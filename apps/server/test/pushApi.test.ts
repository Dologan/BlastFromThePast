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
  added: string[] = [];
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    if (q.trackName.includes('Ghost')) return [{ serviceId: 'sp-ghost', name: q.trackName, artistName: q.artistName }];
    return [];
  }
  async createPlaylist() {
    return 'PL9';
  }
  async setPlaylistTracks(_id: string, ids: string[]) {
    this.added = ids;
  }
  deepLinkTrack(id: string) {
    return `https://open.spotify.com/track/${id}`;
  }
  deepLinkAlbum(id: string) {
    return `https://open.spotify.com/album/${id}`;
  }
  deepLinkPlaylist(id: string) {
    return `https://open.spotify.com/playlist/${id}`;
  }
}

describe('push API', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('pushes a tracks-mode recipe end-to-end and reports matched/unmatched', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized, country) VALUES ('Opeth','opeth','SE')").run().lastInsertRowid);
    const t1 = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost of Perdition','ghost of perdition')").run(opeth).lastInsertRowid);
    const t2 = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Obscure Deep Cut','obscure deep cut')").run(opeth).lastInsertRowid);
    for (const uts of [NOW - 5 * YEAR, NOW - 5 * YEAR + 86400]) s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t1, uts);
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t2, NOW - 5 * YEAR);
    rebuildStats(s);

    const fakeAuth = {
      isAuthorized: () => true,
      getAccessToken: async () => 'AT',
    } as unknown as AuthManager;

    const app = buildApp({
      handle,
      authManager: fakeAuth,
      createConnector: () => new FakeConnector(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      payload: {
        service: 'spotify',
        name: 'Forgotten Opeth',
        recipe: { filters: [], output: { mode: 'tracks', sort: 'neglect', limit: 50 } },
      },
    });
    expect(res.statusCode).toBe(202);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const { result } = (await app.inject({ method: 'GET', url: '/api/push/result' })).json();
    expect(result.matchedCount).toBe(1); // only "Ghost of Perdition" matched
    expect(result.playlistUrl).toBe('https://open.spotify.com/playlist/PL9');
    expect(result.unmatched.map((u: any) => u.name)).toEqual(['Obscure Deep Cut']);

    // Logged for later exclusion.
    expect((s.prepare('SELECT COUNT(*) c FROM playlist_log').get() as any).c).toBe(1);

    await app.close();
  });

  it('pushes only the selected track ids when selectedIds is given', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Opeth','opeth')").run().lastInsertRowid);
    const t1 = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost of Perdition','ghost of perdition')").run(opeth).lastInsertRowid);
    const t2 = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost Reveries Bonus','ghost reveries bonus')").run(opeth).lastInsertRowid);
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t1, NOW - YEAR);
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t2, NOW - YEAR);
    rebuildStats(s);

    const connector = new FakeConnector();
    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: () => connector,
    });

    // Both tracks would match ("Ghost…"), but only t2 is selected.
    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      payload: {
        service: 'spotify',
        name: 'Selected only',
        recipe: { filters: [], output: { mode: 'tracks', sort: 'playcount_desc', limit: 50 } },
        selectedIds: [t2],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().trackCount).toBe(1);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const { result } = (await app.inject({ method: 'GET', url: '/api/push/result' })).json();
    expect(result.matchedCount).toBe(1);
    await app.close();
  });

  it('expands an albums-mode recipe into the album tracks', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Opeth','opeth')").run().lastInsertRowid);
    const album = Number(s.prepare("INSERT INTO albums (artist_id, name, name_normalized) VALUES (?, 'Ghost Reveries','ghost reveries')").run(opeth).lastInsertRowid);
    const t1 = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost of Perdition','ghost of perdition')").run(opeth).lastInsertRowid);
    const t2 = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost Baying of the Hounds','ghost baying of the hounds')").run(opeth).lastInsertRowid);
    // t1 heard first, then t2 — expansion should keep that order.
    s.prepare('INSERT INTO scrobbles (track_id, album_id, uts) VALUES (?, ?, ?)').run(t1, album, NOW - YEAR);
    s.prepare('INSERT INTO scrobbles (track_id, album_id, uts) VALUES (?, ?, ?)').run(t2, album, NOW - YEAR + 300);
    rebuildStats(s);

    const connector = new FakeConnector();
    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: () => connector,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      payload: {
        service: 'spotify',
        name: 'Album push',
        recipe: { filters: [], output: { mode: 'albums', sort: 'playcount_desc', limit: 10 } },
        selectedIds: [album],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().trackCount).toBe(2);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const { result } = (await app.inject({ method: 'GET', url: '/api/push/result' })).json();
    expect(result.matchedCount).toBe(2);
    await app.close();
  });

  it('rejects a push where nothing is selected', async () => {
    handle = openDb(':memory:');
    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: () => new FakeConnector(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      payload: {
        service: 'spotify',
        name: 'empty',
        recipe: { filters: [], output: { mode: 'tracks', sort: 'neglect', limit: 10 } },
        selectedIds: [],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Nothing selected/);
    await app.close();
  });
});
