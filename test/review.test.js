import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { acquireScanLock } from '../packages/core/dist/cache/lock.js';
import { JsonStore } from '../packages/core/dist/cache/json-store.js';
import { getRepoRemoteInfo } from '../packages/core/dist/git/repo.js';
import { parsePackageJson } from '../packages/core/dist/manifest/package-json.js';
import { parseNpmLockfile } from '../packages/core/dist/manifest/lockfiles/npm.js';
import { parseYarnLockfile } from '../packages/core/dist/manifest/lockfiles/yarn.js';
import { parseBunLockfiles } from '../packages/core/dist/manifest/lockfiles/bun.js';
import { parsePnpmLockfiles } from '../packages/core/dist/manifest/lockfiles/pnpm.js';
import { resolveWorkspaceManifests } from '../packages/core/dist/manifest/detect.js';
import { renderCsv } from '../packages/core/dist/render/csv.js';
import { runDepBlame } from '../packages/core/dist/engine.js';
import { startServer } from '../packages/core/ui/server.js';
import { createTestRepo } from './helpers/git-fixture.js';
import { isYamlAvailable } from './helpers/yaml-available.js';
import { getManifestCommits } from '../packages/core/dist/git/log.js';
import { batchReadBlobs, resolveBlobOids } from '../packages/core/dist/git/batch.js';

test('review: an old lock held by a live process cannot be stolen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-lock-'));
  try {
    const first = await acquireScanLock(dir);
    const lockDir = path.join(dir, 'scan.lock');
    fs.utimesSync(lockDir, new Date(0), new Date(0));
    let waited = false;
    const pending = acquireScanLock(dir, () => { waited = true; first.release(); });
    const second = await pending;
    assert.ok(waited, 'the contender must wait even if the directory is old');
    const owner = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8');
    first.release();
    assert.equal(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'), owner);
    second.release();
    assert.ok(!fs.existsSync(lockDir));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('review: locks belonging to exited processes are reclaimed', async () => {
  const child = spawn(process.execPath, ['-e', ''], {windowsHide: true});
  const pid = child.pid;
  await once(child, 'exit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-dead-lock-'));
  try {
    const lockDir = path.join(dir, 'scan.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(pid));
    const lock = await acquireScanLock(dir);
    assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), String(process.pid));
    lock.release();
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('review: JSON transactions rollback events and HEAD together', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-rollback-'));
  try {
    const store = new JsonStore(path.join(dir, 'cache.json'));
    store.setMeta('cached_head', 'old');
    assert.throws(() => store.transaction(() => {
      store.insertEvents([{package: 'alpha', type: 'added', commit: 'abc1234', date: '2026-01-01', manifest: 'package.json'}]);
      store.setMeta('cached_head', 'new');
      throw new Error('interrupted');
    }), /interrupted/);
    const reopened = new JsonStore(store.filePath);
    assert.equal(reopened.getMeta('cached_head'), 'old');
    assert.equal(reopened.queryEvents().length, 0);
    const save = store.save;
    store.save = () => { throw new Error('disk write failed'); };
    assert.throws(() => store.transaction(() => {
      store.insertEvents([{package: 'alpha', type: 'added', commit: 'abc1234', date: '2026-01-01', manifest: 'package.json'}]);
      store.setMeta('cached_head', 'new');
    }), /disk write failed/);
    store.save = save;
    assert.equal(store.getMeta('cached_head'), 'old');
    assert.equal(store.queryEvents().length, 0);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('review: malformed declarations and corrupt Yarn stay undecodable', async () => {
  assert.equal(parseNpmLockfile('').ok, false);
  assert.equal(parseNpmLockfile('{"packages":{"":{"dependencies":[]}}}').ok, false);
  assert.equal(parseBunLockfiles('').ok, false);
  assert.equal(parseBunLockfiles('{"workspaces":{"":{"dependencies":[]}}}').ok, false);
  assert.equal((await parseYarnLockfile('')).ok, false);
  assert.equal((await parsePnpmLockfiles('')).ok, false);
  for (const content of ['', '[]', '{"dependencies":[]}', '{"dependencies":"bad"}', '{"dependencies":{"alpha":23}}']) {
    assert.equal(parsePackageJson(content).ok, false, content);
  }
  for (const content of ['broken', 'alpha@^1:\n  integrity abc']) {
    assert.equal((await parseYarnLockfile(content)).ok, false, content);
  }
  // Berry-shaped input needs the optional yaml parser; without it the
  // documented contract is a null result (low-fi path), not a crash.
  const berry = await parseYarnLockfile('__metadata: [broken');
  if (berry) {
    assert.equal(berry.ok, false, '__metadata: [broken');
  } else {
    assert.ok(!(await isYamlAvailable()), 'Berry parsing must not return null when yaml is installed');
  }
  const pnpm = await parsePnpmLockfiles('importers:\n  .:\n    dependencies:\n      alpha:\n        version: 42\n');
  if (pnpm) assert.equal(pnpm.ok, false);
});

test('review: Bun array descriptors resolve real versions and preserve JSONC URLs', () => {
  const result = parseBunLockfiles(`{
    // Keep URLs and comment-looking text inside strings intact.
    "workspaces": {"": {"dependencies": {"alpha": "^1", "remote": "https://example.test/a//b"}}},
    "packages": {"alpha": ["alpha@1.2.3", "https://registry.example.test/a", {}, "sha"],},
  }`);
  assert.equal(result.ok, true);
  assert.equal(result.maps.get('package.json').get('alpha').version, '1.2.3');
  assert.equal(result.maps.get('package.json').get('remote').version, 'https://example.test/a//b');
});

test('review: unsafe remote schemes never become dashboard links', async () => {
  const repo = await createTestRepo();
  try {
    await repo.runGit(['config', 'remote.origin.url', 'javascript:alert(1)']);
    assert.equal((await getRepoRemoteInfo(repo.repoDir)).remoteUrl, null);
    await repo.runGit(['config', 'remote.origin.url', 'git@github.com:team/project.git']);
    assert.equal((await getRepoRemoteInfo(repo.repoDir)).remoteUrl, 'https://github.com/team/project');
    await repo.runGit(['config', 'remote.origin.url', 'https://user:password@github.com/team/project.git']);
    assert.equal((await getRepoRemoteInfo(repo.repoDir)).remoteUrl, null);
  } finally { repo.cleanup(); }
});

test('review: workspace globs cannot read outside the repository', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-workspace-'));
  try {
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside', 'package.json'), '{}');
    assert.deepEqual(resolveWorkspaceManifests(root, ['../outside', 5]), []);
    fs.mkdirSync(path.join(root, 'packages', 'a'), {recursive: true});
    fs.writeFileSync(path.join(root, 'packages', 'a', 'package.json'), '{}');
    assert.deepEqual(resolveWorkspaceManifests(root, ['**/**']), ['packages/a/package.json']);
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('review: warnings remain visible on a cache hit; empty files invent no removals', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '1'}}, 'add');
    await repo.commitFile('package.json', '', 'empty invalid manifest');
    await repo.commitFile('package.json', {dependencies: {alpha: '2'}}, 'repair');
    const first = await runDepBlame({cwd: repo.repoDir, silent: true});
    const warm = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(first.events.filter(e => e.type === 'removed').length, 0);
    assert.equal(first.events.filter(e => e.type === 'updated').length, 1);
    assert.ok(first.warnings.length);
    assert.deepEqual(warm.warnings, first.warnings);
    assert.equal(warm.cached, true);
  } finally { repo.cleanup(); }
});

test('review: same-commit declarations do not erase resolved history', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '^1'}}, 'declare');
    fs.writeFileSync(path.join(repo.repoDir, 'package.json'), JSON.stringify({dependencies: {alpha: '^2'}}));
    fs.writeFileSync(path.join(repo.repoDir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {'': {dependencies: {alpha: '^2'}}, 'node_modules/alpha': {version: '2.1.0'}}}));
    await repo.runGit(['add', '.']);
    await repo.runGit(['commit', '-m', 'declare and resolve']);
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(result.events.filter(e => e.source === 'manifest' && e.type === 'updated').length, 1);
    assert.equal(result.events.filter(e => e.source === 'lockfile' && e.to === '2.1.0').length, 1);
  } finally { repo.cleanup(); }
});

