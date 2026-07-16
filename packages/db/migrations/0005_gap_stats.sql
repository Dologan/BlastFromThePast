-- Widest gap between two consecutive plays (in days), NULL if the entity
-- has fewer than 2 plays (no bridged gap exists yet). Powers the "gap
-- between plays" recipe filter and the dashboard's ongoing-gaps insight.
ALTER TABLE track_stats ADD COLUMN max_gap_days REAL;
ALTER TABLE album_stats ADD COLUMN max_gap_days REAL;
