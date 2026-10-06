/**
 * Optional columns must stay optional on the way back in.
 *
 * An update sends only the fields that changed, so the server rebuilds the whole
 * record from the stored row before it validates. Every column the row does not
 * fill is null at that moment, and a check that treats null as "missing" turns
 * an untouched blank field into a refusal to save anything at all. The fields a
 * resource genuinely requires are listed on the resource, and only those may
 * complain.
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

const token = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Optional Fields Co' }, token)).json.id as string;

test('a stakeholder with no job title can be created and then edited', async () => {
  const created = await call('POST', `/c/${cid}/stakeholders`.replace(/^/, '/api'),
    { name: 'Priya Raman', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: '' }, token);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.title, null, 'a blank job title is stored as nothing, not as an empty string');

  const renamed = await call('PATCH', `/api/c/${cid}/stakeholders/${created.json.id}`, { name: 'Priya R. Raman' }, token);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.name, 'Priya R. Raman');
  assert.equal(renamed.json.title, null);

  // Filling it in, then clearing it again, both have to work.
  const given = await call('PATCH', `/api/c/${cid}/stakeholders/${created.json.id}`, { title: 'Head of Platform' }, token);
  assert.equal(given.status, 200, JSON.stringify(given.json));
  assert.equal(given.json.title, 'Head of Platform');

  const cleared = await call('PATCH', `/api/c/${cid}/stakeholders/${created.json.id}`, { title: '' }, token);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.title, null);
});

test('every other optional detail survives an update that never mentions it', async () => {
  const created = await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Kestrel Ventures II', type: 'FUND', relation: 'INVESTOR' }, token);
  assert.equal(created.status, 200, JSON.stringify(created.json));

  const patched = await call('PATCH', `/api/c/${cid}/stakeholders/${created.json.id}`, { relation: 'BOARD_MEMBER' }, token);
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  for (const field of ['title', 'department', 'email', 'phone', 'address', 'legalName', 'taxForm', 'signatoryName']) {
    assert.equal(patched.json[field], null, `${field} was left blank and must stay blank`);
  }
});

test('the fields a record really requires still refuse to be emptied', async () => {
  const nameless = await call('POST', `/api/c/${cid}/stakeholders`, { type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, token);
  assert.equal(nameless.status, 400);
  assert.match(nameless.json.error, /name is required/i);

  const untitled = await call('POST', `/api/c/${cid}/tasks`, { kind: 'GENERAL' }, token);
  assert.equal(untitled.status, 400);
  assert.match(untitled.json.error, /title is required/i);

  const task = await call('POST', `/api/c/${cid}/tasks`, { title: 'Countersign the SAFE' }, token);
  assert.equal(task.status, 200, JSON.stringify(task.json));
  const emptied = await call('PATCH', `/api/c/${cid}/tasks/${task.json.id}`, { title: '' }, token);
  assert.equal(emptied.status, 400, 'a task without a title is not a task');
  assert.match(emptied.json.error, /title is required/i);

  // ...and a task keeps updating fine while its own optional detail is blank.
  const moved = await call('PATCH', `/api/c/${cid}/tasks/${task.json.id}`, { status: 'DONE' }, token);
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.detail, null);
});
