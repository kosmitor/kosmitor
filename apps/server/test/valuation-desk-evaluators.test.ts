/**
 * A 409A request sent to a valuation team of several evaluators.
 *
 * The team's list (valuationDesk.email, or VALUATION_DESK_EMAIL comma separated)
 * can hold several addresses. Each gets an email of its own, so no evaluator
 * sees another's address, and every one carries the same private link. What is
 * pinned here: each address hears once per notice, the company is told plainly
 * when some of them were not reached and never told which or how many there
 * are, the link changes only once some address has the new one, the closing
 * notice and a resend reach everyone, a notice counts once against the
 * company's limits however many it goes to and once per address against the
 * server's hourly one, an address taken off the list keeps its link until a
 * resend replaces it, and one address, or none, behaves as it always did.
 *
 * A file of its own because the mail transport is chosen when the server starts,
 * and valuation-requests.test.ts reads its mail from the console. Nothing here
 * leaves the machine: the only mail server is the stand-in on localhost, and
 * every address is made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
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

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/files.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/valuation-requests.ts');
const { deskAddresses, deskReplyTo, PARTLY_REACHED } = await import('../src/routes/valuation-requests.ts');
const { configure, resetConfig, config } = await import('../src/config.ts');
const { run, all } = await import('../src/db.ts');

/**
 * The service on, with the waits between sends and the limits for one person
 * out of the way, since one person runs every test here. A test about a limit
 * sets it again.
 */
