import type { DependencyEntry } from '../../types.js';

/**
 * Strips comments and trailing commas from JSONC-style strings.
 */
function cleanJsonc(text: string): string {
  let cleaned = text.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  return cleaned;
}

/**
 * Parses bun.lock into a normalized Map of dependencies.
 */
export function parseBunLockfile(content?: string | null): Map<string, DependencyEntry> {
  const map = new Map<string, DependencyEntry>();
  if (!content || typeof content !== 'string') {
    return map;
  }

  let parsed: any;
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
    const directNames = new Set<string>();

    const addDirects = (section: any) => {
      if (section && typeof section === 'object') {
        for (const name of Object.keys(section)) {
          directNames.add(name);
        }
      }
    };

    addDirects(rootPkg.dependencies);
    addDirects(rootPkg.devDependencies);
    addDirects(rootPkg.optionalDependencies);

    for (const [key, entry] of Object.entries<any>(parsed.packages)) {
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

  // Fallback if bun.lock has top-level dependencies
  const extractSection = (section: any, depType: any) => {
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
