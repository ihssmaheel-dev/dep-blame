/**
 * Lazy loads the 'yaml' module or logs an actionable warning.
 */
async function loadYamlParser() {
  try {
    const mod = await import('yaml');
    return mod.default || mod;
  } catch {
    console.error('⚠ pnpm-lock.yaml detected but the `yaml` parser isn\'t installed.');
    console.error('  Run: npm install yaml   (or reinstall without --omit=optional)');
    return null;
  }
}

/**
 * Parses pnpm-lock.yaml into a normalized Map of dependencies.
 *
 * @param {string} content
 * @param {Object} [options]
 * @returns {Promise<Map<string, { version: string, depType: string, isDirect: boolean }>>}
 */
export async function parsePnpmLockfile(content, options = {}) {
  const map = new Map();
  if (!content || typeof content !== 'string') {
    return map;
  }

  const yaml = await loadYamlParser();
  if (!yaml) {
    return map;
  }

  let parsed;
  try {
    parsed = yaml.parse(content);
  } catch {
    return map;
  }

  if (!parsed || typeof parsed !== 'object') {
    return map;
  }

  const extractSection = (section, depType) => {
    if (!section || typeof section !== 'object') return;
    for (const [name, val] of Object.entries(section)) {
      let version = '';
      if (typeof val === 'string') {
        version = val;
      } else if (val && typeof val === 'object') {
        version = val.version || val.specifier || '';
      }
      if (name && version) {
        // pnpm versions may look like "1.2.3(react@18.2.0)" - strip peer suffix if needed
        const cleanVersion = version.split('(')[0];
        map.set(name, {
          version: cleanVersion,
          depType,
          isDirect: true
        });
      }
    }
  };

  // pnpm v6+ / v9 (importers)
  if (parsed.importers && typeof parsed.importers === 'object') {
    const root = parsed.importers['.'] || parsed.importers['/'] || {};
    extractSection(root.dependencies, 'dependencies');
    extractSection(root.devDependencies, 'devDependencies');
    extractSection(root.optionalDependencies, 'optionalDependencies');
    return map;
  }

  // pnpm v5 (root dependencies & devDependencies)
  extractSection(parsed.dependencies, 'dependencies');
  extractSection(parsed.devDependencies, 'devDependencies');
  extractSection(parsed.optionalDependencies, 'optionalDependencies');

  return map;
}
