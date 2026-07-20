import type { Recipe } from './recipeTypes';

export type ServiceName = 'spotify' | 'tidal';

export interface Settings {
  lastfmUsername: string | null;
  lastfmApiKeySet: boolean;
  spotifyClientId: string | null;
  tidalClientId: string | null;
  tidalCountryCode: string;
  defaultService: ServiceName | null;
}

export interface AuthStatus {
  spotify: { connected: boolean; clientIdSet: boolean };
  tidal: { connected: boolean; clientIdSet: boolean };
}

export interface UnmatchedTrack {
  trackId: number;
  name: string;
  artistName: string;
}

export interface PushResult {
  playlistId: string;
  playlistUrl: string;
  service: ServiceName;
  matchedCount: number;
  unmatched: UnmatchedTrack[];
  lowConfidence: UnmatchedTrack[];
  matchError?: string;
  itemsError?: string;
  skippedDuplicates?: number;
}

export type PushMode = 'new' | 'replace' | 'append';

export interface ExistingPlaylist {
  playlistId: string;
  playlistUrl: string;
  createdAt: number;
}

export interface PreviewRow {
  entityId: number;
  entityKind: 'track' | 'album';
  name: string;
  artistName: string;
  albumName: string | null;
  playcount: number;
  firstListen: number;
  lastListen: number;
  spotifyUrl: string;
  tidalUrl: string;
}

export interface PreviewResult {
  matched: number;
  rows: PreviewRow[];
}

export interface SavedRecipe {
  id: number;
  name: string;
  definition: Recipe;
  createdAt: number;
  updatedAt: number;
}

export interface Facets {
  countries: string[];
  genres: string[];
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  definition: Recipe;
}

export interface Candidate {
  serviceId: string;
  name: string;
  artistName: string;
  albumName?: string;
}

export type OverrideAction = 'added' | 'replaced' | 'unchanged' | 'savedOnly';

export interface OverrideResult {
  action: OverrideAction;
  /** Set if the match was saved but the live playlist couldn't be updated (e.g. a transient service error). */
  playlistError?: string;
}

export interface SyncProgress {
  phase: 'scrobbles' | 'loved' | 'stats';
  page?: number;
  totalPages?: number;
  inserted: number;
}

export type EnrichProgress =
  | {
      kind: 'enrich';
      phase: 'fetch';
      mbProcessed: number;
      mbTotal: number;
      lastfmProcessed: number;
      lastfmTotal: number;
    }
  | { kind: 'enrich'; phase: 'derive'; processed: number; total: number };

export interface ServiceLikedProgress {
  kind: 'service-liked';
  source: 'spotify' | 'tidal';
  seen: number;
  linked: number;
}

export interface PushProgress {
  kind: 'push';
  matched: number;
  processed: number;
  total: number;
}

export interface PlaylistInventoryProgress {
  kind: 'playlist-inventory';
  service: ServiceName;
  playlistsDone: number;
  playlistsTotal: number;
}

export interface CuratePushProgress {
  kind: 'curate';
  playlistsDone: number;
  playlistsTotal: number;
  currentName: string;
  matched: number;
  processed: number;
  total: number;
}

export interface UnlikeProgress {
  kind: 'unlike';
  processed: number;
  total: number;
}

export type JobProgress =
  | SyncProgress
  | EnrichProgress
  | ServiceLikedProgress
  | PushProgress
  | PlaylistInventoryProgress
  | CuratePushProgress
  | UnlikeProgress;

export interface SyncStatus {
  running: boolean;
  job: string | null;
  progress: JobProgress | null;
  error: string | null;
  finishedAt: number | null;
  sources: { source: string; status: string; error: string | null; lastSyncedAt: number | null }[];
}

export interface NamedWeight {
  name: string;
  weight: number;
}

export type InsightKind = 'tracks' | 'albums' | 'artists';

/** Singular per-entity kind, as used by resolveDeepLinks (vs InsightKind's plural). */
export type LinkEntityKind = 'track' | 'album' | 'artist';

export function insightKindToLinkKind(kind: InsightKind): LinkEntityKind {
  return kind === 'tracks' ? 'track' : kind === 'albums' ? 'album' : 'artist';
}

interface DeepLinks {
  spotifyUrl: string;
  tidalUrl: string;
}

