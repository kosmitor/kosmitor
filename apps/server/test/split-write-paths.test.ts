/**
 * Transfers and exercises after a stock split (math audit CAP-2). A certificate or
 * grant keeps the share count and price of the day it was recorded, and the cap table
 * applies a later split when it is read. A row written for the event is dated after the
 * split, so it must be written in post-split shares, or a transfer or exercise changes
 * the fully diluted total.
 *
 * Facts, fictional: 4,500,000 and 3,500,000 common issued 2020-01-15, 200,000 vested
 * options at $0.10 and a 2,000,000 plan; a 2-for-1 split on 2023-01-01. Before any event
 * the cap table is 16,000,000 outstanding and 20,000,000 fully diluted (SEC, "Stock
 * splits": a split changes the number of shares, not what anyone owns).
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

const admin = (await call('POST', '/api/auth/register', { email: 'rowan@example.com', name: 'Rowan Hale', password: 'rowan-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Split Co', incorporationDate: '2020-01-01', authorizedCommon: 15_000_000 }, admin)).json.id as string;
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vestedAtGrant = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
const person = async (name: string, relation: string) =>
  (await call('POST', `/api/c/${cid}/stakeholders`, { name, type: 'INDIVIDUAL', relation }, admin)).json.id as string;
const founderA = await person('Rowan Hale', 'FOUNDER');
const founderB = await person('Imogen Clarke', 'FOUNDER');
const buyer = await person('Tobias Vance', 'INVESTOR');
const optionee = await person('Mara Quinn', 'EMPLOYEE');
const certificate = async (stakeholderId: string, quantity: number, issueDate = '2020-01-15') =>
  (await call('POST', `/api/c/${cid}/issuances`, { stakeholderId, shareClassId: common, quantity, pricePerShare: 100, issueDate }, admin)).json.id as string;
const certA = await certificate(founderA, 4_500_000);
const certB = await certificate(founderB, 3_500_000);
const now = new Date().toISOString();
await insert('pools', { id: 'pool_s', companyId: cid, name: 'Plan', shareClassId: common, authorized: 2_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', boardApprovalDate: '2020-01-15', createdAt: now });
await insert('awards', { id: 'awd_s', companyId: cid, label: 'OPT-7', stakeholderId: optionee, poolId: 'pool_s', type: 'NSO', quantity: 200_000, strikePrice: 100_000,
  grantDate: '2021-03-01', vestingStartDate: '2021-03-01', vestingScheduleId: vestedAtGrant, status: 'OUTSTANDING', expirationDate: '2031-03-01', ptepMonths: 3,
  earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 100_000, rsuLiquidityCondition: 0, createdAt: now });
assert.equal((await call('POST', `/api/c/${cid}/stock-splits`, { date: '2023-01-01', ratio: 2 }, admin)).status, 200);
await insert('valuations', { id: 'val_s', companyId: cid, type: '409A', fairMarketValue: 1_000_000, effectiveDate: '2024-01-01', expirationDate: '2025-12-31', status: 'ACTIVE', createdAt: now });

const totals = async (asOf: string) => {
  const t = (await call('GET', `/api/c/${cid}/captable?asOf=${asOf}`, undefined, admin)).json.table;
  return { outstanding: t.totals.outstanding, fullyDiluted: t.totals.fullyDiluted, options: t.totals.optionsOutstanding, row: (id: string) => t.rows.find((r: any) => r.stakeholderId === id) };
};

test('before any event the split doubles every count: 16,000,000 outstanding, 20,000,000 fully diluted', async () => {
  const t = await totals('2024-01-01');
  assert.deepEqual([t.outstanding, t.fullyDiluted, t.options], [16_000_000, 20_000_000, 400_000]);
});

test('a full transfer of a pre-split certificate after the split gives the buyer 9,000,000 shares, and no total moves', async () => {
  // The certificate page shows the certificate as recorded and pre-fills its 4,500,000.
  const r = await call('POST', `/api/c/${cid}/issuances/${certA}/transfer`, { toStakeholderId: buyer, quantity: 4_500_000, date: '2024-06-01' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.quantity, r.json.pricePerShare, r.json.issueDate], [9_000_000, 50, '2024-06-01']);
  const t = await totals('2024-06-15');
  assert.deepEqual([t.outstanding, t.fullyDiluted], [16_000_000, 20_000_000]);
  assert.equal(t.row(buyer).outstanding, 9_000_000);
  assert.equal(t.row(founderA), undefined);
  const ledger = await one<{ quantity: number; price_per_share: number; amount: number }>("SELECT * FROM transactions WHERE company_id = ? AND type = 'TRANSFER'", cid);
  assert.deepEqual([Number(ledger!.quantity), Number(ledger!.price_per_share), Number(ledger!.amount)], [9_000_000, 50, 450_00], 'the ledger is in the shares of its own date');
});

test('a partial transfer moves post-split shares and leaves the rest of the certificate as recorded', async () => {
  const r = await call('POST', `/api/c/${cid}/issuances/${certB}/transfer`, { toStakeholderId: buyer, quantity: 1_000_000, date: '2024-06-02' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.quantity, 2_000_000);
  assert.equal(Number((await one<{ quantity: number }>('SELECT quantity FROM issuances WHERE id = ?', certB))!.quantity), 2_500_000);
  const t = await totals('2024-06-15');
  assert.deepEqual([t.outstanding, t.fullyDiluted], [16_000_000, 20_000_000]);
  assert.deepEqual([t.row(founderB).outstanding, t.row(buyer).outstanding], [5_000_000, 11_000_000]);
});

test('exercising 200,000 pre-split options after the split issues 400,000 shares at $0.05, and fully diluted stays 20,000,000', async () => {
  // The grant page shows the grant as recorded: 200,000 options at $0.10.
  const r = await call('POST', `/api/c/${cid}/awards/awd_s/exercise`, { quantity: 200_000, exerciseDate: '2024-07-01', method: 'CASH' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.issuance.quantity, r.json.issuance.pricePerShare], [400_000, 50_000]);
  // $20,000 paid either way; the spread is 400,000 x ($1.00 - $0.05) at the post-split 409A.
  assert.deepEqual([r.json.exercise.quantity, r.json.exercise.strikePrice, r.json.exercise.totalCost, r.json.exercise.spread], [400_000, 50_000, 20_000_00, 380_000_00]);
  assert.equal(r.json.tax.spread, 380_000_00);
  const award = await one<{ exercised_quantity: number; status: string }>('SELECT * FROM awards WHERE id = ?', 'awd_s');
  assert.deepEqual([Number(award!.exercised_quantity), award!.status], [200_000, 'EXERCISED'], 'the grant keeps its own units');
  const t = await totals('2024-08-01');
  assert.deepEqual([t.outstanding, t.fullyDiluted, t.options], [16_400_000, 20_000_000, 0]);
  assert.equal(t.row(optionee).outstanding, 400_000);
});

test('with no split since the certificate, a transfer is written exactly as asked', async () => {
  const fresh = await certificate(founderB, 10_000, '2024-01-15');
  const r = await call('POST', `/api/c/${cid}/issuances/${fresh}/transfer`, { toStakeholderId: buyer, quantity: 4_000, date: '2024-09-01', pricePerShare: 2_000_000 }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.quantity, r.json.pricePerShare], [4_000, 2_000_000]);
});
