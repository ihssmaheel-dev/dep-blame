import fs from 'node:fs';
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
 * Resolves the cache base directory (shared by lock + temp + stores).
 */
export async function resolveCacheBaseDir(repoRoot: string, cacheDir?: string): Promise<string> {
  if (cacheDir) return cacheDir;
  try {
    const commonDir = await getGitCommonDir(repoRoot);
    return path.join(commonDir, 'dep-blame');
  } catch {
    // e.g. --git-common-dir unsupported on ancient git: keep cache inside repo.
    return path.join(repoRoot, '.git', 'dep-blame');
  }
}

/**
 * Best-effort cleanup of temp scan dirs left by interrupted runs.
 * Temp dirs are uniquely named; only directories older than an hour
 * are removed so a concurrent scan is never disturbed.
 */
export function cleanStaleTempDirs(baseDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith('.scan-') && !entry.startsWith('.tmp-')) continue;
    const full = path.join(baseDir, entry);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory() && now - st.mtimeMs > 60 * 60 * 1000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup failures.
    }
  }
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

  const baseDir = await resolveCacheBaseDir(repoRoot, cacheDir);
  cleanStaleTempDirs(baseDir);

  const dbPath = path.join(baseDir, 'cache.db');
  const jsonPath = path.join(baseDir, 'cache.json');

  try {
    const store = new SqliteStore(dbPath);
    // Belt-and-braces: the constructor already migrates stale versions,
    // but a version written by a newer release is unsafe to read.
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
