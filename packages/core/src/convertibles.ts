import type { Convertible, ISODate, Cents, PricePerShare, ConvertibleInstrument } from './types.ts';
import { daysBetween, monthsBetween, addMonths, sharesForAmount, roundShares } from './util.ts';
import { MICRO, CENTS } from './types.ts';

/** What each instrument is called, as a title or at the start of a sentence. */
export const INSTRUMENT_NAMES: Readonly<Record<string, string>> = {
  SAFE_POST: 'Post-money SAFE', SAFE_PRE: 'Pre-money SAFE', NOTE: 'Convertible note', KISS: 'KISS',
} satisfies Record<ConvertibleInstrument, string>;

const CENTS_TO_PPS = MICRO / CENTS; // 10_000

const daysInYear = (year: number): number => ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365);

/**
 * Years from a to b on an Actual/Actual basis: the days in each calendar year
 * count against that year's length. The annotated convertible note (Holloway)
 * computes interest on "a 365-day or 366-day year, as the case may be, for the
 * actual number of days elapsed", so a full calendar year is exactly one.
 */
function actualActualYears(a: ISODate, b: ISODate): number {
  let years = 0;
  for (let from = a; from < b;) {
    const year = Number(from.slice(0, 4));
    const yearEnd = `${String(year + 1).padStart(4, '0')}-01-01`;
    const to = yearEnd < b ? yearEnd : b;
    years += daysBetween(from, to) / daysInYear(year);
    from = to;
  }
  return years;
}

/**
 * Growth of 1 at `rate` a period, compounded every `months` months from a to b:
 * compounded over each whole period, and simple in the period in progress for
 * the share of its days that have passed, since interest compounding annually
 * is added to the principal only on each anniversary.
 */
function compounded(a: ISODate, b: ISODate, months: number, rate: number): number {
  const whole = Math.floor(monthsBetween(a, b) / months);
  const start = addMonths(a, whole * months);
  const part = daysBetween(start, b) / daysBetween(start, addMonths(a, (whole + 1) * months));
  return Math.pow(1 + rate, whole) * (1 + rate * part);
}

/**
 * Accrued interest on a convertible note as of a date. Interest runs from the
 * day the investor's money arrived when that is recorded, otherwise from the
 * issue date, and compounds on whole periods: between compounding dates it
 * accrues simply on the balance compounded so far.
 */
export function accruedInterest(c: Convertible, asOf: ISODate): Cents {
  if (c.instrument !== 'NOTE' && c.instrument !== 'KISS') return 0;
  const accrualStart = c.fundsReceivedOn ?? c.issueDate;
  if (c.interestRate <= 0 || asOf <= accrualStart) return 0;
  const accrualEnd = c.convertedOn && c.convertedOn < asOf ? c.convertedOn : asOf;
  if (accrualEnd <= accrualStart) return 0;
  const p = c.principal;
  switch (c.compounding) {
    case 'SIMPLE': return Math.round(p * c.interestRate * actualActualYears(accrualStart, accrualEnd));
    case 'ANNUAL': return Math.round(p * (compounded(accrualStart, accrualEnd, 12, c.interestRate) - 1));
    case 'MONTHLY': return Math.round(p * (compounded(accrualStart, accrualEnd, 1, c.interestRate / 12) - 1));
    case 'DAILY': {
      const days = daysBetween(accrualStart, accrualEnd);
      const r = c.interestRate / 365;
      return Math.round(p * (Math.pow(1 + r, days) - 1));
    }
  }
}

/** Principal plus accrued interest — the amount that actually converts. */
export function conversionAmount(c: Convertible, asOf: ISODate): Cents {
  return c.principal + accruedInterest(c, asOf);
}

export function isMatured(c: Convertible, asOf: ISODate): boolean {
  return c.maturityDate != null && c.maturityDate <= asOf && c.status === 'OUTSTANDING';
}

export type ConversionMethod = 'CAP' | 'DISCOUNT' | 'ROUND_PRICE' | 'MFN_CAP' | 'MFN_DISCOUNT' | 'NO_CAP_NO_DISCOUNT';

