import type { DbHandle } from '@bftp/db';
import type { ServiceConnector, ServiceName } from '@bftp/core';
import { ServiceMatcher } from '../match/matcher.js';

export type LikedSourceName = 'lastfm' | 'spotify' | 'tidal';

export interface UnlikePreviewOptions {
  /** Only tracks already present in a playlist. 'any' = any service; an array scopes to those services. */
  inPlaylistOn?: ServiceName[] | 'any';
  maxPlaycount?: number;
  notPlayedInDays?: number;
  source?: LikedSourceName;
}

export interface UnlikePreviewRow {
  trackId: number;
  name: string;
  artistName: string;
  sources: LikedSourceName[];
  playcount: number;
  lastListen: number;
  protected: boolean;
  playlistNames: string[];
}

export interface UnlikeProgress {
  kind: 'unlike';
  processed: number;
  total: number;
}

export interface UnlikeExecuteResult {
  unliked: number;
  spotifyRemoved: number;
  tidalRemoved: number;
  localOnlyRemoved: number;
  skipped: { trackId: number; reason: string }[];
}

/** Bulk "unliking" of loved/liked tracks that are already safely stored in a
 * playlist -- with a per-track protect flag enforced server-side regardless
 * of what the caller sends, so a "revisit later" like can be cleaned up in
 * bulk without risking a genuine favourite. */
export class UnlikeService {
  constructor(private readonly handle: DbHandle) {}

  preview(opts: UnlikePreviewOptions): UnlikePreviewRow[] {
    const now = Math.floor(Date.now() / 1000);
    const params: unknown[] = [];
    let where = '1=1';
    if (opts.source) {
      where += ' AND EXISTS (SELECT 1 FROM liked_tracks lt2 WHERE lt2.track_id = lt.track_id AND lt2.source = ?)';
      params.push(opts.source);
    }

    const rows = this.handle.sqlite
      .prepare(
        `SELECT lt.track_id AS trackId, t.name AS name, a.name AS artistName,
                GROUP_CONCAT(DISTINCT lt.source) AS sources, MAX(lt.protected) AS protectedFlag,
                ts.playcount AS playcount, ts.last_listen AS lastListen
         FROM liked_tracks lt
         JOIN tracks t ON t.id = lt.track_id
         JOIN artists a ON a.id = t.artist_id
         JOIN track_stats ts ON ts.track_id = lt.track_id
         WHERE ${where}
         GROUP BY lt.track_id`,
      )
      .all(...params) as {
      trackId: number;
      name: string;
      artistName: string;
      sources: string;
      protectedFlag: number;
      playcount: number;
      lastListen: number;
    }[];

    const filtered = rows.filter((r) => {
      if (opts.maxPlaycount !== undefined && r.playcount > opts.maxPlaycount) return false;
      if (opts.notPlayedInDays !== undefined && r.lastListen > now - opts.notPlayedInDays * 86400) return false;
      return true;
    });

    const trackIds = filtered.map((r) => r.trackId);
    const playlistNamesByTrack = this.playlistNamesFor(trackIds, opts.inPlaylistOn);

    let out: UnlikePreviewRow[] = filtered.map((r) => ({
      trackId: r.trackId,
      name: r.name,
      artistName: r.artistName,
      sources: r.sources.split(',') as LikedSourceName[],
      playcount: r.playcount,
      lastListen: r.lastListen,
      protected: Boolean(r.protectedFlag),
      playlistNames: playlistNamesByTrack.get(r.trackId) ?? [],
    }));

    if (opts.inPlaylistOn) out = out.filter((r) => r.playlistNames.length > 0);
    return out;
  }

  private playlistNamesFor(trackIds: number[], scope?: ServiceName[] | 'any'): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (trackIds.length === 0) return map;
    const idPlaceholders = trackIds.map(() => '?').join(',');
    const serviceScope = Array.isArray(scope) ? scope : null;

    const addRows = (rows: { trackId: number; name: string }[]) => {
      for (const r of rows) {
        const list = map.get(r.trackId) ?? [];
        if (!list.includes(r.name)) list.push(r.name);
        map.set(r.trackId, list);
      }
    };

    let logSql = `SELECT plt.track_id AS trackId, pl.name AS name FROM playlist_log_tracks plt
      JOIN playlist_log pl ON pl.id = plt.playlist_log_id WHERE plt.track_id IN (${idPlaceholders})`;
    const logParams: unknown[] = [...trackIds];
    if (serviceScope && serviceScope.length > 0) {
      logSql += ` AND pl.service IN (${serviceScope.map(() => '?').join(',')})`;
      logParams.push(...serviceScope);
    }
    addRows(this.handle.sqlite.prepare(logSql).all(...logParams) as { trackId: number; name: string }[]);

    let invSql = `SELECT spt.track_id AS trackId, sp.name AS name FROM service_playlist_tracks spt
      JOIN service_playlists sp ON sp.id = spt.playlist_id WHERE spt.track_id IN (${idPlaceholders})`;
    const invParams: unknown[] = [...trackIds];
    if (serviceScope && serviceScope.length > 0) {
      invSql += ` AND sp.service IN (${serviceScope.map(() => '?').join(',')})`;
      invParams.push(...serviceScope);
    }
    addRows(this.handle.sqlite.prepare(invSql).all(...invParams) as { trackId: number; name: string }[]);

