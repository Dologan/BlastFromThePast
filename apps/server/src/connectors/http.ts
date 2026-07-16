export type ConnectorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Authenticated JSON request against a service API, with a fresh bearer token. */
export async function authedJson(
  fetchImpl: ConnectorFetch,
  getToken: () => Promise<string>,
  method: string,
  url: string,
  body?: unknown,
): Promise<any> {
  const token = await getToken();
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
