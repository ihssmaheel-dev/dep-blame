import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DependencyEvent, FilterOptions, StoreInterface } from '../types.js';

export const CACHE_SCHEMA_VERSION = '2';

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

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(filePath);
    this.initSchema();
    // Record schema version for future migrations.
    try {
      this.setMeta('schema_version', CACHE_SCHEMA_VERSION);
    } catch {
      // Ignore meta write failures on read-only caches.
    }
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
        author TEXT NOT NULL,
        message TEXT NOT NULL,
        manifest TEXT NOT NULL,
        dep_type TEXT NOT NULL,
        is_direct INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_package ON events(package)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_manifest ON events(manifest)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_commit ON events(commit_sha)`);

    // Schema migration for existing databases created before is_direct was added
    try {
      this.db.exec('ALTER TABLE events ADD COLUMN is_direct INTEGER NOT NULL DEFAULT 1;');
    } catch {
      // Column already exists, safe to ignore
    }
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

    let inTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;
      if (!this.stmtInsertEvent) {
        this.stmtInsertEvent = this.db.prepare(`
          INSERT INTO events (
            package, type, from_version, to_version,
            date, commit_sha, author, message, manifest, dep_type, is_direct
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          ev.author,
          ev.message,
          ev.manifest,
          ev.depType,
          ev.isDirect === false ? 0 : 1
        );
      }
      this.db.exec('COMMIT');
      inTx = false;
    } catch (err) {
      try {
        if (inTx) this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures.
      }
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
      conditions.push('date >= ?');
      params.push(filter.since);
    }

    if (filter.manifest) {
      conditions.push('manifest = ?');
      params.push(filter.manifest);
    }

    if (filter.workspace) {
      // Escape LIKE wildcards so `web%` doesn't match `website`.
      const escaped = String(filter.workspace).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push('manifest LIKE ? ESCAPE \'\\\'');
      params.push(`%${escaped}%`);
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
        isDirect: row.is_direct === 1
      };
      if (row.from_version) ev.from = row.from_version;
      if (row.to_version) ev.to = row.to_version;
      return ev;
    });
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
    try {
      this.setMeta('schema_version', CACHE_SCHEMA_VERSION);
    } catch {
      // Ignore
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
