import type { Clause, Recipe, SortKey } from './recipe.js';

export interface CompileContext {
  /** Reference "now" in unix seconds, for relative clauses (notPlayedInDays…). */
  nowSeconds: number;
  /**
   * Resolves a genre clause to the concrete lowercase tag names present in the
   * library. Injected so the compiler stays pure/DB-free (the server backs it
   * with GenreResolver + the tags table; tests pass a stub).
   */
  resolveGenreTags: (anyOf: string[], mode: 'canonical' | 'raw') => string[];
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  countSql: string;
  countParams: unknown[];
}

interface Grain {
  fromJoin: string;
  stats: string; // stats table alias
  idCol: string;
  nameCol: string;
  albumCol: string;
  entityKind: 'track' | 'album';
  trackScopeForPlaylist: string; // condition tying playlist_log_tracks to this grain
  lovedExists: (sourceCond: string) => string;
  playlistExists: (recentCond: string) => string;
}

function toEpoch(date: string, endOfDay = false): number {
  // Interpret bare dates as UTC; add a day (minus 1s) for inclusive "before".
  const base = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  return endOfDay ? base + 86399 : base;
}

/** Day of year (1–366, UTC) for a unix-seconds timestamp. */
function dayOfYearUTC(seconds: number): number {
  const d = new Date(seconds * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}

function grainFor(mode: 'tracks' | 'albums'): Grain {
  if (mode === 'tracks') {
    return {
      fromJoin:
        'FROM tracks t JOIN track_stats ts ON ts.track_id = t.id JOIN artists a ON a.id = t.artist_id',
      stats: 'ts',
      idCol: 't.id',
      nameCol: 't.name',
      // Best-effort album: the one this track was most often scrobbled under.
      albumCol:
        "(SELECT al.name FROM scrobbles s3 JOIN albums al ON al.id = s3.album_id WHERE s3.track_id = t.id AND s3.album_id IS NOT NULL GROUP BY s3.album_id ORDER BY COUNT(*) DESC LIMIT 1)",
      entityKind: 'track',
      trackScopeForPlaylist: 'plt.track_id = t.id',
      lovedExists: (sourceCond) =>
        `EXISTS (SELECT 1 FROM liked_tracks lt WHERE lt.track_id = t.id${sourceCond})`,
      playlistExists: (recentCond) =>
        `EXISTS (SELECT 1 FROM playlist_log_tracks plt JOIN playlist_log pl ON pl.id = plt.playlist_log_id WHERE plt.track_id = t.id AND ${recentCond})`,
    };
  }
  return {
    fromJoin:
      'FROM albums al JOIN album_stats als ON als.album_id = al.id JOIN artists a ON a.id = al.artist_id',
    stats: 'als',
    idCol: 'al.id',
    nameCol: 'al.name',
    albumCol: 'al.name',
    entityKind: 'album',
    trackScopeForPlaylist: 's.album_id = al.id',
    // An album is "loved" if it contains a loved track scrobbled under it.
    lovedExists: (sourceCond) =>
      `EXISTS (SELECT 1 FROM scrobbles s JOIN liked_tracks lt ON lt.track_id = s.track_id WHERE s.album_id = al.id${sourceCond})`,
    playlistExists: (recentCond) =>
      `EXISTS (SELECT 1 FROM playlist_log_tracks plt JOIN playlist_log pl ON pl.id = plt.playlist_log_id JOIN scrobbles s ON s.track_id = plt.track_id WHERE s.album_id = al.id AND ${recentCond})`,
  };
}

function inList(values: unknown[], params: unknown[]): string {
  params.push(...values);
  return `(${values.map(() => '?').join(', ')})`;
}

function compileClause(clause: Clause, g: Grain, ctx: CompileContext, params: unknown[]): string {
  const S = g.stats;
  switch (clause.type) {
    case 'firstListen':
    case 'lastListen': {
      const col = clause.type === 'firstListen' ? `${S}.first_listen` : `${S}.last_listen`;
      const parts: string[] = [];
      if (clause.after) parts.push(`${col} >= ${toEpoch(clause.after)}`);
      if (clause.before) parts.push(`${col} <= ${toEpoch(clause.before, true)}`);
      return parts.length ? parts.join(' AND ') : '1';
    }
    case 'peakMonth': {
      const parts: string[] = [];
      // peak_month is 'YYYY-MM'; compare lexically against a YYYY-MM prefix.
      if (clause.after) {
        params.push(clause.after.slice(0, 7));
        parts.push(`${S}.peak_month >= ?`);
      }
      if (clause.before) {
        params.push(clause.before.slice(0, 7));
        parts.push(`${S}.peak_month <= ?`);
      }
      return parts.length ? parts.join(' AND ') : '1';
    }
    case 'notPlayedInDays':
      return `${S}.last_listen <= ${ctx.nowSeconds - clause.days * 86400}`;
    case 'playedInDays':
      return `${S}.last_listen >= ${ctx.nowSeconds - clause.days * 86400}`;
    case 'playcount': {
      const parts: string[] = [];
      if (clause.min !== undefined) parts.push(`${S}.playcount >= ${Math.floor(clause.min)}`);
      if (clause.max !== undefined) parts.push(`${S}.playcount <= ${Math.floor(clause.max)}`);
      return parts.length ? parts.join(' AND ') : '1';
    }
    case 'loved': {
      let sourceCond = '';
      if (clause.source) {
        params.push(clause.source);
        sourceCond = ' AND lt.source = ?';
      }
      return g.lovedExists(sourceCond);
    }
    case 'genre': {
      const tags = ctx.resolveGenreTags(clause.anyOf, clause.mode ?? 'canonical');
      if (tags.length === 0) return '0'; // named a genre with no matching tags -> matches nothing
      return `EXISTS (SELECT 1 FROM artist_tags atg JOIN tags tg ON tg.id = atg.tag_id WHERE atg.artist_id = a.id AND tg.name IN ${inList(
        tags,
        params,
      )})`;
    }
    case 'country': {
      if (clause.anyOf.length === 0) return '1';
      const inClause = `a.country IN ${inList(clause.anyOf, params)}`;
      return clause.negate ? `(a.country IS NULL OR NOT (${inClause}))` : inClause;
    }
    case 'excludeRecentlyPlaylisted': {
      const recentCond = `pl.created_at >= ${ctx.nowSeconds - clause.days * 86400}`;
      return `NOT ${g.playlistExists(recentCond)}`;
    }
    case 'anniversary': {
      const col = clause.field === 'lastListen' ? `${S}.last_listen` : `${S}.first_listen`;
      const today = dayOfYearUTC(ctx.nowSeconds);
      const w = Math.max(0, Math.floor(clause.windowDays));
      const e = `CAST(strftime('%j', ${col}, 'unixepoch') AS INTEGER)`;
      // Circular distance on the calendar wheel (handles Dec/Jan wraparound).
      return `(ABS(${e} - ${today}) <= ${w} OR 366 - ABS(${e} - ${today}) <= ${w})`;
    }
    case 'gapDays': {
      const ongoingDays = `((${ctx.nowSeconds} - ${S}.last_listen) / 86400.0)`;
      if (clause.infinite) {
        const parts = [`(${S}.max_gap_days IS NULL OR ${ongoingDays} > ${S}.max_gap_days)`];
        if (clause.minDays !== undefined) parts.push(`${ongoingDays} >= ${Math.floor(clause.minDays)}`);
        return parts.join(' AND ');
      }
      const parts = [`${S}.max_gap_days IS NOT NULL`];
      if (clause.minDays !== undefined) parts.push(`${S}.max_gap_days >= ${Math.floor(clause.minDays)}`);
      if (clause.maxDays !== undefined) parts.push(`${S}.max_gap_days <= ${Math.floor(clause.maxDays)}`);
      return parts.join(' AND ');
    }
  }
}

function sortExpr(sort: SortKey, S: string, now: number): { expr: string; dir: 'ASC' | 'DESC' } {
  switch (sort) {
    case 'playcount_desc':
      return { expr: `${S}.playcount`, dir: 'DESC' };
    case 'playcount_asc':
      return { expr: `${S}.playcount`, dir: 'ASC' };
    case 'recent':
      return { expr: `${S}.last_listen`, dir: 'DESC' };
    case 'oldest_first_listen':
      return { expr: `${S}.first_listen`, dir: 'ASC' };
    case 'neglect':
      // Played a lot, long ago: high playcount * long time since last listen.
      return { expr: `${S}.playcount * (${now} - ${S}.last_listen)`, dir: 'DESC' };
    case 'random':
      return { expr: 'RANDOM()', dir: 'DESC' };
    case 'weighted_random':
      // Efraimidis-Spirakis key; registered as a SQLite scalar in openDb.
      return { expr: `bftp_wrandom(${S}.playcount)`, dir: 'DESC' };
  }
}

/**
 * Compiles a Recipe into a parameterized SELECT (limited, sorted, diversity-
 * capped) plus a COUNT of all matching rows before output shaping. The sort
 * key is computed once as a column so random orderings stay stable across the
 * window partition and the final ORDER BY.
 */
export function compileRecipe(recipe: Recipe, ctx: CompileContext): CompiledQuery {
  const g = grainFor(recipe.output.mode);
  const whereParams: unknown[] = [];
  const conds = recipe.filters.map((c) => compileClause(c, g, ctx, whereParams));
  const where = conds.length ? conds.map((c) => `(${c})`).join(' AND ') : '1';

  const countSql = `SELECT COUNT(*) AS c ${g.fromJoin} WHERE ${where}`;

  const { expr, dir } = sortExpr(recipe.output.sort, g.stats, ctx.nowSeconds);
  const limit = Math.max(1, Math.floor(recipe.output.limit));

  const inner = `SELECT ${g.idCol} AS entity_id, '${g.entityKind}' AS entity_kind, ${g.nameCol} AS name,
      a.name AS artist_name, ${g.albumCol} AS album_name, a.id AS artist_id,
      ${g.stats}.playcount AS playcount, ${g.stats}.first_listen AS first_listen, ${g.stats}.last_listen AS last_listen,
      ${expr} AS sort_key
    ${g.fromJoin} WHERE ${where}`;

  const finalCols =
    'entity_id, entity_kind, name, artist_name, album_name, playcount, first_listen, last_listen';

  let sql: string;
  const cap = recipe.output.perArtistCap;
  if (cap && cap > 0) {
    sql = `SELECT ${finalCols} FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY sort_key ${dir}) AS rn
        FROM (${inner})
      ) WHERE rn <= ${Math.floor(cap)}
      ORDER BY sort_key ${dir} LIMIT ${limit}`;
  } else {
    sql = `SELECT ${finalCols} FROM (${inner}) ORDER BY sort_key ${dir} LIMIT ${limit}`;
  }

  return { sql, params: [...whereParams], countSql, countParams: [...whereParams] };
}
