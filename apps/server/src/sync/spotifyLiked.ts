import type { DbHandle } from '@bftp/db';
import { normalizeName, type ServiceConnector } from '@bftp/core';

export interface SpotifyLikedProgress {
  kind: 'spotify-liked';
  seen: number;
  linked: number;
}

export interface SpotifyLikedResult {
  seen: number;
  linked: number;
}

/**
 * Imports Spotify "liked songs" as loved flags on matching library tracks.
 *
 * Only tracks already present in the listening history (matched by normalized
 * artist + title) are flagged -- a liked track that was never scrobbled has no
 * stats and so can't appear in results anyway, so importing it as a bare row
 * would be pointless. Replaces the previous spotify-sourced liked set each run.
 */
export async function importSpotifyLiked(
  handle: DbHandle,
  connector: ServiceConnector,
  onProgress: (p: SpotifyLikedProgress) => void = () => {},
): Promise<SpotifyLikedResult> {
  if (!connector.getLikedTracks) throw new Error('Connector does not expose liked tracks.');

  const findTrack = handle.sqlite.prepare(
    `SELECT t.id FROM tracks t JOIN artists a ON a.id = t.artist_id
     WHERE a.name_normalized = ? AND t.name_normalized = ?`,
  );
  const insertLiked = handle.sqlite.prepare(
    "INSERT OR IGNORE INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'spotify', ?)",
  );

  handle.sqlite.prepare("DELETE FROM liked_tracks WHERE source = 'spotify'").run();

  let seen = 0;
  let linked = 0;
  for await (const { track, likedAt } of connector.getLikedTracks()) {
    seen++;
    const row = findTrack.get(normalizeName(track.artistName), normalizeName(track.name)) as
      | { id: number }
      | undefined;
    if (row) {
      insertLiked.run(row.id, likedAt ?? null);
      linked++;
    }
    if (seen % 50 === 0) onProgress({ kind: 'spotify-liked', seen, linked });
  }
  onProgress({ kind: 'spotify-liked', seen, linked });
  return { seen, linked };
}
