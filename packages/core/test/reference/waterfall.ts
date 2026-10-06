/**
 * Independent liquidation waterfall, written from the documents, not from src/:
 *  - NVCA Model COI (Oct 2025) s.2.1/2.2: preference by rank, ratable shortfall
 *    within a rank, participation, and the cap footnote (the cap includes the
 *    preference);
 *  - the NVCA footnote on multiple series: a series converts when converting pays it more;
 *  - YC post-money Safe s.1(b), 1(d) and its Liquidity Capitalization definition,
 *    which leaves out Safes that take their Cash-Out Amount and counts a pre-money
 *    Safe that converts (Safe User Guide, Ex.2 Q3).
 *
 * The engine runs a best-response loop over conversion elections. This tries
 * every combination, keeps the stable ones, and splits the residual at one common
 * price P found by bisection on
 *   Σ payout_i(P) = residual,  payout = s·P (common, converted, full participation),
 *   min(s·P, cap − preference paid) (capped participation), n·max(0, P − K) (options).
 * Floating point and dollars throughout; it imports only types.
 */
import type { AwardType, ConvertibleInstrument, DividendType } from '../../src/types.ts';

/** A compact cap table for waterfall cases; builders.ts turns it into CompanyData. */
export interface WaterfallSpec {
  common: { holder: string; shares: number }[];
  prefs?: {
    id: string; name?: string; holder?: string; shares: number; oip: number; mult?: number; seniority?: number;
    part?: 'NP' | 'FP' | 'CP'; cap?: number | null; ratio?: number;
    divRate?: number; divType?: DividendType; divCompound?: boolean; issueDate?: string; convertible?: boolean;
  }[];
  options?: { holder: string; shares: number; strike: number; type?: AwardType }[];
  /** `mfn` adopts the terms of one safe issued after it (issueDate, default 2022-01-01); see refModel. */
  safes?: { id: string; holder: string; amount: number; cap: number | null; instrument?: ConvertibleInstrument; mfn?: boolean; issueDate?: string }[];
  warrants?: { holder: string; shares: number; strike: number }[];
}

export interface RefPref {
  id: string;
  shares: number;            // as-converted
  claim: number;             // preference, dollars
  seniority: number;
  part: 'NP' | 'FP' | 'CP';
  capTotal: number | null;   // total the class may take under a participation cap, dollars
  convertible?: boolean;
}

export interface RefModel {
  common: number;
  prefs: RefPref[];
  options?: { n: number; K: number }[];
  safes?: { id: string; amount: number; cap: number; instrument?: ConvertibleInstrument }[];
  /** Rank a SAFE cash-out takes; defaults to the most senior preferred (YC s.1(d)). */
  safeRank?: number;
  /** Liquidity Capitalization before the converting SAFEs, given which claimants convert. */
  liqBase?: (converted: Set<string>) => number;
}

export interface RefDistribution {
  converted: string[];
  P: number;
  R: number;
  payouts: Record<string, number>;
  safeShares: Record<string, number>;
}

/**
 * The reference model for a spec. The SAFE Liquidity Capitalization counts common,
 * options and every preferred share as converted; whether preferred that takes its
 * preference belongs there is WF-3, an open question for counsel.
 */
export function refModel(spec: WaterfallSpec): RefModel {
  const common = spec.common.reduce((s, c) => s + c.shares, 0);
  const prefs: RefPref[] = (spec.prefs ?? []).map((p) => {
    const shares = p.shares * (p.ratio ?? 1);
    return {
      id: p.id, shares, claim: p.shares * p.oip * (p.mult ?? 1), seniority: p.seniority ?? 1,
      part: p.part ?? 'NP', capTotal: p.cap ? p.shares * p.oip * p.cap : null, convertible: p.convertible,
    };
  });
  const options = (spec.options ?? []).map((o) => ({ n: o.shares, K: o.strike }));
  const optionShares = options.reduce((s, o) => s + o.n, 0);
  const prefShares = prefs.reduce((s, p) => s + p.shares, 0);
  // YC Safe (MFN), "MFN Amendment Provision": the holder may have its safe amended "to be identical to"
  // a later convertible security whose terms it prefers, so it takes one later safe's cap and pre- or
  // post-money basis in full. With no round price, preferable is the lower cap; on equal caps a
  // pre-money one, whose capitalization leaves the safes out.
  const all = spec.safes ?? [];
  const day = (s: (typeof all)[number]) => s.issueDate ?? '2022-01-01';
  const kind = (s: (typeof all)[number]) => (s.instrument === 'SAFE_PRE' ? 0 : 1);
  const better = (a: (typeof all)[number], b: (typeof all)[number]) =>
    (a.cap ?? Infinity) < (b.cap ?? Infinity) || ((a.cap ?? Infinity) === (b.cap ?? Infinity) && kind(a) < kind(b));
  const adopted = all.map((s) => {
    if (!s.mfn) return s;
    let best = s;
    for (const o of all) if (day(o) > day(s) && better(o, best)) best = o;
    return { ...s, cap: best.cap, instrument: best.instrument };
  });
  const safes = adopted.filter((s) => s.cap != null).map((s) => ({ id: s.id, amount: s.amount, cap: s.cap!, instrument: s.instrument }));
  return { common, prefs, options, safes, liqBase: () => common + optionShares + prefShares };
}

