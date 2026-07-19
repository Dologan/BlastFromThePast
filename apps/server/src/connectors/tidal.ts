import { randomUUID } from 'node:crypto';
import type { AlbumQuery, ArtistQuery, ServiceAlbum, ServiceArtist, ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';
import { SERVICE_CONFIG } from '../auth/serviceConfig.js';
import { chunk, ConnectorError, type ConnectorFetch } from './http.js';

const REMOVE_LIKED_BATCH_SIZE = 20; // No documented max was found -- conservative default.

const API = SERVICE_CONFIG.tidal.apiBase;
const JSON_API = 'application/vnd.api+json';

/**
 * TIDAL v2 (openapi.tidal.com) connector. TIDAL's write/collection API is
 * comparatively new and JSON:API-shaped; the exact endpoint paths and payloads
 * below follow the documented v2 shape but should be treated as needing live
 * verification against a real developer app.
 *
 * `getLikedTracks`/`removeLikedTracks` use the `userCollectionTracks` resource
 * (`GET`/`DELETE .../{id}/relationships/items`, `id="me"`), confirmed present
 * in TIDAL's current OpenAPI spec. `listPlaylists` uses the sibling
 * `userCollectionPlaylists` resource by analogy -- its exact response/`include`
 * shape was not directly confirmed, so treat it as needing a live check too.
 */
function includedTrack(id: string, included: any[]): { name?: string; artistName?: string; isrc?: string } {
  const artistsById = new Map<string, string>();
  for (const r of included) if (r?.type === 'artists') artistsById.set(r.id, r.attributes?.name ?? '');
  const track = included.find((r) => r?.type === 'tracks' && r.id === id);
  if (!track) return {};
  const artistRef = track.relationships?.artists?.data?.[0]?.id;
  return {
    name: track.attributes?.title,
    artistName: artistRef ? artistsById.get(artistRef) : undefined,
    isrc: track.attributes?.isrc,
  };
}

export class TidalConnector implements ServiceConnector {
  readonly service = 'tidal' as const;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly isAuthorizedFn: () => boolean,
    private readonly countryCode: string,
    private readonly fetchImpl: ConnectorFetch = ((url, init) => fetch(url, init)) as ConnectorFetch,
  ) {}

  async isAuthorized(): Promise<boolean> {
    return this.isAuthorizedFn();
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<any> {
    const token = await this.getToken();
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API}${path}${sep}countryCode=${encodeURIComponent(this.countryCode)}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: JSON_API,
        'Content-Type': JSON_API,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ConnectorError(`TIDAL HTTP ${res.status} for ${method} ${path}: ${await res.text()}`, res.status);
    }
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async searchTrack(query: TrackQuery): Promise<ServiceTrack[]> {
    const term = query.isrc ? query.isrc : `${query.artistName} ${query.trackName}`;
    const data = await this.request(
      'GET',
      `/searchResults/${encodeURIComponent(term)}?include=tracks`,
    );
    // JSON:API: track resources arrive in `included`; artist names, when
    // present, are separate included resources referenced by relationship.
    const included: any[] = data?.included ?? [];
    const artistsById = new Map<string, string>();
    for (const r of included) if (r?.type === 'artists') artistsById.set(r.id, r.attributes?.name ?? '');
    return included
      .filter((r) => r?.type === 'tracks')
      .map((r) => {
        const artistRef = r.relationships?.artists?.data?.[0]?.id;
        return {
          serviceId: String(r.id),
          name: r.attributes?.title ?? '',
          artistName: (artistRef && artistsById.get(artistRef)) || query.artistName,
          isrc: r.attributes?.isrc,
          durationMs: r.attributes?.duration ? Number(r.attributes.duration) * 1000 : undefined,
        } satisfies ServiceTrack;
      });
  }

  async searchAlbum(query: AlbumQuery): Promise<ServiceAlbum[]> {
    const term = `${query.artistName} ${query.albumName}`;
    const data = await this.request('GET', `/searchResults/${encodeURIComponent(term)}?include=albums`);
    const included: any[] = data?.included ?? [];
    const artistsById = new Map<string, string>();
    for (const r of included) if (r?.type === 'artists') artistsById.set(r.id, r.attributes?.name ?? '');
    return included
      .filter((r) => r?.type === 'albums')
      .map((r) => {
        const artistRef = r.relationships?.artists?.data?.[0]?.id;
        return {
          serviceId: String(r.id),
          name: r.attributes?.title ?? '',
          artistName: (artistRef && artistsById.get(artistRef)) || query.artistName,
        } satisfies ServiceAlbum;
      });
  }

  async searchArtist(query: ArtistQuery): Promise<ServiceArtist[]> {
    const data = await this.request('GET', `/searchResults/${encodeURIComponent(query.artistName)}?include=artists`);
    const included: any[] = data?.included ?? [];
    return included
      .filter((r) => r?.type === 'artists')
      .map((r) => ({ serviceId: String(r.id), name: r.attributes?.name ?? '' }) satisfies ServiceArtist);
  }

  async createPlaylist(name: string, description: string): Promise<string> {
    const data = await this.request('POST', '/playlists', {
      data: { type: 'playlists', attributes: { name, description, accessType: 'UNLISTED' } },
    });
    return String(data?.data?.id);
  }

  async setPlaylistTracks(playlistId: string, serviceTrackIds: string[]): Promise<void> {
    if (serviceTrackIds.length === 0) return;
    await this.request('POST', `/playlists/${playlistId}/relationships/items`, {
      data: serviceTrackIds.map((id) => ({ type: 'tracks', id })),
    });
  }

  /** Track ids currently in the playlist, for append-mode de-duplication. */
  async getPlaylistTrackIds(playlistId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const path = `/playlists/${playlistId}/relationships/items${cursor ? `?page[cursor]=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.request('GET', path);
      for (const item of data?.data ?? []) {
        if (item?.id) ids.push(String(item.id));
      }
      const next = data?.links?.meta?.nextCursor;
      if (!next) break;
      cursor = next;
    }
    return ids;
  }

  /** Empties a playlist -- TIDAL's item-add endpoint only appends, so a "replace"
   * push needs this before setPlaylistTracks. */
  async clearPlaylist(playlistId: string): Promise<void> {
    const ids = await this.getPlaylistTrackIds(playlistId);
    if (ids.length === 0) return;
    await this.request('DELETE', `/playlists/${playlistId}/relationships/items`, {
      data: ids.map((id) => ({ type: 'tracks', id })),
    });
  }

  /** Paginated liked tracks via the `userCollectionTracks` resource. */
  async *getLikedTracks(): AsyncIterable<{ track: ServiceTrack; likedAt?: number }> {
    let cursor: string | undefined;
    for (let page = 0; page < 500; page++) {
      const path = `/userCollectionTracks/me/relationships/items?include=items${cursor ? `&page[cursor]=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.request('GET', path);
      const included: any[] = data?.included ?? [];
      for (const item of data?.data ?? []) {
        if (!item?.id) continue;
        const info = includedTrack(String(item.id), included);
        const likedAt = item.meta?.addedAt ? Math.floor(Date.parse(item.meta.addedAt) / 1000) : undefined;
        yield {
          track: {
            serviceId: String(item.id),
            name: info.name ?? '',
            artistName: info.artistName ?? '',
            isrc: info.isrc,
          },
          likedAt,
        };
      }
      const next = data?.links?.meta?.nextCursor;
      if (!next) break;
      cursor = next;
    }
  }

  /** Removes tracks from the user's liked tracks collection. Requires a collection-write scope. */
  async removeLikedTracks(serviceTrackIds: string[]): Promise<void> {
    for (const batch of chunk(serviceTrackIds, REMOVE_LIKED_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      await this.request(
        'DELETE',
        '/userCollectionTracks/me/relationships/items',
        { data: batch.map((id) => ({ id, type: 'tracks' })) },
        { 'Idempotency-Key': randomUUID() },
      );
    }
  }

  /** The user's playlists via the `userCollectionPlaylists` resource (by analogy with
   * `userCollectionTracks`; unlike that resource this shape wasn't directly confirmed). */
  async listPlaylists(): Promise<{ serviceId: string; name: string; isOwn: boolean }[]> {
    const out: { serviceId: string; name: string; isOwn: boolean }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const path = `/userCollectionPlaylists/me/relationships/items?include=items${cursor ? `&page[cursor]=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.request('GET', path);
      const included: any[] = data?.included ?? [];
      for (const item of data?.data ?? []) {
        if (!item?.id) continue;
        const playlist = included.find((r) => r?.type === 'playlists' && r.id === item.id);
        // isOwn isn't reliably determinable from this shape without a confirmed
        // owner relationship -- defaults to true (everything in "my collection").
        out.push({ serviceId: String(item.id), name: playlist?.attributes?.name ?? '', isOwn: true });
      }
      const next = data?.links?.meta?.nextCursor;
      if (!next) break;
      cursor = next;
    }
    return out;
  }

  async getPlaylistItems(
    playlistId: string,
  ): Promise<{ serviceTrackId: string; name?: string; artistName?: string; isrc?: string }[]> {
    const out: { serviceTrackId: string; name?: string; artistName?: string; isrc?: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 500; page++) {
      const path = `/playlists/${playlistId}/relationships/items?include=items${cursor ? `&page[cursor]=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.request('GET', path);
      const included: any[] = data?.included ?? [];
      for (const item of data?.data ?? []) {
        if (!item?.id) continue;
        out.push({ serviceTrackId: String(item.id), ...includedTrack(String(item.id), included) });
      }
      const next = data?.links?.meta?.nextCursor;
      if (!next) break;
      cursor = next;
    }
    return out;
  }

  deepLinkTrack(serviceId: string): string {
    return `https://tidal.com/browse/track/${serviceId}`;
  }

  deepLinkAlbum(serviceAlbumId: string): string {
    return `https://tidal.com/browse/album/${serviceAlbumId}`;
  }

  deepLinkArtist(serviceArtistId: string): string {
    return `https://tidal.com/browse/artist/${serviceArtistId}`;
  }

  deepLinkPlaylist(servicePlaylistId: string): string {
    return `https://tidal.com/browse/playlist/${servicePlaylistId}`;
  }
}
