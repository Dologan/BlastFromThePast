import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';
import { SERVICE_CONFIG } from '../auth/serviceConfig.js';
import { authedJson, chunk, type ConnectorFetch } from './http.js';

const API = SERVICE_CONFIG.spotify.apiBase;
const MAX_TRACKS_PER_REQUEST = 100; // Spotify's add-items cap

function toServiceTrack(item: any): ServiceTrack {
  return {
    serviceId: String(item.id),
    name: item.name,
    artistName: item.artists?.[0]?.name ?? '',
    albumName: item.album?.name,
    isrc: item.external_ids?.isrc,
    durationMs: item.duration_ms,
  };
}

export class SpotifyConnector implements ServiceConnector {
  readonly service = 'spotify' as const;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly isAuthorizedFn: () => boolean,
    private readonly fetchImpl: ConnectorFetch = ((url, init) => fetch(url, init)) as ConnectorFetch,
  ) {}

  async isAuthorized(): Promise<boolean> {
    return this.isAuthorizedFn();
  }

  async searchTrack(query: TrackQuery): Promise<ServiceTrack[]> {
    const q = query.isrc
      ? `isrc:${query.isrc}`
      : `track:${query.trackName} artist:${query.artistName}`;
    const url = `${API}/search?type=track&limit=5&q=${encodeURIComponent(q)}`;
    const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
    return (data?.tracks?.items ?? []).map(toServiceTrack);
  }

  async createPlaylist(name: string, description: string): Promise<string> {
    const data = await authedJson(this.fetchImpl, this.getToken, 'POST', `${API}/me/playlists`, {
      name,
      description,
      public: false,
    });
    return String(data.id);
  }

  async setPlaylistTracks(playlistId: string, serviceTrackIds: string[]): Promise<void> {
    const uris = serviceTrackIds.map((id) => `spotify:track:${id}`);
    // First batch replaces, subsequent batches append (so >100 tracks work).
    let first = true;
    for (const batch of chunk(uris, MAX_TRACKS_PER_REQUEST)) {
      await authedJson(
        this.fetchImpl,
        this.getToken,
        first ? 'PUT' : 'POST',
        `${API}/playlists/${playlistId}/tracks`,
        { uris: batch },
      );
      first = false;
    }
  }

  async *getLikedTracks(): AsyncIterable<{ track: ServiceTrack; likedAt?: number }> {
    let url: string | null = `${API}/me/tracks?limit=50`;
    while (url) {
      const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
      for (const item of data?.items ?? []) {
        if (!item?.track) continue;
        const likedAt = item.added_at ? Math.floor(Date.parse(item.added_at) / 1000) : undefined;
        yield { track: toServiceTrack(item.track), likedAt };
      }
      url = data?.next ?? null;
    }
  }

  deepLinkTrack(serviceId: string): string {
    return `https://open.spotify.com/track/${serviceId}`;
  }

  deepLinkAlbum(serviceAlbumId: string): string {
    return `https://open.spotify.com/album/${serviceAlbumId}`;
  }

  deepLinkPlaylist(servicePlaylistId: string): string {
    return `https://open.spotify.com/playlist/${servicePlaylistId}`;
  }
}
