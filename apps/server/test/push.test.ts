import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';
import { ServiceMatcher } from '../src/match/matcher.js';
import { pushPlaylist } from '../src/match/push.js';

/** A fake service: canned search results + records of playlist operations. */
class FakeConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  searchCalls = 0;
  createdName: string | null = null;
  addedIds: string[] = [];
  // Map normalized "artist|title" -> serviceId, or ISRC -> serviceId.
  byQuery = new Map<string, ServiceTrack>();
  byIsrc = new Map<string, ServiceTrack>();

  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    this.searchCalls++;
    if (q.isrc) {
      const hit = this.byIsrc.get(q.isrc);
      return hit ? [hit] : [];
    }
    const hit = this.byQuery.get(`${q.artistName.toLowerCase()}|${q.trackName.toLowerCase()}`);
    return hit ? [hit] : [];
  }
  async createPlaylist(name: string) {
    this.createdName = name;
    return 'PL1';
  }
  async setPlaylistTracks(_id: string, ids: string[]) {
    this.addedIds = ids;
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

describe('ServiceMatcher', () => {
  let handle: DbHandle;
  let connector: FakeConnector;

  const addTrack = (artist: string, title: string, isrc: string | null = null): number => {
    const existing = handle.sqlite.prepare('SELECT id FROM artists WHERE name_normalized = ?').get(artist.toLowerCase()) as { id: number } | undefined;
    const artistId =
      existing?.id ??
      Number(handle.sqlite.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artist, artist.toLowerCase()).lastInsertRowid);
    return Number(
      handle.sqlite.prepare('INSERT INTO tracks (artist_id, name, name_normalized, isrc) VALUES (?, ?, ?, ?)').run(artistId, title, title.toLowerCase(), isrc).lastInsertRowid,
    );
  };

  beforeEach(() => {
    handle = openDb(':memory:');
    connector = new FakeConnector();
  });
  afterEach(() => handle.close());

  it('matches by ISRC with full confidence and caches the result', async () => {
    const id = addTrack('Opeth', 'Windowpane', 'GBAAA0000001');
    connector.byIsrc.set('GBAAA0000001', { serviceId: 'sp-win', name: 'Windowpane', artistName: 'Opeth' });
    const matcher = new ServiceMatcher(handle, connector, 'spotify');

    const first = await matcher.match(id);
    expect(first).toEqual({ serviceId: 'sp-win', method: 'isrc', confidence: 1 });

    // Second call served from service_links cache — no new search.
    const before = connector.searchCalls;
    const second = await matcher.match(id);
    expect(second?.serviceId).toBe('sp-win');
    expect(connector.searchCalls).toBe(before);

    const link = handle.sqlite.prepare("SELECT * FROM service_links WHERE entity_id = ? AND service='spotify'").get(id) as any;
    expect(link.method).toBe('isrc');
    expect(link.confidence).toBe(1);
  });

  it('falls back to search and scores confidence by name match', async () => {
    const exact = addTrack('Opeth', 'Ghost of Perdition');
    const fuzzy = addTrack('Opeth', 'Ghost of Perdition (Live)');
    connector.byQuery.set('opeth|ghost of perdition', { serviceId: 'sp-1', name: 'Ghost of Perdition', artistName: 'Opeth' });
    connector.byQuery.set('opeth|ghost of perdition (live)', { serviceId: 'sp-2', name: 'Ghost of Perdition', artistName: 'Opeth' });
    const matcher = new ServiceMatcher(handle, connector, 'spotify');

    expect(await matcher.match(exact)).toEqual({ serviceId: 'sp-1', method: 'search', confidence: 1 });
    // Title differs (live vs studio) -> partial confidence.
    expect(await matcher.match(fuzzy)).toEqual({ serviceId: 'sp-2', method: 'search', confidence: 0.6 });
  });

  it('returns null when nothing is found', async () => {
    const id = addTrack('Nobody', 'Unknown Song');
    expect(await new ServiceMatcher(handle, connector, 'spotify').match(id)).toBeNull();
  });
});

describe('pushPlaylist', () => {
  let handle: DbHandle;
  let connector: FakeConnector;

  const addTrack = (artist: string, title: string): number => {
    const existing = handle.sqlite.prepare('SELECT id FROM artists WHERE name_normalized = ?').get(artist.toLowerCase()) as { id: number } | undefined;
    const artistId =
      existing?.id ??
      Number(handle.sqlite.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(artist, artist.toLowerCase()).lastInsertRowid);
    return Number(
      handle.sqlite.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(artistId, title, title.toLowerCase()).lastInsertRowid,
    );
  };

  beforeEach(() => {
    handle = openDb(':memory:');
    connector = new FakeConnector();
  });
  afterEach(() => handle.close());

  it('matches, creates a playlist, adds matched tracks, logs, and reports the unmatched', async () => {
    const t1 = addTrack('Opeth', 'Windowpane');
    const t2 = addTrack('Katatonia', 'Lethean');
    const t3 = addTrack('Obscure', 'Nowhere To Be Found');
    connector.byQuery.set('opeth|windowpane', { serviceId: 'sp-1', name: 'Windowpane', artistName: 'Opeth' });
    connector.byQuery.set('katatonia|lethean', { serviceId: 'sp-2', name: 'Lethean', artistName: 'Katatonia' });
    // t3 has no search hit -> unmatched.

    const tracks = [
      { trackId: t1, name: 'Windowpane', artistName: 'Opeth' },
      { trackId: t2, name: 'Lethean', artistName: 'Katatonia' },
      { trackId: t3, name: 'Nowhere To Be Found', artistName: 'Obscure' },
    ];
    const result = await pushPlaylist(handle, connector, 'spotify', 'Forgotten', 'desc', tracks);

    expect(connector.createdName).toBe('Forgotten');
    expect(connector.addedIds).toEqual(['sp-1', 'sp-2']);
    expect(result.matchedCount).toBe(2);
    expect(result.unmatched.map((u) => u.name)).toEqual(['Nowhere To Be Found']);
    expect(result.playlistUrl).toBe('https://open.spotify.com/playlist/PL1');

    // Logged for later "exclude recently playlisted" filters.
    const logged = handle.sqlite.prepare('SELECT COUNT(*) c FROM playlist_log_tracks').get() as { c: number };
    expect(logged.c).toBe(2);
    const log = handle.sqlite.prepare('SELECT service, name FROM playlist_log').get() as any;
    expect(log).toEqual({ service: 'spotify', name: 'Forgotten' });
  });

  it('still creates an (empty) playlist when nothing matches', async () => {
    const t1 = addTrack('Nobody', 'Unfindable');
    const result = await pushPlaylist(handle, connector, 'spotify', 'Empty', 'd', [
      { trackId: t1, name: 'Unfindable', artistName: 'Nobody' },
    ]);
    expect(result.matchedCount).toBe(0);
    expect(connector.addedIds).toEqual([]);
    expect(connector.createdName).toBe('Empty');
  });
});
