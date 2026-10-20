import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DbHandle } from '@bftp/db';
import type { ServiceName } from '@bftp/core';
import { LastfmClient } from './lastfm/client.js';
import { LastfmSync } from './sync/lastfmSync.js';
import { MusicBrainzClient } from './enrich/musicbrainz.js';
import { Enrichment } from './enrich/enrichment.js';
import { AlbumEnrichment } from './enrich/albumEnrichment.js';
import { importServiceLiked } from './sync/spotifyLiked.js';
import { syncPlaylistInventory } from './sync/playlistInventory.js';
import { TokenCrypto } from './auth/crypto.js';
import { TokenStore } from './auth/tokenStore.js';
import { AuthManager } from './auth/authManager.js';
import { SpotifyConnector } from './connectors/spotify.js';
import { TidalConnector } from './connectors/tidal.js';
import { getSetting, SETTING_KEYS } from './settings.js';
import { acquireJobLock, currentJobLock } from './sync/jobLock.js';
import { MB_USER_AGENT } from './app.js';

// Same resolution as index.ts, so the CLI and the server always share one DB.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const dbPath = process.env.BFTP_DB_PATH ?? path.join(repoRoot, 'data', 'library.db');

const SERVICES: ServiceName[] = ['spotify', 'tidal'];

// EX_TEMPFAIL: another job holds the lock. Cron can treat this as "try again later".
const EXIT_BUSY = 75;

const USAGE = `Usage: cli <job> [--reprocess] [service]

Jobs:
  all                          Every job below whose service is configured, in order
  lastfm-sync                  Incremental Last.fm scrobble sync
  enrich                       Artist country/genre enrichment (MusicBrainz + Last.fm tags)
  enrich --reprocess           Re-derive artist rows from cached responses (no network)
  enrich-albums                Album release-date enrichment
  enrich-albums --reprocess    Re-derive album dates from cached responses (no network)
  spotify-liked                Import Spotify liked tracks
  tidal-liked                  Import TIDAL liked tracks
  playlists [spotify|tidal]    Refresh playlist inventory (connected services if omitted)

Settings (Last.fm username/API key, TIDAL country) are read from the database,
so configure them in the web UI once before running these jobs.`;

function parseService(raw: string | undefined): ServiceName {
  if (raw === 'spotify' || raw === 'tidal') return raw;
  throw new Error(`Unknown service "${raw}". Expected spotify or tidal.`);
}

type Run = (job: string, positional: string[], reprocess: boolean, handle: DbHandle) => Promise<unknown>;

/**
 * Runs each job in turn, skipping those whose service isn't configured. A job that
 * fails is recorded and the rest still run; the exit status is 1 if any failed.
 */
async function runAll(handle: DbHandle, auth: AuthManager, run: Run): Promise<Record<string, unknown>> {
  const lastfmApiKey = getSetting(handle, SETTING_KEYS.lastfmApiKey);
  const lastfmUsername = getSetting(handle, SETTING_KEYS.lastfmUsername);
  const steps: [string, string | null][] = [
    ['lastfm-sync', lastfmUsername && lastfmApiKey ? null : 'Last.fm username or API key not configured'],
    ['enrich', lastfmApiKey ? null : 'Last.fm API key not configured'],
    ['enrich-albums', null],
    ['spotify-liked', auth.isAuthorized('spotify') ? null : 'Spotify not connected'],
    ['tidal-liked', auth.isAuthorized('tidal') ? null : 'TIDAL not connected'],
    ['playlists', SERVICES.some((s) => auth.isAuthorized(s)) ? null : 'no streaming service connected'],
  ];

  const results: Record<string, unknown> = {};
  const failed: string[] = [];
  for (const [step, skipReason] of steps) {
    if (skipReason) {
      console.error(`[bftp-cli] skipping ${step}: ${skipReason}`);
      results[step] = { skipped: skipReason };
      continue;
    }
    console.error(`[bftp-cli] ${new Date().toISOString()} start ${step}`);
    try {
      results[step] = await run(step, [], false, handle);
      console.error(`[bftp-cli] ${new Date().toISOString()} done ${step}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[bftp-cli] ${step} failed: ${message}`);
      failed.push(step);
      results[step] = { error: message };
    }
  }
  if (failed.length > 0) process.exitCode = 1;
  return results;
}

