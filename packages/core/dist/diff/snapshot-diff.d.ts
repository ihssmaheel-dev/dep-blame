import type { CommitInfo, DependencyEntry, DependencyEvent } from '../types.js';
/**
 * Diffs two snapshot maps and produces normalized DependencyEvents.
 *
 * @param prevSnapshot Previous dependencies map
 * @param currSnapshot Current dependencies map
 * @param commitInfo Commit metadata
 * @param manifest Path to manifest file
 * @returns Array of DependencyEvent
 */
export declare function diffSnapshots(prevSnapshot: Map<string, DependencyEntry> | undefined, currSnapshot: Map<string, DependencyEntry> | undefined, commitInfo: CommitInfo, manifest: string): DependencyEvent[];
/**
 * Generates low-fidelity lockfile updated event for pnpm/yarn in v0.1 compatibility.
 */
export declare function createLockfileLowFiEvent(commitInfo: CommitInfo, manifest: string): DependencyEvent;
//# sourceMappingURL=snapshot-diff.d.ts.map