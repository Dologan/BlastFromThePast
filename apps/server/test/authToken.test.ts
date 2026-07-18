import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import { setSetting, SETTING_KEYS } from '../src/settings.js';

const REMOTE = '203.0.113.9';

describe('API bearer-token guard', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('leaves everything open when no token is configured', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: REMOTE });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('requires the bearer token for remote clients once configured', async () => {
    handle = openDb(':memory:');
    setSetting(handle, SETTING_KEYS.apiToken, 'sekrit');
    const app = buildApp({ handle });

    const noAuth = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: REMOTE });
    expect(noAuth.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: REMOTE,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: REMOTE,
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('always exempts loopback clients (the web SPA keeps working)', async () => {
    handle = openDb(':memory:');
    setSetting(handle, SETTING_KEYS.apiToken, 'sekrit');
    const app = buildApp({ handle });
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('only guards /api/* paths', async () => {
    handle = openDb(':memory:');
    setSetting(handle, SETTING_KEYS.apiToken, 'sekrit');
    const app = buildApp({ handle });
    // No webDistDir in tests, so / is a plain 404 — but NOT a 401.
    const res = await app.inject({ method: 'GET', url: '/', remoteAddress: REMOTE });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
