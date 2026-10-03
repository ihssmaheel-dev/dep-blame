import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DependencyEvent, FilterOptions, PagedQuery, PagedResult, MonthBucket, StoreInterface } from '../types.js';

export const JSON_CACHE_SCHEMA_VERSION = '5';

interface JsonCacheData {
  meta: Record<string, string>;
  events: DependencyEvent[];
}

function isValidEvent(e: any): e is DependencyEvent {
  return (
    e &&
    typeof e === 'object' &&
    typeof e.package === 'string' &&
    (e.type === 'added' || e.type === 'updated' || e.type === 'removed') &&
    typeof e.date === 'string' &&
    typeof e.commit === 'string' &&
    typeof e.manifest === 'string'
  );
}

/** Instant-based comparison: never let `00:30+05:30` pass a midnight-UTC cutoff. */
function passesSince(date: string, since: string): boolean {
  const a = Date.parse(date);
  const b = Date.parse(since);
  if (!isNaN(a) && !isNaN(b)) return a >= b;
  return date >= since;
}

/** Segment-aware manifest match: no `website` for filter `web`. */
function matchesWorkspace(manifest: string, workspace: string): boolean {
  const m = manifest.replace(/\\/g, '/');
  const w = workspace.replace(/\\/g, '/');
  if (m === w) return true;
  if (m.startsWith(w + '/')) return true;
  return m.split('/').includes(w);
}

export class JsonStore implements StoreInterface {
  filePath: string;
  data: JsonCacheData;
  private suppressSave = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.data = { meta: {}, events: [] };
    this.load();
  }

  load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (!Array.isArray(parsed.events) || !parsed.events.every(isValidEvent)) {
            throw new Error('Incomplete JSON history cache.');
          }
          const events = parsed.events;
          const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
          // Drop incompatible caches from older schema versions.
          if (meta.schema_version !== JSON_CACHE_SCHEMA_VERSION) {
            this.data = { meta: { schema_version: JSON_CACHE_SCHEMA_VERSION }, events: [] };
            return;
          }
          const cleanMeta: Record<string, string> = {};
          for (const [k, v] of Object.entries(meta)) cleanMeta[k] = String(v);
          this.data = { meta: cleanMeta, events };
        }
      } catch {
        this.data = { meta: {}, events: [] };
      }
    }
    if (!this.data.meta.schema_version) {
      this.data.meta.schema_version = JSON_CACHE_SCHEMA_VERSION;
    }
  }

  save(): void {
    // Suppressed inside transaction(): one persist per scan, not per window.
    if (this.suppressSave > 0) return;
    // Atomic write: tmp + rename so a crash never leaves half-written JSON.
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.cache-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
      // Preserve the previous complete cache if atomic replacement fails.
      throw err;
    }
  }

  getMeta(key: string): string | null {
    return this.data.meta[key] !== undefined ? this.data.meta[key] : null;
  }

  setMeta(key: string, value: string): void {
    this.data.meta[key] = String(value);
    this.save();
  }

  insertEvents(events: DependencyEvent[]): void {
    if (!events || events.length === 0) {
      return;
    }
    for (const event of events) this.data.events.push(event);
    this.save();
  }

  /**
   * Coalesced writes: suppresses per-call persists so a full scan costs
   * one write at the end instead of O(windows) full-file rewrites.
   */
  transaction(fn: () => void): void {
    // Snapshot a copy so rollback is correct even if fn replaces the array
    // or mutates nested event objects (previous code kept a live reference).
    const beforeMeta = { ...this.data.meta };
    const beforeEvents = this.data.events.map((e) => ({ ...e }));
    const rollback = () => {
      this.data = { meta: beforeMeta, events: beforeEvents };
    };
    this.suppressSave++;
    try { fn(); }
    catch (err) { rollback(); throw err; }
    finally { this.suppressSave--; }
    if (this.suppressSave === 0) {
      try { this.save(); }
      catch (err) { rollback(); throw err; }
    }
  }

  queryEvents(filter: FilterOptions = {}): DependencyEvent[] {
    let list = this.data.events;

    if (filter.package) {
      list = list.filter((e) => e.package === filter.package);
    }
    if (filter.type) {
      list = list.filter((e) => e.type === filter.type);
    }
    if (filter.since) {
      list = list.filter((e) => passesSince(e.date, filter.since!));
    }
    if (filter.manifest) {
      list = list.filter((e) => e.manifest === filter.manifest);
    }
    if (filter.workspace) {
      list = list.filter((e) => matchesWorkspace(e.manifest, filter.workspace!));
    }
    if (filter.source) {
      list = list.filter((e) => (e.source || 'manifest') === filter.source);
    }
    if (filter.directOnly) {
      list = list.filter((e) => e.isDirect !== false);
    }

    return list;
  }

  queryPaged(filter: FilterOptions = {}, page: PagedQuery = {}): PagedResult {
    const all = this.queryEvents(filter);
    const total = all.length;
    const limit = Math.max(0, Math.min(1000, Math.floor(page.limit ?? 100)));
    const offset = Math.max(0, Math.floor(page.offset ?? 0));
    return { events: all.slice(offset, offset + limit), total, limit, offset };
  }

  monthAggregates(filter: FilterOptions = {}): MonthBucket[] {
    const buckets = new Map<string, { total: number; added: number; updated: number; removed: number }>();
    for (const ev of this.queryEvents(filter)) {
      const d = new Date(ev.date);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      let b = buckets.get(key);
      if (!b) { b = { total: 0, added: 0, updated: 0, removed: 0 }; buckets.set(key, b); }
      b.total++;
      if (ev.type === 'added') b.added++;
      else if (ev.type === 'updated') b.updated++;
      else if (ev.type === 'removed') b.removed++;
    }
    return [...buckets.entries()].map(([month, b]) => ({ month, ...b })).sort((a, b) => a.month < b.month ? -1 : 1);
  }

  clear(): void {
    this.data = { meta: {}, events: [] };
    this.save();
  }

  close(): void {
    // No-op for JSON store
  }
}
