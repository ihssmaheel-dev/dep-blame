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
