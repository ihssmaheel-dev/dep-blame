import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../packages/core/ui/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../packages/core/ui/app.js', import.meta.url), 'utf8');

// Execute the actual client with a controlled stream and a minimal DOM adapter.
// Layout and popover interactions are checked separately in a real browser.
function client() {
  const nodes = new Map(), streams = [], timers = new Map();
  let document;
  function node(id) {
    const classes = new Set(), attributes = new Map(), listeners = new Map();
    return {
      id, style: {}, dataset: {}, hidden: false, disabled: false, value: '',
      textContent: '', innerHTML: '', tagName: 'DIV', isConnected: true,
      classList: {
        add: (...values) => values.forEach(v => classes.add(v)),
        remove: (...values) => values.forEach(v => classes.delete(v)),
        contains: v => classes.has(v),
        toggle(v, force = !classes.has(v)) { force ? classes.add(v) : classes.delete(v); }
      },
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name),
      addEventListener(name, handler) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(handler);
      },
      dispatch(name, event = {}) { for (const handler of listeners.get(name) || []) handler(event); },
      querySelectorAll: () => [], querySelector: () => null,
      focus() { document.activeElement = this; }, contains: () => false
    };
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], node(match[1]));
  nodes.get('filter-panel').hidden = true;
  const selectors = new Map();
  for (const selector of ['.content-card', '.calendar-nav-group', '.calendar-topbar', '.calendar-frame']) {
    selectors.set(selector, node(selector));
  }
  selectors.set('.table-responsive', nodes.get('timeline-view'));
  document = {
    documentElement: node('html'), activeElement: null,
    getElementById(id) { assert.ok(nodes.has(id), `Unknown dashboard element: ${id}`); return nodes.get(id); },
    querySelector: selector => selectors.get(selector) || null,
    querySelectorAll: () => [], addEventListener() {}
  };
  class Stream {
    constructor() { this.listeners = new Map(); this.closed = false; streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, value) { this.listeners.get(type)?.({data: JSON.stringify(value)}); }
    close() { this.closed = true; }
  }
  let fallback = async () => { throw new Error('Offline fixture'); };
  const context = vm.createContext({
    document, URL, console, EventSource: Stream,
    window: {EventSource: Stream, addEventListener() {}},
    localStorage: {getItem: () => null, setItem() {}},
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: (...args) => fallback(...args)
  });
  vm.runInContext(script, context);
  return {nodes, streams, run: code => vm.runInContext(code, context), fallback: value => { fallback = value; }};
}

const event = (date, manifest = 'package.json', type = 'added') => ({
  date: date + 'T12:00:00Z', manifest, type, package: 'alpha', to: '2', from: '1',
  source: 'manifest', depType: 'dependencies', author: 'Fixture author',
  commit: 'abcdef0', commitFull: 'abcdef0'.padEnd(40, '0'), message: 'Change alpha'
});
const result = events => ({schemaVersion: 1, repository: 'fixture', events});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('ui behavior: switching views during a scan preserves progress until completion', async () => {
  const ui = client();
  ui.streams[0].emit('progress', {phase: 'analyzing', current: 4, total: 10, message: 'Reading history'});
  ui.run('switchToCalendar(); switchToTimeline(); switchToCalendar(); switchToTimeline();');
  assert.equal(ui.nodes.get('history-status').hidden, false);
  assert.equal(ui.nodes.get('scan-progress-box').hidden, false);
  assert.equal(ui.nodes.get('scan-title-text').textContent, 'Reading history');
  assert.equal(ui.nodes.get('scan-percent-label').textContent, '66%');
  assert.equal(ui.nodes.get('timeline-view').style.display, 'none');
  assert.ok(!ui.nodes.get('events-tbody').innerHTML.includes('no dependency events'));
  assert.equal(ui.nodes.get('pager').hidden, true);
  assert.equal(ui.nodes.get('refresh-btn').disabled, true);
  ui.streams[0].emit('complete', result([event('2026-09-28')]));
  await flush();
  assert.equal(ui.nodes.get('history-status').hidden, true);
  assert.equal(ui.nodes.get('timeline-view').style.display, 'block');
  assert.ok(ui.nodes.get('events-tbody').innerHTML.includes('alpha'));
  assert.equal(ui.nodes.get('refresh-btn').disabled, false);
  assert.equal(ui.nodes.get('calendar-filters-btn').hidden, true);
});

