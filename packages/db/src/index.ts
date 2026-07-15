import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';

export * as schema from './schema.js';
export { runMigrations } from './migrate.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/** Open (creating if needed) the app database, apply pragmas and pending migrations. */
export function openDb(dbPath: string): DbHandle {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new DatabaseConstructor(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
