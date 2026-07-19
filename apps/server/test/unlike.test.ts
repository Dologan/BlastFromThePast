import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { UnlikeService } from '../src/unlike/unlikeService.js';
import { rebuildStats } from '../src/sync/stats.js';
import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';

const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365 * 86400;

class FakeRemoveConnector implements ServiceConnector {
  removedCalls: string[][] = [];
  constructor(readonly service: 'spotify' | 'tidal') {}
  async isAuthorized() {
    return true;
  }
  async searchTrack(_q: TrackQuery): Promise<ServiceTrack[]> {
    return [];
  }
  async createPlaylist() {
    return 'x';
  }
  async setPlaylistTracks() {}
  async removeLikedTracks(ids: string[]): Promise<void> {
    this.removedCalls.push(ids);
  }
  deepLinkTrack(id: string) {
    return id;
  }
  deepLinkAlbum(id: string) {
    return id;
  }
  deepLinkArtist(id: string) {
    return id;
  }
  deepLinkPlaylist(id: string) {
    return id;
  }
}

function seedLikedTrack(
  handle: DbHandle,
  artistName: string,
  trackName: string,
  opts: { plays?: number; lastListenAgoDays?: number; sources?: string[]; protectedFlag?: boolean } = {},
): number {
  const s = handle.sqlite;
  const artist = Number(
    s.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artistName, artistName.toLowerCase()).lastInsertRowid,
  );
  const track = Number(
    s
      .prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)')
      .run(artist, trackName, trackName.toLowerCase()).lastInsertRowid,
  );
  const plays = opts.plays ?? 1;
  const lastAgo = (opts.lastListenAgoDays ?? 1) * 86400;
  for (let i = 0; i < plays; i++) {
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(track, NOW - lastAgo - i * 3600);
  }
  for (const source of opts.sources ?? ['lastfm']) {
    s.prepare('INSERT INTO liked_tracks (track_id, source, liked_at, protected) VALUES (?, ?, ?, ?)').run(
      track,
      source,
      NOW - YEAR,
      opts.protectedFlag ? 1 : 0,
    );
  }
  return track;
}

describe('UnlikeService.preview', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('filters by maxPlaycount and notPlayedInDays, and reports protected + sources', async () => {
    handle = openDb(':memory:');
    const keep = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { plays: 2, lastListenAgoDays: 1200, sources: ['lastfm', 'spotify'] });
    const tooManyPlays = seedLikedTrack(handle, 'Metallica', 'One', { plays: 50, lastListenAgoDays: 1200 });
    const playedRecently = seedLikedTrack(handle, 'Miles Davis', 'So What', { plays: 2, lastListenAgoDays: 5 });
    rebuildStats(handle.sqlite);

    const service = new UnlikeService(handle);
    const rows = service.preview({ maxPlaycount: 10, notPlayedInDays: 1000 });
    const ids = rows.map((r) => r.trackId);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(tooManyPlays);
    expect(ids).not.toContain(playedRecently);

    const keepRow = rows.find((r) => r.trackId === keep)!;
    expect(keepRow.sources.sort()).toEqual(['lastfm', 'spotify']);
    expect(keepRow.protected).toBe(false);
  });

  it('protected rows are included in preview but flagged', async () => {
    handle = openDb(':memory:');
    const protectedTrack = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { plays: 1, lastListenAgoDays: 1200, protectedFlag: true });
    rebuildStats(handle.sqlite);

    const rows = new UnlikeService(handle).preview({});
    const row = rows.find((r) => r.trackId === protectedTrack)!;
    expect(row.protected).toBe(true);
  });

  it('inPlaylistOn filters to tracks present in a playlist, scoped by service when an array is given', async () => {
    handle = openDb(':memory:');
    const inSpotifyPlaylist = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { plays: 1, lastListenAgoDays: 1200 });
    const notInAnyPlaylist = seedLikedTrack(handle, 'Metallica', 'One', { plays: 1, lastListenAgoDays: 1200 });
    rebuildStats(handle.sqlite);

    const s = handle.sqlite;
    const plId = Number(
      s.prepare("INSERT INTO service_playlists (service, service_playlist_id, name, is_own, fetched_at) VALUES ('spotify','pl1','My Mix',1,0)").run().lastInsertRowid,
    );
    s.prepare('INSERT INTO service_playlist_tracks (playlist_id, service_track_id, track_id) VALUES (?, ?, ?)').run(plId, 'sp-1', inSpotifyPlaylist);

    const service = new UnlikeService(handle);
    const anyRows = service.preview({ inPlaylistOn: 'any' });
    expect(anyRows.map((r) => r.trackId)).toEqual([inSpotifyPlaylist]);

    const tidalScoped = service.preview({ inPlaylistOn: ['tidal'] });
    expect(tidalScoped).toHaveLength(0);

    const spotifyScoped = service.preview({ inPlaylistOn: ['spotify'] });
    expect(spotifyScoped.map((r) => r.trackId)).toEqual([inSpotifyPlaylist]);
    expect(spotifyScoped[0]!.playlistNames).toEqual(['My Mix']);

    void notInAnyPlaylist;
  });
});

