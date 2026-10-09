/**
 * New 409A requests stop at an internal approval step. Every email in this
 * suite goes to a stand-in SMTP server on localhost, never to a real inbox.
 * The tests exercise the real create, send, review, approve and evaluator APIs.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { freshDatabase, sessionCookie } from './helpers.ts';

// --- A mail server that keeps what it is sent and turns some addresses away ------

interface Received { to: string; subject: string; replyTo: string | null; toHeader: string; text: string }
/** Every message the stand-in accepted, in the order it read them. */
const received: Received[] = [];
/** Addresses the stand-in refuses at RCPT TO, as a mailbox that does not exist is refused. */
const refused = new Set<string>();

/** The headers and the plain-text part of a message as buildMessage writes it. */
function readMessage(to: string, lines: string[]): Received {
  const blank = lines.indexOf('');
  const headers = lines.slice(0, blank);
  const header = (name: string) => headers.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
  const start = lines.indexOf('Content-Type: text/plain; charset=utf-8') + 3;
  const base64: string[] = [];
  for (let i = start; i < lines.length && lines[i] && !lines[i].startsWith('--'); i++) base64.push(lines[i]);
  return { to, subject: header('Subject') ?? '', replyTo: header('Reply-To'), toHeader: header('To') ?? '', text: Buffer.from(base64.join(''), 'base64').toString('utf8') };
}

