/** Billing integration: real routes and scratch PostgreSQL; every Stripe method is local. */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

// NODE_TEST_CONTEXT ignores the developer's private config. Secrets here are fictional.
delete process.env.KOSMITOR_CONFIG;
process.env.STRIPE_SECRET_KEY = 'sk_test_billing_fixture_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_fixture_not_a_real_secret';
process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';
process.env.VALUATION_DESK_EMAIL = 'evaluator@example.test';
process.env.VALUATION_APPROVAL_EMAIL = 'approvals@example.test';
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/files.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/valuation-requests.ts');
await import('../src/routes/billing.ts');
const { configure } = await import('../src/config.ts');
const { one, all, run } = await import('../src/db.ts');
const { stripeClient } = await import('../src/stripe.ts');
configure({
  app: { url: 'https://app.example.test' }, mail: { welcomeEmail: false },
  billing: { enabled: true, valuationPriceId: 'price_valuation', subscriptionPlans: [
    { key: 'monthly', name: 'Monthly plan', priceId: 'price_monthly' },
    { key: 'annual', name: 'Annual plan', priceId: 'price_annual' },
  ] },
  valuationDesk: { enabled: true, approvalEmail: 'approvals@example.test', sendCooldownSeconds: 0, resendCooldownMinutes: 0,
    requestsPerCompanyPerDay: 100, requestsPerPersonPerDay: 100, noticesPerCompanyPerDay: 100, noticesPerPersonPerDay: 100, noticesPerHour: 100 },
});

const mail: { to: string; subject: string; text: string }[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const text = args.map(String).join(' ');
  const found = text.match(/^\[mail\] not configured[^\n]*would send to (\S+): "([^"\n]*)"\n([\s\S]*)$/);
  if (found) mail.push({ to: found[1], subject: found[2], text: found[3] }); else realLog(...args);
};
after(() => { console.log = realLog; mock.restoreAll(); });
const approvals = () => mail.filter(m => m.subject.startsWith('409A request awaiting approval:'));
const evaluatorNotices = () => mail.filter(m => m.subject.startsWith('New 409A request'));
const approvalToken = () => approvals().at(-1)!.text.match(/\/409a-approval#([A-Za-z0-9_-]{43})/)![1];

const prices = new Map<string, any>([
  ['price_monthly', { id: 'price_monthly', active: true, billing_scheme: 'per_unit', unit_amount: 2900, currency: 'usd', type: 'recurring', recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 } }],
  ['price_annual', { id: 'price_annual', active: true, billing_scheme: 'per_unit', unit_amount: 29000, currency: 'usd', type: 'recurring', recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 } }],
  ['price_valuation', { id: 'price_valuation', active: true, billing_scheme: 'per_unit', unit_amount: 199900, currency: 'usd', type: 'one_time', recurring: null }],
  ['price_valuationNew', { id: 'price_valuationNew', active: true, billing_scheme: 'per_unit', unit_amount: 249900, currency: 'usd', type: 'one_time', recurring: null }],
]);
const sessions = new Map<string, any>();
const subscriptions = new Map<string, any>();
const invoices = new Map<string, any>();
const initialSubscriptionIntents = new Map<string, string>();
const refunds = new Map<string, number>();
const intentOverrides = new Map<string, Record<string, unknown>>();
const customerKeys = new Map<string, any>();
const sessionKeys = new Map<string, { params: any; sessionId: string }>();
const creates: { params: any; key: string }[] = [];
const portalCalls: any[] = [];
const sdk = stripeClient();
let failNextRetrieve = false;
mock.method(sdk.prices, 'retrieve', async (id: string) => {
  assert.ok(prices.has(id), `the server requested unknown price ${id}`);
  return structuredClone(prices.get(id));
});
mock.method(sdk.customers, 'create', async (params: any, options: any) => {
  const key = options.idempotencyKey;
  if (!customerKeys.has(key)) customerKeys.set(key, { id: `cus_${randomUUID().replaceAll('-', '')}`, metadata: params.metadata });
  return structuredClone(customerKeys.get(key));
});
mock.method(sdk.checkout.sessions, 'create', async (params: any, options: any) => {
  const key = options.idempotencyKey;
  creates.push({ params: structuredClone(params), key });
  const existing = sessionKeys.get(key);
  if (existing) {
    assert.deepEqual(params, existing.params, 'retries use identical provider parameters');
    return structuredClone(sessions.get(existing.sessionId));
  }
  const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
  const price = prices.get(params.line_items[0].price);
  const session = { id, object: 'checkout.session', customer: params.customer, mode: params.mode,
    client_reference_id: params.client_reference_id, metadata: params.metadata, status: 'open', payment_status: 'unpaid',
    line_items: { data: [{ price: { id: price.id }, quantity: 1 }], has_more: false }, currency: price.currency,
    amount_total: price.unit_amount, amount_subtotal: price.unit_amount, expires_at: params.expires_at,
    payment_intent: params.mode === 'payment' ? `pi_${id}` : null, subscription: null,
    url: `https://checkout.stripe.com/c/pay/${id}` };
  sessions.set(id, session);
  sessionKeys.set(key, { params: structuredClone(params), sessionId: id });
  return structuredClone(session);
});
mock.method(sdk.checkout.sessions, 'expire', async (id: string) => {
  const session = sessions.get(id);
  assert.ok(session, `unknown fake session ${id}`);
  assert.equal(session.status, 'open');
  session.status = 'expired';
  return structuredClone(session);
});
mock.method(sdk.checkout.sessions, 'list', async (params: any) => ({
  data: [...sessions.values()].filter(s => s.customer === params.customer).map(s => structuredClone(s)), has_more: false,
}));
mock.method(sdk.checkout.sessions, 'retrieve', async (id: string) => {
  if (failNextRetrieve) { failNextRetrieve = false; throw new Error('Temporary Stripe failure with private provider details'); }
  assert.ok(sessions.has(id), `unknown fake session ${id}`);
  return structuredClone(sessions.get(id));
});
mock.method(sdk.paymentIntents, 'retrieve', async (id: string) => {
  const subscriptionSession = initialSubscriptionIntents.get(id);
  const session = subscriptionSession ? sessions.get(subscriptionSession) : [...sessions.values()].find(s => s.payment_intent === id);
  if (!session) return { id, object: 'payment_intent', status: 'succeeded', customer: 'cus_unrelated', amount: 1000, currency: 'usd', metadata: {} };
  const amount = subscriptionSession ? invoices.get(session.invoice).amount_paid : session.amount_total;
  return { id, object: 'payment_intent', metadata: subscriptionSession ? {} : session.metadata, customer: session.customer, amount, currency: session.currency,
    status: 'succeeded', latest_charge: { id: `ch_${id}`, amount, amount_refunded: refunds.get(id) ?? 0 }, ...intentOverrides.get(id) };
});
const invoiceRetrieval = mock.method(sdk.invoices, 'retrieve', async (id: string) => {
  assert.ok(invoices.has(id), `unknown fake invoice ${id}`);
  return structuredClone(invoices.get(id));
});
mock.method(sdk.subscriptions, 'retrieve', async (id: string) => {
  assert.ok(subscriptions.has(id), `unknown fake subscription ${id}`);
  return structuredClone(subscriptions.get(id));
});
mock.method(sdk.billingPortal.sessions, 'create', async (params: any) => {
  portalCalls.push(structuredClone(params));
  return { id: 'bps_test_local', url: 'https://billing.stripe.com/p/session/test_local' };
});

