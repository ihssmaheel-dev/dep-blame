import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer } from '../packages/core/ui/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('ui: enforces HTML size budget (<100KB uncompressed, <30KB gzipped)', () => {
  const htmlPath = path.join(__dirname, '../packages/core/ui/index.html');
  const content = fs.readFileSync(htmlPath);
  const gzipped = zlib.gzipSync(content);

  // Assert raw size < 100KB
  assert.ok(content.length < 100 * 1024, `HTML raw size exceeds 100KB: ${content.length} bytes`);

  // Assert gzipped size < 30KB
  assert.ok(gzipped.length < 30 * 1024, `HTML gzip size exceeds 30KB: ${gzipped.length} bytes`);
});

test('ui: served bundle stays small with gzip transfer', async () => {
  const htmlPath = path.join(__dirname, '../packages/core/ui/index.html');
  const jsPath = path.join(__dirname, '../packages/core/ui/app.js');
  const css = fs.readFileSync(path.join(__dirname, '../packages/core/ui/flow.css'));
  const total = fs.readFileSync(htmlPath).length + fs.readFileSync(jsPath).length + css.length;
  const gzipped = zlib.gzipSync(fs.readFileSync(htmlPath)).length + zlib.gzipSync(fs.readFileSync(jsPath)).length + zlib.gzipSync(css).length;
  // 46 KiB: still ~1/3 of any framework baseline. Raised from 40 KiB across
  // two user-required additions that cannot shrink further — the full-detail
  // GitHub brand mark and header logo tile (~1.2 KiB gzipped), per-commit
  // lifecycle grouping (~1.3 KiB gzipped), and the scan-notices modal plus
  // slow-scan note (~1.7 KiB gzipped). The gate keeps blocking dependency
  // creep: any library or framework addition would blow past it by 50+ KiB.
  // The dependency flow adds ~6 KiB compressed with no runtime dependency.
  // Count its stylesheet as well, so extracting CSS cannot evade the budget.
  assert.ok(gzipped < 56 * 1024, `UI gzip transfer exceeds 56KB: ${gzipped} bytes (raw ${total})`);
});

test('ui: no inline event handlers remain in served markup or script', () => {
  const html = fs.readFileSync(path.join(__dirname, '../packages/core/ui/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../packages/core/ui/app.js'), 'utf8');
  assert.ok(!/onclick\s*=/.test(html), 'index.html must not contain inline onclick');
  assert.ok(!/onclick\s*=/.test(js), 'app.js must not interpolate inline onclick');
  assert.ok(!/onerror\s*=/.test(js), 'app.js must not interpolate inline onerror');
  assert.ok(!html.includes('fonts.googleapis.com'), 'dashboard must work offline (no remote fonts)');
  assert.ok(html.includes('/fonts/manrope-latin.woff2'), 'Manrope must load from the bundled same-origin fonts');
});

test('ui: bundled fonts stay small and serve correctly', async () => {
  const fontsDir = path.join(__dirname, '../packages/core/ui/fonts');
  const files = fs.readdirSync(fontsDir).filter((f) => f.endsWith('.woff2')).sort();
  assert.ok(files.length >= 1, 'expected bundled woff2 fonts');

  // Variable font, subsetted: the whole family must fit in ~60KB raw.
  let total = 0;
  for (const f of files) {
    const st = fs.statSync(path.join(fontsDir, f));
    assert.ok(st.size < 64 * 1024, `${f} exceeds 64KB: ${st.size} bytes`);
    total += st.size;
  }
  assert.ok(total < 96 * 1024, `bundled fonts exceed 96KB raw: ${total} bytes`);

  const { url, close } = await startServer({ port: 0, host: '127.0.0.1', cwd: path.resolve(__dirname, '..') });
  try {
    const fontRes = await fetch(`${url}/fonts/manrope-latin.woff2`);
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers.get('content-type'), 'font/woff2');
    assert.ok((fontRes.headers.get('cache-control') || '').includes('immutable'));
    const buf = Buffer.from(await fontRes.arrayBuffer());
    assert.ok(buf.length > 1024, 'font body too small to be real');
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'wOF2', 'not a woff2 file');

    // Path traversal is rejected, unknown fonts 404.
    const evil = await fetch(`${url}/fonts/%2e%2e/%2e%2e/package.json`);
    assert.equal(evil.status, 404);
    const missing = await fetch(`${url}/fonts/nope.woff2`);
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test('ui: local server serves HTML page and /api/events JSON endpoint', async () => {
  const { url, close } = await startServer({ port: 0, host: '127.0.0.1', cwd: path.resolve(__dirname, '..') });

  try {
    // 1. Test GET /
    const htmlRes = await fetch(`${url}/`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('content-type'), 'text/html; charset=utf-8');
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes('dep-blame'));
    assert.ok(htmlBody.includes('drawer-overlay'));

    // Proper datatable: every column header carries a filter icon.
    for (const panel of ['date', 'action', 'package', 'change', 'type', 'manifest', 'author', 'commit']) {
      assert.ok(htmlBody.includes(`data-panel="${panel}"`), `missing column filter panel: ${panel}`);
    }
    assert.ok(htmlBody.includes('col-filter-icon'), 'missing header filter icons');
    assert.ok(!htmlBody.includes('class="col-filters"'), 'filter bar must live in header icons, not a second row');
    assert.ok(htmlBody.includes('id="filter-panel"'), 'missing shared filter panel container');

    // Proper pagination: first/numbered/last + page-size selector.
    for (const id of ['pager-first', 'pager-prev', 'pager-numbers', 'pager-next', 'pager-last', 'pager-size']) {
      assert.ok(htmlBody.includes(`id="${id}"`), `missing pager control: ${id}`);
    }

    // Exact-stage progress stepper with all pipeline phases.
    for (const phase of ['initializing', 'discovering', 'reading_commits', 'analyzing', 'saving', 'complete']) {
      assert.ok(htmlBody.includes(`data-phase="${phase}"`), `missing progress phase: ${phase}`);
    }

    // Header brand mark + GitHub link.
    assert.ok(htmlBody.includes('src="/logo.svg"'), 'header must use the bundled brand logo');
    assert.ok(htmlBody.includes('id="github-link"'), 'missing header GitHub link');
    assert.ok(htmlBody.includes('href="https://github.com/ihssmaheel-dev/dep-blame"'), 'GitHub link points at the project repo');
    assert.ok(htmlBody.includes('target="_blank"'), 'GitHub link opens in a new tab');
    assert.ok(htmlBody.includes('rel="noopener noreferrer"'), 'GitHub link must use noopener');

    // 2. Test GET /api/events
    const apiRes = await fetch(`${url}/api/events`);
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await apiRes.json();
    assert.equal(data.schemaVersion, 1);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.workspacePackages && typeof data.workspacePackages === 'object');
    assert.equal(data.workspacePackages['dep-blame'], 'packages/core');
    assert.ok(data.authors && typeof data.authors === 'object');
    assert.ok(data.authors['Mohamed Ismail S']);
    assert.equal(data.authors['Mohamed Ismail S'].username, '');
    assert.equal(data.authors['Mohamed Ismail S'].profileUrl, null);
    // No email or remote-avatar exposure.
    for (const author of Object.values(data.authors)) {
      assert.ok(!('email' in author), 'author map must not expose emails');
      assert.ok(!('avatarUrl' in author), 'author map must not contain remote avatars');
    }
  } finally {
    await close();
  }
});

