import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CommitInfo } from '../types.js';

export interface GitLogOptions {
  sinceCommit?: string | null;
  manifestPaths?: string[];
  reverse?: boolean;
  headCommit?: string;
}

/** Reads NUL-delimited metadata and paths incrementally, parents before children. */
export function getManifestCommits(repoRoot: string, options: GitLogOptions = {}): Promise<CommitInfo[]> {
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
      if (!bySha.has(commit)) { bySha.set(commit, current); commits.push(current); }
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
        resolve(commits);
      } catch (err) { reject(err); }
    });
  });
}
