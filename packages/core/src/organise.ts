import type { ServiceName } from './connectors.js';
import type { Recipe } from './recipe.js';
import { RECIPE_JSON_SCHEMA } from './recipeSchema.js';

/**
 * An OrganisePlan turns one recipe's result into many playlists: the matched
 * tracks are grouped by up to one time dimension and one genre dimension, and
 * each group becomes a playlist named (and optionally foldered) by templates.
 * "My loves of the last two years, per month and genre, in a folder per year"
 * is `groupBy: ['likedMonth', 'genreFamily'], folder: '{year}',
 * name: '{year}-{month} {genre}'` over a `likedInDays: 730` recipe.
 */

export type TimeDim = 'likedMonth' | 'likedYear' | 'firstListenMonth' | 'firstListenYear';
export type GenreDim = 'genreFamily' | 'canonicalGenre';
export type GroupDim = TimeDim | GenreDim;

export const TIME_DIMS: readonly TimeDim[] = ['likedMonth', 'likedYear', 'firstListenMonth', 'firstListenYear'];
export const GENRE_DIMS: readonly GenreDim[] = ['genreFamily', 'canonicalGenre'];

export function isTimeDim(d: GroupDim): d is TimeDim {
  return (TIME_DIMS as readonly string[]).includes(d);
}

export function isGenreDim(d: GroupDim): d is GenreDim {
  return (GENRE_DIMS as readonly string[]).includes(d);
}

export interface OrganisePlan {
  /** Which tracks to organise. Its output limit is ignored: every match is grouped. */
  base: Recipe;
  /** At most one time dimension and at most one genre dimension. */
  groupBy: GroupDim[];
  /** Folder name template, e.g. '{year}'. Omit for no folders. */
  folder?: string;
  /** Playlist name template, e.g. '{year}-{month} {genre}'. Defaults from groupBy. */
  name?: string;
  /** Genre groups smaller than this fold into "Other" within the same time period. */
  minGroupSize?: number;
  /** Skip tracks already in a playlist on these services (or pushed by this app). */
  excludePlaylistedOn?: ServiceName[];
}

export interface TemplateValues {
  year?: string;
  month?: string;
  monthName?: string;
  genre?: string;
}

