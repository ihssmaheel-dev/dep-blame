import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNpmLockfile } from '../packages/core/dist/manifest/lockfiles/npm.js';
import { diffSnapshots } from '../packages/core/dist/diff/snapshot-diff.js';
import { runDepBlame } from '../packages/core/dist/engine.js';
import { SqliteStore, CACHE_SCHEMA_VERSION } from '../packages/core/dist/cache/sqlite-store.js';
import { JsonStore } from '../packages/core/dist/cache/json-store.js';
import { isSqliteAvailable } from '../packages/core/dist/cache/index.js';
import { groupLifecycleNodes, renderArchaeologyView } from '../packages/core/dist/render/archaeology.js';
import { renderEventTable } from '../packages/core/dist/render/table.js';
import { renderCsv } from '../packages/core/dist/render/csv.js';
import { createTestRepo } from './helpers/git-fixture.js';

const commit = {commit: 'a'.repeat(40), parents: [], date: '2026-10-05T12:00:00Z', author: 'Fixture', message: 'Change tree', files: []};
const lock = (section = 'dependencies', flags = {}, extra = []) => JSON.stringify({
  lockfileVersion: 3, packages: {
    '': {[section]: {alpha: '^1.0.0'}},
    'node_modules/alpha': {version: '1.0.0', ...flags},
    ...Object.fromEntries(extra.map((v, i) => [`node_modules/parent${i}/node_modules/alpha`, {version: v, dev: true}]))
  }
});
const diff = (before, after) => diffSnapshots(parseNpmLockfile(before).entries, parseNpmLockfile(after).entries, commit, 'package-lock.json', {source: 'lockfile'});

test('npm: root sections override installed flags, independent of package traversal order', () => {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const flags of [{peer: true}, {dev: true}, {optional: true}, {}]) {
      const parsed = parseNpmLockfile(lock(section, flags));
      assert.equal(parsed.entries.get('alpha').depType, section);
      assert.deepEqual(diff(lock(section, flags), lock(section)), []);
    }
  }
  const data = JSON.parse(lock('dependencies', {peer: true}, ['2.0.0']));
  data.packages = Object.fromEntries(Object.entries(data.packages).reverse());
  assert.equal(parseNpmLockfile(JSON.stringify(data)).entries.get('alpha').depType, 'dependencies');
  data.packages[''].optionalDependencies = {alpha: '^1.0.0'};
  assert.equal(parseNpmLockfile(JSON.stringify(data)).entries.get('alpha').depType, 'optionalDependencies');
  const move = diff(lock(), lock('devDependencies'))[0];
  assert.equal(move.from, move.to);
  assert.equal(move.depTypeFrom, 'dependencies');
  assert.equal(move.depType, 'devDependencies');
});

test('diff: equal representative versions retain both complete resolution sets', () => {
  const change = diff(lock(), lock('dependencies', {}, ['2.0.0']))[0];
  assert.equal(change.from, '1.0.0');
  assert.equal(change.to, '1.0.0');
  assert.deepEqual(change.resolutionsFrom, ['1.0.0']);
  assert.deepEqual(change.resolutions, ['1.0.0', '2.0.0']);
  const reverse = diff(lock('dependencies', {}, ['2.0.0']), lock())[0];
  assert.deepEqual(reverse.resolutionsFrom, ['1.0.0', '2.0.0']);
  assert.deepEqual(reverse.resolutions, ['1.0.0']);
  const entry = {version: '1.0.0', depType: 'dependencies', resolutions: ['1.0.0', '2.0.0'], ambiguous: true};
  const reordered = {...entry, version: '2.0.0', resolutions: ['2.0.0', '1.0.0', '2.0.0']};
  assert.deepEqual(diffSnapshots(new Map([['alpha', entry]]), new Map([['alpha', reordered]]), commit, 'lock'), []);
});

test('engine: npm tree-flag churn produces no event in cold, warm, and incremental scans', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies: {alpha: '^1.0.0'}}, 'Declare alpha');
    await repo.commitFile('package-lock.json', lock('dependencies', {peer: true}), 'Resolve alpha');
    await repo.commitFile('package-lock.json', lock(), 'npm metadata only');
    const cold = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(cold.events.length, 2);
    const warm = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.deepEqual(warm.events, cold.events);
    await repo.commitFile('package-lock.json', lock('dependencies', {dev: true}), 'More tree metadata');
    const incremental = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.deepEqual(incremental.events, cold.events);
    await repo.commitFile('package-lock.json', lock('dependencies', {}, ['2.0.0']), 'Add nested resolution');
    const changed = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.equal(changed.events.length, 3);
    assert.deepEqual(changed.events[2].resolutionsFrom, ['1.0.0']);
    assert.deepEqual(changed.events[2].resolutions, ['1.0.0', '2.0.0']);
    const paged = await runDepBlame({cwd: repo.repoDir, silent: true, limit: 1, offset: 2});
    assert.deepEqual(paged.events, [changed.events[2]]);
  } finally { repo.cleanup(); }
});

test('stores: v5/v6/v7 rows rebuild and full/paged queries preserve identical update evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-update-store-'));
  const constructors = [JsonStore];
  if (await isSqliteAvailable()) constructors.push(SqliteStore);
  const event = diff(lock(), lock('dependencies', {}, ['2.0.0']))[0];
  try {
    for (const Store of constructors) {
      for (const version of ['5', '6', '7']) {
        const file = path.join(dir, `${version}-${Store.name === 'JsonStore' ? 'data.json' : 'data.db'}`);
        let store = new Store(file);
        store.insertEvents([event]);
        store.setMeta('schema_version', version);
        store.close();
        store = new Store(file);
        try {
          assert.equal(store.getMeta('schema_version'), CACHE_SCHEMA_VERSION);
          assert.deepEqual(store.queryEvents(), []);
          store.insertEvents([event]);
          assert.deepEqual(store.queryEvents(), [event]);
          assert.deepEqual(store.queryPaged({}, {limit: 1}).events, [event]);
        } finally { store.close(); }
      }
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('renderers: section moves and set changes explain equal-version updates without losing evidence', () => {
  const set = diff(lock(), lock('dependencies', {}, ['2.0.0']))[0];
  const move = {...diff(lock(), lock('devDependencies'))[0], commit: 'bbbbbbb', commitFull: 'b'.repeat(40)};
  const table = renderEventTable([set, move], {verbose: true});
  assert.match(table, /resolved versions changed/);
  assert.match(table, /\{1.0.0\} -> \{1.0.0, 2.0.0\}/);
  assert.match(table, /version unchanged/);
  assert.match(table, /section: dependencies -> devDependencies/);
  assert.doesNotMatch(table, /1\.0\.0 -> 1\.0\.0/);
  const archaeology = renderArchaeologyView('alpha', [set, move]);
  assert.match(archaeology, /\{1.0.0\} -> \{1.0.0, 2.0.0\}/);
  assert.match(archaeology, /version unchanged/);
  assert.match(renderCsv([set]), /resolutionsFrom/);
  const differentSet = {...set, manifest: 'apps/web/package-lock.json', resolutions: ['1.0.0', '3.0.0']};
  assert.equal(groupLifecycleNodes([set, differentSet])[0].resolved.length, 2);
});
