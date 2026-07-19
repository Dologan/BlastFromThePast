import type { DbHandle } from '@bftp/db';
import type { Recipe, ServiceConnector, ServiceName } from '@bftp/core';
import type { RecipeService } from '../recipes/recipeService.js';
import { expandAlbumTracks } from '../match/albumTracks.js';
import { findExistingPlaylist, pushPlaylist, type PushResult, type PushTrack } from '../match/push.js';
import { Classifier, type GroupBy } from './classify.js';

const CLASSIFY_UNIVERSE_LIMIT = 10000;
const OTHER_KEY = '__other__';
const UNCLASSIFIED_KEY = '__unclassified__';
const DEFAULT_MIN_GROUP_SIZE = 5;
const DEFAULT_NAME_PREFIX = 'Loved: ';

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export interface CuratePreviewOptions {
  base: Recipe;
  groupBy: GroupBy;
  excludePlaylistedOn?: ServiceName[];
  minGroupSize?: number;
  namePrefix?: string;
}

export interface CurateGroup {
  key: string;
  name: string;
  count: number;
  entityIds: number[];
  sample: string[];
}

export interface CuratePreviewResult {
  totalMatched: number;
  excluded: number;
  groups: CurateGroup[];
}

export interface CuratePushPlaylistRequest {
  name: string;
  trackIds: number[];
}

export interface CuratePushProgress {
  kind: 'curate';
  playlistsDone: number;
  playlistsTotal: number;
  currentName: string;
  matched: number;
  processed: number;
  total: number;
}

export type CuratePushOutcome = (PushResult & { skipped?: undefined }) | { skipped: true; name: string };

/**
 * Bulk-organises loved/liked tracks and albums into playlists by genre family,
 * and bulk-pushes the resulting groups. Built entirely on existing machinery:
 * the Recipe compiler for base criteria, GenreResolver-backed Classifier for
 * grouping, and pushPlaylist looped per group for creation.
 */
export class CurateService {
  constructor(private readonly handle: DbHandle) {}

  private artistIdsFor(mode: 'tracks' | 'albums', ids: number[]): Map<number, number> {
    if (ids.length === 0) return new Map();
    const table = mode === 'tracks' ? 'tracks' : 'albums';
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.handle.sqlite
      .prepare(`SELECT id, artist_id AS artistId FROM ${table} WHERE id IN (${placeholders})`)
      .all(...ids) as { id: number; artistId: number }[];
    return new Map(rows.map((r) => [r.id, r.artistId]));
  }

  /** Track ids already logged as pushed by this app, or present in the chosen
   * services' synced playlist inventory. */
  private excludedTrackIds(services: ServiceName[]): Set<number> {
    const set = new Set<number>();
    const logged = this.handle.sqlite.prepare('SELECT DISTINCT track_id AS trackId FROM playlist_log_tracks').all() as {
      trackId: number;
    }[];
    for (const row of logged) set.add(row.trackId);

    if (services.length > 0) {
      const placeholders = services.map(() => '?').join(',');
      const rows = this.handle.sqlite
        .prepare(
          `SELECT DISTINCT spt.track_id AS trackId FROM service_playlist_tracks spt
           JOIN service_playlists sp ON sp.id = spt.playlist_id
           WHERE spt.track_id IS NOT NULL AND sp.service IN (${placeholders})`,
        )
        .all(...services) as { trackId: number }[];
      for (const row of rows) set.add(row.trackId);
    }
    return set;
  }