const api = createServer((req, res) => { void handle(req, res); });
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());
async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const result = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await result.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: result.status, json, token: sessionCookie(result), headers: result.headers };
}
const admin = (await call('POST', '/api/auth/register', { email: 'billing-admin@example.test', name: 'Billing Admin', password: 'billing-fixture-password' })).token!;
async function company(name: string) {
  const response = await call('POST', '/api/companies', { name }, admin);
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.id as string;
}
async function member(cid: string, role: string) {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.test`;
  const added = await call('POST', `/api/c/${cid}/members`, { email, name: `${role} Member`, role }, admin);
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const link = await call('POST', `/api/c/${cid}/members/${added.json.id}/reset-password`, { mode: 'link' }, admin);
  const reset = await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token'), password: 'billing-member-password' });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  return reset.token!;
}
const ANSWERS = {
  valuationDateKind: 'LATEST', valuationDate: null, companySize: '11-50', stage: 'SERIES_A', plans: 'OPTIONS', plansTiming: 'ONE_TO_THREE', optionsToGrant: 250_000,
  last409a: 'NEVER', last409aDate: null, noFullYearYet: false, convertiblesOutstanding: false, projections: 'FILE', guidance: [], capTableConfirmed: true,
  management: [{ name: 'Billing Admin', title: 'Chief executive officer' }], sweatEquity: false, sweatEquityPeople: [], secondary: false, secondaryTransactions: [],
  belowMarketExpenses: false, expenses: [], software: 'Spreadsheets', contactName: 'Billing Admin', contactEmail: 'finance@example.test', contactPhone: '+1 (415) 555-0142', notes: null,
};
async function request(name: string) {
  const cid = await company(name);
  const cls = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
  const founder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Sam Quill', type: 'INDIVIDUAL', relation: 'FOUNDER' }, admin)).json;
  assert.equal((await call('POST', `/api/c/${cid}/issuances`, { certificateNo: 'CS-1', stakeholderId: founder.id, shareClassId: cls.id, quantity: 5_000_000, issueDate: '2024-01-10' }, admin)).status, 200);
  const documents: any[] = [];
  for (const item of ['HISTORICAL_FINANCIALS', 'YTD_FINANCIALS', 'PITCH_DECK', 'CHARTER', 'PROJECTIONS']) {
    const made = await call('POST', `/api/c/${cid}/documents`, { name: `${item}.txt`, category: item === 'CHARTER' ? 'CHARTER' : 'OTHER', body: 'Fictional valuation fixture.' }, admin);
    assert.equal(made.status, 200, JSON.stringify(made.json));
    documents.push({ item, documentId: made.json.id });
  }
  const made = await call('POST', `/api/c/${cid}/valuation-requests`, { ...ANSWERS, documents, paymentRequired: false, paymentStatus: 'paid', paymentPriceId: 'price_from_browser', paidAt: new Date().toISOString() }, admin);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.paymentRequired, true);
  assert.equal(made.json.paymentStatus, 'unpaid');
  assert.equal(made.json.paidAt, null);
  const id = made.json.id as string;
  return { cid, id };
}
const valuationRow = (id: string) => one<any>('SELECT * FROM valuation_requests WHERE id = ?', id);
const payments = (cid: string) => all<any>('SELECT * FROM billing_checkouts WHERE company_id = ? ORDER BY created_at', cid);
const sessionFor = async (cid: string) => sessions.get((await payments(cid)).at(-1)!.stripe_session_id)!;
async function startSubscription(cid: string, planKey = 'monthly') {
  const result = await call('POST', `/api/c/${cid}/billing/checkout`, { planKey }, admin);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return await sessionFor(cid);
}
async function startValuation(r: { cid: string; id: string }, token = admin) {
  const result = await call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/checkout`, {}, token);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return await sessionFor(r.cid);
}
const reconcileValuation = (r: { cid: string; id: string }, sessionId: string, token = admin) =>
  call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/payment/reconcile`, { sessionId }, token);
function event(type: string, object: any, id = `evt_${randomUUID()}`) { return { id, object: 'event', livemode: false, type, data: { object }, created: Math.floor(Date.now() / 1000) }; }
async function webhook(ev: any, options: { signature?: string; raw?: string; timestamp?: number } = {}) {
  const raw = options.raw ?? JSON.stringify(ev);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = options.signature ?? `t=${timestamp},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest('hex')}`;
  const result = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: raw });
  return { status: result.status, json: await result.json() as any };
}
function currentSubscription(session: any, status = 'active') {
  const id = `sub_${randomUUID().replaceAll('-', '')}`;
  const subscription = { id, object: 'subscription', customer: session.customer, status, cancel_at_period_end: false,
    items: { data: [{ price: { id: session.line_items.data[0].price.id }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } };
  subscriptions.set(id, subscription);
  session.subscription = id;
  // Subscription Checkout links an invoice, not a direct payment intent. The
  // initial invoice payment identifies its charge; recurring invoices are separate.
  const invoiceId = `in_${randomUUID().replaceAll('-', '')}`;
  const intentId = `pi_${invoiceId}`;
  session.invoice = invoiceId;
  assert.equal(session.payment_intent, null);
  initialSubscriptionIntents.set(intentId, session.id);
  invoices.set(invoiceId, { id: invoiceId, object: 'invoice', customer: session.customer, status: 'paid', currency: session.currency,
    subtotal: session.amount_total, total: session.amount_total, amount_paid: session.amount_total, amount_due: session.amount_total, amount_remaining: 0,
    parent: { type: 'subscription_details', subscription_details: { subscription: id } },
    payments: { data: [{ id: `inpay_${invoiceId}`, object: 'invoice_payment', invoice: invoiceId, status: 'paid', is_default: true,
      currency: session.currency, amount_paid: session.amount_total, payment: { type: 'payment_intent', payment_intent: intentId } }], has_more: false } });
  return subscription;
}

// --- Scope and checkout creation ------------------------------------------------

test('billing information, subscriptions and portal are admin-only; legal can pay a valuation and readers cannot', async () => {
  const r = await request('Billing Roles');
  const legal = await member(r.cid, 'LEGAL');
  const reader = await member(r.cid, 'BOARD');
  for (const token of [legal, reader]) {
    assert.equal((await call('GET', `/api/c/${r.cid}/billing`, undefined, token)).status, 403);
    assert.equal((await call('POST', `/api/c/${r.cid}/billing/checkout`, { planKey: 'monthly' }, token)).status, 403);
    assert.equal((await call('POST', `/api/c/${r.cid}/billing/portal`, {}, token)).status, 403);
  }
  assert.equal((await call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/checkout`, {}, reader)).status, 403);
  const session = await startValuation(r, legal);
  assert.equal((await reconcileValuation(r, session.id, legal)).status, 200);
  const page = await call('GET', `/api/c/${r.cid}/billing`, undefined, admin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.json.plans[0].amount, 2900);
  assert.equal(page.json.valuationPrice.amount, 199900);
  assert.doesNotMatch(JSON.stringify(page.json), /sk_test|whsec|price_valuation|cus_|approvals@example/);
});

