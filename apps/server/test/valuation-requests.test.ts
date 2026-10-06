/**
 * Asking the valuation team for a new 409A.
 *
 * What is pinned here is what would hurt if it went wrong: a company reading or
 * closing another company's request, an employee reaching the whole capital
 * structure, a holder's name leaving the company in an email, a page or a
 * workbook, the recap going to an address someone typed rather than to the person
 * who asked, the team's link leaking to the company or outliving its request, the
 * company faking a step only the team may take, a close on one side and a status
 * change on the other both winning, the person who asked hearing of each step
 * and nobody else hearing of it, the email limits, and the service staying
 * off, and silent, unless the param file turns it on. And for the appraiser's
 * information request: every item of it refused when missing on the server, not
 * only in the form; documents taken only from the company's own vault; the team
 * reaching them only through its link while the request is open; and requests
 * made before it still reading as they did.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

// A fictional team inbox. Tests run with no mail transport, so the console
// transport prints each message, and that output is read back below.
process.env.VALUATION_DESK_EMAIL = 'desk@example.test';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/files.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/valuation-report.ts');
await import('../src/routes/valuation-requests.ts');
const { composeDeskEmail, composeRecapEmail, composeClosedEmail, composeStatusEmail, refreshWithText, structureOf, deskAddress, readIntake, intakeLines, intakeTables } =
  await import('../src/routes/valuation-requests.ts');
const { config, configure, resetConfig, deskName, mailSignature, publicConfig } = await import('../src/config.ts');
/** The service is off by default; these tests are about it running, so they turn it on. */
const offerTheDesk = () => { resetConfig(); configure({ valuationDesk: { enabled: true } }); };
offerTheDesk();
const limits = () => config().valuationDesk;
const { getCompanyData, invalidate } = await import('../src/store.ts');
const { run, one, all } = await import('../src/db.ts');
const { parseXlsx, readZip } = await import('../src/import/xlsx.ts');
const { longDate } = await import('@kosmitor/core');

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
const tokenIn = (text: string): string => text.match(/\/409a-desk#([A-Za-z0-9_-]{43})/)![1];

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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Harbor Robotics' }, admin)).json.id as string;
await call('PATCH', `/api/c/${cid}/company`, { legalName: 'Harbor Robotics, Inc.' }, admin);
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const seriesA = (await call('POST', `/api/c/${cid}/share-classes`, {
  name: 'Series A Preferred', kind: 'PREFERRED', authorized: 3_000_000, originalIssuePrice: 1_500_000,
  liquidationMultiple: 1, participation: 'NON_PARTICIPATING', seniority: 1, issueDate: '2025-06-01',
}, admin)).json;
const priya = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;
const fund = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Northwind Ventures', email: 'deals@northwind.example.com', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: priya.id, shareClassId: common.id, quantity: 4_000_000, issueDate: '2024-01-10' }, admin);
await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'PA-1', stakeholderId: fund.id, shareClassId: seriesA.id, quantity: 1_000_000, pricePerShare: 1_500_000, issueDate: '2025-06-01' }, admin);

const pool = (await call('POST', `/api/c/${cid}/pools`, { name: '2024 Stock Plan', shareClassId: common.id, authorized: 1_000_000 }, admin)).json;
const schedule = (await call('GET', `/api/c/${cid}/vesting-schedules`, undefined, admin)).json[0];
const labelled = await call('POST', `/api/c/${cid}/awards`, {
  label: 'Option for Priya Raman', stakeholderId: priya.id, poolId: pool.id, type: 'ISO', quantity: 10_000,
  strikePrice: 200_000, grantDate: '2025-04-01', vestingScheduleId: schedule.id,
}, admin);
assert.equal(labelled.status, 200, JSON.stringify(labelled.json));

const HOLDERS = ['Priya Raman', 'priya@example.com', 'Northwind Ventures', 'northwind.example.com'];

const YEAR = new Date().getUTCFullYear();
/** One of each row the information request asks for, made up. None of the people in them holds shares. */
const TRADE = {
  securityType: 'COMMON', date: '2025-11-14', shares: 40_000, pricePerShare: 1_200_000,
  priceRationale: 'Agreed between the two parties, at a discount to the Series A price.',
  rationale: 'A co-founder sold part of their stake to pay for a house.', buyer: 'A new investor', seller: 'A co-founder', expectRepeat: false,
};
const PERSON = { name: 'Avery Stone', title: 'Chief executive officer', from: '2024-01-10', to: '2025-06-30', timePercent: 100, marketSalary: 22_000_000, salaryReceived: 6_000_000 };
const EXPENSE = { nature: 'Office rent: the team worked from the CEO’s home', recorded: 0, market: 3_600_000 };
const GUIDANCE = [{ year: YEAR, revenue: 120_000_000, ebitda: -30_000_000 }, { year: YEAR + 1, revenue: 310_000_000, ebitda: 15_000_000 }];

/** A complete set of answers, as the form sends them, before the documents. */
const ANSWERS = {
  valuationDateKind: 'LATEST', valuationDate: null,
  companySize: '11-50', stage: 'SERIES_A', plans: 'OPTIONS', plansTiming: 'ONE_TO_THREE', optionsToGrant: 250_000,
  last409a: 'DATE', last409aDate: '2025-03-01',
  noFullYearYet: false, convertiblesOutstanding: false, projections: 'FILE', guidance: [], capTableConfirmed: true,
  management: [{ name: 'Avery Stone', title: 'Chief executive officer' }, { name: 'Rowan Hale', title: 'Chief financial officer' }],
  sweatEquity: false, sweatEquityPeople: [], secondary: false, secondaryTransactions: [], belowMarketExpenses: false, expenses: [],
  software: 'Spreadsheets and QuickBooks',
  contactName: 'Avery Stone', contactEmail: 'finance@harbor.example.com', contactPhone: '+1 (415) 555-0142',
  notes: 'We expect to grant to three new hires.',
};
/** Every list answered yes with a row, and guidance in place of projections. */
const RICH = {
  projections: 'GUIDANCE', guidance: GUIDANCE, sweatEquity: true, sweatEquityPeople: [PERSON],
  secondary: true, secondaryTransactions: [TRADE], belowMarketExpenses: true, expenses: [EXPENSE],
};

/** Uploads a file to a company's vault as the web app does: the bytes as the body, everything else in the query. */
async function upload(companyId: string, fileName: string, content: string | Buffer, query: Record<string, string> = {}) {
  const params = new URLSearchParams({ name: fileName, category: 'OTHER', folder: '409A request', ...query });
  const res = await fetch(`${base}/api/c/${companyId}/documents/upload?${params}`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/pdf' },
    body: new Uint8Array(Buffer.from(content)) as unknown as RequestInit['body'],
  });
  const json = await res.json() as { id: string; name: string };
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

/** A document with text and no file, such as one written in the app. */
async function written(companyId: string, name: string, body: string, category = 'OTHER') {
  const r = await call('POST', `/api/c/${companyId}/documents`, { name, category, body }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { id: string };
}

/** The file each item of the answers is answered with, and the category the form files it under. */
const FILES: Record<string, [string, string]> = {
  HISTORICAL_FINANCIALS: ['2023 to 2025 financial statements.pdf', 'OTHER'],
  YTD_FINANCIALS: ['Year-to-date accounts.pdf', 'OTHER'],
  PITCH_DECK: ['Company presentation.pdf', 'OTHER'],
  PRIOR_VALUATIONS: ['409A report, March 2025.pdf', 'VALUATION'],
  CHARTER: ['Certificate of incorporation.pdf', 'CHARTER'],
  PROJECTIONS: ['Five-year projections.pdf', 'OTHER'],
};
type Link = { item: string; documentId: string };
const filed = new Map<string, Link[]>();

/**
 * Gives a company a founder's common stock if it has none, since a request needs
 * a cap table with shares on it. The founder is made up and holds nothing else.
 */
async function withShares(companyId: string) {
  if ((await call('GET', `/api/c/${companyId}/issuances`, undefined, admin)).json.length) return;
  const stock = (await call('GET', `/api/c/${companyId}/share-classes`, undefined, admin)).json[0];
  const founder = (await call('POST', `/api/c/${companyId}/stakeholders`, { name: 'Sam Quill', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json;
  const issued = await call('POST', `/api/c/${companyId}/issuances`,
    { certificateNo: 'CS-1', stakeholderId: founder.id, shareClassId: stock.id, quantity: 5_000_000, issueDate: '2024-01-10' }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
}

/**
 * A complete request for a company: the answers, and a document of its own for
 * each item, uploaded the first time, with shares on its cap table unless the
 * test is about a cap table with none.
 */
async function intakeFor(companyId: string, change: Record<string, unknown> = {}, { shares = true } = {}) {
  if (shares) await withShares(companyId);
  if (!filed.has(companyId)) {
    const links: Link[] = [];
    for (const [item, [fileName, category]] of Object.entries(FILES)) {
      links.push({ item, documentId: (await upload(companyId, fileName, `%PDF-1.4 ${item} of ${companyId}`, { category })).id });
    }
    filed.set(companyId, links);
  }
  return { ...ANSWERS, documents: filed.get(companyId)!, ...change };
}
/** A company's documents without the ones for an item. */
const without = (body: { documents: Link[] }, item: string): Link[] => body.documents.filter((d) => d.item !== item);

const INTAKE = await intakeFor(cid);

/** Moves every earlier request and notice back two days, out of the daily limits, which one person running many tests would otherwise reach. */
const forgetLimits = () =>
  run(`UPDATE audit_log SET created_at = ? WHERE entity_type = 'valuation_requests'`, new Date(Date.now() - 2 * 86_400_000).toISOString());

/** Clears the one-minute gate between sends, which a person would wait out. */
const forgetRecentSends = (requestId: string) =>
  run(`UPDATE audit_log SET created_at = ? WHERE entity_id = ? AND action LIKE 'SEND%' OR entity_id = ? AND action LIKE 'NOTIFY%'`,
    new Date(Date.now() - 11 * 60_000).toISOString(), requestId, requestId);

test('with nothing on file the refresh says a 409A is required, in a sentence', async () => {
  const r = await call('GET', `/api/c/${cid}/valuation-refresh`, undefined, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.due, true);
  assert.equal(r.json.triggers[0].reason, 'NO_VALUATION');
  assert.match(r.json.triggers[0].text, /no current 409A valuation on file/);
});

test('an appraisal before the priced round is flagged by the round, with the date the way the app prints dates', async () => {
  const v = await call('POST', `/api/c/${cid}/valuations`, { type: '409A', fairMarketValue: 200_000, effectiveDate: '2025-03-01', status: 'ACTIVE', provider: 'Ledgerline Valuations' }, admin);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const r = await call('GET', `/api/c/${cid}/valuation-refresh?asOf=2025-07-01`, undefined, admin);
  assert.equal(r.json.due, true);
  const round = r.json.triggers.find((t: any) => t.reason === 'PRICED_ROUND');
  assert.match(round.text, /^Series A Preferred was sold on Jun 1, 2025, after the valuation date/);
});

test('every answer is checked against the questions’ own lists before anything is saved', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ companySize: 'huge' }, /how many people/],
    [{ stage: 'SERIES_Z' }, /stage/],
    [{ plans: 'maybe' }, /grant options or close/],
    [{ plansTiming: 'next-year' }, /roughly when/i],
    [{ last409a: 'SOMETIME' }, /last 409A/],
    [{ last409a: 'DATE', last409aDate: '' }, /Date of the last 409A is required/],
    [{ last409a: 'DATE', last409aDate: '2999-01-01' }, /future/],
    [{ software: '' }, /software/i],
    [{ contactEmail: 'a@example.com, b@example.com' }, /single email address/],
    [{ contactEmail: '' }, /Your email is required/],
    [{ contactPhone: '555' }, /between 7 and 15 digits/],
    [{ contactPhone: 'call me maybe' }, /digits, spaces/],
    [{ contactPhone: '' }, /phone number is required/],
  ];
  for (const [change, error] of cases) {
    const r = await call('POST', `/api/c/${cid}/valuation-requests`, { ...INTAKE, ...change }, admin);
    assert.equal(r.status, 400, `accepted ${JSON.stringify(change)}`);
    assert.match(r.json.error, error, JSON.stringify(change));
  }
  assert.equal((await all('SELECT id FROM valuation_requests WHERE company_id = ?', cid)).length, 0, 'nothing was saved');
  // No plans means no timing, whatever the form sent.
  assert.equal(readIntake({ ...INTAKE, plans: 'NEITHER', plansTiming: 'MONTH' }).plansTiming, null);
});

let requestId = '';
let firstToken = '';

test('a request records the answers and why it was asked for, and a second open one is refused', async () => {
  const made = await call('POST', `/api/c/${cid}/valuation-requests`, INTAKE, admin);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.status, 'REQUESTED');
  assert.equal(made.json.provider, deskName());
  assert.ok(made.json.reasons.includes('PRICED_ROUND'), JSON.stringify(made.json.reasons));
  // The company's dates come from its record, not the form: this one was set up today, with the usual year end.
  assert.deepEqual(made.json.answerLines.map((l: any) => l.value), [
    'As of the most recent date', '11 to 50 people', 'Series A', 'Grant options, in 1 to 3 months', '250,000', 'Valued as of Mar 1, 2025',
    longDate(new Date().toISOString().slice(0, 10)), 'Dec 31',
    'No', 'Attached', 'Confirmed up to date. The data workbook carries them.', 'None', 'None', 'None', 'Spreadsheets and QuickBooks',
  ]);
  assert.deepEqual(made.json.answerLines.slice(6, 8).map((l: any) => l.label), ['Incorporated', 'Fiscal year end']);
  assert.equal(made.json.documentsHidden, 0, 'an administrator sees every document sent');
  assert.equal(made.json.answers.version, 2);
  assert.deepEqual(made.json.tables, [{ title: 'Management team', columns: ['Name', 'Title'], rows: [['Avery Stone', 'Chief executive officer'], ['Rowan Hale', 'Chief financial officer']] }]);
  assert.deepEqual(made.json.documents.map((d: any) => [d.item, d.name]), [
    ['HISTORICAL_FINANCIALS', '2023 to 2025 financial statements.pdf'], ['YTD_FINANCIALS', 'Year-to-date accounts.pdf'],
    ['PITCH_DECK', 'Company presentation.pdf'], ['PRIOR_VALUATIONS', '409A report, March 2025.pdf'],
    ['CHARTER', 'Certificate of incorporation.pdf'], ['PROJECTIONS', 'Five-year projections.pdf'],
  ], 'in the checklist’s order');
  assert.equal(made.json.contactPhone, '+1 (415) 555-0142');
  assert.equal(made.json.deskNotifiedAt, null, 'nothing is sent until the page asks');
  assert.ok(!JSON.stringify(made.json).includes('deskTokenHash') && !('deskTokenHash' in made.json));
  requestId = made.json.id;

  // Even a request with nothing filled in is told the real reason it cannot be made.
  const second = await call('POST', `/api/c/${cid}/valuation-requests`, {}, admin);
  assert.equal(second.status, 400);
  assert.match(second.json.error, /already open/);
});

