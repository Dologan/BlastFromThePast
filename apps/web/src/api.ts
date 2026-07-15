export interface Settings {
  lastfmUsername: string | null;
  lastfmApiKeySet: boolean;
}

export interface SyncProgress {
  phase: 'scrobbles' | 'loved' | 'stats';
  page?: number;
  totalPages?: number;
  inserted: number;
}

export interface EnrichProgress {
  kind: 'enrich';
  processed: number;
  total: number;
  current: string | null;
}

export interface SyncStatus {
  running: boolean;
  job: string | null;
  progress: SyncProgress | EnrichProgress | null;
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
  saveSettings: (body: { lastfmUsername?: string; lastfmApiKey?: string }) =>
    request<void>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  startLastfmSync: () => request<{ started: boolean }>('/api/sync/lastfm', { method: 'POST' }),
  startEnrichment: () => request<{ started: boolean }>('/api/enrich', { method: 'POST' }),
  getSyncStatus: () => request<SyncStatus>('/api/sync/status'),
  getLibrarySummary: () => request<LibrarySummary>('/api/library/summary'),
};
