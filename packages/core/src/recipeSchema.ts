/**
 * JSON Schema for the Recipe AST, used as the MCP tool inputSchema (and as
 * reference documentation for other agents, e.g. the OpenClaw skill). This is
 * the bridge that lets an assistant LLM translate natural language into a
 * structured recipe, so the per-field descriptions carry the semantics and
 * unit conventions an LLM needs to fill it correctly.
 *
 * KEEP IN SYNC with the authoritative TypeScript types in ./recipe.ts — the
 * two files are deliberately adjacent so drift is visible in review.
 */

const days = (what: string) => ({
  type: 'integer',
  minimum: 1,
  description: `${what}, in days. Convert spoken units: a week=7, a month=30, a year=365 (e.g. "5 years"=1825).`,
});

const isoDate = (bound: string) => ({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: `${bound} (inclusive), ISO date YYYY-MM-DD.`,
});

export const RECIPE_JSON_SCHEMA = {
  type: 'object',
  description:
    'A playlist recipe: filters are ANDed together; list values inside one clause are ORed. ' +
    'Example — "metal I have not played in 5 years with more than 10 plays" => ' +
    '{"filters":[{"type":"genre","anyOf":["metal"]},{"type":"notPlayedInDays","days":1825},{"type":"playcount","min":10}],' +
    '"output":{"mode":"tracks","sort":"weighted_random","limit":50}}',
  properties: {
    filters: {
      type: 'array',
      description: 'Zero or more filter clauses, ANDed together. An empty array matches the whole library.',
      items: {
        oneOf: [
          {
            type: 'object',
            description:
              'Genre filter. Values are canonical genre names (lowercase, e.g. "metal", "progressive metal"); ' +
              'canonical mode also matches all subgenres (metal matches death metal etc.). ' +
              'Use get_context to see which genres exist in the library. negate=true EXCLUDES the genres instead.',
            properties: {
              type: { const: 'genre' },
              anyOf: { type: 'array', items: { type: 'string' }, minItems: 1 },
              mode: { enum: ['canonical', 'raw'], description: 'canonical (default) expands subgenres; raw matches the exact tag only.' },
              negate: { type: 'boolean' },
            },
            required: ['type', 'anyOf'],
          },
          {
            type: 'object',
            description:
              'Artist country-of-origin filter, ISO 3166-1 alpha-2 codes (e.g. "SE" for Sweden). negate=true excludes them.',
            properties: {
              type: { const: 'country' },
              anyOf: { type: 'array', items: { type: 'string' }, minItems: 1 },
              negate: { type: 'boolean' },
            },
            required: ['type', 'anyOf'],
          },
          {
            type: 'object',
            description: 'Not played recently — the core "forgotten music" filter.',
            properties: { type: { const: 'notPlayedInDays' }, days: days('Minimum silence since the last play') },
            required: ['type', 'days'],
          },
          {
            type: 'object',
            description: 'Played recently (the opposite of notPlayedInDays).',
            properties: { type: { const: 'playedInDays' }, days: days('Maximum time since the last play') },
            required: ['type', 'days'],
          },
          {
            type: 'object',
            description: 'Total play-count range. "more than 10 plays" => min: 10.',
            properties: {
              type: { const: 'playcount' },
              min: { type: 'integer', minimum: 0 },
              max: { type: 'integer', minimum: 0 },
            },
            required: ['type'],
          },
          {
            type: 'object',
            description: 'Only loved/liked items (Last.fm loved, Spotify liked, or TIDAL liked; omit source for any).',
            properties: { type: { const: 'loved' }, source: { enum: ['lastfm', 'spotify', 'tidal'] } },
            required: ['type'],
          },
          {
            type: 'object',
            description: 'First listened within a date range ("music I discovered in 2014" => after 2014-01-01, before 2014-12-31).',
            properties: { type: { const: 'firstListen' }, after: isoDate('Earliest first listen'), before: isoDate('Latest first listen') },
            required: ['type'],
          },
          {
            type: 'object',
            description: 'Last listened within a date range.',
            properties: { type: { const: 'lastListen' }, after: isoDate('Earliest last listen'), before: isoDate('Latest last listen') },
            required: ['type'],
          },
          {
            type: 'object',
            description: 'Peak listening period (the month with the most plays) fell within a date range.',
            properties: { type: { const: 'peakMonth' }, after: isoDate('Earliest peak'), before: isoDate('Latest peak') },
            required: ['type'],
          },
          {
            type: 'object',
            description: 'First/last listen falls within N days of today, in any past year ("on this day" anniversaries).',
            properties: {
              type: { const: 'anniversary' },
              field: { enum: ['firstListen', 'lastListen'], description: 'Which listen to match (default firstListen).' },
              windowDays: { type: 'integer', minimum: 0, description: 'Calendar-day tolerance around today.' },
            },
            required: ['type', 'windowDays'],
          },
          {
            type: 'object',
            description:
              'Gap between consecutive plays. min/maxDays bound the widest historical (bridged) gap; ' +
              'infinite=true instead matches items whose CURRENT silence already exceeds every past gap (never returned to).',
            properties: {
              type: { const: 'gapDays' },
              minDays: { type: 'integer', minimum: 0 },
              maxDays: { type: 'integer', minimum: 0 },
              infinite: { type: 'boolean' },
            },
            required: ['type'],
          },
          {
            type: 'object',
            description: 'Exclude anything already pushed to a playlist in the last N days (avoids repeats across generated playlists).',
            properties: { type: { const: 'excludeRecentlyPlaylisted' }, days: days('Look-back window') },
            required: ['type', 'days'],
          },
        ],
      },
    },
    output: {
      type: 'object',
      description: 'How to shape the result set.',
      properties: {
        mode: {
          enum: ['tracks', 'albums'],
          description: 'tracks builds a track playlist (use this for playlist pushes); albums picks whole albums.',
        },
        sort: {
          enum: ['weighted_random', 'neglect', 'playcount_desc', 'playcount_asc', 'recent', 'oldest_first_listen', 'random'],
          description:
            'weighted_random: shuffle favouring favourites (good playlist default). neglect: most-played-longest-ago first. ' +
            'playcount_desc/asc, recent (last played), oldest_first_listen, random are self-explanatory.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max results (50 is a good playlist default).' },
        perArtistCap: { type: 'integer', minimum: 1, description: 'Optional diversity cap: at most N results per artist (2-3 recommended).' },
      },
      required: ['mode', 'sort', 'limit'],
    },
  },
  required: ['filters', 'output'],
} as const;
