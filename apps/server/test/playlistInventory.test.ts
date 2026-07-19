import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { syncPlaylistInventory } from '../src/sync/playlistInventory.js';
import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';

class FakePlaylistConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  constructor(
    private readonly playlists: { serviceId: string; name: string; isOwn: boolean }[],
    private readonly items: Record<string, { serviceTrackId: string; name?: string; artistName?: string; isrc?: string }[]>,
  ) {}
  async isAuthorized() {
    return true;
  }
  async searchTrack(_q: TrackQuery): Promise<ServiceTrack[]> {
    return [];
  }
  async createPlaylist() {
    return 'unused';
  }
  async setPlaylistTracks() {}
  async listPlaylists() {
    return this.playlists;
  }
  async getPlaylistItems(playlistId: string) {
    return this.items[playlistId] ?? [];
  }
  deepLinkTrack(id: string) {
    return `https://open.spotify.com/track/${id}`;
  }
  deepLinkAlbum(id: string) {
    return `https://open.spotify.com/album/${id}`;
  }
  deepLinkArtist(id: string) {
    return `https://open.spotify.com/artist/${id}`;
  }
  deepLinkPlaylist(id: string) {
    return `https://open.spotify.com/playlist/${id}`;
  }
}

function seedTrack(handle: DbHandle, artistName: string, trackName: string, isrc?: string): number {
  const s = handle.sqlite;
  const artist = Number(
    s.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artistName, artistName.toLowerCase()).lastInsertRowid,
  );
  return Number(
    s
      .prepare('INSERT INTO tracks (artist_id, name, name_normalized, isrc) VALUES (?, ?, ?, ?)')
      .run(artist, trackName, trackName.toLowerCase(), isrc ?? null).lastInsertRowid,
  );
}

describe('syncPlaylistInventory', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('matches items by service_links first, then ISRC, then normalized name, and leaves the rest unmatched', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const linkedTrack = seedTrack(handle, 'Opeth', 'Ghost of Perdition');
    const isrcTrack = seedTrack(handle, 'Metallica', 'Master of Puppets', 'US1234567890');
    const nameTrack = seedTrack(handle, 'Miles Davis', 'So What');
    s.prepare(
      `INSERT INTO service_links (entity_type, entity_id, service, service_id, method, confidence, verified, matched_at)
       VALUES ('track', ?, 'spotify', 'sp-linked', 'manual', 1, 1, 0)`,
    ).run(linkedTrack);

    const connector = new FakePlaylistConnector(
      [{ serviceId: 'pl1', name: 'My Mix', isOwn: true }],
      {
        pl1: [
          { serviceTrackId: 'sp-linked', name: 'Some Other Title', artistName: 'Some Other Artist' }, // matched via service_links despite mismatched name
          { serviceTrackId: 'sp-isrc', isrc: 'US1234567890' },
          { serviceTrackId: 'sp-name', name: 'So What', artistName: 'Miles Davis' },
          { serviceTrackId: 'sp-unknown', name: 'Totally Unknown Song', artistName: 'Nobody' },
        ],
      },
    );

    const result = await syncPlaylistInventory(handle, connector, 'spotify');
    expect(result).toEqual({ playlists: 1, tracks: 4, matchedTracks: 3 });

    const rows = s
      .prepare('SELECT service_track_id AS serviceTrackId, track_id AS trackId FROM service_playlist_tracks ORDER BY service_track_id')
      .all() as { serviceTrackId: string; trackId: number | null }[];
    const byId = Object.fromEntries(rows.map((r) => [r.serviceTrackId, r.trackId]));
    expect(byId['sp-linked']).toBe(linkedTrack);
    expect(byId['sp-isrc']).toBe(isrcTrack);
    expect(byId['sp-name']).toBe(nameTrack);
    expect(byId['sp-unknown']).toBeNull();
  });

  it('upserts the playlist row and reports progress per playlist', async () => {
    handle = openDb(':memory:');
    const connector = new FakePlaylistConnector(
      [
        { serviceId: 'pl1', name: 'A', isOwn: true },
        { serviceId: 'pl2', name: 'B', isOwn: false },
      ],
      { pl1: [], pl2: [] },
    );
    const progress: { playlistsDone: number; playlistsTotal: number }[] = [];
    await syncPlaylistInventory(handle, connector, 'spotify', (p) => progress.push({ playlistsDone: p.playlistsDone, playlistsTotal: p.playlistsTotal }));

    const rows = handle.sqlite.prepare('SELECT service, service_playlist_id AS id, name, is_own AS isOwn FROM service_playlists ORDER BY id').all();
    expect(rows).toEqual([
      { service: 'spotify', id: 'pl1', name: 'A', isOwn: 1 },
      { service: 'spotify', id: 'pl2', name: 'B', isOwn: 0 },
    ]);
    expect(progress[0]).toEqual({ playlistsDone: 0, playlistsTotal: 2 });
    expect(progress[progress.length - 1]).toEqual({ playlistsDone: 2, playlistsTotal: 2 });
  });

  it('re-syncing a playlist replaces its items rather than accumulating duplicates', async () => {
    handle = openDb(':memory:');
    const track = seedTrack(handle, 'Opeth', 'Ghost of Perdition');
    const firstRun = new FakePlaylistConnector(
      [{ serviceId: 'pl1', name: 'Mix', isOwn: true }],
      { pl1: [{ serviceTrackId: 'sp-a', name: 'Ghost of Perdition', artistName: 'Opeth' }] },
    );
    await syncPlaylistInventory(handle, firstRun, 'spotify');
    expect((handle.sqlite.prepare('SELECT COUNT(*) c FROM service_playlist_tracks').get() as any).c).toBe(1);

    // Re-sync with a different track list -- the old item should be gone, not just added-to.
    const secondRun = new FakePlaylistConnector(
      [{ serviceId: 'pl1', name: 'Mix', isOwn: true }],
      { pl1: [{ serviceTrackId: 'sp-b', name: 'Some New Song', artistName: 'Someone' }] },
    );
    await syncPlaylistInventory(handle, secondRun, 'spotify');
    const rows = handle.sqlite.prepare('SELECT service_track_id AS id FROM service_playlist_tracks').all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['sp-b']);
    void track;
  });

  it('throws a clear error when the connector does not support playlist listing', async () => {
    handle = openDb(':memory:');
    const noop: ServiceConnector = {
      service: 'tidal',
      isAuthorized: async () => true,
      searchTrack: async () => [],
      createPlaylist: async () => 'x',
      setPlaylistTracks: async () => {},
      deepLinkTrack: (id) => id,
      deepLinkAlbum: (id) => id,
      deepLinkArtist: (id) => id,
      deepLinkPlaylist: (id) => id,
    };
    await expect(syncPlaylistInventory(handle, noop, 'tidal')).rejects.toThrow(/does not support playlist listing/);
  });
});