test('the server chooses the price, amount, customer and return URLs; concurrent checkouts reuse a single attempt and idempotency key', async () => {
  const cid = await company('Concurrent Subscription');
  const before = creates.length;
  const answers = await Promise.all(Array.from({ length: 4 }, () => call('POST', `/api/c/${cid}/billing/checkout`, {
    planKey: 'monthly', priceId: 'price_attacker', amount: 1, currency: 'eur', customer: 'cus_attacker', successUrl: 'https://evil.example/success', cancelUrl: 'https://evil.example/cancel',
  }, admin)));
  for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(new Set(answers.map(a => a.json.url)).size, 1);
  const attempts = await payments(cid);
  assert.equal(attempts.length, 1);
  const sent = creates.slice(before);
  assert.equal(new Set(sent.map(c => c.key)).size, 1);
  for (const created of sent) {
    assert.deepEqual(created.params.line_items, [{ price: 'price_monthly', quantity: 1 }]);
    assert.equal(created.params.metadata.companyId, cid);
    assert.equal(created.params.metadata.checkoutId, attempts[0].id);
    assert.equal(created.params.client_reference_id, attempts[0].id);
    assert.notEqual(created.params.customer, 'cus_attacker');
    assert.ok(created.params.success_url.startsWith('https://app.example.test/billing?'));
    assert.ok(created.params.cancel_url.startsWith('https://app.example.test/billing?'));
    assert.ok(created.params.success_url.includes('{CHECKOUT_SESSION_ID}'));
  }
  assert.equal(Number(attempts[0].amount), 2900);
  assert.equal((await call('POST', `/api/c/${cid}/billing/checkout`, { planKey: 'attacker' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/billing/checkout`, { planKey: 'annual' }, admin)).status, 400);
});

test('session reconciliation is tenant-bound even for an administrator of both companies, and portal uses the stored customer', async () => {
  const a = await request('Tenant A');
  const b = await request('Tenant B');
  const session = await startValuation(a);
  assert.equal((await reconcileValuation(b, session.id)).status, 404);
  assert.equal((await call('POST', `/api/c/${b.cid}/billing/reconcile`, { sessionId: session.id }, admin)).status, 404);
  assert.equal((await call('POST', `/api/c/${b.cid}/valuation-requests/${a.id}/checkout`, {}, admin)).status, 404);
  assert.equal((await call('POST', `/api/c/${a.cid}/billing/portal`, { customer: 'cus_attacker', returnUrl: 'https://evil.example' }, admin)).status, 200);
  assert.equal(portalCalls.at(-1).customer, session.customer);
  assert.ok(portalCalls.at(-1).return_url.startsWith('https://app.example.test/billing?'));
  assert.equal((await call('POST', `/api/c/${b.cid}/billing/portal`, {}, admin)).status, 400);
  assert.equal((await valuationRow(a.id)).payment_status, 'unpaid');
});

test('a saved valuation keeps its original price when the catalog changes', async () => {
  const r = await request('Pinned Valuation Price');
  try {
    configure({ billing: { valuationPriceId: 'price_valuationNew' } });
    const session = await startValuation(r);
    assert.equal(session.line_items.data[0].price.id, 'price_valuation');
    assert.equal(session.amount_total, 199900);
  } finally { configure({ billing: { valuationPriceId: 'price_valuation' } }); }
});

// --- Verified payment before approval -----------------------------------------

test('unpaid requests cannot reach review; only a complete and paid current Stripe session records payment and emails approval', async () => {
  const r = await request('Pay Before Review');
  mail.length = 0;
  const sent = await call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/send`, {}, admin);
  assert.ok([400, 402].includes(sent.status), JSON.stringify(sent.json));
  assert.equal(approvals().length, 0);
  assert.equal(evaluatorNotices().length, 0);
  const session = await startValuation(r);
  session.status = 'complete';
  assert.equal((await reconcileValuation(r, session.id)).status, 200);
  assert.equal((await valuationRow(r.id)).payment_status, 'unpaid');
  assert.equal((await payments(r.cid))[0].status, 'processing');
  assert.equal(approvals().length, 0);
  session.status = 'open'; session.payment_status = 'paid';
  assert.equal((await reconcileValuation(r, session.id)).status, 200);
  assert.equal((await valuationRow(r.id)).payment_status, 'unpaid', 'paid alone without complete is insufficient');
  session.status = 'complete';
  const paid = await webhook(event('checkout.session.completed', { id: session.id, payment_status: 'unpaid' }));
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  const row = await valuationRow(r.id);
  assert.equal(row.payment_status, 'paid');
  assert.ok(row.paid_at);
  assert.equal(row.approved_at, null);
  assert.equal(approvals().length, 1, 'payment forwards to internal review, not to the evaluator');
  assert.equal(evaluatorNotices().length, 0);
  assert.equal((await all("SELECT id FROM valuation_request_events WHERE request_id = ? AND kind = 'PAID'", r.id)).length, 1);
  const approved = await call('POST', '/api/valuation-approval/approve', {}, undefined, { 'X-Approval-Token': approvalToken() });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.ok((await valuationRow(r.id)).approved_at);
  assert.equal(evaluatorNotices().length, 1);
});

test('every session ownership and price binding is checked before payment can be recorded', async () => {
  const r = await request('Strict Session Binding');
  const session = await startValuation(r);
  session.status = 'complete'; session.payment_status = 'paid';
  const original = structuredClone(session);
  const changes: [string, (s: any) => void][] = [
    ['checkout metadata', s => { s.metadata.checkoutId = 'bco_somebody_else'; }],
    ['company metadata', s => { s.metadata.companyId = 'other-company'; }],
    ['reference', s => { s.client_reference_id = 'other-checkout'; }],
    ['customer', s => { s.customer = 'cus_somebody_else'; }],
    ['mode', s => { s.mode = 'subscription'; }],
    ['price', s => { s.line_items.data[0].price.id = 'price_monthly'; }],
    ['quantity', s => { s.line_items.data[0].quantity = 2; }],
    ['extra line', s => { s.line_items.data.push(structuredClone(s.line_items.data[0])); }],
    ['unexpanded lines', s => { s.line_items.has_more = true; }],
    ['currency', s => { s.currency = 'eur'; }],
    ['total', s => { s.amount_total = 1; }],
    ['subtotal', s => { s.amount_subtotal = 1; }],
  ];
  for (const [label, alter] of changes) {
    const changed = structuredClone(original); alter(changed); sessions.set(session.id, changed);
    const answer = await reconcileValuation(r, session.id);
    assert.equal(answer.status, 400, `${label}: ${JSON.stringify(answer.json)}`);
    assert.equal((await valuationRow(r.id)).payment_status, 'unpaid', label);
  }
  sessions.set(session.id, original);
});

test('invalid, tampered and expired webhook signatures never claim events or mutate payment', async () => {
  const r = await request('Webhook Verification');
  const session = await startValuation(r);
  session.status = 'complete'; session.payment_status = 'paid';
  const ev = event('checkout.session.completed', { id: session.id });
  assert.equal((await webhook(ev, { signature: 'invalid' })).status, 400);
  const raw = JSON.stringify(ev);
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = `t=${timestamp},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest('hex')}`;
  assert.equal((await webhook(ev, { signature: signed, raw: `${raw} ` })).status, 400);
  assert.equal((await webhook(ev, { timestamp: timestamp - 301 })).status, 400);
  assert.equal(await one('SELECT id FROM billing_events WHERE id = ?', ev.id), undefined);
  assert.equal((await valuationRow(r.id)).payment_status, 'unpaid');
});

test('webhook delivery is idempotent and a transient Stripe failure rolls back the event claim for retry', async () => {
  const r = await request('Webhook Replay');
  const session = await startValuation(r);
  session.status = 'complete'; session.payment_status = 'paid';
  const ev = event('checkout.session.async_payment_succeeded', { id: session.id });
  failNextRetrieve = true;
  const failed = await webhook(ev);
  assert.equal(failed.status, 503, JSON.stringify(failed.json));
  assert.doesNotMatch(JSON.stringify(failed.json), /private provider details|sk_test|whsec/);
  assert.equal(await one('SELECT id FROM billing_events WHERE id = ?', ev.id), undefined);
  mail.length = 0;
  assert.equal((await webhook(ev)).status, 200);
  assert.equal(approvals().length, 1);
  // Console mail is deliberately undelivered. Mark this attempt as received to
  // exercise the state a successful mail transport would leave behind.
  await run('UPDATE valuation_requests SET approval_notified_at = ?, recap_sent_at = ? WHERE id = ?', new Date().toISOString(), new Date().toISOString(), r.id);
  const responses = await Promise.all([webhook(ev), webhook(ev), webhook(ev)]);
  for (const answer of responses) assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal((await all('SELECT id FROM billing_events WHERE id = ?', ev.id)).length, 1);
  assert.equal((await all("SELECT id FROM valuation_request_events WHERE request_id = ? AND kind = 'PAID'", r.id)).length, 1);
  assert.equal(approvals().length, 1, 'successful mail is not repeated by duplicate webhook events');
  // Model a process stopping after payment commits but before the notice goes.
  await run('UPDATE valuation_requests SET approval_notified_at = NULL, recap_sent_at = NULL WHERE id = ?', r.id);
  assert.equal((await webhook(ev)).status, 200);
  assert.equal(approvals().length, 2, 'a replay resumes the missed approval notification');
  assert.equal((await all("SELECT id FROM valuation_request_events WHERE request_id = ? AND kind = 'PAID'", r.id)).length, 1);
});

test('asynchronous failures and expired sessions release unpaid attempts without creating approvals', async () => {
  for (const state of ['failed', 'expired']) {
    const r = await request(`Payment ${state}`);
    const session = await startValuation(r);
    session.status = state === 'failed' ? 'complete' : 'expired';
    session.payment_status = 'unpaid';
    mail.length = 0;
    const result = await webhook(event(state === 'failed' ? 'checkout.session.async_payment_failed' : 'checkout.session.expired', { id: session.id }));
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal((await payments(r.cid))[0].status, state);
    assert.equal((await valuationRow(r.id)).payment_status, 'unpaid');
    assert.equal(approvals().length, 0);
    const retry = await startValuation(r);
    assert.notEqual(retry.id, session.id);
    assert.equal((await payments(r.cid)).length, 2);
  }
});

// --- Subscription lifecycle and refunds ----------------------------------------

test('subscriptions follow current Stripe state even when events arrive out of order, and active subscriptions prevent duplicate checkout', async () => {
  const cid = await company('Subscription Lifecycle');
  const session = await startSubscription(cid);
  const sub = currentSubscription(session);
  session.status = 'complete'; session.payment_status = 'paid';
  assert.equal((await webhook(event('checkout.session.completed', { id: session.id }))).status, 200);
  assert.equal((await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id)).status, 'active');
  assert.equal((await call('POST', `/api/c/${cid}/billing/checkout`, { planKey: 'annual' }, admin)).status, 400);
  sub.status = 'past_due';
  assert.equal((await webhook(event('invoice.payment_failed', { id: 'in_fixture', customer: session.customer, parent: { subscription_details: { subscription: sub.id } } }))).status, 200);
  assert.equal((await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id)).status, 'past_due');
  sub.status = 'active'; sub.cancel_at_period_end = true;
  assert.equal((await webhook(event('customer.subscription.updated', { id: sub.id, customer: session.customer, status: 'past_due', cancel_at_period_end: false }))).status, 200);
  let recorded = (await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id));
  assert.equal(recorded.status, 'active');
  assert.equal(recorded.cancel_at_period_end, true);
  sub.status = 'canceled';
  assert.equal((await webhook(event('customer.subscription.deleted', { id: sub.id, customer: session.customer, status: 'active' }))).status, 200);
  recorded = await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id);
  assert.equal(recorded.status, 'canceled');
  const retry = await startSubscription(cid, 'annual');
  assert.notEqual(retry.id, session.id);
});

