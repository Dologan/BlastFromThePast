-- Album release-date enrichment, mirroring the artist enrichment pattern in
-- 0003_enrichment_cache.sql: raw MusicBrainz responses cached separately from
-- the normalized column they derive, so reprocessAll() never needs to re-hit
-- MusicBrainz after a parsing/schema change.

-- release_date is the raw MusicBrainz release-group date, partial precision:
-- '1998' | '1998-03' | '1998-03-17'. release_date_status mirrors
-- artists.enrich_status ('pending' | 'done' | 'error').
ALTER TABLE albums ADD COLUMN release_date TEXT;
ALTER TABLE albums ADD COLUMN release_date_status TEXT NOT NULL DEFAULT 'pending';

-- One row per artist+album query sent to MusicBrainz's release-group search
-- (only needed when the album has no mbid already). mbid is NULL when no
-- candidate was found -- that's still a cached result, not a missing one.
CREATE TABLE mb_release_search_cache (
  query_normalized TEXT PRIMARY KEY,
  mbid TEXT,
  score REAL,
  fetched_at INTEGER NOT NULL
);

-- One row per release-group MBID looked up. found=0 means a confirmed 404.
CREATE TABLE mb_release_group_cache (
  mbid TEXT PRIMARY KEY,
  found INTEGER NOT NULL,
  release_date TEXT,
  fetched_at INTEGER NOT NULL
);
