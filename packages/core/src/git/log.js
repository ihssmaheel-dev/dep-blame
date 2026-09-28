import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fetches commits touching specified manifest paths in chronological order.
 *
 * @param {string} repoRoot Path to git repository root
 * @param {Object} options
 * @param {string} [options.sinceCommit] Start commit (exclusive), e.g. cached HEAD
 * @param {string[]} [options.manifestPaths] Paths to manifest files to filter on
 * @param {boolean} [options.reverse=true] Chronological order (oldest to newest)
 * @returns {Promise<Array<{ commit: string, date: string, author: string, message: string, files: string[] }>>}
 */
export async function getManifestCommits(repoRoot, options = {}) {
  const { sinceCommit, manifestPaths = ['package.json', 'package-lock.json'], reverse = true } = options;

  const range = sinceCommit ? `${sinceCommit}..HEAD` : 'HEAD';
  const args = ['log'];

  if (reverse) {
    args.push('--reverse');
  }

  // Format:
  // \x1e begins commit record
  // Fields separated by \x1f: %H (sha), %aI (ISO 8601 date), %an (author), %s (message)
  // Followed by \x1f and then file list from --name-only
  args.push('--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f', '--name-only', range);

  if (manifestPaths && manifestPaths.length > 0) {
    args.push('--', ...manifestPaths);
  }

  let stdout;
  try {
    const res = await execFileAsync('git', args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024 // 64 MB buffer
    });
    stdout = res.stdout;
  } catch (err) {
    // If range is invalid (e.g. unknown revision when shallow or rewrite), handle appropriately
    if (err.stderr && err.stderr.includes('fatal: Invalid symmetric difference')) {
      throw err;
    }
    throw err;
  }

  const rawRecords = stdout.split('\x1e').filter((rec) => rec.trim().length > 0);
  const commits = [];

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
      .map((f) => f.trim())
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
