/**
 * Saved scenarios, and the company boundary around them.
 *
 * A scenario is updated by the id in the path, and the helper that writes it
 * matches on that id alone. So the row has to be confirmed as this company's
 * before anything is written, or an administrator of one company could rewrite
 * another company's modelling by knowing its id, and read it back in the reply.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
const { one } = await import('../src/db.ts');

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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const mine = (await call('POST', '/api/companies', { name: 'Modelling Co' }, admin)).json.id as string;
const theirs = (await call('POST', '/api/companies', { name: 'Someone Else Ltd' }, admin)).json.id as string;

test('a scenario can be saved and then revised in its own company', async () => {
  const saved = await call('POST', `/api/c/${mine}/scenarios`, {
    name: 'Series A at 20m', type: 'ROUND', payload: { preMoney: 20_000_000_00 },
  }, admin);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  const revised = await call('PATCH', `/api/c/${mine}/scenarios/${saved.json.id}`, {
    name: 'Series A at 24m', payload: { preMoney: 24_000_000_00 },
  }, admin);
  assert.equal(revised.status, 200, JSON.stringify(revised.json));
  assert.equal(revised.json.name, 'Series A at 24m');
  assert.equal(JSON.parse(String(revised.json.payload)).preMoney, 24_000_000_00);
});

test('a scenario belonging to another company cannot be rewritten through this one', async () => {
  const hers = (await call('POST', `/api/c/${theirs}/scenarios`, {
    name: 'Their confidential model', type: 'ROUND', payload: { preMoney: 80_000_000_00 },
  }, admin)).json;

  // Same administrator, but acting through a company that does not own the row.
  const reach = await call('PATCH', `/api/c/${mine}/scenarios/${hers.id}`, {
    name: 'Rewritten from outside', payload: { preMoney: 1 },
  }, admin);
  assert.equal(reach.status, 404, 'knowing an id is not permission');

  const row = await one<{ name: string; payload: string }>('SELECT name, payload FROM scenarios WHERE id = ?', hers.id);
  assert.equal(row!.name, 'Their confidential model', 'untouched');
  assert.equal(JSON.parse(row!.payload).preMoney, 80_000_000_00);
});

test('and the refusal tells the caller nothing about the other company', async () => {
  const hers = (await call('POST', `/api/c/${theirs}/scenarios`, {
    name: 'Another private model', type: 'EXIT', payload: { exitValue: 5 },
  }, admin)).json;

  // An empty body still writes updatedAt, so it has to be refused as well.
  const reach = await call('PATCH', `/api/c/${mine}/scenarios/${hers.id}`, {}, admin);
  assert.equal(reach.status, 404);
  assert.ok(!JSON.stringify(reach.json).includes('Another private model'), 'no contents leak back');

  const listed = await call('GET', `/api/c/${mine}/scenarios`, undefined, admin);
  assert.ok(!listed.json.some((s: any) => s.id === hers.id), 'and it never appears in this company');
});
