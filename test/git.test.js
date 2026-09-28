import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGit, getRepoRoot, getCurrentHead } from '../packages/core/src/git/repo.js';
import { getManifestCommits } from '../packages/core/src/git/log.js';
import { batchReadBlobs } from '../packages/core/src/git/batch.js';

test('git repo utilities', async () => {
  const hasGit = await checkGit();
  assert.equal(hasGit, true);

  const root = await getRepoRoot();
  assert.ok(root.length > 0);

  const head = await getCurrentHead();
  assert.match(head, /^[0-9a-f]{40}$/);
});

test('git log and batch blob reading', async () => {
  const root = await getRepoRoot();
  const commits = await getManifestCommits(root, { manifestPaths: ['package.json'] });

  assert.ok(commits.length >= 1);
  const firstCommit = commits[0];
  assert.match(firstCommit.commit, /^[0-9a-f]{40}$/);
  assert.ok(firstCommit.date.length > 0);
  assert.ok(firstCommit.author.length > 0);
  assert.ok(firstCommit.files.includes('package.json'));

  const blobs = await batchReadBlobs(root, [
    { commit: firstCommit.commit, path: 'package.json' },
    { commit: firstCommit.commit, path: 'nonexistent-file.json' }
  ]);

  const pkgJsonContent = blobs.get(`${firstCommit.commit}:package.json`);
  assert.ok(pkgJsonContent !== null);
  const parsed = JSON.parse(pkgJsonContent);
  assert.equal(parsed.name, 'dep-blame-monorepo');

  const missingContent = blobs.get(`${firstCommit.commit}:nonexistent-file.json`);
  assert.equal(missingContent, null);
});
