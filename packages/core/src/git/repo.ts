import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  isMissingGit?: boolean;
  code?: string | number;
  stderr?: string;

  constructor(message: string, isMissingGit = false, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.isMissingGit = isMissingGit;
    this.stderr = stderr;
  }
}

/**
 * Executes a git command with windowsHide enabled.
 */
export async function execGit(args: string[], cwd: string = process.cwd()): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new GitError('dep-blame requires git on PATH. Install git and try again.', true);
    }
    throw new GitError(err.message || 'Git execution failed', false, err.stderr || '');
  }
}

/**
 * Checks whether git is available on PATH.
 */
export async function checkGit(): Promise<boolean> {
  try {
    await execGit(['--version']);
    return true;
  } catch (err: any) {
    if (err instanceof GitError && err.isMissingGit) {
      throw err;
    }
    throw new GitError('dep-blame requires git on PATH. Install git and try again.', true);
  }
}

/**
 * Finds the top-level repository root.
 */
export async function getRepoRoot(cwd: string = process.cwd()): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--show-toplevel'], cwd);
  return path.resolve(stdout.trim());
}

/**
 * Resolves git common directory (handles worktrees correctly).
 */
export async function getGitCommonDir(cwd: string = process.cwd()): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--git-common-dir'], cwd);
  const trimmed = stdout.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

/**
 * Checks if the repository is a shallow clone.
 */
export async function isShallowRepo(cwd: string = process.cwd()): Promise<boolean> {
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
export async function getCurrentHead(cwd: string = process.cwd()): Promise<string> {
  const { stdout } = await execGit(['rev-parse', 'HEAD'], cwd);
  return stdout.trim();
}

/**
 * Checks if candidate is an ancestor of target commit.
 */
export async function isAncestor(candidateSha: string, targetSha: string = 'HEAD', cwd: string = process.cwd()): Promise<boolean> {
  try {
    await execGit(['merge-base', '--is-ancestor', candidateSha, targetSha], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves base ref and merge-base commit for CI comparisons.
 */
export async function resolveBaseRef(
  candidateRef?: string,
  cwd: string = process.cwd()
): Promise<{ baseRef: string; baseSha: string | null }> {
  let baseRef = candidateRef;

  if (!baseRef) {
    try {
      const { stdout } = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
      baseRef = stdout.trim().replace(/^refs\/remotes\//, '');
    } catch {
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
