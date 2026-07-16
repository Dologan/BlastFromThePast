import type { DbHandle } from '@bftp/db';

type Sqlite = DbHandle['sqlite'];

export type InsightKind = 'tracks' | 'albums';

export interface GapRow {
  entityId: number;
  name: string;
  artistName: string;
  playcount: number;
  /** Longest stretch between two consecutive plays, in seconds. */
  gapSeconds: number;
  gapStart: number;
  gapEnd: number;
}

export interface ClimberRow {
  entityId: number;
  name: string;
  artistName: string;
  playcount: number;
  rankNow: number;
  rankThen: number;
  /** Positions gained in the all-time playcount ranking over the window. */
  climb: number;
}

/**
 * "Gaps" (à la lastfm-stats-web): items you abandoned for the longest time and
 * then *came back to* — the widest interval between two consecutive plays.
 * Very on-brand: these are past blasts that already proved they can return.
 */
export function computeGaps(sqlite: Sqlite, kind: InsightKind, limit = 15): GapRow[] {
  const idCol = kind === 'tracks' ? 'track_id' : 'album_id';
  const entityTable = kind === 'tracks' ? 'tracks' : 'albums';
  const statsTable = kind === 'tracks' ? 'track_stats' : 'album_stats';
  const rows = sqlite
    .prepare(
      `WITH pairs AS (
         SELECT ${idCol} AS entity_id,
                uts AS gap_end,
                LAG(uts) OVER (PARTITION BY ${idCol} ORDER BY uts) AS gap_start
         FROM scrobbles
         ${kind === 'albums' ? 'WHERE album_id IS NOT NULL' : ''}
       ),
       best AS (
         SELECT entity_id, gap_start, gap_end, gap_end - gap_start AS gap,
                ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY gap_end - gap_start DESC) AS rn
         FROM pairs
         WHERE gap_start IS NOT NULL
       )
       SELECT b.entity_id AS entityId, e.name AS name, a.name AS artistName,
              st.playcount AS playcount, b.gap AS gapSeconds,
              b.gap_start AS gapStart, b.gap_end AS gapEnd
       FROM best b
       JOIN ${entityTable} e ON e.id = b.entity_id
       JOIN artists a ON a.id = e.artist_id
       JOIN ${statsTable} st ON st.${idCol} = b.entity_id
       WHERE b.rn = 1
       ORDER BY b.gap DESC
       LIMIT ?`,
    )
    .all(limit) as GapRow[];
  return rows;
}

/**
 * "Climbers": items that gained the most places in the all-time playcount
 * ranking over the last N days — i.e. what you're currently rediscovering.
 * Only items that already existed before the window count (new discoveries
 * would otherwise drown out the re-discoveries this app is about).
 */
export function computeClimbers(
  sqlite: Sqlite,
  kind: InsightKind,
  sinceDays = 90,
  limit = 15,
  nowSeconds = Math.floor(Date.now() / 1000),
): ClimberRow[] {
  const idCol = kind === 'tracks' ? 'track_id' : 'album_id';
  const entityTable = kind === 'tracks' ? 'tracks' : 'albums';
  const cutoff = nowSeconds - sinceDays * 86400;
  const albumFilter = kind === 'albums' ? 'AND album_id IS NOT NULL' : '';
  const rows = sqlite
    .prepare(
      `WITH now_counts AS (
         SELECT ${idCol} AS entity_id, COUNT(*) AS c
         FROM scrobbles WHERE 1=1 ${albumFilter}
         GROUP BY ${idCol}
       ),
       old_counts AS (
         SELECT ${idCol} AS entity_id, COUNT(*) AS c
         FROM scrobbles WHERE uts < ? ${albumFilter}
         GROUP BY ${idCol}
       ),
       now_ranks AS (
         SELECT entity_id, c, RANK() OVER (ORDER BY c DESC) AS r FROM now_counts
       ),
       old_ranks AS (
         SELECT entity_id, RANK() OVER (ORDER BY c DESC) AS r FROM old_counts
       )
       SELECT n.entity_id AS entityId, e.name AS name, a.name AS artistName,
              n.c AS playcount, n.r AS rankNow, o.r AS rankThen, o.r - n.r AS climb
       FROM now_ranks n
       JOIN old_ranks o ON o.entity_id = n.entity_id
       JOIN ${entityTable} e ON e.id = n.entity_id
       JOIN artists a ON a.id = e.artist_id
       WHERE o.r - n.r > 0
       ORDER BY climb DESC, n.r ASC
       LIMIT ?`,
    )
    .all(cutoff, limit) as ClimberRow[];
  return rows;
}
