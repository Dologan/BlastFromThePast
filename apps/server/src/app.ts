import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import type { DbHandle } from '@bftp/db';
import { LastfmClient } from './lastfm/client.js';
import { LastfmSync } from './sync/lastfmSync.js';
import { JobManager } from './sync/jobManager.js';
import { MusicBrainzClient } from './enrich/musicbrainz.js';
import { Enrichment } from './enrich/enrichment.js';
import { RecipeService } from './recipes/recipeService.js';
import { TokenCrypto } from './auth/crypto.js';
import { TokenStore } from './auth/tokenStore.js';
import { AuthManager, AuthError } from './auth/authManager.js';
import { SpotifyConnector } from './connectors/spotify.js';
import { TidalConnector } from './connectors/tidal.js';
import { pushPlaylist, type PushResult } from './match/push.js';
import { ServiceMatcher } from './match/matcher.js';
import { resolveDeepLink, type LinkEntityKind } from './match/entityLinks.js';
import { importSpotifyLiked } from './sync/spotifyLiked.js';
import { getSetting, getStoredSetting, setSetting, SETTING_KEYS } from './settings.js';
import { computeGaps, computeNeglectedGems, computeOnThisDay, type InsightKind } from './stats/insights.js';
import {
  PRESETS,
  spotifySearchUrl,
  tidalSearchUrl,
  type Recipe,
  type ServiceConnector,
  type ServiceName,
} from '@bftp/core';
import path from 'node:path';

const MB_USER_AGENT =
  'BlastFromThePast/0.1 ( https://github.com/dologan/blastfromthepast )';
const SERVICES: ServiceName[] = ['spotify', 'tidal'];

export interface AppOptions {
  handle: DbHandle;
  /** Directory with the built SPA (apps/web/dist); optional in dev/tests. */
  webDistDir?: string;
  /** Directory for the token-encryption key file; ephemeral key if omitted (tests). */
  dataDir?: string;
  /** Public base URL for OAuth redirect URIs. */
  publicUrl?: string;
  /** Injectable for tests. */
  createLastfmClient?: (apiKey: string) => LastfmClient;
  createMusicBrainzClient?: () => MusicBrainzClient;
  /** Overrides the real Spotify/TIDAL connectors (tests). */
  createConnector?: (service: ServiceName) => ServiceConnector;
  /** OAuth manager override (tests). */
  authManager?: AuthManager;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { handle } = opts;
  const jobs = new JobManager();
  const createClient = opts.createLastfmClient ?? ((apiKey: string) => new LastfmClient(apiKey));
  const createMb =
    opts.createMusicBrainzClient ?? (() => new MusicBrainzClient(MB_USER_AGENT));
  const recipes = new RecipeService(handle);

  const publicUrl = opts.publicUrl ?? process.env.BFTP_PUBLIC_URL ?? 'http://127.0.0.1:8765';
  const crypto = opts.dataDir
    ? TokenCrypto.loadOrCreate(path.join(opts.dataDir, 'secret.key'))
    : TokenCrypto.ephemeral();
  const tokenStore = new TokenStore(handle, crypto);
  const auth = opts.authManager ?? new AuthManager(handle, tokenStore, publicUrl);

  const makeConnector = (service: ServiceName): ServiceConnector => {
    if (opts.createConnector) return opts.createConnector(service);
    const getToken = () => auth.getAccessToken(service);
    const isAuthorized = () => auth.isAuthorized(service);
    if (service === 'spotify') return new SpotifyConnector(getToken, isAuthorized);
    const cc = getSetting(handle, SETTING_KEYS.tidalCountryCode) ?? 'US';
    return new TidalConnector(getToken, isAuthorized, cc);
  };

  let lastPush: PushResult | null = null;

