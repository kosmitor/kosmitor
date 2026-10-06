/**
 * Certificate legends and terms, printable documents, and emailing holders
 * about their executed certificates.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

delete process.env.SMTP_URL;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/certificates.ts');
await import('../src/routes/files.ts');
await import('../src/routes/data.ts');
const { insert, one, run } = await import('../src/db.ts');

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
const cid = (await call('POST', '/api/companies', { name: 'Printco', legalName: 'Printco, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insert('stakeholders', { id: 'stk_noor', companyId: cid, name: 'Noor Haddad', email: null, type: 'INDIVIDUAL', relation: 'INVESTOR', createdAt: now });

test('class legends and company terms print on certificates; documents render as printable pages', async () => {
  assert.equal((await call('PATCH', `/api/c/${cid}/share-classes/${common}`, { legend: 'The shares are subject to a right of first refusal and co-sale agreement.' }, admin)).status, 200);
  assert.equal((await call('PATCH', `/api/c/${cid}`, { certificateTerms: 'Transfers require the prior written consent of the board.' }, admin)).status, 200);

  const issued = await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, { stakeholderId: 'stk_priya', shareClassId: common, quantity: 1_000, pricePerShare: 1_000_000, issueDate: '2026-09-21', signerName: 'Avery Stone', signerTitle: 'CEO' }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.match(issued.json.document.body, /THE SHARES ARE SUBJECT TO A RIGHT OF FIRST REFUSAL AND CO-SALE AGREEMENT\./);
  assert.match(issued.json.document.body, /TERMS\nTransfers require the prior written consent of the board\./);

  // Printing a pending certificate gives its certificate-layout PDF, the same one Read shows,
  // with the blocks awaiting signature; the holder may print their own.
  const pending = await call('GET', `/api/c/${cid}/documents/${issued.json.document.id}/print`, undefined, admin);
  assert.equal(pending.status, 200);
  assert.match(pending.type, /application\/pdf/);
  assert.match(pending.text, /\/MediaBox \[0 0 792 612\]/, 'landscape, like a stock certificate');
  assert.match(pending.text, /\(Printco, Inc\.\) Tj/, 'the legal name heads the page');
  assert.match(pending.text, /\(Awaiting signature\) Tj/);
  assert.match(pending.text, /RIGHT OF FIRST REFUSAL/);
  assert.match(pending.text, /Signatures pending/);
  const read = await fetch(`${base}/api/c/${cid}/documents/${issued.json.document.id}/pdf?inline=1`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(read.headers.get('content-disposition') ?? '', /^inline;/, 'the reading view shows it in the page');
  // Read and Print are the same document: the same pages with the same text on them.
  const shown = Buffer.from(await read.arrayBuffer()).toString('latin1');
  const textOf = (pdf: string) => (pdf.match(/\((?:[^()\\]|\\.)*\) Tj/g) ?? []).join('\n');
  assert.equal(shown.match(/\/Count (\d+)/)?.[1], pending.text.match(/\/Count (\d+)/)?.[1]);
  assert.equal(textOf(shown), textOf(pending.text));

  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  const priya = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'priya-pass-1',
  })).token as string;
  await call('GET', `/api/c/${cid}/portal`, undefined, priya);                                   // links the account
  assert.equal((await call('GET', `/api/c/${cid}/documents/${issued.json.document.id}/print`, undefined, priya)).status, 200);
  assert.equal((await call('GET', `/api/c/${cid}/certificates/print`, undefined, priya)).status, 403);   // the book is for company users
  assert.equal((await call('GET', `/api/c/${cid}/certificates/print`, undefined, admin)).status, 404);   // nothing executed yet

  // Execute it, then the book has one page with both signatures.
  const blocks = issued.json.signatures as { id: string; stakeholderId: string | null }[];
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${blocks.find((b) => b.stakeholderId === 'stk_priya')!.id}/sign`, { typedSignature: 'Priya Raman' }, priya)).status, 200);
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${blocks.find((b) => !b.stakeholderId)!.id}/sign`, { typedSignature: 'Avery Stone' }, admin)).status, 200);
  const book = await call('GET', `/api/c/${cid}/certificates/print`, undefined, admin);
  assert.equal(book.status, 200);
  assert.match(book.type, /application\/pdf/, 'every certificate has a front page, so the book is one PDF');
  assert.match(book.text, /\(Priya Raman\) Tj/);
  assert.match(book.text, /\(Avery Stone\) Tj/);
  assert.match(book.text, /Fully executed electronically/);
  assert.ok((await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.some((a: any) => a.action === 'PRINT'));

  // A certificate generated before front pages existed keeps the plain HTML page, and so
  // does a book that includes one.
  await insert('documents', { id: 'doc_legacy', companyId: cid, name: 'Stock certificate CS-0 — Noor Haddad', category: 'CERTIFICATE', folder: 'Certificates',
    body: 'PRINTCO, INC.\nSTOCK CERTIFICATE No. CS-0\n\nLEGENDS\nTHE SHARES ARE SUBJECT TO A RIGHT OF FIRST REFUSAL.', stakeholderId: 'stk_noor', securityId: null,
    requiresSignature: 1, status: 'AWAITING_SIGNATURE', visibility: 'HOLDER', createdBy: 'Avery Stone', createdAt: now });
  await insert('signatures', { id: 'sig_legacy', companyId: cid, documentId: 'doc_legacy', stakeholderId: 'stk_noor', signerName: 'Noor Haddad', signerEmail: null, status: 'PENDING', token: 'legacy-token', sentAt: now, createdAt: now });
  const legacy = await call('GET', `/api/c/${cid}/documents/doc_legacy/print`, undefined, admin);
  assert.match(legacy.type, /text\/html/);
  assert.match(legacy.text, /<title>Stock certificate CS-0 — Noor Haddad<\/title>/);
  assert.match(legacy.text, /Not yet signed/);
  assert.match(legacy.text, /RIGHT OF FIRST REFUSAL/);
  assert.match(legacy.text, /Signatures pending/);
  assert.doesNotMatch(legacy.text, /<script/);                                                  // nothing executable in the page
  await run("UPDATE documents SET status = 'EXECUTED' WHERE id = 'doc_legacy'");
  const mixed = await call('GET', `/api/c/${cid}/certificates/print`, undefined, admin);
  assert.match(mixed.type, /text\/html/);
  assert.match(mixed.text, /Printco — certificates/);
  assert.equal((mixed.text.match(/class="sheet"/g) ?? []).length, 2);
  assert.match(mixed.text, /class="cursive">Priya Raman</);
  assert.match(mixed.text, /class="cursive">Avery Stone</);
  await run("DELETE FROM documents WHERE id = 'doc_legacy'");

  // Emailing: one holder with an address, none configured to send.
  const mailed = await call('POST', `/api/c/${cid}/certificates/email`, {}, admin);
  assert.equal(mailed.status, 200, JSON.stringify(mailed.json));
  assert.equal(mailed.json.holders, 1);
  assert.equal(mailed.json.certificates, 1);
  assert.equal(mailed.json.emailed, 0);
  assert.match(mailed.json.reason, /not configured/);
  assert.equal((await call('POST', `/api/c/${cid}/certificates/email`, { issuanceIds: ['nope'] }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/certificates/email`, {}, priya)).status, 403);

  // A document without text cannot be printed; an unknown one is not found.
  await insert('documents', { id: 'doc_file', companyId: cid, name: 'Scan.pdf', category: 'OTHER', folder: null, body: null, stakeholderId: null, securityId: null, requiresSignature: 0, status: 'FINAL', visibility: 'ALL', createdBy: 'Avery Stone', createdAt: now });
  assert.equal((await call('GET', `/api/c/${cid}/documents/doc_file/print`, undefined, admin)).status, 400);
  assert.equal((await call('GET', `/api/c/${cid}/documents/doc_missing/print`, undefined, admin)).status, 404);
});

test('the certificates email lists each certificate, links the portal in both parts, and escapes what people typed', async () => {
  const { composeCertificatesReadyEmail } = await import('../src/routes/certificates.ts');
  const { config } = await import('../src/config.ts');
  const portal = `${config().app.url}/portal`;
  const hostile = '<script>x</script>';
  const two = composeCertificatesReadyEmail({
    companyName: 'Printco', to: 'priya@example.com', holderName: hostile, portalUrl: portal,
    certificates: ['Stock certificate CS-1 — Priya Raman', `Stock certificate CS-4 — ${hostile}`],
  });
  assert.equal(two.to, 'priya@example.com');
  assert.equal(two.toName, hostile);
  assert.equal(two.subject, 'Printco: your share certificates are ready');
  assert.ok(two.html && two.text, 'both parts');
  for (const part of [two.html!, two.text]) {
    assert.ok(part.includes(portal), 'the portal link');
    for (const fact of ['View your certificates', 'Printco', 'Stock certificate CS-1 — Priya Raman', 'Stock certificate CS-4', 'fully signed', 'Print', '— Printco']) {
      assert.ok(part.includes(fact), `${fact} is in the ${part === two.text ? 'text' : 'HTML'}`);
    }
  }
  assert.ok(!two.html!.includes('<script>'), 'a typed name never becomes markup');
  assert.ok(two.html!.includes('&lt;script&gt;x&lt;/script&gt;'));

  const one = composeCertificatesReadyEmail({ companyName: 'Printco', to: 'noor@example.com', holderName: 'Noor Haddad', portalUrl: portal, certificates: ['Stock certificate CS-2 — Noor Haddad'] });
  assert.equal(one.subject, 'Printco: your share certificate is ready');
  assert.ok(one.text.includes('View your certificate:'));
  assert.ok(one.html!.includes('Your share certificate is ready'));
});