export interface GapRow extends DeepLinks {
  entityId: number;
  name: string;
  /** Null for the 'artists' kind, where the entity itself is the artist. */
  artistName: string | null;
  playcount: number;
  lastListen: number;
  /** How long it's been silent so far — an open-ended, still-running gap. */
  gapSeconds: number;
}

export interface NeglectedGemRow extends DeepLinks {
  entityId: number;
  name: string;
  artistName: string | null;
  playcount: number;
  lastListen: number;
  liked: boolean;
}

export interface OnThisDayRow extends DeepLinks {
  entityId: number;
  name: string;
  artistName: string | null;
  playcount: number;
  matched: 'first' | 'last';
  matchedAt: number;
}

export interface Insights {
  kind: InsightKind;
  limit: number;
  gaps: GapRow[];
  neglectedGems: NeglectedGemRow[];
  onThisDay: OnThisDayRow[];
}

export type TopArtistsRange = 'all' | 'week' | 'month' | 'year';

export interface TopArtistRow extends DeepLinks {
  entityId: number;
  name: string;
  playcount: number;
}

export interface TopArtists {
  range: TopArtistsRange;
  limit: number;
  artists: TopArtistRow[];
}

export interface LibrarySummary {
  scrobbles: number;
  tracks: number;
  albums: number;
  artists: number;
  liked: number;
  firstScrobble: number | null;
  lastScrobble: number | null;
  enrichment: { enriched: number; pending: number; errored: number; withCountry: number };
  cache: { mbSearches: number; mbArtists: number; lastfmTags: number };
  topGenres: NamedWeight[];
  topCountries: NamedWeight[];
}

export interface PlaylistInventoryEntry {
  playlists: number;
  tracks: number;
  matchedTracks: number;
  fetchedAt: number;
}

export type PlaylistInventory = Partial<Record<ServiceName, PlaylistInventoryEntry>>;

export type GroupBy = 'genreFamily' | 'canonicalGenre';

export interface CurateGroup {
  key: string;
  name: string;
  count: number;
  entityIds: number[];
  sample: string[];
}

export interface CuratePreviewResult {
  totalMatched: number;
  excluded: number;
  groups: CurateGroup[];
}

export interface CuratePreviewRequest {
  base: Recipe;
  groupBy: GroupBy;
  excludePlaylistedOn?: ServiceName[];
  minGroupSize?: number;
  namePrefix?: string;
}

export interface CuratePushPlaylistRequest {
  name: string;
  trackIds: number[];
}

export type OnExisting = 'skip' | 'replace' | 'append';

export type CuratePushOutcome = (PushResult & { skipped?: undefined }) | { skipped: true; name: string };

export type LikedSource = 'lastfm' | 'spotify' | 'tidal';

export interface UnlikePreviewRow {
  trackId: number;
  name: string;
  artistName: string;
  sources: LikedSource[];
  playcount: number;
  lastListen: number;
  protected: boolean;
  playlistNames: string[];
}

export interface UnlikePreviewOptions {
  inPlaylistOn?: ServiceName[] | 'any';
  maxPlaycount?: number;
  notPlayedInDays?: number;
  source?: LikedSource;
}

export interface UnlikeExecuteResult {
  unliked: number;
  spotifyRemoved: number;
  tidalRemoved: number;
  localOnlyRemoved: number;
  skipped: { trackId: number; reason: string }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error((body as { error?: string })?.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  getSettings: () => request<Settings>('/api/settings'),
  saveSettings: (body: {
    lastfmUsername?: string;
    lastfmApiKey?: string;
    spotifyClientId?: string;
    tidalClientId?: string;
    tidalCountryCode?: string;
    defaultService?: string;
  }) =>
    request<void>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  startLastfmSync: () => request<{ started: boolean }>('/api/sync/lastfm', { method: 'POST' }),
  startEnrichment: () => request<{ started: boolean }>('/api/enrich', { method: 'POST' }),
  startReprocess: () =>
    request<{ started: boolean }>('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reprocess: true }),
    }),
  getSyncStatus: () => request<SyncStatus>('/api/sync/status'),
  getLibrarySummary: () => request<LibrarySummary>('/api/library/summary'),
  getInsights: (kind: InsightKind, limit: number) =>
    request<Insights>(`/api/library/insights?kind=${kind}&limit=${limit}`),
  getTopArtists: (range: TopArtistsRange, limit = 10) =>
    request<TopArtists>(`/api/library/top-artists?range=${range}&limit=${limit}`),

