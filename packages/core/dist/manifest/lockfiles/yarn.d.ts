import type { DependencyEntry } from '../../types.js';
/**
 * Parses yarn.lock into a normalized Map of dependencies (supporting v1 Classic and Berry v2+).
 */
export declare function parseYarnLockfile(content?: string | null): Promise<Map<string, DependencyEntry>>;
//# sourceMappingURL=yarn.d.ts.map