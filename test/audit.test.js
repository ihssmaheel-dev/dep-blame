import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestRepo } from './helpers/git-fixture.js';
import { runDepBlame } from '../packages/core/dist/engine.js';
import { getCommitsInRange } from '../packages/core/dist/git/repo.js';
import { JsonStore } from '../packages/core/dist/cache/json-store.js';
import { resolveWorkspaceManifests } from '../packages/core/dist/manifest/detect.js';
import { renderCsv } from '../packages/core/dist/render/csv.js';

const execFileAsync = promisify(execFile);
const pkg = (deps) => ({ name: 'app', dependencies: deps });

// --- Audit #1: merged histories -------------------------------------------

test('audit: merge reports what the merge introduced, no false removals', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ a: '1.0.0' }), 'base: add a');
    await repo.runGit(['branch', 'feature']);
    await repo.commitFile('package.json', pkg({ a: '1.0.0', c: '1.0.0' }), 'main: add c');
    await repo.runGit(['checkout', 'feature']);
    await repo.commitFile('package.json', pkg({ a: '1.0.0', b: '1.0.0' }), 'feature: add b');
    await repo.runGit(['checkout', 'main']);
    try {
      await repo.runGit(['merge', '--no-ff', 'feature', '-m', 'merge feature']);
    } catch {
      // Both sides edited adjacent JSON lines: resolve like a developer would.
      await repo.commitFile('package.json', pkg({ a: '1.0.0', b: '1.0.0', c: '1.0.0' }), 'merge feature');
    }

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const removedB = res.events.filter((e) => e.package === 'b' && e.type === 'removed');
    assert.equal(removedB.length, 0, 'merge must not report removing b');

    // Final manifest really contains a, b, c.
    const heads = (res.headState || []).map((h) => h.package).sort();
    assert.deepEqual(heads, ['a', 'b', 'c']);

    // Incremental rescan after the merge adds nothing.
    const again = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(again.events.length, res.events.length);
    assert.equal(again.cached, true);
  } finally {
    repo.cleanup();
  }
});

// --- Audit #2: corrupt manifests ------------------------------------------

test('audit: corrupt manifest keeps last-good state, no invented churn', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ alpha: '1.0.0' }), 'add alpha 1');
    await repo.commitFile('package.json', '{ broken json', 'corrupt manifest');
    await repo.commitFile('package.json', pkg({ alpha: '2.0.0' }), 'fix to alpha 2');

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const alpha = res.events.filter((e) => e.package === 'alpha');
    assert.equal(
      alpha.filter((e) => e.type === 'removed').length,
      0,
      'corrupt blob must not invent a removal'
    );
    const updates = alpha.filter((e) => e.type === 'updated');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].from, '1.0.0');
    assert.equal(updates[0].to, '2.0.0');
    assert.ok(res.warnings.length > 0, 'corrupt blob must produce a warning');
    assert.ok(res.warnings.some((w) => w.includes('package.json')));
  } finally {
    repo.cleanup();
  }
});

// --- Audit #3: no-cache + interrupted scans --------------------------------

test('audit: --no-cache never duplicates results', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ solo: '1.0.0' }), 'add solo');

    const first = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(first.events.length, 1);

    const noCache = await runDepBlame({ cwd: repo.repoDir, silent: true, noCache: true });
    assert.equal(noCache.events.length, 1);

    const after = await runDepBlame({ cwd: repo.repoDir, silent: true });
    assert.equal(after.events.length, 1);
  } finally {
    repo.cleanup();
  }
});

// --- Audit #5: lockfiles ---------------------------------------------------

test('audit: lockfile committed alone is resolved, not a re-add', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ leftpad: '^1.0.0' }), 'declare leftpad');
    await repo.commitFile(
      'package-lock.json',
      {
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { leftpad: '^1.0.0' } },
          'node_modules/leftpad': { version: '1.3.0' }
        }
      },
      'add lockfile'
    );

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const manifestAdds = res.events.filter((e) => e.package === 'leftpad' && e.source === 'manifest' && e.type === 'added');
    assert.equal(manifestAdds.length, 1);
    const lockAdds = res.events.filter((e) => e.package === 'leftpad' && e.source === 'lockfile');
    for (const e of lockAdds) {
      assert.equal(e.manifest, 'package-lock.json');
    }
  } finally {
    repo.cleanup();
  }
});

test('audit: lockfile deletion emits no removals, warns instead', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ leftpad: '^1.0.0' }), 'declare leftpad');
    await repo.commitFile(
      'package-lock.json',
      {
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { leftpad: '^1.0.0' } },
          'node_modules/leftpad': { version: '1.3.0' }
        }
      },
      'add lockfile'
    );
    await repo.runGit(['rm', 'package-lock.json']);
    await repo.runGit(['commit', '-m', 'drop lockfile']);

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const removals = res.events.filter((e) => e.type === 'removed');
    assert.equal(removals.length, 0);
    assert.ok(res.warnings.some((w) => w.includes('package-lock.json')));
  } finally {
    repo.cleanup();
  }
});