test('review: warm scans recover a corrupt baseline without inventing additions', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '1'}}, 'add');
    await repo.commitFile('package.json', 'broken', 'corrupt');
    await runDepBlame({cwd: repo.repoDir, silent: true});
    await repo.commitFile('package.json', {dependencies: {alpha: '2'}}, 'repair');
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(result.events.filter(e => e.type === 'added').length, 1);
    assert.equal(result.events.filter(e => e.type === 'updated').length, 1);
  } finally { repo.cleanup(); }
});

test('review: warm discovery includes workspaces added and deleted between scans', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {name: 'root'}, 'init');
    await runDepBlame({cwd: repo.repoDir, silent: true});
    await repo.commitFile('apps/temp/package.json', {dependencies: {alpha: '1'}}, 'temporary workspace');
    await repo.runGit(['rm', 'apps/temp/package.json']);
    await repo.runGit(['commit', '-m', 'remove temporary workspace']);
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.deepEqual(result.events.filter(e => e.package === 'alpha').map(e => e.type), ['added', 'removed']);
  } finally { repo.cleanup(); }
});

test('review: unrelated commits between corruption and repair preserve the last readable parent', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '1'}}, 'add');
    await repo.commitFile('package.json', 'broken', 'corrupt');
    await repo.commitFile('notes.txt', 'unrelated', 'unrelated commit');
    await repo.commitFile('package.json', {dependencies: {alpha: '2'}}, 'repair');
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(result.events.filter(e => e.type === 'added').length, 1);
    assert.equal(result.events.filter(e => e.type === 'updated').length, 1);
  } finally { repo.cleanup(); }
});

