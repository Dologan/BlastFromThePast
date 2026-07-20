import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    return {
      ok: true,
      status: body === undefined ? 204 : 200,
      json: async () => body,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

/** A fetch fake that plays back a fixed sequence of responses (status/body/headers),
 * repeating the last one for any calls beyond the queue -- for retry/backoff tests. */
function queueResponder(steps: { status: number; body?: unknown; headers?: Record<string, string> }[]): {
  fetchImpl: ConnectorFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl: ConnectorFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const step = steps[Math.min(i, steps.length - 1)]!;
    i++;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (name: string) => step.headers?.[name.toLowerCase()] ?? null },
      json: async () => step.body,
      text: async () => (step.body === undefined ? '' : JSON.stringify(step.body)),
    };
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

  it('getPlaylistTrackIds paginates via next', async () => {
    let page = 0;
    const { fetchImpl } = recorder(() => {
      page++;
      if (page === 1) return { items: [{ track: { id: 's1' } }], next: 'https://api.spotify.com/v1/playlists/pl1/tracks?offset=100' };
      return { items: [{ track: { id: 's2' } }], next: null };
    });
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    expect(await c.getPlaylistTrackIds('pl1')).toEqual(['s1', 's2']);
  });

  it('setPlaylistTracks with an empty list still issues one PUT, to actually clear the playlist', async () => {
    const { fetchImpl, calls } = recorder(() => ({}));
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    await c.setPlaylistTracks('pl1', []);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.body!).uris).toEqual([]);
  });

  it('searches albums and artists, and builds their deep links', async () => {
    const { fetchImpl, calls } = recorder((url) =>
      url.includes('type=album')
        ? { albums: { items: [{ id: 'al1', name: 'Ghost Reveries', artists: [{ name: 'Opeth' }] }] } }
        : { artists: { items: [{ id: 'ar1', name: 'Opeth' }] } },
    );
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    const albums = await c.searchAlbum!({ artistName: 'Opeth', albumName: 'Ghost Reveries' });
    expect(albums[0]).toEqual({ serviceId: 'al1', name: 'Ghost Reveries', artistName: 'Opeth' });
    expect(calls[0]!.url).toContain(encodeURIComponent('album:Ghost Reveries artist:Opeth'));

    const artists = await c.searchArtist!({ artistName: 'Opeth' });
    expect(artists[0]).toEqual({ serviceId: 'ar1', name: 'Opeth' });

    expect(c.deepLinkArtist('ar1')).toBe('https://open.spotify.com/artist/ar1');
  });

  it('appendPlaylistTracks always POSTs, even for a single track, unlike setPlaylistTracks', async () => {
    const { fetchImpl, calls } = recorder(() => ({}));
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    await c.appendPlaylistTracks!('pl1', ['t1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!).uris).toEqual(['spotify:track:t1']);
  });

  it('appendPlaylistTracks batches >100 tracks, all as POST', async () => {
    const { fetchImpl, calls } = recorder(() => ({}));
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    await c.appendPlaylistTracks!('pl1', ids);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('removePlaylistTracks issues a DELETE with the track uris', async () => {
    const { fetchImpl, calls } = recorder(() => ({}));
    const c = new SpotifyConnector(token, () => true, fetchImpl);
    await c.removePlaylistTracks!('pl1', ['t1', 't2']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(JSON.parse(calls[0]!.body!).tracks).toEqual([{ uri: 'spotify:track:t1' }, { uri: 'spotify:track:t2' }]);
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

  it('does not choke on a 2xx response with an empty body', async () => {
    // Some JSON:API writes return 200/201 with no body rather than 204 —
    // calling res.json() unconditionally would throw on the empty string.
    const fetchImpl: ConnectorFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('should not be called on an empty body');
      },
      text: async () => '',
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await expect(c.setPlaylistTracks('tpl1', ['t1'])).resolves.toBeUndefined();
  });

  it('setPlaylistTracks with an empty list makes no HTTP call', async () => {
    const { fetchImpl, calls } = recorder(() => ({}));
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.setPlaylistTracks('tpl1', []);
    expect(calls).toHaveLength(0);
  });

  it('getPlaylistTrackIds paginates via page[cursor]', async () => {
    const { fetchImpl } = recorder((url) => {
      if (url.includes('page[cursor]=CURSOR1')) return { data: [{ id: 't3', type: 'tracks', meta: { itemId: 'i3' } }] };
      return {
        data: [{ id: 't1', type: 'tracks', meta: { itemId: 'i1' } }, { id: 't2', type: 'tracks', meta: { itemId: 'i2' } }],
        links: { meta: { nextCursor: 'CURSOR1' } },
      };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    expect(await c.getPlaylistTrackIds('tpl1')).toEqual(['t1', 't2', 't3']);
  });

  it('clearPlaylist fetches existing items then DELETEs them with each item\'s meta.itemId', async () => {
    const { fetchImpl, calls } = recorder((_url, method) => {
      if (method === 'DELETE') return undefined; // 204
      return { data: [{ id: 't1', type: 'tracks', meta: { itemId: 'i1' } }, { id: 't2', type: 'tracks', meta: { itemId: 'i2' } }] };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.clearPlaylist('tpl1');
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(del.body!).data).toEqual([
      { type: 'tracks', id: 't1', meta: { itemId: 'i1' } },
      { type: 'tracks', id: 't2', meta: { itemId: 'i2' } },
    ]);
  });

  it('clearPlaylist makes no DELETE call when the playlist is already empty', async () => {
    const { fetchImpl, calls } = recorder(() => ({ data: [] }));
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.clearPlaylist('tpl1');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('deletePlaylist issues a bare DELETE against the playlist resource', async () => {
    const { fetchImpl, calls } = recorder(() => undefined);
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.deletePlaylist!('tpl1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/playlists/tpl1');
    expect(calls[0]!.url).not.toContain('/relationships/items');
  });

  it('searches albums and artists via included resources, and builds their deep links', async () => {
    const { fetchImpl, calls } = recorder((url) => {
      if (url.includes('include=albums')) {
        return {
          included: [
            { type: 'artists', id: 'a1', attributes: { name: 'Opeth' } },
            { type: 'albums', id: 'al1', attributes: { title: 'Ghost Reveries' }, relationships: { artists: { data: [{ id: 'a1' }] } } },
          ],
        };
      }
      return { included: [{ type: 'artists', id: 'a1', attributes: { name: 'Opeth' } }] };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);

    const albums = await c.searchAlbum!({ artistName: 'Opeth', albumName: 'Ghost Reveries' });
    expect(albums[0]).toEqual({ serviceId: 'al1', name: 'Ghost Reveries', artistName: 'Opeth' });
    expect(calls[0]!.url).toContain('include=albums');

    const artists = await c.searchArtist!({ artistName: 'Opeth' });
    expect(artists[0]).toEqual({ serviceId: 'a1', name: 'Opeth' });

    expect(c.deepLinkArtist('a1')).toBe('https://tidal.com/browse/artist/a1');
  });

  it('searches via the paginated /relationships/tracks endpoint, not the unpaginated base endpoint', async () => {
    const { fetchImpl, calls } = recorder((url) => {
      if (url.includes('page[cursor]=CURSOR1')) {
        return { included: [{ type: 'tracks', id: 't2', attributes: { title: 'Second Page Match' } }] };
      }
      return {
        included: [{ type: 'tracks', id: 't1', attributes: { title: 'First Page' } }],
        links: { meta: { nextCursor: 'CURSOR1' } },
      };
    });
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    const res = await c.searchTrack({ artistName: 'At the Gates', trackName: 'World of Lies' });
    expect(calls[0]!.url).toContain('/relationships/tracks');
    expect(calls[0]!.url).not.toMatch(/searchResults\/[^/]+\?/); // not the base endpoint
    // Both pages' results are considered as candidates, not just the first.
    expect(res.map((t) => t.serviceId)).toEqual(['t1', 't2']);
  });

  it('stops paginating search results after SEARCH_MAX_PAGES even if more pages exist', async () => {
    const { fetchImpl, calls } = recorder((url) => {
      const cursor = url.includes('page[cursor]=') ? url.split('page[cursor]=')[1] : '0';
      return {
        included: [{ type: 'tracks', id: `t${cursor}`, attributes: { title: 'X' } }],
        links: { meta: { nextCursor: String(Number(cursor) + 1) } }, // always another page available
      };
    });
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    await c.searchTrack({ artistName: 'A', trackName: 'B' });
    expect(calls.length).toBe(3); // capped, not infinite
  });

  it('appendPlaylistTracks adds without fetching or touching existing items', async () => {
    const { fetchImpl, calls } = recorder(() => undefined);
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.appendPlaylistTracks!('tpl1', ['t1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!).data).toEqual([{ type: 'tracks', id: 't1' }]);
  });

  it('removePlaylistTracks looks up each item\'s meta.itemId before DELETEing -- TIDAL requires it per entry', async () => {
    const { fetchImpl, calls } = recorder((_url, method) => {
      if (method === 'DELETE') return undefined; // 204
      return {
        data: [
          { id: 't1', type: 'tracks', meta: { itemId: 'i1' } },
          { id: 't2', type: 'tracks', meta: { itemId: 'i2' } },
        ],
      };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.removePlaylistTracks!('tpl1', ['t1']);
    expect(calls.some((c) => c.method === 'GET')).toBe(true); // fetches item refs to get meta.itemId
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(del.body!).data).toEqual([{ type: 'tracks', id: 't1', meta: { itemId: 'i1' } }]);
  });

  it('removePlaylistTracks with an empty list makes no HTTP call', async () => {
    const { fetchImpl, calls } = recorder(() => undefined);
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.removePlaylistTracks!('tpl1', []);
    expect(calls).toHaveLength(0);
  });

  it('removePlaylistTracks removes every occurrence of a repeated track, each with its own meta.itemId', async () => {
    const { fetchImpl, calls } = recorder((_url, method) => {
      if (method === 'DELETE') return undefined; // 204
      return {
        data: [
          { id: 't1', type: 'tracks', meta: { itemId: 'i1' } },
          { id: 't1', type: 'tracks', meta: { itemId: 'i1b' } }, // same track, second occurrence
          { id: 't2', type: 'tracks', meta: { itemId: 'i2' } },
        ],
      };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.removePlaylistTracks!('tpl1', ['t1']);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(del.body!).data).toEqual([
      { type: 'tracks', id: 't1', meta: { itemId: 'i1' } },
      { type: 'tracks', id: 't1', meta: { itemId: 'i1b' } },
    ]);
  });

  it('removePlaylistTracks batches large ref lists rather than sending one unbounded request', async () => {
    const refs = Array.from({ length: 45 }, (_, i) => ({ id: `t${i}`, type: 'tracks', meta: { itemId: `i${i}` } }));
    const { fetchImpl, calls } = recorder((_url, method) => (method === 'DELETE' ? undefined : { data: refs }));
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.removePlaylistTracks!(
      'tpl1',
      refs.map((r) => r.id),
    );
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(3); // 45 refs at a batch size of 20
    const sent = deletes.flatMap((c) => JSON.parse(c.body!).data.map((d: any) => d.id));
    expect(sent).toEqual(refs.map((r) => r.id));
  });

  it('clearPlaylist deletes every occurrence, even when a playlist lists the same track twice', async () => {
    const { fetchImpl, calls } = recorder((_url, method) => {
      if (method === 'DELETE') return undefined; // 204
      return {
        data: [
          { id: 't1', type: 'tracks', meta: { itemId: 'i1' } },
          { id: 't1', type: 'tracks', meta: { itemId: 'i1b' } },
          { id: 't2', type: 'tracks', meta: { itemId: 'i2' } },
        ],
      };
    });
    const c = new TidalConnector(token, () => true, 'GB', fetchImpl);
    await c.clearPlaylist('tpl1');
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(del.body!).data).toEqual([
      { type: 'tracks', id: 't1', meta: { itemId: 'i1' } },
      { type: 'tracks', id: 't1', meta: { itemId: 'i1b' } },
      { type: 'tracks', id: 't2', meta: { itemId: 'i2' } },
    ]);
  });
});

describe('TIDAL request retry-with-backoff on 429/503', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries once on 429 then succeeds', async () => {
    const { fetchImpl, calls } = queueResponder([
      { status: 429 },
      { status: 200, body: { included: [{ type: 'tracks', id: 't1', attributes: { title: 'Song' } }] } },
    ]);
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    const promise = c.searchTrack({ artistName: 'A', trackName: 'B' });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(calls.length).toBe(2);
    expect(res[0]!.name).toBe('Song');
  });

  it('honors a numeric Retry-After header instead of the default backoff', async () => {
    const { fetchImpl, calls } = queueResponder([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { included: [] } },
    ]);
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    const promise = c.searchTrack({ artistName: 'A', trackName: 'B' });
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(calls.length).toBe(2);
  });

  it('retries on 503 the same way as 429', async () => {
    const { fetchImpl, calls } = queueResponder([{ status: 503 }, { status: 200, body: { included: [] } }]);
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    const promise = c.searchTrack({ artistName: 'A', trackName: 'B' });
    await vi.runAllTimersAsync();
    await promise;
    expect(calls.length).toBe(2);
  });

  it('gives up after exhausting retries and throws a ConnectorError carrying the status', async () => {
    const { fetchImpl, calls } = queueResponder([{ status: 429, body: { errors: [{ detail: 'Rate limit exceeded' }] } }]);
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    const promise = c.searchTrack({ artistName: 'A', trackName: 'B' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await promise) as { status?: number; message: string };
    expect(err.status).toBe(429);
    expect(calls.length).toBe(5); // 1 initial + 4 retries
  });

  it('does not retry on a non-retryable error status (e.g. 401)', async () => {
    const { fetchImpl, calls } = queueResponder([{ status: 401, body: { errors: [{ detail: 'unauthorized' }] } }]);
    const c = new TidalConnector(token, () => true, 'US', fetchImpl);
    await expect(c.searchTrack({ artistName: 'A', trackName: 'B' })).rejects.toThrow(/401/);
    expect(calls.length).toBe(1);
  });
});
