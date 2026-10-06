/**
 * Global search over HTTP: full-access roles find people, grants, certificates
 * and documents by fragments of their names; portfolio-only roles find only
 * the documents they may open.
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
await import('../src/routes/data.ts');
await import('../src/routes/search.ts');
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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Search Co' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;

await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insert('stakeholders', { id: 'stk_lark', companyId: cid, name: 'Larkspur Ventures Fund II, L.P.', email: 'ops@larkspur.example', type: 'ENTITY', relation: 'INVESTOR', createdAt: now });
await insert('pools', { id: 'pool_x', companyId: cid, name: '2022 Stock Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
await insert('awards', { id: 'awa_7', companyId: cid, label: 'OPT-7', stakeholderId: 'stk_priya', poolId: 'pool_x', type: 'ISO', quantity: 10_000, strikePrice: 500_000,
  grantDate: '2024-01-01', vestingStartDate: '2024-01-01', vestingScheduleId: schedule, status: 'OUTSTANDING', expirationDate: '2034-01-01', ptepMonths: 3,
  earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 500_000, rsuLiquidityCondition: 0, createdAt: now });
await insert('issuances', { id: 'iss_12', companyId: cid, certificateNo: 'CS-12', stakeholderId: 'stk_lark', shareClassId: common,
  quantity: 250_000, pricePerShare: 420_000, issueDate: '2024-03-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
await insert('documents', { id: 'doc_all', companyId: cid, name: 'Employee handbook', category: 'OTHER', visibility: 'ALL', stakeholderId: null, status: 'FINAL', requiresSignature: 0, createdAt: now });
await insert('documents', { id: 'doc_board', companyId: cid, name: 'Board deck Q3', category: 'OTHER', visibility: 'ADMIN', stakeholderId: null, status: 'FINAL', requiresSignature: 0, createdAt: now });
await insert('documents', { id: 'doc_priya', companyId: cid, name: 'Priya option agreement', category: 'GRANT_AGREEMENT', visibility: 'HOLDER', stakeholderId: 'stk_priya', status: 'EXECUTED', requiresSignature: 1, createdAt: now });

const titles = (r: { json: { results: { kind: string; title: string }[] } }) => r.json.results.map((h) => `${h.kind}:${h.title}`);

test('an administrator finds people, grants, certificates and documents by name fragments', async () => {
  const priya = await call('GET', `/api/c/${cid}/search?q=pri`, undefined, admin);
  assert.equal(priya.status, 200);
  assert.deepEqual(titles(priya).sort(), ['award:OPT-7 · Priya Raman', 'document:Priya option agreement', 'stakeholder:Priya Raman']);
  const award = priya.json.results.find((h: any) => h.kind === 'award');
  assert.equal(award.label, 'OPT-7');
  assert.equal(award.stakeholderId, 'stk_priya');
  assert.equal(award.subtitle, 'ISO · Outstanding');

  const grant = await call('GET', `/api/c/${cid}/search?q=opt-7`, undefined, admin);
  assert.deepEqual(titles(grant), ['award:OPT-7 · Priya Raman']);

  const lark = await call('GET', `/api/c/${cid}/search?q=lark`, undefined, admin);
  assert.deepEqual(titles(lark).sort(), ['certificate:CS-12 · Larkspur Ventures Fund II, L.P.', 'stakeholder:Larkspur Ventures Fund II, L.P.']);
  const cert = lark.json.results.find((h: any) => h.kind === 'certificate');
  assert.equal(cert.label, 'CS-12');

  const plan = await call('GET', `/api/c/${cid}/search?q=2022`, undefined, admin);
  assert.deepEqual(titles(plan), ['pool:2022 Stock Plan']);
});

test('short and wildcard-only queries return nothing rather than everything', async () => {
  const short = await call('GET', `/api/c/${cid}/search?q=p`, undefined, admin);
  assert.deepEqual(short.json, { query: 'p', results: [] });
  // LIKE wildcards in the query are literal characters, so "%%" matches no name.
  const wild = await call('GET', `/api/c/${cid}/search?q=${encodeURIComponent('%%')}`, undefined, admin);
  assert.deepEqual(wild.json.results, []);
  const underscore = await call('GET', `/api/c/${cid}/search?q=${encodeURIComponent('__')}`, undefined, admin);
  assert.deepEqual(underscore.json.results, []);
});

test('a portfolio-only member searches only the documents they may open', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  assert.equal(invite.status, 200);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const priya = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).token as string;

  const own = await call('GET', `/api/c/${cid}/search?q=priya`, undefined, priya);
  assert.equal(own.status, 200);
  assert.deepEqual(titles(own), ['document:Priya option agreement']); // no stakeholder or grant hits

  const shared = await call('GET', `/api/c/${cid}/search?q=handbook`, undefined, priya);
  assert.deepEqual(titles(shared), ['document:Employee handbook']);

  const hidden = await call('GET', `/api/c/${cid}/search?q=board deck`, undefined, priya);
  assert.deepEqual(hidden.json.results, []);

  const outsider = await call('GET', `/api/c/${cid}/search?q=lark`, undefined, priya);
  assert.deepEqual(outsider.json.results, []);
});
