import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Suppress experimental SQLite warning for clean CLI and JSON outputs
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) {
    return;
  }
  return origEmitWarning.call(process, warning, ...args);
};

export class SqliteStore {
  /**
   * @param {string} filePath Absolute path to sqlite file
   */
  constructor(filePath) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(filePath);
    this.initSchema();
  }

  initSchema() {
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
        dep_type TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_package ON events(package);
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    `);
  }

  getMeta(key) {
    const stmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    const row = stmt.get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    const stmt = this.db.prepare(`
      INSERT INTO meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, String(value));
  }

  insertEvents(events) {
    if (!events || events.length === 0) {
      return;
    }

    this.db.exec('BEGIN TRANSACTION');
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (
          package, type, from_version, to_version,
          date, commit_sha, author, message, manifest, dep_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          ev.depType
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  queryEvents(filter = {}) {
    const conditions = [];
    const params = [];

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

    let sql = 'SELECT * FROM events';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY id ASC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map((row) => {
      const ev = {
        package: row.package,
        type: row.type,
        date: row.date,
        commit: row.commit_sha,
        author: row.author,
        message: row.message,
        manifest: row.manifest,
        depType: row.dep_type
      };
      if (row.from_version) ev.from = row.from_version;
      if (row.to_version) ev.to = row.to_version;
      return ev;
    });
  }

  close() {
    this.db.close();
  }
}
