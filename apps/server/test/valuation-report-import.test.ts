/**
 * Importing a 409A report on the company's 409A page: the app reads the PDF,
 * from the computer or from the vault, and fills in the form to record the
 * valuation from it.
 *
 * Pinned here: reading records nothing and keeps nothing, but the line in the
 * log for a document opened in the vault, so an import that is cancelled leaves
 * nothing behind; it reads the appraiser and the company's value
 * as well as the price, the date and the method, and never takes the company's
 * own name for the appraiser's; a report already in the vault is read where it
 * is, and only one of this company's that the member may open; only a PDF, within
 * the size limit, and a scan says plainly that nothing was read; only those who
 * can record a valuation can import, and on the sample company only read; a
 * full reader says to try again shortly, keeps a place for the valuation team,
 * and nobody fills it alone; a reading holds no lock while it runs; and saving files the uploaded PDF
 * as the valuation's report together with the link to it, or not at all.
 *
 * Every company, firm, person and figure here is made up, and no email leaves
 * the machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import { freshDatabase, sessionCookie } from './helpers.ts';

// No mail transport, whatever apps/server/.env says: an empty value wins over the file.
process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/files.ts');
await import('../src/routes/valuation-report.ts');
const { configure, resetConfig } = await import('../src/config.ts');
const { invalidate } = await import('../src/store.ts');
const { one, run, transaction } = await import('../src/db.ts');
const { documentPdf } = await import('../src/pdf-writer.ts');
const { readReport } = await import('../src/report-reader.ts');
const { detectReport, nothingDetected } = await import('../src/report-detect.ts');
const { pdfText } = await import('../src/pdf-text.ts');
const { longDate } = await import('@kosmitor/core');

// The reader says in the log why a report was not read, and the members route
// prints the email it would send; collected here, not printed.
const realError = console.error;
const realLog = console.log;
console.error = () => undefined;
console.log = () => undefined;
after(() => { console.error = realError; console.log = realLog; });

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

/** Sends a file as the raw body, as the 409A page does, with anything else in the query string. */
async function send(path: string, token: string | null, content: Buffer | null, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: content ? new Uint8Array(content) as unknown as RequestInit['body'] : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const readIt = (cid: string, token: string | null, content: Buffer | null, query: Record<string, string> = {}) =>
  send(`/api/c/${cid}/valuations/report-reading`, token, content, query);
const fileIt = (cid: string, valuationId: string, token: string | null, content: Buffer | null, name = 'Quillfeather 409A report.pdf') =>
  send(`/api/c/${cid}/valuations/${valuationId}/report`, token, content, { name });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
/** The day the made-up reports value the stock as of: a month ago, so it is neither in the future nor stale. */
const VALUED_AS_OF = daysAgo(30);

/** A made-up appraisal report, written by the app's own PDF writer, the firm's name at the top as on its letterhead. */
function reportPdf(): Buffer {
  return documentPdf({
    company: 'Saltmarsh Appraisal Partners, LLC',
    title: 'Valuation of the common stock of Quillfeather Robotics, Inc.',
    body: [
      `Valuation Date: ${longDate(VALUED_AS_OF)}`,
      '',
      'Saltmarsh Appraisal Partners, LLC was engaged to estimate the fair market value of the common stock for Section 409A purposes.',
      'The Series A Preferred was issued at $1.50 per share.',
      'Based on our analysis, we concluded that the enterprise value of the Company was $48.2 million.',
      'We concluded that the fair market value of the common stock is $0.42 per share on a non-marketable, minority basis.',
      'We relied on the OPM backsolve method, calibrated to the Series A financing.',
    ].join('\n'),
    signatures: [],
    footer: 'Prepared by Saltmarsh Appraisal Partners, LLC',
  });
}

/** A PDF with no text in it, as a scan has none. */
const SCAN = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

/**
 * A few kilobytes that keep the reader busy for a while: one page drawing a
 * one-megabyte form over and over, until the limit on content drawn stops it.
 */
function slowReport(): Buffer {
  const line = 'BT /F1 12 Tf 72 700 Td (Fair market value) Tj ET\n';
  const form = deflateSync(Buffer.from(line.repeat(Math.ceil(1024 * 1024 / line.length))));
  const content = deflateSync(Buffer.from('/X Do\n'.repeat(300)));
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
      + '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >> >> endobj\n'
      + `4 0 obj << /Length ${content.length} /Filter /FlateDecode >> stream\n`, 'latin1'),
    content,
    Buffer.from('\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
      + `6 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length ${form.length} /Filter /FlateDecode >> stream\n`, 'latin1'),
    form,
    Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

/** How many rows each table holds, to show that something left nothing behind. */
const counts = async () => (await one<Record<string, number>>(
  `SELECT (SELECT count(*)::int FROM documents) AS documents, (SELECT count(*)::int FROM file_blobs) AS files,
          (SELECT count(*)::int FROM valuations) AS valuations, (SELECT count(*)::int FROM audit_log) AS audit`))!;

// --- A company, its members and a neighbour -----------------------------------------

const registered = await call('POST', '/api/auth/register', { email: 'ines.okafor@example.com', name: 'Ines Okafor', password: 'ines-pass-1' });
const admin = registered.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Quillfeather Robotics', legalName: 'Quillfeather Robotics, Inc.' }, admin)).json.id as string;
const neighbour = (await call('POST', '/api/companies', { name: 'Larchmont Kilnworks' }, admin)).json.id as string;

/** A member of the company with a role, signed in. */
async function member(email: string, name: string, role: string, stakeholderId?: string): Promise<string> {
  const added = await call('POST', `/api/c/${cid}/members`, { email, name, role, stakeholderId }, admin);
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const link = await call('POST', `/api/c/${cid}/members/${added.json.id}/reset-password`, { mode: 'link' }, admin);
  const reset = await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: `${role.toLowerCase()}-pass-1` });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  return reset.token as string;
}
const legal = await member('teodor.brandt@example.com', 'Teodor Brandt', 'LEGAL');
const board = await member('maeve.lindqvist@example.com', 'Maeve Lindqvist', 'BOARD');
const viewer = await member('cyrus.adeyemi@example.com', 'Cyrus Adeyemi', 'VIEWER');
// Holders, who see only their own holdings.
const holderOf = async (name: string, relation: string) => (await call('POST', `/api/c/${cid}/stakeholders`, { name, type: 'INDIVIDUAL', relation }, admin)).json.id as string;
const employee = await member('wren.tallis@example.com', 'Wren Tallis', 'EMPLOYEE', await holderOf('Wren Tallis', 'EMPLOYEE'));
const investor = await member('osric.vane@example.com', 'Osric Vane', 'INVESTOR', await holderOf('Osric Vane', 'INVESTOR'));

