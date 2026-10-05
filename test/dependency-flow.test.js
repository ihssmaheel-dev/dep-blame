import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame, buildDependencyFlow, pageDependencyFlow, JsonStore } from '../packages/core/dist/index.js';
import { startServer } from '../packages/core/ui/server.js';

async function commit(repo, version, message, date) {
  const deps = version ? { alpha: version } : {};
  fs.writeFileSync(path.join(repo.repoDir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }));
  fs.writeFileSync(path.join(repo.repoDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { '': { dependencies: deps }, ...(version ? { 'node_modules/alpha': { version } } : {}) } }));
  await repo.runGit(['add', '.']);
  await repo.runGit(['commit', '-m', message, ...(date ? ['--date', date] : [])]);
  return (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
}
async function flow(repo, packageName = 'alpha', manifest = 'package.json') {
  const result = await runDepBlame({ cwd: repo.repoDir, silent: true });
  const head = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
  return { result, graph: await buildDependencyFlow(repo.repoDir, result.events,
    { package: packageName, manifest, head, headState: result.headState, headStateComplete: result.headStateComplete }) };
}

test('flow: nested integrations trace readable incoming parents across unchanged commits', async () => {
  const repo = await createTestRepo();
  try {
    const base = await commit(repo, null, 'base');
    await repo.runGit(['branch', 'feature']); await repo.runGit(['branch', 'third', base]);
    await repo.commitFile('notes.txt', 'main', 'unrelated main change');
    await repo.runGit(['checkout', 'feature']);
    const original = await commit(repo, '1', 'original dependency addition', '2030-01-01T12:00:00Z');
    await repo.commitFile('feature.txt', 'notes', 'no dependency change');
    const incoming = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    await repo.runGit(['checkout', 'main']); await repo.runGit(['merge', '--no-ff', 'feature', '-m', 'integrate feature']);
    const firstMerge = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    await repo.commitFile('notes.txt', 'main later', 'no dependency change after integration');
    const nestedParent = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    await repo.runGit(['checkout', 'third']); await repo.commitFile('third.txt', 'third', 'third diverges');
    await repo.runGit(['merge', '--no-ff', 'main', '-m', 'integrate main']);
    const nested = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const { result, graph } = await flow(repo);
    assert.deepEqual(graph.nodes.map(n => n.id), [original, firstMerge, nested]);
    assert.deepEqual(graph.nodes.map(n => n.kind), ['change', 'integration', 'integration']);
    assert.equal(graph.edges.length, 4, 'two sources remain explicit for each integration');
    assert.ok(graph.edges.every(e => e.kind === 'integration'));
    assert.ok(graph.edges.some(e => e.from === original && e.to === firstMerge && e.viaParent === incoming));
    assert.ok(graph.edges.some(e => e.from === firstMerge && e.to === nested && e.viaParent === nestedParent));
    assert.ok(result.events.filter(e => e.commitFull === firstMerge).every(e => e.flowEvidence.matchingParents.includes(incoming)));
    const warm = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.deepEqual(warm.events, result.events);
    const paged = await runDepBlame({ cwd: repo.repoDir, silent: true, limit: 1 });
    assert.deepEqual(paged.events[0].flowEvidence, result.events[0].flowEvidence);
    const page = pageDependencyFlow(graph, 1, 1);
    assert.equal(page.nodes.length, 1); assert.equal(page.total, 3);
    assert.ok(page.references.some(r => r.id === original && r.offset === 0));
    assert.ok(page.references.some(r => r.id === nested && r.offset === 2));
    assert.deepEqual(graph.headResolved[0].versions, ['1']);
  } finally { repo.cleanup(); }
});

