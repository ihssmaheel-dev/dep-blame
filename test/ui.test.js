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
  } finally {
    await close();
  }
});
