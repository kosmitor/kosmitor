/** Stripe's SDK owns transport retries and webhook signature verification. */
import Stripe from 'stripe';
import { HttpError } from './http.ts';

const unavailable = () => new HttpError(503, 'Payments are temporarily unavailable. Please try again.', {
  code: 'payment-unavailable', retryable: true,
});
const invalidEvent = () => new HttpError(400, 'Invalid payment webhook.');
const secretKey = () => process.env.STRIPE_SECRET_KEY?.trim() ?? '';
const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';

let cached: { key: string; client: Stripe } | null = null;

/** Lazy initialization lets servers without billing configured keep running. */
export function stripeClient(): Stripe {
  const key = secretKey();
  if (!key) {
    cached = null;
    throw unavailable();
  }
  if (cached?.key === key) return cached.client;
  try {
    const client = new Stripe(key, { maxNetworkRetries: 2, timeout: 10_000, telemetry: false });
    cached = { key, client };
    return client;
  } catch {
    cached = null;
    throw unavailable();
  }
}

/** Both credentials are needed before checkout can safely accept a payment. */
export function stripeConfigured(): boolean {
  return !!secretKey() && !!webhookSecret();
}

/** Verify the original bytes; parsing or serializing the body changes its signature. */
export function verifyStripeEvent(rawBody: Buffer, signature: string | string[] | undefined): Stripe.Event {
  const secret = webhookSecret();
  if (!secret) throw unavailable();
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !signature.trim()) throw invalidEvent();
  const client = stripeClient();
  try {
    // Multiple v1 signatures in one header are handled by Stripe during rotation.
    return client.webhooks.constructEvent(rawBody, signature, secret, 300);
  } catch {
    // SDK errors can contain the signature and raw payload; never expose them.
    throw invalidEvent();
  }
}

/** Never pass a provider error, response body, request headers or key to the caller. */
export async function stripeCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw unavailable();
  }
}

/** Only Stripe-hosted pages may be returned as a checkout or billing portal redirect. */
export function hostedStripeUrl(url: unknown, kind: 'checkout' | 'portal'): string {
  if (typeof url !== 'string' || !url || url !== url.trim() || /[\x00-\x20\x7f\\]/.test(url)) throw unavailable();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw unavailable(); }
  const host = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
  if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.username || parsed.password || parsed.port) throw unavailable();
  return parsed.href;
}