test('flow: independent equal versions remain separate ancestry paths', async () => {
  const repo = await createTestRepo();
  try {
    const root = await commit(repo, '1', 'base'); await repo.runGit(['branch', 'feature']);
    const main = await commit(repo, '2', 'independent main update');
    await repo.runGit(['checkout', 'feature']); const feature = await commit(repo, '2', 'independent feature update');
    await repo.runGit(['checkout', 'main']); await repo.runGit(['merge', '--no-ff', 'feature', '-m', 'equal outcomes']);
    const { graph } = await flow(repo);
    assert.equal(graph.nodes.length, 3);
    assert.ok(graph.edges.some(e => e.from === root && e.to === main));
    assert.ok(graph.edges.some(e => e.from === root && e.to === feature));
    assert.ok(!graph.edges.some(e => e.from === main && e.to === feature || e.from === feature && e.to === main));
    assert.ok(!graph.edges.some(e => e.kind === 'integration'));
  } finally { repo.cleanup(); }
});

test('flow: unreadable baseline creates an explicit gap and never an inferred state arrow', async () => {
  const repo = await createTestRepo();
  try {
    const original = await commit(repo, '1', 'original');
    await repo.commitFile('package.json', 'corrupt JSON', 'unreadable');
    const repair = await commit(repo, '2', 'repair and update');
    const { graph } = await flow(repo);
    assert.equal(graph.nodes.find(n => n.id === repair).kind, 'unknown');
    assert.ok(graph.nodes.find(n => n.id === repair).gaps.length);
    assert.ok(!graph.edges.some(e => e.from === original && e.to === repair && e.source === 'manifest'));
    assert.ok(graph.edges.some(e => e.from === original && e.to === repair && e.source === 'lockfile'));
  } finally { repo.cleanup(); }
});

test('flow: an unreadable first snapshot remains unknown when a dependency is first observed', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', 'corrupt JSON', 'unreadable initial manifest');
    await repo.commitFile('package.json', { name: 'fixture', dependencies: { alpha: '1' } }, 'first readable dependency');
    const { result, graph } = await flow(repo);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].flowEvidence.previousReadable, false);
    assert.equal(graph.nodes[0].kind, 'unknown'); assert.equal(graph.edges.length, 0);
  } finally { repo.cleanup(); }
});

test('flow: removals, reintroductions and section moves preserve states and workspace separation', async () => {
  const repo = await createTestRepo();
  try {
    await commit(repo, '1', 'root alpha');
    await repo.commitFile('packages/other/package.json', { name: 'other', dependencies: { alpha: '99' } }, 'workspace alpha');
    await repo.commitFile('package.json', { name: 'fixture', devDependencies: { alpha: '1' } }, 'section move');
    const removed = await commit(repo, null, 'remove alpha', '2030-01-01T00:00:00Z');
    const readded = await commit(repo, '2', 'reintroduce alpha', '2020-01-01T00:00:00Z');
    const { graph } = await flow(repo);
    assert.ok(graph.nodes.every(n => n.changes.every(e => e.manifest === 'package.json')));
    assert.ok(graph.nodes.some(n => n.changes.some(e => e.from === e.to && e.depTypeFrom === 'dependencies' && e.depType === 'devDependencies')));
    assert.ok(graph.edges.some(e => e.from === removed && e.to === readded));
    assert.equal(graph.nodes.at(-1).id, readded, 'ancestry takes precedence over author dates');
    assert.equal(graph.headState[0].version, '2');
    assert.deepEqual(graph.headResolved[0].versions, ['2']);
  } finally { repo.cleanup(); }
});