test('subscription sync refuses a current Stripe subscription belonging to another customer', async () => {
  const cid = await company('Foreign Subscription');
  const session = await startSubscription(cid);
  const sub = currentSubscription(session);
  sub.customer = 'cus_foreign';
  const ev = event('customer.subscription.updated', { id: sub.id, customer: session.customer });
  assert.equal((await webhook(ev)).status, 400);
  assert.equal(await one('SELECT id FROM billing_subscriptions WHERE id = ?', sub.id), undefined);
  assert.equal(await one('SELECT id FROM billing_events WHERE id = ?', ev.id), undefined);
});

test('partial and full refunds are monotonic, tenant-bound, and stale payment events cannot restore a refunded valuation', async () => {
  const r = await request('Valuation Refund');
  const session = await startValuation(r);
  session.status = 'complete'; session.payment_status = 'paid';
  assert.equal((await webhook(event('checkout.session.completed', { id: session.id }))).status, 200);
  const charge = (amount: number, intent = session.payment_intent) => event('charge.refunded', { id: 'ch_fixture', payment_intent: intent, customer: session.customer, amount_refunded: amount });
  assert.equal((await webhook(charge(10000, 'pi_somebody_else'))).status, 200);
  assert.equal(Number((await payments(r.cid))[0].refunded_amount), 0);
  assert.equal((await webhook(charge(10000))).status, 200);
  assert.equal(Number((await payments(r.cid))[0].refunded_amount), 10000);
  assert.equal((await valuationRow(r.id)).payment_status, 'paid');
  assert.equal((await webhook(charge(5000))).status, 200);
  assert.equal(Number((await payments(r.cid))[0].refunded_amount), 10000);
  assert.equal((await webhook(charge(session.amount_total))).status, 200);
  assert.equal((await payments(r.cid))[0].status, 'refunded');
  assert.equal((await valuationRow(r.id)).payment_status, 'refunded');
  mail.length = 0;
  assert.equal((await webhook(event('checkout.session.completed', { id: session.id }))).status, 200);
  assert.equal((await valuationRow(r.id)).payment_status, 'refunded');
  assert.equal(approvals().length, 0);
  assert.equal((await call('POST', `/api/c/${r.cid}/valuation-requests/${r.id}/send`, {}, admin)).status, 400);
});

