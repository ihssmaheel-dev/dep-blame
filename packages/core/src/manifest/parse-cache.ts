import type { DependencyEntry, ParseResult } from '../types.js';

export interface MultiParseResult {
  ok: boolean;
  maps: Map<string, Map<string, DependencyEntry>>;
  note?: string;
}

export type CachedParse =
  | { kind: 'single'; result: ParseResult }
  | { kind: 'multi'; result: MultiParseResult };

// Retention budgets for parsed lockfile results. Parsed maps are small
// relative to their source text, but a pathological history could still
// pin many distinct lockfile versions — bound both dimensions. The entry
// budget covers several large (~15k-entry) lockfiles plus many small ones;
// measured worst-case retention stays in the tens of megabytes per scan.
const MAX_CACHED_BLOBS = 64;
const MAX_CACHED_ENTRIES = 100000;

function countEntries(value: CachedParse): number {
  if (value.kind === 'single') return value.result.entries.size;
  let n = 0;
  for (const m of value.result.maps.values()) n += m.size;
  return n;
}

/**
 * Content-addressed cache of lockfile parse results, keyed by Git blob OID.
 *
 * Identical OIDs are byte-identical everywhere, so one process-wide cache is
 * safe across concurrent scans and repositories: merge-heavy histories and
 * repeated lockfile states parse each unique blob exactly once instead of
 * once per commit that references it.
 *
 * A `null` result (missing optional `yaml` parser) is deliberately never
 * cached: parser availability can change between scans, while every other
 * outcome — including corrupt (`ok: false`) verdicts — is a pure function
 * of the bytes. Parsed maps are shared by reference like the engine's own
 * structural snapshot sharing; parsers hand over ownership and callers
 * must treat maps as read-only (the diff path only reads).
 */
export class ParsedBlobCache {
  private entries = new Map<string, CachedParse>();
  private tokens = 0;

  get(oid: string | undefined): CachedParse | undefined {
    if (!oid) return undefined;
    const hit = this.entries.get(oid);
    if (hit) {
      // LRU refresh: recently re-referenced blobs survive eviction.
      this.entries.delete(oid);
      this.entries.set(oid, hit);
    }
    return hit;
  }

  set(oid: string | undefined, value: CachedParse): void {
    if (!oid || this.entries.has(oid)) return;
    this.entries.set(oid, value);
    this.tokens += countEntries(value);
    while ((this.entries.size > MAX_CACHED_BLOBS || this.tokens > MAX_CACHED_ENTRIES) && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.tokens -= countEntries(evicted);
    }
  }

  clear(): void {
    this.entries.clear();
    this.tokens = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const parsedBlobCache = new ParsedBlobCache();
