-- Raw external-API response cache, decoupled from the normalized artists/
-- artist_tags schema. Enrichment always writes here before deriving into the
-- normalized tables, so re-deriving after a schema or parsing-logic change
-- never needs to re-hit MusicBrainz/Last.fm -- only genuinely new artists
-- cost network time. See Enrichment.reprocessAll() in apps/server.

-- One row per artist-name query we've sent to MusicBrainz's artist search.
-- mbid/score/country are all NULL when the search found no candidate --
-- that's still a cached result, not a missing one.
CREATE TABLE mb_search_cache (
  query_normalized TEXT PRIMARY KEY,
  mbid TEXT,
  score REAL,
  country TEXT,
  fetched_at INTEGER NOT NULL
);

-- One row per MusicBrainz artist MBID we've looked up. found=0 means a
-- confirmed 404 (a merged/deleted MBID), distinct from "never looked up".
CREATE TABLE mb_artist_cache (
  mbid TEXT PRIMARY KEY,
  found INTEGER NOT NULL,
  country TEXT,
  genres_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER NOT NULL
);

-- Keyed by mbid when the artist had one at fetch time, else by normalized
-- name (prefixed to avoid colliding with a real mbid string).
CREATE TABLE lastfm_tags_cache (
  cache_key TEXT PRIMARY KEY,
  tags_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
