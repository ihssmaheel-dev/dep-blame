import type { DependencyEntry } from '../../types.js';
export interface NpmLockfileOptions {
    directOnly?: boolean;
}
/**
 * Parses package-lock.json content into a normalized Map (supporting v1, v2, and v3).
 *
 * @param content Raw JSON string of package-lock.json
 * @param options Options including directOnly filter
 */
export declare function parseNpmLockfile(content?: string | null, options?: NpmLockfileOptions): Map<string, DependencyEntry>;
//# sourceMappingURL=npm.d.ts.map