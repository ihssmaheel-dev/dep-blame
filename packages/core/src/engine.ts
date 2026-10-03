import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  getRepoState,
  execGit,
  isAncestor
} from './git/repo.js';
import { getManifestCommits } from './git/log.js';
import { batchReadBlobs, streamReadBlobs, resolveBlobOids, MAX_BLOB_BYTES, type BlobContent } from './git/batch.js';
import { detectPackageManager, discoverHistoricManifests, mergeManifestPaths } from './manifest/detect.js';
import { parsePackageJson } from './manifest/package-json.js';
import { parseNpmLockfile } from './manifest/lockfiles/npm.js';
import { parsePnpmLockfiles } from './manifest/lockfiles/pnpm.js';
import { parseYarnLockfile } from './manifest/lockfiles/yarn.js';
import { parseBunLockfiles } from './manifest/lockfiles/bun.js';
import { diffSnapshots, createLockfileLowFiEvent } from './diff/snapshot-diff.js';
import { openCache, resolveCacheBaseDir } from './cache/index.js';
import { acquireScanLock } from './cache/lock.js';
import { stripControl } from './render/ansi.js';
import type {
  BlobRequest,
  CommitInfo,
  DependencyEntry,
  DependencyEvent,
  EngineOptions,
  EngineResult,
  EventSource,
  HeadEntry,
  ParseResult,
  StoreInterface
} from './types.js';

const MANIFEST_PATHS_CACHE_KEY = 'manifest_paths';
// Count-limited windows; total retained bytes also depend on manifest sizes.
const WINDOW_TARGET_BLOBS = 1500;
const WINDOW_MAX_COMMITS = 300;
const TRANSFER_TARGET_BYTES = 16 * 1024 * 1024;
// Historic discovery is a full-history `git log`; only pay it on cold scans.
const PROGRESS_THRESHOLD = 2000;

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb'
]);

function hashContent(content: string): string {
  // sha1 is native-fast and collision risk is irrelevant for change detection.
  return createHash('sha1').update(content, 'utf8').digest('hex');
}

