-- Seed genre_rules: canonical genres, subgenre -> parent hierarchy, and common
-- aliases. This lets the (Phase 3) filter engine answer "does this artist
-- belong to genre G?" for both general genres (metal) and specific ones
-- (progressive metal). The intended matching semantics:
--
--   canonical(tag) = genre of the first rule whose lowercased `pattern` matches
--     the tag (glob, '*' = any run of chars); otherwise the tag itself.
--   An artist matches target T if any of its tags has canonical(tag) == T, or
--     T appears in canonical(tag)'s parent chain, or (fallback) the tag
--     word-contains T. The word-contains fallback already covers most
--     "<x> metal" -> metal cases, so rules here focus on hierarchy, on
--     subgenres whose name does NOT contain the parent, and on aliases.
--
-- Everything is user-editable at runtime.

-- Top-level genres (parent = NULL).
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('metal', 'metal', NULL),
  ('rock', 'rock', NULL),
  ('punk', 'punk', NULL),
  ('pop', 'pop', NULL),
  ('electronic', 'electronic', NULL),
  ('hip hop', 'hip hop', NULL),
  ('jazz', 'jazz', NULL),
  ('blues', 'blues', NULL),
  ('folk', 'folk', NULL),
  ('country', 'country', NULL),
  ('classical', 'classical', NULL),
  ('r&b', 'r&b', NULL),
  ('soul', 'soul', NULL),
  ('funk', 'funk', NULL),
  ('reggae', 'reggae', NULL),
  ('experimental', 'experimental', NULL);

-- Metal subgenres.
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('heavy metal', 'heavy metal', 'metal'),
  ('thrash metal', 'thrash metal', 'metal'),
  ('death metal', 'death metal', 'metal'),
  ('melodic death metal', 'melodic death metal', 'death metal'),
  ('black metal', 'black metal', 'metal'),
  ('doom metal', 'doom metal', 'metal'),
  ('power metal', 'power metal', 'metal'),
  ('progressive metal', 'progressive metal', 'metal'),
  ('folk metal', 'folk metal', 'metal'),
  ('sludge metal', 'sludge metal', 'metal'),
  ('gothic metal', 'gothic metal', 'metal'),
  ('symphonic metal', 'symphonic metal', 'metal'),
  ('nu metal', 'nu metal', 'metal'),
  ('groove metal', 'groove metal', 'metal'),
  ('speed metal', 'speed metal', 'metal'),
  ('metalcore', 'metalcore', 'metal'),
  ('deathcore', 'deathcore', 'metal'),
  ('grindcore', 'grindcore', 'metal'),
  ('djent', 'djent', 'progressive metal');

-- Rock subgenres.
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('classic rock', 'classic rock', 'rock'),
  ('hard rock', 'hard rock', 'rock'),
  ('progressive rock', 'progressive rock', 'rock'),
  ('psychedelic rock', 'psychedelic rock', 'rock'),
  ('indie rock', 'indie rock', 'rock'),
  ('alternative rock', 'alternative rock', 'rock'),
  ('post-rock', 'post-rock', 'rock'),
  ('art rock', 'art rock', 'rock'),
  ('garage rock', 'garage rock', 'rock'),
  ('math rock', 'math rock', 'rock'),
  ('stoner rock', 'stoner rock', 'rock'),
  ('soft rock', 'soft rock', 'rock'),
  ('grunge', 'grunge', 'rock'),
  ('britpop', 'britpop', 'rock'),
  ('shoegaze', 'shoegaze', 'rock'),
  ('emo', 'emo', 'rock');

-- Punk subgenres.
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('hardcore punk', 'hardcore punk', 'punk'),
  ('post-punk', 'post-punk', 'punk'),
  ('pop punk', 'pop punk', 'punk'),
  ('skate punk', 'skate punk', 'punk'),
  ('punk rock', 'punk rock', 'punk');

-- Electronic subgenres.
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('techno', 'techno', 'electronic'),
  ('house', 'house', 'electronic'),
  ('trance', 'trance', 'electronic'),
  ('drum and bass', 'drum and bass', 'electronic'),
  ('dubstep', 'dubstep', 'electronic'),
  ('idm', 'idm', 'electronic'),
  ('ambient', 'ambient', 'electronic'),
  ('synthwave', 'synthwave', 'electronic'),
  ('downtempo', 'downtempo', 'electronic'),
  ('trip hop', 'trip hop', 'electronic'),
  ('breakbeat', 'breakbeat', 'electronic'),
  ('electronica', 'electronica', 'electronic');

-- Hip hop subgenres.
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('rap', 'rap', 'hip hop'),
  ('trap', 'trap', 'hip hop'),
  ('boom bap', 'boom bap', 'hip hop'),
  ('gangsta rap', 'gangsta rap', 'hip hop');

-- Aliases (spelling / abbreviation variants -> canonical genre).
INSERT INTO genre_rules (pattern, genre, parent) VALUES
  ('prog rock', 'progressive rock', 'rock'),
  ('prog metal', 'progressive metal', 'metal'),
  ('psych rock', 'psychedelic rock', 'rock'),
  ('alt rock', 'alternative rock', 'rock'),
  ('post rock', 'post-rock', 'rock'),
  ('post punk', 'post-punk', 'punk'),
  ('hip-hop', 'hip hop', NULL),
  ('rnb', 'r&b', NULL),
  ('dnb', 'drum and bass', 'electronic'),
  ('d&b', 'drum and bass', 'electronic');
