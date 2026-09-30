import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  getRepoState,
  isAncestor
} from './git/repo.js';
import { getManifestCommits } from './git/log.js';
import { batchReadBlobs } from './git/batch.js';
import { detectPackageManager, discoverHistoricManifests, mergeManifestPaths } from './manifest/detect.js';
import { parsePackageJson } from './manifest/package-json.js';
import { parseNpmLockfile } from './manifest/lockfiles/npm.js';
import { parsePnpmLockfiles } from './manifest/lockfiles/pnpm.js';
import { parseYarnLockfile } from './manifest/lockfiles/yarn.js';
import { parseBunLockfiles } from './manifest/lockfiles/bun.js';
import { diffSnapshots, createLockfileLowFiEvent } from './diff/snapshot-diff.js';
import { openCache, resolveCacheBaseDir } from './cache/index.js';
import { acquireScanLock } from './cache/lock.js';
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
// Streaming windows bound peak memory: ~1500 blobs ≈ 5-15MB, not 500MB.
const WINDOW_TARGET_BLOBS = 1500;
const WINDOW_MAX_COMMITS = 300;
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
  if (!content) return { ok: true, entries: new Map() };

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

/** Snapshot entry: parsed map plus content hash for skip-fast paths. */
interface SnapEntry {
  map: Map<string, DependencyEntry>;
  hash: string;
}

type StateMap = Map<string, SnapEntry>;

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
  const { cwd = process.cwd(), noCache = false, clearCache = false, cacheDir, filter = {}, onProgress } = options;

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
  const lock = await acquireScanLock(baseDir);
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
      startTime
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
}

async function runScanLocked(args: LockedScanArgs): Promise<EngineResult> {
  const { repoRoot, repoName, branch, isShallow, currentHead, baseDir } = args;
  const { noCache, clearCache, filter = {}, silent, onProgress, startTime } = args;

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
          store: tempStore,
          detected,
          sinceCommit: null,
          priorManifestPaths: null,
          silent,
          onProgress
        });
        const events = tempStore.queryEvents(filter);
        return {
          repository: repoName,
          branch,
          packageManager: detected.packageManager,
          events,
          isShallow,
          cached: false,
          durationMs: Date.now() - startTime,
          warnings: scanned.warnings,
          truncated: scanned.truncated,
          headState: scanned.headState
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
      const events = cache.queryEvents(filter);
      const headState = await readHeadState(repoRoot, mergeManifestPaths(
        detected.manifestPaths,
        readCachedManifestPaths(cache) || []
      ));
      const warnings: string[] = [];
      if (isShallow) warnings.push('Shallow clone: history may be incomplete.');
      cache.close();
      return {
        repository: repoName,
        branch,
        packageManager: detected.packageManager,
        events,
        isShallow,
        cached: true,
        durationMs: Date.now() - startTime,
        warnings,
        headState
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
        const warnings = [...scanned.warnings];
        if (isShallow) warnings.push('Shallow clone: history may be incomplete.');
        return {
          repository: repoName,
          branch,
          packageManager: detected.packageManager,
          events,
          isShallow,
          cached: false,
          durationMs: Date.now() - startTime,
          warnings,
          truncated: scanned.truncated,
          headState: scanned.headState
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
      store: cache,
      detected,
      sinceCommit,
      priorManifestPaths,
      silent,
      onProgress
    });
    const events = cache.queryEvents(filter);
    const warnings = [...scanned.warnings];
    if (isShallow) warnings.push('Shallow clone: history may be incomplete.');
    return {
      repository: repoName,
      branch,
      packageManager: detected.packageManager,
      events,
      isShallow,
      cached: false,
      durationMs: Date.now() - startTime,
      warnings,
      truncated: scanned.truncated,
      headState: scanned.headState
    };
  } finally {
    try {
      cache.close();
    } catch {
      // Ignore close failures.
    }
  }
}

