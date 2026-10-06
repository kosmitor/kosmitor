/**
 * The fictional sample company: its workbooks import through the same path as
 * a real export and reconcile to the totals the sample declares, the database
 * version of the sample builds cleanly with the same numbers, and the workbooks
 * kept in samples/ are the ones the sample builds, dates included.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/imports.ts');
await import('../src/routes/data.ts');
const { buildWorkbooks, createSampleCompany, SAMPLE_TOTALS, SAMPLE_COMPANY, SAMPLE_AS_OF, PEOPLE, COMMON, SEED, GRANTS, SAFES, EXERCISE, VALUATIONS } = await import('../src/sample.ts');
const { parseXlsx } = await import('../src/import/xlsx.ts');
const { detectSheet, guessHeaderRow } = await import('../src/import/values.ts');
const { runWorkbook } = await import('../src/import/engine.ts');
const { getCompanyData } = await import('../src/store.ts');
const { computeCapTable, addMonths, addDays, daysBetween } = await import('@kosmitor/core');
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

/** Detects every sheet of a workbook the way the wizard does and turns the recognised ones into import requests. */
function sheetsOf(buffer: Buffer) {
  return parseXlsx(buffer).map((sheet) => {
    const headerRow = guessHeaderRow(sheet.rows);
    const headers = sheet.rows[headerRow] ?? [];
    const rows = sheet.rows.slice(headerRow + 1);
    const det = detectSheet(sheet.name, headers, rows.length);
    if (!det.kind) return null;
    const mapping: Record<string, number | { value: string } | null> = { ...det.mapping };
    for (const [k, v] of Object.entries(det.constants)) if (mapping[k] == null) mapping[k] = { value: v };
    return { kind: det.kind, headers, rows, mapping, headerRowNumber: headerRow + 1, options: {}, sheetName: sheet.name };
  }).filter((s): s is NonNullable<typeof s> => s !== null);
}

test('the sample workbooks import like a real export and reconcile to the declared totals', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'import@example.com', name: 'Import Tester', password: 'import-pass-1' })).token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Marlowe (import)' }, admin)).json.id as string;
  const { stakeholderReport, capTable } = buildWorkbooks();

  const peopleSheets = sheetsOf(stakeholderReport);
  assert.deepEqual(peopleSheets.map((s) => s.kind), ['stakeholders']);
  const people = await runWorkbook(cid, peopleSheets, 'Import Tester', false);
  assert.equal(people.sheets[0].blocked, false, JSON.stringify((people.sheets[0].preview as any).rows.filter((r: any) => r.status !== 'ok')));
  assert.equal(people.imported.stakeholders, PEOPLE.length);

  const capSheets = sheetsOf(capTable);
  assert.deepEqual(capSheets.map((s) => `${s.sheetName}:${s.kind}`), ['Common:captable', 'Series Seed Preferred:captable', '2022 Stock Plan:grants', 'SAFEs:convertibles']);   // the Summary sheet is left out
  const preview = await runWorkbook(cid, capSheets, 'Import Tester', true);
  for (const s of preview.sheets) assert.equal(s.blocked, false, `${s.sheetName}: ${JSON.stringify((s.preview as any).rows.filter((r: any) => r.status !== 'ok'))}`);
  const result = await runWorkbook(cid, capSheets, 'Import Tester', false);
  assert.equal(result.imported.issuances, 13);
  assert.equal(result.imported.awards, 10);
  assert.equal(result.imported.convertibles, 9);
  assert.equal(result.imported.stakeholders, 0);                                                  // everyone was already on the register
  assert.equal(result.imported.shareClasses, 1);                                                  // Series Seed Preferred; Common already existed

  const data = await getCompanyData(cid);
  const table = computeCapTable(data, { asOf: SAMPLE_AS_OF });
  assert.equal(table.totals.outstanding, SAMPLE_TOTALS.commonOutstanding + SAMPLE_TOTALS.seedOutstanding);
  assert.equal(table.totals.optionsOutstanding, SAMPLE_TOTALS.optionsOutstanding);
  assert.equal(table.totals.poolAvailable, SAMPLE_TOTALS.poolAvailable);
  assert.equal(table.totals.fullyDiluted, SAMPLE_TOTALS.fullyDiluted);
  const pool = (await call('GET', `/api/c/${cid}/pools/summary`, undefined, admin)).json[0];
  assert.equal(pool.name, '2022 Stock Plan');
  assert.equal(Number(pool.authorized), 1_800_000);
  assert.equal(pool.available, SAMPLE_TOTALS.poolAvailable);
  const stack = (await call('GET', `/api/c/${cid}/model/convertibles`, undefined, admin)).json;
  assert.equal(stack.count, SAMPLE_TOTALS.safesOutstanding);
  assert.equal(stack.totalPrincipal, SAMPLE_TOTALS.safePrincipal * 100);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM convertibles WHERE company_id = ? AND status = 'CANCELLED'", cid))!.n, 1);
  const oscar = await one<{ exercised_quantity: number; cancelled_quantity: number; status: string }>("SELECT * FROM awards WHERE company_id = ? AND label = 'OPT-5'", cid);
  assert.equal(Number(oscar!.exercised_quantity), 23_437);
  assert.equal(Number(oscar!.cancelled_quantity), 51_563);

  // Importing the same workbook again is refused as duplicates, so the numbers cannot drift.
  const again = await runWorkbook(cid, capSheets, 'Import Tester', true);
  assert.ok(again.sheets.some((s) => s.blocked));
});

