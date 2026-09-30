import type { DependencyEntry, DepType } from '../../types.js';

/**
 * Strips comments and trailing commas from JSONC-style strings.
 */
function cleanJsonc(text: string): string {
  let cleaned = text.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  return cleaned;
}

export interface BunParseResult {
  ok: boolean;
  /** Per-manifest maps: importer package.json path -> resolved deps. */
  maps: Map<string, Map<string, DependencyEntry>>;
  note?: string;
}

const DEP_SECTIONS: DepType[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Splits a `name@version` lockfile key, handling `@scope/name@version`. */
function splitNameVersion(key: string): { name: string; version: string } | null {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

/**
 * Parses a text `bun.lock` into per-manifest resolved maps.
 *
 * Text format reference: top-level `workspaces` maps each workspace
 * ("" = root) to its declared sections, and `packages` maps
 * `name@version` keys to array- or object-valued entries.
 * `ok: false` means binary (`bun.lockb` / NUL bytes) or corrupt content —
 * callers must retain last-good snapshots and warn.
 */
export function parseBunLockfiles(content?: string | null): BunParseResult {
  const maps = new Map<string, Map<string, DependencyEntry>>();
  if (!content || typeof content !== 'string') {
    return { ok: true, maps };
  }
  if (content.includes('\0')) {
    return {
      ok: false,
      maps,
      note: 'binary bun.lockb is not decodable as text; tracking package.json declarations only'
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleanJsonc(content));
  } catch {
    return { ok: false, maps, note: 'invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, maps, note: 'not a JSON object' };
  }

  // Preferred: workspaces + packages tables.
  if (parsed.workspaces && typeof parsed.workspaces === 'object') {
    const directByManifest = new Map<string, Map<string, { spec: string; depType: DepType }>>();
    for (const [wsPath, ws] of Object.entries<any>(parsed.workspaces)) {
      if (!ws || typeof ws !== 'object') continue;
      const manifest = wsPath === '' ? 'package.json' : `${String(wsPath).replace(/\/$/, '')}/package.json`;
      const direct = new Map<string, { spec: string; depType: DepType }>();
      for (const depType of DEP_SECTIONS) {
        const section = ws[depType];
        if (section && typeof section === 'object') {
          for (const [name, spec] of Object.entries(section)) {
            if (typeof spec === 'string' && !direct.has(name)) {
              direct.set(name, { spec, depType });
            }
          }
        }
      }
      directByManifest.set(manifest, direct);
    }

    const resolved = new Map<string, string>();
    const multiVersion = new Set<string>();
    if (parsed.packages && typeof parsed.packages === 'object') {
      for (const [key, entry] of Object.entries<any>(parsed.packages)) {
        if (key === '') continue;
        const split = splitNameVersion(key);
        if (!split) continue;
        let version = split.version;
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.version === 'string') {
          version = entry.version;
        }
        if (!resolved.has(split.name)) {
          resolved.set(split.name, version);
        } else if (resolved.get(split.name) !== version) {
          multiVersion.add(split.name);
        }
      }
    }

    for (const [manifest, direct] of directByManifest) {
      const map = new Map<string, DependencyEntry>();
      for (const [name, { spec, depType }] of direct) {
        map.set(name, {
          version: resolved.get(name) || spec,
          depType,
          isDirect: true
        });
      }
      maps.set(manifest, map);
    }
    // Include workspaces that declare nothing so deletions diff correctly.
    return {
      ok: true,
      maps,
      ...(multiVersion.size > 0
        ? { note: `multiple resolved versions for: ${Array.from(multiVersion).sort().join(', ')} (showing first)` }
        : {})
    };
  }

  // Legacy/partial shapes below.
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

    const map = new Map<string, DependencyEntry>();
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

    if (map.size > 0) {
      maps.set('package.json', map);
      return { ok: true, maps };
    }
  }

  // Fallback if bun.lock has top-level dependencies
  const map = new Map<string, DependencyEntry>();
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
  maps.set('package.json', map);

  return { ok: true, maps };
}

/**
 * Single-map convenience wrapper (merges all workspace maps).
 * Prefer `parseBunLockfiles` when workspace attribution matters.
 */
export function parseBunLockfile(content?: string | null): Map<string, DependencyEntry> {
  const res = parseBunLockfiles(content);
  const merged = new Map<string, DependencyEntry>();
  for (const map of res.maps.values()) {
    for (const [name, entry] of map) {
      if (!merged.has(name)) merged.set(name, entry);
    }
  }
  return merged;
}
