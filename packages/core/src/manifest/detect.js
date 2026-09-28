import fs from 'node:fs';
import path from 'node:path';

/**
 * Detects the package manager and manifest files in the repo.
 *
 * @param {string} repoRoot Path to git repository root
 * @returns {{
 *   packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun',
 *   lockfile: string | null,
 *   manifestPaths: string[],
 *   isMonorepo: boolean,
 *   workspaceGlobs: string[]
 * }}
 */
export function detectPackageManager(repoRoot) {
  const fileExists = (relPath) => fs.existsSync(path.join(repoRoot, relPath));

  let packageManager = 'npm';
  let lockfile = null;

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
  let workspaceGlobs = [];

  if (fileExists('pnpm-workspace.yaml') || fileExists('turbo.json') || fileExists('nx.json') || fileExists('lerna.json')) {
    isMonorepo = true;
  }

  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const raw = fs.readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.workspaces) {
        isMonorepo = true;
        if (Array.isArray(parsed.workspaces)) {
          workspaceGlobs = parsed.workspaces;
        } else if (Array.isArray(parsed.workspaces.packages)) {
          workspaceGlobs = parsed.workspaces.packages;
        }
      }
    } catch {
      // Ignore invalid JSON in root
    }
  }

  const manifestPaths = ['package.json'];
  if (lockfile) {
    manifestPaths.push(lockfile);
  }

  return {
    packageManager,
    lockfile,
    manifestPaths,
    isMonorepo,
    workspaceGlobs
  };
}
