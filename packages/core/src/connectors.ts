/**
 * Abstraction over streaming services that can receive playlists (Spotify,
 * TIDAL). Last.fm is a data *source*, not a connector. Implementations arrive
 * in the connectors phase; the interface lives here so the filter/output
 * pipeline can be written against it.
 */

export type ServiceName = 'spotify' | 'tidal';

export interface ServiceTrack {
  serviceId: string;
  name: string;
  artistName: string;
  albumName?: string;
  isrc?: string;
  durationMs?: number;
}

export interface TrackQuery {
  isrc?: string;
  artistName: string;
  trackName: string;
}

export interface ServiceConnector {
  readonly service: ServiceName;
  /** True once OAuth tokens are stored and valid/refreshable. */
  isAuthorized(): Promise<boolean>;
  searchTrack(query: TrackQuery): Promise<ServiceTrack[]>;
  createPlaylist(name: string, description: string): Promise<string>;
  /** Adds tracks to a playlist. Some implementations (Spotify) fully replace the
   * contents when called on an empty/fresh playlist; see `clearPlaylist`. */
  setPlaylistTracks(playlistId: string, serviceTrackIds: string[]): Promise<void>;
  /** Track ids currently in a playlist, for append-mode de-duplication. Optional; if
   * absent, an append just adds without checking for existing tracks. */
  getPlaylistTrackIds?(playlistId: string): Promise<string[]>;
  /** Empties a playlist so it can be fully replaced via setPlaylistTracks. Optional;
   * connectors whose setPlaylistTracks already replaces outright (Spotify) don't need it. */
  clearPlaylist?(playlistId: string): Promise<void>;
  /** Liked tracks, where the service exposes them (Spotify yes, TIDAL not yet). */
  getLikedTracks?(): AsyncIterable<{ track: ServiceTrack; likedAt?: number }>;
  deepLinkTrack(serviceId: string): string;
  deepLinkAlbum(serviceAlbumId: string): string;
  deepLinkPlaylist(servicePlaylistId: string): string;
}
