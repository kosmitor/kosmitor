import type { CompanyData, ISODate, VestingSchedule } from './types.ts';
import { roundShares } from './util.ts';
import { rewindToDate } from './ledger.ts';

/**
 * Cumulative split ratio applied to a security dated `on`, counting splits
 * effective after that date and on or before `asOf`. `on === null` means the
 * security predates every split.
 */
export function splitFactor(data: CompanyData, on: ISODate | null, asOf: ISODate): number {
  let f = 1;
  for (const s of data.stockSplits) {
    if (s.date <= asOf && (on == null || s.date > on)) f *= s.ratio;
  }
  return f;
}

/**
 * Folds every stock split effective on or before `asOf` into the securities
 * themselves: share counts are multiplied and per-share prices divided, so the
 * economics are unchanged — a $2M liquidation preference is still $2M, and a
 * $1.00 strike on 100 options becomes $0.50 on 200.
 *
 * Every engine entry point calls this first, which means no other formula has
 * to reason about splits. The returned snapshot carries only splits dated after
 * `asOf`, so applying it twice is a no-op.
 *
 * It first rewinds the snapshot to `asOf` (rewindToDate, ledger.ts): transfers,
 * repurchases, exercises, cancellations and conversions dated after it are
 * undone, so every entry point sees the cap table as it stood that day and not
 * today's statuses and quantities (math audit CAP-1). The ledger entries it
 * keeps are restated in the shares of `asOf` with the rows.
 *
 * Prices are divided exactly and may hold a fraction of a micro-cent: rounding
 * $1.37 / 3 to $0.456667 books a $1,370,000 round as $1,370,001, and rounding
 * a $0.10 strike / 3 down lowers the aggregate exercise price, which 26 CFR
 * 1.424-1(e)(4)(v) does not allow. Amounts are rounded to the cent where they
 * are worked out (shareValue), as they are without a split.
 */
export function normalizeSplits(input: CompanyData, asOf: ISODate): CompanyData {
  const data = rewindToDate(input, asOf);
  if (!data.stockSplits.some((s) => s.date <= asOf)) return data;

  const f = (on: ISODate | null): number => splitFactor(data, on, asOf);
  const qty = (n: number, k: number): number => (k === 1 ? n : roundShares(n * k));
  const price = (p: number, k: number): number => (k === 1 ? p : p / k);

  // A custom schedule's tranches given as share counts are in the shares of the
  // security's own date, like its quantity: a security split since vests the same
  // part of itself on each date, so it gets a copy of its schedule with those counts
  // restated (`<id>@<factor>`). Portions need nothing.
  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  const restated = new Map<string, VestingSchedule>();
  const scheduleFor = (id: string | null, k: number): string | null => {
    if (id == null || k === 1) return id;
    const s = scheduleById.get(id);
    if (!s || s.kind !== 'CUSTOM' || !s.customTranches?.some((t) => t.quantity != null)) return id;
    const key = `${id}@${k}`;
    if (!restated.has(key)) {
      restated.set(key, { ...s, id: key, customTranches: s.customTranches.map((t) => (t.quantity != null ? { ...t, quantity: qty(t.quantity, k) } : t)) });
    }
    return key;
  };

  const issuances = data.issuances.map((i) => {
    const k = f(i.issueDate);
    return k === 1 ? i : { ...i, quantity: qty(i.quantity, k), pricePerShare: price(i.pricePerShare, k), vestingScheduleId: scheduleFor(i.vestingScheduleId, k) };
  });
  const awards = data.awards.map((a) => {
    const k = f(a.grantDate);
    return k === 1 ? a : {
      ...a, quantity: qty(a.quantity, k), exercisedQuantity: qty(a.exercisedQuantity, k),
      cancelledQuantity: qty(a.cancelledQuantity, k),
      strikePrice: price(a.strikePrice, k), fmvAtGrant: price(a.fmvAtGrant, k),
      vestingScheduleId: scheduleFor(a.vestingScheduleId, k) as string,
    };
  });

  return {
    ...data,
    ...(restated.size ? { vestingSchedules: [...data.vestingSchedules, ...restated.values()] } : {}),
    shareClasses: data.shareClasses.map((c) => {
      const k = f(c.issueDate);
      return k === 1 ? c : {
        ...c, authorized: qty(c.authorized, k),
        originalIssuePrice: price(c.originalIssuePrice, k), parValue: price(c.parValue, k),
      };
    }),
    issuances,
    awards,
    warrants: data.warrants.map((w) => {
      const k = f(w.issueDate);
      return k === 1 ? w : {
        ...w, quantity: qty(w.quantity, k), exercisedQuantity: qty(w.exercisedQuantity, k),
        strikePrice: price(w.strikePrice, k),
      };
    }),
    pools: data.pools.map((p) => {
      const k = f(p.boardApprovalDate ?? p.shareholderApprovalDate ?? null);
      return k === 1 ? p : { ...p, authorized: qty(p.authorized, k) };
    }),
    poolAdjustments: data.poolAdjustments.map((p) => {
      const k = f(p.date);
      return k === 1 ? p : { ...p, amount: qty(p.amount, k) };
    }),
    valuations: data.valuations.map((v) => {
      const k = f(v.effectiveDate);
      return k === 1 ? v : { ...v, fairMarketValue: price(v.fairMarketValue, k) };
    }),
    ...(data.ledger ? {
      ledger: data.ledger.map((e) => {
        const k = f(e.date);
        return k === 1 || e.quantity == null ? e : { ...e, quantity: qty(e.quantity, k) };
      }),
    } : {}),
    stockSplits: data.stockSplits.filter((s) => s.date > asOf),
  };
}
