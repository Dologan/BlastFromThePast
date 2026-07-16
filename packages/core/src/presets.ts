import type { Recipe } from './recipe.js';

export interface Preset {
  id: string;
  name: string;
  description: string;
  definition: Recipe;
}

/**
 * Built-in recipe templates offered as starting points in the builder. They're
 * plain Recipes; loading one just populates the builder, which the user can
 * then tweak and save. A couple are intentionally incomplete (e.g. genre left
 * blank) as a prompt to fill in.
 */
export const PRESETS: Preset[] = [
  {
    id: 'forgotten-favourites',
    name: 'Forgotten favourites',
    description: "Tracks you played a lot but haven't touched in two years.",
    definition: {
      filters: [
        { type: 'playcount', min: 15 },
        { type: 'notPlayedInDays', days: 730 },
      ],
      output: { mode: 'tracks', sort: 'neglect', limit: 50, perArtistCap: 2 },
    },
  },
  {
    id: 'on-this-day',
    name: 'On this day',
    description: 'Music you first discovered around this date in past years.',
    definition: {
      filters: [{ type: 'anniversary', field: 'firstListen', windowDays: 3 }],
      output: { mode: 'tracks', sort: 'playcount_desc', limit: 50 },
    },
  },
  {
    id: 'deep-cuts',
    name: 'Deep cuts of a genre',
    description: 'Pick a genre — lesser-played tracks you loved but let slip.',
    definition: {
      filters: [
        { type: 'genre', anyOf: [], mode: 'canonical' },
        { type: 'playcount', min: 3, max: 15 },
        { type: 'notPlayedInDays', days: 365 },
      ],
      output: { mode: 'tracks', sort: 'weighted_random', limit: 40, perArtistCap: 2 },
    },
  },
  {
    id: 'long-lost-loves',
    name: 'Long-lost loves',
    description: "Tracks you marked loved but haven't played in ages.",
    definition: {
      filters: [
        { type: 'loved' },
        { type: 'notPlayedInDays', days: 540 },
      ],
      output: { mode: 'tracks', sort: 'neglect', limit: 50 },
    },
  },
  {
    id: 'album-rediscovery',
    name: 'Album rediscovery',
    description: 'Whole albums you once played through but have neglected.',
    definition: {
      filters: [
        { type: 'playcount', min: 20 },
        { type: 'notPlayedInDays', days: 730 },
      ],
      output: { mode: 'albums', sort: 'neglect', limit: 30, perArtistCap: 1 },
    },
  },
];
