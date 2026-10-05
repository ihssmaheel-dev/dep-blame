import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../packages/core/ui/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../packages/core/ui/app.js', import.meta.url), 'utf8');

// Execute the actual client with a controlled stream and a minimal DOM adapter.
// Layout and popover interactions are checked separately in a real browser.
function client() {
  const nodes = new Map(), streams = [], timers = new Map(), documentListeners = new Map();
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
      focus() { document.activeElement = this; }, contains(target) { return target === this; }, closest: () => null
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
    querySelectorAll: () => [],
    addEventListener(name, handler) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(handler);
    },
    dispatch(name, event) { for (const handler of documentListeners.get(name) || []) handler(event); }
  };
  class Stream {
    constructor() { this.listeners = new Map(); this.closed = false; streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, value) { this.listeners.get(type)?.({data: JSON.stringify(value)}); }
    close() { this.closed = true; }
  }
  let fallback = async () => { throw new Error('Offline fixture'); };
  const context = vm.createContext({
    document, URL, URLSearchParams, AbortController, console, EventSource: Stream,
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

test('ui flow: a bubbled workspace trigger click keeps its popup open, while an outside click closes it', () => {
  const ui = client(), panel = ui.nodes.get('filter-panel'), anchor = ui.nodes.get('flow-manifest-btn');
  ui.run("panelAnchor = document.getElementById('flow-manifest-btn'); openPanelKind = 'flow-manifest'; document.getElementById('filter-panel').hidden = false;");
  ui.run("document.dispatch('click', {target: document.getElementById('flow-manifest-btn')});");
  assert.equal(panel.hidden, false);
  // Simulate the SVG/text child of the trigger after its button handler opened the panel.
  ui.nodes.get('flow-manifest-label').closest = () => null;
  anchor.contains = target => target === anchor || target === ui.nodes.get('flow-manifest-label');
  ui.run("document.dispatch('click', {target: document.getElementById('flow-manifest-label')});");
  assert.equal(panel.hidden, false);
  ui.run("document.dispatch('click', {target: document.getElementById('search-input')});");
  assert.equal(panel.hidden, true);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
});

function flowResponse(events, generation = 'fixture-generation') {
  return { schemaVersion: 1, generation, manifest: 'package.json', package: 'alpha',
    total: events.length, offset: 0, limit: 50, nextOffset: null, references: [], edges: [],
    headState: [{ package: 'alpha', manifest: 'package.json', version: '2', depType: 'dependencies' }],
    headResolved: [{ file: 'package-lock.json', status: 'resolved', versions: ['2'] }], headStateComplete: true,
    nodes: events.map((e, index) => ({ id: e.commitFull, commit: e.commit, date: e.date, author: e.author,
      message: e.message, kind: index ? 'integration' : 'change', gaps: [], changes: [e] })) };
}

test('ui flow: loading, source evidence, collapsed integrations, HEAD and escaped details', async () => {
  const ui = client(), first = event('2026-09-28'), second = { ...first, commit: 'bcdef00', commitFull: 'b'.repeat(40) };
  first.message = '<img src=x onerror=alert(1)>';
  ui.streams[0].emit('complete', { ...result([first, second]), generation: 'fixture-generation' }); await flush();
  let finish, queries = 0;
  ui.fallback((url, opts) => { queries++; assert.match(url, /generation=fixture-generation/); assert.ok(opts.signal); return new Promise(resolve => { finish = resolve; }); });
  ui.run("openArchaeology('alpha'); setDrawerView('flow'); setDrawerView('history'); setDrawerView('flow');");
  assert.equal(queries, 1); assert.equal(ui.nodes.get('flow-status').hidden, false);
  assert.equal(ui.nodes.get('drawer-flow-panel').getAttribute('aria-busy'), 'true');
  assert.equal(ui.nodes.get('flow-content').hidden, true);
  finish({ ok: true, json: async () => flowResponse([first, second]) }); await flush();
  assert.equal(ui.nodes.get('flow-content').hidden, false);
  assert.equal(ui.nodes.get('drawer-flow-panel').getAttribute('aria-busy'), 'false');
  assert.match(ui.nodes.get('flow-nodes').innerHTML, /Declared/);
  assert.match(ui.nodes.get('flow-integrations-summary').textContent, /1 verified merge integration/);
  assert.equal(ui.nodes.get('flow-integrations').open, false);
  assert.match(ui.nodes.get('flow-head').innerHTML, /Current checkout · HEAD/);
  assert.match(ui.nodes.get('flow-head').innerHTML, /Resolved: 2/);
  assert.ok(ui.nodes.get('flow-details').innerHTML.includes('&lt;img'));
  assert.ok(!ui.nodes.get('flow-details').innerHTML.includes('<img'));
  assert.equal(ui.nodes.get('flow-manifest-btn').hidden, true);
});

test('ui flow: closed drawers and changed generations discard delayed responses', async () => {
  const ui = client(), e = event('2026-09-28');
  ui.streams[0].emit('complete', { ...result([e]), generation: 'fixture-generation' }); await flush();
  let finish, signal;
  ui.fallback((url, opts) => { signal = opts.signal; return new Promise(resolve => { finish = resolve; }); });
  ui.run("openArchaeology('alpha'); setDrawerView('flow'); closeArchaeology();");
  assert.equal(signal.aborted, true);
  finish({ ok: true, json: async () => flowResponse([e]) }); await flush();
  assert.equal(ui.run('flowData'), null);
  assert.equal(ui.nodes.get('drawer-overlay').classList.contains('active'), false);
  ui.fallback(async () => ({ ok: true, json: async () => flowResponse([e], 'outdated') }));
  ui.run("openArchaeology('alpha'); setDrawerView('flow');"); await flush();
  assert.equal(ui.nodes.get('flow-content').hidden, true);
  assert.match(ui.nodes.get('flow-status').textContent, /History changed/);
  assert.equal(ui.nodes.get('flow-retry').hidden, false);
});

test('ui flow: section moves remain explicit, tabs work from keyboard and lockfiles share their workspace', async () => {
  const ui = client(), e = { ...event('2026-09-28', 'package.json', 'updated'), from: '2', depTypeFrom: 'dependencies', depType: 'devDependencies' };
  const lock = { ...e, source: 'lockfile', manifest: 'package-lock.json' };
  ui.streams[0].emit('complete', { ...result([e, lock]), generation: 'fixture-generation' }); await flush();
  ui.fallback(async () => ({ ok: true, json: async () => flowResponse([e]) }));
  ui.run("openArchaeology('alpha');");
  ui.nodes.get('drawer-history-tab').dispatch('keydown', { key: 'ArrowRight', preventDefault() {} }); await flush();
  assert.equal(ui.nodes.get('drawer-flow-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.nodes.get('drawer-history-tab').getAttribute('tabindex'), '-1');
  assert.match(ui.nodes.get('flow-nodes').innerHTML, /Dependency section moved/);
  assert.match(ui.nodes.get('flow-nodes').innerHTML, /version unchanged/);
  assert.match(ui.nodes.get('flow-nodes').innerHTML, /dependencies → devDependencies/);
  assert.equal(ui.run('flowManifests.length'), 1);
  ui.nodes.get('drawer-flow-tab').dispatch('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(ui.nodes.get('drawer-history-panel').hidden, false);
});

test('ui history: large package drawers bound the DOM while navigation retains all commit evidence', async () => {
  const ui = client(), events = Array.from({length: 121}, (_, i) => ({ ...event('2026-09-28'), commit: i.toString(16).padStart(7, '0'), commitFull: i.toString(16).padStart(40, '0') }));
  ui.streams[0].emit('complete', result(events)); await flush(); ui.run("openArchaeology('alpha');");
  assert.equal((ui.nodes.get('drawer-timeline').innerHTML.match(/class="timeline-node /g) || []).length, 50);
  assert.equal(ui.nodes.get('drawer-history-window').hidden, false);
  ui.nodes.get('drawer-history-later').dispatch('click');
  assert.match(ui.nodes.get('drawer-history-window-label').textContent, /51–100 of 121/);
  ui.nodes.get('drawer-history-later').dispatch('click');
  assert.equal((ui.nodes.get('drawer-timeline').innerHTML.match(/class="timeline-node /g) || []).length, 21);
  assert.equal(ui.nodes.get('drawer-history-later').disabled, true);
  ui.nodes.get('drawer-history-earlier').dispatch('click');
  assert.match(ui.nodes.get('drawer-history-window-label').textContent, /51–100 of 121/);
});

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

test('ui behavior: archaeology drawer groups same-commit evidence into one node', () => {
  const ui = client();
  const fixture = [
    { package: '@types/node', type: 'added', to: '^26.6.3', date: '2026-10-02T12:00:00Z', commit: 'abc1234', commitFull: 'a'.repeat(40), author: 'Dev', message: 'add workspaces', manifest: 'package.json', depType: 'devDependencies', source: 'manifest' },
    { package: '@types/node', type: 'added', to: '^26.6.3', date: '2026-10-02T12:00:00Z', commit: 'abc1234', commitFull: 'a'.repeat(40), author: 'Dev', message: 'add workspaces', manifest: 'packages/app/package.json', depType: 'devDependencies', source: 'manifest' },
    { package: '@types/node', type: 'added', to: '26.6.3', date: '2026-10-02T12:00:00Z', commit: 'abc1234', commitFull: 'a'.repeat(40), author: 'Dev', message: 'add workspaces', manifest: 'package.json', depType: 'devDependencies', source: 'lockfile' },
    { package: '@types/node', type: 'added', to: '26.6.3', date: '2026-10-02T12:00:00Z', commit: 'abc1234', commitFull: 'a'.repeat(40), author: 'Dev', message: 'add workspaces', manifest: 'packages/app/package.json', depType: 'devDependencies', source: 'lockfile' },
    { package: '@types/node', type: 'updated', from: '^26.6.3', to: '^26.7.0', date: '2026-10-03T12:00:00Z', commit: 'def5678', commitFull: 'b'.repeat(40), author: 'Dev', message: 'bump types', manifest: 'package.json', depType: 'devDependencies', source: 'manifest' }
  ];
  ui.run(`globalThis.groupFixture = ${JSON.stringify(fixture)};`);
  assert.equal(ui.run('groupLifecycleNodes(groupFixture).length'), 2);
  assert.equal(ui.run('groupLifecycleNodes(groupFixture)[0].manifests.length'), 2);
  assert.equal(ui.run('groupLifecycleNodes(groupFixture)[0].declared.length'), 1);
  assert.equal(ui.run('groupLifecycleNodes(groupFixture)[0].resolved.length'), 1);
  assert.equal(ui.run('groupLifecycleNodes(groupFixture)[0].headline'), 'added');

  // The drawer renders one card per node, with both evidence streams inside.
  ui.run('allEvents = groupFixture; headStateData = []; headStateComplete = true; openArchaeology("@types/node");');
  const timelineHtml = ui.nodes.get('drawer-timeline').innerHTML;
  assert.equal(timelineHtml.split('node-card').length - 1, 2);
  assert.ok(timelineHtml.includes('Declared:'));
  assert.ok(timelineHtml.includes('Resolved:'));
  assert.ok(timelineHtml.includes('packages/app/package.json'));
  assert.equal(ui.nodes.get('drawer-changes-count').textContent, '2 commits');
  assert.equal(ui.nodes.get('drawer-evidence-count').textContent, '5 file events');
});

test('ui behavior: unknowable phases render indeterminate, not frozen', () => {
  const ui = client();
  ui.streams[0].emit('progress', { phase: 'reading_commits', current: 1500, total: 0, message: 'Reading commit history… (1500 found)' });
  assert.equal(ui.nodes.get('scan-percent-label').textContent, '…');
  assert.ok(ui.nodes.get('scan-bar-track').classList.contains('indeterminate'));
  assert.equal(ui.nodes.get('scan-commits-count').textContent, 'Reading commit history… (1500 found)');
});

test('ui behavior: heavy scans show a friendly wait message', () => {
  const ui = client();
  ui.streams[0].emit('progress', { phase: 'analyzing', current: 4, total: 2500, message: 'Batch 1/9: Analyzing…', detail: '4/2500 commits' });
  const note = ui.nodes.get('scan-slow-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Sorry for the wait/);
  assert.match(note.textContent, /2500/);
  assert.match(note.textContent, /seconds/);
  // Small scans stay clean: no apology needed.
  ui.streams[0].emit('progress', { phase: 'analyzing', current: 4, total: 10, message: 'Analyzing…', detail: '4/10 commits' });
  assert.equal(ui.nodes.get('scan-slow-note').hidden, true);
});

test('ui behavior: scan notices open in a modal instead of a banner', async () => {
  const ui = client();
  // The yellow wall above the table is gone.
  assert.throws(() => ui.run("document.getElementById('history-notices')"), /Unknown dashboard element/);
  ui.streams[0].emit('complete', { ...result([event('2026-09-28')]), warnings: ['broke one thing', 'broke <two> things'], truncated: true });
  await flush();
  assert.equal(ui.nodes.get('notices-btn').hidden, false);
  assert.equal(ui.nodes.get('notices-count').textContent, '3');
  ui.nodes.get('notices-btn').dispatch('click');
  assert.equal(ui.nodes.get('notices-overlay').hidden, false);
  const listHtml = ui.nodes.get('notices-list').innerHTML;
  assert.ok(listHtml.includes('History is incomplete'));
  assert.ok(listHtml.includes('broke one thing'));
  assert.ok(listHtml.includes('broke &lt;two&gt; things'));
  assert.ok(!listHtml.includes('broke <two>'));
  ui.run('closeNotices()');
  assert.equal(ui.nodes.get('notices-overlay').hidden, true);
});

test('ui behavior: notices highlight paths and commits for readability', () => {
  const ui = client();
  const out = ui.run(`noticeHtml('packages/app/package.json no longer resolved by pnpm-lock.yaml at abc1234; keeping state.')`);
  assert.ok(out.includes('<span class="notice-path">packages/app/package.json</span>'));
  assert.ok(out.includes('<span class="notice-path">pnpm-lock.yaml</span>'));
  assert.ok(out.includes('<span class="notice-sha">abc1234</span>'));
  // Escaped first: no markup injection, no highlights inside long hashes.
  const evil = ui.run(`noticeHtml('x <img src=x onerror=alert(1)> ' + 'a'.repeat(40))`);
  assert.ok(!evil.includes('<img'));
  assert.ok(!evil.includes('notice-sha">aaaaaaa'));
  // Table region fills tall viewports instead of leaving dead page space.
  assert.match(html, /\.table-responsive[^}]*height:\s*clamp\(280px,\s*calc\(100dvh[^,]*,\s*1200px\)/);
});

test('ui behavior: theme toggle swaps in one repaint without transitions', () => {
  const ui = client();
  // Adapter localStorage is empty, so the dashboard starts dark.
  assert.equal(ui.run("document.documentElement.getAttribute('data-theme')"), 'dark');
  ui.nodes.get('theme-toggle').dispatch('click');
  assert.equal(ui.run("document.documentElement.getAttribute('data-theme')"), 'light');
  // The transition guard is applied synchronously around the swap (the rAF
  // stub never fires here, so it stays on — exactly what we assert).
  assert.equal(ui.run("document.documentElement.classList.contains('theme-switching')"), true);
  assert.equal(ui.nodes.get('theme-icon-dark').style.display, 'none');
  assert.equal(ui.nodes.get('theme-icon-light').style.display, 'block');
  // And the stylesheet honors the guard instead of animating every element.
  assert.match(html, /html\.theme-switching[^}]*transition:\s*none/);
});

test('ui behavior: archaeology separates direct changes, integrations, author roles, and export context', async () => {
  const ui = client();
  const original = { package: 'alpha', type: 'added', to: '^1', date: '2026-09-22T12:17:43+05:30',
    commit: 'aaaaaaa', commitFull: 'a'.repeat(40), author: 'Alice', message: 'Merge-looking subject',
    manifest: 'package.json', depType: 'devDependencies', source: 'manifest', commitParents: ['0'.repeat(40)], changeOrigin: 'direct' };
  const nodes = [original, { ...original, commit: 'bbbbbbb', commitFull: 'b'.repeat(40), author: 'Bob',
    date: '2026-09-22T12:28:50+05:30', commitParents: ['0'.repeat(40), 'a'.repeat(40)], changeOrigin: 'merge-integration' },
  { ...original, commit: 'ccccccc', commitFull: 'c'.repeat(40), author: '<Carol>', date: '2026-09-24T10:24:43+05:30',
    commitParents: ['0'.repeat(40), 'b'.repeat(40)], changeOrigin: 'merge-integration' }];
  const events = nodes.flatMap(e => [e, { ...e, source: 'lockfile', manifest: 'package-lock.json', to: '1' }]).reverse();
  ui.run(`allEvents = ${JSON.stringify(events)}; headStateData = [{package:'alpha',version:'^1',manifest:'package.json',depType:'devDependencies'}]; openArchaeology('alpha');`);
  assert.equal(ui.nodes.get('drawer-changes-count').textContent, '3 commits');
  assert.equal(ui.nodes.get('drawer-evidence-count').textContent, '6 file events');
  assert.equal(ui.nodes.get('drawer-history-summary').textContent, '1 direct change · 2 merge integrations');
  assert.equal(ui.nodes.get('drawer-first-author').textContent, 'Commit author: Alice');
  assert.equal(ui.nodes.get('drawer-manifest-summary').textContent, '2 evidence files');
  assert.equal(ui.nodes.get('drawer-authors-count').textContent, '3 authors');
  assert.equal(ui.nodes.get('drawer-history-note').hidden, false);
  const timeline = ui.nodes.get('drawer-timeline').innerHTML;
  assert.equal(timeline.split('Merged existing dependency').length - 1, 2);
  assert.equal(timeline.split('Merged by').length - 1, 2);
  assert.equal(timeline.split('Commit by').length - 1, 1);
  assert.ok(timeline.indexOf('aaaaaaa') < timeline.indexOf('bbbbbbb'));
  assert.ok(timeline.includes('&lt;Carol&gt;'));
  assert.ok(!timeline.includes('<Carol>'));
  ui.run("globalThis.copied = ''; globalThis.navigator = {clipboard: {writeText: async value => { globalThis.copied = value; }}};");
  ui.nodes.get('drawer-copy-md').dispatch('click');
  await flush();
  assert.match(ui.run('copied'), /Merge integration/);
  assert.match(ui.run('copied'), /Merge author/);
  assert.match(ui.run('copied'), /3 commits · 6 file events/);
  assert.match(ui.run('copied'), /first parent/);
  assert.match(ui.run('copied'), /not necessarily the original author/);
  ui.run("historyWarnings = ['Multiple installed versions for an unrelated package']; openArchaeology('alpha');");
  assert.match(ui.nodes.get('drawer-history-note').textContent, /Repository scan notices/);
  assert.doesNotMatch(ui.nodes.get('drawer-history-note').textContent, /first recorded date/);
  ui.run("historyTruncated = true; openArchaeology('alpha');");
  assert.match(ui.nodes.get('drawer-history-note').textContent, /first recorded date may be incomplete/);
});

test('ui behavior: generic merge changes and missing metadata never claim an existing integration', () => {
  const ui = client();
  const e = event('2026-09-28');
  ui.run(`allEvents = [${JSON.stringify({ ...e, changeOrigin: 'merge-change', commitParents: ['a'.repeat(40), 'b'.repeat(40)] })}]; openArchaeology('alpha');`);
  assert.match(ui.nodes.get('drawer-timeline').innerHTML, /Merge dependency changes/);
  assert.ok(!ui.nodes.get('drawer-timeline').innerHTML.includes('Merged existing'));
  ui.run(`allEvents = [${JSON.stringify({ ...e, message: 'Merge feature but metadata is unavailable' })}]; openArchaeology('alpha');`);
  assert.ok(!ui.nodes.get('drawer-timeline').innerHTML.includes('Merged by'));
  assert.equal(ui.nodes.get('drawer-history-summary').textContent, '1 commit without merge metadata');
});

test('ui behavior: equal-version updates explain section moves and complete resolved sets in table, drawer, filters, and Markdown', async () => {
  const ui = client();
  const base = {...event('2026-10-05', 'package-lock.json', 'updated'), source: 'lockfile', from: '1.0.0', to: '1.0.0', commitParents: [], changeOrigin: 'direct'};
  const move = {...base, depTypeFrom: 'dependencies', depType: 'devDependencies'};
  const set = {...base, commit: 'bbbbbbb', commitFull: 'b'.repeat(40), resolutionsFrom: ['1.0.0'], resolutions: ['1.0.0', '2.0.0'], ambiguous: true};
  ui.streams[0].emit('complete', result([move, set]));
  await flush();
  const rows = ui.nodes.get('events-tbody').innerHTML;
  assert.match(rows, /1\.0\.0 \(unchanged\)/);
  assert.match(rows, /Section moved: dependencies → devDependencies/);
  assert.match(rows, /Resolved versions changed/);
  assert.match(rows, /\{1\.0\.0, 2\.0\.0\}/);
  assert.match(ui.run(`changeKeyOf(${JSON.stringify(move)})`), /version unchanged/);
  assert.match(ui.run(`changeKeyOf(${JSON.stringify(set)})`), /2\.0\.0/);
  ui.run("openArchaeology('alpha'); globalThis.copied = ''; globalThis.navigator = {clipboard: {writeText: async value => { globalThis.copied = value; }}};");
  const drawer = ui.nodes.get('drawer-timeline').innerHTML;
  assert.match(drawer, /Section moved: dependencies → devDependencies/);
  assert.match(drawer, /\{1\.0\.0\} → \{1\.0\.0, 2\.0\.0\}/);
  ui.nodes.get('drawer-copy-md').dispatch('click');
  await flush();
  const markdown = ui.run('copied');
  assert.match(markdown, /\| Change \|/);
  assert.match(markdown, /Section moved: dependencies → devDependencies/);
  assert.match(markdown, /Resolved versions changed/);
  assert.match(markdown, /1\.0\.0, 2\.0\.0/);
  const other = {...set, manifest: 'apps/web/package-lock.json', resolutions: ['1.0.0', '3.0.0']};
  assert.equal(ui.run(`groupLifecycleNodes(${JSON.stringify([set, other])})[0].resolved.length`), 2);
  const unsafe = {...set, resolutions: ['1.0.0', '<img src=x onerror=alert(1)>']};
  const encoded = ui.run(`updateDiffHtml(${JSON.stringify(unsafe)})`);
  assert.ok(encoded.includes('&lt;img'));
  assert.ok(!encoded.includes('<img'));
});
