/** Exercise requests over HTTP: a holder asks from the portal, the company reviews, collects payment and records the exercise. */
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

test('an option holder requests an exercise; the company approves, takes payment and completes it', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Exercise Co' }, admin)).json.id as string;
  const now = new Date().toISOString();
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
  await insert('stakeholders', { id: 'stk_p', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  await insert('stakeholders', { id: 'stk_m', companyId: cid, name: 'Marcus Webb', email: 'marcus@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  await insert('pools', { id: 'pool_x', companyId: cid, name: 'Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
  await insert('valuations', { id: 'val_1', companyId: cid, type: '409A', fairMarketValue: 2_000_000, effectiveDate: '2025-01-01', expirationDate: '2026-12-31', status: 'ACTIVE', createdAt: now });
  // Granted four years ago: fully vested by now.
  await insert('awards', { id: 'awa_p', companyId: cid, label: 'OPT-1', stakeholderId: 'stk_p', poolId: 'pool_x', type: 'ISO', quantity: 48_000, strikePrice: 500_000,
    grantDate: '2021-01-01', vestingStartDate: '2021-01-01', vestingScheduleId: schedule, status: 'OUTSTANDING', expirationDate: '2031-01-01', ptepMonths: 3,
    earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 500_000, rsuLiquidityCondition: 0, createdAt: now });

  const signIn = async (memberEmail: string, name: string) => {
    const invite = await call('POST', `/api/c/${cid}/members`, { email: memberEmail, name, role: 'EMPLOYEE' }, admin);
    return (await call('POST', '/api/auth/reset', {
      token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
      password: 'holder-pass-1',
    })).json.token as string;
  };
  const priya = await signIn('priya@example.com', 'Priya Raman');
  const marcus = await signIn('marcus@example.com', 'Marcus Webb');

  // Portal shows the setting; Priya asks for 10,000; Marcus cannot ask on her grant; too many is refused.
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, priya);
  assert.equal(portal.json.exerciseRequestsEnabled, true);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 10, method: 'CASH' }, marcus)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 50_000, method: 'CASH' }, priya)).status, 400);
  const req = await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 10_000, method: 'CASH', note: 'Please process before month end' }, priya);
  assert.equal(req.status, 200, JSON.stringify(req.json));
  assert.equal(req.json.status, 'REQUESTED');
  assert.equal(req.json.estimatedCost, 10_000 * 50);                                     // $0.50 × 10,000 in cents
  assert.equal(req.json.spread, 10_000 * 150);                                           // ($2.00 − $0.50) × 10,000
  assert.equal(req.json.awardLabel, 'OPT-1');
  // Pending requests reduce what can still be asked for.
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 40_000, method: 'CASH' }, priya)).status, 400);
  const second = await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 5_000, method: 'CASH' }, priya);
  assert.equal(second.status, 200);

  // Each side sees what it should.
  const mine = await call('GET', `/api/c/${cid}/exercise-requests`, undefined, priya);
  assert.equal(mine.json.requests.length, 2);
  assert.equal((await call('GET', `/api/c/${cid}/exercise-requests`, undefined, marcus)).json.requests.length, 0);
  const all = await call('GET', `/api/c/${cid}/exercise-requests`, undefined, admin);
  assert.equal(all.json.counts.REQUESTED, 2);
  assert.equal((await call('GET', `/api/c/${cid}/portal`, undefined, priya)).json.exerciseRequests.length, 2);

  // Marcus cannot withdraw Priya's request; Priya withdraws her second one.
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests/${second.json.id}/withdraw`, {}, marcus)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests/${second.json.id}/withdraw`, {}, priya)).json.status, 'WITHDRAWN');

  // Holders cannot approve; the admin does, records payment, then completes → a real exercise.
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests/${req.json.id}/approve`, {}, priya)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests/${req.json.id}/mark-paid`, {}, admin)).status, 400);   // not approved yet
  const approved = await call('POST', `/api/c/${cid}/exercise-requests/${req.json.id}/approve`, { adminNote: 'Wire the exercise price' }, admin);
  assert.equal(approved.json.status, 'APPROVED');
  const paid = await call('POST', `/api/c/${cid}/exercise-requests/${req.json.id}/mark-paid`, { paymentReference: 'WIRE-2026-09-21' }, admin);
  assert.equal(paid.json.status, 'PAID');
  const done = await call('POST', `/api/c/${cid}/exercise-requests/${req.json.id}/complete`, { exerciseDate: '2026-09-21' }, admin);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.request.status, 'COMPLETED');
  assert.equal(done.json.exercise.quantity, 10_000);
  assert.equal(done.json.issuance.quantity, 10_000);
  assert.equal((await one<{ exercised_quantity: number }>('SELECT exercised_quantity FROM awards WHERE id = ?', 'awa_p'))!.exercised_quantity, 10_000);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests/${req.json.id}/complete`, {}, admin)).status, 400);   // once only
  assert.ok((await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.some((a: any) => a.action === 'EXERCISE'));

  // Rejection and the company switch.
  const third = await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 1_000, method: 'NET_EXERCISE' }, priya);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests/${third.json.id}/reject`, { adminNote: 'Blackout period' }, admin)).json.status, 'REJECTED');
  await call('PATCH', `/api/c/${cid}`, { exerciseRequestsEnabled: false, paymentInstructions: 'Wire to First Republic, account 1234' }, admin);
  assert.equal((await call('POST', `/api/c/${cid}/exercise-requests`, { awardId: 'awa_p', quantity: 100, method: 'CASH' }, priya)).status, 400);
  const settings = await call('GET', `/api/c/${cid}/exercise-requests`, undefined, admin);
  assert.equal(settings.json.enabled, false);
  assert.equal(settings.json.paymentInstructions, 'Wire to First Republic, account 1234');
});
