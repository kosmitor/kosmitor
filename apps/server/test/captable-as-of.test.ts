/**
 * A cap table viewed as of an earlier date (math audit CAP-1): the routes change a
 * certificate, grant or convertible in place, so before the fix every past view
 * read today's statuses and quantities. Each event below goes through its route,
 * which also writes a dated ledger entry; the store loads the ledger and the engine
 * undoes what is dated after the view (docs/design/dated-ledger.md, Option A).
 *
 * Facts, fictional: 4,500,000 (CS-1) and 3,500,000 (CS-2) common issued 2020-01-15,
 * 200,000 vested options from a 2,000,000 plan, a $500,000 post-money SAFE from 2022.
 * Before any event the table is 8,000,000 outstanding and 10,000,000 fully diluted.
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
await import('../src/routes/workflows.ts');
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

const admin = (await call('POST', '/api/auth/register', { email: 'wren@example.com', name: 'Wren Ashby', password: 'wren-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Ledger Co', incorporationDate: '2020-01-01', authorizedCommon: 20_000_000 }, admin)).json.id as string;
const post = async (path: string, body: unknown) => {
  const r = await call('POST', `/api/c/${cid}${path}`, body, admin);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.json)}`);
  return r.json;
};
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vested = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
const person = async (name: string, relation: string) => (await post('/stakeholders', { name, type: 'INDIVIDUAL', relation })).id as string;
const founder = await person('Wren Ashby', 'FOUNDER');
const cofounder = await person('Idris Vale', 'FOUNDER');
const buyer = await person('Noor Kessler', 'INVESTOR');
const optionee = await person('Tamsin Roe', 'EMPLOYEE');
const fund = (await post('/stakeholders', { name: 'Harrow Ventures', type: 'FUND', relation: 'INVESTOR' })).id as string;
const cs1 = (await post('/issuances', { stakeholderId: founder, shareClassId: common, quantity: 4_500_000, pricePerShare: 100, issueDate: '2020-01-15', certificateNo: 'CS-1' })).id as string;
const cs2 = (await post('/issuances', { stakeholderId: cofounder, shareClassId: common, quantity: 3_500_000, pricePerShare: 100, issueDate: '2020-01-15', certificateNo: 'CS-2' })).id as string;
const plan = (await post('/pools', { name: '2020 Stock Plan', shareClassId: common, authorized: 2_000_000, boardApprovalDate: '2020-01-15', returnForfeitures: 1, planType: 'STOCK_PLAN' })).id as string;
const grant = (await post('/awards', {
  stakeholderId: optionee, poolId: plan, type: 'NSO', quantity: 200_000, strikePrice: 100_000, grantDate: '2021-03-01',
  vestingScheduleId: vested, status: 'OUTSTANDING', expirationDate: '2031-03-01', fmvAtGrant: 100_000,
})).id as string;
const safe = (await post('/convertibles', {
  stakeholderId: fund, instrument: 'SAFE_POST', principal: 500_000_00, valuationCap: 10_000_000_00, issueDate: '2022-03-01', status: 'OUTSTANDING',
})).id as string;

async function view(asOf?: string, includeConvertibles = false) {
  const q = new URLSearchParams({ ...(asOf ? { asOf } : {}), ...(includeConvertibles ? { includeConvertibles: 'true' } : {}) });
  const r = await call('GET', `/api/c/${cid}/captable?${q}`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const t = r.json.table;
  const of = (id: string) => t.rows.find((x: any) => x.stakeholderId === id) ?? { outstanding: 0, optionsOutstanding: 0, convertiblePrincipal: 0 };
  return { t, of, counts: [t.totals.outstanding, t.totals.optionsOutstanding, t.totals.poolAvailable, t.totals.fullyDiluted] };
}

test('before any event: 8,000,000 outstanding, 200,000 options, 1,800,000 unallocated, 10,000,000 fully diluted', async () => {
  assert.deepEqual((await view('2023-01-01')).counts, [8_000_000, 200_000, 1_800_000, 10_000_000]);
});

test('OCF StockTransfer: after 1,000,000 of CS-1 are transferred on 2024-06-01, the 2023 view still shows the founder with 4,500,000 (CAP-1)', async () => {
  // Before the fix the 2023 view read 7,000,000 outstanding and 9,000,000 fully diluted.
  await post(`/issuances/${cs1}/transfer`, { toStakeholderId: buyer, quantity: 1_000_000, date: '2024-06-01', pricePerShare: 5_000_000 });
  const then = await view('2023-01-01');
  assert.deepEqual(then.counts, [8_000_000, 200_000, 1_800_000, 10_000_000]);
  assert.deepEqual([then.of(founder).outstanding, then.of(buyer).outstanding], [4_500_000, 0]);
  const now = await view('2024-06-15');
  assert.deepEqual([now.of(founder).outstanding, now.of(buyer).outstanding], [3_500_000, 1_000_000]);
  assert.deepEqual(now.counts, [8_000_000, 200_000, 1_800_000, 10_000_000]);
  // The buyer's $5 a share is not money the company raised (CAP-9): $800 before and after.
  assert.deepEqual([then.t.totals.investedAmount, now.t.totals.investedAmount], [800_00, 800_00]);
  // The holder's page lists the certificate as it stood.
  const position = await call('GET', `/api/c/${cid}/stakeholders/${founder}/position?asOf=2023-01-01`, undefined, admin);
  assert.deepEqual(position.json.issuances.map((i: any) => i.quantity), [4_500_000]);
});

test('OCF EquityCompensationExercise: an exercise on 2024-07-01 leaves the options in every earlier view (CAP-1)', async () => {
  await post(`/awards/${grant}/exercise`, { quantity: 50_000, exerciseDate: '2024-07-01', method: 'CASH' });
  assert.deepEqual((await view('2024-06-15')).counts, [8_000_000, 200_000, 1_800_000, 10_000_000]);
  const now = await view('2024-07-15');
  assert.deepEqual(now.counts, [8_050_000, 150_000, 1_800_000, 10_000_000]);
  assert.equal(now.of(optionee).optionsExercised, 50_000);
});

test('OCF EquityCompensationCancellation: a cancellation on 2024-08-01 returns options to the plan from that day only (CAP-1)', async () => {
  // Before the fix every earlier view showed the cancelled options already back in the plan.
  await post(`/awards/${grant}/cancel`, { quantity: 50_000, date: '2024-08-01' });
  assert.deepEqual((await view('2024-07-15')).counts, [8_050_000, 150_000, 1_800_000, 10_000_000]);
  assert.deepEqual((await view('2024-08-15')).counts, [8_050_000, 100_000, 1_850_000, 10_000_000]);
});

test('OCF StockRepurchase: CS-2 repurchased in full on 2024-09-01 is outstanding in every earlier view (CAP-1)', async () => {
  await post(`/issuances/${cs2}/repurchase`, { date: '2024-09-01' });
  const before = await view('2024-08-15');
  assert.equal(before.of(cofounder).outstanding, 3_500_000);
  assert.deepEqual((await view('2024-09-15')).counts, [4_550_000, 100_000, 1_850_000, 6_500_000]);
  assert.equal((await view('2021-01-01')).of(cofounder).outstanding, 3_500_000);
});

test('OCF ConvertibleConversion: a SAFE converted on 2024-10-01 is outstanding before, and the dilution history agrees with the as-of table (CAP-1)', async () => {
  // Before the fix the converted SAFE was gone from every earlier view and from the history.
  const seed = await post('/share-classes', { name: 'Series Seed Preferred', kind: 'PREFERRED', authorized: 2_000_000, issueDate: '2024-10-01', originalIssuePrice: 950_000, conversionRatio: 1, isConvertible: 1, seniority: 1 });
  await post(`/convertibles/${safe}/convert`, { shareClassId: seed.id, shares: 526_315, date: '2024-10-01', pricePerShare: 950_000 });
  const then = await view('2023-01-01', true);
  assert.equal(then.of(fund).convertiblePrincipal, 500_000_00);
  // $500,000 at a $10,000,000 post-money cap owns 5%: 10,000,000 / 0.95 = 10,526,315 (YC guide §C.1).
  assert.equal(then.t.totals.fullyDiluted, 10_526_315);
  const after = await view('2024-10-15', true);
  assert.deepEqual([after.of(fund).convertiblePrincipal, after.of(fund).outstanding], [0, 526_315]);

  const history = (await call('GET', `/api/c/${cid}/captable/history`, undefined, admin)).json;
  const point = history.points.find((p: any) => p.date === '2022-03-01');
  assert.equal(point.shares.Convertibles, 526_315, JSON.stringify(history.points));
  for (const p of history.points) {
    assert.equal(p.fullyDiluted, (await view(p.date, true)).t.totals.fullyDiluted, `history point ${p.date}`);
  }
});

test('today\'s view is the view of the last event\'s date: nothing dated later is undone', async () => {
  assert.deepEqual((await view()).t.totals, (await view('2024-10-15')).t.totals);
});

test('a certificate cannot be closed by an edit, which the ledger could not date: the transfer route does it', async () => {
  const edited = (await post('/issuances', { stakeholderId: buyer, shareClassId: common, quantity: 10_000, pricePerShare: 100, issueDate: '2021-01-01', certificateNo: 'CS-3' })).id as string;
  assert.equal((await view('2022-01-01')).of(buyer).outstanding, 10_000);
  const r = await call('PATCH', `/api/c/${cid}/issuances/${edited}`, { status: 'TRANSFERRED' }, admin);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /transfer/);
  assert.equal((await view('2022-01-01')).of(buyer).outstanding, 10_000);
});
