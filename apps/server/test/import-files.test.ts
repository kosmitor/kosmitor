/**
 * Importing through the API a page uses: files parsed one by one, every sheet
 * detected, then one dry run and one commit for all of them. Covers several
 * files at once (people first whatever the file order, people matched across
 * files, all or nothing), the commit refusing what the review did not show,
 * and the import bugs the review of the old wizard found, one test each:
 * re-importing a fixed file issued shares twice, European numbers were
 * misread, a cap table missing its class column became a stakeholder import,
 * dates were decided row by row, two emails for one name made two people
 * silently, going over the authorized shares was not flagged before saving,
 * founders came in as employees, a left-out row stuck, Windows-1252 text was
 * garbled, and files that are not spreadsheets were read as CSV.
 *
 * Every name, email and figure here is invented.
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
await import('../src/routes/imports.ts');
const { all, one } = await import('../src/db.ts');
const { xlsx, zip } = await import('../src/xlsx-writer.ts');
const { parseXlsx } = await import('../src/import/xlsx.ts');
const { coerceNumber, detectNumberFormat, detectSheet, isAmbiguousNumber } = await import('../src/import/values.ts');
const { decodeText, looksBinary } = await import('../src/import/csv.ts');
const { configure, resetConfig, megabytes } = await import('../src/config.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token: string | null = admin) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

let admin: string | null = null;
admin = (await call('POST', '/api/auth/register', { email: 'odette.marsh@example.com', name: 'Odette Marsh', password: 'odette-pass-1' }, null)).token as string;
const company = async (name: string, authorizedCommon = 10_000_000) =>
  (await call('POST', '/api/companies', { name, incorporationDate: '2021-01-04', authorizedCommon })).json.id as string;

/** POST imports/parse with a file's bytes, as the drop zone sends it. */
async function parse(cid: string, name: string, body: Buffer) {
  const res = await fetch(`${base}/api/c/${cid}/imports/parse?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(body) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any };
}

const csv = (rows: (string | number)[][], delimiter = ','): Buffer =>
  Buffer.from(rows.map((r) => r.map((c) => (String(c).includes(delimiter) ? `"${c}"` : String(c))).join(delimiter)).join('\r\n'));

/**
 * What a page does with dropped files: parse each, detect every sheet, and turn
 * the ready ones into the sheets of a workbook request. `fill` supplies a value
 * for a field no column holds, as the page's question card would.
 */
async function sheetsFrom(cid: string, files: { name: string; body: Buffer }[], fill: Record<string, Record<string, string>> = {}) {
  const parsed = [];
  for (const f of files) {
    const r = await parse(cid, f.name, f.body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    parsed.push(r.json);
  }
  const tabs = parsed.flatMap((p) => p.sheets.map((s: any) => ({ ...s, file: p.fileName })));
  const detected = (await call('POST', `/api/c/${cid}/imports/detect`, {
    sheets: tabs.map((s) => ({ name: s.name, file: s.file, headers: s.rows[s.headerRow], rowCount: s.rows.length - s.headerRow - 1 })),
  })).json.sheets;
  return tabs.map((s, i) => {
    const d = detected[i];
    const mapping: Record<string, unknown> = { ...d.mapping };
    for (const [k, v] of Object.entries(d.constants as Record<string, string>)) mapping[k] ??= { value: v };
    for (const [k, v] of Object.entries(fill[s.name] ?? {})) mapping[k] = { value: v };
    return { detection: d, sheet: { file: s.file, name: s.name, kind: d.kind, headers: s.rows[s.headerRow], rows: s.rows.slice(s.headerRow + 1),
      headerRowNumber: s.headerRow + 1, rowCount: s.rowCount, numberFormat: s.numberFormat, mapping } };
  }).filter((x) => x.detection.kind && (x.detection.ready || fill[x.sheet.name]))
    .map((x) => x.sheet);
}

const preview = (cid: string, body: unknown) => call('POST', `/api/c/${cid}/imports/workbook/preview`, body);
const commit = (cid: string, body: unknown) => call('POST', `/api/c/${cid}/imports/workbook/commit`, body);
const countOf = async (cid: string, table: string) => Number((await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE company_id = ?`, cid))!.n);

// ---------------------------------------------------------------------------
// The files of one export, dropped together
// ---------------------------------------------------------------------------

const PEOPLE = csv([
  ['Name', 'Email', 'Relationship', 'Start date'],
  ['Ines Calloway', 'ines@calloway.example', 'Founder', '2021-01-04'],
  ['Rafe Dunmore', 'rafe@dunmore.example', 'Employee', '2022-01-10'],
  ['Tamsin Okoro', 'tamsin@okoro.example', 'Advisor', '2022-06-01'],
]);
const CAP_TABLE = (grantType = 'ISO') => xlsx([
  { name: 'Common', rows: [
    ['Certificate', 'Stakeholder', 'Shares', 'Price per share', 'Issue date'],
    ['CS-1', 'Ines Calloway', 4_000_000, 0.0001, '2021-01-04'],
    ['CS-2', 'Rafe Dunmore', 250_000, 0.0001, '2022-01-10'],
  ] },
  { name: '2023 Stock Plan', rows: [
    ['Grant ID', 'Stakeholder', 'Grant type', 'Granted', 'Exercise price', 'Grant date', 'Vesting schedule'],
    ['OPT-1', 'Tamsin Okoro', grantType, 40_000, 0.25, '2023-03-01', '4y/1y monthly'],
  ] },
  { name: 'Summary', rows: [['Share Class', 'Authorized', 'Outstanding'], ['Common', 10_000_000, 4_250_000]] },
]);

test('several files at once: people first whatever the order, matched across files, one review and one commit', async () => {
  const cid = await company('Calloway Instruments');
  // The cap table workbook is dropped before the stakeholder report.
  const sheets = await sheetsFrom(cid, [{ name: 'cap-table.xlsx', body: CAP_TABLE() }, { name: 'people.csv', body: PEOPLE }]);
  assert.deepEqual(sheets.map((s) => `${s.file} › ${s.name}`), ['cap-table.xlsx › Common', 'cap-table.xlsx › 2023 Stock Plan', 'people.csv › people']);   // the summary tab is left out

  const dry = await preview(cid, { sheets });
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.deepEqual(dry.json.sheets.map((s: any) => [s.file, s.sheetName, s.kind]),
    [['people.csv', 'people', 'stakeholders'], ['cap-table.xlsx', 'Common', 'captable'], ['cap-table.xlsx', '2023 Stock Plan', 'grants']]);
  assert.deepEqual(dry.json.files, ['cap-table.xlsx', 'people.csv']);
  assert.deepEqual(dry.json.creates.stakeholders, ['Ines Calloway', 'Rafe Dunmore', 'Tamsin Okoro']);   // created once, by the report
  for (const s of dry.json.sheets.slice(1)) for (const r of s.preview.rows) assert.ok(!r.messages.some((m: any) => m.code === 'relationship-guessed'), JSON.stringify(r));
  assert.deepEqual(dry.json.newPeople.map((p: any) => [p.name, p.relation, p.guessed, p.rows.length]),
    [['Ines Calloway', 'FOUNDER', false, 2], ['Rafe Dunmore', 'EMPLOYEE', false, 2], ['Tamsin Okoro', 'ADVISOR', false, 2]]);
  assert.deepEqual(dry.json.newPeople[0].rows, [{ file: 'people.csv', sheet: 'people', row: 2 }, { file: 'cap-table.xlsx', sheet: 'Common', row: 2 }]);
  assert.equal(dry.json.counts.willImport, 6);
  assert.equal(await countOf(cid, 'stakeholders'), 0, 'a dry run writes nothing');

  const done = await commit(cid, { sheets, expectedCounts: dry.json.counts });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(done.json.imported, { stakeholders: 3, shareClasses: 0, issuances: 2, awards: 1, convertibles: 0, vestingSchedules: 0, pools: 1,
    warrants: 0, valuations: 0, stockSplits: 0, poolAdjustments: 0, events: 0, updated: { stakeholders: 0 } });
  const ines = await one<{ id: string; relation: string }>("SELECT id, relation FROM stakeholders WHERE company_id = ? AND name = 'Ines Calloway'", cid);
  assert.equal(ines!.relation, 'FOUNDER', 'the report\'s relationship, not a guess from the cap table');
  assert.equal((await one<{ stakeholder_id: string }>("SELECT stakeholder_id FROM issuances WHERE company_id = ? AND certificate_no = 'CS-1'", cid))!.stakeholder_id, ines!.id);
  // Every issued security has its dated ledger entry.
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = ? AND type IN ('ISSUANCE', 'GRANT')", cid))!.n), 3);
  const audit = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE company_id = ? AND action = 'IMPORT'", cid);
  assert.match(audit!.detail, /^Imported 3 sheets from cap-table\.xlsx and people\.csv: 3 stakeholders/);
});