export interface ConversionResult {
  convertibleId: string;
  stakeholderId: string;
  instrument: Convertible['instrument'];
  principal: Cents;
  accruedInterest: Cents;
  amount: Cents;
  capPrice: PricePerShare | null;
  discountPrice: PricePerShare | null;
  conversionPrice: PricePerShare;
  method: ConversionMethod;
  shares: number;
  /** Effective pre-money valuation the holder converted at. */
  effectiveValuation: Cents | null;
  /** Multiple on the holder's money at the round price. */
  valueMultiple: number;
}

export interface ConversionContext {
  /** Date of the triggering financing. */
  asOf: ISODate;
  /** Price per share of the new priced round. */
  roundPPS: PricePerShare;
  /**
   * Share base used for the cap price of pre-money SAFEs and notes: the
   * pre-money fully diluted capitalization, excluding the converting
   * instruments and (per most docs) excluding the new pool increase.
   */
  preMoneyCapitalization: number;
  /**
   * Share base used for post-money SAFEs: the "company capitalization" which
   * includes all shares, options, the whole pool and every converting SAFE,
   * but excludes the new round's shares.
   */
  postMoneyCapitalization: number;
  /** All convertibles in the stack — needed to resolve MFN clauses. */
  allConvertibles?: Convertible[];
  /** Pre-money valuation of the round, which an MFN holder weighs a discount against (resolveMFN). */
  valuation?: Cents;
}

/** Statuses of an instrument the company has actually issued; one awaiting approval or signature has not been. */
const ISSUED = new Set<Convertible['status']>(['OUTSTANDING', 'CONVERTED', 'REPAID']);

export interface ConversionTerms { cap: Cents | null; discount: number; instrument: Convertible['instrument'] }

/**
 * The terms an instrument converts on. For an MFN instrument, YC Safe (MFN),
 * "MFN Amendment Provision": if the Company issues Subsequent Convertible
 * Securities before this safe terminates and "the Investor determines that the
 * terms of the Subsequent Convertible Securities are preferable to the terms of
 * this Safe", the Company amends this safe "to be identical to the instrument(s)
 * evidencing the Subsequent Convertible Securities". So the holder takes ONE
 * later instrument whole: its cap, its discount and its pre- or post-money basis
 * (YC Safe User Guide App. I.3), never one's cap with another's discount.
 *
 * Candidates are instruments issued (not pending) after this one and on or before
 * `asOf`, the conversion or event date. Preferable is the lower effective
 * valuation min(cap, valuation x (1 - discount)), `valuation` being the round's
 * pre-money where there is one; with none (cap table, exit) only the cap counts.
 * Ties go to a pre-money basis, whose capitalization leaves the safes out, then
 * to the larger discount. If no candidate beats its own terms it keeps them.
 * ponytail: ranks terms by valuation, not by solving the round once per candidate;
 * a post-money cap a little below a pre-money one can rank first and give fewer shares.
 */
export function resolveMFN(c: Convertible, all: Convertible[] | undefined, asOf: ISODate, valuation: Cents = Infinity): ConversionTerms {
  const own = { cap: c.valuationCap, discount: c.discount, instrument: c.instrument };
  if (!c.mfn || !all) return own;
  const score = (t: ConversionTerms) => [Math.min(t.cap ?? Infinity, valuation * (1 - t.discount)), t.instrument === 'SAFE_POST' ? 1 : 0, -t.discount];
  const better = (a: ConversionTerms, b: ConversionTerms): boolean => {
    const x = score(a), y = score(b);
    const i = x.findIndex((v, k) => v !== y[k]);
    return i >= 0 && x[i] < y[i];
  };
  let best: ConversionTerms = own;
  for (const other of all) {
    if (other.id === c.id || other.issueDate <= c.issueDate || other.issueDate > asOf || !ISSUED.has(other.status)) continue;
    const terms = { cap: other.valuationCap, discount: other.discount, instrument: other.instrument };
    if (better(terms, best)) best = terms;
  }
  return best;
}