test('sending mails the recap to the account of whoever asked and the notice to the team, and claims neither without a transport', async () => {
  outbox.length = 0;
  const sent = await call('POST', `/api/c/${cid}/valuation-requests/${requestId}/send`, {}, admin);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.match(sent.json.recapError, /Mail is not set up/);
  assert.match(sent.json.deskError, /Mail is not set up/);
  assert.deepEqual([sent.json.recap, sent.json.desk, sent.json.recapTo], ['failed', 'failed', 'Avery Stone']);
  assert.equal(sent.json.request.recapSentAt, null);
  assert.equal(sent.json.request.deskNotifiedAt, null);

  const recap = outbox.find((m) => m.subject.startsWith('Your 409A request'))!;
  const notice = outbox.find((m) => m.subject.startsWith('New 409A request'))!;
  assert.equal(recap.to, 'avery@example.com', 'the account address, not the one typed into the form');
  assert.equal(recap.subject, 'Your 409A request for Harbor Robotics, Inc. was received');
  assert.match(recap.text, /valuation of Harbor Robotics, Inc\. A 409A is/, 'one full stop after "Inc."');
  assert.match(recap.text, /finance@harbor\.example\.com or \+1 \(415\) 555-0142/);
  assert.match(recap.text, /Company size: +11 to 50 people/);
  assert.match(recap.text, /\/compliance\/409a/);
  assert.doesNotMatch(recap.text, /409a-desk/, 'the recap never carries the team’s link');

  assert.equal(notice.to, 'desk@example.test');
  assert.equal(notice.subject, 'New 409A request from Harbor Robotics, Inc.');
  assert.match(notice.text, /\+1 \(415\) 555-0142/);
  assert.match(notice.text, /Series A Preferred: +1,000,000 shares outstanding, issued at \$1\.50, 1x non-participating/);
  for (const who of HOLDERS) assert.ok(!notice.text.includes(who), `the notice names ${who}`);
  firstToken = tokenIn(notice.text);

  const tooSoon = await call('POST', `/api/c/${cid}/valuation-requests/${requestId}/send`, {}, admin);
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.json.error, /Wait a minute/);
  assert.equal(await one('SELECT id FROM audit_log WHERE detail LIKE ? OR detail LIKE ?', '%555-0142%', '%finance@harbor%'), undefined,
    'no phone or email in the audit log');
});

test('the composed messages carry replies to the right people', async () => {
  const data = await getCompanyData(cid);
  const intake = readIntake(INTAKE);
  const contact = { name: 'Avery Stone', email: 'finance@harbor.example.com', phone: '+1 (415) 555-0142' };
  const recap = composeRecapEmail({
    companyName: 'Harbor Robotics, Inc.', to: 'avery@example.com', toName: 'Avery Stone', contact, intake, documents: [], notes: null,
    statusUrl: 'https://app.example.test/compliance/409a', replyTo: 'desk@example.test',
  });
  assert.equal(recap.replyTo, 'desk@example.test', 'the recap’s replies reach the team');
  assert.match(recap.text, /reply to this email/);
  const notice = composeDeskEmail({
    companyName: 'Harbor Robotics, Inc.', to: 'desk@example.test', requestedAt: '2025-07-01T10:00:00.000Z', requestedBy: 'Avery Stone',
    contact, intake, documents: [], notes: null, link: 'https://app.example.test/409a-desk#x',
    situation: { refresh: refreshWithText(data, '2025-07-01', 'appraiser'), structure: structureOf(data, '2025-07-01'), splitSinceValuation: false },
  });
  // A reply quotes the message it answers, and this one carries the team's link.
  assert.equal(notice.replyTo, undefined, 'a reply to the notice goes nowhere near the company');
  assert.match(notice.text, /Write to them in a new email/);
  assert.match(notice.text, /finance@harbor\.example\.com/);
  assert.match(notice.text, /Valued as of Mar 1, 2025 at \$0\.2000 per common share, by Ledgerline Valuations/);
  assert.doesNotMatch(notice.text, /Your appraiser will judge|is worth starting/, 'the team is told facts, not advice');
});

/** A name someone typed that would be markup if it were not escaped. */
const HOSTILE = '<script>x</script>';
const escapedIn = (html: string) => {
  assert.ok(!html.includes('<script>'), 'no script tag in the HTML');
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), 'the name shown as text');
};

test('the recap has an HTML part with the same words, the status link as its one button, and what people typed escaped', () => {
  const statusUrl = 'https://app.example.test/compliance/409a';
  const m = composeRecapEmail({
    companyName: `${HOSTILE} Robotics`, to: 'avery@example.com', toName: HOSTILE,
    contact: { name: HOSTILE, email: 'finance@harbor.example.com', phone: '+1 (415) 555-0142' },
    intake: { ...readIntake(INTAKE), software: HOSTILE }, documents: [{ itemLabel: 'Pitch deck or company presentation', name: `${HOSTILE}.pdf` }],
    notes: `Three new hires.\n\nAlso ${HOSTILE}`,
    statusUrl, replyTo: 'desk@example.test',
  });
  assert.ok(m.html && m.text, 'both parts');
  for (const part of [m.html!, m.text]) {
    assert.ok(part.includes(statusUrl), 'the status link');
    assert.match(part, /Follow your request/);
    for (const fact of [/11 to 50 people/, /Series A/, /Grant options, in 1 to 3 months/, /Valued as of Mar 1, 2025/,
      /finance@harbor\.example\.com/, /\+1 \(415\) 555-0142/, /confirm scope, price and timing/, /What happens next/i, /Three new hires/]) {
      assert.match(part, fact);
    }
  }
  assert.doesNotMatch(m.html! + m.text, /409a-desk/, 'never the team’s link');
  assert.equal(m.replyTo, 'desk@example.test');
  escapedIn(m.html!);
});

test('the notice to the team has an HTML part with the private link as its one button, its warnings, the answers and the structure', async () => {
  const data = await getCompanyData(cid);
  const link = `https://app.example.test/409a-desk#${'A'.repeat(43)}`;
  const m = composeDeskEmail({
    companyName: `${HOSTILE} Robotics`, to: 'desk@example.test', requestedAt: '2025-07-01T10:00:00.000Z', requestedBy: 'Avery Stone',
    contact: { name: HOSTILE, email: 'finance@harbor.example.com', phone: '+1 (415) 555-0142' },
    intake: readIntake(INTAKE), documents: [{ itemLabel: 'Pitch deck or company presentation', name: `${HOSTILE}.pdf` }],
    notes: `Please call. ${HOSTILE}`, link,
    situation: { refresh: refreshWithText(data, '2025-07-01', 'appraiser'), structure: structureOf(data, '2025-07-01'), splitSinceValuation: false },
  });
  assert.ok(m.html && m.text, 'both parts');
  for (const part of [m.html!, m.text]) {
    assert.ok(part.includes(link), 'the request link');
    for (const fact of [/Open the request/, /opens this request only/, /Keep it to yourself/, /Write to them in a new email/,
      /Jul 1, 2025/, /finance@harbor\.example\.com/, /\+1 \(415\) 555-0142/, /11 to 50 people/, /Please call/,
      /Why now/i, /Series A Preferred was sold on Jun 1, 2025/, /twelve months/, /Capital structure as of Jul 1, 2025/i,
      /Fully diluted shares/, /1,000,000 shares outstanding, issued at \$1\.50, 1x non-participating/]) {
      assert.match(part, fact);
    }
    for (const who of HOLDERS) assert.ok(!part.includes(who), `the notice names ${who}`);
  }
  assert.equal(m.replyTo, undefined, 'no reply-to');
  assert.doesNotMatch(m.text, /^Hi /m, 'no greeting to a team inbox');
  escapedIn(m.html!);
});

test('the closing notice has an HTML part too, short, with no link and no data, and the company name escaped', () => {
  for (const how of ['CANCELLED', 'COMPLETED'] as const) {
    const m = composeClosedEmail({ companyName: `${HOSTILE} Robotics`, to: 'desk@example.test', requestedAt: '2025-07-01T10:00:00.000Z', how });
    assert.ok(m.html && m.text, 'both parts');
    for (const part of [m.html!, m.text]) {
      assert.match(part, how === 'CANCELLED' ? /cancelled its 409A request of Jul 1, 2025/ : /recorded a 409A and closed its request of Jul 1, 2025/);
      assert.match(part, /Nothing more is needed on it/);
      assert.match(part, /link now shows the request as closed/);
      assert.doesNotMatch(part, /409a-desk|https?:\/\/|555-0142|Series A/, 'no link and no data');
    }
    assert.ok(!m.html!.includes('If the button does not work'), 'no button');
    assert.equal(m.replyTo, undefined);
    escapedIn(m.html!);
  }
});

test('the team’s page opens with its link and nothing else, and never tells the company the link', async () => {
  const oneOff = `${firstToken.slice(0, 42)}${firstToken.endsWith('A') ? 'B' : 'A'}`;
  for (const bad of ['', 'short', 'x'.repeat(43), oneOff]) {
    const r = await desk('GET', '', bad);
    assert.equal(r.status, 404, `opened with ${JSON.stringify(bad)}`);
  }
  const page = await desk('GET', '', firstToken);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.json.companyName, 'Harbor Robotics, Inc.');
  assert.equal(page.json.contact.phone, '+1 (415) 555-0142');
  assert.ok(page.json.situation.some((l: string) => /Fully diluted shares/.test(l)));
  for (const who of HOLDERS) assert.ok(!JSON.stringify(page.json).includes(who), `the page names ${who}`);

  const listed = await call('GET', `/api/c/${cid}/valuation-requests`, undefined, admin);
  assert.ok(!JSON.stringify(listed.json).includes(firstToken));
  assert.ok(!JSON.stringify(listed.json).includes('deskToken'));

  const res = await fetch(`${base}/api/valuation-desk/package.xlsx`, { headers: { 'X-Desk-Token': firstToken } });
  assert.equal(res.status, 200);
  const everything = JSON.stringify(parseXlsx(Buffer.from(await res.arrayBuffer())));
  for (const who of HOLDERS) assert.ok(!everything.includes(who), `the workbook names ${who}`);
});

test('a new notice replaces the link, and the old one stops working', async () => {
  await forgetRecentSends(requestId);
  outbox.length = 0;
  const again = await call('POST', `/api/c/${cid}/valuation-requests/${requestId}/send`, { again: true }, admin);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  const fresh = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
  assert.notEqual(fresh, firstToken);
  assert.equal((await desk('GET', '', firstToken)).status, 404);
  assert.equal((await desk('GET', '', fresh)).status, 200);
  firstToken = fresh;
});

test('the team moves the request forward, the company sees each step, and the team’s steps are its own', async () => {
  // The company cannot claim a step the team has not taken.
  for (const status of ['IN_PROGRESS', 'DELIVERED']) {
    const r = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { status }, admin);
    assert.equal(r.status, 400, `the company set ${status}`);
  }
  const answers = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { stage: 'SEED' }, admin);
  assert.equal(answers.status, 400, 'the answers stand as they were sent');
  assert.match(answers.json.error, /Only the contact details and notes/);

  const bogus = await desk('POST', '/status', firstToken, { action: 'APPROVE' });
  assert.equal(bogus.status, 400);

  const started = await desk('POST', '/status', firstToken, { action: 'START', message: 'We will call you on Tuesday.' });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.status, 'IN_PROGRESS');
  const twice = await desk('POST', '/status', firstToken, { action: 'START' });
  assert.equal(twice.status, 200, 'pressing it twice is harmless');
  assert.equal(twice.json.events.filter((e: any) => e.kind === 'IN_PROGRESS').length, 1, 'and writes one step, not two');

  assert.equal((await desk('POST', '/status', firstToken, { action: 'NOTE' })).status, 400, 'a note needs words');
  const note = await desk('POST', '/status', firstToken, { action: 'NOTE', message: 'Please send the last two P&L statements.' });
  assert.equal(note.status, 200);

  const noFirm = await desk('POST', '/status', firstToken, { action: 'DELIVER', reportDate: '2025-07-01' });
  assert.equal(noFirm.status, 400);
  const delivered = await desk('POST', '/status', firstToken, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2025-07-01' });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  assert.equal(delivered.json.status, 'DELIVERED');

  const seen = (await call('GET', `/api/c/${cid}/valuation-requests`, undefined, admin)).json.find((r: any) => r.id === requestId);
  assert.equal(seen.status, 'DELIVERED');
  assert.equal(seen.appraiser, 'Ledgerline Valuations');
  assert.equal(seen.reportDate, '2025-07-01');
  assert.deepEqual(seen.events.map((e: any) => [e.kind, e.author]), [['IN_PROGRESS', 'desk'], ['MESSAGE', 'desk'], ['DELIVERED', 'desk']]);
  assert.equal(seen.events[0].message, 'We will call you on Tuesday.');
  assert.equal(seen.events[0].authorName, deskName());

  const reopened = await desk('POST', '/status', firstToken, { action: 'REOPEN', message: 'Correcting the date.' });
  assert.equal(reopened.json.status, 'IN_PROGRESS');
  assert.deepEqual([reopened.json.appraiser, reopened.json.reportDate], [null, null], 'a withdrawn report takes its firm and date with it');
  const redelivered = await desk('POST', '/status', firstToken, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2025-07-01' });
  assert.equal(redelivered.json.status, 'DELIVERED');

  // The team is named in the company's audit log, with no account and no address behind it.
  const logged = await all<{ user_id: string | null; user_name: string; ip_address: string | null; company_id: string }>(
    `SELECT user_id, user_name, ip_address, company_id FROM audit_log WHERE action = 'DESK_UPDATE' AND entity_id = ?`, requestId);
  assert.ok(logged.length >= 4);
  for (const l of logged) assert.deepEqual([l.user_id, l.user_name, l.ip_address, l.company_id], [null, deskName(), null, cid]);
});

test('the company fixes its contact details while the team works, and only editors see them', async () => {
  const other = (await call('POST', '/api/companies', { name: 'Contact Harbor' }, admin)).json.id as string;
  const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  const fixed = await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { contactPhone: '+1 415 555 0199', contactEmail: 'cfo@harbor.example.com' }, admin);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal(fixed.json.contactPhone, '+1 415 555 0199');
  assert.deepEqual(fixed.json.events.map((e: any) => e.kind), ['CONTACT_CHANGED']);
  const same = await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { contactPhone: '+1 415 555 0199' }, admin);
  assert.equal(same.json.events.length, 1, 'an unchanged value is not a change');

  const board = await call('POST', `/api/c/${other}/members`, { email: 'blair@example.com', name: 'Blair Kim', role: 'BOARD' }, admin);
  const link = await call('POST', `/api/c/${other}/members/${board.json.id}/reset-password`, { mode: 'link' }, admin);
  const director = (await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: 'blair-pass-1' })).token as string;
  const theirView = (await call('GET', `/api/c/${other}/valuation-requests`, undefined, director)).json[0];
  assert.equal(theirView.contactPhone, null);
  assert.equal(theirView.contactEmail, null);
  assert.deepEqual(theirView.answerLines, req.answerLines, 'the answers themselves are the company’s to read');
  assert.deepEqual([theirView.tables, theirView.documents], [req.tables, req.documents], 'and so are the tables and the documents');
  await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin);
});

test('the request completes against a 409A of this company, and then the team’s page is read-only and brief', async () => {
  const empty = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { status: 'COMPLETED' }, admin);
  assert.equal(empty.status, 400, 'completing names the valuation that came back');

  const estimate = (await call('POST', `/api/c/${cid}/valuations`, { type: 'BOARD_ESTIMATE', fairMarketValue: 300_000, effectiveDate: '2025-07-01', status: 'DRAFT' }, admin)).json;
  const notA409a = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { status: 'COMPLETED', valuationId: estimate.id }, admin);
  assert.equal(notA409a.status, 400);
  assert.match(notA409a.json.error, /completed by a 409A/);

  const other = (await call('POST', '/api/companies', { name: 'Elsewhere Labs' }, admin)).json.id as string;
  const theirs = (await call('POST', `/api/c/${other}/valuations`, { type: '409A', fairMarketValue: 100_000, effectiveDate: '2025-07-01', status: 'ACTIVE' }, admin)).json;
  const crossed = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { status: 'COMPLETED', valuationId: theirs.id }, admin);
  assert.equal(crossed.status, 400, 'another company’s valuation does not complete this request');

  const before = (await call('GET', `/api/c/${cid}/valuations`, undefined, admin)).json.find((v: any) => v.effectiveDate === '2025-03-01');
  const stale = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { status: 'COMPLETED', valuationId: before.id }, admin);
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /recorded before this request/);

  const fresh = (await call('POST', `/api/c/${cid}/valuations`, { type: '409A', fairMarketValue: 450_000, effectiveDate: '2025-07-01', status: 'ACTIVE', provider: 'Ledgerline Valuations' }, admin)).json;
  // As if the notice had arrived, so the only thing keeping the team's inbox quiet is that it delivered the report.
  await run('UPDATE valuation_requests SET desk_notified_at = ? WHERE id = ?', new Date().toISOString(), requestId);
  outbox.length = 0;
  const done = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { status: 'COMPLETED', valuationId: fresh.id }, admin);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.valuationId, fresh.id);
  assert.ok(done.json.closedAt);
  assert.equal(outbox.length, 0, 'the team delivered this one, so its close is no news to them');

  const closed = await call('PATCH', `/api/c/${cid}/valuation-requests/${requestId}`, { notes: 'too late' }, admin);
  assert.equal(closed.status, 400);
  assert.match(closed.json.error, /completed and can no longer be changed/);
  assert.equal((await call('POST', `/api/c/${cid}/valuation-requests/${requestId}/send`, {}, admin)).status, 400);

  const page = await desk('GET', '', firstToken);
  assert.equal(page.status, 200);
  assert.equal(page.json.status, 'COMPLETED');
  assert.equal(page.json.contact, undefined, 'a closed request no longer shares who to call');
  assert.equal(page.json.situation, undefined, 'or the cap table');
  assert.equal(page.json.documents, undefined, 'or the documents');
  assert.equal((await desk('POST', '/status', firstToken, { action: 'NOTE', message: 'Late note' })).status, 400);
  assert.equal((await fetch(`${base}/api/valuation-desk/package.xlsx`, { headers: { 'X-Desk-Token': firstToken } })).status, 404);

  await run('UPDATE valuation_requests SET closed_at = ? WHERE id = ?', new Date(Date.now() - (limits().linkClosedDays + 1) * 86_400_000).toISOString(), requestId);
  assert.equal((await desk('GET', '', firstToken)).status, 404, 'linkClosedDays after it closed, the link is dead');

  const deleting = await call('DELETE', `/api/c/${cid}/valuations/${fresh.id}`, undefined, admin);
  assert.equal(deleting.status, 400, 'the valuation that answered a request stays');
  assert.match(deleting.json.error, /completed a 409A request/);
});

