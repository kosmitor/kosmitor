/**
 * Independent SAFE and priced-round solver, written from the YC Post-Money Safe
 * User Guide (Feb 2023) and the YC pre-money safe, not from src/. It imports no
 * engine code: plain dollars and real-valued shares, rounded only by the caller.
 *
 *  - Post-money safe: Company Capitalization includes every converting security
 *    and excludes the round's new shares and pool increase (guide p.12-13).
 *  - Pre-money safe: the capitalization includes the pool increase and excludes
 *    all safes and notes (guide p.25-26).
 *  - Series price p = preMoney / (pre-round FD + conversion shares + pool increase)
 *    (guide p.20, p.26); the pool target is unissued pool after = t x post-round FD (p.19).
 *
 * The engine starts with every cap and drops the ones the round price beats. This
 * solves by bisection on T instead: the right-hand side of
 *   T = base + Σ max(a·T/c, a/f)
 * has slope Σ a/c < 1, so the root is unique and bisection cannot miss it.
 */

export interface RefPostSafe {
  amount: number;            // dollars, principal plus any interest
  cap: number | null;        // post-money valuation cap, dollars
  /** Price the safe converts at when its cap does not bind: round price x (1 - discount). */
  fixedPrice: number;
}

/** The unique Company Capitalization T and each post-money safe's real-valued shares. */
export function refPostMoneySafes(base: number, safes: RefPostSafe[]): { T: number; shares: number[] } {
  const g = (T: number) => base + safes.reduce((s, x) => s + Math.max(x.cap ? x.amount * T / x.cap : 0, x.amount / x.fixedPrice), 0);
  let lo = base, hi = base;
  while (g(hi) > hi) hi *= 2;
  for (let i = 0; i < 300; i++) { const mid = (lo + hi) / 2; if (g(mid) > mid) lo = mid; else hi = mid; }
  const T = (lo + hi) / 2;
  return { T, shares: safes.map((x) => Math.max(x.cap ? x.amount * T / x.cap : 0, x.amount / x.fixedPrice)) };
}

export interface RefSafe { amount: number; cap: number | null; discount: number; kind: 'POST' | 'PRE' }

export interface RefRound {
  baseFD: number;            // pre-round fully diluted, including the existing unissued pool
  poolAvailable: number;     // existing unissued pool
  preMoney: number;          // dollars
  raise: number;             // dollars of new money
  targetPool: number;        // 0..1 of post-round FD
  safes: RefSafe[];
  poolFromPreMoney?: boolean; // default true
}

export interface RefRoundResult {
  poolIncrease: number;
  price: number;
  companyCapitalization: number;
  preShares: number[];
  postShares: number[];
  newShares: number;
  postFD: number;
}

/**
 * Bisection on the pool increase, with an inner fixed point on the price, all in
 * full precision. Returns real-valued shares; floor them to compare with a cap table.
 */
export function refRound(r: RefRound): RefRoundResult {
  const fromPre = r.poolFromPreMoney !== false;
  const inner = (inc: number) => {
    let p = r.preMoney / r.baseFD;
    let T = r.baseFD, pre: number[] = [], post: number[] = [];
    for (let k = 0; k < 5000; k++) {
      const preCapBase = r.baseFD + inc;
      pre = r.safes.map((s) => s.kind !== 'PRE' ? 0 : s.amount / Math.min(s.cap ? s.cap / preCapBase : Infinity, p * (1 - s.discount)));
      const preTotal = pre.reduce((a, b) => a + b, 0);
      const posts = r.safes.filter((s) => s.kind === 'POST');
      const sol = refPostMoneySafes(r.baseFD + preTotal, posts.map((s) => ({ amount: s.amount, cap: s.cap, fixedPrice: p * (1 - s.discount) })));
      let j = 0;
      post = r.safes.map((s) => s.kind === 'POST' ? sol.shares[j++] : 0);
      T = sol.T;
      const np = r.preMoney / (fromPre ? T + inc : T);
      if (Math.abs(np - p) < 1e-15) { p = np; break; }
      p = np;
    }
    return { p, T, pre, post };
  };
  const h = (inc: number) => { const s = inner(inc); return r.poolAvailable + inc - r.targetPool * (s.T + inc + r.raise / s.p); };
  let inc = 0;
  if (r.targetPool > 0 && h(0) < 0) {
    let lo = 0, hi = r.baseFD;
    while (h(hi) < 0) hi *= 2;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (h(mid) < 0) lo = mid; else hi = mid; }
    inc = (lo + hi) / 2;
  }
  const s = inner(inc);
  const newShares = r.raise / s.p;
  return {
    poolIncrease: inc, price: s.p, companyCapitalization: s.T, preShares: s.pre, postShares: s.post,
    newShares, postFD: s.T + inc + newShares,
  };
}
