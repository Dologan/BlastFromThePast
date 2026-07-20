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

export interface ServiceAlbum {
  serviceId: string;
  name: string;
  artistName: string;
}

export interface ServiceArtist {
  serviceId: string;
  name: string;
}

export interface TrackQuery {
  isrc?: string;
  artistName: string;
  trackName: string;
}

export interface AlbumQuery {
  artistName: string;
  albumName: string;
}

export interface ArtistQuery {
  artistName: string;
}

export interface ServiceConnector {
  readonly service: ServiceName;
  /** True once OAuth tokens are stored and valid/refreshable. */
  isAuthorized(): Promise<boolean>;
  searchTrack(query: TrackQuery): Promise<ServiceTrack[]>;
  /** Optional: not every connector implementation needs album/artist resolution
   * (e.g. push only ever matches tracks). Used to resolve a direct deep link
   * for library albums/artists instead of falling back to a search URL. */
  searchAlbum?(query: AlbumQuery): Promise<ServiceAlbum[]>;
  searchArtist?(query: ArtistQuery): Promise<ServiceArtist[]>;
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
  /** Adds tracks to a playlist WITHOUT ever replacing existing contents -- unlike
   * setPlaylistTracks, whose first batch may replace on some implementations (Spotify).
   * Used to add a single corrected match into an already-pushed playlist. */
  appendPlaylistTracks?(playlistId: string, serviceTrackIds: string[]): Promise<void>;
  /** Removes specific tracks from a playlist by service track id, leaving the rest
   * untouched -- unlike clearPlaylist, which empties it entirely. */
  removePlaylistTracks?(playlistId: string, serviceTrackIds: string[]): Promise<void>;
  /** Liked tracks, where the service exposes them. */
  getLikedTracks?(): AsyncIterable<{ track: ServiceTrack; likedAt?: number }>;
  /** Removes tracks from the user's liked/favorite tracks, where the service supports it. */
  removeLikedTracks?(serviceTrackIds: string[]): Promise<void>;
  /** The user's own playlists (for playlist-inventory sync / exclusion). Optional. */
  listPlaylists?(): Promise<{ serviceId: string; name: string; isOwn: boolean }[]>;
  /** Track items of a playlist, with enough identity to match back to the library. Optional. */
  getPlaylistItems?(
    playlistId: string,
  ): Promise<{ serviceTrackId: string; name?: string; artistName?: string; isrc?: string }[]>;
  deepLinkTrack(serviceId: string): string;
  deepLinkAlbum(serviceAlbumId: string): string;
  deepLinkArtist(serviceArtistId: string): string;
  deepLinkPlaylist(servicePlaylistId: string): string;
}
