import type { DbHandle } from '@bftp/db';

export const SETTING_KEYS = {
  lastfmUsername: 'lastfm.username',
  lastfmApiKey: 'lastfm.apiKey',
  spotifyClientId: 'spotify.clientId',
  tidalClientId: 'tidal.clientId',
  tidalCountryCode: 'tidal.countryCode',
} as const;

/**
 * Built-in defaults. The streaming-service client IDs are the app's own dev
 * app registrations (public identifiers — PKCE flows have no client secret),
 * so connecting works out of the box; a stored non-empty setting overrides.
 */
export const SETTING_DEFAULTS: Record<string, string> = {
  [SETTING_KEYS.spotifyClientId]: 'f76bc60bf2dc4c0b8c3e48c8802da3f8',
  [SETTING_KEYS.tidalClientId]: '0DP3zAnDfUfumNa9',
};

/** The raw stored value, ignoring built-in defaults (for the settings UI). */
export function getStoredSetting(handle: DbHandle, key: string): string | undefined {
  const row = handle.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** The effective value: a non-empty stored setting, else the built-in default. */
export function getSetting(handle: DbHandle, key: string): string | undefined {
  return getStoredSetting(handle, key) || SETTING_DEFAULTS[key];
}

export function setSetting(handle: DbHandle, key: string, value: string): void {
  handle.sqlite
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}
