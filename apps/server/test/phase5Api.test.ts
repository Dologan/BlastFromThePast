import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import type { AuthManager } from '../src/auth/authManager.js';
import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';

class FakeConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    return [
      { serviceId: 'cand-a', name: q.trackName, artistName: q.artistName },
      { serviceId: 'cand-b', name: `${q.trackName} (Remaster)`, artistName: q.artistName },
    ];
  }
  async createPlaylist() {
    return 'PL';
  }
  async setPlaylistTracks() {}
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

describe('presets + match fix-up API', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('serves built-in presets', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });
    const presets = (await app.inject({ method: 'GET', url: '/api/presets' })).json();
    expect(presets.length).toBeGreaterThanOrEqual(4);
    const onThisDay = presets.find((p: any) => p.id === 'on-this-day');
    expect(onThisDay.definition.filters[0].type).toBe('anniversary');
    await app.close();
  });

  it('returns candidates and records a manual override as verified', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const artist = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Opeth','opeth')").run().lastInsertRowid);
    const trackId = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Harvest','harvest')").run(artist).lastInsertRowid);

    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: () => new FakeConnector(),
    });

    const cand = (await app.inject({ method: 'GET', url: `/api/match/candidates?service=spotify&trackId=${trackId}` })).json();
    expect(cand.candidates.map((c: any) => c.serviceId)).toEqual(['cand-a', 'cand-b']);

    const ov = await app.inject({
      method: 'POST',
      url: '/api/match/override',
      payload: { service: 'spotify', trackId, serviceId: 'cand-b' },
    });
    expect(ov.statusCode).toBe(204);

    const link = s.prepare("SELECT service_id, method, confidence, verified FROM service_links WHERE entity_id = ? AND service = 'spotify'").get(trackId) as any;
    expect(link).toEqual({ service_id: 'cand-b', method: 'manual', confidence: 1, verified: 1 });
    await app.close();
  });

  it('rejects candidates when the service is not connected', async () => {
    handle = openDb(':memory:');
    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => false } as unknown as AuthManager,
      createConnector: () => new FakeConnector(),
    });
    const res = await app.inject({ method: 'GET', url: '/api/match/candidates?service=spotify&trackId=1' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
