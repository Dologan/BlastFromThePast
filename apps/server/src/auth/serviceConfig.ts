import type { ServiceName } from '@bftp/core';

export interface ServiceConfig {
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  scopes: string[];
  /** settings key holding the user's OAuth client id for this service. */
  clientIdSetting: string;
}

/**
 * Endpoints and scopes per service. Centralized because the exact current
 * paths -- especially TIDAL's, which is still being rolled out -- may need
 * tweaking against the live APIs; the connector code references these
 * constants rather than hard-coding URLs.
 */
export const SERVICE_CONFIG: Record<ServiceName, ServiceConfig> = {
  spotify: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    apiBase: 'https://api.spotify.com/v1',
    scopes: ['playlist-modify-private', 'playlist-modify-public', 'user-library-read', 'user-library-modify'],
    clientIdSetting: 'spotify.clientId',
  },
  tidal: {
    authorizeUrl: 'https://login.tidal.com/authorize',
    tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
    apiBase: 'https://openapi.tidal.com/v2',
    // 'collection.write' name is a best guess (TIDAL's docs didn't return the
    // exact scope for DELETE /userCollectionTracks/.../items) -- confirm
    // against a live developer-app consent screen and adjust if wrong.
    scopes: ['playlists.write', 'playlists.read', 'collection.read', 'collection.write'],
    clientIdSetting: 'tidal.clientId',
  },
};
