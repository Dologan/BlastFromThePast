import { describe, it, expect } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { TokenCrypto } from '../src/auth/crypto.js';
import { TokenStore } from '../src/auth/tokenStore.js';
import { AuthManager, type FetchLike } from '../src/auth/authManager.js';
import { generatePkce, buildAuthorizeUrl } from '../src/auth/oauth.js';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('TokenCrypto', () => {
  it('round-trips and rejects tampering', () => {
    const c = TokenCrypto.ephemeral();
    const blob = c.encrypt('a-secret-token');
    expect(blob).not.toContain('a-secret-token');
    expect(c.decrypt(blob)).toBe('a-secret-token');
    expect(() => c.decrypt('AAAA' + blob.slice(4))).toThrow();
  });
});

describe('PKCE + authorize URL', () => {
  it('produces an S256 challenge and a well-formed URL', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge).not.toBe(verifier);
    const url = new URL(
      buildAuthorizeUrl({
        authorizeUrl: 'https://accounts.spotify.com/authorize',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:8765/api/auth/spotify/callback',
        scopes: ['playlist-modify-private'],
        state: 'st',
        challenge,
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('AuthManager', () => {
  const setup = (fetchImpl: FetchLike, now = () => 1000) => {
    const handle: DbHandle = openDb(':memory:');
    handle.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('spotify.clientId', 'cid')").run();
    const store = new TokenStore(handle, TokenCrypto.ephemeral());
    const auth = new AuthManager(handle, store, 'http://127.0.0.1:8765', fetchImpl, now);
    return { handle, store, auth };
  };

  it('completes the code exchange and stores tokens (encrypted)', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 's' });
    };
    const { handle, auth } = setup(fetchImpl);

    const url = new URL(auth.start('spotify'));
    const state = url.searchParams.get('state')!;
    await auth.handleCallback('spotify', 'the-code', state);

    expect(auth.isAuthorized('spotify')).toBe(true);
    expect(await auth.getAccessToken('spotify')).toBe('AT');
    // Exchange sent the code + a verifier.
    expect(calls[0]!.body).toContain('code=the-code');
    expect(calls[0]!.body).toContain('code_verifier=');
    // Stored ciphertext is not the plaintext token.
    const raw = handle.sqlite.prepare("SELECT access_token FROM service_auth WHERE service='spotify'").get() as { access_token: string };
    expect(raw.access_token).not.toContain('AT');
  });

  it('rejects a callback with an unknown state', async () => {
    const { auth } = setup(async () => jsonResponse({}));
    await expect(auth.handleCallback('spotify', 'code', 'bogus-state')).rejects.toThrow(/state/i);
  });

  it('refreshes an expired access token, keeping the refresh token if not rotated', async () => {
    let t = 1000;
    const bodies: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init.body);
      if (init.body.includes('authorization_code')) {
        return jsonResponse({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
      }
      return jsonResponse({ access_token: 'AT2', expires_in: 3600 }); // no new refresh token
    };
    const { auth } = setup(fetchImpl, () => t);
    const url = new URL(auth.start('spotify'));
    await auth.handleCallback('spotify', 'c', url.searchParams.get('state')!);

    expect(await auth.getAccessToken('spotify')).toBe('AT1');
    t += 4000; // now past expiry
    expect(await auth.getAccessToken('spotify')).toBe('AT2');
    expect(bodies.some((b) => b.includes('grant_type=refresh_token') && b.includes('RT1'))).toBe(true);
  });

  it('disconnect clears stored tokens', async () => {
    const { auth } = setup(async () => jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
    const url = new URL(auth.start('spotify'));
    await auth.handleCallback('spotify', 'c', url.searchParams.get('state')!);
    expect(auth.isAuthorized('spotify')).toBe(true);
    auth.disconnect('spotify');
    expect(auth.isAuthorized('spotify')).toBe(false);
  });
});
