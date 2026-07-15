import type { DbHandle } from '@bftp/db';
import { normalizeName, type ServiceConnector, type ServiceName, type ServiceTrack } from '@bftp/core';

export interface MatchResult {
  serviceId: string;
  method: 'isrc' | 'search';
  confidence: number;
}

interface TrackInfo {
  id: number;
  name: string;
  isrc: string | null;
  artistName: string;
}

/**
 * Resolves library tracks to service track IDs, caching results in
 * service_links so a track is only searched once per service. Matching prefers
 * ISRC (exact) and otherwise searches by artist+title, scoring confidence from
 * how well the top result's normalized artist+title matches the query.
 */
export class ServiceMatcher {
  constructor(
    private readonly handle: DbHandle,
    private readonly connector: ServiceConnector,
    private readonly service: ServiceName,
  ) {}

  private cached(trackId: number): MatchResult | null {
    const row = this.handle.sqlite
      .prepare(
        `SELECT service_id, method, confidence FROM service_links
         WHERE entity_type = 'track' AND entity_id = ? AND service = ?`,
      )
      .get(trackId, this.service) as
      | { service_id: string; method: 'isrc' | 'search'; confidence: number }
      | undefined;
    return row ? { serviceId: row.service_id, method: row.method, confidence: row.confidence } : null;
  }

  private store(trackId: number, result: MatchResult): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO service_links (entity_type, entity_id, service, service_id, method, confidence, verified, matched_at)
         VALUES ('track', ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(entity_type, entity_id, service) DO UPDATE SET
           service_id = excluded.service_id, method = excluded.method,
           confidence = excluded.confidence, matched_at = excluded.matched_at`,
      )
      .run(trackId, this.service, result.serviceId, result.method, result.confidence, Math.floor(Date.now() / 1000));
  }

  private trackInfo(trackId: number): TrackInfo | null {
    return (
      (this.handle.sqlite
        .prepare(
          `SELECT t.id AS id, t.name AS name, t.isrc AS isrc, a.name AS artistName
           FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.id = ?`,
        )
        .get(trackId) as TrackInfo | undefined) ?? null
    );
  }

  private score(info: TrackInfo, candidate: ServiceTrack): number {
    const titleMatch = normalizeName(candidate.name) === normalizeName(info.name);
    const artistMatch = normalizeName(candidate.artistName) === normalizeName(info.artistName);
    if (titleMatch && artistMatch) return 1;
    if (titleMatch || artistMatch) return 0.6;
    return 0.3;
  }

  /** Returns a cached or freshly-resolved match, or null if nothing was found. */
  async match(trackId: number, { useCache = true } = {}): Promise<MatchResult | null> {
    if (useCache) {
      const hit = this.cached(trackId);
      if (hit) return hit;
    }
    const info = this.trackInfo(trackId);
    if (!info) return null;

    if (info.isrc) {
      const byIsrc = await this.connector.searchTrack({
        isrc: info.isrc,
        artistName: info.artistName,
        trackName: info.name,
      });
      if (byIsrc[0]) {
        const result: MatchResult = { serviceId: byIsrc[0].serviceId, method: 'isrc', confidence: 1 };
        this.store(trackId, result);
        return result;
      }
    }

    const results = await this.connector.searchTrack({
      artistName: info.artistName,
      trackName: info.name,
    });
    if (!results[0]) return null;
    // Pick the best-scoring candidate among the returned results.
    let best = results[0];
    let bestScore = this.score(info, results[0]);
    for (const cand of results.slice(1)) {
      const s = this.score(info, cand);
      if (s > bestScore) {
        best = cand;
        bestScore = s;
      }
    }
    const result: MatchResult = { serviceId: best.serviceId, method: 'search', confidence: bestScore };
    this.store(trackId, result);
    return result;
  }
}
