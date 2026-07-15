import type { DbHandle } from '@bftp/db';

export const SETTING_KEYS = {
  lastfmUsername: 'lastfm.username',
  lastfmApiKey: 'lastfm.apiKey',
} as const;

export function getSetting(handle: DbHandle, key: string): string | undefined {
  const row = handle.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(handle: DbHandle, key: string, value: string): void {
  handle.sqlite
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}
