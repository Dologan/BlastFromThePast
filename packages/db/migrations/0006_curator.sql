-- Curator: playlist inventory (which service playlists already contain which
-- library tracks, for exclusion) and a protect flag on loved tracks (exempts
-- a track from bulk "unlike" cleanup even if it's rarely played).
CREATE TABLE service_playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,               -- 'spotify' | 'tidal'
  service_playlist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_own INTEGER NOT NULL DEFAULT 1,
  fetched_at INTEGER NOT NULL,
  UNIQUE(service, service_playlist_id)
);

CREATE TABLE service_playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES service_playlists(id) ON DELETE CASCADE,
  service_track_id TEXT NOT NULL,
  track_id INTEGER REFERENCES tracks(id),  -- NULL when unmatched to the library
  raw_name TEXT, raw_artist TEXT,          -- diagnostics for unmatched rows
  PRIMARY KEY (playlist_id, service_track_id)
);
CREATE INDEX idx_spt_track ON service_playlist_tracks(track_id);

ALTER TABLE liked_tracks ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