/** Fail explicitly instead of producing plausible prices from invalid terms. */
function validateConversion(c: Convertible, roundPPS: PricePerShare): void {
  if (!Number.isFinite(roundPPS) || roundPPS <= 0) throw new Error('Round price must be positive and finite.');
  if (!Number.isFinite(c.principal) || c.principal < 0) throw new Error('Convertible principal must be non-negative and finite.');
  if (!Number.isFinite(c.discount) || c.discount < 0 || c.discount >= 1) throw new Error('Convertible discount must be between 0 and 1 (exclusive of 1).');
  if (c.valuationCap != null && (!Number.isFinite(c.valuationCap) || c.valuationCap <= 0)) throw new Error('Valuation cap must be positive and finite.');
}

/**
 * Converts a single instrument in a priced round.
 *
 * Conversion price is the lowest of the applicable prices:
 *  - cap price   = valuation cap / capitalization
 *  - discount    = round price x (1 - discount)
 *  - round price = no cap and no discount
 */
export function convertOne(c: Convertible, ctx: ConversionContext): ConversionResult {
  validateConversion(c, ctx.roundPPS);
  const interest = accruedInterest(c, ctx.asOf);
  const amount = c.principal + interest;
  const { cap, discount, instrument } = resolveMFN(c, ctx.allConvertibles, ctx.asOf, ctx.valuation);
  const usedMFN = c.mfn && (cap !== c.valuationCap || discount !== c.discount || instrument !== c.instrument);

  const capBase = instrument === 'SAFE_POST' ? ctx.postMoneyCapitalization : ctx.preMoneyCapitalization;
  const capPrice: PricePerShare | null =
    cap != null && capBase > 0 ? Math.max(1, Math.round((cap * CENTS_TO_PPS) / capBase)) : null;
  const discountPrice: PricePerShare | null =
    discount > 0 ? Math.max(1, Math.round(ctx.roundPPS * (1 - discount))) : null;

  let conversionPrice = ctx.roundPPS;
  let method: ConversionMethod = cap == null && discount === 0 ? 'NO_CAP_NO_DISCOUNT' : 'ROUND_PRICE';
  if (capPrice != null && capPrice < conversionPrice) {
    conversionPrice = capPrice;
    method = usedMFN ? 'MFN_CAP' : 'CAP';
  }
  if (discountPrice != null && discountPrice < conversionPrice) {
    conversionPrice = discountPrice;
    method = usedMFN ? 'MFN_DISCOUNT' : 'DISCOUNT';
  }
  if (conversionPrice <= 0) conversionPrice = Math.max(1, ctx.roundPPS);

  const shares = sharesForAmount(amount, conversionPrice);
  return {
    convertibleId: c.id,
    stakeholderId: c.stakeholderId,
    instrument: c.instrument,
    principal: c.principal,
    accruedInterest: interest,
    amount,
    capPrice,
    discountPrice,
    conversionPrice,
    method,
    shares,
    effectiveValuation: capBase > 0 ? Math.round((conversionPrice * capBase) / CENTS_TO_PPS) : null,
    valueMultiple: conversionPrice > 0 ? ctx.roundPPS / conversionPrice : 1,
  };
}

/** Converts the whole convertible stack at a single round price. */
export function convertAll(convertibles: Convertible[], ctx: ConversionContext): ConversionResult[] {
  const live = convertibles.filter((c) => c.status === 'OUTSTANDING' && c.issueDate <= ctx.asOf);
  const withAll = { ...ctx, allConvertibles: ctx.allConvertibles ?? convertibles };
  return live.map((c) => convertOne(c, withAll));
}

/**
 * Post-money SAFEs are defined by ownership, not by a share count: the holder
 * owns principal / post-money-cap of the company after all SAFEs convert but
 * before the new money. Because every post-money SAFE's price depends on a
 * capitalization that includes the other post-money SAFEs, the set has to be
 * solved together. This finds the fixed point. An MFN safe that adopted a
 * pre-money instrument's cap is not post-money and is left out; `all` is the
 * stack its MFN clause looks at (by default the instruments given) and
 * `valuation` the round's pre-money it weighs terms by (see resolveMFN).
 */
