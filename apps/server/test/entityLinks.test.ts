import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import type { AlbumQuery, ArtistQuery, ServiceAlbum, ServiceArtist, ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';
import { resolveDeepLink } from '../src/match/entityLinks.js';

class FakeConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  authorized = true;
  trackHits = new Map<string, ServiceTrack>();
  albumHits = new Map<string, ServiceAlbum>();
  artistHits = new Map<string, ServiceArtist>();
  searchCalls = 0;

  async isAuthorized() {
    return this.authorized;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    this.searchCalls++;
    const hit = this.trackHits.get(`${q.artistName}|${q.trackName}`);
    return hit ? [hit] : [];
  }
  async searchAlbum(q: AlbumQuery): Promise<ServiceAlbum[]> {
    this.searchCalls++;
    const hit = this.albumHits.get(`${q.artistName}|${q.albumName}`);
    return hit ? [hit] : [];
  }
  async searchArtist(q: ArtistQuery): Promise<ServiceArtist[]> {
    this.searchCalls++;
    const hit = this.artistHits.get(q.artistName);
    return hit ? [hit] : [];
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

describe('resolveDeepLink', () => {
  let handle: DbHandle;
  let connector: FakeConnector;

  const mkArtist = (name: string) =>
    Number(handle.sqlite.prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)').run(name, name.toLowerCase()).lastInsertRowid);
  const mkTrack = (artistId: number, name: string) =>
    Number(handle.sqlite.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(artistId, name, name.toLowerCase()).lastInsertRowid);
  const mkAlbum = (artistId: number, name: string) =>
    Number(handle.sqlite.prepare('INSERT INTO albums (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(artistId, name, name.toLowerCase()).lastInsertRowid);

  beforeEach(() => {
    handle = openDb(':memory:');
    connector = new FakeConnector();
  });
  afterEach(() => handle.close());

  it('resolves and caches a track deep link, skipping the search on a second call', async () => {
    const opeth = mkArtist('Opeth');
    const t = mkTrack(opeth, 'Windowpane');
    connector.trackHits.set('Opeth|Windowpane', { serviceId: 'sp-1', name: 'Windowpane', artistName: 'Opeth' });

    const link = await resolveDeepLink(handle, connector, 'spotify', 'track', t);
    expect(link).toBe('https://open.spotify.com/track/sp-1');

    const again = await resolveDeepLink(handle, connector, 'spotify', 'track', t);
    expect(again).toBe('https://open.spotify.com/track/sp-1');
    expect(connector.searchCalls).toBe(1); // second call served from service_links cache

    const cached = handle.sqlite.prepare("SELECT * FROM service_links WHERE entity_type='track' AND entity_id=?").get(t) as any;
    expect(cached.service).toBe('spotify');
    expect(cached.service_id).toBe('sp-1');
  });

  it('resolves an album deep link', async () => {
    const opeth = mkArtist('Opeth');
    const al = mkAlbum(opeth, 'Ghost Reveries');
    connector.albumHits.set('Opeth|Ghost Reveries', { serviceId: 'al-1', name: 'Ghost Reveries', artistName: 'Opeth' });

    const link = await resolveDeepLink(handle, connector, 'spotify', 'album', al);
    expect(link).toBe('https://open.spotify.com/album/al-1');
  });

  it('resolves an artist deep link by name only', async () => {
    const opeth = mkArtist('Opeth');
    connector.artistHits.set('Opeth', { serviceId: 'ar-1', name: 'Opeth' });

    const link = await resolveDeepLink(handle, connector, 'spotify', 'artist', opeth);
    expect(link).toBe('https://open.spotify.com/artist/ar-1');
  });

  it('returns null when not authorized, without searching', async () => {
    connector.authorized = false;
    const opeth = mkArtist('Opeth');
    const t = mkTrack(opeth, 'Windowpane');
    connector.trackHits.set('Opeth|Windowpane', { serviceId: 'sp-1', name: 'Windowpane', artistName: 'Opeth' });

    expect(await resolveDeepLink(handle, connector, 'spotify', 'track', t)).toBeNull();
    expect(connector.searchCalls).toBe(0);
  });

  it('returns null when no candidate is found', async () => {
    const opeth = mkArtist('Opeth');
    const t = mkTrack(opeth, 'Unfindable');
    expect(await resolveDeepLink(handle, connector, 'spotify', 'track', t)).toBeNull();
  });

  it('returns null when the best candidate is too low-confidence to trust', async () => {
    const opeth = mkArtist('Opeth');
    const t = mkTrack(opeth, 'Windowpane');
    // Neither title nor artist matches -> low confidence, should not be linked.
    connector.trackHits.set('Opeth|Windowpane', { serviceId: 'sp-1', name: 'Completely Different', artistName: 'Someone Else' });
    expect(await resolveDeepLink(handle, connector, 'spotify', 'track', t)).toBeNull();
    // And nothing should have been cached.
    const cached = handle.sqlite.prepare("SELECT * FROM service_links WHERE entity_type='track' AND entity_id=?").get(t);
    expect(cached).toBeUndefined();
  });

  it('returns null for a kind the connector cannot search', async () => {
    // A connector without searchAlbum/searchArtist implemented.
    const bare: ServiceConnector = {
      service: 'tidal',
      isAuthorized: async () => true,
      searchTrack: async () => [],
      createPlaylist: async () => 'PL',
      setPlaylistTracks: async () => {},
      deepLinkTrack: (id) => id,
      deepLinkAlbum: (id) => id,
      deepLinkArtist: (id) => id,
      deepLinkPlaylist: (id) => id,
    };
    const opeth = mkArtist('Opeth');
    expect(await resolveDeepLink(handle, bare, 'tidal', 'artist', opeth)).toBeNull();
  });
});