test('all or nothing: a row that needs a fix in one file stops every file, and a commit that differs from its review is refused', async () => {
  const cid = await company('Dunmore Optics');
  const broken = await sheetsFrom(cid, [{ name: 'people.csv', body: PEOPLE }, { name: 'cap-table.xlsx', body: CAP_TABLE('Stock Option') }]);
  const dry = await preview(cid, { sheets: broken });
  const grants = dry.json.sheets.find((s: any) => s.kind === 'grants');
  assert.equal(grants.blocked, true);
  const problem = grants.preview.rows[0].messages.find((m: any) => m.level === 'error');
  assert.deepEqual([problem.code, problem.field, problem.value], ['ambiguous-award-type', 'awardType', 'Stock Option']);
  const refused = await commit(cid, { sheets: broken });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.detail.code, 'rows-need-fixing');
  assert.equal(await countOf(cid, 'stakeholders'), 0, 'the people file is not applied either');
  assert.equal(await countOf(cid, 'imports'), 0);

  // The review was of an empty company; the people arrive by another import before the commit.
  const sheets = await sheetsFrom(cid, [{ name: 'people.csv', body: PEOPLE }, { name: 'cap-table.xlsx', body: CAP_TABLE() }]);
  const review = await preview(cid, { sheets });
  assert.equal((await commit(cid, { sheets: sheets.filter((s) => s.kind === 'stakeholders') })).status, 200);
  const stale = await commit(cid, { sheets, expectedCounts: review.json.counts });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'The cap table changed since you checked these rows. Check again');
  assert.equal(stale.json.detail.code, 'stale-review');
  assert.equal(stale.json.detail.counts.existing, 3);
  assert.equal(await countOf(cid, 'issuances'), 0, 'nothing from the stale commit was written');
  const again = await preview(cid, { sheets });
  assert.equal((await commit(cid, { sheets, expectedCounts: again.json.counts })).status, 200);
  assert.equal(await countOf(cid, 'issuances'), 2);
});

// ---------------------------------------------------------------------------
// The bugs, one test each
// ---------------------------------------------------------------------------

test('re-importing a corrected file adds only the rows that were missing — no shares are issued twice', async () => {
  const cid = await company('Hollis Bay Robotics');
  const file = (thirdDate: string) => csv([
    ['Stakeholder', 'Share class', 'Shares', 'Price per share', 'Issue date'],
    ['Wren Talbot', 'Common', '4,000,000', '0.0001', '2024-01-15'],
    ['Wren Talbot', 'Common', '250,000', '0.0001', '2024-02-01'],
    ['Esme Corran', 'Common', '900,000', '0.0001', thirdDate],
  ]);
  const first = await sheetsFrom(cid, [{ name: 'certificates.csv', body: file('2024-02-31') }]);
  const dry = await preview(cid, { sheets: first });
  assert.equal(dry.json.counts.errors, 1);
  assert.equal((await commit(cid, { sheets: first, options: { skipRowsWithErrors: true } })).status, 200);
  assert.equal(await countOf(cid, 'issuances'), 2);

  // The fixed file, imported again: the two rows already there are recognised though they have no certificate number.
  const fixed = await sheetsFrom(cid, [{ name: 'certificates.csv', body: file('2024-02-28') }]);
  const check = await preview(cid, { sheets: fixed });
  assert.deepEqual(check.json.sheets[0].preview.rows.map((r: any) => r.outcome), ['existing', 'existing', 'add']);
  assert.deepEqual(check.json.sheets[0].preview.rows[0].messages, [{ level: 'info', text: 'Already on the cap table — skipped', code: 'already-imported' }]);
  assert.deepEqual([check.json.counts.existing, check.json.counts.willImport], [2, 1]);
  assert.equal((await commit(cid, { sheets: fixed, expectedCounts: check.json.counts })).status, 200);
  const held = await all<{ name: string; shares: number }>(
    'SELECT s.name, SUM(i.quantity)::int AS shares FROM issuances i JOIN stakeholders s ON s.id = i.stakeholder_id WHERE i.company_id = ? GROUP BY s.name ORDER BY s.name', cid);
  assert.deepEqual(held.map((h) => [h.name, Number(h.shares)]), [['Esme Corran', 900_000], ['Wren Talbot', 4_250_000]]);

  // A number that is taken by a different certificate is still an error, not a skip.
  const clash = await sheetsFrom(cid, [{ name: 'more.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Issue date', 'Certificate'], ['Esme Corran', 'Common', '10', '2024-03-01', 'CS-7']]) }]);
  assert.equal((await commit(cid, { sheets: clash })).status, 200);
  const clash2 = await sheetsFrom(cid, [{ name: 'more.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Issue date', 'Certificate'], ['Wren Talbot', 'Common', '10', '2024-03-01', 'CS-7']]) }]);
  const dup = await preview(cid, { sheets: clash2 });
  assert.equal(dup.json.sheets[0].preview.rows[0].outcome, 'error');
  assert.equal(dup.json.sheets[0].preview.rows[0].messages.find((m: any) => m.level === 'error').code, 'number-taken');
});

