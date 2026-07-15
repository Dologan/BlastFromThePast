const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

export interface LastfmScrobble {
  artist: string;
  artistMbid?: string;
  album?: string;
  albumMbid?: string;
  track: string;
  trackMbid?: string;
  uts: number;
}

export interface RecentTracksPage {
  scrobbles: LastfmScrobble[];
  page: number;
  totalPages: number;
  total: number;
}

export interface LovedTrack {
  artist: string;
  artistMbid?: string;
  track: string;
  trackMbid?: string;
  uts?: number;
}

export interface LovedTracksPage {
  loved: LovedTrack[];
  page: number;
  totalPages: number;
}

export class LastfmError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'LastfmError';
  }
}

/** Last.fm returns a bare object instead of a one-element array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Last.fm error codes that indicate a transient service problem.
const RETRYABLE_LASTFM_CODES = new Set([8, 11, 16, 29]);

export interface LastfmClientOptions {
  fetchImpl?: FetchLike;
  /** Minimum spacing between requests, ms. Last.fm asks for <= ~5 req/s. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LastfmClient {
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(
    private readonly apiKey: string,
    options: LastfmClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url));
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call(method: string, params: Record<string, string | number>): Promise<any> {
    const url = new URL(API_ROOT);
    url.searchParams.set('method', method);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();

      let status = 0;
      let body: any;
      let networkError: unknown;
      try {
        const res = await this.fetchImpl(url.toString());
        status = res.status;
        body = await res.json().catch(() => undefined);
      } catch (err) {
        networkError = err;
      }

      const lastfmCode = typeof body?.error === 'number' ? body.error : undefined;
      const retryable =
        networkError !== undefined ||
        RETRYABLE_STATUS.has(status) ||
        (lastfmCode !== undefined && RETRYABLE_LASTFM_CODES.has(lastfmCode));

      if (retryable && attempt < this.maxRetries) {
        await this.sleep(2 ** attempt * 1000);
        continue;
      }
      if (networkError !== undefined) throw networkError;
      if (lastfmCode !== undefined) {
        throw new LastfmError(body?.message ?? `Last.fm error ${lastfmCode}`, lastfmCode);
      }
      if (status < 200 || status >= 300) {
        throw new LastfmError(`Last.fm HTTP ${status} for ${method}`);
      }
      return body;
    }
  }

  async getRecentTracks(
    user: string,
    opts: { from?: number; to?: number; page?: number; limit?: number } = {},
  ): Promise<RecentTracksPage> {
    const params: Record<string, string | number> = {
      user,
      limit: opts.limit ?? 200,
      page: opts.page ?? 1,
    };
    if (opts.from !== undefined) params.from = opts.from;
    if (opts.to !== undefined) params.to = opts.to;
    const body = await this.call('user.getRecentTracks', params);
    const rt = body?.recenttracks;
    const attr = rt?.['@attr'] ?? {};
    const scrobbles: LastfmScrobble[] = [];
    for (const t of asArray<any>(rt?.track)) {
      if (t?.['@attr']?.nowplaying === 'true') continue; // in-flight play, no timestamp yet
      const uts = Number(t?.date?.uts);
      if (!Number.isFinite(uts)) continue;
      scrobbles.push({
        artist: t?.artist?.['#text'] ?? t?.artist?.name ?? '',
        artistMbid: t?.artist?.mbid || undefined,
        album: t?.album?.['#text'] || undefined,
        albumMbid: t?.album?.mbid || undefined,
        track: t?.name ?? '',
        trackMbid: t?.mbid || undefined,
        uts,
      });
    }
    return {
      scrobbles,
      page: Number(attr.page ?? 1),
      totalPages: Number(attr.totalPages ?? 1),
      total: Number(attr.total ?? scrobbles.length),
    };
  }

  async getLovedTracks(user: string, page = 1, limit = 200): Promise<LovedTracksPage> {
    const body = await this.call('user.getLovedTracks', { user, page, limit });
    const lt = body?.lovedtracks;
    const attr = lt?.['@attr'] ?? {};
    const loved: LovedTrack[] = asArray<any>(lt?.track).map((t) => ({
      artist: t?.artist?.name ?? t?.artist?.['#text'] ?? '',
      artistMbid: t?.artist?.mbid || undefined,
      track: t?.name ?? '',
      trackMbid: t?.mbid || undefined,
      uts: t?.date?.uts !== undefined ? Number(t.date.uts) : undefined,
    }));
    return {
      loved,
      page: Number(attr.page ?? 1),
      totalPages: Number(attr.totalPages ?? 1),
    };
  }
}
