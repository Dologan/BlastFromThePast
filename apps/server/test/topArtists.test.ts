import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import { rebuildStats } from '../src/sync/stats.js';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const YEAR = 365 * DAY;

describe('GET /api/library/top-artists', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  const mkArtist = (name: string) =>
    Number(
      handle.sqlite
        .prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)')
        .run(name, name.toLowerCase()).lastInsertRowid,
    );
  const mkTrack = (artistId: number, name: string) =>
    Number(
      handle.sqlite
        .prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)')
        .run(artistId, name, name.toLowerCase()).lastInsertRowid,
    );
  const scrobble = (trackId: number, uts: number) =>
    handle.sqlite.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(trackId, uts);

  it('ranks all-time by the materialized artist_stats, and a recent range live from scrobbles', async () => {
    handle = openDb(':memory:');
    // Old favourite: lots of plays, all long ago (outside any recent range).
    const oldFav = mkArtist('Old Favourite');
    const t1 = mkTrack(oldFav, 'Song');
    for (let i = 0; i < 10; i++) scrobble(t1, NOW - 2 * YEAR - i * DAY);
    // New obsession: fewer total plays, but all this week.
    const newObsession = mkArtist('New Obsession');
    const t2 = mkTrack(newObsession, 'Song');
    for (let i = 0; i < 3; i++) scrobble(t2, NOW - i * DAY);
    rebuildStats(handle.sqlite);

    const app = buildApp({ handle });

    const all = (await app.inject({ method: 'GET', url: '/api/library/top-artists?range=all' })).json();
    expect(all.artists[0]).toMatchObject({ name: 'Old Favourite', playcount: 10 });

    const week = (await app.inject({ method: 'GET', url: '/api/library/top-artists?range=week' })).json();
    expect(week.artists.map((a: any) => a.name)).toEqual(['New Obsession']);
    expect(week.artists[0].playcount).toBe(3);

    // Deep links present and artist-typed.
    expect(all.artists[0].spotifyUrl).toContain('artists');
    expect(all.artists[0].tidalUrl).toContain('artists');

    await app.close();
  });

  it('rejects an unknown range', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });
    const res = await app.inject({ method: 'GET', url: '/api/library/top-artists?range=decade' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
