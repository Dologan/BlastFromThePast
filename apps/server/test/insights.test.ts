import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { computeGaps, computeClimbers } from '../src/stats/insights.js';
import { rebuildStats } from '../src/sync/stats.js';
import { buildApp } from '../src/app.js';

const NOW = 1_800_000_000;
const DAY = 86400;

describe('insights: gaps & climbers', () => {
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

  it('finds the widest bridged gap per track and ranks by it', () => {
    const a = mkArtist('Opeth');
    // "Comeback": played, 2-year silence, played again — the biggest gap.
    const comeback = mkTrack(a, 'Comeback');
    scrobble(comeback, NOW - 900 * DAY);
    scrobble(comeback, NOW - 170 * DAY); // 730-day gap
    scrobble(comeback, NOW - 100 * DAY);
    // "Steady": played weekly — tiny gaps.
    const steady = mkTrack(a, 'Steady');
    for (let i = 0; i < 5; i++) scrobble(steady, NOW - i * 7 * DAY);
    // "Once": a single play — no gap at all, must not appear.
    const once = mkTrack(a, 'Once');
    scrobble(once, NOW - 400 * DAY);
    rebuildStats(handle.sqlite);

    const gaps = computeGaps(handle.sqlite, 'tracks');
    expect(gaps[0]!.name).toBe('Comeback');
    expect(Math.round(gaps[0]!.gapSeconds / DAY)).toBe(730);
    expect(gaps[0]!.gapEnd).toBe(NOW - 170 * DAY);
    expect(gaps.map((g) => g.name)).not.toContain('Once');
  });

  it('computes album gaps from album-linked scrobbles only', () => {
    const a = mkArtist('Opeth');
    const alb = mkAlbum(a, 'Ghost Reveries');
    const t = mkTrack(a, 'Ghost of Perdition');
    scrobble(t, NOW - 500 * DAY, alb);
    scrobble(t, NOW - 10 * DAY, alb);
    const loose = mkTrack(a, 'No Album Track');
    scrobble(loose, NOW - 800 * DAY);
    scrobble(loose, NOW - DAY);
    rebuildStats(handle.sqlite);

    const gaps = computeGaps(handle.sqlite, 'albums');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.name).toBe('Ghost Reveries');
    expect(Math.round(gaps[0]!.gapSeconds / DAY)).toBe(490);
  });

  it('ranks climbers by places gained in the window, ignoring new arrivals', () => {
    const a = mkArtist('Various');
    // Old favourite: 10 old plays, none recent (should not climb).
    const fav = mkTrack(a, 'Old Favourite');
    for (let i = 0; i < 10; i++) scrobble(fav, NOW - 400 * DAY + i * DAY);
    // Rediscovered: 2 old plays, 6 recent — jumps over the middle one.
    const redis = mkTrack(a, 'Rediscovered');
    scrobble(redis, NOW - 500 * DAY);
    scrobble(redis, NOW - 450 * DAY);
    for (let i = 0; i < 6; i++) scrobble(redis, NOW - 10 * DAY + i * 3600);
    // Middle: 4 old plays, none recent.
    const mid = mkTrack(a, 'Middle');
    for (let i = 0; i < 4; i++) scrobble(mid, NOW - 300 * DAY + i * DAY);
    // Brand new: first played inside the window — excluded by design.
    const brandNew = mkTrack(a, 'Brand New');
    for (let i = 0; i < 3; i++) scrobble(brandNew, NOW - 5 * DAY + i * 3600);
    rebuildStats(handle.sqlite);

    const climbers = computeClimbers(handle.sqlite, 'tracks', 90, 15, NOW);
    expect(climbers.map((c) => c.name)).toEqual(['Rediscovered']);
    // Then: fav(10)=1, mid(4)=2, redis(2)=3. Now: fav(10)=1, redis(8)=2,
    // mid(4)=3, new(3)=4 — redis climbed 3→2.
    expect(climbers[0]!.rankThen).toBe(3);
    expect(climbers[0]!.rankNow).toBe(2);
    expect(climbers[0]!.climb).toBe(1);
  });

  it('is served by /api/library/insights', async () => {
    const a = mkArtist('Opeth');
    const t = mkTrack(a, 'Harvest');
    scrobble(t, NOW - 300 * DAY);
    scrobble(t, NOW - 10 * DAY);
    rebuildStats(handle.sqlite);

    const app = buildApp({ handle });
    const res = await app.inject({ method: 'GET', url: '/api/library/insights?kind=tracks&days=30' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('tracks');
    expect(body.days).toBe(30);
    expect(body.gaps[0].name).toBe('Harvest');
    expect(Array.isArray(body.climbers)).toBe(true);

    const bad = await app.inject({ method: 'GET', url: '/api/library/insights?kind=artists' });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
