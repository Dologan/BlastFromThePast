import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import type { DbHandle } from '@bftp/db';
import { LastfmClient } from './lastfm/client.js';
import { LastfmSync } from './sync/lastfmSync.js';
import { JobManager } from './sync/jobManager.js';
import { MusicBrainzClient } from './enrich/musicbrainz.js';
import { Enrichment } from './enrich/enrichment.js';
import { getSetting, setSetting, SETTING_KEYS } from './settings.js';

const MB_USER_AGENT =
  'BlastFromThePast/0.1 ( https://github.com/dologan/blastfromthepast )';

export interface AppOptions {
  handle: DbHandle;
  /** Directory with the built SPA (apps/web/dist); optional in dev/tests. */
  webDistDir?: string;
  /** Injectable for tests. */
  createLastfmClient?: (apiKey: string) => LastfmClient;
  createMusicBrainzClient?: () => MusicBrainzClient;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { handle } = opts;
  const jobs = new JobManager();
  const createClient = opts.createLastfmClient ?? ((apiKey: string) => new LastfmClient(apiKey));
  const createMb =
    opts.createMusicBrainzClient ?? (() => new MusicBrainzClient(MB_USER_AGENT));

  const app = Fastify({ logger: true });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/settings', async () => {
    const apiKey = getSetting(handle, SETTING_KEYS.lastfmApiKey);
    return {
      lastfmUsername: getSetting(handle, SETTING_KEYS.lastfmUsername) ?? null,
      lastfmApiKeySet: Boolean(apiKey),
    };
  });

  app.put('/api/settings', async (req, reply) => {
    const body = req.body as { lastfmUsername?: string; lastfmApiKey?: string };
    if (body.lastfmUsername !== undefined) {
      setSetting(handle, SETTING_KEYS.lastfmUsername, body.lastfmUsername.trim());
    }
    if (body.lastfmApiKey !== undefined && body.lastfmApiKey !== '') {
      setSetting(handle, SETTING_KEYS.lastfmApiKey, body.lastfmApiKey.trim());
    }
    reply.code(204);
  });

  app.post('/api/sync/lastfm', async (req, reply) => {
    const username = getSetting(handle, SETTING_KEYS.lastfmUsername);
    const apiKey = getSetting(handle, SETTING_KEYS.lastfmApiKey);
    if (!username || !apiKey) {
      return reply.code(400).send({ error: 'Configure Last.fm username and API key first.' });
    }
    const sync = new LastfmSync(handle, createClient(apiKey), username, jobs.reportProgress);
    const started = jobs.start('lastfm', async () => {
      await sync.run();
    });
    if (!started) return reply.code(409).send({ error: 'A sync is already running.' });
    return reply.code(202).send({ started: true });
  });

  app.post('/api/enrich', async (req, reply) => {
    const body = (req.body as { reprocess?: boolean } | undefined) ?? {};

    // Reprocessing re-derives artists/artist_tags purely from the cached
    // MusicBrainz/Last.fm responses -- no network, so no API key needed.
    if (body.reprocess) {
      const enrichment = new Enrichment(handle, null, null, jobs.reportProgress);
      const started = jobs.start('enrich-reprocess', async () => {
        enrichment.reprocessAll();
      });
      if (!started) return reply.code(409).send({ error: 'A job is already running.' });
      return reply.code(202).send({ started: true });
    }

    const apiKey = getSetting(handle, SETTING_KEYS.lastfmApiKey);
    if (!apiKey) {
      return reply.code(400).send({ error: 'Configure a Last.fm API key first.' });
    }
    const enrichment = new Enrichment(handle, createMb(), createClient(apiKey), jobs.reportProgress);
    const started = jobs.start('enrich', async () => {
      await enrichment.run();
    });
    if (!started) return reply.code(409).send({ error: 'A job is already running.' });
    return reply.code(202).send({ started: true });
  });

  app.get('/api/sync/status', async () => {
    const sources = handle.sqlite
      .prepare('SELECT source, status, error, last_synced_at AS lastSyncedAt FROM sync_state')
      .all();
    return { ...jobs.getStatus(), sources };
  });

  app.get('/api/library/summary', async () => {
    const one = (sql: string) =>
      (handle.sqlite.prepare(sql).get() as Record<string, number | null>) ?? {};
    const counts = one(`SELECT
        (SELECT COUNT(*) FROM scrobbles) AS scrobbles,
        (SELECT COUNT(*) FROM tracks) AS tracks,
        (SELECT COUNT(*) FROM albums) AS albums,
        (SELECT COUNT(*) FROM artists) AS artists,
        (SELECT COUNT(*) FROM liked_tracks) AS liked,
        (SELECT MIN(uts) FROM scrobbles) AS firstScrobble,
        (SELECT MAX(uts) FROM scrobbles) AS lastScrobble`);
    const topArtists = handle.sqlite
      .prepare(
        `SELECT a.name, s.playcount
         FROM artist_stats s JOIN artists a ON a.id = s.artist_id
         ORDER BY s.playcount DESC LIMIT 10`,
      )
      .all();

    const enrichment = one(`SELECT
        (SELECT COUNT(*) FROM artists WHERE enrich_status = 'done') AS enriched,
        (SELECT COUNT(*) FROM artists WHERE enrich_status = 'pending') AS pending,
        (SELECT COUNT(*) FROM artists WHERE enrich_status = 'error') AS errored,
        (SELECT COUNT(*) FROM artists WHERE country IS NOT NULL) AS withCountry`);

    // Cache row counts, so it's visible that re-deriving (reprocessAll) after
    // a schema change won't cost any network time.
    const cache = one(`SELECT
        (SELECT COUNT(*) FROM mb_search_cache) AS mbSearches,
        (SELECT COUNT(*) FROM mb_artist_cache) AS mbArtists,
        (SELECT COUNT(*) FROM lastfm_tags_cache) AS lastfmTags`);

    // Genres/countries weighted by how much the user actually listens (artist
    // playcount), so the summary reflects taste rather than raw catalogue size.
    const topGenres = handle.sqlite
      .prepare(
        `SELECT t.name, SUM(s.playcount) AS weight
         FROM artist_tags at
         JOIN tags t ON t.id = at.tag_id
         JOIN artist_stats s ON s.artist_id = at.artist_id
         GROUP BY t.name
         ORDER BY weight DESC LIMIT 15`,
      )
      .all();
    const topCountries = handle.sqlite
      .prepare(
        `SELECT a.country AS name, SUM(s.playcount) AS weight
         FROM artists a
         JOIN artist_stats s ON s.artist_id = a.id
         WHERE a.country IS NOT NULL
         GROUP BY a.country
         ORDER BY weight DESC LIMIT 15`,
      )
      .all();

    return { ...counts, topArtists, enrichment, cache, topGenres, topCountries };
  });

  if (opts.webDistDir && fs.existsSync(opts.webDistDir)) {
    app.register(fastifyStatic, { root: opts.webDistDir });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for client-side routes; API misses stay 404s.
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
