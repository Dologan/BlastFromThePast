import type { Recipe } from './recipeTypes';

export interface Settings {
  lastfmUsername: string | null;
  lastfmApiKeySet: boolean;
  spotifyClientId: string | null;
  tidalClientId: string | null;
  tidalCountryCode: string;
}

export type ServiceName = 'spotify' | 'tidal';

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

export interface SpotifyLikedProgress {
  kind: 'spotify-liked';
  seen: number;
  linked: number;
}

export interface PushProgress {
  kind: 'push';
  matched: number;
  processed: number;
  total: number;
}

export type JobProgress = SyncProgress | EnrichProgress | SpotifyLikedProgress | PushProgress;

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

export interface LibrarySummary {
  scrobbles: number;
  tracks: number;
  albums: number;
  artists: number;
  liked: number;
  firstScrobble: number | null;
  lastScrobble: number | null;
  topArtists: { name: string; playcount: number }[];
  enrichment: { enriched: number; pending: number; errored: number; withCountry: number };
  cache: { mbSearches: number; mbArtists: number; lastfmTags: number };
  topGenres: NamedWeight[];
  topCountries: NamedWeight[];
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

  push: (recipe: Recipe, service: ServiceName, name: string) =>
    request<{ started: boolean; trackCount: number }>('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipe, service, name }),
    }),
  getPushResult: () => request<{ result: PushResult | null }>('/api/push/result'),

  getPresets: () => request<Preset[]>('/api/presets'),
  getCandidates: (service: ServiceName, trackId: number) =>
    request<{ candidates: Candidate[] }>(`/api/match/candidates?service=${service}&trackId=${trackId}`),
  overrideMatch: (service: ServiceName, trackId: number, serviceId: string) =>
    request<void>('/api/match/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, trackId, serviceId }),
    }),
};
