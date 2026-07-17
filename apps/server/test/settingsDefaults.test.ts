import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import { getSetting, setSetting, SETTING_KEYS, SETTING_DEFAULTS } from '../src/settings.js';

describe('bundled client-ID defaults', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('getSetting falls back to the built-in IDs and a stored override wins', () => {
    handle = openDb(':memory:');
    expect(getSetting(handle, SETTING_KEYS.spotifyClientId)).toBe(
      SETTING_DEFAULTS[SETTING_KEYS.spotifyClientId],
    );
    expect(getSetting(handle, SETTING_KEYS.tidalClientId)).toBe('0DP3zAnDfUfumNa9');

    setSetting(handle, SETTING_KEYS.tidalClientId, 'my-own-id');
    expect(getSetting(handle, SETTING_KEYS.tidalClientId)).toBe('my-own-id');

    // Clearing the override (empty string) restores the built-in default.
    setSetting(handle, SETTING_KEYS.tidalClientId, '');
    expect(getSetting(handle, SETTING_KEYS.tidalClientId)).toBe('0DP3zAnDfUfumNa9');
  });

  it('auth status reports client IDs as configured out of the box', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });
    const status = (await app.inject({ method: 'GET', url: '/api/auth/status' })).json();
    expect(status.spotify.clientIdSet).toBe(true);
    expect(status.tidal.clientIdSet).toBe(true);
    await app.close();
  });

  it('GET /api/settings exposes only user overrides, not the built-ins', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });
    let settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings.spotifyClientId).toBeNull();
    expect(settings.tidalClientId).toBeNull();

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { spotifyClientId: 'override-123' },
    });
    settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings.spotifyClientId).toBe('override-123');
    expect(settings.tidalClientId).toBeNull();
    await app.close();
  });

  it('defaultService defaults to null, can be set, and rejects an unknown service', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });

    let settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings.defaultService).toBeNull();

    const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultService: 'napster' } });
    expect(bad.statusCode).toBe(400);

    await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultService: 'tidal' } });
    settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings.defaultService).toBe('tidal');

    // Clearing it (empty string) restores null.
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultService: '' } });
    settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings.defaultService).toBeNull();
    await app.close();
  });
});
