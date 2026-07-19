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
  created: { name: string; description: string }[] = [];
  added: Record<string, string[]> = {};
  private nextId = 1;
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    return [{ serviceId: `sp-${q.trackName.toLowerCase().replace(/\s+/g, '-')}`, name: q.trackName, artistName: q.artistName }];
  }
  async createPlaylist(name: string, description: string) {
    this.created.push({ name, description });
    return `PL${this.nextId++}`;
  }
  async setPlaylistTracks(id: string, ids: string[]) {
    this.added[id] = ids;
  }
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

/** Seeds an artist with one root-genre tag, a loved track, and enough plays to have stats. */
function seedLovedArtist(
  handle: DbHandle,
  artistName: string,
  trackName: string,
  tag: string,
  opts: { plays?: number; source?: string } = {},
): number {
  const s = handle.sqlite;
  const artist = Number(
    s.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artistName, artistName.toLowerCase()).lastInsertRowid,
  );
  s.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
  const tagId = (s.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number }).id;
  s.prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'lastfm', 10)").run(artist, tagId);
  const track = Number(
    s
      .prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)')
      .run(artist, trackName, trackName.toLowerCase()).lastInsertRowid,
  );
  const plays = opts.plays ?? 3;
  for (let i = 0; i < plays; i++) {
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(track, NOW - 2 * YEAR + i * 86400);
  }
  s.prepare("INSERT INTO liked_tracks (track_id, source, liked_at) VALUES (?, ?, ?)").run(track, opts.source ?? 'lastfm', NOW - 2 * YEAR);
  return track;
}

const BASE_LOVED_TRACKS_RECIPE = { filters: [{ type: 'loved' }], output: { mode: 'tracks', sort: 'weighted_random', limit: 10000 } };

describe('Curator API: /api/curate/preview', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('groups loved tracks by genre family and reports the excluded count', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    seedLovedArtist(handle, 'Opeth', 'Ghost of Perdition', 'progressive metal');
    seedLovedArtist(handle, 'Miles Davis', 'So What', 'jazz');
    const excludedTrack = seedLovedArtist(handle, 'Coltrane', 'Giant Steps', 'jazz');
    rebuildStats(s);

    // Log excludedTrack as already pushed -- should be dropped from the preview.
    const logId = Number(
      s.prepare("INSERT INTO playlist_log (service, service_playlist_id, name, created_at) VALUES ('spotify','PL_OLD','Old',?)").run(NOW).lastInsertRowid,
    );
    s.prepare('INSERT INTO playlist_log_tracks (playlist_log_id, track_id) VALUES (?, ?)').run(logId, excludedTrack);

    const app = buildApp({ handle, authManager: { isAuthorized: () => true } as unknown as AuthManager, createConnector: () => new FakeConnector() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/curate/preview',
      payload: { base: BASE_LOVED_TRACKS_RECIPE, groupBy: 'genreFamily', minGroupSize: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalMatched).toBe(3);
    expect(body.excluded).toBe(1);
    const byName = Object.fromEntries(body.groups.map((g: any) => [g.name, g]));
    expect(byName['Loved: Metal'].count).toBe(1);
    expect(byName['Loved: Jazz'].count).toBe(1); // Coltrane excluded, only Miles Davis remains
    await app.close();
  });

  it('folds groups smaller than minGroupSize into Other, keeping Unclassified separate', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    seedLovedArtist(handle, 'Opeth', 'Ghost of Perdition', 'progressive metal');
    seedLovedArtist(handle, 'Metallica', 'Master of Puppets', 'metal'); // 2nd metal track -> metal group reaches minGroupSize
    seedLovedArtist(handle, 'Miles Davis', 'So What', 'jazz'); // lone jazz track -> too small, folds into Other
    const noTagArtist = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Obscure','obscure')").run().lastInsertRowid);
    const noTagTrack = Number(
      s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Mystery Track','mystery track')").run(noTagArtist).lastInsertRowid,
    );
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(noTagTrack, NOW - 2 * YEAR);
    s.prepare("INSERT INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'lastfm', ?)").run(noTagTrack, NOW - 2 * YEAR);
    rebuildStats(s);

    const app = buildApp({ handle, authManager: { isAuthorized: () => true } as unknown as AuthManager, createConnector: () => new FakeConnector() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/curate/preview',
      payload: { base: BASE_LOVED_TRACKS_RECIPE, groupBy: 'genreFamily', minGroupSize: 2 },
    });
    const body = res.json();
    const names = body.groups.map((g: any) => g.name);
    expect(names).toContain('Loved: Metal'); // reached minGroupSize, stays its own group
    expect(names).not.toContain('Loved: Jazz'); // folded, too small
    expect(names).toContain('Loved: Other');
    expect(names).toContain('Loved: Unclassified');
    const byName = Object.fromEntries(body.groups.map((g: any) => [g.name, g]));
    expect(byName['Loved: Metal'].count).toBe(2);
    expect(byName['Loved: Other'].count).toBe(1); // the lone jazz track
    expect(byName['Loved: Unclassified'].count).toBe(1); // the untagged artist's track
    await app.close();
  });

  it('excludePlaylistedOn scopes exclusion to service_playlist_tracks for the chosen services only', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const track = seedLovedArtist(handle, 'Opeth', 'Ghost of Perdition', 'progressive metal');
    rebuildStats(s);

    const plId = Number(
      s.prepare("INSERT INTO service_playlists (service, service_playlist_id, name, is_own, fetched_at) VALUES ('spotify','sp1','My Playlist',1,?)").run(NOW).lastInsertRowid,
    );
    s.prepare('INSERT INTO service_playlist_tracks (playlist_id, service_track_id, track_id) VALUES (?, ?, ?)').run(plId, 'sptrack1', track);

    const app = buildApp({ handle, authManager: { isAuthorized: () => true } as unknown as AuthManager, createConnector: () => new FakeConnector() });

    // Not excluded when the inventoried service isn't in excludePlaylistedOn.
    const withoutExclusion = await app.inject({
      method: 'POST',
      url: '/api/curate/preview',
      payload: { base: BASE_LOVED_TRACKS_RECIPE, groupBy: 'genreFamily', minGroupSize: 1, excludePlaylistedOn: ['tidal'] },
    });
    expect(withoutExclusion.json().excluded).toBe(0);

    // Excluded once spotify is in scope.
    const withExclusion = await app.inject({
      method: 'POST',
      url: '/api/curate/preview',
      payload: { base: BASE_LOVED_TRACKS_RECIPE, groupBy: 'genreFamily', minGroupSize: 1, excludePlaylistedOn: ['spotify'] },
    });
    expect(withExclusion.json().excluded).toBe(1);
    await app.close();
  });
});

