/**
 * Cap table exports over HTTP: the Excel workbook round-trips through our own
 * parser with the page's columns and totals, the PDF is a well-formed file
 * with the company's numbers in it, and portfolio-only roles are refused.
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
await import('../src/routes/data.ts');
await import('../src/routes/captable-export.ts');
const { insert, one, run } = await import('../src/db.ts');
const { parseXlsx } = await import('../src/import/xlsx.ts');
const { tablePdf } = await import('../src/pdf-writer.ts');

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
async function download(path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition') ?? '', body: Buffer.from(await res.arrayBuffer()) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Export Co', legalName: 'Export Co, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
// A new company's Common class is dated today; the exports below look back to 2026-01-01, so date it with the first issuance.
await run("UPDATE share_classes SET issue_date = '2023-01-01' WHERE id = ?", common);
await insert('stakeholders', { id: 'stk_ava', companyId: cid, name: 'Ava Founder', email: 'ava@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', createdAt: now });
await insert('stakeholders', { id: 'stk_ben', companyId: cid, name: 'Ben Investor', email: 'ben@example.com', type: 'INDIVIDUAL', relation: 'INVESTOR', createdAt: now });
await insert('stakeholders', { id: 'stk_cam', companyId: cid, name: 'Cam Employee', email: 'cam@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insertSecurity('issuances', { id: 'iss_1', companyId: cid, certificateNo: 'CS-1', stakeholderId: 'stk_ava', shareClassId: common, quantity: 6_000_000, pricePerShare: 100, issueDate: '2023-01-15', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
await insertSecurity('issuances', { id: 'iss_2', companyId: cid, certificateNo: 'CS-2', stakeholderId: 'stk_ben', shareClassId: common, quantity: 2_000_000, pricePerShare: 500_000, issueDate: '2024-03-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
await insert('pools', { id: 'pool_1', companyId: cid, name: '2023 Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
await insertSecurity('awards', { id: 'awa_1', companyId: cid, label: 'OPT-1', stakeholderId: 'stk_cam', poolId: 'pool_1', type: 'ISO', quantity: 400_000, strikePrice: 500_000,
  grantDate: '2024-06-01', vestingStartDate: '2024-06-01', vestingScheduleId: schedule, status: 'OUTSTANDING', expirationDate: '2034-06-01', ptepMonths: 3,
  earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 500_000, rsuLiquidityCondition: 0, createdAt: now });

test('the Excel export carries the fully diluted view with a pool row, totals, share classes and a summary', async () => {
  const r = await download(`/api/c/${cid}/captable/export.xlsx?asOf=2026-01-01&view=FULLY_DILUTED&includePool=true`, admin);
  assert.equal(r.status, 200);
  assert.match(r.type, /spreadsheetml/);
  assert.match(r.disposition, /cap-table-2026-01-01\.xlsx/);
  assert.equal(r.body.subarray(0, 2).toString('latin1'), 'PK');

  const sheets = parseXlsx(r.body);
  assert.deepEqual(sheets.map((s) => s.name), ['Cap table', 'Share classes', 'Summary']);
  const [table, classes, summary] = sheets;
  assert.deepEqual(table.rows[0], ['Holder', 'Relationship', 'Shares', 'Options', 'RSUs', 'Warrants', 'Fully diluted shares', 'Ownership %', 'Invested ($)', 'Value ($)']);
  const holders = table.rows.slice(1).map((row) => row[0]);
  assert.deepEqual(holders, ['Ava Founder', 'Ben Investor', 'Cam Employee', 'Unallocated pool', 'Total']);
  const ava = table.rows[1];
  assert.equal(ava[1], 'Founder');
  assert.equal(Number(ava[2]), 6_000_000);
  assert.equal(Number(ava[6]), 6_000_000);
  const pool = table.rows[4];
  assert.equal(Number(pool[6]), 600_000); // 1,000,000 reserved less the 400,000 granted
  const total = table.rows[5];
  assert.equal(Number(total[6]), 9_000_000); // 8,000,000 issued + 400,000 options + 600,000 pool
  assert.equal(Number(total[7]), 100);
  // Ownership adds up across holders and the pool.
  const pctSum = table.rows.slice(1, 5).reduce((s, row) => s + Number(row[7]), 0);
  assert.ok(Math.abs(pctSum - 100) < 0.01, `ownership sums to ${pctSum}`);

  assert.equal(classes.rows[0][0], 'Share class');
  assert.equal(classes.rows.length, 2);
  assert.equal(Number(classes.rows[1][3]), 8_000_000);

  const summaryMap = new Map(summary.rows.filter((row) => row.length >= 2).map((row) => [String(row[0]), row[1]]));
  assert.equal(summaryMap.get('Company'), 'Export Co');
  assert.equal(summaryMap.get('View'), 'Fully diluted');
  assert.equal(Number(summaryMap.get('Fully diluted shares')), 9_000_000);
  assert.equal(summaryMap.get('Includes unallocated pool'), 'Yes');
});

test('the outstanding view leaves out options and the pool, and follows the view parameter', async () => {
  const r = await download(`/api/c/${cid}/captable/export.xlsx?asOf=2026-01-01&view=OUTSTANDING`, admin);
  const [table] = parseXlsx(r.body);
  assert.equal(table.rows[0][6], 'Outstanding shares');
  assert.deepEqual(table.rows.slice(1).map((row) => row[0]), ['Ava Founder', 'Ben Investor', 'Cam Employee', 'Total']);
  assert.equal(Number(table.rows[4][6]), 8_000_000);
  const bad = await download(`/api/c/${cid}/captable/export.xlsx?view=SIDEWAYS`, admin);
  assert.equal(bad.status, 400);
});

test('the PDF export is a well-formed document with the company and its holders in it', async () => {
  const r = await download(`/api/c/${cid}/captable/export.pdf?asOf=2026-01-01&view=FULLY_DILUTED`, admin);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/pdf');
  assert.match(r.disposition, /cap-table-2026-01-01\.pdf/);
  const text = r.body.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(text.includes('(Export Co \\227 Cap table)'), 'title with an em dash in WinAnsi');
  assert.ok(text.includes('(Ava Founder)') && text.includes('(Cam Employee)') && text.includes('(Unallocated pool)') && text.includes('(Total)'));
  assert.ok(text.includes('(9,000,000)'), 'fully diluted total printed with separators');
  assert.ok(text.includes('/BaseFont /Helvetica-Bold'));
  // The cross-reference table points at the byte where "xref" starts.
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)![1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  // Every object offset in the table lands on "<n> 0 obj".
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  assert.ok(offsets.length >= 7);
  offsets.forEach((o, i) => assert.match(text.slice(o, o + 12), new RegExp(`^${i + 1} 0 obj`)));
});

test('the PDF writer paginates long tables and repeats the header on every page', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ cells: [`Holder ${i + 1}`, 'Employee', String(1000 * (i + 1))] }));
  const pdf = tablePdf({ title: 'Long table', columns: [{ header: 'Holder' }, { header: 'Relationship' }, { header: 'Shares', align: 'right' }], rows }).toString('latin1');
  const pages = Number(pdf.match(/\/Count (\d+)/)![1]);
  assert.ok(pages >= 4, `expected several pages, got ${pages}`);
  assert.equal((pdf.match(/\(Page \d+ of \d+\)/g) ?? []).length, pages);
  assert.equal((pdf.match(/\(Holder\)/g) ?? []).length, pages, 'header row on each page');
  assert.ok(pdf.includes('(Holder 120)'));
});

test('a portfolio-only member cannot export the cap table', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'cam@example.com', name: 'Cam Employee', role: 'EMPLOYEE' }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const cam = (await call('POST', '/api/auth/reset', { token, password: 'cam-pass-1' })).token as string;
  const r = await download(`/api/c/${cid}/captable/export.pdf`, cam);
  assert.equal(r.status, 403);
});
