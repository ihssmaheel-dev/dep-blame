import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createTestRepo } from './helpers/git-fixture.js';

const installed = path.resolve(process.argv[2]);
const core = path.join(installed, 'node_modules/dep-blame');
const ui = path.join(installed, 'node_modules/@dep-blame/ui');
for (const pkg of [core, ui]) assert.ok(fs.existsSync(path.join(pkg, 'LICENSE')));
execFileSync(process.execPath, [path.join(core, 'bin/cli.js'), '--help']);
execFileSync(process.execPath, [path.join(ui, 'bin/cli.js'), '--help']);
const {runDepBlame} = await import(pathToFileURL(path.join(core, 'dist/index.js')));
const {startServer} = await import(pathToFileURL(path.join(ui, 'src/server.js')));
const repo = await createTestRepo();
let instance;
try {
  await repo.commitFile('package.json', {dependencies: {alpha: '1'}}, 'add alpha');
  await repo.commitFile('package.json', {dependencies: {alpha: '2'}}, 'update alpha');
  const result = await runDepBlame({cwd: repo.repoDir, silent: true});
  assert.deepEqual(result.events.map(e => e.type), ['added', 'updated']);
  instance = await startServer({cwd: repo.repoDir, port: 0});
  const page = await fetch(instance.url);
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy'));
  const html = await page.text();
  const font = html.match(/url\(['"]?([^)'"\s]+\.woff2)/)?.[1];
  assert.ok(font, 'bundled font reference');
  assert.equal((await fetch(new URL(font, instance.url))).status, 200);
  assert.equal((await fetch(`${instance.url}/app.js`)).status, 200);
  const data = await (await fetch(`${instance.url}/api/events`)).json();
  assert.equal(data.events.length, 2);
  console.log('Installed core and UI tarballs: CLI, engine, API, font, CSP, and LICENSE smoke checks passed.');
} finally {
  if (instance) await instance.close();
  repo.cleanup();
}