test('a cancel stops the team’s page from changing anything and tells the team, if it was told in the first place', async () => {
  const req = (await call('POST', `/api/c/${cid}/valuation-requests`, INTAKE, admin)).json;
  outbox.length = 0;
  await call('POST', `/api/c/${cid}/valuation-requests/${req.id}/send`, {}, admin);
  const token = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
  // As if the notice had arrived, which the console transport cannot do.
  await run('UPDATE valuation_requests SET desk_notified_at = ? WHERE id = ?', new Date().toISOString(), req.id);

  outbox.length = 0;
  const cancelled = await call('PATCH', `/api/c/${cid}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const notice = outbox.find((m) => m.to === 'desk@example.test')!;
  assert.equal(notice.subject, '409A request closed: Harbor Robotics, Inc.');
  assert.doesNotMatch(notice.text, /409a-desk|555-0142|Series A/, 'no link and no data in it');

  const late = await desk('POST', '/status', token, { action: 'START' });
  assert.equal(late.status, 400);
  assert.match(late.json.error, /cancelled this request/);
  const after = await one<{ status: string }>('SELECT status FROM valuation_requests WHERE id = ?', req.id);
  assert.equal(after!.status, 'CANCELLED', 'the close stands');
});

test('the team can close a request itself, with a reason the company reads', async () => {
  const req = (await call('POST', `/api/c/${cid}/valuation-requests`, INTAKE, admin)).json;
  outbox.length = 0;
  await call('POST', `/api/c/${cid}/valuation-requests/${req.id}/send`, {}, admin);
  const token = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
  assert.equal((await desk('POST', '/status', token, { action: 'CLOSE' })).status, 400, 'a close needs a reason');
  const closed = await desk('POST', '/status', token, { action: 'CLOSE', message: 'This was a duplicate of your earlier request.' });
  assert.equal(closed.status, 200);
  const again = await desk('POST', '/status', token, { action: 'NOTE', message: 'One more thing' });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /closed from this page/, 'the team is not told the company cancelled it');
  const seen = (await call('GET', `/api/c/${cid}/valuation-requests`, undefined, admin)).json.find((r: any) => r.id === req.id);
  assert.equal(seen.status, 'CANCELLED');
  assert.deepEqual(seen.events.at(-1), { ...seen.events.at(-1), kind: 'CANCELLED', author: 'desk', message: 'This was a duplicate of your earlier request.' });
});

test('one company cannot read, change or send another company’s request', async () => {
  const other = (await call('POST', '/api/companies', { name: 'Third Harbor' }, admin)).json.id as string;
  const theirs = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  assert.ok(theirs.id);

  const changed = await call('PATCH', `/api/c/${cid}/valuation-requests/${theirs.id}`, { status: 'CANCELLED' }, admin);
  assert.equal(changed.status, 404, 'knowing an id is not permission');
  assert.equal((await call('POST', `/api/c/${cid}/valuation-requests/${theirs.id}/send`, {}, admin)).status, 404);

  const listed = await call('GET', `/api/c/${cid}/valuation-requests`, undefined, admin);
  assert.ok(!listed.json.some((r: any) => r.id === theirs.id));
  const still = await call('GET', `/api/c/${other}/valuation-requests`, undefined, admin);
  assert.equal(still.json.find((r: any) => r.id === theirs.id).status, 'REQUESTED', 'untouched');
  await call('PATCH', `/api/c/${other}/valuation-requests/${theirs.id}`, { status: 'CANCELLED' }, admin);
});

test('requests are limited per company and per person, and notices to the team per hour', async () => {
  const other = (await call('POST', '/api/companies', { name: 'Quiet Harbor' }, admin)).json.id as string;
  const stamp = new Date().toISOString();
  for (let i = 0; i < limits().requestsPerCompanyPerDay; i++) {
    await run(`INSERT INTO audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, created_at)
               VALUES (?, ?, NULL, 'CREATE', 'valuation_requests', ?, 'made', ?)`, `aud_c${i}`, other, `vrq_c${i}`, stamp);
  }
  const perCompany = await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin);
  assert.equal(perCompany.status, 400);
  assert.match(perCompany.json.error, /Five 409A requests have been made for this company today/);
  // The words follow the setting: a lower limit is reached sooner, and says so.
  configure({ valuationDesk: { requestsPerCompanyPerDay: 1 } });
  await run(`DELETE FROM audit_log WHERE id LIKE 'aud_c%' AND id <> 'aud_c0'`);
  const lower = await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin);
  assert.equal(lower.status, 400);
  assert.match(lower.json.error, /^One 409A request has been made for this company today/);
  offerTheDesk();
  await run(`DELETE FROM audit_log WHERE id LIKE 'aud_c%'`);

  const me = await one<{ id: string }>("SELECT id FROM users WHERE email = 'avery@example.com'");
  const mine = await one<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = 'CREATE' AND entity_type = 'valuation_requests' AND created_at > ?`,
    me!.id, new Date(Date.now() - 86_400_000).toISOString());
  for (let i = Number(mine!.n); i < limits().requestsPerPersonPerDay; i++) {
    await run(`INSERT INTO audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, created_at)
               VALUES (?, ?, ?, 'CREATE', 'valuation_requests', ?, 'made', ?)`, `aud_u${i}`, cid, me!.id, `vrq_u${i}`, stamp);
  }
  const perPerson = await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin);
  assert.equal(perPerson.status, 400);
  assert.match(perPerson.json.error, /You have made five 409A requests today/);
  await run(`UPDATE audit_log SET created_at = ? WHERE user_id = ? AND action = 'CREATE' AND entity_type = 'valuation_requests'`,
    new Date(Date.now() - 2 * 86_400_000).toISOString(), me!.id);

  const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  for (let i = 0; i < limits().noticesPerHour; i++) {
    await run(`INSERT INTO audit_log (id, company_id, action, entity_type, entity_id, detail, created_at)
               VALUES (?, ?, 'NOTIFY_DESK', 'valuation_requests', ?, 'sent', ?)`, `aud_d${i}`, cid, `vrq_d${i}`, stamp);
  }
  const busy = await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, {}, admin);
  assert.equal(busy.status, 200, 'the request is kept; only the notice waits');
  assert.match(busy.json.deskError, /a lot of requests/);
  assert.equal(busy.json.request.deskNotifiedAt, null);
  await run(`DELETE FROM audit_log WHERE id LIKE 'aud_d%'`);
  await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin);
});

test('the team’s address is set per server, there is none unless it is given one, and without one nobody is notified', async () => {
  const saved = { email: process.env.VALUATION_DESK_EMAIL, env: process.env.NODE_ENV };
  const restore = (name: 'VALUATION_DESK_EMAIL' | 'NODE_ENV', value: string | undefined) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  try {
    delete process.env.VALUATION_DESK_EMAIL;
    process.env.NODE_ENV = 'test';
    offerTheDesk();
    assert.equal(deskAddress(), null);
    process.env.NODE_ENV = 'production';
    offerTheDesk();
    assert.equal(deskAddress(), null, 'production has no built-in inbox either');

    // A request is still saved, and the person who asked is told the team was not.
    await forgetLimits();
    const other = (await call('POST', '/api/companies', { name: 'Unaddressed Harbor' }, admin)).json.id as string;
    const req = await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin);
    assert.equal(req.status, 200, JSON.stringify(req.json));
    outbox.length = 0;
    const sent = await call('POST', `/api/c/${other}/valuation-requests/${req.json.id}/send`, {}, admin);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.desk, 'failed');
    assert.match(sent.json.deskError, /No valuation team address is set/);
    assert.equal(sent.json.request.deskNotifiedAt, null);
    assert.ok(!outbox.some((m) => m.subject.startsWith('New 409A request')), 'no notice went to anyone');
    await call('PATCH', `/api/c/${other}/valuation-requests/${req.json.id}`, { status: 'CANCELLED' }, admin);

    assert.throws(() => configure({ valuationDesk: { email: 'desk@example.test,cc' } }), /valuationDesk\.email/, 'a list is not an address, so the file is refused');
    assert.equal(deskAddress(), null, 'and the refused change is not left in force');
    process.env.VALUATION_DESK_EMAIL = 'desk@example.test, other@example.test';
    resetConfig();
    assert.throws(() => config(), /valuationDesk\.email/, 'and a list in the environment stops the server at start');
  } finally {
    restore('VALUATION_DESK_EMAIL', saved.email);
    restore('NODE_ENV', saved.env);
    offerTheDesk();
  }
  assert.equal(deskAddress(), 'desk@example.test');
});

test('the service is off unless the param file turns it on, and off it takes no new request and tells the team nothing', async () => {
  await forgetLimits();
  const other = (await call('POST', '/api/companies', { name: 'Paused Harbor' }, admin)).json.id as string;
  const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  outbox.length = 0;
  await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, {}, admin);
  const token = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
  // As if the notice had arrived, so a cancel would ordinarily tell the team.
  await run('UPDATE valuation_requests SET desk_notified_at = ? WHERE id = ?', new Date().toISOString(), req.id);

  try {
    resetConfig();
    assert.equal(config().valuationDesk.enabled, false, 'off as shipped');
    const refused = await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin);
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /turned off on this server/);
    const resend = await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, { again: true }, admin);
    assert.equal(resend.status, 403, 'and nothing is sent');

    // What was asked for before stays: the company reads it, the team's link works, and it can close.
    const listed = await call('GET', `/api/c/${other}/valuation-requests`, undefined, admin);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.map((r: any) => r.id), [req.id]);
    assert.equal((await desk('GET', '', token)).status, 200);
    assert.equal((await desk('POST', '/status', token, { action: 'START' })).json.status, 'IN_PROGRESS');
    const workbook = await fetch(`${base}/api/c/${other}/valuation-requests/package.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(workbook.status, 200);
    outbox.length = 0;
    const cancelled = await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
    assert.equal(cancelled.json.status, 'CANCELLED');
    assert.equal(outbox.length, 0, 'the team is not told about the close');
  } finally {
    offerTheDesk();
  }
});

test('the questions, the names and the sign-off come from the param file', async () => {
  try {
    configure({
      brand: { productName: 'Ledgerly' },
      mail: { signature: 'The Ledgerly team' },
      valuationDesk: {
        name: 'Acme valuation desk',
        intake: { stages: [...config().valuationDesk.intake.stages, { value: 'GROWTH', label: 'Growth stage', shortLabel: 'Growth' }] },
      },
    });
    const intake = readIntake({ ...INTAKE, stage: 'GROWTH' });
    const stage = () => intakeLines(intake).find((l) => l.label === 'Stage')!.value;
    assert.equal(stage(), 'Growth stage');
    assert.throws(() => readIntake({ ...INTAKE, stage: 'SERIES_Z' }), /stage/);

    const contact = { name: 'Avery Stone', email: 'finance@harbor.example.com', phone: '+1 (415) 555-0142' };
    const recap = composeRecapEmail({
      companyName: 'Harbor Robotics, Inc.', to: 'avery@example.com', toName: 'Avery Stone', contact, intake, documents: [], notes: null,
      statusUrl: 'https://app.example.test/compliance/409a', replyTo: null,
    });
    assert.match(recap.text, /^Ledgerly has your request/m);
    assert.match(recap.text, /The Acme valuation desk will contact you/);
    assert.match(recap.text, /The 409A page in Ledgerly/);
    assert.match(recap.text, /^— The Ledgerly team$/m);
    assert.doesNotMatch(recap.text + recap.html, /Kosmitor/);
    const closed = composeClosedEmail({ companyName: 'Harbor Robotics, Inc.', to: 'desk@example.test', requestedAt: '2025-07-01T10:00:00.000Z', how: 'CANCELLED' });
    assert.equal(closed.toName, 'Acme valuation desk');
    assert.match(closed.text, /^— The Ledgerly team$/m);
    assert.doesNotMatch(closed.text + closed.html, /Kosmitor/);

    // An answer stored before its choice left the list still reads as it was stored.
    offerTheDesk();
    assert.equal(stage(), 'GROWTH');
  } finally {
    offerTheDesk();
  }
});

test('a request made before the intake questions cannot be sent to the team, but can be cancelled', async () => {
  const other = (await call('POST', '/api/companies', { name: 'Older Harbor' }, admin)).json.id as string;
  await run(`INSERT INTO valuation_requests (id, company_id, status, provider, provider_email, requested_by, created_at)
             VALUES ('vrq_legacy', ?, 'REQUESTED', 'Ledgerline Valuations', 'intake@ledgerline.example.com', 'Avery Stone', ?)`, other, new Date().toISOString());
  const sent = await call('POST', `/api/c/${other}/valuation-requests/vrq_legacy/send`, {}, admin);
  assert.equal(sent.status, 400);
  assert.match(sent.json.error, /before the intake questions/);
  const listed = (await call('GET', `/api/c/${other}/valuation-requests`, undefined, admin)).json[0];
  assert.equal(listed.answers, null);
  assert.equal((await call('PATCH', `/api/c/${other}/valuation-requests/vrq_legacy`, { status: 'CANCELLED' }, admin)).json.status, 'CANCELLED');
});

test('completing before the report is delivered tells the team, in words that claim nothing about where the 409A came from', async () => {
  await forgetLimits();
  const other = (await call('POST', '/api/companies', { name: 'Early Harbor' }, admin)).json.id as string;
  const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  await run('UPDATE valuation_requests SET desk_notified_at = ? WHERE id = ?', new Date().toISOString(), req.id);
  const v = (await call('POST', `/api/c/${other}/valuations`, { type: '409A', fairMarketValue: 300_000, effectiveDate: '2026-01-15', status: 'ACTIVE' }, admin)).json;
  outbox.length = 0;
  const done = await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'COMPLETED', valuationId: v.id }, admin);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const notice = outbox.filter((m) => m.to === 'desk@example.test');
  assert.equal(notice.length, 1);
  assert.match(notice[0].text, /recorded a 409A and closed its request/);
  assert.doesNotMatch(notice[0].text, /elsewhere/);
});

test('a cancel and a team update sent at the same moment cannot both win', async () => {
  await forgetLimits();
  for (let round = 0; round < 4; round++) {
    await forgetLimits();
    const other = (await call('POST', '/api/companies', { name: `Race Harbor ${round}` }, admin)).json.id as string;
    const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
    outbox.length = 0;
    await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, {}, admin);
    const token = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
    await Promise.all([
      call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin),
      desk('POST', '/status', token, { action: 'START' }),
    ]);
    const row = await one<{ status: string }>('SELECT status FROM valuation_requests WHERE id = ?', req.id);
    assert.equal(row!.status, 'CANCELLED', `round ${round}: the cancel stands`);
    const kinds = (await all<{ kind: string }>('SELECT kind FROM valuation_request_events WHERE request_id = ? ORDER BY created_at, id', req.id)).map((e) => e.kind);
    assert.ok(kinds.indexOf('IN_PROGRESS') === -1 || kinds.indexOf('IN_PROGRESS') < kinds.indexOf('CANCELLED'),
      `round ${round}: nothing happens after the close (${kinds.join(', ')})`);
  }
});

test('an expired link stays expired when the request later closes', async () => {
  await forgetLimits();
  const other = (await call('POST', '/api/companies', { name: 'Stale Harbor' }, admin)).json.id as string;
  const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  outbox.length = 0;
  await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, {}, admin);
  const token = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
  await run('UPDATE valuation_requests SET desk_token_at = ? WHERE id = ?', new Date(Date.now() - (limits().linkOpenDays + 1) * 86_400_000).toISOString(), req.id);
  assert.equal((await desk('GET', '', token)).status, 404, 'linkOpenDays on, the link is dead');
  await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin);
  assert.equal((await desk('GET', '', token)).status, 404, 'and closing the request does not bring it back');
});

test('notices to the team are limited per request, per company and per person, before the hourly limit for everyone', async () => {
  await forgetLimits();
  const other = (await call('POST', '/api/companies', { name: 'Loud Harbor' }, admin)).json.id as string;
  const req = (await call('POST', `/api/c/${other}/valuation-requests`, await intakeFor(other), admin)).json;
  const stamp = new Date(Date.now() - 5 * 60_000).toISOString();
  const insertNotices = async (prefix: string, n: number, company: string, entity: string, userId: string | null) => {
    for (let i = 0; i < n; i++) {
      await run(`INSERT INTO audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, created_at)
                 VALUES (?, ?, ?, 'NOTIFY_DESK', 'valuation_requests', ?, 'sent', ?)`, `${prefix}${i}`, company, userId, entity, stamp);
    }
  };
  await insertNotices('aud_r', limits().noticesPerRequestPerDay, other, req.id, null);
  const perRequest = await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, { again: true }, admin);
  assert.equal(perRequest.status, 200);
  assert.match(perRequest.json.deskError, /three times today/);
  await run(`DELETE FROM audit_log WHERE id LIKE 'aud_r%' OR (entity_id = ? AND action LIKE 'NOTIFY%') OR (entity_id = ? AND action LIKE 'SEND%')`, req.id, req.id);

  await insertNotices('aud_k', limits().noticesPerCompanyPerDay, other, 'vrq_elsewhere', null);
  const perCompany = await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, { again: true }, admin);
  assert.match(perCompany.json.deskError, /five notices from this company today/);
  await run(`DELETE FROM audit_log WHERE id LIKE 'aud_k%' OR (entity_id = ? AND action LIKE 'NOTIFY%') OR (entity_id = ? AND action LIKE 'SEND%')`, req.id, req.id);

  const me = await one<{ id: string }>("SELECT id FROM users WHERE email = 'avery@example.com'");
  await insertNotices('aud_p', limits().noticesPerPersonPerDay, cid, 'vrq_mine', me!.id);
  const perPerson = await call('POST', `/api/c/${other}/valuation-requests/${req.id}/send`, { again: true }, admin);
  assert.match(perPerson.json.deskError, /ten notices today/);
  await run(`DELETE FROM audit_log WHERE id LIKE 'aud_p%'`);
  await call('PATCH', `/api/c/${other}/valuation-requests/${req.id}`, { status: 'CANCELLED' }, admin);
});

test('a schedule or plan named after a holder is numbered in the workbook instead', async () => {
  const named = await call('POST', `/api/c/${cid}/vesting-schedules`, { name: 'Priya Raman special', kind: 'TIME', durationMonths: 24, cliffMonths: 0, frequency: 'MONTHLY' }, admin);
  assert.equal(named.status, 200, JSON.stringify(named.json));
  await call('POST', `/api/c/${cid}/awards`, {
    label: 'Retention grant', stakeholderId: priya.id, poolId: pool.id, type: 'NSO', quantity: 1_000,
    strikePrice: 200_000, grantDate: '2025-05-01', vestingScheduleId: named.json.id,
  }, admin);
  await call('POST', `/api/c/${cid}/pools`, { name: 'Northwind Ventures side plan', shareClassId: common.id, authorized: 10_000 }, admin);
  const res = await fetch(`${base}/api/c/${cid}/valuation-requests/package.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  const everything = JSON.stringify(parseXlsx(Buffer.from(await res.arrayBuffer())));
  for (const who of HOLDERS) assert.ok(!everything.includes(who), `the workbook names ${who}`);
  assert.match(everything, /Schedule \d+/);
  assert.match(everything, /Plan \d+/);
});

