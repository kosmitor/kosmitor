/**
 * Paperwork filed against one instrument.
 *
 * The same route serves a certificate, an option grant, a SAFE and a warrant,
 * because they are all just a security id on a document row. What has to hold is
 * that an id from another company is refused, that a document reaches the
 * instrument it was filed against and no other, and that a holder sees what was
 * filed against them without seeing what was not.
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
await import('../src/routes/workflows.ts');
await import('../src/routes/files.ts');
await import('../src/routes/security-documents.ts');

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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
async function attach(cid: string, query: Record<string, string>, token: string) {
  const res = await fetch(`${base}/api/c/${cid}/documents/upload?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    body: new Uint8Array(PDF) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Filing Co' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const schedule = (await call('GET', `/api/c/${cid}/vesting-schedules`, undefined, admin)).json[0];
const priya = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;
const fund = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Kestrel Ventures', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
const pool = (await call('POST', `/api/c/${cid}/pools`, { name: 'Plan 2024', shareClassId: common.id, authorized: 500_000 }, admin)).json;

const certificate = (await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: priya.id, shareClassId: common.id, quantity: 10_000, issueDate: '2024-01-01' }, admin)).json;
const award = (await call('POST', `/api/c/${cid}/awards`, { stakeholderId: priya.id, poolId: pool.id, type: 'ISO', quantity: 5_000, strikePrice: 10_000, grantDate: '2024-02-01', vestingScheduleId: schedule.id }, admin)).json;
const safe = (await call('POST', `/api/c/${cid}/convertibles`, { stakeholderId: fund.id, instrument: 'SAFE_POST', principal: 50_000_00, issueDate: '2024-03-01' }, admin)).json;
const warrant = (await call('POST', `/api/c/${cid}/warrants`, { stakeholderId: fund.id, shareClassId: common.id, quantity: 2_000, issueDate: '2024-04-01' }, admin)).json;

test('all four kinds of holding accept a document, and each keeps its own', async () => {
  const filings: [string, string, string][] = [
    [certificate.id, 'Signed certificate CS-1', 'issuances'],
    [award.id, 'ISO grant agreement', 'awards'],
    [safe.id, 'SAFE, post-money', 'convertibles'],
    [warrant.id, 'Warrant to purchase common', 'warrants'],
  ];
  for (const [securityId, title] of filings) {
    const up = await attach(cid, { name: `${title}.pdf`, title, category: 'AGREEMENT', securityId, stakeholderId: priya.id, visibility: 'HOLDER' }, admin);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.equal(up.json.securityId, securityId);
  }

  for (const [securityId, title, kind] of filings) {
    const listed = await call('GET', `/api/c/${cid}/securities/${securityId}/documents`, undefined, admin);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.kind, kind, 'the route reports which kind of holding this is');
    assert.deepEqual(listed.json.documents.map((d: any) => d.name), [title], 'and only its own paperwork');
  }
});

test('an id that is not a holding of this company is refused', async () => {
  const bogus = await call('GET', `/api/c/${cid}/securities/iss_elsewhere/documents`, undefined, admin);
  assert.equal(bogus.status, 404);

  const otherCompany = (await call('POST', '/api/companies', { name: 'Somewhere Else' }, admin)).json.id as string;
  const leak = await call('GET', `/api/c/${otherCompany}/securities/${certificate.id}/documents`, undefined, admin);
  assert.equal(leak.status, 404, 'a real id, but not of this company');
});

test('a holder sees what was filed against them and not what was not', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE', stakeholderId: priya.id }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const holder = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).json.token as string;

  const theirs = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, holder);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.json));
  assert.deepEqual(theirs.json.documents.map((d: any) => d.name), ['Signed certificate CS-1']);

  // Filed against the same certificate but kept back from the holder.
  await attach(cid, { name: 'internal-memo.pdf', title: 'Board memo', category: 'BOARD', securityId: certificate.id, visibility: 'ADMIN' }, admin);
  const again = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, holder);
  assert.deepEqual(again.json.documents.map((d: any) => d.name), ['Signed certificate CS-1'], 'the memo stays back');

  const asAdmin = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, admin);
  assert.equal(asAdmin.json.documents.length, 2, 'while the company sees both');
});

test('an attachment is removed the same way any document is', async () => {
  const listed = await call('GET', `/api/c/${cid}/securities/${warrant.id}/documents`, undefined, admin);
  const doc = listed.json.documents[0];
  const gone = await call('DELETE', `/api/c/${cid}/documents/${doc.id}`, undefined, admin);
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  const after_ = await call('GET', `/api/c/${cid}/securities/${warrant.id}/documents`, undefined, admin);
  assert.deepEqual(after_.json.documents, []);
});
