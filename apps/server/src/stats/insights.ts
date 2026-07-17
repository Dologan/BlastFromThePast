import type { DbHandle } from '@bftp/db';
import {
  circularDayMatchSql,
  dayOfYearUTC,
  searchQueryFor,
  spotifySearchUrl,
  tidalSearchUrl,
  type DeepLinkKind,
} from '@bftp/core';

type Sqlite = DbHandle['sqlite'];

export type InsightKind = 'tracks' | 'albums' | 'artists';

interface DeepLinks {
  spotifyUrl: string;
  tidalUrl: string;
}

export interface GapRow extends DeepLinks {
  entityId: number;
  name: string;
  /** Null for the 'artists' kind, where the entity itself is the artist. */
  artistName: string | null;
  playcount: number;
  lastListen: number;
  /** How long it's been silent so far, in seconds — an open-ended, still-running gap. */
  gapSeconds: number;
}

export interface NeglectedGemRow extends DeepLinks {
  entityId: number;
  name: string;
  artistName: string | null;
  playcount: number;
  lastListen: number;
  liked: boolean;
}

export interface OnThisDayRow extends DeepLinks {
  entityId: number;
  name: string;
  artistName: string | null;
  playcount: number;
  /** Which listen fell on today's calendar date. */
  matched: 'first' | 'last';
  matchedAt: number;
}

interface Tables {
  idCol: string;
  entityTable: string;
  statsTable: string;
  hasArtist: boolean;
  deepLinkKind: DeepLinkKind;
  /** SQL EXISTS fragment (references `e.id`): does this entity have a loved/liked track? */
  likedExistsSql: string;
}

function tablesFor(kind: InsightKind): Tables {
  if (kind === 'tracks') {
    return {
      idCol: 'track_id',
      entityTable: 'tracks',
      statsTable: 'track_stats',
      hasArtist: true,
      deepLinkKind: 'track',
      likedExistsSql: 'EXISTS (SELECT 1 FROM liked_tracks lt WHERE lt.track_id = e.id)',
    };
  }
  if (kind === 'albums') {
    return {
      idCol: 'album_id',
      entityTable: 'albums',
      statsTable: 'album_stats',
      hasArtist: true,
      deepLinkKind: 'album',
      likedExistsSql:
        'EXISTS (SELECT 1 FROM scrobbles s JOIN liked_tracks lt ON lt.track_id = s.track_id WHERE s.album_id = e.id)',
    };
  }
  return {
    idCol: 'artist_id',
    entityTable: 'artists',
    statsTable: 'artist_stats',
    hasArtist: false,
    deepLinkKind: 'artist',
    likedExistsSql:
      'EXISTS (SELECT 1 FROM tracks t JOIN liked_tracks lt ON lt.track_id = t.id WHERE t.artist_id = e.id)',
  };
}

function attachDeepLinks<T extends { name: string; artistName: string | null }>(
  rows: T[],
  deepLinkKind: DeepLinkKind,
): (T & DeepLinks)[] {
  return rows.map((r) => {
    const query = searchQueryFor({ artistName: r.artistName ?? '', name: r.name });
    return { ...r, spotifyUrl: spotifySearchUrl(query, deepLinkKind), tidalUrl: tidalSearchUrl(query, deepLinkKind) };
  });
}

/**
 * "Gaps": the longest you've currently gone without playing something you'd
 * played more than once before — an open-ended, still-running silence, not a
 * past pause you already came back from. Requiring playcount >= 2 keeps
 * one-off plays (which trivially have an "infinite" gap since day one) from
 * drowning out genuine rediscovery candidates.
 *
 * Ranked with weighted jitter rather than a strict ORDER BY: the biggest
 * gaps are still favoured, but pulled from a wide candidate pool (`poolSize`)
 * so the box doesn't show the exact same fixed list on every visit.
 */
