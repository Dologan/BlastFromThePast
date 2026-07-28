import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import type { LastfmClient } from '../src/lastfm/client.js';
import type { MusicBrainzClient } from '../src/enrich/musicbrainz.js';

/**
 * End-to-end route test: POST /api/enrich runs the job through the JobManager,
 * and /api/library/summary reflects country + genre stats. Clients are faked so
 * no network is touched.
 */
describe('enrichment API', () => {
  let handle: DbHandle | undefined;
  afterEach(() => handle?.close());

  it('enriches via the route and surfaces genre/country stats in the summary', async () => {
    handle = openDb(':memory:');
    // Two artists with scrobbles so artist_stats (playcount weighting) exists.
    const seed = handle.sqlite;
    const a1 = Number(
      seed.prepare('INSERT INTO artists (name, name_normalized, mbid) VALUES (?, ?, ?)').run('Opeth', 'opeth', 'mb-opeth').lastInsertRowid,
    );
    const a2 = Number(
      seed.prepare('INSERT INTO artists (name, name_normalized, mbid) VALUES (?, ?, ?)').run('Katatonia', 'katatonia', 'mb-kata').lastInsertRowid,
    );
    const t1 = Number(seed.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(a1, 'X', 'x').lastInsertRowid);
    const t2 = Number(seed.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(a2, 'Y', 'y').lastInsertRowid);
    seed.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t1, 1000);
    seed.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t1, 2000);
    seed.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t2, 3000);
    seed.prepare("INSERT INTO settings (key, value) VALUES ('lastfm.apiKey', 'k')").run();
    seed.prepare(`INSERT INTO artist_stats VALUES (?, 1000, 2000, 2, '1970-01', 2)`).run(a1);
    seed.prepare(`INSERT INTO artist_stats VALUES (?, 3000, 3000, 1, '1970-01', 1)`).run(a2);

    const fakeMb = {
      async searchArtist() {
        return null;
      },
      async lookupArtist(mbid: string) {
        const map: Record<string, { country: string; genre: string }> = {
          'mb-opeth': { country: 'SE', genre: 'progressive metal' },
          'mb-kata': { country: 'SE', genre: 'doom metal' },
        };
        const r = map[mbid];
        return r
          ? { mbid, country: r.country, genres: [{ name: r.genre, weight: 10 }], tags: [] }
          : null;
      },
    } as unknown as MusicBrainzClient;
    const fakeLastfm = {
      async getArtistTopTags() {
        return [];
      },
    } as unknown as LastfmClient;

    const app = buildApp({
      handle,
      createLastfmClient: () => fakeLastfm,
      createMusicBrainzClient: () => fakeMb,
    });

    const start = await app.inject({ method: 'POST', url: '/api/enrich' });
    expect(start.statusCode).toBe(202);

    // Wait for the background job to finish.
    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const summary = (await app.inject({ method: 'GET', url: '/api/library/summary' })).json();
    expect(summary.enrichment).toEqual({ enriched: 2, pending: 0, errored: 0, withCountry: 2 });
    // Sweden weighted by 2+1 = 3 plays.
    expect(summary.topCountries).toEqual([{ name: 'SE', weight: 3 }]);
    // progressive metal (Opeth, 2 plays) outranks doom metal (Katatonia, 1 play).
    expect(summary.topGenres[0]).toEqual({ name: 'progressive metal', weight: 2 });
    expect(summary.topGenres).toContainEqual({ name: 'doom metal', weight: 1 });

    await app.close();
  });

  it('reprocesses from cache via the route without an API key or any client calls', async () => {
    handle = openDb(':memory:');
    const seed = handle.sqlite;
    const a1 = Number(
      seed
        .prepare('INSERT INTO artists (name, name_normalized, mbid) VALUES (?, ?, ?)')
        .run('Opeth', 'opeth', 'mb-opeth').lastInsertRowid,
    );
    // Pre-populate the cache as if a fetch already happened, with no API key set.
    seed
      .prepare(
        `INSERT INTO mb_artist_cache (mbid, found, country, genres_json, tags_json, fetched_at)
         VALUES ('mb-opeth', 1, 'SE', '[{"name":"progressive metal","weight":5}]', '[]', 0)`,
      )
      .run();

    let clientFactoryCalls = 0;
    const app = buildApp({
      handle,
      createLastfmClient: () => {
        clientFactoryCalls++;
        throw new Error('should not be called during reprocess');
      },
      createMusicBrainzClient: () => {
        clientFactoryCalls++;
        throw new Error('should not be called during reprocess');
      },
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/enrich',
      payload: { reprocess: true },
    });
    expect(start.statusCode).toBe(202);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(clientFactoryCalls).toBe(0);
    const artist = seed.prepare('SELECT country FROM artists WHERE id = ?').get(a1) as {
      country: string | null;
    };
    expect(artist.country).toBe('SE');

    await app.close();
  });

  it('enriches album release dates via /api/enrich/albums and surfaces them in the summary', async () => {
    handle = openDb(':memory:');
    const seed = handle.sqlite;
    const a1 = Number(
      seed.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run('Opeth', 'opeth').lastInsertRowid,
    );
    seed
      .prepare('INSERT INTO albums (artist_id, name, name_normalized, mbid) VALUES (?, ?, ?, ?)')
      .run(a1, 'Ghost Reveries', 'ghost reveries', 'rg-ghost-reveries');

    const fakeMb = {
      async searchReleaseGroup() {
        return null;
      },
      async lookupReleaseGroup(mbid: string) {
        return mbid === 'rg-ghost-reveries' ? { firstReleaseDate: '2005-08-24' } : null;
      },
    } as unknown as MusicBrainzClient;

    // Deliberately no createLastfmClient / API key -- album enrichment is
    // MusicBrainz-only and must not need either.
    const app = buildApp({ handle, createMusicBrainzClient: () => fakeMb });

    const start = await app.inject({ method: 'POST', url: '/api/enrich/albums' });
    expect(start.statusCode).toBe(202);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const summary = (await app.inject({ method: 'GET', url: '/api/library/summary' })).json();
    expect(summary.albumEnrichment).toEqual({ enriched: 1, pending: 0, errored: 0, withDate: 1 });

    await app.close();
  });

  it('reprocesses album release dates from cache via the route with zero client calls', async () => {
    handle = openDb(':memory:');
    const seed = handle.sqlite;
    const a1 = Number(
      seed.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run('Opeth', 'opeth').lastInsertRowid,
    );
    const album = Number(
      seed
        .prepare('INSERT INTO albums (artist_id, name, name_normalized, mbid) VALUES (?, ?, ?, ?)')
        .run(a1, 'Ghost Reveries', 'ghost reveries', 'rg-ghost-reveries').lastInsertRowid,
    );
    // Pre-populate the cache as if a fetch already happened.
    seed
      .prepare(
        `INSERT INTO mb_release_group_cache (mbid, found, release_date, fetched_at)
         VALUES ('rg-ghost-reveries', 1, '2005-08-24', 0)`,
      )
      .run();

    let clientFactoryCalls = 0;
    const app = buildApp({
      handle,
      createMusicBrainzClient: () => {
        clientFactoryCalls++;
        throw new Error('should not be called during reprocess');
      },
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/enrich/albums',
      payload: { reprocess: true },
    });
    expect(start.statusCode).toBe(202);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(clientFactoryCalls).toBe(0);
    const row = seed.prepare('SELECT release_date FROM albums WHERE id = ?').get(album) as { release_date: string | null };
    expect(row.release_date).toBe('2005-08-24');

    await app.close();
  });
});
