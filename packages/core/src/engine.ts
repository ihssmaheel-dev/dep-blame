import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  checkGit,
  getRepoRoot,
  getCurrentHead,
  isShallowRepo,
  isAncestor
} from './git/repo.js';
import { getManifestCommits } from './git/log.js';
import { batchReadBlobs } from './git/batch.js';
import { detectPackageManager, discoverHistoricManifests, mergeManifestPaths } from './manifest/detect.js';
import { parsePackageJson } from './manifest/package-json.js';
import { parseNpmLockfile } from './manifest/lockfiles/npm.js';
import { parsePnpmLockfile } from './manifest/lockfiles/pnpm.js';
import { parseYarnLockfile } from './manifest/lockfiles/yarn.js';
import { parseBunLockfile } from './manifest/lockfiles/bun.js';
import { diffSnapshots, createLockfileLowFiEvent } from './diff/snapshot-diff.js';
import { openCache } from './cache/index.js';
import type {
  BlobRequest,
  CommitInfo,
  DependencyEntry,
  DependencyEvent,
  EngineOptions,
  EngineResult
} from './types.js';

const MANIFEST_PATHS_CACHE_KEY = 'manifest_paths';
// Streaming windows bound peak memory: ~1500 blobs ≈ 5-15MB, not 500MB.
const WINDOW_TARGET_BLOBS = 1500;
const WINDOW_MAX_COMMITS = 300;
// Historic discovery is a full-history `git log`; only pay it on cold scans.
const PROGRESS_THRESHOLD = 2000;

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

async function parseAnyManifest(
  filePath: string,
  content?: string | null
): Promise<Map<string, DependencyEntry> | null> {
  if (!content) return new Map();

  if (filePath.endsWith('package.json')) {
    return parsePackageJson(content);
  }
  if (filePath.endsWith('package-lock.json')) {
    return parseNpmLockfile(content, { directOnly: true });
  }
  if (filePath.endsWith('pnpm-lock.yaml')) {
    return await parsePnpmLockfile(content);
  }
  if (filePath.endsWith('yarn.lock')) {
    return await parseYarnLockfile(content);
  }
  if (filePath.endsWith('bun.lock') || filePath.endsWith('bun.lockb')) {
    return parseBunLockfile(content);
  }

  return new Map();
}

/**
 * Runs the full dep-blame analysis pipeline.
 */
