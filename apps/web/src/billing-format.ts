/** Stripe amounts are integer minor units, including currencies without decimal places. */
export function billingAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
  // Stripe retains a two-decimal charge representation for these currencies,
  // although their ISO display formats have no decimals.
  const digits = ['ISK', 'UGX'].includes(code) ? 2 : formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / 10 ** digits);
}

export function billingInterval(interval: string, count = 1): string {
  return count === 1 ? `per ${interval}` : `every ${count} ${interval}s`;
}

/** A completed checkout may return directly to the app; otherwise it opens on Stripe. */
export function stripeUrl(value: string, appOrigin?: string): string {
  const url = new URL(value);
  const stripe = url.protocol === 'https:' && ['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname) && !url.port;
  const returned = appOrigin && url.origin === appOrigin && ['/billing', '/compliance/409a'].includes(url.pathname);
  if ((!stripe && !returned) || url.username || url.password) {
    throw new Error('The payment page could not be opened. Please try again.');
  }
  return url.href;
}