test('the database sample builds the same company with approvals, signatures and an update in flight', async () => {
  const companyId = await createSampleCompany('founder@example.com');
  const company = await one<{ name: string; legal_name: string }>('SELECT name, legal_name FROM companies WHERE id = ?', companyId);
  assert.equal(company!.legal_name, SAMPLE_COMPANY.legalName);
  const data = await getCompanyData(companyId);
  const table = computeCapTable(data, { asOf: SAMPLE_AS_OF });
  assert.equal(table.totals.fullyDiluted, SAMPLE_TOTALS.fullyDiluted);
  assert.equal(table.totals.optionsOutstanding, SAMPLE_TOTALS.optionsOutstanding);              // the pending grant stays out until signed
  assert.equal((await all("SELECT id FROM awards WHERE company_id = ? AND status = 'PENDING_SIGNATURE'", companyId)).length, 1);
  assert.equal((await all("SELECT id FROM signatures WHERE company_id = ? AND status = 'PENDING'", companyId)).length, 1);
  assert.equal((await all("SELECT id FROM board_consents WHERE company_id = ? AND status = 'PENDING'", companyId)).length, 2);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM update_recipients r JOIN investor_updates u ON u.id = r.update_id WHERE u.company_id = ?", companyId))!.n, PEOPLE.filter((p) => p.relation === 'INVESTOR').length);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM exercises WHERE company_id = ?", companyId))!.n, 1);
  assert.equal((await one<{ status: string }>("SELECT status FROM offers WHERE company_id = ?", companyId))!.status, 'SENT');

  // Nobody real: every email is on a reserved example domain.
  const emails = await all<{ email: string | null }>('SELECT email FROM stakeholders WHERE company_id = ?', companyId);
  for (const e of emails) if (e.email) assert.match(e.email, /\.example$|@example\.com$/);
});

test('the workbooks kept in samples/ are the ones the sample builds, cell for cell', () => {
  // Written by `npm run sample -- --files-only`; a change to the sample's records or dates that is not written out shows here.
  const built = buildWorkbooks();
  for (const [file, body] of [['marlowe-stakeholder-report.xlsx', built.stakeholderReport], ['marlowe-cap-table.xlsx', built.capTable]] as const) {
    assert.deepEqual(parseXlsx(readFileSync(resolve(import.meta.dirname, '..', 'samples', file))), parseXlsx(body), `${file} is out of date`);
  }
  const summary = parseXlsx(built.capTable).find((s) => s.name === 'Summary')!;
  assert.deepEqual(summary.rows[1], ['Cap table as of', SAMPLE_AS_OF]);
});

test('the sample\'s calendar holds its story together', () => {
  // The founders start, are issued their shares and begin vesting the day the company is incorporated, and file their 83(b)s inside the 30 days.
  const founders = COMMON.filter((c) => PEOPLE.find((p) => p.key === c.holder)!.relation === 'FOUNDER');
  assert.equal(founders.length, 3);
  for (const c of founders) {
    assert.deepEqual([c.date, c.vestStart, PEOPLE.find((p) => p.key === c.holder)!.start], Array(3).fill(SAMPLE_COMPANY.incorporationDate), c.no);
    assert.ok(daysBetween(c.date, c.filed83b!) <= 30, `${c.no}'s 83(b)`);
  }
  // Oscar leaves, exercises inside his three-month window, and the rest lapses the day it closes.
  const oscar = PEOPLE.find((p) => p.key === 'oscar')!;
  assert.ok(oscar.end! < EXERCISE.date && EXERCISE.date < EXERCISE.cancelledOn);
  assert.equal(EXERCISE.cancelledOn, addMonths(oscar.end!, 3));
  // Each 409A runs a year less a day.
  for (const [effective, , expires] of VALUATIONS) assert.equal(expires, addDays(addMonths(effective, 12), -1), effective);
  // Nothing in the export is dated after the export, or before the company.
  const dates = [...COMMON, ...SEED].map((c) => c.date).concat(GRANTS.map((g) => g.date), SAFES.map((s) => s.date));
  for (const d of dates) assert.ok(d >= SAMPLE_COMPANY.incorporationDate && d <= SAMPLE_AS_OF, d);
});