  getFacets: () => request<Facets>('/api/facets'),
  previewRecipe: (recipe: Recipe) =>
    request<PreviewResult>('/api/recipes/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipe),
    }),
  listRecipes: () => request<SavedRecipe[]>('/api/recipes'),
  createRecipe: (name: string, definition: Recipe) =>
    request<SavedRecipe>('/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, definition }),
    }),
  updateRecipe: (id: number, name: string, definition: Recipe) =>
    request<void>(`/api/recipes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, definition }),
    }),
  deleteRecipe: (id: number) => request<void>(`/api/recipes/${id}`, { method: 'DELETE' }),

  getAuthStatus: () => request<AuthStatus>('/api/auth/status'),
  startAuth: (service: ServiceName) => request<{ url: string }>(`/api/auth/${service}/start`),
  disconnect: (service: ServiceName) =>
    request<void>(`/api/auth/${service}/disconnect`, { method: 'POST' }),
  importSpotifyLiked: () => request<{ started: boolean }>('/api/sync/spotify-liked', { method: 'POST' }),
  importTidalLiked: () => request<{ started: boolean }>('/api/sync/tidal-liked', { method: 'POST' }),

  push: (
    recipe: Recipe,
    service: ServiceName,
    name: string,
    selectedIds?: number[],
    mode?: PushMode,
    existingPlaylistId?: string,
  ) =>
    request<{ started: boolean; trackCount: number }>('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipe, service, name, selectedIds, mode, existingPlaylistId }),
    }),
  getPushResult: () => request<{ result: PushResult | null }>('/api/push/result'),
  checkExistingPlaylist: (service: ServiceName, name: string) =>
    request<{ existing: ExistingPlaylist | null }>(
      `/api/push/existing?service=${service}&name=${encodeURIComponent(name)}`,
    ),

  getPresets: () => request<Preset[]>('/api/presets'),
  getCandidates: (service: ServiceName, trackId: number) =>
    request<{ candidates: Candidate[] }>(`/api/match/candidates?service=${service}&trackId=${trackId}`),
  /** Saves a chosen match and, when playlistId is given, also mutates that live
   * playlist: appends it (alreadyInPlaylist false/omitted -- the track was
   * unmatched) or removes the old id and appends the new one (alreadyInPlaylist
   * true -- the track was a low-confidence match already sitting in the playlist). */
  overrideMatch: (service: ServiceName, trackId: number, serviceId: string, playlistId?: string, alreadyInPlaylist?: boolean) =>
    request<OverrideResult>('/api/match/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, trackId, serviceId, playlistId, alreadyInPlaylist }),
    }),

  resolveDeepLinks: (service: ServiceName, items: { kind: LinkEntityKind; entityId: number }[]) =>
    request<{ links: (string | null)[] }>('/api/deeplinks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, items }),
    }),

  // ---- Curator: playlist inventory ----
  syncPlaylists: (service?: ServiceName) =>
    request<{ started: boolean; services: ServiceName[] }>('/api/sync/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(service ? { service } : {}),
    }),
  getPlaylistInventory: () => request<PlaylistInventory>('/api/playlists/inventory'),

  // ---- Curator: classify & push ----
  curatePreview: (body: CuratePreviewRequest) =>
    request<CuratePreviewResult>('/api/curate/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  curatePush: (service: ServiceName, onExisting: OnExisting, playlists: CuratePushPlaylistRequest[]) =>
    request<{ started: boolean; playlistCount: number }>('/api/curate/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, onExisting, playlists }),
    }),
  getCurateResult: () => request<{ results: CuratePushOutcome[] | null }>('/api/curate/result'),

  // ---- Curator: cleanup (bulk unlike) ----
  unlikePreview: (opts: UnlikePreviewOptions) =>
    request<{ rows: UnlikePreviewRow[] }>('/api/unlike/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }),
  protectTrack: (trackId: number, isProtected: boolean) =>
    request<void>('/api/tracks/protect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId, protected: isProtected }),
    }),
  unlikeExecute: (trackIds: number[], localOnly: boolean) =>
    request<{ started: boolean; trackCount: number }>('/api/unlike/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackIds, localOnly }),
    }),
  getUnlikeResult: () => request<{ result: UnlikeExecuteResult | null }>('/api/unlike/result'),
};
