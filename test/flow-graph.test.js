import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../packages/core/ui/flow-graph.js', import.meta.url), 'utf8'), context);
const { layout, fit, zoomAt } = context.DepBlameGraph;

test('graph layout: branches stay separate and merge after both parents, regardless of input dates/order', () => {
  const nodes = ['merge', 'base', 'left', 'right', 'unrelated'].map(id => ({ id }));
  const edges = [{ from: 'base', to: 'left' }, { from: 'base', to: 'right' },
    { from: 'left', to: 'merge' }, { from: 'right', to: 'merge', kind: 'integration' }];
  const g = layout(nodes, [...edges, edges[0], { from: 'off-window', to: 'base' }]);
  assert.equal(g.edges.length, 4, 'duplicate source evidence shares a visual edge; off-window paths are not invented');
  assert.equal(g.incomplete, false);
  for (const e of edges) assert.ok(g.nodes.get(e.from).x < g.nodes.get(e.to).x);
  assert.equal(g.nodes.get('left').x, g.nodes.get('right').x);
  assert.ok(Math.abs(g.nodes.get('left').y - g.nodes.get('right').y) >= 178);
  assert.ok(!g.edges.some(e => e.from === 'unrelated' || e.to === 'unrelated'));
  for (const a of g.nodes.values()) for (const b of g.nodes.values()) {
    if (a.id === b.id) continue;
    assert.ok(Math.abs(a.x - b.x) >= 264 || Math.abs(a.y - b.y) >= 178, 'cards must not overlap');
  }
});

test('graph viewport: zoom keeps the pointer anchored and fit contains a readable small graph', () => {
  const v = { x: 60, y: -20, k: .7 }, point = { x: 180, y: 150 };
  const next = zoomAt(v, 1.2, point);
  assert.ok(Math.abs((point.x - v.x) / v.k - (point.x - next.x) / next.k) < 1e-8);
  assert.ok(Math.abs((point.y - v.y) / v.k - (point.y - next.y) / next.k) < 1e-8);
  assert.equal(zoomAt(v, 1000, point).k, 1.8);
  assert.equal(zoomAt(v, 0, point).k, .12);
  const g = layout([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b' }]);
  const f = fit(g, 1000, 600);
  assert.ok(f.k >= .75 && f.x >= 0 && f.y >= 0);
  assert.ok(g.width * f.k + f.x <= 1000 && g.height * f.k + f.y <= 600);
});

test('graph layout: empty, cyclic, and bounded 100-node histories terminate without invalid geometry', () => {
  assert.equal(layout([], []).nodes.size, 0);
  const bad = layout([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
  assert.equal(bad.incomplete, true); assert.equal(bad.edges.length, 0);
  const nodes = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
  const g = layout(nodes, nodes.slice(1).map((n, i) => ({ from: String(i), to: n.id })));
  assert.equal(g.nodes.size, 100); assert.equal(g.edges.length, 99);
  assert.ok(g.edges.every(e => !/NaN|Infinity/.test(e.d)));
});
