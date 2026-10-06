/**
 * Everything one certificate page needs, in one request.
 *
 * The parts worth pinning are the ones a browser must not be left to work out:
 * what these shares are worth and what fraction of the company they are, when an
 * 83(b) election was due, and who is allowed to open the record at all.
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
await import('../src/routes/certificate-detail.ts');

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
const cid = (await call('POST', '/api/companies', { name: 'Certificate Co', incorporationDate: '2022-01-01' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
await call('PATCH', `/api/c/${cid}/share-classes/${common.id}`, { legend: 'THE SECURITIES REFERENCED HEREIN HAVE NOT BEEN REGISTERED.' }, admin);
const schedule = (await call('GET', `/api/c/${cid}/vesting-schedules`, undefined, admin)).json[0];
const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Robin Vale', email: 'robin@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json;
const other = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Mira Castellanos', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;

const issued = await call('POST', `/api/c/${cid}/issuances`, {
  certificateNo: 'CS-1', stakeholderId: founder.id, shareClassId: common.id,
  quantity: 7_500_000, pricePerShare: 240_000, issueDate: '2023-04-11',
  vestingScheduleId: schedule.id, vestingStartDate: '2022-10-03',
  federalExemption: 'REG_S', issueReason: 'Original Issuance', proRata: 0,
  notes: 'Pursuant to Founder Stock Purchase Agreement dated April 11, 2023.',
}, admin);

test('the record carries the paperwork, not only the numbers', async () => {
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  const r = await call('GET', `/api/c/${cid}/issuances/${issued.json.id}/detail`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));

  assert.equal(r.json.issuance.certificateNo, 'CS-1');
  assert.equal(r.json.issuance.federalExemption, 'REG_S');
  assert.equal(r.json.issuance.issueReason, 'Original Issuance');
  assert.equal(r.json.stakeholder.name, 'Robin Vale');
  assert.equal(r.json.stakeholder.email, 'robin@example.com');
  assert.match(r.json.shareClass.legend, /NOT BEEN REGISTERED/);

  // Both dates default from the issue date rather than being left blank.
  assert.equal(r.json.issuance.holdingStartDate, '2023-04-11');
  assert.equal(r.json.issuance.rule144Date, '2023-04-11');
});

test('the money is worked out here, so the page never has to', async () => {
  const { amounts } = (await call('GET', `/api/c/${cid}/issuances/${issued.json.id}/detail`, undefined, admin)).json;
  // 7,500,000 shares at $0.24 is $1,800,000, carried as cents.
  assert.equal(amounts.capitalContribution, 180_000_000);
  assert.equal(amounts.companyFullyDiluted > 0, true);
  assert.ok(amounts.pctOfCompany > 0 && amounts.pctOfCompany <= 1, 'a fraction, never a percentage');
  assert.ok(amounts.holderFullyDilutedPct <= 1);
});

test('vesting arrives ready to draw', async () => {
  const { vesting } = (await call('GET', `/api/c/${cid}/issuances/${issued.json.id}/detail`, undefined, admin)).json;
  assert.ok(vesting, 'these shares vest');
  assert.equal(vesting.startDate, '2022-10-03');
  assert.equal(vesting.scheduleName, schedule.name);
  assert.ok(vesting.curve.length > 0);
  assert.ok(vesting.summary.vested > 0, 'granted in 2022, so some has vested by now');
});

test('the 83(b) window is dated from the transfer and flagged when it has passed', async () => {
  const { election83b } = (await call('GET', `/api/c/${cid}/issuances/${issued.json.id}/detail`, undefined, admin)).json;
  assert.equal(election83b.relevant, true, 'restricted stock is what the election is for');
  assert.equal(election83b.dueBy, '2023-05-11', 'thirty days after the transfer');
  assert.equal(election83b.filedOn, null);
  assert.equal(election83b.overdue, true);

  await call('PATCH', `/api/c/${cid}/issuances/${issued.json.id}`, { election83bFiledOn: '2023-04-28' }, admin);
  const after_ = (await call('GET', `/api/c/${cid}/issuances/${issued.json.id}/detail`, undefined, admin)).json;
  assert.equal(after_.election83b.filedOn, '2023-04-28');
  assert.equal(after_.election83b.overdue, false);
});

test('shares that never vest need no election', async () => {
  const plain = await call('POST', `/api/c/${cid}/issuances`, {
    certificateNo: 'CS-2', stakeholderId: other.id, shareClassId: common.id,
    quantity: 1000, pricePerShare: 10_000, issueDate: '2023-01-01',
  }, admin);
  const r = await call('GET', `/api/c/${cid}/issuances/${plain.json.id}/detail`, undefined, admin);
  assert.equal(r.json.election83b.relevant, false);
  assert.equal(r.json.election83b.dueBy, null);
  assert.equal(r.json.vesting, null);
});

test('a holder opens their own certificate and nobody else\'s', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'mira@example.com', name: 'Mira Castellanos', role: 'EMPLOYEE', stakeholderId: other.id }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const mira = (await call('POST', '/api/auth/reset', { token, password: 'mira-pass-123' })).json.token as string;

  const hers = (await call('GET', `/api/c/${cid}/issuances`, undefined, admin)).json.find((i: any) => i.certificateNo === 'CS-2');
  const own = await call('GET', `/api/c/${cid}/issuances/${hers.id}/detail`, undefined, mira);
  assert.equal(own.status, 200, JSON.stringify(own.json));

  const someoneElses = await call('GET', `/api/c/${cid}/issuances/${issued.json.id}/detail`, undefined, mira);
  assert.equal(someoneElses.status, 404, 'and is not told it exists');
});

test('an unknown certificate is a plain not found', async () => {
  const r = await call('GET', `/api/c/${cid}/issuances/iss_nothing/detail`, undefined, admin);
  assert.equal(r.status, 404);
});
