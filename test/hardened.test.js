import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame } from '../packages/core/dist/engine.js';
import { batchReadBlobs } from '../packages/core/dist/git/batch.js';

test('hardening: --clear-cache clears cache and re-indexes cleanly', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile(
      'package.json',
      {
        name: 'test-app',
        dependencies: { chalk: '4.0.0' }
      },
      'feat: add chalk'
    );

    // Initial run (populates cache)
    const run1 = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(run1.cached, false);
    assert.equal(run1.events.length, 1);

    // Warm cache run
    const run2 = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(run2.cached, true);
    assert.equal(run2.events.length, 1);

    // Run with clearCache: true
    const run3 = await runDepBlame({ cwd: repo.repoDir, clearCache: true, silent: true });
    assert.equal(run3.cached, false);
    assert.equal(run3.events.length, 1);
  } finally {
    repo.cleanup();
  }
});

test('hardening: filters by workspace path and directOnly', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile(
      'package.json',
      {
        name: 'monorepo',
        private: true,
        workspaces: ['apps/*']
      },
      'monorepo init'
    );

    await repo.commitFile(
      'apps/web/package.json',
      {
        name: 'web',
        dependencies: { next: '14.0.0' }
      },
      'feat: add next to web'
    );

    await repo.commitFile(
      'apps/docs/package.json',
      {
        name: 'docs',
        dependencies: { astro: '4.0.0' }
      },
      'feat: add astro to docs'
    );

    // Filter by workspace: web
    const webOnly = await runDepBlame({
      cwd: repo.repoDir,
      silent: true,
      filter: { workspace: 'web' }
    });
    assert.equal(webOnly.events.length, 1);
    assert.equal(webOnly.events[0].package, 'next');

    // Filter by directOnly
    const directOnly = await runDepBlame({
      cwd: repo.repoDir,
      silent: true,
      filter: { directOnly: true }
    });
    assert.equal(directOnly.events.length, 2);
  } finally {
    repo.cleanup();
  }
});

test('hardening: batchReadBlobs safely handles empty requests and missing files', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', { name: 'app' }, 'init');
    const { stdout } = await repo.runGit(['rev-parse', 'HEAD']);
    const head = stdout.trim();

    // Empty array
    const emptyMap = await batchReadBlobs(repo.repoDir, []);
    assert.equal(emptyMap.size, 0);

    // Missing file returns null without error
    const map = await batchReadBlobs(repo.repoDir, [
      { commit: head, path: 'package.json' },
      { commit: head, path: 'missing-file.txt' }
    ]);

    assert.ok(map.get(`${head}:package.json`));
    assert.equal(map.get(`${head}:missing-file.txt`), null);
  } finally {
    repo.cleanup();
  }
});