// --- Audit #6: CI ranges ----------------------------------------------------

test('audit: empty range is empty, bad base is null', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ a: '1.0.0' }), 'add a');
    const { stdout } = await repo.runGit(['rev-parse', 'HEAD']);
    const head = stdout.trim();

    const empty = await getCommitsInRange(head, repo.repoDir, []);
    assert.ok(empty instanceof Set);
    assert.equal(empty.size, 0);

    const bad = await getCommitsInRange('deadbeef', repo.repoDir, []);
    assert.equal(bad, null);
  } finally {
    repo.cleanup();
  }
});

test('audit: ci --since HEAD reports no changes', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', pkg({ a: '1.0.0' }), 'add a');
    const { stdout } = await repo.runGit(['rev-parse', 'HEAD']);
    const head = stdout.trim();
    const cli = path.resolve('packages/core/bin/cli.js');
    const { stdout: out } = await execFileAsync(process.execPath, [cli, 'ci', '--since', head, '--json'], {
      cwd: repo.repoDir,
      windowsHide: true
    });
    const data = JSON.parse(out);
    assert.equal(data.events.length, 0);
  } finally {
    repo.cleanup();
  }
});

// --- Audit: pnpm workspace importers ---------------------------------------

test('audit: pnpm workspace deps attributed per importer', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', { name: 'root', private: true }, 'root');
    await repo.commitFile(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .: {}',
        '  packages/app:',
        '    dependencies:',
        '      b:',
        '        specifier: ^2.0.0',
        '        version: 2.0.1',
        ''
      ].join('\n'),
      'pnpm: add b in app'
    );

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const b = res.events.find((e) => e.package === 'b');
    assert.ok(b, 'workspace importer dep must not disappear');
    assert.equal(b.manifest, 'packages/app/package.json');
    assert.equal(b.source, 'lockfile');
  } finally {
    repo.cleanup();
  }
});

// --- Audit mediums ----------------------------------------------------------

test('audit: depType move is an explicit updated event', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile(
      'package.json',
      { name: 'app', dependencies: { mover: '1.0.0' } },
      'mover as dep'
    );
    await repo.commitFile(
      'package.json',
      { name: 'app', devDependencies: { mover: '1.0.0' } },
      'mover to devDeps'
    );

    const res = await runDepBlame({ cwd: repo.repoDir, silent: true });
    const moves = res.events.filter((e) => e.package === 'mover' && e.type === 'updated');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].depTypeFrom, 'dependencies');
    assert.equal(moves[0].depType, 'devDependencies');
  } finally {
    repo.cleanup();
  }
});

test('audit: workspace globs support exclusions and mid-segment stars', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-glob-'));
  try {
    for (const d of ['packages/a', 'packages/b', 'packages/web/app', 'packages/skip']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
      fs.writeFileSync(path.join(dir, d, 'package.json'), JSON.stringify({ name: d }), 'utf8');
    }
    const found = resolveWorkspaceManifests(dir, ['packages/*', 'packages/*/app', '!packages/skip']);
    assert.ok(found.includes('packages/a/package.json'));
    assert.ok(found.includes('packages/web/app/package.json'));
    assert.ok(!found.includes('packages/skip/package.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit: since-filter compares instants, not strings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-date-'));
  try {
    const store = new JsonStore(path.join(dir, 'cache.json'));
    store.insertEvents([
      {
        package: 'late',
        type: 'added',
        to: '1.0.0',
        date: '2026-01-01T00:30:00+05:30',
        commit: 'abc1234',
        author: 'A',
        message: 'm',
        manifest: 'package.json',
        depType: 'dependencies',
        source: 'manifest'
      }
    ]);
    // 00:30+05:30 == 2025-12-31T19:00Z, before midnight UTC.
    assert.equal(store.queryEvents({ since: '2026-01-01T00:00:00Z' }).length, 0);
    assert.equal(store.queryEvents({ since: '2025-12-31T19:00:00Z' }).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit: workspace filter matches segments, not substrings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-ws-'));
  try {
    const store = new JsonStore(path.join(dir, 'cache.json'));
    const ev = (manifest) => ({
      package: 'p',
      type: 'added',
      to: '1.0.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      author: 'A',
      message: 'm',
      manifest,
      depType: 'dependencies',
      source: 'manifest'
    });
    store.insertEvents([ev('apps/web/package.json'), ev('apps/website/package.json')]);
    const res = store.queryEvents({ workspace: 'web' });
    assert.equal(res.length, 1);
    assert.equal(res[0].manifest, 'apps/web/package.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit: CSV export quotes correctly', async () => {
  const csv = renderCsv([
    {
      package: 'weird"name',
      type: 'added',
      to: '1.0.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      commitFull: 'abc1234def5678',
      author: 'A',
      message: 'say "hi", bye',
      manifest: 'package.json',
      depType: 'dependencies',
      source: 'manifest'
    }
  ]);
  assert.ok(csv.includes('"weird""name"'));
  assert.ok(csv.includes('"say ""hi"", bye"'));
});
