/**
 * Paperwork filed against compliance work.
 *
 * Two anchors, and which one applies depends on whether there is a record. An
 * 83(b) election belongs to a certificate and a Form 3921 line to a grant, so
 * those attach to the instrument. The $100,000 test and the Rule 701 test are
 * computed from the cap table each time they are asked for, so their paperwork
 * attaches to a named subject and a reference instead. The reference is matched
 * exactly, which is the thing most likely to go wrong and the thing pinned here.
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
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const PDF = Buffer.from('%PDF-1.4\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
async function attach(cid: string, query: Record<string, string>, token: string) {
  const res = await fetch(`${base}/api/c/${cid}/documents/upload?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    body: new Uint8Array(PDF) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
const listSubject = (cid: string, kind: string, ref: string, token: string) =>
  call('GET', `/api/c/${cid}/compliance-documents?${new URLSearchParams({ kind, ref })}`, undefined, token);

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Compliance Co' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const priya = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;

test('a compliance subject holds its paperwork, and each reference keeps its own', async () => {
  const up = await attach(cid, {
    name: 'iso-100k-2025-priya.pdf', title: '$100,000 test working', category: 'TAX',
    subjectKind: 'ISO_100K', subjectRef: `${priya.id}:2025`,
  }, admin);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.subjectKind, 'ISO_100K');
  assert.equal(up.json.subjectRef, `${priya.id}:2025`);

  const found = await listSubject(cid, 'ISO_100K', `${priya.id}:2025`, admin);
  assert.equal(found.status, 200, JSON.stringify(found.json));
  assert.deepEqual(found.json.documents.map((d: any) => d.name), ['$100,000 test working']);

  // The same holder, a different year: a different subject entirely.
  const otherYear = await listSubject(cid, 'ISO_100K', `${priya.id}:2024`, admin);
  assert.deepEqual(otherYear.json.documents, [], 'the reference is matched exactly, not loosely');
});

test('each of the five subjects is its own drawer', async () => {
  const filings: [string, string, string][] = [
    ['RULE_701', '2025-01-01:2025-12-31', 'Rule 701 disclosure package'],
    ['BOI', 'fil_abc123', 'BOI confirmation'],
    ['ELECTION_83B', 'iss_xyz', '83(b) as filed'],
    ['FORM_3921', '2025', 'Form 3921 transmittal'],
  ];
  for (const [kind, ref, title] of filings) {
    const up = await attach(cid, { name: `${kind}.pdf`, title, category: 'TAX', subjectKind: kind, subjectRef: ref }, admin);
    assert.equal(up.status, 200, `${kind}: ${JSON.stringify(up.json)}`);
  }
  for (const [kind, ref, title] of filings) {
    const listed = await listSubject(cid, kind, ref, admin);
    assert.deepEqual(listed.json.documents.map((d: any) => d.name), [title], kind);
  }
  // And none of them leaked into the $100,000 test's drawer.
  const iso = await listSubject(cid, 'ISO_100K', `${priya.id}:2025`, admin);
  assert.equal(iso.json.documents.length, 1);
});

test('a subject this app does not file against is refused, on both routes', async () => {
  const listed = await listSubject(cid, 'SOMETHING_ELSE', '2025', admin);
  assert.equal(listed.status, 400);
  assert.match(listed.json.error, /compliance subject/);

  const up = await attach(cid, { name: 'x.pdf', category: 'TAX', subjectKind: 'SOMETHING_ELSE', subjectRef: '2025' }, admin);
  assert.equal(up.status, 400);
  assert.match(up.json.error, /compliance subject/);
});

test('half a subject files nothing, so it is refused rather than silently dropped', async () => {
  const noRef = await attach(cid, { name: 'x.pdf', category: 'TAX', subjectKind: 'RULE_701' }, admin);
  assert.equal(noRef.status, 400);
  assert.match(noRef.json.error, /both a kind and a reference/);

  const noKind = await attach(cid, { name: 'x.pdf', category: 'TAX', subjectRef: '2025' }, admin);
  assert.equal(noKind.status, 400);
  assert.match(noKind.json.error, /both a kind and a reference/);
});

test('where a record exists the paperwork goes on the record, not on a subject', async () => {
  const certificate = (await call('POST', `/api/c/${cid}/issuances`, {
    certificateNo: 'CS-1', stakeholderId: priya.id, shareClassId: common.id, quantity: 1000, issueDate: '2025-01-05',
  }, admin)).json;

  const up = await attach(cid, {
    name: '83b-as-filed.pdf', title: '83(b) as filed', category: 'TAX',
    securityId: certificate.id, stakeholderId: priya.id, visibility: 'HOLDER',
  }, admin);
  assert.equal(up.status, 200, JSON.stringify(up.json));

  const onTheRecord = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, admin);
  assert.deepEqual(onTheRecord.json.documents.map((d: any) => d.name), ['83(b) as filed']);
  assert.equal(onTheRecord.json.kind, 'issuances');
});

test('a holder sees compliance paperwork meant for them and not the rest', async () => {
  await attach(cid, { name: 'internal.pdf', title: 'Internal working note', category: 'TAX', subjectKind: 'RULE_701', subjectRef: '2025-01-01:2025-12-31' }, admin);
  await attach(cid, { name: 'shared.pdf', title: 'Published to everyone', category: 'TAX', subjectKind: 'RULE_701', subjectRef: '2025-01-01:2025-12-31', visibility: 'ALL' }, admin);

  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE', stakeholderId: priya.id }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const holder = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).token as string;

  const theirs = await listSubject(cid, 'RULE_701', '2025-01-01:2025-12-31', holder);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.json));
  assert.deepEqual(theirs.json.documents.map((d: any) => d.name), ['Published to everyone']);

  const asAdmin = await listSubject(cid, 'RULE_701', '2025-01-01:2025-12-31', admin);
  assert.equal(asAdmin.json.documents.length, 3, 'the company sees the working notes too');
});
