import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame } from '../packages/core/dist/engine.js';
import { renderArchaeologyView, groupLifecycleNodes, lifecycleNodeTitle } from '../packages/core/dist/render/archaeology.js';
import { renderCsv } from '../packages/core/dist/render/csv.js';
import { JsonStore, JSON_CACHE_SCHEMA_VERSION } from '../packages/core/dist/cache/json-store.js';
import { SqliteStore, CACHE_SCHEMA_VERSION } from '../packages/core/dist/cache/sqlite-store.js';
import { isSqliteAvailable } from '../packages/core/dist/cache/index.js';

function write(repo, version) {
  const deps = version ? { alpha: version } : {};
  fs.writeFileSync(path.join(repo.repoDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }, null, 2));
  fs.writeFileSync(path.join(repo.repoDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: deps }, ...(version ? { 'node_modules/alpha': { version } } : {})
  } }, null, 2));
}
async function commit(repo, version, message) {
  write(repo, version);
  await repo.runGit(['add', 'package.json', 'package-lock.json']);
  await repo.runGit(['commit', '-m', message]);
  return (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
}

test('merge origin: one direct addition and two nested integrations preserve author roles and evidence', async () => {
  const repo = await createTestRepo();
  try {
    const base = await commit(repo, null, 'base');
    await repo.runGit(['branch', 'feature']);
    await repo.runGit(['branch', 'third', base]);
    await repo.commitFile('notes.txt', 'main diverges', 'notes');
    await repo.runGit(['checkout', 'feature']);
    await repo.runGit(['config', 'user.name', 'Alice']);
    const original = await commit(repo, '1', 'Merge-looking subject is not a merge');
    await repo.runGit(['checkout', 'main']);
    await repo.runGit(['config', 'user.name', 'Bob']);
    await repo.runGit(['merge', '--no-ff', 'feature', '-m', 'integrate feature']);
    await repo.runGit(['checkout', 'third']);
    await repo.commitFile('third.txt', 'third diverges', 'third notes');
    await repo.runGit(['config', 'user.name', 'Carol']);
    await repo.runGit(['merge', '--no-ff', 'main', '-m', 'integrate main']);
    const result = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(result.events.length, 6);
    const direct = result.events.filter(e => e.commitFull === original);
    assert.equal(direct.length, 2);
    assert.ok(direct.every(e => e.changeOrigin === 'direct' && e.commitParents.length === 1 && e.author === 'Alice'));
    const merges = result.events.filter(e => e.commitFull !== original);
    assert.ok(merges.every(e => e.changeOrigin === 'merge-integration' && e.commitParents.length === 2));
    assert.deepEqual(new Set(merges.map(e => e.author)), new Set(['Bob', 'Carol']));
    const nodes = groupLifecycleNodes(result.events);
    assert.equal(nodes.length, 3);
    assert.equal(nodes.filter(n => n.isMerge).length, 2);
    assert.equal(lifecycleNodeTitle(nodes.find(n => n.commitFull === original)), 'Added dependency');
    assert.ok(nodes.filter(n => n.isMerge).every(n => lifecycleNodeTitle(n) === 'Merged existing dependency'));
    assert.ok(nodes.every(n => n.files.length === 2));
    const cli = renderArchaeologyView('alpha', result.events, result.headState);
    assert.match(cli, /Merge author: Bob/);
    assert.match(cli, /Commit author: Alice/);
    assert.match(cli, /merged existing/);
    assert.match(renderCsv(result.events), /changeOrigin,commitParents/);
    assert.match(renderCsv(result.events), /merge-integration/);
    const warm = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.deepEqual(warm.events, result.events);
    const paged = await runDepBlame({ cwd: repo.repoDir, silent: true, limit: 2, offset: 2 });
    assert.deepEqual(paged.events, result.events.slice(2, 4));
  } finally { repo.cleanup(); }
});

test('merge origin: a resolution version absent from incoming parents remains a merge change', async () => {
  const repo = await createTestRepo();
  try {
    await commit(repo, '1', 'base');
    await repo.runGit(['branch', 'feature']);
    await commit(repo, '3', 'main bump');
    await repo.runGit(['checkout', 'feature']);
    await commit(repo, '2', 'feature bump');
    await repo.runGit(['checkout', 'main']);
    await assert.rejects(repo.runGit(['merge', '--no-ff', 'feature', '-m', 'merge']));
    const merge = await commit(repo, '4', 'resolve with new version');
    const result = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const events = result.events.filter(e => e.commitFull === merge);
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.changeOrigin === 'merge-change' && e.from === '3' && e.to === '4'));
    assert.equal(lifecycleNodeTitle(groupLifecycleNodes(events)[0]), 'Merge dependency changes');
    assert.ok(!renderArchaeologyView('alpha', events).includes('Merged existing dependency'));
  } finally { repo.cleanup(); }
});

