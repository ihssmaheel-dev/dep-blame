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

export interface RepoState {
  repoRoot: string;
  isShallow: boolean;
  currentHead: string | null;
  branch: string;
}

/**
 * Fast-path: resolves repoRoot, isShallow, currentHead, and branch in a single git execution.
 */
export async function getRepoState(cwd: string = process.cwd()): Promise<RepoState> {
  try {
    const { stdout } = await execGit([
      'rev-parse',
      '--show-toplevel',
      '--is-shallow-repository',
      'HEAD',
      '--abbrev-ref',
      'HEAD'
    ], cwd);

    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const repoRoot = path.resolve(lines[0]);
    const isShallow = lines[1] === 'true';
    const currentHead = lines[2] || null;
    let branch = lines[3] || 'main';
    if (branch === 'HEAD' && currentHead) {
      branch = currentHead.slice(0, 7);
    }
    return { repoRoot, isShallow, currentHead, branch };
  } catch (err: any) {
    if (err instanceof GitError && err.isMissingGit) {
      throw err;
    }
    // Fallback for unborn HEAD or detached/special states
    const repoRoot = await getRepoRoot(cwd);
    const isShallow = await isShallowRepo(repoRoot);
    let currentHead: string | null = null;
    try {
      currentHead = await getCurrentHead(repoRoot);
    } catch {
      currentHead = null;
    }
    let branch = 'main';
    try {
      branch = await getCurrentBranch(repoRoot);
    } catch {
      branch = 'main';
    }
    return { repoRoot, isShallow, currentHead, branch };
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
 * Gets the current branch name, or short SHA if detached HEAD.
 */
export async function getCurrentBranch(cwd: string = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') return branch;
    const { stdout: sha } = await execGit(['rev-parse', '--short', 'HEAD'], cwd);
    return sha.trim() || 'HEAD';
  } catch {
    return 'main';
  }
}

export interface RepoRemoteInfo {
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  host: string;
}

/**
 * Parses git remote origin info (e.g. https://github.com/owner/repo.git or git@github.com:owner/repo.git)
 */
export async function getRepoRemoteInfo(cwd: string = process.cwd()): Promise<RepoRemoteInfo> {
  try {
    const { stdout } = await execGit(['config', '--get', 'remote.origin.url'], cwd);
    const raw = stdout.trim();
    if (!raw) return { remoteUrl: null, owner: null, repo: null, host: 'github.com' };

    const match = raw.match(/^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (match) {
      const host = match[1];
      const owner = match[2];
      const repo = match[3];
      return {
        remoteUrl: `https://${host}/${owner}/${repo}`,
        owner,
        repo,
        host
      };
    }
    return { remoteUrl: raw, owner: null, repo: null, host: 'github.com' };
  } catch {
    return { remoteUrl: null, owner: null, repo: null, host: 'github.com' };
  }
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
  let baseRef = candidateRef?.trim() || '';

  // Guard against passing a time window (7d/30d) as a git ref for `ci --since`.
  if (baseRef && /^(\d+)(d|w|mo|m|y)$/i.test(baseRef)) {
    baseRef = '';
  }

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
    return { baseRef: baseRef!, baseSha: stdout.trim() };
  } catch {
    try {
      const { stdout } = await execGit(['rev-parse', baseRef!], cwd);
      return { baseRef: baseRef!, baseSha: stdout.trim() };
    } catch {
      return { baseRef: baseRef!, baseSha: null };
    }
  }
}

/**
 * Returns the author date (ISO 8601) of a commit, or null if unresolvable.
 */
export async function getCommitDate(sha: string, cwd: string = process.cwd()): Promise<string | null> {
  if (!sha || !/^[0-9a-f]{4,40}$/i.test(sha.trim())) return null;
  try {
    const { stdout } = await execGit(['show', '-s', '--format=%aI', sha], cwd);
    const d = stdout.trim().split('\n')[0]?.trim();
    return d || null;
  } catch {
    return null;
  }
}

/**
 * Lists full commit SHAs in `baseSha..HEAD`.
 * Used by CI mode to scope events to the PR range without relying on
 * short-SHA string equality.
 *
 * Returns `null` when the range cannot be listed (bad ref, git failure) —
 * callers must NOT treat that as an empty range. An empty (non-null) set
 * is a genuine empty range and must stay empty.
 */
export async function getCommitsInRange(
  baseSha: string,
  cwd: string = process.cwd(),
  manifestPaths: string[] = []
): Promise<Set<string> | null> {
  const out = new Set<string>();
  if (!baseSha || !/^[0-9a-f]{4,40}$/i.test(baseSha.trim())) return null;
  const args = ['log', '--format=%H', `${baseSha}..HEAD`];
  if (manifestPaths.length > 0) args.push('--', ...manifestPaths);
  try {
    const { stdout } = await execGit(args, cwd);
    for (const line of stdout.split('\n')) {
      const sha = line.trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) out.add(sha);
    }
  } catch {
    return null;
  }
  return out;
}
