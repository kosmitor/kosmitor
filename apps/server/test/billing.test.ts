/**
 * Stripe's webhook over HTTP: the signature is checked, the subscription is read
 * back from a stand-in Stripe API, and an ended subscription never overwrites
 * the company's current one.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { freshDatabase } from './helpers.ts';

const SECRET = 'whsec_test';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/billing.ts');
const { insert, one } = await import('../src/db.ts');
const { configure } = await import('../src/config.ts');
configure({ billing: { priceId: 'price_test1' } });

// The stand-in Stripe API: GET /v1/subscriptions/:id answers from here.
const subscriptions: Record<string, Record<string, unknown>> = {};
// Checkout sessions: how many were made, and each one's state.
const sessions: Record<string, { id: string; url: string; status: string }> = {};
let made = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.stripe.com') return realFetch(input, init);
  if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
    const s = { id: `cs_${++made}`, url: `https://checkout.stripe.test/${made}`, status: 'open' };
    sessions[s.id] = s;
    return new Response(JSON.stringify(s));
  }
  if (url.pathname.startsWith('/v1/checkout/sessions/')) return new Response(JSON.stringify(sessions[url.pathname.split('/').pop()!]));
  const sub = subscriptions[url.pathname.split('/').pop()!];
  return new Response(JSON.stringify(sub ?? { error: { message: 'No such subscription' } }), { status: sub ? 200 : 404 });
}) as typeof fetch;

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => { api.close(); globalThis.fetch = realFetch; });

await insert('companies', { id: 'co_paying', name: 'Paying Co', createdAt: new Date().toISOString() });
const PERIOD_END = 1798761600;   // 2027-01-01
subscriptions.sub_new = { id: 'sub_new', customer: 'cus_1', status: 'active', metadata: { companyId: 'co_paying' }, items: { data: [{ current_period_end: PERIOD_END }] } };
subscriptions.sub_old = { id: 'sub_old', customer: 'cus_1', status: 'canceled', metadata: { companyId: 'co_paying' }, items: { data: [] } };

function deliver(event: unknown, { secret = SECRET, at = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${at},v1=${sig}` }, body });
}
const billing = () => one('SELECT stripe_customer_id, stripe_subscription_id, billing_status, billing_period_end FROM companies WHERE id = ?', 'co_paying');
const updated = (id: string) => ({ type: 'customer.subscription.updated', data: { object: { id } } });

test('an event signed with another secret, or too long ago, changes nothing', async () => {
  assert.equal((await deliver(updated('sub_new'), { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await deliver(updated('sub_new'), { at: Math.floor(Date.now() / 1000) - 600 })).status, 400);
  assert.equal((await fetch(`${base}/api/billing/webhook`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await billing())!.billing_status, null);
});

test('a signed event records the subscription as Stripe has it', async () => {
  assert.equal((await deliver(updated('sub_new'))).status, 200);
  assert.deepEqual(await billing(), {
    stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_new', billing_status: 'active',
    billing_period_end: new Date(PERIOD_END * 1000).toISOString(),
  });
});

test('a late event for an ended subscription leaves the current one in place', async () => {
  assert.equal((await deliver({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_old' } } })).status, 200);
  assert.equal((await billing())!.stripe_subscription_id, 'sub_new');
  assert.equal((await billing())!.billing_status, 'active');
});

test('a company has one Checkout session at a time, so it cannot subscribe twice', async () => {
  const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pay@example.com', name: 'Pat Doe', password: 'pay-pass-12' }) });
  const auth = { Authorization: `Bearer ${reg.headers.get('set-cookie')!.match(/kosmitor_session=([^;]+)/)![1]}`, 'Content-Type': 'application/json' };
  const cid = ((await (await fetch(`${base}/api/companies`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Two Tabs' }) })).json()) as { id: string }).id;
  const checkout = async () => ((await (await fetch(`${base}/api/c/${cid}/billing/checkout`, { method: 'POST', headers: auth, body: '{}' })).json()) as { url: string }).url;
  const [a, b] = await Promise.all([checkout(), checkout()]);
  assert.equal(a, b);
  assert.equal(made, 1);
  // Once that session has expired, the next click gets a new one.
  sessions.cs_1.status = 'expired';
  assert.notEqual(await checkout(), a);
  assert.equal(made, 2);
});
