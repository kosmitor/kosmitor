/** No request reaches Stripe: signatures are local and API methods are stubbed. */
import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDatabase } from './helpers.ts';

const API_KEY = 'sk_test_unit_fixture_not_a_real_key';
const WEBHOOK_SECRET = 'whsec_unit_fixture_not_a_real_secret';
const saved = { key: process.env.STRIPE_SECRET_KEY, webhook: process.env.STRIPE_WEBHOOK_SECRET };
process.env.STRIPE_SECRET_KEY = API_KEY;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';

// HttpError lives in http.ts, which imports the database. Bind it to the normal
// isolated test database before importing src, even though these tests are pure.
await freshDatabase();
const { HttpError } = await import('../src/http.ts');
const { stripeClient, stripeConfigured, verifyStripeEvent, stripeCall, hostedStripeUrl } = await import('../src/stripe.ts');

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = API_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});
afterEach(() => mock.restoreAll());
after(() => {
  if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
  if (saved.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = saved.webhook;
});

const event = { id: 'evt_local_test', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_test_local', payment_status: 'paid' } } };
const payload = Buffer.from(JSON.stringify(event));
const seconds = () => Math.floor(Date.now() / 1000);
function signature(body = payload, timestamp = seconds(), secret = WEBHOOK_SECRET): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}
function sanitized(status: number, ...privateValues: string[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, status);
    assert.equal(error.cause, undefined, 'the provider error is not retained as a cause');
    const visible = `${String(error)}\n${error.stack}\n${JSON.stringify(error)}`;
    for (const secret of [API_KEY, WEBHOOK_SECRET, ...privateValues]) assert.ok(!visible.includes(secret), 'private provider values stay out of errors');
    if (status === 503) assert.deepEqual(error.detail, { code: 'payment-unavailable', retryable: true });
    return true;
  };
}

test('billing is configured only with both nonempty credentials', () => {
  assert.equal(stripeConfigured(), true);
  process.env.STRIPE_SECRET_KEY = '';
  assert.equal(stripeConfigured(), false);
  process.env.STRIPE_SECRET_KEY = API_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = ' \n ';
  assert.equal(stripeConfigured(), false);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal(stripeConfigured(), false);
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = '  ';
  assert.equal(stripeConfigured(), false);
});

test('the client is cached by key, rotates with the key and cannot reuse a key after it is removed', () => {
  const first = stripeClient();
  assert.strictEqual(stripeClient(), first);
  process.env.STRIPE_SECRET_KEY = ` ${API_KEY} `;
  assert.strictEqual(stripeClient(), first, 'surrounding whitespace is ignored');
  process.env.STRIPE_SECRET_KEY = 'sk_test_another_unit_fixture';
  assert.notStrictEqual(stripeClient(), first);
  delete process.env.STRIPE_SECRET_KEY;
  assert.throws(() => stripeClient(), sanitized(503));
  process.env.STRIPE_SECRET_KEY = API_KEY;
  assert.notStrictEqual(stripeClient(), first, 'removing configuration discards the cached client');
});

test('webhook verification uses the original bytes and returns the verified event', () => {
  assert.deepEqual(verifyStripeEvent(payload, signature()), event);
  const spaced = Buffer.from(JSON.stringify(event, null, 2));
  assert.deepEqual(verifyStripeEvent(spaced, signature(spaced)), event);
  assert.throws(() => verifyStripeEvent(spaced, signature(payload)), sanitized(400), 'equivalent JSON with different bytes does not share a signature');
});

test('tampered payloads, wrong signing secrets and unsigned or malformed headers are rejected without echoing them', () => {
  const originalSignature = signature();
  const changed = Buffer.from(payload.toString().replace('"paid"', '"unpaid"'));
  assert.throws(() => verifyStripeEvent(changed, originalSignature), sanitized(400, originalSignature, changed.toString()));
  const wrong = signature(payload, seconds(), 'whsec_wrong_fixture');
  assert.throws(() => verifyStripeEvent(payload, wrong), sanitized(400, wrong));
  for (const header of [undefined, '', ' ', 'not-a-signature', 'v1=abc', `t=${seconds()},v0=abc`, [], [originalSignature]]) {
    assert.throws(() => verifyStripeEvent(payload, header), sanitized(400));
  }
});

test('the SDK rejects signatures older than five minutes, including one just beyond the tolerance', () => {
  const now = 1_800_000_000_000;
  mock.method(Date, 'now', () => now);
  assert.deepEqual(verifyStripeEvent(payload, signature(payload, now / 1000 - 299)), event);
  for (const age of [301, 3600]) {
    const old = signature(payload, now / 1000 - age);
    assert.throws(() => verifyStripeEvent(payload, old), sanitized(400, old));
  }
});

