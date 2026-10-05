import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createTestRepo } from './helpers/git-fixture.js';

// Single-package smoke: one `dep-blame` tarball carries the CLI, the engine,
// and the bundled dashboard (ui/).
const installed = path.resolve(process.argv[2]);
const core = path.join(installed, 'node_modules/dep-blame');
assert.ok(fs.existsSync(path.join(core, 'LICENSE')));
assert.ok(fs.existsSync(path.join(core, 'ui', 'server.js')));
assert.ok(fs.existsSync(path.join(core, 'ui', 'index.html')));
assert.ok(fs.existsSync(path.join(core, 'ui', 'app.js')));
assert.ok(fs.existsSync(path.join(core, 'ui', 'flow.css')));
assert.ok(fs.existsSync(path.join(core, 'dist', 'render', 'dependency-flow.js')));
execFileSync(process.execPath, [path.join(core, 'bin/cli.js'), '--help']);
execFileSync(process.execPath, [path.join(core, 'bin/dep-blame-ui.js'), '--help']);
const {runDepBlame} = await import(pathToFileURL(path.join(core, 'dist/index.js')));
const {startServer} = await import(pathToFileURL(path.join(core, 'ui/server.js')));
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
  const query = new URLSearchParams({ package: 'alpha', manifest: 'package.json', generation: data.generation });
  const flow = await (await fetch(`${instance.url}/api/dependency-flow?${query}`)).json();
  assert.equal(flow.total, 2); assert.equal(flow.edges.length, 1);
  assert.equal((await fetch(`${instance.url}/flow.css`)).status, 200);
  console.log('Installed dep-blame tarball: CLI, UI bins, engine, API, font, CSP, and LICENSE smoke checks passed.');
} finally {
  if (instance) await instance.close();
  repo.cleanup();
}
