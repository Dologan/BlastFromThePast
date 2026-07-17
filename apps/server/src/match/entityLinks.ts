import type { DbHandle } from '@bftp/db';
import { normalizeName, type ServiceConnector, type ServiceName } from '@bftp/core';

export type LinkEntityKind = 'track' | 'album' | 'artist';

interface EntityInfo {
  name: string;
  /** '' for the 'artist' kind, where the entity itself is the artist. */
  artistName: string;
}

interface Candidate {
  serviceId: string;
  name: string;
  artistName: string;
}

const MIN_CONFIDENCE = 0.6;

function fetchEntityInfo(handle: DbHandle, kind: LinkEntityKind, entityId: number): EntityInfo | null {
  if (kind === 'track') {
    return (
      (handle.sqlite
        .prepare('SELECT t.name AS name, a.name AS artistName FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.id = ?')
        .get(entityId) as EntityInfo | undefined) ?? null
    );
  }
  if (kind === 'album') {
    return (
      (handle.sqlite
        .prepare('SELECT al.name AS name, a.name AS artistName FROM albums al JOIN artists a ON a.id = al.artist_id WHERE al.id = ?')
        .get(entityId) as EntityInfo | undefined) ?? null
    );
  }
  const row = handle.sqlite.prepare('SELECT name FROM artists WHERE id = ?').get(entityId) as { name: string } | undefined;
  return row ? { name: row.name, artistName: '' } : null;
}

function cachedServiceId(handle: DbHandle, kind: LinkEntityKind, entityId: number, service: ServiceName): string | null {
  const row = handle.sqlite
    .prepare('SELECT service_id FROM service_links WHERE entity_type = ? AND entity_id = ? AND service = ?')
    .get(kind, entityId, service) as { service_id: string } | undefined;
  return row?.service_id ?? null;
}

function storeServiceId(
  handle: DbHandle,
  kind: LinkEntityKind,
  entityId: number,
  service: ServiceName,
  serviceId: string,
  confidence: number,
): void {
  handle.sqlite
    .prepare(
      `INSERT INTO service_links (entity_type, entity_id, service, service_id, method, confidence, verified, matched_at)
       VALUES (?, ?, ?, ?, 'search', ?, 0, ?)
       ON CONFLICT(entity_type, entity_id, service) DO UPDATE SET
         service_id = excluded.service_id, confidence = excluded.confidence, matched_at = excluded.matched_at`,
    )
    .run(kind, entityId, service, serviceId, confidence, Math.floor(Date.now() / 1000));
}

/** Same "how well does this candidate match" heuristic as the track push matcher. */
function score(info: EntityInfo, candidate: Candidate): number {
  const nameMatch = normalizeName(candidate.name) === normalizeName(info.name);
  if (!info.artistName) return nameMatch ? 1 : 0.3; // artist kind: name is the only signal
  const artistMatch = normalizeName(candidate.artistName) === normalizeName(info.artistName);
  if (nameMatch && artistMatch) return 1;
  if (nameMatch || artistMatch) return 0.6;
  return 0.3;
}

function deepLinkFor(connector: ServiceConnector, kind: LinkEntityKind, serviceId: string): string {
  if (kind === 'track') return connector.deepLinkTrack(serviceId);
  if (kind === 'album') return connector.deepLinkAlbum(serviceId);
  return connector.deepLinkArtist(serviceId);
}

/**
 * Resolves a library track/album/artist to a direct deep link on `service`,
 * caching the match in service_links so repeat lookups (e.g. re-viewing the
 * same Insights box) are free. Returns null if the service isn't connected,
 * the connector doesn't support searching this kind, or no confident match
 * was found -- callers should fall back to a generic search URL.
 */
export async function resolveDeepLink(
  handle: DbHandle,
  connector: ServiceConnector,
  service: ServiceName,
  kind: LinkEntityKind,
  entityId: number,
): Promise<string | null> {
  const existing = cachedServiceId(handle, kind, entityId, service);
  if (existing) return deepLinkFor(connector, kind, existing);

  if (!(await connector.isAuthorized())) return null;
  const info = fetchEntityInfo(handle, kind, entityId);
  if (!info) return null;

  let candidates: Candidate[] = [];
  if (kind === 'track') {
    candidates = await connector.searchTrack({ artistName: info.artistName, trackName: info.name });
  } else if (kind === 'album') {
    if (!connector.searchAlbum) return null;
    candidates = await connector.searchAlbum({ artistName: info.artistName, albumName: info.name });
  } else {
    if (!connector.searchArtist) return null;
    candidates = (await connector.searchArtist({ artistName: info.name })).map((c) => ({ ...c, artistName: '' }));
  }
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestScore = score(info, best);
  for (const c of candidates.slice(1)) {
    const s = score(info, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (bestScore < MIN_CONFIDENCE) return null;

  storeServiceId(handle, kind, entityId, service, best.serviceId, bestScore);
  return deepLinkFor(connector, kind, best.serviceId);
}
