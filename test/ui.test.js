import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer } from '../packages/ui/src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('ui: enforces HTML size budget (<100KB uncompressed, <30KB gzipped)', () => {
  const htmlPath = path.join(__dirname, '../packages/ui/src/index.html');
  const content = fs.readFileSync(htmlPath);
  const gzipped = zlib.gzipSync(content);

  // Assert raw size < 100KB
  assert.ok(content.length < 100 * 1024, `HTML raw size exceeds 100KB: ${content.length} bytes`);

  // Assert gzipped size < 30KB
  assert.ok(gzipped.length < 30 * 1024, `HTML gzip size exceeds 30KB: ${gzipped.length} bytes`);
});

test('ui: served bundle stays small with gzip transfer', async () => {
  const htmlPath = path.join(__dirname, '../packages/ui/src/index.html');
  const jsPath = path.join(__dirname, '../packages/ui/src/app.js');
  const total = fs.readFileSync(htmlPath).length + fs.readFileSync(jsPath).length;
  const gzipped = zlib.gzipSync(fs.readFileSync(htmlPath)).length + zlib.gzipSync(fs.readFileSync(jsPath)).length;
  assert.ok(gzipped < 40 * 1024, `UI gzip transfer exceeds 40KB: ${gzipped} bytes (raw ${total})`);
});

test('ui: no inline event handlers remain in served markup or script', () => {
  const html = fs.readFileSync(path.join(__dirname, '../packages/ui/src/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../packages/ui/src/app.js'), 'utf8');
  assert.ok(!/onclick\s*=/.test(html), 'index.html must not contain inline onclick');
  assert.ok(!/onclick\s*=/.test(js), 'app.js must not interpolate inline onclick');
  assert.ok(!/onerror\s*=/.test(js), 'app.js must not interpolate inline onerror');
  assert.ok(!html.includes('fonts.googleapis.com'), 'dashboard must work offline (no remote fonts)');
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

    // 2. Test GET /api/events
    const apiRes = await fetch(`${url}/api/events`);
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await apiRes.json();
    assert.equal(data.schemaVersion, 1);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.workspacePackages && typeof data.workspacePackages === 'object');
    assert.equal(data.workspacePackages['dep-blame'], 'packages/core');
    assert.equal(data.workspacePackages['@dep-blame/ui'], 'packages/ui');
    assert.ok(data.authors && typeof data.authors === 'object');
    assert.ok(data.authors['Mohamed Ismail S']);
    assert.equal(data.authors['Mohamed Ismail S'].username, 'ihssmaheel-dev');
    // No email or remote-avatar exposure.
    for (const author of Object.values(data.authors)) {
      assert.ok(!('email' in author), 'author map must not expose emails');
      assert.ok(!('avatarUrl' in author), 'author map must not contain remote avatars');
    }
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
