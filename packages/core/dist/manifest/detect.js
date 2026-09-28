import fs from 'node:fs';
import path from 'node:path';
function toPosixPath(p) {
    return p.split(path.sep).join('/');
}
/**
 * Resolves workspace glob patterns to find child package.json files.
 */
export function resolveWorkspaceManifests(repoRoot, workspaceGlobs) {
    const manifests = new Set();
    for (const pattern of workspaceGlobs) {
        const cleanPattern = pattern.trim();
        if (!cleanPattern || cleanPattern.startsWith('!'))
            continue;
        // Direct match e.g. "packages/core"
        if (!cleanPattern.includes('*')) {
            const candidate = path.join(repoRoot, cleanPattern, 'package.json');
            if (fs.existsSync(candidate)) {
                manifests.add(toPosixPath(path.relative(repoRoot, candidate)));
            }
            continue;
        }
        // Pattern like "packages/*" or "apps/*"
        const prefix = cleanPattern.replace(/\/\*.*$/, '');
        const parentDir = path.join(repoRoot, prefix);
        if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
            try {
                const entries = fs.readdirSync(parentDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === 'node_modules' || entry.name.startsWith('.'))
                        continue;
                    if (entry.isDirectory()) {
                        const pkgPath = path.join(parentDir, entry.name, 'package.json');
                        if (fs.existsSync(pkgPath)) {
                            manifests.add(toPosixPath(path.relative(repoRoot, pkgPath)));
                        }
                    }
                }
            }
            catch {
                // Skip inaccessible dirs
            }
        }
    }
    return Array.from(manifests).sort();
}
/**
 * Detects the package manager and manifest files in the repo.
 */
export function detectPackageManager(repoRoot) {
    const fileExists = (relPath) => fs.existsSync(path.join(repoRoot, relPath));
    let packageManager = 'npm';
    let lockfile = null;
    if (fileExists('bun.lock') || fileExists('bun.lockb')) {
        packageManager = 'bun';
        lockfile = fileExists('bun.lock') ? 'bun.lock' : 'bun.lockb';
    }
    else if (fileExists('pnpm-lock.yaml')) {
        packageManager = 'pnpm';
        lockfile = 'pnpm-lock.yaml';
    }
    else if (fileExists('yarn.lock')) {
        packageManager = 'yarn';
        lockfile = 'yarn.lock';
    }
    else if (fileExists('package-lock.json')) {
        packageManager = 'npm';
        lockfile = 'package-lock.json';
    }
    else {
        packageManager = 'npm';
    }
    // Detect monorepo / workspaces
    let isMonorepo = false;
    const workspaceGlobs = [];
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
                    if (glob)
                        workspaceGlobs.push(glob);
                }
            }
        }
        catch {
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
                }
                else if (Array.isArray(parsed.workspaces.packages)) {
                    workspaceGlobs.push(...parsed.workspaces.packages);
                }
            }
        }
        catch {
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
//# sourceMappingURL=detect.js.map