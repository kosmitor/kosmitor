/**
 * Sign in with Google — ID token verification.
 *
 * The browser obtains an ID token from Google Identity Services and posts it
 * to us. We verify it locally against Google's published signing keys rather
 * than calling a Google endpoint on every login: parse the JWT, check the
 * RS256 signature with the key whose `kid` matches, then check the claims
 * Google documents — issuer, audience (our client ID), expiry, a verified
 * email, and the nonce we issued for this particular attempt.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

export interface GoogleJwk extends JsonWebKey { kid: string; alg?: string; use?: string }

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: true;
  name: string;
  picture: string | null;
  hostedDomain: string | null;
}

export class GoogleAuthError extends Error {
  status = 401;
}

/** Google's published signing keys. Overridable so tests (or a proxy) can point elsewhere. */
export const GOOGLE_JWKS_URL = process.env.GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// ---------------------------------------------------------------------------
// Signing keys, cached for as long as Google's Cache-Control allows
// ---------------------------------------------------------------------------

let keyCache: { keys: GoogleJwk[]; expiresAt: number } | null = null;

export async function fetchGoogleKeys(force = false): Promise<GoogleJwk[]> {
  if (!force && keyCache && keyCache.expiresAt > Date.now()) return keyCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new GoogleAuthError('Could not reach Google to verify the sign-in. Try again in a moment.');
  const body = (await res.json()) as { keys: GoogleJwk[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
  keyCache = { keys: body.keys, expiresAt: Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 3_600_000) };
  return keyCache.keys;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new GoogleAuthError('The Google sign-in token is malformed.');
  }
}

export interface VerifyOptions {
  clientId: string;
  /** The nonce issued for this attempt; the token must carry it. */
  nonce?: string | null;
  /** Restrict sign-in to Google accounts on these email domains. */
  allowedDomains?: string[];
  /** Seconds since the epoch — injectable for tests. */
  now?: number;
  /** Key source — injectable for tests. */
  keys?: (force: boolean) => Promise<GoogleJwk[]>;
}

export async function verifyGoogleIdToken(token: string, opts: VerifyOptions): Promise<GoogleProfile> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('The Google sign-in token is malformed.');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeSegment(headerPart);
  const payload = decodeSegment(payloadPart);
  if (header.alg !== 'RS256') throw new GoogleAuthError('The token uses an unexpected signing algorithm.');

  // Google rotates keys; an unknown kid means our cache is stale, so refetch once.
  const getKeys = opts.keys ?? fetchGoogleKeys;
  let jwk = (await getKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new GoogleAuthError('The token was signed with a key Google does not publish.');

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  if (!verifySignature('sha256', signed, publicKey, Buffer.from(signaturePart, 'base64url'))) {
    throw new GoogleAuthError('The token signature is invalid.');
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.iss !== 'string' || !ISSUERS.has(payload.iss)) {
    throw new GoogleAuthError('The token was not issued by Google.');
  }
  if (payload.aud !== opts.clientId) throw new GoogleAuthError('The token was issued for a different application.');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new GoogleAuthError('The sign-in expired. Try again.');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new GoogleAuthError('The token is not valid yet.');
  if (opts.nonce != null && payload.nonce !== opts.nonce) {
    throw new GoogleAuthError('The sign-in did not match this session. Try again.');
  }
  if (typeof payload.email !== 'string' || payload.email_verified !== true) {
    throw new GoogleAuthError('Google has not verified the email address on this account.');
  }

  const email = payload.email.toLowerCase();
  if (opts.allowedDomains && opts.allowedDomains.length > 0) {
    const domain = email.split('@')[1] ?? '';
    const allowed = opts.allowedDomains.map((d) => d.toLowerCase().replace(/^@/, ''));
    if (!allowed.includes(domain)) {
      throw new GoogleAuthError(`Sign in with a ${allowed.map((d) => `@${d}`).join(' or ')} Google account.`);
    }
  }

  return {
    sub: String(payload.sub),
    email,
    emailVerified: true,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : email,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    hostedDomain: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null,
  };
}
