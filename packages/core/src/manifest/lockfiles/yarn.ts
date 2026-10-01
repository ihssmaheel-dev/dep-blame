import type { DependencyEntry, ParseResult } from '../../types.js';

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
 * Parses yarn.lock (Berry v2+ and v1 Classic) into resolved entries.
 *
 * Honesty rules: a lockfile records the whole resolved tree, so entries
 * are `isDirect: false` — only a `package.json` can declare directness.
 * Consumers filtering `--direct-only` therefore skip yarn entries; see the
 * README. When one name resolves to several versions, the first is kept
 * and the rest are reported via `note` so callers can warn.
 *
 * Returns null when Berry is detected but the YAML parser is unavailable.
 */
export async function parseYarnLockfile(
  content?: string | null
): Promise<ParseResult | null> {
  const map = new Map<string, DependencyEntry>();
  const multiVersion = new Set<string>();
  if (content === null || content === undefined) {
    return { ok: true, entries: map };
  }

  if (typeof content !== 'string' || !content.trim()) return {ok: false, entries: map, note: 'empty or invalid lockfile'};

  // Berry (v2+) is real YAML with __metadata — parse structurally.
  if (looksLikeBerry(content)) {
    const yaml = await loadYamlParser();
    if (!yaml) return null;
    try {
      const parsed = yaml.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.__metadata) {
        for (const [descriptor, entry] of Object.entries<any>(parsed)) {
          if (descriptor === '__metadata') continue;
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.version !== 'string' || !entry.version) return {ok: false, entries: new Map(), note: 'invalid Yarn Berry entry'};
          if (entry.version) {
            const nameMatch = descriptor.match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
            if (nameMatch) {
              const name = nameMatch[1];
              if (name === '__metadata') continue;
              if (!map.has(name)) {
                map.set(name, {
                  version: String(entry.version),
                  depType: 'dependencies',
                  isDirect: false
                });
              } else if (map.get(name)!.version !== String(entry.version)) {
                multiVersion.add(name);
              }
            }
          }
        }
        return {
          ok: true,
          entries: map,
          ...(multiVersion.size > 0
            ? { note: `multiple resolved versions for: ${Array.from(multiVersion).sort().join(', ')} (showing first)` }
            : {})
        };
      }
      return { ok: false, entries: map, note: 'invalid Yarn Berry mapping' };
    } catch {
      return { ok: false, entries: map, note: 'invalid Yarn Berry YAML' };
    }
  }

  // 2. Line-based parser for Yarn v1 Classic
  const lines = content.split('\n');
  let currentPackage: string | null = null;
  let pendingVersion = false;

  for (const line of lines) {
    if (!line.startsWith(' ') && !line.startsWith('#') && line.includes('@') && line.trim().endsWith(':')) {
      if (pendingVersion) return { ok: false, entries: new Map(), note: 'missing Yarn version' };
      const header = line.trim().slice(0, -1);
      const match = header.match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
      currentPackage = match ? match[1] : null;
      pendingVersion = !!currentPackage;
    } else if (currentPackage && line.trim().startsWith('version')) {
      const versionMatch = line.match(/version\s+"?([^"\s]+)"?/);
      if (versionMatch) {
        pendingVersion = false;
        const version = versionMatch[1];
        if (!map.has(currentPackage)) {
          map.set(currentPackage, {
            version,
            depType: 'dependencies',
            isDirect: false
          });
        } else if (map.get(currentPackage)!.version !== version) {
          multiVersion.add(currentPackage);
        }
      }
      currentPackage = null;
    } else if (line.trim() && !line.startsWith(' ') && !line.startsWith('#')) {
      return { ok: false, entries: new Map(), note: 'invalid Yarn Classic record' };
    }
  }
  if (pendingVersion) return { ok: false, entries: new Map(), note: 'missing Yarn version' };

  return {
    ok: true,
    entries: map,
    ...(multiVersion.size > 0
      ? { note: `multiple resolved versions for: ${Array.from(multiVersion).sort().join(', ')} (showing first)` }
      : {})
  };
}
