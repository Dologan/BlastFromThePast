import type { DbHandle } from '@bftp/db';

type Sqlite = DbHandle['sqlite'];

export type InsightKind = 'tracks' | 'albums' | 'artists';

export interface GapRow {
  entityId: number;
  name: string;
  /** Null for the 'artists' kind, where the entity itself is the artist. */
  artistName: string | null;
  playcount: number;
  lastListen: number;
  /** How long it's been silent so far, in seconds — an open-ended, still-running gap. */
  gapSeconds: number;
}

export interface NeglectedRow {
  entityId: number;
  name: string;
  artistName: string | null;
  playcount: number;
  lastListen: number;
}

interface Tables {
  idCol: string;
  entityTable: string;
  statsTable: string;
  hasArtist: boolean;
}

function tablesFor(kind: InsightKind): Tables {
  if (kind === 'tracks') return { idCol: 'track_id', entityTable: 'tracks', statsTable: 'track_stats', hasArtist: true };
  if (kind === 'albums') return { idCol: 'album_id', entityTable: 'albums', statsTable: 'album_stats', hasArtist: true };
  return { idCol: 'artist_id', entityTable: 'artists', statsTable: 'artist_stats', hasArtist: false };
}

/**
 * "Gaps": the longest you've currently gone without playing something you'd
 * played more than once before — an open-ended, still-running silence, not a
 * past pause you already came back from. Requiring playcount >= 2 keeps
 * one-off plays (which trivially have an "infinite" gap since day one) from
 * drowning out genuine rediscovery candidates.
 */
export function computeGaps(
  sqlite: Sqlite,
  kind: InsightKind,
  limit = 15,
  nowSeconds = Math.floor(Date.now() / 1000),
): GapRow[] {
  const { idCol, entityTable, statsTable, hasArtist } = tablesFor(kind);
  const rows = sqlite
    .prepare(
      `SELECT e.id AS entityId, e.name AS name,
              ${hasArtist ? 'ar.name' : 'NULL'} AS artistName,
              st.playcount AS playcount, st.last_listen AS lastListen,
              (? - st.last_listen) AS gapSeconds
       FROM ${statsTable} st
       JOIN ${entityTable} e ON e.id = st.${idCol}
       ${hasArtist ? 'JOIN artists ar ON ar.id = e.artist_id' : ''}
       WHERE st.playcount >= 2
       ORDER BY gapSeconds DESC
       LIMIT ?`,
    )
    .all(nowSeconds, limit) as GapRow[];
  return rows;
}

/**
 * "Neglected": a random sample of things that have gone quiet for at least
 * `minSilentDays` — deliberately random (rather than a fixed top-N) so this
 * section surfaces different rediscovery candidates each time, complementing
 * the deterministic "longest gaps" ranking above it.
 */
export function computeNeglected(
  sqlite: Sqlite,
  kind: InsightKind,
  minSilentDays = 90,
  limit = 8,
  nowSeconds = Math.floor(Date.now() / 1000),
): NeglectedRow[] {
  const { idCol, entityTable, statsTable, hasArtist } = tablesFor(kind);
  const cutoff = nowSeconds - minSilentDays * 86400;
  const rows = sqlite
    .prepare(
      `SELECT e.id AS entityId, e.name AS name,
              ${hasArtist ? 'ar.name' : 'NULL'} AS artistName,
              st.playcount AS playcount, st.last_listen AS lastListen
       FROM ${statsTable} st
       JOIN ${entityTable} e ON e.id = st.${idCol}
       ${hasArtist ? 'JOIN artists ar ON ar.id = e.artist_id' : ''}
       WHERE st.playcount >= 1 AND st.last_listen <= ?
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(cutoff, limit) as NeglectedRow[];
  return rows;
}
