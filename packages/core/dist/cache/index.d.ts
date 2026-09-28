import type { StoreInterface } from '../types.js';
export interface OpenCacheOptions {
    repoRoot: string;
    cacheDir?: string;
}
/**
 * Resolves cache path and initializes storage (SQLite with JSON fallback).
 */
export declare function openCache(options: OpenCacheOptions): Promise<StoreInterface>;
//# sourceMappingURL=index.d.ts.map