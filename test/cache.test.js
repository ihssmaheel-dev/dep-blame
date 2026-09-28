import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from '../packages/core/src/cache/sqlite-store.js';
import { JsonStore } from '../packages/core/src/cache/json-store.js';
import { openCache } from '../packages/core/src/cache/index.js';
import { getRepoRoot } from '../packages/core/src/git/repo.js';

test('SqliteStore stores and queries events with metadata', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-sqlite-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const store = new SqliteStore(dbPath);

  assert.equal(store.getMeta('cached_head'), null);
  store.setMeta('cached_head', 'abc1234');
  assert.equal(store.getMeta('cached_head'), 'abc1234');

  const events = [
    {
      package: 'react',
      type: 'added',
      to: '18.2.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      author: 'Dev',
      message: 'add react',
      manifest: 'package.json',
      depType: 'dependencies'
    },
    {
      package: 'react',
      type: 'updated',
      from: '18.2.0',
      to: '19.0.0',
      date: '2026-02-01T00:00:00Z',
      commit: 'def5678',
      author: 'Dev',
      message: 'bump react',
      manifest: 'package.json',
      depType: 'dependencies'
    },
    {
      package: 'lodash',
      type: 'added',
      to: '4.17.21',
      date: '2026-01-15T00:00:00Z',
      commit: 'xyz9999',
      author: 'Dev 2',
      message: 'add lodash',
      manifest: 'package.json',
      depType: 'devDependencies'
    }
  ];

  store.insertEvents(events);

  const all = store.queryEvents();
  assert.equal(all.length, 3);
  assert.equal(all[0].package, 'react');
  assert.equal(all[0].type, 'added');
  assert.equal(all[1].type, 'updated');
  assert.equal(all[1].from, '18.2.0');
  assert.equal(all[1].to, '19.0.0');

  const reactOnly = store.queryEvents({ package: 'react' });
  assert.equal(reactOnly.length, 2);

  const sinceFilter = store.queryEvents({ since: '2026-01-10T00:00:00Z' });
  assert.equal(sinceFilter.length, 2);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore fallback behaves identically to SqliteStore', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-json-'));
  const jsonPath = path.join(tmpDir, 'test.json');
  const store = new JsonStore(jsonPath);

  assert.equal(store.getMeta('cached_head'), null);
  store.setMeta('cached_head', 'abc1234');
  assert.equal(store.getMeta('cached_head'), 'abc1234');

  const events = [
    {
      package: 'vue',
      type: 'added',
      to: '3.3.0',
      date: '2026-03-01T00:00:00Z',
      commit: 'vue1234',
      author: 'Vue Dev',
      message: 'add vue',
      manifest: 'package.json',
      depType: 'dependencies'
    }
  ];

  store.insertEvents(events);
  const results = store.queryEvents({ package: 'vue' });
  assert.equal(results.length, 1);
  assert.equal(results[0].package, 'vue');

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('openCache initializes store in custom cache directory', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-opencache-'));
  const repoRoot = await getRepoRoot();
  const store = await openCache({ repoRoot, cacheDir: tmpDir });

  store.setMeta('version', '1');
  assert.equal(store.getMeta('version'), '1');
  store.close();

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
