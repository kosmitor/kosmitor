/**
 * The sign-in surface after hardening. A session travels only in the HttpOnly
 * cookie and is stored hashed, so neither a script in the page nor a copy of
 * the database is a way in. With a mail server, signing up sends a link to the
 * address and the password does not work until it is opened; an account whose
 * address nobody confirmed loses its password the moment its owner arrives
 * through Google. Guessing a password is cut off after ten tries.
 *
 * The mail server here is a closed port: every message fails, which is fine,
 * because the confirmation token is minted into the table the server reads.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { freshDatabase, sessionCookie } from './helpers.ts';

process.env.SMTP_URL = 'smtp://127.0.0.1:9';   // nothing listens: mail is "configured" and every send fails
process.env.ACS_CONNECTION_STRING = '';
process.env.GOOGLE_CLIENT_ID = '';
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
const { one, all, insert, update } = await import('../src/db.ts');
const { upsertGoogleAccount, verifyPassword, hashPassword } = await import('../src/auth.ts');
const { forgetAttempts } = await import('../src/rate-limit.ts');
const { configure } = await import('../src/config.ts');
configure({ auth: { verifyEmail: true } });   // off by default; on where strangers can sign up

// Failed sends are logged, not shown.
const realError = console.error;
console.error = () => undefined;
after(() => { console.error = realError; });

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res), cookie: res.headers.get('set-cookie') };
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const userId = async (email: string) => (await one<{ id: string }>('SELECT id FROM users WHERE email = ?', email))!.id;

/** Mints the confirmation link's token for an address, as the welcome email would carry it. */
async function verificationToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await insert('password_resets', {
    tokenHash: sha256(token), userId: await userId(email), createdBy: null, purpose: 'VERIFY',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), usedAt: null,
  });
  return token;
}

test('signing up with a mail server sends a link; the password works only once it is opened', async () => {
  const signedUp = await call('POST', '/api/auth/register', { email: 'noor@example.com', name: 'Noor Haddad', password: 'noor-pass-123' });
  assert.equal(signedUp.status, 200, JSON.stringify(signedUp.json));
  assert.deepEqual(signedUp.json, { verifyEmail: true, email: 'noor@example.com' });
  assert.equal(signedUp.cookie, null, 'no session before the address is confirmed');

  const early = await call('POST', '/api/auth/login', { email: 'noor@example.com', password: 'noor-pass-123' });
  assert.equal(early.status, 403);
  assert.match(early.json.error, /Confirm your email address first/);
  assert.equal(early.cookie, null);

  const wrongPurpose = await call('POST', '/api/auth/verify', { token: 'not-a-token' });
  assert.equal(wrongPurpose.status, 400);

  const verified = await call('POST', '/api/auth/verify', { token: await verificationToken('noor@example.com') });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal(verified.json.user.email, 'noor@example.com');
  assert.ok(verified.token, 'opening the link signs the person in');
  assert.equal((await call('GET', '/api/auth/me', undefined, verified.token)).status, 200);

  const login = await call('POST', '/api/auth/login', { email: 'noor@example.com', password: 'noor-pass-123' });
  assert.equal(login.status, 200);
  assert.ok(login.token);
});

test('a session is only in the HttpOnly cookie, and the table holds its hash', async () => {
  const login = await call('POST', '/api/auth/login', { email: 'noor@example.com', password: 'noor-pass-123' });
  assert.equal(login.json.token, undefined, 'the token is not in the body');
  assert.match(login.cookie ?? '', /^kosmitor_session=[^;]+; HttpOnly; SameSite=Lax; Path=\//);
  const stored = (await all<{ token: string }>('SELECT token FROM sessions WHERE user_id = ?', await userId('noor@example.com'))).map((r) => r.token);
  assert.ok(!stored.includes(login.token!), 'the cookie value is not stored as is');
  assert.ok(stored.includes(sha256(login.token!)), 'its hash is');

  // Logging out and a password change still find the session by its hash.
  assert.equal((await call('POST', '/api/auth/logout', {}, login.token)).status, 200);
  const outByBearer = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `kosmitor_session=${login.token}` } });
  assert.equal(outByBearer.status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, login.token)).status, 401);
});

test('an unconfirmed account loses its password when its owner arrives through Google', async () => {
  // Someone who knows Priya's address signs up with it, and she never opens the link.
  const squatter = await call('POST', '/api/auth/register', { email: 'priya@example.com', name: 'Not Priya', password: 'squat-pass-123' });
  assert.equal(squatter.json.verifyEmail, true);
  const id = await userId('priya@example.com');
  const before = (await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', id))!.password_hash;
  assert.ok(verifyPassword('squat-pass-123', before));

  // Priya signs in with Google, which vouches for the address.
  const { user, created } = await upsertGoogleAccount({ sub: 'google-priya', email: 'priya@example.com', emailVerified: true, name: 'Priya Raman', picture: null, hostedDomain: null });
  assert.equal(created, false);
  assert.equal(user.id, id);
  const after_ = (await one<{ password_hash: string; email_verified_at: string | null }>('SELECT password_hash, email_verified_at FROM users WHERE id = ?', id))!;
  assert.ok(after_.email_verified_at, 'Google confirmed the address');
  assert.ok(!verifyPassword('squat-pass-123', after_.password_hash), 'the password nobody confirmed is gone');
  assert.equal((await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'squat-pass-123' })).status, 401);

  // An account whose owner did confirm the address keeps its password through a Google link.
  await update('users', await userId('noor@example.com'), { passwordHash: hashPassword('noor-pass-123') });
  await upsertGoogleAccount({ sub: 'google-noor', email: 'noor@example.com', emailVerified: true, name: 'Noor Haddad', picture: null, hostedDomain: null });
  assert.equal((await call('POST', '/api/auth/login', { email: 'noor@example.com', password: 'noor-pass-123' })).status, 200);
});

test('ten wrong passwords at one address cut sign-in off, right one included', async () => {
  forgetAttempts();
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/auth/login', { email: 'noor@example.com', password: `wrong-${i}` })).status, 401);
  }
  const cutOff = await call('POST', '/api/auth/login', { email: 'noor@example.com', password: 'noor-pass-123' });
  assert.equal(cutOff.status, 429);
  assert.match(cutOff.json.error, /Too many sign-in attempts/);
  // Another address is not affected.
  assert.equal((await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'anything-at-all' })).status, 401);
  forgetAttempts();
});
