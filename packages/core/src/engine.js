import path from 'node:path';
import {
  checkGit,
  getRepoRoot,
  getCurrentHead,
  isShallowRepo,
  isAncestor
} from './git/repo.js';
import { getManifestCommits } from './git/log.js';
import { batchReadBlobs } from './git/batch.js';
import { detectPackageManager } from './manifest/detect.js';
import { parsePackageJson } from './manifest/package-json.js';
import { parseNpmLockfile } from './manifest/lockfiles/npm.js';
import { diffSnapshots, createLockfileLowFiEvent } from './diff/snapshot-diff.js';
import { openCache } from './cache/index.js';

/**
 * Runs the full dep-blame analysis pipeline.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd=process.cwd()] Working directory
 * @param {boolean} [options.noCache=false] Force full rescan without cache
 * @param {string} [options.cacheDir] Override cache directory
 * @param {Object} [options.filter] Filter options (package, type, since)
 * @returns {Promise<{
 *   repository: string,
 *   packageManager: string,
 *   events: import('./diff/snapshot-diff.js').DependencyEvent[],
 *   isShallow: boolean
 * }>}
 */
export async function runDepBlame(options = {}) {
  const { cwd = process.cwd(), noCache = false, cacheDir, filter = {} } = options;

  // Step 0: Check git availability
  await checkGit();

  // Step 1: Locate repo root
  let repoRoot;
  try {
    repoRoot = await getRepoRoot(cwd);
  } catch (err) {
    throw new Error(`Not a git repository (or any of the parent directories).`);
  }

  const repoName = path.basename(repoRoot);

  // Step 2: Check for shallow clone
  const isShallow = await isShallowRepo(repoRoot);
  if (isShallow && !options.silent) {
    console.warn('⚠ Shallow clone detected — history may be incomplete.');
    console.warn('  In GitHub Actions: actions/checkout with fetch-depth: 0');
  }

  // Check current HEAD
  let currentHead;
  try {
    currentHead = await getCurrentHead(repoRoot);
  } catch {
    // Empty repository with no commits yet
    return {
      repository: repoName,
      packageManager: 'npm',
      events: [],
      isShallow
    };
  }

  // Step 3: Detect package manager & manifests
  const detected = detectPackageManager(repoRoot);
  const manifestPaths = detected.manifestPaths;

  // Step 4: Load cache
  const cache = await openCache({ repoRoot, cacheDir });

  let sinceCommit = null;
  const cachedHead = noCache ? null : cache.getMeta('cached_head');

  if (cachedHead) {
    if (cachedHead === currentHead) {
      // Warm cache hit!
      const events = cache.queryEvents(filter);
      cache.close();
      return {
        repository: repoName,
        packageManager: detected.packageManager,
        events,
        isShallow
      };
    }

    // Check if cached HEAD is still an ancestor of current HEAD
    const isValidAncestor = await isAncestor(cachedHead, currentHead, repoRoot);
    if (isValidAncestor) {
      sinceCommit = cachedHead;
    } else {
      if (!options.silent) {
        console.warn('⚠ History rewrite detected. Re-indexing full dependency history...');
      }
      // Re-initialize cache on history rewrite
      cache.setMeta('cached_head', '');
    }
  }

  // Step 5: Get commits touching manifests
  const commits = await getManifestCommits(repoRoot, {
    sinceCommit,
    manifestPaths,
    reverse: true
  });

  if (commits.length === 0) {
    cache.setMeta('cached_head', currentHead);
    const events = cache.queryEvents(filter);
    cache.close();
    return {
      repository: repoName,
      packageManager: detected.packageManager,
      events,
      isShallow
    };
  }

  // Step 6: Prepare batch requests
  const blobRequests = [];

  // If incremental, we need baseline snapshots at sinceCommit
  if (sinceCommit) {
    for (const p of manifestPaths) {
      blobRequests.push({ commit: sinceCommit, path: p });
    }
  }

  for (const c of commits) {
    for (const f of c.files) {
      blobRequests.push({ commit: c.commit, path: f });
    }
  }

  const blobs = await batchReadBlobs(repoRoot, blobRequests);

  // Step 7: Diff snapshots chronologically
  const snapshots = new Map(); // manifestPath -> Map<packageName, { version, depType }>

  // Populate baseline snapshots if incremental
  if (sinceCommit) {
    for (const p of manifestPaths) {
      const content = blobs.get(`${sinceCommit}:${p}`);
      if (content) {
        if (p.endsWith('package.json')) {
          snapshots.set(p, parsePackageJson(content));
        } else if (p.endsWith('package-lock.json')) {
          snapshots.set(p, parseNpmLockfile(content, { directOnly: true }));
        }
      }
    }
  }

  const newEvents = [];

  for (const c of commits) {
    const pkgJsonChanged = c.files.some((f) => f.endsWith('package.json'));
    const packagesModifiedInCommit = new Set();

    // First process package.json changes
    for (const f of c.files) {
      if (f.endsWith('package.json')) {
        const content = blobs.get(`${c.commit}:${f}`);
        const currMap = content ? parsePackageJson(content) : new Map();
        const prevMap = snapshots.get(f) || new Map();

        const events = diffSnapshots(prevMap, currMap, c, f);
        for (const ev of events) {
          packagesModifiedInCommit.add(ev.package);
          newEvents.push(ev);
        }
        snapshots.set(f, currMap);
      }
    }

    // Process package-lock.json changes
    for (const f of c.files) {
      if (f.endsWith('package-lock.json')) {
        const content = blobs.get(`${c.commit}:${f}`);
        const currMap = content ? parseNpmLockfile(content, { directOnly: true }) : new Map();
        const prevMap = snapshots.get(f) || new Map();

        const lockEvents = diffSnapshots(prevMap, currMap, c, f);
        for (const ev of lockEvents) {
          // Avoid duplicate events if already handled by package.json in same commit
          if (!packagesModifiedInCommit.has(ev.package)) {
            newEvents.push(ev);
          }
        }
        snapshots.set(f, currMap);
      }
    }

    // Low-fidelity event for pnpm / yarn in v0.1
    for (const f of c.files) {
      if ((f.endsWith('pnpm-lock.yaml') || f.endsWith('yarn.lock')) && !pkgJsonChanged) {
        newEvents.push(createLockfileLowFiEvent(c, f));
      }
    }
  }

  // Step 8: Write to cache
  cache.insertEvents(newEvents);
  cache.setMeta('cached_head', currentHead);

  // Step 9: Return filtered events
  const allEvents = cache.queryEvents(filter);
  cache.close();

  return {
    repository: repoName,
    packageManager: detected.packageManager,
    events: allEvents,
    isShallow
  };
}
