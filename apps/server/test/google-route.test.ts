/**
 * Sign in with Google, end to end over HTTP: the real route, a nonce stored in
 * PostgreSQL, signature verification against a stand-in key server, account
 * creation and linking, the session cookie and bearer token, and the audit
 * trail. Only Google's own popup is missing — a stand-in key server signs the
 * ID tokens exactly as Google would.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { freshDatabase } from './helpers.ts';

// --- a stand-in for https://www.googleapis.com/oauth2/v3/certs -------------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'route-test-key', alg: 'RS256', use: 'sig' };
const keyServer: Server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => keyServer.listen(0, '127.0.0.1', resolve));

const CLIENT_ID = '000000000000-routetest.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_ALLOWED_DOMAINS = 'example.com';
process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}/certs`;

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
const { all } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => { api.close(); keyServer.close(); });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
function mint(claims: Record<string, unknown> = {}): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'route-test-key' });
  const p = b64({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '10769150350006150715113082367',
    email: 'Avery@Example.com', email_verified: true, name: 'Avery Stone', hd: 'example.com',
    picture: 'https://lh3.googleusercontent.com/a/photo', iat: NOW - 5, exp: NOW + 3600, ...claims,
  });
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const startNonce = async (): Promise<string> => ((await (await post('/api/auth/google/start', {})).json()) as { nonce: string }).nonce;

test('the sign-in page learns Google is configured, and restricted to the workspace domain', async () => {
  const config = await (await fetch(`${base}/api/auth/config`)).json() as Record<string, unknown>;
  assert.equal(config.googleClientId, CLIENT_ID);
  assert.deepEqual(config.googleAllowedDomains, ['example.com']);
  assert.equal(config.passwordSignIn, true);
  assert.equal(config.selfSignup, true);
});

test('a nonce is issued and stored in the database', async () => {
  const nonce = await startNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{32}$/);
  const rows = await all<{ nonce: string; expires_at: string }>('SELECT nonce, expires_at FROM login_nonces WHERE nonce = ?', nonce);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].expires_at > new Date().toISOString());
});

test('a valid Google ID token signs in: account created, cookie and bearer token issued, /auth/me works', async () => {
  const nonce = await startNonce();
  const res = await post('/api/auth/google', { credential: mint({ nonce }), nonce });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { user: Record<string, unknown>; token: string };
  assert.equal(body.user.email, 'avery@example.com');
  assert.equal(body.user.name, 'Avery Stone');
  assert.equal(body.user.authProvider, 'GOOGLE');
  assert.equal(body.user.avatarUrl, 'https://lh3.googleusercontent.com/a/photo');
  assert.match(res.headers.get('set-cookie') ?? '', /^ct_session=[^;]+; HttpOnly; SameSite=Lax; Path=\//);

  const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);
  const meBody = await me.json() as { user: { id: string }; companies: unknown[] };
  assert.equal(meBody.user.id, body.user.id);
  assert.deepEqual(meBody.companies, []);                          // brand-new account, no workspace yet

  const cookieMe = await fetch(`${base}/api/auth/me`, { headers: { cookie: res.headers.get('set-cookie')!.split(';')[0] } });
  assert.equal(cookieMe.status, 200);                              // the cookie alone is enough

  const logins = await all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'LOGIN' AND entity_id = ?", body.user.id);
  assert.equal(logins.length, 1);
  assert.equal(logins[0].detail, 'Signed in with Google');
});

test('signing in again finds the same account and does not create a duplicate', async () => {
  const nonce = await startNonce();
  const first = await all<{ id: string }>('SELECT id FROM users WHERE email = ?', 'avery@example.com');
  const res = await post('/api/auth/google', { credential: mint({ nonce, name: 'A. Stone' }), nonce });
  assert.equal(res.status, 200);
  const body = await res.json() as { user: { id: string } };
  assert.equal(body.user.id, first[0].id);
  assert.equal((await all('SELECT id FROM users WHERE email = ?', 'avery@example.com')).length, 1);
});

test('a nonce works exactly once — replaying the same credential is refused', async () => {
  const nonce = await startNonce();
  const credential = mint({ nonce });
  assert.equal((await post('/api/auth/google', { credential, nonce })).status, 200);
  const replay = await post('/api/auth/google', { credential, nonce });
  assert.equal(replay.status, 401);
  assert.match(((await replay.json()) as { error: string }).error, /expired/);
});

test('an account outside the allowed domain is refused, and its nonce is burned so the token cannot be retried', async () => {
  const nonce = await startNonce();
  const res = await post('/api/auth/google', { credential: mint({ nonce, email: 'mallory@evil.example', hd: 'evil.example' }), nonce });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /@example\.com/);
  assert.equal((await all('SELECT id FROM users WHERE email = ?', 'mallory@evil.example')).length, 0);
  const retry = await post('/api/auth/google', { credential: mint({ nonce }), nonce });
  assert.equal(retry.status, 401);
});

test('a token minted for a different client, or with a bad signature, never signs in', async () => {
  const nonce1 = await startNonce();
  const wrongAudience = await post('/api/auth/google', { credential: mint({ nonce: nonce1, aud: 'someone-else' }), nonce: nonce1 });
  assert.equal(wrongAudience.status, 401);
  const nonce2 = await startNonce();
  const [h, p] = mint({ nonce: nonce2 }).split('.');
  const forged = await post('/api/auth/google', { credential: `${h}.${p}.${Buffer.from('nope').toString('base64url')}`, nonce: nonce2 });
  assert.equal(forged.status, 401);
  assert.match(((await forged.json()) as { error: string }).error, /signature/);
});

test('an invited placeholder account is claimed by signing in with the invited address', async () => {
  const { createUser } = await import('../src/auth.ts');
  const invited = await createUser('priya@example.com', 'priya', 'placeholder-nobody-knows');
  const nonce = await startNonce();
  const res = await post('/api/auth/google', { credential: mint({ nonce, sub: '999', email: 'priya@example.com', name: 'Priya Raman' }), nonce });
  assert.equal(res.status, 200);
  const body = await res.json() as { user: { id: string; name: string } };
  assert.equal(body.user.id, invited.id);
  assert.equal(body.user.name, 'Priya Raman');
});

test('malformed requests fail cleanly', async () => {
  assert.equal((await post('/api/auth/google', {})).status, 400);
  const nonce = await startNonce();
  const res = await post('/api/auth/google', { credential: 'not.a.jwt', nonce });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /malformed/);
});

test('without self-service sign-up, Google signs in existing and invited accounts but creates none', async () => {
  const { configure, resetConfig } = await import('../src/config.ts');
  const { createUser } = await import('../src/auth.ts');
  const invited = await createUser('quinn@example.com', 'quinn', 'placeholder-nobody-knows');
  configure({ auth: { selfSignup: false } });
  try {
    const stranger = await startNonce();
    const refused = await post('/api/auth/google', { credential: mint({ nonce: stranger, sub: '555', email: 'newcomer@example.com', name: 'New Comer' }), nonce: stranger });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /invitation only/);
    assert.equal((await all('SELECT id FROM users WHERE email = ?', 'newcomer@example.com')).length, 0);

    const known = await startNonce();
    assert.equal((await post('/api/auth/google', { credential: mint({ nonce: known }), nonce: known })).status, 200);   // avery, created earlier

    const claim = await startNonce();
    const claimed = await post('/api/auth/google', { credential: mint({ nonce: claim, sub: '777', email: 'quinn@example.com', name: 'Quinn Ash' }), nonce: claim });
    assert.equal(claimed.status, 200);
    assert.equal(((await claimed.json()) as { user: { id: string } }).user.id, invited.id);
  } finally {
    resetConfig();
  }
});
