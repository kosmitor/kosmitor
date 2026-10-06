/**
 * The valuation team uploads the 409A report from its page, the app reads the
 * values from it, and the company records the 409A from them once someone there
 * has checked them.
 *
 * Pinned here: only the team's link uploads, and only while the team works the
 * request; only a PDF, within the size and the daily limits, an upload counting
 * from when its file is read; one report read at a time on the server; the file
 * lands in the company's vault and nowhere else; a draft the team replaces or
 * takes back before delivering leaves the vault unless someone there has put it
 * to use, and a delivered one never does; the figures the team gives with the
 * delivery are kept and cleared with it; the company sees the report as far as
 * its role sees the vault; completing the request attaches the report to the
 * company's own 409A and never to another company's, says whether it did, and
 * is refused from a page that read the request before the team last changed it;
 * the delivery email states the team's price; and no holder's name appears
 * anywhere the team or the email reaches. Nothing is ever recorded without the
 * company's own call.
 *
 * Every company, person and report here is made up, and no email leaves the
 * machine: the console transport prints each one, and it is read back below.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { freshDatabase, sessionCookie } from './helpers.ts';

// No mail transport, whatever apps/server/.env says: an empty value wins over the file.
process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';
process.env.VALUATION_DESK_EMAIL = 'desk@example.test';

await freshDatabase();
const { mailConfigured } = await import('../src/mail.ts');
if (mailConfigured()) throw new Error('These tests must run with no mail transport.');
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/files.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/valuation-report.ts');
await import('../src/routes/valuation-requests.ts');
const { configure, resetConfig, deskName, publicConfig } = await import('../src/config.ts');
const { run, one, all, transaction } = await import('../src/db.ts');
const { documentPdf } = await import('../src/pdf-writer.ts');
const { longDate } = await import('@kosmitor/core');

/** The service is off by default; these tests are about it running. */
const offerTheDesk = () => { resetConfig(); configure({ valuationDesk: { enabled: true } }); };
offerTheDesk();

// --- Mail, as the console transport prints it ---------------------------------
interface Sent { to: string; subject: string; text: string }
const outbox: Sent[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  const m = line.match(/^\[mail\] not configured[^\n]*would send to (\S+): "([^"\n]*)"\n([\s\S]*)$/);
  if (m) outbox.push({ to: m[1], subject: m[2], text: m[3].split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n') });
  else realLog(...args);
};
after(() => { console.log = realLog; });

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, token: sessionCookie(res) };
}
const desk = (method: string, path: string, token: string, body?: unknown) =>
  call(method, `/api/valuation-desk${path}`, body, null, { 'X-Desk-Token': token });

