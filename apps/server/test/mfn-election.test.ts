/**
 * POST /api/c/:cid/convertibles/:id/mfn-election: an MFN holder elects ONE later
 * convertible's terms once (YC Safe, MFN Amendment Provision). The route writes a
 * dated MFN_ELECTION ledger entry and leaves the convertible row as issued; every
 * view applies the election from its date.
 *
 * Facts, fictional (the reviewer's repro): 10,000,000 common; MFN $1M uncapped pre-money
 * (2022-01-01); X $1M pre-money at $5M (2022-03-01); Y $1M post-money at $5.5M (2022-06-01).
 * As X the MFN converts $1M x 10M / $5M = 2,000,000; as Y, MFN and Y each own 1/5.5 of
 * (10M + X's 2M) / (1 - 2/5.5) = 18,857,142.9, so 3,428,571.
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

const admin = (await call('POST', '/api/auth/register', { email: 'odile@example.com', name: 'Odile Marsh', password: 'odile-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Election Co', incorporationDate: '2020-01-01', authorizedCommon: 20_000_000 }, admin)).json.id as string;
const post = async (path: string, body: unknown) => {
  const r = await call('POST', `/api/c/${cid}${path}`, body, admin);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.json)}`);
  return r.json;
};
const refused = async (path: string, body: unknown, message: RegExp) => {
  const r = await call('POST', `/api/c/${cid}${path}`, body, admin);
  assert.equal(r.status, 400, `${path}: ${JSON.stringify(r.json)}`);
  assert.match(r.json.error, message);
};
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const person = async (name: string) => (await post('/stakeholders', { name, type: 'INDIVIDUAL', relation: 'INVESTOR' })).id as string;
const founder = (await post('/stakeholders', { name: 'Odile Marsh', type: 'INDIVIDUAL', relation: 'FOUNDER' })).id as string;
await post('/issuances', { stakeholderId: founder, shareClassId: common, quantity: 10_000_000, pricePerShare: 100, issueDate: '2020-01-15', certificateNo: 'CS-1' });
const safe = async (holder: string, o: Record<string, unknown>) => (await post('/convertibles', {
  stakeholderId: await person(holder), principal: 1_000_000_00, status: 'OUTSTANDING', ...o,
})).id as string;
const mfn = await safe('Mira Fenn', { instrument: 'SAFE_PRE', valuationCap: null, issueDate: '2022-01-01', mfn: 1 });
const x = await safe('Xavier Lund', { instrument: 'SAFE_PRE', valuationCap: 5_000_000_00, issueDate: '2022-03-01' });
const y = await safe('Yara Holt', { instrument: 'SAFE_POST', valuationCap: 5_500_000_00, issueDate: '2022-06-01' });
const late = await safe('Lev Ortiz', { instrument: 'SAFE_PRE', valuationCap: 2_000_000_00, issueDate: '2024-01-01' });
// Cancelled on the day it was issued, so it converts in no view.
const plain = await safe('Pia Snow', { instrument: 'SAFE_PRE', valuationCap: 8_000_000_00, issueDate: '2021-06-01' });
await post(`/convertibles/${plain}/cancel`, { date: '2021-06-01' });

const stack = async (asOf: string) => {
  const r = await call('GET', `/api/c/${cid}/model/convertibles?asOf=${asOf}`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.instruments.find((i: any) => i.id === mfn);
};
const mfnShares = async (asOf: string) => {
  const r = await call('GET', `/api/c/${cid}/captable?asOf=${asOf}&includeConvertibles=true`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.table.rows.find((row: any) => row.stakeholderId === stakeholderOf)!.convertibleAsConverted;
};
const stakeholderOf = (await one<{ stakeholder_id: string }>('SELECT stakeholder_id FROM convertibles WHERE id = ?', mfn))!.stakeholder_id;

test('before any election the MFN safe is on its own terms, and the list suggests Y: 3,428,571 shares', async () => {
  assert.equal(await mfnShares('2023-06-01'), 0); // uncapped, no valuation: no estimate
  const s = await stack('2023-06-01');
  assert.deepEqual([s.mfn, s.mfnElection, s.mfnSuggestion, s.cap], [true, null, { adoptedId: y, shares: 3_428_571 }, null]);
});

test('the route refuses what is not a valid election', async () => {
  await refused(`/convertibles/${plain}/mfn-election`, { adoptedId: y, date: '2023-01-01' }, /no MFN clause/);
  await refused(`/convertibles/${mfn}/mfn-election`, { adoptedId: plain, date: '2023-01-01' }, /issued on or after this one/);
  await refused(`/convertibles/${mfn}/mfn-election`, { adoptedId: late, date: '2023-01-01' }, /on or before the election date/);
  await refused(`/convertibles/${mfn}/mfn-election`, { adoptedId: 'cv_elsewhere', date: '2023-01-01' }, /of this company/);
  await refused(`/convertibles/${mfn}/mfn-election`, { adoptedId: y }, /Election date/);
  const settled = await safe('Cato Reyes', { instrument: 'SAFE_PRE', valuationCap: null, issueDate: '2022-01-01', mfn: 1 });
  await post(`/convertibles/${settled}/cancel`, { date: '2022-01-01' });
  await refused(`/convertibles/${settled}/mfn-election`, { adoptedId: y, date: '2023-01-01' }, /already been settled/);
  assert.equal(Number((await one<{ n: string }>("SELECT COUNT(*) AS n FROM transactions WHERE type = 'MFN_ELECTION'"))!.n), 0);
});

test('an election of Y dated 2023-01-01 writes only a ledger entry; from that date every view uses Y', async () => {
  await post(`/convertibles/${mfn}/mfn-election`, { adoptedId: y, date: '2023-01-01' });
  const row = await one<any>("SELECT * FROM transactions WHERE type = 'MFN_ELECTION' AND security_id = ?", mfn);
  assert.deepEqual([row.date, row.adopted_security_id], ['2023-01-01', y]);
  const terms = await one<any>('SELECT instrument, valuation_cap, discount FROM convertibles WHERE id = ?', mfn);
  assert.deepEqual([terms.instrument, terms.valuation_cap, Number(terms.discount)], ['SAFE_PRE', null, 0]);
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'MFN_ELECTION' AND entity_id = ?", mfn));

  assert.equal(await mfnShares('2022-12-31'), 0);
  assert.equal(await mfnShares('2023-06-01'), 3_428_571);
  const s = await stack('2023-06-01');
  assert.deepEqual([s.mfnElection, s.mfnSuggestion, s.cap], [{ adoptedId: y, date: '2023-01-01' }, null, 5_500_000_00]);
  assert.equal((await stack('2022-12-31')).mfnElection, null);
});

test('a second election is refused unless sent as a correction dated on or after the first', async () => {
  await refused(`/convertibles/${mfn}/mfn-election`, { adoptedId: x, date: '2023-06-01' }, /already made its MFN election/);
  await refused(`/convertibles/${mfn}/mfn-election`, { adoptedId: x, date: '2022-12-01', correction: true }, /on or after the election it corrects/);
  await post(`/convertibles/${mfn}/mfn-election`, { adoptedId: x, date: '2023-06-01', correction: true });
  assert.equal(await mfnShares('2023-03-01'), 3_428_571);
  assert.equal(await mfnShares('2023-06-01'), 2_000_000);
});

test('an adopted instrument cannot be deleted while an election names it', async () => {
  const r = await call('DELETE', `/api/c/${cid}/convertibles/${y}`, undefined, admin);
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /MFN holder elected/);
});
