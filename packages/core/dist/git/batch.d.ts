import type { BlobRequest } from '../types.js';
/**
 * Batch-reads manifest blobs from git using `git cat-file --batch`.
 * Features chunked stream parsing, backpressure handling, and timeout safeguards.
 *
 * @param repoRoot Absolute path to git repository root
 * @param requests Array of commit and path pairs
 * @returns Map of `<commit>:<path>` to file content string (or null if missing)
 */
export declare function batchReadBlobs(repoRoot: string, requests: BlobRequest[]): Promise<Map<string, string | null>>;
//# sourceMappingURL=batch.d.ts.map