/** Moves a temp scan's store files over the live cache atomically. */
function promoteTempStore(baseDir: string, tempDir: string): void {
  for (const name of ['cache.db', 'cache.db-wal', 'cache.db-shm', 'cache.db-journal', 'cache.json']) {
    const src = path.join(tempDir, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(baseDir, name);
    try {
      fs.rmSync(dst, { force: true });
    } catch {
      // Ignore removal failures; rename will surface real errors.
    }
    fs.renameSync(src, dst);
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures (stale-temp reaper handles leftovers).
  }
}

interface ScanInput {
  repoRoot: string;
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
}

async function executeScan(input: ScanInput): Promise<ScanOutput> {
  const { repoRoot, store, detected, sinceCommit, priorManifestPaths, silent, onProgress } = input;
  const warnings: string[] = [];
  const warnedKeys = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warnings.push(message);
    if (!silent) console.warn(`⚠ ${message}`);
  };

  // Step 4: Resolve full manifest list.
  onProgress?.({
    phase: 'discovering',
    current: 15,
    total: 100,
    message: 'Resolving dependency manifests...'
  });

  let manifestPaths = detected.manifestPaths;
  let truncated = false;
  if (sinceCommit && priorManifestPaths) {
    manifestPaths = mergeManifestPaths(priorManifestPaths, manifestPaths);
  } else {
    try {
      const historic = await discoverHistoricManifests(repoRoot);
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
    reverse: true
  });

  const currentHead = await readCurrentHeadSafe(repoRoot);

  if (commits.length === 0) {
    const headState = await readHeadState(repoRoot, manifestPaths);
    store.transaction(() => {
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
    return { warnings, truncated, headState };
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
    for (let i = 0; i < seedRequests.length; i += 1000) {
      const slice = seedRequests.slice(i, i + 1000);
      const seedBlobs = await batchReadBlobs(repoRoot, slice);
      for (const req of slice) {
        const content = seedBlobs.get(`${req.commit}:${req.path}`);
        if (content) {
          await seedStateEntry(seedState, req.path, content, warnOnce);
        }
      }
    }
    states.set(sinceCommit, seedState);
  }

  // Fetch snapshots for parents outside the scanned range (old branch
  // forks): bounded to files their in-range children actually changed.
  await seedMissingParents(repoRoot, commits, commitSet, sinceCommit, states, warnOnce);

  let processed = 0;
  const newEvents: DependencyEvent[] = [];

  const processWindow = async (window: CommitInfo[]): Promise<void> => {
    if (window.length === 0) return;
    const blobRequests: BlobRequest[] = [];
    for (const c of window) {
      for (const f of c.files) {
        if (isManifestFile(f)) blobRequests.push({ commit: c.commit, path: f });
      }
    }
    const blobs = await batchReadBlobs(repoRoot, blobRequests);

    for (const c of window) {
      // Awaited: each commit's snapshots must be stored before pruning
      // runs and before the next commit reads them. Fire-and-forget here
      // used to lose async continuations (e.g. yaml imports) past the
      // cache transaction and corrupt parent-state pruning.
      await processCommit(c, blobs, states, newEvents, warnOnce);
      processed++;
      // Prune parent states no longer needed by future commits.
      for (const p of c.parents) {
        const left = (needCount.get(p) || 1) - 1;
        if (left <= 0) {
          needCount.delete(p);
          states.delete(p);
        } else {
          needCount.set(p, left);
        }
      }
      if (onProgress) {
        onProgress({
          phase: 'analyzing',
          current: processed,
          total: commits.length,
          message: `Analyzing commit ${processed} of ${commits.length}...`,
          detail: `${c.commit.slice(0, 7)}: ${c.message.slice(0, 60)}`
        });
      }
    }

    if (showProgress) {
      console.warn(`  dep-blame: indexed ${processed}/${commits.length} commits...`);
    }
  };

  // Slice commits so no window exceeds blob or count budgets.
  let window: CommitInfo[] = [];
  let windowBlobs = 0;
  for (const c of commits) {
    window.push(c);
    windowBlobs += c.files.length;
    if (window.length >= WINDOW_MAX_COMMITS || windowBlobs >= WINDOW_TARGET_BLOBS) {
      await processWindow(window);
      window = [];
      windowBlobs = 0;
    }
  }
  await processWindow(window);

  // Single atomic unit: events + HEAD pointer + manifest list commit
  // together, so an interrupted scan retries cleanly with no duplicates.
  store.transaction(() => {
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

  const headState = await readHeadState(repoRoot, manifestPaths);

  onProgress?.({
    phase: 'complete',
    current: commits.length,
    total: commits.length,
    message: 'Dependency analysis complete'
  });

  return { warnings, truncated, headState };
}

/** Seeds one manifest path into a state map (used for baselines). */
async function seedStateEntry(
  state: StateMap,
  manifestPath: string,
  content: string,
  warnOnce: (key: string, message: string) => void
): Promise<void> {
  if (manifestPath.endsWith('pnpm-lock.yaml') || manifestPath.endsWith('bun.lock') || manifestPath.endsWith('bun.lockb')) {
    const multi = await parseLockfilePerManifest(manifestPath, content);
    if (multi === null || !multi.ok) {
      return;
    }
    for (const [manifest, map] of multi.maps) {
      state.set(lockStateKey(manifestPath, manifest), { map, hash: hashContent(content) });
    }
    return;
  }
  const res = await parseAnyManifest(manifestPath, content);
  if (res === null || !res.ok) {
    if (res && res.note) warnOnce(`seed:${manifestPath}`, `Skipping undecodable ${manifestPath} at baseline (${res.note}).`);
    return;
  }
  state.set(manifestPath, { map: res.entries, hash: hashContent(content) });
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
    for (const f of files) requests.push({ commit: parent, path: f });
  }
  let blobs: Map<string, string | null>;
  try {
    blobs = await batchReadBlobs(repoRoot, requests);
  } catch {
    warnOnce('parents:read', 'Could not read some parent commit snapshots; affected branch diffs may be approximate.');
    return;
  }
  for (const [parent, files] of needed) {
    const state: StateMap = new Map();
    for (const f of files) {
      const content = blobs.get(`${parent}:${f}`);
      if (content) {
        await seedStateEntry(state, f, content, warnOnce);
      }
    }
    states.set(parent, state);
  }
}

/**
 * Diffs one commit against its own first parent and records events.
 * Corrupt blobs keep the parent state and warn; lockfile deletion
 * warns (resolution lost) instead of inventing removals.
 */
function processCommitSyncPlaceholder(): void {
  // (async work happens in processCommit below; kept separate for clarity)
}

async function processCommit(
  c: CommitInfo,
  blobs: Map<string, string | null>,
  states: Map<string, StateMap>,
  newEvents: DependencyEvent[],
  warnOnce: (key: string, message: string) => void
): Promise<void> {
  void processCommitSyncPlaceholder;
  const short = c.commit.length > 7 ? c.commit.slice(0, 7) : c.commit;
  const firstParent = c.parents.length > 0 ? c.parents[0] : null;
  const base: StateMap = (firstParent && states.get(firstParent)) || new Map();
  const next: StateMap = new Map(base);
  const directPackagesInCommit = new Set<string>();

  // Declared manifests first: direct intent wins same-commit dedup.
  for (const f of c.files) {
    if (!f.endsWith('package.json')) continue;
    const content = blobs.get(`${c.commit}:${f}`);
    const prev = base.get(f);
    if (!content) {
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
      continue; // unchanged (merge/mode-only change)
    }
    const res = parsePackageJsonSync(content);
    if (!res.ok) {
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
    next.set(f, { map: currMap, hash: h });
  }

  // Resolved lockfiles second.
  for (const f of c.files) {
    if (!isLockfilePath(f)) continue;
    const content = blobs.get(`${c.commit}:${f}`);
    if (!content) {
      // Resolution info lost — never removals of declared packages.
      const had = baseHasLockData(base, f);
      if (had) {
        warnOnce(`lockfile-deleted:${f}`, `${f} was deleted at ${short}; resolution history ends there (declared dependencies unchanged).`);
      }
      dropLockState(next, f);
      continue;
    }
    if (f.endsWith('pnpm-lock.yaml') || f.endsWith('bun.lock') || f.endsWith('bun.lockb')) {
      await processMultiManifestLockfile(c, f, content, base, next, newEvents, directPackagesInCommit, warnOnce);
      continue;
    }
    const h = hashContent(content);
    const prev = base.get(f);
    if (prev && h === prev.hash) continue;
    const res = await parseAnyManifest(f, content);
    if (res === null) {
      if (directPackagesInCommit.size === 0) {
        newEvents.push(createLockfileLowFiEvent(c, f));
      }
      warnOnce('yaml-missing', 'A lockfile needs the optional `yaml` parser (`npm install yaml`); showing low-fidelity lockfile events.');
      continue;
    }
    if (!res.ok) {
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
      if (!directPackagesInCommit.has(ev.package)) newEvents.push(ev);
    }
    next.set(f, { map: currMap, hash: h });
  }

  states.set(c.commit, next);
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
  warnOnce: (key: string, message: string) => void
): Promise<void> {
  const short = c.commit.length > 7 ? c.commit.slice(0, 7) : c.commit;
  const h = hashContent(content);
  const multi = await parseLockfilePerManifest(lockPath, content);
  if (multi === null) {
    if (directPackagesInCommit.size === 0) {
      newEvents.push(createLockfileLowFiEvent(c, lockPath));
    }
    warnOnce('yaml-missing', 'A lockfile needs the optional `yaml` parser (`npm install yaml`); showing low-fidelity lockfile events.');
    return;
  }
  if (!multi.ok) {
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
    if (prev && h === prev.hash) continue;
    const prevMap = prev ? prev.map : new Map<string, DependencyEntry>();
    const lockEvents = diffSnapshots(prevMap, currMap, c, manifest, {
      source: 'lockfile' as EventSource,
      lockfile: lockPath
    });
    for (const ev of lockEvents) {
      if (!directPackagesInCommit.has(ev.package)) newEvents.push(ev);
    }
    next.set(key, { map: currMap, hash: h });
  }
  // Importers that vanished from the lockfile: resolution lost, not removals.
  const prefix = `${lockPath}::`;
  for (const [key, entry] of base) {
    if (!key.startsWith(prefix) || entry.map.size === 0) continue;
    const manifest = key.slice(prefix.length);
    if (!seenManifests.has(manifest)) {
      warnOnce(`lockfile-importer-lost:${lockPath}:${manifest}`, `${manifest} no longer resolved by ${lockPath} at ${short}; keeping last resolved state.`);
      next.set(key, entry);
    }
  }
}

async function readCurrentHeadSafe(repoRoot: string): Promise<string | null> {
  try {
    const { execGit } = await import('./git/repo.js');
    const { stdout } = await execGit(['rev-parse', 'HEAD'], repoRoot);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Declared dependency state at HEAD, so package status reflects reality
 * instead of the last chronological event (which may live on an
 * unmerged branch).
 */
async function readHeadState(repoRoot: string, manifestPaths: string[]): Promise<HeadEntry[]> {
  const pkgPaths = manifestPaths.filter((p) => p.endsWith('package.json'));
  if (pkgPaths.length === 0) return [];
  let head: string;
  try {
    const { execGit } = await import('./git/repo.js');
    const { stdout } = await execGit(['rev-parse', 'HEAD'], repoRoot);
    head = stdout.trim();
    if (!head) return [];
  } catch {
    return [];
  }
  const requests: BlobRequest[] = pkgPaths.map((p) => ({ commit: head, path: p }));
  let blobs: Map<string, string | null>;
  try {
    blobs = await batchReadBlobs(repoRoot, requests);
  } catch {
    return [];
  }
  const out: HeadEntry[] = [];
  for (const p of pkgPaths) {
    const content = blobs.get(`${head}:${p}`);
    if (!content) continue;
    const res = parsePackageJson(content);
    if (!res.ok) continue;
    for (const [pkg, entry] of res.entries) {
      out.push({ manifest: p, package: pkg, version: entry.version, depType: entry.depType });
    }
  }
  return out;
}
