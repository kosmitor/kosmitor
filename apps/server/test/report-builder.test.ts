/**
 * The custom report builder: datasets with typed columns, filters and sort,
 * CSV and Excel export (round-tripped through the import parser), and saved
 * report definitions.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie, insertSecurity } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/report-builder.ts');
await import('../src/routes/data.ts');
const { insert, one } = await import('../src/db.ts');
const { parseXlsx } = await import('../src/import/xlsx.ts');
const { xlsx, columnName } = await import('../src/xlsx-writer.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) return { status: res.status, type, json: (await res.json()) as any, buffer: Buffer.alloc(0), disposition: res.headers.get('content-disposition'), token: sessionCookie(res) };
  return { status: res.status, type, json: null, buffer: Buffer.from(await res.arrayBuffer()), disposition: res.headers.get('content-disposition') };
}
const encode = (spec: unknown) => Buffer.from(JSON.stringify(spec)).toString('base64url');

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Reportco' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string; name: string }>("SELECT id, name FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!;
await insert('pools', { id: 'pool_1', companyId: cid, name: '2026 Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
await insert('stakeholders', { id: 'stk_avery', companyId: cid, name: 'Avery Stone', email: 'avery@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', department: 'Leadership', createdAt: now });
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', department: 'Engineering', createdAt: now });
await insert('stakeholders', { id: 'stk_halcyon', companyId: cid, name: 'Halcyon Ventures', email: null, type: 'FUND', relation: 'INVESTOR', createdAt: now });
await insertSecurity('issuances', { id: 'iss_1', companyId: cid, certificateNo: 'CS-1', stakeholderId: 'stk_avery', shareClassId: common, quantity: 6_000_000, pricePerShare: 100, issueDate: '2024-01-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
await insertSecurity('issuances', { id: 'iss_2', companyId: cid, certificateNo: 'CS-2', stakeholderId: 'stk_halcyon', shareClassId: common, quantity: 2_000_000, pricePerShare: 1_000_000, issueDate: '2025-06-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
await insertSecurity('awards', { id: 'awa_1', companyId: cid, label: 'OPT-1', stakeholderId: 'stk_priya', poolId: 'pool_1', type: 'ISO', quantity: 48_000, strikePrice: 500_000, grantDate: '2025-01-01', vestingStartDate: '2025-01-01', vestingScheduleId: schedule.id,
  status: 'OUTSTANDING', expirationDate: '2035-01-01', ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 500_000, rsuLiquidityCondition: 0, createdAt: now });
await insertSecurity('awards', { id: 'awa_2', companyId: cid, label: 'OPT-2', stakeholderId: 'stk_avery', poolId: 'pool_1', type: 'NSO', quantity: 10_000, strikePrice: 500_000, grantDate: '2025-01-01', vestingStartDate: '2025-01-01', vestingScheduleId: schedule.id,
  status: 'CANCELLED', expirationDate: '2035-01-01', ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 10_000, fmvAtGrant: 500_000, rsuLiquidityCondition: 0, createdAt: now });

test('the xlsx writer produces workbooks the import parser reads back', () => {
  const book = xlsx([{ name: 'Data / Test', rows: [['Name', 'Shares', 'Price', 'Flag'], ['Avery "A" Stone', 6_000_000, 0.0001, true], ['Émilie <x>', null, 1.5, false]] }]);
  assert.equal(book.subarray(0, 2).toString('latin1'), 'PK');
  const sheets = parseXlsx(book);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Data   Test');
  assert.deepEqual(sheets[0].rows[0], ['Name', 'Shares', 'Price', 'Flag']);
  assert.equal(sheets[0].rows[1][0], 'Avery "A" Stone');
  assert.equal(sheets[0].rows[1][1], 6_000_000);
  assert.equal(sheets[0].rows[1][2], 0.0001);
  assert.equal(sheets[0].rows[2][0], 'Émilie <x>');
  assert.equal(sheets[0].rows[2][2], 1.5);
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27 * 26), 'AAA');
});

test('datasets, filters, sort, totals and exports', async () => {
  const meta = await call('GET', `/api/c/${cid}/report-builder`, undefined, admin);
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.json.datasets.map((d: any) => d.key), ['stakeholders', 'captable', 'certificates', 'grants', 'convertibles', 'warrants', 'transactions']);
  assert.ok(meta.json.datasets.find((d: any) => d.key === 'grants').columns.some((c: any) => c.key === 'vested' && c.type === 'number'));

  // Grants: only outstanding ones, sorted by holder, with a totals row.
  const grants = await call('POST', `/api/c/${cid}/report-builder/run`, {
    dataset: 'grants', columns: ['label', 'holder', 'quantity', 'vested', 'strikePrice', 'status'], filters: [{ column: 'status', op: 'eq', value: 'OUTSTANDING' }],
    sort: { column: 'holder', dir: 'asc' }, asOf: '2026-01-01', totals: true,
  }, admin);
  assert.equal(grants.status, 200, JSON.stringify(grants.json));
  assert.equal(grants.json.total, 1);
  assert.deepEqual(grants.json.columns.map((c: any) => c.key), ['label', 'holder', 'quantity', 'vested', 'strikePrice', 'status']);
  assert.equal(grants.json.rows[0][0], 'OPT-1');
  assert.equal(grants.json.rows[0][1], 'Priya Raman');
  assert.equal(grants.json.rows[0][2], 48_000);
  assert.equal(grants.json.rows[0][3], 12_000);                                                   // one year of a four-year schedule with a one-year cliff
  assert.deepEqual(grants.json.totalsRow, ['Total', '', 48_000, 12_000, '', '']);

  // Stakeholders: department filter, contains, numeric comparisons and emptiness.
  const eng = await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'stakeholders', columns: ['name', 'department', 'fullyDiluted'], filters: [{ column: 'department', op: 'contains', value: 'eng' }] }, admin);
  assert.deepEqual(eng.json.rows, [['Priya Raman', 'Engineering', 48_000]]);
  const big = await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'captable', columns: ['name', 'outstanding', 'fullyDilutedPct'], filters: [{ column: 'outstanding', op: 'gte', value: 2_000_000 }], sort: { column: 'outstanding', dir: 'desc' } }, admin);
  assert.deepEqual(big.json.rows.map((r: any[]) => r[0]), ['Avery Stone', 'Halcyon Ventures']);
  const noEmail = await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'stakeholders', columns: ['name'], filters: [{ column: 'email', op: 'empty' }] }, admin);
  assert.deepEqual(noEmail.json.rows, [['Halcyon Ventures']]);
  const some = await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'stakeholders', columns: ['name'], filters: [{ column: 'relation', op: 'in', value: ['FOUNDER', 'INVESTOR'] }], sort: { column: 'name' } }, admin);
  assert.deepEqual(some.json.rows, [['Avery Stone'], ['Halcyon Ventures']]);
  assert.equal((await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'nope' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'grants', filters: [{ column: 'bogus', op: 'eq', value: 1 }] }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/report-builder/run`, { dataset: 'grants', sort: { column: 'bogus' } }, admin)).status, 400);

  // CSV export: dollars and percentages as numbers, a BOM for Excel, a filename with the as-of date.
  const csvSpec = { dataset: 'certificates', columns: ['certificateNo', 'holder', 'quantity', 'pricePerShare', 'consideration', 'earlyExercised'], sort: { column: 'certificateNo' }, asOf: '2026-01-01', totals: true };
  const csv = await call('GET', `/api/c/${cid}/report-builder/export?format=csv&spec=${encode(csvSpec)}`, undefined, admin);
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.disposition ?? '', /Certificates_2026-01-01\.csv/);
  const text = csv.buffer.toString('utf8');
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).split('\n');
  assert.equal(lines[0], 'Certificate,Holder,Shares,Price per share,Consideration,Early exercised');
  assert.equal(lines[1], 'CS-1,Avery Stone,6000000,0.0001,600,No');
  assert.equal(lines[2], 'CS-2,Halcyon Ventures,2000000,1,2000000,No');
  assert.equal(lines[3], 'Total,,8000000,,2000600,');

  // Excel export: a real workbook the parser reads, with the header and typed cells.
  const xl = await call('GET', `/api/c/${cid}/report-builder/export?format=xlsx&name=Cert%20book&spec=${encode(csvSpec)}`, undefined, admin);
  assert.equal(xl.status, 200);
  assert.match(xl.type, /spreadsheetml/);
  assert.match(xl.disposition ?? '', /Cert_book_2026-01-01\.xlsx/);
  const sheets = parseXlsx(xl.buffer);
  assert.equal(sheets[0].name, 'Certificates');
  assert.deepEqual(sheets[0].rows[0], ['Certificate', 'Holder', 'Shares', 'Price per share', 'Consideration', 'Early exercised']);
  assert.deepEqual(sheets[0].rows[1], ['CS-1', 'Avery Stone', 6_000_000, 0.0001, 600, 'No']);
  assert.equal(sheets[0].rows[3][2], 8_000_000);
  assert.equal((await call('GET', `/api/c/${cid}/report-builder/export?format=csv&spec=not-base64`, undefined, admin)).status, 400);

  // Saved definitions.
  const saved = await call('POST', `/api/c/${cid}/report-builder/saved`, { name: 'Outstanding grants', config: { dataset: 'grants', columns: ['label', 'holder'], filters: [{ column: 'status', op: 'eq', value: 'OUTSTANDING' }] } }, admin);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.dataset, 'grants');
  assert.deepEqual(saved.json.config.columns, ['label', 'holder']);
  const renamed = await call('PATCH', `/api/c/${cid}/report-builder/saved/${saved.json.id}`, { name: 'Live grants', config: { dataset: 'grants', columns: ['label'], totals: true } }, admin);
  assert.equal(renamed.json.name, 'Live grants');
  assert.equal(renamed.json.config.totals, true);
  assert.equal((await call('GET', `/api/c/${cid}/report-builder`, undefined, admin)).json.saved.length, 1);
  assert.equal((await call('POST', `/api/c/${cid}/report-builder/saved`, { name: 'x', config: { dataset: 'nope' } }, admin)).status, 400);
  assert.equal((await call('DELETE', `/api/c/${cid}/report-builder/saved/${saved.json.id}`, undefined, admin)).status, 200);
  assert.equal((await call('GET', `/api/c/${cid}/report-builder`, undefined, admin)).json.saved.length, 0);
});
