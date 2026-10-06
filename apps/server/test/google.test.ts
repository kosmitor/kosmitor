import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { freshDatabase } from './helpers.ts';
import { verifyGoogleIdToken, GoogleAuthError, type GoogleJwk, type VerifyOptions } from '../src/google.ts';

await freshDatabase();

// A key pair that stands in for Google's, published as a JWKS the verifier fetches.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: GoogleJwk = { ...(publicKey.export({ format: 'jwk' }) as GoogleJwk), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
const keys = async (_force: boolean) => [jwk];
const NOW = 1_800_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signer = privateKey): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...header });
  const p = b64({
    iss: 'https://accounts.google.com', aud: 'client-123', sub: '1234567890',
    email: 'Avery@Example.com', email_verified: true, name: 'Avery Stone',
    picture: 'https://lh3.googleusercontent.com/a/photo', hd: 'example.com',
    iat: NOW - 10, exp: NOW + 3600, nonce: 'n-1', ...claims,
  });
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), signer).toString('base64url');
  return `${h}.${p}.${sig}`;
}

const opts: VerifyOptions = { clientId: 'client-123', nonce: 'n-1', now: NOW, keys };
const rejectsWith = (token: string, message: string, extra: Partial<VerifyOptions> = {}) =>
  assert.rejects(() => verifyGoogleIdToken(token, { ...opts, ...extra }),
    (e: unknown) => e instanceof GoogleAuthError && e.message.includes(message), `expected "${message}"`);

test('a well-formed Google ID token yields a normalised profile', async () => {
  const profile = await verifyGoogleIdToken(mint(), opts);
  assert.deepEqual(profile, {
    sub: '1234567890', email: 'avery@example.com', emailVerified: true, name: 'Avery Stone',
    picture: 'https://lh3.googleusercontent.com/a/photo', hostedDomain: 'example.com',
  });
});

test('both Google issuer spellings are accepted', async () => {
  const profile = await verifyGoogleIdToken(mint({ iss: 'accounts.google.com' }), opts);
  assert.equal(profile.sub, '1234567890');
});

test('a token for another application is rejected', () =>
  rejectsWith(mint({ aud: 'someone-else' }), 'different application'));

test('a token from another issuer is rejected', () =>
  rejectsWith(mint({ iss: 'https://evil.example' }), 'not issued by Google'));

test('an expired token is rejected, one that expires later is not', async () => {
  await rejectsWith(mint({ exp: NOW - 1 }), 'expired');
  await verifyGoogleIdToken(mint({ exp: NOW + 1 }), opts);
});

test('a token issued in the future is rejected', () =>
  rejectsWith(mint({ iat: NOW + 3600 }), 'not valid yet'));

test('a tampered payload fails the signature check', async () => {
  const [h, p, s] = mint().split('.');
  const tampered = b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), email: 'attacker@example.com' });
  await rejectsWith(`${h}.${tampered}.${s}`, 'signature is invalid');
});

test('a token signed by a different key with a matching kid fails the signature check', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await rejectsWith(mint({}, {}, other), 'signature is invalid');
});

test('a token signed with a key Google does not publish is rejected after one refetch', async () => {
  const calls: boolean[] = [];
  const tracking = async (force: boolean) => { calls.push(force); return [jwk]; };
  await rejectsWith(mint({}, { kid: 'rotated-away' }), 'does not publish', { keys: tracking });
  assert.deepEqual(calls, [false, true]);
});

test('an unexpected algorithm is rejected before any key lookup', () =>
  rejectsWith(mint({}, { alg: 'HS256' }), 'unexpected signing algorithm'));

test('the nonce must match the one issued for this attempt', async () => {
  await rejectsWith(mint({ nonce: 'someone-elses' }), 'did not match');
  await rejectsWith(mint({ nonce: undefined }), 'did not match');
  await verifyGoogleIdToken(mint({ nonce: undefined }), { ...opts, nonce: null }); // callers may opt out
});

test('an unverified email is rejected', () =>
  rejectsWith(mint({ email_verified: false }), 'not verified'));