/** Payouts in dollars for one set of conversion elections. */
export function refDistribute(E: number, m: RefModel, conv: Set<string>): RefDistribution {
  const prefPaid: Record<string, number> = {};
  let pot = E;
  const claimants = [
    ...m.prefs.map((p) => ({ id: p.id, claim: p.claim, seniority: p.seniority })),
    ...(m.safes ?? []).map((s) => ({ id: s.id, claim: s.amount, seniority: m.safeRank ?? Math.max(1, ...m.prefs.map((p) => p.seniority)) })),
  ];
  for (const c of claimants) prefPaid[c.id] = 0;
  const ranks = [...new Set(claimants.filter((c) => !conv.has(c.id)).map((c) => c.seniority))].sort((a, b) => b - a);
  for (const r of ranks) {
    const inRank = claimants.filter((c) => !conv.has(c.id) && c.seniority === r);
    const claim = inRank.reduce((s, c) => s + c.claim, 0);
    const pay = Math.min(pot, claim);
    for (const c of inRank) prefPaid[c.id] = claim > 0 ? pay * c.claim / claim : 0;
    pot -= pay;
  }
  const R = pot;

  // SAFE conversion shares on a Liquidity Capitalization that excludes cash-out SAFEs.
  const convSafes = (m.safes ?? []).filter((s) => conv.has(s.id));
  const safeShares: Record<string, number> = {};
  if (convSafes.length) {
    const base = (m.liqBase ?? (() => m.common))(conv);
    // A pre-money safe converts on the base, and once it converts it is in a post-money safe's
    // Liquidity Capitalization: Safe User Guide Ex.2 Q3, B = $800,000 / ($8M / ((9,550,000 + 502,631) / 90%)).
    for (const s of convSafes) if (s.instrument === 'SAFE_PRE') safeShares[s.id] = s.amount * base / s.cap;
    const pre = convSafes.reduce((t, s) => t + (safeShares[s.id] ?? 0), 0);
    const own = convSafes.filter((s) => s.instrument !== 'SAFE_PRE').reduce((t, x) => t + x.amount / x.cap, 0);
    const liq = (base + pre) / (1 - own);
    for (const s of convSafes) if (s.instrument !== 'SAFE_PRE') safeShares[s.id] = s.amount / s.cap * liq;
  }

  const parts: { id: string; f: (P: number) => number }[] = [{ id: 'common', f: (P) => m.common * P }];
  for (const p of m.prefs) {
    if (conv.has(p.id) || p.part === 'FP') parts.push({ id: p.id, f: (P) => p.shares * P });
    else if (p.part === 'CP') parts.push({ id: p.id, f: (P) => Math.max(0, Math.min(p.shares * P, (p.capTotal ?? Infinity) - prefPaid[p.id])) });
  }
  for (const s of convSafes) parts.push({ id: s.id, f: (P) => safeShares[s.id] * P });
  (m.options ?? []).forEach((o, i) => parts.push({ id: `opt${i}`, f: (P) => o.n * Math.max(0, P - o.K) }));
  const total = (P: number) => parts.reduce((s, x) => s + x.f(P), 0);
  let lo = 0, hi = 1;
  while (total(hi) < R && hi < 1e15) hi *= 2;
  for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (total(mid) < R) lo = mid; else hi = mid; }
  const P = R > 0 ? (lo + hi) / 2 : 0;

  const payouts: Record<string, number> = {};
  for (const c of claimants) payouts[c.id] = prefPaid[c.id];
  for (const x of parts) payouts[x.id] = (payouts[x.id] ?? 0) + x.f(P);
  return { converted: [...conv].sort(), P, R, payouts, safeShares };
}

/** Every stable set of elections: no claimant gains more than a cent by switching alone. */
export function refEquilibria(E: number, m: RefModel): RefDistribution[] {
  const choosers = [...m.prefs.filter((p) => p.convertible !== false).map((p) => p.id), ...(m.safes ?? []).map((s) => s.id)];
  const out: RefDistribution[] = [];
  for (let mask = 0; mask < (1 << choosers.length); mask++) {
    const conv = new Set(choosers.filter((_, i) => mask & (1 << i)));
    const r = refDistribute(E, m, conv);
    let stable = true;
    for (const id of choosers) {
      const alt = new Set(conv);
      if (alt.has(id)) alt.delete(id); else alt.add(id);
      if (refDistribute(E, m, alt).payouts[id] > r.payouts[id] + 0.01) { stable = false; break; }
    }
    if (stable) out.push(r);
  }
  return out;
}
