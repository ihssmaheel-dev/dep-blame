import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DependencyEvent, FilterOptions, StoreInterface } from '../types.js';

export const CACHE_SCHEMA_VERSION = '5';

function loadDatabaseSync(): any {
  try {
    const require = createRequire(import.meta.url);
    // Synchronous load so `new SqliteStore()` preserves its API.
    // Throws on Node without node:sqlite (<=22 without flag) -> caller falls back.
    const mod = require('node:sqlite');
    const DatabaseSync = mod.DatabaseSync || mod.default?.DatabaseSync || mod.default;
    if (!DatabaseSync) {
      throw new Error('node:sqlite does not export DatabaseSync');
    }
    return DatabaseSync;
  } catch (err: any) {
    const e: any = new Error(
      'node:sqlite is unavailable in this Node runtime. Falling back to JSON cache.'
    );
    e.code = 'SQLITE_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
}

export class SqliteStore implements StoreInterface {
  filePath: string;
  db: any;
  private stmtGetMeta: any = null;
  private stmtSetMeta: any = null;
  private stmtInsertEvent: any = null;
  private txDepth = 0;

  /** Nesting-aware BEGIN: inner callers reuse the outer transaction. */
  private beginTx(): void {
    if (this.txDepth === 0) this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
  }

  private commitTx(): void {
    this.txDepth--;
    if (this.txDepth <= 0) {
      this.txDepth = 0;
      this.db.exec('COMMIT');
    }
  }

  private rollbackTx(): void {
    this.txDepth = 0;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures.
    }
  }

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(filePath);
    this.initSchema();
    // Validate BEFORE stamping: a stale version must trigger migration,
    // otherwise the check in openCache could never observe it.
    let prev: string | null = null;
    try {
      prev = this.getMeta('schema_version');
    } catch {
      prev = null;
    }
    if (prev && prev !== CACHE_SCHEMA_VERSION) {
      this.migrate(prev);
    } else if (!prev) {
      try {
        this.setMeta('schema_version', CACHE_SCHEMA_VERSION);
      } catch {
        // Ignore meta write failures on read-only caches.
      }
    }
  }

  /**
   * Migrates or clears on version mismatch inside a transaction, so an
   * interrupted migration can't leave a half-migrated database behind.
   */
  migrate(prevVersion: string): void {
    void prevVersion;
    let inTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;
      this.db.exec('DELETE FROM events');
      this.db.exec('DELETE FROM meta');
      this.initSchema();
      this.resetStatements();
      this.setMeta('schema_version', CACHE_SCHEMA_VERSION);
      this.db.exec('COMMIT');
      inTx = false;
    } catch {
      try {
        if (inTx) this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures.
      }
      // Last resort: drop and rebuild outside a transaction.
      try {
        this.db.exec('DROP TABLE IF EXISTS events');
      } catch {
        // Ignore
      }
      try {
        this.db.exec('DROP TABLE IF EXISTS meta');
      } catch {
        // Ignore
      }
      this.initSchema();
      this.resetStatements();
      try {
        this.setMeta('schema_version', CACHE_SCHEMA_VERSION);
      } catch {
        // Ignore
      }
    }
  }

  private resetStatements(): void {
    this.stmtGetMeta = null;
    this.stmtSetMeta = null;
    this.stmtInsertEvent = null;
  }

  initSchema(): void {
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    } catch {
      // Ignore
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package TEXT NOT NULL,
        type TEXT NOT NULL,
        from_version TEXT,
        to_version TEXT,
        date TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        commit_full TEXT,
        author TEXT NOT NULL,
        message TEXT NOT NULL,
        manifest TEXT NOT NULL,
        dep_type TEXT NOT NULL,
        dep_type_from TEXT,
        source TEXT NOT NULL DEFAULT 'manifest',
        lockfile TEXT,
        is_direct INTEGER NOT NULL DEFAULT 1,
        resolutions TEXT,
        ambiguous INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_package ON events(package)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_manifest ON events(manifest)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_commit ON events(commit_sha)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_direct ON events(is_direct)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_ambiguous ON events(ambiguous)`);

    // Schema migrations for databases created before these columns existed.
    // Each is idempotent: failure means the column already exists.
    const additions = [
      'ALTER TABLE events ADD COLUMN is_direct INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE events ADD COLUMN commit_full TEXT',
      "ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'manifest'",
      'ALTER TABLE events ADD COLUMN dep_type_from TEXT',
      'ALTER TABLE events ADD COLUMN lockfile TEXT',
      'ALTER TABLE events ADD COLUMN resolutions TEXT',
      'ALTER TABLE events ADD COLUMN ambiguous INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE events ADD COLUMN commit_parents TEXT',
      'ALTER TABLE events ADD COLUMN change_origin TEXT'
    ];
    for (const sql of additions) {
      try {
        this.db.exec(sql + ';');
      } catch {
        // Column already exists, safe to ignore.
      }
    }
    this.resetStatements();
  }

  getMeta(key: string): string | null {
    if (!this.stmtGetMeta) {
      this.stmtGetMeta = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    }
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    if (!this.stmtSetMeta) {
      this.stmtSetMeta = this.db.prepare(`
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
    }
    this.stmtSetMeta.run(key, String(value));
  }

  insertEvents(events: DependencyEvent[]): void {
    if (!events || events.length === 0) {
      return;
    }

    let started = false;
    try {
      this.beginTx();
      started = true;
      if (!this.stmtInsertEvent) {
        this.stmtInsertEvent = this.db.prepare(`
          INSERT INTO events (
            package, type, from_version, to_version,
            date, commit_sha, commit_full, author, message, manifest,
            dep_type, dep_type_from, source, lockfile, is_direct,
            resolutions, ambiguous, commit_parents, change_origin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      const stmt = this.stmtInsertEvent;

      for (const ev of events) {
        stmt.run(
          ev.package,
          ev.type,
          ev.from || null,
          ev.to || null,
          ev.date,
          ev.commit,
          ev.commitFull || null,
          ev.author,
          ev.message,
          ev.manifest,
          ev.depType,
          ev.depTypeFrom || null,
          ev.source || 'manifest',
          ev.lockfile || null,
          ev.isDirect === false ? 0 : 1,
          ev.resolutions ? JSON.stringify(ev.resolutions) : null,
          ev.ambiguous ? 1 : 0,
          ev.commitParents ? JSON.stringify(ev.commitParents) : null,
          ev.changeOrigin || null
        );
      }
      this.commitTx();
      started = false;
    } catch (err) {
      if (started) this.rollbackTx();
      throw err;
    }
  }

  /**
   * Coalesced writes: wraps `fn` in a single transaction so N window
   * inserts cost one commit. Safe to nest around `insertEvents`.
   */
  transaction(fn: () => void): void {
    this.beginTx();
    try {
      fn();
      this.commitTx();
    } catch (err) {
      this.rollbackTx();
      throw err;
    }
  }

  queryEvents(filter: FilterOptions = {}): DependencyEvent[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.package) {
      conditions.push('package = ?');
      params.push(filter.package);
    }

    if (filter.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }

    if (filter.since) {
      // Instant comparison (not lexicographic): SQLite normalizes the
      // `+05:30` offsets git emits, so a 00:30+05:30 event can't pass a
      // midnight-UTC cutoff it predates.
      conditions.push('datetime(date) >= datetime(?)');
      params.push(filter.since);
    }

    if (filter.manifest) {
      conditions.push('manifest = ?');
      params.push(filter.manifest);
    }

    if (filter.workspace) {
      // Segment-aware match: exact path, directory prefix, or a single
      // path segment — so `web` matches `apps/web/package.json` but
      // never an unrelated `website` path.
      const w = String(filter.workspace).replace(/\\/g, '/');
      const like = (s: string) => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push(
        "(manifest = ? OR manifest LIKE ? ESCAPE '\\' OR manifest LIKE ? ESCAPE '\\')"
      );
      params.push(w, `${like(w)}/%`, `%/${like(w)}/%`);
    }

    if (filter.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }

    if (filter.directOnly) {
      conditions.push('is_direct = 1');
    }

    let sql = 'SELECT * FROM events';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY id ASC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => {
      const ev: DependencyEvent = {
        package: row.package,
        type: row.type,
        date: row.date,
        commit: row.commit_sha,
        author: row.author,
        message: row.message,
        manifest: row.manifest,
        depType: row.dep_type,
        source: row.source === 'lockfile' ? 'lockfile' : 'manifest',
        isDirect: row.is_direct === 1
      };
      if (row.commit_full) ev.commitFull = row.commit_full;
      if (row.commit_parents) {
        try {
          const parents = JSON.parse(row.commit_parents);
          if (Array.isArray(parents) && parents.every((p: unknown) => typeof p === 'string' && /^[0-9a-f]{40,64}$/i.test(p))) ev.commitParents = parents;
        } catch { /* Ignore corrupt optional metadata. */ }
      }
      if (['direct', 'merge-integration', 'merge-change'].includes(row.change_origin)) ev.changeOrigin = row.change_origin;
      if (row.from_version) ev.from = row.from_version;
      if (row.to_version) ev.to = row.to_version;
      if (row.dep_type_from) ev.depTypeFrom = row.dep_type_from;
      if (row.lockfile) ev.lockfile = row.lockfile;
      if (row.resolutions) {
        try {
          const parsed = JSON.parse(row.resolutions);
          if (Array.isArray(parsed)) ev.resolutions = parsed.filter((v) => typeof v === 'string');
        } catch { /* ignore corrupt resolutions payload */ }
      }
      if (row.ambiguous === 1) ev.ambiguous = true;
      return ev;
    });
  }

  /**
   * Bounded paged query: same filters as queryEvents plus stable
   * id tie-breaker, total count, and limit/offset. Backs the v4
   * bounded-query contract (CLI --limit/--page, UI /api/events/paged).
   */
  queryPaged(filter: FilterOptions = {}, page: { limit?: number; offset?: number } = {}): { events: DependencyEvent[]; total: number; limit: number; offset: number } {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filter.package) { conditions.push('package = ?'); params.push(filter.package); }
    if (filter.type) { conditions.push('type = ?'); params.push(filter.type); }
    if (filter.since) { conditions.push('datetime(date) >= datetime(?)'); params.push(filter.since); }
    if (filter.manifest) { conditions.push('manifest = ?'); params.push(filter.manifest); }
    if (filter.workspace) {
      const w = String(filter.workspace).replace(/\\/g, '/');
      const like = (s: string) => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push("(manifest = ? OR manifest LIKE ? ESCAPE '\\' OR manifest LIKE ? ESCAPE '\\')");
      params.push(w, `${like(w)}/%`, `%/${like(w)}/%`);
    }
    if (filter.source) { conditions.push('source = ?'); params.push(filter.source); }
    if (filter.directOnly) { conditions.push('is_direct = 1'); }
    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const countStmt = this.db.prepare('SELECT COUNT(*) as n FROM events' + where);
    const countRow = countStmt.get(...params) as { n: number };
    const total = typeof countRow?.n === 'number' ? countRow.n : 0;
    const limit = Math.max(0, Math.min(1000, Math.floor(page.limit ?? 100)));
    const offset = Math.max(0, Math.floor(page.offset ?? 0));
    const stmt = this.db.prepare('SELECT * FROM events' + where + ' ORDER BY id ASC LIMIT ? OFFSET ?');
    const rows = stmt.all(...params, limit, offset) as any[];
    const events = rows.map((row) => {
      const ev: DependencyEvent = {
        package: row.package, type: row.type, date: row.date, commit: row.commit_sha,
        author: row.author, message: row.message, manifest: row.manifest,
        depType: row.dep_type, source: row.source === 'lockfile' ? 'lockfile' : 'manifest',
        isDirect: row.is_direct === 1,
      };
      if (row.commit_full) ev.commitFull = row.commit_full;
      if (row.commit_parents) {
        try {
          const parents = JSON.parse(row.commit_parents);
          if (Array.isArray(parents) && parents.every((p: unknown) => typeof p === 'string' && /^[0-9a-f]{40,64}$/i.test(p))) ev.commitParents = parents;
        } catch { /* Ignore corrupt optional metadata. */ }
      }
      if (['direct', 'merge-integration', 'merge-change'].includes(row.change_origin)) ev.changeOrigin = row.change_origin;
      if (row.from_version) ev.from = row.from_version;
      if (row.to_version) ev.to = row.to_version;
      if (row.dep_type_from) ev.depTypeFrom = row.dep_type_from;
      if (row.lockfile) ev.lockfile = row.lockfile;
      if (row.ambiguous === 1) ev.ambiguous = true;
      return ev;
    });
    return { events, total, limit, offset };
  }

  /** Month aggregates for bounded calendar rendering (no full transfer). */
  monthAggregates(filter: FilterOptions = {}): { month: string; total: number; added: number; updated: number; removed: number }[] {
    // Dates carry offsets; normalize in JS for correctness instead of
    // trusting substr on raw ISO strings.
    const all = this.queryEvents(filter);
    const buckets = new Map<string, { total: number; added: number; updated: number; removed: number }>();
    for (const ev of all) {
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
    return [...buckets.entries()].map(([month, b]) => ({ month, ...b }));
  }

  /**
   * Instant-based `since` check shared with the JSON store: compares
   * timestamps, not raw strings, so `00:30+05:30` never passes a
   * midnight-UTC cutoff it predates.
   */
  static passesSince(date: string, since: string): boolean {
    const a = Date.parse(date);
    const b = Date.parse(since);
    if (!isNaN(a) && !isNaN(b)) return a >= b;
    return date >= since;
  }

  clear(): void {
    // Separate execs: some SQLite builds reject multi-statement strings.
    try {
      this.db.exec('DELETE FROM events');
    } catch {
      // Ignore
    }
    try {
      this.db.exec('DELETE FROM meta');
    } catch {
      try {
        this.db.exec('DROP TABLE IF EXISTS events');
      } catch {
        // Ignore
      }
      try {
        this.db.exec('DROP TABLE IF EXISTS meta');
      } catch {
        // Ignore
      }
      this.initSchema();
    }
    // DROP invalidates cached prepared statements — always reset.
    this.resetStatements();
    try {
      this.setMeta('schema_version', CACHE_SCHEMA_VERSION);
    } catch {
      // Ignore
    }
  }

  close(): void {
    // Checkpoint WAL so the main DB file is complete even if -wal/-shm
    // are never promoted alongside it (crash-safe promotion).
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Ignore checkpoint failures (e.g. read-only cache).
    }
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