test('ui: bundled logo serves correctly', async () => {
  const logoSvg = fs.readFileSync(path.join(__dirname, '../packages/core/ui/logo.svg'), 'utf8');
  assert.ok(!/<script/i.test(logoSvg), 'logo must not contain scripts');
  assert.ok(logoSvg.includes('<svg'), 'logo must be an SVG document');

  const { url, close } = await startServer({ port: 0, host: '127.0.0.1', cwd: path.resolve(__dirname, '..') });
  try {
    const res = await fetch(`${url}/logo.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.ok((res.headers.get('cache-control') || '').includes('immutable'));
    const body = await res.text();
    assert.ok(body.includes('<svg'));
    assert.ok(!/<script/i.test(body), 'served logo must not contain scripts');
  } finally {
    await close();
  }
});

test('ui: CSP has no inline-script allowance and app.js is served', async () => {
  const { url, close } = await startServer({ port: 0, host: '127.0.0.1', cwd: path.resolve(__dirname, '..') });

  try {
    const htmlRes = await fetch(`${url}/`);
    const csp = htmlRes.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("script-src 'self'"), `CSP must lock scripts to self: ${csp}`);
    assert.ok(!csp.includes('unsafe-inline') || !/script-src[^;]*unsafe-inline/.test(csp), `script-src must not allow inline: ${csp}`);

    const jsRes = await fetch(`${url}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get('content-type'), 'application/javascript; charset=utf-8');
    const jsBody = await jsRes.text();
    assert.ok(jsBody.includes('renderTable'));
  } finally {
    await close();
  }
});

test('ui: spoofed Host headers are rejected', async () => {
  const net = await import('node:net');
  const { url, close } = await startServer({ port: 0, host: '127.0.0.1', cwd: path.resolve(__dirname, '..') });

  try {
    const { port } = new URL(url);
    const status = await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
        sock.write('GET /api/events HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      sock.on('end', () => resolve(data.split(' ')[1] || ''));
      sock.on('error', reject);
    });
    assert.equal(status, '403');
  } finally {
    await close();
  }
});

test('ui: non-loopback bind requires explicit opt-in', async () => {
  delete process.env.DEP_BLAME_ALLOW_LAN;
  let threw = false;
  try {
    await startServer({ port: 0, host: '0.0.0.0', cwd: path.resolve(__dirname, '..') });
  } catch (err) {
    threw = true;
    assert.ok(String(err.message).includes('DEP_BLAME_ALLOW_LAN'));
  }
  assert.ok(threw, 'expected refusal to bind 0.0.0.0 without opt-in');
});

test('ui: server streams progress and events over /api/events/stream', async () => {
  const { url, close } = await startServer({ port: 0, host: '127.0.0.1', cwd: path.resolve(__dirname, '..') });

  try {
    const streamRes = await fetch(`${url}/api/events/stream`);
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const text = await streamRes.text();
    assert.ok(text.includes(': connected'));
    assert.ok(text.includes('event: complete'));
    assert.ok(text.includes('"schemaVersion":1'));
  } finally {
    await close();
  }
});
