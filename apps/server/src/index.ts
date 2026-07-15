import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@bftp/db';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const dbPath = process.env.BFTP_DB_PATH ?? path.join(repoRoot, 'data', 'library.db');
const dataDir = path.dirname(dbPath);
const port = Number(process.env.BFTP_PORT ?? 8765);
const host = process.env.BFTP_HOST ?? '127.0.0.1';
const publicUrl = process.env.BFTP_PUBLIC_URL ?? `http://${host}:${port}`;

const handle = openDb(dbPath);
const app = buildApp({
  handle,
  webDistDir: path.join(repoRoot, 'apps', 'web', 'dist'),
  dataDir,
  publicUrl,
});

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`BlastFromThePast listening on http://${host}:${port} (db: ${dbPath})`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
