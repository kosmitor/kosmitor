/**
 * Imported grants with cancelled shares get a dated entry in the ledger. The ISO
 * $100K test and the stock comp report place a cancellation in its year by the
 * ledger's CANCELLATION, FORFEITURE or EXPIRATION date; a grant that has none is
 * taken as cancelled on the as-of date, which keeps it counting in every year
 * up to then.
 *
 * Facts, fictional, shaped like Treas. Reg. 1.422-4(d) Ex.5(ii): Odile Brandt
 * holds three ISOs at a $1.00 strike and FMV, each exercisable a year after its
 * grant: TW-1 60,000 (2022-02-07), TW-2 50,000 (2022-04-11), TW-3 40,000
 * (2022-06-13). TW-2 is cancelled in full on 2022-12-05, before its first year,
 * so it is disregarded (1.422-4(b)(5)): 2023 holds $100,000 and TW-3 is all ISO.
 * Counted, 2023 would hold $150,000 and TW-3 would be all NSO.
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
await import('../src/routes/imports.ts');
const { all, one } = await import('../src/db.ts');

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

const admin = (await call('POST', '/api/auth/register', { email: 'nadia.voss@example.com', name: 'Nadia Voss', password: 'nadia-pass-1' })).token as string;
const company = async (name: string) => (await call('POST', '/api/companies', { name, incorporationDate: '2021-06-01' }, admin)).json.id as string;

const HEADERS = ['Optionee', 'Email', 'Grant ID', 'Grant Type', 'Granted', 'Exercise Price', 'Grant Date', 'Vesting Schedule', 'Equity Plan', 'Amount Cancelled', 'Cancellation Date'];
const odile = (label: string, granted: string, grantDate: string, cancelled = '', cancelledOn = '') =>
  ['Odile Brandt', 'odile.brandt@example.com', label, 'ISO', granted, '1.00', grantDate, '1y/1y', '2022 Equity Incentive Plan', cancelled, cancelledOn];
const EX5 = [odile('TW-1', '60,000', '2022-02-07'), odile('TW-2', '50,000', '2022-04-11', '50,000', '2022-12-05'), odile('TW-3', '40,000', '2022-06-13')];

/** Maps the columns the way the wizard does, then imports the sheet. */
async function importGrants(cid: string, headers: string[], rows: string[][]) {
  const suggested = (await call('POST', `/api/c/${cid}/imports/suggest`, { kind: 'grants', headers }, admin)).json;
  const r = await call('POST', `/api/c/${cid}/imports/commit`, { kind: 'grants', headers, rows, mapping: suggested.mapping, options: { fileName: 'grants.csv' } }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { mapping: suggested.mapping as Record<string, number | null>, result: r.json };
}

const ledger = (cid: string) => all<{ type: string; date: string; quantity: number; security_id: string; memo: string }>(
  "SELECT t.type, t.date, t.quantity, t.security_id, t.memo FROM transactions t WHERE t.company_id = ? AND t.type IN ('CANCELLATION', 'FORFEITURE', 'EXPIRATION')", cid);
const awardId = async (cid: string, label: string) => (await one<{ id: string }>('SELECT id FROM awards WHERE company_id = ? AND label = ?', cid, label))!.id;
const isoIn2023 = async (cid: string) => {
  const c = (await call('GET', `/api/c/${cid}/compliance?asOf=2023-12-31`, undefined, admin)).json;
  const rows: Record<string, [number, number]> = {};
  for (const r of c.iso100k.filter((r: any) => r.year === 2023)) rows[r.awardLabel] = [r.isoQualified, r.nsoRecharacterized];
  return { rows, limitFindings: c.issues.filter((i: any) => i.rule === 'ISO_100K').length };
};

test('a cancellation date column is recognised and written to the ledger with the cancelled shares', async () => {
  const cid = await company('Tidewater Instruments');
  const { mapping, result } = await importGrants(cid, HEADERS, EX5);
  assert.deepEqual([mapping.cancelledQuantity, mapping.cancellationDate], [9, 10]);
  assert.equal(result.imported.awards, 3);
  assert.deepEqual(await ledger(cid), [{ type: 'CANCELLATION', date: '2022-12-05', quantity: 50_000, security_id: await awardId(cid, 'TW-2'), memo: 'Imported from grants.csv' }]);
});

test('so the ISO $100K test disregards the grant cancelled before its first year: TW-3 is all ISO', async () => {
  const cid = await company('Tidewater Instruments (ISO)');
  await importGrants(cid, HEADERS, EX5);
  assert.deepEqual(await isoIn2023(cid), { rows: { 'TW-1': [60_000, 0], 'TW-3': [40_000, 0] }, limitFindings: 0 });
});

test('with no date and no termination on record, nothing is dated and the row says so', async () => {
  const cid = await company('Tidewater Instruments (undated)');
  const headers = HEADERS.slice(0, 10);
  const { result } = await importGrants(cid, headers, EX5.map((r) => r.slice(0, 10)));
  assert.deepEqual(await ledger(cid), []);
  const tw2 = result.rows.find((r: any) => r.summary.label === 'TW-2');
  assert.ok(tw2.messages.some((m: any) => m.level === 'info' && m.text === 'No cancellation date for the 50,000 cancelled shares — add one to place them in the right year for the ISO $100K test'), JSON.stringify(tw2.messages));
  // Undated, TW-2 is taken as cancelled on the as-of date and still counts in 2023.
  assert.deepEqual(await isoIn2023(cid), { rows: { 'TW-1': [60_000, 0], 'TW-2': [40_000, 10_000], 'TW-3': [0, 40_000] }, limitFindings: 1 });
});

test('a leaver\'s grant with no cancellation date is dated to the termination the people sheet records', async () => {
  // Basil Fenwick leaves on 2024-08-16; BF-1 lost 24,000 of its 48,000 options.
  const cid = await company('Fenwick & Hale');
  const people = { name: 'People', kind: 'stakeholders', headers: ['Name', 'Email', 'Relationship', 'Start Date', 'Termination Date'],
    rows: [['Basil Fenwick', 'basil.fenwick@example.com', 'Former employee', '2022-01-10', '2024-08-16']],
    mapping: { stakeholderName: 0, email: 1, relation: 2, startDate: 3, terminationDate: 4 } };
  const grantHeaders = HEADERS.slice(0, 10);
  const grants = { name: 'Grants', kind: 'grants', headers: grantHeaders,
    rows: [['Basil Fenwick', 'basil.fenwick@example.com', 'BF-1', 'NSO', '48,000', '0.30', '2022-01-10', '4y/1y', '2022 Plan', '24,000']],
    mapping: (await call('POST', `/api/c/${cid}/imports/suggest`, { kind: 'grants', headers: grantHeaders }, admin)).json.mapping };
  const r = await call('POST', `/api/c/${cid}/imports/workbook/commit`, { sheets: [grants, people], fileName: 'export.xlsx' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await ledger(cid), [{ type: 'FORFEITURE', date: '2024-08-16', quantity: 24_000, security_id: await awardId(cid, 'BF-1'),
    memo: 'Imported from export.xlsx › Grants (dated to the holder\'s termination)' }]);
  const row = r.json.sheets.find((s: any) => s.kind === 'grants').preview.rows[0];
  assert.ok(row.messages.some((m: any) => m.text === '24,000 cancelled shares dated to Basil Fenwick\'s termination on 2024-08-16'), JSON.stringify(row.messages));
});

test('after a stock split the cancellation is written in the shares of its own date', async () => {
  // SP-1: 9,000 NSOs granted 2021-03-01, 3,000 of them cancelled on 2024-05-06, after a 3-for-1 split on 2023-09-01.
  const cid = await company('Splitrock Labs');
  assert.equal((await call('POST', `/api/c/${cid}/stock-splits`, { date: '2023-09-01', ratio: 3 }, admin)).status, 200);
  await importGrants(cid, HEADERS, [['Mira Okonkwo', 'mira.okonkwo@example.com', 'SP-1', 'NSO', '9,000', '0.60', '2021-03-01', '4y/1y', '2021 Plan', '3,000', '2024-05-06']]);
  const [entry] = await ledger(cid);
  assert.deepEqual([entry.type, entry.date, entry.quantity], ['CANCELLATION', '2024-05-06', 9_000]);
  const award = await one<{ quantity: number; cancelled_quantity: number }>("SELECT * FROM awards WHERE company_id = ? AND label = 'SP-1'", cid);
  assert.deepEqual([Number(award!.quantity), Number(award!.cancelled_quantity)], [9_000, 3_000], 'the grant keeps its own units');
});

test('a cancellation dated before the grant is an error, and a date with nothing cancelled is not used', async () => {
  const cid = await company('Tidewater Instruments (checks)');
  const rows = [odile('CK-1', '10,000', '2023-03-01', '10,000', '2023-02-28'), odile('CK-2', '10,000', '2023-03-01', '', '2023-09-01')];
  const r = await call('POST', `/api/c/${cid}/imports/preview`, { kind: 'grants', headers: HEADERS, rows,
    mapping: (await call('POST', `/api/c/${cid}/imports/suggest`, { kind: 'grants', headers: HEADERS }, admin)).json.mapping }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rows[0].status, 'error');
  assert.ok(r.json.rows[0].messages.some((m: any) => m.text === 'Cancellation date is before the grant date'));
  assert.ok(r.json.rows[1].messages.some((m: any) => m.text === 'Cancellation date given with no cancelled shares — not used'));
});

test('exercised options and settled instruments are dated in the ledger, so past cap tables still show them', async () => {
  const cid = await company('Tidewater Exercises');
  const headers = [...HEADERS, 'Exercised', 'Exercise Date'];
  await importGrants(cid, headers, [[...odile('TW-9', '10,000', '2022-02-07'), '4,000', '2023-03-01'], [...odile('TW-10', '5,000', '2022-02-07'), '1,000', '']]);
  const exercises = await all<{ date: string; quantity: number }>("SELECT date, quantity FROM transactions WHERE company_id = ? AND type = 'EXERCISE' ORDER BY quantity DESC", cid);
  assert.deepEqual(exercises.map((e) => [e.date, Number(e.quantity)]), [['2023-03-01', 4_000], ['2022-02-07', 1_000]]);
  const options = async (asOf: string) => (await call('GET', `/api/c/${cid}/captable?asOf=${asOf}`, undefined, admin)).json.table.rows
    .reduce((s: number, r: any) => s + (r.optionsOutstanding ?? 0), 0);
  assert.equal(await options('2022-06-01'), 14_000, 'before 2023-03-01 the 4,000 were not yet exercised; the undated 1,000 were');
  assert.equal(await options('2023-06-01'), 10_000);

  const safeHeaders = ['Stakeholder', 'Instrument', 'Principal', 'Issue date', 'Valuation cap', 'Status', 'Converted on'];
  const suggested = (await call('POST', `/api/c/${cid}/imports/suggest`, { kind: 'convertibles', headers: safeHeaders }, admin)).json;
  const rows = [['Lior Vance', 'Post-money SAFE', '$100,000', '2022-01-10', '$10,000,000', 'Converted', '2023-05-01'], ['Mae Ostrow', 'Post-money SAFE', '$50,000', '2022-01-10', '$10,000,000', 'Cancelled', '']];
  const r = await call('POST', `/api/c/${cid}/imports/commit`, { kind: 'convertibles', headers: safeHeaders, rows, mapping: suggested.mapping, options: { fileName: 'safes.csv', createMissingStakeholders: true } }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const settled = await all<{ type: string; date: string }>("SELECT type, date FROM transactions WHERE company_id = ? AND type IN ('CONVERSION', 'CANCELLATION') ORDER BY type", cid);
  assert.deepEqual(settled.map((e) => [e.type, e.date]), [['CANCELLATION', '2022-01-10'], ['CONVERSION', '2023-05-01']]);
  const principal = async (asOf: string) => (await call('GET', `/api/c/${cid}/captable?asOf=${asOf}&includeConvertibles=true`, undefined, admin)).json.table.rows
    .reduce((s: number, x: any) => s + (x.convertiblePrincipal ?? 0), 0);
  assert.deepEqual([await principal('2022-06-01'), await principal('2023-06-01')], [10_000_000, 0]);
});
