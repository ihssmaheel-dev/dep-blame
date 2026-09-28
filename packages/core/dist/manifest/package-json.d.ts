import type { DependencyEntry, DepType } from '../types.js';
export declare const DEP_TYPES: DepType[];
/**
 * Parses a package.json content string into a normalized Map of dependencies.
 *
 * @param content Raw JSON string of package.json
 * @returns Map of package name to version & type
 */
export declare function parsePackageJson(content?: string | null): Map<string, DependencyEntry>;
//# sourceMappingURL=package-json.d.ts.map