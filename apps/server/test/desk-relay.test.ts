/**
 * A self-hosted server's 409A request, relayed to the hosted one, end to end over
 * HTTP. One server plays both parts: valuationDesk.relayUrl points it at itself.
 * No mail transport is set, so each email is printed, and read back from there.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { freshDatabase, sessionCookie } from './helpers.ts';

process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';
process.env.VALUATION_APPROVAL_EMAIL = 'review@example.test';

await freshDatabase();
const { handle } = await import('../src/http.ts');
for (const m of ['auth', 'entities', 'files', 'workflows', 'valuation-requests', 'desk-relay']) await import(`../src/routes/${m}.ts`);
const { configure } = await import('../src/config.ts');
const { run, one } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());
configure({ valuationDesk: { enabled: true, relayUrl: base, sendCooldownSeconds: 0, resendCooldownMinutes: 0 } });

// The emails, as the server prints them with no transport.
const printed: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); if (line.startsWith('[mail]')) printed.push(line); else realLog(...args); };
after(() => { console.log = realLog; });
const linkIn = (kind: string): string => {
  const found = printed.map((m) => m.match(new RegExp(`/409a-relay#${kind}\\.([A-Za-z0-9_-]{43})`))?.[1]).filter(Boolean).at(-1);
  assert.ok(found, `an email carries the ${kind} link`);
  return found!;
};

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any, token: sessionCookie(res) };
}
const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token!;
const as = { Authorization: `Bearer ${admin}` };

const ANSWERS = {
  valuationDateKind: 'LATEST', valuationDate: null,
  companySize: '11-50', stage: 'SERIES_A', plans: 'OPTIONS', plansTiming: 'ONE_TO_THREE', optionsToGrant: 250_000,
  last409a: 'NEVER', last409aDate: null,
  noFullYearYet: true, convertiblesOutstanding: false, projections: 'FILE', guidance: [], capTableConfirmed: true,
  management: [{ name: 'Avery Stone', title: 'Chief executive officer' }],
  sweatEquity: false, sweatEquityPeople: [], secondary: false, secondaryTransactions: [], belowMarketExpenses: false, expenses: [],
  software: 'Spreadsheets',
  contactName: 'Avery Stone', contactEmail: 'finance@harbor.example.com', contactPhone: '+1 (415) 555-0142', notes: null,
};

/** A company with a founder's shares and the documents the form asks for, its request made and sent on. */
async function sentRequest(name: string) {
  const cid = (await call('POST', '/api/companies', { name }, as)).json.id as string;
  const stock = (await call('GET', `/api/c/${cid}/share-classes`, undefined, as)).json[0];
  const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Sam Quill', type: 'INDIVIDUAL', relation: 'FOUNDER' }, as)).json;
  await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: founder.id, shareClassId: stock.id, quantity: 5_000_000, issueDate: '2024-01-10' }, as);
  const documents: { item: string; documentId: string }[] = [];
  for (const [item, file, category] of [['YTD_FINANCIALS', 'Accounts.pdf', 'OTHER'], ['PITCH_DECK', 'Deck.pdf', 'OTHER'], ['CHARTER', 'Charter.pdf', 'CHARTER'], ['PROJECTIONS', 'Projections.pdf', 'OTHER']]) {
    const res = await fetch(`${base}/api/c/${cid}/documents/upload?${new URLSearchParams({ name: file, category })}`, {
      method: 'POST', headers: { ...as, 'Content-Type': 'application/pdf' }, body: new Uint8Array(Buffer.from(`%PDF-1.4 ${file}`)) as unknown as RequestInit['body'],
    });
    documents.push({ item, documentId: ((await res.json()) as { id: string }).id });
  }
  const made = await call('POST', `/api/c/${cid}/valuation-requests`, { ...ANSWERS, documents }, as);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const sent = await call('POST', `/api/c/${cid}/valuation-requests/${made.json.id}/send`, {}, as);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.approval, 'sent', JSON.stringify(sent.json));
  return { cid, id: made.json.id as string };
}
/** The company's request as its 409A page reads it, asking the relay afresh. */
async function page(r: { cid: string; id: string }) {
  await run('UPDATE valuation_requests SET relay_checked_at = NULL WHERE id = ?', r.id);
  return (await call('GET', `/api/c/${r.cid}/valuation-requests`, undefined, as)).json.find((x: any) => x.id === r.id);
}
const newToken = () => randomBytes(32).toString('base64url');
const direct = (token: string, contactEmail: string) => call('POST', '/api/409a-relay', {
  token, companyName: 'Echo Co', answers: ANSWERS, contactEmail, contactPhone: '+1 415 555 0100', requestedBy: 'Someone',
});
const decide = (token: string, decision: string) => call('POST', '/api/409a-relay/team/decide', { decision }, { 'X-Relay-Token': token });

