import path from 'node:path';
import { getGitCommonDir } from '../git/repo.js';
import { SqliteStore, CACHE_SCHEMA_VERSION } from './sqlite-store.js';
import { JsonStore } from './json-store.js';
import type { StoreInterface } from '../types.js';

export interface OpenCacheOptions {
  repoRoot: string;
  cacheDir?: string;
}

/**
 * Resolves cache path and initializes storage (SQLite with JSON fallback).
 *
 * No static `node:sqlite` import anywhere on this path, so Node 20 and
 * Node 22 without --experimental-sqlite fall back cleanly instead of
 * crashing at module load.
 */
export async function openCache(options: OpenCacheOptions): Promise<StoreInterface> {
  const { repoRoot, cacheDir } = options;

  let baseDir = cacheDir;
  if (!baseDir) {
    try {
      const commonDir = await getGitCommonDir(repoRoot);
      baseDir = path.join(commonDir, 'dep-blame');
    } catch {
      // e.g. --git-common-dir unsupported on ancient git: keep cache inside repo.
      baseDir = path.join(repoRoot, '.git', 'dep-blame');
    }
  }

  const dbPath = path.join(baseDir, 'cache.db');
  const jsonPath = path.join(baseDir, 'cache.json');

  try {
    const store = new SqliteStore(dbPath);
    // Validate schema version; wipe on major mismatch rather than mis-query.
    try {
      const v = store.getMeta('schema_version');
      if (v && v !== CACHE_SCHEMA_VERSION) {
        store.clear();
      }
    } catch {
      // Ignore validation failures; store remains usable.
    }
    return store;
  } catch (err: any) {
    // SQLITE_UNAVAILABLE, locked DB, read-only .git, etc. -> JSON fallback.
    if (err?.code && err.code !== 'SQLITE_UNAVAILABLE') {
      // Still fall back; sqlite failures must never crash analysis.
    }
    return new JsonStore(jsonPath);
  }
}

/**
 * Probes whether the current runtime can use node:sqlite.
 * Useful for diagnostics and tests without touching the filesystem.
 */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