const newValuation = async (company = cid) => (await call('POST', `/api/c/${company}/valuations`, {
  type: '409A', fairMarketValue: 420_000, effectiveDate: VALUED_AS_OF, status: 'ACTIVE', provider: 'Saltmarsh Appraisal Partners, LLC',
}, admin)).json as { id: string };

// --- Reading ------------------------------------------------------------------------

test('a PDF from the computer is read for the form, and nothing is recorded or kept', async () => {
  const before = await counts();
  const r = await readIt(cid, admin, reportPdf());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.detected;
  assert.equal(d.readable, true);
  assert.deepEqual([d.fairMarketValue.value, d.fairMarketValue.confidence], [420_000, 'high']);
  assert.match(d.fairMarketValue.context, /fair market value of the common stock is \$0\.42 per share/);
  assert.equal(d.valuationDate.value, VALUED_AS_OF);
  assert.equal(d.method.value, 'OPM backsolve');
  // The firm that prepared it, in the case the report writes it, never the company it values.
  assert.deepEqual([d.appraiser.value, d.appraiser.confidence], ['Saltmarsh Appraisal Partners, LLC', 'high']);
  assert.ok(d.appraiser.page >= 1 && d.appraiser.context.includes(d.appraiser.text), JSON.stringify(d.appraiser));
  assert.deepEqual([d.enterpriseValue.value, d.enterpriseValue.basis, d.enterpriseValue.confidence], [4_820_000_000, 'enterprise', 'high']);
  assert.equal(d.enterpriseValue.text, '$48.2 million');

  // Nothing written: no document, no file, no valuation, not even a line in the log.
  assert.deepEqual(await counts(), before);
  // An editor other than an administrator imports as well.
  assert.equal((await readIt(cid, legal, reportPdf())).status, 200);
});