test('the request reaches the approval inbox only once its contact confirms, and approval reaches the company', async () => {
  const r = await sentRequest('Harbor Labs');
  const row = await one<any>('SELECT relay_id, relay_token FROM valuation_requests WHERE id = ?', r.id);
  assert.ok(row.relay_id && row.relay_token);
  assert.ok(printed.some((m) => m.includes('would send to finance@harbor.example.com')), 'the contact is asked to confirm');
  assert.ok(!printed.some((m) => m.includes('review@example.test')), 'the approval inbox hears nothing yet');

  // Its token reads the status; nothing else does.
  assert.equal((await call('GET', `/api/409a-relay/${row.relay_id}`, undefined, { Authorization: 'Bearer x'.padEnd(50, 'x') })).status, 404);
  assert.equal((await call('GET', `/api/409a-relay/${row.relay_id}`, undefined, { Authorization: `Bearer ${row.relay_token}` })).json.status, 'UNCONFIRMED');
  // Nothing to decide before the contact confirms: there is no team link yet.
  assert.equal((await page(r)).approvedAt, null);

  assert.equal((await call('POST', '/api/409a-relay/confirm', { token: linkIn('confirm') })).json.status, 'CONFIRMED');
  const approval = printed.at(-1)!;
  assert.match(approval, /would send to review@example.test/);
  assert.match(approval, /Spreadsheets/, 'the answers are in the email');
  // Confirming again sends nothing more.
  const count = printed.length;
  await call('POST', '/api/409a-relay/confirm', { token: linkIn('confirm') });
  assert.equal(printed.length, count);

  // Sending it again makes no second request: the first one's approval must still arrive.
  const before = printed.length;
  await call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/send`, { again: true }, as);
  assert.equal(printed.length, before);
  assert.equal((await one<any>('SELECT relay_id FROM valuation_requests WHERE id = ?', r.id)).relay_id, row.relay_id);

  assert.equal((await page(r)).relayStatus, 'CONFIRMED', 'the page knows the contact confirmed');

  const team = linkIn('team');
  assert.equal((await call('GET', '/api/409a-relay/team', undefined, { 'X-Relay-Token': team })).json.companyName, 'Harbor Labs, Inc.');
  assert.equal((await decide(team, 'APPROVED')).json.status, 'APPROVED');
  assert.equal((await decide(team, 'DECLINED')).status, 400, 'a decision stands');

  const now = await page(r);
  assert.ok(now.approvedAt, 'approved on the company’s page');
  assert.equal(now.deskNotifiedAt, null, 'nothing has reached an evaluator: the hand-off is by hand');
  assert.equal(now.status, 'REQUESTED');
});

test('a declined request closes on the company’s page', async () => {
  const r = await sentRequest('Quay Robotics');
  // Two clicks at once: the approval inbox hears of it once.
  const before = printed.length;
  const confirm = linkIn('confirm');
  await Promise.all([call('POST', '/api/409a-relay/confirm', { token: confirm }), call('POST', '/api/409a-relay/confirm', { token: confirm })]);
  assert.equal(printed.slice(before).filter((m) => m.includes('would send to review@example.test')).length, 1);
  await decide(linkIn('team'), 'DECLINED');
  const now = await page(r);
  assert.equal(now.status, 'CANCELLED');
  assert.ok(now.events.some((e: any) => e.kind === 'CANCELLED' && e.author === 'desk'));
});

test('cancelling withdraws the request at the relay, and it can no longer be approved', async () => {
  const r = await sentRequest('Cove Systems');
  const { relay_id, relay_token } = await one<any>('SELECT relay_id, relay_token FROM valuation_requests WHERE id = ?', r.id);
  await call('POST', '/api/409a-relay/confirm', { token: linkIn('confirm') });
  const team = linkIn('team');
  assert.equal((await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, as)).status, 200);
  assert.equal((await call('GET', `/api/409a-relay/${relay_id}`, undefined, { Authorization: `Bearer ${relay_token}` })).json.status, 'WITHDRAWN');
  assert.ok(printed.at(-1)!.includes('409A request withdrawn'), 'the approval inbox is told');
  assert.equal((await decide(team, 'APPROVED')).status, 400);
});

test('a new contact withdraws the old request at the relay and asks the new address', async () => {
  const r = await sentRequest('Delta Mills');
  const old = await one<any>('SELECT relay_id, relay_token FROM valuation_requests WHERE id = ?', r.id);
  const changed = await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { contactEmail: 'cfo@delta.example.com' }, as);
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal((await call('GET', `/api/409a-relay/${old.relay_id}`, undefined, { Authorization: `Bearer ${old.relay_token}` })).json.status, 'WITHDRAWN');
  const now = await one<any>('SELECT relay_id, approval_notified_at FROM valuation_requests WHERE id = ?', r.id);
  assert.ok(now.relay_id && now.relay_id !== old.relay_id && now.approval_notified_at);
  assert.ok(printed.at(-1)!.includes('would send to cfo@delta.example.com'));
});

test('in production, a relay without mail takes nothing, so no link is only printed', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const res = await call('POST', '/api/409a-relay', { token: newToken(), companyName: 'X', answers: ANSWERS, contactEmail: 'a@b.example', contactPhone: '+1 415 555 0100', requestedBy: 'Someone' });
    assert.equal(res.status, 403);
  } finally {
    delete process.env.NODE_ENV;
  }
});

test('the company page leaves out Stripe’s ids', async () => {
  const cid = (await call('POST', '/api/companies', { name: 'Ids Co' }, as)).json.id as string;
  await run("UPDATE companies SET stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x', billing_status = 'active' WHERE id = ?", cid);
  const company = (await call('GET', `/api/c/${cid}`, undefined, as)).json;
  assert.equal(company.billingStatus, 'active');
  assert.equal(company.stripeCustomerId, undefined);
  assert.equal(company.stripeSubscriptionId, undefined);
});

test('the contact’s email carries no address the sender chose', async () => {
  const res = await call('POST', '/api/409a-relay', {
    token: newToken(), companyName: 'Lure Co', answers: ANSWERS, contactEmail: 'victim@example.test', contactPhone: '+1 415 555 0100',
    requestedBy: 'Someone', instanceUrl: 'https://evil.example/login',
  });
  assert.equal(res.status, 200);
  const sent = printed.find((m) => m.includes('would send to victim@example.test'))!;
  assert.ok(sent && !sent.includes('evil.example'));
});

test('a retry with the same token gets the same request, and no second email', async () => {
  const token = newToken();
  const first = await direct(token, 'retry@example.test');
  const sentTo = () => printed.filter((m) => m.includes('would send to retry@example.test')).length;
  assert.equal(sentTo(), 1);
  const again = await direct(token, 'retry@example.test');
  assert.equal(again.json.id, first.json.id);
  assert.equal(sentTo(), 1);
});

test('a burst to one address cannot get past its allowance', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => direct(newToken(), 'flood@example.test')));
  assert.equal(results.filter((r) => r.status === 200).length, 5, 'requestsPerPersonPerDay');
  assert.equal(printed.filter((m) => m.includes('would send to flood@example.test')).length, 5);
});

test('the relay refuses answers it does not take, and a stranger’s links', async () => {
  const bad = await call('POST', '/api/409a-relay', { token: newToken(), companyName: 'X', answers: { ...ANSWERS, stage: 'NOT_A_STAGE' }, contactEmail: 'a@b.example', contactPhone: '+1 415 555 0100', requestedBy: 'Someone' });
  assert.equal(bad.status, 400);
  assert.equal((await call('POST', '/api/409a-relay/confirm', { token: 'x'.repeat(43) })).status, 404);
  assert.equal((await decide('x'.repeat(43), 'APPROVED')).status, 404);
});
