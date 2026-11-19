/**
 * Live check of TIDAL playlist folders against your real account -- the parts
 * of the API the organiser relies on that unit tests can't confirm. It creates
 * one empty playlist and one folder, both named "BFTP folder check (safe to
 * delete)", files the playlist, prints what TIDAL reports, then deletes both.
 *
 * Run as the user owning the DB (BFTP_DB_PATH as for the CLI):
 *   sudo -u bftp env BFTP_DB_PATH=/var/lib/blastfromthepast/library.db \
 *     /usr/bin/node node_modules/.bin/tsx apps/server/scripts/tidal-folder-check.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@bftp/db';
import { TokenCrypto } from '../src/auth/crypto.js';
import { TokenStore } from '../src/auth/tokenStore.js';
import { AuthManager } from '../src/auth/authManager.js';
import { TidalConnector } from '../src/connectors/tidal.js';
import { getSetting, SETTING_KEYS } from '../src/settings.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dbPath = process.env.BFTP_DB_PATH ?? path.join(repoRoot, 'data', 'library.db');
const handle = openDb(dbPath);
const auth = new AuthManager(
  handle,
  new TokenStore(handle, TokenCrypto.loadOrCreate(path.join(path.dirname(dbPath), 'secret.key'))),
  process.env.BFTP_PUBLIC_URL ?? 'http://127.0.0.1:8765',
);
const tidal = new TidalConnector(
  () => auth.getAccessToken('tidal'),
  () => auth.isAuthorized('tidal'),
  getSetting(handle, SETTING_KEYS.tidalCountryCode) ?? 'US',
);
// The connector's raw request, for the cleanup and inspection calls it has no method for.
const request = (method: string, p: string) => (tidal as unknown as { request(m: string, p: string): Promise<any> }).request(method, p);

const NAME = 'BFTP folder check (safe to delete)';
let ok = true;
async function step<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await f();
    console.log(`ok    ${label}${value === undefined ? '' : `: ${JSON.stringify(value).slice(0, 400)}`}`);
    return value;
  } catch (err) {
    ok = false;
    console.log(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

let folderId: string | undefined;
let playlistId: string | undefined;
try {
  folderId = await step('create folder', () => tidal.findOrCreateFolder(NAME));
  await step('find the same folder again (no duplicate)', async () => {
    const again = await tidal.findOrCreateFolder(NAME);
    if (again !== folderId) throw new Error(`got a second folder ${again}`);
    return again;
  });
  playlistId = await step('create playlist', () => tidal.createPlaylist(NAME, 'BFTP folder check'));
  if (folderId && playlistId) {
    await step('file playlist in folder', () => tidal.addPlaylistsToFolder(folderId!, [playlistId!]));
    await step('folder items', async () => (await request('GET', `/userCollectionFolders/${folderId}/relationships/items`))?.data);
    await step('playlist still listed in the FLAT view', async () => {
      const found = (await tidal.listPlaylists()).some((p) => p.serviceId === playlistId);
      if (!found) throw new Error('playlists inside folders are missing from listPlaylists');
      return found;
    });
    await step('deleting the playlist removes it from the folder', async () => {
      await tidal.deletePlaylist(playlistId!);
      playlistId = undefined;
      return (await request('GET', `/userCollectionFolders/${folderId}/relationships/items`))?.data;
    });
  }
} finally {
  if (playlistId) await step('clean up playlist', () => tidal.deletePlaylist(playlistId!));
  if (folderId) await step('clean up folder', () => request('DELETE', `/userCollectionFolders/${folderId}`));
  handle.close();
}
console.log(ok ? '\nAll folder calls worked.' : '\nSome folder calls failed: see FAIL lines.');
process.exitCode = ok ? 0 : 1;
