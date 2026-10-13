/**
 * Subscriptions through Stripe, without its SDK. An administrator subscribes the
 * company in Stripe Checkout and manages the subscription in Stripe's customer
 * portal; Stripe's webhook keeps companies.billing_status in step. Off until
 * billing.priceId is set. The keys stay in the environment: STRIPE_SECRET_KEY,
 * and STRIPE_WEBHOOK_SECRET for the endpoint /api/billing/webhook.
 *
 * Nothing is refused to a company that has not paid: billing_status only says
 * where it stands.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { route, badRequest, notFound, HttpError } from '../http.ts';
import { one, run } from '../db.ts';
import { config, megabytes } from '../config.ts';
import { log, track } from '../telemetry.ts';

/** Every call names its API version, so a change to the account's default does not change what comes back. */
const STRIPE_VERSION = '2025-03-31.basil';

/** Statuses in which the company has a subscription it should manage rather than start again. */
const LIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

const notSetUp = () => new HttpError(503, 'Billing is not set up on this server yet.');

async function stripe(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}, idempotencyKey?: string): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw notSetUp();
  const form = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && form ? `?${form}` : ''}`, {
    method, signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION, 'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: method === 'POST' ? form : undefined,
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`Stripe ${method} ${path} answered ${res.status}: ${data?.error?.message ?? 'no message'}`);
  return data;
}

/** The event, once its Stripe-Signature header proves Stripe sent it in the last five minutes. */
export function verifiedEvent(raw: Buffer, header: string, secret: string, now = Date.now()): any {
  const pairs = header.split(',').map((p) => p.trim().split('='));
  const t = pairs.find(([k]) => k === 't')?.[1];
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const signed = pairs.some(([k, v]) => {
    if (k !== 'v1' || !v) return false;
    const given = Buffer.from(v, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!t || !signed || Math.abs(now / 1000 - Number(t)) > 300) throw badRequest('The Stripe signature does not check out.');
  return JSON.parse(raw.toString('utf8'));
}

/**
 * Copies a subscription as Stripe has it now onto its company. Events arrive late,
 * twice and out of order, so the event's own copy is not trusted to be current.
 * A company's earlier subscription, ended, never overwrites the one it has now.
 */
async function sync(subscriptionId: string, companyId: string | null): Promise<void> {
  const sub = await stripe('GET', `/subscriptions/${subscriptionId}`);
  const id = companyId ?? sub.metadata?.companyId
    ?? (await one<{ id: string }>('SELECT id FROM companies WHERE stripe_customer_id = ?', sub.customer))?.id;
  if (!id) { log('warn', 'Stripe subscription for no known company', { subscriptionId, customer: sub.customer }); return; }
  const end = sub.items?.data?.[0]?.current_period_end;
  const changed = await run(
    `UPDATE companies SET stripe_customer_id = ?, stripe_subscription_id = ?, billing_status = ?, billing_period_end = ?
     WHERE id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ? OR billing_status NOT IN (${LIVE.map(() => '?').join(', ')}))`,
    sub.customer, sub.id, sub.status, end ? new Date(end * 1000).toISOString() : null, id, sub.id, ...LIVE,
  );
  if (changed) log('info', 'Billing status', { companyId: id, status: sub.status, subscriptionId });
}

/**
 * Sends an administrator to Checkout. Until Stripe's webhook says the company
 * subscribed, every Checkout session could be paid, so a company has one at a
 * time: the session still open is handed out again (another tab, another admin,
 * a retry), under the company's lock, which this route holds like every write.
 */
route.post('/api/c/:cid/billing/checkout', 'admin', async (ctx) => {
  const { priceId } = config().billing;
  if (!priceId) throw notSetUp();
  const company = await one<{ stripe_customer_id: string | null; billing_status: string | null; stripe_checkout_session_id: string | null }>(
    'SELECT stripe_customer_id, billing_status, stripe_checkout_session_id FROM companies WHERE id = ?', ctx.companyId);
  if (!company) throw notFound('Company not found.');
  if (company.billing_status && LIVE.includes(company.billing_status)) throw badRequest('This company already has a subscription. Manage it from the billing portal.');
  const previous = company.stripe_checkout_session_id;
  if (previous) {
    const last = await stripe('GET', `/checkout/sessions/${previous}`);
    if (last.status === 'open') return { url: last.url };
    // Paid, and Stripe's webhook not in yet: a new session now would be a second subscription.
    if (last.status === 'complete' && !company.billing_status) throw badRequest('Your payment went through and the subscription is being set up. Refresh in a minute.');
  }
  const back = `${config().app.url}/company`;
  // The key makes a retry of this very call, after a lost answer, return the session Stripe already made.
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: ctx.companyId!,
    'subscription_data[metadata][companyId]': ctx.companyId!,
    ...(company.stripe_customer_id ? { customer: company.stripe_customer_id } : { customer_email: ctx.user!.email }),
    allow_promotion_codes: 'true',
    success_url: `${back}?billing=done#billing`,
    cancel_url: `${back}#billing`,
  }, `checkout-${ctx.companyId}-${previous ?? 'first'}-${ctx.user!.id}`);
  await run('UPDATE companies SET stripe_checkout_session_id = ? WHERE id = ?', session.id, ctx.companyId);
  track(ctx.user!.id, 'billing_checkout_started', { companyId: ctx.companyId });
  return { url: session.url };
});

route.post('/api/c/:cid/billing/portal', 'admin', async (ctx) => {
  const company = await one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM companies WHERE id = ?', ctx.companyId);
  if (!company?.stripe_customer_id) throw badRequest('This company has no subscription yet.');
  const session = await stripe('POST', '/billing_portal/sessions', {
    customer: company.stripe_customer_id, return_url: `${config().app.url}/company#billing`,
  });
  return { url: session.url };
}, { unlocked: true });

route.post('/api/billing/webhook', 'public', async (ctx) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw notSetUp();
  const event = verifiedEvent(ctx.rawBody!, String(ctx.req.headers['stripe-signature'] ?? ''), secret);
  const object = event.data?.object ?? {};
  if (event.type === 'checkout.session.completed' && object.subscription) await sync(object.subscription, object.client_reference_id ?? null);
  else if (String(event.type).startsWith('customer.subscription.')) await sync(object.id, null);
  return { received: true };
}, { raw: true, maxBytes: megabytes(1) });
