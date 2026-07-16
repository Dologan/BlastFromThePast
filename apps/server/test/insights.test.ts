import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { computeGaps, computeNeglected } from '../src/stats/insights.js';
import { rebuildStats } from '../src/sync/stats.js';
import { buildApp } from '../src/app.js';

const NOW = 1_800_000_000;
const DAY = 86400;

describe('insights: gaps & neglected', () => {
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
  const mkAlbum = (artistId: number, name: string) =>
    Number(
      handle.sqlite
        .prepare('INSERT INTO albums (artist_id, name, name_normalized) VALUES (?, ?, ?)')
        .run(artistId, name, name.toLowerCase()).lastInsertRowid,
    );
  const scrobble = (trackId: number, uts: number, albumId?: number) =>
    handle.sqlite
      .prepare('INSERT INTO scrobbles (track_id, album_id, uts) VALUES (?, ?, ?)')
      .run(trackId, albumId ?? null, uts);

  beforeEach(() => {
    handle = openDb(':memory:');
  });

  it('ranks by the longest ongoing silence among things played more than once', () => {
    const a = mkArtist('Opeth');
    // "Ghosted": played a lot, then nothing for 3 years — the biggest ongoing gap.
    const ghosted = mkTrack(a, 'Ghosted');
    scrobble(ghosted, NOW - 5 * 365 * DAY);
    scrobble(ghosted, NOW - 5 * 365 * DAY + DAY);
    scrobble(ghosted, NOW - 3 * 365 * DAY); // last play 3 years ago
    // "Steady": played weekly, up to recently — tiny ongoing gap.
    const steady = mkTrack(a, 'Steady');
    for (let i = 0; i < 5; i++) scrobble(steady, NOW - i * 7 * DAY);
    // "Once": a single play — must not appear (needs playcount >= 2).
    const once = mkTrack(a, 'Once');
    scrobble(once, NOW - 4 * 365 * DAY);
    rebuildStats(handle.sqlite);

    const gaps = computeGaps(handle.sqlite, 'tracks', 15, NOW);
    expect(gaps[0]!.name).toBe('Ghosted');
    expect(Math.round(gaps[0]!.gapSeconds / DAY / 365)).toBe(3);
    expect(gaps.map((g) => g.name)).not.toContain('Once');
    expect(gaps.map((g) => g.name)).toContain('Steady');
  });

  it('computes album gaps from album-linked scrobbles only', () => {
    const a = mkArtist('Opeth');
    const alb = mkAlbum(a, 'Ghost Reveries');
    const t = mkTrack(a, 'Ghost of Perdition');
    scrobble(t, NOW - 500 * DAY, alb);
    scrobble(t, NOW - 400 * DAY, alb);
    const loose = mkTrack(a, 'No Album Track');
    scrobble(loose, NOW - 800 * DAY);
    scrobble(loose, NOW - 700 * DAY);
    rebuildStats(handle.sqlite);

    const gaps = computeGaps(handle.sqlite, 'albums', 15, NOW);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.name).toBe('Ghost Reveries');
    expect(Math.round(gaps[0]!.gapSeconds / DAY)).toBe(400);
  });

  it('supports the artists kind, with a null artistName', () => {
    const a = mkArtist('Opeth');
    const t = mkTrack(a, 'Harvest');
    scrobble(t, NOW - 400 * DAY);
    scrobble(t, NOW - 300 * DAY);
    rebuildStats(handle.sqlite);

    const gaps = computeGaps(handle.sqlite, 'artists', 15, NOW);
    expect(gaps[0]!.name).toBe('Opeth');
    expect(gaps[0]!.artistName).toBeNull();
  });

  it('neglected samples items silent for at least the given window, ignoring recent ones', () => {
    const a = mkArtist('Opeth');
    const stale = mkTrack(a, 'Stale');
    scrobble(stale, NOW - 200 * DAY);
    const fresh = mkTrack(a, 'Fresh');
    scrobble(fresh, NOW - 5 * DAY);
    rebuildStats(handle.sqlite);

    const neglected = computeNeglected(handle.sqlite, 'tracks', 90, 15, NOW);
    expect(neglected.map((n) => n.name)).toEqual(['Stale']);
  });

  it('is served by /api/library/insights, including the artists kind', async () => {
    const a = mkArtist('Opeth');
    const t = mkTrack(a, 'Harvest');
    scrobble(t, NOW - 300 * DAY);
    scrobble(t, NOW - 200 * DAY);
    rebuildStats(handle.sqlite);

    const app = buildApp({ handle });
    const res = await app.inject({ method: 'GET', url: '/api/library/insights?kind=tracks&days=365' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('tracks');
    expect(body.days).toBe(365);
    expect(body.gaps[0].name).toBe('Harvest');
    expect(Array.isArray(body.neglected)).toBe(true);

    const artists = await app.inject({ method: 'GET', url: '/api/library/insights?kind=artists' });
    expect(artists.statusCode).toBe(200);
    expect(artists.json().kind).toBe('artists');

    const bad = await app.inject({ method: 'GET', url: '/api/library/insights?kind=songs' });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
