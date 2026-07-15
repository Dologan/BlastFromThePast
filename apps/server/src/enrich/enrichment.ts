import type { DbHandle } from '@bftp/db';
import type { LastfmClient, WeightedTag } from '../lastfm/client.js';
import type { MusicBrainzClient } from './musicbrainz.js';

export interface EnrichProgress {
  kind: 'enrich';
  processed: number;
  total: number;
  current: string | null;
}

export interface EnrichResult {
  processed: number;
  withCountry: number;
  failed: number;
}

// Only trust a name-based MusicBrainz match at or above this score (0–100);
// below it we skip country/mbid but still take Last.fm tags by name.
const MB_SCORE_THRESHOLD = 90;

interface PendingArtist {
  id: number;
  name: string;
  mbid: string | null;
}

/**
 * Fills in country of origin and genre/folksonomy tags for artists, from
 * MusicBrainz (authoritative genres + country) and Last.fm (broad tags).
 *
 * Each artist is committed independently and its `enrich_status` advanced, so
 * the job is naturally resumable: re-running picks up whatever is still
 * `pending` or `error`. "Not found" is a terminal success (marked `done` with
 * null country) so obscure artists aren't retried forever.
 */
export class Enrichment {
  private readonly tagCache = new Map<string, number>();
  private readonly selectTag;
  private readonly insertTag;
  private readonly upsertArtistTag;

  constructor(
    private readonly handle: DbHandle,
    private readonly mb: MusicBrainzClient,
    private readonly lastfm: LastfmClient,
    private readonly onProgress: (p: EnrichProgress) => void = () => {},
  ) {
    const s = handle.sqlite;
    this.selectTag = s.prepare('SELECT id FROM tags WHERE name = ?');
    this.insertTag = s.prepare('INSERT INTO tags (name) VALUES (?)');
    this.upsertArtistTag = s.prepare(
      `INSERT INTO artist_tags (artist_id, tag_id, source, weight)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(artist_id, tag_id, source) DO UPDATE SET weight = excluded.weight`,
    );
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

  private pendingArtists(): PendingArtist[] {
    return this.handle.sqlite
      .prepare(
        `SELECT id, name, mbid FROM artists
         WHERE enrich_status IN ('pending', 'error')
         ORDER BY id`,
      )
      .all() as PendingArtist[];
  }

  async run(): Promise<EnrichResult> {
    const artists = this.pendingArtists();
    let processed = 0;
    let withCountry = 0;
    let failed = 0;

    for (const artist of artists) {
      this.onProgress({ kind: 'enrich', processed, total: artists.length, current: artist.name });
      try {
        const { country, mbid } = await this.enrichOne(artist);
        if (country) withCountry++;
        this.commit(artist.id, country, mbid);
      } catch (err) {
        // Transient failure (network / MB 5xx after retries): leave for a later run.
        this.markError(artist.id, err instanceof Error ? err.message : String(err));
        failed++;
      }
      processed++;
    }

    this.onProgress({ kind: 'enrich', processed, total: artists.length, current: null });
    return { processed, withCountry, failed };
  }

  private async enrichOne(
    artist: PendingArtist,
  ): Promise<{ country: string | null; mbid: string | null; genres: WeightedTag[]; lfmTags: WeightedTag[] }> {
    let mbid = artist.mbid;
    let country: string | null = null;
    let genres: WeightedTag[] = [];
    let mbTags: WeightedTag[] = [];

    // Resolve an MBID by name when scrobbles didn't carry one.
    if (!mbid) {
      const hit = await this.mb.searchArtist(artist.name);
      if (hit && hit.score >= MB_SCORE_THRESHOLD) {
        mbid = hit.mbid;
        country = hit.country;
      }
    }
    if (mbid) {
      const record = await this.mb.lookupArtist(mbid);
      if (record) {
        country = record.country ?? country;
        genres = record.genres;
        mbTags = record.tags;
      }
    }

    const lfmTags = await this.lastfm.getArtistTopTags({ name: artist.name, mbid: mbid ?? undefined });

    this.writeTags(artist.id, 'musicbrainz', [...genres, ...mbTags]);
    this.writeTags(artist.id, 'lastfm', lfmTags);

    return { country, mbid, genres, lfmTags };
  }

  private writeTags(artistId: number, source: string, tags: WeightedTag[]): void {
    if (tags.length === 0) return;
    // Collapse duplicate tag names within a source, keeping the highest weight.
    const best = new Map<string, number>();
    for (const t of tags) {
      const norm = t.name.toLowerCase();
      best.set(norm, Math.max(best.get(norm) ?? 0, t.weight));
    }
    const apply = this.handle.sqlite.transaction(() => {
      for (const [name, weight] of best) {
        this.upsertArtistTag.run(artistId, this.getOrCreateTag(name), source, weight);
      }
    });
    apply();
  }

  private commit(artistId: number, country: string | null, mbid: string | null): void {
    this.handle.sqlite
      .prepare(
        `UPDATE artists
         SET country = ?, mbid = COALESCE(?, mbid), enrich_status = 'done', enriched_at = ?
         WHERE id = ?`,
      )
      .run(country, mbid, Math.floor(Date.now() / 1000), artistId);
  }

  private markError(artistId: number, _message: string): void {
    this.handle.sqlite
      .prepare("UPDATE artists SET enrich_status = 'error' WHERE id = ?")
      .run(artistId);
  }
}
