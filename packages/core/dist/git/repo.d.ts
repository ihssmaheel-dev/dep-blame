export declare class GitError extends Error {
    isMissingGit?: boolean;
    code?: string | number;
    stderr?: string;
    constructor(message: string, isMissingGit?: boolean, stderr?: string);
}
/**
 * Executes a git command with windowsHide enabled.
 */
export declare function execGit(args: string[], cwd?: string): Promise<{
    stdout: string;
    stderr: string;
}>;
/**
 * Checks whether git is available on PATH.
 */
export declare function checkGit(): Promise<boolean>;
/**
 * Finds the top-level repository root.
 */
export declare function getRepoRoot(cwd?: string): Promise<string>;
/**
 * Resolves git common directory (handles worktrees correctly).
 */
export declare function getGitCommonDir(cwd?: string): Promise<string>;
/**
 * Checks if the repository is a shallow clone.
 */
export declare function isShallowRepo(cwd?: string): Promise<boolean>;
/**
 * Gets the current commit SHA of HEAD.
 */
export declare function getCurrentHead(cwd?: string): Promise<string>;
/**
 * Checks if candidate is an ancestor of target commit.
 */
export declare function isAncestor(candidateSha: string, targetSha?: string, cwd?: string): Promise<boolean>;
/**
 * Resolves base ref and merge-base commit for CI comparisons.
 */
export declare function resolveBaseRef(candidateRef?: string, cwd?: string): Promise<{
    baseRef: string;
    baseSha: string | null;
}>;
//# sourceMappingURL=repo.d.ts.map