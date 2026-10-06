/**
 * Fixes made in the engine reach the people using the routes: a round no price
 * solves is refused with its reason (CR-2), Rule 701 measures the class at the
 * company's own fiscal year end (TAX-11), each cancellation of a grant reverses
 * its cost from its own date (VA-18), an exercise after a split pays in the
 * aggregate exercise price to the cent (CAP-3), and a leaver's lapsed options
 * leave the appraiser's workbook and the grant page as they leave the cap table
 * (CAP-4).
 *
 * Every company, person and figure here is invented.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie, insertSecurity } from './helpers.ts';

delete process.env.SMTP_URL;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/instrument-detail.ts');
await import('../src/routes/valuation-requests.ts');
const { insert, one, run } = await import('../src/db.ts');
const { parseXlsx } = await import('../src/import/xlsx.ts');
const { getCompanyData, invalidate } = await import('../src/store.ts');
const { config } = await import('../src/config.ts');
const { stockCompReport } = await import('@kosmitor/core');

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

const admin = (await call('POST', '/api/auth/register', { email: 'tamsin.okafor@example.com', name: 'Tamsin Okafor', password: 'tamsin-pass-1' })).token as string;
const now = new Date().toISOString();

/** A company with one founder holding `founderShares` common from 2024-01-15, and its common class. */
async function newCompany(name: string, founderShares: number) {
  const cid = (await call('POST', '/api/companies', { name, incorporationDate: '2023-11-01', authorizedCommon: 50_000_000 }, admin)).json.id as string;
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Odile Varga', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json.id as string;
  await insertSecurity('issuances', { id: `iss_${cid}`, companyId: cid, certificateNo: 'CS-1', stakeholderId: founder, shareClassId: common, quantity: founderShares,
    pricePerShare: 100, issueDate: '2024-01-15', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
  await insert('pools', { id: `pool_${cid}`, companyId: cid, name: 'Plan', shareClassId: common, authorized: 5_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', boardApprovalDate: '2023-12-01', createdAt: now });
  const schedule = async (kind: string) => (await one<{ id: string }>('SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = ? ORDER BY duration_months DESC LIMIT 1', cid, kind))!.id;
  invalidate(cid);
  return { cid, common, founder, pool: `pool_${cid}`, fourYear: await schedule('TIME'), vested: await schedule('FULLY_VESTED') };
}

async function grant(c: Awaited<ReturnType<typeof newCompany>>, holder: string, o: Record<string, unknown>) {
  const id = String(o.id ?? `aw_${Math.random().toString(36).slice(2, 10)}`);
  await insertSecurity('awards', {
    id, companyId: c.cid, label: id.toUpperCase(), stakeholderId: holder, poolId: c.pool, type: 'NSO', quantity: 48_000, strikePrice: 100_000,
    grantDate: '2023-01-01', vestingStartDate: '2023-01-01', vestingScheduleId: c.fourYear, status: 'OUTSTANDING', expirationDate: '2033-01-01', ptepMonths: 3,
    earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 100_000, rsuLiquidityCondition: 0, createdAt: now, ...o,
  });
  invalidate(c.cid);
  return id;
}

test('a round no price solves is refused with the reason, not a server error', async () => {
  // 10,000,000 shares; an uncapped $6M pre-money SAFE converting at the round price out of a $5M pre-money
  // takes 120% of it (math audit CR-2). Before the fix the route answered 500 "Something went wrong".
  const c = await newCompany('Roundless Co', 10_000_000);
  const investor = (await call('POST', `/api/c/${c.cid}/stakeholders`, { name: 'Pike Hollow Ventures', type: 'ENTITY', relation: 'INVESTOR' }, admin)).json.id as string;
  await insertSecurity('convertibles', { id: 'cnv_r', companyId: c.cid, stakeholderId: investor, instrument: 'SAFE_PRE', principal: 6_000_000_00, issueDate: '2024-06-01',
    valuationCap: null, discount: 0, interestRate: 0, compounding: 'SIMPLE', mfn: 0, proRataRight: 0, status: 'OUTSTANDING', createdAt: now });
  invalidate(c.cid);
  const round = (preMoney: number) => call('POST', `/api/c/${c.cid}/model/round`, {
    name: 'Series A', closeDate: '2025-01-15', preMoney, investors: [{ name: 'Lead', amount: 2_000_000_00 }], targetPoolPct: 0, poolFromPreMoney: true,
  }, admin);
  const refused = await round(5_000_000_00);
  assert.equal(refused.status, 400, JSON.stringify(refused.json));
  assert.match(refused.json.error, /^No round price solves these terms: the converting SAFEs and notes would take 120% of the pre-money valuation\./);
  // A pre-money the SAFE leaves room in still prices: $6M of $12M is half the pre-money shares.
  assert.equal((await round(12_000_000_00)).status, 200);
});

test('Rule 701 measures the class at the company\'s own fiscal year end', async () => {
  // A June 30 year end: 10,000,000 common at 2025-06-30, 10,000,000 more issued 2025-09-01. As of 2026-03-01 the
  // last balance sheet date is 2025-06-30 and the class is 10,000,000 (17 CFR 230.701(d)(2)(iii); math audit
  // TAX-11). Before the fix the route measured it at 2025-12-31, 20,000,000, whatever the fiscal year.
  const c = await newCompany('Midyear Co', 10_000_000);
  await insertSecurity('issuances', { id: 'iss_mid_2', companyId: c.cid, certificateNo: 'CS-2', stakeholderId: c.founder, shareClassId: c.common, quantity: 10_000_000,
    pricePerShare: 100, issueDate: '2025-09-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
  await run("UPDATE companies SET fiscal_year_end = '06-30' WHERE id = ?", c.cid);
  invalidate(c.cid);
  const r = await call('GET', `/api/c/${c.cid}/compliance?asOf=2026-03-01`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.rule701.balanceSheetDate, r.json.rule701.outstandingShares], ['2025-06-30', 10_000_000]);
});

test('a grant cancelled in two steps reverses its cost from each date, not all from the first', async () => {
  // 48,000 RSUs at $1, 4y/1y from 2023-01-01; 10,000 cancelled on 2024-03-01 and 20,000 on 2025-03-01 (math
  // audit VA-18). The FY2024 report must keep the cost of the 20,000 until 2025; before the fix the route passed
  // only the first date and reversed all 30,000 from it.
  const c = await newCompany('Twostep Co', 5_000_000);
  const employee = (await call('POST', `/api/c/${c.cid}/stakeholders`, { name: 'Bram Calloway', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json.id as string;
  const id = await grant(c, employee, { type: 'RSU', strikePrice: 0, fmvAtGrant: 1_000_000, expirationDate: null });
  for (const [quantity, date] of [[10_000, '2024-03-01'], [20_000, '2025-03-01']] as const) {
    assert.equal((await call('POST', `/api/c/${c.cid}/awards/${id}/cancel`, { quantity, date }, admin)).status, 200);
  }
  const route = await call('GET', `/api/c/${c.cid}/reports/stock-comp?year=2024&asOf=2026-01-01`, undefined, admin);
  assert.equal(route.status, 200, JSON.stringify(route.json));
  const data = await getCompanyData(c.cid);
  const opts = { asOf: '2026-01-01', fiscalYearEnd: config().company.fiscalYearEnd, assumptions: config().stockComp.defaultAssumptions };
  const twoSteps = stockCompReport(data, 2024, { ...opts, cancellations: { [id]: [{ date: '2024-03-01', quantity: 10_000 }, { date: '2025-03-01', quantity: 20_000 }] } });
  const fromFirst = stockCompReport(data, 2024, { ...opts, cancellationDates: { [id]: '2024-03-01' } });
  assert.notEqual(twoSteps.totals.cumulative, fromFirst.totals.cumulative);
  assert.equal(route.json.report.totals.cumulative, twoSteps.totals.cumulative);
});

test('300,000 options at $0.10 exercised after a 3-for-1 split pay in $30,000.00, in the exercise and in the cap table', async () => {
  // The certificate holds 900,000 shares at the strike as stored, $0.033333, but the aggregate exercise price is
  // not reduced (26 CFR 1.424-1(e)(4)(v); math audit CAP-3). Before the fix the cap table counted $29,999.70.
  const c = await newCompany('Thirds Co', 8_000_000);
  const optionee = (await call('POST', `/api/c/${c.cid}/stakeholders`, { name: 'Ines Halloran', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json.id as string;
  const id = await grant(c, optionee, { quantity: 300_000, grantDate: '2022-05-02', vestingStartDate: '2022-05-02', vestingScheduleId: c.vested, expirationDate: '2032-05-02' });
  assert.equal((await call('POST', `/api/c/${c.cid}/stock-splits`, { date: '2024-02-01', ratio: 3 }, admin)).status, 200);
  const exercise = await call('POST', `/api/c/${c.cid}/awards/${id}/exercise`, { quantity: 300_000, exerciseDate: '2024-06-03', method: 'CASH' }, admin);
  assert.equal(exercise.status, 200, JSON.stringify(exercise.json));
  assert.deepEqual([exercise.json.issuance.quantity, exercise.json.issuance.pricePerShare, exercise.json.exercise.totalCost], [900_000, 33_333, 30_000_00]);
  const table = (await call('GET', `/api/c/${c.cid}/captable?asOf=2024-07-01`, undefined, admin)).json.table;
  assert.equal(table.rows.find((r: any) => r.stakeholderId === optionee).investedAmount, 30_000_00);
});

test('a leaver\'s unvested options leave the grant page and the appraiser\'s workbook as they leave the cap table', async () => {
  // 48,000 NSOs, 4y/1y from 2023-01-01; the holder left 2024-07-01 with 18/48 vested, 18,000 (math audit CAP-4).
  // Before the fix the grant page and the 409A data workbook still showed all 48,000 outstanding until the
  // exercise window closed.
  const c = await newCompany('Leaver Co', 5_000_000);
  const leaver = (await call('POST', `/api/c/${c.cid}/stakeholders`, { name: 'Wynn Asante', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json.id as string;
  const id = await grant(c, leaver, {});
  await run("UPDATE stakeholders SET termination_date = '2024-07-01' WHERE id = ?", leaver);
  await run("UPDATE awards SET ptep_months = 1200 WHERE id = ?", id);
  invalidate(c.cid);
  const detail = await call('GET', `/api/c/${c.cid}/awards/${id}/detail`, undefined, admin);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.amounts.outstanding, 18_000);
  const table = (await call('GET', `/api/c/${c.cid}/captable`, undefined, admin)).json.table;
  assert.equal(table.rows.find((r: any) => r.stakeholderId === leaver).optionsOutstanding, 18_000);
  const res = await fetch(`${base}/api/c/${c.cid}/valuation-requests/package.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(res.status, 200);
  const grants = parseXlsx(Buffer.from(await res.arrayBuffer())).find((x) => x.name === 'Options and awards')!.rows;
  assert.deepEqual(grants[0].slice(3, 5), ['Granted', 'Outstanding']);
  assert.deepEqual(grants[1].slice(3, 5), [48_000, 18_000]);
});

test('a grant struck at a 409A split since, to the micro-cent, is not listed as below the valuation', async () => {
  // A $0.10 409A of 2025-01-15, a 3-for-1 split on 2025-03-01 and an NSO granted 2025-04-01 at $0.033333: the
  // valuation's page lists the grants it priced, and this one is at its value in the shares of the grant
  // date (math audit CAP-3). Before the fix the page compared $0.033333 with $0.10 and flagged it.
  const c = await newCompany('Postsplit Co', 3_000_000);
  const employee = (await call('POST', `/api/c/${c.cid}/stakeholders`, { name: 'Lorne Ekwueme', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json.id as string;
  await insert('valuations', { id: 'val_ps', companyId: c.cid, type: '409A', fairMarketValue: 100_000, effectiveDate: '2025-01-15', expirationDate: '2026-01-14', status: 'ACTIVE', createdAt: now });
  assert.equal((await call('POST', `/api/c/${c.cid}/stock-splits`, { date: '2025-03-01', ratio: 3 }, admin)).status, 200);
  await grant(c, employee, { id: 'aw_at', quantity: 30_000, strikePrice: 33_333, fmvAtGrant: 33_333, grantDate: '2025-04-01', vestingStartDate: '2025-04-01' });
  await grant(c, employee, { id: 'aw_under', quantity: 30_000, strikePrice: 33_332, fmvAtGrant: 33_332, grantDate: '2025-04-02', vestingStartDate: '2025-04-02' });
  const r = await call('GET', `/api/c/${c.cid}/valuations/val_ps/detail`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const priced = Object.fromEntries(r.json.pricedGrants.map((g: any) => [g.id, g.belowFairMarketValue]));
  assert.deepEqual(priced, { aw_at: false, aw_under: true });
});
