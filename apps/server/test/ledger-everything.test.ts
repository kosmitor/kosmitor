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
const { one, all, run, insert, transaction } = await import('../src/db.ts');

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
let cid = await company('Ledger Co');
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

const person = async (name: string) => (await ok('POST', '/stakeholders', { name, type: 'INDIVIDUAL', relation: 'OTHER' })).id as string;
let common = '', vested = '', founder = '', lender = '', employee = '', plan = '';
/**
 * Moves the tests that follow to a company of their own. A split restates the ledger
 * entries dated after it, so one is refused behind entries already recorded: a test
 * that records a split before its events starts with a fresh ledger.
 */
async function fresh(name: string): Promise<void> {
  if (name !== 'Ledger Co') cid = await company(name);
  common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  vested = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
  founder = await person('Wren Ashby');
  lender = await person('Odile Fenwick');
  employee = await person('Piet Marlowe');
  plan = (await ok('POST', '/pools', { name: 'Plan', shareClassId: common, authorized: 2_000_000, boardApprovalDate: '2020-01-01', returnForfeitures: 1, planType: 'STOCK_PLAN' })).id as string;
}
await fresh('Ledger Co');
const certificate = async (quantity: number, issueDate = '2020-01-15') =>
  (await ok('POST', '/issuances', { stakeholderId: founder, shareClassId: common, quantity, pricePerShare: 100, issueDate })).id as string;
const grant = async (quantity: number, extra: Record<string, unknown> = {}) => (await ok('POST', '/awards', {
  stakeholderId: employee, poolId: plan, type: 'NSO', quantity, strikePrice: 100_000, grantDate: '2021-03-01',
  vestingScheduleId: vested, status: 'OUTSTANDING', expirationDate: '2031-03-01', fmvAtGrant: 100_000, ...extra,
})).id as string;
const table = async (asOf: string) => (await ok('GET', `/captable?asOf=${asOf}`)).table;
const holderAt = async (asOf: string, id: string) => (await table(asOf)).rows.find((r: any) => r.stakeholderId === id) ?? {};
/** What happened to a security after the ISSUANCE or GRANT entry it was created with. */
const ledgerOf = (id: string) => all<{ type: string; date: string; quantity: number; field: string | null }>(
  "SELECT type, date, quantity, field FROM transactions WHERE security_id = ? AND type NOT IN ('ISSUANCE', 'GRANT') ORDER BY date, created_at", id);

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
  await fresh('Correction split Co');
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
  // The split is behind the correction now, so it stays; the tests that follow start afresh.
  await refused('DELETE', `/stock-splits/${(await one<{ id: string }>('SELECT id FROM stock_splits WHERE company_id = ?', cid))!.id}`, undefined, /restate/i);
  await fresh('After correction split Co');
});

