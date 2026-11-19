import type { DbHandle } from '@bftp/db';
import {
  isGenreDim,
  isTimeDim,
  likedAtSql,
  renderTemplate,
  timeValues,
  type OrganisePlan,
  type Recipe,
  type ServiceConnector,
  type ServiceName,
  type TemplateValues,
} from '@bftp/core';
import type { RecipeService } from '../recipes/recipeService.js';
import { expandAlbumTracks } from '../match/albumTracks.js';
import { findExistingPlaylist, pushPlaylist, type PushResult, type PushTrack } from '../match/push.js';
import { Classifier, type GroupBy } from './classify.js';

const CLASSIFY_UNIVERSE_LIMIT = 10000;
const OTHER_KEY = '__other__';
const UNCLASSIFIED_KEY = '__unclassified__';
const UNDATED_KEY = '__undated__';
const DEFAULT_MIN_GROUP_SIZE = 5;
const DEFAULT_NAME_PREFIX = 'Loved: ';
const SQL_ID_BATCH = 5000;
/** Joins a folder onto a playlist name on services without a folders API. */
const FOLDER_PREFIX_SEPARATOR = ' · ';

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

export interface OrganisePlaylist {
  /** Group identity: the grouped dimensions' values joined by '|', e.g. '2025-03|metal'. */
  key: string;
  name: string;
  folder: string | null;
  count: number;
  trackIds: number[];
  sample: string[];
  /** Set when previewing for a service: the name it will get there, which carries the
   * folder on services without folders (e.g. '2024 · March Metal'). */
  pushName?: string;
  /** Set when previewing for a service: this app already pushed this playlist there. */
  existing?: boolean;
}

export interface OrganiseFolder {
  /** null: playlists that aren't filed in a folder. */
  name: string | null;
  playlists: OrganisePlaylist[];
}

export interface OrganisePreviewResult {
  totalMatched: number;
  excluded: number;
  trackCount: number;
  playlistCount: number;
  /** Tracks dated by their first play because none of their likes has a date (likedMonth/likedYear only). */
  likeDateFallback: number;
  folders: OrganiseFolder[];
}

export interface CuratePushPlaylistRequest {
  name: string;
  trackIds: number[];
  /** Folder to file the playlist in; on services without folders it prefixes the name. */
  folder?: string | null;
}

export interface CuratePushProgress {
  kind: 'curate';
  playlistsDone: number;
  playlistsTotal: number;
  currentName: string;
  currentFolder?: string | null;
  matched: number;
  processed: number;
  total: number;
}

export type CuratePushOutcome =
  | (PushResult & { skipped?: undefined; name: string; folder?: string | null; folderError?: string })
  | { skipped: true; name: string; folder?: string | null };

interface GroupTrack {
  trackId: number;
  name: string;
  artistName: string;
}

