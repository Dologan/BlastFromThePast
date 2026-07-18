import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import { rebuildStats } from '../src/sync/stats.js';
import type { AuthManager } from '../src/auth/authManager.js';
import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';

const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365 * 86400;

class FakeConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  /** When set, searchTrack blocks on this promise (for busy/timeout tests). */
  gate: Promise<void> | null = null;
  failCreate = false;
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    if (this.gate) await this.gate;
    if (q.trackName.includes('Ghost')) return [{ serviceId: 'sp-ghost', name: q.trackName, artistName: q.artistName }];
    return [];
  }
  async createPlaylist() {
    if (this.failCreate) throw new Error('service exploded');
    return 'PL9';
  }
  async setPlaylistTracks() {}
  async getPlaylistTrackIds(): Promise<string[]> {
    return [];
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

const seed = (handle: DbHandle) => {
  const s = handle.sqlite;
  const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Opeth','opeth')").run().lastInsertRowid);
  const t1 = Number(
    s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost of Perdition','ghost of perdition')").run(opeth).lastInsertRowid,
  );
  s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t1, NOW - YEAR);
  rebuildStats(s);
};

const RECIPE = { filters: [], output: { mode: 'tracks', sort: 'playcount_desc', limit: 50 } };
const fakeAuth = { isAuthorized: () => true } as unknown as AuthManager;

describe('POST /api/push/sync', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('waits for the push and returns the full result inline', async () => {
    handle = openDb(':memory:');
    seed(handle);
    const app = buildApp({ handle, authManager: fakeAuth, createConnector: () => new FakeConnector() });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/sync',
      payload: { service: 'spotify', name: 'Sync push', recipe: RECIPE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trackCount).toBe(1);
    expect(body.result.matchedCount).toBe(1);
    expect(body.result.playlistUrl).toBe('https://open.spotify.com/playlist/PL9');
    await app.close();
  });

  it('shares validation with /api/push (bad request -> 400)', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle, authManager: fakeAuth, createConnector: () => new FakeConnector() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/sync',
      payload: { service: 'spotify', name: '', recipe: RECIPE },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 409 while another job is running', async () => {
    handle = openDb(':memory:');
    seed(handle);
    const connector = new FakeConnector();
    let release!: () => void;
    connector.gate = new Promise((r) => (release = r));
    const app = buildApp({ handle, authManager: fakeAuth, createConnector: () => connector });

    // Occupy the job slot with an async push that blocks in searchTrack…
    const first = await app.inject({
      method: 'POST',
      url: '/api/push',
      payload: { service: 'spotify', name: 'Busy', recipe: RECIPE },
    });
    expect(first.statusCode).toBe(202);

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/sync',
      payload: { service: 'spotify', name: 'Blocked', recipe: RECIPE },
    });
    expect(res.statusCode).toBe(409);

    release();
    for (let i = 0; i < 50; i++) {
      if (!(await app.inject({ method: 'GET', url: '/api/sync/status' })).json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await app.close();
  });

  it('returns pending when the job outlives the sync timeout, and keeps running', async () => {
    handle = openDb(':memory:');
    seed(handle);
    const connector = new FakeConnector();
    let release!: () => void;
    connector.gate = new Promise((r) => (release = r));
    const app = buildApp({
      handle,
      authManager: fakeAuth,
      createConnector: () => connector,
      syncPushTimeoutMs: 300,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/sync',
      payload: { service: 'spotify', name: 'Slowpoke', recipe: RECIPE },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().pending).toBe(true);

    // The job finishes in the background and the result becomes pollable.
    release();
    for (let i = 0; i < 50; i++) {
      if (!(await app.inject({ method: 'GET', url: '/api/sync/status' })).json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const { result } = (await app.inject({ method: 'GET', url: '/api/push/result' })).json();
    expect(result.matchedCount).toBe(1);
    await app.close();
  });

  it('surfaces a failed push as 502 with the job error', async () => {
    handle = openDb(':memory:');
    seed(handle);
    const connector = new FakeConnector();
    connector.failCreate = true;
    const app = buildApp({ handle, authManager: fakeAuth, createConnector: () => connector });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/sync',
      payload: { service: 'spotify', name: 'Doomed', recipe: RECIPE },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('service exploded');
    await app.close();
  });
});
