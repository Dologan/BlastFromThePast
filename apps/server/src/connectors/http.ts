export type ConnectorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  /** Optional: real `fetch()` always provides this; test fakes may omit it (only consulted for Retry-After on 429/503). */
  headers?: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export interface RetryOptions {
  /** Extra attempts after the first, on 429/503 only. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryOptions> = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000 };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before the next attempt: honors a numeric Retry-After (seconds) if the
 * service sent one, else exponential backoff with jitter so retries don't
 * all land on the same instant. */
function retryDelayMs(attempt: number, retryAfterHeader: string | null, opts: Required<RetryOptions>): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, opts.maxDelayMs);
  }
  const backoff = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return backoff * (0.5 + Math.random() * 0.5);
}

/**
 * Retries a request on 429 (rate limited) or 503 (temporarily unavailable),
 * up to `maxRetries` extra attempts, before returning whatever response it
 * last got (ok or not -- the caller still checks `res.ok`). Neither Spotify
 * nor TIDAL's public docs specify exact numeric rate limits, so this is a
 * conservative generic policy rather than one tuned to a published number.
 */
export async function fetchWithRetry(
  doFetch: () => ReturnType<ConnectorFetch>,
  opts: RetryOptions = {},
): Promise<Awaited<ReturnType<ConnectorFetch>>> {
  const merged = { ...DEFAULT_RETRY, ...opts };
  let attempt = 0;
  for (;;) {
    const res = await doFetch();
    if (res.ok || (res.status !== 429 && res.status !== 503) || attempt >= merged.maxRetries) return res;
    const retryAfter = res.headers?.get('retry-after') ?? null;
    await sleep(retryDelayMs(attempt, retryAfter, merged));
    attempt++;
  }
}

/** Authenticated JSON request against a service API, with a fresh bearer token
 * and automatic retry-with-backoff on 429/503. */
export async function authedJson(
  fetchImpl: ConnectorFetch,
  getToken: () => Promise<string>,
  method: string,
  url: string,
  body?: unknown,
  retryOpts?: RetryOptions,
): Promise<any> {
  const token = await getToken();
  const res = await fetchWithRetry(
    () =>
      fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    retryOpts,
  );
  if (!res.ok) {
    throw new ConnectorError(`HTTP ${res.status} for ${method} ${url}: ${await res.text()}`, res.status);
  }
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
