import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGit, getRepoRoot, getCurrentHead } from '../packages/core/dist/git/repo.js';
import { getManifestCommits } from '../packages/core/dist/git/log.js';
import fs from 'node:fs';
import path from 'node:path';
import { batchReadBlobs, streamReadBlobs } from '../packages/core/dist/git/batch.js';
import { createTestRepo } from './helpers/git-fixture.js';

test('git repo utilities', async () => {
  const hasGit = await checkGit();
  assert.equal(hasGit, true);

  const root = await getRepoRoot();
  assert.ok(root.length > 0);

  const head = await getCurrentHead();
  assert.match(head, /^[0-9a-f]{40}$/);
});

test('streamed Git blobs preserve Unicode, empty and missing files, duplicates, and request backpressure', async () => {
  const repo = await createTestRepo();
  try {
    const content = 'é漢🙂'.repeat(20000);
    await repo.commitFile('café demo.txt', content, 'unicode blob');
    await repo.commitFile('empty.txt', '', 'empty blob');
    const sha = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const request = { commit: sha, path: 'café demo.txt' };
    // Enough request bytes to exercise stdin drain while stdout is consumed.
    const missing = Array.from({ length: 4500 }, (_, i) => ({ commit: sha, path: `missing-${i}.txt` }));
    const seen = new Set();
    for await (const blob of streamReadBlobs(repo.repoDir, [request, request, { commit: sha, path: 'empty.txt' }, ...missing])) {
      assert.ok(!seen.has(blob.request.path));
      seen.add(blob.request.path);
      if (blob.request.path === request.path) {
        assert.equal(blob.content, content);
        assert.match(blob.oid, /^[0-9a-f]{40}$/);
        await new Promise(resolve => setTimeout(resolve, 20));
      } else if (blob.request.path === 'empty.txt') {
        assert.equal(blob.content, '');
      } else {
        assert.equal(blob.content, null);
        assert.equal(blob.oid, undefined);
      }
    }
    assert.equal(seen.size, 4502);
    const empty = [];
    for await (const blob of streamReadBlobs(repo.repoDir, [])) empty.push(blob);
    assert.deepEqual(empty, []);
    for (const bad of [{ commit: 'HEAD', path: 'empty.txt' }, { commit: sha, path: 'bad\npath' }]) {
      await assert.rejects(async () => { for await (const blob of streamReadBlobs(repo.repoDir, [bad])) void blob; }, /Invalid blob request/);
    }
  } finally { repo.cleanup(); }
});

test('streamed Git blobs close on early cancellation and consumer errors', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('blob.txt', 'x'.repeat(2 * 1024 * 1024), 'blob');
    const sha = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const requests = [{ commit: sha, path: 'blob.txt' }, ...Array.from({ length: 5000 }, (_, i) => ({ commit: sha, path: `missing-${i}` }))];
    const reader = streamReadBlobs(repo.repoDir, requests);
    assert.equal((await reader.next()).value.content.length, 2 * 1024 * 1024);
    assert.equal((await reader.return()).done, true);
    await assert.rejects(async () => {
      for await (const blob of streamReadBlobs(repo.repoDir, requests)) {
        assert.ok(blob.content);
        throw new Error('consumer failed');
      }
    }, /consumer failed/);
    // A fresh read still succeeds after both abort paths close their process.
    assert.equal((await batchReadBlobs(repo.repoDir, requests.slice(0, 1))).get(`${sha}:blob.txt`).length, 2 * 1024 * 1024);
  } finally { repo.cleanup(); }
});

test('streamed Git blobs reject an oversized single object before allocating its body', async () => {
  const repo = await createTestRepo();
  try {
    const target = path.join(repo.repoDir, 'oversized.txt');
    const fd = fs.openSync(target, 'w');
    try {
      const block = Buffer.alloc(1024 * 1024, 120);
      for (let i = 0; i < 65; i++) fs.writeSync(fd, block);
    } finally { fs.closeSync(fd); }
    await repo.runGit(['add', 'oversized.txt']);
    await repo.runGit(['commit', '-m', 'oversized single blob']);
    const sha = (await repo.runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const requests = [{ commit: sha, path: 'oversized.txt' }];
    await assert.rejects(async () => {
      for await (const blob of streamReadBlobs(repo.repoDir, requests)) void blob;
    }, /Manifest blob exceeds the 64 MiB safety limit: oversized\.txt at [0-9a-f]{7}/);
    await assert.rejects(batchReadBlobs(repo.repoDir, requests), /Manifest blob exceeds the 64 MiB safety limit/);
  } finally { repo.cleanup(); }
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