test('legacy requests retain their payment exemption and never open a checkout', async () => {
  const r = await request('Legacy Billing');
  const id = `legacy_${randomUUID()}`;
  await run(`INSERT INTO valuation_requests (id, company_id, status, provider, requested_by, requested_by_id, contact_name, contact_email, contact_phone, answers, created_at, updated_at)
    SELECT ?, company_id, status, provider, requested_by, requested_by_id, contact_name, contact_email, contact_phone, answers, created_at, updated_at
    FROM valuation_requests WHERE id = ?`, id, r.id);
  const legacy = await valuationRow(id);
  assert.equal(legacy.payment_required, false);
  assert.equal(legacy.payment_status, 'unpaid');
  assert.equal(legacy.payment_price_id, null);
  assert.equal((await call('POST', `/api/c/${r.cid}/valuation-requests/${id}/checkout`, {}, admin)).status, 400);
  mail.length = 0;
  const sent = await call('POST', `/api/c/${r.cid}/valuation-requests/${id}/send`, {}, admin);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(evaluatorNotices().length, 1, 'old requests preserve their existing evaluator workflow');
  assert.equal(approvals().length, 0);
});

test('a full refund received before checkout completion is never forwarded to review', async () => {
  const r = await request('Refund Before Completion');
  const session = await startValuation(r);
  session.status = 'complete'; session.payment_status = 'paid';
  refunds.set(session.payment_intent, session.amount_total);
  mail.length = 0;
  const refund = await webhook(event('charge.refunded', { id: 'ch_early', payment_intent: session.payment_intent, amount_refunded: session.amount_total }));
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  assert.equal((await valuationRow(r.id)).payment_status, 'refunded');
  const complete = await webhook(event('checkout.session.completed', { id: session.id }));
  assert.equal(complete.status, 200, JSON.stringify(complete.json));
  assert.equal((await valuationRow(r.id)).payment_status, 'refunded');
  assert.equal((await payments(r.cid))[0].status, 'refunded');
  assert.equal(approvals().length, 0);
  assert.equal((await all("SELECT id FROM valuation_request_events WHERE request_id = ? AND kind = 'PAID'", r.id)).length, 0);
});

