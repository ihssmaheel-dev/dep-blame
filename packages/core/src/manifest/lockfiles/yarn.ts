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
        const versionsByName = new Map<string, Set<string>>();
        for (const [descriptor, entry] of Object.entries<any>(parsed)) {
          if (descriptor === '__metadata') continue;
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.version !== 'string' || !entry.version) return {ok: false, entries: new Map(), note: 'invalid Yarn Berry entry'};
          if (entry.version) {
            // Split comma-joined descriptors ("a@1, a@2:") safely: each
            // comma part carries its own name.
            const parts = String(descriptor).split(',');
            for (const part of parts) {
              const nameMatch = part.trim().match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
              if (nameMatch) {
                const name = nameMatch[1].replace(/"$/g, '');
                if (name === '__metadata' || !name) continue;
                if (!versionsByName.has(name)) versionsByName.set(name, new Set());
                versionsByName.get(name)!.add(String(entry.version));
              }
            }
          }
        }
        for (const [name, versions] of versionsByName) {
          const sorted = [...versions].sort();
          map.set(name, {
            version: sorted[0],
            depType: 'dependencies',
            isDirect: false,
            ...(sorted.length > 1 ? { resolutions: sorted, ambiguous: true as const } : {})
          });
        }
        const multiVersion = new Set([...versionsByName.entries()].filter(([, v]) => v.size > 1).map(([n]) => n));
        return {
          ok: true,
          entries: map,
          ...(multiVersion.size > 0
            ? { note: `multiple resolved versions for: ${Array.from(multiVersion).sort().join(', ')} (all recorded)` }
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
  let currentPackages: string[] | null = null;
  let pendingVersion = false;
  const versionsByName = new Map<string, Set<string>>();

  for (const line of lines) {
    if (!line.startsWith(' ') && !line.startsWith('#') && line.includes('@') && line.trim().endsWith(':')) {
      if (pendingVersion) return { ok: false, entries: new Map(), note: 'missing Yarn version' };
      const header = line.trim().slice(0, -1);
      // A header may list several descriptors: "a@^1, a@~1:" — split first.
      const names = new Set<string>();
      for (const part of header.split(',')) {
        const match = part.trim().match(/^"?((?:@[^/]+\/)?[^@\s,:]+)/);
        if (match && match[1]) names.add(match[1].replace(/"$/g, ''));
      }
      currentPackages = names.size > 0 ? [...names] : null;
      pendingVersion = !!currentPackages;
    } else if (currentPackages && line.trim().startsWith('version')) {
      const versionMatch = line.match(/version\s+"?([^"\s]+)"?/);
      if (versionMatch) {
        pendingVersion = false;
        const version = versionMatch[1];
        for (const pkg of currentPackages) {
          if (!versionsByName.has(pkg)) versionsByName.set(pkg, new Set());
          versionsByName.get(pkg)!.add(version);
        }
      }
      currentPackages = null;
    } else if (line.trim() && !line.startsWith(' ') && !line.startsWith('#')) {
      return { ok: false, entries: new Map(), note: 'invalid Yarn Classic record' };
    }
  }
  if (pendingVersion) return { ok: false, entries: new Map(), note: 'missing Yarn version' };

  for (const [name, versions] of versionsByName) {
    const sorted = [...versions].sort();
    map.set(name, {
      version: sorted[0],
      depType: 'dependencies',
      isDirect: false,
      ...(sorted.length > 1 ? { resolutions: sorted, ambiguous: true as const } : {})
    });
  }
  const multiVersion = new Set([...versionsByName.entries()].filter(([, v]) => v.size > 1).map(([n]) => n));
  return {
    ok: true,
    entries: map,
    ...(multiVersion.size > 0
      ? { note: `multiple resolved versions for: ${Array.from(multiVersion).sort().join(', ')} (all recorded)` }
      : {})
  };
}
