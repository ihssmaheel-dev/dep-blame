/**
 * Parses package-lock.json content into a normalized Map (supporting v1, v2, and v3).
 *
 * @param content Raw JSON string of package-lock.json
 * @param options Options including directOnly filter
 */
export function parseNpmLockfile(content, options = {}) {
    const { directOnly = true } = options;
    const map = new Map();
    if (!content || typeof content !== 'string') {
        return map;
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return map;
    }
    if (!parsed || typeof parsed !== 'object') {
        return map;
    }
    // Handle v2 & v3 (parsed.packages)
    if (parsed.packages && typeof parsed.packages === 'object') {
        const rootPkg = parsed.packages[''] || {};
        const directNames = new Set();
        const checkRootDeps = (section) => {
            if (section && typeof section === 'object') {
                for (const name of Object.keys(section)) {
                    directNames.add(name);
                }
            }
        };
        checkRootDeps(rootPkg.dependencies);
        checkRootDeps(rootPkg.devDependencies);
        checkRootDeps(rootPkg.peerDependencies);
        checkRootDeps(rootPkg.optionalDependencies);
        for (const [pkgPath, entry] of Object.entries(parsed.packages)) {
            if (pkgPath === '' || !entry || typeof entry !== 'object') {
                continue;
            }
            // Check if it's a top-level node_modules package
            const match = pkgPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/);
            if (match) {
                const name = match[1];
                const isDirect = directNames.has(name);
                if (directOnly && !isDirect) {
                    continue;
                }
                let depType = 'dependencies';
                if (entry.dev)
                    depType = 'devDependencies';
                else if (entry.peer)
                    depType = 'peerDependencies';
                else if (entry.optional)
                    depType = 'optionalDependencies';
                map.set(name, {
                    version: entry.version || '',
                    depType,
                    isDirect
                });
            }
        }
        return map;
    }
    // Handle v1 (parsed.dependencies)
    if (parsed.dependencies && typeof parsed.dependencies === 'object') {
        for (const [name, entry] of Object.entries(parsed.dependencies)) {
            if (!entry || typeof entry !== 'object')
                continue;
            let depType = 'dependencies';
            if (entry.dev)
                depType = 'devDependencies';
            else if (entry.peer)
                depType = 'peerDependencies';
            else if (entry.optional)
                depType = 'optionalDependencies';
            map.set(name, {
                version: entry.version || '',
                depType,
                isDirect: true
            });
        }
    }
    return map;
}
//# sourceMappingURL=npm.js.map