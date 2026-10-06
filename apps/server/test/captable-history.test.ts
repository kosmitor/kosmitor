/**
 * The dilution history behind the cap table chart: one point per round, each
 * split into bands that add up to the fully diluted total, and closed to the
 * roles that may not see the whole register.
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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'History Co', incorporationDate: '2021-01-01' }, admin)).json.id as string;
const classes = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json;
const common = classes[0];
const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Avery Stone', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json;
const fund = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Northwind Ventures', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
await call('POST', `/api/c/${cid}/issuances`, { stakeholderId: founder.id, shareClassId: common.id, quantity: 8_000_000, issueDate: '2021-01-01' }, admin);
const seed = (await call('POST', `/api/c/${cid}/share-classes`, { name: 'Seed Preferred', kind: 'PREFERRED', authorized: 3_000_000, issueDate: '2023-06-01', originalIssuePrice: 1_000_000 }, admin)).json;
await call('POST', `/api/c/${cid}/issuances`, { stakeholderId: fund.id, shareClassId: seed.id, quantity: 2_000_000, pricePerShare: 1_000_000, issueDate: '2023-06-01' }, admin);

test('one point per round, oldest class at the bottom of the stack', async () => {
  const r = await call('GET', `/api/c/${cid}/captable/history`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.points.map((p: any) => p.date), ['2021-01-01', '2023-06-01']);
  assert.deepEqual(r.json.points.map((p: any) => p.label), ['Common', 'Seed Preferred']);
  assert.equal(r.json.bands[0], 'Common', 'the founding class anchors the stack');
  assert.ok(r.json.bands.includes('Seed Preferred'));
});

test('each point adds up to its fully diluted total, and the founders are diluted', async () => {
  const { bands, points } = (await call('GET', `/api/c/${cid}/captable/history`, undefined, admin)).json;
  for (const p of points) {
    const stacked = bands.reduce((n: number, b: string) => n + p.shares[b], 0);
    assert.equal(stacked, p.fullyDiluted, `bands do not add up at ${p.date}`);
  }
  const [founding, seed] = points;
  assert.equal(founding.shares['Seed Preferred'], 0, 'a class contributes nothing before it is issued');
  assert.equal(seed.shares['Seed Preferred'], 2_000_000);
  assert.equal(founding.shares.Common, seed.shares.Common, 'the common band holds its shares');
  assert.ok(seed.fullyDiluted > founding.fullyDiluted, 'the total grows around it');
});

test('a holder who cannot see the whole register cannot see the history either', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'northwind@example.com', name: 'Northwind Ventures', role: 'INVESTOR', stakeholderId: fund.id }, admin);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const investor = (await call('POST', '/api/auth/reset', { token, password: 'northwind-pass-1' })).json.token as string;

  const r = await call('GET', `/api/c/${cid}/captable/history`, undefined, investor);
  assert.notEqual(r.status, 200, 'the dilution history is the whole cap table in another shape');
});
