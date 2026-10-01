import type { DependencyEntry, DepType, ParseResult } from '../types.js';

export const DEP_TYPES: DepType[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
];

/**
 * Parses a package.json content string into a normalized Map of dependencies.
 *
 * Tri-state: `ok: false` means present-but-corrupt content. Callers must
 * retain the last-good snapshot and warn — never treat it as an empty
 * manifest, which would invent removals followed by re-additions.
 */
export function parsePackageJson(content?: string | null): ParseResult {
  const map = new Map<string, DependencyEntry>();
  if (content === null || content === undefined) {
    return { ok: true, entries: map };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, entries: map, note: 'invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, entries: map, note: 'not a JSON object' };
  }

  for (const depType of DEP_TYPES) {
    const section = parsed[depType];
    if (section !== undefined && (!section || typeof section !== 'object' || Array.isArray(section))) {
      return { ok: false, entries: new Map(), note: `invalid ${depType} section` };
    }
    if (section && typeof section === 'object') {
      for (const [name, version] of Object.entries(section)) {
        if (typeof version !== 'string' || !name.trim() || !version.trim()) {
          return { ok: false, entries: new Map(), note: `invalid ${depType} entry` };
        }
        if (typeof version === 'string' && name.trim().length > 0) {
          map.set(name.trim(), {
            version: version.trim(),
            depType,
            isDirect: true
          });
        }
      }
    }
  }

  return { ok: true, entries: map };
}