test('European numbers and day-first dates are read the way each file writes them', async () => {
  const cid = await company('Brenner Werkzeuge');
  // A semicolon CSV written the European way, and an English one, in the same import.
  const european = csv([
    ['Stakeholder', 'Share class', 'Shares', 'Price per share', 'Issue date'],
    ['Lotte Brenner', 'Common', '500.000', '0,0001', '15.01.2024'],
    ['Jonas Weil', 'Common', '1.250.000', '0,0001', '03.02.2024'],
  ], ';');
  const english = csv([
    ['Stakeholder', 'Share class', 'Shares', 'Price per share', 'Issue date'],
    ['Maren Holt', 'Common', '1,000', '0.0001', '01/20/2024'],
    ['Piet Arnaud', 'Common', '2,000', '0.0001', '03/02/2024'],
  ]);
  const parsed = await parse(cid, 'aktien.csv', european);
  assert.deepEqual([parsed.json.delimiter, parsed.json.sheets[0].numberFormat, parsed.json.sheets[0].numberDecidedBy, parsed.json.sheets[0].numberEvidence],
    [';', 'eu', 'file', { text: '0,0001', row: 2 }]);

  const sheets = await sheetsFrom(cid, [{ name: 'aktien.csv', body: european }, { name: 'holders.csv', body: english }]);
  const dry = await preview(cid, { sheets });
  const rows = (file: string) => dry.json.sheets.find((s: any) => s.file === file).preview.rows.map((r: any) => [r.summary.shares, r.summary.price, r.summary.issueDate]);
  assert.deepEqual(rows('aktien.csv'), [[500_000, 0.0001, '2024-01-15'], [1_250_000, 0.0001, '2024-02-03']]);   // 03.02 is the 3rd of February in a day-first file
  assert.deepEqual(rows('holders.csv'), [[1_000, 0.0001, '2024-01-20'], [2_000, 0.0001, '2024-03-02']]);       // 03/02 is March 2 in a month-first one
  const readAs = Object.fromEntries(dry.json.readAs.map((r: any) => [r.file, r]));
  assert.deepEqual([readAs['aktien.csv'].dateOrder, readAs['aktien.csv'].dateDecidedBy, readAs['aktien.csv'].dateEvidence, readAs['aktien.csv'].numberFormat],
    ['DMY', 'file', { text: '15.01.2024', sheet: 'aktien', row: 2 }, 'eu']);
  assert.deepEqual([readAs['holders.csv'].dateOrder, readAs['holders.csv'].dateEvidence.text, readAs['holders.csv'].numberFormat], ['MDY', '01/20/2024', 'en']);
  assert.deepEqual(dry.json.sheets.map((s: any) => s.dateOrder), ['DMY', 'MDY']);

  // The person can still say otherwise for a file; the evidence is kept for the note.
  const turned = await preview(cid, { sheets: sheets.map((s) => (s.file === 'holders.csv' ? { ...s, dateOrder: 'DMY' } : s)) });
  assert.equal(turned.json.sheets[1].preview.rows[1].summary.issueDate, '2024-02-03');
  assert.equal(turned.json.sheets[1].preview.rows[0].status, 'error');                                         // 01/20 cannot be day-first
  assert.equal(turned.json.readAs[1].dateDecidedBy, 'setting');

  // A share count that reads two ways is flagged where the file gives no other clue.
  const plain = await preview(cid, { sheets: [{ ...sheets[0], numberFormat: 'en' }] });
  const warned = plain.json.sheets[0].preview.rows[0].messages.find((m: any) => m.code === 'ambiguous-number');
  assert.equal(warned.text, 'Shares "500.000" was read as 500 — if the file means 500,000, read its numbers as 1.234,56');

  // The reading rules themselves.
  assert.equal(coerceNumber('500.000', 'eu').value, 500_000);
  assert.equal(coerceNumber('500.000', 'en').value, 500);
  assert.equal(coerceNumber('0,0001', 'en').value, 0.0001);                 // a comma before four digits is never a thousands separator
  assert.equal(coerceNumber('1.000.000', 'en').value, 1_000_000);
  assert.equal(coerceNumber('1.234,56', 'en').value, 1234.56);
  assert.equal(coerceNumber('1,234.56', 'eu').value, 1234.56);
  assert.equal(coerceNumber('€ 1.250.000', 'eu').value, 1_250_000);
  assert.equal(coerceNumber('1 234 567', 'eu').value, 1_234_567);
  assert.equal(coerceNumber('1,5M', 'eu').value, 1_500_000);
  assert.equal(coerceNumber('1,000', 'en').value, 1_000);
  assert.equal(coerceNumber('1,000', 'eu').value, 1);
  assert.ok(isAmbiguousNumber('500.000') && isAmbiguousNumber('1,000') && !isAmbiguousNumber('0,0001') && !isAmbiguousNumber('1,000,000'));
  assert.equal(detectNumberFormat([['Shares'], ['1,000'], ['2,500']], ';').decidedBy, 'delimiter');
  assert.equal(detectNumberFormat([['Shares'], ['1,000'], ['2,500']]).format, 'en');
});

test('a cap table without a class column is not turned into a stakeholder import: the missing column is asked for', async () => {
  const cid = await company('Corran Analytics');
  const headers = ['Shareholder', 'Email', 'Shares', 'Price', 'Date issued'];
  const d = detectSheet('Sheet1', headers, 4);
  assert.equal(d.kind, 'captable');
  assert.deepEqual(d.missing, ['shareClassName']);
  assert.match(d.reason!, /share class/);
  assert.equal(detectSheet('Sheet1', ['Date', 'Description', 'Amount', 'Balance'], 9).kind, null);   // a bank statement is not a ledger
  assert.equal(detectSheet('Team', ['Name', 'Email', 'Title'], 3).kind, 'stakeholders');           // a people list still is one

  const file = csv([headers, ['Nell Ashby', 'nell@ashby.example', '1,000,000', '0.0001', '2024-04-02']]);
  const parsed = (await parse(cid, 'holders.csv', file)).json;
  const detected = (await call('POST', `/api/c/${cid}/imports/detect`, { sheets: [{ name: 'holders', headers, rowCount: 1 }] })).json.sheets[0];
  assert.deepEqual([detected.kind, detected.ready, detected.missing], ['captable', false, ['shareClassName']]);
  const sheet = { name: 'holders', kind: 'captable', headers, rows: parsed.sheets[0].rows.slice(1), mapping: detected.mapping, headerRowNumber: 1 };
  const refused = await preview(cid, { sheets: [sheet] });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json.detail, { code: 'missing-column', field: 'shareClassName' });
  // Answered with one value for every row, the shares, price and date all come through.
  const answered = await preview(cid, { sheets: [{ ...sheet, mapping: { ...detected.mapping, shareClassName: { value: 'Common' } } }] });
  assert.deepEqual(answered.json.sheets[0].preview.rows[0].summary, { stakeholder: 'Nell Ashby', shareClass: 'Common', shares: 1_000_000, price: 0.0001, issueDate: '2024-04-02', certificate: null, vesting: null });
});

test('the same name with two emails makes two people, and the review says so', async () => {
  const cid = await company('Vale Ceramics');
  const sheets = await sheetsFrom(cid, [{ name: 'certificates.csv', body: csv([
    ['Stakeholder', 'Email', 'Share class', 'Shares', 'Issue date'],
    ['Robin Vale', 'robin@vale.example', 'Common', '1,000,000', '2024-01-02'],
    ['Robin Vale', 'robin.vale@post.example', 'Common', '500,000', '2024-01-02'],
    ['Robin Vale', '', 'Common', '20,000', '2024-02-02'],
  ]) }]);
  const dry = await preview(cid, { sheets });
  const rows = dry.json.sheets[0].preview.rows;
  const sameName = rows[1].messages.find((m: any) => m.code === 'same-name');
  assert.equal(sameName.text, 'Another "Robin Vale" has a different email (robin@vale.example) — two stakeholders will be created');
  assert.equal(sameName.field, 'email');
  // No email: either Robin Vale. The row goes to neither until the page says which.
  const which = rows[2].messages.find((m: any) => m.level === 'error');
  assert.deepEqual([rows[2].outcome, which.code, which.field, which.choices], ['error', 'ambiguous-person', 'email', ['robin.vale@post.example', 'robin@vale.example']]);
  assert.equal(which.text, 'Two people are called "Robin Vale" (robin.vale@post.example, robin@vale.example) — add the email of the one this row is about');
  assert.deepEqual(dry.json.newPeople.map((p: any) => [p.key, p.sameName, p.rows.map((r: any) => r.row)]), [
    ['robin@vale.example', [{ name: 'Robin Vale', email: 'robin.vale@post.example', onRecord: false }], [2]],
    ['robin.vale@post.example', [{ name: 'Robin Vale', email: 'robin@vale.example', onRecord: false }], [3]],
  ]);
  // Told they are the same person, the page makes the emails match, and one person holds both.
  const one = sheets.map((s) => ({ ...s, rows: s.rows.map((r: any[]) => (r[1] === 'robin.vale@post.example' ? [r[0], 'robin@vale.example', ...r.slice(2)] : r)) }));
  const merged = await preview(cid, { sheets: one });
  assert.deepEqual(merged.json.creates.stakeholders, ['Robin Vale']);

  // Someone on record with another email is kept apart too, and says so.
  assert.equal((await commit(cid, { sheets: one })).status, 200);
  const later = await sheetsFrom(cid, [{ name: 'later.csv', body: csv([['Stakeholder', 'Email', 'Share class', 'Shares', 'Issue date'], ['Robin Vale', 'rv@elsewhere.example', 'Common', '10', '2024-05-05']]) }]);
  const third = await preview(cid, { sheets: later });
  const robin = (await all<{ id: string }>("SELECT id FROM stakeholders WHERE company_id = ? AND email = 'robin@vale.example'", cid))[0].id;
  assert.deepEqual(third.json.newPeople[0].sameName, [{ name: 'Robin Vale', email: 'robin@vale.example', onRecord: true, stakeholderId: robin }]);
});

