export const DEP_TYPES = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
];
/**
 * Parses a package.json content string into a normalized Map of dependencies.
 *
 * @param content Raw JSON string of package.json
 * @returns Map of package name to version & type
 */
export function parsePackageJson(content) {
    const map = new Map();
    if (!content || typeof content !== 'string') {
        return map;
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        // Return empty map on invalid/corrupted JSON
        return map;
    }
    if (!parsed || typeof parsed !== 'object') {
        return map;
    }
    for (const depType of DEP_TYPES) {
        const section = parsed[depType];
        if (section && typeof section === 'object') {
            for (const [name, version] of Object.entries(section)) {
                if (typeof version === 'string' && name.trim().length > 0) {
                    map.set(name.trim(), {
                        version: version.trim(),
                        depType,
                        isDirect: true
                    });
                }
            }
        }
    }
    return map;
}
//# sourceMappingURL=package-json.js.map