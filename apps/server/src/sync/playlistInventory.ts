import type { DbHandle } from '@bftp/db';
import { normalizeName, type ServiceConnector, type ServiceName } from '@bftp/core';

export interface PlaylistInventoryProgress {
  kind: 'playlist-inventory';
  service: ServiceName;
  playlistsDone: number;
  playlistsTotal: number;
}

export interface PlaylistInventoryResult {
  playlists: number;
  tracks: number;
  matchedTracks: number;
}

/**
 * Pulls a service's actual playlists (and their tracks) into service_playlists /
 * service_playlist_tracks, matching each remote track back to a library track_id
 * where possible -- so the Curator's exclusion logic can see playlists that
 * exist on the service but weren't created by this app (playlist_log only
 * covers app-initiated pushes).
 *
 * Matching precedence: (1) a cached service_links reverse lookup, (2) exact
 * ISRC, (3) normalized artist+title. Replaces this service's rows each run.
 */
export async function syncPlaylistInventory(
  handle: DbHandle,
  connector: ServiceConnector,
  service: ServiceName,
  onProgress: (p: PlaylistInventoryProgress) => void = () => {},
): Promise<PlaylistInventoryResult> {
  if (!connector.listPlaylists || !connector.getPlaylistItems) {
    throw new Error(`Connector for ${service} does not support playlist listing.`);
  }

  const findByServiceLink = handle.sqlite.prepare(
    `SELECT entity_id AS trackId FROM service_links
     WHERE entity_type = 'track' AND service = ? AND service_id = ?`,
  );
  const findByIsrc = handle.sqlite.prepare('SELECT id FROM tracks WHERE isrc = ?');
  const findByName = handle.sqlite.prepare(
    `SELECT t.id FROM tracks t JOIN artists a ON a.id = t.artist_id
     WHERE a.name_normalized = ? AND t.name_normalized = ?`,
  );

  const matchTrackId = (item: { serviceTrackId: string; name?: string; artistName?: string; isrc?: string }): number | null => {
    const byLink = findByServiceLink.get(service, item.serviceTrackId) as { trackId: number } | undefined;
    if (byLink) return byLink.trackId;
    if (item.isrc) {
      const byIsrc = findByIsrc.get(item.isrc) as { id: number } | undefined;
      if (byIsrc) return byIsrc.id;
    }
    if (item.name && item.artistName) {
      const byName = findByName.get(normalizeName(item.artistName), normalizeName(item.name)) as
        | { id: number }
        | undefined;
      if (byName) return byName.id;
    }
    return null;
  };

  const upsertPlaylist = handle.sqlite.prepare(
    `INSERT INTO service_playlists (service, service_playlist_id, name, is_own, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(service, service_playlist_id) DO UPDATE SET
       name = excluded.name, is_own = excluded.is_own, fetched_at = excluded.fetched_at`,
  );
  const getPlaylistRowId = handle.sqlite.prepare(
    'SELECT id FROM service_playlists WHERE service = ? AND service_playlist_id = ?',
  );
  const deleteItems = handle.sqlite.prepare('DELETE FROM service_playlist_tracks WHERE playlist_id = ?');
  const insertItem = handle.sqlite.prepare(
    `INSERT OR IGNORE INTO service_playlist_tracks (playlist_id, service_track_id, track_id, raw_name, raw_artist)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const playlists = await connector.listPlaylists();
  let totalTracks = 0;
  let matchedTracks = 0;
  let playlistsDone = 0;
  onProgress({ kind: 'playlist-inventory', service, playlistsDone, playlistsTotal: playlists.length });

  for (const playlist of playlists) {
    const items = await connector.getPlaylistItems(playlist.serviceId);
    const now = Math.floor(Date.now() / 1000);
    upsertPlaylist.run(service, playlist.serviceId, playlist.name, playlist.isOwn ? 1 : 0, now);
    const row = getPlaylistRowId.get(service, playlist.serviceId) as { id: number };

    const applyItems = handle.sqlite.transaction(() => {
      deleteItems.run(row.id);
      for (const item of items) {
        const trackId = matchTrackId(item);
        insertItem.run(row.id, item.serviceTrackId, trackId, item.name ?? null, item.artistName ?? null);
        totalTracks++;
        if (trackId) matchedTracks++;
      }
    });
    applyItems();

    playlistsDone++;
    onProgress({ kind: 'playlist-inventory', service, playlistsDone, playlistsTotal: playlists.length });
  }

  return { playlists: playlists.length, tracks: totalTracks, matchedTracks };
}