describe('Curator API: /api/curate/push', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('pushes one playlist per group via a single job, logging each to playlist_log', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    seedLovedArtist(handle, 'Opeth', 'Ghost of Perdition', 'progressive metal');
    seedLovedArtist(handle, 'Miles Davis', 'So What', 'jazz');
    rebuildStats(s);

    const connector = new FakeConnector();
    const app = buildApp({ handle, authManager: { isAuthorized: () => true } as unknown as AuthManager, createConnector: () => connector });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/curate/preview',
      payload: { base: BASE_LOVED_TRACKS_RECIPE, groupBy: 'genreFamily', minGroupSize: 1 },
    });
    const groups = preview.json().groups as { name: string; entityIds: number[] }[];
    expect(groups).toHaveLength(2);

    const pushRes = await app.inject({
      method: 'POST',
      url: '/api/curate/push',
      payload: { service: 'spotify', onExisting: 'skip', playlists: groups.map((g) => ({ name: g.name, trackIds: g.entityIds })) },
    });
    expect(pushRes.statusCode).toBe(202);

    for (let i = 0; i < 50; i++) {
      const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
      if (!st.json().running) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const { results } = (await app.inject({ method: 'GET', url: '/api/curate/result' })).json();
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.matchedCount).toBe(1);
    expect(connector.created).toHaveLength(2);
    expect((s.prepare('SELECT COUNT(*) c FROM playlist_log').get() as any).c).toBe(2);
  });

  it('onExisting "skip" records a skip and does not touch the existing playlist; "replace" reuses it', async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    seedLovedArtist(handle, 'Opeth', 'Ghost of Perdition', 'progressive metal');
    rebuildStats(s);

    const connector = new FakeConnector();
    const app = buildApp({ handle, authManager: { isAuthorized: () => true } as unknown as AuthManager, createConnector: () => connector });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/curate/preview',
      payload: { base: BASE_LOVED_TRACKS_RECIPE, groupBy: 'genreFamily', minGroupSize: 1 },
    });
    const group = preview.json().groups[0];
    const runPush = async (onExisting: string) => {
      await app.inject({
        method: 'POST',
        url: '/api/curate/push',
        payload: { service: 'spotify', onExisting, playlists: [{ name: group.name, trackIds: group.entityIds }] },
      });
      for (let i = 0; i < 50; i++) {
        const st = await app.inject({ method: 'GET', url: '/api/sync/status' });
        if (!st.json().running) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return (await app.inject({ method: 'GET', url: '/api/curate/result' })).json().results;
    };

    // First push creates a new playlist.
    await runPush('skip');
    expect(connector.created).toHaveLength(1);

    // Second push with the same name and onExisting: 'skip' is skipped, not duplicated.
    const skippedResult = await runPush('skip');
    expect(skippedResult).toEqual([{ skipped: true, name: group.name }]);
    expect(connector.created).toHaveLength(1);

    // Third push with onExisting: 'replace' reuses the existing playlist id instead of creating a new one.
    const replacedResult = await runPush('replace');
    expect(connector.created).toHaveLength(1);
    expect(replacedResult[0].playlistId).toBe('PL1');
    await app.close();
  });

  it('rejects a push with no non-empty playlists', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle, authManager: { isAuthorized: () => true } as unknown as AuthManager, createConnector: () => new FakeConnector() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/curate/push',
      payload: { service: 'spotify', playlists: [{ name: 'Empty', trackIds: [] }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
