import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { TidalConnector } from '../src/connectors/tidal.js';
import { importServiceLiked } from '../src/sync/spotifyLiked.js';
import type { ConnectorFetch } from '../src/connectors/http.js';
import type { ServiceConnector, ServiceTrack } from '@bftp/core';

const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365 * 86400;

interface Recorded {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function recorder(responder: (url: string, method: string) => unknown): { fetchImpl: ConnectorFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: ConnectorFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const body = responder(url, init.method);
    return {
      ok: true,
      status: body === undefined ? 204 : 200,
      json: async () => body,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

const token = async () => 'AT';

describe('TidalConnector.getLikedTracks / removeLikedTracks', () => {
  it('paginates userCollectionTracks items via page[cursor], resolving track attributes from included', async () => {
    const { fetchImpl } = recorder((url) => {
      if (url.includes('page[cursor]=CURSOR1')) {
        return {
          data: [{ id: 't2', type: 'tracks', meta: { addedAt: '2021-06-01T00:00:00Z' } }],
          included: [{ type: 'tracks', id: 't2', attributes: { title: 'One', isrc: 'X2' }, relationships: { artists: { data: [{ id: 'a2' }] } } }, { type: 'artists', id: 'a2', attributes: { name: 'Metallica' } }],
        };
      }
      return {
        data: [{ id: 't1', type: 'tracks', meta: { addedAt: '2020-01-01T00:00:00Z' } }],
        included: [
          { type: 'tracks', id: 't1', attributes: { title: 'Ghost of Perdition', isrc: 'X1' }, relationships: { artists: { data: [{ id: 'a1' }] } } },
          { type: 'artists', id: 'a1', attributes: { name: 'Opeth' } },
        ],
        links: { meta: { nextCursor: 'CURSOR1' } },
      };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    const seen: { serviceId: string; name: string; artistName: string; likedAt?: number }[] = [];
    for await (const { track, likedAt } of c.getLikedTracks!()) {
      seen.push({ serviceId: track.serviceId, name: track.name, artistName: track.artistName, likedAt });
    }
    expect(seen).toEqual([
      { serviceId: 't1', name: 'Ghost of Perdition', artistName: 'Opeth', likedAt: Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000) },
      { serviceId: 't2', name: 'One', artistName: 'Metallica', likedAt: Math.floor(Date.parse('2021-06-01T00:00:00Z') / 1000) },
    ]);
  });

  it('removeLikedTracks batches DELETEs and sends an Idempotency-Key header per batch', async () => {
    const { fetchImpl, calls } = recorder(() => undefined);
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    const ids = Array.from({ length: 45 }, (_, i) => `t${i}`);
    await c.removeLikedTracks!(ids);

    const deleteCalls = calls.filter((call) => call.method === 'DELETE' && call.url.includes('/userCollectionTracks/me/relationships/items'));
    expect(deleteCalls.length).toBe(3); // 20 + 20 + 5
    for (const call of deleteCalls) expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(new Set(deleteCalls.map((c) => c.headers['Idempotency-Key'])).size).toBe(3); // a fresh key per batch
    expect(JSON.parse(deleteCalls[0]!.body!).data).toHaveLength(20);
    expect(JSON.parse(deleteCalls[0]!.body!).data[0]).toEqual({ id: 't0', type: 'tracks' });
    expect(JSON.parse(deleteCalls[2]!.body!).data).toHaveLength(5);
  });
});

function seedArtistTrack(handle: DbHandle, artistName: string, trackName: string): number {
  const s = handle.sqlite;
  const artist = Number(
    s.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artistName, artistName.toLowerCase()).lastInsertRowid,
  );
  const track = Number(
    s
      .prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)')
      .run(artist, trackName, trackName.toLowerCase()).lastInsertRowid,
  );
  s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(track, NOW - YEAR);
  return track;
}

class FakeLikedConnector implements ServiceConnector {
  readonly service = 'tidal' as const;
  constructor(private readonly liked: { track: ServiceTrack; likedAt?: number }[]) {}
  async isAuthorized() {
    return true;
  }
  async searchTrack() {
    return [];
  }
  async createPlaylist() {
    return 'x';
  }
  async setPlaylistTracks() {}
  async *getLikedTracks() {
    for (const item of this.liked) yield item;
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

describe('importServiceLiked generalized for TIDAL', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('links matching tracks and tags them with source="tidal", leaving other sources untouched', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = seedArtistTrack(handle, 'Opeth', 'Ghost of Perdition');
    const unrelated = seedArtistTrack(handle, 'Miles Davis', 'So What');
    // Pre-existing Last.fm love, should survive a TIDAL import untouched.
    s.prepare("INSERT INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'lastfm', ?)").run(unrelated, NOW);

    const connector = new FakeLikedConnector([{ track: { serviceId: 't1', name: 'Ghost of Perdition', artistName: 'Opeth' }, likedAt: NOW }]);
    const result = await importServiceLiked(handle, connector, 'tidal');
    expect(result).toEqual({ seen: 1, linked: 1 });

    const rows = s.prepare('SELECT track_id AS trackId, source AS source FROM liked_tracks ORDER BY track_id').all() as { trackId: number; source: string }[];
    expect(rows).toEqual([
      { trackId: opeth, source: 'tidal' },
      { trackId: unrelated, source: 'lastfm' },
    ]);
  });

  it('a re-run replaces only the tidal-sourced rows', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = seedArtistTrack(handle, 'Opeth', 'Ghost of Perdition');
    const metallica = seedArtistTrack(handle, 'Metallica', 'One');

    const firstRun = new FakeLikedConnector([{ track: { serviceId: 't1', name: 'Ghost of Perdition', artistName: 'Opeth' } }]);
    await importServiceLiked(handle, firstRun, 'tidal');
    expect((s.prepare("SELECT COUNT(*) c FROM liked_tracks WHERE source = 'tidal'").get() as any).c).toBe(1);

    const secondRun = new FakeLikedConnector([{ track: { serviceId: 't2', name: 'One', artistName: 'Metallica' } }]);
    await importServiceLiked(handle, secondRun, 'tidal');
    const rows = s.prepare("SELECT track_id AS trackId FROM liked_tracks WHERE source = 'tidal'").all() as { trackId: number }[];
    expect(rows.map((r) => r.trackId)).toEqual([metallica]);
    void opeth;
  });

  it('a liked track never scrobbled (no matching library track) is seen but not linked', async () => {
    handle = openDb(':memory:');
    const connector = new FakeLikedConnector([{ track: { serviceId: 't1', name: 'Unknown Song', artistName: 'Unknown Artist' } }]);
    const result = await importServiceLiked(handle, connector, 'tidal');
    expect(result).toEqual({ seen: 1, linked: 0 });
  });
});
