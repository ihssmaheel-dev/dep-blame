import test from 'node:test';
import assert from 'node:assert/strict';
import { ParsedBlobCache, parsedBlobCache } from '../packages/core/dist/manifest/parse-cache.js';

const single = (version) => ({ ok: true, entries: new Map([['a', { version, depType: 'dependencies' }]]) });
const multi = (version) => ({ ok: true, maps: new Map([['package.json', new Map([['a', { version, depType: 'dependencies' }]])]]) });

test('parse cache: identical blob OIDs share one parse result', () => {
  const cache = new ParsedBlobCache();
  assert.equal(cache.get('abc'), undefined);
  assert.equal(cache.get(undefined), undefined);
  cache.set(undefined, { kind: 'single', result: single('1') });
  assert.equal(cache.size, 0);

  cache.set('abc', { kind: 'single', result: single('1') });
  assert.equal(cache.size, 1);
  // Same reference back: no re-parse, no copy.
  assert.equal(cache.get('abc').result.entries.get('a').version, '1');

  cache.set('def', { kind: 'multi', result: multi('2') });
  const hit = cache.get('def');
  assert.equal(hit.kind, 'multi');
  assert.equal(hit.result.maps.get('package.json').get('a').version, '2');
});

test('parse cache: evicts oldest blobs under budget pressure', () => {
  const cache = new ParsedBlobCache();
  // 65 distinct blobs exceeds the 64-blob budget; the first must go.
  for (let i = 0; i < 65; i++) cache.set(`oid-${i}`, { kind: 'single', result: single(`${i}`) });
  assert.equal(cache.size, 64);
  assert.equal(cache.get('oid-0'), undefined);
  assert.ok(cache.get('oid-64'));

  // A 110k-entry map blows the 100k token budget on its own terms.
  const big = new Map();
  for (let i = 0; i < 110000; i++) big.set(`p${i}`, { version: '1', depType: 'dependencies' });
  cache.set('big', { kind: 'single', result: { ok: true, entries: big } });
  assert.ok(cache.size <= 64);
  assert.ok(cache.get('big'));
});

test('parse cache: shared singleton starts empty and clears', () => {
  parsedBlobCache.clear();
  assert.equal(parsedBlobCache.size, 0);
});
