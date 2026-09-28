import type { DependencyEntry } from '../../types.js';

/**
 * Lazy loads the 'yaml' module.
 */
async function loadYamlParser(): Promise<any | null> {
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
 * Parses yarn.lock into a normalized Map of dependencies (supporting v1 Classic and Berry v2+).
 */
export async function parseYarnLockfile(content?: string | null): Promise<Map<string, DependencyEntry>> {
  const map = new Map<string, DependencyEntry>();
  if (!content || typeof content !== 'string') {
    return map;
  }

  // 1. Try parsing with YAML (handles Yarn Berry v2+)
  const yaml = await loadYamlParser();
  if (yaml) {
    try {
      const parsed = yaml.parse(content);
      if (parsed && typeof parsed === 'object') {
        for (const [descriptor, entry] of Object.entries<any>(parsed)) {
          if (entry && typeof entry === 'object' && entry.version) {
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
  let currentPackage: string | null = null;

  for (const line of lines) {
    if (!line.startsWith(' ') && !line.startsWith('#') && line.includes('@') && line.trim().endsWith(':')) {
      const header = line.trim().slice(0, -1);
      const match = header.match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
      currentPackage = match ? match[1] : null;
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
