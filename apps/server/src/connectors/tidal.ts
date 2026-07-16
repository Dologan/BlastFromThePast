import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';
import { SERVICE_CONFIG } from '../auth/serviceConfig.js';
import { ConnectorError, type ConnectorFetch } from './http.js';

const API = SERVICE_CONFIG.tidal.apiBase;
const JSON_API = 'application/vnd.api+json';

/**
 * TIDAL v2 (openapi.tidal.com) connector. TIDAL's write/collection API is
 * comparatively new and JSON:API-shaped; the exact endpoint paths and payloads
 * below follow the documented v2 shape but should be treated as needing live
 * verification against a real developer app. `getLikedTracks` is intentionally
 * absent: reading a user's favorite *tracks* is not yet exposed by the TIDAL
 * API (albums/artists/playlists are), so liked-track import comes from Spotify
 * + Last.fm instead.
 */
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

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.getToken();
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API}${path}${sep}countryCode=${encodeURIComponent(this.countryCode)}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: JSON_API,
        'Content-Type': JSON_API,
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

  deepLinkTrack(serviceId: string): string {
    return `https://tidal.com/browse/track/${serviceId}`;
  }

  deepLinkAlbum(serviceAlbumId: string): string {
    return `https://tidal.com/browse/album/${serviceAlbumId}`;
  }

  deepLinkPlaylist(servicePlaylistId: string): string {
    return `https://tidal.com/browse/playlist/${servicePlaylistId}`;
  }
}
