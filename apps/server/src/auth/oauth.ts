import crypto from 'node:crypto';

export interface Pkce {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 PKCE pair (S256). */
export function generatePkce(): Pkce {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64url(crypto.randomBytes(16));
}

export interface AuthorizeUrlParams {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}

/** Builds the provider authorization URL for the Authorization Code + PKCE flow. */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(p.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', p.scopes.join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
