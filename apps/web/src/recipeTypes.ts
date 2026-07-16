// Mirror of the Recipe AST in @bftp/core. Kept as a local copy so the web
// build stays a plain Vite app with no workspace-source transpilation; the
// server owns the authoritative types and validates incoming recipes.

export interface DateBound {
  after?: string;
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
  | { type: 'genre'; anyOf: string[]; mode?: 'canonical' | 'raw' }
  | { type: 'country'; anyOf: string[]; negate?: boolean }
  | { type: 'excludeRecentlyPlaylisted'; days: number }
  | { type: 'anniversary'; field?: 'firstListen' | 'lastListen'; windowDays: number };

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
  perArtistCap?: number;
}

export interface Recipe {
  filters: Clause[];
  output: RecipeOutput;
}

export const SORT_LABELS: Record<SortKey, string> = {
  neglect: 'Most neglected (played a lot, long ago)',
  recent: 'Recently played',
  oldest_first_listen: 'Oldest discoveries first',
  playcount_desc: 'Most played',
  playcount_asc: 'Least played',
  weighted_random: 'Weighted shuffle (favours favourites)',
  random: 'Shuffle',
};
