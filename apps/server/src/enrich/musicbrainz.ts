import type { WeightedTag } from '../lastfm/client.js';

const API_ROOT = 'https://musicbrainz.org/ws/2';

export interface MbArtist {
  mbid: string;
  /** ISO 3166-1 alpha-2 country code where resolvable, else an area name. */
  country: string | null;
  genres: WeightedTag[];
  tags: WeightedTag[];
}

export interface MbSearchHit {
  mbid: string;
  score: number;
  country: string | null;
}

export interface MbReleaseSearchHit {
  mbid: string;
  score: number;
}

export interface MbReleaseGroup {
  /** Raw MusicBrainz release-group date, partial precision: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'. */
  firstReleaseDate: string | null;
}

export class MusicBrainzError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MusicBrainzError';
  }
}

type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface MusicBrainzClientOptions {
  fetchImpl?: FetchLike;
  /** MusicBrainz asks anonymous clients to stay at <= 1 req/s. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function weightedTags(list: unknown): WeightedTag[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((t: any) => ({ name: String(t?.name ?? '').trim(), weight: Number(t?.count ?? 0) }))
    .filter((t) => t.name.length > 0);
}

/** Prefer an ISO country code; fall back through area codes, then area name. */
function resolveCountry(entity: any): string | null {
  if (typeof entity?.country === 'string' && entity.country) return entity.country;
  for (const key of ['area', 'begin-area']) {
    const area = entity?.[key];
    const codes = area?.['iso-3166-1-codes'];
    if (Array.isArray(codes) && codes.length > 0) return String(codes[0]);
  }
  if (typeof entity?.area?.name === 'string' && entity.area.name) return entity.area.name;
  return null;
}

export class MusicBrainzClient {
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(
    private readonly userAgent: string,
    options: MusicBrainzClientOptions = {},
  ) {
    this.fetchImpl =
      options.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
    this.minIntervalMs = options.minIntervalMs ?? 1100;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get(pathAndQuery: string): Promise<any> {
    const url = `${API_ROOT}${pathAndQuery}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();

      let status = 0;
      let body: any;
      let networkError: unknown;
      try {
        // A descriptive User-Agent is mandatory; MusicBrainz blocks generic ones.
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        });
        status = res.status;
        if (res.ok) body = await res.json().catch(() => undefined);
      } catch (err) {
        networkError = err;
      }

      if ((networkError !== undefined || RETRYABLE_STATUS.has(status)) && attempt < this.maxRetries) {
        await this.sleep(2 ** attempt * 1000);
        continue;
      }
      if (networkError !== undefined) throw networkError;
      if (status === 404) return undefined;
      if (status < 200 || status >= 300) {
        throw new MusicBrainzError(`MusicBrainz HTTP ${status}`, status);
      }
      return body;
    }
  }

  /** Full artist record including genres, tags and country. */
  async lookupArtist(mbid: string): Promise<MbArtist | null> {
    const body = await this.get(`/artist/${encodeURIComponent(mbid)}?inc=genres+tags&fmt=json`);
    if (!body?.id) return null;
    return {
      mbid: String(body.id),
      country: resolveCountry(body),
      genres: weightedTags(body.genres),
      tags: weightedTags(body.tags),
    };
  }

  /** Best-scoring artist candidate for a free-text name, or null. */
  async searchArtist(name: string): Promise<MbSearchHit | null> {
    const query = `artist:"${name.replace(/"/g, '\\"')}"`;
    const body = await this.get(`/artist?query=${encodeURIComponent(query)}&limit=3&fmt=json`);
    const hit = body?.artists?.[0];
    if (!hit?.id) return null;
    return { mbid: String(hit.id), score: Number(hit.score ?? 0), country: resolveCountry(hit) };
  }

  /** Best-scoring release-group candidate for an artist+album name, or null. */
  async searchReleaseGroup(artistName: string, albumName: string): Promise<MbReleaseSearchHit | null> {
    const query = `releasegroup:"${albumName.replace(/"/g, '\\"')}" AND artist:"${artistName.replace(/"/g, '\\"')}"`;
    const body = await this.get(`/release-group?query=${encodeURIComponent(query)}&limit=3&fmt=json`);
    const hit = body?.['release-groups']?.[0];
    if (!hit?.id) return null;
    return { mbid: String(hit.id), score: Number(hit.score ?? 0) };
  }

  /** Release-group record (currently just its first-release-date), or null on 404. */
  async lookupReleaseGroup(mbid: string): Promise<MbReleaseGroup | null> {
    const body = await this.get(`/release-group/${encodeURIComponent(mbid)}?fmt=json`);
    if (!body?.id) return null;
    return { firstReleaseDate: body['first-release-date'] || null };
  }
}
