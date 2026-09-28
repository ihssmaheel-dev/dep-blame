import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { DependencyEvent, FilterOptions, StoreInterface } from '../types.js';

export class SqliteStore implements StoreInterface {
  filePath: string;
  db: DatabaseSync;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(filePath);
    this.initSchema();
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
      );

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
      );

      CREATE INDEX IF NOT EXISTS idx_events_package ON events(package);
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
      CREATE INDEX IF NOT EXISTS idx_events_manifest ON events(manifest);
    `);

    // Schema migration for existing databases created before is_direct was added
    try {
      this.db.exec('ALTER TABLE events ADD COLUMN is_direct INTEGER NOT NULL DEFAULT 1;');
    } catch {
      // Column already exists, safe to ignore
    }
  }

  getMeta(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, String(value));
  }

  insertEvents(events: DependencyEvent[]): void {
    if (!events || events.length === 0) {
      return;
    }

    this.db.exec('BEGIN TRANSACTION');
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (
          package, type, from_version, to_version,
          date, commit_sha, author, message, manifest, dep_type, is_direct
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

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
    } catch (err) {
      this.db.exec('ROLLBACK');
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
      conditions.push('manifest LIKE ?');
      params.push(`%${filter.workspace}%`);
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
    try {
      this.db.exec('DELETE FROM events; DELETE FROM meta;');
    } catch {
      try {
        this.db.exec('DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS meta;');
        this.initSchema();
      } catch {
        // Ignore
      }
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
