import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCiSummary } from '../packages/core/src/render/ci.js';
import { createTestRepo } from './helpers/git-fixture.js';
import { resolveBaseRef } from '../packages/core/src/git/repo.js';

test('ci: renderCiSummary generates compact diff summary', () => {
  const events = [
    {
      package: 'react',
      type: 'added',
      to: '19.0.0',
      manifest: 'package.json'
    },
    {
      package: 'lodash',
      type: 'updated',
      from: '4.17.20',
      to: '4.17.21',
      manifest: 'package.json'
    },
    {
      package: 'moment',
      type: 'removed',
      from: '2.29.4',
      manifest: 'package.json'
    }
  ];

  const summary = renderCiSummary(events, 'origin/main');
  assert.ok(summary.includes('dep-blame CI Summary (vs origin/main)'));
  assert.ok(summary.includes('+ added   react'));
  assert.ok(summary.includes('↑ updated lodash'));
  assert.ok(summary.includes('- removed moment'));
  assert.ok(summary.includes('1 added, 1 updated, 1 removed'));
});

test('ci: resolveBaseRef resolves ancestor commit for branch diffs', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', { name: 'app' }, 'initial commit');
    await repo.runGit(['branch', 'feature']);
    await repo.commitFile('package.json', { name: 'app', dependencies: { chalk: '5.0.0' } }, 'commit on main');

    await repo.runGit(['checkout', 'feature']);
    await repo.commitFile('package.json', { name: 'app', dependencies: { chalk: '5.1.0' } }, 'commit on feature');

    const resolved = await resolveBaseRef('main', repo.repoDir);
    assert.equal(resolved.baseRef, 'main');
    assert.ok(resolved.baseSha);
  } finally {
    repo.cleanup();
  }
});
