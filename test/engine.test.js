import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame } from '../packages/core/src/engine.js';

test('engine: adds, updates, and removes dependencies in real git history', async () => {
  const repo = await createTestRepo();
  try {
    // 1. Initial commit: add lodash
    await repo.commitFile(
      'package.json',
      {
        name: 'test-app',
        dependencies: {
          lodash: '^4.17.20'
        }
      },
      'feat: add lodash'
    );

    // 2. Second commit: bump lodash, add react
    await repo.commitFile(
      'package.json',
      {
        name: 'test-app',
        dependencies: {
          lodash: '^4.17.21',
          react: '^18.2.0'
        }
      },
      'feat: bump lodash and add react'
    );

    // 3. Third commit: remove lodash
    await repo.commitFile(
      'package.json',
      {
        name: 'test-app',
        dependencies: {
          react: '^18.2.0'
        }
      },
      'chore: remove lodash'
    );

    // Run engine
    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(res.events.length, 4);

    // Event 1: lodash added
    assert.equal(res.events[0].package, 'lodash');
    assert.equal(res.events[0].type, 'added');
    assert.equal(res.events[0].to, '^4.17.20');

    // Event 2: lodash updated
    assert.equal(res.events[1].package, 'lodash');
    assert.equal(res.events[1].type, 'updated');
    assert.equal(res.events[1].from, '^4.17.20');
    assert.equal(res.events[1].to, '^4.17.21');

    // Event 3: react added
    assert.equal(res.events[2].package, 'react');
    assert.equal(res.events[2].type, 'added');
    assert.equal(res.events[2].to, '^18.2.0');

    // Event 4: lodash removed
    assert.equal(res.events[3].package, 'lodash');
    assert.equal(res.events[3].type, 'removed');
    assert.equal(res.events[3].from, '^4.17.21');

    // Test incremental scan (warm cache)
    const warmRes = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(warmRes.events.length, 4);

    // Append new commit: add vue
    await repo.commitFile(
      'package.json',
      {
        name: 'test-app',
        dependencies: {
          react: '^18.2.0',
          vue: '^3.3.0'
        }
      },
      'feat: add vue'
    );

    // Run engine incrementally
    const deltaRes = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(deltaRes.events.length, 5);
    const lastEvent = deltaRes.events[4];
    assert.equal(lastEvent.package, 'vue');
    assert.equal(lastEvent.type, 'added');
    assert.equal(lastEvent.to, '^3.3.0');

    // Test filtering by package
    const pkgFiltered = await runDepBlame({
      cwd: repo.repoDir,
      silent: true,
      filter: { package: 'react' }
    });
    assert.equal(pkgFiltered.events.length, 1);
    assert.equal(pkgFiltered.events[0].package, 'react');

    // Test filtering by type
    const typeFiltered = await runDepBlame({
      cwd: repo.repoDir,
      silent: true,
      filter: { type: 'removed' }
    });
    assert.equal(typeFiltered.events.length, 1);
    assert.equal(typeFiltered.events[0].package, 'lodash');
  } finally {
    repo.cleanup();
  }
});

test('engine: handles invalid/corrupted JSON commit gracefully without crashing', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile(
      'package.json',
      {
        name: 'app',
        dependencies: { express: '4.18.2' }
      },
      'initial valid commit'
    );

    // Corrupted commit
    await repo.commitFile(
      'package.json',
      '{ invalid json here, missing quotes }',
      'corrupted commit'
    );

    // Valid recovery commit
    await repo.commitFile(
      'package.json',
      {
        name: 'app',
        dependencies: { express: '4.19.0' }
      },
      'fix corrupted package.json'
    );

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    // Should successfully parse events around the corrupted commit
    assert.ok(res.events.length >= 1);
  } finally {
    repo.cleanup();
  }
});