const offerTheDesk = (changes: Record<string, unknown> = {}) => {
  resetConfig();
  configure({
    valuationDesk: {
      enabled: true, approvalEmail: 'approvals@example.com', sendCooldownSeconds: 0, resendCooldownMinutes: 0, requestsPerCompanyPerDay: 100, requestsPerPersonPerDay: 100,
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
  return { status: res.status, json, token: sessionCookie(res) };
}
const deskPage = (token: string) => call('GET', '/api/valuation-desk', undefined, null, { 'X-Desk-Token': token });

/** Waits for something the server does in its own time, for up to five seconds. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
async function newRequest(name: string): Promise<{ cid: string; id: string }> {
  const cid = (await call('POST', '/api/companies', { name }, admin)).json.id as string;
  const stock = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
  const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Sam Quill', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json;
  await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: founder.id, shareClassId: stock.id, quantity: 5_000_000, issueDate: '2024-01-10' }, admin);
  const documents: { item: string; documentId: string }[] = [];
  for (const [item, [fileName, category]] of Object.entries(FILES)) documents.push({ item, documentId: await upload(cid, fileName, category) });
  const made = await call('POST', `/api/c/${cid}/valuation-requests`, { ...ANSWERS, documents }, admin);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  // These tests exercise evaluator delivery after internal review. The approval
  // handshake itself is covered by valuation-approval.test.ts.
  await run('UPDATE valuation_requests SET approved_at = ?, approved_by = ? WHERE id = ?',
    new Date().toISOString(), 'Internal review fixture', made.json.id);
  return { cid, id: made.json.id };
}
const send = (r: { cid: string; id: string }, again = false) =>
  call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/send`, again ? { again: true } : {}, admin);
const deskRows = (id: string) =>
  all<{ action: string; detail: string }>(`SELECT action, detail FROM audit_log WHERE entity_id = ? AND action LIKE 'NOTIFY_DESK%' ORDER BY created_at, id`, id);

// --- The list ---------------------------------------------------------------------

test('the list is read from the environment lowercased, each address once, in the order given; replies reach the first', () => {
  assert.deepEqual(deskAddresses(), TEAM);
  assert.equal(deskReplyTo(), 'lead@example.test');
  try {
    configure({ valuationDesk: { email: ['B@example.test', 'c@example.test', 'b@example.test'] } });
    assert.deepEqual(deskAddresses(), ['b@example.test', 'c@example.test'], 'a list in the param file, read the same way');
    configure({ valuationDesk: { email: 'Solo@Example.test' } });
    assert.deepEqual(deskAddresses(), ['solo@example.test'], 'one address, as before');
    assert.throws(() => configure({ valuationDesk: { email: ['b@example.test', 'two words@example.test'] } }), /valuationDesk\.email\[1\]/);
  } finally {
    offerTheDesk();
  }
});

// --- Sending ---------------------------------------------------------------------------

test('an approved request emails each evaluator once, alone in its To, all with the same link that works', async () => {
  const r = await newRequest('Shared Harbor');
  received.length = 0;
  const sent = await send(r);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.deepEqual([sent.json.desk, sent.json.deskError, sent.json.recap], ['sent', null, 'sent']);
  assert.ok(sent.json.request.deskNotifiedAt, 'the tracker shows the team has it');

  const mail = notices();
  assert.deepEqual(mail.map((m) => m.to).sort(), [...TEAM].sort(), 'one notice per evaluator, the address written twice mailed once');
  for (const m of mail) {
    assert.equal(m.toHeader.match(/@/g)?.length, 1, `${m.to}'s copy names nobody else`);
    assert.ok(m.toHeader.includes(`<${m.to}>`));
    assert.equal(m.replyTo, null, 'a reply would quote the link, so the notice has no reply-to');
    assert.match(m.text, /everyone on the team’s list was sent the same one\. Keep it within the team/);
    for (const other of TEAM.filter((a) => a !== m.to)) assert.ok(!m.text.includes(other), `${m.to}'s copy does not carry ${other}`);
  }
  const links = new Set(mail.map((m) => tokenIn(m.text)));
  assert.equal(links.size, 1, 'the same link in every copy');
  assert.equal((await deskPage([...links][0])).status, 200, 'and it opens the request');

  const recap = received.find((m) => m.subject.startsWith('Your 409A request'))!;
  assert.equal(recap.to, 'avery@example.com');
  assert.equal(recap.replyTo, 'lead@example.test', 'the recap replies to the first evaluator only');
  assert.ok(!TEAM.slice(1).some((a) => recap.text.includes(a)), 'and names none of the others');

  const rows = await deskRows(r.id);
  assert.deepEqual(rows.map((x) => x.action), ['NOTIFY_DESK'], 'one notice, one entry, however many addresses');
  assert.ok(!rows.some((x) => x.detail.includes('@')), 'the audit log, which the company reads, holds no address');
  await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
});

test('when one evaluator cannot be emailed, the others get the request and the company is told so, without addresses or numbers', async () => {
  const r = await newRequest('Partial Harbor');
  received.length = 0;
  const first = await send(r);
  assert.equal(first.json.desk, 'sent');
  const oldLink = tokenIn(notices()[0].text);

  received.length = 0;
  const { result: again, logged } = await whileRefusing(['third@example.test'], () => send(r, true));
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.desk, 'partial');
  assert.equal(again.json.deskError, PARTLY_REACHED);
  assert.equal(again.json.deskError,
    'Not every address on the team’s list could be emailed, so some of the team did not get it. To reach them all, send it to the team again later, with a new link.');
  assert.ok(!again.json.deskError.includes('@'), 'the company is not told the addresses');
  assert.doesNotMatch(again.json.deskError, /\d|\b(one|two|three|both)\b/, 'nor how many there are');
  assert.ok(logged.some((l) => l.includes('third@example.test')), 'the server log names the one that failed, for whoever runs the server');

  const mail = notices();
  assert.deepEqual(mail.map((m) => m.to).sort(), ['lead@example.test', 'second@example.test']);
  const newLink = tokenIn(mail[0].text);
  assert.equal(tokenIn(mail[1].text), newLink);
  assert.notEqual(newLink, oldLink);
  assert.equal((await deskPage(newLink)).status, 200, 'the new link took over, since some of the team has it');
  assert.equal((await deskPage(oldLink)).status, 404, 'and the old one retired');

  const rows = await deskRows(r.id);
  assert.deepEqual(rows.map((x) => x.action), ['NOTIFY_DESK', 'NOTIFY_DESK']);
  assert.match(rows[1].detail, /, but not to every address on its list$/);
  assert.doesNotMatch(rows[1].detail.replace('409A', ''), /\d|\b(one|two|three)\b/, 'the audit log, which the company reads, does not count the team either');

  // Sending again with a new link reaches all three once the address works again.
  received.length = 0;
  const fixed = await send(r, true);
  assert.deepEqual([fixed.json.desk, fixed.json.deskError], ['sent', null]);
  assert.deepEqual(notices().map((m) => m.to).sort(), [...TEAM].sort());
  assert.equal(new Set(notices().map((m) => tokenIn(m.text))).size, 1);
  await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
});

test('reaching nobody is a failure, and the link that worked keeps working', async () => {
  const r = await newRequest('Unreached Harbor');
  received.length = 0;
  await send(r);
  const link = tokenIn(notices()[0].text);
  received.length = 0;
  const { result: again } = await whileRefusing(TEAM, () => send(r, true));
  assert.deepEqual([again.json.desk, again.json.deskError], ['failed', 'The email could not be sent. Try again later.']);
  assert.equal(notices().length, 0);
  assert.equal((await deskPage(link)).status, 200, 'a failed resend never strands the link the team has');
  assert.deepEqual((await deskRows(r.id)).map((x) => x.action), ['NOTIFY_DESK', 'NOTIFY_DESK_FAILED']);
  await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
});

test('a request that closes before the report tells every evaluator, each in an email of its own', async () => {
  const r = await newRequest('Closing Harbor');
  await send(r);
  received.length = 0;
  const cancelled = await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  await until(() => closings('Closing Harbor').length === TEAM.length, 'the closing notice to every evaluator');
  assert.deepEqual(closings('Closing Harbor').map((m) => m.to).sort(), [...TEAM].sort());
  for (const m of closings('Closing Harbor')) assert.equal(m.toHeader.match(/@/g)?.length, 1);
  await until(async () => (await deskRows(r.id)).some((x) => x.action.startsWith('NOTIFY_DESK_CLOSED')), 'the closing notice in the log');
  assert.deepEqual((await deskRows(r.id)).map((x) => x.action), ['NOTIFY_DESK', 'NOTIFY_DESK_CLOSED']);
});

test('a notice to the whole list counts once against the company’s limits, and once per address against the hour’s', async () => {
  try {
    offerTheDesk({ noticesPerRequestPerDay: 2 });
    const r = await newRequest('Limited Harbor');
    received.length = 0;
    assert.equal((await send(r)).json.desk, 'sent');
    assert.equal((await send(r, true)).json.desk, 'sent', 'three addresses did not use up two notices');
    const held = await send(r, true);
    assert.equal(held.json.desk, 'failed');
    assert.match(held.json.deskError, /sent to the team twice today/);
    for (const a of TEAM) assert.equal(notices().filter((m) => m.to === a).length, 2, `${a} had as many notices as the limit, no more`);
    await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);

    // The server's hourly limit guards the mail sent, so it counts each address: six
    // emails an hour lets two notices out to three evaluators, and holds the third.
    await run(`UPDATE audit_log SET created_at = ? WHERE entity_type = 'valuation_requests'`, new Date(Date.now() - 2 * 86_400_000).toISOString());
    offerTheDesk({ noticesPerHour: 6, noticesPerRequestPerDay: 100 });
    const s = await newRequest('Hourly Harbor');
    received.length = 0;
    assert.equal((await send(s)).json.desk, 'sent');
    assert.equal((await send(s, true)).json.desk, 'sent');
    const busy = await send(s, true);
    assert.equal(busy.json.desk, 'failed');
    assert.match(busy.json.deskError, /a lot of requests/);
    assert.equal(notices().length, 6, 'no more emails to the team in the hour than noticesPerHour');
    assert.deepEqual((await deskRows(s.id)).map((x) => x.action), ['NOTIFY_DESK', 'NOTIFY_DESK', 'NOTIFY_DESK_SKIPPED']);
    await call('PATCH', `/api/c/${s.cid}/valuation-requests/${s.id}`, { status: 'CANCELLED' }, admin);

    // With one address, the limit lets as many notices out as it always did.
    await run(`UPDATE audit_log SET created_at = ? WHERE entity_type = 'valuation_requests'`, new Date(Date.now() - 2 * 86_400_000).toISOString());
    offerTheDesk({ noticesPerHour: 2, noticesPerRequestPerDay: 100, email: 'solo@example.test' });
    const t = await newRequest('Solo Hourly Harbor');
    assert.equal((await send(t)).json.desk, 'sent');
    assert.equal((await send(t, true)).json.desk, 'sent');
    assert.match((await send(t, true)).json.deskError, /a lot of requests/);
    await call('PATCH', `/api/c/${t.cid}/valuation-requests/${t.id}`, { status: 'CANCELLED' }, admin);
  } finally {
    await run(`UPDATE audit_log SET created_at = ? WHERE entity_type = 'valuation_requests'`, new Date(Date.now() - 2 * 86_400_000).toISOString());
    offerTheDesk();
  }
});

test('an address taken off the list keeps the link it was sent until the company sends the request again', async () => {
  try {
    const r = await newRequest('Departing Harbor');
    received.length = 0;
    await send(r);
    const link = tokenIn(notices().find((m) => m.to === 'third@example.test')!.text);

    // The owner takes the third evaluator off the list (a restart, or an apply).
    configure({ valuationDesk: { email: ['lead@example.test', 'second@example.test'] } });
    assert.equal((await deskPage(link)).status, 200, 'every evaluator shares the one link, so it still opens the request');

    received.length = 0;
    const again = await send(r, true);
    assert.deepEqual([again.json.desk, again.json.deskError], ['sent', null]);
    assert.deepEqual(notices().map((m) => m.to).sort(), ['lead@example.test', 'second@example.test'], 'the new link goes to the list as it is now');
    assert.equal((await deskPage(link)).status, 404, 'and the link the third evaluator has stops working');
    assert.equal((await deskPage(tokenIn(notices()[0].text))).status, 200);
    await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
  } finally {
    offerTheDesk();
  }
});

// --- One address, or none, as before ---------------------------------------------------

test('one address works as it always did, and the email tells its reader to keep the link to themselves', async () => {
  try {
    offerTheDesk();
    configure({ valuationDesk: { email: 'solo@example.test' } });
    const r = await newRequest('Solo Harbor');
    received.length = 0;
    const sent = await send(r);
    assert.deepEqual([sent.json.desk, sent.json.deskError], ['sent', null]);
    assert.deepEqual(notices().map((m) => m.to), ['solo@example.test']);
    assert.match(notices()[0].text, /The link opens this request only\. Keep it to yourself:/);
    assert.equal(received.find((m) => m.subject.startsWith('Your 409A request'))!.replyTo, 'solo@example.test');
    await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
  } finally {
    offerTheDesk();
  }
});

test('with no address the request is saved, the person who asked hears, and nobody else is emailed', async () => {
  const saved = process.env.VALUATION_DESK_EMAIL;
  try {
    delete process.env.VALUATION_DESK_EMAIL;
    offerTheDesk();
    assert.deepEqual(deskAddresses(), []);
    assert.equal(config().valuationDesk.email, null);
    const r = await newRequest('Unaddressed Harbor');
    received.length = 0;
    const sent = await send(r);
    assert.equal(sent.json.desk, 'failed');
    assert.match(sent.json.deskError, /No valuation team address is set/);
    assert.equal(sent.json.request.deskNotifiedAt, null);
    assert.equal(notices().length, 0);
    const recap = received.find((m) => m.subject.startsWith('Your 409A request'))!;
    assert.equal(recap.replyTo, null, 'with no team, a reply has nowhere to go');
    assert.deepEqual((await deskRows(r.id)).map((x) => x.action), ['NOTIFY_DESK_SKIPPED']);
    await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
  } finally {
    process.env.VALUATION_DESK_EMAIL = saved;
    offerTheDesk();
  }
  assert.deepEqual(deskAddresses(), TEAM);
});
