import path from 'node:path';
import { checkGit, getRepoRoot, getCurrentHead, isShallowRepo, isAncestor } from './git/repo.js';
import { getManifestCommits } from './git/log.js';
import { batchReadBlobs } from './git/batch.js';
import { detectPackageManager } from './manifest/detect.js';
import { parsePackageJson } from './manifest/package-json.js';
import { parseNpmLockfile } from './manifest/lockfiles/npm.js';
import { parsePnpmLockfile } from './manifest/lockfiles/pnpm.js';
import { parseYarnLockfile } from './manifest/lockfiles/yarn.js';
import { parseBunLockfile } from './manifest/lockfiles/bun.js';
import { diffSnapshots } from './diff/snapshot-diff.js';
import { openCache } from './cache/index.js';
async function parseAnyManifest(filePath, content) {
    if (!content)
        return new Map();
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
export async function runDepBlame(options = {}) {
    const startTime = Date.now();
    const { cwd = process.cwd(), noCache = false, clearCache = false, cacheDir, filter = {} } = options;
    // Step 0: Check git
    await checkGit();
    // Step 1: Repo root
    let repoRoot;
    try {
        repoRoot = await getRepoRoot(cwd);
    }
    catch {
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
    let currentHead;
    try {
        currentHead = await getCurrentHead(repoRoot);
    }
    catch {
        return {
            repository: repoName,
            packageManager: 'npm',
            events: [],
            isShallow,
            cached: false,
            durationMs: Date.now() - startTime
        };
    }
    // Step 3: Manifest detection
    const detected = detectPackageManager(repoRoot);
    const manifestPaths = detected.manifestPaths;
    // Step 4: Cache management
    const cache = await openCache({ repoRoot, cacheDir });
    if (clearCache) {
        cache.clear();
    }
    let sinceCommit = null;
    const cachedHead = noCache || clearCache ? null : cache.getMeta('cached_head');
    if (cachedHead) {
        if (cachedHead === currentHead) {
            // Warm cache hit
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
        }
        else {
            if (!options.silent) {
                console.warn('⚠ History rewrite detected. Re-indexing full dependency history...');
            }
            cache.clear();
        }
    }
    // Step 5: Get manifest commits
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
            isShallow,
            cached: false,
            durationMs: Date.now() - startTime
        };
    }
    // Step 6: Prepare batch requests
    const blobRequests = [];
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
    const snapshots = new Map();
    if (sinceCommit) {
        for (const p of manifestPaths) {
            const content = blobs.get(`${sinceCommit}:${p}`);
            if (content) {
                const parsed = await parseAnyManifest(p, content);
                snapshots.set(p, parsed);
            }
        }
    }
    const newEvents = [];
    for (const c of commits) {
        const packagesModifiedInCommit = new Set();
        // First process all package.json files (root and workspace manifests)
        for (const f of c.files) {
            if (f.endsWith('package.json')) {
                const content = blobs.get(`${c.commit}:${f}`);
                const currMap = content ? parsePackageJson(content) : new Map();
                const prevMap = snapshots.get(f) || new Map();
                const events = diffSnapshots(prevMap, currMap, c, f);
                for (const ev of events) {
                    packagesModifiedInCommit.add(`${f}:${ev.package}`);
                    newEvents.push(ev);
                }
                snapshots.set(f, currMap);
            }
        }
        // Process lockfiles (npm, pnpm, yarn, bun)
        for (const f of c.files) {
            if (!f.endsWith('package.json')) {
                const content = blobs.get(`${c.commit}:${f}`);
                const currMap = content ? await parseAnyManifest(f, content) : new Map();
                const prevMap = snapshots.get(f) || new Map();
                const lockEvents = diffSnapshots(prevMap, currMap, c, f);
                for (const ev of lockEvents) {
                    const directKey = `package.json:${ev.package}`;
                    if (!packagesModifiedInCommit.has(directKey)) {
                        newEvents.push(ev);
                    }
                }
                snapshots.set(f, currMap);
            }
        }
    }
    // Step 8: Cache events
    cache.insertEvents(newEvents);
    cache.setMeta('cached_head', currentHead);
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
//# sourceMappingURL=engine.js.map