/**
 * The compliance sections over HTTP: 83(b) rows, Form 3921 by tax year with
 * its CSV, beneficial ownership with the company's BOI standing, and filing
 * records that turn findings off.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/data.ts');
const { insert, one } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

test('83(b), Form 3921 and BOI sections read from the cap table; filings and the BOI status change what they report', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Sections Co', jurisdiction: 'Delaware' }, admin)).json.id as string;
  const now = new Date().toISOString();
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
  await insert('stakeholders', { id: 'stk_f', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', title: 'Chief Executive Officer', address: '1 Main St, Dover, DE', createdAt: now });
  await insert('stakeholders', { id: 'stk_e', companyId: cid, name: 'Marcus Webb', email: null, type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  await insert('stakeholders', { id: 'stk_v', companyId: cid, name: 'Kestrel Ventures II, L.P.', email: null, type: 'FUND', relation: 'INVESTOR', createdAt: now });
  await insert('issuances', { id: 'iss_f', companyId: cid, certificateNo: 'CS-1', stakeholderId: 'stk_f', shareClassId: common, quantity: 6_000_000, pricePerShare: 100,
    issueDate: '2024-01-15', status: 'OUTSTANDING', vestingScheduleId: schedule, vestingStartDate: '2024-01-15', earlyExercised: 0, createdAt: now });
  await insert('issuances', { id: 'iss_v', companyId: cid, certificateNo: 'CS-2', stakeholderId: 'stk_v', shareClassId: common, quantity: 3_000_000, pricePerShare: 5_000_000,
    issueDate: '2024-06-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
  await insert('pools', { id: 'pool_s', companyId: cid, name: '2024 Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
  await insert('awards', { id: 'awa_iso', companyId: cid, label: 'OPT-1', stakeholderId: 'stk_e', poolId: 'pool_s', type: 'ISO', quantity: 100_000, strikePrice: 500_000,
    grantDate: '2023-03-01', vestingStartDate: '2023-03-01', vestingScheduleId: schedule, status: 'OUTSTANDING', expirationDate: '2033-03-01', ptepMonths: 3,
    earlyExerciseAllowed: 0, exercisedQuantity: 10_000, cancelledQuantity: 0, fmvAtGrant: 500_000, rsuLiquidityCondition: 0, createdAt: now });
  await insert('exercises', { id: 'ex_1', companyId: cid, awardId: 'awa_iso', stakeholderId: 'stk_e', quantity: 10_000, exerciseDate: '2025-05-10', method: 'CASH',
    strikePrice: 500_000, fmvAtExercise: 2_000_000, totalCost: 5_000_00, spread: 15_000_00, sharesIssued: 10_000, status: 'COMPLETED', createdAt: now });

  // 83(b): the founder's vesting stock is listed and closed; the investor's fully vested shares are not.
  const b = await call('GET', `/api/c/${cid}/compliance/83b?asOf=2026-09-20`, undefined, admin);
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.rows.map((r: any) => [r.certificateNo, r.status, r.deadline, r.reason]), [['CS-1', 'CLOSED', '2024-02-14', 'vesting']]);
  assert.deepEqual(b.json.counts, { filed: 0, open: 0, closed: 1 });
  assert.equal(b.json.unrestricted, 1);

  // Form 3921: the 2025 exercise is due after the year closes, then recorded as filed.
  const f = await call('GET', `/api/c/${cid}/compliance/form-3921?asOf=2026-02-15`, undefined, admin);
  assert.equal(f.json.year, 2025);
  assert.equal(f.json.state, 'DUE');
  assert.equal(f.json.rows.length, 1);
  assert.equal(f.json.rows[0].grantDate, '2023-03-01');
  assert.equal(f.json.rows[0].fmvAtExercise, 2_000_000);
  // January 31 and February 28, 2026 are Saturdays, so both move to the Monday after (IRC 7503).
  assert.deepEqual(f.json.deadlines, { furnish: '2026-02-02', filePaper: '2026-03-02', fileElectronic: '2026-03-31' });
  const csv = await fetch(`${base}/api/c/${cid}/compliance/form-3921.csv?year=2025`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /Box 1 Date option granted/);
  assert.match(csvText, /Marcus Webb,,,2023-03-01,2025-05-10,0.5000,2.0000,10000,,OPT-1,15000.00/);
  const overview = await call('GET', `/api/c/${cid}/compliance?asOf=2026-02-15`, undefined, admin);
  assert.ok(overview.json.issues.some((i: any) => i.rule === 'FORM_3921'));
  assert.deepEqual(overview.json.sections.form3921, [{ year: 2025, state: 'DUE', count: 1 }]);

  assert.equal((await call('POST', `/api/c/${cid}/compliance/filings`, { kind: 'FORM_3921', period: '25', filedOn: '2026-01-20' }, admin)).status, 400);
  const filing = await call('POST', `/api/c/${cid}/compliance/filings`, { kind: 'FORM_3921', period: '2025', filedOn: '2026-01-20', reference: 'IRIS receipt 42' }, admin);
  assert.equal(filing.status, 200);
  assert.equal((await call('GET', `/api/c/${cid}/compliance/form-3921?asOf=2026-02-15&year=2025`, undefined, admin)).json.state, 'FILED');
  assert.ok(!(await call('GET', `/api/c/${cid}/compliance?asOf=2026-02-15`, undefined, admin)).json.issues.some((i: any) => i.rule === 'FORM_3921'));

  // BOI: a Delaware company is exempt by default; marked as a reporting company it needs a report, and the founder/CEO is a beneficial owner.
  const boi = await call('GET', `/api/c/${cid}/compliance/boi?asOf=2026-09-20`, undefined, admin);
  assert.equal(boi.json.status, 'EXEMPT_DOMESTIC');
  assert.equal(boi.json.statusSource, 'derived');
  assert.deepEqual(boi.json.owners.map((o: any) => [o.name, o.reasons.sort()]), [['Priya Raman', ['control', 'ownership']]]);
  assert.equal(boi.json.owners[0].address, '1 Main St, Dover, DE');
  assert.deepEqual(boi.json.entitiesToLookThrough.map((e: any) => e.name), ['Kestrel Ventures II, L.P.']);
  assert.ok(!(await call('GET', `/api/c/${cid}/compliance?asOf=2026-09-20`, undefined, admin)).json.issues.some((i: any) => i.rule.startsWith('BOI')));

  assert.equal((await call('PATCH', `/api/c/${cid}`, { boiStatus: 'MAYBE' }, admin)).status, 400);
  assert.equal((await call('PATCH', `/api/c/${cid}`, { boiStatus: 'REQUIRED' }, admin)).status, 200);
  const required = await call('GET', `/api/c/${cid}/compliance?asOf=2026-09-20`, undefined, admin);
  assert.equal(required.json.issues.find((i: any) => i.rule === 'BOI_REPORT')?.severity, 'ERROR');
  assert.equal((await call('GET', `/api/c/${cid}/compliance/boi`, undefined, admin)).json.statusSource, 'set');
  const boiFiling = await call('POST', `/api/c/${cid}/compliance/filings`, { kind: 'BOI', period: 'INITIAL', filedOn: '2026-09-01', reference: 'FinCEN BOIR 123' }, admin);
  assert.equal(boiFiling.status, 200);
  const afterFiling = await call('GET', `/api/c/${cid}/compliance/boi?asOf=2026-09-20`, undefined, admin);
  assert.equal(afterFiling.json.lastFiledOn, '2026-09-01');
  assert.equal(afterFiling.json.updateDue, false);
  assert.ok(!(await call('GET', `/api/c/${cid}/compliance?asOf=2026-09-20`, undefined, admin)).json.issues.some((i: any) => i.rule === 'BOI_REPORT'));

  // Removing a filing record brings the finding back; portfolio-only roles are kept out.
  assert.equal((await call('DELETE', `/api/c/${cid}/compliance/filings/${boiFiling.json.id}`, undefined, admin)).status, 200);
  assert.ok((await call('GET', `/api/c/${cid}/compliance?asOf=2026-09-20`, undefined, admin)).json.issues.some((i: any) => i.rule === 'BOI_REPORT'));
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'marcus@example.com', name: 'Marcus Webb', role: 'EMPLOYEE' }, admin);
  const marcus = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'marcus-pass-1',
  })).json.token as string;
  assert.equal((await call('GET', `/api/c/${cid}/compliance/form-3921`, undefined, marcus)).status, 403);
});

test('the findings come with every area checked and the scoring, and the dashboard shows the same score', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'rowan@example.com', name: 'Rowan Hale', password: 'rowan-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Score Co', jurisdiction: 'Delaware' }, admin)).json.id as string;
  // A reporting company with no report on file: a must-fix finding the dashboard used to leave out.
  const set = await call('PATCH', `/api/c/${cid}`, { boiStatus: 'REQUIRED' }, admin);
  assert.equal(set.status, 200, JSON.stringify(set.json));

  const page = await call('GET', `/api/c/${cid}/compliance`, undefined, admin);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  assert.ok(page.json.checks.length >= 10);
  const boi = page.json.checks.find((c: any) => c.id === 'BOI');
  assert.equal(boi.status, 'FAIL');
  assert.deepEqual(page.json.scoring.points, { ERROR: 12, WARNING: 4, INFO: 1 });
  const { start, points } = page.json.scoring;
  assert.equal(page.json.score, Math.max(0, start - page.json.errors * points.ERROR - page.json.warnings * points.WARNING - page.json.info * points.INFO));
  assert.equal(typeof page.json.band, 'string');
  for (const c of page.json.checks) assert.ok(['PASS', 'REVIEW', 'FAIL', 'NOT_APPLICABLE'].includes(c.status) && c.summary, JSON.stringify(c));

  const dashboard = await call('GET', `/api/c/${cid}/dashboard`, undefined, admin);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.json.compliance.score, page.json.score, 'one score, whichever page shows it');
});
