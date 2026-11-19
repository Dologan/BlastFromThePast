-- The folder a pushed playlist was filed in (NULL: none). Organised pushes can
-- reuse a playlist name across folders ('March Metal' under both '2024' and
-- '2025'), so "does this playlist already exist?" matches on name AND folder.
ALTER TABLE playlist_log ADD COLUMN folder TEXT;
