/**
 * Independent Black-Scholes-Merton, written from Hull, "Options, Futures and Other
 * Derivatives" (eqs. 15.20 and 17.4), not from src/. N(x) comes from Simpson
 * integration of the normal density rather than a polynomial approximation, so it
 * cannot share the engine's approximation error.
 */

export function refNormalCdf(x: number): number {
  const f = (t: number) => Math.exp(-t * t / 2) / Math.sqrt(2 * Math.PI);
  const b = Math.abs(x), n = 20_000, h = b / n;
  let s = f(0) + f(b);
  for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  const half = (s * h) / 3;
  return x >= 0 ? 0.5 + half : 0.5 - half;
}

/** European call with a continuous dividend yield q. */
export function refBlackScholesCall(S: number, K: number, T: number, sigma: number, r: number, q = 0): number {
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * Math.exp(-q * T) * refNormalCdf(d1) - K * Math.exp(-r * T) * refNormalCdf(d2);
}
