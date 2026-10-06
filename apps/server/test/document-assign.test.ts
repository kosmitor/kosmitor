/**
 * Filing an existing document against a holding, and the company boundary.
 *
 * The update route matches a document by id alone when it writes, so the id has
 * to be confirmed as this company's first. Without that check an administrator
 * of one company could rename, reclassify or refile another company's paperwork
 * by knowing its id, and knowing an id is not permission.
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
await import('../src/routes/workflows.ts');
await import('../src/routes/files.ts');
await import('../src/routes/security-documents.ts');
await import('../src/routes/instrument-detail.ts');
const { one, run } = await import('../src/db.ts');

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
async function upload(cid: string, query: Record<string, string>, token: string) {
  const res = await fetch(`${base}/api/c/${cid}/documents/upload?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    body: new Uint8Array(PDF) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Filing Co' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const priya = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;
const certificate = (await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-2', stakeholderId: priya.id, shareClassId: common.id, quantity: 1_000_000, issueDate: '2023-04-11' }, admin)).json;

test('a document already in the vault can be filed against a certificate', async () => {
  const loose = await upload(cid, { name: 'cs-2-signed.pdf', title: 'CS-2 signed certificate', category: 'OTHER', folder: 'Inbox' }, admin);
  assert.equal(loose.status, 200, JSON.stringify(loose.json));
  assert.equal(loose.json.securityId, null, 'filed against nothing to begin with');

  const filed = await call('PATCH', `/api/c/${cid}/documents/${loose.json.id}`,
    { securityId: certificate.id, category: 'CERTIFICATE' }, admin);
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  assert.equal(filed.json.securityId, certificate.id);
  assert.equal(filed.json.category, 'CERTIFICATE');

  const detail = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, admin);
  assert.deepEqual(detail.json.documents.map((d: any) => d.name), ['CS-2 signed certificate']);
});

test('removing it unfiles the document rather than destroying it', async () => {
  const listed = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, admin);
  const doc = listed.json.documents[0];

  const unfiled = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { securityId: null }, admin);
  assert.equal(unfiled.status, 200, JSON.stringify(unfiled.json));
  assert.equal(unfiled.json.securityId, null);

  const gone = await call('GET', `/api/c/${cid}/securities/${certificate.id}/documents`, undefined, admin);
  assert.deepEqual(gone.json.documents, [], 'off the certificate');
  const still = await one<{ id: string }>('SELECT id FROM documents WHERE id = ?', doc.id);
  assert.ok(still, 'but still in the vault');
});

test('an instrument from another company is refused', async () => {
  const doc = (await upload(cid, { name: 'x.pdf', title: 'Loose paper', category: 'OTHER' }, admin)).json;
  const elsewhere = (await call('POST', '/api/companies', { name: 'Somewhere Else' }, admin)).json.id as string;
  const theirClasses = (await call('GET', `/api/c/${elsewhere}/share-classes`, undefined, admin)).json;
  const theirHolder = (await call('POST', `/api/c/${elsewhere}/stakeholders`, { name: 'Someone', type: 'INDIVIDUAL', relation: 'OTHER' }, admin)).json;
  const theirCertificate = (await call('POST', `/api/c/${elsewhere}/issuances`, {
    certificateNo: 'X-1', stakeholderId: theirHolder.id, shareClassId: theirClasses[0].id, quantity: 10, issueDate: '2024-01-01',
  }, admin)).json;

  const crossed = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { securityId: theirCertificate.id }, admin);
  assert.equal(crossed.status, 400);
  assert.match(crossed.json.error, /does not belong/);
});

test('a document belonging to another company cannot be touched through this one', async () => {
  const elsewhere = (await call('POST', '/api/companies', { name: 'Third Co' }, admin)).json.id as string;
  const theirs = (await upload(elsewhere, { name: 'private.pdf', title: 'Their private paper', category: 'BOARD' }, admin)).json;

  // Same administrator, but acting through a company that does not own the document.
  const reach = await call('PATCH', `/api/c/${cid}/documents/${theirs.id}`, { name: 'Renamed from outside' }, admin);
  assert.equal(reach.status, 404, 'knowing an id is not permission');

  const unchanged = await one<{ name: string }>('SELECT name FROM documents WHERE id = ?', theirs.id);
  assert.equal(unchanged!.name, 'Their private paper');
});

test('a compliance subject can be set the same way, and needs both halves', async () => {
  const doc = (await upload(cid, { name: 'memo.pdf', title: 'Adviser memo', category: 'TAX' }, admin)).json;

  const filed = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { subjectKind: 'RULE_701', subjectRef: '2026' }, admin);
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  const listed = await call('GET', `/api/c/${cid}/compliance-documents?kind=RULE_701&ref=2026`, undefined, admin);
  assert.deepEqual(listed.json.documents.map((d: any) => d.name), ['Adviser memo']);

  const half = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { subjectKind: 'ISO_100K' }, admin);
  assert.equal(half.status, 400);
  assert.match(half.json.error, /both a kind and a reference/);
});

test('a signed copy of a document the app generates can be uploaded back against it', async () => {
  // The certificate category is written by the issuing flow, so the upload route
  // has to accept it: this is the paper coming back from the printer, scanned.
  const scan = await upload(cid, {
    name: 'cs-2-wet-signed.pdf', title: 'CS-2 as signed', category: 'CERTIFICATE',
    folder: 'Certificates', securityId: certificate.id,
  }, admin);
  assert.equal(scan.status, 200, JSON.stringify(scan.json));
  assert.equal(scan.json.category, 'CERTIFICATE');
  assert.equal(scan.json.securityId, certificate.id);

  for (const category of ['GRANT_AGREEMENT', 'CONVERTIBLE_AGREEMENT']) {
    const other = await upload(cid, { name: `${category}.pdf`, category }, admin);
    assert.equal(other.status, 200, `${category}: ${JSON.stringify(other.json)}`);
  }
});

test('a category the app does not know is refused on every route that sets one', async () => {
  const uploaded = await upload(cid, { name: 'x.pdf', category: 'SOMETHING_MADE_UP' }, admin);
  assert.equal(uploaded.status, 400);
  assert.match(uploaded.json.error, /valid document category/);

  const created = await call('POST', `/api/c/${cid}/documents`, { name: 'Hand-filed note', category: 'SOMETHING_MADE_UP' }, admin);
  assert.equal(created.status, 400);
  assert.match(created.json.error, /valid document category/);

  const real = (await call('POST', `/api/c/${cid}/documents`, { name: 'Hand-filed note' }, admin)).json;
  assert.equal(real.category, 'OTHER', 'and an unstated category still falls back');
  const edited = await call('PATCH', `/api/c/${cid}/documents/${real.id}`, { category: 'SOMETHING_MADE_UP' }, admin);
  assert.equal(edited.status, 400);
  assert.match(edited.json.error, /valid document category/);
});

test('an award agreement uploaded against a grant is what the grant record reads', async () => {
  const pool = (await call('POST', `/api/c/${cid}/pools`, { name: '2024 Stock Plan', shareClassId: common.id, authorized: 1_000_000 }, admin)).json;
  const schedule = (await call('GET', `/api/c/${cid}/vesting-schedules`, undefined, admin)).json[0];
  const award = (await call('POST', `/api/c/${cid}/awards`, {
    label: 'OPT-9', stakeholderId: priya.id, poolId: pool.id, type: 'ISO', quantity: 1000,
    strikePrice: 100_000, grantDate: '2024-03-01', vestingScheduleId: schedule.id,
  }, admin)).json;
  assert.ok(award.id, JSON.stringify(award));

  const up = await upload(cid, {
    name: 'opt-9-signed.pdf', title: 'OPT-9 as signed', category: 'GRANT_AGREEMENT',
    folder: 'Equity awards', securityId: award.id, stakeholderId: priya.id, visibility: 'HOLDER',
  }, admin);
  assert.equal(up.status, 200, JSON.stringify(up.json));

  const detail = await call('GET', `/api/c/${cid}/awards/${award.id}/detail`, undefined, admin);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  const agreement = detail.json.documents.find((d: any) => d.category === 'GRANT_AGREEMENT');
  assert.equal(agreement?.name, 'OPT-9 as signed');
});

test('a document out for signature stays put until every party has signed', async () => {
  const inFlight = (await call('POST', `/api/c/${cid}/documents`, {
    name: 'Stock power awaiting signature', category: 'AGREEMENT', securityId: certificate.id,
    requiresSignature: true, signers: [{ name: 'Priya Raman', stakeholderId: priya.id }],
  }, admin)).json;
  assert.equal(inFlight.status, 'AWAITING_SIGNATURE');

  // Moving it or changing what it is would strand the pending signature blocks.
  const moved = await call('PATCH', `/api/c/${cid}/documents/${inFlight.id}`, { securityId: null }, admin);
  assert.equal(moved.status, 400);
  assert.match(moved.json.error, /out for signature/);
  const reclassified = await call('PATCH', `/api/c/${cid}/documents/${inFlight.id}`, { category: 'OTHER' }, admin);
  assert.equal(reclassified.status, 400);

  // Renaming and refiling it into another folder are not what signing depends on.
  const renamed = await call('PATCH', `/api/c/${cid}/documents/${inFlight.id}`, { name: 'Stock power, Priya', folder: 'Signing' }, admin);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  // Sending back the holding and category it already has is not a move.
  const same = await call('PATCH', `/api/c/${cid}/documents/${inFlight.id}`, { securityId: certificate.id, category: 'AGREEMENT' }, admin);
  assert.equal(same.status, 200, JSON.stringify(same.json));

  // Once signed it is an ordinary document again.
  await run("UPDATE signatures SET status = 'SIGNED' WHERE document_id = ?", inFlight.id);
  const freed = await call('PATCH', `/api/c/${cid}/documents/${inFlight.id}`, { securityId: null }, admin);
  assert.equal(freed.status, 200, JSON.stringify(freed.json));
});

test('a document cannot be created against another company\'s holder or holding', async () => {
  const elsewhere = (await call('POST', '/api/companies', { name: 'Fourth Co' }, admin)).json.id as string;
  const theirClass = (await call('GET', `/api/c/${elsewhere}/share-classes`, undefined, admin)).json[0];
  const theirHolder = (await call('POST', `/api/c/${elsewhere}/stakeholders`, { name: 'Someone Else', type: 'INDIVIDUAL', relation: 'OTHER' }, admin)).json;
  const theirShares = (await call('POST', `/api/c/${elsewhere}/issuances`, {
    certificateNo: 'Y-1', stakeholderId: theirHolder.id, shareClassId: theirClass.id, quantity: 10, issueDate: '2024-01-01',
  }, admin)).json;

  const onTheirHolding = await call('POST', `/api/c/${cid}/documents`, { name: 'Filed across', securityId: theirShares.id }, admin);
  assert.equal(onTheirHolding.status, 400);
  assert.match(onTheirHolding.json.error, /instrument does not belong/);

  const onTheirHolder = await call('POST', `/api/c/${cid}/documents`, { name: 'Filed across', stakeholderId: theirHolder.id }, admin);
  assert.equal(onTheirHolder.status, 400);
  assert.match(onTheirHolder.json.error, /stakeholder does not belong/);
});

test('editing a document refuses another company\'s holder, and a status or visibility the app does not use', async () => {
  const elsewhere = (await call('POST', '/api/companies', { name: 'Fifth Co' }, admin)).json.id as string;
  const theirHolder = (await call('POST', `/api/c/${elsewhere}/stakeholders`, { name: 'Morgan Hale', type: 'INDIVIDUAL', relation: 'OTHER' }, admin)).json;
  const doc = (await call('POST', `/api/c/${cid}/documents`, { name: 'Certificate copy', category: 'CERTIFICATE', stakeholderId: priya.id }, admin)).json;

  // The certificate email finds its recipient through the document's holder, so
  // pointing it at someone from another company would send them this company's certificate.
  const crossed = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { stakeholderId: theirHolder.id, status: 'EXECUTED' }, admin);
  assert.equal(crossed.status, 400);
  assert.match(crossed.json.error, /stakeholder does not belong/);
  const kept = await one<{ stakeholder_id: string; status: string }>('SELECT stakeholder_id, status FROM documents WHERE id = ?', doc.id);
  assert.equal(kept!.stakeholder_id, priya.id, 'the holder is unchanged');
  assert.notEqual(kept!.status, 'EXECUTED', 'and nothing else in the refused edit was written');

  const status = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { status: 'SHREDDED' }, admin);
  assert.equal(status.status, 400);
  assert.match(status.json.error, /valid document status/);
  const visibility = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { visibility: 'EVERYONE' }, admin);
  assert.equal(visibility.status, 400);
  assert.match(visibility.json.error, /who can see the document/);

  // What the app itself sends still goes through, and an empty holder unlinks the document.
  const shared = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { visibility: 'holder', stakeholderId: priya.id, status: 'FINAL' }, admin);
  assert.equal(shared.status, 200, JSON.stringify(shared.json));
  assert.equal(shared.json.visibility, 'HOLDER');
  assert.equal(shared.json.status, 'FINAL');
  const unlinked = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { stakeholderId: '' }, admin);
  assert.equal(unlinked.json.stakeholderId, null);
});