test('going over the authorized shares is flagged before saving, with a raise that settles it', async () => {
  const cid = await company('Ashby Marine', 1_000_000);
  const common = (await one<{ id: string }>("SELECT id FROM share_classes WHERE company_id = ? AND name = 'Common'", cid))!.id;
  const sheets = await sheetsFrom(cid, [{ name: 'certificates.csv', body: csv([
    ['Stakeholder', 'Share class', 'Shares', 'Issue date'],
    ['Corin Ashby', 'Common', '900,000', '2024-01-02'],
    ['Lise Morrow', 'Common', '300,000', '2024-01-02'],
  ]) }]);
  const dry = await preview(cid, { sheets });
  assert.deepEqual(dry.json.notices, [{
    code: 'over-authorized', level: 'warning', text: 'After this import Common has 1,200,000 shares outstanding but 1,000,000 authorized',
    fix: { option: 'raiseAuthorized', value: common, shareClassId: common, className: 'Common', to: 1_200_000 },
  }]);
  const raised = await preview(cid, { sheets, options: { raiseAuthorized: [common] } });
  assert.deepEqual(raised.json.notices, []);
  assert.deepEqual(raised.json.raised, [{ shareClassId: common, name: 'Common', from: 1_000_000, to: 1_200_000 }]);
  assert.equal((await one<{ authorized: number }>('SELECT authorized FROM share_classes WHERE id = ?', common))!.authorized, 1_000_000, 'the dry run raises nothing');

  const done = await commit(cid, { sheets, options: { raiseAuthorized: [common] }, expectedCounts: raised.json.counts });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(Number((await one<{ authorized: number }>('SELECT authorized FROM share_classes WHERE id = ?', common))!.authorized), 1_200_000);
  assert.match((await one<{ detail: string }>("SELECT detail FROM audit_log WHERE company_id = ? AND action = 'IMPORT'", cid))!.detail, /Common authorized shares raised from 1,000,000 to 1,200,000/);

  // Another company's class is never touched, whatever is asked.
  const other = await company('Morrow Textiles', 100);
  const elsewhere = await sheetsFrom(other, [{ name: 'c.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Issue date'], ['Una Pell', 'Common', '500', '2024-01-02']]) }]);
  assert.equal((await commit(other, { sheets: elsewhere, options: { raiseAuthorized: [common] } })).status, 200);
  assert.equal(Number((await one<{ authorized: number }>('SELECT authorized FROM share_classes WHERE id = ?', common))!.authorized), 1_200_000);
});

test('people a file creates without a relationship are listed as guesses, and the answer is used', async () => {
  const cid = await company('Okoro Labs');
  const sheets = await sheetsFrom(cid, [{ name: 'founders.csv', body: csv([
    ['Stakeholder', 'Share class', 'Shares', 'Issue date'],
    ['Ama Okoro', 'Common', '3,000,000', '2021-01-04'],
    ['Teodor Lund', 'Common', '3,000,000', '2021-01-04'],
    ['Lindqvist Capital Fund I, L.P.', 'Series Seed Preferred', '800,000', '2022-05-01'],
  ]) }]);
  const dry = await preview(cid, { sheets });
  assert.deepEqual(dry.json.newPeople.map((p: any) => [p.key, p.relation, p.guessed]),
    [['ama okoro', 'EMPLOYEE', true], ['teodor lund', 'EMPLOYEE', true], ['lindqvist capital fund i, l.p.', 'INVESTOR', true]]);
  const guessed = dry.json.sheets[0].preview.rows[0].messages.find((m: any) => m.code === 'relationship-guessed');
  assert.equal(guessed.text, 'Creates stakeholder "Ama Okoro" as employee — review the relationship');
  const relationships = { 'ama okoro': 'FOUNDER', 'Teodor Lund': 'FOUNDER' };
  const answered = await preview(cid, { sheets, options: { relationships } });
  assert.deepEqual(answered.json.newPeople.map((p: any) => [p.relation, p.guessed]), [['FOUNDER', false], ['FOUNDER', false], ['INVESTOR', true]]);
  assert.equal((await commit(cid, { sheets, options: { relationships } })).status, 200);
  const founders = await all<{ name: string }>("SELECT name FROM stakeholders WHERE company_id = ? AND relation = 'FOUNDER' ORDER BY name", cid);
  assert.deepEqual(founders.map((f) => f.name), ['Ama Okoro', 'Teodor Lund']);
  assert.equal((await call('POST', `/api/c/${cid}/imports/workbook/preview`, { sheets, options: { relationships: { 'ama okoro': 'CEO' } } })).status, 400);
});

test('a row left out stays out of that request only: nothing about it is kept for the next', async () => {
  const cid = await company('Pell Foods');
  const sheets = await sheetsFrom(cid, [{ name: 'c.csv', body: csv([
    ['Stakeholder', 'Share class', 'Shares', 'Issue date'],
    ['Una Pell', 'Common', '1,000', '2024-01-02'],
    ['Oskar Brandt', 'Common', '2,000', '2024-02-31'],
  ]) }]);
  const left = await preview(cid, { sheets: [{ ...sheets[0], excludeRows: [3] }] });
  assert.deepEqual(left.json.sheets[0].preview.rows[1], { row: 3, status: 'ok', action: 'skip', outcome: 'excluded', summary: { stakeholder: 'Oskar Brandt' },
    messages: [{ level: 'info', text: 'Left out by you', code: 'excluded' }] });
  assert.deepEqual([left.json.counts.excluded, left.json.counts.errors, left.json.counts.willImport], [1, 0, 1]);
  const next = await preview(cid, { sheets });
  assert.equal(next.json.sheets[0].preview.rows[1].outcome, 'error');
  assert.equal((await commit(cid, { sheets })).status, 400);
  assert.equal((await commit(cid, { sheets: [{ ...sheets[0], excludeRows: [3] }] })).status, 200);
  assert.equal(await countOf(cid, 'issuances'), 1);
});

test('a CSV saved as Windows-1252 keeps its accents, and a UTF-16 one is read too', async () => {
  const cid = await company('Marchetti Studio');
  const latin = Buffer.concat([Buffer.from('Stakeholder,Cat'), Buffer.from([0xe9]), Buffer.from('gorie,Shares,Issue date\r\nZo'), Buffer.from([0xeb]),
    Buffer.from(' Marchetti,Common,1000,2024-01-02\r\nTom'), Buffer.from([0x92]), Buffer.from('s Fund,Common,2000,2024-01-02\r\n')]);
  const r = await parse(cid, 'export.csv', latin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.encoding, 'windows-1252');
  assert.deepEqual(r.json.sheets[0].rows.map((row: any[]) => row[0]), ['Stakeholder', 'Zoë Marchetti', 'Tom’s Fund']);
  assert.equal(r.json.sheets[0].rows[0][1], 'Catégorie');
  assert.equal(decodeText(Buffer.from('Zoë', 'utf8')).encoding, 'utf-8');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\tEmail\r\nZoë Marchetti\tzoe@marchetti.example\r\n', 'utf16le')]);
  const wide = await parse(cid, 'unicode.txt', utf16);
  assert.equal(wide.json.encoding, 'utf-16le');
  assert.deepEqual(wide.json.sheets[0].rows[1], ['Zoë Marchetti', 'zoe@marchetti.example']);
});