export async function runDepBlame(options: EngineOptions = {}): Promise<EngineResult> {
  const startTime = Date.now();
  const { cwd = process.cwd(), noCache = false, clearCache = false, cacheDir, filter = {} } = options;

  // Step 0: Check git
  await checkGit();

  // Step 1: Repo root
  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(cwd);
  } catch {
    throw new Error('Not a git repository (or any of the parent directories).');
  }

  const repoName = path.basename(repoRoot);

  // Step 2: Shallow check
  const isShallow = await isShallowRepo(repoRoot);
  if (isShallow && !options.silent) {
    console.warn('⚠ Shallow clone detected — history may be incomplete.');
    console.warn('  In GitHub Actions: actions/checkout with fetch-depth: 0');
  }

  // Current HEAD
  let currentHead: string;
  try {
    currentHead = await getCurrentHead(repoRoot);
  } catch {
    return {
      repository: repoName,
      packageManager: 'npm',
      events: [],
      isShallow,
      cached: false,
      durationMs: Date.now() - startTime
    };
  }

  // Step 3: Cheap HEAD detection first (sync fs, no git history walk).
  const detected = detectPackageManager(repoRoot);

  // Step 4: Cache management — opened BEFORE expensive historic discovery
  // so warm hits (`cached_head === HEAD`) return without ever running
  // `git log --all --full-history`.
  const cache = await openCache({ repoRoot, cacheDir });

  if (clearCache) {
    cache.clear();
  }

  let sinceCommit: string | null = null;
  const cachedHead = noCache || clearCache ? null : cache.getMeta('cached_head');

  if (cachedHead) {
    if (cachedHead === currentHead) {
      // Warm cache hit — no git history walk at all.
      const events = cache.queryEvents(filter);
      cache.close();
      return {
        repository: repoName,
        packageManager: detected.packageManager,
        events,
        isShallow,
        cached: true,
        durationMs: Date.now() - startTime
      };
    }

    const isValidAncestor = await isAncestor(cachedHead, currentHead, repoRoot);
    if (isValidAncestor) {
      sinceCommit = cachedHead;
    } else {
      if (!options.silent) {
        console.warn('⚠ History rewrite detected. Re-indexing full dependency history...');
      }
      cache.clear();
    }
  }

  // Step 4b: Resolve full manifest list.
  // - Incremental (sinceCommit + cached list): merge cached + HEAD, skip
  //   the full-history walk entirely. Deleted workspaces stay covered
  //   because the cached list already contains them.
  // - Cold / rewrite / first run: pay for historic discovery once, then
  //   cache the result for all future incrementals.
  let manifestPaths = detected.manifestPaths;
  if (sinceCommit) {
    const cachedPaths = noCache ? null : readCachedManifestPaths(cache);
    if (cachedPaths) {
      manifestPaths = mergeManifestPaths(cachedPaths, manifestPaths);
    } else {
      try {
        const historic = await discoverHistoricManifests(repoRoot);
        if (historic.length > 0) manifestPaths = mergeManifestPaths(manifestPaths, historic);
      } catch {
        // Best-effort.
      }
    }
  } else {
    try {
      const historic = await discoverHistoricManifests(repoRoot);
      if (historic.length > 0) manifestPaths = mergeManifestPaths(manifestPaths, historic);
    } catch {
      // Best-effort; HEAD paths alone still produce correct (if partial) results.
    }
  }

  // Step 5: Get manifest commits (git filters; Node only sees hits).
  const commits = await getManifestCommits(repoRoot, {
    sinceCommit,
    manifestPaths,
    reverse: true
  });

  if (commits.length === 0) {
    cache.setMeta('cached_head', currentHead);
    try {
      cache.setMeta(MANIFEST_PATHS_CACHE_KEY, JSON.stringify(manifestPaths));
    } catch {
      // Ignore meta failures.
    }
    const events = cache.queryEvents(filter);
    cache.close();
    return {
      repository: repoName,
      packageManager: detected.packageManager,
      events,
      isShallow,
      cached: false,
      durationMs: Date.now() - startTime
    };
  }

  const showProgress = !options.silent && commits.length >= PROGRESS_THRESHOLD;

  // Step 6+7: Stream commits in windows instead of one giant blob Map.
  // Peak memory stays ~1 window (≤1500 blobs), not total history.
  const snapshots = new Map<string, Map<string, DependencyEntry>>();
  const rawHashes = new Map<string, string>();

  // Seed baseline from sinceCommit (small: one blob per manifest path).
  if (sinceCommit) {
    const seedRequests: BlobRequest[] = manifestPaths.map((p) => ({ commit: sinceCommit as string, path: p }));
    // Chunk seed fetch so 300-path monorepos don't breach batch limits.
    for (let i = 0; i < seedRequests.length; i += 1000) {
      const slice = seedRequests.slice(i, i + 1000);
      const seedBlobs = await batchReadBlobs(repoRoot, slice);
      for (const req of slice) {
        const content = seedBlobs.get(`${req.commit}:${req.path}`);
        if (content) {
          const parsed = await parseAnyManifest(req.path, content);
          if (parsed !== null) {
            snapshots.set(req.path, parsed);
            rawHashes.set(req.path, hashContent(content));
          }
        }
      }
    }
  }

  let processed = 0;

  const processWindow = async (window: CommitInfo[]): Promise<void> => {
    if (window.length === 0) return;
    const blobRequests: BlobRequest[] = [];
    for (const c of window) {
      for (const f of c.files) blobRequests.push({ commit: c.commit, path: f });
    }
    const blobs = await batchReadBlobs(repoRoot, blobRequests);
    const windowEvents: DependencyEvent[] = [];

    for (const c of window) {
      const directPackagesInCommit = new Set<string>();

      for (const f of c.files) {
        if (!f.endsWith('package.json')) continue;
        const content = blobs.get(`${c.commit}:${f}`);
        const h = content ? hashContent(content) : '';
        const prevH = rawHashes.get(f);
        if (h === prevH && snapshots.has(f)) continue; // unchanged (merge/mode-only)
        const currMap = content ? parsePackageJson(content) : new Map<string, DependencyEntry>();
        const prevMap = snapshots.get(f) || new Map<string, DependencyEntry>();
        const events = diffSnapshots(prevMap, currMap, c, f);
        for (const ev of events) {
          directPackagesInCommit.add(ev.package);
          windowEvents.push(ev);
        }
        snapshots.set(f, currMap);
        rawHashes.set(f, h);
      }

      for (const f of c.files) {
        if (f.endsWith('package.json')) continue;
        const content = blobs.get(`${c.commit}:${f}`);
        if (!content) {
          const prevH = rawHashes.get(f) || '';
          if (prevH === '' && snapshots.has(f)) continue;
          const prevMap = snapshots.get(f) || new Map<string, DependencyEntry>();
          if (prevMap.size > 0) {
            const lockEvents = diffSnapshots(prevMap, new Map(), c, f);
            for (const ev of lockEvents) {
              if (!directPackagesInCommit.has(ev.package)) windowEvents.push(ev);
            }
          }
          snapshots.set(f, new Map());
          rawHashes.set(f, '');
          continue;
        }
        // Hash-skip BEFORE the expensive YAML/JSON parse.
        const h = hashContent(content);
        if (h === rawHashes.get(f) && snapshots.has(f)) continue;
        const currMap = await parseAnyManifest(f, content);
        if (currMap === null) {
          if (directPackagesInCommit.size === 0) {
            windowEvents.push(createLockfileLowFiEvent(c, f));
          }
          continue;
        }
        const prevMap = snapshots.get(f) || new Map<string, DependencyEntry>();
        const lockEvents = diffSnapshots(prevMap, currMap, c, f);
        for (const ev of lockEvents) {
          if (!directPackagesInCommit.has(ev.package)) windowEvents.push(ev);
        }
        snapshots.set(f, currMap);
        rawHashes.set(f, h);
      }
    }

    if (windowEvents.length > 0) cache.insertEvents(windowEvents);
    processed += window.length;
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

  // Step 8: Cache bookkeeping (events already inserted per window).
  cache.setMeta('cached_head', currentHead);
  try {
    cache.setMeta(MANIFEST_PATHS_CACHE_KEY, JSON.stringify(manifestPaths));
  } catch {
    // Ignore meta failures.
  }

  // Step 9: Return filtered events
  const allEvents = cache.queryEvents(filter);
  cache.close();

  return {
    repository: repoName,
    packageManager: detected.packageManager,
    events: allEvents,
    isShallow,
    cached: false,
    durationMs: Date.now() - startTime
  };
}
