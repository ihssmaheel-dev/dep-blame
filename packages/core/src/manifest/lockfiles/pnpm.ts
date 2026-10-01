import type { DependencyEntry, DepType, ParseResult } from '../../types.js';

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
 * Parses pnpm-lock.yaml into per-manifest dependency maps, one entry per
 * importer. Importer `.` (or `/`) maps to the root `package.json`; any
 * other importer (e.g. `packages/app`) maps to `<dir>/package.json`.
 *
 * Returns null when the YAML parser is unavailable (caller: low-fi event).
 * `ok: false` means corrupt YAML — retain last-good snapshots and warn.
 */
export async function parsePnpmLockfiles(
  content?: string | null
): Promise<{ ok: boolean; maps: Map<string, Map<string, DependencyEntry>>; note?: string } | null> {
  const maps = new Map<string, Map<string, DependencyEntry>>();
  if (content === null || content === undefined) {
    return { ok: true, maps };
  }

  if (typeof content !== 'string' || !content.trim()) return {ok: false, maps, note: 'empty or invalid lockfile'};

  const yaml = await loadYamlParser();
  if (!yaml) {
    return null;
  }

  let parsed: any;
  try {
    parsed = yaml.parse(content);
  } catch {
    return { ok: false, maps, note: 'invalid YAML' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, maps, note: 'not a YAML mapping' };
  }

  if (parsed.importers !== undefined && (!parsed.importers || typeof parsed.importers !== 'object' || Array.isArray(parsed.importers))) return {ok: false, maps, note: 'invalid importer mapping'};

  const toManifest = (importer: string): string =>
    importer === '.' || importer === '/' ? 'package.json' : `${importer.replace(/\/$/, '')}/package.json`;

  let invalid = false;
  const extractSection = (map: Map<string, DependencyEntry>, section: any, depType: DepType) => {
    if (section !== undefined && (!section || typeof section !== 'object' || Array.isArray(section))) { invalid = true; return; }
    if (!section || typeof section !== 'object') return;
    for (const [name, val] of Object.entries<any>(section)) {
      let version = '';
      if (typeof val === 'string') {
        version = val;
      } else if (val && typeof val === 'object') {
        version = val.version || val.specifier || '';
      }
      if (typeof version !== 'string' || !version) { invalid = true; continue; }
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

  const extractImporter = (manifest: string, root: any) => {
    const map = new Map<string, DependencyEntry>();
    extractSection(map, root.dependencies, 'dependencies');
    extractSection(map, root.devDependencies, 'devDependencies');
    extractSection(map, root.peerDependencies, 'peerDependencies');
    extractSection(map, root.optionalDependencies, 'optionalDependencies');
    maps.set(manifest, map);
  };

  // pnpm v6+ / v9 (importers) — every workspace importer tracked separately.
  if (parsed.importers && typeof parsed.importers === 'object') {
    for (const [importer, root] of Object.entries<any>(parsed.importers)) {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return {ok: false, maps: new Map(), note: 'invalid importer'};
      extractImporter(toManifest(importer), root);
    }
    // Ensure a root entry exists even when the lockfile omits it.
    if (!maps.has('package.json')) maps.set('package.json', new Map());
    return invalid ? { ok: false, maps: new Map(), note: 'invalid importer dependency' } : { ok: true, maps };
  }

  // pnpm v5 (root dependencies & devDependencies)
  const rootMap = new Map<string, DependencyEntry>();
  extractSection(rootMap, parsed.dependencies, 'dependencies');
  extractSection(rootMap, parsed.devDependencies, 'devDependencies');
  extractSection(rootMap, parsed.peerDependencies, 'peerDependencies');
  extractSection(rootMap, parsed.optionalDependencies, 'optionalDependencies');
  maps.set('package.json', rootMap);

  return invalid ? { ok: false, maps: new Map(), note: 'invalid root dependency' } : { ok: true, maps };
}

/**
 * Root-only convenience wrapper (root `package.json` importer).
 * Prefer `parsePnpmLockfiles` when workspace attribution matters.
 */
export async function parsePnpmLockfile(
  content?: string | null
): Promise<Map<string, DependencyEntry> | null> {
  const res = await parsePnpmLockfiles(content);
  if (res === null) return null;
  return res.maps.get('package.json') || new Map<string, DependencyEntry>();
}