test('ui behavior: retry and fetch fallback stay loading and errors survive view changes', async () => {
  const ui = client();
  let finish;
  ui.fallback(() => new Promise(resolve => { finish = resolve; }));
  ui.streams[0].emit('error');
  await flush();
  ui.streams[1].emit('error');
  await flush();
  ui.run('switchToCalendar(); switchToTimeline();');
  assert.equal(ui.nodes.get('refresh-btn').disabled, true);
  assert.equal(ui.nodes.get('history-status').hidden, false);
  finish({ok: false, status: 500, json: async () => ({error: 'Fixture scan failed'})});
  await flush();
  ui.run('switchToCalendar(); switchToTimeline();');
  assert.equal(ui.nodes.get('history-load-error').hidden, false);
  assert.equal(ui.nodes.get('history-error-message').textContent, 'Fixture scan failed');
  assert.equal(ui.nodes.get('scan-progress-box').hidden, true);
  assert.equal(ui.nodes.get('refresh-btn').disabled, false);
  assert.ok(!ui.nodes.get('events-tbody').innerHTML.includes('no dependency events'));
});

test('ui behavior: calendar skips empty months, reuses buckets, and hides an empty grid', async () => {
  const ui = client();
  ui.streams[0].emit('complete', result([event('2025-01-15'), event('2026-09-28'), event('2026-10-01')]));
  await flush();
  ui.run('switchToCalendar();');
  assert.equal(ui.nodes.get('calendar-month-title').textContent, 'October 2026');
  assert.equal(ui.nodes.get('calendar-filters-btn').hidden, false);
  assert.equal(ui.nodes.get('cal-next-btn').disabled, true);
  ui.run('globalThis.savedBuckets = calendarActivity(); moveCalendar(-1); moveCalendar(-1);');
  assert.equal(ui.nodes.get('calendar-month-title').textContent, 'January 2025');
  assert.equal(ui.nodes.get('cal-prev-btn').disabled, true);
  assert.equal(ui.run('calendarActivity() === savedBuckets'), true);
  ui.run("currentSearch = 'no matching event'; renderView();");
  assert.equal(ui.run("document.querySelector('.calendar-frame').hidden"), true);
  assert.equal(ui.nodes.get('calendar-empty').hidden, false);
  assert.equal(ui.nodes.get('calendar-days-grid').innerHTML, '');
  ui.run("currentSearch = ''; renderView();");
  assert.equal(ui.nodes.get('calendar-month-title').textContent, 'January 2025');
  assert.equal(ui.run("document.querySelector('.calendar-frame').hidden"), false);
});

test('ui behavior: manifest selection matches the full path and profiles never guess usernames', async () => {
  const ui = client();
  ui.streams[0].emit('complete', result([event('2026-09-28'), event('2026-09-28', 'packages/app/package.json')]));
  await flush();
  ui.run("colFilters.manifest = 'packages/app/package.json'; renderView();");
  assert.equal(ui.run('getFilteredEvents().length'), 1);
  assert.equal(ui.run('getFilteredEvents()[0].manifest'), 'packages/app/package.json');
  assert.equal(ui.nodes.get('manifest-selected-label').textContent, 'packages/app/package.json');
  assert.ok(!ui.run("renderAuthorName('Fixture author', 'unknown')").includes('<a'));
  ui.run("authorProfiles.set('known', {profile: {username: 'real-account', profileUrl: 'https://git.example/base/real-account'}});");
  assert.match(ui.run("renderAuthorName('<Author>', 'known')"), /href="https:\/\/git\.example\/base\/real-account"/);
  assert.match(ui.run("renderAuthorName('<Author>', 'known')"), /&lt;Author&gt;/);
  ui.run("authorProfiles.set('unsafe', {profile: {profileUrl: 'javascript:alert(1)'}});");
  assert.ok(!ui.run("renderAuthorName('Fixture author', 'unsafe')").includes('<a'));
});
