import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure the directory exists
    const dir = path.dirname(config.sqlite.path);
    fs.mkdirSync(dir, { recursive: true });

    db = new Database(config.sqlite.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/** Run a read query — returns rows as plain objects. */
export function queryAll<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

/** Run a write query — returns { changes, lastInsertRowid }. */
export function run(sql: string, params: unknown[] = []): Database.RunResult {
  return getDb().prepare(sql).run(...params);
}

/** Run a read query — returns the first row or undefined. */
export function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

/** Generate a UUID v4 (SQLite has no built-in UUID). */
export function uuid(): string {
  return crypto.randomUUID();
}

/** Initialize database schema. */
export function initDatabase(): void {
  const d = getDb();

  d.exec(`
    -- Devices table
    CREATE TABLE IF NOT EXISTS devices (
      radio_id    TEXT PRIMARY KEY,
      callsign    TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      last_lat    REAL,
      last_lon    REAL,
      source      TEXT
    );

    -- Positions table
    CREATE TABLE IF NOT EXISTS positions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      radio_id     TEXT NOT NULL REFERENCES devices(radio_id) ON DELETE CASCADE,
      callsign     TEXT,
      lat          REAL,
      lon          REAL,
      altitude     REAL,
      speed        REAL,
      course       REAL,
      comment      TEXT,
      symbol       TEXT,
      symbol_table TEXT,
      source       TEXT,
      timestamp    TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_positions_radio_id  ON positions(radio_id);
    CREATE INDEX IF NOT EXISTS idx_positions_timestamp ON positions(timestamp DESC);

    -- User profiles table
    CREATE TABLE IF NOT EXISTS profiles (
      id          TEXT PRIMARY KEY,
      auth_id     TEXT UNIQUE NOT NULL,
      email       TEXT UNIQUE NOT NULL,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      address     TEXT NOT NULL,
      city        TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      qth_locator TEXT NOT NULL DEFAULT '',
      callsign    TEXT NOT NULL,
      avatar_url  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_auth_id ON profiles(auth_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_email   ON profiles(email);
  `);

  // Migrations for existing databases
  try { d.exec(`ALTER TABLE profiles ADD COLUMN city TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.exec(`ALTER TABLE profiles ADD COLUMN avatar_url TEXT`); } catch { /* already exists */ }
  try { d.exec(`ALTER TABLE profiles ADD COLUMN country TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.exec(`ALTER TABLE profiles ADD COLUMN qth_locator TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }

  // Trim trigger — keep last 500 positions per radio_id
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_trim_position_history
    AFTER INSERT ON positions
    BEGIN
      DELETE FROM positions
      WHERE id IN (
        SELECT id FROM positions
        WHERE radio_id = NEW.radio_id
        ORDER BY timestamp DESC
        LIMIT -1 OFFSET 500
      );
    END;
  `);

  console.log('[sqlite] Database initialized:', config.sqlite.path);
}

/** Graceful shutdown. */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
