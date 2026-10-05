import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame } from '../packages/core/dist/engine.js';

const manifest = deps => ({name: 'fixture', dependencies: deps});
const lock = deps => ({lockfileVersion: 3, packages: {
  '': {dependencies: deps},
  ...Object.fromEntries(Object.entries(deps).map(([name, version]) => [`node_modules/${name}`, {version}]))
}});
async function commitBoth(repo, deps, message) {
  fs.writeFileSync(path.join(repo.repoDir, 'package.json'), JSON.stringify(manifest(deps)));
  fs.writeFileSync(path.join(repo.repoDir, 'package-lock.json'), JSON.stringify(lock(deps)));
  await repo.runGit(['add', 'package.json', 'package-lock.json']);
  await repo.runGit(['commit', '-m', message]);
  return (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
}

test('parent state: a filtered-out commit cannot make later file changes look like additions', async () => {
  const repo = await createTestRepo();
  try {
    await commitBoth(repo, {alpha: '1.0.0'}, 'Original alpha');
    await repo.commitFile('notes.txt', 'unrelated', 'Unrelated file');
    await repo.commitFile('package.json', manifest({alpha: '1.0.0', beta: '1.0.0'}), 'Declare beta');
    await repo.commitFile('package-lock.json', lock({alpha: '2.0.0', beta: '1.0.0'}), 'Update alpha and resolve beta');
    const cold = await runDepBlame({cwd: repo.repoDir, silent: true});
    const alpha = cold.events.filter(e => e.package === 'alpha');
    assert.equal(alpha.filter(e => e.type === 'added').length, 2, 'one original addition per evidence source');
    assert.deepEqual(alpha.filter(e => e.type === 'updated').map(e => [e.source, e.from, e.to]), [['lockfile', '1.0.0', '2.0.0']]);
    const warm = await runDepBlame({cwd: repo.repoDir, silent: true});
    assert.deepEqual(warm.events, cold.events);
    await repo.commitFile('notes.txt', 'still unrelated', 'Another unrelated file');
    await repo.commitFile('package.json', manifest({alpha: '2.0.0', beta: '1.0.0'}), 'Update declared alpha');
    await repo.commitFile('package-lock.json', lock({alpha: '3.0.0', beta: '1.0.0'}), 'Update resolved alpha again');
    const incremental = await runDepBlame({cwd: repo.repoDir, silent: true});
    const fresh = await runDepBlame({cwd: repo.repoDir, silent: true, noCache: true});
    assert.deepEqual(incremental.events, fresh.events);
    assert.equal(fresh.events.filter(e => e.package === 'alpha' && e.type === 'added').length, 2);
  } finally { repo.cleanup(); }
});

test('parent state: incoming merge snapshots retain manifests changed later on the branch', async () => {
  const repo = await createTestRepo();
  try {
    await commitBoth(repo, {alpha: '1.0.0'}, 'Base');
    await repo.runGit(['branch', 'feature']);
    await repo.commitFile('notes.txt', 'main', 'Unrelated main file');
    await repo.commitFile('package.json', {...manifest({alpha: '1.0.0'}), description: 'main'}, 'Main manifest metadata');
    await repo.runGit(['checkout', 'feature']);
    await repo.commitFile('feature.txt', 'feature', 'Unrelated feature file');
    await repo.commitFile('package.json', manifest({alpha: '2.0.0'}), 'Update alpha declaration');
    await repo.commitFile('package-lock.json', lock({alpha: '2.0.0'}), 'Update alpha resolution');
    await repo.runGit(['checkout', 'main']);
    try { await repo.runGit(['merge', '--no-ff', 'feature', '-m', 'Merge alpha update']); }
    catch { await commitBoth(repo, {alpha: '2.0.0'}, 'Resolve merge'); }
    const merge = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const result = await runDepBlame({cwd: repo.repoDir, silent: true});
    const alpha = result.events.filter(e => e.package === 'alpha');
    assert.equal(alpha.filter(e => e.type === 'added').length, 2);
    const integrated = alpha.filter(e => e.commitFull === merge);
    assert.equal(integrated.length, 2);
    assert.ok(integrated.every(e => e.type === 'updated' && e.changeOrigin === 'merge-integration'));
  } finally { repo.cleanup(); }
});
