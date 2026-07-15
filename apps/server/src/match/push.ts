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
  for (const t of tracks) {
    const result = await matcher.match(t.trackId);
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
  if (matchedIds.length > 0) {
    await connector.setPlaylistTracks(playlistId, matchedIds);
  }

  // Log the push and its tracks for later "exclude recently playlisted" filters.
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

  return {
    playlistId,
    playlistUrl: connector.deepLinkPlaylist(playlistId),
    service,
    matchedCount: matchedIds.length,
    unmatched,
    lowConfidence,
  };
}
