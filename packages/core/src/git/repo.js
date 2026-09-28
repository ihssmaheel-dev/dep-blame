import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Executes a git command with windowsHide enabled.
 */
export async function execGit(args, cwd = process.cwd()) {
  try {
    return await execFileAsync('git', args, { cwd, windowsHide: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error('dep-blame requires git on PATH. Install git and try again.');
      error.isMissingGit = true;
      throw error;
    }
    throw err;
  }
}

/**
 * Checks whether git is available on PATH.
 */
export async function checkGit() {
  try {
    await execGit(['--version']);
    return true;
  } catch (err) {
    if (err.isMissingGit || err.code === 'ENOENT') {
      throw new Error('dep-blame requires git on PATH. Install git and try again.');
    }
    throw err;
  }
}

/**
 * Finds the top-level repository root.
 */
export async function getRepoRoot(cwd = process.cwd()) {
  const { stdout } = await execGit(['rev-parse', '--show-toplevel'], cwd);
  return path.resolve(stdout.trim());
}

/**
 * Resolves git common directory (handles worktrees correctly).
 */
export async function getGitCommonDir(cwd = process.cwd()) {
  const { stdout } = await execGit(['rev-parse', '--git-common-dir'], cwd);
  const trimmed = stdout.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

/**
 * Checks if the repository is a shallow clone.
 */
export async function isShallowRepo(cwd = process.cwd()) {
  try {
    const { stdout } = await execGit(['rev-parse', '--is-shallow-repository'], cwd);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Gets the current commit SHA of HEAD.
 */
export async function getCurrentHead(cwd = process.cwd()) {
  const { stdout } = await execGit(['rev-parse', 'HEAD'], cwd);
  return stdout.trim();
}

/**
 * Checks if candidate is an ancestor of target commit.
 */
export async function isAncestor(candidateSha, targetSha = 'HEAD', cwd = process.cwd()) {
  try {
    await execGit(['merge-base', '--is-ancestor', candidateSha, targetSha], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves base ref and merge-base commit for CI comparisons.
 *
 * @param {string} [candidateRef] Specific ref (e.g. origin/main, HEAD~1)
 * @param {string} [cwd=process.cwd()]
 * @returns {Promise<{ baseRef: string, baseSha: string | null }>}
 */
export async function resolveBaseRef(candidateRef, cwd = process.cwd()) {
  let baseRef = candidateRef;

  if (!baseRef) {
    // Try symbolic-ref for default remote branch
    try {
      const { stdout } = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
      baseRef = stdout.trim().replace('refs/remotes/', '');
    } catch {
      // Try origin/main or origin/master
      try {
        await execGit(['rev-parse', '--verify', 'origin/main'], cwd);
        baseRef = 'origin/main';
      } catch {
        try {
          await execGit(['rev-parse', '--verify', 'origin/master'], cwd);
          baseRef = 'origin/master';
        } catch {
          baseRef = 'HEAD~1';
        }
      }
    }
  }

  try {
    const { stdout } = await execGit(['merge-base', baseRef, 'HEAD'], cwd);
    return { baseRef, baseSha: stdout.trim() };
  } catch {
    try {
      const { stdout } = await execGit(['rev-parse', baseRef], cwd);
      return { baseRef, baseSha: stdout.trim() };
    } catch {
      return { baseRef, baseSha: null };
    }
  }
}
