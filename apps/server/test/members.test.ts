/**
 * Editing a team member over HTTP: an administrator changes the person's
 * name, sign-in email, role and linked stakeholder in one call, and the
 * guards refuse a taken email, an unknown role, a foreign stakeholder and
 * demoting the last administrator.
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
const { insert } = await import('../src/db.ts');

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
await call('POST', '/api/auth/register', { email: 'bo@example.com', name: 'Bo Other', password: 'bo-pass-1234' });
const cid = (await call('POST', '/api/companies', { name: 'Members Co' }, admin)).json.id as string;
const now = new Date().toISOString();
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
const invite = await call('POST', `/api/c/${cid}/members`, { email: 'p.raman@example.com', name: 'P Raman', role: 'VIEWER' }, admin);
assert.equal(invite.status, 200);
const memberId = invite.json.id as string;

test('an administrator edits a member’s name, email, role and linked stakeholder in one call', async () => {
  const r = await call('PATCH', `/api/c/${cid}/members/${memberId}`,
    { name: 'Priya Raman', email: 'Priya.Raman@Example.com', role: 'LEGAL', stakeholderId: 'stk_priya' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.name, 'Priya Raman');
  assert.equal(r.json.email, 'priya.raman@example.com'); // stored lower-case, as sign-in compares
  assert.equal(r.json.role, 'LEGAL');
  assert.equal(r.json.stakeholderId, 'stk_priya');

  const list = await call('GET', `/api/c/${cid}/members`, undefined, admin);
  const priya = list.json.find((m: any) => m.id === memberId);
  assert.deepEqual({ name: priya.name, email: priya.email, role: priya.role, stakeholderId: priya.stakeholderId },
    { name: 'Priya Raman', email: 'priya.raman@example.com', role: 'LEGAL', stakeholderId: 'stk_priya' });

  // Fields left out of the body stay as they are.
  const unlink = await call('PATCH', `/api/c/${cid}/members/${memberId}`, { stakeholderId: null }, admin);
  assert.equal(unlink.json.stakeholderId, null);
  assert.equal(unlink.json.role, 'LEGAL');
  assert.equal(unlink.json.name, 'Priya Raman');
});

test('the guards refuse a taken email, an unknown role, a foreign stakeholder and demoting the last administrator', async () => {
  const taken = await call('PATCH', `/api/c/${cid}/members/${memberId}`, { email: 'bo@example.com' }, admin);
  assert.equal(taken.status, 400);
  assert.match(taken.json.error, /another account/);

  const malformed = await call('PATCH', `/api/c/${cid}/members/${memberId}`, { email: 'not-an-email' }, admin);
  assert.equal(malformed.status, 400);

  const role = await call('PATCH', `/api/c/${cid}/members/${memberId}`, { role: 'KING' }, admin);
  assert.equal(role.status, 400);

  const foreign = await call('PATCH', `/api/c/${cid}/members/${memberId}`, { stakeholderId: 'stk_elsewhere' }, admin);
  assert.equal(foreign.status, 400);
  assert.match(foreign.json.error, /does not belong/);

  const members = await call('GET', `/api/c/${cid}/members`, undefined, admin);
  const me = members.json.find((m: any) => m.email === 'avery@example.com');
  const demote = await call('PATCH', `/api/c/${cid}/members/${me.id}`, { role: 'VIEWER' }, admin);
  assert.equal(demote.status, 400);
  assert.match(demote.json.error, /at least one administrator/);

  // A second administrator makes the demotion legitimate.
  await call('PATCH', `/api/c/${cid}/members/${memberId}`, { role: 'ADMIN' }, admin);
  const demoteNow = await call('PATCH', `/api/c/${cid}/members/${me.id}`, { role: 'LEGAL' }, admin);
  assert.equal(demoteNow.status, 200);
  assert.equal(demoteNow.json.role, 'LEGAL');
});

test('only administrators can edit members', async () => {
  // Avery is LEGAL now; the route requires ADMIN.
  const r = await call('PATCH', `/api/c/${cid}/members/${memberId}`, { name: 'Nope' }, admin);
  assert.equal(r.status, 403);
});
