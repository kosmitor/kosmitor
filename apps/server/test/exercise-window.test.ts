/**
 * The post-termination exercise window when an exercise is recorded (math audit
 * PTEP-0). The cap table reads a grant's recorded window with awardIsLive: a
 * recorded 0 is a window that closes on the day the holder leaves, and only a
 * grant that records no window takes equity.postTerminationExerciseMonths. The
 * exercise route has to agree, or it records an exercise of options the cap table
 * has already dropped.
 *
 * Facts, fictional: Ines Marlow leaves on 2025-03-14 holding two NSO grants of
 * 10,000 at $0.25, vested at grant on 2023-04-03; one records a 0-month window,
 * the other a 2-month one. The grant agreement states the window the grant
 * records, 0 included.
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
const { insert, one, run } = await import('../src/db.ts');

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

const admin = (await call('POST', '/api/auth/register', { email: 'thea.morrow@example.com', name: 'Thea Morrow', password: 'thea-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Window Co', incorporationDate: '2022-11-07' }, admin)).json.id as string;
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vestedAtGrant = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
const leaver = await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Ines Marlow', type: 'INDIVIDUAL', relation: 'FORMER_EMPLOYEE', startDate: '2023-04-03', terminationDate: '2025-03-14' }, admin);
assert.equal(leaver.status, 200, JSON.stringify(leaver.json));
const now = new Date().toISOString();
await insert('pools', { id: 'pool_w', companyId: cid, name: 'Plan', shareClassId: common, authorized: 500_000, returnForfeitures: 1, planType: 'STOCK_PLAN', boardApprovalDate: '2023-01-09', createdAt: now });
const grant = (id: string, ptepMonths: number) => ({ id, companyId: cid, label: id.toUpperCase(), stakeholderId: leaver.json.id, poolId: 'pool_w', type: 'NSO', quantity: 10_000, strikePrice: 250_000,
  grantDate: '2023-04-03', vestingStartDate: '2023-04-03', vestingScheduleId: vestedAtGrant, status: 'OUTSTANDING', expirationDate: '2033-04-03', ptepMonths,
  earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 250_000, rsuLiquidityCondition: 0, createdAt: now });
await insertSecurity('awards', grant('opt_zero', 0));
await insertSecurity('awards', grant('opt_two', 2));

const exercise = (awardId: string, exerciseDate: string) =>
  call('POST', `/api/c/${cid}/awards/${awardId}/exercise`, { quantity: 1_000, exerciseDate, method: 'CASH' }, admin);

test('a recorded 0-month window is open on the day the holder leaves', async () => {
  const r = await exercise('opt_zero', '2025-03-14');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.exercise.quantity, 1_000);
});

test('and closed the day after, as the cap table has it, not three months later', async () => {
  const r = await exercise('opt_zero', '2025-03-15');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'The post-termination exercise window closed on 2025-03-14.');
  const later = await exercise('opt_zero', '2025-06-13');
  assert.equal(later.status, 400, 'the 3-month default does not reopen it');
});

test('a recorded 2-month window closes two months after the leaving day', async () => {
  assert.equal((await exercise('opt_two', '2025-05-14')).status, 200);
  const r = await exercise('opt_two', '2025-05-15');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'The post-termination exercise window closed on 2025-05-14.');
});

test('the agreement for a grant that records a 0-month window says 0 months, not the default', async () => {
  // Board approval sends the agreement out; the window was recorded as 0 while the grant awaited the board.
  await insert('stakeholders', { id: 'stk_board', companyId: cid, name: 'Ottilie Grange', email: 'ottilie.grange@example.com', type: 'INDIVIDUAL', relation: 'BOARD_MEMBER', boardSeat: 1, createdAt: now });
  const issued = await call('POST', `/api/c/${cid}/awards/issue`, {
    stakeholderId: leaver.json.id, poolId: 'pool_w', type: 'NSO', quantity: 4_000, strikePrice: 250_000, grantDate: '2024-06-03', vestingScheduleId: vestedAtGrant,
    approval: 'REQUEST', directorIds: ['stk_board'], signing: { signerName: 'Thea Morrow', signerTitle: 'Chief Executive Officer' },
  }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  await run('UPDATE awards SET ptep_months = 0 WHERE id = ?', issued.json.award.id);
  const voted = await call('POST', `/api/c/${cid}/consents/${issued.json.consent.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_board' }, admin);
  assert.equal(voted.status, 200, JSON.stringify(voted.json));
  const doc = await one<{ body: string }>("SELECT body FROM documents WHERE security_id = ? AND category = 'GRANT_AGREEMENT'", issued.json.award.id);
  assert.match(doc!.body, /no later than 0 months after the Optionee's service ends/);
});