    return map;
  }

  /** Sets/clears the protect flag on every liked_tracks row (all sources) for a track. */
  protectTrack(trackId: number, isProtected: boolean): void {
    this.handle.sqlite.prepare('UPDATE liked_tracks SET protected = ? WHERE track_id = ?').run(isProtected ? 1 : 0, trackId);
  }

  /**
   * Unlikes the given tracks. Protection is re-checked here regardless of
   * what the caller sent -- a protected track is never removed, even in
   * `localOnly` mode. When not `localOnly`, Spotify/TIDAL-sourced likes are
   * removed via the connector's `removeLikedTracks` (service id resolved from
   * the cached `service_links` match, falling back to a fresh search);
   * Last.fm-only likes have no write path yet and are skipped with a reason.
   * The local `liked_tracks` row is deleted once a track has been handled
   * (remotely, or unconditionally under `localOnly`).
   */
  async execute(
    trackIds: number[],
    localOnly: boolean,
    connectors: Partial<Record<'spotify' | 'tidal', ServiceConnector>>,
    onProgress: (p: UnlikeProgress) => void = () => {},
  ): Promise<UnlikeExecuteResult> {
    if (trackIds.length === 0) return { unliked: 0, spotifyRemoved: 0, tidalRemoved: 0, localOnlyRemoved: 0, skipped: [] };

    const placeholders = trackIds.map(() => '?').join(',');
    const rows = this.handle.sqlite
      .prepare(`SELECT track_id AS trackId, source, protected FROM liked_tracks WHERE track_id IN (${placeholders})`)
      .all(...trackIds) as { trackId: number; source: string; protected: number }[];

    const bySources = new Map<number, Set<string>>();
    const protectedTracks = new Set<number>();
    for (const r of rows) {
      if (r.protected) protectedTracks.add(r.trackId);
      const set = bySources.get(r.trackId) ?? new Set<string>();
      set.add(r.source);
      bySources.set(r.trackId, set);
    }

    const skipped: { trackId: number; reason: string }[] = [];
    const toRemoveLocally = new Set<number>();
    const spotifyTargets: { trackId: number; serviceId: string }[] = [];
    const tidalTargets: { trackId: number; serviceId: string }[] = [];

    let processed = 0;
    const total = trackIds.length;
    for (const trackId of trackIds) {
      processed++;
      onProgress({ kind: 'unlike', processed, total });

      const sources = bySources.get(trackId);
      if (!sources) {
        skipped.push({ trackId, reason: 'not currently liked' });
        continue;
      }
      if (protectedTracks.has(trackId)) {
        skipped.push({ trackId, reason: 'protected' });
        continue;
      }
      if (localOnly) {
        toRemoveLocally.add(trackId);
        continue;
      }

      let handledRemotely = false;
      if (sources.has('spotify') && connectors.spotify?.removeLikedTracks) {
        const serviceId = await new ServiceMatcher(this.handle, connectors.spotify, 'spotify').match(trackId).then((m) => m?.serviceId ?? null);
        if (serviceId) {
          spotifyTargets.push({ trackId, serviceId });
          handledRemotely = true;
        }
      }
      if (sources.has('tidal') && connectors.tidal?.removeLikedTracks) {
        const serviceId = await new ServiceMatcher(this.handle, connectors.tidal, 'tidal').match(trackId).then((m) => m?.serviceId ?? null);
        if (serviceId) {
          tidalTargets.push({ trackId, serviceId });
          handledRemotely = true;
        }
      }
      if (handledRemotely) {
        toRemoveLocally.add(trackId);
      } else if (sources.has('lastfm')) {
        skipped.push({ trackId, reason: 'Last.fm write auth is not implemented yet -- unlike locally instead, or unlove it on last.fm directly' });
      } else {
        skipped.push({ trackId, reason: 'no connected service can remove this like' });
      }
    }

    let spotifyRemoved = 0;
    let tidalRemoved = 0;
    if (spotifyTargets.length > 0 && connectors.spotify?.removeLikedTracks) {
      await connectors.spotify.removeLikedTracks(spotifyTargets.map((t) => t.serviceId));
      spotifyRemoved = spotifyTargets.length;
    }
    if (tidalTargets.length > 0 && connectors.tidal?.removeLikedTracks) {
      await connectors.tidal.removeLikedTracks(tidalTargets.map((t) => t.serviceId));
      tidalRemoved = tidalTargets.length;
    }

    const del = this.handle.sqlite.prepare('DELETE FROM liked_tracks WHERE track_id = ?');
    const delAll = this.handle.sqlite.transaction(() => {
      for (const id of toRemoveLocally) del.run(id);
    });
    delAll();

    return {
      unliked: toRemoveLocally.size,
      spotifyRemoved,
      tidalRemoved,
      localOnlyRemoved: localOnly ? toRemoveLocally.size : 0,
      skipped,
    };
  }
}
