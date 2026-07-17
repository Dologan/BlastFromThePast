import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import type { AuthManager } from '../src/auth/authManager.js';
import type { ServiceAlbum, ServiceArtist, ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';

class FakeConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    if (q.trackName === 'Windowpane') return [{ serviceId: 'sp-track', name: 'Windowpane', artistName: 'Opeth' }];
    return [];
  }
  async searchAlbum(): Promise<ServiceAlbum[]> {
    return [{ serviceId: 'sp-album', name: 'Ghost Reveries', artistName: 'Opeth' }];
  }
  async searchArtist(): Promise<ServiceArtist[]> {
    return [{ serviceId: 'sp-artist', name: 'Opeth' }];
  }
  async createPlaylist() {
    return 'PL';
  }
  async setPlaylistTracks() {}
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

describe('POST /api/deeplinks', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('resolves a batch of track/album/artist entities in order', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Opeth','opeth')").run().lastInsertRowid);
    const track = Number(
      s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Windowpane','windowpane')").run(opeth).lastInsertRowid,
    );
    const album = Number(
      s.prepare("INSERT INTO albums (artist_id, name, name_normalized) VALUES (?, 'Ghost Reveries','ghost reveries')").run(opeth).lastInsertRowid,
    );

    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: () => new FakeConnector(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/deeplinks',
      payload: {
        service: 'spotify',
        items: [
          { kind: 'track', entityId: track },
          { kind: 'album', entityId: album },
          { kind: 'artist', entityId: opeth },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toEqual([
      'https://open.spotify.com/track/sp-track',
      'https://open.spotify.com/album/sp-album',
      'https://open.spotify.com/artist/sp-artist',
    ]);
    await app.close();
  });

  it('returns all nulls when the service is not connected', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Opeth','opeth')").run().lastInsertRowid);

    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => false } as unknown as AuthManager,
      createConnector: () => new FakeConnector(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/deeplinks',
      payload: { service: 'spotify', items: [{ kind: 'artist', entityId: opeth }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toEqual([null]);
    await app.close();
  });

  it('rejects an invalid service', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });
    const res = await app.inject({ method: 'POST', url: '/api/deeplinks', payload: { service: 'napster', items: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
