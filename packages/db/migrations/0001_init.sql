CREATE TABLE artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL UNIQUE,
  mbid TEXT,
  country TEXT,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  enriched_at INTEGER
);

CREATE TABLE albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  mbid TEXT,
  UNIQUE(artist_id, name_normalized)
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  mbid TEXT,
  isrc TEXT,
  UNIQUE(artist_id, name_normalized)
);

-- A scrobble references the track (identity = artist + track name) and,
-- separately, the album it was scrobbled under (a track can appear on many albums).
CREATE TABLE scrobbles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  album_id INTEGER REFERENCES albums(id),
  uts INTEGER NOT NULL,
  UNIQUE(track_id, uts)
);
CREATE INDEX idx_scrobbles_uts ON scrobbles(uts);
CREATE INDEX idx_scrobbles_album ON scrobbles(album_id);

CREATE TABLE liked_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  source TEXT NOT NULL, -- 'lastfm' | 'spotify'
  liked_at INTEGER,
  UNIQUE(track_id, source)
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE artist_tags (
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  source TEXT NOT NULL, -- 'lastfm' | 'musicbrainz'
  weight INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artist_id, tag_id, source)
);

CREATE TABLE track_tags (
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  source TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, tag_id, source)
);

-- Maps raw tag patterns to canonical genres and optional parent genre,
-- enabling "metal" to match "progressive metal" etc. Seeded, user-editable.
CREATE TABLE genre_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,        -- e.g. '*metal', 'shoegaze'
  genre TEXT NOT NULL,          -- canonical genre this pattern maps to
  parent TEXT                   -- optional parent genre ('progressive metal' -> 'metal')
);

CREATE TABLE service_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,    -- 'track' | 'album' | 'artist'
  entity_id INTEGER NOT NULL,
  service TEXT NOT NULL,        -- 'spotify' | 'tidal'
  service_id TEXT NOT NULL,
  method TEXT NOT NULL,         -- 'isrc' | 'search' | 'manual'
  confidence REAL NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  matched_at INTEGER NOT NULL,
  UNIQUE(entity_type, entity_id, service)
);

CREATE TABLE track_stats (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id),
  first_listen INTEGER NOT NULL,
  last_listen INTEGER NOT NULL,
  playcount INTEGER NOT NULL,
  peak_month TEXT NOT NULL,     -- 'YYYY-MM' with the most plays
  peak_month_count INTEGER NOT NULL
);
CREATE INDEX idx_track_stats_first ON track_stats(first_listen);
CREATE INDEX idx_track_stats_last ON track_stats(last_listen);
CREATE INDEX idx_track_stats_count ON track_stats(playcount);

CREATE TABLE album_stats (
  album_id INTEGER PRIMARY KEY REFERENCES albums(id),
  first_listen INTEGER NOT NULL,
  last_listen INTEGER NOT NULL,
  playcount INTEGER NOT NULL,
  peak_month TEXT NOT NULL,
  peak_month_count INTEGER NOT NULL
);

CREATE TABLE artist_stats (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id),
  first_listen INTEGER NOT NULL,
  last_listen INTEGER NOT NULL,
  playcount INTEGER NOT NULL,
  peak_month TEXT NOT NULL,
  peak_month_count INTEGER NOT NULL
);

CREATE TABLE sync_state (
  source TEXT PRIMARY KEY,      -- 'lastfm:scrobbles' | 'lastfm:loved' | 'spotify:liked' | ...
  cursor TEXT,                  -- JSON checkpoint, source-specific
  status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'running' | 'error'
  error TEXT,
  last_synced_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,     -- JSON filter AST
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  service_playlist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE playlist_log_tracks (
  playlist_log_id INTEGER NOT NULL REFERENCES playlist_log(id),
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  PRIMARY KEY (playlist_log_id, track_id)
);
