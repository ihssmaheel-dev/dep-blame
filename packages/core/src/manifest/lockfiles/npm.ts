import type { DependencyEntry, DepType, ParseResult } from '../../types.js';

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
    const directNames = new Set<string>();

    const checkRootDeps = (section: any) => {
      if (section && typeof section === 'object') {
        for (const name of Object.keys(section)) {
          directNames.add(name);
        }
      }
    };

    checkRootDeps(rootPkg.dependencies);
    checkRootDeps(rootPkg.devDependencies);
    checkRootDeps(rootPkg.peerDependencies);
    checkRootDeps(rootPkg.optionalDependencies);

    for (const [pkgPath, entry] of Object.entries<any>(parsed.packages)) {
      if (pkgPath === '' || !entry || typeof entry !== 'object') {
        continue;
      }

      // Check if it's a top-level node_modules package
      const match = pkgPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      if (match) {
        if (entry.version !== undefined && typeof entry.version !== 'string') return { ok: false, entries: new Map(), note: 'invalid resolved version' };
        const name = match[1];
        const isDirect = directNames.has(name);

        if (directOnly && !isDirect) {
          continue;
        }

        let depType: DepType = 'dependencies';
        if (entry.dev) depType = 'devDependencies';
        else if (entry.peer) depType = 'peerDependencies';
        else if (entry.optional) depType = 'optionalDependencies';

        map.set(name, {
          version: entry.version || '',
          depType,
          isDirect
        });
      }
    }

    return { ok: true, entries: map };
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