test('the data workbook carries the structure as numbers and names nobody', async () => {
  const res = await fetch(`${base}/api/c/${cid}/valuation-requests/package.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
  const sheets = parseXlsx(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(sheets.map((s) => s.name),
    ['Summary', 'Share classes', 'Financings', 'Options and awards', 'Warrants', 'Equity plans', 'Valuation history']);

  const everything = JSON.stringify(sheets);
  for (const who of HOLDERS) assert.ok(!everything.includes(who), `the workbook names ${who}`);

  const classes = sheets.find((s) => s.name === 'Share classes')!.rows;
  const pref = classes.find((r) => r[0] === 'Series A Preferred')!;
  assert.equal(pref[3], 1_000_000, 'outstanding shares as a number');
  assert.equal(pref[4], 1.5, 'issue price in dollars, not micro-dollars');

  const grants = sheets.find((s) => s.name === 'Options and awards')!.rows;
  assert.equal(grants[1][0], 'Grant 1', 'a label carrying a holder is replaced by a number');

  const financings = sheets.find((s) => s.name === 'Financings')!.rows;
  const sale = financings.find((r) => r[1] === 'Series A Preferred')!;
  assert.equal(sale[4], 1_500_000, 'amount raised in dollars');
});

test('an employee reaches none of it', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE', stakeholderId: priya.id }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const employee = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).token as string;

  for (const path of ['valuation-refresh', 'valuation-requests', 'valuation-requests/package.xlsx', 'valuation-requests/checklist']) {
    const r = await fetch(`${base}/api/c/${cid}/${path}`, { headers: { Authorization: `Bearer ${employee}` } });
    assert.equal(r.status, 403, `${path} answered ${r.status}`);
  }
  const make = await call('POST', `/api/c/${cid}/valuation-requests`, INTAKE, employee);
  assert.equal(make.status, 403);
});

test('every valuation type and state the Record valuation form offers can be saved', async () => {
  for (const type of ['409A', 'PREFERRED_PRICE', 'BOARD_ESTIMATE', 'SECONDARY']) {
    const r = await call('POST', `/api/c/${cid}/valuations`, { type, fairMarketValue: 100_000, effectiveDate: '2024-01-01', status: 'SUPERSEDED' }, admin);
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.json)}`);
  }
  for (const status of ['DRAFT', 'ACTIVE', 'EXPIRED', 'SUPERSEDED']) {
    const r = await call('POST', `/api/c/${cid}/valuations`, { type: 'BOARD_ESTIMATE', fairMarketValue: 100_000, effectiveDate: '2024-01-01', status }, admin);
    assert.equal(r.status, 200, `${status}: ${JSON.stringify(r.json)}`);
  }
});

