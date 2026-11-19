import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import { rebuildStats } from '../src/sync/stats.js';
import type { AuthManager } from '../src/auth/authManager.js';
import type { ServiceConnector, ServiceName, ServiceTrack, TrackQuery } from '@bftp/core';

/** Unix seconds for a local-time date (the organiser buckets by server-local month). */
const at = (y: number, m: number, d = 15) => Math.floor(new Date(y, m - 1, d, 12).getTime() / 1000);

class FakeConnector implements ServiceConnector {
  created: string[] = [];
  deleted: string[] = [];
  foldersCreated: string[] = [];
  filed: Record<string, string[]> = {};
  private nextId = 1;
  private readonly folderIds = new Map<string, string>();
  findOrCreateFolder?: (name: string) => Promise<string>;
  addPlaylistsToFolder?: (folderId: string, playlistIds: string[]) => Promise<void>;

  constructor(readonly service: ServiceName) {
    if (service === 'tidal') {
      this.findOrCreateFolder = async (name) => {
        if (!this.folderIds.has(name)) {
          this.foldersCreated.push(name);
          this.folderIds.set(name, `F-${name}`);
        }
        return this.folderIds.get(name)!;
      };
      this.addPlaylistsToFolder = async (folderId, ids) => {
        (this.filed[folderId] ??= []).push(...ids);
      };
    }
  }
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    return [{ serviceId: `s-${q.trackName}`, name: q.trackName, artistName: q.artistName }];
  }
  async createPlaylist(name: string) {
    this.created.push(name);
    return `PL${this.nextId++}`;
  }
  async deletePlaylist(id: string) {
    this.deleted.push(id);
  }
  async setPlaylistTracks() {}
  async getPlaylistTrackIds(): Promise<string[]> {
    return [];
  }
  deepLinkTrack(id: string) {
    return `track/${id}`;
  }
  deepLinkAlbum(id: string) {
    return `album/${id}`;
  }
  deepLinkArtist(id: string) {
    return `artist/${id}`;
  }
  deepLinkPlaylist(id: string) {
    return `playlist/${id}`;
  }
}

/** A loved track by a one-tag artist, first played at `playedAt` and liked at `likedAt` (null: undated). */
function seed(handle: DbHandle, artistName: string, trackName: string, tag: string, playedAt: number, likedAt: number | null) {
  const s = handle.sqlite;
  const artist = Number(s.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artistName, artistName.toLowerCase()).lastInsertRowid);
  s.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
  const tagId = (s.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number }).id;
  s.prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'lastfm', 10)").run(artist, tagId);
  const track = Number(
    s.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(artist, trackName, trackName.toLowerCase()).lastInsertRowid,
  );
  s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(track, playedAt);
  s.prepare("INSERT INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'lastfm', ?)").run(track, likedAt);
}

const PLAN = {
  base: { filters: [{ type: 'loved' }], output: { mode: 'tracks', sort: 'random', limit: 50 } },
  groupBy: ['likedMonth', 'genreFamily'],
  folder: '{year}',
  name: '{year}-{month} {genre}',
  minGroupSize: 2,
};

