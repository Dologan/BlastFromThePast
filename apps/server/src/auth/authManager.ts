import type { ServiceName } from '@bftp/core';
import type { DbHandle } from '@bftp/db';
import { getSetting } from '../settings.js';
import { SERVICE_CONFIG } from './serviceConfig.js';
import { buildAuthorizeUrl, generatePkce, randomState } from './oauth.js';
import type { TokenStore } from './tokenStore.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

interface PendingAuth {
  service: ServiceName;
  verifier: string;
  createdAt: number;
}

export class AuthError extends Error {}

/**
 * Drives the Authorization Code + PKCE flow for each streaming service and
 * hands out fresh access tokens (refreshing transparently). Pending flows are
 * held in memory keyed by `state`; a server restart mid-flow just means the
 * user clicks "connect" again.
 */
export class AuthManager {
  private readonly pending = new Map<string, PendingAuth>();

  constructor(
    private readonly handle: DbHandle,
    private readonly tokens: TokenStore,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = ((url, init) => fetch(url, init)) as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private redirectUri(service: ServiceName): string {
    return `${this.baseUrl}/api/auth/${service}/callback`;
  }

  private clientId(service: ServiceName): string {
    const id = getSetting(this.handle, SERVICE_CONFIG[service].clientIdSetting);
    if (!id) throw new AuthError(`No client ID configured for ${service}.`);
    return id;
  }

  /** Begins a flow: returns the provider URL to send the user's browser to. */
  start(service: ServiceName): string {
    const cfg = SERVICE_CONFIG[service];
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    this.pending.set(state, { service, verifier, createdAt: this.now() });
    return buildAuthorizeUrl({
      authorizeUrl: cfg.authorizeUrl,
      clientId: this.clientId(service),
      redirectUri: this.redirectUri(service),
      scopes: cfg.scopes,
      state,
      challenge,
    });
  }

  /** Completes a flow: exchanges the code for tokens and persists them. */
  async handleCallback(service: ServiceName, code: string, state: string): Promise<void> {
    const pending = this.pending.get(state);
    if (!pending || pending.service !== service) throw new AuthError('Unknown or mismatched OAuth state.');
    this.pending.delete(state);

    const cfg = SERVICE_CONFIG[service];
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(service),
      client_id: this.clientId(service),
      code_verifier: pending.verifier,
    });
    const res = await this.fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new AuthError(`Token exchange failed for ${service}: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    this.tokens.set(service, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: this.now() + Number(data.expires_in ?? 3600),
      scope: data.scope ?? null,
    });
  }

  isAuthorized(service: ServiceName): boolean {
    return this.tokens.get(service) !== null;
  }

  disconnect(service: ServiceName): void {
    this.tokens.clear(service);
  }

  /** A valid access token, refreshed if within 60s of expiry. Throws if not connected. */
  async getAccessToken(service: ServiceName): Promise<string> {
    const stored = this.tokens.get(service);
    if (!stored) throw new AuthError(`${service} is not connected.`);
    if (stored.expiresAt - 60 > this.now()) return stored.accessToken;
    if (!stored.refreshToken) throw new AuthError(`${service} token expired and no refresh token is available.`);

    const cfg = SERVICE_CONFIG[service];
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: this.clientId(service),
    });
    const res = await this.fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new AuthError(`Token refresh failed for ${service}: HTTP ${res.status}`);
    const data = await res.json();
    const refreshed = {
      accessToken: data.access_token,
      // Providers may or may not rotate the refresh token; keep the old one if not.
      refreshToken: data.refresh_token ?? stored.refreshToken,
      expiresAt: this.now() + Number(data.expires_in ?? 3600),
      scope: data.scope ?? stored.scope,
    };
    this.tokens.set(service, refreshed);
    return refreshed.accessToken;
  }
}