  const app = Fastify({ logger: true });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/settings', async () => {
    return {
      lastfmUsername: getSetting(handle, SETTING_KEYS.lastfmUsername) ?? null,
      lastfmApiKeySet: Boolean(getSetting(handle, SETTING_KEYS.lastfmApiKey)),
      // Client IDs report only a user override; empty means the built-in
      // app registration is in effect.
      spotifyClientId: getStoredSetting(handle, SETTING_KEYS.spotifyClientId) || null,
      tidalClientId: getStoredSetting(handle, SETTING_KEYS.tidalClientId) || null,
      tidalCountryCode: getSetting(handle, SETTING_KEYS.tidalCountryCode) ?? 'US',
      defaultService: (getSetting(handle, SETTING_KEYS.defaultService) as ServiceName | undefined) ?? null,
    };
  });

  app.put('/api/settings', async (req, reply) => {
    const body = req.body as {
      lastfmUsername?: string;
      lastfmApiKey?: string;
      spotifyClientId?: string;
      tidalClientId?: string;
      tidalCountryCode?: string;
      defaultService?: string;
    };
    if (body.lastfmUsername !== undefined) {
      setSetting(handle, SETTING_KEYS.lastfmUsername, body.lastfmUsername.trim());
    }
    if (body.lastfmApiKey !== undefined && body.lastfmApiKey !== '') {
      setSetting(handle, SETTING_KEYS.lastfmApiKey, body.lastfmApiKey.trim());
    }
    if (body.spotifyClientId !== undefined) {
      setSetting(handle, SETTING_KEYS.spotifyClientId, body.spotifyClientId.trim());
    }
    if (body.tidalClientId !== undefined) {
      setSetting(handle, SETTING_KEYS.tidalClientId, body.tidalClientId.trim());
    }
    if (body.tidalCountryCode !== undefined) {
      setSetting(handle, SETTING_KEYS.tidalCountryCode, body.tidalCountryCode.trim().toUpperCase());
    }
    if (body.defaultService !== undefined) {
      if (body.defaultService && !parseService(body.defaultService)) {
        return reply.code(400).send({ error: 'defaultService must be spotify or tidal.' });
      }
      setSetting(handle, SETTING_KEYS.defaultService, body.defaultService);
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

    return { ...counts, enrichment, cache, topGenres, topCountries };
  });

  const TOP_ARTISTS_RANGE_DAYS: Record<string, number | null> = { all: null, week: 7, month: 30, year: 365 };

  app.get('/api/library/top-artists', async (req, reply) => {
    const q = req.query as { range?: string; limit?: string };
    const range = q.range ?? 'all';
    if (!(range in TOP_ARTISTS_RANGE_DAYS)) {
      return reply.code(400).send({ error: 'range must be one of: all, week, month, year.' });
    }
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    const rangeDays = TOP_ARTISTS_RANGE_DAYS[range]!;

    const rows =
      rangeDays === null
        ? (handle.sqlite
            .prepare(
              `SELECT a.id AS entityId, a.name AS name, s.playcount AS playcount
               FROM artist_stats s JOIN artists a ON a.id = s.artist_id
               ORDER BY s.playcount DESC LIMIT ?`,
            )
            .all(limit) as { entityId: number; name: string; playcount: number }[])
        : (handle.sqlite
            .prepare(
              `SELECT a.id AS entityId, a.name AS name, COUNT(*) AS playcount
               FROM scrobbles s
               JOIN tracks t ON t.id = s.track_id
               JOIN artists a ON a.id = t.artist_id
               WHERE s.uts >= ?
               GROUP BY t.artist_id
               ORDER BY playcount DESC LIMIT ?`,
            )
            .all(Math.floor(Date.now() / 1000) - rangeDays * 86400, limit) as { entityId: number; name: string; playcount: number }[]);

    const artists = rows.map((r) => ({
      entityId: r.entityId,
      name: r.name,
      playcount: r.playcount,
      spotifyUrl: spotifySearchUrl(r.name, 'artist'),
      tidalUrl: tidalSearchUrl(r.name, 'artist'),
    }));
    return { range, limit, artists };
  });

  app.get('/api/library/insights', async (req, reply) => {
    const q = req.query as { kind?: string; limit?: string };
    if (q.kind && q.kind !== 'tracks' && q.kind !== 'albums' && q.kind !== 'artists') {
      return reply.code(400).send({ error: 'kind must be tracks, albums or artists.' });
    }
    const kind: InsightKind = (q.kind as InsightKind) ?? 'tracks';
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    return {
      kind,
      limit,
      gaps: computeGaps(handle.sqlite, kind, limit),
      neglectedGems: computeNeglectedGems(handle.sqlite, kind, limit),
      onThisDay: computeOnThisDay(handle.sqlite, kind, limit),
    };
  });

  // ---- Streaming service connections (OAuth) ----

  function parseService(raw: string): ServiceName | null {
    return (SERVICES as string[]).includes(raw) ? (raw as ServiceName) : null;
  }

  app.get('/api/auth/status', async () => ({
    spotify: { connected: auth.isAuthorized('spotify'), clientIdSet: Boolean(getSetting(handle, SETTING_KEYS.spotifyClientId)) },
    tidal: { connected: auth.isAuthorized('tidal'), clientIdSet: Boolean(getSetting(handle, SETTING_KEYS.tidalClientId)) },
  }));

  app.get('/api/auth/:service/start', async (req, reply) => {
    const service = parseService((req.params as { service: string }).service);
    if (!service) return reply.code(404).send({ error: 'Unknown service.' });
    try {
      return { url: auth.start(service) };
    } catch (err) {
      const msg = err instanceof AuthError ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.get('/api/auth/:service/callback', async (req, reply) => {
    const service = parseService((req.params as { service: string }).service);
    const q = req.query as { code?: string; state?: string; error?: string };
    if (!service) return reply.code(404).send({ error: 'Unknown service.' });
    if (q.error || !q.code || !q.state) {
      return reply.redirect(`/?connect=${service}&error=${encodeURIComponent(q.error ?? 'missing_code')}`);
    }
    try {
      await auth.handleCallback(service, q.code, q.state);
      return reply.redirect(`/?connect=${service}&ok=1`);
    } catch (err) {
      const msg = err instanceof AuthError ? err.message : String(err);
      return reply.redirect(`/?connect=${service}&error=${encodeURIComponent(msg)}`);
    }
  });

  app.post('/api/auth/:service/disconnect', async (req, reply) => {
    const service = parseService((req.params as { service: string }).service);
    if (!service) return reply.code(404).send({ error: 'Unknown service.' });
    auth.disconnect(service);
    reply.code(204);
  });

  app.post('/api/sync/spotify-liked', async (req, reply) => {
    if (!auth.isAuthorized('spotify')) return reply.code(400).send({ error: 'Connect Spotify first.' });
    const connector = makeConnector('spotify');
    const started = jobs.start('spotify-liked', async () => {
      await importSpotifyLiked(handle, connector, jobs.reportProgress);
    });
    if (!started) return reply.code(409).send({ error: 'A job is already running.' });
    return reply.code(202).send({ started: true });
  });

  // ---- Playlist push ----

  /** All library tracks of an album (via its scrobbles), oldest-first-heard. */
  const expandAlbumTracks = (albumId: number) =>
    handle.sqlite
      .prepare(
        `SELECT t.id AS trackId, t.name AS name, a.name AS artistName
         FROM scrobbles s
         JOIN tracks t ON t.id = s.track_id
         JOIN artists a ON a.id = t.artist_id
         WHERE s.album_id = ?
         GROUP BY t.id
         ORDER BY MIN(s.uts)`,
      )
      .all(albumId) as { trackId: number; name: string; artistName: string }[];

  /** Most recent push of this name to this service, if any -- lets the UI ask
   * "replace or add to it?" instead of silently duplicating a playlist. */
  app.get('/api/push/existing', async (req, reply) => {
    const q = req.query as { service?: string; name?: string };
    const service = q.service ? parseService(q.service) : null;
    if (!service || !q.name?.trim()) return reply.code(400).send({ error: 'service and name are required.' });
    const row = handle.sqlite
      .prepare(
        `SELECT service_playlist_id AS playlistId, created_at AS createdAt FROM playlist_log
         WHERE service = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(service, q.name.trim()) as { playlistId: string; createdAt: number } | undefined;
    if (!row) return { existing: null };
    const connector = makeConnector(service);
    return {
      existing: { playlistId: row.playlistId, playlistUrl: connector.deepLinkPlaylist(row.playlistId), createdAt: row.createdAt },
    };
  });

  app.post('/api/push', async (req, reply) => {
    const body = req.body as {
      recipe?: Recipe;
      service?: string;
      name?: string;
      description?: string;
      /** Optional subset of preview entity ids (tracks or albums, per mode). */
      selectedIds?: number[];
      mode?: 'new' | 'replace' | 'append';
      existingPlaylistId?: string;
    };
    const service = body.service ? parseService(body.service) : null;
    if (!service) return reply.code(400).send({ error: 'A valid service is required.' });
    if (!body.name?.trim()) return reply.code(400).send({ error: 'A playlist name is required.' });
    if (!body.recipe) return reply.code(400).send({ error: 'A recipe is required.' });
    if (!auth.isAuthorized(service)) return reply.code(400).send({ error: `Connect ${service} first.` });

    const preview = recipes.preview(body.recipe);
    const selected = body.selectedIds ? new Set(body.selectedIds) : null;
    const rows = preview.rows.filter((r) => !selected || selected.has(r.entityId));

    // Tracks push as-is; albums expand to their tracks (in preview order).
    const tracks =
      body.recipe.output.mode === 'tracks'
        ? rows.map((r) => ({ trackId: r.entityId, name: r.name, artistName: r.artistName }))
        : rows.flatMap((r) => expandAlbumTracks(r.entityId));
    if (tracks.length === 0) return reply.code(400).send({ error: 'Nothing selected to push.' });
    const connector = makeConnector(service);
    const name = body.name.trim();
    const description = body.description ?? 'Created by Blast From The Past';
    const mode = body.mode ?? 'new';
    if (mode !== 'new' && !body.existingPlaylistId) {
      return reply.code(400).send({ error: 'existingPlaylistId is required for replace/append.' });
    }

    lastPush = null;
    const started = jobs.start('push', async () => {
      lastPush = await pushPlaylist(handle, connector, service, name, description, tracks, jobs.reportProgress, {
        mode,
        existingPlaylistId: body.existingPlaylistId,
      });
    });
    if (!started) return reply.code(409).send({ error: 'A job is already running.' });
    return reply.code(202).send({ started: true, trackCount: tracks.length });
  });

  app.get('/api/push/result', async () => ({ result: lastPush }));

  // ---- Match fix-up ----

  app.get('/api/match/candidates', async (req, reply) => {
    const q = req.query as { service?: string; trackId?: string };
    const service = q.service ? parseService(q.service) : null;
    const trackId = Number(q.trackId);
    if (!service || !Number.isFinite(trackId)) {
      return reply.code(400).send({ error: 'service and trackId are required.' });
    }
    if (!auth.isAuthorized(service)) return reply.code(400).send({ error: `Connect ${service} first.` });
    const matcher = new ServiceMatcher(handle, makeConnector(service), service);
    return { candidates: await matcher.candidates(trackId) };
  });

  app.post('/api/match/override', async (req, reply) => {
    const body = req.body as { service?: string; trackId?: number; serviceId?: string };
    const service = body.service ? parseService(body.service) : null;
    if (!service || !body.trackId || !body.serviceId) {
      return reply.code(400).send({ error: 'service, trackId and serviceId are required.' });
    }
    new ServiceMatcher(handle, makeConnector(service), service).setOverride(body.trackId, body.serviceId);
    reply.code(204);
  });

  // ---- Deep links (Insights / Top artists -> resolved streaming-service entries) ----

  const DEEP_LINK_KINDS: LinkEntityKind[] = ['track', 'album', 'artist'];
  const DEEP_LINK_CONCURRENCY = 4;

  app.post('/api/deeplinks', async (req, reply) => {
    const body = req.body as { service?: string; items?: { kind?: string; entityId?: number }[] };
    const service = body.service ? parseService(body.service) : null;
    if (!service) return reply.code(400).send({ error: 'A valid service is required.' });
    const items = body.items ?? [];
    const links: (string | null)[] = new Array(items.length).fill(null);

    if (auth.isAuthorized(service)) {
      const connector = makeConnector(service);
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          const item = items[i];
          if (!item || !DEEP_LINK_KINDS.includes(item.kind as LinkEntityKind) || !item.entityId) continue;
          try {
            links[i] = await resolveDeepLink(handle, connector, service, item.kind as LinkEntityKind, item.entityId);
          } catch {
            links[i] = null; // best-effort: a lookup failure just falls back to search on the client
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DEEP_LINK_CONCURRENCY, items.length) }, worker));
    }
    return { links };
  });

  app.get('/api/presets', async () => PRESETS);

  app.get('/api/facets', async () => recipes.facets());

  app.post('/api/recipes/preview', async (req, reply) => {
    const recipe = req.body as Recipe | undefined;
    if (!recipe || !recipe.output || !Array.isArray(recipe.filters)) {
      return reply.code(400).send({ error: 'Invalid recipe.' });
    }
    try {
      return recipes.preview(recipe);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/recipes', async () => recipes.list());

  app.post('/api/recipes', async (req, reply) => {
    const body = req.body as { name?: string; definition?: Recipe } | undefined;
    if (!body?.name || !body.definition) {
      return reply.code(400).send({ error: 'name and definition are required.' });
    }
    return reply.code(201).send(recipes.create(body.name, body.definition));
  });

  app.put('/api/recipes/:id', async (req, reply) => {
    const body = req.body as { name?: string; definition?: Recipe } | undefined;
    const id = Number((req.params as { id: string }).id);
    if (!body?.name || !body.definition) {
      return reply.code(400).send({ error: 'name and definition are required.' });
    }
    if (!recipes.update(id, body.name, body.definition)) {
      return reply.code(404).send({ error: 'Recipe not found.' });
    }
    reply.code(204);
  });

  app.delete('/api/recipes/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!recipes.remove(id)) return reply.code(404).send({ error: 'Recipe not found.' });
    reply.code(204);
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
