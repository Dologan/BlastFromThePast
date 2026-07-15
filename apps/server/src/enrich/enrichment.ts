import type { DbHandle } from '@bftp/db';
import type { LastfmClient, WeightedTag } from '../lastfm/client.js';
import type { MusicBrainzClient } from './musicbrainz.js';
import { EnrichmentCache } from './cache.js';

export type EnrichProgress =
  | {
      kind: 'enrich';
      phase: 'fetch';
      mbProcessed: number;
      mbTotal: number;
      lastfmProcessed: number;
      lastfmTotal: number;
    }
  | { kind: 'enrich'; phase: 'derive'; processed: number; total: number };

export interface EnrichResult {
  processed: number;
  withCountry: number;
  failed: number;
}

export interface ReprocessResult {
  processed: number;
  withCountry: number;
}

// Only trust a name-based MusicBrainz match at or above this score (0–100);
// below it we skip country/mbid but still take Last.fm tags by name. Cached
// per-search, so retuning this threshold is a free reprocessAll(), not a
// re-fetch.
const MB_SCORE_THRESHOLD = 90;

interface ArtistRow {
  id: number;
  name: string;
  mbid: string | null;
}

interface Derived {
  /** False when neither source has ever been fetched for this artist. */
  hadCacheData: boolean;
  country: string | null;
  mbid: string | null;
  genres: WeightedTag[];
  mbTags: WeightedTag[];
  lfmTags: WeightedTag[];
}

/**
 * Fills in country of origin and genre/folksonomy tags for artists, from
 * MusicBrainz (authoritative genres + country) and Last.fm (broad tags).
 *
 * Fetching and deriving are separate steps:
 *  - `run()` fetches (through EnrichmentCache, so already-cached artists cost
 *    no network call) for pending/error artists, then derives.
 *  - `reprocessAll()` re-derives the normalized artists/artist_tags rows for
 *    every artist purely from the cache, with zero network calls. Use it
 *    after changing how cached data maps onto the schema (e.g. genre_rules
 *    logic, the MB score threshold) instead of re-running the slow,
 *    rate-limited fetch.
 *
 * MusicBrainz and Last.fm are fetched via two independently-paced lanes
 * running concurrently (`Promise.all`) -- they're unrelated rate-limited
 * services, so overlapping them removes the faster lane's time from the
 * total instead of adding to it. Each lane stays strictly sequential
 * internally (one in-flight request at a time) so neither client's own rate
 * limiter -- which assumes a single caller -- is violated.
 */
export class Enrichment {
  private readonly cache: EnrichmentCache;
  private readonly tagCache = new Map<string, number>();
  private readonly selectTag;
  private readonly insertTag;
  private readonly insertArtistTag;
  private readonly deleteArtistTags;

  constructor(
    private readonly handle: DbHandle,
    private readonly mb: MusicBrainzClient | null,
    private readonly lastfm: LastfmClient | null,
    private readonly onProgress: (p: EnrichProgress) => void = () => {},
  ) {
    this.cache = new EnrichmentCache(handle.sqlite);
    const s = handle.sqlite;
    this.selectTag = s.prepare('SELECT id FROM tags WHERE name = ?');
    this.insertTag = s.prepare('INSERT INTO tags (name) VALUES (?)');
    this.insertArtistTag = s.prepare(
      'INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, ?, ?)',
    );
    this.deleteArtistTags = s.prepare('DELETE FROM artist_tags WHERE artist_id = ? AND source = ?');
  }

  private allArtists(): ArtistRow[] {
    return this.handle.sqlite.prepare('SELECT id, name, mbid FROM artists ORDER BY id').all() as ArtistRow[];
  }

  private pendingArtists(): ArtistRow[] {
    return this.handle.sqlite
      .prepare(`SELECT id, name, mbid FROM artists WHERE enrich_status IN ('pending', 'error') ORDER BY id`)
      .all() as ArtistRow[];
  }

