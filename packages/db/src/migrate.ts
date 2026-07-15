import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    sqlite
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    apply();
  }
}
