import type { DependencyEntry } from '../../types.js';
/**
 * Parses pnpm-lock.yaml into a normalized Map of dependencies.
 */
export declare function parsePnpmLockfile(content?: string | null): Promise<Map<string, DependencyEntry>>;
//# sourceMappingURL=pnpm.d.ts.map