  /** Fetches (cache-aware) for pending/error artists, then derives their normalized data. */
  async run(): Promise<EnrichResult> {
    if (!this.mb || !this.lastfm) {
      throw new Error('run() requires MusicBrainz and Last.fm clients; use reprocessAll() for cache-only re-derivation');
    }
    const artists = this.pendingArtists();
    const erroredIds = await this.fetchAll(artists, this.mb, this.lastfm);

    let processed = 0;
    let withCountry = 0;
    const apply = this.handle.sqlite.transaction(() => {
      for (const artist of artists) {
        const derived = this.deriveOne(artist);
        if (derived.country) withCountry++;
        if (erroredIds.has(artist.id)) {
          this.saveAsError(artist.id, derived.country, derived.mbid);
        } else {
          this.saveAsDone(artist.id, derived.country, derived.mbid);
        }
        processed++;
      }
    });
    apply();

    this.onProgress({ kind: 'enrich', phase: 'derive', processed, total: artists.length });
    return { processed, withCountry, failed: erroredIds.size };
  }

  /**
   * Re-derives country/genre data for every artist purely from cached raw
   * responses -- no network calls, no status changes. Artists that were
   * never fetched (no cache row at all) are left untouched so a later
   * `run()` still picks them up.
   */
  reprocessAll(): ReprocessResult {
    const artists = this.allArtists();
    let processed = 0;
    let withCountry = 0;
    const apply = this.handle.sqlite.transaction(() => {
      for (const artist of artists) {
        const derived = this.deriveOne(artist);
        if (!derived.hadCacheData) continue;
        this.updateDerivedData(artist.id, derived.country, derived.mbid);
        if (derived.country) withCountry++;
        processed++;
      }
    });
    apply();
    return { processed, withCountry };
  }

  private async fetchAll(
    artists: ArtistRow[],
    mb: MusicBrainzClient,
    lastfm: LastfmClient,
  ): Promise<Set<number>> {
    const erroredIds = new Set<number>();
    let mbProcessed = 0;
    let lastfmProcessed = 0;
    const report = () =>
      this.onProgress({
        kind: 'enrich',
        phase: 'fetch',
        mbProcessed,
        mbTotal: artists.length,
        lastfmProcessed,
        lastfmTotal: artists.length,
      });

    const mbLane = async () => {
      for (const artist of artists) {
        try {
          await this.ensureMbCached(artist, mb);
        } catch {
          // Transient failure (network / MB 5xx after retries): leave uncached
          // so the next run() retries just this artist's MB fetch.
          erroredIds.add(artist.id);
        }
        mbProcessed++;
        report();
      }
    };
    const lastfmLane = async () => {
      for (const artist of artists) {
        try {
          await this.ensureLastfmCached(artist, lastfm);
        } catch {
          erroredIds.add(artist.id);
        }
        lastfmProcessed++;
        report();
      }
    };
    await Promise.all([mbLane(), lastfmLane()]);
    return erroredIds;
  }

  private async ensureMbCached(artist: ArtistRow, mb: MusicBrainzClient): Promise<void> {
    let mbid = artist.mbid;
    if (!mbid) {
      if (!this.cache.hasMbSearch(artist.name)) {
        const hit = await mb.searchArtist(artist.name);
        this.cache.putMbSearch(artist.name, hit);
      }
      const cached = this.cache.getMbSearch(artist.name);
      if (cached && cached.score >= MB_SCORE_THRESHOLD) mbid = cached.mbid;
    }
    if (mbid && !this.cache.hasMbArtist(mbid)) {
      const record = await mb.lookupArtist(mbid);
      this.cache.putMbArtist(mbid, record);
    }
  }