/** Uploads a report as the team's page does: the file as the body, its name in the query, the token in a header. */
async function upload(token: string | null, content: Buffer, fileName = 'Ledgerline 409A report.pdf') {
  const res = await fetch(`${base}/api/valuation-desk/report?${new URLSearchParams({ name: fileName })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...(token ? { 'X-Desk-Token': token } : {}) },
    body: new Uint8Array(content) as unknown as RequestInit['body'],
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, token: sessionCookie(res) };
}

// --- A company with holders on its cap table ---------------------------------------

const avery = await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' });
const admin = avery.token as string;
const averyId = avery.json.user.id as string;

const HOLDERS = ['Priya Raman', 'priya@example.com', 'Northwind Ventures', 'northwind.example.com'];

async function newCompany(name: string): Promise<string> {
  const cid = (await call('POST', '/api/companies', { name }, admin)).json.id as string;
  await call('PATCH', `/api/c/${cid}/company`, { legalName: `${name}, Inc.` }, admin);
  const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
  const seriesA = (await call('POST', `/api/c/${cid}/share-classes`, {
    name: 'Series A Preferred', kind: 'PREFERRED', authorized: 3_000_000, originalIssuePrice: 1_500_000,
    liquidationMultiple: 1, participation: 'NON_PARTICIPATING', seniority: 1, issueDate: '2025-06-01',
  }, admin)).json;
  const priya = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;
  const fund = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Northwind Ventures', email: 'deals@northwind.example.com', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
  await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: priya.id, shareClassId: common.id, quantity: 4_000_000, issueDate: '2024-01-10' }, admin);
  await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'PA-1', stakeholderId: fund.id, shareClassId: seriesA.id, quantity: 1_000_000, pricePerShare: 1_500_000, issueDate: '2025-06-01' }, admin);
  return cid;
}

/**
 * A request the team has been told about, with a link it can use. Written straight
 * to the table: what is checked here is what the team does once it has the link.
 */
async function openRequest(companyId: string, status = 'IN_PROGRESS'): Promise<{ id: string; token: string }> {
  const id = `vrq_${randomBytes(6).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  await run(`INSERT INTO valuation_requests (id, company_id, status, provider, requested_by, requested_by_id, desk_token_hash, desk_token_at,
      desk_notified_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'Avery Stone', ?, ?, ?, ?, ?, ?)`,
  id, companyId, status, deskName(), averyId, createHash('sha256').update(token).digest('hex'), now, now, now, now);
  return { id, token };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
/** The day the made-up reports value the stock as of: a month ago, so it is neither in the future nor stale. */
const VALUED_AS_OF = daysAgo(30);

/** A made-up appraisal report, written by the app's own PDF writer. */
function reportPdf(price = '$0.42', valuedAsOf = VALUED_AS_OF): Buffer {
  return documentPdf({
    company: 'Ledgerline Valuations',
    title: 'Valuation of the common stock of Harbor Robotics, Inc.',
    body: [
      `Valuation Date: ${longDate(valuedAsOf)}`,
      '',
      'The Series A Preferred was issued at $1.50 per share.',
      `Based on our analysis, we concluded that the fair market value of the common stock is ${price} per share on a non-marketable, minority basis.`,
      'We relied on the OPM backsolve method, calibrated to the Series A financing.',
    ].join('\n'),
    signatures: [],
    footer: 'Prepared by Ledgerline Valuations',
  });
}

const requestRow = (id: string) => one<{ status: string; report_document_id: string | null; report_detected: string | null; report_fmv: number | null; report_method: string | null }>(
  'SELECT status, report_document_id, report_detected, report_fmv, report_method FROM valuation_requests WHERE id = ?', id);
const documentRow = (id: string) => one<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', id);
/** Moves every earlier upload back two days, out of the daily limit. */
const forgetUploads = () => run(`UPDATE audit_log SET created_at = ? WHERE action = 'DESK_UPLOAD'`, new Date(Date.now() - 2 * 86_400_000).toISOString());
const companyRequest = async (companyId: string, id: string, token = admin) =>
  (await call('GET', `/api/c/${companyId}/valuation-requests`, undefined, token)).json.find((r: any) => r.id === id);
const closeRequests = (...ids: string[]) =>
  run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, new Date().toISOString(), ...ids);

/**
 * Holds a company's lock, as a long change at the company would, until release()
 * is called; `then` runs under the lock just before it is let go. An upload is
 * read before it takes the lock, so one sent meanwhile is read and then waits.
 */
function holdCompany(companyId: string, then: () => Promise<unknown> = async () => undefined) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const done = transaction(async () => {
    await one('SELECT id FROM companies WHERE id = ? FOR UPDATE', companyId);
    held();
    await released;
    await then();
  });
  return { holding, release, done };
}

/** Waits until a query on this test's database waits for a lock: an upload, read, waiting for the company's. */
async function someoneWaits(): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    const waiting = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (waiting && waiting.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Nothing waited for the company’s lock.');
}

const harbor = await newCompany('Harbor Robotics');

// --- Uploading -------------------------------------------------------------------------

test('the team uploads the report with its link: it lands in the company’s vault and the values are read from it', async () => {
  const { id, token } = await openRequest(harbor);
  const file = reportPdf();
  const r = await upload(token, file, 'Harbor Robotics 409A report.pdf');
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // What was read, for the delivery form.
  assert.equal(r.json.detected.readable, true);
  assert.equal(r.json.detected.fairMarketValue.value, 420_000);
  assert.equal(r.json.detected.fairMarketValue.confidence, 'high');
  assert.match(r.json.detected.fairMarketValue.context, /fair market value of the common stock is \$0\.42 per share/);
  assert.equal(r.json.detected.valuationDate.value, VALUED_AS_OF);
  assert.equal(r.json.detected.method.value, 'OPM backsolve');
  assert.ok(r.json.detected.candidates.fairMarketValue.every((c: any) => c.value !== 1_500_000), 'the preferred price is not offered');

  // The team's page shows the upload, beside everything else it shows.
  assert.equal(r.json.id, id);
  assert.equal(r.json.report.document.name, 'Harbor Robotics 409A report.pdf');
  assert.equal(r.json.report.document.sizeBytes, file.length);
  assert.deepEqual(Object.keys(r.json.report.document).sort(), ['createdAt', 'fileName', 'id', 'name', 'sizeBytes']);
  assert.deepEqual(r.json.report.detected, r.json.detected);
  assert.equal(r.json.report.fairMarketValue, null, 'nothing the team has given yet');
  assert.equal(r.json.report.method, null);

  // In the company's vault, filed with its valuations, kept to administrators, made by the team.
  const docId = r.json.report.document.id as string;
  const doc = (await documentRow(docId))!;
  assert.equal(doc.company_id, harbor);
  assert.deepEqual([doc.category, doc.folder, doc.status, doc.visibility, doc.created_by, doc.mime_type, doc.file_name],
    ['VALUATION', 'Valuations', 'FINAL', 'ADMIN', deskName(), 'application/pdf', 'Harbor Robotics 409A report.pdf']);
  const blob = await one<{ content: Buffer }>('SELECT content FROM file_blobs WHERE document_id = ? AND company_id = ?', docId, harbor);
  assert.ok(blob && Buffer.from(blob.content).equals(file), 'the file as uploaded');
  assert.equal((await requestRow(id))!.report_document_id, docId);

  // Logged under the team's name, naming the file.
  const log = await all<{ user_id: string | null; user_name: string; detail: string; company_id: string }>(
    `SELECT user_id, user_name, detail, company_id FROM audit_log WHERE entity_id = ? AND action = 'DESK_UPLOAD'`, id);
  assert.deepEqual(log, [{ user_id: null, user_name: deskName(), detail: `The ${deskName()} uploaded the report "Harbor Robotics 409A report.pdf"`, company_id: harbor }]);

  // The team downloads it back with the link, and the company sees it on its page.
  const back = await fetch(`${base}/api/valuation-desk/report`, { headers: { 'X-Desk-Token': token } });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'application/pdf');
  assert.equal(back.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.from(await back.arrayBuffer()).equals(file));

  const seen = await companyRequest(harbor, id);
  assert.deepEqual(seen.report.document, {
    item: 'REPORT', itemLabel: 'The 409A report', id: docId, name: 'Harbor Robotics 409A report.pdf', fileName: 'Harbor Robotics 409A report.pdf',
    mimeType: 'application/pdf', sizeBytes: file.length, hasBody: false, createdAt: doc.created_at,
    category: 'VALUATION', folder: 'Valuations', status: 'FINAL', visibility: 'ADMIN',
  });
  assert.equal(seen.report.detected.fairMarketValue.value, 420_000);
  // The company opens it through its vault's own route.
  const opened = await fetch(`${base}/api/c/${harbor}/documents/${docId}/download`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(opened.status, 200);

  // Nothing is recorded: no valuation exists until the company records one.
  assert.equal((await all('SELECT id FROM valuations WHERE company_id = ?', harbor)).length, 0);
  assert.equal((await requestRow(id))!.status, 'IN_PROGRESS');
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('without the team’s current link, nothing is uploaded, removed or downloaded', async () => {
  const { id, token } = await openRequest(harbor);
  const before = (await all('SELECT id FROM documents WHERE company_id = ?', harbor)).length;
  assert.equal((await upload(null, reportPdf())).status, 404, 'no token');
  assert.equal((await upload('not-a-token', reportPdf())).status, 404, 'not a token');
  assert.equal((await upload(randomBytes(32).toString('base64url'), reportPdf())).status, 404, 'a token of no request');
  // A newer notice replaced the link.
  await run('UPDATE valuation_requests SET desk_token_hash = ? WHERE id = ?', createHash('sha256').update('newer').digest('hex'), id);
  const stale = await upload(token, reportPdf());
  assert.equal(stale.status, 404);
  assert.match(stale.json.error, /not valid/);
  assert.equal((await desk('DELETE', '/report', token)).status, 404);
  assert.equal((await desk('GET', '/report', token)).status, 404);
  // An old link expires, as it does for everything else on the team's page.
  const old = await openRequest(harbor);
  await run('UPDATE valuation_requests SET desk_token_at = ? WHERE id = ?', new Date(Date.now() - 400 * 86_400_000).toISOString(), old.id);
  assert.equal((await upload(old.token, reportPdf())).status, 404);
  assert.equal((await all('SELECT id FROM documents WHERE company_id = ?', harbor)).length, before, 'nothing reached the vault');
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id IN (?, ?)`, new Date().toISOString(), id, old.id);
});

test('only while the team works the request: a delivered report is put back first, and a closed request takes nothing', async () => {
  for (const [status, error] of [
    ['DELIVERED', /already marked delivered\. Put it back in progress/],
    ['COMPLETED', /The company completed this request/],
    ['CANCELLED', /The company cancelled this request/],
  ] as const) {
    const { id, token } = await openRequest(harbor, status);
    if (status !== 'DELIVERED') await run('UPDATE valuation_requests SET closed_at = ? WHERE id = ?', new Date().toISOString(), id);
    const r = await upload(token, reportPdf());
    assert.equal(r.status, 400, status);
    assert.match(r.json.error, error);
    const removed = await desk('DELETE', '/report', token);
    assert.equal(removed.status, 400, status);
    assert.equal((await requestRow(id))!.report_document_id, null);
    if (status === 'DELIVERED') await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
  }
  // A request just made, not yet started, takes one.
  const fresh = await openRequest(harbor, 'REQUESTED');
  assert.equal((await upload(fresh.token, reportPdf())).status, 200);
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), fresh.id);
});

test('only a PDF, and nothing empty or past the size limit', async () => {
  const { id, token } = await openRequest(harbor);
  const png = await upload(token, Buffer.from('\x89PNG\r\n\x1a\n made-up image', 'latin1'), 'report.png');
  assert.equal(png.status, 400);
  assert.equal(png.json.error, 'Upload the report as a PDF.');
  const empty = await upload(token, Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /empty/);
  try {
    configure({ limits: { uploadMb: 1 } });
    const big = await upload(token, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 + 10, 0x20)]));
    assert.equal(big.status, 413);
    assert.match(big.json.error, /too large/);
  } finally {
    offerTheDesk();
  }
  assert.equal((await requestRow(id))!.report_document_id, null);
  assert.equal(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'DESK_UPLOAD'`, id), undefined, 'a refused upload is not counted');
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('a PDF with no text to read is kept, and says plainly that nothing was read', async () => {
  const { id, token } = await openRequest(harbor);
  const r = await upload(token, Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'), 'Scanned report.pdf');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.detected, { readable: false, fairMarketValue: null, valuationDate: null, method: null, candidates: { fairMarketValue: [], valuationDate: [] } });
  assert.equal(r.json.report.document.name, 'Scanned report.pdf');
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('uploads are limited per request per day, and 0 turns them off', async () => {
  const { id, token } = await openRequest(harbor);
  try {
    configure({ valuationDesk: { reportUploadsPerRequestPerDay: 2 } });
    assert.equal((await upload(token, reportPdf())).status, 200);
    assert.equal((await upload(token, reportPdf())).status, 200);
    const third = await upload(token, reportPdf());
    assert.equal(third.status, 400);
    assert.match(third.json.error, /uploaded to this request, or tried, twice today\. Try again tomorrow, or send it to the company by email\./);
    // Another request has its own allowance.
    const other = await openRequest(harbor);
    assert.equal((await upload(other.token, reportPdf())).status, 200);
    await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), other.id);

    assert.equal(publicConfig().valuationDesk.reportUploads, true);
    configure({ valuationDesk: { reportUploadsPerRequestPerDay: 0 } });
    await forgetUploads();
    const off = await upload(token, reportPdf());
    assert.equal(off.status, 400);
    assert.match(off.json.error, /turned off on this server\. Send it to the company by email instead\./);
    // And the team's page, which reads the same setting, does not offer an upload.
    assert.equal(publicConfig().valuationDesk.reportUploads, false);
  } finally {
    offerTheDesk();
  }
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('a new upload replaces the last, which leaves the vault unless something else uses it', async () => {
  await forgetUploads();
  const { id, token } = await openRequest(harbor);
  const first = (await upload(token, reportPdf('$0.40'), 'Draft one.pdf')).json.report.document.id as string;
  const second = await upload(token, reportPdf('$0.41'), 'Draft two.pdf');
  assert.equal(second.json.detected.fairMarketValue.value, 410_000);
  const secondId = second.json.report.document.id as string;
  assert.equal(await documentRow(first), undefined, 'the draft it replaced is gone');
  assert.equal(await one('SELECT document_id FROM file_blobs WHERE document_id = ?', first), undefined, 'and its file with it');

  // Someone at the company files the second draft as an earlier valuation's report.
  const earlier = await call('POST', `/api/c/${harbor}/valuations`, { type: '409A', fairMarketValue: 300_000, effectiveDate: '2025-03-01', status: 'SUPERSEDED' }, admin);
  assert.equal(earlier.status, 200, JSON.stringify(earlier.json));
  assert.equal((await call('PUT', `/api/c/${harbor}/valuations/${earlier.json.id}/report`, { documentId: secondId }, admin)).status, 200);
  const third = await upload(token, reportPdf('$0.42'), 'Final.pdf');
  assert.equal(third.status, 200);
  assert.ok(await documentRow(secondId), 'a document a valuation uses stays');
  assert.equal((await requestRow(id))!.report_document_id, third.json.report.document.id);

  // And one another request sent to the team stays too.
  const thirdId = third.json.report.document.id as string;
  const other = await openRequest(harbor);
  await run(`INSERT INTO valuation_request_documents (request_id, company_id, document_id, item, created_at) VALUES (?, ?, ?, 'PRIOR_VALUATIONS', ?)`,
    other.id, harbor, thirdId, new Date().toISOString());
  assert.equal((await upload(token, reportPdf('$0.43'), 'Final, corrected.pdf')).status, 200);
  assert.ok(await documentRow(thirdId), 'a document a request sent stays');

  // The team takes its upload back: the file goes, and the request has no report.
  const latest = (await requestRow(id))!.report_document_id!;
  const removed = await desk('DELETE', '/report', token);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(removed.json.report, null);
  assert.equal(await documentRow(latest), undefined);
  assert.deepEqual(await requestRow(id), { status: 'IN_PROGRESS', report_document_id: null, report_detected: null, report_fmv: null, report_method: null });
  assert.match((await one<{ detail: string }>(`SELECT detail FROM audit_log WHERE entity_id = ? AND action = 'DESK_REMOVE_UPLOAD'`, id))!.detail,
    /removed the report it uploaded \("Final, corrected\.pdf"\)/);
  assert.equal((await desk('DELETE', '/report', token)).status, 200, 'pressed twice');
  assert.equal((await desk('GET', '/report', token)).status, 404);
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id IN (?, ?)`, new Date().toISOString(), id, other.id);
});

test('a draft someone at the company has filed, shared, renamed, reclassified or moved stays when the team replaces or removes it', async () => {
  await forgetUploads();
  const company = await newCompany('Kestrel Instruments');
  const [holder] = (await call('GET', `/api/c/${company}/stakeholders`, undefined, admin)).json;
  const { id, token } = await openRequest(company);
  const uploaded = async (fileName: string) => {
    const r = await upload(token, reportPdf(), fileName);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.report.document.id as string;
  };
  const edit = async (docId: string, body: Record<string, unknown>) =>
    assert.equal((await call('PATCH', `/api/c/${company}/documents/${docId}`, body, admin)).status, 200);

  // Through the vault's own page. Filed against a holder, then replaced by a new upload.
  const filed = await uploaded('Draft one.pdf');
  await edit(filed, { stakeholderId: holder.id });
  const shared = await uploaded('Draft two.pdf');
  assert.ok(await documentRow(filed), 'a report filed against a holder stays');
  assert.equal((await requestRow(id))!.report_document_id, shared);

  // Shared with everyone, then removed by the team.
  await edit(shared, { visibility: 'ALL' });
  assert.equal((await desk('DELETE', '/report', token)).status, 200);
  assert.ok(await documentRow(shared), 'a report shared with everyone stays');
  assert.equal((await requestRow(id))!.report_document_id, null, 'though the request no longer points at it');

  // Only renamed, or only moved to another folder: a choice someone at the company made is a use too.
  const renamed = await uploaded('Draft three.pdf');
  await edit(renamed, { name: 'Ledgerline 409A, draft' });
  const moved = await uploaded('Draft four.pdf');
  await edit(moved, { folder: 'Board' });
  await uploaded('Draft five.pdf');
  assert.ok(await documentRow(renamed), 'a report renamed in the vault stays');
  assert.ok(await documentRow(moved), 'a report moved to another folder stays');

  // However a later change reaches the file, even without the stamp the vault puts
  // on its own edits, each of these is a use. Every upload replaces the one before.
  await forgetUploads();
  const uses: [string, string, unknown[]][] = [
    ['filed against a holding', 'security_id = ?', ['sec_made_up']],
    ['filed against a holder', 'stakeholder_id = ?', [holder.id]],
    ['filed against a compliance subject', 'subject_kind = ?, subject_ref = ?', ['ISO_100K', String(new Date().getFullYear())]],
    ['shared with everyone', 'visibility = ?', ['ALL']],
    ['reclassified', 'category = ?', ['OTHER']],
    ['moved to another folder', 'folder = ?', ['Board']],
    ['renamed', 'name = ?', ['Ledgerline 409A, final']],
  ];
  const kept: [string, string][] = [];
  for (const [what, set, values] of uses) {
    const docId = await uploaded(`Draft, ${what}.pdf`);
    await run(`UPDATE documents SET ${set} WHERE id = ?`, ...values, docId);
    assert.equal((await documentRow(docId))!.updated_at, null);
    kept.push([docId, what]);
  }
  const untouched = await uploaded('Final.pdf');
  for (const [docId, what] of kept) assert.ok(await documentRow(docId), `a report ${what} stays`);

  // And a draft just as the upload left it is replaced outright.
  await uploaded('Final, corrected.pdf');
  assert.equal(await documentRow(untouched), undefined, 'an untouched draft leaves the vault');
  await closeRequests(id);
});

test('two uploads at once to one request: the second is turned away, and only the first is counted', async () => {
  await forgetUploads();
  const { id, token } = await openRequest(harbor);
  const [a, b] = await Promise.all([upload(token, reportPdf('$0.40'), 'One.pdf'), upload(token, reportPdf('$0.41'), 'Two.pdf')]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 429], JSON.stringify([a.json, b.json]));
  const refused = a.status === 429 ? a : b;
  assert.match(refused.json.error, /already being uploaded to this request\. Wait for it to finish, then try again\./);
  assert.equal((await all(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'DESK_UPLOAD'`, id)).length, 1);
  // Once the first is done, the next goes through.
  assert.equal((await upload(token, reportPdf('$0.42'), 'Three.pdf')).status, 200);
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('one report is read at a time on the server: an upload that comes meanwhile is turned away unread, and not counted', async () => {
  await forgetUploads();
  const company = await newCompany('Larkspur Devices');
  const requests = [await openRequest(company), await openRequest(company), await openRequest(company)];
  try {
    configure({ valuationDesk: { reportUploadsPerRequestPerDay: 1 } });
    // Three teams' uploads at once. A reading takes a good part of a second, and the
    // checks before it a few milliseconds, so the first to start is still being read
    // when the others ask.
    const answers = await Promise.all(requests.map((r, n) => upload(r.token, reportPdf(), `Report ${n + 1}.pdf`)));
    const summary = JSON.stringify(answers.map((a) => [a.status, a.json?.error]));
    assert.ok(answers.some((a) => a.status === 200), summary);
    assert.ok(answers.some((a) => a.status === 429), summary);
    for (const [n, a] of answers.entries()) {
      if (a.status === 200) continue;
      assert.equal(a.status, 429, summary);
      assert.equal(a.json.error, 'Another report is being read. Try again in a moment.');
      assert.equal((await requestRow(requests[n].id))!.report_document_id, null);
      assert.equal(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'DESK_UPLOAD'`, requests[n].id), undefined);
      // Never read, so never counted: with one upload a day, the request still takes its one.
      const again = await upload(requests[n].token, reportPdf());
      assert.equal(again.status, 200, JSON.stringify(again.json));
    }
  } finally {
    offerTheDesk();
  }
  await closeRequests(...requests.map((r) => r.id));
});

test('an upload counts toward the day’s limit from when its file is read, saved or not', async () => {
  await forgetUploads();
  const company = await newCompany('Fernhill Instruments');
  const { id, token } = await openRequest(company);
  const vault = async () => (await all(`SELECT id FROM documents WHERE company_id = ? AND category = 'VALUATION'`, company)).length;
  try {
    configure({ valuationDesk: { reportUploadsPerRequestPerDay: 1 } });
    // While the company's lock is held, an upload is read and then waits to be saved.
    // Before the lock is let go, the team marks the report delivered from another tab.
    const lock = holdCompany(company, () => run(`UPDATE valuation_requests SET status = 'DELIVERED' WHERE id = ?`, id));
    await lock.holding;
    let first: ReturnType<typeof upload> | undefined;
    try {
      first = upload(token, reportPdf('$0.40'), 'One.pdf');
      await someoneWaits();
      // Meanwhile a second upload to the request finds the first already counted.
      const second = await upload(token, reportPdf('$0.41'), 'Two.pdf');
      assert.equal(second.status, 400, JSON.stringify(second.json));
      assert.match(second.json.error, /uploaded to this request, or tried, once today\. Try again tomorrow/);
    } finally {
      // Let go whatever happened above, so a failure here cannot leave the upload waiting forever.
      lock.release();
      await lock.done;
    }

    // The first is refused once it has the lock, and it still counts.
    const refused = await first;
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.match(refused.json.error, /already marked delivered/);
    await run(`UPDATE valuation_requests SET status = 'IN_PROGRESS' WHERE id = ?`, id);
    const third = await upload(token, reportPdf('$0.42'), 'Three.pdf');
    assert.equal(third.status, 400, JSON.stringify(third.json));
    assert.match(third.json.error, /or tried, once today/);
    assert.equal(await vault(), 0, 'nothing was saved');
    assert.equal(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'DESK_UPLOAD'`, id), undefined);

    // It counted once and no more: with two a day, the next goes through.
    configure({ valuationDesk: { reportUploadsPerRequestPerDay: 2 } });
    const fourth = await upload(token, reportPdf('$0.43'), 'Four.pdf');
    assert.equal(fourth.status, 200, JSON.stringify(fourth.json));
    assert.equal(await vault(), 1);
  } finally {
    offerTheDesk();
  }
  await closeRequests(id);
});

// --- Delivering ---------------------------------------------------------------------

test('delivering keeps the fair market value and method the team gives, and putting it back clears them and lets go of the upload', async () => {
  await forgetUploads();
  const { id, token } = await openRequest(harbor);
  const docId = (await upload(token, reportPdf())).json.report.document.id as string;

  for (const [fairMarketValue, error] of [[-1, /above zero/], [0, /above zero/], [0.5, /above zero/], ['420000', /above zero/], [2e12, /above zero/]] as const) {
    const r = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue });
    assert.equal(r.status, 400, String(fairMarketValue));
    assert.match(r.json.error, error);
  }
  const long = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, method: 'x'.repeat(121) });
  assert.equal(long.status, 400);
  assert.match(long.json.error, /120 characters/);
  assert.equal((await requestRow(id))!.status, 'IN_PROGRESS', 'nothing refused was saved');

  outbox.length = 0;
  const delivered = await desk('POST', '/status', token, {
    action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue: 420_000, method: '  OPM\n backsolve ',
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  assert.equal(delivered.json.emailed, 'failed', 'tried, with no transport to deliver it');
  assert.deepEqual(await requestRow(id), {
    status: 'DELIVERED', report_document_id: docId, report_detected: (await requestRow(id))!.report_detected, report_fmv: 420_000, report_method: 'OPM backsolve',
  });
  assert.equal(delivered.json.report.fairMarketValue, 420_000);
  assert.equal(delivered.json.report.method, 'OPM backsolve');
  const seen = await companyRequest(harbor, id);
  assert.equal(seen.status, 'DELIVERED');
  assert.deepEqual([seen.appraiser, seen.reportDate, seen.report.fairMarketValue, seen.report.method, seen.report.document.id],
    ['Ledgerline Valuations', VALUED_AS_OF, 420_000, 'OPM backsolve', docId]);

  // The email states the team's price and says where the report is.
  const email = outbox.find((m) => m.to === 'avery@example.com')!;
  assert.equal(email.subject, 'Your 409A report for Harbor Robotics, Inc. is ready');
  assert.match(email.text, /Fair market value: +\$0\.4200 per common share/);
  assert.match(email.text, /Valuation date: +/);
  assert.match(email.text, /The report is on the 409A page in .+, not attached to this email\./);
  assert.match(email.text, /^Check the values against the report on the 409A page in .+, then record the 409A from them\./m);
  for (const who of HOLDERS) {
    assert.ok(!email.text.includes(who), `the email names ${who}`);
    assert.ok(!JSON.stringify(delivered.json).includes(who), `the team's page names ${who}`);
  }
  // An upload is not possible once delivered.
  assert.equal((await upload(token, reportPdf())).status, 400);

  outbox.length = 0;
  const reopened = await desk('POST', '/status', token, { action: 'REOPEN', message: 'Correcting the date.' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
  assert.deepEqual(await requestRow(id), { status: 'IN_PROGRESS', report_document_id: null, report_detected: null, report_fmv: null, report_method: null });
  assert.equal(reopened.json.report, null);
  assert.equal((await companyRequest(harbor, id)).report, null);
  // The company has had the delivered file, untouched or not, so it stays in the vault.
  const kept = (await documentRow(docId))!;
  assert.ok(kept, 'the delivered report stays in the vault');
  assert.equal(kept.updated_at, null, 'though nobody at the company touched it');

  // What the team uploads after that is a draft again, and goes when it is replaced before delivery.
  const draft = (await upload(token, reportPdf('$0.43'), 'Corrected draft.pdf')).json.report.document.id as string;
  assert.equal((await upload(token, reportPdf('$0.44'), 'Corrected.pdf')).status, 200);
  assert.equal(await documentRow(draft), undefined, 'the replaced draft leaves the vault');
  assert.ok(await documentRow(docId), 'the delivered report is still there');
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('a report delivered without an upload is emailed as before, with no price the team did not give', async () => {
  const { id, token } = await openRequest(harbor);
  outbox.length = 0;
  const r = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue: '' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.report, null);
  const email = outbox.find((m) => m.to === 'avery@example.com')!;
  assert.match(email.text, /The report itself comes from the team, not with this email\./);
  assert.doesNotMatch(email.text, /Fair market value:/);
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

// --- The company's side ----------------------------------------------------------------

test('a reader the vault keeps the report from sees the team’s figures, but not the file or what was read from it', async () => {
  await forgetUploads();
  const { id, token } = await openRequest(harbor);
  await upload(token, reportPdf());
  await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue: 420_000 });
  const added = await call('POST', `/api/c/${harbor}/members`, { email: 'rowan.hale@example.com', name: 'Rowan Hale', role: 'VIEWER' }, admin);
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const link = await call('POST', `/api/c/${harbor}/members/${added.json.id}/reset-password`, { mode: 'link' }, admin);
  const reset = await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: 'member-pass-1' });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  const seen = await companyRequest(harbor, id, reset.token);
  assert.deepEqual(seen.report, { document: null, detected: null, fairMarketValue: 420_000, method: null });
  const docId = (await companyRequest(harbor, id)).report.document?.id as string;
  assert.ok(docId, 'an administrator sees it');

  // Shared with everyone from the vault, it is the viewer's to read too, and the page is told so.
  assert.equal((await call('PATCH', `/api/c/${harbor}/documents/${docId}`, { visibility: 'ALL' }, admin)).status, 200);
  const shared = (await companyRequest(harbor, id, reset.token)).report;
  assert.deepEqual([shared.document?.id, shared.document?.visibility, shared.detected?.fairMarketValue?.value], [docId, 'ALL', 420_000]);
  await run(`UPDATE valuation_requests SET status = 'CANCELLED', closed_at = ? WHERE id = ?`, new Date().toISOString(), id);
});

test('recording the 409A completes the request and attaches the report, to this company’s valuation and no other', async () => {
  await forgetUploads();
  const { id, token } = await openRequest(harbor);
  const docId = (await upload(token, reportPdf())).json.report.document.id as string;
  await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue: 420_000, method: 'OPM backsolve' });

  // Another company, with its own request and upload, tries to complete against Harbor's valuation.
  const other = await newCompany('Tidewater Labs');
  const theirs = await openRequest(other);
  const theirDoc = (await upload(theirs.token, reportPdf('$0.55'))).json.report.document.id as string;

  const recorded = await call('POST', `/api/c/${harbor}/valuations`, {
    type: '409A', fairMarketValue: 420_000, effectiveDate: VALUED_AS_OF, provider: 'Ledgerline Valuations', method: 'OPM backsolve', status: 'ACTIVE',
  }, admin);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
  const crossed = await call('PATCH', `/api/c/${other}/valuation-requests/${theirs.id}`, { status: 'COMPLETED', valuationId: recorded.json.id }, admin);
  assert.equal(crossed.status, 400);
  assert.equal((await one<{ report_document_id: string | null }>('SELECT report_document_id FROM valuations WHERE id = ?', recorded.json.id))!.report_document_id, null,
    'Harbor’s valuation is untouched');

  const completed = await call('PATCH', `/api/c/${harbor}/valuation-requests/${id}`, { status: 'COMPLETED', valuationId: recorded.json.id }, admin);
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  assert.equal(completed.json.status, 'COMPLETED');
  assert.equal(completed.json.reportAttached, true, 'the answer says the report went onto the 409A');
  const report = await call('GET', `/api/c/${harbor}/valuations/${recorded.json.id}/report`, undefined, admin);
  assert.equal(report.json.document.id, docId, 'the 409A carries the report the team uploaded');
  assert.ok(await one(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'UPDATE' AND detail LIKE 'Report set to the document%'`, recorded.json.id));
  assert.equal(completed.json.report.document.id, docId, 'the closed request still shows the report');
  assert.ok(await documentRow(theirDoc), 'the other company’s upload is where it was');
});

test('a valuation that already has a report keeps it when a delivered request completes against it', async () => {
  await forgetUploads();
  const company = await newCompany('Brightwater Labs');
  /** A request the team has delivered with an upload, as the attach needs. */
  const delivered = async (price: string) => {
    const r = await openRequest(company);
    const docId = (await upload(r.token, reportPdf(price))).json.report.document.id as string;
    const d = await desk('POST', '/status', r.token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue: 550_000 });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    return { ...r, docId };
  };

  // A link.
  const linked = await delivered('$0.55');
  const withLink = await call('POST', `/api/c/${company}/valuations`, {
    type: '409A', fairMarketValue: 550_000, effectiveDate: VALUED_AS_OF, status: 'ACTIVE', reportUrl: 'https://reports.example.com/brightwater',
  }, admin);
  const done = await call('PATCH', `/api/c/${company}/valuation-requests/${linked.id}`, { status: 'COMPLETED', valuationId: withLink.json.id }, admin);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.reportAttached, false);
  const kept = await call('GET', `/api/c/${company}/valuations/${withLink.json.id}/report`, undefined, admin);
  assert.deepEqual([kept.json.document, kept.json.url], [null, 'https://reports.example.com/brightwater']);

  // A document of its own in the vault.
  const filed = await delivered('$0.56');
  const own = await call('POST', `/api/c/${company}/documents`, { name: 'Signed 409A report', category: 'VALUATION', body: 'The signed copy.' }, admin);
  assert.equal(own.status, 200, JSON.stringify(own.json));
  const withDocument = await call('POST', `/api/c/${company}/valuations`, { type: '409A', fairMarketValue: 560_000, effectiveDate: VALUED_AS_OF, status: 'ACTIVE' }, admin);
  assert.equal((await call('PUT', `/api/c/${company}/valuations/${withDocument.json.id}/report`, { documentId: own.json.id }, admin)).status, 200);
  const completed = await call('PATCH', `/api/c/${company}/valuation-requests/${filed.id}`, { status: 'COMPLETED', valuationId: withDocument.json.id }, admin);
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  assert.equal(completed.json.reportAttached, false);
  const stays = await call('GET', `/api/c/${company}/valuations/${withDocument.json.id}/report`, undefined, admin);
  assert.equal(stays.json.document.id, own.json.id, 'the valuation’s own report stays');
  assert.ok(await documentRow(filed.docId), 'and the upload stays in the vault');
});

test('a delivered request whose upload was deleted from the vault shows no file, and completing attaches nothing', async () => {
  await forgetUploads();
  const company = await newCompany('Quiet Harbor');
  const { id, token } = await openRequest(company);
  const docId = (await upload(token, reportPdf())).json.report.document.id as string;
  const d = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue: 420_000 });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal((await call('DELETE', `/api/c/${company}/documents/${docId}`, undefined, admin)).status, 200);
  assert.equal((await requestRow(id))!.report_document_id, null, 'the pointer goes with the document');
  assert.deepEqual((await companyRequest(company, id)).report, { document: null, detected: null, fairMarketValue: 420_000, method: null });
  const v = await call('POST', `/api/c/${company}/valuations`, { type: '409A', fairMarketValue: 420_000, effectiveDate: VALUED_AS_OF, status: 'ACTIVE' }, admin);
  const done = await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'COMPLETED', valuationId: v.json.id }, admin);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.reportAttached, false);
  assert.equal((await call('GET', `/api/c/${company}/valuations/${v.json.id}/report`, undefined, admin)).json.document, null);
});

test('a request completed before the team delivered leaves its draft upload off the 409A', async () => {
  await forgetUploads();
  const company = await newCompany('Saltmarsh Analytics');
  const { id, token } = await openRequest(company);
  const docId = (await upload(token, reportPdf())).json.report.document.id as string;
  // The company records a 409A from another appraiser while the team is still working.
  const v = await call('POST', `/api/c/${company}/valuations`, { type: '409A', fairMarketValue: 390_000, effectiveDate: VALUED_AS_OF, status: 'ACTIVE' }, admin);
  const done = await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'COMPLETED', valuationId: v.json.id }, admin);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.reportAttached, false);
  assert.equal((await call('GET', `/api/c/${company}/valuations/${v.json.id}/report`, undefined, admin)).json.document, null,
    'the team never delivered that file, so it is not this 409A’s report');
  assert.ok(await documentRow(docId), 'the upload stays in the vault');
});

test('completing from a page that read the request before the team put the report back or delivered it again is refused', async () => {
  await forgetUploads();
  const company = await newCompany('Marsh Lane Robotics');
  const { id, token } = await openRequest(company);
  const deliver = async (fairMarketValue: number) => {
    const d = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: VALUED_AS_OF, fairMarketValue });
    assert.equal(d.status, 200, JSON.stringify(d.json));
  };
  const firstDoc = (await upload(token, reportPdf())).json.report.document.id as string;
  await deliver(420_000);
  // The company opens the record form from the request as it reads it now.
  const opened = await companyRequest(company, id);
  assert.equal(opened.status, 'DELIVERED');

  const v = await call('POST', `/api/c/${company}/valuations`, { type: '409A', fairMarketValue: 420_000, effectiveDate: VALUED_AS_OF, status: 'ACTIVE' }, admin);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const complete = (updatedAt: unknown) =>
    call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'COMPLETED', valuationId: v.json.id, updatedAt }, admin);
  const reportOf = async () => (await call('GET', `/api/c/${company}/valuations/${v.json.id}/report`, undefined, admin)).json.document;

  // Meanwhile the team puts the report back in progress to correct it.
  assert.equal((await desk('POST', '/status', token, { action: 'REOPEN', message: 'Correcting the date.' })).status, 200);
  const reopened = await complete(opened.updatedAt);
  assert.equal(reopened.status, 409, JSON.stringify(reopened.json));
  assert.equal(reopened.json.error,
    'This request changed after you opened it, and its report is not marked delivered now. Look at the request again before completing it.');
  assert.equal((await requestRow(id))!.status, 'IN_PROGRESS', 'the request is not completed');
  assert.equal(await reportOf(), null, 'and the 409A carries nothing');

  // The team delivers a corrected report. The page that read the first is still refused, and told why.
  const secondDoc = (await upload(token, reportPdf('$0.43'), 'Corrected.pdf')).json.report.document.id as string;
  await deliver(430_000);
  const redelivered = await complete(opened.updatedAt);
  assert.equal(redelivered.status, 409, JSON.stringify(redelivered.json));
  assert.equal(redelivered.json.error,
    'The valuation team delivered the report after you opened this request. Check the 409A against the report as it is now, then complete the request.');
  assert.equal(await reportOf(), null);
  assert.equal((await complete(Date.now())).status, 400, 'only the page’s own reading is compared');

  // Read again, it completes, and the answer says the corrected report went onto the 409A.
  const done = await complete((await companyRequest(company, id)).updatedAt);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.status, 'COMPLETED');
  assert.equal(done.json.reportAttached, true);
  assert.equal((await reportOf()).id, secondDoc);
  assert.ok(await documentRow(firstDoc), 'the report delivered first stays in the vault');
});
