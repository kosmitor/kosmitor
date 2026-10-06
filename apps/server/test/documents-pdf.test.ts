/**
 * A signed document as a PDF over HTTP: the file carries the text and the
 * signature record, a holder may fetch their own but not someone else's, and
 * uploaded files without text are refused with a pointer to the download.
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
await import('../src/routes/certificates.ts');
const { insert } = await import('../src/db.ts');
const { documentPdf } = await import('../src/pdf-writer.ts');

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
async function download(path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition') ?? '', body: Buffer.from(await res.arrayBuffer()) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Docs Co', legalName: 'Docs Co, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insert('stakeholders', { id: 'stk_theo', companyId: cid, name: 'Theo Lindqvist', email: 'theo@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', createdAt: now });
const body = ['STOCK OPTION AGREEMENT', '', 'Docs Co, Inc. (the "Company") grants Priya Raman an option to purchase 10,000 shares of Common Stock at $0.50 per share.',
  'Vesting: 25% after twelve months, then monthly over the following thirty-six months, subject to continued service.',
  '', 'IN WITNESS WHEREOF, the parties have executed this agreement as of the date set out below.'].join('\n');
await insert('documents', { id: 'doc_opt', companyId: cid, name: 'Option agreement OPT-7', category: 'GRANT_AGREEMENT', visibility: 'HOLDER', stakeholderId: 'stk_priya',
  body, status: 'EXECUTED', requiresSignature: 1, createdAt: now });
await insert('signatures', { id: 'sig_co', companyId: cid, documentId: 'doc_opt', stakeholderId: null, signerName: 'Avery Stone', signerEmail: 'avery@example.com',
  status: 'SIGNED', typedSignature: 'Avery Stone', signedAt: '2026-09-22T12:16:00.000Z', ipAddress: '203.0.113.7', token: 'tok_co', createdAt: now });
await insert('signatures', { id: 'sig_holder', companyId: cid, documentId: 'doc_opt', stakeholderId: 'stk_priya', signerName: 'Priya Raman', signerEmail: 'priya@example.com',
  status: 'SIGNED', typedSignature: 'P. Raman', signedAt: '2026-09-23T08:02:00.000Z', ipAddress: null, token: 'tok_holder', createdAt: now });
await insert('documents', { id: 'doc_theo', companyId: cid, name: 'Founder certificate CS-1', category: 'CERTIFICATE', visibility: 'HOLDER', stakeholderId: 'stk_theo',
  body: 'Certificate CS-1: 6,000,000 shares of Common Stock.', status: 'EXECUTED', requiresSignature: 1, createdAt: now });
await insert('documents', { id: 'doc_file', companyId: cid, name: 'Board deck.pdf', category: 'OTHER', visibility: 'ALL', stakeholderId: null,
  body: null, fileName: 'Board deck.pdf', status: 'FINAL', requiresSignature: 0, createdAt: now });

test('an executed agreement downloads as a PDF carrying its text and both signatures', async () => {
  const r = await download(`/api/c/${cid}/documents/doc_opt/pdf`, admin);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/pdf');
  assert.match(r.disposition, /filename="Option-agreement-OPT-7\.pdf"/);
  const text = r.body.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'));
  assert.ok(text.includes('(DOCS CO, INC.)'), 'company line');
  assert.ok(text.includes('(Option agreement OPT-7)'), 'title');
  assert.ok(text.includes('(STOCK OPTION AGREEMENT)'), 'body heading kept on its own line');
  assert.ok(text.includes('(Avery Stone)') && text.includes('(P. Raman)'), 'typed signatures');
  assert.ok(text.includes('(signed 2026-09-22 12:16 UTC \\267 203.0.113.7)'), 'signature detail with IP');
  assert.ok(text.includes('(signed 2026-09-23 08:02 UTC)'), 'signature detail without IP');
  assert.ok(text.includes('/BaseFont /Helvetica-Oblique'), 'typed signatures use the oblique face');
  assert.ok(text.includes('Fully executed electronically'));
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)![1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
});

test('long agreements wrap and paginate, keeping the author’s line breaks', () => {
  const paragraph = 'The Optionee acknowledges that the Option is granted under and governed by the terms of the Plan, which is incorporated herein by reference. ';
  const pdf = documentPdf({
    company: 'Docs Co, Inc.', title: 'A long agreement', body: Array.from({ length: 40 }, (_, i) => `Section ${i + 1}. ${paragraph.repeat(3)}`).join('\n\n'),
    signatures: [{ name: 'Avery Stone', signed: false }], footer: 'Signatures pending',
  }).toString('latin1');
  const pages = Number(pdf.match(/\/Count (\d+)/)![1]);
  assert.ok(pages >= 3, `expected several pages, got ${pages}`);
  assert.equal((pdf.match(/\(Page \d+ of \d+\)/g) ?? []).length, pages);
  assert.ok(pdf.includes('(Section 40. '), 'the last section is present');
  assert.ok(pdf.includes('(Not yet signed)'));
  // No line is wider than the page: every text run fits the 492pt column at the body size.
  const longest = Math.max(...[...pdf.matchAll(/\/F1 10\.5 Tf [\d.]+ [\d.]+ Td \(([^)]*)\)/g)].map((m) => m[1].length));
  assert.ok(longest < 120, `longest body line has ${longest} characters`);
});

test('holders download their own document, not somebody else’s, and files without text are refused', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const priya = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).json.token as string;

  const own = await download(`/api/c/${cid}/documents/doc_opt/pdf`, priya);
  assert.equal(own.status, 200);
  assert.equal(own.type, 'application/pdf');
  const other = await download(`/api/c/${cid}/documents/doc_theo/pdf`, priya);
  assert.equal(other.status, 403);
  const file = await download(`/api/c/${cid}/documents/doc_file/pdf`, admin);
  assert.equal(file.status, 400);
  const missing = await download(`/api/c/${cid}/documents/doc_nope/pdf`, admin);
  assert.equal(missing.status, 404);
});
