/**
 * A person's own preferences. They follow the person rather than the browser,
 * each can be saved on its own, and none of them can be used to put something
 * other than what it says into the page: a colour is a colour.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const token = (await call('POST', '/api/auth/register', { email: 'rae@example.com', name: 'Rae Lindqvist', password: 'rae-pass-123' })).token as string;

test('explanations start closed, and the choice to open them follows the person', async () => {
  const before = await call('GET', '/api/auth/me', undefined, token);
  assert.equal(before.json.user.explanationsOpen, false);

  const saved = await call('PATCH', '/api/auth/me', { explanationsOpen: true }, token);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.explanationsOpen, true);

  // A second sign-in, as from another browser, sees the same choice.
  const again = (await call('POST', '/api/auth/login', { email: 'rae@example.com', password: 'rae-pass-123' })).token as string;
  assert.equal((await call('GET', '/api/auth/me', undefined, again)).json.user.explanationsOpen, true);
});

test('each preference saves on its own and leaves the others as they were', async () => {
  const renamed = await call('PATCH', '/api/auth/me', { name: '  Rae   Lindqvist-Hart ' }, token);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.name, 'Rae Lindqvist-Hart', 'spacing tidied');
  assert.equal(renamed.json.explanationsOpen, true, 'untouched by a name change');

  const nothing = await call('PATCH', '/api/auth/me', {}, token);
  assert.equal(nothing.status, 200, 'an empty save is not an error');
  assert.equal(nothing.json.name, 'Rae Lindqvist-Hart');
});

test('a colour is a colour, and a name cannot be emptied', async () => {
  const ok = await call('PATCH', '/api/auth/me', { avatarColor: '#00A389' }, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.avatarColor, '#00a389');

  for (const bad of ['red', '#fff', 'url(https://example.com/x.png)', '#00a389; background-image:none', '']) {
    const r = await call('PATCH', '/api/auth/me', { avatarColor: bad }, token);
    assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal((await call('PATCH', '/api/auth/me', { name: '   ' }, token)).status, 400);
  assert.equal((await call('PATCH', '/api/auth/me', { explanationsOpen: 'yes' }, token)).status, 400);
});

test('only a signed-in person can change their own preferences', async () => {
  assert.equal((await call('PATCH', '/api/auth/me', { name: 'Someone' })).status, 401);
});

test('a name cannot carry an address, invisible characters, or nothing at all', async () => {
  for (const bad of ['Rae <thief@example.net>', 'Rae "the boss"', 'Rae\u0000', '\u200b\u200b', '\u202eeaR', '...']) {
    const r = await call('PATCH', '/api/auth/me', { name: bad }, token);
    assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
  }
  const reg = await call('POST', '/api/auth/register', { email: 'sly@example.com', name: 'Sly <thief@example.net>', password: 'sly-pass-123' });
  assert.equal(reg.status, 400, 'nor at sign-up');
  const ok = await call('PATCH', '/api/auth/me', { name: 'Zoë Smith, Jr.' }, token);
  assert.equal(ok.status, 200, 'accents and commas are ordinary in names');
});

test('a rename is written to the audit trail, and every endpoint returns the same user', async () => {
  const { all } = await import('../src/db.ts');
  const rows = await all<{ detail: string }>("SELECT detail FROM audit_log WHERE entity_type = 'users' AND action = 'UPDATE' ORDER BY created_at");
  assert.ok(rows.some((r) => /^Name changed from .+ to Zoë Smith, Jr\.$/.test(r.detail)), JSON.stringify(rows));

  const login = (await call('POST', '/api/auth/login', { email: 'rae@example.com', password: 'rae-pass-123' })).json.user;
  const me = (await call('GET', '/api/auth/me', undefined, token)).json.user;
  const saved = (await call('PATCH', '/api/auth/me', {}, token)).json;
  for (const u of [login, me, saved]) {
    assert.deepEqual([typeof u.explanationsOpen, typeof u.googleLinked, typeof u.mustChangePassword], ['boolean', 'boolean', 'boolean']);
  }
  assert.equal(me.googleLinked, false);
});
