/**
 * Lazy loads the 'yaml' module.
 */
async function loadYamlParser() {
  try {
    const mod = await import('yaml');
    return mod.default || mod;
  } catch {
    console.error('⚠ yarn.lock detected but the `yaml` parser isn\'t installed.');
    console.error('  Run: npm install yaml   (or reinstall without --omit=optional)');
    return null;
  }
}

/**
 * Parses yarn.lock into a normalized Map of dependencies (supporting v1 and Berry).
 *
 * @param {string} content
 * @param {Object} [options]
 * @returns {Promise<Map<string, { version: string, depType: string, isDirect: boolean }>>}
 */
export async function parseYarnLockfile(content, options = {}) {
  const map = new Map();
  if (!content || typeof content !== 'string') {
    return map;
  }

  // 1. Try parsing with YAML (handles Yarn Berry v2+ and standard YAML)
  const yaml = await loadYamlParser();
  if (yaml) {
    try {
      const parsed = yaml.parse(content);
      if (parsed && typeof parsed === 'object') {
        for (const [descriptor, entry] of Object.entries(parsed)) {
          if (entry && typeof entry === 'object' && entry.version) {
            // Descriptor format: "react@npm:^18.2.0" or "@scope/pkg@npm:^1.0.0"
            const nameMatch = descriptor.match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
            if (nameMatch) {
              const name = nameMatch[1];
              if (!map.has(name)) {
                map.set(name, {
                  version: String(entry.version),
                  depType: 'dependencies',
                  isDirect: true
                });
              }
            }
          }
        }
        if (map.size > 0) {
          return map;
        }
      }
    } catch {
      // Fallback to Yarn v1 line-based parser
    }
  }

  // 2. Line-based parser for Yarn v1 Classic
  const lines = content.split('\n');
  let currentPackage = null;

  for (const line of lines) {
    // Top-level key: "package@version-spec", "@scope/package@version-spec":
    if (!line.startsWith(' ') && !line.startsWith('#') && line.includes('@') && line.trim().endsWith(':')) {
      const header = line.trim().slice(0, -1);
      const match = header.match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
      if (match) {
        currentPackage = match[1];
      } else {
        currentPackage = null;
      }
    } else if (currentPackage && line.trim().startsWith('version')) {
      const versionMatch = line.match(/version\s+"?([^"\s]+)"?/);
      if (versionMatch) {
        const version = versionMatch[1];
        if (!map.has(currentPackage)) {
          map.set(currentPackage, {
            version,
            depType: 'dependencies',
            isDirect: true
          });
        }
      }
      currentPackage = null;
    }
  }

  return map;
}
