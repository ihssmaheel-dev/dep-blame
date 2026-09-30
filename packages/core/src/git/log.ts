import { spawn } from 'node:child_process';
import type { CommitInfo } from '../types.js';

export interface GitLogOptions {
  sinceCommit?: string | null;
  manifestPaths?: string[];
  reverse?: boolean;
}

/**
 * Fetches commits touching specified manifest paths in topological order
 * (parents before children), oldest first by default.
 *
 * - `--topo-order` makes cross-branch enumeration deterministic so each
 *   commit can be diffed against its own parents (see engine).
 * - `-m` forces merge commits to list their changed files; without it,
 *   merges are silently absent from `--name-only` output and their
 *   dependency changes vanish from the timeline.
 * - Output streams through `spawn` with incremental parsing — no
 *   `maxBuffer` ceiling, so large histories can't fail or truncate.
 */
export async function getManifestCommits(
  repoRoot: string,
  options: GitLogOptions = {}
): Promise<CommitInfo[]> {
  const {
    sinceCommit,
    manifestPaths = ['package.json', 'package-lock.json'],
    reverse = true
  } = options;

  const range = sinceCommit ? `${sinceCommit}..HEAD` : 'HEAD';
  const args = ['log', '--topo-order'];

  if (reverse) {
    args.push('--reverse');
  }

  // Never --follow with multiple paths: git silently drops it past one path.
  // %P = parent SHAs (empty for root). \x1e records / \x1f fields: control
  // chars can't appear in normal commit text, so plain split() is safe.
  args.push('-m', '--format=%x1e%H%x1f%P%x1f%aI%x1f%an%x1f%s%x1f', '--name-only', range);

  if (manifestPaths && manifestPaths.length > 0) {
    args.push('--', ...manifestPaths);
  }

  const stdout = await streamGitLog(repoRoot, args);

  const rawRecords = stdout.split('\x1e').filter((rec) => rec.trim().length > 0);
  const commits: CommitInfo[] = [];
  const bySha = new Map<string, CommitInfo>();

  for (const record of rawRecords) {
    const parts = record.split('\x1f');
    if (parts.length < 5) {
      continue;
    }

    const commit = parts[0].trim();
    const parents = (parts[1] || '').trim().split(/\s+/).filter((s) => /^[0-9a-f]{40}$/i.test(s));
    const date = parts[2].trim();
    const author = parts[3].trim();
    const message = parts[4].trim();
    const rawFiles = parts[5] || '';

    if (!/^[0-9a-f]{40}$/i.test(commit)) continue;

    // Files are listed after subject, separated by newlines.
    // Git always emits forward slashes, even on Windows — do not mangle
    // literal backslashes in exotic filenames.
    const files = rawFiles
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    // `-m` can repeat a merge SHA once per parent diff; merge the file
    // sets so each commit is processed exactly once.
    const existing = bySha.get(commit);
    if (existing) {
      const seen = new Set(existing.files);
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          existing.files.push(f);
        }
      }
      continue;
    }

    const info: CommitInfo = {
      commit,
      parents,
      date,
      author,
      message,
      files
    };
    bySha.set(commit, info);
    commits.push(info);
  }

  return commits;
}

/** Runs `git log` streaming stdout so history size has no buffer ceiling. */
function streamGitLog(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoRoot, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = (err || `git log exited with code ${code}`).trim();
        reject(new Error(msg));
        return;
      }
      resolve(out);
    });
  });
}