test('cancelling an unpaid request expires its open checkout; a payment still processing prevents cancellation', async () => {
  const r = await request('Cancel Open Checkout');
  const session = await startValuation(r);
  const cancelled = await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { status: 'CANCELLED' }, admin);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(session.status, 'expired');
  assert.equal((await payments(r.cid))[0].status, 'expired');
  assert.equal((await valuationRow(r.id)).status, 'CANCELLED');
  const processing = await request('Do Not Cancel Processing');
  const pending = await startValuation(processing);
  pending.status = 'complete'; pending.payment_status = 'unpaid';
  assert.equal((await reconcileValuation(processing, pending.id)).status, 200);
  const refused = await call('PATCH', `/api/c/${processing.cid}/valuation-requests/${processing.id}`, { status: 'CANCELLED' }, admin);
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.equal((await valuationRow(processing.id)).status, 'REQUESTED');
  assert.equal((await payments(processing.cid))[0].status, 'processing');
});

test('deleting a company is refused while it has a pending checkout or a live subscription', async () => {
  const name = 'Protected Billing Company';
  const cid = await company(name);
  const session = await startSubscription(cid);
  const path = `/api/c/${cid}?confirm=${encodeURIComponent(name)}`;
  assert.equal((await call('DELETE', path, undefined, admin)).status, 400);
  assert.ok(await one('SELECT id FROM companies WHERE id = ?', cid));
  const sub = currentSubscription(session);
  session.status = 'complete'; session.payment_status = 'paid';
  assert.equal((await webhook(event('checkout.session.completed', { id: session.id }))).status, 200);
  assert.equal((await call('DELETE', path, undefined, admin)).status, 400);
  assert.ok(await one('SELECT id FROM companies WHERE id = ?', cid));
  sub.status = 'canceled';
  assert.equal((await webhook(event('customer.subscription.deleted', { id: sub.id, customer: session.customer }))).status, 200);
  const removed = await call('DELETE', path, undefined, admin);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
});