/**
 * Bulk-organises tracks into playlists -- by genre, by when they were liked or
 * first played, or both, optionally filed in folders -- and bulk-pushes the
 * resulting groups. Built entirely on existing machinery: the Recipe compiler
 * for base criteria, GenreResolver-backed Classifier for genres, and
 * pushPlaylist looped per group for creation.
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

  /** Track ids present in the chosen services' synced playlist inventory and,
   * with `includeLogged`, any already pushed by this app. */
  private excludedTrackIds(services: ServiceName[], includeLogged: boolean): Set<number> {
    const set = new Set<number>();
    if (includeLogged) {
      const logged = this.handle.sqlite.prepare('SELECT DISTINCT track_id AS trackId FROM playlist_log_tracks').all() as {
        trackId: number;
      }[];
      for (const row of logged) set.add(row.trackId);
    }

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

  /**
   * When each track was liked: its latest like on any service, an undated like
   * counting as the track's first play (likedAtSql, as the likedInDays filter
   * uses -- so a track that passes `likedInDays: N` is always dated within N
   * days). `fallback` marks tracks none of whose likes has a date.
   */
  private likeDates(trackIds: number[]): Map<number, { at: number | null; fallback: boolean }> {
    const out = new Map<number, { at: number | null; fallback: boolean }>();
    for (const batch of chunk(trackIds, SQL_ID_BATCH)) {
      const rows = this.handle.sqlite
        .prepare(
          `SELECT lt.track_id AS trackId, MAX(${likedAtSql('lt', 'ts')}) AS at, MAX(lt.liked_at) IS NULL AS fallback
           FROM liked_tracks lt LEFT JOIN track_stats ts ON ts.track_id = lt.track_id
           WHERE lt.track_id IN (${batch.map(() => '?').join(',')}) GROUP BY lt.track_id`,
        )
        .all(...batch) as { trackId: number; at: number | null; fallback: number }[];
      for (const r of rows) out.set(r.trackId, { at: r.at, fallback: r.fallback === 1 });
    }
    return out;
  }

  private firstListens(trackIds: number[]): Map<number, number | null> {
    const out = new Map<number, number | null>();
    for (const batch of chunk(trackIds, SQL_ID_BATCH)) {
      const rows = this.handle.sqlite
        .prepare(`SELECT track_id AS trackId, first_listen AS at FROM track_stats WHERE track_id IN (${batch.map(() => '?').join(',')})`)
        .all(...batch) as { trackId: number; at: number | null }[];
      for (const r of rows) out.set(r.trackId, r.at);
    }
    return out;
  }

  /**
   * Groups a plan's tracks into a folder -> playlist tree. Every matched track
   * lands in exactly one playlist. Genre groups smaller than minGroupSize --
   * "Unclassified" (artists without genre tags) included -- fold into "Other"
   * within their own time period. Pass `target` to get each playlist's name on
   * that service and flag the ones this app already pushed there.
   *
   * Tracks this app already pushed stay in: re-running a plan regroups
   * everything, so a 'replace' refreshes each playlist rather than emptying it
   * of the tracks it already had. `curatorRules` applies the one-off Curator's
   * rules instead: drop tracks this app already pushed, and keep Unclassified
   * as its own group at any size.
   */
  organise(
    recipes: RecipeService,
    plan: OrganisePlan,
    target?: { service: ServiceName; foldersSupported: boolean },
    { curatorRules = false }: { curatorRules?: boolean } = {},
  ): OrganisePreviewResult {
    const minGroupSize = plan.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE;
    const base: Recipe = { ...plan.base, output: { ...plan.base.output, limit: CLASSIFY_UNIVERSE_LIMIT } };
    const mode = base.output.mode;
    const timeDim = plan.groupBy.find(isTimeDim);
    const genreDim = plan.groupBy.find(isGenreDim);

    const previewResult = recipes.preview(base);
    const artistIds = this.artistIdsFor(mode, previewResult.rows.map((r) => r.entityId));
    const excluded = this.excludedTrackIds(plan.excludePlaylistedOn ?? [], curatorRules);
    const classifier = new Classifier(this.handle.sqlite);

    // Grouping always operates at track granularity -- in albums mode each
    // matched album's tracks are expanded here, so the playlists' trackIds are
    // always library track ids, directly usable by push.
    const tracks: (GroupTrack & { artistId: number | null })[] = [];
    let excludedCount = 0;
    for (const row of previewResult.rows) {
      const albumTracks = mode === 'albums' ? expandAlbumTracks(this.handle, row.entityId) : null;
      const rowTracks: GroupTrack[] =
        mode === 'tracks'
          ? [{ trackId: row.entityId, name: row.name, artistName: row.artistName }]
          : (albumTracks ?? []).map((t) => ({ trackId: t.trackId, name: t.name, artistName: t.artistName }));
      if (rowTracks.length === 0 || rowTracks.some((t) => excluded.has(t.trackId))) {
        excludedCount++;
        continue;
      }
      const artistId = artistIds.get(row.entityId) ?? null;
      for (const t of rowTracks) tracks.push({ ...t, artistId });
    }

    const trackIds = tracks.map((t) => t.trackId);
    const liked = timeDim?.startsWith('liked') ? this.likeDates(trackIds) : null;
    const firstListen = timeDim?.startsWith('firstListen') ? this.firstListens(trackIds) : null;
    let likeDateFallback = 0;

    interface Group {
      timeKey: string | null;
      genreKey: string | null;
      values: TemplateValues;
      rows: GroupTrack[];
    }
    const groupKey = (timeKey: string | null, genreKey: string | null) =>
      [timeKey, genreKey].filter((k) => k !== null).join('|');
    const groups = new Map<string, Group>();
    const add = (timeKey: string | null, genreKey: string | null, values: TemplateValues, rows: GroupTrack[]) => {
      const key = groupKey(timeKey, genreKey);
      const group = groups.get(key) ?? { timeKey, genreKey, values, rows: [] };
      group.rows.push(...rows);
      groups.set(key, group);
    };

    for (const t of tracks) {
      const values: TemplateValues = {};
      let timeKey: string | null = null;
      if (timeDim) {
        const likedInfo = liked?.get(t.trackId);
        if (likedInfo?.fallback) likeDateFallback++;
        const at = liked ? (likedInfo?.at ?? null) : (firstListen?.get(t.trackId) ?? null);
        if (at === null) {
          timeKey = UNDATED_KEY;
          values.year = 'Undated';
        } else {
          Object.assign(values, timeValues(at, timeDim));
          timeKey = values.month ? `${values.year}-${values.month}` : values.year!;
        }
      }
      let genreKey: string | null = null;
      if (genreDim) {
        const genre = t.artistId != null ? classifier.classify(t.artistId, genreDim) : null;
        genreKey = genre ?? UNCLASSIFIED_KEY;
        values.genre = genre ? capitalize(genre) : 'Unclassified';
      }
      add(timeKey, genreKey, values, [t]);
    }

    // Fold small genre groups into their period's "Other".
    if (genreDim) {
      for (const [key, g] of [...groups]) {
        if (g.genreKey === OTHER_KEY || g.rows.length >= minGroupSize) continue;
        if (curatorRules && g.genreKey === UNCLASSIFIED_KEY) continue;
        groups.delete(key);
        add(g.timeKey, OTHER_KEY, { ...g.values, genre: 'Other' }, g.rows);
      }
    }

    const genreRank = (k: string | null) => (k === OTHER_KEY ? 1 : k === UNCLASSIFIED_KEY ? 2 : 0);
    const ordered = [...groups.values()].sort((a, b) => {
      const ta = a.timeKey ?? '';
      const tb = b.timeKey ?? '';
      if (ta !== tb) return ta === UNDATED_KEY ? 1 : tb === UNDATED_KEY ? -1 : ta < tb ? -1 : 1;
      const ra = genreRank(a.genreKey);
      const rb = genreRank(b.genreKey);
      if (ra !== rb) return ra - rb;
      return (a.genreKey ?? '') < (b.genreKey ?? '') ? -1 : (a.genreKey ?? '') > (b.genreKey ?? '') ? 1 : 0;
    });

    // Render names; groups that render to the same folder + name share a playlist.
    const folders = new Map<string | null, Map<string, OrganisePlaylist>>();
    for (const g of ordered) {
      const folder = plan.folder ? renderTemplate(plan.folder, g.values) || null : null;
      const name = renderTemplate(plan.name ?? '{genre}', g.values) || 'Untitled';
      const playlists = folders.get(folder) ?? new Map<string, OrganisePlaylist>();
      const playlist = playlists.get(name) ?? {
        key: groupKey(g.timeKey, g.genreKey),
        name,
        folder,
        count: 0,
        trackIds: [],
        sample: [],
      };
      playlist.trackIds.push(...g.rows.map((r) => r.trackId));
      playlist.sample.push(...g.rows.slice(0, 10 - playlist.sample.length).map((r) => `${r.name} — ${r.artistName}`));
      playlist.count = playlist.trackIds.length;
      playlists.set(name, playlist);
      folders.set(folder, playlists);
    }

    const tree: OrganiseFolder[] = [...folders].map(([name, playlists]) => ({ name, playlists: [...playlists.values()] }));
    if (target) {
      for (const f of tree) {
        for (const p of f.playlists) {
          const dest = this.pushTarget(p.name, p.folder, target.foldersSupported);
          p.pushName = dest.name;
          p.existing = findExistingPlaylist(this.handle, target.service, dest.name, dest.folder) !== null;
        }
      }
    }
    return {
      totalMatched: previewResult.matched,
      excluded: excludedCount,
      trackCount: tracks.length,
      playlistCount: tree.reduce((n, f) => n + f.playlists.length, 0),
      likeDateFallback,
      folders: tree,
    };
  }

  /** The single-dimension Curator preview (genre groups named with a prefix), on top of organise(). */
  preview(recipes: RecipeService, opts: CuratePreviewOptions): CuratePreviewResult {
    const namePrefix = opts.namePrefix ?? DEFAULT_NAME_PREFIX;
    const result = this.organise(recipes, {
      base: opts.base,
      groupBy: [opts.groupBy],
      name: '{genre}',
      minGroupSize: opts.minGroupSize,
      excludePlaylistedOn: opts.excludePlaylistedOn,
    }, undefined, { curatorRules: true });
    // The prefix is added afterwards, so braces in it are never read as template variables.
    const groups = result.folders
      .flatMap((f) => f.playlists)
      .map((p) => ({ key: p.key, name: `${namePrefix}${p.name}`, count: p.count, entityIds: p.trackIds, sample: p.sample }));
    return { totalMatched: result.totalMatched, excluded: result.excluded, groups };
  }

  /**
   * Where a playlist actually goes: in its folder, or, on a service without
   * folders, with the folder prefixed to its name -- unless the name already
   * contains it ('2025-03 Metal' in folder '2025'), which keeps names unique
   * without repeating the year.
   */
  private pushTarget(name: string, folder: string | null | undefined, foldersSupported: boolean): { name: string; folder: string | null } {
    if (!folder) return { name, folder: null };
    if (foldersSupported) return { name, folder };
    return { name: name.includes(folder) ? name : `${folder}${FOLDER_PREFIX_SEPARATOR}${name}`, folder: null };
  }

  private trackInfoFor(trackIds: number[]): PushTrack[] {
    if (trackIds.length === 0) return [];
    const rows: PushTrack[] = [];
    for (const batch of chunk(trackIds, SQL_ID_BATCH)) {
      rows.push(
        ...(this.handle.sqlite
          .prepare(
            `SELECT t.id AS trackId, t.name AS name, a.name AS artistName
             FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.id IN (${batch.map(() => '?').join(',')})`,
          )
          .all(...batch) as PushTrack[]),
      );
    }
    // Preserve the caller's requested order rather than the SQL IN()'s arbitrary one.
    const byId = new Map(rows.map((r) => [r.trackId, r]));
    return trackIds.map((id) => byId.get(id)).filter((t): t is PushTrack => Boolean(t));
  }

  /**
   * Pushes each playlist, in order, within one job, filing it in its folder
   * where the service has folders. A playlist is (re-)filed whenever the push
   * gave it a new id -- a new playlist, or a TIDAL 'replace', which deletes and
   * recreates it. A failure to file is reported on that playlist's outcome
   * (`folderError`) and doesn't stop the rest: the playlist itself exists.
   */
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
    const foldersSupported = Boolean(connector.findOrCreateFolder && connector.addPlaylistsToFolder);
    const folderIds = new Map<string, string>();

    for (const pl of playlists) {
      const { name, folder } = this.pushTarget(pl.name, pl.folder, foldersSupported);
      const folderField = folder ? { folder } : {};
      const report = (matched: number, processed: number, total: number) =>
        onProgress({ kind: 'curate', playlistsDone, playlistsTotal, currentName: name, currentFolder: folder, matched, processed, total });
      const existing = findExistingPlaylist(this.handle, service, name, folder);

      if (existing && onExisting === 'skip') {
        results.push({ skipped: true, name, ...folderField });
        playlistsDone++;
        report(0, 0, 0);
        continue;
      }

      const tracks = this.trackInfoFor(pl.trackIds);
      const result = await pushPlaylist(
        this.handle,
        connector,
        service,
        name,
        'Created by Blast From The Past — Curator',
        tracks,
        (p) => report(p.matched, p.processed, p.total),
        {
          ...(existing ? { mode: onExisting as 'replace' | 'append', existingPlaylistId: existing.playlistId } : { mode: 'new' as const }),
          folder,
        },
      );

      let folderError: string | undefined;
      if (folder && result.playlistId !== existing?.playlistId) {
        try {
          let folderId = folderIds.get(folder);
          if (!folderId) {
            folderId = await connector.findOrCreateFolder!(folder);
            folderIds.set(folder, folderId);
          }
          await connector.addPlaylistsToFolder!(folderId, [result.playlistId]);
        } catch (err) {
          folderError = err instanceof Error ? err.message : String(err);
        }
      }
      results.push({ ...result, name, ...folderField, ...(folderError ? { folderError } : {}) });
      playlistsDone++;
      report(result.matchedCount, tracks.length, tracks.length);
    }

    return results;
  }
}
