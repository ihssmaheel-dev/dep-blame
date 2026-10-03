import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame } from '../packages/core/dist/engine.js';
import { batchReadBlobs } from '../packages/core/dist/git/batch.js';
import { startServer } from '../packages/core/ui/server.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/core/bin/cli.js', import.meta.url));
const MiB = 1024 * 1024;

test('large history: cold UI, HEAD, warm baselines, large commits, and CLI exceed 64 MiB in total', async () => {
  const repo = await createTestRepo();
  let instance;
  try {
    await repo.commitFile('package.json', { name: 'large-workspace', workspaces: ['packages/*'] }, 'root');
    const manifests = Array.from({ length: 8 }, (_, i) => `packages/p${i}/package.json`);
    function writeManifest(i, version) {
      // Valid manifests with small parsed dependency maps and large source blobs.
      // Distinct metadata ensures these are eight unique Git objects (>72 MiB).
      fs.writeFileSync(path.join(repo.repoDir, manifests[i]), JSON.stringify({
        name: `p${i}`, dependencies: { [`alpha-${i}`]: version }, metadata: 'x'.repeat(9 * MiB) + i
      }));
    }
    for (let i = 0; i < manifests.length; i++) {
      fs.mkdirSync(path.dirname(path.join(repo.repoDir, manifests[i])), { recursive: true });
      writeManifest(i, '1');
      await repo.runGit(['add', manifests[i]]);
      await repo.runGit(['commit', '-m', `add workspace ${i}`]);
    }
    // An outside-range first parent needs all eight large baseline blobs.
    await repo.commitFile('notes.txt', 'unrelated change', 'notes');
    for (let i = 0; i < manifests.length; i++) writeManifest(i, '2');
    await repo.runGit(['add', 'packages']);
    await repo.runGit(['commit', '-m', 'update all workspaces in one large commit']);
    const sha = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    // The collecting API still protects callers that retain an entire map.
    await assert.rejects(batchReadBlobs(repo.repoDir, manifests.map(p => ({ commit: sha, path: p }))), /Git blob batch exceeds/);

    instance = await startServer({ cwd: repo.repoDir, port: 0 });
    const response = await fetch(`${instance.url}/api/events/stream`);
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.doesNotMatch(stream, /event: error/, stream.slice(-500));
    const completion = stream.match(/event: complete\ndata: ([^\n]+)/);
    assert.ok(completion, 'SSE scan must complete');
    const data = JSON.parse(completion[1]);
    assert.equal(data.events.length, 16);
    assert.equal(data.headStateComplete, true);
    assert.equal(data.headState.length, 8);
    assert.equal(data.events.filter(e => e.type === 'updated').length, 8);

    const api = await fetch(`${instance.url}/api/events`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).events.length, 16);
    const warm = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(warm.cached, true);
    assert.equal(warm.headStateComplete, true);
    assert.equal(warm.headState.length, 8);

    writeManifest(0, '3');
    await repo.runGit(['add', manifests[0]]);
    await repo.runGit(['commit', '-m', 'incremental update after large baseline']);
    const incremental = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(incremental.events.length, 17);
    assert.equal(incremental.headStateComplete, true);
    assert.equal(incremental.headState.find(e => e.package === 'alpha-0').version, '3');
    const { stdout } = await execFileAsync(process.execPath, [cli, '--json', '--no-cache'], {
      cwd: repo.repoDir, windowsHide: true, maxBuffer: MiB
    });
    const json = JSON.parse(stdout);
    assert.equal(json.events.length, 17);
    // CLI schema omits the flag when complete and emits it only when false.
    assert.notEqual(json.headStateComplete, false);
    assert.deepEqual(json.headState, incremental.headState);
    assert.deepEqual(json.events, incremental.events);
  } finally {
    if (instance) await instance.close();
    repo.cleanup();
  }
});
