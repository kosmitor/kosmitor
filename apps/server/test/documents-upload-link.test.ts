/**
 * A PDF kept as a document over HTTP: the bytes are stored untouched and linked
 * to a stakeholder and one of their instruments, the holder can see it when
 * the visibility says so, foreign instruments are refused, and the table
 * importer refuses PDFs with a pointer to this path.
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
await import('../src/routes/workflows.ts');
await import('../src/routes/files.ts');
await import('../src/routes/imports.ts');
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
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
async function upload(query: Record<string, string>, token: string, body: Buffer = PDF) {
  const res = await fetch(`${base}/api/c/${cid}/documents/upload?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: new Uint8Array(body) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Files Co' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insertSecurity('issuances', { id: 'iss_7', companyId: cid, certificateNo: 'CS-7', stakeholderId: 'stk_priya', shareClassId: common, quantity: 25_000, pricePerShare: 10_000, issueDate: '2024-01-15', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });

test('a PDF is stored byte for byte and linked to a stakeholder and their certificate', async () => {
  const r = await upload({ name: 'signed-cs-7.pdf', title: 'Signed certificate CS-7', category: 'AGREEMENT', folder: 'Certificates', stakeholderId: 'stk_priya', securityId: 'iss_7', visibility: 'HOLDER' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.name, r.json.category, r.json.folder, r.json.stakeholderId, r.json.securityId, r.json.visibility, r.json.fileName, r.json.mimeType],
    ['Signed certificate CS-7', 'AGREEMENT', 'Certificates', 'stk_priya', 'iss_7', 'HOLDER', 'signed-cs-7.pdf', 'application/pdf']);
  assert.equal(Number(r.json.sizeBytes), PDF.length);

  const back = await fetch(`${base}/api/c/${cid}/documents/${r.json.id}/download`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(back.status, 200);
  assert.ok(Buffer.from(await back.arrayBuffer()).equals(PDF), 'the download is the exact upload');
});

test('the visibility the holder is given lets them see it in their own documents', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const priya = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).token as string;
  const docs = await call('GET', `/api/c/${cid}/documents`, undefined, priya);
  assert.equal(docs.status, 200);
  assert.ok(docs.json.some((d: any) => d.name === 'Signed certificate CS-7'), 'the linked holder sees the document');

  const adminOnly = await upload({ name: 'internal.pdf', category: 'BOARD', securityId: '', visibility: 'ADMIN' }, admin);
  assert.equal(adminOnly.json.visibility, 'ADMIN');
  const again = await call('GET', `/api/c/${cid}/documents`, undefined, priya);
  assert.ok(!again.json.some((d: any) => d.name === 'internal.pdf'), 'administrator-only documents stay hidden from the holder');
});

test('guards: an instrument from elsewhere is refused, holder visibility needs a holder, and the table importer redirects PDFs here', async () => {
  const foreign = await upload({ name: 'x.pdf', category: 'AGREEMENT', securityId: 'iss_elsewhere', visibility: 'ADMIN' }, admin);
  assert.equal(foreign.status, 400);
  assert.match(foreign.json.error, /does not belong/);
  const orphanHolder = await upload({ name: 'y.pdf', category: 'AGREEMENT', visibility: 'HOLDER' }, admin);
  assert.equal(orphanHolder.status, 200);
  assert.equal(orphanHolder.json.visibility, 'ADMIN', 'holder visibility without a holder falls back to administrators');

  const parse = await fetch(`${base}/api/c/${cid}/imports/parse?name=table.pdf`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/pdf' }, body: new Uint8Array(PDF) as unknown as RequestInit['body'],
  });
  assert.equal(parse.status, 400);
  assert.match(((await parse.json()) as any).error, /stored as documents/);
});
