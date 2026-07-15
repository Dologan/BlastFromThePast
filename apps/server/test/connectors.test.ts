import { describe, it, expect } from 'vitest';
import { SpotifyConnector } from '../src/connectors/spotify.js';
import { TidalConnector } from '../src/connectors/tidal.js';
import type { ConnectorFetch } from '../src/connectors/http.js';

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

function recorder(responder: (url: string, method: string) => unknown): {
  fetchImpl: ConnectorFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: ConnectorFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const body = responder(url, init.method);
    return { ok: true, status: body === undefined ? 204 : 200, json: async () => body, text: async () => '' };
  };
  return { fetchImpl, calls };
}

const token = async () => 'AT';

describe('SpotifyConnector', () => {
  it('searches by ISRC using the isrc: filter', async () => {
    const { fetchImpl, calls } = recorder(() => ({
      tracks: { items: [{ id: 'sp1', name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album' }, external_ids: { isrc: 'X123' }, duration_ms: 1000 }] },
    }));
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    const res = await c.searchTrack({ isrc: 'X123', artistName: 'Artist', trackName: 'Song' });
    expect(calls[0]!.url).toContain(encodeURIComponent('isrc:X123'));
    expect(res[0]).toEqual({ serviceId: 'sp1', name: 'Song', artistName: 'Artist', albumName: 'Album', isrc: 'X123', durationMs: 1000 });
  });

  it('creates a playlist and adds tracks in <=100 batches (PUT then POST)', async () => {
    const { fetchImpl, calls } = recorder((url) => (url.includes('/me/playlists') ? { id: 'pl1' } : {}));
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    const id = await c.createPlaylist('My List', 'desc');
    expect(id).toBe('pl1');

    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    await c.setPlaylistTracks('pl1', ids);
    const trackCalls = calls.filter((c) => c.url.includes('/playlists/pl1/tracks'));
    expect(trackCalls).toHaveLength(2); // 100 + 50
    expect(trackCalls[0]!.method).toBe('PUT'); // first batch replaces
    expect(trackCalls[1]!.method).toBe('POST'); // subsequent append
    expect(JSON.parse(trackCalls[0]!.body!).uris[0]).toBe('spotify:track:t0');
  });

  it('iterates liked tracks across pages', async () => {
    let page = 0;
    const { fetchImpl } = recorder(() => {
      page++;
      if (page === 1) {
        return {
          items: [{ added_at: '2020-01-01T00:00:00Z', track: { id: 's1', name: 'A', artists: [{ name: 'X' }] } }],
          next: 'https://api.spotify.com/v1/me/tracks?offset=50',
        };
      }
      return { items: [{ added_at: '2021-01-01T00:00:00Z', track: { id: 's2', name: 'B', artists: [{ name: 'Y' }] } }], next: null };
    });
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    const seen: string[] = [];
    for await (const { track } of c.getLikedTracks()) seen.push(track.serviceId);
    expect(seen).toEqual(['s1', 's2']);
  });

  it('builds deep links', () => {
    const c = new SpotifyConnector(token, () => true);
    expect(c.deepLinkPlaylist('pl1')).toBe('https://open.spotify.com/playlist/pl1');
  });
});

describe('TidalConnector', () => {
  it('parses JSON:API search results, resolving artist names from included resources', async () => {
    const { fetchImpl, calls } = recorder(() => ({
      included: [
        { type: 'artists', id: 'a1', attributes: { name: 'Opeth' } },
        { type: 'tracks', id: 't1', attributes: { title: 'Ghost of Perdition', isrc: 'X1', duration: 200 }, relationships: { artists: { data: [{ id: 'a1' }] } } },
      ],
    }));
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    const res = await c.searchTrack({ artistName: 'Opeth', trackName: 'Ghost of Perdition' });
    expect(calls[0]!.url).toContain('countryCode=US');
    expect(res[0]).toEqual({ serviceId: 't1', name: 'Ghost of Perdition', artistName: 'Opeth', isrc: 'X1', durationMs: 200000 });
  });

  it('creates a playlist and adds items via JSON:API relationship', async () => {
    const { fetchImpl, calls } = recorder((url) => (url.includes('/playlists?') || url.endsWith('/playlists') ? { data: { id: 'tpl1' } } : undefined));
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    const id = await c.createPlaylist('L', 'd');
    expect(id).toBe('tpl1');
    await c.setPlaylistTracks('tpl1', ['t1', 't2']);
    const addCall = calls.find((c) => c.url.includes('/relationships/items'))!;
    expect(JSON.parse(addCall.body!).data).toEqual([
      { type: 'tracks', id: 't1' },
      { type: 'tracks', id: 't2' },
    ]);
  });
});
