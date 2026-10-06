/** The ASC 718 report over HTTP: assumptions saved on the company, departments on holders, the CSV. */
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
await import('../src/routes/data.ts');
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
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
}

test('the stock-compensation report values grants, follows the company assumptions and exports its workpaper', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Comp Co', fiscalYearEnd: '12-31' }, admin)).json.id as string;
  const now = new Date().toISOString();
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
  await insert('stakeholders', { id: 'stk_e', companyId: cid, name: 'Priya Raman', type: 'INDIVIDUAL', relation: 'EMPLOYEE', department: 'Engineering', createdAt: now });
  await insert('stakeholders', { id: 'stk_s', companyId: cid, name: 'Marcus Webb', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  await insert('pools', { id: 'pool_c', companyId: cid, name: 'Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
  const grant = (id: string, stakeholderId: string, extra: Record<string, unknown>) => insert('awards', {
    id, companyId: cid, label: id.toUpperCase(), stakeholderId, poolId: 'pool_c', type: 'ISO', quantity: 48_000, strikePrice: 1_000_000,
    grantDate: '2025-01-01', vestingStartDate: '2025-01-01', vestingScheduleId: schedule, status: 'OUTSTANDING', expirationDate: '2035-01-01',
    ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 1_000_000, rsuLiquidityCondition: 0, createdAt: now, ...extra,
  });
  await grant('opt_a', 'stk_e', {});
  await grant('rsu_b', 'stk_s', { type: 'RSU', strikePrice: 0, quantity: 12_000, fmvAtGrant: 2_000_000 });

  const r = await call('GET', `/api/c/${cid}/reports/stock-comp?year=2025&asOf=2026-06-30`, undefined, admin);
  assert.equal(r.status, 200);
  assert.equal(r.json.report.period.label, 'FY2025');
  assert.equal(r.json.assumptionsSet, false);
  assert.deepEqual(r.json.years, [2025, 2026]);
  const optA = r.json.report.awards.find((x: any) => x.awardId === 'opt_a');
  const rsuB = r.json.report.awards.find((x: any) => x.awardId === 'rsu_b');
  assert.equal(optA.department, 'Engineering');
  assert.ok(optA.fairValuePerShare > 400_000 && optA.fairValuePerShare < 750_000, `ATM 10-year option at 60% vol: ${optA.fairValuePerShare}`);
  assert.equal(rsuB.fairValuePerShare, 2_000_000);
  assert.equal(rsuB.totalFairValue, 12_000 * 200);
  assert.ok(optA.expense > 0 && rsuB.expense > 0);
  assert.equal(r.json.report.totals.expense, optA.expense + rsuB.expense);
  assert.deepEqual(r.json.report.byDepartment.map((d: any) => d.department), ['Engineering', 'Unassigned'].sort((a, b) => {
    const ea = a === 'Engineering' ? optA.expense : rsuB.expense; const eb = b === 'Engineering' ? optA.expense : rsuB.expense; return eb - ea;
  }));
  assert.equal(r.json.report.rollforward.granted.count, 48_000);                        // the RSU is not an option
  assert.equal(r.json.report.rollforward.outstandingEnd.count, 48_000);

  // Assumptions: validated, saved as JSON, and they change the numbers.
  assert.equal((await call('PATCH', `/api/c/${cid}`, { accountingAssumptions: { volatility: 9 } }, admin)).status, 400);
  assert.equal((await call('PATCH', `/api/c/${cid}`, { accountingAssumptions: { attribution: 'MAGIC' } }, admin)).status, 400);
  const saved = await call('PATCH', `/api/c/${cid}`, { accountingAssumptions: { volatility: 0.3, riskFreeRate: 0.04, expectedTermYears: 6, attribution: 'STRAIGHT_LINE' } }, admin);
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.json.accountingAssumptions), { volatility: 0.3, riskFreeRate: 0.04, expectedTermYears: 6, attribution: 'STRAIGHT_LINE' });
  const r2 = await call('GET', `/api/c/${cid}/reports/stock-comp?year=2025&asOf=2026-06-30`, undefined, admin);
  assert.equal(r2.json.assumptionsSet, true);
  assert.equal(r2.json.report.assumptions.attribution, 'STRAIGHT_LINE');
  const optA2 = r2.json.report.awards.find((x: any) => x.awardId === 'opt_a');
  assert.ok(optA2.fairValuePerShare < optA.fairValuePerShare, 'lower volatility, lower fair value');
  assert.ok(optA2.expense < optA.expense, 'straight-line recognises less in year one than graded');
  // IFRS forces graded attribution regardless.
  await call('PATCH', `/api/c/${cid}`, { accountingAssumptions: { standard: 'IFRS', attribution: 'STRAIGHT_LINE' } }, admin);
  assert.equal((await call('GET', `/api/c/${cid}/reports/stock-comp?year=2025`, undefined, admin)).json.report.assumptions.attribution, 'GRADED');

  const csv = await call('GET', `/api/c/${cid}/reports/stock-comp.csv?year=2025&asOf=2026-06-30`, undefined, admin);
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.text, /^Fiscal period,Award,Holder,Department/);
  assert.match(csv.text, /FY2025,OPT_A,Priya Raman,Engineering,ISO,2025-01-01,48000,/);
  assert.match(csv.text, /Assumptions,volatility/);

  // Portfolio-only roles are kept out.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'marcus@example.com', name: 'Marcus Webb', role: 'EMPLOYEE' }, admin);
  const marcus = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'marcus-pass-1',
  })).json.token as string;
  assert.equal((await call('GET', `/api/c/${cid}/reports/stock-comp`, undefined, marcus)).status, 403);
});
