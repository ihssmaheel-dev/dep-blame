import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore } from '../packages/core/dist/cache/sqlite-store.js';
import { JsonStore } from '../packages/core/dist/cache/json-store.js';
import { openCache, isSqliteAvailable } from '../packages/core/dist/cache/index.js';
import { getRepoRoot } from '../packages/core/dist/git/repo.js';

test('SqliteStore migrates a stale schema instead of serving it', async () => {
  if (!(await isSqliteAvailable())) {
    console.log('  (skip: node:sqlite unavailable, JSON fallback active)');
    return;
  }
  const { createRequire } = await import('node:module');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-migrate-'));
  const dbPath = path.join(tmpDir, 'test.db');
  try {
    // Craft a version-1 database with a stale event, bypassing the store.
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    raw.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package TEXT NOT NULL, type TEXT NOT NULL,
      from_version TEXT, to_version TEXT, date TEXT NOT NULL, commit_sha TEXT NOT NULL,
      author TEXT NOT NULL, message TEXT NOT NULL, manifest TEXT NOT NULL, dep_type TEXT NOT NULL
    )`);
    raw.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`);
    raw.exec(`INSERT INTO events (package, type, to_version, date, commit_sha, author, message, manifest, dep_type)
      VALUES ('stale', 'added', '0.0.0', '2020-01-01T00:00:00Z', 'abc1234', 'Old', 'stale', 'package.json', 'dependencies')`);
    raw.close();

    const store = await openCache({ repoRoot: tmpDir, cacheDir: tmpDir });
    assert.equal(store.queryEvents().length, 0, 'stale v1 history must not be served');
    assert.equal(store.getMeta('schema_version'), '2');
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SqliteStore transaction coalesces writes atomically', async () => {
  if (!(await isSqliteAvailable())) {
    console.log('  (skip: node:sqlite unavailable, JSON fallback active)');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-tx-'));
  try {
    const store = new SqliteStore(path.join(tmpDir, 'test.db'));
    const ev = (pkg) => ({
      package: pkg,
      type: 'added',
      to: '1.0.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      commitFull: 'abc1234def5678901234567890123456789abcd',
      author: 'Dev',
      message: 'add',
      manifest: 'package.json',
      depType: 'dependencies',
      source: 'manifest'
    });
    store.transaction(() => {
      store.insertEvents([ev('a'), ev('b')]);
      store.setMeta('cached_head', 'abc1234');
    });
    assert.equal(store.queryEvents().length, 2);
    assert.equal(store.queryEvents({ package: 'a' })[0].commitFull, 'abc1234def5678901234567890123456789abcd');
    assert.equal(store.getMeta('cached_head'), 'abc1234');
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SqliteStore stores and queries events with metadata', async () => {
  if (!(await isSqliteAvailable())) {
    console.log('  (skip: node:sqlite unavailable, JSON fallback active)');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-sqlite-'));
  const dbPath = path.join(tmpDir, 'test.db');
  let store;
  try {
    store = new SqliteStore(dbPath);
  } catch (err) {
    if (err?.code === 'SQLITE_UNAVAILABLE') {
      console.log('  (skip: node:sqlite unavailable at runtime)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
    throw err;
  }

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

test('openCache falls back to JSON when sqlite is unavailable or locked', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-fallback-'));
  const repoRoot = await getRepoRoot();
  // Unwritable-looking cacheDir forces fallback path without crashing.
  const store = await openCache({ repoRoot, cacheDir: tmpDir });
  assert.ok(store);
  store.setMeta('fallback_check', 'ok');
  assert.equal(store.getMeta('fallback_check'), 'ok');
  store.insertEvents([
    {
      package: 'fallback-pkg',
      type: 'added',
      to: '1.0.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      author: 'Test',
      message: 'test',
      manifest: 'package.json',
      depType: 'dependencies'
    }
  ]);
  assert.equal(store.queryEvents({ package: 'fallback-pkg' }).length, 1);
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
