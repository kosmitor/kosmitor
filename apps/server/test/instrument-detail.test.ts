/**
 * The record behind an equity award, a convertible, a warrant and a 409A.
 *
 * Each page asks one question of the server and must be able to draw itself from
 * the answer, so what is pinned here is that the arithmetic arrives done, that
 * the parts specific to each instrument are present, and that a holder reaches
 * their own record and no one else's.
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
await import('../src/routes/instrument-detail.ts');

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
const cid = (await call('POST', '/api/companies', { name: 'Records Co' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const schedule = (await call('GET', `/api/c/${cid}/vesting-schedules`, undefined, admin)).json[0];
const priya = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;
const fund = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Kestrel Ventures', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
const pool = (await call('POST', `/api/c/${cid}/pools`, { name: 'Plan 2024', shareClassId: common.id, authorized: 1_000_000 }, admin)).json;

await call('POST', `/api/c/${cid}/valuations`, { type: '409A', fairMarketValue: 250_000, effectiveDate: '2024-01-01', provider: 'Northgate', status: 'ACTIVE' }, admin);
const award = (await call('POST', `/api/c/${cid}/awards`, {
  label: 'ISO-001', stakeholderId: priya.id, poolId: pool.id, type: 'ISO', quantity: 100_000,
  strikePrice: 100_000, fmvAtGrant: 100_000, grantDate: '2024-02-01', vestingScheduleId: schedule.id,
  expirationDate: '2034-02-01', ptepMonths: 3,
}, admin)).json;
const safe = (await call('POST', `/api/c/${cid}/convertibles`, {
  stakeholderId: fund.id, instrument: 'SAFE_POST', principal: 500_000_00, issueDate: '2024-03-01',
  valuationCap: 10_000_000_00, discount: 0.2,
}, admin)).json;
const warrant = (await call('POST', `/api/c/${cid}/warrants`, {
  stakeholderId: fund.id, shareClassId: common.id, quantity: 25_000, strikePrice: 150_000,
  issueDate: '2024-04-01', expirationDate: '2034-04-01',
}, admin)).json;

test('an equity award arrives with its money, its vesting and its deadlines worked out', async () => {
  const r = await call('GET', `/api/c/${cid}/awards/${award.id}/detail`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.award.label, 'ISO-001');
  assert.equal(r.json.holder.name, 'Priya Raman');
  assert.equal(r.json.plan.name, 'Plan 2024');

  assert.equal(r.json.amounts.outstanding, 100_000);
  assert.equal(r.json.amounts.strikePrice, 100_000);
  // Struck at $0.10 against a $0.25 valuation, so the spread is $0.15 a share.
  assert.equal(r.json.amounts.fmv, 250_000);
  assert.equal(r.json.amounts.spreadPerShare, 150_000);
  assert.equal(r.json.amounts.intrinsicValue, 15_000_00);
  assert.equal(r.json.amounts.costToExercise, 10_000_00);
  assert.equal(r.json.amounts.underwater, false);

  assert.ok(r.json.vesting, 'it vests');
  assert.ok(r.json.vesting.curve.length > 0);
  assert.equal(r.json.exercisable.expiresOn, '2034-02-01');
  assert.equal(r.json.exercisable.postTerminationDeadline, null, 'nobody has left');
  assert.ok(Array.isArray(r.json.isoLimit), 'an incentive option is subject to the hundred thousand test');
  assert.ok(Array.isArray(r.json.timeline));
});

test('an option priced above the current value says so', async () => {
  const steep = (await call('POST', `/api/c/${cid}/awards`, {
    label: 'NSO-900', stakeholderId: priya.id, poolId: pool.id, type: 'NSO', quantity: 1_000,
    strikePrice: 900_000, grantDate: '2024-05-01', vestingScheduleId: schedule.id,
  }, admin)).json;
  const r = await call('GET', `/api/c/${cid}/awards/${steep.id}/detail`, undefined, admin);
  assert.equal(r.json.amounts.underwater, true);
  assert.equal(r.json.amounts.spreadPerShare, 0, 'worth nothing rather than a negative amount');
  assert.equal(r.json.amounts.intrinsicValue, 0);
  assert.deepEqual(r.json.isoLimit, [], 'and it is not an incentive option');
});

test('a leaver gets a deadline on the page, because the clock is already running', async () => {
  await call('PATCH', `/api/c/${cid}/stakeholders/${priya.id}`, { terminationDate: '2025-06-30' }, admin);
  const r = await call('GET', `/api/c/${cid}/awards/${award.id}/detail`, undefined, admin);
  assert.equal(r.json.exercisable.postTerminationMonths, 3);
  assert.equal(r.json.exercisable.postTerminationDeadline, '2025-09-30');
  await call('PATCH', `/api/c/${cid}/stakeholders/${priya.id}`, { terminationDate: null }, admin);
});

test('a convertible carries its terms and what it would become today', async () => {
  const r = await call('GET', `/api/c/${cid}/convertibles/${safe.id}/detail`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.convertible.instrument, 'SAFE_POST');
  assert.equal(r.json.amounts.principal, 500_000_00);
  assert.equal(r.json.amounts.valuationCap, 10_000_000_00);
  assert.equal(r.json.amounts.discount, 0.2);
  assert.ok(r.json.conversion, 'the same solver the cap table uses');
  // A post-money SAFE owns principal over cap: $500k of a $10m cap is five percent.
  assert.ok(Math.abs(r.json.conversion.impliedOwnershipPct - 0.05) < 1e-9);
});

test('a warrant is valued against the current price', async () => {
  const r = await call('GET', `/api/c/${cid}/warrants/${warrant.id}/detail`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.amounts.outstanding, 25_000);
  assert.equal(r.json.shareClass.name, common.name);
  // Struck at $0.15 against $0.25, so $0.10 a share.
  assert.equal(r.json.amounts.spreadPerShare, 100_000);
  assert.equal(r.json.amounts.intrinsicValue, 2_500_00);
  assert.equal(r.json.amounts.expired, false);
});

test('a 409A shows what it priced, and flags a grant struck below it', async () => {
  const valuations = (await call('GET', `/api/c/${cid}/valuations`, undefined, admin)).json;
  const v = valuations[0];
  const r = await call('GET', `/api/c/${cid}/valuations/${v.id}/detail`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.current, true, 'nothing has replaced it');
  assert.equal(r.json.supersededBy, null);
  assert.ok(r.json.company.fullyDilutedAtEffective >= 0);

  const priced = r.json.pricedGrants.find((g: any) => g.label === 'ISO-001');
  assert.ok(priced, 'the grant made after it was the current valuation');
  assert.equal(priced.belowFairMarketValue, true, 'struck at $0.10 against a $0.25 valuation');
});

test('a holder opens their own records and no one else\'s', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE', stakeholderId: priya.id }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const holder = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).token as string;

  assert.equal((await call('GET', `/api/c/${cid}/awards/${award.id}/detail`, undefined, holder)).status, 200, 'their own grant');
  assert.equal((await call('GET', `/api/c/${cid}/convertibles/${safe.id}/detail`, undefined, holder)).status, 404, 'the fund\'s SAFE');
  assert.equal((await call('GET', `/api/c/${cid}/warrants/${warrant.id}/detail`, undefined, holder)).status, 404, 'the fund\'s warrant');
});

test('records from another company are not there', async () => {
  const elsewhere = (await call('POST', '/api/companies', { name: 'Elsewhere' }, admin)).json.id as string;
  for (const path of [`awards/${award.id}`, `convertibles/${safe.id}`, `warrants/${warrant.id}`]) {
    const r = await call('GET', `/api/c/${elsewhere}/${path}/detail`, undefined, admin);
    assert.equal(r.status, 404, path);
  }
});
