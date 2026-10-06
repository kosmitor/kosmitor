/**
 * The sample company is for exploring: every read works, every change is
 * refused with a clear message, and only housekeeping (who may look at it,
 * removing the sample) goes through.
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
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/data.ts');
await import('../src/routes/imports.ts');
const { createSampleCompany } = await import('../src/sample.ts');
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
  return { status: res.status, json: (await res.json()) as any };
}

const cid = await createSampleCompany('founder@example.com');
const owner = (await call('POST', '/api/auth/login', { email: 'founder@example.com', password: 'password123' })).json.token as string;

test('the sample company is flagged and fully readable', async () => {
  const flag = await one<{ is_sample: number }>('SELECT is_sample FROM companies WHERE id = ?', cid);
  assert.equal(Number(flag!.is_sample), 1);
  const me = await call('GET', '/api/auth/me', undefined, owner);
  assert.equal(Number(me.json.companies.find((c: any) => c.id === cid).isSample), 1);
  const table = await call('GET', `/api/c/${cid}/captable`, undefined, owner);
  assert.equal(table.status, 200);
  assert.ok(table.json.table.rows.length > 10);
});

test('changes to sample records are refused, whatever the role allows elsewhere', async () => {
  const stakeholder = await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Intruder', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, owner);
  assert.equal(stakeholder.status, 403);
  assert.match(stakeholder.json.error, /sample data/);
  const company = await call('PATCH', `/api/c/${cid}`, { name: 'Renamed' }, owner);
  assert.equal(company.status, 403);
  const before = await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', cid);
  assert.equal(before!.name, 'Marlowe Systems');
});

test('calculations that only read still run on the sample: modelling and the import wizard up to review', async () => {
  const model = await call('POST', `/api/c/${cid}/model/round`, { preMoney: 1_000_000_000, newMoney: 200_000_000, poolTopUpPct: 0 }, owner);
  assert.notEqual(model.status, 403, JSON.stringify(model.json));
  const detect = await call('POST', `/api/c/${cid}/imports/detect`, { preferredKind: 'stakeholders', sheets: [{ name: 'People', headers: ['Name', 'Email'], rowCount: 1 }] }, owner);
  assert.equal(detect.status, 200);
  const commit = await call('POST', `/api/c/${cid}/imports/workbook/commit`, { sheets: [] }, owner);
  assert.equal(commit.status, 403);
  assert.match(commit.json.error, /sample data/);
});

test('housekeeping still works: sharing the sample, and removing it', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'guest@example.com', name: 'Guest', role: 'VIEWER' }, owner);
  assert.equal(invite.status, 200);
  const remove = await call('DELETE', `/api/c/${cid}/members/${invite.json.id}`, undefined, owner);
  assert.equal(remove.status, 200);
  const gone = await call('DELETE', `/api/c/${cid}?confirm=${encodeURIComponent('Marlowe Systems')}`, undefined, owner);
  assert.equal(gone.status, 200);
  assert.equal(await one('SELECT id FROM companies WHERE id = ?', cid), undefined);
});
