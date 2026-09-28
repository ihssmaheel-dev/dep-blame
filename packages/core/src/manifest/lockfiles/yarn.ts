import type { DependencyEntry } from '../../types.js';

let yamlMissingWarned = false;

/**
 * Lazy loads the 'yaml' module (once-warned).
 */
async function loadYamlParser(): Promise<any | null> {
  try {
    const mod = await import('yaml');
    return (mod as any).default || mod;
  } catch {
    if (!yamlMissingWarned) {
      yamlMissingWarned = true;
      console.error('⚠ yarn.lock detected but the `yaml` parser isn\'t installed.');
      console.error('  Run: npm install yaml   (or reinstall without --omit=optional)');
    }
    return null;
  }
}

function looksLikeBerry(content: string): boolean {
  // Yarn Berry always carries __metadata; v1 starts with yarn lockfile v1 header.
  if (content.includes('__metadata:')) return true;
  if (content.includes('# yarn lockfile v1')) return false;
  // Heuristic: Berry uses `resolution:` + `checksum:` blocks.
  if (content.includes('resolution:') && content.includes('checksum:')) return true;
  return false;
}

/**
 * Parses yarn.lock into a normalized Map (Berry v2+ and v1 Classic).
 * Returns null when Berry is detected but the YAML parser is unavailable.
 */
export async function parseYarnLockfile(
  content?: string | null
): Promise<Map<string, DependencyEntry> | null> {
  const map = new Map<string, DependencyEntry>();
  if (!content || typeof content !== 'string') {
    return map;
  }

  // Berry (v2+) is real YAML with __metadata — parse structurally.
  if (looksLikeBerry(content)) {
    const yaml = await loadYamlParser();
    if (!yaml) return null;
    try {
      const parsed = yaml.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.__metadata) {
        for (const [descriptor, entry] of Object.entries<any>(parsed)) {
          if (descriptor === '__metadata') continue;
          if (entry && typeof entry === 'object' && entry.version) {
            const nameMatch = descriptor.match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
            if (nameMatch) {
              const name = nameMatch[1];
              if (!map.has(name) && name !== '__metadata') {
                map.set(name, {
                  version: String(entry.version),
                  depType: 'dependencies',
                  isDirect: true
                });
              }
            }
          }
        }
        return map;
      }
      // Berry-looking but unparsable -> fall through to v1 parser (best effort).
    } catch {
      // Fall through to v1 line-based parser.
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
