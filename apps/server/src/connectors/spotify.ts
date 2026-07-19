import type { AlbumQuery, ArtistQuery, ServiceAlbum, ServiceArtist, ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';
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

  async searchAlbum(query: AlbumQuery): Promise<ServiceAlbum[]> {
    const q = `album:${query.albumName} artist:${query.artistName}`;
    const url = `${API}/search?type=album&limit=5&q=${encodeURIComponent(q)}`;
    const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
    return (data?.albums?.items ?? []).map((item: any) => ({
      serviceId: String(item.id),
      name: item.name,
      artistName: item.artists?.[0]?.name ?? '',
    }));
  }

  async searchArtist(query: ArtistQuery): Promise<ServiceArtist[]> {
    const q = `artist:${query.artistName}`;
    const url = `${API}/search?type=artist&limit=5&q=${encodeURIComponent(q)}`;
    const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
    return (data?.artists?.items ?? []).map((item: any) => ({ serviceId: String(item.id), name: item.name }));
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
    // First batch replaces (PUT), subsequent batches append (POST) so >100
    // tracks work; an empty list still issues one PUT since that's how the
    // Spotify API empties a playlist (a "replace" push may have zero matches).
    const batches = chunk(uris, MAX_TRACKS_PER_REQUEST);
    if (batches.length === 0) batches.push([]);
    let first = true;
    for (const batch of batches) {
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

  /** Track ids currently in the playlist, for append-mode de-duplication. */
  async getPlaylistTrackIds(playlistId: string): Promise<string[]> {
    const ids: string[] = [];
    let url: string | null = `${API}/playlists/${playlistId}/tracks?fields=items(track(id)),next&limit=100`;
    while (url) {
      const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
      for (const item of data?.items ?? []) {
        if (item?.track?.id) ids.push(String(item.track.id));
      }
      url = data?.next ?? null;
    }
    return ids;
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

  /** Removes tracks from Liked Songs. Requires the `user-library-modify` scope. */
  async removeLikedTracks(serviceTrackIds: string[]): Promise<void> {
    for (const batch of chunk(serviceTrackIds, MAX_TRACKS_PER_REQUEST)) {
      if (batch.length === 0) continue;
      await authedJson(this.fetchImpl, this.getToken, 'DELETE', `${API}/me/tracks`, { ids: batch });
    }
  }

  /** The user's own and followed playlists. */
  async listPlaylists(): Promise<{ serviceId: string; name: string; isOwn: boolean }[]> {
    const me = await authedJson(this.fetchImpl, this.getToken, 'GET', `${API}/me`);
    const meId = me?.id;
    const out: { serviceId: string; name: string; isOwn: boolean }[] = [];
    let url: string | null = `${API}/me/playlists?limit=50`;
    while (url) {
      const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
      for (const item of data?.items ?? []) {
        if (!item?.id) continue;
        out.push({ serviceId: String(item.id), name: item.name ?? '', isOwn: item.owner?.id === meId });
      }
      url = data?.next ?? null;
    }
    return out;
  }

  async getPlaylistItems(
    playlistId: string,
  ): Promise<{ serviceTrackId: string; name?: string; artistName?: string; isrc?: string }[]> {
    const out: { serviceTrackId: string; name?: string; artistName?: string; isrc?: string }[] = [];
    let url: string | null =
      `${API}/playlists/${playlistId}/tracks?fields=items(track(id,name,artists(name),external_ids(isrc))),next&limit=100`;
    while (url) {
      const data = await authedJson(this.fetchImpl, this.getToken, 'GET', url);
      for (const item of data?.items ?? []) {
        const track = item?.track;
        if (!track?.id) continue;
        out.push({
          serviceTrackId: String(track.id),
          name: track.name,
          artistName: track.artists?.[0]?.name,
          isrc: track.external_ids?.isrc,
        });
      }
      url = data?.next ?? null;
    }
    return out;
  }

  deepLinkTrack(serviceId: string): string {
    return `https://open.spotify.com/track/${serviceId}`;
  }

  deepLinkAlbum(serviceAlbumId: string): string {
    return `https://open.spotify.com/album/${serviceAlbumId}`;
  }

  deepLinkArtist(serviceArtistId: string): string {
    return `https://open.spotify.com/artist/${serviceArtistId}`;
  }

  deepLinkPlaylist(servicePlaylistId: string): string {
    return `https://open.spotify.com/playlist/${servicePlaylistId}`;
  }
}
