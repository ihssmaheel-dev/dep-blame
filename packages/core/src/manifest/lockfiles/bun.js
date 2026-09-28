/**
 * Strips comments and trailing commas from JSONC-style strings.
 */
function cleanJsonc(text) {
  // Remove single-line comments //...
  let cleaned = text.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments /* ... */
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  return cleaned;
}

/**
 * Parses bun.lock into a normalized Map of dependencies.
 *
 * @param {string} content
 * @param {Object} [options]
 * @returns {Map<string, { version: string, depType: string, isDirect: boolean }>}
 */
export function parseBunLockfile(content, options = {}) {
  const map = new Map();
  if (!content || typeof content !== 'string') {
    return map;
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanJsonc(content));
  } catch {
    return map;
  }

  if (!parsed || typeof parsed !== 'object') {
    return map;
  }

  // If bun.lock has packages (similar to npm v3)
  if (parsed.packages && typeof parsed.packages === 'object') {
    const rootPkg = parsed.packages[''] || {};
    const directNames = new Set();

    const addDirects = (section) => {
      if (section && typeof section === 'object') {
        for (const name of Object.keys(section)) {
          directNames.add(name);
        }
      }
    };

    addDirects(rootPkg.dependencies);
    addDirects(rootPkg.devDependencies);
    addDirects(rootPkg.optionalDependencies);

    for (const [key, entry] of Object.entries(parsed.packages)) {
      if (key === '' || !entry || typeof entry !== 'object') continue;
      const match = key.match(/^(?:node_modules\/)?((?:@[^/]+\/)?[^/]+)$/);
      if (match) {
        const name = match[1];
        if (directNames.has(name) || directNames.size === 0) {
          map.set(name, {
            version: entry.version || '',
            depType: entry.dev ? 'devDependencies' : 'dependencies',
            isDirect: true
          });
        }
      }
    }

    if (map.size > 0) return map;
  }

  // Fallback if bun.lock has top-level dependencies/devDependencies
  const extractSection = (section, depType) => {
    if (section && typeof section === 'object') {
      for (const [name, version] of Object.entries(section)) {
        if (typeof version === 'string') {
          map.set(name, { version, depType, isDirect: true });
        }
      }
    }
  };

  extractSection(parsed.dependencies, 'dependencies');
  extractSection(parsed.devDependencies, 'devDependencies');

  return map;
}