function readCachedManifestPaths(cache: { getMeta(k: string): string | null }): string[] | null {
  try {
    const raw = cache.getMeta(MANIFEST_PATHS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 256);
    if (cleaned.length !== parsed.length) {
      // Long-path entries were dropped by an older version: treat history
      // as potentially incomplete rather than silently partial.
      try { (cache as { setMeta?: (k: string, v: string) => void }).setMeta?.('history_truncated', 'true'); } catch { /* ignore */ }
    }
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function isManifestFile(f: string): boolean {
  if (f.endsWith('package.json')) return true;
  const base = f.split('/').pop() || '';
  return LOCKFILE_BASENAMES.has(base);
}

function isLockfilePath(f: string): boolean {
  if (f.endsWith('package.json')) return false;
  const base = f.split('/').pop() || '';
  return LOCKFILE_BASENAMES.has(base);
}

async function parseAnyManifest(
  filePath: string,
  content?: string | null
): Promise<ParseResult | null> {
  if (content === null || content === undefined) return { ok: true, entries: new Map() };

  if (filePath.endsWith('package.json')) {
    return parsePackageJson(content);
  }
  if (filePath.endsWith('package-lock.json')) {
    return parseNpmLockfile(content, { directOnly: true });
  }
  if (filePath.endsWith('pnpm-lock.yaml')) {
    return await parsePnpmLockfileMulti(filePath, content);
  }
  if (filePath.endsWith('yarn.lock')) {
    return await parseYarnLockfile(content);
  }
  if (filePath.endsWith('bun.lock') || filePath.endsWith('bun.lockb')) {
    return parseBunLockfileMulti(filePath, content);
  }

  return { ok: true, entries: new Map() };
}

async function parsePnpmLockfileMulti(
  _lockPath: string,
  content: string
): Promise<ParseResult | null> {
  // Multi-importer maps are expanded by the caller; this path is unused
  // directly, but keep the single-map contract for compatibility.
  void _lockPath;
  const res = await parsePnpmLockfiles(content);
  if (res === null) return null;
  if (!res.ok) return { ok: false, entries: new Map(), note: res.note };
  return { ok: true, entries: res.maps.get('package.json') || new Map(), note: res.note };
}

function parseBunLockfileMulti(
  _lockPath: string,
  content: string
): ParseResult | null {
  void _lockPath;
  const res = parseBunLockfiles(content);
  if (!res.ok) return { ok: false, entries: new Map(), note: res.note };
  const merged = new Map<string, DependencyEntry>();
  for (const map of res.maps.values()) {
    for (const [name, entry] of map) {
      if (!merged.has(name)) merged.set(name, entry);
    }
  }
  return { ok: true, entries: merged, note: res.note };
}

/** Per-manifest resolved maps for multi-importer lockfiles (pnpm, bun). */
async function parseLockfilePerManifest(
  lockPath: string,
  content: string
): Promise<{ ok: boolean; maps: Map<string, Map<string, DependencyEntry>>; note?: string } | null> {
  if (lockPath.endsWith('pnpm-lock.yaml')) {
    return parsePnpmLockfiles(content);
  }
  if (lockPath.endsWith('bun.lock') || lockPath.endsWith('bun.lockb')) {
    return parseBunLockfiles(content);
  }
  return null;
}

/** Snapshot entry: parsed map plus content hash and blob OID for skip-fast paths. */
interface SnapEntry {
  map: Map<string, DependencyEntry>;
  hash: string;
  /** Blob object ID the map was parsed from. */
  oid?: string;
  /** Last-good data retained after unreadable or missing importer evidence. */
  unreadable?: boolean;
}

type StateMap = Map<string, SnapEntry>;

function markUnreadable(state: StateMap, filePath: string): void {
  for (const [key, entry] of state) {
    if (key === filePath || key.startsWith(filePath + '::')) state.set(key, { ...entry, unreadable: true });
  }
}

/** Snapshot key for a lockfile's per-manifest resolved map. */
function lockStateKey(lockPath: string, manifest: string): string {
  return `${lockPath}::${manifest}`;
}

/**
 * Runs the full dep-blame analysis pipeline.
 *
 * History semantics: every commit is diffed against its own first parent
 * (the mainline it landed on), never against the previously enumerated
 * commit. Merge commits therefore report exactly what the merge
 * introduced. Event order stays chronological for display.
 */
export async function runDepBlame(options: EngineOptions = {}): Promise<EngineResult> {
  const startTime = Date.now();
  const { cwd = process.cwd(), noCache = false, clearCache = false, cacheDir, filter = {}, onProgress, limit, offset, includeAggregates } = options;

  onProgress?.({
    phase: 'initializing',
    current: 0,
    total: 100,
    message: 'Inspecting repository status...'
  });

  // Step 1: High-performance single-pass git status resolution
  let repoState;
  try {
    repoState = await getRepoState(cwd);
  } catch (err: any) {
    if (err && err.isMissingGit) {
      throw err;
    }
    throw new Error('Not a git repository (or any of the parent directories).');
  }

  const { repoRoot, isShallow, currentHead, branch } = repoState;
  const repoName = path.basename(repoRoot);

  if (isShallow && !options.silent) {
    console.warn('⚠ Shallow clone detected — history may be incomplete.');
    console.warn('  In GitHub Actions: actions/checkout with fetch-depth: 0');
  }

  if (!currentHead) {
    onProgress?.({
      phase: 'complete',
      current: 100,
      total: 100,
      message: 'No commits in repository'
    });
    return {
      repository: repoName,
      branch: 'main',
      packageManager: 'npm',
      events: [],
      isShallow,
      cached: false,
      durationMs: Date.now() - startTime,
      warnings: []
    };
  }

  const baseDir = await resolveCacheBaseDir(repoRoot, cacheDir);
  const lock = await acquireScanLock(baseDir, () =>
    onProgress?.({
      phase: 'initializing',
      current: 0,
      total: 100,
      message: 'Waiting for another scan to finish…'
    })
  );
  try {
    return await runScanLocked({
      repoRoot,
      repoName,
      branch,
      isShallow,
      currentHead,
      baseDir,
      noCache,
      clearCache,
      filter,
      silent: options.silent,
      onProgress,
      startTime,
      limit,
      offset,
      includeAggregates
    });
  } finally {
    lock.release();
  }
}

interface LockedScanArgs {
  repoRoot: string;
  repoName: string;
  branch: string;
  isShallow: boolean;
  currentHead: string;
  baseDir: string;
  noCache: boolean;
  clearCache: boolean;
  filter: EngineOptions['filter'];
  silent?: boolean;
  onProgress: EngineOptions['onProgress'];
  startTime: number;
  /** Guard against infinite InvalidBaselineError -> rescan loops. */
  _retryCount?: number;
  limit?: number;
  offset?: number;
  includeAggregates?: boolean;
}

async function runScanLocked(args: LockedScanArgs): Promise<EngineResult> {
  const { repoRoot, repoName, branch, isShallow, currentHead, baseDir } = args;
  const { noCache, clearCache, filter = {}, silent, onProgress, startTime, limit, offset, includeAggregates } = args;

  // Step 2: Cheap HEAD detection (sync fs, no git history walk)
  const detected = detectPackageManager(repoRoot);

  // --no-cache scans a throwaway store: the real cache is never read,
  // never appended to, and never overwritten.
  if (noCache) {
    const tempDir = fs.mkdtempSync(path.join(baseDir, '.scan-'));
    try {
      const tempStore = await openCache({ repoRoot, cacheDir: tempDir });
      try {
        const scanned = await executeScan({
          repoRoot,
          scanHead: currentHead,
          store: tempStore,
          detected,
          sinceCommit: null,
          priorManifestPaths: null,
          silent,
          onProgress
        });
        const events = tempStore.queryEvents(filter);
        const bounded = applyBounds(tempStore, filter, events, { limit, offset, includeAggregates, baseDir });
        return {
          repository: repoName,
          branch,
          packageManager: detected.packageManager,
          events: bounded.events,
          isShallow,
          cached: false,
          durationMs: Date.now() - startTime,
          warnings: scanned.warnings,
          truncated: scanned.truncated,
          headState: scanned.headState,
          headStateComplete: scanned.headStateComplete,
          total: bounded.total,
          generation: bounded.generation,
          ...(bounded.months ? { months: bounded.months } : {})
        };
      } finally {
        try {
          tempStore.close();
        } catch {
          // Ignore close failures.
        }
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  // Step 3: Cache management
  const cache = await openCache({ repoRoot, cacheDir: baseDir });
  const priorHead = cache.getMeta('cached_head');

  if (clearCache) {
    // Deferred: a full rescan below rebuilds into a temp store and
    // atomically promotes it, so clear() here would only destroy the
    // fallback if the scan is interrupted.
  }

  let sinceCommit: string | null = null;
  const cachedHead = clearCache ? null : priorHead;

  if (cachedHead) {
    if (cachedHead === currentHead) {
      onProgress?.({
        phase: 'complete',
        current: 100,
        total: 100,
        message: 'Cache hit — dependency history up to date'
      });
      // Ensure a generation pointer exists even for long-lived caches
      // created before generation tracking (write before bounding so
      // the current result already carries it).
      if (!readGeneration(baseDir)) writeGenerationPointer(baseDir, currentHead);
      const events = cache.queryEvents(filter);
      const bounded = applyBounds(cache, filter, events, { limit, offset, includeAggregates, baseDir });
      const headState = await readHeadState(repoRoot, mergeManifestPaths(
        detected.manifestPaths,
        readCachedManifestPaths(cache) || []
      ), currentHead);
      const warnings = readCachedWarnings(cache);
      const truncated = cache.getMeta('history_truncated') === 'true';
      if (isShallow) warnings.push('Shallow clone: history may be incomplete.');
      cache.close();
      return {
        repository: repoName,
        branch,
        packageManager: detected.packageManager,
        events: bounded.events,
        isShallow,
        cached: true,
        durationMs: Date.now() - startTime,
        warnings,
        truncated,
        headState: headState.entries,
        headStateComplete: headState.complete,
        total: bounded.total,
        generation: bounded.generation,
        ...(bounded.months ? { months: bounded.months } : {})
      };
    }

    const isValidAncestor = await isAncestor(cachedHead, currentHead, repoRoot);
    if (isValidAncestor) {
      sinceCommit = cachedHead;
    } else {
      if (!silent) {
        console.warn('⚠ History rewrite detected. Re-indexing full dependency history...');
      }
    }
  }

  const priorManifestPaths = sinceCommit ? readCachedManifestPaths(cache) : null;
  const replacing = sinceCommit === null && (!!priorHead || clearCache);

  // Full rescans that replace existing data build into a temp store and
  // promote atomically: an interrupted scan can never leave appended
  // duplicates or a half-written HEAD behind.
  if (replacing) {
    try {
      cache.close();
    } catch {
      // Ignore close failures.
    }
    const tempDir = fs.mkdtempSync(path.join(baseDir, '.scan-'));
    try {
      const tempStore = await openCache({ repoRoot, cacheDir: tempDir });
      let scanned;
      try {
        scanned = await executeScan({
          repoRoot,
          scanHead: currentHead,
          store: tempStore,
          detected,
          sinceCommit: null,
          priorManifestPaths: null,
          silent,
          onProgress
        });
      } finally {
        try {
          tempStore.close();
        } catch {
          // Ignore close failures.
        }
      }
      promoteTempStore(baseDir, tempDir);
      const fresh = await openCache({ repoRoot, cacheDir: baseDir });
      try {
        const events = fresh.queryEvents(filter);
        const bounded = applyBounds(fresh, filter, events, { limit, offset, includeAggregates, baseDir });
        const warnings = [...scanned.warnings];
        if (isShallow) warnings.push('Shallow clone: history may be incomplete.');
        return {
          repository: repoName,
          branch,
          packageManager: detected.packageManager,
          events: bounded.events,
          isShallow,
          cached: false,
          durationMs: Date.now() - startTime,
          warnings,
          truncated: scanned.truncated,
          headState: scanned.headState,
          headStateComplete: scanned.headStateComplete,
          total: bounded.total,
          generation: bounded.generation,
          ...(bounded.months ? { months: bounded.months } : {})
        };
      } finally {
        try {
          fresh.close();
        } catch {
          // Ignore close failures.
        }
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  // Incremental scan (or first-ever scan into an empty cache).
  try {
    const scanned = await executeScan({
      repoRoot,
      scanHead: currentHead,
      store: cache,
      detected,
      sinceCommit,
      priorManifestPaths,
      silent,
      onProgress
    });
    writeGenerationPointer(baseDir, currentHead);
    const events = cache.queryEvents(filter);
    const bounded = applyBounds(cache, filter, events, { limit, offset, includeAggregates, baseDir });
    const warnings = [...scanned.warnings];
    if (isShallow) warnings.push('Shallow clone: history may be incomplete.');
    return {
      repository: repoName,
      branch,
      packageManager: detected.packageManager,
      events: bounded.events,
      isShallow,
      cached: false,
      durationMs: Date.now() - startTime,
      warnings,
      truncated: scanned.truncated,
      headState: scanned.headState,
          headStateComplete: scanned.headStateComplete,
      total: bounded.total,
      generation: bounded.generation,
      ...(bounded.months ? { months: bounded.months } : {})
    };
  } catch (err) {
    if (!(err instanceof InvalidBaselineError)) throw err;
    // A persistently corrupt baseline must not recurse forever.
    if ((args._retryCount || 0) >= 1) throw new Error('Cached history baseline is unusable and a fresh rescan also failed. Try --clear-cache.');
    cache.close();
    return await runScanLocked({...args, clearCache: true, _retryCount: (args._retryCount || 0) + 1});
  } finally {
    try {
      cache.close();
    } catch {
      // Ignore close failures.
    }
  }
}

/** Bounded-query helper: prefers store-native paging/aggregates, falls back to memory. */
function applyBounds(
  store: StoreInterface,
  filter: NonNullable<LockedScanArgs['filter']>,
  all: DependencyEvent[],
  opts: { limit?: number; offset?: number; includeAggregates?: boolean; baseDir?: string }
): { events: DependencyEvent[]; total: number; generation: number | null; months?: { month: string; total: number; added: number; updated: number; removed: number }[] } {
  const generation = readGeneration(opts.baseDir);
  const hasPaging = opts.limit !== undefined || opts.offset !== undefined;
  if (hasPaging && typeof (store as { queryPaged?: unknown }).queryPaged === 'function') {
    try {
      const paged = (store as unknown as { queryPaged: (f: typeof filter, p: { limit?: number; offset?: number }) => { events: DependencyEvent[]; total: number } }).queryPaged(filter, { limit: opts.limit ?? 100, offset: opts.offset ?? 0 });
      const months = opts.includeAggregates ? readMonths(store, filter, paged.events) : undefined;
      return { events: paged.events, total: paged.total, generation, ...(months ? { months } : {}) };
    } catch { /* fall through to memory slicing */ }
  }
  const total = all.length;
  let events = all;
  if (hasPaging) {
    const lim = Math.max(0, Math.min(1000, Math.floor(opts.limit ?? total)));
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    events = all.slice(off, off + lim);
  }
  const months = opts.includeAggregates ? readMonths(store, filter, all) : undefined;
  return { events, total, generation, ...(months ? { months } : {}) };
}

function readGeneration(baseDir?: string): number | null {
  if (!baseDir) return null;
  try {
    const raw = fs.readFileSync(path.join(baseDir, 'active.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.generation === 'number' ? parsed.generation : null;
  } catch { return null; }
}

function writeGenerationPointer(baseDir: string, head: string): void {
  try {
    const active = { generation: Date.now(), head, schema: 5, updatedAt: new Date().toISOString() };
    const tmp = path.join(baseDir, `.active-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(active), 'utf8');
    fs.renameSync(tmp, path.join(baseDir, 'active.json'));
  } catch { /* advisory */ }
}

function readMonths(store: StoreInterface, filter: NonNullable<LockedScanArgs['filter']>, fallback: DependencyEvent[]) {
  try {
    const fn = (store as { monthAggregates?: (f: typeof filter) => { month: string; total: number; added: number; updated: number; removed: number }[] }).monthAggregates;
    if (typeof fn === 'function') return fn.call(store, filter);
  } catch { /* ignore */ }
  const buckets = new Map<string, { total: number; added: number; updated: number; removed: number }>();
  for (const ev of fallback) {
    const d = new Date(ev.date);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let b = buckets.get(key);
    if (!b) { b = { total: 0, added: 0, updated: 0, removed: 0 }; buckets.set(key, b); }
    b.total++;
    if (ev.type === 'added') b.added++;
    else if (ev.type === 'updated') b.updated++;
    else if (ev.type === 'removed') b.removed++;
  }
  return [...buckets.entries()].map(([month, b]) => ({ month, ...b })).sort((a, b) => a.month < b.month ? -1 : 1);
}

/** Moves a temp scan's store files over the live cache atomically. */
function promoteTempStore(baseDir: string, tempDir: string): void {
  // Temp stores are already closed at this point, and SqliteStore.close()
  // checkpoints WAL -> main DB, so cache.db is complete on its own.
  // Renames below only move complete files; stale opposite-backend files
  // are removed so readers never mix generations.
  for (const name of ['cache.db', 'cache.db-wal', 'cache.db-shm', 'cache.db-journal', 'cache.json']) {
    const src = path.join(tempDir, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(baseDir, name);
    try {
      if (name === 'cache.db') {
        try { fs.rmSync(path.join(baseDir, 'cache.json'), { force: true }); } catch { /* ignore */ }
      }
      if (name === 'cache.json') {
        for (const stale of ['cache.db', 'cache.db-wal', 'cache.db-shm', 'cache.db-journal']) {
          try { fs.rmSync(path.join(baseDir, stale), { force: true }); } catch { /* ignore */ }
        }
      }
      // rename replaces the destination atomically; deleting first loses the last good cache.
      fs.renameSync(src, dst);
    } catch {
      // Cross-device rename (tmp on another volume): copy + unlink fallback.
      fs.copyFileSync(src, dst);
      try { fs.rmSync(src, { force: true }); } catch { /* ignore */ }
    }
  }
  // Write an atomic generation pointer so readers can pin one generation.
  try {
    const head = tryReadJsonMeta(path.join(baseDir, 'cache.json'), 'cached_head') ?? '';
    const active = { generation: Date.now(), head, schema: 5, updatedAt: new Date().toISOString() };
    const tmp = path.join(baseDir, `.active-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(active), 'utf8');
    fs.renameSync(tmp, path.join(baseDir, 'active.json'));
  } catch { /* generation pointer is advisory */ }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures (stale-temp reaper handles leftovers).
  }
}

function tryReadJsonMeta(jsonPath: string, key: string): string | null {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const v = parsed?.meta?.[key];
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

function readCachedWarnings(store: StoreInterface): string[] {
  try {
    const value = JSON.parse(store.getMeta('history_warnings') || '[]');
    return Array.isArray(value) ? value.filter((v: unknown) => typeof v === 'string') : [];
  } catch { return []; }
}

class InvalidBaselineError extends Error {}

interface ScanInput {
  repoRoot: string;
  scanHead: string;
  store: StoreInterface;
  detected: ReturnType<typeof detectPackageManager>;
  sinceCommit: string | null;
  priorManifestPaths: string[] | null;
  silent?: boolean;
  onProgress: EngineOptions['onProgress'];
}

interface ScanOutput {
  warnings: string[];
  truncated: boolean;
  headState: HeadEntry[];
  headStateComplete: boolean;
}

async function executeScan(input: ScanInput): Promise<ScanOutput> {
  const { repoRoot, scanHead, store, detected, sinceCommit, priorManifestPaths, silent, onProgress } = input;
  const warnings: string[] = sinceCommit ? readCachedWarnings(store) : [];
  const warnedKeys = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    if (!warnings.includes(message)) warnings.push(message);
    if (!silent) console.warn(`⚠ ${stripControl(message)}`);
  };

  // Step 4: Resolve full manifest list.
  onProgress?.({
    phase: 'discovering',
    current: 15,
    total: 100,
    message: 'Resolving dependency manifests...'
  });

  let manifestPaths = detected.manifestPaths;
  let truncated = sinceCommit ? store.getMeta('history_truncated') === 'true' : false;
  if (sinceCommit && priorManifestPaths) {
    manifestPaths = mergeManifestPaths(priorManifestPaths, manifestPaths);
    const historic = await discoverHistoricManifests(repoRoot, 300, sinceCommit + '..' + scanHead);
    manifestPaths = mergeManifestPaths(manifestPaths, historic.paths);
    if (historic.truncated || historic.error) {
      truncated = true;
      warnOnce('incremental-discovery', 'Incremental manifest discovery is incomplete' + (historic.error ? ': ' + historic.error : ' (path cap reached).'));
    }
  } else {
    try {
      const historic = await discoverHistoricManifests(repoRoot, 300, scanHead);
      if (historic.paths.length > 0) manifestPaths = mergeManifestPaths(manifestPaths, historic.paths);
      if (historic.truncated) {
        truncated = true;
        warnOnce('discovery:truncated', 'Manifest discovery hit its path cap; some workspace history may be missing.');
      }
      if (historic.error) {
        warnOnce('discovery:error', `Manifest history scan failed (${historic.error}); showing HEAD-known manifests only.`);
      }
    } catch {
      // Best-effort; HEAD paths alone still produce correct (if partial) results.
    }
  }

  // Step 5: Get manifest commits in topological order.
  onProgress?.({
    phase: 'reading_commits',
    current: 30,
    total: 100,
    message: 'Reading commit history...'
  });

  const commits = await getManifestCommits(repoRoot, {
    sinceCommit,
    manifestPaths,
    reverse: true,
    headCommit: scanHead
  });

  const currentHead = scanHead;

  if (commits.length === 0) {
    const headState = await readHeadState(repoRoot, manifestPaths, scanHead);
    store.transaction(() => {
      store.setMeta('history_warnings', JSON.stringify(warnings));
      store.setMeta('history_truncated', String(truncated));
      if (currentHead) store.setMeta('cached_head', currentHead);
      try {
        store.setMeta(MANIFEST_PATHS_CACHE_KEY, JSON.stringify(manifestPaths));
      } catch {
        // Ignore meta failures.
      }
    });
    onProgress?.({
      phase: 'complete',
      current: 100,
      total: 100,
      message: 'No new dependency commits'
    });
    return { warnings, truncated, headState: headState.entries, headStateComplete: headState.complete };
  }

  const showProgress = !silent && commits.length >= PROGRESS_THRESHOLD;
  const commitSet = new Set(commits.map((c) => c.commit));

  // Children counts for state pruning (memory bounded by DAG frontier).
  const needCount = new Map<string, number>();
  for (const c of commits) {
    for (const p of c.parents) {
      needCount.set(p, (needCount.get(p) || 0) + 1);
    }
  }

  // Per-commit snapshots with structural sharing; pruned when the last
  // in-range child is processed.
  const states = new Map<string, StateMap>();

  // Seed baseline from sinceCommit (one blob per manifest path).
  if (sinceCommit) {
    const seedRequests: BlobRequest[] = manifestPaths.map((p) => ({ commit: sinceCommit as string, path: p }));
    const seedState: StateMap = new Map();
    for await (const { request, content, oid } of streamReadBlobs(repoRoot, seedRequests)) {
      if (content !== null) {
        await seedStateEntry(seedState, request.path, content, warnOnce, true, oid);
      }
    }
    states.set(sinceCommit, seedState);
  }

  // Fetch snapshots for parents outside the scanned range (old branch
  // forks): bounded to files their in-range children actually changed.
  await seedMissingParents(repoRoot, commits, commitSet, sinceCommit, states, warnOnce);

  let processed = 0;
  const newEvents: DependencyEvent[] = [];
  let lastProgressAt = 0;

  // Throttled heartbeat: at most one update per 150ms, always on window
  // edges, so long fetches never look stalled and huge histories never
  // flood the SSE stream / terminal with per-commit spam.
  const emitProgress = (windowIndex: number, windowTotal: number, message: string, detail?: string) => {
    if (!onProgress) return;
    const now = Date.now();
    const isEdge = processed === 0 || processed >= commits.length;
    if (!isEdge && now - lastProgressAt < 150) return;
    lastProgressAt = now;
    onProgress({
      phase: 'analyzing',
      current: processed,
      total: commits.length,
      message: windowTotal > 1 ? `Batch ${windowIndex + 1}/${windowTotal}: ${message}` : message,
      detail: detail ?? (windowTotal > 1 ? `${processed}/${commits.length} commits` : undefined)
    });
  };

  // Blob OID of a snapshot entry's source content.
  const snapshotOid = (state: StateMap | undefined, key: string): string | undefined =>
    state?.get(key)?.unreadable ? undefined : state?.get(key)?.oid;

  const finishCommit = (c: CommitInfo, windowIndex: number, windowTotal: number) => {
    processed++;
    for (const parent of c.parents) {
      const left = (needCount.get(parent) || 1) - 1;
      if (left <= 0) { needCount.delete(parent); states.delete(parent); }
      else needCount.set(parent, left);
    }
    emitProgress(windowIndex, windowTotal, 'Analyzing commit ' + processed + ' of ' + commits.length + '...', c.commit.slice(0, 7) + ': ' + c.message.slice(0, 60));
  };

  const processWindow = async (window: CommitInfo[], windowIndex: number, windowTotal: number): Promise<void> => {
    if (window.length === 0) return;
    const blobRequests: BlobRequest[] = [];
    for (const c of window) {
      for (const f of c.files) {
        if (isManifestFile(f)) blobRequests.push({ commit: c.commit, path: f });
      }
    }

    // Cheap identity pass first: only blobs whose object ID differs from
    // the parent snapshot are transferred. Unchanged lockfiles (the
    // common case) cost one short line each, not megabytes, per commit.
    emitProgress(windowIndex, windowTotal, `Locating changed files (${blobRequests.length} lookups)…`);
    const ids = await resolveBlobOids(repoRoot, blobRequests);
    const requestsByCommit = new Map<string, BlobRequest[]>();
    for (const req of blobRequests) {
      let list = requestsByCommit.get(req.commit);
      if (!list) { list = []; requestsByCommit.set(req.commit, list); }
      list.push(req);
    }
    // Keep normal transfers below 16 MiB. Larger commits are streamed one
    // file at a time through the same diff path, with no aggregate byte cap.
    const groups: CommitInfo[][] = [];
    const largeCommits = new Set<string>();
    let group: CommitInfo[] = [];
    let groupOids = new Set<string>();
    let groupBytes = 0;
    for (const commit of window) {
      const commitOids = new Map<string, number>();
      for (const req of requestsByCommit.get(commit.commit) || []) {
        const id = ids.get(req.commit + ':' + req.path);
        if (!id) throw new Error('Git object sizing response omitted a manifest.');
        if (id.size > MAX_BLOB_BYTES) throw new Error('Manifest blob exceeds the 64 MiB safety limit: ' + req.path + ' at ' + req.commit.slice(0, 7) + '.');
        if (!id.missing) commitOids.set(id.oid, id.size);
      }
      const commitBytes = [...commitOids.values()].reduce((a, b) => a + b, 0);
      if (commitBytes > TRANSFER_TARGET_BYTES) {
        if (group.length) groups.push(group);
        groups.push([commit]);
        largeCommits.add(commit.commit);
        group = []; groupOids = new Set(); groupBytes = 0;
        continue;
      }
      let extra = [...commitOids].reduce((n, [oid, bytes]) => n + (groupOids.has(oid) ? 0 : bytes), 0);
      if (group.length && groupBytes + extra > TRANSFER_TARGET_BYTES) {
        groups.push(group); group = []; groupOids = new Set(); groupBytes = 0; extra = commitBytes;
      }
      group.push(commit);
      for (const oid of commitOids.keys()) groupOids.add(oid);
      groupBytes += extra;
    }
    if (group.length) groups.push(group);
    for (const chunk of groups) {
      if (largeCommits.has(chunk[0].commit)) {
        const c = chunk[0];
        const base = c.parents.length ? states.get(c.parents[0]) : undefined;
        const requests = orderedManifestFiles(c).map(f => ({ commit: c.commit, path: f })).filter(req => {
          const id = ids.get(req.commit + ':' + req.path)!;
          return id.missing || snapshotOid(base, req.path) !== id.oid;
        });
        emitProgress(windowIndex, windowTotal, 'Streaming ' + requests.length + ' file(s) from large commit ' + c.commit.slice(0, 7) + '…');
        await processCommit(c, streamReadBlobs(repoRoot, requests), states, newEvents, warnOnce);
        finishCommit(c, windowIndex, windowTotal);
        continue;
      }
      const blobs = new Map<string, string | null>();
      const oids = new Map<string, string>();
      const toFetch: BlobRequest[] = [];
      const aliases = new Map<string, string>();
      const canonicalByOid = new Map<string, string>();
      let transferBytes = 0;
      let skippedBytes = 0;
      for (const c of chunk) {
        const base = c.parents.length ? states.get(c.parents[0]) : undefined;
        for (const req of requestsByCommit.get(c.commit) || []) {
          const key = req.commit + ':' + req.path;
          const id = ids.get(key)!;
          if (id.missing) { blobs.set(key, null); continue; }
          oids.set(key, id.oid);
          if (snapshotOid(base, req.path) === id.oid) { skippedBytes += id.size; continue; }
          const canonical = canonicalByOid.get(id.oid);
          if (canonical) { aliases.set(key, canonical); continue; }
          canonicalByOid.set(id.oid, key);
          transferBytes += id.size;
          toFetch.push(req);
        }
      }
      if (toFetch.length) {
        const skipped = skippedBytes ? ' · skipped ' + (skippedBytes / 1048576).toFixed(1) + ' MiB unchanged' : '';
        emitProgress(windowIndex, windowTotal, 'Reading ' + toFetch.length + ' unique file(s), ' + (transferBytes / 1024).toFixed(0) + ' KiB' + skipped, processed + '/' + commits.length + ' commits');
        const fetched = await batchReadBlobs(repoRoot, toFetch);
        for (const [k, v] of fetched) blobs.set(k, v);
        for (const [alias, canonical] of aliases) {
          if (!fetched.has(canonical)) throw new Error('Incomplete Git blob transfer.');
          blobs.set(alias, fetched.get(canonical)!);
        }
      }
      for (const c of chunk) {
        await processCommit(c, bufferedCommitContents(c, blobs, oids), states, newEvents, warnOnce);
        for (const req of requestsByCommit.get(c.commit) || []) blobs.delete(req.commit + ':' + req.path);
        finishCommit(c, windowIndex, windowTotal);
      }
    }

    if (showProgress) {
      console.warn(`  dep-blame: indexed ${processed}/${commits.length} commits...`);
    }
  };

  // Slice commits so no window exceeds blob or count budgets. Slicing is
  // synchronous metadata work, so window indexes are known up front and
  // every fetch carries an exact "batch i/n" label — no silent stretches.
  const windows: CommitInfo[][] = [];
  {
    let window: CommitInfo[] = [];
    let windowBlobs = 0;
    for (const c of commits) {
      window.push(c);
      windowBlobs += c.files.length;
      if (window.length >= WINDOW_MAX_COMMITS || windowBlobs >= WINDOW_TARGET_BLOBS) {
        windows.push(window);
        window = [];
        windowBlobs = 0;
      }
    }
    if (window.length > 0) windows.push(window);
  }
  for (let i = 0; i < windows.length; i++) {
    await processWindow(windows[i], i, windows.length);
  }

  // Single atomic unit: events + HEAD pointer + manifest list commit
  // together, so an interrupted scan retries cleanly with no duplicates.
  store.transaction(() => {
    store.setMeta('history_warnings', JSON.stringify(warnings));
    store.setMeta('history_truncated', String(truncated));
    store.insertEvents(newEvents);
    if (currentHead) store.setMeta('cached_head', currentHead);
    try {
      store.setMeta(MANIFEST_PATHS_CACHE_KEY, JSON.stringify(manifestPaths));
    } catch {
      // Ignore meta failures.
    }
  });

  onProgress?.({
    phase: 'saving',
    current: commits.length,
    total: commits.length,
    message: 'Saving dependency cache...'
  });

  const headState = await readHeadState(repoRoot, manifestPaths, scanHead);

  onProgress?.({
    phase: 'complete',
    current: commits.length,
    total: commits.length,
    message: 'Dependency analysis complete'
  });

  return { warnings, truncated, headState: headState.entries, headStateComplete: headState.complete };
}

/** Seeds one manifest path into a state map (used for baselines). */
async function seedStateEntry(
  state: StateMap,
  manifestPath: string,
  content: string,
  warnOnce: (key: string, message: string) => void,
  requireReadable = false,
  oid?: string
): Promise<void> {
  if (manifestPath.endsWith('pnpm-lock.yaml') || manifestPath.endsWith('bun.lock') || manifestPath.endsWith('bun.lockb')) {
    const multi = await parseLockfilePerManifest(manifestPath, content);
    if (multi === null || !multi.ok) {
      if (multi && requireReadable) throw new InvalidBaselineError();
      return;
    }
    const hash = hashContent(content);
    for (const [manifest, map] of multi.maps) {
      state.set(lockStateKey(manifestPath, manifest), { map, hash, oid });
    }
    state.set(manifestPath, { map: new Map(), hash, oid });
    return;
  }
  const res = await parseAnyManifest(manifestPath, content);
  if (res === null || !res.ok) {
    if (res && requireReadable) throw new InvalidBaselineError();
    if (res && res.note) warnOnce(`seed:${manifestPath}`, `Skipping undecodable ${manifestPath} at baseline (${res.note}).`);
    return;
  }
  state.set(manifestPath, { map: res.entries, hash: hashContent(content), oid });
  if (res.note) warnOnce(`seed-note:${manifestPath}:${res.note}`, `${manifestPath} at baseline: ${res.note}.`);
}

/**
 * Fetches snapshots for parents outside the scanned range so
 * branch commits diff against their true baseline, not an empty map.
 */
async function seedMissingParents(
  repoRoot: string,
  commits: CommitInfo[],
  commitSet: Set<string>,
  sinceCommit: string | null,
  states: Map<string, StateMap>,
  warnOnce: (key: string, message: string) => void
): Promise<void> {
  // Which manifest files does each missing parent need? Only files its
  // in-range children changed.
  const needed = new Map<string, Set<string>>();
  for (const c of commits) {
    for (const p of c.parents) {
      if (p === sinceCommit || commitSet.has(p) || states.has(p)) continue;
      let set = needed.get(p);
      if (!set) {
        set = new Set();
        needed.set(p, set);
      }
      for (const f of c.files) {
        if (isManifestFile(f)) set.add(f);
      }
    }
  }
  if (needed.size === 0) return;

  const requests: BlobRequest[] = [];
  for (const [parent, files] of needed) {
    states.set(parent, new Map());
    for (const f of files) requests.push({ commit: parent, path: f });
  }
  // Bound recovery walks: a corrupt parent with hundreds of files must not
  // fan out into unbounded `git log` history walks below.
  const MAX_RECOVERY_COMMITS = 50;
  let recoveryWalks = 0;
  for await (const { request, content, oid } of streamReadBlobs(repoRoot, requests)) {
    const parent = request.commit;
    const f = request.path;
    const state = states.get(parent)!;
    if (content !== null) {
      try {
        await seedStateEntry(state, f, content, warnOnce, true, oid);
      } catch (err) {
        if (!(err instanceof InvalidBaselineError)) throw err;
        // A non-manifest commit may sit between a corrupt blob and its repair.
        // Recover the last readable version along this parent's first-parent history.
        if (++recoveryWalks > MAX_RECOVERY_COMMITS) {
          warnOnce(`parent-corrupt:${f}`, `Too many corrupt baselines; skipping recovery for ${f} at parent ${parent.slice(0, 7)}.`);
          continue;
        }
        const { stdout } = await execGit(['log', '--first-parent', '--format=%H', '-n', '50', parent, '--', f], repoRoot);
        let restored = false;
        for (const sha of stdout.trim().split('\n').filter(Boolean)) {
          const prior = (await batchReadBlobs(repoRoot, [{commit: sha, path: f}])).get(`${sha}:${f}`);
          if (prior === null || prior === undefined) { restored = true; break; }
          try {
            await seedStateEntry(state, f, prior, warnOnce, true);
            restored = true;
            break;
          } catch (err) { if (!(err instanceof InvalidBaselineError)) throw err; }
        }
        warnOnce(`parent-corrupt:${f}`, restored
          ? `Recovered last readable ${f} before corrupt parent ${parent.slice(0, 7)}.`
          : `No readable baseline for ${f} at parent ${parent.slice(0, 7)}; changes may be incomplete.`);
        markUnreadable(state, f);
      }
    } else if (f.endsWith('package.json')) {
      state.set(f, { map: new Map(), hash: '' });
    }
  }
}

function orderedManifestFiles(c: CommitInfo): string[] {
  return [...c.files.filter(f => f.endsWith('package.json')), ...c.files.filter(isLockfilePath)];
}

async function* bufferedCommitContents(
  c: CommitInfo,
  blobs: Map<string, string | null>,
  oids: Map<string, string>
): AsyncGenerator<BlobContent> {
  for (const f of orderedManifestFiles(c)) {
    const key = c.commit + ':' + f;
    // OID-identical to the parent: carry shared state forward untouched.
    if (!blobs.has(key)) continue;
    yield { request: { commit: c.commit, path: f }, content: blobs.get(key)!, oid: oids.get(key) };
  }
}

/**
 * Diffs one commit against its own first parent and records events.
 * Corrupt blobs keep the parent state and warn; lockfile deletion
 * warns (resolution lost) instead of inventing removals.
 */
async function processCommit(
  c: CommitInfo,
  contents: AsyncIterable<BlobContent>,
  states: Map<string, StateMap>,
  newEvents: DependencyEvent[],
  warnOnce: (key: string, message: string) => void
): Promise<void> {
  const short = c.commit.length > 7 ? c.commit.slice(0, 7) : c.commit;
  const firstParent = c.parents.length > 0 ? c.parents[0] : null;
  const base: StateMap = (firstParent && states.get(firstParent)) || new Map();
  const next: StateMap = new Map(base);
  const directPackagesInCommit = new Set<string>();
  const eventStart = newEvents.length;

  // Contents arrive with declarations first, then resolved lockfiles.
  // Both paths use this same diff logic, including streamed large commits.
  for await (const { request, content, oid } of contents) {
    const f = request.path;
    if (f.endsWith('package.json')) {
      const prev = base.get(f);
      if (content === null || content === undefined) {
        if (prev && prev.map.size > 0) {
          const events = diffSnapshots(prev.map, new Map(), c, f, { source: 'manifest' });
          for (const ev of events) {
            directPackagesInCommit.add(ev.package);
            newEvents.push(ev);
          }
        }
        next.set(f, { map: new Map(), hash: '' });
        continue;
      }
      const h = hashContent(content);
      if (prev && h === prev.hash) {
        if (prev.unreadable) next.set(f, { ...prev, oid, unreadable: false });
        continue; // unchanged (merge/mode-only change)
      }
      const res = parsePackageJsonSync(content);
      if (!res.ok) {
        markUnreadable(next, f);
        warnOnce(`corrupt:${f}:${res.note || 'invalid'}`, `Skipping undecodable ${f} at ${short} (${res.note || 'invalid'}); keeping previous state.`);
        continue;
      }
      const currMap = res.entries;
      const prevMap = prev ? prev.map : new Map<string, DependencyEntry>();
      const events = diffSnapshots(prevMap, currMap, c, f, { source: 'manifest' });
      for (const ev of events) {
        directPackagesInCommit.add(ev.package);
        newEvents.push(ev);
      }
      next.set(f, { map: currMap, hash: h, oid });
      continue;
    }

    if (!isLockfilePath(f)) continue;
    if (content === null || content === undefined) {
      // Resolution info lost — never removals of declared packages.
      const had = baseHasLockData(base, f);
      if (had) {
        warnOnce(`lockfile-deleted:${f}`, `${f} was deleted at ${short}; resolution history ends there (declared dependencies unchanged).`);
      }
      dropLockState(next, f);
      continue;
    }
    if (f.endsWith('pnpm-lock.yaml') || f.endsWith('bun.lock') || f.endsWith('bun.lockb')) {
      await processMultiManifestLockfile(c, f, content, base, next, newEvents, directPackagesInCommit, warnOnce, oid);
      continue;
    }
    const h = hashContent(content);
    const prev = base.get(f);
    if (prev && h === prev.hash) {
      if (prev.unreadable) next.set(f, { ...prev, oid, unreadable: false });
      continue;
    }
    const res = await parseAnyManifest(f, content);
    if (res === null) {
      markUnreadable(next, f);
      if (directPackagesInCommit.size === 0) {
        newEvents.push(createLockfileLowFiEvent(c, f));
      }
      warnOnce('yaml-missing', 'A lockfile needs the optional `yaml` parser (`npm install yaml`); showing low-fidelity lockfile events.');
      continue;
    }
    if (!res.ok) {
      markUnreadable(next, f);
      warnOnce(`corrupt:${f}:${res.note || 'invalid'}`, `Skipping undecodable ${f} at ${short} (${res.note || 'invalid'}); keeping previous state.`);
      continue;
    }
    if (res.note) {
      warnOnce(`note:${f}:${res.note}`, `${f} at ${short}: ${res.note}.`);
    }
    const currMap = res.entries;
    const prevMap = prev ? prev.map : new Map<string, DependencyEntry>();
    const lockEvents = diffSnapshots(prevMap, currMap, c, f, { source: 'lockfile' });
    for (const ev of lockEvents) {
      newEvents.push(ev);
    }
    next.set(f, { map: currMap, hash: h, oid });
  }

  for (let i = eventStart; i < newEvents.length; i++) {
    newEvents[i].changeOrigin = classifyChangeOrigin(newEvents[i], c, states);
  }
  states.set(c.commit, next);
}

/** A matching incoming snapshot proves integration; messages and names do not. */
function classifyChangeOrigin(event: DependencyEvent, c: CommitInfo, states: Map<string, StateMap>): DependencyEvent['changeOrigin'] {
  if (c.parents.length < 2) return 'direct';
  const key = event.lockfile ? lockStateKey(event.lockfile, event.manifest) : event.manifest;
  for (const parent of c.parents.slice(1)) {
    const snapshot = states.get(parent)?.get(key);
    if (!snapshot || snapshot.unreadable) continue;
    const incoming = snapshot.map.get(event.package);
    if (event.type === 'removed') {
      if (!incoming) return 'merge-integration';
    } else if (incoming && incoming.version === event.to && incoming.depType === event.depType &&
      Boolean(incoming.ambiguous) === Boolean(event.ambiguous) &&
      JSON.stringify(incoming.resolutions || null) === JSON.stringify(event.resolutions || null)) {
      return 'merge-integration';
    }
  }
  return 'merge-change';
}

function parsePackageJsonSync(content: string): ParseResult {
  return parsePackageJson(content);
}

function baseHasLockData(base: StateMap, lockPath: string): boolean {
  const direct = base.get(lockPath);
  if (direct && direct.map.size > 0) return true;
  const prefix = `${lockPath}::`;
  for (const [key, entry] of base) {
    if (key.startsWith(prefix) && entry.map.size > 0) return true;
  }
  return false;
}

function dropLockState(next: StateMap, lockPath: string): void {
  next.delete(lockPath);
  const prefix = `${lockPath}::`;
  for (const key of Array.from(next.keys())) {
    if (key.startsWith(prefix)) next.delete(key);
  }
}

async function processMultiManifestLockfile(
  c: CommitInfo,
  lockPath: string,
  content: string,
  base: StateMap,
  next: StateMap,
  newEvents: DependencyEvent[],
  directPackagesInCommit: Set<string>,
  warnOnce: (key: string, message: string) => void,
  lockOid: string | undefined
): Promise<void> {
  const short = c.commit.length > 7 ? c.commit.slice(0, 7) : c.commit;
  const h = hashContent(content);
  const multi = await parseLockfilePerManifest(lockPath, content);
  if (multi === null) {
    markUnreadable(next, lockPath);
    if (directPackagesInCommit.size === 0) {
      newEvents.push(createLockfileLowFiEvent(c, lockPath));
    }
    warnOnce('yaml-missing', 'A lockfile needs the optional `yaml` parser (`npm install yaml`); showing low-fidelity lockfile events.');
    return;
  }
  if (!multi.ok) {
    markUnreadable(next, lockPath);
    warnOnce(`corrupt:${lockPath}:${multi.note || 'invalid'}`, `Skipping undecodable ${lockPath} at ${short} (${multi.note || 'invalid'}); keeping previous state.`);
    return;
  }
  if (multi.note) {
    warnOnce(`note:${lockPath}:${multi.note}`, `${lockPath} at ${short}: ${multi.note}.`);
  }
  const seenManifests = new Set<string>();
  for (const [manifest, currMap] of multi.maps) {
    seenManifests.add(manifest);
    const key = lockStateKey(lockPath, manifest);
    const prev = base.get(key);
    if (prev && h === prev.hash) {
      // Carry the recorded blob OID forward so later commits keep
      // skipping this importer without re-fetching.
      if (prev.unreadable || (prev.oid === undefined && lockOid !== undefined)) {
        next.set(key, { map: prev.map, hash: prev.hash, oid: lockOid });
      }
      continue;
    }
    const prevMap = prev ? prev.map : new Map<string, DependencyEntry>();
    const lockEvents = diffSnapshots(prevMap, currMap, c, manifest, {
      source: 'lockfile' as EventSource,
      lockfile: lockPath
    });
    for (const ev of lockEvents) {
      newEvents.push(ev);
    }
    next.set(key, { map: currMap, hash: h, oid: lockOid });
  }
  // Lock-level identity record: identical content implies an identical
  // importer set, so future commits skip the whole file without parsing.
  next.set(lockPath, { map: new Map(), hash: h, oid: lockOid });
  // Importers that vanished from the lockfile: resolution lost, not removals.
  const prefix = `${lockPath}::`;
  for (const [key, entry] of base) {
    if (!key.startsWith(prefix) || entry.map.size === 0) continue;
    const manifest = key.slice(prefix.length);
    if (!seenManifests.has(manifest)) {
      warnOnce(`lockfile-importer-lost:${lockPath}:${manifest}`, `${manifest} no longer resolved by ${lockPath} at ${short}; keeping last resolved state.`);
      next.set(key, { ...entry, unreadable: true });
    }
  }
}

/**
 * Declared dependency state at HEAD, so package status reflects reality
 * instead of the last chronological event (which may live on an
 * unmerged branch).
 */
async function readHeadState(repoRoot: string, manifestPaths: string[], pinnedHead?: string): Promise<{entries: HeadEntry[]; complete: boolean}> {
  const pkgPaths = manifestPaths.filter((p) => p.endsWith('package.json'));
  if (pkgPaths.length === 0) return {entries: [], complete: true};
  let head: string;
  try {
    const { execGit } = await import('./git/repo.js');
    head = pinnedHead || (await execGit(['rev-parse', 'HEAD'], repoRoot)).stdout.trim();
    if (!head) return {entries: [], complete: false};
  } catch {
    return {entries: [], complete: false};
  }
  const requests: BlobRequest[] = pkgPaths.map((p) => ({ commit: head, path: p }));
  const out: HeadEntry[] = [];
  let complete = true;
  try {
    for await (const { request, content } of streamReadBlobs(repoRoot, requests)) {
      if (content === null) continue;
      const res = parsePackageJson(content);
      if (!res.ok) { complete = false; continue; }
      for (const [pkg, entry] of res.entries) {
        out.push({ manifest: request.path, package: pkg, version: entry.version, depType: entry.depType });
      }
    }
  } catch {
    return {entries: [], complete: false};
  }
  return {entries: out, complete};
}
