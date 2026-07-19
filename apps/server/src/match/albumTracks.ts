import type { DbHandle } from '@bftp/db';

export interface AlbumTrack {
  trackId: number;
  name: string;
  artistName: string;
}

/** All library tracks of an album (via its scrobbles), oldest-first-heard. */
export function expandAlbumTracks(handle: DbHandle, albumId: number): AlbumTrack[] {
  return handle.sqlite
    .prepare(
      `SELECT t.id AS trackId, t.name AS name, a.name AS artistName
       FROM scrobbles s
       JOIN tracks t ON t.id = s.track_id
       JOIN artists a ON a.id = t.artist_id
       WHERE s.album_id = ?
       GROUP BY t.id
       ORDER BY MIN(s.uts)`,
    )
    .all(albumId) as AlbumTrack[];
}
