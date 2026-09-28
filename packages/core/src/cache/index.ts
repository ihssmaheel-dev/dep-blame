import path from 'node:path';
import { getGitCommonDir } from '../git/repo.js';
import { SqliteStore } from './sqlite-store.js';
import { JsonStore } from './json-store.js';
import type { StoreInterface } from '../types.js';

export interface OpenCacheOptions {
  repoRoot: string;
  cacheDir?: string;
}

/**
 * Resolves cache path and initializes storage (SQLite with JSON fallback).
 */
export async function openCache(options: OpenCacheOptions): Promise<StoreInterface> {
  const { repoRoot, cacheDir } = options;

  let baseDir = cacheDir;
  if (!baseDir) {
    const commonDir = await getGitCommonDir(repoRoot);
    baseDir = path.join(commonDir, 'dep-blame');
  }

  const dbPath = path.join(baseDir, 'cache.db');
  const jsonPath = path.join(baseDir, 'cache.json');

  try {
    return new SqliteStore(dbPath);
  } catch {
    // If node:sqlite is not available or locked, fall back to JsonStore
    return new JsonStore(jsonPath);
  }
}
