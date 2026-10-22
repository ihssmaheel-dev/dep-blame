import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame, parseNpmLockfile, parsePnpmLockfiles, parseBunLockfiles, parsedBlobCache } from '../packages/core/dist/index.js';
import { readResolvedDependencyState } from '../packages/core/dist/engine.js';
import { startServer } from '../packages/core/ui/server.js';

const pnpm = (version, importer = '.') => `lockfileVersion: '9.0'\nimporters:\n  '${importer}':\n    dependencies:\n      alpha:\n        specifier: ^1.0.0\n        version: ${version}\n`;
const bun = version => JSON.stringify({ lockfileVersion: 1, workspaces: { '': { dependencies: { alpha: '^1.0.0' } } }, packages: { alpha: [`alpha@${version}`, '', {}, 'hash'] } });

for (const format of ['pnpm', 'bun']) test(`audit: identical nested ${format} lockfiles retain their owning workspace on cold and warm scans`, async t => {
  if (format === 'pnpm' && !(await parsePnpmLockfiles(pnpm('1.0.0')))) return t.skip('optional yaml parser unavailable');
  const repo = await createTestRepo();
  try {
    parsedBlobCache.clear();
    await repo.commitFile('package.json', { name: 'fixture', workspaces: ['apps/*'] }, 'root');
    const lock = format === 'pnpm' ? 'pnpm-lock.yaml' : 'bun.lock', content = format === 'pnpm' ? pnpm : bun;
    for (const directory of ['apps/a', 'apps/b']) {
      await repo.commitFile(`${directory}/package.json`, { name: directory, dependencies: { alpha: '^1.0.0' } }, `declare ${directory}`);
      await repo.commitFile(`${directory}/${lock}`, content('1.0.0'), `resolve ${directory}`);
    }
    await repo.commitFile(`apps/a/${lock}`, content('1.1.0'), 'update one workspace');
    const result = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const events = result.events.filter(e => e.source === 'lockfile' && e.package === 'alpha');
    assert.equal(events.length, 3);
    assert.deepEqual([...new Set(events.map(e => e.manifest))].sort(), ['apps/a/package.json', 'apps/b/package.json']);
    assert.equal(events.find(e => e.type === 'updated').manifest, 'apps/a/package.json');
    const head = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const current = await readResolvedDependencyState(repo.repoDir, head, 'alpha', 'apps/a/package.json', [`apps/a/${lock}`]);
    assert.equal(current[0].status, 'resolved'); assert.deepEqual(current[0].versions, ['1.1.0']);
    assert.deepEqual((await runDepBlame({ cwd: repo.repoDir, silent: true })).events, result.events);
    const missing = await readResolvedDependencyState(repo.repoDir, head, 'alpha', 'apps/missing/package.json', [`apps/a/${lock}`]);
    assert.equal(missing[0].status, 'unavailable', 'missing importer is unknown, not proven absence');
  } finally { repo.cleanup(); }
});

test('audit: lockfile cache separates formats even when their Git blob bytes are identical', async () => {
  const repo = await createTestRepo();
  try {
    parsedBlobCache.clear();
    const content = JSON.stringify({ dependencies: { alpha: { version: '1.0.0' } }, workspaces: { '': { dependencies: { alpha: '^2.0.0' } } }, packages: { alpha: ['alpha@2.0.0', '', {}, 'hash'] } });
    await repo.commitFile('package-lock.json', content, 'npm shape invalid');
    await repo.commitFile('bun.lock', content, 'same bytes valid for bun');
    const head = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const npm = await readResolvedDependencyState(repo.repoDir, head, 'alpha', 'package.json', ['package-lock.json']);
    const bun = await readResolvedDependencyState(repo.repoDir, head, 'alpha', 'package.json', ['bun.lock']);
    assert.equal(npm[0].status, 'unavailable'); assert.deepEqual(bun[0].versions, ['2.0.0']);
  } finally { repo.cleanup(); }
});

test('audit: workspace metadata is not an installed npm dependency', () => {
  const result = parseNpmLockfile(JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { alpha: '^1' } }, alpha: { version: '9.0.0' }, 'node_modules/alpha': { version: '1.0.0' }
  } }));
  assert.equal(result.entries.get('alpha').version, '1.0.0');
  assert.equal(result.entries.get('alpha').ambiguous, undefined);
});

test('audit: declared specifiers cannot masquerade as missing lockfile resolutions', async t => {
  const result = await parsePnpmLockfiles("importers:\n  '.':\n    dependencies:\n      alpha:\n        specifier: ^1.0.0\n");
  if (result) assert.equal(result.ok, false);
  const bun = parseBunLockfiles(JSON.stringify({ workspaces: { '': { dependencies: { alpha: '^1.0.0' } } }, packages: {} }));
  assert.equal(bun.ok, false); assert.match(bun.note, /Missing lockfile resolution/);
});

test('audit: API paging stays on its captured generation; explicit Sync updates it, invalid offsets fail', async () => {
  const repo = await createTestRepo(); let server;
  try {
    await repo.commitFile('package.json', { dependencies: { alpha: '1' } }, 'add');
    server = await startServer({ cwd: repo.repoDir, port: 0 });
    const get = async route => (await fetch(server.url + route)).json();
    const first = await get('/api/events');
    await repo.commitFile('package.json', { dependencies: { alpha: '2' } }, 'update');
    const page = await get('/api/events/paged?limit=1');
    assert.equal(page.generation, first.generation); assert.equal(page.total, 1);
    const fresh = await get('/api/events'); assert.notEqual(fresh.generation, first.generation);
    assert.equal((await fetch(server.url + '/api/events/paged?generation=' + encodeURIComponent(first.generation))).status, 409);
    for (const suffix of ['offset=1junk', 'offset=9007199254740992', 'limit=1001', 'limit=0']) assert.equal((await fetch(server.url + '/api/events/paged?' + suffix)).status, 400);
    for (const file of ['/flow-graph.js', '/app.css', '/flow.css', '/']) {
      const identity = await fetch(server.url + file, { headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' } });
      assert.equal(identity.status, 200); assert.equal(identity.headers.get('content-encoding'), null);
      assert.equal(identity.headers.get('vary'), 'Accept-Encoding');
      assert.ok((await identity.text()).length > 100);
      const encoded = await fetch(server.url + file, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(encoded.headers.get('content-encoding'), 'gzip'); await encoded.arrayBuffer();
    }
  } finally { if (server) await server.close(); repo.cleanup(); }
});
