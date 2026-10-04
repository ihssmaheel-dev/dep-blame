import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import type { DetectedPackageManager } from '../types.js';

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

export const KNOWN_MANIFEST_BASENAMES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb'
];

function isManifestBasename(base: string): boolean {
  return KNOWN_MANIFEST_BASENAMES.includes(base);
}

/** Directories never descended into during workspace expansion. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', '.next', '.nuxt']);

/**
 * Converts a glob pattern to a RegExp. Supports `*` (within a segment),
 * `**` (across segments), `?`, and `{a,b}` alternation.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // '**/' matches zero or more directories; trailing '**' matches all.
        if (pattern[i + 2] === '/') {
          re += '(.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
      } else {
        re += '(' + pattern.slice(i + 1, end).split(',').map((s) => globToRegExpSource(s)).join('|') + ')';
        i = end + 1;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function globToRegExpSource(pattern: string): string {
  return globToRegExp(pattern).source.replace(/^\^/, '').replace(/\$$/, '');
}

/**
 * Resolves workspace glob patterns to child package.json manifests.
 * Supports `*` in any segment, `**`, `?`, `{a,b}`, and `!` exclusions
 * (e.g. npm/Yarn `workspaces` and Bun workspace globs).
 */
export function resolveWorkspaceManifests(repoRoot: string, workspaceGlobs: string[]): string[] {
  const inclusions: string[] = [];
  const exclusions: string[] = [];
  for (const raw of workspaceGlobs) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.startsWith('!')) {
      if (pattern.length > 1) exclusions.push(pattern.slice(1));
      continue;
    }
    inclusions.push(pattern);
  }

  const manifests = new Set<string>();
  const visited = new Set<string>();
  const realRoot = fs.realpathSync(repoRoot);
  const isInside = (candidate: string): boolean => {
    try {
      const relative = path.relative(realRoot, fs.realpathSync(candidate));
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    } catch { return false; }
  };

  const expandSegments = (dirAbs: string, segments: string[], segIdx: number): void => {
    if (!isInside(dirAbs)) return;
    const key = `${dirAbs}\0${segments.join('/')}\0${segIdx}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (segIdx >= segments.length) {
      const pkg = path.join(dirAbs, 'package.json');
      if (fs.existsSync(pkg) && isInside(pkg)) {
        manifests.add(toPosixPath(path.relative(repoRoot, pkg)));
      }
      return;
    }
    const seg = segments[segIdx];
    if (seg === '**') {
      // Zero directories.
      expandSegments(dirAbs, segments, segIdx + 1);
      // One or more directories.
      let entries: any[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = path.join(dirAbs, entry.name);
        expandSegments(full, segments, segIdx);
      }
      return;
    }
    if (seg.includes('*') || seg.includes('?') || (seg.includes('{') && seg.includes('}'))) {
      const rx = globToRegExp(seg);
      let entries: any[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (!rx.test(entry.name)) continue;
        expandSegments(path.join(dirAbs, entry.name), segments, segIdx + 1);
      }
      return;
    }
    const next = path.join(dirAbs, seg);
    try {
      if (fs.statSync(next).isDirectory()) expandSegments(next, segments, segIdx + 1);
    } catch { /* A workspace may disappear while being inspected. */ }
  };

  for (const pattern of inclusions) {
    const segments = pattern.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    // A trailing package.json/file segment targets the file's directory.
    const last = segments[segments.length - 1];
    if (last === 'package.json') {
      const dirSegs = segments.slice(0, -1);
      if (dirSegs.length === 0) {
        manifests.add('package.json');
      } else {
        expandSegments(repoRoot, dirSegs, 0);
      }
      continue;
    }
    expandSegments(repoRoot, segments, 0);
  }

  if (exclusions.length > 0) {
    const rxList = exclusions.map(globToRegExp);
    const matchesExclusion = (manifest: string): boolean => {
      const dir = manifest.endsWith('/package.json') ? manifest.slice(0, -'/package.json'.length) : manifest;
      return rxList.some((rx) => rx.test(manifest) || rx.test(dir));
    };
    for (const m of Array.from(manifests)) {
      if (matchesExclusion(m)) manifests.delete(m);
    }
  }

  return Array.from(manifests).sort();
}

/**
 * Detects the package manager and manifest files in the repo.
 */
export function detectPackageManager(repoRoot: string): DetectedPackageManager {
  const fileExists = (relPath: string) => fs.existsSync(path.join(repoRoot, relPath));

  let packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' = 'npm';
  let lockfile: string | null = null;

  if (fileExists('bun.lock') || fileExists('bun.lockb')) {
    packageManager = 'bun';
    lockfile = fileExists('bun.lock') ? 'bun.lock' : 'bun.lockb';
  } else if (fileExists('pnpm-lock.yaml')) {
    packageManager = 'pnpm';
    lockfile = 'pnpm-lock.yaml';
  } else if (fileExists('yarn.lock')) {
    packageManager = 'yarn';
    lockfile = 'yarn.lock';
  } else if (fileExists('package-lock.json')) {
    packageManager = 'npm';
    lockfile = 'package-lock.json';
  } else {
    packageManager = 'npm';
  }

  // Detect monorepo / workspaces
  let isMonorepo = false;
  const workspaceGlobs: string[] = [];

  const pnpmWorkspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspacePath)) {
    isMonorepo = true;
    try {
      const raw = fs.readFileSync(pnpmWorkspacePath, 'utf8');
      const lines = raw.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('-')) {
          const glob = trimmed.replace(/^-\s*['"]?/, '').replace(/['"]?$/, '').trim();
          if (glob) workspaceGlobs.push(glob);
        }
      }
    } catch {
      // Ignore
    }
  }

  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const raw = fs.readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.workspaces) {
        isMonorepo = true;
        if (Array.isArray(parsed.workspaces)) {
          workspaceGlobs.push(...parsed.workspaces);
        } else if (Array.isArray(parsed.workspaces.packages)) {
          workspaceGlobs.push(...parsed.workspaces.packages);
        }
      }
    } catch {
      // Ignore
    }
  }

  if (fileExists('turbo.json') || fileExists('nx.json') || fileExists('lerna.json')) {
    isMonorepo = true;
  }

  const manifestPaths = ['package.json'];
  if (lockfile) {
    manifestPaths.push(lockfile);
  }

  if (isMonorepo && workspaceGlobs.length > 0) {
    const workspaceManifests = resolveWorkspaceManifests(repoRoot, workspaceGlobs);
    for (const wm of workspaceManifests) {
      if (!manifestPaths.includes(wm)) {
        manifestPaths.push(wm);
      }
    }
  }

  return {
    packageManager,
    lockfile,
    manifestPaths,
    isMonorepo,
    workspaceGlobs
  };
}

/**
 * Discovers every manifest path that ever existed in history.
 * Fixes HEAD-only detection: a workspace deleted before HEAD would
 * otherwise vanish from `git log -- <paths>` entirely.
 *
 * Never throws; reports truncation and scan errors so callers can
 * surface completeness instead of presenting partial history as fact.
 */
export interface HistoricDiscovery {
  paths: string[];
  /** True when the path cap cut discovery short. */
  truncated: boolean;
  /** Set when the git scan itself failed (history treated as HEAD-only). */
  error?: string;
}

export async function discoverHistoricManifests(
  repoRoot: string,
  maxPaths = 300,
  range?: string,
  onProgress?: (found: number) => void
): Promise<HistoricDiscovery> {
  // Streamed (not buffered): full-history walks on huge repositories emit
  // tens of megabytes of paths. Buffering that in one execFile both hides
  // progress for the whole walk and risks maxBuffer failure; streaming
  // reports live counts, has no buffer cap, and exits early on the path cap.
  const args = [
    'log',
    ...(range ? [range] : ['--all']),
    '--full-history',
    '--format=',
    '--name-only',
    '-z',
    '--diff-filter=AMR',
    '--',
    '*package.json',
    '*package-lock.json',
    '*pnpm-lock.yaml',
    '*yarn.lock',
    '*bun.lock*'
  ];
  // Pathological guard: never retain more than this from one discovery walk.
  const MAX_STREAM_BYTES = 128 * 1024 * 1024;
  return new Promise((resolve) => {
    const found = new Set<string>();
    let truncated = false;
    let skippedLong = 0;
    let settled = false;
    let stderr = '';
    let streamedBytes = 0;
    let pending = '';
    let lastEmit = 0;
    const finish = (result: HistoricDiscovery) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already exited */ }
      resolve(result);
    };
    const emit = () => {
      const now = Date.now();
      if (onProgress && now - lastEmit > 500) {
        lastEmit = now;
        try { onProgress(found.size); } catch { /* progress must never break scans */ }
      }
    };
    const consider = (f: string): void => {
      if (!f) return;
      const base = f.split('/').pop() || '';
      if (!isManifestBasename(base)) return;
      // Skip absurd paths (submodule dumps, generated fixtures) but record
      // it so callers surface incompleteness instead of silent partial history.
      // Match any node_modules segment (not just `node_modules/.`).
      if (f.split('/').includes('node_modules')) return;
      if (f.length > 256) { skippedLong++; return; }
      found.add(f);
      if (found.size >= maxPaths) {
        truncated = true;
        onProgress?.(found.size);
        finish({ paths: Array.from(found).sort(), truncated: true });
        return;
      }
      if (found.size % 500 === 0) emit();
    };
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    child = spawn('git', args, { cwd: repoRoot, windowsHide: true });
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_STREAM_BYTES) {
        truncated = true;
        finish({ paths: Array.from(found).sort(), truncated, error: 'manifest discovery exceeded its 128 MiB scan cap' });
        return;
      }
      pending += decoder.write(chunk);
      let pos: number;
      while ((pos = pending.indexOf('\0')) !== -1) {
        consider(pending.slice(0, pos));
        if (settled) return;
        pending = pending.slice(pos + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      finish({ paths: [], truncated: false, error: (err as Error)?.message || 'git log failed' });
    });
    child.on('close', (code) => {
      if (settled) return;
      try {
        pending += decoder.end();
        for (const f of pending.split('\0')) consider(f);
        if (settled) return;
        if (code !== 0) {
          finish({ paths: [], truncated: false, error: stderr.trim() || 'git log exited with code ' + code });
          return;
        }
      } catch (err: any) {
        finish({ paths: [], truncated: false, error: err?.message || 'git log failed' });
        return;
      }
      if (skippedLong > 0) truncated = true;
      onProgress?.(found.size);
      finish({ paths: Array.from(found).sort(), truncated });
    });
  });
}

/**
 * Merges HEAD-detected paths with historic paths.
 * Current filesystem wins ordering; historic-only paths appended.
 */
export function mergeManifestPaths(current: string[], historic: string[]): string[] {
  const seen = new Set(current);
  const out = [...current];
  for (const h of historic) {
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}