test('files that are not spreadsheets are refused with a code, not read as CSV', async () => {
  const cid = await company('Refusals Inc');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const refusal = async (name: string, body: Buffer) => { const r = await parse(cid, name, body); assert.equal(r.status, 400, name); return [r.json.detail.code, r.json.error]; };
  assert.deepEqual(await refusal('logo.png', png), ['not-a-spreadsheet', 'This file isn\'t a spreadsheet. Save it from Excel as .xlsx or .csv and try again.']);
  const docx = zip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.from('<w:document/>') }]);
  assert.deepEqual(await refusal('notes.docx', docx), ['word-document', 'notes.docx is a Word document, not a spreadsheet. Save your table from Excel as .xlsx or .csv and drop it here.']);
  const pptx = zip([{ name: 'ppt/presentation.xml', data: Buffer.from('<p/>') }]);
  assert.equal((await refusal('deck.pptx', pptx))[0], 'powerpoint');
  const damaged = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
  assert.deepEqual(await refusal('cap-table.xlsx', damaged), ['damaged', 'We couldn\'t open this workbook — it may be damaged. Open it in Excel, save it again as .xlsx and drop it here.']);
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  assert.equal((await refusal('old.xls', ole))[0], 'legacy-xls');
  assert.equal((await refusal('memo.doc', ole))[0], 'word-document');
  assert.equal((await refusal('notes.txt', Buffer.from('Meeting notes\nWe agreed on the plan\nNext steps follow\n')))[0], 'not-a-table');
  assert.deepEqual(await refusal('empty.csv', Buffer.alloc(0)), ['empty', 'This file is empty.']);
  assert.equal((await refusal('table.pdf', Buffer.from('%PDF-1.4\n%%EOF')))[0], 'pdf');
  assert.ok(looksBinary('ok\u0000') && !looksBinary('Name,Email\nZoë,zoe@x.example\n'));
});

// ---------------------------------------------------------------------------
// What else the review relies on
// ---------------------------------------------------------------------------

test('a stakeholder report says what an update changes, skips who is up to date, and merges a person listed twice', async () => {
  const cid = await company('Lund Bicycles');
  const first = await sheetsFrom(cid, [{ name: 'people.csv', body: csv([['Name', 'Email', 'Relationship'], ['Ada Lund', 'ada@lund.example', 'Employee'], ['Bo Lund', 'bo@lund.example', 'Advisor']]) }]);
  assert.equal((await commit(cid, { sheets: first })).status, 200);
  const second = await sheetsFrom(cid, [{ name: 'people.csv', body: csv([
    ['Name', 'Email', 'Relationship', 'Start date', 'Title'],
    ['Ada Lund', 'ada@lund.example', 'Founder', '2021-03-01', ''],
    ['Bo Lund', 'BO@lund.example', 'Advisor', '', ''],
    ['Cy Arden', 'cy@arden.example', '', '', ''],
    ['Cy Arden', '', 'Contractor', '', 'Designer'],
  ]) }]);
  const dry = await preview(cid, { sheets: second });
  const rows = dry.json.sheets[0].preview.rows;
  assert.deepEqual(rows[0].messages, [{ level: 'info', text: 'Updates "Ada Lund": relationship Employee → Founder, start date — → 2021-03-01', code: 'stakeholder-updated' }]);
  assert.deepEqual([rows[1].outcome, rows[1].messages[0].text, rows[1].messages[0].code], ['existing', 'Already up to date', 'up-to-date']);
  assert.equal(rows[3].messages[0].code, 'duplicate-in-file');
  assert.deepEqual(dry.json.newPeople.map((p: any) => [p.name, p.relation, p.guessed]), [['Cy Arden', 'CONTRACTOR', false]]);
  const done = await commit(cid, { sheets: second });
  assert.equal(done.json.imported.updated.stakeholders, 1);
  const cy = await one<{ relation: string; title: string; email: string }>("SELECT relation, title, email FROM stakeholders WHERE company_id = ? AND name = 'Cy Arden'", cid);
  assert.deepEqual([cy!.relation, cy!.title, cy!.email], ['CONTRACTOR', 'Designer', 'cy@arden.example']);   // the later row filled in the first
});

test('grants with no plan can name a new one; a default schedule for grants no longer restricts certificates', async () => {
  const cid = await company('Arden Audio');
  const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY name LIMIT 1", cid))!.id;
  const sheets = await sheetsFrom(cid, [{ name: 'grants.csv', body: csv([
    ['Optionee', 'Award type', 'Shares', 'Strike price', 'Grant date'],
    ['Juno Ferris', 'NSO', '10,000', '0.50', '2024-03-01'],
  ]) }, { name: 'certs.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Issue date'], ['Series Lead Fund, L.P.', 'Series A Preferred', '100,000', '2024-03-01']]) }]);
  const dry = await preview(cid, { sheets });
  const codes = dry.json.sheets.find((s: any) => s.kind === 'grants').preview.rows[0].messages.filter((m: any) => m.level === 'error').map((m: any) => m.code);
  assert.deepEqual(codes, ['missing-vesting', 'missing-plan']);
  const options = { defaultVestingScheduleId: schedule, defaultPoolName: '2024 Equity Plan' };
  const answered = await preview(cid, { sheets, options });
  assert.deepEqual(answered.json.creates.pools, ['2024 Equity Plan']);
  assert.equal((await commit(cid, { sheets, options })).status, 200);
  assert.equal((await one<{ vesting_schedule_id: string | null }>('SELECT vesting_schedule_id FROM issuances WHERE company_id = ?', cid))!.vesting_schedule_id, null);
  assert.equal((await one<{ vesting_schedule_id: string }>('SELECT vesting_schedule_id FROM awards WHERE company_id = ?', cid))!.vesting_schedule_id, schedule);
  // A schedule or plan of another company is refused.
  const other = await company('Ferris Glass');
  assert.equal((await preview(other, { sheets, options: { defaultVestingScheduleId: schedule } })).status, 400);
});

