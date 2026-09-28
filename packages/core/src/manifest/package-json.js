/**
 * Normalizes dependency types.
 */
export const DEP_TYPES = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
];

/**
 * Parses a package.json content string into a normalized Map of dependencies.
 *
 * @param {string} content Raw JSON string of package.json
 * @returns {Map<string, { version: string, depType: string }>} Map of package name to version & type
 */
export function parsePackageJson(content) {
  const map = new Map();
  if (!content || typeof content !== 'string') {
    return map;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Return empty map on invalid JSON (corrupted commit in history)
    return map;
  }

  if (!parsed || typeof parsed !== 'object') {
    return map;
  }

  for (const depType of DEP_TYPES) {
    const section = parsed[depType];
    if (section && typeof section === 'object') {
      for (const [name, version] of Object.entries(section)) {
        if (typeof version === 'string') {
          map.set(name, {
            version,
            depType
          });
        }
      }
    }
  }

  return map;
}
