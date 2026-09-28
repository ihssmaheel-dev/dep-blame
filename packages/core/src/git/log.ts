import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitInfo } from '../types.js';

const execFileAsync = promisify(execFile);

export interface GitLogOptions {
  sinceCommit?: string | null;
  manifestPaths?: string[];
  reverse?: boolean;
}

/**
 * Fetches commits touching specified manifest paths in chronological order.
 *
 * @param repoRoot Path to git repository root
 * @param options Log options
 * @returns Array of commit details
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
  const args = ['log'];

  if (reverse) {
    args.push('--reverse');
  }

  // Record separator \x1e, Unit separator \x1f
  args.push('--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f', '--name-only', range);

  if (manifestPaths && manifestPaths.length > 0) {
    args.push('--', ...manifestPaths);
  }

  let stdout: string;
  try {
    const res = await execFileAsync('git', args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    stdout = res.stdout;
  } catch (err: any) {
    // If range is invalid (e.g. unknown revision when shallow or rewrite)
    if (err.stderr && (err.stderr.includes('Invalid symmetric difference') || err.stderr.includes('unknown revision'))) {
      throw err;
    }
    throw err;
  }

  const rawRecords = stdout.split('\x1e').filter((rec) => rec.trim().length > 0);
  const commits: CommitInfo[] = [];

  for (const record of rawRecords) {
    const parts = record.split('\x1f');
    if (parts.length < 4) {
      continue;
    }

    const commit = parts[0].trim();
    const date = parts[1].trim();
    const author = parts[2].trim();
    const message = parts[3].trim();
    const rawFiles = parts[4] || '';

    // Files are listed after subject, separated by newlines
    const files = rawFiles
      .split('\n')
      .map((f) => f.trim().replace(/\\/g, '/')) // Normalize to posix forward slashes
      .filter((f) => f.length > 0);

    commits.push({
      commit,
      date,
      author,
      message,
      files
    });
  }

  return commits;
}
