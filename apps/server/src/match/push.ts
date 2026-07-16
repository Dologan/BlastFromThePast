import type { DbHandle } from '@bftp/db';
import type { ServiceConnector, ServiceName } from '@bftp/core';
import { ServiceMatcher } from './matcher.js';

export interface PushTrack {
  trackId: number;
  name: string;
  artistName: string;
}

export interface PushProgress {
  kind: 'push';
  matched: number;
  processed: number;
  total: number;
}

export interface UnmatchedTrack {
  trackId: number;
  name: string;
  artistName: string;
}

export interface PushResult {
  playlistId: string;
  playlistUrl: string;
  service: ServiceName;
  matchedCount: number;
  unmatched: UnmatchedTrack[];
  /** Matches below this confidence — worth a human glance in a fix-up view. */
  lowConfidence: UnmatchedTrack[];
  /** Set if matched tracks couldn't be searched/looked up (search API errors), rather than simply not found. */
  matchError?: string;
  /** Set if the playlist was created but adding the matched tracks to it failed. */
  itemsError?: string;
}

const LOW_CONFIDENCE = 0.6;

/**
 * Matches a list of library tracks to a service, creates a playlist, adds the
 * matched tracks, and records the push in playlist_log (so recipes can later
 * exclude recently-playlisted tracks). Unmatched and low-confidence tracks are
 * reported back rather than silently dropped.
 */
export async function pushPlaylist(
  handle: DbHandle,
  connector: ServiceConnector,
  service: ServiceName,
  name: string,
  description: string,
  tracks: PushTrack[],
  onProgress: (p: PushProgress) => void = () => {},
): Promise<PushResult> {
  const matcher = new ServiceMatcher(handle, connector, service);
  const matchedIds: string[] = [];
  const matchedTrackIds: number[] = [];
  const unmatched: UnmatchedTrack[] = [];
  const lowConfidence: UnmatchedTrack[] = [];

  let processed = 0;
  let matchError: string | undefined;
  for (const t of tracks) {
    let result: Awaited<ReturnType<typeof matcher.match>> = null;
    try {
      result = await matcher.match(t.trackId);
    } catch (err) {
      // A single search failure (e.g. a transient service error) shouldn't
      // abort the whole push — record it, treat the track as unmatched, and
      // keep going so the rest of the playlist still gets built.
      matchError = err instanceof Error ? err.message : String(err);
    }
    if (result) {
      matchedIds.push(result.serviceId);
      matchedTrackIds.push(t.trackId);
      if (result.confidence < LOW_CONFIDENCE) {
        lowConfidence.push({ trackId: t.trackId, name: t.name, artistName: t.artistName });
      }
    } else {
      unmatched.push({ trackId: t.trackId, name: t.name, artistName: t.artistName });
    }
    processed++;
    onProgress({ kind: 'push', matched: matchedIds.length, processed, total: tracks.length });
  }

  const playlistId = await connector.createPlaylist(name, description);
  let itemsError: string | undefined;
  if (matchedIds.length > 0) {
    try {
      await connector.setPlaylistTracks(playlistId, matchedIds);
    } catch (err) {
      // The playlist exists but adding tracks failed — surface this instead
      // of leaving the caller with an empty, unexplained playlist.
      itemsError = err instanceof Error ? err.message : String(err);
    }
  }

  // Log the push and its tracks for later "exclude recently playlisted"
  // filters — but only tracks that were actually added to the real playlist.
  if (!itemsError && matchedTrackIds.length > 0) {
    const logId = Number(
      handle.sqlite
        .prepare('INSERT INTO playlist_log (service, service_playlist_id, name, created_at) VALUES (?, ?, ?, ?)')
        .run(service, playlistId, name, Math.floor(Date.now() / 1000)).lastInsertRowid,
    );
    const logTrack = handle.sqlite.prepare(
      'INSERT OR IGNORE INTO playlist_log_tracks (playlist_log_id, track_id) VALUES (?, ?)',
    );
    const logAll = handle.sqlite.transaction(() => {
      for (const trackId of matchedTrackIds) logTrack.run(logId, trackId);
    });
    logAll();
  }

  return {
    playlistId,
    playlistUrl: connector.deepLinkPlaylist(playlistId),
    service,
    matchedCount: itemsError ? 0 : matchedIds.length,
    unmatched,
    lowConfidence,
    ...(matchError ? { matchError } : {}),
    ...(itemsError ? { itemsError } : {}),
  };
}
