import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectedPackageManager } from '../types.js';

const execFileAsync = promisify(execFile);

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
  range?: string
): Promise<HistoricDiscovery> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
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
      ],
      { cwd: repoRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );
    const found = new Set<string>();
    let truncated = false;
    let skippedLong = 0;
    for (const f of stdout.split('\0')) {
      if (!f) continue;
      const base = f.split('/').pop() || '';
      if (!isManifestBasename(base)) continue;
      // Skip absurd paths (submodule dumps, generated fixtures) but record
      // it so callers surface incompleteness instead of silent partial history.
      // Match any node_modules segment (not just `node_modules/.`).
      const segments = f.split('/');
      if (segments.includes('node_modules')) continue;
      if (f.length > 256) { skippedLong++; continue; }
      found.add(f);
      if (found.size >= maxPaths) {
        truncated = true;
        break;
      }
    }
    if (skippedLong > 0) truncated = true;
    return { paths: Array.from(found).sort(), truncated };
  } catch (err: any) {
    return { paths: [], truncated: false, error: err?.message || 'git log failed' };
  }
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
