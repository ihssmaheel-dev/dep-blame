import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DependencyEvent, FilterOptions, StoreInterface } from '../types.js';

export const JSON_CACHE_SCHEMA_VERSION = '2';

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

export class JsonStore implements StoreInterface {
  filePath: string;
  data: JsonCacheData;

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
          const events = Array.isArray(parsed.events) ? parsed.events.filter(isValidEvent) : [];
          const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
          // Drop incompatible caches from older schema versions.
          if (meta.schema_version && meta.schema_version !== JSON_CACHE_SCHEMA_VERSION) {
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
    // Atomic write: tmp + rename so a crash never leaves half-written JSON.
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.cache-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
      // Last-resort direct write (e.g. cross-device rename issues).
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch {
        // Cache is best-effort; never crash analysis on write failure.
      }
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
    this.data.events.push(...events);
    this.save();
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
      list = list.filter((e) => e.date >= filter.since!);
    }
    if (filter.manifest) {
      list = list.filter((e) => e.manifest === filter.manifest);
    }
    if (filter.workspace) {
      list = list.filter((e) => e.manifest.includes(filter.workspace!));
    }
    if (filter.directOnly) {
      list = list.filter((e) => e.isDirect !== false);
    }

    return list;
  }

  clear(): void {
    this.data = { meta: {}, events: [] };
    this.save();
  }

  close(): void {
    // No-op for JSON store
  }
}