test('one valid v1 signature among several is accepted for secret rotation; old-version signatures alone are not', () => {
  const signed = signature();
  const mac = signed.split('v1=')[1];
  assert.deepEqual(verifyStripeEvent(payload, `${signed},v1=${'0'.repeat(64)},v0=legacy`), event);
  assert.deepEqual(verifyStripeEvent(payload, `t=${seconds()},v1=${'0'.repeat(64)},v1=${mac}`), event);
  assert.throws(() => verifyStripeEvent(payload, `t=${seconds()},v0=${mac}`), sanitized(400));
});

test('webhook secret rotation is read on each verification and missing credentials stay a retryable configuration failure', () => {
  const oldSignature = signature();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_rotated_unit_fixture';
  assert.throws(() => verifyStripeEvent(payload, oldSignature), sanitized(400, oldSignature));
  assert.deepEqual(verifyStripeEvent(payload, signature(payload, seconds(), process.env.STRIPE_WEBHOOK_SECRET)), event);
  process.env.STRIPE_WEBHOOK_SECRET = '';
  assert.throws(() => verifyStripeEvent(payload, oldSignature), sanitized(503));
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = '';
  assert.throws(() => verifyStripeEvent(payload, oldSignature), sanitized(503));
});

test('malformed JSON with an otherwise valid signature receives the same sanitized webhook error', () => {
  const malformed = Buffer.from(`{"sensitive":"${WEBHOOK_SECRET}",`);
  assert.throws(() => verifyStripeEvent(malformed, signature(malformed)), sanitized(400));
});

test('successful Stripe calls return the SDK result unchanged and can be stubbed without any network', async () => {
  const client = stripeClient();
  const answer = { id: 'cs_test_local', url: 'https://checkout.stripe.com/c/pay/cs_test_local' };
  const create = mock.method(client.checkout.sessions, 'create', async () => answer);
  const result = await stripeCall(() => client.checkout.sessions.create({ mode: 'payment' }));
  assert.strictEqual(result, answer);
  assert.equal(create.mock.callCount(), 1);
});

test('provider errors and synchronous failures become retryable errors without logging or exposing provider data', async () => {
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  const errorLog = mock.method(console, 'error', () => {});
  const privateUrl = `https://provider.example.test/?key=${API_KEY}`;
  const providerError = Object.assign(new Error(`Rejected ${API_KEY} ${WEBHOOK_SECRET}`), {
    statusCode: 401, raw: { api_key: API_KEY }, headers: { authorization: API_KEY }, requestId: privateUrl,
  });
  const client = stripeClient();
  mock.method(client.checkout.sessions, 'create', async () => { throw providerError; });
  await assert.rejects(stripeCall(() => client.checkout.sessions.create({ mode: 'payment' })), sanitized(503, privateUrl));
  await assert.rejects(stripeCall(() => { throw providerError; }), sanitized(503, privateUrl));
  await assert.rejects(stripeCall(async () => { throw WEBHOOK_SECRET; }), sanitized(503));
  assert.equal(log.mock.callCount() + warn.mock.callCount() + errorLog.mock.callCount(), 0);
});

test('redirects accept only Stripe-hosted HTTPS checkout and portal pages', () => {
  const checkout = 'https://checkout.stripe.com/c/pay/cs_test_local#session-data';
  const portal = 'https://billing.stripe.com/p/session/test_local?locale=en';
  assert.equal(hostedStripeUrl(checkout, 'checkout'), checkout);
  assert.equal(hostedStripeUrl(portal, 'portal'), portal);
  assert.throws(() => hostedStripeUrl(portal, 'checkout'), sanitized(503));
  assert.throws(() => hostedStripeUrl(checkout, 'portal'), sanitized(503));
  for (const url of [null, undefined, '', '/checkout', '//checkout.stripe.com/pay', 'javascript:alert(1)',
    'http://checkout.stripe.com/pay', 'https://checkout.stripe.com.evil.example/pay',
    'https://checkout.stripe.com@evil.example/pay', 'https://evil.example@checkout.stripe.com/pay',
    'https://checkout.stripe.com:444/pay', 'https://checkout.stripe.com./pay',
    'https://checkout.stripe.com\\@evil.example/pay', ' https://checkout.stripe.com/pay',
    'https://checkout.stripe.com/pay\n', 'https://billing.stripe.com.evil.example/session']) {
    assert.throws(() => hostedStripeUrl(url, 'checkout'), sanitized(503));
  }
});