  private async ensureLastfmCached(artist: ArtistRow, lastfm: LastfmClient): Promise<void> {
    // Deliberately keyed off the artist's pre-existing (scrobble-sourced)
    // mbid only, never one the MB lane might resolve concurrently -- that
    // keeps the two lanes fully independent instead of serializing on each
    // other. A slightly less precise Last.fm lookup for artists with no
    // stored mbid is the trade-off for true parallelism.
    if (this.cache.hasLastfmTags(artist.name, artist.mbid)) return;
    const tags = await lastfm.getArtistTopTags({ name: artist.name, mbid: artist.mbid ?? undefined });
    this.cache.putLastfmTags(artist.name, artist.mbid, tags);
  }

  private deriveOne(artist: ArtistRow): Derived {
    let mbid = artist.mbid;
    let country: string | null = null;
    let genres: WeightedTag[] = [];
    let mbTags: WeightedTag[] = [];
    let sawCache = false;

    if (!mbid) {
      const searchHit = this.cache.getMbSearch(artist.name);
      if (searchHit !== undefined) {
        sawCache = true;
        if (searchHit && searchHit.score >= MB_SCORE_THRESHOLD) {
          mbid = searchHit.mbid;
          country = searchHit.country;
        }
      }
    }
    if (mbid) {
      const record = this.cache.getMbArtist(mbid);
      if (record !== undefined) {
        sawCache = true;
        if (record) {
          country = record.country ?? country;
          genres = record.genres;
          mbTags = record.tags;
        }
      }
    }

    const lfmTags = this.cache.getLastfmTags(artist.name, artist.mbid);
    if (lfmTags !== undefined) sawCache = true;

    if (sawCache) {
      this.writeTags(artist.id, 'musicbrainz', [...genres, ...mbTags]);
      this.writeTags(artist.id, 'lastfm', lfmTags ?? []);
    }

    return { hadCacheData: sawCache, country, mbid, genres, mbTags, lfmTags: lfmTags ?? [] };
  }

  /** Fully replaces (not merges) an artist's tags for one source, so a re-derive after a parsing change drops stale tags. */
  private writeTags(artistId: number, source: string, tags: WeightedTag[]): void {
    const best = new Map<string, number>();
    for (const t of tags) {
      const norm = t.name.toLowerCase();
      best.set(norm, Math.max(best.get(norm) ?? 0, t.weight));
    }
    this.deleteArtistTags.run(artistId, source);
    for (const [name, weight] of best) {
      this.insertArtistTag.run(artistId, this.getOrCreateTag(name), source, weight);
    }
  }

  private getOrCreateTag(name: string): number {
    const norm = name.toLowerCase();
    const cached = this.tagCache.get(norm);
    if (cached !== undefined) return cached;
    const row = this.selectTag.get(norm) as { id: number } | undefined;
    const id = row?.id ?? Number(this.insertTag.run(norm).lastInsertRowid);
    this.tagCache.set(norm, id);
    return id;
  }

  private saveAsDone(artistId: number, country: string | null, mbid: string | null): void {
    this.handle.sqlite
      .prepare(
        `UPDATE artists SET country = ?, mbid = COALESCE(?, mbid), enrich_status = 'done', enriched_at = ? WHERE id = ?`,
      )
      .run(country, mbid, Math.floor(Date.now() / 1000), artistId);
  }

  private saveAsError(artistId: number, country: string | null, mbid: string | null): void {
    // Preserve whatever partial data we did get (e.g. Last.fm succeeded even
    // though MusicBrainz failed) while flagging the artist for retry.
    this.handle.sqlite
      .prepare(`UPDATE artists SET country = ?, mbid = COALESCE(?, mbid), enrich_status = 'error' WHERE id = ?`)
      .run(country, mbid, artistId);
  }

  private updateDerivedData(artistId: number, country: string | null, mbid: string | null): void {
    this.handle.sqlite
      .prepare('UPDATE artists SET country = ?, mbid = COALESCE(?, mbid) WHERE id = ?')
      .run(country, mbid, artistId);
  }
}
