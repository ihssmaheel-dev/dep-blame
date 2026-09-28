import type { DetectedPackageManager } from '../types.js';
/**
 * Resolves workspace glob patterns to find child package.json files.
 */
export declare function resolveWorkspaceManifests(repoRoot: string, workspaceGlobs: string[]): string[];
/**
 * Detects the package manager and manifest files in the repo.
 */
export declare function detectPackageManager(repoRoot: string): DetectedPackageManager;
//# sourceMappingURL=detect.d.ts.map