export function computeGaps(
  sqlite: Sqlite,
  kind: InsightKind,
  limit = 10,
  nowSeconds = Math.floor(Date.now() / 1000),
  poolSize = 100,
): GapRow[] {
  const { idCol, entityTable, statsTable, hasArtist, deepLinkKind } = tablesFor(kind);
  const rows = sqlite
    .prepare(
      `WITH pool AS (
         SELECT e.id AS entityId, e.name AS name,
                ${hasArtist ? 'ar.name' : 'NULL'} AS artistName,
                st.playcount AS playcount, st.last_listen AS lastListen,
                (? - st.last_listen) AS gapSeconds,
                ROW_NUMBER() OVER (ORDER BY (? - st.last_listen) DESC) AS rn
         FROM ${statsTable} st
         JOIN ${entityTable} e ON e.id = st.${idCol}
         ${hasArtist ? 'JOIN artists ar ON ar.id = e.artist_id' : ''}
         WHERE st.playcount >= 2
       )
       SELECT entityId, name, artistName, playcount, lastListen, gapSeconds
       FROM pool
       WHERE rn <= ?
       ORDER BY bftp_wrandom(? - rn + 1) DESC
       LIMIT ?`,
    )
    .all(nowSeconds, nowSeconds, poolSize, poolSize, limit) as Omit<GapRow, keyof DeepLinks>[];
  return attachDeepLinks(rows, deepLinkKind);
}

/**
 * "Neglected Gems": a random sample of things that either (a) rank in the top
 * 10% by playcount for their kind, or (b) are loved/liked regardless of
 * playcount — and haven't been played in at least 3 years either way. Random
 * rather than a fixed top-N so the section surfaces different rediscovery
 * candidates each time.
 */
export function computeNeglectedGems(
  sqlite: Sqlite,
  kind: InsightKind,
  limit = 10,
  nowSeconds = Math.floor(Date.now() / 1000),
): NeglectedGemRow[] {
  const { idCol, entityTable, statsTable, hasArtist, deepLinkKind, likedExistsSql } = tablesFor(kind);
  const silenceCutoff = nowSeconds - 3 * 365 * 86400;
  const rows = sqlite
    .prepare(
      `SELECT e.id AS entityId, e.name AS name,
              ${hasArtist ? 'ar.name' : 'NULL'} AS artistName,
              st.playcount AS playcount, st.last_listen AS lastListen,
              (CASE WHEN ${likedExistsSql} THEN 1 ELSE 0 END) AS liked
       FROM ${statsTable} st
       JOIN ${entityTable} e ON e.id = st.${idCol}
       ${hasArtist ? 'JOIN artists ar ON ar.id = e.artist_id' : ''}
       WHERE st.last_listen <= ?
         AND (
           ${likedExistsSql}
           OR st.playcount >= (
             SELECT playcount FROM ${statsTable}
             ORDER BY playcount DESC
             LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.1 AS INTEGER) FROM ${statsTable})
           )
         )
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(silenceCutoff, limit) as (Omit<NeglectedGemRow, 'liked' | keyof DeepLinks> & { liked: number })[];
  return attachDeepLinks(
    rows.map((r) => ({ ...r, liked: Boolean(r.liked) })),
    deepLinkKind,
  );
}

/**
 * "On this day": things first or last played within a day of today's
 * calendar date, in some past year (not this year — that's just today's
 * normal listening, not a callback).
 */
export function computeOnThisDay(
  sqlite: Sqlite,
  kind: InsightKind,
  limit = 10,
  nowSeconds = Math.floor(Date.now() / 1000),
): OnThisDayRow[] {
  const { idCol, entityTable, statsTable, hasArtist, deepLinkKind } = tablesFor(kind);
  const today = dayOfYearUTC(nowSeconds);
  const thisYear = new Date(nowSeconds * 1000).getUTCFullYear();
  const notThisYear = (col: string) => `CAST(strftime('%Y', ${col}, 'unixepoch') AS INTEGER) != ${thisYear}`;
  const firstMatch = `(${circularDayMatchSql('st.first_listen', today, 1)} AND ${notThisYear('st.first_listen')})`;
  const lastMatch = `(${circularDayMatchSql('st.last_listen', today, 1)} AND ${notThisYear('st.last_listen')})`;
  const rows = sqlite
    .prepare(
      `SELECT e.id AS entityId, e.name AS name,
              ${hasArtist ? 'ar.name' : 'NULL'} AS artistName,
              st.playcount AS playcount,
              CASE WHEN ${firstMatch} THEN 'first' ELSE 'last' END AS matched,
              CASE WHEN ${firstMatch} THEN st.first_listen ELSE st.last_listen END AS matchedAt
       FROM ${statsTable} st
       JOIN ${entityTable} e ON e.id = st.${idCol}
       ${hasArtist ? 'JOIN artists ar ON ar.id = e.artist_id' : ''}
       WHERE ${firstMatch} OR ${lastMatch}
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(limit) as Omit<OnThisDayRow, keyof DeepLinks>[];
  return attachDeepLinks(rows, deepLinkKind);
}