test('domain restrictions compare the email domain, case-insensitively, with or without a leading @', async () => {
  await verifyGoogleIdToken(mint(), { ...opts, allowedDomains: ['@Example.com'] });
  await rejectsWith(mint(), 'Sign in with a @acme.com', { allowedDomains: ['acme.com'] });
  await rejectsWith(mint({ email: 'avery@example.com.evil.net' }), '@example.com', { allowedDomains: ['example.com'] });
});

test('a missing name falls back to the email', async () => {
  const profile = await verifyGoogleIdToken(mint({ name: undefined }), opts);
  assert.equal(profile.name, 'avery@example.com');
});

test('malformed tokens are rejected without throwing anything else', async () => {
  await rejectsWith('not-a-jwt', 'malformed');
  await rejectsWith('a.b', 'malformed');
  await rejectsWith('%%%.%%%.%%%', 'malformed');
});

test('nonces are single use, expire, and unknown nonces are refused', async () => {
  const { issueNonce, consumeNonce } = await import('../src/nonces.ts');
  const { run } = await import('../src/db.ts');
  const nonce = await issueNonce();
  assert.equal(await consumeNonce(nonce), true);
  assert.equal(await consumeNonce(nonce), false);
  assert.equal(await consumeNonce('never-issued'), false);
  assert.equal(await consumeNonce(null), false);
  assert.notEqual(await issueNonce(), await issueNonce());
  const stale = await issueNonce();
  await run('UPDATE login_nonces SET expires_at = ? WHERE nonce = ?', '2000-01-01T00:00:00.000Z', stale);
  assert.equal(await consumeNonce(stale), false);
});

test('Google identities link to an existing account by verified email, else create one, and are found by subject after', async () => {
  const auth = await import('../src/auth.ts');
  const profile = (o: Partial<Parameters<typeof auth.upsertGoogleUser>[0]> = {}) => ({
    sub: 'g-1', email: 'priya@example.com', emailVerified: true as const, name: 'Priya Raman',
    picture: 'https://p/1', hostedDomain: null, ...o,
  });

  // An invited placeholder account (name defaulted from the email) is claimed and named.
  const invited = await auth.createUser('priya@example.com', 'priya', 'unguessable-placeholder');
  const linked = await auth.upsertGoogleUser(profile());
  assert.equal(linked.id, invited.id);
  assert.equal(linked.name, 'Priya Raman');
  assert.equal(linked.avatarUrl, 'https://p/1');
  assert.equal((await auth.findUserByEmail('priya@example.com'))?.googleSub, 'g-1');

  // Once linked, the Google subject wins even if the Google email changes.
  const bySub = await auth.upsertGoogleUser(profile({ email: 'priya.raman@example.com', picture: 'https://p/2' }));
  assert.equal(bySub.id, invited.id);
  assert.equal(bySub.avatarUrl, 'https://p/2');

  // A password user keeps their chosen name when they link Google.
  const bao = await auth.createUser('bao@example.com', 'Bao Nguyen', 'password123');
  const baoLinked = await auth.upsertGoogleUser(profile({ sub: 'g-2', email: 'bao@example.com', name: 'B. Nguyen' }));
  assert.equal(baoLinked.id, bao.id);
  assert.equal(baoLinked.name, 'Bao Nguyen');
  assert.equal(baoLinked.authProvider, 'PASSWORD');
  assert.equal(auth.verifyPassword('password123', (await auth.findUserByEmail('bao@example.com'))!.passwordHash), true);

  // Nobody with this email: a Google-only account is created with no usable password.
  const fresh = await auth.upsertGoogleUser(profile({ sub: 'g-3', email: 'new@example.com', name: 'New Person' }));
  assert.notEqual(fresh.id, invited.id);
  assert.equal(fresh.authProvider, 'GOOGLE');
  assert.equal((await auth.findUserByEmail('new@example.com'))?.id, fresh.id);
  assert.equal(auth.verifyPassword('', (await auth.findUserByEmail('new@example.com'))!.passwordHash), false);
});