describe('Organiser API', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  function setup() {
    handle = openDb(':memory:');
    // March 2025: two metal likes and a lone jazz one (too small: folds into that month's Other).
    seed(handle, 'Opeth', 'Ghost of Perdition', 'progressive metal', at(2020, 1), at(2025, 3));
    seed(handle, 'Metallica', 'Master of Puppets', 'metal', at(2020, 1), at(2025, 3, 20));
    seed(handle, 'Miles Davis', 'So What', 'jazz', at(2020, 1), at(2025, 3));
    // January 2024: two jazz likes, one undated -- dated by its first play instead.
    seed(handle, 'Coltrane', 'Giant Steps', 'jazz', at(2019, 6), at(2024, 1));
    seed(handle, 'Bill Evans', 'Peace Piece', 'jazz', at(2024, 1, 10), null);
    rebuildStats(handle.sqlite);
    const connectors = { tidal: new FakeConnector('tidal'), spotify: new FakeConnector('spotify') };
    const app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: (service) => connectors[service],
    });
    return { app, connectors };
  }

  it('previews a folder-per-year tree of per-month, per-genre playlists', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/organise/preview', payload: { plan: PLAN } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folders.map((f: any) => [f.name, f.playlists.map((p: any) => [p.name, p.count])])).toEqual([
      ['2024', [['2024-01 Jazz', 2]]],
      ['2025', [['2025-03 Metal', 2], ['2025-03 Other', 1]]],
    ]);
    expect(body).toMatchObject({ trackCount: 5, playlistCount: 3, likeDateFallback: 1 });
    await app.close();
  });

  it('folds a small Unclassified group into its month\'s Other, unlike the one-off Curator', async () => {
    const { app } = setup();
    const s = handle.sqlite;
    const artist = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Obscure', 'obscure')").run().lastInsertRowid);
    const track = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Mystery', 'mystery')").run(artist).lastInsertRowid);
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(track, at(2020, 1));
    s.prepare("INSERT INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'lastfm', ?)").run(track, at(2025, 3));
    rebuildStats(s);
    const res = await app.inject({ method: 'POST', url: '/api/organise/preview', payload: { plan: PLAN } });
    const march = res.json().folders.find((f: any) => f.name === '2025').playlists;
    expect(march.map((p: any) => [p.name, p.count])).toEqual([['2025-03 Metal', 2], ['2025-03 Other', 2]]);
    await app.close();
  });

  it('rejects an invalid plan', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/organise/preview', payload: { plan: { ...PLAN, name: '{genre}', folder: undefined } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/\{year\}/);
    await app.close();
  });

  it('pushes to TIDAL, filing each playlist in its year folder and logging the folder', async () => {
    const { app, connectors } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/organise/push/sync', payload: { plan: PLAN, service: 'tidal' } });
    expect(res.statusCode).toBe(200);
    const tidal = connectors.tidal;
    expect(tidal.created).toEqual(['2024-01 Jazz', '2025-03 Metal', '2025-03 Other']);
    expect(tidal.foldersCreated).toEqual(['2024', '2025']);
    expect(tidal.filed).toEqual({ 'F-2024': ['PL1'], 'F-2025': ['PL2', 'PL3'] });
    expect(res.json().results.map((r: any) => [r.folder, r.name])).toEqual([
      ['2024', '2024-01 Jazz'],
      ['2025', '2025-03 Metal'],
      ['2025', '2025-03 Other'],
    ]);
    const logged = handle.sqlite.prepare('SELECT folder, name FROM playlist_log ORDER BY id').all();
    expect(logged).toEqual([
      { folder: '2024', name: '2024-01 Jazz' },
      { folder: '2025', name: '2025-03 Metal' },
      { folder: '2025', name: '2025-03 Other' },
    ]);
    await app.close();
  });

  it('re-running replaces playlists and re-files the recreated ones; skip leaves them alone', async () => {
    const { app, connectors } = setup();
    const tidal = connectors.tidal;
    await app.inject({ method: 'POST', url: '/api/organise/push/sync', payload: { plan: PLAN, service: 'tidal' } });

    const preview = await app.inject({ method: 'POST', url: '/api/organise/preview', payload: { plan: PLAN, service: 'tidal' } });
    expect(preview.json().folders.flatMap((f: any) => f.playlists.map((p: any) => p.existing))).toEqual([true, true, true]);

    // Default 'replace': TIDAL deletes and recreates, so the new ids must go back into the folders.
    await app.inject({ method: 'POST', url: '/api/organise/push/sync', payload: { plan: PLAN, service: 'tidal' } });
    expect(tidal.deleted).toEqual(['PL1', 'PL2', 'PL3']);
    expect(tidal.filed).toEqual({ 'F-2024': ['PL1', 'PL4'], 'F-2025': ['PL2', 'PL3', 'PL5', 'PL6'] });

    const skip = await app.inject({ method: 'POST', url: '/api/organise/push/sync', payload: { plan: PLAN, service: 'tidal', onExisting: 'skip' } });
    expect(skip.json().results.every((r: any) => r.skipped)).toBe(true);
    expect(tidal.created).toHaveLength(6);
    await app.close();
  });

  it('prefixes the folder to the playlist name on Spotify, which has no folders', async () => {
    const { app, connectors } = setup();
    const preview = await app.inject({ method: 'POST', url: '/api/organise/preview', payload: { plan: PLAN, service: 'spotify' } });
    expect(preview.json().foldersSupported).toBe(false);
    await app.inject({ method: 'POST', url: '/api/organise/push/sync', payload: { plan: PLAN, service: 'spotify' } });
    expect(connectors.spotify.created).toEqual(['2024 · 2024-01 Jazz', '2025 · 2025-03 Metal', '2025 · 2025-03 Other']);
    expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM playlist_log WHERE folder IS NULL').get()).toEqual({ n: 3 });
    await app.close();
  });

  it('a folder failure is reported per playlist and does not stop the push', async () => {
    const { app, connectors } = setup();
    connectors.tidal.findOrCreateFolder = async () => {
      throw new Error('TIDAL HTTP 400 for POST /userCollectionFolders');
    };
    const res = await app.inject({ method: 'POST', url: '/api/organise/push/sync', payload: { plan: PLAN, service: 'tidal' } });
    const results = res.json().results;
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.matchedCount).toBeGreaterThan(0);
      expect(r.folderError).toMatch(/HTTP 400/);
    }
    await app.close();
  });
});
