/**
 * The exercise preview after a stock split. The exercise route takes the quantity
 * in options as the grant records them and writes the shares, the cost and the
 * spread in the shares of the exercise date (math audit CAP-2); the preview must
 * work the same numbers out before anything is written, or the Grants page shows
 * one cost and records another. The Portal shows a holder today's shares and
 * previews in those.
 *
 * Facts, fictional: 120,000 NSOs at $0.40 granted 2022-05-02, vested at grant; a
 * 2-for-1 split on 2024-02-01; a $1.30 409A from 2024-03-01, in post-split shares.
 * 30,000 options as granted are 60,000 shares at $0.20 after the split: $12,000 to
 * exercise either way (SEC, "Stock splits": a split changes the number of shares,
 * not what anyone owns), and a spread of 60,000 x ($1.30 - $0.20) = $66,000.
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
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'wren.ashby@example.com', name: 'Wren Ashby', password: 'wren-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Preview Co', incorporationDate: '2021-09-01', authorizedCommon: 20_000_000 }, admin)).json.id as string;
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vestedAtGrant = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
const optionee = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Callum Reyes', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json.id as string;
const now = new Date().toISOString();
await insert('pools', { id: 'pool_p', companyId: cid, name: 'Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', boardApprovalDate: '2022-01-10', createdAt: now });
const grant = (id: string) => ({ id, companyId: cid, label: id.toUpperCase(), stakeholderId: optionee, poolId: 'pool_p', type: 'NSO', quantity: 120_000, strikePrice: 400_000,
  grantDate: '2022-05-02', vestingStartDate: '2022-05-02', vestingScheduleId: vestedAtGrant, status: 'OUTSTANDING', expirationDate: '2032-05-02', ptepMonths: 3,
  earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 400_000, rsuLiquidityCondition: 0, createdAt: now });
await insert('awards', grant('opt_a'));
await insert('awards', grant('opt_b'));
assert.equal((await call('POST', `/api/c/${cid}/stock-splits`, { date: '2024-02-01', ratio: 2 }, admin)).status, 200);
await insert('valuations', { id: 'val_p', companyId: cid, type: '409A', fairMarketValue: 1_300_000, effectiveDate: '2024-03-01', expirationDate: '2025-02-28', status: 'ACTIVE', createdAt: now });

const preview = (body: Record<string, unknown>) => call('POST', `/api/c/${cid}/model/exercise`, body, admin);

test('30,000 options as granted, previewed after the split, are 60,000 shares at $0.20: $12,000 to exercise and a $66,000 spread', async () => {
  const r = await preview({ awardId: 'opt_a', quantity: 30_000, asOf: '2024-06-03' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json.scenario;
  assert.deepEqual([s.shares, s.strikePrice, s.fmv, s.exerciseCost, s.spread, s.ordinaryIncome], [60_000, 200_000, 1_300_000, 12_000_00, 66_000_00, 66_000_00]);
});

test('the preview is what the exercise then records, to the cent', async () => {
  const before = (await preview({ awardId: 'opt_a', quantity: 30_000, asOf: '2024-06-03' })).json.scenario;
  const r = await call('POST', `/api/c/${cid}/awards/opt_a/exercise`, { quantity: 30_000, exerciseDate: '2024-06-03', method: 'CASH' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.exercise.quantity, r.json.exercise.strikePrice, r.json.exercise.totalCost, r.json.exercise.spread],
    [before.shares, before.strikePrice, before.exerciseCost, before.spread]);
  assert.deepEqual(r.json.tax, before);
});

test('the Portal previews in today\'s shares: 60,000 shares after the split are the same exercise', async () => {
  const asGranted = (await preview({ awardId: 'opt_b', quantity: 30_000, asOf: '2024-06-03' })).json.scenario;
  const asToday = await preview({ awardId: 'opt_b', shares: 60_000, asOf: '2024-06-03' });
  assert.equal(asToday.status, 200, JSON.stringify(asToday.json));
  assert.deepEqual(asToday.json.scenario, asGranted);
});

test('a sale of the exercised shares costs the post-split strike: 60,000 x $0.20, not $0.40', async () => {
  const r = await preview({ awardId: 'opt_b', shares: 60_000, asOf: '2024-06-03', exitPricePerShare: 3_000_000, saleDate: '2025-07-01' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // $180,000 gross; $12,000 cost; the $66,000 spread was ordinary income at exercise, the rest a long-term gain.
  assert.deepEqual([r.json.sale.grossProceeds, r.json.sale.exerciseCost, r.json.sale.ordinaryIncomePortion, r.json.sale.capitalGainPortion, r.json.sale.isLongTerm],
    [180_000_00, 12_000_00, 66_000_00, 102_000_00, true]);
});

test('before the split there is nothing to convert: 30,000 options are 30,000 shares at $0.40', async () => {
  const r = await preview({ awardId: 'opt_b', quantity: 30_000, asOf: '2023-06-01', fmv: 900_000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json.scenario;
  assert.deepEqual([s.shares, s.strikePrice, s.exerciseCost, s.spread], [30_000, 400_000, 12_000_00, 15_000_00]);
});

test('no quantity and no shares is refused', async () => {
  assert.equal((await preview({ awardId: 'opt_b', asOf: '2024-06-03' })).status, 400);
  assert.equal((await preview({ awardId: 'opt_b', quantity: 'many', asOf: '2024-06-03' })).status, 400);
});
