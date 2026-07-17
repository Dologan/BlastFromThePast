/**
 * A Recipe is the serialized, saveable definition of a music-selection query.
 * `filters` are ANDed together; a genre or country clause can list several
 * values that are ORed within that one clause. `output` shapes the result set
 * (grain, ordering, size, per-artist diversity).
 */

export interface DateBound {
  /**
   * Inclusive lower bound, ISO date 'YYYY-MM-DD'. For peakMonth this is
   * truncated to the containing month ('YYYY-MM') when compiled, so a bare
   * 'YYYY-MM' (from older saved recipes) still works.
   */
  after?: string;
  /** Inclusive upper bound, same format as `after`. */
  before?: string;
}

export type Clause =
  | ({ type: 'firstListen' } & DateBound)
  | ({ type: 'lastListen' } & DateBound)
  | ({ type: 'peakMonth' } & DateBound)
  | { type: 'notPlayedInDays'; days: number }
  | { type: 'playedInDays'; days: number }
  | { type: 'playcount'; min?: number; max?: number }
  | { type: 'loved'; source?: 'lastfm' | 'spotify' }
  | { type: 'genre'; anyOf: string[]; mode?: 'canonical' | 'raw'; negate?: boolean }
  | { type: 'country'; anyOf: string[]; negate?: boolean }
  | { type: 'excludeRecentlyPlaylisted'; days: number }
  // First/last listen fell within ±windowDays of today's calendar day, in any
  // year — the "on this day" / anniversaries filter.
  | { type: 'anniversary'; field?: 'firstListen' | 'lastListen'; windowDays: number }
  // Widest gap between two consecutive plays. `infinite` selects entities
  // whose *current* silence since the last play already exceeds every past,
  // already-bridged gap (or who have no bridged gap at all) — i.e. they
  // haven't returned from their biggest-ever pause yet, unlike a min/max
  // range which looks at gaps that were already bridged by a later play.
  | { type: 'gapDays'; minDays?: number; maxDays?: number; infinite?: boolean };

export type ClauseType = Clause['type'];

export type OutputMode = 'tracks' | 'albums';

export type SortKey =
  | 'playcount_desc'
  | 'playcount_asc'
  | 'recent'
  | 'oldest_first_listen'
  | 'neglect'
  | 'random'
  | 'weighted_random';

export interface RecipeOutput {
  mode: OutputMode;
  sort: SortKey;
  limit: number;
  /** Max results per artist (diversity). Undefined = no cap. */
  perArtistCap?: number;
}

export interface Recipe {
  filters: Clause[];
  output: RecipeOutput;
}

export interface ResultRow {
  entityId: number;
  entityKind: OutputMode extends 'tracks' ? 'track' : 'album';
  name: string;
  artistName: string;
  albumName: string | null;
  playcount: number;
  firstListen: number;
  lastListen: number;
}

export const DEFAULT_OUTPUT: RecipeOutput = {
  mode: 'albums',
  sort: 'neglect',
  limit: 50,
};
