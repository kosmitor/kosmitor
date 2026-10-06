/**
 * The full stakeholder profile over HTTP: every field round-trips through
 * create, partial update and read; blanks clear fields; and the guards refuse
 * unknown codes, malformed emails and a departure before the start.
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

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Profile Co' }, admin)).json.id as string;

const fund = {
  name: 'Larkspur Ventures Fund II', legalName: 'Larkspur Ventures Fund II, L.P.', type: 'FUND', relation: 'INVESTOR',
  email: 'Ops@Larkspur.example', secondaryEmail: 'legal@larkspur.example', phone: '+1 415 555 0134',
  address: '1 Market Street, Suite 400', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'United States',
  startDate: '2023-05-10', taxCountry: 'US', taxState: 'CA', taxForm: 'W9', accreditedInvestor: 'YES',
  jurisdiction: 'Delaware', signatoryName: 'Dana Whitfield', signatoryTitle: 'Managing Partner', signatoryEmail: 'dana@larkspur.example',
  tags: 'seed-round, board-observer ,, lead', notes: 'Lead investor in the seed round.',
};

test('a fund with every field round-trips through create and read', async () => {
  const created = await call('POST', `/api/c/${cid}/stakeholders`, fund, admin);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const got = await call('GET', `/api/c/${cid}/stakeholders/${created.json.id}`, undefined, admin);
  const s = got.json;
  assert.equal(s.legalName, 'Larkspur Ventures Fund II, L.P.');
  assert.equal(s.email, 'ops@larkspur.example'); // stored lower-case, as invitations match
  assert.equal(s.secondaryEmail, 'legal@larkspur.example');
  assert.deepEqual([s.city, s.region, s.postalCode, s.country], ['San Francisco', 'CA', '94105', 'United States']);
  assert.deepEqual([s.taxForm, s.accreditedInvestor, s.jurisdiction], ['W9', 'YES', 'Delaware']);
  assert.deepEqual([s.signatoryName, s.signatoryTitle, s.signatoryEmail], ['Dana Whitfield', 'Managing Partner', 'dana@larkspur.example']);
  assert.equal(s.tags, 'seed-round, board-observer, lead'); // tidied
  assert.equal(s.employmentType, null);
});

test('a person is edited field by field: partial updates keep the rest, blanks clear', async () => {
  const created = await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', type: 'INDIVIDUAL', relation: 'EMPLOYEE', email: 'priya@example.com', startDate: '2024-06-01', title: 'Engineer' }, admin);
  const id = created.json.id as string;

  const employment = await call('PATCH', `/api/c/${cid}/stakeholders/${id}`, { employeeId: 'E-0042', employmentType: 'FULL_TIME', department: 'Platform', taxForm: 'W9' }, admin);
  assert.equal(employment.status, 200, JSON.stringify(employment.json));
  assert.deepEqual([employment.json.employeeId, employment.json.employmentType, employment.json.department, employment.json.title], ['E-0042', 'FULL_TIME', 'Platform', 'Engineer']);

  const departure = await call('PATCH', `/api/c/${cid}/stakeholders/${id}`, { terminationDate: '2026-03-31', terminationReason: 'VOLUNTARY' }, admin);
  assert.deepEqual([departure.json.terminationDate, departure.json.terminationReason], ['2026-03-31', 'VOLUNTARY']);

  const cleared = await call('PATCH', `/api/c/${cid}/stakeholders/${id}`, { department: '', terminationDate: null }, admin);
  assert.equal(cleared.json.department, null);
  assert.equal(cleared.json.terminationDate, null);
  assert.equal(cleared.json.terminationReason, null, 'a reason without a departure is dropped');
  assert.equal(cleared.json.employeeId, 'E-0042', 'untouched fields stay');
});

test('the guards refuse unknown codes, malformed emails and a departure before the start', async () => {
  const created = await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Theo Lindqvist', type: 'INDIVIDUAL', relation: 'FOUNDER', startDate: '2022-03-08' }, admin);
  const id = created.json.id as string;
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ employmentType: 'GIG' }, /Employment type/],
    [{ terminationDate: '2026-01-01', terminationReason: 'BORED' }, /Termination reason/],
    [{ taxForm: 'W2' }, /Tax form/],
    [{ accreditedInvestor: 'MAYBE' }, /Accredited/],
    [{ type: 'ROBOT' }, /individual, entity, fund or trust/],
    [{ relation: 'FRIEND' }, /relationship/],
    [{ signatoryEmail: 'not-an-email' }, /Signatory email/],
    [{ terminationDate: '2021-12-31' }, /before the start/],
  ];
  for (const [body, message] of cases) {
    const r = await call('PATCH', `/api/c/${cid}/stakeholders/${id}`, body, admin);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
    assert.match(r.json.error, message);
  }
});