test('payment quotes use each request’s stored price and cannot inspect another company’s request', async () => {
  const r = await request('Stored Quote');
  const other = await company('Quote Outsider');
  try {
    configure({ billing: { valuationPriceId: 'price_valuationNew' } });
    const quote = await call('GET', `/api/c/${r.cid}/valuation-requests/payment?requestId=${r.id}`, undefined, admin);
    assert.equal(quote.status, 200, JSON.stringify(quote.json));
    assert.equal(quote.json.required, true);
    assert.equal(quote.json.price.amount, 199900);
    const current = await call('GET', `/api/c/${r.cid}/valuation-requests/payment`, undefined, admin);
    assert.equal(current.json.price.amount, 249900);
    assert.equal((await call('GET', `/api/c/${other}/valuation-requests/payment?requestId=${r.id}`, undefined, admin)).status, 404);
    configure({ billing: { valuationPriceId: null } });
    const missing = await call('GET', `/api/c/${r.cid}/valuation-requests/payment`, undefined, admin);
    assert.equal(missing.json.required, true, 'missing deployment pricing never makes a paid service free');
    assert.equal(missing.json.configured, false);
  } finally { configure({ billing: { valuationPriceId: 'price_valuation' } }); }
});

test('signed events for the wrong Stripe mode or a connected account are rejected before they claim an event', async () => {
  for (const ev of [
    { ...event('customer.created', { id: 'cus_elsewhere' }), livemode: true },
    { ...event('customer.created', { id: 'cus_elsewhere' }), account: 'acct_someone_else' },
  ]) {
    assert.equal((await webhook(ev)).status, 400);
    assert.equal(await one('SELECT id FROM billing_events WHERE id = ?', ev.id), undefined);
  }
});

test('stored review and evaluator tokens cannot bypass unpaid status, even if an approval timestamp exists', async () => {
  const r = await request('Unpaid Token Guard');
  const review = randomBytes(32).toString('base64url');
  const desk = randomBytes(32).toString('base64url');
  const stamp = new Date().toISOString();
  await run('UPDATE valuation_requests SET approval_token_hash = ?, approval_token_at = ?, approval_email = ?, desk_token_hash = ?, desk_token_at = ? WHERE id = ?',
    createHash('sha256').update(review).digest('hex'), stamp, 'approvals@example.test', createHash('sha256').update(desk).digest('hex'), stamp, r.id);
  assert.equal((await call('POST', '/api/valuation-approval/approve', {}, undefined, { 'X-Approval-Token': review })).status, 404);
  await run('UPDATE valuation_requests SET approved_at = ? WHERE id = ?', stamp, r.id);
  assert.equal((await call('GET', '/api/valuation-desk', undefined, undefined, { 'X-Desk-Token': desk })).status, 404);
  assert.equal((await call('POST', '/api/valuation-desk/status', { action: 'START' }, undefined, { 'X-Desk-Token': desk })).status, 404);
  assert.equal((await call('PATCH', `/api/c/${r.cid}/valuation-requests/${r.id}`, { paymentStatus: 'paid', paymentRequired: false }, admin)).status, 400);
  assert.equal((await valuationRow(r.id)).payment_status, 'unpaid');
});

test('checkout recovery finds an existing Stripe session after a crash without creating a second one', async () => {
  const cid = await company('Recover Existing Checkout');
  const session = await startSubscription(cid);
  const before = creates.length;
  const attempt = (await payments(cid))[0];
  await run('UPDATE billing_checkouts SET stripe_session_id = NULL, created_at = ? WHERE id = ?', new Date(Date.now() - 6 * 60_000).toISOString(), attempt.id);
  const recovered = await call('POST', `/api/c/${cid}/billing/checkout`, { planKey: 'monthly' }, admin);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  assert.equal(recovered.json.url, session.url);
  assert.equal(creates.length, before);
  assert.equal((await payments(cid)).length, 1);
  assert.equal((await payments(cid))[0].stripe_session_id, session.id);
});

test('a paid checkout also requires a successful matching payment intent with its latest refund information', async () => {
  const r = await request('Payment Intent Binding');
  const session = await startValuation(r);
  session.status = 'complete'; session.payment_status = 'paid';
  const changes: [Record<string, unknown>, number][] = [
    [{ status: 'processing' }, 400], [{ amount: 1 }, 400], [{ currency: 'eur' }, 400], [{ customer: 'cus_elsewhere' }, 400],
    [{ latest_charge: null }, 503], [{ latest_charge: 'ch_unexpanded' }, 503],
  ];
  for (const [override, status] of changes) {
    intentOverrides.set(session.payment_intent, override);
    const response = await reconcileValuation(r, session.id);
    assert.equal(response.status, status, JSON.stringify(response.json));
    assert.equal((await valuationRow(r.id)).payment_status, 'unpaid');
  }
  intentOverrides.delete(session.payment_intent);
});