const smtp: Server = createServer((socket: Socket) => {
  let inData = false;
  let buffer = '';
  let to = '';
  let data: string[] = [];
  socket.write('220 stand-in ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          received.push(readMessage(to, data));
          data = [];
          socket.write('250 2.0.0 queued\r\n');
        } else data.push(line.startsWith('..') ? line.slice(1) : line);
        continue;
      }
      if (/^EHLO /.test(line)) socket.write('250-stand-in\r\n250 8BITMIME\r\n');   // no STARTTLS: allowed on localhost
      else if (/^MAIL FROM:/.test(line)) socket.write('250 ok\r\n');
      else if (/^RCPT TO:/.test(line)) {
        to = line.match(/<([^>]*)>/)?.[1] ?? '';
        socket.write(refused.has(to) ? '550 5.1.1 no such mailbox here\r\n' : '250 ok\r\n');
      } else if (line === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 what\r\n');
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
after(() => smtp.close());

// Mail goes to the stand-in and nowhere else. These win over apps/server/.env.
process.env.SMTP_URL = `smtp://127.0.0.1:${(smtp.address() as AddressInfo).port}`;
process.env.ACS_CONNECTION_STRING = '';
// Three made-up evaluators, the first written twice in another case: each is mailed once.
const TEAM_ENV = 'Lead@Example.test, second@example.test, third@example.test, lead@example.test';
const TEAM = ['lead@example.test', 'second@example.test', 'third@example.test'];
process.env.VALUATION_DESK_EMAIL = TEAM_ENV;
process.env.VALUATION_APPROVAL_EMAIL = 'review@example.test';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/files.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/valuation-requests.ts');
const { composeApprovalEmail } = await import('../src/routes/valuation-requests.ts');
const { configure, resetConfig, config } = await import('../src/config.ts');
const { run, one, all } = await import('../src/db.ts');

/**
 * The service on, with the waits between sends and the limits for one person
 * out of the way, since one person runs every test here. A test about a limit
 * sets it again.
 */
const offerTheDesk = (changes: Record<string, unknown> = {}) => {
  resetConfig();
  configure({
    valuationDesk: {
      enabled: true, sendCooldownSeconds: 0, resendCooldownMinutes: 0, requestsPerCompanyPerDay: 100, requestsPerPersonPerDay: 100,
      noticesPerCompanyPerDay: 100, noticesPerPersonPerDay: 100, noticesPerHour: 100, ...changes,
    },
  });
};
offerTheDesk();

const api: HttpServer = createHttpServer((req, res) => { void handle(req, res); });
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
const deskPage = (token: string) => call('GET', '/api/valuation-desk', undefined, null, { 'X-Desk-Token': token });

const tokenIn = (text: string): string => text.match(/\/409a-desk#([A-Za-z0-9_-]{43})/)![1];
const notices = () => received.filter((m) => m.subject.startsWith('New 409A request'));
/** The closing notices about one company's request; a close elsewhere sends its own, in its own time. */
const closings = (company: string) => received.filter((m) => m.subject.startsWith(`409A request closed: ${company}`));

/**
 * Runs fn while the stand-in turns these addresses away, with what the server
 * logs about it kept rather than printed.
 */
async function whileRefusing<T>(addresses: string[], fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  for (const a of addresses) refused.add(a);
  try {
    return { result: await fn(), logged };
  } finally {
    refused.clear();
    console.error = realError;
  }
}

// --- A company and a complete request, all made up --------------------------------

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;

/** The appraiser's information request, answered in full, as the form sends it before the documents. */
const ANSWERS = {
  valuationDateKind: 'LATEST', valuationDate: null,
  companySize: '11-50', stage: 'SERIES_A', plans: 'OPTIONS', plansTiming: 'ONE_TO_THREE', optionsToGrant: 250_000,
  last409a: 'DATE', last409aDate: '2025-03-01',
  noFullYearYet: false, convertiblesOutstanding: false, projections: 'FILE', guidance: [], capTableConfirmed: true,
  management: [{ name: 'Avery Stone', title: 'Chief executive officer' }],
  sweatEquity: false, sweatEquityPeople: [], secondary: false, secondaryTransactions: [], belowMarketExpenses: false, expenses: [],
  software: 'Spreadsheets',
  contactName: 'Avery Stone', contactEmail: 'finance@harbor.example.com', contactPhone: '+1 (415) 555-0142',
  notes: null,
};
const FILES: Record<string, [string, string]> = {
  HISTORICAL_FINANCIALS: ['Financial statements.pdf', 'OTHER'],
  YTD_FINANCIALS: ['Year-to-date accounts.pdf', 'OTHER'],
  PITCH_DECK: ['Company presentation.pdf', 'OTHER'],
  PRIOR_VALUATIONS: ['409A report.pdf', 'VALUATION'],
  CHARTER: ['Certificate of incorporation.pdf', 'CHARTER'],
  PROJECTIONS: ['Projections.pdf', 'OTHER'],
};

async function upload(companyId: string, fileName: string, category: string) {
  const params = new URLSearchParams({ name: fileName, category, folder: '409A request' });
  const res = await fetch(`${base}/api/c/${companyId}/documents/upload?${params}`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/pdf' },
    body: new Uint8Array(Buffer.from(`%PDF-1.4 ${fileName} of ${companyId}`)) as unknown as RequestInit['body'],
  });
  const json = await res.json() as { id: string };
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.id;
}

/** A company of its own with a founder's shares, and an open request for it, made and not yet sent. */
async function newRequest(name: string, changes: Record<string, unknown> = {}): Promise<{ cid: string; id: string }> {
  const cid = (await call('POST', '/api/companies', { name }, admin)).json.id as string;
  const stock = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
  const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Sam Quill', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json;
  await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: founder.id, shareClassId: stock.id, quantity: 5_000_000, issueDate: '2024-01-10' }, admin);
  const documents: { item: string; documentId: string }[] = [];
  for (const [item, [fileName, category]] of Object.entries(FILES)) documents.push({ item, documentId: await upload(cid, fileName, category) });
  const made = await call('POST', `/api/c/${cid}/valuation-requests`, { ...ANSWERS, documents, ...changes }, admin);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.approvalRequired, true);
  assert.equal(made.json.approvedAt, null);
  assert.equal(made.json.approvalNotifiedAt, null);
  assert.equal(made.json.status, 'REQUESTED');
  return { cid, id: made.json.id };
}
const send = (r: { cid: string; id: string }, again = false) =>
  call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/send`, again ? { again: true } : {}, admin);
// --- Internal review -----------------------------------------------------------

const approvals = () => received.filter((m) => m.subject.startsWith('409A request awaiting approval:'));
const approvalTokenIn = (text: string): string => {
  const match = text.match(/\/409a-approval#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/);
  assert.ok(match, 'the reviewer receives a private approval link');
  return match[1];
};
const approval = (method: string, path: string, token: string, body?: unknown) =>
  call(method, `/api/valuation-approval${path}`, body, null, { 'X-Approval-Token': token });
const approve = (token: string) => approval('POST', '/approve', token, {});
const rowOf = (id: string) => one<any>('SELECT * FROM valuation_requests WHERE id = ?', id);
const approvalEvents = (id: string) => all<any>(
  "SELECT * FROM valuation_request_events WHERE request_id = ? AND kind = 'APPROVED'", id);
const approvalAudits = (id: string) => all<any>(
  "SELECT * FROM audit_log WHERE entity_id = ? AND action = 'APPROVE_REQUEST'", id);
async function requestedReview(name: string) {
  const request = await newRequest(name);
  received.length = 0;
  const sent = await send(request);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.approval, 'sent');
  return { ...request, token: approvalTokenIn(approvals()[0].text) };
}

test('creating a request saves a pending review without sending anything or trusting approval fields from the browser', async () => {
  received.length = 0;
  const r = await newRequest('Pending Harbor', { approvalRequired: false, approvedAt: new Date().toISOString(), approvedBy: 'Company administrator' });
  assert.equal(approvals().length, 0);
  assert.equal(notices().length, 0);
  assert.equal(received.filter((m) => m.subject.startsWith('Your 409A request')).length, 0);
  const row = await rowOf(r.id);
  assert.equal(row.approval_required, true);
  for (const field of ['approved_at', 'approved_by', 'approval_notified_at', 'approval_token_hash', 'desk_token_hash', 'desk_notified_at']) {
    assert.equal(row[field], null, `${field} is unset until its step happens`);
  }
  const forged = await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, {
    approvedAt: new Date().toISOString(), approvalRequired: false, approvedBy: 'Company administrator',
  }, admin);
  assert.equal(forged.status, 400);
  assert.equal((await rowOf(r.id)).approved_at, null);
});

test('sending reaches only the reviewer and requester; opening the review is read-only and exposes no token or internal inbox', async () => {
  const r = await newRequest('Review Harbor');
  received.length = 0;
  const sent = await send(r);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.deepEqual([sent.json.approval, sent.json.approvalError, sent.json.desk, sent.json.deskError, sent.json.recap],
    ['sent', null, 'not needed', null, 'sent']);
  assert.deepEqual(received.map((m) => m.to).sort(), ['avery@example.com', 'review@example.test']);
  assert.equal(approvals()[0].subject, '409A request awaiting approval: Review Harbor, Inc.');
  const token = approvalTokenIn(approvals()[0].text);
  const recap = received.find((m) => m.to === 'avery@example.com')!;
  assert.match(recap.text, /approv|internal review/i);
  assert.doesNotMatch(recap.text, /409a-approval|review@example\.test|409a-desk/);
  assert.notEqual(recap.replyTo, 'review@example.test');
  const before = await rowOf(r.id);
  assert.ok(before.approval_notified_at);
  assert.ok(before.approval_token_at);
  assert.equal(before.approval_token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(before.approval_email, 'review@example.test');
  assert.equal(before.approved_at, null);
  assert.equal(before.desk_token_hash, null);
  assert.equal(before.desk_notified_at, null);
  const page = await approval('GET', '', token);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.json.companyName, 'Review Harbor, Inc.');
  assert.equal(page.json.canApprove, true);
  assert.equal(page.json.approvedAt, null);
  assert.deepEqual(await rowOf(r.id), before, 'a mail scanner opening the link cannot approve it');
  assert.equal((await approvalEvents(r.id)).length, 0);
  assert.equal(notices().length, 0);
  const list = await call('GET', `/api/c/${r.cid}/valuation-requests`, undefined, admin);
  const audit = await all('SELECT * FROM audit_log WHERE entity_id = ?', r.id);
  for (const visible of [sent.json, page.json, list.json, audit]) {
    const text = JSON.stringify(visible);
    assert.ok(!text.includes(token), 'raw approval token stays out of responses and audit logs');
    assert.ok(!text.includes(before.approval_token_hash), 'token hash stays private too');
    assert.ok(!text.includes('review@example.test'), 'the internal inbox stays private');
  }
  const again = await send(r);
  assert.equal(again.status, 200);
  assert.equal(approvals().length, 1, 'a successful notification is not sent twice without a resend request');
  assert.equal(notices().length, 0, 'resubmitting cannot skip review');
});

test('an explicit approval records one event, sends each evaluator once and remains safe to retry', async () => {
  const r = await requestedReview('Approved Harbor');
  received.length = 0;
  const result = await approve(r.token);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const row = await rowOf(r.id);
  assert.ok(row.approved_at);
  assert.ok(row.approved_by);
  assert.ok(row.desk_notified_at);
  assert.equal(row.status, 'REQUESTED', 'the evaluator still chooses when work starts');
  assert.deepEqual(notices().map((m) => m.to).sort(), [...TEAM].sort());
  assert.equal(new Set(notices().map((m) => tokenIn(m.text))).size, 1);
  assert.equal((await deskPage(tokenIn(notices()[0].text))).status, 200);
  const events = await approvalEvents(r.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].author, 'approval');
  assert.equal(events[0].author_name, 'Internal review team');
  assert.equal((await approvalAudits(r.id)).length, 1);
  const again = await approve(r.token);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal((await rowOf(r.id)).approved_at, row.approved_at);
  assert.equal((await approvalEvents(r.id)).length, 1);
  assert.equal((await approvalAudits(r.id)).length, 1);
  assert.equal(notices().length, TEAM.length, 'a repeated approval does not send successful notices twice');
});

test('concurrent approvals release one evaluator notice and create one approval event', async () => {
  const r = await requestedReview('Concurrent Harbor');
  received.length = 0;
  const answers = await Promise.all([approve(r.token), approve(r.token), approve(r.token)]);
  for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal((await approvalEvents(r.id)).length, 1);
  assert.equal((await approvalAudits(r.id)).length, 1);
  assert.equal(notices().length, TEAM.length);
  assert.ok((await rowOf(r.id)).approved_at);
});

test('review endpoints require their own token header and an approval token grants no evaluator permissions', async () => {
  const r = await requestedReview('Private Harbor');
  const invalid = ['', 'short', 'x'.repeat(43), `${r.token.slice(0, 42)}${r.token.endsWith('A') ? 'B' : 'A'}`];
  for (const token of invalid) {
    assert.equal((await approval('GET', '', token)).status, 404);
    assert.equal((await approve(token)).status, 404);
  }
  assert.equal((await call('GET', `/api/valuation-approval?token=${r.token}`, undefined, admin)).status, 404);
  assert.equal((await call('POST', '/api/valuation-approval/approve', { token: r.token }, admin)).status, 404);
  assert.equal((await deskPage(r.token)).status, 404);
  assert.equal((await call('POST', '/api/valuation-desk/status', { action: 'START' }, null, { 'X-Desk-Token': r.token })).status, 404);
  assert.equal((await call('GET', '/api/valuation-desk/package.xlsx', undefined, null, { 'X-Desk-Token': r.token })).status, 404);
  assert.equal((await rowOf(r.id)).approved_at, null);
  assert.equal(notices().length, 0);
});

test('a stored evaluator token cannot bypass an outstanding approval, even for exports or status changes', async () => {
  const r = await requestedReview('Guarded Harbor');
  const forgedDeskToken = randomBytes(32).toString('base64url');
  await run('UPDATE valuation_requests SET desk_token_hash = ?, desk_token_at = ? WHERE id = ?',
    createHash('sha256').update(forgedDeskToken).digest('hex'), new Date().toISOString(), r.id);
  for (const path of ['', '/package.xlsx', '/documents.zip']) {
    assert.equal((await call('GET', `/api/valuation-desk${path}`, undefined, null, { 'X-Desk-Token': forgedDeskToken })).status, 404);
  }
  const status = await call('POST', '/api/valuation-desk/status', { action: 'START' }, null, { 'X-Desk-Token': forgedDeskToken });
  assert.equal(status.status, 404);
  assert.equal((await rowOf(r.id)).status, 'REQUESTED');
  assert.equal((await approval('GET', '', forgedDeskToken)).status, 404, 'evaluator tokens cannot approve either');
});

test('a failed approval email leaves the request pending and can be retried without reaching the evaluator', async () => {
  const r = await newRequest('Undelivered Review Harbor');
  received.length = 0;
  const { result: failed } = await whileRefusing(['review@example.test'], () => send(r));
  assert.equal(failed.status, 200, JSON.stringify(failed.json));
  assert.equal(failed.json.approval, 'failed');
  assert.ok(failed.json.approvalError);
  assert.equal(failed.json.desk, 'not needed');
  assert.equal((await rowOf(r.id)).approval_notified_at, null);
  assert.equal((await rowOf(r.id)).approved_at, null);
  assert.equal(notices().length, 0);
  const retry = await send(r);
  assert.equal(retry.json.approval, 'sent', JSON.stringify(retry.json));
  assert.equal(approvals().length, 1);
  assert.ok((await rowOf(r.id)).approval_notified_at);
  assert.equal((await rowOf(r.id)).approved_at, null);
  assert.equal(notices().length, 0);
  assert.equal(received.filter((m) => m.subject.startsWith('Your 409A request')).length, 1, 'the already-delivered recap is not repeated');
});

test('an evaluator delivery failure keeps the approval and its link can retry delivery without approving again', async () => {
  const r = await requestedReview('Retry Evaluation Harbor');
  received.length = 0;
  const { result: failed } = await whileRefusing(TEAM, () => approve(r.token));
  assert.equal(failed.status, 200, JSON.stringify(failed.json));
  const approvedAt = (await rowOf(r.id)).approved_at;
  assert.ok(approvedAt, 'review remains approved when the evaluator mailbox is temporarily unavailable');
  assert.equal((await rowOf(r.id)).desk_notified_at, null);
  assert.equal(notices().length, 0);
  assert.equal((await approvalEvents(r.id)).length, 1);
  const retried = await approve(r.token);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(notices().length, TEAM.length);
  assert.equal((await rowOf(r.id)).approved_at, approvedAt);
  assert.ok((await rowOf(r.id)).desk_notified_at);
  assert.equal((await approvalEvents(r.id)).length, 1);
  assert.equal((await approvalAudits(r.id)).length, 1);
  await approve(r.token);
  assert.equal(notices().length, TEAM.length);
});

test('changing the configured reviewer revokes its old link and a resend reaches the new inbox', async () => {
  const r = await requestedReview('Reassigned Review Harbor');
  try {
    configure({ valuationDesk: { approvalEmail: 'replacement@example.test' } });
    assert.equal((await approval('GET', '', r.token)).status, 404);
    assert.equal((await approve(r.token)).status, 404);
    received.length = 0;
    const resent = await send(r, true);
    assert.equal(resent.json.approval, 'sent', JSON.stringify(resent.json));
    assert.deepEqual(approvals().map((m) => m.to), ['replacement@example.test']);
    const replacement = approvalTokenIn(approvals()[0].text);
    assert.notEqual(replacement, r.token);
    assert.equal((await approval('GET', '', r.token)).status, 404);
    assert.equal((await approval('GET', '', replacement)).status, 200);
    assert.equal((await rowOf(r.id)).approval_email, 'replacement@example.test');
    assert.equal((await rowOf(r.id)).approved_at, null);
    assert.equal(notices().length, 0);
  } finally { offerTheDesk(); }
});

test('expired approval links cannot approve and a resend creates a fresh link', async () => {
  const r = await requestedReview('Expired Review Harbor');
  await run('UPDATE valuation_requests SET approval_token_at = ? WHERE id = ?',
    new Date(Date.now() - (config().valuationDesk.linkOpenDays + 1) * 86_400_000).toISOString(), r.id);
  assert.equal((await approval('GET', '', r.token)).status, 404);
  assert.equal((await approve(r.token)).status, 404);
  assert.equal((await rowOf(r.id)).approved_at, null);
  received.length = 0;
  const sent = await send(r, true);
  assert.equal(sent.json.approval, 'sent', JSON.stringify(sent.json));
  const replacement = approvalTokenIn(approvals()[0].text);
  assert.notEqual(replacement, r.token);
  assert.equal((await approval('GET', '', replacement)).status, 200);
  assert.equal((await approve(r.token)).status, 404);
});

test('a cancelled pending request cannot be approved and its evaluator hears nothing', async () => {
  const r = await requestedReview('Cancelled Review Harbor');
  received.length = 0;
  const cancelled = await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
  assert.equal(cancelled.status, 200);
  const result = await approve(r.token);
  assert.ok([400, 404].includes(result.status), JSON.stringify(result.json));
  assert.equal((await rowOf(r.id)).approved_at, null);
  assert.equal((await approvalEvents(r.id)).length, 0);
  assert.equal(notices().length, 0);
  assert.equal(closings('Cancelled Review Harbor').length, 0, 'evaluators are not told to close a request they never received');
});

test('a concurrent cancel and approval never records approval after the close', async () => {
  const r = await requestedReview('Closing Review Race Harbor');
  received.length = 0;
  const [cancelled, approved] = await Promise.all([
    call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin),
    approve(r.token),
  ]);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.ok([200, 400, 404].includes(approved.status), JSON.stringify(approved.json));
  const row = await rowOf(r.id);
  assert.equal(row.status, 'CANCELLED');
  const events = await all<{ kind: string }>('SELECT kind FROM valuation_request_events WHERE request_id = ? ORDER BY created_at, id', r.id);
  const kinds = events.map((event) => event.kind);
  assert.ok(!kinds.includes('APPROVED') || kinds.indexOf('APPROVED') < kinds.indexOf('CANCELLED'), kinds.join(', '));
  if (!kinds.includes('APPROVED')) assert.equal(notices().length, 0);
});

test('legacy rows retain their default exemption so existing evaluator links keep working', async () => {
  const r = await newRequest('Legacy Review Harbor');
  // Recreate a pre-migration row, omitting every newly introduced approval column.
  const legacyId = `legacy_${randomBytes(8).toString('hex')}`;
  await run(`INSERT INTO valuation_requests (id, company_id, status, provider, requested_by, requested_by_id,
    contact_name, contact_email, contact_phone, answers, created_at, updated_at)
    SELECT ?, company_id, status, provider, requested_by, requested_by_id,
    contact_name, contact_email, contact_phone, answers, created_at, updated_at FROM valuation_requests WHERE id = ?`, legacyId, r.id);
  assert.equal((await rowOf(legacyId)).approval_required, false);
  received.length = 0;
  const sent = await send({ cid: r.cid, id: legacyId });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.approval, 'not needed');
  assert.equal(sent.json.desk, 'sent');
  assert.equal(approvals().length, 0);
  assert.equal(notices().length, TEAM.length);
  assert.equal((await deskPage(tokenIn(notices()[0].text))).status, 200);
});

test('partial evaluator delivery can be explicitly retried from the review page without a second approval', async () => {
  const r = await requestedReview('Partial Approved Harbor');
  received.length = 0;
  const { result: partial } = await whileRefusing(['third@example.test'], () => approve(r.token));
  assert.equal(partial.status, 200, JSON.stringify(partial.json));
  assert.equal(partial.json.desk, 'partial');
  assert.equal(notices().length, 2);
  const firstDeskToken = tokenIn(notices()[0].text);
  const duplicate = await approve(r.token);
  assert.equal(duplicate.status, 200);
  assert.equal(notices().length, 2, 'ordinary double clicks do not resend successful mail');
  received.length = 0;
  const retried = await approval('POST', '/approve', r.token, { again: true });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.desk, 'sent');
  assert.deepEqual(notices().map((m) => m.to).sort(), [...TEAM].sort());
  assert.equal((await approvalEvents(r.id)).length, 1);
  assert.equal((await approvalAudits(r.id)).length, 1);
  assert.equal((await deskPage(firstDeskToken)).status, 404, 'explicit resends retire the old evaluator link');
  assert.equal((await deskPage(tokenIn(notices()[0].text))).status, 200);
});

test('approval emails follow resend waits and limits without consuming the evaluator notice allowance', async () => {
  try {
    offerTheDesk({ sendCooldownSeconds: 60, resendCooldownMinutes: 10, noticesPerRequestPerDay: 1 });
    const r = await requestedReview('Limited Review Harbor');
    const tooSoon = await send(r, true);
    assert.equal(tooSoon.status, 400);
    assert.match(tooSoon.json.error, /Wait|wait/);
    assert.equal(approvals().length, 1);
    assert.equal(notices().length, 0);
    // The two stages have separate request allowances: the approval notice must
    // not block the evaluator's first notice even when the limit is one.
    const approved = await approve(r.token);
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.desk, 'sent');
    assert.equal(notices().length, TEAM.length);

    offerTheDesk({ noticesPerRequestPerDay: 1 });
    const another = await requestedReview('Daily Review Limit Harbor');
    const limited = await send(another, true);
    assert.equal(limited.status, 200, JSON.stringify(limited.json));
    assert.equal(limited.json.approval, 'failed');
    assert.match(limited.json.approvalError, /today/);
    assert.equal(approvals().length, 1, 'one review email is the configured daily limit');
    assert.equal(notices().length, 0);
  } finally { offerTheDesk(); }
});

test('turning off the service prevents approval and forwarding while preserving a read-only review', async () => {
  const r = await requestedReview('Paused Review Harbor');
  try {
    configure({ valuationDesk: { enabled: false } });
    received.length = 0;
    const page = await approval('GET', '', r.token);
    assert.equal(page.status, 200);
    assert.equal(page.json.canApprove, false);
    const result = await approve(r.token);
    assert.equal(result.status, 403);
    assert.equal((await rowOf(r.id)).approved_at, null);
    assert.equal((await approvalEvents(r.id)).length, 0);
    assert.equal(received.length, 0);
  } finally { offerTheDesk(); }
});

test('the approval email has escaped HTML and a review link in both parts, without an evaluator link or an automatic approval action', () => {
  const hostile = '<script>alert(1)</script>';
  const link = `https://app.example.test/409a-approval#${'A'.repeat(43)}`;
  const message = composeApprovalEmail({
    companyName: `${hostile} Harbor`, to: 'review@example.test', requestedBy: hostile,
    requestedAt: '2026-07-01T10:00:00.000Z',
    contact: { name: hostile, email: 'finance@example.test', phone: '+1 (415) 555-0142' }, link,
  });
  assert.ok(message.html && message.text);
  for (const part of [message.html!, message.text]) {
    assert.ok(part.includes(link));
    assert.match(part, /Review the request/);
    assert.match(part, /Opening this link alone does not approve anything/);
    assert.doesNotMatch(part, /409a-desk|\/api\/valuation-approval\/approve/);
  }
  assert.doesNotMatch(message.html!, /<script>/);
  assert.match(message.html!, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(message.replyTo, undefined, 'replies cannot quote the private link back to the requester');
});
