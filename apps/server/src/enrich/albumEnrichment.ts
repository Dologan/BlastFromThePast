import type { DbHandle } from '@bftp/db';
import type { MusicBrainzClient } from './musicbrainz.js';
import { EnrichmentCache } from './cache.js';

export interface AlbumEnrichProgress {
  kind: 'enrich-albums';
  processed: number;
  total: number;
}

export interface AlbumEnrichResult {
  processed: number;
  withDate: number;
  failed: number;
}

export interface AlbumReprocessResult {
  processed: number;
  withDate: number;
}

// Matches the artist enrichment's MB_SCORE_THRESHOLD -- only trust a
// name-based release-group match at or above this score (0-100); cached
// per-search, so retuning is a free reprocessAll(), not a re-fetch.
const RELEASE_SCORE_THRESHOLD = 90;

interface AlbumRow {
  id: number;
  artistName: string;
  name: string;
  mbid: string | null;
}

interface Derived {
  /** False when this album has never been fetched (no cache row at all). */
  hadCacheData: boolean;
  mbid: string | null;
  releaseDate: string | null;
}

/**
 * Fills in album release dates from MusicBrainz release-groups. Mirrors
 * `Enrichment` (artists) in shape -- `run()` fetches (cache-aware, so
 * already-cached albums cost no network call) then derives; `reprocessAll()`
 * re-derives purely from the cache after a schema/parsing change, with zero
 * network calls -- but MusicBrainz is the only source here (Last.fm has no
 * release-date data), so there's a single sequential fetch lane rather than
 * two lanes run concurrently.
 */
export class AlbumEnrichment {
  private readonly cache: EnrichmentCache;

  constructor(
    private readonly handle: DbHandle,
    private readonly mb: MusicBrainzClient | null,
    private readonly onProgress: (p: AlbumEnrichProgress) => void = () => {},
  ) {
    this.cache = new EnrichmentCache(handle.sqlite);
  }

  private allAlbums(): AlbumRow[] {
    return this.handle.sqlite
      .prepare(
        `SELECT al.id AS id, a.name AS artistName, al.name AS name, al.mbid AS mbid
         FROM albums al JOIN artists a ON a.id = al.artist_id ORDER BY al.id`,
      )
      .all() as AlbumRow[];
  }

  private pendingAlbums(): AlbumRow[] {
    return this.handle.sqlite
      .prepare(
        `SELECT al.id AS id, a.name AS artistName, al.name AS name, al.mbid AS mbid
         FROM albums al JOIN artists a ON a.id = al.artist_id
         WHERE al.release_date_status IN ('pending', 'error') ORDER BY al.id`,
      )
      .all() as AlbumRow[];
  }

  /** Fetches (cache-aware) for pending/error albums, then derives release dates. */
  async run(): Promise<AlbumEnrichResult> {
    if (!this.mb) {
      throw new Error('run() requires a MusicBrainz client; use reprocessAll() for cache-only re-derivation');
    }
    const albums = this.pendingAlbums();
    const erroredIds = await this.fetchAll(albums, this.mb);

    let processed = 0;
    let withDate = 0;
    const apply = this.handle.sqlite.transaction(() => {
      for (const album of albums) {
        const derived = this.deriveOne(album);
        if (derived.releaseDate) withDate++;
        if (erroredIds.has(album.id)) {
          this.saveAsError(album.id, derived.releaseDate, derived.mbid);
        } else {
          this.saveAsDone(album.id, derived.releaseDate, derived.mbid);
        }
        processed++;
      }
    });
    apply();

    return { processed, withDate, failed: erroredIds.size };
  }

  /**
   * Re-derives release dates for every album purely from cached raw
   * responses -- no network calls, no status changes. Albums never fetched
   * (no cache row at all) are left untouched so a later `run()` still picks
   * them up.
   */
  reprocessAll(): AlbumReprocessResult {
    const albums = this.allAlbums();
    let processed = 0;
    let withDate = 0;
    const apply = this.handle.sqlite.transaction(() => {
      for (const album of albums) {
        const derived = this.deriveOne(album);
        if (!derived.hadCacheData) continue;
        this.updateDerivedData(album.id, derived.releaseDate, derived.mbid);
        if (derived.releaseDate) withDate++;
        processed++;
      }
    });
    apply();
    return { processed, withDate };
  }

  private async fetchAll(albums: AlbumRow[], mb: MusicBrainzClient): Promise<Set<number>> {
    const erroredIds = new Set<number>();
    let processed = 0;
    for (const album of albums) {
      try {
        await this.ensureReleaseCached(album, mb);
      } catch {
        // Transient failure (network / MB 5xx after retries): leave uncached
        // so the next run() retries just this album's fetch.
        erroredIds.add(album.id);
      }
      processed++;
      this.onProgress({ kind: 'enrich-albums', processed, total: albums.length });
    }
    return erroredIds;
  }

  private async ensureReleaseCached(album: AlbumRow, mb: MusicBrainzClient): Promise<void> {
    let mbid = album.mbid;
    if (!mbid) {
      if (!this.cache.hasReleaseSearch(album.artistName, album.name)) {
        const hit = await mb.searchReleaseGroup(album.artistName, album.name);
        this.cache.putReleaseSearch(album.artistName, album.name, hit);
      }
      const cached = this.cache.getReleaseSearch(album.artistName, album.name);
      if (cached && cached.score >= RELEASE_SCORE_THRESHOLD) mbid = cached.mbid;
    }
    if (mbid && !this.cache.hasReleaseGroup(mbid)) {
      const record = await mb.lookupReleaseGroup(mbid);
      this.cache.putReleaseGroup(mbid, record ? { releaseDate: record.firstReleaseDate } : null);
    }
  }

  private deriveOne(album: AlbumRow): Derived {
    let mbid = album.mbid;
    let releaseDate: string | null = null;
    let sawCache = false;

    if (!mbid) {
      const searchHit = this.cache.getReleaseSearch(album.artistName, album.name);
      if (searchHit !== undefined) {
        sawCache = true;
        if (searchHit && searchHit.score >= RELEASE_SCORE_THRESHOLD) mbid = searchHit.mbid;
      }
    }
    if (mbid) {
      const record = this.cache.getReleaseGroup(mbid);
      if (record !== undefined) {
        sawCache = true;
        if (record) releaseDate = record.releaseDate;
      }
    }

    return { hadCacheData: sawCache, mbid, releaseDate };
  }

  private saveAsDone(albumId: number, releaseDate: string | null, mbid: string | null): void {
    this.handle.sqlite
      .prepare(
        `UPDATE albums SET release_date = ?, mbid = COALESCE(?, mbid), release_date_status = 'done' WHERE id = ?`,
      )
      .run(releaseDate, mbid, albumId);
  }

  private saveAsError(albumId: number, releaseDate: string | null, mbid: string | null): void {
    // Preserve whatever partial data we did get while flagging for retry.
    this.handle.sqlite
      .prepare(`UPDATE albums SET release_date = ?, mbid = COALESCE(?, mbid), release_date_status = 'error' WHERE id = ?`)
      .run(releaseDate, mbid, albumId);
  }

  private updateDerivedData(albumId: number, releaseDate: string | null, mbid: string | null): void {
    this.handle.sqlite
      .prepare('UPDATE albums SET release_date = ?, mbid = COALESCE(?, mbid) WHERE id = ?')
      .run(releaseDate, mbid, albumId);
  }
}