test('an initial subscription invoice payment is correlated to refunds without cancelling the live subscription', async () => {
  const cid = await company('Initial Subscription Refund');
  const session = await startSubscription(cid);
  const sub = currentSubscription(session);
  const intent = invoices.get(session.invoice).payments.data[0].payment.payment_intent;
  session.status = 'complete'; session.payment_status = 'paid';
  assert.equal(session.payment_intent, null, 'Stripe exposes the initial subscription payment through its invoice');
  const completed = await webhook(event('checkout.session.completed', { id: session.id }));
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  let payment = (await payments(cid))[0];
  assert.equal(payment.stripe_payment_intent_id, intent);
  assert.equal(payment.status, 'paid');
  assert.equal((await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id)).status, 'active');
  refunds.set(intent, session.amount_total);
  const refunded = await webhook(event('charge.refunded', { id: `ch_${intent}`, payment_intent: intent, customer: session.customer, amount: session.amount_total, amount_refunded: session.amount_total }));
  assert.equal(refunded.status, 200, JSON.stringify(refunded.json));
  payment = (await payments(cid))[0];
  assert.equal(payment.status, 'refunded');
  assert.equal(Number(payment.refunded_amount), session.amount_total);
  assert.equal((await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id)).status, 'active', 'refund accounting does not cancel recurring billing');
  assert.equal((await webhook(event('checkout.session.completed', { id: session.id }))).status, 200);
  assert.equal((await payments(cid))[0].status, 'refunded');
  assert.equal((await payments(cid))[0].stripe_payment_intent_id, intent);
});

test('a subscription charge refunded before checkout fulfillment is read from the invoice payment and remains refunded', async () => {
  const cid = await company('Early Subscription Refund');
  const session = await startSubscription(cid);
  const sub = currentSubscription(session);
  const intent = invoices.get(session.invoice).payments.data[0].payment.payment_intent;
  session.status = 'complete'; session.payment_status = 'paid';
  refunds.set(intent, session.amount_total);
  const early = await webhook(event('charge.refunded', { id: `ch_${intent}`, payment_intent: intent, customer: session.customer, amount: session.amount_total, amount_refunded: session.amount_total }));
  assert.equal(early.status, 200, JSON.stringify(early.json));
  const completed = await webhook(event('checkout.session.completed', { id: session.id }));
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  const payment = (await payments(cid))[0];
  assert.equal(payment.stripe_payment_intent_id, intent);
  assert.equal(payment.status, 'refunded');
  assert.equal(Number(payment.refunded_amount), session.amount_total);
  assert.equal((await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id)).status, 'active');
});

test('a fully credited initial subscription invoice needs no payment intent and still synchronizes its subscription', async () => {
  const cid = await company('Credited Subscription Invoice');
  const session = await startSubscription(cid);
  const sub = currentSubscription(session);
  const invoice = invoices.get(session.invoice);
  const intent = invoice.payments.data[0].payment.payment_intent;
  initialSubscriptionIntents.delete(intent);
  invoice.amount_due = 0; invoice.amount_paid = 0; invoice.payments.data = [];
  session.status = 'complete'; session.payment_status = 'no_payment_required';
  const before = invoiceRetrieval.mock.callCount();
  const completed = await webhook(event('checkout.session.completed', { id: session.id }));
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  assert.ok(invoiceRetrieval.mock.callCount() > before);
  const payment = (await payments(cid))[0];
  assert.equal(payment.status, 'paid');
  assert.equal(payment.stripe_payment_intent_id, null);
  assert.equal(Number(payment.refunded_amount), 0);
  assert.equal((await one<any>('SELECT * FROM billing_subscriptions WHERE id = ?', sub.id)).status, 'active');
});

test('initial subscription invoices must match the customer, subscription and quoted price before fulfillment', async () => {
  const cid = await company('Subscription Invoice Binding');
  const session = await startSubscription(cid);
  const sub = currentSubscription(session);
  session.status = 'complete'; session.payment_status = 'paid';
  const original = structuredClone(invoices.get(session.invoice));
  const changes: [string, (invoice: any) => void][] = [
    ['customer', invoice => { invoice.customer = 'cus_someone_else'; }],
    ['subscription', invoice => { invoice.parent.subscription_details.subscription = 'sub_someone_else'; }],
    ['total', invoice => { invoice.total = 1; }],
    ['subtotal', invoice => { invoice.subtotal = 1; }],
    ['currency', invoice => { invoice.currency = 'eur'; }],
    ['unpaid invoice', invoice => { invoice.status = 'open'; }],
    ['payment invoice', invoice => { invoice.payments.data[0].invoice = 'in_someone_else'; }],
    ['payment amount', invoice => { invoice.payments.data[0].amount_paid = 1; }],
  ];
  for (const [label, alter] of changes) {
    const changed = structuredClone(original); alter(changed); invoices.set(session.invoice, changed);
    const response = await call('POST', `/api/c/${cid}/billing/reconcile`, { sessionId: session.id }, admin);
    assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.json)}`);
    const payment = (await payments(cid))[0];
    assert.equal(payment.status, 'pending');
    assert.equal(payment.paid_at, null);
    assert.equal(payment.stripe_payment_intent_id, null);
    assert.equal(await one('SELECT id FROM billing_subscriptions WHERE id = ?', sub.id), undefined);
  }
  invoices.set(session.invoice, original);
});
