/**
 * A company's administrators manage who has access to their company, not the
 * accounts of people who also belong elsewhere. Inviting someone who already
 * has an account gives them access, but it does not let the inviting company
 * change their name or sign-in email, or get a way into their account through
 * a reset link or a temporary password.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
const { insert, one } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

// Mara runs Harbor Labs. Ines runs Quill Works, and invites Mara into it.
const mara = (await call('POST', '/api/auth/register', { email: 'mara@example.com', name: 'Mara Quint', password: 'mara-pass-1' })).json.token as string;
await call('POST', '/api/companies', { name: 'Harbor Labs' }, mara);
const ines = (await call('POST', '/api/auth/register', { email: 'ines@example.com', name: 'Ines Tarrow', password: 'ines-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Quill Works' }, ines)).json.id as string;

const invited = await call('POST', `/api/c/${cid}/members`, { email: 'mara@example.com', role: 'VIEWER' }, ines);
assert.equal(invited.status, 200, JSON.stringify(invited.json));
const maraMember = invited.json.id as string;
// Someone new, whose only account is the one this invitation creates.
const newcomer = (await call('POST', `/api/c/${cid}/members`, { email: 'theo@example.com', name: 'Theo Vance', role: 'VIEWER' }, ines)).json.id as string;

test('the member list says which accounts this company alone manages', async () => {
  const list = (await call('GET', `/api/c/${cid}/members`, undefined, ines)).json as any[];
  const byEmail = Object.fromEntries(list.map((m) => [m.email, m]));
  assert.equal(byEmail['mara@example.com'].managedHere, false);
  assert.equal(byEmail['theo@example.com'].managedHere, true);
  assert.equal(byEmail['ines@example.com'].managedHere, true);
});

test('another company cannot change the name or sign-in email of someone who belongs elsewhere', async () => {
  const email = await call('PATCH', `/api/c/${cid}/members/${maraMember}`, { email: 'ines+mara@example.com' }, ines);
  assert.equal(email.status, 400);
  assert.match(email.json.error, /another company/);
  const name = await call('PATCH', `/api/c/${cid}/members/${maraMember}`, { name: 'Someone Else' }, ines);
  assert.equal(name.status, 400);

  // The edit form sends every field back, so an unchanged name and email do not block a role change.
  const role = await call('PATCH', `/api/c/${cid}/members/${maraMember}`,
    { name: 'Mara Quint', email: 'mara@example.com', role: 'BOARD' }, ines);
  assert.equal(role.status, 200, JSON.stringify(role.json));
  assert.equal(role.json.role, 'BOARD');

  const account = await one<{ email: string; name: string }>("SELECT email, name FROM users WHERE email = 'mara@example.com'");
  assert.deepEqual({ ...account }, { email: 'mara@example.com', name: 'Mara Quint' });
});

test('another company gets no link or password into that account, and does not sign its owner out', async () => {
  const link = await call('POST', `/api/c/${cid}/members/${maraMember}/reset-password`, { mode: 'link' }, ines);
  assert.equal(link.status, 400);
  assert.match(link.json.error, /emailing them a link/);
  assert.equal(link.json.resetUrl, undefined);
  const temporary = await call('POST', `/api/c/${cid}/members/${maraMember}/reset-password`, { mode: 'temporary', password: 'taken-over-1' }, ines);
  assert.equal(temporary.status, 400);

  // Mara's password and session are untouched.
  assert.equal((await call('GET', '/api/auth/me', undefined, mara)).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { email: 'mara@example.com', password: 'mara-pass-1' })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { email: 'mara@example.com', password: 'taken-over-1' })).status, 401);
  assert.equal(await one("SELECT token_hash FROM password_resets WHERE user_id = (SELECT id FROM users WHERE email = 'mara@example.com')"), undefined);
});

test('an account this company alone manages can still be edited and reset, and loses any stored assistant key', async () => {
  const rename = await call('PATCH', `/api/c/${cid}/members/${newcomer}`, { name: 'Theo Vance-Hart', email: 'theo.vh@example.com' }, ines);
  assert.equal(rename.status, 200, JSON.stringify(rename.json));
  assert.equal(rename.json.email, 'theo.vh@example.com');

  const user = await one<{ id: string }>("SELECT id FROM users WHERE email = 'theo.vh@example.com'");
  await insert('user_ai_settings', { userId: user!.id, provider: 'anthropic', model: 'm', apiKey: 'x', keyHint: '…x', updatedAt: new Date().toISOString() });
  const temporary = await call('POST', `/api/c/${cid}/members/${newcomer}/reset-password`, { mode: 'temporary' }, ines);
  assert.equal(temporary.status, 200, JSON.stringify(temporary.json));
  assert.ok(temporary.json.temporaryPassword);
  assert.equal(await one('SELECT user_id FROM user_ai_settings WHERE user_id = ?', user!.id), undefined,
    'whoever signs in with a password someone else set is not known to be the person who stored the key');
});

test('an invitation, a sign-up and a forgotten password take one plain address', async () => {
  for (const email of ['a@example.com, b@example.com', 'Name <a@example.com>', 'a@exa"mple.com']) {
    assert.equal((await call('POST', `/api/c/${cid}/members`, { email, role: 'VIEWER' }, ines)).status, 400, email);
    assert.equal((await call('POST', '/api/auth/register', { email, name: 'Some One', password: 'some-pass-1' })).status, 400, email);
    assert.equal((await call('POST', '/api/auth/forgot', { email })).status, 400, email);
  }
});
