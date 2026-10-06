/**
 * Correcting a certificate before anyone signs it.
 *
 * A certificate out for signature is still a draft: a wrong share count should be
 * fixable without cancelling it. What must hold is that the document is rewritten
 * with the corrected terms, so the record and the paperwork never disagree, and
 * that the moment somebody has signed the terms stop being editable, because
 * changing them would alter what that person put their name to.
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
const { one } = await import('../src/db.ts');

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
const cid = (await call('POST', '/api/companies', { name: 'Draft Co' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const holder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;

const issue = () => call('POST', `/api/c/${cid}/issuances/issue-for-signature`, {
  stakeholderId: holder.id, shareClassId: common.id, quantity: 10_000, pricePerShare: 10_000,
  issueDate: '2024-01-15', signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer',
}, admin);

test('a draft certificate is corrected, and its document is rewritten to match', async () => {
  const made = await issue();
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.issuance.id as string;
  assert.match(String(made.json.document.body), /10,000/, 'the document repeats the terms');

  const fixed = await call('PATCH', `/api/c/${cid}/issuances/${id}/draft`, { quantity: 12_500, pricePerShare: 20_000 }, admin);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal(fixed.json.issuance.quantity, 12_500);
  assert.equal(fixed.json.issuance.pricePerShare, 20_000);
  assert.equal(fixed.json.issuance.status, 'PENDING_SIGNATURE', 'still a draft, still out for signature');

  assert.match(String(fixed.json.document.body), /12,500/, 'the document carries the corrected count');
  assert.ok(!String(fixed.json.document.body).includes('10,000'), 'and not the old one');
});

test('the certificate number stays unique', async () => {
  const first = await issue();
  const second = await issue();
  const taken = String(first.json.issuance.certificateNo);
  const clash = await call('PATCH', `/api/c/${cid}/issuances/${second.json.issuance.id}/draft`, { certificateNo: taken }, admin);
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /already exists/);

  const fine = await call('PATCH', `/api/c/${cid}/issuances/${second.json.issuance.id}/draft`, { certificateNo: 'CS-RENAMED' }, admin);
  assert.equal(fine.status, 200, JSON.stringify(fine.json));
  assert.equal(fine.json.issuance.certificateNo, 'CS-RENAMED');
});

test('once somebody has signed, the terms stop being editable', async () => {
  const made = await issue();
  const id = made.json.issuance.id as string;
  const theirs = await one<{ id: string }>(
    'SELECT s.id FROM signatures s JOIN documents d ON d.id = s.document_id WHERE d.security_id = ? AND s.stakeholder_id IS NOT NULL', id);
  const signed = await call('POST', `/api/c/${cid}/signatures/${theirs!.id}/sign`, { typedSignature: 'Priya Raman' }, admin);
  assert.equal(signed.status, 200, JSON.stringify(signed.json));

  const late = await call('PATCH', `/api/c/${cid}/issuances/${id}/draft`, { quantity: 1 }, admin);
  assert.equal(late.status, 400);
  assert.match(late.json.error, /already signed/);
  assert.match(late.json.error, /Withdraw it and issue a new one/);

  const unchanged = await one<{ quantity: number }>('SELECT quantity FROM issuances WHERE id = ?', id);
  assert.equal(Number(unchanged!.quantity), 10_000);
});

test('a certificate that is already outstanding is not a draft', async () => {
  const plain = await call('POST', `/api/c/${cid}/issuances`, {
    certificateNo: 'CS-PLAIN', stakeholderId: holder.id, shareClassId: common.id,
    quantity: 500, issueDate: '2024-02-01',
  }, admin);
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  const r = await call('PATCH', `/api/c/${cid}/issuances/${plain.json.id}/draft`, { quantity: 600 }, admin);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /still out for signature/);

  // It is editable the ordinary way, which is what that route is for.
  const ordinary = await call('PATCH', `/api/c/${cid}/issuances/${plain.json.id}`, { quantity: 600 }, admin);
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.json));
  assert.equal(ordinary.json.quantity, 600);
});

test('the ordinary route refuses a draft rather than leaving its document behind', async () => {
  const made = await issue();
  const r = await call('PATCH', `/api/c/${cid}/issuances/${made.json.issuance.id}`, { quantity: 99 }, admin);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Edit it as a draft/);
});