export function solvePostMoneySafes(
  convertibles: Convertible[],
  baseCapitalization: number,
  roundPPS: PricePerShare,
  asOf: ISODate,
  all: Convertible[] = convertibles,
  valuation?: Cents,
): { shares: Map<string, number>; totalCapitalization: number; iterations: number } {
  const posts = convertibles.filter(
    (c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf && resolveMFN(c, all, asOf, valuation).instrument === 'SAFE_POST',
  );
  const shares = new Map<string, number>();
  if (posts.length === 0) return { shares, totalCapitalization: baseCapitalization, iterations: 0 };

  if (!Number.isFinite(baseCapitalization) || baseCapitalization <= 0) {
    throw new Error('Post-money SAFE conversion requires a positive existing capitalization.');
  }
  const terms = posts.map((c) => {
    validateConversion(c, roundPPS);
    const { cap, discount } = resolveMFN(c, all, asOf, valuation);
    const amount = conversionAmount(c, asOf);
    return { c, cap, amount, fixedPrice: Math.max(1, Math.round(roundPPS * (1 - discount))) };
  });
  const ownershipTaken = terms.reduce((sum, t) => sum + (t.cap ? t.amount / t.cap : 0), 0);
  if (ownershipTaken >= 1) throw new RangeError('Post-money SAFE caps allocate 100% or more of the company; no finite conversion exists.');

  // Solve the piecewise-linear equation T = base + sum(max(amount/cap*T,
  // amount/discountPrice)). The right side is convex with slope below 1, so the
  // root is unique. Starting from T = base, each pass prices with the caps that
  // beat the round/discount price at the current T and solves that linear piece;
  // T only rises, so a cap once binding stays binding and caps are only ever
  // added. A safe the round price beat at first converts at its cap once the
  // others' shares raise T enough (YC Safe User Guide p.12-13, 22-23). At most
  // one pass per instrument is needed.
  const binding = (capitalization: number): Set<string> => new Set(terms
    .filter((t) => t.cap != null && t.cap * CENTS_TO_PPS / capitalization < t.fixedPrice).map((t) => t.c.id));
  const solveWith = (capped: Set<string>): number => {
    const fixedShares = terms.filter((t) => !capped.has(t.c.id))
      .reduce((sum, t) => sum + t.amount * CENTS_TO_PPS / t.fixedPrice, 0);
    const ownership = terms.filter((t) => capped.has(t.c.id))
      .reduce((sum, t) => sum + t.amount / t.cap!, 0);
    return (baseCapitalization + fixedShares) / (1 - ownership);
  };
  let capped = binding(baseCapitalization);
  let capitalization = solveWith(capped);
  let iterations = 1;
  for (; iterations <= terms.length; iterations++) {
    const next = binding(capitalization);
    if (next.size === capped.size) break;
    capped = next;
    capitalization = solveWith(capped);
  }
  // Keep cap math at full precision until share issuance: rounding a $1.111111
  // cap price to microdollars before dividing can create or erase whole shares.
  for (const t of terms) {
    const price = Math.min(t.fixedPrice, t.cap != null ? t.cap * CENTS_TO_PPS / capitalization : Infinity);
    shares.set(t.c.id, sharesForAmount(t.amount, price));
  }
  capitalization = baseCapitalization + [...shares.values()].reduce((sum, qty) => sum + qty, 0);

  return { shares, totalCapitalization: roundShares(capitalization), iterations };
}

/** What a convertible is worth today if it converted at the current FMV. */
export function convertibleMarkToMarket(
  c: Convertible, fmv: PricePerShare, capitalization: number, asOf: ISODate,
): { shares: number; value: Cents; multiple: number } {
  const amount = conversionAmount(c, asOf);
  const capPrice = c.valuationCap && capitalization > 0
    ? Math.round((c.valuationCap * CENTS_TO_PPS) / capitalization) : null;
  const discPrice = c.discount > 0 ? Math.round(fmv * (1 - c.discount)) : null;
  let price = fmv || 1;
  if (capPrice != null && capPrice > 0 && capPrice < price) price = capPrice;
  if (discPrice != null && discPrice > 0 && discPrice < price) price = discPrice;
  const shares = sharesForAmount(amount, Math.max(1, price));
  const value = Math.round((shares * fmv) / CENTS_TO_PPS);
  return { shares, value, multiple: amount > 0 ? value / amount : 0 };
}