test('review: CSV repository text cannot become spreadsheet formulas', () => {
  const csv = renderCsv([{package: 'alpha', type: 'added', author: '=1+1', message: '+SUM(1)', manifest: 'package.json'}]);
  assert.ok(csv.includes("'=1+1"));
  assert.ok(csv.includes("'+SUM(1)"));
});

test('review: Unicode paths and control characters in subjects do not corrupt Git records', async () => {
  const repo = await createTestRepo();
  try {
    const manifest = 'packages/café demo/package.json';
    const subject = 'change\x1f subject\x1e text';
    await repo.commitFile(manifest, {dependencies: {alpha: '1'}}, subject);
    const records = await getManifestCommits(repo.repoDir, {manifestPaths: [manifest]});
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].files, [manifest]);
    assert.equal(records[0].message, subject);
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(result.events[0].manifest, manifest);
  } finally { repo.cleanup(); }
});

test('review: batch readers preserve large multibyte blobs and repeated requests', async () => {
  const repo = await createTestRepo();
  try {
    const content = 'é漢'.repeat(700000);
    await repo.commitFile('blob.txt', content, 'large blob');
    const sha = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const request = {commit: sha, path: 'blob.txt'};
    const missing = {commit: sha, path: 'missing.txt'};
    const blobs = await batchReadBlobs(repo.repoDir, [request, request, missing]);
    assert.equal(blobs.size, 2);
    assert.equal(blobs.get(`${sha}:blob.txt`), content);
    assert.equal(blobs.get(`${sha}:missing.txt`), null);
    const ids = await resolveBlobOids(repo.repoDir, [request, request, missing]);
    assert.equal(ids.size, 2);
    assert.equal(ids.get(`${sha}:blob.txt`).size, Buffer.byteLength(content));
    assert.equal(ids.get(`${sha}:missing.txt`).missing, true);
    await assert.rejects(batchReadBlobs(repo.repoDir, [{commit: sha, path: 'bad\npath'}]), /Invalid blob request/);
  } finally { repo.cleanup(); }
});

test('review: corrupt HEAD is unknown rather than a removed dependency', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '1'}}, 'add');
    await repo.commitFile('package.json', '', 'corrupt HEAD');
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(result.headStateComplete, false);
    assert.equal(result.events.filter(e => e.type === 'removed').length, 0);
    assert.equal((await runDepBlame({cwd: repo.repoDir, silent: true})).headStateComplete, false);
  } finally { repo.cleanup(); }
});

test('review: a scan and its cache checkpoint stay pinned while HEAD changes', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '1'}}, 'add');
    let changed = false;
    const first = await runDepBlame({cwd: repo.repoDir, silent: true, onProgress: p => {
      if (p.phase !== 'discovering' || changed) return;
      changed = true;
      fs.writeFileSync(path.join(repo.repoDir, 'package.json'), JSON.stringify({dependencies: {alpha: '2'}}));
      execFileSync('git', ['add', 'package.json'], {cwd: repo.repoDir, windowsHide: true});
      execFileSync('git', ['commit', '-m', 'commit while scanning'], {cwd: repo.repoDir, windowsHide: true});
    }});
    assert.ok(changed);
    assert.equal(first.events.length, 1);
    assert.equal(first.headState[0].version, '1');
    const next = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(next.events.length, 2);
    assert.equal(next.headState[0].version, '2');
  } finally { repo.cleanup(); }
});

test('review: partial JSON cache rows invalidate their checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-cache-review-'));
  try {
    const file = path.join(dir, 'cache.json');
    fs.writeFileSync(file, JSON.stringify({meta: {schema_version: '3', cached_head: 'old'}, events: [{package: 'incomplete'}]}));
    const store = new JsonStore(file);
    assert.equal(store.getMeta('cached_head'), null);
    assert.deepEqual(store.queryEvents(), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('review: exact origins are enforced, including ports and opaque origins', async () => {
  const instance = await startServer({port: 0});
  try {
    for (const origin of ['null', 'https://attacker.example', 'http://127.0.0.1:1', 'http://localhost:1']) {
      assert.equal((await fetch(instance.url, {headers: {Origin: origin}})).status, 403, origin);
    }
    assert.equal((await fetch(instance.url, {headers: {Origin: instance.url}})).status, 200);
    const requestStatus = headers => new Promise((resolve, reject) => {
      const req = http.get(instance.url, {headers}, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(await requestStatus({Host: 'invalid host'}), 403);
    assert.equal(await requestStatus({'Sec-Fetch-Site': 'cross-site'}), 403);
  } finally { await instance.close(); }
});
