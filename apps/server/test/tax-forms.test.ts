/**
 * Printable 83(b) election statements (holders may print their own) and
 * per-employee Form 3921 statements for a year's ISO exercises.
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
await import('../src/routes/certificates.ts');
await import('../src/routes/tax-forms.ts');
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
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, json: type.includes('json') ? ((await res.json()) as any) : null, text: type.includes('json') ? '' : await res.text(), token: sessionCookie(res) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Taxco', legalName: 'Taxco, Inc.' }, admin)).json.id as string;
await call('PATCH', `/api/c/${cid}`, { ein: '87-4410293', address: '1 Market St, San Francisco, CA 94105' }, admin);
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const vesting = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
const immediate = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED' LIMIT 1", cid))!.id;
await insert('pools', { id: 'pool_1', companyId: cid, name: 'Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', address: '12 Elm St, Oakland, CA', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insert('stakeholders', { id: 'stk_noor', companyId: cid, name: 'Noor Haddad', email: 'noor@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
const issued = today();
await insertSecurity('issuances', { id: 'iss_restricted', companyId: cid, certificateNo: 'CS-1', stakeholderId: 'stk_priya', shareClassId: common, quantity: 40_000, pricePerShare: 10_000, issueDate: issued, status: 'OUTSTANDING',
  vestingScheduleId: vesting, vestingStartDate: issued, earlyExercised: 0, createdAt: now });
await insertSecurity('issuances', { id: 'iss_plain', companyId: cid, certificateNo: 'CS-2', stakeholderId: 'stk_noor', shareClassId: common, quantity: 1_000, pricePerShare: 10_000, issueDate: '2024-01-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
await insert('valuations', { id: 'val_1', companyId: cid, type: '409A', fairMarketValue: 250_000, effectiveDate: '2024-01-01', status: 'ACTIVE', provider: 'Test', createdAt: now });

function today(): string { return new Date().toISOString().slice(0, 10); }

test('the 83(b) statement is prefilled for restricted stock and only for its holder or the company', async () => {
  const printed = await call('GET', `/api/c/${cid}/compliance/83b/iss_restricted/print`, undefined, admin);
  assert.equal(printed.status, 200);
  assert.match(printed.type, /text\/html/);
  assert.match(printed.text, /Election to include the value of restricted property/);
  assert.match(printed.text, /Priya Raman/);
  assert.match(printed.text, /12 Elm St, Oakland, CA/);
  assert.match(printed.text, /40,000 shares of Common of Taxco, Inc\. \(certificate CS-1\)/);
  assert.match(printed.text, /\$10,000\.00 \(\$0\.25 per share/);                              // fair market value from the 409A
  assert.match(printed.text, /\$400\.00 \(\$0\.01 per share\)/);                                // amount paid
  assert.match(printed.text, /Amount to include in gross income<\/th><td>\$9,600\.00/);
  assert.match(printed.text, /Taxpayer identification number<\/th><td><span class="blank">/);   // never stored, left blank
  assert.match(printed.text, /vest over time/);
  assert.match(printed.text, /How to file your 83\(b\) election/);
  assert.match(printed.text, /EIN 87-4410293/);
  assert.doesNotMatch(printed.text, /<script/);
  assert.equal((await call('GET', `/api/c/${cid}/compliance/83b/iss_plain/print`, undefined, admin)).status, 400);   // not restricted stock
  assert.equal((await call('GET', `/api/c/${cid}/compliance/83b/iss_missing/print`, undefined, admin)).status, 404);

  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'noor@example.com', name: 'Noor Haddad', role: 'EMPLOYEE' }, admin);
  const noor = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'noor-pass-1',
  })).token as string;
  await call('GET', `/api/c/${cid}/portal`, undefined, noor);
  assert.equal((await call('GET', `/api/c/${cid}/compliance/83b/iss_restricted/print`, undefined, noor)).status, 403);   // someone else's certificate
  assert.equal((await call('GET', `/api/c/${cid}/compliance/form-3921/2026/statements`, undefined, noor)).status, 403);
});

test('Form 3921 statements: one page per ISO exercise of the year, with the boxes filled', async () => {
  const grant = await call('POST', `/api/c/${cid}/awards/issue`, { stakeholderId: 'stk_priya', poolId: 'pool_1', type: 'ISO', quantity: 10_000, strikePrice: 100_000, grantDate: '2025-01-15', vestingScheduleId: immediate, approval: 'NONE', signing: null }, admin);
  assert.equal(grant.status, 200, JSON.stringify(grant.json));
  const exercised = await call('POST', `/api/c/${cid}/awards/${grant.json.award.id}/exercise`, { quantity: 4_000, exerciseDate: '2026-03-02', method: 'CASH' }, admin);
  assert.equal(exercised.status, 200, JSON.stringify(exercised.json));

  const statements = await call('GET', `/api/c/${cid}/compliance/form-3921/2026/statements`, undefined, admin);
  assert.equal(statements.status, 200, statements.text.slice(0, 200));
  assert.match(statements.text, /Form 3921 statements 2026 — Taxco/);
  assert.equal((statements.text.match(/class="sheet"/g) ?? []).length, 1);
  assert.match(statements.text, /Transferor \(corporation\)<\/th><td>Taxco, Inc\./);
  assert.match(statements.text, /Transferor EIN<\/th><td>87-4410293/);
  assert.match(statements.text, /Employee<\/th><td>Priya Raman/);
  assert.match(statements.text, /Box 1 · Date option granted<\/th><td>2025-01-15/);
  assert.match(statements.text, /Box 2 · Date option exercised<\/th><td>2026-03-02/);
  assert.match(statements.text, /Box 3 · Exercise price per share<\/th><td>\$0\.10/);
  assert.match(statements.text, /Box 4 · Fair market value per share on exercise date<\/th><td>\$0\.25/);
  assert.match(statements.text, /Box 5 · Number of shares transferred<\/th><td>4,000/);
  assert.match(statements.text, /Spread at exercise .*<\/th><td>\$600\.00/);
  assert.equal((await call('GET', `/api/c/${cid}/compliance/form-3921/2026/statements?stakeholderId=stk_noor`, undefined, admin)).status, 404);
  assert.equal((await call('GET', `/api/c/${cid}/compliance/form-3921/2019/statements`, undefined, admin)).status, 404);
  assert.equal((await call('GET', `/api/c/${cid}/compliance/form-3921/abc/statements`, undefined, admin)).status, 400);
});