async function run(job: string, positional: string[], reprocess: boolean, handle: DbHandle): Promise<unknown> {
  const publicUrl = process.env.BFTP_PUBLIC_URL ?? 'http://127.0.0.1:8765';
  const crypto = TokenCrypto.loadOrCreate(path.join(path.dirname(dbPath), 'secret.key'));
  const auth = new AuthManager(handle, new TokenStore(handle, crypto), publicUrl);

  const makeConnector = (service: ServiceName) => {
    const getToken = () => auth.getAccessToken(service);
    const isAuthorized = () => auth.isAuthorized(service);
    if (service === 'spotify') return new SpotifyConnector(getToken, isAuthorized);
    const cc = getSetting(handle, SETTING_KEYS.tidalCountryCode) ?? 'US';
    return new TidalConnector(getToken, isAuthorized, cc);
  };

  const lastfmApiKey = () => {
    const apiKey = getSetting(handle, SETTING_KEYS.lastfmApiKey);
    if (!apiKey) throw new Error('Configure a Last.fm API key first.');
    return apiKey;
  };

  switch (job) {
    case 'all':
      return runAll(handle, auth, run);

    case 'lastfm-sync': {
      const username = getSetting(handle, SETTING_KEYS.lastfmUsername);
      if (!username) throw new Error('Configure a Last.fm username first.');
      return new LastfmSync(handle, new LastfmClient(lastfmApiKey()), username).run();
    }

    case 'enrich': {
      if (reprocess) return new Enrichment(handle, null, null).reprocessAll();
      return new Enrichment(
        handle,
        new MusicBrainzClient(MB_USER_AGENT),
        new LastfmClient(lastfmApiKey()),
      ).run();
    }

    case 'enrich-albums': {
      if (reprocess) return new AlbumEnrichment(handle, null).reprocessAll();
      return new AlbumEnrichment(handle, new MusicBrainzClient(MB_USER_AGENT)).run();
    }

    case 'spotify-liked':
    case 'tidal-liked': {
      const service = job === 'spotify-liked' ? 'spotify' : 'tidal';
      if (!auth.isAuthorized(service)) throw new Error(`Connect ${service} first.`);
      return importServiceLiked(handle, makeConnector(service), service);
    }

    case 'playlists': {
      const services = positional[0]
        ? [parseService(positional[0])]
        : SERVICES.filter((s) => auth.isAuthorized(s));
      if (services.length === 0) throw new Error('Connect a service first.');
      const results = [];
      for (const service of services) {
        results.push(await syncPlaylistInventory(handle, makeConnector(service), service));
      }
      return results;
    }

    default:
      throw new Error(`Unknown job "${job}".\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  const [job, ...args] = process.argv.slice(2);
  if (!job || job === '--help' || job === 'help') {
    console.log(USAGE);
    return;
  }

  const dataDir = path.dirname(dbPath);
  const release = acquireJobLock(dataDir, job, 'cli');
  if (!release) {
    const held = currentJobLock(dataDir);
    const since = held ? new Date(held.startedAt).toISOString() : 'unknown time';
    console.error(
      `[bftp-cli] skipped ${job}: ${held?.job ?? 'a job'} is already running (${held?.source ?? 'unknown'}, pid ${held?.pid ?? '?'}, since ${since})`,
    );
    process.exitCode = EXIT_BUSY;
    return;
  }

  const handle = openDb(dbPath);
  try {
    console.error(`[bftp-cli] ${new Date().toISOString()} start ${job} (db: ${dbPath})`);
    const result = await run(job, args.filter((a) => !a.startsWith('--')), args.includes('--reprocess'), handle);
    console.error(`[bftp-cli] ${new Date().toISOString()} done ${job}`);
    console.log(JSON.stringify(result));
  } finally {
    handle.close();
    release();
  }
}

main().catch((err: unknown) => {
  console.error(`[bftp-cli] error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
