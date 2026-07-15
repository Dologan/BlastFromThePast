import type Database from 'better-sqlite3';
import { normalizeName } from '@bftp/core';
import type { WeightedTag } from '../lastfm/client.js';
import type { MbSearchHit } from './musicbrainz.js';

export interface CachedMbArtist {
  country: string | null;
  genres: WeightedTag[];
  tags: WeightedTag[];
}

/**
 * Raw-response cache for MusicBrainz/Last.fm lookups, keyed independently of
 * the normalized artists/artist_tags schema. Populated once per artist (or
 * once per not-found query) and never expires, so re-deriving the normalized
 * tables after a schema or parsing change -- via Enrichment.reprocessAll() --
 * is a purely local, network-free operation.
 *
 * Every getter distinguishes "not cached yet" (`undefined`, caller must
 * fetch) from "cached, and the answer was a miss" (`null`, e.g. no MB
 * candidate found) -- both must be handled differently by callers.
 */
export class EnrichmentCache {
  private readonly selectMbSearch;
  private readonly upsertMbSearch;
  private readonly selectMbArtist;
  private readonly upsertMbArtist;
  private readonly selectLastfmTags;
  private readonly upsertLastfmTags;

  constructor(sqlite: Database.Database) {
    this.selectMbSearch = sqlite.prepare(
      'SELECT mbid, score, country FROM mb_search_cache WHERE query_normalized = ?',
    );
    this.upsertMbSearch = sqlite.prepare(
      `INSERT INTO mb_search_cache (query_normalized, mbid, score, country, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(query_normalized) DO UPDATE SET
         mbid = excluded.mbid, score = excluded.score, country = excluded.country,
         fetched_at = excluded.fetched_at`,
    );
    this.selectMbArtist = sqlite.prepare(
      'SELECT found, country, genres_json, tags_json FROM mb_artist_cache WHERE mbid = ?',
    );
    this.upsertMbArtist = sqlite.prepare(
      `INSERT INTO mb_artist_cache (mbid, found, country, genres_json, tags_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mbid) DO UPDATE SET
         found = excluded.found, country = excluded.country, genres_json = excluded.genres_json,
         tags_json = excluded.tags_json, fetched_at = excluded.fetched_at`,
    );
    this.selectLastfmTags = sqlite.prepare('SELECT tags_json FROM lastfm_tags_cache WHERE cache_key = ?');
    this.upsertLastfmTags = sqlite.prepare(
      `INSERT INTO lastfm_tags_cache (cache_key, tags_json, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET tags_json = excluded.tags_json, fetched_at = excluded.fetched_at`,
    );
  }

  hasMbSearch(artistName: string): boolean {
    return this.selectMbSearch.get(normalizeName(artistName)) !== undefined;
  }

  /** undefined = not cached (must fetch); null = cached miss (no candidate found). */
  getMbSearch(artistName: string): MbSearchHit | null | undefined {
    const row = this.selectMbSearch.get(normalizeName(artistName)) as
      | { mbid: string | null; score: number | null; country: string | null }
      | undefined;
    if (row === undefined) return undefined;
    if (row.mbid === null) return null;
    return { mbid: row.mbid, score: row.score ?? 0, country: row.country };
  }

  putMbSearch(artistName: string, hit: MbSearchHit | null): void {
    this.upsertMbSearch.run(
      normalizeName(artistName),
      hit?.mbid ?? null,
      hit?.score ?? null,
      hit?.country ?? null,
      Math.floor(Date.now() / 1000),
    );
  }

  hasMbArtist(mbid: string): boolean {
    return this.selectMbArtist.get(mbid) !== undefined;
  }

  /** undefined = not cached (must fetch); null = cached 404 (mbid merged/deleted). */
  getMbArtist(mbid: string): CachedMbArtist | null | undefined {
    const row = this.selectMbArtist.get(mbid) as
      | { found: number; country: string | null; genres_json: string; tags_json: string }
      | undefined;
    if (row === undefined) return undefined;
    if (!row.found) return null;
    return {
      country: row.country,
      genres: JSON.parse(row.genres_json) as WeightedTag[],
      tags: JSON.parse(row.tags_json) as WeightedTag[],
    };
  }

  putMbArtist(mbid: string, record: CachedMbArtist | null): void {
    this.upsertMbArtist.run(
      mbid,
      record ? 1 : 0,
      record?.country ?? null,
      JSON.stringify(record?.genres ?? []),
      JSON.stringify(record?.tags ?? []),
      Math.floor(Date.now() / 1000),
    );
  }

  private lastfmKey(artistName: string, mbid: string | null): string {
    // 'name:' prefix keeps this key space disjoint from real MBIDs (UUIDs).
    return mbid ?? `name:${normalizeName(artistName)}`;
  }

  hasLastfmTags(artistName: string, mbid: string | null): boolean {
    return this.selectLastfmTags.get(this.lastfmKey(artistName, mbid)) !== undefined;
  }

  /** undefined = not cached; an empty array is itself a valid cached "no tags" result. */
  getLastfmTags(artistName: string, mbid: string | null): WeightedTag[] | undefined {
    const row = this.selectLastfmTags.get(this.lastfmKey(artistName, mbid)) as
      | { tags_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.tags_json) as WeightedTag[]);
  }

  putLastfmTags(artistName: string, mbid: string | null, tags: WeightedTag[]): void {
    this.upsertLastfmTags.run(
      this.lastfmKey(artistName, mbid),
      JSON.stringify(tags),
      Math.floor(Date.now() / 1000),
    );
  }
}
