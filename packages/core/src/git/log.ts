import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CommitInfo } from '../types.js';

export interface GitLogOptions {
  sinceCommit?: string | null;
  manifestPaths?: string[];
  reverse?: boolean;
  headCommit?: string;
}

/**
 * Reads NUL-delimited metadata and paths incrementally, parents before children.
 *
 * `onProgress(found)` reports the running commit count while git walks —
 * full-history walks on huge repositories otherwise sit silent for minutes.
 * Path chunks run with bounded parallelism (default 4) and merge in chunk
 * order, so output is deterministic regardless of completion order.
 */
export function getManifestCommits(
  repoRoot: string,
  options: GitLogOptions = {},
  onProgress?: (found: number) => void
): Promise<CommitInfo[]> {
  const {sinceCommit, manifestPaths = ['package.json', 'package-lock.json'], reverse = true, headCommit = 'HEAD'} = options;
  // Avoid ARG_MAX on repos with 300 manifest paths: chunk the path filter
  // and merge/dedupe. 50 paths per invocation keeps argv small.
  const PATH_CHUNK = 50;
  const chunks: string[][] = [];
  if (manifestPaths.length <= PATH_CHUNK) {
    chunks.push(manifestPaths);
  } else {
    for (let i = 0; i < manifestPaths.length; i += PATH_CHUNK) {
      chunks.push(manifestPaths.slice(i, i + PATH_CHUNK));
    }
  }
  if (chunks.length === 1) {
    return getManifestCommitsChunk(repoRoot, { sinceCommit, manifestPaths, reverse, headCommit }, onProgress);
  }
  const CONCURRENCY = 4;
  const counts = new Array<number>(chunks.length).fill(0);
  let lastEmit = 0;
  const runChunk = async (index: number): Promise<CommitInfo[]> => {
    const part = await getManifestCommitsChunk(
      repoRoot,
      { sinceCommit, manifestPaths: chunks[index], reverse, headCommit },
      (n) => {
        counts[index] = n;
        const now = Date.now();
        if (onProgress && now - lastEmit > 500) {
          lastEmit = now;
          onProgress(counts.reduce((a, b) => a + b, 0));
        }
      }
    );
    counts[index] = part.length;
    return part;
  };
  return (async () => {
    const parts: CommitInfo[][] = [];
    for (let s = 0; s < chunks.length; s += CONCURRENCY) {
      const group = await Promise.all(chunks.slice(s, s + CONCURRENCY).map((_, k) => runChunk(s + k)));
      parts.push(...group);
    }
    const bySha = new Map<string, CommitInfo>();
    for (const part of parts) {
      for (const c of part) {
        const existing = bySha.get(c.commit);
        if (!existing) {
          bySha.set(c.commit, { ...c, files: [...c.files] });
        } else {
          for (const f of c.files) {
            if (!existing.files.includes(f)) existing.files.push(f);
          }
        }
      }
    }
    // Concatenating independently walked chunks can put a child before a
    // parent found only in another chunk. Order the merged DAG by its actual
    // edges, not timestamps (author clocks can run backwards).
    const unordered = [...bySha.values()];
    const degree = new Map<string, number>();
    const children = new Map<string, CommitInfo[]>();
    for (const c of unordered) {
      let count = 0;
      for (const parent of c.parents) {
        if (!bySha.has(parent)) continue;
        count++;
        let list = children.get(parent);
        if (!list) { list = []; children.set(parent, list); }
        list.push(c);
      }
      degree.set(c.commit, count);
    }
    const ready = unordered.filter(c => degree.get(c.commit) === 0);
    const merged: CommitInfo[] = [];
    for (let cursor = 0; cursor < ready.length; cursor++) {
      const c = ready[cursor];
      merged.push(c);
      for (const child of children.get(c.commit) || []) {
        const left = degree.get(child.commit)! - 1;
        degree.set(child.commit, left);
        if (left === 0) ready.push(child);
      }
    }
    if (merged.length !== unordered.length) throw new Error('Invalid Git history graph.');
    if (options.reverse === false) merged.reverse();
    onProgress?.(merged.length);
    return merged;
  })();
}

function getManifestCommitsChunk(
  repoRoot: string,
  options: GitLogOptions = {},
  onProgress?: (found: number) => void
): Promise<CommitInfo[]> {
  const {sinceCommit, manifestPaths = ['package.json', 'package-lock.json'], reverse = true, headCommit = 'HEAD'} = options;
  const args = ['log', '--topo-order'];
  if (reverse) args.push('--reverse');
  // Fixed metadata field count keeps empty root parents unambiguous. -z preserves
  // Unicode and spaces in paths without Git's quoting or line-based trimming.
  args.push('-m', '-z', '--format=%x00%H%x00%P%x00%aI%x00%an%x00%s', '--name-only', sinceCommit ? sinceCommit + '..' + headCommit : headCommit);
  if (manifestPaths.length) args.push('--', ...manifestPaths);
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {cwd: repoRoot, windowsHide: true});
    const decoder = new StringDecoder('utf8');
    const commits: CommitInfo[] = [];
    const bySha = new Map<string, CommitInfo>();
    let pending = '';
    let fields: string[] = [];
    let current: CommitInfo | null = null;
    let firstFile = false;
    let stderr = '';
    let failed = false;
    function consume(token: string) {
      if (current) {
        if (token === '') { current = null; fields = []; return; }
        const file = firstFile && token.startsWith('\n') ? token.slice(1) : token;
        firstFile = false;
        if (file && !current.files.includes(file)) current.files.push(file);
        return;
      }
      if (fields.length === 0 && token === '') return;
      fields.push(token);
      if (fields.length < 5) return;
      const [commit, parentText, date, author, message] = fields;
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) throw new Error('Invalid Git history record.');
      const parents = parentText.split(/\s+/).filter(Boolean);
      if (parents.some(p => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(p))) throw new Error('Invalid Git parent record.');
      current = bySha.get(commit) || {commit, parents, date, author, message, files: []};
      if (!bySha.has(commit)) {
        bySha.set(commit, current); commits.push(current);
        if (onProgress && commits.length % 200 === 0) onProgress(commits.length);
      }
      firstFile = true;
    }
    function feed(text: string) {
      pending += text;
      let pos: number;
      while ((pos = pending.indexOf('\0')) !== -1) {
        consume(pending.slice(0, pos));
        pending = pending.slice(pos + 1);
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      try { feed(decoder.write(chunk)); }
      catch (err) { failed = true; child.kill(); reject(err); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', err => { failed = true; reject(err); });
    child.on('close', code => {
      if (failed) return;
      try {
        feed(decoder.end());
        if (code !== 0) throw new Error(stderr.trim() || 'git log exited with code ' + code);
        if (pending.length || (!current && fields.length)) throw new Error('Incomplete Git history record.');
        onProgress?.(commits.length);
        resolve(commits);
      } catch (err) { reject(err); }
    });
  });
}
