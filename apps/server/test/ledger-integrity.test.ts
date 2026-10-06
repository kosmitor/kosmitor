/**
 * The database holds the ledger rule (docs/design/dated-ledger.md): a change to a
 * security or a stock split fails at COMMIT unless the same transaction wrote its
 * dated ledger entry. And the second review's findings: splits, withdrawing a partly
 * signed document, generic create and delete, convertible terms, signed certificates,
 * typo corrections, relinking signed documents, and the hash of what was signed.
 * Holders and figures are invented.
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
const { one, all, run, transaction, insert } = await import('../src/db.ts');

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
const cid = (await call('POST', '/api/companies', { name: 'Integrity Co', incorporationDate: '2020-01-01', authorizedCommon: 50_000_000 }, admin)).json.id as string;
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
const person = async (name: string) => (await ok('POST', '/stakeholders', { name, type: 'INDIVIDUAL', relation: 'OTHER' })).id as string;
const founder = await person('Wren Ashby');
const other = await person('Odile Fenwick');
const certificate = async (quantity: number, issueDate = '2020-01-15', holder = founder) =>
  (await ok('POST', '/issuances', { stakeholderId: holder, shareClassId: common, quantity, pricePerShare: 100, issueDate })).id as string;
const holderAt = async (asOf: string, id: string) => (await ok('GET', `/captable?asOf=${asOf}`)).table.rows.find((r: any) => r.stakeholderId === id) ?? {};
const ledgerOf = (id: string) => all<{ type: string; date: string; quantity: number | null; field: string | null; before_value: string | null; after_value: string | null; reason: string | null }>(
  'SELECT type, date, quantity, field, before_value, after_value, reason FROM transactions WHERE security_id = ? ORDER BY date, created_at', id);
const commitFails = async (fn: () => Promise<unknown>) => {
  await assert.rejects(transaction(fn), /needs a dated (STOCK_SPLIT )?ledger entry/);
};

// ---------------------------------------------------------------------------
// A. The trigger
// ---------------------------------------------------------------------------

test('a raw UPDATE of a quantity with no ledger entry fails at commit; with one it holds', async () => {
  const cert = await certificate(1_000);
  await commitFails(() => run('UPDATE issuances SET quantity = 900 WHERE id = ?', cert));
  assert.equal((await one<{ quantity: number }>('SELECT quantity FROM issuances WHERE id = ?', cert))!.quantity, 1_000);
  // The entry may come after the change: the check waits for the commit.
  await transaction(async () => {
    await run('UPDATE issuances SET quantity = 900 WHERE id = ?', cert);
    await insert('transactions', { id: `tx_${Date.now()}`, companyId: cid, type: 'CORRECTION', date: '2020-01-15', securityId: cert, quantity: -100, field: 'quantity', createdAt: new Date().toISOString() });
  });
  assert.equal((await one<{ quantity: number }>('SELECT quantity FROM issuances WHERE id = ?', cert))!.quantity, 900);
});

test('an entry for another security, or one written by an earlier transaction, does not count', async () => {
  const a = await certificate(1_000), b = await certificate(1_000);
  await commitFails(async () => {
    await run('UPDATE issuances SET quantity = 900 WHERE id = ?', a);
    await insert('transactions', { id: `tx_${Date.now()}b`, companyId: cid, type: 'CORRECTION', date: '2020-01-15', securityId: b, quantity: -100, field: 'quantity', createdAt: new Date().toISOString() });
  });
  // a already has its ISSUANCE entry from its creation, in another transaction.
  await commitFails(() => run('DELETE FROM issuances WHERE id = ?', a));
  await commitFails(() => run("UPDATE issuances SET status = 'CANCELLED' WHERE id = ?", a));
  await commitFails(() => run('UPDATE issuances SET stakeholder_id = ? WHERE id = ?', other, a));
});

test('every security table and stock splits are held; an edit of another column is not', async () => {
  const cert = await certificate(1_000);
  await transaction(() => run("UPDATE issuances SET notes = 'filed' WHERE id = ?", cert));
  await commitFails(() => run(`INSERT INTO warrants (id, company_id, stakeholder_id, share_class_id, quantity, issue_date, created_at) VALUES ('w_raw', ?, ?, ?, 10, '2021-01-01', 'now')`, cid, founder, common));
  await commitFails(() => run(`INSERT INTO convertibles (id, company_id, stakeholder_id, instrument, principal, issue_date, created_at) VALUES ('c_raw', ?, ?, 'SAFE_POST', 100, '2021-01-01', 'now')`, cid, founder));
  await commitFails(() => run(`INSERT INTO stock_splits (id, company_id, date, ratio, created_at) VALUES ('s_raw', ?, '2021-01-01', 2, 'now')`, cid));
  // Not yet issued: a certificate awaiting signatures is not on the cap table.
  await transaction(() => run(`INSERT INTO issuances (id, company_id, stakeholder_id, share_class_id, quantity, issue_date, status, created_at) VALUES ('i_pending', ?, ?, ?, 10, '2021-01-01', 'PENDING_SIGNATURE', 'now')`, cid, founder, common));
  await commitFails(() => run("UPDATE issuances SET status = 'OUTSTANDING' WHERE id = 'i_pending'"));
  await transaction(() => run("DELETE FROM issuances WHERE id = 'i_pending'"));
});

// ---------------------------------------------------------------------------
// B. Review findings
// ---------------------------------------------------------------------------

/** A company of its own, for the tests a split would otherwise reach across. */
async function another(name: string) {
  const id = (await call('POST', '/api/companies', { name, incorporationDate: '2020-01-01', authorizedCommon: 50_000_000 }, admin)).json.id as string;
  const at = async (method: string, path: string, body?: unknown, status = 200) => {
    const r = await call(method, `/api/c/${id}${path}`, body, admin);
    assert.equal(r.status, status, `${method} ${path} → ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const cls = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', id))!.id;
  const holder = (await at('POST', '/stakeholders', { name: 'Ines Calder', type: 'INDIVIDUAL', relation: 'FOUNDER' })).id as string;
  const held = async (asOf: string) => (await at('GET', `/captable?asOf=${asOf}`)).table.rows.find((r: any) => r.stakeholderId === holder)?.outstanding ?? 0;
  return { id, at, cls, holder, held };
}

test('1. a split dated behind recorded entries is refused, so past cap tables stay as they were', async () => {
  const co = await another('Split Co');
  const cert = (await co.at('POST', '/issuances', { stakeholderId: co.holder, shareClassId: co.cls, quantity: 100, pricePerShare: 100, issueDate: '2020-01-15' })).id;
  await co.at('POST', `/issuances/${cert}/cancel`, { quantity: 40, date: '2022-01-01' });
  // The review's case: added afterwards, this split read the 2022 cancellation as 80 old shares.
  const r = await call('POST', `/api/c/${co.id}/stock-splits`, { date: '2021-01-01', ratio: 2 }, admin);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /restate ledger entries.*cancellation on 2022-01-01/);
  assert.deepEqual([await co.held('2020-06-01'), await co.held('2022-06-01')], [100, 60]);
  // After the last entry it is recorded, with a dated STOCK_SPLIT entry.
  const split = (await co.at('POST', '/stock-splits', { date: '2022-06-01', ratio: 2 })).id;
  assert.deepEqual([await co.held('2020-06-01'), await co.held('2022-01-15'), await co.held('2023-01-01')], [100, 60, 120]);
  await co.at('PATCH', `/stock-splits/${split}`, { ratio: 3 });
  await co.at('POST', `/issuances/${cert}/cancel`, { quantity: 30, date: '2023-01-01' });
  await co.at('PATCH', `/stock-splits/${split}`, { ratio: 2 }, 400);
  await co.at('DELETE', `/stock-splits/${split}`, undefined, 400);
  const entries = await all<{ date: string; before_value: string | null; after_value: string | null }>(
    "SELECT date, before_value, after_value FROM transactions WHERE company_id = ? AND type = 'STOCK_SPLIT' ORDER BY created_at", co.id);
  assert.deepEqual(entries.map((e) => [e.date, JSON.parse(e.before_value ?? 'null'), JSON.parse(e.after_value ?? 'null')]), [
    ['2022-06-01', null, { date: '2022-06-01', ratio: 2 }],
    ['2022-06-01', { date: '2022-06-01', ratio: 2 }, { date: '2022-06-01', ratio: 3 }],
  ]);
});

/** Signs one block of a document as the administrator, who may sign for the Company and, here, for the holder. */
const sign = async (documentId: string, holderBlock: boolean) => {
  const block = (await one<{ id: string }>(`SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id IS ${holderBlock ? 'NOT ' : ''}NULL`, documentId))!.id;
  await ok('POST', `/signatures/${block}/sign`, { typedSignature: 'Wren Ashby' });
};
const docsOf = (securityId: string) => all<{ id: string; status: string }>('SELECT id, status FROM documents WHERE security_id = ? ORDER BY created_at', securityId);
const sigStatuses = (documentId: string) => all<{ status: string }>('SELECT status FROM signatures WHERE document_id = ? ORDER BY status', documentId);

test('2. withdrawing a partly signed certificate, grant or SAFE voids its document and keeps the signatures', async () => {
  const vesting = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
  const plan = (await ok('POST', '/pools', { name: 'Withdraw Plan', shareClassId: common, authorized: 100_000, boardApprovalDate: '2020-01-01', returnForfeitures: 1, planType: 'STOCK_PLAN' })).id;
  const cert = (await ok('POST', '/issuances/issue-for-signature', { stakeholderId: other, shareClassId: common, quantity: 500, issueDate: '2024-01-02' })).issuance.id;
  const grant = (await ok('POST', '/awards/issue', { stakeholderId: other, poolId: plan, type: 'NSO', quantity: 1_000, strikePrice: 100, grantDate: '2024-01-02', vestingScheduleId: vesting, signing: {} })).award.id;
  const safe = (await ok('POST', '/convertibles/issue', { investors: [{ stakeholderId: other, principal: 1_000_000 }], terms: { instrument: 'SAFE_POST', valuationCap: 100_000_000 }, issueDate: '2024-01-02', signing: {} })).convertibles[0].id;
  for (const [path, id] of [['issuances', cert], ['awards', grant], ['convertibles', safe]]) {
    const [doc] = await docsOf(id);
    await sign(doc.id, true);
    await ok('POST', `/${path}/${id}/cancel-signing`);
    assert.deepEqual(await docsOf(id), [{ id: doc.id, status: 'VOID' }], `${path}: the signed document is kept, void`);
    assert.deepEqual((await sigStatuses(doc.id)).map((s) => s.status), ['SIGNED', 'VOID'], `${path}: the signature stays; the open block cannot be signed`);
    assert.ok(await one("SELECT 1 FROM audit_log WHERE entity_id = ? AND action = 'VOID'", doc.id));
    await refused('DELETE', `/documents/${doc.id}`, undefined, /signed/i);
  }
  const companyBlock = (await one<{ id: string }>('SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id IS NULL', (await docsOf(cert))[0].id))!.id;
  await refused('POST', `/signatures/${companyBlock}/sign`, { typedSignature: 'Wren Ashby' }, /void/i);
  // Nobody signed: the document goes with the certificate.
  const unsigned = (await ok('POST', '/issuances/issue-for-signature', { stakeholderId: other, shareClassId: common, quantity: 500, issueDate: '2024-01-02' })).issuance.id;
  await ok('POST', `/issuances/${unsigned}/cancel-signing`);
  assert.deepEqual(await docsOf(unsigned), []);
});

test('3. creating a security writes its dated entry; one entered by mistake can be deleted only while that is all its ledger holds', async () => {
  const cert = await certificate(700, '2023-03-03');
  const w = (await ok('POST', '/warrants', { stakeholderId: founder, shareClassId: common, quantity: 50, strikePrice: 100, issueDate: '2023-03-03' })).id;
  const safe = (await ok('POST', '/convertibles', { stakeholderId: founder, instrument: 'SAFE_POST', principal: 2_500_000, valuationCap: 100_000_000, issueDate: '2023-03-03' })).id;
  assert.deepEqual((await ledgerOf(cert)).map((e) => [e.type, e.date, Number(e.quantity)]), [['ISSUANCE', '2023-03-03', 700]]);
  assert.deepEqual((await ledgerOf(w)).map((e) => [e.type, Number(e.quantity)]), [['ISSUANCE', 50]]);
  assert.equal((await one<{ amount: number }>("SELECT amount FROM transactions WHERE security_id = ? AND type = 'ISSUANCE'", safe))!.amount, 2_500_000);
  await ok('DELETE', `/issuances/${cert}?reason=${encodeURIComponent('Entered twice')}`);
  assert.deepEqual((await ledgerOf(cert)).map((e) => [e.type, e.field, e.reason]), [['ISSUANCE', null, null], ['CORRECTION', 'deleted', 'Entered twice']]);
  const kept = await certificate(300, '2023-03-03');
  await ok('POST', `/issuances/${kept}/cancel`, { quantity: 100, date: '2023-06-01' });
  await refused('DELETE', `/issuances/${kept}`, undefined, /history beyond its creation.*cancel/i);
});

test('4. a convertible\'s principal or terms change on a date with a CORRECTION; earlier dates keep the old terms', async () => {
  const safe = (await ok('POST', '/convertibles', { stakeholderId: other, instrument: 'SAFE_POST', principal: 10_000_000, valuationCap: 1_000_000_000, issueDate: '2021-01-01' })).id;
  await refused('PATCH', `/convertibles/${safe}`, { principal: 12_000_000 }, /effective date/i);
  await ok('PATCH', `/convertibles/${safe}`, { principal: 12_000_000, valuationCap: 800_000_000, effectiveDate: '2023-01-01', reason: 'Side letter' });
  const fixes = (await ledgerOf(safe)).filter((e) => e.type === 'CORRECTION').map((e) => [e.field, e.date, JSON.parse(e.before_value!), JSON.parse(e.after_value!)]);
  assert.deepEqual(fixes, [['principal', '2023-01-01', 10_000_000, 12_000_000], ['valuationCap', '2023-01-01', 1_000_000_000, 800_000_000]]);
  const principal = async (asOf: string) => (await ok('GET', `/captable?asOf=${asOf}&includeConvertibles=true`)).table.rows.find((r: any) => r.stakeholderId === other)?.convertiblePrincipal ?? 0;
  assert.deepEqual([await principal('2022-06-01'), await principal('2023-06-01')], [10_000_000, 12_000_000]);
});

test('5. correcting a signed certificate voids it and sends a corrected one to sign; it is flagged until signed', async () => {
  const cert = (await ok('POST', '/issuances/issue-for-signature', { stakeholderId: other, shareClassId: common, quantity: 1_200, issueDate: '2024-02-02' })).issuance.id;
  const [signed] = await docsOf(cert);
  await sign(signed.id, true);
  await sign(signed.id, false);
  assert.equal((await ok('GET', `/issuances/${cert}`)).status, 'OUTSTANDING');
  await ok('PATCH', `/issuances/${cert}`, { quantity: 1_000, effectiveDate: '2024-02-02' });
  const docs = await docsOf(cert);
  assert.deepEqual(docs.map((d) => d.status), ['VOID', 'AWAITING_SIGNATURE']);
  assert.deepEqual((await sigStatuses(signed.id)).map((s) => s.status), ['SIGNED', 'SIGNED'], 'the void certificate keeps both signatures');
  const listed = async (id: string) => (await ok('GET', '/documents')).find((d: any) => d.id === id);
  const replacement = await listed(docs[1].id);
  assert.equal(replacement.resign, true);
  assert.match(replacement.body, /1,000/);
  assert.equal((await listed(signed.id)).status, 'VOID');
  await sign(docs[1].id, true);
  await sign(docs[1].id, false);
  const done = await listed(docs[1].id);
  assert.deepEqual([done.status, done.resign], ['EXECUTED', false]);
  assert.equal((await ok('GET', `/issuances/${cert}`)).status, 'OUTSTANDING');
});

test('7. a signed document cannot be relinked to another security', async () => {
  const a = await certificate(10), b = await certificate(20);
  const doc = await ok('POST', '/documents', { name: 'Stock power', category: 'OTHER', body: 'Assigned.', securityId: a, requiresSignature: true, signers: [{ name: 'Wren Ashby' }] });
  await sign(doc.id, false);
  await refused('PATCH', `/documents/${doc.id}`, { securityId: b }, /cannot be linked to another holding/);
  await refused('PATCH', `/documents/${doc.id}`, { securityId: null }, /cannot be linked to another holding/);
});

test('8. the signature hash covers the stored certificate face as well as the text', async () => {
  const cert = (await ok('POST', '/issuances/issue-for-signature', { stakeholderId: other, shareClassId: common, quantity: 300, issueDate: '2024-03-03' })).issuance.id;
  const [doc] = await docsOf(cert);
  await sign(doc.id, true);
  const listed = async () => (await ok('GET', '/documents')).find((d: any) => d.id === doc.id);
  assert.equal((await listed()).tampered, false);
  // The face changed in the database, past the routes; the text did not.
  await run("UPDATE documents SET face = replace(face, '300', '3000') WHERE id = ?", doc.id);
  assert.equal((await listed()).tampered, true);
});
