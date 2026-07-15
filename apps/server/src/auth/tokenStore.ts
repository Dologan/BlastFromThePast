import type { DbHandle } from '@bftp/db';
import type { ServiceName } from '@bftp/core';
import type { TokenCrypto } from './crypto.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // unix seconds
  scope: string | null;
}

/** Encrypted persistence for OAuth tokens, one row per service. */
export class TokenStore {
  constructor(
    private readonly handle: DbHandle,
    private readonly crypto: TokenCrypto,
  ) {}

  get(service: ServiceName): StoredTokens | null {
    const row = this.handle.sqlite
      .prepare('SELECT access_token, refresh_token, expires_at, scope FROM service_auth WHERE service = ?')
      .get(service) as
      | { access_token: string; refresh_token: string | null; expires_at: number; scope: string | null }
      | undefined;
    if (!row) return null;
    return {
      accessToken: this.crypto.decrypt(row.access_token),
      refreshToken: row.refresh_token ? this.crypto.decrypt(row.refresh_token) : null,
      expiresAt: row.expires_at,
      scope: row.scope,
    };
  }

  set(service: ServiceName, tokens: StoredTokens): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO service_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(service) DO UPDATE SET
           access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at`,
      )
      .run(
        service,
        this.crypto.encrypt(tokens.accessToken),
        tokens.refreshToken ? this.crypto.encrypt(tokens.refreshToken) : null,
        tokens.expiresAt,
        tokens.scope,
        Math.floor(Date.now() / 1000),
      );
  }

  clear(service: ServiceName): void {
    this.handle.sqlite.prepare('DELETE FROM service_auth WHERE service = ?').run(service);
  }
}
