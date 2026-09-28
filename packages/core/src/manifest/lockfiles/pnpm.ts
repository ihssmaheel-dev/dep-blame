import type { DependencyEntry, DepType } from '../../types.js';

let yamlMissingWarned = false;

/**
 * Lazy loads the 'yaml' module or logs an actionable warning (once).
 * Returns null when unavailable so the caller can emit a low-fidelity
 * lockfile event instead of silent nothing.
 */
async function loadYamlParser(): Promise<any | null> {
  try {
    const mod = await import('yaml');
    return (mod as any).default || mod;
  } catch {
    if (!yamlMissingWarned) {
      yamlMissingWarned = true;
      console.error('⚠ pnpm-lock.yaml detected but the `yaml` parser isn\'t installed.');
      console.error('  Run: npm install yaml   (or reinstall without --omit=optional)');
    }
    return null;
  }
}

export function isYamlMissingForPnpm(): boolean {
  return yamlMissingWarned;
}

/**
 * Parses pnpm-lock.yaml into a normalized Map of dependencies.
 * Returns null when the YAML parser is unavailable (caller: low-fi event).
 */
export async function parsePnpmLockfile(
  content?: string | null
): Promise<Map<string, DependencyEntry> | null> {
  const map = new Map<string, DependencyEntry>();
  if (!content || typeof content !== 'string') {
    return map;
  }

  const yaml = await loadYamlParser();
  if (!yaml) {
    return null;
  }

  let parsed: any;
  try {
    parsed = yaml.parse(content);
  } catch {
    return map;
  }

  if (!parsed || typeof parsed !== 'object') {
    return map;
  }

  const extractSection = (section: any, depType: DepType) => {
    if (!section || typeof section !== 'object') return;
    for (const [name, val] of Object.entries<any>(section)) {
      let version = '';
      if (typeof val === 'string') {
        version = val;
      } else if (val && typeof val === 'object') {
        version = val.version || val.specifier || '';
      }
      if (name && version) {
        // Strip peer dependency parenthetical suffixes e.g. "1.2.3(react@18.2.0)"
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
    extractSection(root.peerDependencies, 'peerDependencies');
    extractSection(root.optionalDependencies, 'optionalDependencies');
    return map;
  }

  // pnpm v5 (root dependencies & devDependencies)
  extractSection(parsed.dependencies, 'dependencies');
  extractSection(parsed.devDependencies, 'devDependencies');
  extractSection(parsed.peerDependencies, 'peerDependencies');
  extractSection(parsed.optionalDependencies, 'optionalDependencies');

  return map;
}