test('templates: one workbook with a tab per kind and a guide the import leaves out; CSV templates have headers only; old examples are flagged', async () => {
  const cid = await company('Template Co');
  const res = await fetch(`${base}/api/c/${cid}/imports/template.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(res.status, 200);
  const book = parseXlsx(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(book.map((s) => s.name), ['How to fill this in', 'Stakeholders', 'Certificates', 'Equity grants', 'SAFEs & notes']);
  assert.equal(detectSheet(book[0].name, book[0].rows[2], book[0].rows.length - 3).kind, null);
  for (const tab of book.slice(1)) assert.equal(tab.rows.length, 1, tab.name);
  // Filled in, each tab is read as its kind.
  const filled = book.slice(1).map((t) => detectSheet(t.name, t.rows[0], 1).kind);
  assert.deepEqual(filled, ['stakeholders', 'captable', 'grants', 'convertibles']);
  const csvRes = await fetch(`${base}/api/c/${cid}/imports/template/captable`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal((await csvRes.text()).split('\r\n').length, 1);

  const old = await sheetsFrom(cid, [{ name: 'from-old-template.csv', body: csv([
    ['Stakeholder', 'Email', 'Share class', 'Shares', 'Issue date'], ['Avery Stone', 'avery@example.com', 'Common', '4,200,000', '2021-02-01'],
  ]) }]);
  const flagged = (await preview(cid, { sheets: old })).json.sheets[0].preview.rows[0];
  assert.equal(flagged.status, 'warning');
  assert.equal(flagged.messages.find((m: any) => m.code === 'template-example').text, '"Avery Stone" is an example row from the import template — delete it from the file unless it is real');
});

test('the preview and commit take bodies up to limits.importJsonMb, other routes stay at limits.jsonBodyMb', async () => {
  const cid = await company('Big File Co');
  configure({ limits: { jsonBodyMb: 1, importJsonMb: 3 } });
  try {
    const rows = Array.from({ length: 4000 }, (_, i) => [`Holder ${i}`, 'Common', '100', '2024-01-02', 'x'.repeat(300)]);
    const sheet = { name: 'big', kind: 'captable', headers: ['Stakeholder', 'Share class', 'Shares', 'Issue date', 'Notes'], rows,
      mapping: { stakeholderName: 0, shareClassName: 1, quantity: 2, issueDate: 3 }, headerRowNumber: 1 };
    assert.ok(JSON.stringify({ sheets: [sheet] }).length > megabytes(1));
    const dry = await preview(cid, { sheets: [sheet] });
    assert.equal(dry.status, 200, JSON.stringify(dry.json).slice(0, 200));
    assert.equal(dry.json.counts.willImport, 4000);
    const tooBig = await call('POST', `/api/c/${cid}/imports/suggest`, { kind: 'captable', headers: sheet.headers, padding: 'x'.repeat(megabytes(1.2)) });
    assert.deepEqual([tooBig.status, tooBig.json.detail], [400, { code: 'body-too-large' }]);
    configure({ limits: { importUploadMb: 1 } });
    const upload = await parse(cid, 'big.csv', Buffer.alloc(megabytes(1.5), 'a'));
    assert.deepEqual([upload.status, upload.json.detail], [413, { code: 'too-large', limitMb: 1 }]);
  } finally {
    resetConfig();
  }
});

// ---------------------------------------------------------------------------
// What the reviews of the new import found, one test each
// ---------------------------------------------------------------------------

test('two identical rows are two records: the copy that was left out is added when the file is imported again', async () => {
  const cid = await company('Rook Instruments');
  const files = [
    { name: 'certificates.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Issue date'],
      ['Tamsin Rook', 'Common', '120,000', '2023-07-14'], ['Tamsin Rook', 'Common', '120,000', '2023-07-14']]) },
    { name: 'grants.csv', body: csv([['Optionee', 'Award type', 'Shares', 'Strike price', 'Grant date', 'Vesting schedule'],
      ['Ivo Rook', 'ISO', '8,000', '0.25', '2024-02-01', '4y/1y monthly'], ['Ivo Rook', 'ISO', '8,000', '0.25', '2024-02-01', '4y/1y monthly']]) },
    { name: 'safes.csv', body: csv([['Investor', 'Instrument', 'Principal', 'Issue date', 'Valuation cap'],
      ['Rook Angels LLC', 'Post-money SAFE', '250,000', '2024-03-01', '10,000,000'], ['Rook Angels LLC', 'Post-money SAFE', '250,000', '2024-03-01', '10,000,000']]) },
  ];
  const sheets = await sheetsFrom(cid, files);
  const options = { defaultPoolName: 'Rook Plan' };
  // The first time, the second copy of each is left out.
  assert.equal((await commit(cid, { sheets: sheets.map((s) => ({ ...s, excludeRows: [3] })), options })).status, 200);
  assert.deepEqual([await countOf(cid, 'issuances'), await countOf(cid, 'awards'), await countOf(cid, 'convertibles')], [1, 1, 1]);

  const again = await preview(cid, { sheets, options });
  for (const s of again.json.sheets) {
    assert.deepEqual(s.preview.rows.map((r: any) => r.outcome), ['existing', 'add'], s.sheetName);
    assert.match(s.preview.rows[1].messages.find((m: any) => m.code === 'duplicate-in-file').text, /as row 2, which is already on the cap table — this one is added as another$/);
  }
  assert.equal((await commit(cid, { sheets, options, reviewToken: again.json.reviewToken })).status, 200);
  assert.deepEqual([await countOf(cid, 'issuances'), await countOf(cid, 'awards'), await countOf(cid, 'convertibles')], [2, 2, 2]);
  // Every one of them has its ledger entry.
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = ? AND type IN ('ISSUANCE', 'GRANT')", cid))!.n), 6);

  // A third time, both copies are there.
  const third = await preview(cid, { sheets, options });
  assert.deepEqual(third.json.sheets.map((s: any) => s.preview.rows.map((r: any) => r.outcome)), [['existing', 'existing'], ['existing', 'existing'], ['existing', 'existing']]);
  assert.equal(third.json.counts.willImport, 0);
});

test('a row without an email that could be either of two people of that name goes to neither until the email is added', async () => {
  const cid = await company('Walker Pumps');
  const people = await sheetsFrom(cid, [{ name: 'people.csv', body: csv([['Name', 'Email', 'Relationship'],
    ['Robin Walker', 'robin.a@walker.example', 'Founder'], ['Robin Walker', 'robin.b@walker.example', 'Employee']]) }]);
  assert.equal((await commit(cid, { sheets: people })).status, 200);

  const certs = await sheetsFrom(cid, [{ name: 'certificates.csv', body: csv([['Stakeholder', 'Email', 'Share class', 'Shares', 'Issue date'],
    ['Robin Walker', '', 'Common', '300,000', '2024-01-02'], ['Robin Walker', 'robin.b@walker.example', 'Common', '7,777', '2024-01-02']]) }]);
  const dry = await preview(cid, { sheets: certs });
  const [unsure, sure] = dry.json.sheets[0].preview.rows;
  const which = unsure.messages.find((m: any) => m.level === 'error');
  assert.deepEqual([unsure.outcome, which.code, which.field, which.choices], ['error', 'ambiguous-person', 'email', ['robin.a@walker.example', 'robin.b@walker.example']]);
  assert.equal(sure.outcome, 'add');
  // The page writes the chosen email into the row, and the shares go to that Robin Walker.
  const answered = certs.map((s) => ({ ...s, rows: s.rows.map((r: any[], i: number) => (i === 0 ? [r[0], 'robin.a@walker.example', ...r.slice(2)] : r)) }));
  assert.equal((await commit(cid, { sheets: answered })).status, 200);
  const held = await all<{ email: string; shares: number }>(
    'SELECT s.email, SUM(i.quantity)::int AS shares FROM issuances i JOIN stakeholders s ON s.id = i.stakeholder_id WHERE i.company_id = ? GROUP BY s.email ORDER BY s.email', cid);
  assert.deepEqual(held.map((h) => [h.email, Number(h.shares)]), [['robin.a@walker.example', 300_000], ['robin.b@walker.example', 7_777]]);

  // A stakeholder report row is not written onto either of them either.
  const report = await sheetsFrom(cid, [{ name: 'report.csv', body: csv([['Name', 'Relationship', 'Termination date'], ['Robin Walker', 'Former employee', '2024-12-31']]) }]);
  const left = (await preview(cid, { sheets: report })).json.sheets[0].preview.rows[0];
  assert.deepEqual([left.outcome, left.messages[0].code], ['error', 'ambiguous-person']);
});

test('tabs of one file that write dates differently are each read their own way, and a tab with both has its two-way dates flagged', async () => {
  const cid = await company('Ashdown Mills');
  const headers = ['Stakeholder', 'Share class', 'Shares', 'Issue date'];
  const book = xlsx([
    { name: 'Common', rows: [headers, ['Hale Ashdown', 'Common', 100, '01/20/2024'], ['Ivy Ashdown', 'Common', 100, '03/04/2024']] },
    { name: 'Series Seed Preferred', rows: [headers, ['Ashdown Fund LP', 'Series Seed Preferred', 100, '25/06/2024'], ['Mill Fund LP', 'Series Seed Preferred', 100, '05/07/2024']] },
  ]);
  const sheets = await sheetsFrom(cid, [{ name: 'cap-table.xlsx', body: book }]);
  const dry = await preview(cid, { sheets });
  assert.deepEqual(dry.json.sheets.map((s: any) => [s.sheetName, s.dateOrder]), [['Common', 'MDY'], ['Series Seed Preferred', 'DMY']]);
  assert.deepEqual(dry.json.sheets.map((s: any) => s.preview.rows[1].summary.issueDate), ['2024-03-04', '2024-07-05']);
  assert.equal(dry.json.readAs[0].dateOrder, 'mixed');

  // One sheet with both kinds of dates: each date that reads two ways says so.
  const mixed = await sheetsFrom(cid, [{ name: 'mixed.csv', body: csv([[...headers, 'Price per share'],
    ['Lark Bell', 'Common', '10', '15/01/2024', '0.01'], ['Moss Bell', 'Common', '10', '01/20/2024', '0.01'], ['Nell Bell', 'Common', '10', '03/02/2024', '0.01']]) }]);
  const read = await preview(cid, { sheets: mixed });
  assert.equal(read.json.sheets[0].dateOrder, 'auto');
  const rows = read.json.sheets[0].preview.rows;
  assert.deepEqual(rows.map((r: any) => [r.status, r.summary.issueDate]), [['ok', '2024-01-15'], ['ok', '2024-01-20'], ['warning', '2024-03-02']]);
  assert.deepEqual(rows[2].messages.find((m: any) => m.code === 'ambiguous-date'), {
    level: 'warning', code: 'ambiguous-date', field: 'issueDate', value: '03/02/2024',
    text: 'Issue date "03/02/2024" was read as 2024-03-02 (month first) — this file writes dates both ways; if it means 2024-02-03, read its dates day first' });
  // Told the order, the file reads one way and nothing is flagged.
  const told = await preview(cid, { sheets: mixed.map((s) => ({ ...s, dateOrder: 'DMY' })) });
  assert.equal(told.json.sheets[0].preview.rows[2].summary.issueDate, '2024-02-03');
  assert.ok(!told.json.sheets[0].preview.rows[2].messages.some((m: any) => m.code === 'ambiguous-date'));
});

test('an amount that reads a thousand times differently in the other number format is flagged, as share counts are', async () => {
  const cid = await company('Pellham Labs');
  const sheets = await sheetsFrom(cid, [{ name: 'safes.csv', body: csv([['Investor', 'Instrument', 'Principal', 'Issue date', 'Discount'],
    ['Quill Ventures LP', 'Post-money SAFE', '500.000', '2024-05-01', '20%']]) }]);
  assert.equal(sheets[0].numberFormat, 'en');
  const row = (await preview(cid, { sheets })).json.sheets[0].preview.rows[0];
  assert.equal(row.status, 'warning');
  assert.deepEqual(row.messages.find((m: any) => m.code === 'ambiguous-number'), { level: 'warning', code: 'ambiguous-number', field: 'principal', value: '500.000',
    text: 'Principal "500.000" was read as $500.00 — if the file means $500,000.00, read its numbers as 1.234,56' });
  const european = (await preview(cid, { sheets: [{ ...sheets[0], numberFormat: 'eu' }] })).json.sheets[0].preview.rows[0];
  assert.equal(european.summary.principal, 500_000);
  assert.ok(!european.messages.some((m: any) => m.code === 'ambiguous-number'));
});

test('importing a corrected file again flags what it corrects instead of skipping it silently or adding it twice', async () => {
  const cid = await company('Lucid Optics');
  const header = ['Stakeholder', 'Share class', 'Shares', 'Price per share', 'Issue date', 'Certificate'];
  const first = await sheetsFrom(cid, [{ name: 'v1.csv', body: csv([header,
    ['Pim Lucid', 'Common', '500', '1.00', '2021-01-01', ''], ['Ada Lucid', 'Common', '1,000,000', '0.0001', '2021-02-01', 'CS-1']]) }]);
  assert.equal((await commit(cid, { sheets: first })).status, 200);

  // The price corrected: the row is the certificate on file, which keeps its price, and the review says so.
  const repriced = await sheetsFrom(cid, [{ name: 'v2.csv', body: csv([header,
    ['Pim Lucid', 'Common', '500', '0.0001', '2021-01-01', ''], ['Ada Lucid', 'Common', '1,000,000', '0.0001', '2021-02-01', 'CS-1']]) }]);
  const check = await preview(cid, { sheets: repriced });
  const price = check.json.sheets[0].preview.rows[0];
  assert.deepEqual([price.outcome, price.status], ['existing', 'warning']);
  assert.deepEqual(price.messages, [
    { level: 'info', text: 'Already on the cap table — skipped', code: 'already-imported' },
    { level: 'warning', code: 'differs-from-record', field: 'pricePerShare', value: '0.0001',
      text: 'Price per share is $1.00 on the cap table and $0.0001 in the file — the import leaves the record as it is' },
  ]);
  // Each row counts once: the existing one as skipped, not also as a warning.
  assert.deepEqual([check.json.counts.total, check.json.counts.skipped, check.json.counts.existing, check.json.counts.warnings, check.json.counts.willImport], [2, 2, 2, 0, 0]);

  // The share count corrected, and a certificate renumbered: each is added only if the person says so.
  const second = await sheetsFrom(cid, [{ name: 'v3.csv', body: csv([header,
    ['Pim Lucid', 'Common', '500,000', '0.0001', '2021-01-01', ''], ['Ada Lucid', 'Common', '1,000,000', '0.0001', '2021-02-01', 'CS-0001']]) }]);
  const dry = await preview(cid, { sheets: second });
  const [shares, renumbered] = dry.json.sheets[0].preview.rows;
  assert.deepEqual([shares.outcome, shares.status], ['add', 'warning']);
  assert.deepEqual(shares.messages.find((m: any) => m.code === 'similar-on-record'), { level: 'warning', code: 'similar-on-record', field: 'quantity',
    text: 'The cap table already has a Common certificate for Pim Lucid dated 2021-01-01 for 500 shares — if this row corrects it, leave the row out and correct that certificate instead' });
  assert.deepEqual(renumbered.messages.find((m: any) => m.code === 'similar-on-record'), { level: 'warning', code: 'similar-on-record', field: 'certificateNo',
    text: 'The cap table already has a Common certificate for Ada Lucid with these shares and this date (CS-1) — if this row is that certificate renumbered, leave the row out' });
  assert.deepEqual([dry.json.counts.warnings, dry.json.counts.willImport], [2, 2]);

  // Left out, the look-alikes add nothing, and the record keeps its price.
  assert.equal((await commit(cid, { sheets: second.map((s) => ({ ...s, excludeRows: [2, 3] })) })).status, 200);
  assert.equal(await countOf(cid, 'issuances'), 2);
  assert.equal(Number((await one<{ p: number }>("SELECT i.price_per_share AS p FROM issuances i JOIN stakeholders s ON s.id = i.stakeholder_id WHERE s.name = 'Pim Lucid' AND i.company_id = ?", cid))!.p), 1_000_000);
});

test('a file imported again with another answer to "ISO or NSO?" or another class flags the record instead of adding it twice', async () => {
  const cid = await company('Kestrel Optics');
  const grants = (type: string) => csv([['Optionee', 'Email', 'Award type', 'Shares', 'Strike price', 'Grant date', 'Vesting schedule'],
    ['Owen Kestrel', 'owen@kestrel.example', type, '25,000', '0.20', '2024-03-15', '4y/1y monthly']]);
  const options = { defaultPoolName: 'Kestrel Plan' };
  assert.equal((await commit(cid, { sheets: await sheetsFrom(cid, [{ name: 'grants.csv', body: grants('NSO') }]), options })).status, 200);
  const again = (await preview(cid, { sheets: await sheetsFrom(cid, [{ name: 'grants.csv', body: grants('ISO') }]), options })).json.sheets[0].preview.rows[0];
  assert.deepEqual([again.outcome, again.status], ['add', 'warning']);
  assert.deepEqual(again.messages.find((m: any) => m.code === 'similar-on-record'), { level: 'warning', code: 'similar-on-record', field: 'quantity',
    text: 'The cap table already has an NSO grant for Owen Kestrel with these shares and this date — if this row is that grant, leave the row out' });

  const certificates = (cls: string) => csv([['Stakeholder', 'Email', 'Share class', 'Shares', 'Price per share', 'Issue date'],
    ['Ida Kestrel', 'ida@kestrel.example', cls, '4,000,000', '0.0001', '2021-03-01']]);
  assert.equal((await commit(cid, { sheets: await sheetsFrom(cid, [{ name: 'certificates.csv', body: certificates('Common') }]) })).status, 200);
  const renamed = (await preview(cid, { sheets: await sheetsFrom(cid, [{ name: 'certificates.csv', body: certificates('Common Stock') }]) })).json.sheets[0].preview.rows[0];
  assert.deepEqual([renamed.outcome, renamed.status], ['add', 'warning']);
  assert.deepEqual(renamed.messages.find((m: any) => m.code === 'similar-on-record'), { level: 'warning', code: 'similar-on-record', field: 'quantity',
    text: 'The cap table already has a Common certificate for Ida Kestrel with these shares and this date — if this row is that certificate, leave the row out' });
});

test('a person a stakeholder report lists without an email gets the one a ledger in another file gives them', async () => {
  const cid = await company('Barlow Freight');
  const sheets = await sheetsFrom(cid, [
    { name: 'report.csv', body: csv([['Name', 'Relationship', 'Start date'], ['Kit Barlow', 'Employee', '2023-09-01']]) },
    { name: 'grants.csv', body: csv([['Optionee', 'Email', 'Award type', 'Shares', 'Strike price', 'Grant date', 'Vesting schedule'],
      ['Kit Barlow', 'kit@barlow.example', 'NSO', '5,000', '0.40', '2024-04-01', '4y/1y monthly'],
      ['Kit Barlow', 'kit@barlow.example', 'NSO', '1,000', '0.40', '2024-06-01', '4y/1y monthly']]) },
  ]);
  const options = { defaultPoolName: 'Barlow Plan' };
  const dry = await preview(cid, { sheets, options });
  const grants = dry.json.sheets.find((s: any) => s.kind === 'grants').preview.rows;
  assert.deepEqual(grants[0].messages.find((m: any) => m.code === 'stakeholder-updated'),
    { level: 'info', code: 'stakeholder-updated', field: 'email', value: 'kit@barlow.example', text: 'Gives "Kit Barlow" the email kit@barlow.example' });
  assert.ok(!grants[1].messages.some((m: any) => m.code === 'stakeholder-updated' || m.code === 'same-name'), 'the second row finds them by the email the first gave');
  assert.deepEqual(dry.json.creates.stakeholders, ['Kit Barlow']);
  assert.equal((await commit(cid, { sheets, options })).status, 200);
  assert.deepEqual(await all('SELECT name, email FROM stakeholders WHERE company_id = ?', cid), [{ name: 'Kit Barlow', email: 'kit@barlow.example' }]);
});

test('a grant of February 29 with no expiration expires on February 28 ten years on', async () => {
  const cid = await company('Leap Day Ltd');
  const sheets = await sheetsFrom(cid, [{ name: 'grants.csv', body: csv([['Optionee', 'Award type', 'Shares', 'Strike price', 'Grant date', 'Vesting schedule'],
    ['Lea Day', 'ISO', '1,000', '0.10', '2024-02-29', '4y/1y monthly']]) }]);
  assert.equal((await commit(cid, { sheets, options: { defaultPoolName: 'Leap Plan' } })).status, 200);
  assert.equal((await one<{ expiration_date: string }>('SELECT expiration_date FROM awards WHERE company_id = ?', cid))!.expiration_date, '2034-02-28');
});

test('a long sheet says in the review how much of it was left behind; a format sent back as parse read it is still the file\'s own reading', async () => {
  const cid = await company('Tally Rows');
  configure({ limits: { importMaxRows: 5 } });
  try {
    const rows = Array.from({ length: 8 }, (_, i) => [`Holder ${i + 1}`, 'Common', '10', '2024-01-02']);
    const file = csv([['Pellham export'], ['Stakeholder', 'Share class', 'Shares', 'Issue date'], ...rows]);
    const parsed = await parse(cid, 'long.csv', file);
    const sheet = parsed.json.sheets[0];
    assert.deepEqual([sheet.headerRow, sheet.rows.length, sheet.rowCount, sheet.truncated], [1, 7, 10, true]);
    assert.equal(sheet.notices[0].text, 'Only the first 5 of 8 rows are included. Import the rest as a second file.');
    const sheets = await sheetsFrom(cid, [{ name: 'long.csv', body: file }]);
    const dry = await preview(cid, { sheets });
    assert.deepEqual(dry.json.sheets[0].preview.notices, [{ code: 'truncated', level: 'warning', text: 'Only the first 5 of 8 rows are included. Import the rest as a second file.' }]);
    assert.equal(dry.json.counts.total, 5);
    // A CSV can run past Excel's last row; its count still comes back.
    const huge = await preview(cid, { sheets: sheets.map((s) => ({ ...s, rowCount: 2_000_000 })) });
    assert.equal(huge.json.sheets[0].preview.notices[0].text, 'Only the first 5 of 1,999,998 rows are included. Import the rest as a second file.');
  } finally {
    resetConfig();
  }
  const eu = await sheetsFrom(cid, [{ name: 'eu.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Price per share', 'Issue date'], ['Una Tally', 'Common', '1.000', '0,0001', '2024-01-02']], ';') }]);
  assert.equal(eu[0].numberFormat, 'eu');
  const readAs = (await preview(cid, { sheets: eu })).json.readAs[0];
  assert.deepEqual([readAs.numberFormat, readAs.numberDecidedBy, readAs.numberEvidence.text, readAs.numberMixed], ['eu', 'file', '0,0001', false]);
  assert.equal((await preview(cid, { sheets: eu.map((s) => ({ ...s, numberFormat: 'en' })) })).json.readAs[0].numberDecidedBy, 'given');
});

test('a commit must be what was reviewed: other options or cells are refused as not reviewed, a changed cap table as stale', async () => {
  const cid = await company('Token Works');
  const sheets = await sheetsFrom(cid, [{ name: 'c.csv', body: csv([['Stakeholder', 'Share class', 'Shares', 'Issue date'],
    ['Wyn Token', 'Common', '1,000', '2024-01-02'], ['Xan Token', 'Common', '2,000', '2024-02-31']]) }]);
  const review = await preview(cid, { sheets });
  assert.match(review.json.reviewToken, /^[\w-]{22}\.[\w-]{22}$/);
  // Leaving the bad row out changes what would be written: check again first.
  const leave = await commit(cid, { sheets, options: { skipRowsWithErrors: true }, reviewToken: review.json.reviewToken });
  assert.deepEqual([leave.status, leave.json.detail.code, leave.json.error], [409, 'not-reviewed', 'These rows were checked with other settings or other cells. Check them again before importing']);
  const edited = sheets.map((s) => ({ ...s, rows: [s.rows[0], ['Xan Token', 'Common', '2,000', '2024-02-28']] }));
  assert.equal((await commit(cid, { sheets: edited, reviewToken: review.json.reviewToken })).json.detail.code, 'not-reviewed');
  assert.equal(await countOf(cid, 'issuances'), 0);

  const fixed = await preview(cid, { sheets: edited });
  // Someone else imports one of the rows in between: the same body now comes out differently.
  assert.equal((await commit(cid, { sheets: edited.map((s) => ({ ...s, rows: [s.rows[0]] })) })).status, 200);
  const stale = await commit(cid, { sheets: edited, reviewToken: fixed.json.reviewToken });
  assert.deepEqual([stale.status, stale.json.detail.code, stale.json.detail.counts.existing], [409, 'stale-review', 1]);
  assert.equal(await countOf(cid, 'issuances'), 1);
  const current = await preview(cid, { sheets: edited });
  assert.equal((await commit(cid, { sheets: edited, reviewToken: current.json.reviewToken })).status, 200);
  assert.equal(await countOf(cid, 'issuances'), 2);
  // expectedCounts, for older pages, must be all of the counts.
  assert.deepEqual((await commit(cid, { sheets: edited, expectedCounts: {} })).json.detail, { code: 'bad-option' });
});