test('the company’s own name, on the report’s cover with nothing to say it is the company, is never read as the appraiser', async () => {
  // A cover with the company's legal name standing alone, as a letterhead stands.
  const cover = documentPdf({
    company: 'Quillfeather Robotics, Inc.', title: '409A valuation report',
    body: 'We concluded that the fair market value of the common stock is $0.42 per share.', signatures: [], footer: '',
  });
  const text = pdfText(cover);
  assert.ok(text.readable);
  if (!text.readable) return;
  assert.equal(detectReport(text.pages).appraiser?.value, 'QUILLFEATHER ROBOTICS, INC.', 'read alone, the name is offered as a guess');
  const r = await readIt(cid, admin, cover);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.detected.appraiser, null, 'the route knows the company’s names and leaves them out');
  assert.equal(r.json.detected.fairMarketValue.value, 420_000);
});

test('a report already in the vault is read where it is, and only one of this company’s', async () => {
  const filed = await send(`/api/c/${cid}/documents/upload`, admin, reportPdf(), { name: 'Saltmarsh report.pdf', category: 'VALUATION', folder: 'Valuations' });
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  const before = await counts();
  const r = await readIt(cid, admin, null, { documentId: filed.json.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.detected.fairMarketValue.value, 420_000);
  assert.equal(r.json.detected.appraiser.value, 'Saltmarsh Appraisal Partners, LLC');
  // The document stays as it was and nothing is added, but for the line in the log a download of it would write too.
  assert.deepEqual(await counts(), { ...before, audit: before.audit + 1 });
  assert.ok(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'VIEW' AND detail = 'Read "Saltmarsh report.pdf" to fill in a valuation'`, filed.json.id));

  // Another company's document is not this company's to read.
  const theirs = await send(`/api/c/${neighbour}/documents/upload`, admin, reportPdf(), { name: 'Their report.pdf', category: 'VALUATION' });
  const crossed = await readIt(cid, admin, null, { documentId: theirs.json.id });
  assert.equal(crossed.status, 400);
  assert.equal(crossed.json.error, 'That document is not in this company’s vault.');
  // A document that is not a PDF, or has no file at all, has nothing to read.
  const sheet = await send(`/api/c/${cid}/documents/upload`, admin, Buffer.from('a,b\n1,2\n'), { name: 'cap table.csv' });
  assert.equal((await readIt(cid, admin, null, { documentId: sheet.json.id })).json.error, 'That document is not a PDF. Choose the report’s PDF.');
  await run(`INSERT INTO documents (id, company_id, name, category, body, status, created_at) VALUES ('doc_written', ?, 'Board minutes', 'BOARD', 'Resolved.', 'FINAL', ?)`,
    cid, new Date().toISOString());
  assert.equal((await readIt(cid, admin, null, { documentId: 'doc_written' })).json.error, 'That document has no file to read. Choose the report’s PDF.');
  // One or the other, not both.
  const both = await readIt(cid, admin, reportPdf(), { documentId: filed.json.id });
  assert.equal(both.status, 400);
});

test('a PDF with no text, as a scan has none, says plainly that nothing was read', async () => {
  const r = await readIt(cid, admin, SCAN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.detected, nothingDetected(false));
  assert.deepEqual(r.json.detected, {
    readable: false, fairMarketValue: null, valuationDate: null, method: null, appraiser: null, enterpriseValue: null,
    candidates: { fairMarketValue: [], valuationDate: [] },
  });
});

test('only a PDF, and nothing empty or past the size limit', async () => {
  const before = await counts();
  const png = await readIt(cid, admin, Buffer.from('\x89PNG\r\n\x1a\n made-up image', 'latin1'));
  assert.deepEqual([png.status, png.json.error], [400, 'That file is not a PDF the app can open. Choose the report’s PDF.']);
  const empty = await readIt(cid, admin, Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /empty/);
  try {
    configure({ limits: { uploadMb: 1 } });
    const big = await readIt(cid, admin, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 + 10, 0x20)]));
    assert.equal(big.status, 413);
    assert.match(big.json.error, /too large/);
  } finally {
    resetConfig();
  }
  assert.deepEqual(await counts(), before);
});

test('only those who can record a valuation can import one', async () => {
  const v = await newValuation();
  const stranger = (await call('POST', '/api/auth/register', { email: 'odile.marchetti@example.com', name: 'Odile Marchetti', password: 'odile-pass-1' })).token as string;
  const before = await counts();
  for (const [token, who] of [[board, 'the board'], [viewer, 'a viewer'], [employee, 'an employee with holdings'], [investor, 'an investor']] as const) {
    const read = await readIt(cid, token, reportPdf());
    assert.equal(read.status, 403, who);
    assert.match(read.json.error, /read-only|your own portfolio/, who);
    assert.equal((await fileIt(cid, v.id, token, reportPdf())).status, 403, who);
    assert.equal((await call('PUT', `/api/c/${cid}/valuations/${v.id}/report`, { url: 'https://reports.example.com/x' }, token)).status, 403, who);
  }
  assert.equal((await readIt(cid, null, reportPdf())).status, 401, 'nobody signed in');
  // Someone who is not a member is nobody here.
  assert.equal((await readIt(cid, stranger, reportPdf())).status, 403);
  assert.deepEqual(await counts(), before);
});

test('when the server’s line of reports is full, the import is told to try again shortly; one company, and one person, reads one report at a time', async () => {
  // Two reports that take a while to read hold the reader's line, and this
  // company's import, of another such report, takes the last place an import may.
  const held = [1, 2].map(() => readReport(slowReport()));
  const first = readIt(cid, legal, slowReport());
  let desk: Promise<unknown> | null = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Another company's import finds the line full.
    const busy = await readIt(neighbour, admin, reportPdf());
    assert.equal(busy.status, 503, JSON.stringify(busy.json));
    assert.equal(busy.json.error, 'The server is busy reading other reports. Try again in a moment.');
    // The place left over is the valuation team's: an upload of theirs is still taken in.
    desk = readReport(reportPdf());
    // A second press here, while the first report is still being read, is turned away.
    const second = await readIt(cid, admin, reportPdf());
    assert.equal(second.status, 429, JSON.stringify(second.json));
    assert.match(second.json.error, /An earlier report is still being read/);
  } finally {
    await Promise.all(held);
  }
  assert.equal((await first).status, 200, 'the first is read');
  assert.ok(desk && (await desk as { readable: boolean }).readable, 'the valuation team’s upload is read');
  assert.equal((await readIt(cid, admin, reportPdf())).status, 200, 'and once it is done, the next is');
});

test('one person importing for two companies at once is asked to wait for the first', async () => {
  // A slow report ahead in the line keeps the first import waiting while the second is sent.
  const ahead = readReport(slowReport());
  const first = readIt(cid, admin, slowReport());
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await readIt(neighbour, admin, reportPdf());
    assert.equal(second.status, 429, JSON.stringify(second.json));
  } finally {
    await ahead;
  }
  assert.equal((await first).status, 200);
  assert.equal((await readIt(neighbour, admin, reportPdf())).status, 200);
});

test('on the sample company a report can be read, to try the import, but not filed', async () => {
  const sample = (await call('POST', '/api/companies', { name: 'Sample Fernhollow' }, admin)).json.id as string;
  const v = await newValuation(sample);
  await run('UPDATE companies SET is_sample = 1 WHERE id = ?', sample);
  invalidate(sample);
  const r = await readIt(sample, admin, reportPdf());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.detected.fairMarketValue.value, 420_000);
  const filed = await fileIt(sample, v.id, admin, reportPdf());
  assert.deepEqual([filed.status, filed.json.error], [403, 'This is sample data and cannot be changed.']);
});

test('a reading holds no lock: it goes through while a long change at the company holds the company’s', async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const done = transaction(async () => {
    await one('SELECT id FROM companies WHERE id = ? FOR UPDATE', cid);
    held();
    await released;
  });
  await holding;
  try {
    const r = await Promise.race([
      readIt(cid, admin, reportPdf()),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    assert.ok(r, 'the reading did not wait for the lock');
    assert.equal(r.status, 200, JSON.stringify(r.json));
  } finally {
    release();
    await done;
  }
});

// --- Saving -----------------------------------------------------------------------

test('saving files the uploaded PDF as the valuation’s report, the document and the link together', async () => {
  const v = await newValuation();
  const file = reportPdf();
  const r = await fileIt(cid, v.id, admin, file);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const docId = r.json.document.id as string;
  assert.equal(r.json.url, null);
  assert.equal(r.json.document.name, 'Quillfeather 409A report.pdf');

  // In the vault with the valuations, for administrators, as the team's uploads are filed.
  const doc = (await one<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', docId))!;
  assert.deepEqual([doc.company_id, doc.category, doc.folder, doc.status, doc.visibility, doc.mime_type, doc.file_name, doc.created_by, Number(doc.size_bytes)],
    [cid, 'VALUATION', 'Valuations', 'FINAL', 'ADMIN', 'application/pdf', 'Quillfeather 409A report.pdf', 'Ines Okafor', file.length]);
  const blob = await one<{ content: Buffer }>('SELECT content FROM file_blobs WHERE document_id = ? AND company_id = ?', docId, cid);
  assert.ok(blob && Buffer.from(blob.content).equals(file), 'the file as uploaded');
  const saved = (await one<{ report_document_id: string | null; report_url: string | null }>('SELECT report_document_id, report_url FROM valuations WHERE id = ?', v.id))!;
  assert.deepEqual(saved, { report_document_id: docId, report_url: null });
  const report = await call('GET', `/api/c/${cid}/valuations/${v.id}/report`, undefined, admin);
  assert.equal(report.json.document.id, docId);
  assert.ok(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'UPDATE' AND detail = 'Report set to the uploaded document "Quillfeather 409A report.pdf"'`, v.id));
  assert.ok(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'UPLOAD'`, docId));

  // A link on file is replaced, as a document chosen from the vault replaces it.
  await call('PUT', `/api/c/${cid}/valuations/${v.id}/report`, { url: 'https://reports.example.com/quillfeather' }, admin);
  const again = await fileIt(cid, v.id, admin, file, 'Quillfeather 409A report, final.pdf');
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual(await one('SELECT report_url FROM valuations WHERE id = ?', v.id), { report_url: null });
});

test('a report that cannot be filed leaves nothing in the vault', async () => {
  const v = await newValuation();
  const theirs = await newValuation(neighbour);
  const before = await counts();
  const crossed = await fileIt(cid, theirs.id, admin, reportPdf());
  assert.equal(crossed.status, 404, 'another company’s valuation');
  const png = await fileIt(cid, v.id, admin, Buffer.from('\x89PNG\r\n\x1a\n made-up image', 'latin1'));
  assert.deepEqual([png.status, png.json.error], [400, 'That file is not a PDF the app can open. Choose the report’s PDF.']);
  assert.equal((await fileIt(cid, v.id, admin, Buffer.alloc(0))).status, 400);
  assert.equal((await fileIt(cid, 'val_nothing', admin, reportPdf())).status, 404);
  assert.deepEqual(await counts(), before);
  assert.deepEqual(await one('SELECT report_document_id FROM valuations WHERE id = ?', theirs.id), { report_document_id: null });
});

test('a report chosen from the vault becomes the valuation’s report where it is, with no copy made', async () => {
  const filed = await send(`/api/c/${cid}/documents/upload`, admin, reportPdf(), { name: 'Saltmarsh report, vault.pdf', category: 'VALUATION', folder: 'Valuations' });
  const v = await newValuation();
  const before = await counts();
  assert.equal((await readIt(cid, admin, null, { documentId: filed.json.id })).status, 200);
  const set = await call('PUT', `/api/c/${cid}/valuations/${v.id}/report`, { documentId: filed.json.id }, admin);
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const after = await counts();
  assert.deepEqual([after.documents, after.files], [before.documents, before.files]);
});
