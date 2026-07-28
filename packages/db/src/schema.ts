import {
  sqliteTable,
  integer,
  text,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const artists = sqliteTable(
  'artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    mbid: text('mbid'),
    country: text('country'),
    enrichStatus: text('enrich_status').notNull().default('pending'),
    enrichedAt: integer('enriched_at'),
  },
  (t) => [uniqueIndex('artists_name_normalized_unique').on(t.nameNormalized)],
);

export const albums = sqliteTable(
  'albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    mbid: text('mbid'),
    releaseDate: text('release_date'),
    releaseDateStatus: text('release_date_status').notNull().default('pending'),
  },
  (t) => [uniqueIndex('albums_artist_name_unique').on(t.artistId, t.nameNormalized)],
);

export const tracks = sqliteTable(
  'tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    mbid: text('mbid'),
    isrc: text('isrc'),
  },
  (t) => [uniqueIndex('tracks_artist_name_unique').on(t.artistId, t.nameNormalized)],
);

export const scrobbles = sqliteTable(
  'scrobbles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id),
    albumId: integer('album_id').references(() => albums.id),
    uts: integer('uts').notNull(),
  },
  (t) => [
    uniqueIndex('scrobbles_track_uts_unique').on(t.trackId, t.uts),
    index('idx_scrobbles_uts').on(t.uts),
    index('idx_scrobbles_album').on(t.albumId),
  ],
);

export const likedTracks = sqliteTable(
  'liked_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id),
    source: text('source').notNull(), // 'lastfm' | 'spotify' | 'tidal'
    likedAt: integer('liked_at'),
    /** Exempts this track from bulk "unlike" cleanup even if rarely played. */
    protected: integer('protected').notNull().default(0),
  },
  (t) => [uniqueIndex('liked_tracks_track_source_unique').on(t.trackId, t.source)],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

export const artistTags = sqliteTable(
  'artist_tags',
  {
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id),
    source: text('source').notNull(),
    weight: integer('weight').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.artistId, t.tagId, t.source] })],
);

export const trackTags = sqliteTable(
  'track_tags',
  {
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id),
    source: text('source').notNull(),
    weight: integer('weight').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.trackId, t.tagId, t.source] })],
);

export const genreRules = sqliteTable('genre_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull(),
  genre: text('genre').notNull(),
  parent: text('parent'),
});

export const serviceLinks = sqliteTable(
  'service_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id').notNull(),
    service: text('service').notNull(),
    serviceId: text('service_id').notNull(),
    method: text('method').notNull(),
    confidence: real('confidence').notNull().default(0),
    verified: integer('verified').notNull().default(0),
    matchedAt: integer('matched_at').notNull(),
  },
  (t) => [uniqueIndex('service_links_entity_service_unique').on(t.entityType, t.entityId, t.service)],
);

export const trackStats = sqliteTable(
  'track_stats',
  {
    trackId: integer('track_id')
      .primaryKey()
      .references(() => tracks.id),
    firstListen: integer('first_listen').notNull(),
    lastListen: integer('last_listen').notNull(),
    playcount: integer('playcount').notNull(),
    peakMonth: text('peak_month').notNull(),
    peakMonthCount: integer('peak_month_count').notNull(),
    /** Widest gap between two consecutive plays, in days; NULL if fewer than 2 plays. */
    maxGapDays: real('max_gap_days'),
  },
  (t) => [
    index('idx_track_stats_first').on(t.firstListen),
    index('idx_track_stats_last').on(t.lastListen),
    index('idx_track_stats_count').on(t.playcount),
  ],
);

export const albumStats = sqliteTable('album_stats', {
  albumId: integer('album_id')
    .primaryKey()
    .references(() => albums.id),
  firstListen: integer('first_listen').notNull(),
  lastListen: integer('last_listen').notNull(),
  playcount: integer('playcount').notNull(),
  peakMonth: text('peak_month').notNull(),
  peakMonthCount: integer('peak_month_count').notNull(),
  maxGapDays: real('max_gap_days'),
});

export const artistStats = sqliteTable('artist_stats', {
  artistId: integer('artist_id')
    .primaryKey()
    .references(() => artists.id),
  firstListen: integer('first_listen').notNull(),
  lastListen: integer('last_listen').notNull(),
  playcount: integer('playcount').notNull(),
  peakMonth: text('peak_month').notNull(),
  peakMonthCount: integer('peak_month_count').notNull(),
});

export const mbSearchCache = sqliteTable('mb_search_cache', {
  queryNormalized: text('query_normalized').primaryKey(),
  mbid: text('mbid'),
  score: real('score'),
  country: text('country'),
  fetchedAt: integer('fetched_at').notNull(),
});

export const mbArtistCache = sqliteTable('mb_artist_cache', {
  mbid: text('mbid').primaryKey(),
  found: integer('found').notNull(),
  country: text('country'),
  genresJson: text('genres_json').notNull().default('[]'),
  tagsJson: text('tags_json').notNull().default('[]'),
  fetchedAt: integer('fetched_at').notNull(),
});

export const lastfmTagsCache = sqliteTable('lastfm_tags_cache', {
  cacheKey: text('cache_key').primaryKey(),
  tagsJson: text('tags_json').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

export const mbReleaseSearchCache = sqliteTable('mb_release_search_cache', {
  queryNormalized: text('query_normalized').primaryKey(),
  mbid: text('mbid'),
  score: real('score'),
  fetchedAt: integer('fetched_at').notNull(),
});

export const mbReleaseGroupCache = sqliteTable('mb_release_group_cache', {
  mbid: text('mbid').primaryKey(),
  found: integer('found').notNull(),
  releaseDate: text('release_date'),
  fetchedAt: integer('fetched_at').notNull(),
});

export const syncState = sqliteTable('sync_state', {
  source: text('source').primaryKey(),
  cursor: text('cursor'),
  status: text('status').notNull().default('idle'),
  error: text('error'),
  lastSyncedAt: integer('last_synced_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const serviceAuth = sqliteTable('service_auth', {
  service: text('service').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at').notNull(),
  scope: text('scope'),
  updatedAt: integer('updated_at').notNull(),
});

export const recipes = sqliteTable('recipes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  definition: text('definition').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const playlistLog = sqliteTable('playlist_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull(),
  servicePlaylistId: text('service_playlist_id').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const playlistLogTracks = sqliteTable(
  'playlist_log_tracks',
  {
    playlistLogId: integer('playlist_log_id')
      .notNull()
      .references(() => playlistLog.id),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id),
  },
  (t) => [primaryKey({ columns: [t.playlistLogId, t.trackId] })],
);

/** A user's actual playlists on a streaming service, pulled by the playlist-inventory sync
 * (distinct from playlist_log, which only tracks playlists this app itself pushed to). */
export const servicePlaylists = sqliteTable(
  'service_playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    service: text('service').notNull(),
    servicePlaylistId: text('service_playlist_id').notNull(),
    name: text('name').notNull(),
    isOwn: integer('is_own').notNull().default(1),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [uniqueIndex('service_playlists_service_id_unique').on(t.service, t.servicePlaylistId)],
);

export const servicePlaylistTracks = sqliteTable(
  'service_playlist_tracks',
  {
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => servicePlaylists.id),
    serviceTrackId: text('service_track_id').notNull(),
    trackId: integer('track_id').references(() => tracks.id),
    rawName: text('raw_name'),
    rawArtist: text('raw_artist'),
  },
  (t) => [primaryKey({ columns: [t.playlistId, t.serviceTrackId] })],
);