describe('UnlikeService.execute', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('never unlikes a protected track, even if the payload asks to', async () => {
    handle = openDb(':memory:');
    const protectedTrack = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { protectedFlag: true });
    rebuildStats(handle.sqlite);

    const service = new UnlikeService(handle);
    const result = await service.execute([protectedTrack], true, {});
    expect(result.unliked).toBe(0);
    expect(result.skipped).toEqual([{ trackId: protectedTrack, reason: 'protected' }]);
    expect((handle.sqlite.prepare('SELECT COUNT(*) c FROM liked_tracks WHERE track_id = ?').get(protectedTrack) as any).c).toBe(1);
  });

  it('batches Spotify removeLikedTracks calls and deletes the local rows once removed', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const track = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { sources: ['spotify'] });
    s.prepare(
      `INSERT INTO service_links (entity_type, entity_id, service, service_id, method, confidence, verified, matched_at)
       VALUES ('track', ?, 'spotify', 'sp-ghost', 'manual', 1, 1, 0)`,
    ).run(track);
    rebuildStats(s);

    const connector = new FakeRemoveConnector('spotify');
    const service = new UnlikeService(handle);
    const result = await service.execute([track], false, { spotify: connector });

    expect(connector.removedCalls).toEqual([['sp-ghost']]);
    expect(result.spotifyRemoved).toBe(1);
    expect(result.unliked).toBe(1);
    expect((s.prepare('SELECT COUNT(*) c FROM liked_tracks WHERE track_id = ?').get(track) as any).c).toBe(0);
  });

  it('Last.fm-only likes are skipped with a reason when not localOnly, and no connector call is made', async () => {
    handle = openDb(':memory:');
    const track = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { sources: ['lastfm'] });
    rebuildStats(handle.sqlite);

    const service = new UnlikeService(handle);
    const result = await service.execute([track], false, {});
    expect(result.unliked).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/Last\.fm/);
    expect((handle.sqlite.prepare('SELECT COUNT(*) c FROM liked_tracks WHERE track_id = ?').get(track) as any).c).toBe(1);
  });

  it('localOnly deletes local rows for any source, including Last.fm-only, without calling any connector', async () => {
    handle = openDb(':memory:');
    const track = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { sources: ['lastfm'] });
    rebuildStats(handle.sqlite);

    const connector = new FakeRemoveConnector('spotify');
    const service = new UnlikeService(handle);
    const result = await service.execute([track], true, { spotify: connector });

    expect(connector.removedCalls).toEqual([]);
    expect(result.localOnlyRemoved).toBe(1);
    expect(result.unliked).toBe(1);
    expect((handle.sqlite.prepare('SELECT COUNT(*) c FROM liked_tracks WHERE track_id = ?').get(track) as any).c).toBe(0);
  });

  it('protectTrack toggles the flag for all liked_tracks rows of that track', async () => {
    handle = openDb(':memory:');
    const track = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition', { sources: ['lastfm', 'spotify'] });
    rebuildStats(handle.sqlite);

    const service = new UnlikeService(handle);
    service.protectTrack(track, true);
    const rows = handle.sqlite.prepare('SELECT protected FROM liked_tracks WHERE track_id = ?').all(track) as { protected: number }[];
    expect(rows.every((r) => r.protected === 1)).toBe(true);

    service.protectTrack(track, false);
    const rows2 = handle.sqlite.prepare('SELECT protected FROM liked_tracks WHERE track_id = ?').all(track) as { protected: number }[];
    expect(rows2.every((r) => r.protected === 0)).toBe(true);
  });

  it('reports progress per track processed', async () => {
    handle = openDb(':memory:');
    const t1 = seedLikedTrack(handle, 'Opeth', 'Ghost of Perdition');
    const t2 = seedLikedTrack(handle, 'Metallica', 'One');
    rebuildStats(handle.sqlite);

    const service = new UnlikeService(handle);
    const progress: { processed: number; total: number }[] = [];
    await service.execute([t1, t2], true, {}, (p) => progress.push({ processed: p.processed, total: p.total }));
    expect(progress).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
  });
});
