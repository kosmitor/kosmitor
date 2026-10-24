/** Stripe owns card details. Local records own tenant binding and fulfillment. */
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { all, one, run, insert, update, transaction } from '../db.ts';
import { route, HttpError, badRequest, notFound, audit, type Ctx } from '../http.ts';
import { stripeClient, stripeConfigured, stripeCall, verifyStripeEvent, hostedStripeUrl } from '../stripe.ts';

interface Checkout {
  id: string; company_id: string; kind: 'subscription' | 'valuation'; request_id: string | null;
  price_id: string; plan_name: string; stripe_session_id: string | null; stripe_payment_intent_id: string | null;
  status: string; amount: number | string; currency: string; created_at: string; expires_at: number | string;
  paid_at: string | null; refunded_amount: number | string;
}
interface Valuation { id: string; status: string; payment_required: boolean; payment_status: string; payment_price_id: string | null }
const now = () => new Date().toISOString();
const activeSubscription = "status NOT IN ('canceled', 'incomplete_expired')";
const objectId = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
const unavailable = () => new HttpError(503, 'Payments are not available right now. Please try again later.');
function requireBilling(): void {
  if (!config().billing.enabled || !stripeConfigured()) throw unavailable();
}
async function locked<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  return transaction(async () => {
    if (!await one('SELECT id FROM companies WHERE id = ? FOR UPDATE', companyId)) throw notFound();
    return work();
  });
}
function returnUrl(kind: Checkout['kind'], companyId: string, requestId: string | null, outcome: string): string {
  const url = new URL(kind === 'subscription' ? '/billing' : '/compliance/409a', config().app.url);
  url.searchParams.set('company', companyId);
  url.searchParams.set('checkout', outcome);
  if (requestId) url.searchParams.set('request_id', requestId);
  return url.toString() + (outcome === 'success' ? '&session_id={CHECKOUT_SESSION_ID}' : '');
}
async function priceInfo(id: string, kind: Checkout['kind']) {
  const price = await stripeCall(() => stripeClient().prices.retrieve(id));
  if (!price.active || price.billing_scheme !== 'per_unit' || !Number.isSafeInteger(price.unit_amount) || !price.unit_amount || price.unit_amount < 0
    || (kind === 'subscription' ? price.type !== 'recurring' || price.recurring?.usage_type !== 'licensed' : price.type !== 'one_time')) throw unavailable();
  return { amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? null, intervalCount: price.recurring?.interval_count ?? null };
}
async function customer(companyId: string): Promise<string> {
  const existing = await locked(companyId, async () => {
    await run('INSERT INTO billing_accounts (company_id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING', companyId, now());
    return one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', companyId);
  });
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;
  // Stable parameters and key across parallel calls and retries after a crash.
  const created = await stripeCall(() => stripeClient().customers.create({ metadata: { companyId } }, { idempotencyKey: `kosmitor-customer-${companyId}` }));
  return locked(companyId, async () => {
    await run('UPDATE billing_accounts SET stripe_customer_id = ? WHERE company_id = ? AND stripe_customer_id IS NULL', created.id, companyId);
    return (await one<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', companyId))!.stripe_customer_id;
  });
}
async function valuation(companyId: string, id: string): Promise<Valuation> {
  const row = await one<Valuation>('SELECT id, status, payment_required, payment_status, payment_price_id FROM valuation_requests WHERE company_id = ? AND id = ?', companyId, id);
  if (!row) throw notFound('That 409A request does not exist.');
  return row;
}
function payable(row: Valuation): void {
  if (row.status !== 'REQUESTED' || !row.payment_required || row.payment_status !== 'unpaid') throw badRequest('This request does not need a payment.');
}
async function checkout(ctx: Ctx, kind: Checkout['kind']) {
  requireBilling();
  const companyId = ctx.companyId!;
  const requestId = kind === 'valuation' ? ctx.params.id : null;
  const plan = kind === 'subscription' ? config().billing.subscriptionPlans.find(p => p.key === ctx.body.planKey) : null;
  const request = requestId ? await valuation(companyId, requestId) : null;
  if (request) payable(request);
  const priceId = request?.payment_price_id ?? plan?.priceId;
  if (!priceId) throw badRequest('Choose an available payment plan.');
  const quoted = await priceInfo(priceId, kind);
  const customerId = await customer(companyId);
  let attempt = await locked(companyId, async () => {
    if (requestId) payable(await valuation(companyId, requestId));
    else if (await one(`SELECT id FROM billing_subscriptions WHERE company_id = ? AND ${activeSubscription} LIMIT 1`, companyId)) {
      throw badRequest('This company already has a subscription. Use Manage billing to change it.');
    }
    const pending = await one<Checkout>(`SELECT * FROM billing_checkouts WHERE company_id = ? AND kind = ? AND ${requestId ? 'request_id = ?' : 'request_id IS NULL'} AND status IN ('pending', 'processing')`, companyId, kind, ...(requestId ? [requestId] : []));
    if (pending) {
      if (pending.price_id !== priceId) throw badRequest('A checkout for another plan is still open. Complete it or wait for it to expire before choosing another plan.');
      return pending;
    }
    const id = `bco_${randomUUID()}`;
    await insert('billing_checkouts', { id, companyId, kind, requestId, priceId, planName: plan?.name ?? '409A valuation', amount: quoted.amount,
      currency: quoted.currency, createdAt: now(), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await audit(ctx, 'CHECKOUT', 'billing_checkouts', id, kind === 'subscription' ? 'Subscription checkout started' : '409A payment checkout started');
    return (await one<Checkout>('SELECT * FROM billing_checkouts WHERE id = ?', id))!;
  });
  // A crash can occur after Stripe accepts the operation but before its ID is
  // saved locally. Recover it by our committed reference before minting anything.
  if (!attempt.stripe_session_id && Date.now() - Date.parse(attempt.created_at) > 5 * 60_000) {
    const sessions = await stripeCall(() => stripeClient().checkout.sessions.list({ customer: customerId,
      created: { gte: Math.floor(Date.parse(attempt.created_at) / 1000) - 60 }, limit: 100 }));
    const recovered = sessions.data.find(s => s.client_reference_id === attempt.id && s.metadata?.checkoutId === attempt.id);
    if (recovered) {
      await locked(companyId, () => update('billing_checkouts', attempt.id, { stripeSessionId: recovered.id }));
      attempt = { ...attempt, stripe_session_id: recovered.id };
    } else if (!sessions.has_more && Number(attempt.expires_at) + 300 < Date.now() / 1000) {
      await locked(companyId, () => run("UPDATE billing_checkouts SET status = 'expired' WHERE id = ? AND status = 'pending' AND stripe_session_id IS NULL", attempt.id));
      return checkout(ctx, kind);
    }
  }
  if (attempt.stripe_session_id) {
    const session = await stripeCall(() => stripeClient().checkout.sessions.retrieve(attempt.stripe_session_id!));
    if (session.status === 'open' && session.url) return { url: hostedStripeUrl(session.url, 'checkout') };
    await fulfillSession(session.id);
    if (session.status !== 'expired') return { url: returnUrl(kind, companyId, requestId, 'success').replace('{CHECKOUT_SESSION_ID}', encodeURIComponent(session.id)) };
    // Expiration is confirmed by Stripe before we allow another payment attempt.
    return checkout(ctx, kind);
  }
  // If a previous call timed out, retry the exact payload and key. Keep the
  // operation for reconciliation rather than risk a second charge on uncertainty.
  if (Number(attempt.expires_at) < Math.floor(Date.now() / 1000) + 1800) throw new HttpError(409, 'This checkout is still being reconciled. Please try again later or contact support.');
  const session = await stripeCall(() => stripeClient().checkout.sessions.create({
    mode: kind === 'subscription' ? 'subscription' : 'payment', customer: customerId,
    adaptive_pricing: { enabled: false },
    client_reference_id: attempt.id, metadata: { checkoutId: attempt.id, companyId },
    line_items: [{ price: attempt.price_id, quantity: 1 }],
    success_url: returnUrl(kind, companyId, requestId, 'success'), cancel_url: returnUrl(kind, companyId, requestId, 'cancel'),
    expires_at: Number(attempt.expires_at),
    ...(kind === 'subscription' ? { subscription_data: { metadata: { companyId } } } : { payment_intent_data: { metadata: { companyId, checkoutId: attempt.id } } }),
  }, { idempotencyKey: attempt.id }));
  await locked(companyId, async () => {
    await run('UPDATE billing_checkouts SET stripe_session_id = ? WHERE id = ? AND (stripe_session_id IS NULL OR stripe_session_id = ?)', session.id, attempt.id, session.id);
  });
  if (requestId && (await valuation(companyId, requestId)).status !== 'REQUESTED' && session.status === 'open') {
    await stripeCall(() => stripeClient().checkout.sessions.expire(session.id));
    throw badRequest('This request closed while checkout was being prepared.');
  }
  return { url: hostedStripeUrl(session.url, 'checkout') };
}

/** Called under the company lock; retrieve current state so an old event cannot regress a subscription. */
async function syncSubscription(id: string, companyId: string): Promise<void> {
  const sub = await stripeCall(() => stripeClient().subscriptions.retrieve(id));
  const account = await one<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', companyId);
  if (objectId(sub.customer) !== account?.stripe_customer_id) throw badRequest('Subscription does not belong to this company.');
  const item = sub.items.data[0];
  if (!item) throw badRequest('Subscription has no price.');
  const previous = await one<{ plan_name: string }>('SELECT plan_name FROM billing_subscriptions WHERE id = ?', id);
  const configured = config().billing.subscriptionPlans.find(p => p.priceId === item.price.id);
  const planName = configured?.name ?? previous?.plan_name ?? 'Subscription';
  await run(`INSERT INTO billing_subscriptions (id, company_id, price_id, plan_name, status, current_period_end, cancel_at_period_end, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET price_id = EXCLUDED.price_id, plan_name = EXCLUDED.plan_name,
    status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = EXCLUDED.updated_at`,
  sub.id, companyId, item.price.id, planName, sub.status, item.current_period_end, sub.cancel_at_period_end, now());
}

/** Never trust the browser's success redirect or an event's stale payment snapshot. */
async function fulfillSession(id: string): Promise<Checkout | undefined> {
  const session = await stripeCall(() => stripeClient().checkout.sessions.retrieve(id, { expand: ['line_items'] }));
  const found = await one<Checkout>('SELECT * FROM billing_checkouts WHERE stripe_session_id = ? OR id = ?', session.id, session.metadata?.checkoutId ?? '');
  if (!found) return undefined; // A different Stripe product in the same account.
  return locked(found.company_id, async () => {
    const row = (await one<Checkout>('SELECT * FROM billing_checkouts WHERE id = ?', found.id))!;
    const account = await one<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', row.company_id);
    const line = session.line_items?.data[0];
    if (session.client_reference_id !== row.id || session.metadata?.checkoutId !== row.id || session.metadata?.companyId !== row.company_id
      || objectId(session.customer) !== account?.stripe_customer_id || session.mode !== (row.kind === 'subscription' ? 'subscription' : 'payment')
      || (row.stripe_session_id && row.stripe_session_id !== session.id)
      || !line || session.line_items?.has_more || session.line_items?.data.length !== 1 || line.price?.id !== row.price_id || line.quantity !== 1
      || session.currency !== row.currency || session.amount_total !== Number(row.amount) || session.amount_subtotal !== Number(row.amount)) {
      throw badRequest('Payment details do not match this checkout.');
    }
    const sessionIntentId = objectId(session.payment_intent);
    await update('billing_checkouts', row.id, { stripeSessionId: session.id,
      ...(sessionIntentId ? { stripePaymentIntentId: sessionIntentId } : {}) });
    if (session.status === 'complete' && (session.payment_status === 'paid'
      || (row.kind === 'subscription' && session.payment_status === 'no_payment_required'))) {
      let intentId = sessionIntentId;
      let paidAmount = Number(row.amount);
      const subscriptionId = objectId(session.subscription);
      if (row.kind === 'subscription') {
        // Subscription Checkout has no payment_intent. Its first invoice owns
        // that payment, including any customer credit applied before charging.
        const invoiceId = objectId(session.invoice);
        if (!invoiceId || !subscriptionId) throw badRequest('Subscription payment confirmation is missing.');
        const invoice = await stripeCall(() => stripeClient().invoices.retrieve(invoiceId, { expand: ['payments'] }));
        if (invoice.id !== invoiceId || objectId(invoice.customer) !== account?.stripe_customer_id
          || objectId(invoice.parent?.subscription_details?.subscription) !== subscriptionId
          || invoice.status !== 'paid' || invoice.currency !== row.currency
          || invoice.subtotal !== Number(row.amount) || invoice.total !== Number(row.amount)
          || invoice.amount_remaining !== 0 || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < 0
          || invoice.amount_paid !== invoice.amount_due) throw badRequest('Invoice details do not match this checkout.');
        if (!invoice.payments || invoice.payments.has_more) throw unavailable();
        const payments = invoice.payments.data.filter(p => p.status === 'paid');
        const payment = payments.find(p => p.is_default) ?? (payments.length === 1 ? payments[0] : undefined);
        paidAmount = invoice.amount_paid;
        intentId = payment ? objectId(payment.payment.payment_intent) : null;
        if (payment && (objectId(payment.invoice) !== invoiceId || payment.currency !== row.currency
          || payment.amount_paid !== paidAmount || payment.payment.type !== 'payment_intent' || !intentId)) {
          throw badRequest('Invoice payment details do not match this checkout.');
        }
        if (!intentId && paidAmount !== 0) throw unavailable();
      } else if (!intentId) throw badRequest('Payment confirmation is missing.');

      let refunded = Number(row.refunded_amount);
      if (intentId) {
        const paymentIntentId = intentId;
        const intent = await stripeCall(() => stripeClient().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }));
        if (intent.status !== 'succeeded' || intent.amount !== paidAmount || intent.currency !== row.currency
          || objectId(intent.customer) !== account?.stripe_customer_id) throw badRequest('Payment details do not match this checkout.');
        const charge = intent.latest_charge;
        if (!charge || typeof charge === 'string') throw unavailable();
        refunded = Math.max(refunded, charge.amount_refunded);
        await update('billing_checkouts', row.id, { stripePaymentIntentId: intentId, refundedAmount: refunded });
      }
      if (paidAmount > 0 && refunded >= paidAmount) {
        await update('billing_checkouts', row.id, { status: 'refunded', paidAt: row.paid_at ?? now() });
        if (row.request_id) {
          await update('valuation_requests', row.request_id, { paymentStatus: 'refunded', updatedAt: now() });
        }
      } else if (row.status !== 'paid' && row.status !== 'refunded') {
        const paidAt = now();
        await update('billing_checkouts', row.id, { status: 'paid', paidAt });
        if (row.request_id) {
          await update('valuation_requests', row.request_id, { paymentStatus: 'paid', paidAt, updatedAt: paidAt });
          await insert('valuation_request_events', { id: `vre_${randomUUID()}`, requestId: row.request_id, companyId: row.company_id,
            kind: 'PAID', message: 'Payment confirmed by Stripe', author: 'payment', authorName: 'Stripe', createdAt: paidAt });
        }
      }
      // A refund does not cancel the recurring subscription.
      if (row.kind === 'subscription') await syncSubscription(subscriptionId!, row.company_id);
    } else if (!['paid', 'refunded', 'failed'].includes(row.status)) {
      await update('billing_checkouts', row.id, { status: session.status === 'expired' ? 'expired' : session.status === 'complete' ? 'processing' : 'pending' });
    }
    return one<Checkout>('SELECT * FROM billing_checkouts WHERE id = ?', row.id);
  });
}
async function resumeValuation(ctx: Ctx, payment?: Checkout): Promise<void> {
  if (payment?.kind !== 'valuation' || payment.status !== 'paid' || !payment.request_id) return;
  const { sendPaidValuation } = await import('./valuation-requests.ts');
  // Committed payment must survive mail failure. Existing /send remains a retry.
  try { await sendPaidValuation(ctx, payment.company_id, payment.request_id); }
  catch { console.error('[billing] Paid valuation notification needs retry.'); }
}

/** A cancelled request must not leave an open checkout that can still charge. */
export async function closeValuationCheckout(companyId: string, requestId: string): Promise<void> {
  const payment = await one<Checkout>("SELECT * FROM billing_checkouts WHERE company_id = ? AND request_id = ? AND status IN ('pending', 'processing')", companyId, requestId);
  if (!payment) return;
  if (!payment.stripe_session_id) throw new HttpError(409, 'Checkout is still being prepared. Please try closing this request again shortly.');
  let session = await stripeCall(() => stripeClient().checkout.sessions.retrieve(payment.stripe_session_id!));
  if (session.status === 'open') session = await stripeCall(() => stripeClient().checkout.sessions.expire(session.id));
  if (session.status === 'complete' && session.payment_status !== 'paid') throw new HttpError(409, 'A payment is processing. Wait for it to finish before closing this request.');
  await fulfillSession(session.id);
}

route.get('/api/c/:cid/valuation-requests/payment', 'read', async ctx => {
  const request = ctx.query.get('requestId') ? await valuation(ctx.companyId!, ctx.query.get('requestId')!) : null;
  const required = request ? request.payment_required : config().billing.enabled;
  const priceId = request ? request.payment_price_id : config().billing.valuationPriceId;
  if (!required) return { required: false, configured: stripeConfigured(), price: null };
  if (!stripeConfigured() || !priceId || !config().billing.enabled) return { required, configured: false, price: null };
  try { return { required, configured: true, price: await priceInfo(priceId, 'valuation') }; }
  catch { return { required, configured: false, price: null, error: 'Payment pricing is temporarily unavailable. Please try again.' }; }
});
route.get('/api/c/:cid/billing', 'admin', async ctx => {
  ctx.res.setHeader('Cache-Control', 'no-store');
  const account = await one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', ctx.companyId);
  const sub = await one<{ status: string; plan_name: string; current_period_end: number | string | null; cancel_at_period_end: boolean }>(
    `SELECT * FROM billing_subscriptions WHERE company_id = ? ORDER BY CASE WHEN ${activeSubscription} THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`, ctx.companyId);
  const payments = await all<Checkout>('SELECT * FROM billing_checkouts WHERE company_id = ? ORDER BY created_at DESC LIMIT 100', ctx.companyId);
  let plans: unknown[] = [], valuationPrice = null, error: string | undefined;
  if (config().billing.enabled && stripeConfigured()) {
    try {
      plans = await Promise.all(config().billing.subscriptionPlans.map(async p => ({ key: p.key, name: p.name, ...await priceInfo(p.priceId, 'subscription') })));
      if (config().billing.valuationPriceId) valuationPrice = await priceInfo(config().billing.valuationPriceId!, 'valuation');
    } catch { error = 'Payment pricing is temporarily unavailable. Please try again.'; }
  }
  return { enabled: config().billing.enabled, configured: stripeConfigured(), plans, valuationPrice, customerExists: !!account?.stripe_customer_id,
    subscription: sub ? { status: sub.status, planName: sub.plan_name, currentPeriodEnd: sub.current_period_end ? new Date(Number(sub.current_period_end) * 1000).toISOString() : null, cancelAtPeriodEnd: sub.cancel_at_period_end } : null,
    payments: payments.map(p => ({ id: p.id, kind: p.kind, requestId: p.request_id, status: p.status, amount: Number(p.amount), currency: p.currency,
      createdAt: p.created_at, paidAt: p.paid_at, refundedAmount: Number(p.refunded_amount) })), ...(error ? { error } : {}) };
});
route.post('/api/c/:cid/billing/checkout', 'admin', ctx => checkout(ctx, 'subscription'), { unlocked: true });
route.post('/api/c/:cid/valuation-requests/:id/checkout', 'write', ctx => checkout(ctx, 'valuation'), { unlocked: true });
route.post('/api/c/:cid/billing/portal', 'admin', async ctx => {
  if (!stripeConfigured()) throw unavailable(); // Existing customers can cancel even when new purchases are disabled.
  const account = await one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', ctx.companyId);
  if (!account?.stripe_customer_id) throw badRequest('This company has no billing account yet.');
  const url = new URL('/billing', config().app.url); url.searchParams.set('company', ctx.companyId!);
  url.searchParams.set('checkout', 'portal');
  const session = await stripeCall(() => stripeClient().billingPortal.sessions.create({ customer: account.stripe_customer_id!, return_url: url.toString() }));
  return { url: hostedStripeUrl(session.url, 'portal') };
}, { unlocked: true });
async function reconcile(ctx: Ctx, requestId?: string) {
  if (!stripeConfigured()) throw unavailable();
  const sessionId = ctx.body.sessionId;
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw badRequest('Choose a valid checkout session.');
  const payment = await one<Checkout>('SELECT * FROM billing_checkouts WHERE stripe_session_id = ? AND company_id = ?', sessionId, ctx.companyId);
  if (!payment || (requestId && payment.request_id !== requestId)) throw notFound('This checkout does not belong to this request.');
  const updated = await fulfillSession(sessionId);
  await resumeValuation(ctx, updated);
  return { ok: true, status: updated?.status };
}
route.post('/api/c/:cid/billing/reconcile', 'admin', ctx => reconcile(ctx), { unlocked: true });
route.post('/api/c/:cid/valuation-requests/:id/payment/reconcile', 'write', ctx => reconcile(ctx, ctx.params.id), { unlocked: true });

route.post('/api/stripe/webhook', 'public', async ctx => {
  const event = verifyStripeEvent(ctx.rawBody!, ctx.req.headers['stripe-signature']);
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
  if (event.livemode !== /^(sk|rk)_live_/.test(key) || event.account) throw badRequest('Invalid payment webhook.');
  let paid: Checkout | undefined;
  await transaction(async () => {
    // Claim and apply atomically. A failed Stripe/API/DB request rolls the claim back for retry.
    if (!await run('INSERT INTO billing_events (id, type, processed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', event.id, event.type, now())) return;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) {
      const session = event.data.object as Stripe.Checkout.Session;
      paid = await fulfillSession(session.id);
      if (event.type === 'checkout.session.async_payment_failed' && paid && paid.status === 'processing') {
        await update('billing_checkouts', paid.id, { status: 'failed' });
      }
    } else if (event.type.startsWith('customer.subscription.') || ['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
      const object = event.data.object as unknown as { id: string; customer: string | null; parent?: { subscription_details?: { subscription: string | null } | null } | null };
      const account = await one<{ company_id: string }>('SELECT company_id FROM billing_accounts WHERE stripe_customer_id = ?', objectId(object.customer));
      const id = event.type.startsWith('customer.subscription.') ? object.id : objectId(object.parent?.subscription_details?.subscription);
      if (account && id) await locked(account.company_id, () => syncSubscription(id, account.company_id));
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      const intentId = objectId(charge.payment_intent);
      let payment = await one<Checkout>('SELECT * FROM billing_checkouts WHERE stripe_payment_intent_id = ?', intentId);
      if (!payment && intentId) {
        const intent = await stripeCall(() => stripeClient().paymentIntents.retrieve(intentId));
        const candidate = await one<Checkout>('SELECT * FROM billing_checkouts WHERE id = ?', intent.metadata?.checkoutId ?? '');
        if (candidate) {
          const account = await one<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM billing_accounts WHERE company_id = ?', candidate.company_id);
          if (intent.metadata?.companyId === candidate.company_id && objectId(intent.customer) === account?.stripe_customer_id
            && intent.amount === Number(candidate.amount) && intent.currency === candidate.currency) payment = candidate;
        }
      }
      if (payment) await locked(payment.company_id, async () => {
        const current = (await one<Checkout>('SELECT * FROM billing_checkouts WHERE id = ?', payment!.id))!;
        const refunded = Math.max(Number(current.refunded_amount), charge.amount_refunded);
        // Subscription invoices may apply credit, so the cash charge can be
        // smaller than the immutable price quoted for the checkout.
        const charged = current.kind === 'subscription' ? charge.amount : Number(current.amount);
        const fullyRefunded = charged > 0 && refunded >= charged;
        await update('billing_checkouts', current.id, { stripePaymentIntentId: intentId, refundedAmount: refunded, ...(fullyRefunded ? { status: 'refunded' } : {}) });
        if (current.request_id && fullyRefunded) await update('valuation_requests', current.request_id, { paymentStatus: 'refunded', updatedAt: now() });
      });
    }
  });
  // A process may stop after recording payment but before sending its approval
  // notice. Replayed events resume that step using committed state, without ever
  // recording the charge or advancing payment twice.
  if (!paid && event.type.startsWith('checkout.session.')) {
    paid = await one<Checkout>("SELECT * FROM billing_checkouts WHERE stripe_session_id = ? AND kind = 'valuation' AND status = 'paid'", (event.data.object as Stripe.Checkout.Session).id);
  }
  await resumeValuation(ctx, paid);
  return { received: true };
}, { raw: true, maxBytes: 1024 * 1024 });