test('flow API: bounded generation-pinned windows, validation and cache invalidation', async () => {
  const repo = await createTestRepo(); let close;
  try {
    await commit(repo, '1', 'addition'); await commit(repo, '2', 'update');
    const running = await startServer({ port: 0, cwd: repo.repoDir }); close = running.close;
    const initial = await (await fetch(running.url + '/api/events')).json();
    const query = new URLSearchParams({ package: 'alpha', manifest: 'package.json', limit: '1', generation: initial.generation });
    const first = await fetch(running.url + '/api/dependency-flow?' + query, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(first.status, 200); assert.equal(first.headers.get('content-encoding'), 'gzip');
    const body = await first.json();
    assert.equal(body.nodes.length, 1); assert.equal(body.total, 2); assert.equal(body.nextOffset, 1);
    const second = await (await fetch(running.url + '/api/dependency-flow?' + query + '&offset=1')).json();
    assert.equal(second.nodes.length, 1); assert.equal(second.references[0].offset, 0);
    for (const extra of ['limit=101', 'offset=-1', 'offset=NaN']) {
      const invalid = new URLSearchParams(query); const [key, value] = extra.split('='); invalid.set(key, value);
      assert.equal((await fetch(running.url + '/api/dependency-flow?' + invalid)).status, 400);
    }
    const missing = new URLSearchParams(query); missing.set('manifest', '../../secret');
    assert.equal((await fetch(running.url + '/api/dependency-flow?' + missing)).status, 404);
    const css = await fetch(running.url + '/flow.css'); assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
    await commit(repo, '3', 'new generation');
    const updated = await (await fetch(running.url + '/api/events')).json();
    assert.notEqual(updated.generation, initial.generation);
    assert.equal((await fetch(running.url + '/api/dependency-flow?' + query)).status, 409);
    query.set('generation', updated.generation);
    const current = await (await fetch(running.url + '/api/dependency-flow?' + query)).json();
    assert.equal(current.total, 3);
  } finally { if (close) await close(); repo.cleanup(); }
});

test('flow: invalid HEAD and cancelled ancestry requests fail explicitly', async () => {
  const repo = await createTestRepo();
  try {
    const head = await commit(repo, '1', 'addition');
    await assert.rejects(buildDependencyFlow(repo.repoDir, [], { package: 'alpha', manifest: 'package.json', head: '--all' }), /resolved HEAD/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(buildDependencyFlow(repo.repoDir, [], { package: 'alpha', manifest: 'package.json', head, signal: controller.signal }));
  } finally { repo.cleanup(); }
});

test('flow: large histories retain every node across bounded windows and keep boundary references', () => {
  const sha = i => i.toString(16).padStart(40, '0');
  const nodes = Array.from({ length: 10000 }, (_, i) => ({ id: sha(i + 1), commit: sha(i + 1).slice(-7),
    date: '2026-01-01T00:00:00Z', author: 'Fixture', message: 'change', kind: 'change', gaps: [], changes: [] }));
  const graph = { package: 'alpha', manifest: 'package.json', nodes,
    edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, kind: 'continuation', source: 'manifest', manifest: 'package.json', file: 'package.json' })),
    headState: [], headResolved: [], headStateComplete: true, truncated: false };
  const seen = [];
  for (let offset = 0; offset < nodes.length;) {
    const page = pageDependencyFlow(graph, offset, 500);
    assert.ok(page.nodes.length <= 100);
    seen.push(...page.nodes.map(n => n.id));
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, nodes.map(n => n.id));
  const middle = pageDependencyFlow(graph, 6000, 50);
  assert.ok(middle.references.some(r => r.id === nodes[5999].id && r.offset === 5950));
  assert.ok(middle.references.some(r => r.id === nodes[6050].id && r.offset === 6050));
  assert.throws(() => pageDependencyFlow(graph, NaN), /Invalid/);
});

test('flow: JSON fallback preserves complete snapshot proof across reopening and paged reads', async () => {
  const repo = await createTestRepo();
  try {
    await commit(repo, '1', 'addition'); const result = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const file = path.join(repo.repoDir, 'flow-test-cache.json');
    let store = new JsonStore(file); store.insertEvents(result.events); store.close(); store = new JsonStore(file);
    try {
      assert.deepEqual(store.queryEvents(), result.events);
      assert.deepEqual(store.queryPaged({}, { limit: 1 }).events[0].flowEvidence, result.events[0].flowEvidence);
    } finally { store.close(); }
    await commit(repo, '2', 'incremental update');
    const incremental = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const head = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildDependencyFlow(repo.repoDir, incremental.events, { package: 'alpha', manifest: 'package.json', head });
    assert.equal(graph.nodes.length, 2); assert.equal(graph.edges.length, 2);
  } finally { repo.cleanup(); }
});