  preview(recipes: RecipeService, opts: CuratePreviewOptions): CuratePreviewResult {
    const minGroupSize = opts.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE;
    const namePrefix = opts.namePrefix ?? DEFAULT_NAME_PREFIX;
    const base: Recipe = { ...opts.base, output: { ...opts.base.output, limit: CLASSIFY_UNIVERSE_LIMIT } };
    const mode = base.output.mode;

    const previewResult = recipes.preview(base);
    const artistIds = this.artistIdsFor(mode, previewResult.rows.map((r) => r.entityId));
    const excluded = this.excludedTrackIds(opts.excludePlaylistedOn ?? []);
    const classifier = new Classifier(this.handle.sqlite);

    // Grouping always operates at track granularity -- in albums mode each
    // matched album's tracks are expanded here, so `entityIds` on the
    // returned groups are always library track ids, directly usable by
    // curate/push (which creates track playlists either way). `count`
    // therefore reflects the number of tracks the resulting playlist would
    // have, not the number of albums matched (that's `totalMatched`/`excluded`).
    interface GroupTrack {
      entityId: number;
      name: string;
      artistName: string;
    }
    const groupRows = new Map<string, { name: string; rows: GroupTrack[] }>();
    let excludedCount = 0;

    for (const row of previewResult.rows) {
      const albumTracks = mode === 'albums' ? expandAlbumTracks(this.handle, row.entityId) : null;
      const trackIds = mode === 'tracks' ? [row.entityId] : (albumTracks ?? []).map((t) => t.trackId);
      if (trackIds.length === 0 || trackIds.some((id) => excluded.has(id))) {
        excludedCount++;
        continue;
      }
      const artistId = artistIds.get(row.entityId) ?? null;
      const genre = artistId != null ? classifier.classify(artistId, opts.groupBy) : null;
      const key = genre ?? UNCLASSIFIED_KEY;
      const name = genre ? capitalize(genre) : 'Unclassified';
      const group = groupRows.get(key) ?? { name, rows: [] as GroupTrack[] };
      if (mode === 'tracks') {
        group.rows.push({ entityId: row.entityId, name: row.name, artistName: row.artistName });
      } else {
        for (const t of albumTracks!) group.rows.push({ entityId: t.trackId, name: t.name, artistName: t.artistName });
      }
      groupRows.set(key, group);
    }

    // Fold small named-genre groups into "Other"; Unclassified is its own
    // catch-all and stays separate regardless of size.
    const finalGroups = new Map<string, { name: string; rows: GroupTrack[] }>();
    for (const [key, g] of groupRows) {
      if (key === UNCLASSIFIED_KEY) {
        finalGroups.set(key, g);
        continue;
      }
      if (g.rows.length < minGroupSize) {
        const other = finalGroups.get(OTHER_KEY) ?? { name: 'Other', rows: [] };
        other.rows.push(...g.rows);
        finalGroups.set(OTHER_KEY, other);
      } else {
        finalGroups.set(key, g);
      }
    }

    const namedKeys = [...finalGroups.keys()].filter((k) => k !== OTHER_KEY && k !== UNCLASSIFIED_KEY).sort();
    const orderedKeys = [
      ...namedKeys,
      ...(finalGroups.has(OTHER_KEY) ? [OTHER_KEY] : []),
      ...(finalGroups.has(UNCLASSIFIED_KEY) ? [UNCLASSIFIED_KEY] : []),
    ];

    const groups: CurateGroup[] = orderedKeys.map((key) => {
      const g = finalGroups.get(key)!;
      return {
        key,
        name: `${namePrefix}${g.name}`,
        count: g.rows.length,
        entityIds: g.rows.map((r) => r.entityId),
        sample: g.rows.slice(0, 10).map((r) => `${r.name} — ${r.artistName}`),
      };
    });

    return { totalMatched: previewResult.matched, excluded: excludedCount, groups };
  }

  private trackInfoFor(trackIds: number[]): PushTrack[] {
    if (trackIds.length === 0) return [];
    const placeholders = trackIds.map(() => '?').join(',');
    const rows = this.handle.sqlite
      .prepare(
        `SELECT t.id AS trackId, t.name AS name, a.name AS artistName
         FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.id IN (${placeholders})`,
      )
      .all(...trackIds) as PushTrack[];
    // Preserve the caller's requested order rather than the SQL IN()'s arbitrary one.
    const byId = new Map(rows.map((r) => [r.trackId, r]));
    return trackIds.map((id) => byId.get(id)).filter((t): t is PushTrack => Boolean(t));
  }

  /** Pushes each group as its own playlist, in order, within one job. */
  async push(
    connector: ServiceConnector,
    service: ServiceName,
    onExisting: 'skip' | 'replace' | 'append',
    playlists: CuratePushPlaylistRequest[],
    onProgress: (p: CuratePushProgress) => void = () => {},
  ): Promise<CuratePushOutcome[]> {
    const results: CuratePushOutcome[] = [];
    let playlistsDone = 0;
    const playlistsTotal = playlists.length;

    for (const pl of playlists) {
      const existing = findExistingPlaylist(this.handle, service, pl.name);

      if (existing && onExisting === 'skip') {
        results.push({ skipped: true, name: pl.name });
        playlistsDone++;
        onProgress({ kind: 'curate', playlistsDone, playlistsTotal, currentName: pl.name, matched: 0, processed: 0, total: 0 });
        continue;
      }

      const tracks = this.trackInfoFor(pl.trackIds);
      const result = await pushPlaylist(
        this.handle,
        connector,
        service,
        pl.name,
        'Created by Blast From The Past — Curator',
        tracks,
        (p) =>
          onProgress({
            kind: 'curate',
            playlistsDone,
            playlistsTotal,
            currentName: pl.name,
            matched: p.matched,
            processed: p.processed,
            total: p.total,
          }),
        existing ? { mode: onExisting as 'replace' | 'append', existingPlaylistId: existing.playlistId } : { mode: 'new' },
      );
      results.push(result);
      playlistsDone++;
      onProgress({
        kind: 'curate',
        playlistsDone,
        playlistsTotal,
        currentName: pl.name,
        matched: result.matchedCount,
        processed: tracks.length,
        total: tracks.length,
      });
    }

    return results;
  }
}