test('a board member reads requests but cannot make or change them, and the sample company is read-only', async () => {
  const board = await call('POST', `/api/c/${cid}/members`, { email: 'blake@example.com', name: 'Blake Ortiz', role: 'BOARD' }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${board.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const director = (await call('POST', '/api/auth/reset', { token, password: 'blake-pass-1' })).token as string;
  assert.equal((await call('GET', `/api/c/${cid}/valuation-requests`, undefined, director)).status, 200);
  assert.equal((await call('POST', `/api/c/${cid}/valuation-requests`, INTAKE, director)).status, 403);

  const sample = (await call('POST', '/api/companies', { name: 'Sample Harbor' }, admin)).json.id as string;
  await run('UPDATE companies SET is_sample = 1 WHERE id = ?', sample);
  invalidate(sample);
  const refused = await call('POST', `/api/c/${sample}/valuation-requests`, INTAKE, admin);
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
});

test('after a stock split the workbook keeps every count and price on one basis', async () => {
  const split = await call('POST', `/api/c/${cid}/stock-splits`, { date: '2026-01-02', ratio: 2 }, admin);
  assert.equal(split.status, 200, JSON.stringify(split.json));
  const res = await fetch(`${base}/api/c/${cid}/valuation-requests/package.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  const classes = parseXlsx(Buffer.from(await res.arrayBuffer())).find((s) => s.name === 'Share classes')!.rows;
  const pref = classes.find((r) => r[0] === 'Series A Preferred')!;
  assert.deepEqual([pref[2], pref[3], pref[4]], [6_000_000, 2_000_000, 0.75], 'authorized, outstanding and issue price all split');
});

// --- The appraiser's information request ----------------------------------------

/** Makes a request that should be accepted, then cancels it so the next one can be made. */
async function accepted(companyId: string, body: Record<string, unknown>) {
  await forgetLimits();
  const r = await call('POST', `/api/c/${companyId}/valuation-requests`, body, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await call('PATCH', `/api/c/${companyId}/valuation-requests/${r.json.id}`, { status: 'CANCELLED' }, admin);
  return r.json;
}
async function refused(companyId: string, body: Record<string, unknown>, error: RegExp) {
  const r = await call('POST', `/api/c/${companyId}/valuation-requests`, body, admin);
  assert.equal(r.status, 400, `accepted ${JSON.stringify(body).slice(0, 200)}`);
  assert.match(r.json.error, error);
  return r.json.error as string;
}
const newCompany = async (name: string, extra: Record<string, unknown> = {}) =>
  (await call('POST', '/api/companies', { name, ...extra }, admin)).json.id as string;
const itemsOf = (request: { documents: { item: string }[] }) => request.documents.map((d) => d.item);

test('every item of the information request is mandatory on the server, each refused with its own message, and nothing is saved', async () => {
  await forgetLimits();
  const company = await newCompany('Strict Harbor');
  const body = await intakeFor(company);
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const row = <T extends object>(base: T, change: Partial<Record<keyof T, unknown>>) => ({ ...base, ...change });
  const cases: [Record<string, unknown>, RegExp][] = [
    // 1. The valuation date, the most recent one or one within a year of today.
    [{ valuationDateKind: undefined }, /^Choose the date to value the common stock as of, or the most recent date\.$/],
    [{ valuationDateKind: 'SOON' }, /^Choose the date to value the common stock as of/],
    [{ valuationDateKind: 'DATE', valuationDate: null }, /^Give the valuation date\.$/],
    [{ valuationDateKind: 'DATE', valuationDate: '2026-02-30' }, /^Give the valuation date\.$/],
    [{ valuationDateKind: 'DATE', valuationDate: inDays(400) }, /^Choose a valuation date within a year of today\.$/],
    [{ valuationDateKind: 'DATE', valuationDate: inDays(-400) }, /within a year of today/],
    // 2. Historical and year-to-date statements; 3. the pitch deck.
    [{ documents: without(body, 'HISTORICAL_FINANCIALS') }, /^Attach the historical financial statements, or say the company has not finished a financial year yet\.$/],
    [{ documents: without(body, 'YTD_FINANCIALS') }, /^Attach the year-to-date financial statements\.$/],
    [{ noFullYearYet: true, documents: without(body, 'YTD_FINANCIALS') }, /^Attach the year-to-date financial statements\.$/],
    [{ documents: without(body, 'PITCH_DECK') }, /^Attach the pitch deck or a company presentation\.$/],
    [{ documents: [] }, /^Attach the historical financial statements/],
    [{ documents: undefined }, /^Attach the historical financial statements/],
    // 4. The management team, one to thirty people, each with a name and a title.
    [{ management: undefined }, /^List at least one person on the management team, with their title\.$/],
    [{ management: [] }, /^List at least one person on the management team/],
    [{ management: [{ name: 'Avery Stone', title: ' ' }] }, /^Management team, person 1: give their title\.$/],
    [{ management: [{ name: 'Avery Stone', title: 'CEO' }, { title: 'CFO' }] }, /^Management team, person 2: give their name\.$/],
    [{ management: ['Avery Stone'] }, /^Management team, person 1: give their name\.$/],
    [{ management: [{ name: 'A'.repeat(201), title: 'CEO' }] }, /^Management team, person 1: keep the name to 200 characters or fewer\.$/],
    [{ management: Array.from({ length: 31 }, () => ({ name: 'Avery Stone', title: 'CEO' })) }, /^List at most 30 people on the management team\.$/],
    // 5. The cap table and option ledger, confirmed.
    [{ capTableConfirmed: false }, /^Confirm the cap table and option ledger are up to date\.$/],
    [{ capTableConfirmed: 'yes' }, /^Confirm the cap table and option ledger are up to date\.$/],
    // 6. The options to grant, a whole number, nought included.
    [{ optionsToGrant: undefined }, /^Give a ballpark number of options to grant in the next 6 to 12 months, or 0\.$/],
    [{ optionsToGrant: -1 }, /ballpark number of options/],
    [{ optionsToGrant: 12.5 }, /ballpark number of options/],
    [{ optionsToGrant: '5000' }, /ballpark number of options/],
    [{ optionsToGrant: 20_000_000_000 }, /ballpark number of options/],
    // 7. The report of an earlier 409A; 8. the charter.
    [{ documents: without(body, 'PRIOR_VALUATIONS') }, /^Attach the report of the last 409A\.$/],
    [{ documents: without(body, 'CHARTER') }, /^Attach the certificate of incorporation\.$/],
    // 9. SAFEs and notes: answered, and their agreements when there are some.
    [{ convertiblesOutstanding: undefined }, /^Say whether any SAFEs or convertible notes are outstanding\.$/],
    [{ convertiblesOutstanding: 'no' }, /^Say whether any SAFEs or convertible notes are outstanding\.$/],
    [{ convertiblesOutstanding: true }, /^Attach the SAFE and convertible note agreements, or say none are outstanding\.$/],
    // 10. Projections as a file, or two or three consecutive years of guidance.
    [{ projections: undefined }, /^Say whether you will attach projections or give revenue and EBITDA guidance\.$/],
    [{ projections: 'MAYBE' }, /attach projections or give revenue and EBITDA guidance/],
    [{ documents: without(body, 'PROJECTIONS') }, /^Attach the financial projections, or give revenue and EBITDA guidance instead\.$/],
    [{ projections: 'GUIDANCE', guidance: [] }, /^Give revenue and EBITDA guidance for the next two or three years\.$/],
    [{ projections: 'GUIDANCE', guidance: GUIDANCE.slice(0, 1) }, /two or three years/],
    [{ projections: 'GUIDANCE', guidance: [...GUIDANCE, ...GUIDANCE] }, /two or three years/],
    [{ projections: 'GUIDANCE', guidance: [GUIDANCE[0], { ...GUIDANCE[1], year: YEAR + 2 }] }, /^Give the guidance for consecutive years, the earliest first\.$/],
    [{ projections: 'GUIDANCE', guidance: [GUIDANCE[1], GUIDANCE[0]] }, /consecutive years/],
    [{ projections: 'GUIDANCE', guidance: [{ ...GUIDANCE[0], year: YEAR + 20 }, GUIDANCE[1]] }, new RegExp(`^Guidance row 1: give a fiscal year from ${YEAR - 1} to ${YEAR + 10}\\.$`)],
    [{ projections: 'GUIDANCE', guidance: [GUIDANCE[0], { ...GUIDANCE[1], revenue: 1.5 }] }, /^Guidance row 2: give the revenue\.$/],
    [{ projections: 'GUIDANCE', guidance: [GUIDANCE[0], { ...GUIDANCE[1], revenue: -1 }] }, /^Guidance row 2: give the revenue\.$/],
    [{ projections: 'GUIDANCE', guidance: [{ ...GUIDANCE[0], ebitda: undefined }, GUIDANCE[1]] }, /^Guidance row 1: give the EBITDA/],
    // 11. Secondary transactions: answered, and every detail the checklist lists for each.
    [{ secondary: undefined }, /^Say whether there has been a secondary transaction in the company’s stock\.$/],
    [{ secondary: 1 }, /secondary transaction in the company’s stock/],
    [{ secondary: true, secondaryTransactions: [] }, /^List at least one secondary transaction, or answer no\.$/],
    [{ secondary: true, secondaryTransactions: Array(21).fill(TRADE) }, /^List at most 20 secondary transactions\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { securityType: 'BONDS' })] }, /^Secondary transaction 1: choose the type of security\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { date: inDays(3) })] }, /^Secondary transaction 1: the date cannot be in the future\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { date: 'last spring' })] }, /^Secondary transaction 1: give a real date, or leave it out\.$/],
    [{ secondary: true, secondaryTransactions: [TRADE, row(TRADE, { shares: 0 })] }, /^Secondary transaction 2: give the number of shares\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { shares: 10.5 })] }, /^Secondary transaction 1: give the number of shares\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { pricePerShare: -1 })] }, /^Secondary transaction 1: give the price per share\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { priceRationale: '' })] }, /^Secondary transaction 1: say how the price was set\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { priceRationale: 'x'.repeat(1001) })] }, /keep how the price was set to 1000 characters or fewer/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { rationale: undefined })] }, /^Secondary transaction 1: say why it happened\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { buyer: '' })] }, /^Secondary transaction 1: say who bought, such as "a new investor"\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { seller: '  ' })] }, /^Secondary transaction 1: say who sold, such as "a co-founder"\.$/],
    [{ secondary: true, secondaryTransactions: [row(TRADE, { expectRepeat: undefined })] }, /^Secondary transaction 1: say whether you expect it to happen again\.$/],
    // 12. Sweat equity: answered, and every detail for each person.
    [{ sweatEquity: undefined }, /^Say whether any key people have taken a below-market salary since the company started\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [] }, /^List at least one person on a below-market salary, or answer no\.$/],
    [{ sweatEquity: true, sweatEquityPeople: Array(21).fill(PERSON) }, /^List at most 20 people on below-market salaries\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { name: '' })] }, /^Below-market salary, person 1: give their name\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { title: '' })] }, /^Below-market salary, person 1: give their title\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { from: null })] }, /^Below-market salary, person 1: give the date it started\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { from: inDays(5), to: null })] }, /^Below-market salary, person 1: the start cannot be in the future\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { to: '2023-12-31' })] }, /^Below-market salary, person 1: the end cannot be before the start\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { to: inDays(5) })] }, /^Below-market salary, person 1: the end cannot be in the future/],
    [{ sweatEquity: true, sweatEquityPeople: [PERSON, row(PERSON, { timePercent: 0 })] }, /^Below-market salary, person 2: give the share of each working day spent on the company, from 1 to 100 percent\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { timePercent: 101 })] }, /from 1 to 100 percent/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { marketSalary: undefined })] }, /^Below-market salary, person 1: give the market salary for the role, a year\.$/],
    [{ sweatEquity: true, sweatEquityPeople: [row(PERSON, { salaryReceived: -5 })] }, /^Below-market salary, person 1: give the salary received in total since the company started\.$/],
    // 13. Expenses recorded below market rates: answered, and what, what was recorded and the market rate.
    [{ belowMarketExpenses: undefined }, /^Say whether any operating expenses are recorded below market rates\.$/],
    [{ belowMarketExpenses: true, expenses: [] }, /^List at least one expense recorded below market rates, or answer no\.$/],
    [{ belowMarketExpenses: true, expenses: [row(EXPENSE, { nature: '' })] }, /^Below-market expense 1: say what the expense is\.$/],
    [{ belowMarketExpenses: true, expenses: [row(EXPENSE, { nature: 'x'.repeat(501) })] }, /keep what the expense is to 500 characters or fewer/],
    [{ belowMarketExpenses: true, expenses: [row(EXPENSE, { recorded: -1 })] }, /^Below-market expense 1: give the amount recorded in the books, a year\.$/],
    [{ belowMarketExpenses: true, expenses: [EXPENSE, row(EXPENSE, { market: '36000' })] }, /^Below-market expense 2: give the market rate, a year\.$/],
  ];
  for (const [change, error] of cases) {
    const r = await call('POST', `/api/c/${company}/valuation-requests`, { ...body, ...change }, admin);
    assert.equal(r.status, 400, `accepted ${JSON.stringify(change).slice(0, 200)}`);
    assert.match(r.json.error, error, JSON.stringify(change).slice(0, 200));
  }
  assert.equal((await all('SELECT id FROM valuation_requests WHERE company_id = ?', company)).length, 0, 'no request was saved');
  assert.equal((await all('SELECT request_id FROM valuation_request_documents WHERE company_id = ?', company)).length, 0, 'and no document was linked');
  // The same answers, whole, are accepted: each refusal above was for its one change.
  await accepted(company, body);
});

test('the answers decide which documents are needed, and a "no" keeps no rows and no documents', async () => {
  const company = await newCompany('Conditional Harbor');
  const body = await intakeFor(company);

  // A company without a full year behind it has no historical statements to send, and any sent are not kept.
  const young = await accepted(company, { ...body, noFullYearYet: true, documents: without(body, 'HISTORICAL_FINANCIALS') });
  assert.ok(young.answerLines.some((l: any) => l.label === 'Financial statements' && l.value === 'The company has not finished a financial year yet'));
  assert.ok(!itemsOf(await accepted(company, { ...body, noFullYearYet: true })).includes('HISTORICAL_FINANCIALS'));
  assert.ok(!(await accepted(company, body)).answerLines.some((l: any) => l.label === 'Financial statements'), 'a full year says nothing');

  // A 409A on record needs its report; with none it does not, though one sent anyway is kept.
  await refused(company, { ...body, documents: without(body, 'PRIOR_VALUATIONS') }, /^Attach the report of the last 409A\.$/);
  await accepted(company, { ...body, last409a: 'NEVER', last409aDate: null, documents: without(body, 'PRIOR_VALUATIONS') });
  assert.ok(itemsOf(await accepted(company, { ...body, last409a: 'UNKNOWN' })).includes('PRIOR_VALUATIONS'));

  // SAFEs or notes outstanding need their agreements; none outstanding keeps none.
  const agreements = await upload(company, 'SAFE agreements.pdf', '%PDF-1.4 the SAFEs', { category: 'FINANCING' });
  const withAgreements = [...body.documents, { item: 'CONVERTIBLE_AGREEMENTS', documentId: agreements.id }];
  await refused(company, { ...body, convertiblesOutstanding: true }, /^Attach the SAFE and convertible note agreements/);
  const safes = await accepted(company, { ...body, convertiblesOutstanding: true, documents: withAgreements });
  assert.ok(itemsOf(safes).includes('CONVERTIBLE_AGREEMENTS'));
  assert.ok(safes.answerLines.some((l: any) => l.label === 'SAFEs or notes outstanding' && l.value === 'Yes'));
  assert.ok(!itemsOf(await accepted(company, { ...body, documents: withAgreements })).includes('CONVERTIBLE_AGREEMENTS'));

  // Projections as a file need the file; guidance needs two or three consecutive years, and then no file is kept.
  await refused(company, { ...body, documents: without(body, 'PROJECTIONS') }, /^Attach the financial projections/);
  const guided = await accepted(company, { ...body, projections: 'GUIDANCE', guidance: GUIDANCE });
  assert.ok(!itemsOf(guided).includes('PROJECTIONS'));
  assert.deepEqual(guided.answers.guidance, GUIDANCE);
  assert.ok(guided.answerLines.some((l: any) => l.label === 'Projections' && l.value === 'Revenue and EBITDA guidance, below'));
  assert.deepEqual(guided.tables.find((t: any) => t.title === 'Revenue and EBITDA guidance'), {
    title: 'Revenue and EBITDA guidance', columns: ['Fiscal year', 'Revenue', 'EBITDA'],
    rows: [[String(YEAR), '$1,200,000', '-$300,000'], [String(YEAR + 1), '$3,100,000', '$150,000']],
  });
  const three = await accepted(company, { ...body, projections: 'GUIDANCE', guidance: [...GUIDANCE, { year: YEAR + 2, revenue: 640_000_050, ebitda: 0 }] });
  assert.deepEqual(three.tables.find((t: any) => t.title === 'Revenue and EBITDA guidance').rows[2], [String(YEAR + 2), '$6,400,000.50', '$0']);
  assert.deepEqual((await accepted(company, { ...body, guidance: GUIDANCE })).answers.guidance, [], 'guidance sent with a file is not kept');

  // Each yes keeps its rows and shows them as a table; each no keeps none, whatever was sent.
  const yes = await accepted(company, { ...body, ...RICH });
  assert.deepEqual([yes.answers.secondaryTransactions, yes.answers.sweatEquityPeople, yes.answers.expenses], [[TRADE], [PERSON], [EXPENSE]]);
  assert.deepEqual(yes.tables.map((t: any) => t.title),
    ['Management team', 'Revenue and EBITDA guidance', 'Secondary transactions', 'People on below-market salaries', 'Expenses below market rates']);
  assert.deepEqual(yes.tables.find((t: any) => t.title === 'Secondary transactions').rows, [[
    'Common stock', 'Nov 14, 2025', '40,000', '$1.20', TRADE.priceRationale, TRADE.rationale, 'A new investor', 'A co-founder', 'No',
  ]]);
  assert.deepEqual(yes.tables.find((t: any) => t.title === 'People on below-market salaries').rows, [[
    'Avery Stone', 'Chief executive officer', 'Jan 10, 2024 to Jun 30, 2025', '100% of each working day', '$220,000', '$60,000',
  ]]);
  assert.deepEqual(yes.tables.find((t: any) => t.title === 'Expenses below market rates').rows, [[EXPENSE.nature, '$0', '$36,000']]);
  for (const label of ['People on below-market salaries', 'Secondary transactions', 'Expenses below market rates']) {
    assert.equal(yes.answerLines.find((l: any) => l.label === label).value, 'One, below');
  }
  const ongoing = await accepted(company, { ...body, sweatEquity: true, sweatEquityPeople: [{ ...PERSON, name: '  Rowan   Hale ', to: null }] });
  assert.deepEqual(ongoing.tables.find((t: any) => t.title === 'People on below-market salaries').rows[0].slice(0, 3),
    ['Rowan Hale', 'Chief executive officer', 'Jan 10, 2024 to today'], 'trimmed, and still the case today');

  const no = await accepted(company, { ...body, secondaryTransactions: [TRADE], sweatEquityPeople: [PERSON], expenses: [EXPENSE] });
  assert.deepEqual([no.answers.secondaryTransactions, no.answers.sweatEquityPeople, no.answers.expenses], [[], [], []]);
  assert.deepEqual(no.tables.map((t: any) => t.title), ['Management team']);
  for (const label of ['People on below-market salaries', 'Secondary transactions', 'Expenses below market rates']) {
    assert.equal(no.answerLines.find((l: any) => l.label === label).value, 'None');
  }
});

test('documents come only from the company’s own vault and must have something to open, and each link is written once, with its request', async () => {
  await forgetLimits();
  const company = await newCompany('Vault Harbor');
  const body = await intakeFor(company);
  const elsewhere = await newCompany('Elsewhere Holdings');
  const theirs = await upload(elsewhere, 'Elsewhere Holdings board minutes.pdf', '%PDF-1.4 not yours');

  const crossed = await refused(company, { ...body, documents: [...body.documents, { item: 'PITCH_DECK', documentId: theirs.id }] },
    /^One of the documents is not in this company’s vault\. Choose it again from the vault\.$/);
  assert.doesNotMatch(crossed, /Elsewhere|minutes/, 'nothing about the other company');
  assert.equal(await refused(company, { ...body, documents: [...body.documents, { item: 'PITCH_DECK', documentId: 'doc_nonexistent' }] }, /vault/),
    crossed, 'and the same words as for a document that does not exist');
  const blank = await written(company, 'Blank page', '');
  await refused(company, { ...body, documents: [...body.documents, { item: 'PITCH_DECK', documentId: blank.id }] },
    /^"Blank page" has no file and no text, so there is nothing to send\. Choose another document\.$/);
  await refused(company, { ...body, documents: [...body.documents, { item: 'TAX_RETURNS', documentId: body.documents[0].documentId }] },
    /does not ask for/);
  await refused(company, { ...body, documents: Array(101).fill(body.documents[0]) }, /^Attach at most 100 documents to one request\.$/);
  assert.equal((await all('SELECT request_id FROM valuation_request_documents WHERE company_id = ?', company)).length, 0,
    'nothing is linked by a refused request');

  // Twice for one item is once; one document may answer two items; text alone is something to open.
  const deck = body.documents.find((d) => d.item === 'PITCH_DECK')!;
  const memo = await written(company, 'How the business works', 'The business, in words.');
  const made = await accepted(company, {
    ...body,
    documents: [...body.documents, deck, { item: 'YTD_FINANCIALS', documentId: deck.documentId }, { item: 'PITCH_DECK', documentId: memo.id }],
  });
  const links = await all<{ item: string; document_id: string }>('SELECT item, document_id FROM valuation_request_documents WHERE request_id = ?', made.id);
  assert.equal(links.length, body.documents.length + 2);
  assert.deepEqual(links.filter((l) => l.document_id === deck.documentId).map((l) => l.item).sort(), ['PITCH_DECK', 'YTD_FINANCIALS']);
  assert.ok(made.documents.some((d: any) => d.id === memo.id && d.hasBody && d.fileName === null));
  assert.deepEqual(made.documents.find((d: any) => d.id === deck.documentId && d.item === 'PITCH_DECK'), {
    item: 'PITCH_DECK', itemLabel: 'Pitch deck or company presentation', id: deck.documentId, name: 'Company presentation.pdf',
    fileName: 'Company presentation.pdf', mimeType: 'application/pdf', sizeBytes: made.documents.find((d: any) => d.id === deck.documentId).sizeBytes,
    hasBody: false, createdAt: made.documents.find((d: any) => d.id === deck.documentId).createdAt,
  });
});

test('a viewer sees a request’s documents only as far as the vault shows them to everyone', async () => {
  await forgetLimits();
  const company = await newCompany('Viewing Harbor');
  const body = await intakeFor(company);
  const shared = await upload(company, 'Company overview for everyone.pdf', '%PDF-1.4 shared', { visibility: 'ALL' });
  const made = await accepted(company, { ...body, documents: [...body.documents, { item: 'PITCH_DECK', documentId: shared.id }] });
  const member = await call('POST', `/api/c/${company}/members`, { email: 'drew@example.com', name: 'Drew Park', role: 'VIEWER' }, admin);
  const link = await call('POST', `/api/c/${company}/members/${member.json.id}/reset-password`, { mode: 'link' }, admin);
  const viewer = (await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: 'drew-pass-1' })).token as string;
  const seen = (await call('GET', `/api/c/${company}/valuation-requests`, undefined, viewer)).json.find((r: any) => r.id === made.id);
  assert.deepEqual(seen.documents.map((d: any) => d.id), [shared.id]);
  assert.equal(seen.documentsHidden, new Set(body.documents.map((d) => d.documentId)).size, 'and is told how many others were sent, each once');
  assert.equal(made.documentsHidden, 0);
  assert.deepEqual(seen.answerLines, made.answerLines, 'the answers are the same');
  const offered = (await call('GET', `/api/c/${company}/valuation-requests/checklist`, undefined, viewer)).json;
  assert.ok(Object.values(offered.suggestions).flat().every((d: any) => d.id === shared.id));
});

let documentsNotice: Sent | undefined;
let documentsRecap: Sent | undefined;
const documentNames: string[] = [];
const documentIds: string[] = [];

test('the team’s page lists the documents and the tables, and its link alone downloads them, one by one or in one ZIP, while the request is open', async () => {
  await forgetLimits();
  const body = await intakeFor(cid, RICH);
  // Bytes that are not text, so a download that reads and rewrites them shows.
  const accounts = Buffer.concat([Buffer.from('%PDF-1.4 year to date '), Buffer.from([0, 255, 128, 10, 13, 9])]);
  const ytd = await upload(cid, 'Year-to-date accounts (Q1–Q3).pdf', accounts);
  const twin = await upload(cid, '2023 to 2025 financial statements.pdf', '%PDF-1.4 the same name, another file');
  const memo = await written(cid, 'How the business works', 'The business, in words.');
  const stray = await upload(cid, 'Office lease.pdf', '%PDF-1.4 never sent');
  const documents = [
    ...without(body, 'YTD_FINANCIALS'), { item: 'YTD_FINANCIALS', documentId: ytd.id },
    { item: 'HISTORICAL_FINANCIALS', documentId: twin.id }, { item: 'PITCH_DECK', documentId: memo.id },
  ];
  const made = await call('POST', `/api/c/${cid}/valuation-requests`, { ...body, documents }, admin);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.id as string;
  documentNames.push(...made.json.documents.map((d: any) => d.name));
  documentIds.push(...made.json.documents.map((d: any) => d.id));
  outbox.length = 0;
  await call('POST', `/api/c/${cid}/valuation-requests/${id}/send`, {}, admin);
  documentsNotice = outbox.find((m) => m.to === 'desk@example.test');
  documentsRecap = outbox.find((m) => m.subject.startsWith('Your 409A request'));
  const token = tokenIn(documentsNotice!.text);

  const page = await desk('GET', '', token);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  assert.deepEqual(page.json.tables, made.json.tables, 'the same tables as the company’s page');
  assert.deepEqual(page.json.documents, made.json.documents, 'and the same documents');
  assert.ok(page.json.documents.some((d: any) => d.id === ytd.id && d.itemLabel === 'Year-to-date financial statements'));

  const get = (path: string, t: string | null = token) =>
    fetch(`${base}/api/valuation-desk${path}`, { headers: t ? { 'X-Desk-Token': t } : {} });
  const file = await get(`/documents/${ytd.id}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), accounts, 'the file as it was uploaded, byte for byte');
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('content-disposition'),
    `attachment; filename="Year-to-date accounts (Q1_Q3).pdf"; filename*=UTF-8''Year-to-date%20accounts%20%28Q1%E2%80%93Q3%29.pdf`);
  assert.equal(file.headers.get('cache-control'), 'no-store');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  const rendered = await get(`/documents/${memo.id}`);
  assert.equal(rendered.status, 200);
  assert.equal(rendered.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await rendered.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'a document with only text comes as a PDF');
  assert.match(rendered.headers.get('content-disposition')!, /filename="How the business works\.pdf"/);
  const own = await fetch(`${base}/api/c/${cid}/documents/${memo.id}/pdf`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(pdf.length, Buffer.from(await own.arrayBuffer()).length, 'the same PDF the company’s own download makes');

  assert.equal((await get(`/documents/${stray.id}`)).status, 404, 'a document of the company that was not sent');
  const otherCompany = [...filed.keys()].find((k) => k !== cid)!;
  assert.equal((await get(`/documents/${filed.get(otherCompany)![0].documentId}`)).status, 404, 'or another company’s');
  for (const bad of [null, '', 'x'.repeat(43)]) {
    assert.equal((await get(`/documents/${ytd.id}`, bad)).status, 404, `opened with ${JSON.stringify(bad)}`);
    assert.equal((await get('/documents.zip', bad)).status, 404);
  }

  const archive = await get('/documents.zip');
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.match(archive.headers.get('content-disposition')!, /^attachment; filename="409a-documents-\d{4}-\d{2}-\d{2}\.zip"/);
  const zipped = Buffer.from(await archive.arrayBuffer());
  assert.equal(zipped.readUInt16LE(8), 0, 'files are stored as they are, not compressed');
  const entries = readZip(zipped);
  // Projections were answered with guidance, so the file sent for them was not kept and is not here.
  assert.deepEqual([...entries.keys()], [
    'Historical financial statements/2023 to 2025 financial statements.pdf',
    'Historical financial statements/2023 to 2025 financial statements (2).pdf',
    'Year-to-date financial statements/Year-to-date accounts (Q1–Q3).pdf',
    'Pitch deck or company presentation/Company presentation.pdf',
    'Pitch deck or company presentation/How the business works.pdf',
    'Earlier valuation reports/409A report, March 2025.pdf',
    'Certificate of incorporation/Certificate of incorporation.pdf',
  ], 'each in a folder for its item, in the checklist’s order, a second file of the same name numbered');
  assert.deepEqual(entries.get('Year-to-date financial statements/Year-to-date accounts (Q1–Q3).pdf'), accounts);
  assert.equal(entries.get('Pitch deck or company presentation/How the business works.pdf')!.subarray(0, 5).toString(), '%PDF-');

  const logged = await all<{ detail: string; user_name: string; user_id: string | null }>(
    `SELECT detail, user_name, user_id FROM audit_log WHERE entity_id = ? AND action = 'EXPORT' ORDER BY created_at`, id);
  assert.deepEqual(logged.map((l) => l.detail), [
    `The ${deskName()} downloaded "Year-to-date accounts (Q1–Q3).pdf"`,
    `The ${deskName()} downloaded "How the business works"`,
    `The ${deskName()} downloaded the request's documents in one file (seven documents)`,
  ]);
  for (const l of logged) assert.deepEqual([l.user_name, l.user_id], [deskName(), null]);

  // A link past its days opens nothing, and nor does any link once the request is closed.
  const { desk_token_at: sentAt } = (await one<{ desk_token_at: string }>('SELECT desk_token_at FROM valuation_requests WHERE id = ?', id))!;
  await run('UPDATE valuation_requests SET desk_token_at = ? WHERE id = ?', new Date(Date.now() - (limits().linkOpenDays + 1) * 86_400_000).toISOString(), id);
  assert.equal((await get(`/documents/${ytd.id}`)).status, 404, 'a stale link');
  assert.equal((await get('/documents.zip')).status, 404);
  await run('UPDATE valuation_requests SET desk_token_at = ? WHERE id = ?', sentAt, id);
  assert.equal((await get(`/documents/${ytd.id}`)).status, 200);
  await call('PATCH', `/api/c/${cid}/valuation-requests/${id}`, { status: 'CANCELLED' }, admin);
  assert.equal((await desk('GET', '', token)).status, 200, 'the page still opens, briefly');
  assert.equal((await get(`/documents/${ytd.id}`)).status, 404, 'a closed request');
  assert.equal((await get('/documents.zip')).status, 404);
});

test('both emails list the tables and the documents by name, with no link to a document, and still name no holder', () => {
  assert.ok(documentsNotice && documentsRecap, 'the request above was sent');
  for (const mail of [documentsNotice!, documentsRecap!]) {
    for (const fact of [/^MANAGEMENT TEAM$/m, /^- Avery Stone, Chief executive officer$/m, /^- Rowan Hale, Chief financial officer$/m,
      /^REVENUE AND EBITDA GUIDANCE$/m, new RegExp(`^- Fiscal year: ${YEAR}; Revenue: \\$1,200,000; EBITDA: -\\$300,000$`, 'm'),
      /Fiscal year end: +Dec 31/,
      /^SECONDARY TRANSACTIONS$/m, /Security: Common stock; Date: Nov 14, 2025; Shares: 40,000; Price per share: \$1\.20; How the price was set: Agreed between the two parties, at a discount to the Series A price; Why it happened/,
      /Buyer: A new investor; Seller: A co-founder; Likely to happen again: No$/m,
      /^PEOPLE ON BELOW-MARKET SALARIES$/m, /Period: Jan 10, 2024 to Jun 30, 2025; Time on the company: 100% of each working day/,
      /^EXPENSES BELOW MARKET RATES$/m, /Expense: Office rent: the team worked from the CEO’s home; Recorded in the books a year: \$0; Market rate a year: \$36,000/,
      /Year-to-date financial statements: +Year-to-date accounts \(Q1–Q3\)\.pdf/, /How the business works/]) {
      assert.match(mail.text, fact, `${mail.subject}: ${fact}`);
    }
    for (const n of documentNames) assert.ok(mail.text.includes(n), `${mail.subject} names ${n}`);
    for (const docId of documentIds) assert.ok(!mail.text.includes(docId), `${mail.subject} carries no document id`);
    assert.doesNotMatch(mail.text, /\/api\/|valuation-desk\/documents|documents\.zip/, 'and no link to one');
    for (const who of HOLDERS) assert.ok(!mail.text.includes(who), `${mail.subject} names ${who}`);
  }
  assert.match(documentsNotice!.text, /^DOCUMENTS\nThey are on the request page/m);
  assert.match(documentsNotice!.text, /It has the data workbook and the documents the company attached/);
  assert.match(documentsRecap!.text, /^THE DOCUMENTS YOU ATTACHED\nThey stay in your vault/m);
  assert.equal([...documentsNotice!.text.matchAll(/https?:\/\/\S+/g)].length, 1, 'the notice’s one link is the request page');
});

test('a request made with the first, shorter answers still lists, presents and sends, without the new lines', async () => {
  await forgetLimits();
  const company = await newCompany('First Version Harbor');
  const me = (await one<{ id: string }>("SELECT id FROM users WHERE email = 'avery@example.com'"))!;
  const v1 = { companySize: '11-50', stage: 'SEED', plans: 'NEITHER', plansTiming: null, last409a: 'NEVER', last409aDate: null, software: 'Spreadsheets' };
  const now = new Date().toISOString();
  await run(`INSERT INTO valuation_requests (id, company_id, status, provider, answers, contact_name, contact_email, contact_phone,
               requested_by, requested_by_id, created_at, updated_at)
             VALUES ('vrq_first_version', ?, 'REQUESTED', ?, ?, 'Avery Stone', 'finance@harbor.example.com', '+1 (415) 555-0142', 'Avery Stone', ?, ?, ?)`,
  company, deskName(), JSON.stringify(v1), me.id, now, now);

  const listed = (await call('GET', `/api/c/${company}/valuation-requests`, undefined, admin)).json[0];
  assert.deepEqual(listed.answerLines, [
    { label: 'Company size', value: '11 to 50 people' }, { label: 'Stage', value: 'Seed' },
    { label: 'Options or financing soon', value: 'Neither in the next six months' }, { label: 'Last 409A', value: 'Never had one' },
    { label: 'Software used today', value: 'Spreadsheets' },
  ]);
  assert.deepEqual([listed.tables, listed.documents], [[], []]);
  assert.deepEqual(intakeTables(v1 as never), []);

  outbox.length = 0;
  const sent = await call('POST', `/api/c/${company}/valuation-requests/vrq_first_version/send`, {}, admin);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const notice = outbox.find((m) => m.to === 'desk@example.test')!;
  const recap = outbox.find((m) => m.subject.startsWith('Your 409A request'))!;
  for (const mail of [notice, recap]) {
    assert.match(mail.text, /Company size: +11 to 50 people/);
    assert.doesNotMatch(mail.text, /Valuation date|Cap table and option ledger|MANAGEMENT TEAM|DOCUMENTS|below-market/i);
  }
  assert.match(notice.text, /It has the data workbook, and it is where/);
  const token = tokenIn(notice.text);
  const page = await desk('GET', '', token);
  assert.deepEqual([page.json.answerLines, page.json.tables, page.json.documents], [listed.answerLines, [], []]);
  assert.equal((await fetch(`${base}/api/valuation-desk/documents.zip`, { headers: { 'X-Desk-Token': token } })).status, 404, 'nothing to download');
  await call('PATCH', `/api/c/${company}/valuation-requests/vrq_first_version`, { status: 'CANCELLED' }, admin);
});

test('the checklist counts the outstanding SAFEs and notes and offers the charter, the 409A report and the agreements already in the vault', async () => {
  await forgetLimits();
  const company = await newCompany('Suggesting Harbor', { incorporationDate: '2023-04-12' });
  const investor = (await call('POST', `/api/c/${company}/stakeholders`, { name: 'Halcyon Ventures', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
  const safe = (await call('POST', `/api/c/${company}/convertibles`, { stakeholderId: investor.id, instrument: 'SAFE_POST', principal: 25_000_000, issueDate: '2025-02-01' }, admin)).json;
  const repaid = (await call('POST', `/api/c/${company}/convertibles`, { stakeholderId: investor.id, instrument: 'NOTE', principal: 5_000_000, issueDate: '2024-06-01', interestRate: 0.05 }, admin)).json;
  assert.equal((await call('POST', `/api/c/${company}/convertibles/${repaid.id}/cancel`, { date: '2024-12-01' }, admin)).status, 200);
  assert.ok(safe.id && repaid.id, JSON.stringify([safe, repaid]));
  const charter = await upload(company, 'Restated certificate of incorporation.pdf', '%PDF-1.4 charter', { category: 'CHARTER' });
  await written(company, 'Charter, to be scanned', '', 'CHARTER');
  const report = await upload(company, '409A report.pdf', '%PDF-1.4 report', { category: 'VALUATION' });
  const valuation = (await call('POST', `/api/c/${company}/valuations`, { type: '409A', fairMarketValue: 200_000, effectiveDate: '2025-03-01', status: 'ACTIVE' }, admin)).json;
  assert.equal((await call('PUT', `/api/c/${company}/valuations/${valuation.id}/report`, { documentId: report.id }, admin)).status, 200);
  const agreement = await upload(company, 'Post-money SAFE.pdf', '%PDF-1.4 safe', { category: 'FINANCING', securityId: safe.id });
  await upload(company, 'Repaid note.pdf', '%PDF-1.4 note', { category: 'FINANCING', securityId: repaid.id });

  const first = await call('GET', `/api/c/${company}/valuation-requests/checklist`, undefined, admin);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.convertiblesOutstanding, 1, 'the cancelled note is not outstanding');
  assert.equal(first.json.sharesOutstanding, 0, 'no stock issued yet');
  assert.equal(first.json.incorporationDate, '2023-04-12');
  assert.match(first.json.fiscalYearEnd, /^\d{2}-\d{2}$/);
  assert.equal(first.json.finishedFullYear, true, 'incorporated in 2023, it has a full fiscal year behind it');
  const offered = (item: string, r = first) => (r.json.suggestions[item] ?? []).map((d: any) => [d.name, d.source]);
  assert.deepEqual(offered('CHARTER'), [['Restated certificate of incorporation.pdf', 'CHARTER']], 'not the charter with nothing in it');
  assert.deepEqual(offered('PRIOR_VALUATIONS'), [['409A report.pdf', 'REPORT']]);
  assert.deepEqual(offered('CONVERTIBLE_AGREEMENTS'), [['Post-money SAFE.pdf', 'INSTRUMENT']], 'not the repaid note’s');
  assert.deepEqual(Object.keys(first.json.suggestions).sort(), ['CHARTER', 'CONVERTIBLE_AGREEMENTS', 'PRIOR_VALUATIONS']);
  assert.deepEqual(Object.keys(first.json.suggestions.CHARTER[0]).sort(),
    ['category', 'createdAt', 'fileName', 'folder', 'id', 'mimeType', 'name', 'sizeBytes', 'source']);

  // A request that says no SAFE or note is outstanding, against a cap table that shows one, would send no agreement for it.
  const body = await intakeFor(company);
  await refused(company, body, /^Your cap table shows one SAFE or note outstanding\. Answer yes and attach its agreement, or update the cap table first\.$/);

  // After a request, what it sent is offered again under each item, once, behind its own reason.
  await accepted(company, {
    ...body, convertiblesOutstanding: true,
    documents: [...body.documents, { item: 'CONVERTIBLE_AGREEMENTS', documentId: agreement.id }, { item: 'CHARTER', documentId: charter.id }],
  });
  const again = await call('GET', `/api/c/${company}/valuation-requests/checklist`, undefined, admin);
  assert.deepEqual(offered('PITCH_DECK', again), [['Company presentation.pdf', 'LAST_REQUEST']]);
  assert.deepEqual(offered('YTD_FINANCIALS', again), [['Year-to-date accounts.pdf', 'LAST_REQUEST']]);
  assert.deepEqual(offered('CONVERTIBLE_AGREEMENTS', again), [['Post-money SAFE.pdf', 'INSTRUMENT']]);
  assert.deepEqual(offered('CHARTER', again), [['Certificate of incorporation.pdf', 'CHARTER'], ['Restated certificate of incorporation.pdf', 'CHARTER']],
    'newest first, each once');
  assert.deepEqual(offered('PRIOR_VALUATIONS', again), [['409A report, March 2025.pdf', 'LAST_REQUEST'], ['409A report.pdf', 'REPORT']]);
});

test('a request is checked against the company’s records: stock on the cap table, its SAFEs and notes, and a full year behind it', async () => {
  await forgetLimits();
  // A cap table with no stock on it has no capital structure to value.
  const empty = await newCompany('Empty Harbor');
  const bare = await intakeFor(empty, {}, { shares: false });
  assert.equal((await call('GET', `/api/c/${empty}/valuation-requests/checklist`, undefined, admin)).json.sharesOutstanding, 0);
  await refused(empty, bare, /^Your cap table has no shares outstanding yet\. Add the company’s shareholdings and option grants first, so the appraiser has the capital structure\.$/);
  await withShares(empty);
  assert.equal((await call('GET', `/api/c/${empty}/valuation-requests/checklist`, undefined, admin)).json.sharesOutstanding, 5_000_000);
  await accepted(empty, bare);

  // Two SAFEs outstanding are counted in words, and a yes with their agreements goes through.
  const investor = (await call('POST', `/api/c/${empty}/stakeholders`, { name: 'Halcyon Ventures', type: 'FUND', relation: 'INVESTOR' }, admin)).json;
  for (const issueDate of ['2025-02-01', '2025-05-01']) {
    await call('POST', `/api/c/${empty}/convertibles`, { stakeholderId: investor.id, instrument: 'SAFE_POST', principal: 25_000_000, issueDate }, admin);
  }
  await refused(empty, bare, /^Your cap table shows two SAFEs or notes outstanding\. Answer yes and attach their agreements, or update the cap table first\.$/);
  const agreements = await upload(empty, 'Post-money SAFEs.pdf', '%PDF-1.4 the SAFEs', { category: 'FINANCING' });
  await accepted(empty, { ...bare, convertiblesOutstanding: true, documents: [...bare.documents, { item: 'CONVERTIBLE_AGREEMENTS', documentId: agreements.id }] });

  // "Not finished a financial year yet" is refused once a whole fiscal year has passed since incorporation,
  // the year ending Dec 31 here: on its first day is a full year, the day after is not.
  const young = { ...bare, convertiblesOutstanding: true, documents: [...without(bare, 'HISTORICAL_FINANCIALS'), { item: 'CONVERTIBLE_AGREEMENTS', documentId: agreements.id }], noFullYearYet: true };
  const incorporate = async (incorporationDate: string) => {
    assert.equal((await call('PATCH', `/api/c/${empty}`, { incorporationDate, fiscalYearEnd: '12-31' }, admin)).status, 200);
    return (await call('GET', `/api/c/${empty}/valuation-requests/checklist`, undefined, admin)).json;
  };
  assert.equal((await incorporate('2019-03-01')).finishedFullYear, true);
  await refused(empty, young, /^The company was incorporated on Mar 1, 2019, so it has finished a financial year\. Attach the historical financial statements, or correct the incorporation date in the company settings\.$/);
  assert.equal((await incorporate(`${YEAR - 1}-01-01`)).finishedFullYear, true);
  await refused(empty, young, /so it has finished a financial year/);
  assert.equal((await incorporate(`${YEAR - 1}-01-02`)).finishedFullYear, false);
  const made = await accepted(empty, young);
  assert.deepEqual(made.answerLines.filter((l: any) => ['Incorporated', 'Fiscal year end', 'Financial statements'].includes(l.label)).map((l: any) => l.value),
    [longDate(`${YEAR - 1}-01-02`), 'Dec 31', 'The company has not finished a financial year yet'], 'the team reads the answer next to the dates behind it');
  // A year end the settings stored as something that is not a date checks nothing, and is not shown.
  assert.equal((await call('PATCH', `/api/c/${empty}`, { incorporationDate: '2019-03-01', fiscalYearEnd: 'December' }, admin)).status, 200);
  const odd = await accepted(empty, young);
  assert.ok(!odd.answerLines.some((l: any) => l.label === 'Fiscal year end'));
});

test('the kinds of security a secondary transaction can be in come from the param file', () => {
  const sold = (securityType: string) => ({ ...INTAKE, secondary: true, secondaryTransactions: [{ ...TRADE, securityType }] });
  try {
    configure({
      valuationDesk: {
        intake: { securityTypes: [...config().valuationDesk.intake.securityTypes, { value: 'WARRANT', label: 'Warrants to buy common stock', shortLabel: 'Warrant' }] },
      },
    });
    const intake = readIntake(sold('WARRANT'));
    const security = () => intakeTables(intake).find((t) => t.title === 'Secondary transactions')!.rows[0][0];
    assert.equal(security(), 'Warrants to buy common stock');
    assert.throws(() => readIntake(sold('BONDS')), /Secondary transaction 1: choose the type of security\.$/);
    offerTheDesk();
    assert.throws(() => readIntake(sold('WARRANT')), /Secondary transaction 1: choose the type of security\./, 'off the list, it is refused');
    assert.equal(security(), 'WARRANT', 'and one stored before reads as it was stored');
    assert.equal(intakeTables(readIntake(sold('PREFERRED'))).find((t) => t.title === 'Secondary transactions')!.rows[0][0], 'Preferred stock');
  } finally {
    offerTheDesk();
  }
});

// --- Telling the person who asked ------------------------------------------------
//
// Each change of status is emailed to the person who made the request, at their
// account address. Tests have no mail transport, so each email is read back from
// the console and the route reports it as "failed": tried, and not delivered.

/** A member of a company, signed in through the reset link an administrator sends. Made up, and holding nothing. */
async function signedInMember(companyId: string, email: string, memberName: string, role: string) {
  const added = await call('POST', `/api/c/${companyId}/members`, { email, name: memberName, role }, admin);
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const link = await call('POST', `/api/c/${companyId}/members/${added.json.id}/reset-password`, { mode: 'link' }, admin);
  const reset = await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: 'member-pass-1' });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  return { token: reset.token as string, membershipId: added.json.id as string };
}

/** A request made by whoever's token is given and sent to the team, with the team's link from the notice, and an empty outbox. */
async function sentRequest(companyId: string, asker = admin) {
  await forgetLimits();
  const made = await call('POST', `/api/c/${companyId}/valuation-requests`, await intakeFor(companyId), asker);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  outbox.length = 0;
  await call('POST', `/api/c/${companyId}/valuation-requests/${made.json.id}/send`, {}, asker);
  const token = tokenIn(outbox.find((m) => m.to === 'desk@example.test')!.text);
  outbox.length = 0;
  return { id: made.json.id as string, token };
}

/** What a request wrote to the audit log about emailing the person who asked. */
const requesterLog = (requestId: string) => all<{ action: string; user_id: string | null; user_name: string; detail: string }>(
  `SELECT action, user_id, user_name, detail FROM audit_log WHERE entity_id = ? AND action LIKE 'NOTIFY_REQUESTER%' ORDER BY created_at, id`, requestId);

const PAGE = () => `${config().app.url}/compliance/409a`;

test('the team starting a request emails the person who asked at their account, naming the company, linking the 409A page, and never the team’s link', async () => {
  const company = await newCompany('Started Harbor');
  const { id, token } = await sentRequest(company);
  const started = await desk('POST', '/status', token, { action: 'START' });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.status, 'IN_PROGRESS');
  assert.equal(started.json.emailed, 'failed', 'reported beside the request: tried, and with no transport not delivered');
  assert.equal(started.json.companyName, 'Started Harbor, Inc.', 'the rest of the answer is the request as before');

  assert.equal(outbox.length, 1);
  const [mail] = outbox;
  assert.equal(mail.to, 'avery@example.com', 'the account address, not the one typed into the form');
  assert.equal(mail.subject, `The ${deskName()} has started on your 409A for Started Harbor, Inc.`);
  assert.match(mail.text, /^Hi Avery Stone,$/m);
  assert.match(mail.text, /started work on your request for a 409A valuation of Started Harbor, Inc\.$/m, 'one full stop after "Inc."');
  assert.match(mail.text, /Status: +In progress/);
  assert.ok(mail.text.includes(PAGE()), 'the 409A page');
  assert.equal([...mail.text.matchAll(/https?:\/\/\S+/g)].length, 1, 'and no other link');
  assert.match(mail.text, /To reach the team, reply to this email\./, 'replies reach the team');
  assert.ok(!mail.text.includes(token) && !/409a-desk/.test(mail.text), 'never the team’s link');
  assert.doesNotMatch(mail.text, /finance@harbor|555-0142/, 'nor the contact details typed into the form');
  for (const who of HOLDERS) assert.ok(!mail.text.includes(who), `the email names ${who}`);

  // Logged under the team's name, as its own steps are, and with no address in it.
  const logged = await requesterLog(id);
  assert.deepEqual(logged.map((l) => [l.action, l.user_id, l.user_name]), [['NOTIFY_REQUESTER_FAILED', null, deskName()]]);
  assert.ok(!logged.some((l) => l.detail.includes('@')));
  await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, admin);
});

