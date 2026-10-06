/**
 * The report behind a valuation: a document in the vault or a link, one or the
 * other. Pinned here: nobody can point a valuation at another company's
 * document or reach another company's valuation, a link that would run script is
 * refused, deleting the document leaves the valuation with no report rather than
 * a broken one, and only editors can change it.
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
await import('../src/routes/workflows.ts');
await import('../src/routes/instrument-detail.ts');
await import('../src/routes/valuation-report.ts');

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
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, token: sessionCookie(res) };
}

async function upload(cid: string, token: string, name: string) {
  const res = await fetch(`${base}/api/c/${cid}/documents/upload?name=${encodeURIComponent(name)}&category=VALUATION&folder=Valuations`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf', Authorization: `Bearer ${token}` },
    body: Buffer.from('%PDF-1.4\n%fake appraisal\n'),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { id: string; name: string };
}

const admin = (await call('POST', '/api/auth/register', { email: 'morgan@example.com', name: 'Morgan Hale', password: 'morgan-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Tidewater Labs' }, admin)).json.id as string;
const other = (await call('POST', '/api/companies', { name: 'Elsewhere Works' }, admin)).json.id as string;
const valuation = (await call('POST', `/api/c/${cid}/valuations`, {
  type: '409A', fairMarketValue: 420_000, effectiveDate: '2026-01-15', status: 'ACTIVE', provider: 'Harbor Appraisal Partners',
}, admin)).json;
const theirs = (await call('POST', `/api/c/${other}/valuations`, { type: '409A', fairMarketValue: 100_000, effectiveDate: '2026-01-15', status: 'ACTIVE' }, admin)).json;

test('a valuation starts with no report, and a document from the vault becomes it', async () => {
  const before = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/detail`, undefined, admin);
  assert.equal(before.status, 200, JSON.stringify(before.json));
  assert.equal(before.json.reportDocument, null);

  const doc = await upload(cid, admin, '2026 409A report.pdf');
  const set = await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { documentId: doc.id }, admin);
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.document.id, doc.id);
  assert.equal(set.json.document.fileName, '2026 409A report.pdf');
  assert.equal(set.json.url, null);

  const detail = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/detail`, undefined, admin);
  assert.equal(detail.json.reportDocument.name, '2026 409A report.pdf');
  assert.equal(detail.json.reportDocument.body, undefined, 'the page is told whether there is a body, not sent it');
  const listed = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/report`, undefined, admin);
  assert.equal(listed.json.document.id, doc.id);
});

test('a link replaces the document, and a link that would run script is refused', async () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not a link', 'ftp://example.com/report.pdf']) {
    const r = await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { url: bad }, admin);
    assert.equal(r.status, 400, `accepted ${bad}`);
  }
  const viaForm = await call('PATCH', `/api/c/${cid}/valuations/${valuation.id}`, { reportUrl: 'javascript:alert(1)' }, admin);
  assert.equal(viaForm.status, 400, 'the valuation form checks the link the same way');

  const link = await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { url: 'https://reports.example.com/tidewater/2026' }, admin);
  assert.equal(link.status, 200, JSON.stringify(link.json));
  assert.equal(link.json.url, 'https://reports.example.com/tidewater/2026');
  assert.equal(link.json.document, null, 'one or the other, never both');

  const both = await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { url: 'https://example.com/a', documentId: 'doc_x' }, admin);
  assert.equal(both.status, 400);

  const cleared = await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, {}, admin);
  assert.equal(cleared.status, 200);
  assert.deepEqual([cleared.json.document, cleared.json.url], [null, null]);
});

test('another company’s document cannot be the report, and another company’s valuation cannot be reached', async () => {
  const foreign = await upload(other, admin, 'Their report.pdf');
  const crossed = await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { documentId: foreign.id }, admin);
  assert.equal(crossed.status, 400);
  assert.match(crossed.json.error, /not in this company/);

  const reached = await call('PUT', `/api/c/${cid}/valuations/${theirs.id}/report`, { url: 'https://example.com/r' }, admin);
  assert.equal(reached.status, 404, 'knowing an id is not permission');
  const still = await call('GET', `/api/c/${other}/valuations/${theirs.id}/report`, undefined, admin);
  assert.equal(still.json.url, null, 'untouched');
});

test('deleting the document leaves the valuation with no report', async () => {
  const doc = await upload(cid, admin, 'Short-lived report.pdf');
  await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { documentId: doc.id }, admin);
  const gone = await call('DELETE', `/api/c/${cid}/documents/${doc.id}`, undefined, admin);
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  const after = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/detail`, undefined, admin);
  assert.equal(after.status, 200);
  assert.equal(after.json.reportDocument, null);
  assert.equal(after.json.valuation.reportDocumentId, null);
});

test('a board member reads the report but cannot change it, and an employee reaches neither', async () => {
  const doc = await upload(cid, admin, 'Board copy.pdf');
  await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { documentId: doc.id }, admin);

  const signIn = async (email: string, name: string, role: string, password: string) => {
    const member = await call('POST', `/api/c/${cid}/members`, { email, name, role }, admin);
    const link = await call('POST', `/api/c/${cid}/members/${member.json.id}/reset-password`, { mode: 'link' }, admin);
    const token = new URL(link.json.resetUrl).searchParams.get('token')!;
    return (await call('POST', '/api/auth/reset', { token, password })).token as string;
  };
  const director = await signIn('dana@example.com', 'Dana Wu', 'BOARD', 'dana-pass-1');
  assert.equal((await call('GET', `/api/c/${cid}/valuations/${valuation.id}/report`, undefined, director)).json.document.id, doc.id);
  assert.equal((await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, {}, director)).status, 403);

  const employee = await signIn('eli@example.com', 'Eli Park', 'EMPLOYEE', 'eli-pass-12');
  assert.equal((await call('GET', `/api/c/${cid}/valuations/${valuation.id}/report`, undefined, employee)).status, 403);
  assert.equal((await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, {}, employee)).status, 403);
});

test('a viewer learns a report is on file, and nothing the vault keeps from them', async () => {
  const doc = await upload(cid, admin, 'Restricted appraisal.pdf');
  await call('PUT', `/api/c/${cid}/valuations/${valuation.id}/report`, { documentId: doc.id }, admin);
  const member = await call('POST', `/api/c/${cid}/members`, { email: 'vic@example.com', name: 'Vic Lane', role: 'VIEWER' }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${member.json.id}/reset-password`, { mode: 'link' }, admin);
  const viewer = (await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: 'vic-pass-123' })).token as string;

  const detail = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/detail`, undefined, viewer);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.reportDocument.restricted, true);
  assert.equal(detail.json.reportDocument.name, '');
  assert.equal(detail.json.reportDocument.fileName, null);
  assert.ok(!JSON.stringify(detail.json).includes('Restricted appraisal'), 'not even its name');
  assert.equal(detail.json.documents.length, 0, 'admin-only valuation paperwork is not listed for a viewer');

  const listed = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/report`, undefined, viewer);
  assert.equal(listed.json.document.restricted, true);

  const own = await call('GET', `/api/c/${cid}/valuations/${valuation.id}/detail`, undefined, admin);
  assert.equal(own.json.reportDocument.name, 'Restricted appraisal.pdf', 'an administrator sees it in full');
  assert.ok(own.json.documents.every((d: any) => d.body === undefined), 'bodies stay on the server');
});
