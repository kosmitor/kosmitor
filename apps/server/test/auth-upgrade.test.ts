/**
 * Sign-in after the v19 upgrade: a restart (migrate) does not confirm an address
 * nobody confirmed; an administrator's temporary password and the demo account
 * sign in without a link; only wrong passwords count towards the limit.
 * Mail points at a closed port, so nothing is sent.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

process.env.SMTP_URL = 'smtp://127.0.0.1:9';
process.env.ACS_CONNECTION_STRING = '';
process.env.GOOGLE_CLIENT_ID = '';
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
const { one, all, migrate, insert } = await import('../src/db.ts');
const { upsertGoogleAccount, createUser, setPassword } = await import('../src/auth.ts');
const { configure } = await import('../src/config.ts');
configure({ auth: { verifyEmail: true }, demo: { enabled: true } });
const { ensureDemoCompany } = await import('../src/sample.ts');

const realError = console.error;
console.error = () => undefined;
after(() => { console.error = realError; });

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

test('an unconfirmed sign-up stays unconfirmed across restarts', async () => {
  const reg = await call('POST', '/api/auth/register', { email: 'victim@example.com', name: 'Stranger Danger', password: 'stranger-pass-123' });
  assert.equal(reg.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await call('POST', '/api/auth/login', { email: 'victim@example.com', password: 'stranger-pass-123' })).status, 403);
  await migrate(); await migrate();
  const s = await one<any>('SELECT last_login_at, email_verified_at FROM users WHERE email = ?', 'victim@example.com');
  assert.equal(s.last_login_at, null); assert.equal(s.email_verified_at, null);
  assert.equal((await call('POST', '/api/auth/login', { email: 'victim@example.com', password: 'stranger-pass-123' })).status, 403);
  await upsertGoogleAccount({ sub: 'g-victim', email: 'victim@example.com', name: 'Real Owner', emailVerified: true } as any);
  assert.equal((await call('POST', '/api/auth/login', { email: 'victim@example.com', password: 'stranger-pass-123' })).status, 401, 'stranger password dropped');
});

test('a temporary password an administrator set (unused) signs in and confirms', async () => {
  const u = await createUser('temp@example.com', 'Tess Temp', 'placeholder-random-123');
  await setPassword(u.id, 'temp-pass-1234', { mustChange: true });
  const r = await call('POST', '/api/auth/login', { email: 'temp@example.com', password: 'temp-pass-1234' });
  assert.equal(r.status, 200);
  const s = await one<any>('SELECT email_verified_at FROM users WHERE email = ?', 'temp@example.com');
  assert.ok(s.email_verified_at);
  const links = await one<any>("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND purpose = 'VERIFY'", u.id);
  assert.equal(Number(links.n), 0, 'no VERIFY link minted');
});

test('the demo account on a fresh database signs in at once', async () => {
  const cid = await ensureDemoCompany();
  assert.ok(cid);
  const r = await call('POST', '/api/auth/login', { email: 'founder@example.com', password: 'password123' });
  assert.equal(r.status, 200);
  const links = await one<any>("SELECT COUNT(*) AS n FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'founder@example.com' AND r.purpose = 'VERIFY'");
  assert.equal(Number(links.n), 0);
});

test('an ordinary unconfirmed password account is still refused', async () => {
  await createUser('plain@example.com', 'Plain Person', 'plain-pass-1234');
  const r = await call('POST', '/api/auth/login', { email: 'plain@example.com', password: 'plain-pass-1234' });
  assert.equal(r.status, 403);
});

test('right passwords do not count towards the limit; the demo account is not limited', async () => {
  const { forgetAttempts } = await import('../src/rate-limit.ts');
  forgetAttempts();
  for (let i = 0; i < 11; i++) assert.equal((await call('POST', '/api/auth/login', { email: 'temp@example.com', password: 'temp-pass-1234' })).status, 200);
  for (let i = 0; i < 11; i++) assert.equal((await call('POST', '/api/auth/login', { email: 'founder@example.com', password: `wrong-${i}` })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'founder@example.com', password: 'password123' })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/login', { email: 'temp@example.com', password: `wrong-${i}` })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'temp@example.com', password: 'temp-pass-1234' })).status, 429);
  forgetAttempts();
});