test('merge origin: unreadable incoming manifests cannot prove an existing dependency integration', async () => {
  const repo = await createTestRepo();
  try {
    await commit(repo, null, 'base');
    await repo.runGit(['branch', 'feature']);
    await repo.commitFile('notes.txt', 'diverge', 'notes');
    await repo.runGit(['checkout', 'feature']);
    await commit(repo, '1', 'add alpha');
    await repo.commitFile('package.json', 'broken JSON', 'corrupt incoming manifest');
    await repo.runGit(['checkout', 'main']);
    await repo.runGit(['merge', '--no-ff', '--no-commit', 'feature']);
    const merge = await commit(repo, '1', 'restore valid manifest while merging');
    const result = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const events = result.events.filter(e => e.commitFull === merge);
    assert.equal(events.find(e => e.source === 'manifest').changeOrigin, 'merge-change');
    assert.equal(events.find(e => e.source === 'lockfile').changeOrigin, 'merge-integration');
    assert.equal(lifecycleNodeTitle(groupLifecycleNodes(events)[0]), 'Merge dependency changes');
  } finally { repo.cleanup(); }
});

test('merge origin: v4 cache checkpoints rescan and both backends preserve parent metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-origin-cache-'));
  try {
    const event = { package: 'alpha', type: 'added', to: '1', date: '2026-01-01T00:00:00Z', commit: 'abcdef0', commitFull: 'a'.repeat(40),
      author: 'Merge author', message: 'merge', manifest: 'package.json', depType: 'dependencies', source: 'manifest', isDirect: true,
      changeOrigin: 'merge-integration', commitParents: ['b'.repeat(40), 'c'.repeat(40)] };
    const jsonFile = path.join(dir, 'cache.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ meta: { schema_version: '4', cached_head: 'old' }, events: [event] }));
    let json = new JsonStore(jsonFile);
    assert.equal(json.getMeta('cached_head'), null);
    assert.equal(json.getMeta('schema_version'), JSON_CACHE_SCHEMA_VERSION);
    json.insertEvents([event]); json.close();
    json = new JsonStore(jsonFile);
    assert.deepEqual(json.queryPaged({}, { limit: 1 }).events[0], event);
    json.close();
    if (await isSqliteAvailable()) {
      const dbFile = path.join(dir, 'cache.db');
      let sql = new SqliteStore(dbFile);
      sql.insertEvents([event]); sql.setMeta('schema_version', '4'); sql.setMeta('cached_head', 'old'); sql.close();
      sql = new SqliteStore(dbFile);
      assert.equal(sql.getMeta('cached_head'), null);
      assert.equal(sql.getMeta('schema_version'), CACHE_SCHEMA_VERSION);
      assert.equal(sql.queryEvents().length, 0);
      sql.insertEvents([event]); sql.close();
      sql = new SqliteStore(dbFile);
      assert.deepEqual(sql.queryEvents()[0], event);
      assert.deepEqual(sql.queryPaged({}, { limit: 1 }).events[0], event);
      sql.close();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
