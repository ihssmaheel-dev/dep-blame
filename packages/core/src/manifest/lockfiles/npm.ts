import type { DependencyEntry, DepType, ParseResult } from '../../types.js';
import { DEP_TYPES } from '../package-json.js';

export interface NpmLockfileOptions {
  directOnly?: boolean;
}

/**
 * Parses package-lock.json content (v1, v2, v3). Tri-state: corrupt JSON
 * yields `ok: false` so callers retain the last-good snapshot.
 */
export function parseNpmLockfile(
  content?: string | null,
  options: NpmLockfileOptions = {}
): ParseResult {
  const { directOnly = true } = options;
  const map = new Map<string, DependencyEntry>();

  if (content === null || content === undefined) {
    return { ok: true, entries: map };
  }

  if (typeof content !== 'string' || !content.trim()) return {ok: false, entries: map, note: 'empty or invalid lockfile'};

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, entries: map, note: 'invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, entries: map, note: 'not a JSON object' };
  }

  const isMapping = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const field of ['packages', 'dependencies']) {
    if (parsed[field] !== undefined && !isMapping(parsed[field])) return {ok: false, entries: map, note: 'invalid lockfile section'};
  }
  if (parsed.packages) {
    for (const entry of Object.values<any>(parsed.packages)) {
      if (!isMapping(entry)) return {ok: false, entries: map, note: 'invalid resolved entry'};
    }
    const root = parsed.packages[''];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (root?.[field] !== undefined && (!isMapping(root[field]) || Object.values(root[field]).some(v => typeof v !== 'string'))) return {ok: false, entries: map, note: 'invalid root dependency'};
    }
  }
  if (parsed.dependencies && Object.values(parsed.dependencies).some(v => !isMapping(v))) return {ok: false, entries: map, note: 'invalid dependency entry'};

  // Handle v2 & v3 (parsed.packages)
  if (parsed.packages && typeof parsed.packages === 'object') {
    const rootPkg = parsed.packages[''] || {};
    // Installed dev/peer/optional flags describe npm's dependency tree.
    // Root declarations are authoritative for a direct package's section.
    const directTypes = new Map<string, DepType>();
    for (const depType of DEP_TYPES) {
      for (const name of Object.keys(rootPkg[depType] || {})) directTypes.set(name, depType);
    }

    // Collect every installed version per package (including nested
    // node_modules/a/node_modules/b) so multi-version installs are
    // explicit instead of silently collapsed to the first hit.
    const versionsByName = new Map<string, Set<string>>();
    const metaByName = new Map<string, { depType: DepType; isDirect: boolean }>();
    for (const [pkgPath, entry] of Object.entries<any>(parsed.packages)) {
      if (pkgPath === '' || !entry || typeof entry !== 'object') {
        continue;
      }
      if (entry.version !== undefined && typeof entry.version !== 'string') return { ok: false, entries: new Map(), note: 'invalid resolved version' };
      // Last node_modules segment is the installed package name.
      const segs = String(pkgPath).split('node_modules/');
      const last = segs[segs.length - 1] || '';
      const name = last.split('/').slice(0, last.startsWith('@') ? 2 : 1).join('/');
      if (!name || name.includes('/node_modules') || last.includes('/')) {
        // Skip non-package paths (e.g. node_modules/a/lib deep files are
        // never keys here, but guard anyway). Valid names have ≤1 slash.
        const parts = last.split('/');
        if (parts.length > 2 || (parts.length === 2 && !last.startsWith('@'))) continue;
      }
      if (!name) continue;
      const version = entry.version || '';
      if (!versionsByName.has(name)) versionsByName.set(name, new Set());
      if (version) versionsByName.get(name)!.add(version);
      if (!metaByName.has(name) || pkgPath === `node_modules/${name}`) {
        const isDirect = directTypes.has(name);
        let depType: DepType = 'dependencies';
        if (entry.dev) depType = 'devDependencies';
        else if (entry.peer) depType = 'peerDependencies';
        else if (entry.optional) depType = 'optionalDependencies';
        depType = directTypes.get(name) || depType;
        metaByName.set(name, { depType, isDirect });
      }
    }

    for (const [name, versions] of versionsByName) {
      const meta = metaByName.get(name)!;
      if (directOnly && !meta.isDirect) continue;
      const sorted = [...versions].sort();
      const ambiguous = sorted.length > 1;
      map.set(name, {
        version: sorted[0] || '',
        depType: meta.depType,
        isDirect: meta.isDirect,
        ...(ambiguous ? { resolutions: sorted, ambiguous: true as const } : {})
      });
    }
    const ambiguousNames = [...versionsByName.entries()].filter(([, v]) => v.size > 1).map(([n]) => n).sort();

    return { ok: true, entries: map, ...(ambiguousNames.length > 0 ? { note: `multiple installed versions for: ${ambiguousNames.join(', ')}` } : {}) };
  }

  // Handle v1 (parsed.dependencies)
  if (parsed.dependencies && typeof parsed.dependencies === 'object') {
    for (const [name, entry] of Object.entries<any>(parsed.dependencies)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.version !== undefined && typeof entry.version !== 'string') return { ok: false, entries: new Map(), note: 'invalid resolved version' };

      let depType: DepType = 'dependencies';
      if (entry.dev) depType = 'devDependencies';
      else if (entry.peer) depType = 'peerDependencies';
      else if (entry.optional) depType = 'optionalDependencies';

      map.set(name, {
        version: entry.version || '',
        depType,
        isDirect: true
      });
    }
  }

  return { ok: true, entries: map };
}