test('a lowered exercised count is a correction; a raised one is an exercise', async () => {
  const opt = await grant(10_000);
  await ok('POST', `/awards/${opt}/exercise`, { quantity: 4_000, exerciseDate: '2024-01-01', method: 'CASH' });
  // 1,000 more exercised with no shares issued here, as an earlier correction left it.
  await transaction(async () => {
    await run('UPDATE awards SET exercised_quantity = 5000 WHERE id = ?', opt);
    await insert('transactions', { id: 'tx_raised', companyId: cid, type: 'CORRECTION', date: '2024-02-01', securityId: opt, quantity: 1_000, field: 'exercisedQuantity', createdAt: new Date().toISOString() });
  });
  await ok('PATCH', `/awards/${opt}`, { exercisedQuantity: 4_500, effectiveDate: '2024-03-01' });
  await refused('PATCH', `/awards/${opt}`, { exercisedQuantity: 3_000, effectiveDate: '2024-03-01' }, /issued on exercise/i);
  const entries = (await ledgerOf(opt)).map((e) => [e.type, Number(e.quantity), e.field]);
  assert.deepEqual(entries, [['EXERCISE', 4_000, null], ['CORRECTION', 1_000, 'exercisedQuantity'], ['CORRECTION', -500, 'exercisedQuantity']]);
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
  const opt = await grant(20_000);
  const elsewhere = await company('Other Co');
  const foreign = (await call('POST', `/api/c/${elsewhere}/issuances`, {
    stakeholderId: (await call('POST', `/api/c/${elsewhere}/stakeholders`, { name: 'Lior Kade', type: 'INDIVIDUAL', relation: 'OTHER' }, admin)).json.id,
    shareClassId: (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', elsewhere))!.id,
    quantity: 10, pricePerShare: 100, issueDate: '2021-01-01',
  }, admin)).json.id;
  await refused('POST', '/transactions', { type: 'GIFT', date: '2024-01-01', securityId: opt, quantity: 5_000 }, /type/i);
  await refused('POST', '/transactions', { type: 'GRANT', date: '2024-01-01', securityId: opt, quantity: -5 }, /quantity/i);
  await refused('POST', '/transactions', { type: 'GRANT', date: '2024-01-01', securityId: opt, quantity: 2.5 }, /quantity/i);
  await refused('POST', '/transactions', { type: 'ISSUANCE', date: '2024-01-01', securityId: foreign, quantity: 5 }, /company/i);
  const entry = await ok('POST', '/transactions', { type: 'GRANT', date: '2021-03-01', securityId: opt, quantity: 20_000 });
  assert.ok(await one('SELECT 1 FROM audit_log WHERE entity_id = ?', entry.id));
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
  // The text and the certificate face (none here) together.
  assert.equal(signed.bodySha256, createHash('sha256').update(JSON.stringify([`${text} Amended.`, null])).digest('hex'));

  await refused('PATCH', `/documents/${doc.id}`, { body: 'Something else entirely.' }, /signed/i);
  await refused('PATCH', `/documents/${doc.id}`, { status: 'EXECUTED' }, /signed/i);
  await ok('PATCH', `/documents/${doc.id}`, { name: 'Side letter (2024)' });
  assert.equal((await ok('GET', '/documents')).find((d: any) => d.id === doc.id).name, 'Side letter (2024)');
  assert.equal((await one<{ body: string }>('SELECT body FROM documents WHERE id = ?', doc.id))!.body, `${text} Amended.`);
});

// ---------------------------------------------------------------------------
// 7. Review gaps: own dates, holders, manual entries, creation, corrections
// ---------------------------------------------------------------------------

test('a security\'s own date is corrected with a reason, but not across a split or past its own events', async () => {
  await fresh('Own date Co');
  const holder = await person('Tamsin Rook');
  const buyer = await person('Ivo Brandt');
  const cert = (await ok('POST', '/issuances', { stakeholderId: holder, shareClassId: common, quantity: 1_000, pricePerShare: 100, issueDate: '2022-01-01' })).id;
  // A typo in the date is a correction: it needs a reason, and it holds for every date.
  await refused('PATCH', `/issuances/${cert}`, { issueDate: '2022-01-02' }, /reason/i);
  await ok('PATCH', `/issuances/${cert}`, { issueDate: '2022-01-02', reason: 'Board minutes say 2 January' });
  const split = (await ok('POST', '/stock-splits', { date: '2022-06-01', ratio: 2 })).id;
  await ok('POST', `/issuances/${cert}/transfer`, { toStakeholderId: buyer, quantity: 100, date: '2022-03-01' });
  await refused('PATCH', `/issuances/${cert}`, { issueDate: '2022-07-01', reason: 'Typo' }, /split/i);
  await refused('PATCH', `/issuances/${cert}`, { issueDate: '2022-04-01', reason: 'Typo' }, /transfer on 2022-03-01/i);
  assert.equal((await holderAt('2023-01-01', holder)).outstanding, 1_800);
  const opt = await grant(1_000);
  await ok('POST', `/awards/${opt}/exercise`, { quantity: 100, exerciseDate: '2022-02-01', method: 'CASH' });
  await refused('PATCH', `/awards/${opt}`, { grantDate: '2022-07-01', reason: 'Typo' }, /split|exercise/i);
  // Every event here is dated before the split, so it can still go.
  await ok('DELETE', `/stock-splits/${split}`);
});

test('a holder or class typo is a correction with a reason that holds on every date, never a transfer', async () => {
  const a = await person('Nell Quarry');
  const b = await person('Otto Plume');
  const cert = (await ok('POST', '/issuances', { stakeholderId: a, shareClassId: common, quantity: 1_000, pricePerShare: 100, issueDate: '2022-01-01' })).id;
  await refused('PATCH', `/issuances/${cert}`, { stakeholderId: b }, /reason.*transfer/i);
  await refused('PATCH', `/issuances/${cert}`, { stakeholderId: b, reason: '   ' }, /reason/i);
  await ok('PATCH', `/issuances/${cert}`, { stakeholderId: b, reason: 'Entered against the wrong holder' });
  const fix = (await all<{ field: string; before_value: string; after_value: string; reason: string }>(
    "SELECT field, before_value, after_value, reason FROM transactions WHERE security_id = ? AND type = 'CORRECTION'", cert))[0];
  assert.deepEqual([fix.field, JSON.parse(fix.before_value), JSON.parse(fix.after_value), fix.reason], ['stakeholderId', a, b, 'Entered against the wrong holder']);
  // Always was b's: no date shows a's shares, so it is not a transfer.
  assert.equal((await holderAt('2022-01-15', b)).outstanding, 1_000);
  assert.equal((await holderAt('2022-01-15', a)).outstanding ?? 0, 0);
  const other = (await ok('POST', '/share-classes', { name: 'Class B', kind: 'COMMON', authorized: 1_000_000, issueDate: '2020-01-01' })).id;
  await refused('PATCH', `/issuances/${cert}`, { shareClassId: other }, /reason/i);
  await ok('PATCH', `/issuances/${cert}`, { shareClassId: other, reason: 'Class B, as the purchase agreement says' });
  const w = (await ok('POST', '/warrants', { stakeholderId: a, shareClassId: common, quantity: 500, strikePrice: 100, issueDate: '2021-01-01' })).id;
  await ok('PATCH', `/warrants/${w}`, { stakeholderId: b, reason: 'Wrong holder' });
  assert.equal((await ok('GET', `/issuances/${cert}`)).stakeholderId, b);
  // Once something has happened to it, a new holder may be a transfer in disguise (ledger-final-review.test.ts).
  await ok('POST', `/issuances/${cert}/repurchase`, { quantity: 10, date: '2022-02-01' });
  await refused('PATCH', `/issuances/${cert}`, { stakeholderId: a, reason: 'Typo' }, /history.*transfer/i);
  await ok('POST', `/warrants/${w}/exercise`, { quantity: 100, exerciseDate: '2022-01-01' });
  await refused('PATCH', `/warrants/${w}`, { stakeholderId: a, reason: 'Typo' }, /history/i);
});

test('a manual entry cannot be an event the engine rewinds: those come from their routes', async () => {
  const cert = await certificate(1_000, '2022-01-01');
  for (const type of ['TRANSFER', 'REPURCHASE', 'EXERCISE', 'CANCELLATION', 'FORFEITURE', 'EXPIRATION', 'CONVERSION', 'REPAYMENT']) {
    await refused('POST', '/transactions', { type, date: '2024-01-01', securityId: cert, quantity: 500 }, /route|action/i);
  }
  await refused('POST', '/transactions', { type: 'MFN_ELECTION', date: '2024-01-01', securityId: cert, quantity: 1 }, /mfn-election/i);
  // An entry with no security, or one the engine does not rewind, is still a note in the ledger.
  await ok('POST', '/transactions', { type: 'TRANSFER', date: '2024-01-01', quantity: 500, memo: 'Secondary noted' });
  await ok('POST', '/transactions', { type: 'ISSUANCE', date: '2022-01-01', securityId: cert, quantity: 1_000 });
});

test('a security is created in its initial state; a closed or exercised one comes from the import', async () => {
  await refused('POST', '/issuances', { stakeholderId: founder, shareClassId: common, quantity: 10, pricePerShare: 100, issueDate: '2022-01-01', status: 'CANCELLED' }, /outstanding|import/i);
  await refused('POST', '/warrants', { stakeholderId: lender, shareClassId: common, quantity: 10, strikePrice: 100, issueDate: '2022-01-01', status: 'EXERCISED', exercisedQuantity: 10 }, /outstanding|import/i);
  await refused('POST', '/warrants', { stakeholderId: lender, shareClassId: common, quantity: 10, strikePrice: 100, issueDate: '2022-01-01', exercisedQuantity: 5 }, /exercise|import/i);
  await refused('POST', '/awards', { stakeholderId: employee, poolId: plan, type: 'NSO', quantity: 10, strikePrice: 100, grantDate: '2022-01-01', vestingScheduleId: vested, cancelledQuantity: 5 }, /cancel|import/i);
  await refused('POST', '/convertibles', { stakeholderId: lender, instrument: 'SAFE_POST', principal: 100_000, valuationCap: 1_000_000, issueDate: '2022-01-01', status: 'CONVERTED' }, /outstanding|import/i);
  await ok('POST', '/warrants', { stakeholderId: lender, shareClassId: common, quantity: 10, strikePrice: 100, issueDate: '2022-01-01', status: 'OUTSTANDING' });
});

test('a correction keeps status and issued shares consistent', async () => {
  const holder = await person('Fen Aldous');
  const w = (await ok('POST', '/warrants', { stakeholderId: holder, shareClassId: common, quantity: 1_000, strikePrice: 100, issueDate: '2021-01-01' })).id;
  await ok('POST', `/warrants/${w}/exercise`, { quantity: 1_000, exerciseDate: '2022-01-01' });
  // The WX certificate for 1,000 shares stands, so the exercised count cannot drop below it.
  await refused('PATCH', `/warrants/${w}`, { exercisedQuantity: 600, effectiveDate: '2022-06-01' }, /exercise/i);
  // Raising the size reopens the warrant for what is now left.
  const raised = await ok('PATCH', `/warrants/${w}`, { quantity: 1_200, effectiveDate: '2021-01-01' });
  assert.equal(raised.status, 'OUTSTANDING');
  const opt = await grant(1_000);
  await ok('POST', `/awards/${opt}/exercise`, { quantity: 400, exerciseDate: '2022-01-01', method: 'CASH' });
  // Lowering the size to what was exercised uses the grant up.
  const lowered = await ok('PATCH', `/awards/${opt}`, { quantity: 400, effectiveDate: '2023-01-01' });
  assert.equal(lowered.status, 'EXERCISED');
  await refused('PATCH', `/awards/${opt}`, { quantity: 300, effectiveDate: '2023-01-01' }, /exercised|cancelled/i);
});

// ---------------------------------------------------------------------------
// 8. Event routes for what an edit can no longer do
// ---------------------------------------------------------------------------

test('a certificate is cancelled through its route, dated in the ledger in the shares of the day', async () => {
  await fresh('Cancel split Co');
  const holder = await person('Rhea Lantos');
  const cert = (await ok('POST', '/issuances', { stakeholderId: holder, shareClassId: common, quantity: 1_000, pricePerShare: 100, issueDate: '2022-01-01' })).id;
  await refused('PATCH', `/issuances/${cert}`, { status: 'CANCELLED' }, /cancel/i);
  await refused('POST', `/issuances/${cert}/cancel`, { date: '2021-12-31' }, /before/i);
  const split = (await ok('POST', '/stock-splits', { date: '2022-06-01', ratio: 2 })).id;
  await ok('POST', `/issuances/${cert}/cancel`, { quantity: 400, date: '2023-01-01' });
  assert.deepEqual((await ledgerOf(cert)).map((e) => [e.type, e.date, Number(e.quantity)]), [['CANCELLATION', '2023-01-01', 800]]);
  const closed = await ok('POST', `/issuances/${cert}/cancel`, { date: '2024-01-01' });
  assert.equal(closed.status, 'CANCELLED');
  await refused('POST', `/issuances/${cert}/cancel`, { date: '2024-02-01' }, /outstanding/i);
  assert.deepEqual([(await holderAt('2022-12-31', holder)).outstanding, (await holderAt('2023-06-01', holder)).outstanding, (await holderAt('2024-06-01', holder)).outstanding ?? 0], [2_000, 1_200, 0]);
  assert.ok(await one('SELECT 1 FROM audit_log WHERE entity_id = ? AND action = ?', cert, 'CANCEL'));
  await refused('DELETE', `/stock-splits/${split}`, undefined, /restate/i);
  await fresh('After cancel split Co');
});

test('a warrant expires or is cancelled through its route, and past views keep it', async () => {
  const holder = await person('Sable Okonkwo');
  const w = (await ok('POST', '/warrants', { stakeholderId: holder, shareClassId: common, quantity: 1_000, strikePrice: 100, issueDate: '2021-01-01' })).id;
  await refused('PATCH', `/warrants/${w}`, { status: 'EXPIRED' }, /cancel/i);
  await ok('POST', `/warrants/${w}/exercise`, { quantity: 300, exerciseDate: '2022-01-01' });
  const r = await ok('POST', `/warrants/${w}/cancel`, { date: '2023-01-01', reason: 'EXPIRED' });
  assert.equal(r.status, 'EXPIRED');
  assert.deepEqual((await ledgerOf(w)).map((e) => [e.type, Number(e.quantity)]), [['EXERCISE', 300], ['EXPIRATION', 700]]);
  assert.equal((await holderAt('2022-06-01', holder)).warrantsOutstanding, 700);
  assert.equal((await holderAt('2023-06-01', holder)).warrantsOutstanding ?? 0, 0);
  const w2 = (await ok('POST', '/warrants', { stakeholderId: holder, shareClassId: common, quantity: 500, strikePrice: 100, issueDate: '2021-01-01' })).id;
  assert.equal((await ok('POST', `/warrants/${w2}/cancel`, { date: '2023-01-01' })).status, 'CANCELLED');
  await refused('POST', `/warrants/${w2}/cancel`, { date: '2023-02-01' }, /outstanding/i);
});

test('a note is repaid, and a SAFE cancelled, through their routes; past views keep them outstanding', async () => {
  const holder = await person('Bea Halvorsen');
  const note = (await ok('POST', '/convertibles', { stakeholderId: holder, instrument: 'NOTE', principal: 5_000_000, valuationCap: 1_000_000_000, interestRate: 0.05, maturityDate: '2024-01-01', issueDate: '2021-01-01' })).id;
  await refused('PATCH', `/convertibles/${note}`, { status: 'REPAID' }, /repay/i);
  await refused('POST', `/convertibles/${note}/repay`, { date: '2020-12-31' }, /before/i);
  assert.equal((await ok('POST', `/convertibles/${note}/repay`, { date: '2024-01-01', amount: 5_500_000 })).status, 'REPAID');
  assert.deepEqual((await ledgerOf(note)).map((e) => e.type), ['REPAYMENT']);
  const safe = (await ok('POST', '/convertibles', { stakeholderId: holder, instrument: 'SAFE_POST', principal: 1_000_000, valuationCap: 1_000_000_000, issueDate: '2021-01-01' })).id;
  assert.equal((await ok('POST', `/convertibles/${safe}/cancel`, { date: '2023-01-01' })).status, 'CANCELLED');
  const principal = async (asOf: string) => (await ok('GET', `/captable?asOf=${asOf}&includeConvertibles=true`)).table.rows.find((r: any) => r.stakeholderId === holder)?.convertiblePrincipal ?? 0;
  assert.deepEqual([await principal('2022-06-01'), await principal('2023-06-01'), await principal('2024-06-01')], [6_000_000, 5_000_000, 0]);
  await refused('POST', `/convertibles/${safe}/repay`, { date: '2023-02-01' }, /outstanding|settled/i);
});

// ---------------------------------------------------------------------------
// 9. Signed documents cannot be deleted, and a changed text shows
// ---------------------------------------------------------------------------

test('a document anyone has signed cannot be deleted, and a text changed under a signature is flagged', async () => {
  const doc = await ok('POST', '/documents', { name: 'Board consent', category: 'OTHER', body: 'Resolved.', requiresSignature: true, signers: [{ name: 'Wren Ashby' }, { name: 'Odile Fenwick', stakeholderId: lender }] });
  const draft = await ok('POST', '/documents', { name: 'Draft', category: 'OTHER', body: 'Draft.', requiresSignature: true, signers: [{ name: 'Wren Ashby' }] });
  await ok('DELETE', `/documents/${draft.id}`);
  const block = (await one<{ id: string }>('SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id IS NULL', doc.id))!.id;
  await ok('POST', `/signatures/${block}/sign`, { typedSignature: 'Wren Ashby' });
  await refused('DELETE', `/documents/${doc.id}`, undefined, /signed/i);
  const listed = async () => (await ok('GET', '/documents')).find((d: any) => d.id === doc.id);
  assert.equal((await listed()).tampered, false);
  // Changed in the database, past the routes.
  await run('UPDATE documents SET body = ? WHERE id = ?', 'Resolved, and more.', doc.id);
  assert.equal((await listed()).tampered, true);
  const res = await fetch(`${base}${c(`/documents/${doc.id}/print`)}`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(await res.text(), /changed since it was signed/i);
});