test('the status email is built like the others: both parts, the 409A page as its one button, what the team typed escaped, and replies to the team only for its own changes', () => {
  const base = { companyName: `${HOSTILE} Robotics`, to: 'avery@example.com', toName: HOSTILE, replyTo: 'desk@example.test' };
  const delivered = composeStatusEmail({
    ...base, change: { kind: 'DELIVERED', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01' },
    message: `The report is in your inbox.\n\nAlso ${HOSTILE}`,
  });
  assert.ok(delivered.html && delivered.text, 'both parts');
  for (const part of [delivered.html!, delivered.text]) {
    assert.ok(part.includes(PAGE()), 'the 409A page');
    for (const fact of [/Open the 409A page/, /Ledgerline Valuations/, /Jul 1, 2026/, /Report delivered/, /The report is in your inbox/,
      /A note from the team/i, /Record the 409A from the report on the 409A page/, /recording it closes this request/]) {
      assert.match(part, fact);
    }
    assert.doesNotMatch(part, /409a-desk/);
  }
  assert.equal(delivered.replyTo, 'desk@example.test', 'a reply about the team’s change reaches the team');
  escapedIn(delivered.html!);

  // A change made at the company is not the team's to answer for, whatever the caller passes.
  for (const change of [{ kind: 'CANCELLED', by: 'Morgan Lee' }, { kind: 'COMPLETED', by: 'Morgan Lee', valuationDate: '2026-07-01' }] as const) {
    const m = composeStatusEmail({ ...base, change, message: null });
    assert.equal(m.replyTo, undefined);
    assert.doesNotMatch(m.text, /reply to this email/);
    escapedIn(m.html!);
  }
});

test('each kind of change says what happened in its own words, with the company in the subject and the same greeting, sign-off and footer', () => {
  const base = { companyName: 'Harbor Robotics, Inc.', to: 'avery@example.com', toName: 'Avery Stone', replyTo: 'desk@example.test', message: null };
  const cases: [Parameters<typeof composeStatusEmail>[0]['change'], string | null, string, RegExp[]][] = [
    [{ kind: 'STARTED' }, null, `The ${deskName()} has started on your 409A for Harbor Robotics, Inc.`,
      [/nothing you need to do now/, /email you again when the report is ready/]],
    [{ kind: 'DELIVERED', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01' }, null, 'Your 409A report for Harbor Robotics, Inc. is ready',
      [/Appraisal firm: +Ledgerline Valuations/, /Valuation date: +Jul 1, 2026/, /^WHAT TO DO NEXT$/m, /comes from the team, not with this email/]],
    [{ kind: 'REOPENED' }, 'Correcting the date.', 'Your 409A report for Harbor Robotics, Inc. is back in progress',
      [/report it delivered earlier is withdrawn, so do not record a 409A from it/, /Status: +In progress/, /^A NOTE FROM THE TEAM\nCorrecting the date\.$/m]],
    [{ kind: 'CLOSED' }, 'This was a duplicate of your earlier request.', `The ${deskName()} closed your 409A request for Harbor Robotics, Inc.`,
      [/No report will come from it\. The team’s reason is below\./, /^WHY THE TEAM CLOSED IT\nThis was a duplicate of your earlier request\.$/m, /ask for a new one/]],
    [{ kind: 'COMPLETED', by: 'Morgan Lee', valuationDate: '2026-07-01' }, null, 'Your 409A request for Harbor Robotics, Inc. is complete',
      [/^Morgan Lee recorded a 409A valued as of Jul 1, 2026, and that completed your request/m, /Recorded by: +Morgan Lee/, /Valuation date: +Jul 1, 2026/]],
    [{ kind: 'CANCELLED', by: 'Morgan Lee' }, null, 'Your 409A request for Harbor Robotics, Inc. was cancelled',
      [/^Morgan Lee cancelled your request for a 409A valuation of Harbor Robotics, Inc\.$/m, /Cancelled by: +Morgan Lee/]],
  ];
  for (const [change, message, subject, facts] of cases) {
    const m = composeStatusEmail({ ...base, change, message });
    assert.equal(m.subject, subject);
    assert.equal(m.to, 'avery@example.com');
    assert.equal(m.toName, 'Avery Stone');
    assert.match(m.text, /^Hi Avery Stone,$/m, change.kind);
    for (const fact of facts) assert.match(m.text, fact, `${change.kind}: ${fact}`);
    assert.match(m.text, new RegExp(`^— ${mailSignature()}$`, 'm'));
    assert.match(m.text, /You are receiving this because you asked .+ for a 409A valuation of Harbor Robotics, Inc\.\n$/);
    assert.equal([...m.text.matchAll(/https?:\/\/\S+/g)].map((x) => x[0]).join(), PAGE(), `${change.kind}: one link, the 409A page`);
    assert.doesNotMatch(m.text, /Inc\.\./, 'one full stop after "Inc."');
    assert.equal(m.replyTo, change.kind === 'COMPLETED' || change.kind === 'CANCELLED' ? undefined : 'desk@example.test');
  }
  // A legal name of any length still makes a subject a mail server takes.
  const long = composeStatusEmail({ ...base, companyName: `${'Harbor '.repeat(40)}Inc.`, change: { kind: 'STARTED' } });
  assert.ok(long.subject.length < 250 && long.subject.includes('...'), long.subject);
});

test('delivering names the firm and the valuation date, and carries the team’s note; putting it back says the report was withdrawn; closing gives the reason', async () => {
  const company = await newCompany('Delivered Harbor');
  const { id, token } = await sentRequest(company);
  await desk('POST', '/status', token, { action: 'START' });
  outbox.length = 0;

  const delivered = await desk('POST', '/status', token, {
    action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01', message: `The report is in your inbox. ${HOSTILE}`,
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  assert.equal(delivered.json.emailed, 'failed');
  const report = outbox.at(-1)!;
  assert.equal(report.to, 'avery@example.com');
  assert.equal(report.subject, 'Your 409A report for Delivered Harbor, Inc. is ready');
  assert.match(report.text, /Appraisal firm: +Ledgerline Valuations/);
  assert.match(report.text, /Valuation date: +Jul 1, 2026/, 'the date as the app prints dates');
  assert.match(report.text, /^A NOTE FROM THE TEAM\nThe report is in your inbox\. <script>x<\/script>$/m, 'the note as typed in the plain-text part');

  outbox.length = 0;
  const reopened = await desk('POST', '/status', token, { action: 'REOPEN', message: 'Correcting the date.' });
  assert.equal(reopened.json.emailed, 'failed');
  const back = outbox.at(-1)!;
  assert.equal(back.subject, 'Your 409A report for Delivered Harbor, Inc. is back in progress');
  assert.match(back.text, /withdrawn, so do not record a 409A from it/);
  assert.match(back.text, /Correcting the date\./);

  outbox.length = 0;
  const closed = await desk('POST', '/status', token, { action: 'CLOSE', message: 'The company asked us to stop.' });
  assert.equal(closed.json.status, 'CANCELLED');
  assert.equal(closed.json.emailed, 'failed');
  const gone = outbox.at(-1)!;
  assert.equal(gone.subject, `The ${deskName()} closed your 409A request for Delivered Harbor, Inc.`);
  assert.match(gone.text, /^WHY THE TEAM CLOSED IT\nThe company asked us to stop\.$/m);

  assert.deepEqual((await requesterLog(id)).map((l) => l.action), Array(4).fill('NOTIFY_REQUESTER_FAILED'), 'one attempt per change, each logged');
});

test('a note, or pressing start a second time, emails nobody', async () => {
  const company = await newCompany('Quiet Notes Harbor');
  const { id, token } = await sentRequest(company);
  assert.equal((await desk('POST', '/status', token, { action: 'START' })).json.emailed, 'failed');
  outbox.length = 0;
  const twice = await desk('POST', '/status', token, { action: 'START' });
  assert.equal(twice.status, 200);
  assert.equal(twice.json.emailed, 'not sent');
  const note = await desk('POST', '/status', token, { action: 'NOTE', message: 'Please send the last two P&L statements.' });
  assert.equal(note.status, 200);
  assert.equal(note.json.emailed, 'not sent');
  assert.equal(outbox.length, 0);
  assert.equal((await requesterLog(id)).length, 1, 'only the first start');
  await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, admin);
});

test('a complete or cancel at the company is emailed when someone else made it, naming them, and not when the person who asked did', async () => {
  const company = await newCompany('Colleague Harbor');
  const morgan = await signedInMember(company, 'morgan.lee@example.com', 'Morgan Lee', 'LEGAL');
  const toAvery = () => outbox.filter((m) => m.to === 'avery@example.com');
  const recorded = async (effectiveDate: string) => {
    const v = await call('POST', `/api/c/${company}/valuations`, { type: '409A', fairMarketValue: 300_000, effectiveDate, status: 'ACTIVE' }, admin);
    assert.equal(v.status, 200, JSON.stringify(v.json));
    return v.json.id as string;
  };

  // By the person who asked: they know, so nothing.
  const own = await sentRequest(company);
  assert.equal((await call('PATCH', `/api/c/${company}/valuation-requests/${own.id}`, { status: 'CANCELLED' }, admin)).status, 200);
  const ownDone = await sentRequest(company);
  const doneByMe = await call('PATCH', `/api/c/${company}/valuation-requests/${ownDone.id}`, { status: 'COMPLETED', valuationId: await recorded('2026-06-01') }, admin);
  assert.equal(doneByMe.status, 200, JSON.stringify(doneByMe.json));
  assert.deepEqual(toAvery(), []);
  assert.deepEqual([...await requesterLog(own.id), ...await requesterLog(ownDone.id)], [], 'and nothing to log');

  // By a colleague: the person who asked is told who.
  const theirs = await sentRequest(company);
  const cancelled = await call('PATCH', `/api/c/${company}/valuation-requests/${theirs.id}`, { status: 'CANCELLED' }, morgan.token);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const cancel = toAvery().at(-1)!;
  assert.equal(cancel.subject, 'Your 409A request for Colleague Harbor, Inc. was cancelled');
  assert.match(cancel.text, /^Morgan Lee cancelled your request for a 409A valuation of Colleague Harbor, Inc\.$/m);
  assert.doesNotMatch(cancel.text, /reply to this email/, 'the team did not make this change');

  const done = await sentRequest(company);
  outbox.length = 0;
  const completed = await call('PATCH', `/api/c/${company}/valuation-requests/${done.id}`, { status: 'COMPLETED', valuationId: await recorded('2026-07-01') }, morgan.token);
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  const complete = toAvery().at(-1)!;
  assert.equal(complete.subject, 'Your 409A request for Colleague Harbor, Inc. is complete');
  assert.match(complete.text, /^Morgan Lee recorded a 409A valued as of Jul 1, 2026, and that completed your request/m);
  assert.match(complete.text, /Recorded by: +Morgan Lee/);

  // Logged under the colleague who made the change.
  const morganId = (await one<{ id: string }>("SELECT id FROM users WHERE email = 'morgan.lee@example.com'"))!.id;
  for (const r of [theirs, done]) {
    assert.deepEqual((await requesterLog(r.id)).map((l) => [l.action, l.user_id, l.user_name]), [['NOTIFY_REQUESTER_FAILED', morganId, 'Morgan Lee']]);
  }
});

test('someone who has left the company, or whose account is gone, is not emailed, and the change still goes through', async () => {
  const company = await newCompany('Departed Harbor');
  const quinn = await signedInMember(company, 'quinn.harper@example.com', 'Quinn Harper', 'ADMIN');
  const { id, token } = await sentRequest(company, quinn.token);
  assert.equal((await one<{ requested_by: string }>('SELECT requested_by FROM valuation_requests WHERE id = ?', id))!.requested_by, 'Quinn Harper');

  const listed = async () => (await call('GET', `/api/c/${company}/valuation-requests`, undefined, admin)).json.find((r: { id: string }) => r.id === id);
  assert.equal((await listed()).emailsRequester, true, 'the page says they get an email at each step');

  // Moved to a role that cannot read the 409A page: the email would say what that page does.
  assert.equal((await call('PATCH', `/api/c/${company}/members/${quinn.membershipId}`, { role: 'EMPLOYEE' }, admin)).status, 200);
  assert.equal((await listed()).emailsRequester, false, 'and stops saying so');
  const started = await desk('POST', '/status', token, { action: 'START' });
  assert.equal(started.json.status, 'IN_PROGRESS');
  assert.equal(started.json.emailed, 'not sent');

  // Removed from the company.
  assert.equal((await call('DELETE', `/api/c/${company}/members/${quinn.membershipId}`, undefined, admin)).status, 200);
  const delivered = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01' });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  assert.equal(delivered.json.status, 'DELIVERED');
  assert.equal(delivered.json.emailed, 'not sent');
  assert.ok(!outbox.some((m) => m.to === 'quinn.harper@example.com'), 'nothing went to them');
  const skipped = await requesterLog(id);
  assert.deepEqual(skipped.map((l) => [l.action, l.user_name]), [['NOTIFY_REQUESTER_SKIPPED', deskName()], ['NOTIFY_REQUESTER_SKIPPED', deskName()]]);
  assert.match(skipped[0].detail, /no longer have access/);

  // An account that is gone altogether.
  const rae = await signedInMember(company, 'rae.okafor@example.com', 'Rae Okafor', 'ADMIN');
  await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, admin);
  const second = await sentRequest(company, rae.token);
  await run("DELETE FROM users WHERE email = 'rae.okafor@example.com'");
  const closed = await desk('POST', '/status', second.token, { action: 'CLOSE', message: 'Nobody to talk to.' });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.equal(closed.json.status, 'CANCELLED');
  assert.equal(closed.json.emailed, 'not sent');
  assert.deepEqual(outbox, []);
  assert.deepEqual((await requesterLog(second.id)).map((l) => l.action), ['NOTIFY_REQUESTER_SKIPPED']);
});

test('the daily limit on status emails stops them, 0 turns them off, and the changes still go through', async () => {
  const company = await newCompany('Limited Harbor');
  const { id, token } = await sentRequest(company);
  try {
    configure({ valuationDesk: { statusEmailsPerRequestPerDay: 2 } });
    assert.equal((await desk('POST', '/status', token, { action: 'START' })).json.emailed, 'failed');
    assert.equal((await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01' })).json.emailed, 'failed');
    outbox.length = 0;
    // Failed attempts count too, or a mail server that refuses would let a leaked link press on forever.
    const third = await desk('POST', '/status', token, { action: 'REOPEN' });
    assert.equal(third.status, 200);
    assert.equal(third.json.status, 'IN_PROGRESS', 'the change stands');
    assert.equal(third.json.emailed, 'not sent');
    assert.deepEqual(outbox, []);
    const log = await requesterLog(id);
    assert.deepEqual(log.map((l) => l.action), ['NOTIFY_REQUESTER_FAILED', 'NOTIFY_REQUESTER_FAILED', 'NOTIFY_REQUESTER_SKIPPED']);
    assert.match(log[2].detail, /already tried to email them twice today/);

    configure({ valuationDesk: { statusEmailsPerRequestPerDay: 0 } });
    const off = await desk('POST', '/status', token, { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-02' });
    assert.equal(off.json.status, 'DELIVERED');
    assert.equal(off.json.emailed, 'not sent');
    assert.deepEqual(outbox, []);
    assert.equal((await requesterLog(id)).length, 3, 'turned off, nothing is tried and nothing is logged');
    // Nor does the recap promise an email at each step.
    const recap = composeRecapEmail({
      companyName: 'Harbor Robotics, Inc.', to: 'avery@example.com', toName: 'Avery Stone', contact: { name: null, email: 'finance@harbor.example.com', phone: '+1 (415) 555-0142' },
      intake: readIntake(INTAKE), documents: [], notes: null, statusUrl: PAGE(), replyTo: 'desk@example.test',
    });
    assert.doesNotMatch(recap.text, /email you at each step/);
    // Nor do the pages, which read the same setting.
    assert.equal(publicConfig().valuationDesk.statusEmails, false);
    const listed = (await call('GET', `/api/c/${company}/valuation-requests`, undefined, admin)).json.find((r: { id: string }) => r.id === id);
    assert.equal(listed.emailsRequester, false);

    // Back on with the same limit of two, a day later the request can email again:
    // the earlier attempts have left the day, not been let off by a higher limit.
    configure({ valuationDesk: { statusEmailsPerRequestPerDay: 2 } });
    assert.equal(publicConfig().valuationDesk.statusEmails, true);
    await forgetLimits();
    assert.equal((await desk('POST', '/status', token, { action: 'REOPEN', message: 'Correcting the date.' })).json.emailed, 'failed');
    const again = await requesterLog(id);
    assert.equal(again.length, 4);
    assert.equal(again.at(-1)!.action, 'NOTIFY_REQUESTER_FAILED', 'a new attempt, logged');
  } finally {
    offerTheDesk();
  }
  await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, admin);
});

test('with the service turned off, the person who asked still hears what happens to a request in flight, and the recap says they will', async () => {
  const company = await newCompany('Winding Down Harbor');
  const { id, token } = await sentRequest(company);
  try {
    resetConfig();
    assert.equal(config().valuationDesk.enabled, false);
    const started = await desk('POST', '/status', token, { action: 'START' });
    assert.equal(started.json.emailed, 'failed');
    assert.equal(outbox.filter((m) => m.to === 'avery@example.com').length, 1);
  } finally {
    offerTheDesk();
  }
  await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, admin);
  const recap = composeRecapEmail({
    companyName: 'Harbor Robotics, Inc.', to: 'avery@example.com', toName: 'Avery Stone', contact: { name: null, email: 'finance@harbor.example.com', phone: '+1 (415) 555-0142' },
    intake: readIntake(INTAKE), documents: [], notes: null, statusUrl: PAGE(), replyTo: 'desk@example.test',
  });
  assert.match(recap.text, /^WHAT HAPPENS NEXT\n.*\n- We will email you at each step, such as when the team starts and when the report is delivered\.$/m);
});

test('the closing emails point to what can still be done: a new request while the service is on, the company’s own appraiser once it is off, and someone who edits the cap table for a reader', () => {
  const base = { companyName: 'Harbor Robotics, Inc.', to: 'avery@example.com', toName: 'Avery Stone', replyTo: 'desk@example.test', message: null };
  const closing = [{ kind: 'CLOSED' }, { kind: 'CANCELLED', by: 'Morgan Lee' }] as const;
  for (const change of closing) {
    assert.match(composeStatusEmail({ ...base, change }).text, /^If you still need a 409A, ask for a new one on the 409A page\.$/m);
    const reader = composeStatusEmail({ ...base, change, canRecord: false }).text;
    assert.match(reader, /^If the company still needs a 409A, anyone who edits the cap table can ask for a new one on the 409A page\.$/m);
    assert.doesNotMatch(reader, /If you still need/);
  }
  const delivered = composeStatusEmail({ ...base, change: { kind: 'DELIVERED', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01' }, canRecord: false }).text;
  assert.match(delivered, /^WHAT HAPPENS NEXT\nAnyone who edits the cap table can record the 409A from the report on the 409A page/m);
  assert.doesNotMatch(delivered, /WHAT TO DO NEXT|Record the 409A to finish/);
  try {
    // Off, a new request is refused, so the email does not suggest one.
    resetConfig();
    for (const change of closing) {
      const m = composeStatusEmail({ ...base, change }).text;
      assert.match(m, /^If you still need a 409A, record one from your own appraiser on the 409A page\.$/m);
      assert.doesNotMatch(m, /ask for a new one/);
      assert.match(composeStatusEmail({ ...base, change, canRecord: false }).text,
        /^If the company still needs a 409A, anyone who edits the cap table can record one from its own appraiser on the 409A page\.$/m);
    }
  } finally {
    offerTheDesk();
  }
});

test('someone whose role now only reads the 409A page still hears of each step, and is told who can act on it', async () => {
  const company = await newCompany('Board Seat Harbor');
  const sam = await signedInMember(company, 'sam.ortiz@example.com', 'Sam Ortiz', 'ADMIN');
  const { id, token } = await sentRequest(company, sam.token);
  assert.equal((await call('PATCH', `/api/c/${company}/members/${sam.membershipId}`, { role: 'BOARD' }, admin)).status, 200);
  const closed = await desk('POST', '/status', token, { action: 'CLOSE', message: 'The company asked us to stop.' });
  assert.equal(closed.json.emailed, 'failed');
  const mail = outbox.find((m) => m.to === 'sam.ortiz@example.com')!;
  assert.match(mail.text, /anyone who edits the cap table can ask for a new one on the 409A page/);
  assert.doesNotMatch(mail.text, /If you still need/);
  assert.deepEqual((await requesterLog(id)).map((l) => l.action), ['NOTIFY_REQUESTER_FAILED']);
});

test('a change at the company is emailed only once it has committed: a cancel refused at the commit tells nobody and counts nothing', async () => {
  const company = await newCompany('Rolled Back Harbor');
  const casey = await signedInMember(company, 'casey.lin@example.com', 'Casey Lin', 'LEGAL');
  const { id } = await sentRequest(company);
  // A check that runs at the commit and refuses it, after everything in the
  // change has run, as a dropped connection or a failed write would.
  await run(`CREATE FUNCTION refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused at commit'; END $$`);
  await run(`CREATE CONSTRAINT TRIGGER refuse_commit AFTER INSERT ON valuation_request_events
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_commit()`);
  const realError = console.error;
  console.error = () => {};   // the server logs the refused commit, which is the point here
  try {
    const refused = await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, casey.token);
    assert.equal(refused.status, 500);
  } finally {
    console.error = realError;
    await run('DROP TRIGGER refuse_commit ON valuation_request_events');
    await run('DROP FUNCTION refuse_commit()');
  }
  assert.equal(outbox.length, 0, 'nobody hears of a cancel that did not happen');
  assert.equal((await one<{ status: string }>('SELECT status FROM valuation_requests WHERE id = ?', id))!.status, 'REQUESTED');
  assert.deepEqual(await requesterLog(id), [], 'and the attempt went with it, so it does not count against the limit');

  const cancelled = await call('PATCH', `/api/c/${company}/valuation-requests/${id}`, { status: 'CANCELLED' }, casey.token);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.deepEqual(outbox.map((m) => [m.to, m.subject]), [['avery@example.com', 'Your 409A request for Rolled Back Harbor, Inc. was cancelled']]);
  assert.deepEqual((await requesterLog(id)).map((l) => [l.action, l.user_name]), [['NOTIFY_REQUESTER_FAILED', 'Casey Lin']]);
});