const TEMPLATE_VARS = ['year', 'month', 'monthName', 'genre'] as const;

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Substitutes `{var}`s; a variable with no value renders empty and spacing is tidied. */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template
    .replace(/\{(\w+)\}/g, (match, key: string) =>
      (TEMPLATE_VARS as readonly string[]).includes(key) ? (values[key as keyof TemplateValues] ?? '') : match,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Year/month template values for a timestamp (server-local time), at the dimension's precision. */
export function timeValues(epochSeconds: number, dim: TimeDim): TemplateValues {
  const d = new Date(epochSeconds * 1000);
  const year = String(d.getFullYear());
  if (dim === 'likedYear' || dim === 'firstListenYear') return { year };
  return { year, month: String(d.getMonth() + 1).padStart(2, '0'), monthName: MONTH_NAMES[d.getMonth()] };
}

/** The name template used when a plan doesn't give one, e.g. '{year}-{month} {genre}'. */
export function defaultNameTemplate(groupBy: GroupDim[]): string {
  return groupBy
    .map((d) => (isGenreDim(d) ? '{genre}' : d.endsWith('Month') ? '{year}-{month}' : '{year}'))
    .join(' ');
}

/**
 * Checks a plan from an API caller or assistant. Besides shape, the templates
 * must use only variables the grouping provides, and between them must name
 * every grouped dimension -- otherwise distinct groups would render to the
 * same playlist (e.g. per-month groups named only '{genre}').
 */
export function validateOrganisePlan(raw: unknown): { plan: OrganisePlan } | { error: string } {
  const p = raw as Partial<OrganisePlan> | undefined;
  if (!p?.base || !Array.isArray(p.base.filters) || !p.base.output) return { error: 'A valid base recipe is required.' };
  const groupBy = p.groupBy;
  if (!Array.isArray(groupBy) || groupBy.length === 0) return { error: 'groupBy needs at least one dimension.' };
  const known = [...TIME_DIMS, ...GENRE_DIMS] as string[];
  const unknown = groupBy.find((d) => !known.includes(d));
  if (unknown !== undefined) return { error: `Unknown groupBy dimension "${unknown}".` };
  if (groupBy.filter(isTimeDim).length > 1) return { error: 'groupBy can have at most one time dimension.' };
  if (groupBy.filter(isGenreDim).length > 1) return { error: 'groupBy can have at most one genre dimension.' };

  const name = p.name?.trim() || defaultNameTemplate(groupBy);
  const folder = p.folder?.trim() || undefined;
  const used = new Set([...`${folder ?? ''} ${name}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
  const time = groupBy.find(isTimeDim);
  const provided = new Set<string>(groupBy.some(isGenreDim) ? ['genre'] : []);
  if (time) provided.add('year');
  if (time?.endsWith('Month')) {
    provided.add('month');
    provided.add('monthName');
  }
  for (const v of used) {
    if (!(TEMPLATE_VARS as readonly string[]).includes(v)) return { error: `Unknown template variable {${v}}.` };
    if (!provided.has(v)) return { error: `Template variable {${v}} isn't provided by groupBy [${groupBy.join(', ')}].` };
  }
  if (groupBy.some(isGenreDim) && !used.has('genre')) return { error: 'The folder or name template must include {genre}.' };
  if (time && !used.has('year')) return { error: 'The folder or name template must include {year}.' };
  if (time?.endsWith('Month') && !used.has('month') && !used.has('monthName')) {
    return { error: 'The folder or name template must include {month} or {monthName}.' };
  }

  const minGroupSize = p.minGroupSize === undefined ? undefined : Math.max(1, Math.floor(Number(p.minGroupSize) || 1));
  const excludePlaylistedOn = (p.excludePlaylistedOn ?? []).filter((s): s is ServiceName => s === 'spotify' || s === 'tidal');
  return { plan: { base: p.base, groupBy, folder, name, minGroupSize, excludePlaylistedOn } };
}

/** JSON Schema for OrganisePlan, used as an MCP tool inputSchema. KEEP IN SYNC with the type above. */
export const ORGANISE_JSON_SCHEMA = {
  type: 'object',
  description:
    'Organises one recipe\'s tracks into many playlists, grouped by time and/or genre, optionally in folders. ' +
    'Example — "my loved tracks from the last two years as per-month, per-genre playlists in a folder per year" => ' +
    '{"base":{"filters":[{"type":"likedInDays","days":730}],"output":{"mode":"tracks","sort":"oldest_first_listen","limit":50}},' +
    '"groupBy":["likedMonth","genreFamily"],"folder":"{year}","name":"{year}-{month} {genre}","minGroupSize":5}',
  properties: {
    base: { ...RECIPE_JSON_SCHEMA, description: 'Recipe selecting the tracks to organise. Its output.limit is ignored: every match is grouped.' },
    groupBy: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', enum: [...TIME_DIMS, ...GENRE_DIMS] },
      description:
        'Grouping dimensions, at most one time and one genre. likedMonth/likedYear: when the track was liked ' +
        '(latest like across services; an undated like counts as the track\'s first play). ' +
        'firstListenMonth/firstListenYear: when it was first played. genreFamily: broad family (metal, rock, ...); ' +
        'canonicalGenre: the artist\'s top genre (finer, more playlists).',
    },
    folder: {
      type: 'string',
      description:
        'Folder name template, e.g. "{year}". Omit for no folders. Neither Spotify nor TIDAL lets this app create ' +
        'folders, so on the service the folder becomes part of the name: kept as is when the name already contains it, ' +
        'else prefixed ("2025 · March Metal").',
    },
    name: {
      type: 'string',
      description:
        'Playlist name template. Variables: {year}, {month} (01-12), {monthName}, {genre}. Folder and name together must ' +
        'mention every grouped dimension. Defaults to e.g. "{year}-{month} {genre}".',
    },
    minGroupSize: {
      type: 'integer',
      minimum: 1,
      description: 'Genre groups with fewer tracks fold into an "Other" playlist for the same period. 5 is a good default.',
    },
    excludePlaylistedOn: {
      type: 'array',
      items: { type: 'string', enum: ['spotify', 'tidal'] },
      description: 'Skip tracks already in one of your playlists on these services.',
    },
  },
  required: ['base', 'groupBy'],
} as const;
