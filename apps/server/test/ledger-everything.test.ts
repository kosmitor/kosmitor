/**
 * Every change to equity is dated in the ledger (docs/design/dated-ledger.md), and a
 * signed document cannot be rewritten. An edit (PATCH) of a security either names the
 * event route that dates the change or writes a dated CORRECTION; warrants have an
 * exercise route; manual ledger entries are checked; event dates cannot precede the
 * security. Holders and figures are invented.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
const { one, all } = await import('../src/db.ts');

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
const company = async (name: string) => (await call('POST', '/api/companies', { name, incorporationDate: '2020-01-01', authorizedCommon: 50_000_000 }, admin)).json.id as string;
const cid = await company('Ledger Co');
const c = (path: string) => `/api/c/${cid}${path}`;
const ok = async (method: string, path: string, body?: unknown) => {
  const r = await call(method, c(path), body, admin);
  assert.equal(r.status, 200, `${method} ${path} → ${JSON.stringify(r.json)}`);
  return r.json;
};
const refused = async (method: string, path: string, body: unknown, words: RegExp) => {
  const r = await call(method, c(path), body, admin);
  assert.equal(r.status, 400, `${method} ${path} should be refused: ${JSON.stringify(r.json)}`);
  assert.match(r.json.error ?? r.json.message ?? JSON.stringify(r.json), words);
};

const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vested = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
const person = async (name: string) => (await ok('POST', '/stakeholders', { name, type: 'INDIVIDUAL', relation: 'OTHER' })).id as string;
const founder = await person('Wren Ashby');
const lender = await person('Odile Fenwick');
const employee = await person('Piet Marlowe');
const plan = (await ok('POST', '/pools', { name: 'Plan', shareClassId: common, authorized: 2_000_000, boardApprovalDate: '2020-01-01', returnForfeitures: 1, planType: 'STOCK_PLAN' })).id as string;
const certificate = async (quantity: number, issueDate = '2020-01-15') =>
  (await ok('POST', '/issuances', { stakeholderId: founder, shareClassId: common, quantity, pricePerShare: 100, issueDate })).id as string;
const grant = async (quantity: number, extra: Record<string, unknown> = {}) => (await ok('POST', '/awards', {
  stakeholderId: employee, poolId: plan, type: 'NSO', quantity, strikePrice: 100_000, grantDate: '2021-03-01',
  vestingScheduleId: vested, status: 'OUTSTANDING', expirationDate: '2031-03-01', fmvAtGrant: 100_000, ...extra,
})).id as string;
const table = async (asOf: string) => (await ok('GET', `/captable?asOf=${asOf}`)).table;
const holderAt = async (asOf: string, id: string) => (await table(asOf)).rows.find((r: any) => r.stakeholderId === id) ?? {};
const ledgerOf = (id: string) => all<{ type: string; date: string; quantity: number; field: string | null }>(
  'SELECT type, date, quantity, field FROM transactions WHERE security_id = ? ORDER BY date, created_at', id);

// ---------------------------------------------------------------------------
// 1. PATCH: events go to their routes; corrections are dated
// ---------------------------------------------------------------------------

test('an edit that is really an event is refused and names the route that dates it', async () => {
  const cert = await certificate(10_000);
  const opt = await grant(10_000);
  const safe = (await ok('POST', '/convertibles', { stakeholderId: lender, instrument: 'SAFE_POST', principal: 10_000_000, valuationCap: 1_000_000_000, issueDate: '2021-01-01', status: 'OUTSTANDING' })).id;
  const w = (await ok('POST', '/warrants', { stakeholderId: lender, shareClassId: common, quantity: 5_000, strikePrice: 100_000, issueDate: '2021-01-01' })).id;
  await refused('PATCH', `/issuances/${cert}`, { status: 'TRANSFERRED' }, /transfer/i);
  await refused('PATCH', `/issuances/${cert}`, { status: 'REPURCHASED' }, /repurchase/i);
  await refused('PATCH', `/awards/${opt}`, { exercisedQuantity: 1_000 }, /exercise/i);
  await refused('PATCH', `/awards/${opt}`, { cancelledQuantity: 1_000 }, /cancel/i);
  await refused('PATCH', `/awards/${opt}`, { status: 'CANCELLED' }, /cancel/i);
  await refused('PATCH', `/convertibles/${safe}`, { status: 'CONVERTED', convertedOn: '2024-01-01' }, /convert/i);
  await refused('PATCH', `/warrants/${w}`, { exercisedQuantity: 1_000 }, /exercise/i);
  // Nothing was written.
  assert.equal((await ok('GET', `/issuances/${cert}`)).status, 'OUTSTANDING');
  assert.equal((await ok('GET', `/awards/${opt}`)).exercisedQuantity, 0);
  assert.equal((await ledgerOf(cert)).length, 0);
});

test('a corrected quantity needs an effective date, writes a dated CORRECTION, and past views keep the old figure', async () => {
  const cert = await certificate(100_000);
  await refused('PATCH', `/issuances/${cert}`, { quantity: 120_000 }, /effective date/i);
  await refused('PATCH', `/issuances/${cert}`, { quantity: 120_000, effectiveDate: '2019-01-01' }, /before/i);
  await ok('PATCH', `/issuances/${cert}`, { quantity: 120_000, effectiveDate: '2024-01-01' });
  assert.deepEqual((await ledgerOf(cert)).map((e) => [e.type, e.date, Number(e.quantity), e.field]), [['CORRECTION', '2024-01-01', 20_000, 'quantity']]);
  const before = (await holderAt('2023-06-01', founder)).outstanding;
  const afterwards = (await holderAt('2024-01-01', founder)).outstanding;
  assert.equal(afterwards - before, 20_000);
});

test('a correction dated the grant date holds for every date; one across a split is in the shares of its date', async () => {
  const fixedSince = await grant(10_000);
  const fixedLater = await grant(10_000, { grantDate: '2021-06-01' });
  await ok('PATCH', `/awards/${fixedSince}`, { quantity: 8_000, effectiveDate: '2021-03-01' });
  const at2021 = (await holderAt('2021-04-01', employee)).optionsOutstanding;
  const today = (await holderAt('2030-01-01', employee)).optionsOutstanding;
  assert.equal(today - at2021, 10_000, 'only the later grant was added since; the corrected one reads 8,000 at both dates');

  await ok('POST', '/stock-splits', { date: '2023-01-01', ratio: 2 });
  await ok('PATCH', `/awards/${fixedLater}`, { quantity: 12_000, effectiveDate: '2024-01-01' });
  assert.deepEqual((await ledgerOf(fixedLater)).map((e) => [e.type, Number(e.quantity)]), [['CORRECTION', 4_000]]);
  const mid = (await holderAt('2023-06-01', employee)).optionsOutstanding;
  const late = (await holderAt('2024-01-01', employee)).optionsOutstanding;
  assert.equal(late - mid, 4_000);
  await ok('DELETE', `/stock-splits/${(await one<{ id: string }>('SELECT id FROM stock_splits WHERE company_id = ?', cid))!.id}`);
});

test('a lowered exercised count is a correction; a raised one is an exercise', async () => {
  const opt = await grant(10_000);
  await ok('POST', `/awards/${opt}/exercise`, { quantity: 4_000, exerciseDate: '2024-01-01', method: 'CASH' });
  await ok('PATCH', `/awards/${opt}`, { exercisedQuantity: 3_000, effectiveDate: '2024-03-01' });
  const entries = (await ledgerOf(opt)).map((e) => [e.type, Number(e.quantity), e.field]);
  assert.deepEqual(entries, [['EXERCISE', 4_000, null], ['CORRECTION', -1_000, 'exercisedQuantity']]);
});

// ---------------------------------------------------------------------------
// 5. The audit log names what changed, before and after
// ---------------------------------------------------------------------------

test('the audit log of an edit lists only the fields that changed, with before and after', async () => {
  const cert = await certificate(5_000);
  await ok('PATCH', `/issuances/${cert}`, { quantity: 5_000, notes: 'Board minutes 12' });
  const row = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE entity_id = ? AND action = 'UPDATE' ORDER BY created_at DESC LIMIT 1", cert);
  assert.match(row!.detail, /notes: null → "Board minutes 12"/);
  assert.doesNotMatch(row!.detail, /quantity|stakeholderId|issueDate/);
});

// ---------------------------------------------------------------------------
// 2. Warrant exercise
// ---------------------------------------------------------------------------

test('a warrant is exercised through its own route: shares issued, a dated EXERCISE, and past views keep the warrant', async () => {
  const holder = await person('Esme Dunmore');
  const w = (await ok('POST', '/warrants', { stakeholderId: holder, shareClassId: common, quantity: 100_000, strikePrice: 100_000, issueDate: '2021-01-01' })).id;
  await refused('POST', `/warrants/${w}/exercise`, { quantity: 1_000, exerciseDate: '2020-06-01' }, /issued/i);
  await refused('POST', `/warrants/${w}/exercise`, { quantity: 100_001, exerciseDate: '2024-01-01' }, /remain/i);
  const r = await ok('POST', `/warrants/${w}/exercise`, { quantity: 40_000, exerciseDate: '2024-01-01' });
  assert.equal(Number(r.issuance.quantity), 40_000);
  assert.deepEqual([Number(r.warrant.exercisedQuantity), r.warrant.status], [40_000, 'OUTSTANDING']);
  assert.deepEqual((await ledgerOf(w)).map((e) => [e.type, e.date, Number(e.quantity)]), [['EXERCISE', '2024-01-01', 40_000]]);
  const then = await holderAt('2023-06-01', holder);
  const now = await holderAt('2024-02-01', holder);
  assert.deepEqual([then.warrantsOutstanding, then.outstanding ?? 0], [100_000, 0]);
  assert.deepEqual([now.warrantsOutstanding, now.outstanding], [60_000, 40_000]);
  const rest = await ok('POST', `/warrants/${w}/exercise`, { quantity: 60_000, exerciseDate: '2024-06-01' });
  assert.equal(rest.warrant.status, 'EXERCISED');
  assert.equal((await holderAt('2024-03-01', holder)).warrantsOutstanding, 60_000);
  const audited = await one('SELECT 1 FROM audit_log WHERE entity_id = ? AND action = ?', w, 'EXERCISE');
  assert.ok(audited);
});

// ---------------------------------------------------------------------------
// 3. Manual ledger entries
// ---------------------------------------------------------------------------

test('a manual ledger entry is checked and refreshes the cached cap table', async () => {
  const opt = await grant(20_000, { cancelledQuantity: 5_000 });
  const elsewhere = await company('Other Co');
  const foreign = (await call('POST', `/api/c/${elsewhere}/issuances`, {
    stakeholderId: (await call('POST', `/api/c/${elsewhere}/stakeholders`, { name: 'Lior Kade', type: 'INDIVIDUAL', relation: 'OTHER' }, admin)).json.id,
    shareClassId: (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', elsewhere))!.id,
    quantity: 10, pricePerShare: 100, issueDate: '2021-01-01',
  }, admin)).json.id;
  await refused('POST', '/transactions', { type: 'GIFT', date: '2024-01-01', securityId: opt, quantity: 5_000 }, /type/i);
  await refused('POST', '/transactions', { type: 'CANCELLATION', date: '2024-01-01', securityId: opt, quantity: -5 }, /quantity/i);
  await refused('POST', '/transactions', { type: 'CANCELLATION', date: '2024-01-01', securityId: opt, quantity: 2.5 }, /quantity/i);
  await refused('POST', '/transactions', { type: 'TRANSFER', date: '2024-01-01', securityId: foreign, quantity: 5 }, /company/i);

  const before = (await holderAt('2023-01-01', employee)).optionsOutstanding;
  await ok('POST', '/transactions', { type: 'CANCELLATION', date: '2024-01-01', securityId: opt, quantity: 5_000 });
  // The cancellation is now dated 2024, so in 2023 the 5,000 were still outstanding.
  assert.equal((await holderAt('2023-01-01', employee)).optionsOutstanding - before, 5_000);
});

// ---------------------------------------------------------------------------
// 4. Repurchase and event dates
// ---------------------------------------------------------------------------

test('only an outstanding certificate is repurchased, and no event is dated before the security', async () => {
  const cert = await certificate(1_000, '2022-01-01');
  const buyer = await person('Juno Calloway');
  await refused('POST', `/issuances/${cert}/transfer`, { toStakeholderId: buyer, quantity: 100, date: '2021-12-31' }, /before/i);
  await refused('POST', `/issuances/${cert}/repurchase`, { quantity: 100, date: '2021-12-31' }, /before/i);
  await ok('POST', `/issuances/${cert}/transfer`, { toStakeholderId: buyer, date: '2022-06-01' });
  await refused('POST', `/issuances/${cert}/repurchase`, { quantity: 100, date: '2022-07-01' }, /outstanding/i);
  const opt = await grant(1_000);
  await refused('POST', `/awards/${opt}/cancel`, { quantity: 100, date: '2021-01-01' }, /before/i);
});

// ---------------------------------------------------------------------------
// 6. Signed documents
// ---------------------------------------------------------------------------

test('once anyone has signed, a document\'s body and status cannot be edited, and each signature keeps the hash of what it signed', async () => {
  const text = 'The parties agree to the terms set out here.';
  const doc = await ok('POST', '/documents', {
    name: 'Side letter', category: 'OTHER', body: text, requiresSignature: true,
    signers: [{ name: 'Wren Ashby' }, { name: 'Odile Fenwick', stakeholderId: lender }],
  });
  // Before anyone signs, the draft can still change.
  await ok('PATCH', `/documents/${doc.id}`, { body: `${text} Amended.` });
  const blocks = await all<{ id: string }>('SELECT id FROM signatures WHERE document_id = ? ORDER BY signer_name DESC', doc.id);
  const signed = await ok('POST', `/signatures/${blocks[0].id}/sign`, { typedSignature: 'Wren Ashby' });
  assert.equal(signed.bodySha256, createHash('sha256').update(`${text} Amended.`).digest('hex'));

  await refused('PATCH', `/documents/${doc.id}`, { body: 'Something else entirely.' }, /signed/i);
  await refused('PATCH', `/documents/${doc.id}`, { status: 'EXECUTED' }, /signed/i);
  await ok('PATCH', `/documents/${doc.id}`, { name: 'Side letter (2024)' });
  assert.equal((await ok('GET', '/documents')).find((d: any) => d.id === doc.id).name, 'Side letter (2024)');
  assert.equal((await one<{ body: string }>('SELECT body FROM documents WHERE id = ?', doc.id))!.body, `${text} Amended.`);
});
