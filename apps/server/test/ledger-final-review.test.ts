/**
 * The final review of the dated ledger (docs/design/dated-ledger.md): a pending
 * security cannot go live by an edit, every term the views read as of a date is a
 * dated CORRECTION, a holder or class "typo" cannot hide a transfer, a signed
 * document keeps its holder, and an instrument an MFN holder elected keeps its date
 * and the terms it had on the election date. Holders and figures are invented.
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
await import('../src/routes/fundraising.ts');
const { one, all, run, transaction } = await import('../src/db.ts');

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

const admin = (await call('POST', '/api/auth/register', { email: 'tamsin@example.com', name: 'Tamsin Rowe', password: 'tamsin-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Final Review Co', incorporationDate: '2020-01-01', authorizedCommon: 50_000_000 }, admin)).json.id as string;
const c = (path: string) => `/api/c/${cid}${path}`;
const ok = async (method: string, path: string, body?: unknown) => {
  const r = await call(method, c(path), body, admin);
  assert.equal(r.status, 200, `${method} ${path} → ${JSON.stringify(r.json)}`);
  return r.json;
};
const refused = async (method: string, path: string, body: unknown, words: RegExp) => {
  const r = await call(method, c(path), body, admin);
  assert.equal(r.status, 400, `${method} ${path} should be refused: ${JSON.stringify(r.json)}`);
  assert.match(r.json.error ?? JSON.stringify(r.json), words);
};
const commitFails = (fn: () => Promise<unknown>) => assert.rejects(transaction(fn), /needs a dated ledger entry/);

const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vested = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
const person = async (name: string, relation = 'OTHER') => (await ok('POST', '/stakeholders', { name, type: 'INDIVIDUAL', relation })).id as string;
const founder = await person('Tamsin Rowe', 'FOUNDER');
const other = await person('Ivo Darrow');
const third = await person('Neve Castell');
const plan = (await ok('POST', '/pools', { name: 'Review Plan', shareClassId: common, authorized: 1_000_000, boardApprovalDate: '2020-01-01', returnForfeitures: 1, planType: 'STOCK_PLAN' })).id as string;
const preferred = (await ok('POST', '/share-classes', { name: 'Series Seed', kind: 'PREFERRED', authorized: 5_000_000, issueDate: '2020-01-01', originalIssuePrice: 1_000_000, conversionRatio: 1, isConvertible: 1, seniority: 1 })).id as string;
const certificate = async (quantity: number, issueDate = '2021-01-15', holder = founder) =>
  (await ok('POST', '/issuances', { stakeholderId: holder, shareClassId: common, quantity, pricePerShare: 100, issueDate })).id as string;
const grant = async (quantity: number, o: Record<string, unknown> = {}) => (await ok('POST', '/awards', {
  stakeholderId: other, poolId: plan, type: 'NSO', quantity, strikePrice: 100_000, grantDate: '2021-03-01',
  vestingScheduleId: vested, status: 'OUTSTANDING', expirationDate: '2031-03-01', fmvAtGrant: 100_000, ...o,
})).id as string;
const ledgerOf = (id: string) => all<{ type: string; date: string; field: string | null; before_value: string | null; after_value: string | null }>(
  'SELECT type, date, field, before_value, after_value FROM transactions WHERE security_id = ? ORDER BY date, created_at', id);
const row = async (asOf: string, holder: string, extra = '') =>
  (await ok('GET', `/captable?asOf=${asOf}${extra}`)).table.rows.find((r: any) => r.stakeholderId === holder) ?? {};

// ---------------------------------------------------------------------------
// 1. A pending security goes live only through its signing or approval flow
// ---------------------------------------------------------------------------

test('1. an edit cannot move a certificate, grant, warrant or SAFE out of PENDING_* or into it', async () => {
  const cert = (await ok('POST', '/issuances/issue-for-signature', { stakeholderId: other, shareClassId: common, quantity: 500, issueDate: '2024-01-02' })).issuance.id;
  const signing = (await ok('POST', '/awards/issue', { stakeholderId: other, poolId: plan, type: 'NSO', quantity: 1_000, strikePrice: 100, grantDate: '2024-01-02', vestingScheduleId: vested, signing: {} })).award.id;
  const approval = 'a_pending';
  await run(`INSERT INTO awards (id, company_id, stakeholder_id, pool_id, type, quantity, grant_date, vesting_start_date, vesting_schedule_id, status, created_at)
             VALUES (?, ?, ?, ?, 'NSO', 1000, '2024-01-02', '2024-01-02', ?, 'PENDING_APPROVAL', 'now')`, approval, cid, other, plan, vested);
  const safe = (await ok('POST', '/convertibles/issue', { investors: [{ stakeholderId: other, principal: 1_000_000 }], terms: { instrument: 'SAFE_POST', valuationCap: 100_000_000 }, issueDate: '2024-01-02', signing: {} })).convertibles[0].id;
  await run(`INSERT INTO warrants (id, company_id, stakeholder_id, share_class_id, quantity, strike_price, issue_date, status, created_at)
             VALUES ('w_pending', ?, ?, ?, 100, 100, '2024-01-02', 'PENDING_APPROVAL', 'now')`, cid, other, common);
  const pending: [string, string][] = [['issuances', cert], ['awards', signing], ['awards', approval], ['convertibles', safe], ['warrants', 'w_pending']];
  for (const [path, id] of pending) {
    const before = (await one<{ status: string }>(`SELECT status FROM ${path} WHERE id = ?`, id))!.status;
    assert.match(before, /^PENDING_/, `${path} starts pending`);
    await refused('PATCH', `/${path}/${id}`, { status: 'OUTSTANDING' }, /signing or approval/);
    assert.equal((await one<{ status: string }>(`SELECT status FROM ${path} WHERE id = ?`, id))!.status, before, `${path} stays ${before}`);
    assert.deepEqual(await ledgerOf(id), [], `${path}: nothing in the ledger`);
  }
  // Into it: an issued security cannot be sent back to signing or approval by an edit, nor created there.
  const live = await certificate(100);
  const liveGrant = await grant(100);
  const liveWarrant = (await ok('POST', '/warrants', { stakeholderId: other, shareClassId: common, quantity: 100, strikePrice: 100, issueDate: '2023-01-01' })).id;
  const liveSafe = (await ok('POST', '/convertibles', { stakeholderId: other, instrument: 'SAFE_POST', principal: 1_000_000, valuationCap: 100_000_000, issueDate: '2023-01-01' })).id;
  for (const [path, id] of [['issuances', live], ['awards', liveGrant], ['warrants', liveWarrant], ['convertibles', liveSafe]]) {
    await refused('PATCH', `/${path}/${id}`, { status: 'PENDING_APPROVAL' }, /signing or approval/);
  }
  await refused('POST', '/warrants', { stakeholderId: other, shareClassId: common, quantity: 100, strikePrice: 100, issueDate: '2023-01-01', status: 'PENDING_APPROVAL' }, /signing or approval/);
});

// ---------------------------------------------------------------------------
// 2. Every term the views read as of a date is a dated CORRECTION
// ---------------------------------------------------------------------------

test('2. a grant\'s vesting start, strike and expiry change on a date with a CORRECTION; earlier dates keep the old terms', async () => {
  const fourYear = (await ok('POST', '/vesting-schedules', { name: 'Four years, one-year cliff', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY' })).id;
  const holder = await person('Orla Brannock', 'EMPLOYEE');
  const g = await grant(4_800, { stakeholderId: holder, vestingScheduleId: fourYear, vestingStartDate: '2021-03-01' });
  await refused('PATCH', `/awards/${g}`, { vestingStartDate: '2022-03-01' }, /effective date/i);
  await ok('PATCH', `/awards/${g}`, { vestingStartDate: '2022-03-01', strikePrice: 50_000, expirationDate: '2030-03-01', effectiveDate: '2023-01-01' });
  const fixes = (await ledgerOf(g)).filter((e) => e.type === 'CORRECTION');
  assert.deepEqual(fixes.map((e) => [e.date, e.field, JSON.parse(e.before_value!), JSON.parse(e.after_value!)]).sort(), [
    ['2023-01-01', 'expirationDate', '2031-03-01', '2030-03-01'],
    ['2023-01-01', 'strikePrice', 100_000, 50_000],
    ['2023-01-01', 'vestingStartDate', '2021-03-01', '2022-03-01'],
  ]);
  // Vested as of a date counts from the start in force then: 21 months, then back inside the new cliff.
  assert.equal((await row('2022-12-31', holder)).optionsVested, 2_100);
  assert.equal((await row('2023-01-01', holder)).optionsVested, 0);
});

test('2. a warrant\'s expiry and strike, and a certificate\'s vesting, are corrected the same way', async () => {
  const holder = await person('Bastian Quell');
  const w = (await ok('POST', '/warrants', { stakeholderId: holder, shareClassId: common, quantity: 1_000, strikePrice: 100_000, issueDate: '2021-01-01', expirationDate: '2030-01-01' })).id;
  await refused('PATCH', `/warrants/${w}`, { expirationDate: '2022-01-01' }, /effective date/i);
  await ok('PATCH', `/warrants/${w}`, { expirationDate: '2022-01-01', strikePrice: 120_000, effectiveDate: '2023-06-01' });
  // The views drop a warrant past its expiry: before the correction it ran to 2030.
  assert.equal((await row('2023-05-31', holder)).warrantsOutstanding, 1_000);
  assert.equal((await row('2023-06-01', holder)).warrantsOutstanding ?? 0, 0);
  const cert = await certificate(1_000, '2021-01-15', holder);
  await refused('PATCH', `/issuances/${cert}`, { vestingScheduleId: vested, vestingStartDate: '2021-02-01' }, /effective date/i);
  await ok('PATCH', `/issuances/${cert}`, { vestingScheduleId: vested, vestingStartDate: '2021-02-01', effectiveDate: '2021-01-15' });
  assert.deepEqual((await ledgerOf(cert)).filter((e) => e.type === 'CORRECTION').map((e) => e.field).sort(), ['vestingScheduleId', 'vestingStartDate']);
});

test('2. the trigger holds the new term columns: a raw UPDATE with no ledger entry fails at commit', async () => {
  const cert = await certificate(100);
  const g = await grant(100);
  const w = (await ok('POST', '/warrants', { stakeholderId: other, shareClassId: common, quantity: 100, strikePrice: 100, issueDate: '2023-01-01' })).id;
  await commitFails(() => run('UPDATE issuances SET price_per_share = 5 WHERE id = ?', cert));
  await commitFails(() => run("UPDATE issuances SET vesting_start_date = '2022-01-01' WHERE id = ?", cert));
  for (const set of ['strike_price = 5', "vesting_start_date = '2022-01-01'", "expiration_date = '2025-01-01'", 'ptep_months = 12', 'fmv_at_grant = 5', "type = 'ISO'"]) {
    await commitFails(() => run(`UPDATE awards SET ${set} WHERE id = ?`, g));
  }
  await commitFails(() => run('UPDATE warrants SET strike_price = 5 WHERE id = ?', w));
  await commitFails(() => run("UPDATE warrants SET expiration_date = '2025-01-01' WHERE id = ?", w));
  // A label is not dated state.
  await transaction(() => run("UPDATE awards SET notes = 'relabelled' WHERE id = ?", g));
});

// ---------------------------------------------------------------------------
// 3. A holder or class "typo" cannot hide a transfer
// ---------------------------------------------------------------------------

test('3. a holder or class correction is refused once the security has history, or was issued by an event', async () => {
  const source = await certificate(1_000, '2021-01-15');
  const bought = (await ok('POST', `/issuances/${source}/transfer`, { toStakeholderId: other, quantity: 400, date: '2022-01-01' })).id as string;
  await refused('PATCH', `/issuances/${bought}`, { stakeholderId: third, reason: 'Typo' }, /transfer/);
  await refused('PATCH', `/issuances/${source}`, { stakeholderId: third, reason: 'Typo' }, /transfer/);
  await refused('PATCH', `/issuances/${source}`, { shareClassId: preferred, reason: 'Typo' }, /history|transfer/);
  const g = await grant(1_000);
  await ok('POST', `/awards/${g}/exercise`, { quantity: 100, exerciseDate: '2022-01-01', method: 'CASH' });
  await refused('PATCH', `/awards/${g}`, { stakeholderId: third, reason: 'Typo' }, /history/);
  assert.equal((await one<{ stakeholder_id: string }>('SELECT stakeholder_id FROM issuances WHERE id = ?', bought))!.stakeholder_id, other);
  // With only its creation in the ledger, a typo is still fixed with a reason.
  const fresh = await certificate(50);
  await ok('PATCH', `/issuances/${fresh}`, { stakeholderId: third, reason: 'Entered against the wrong holder' });
});

// ---------------------------------------------------------------------------
// 4. A signed document keeps its holder
// ---------------------------------------------------------------------------

test('4. a signed document cannot be given to another holder; its name and category can change, in the audit log', async () => {
  const doc = await ok('POST', '/documents', { name: 'Side letter', category: 'AGREEMENT', body: 'Agreed.', stakeholderId: other, requiresSignature: true, signers: [{ name: 'Tamsin Rowe' }] });
  const block = (await one<{ id: string }>('SELECT id FROM signatures WHERE document_id = ?', doc.id))!.id;
  await ok('POST', `/signatures/${block}/sign`, { typedSignature: 'Tamsin Rowe' });
  await refused('PATCH', `/documents/${doc.id}`, { stakeholderId: third }, /signed/);
  await refused('PATCH', `/documents/${doc.id}`, { stakeholderId: null }, /signed/);
  await ok('PATCH', `/documents/${doc.id}`, { name: 'Side letter (Ivo)', category: 'FINANCING', stakeholderId: other });
  const logged = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE entity_id = ? AND action = 'UPDATE' ORDER BY created_at DESC LIMIT 1", doc.id);
  assert.match(logged!.detail, /Side letter \(Ivo\)/);
  assert.match(logged!.detail, /FINANCING/);
  // Before anyone signs, the holder is still free to fix.
  const draft = await ok('POST', '/documents', { name: 'Draft', category: 'OTHER', body: 'Draft.', stakeholderId: other });
  await ok('PATCH', `/documents/${draft.id}`, { stakeholderId: third });
});

// ---------------------------------------------------------------------------
// 5. An instrument an MFN holder elected
// ---------------------------------------------------------------------------

test('5. an elected instrument cannot be redated past the election, and keeps for the holder the terms it had then', async () => {
  const holder = await person('Mira Talbot', 'INVESTOR');
  const mfn = (await ok('POST', '/convertibles', { stakeholderId: holder, instrument: 'SAFE_PRE', principal: 100_000_000, valuationCap: null, issueDate: '2022-01-01', mfn: 1 })).id;
  const y = (await ok('POST', '/convertibles', { stakeholderId: await person('Yusuf Hale', 'INVESTOR'), instrument: 'SAFE_POST', principal: 100_000_000, valuationCap: 550_000_000, issueDate: '2022-06-01' })).id;
  await ok('POST', `/convertibles/${mfn}/mfn-election`, { adoptedId: y, date: '2023-01-01' });
  await refused('PATCH', `/convertibles/${y}`, { issueDate: '2023-02-01', reason: 'Typo' }, /MFN/);
  await refused('PATCH', `/convertibles/${y}`, { issueDate: '2021-12-01', reason: 'Typo' }, /MFN/);
  await ok('PATCH', `/convertibles/${y}`, { issueDate: '2022-07-01', reason: 'Board minutes give another date' });

  const capOf = async (id: string, asOf: string) => (await ok('GET', `/model/convertibles?asOf=${asOf}`)).instruments.find((i: any) => i.id === id).cap;
  assert.equal(await capOf(mfn, '2023-08-01'), 550_000_000);
  // The adopted SAFE's cap is amended from 2023-06-01: the holder elected the cap of 2023-01-01.
  await ok('PATCH', `/convertibles/${y}`, { valuationCap: 300_000_000, effectiveDate: '2023-06-01' });
  assert.equal(await capOf(y, '2023-08-01'), 300_000_000);
  assert.equal(await capOf(mfn, '2023-08-01'), 550_000_000);
});
