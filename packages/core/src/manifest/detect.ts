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

/**
 * Resolves workspace glob patterns to find child package.json files.
 * Supports `*` (one level) and `**` (recursive) segments.
 */
export function resolveWorkspaceManifests(repoRoot: string, workspaceGlobs: string[]): string[] {
  const manifests = new Set<string>();

  const collectRecursive = (dir: string): void => {
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const pkg = path.join(full, 'package.json');
        if (fs.existsSync(pkg)) {
          manifests.add(toPosixPath(path.relative(repoRoot, pkg)));
        }
        collectRecursive(full);
      }
    }
  };

  for (const pattern of workspaceGlobs) {
    const cleanPattern = pattern.trim();
    if (!cleanPattern || cleanPattern.startsWith('!')) continue;

    // Recursive glob e.g. "packages/**"
    if (cleanPattern.includes('**')) {
      const prefix = cleanPattern.split('**')[0].replace(/\/$/, '');
      const baseDir = prefix ? path.join(repoRoot, prefix) : repoRoot;
      if (fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()) {
        collectRecursive(baseDir);
      }
      continue;
    }

    // Direct match e.g. "packages/core"
    if (!cleanPattern.includes('*')) {
      const candidate = path.join(repoRoot, cleanPattern, 'package.json');
      if (fs.existsSync(candidate)) {
        manifests.add(toPosixPath(path.relative(repoRoot, candidate)));
      }
      continue;
    }

    // Single-star pattern like "packages/*" or "apps/*" (also "packages/*/app")
    const prefix = cleanPattern.replace(/\/\*.*$/, '');
    const parentDir = path.join(repoRoot, prefix);

    if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
      try {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

          if (entry.isDirectory()) {
            const pkgPath = path.join(parentDir, entry.name, 'package.json');
            if (fs.existsSync(pkgPath)) {
              manifests.add(toPosixPath(path.relative(repoRoot, pkgPath)));
            }
          }
        }
      } catch {
        // Skip inaccessible dirs
      }
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
 * Capped and best-effort — never throws.
 */
export async function discoverHistoricManifests(
  repoRoot: string,
  maxPaths = 300
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        '--all',
        '--full-history',
        '--format=',
        '--name-only',
        '--diff-filter=AMR',
        '--',
        'package.json',
        '**/package.json',
        'package-lock.json',
        '**/package-lock.json',
        'pnpm-lock.yaml',
        '**/pnpm-lock.yaml',
        'yarn.lock',
        '**/yarn.lock',
        'bun.lock',
        '**/bun.lock',
        'bun.lockb',
        '**/bun.lockb'
      ],
      { cwd: repoRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );
    const found = new Set<string>();
    for (const line of stdout.split('\n')) {
      const f = line.trim();
      if (!f) continue;
      const base = f.split('/').pop() || '';
      if (!isManifestBasename(base)) continue;
      // Skip absurd paths (submodule dumps, generated fixtures).
      if (f.length > 256 || f.includes('node_modules/.')) continue;
      found.add(f);
      if (found.size >= maxPaths) break;
    }
    return Array.from(found).sort();
  } catch {
    return [];
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
