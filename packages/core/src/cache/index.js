import path from 'node:path';
import { getGitCommonDir } from '../git/repo.js';
import { SqliteStore } from './sqlite-store.js';
import { JsonStore } from './json-store.js';

/**
 * Resolves cache path and initializes storage (SQLite with JSON fallback).
 *
 * @param {Object} options
 * @param {string} options.repoRoot Repository root path
 * @param {string} [options.cacheDir] Optional cache directory override
 * @returns {Promise<SqliteStore | JsonStore>}
 */
export async function openCache(options = {}) {
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
  } catch (err) {
    // If node:sqlite is not available or throws, fall back to JsonStore
    return new JsonStore(jsonPath);
  }
}
