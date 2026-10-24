import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billingAmount, billingInterval, stripeUrl } from '../src/billing-format.ts';

test('formats billing amounts using the currency minor units', () => {
  assert.equal(billingAmount(1299, 'usd'), '$12.99');
  assert.equal(billingAmount(1200, 'jpy'), '¥1,200');
  assert.equal(billingAmount(1234, 'kwd'), 'KWD\u00a01.234');
  assert.equal(billingAmount(0, 'eur'), '€0.00');
  assert.equal(billingAmount(500, 'isk'), 'ISK\u00a05');
  assert.equal(billingAmount(500, 'ugx'), 'UGX\u00a05');
});

test('states the actual recurring interval', () => {
  assert.equal(billingInterval('month', 1), 'per month');
  assert.equal(billingInterval('month', 3), 'every 3 months');
  assert.equal(billingInterval('year', 1), 'per year');
});

test('allows only Stripe hosted checkout or billing portal destinations', () => {
  assert.equal(stripeUrl('https://checkout.stripe.com/c/pay/cs_test_123'), 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.equal(stripeUrl('https://billing.stripe.com/p/session/test_123'), 'https://billing.stripe.com/p/session/test_123');
  for (const url of ['http://checkout.stripe.com/pay', 'https://checkout.stripe.com.evil.test/pay', 'https://evil.test/pay', 'javascript:alert(1)', '//checkout.stripe.com/pay', 'https://user:pass@checkout.stripe.com/pay', 'https://checkout.stripe.com:444/pay']) {
    assert.throws(() => stripeUrl(url), `refuses ${url}`);
  }
});

test('allows completed checkout returns only to known pages on this app origin', () => {
  const origin = 'https://app.example.com';
  const returned = `${origin}/compliance/409a?checkout=success&company=c_123&request_id=r_123`;
  assert.equal(stripeUrl(returned, origin), returned);
  assert.equal(stripeUrl(`${origin}/billing?checkout=success`, origin), `${origin}/billing?checkout=success`);
  assert.throws(() => stripeUrl('https://other.example.com/billing', origin));
  assert.throws(() => stripeUrl(`${origin}/reset-password`, origin));
  assert.throws(() => stripeUrl(returned));
});
