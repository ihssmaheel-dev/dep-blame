import type { CommitInfo } from '../types.js';
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
export declare function getManifestCommits(repoRoot: string, options?: GitLogOptions): Promise<CommitInfo[]>;
//# sourceMappingURL=log.d.ts.map