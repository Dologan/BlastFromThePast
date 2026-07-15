import type Database from 'better-sqlite3';

/**
 * Rebuild the materialized listening stats (first/last listen, playcount,
 * peak month) for tracks, albums and artists from the scrobbles table.
 *
 * A full rebuild is a single SQL pass per table and stays well under a second
 * even for libraries with hundreds of thousands of scrobbles, so we favour
 * simplicity over incremental bookkeeping.
 */
export function rebuildStats(sqlite: Database.Database): void {
  const rebuild = sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM track_stats;
      INSERT INTO track_stats (track_id, first_listen, last_listen, playcount, peak_month, peak_month_count)
      WITH monthly AS (
        SELECT track_id AS eid, strftime('%Y-%m', uts, 'unixepoch') AS ym, COUNT(*) AS c
        FROM scrobbles GROUP BY eid, ym
      ), peaks AS (
        SELECT eid, ym, c, ROW_NUMBER() OVER (PARTITION BY eid ORDER BY c DESC, ym ASC) AS rn
        FROM monthly
      )
      SELECT s.track_id, MIN(s.uts), MAX(s.uts), COUNT(*), p.ym, p.c
      FROM scrobbles s
      JOIN peaks p ON p.eid = s.track_id AND p.rn = 1
      GROUP BY s.track_id;

      DELETE FROM album_stats;
      INSERT INTO album_stats (album_id, first_listen, last_listen, playcount, peak_month, peak_month_count)
      WITH monthly AS (
        SELECT album_id AS eid, strftime('%Y-%m', uts, 'unixepoch') AS ym, COUNT(*) AS c
        FROM scrobbles WHERE album_id IS NOT NULL GROUP BY eid, ym
      ), peaks AS (
        SELECT eid, ym, c, ROW_NUMBER() OVER (PARTITION BY eid ORDER BY c DESC, ym ASC) AS rn
        FROM monthly
      )
      SELECT s.album_id, MIN(s.uts), MAX(s.uts), COUNT(*), p.ym, p.c
      FROM scrobbles s
      JOIN peaks p ON p.eid = s.album_id AND p.rn = 1
      WHERE s.album_id IS NOT NULL
      GROUP BY s.album_id;

      DELETE FROM artist_stats;
      INSERT INTO artist_stats (artist_id, first_listen, last_listen, playcount, peak_month, peak_month_count)
      WITH monthly AS (
        SELECT t.artist_id AS eid, strftime('%Y-%m', s.uts, 'unixepoch') AS ym, COUNT(*) AS c
        FROM scrobbles s JOIN tracks t ON t.id = s.track_id
        GROUP BY eid, ym
      ), peaks AS (
        SELECT eid, ym, c, ROW_NUMBER() OVER (PARTITION BY eid ORDER BY c DESC, ym ASC) AS rn
        FROM monthly
      )
      SELECT t.artist_id, MIN(s.uts), MAX(s.uts), COUNT(*), p.ym, p.c
      FROM scrobbles s
      JOIN tracks t ON t.id = s.track_id
      JOIN peaks p ON p.eid = t.artist_id AND p.rn = 1
      GROUP BY t.artist_id;
    `);
  });
  rebuild();
}
