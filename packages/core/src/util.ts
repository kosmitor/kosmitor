import { MICRO, CENTS, type ISODate, type PricePerShare, type Cents } from './types.ts';

// ---------------------------------------------------------------------------
// Dates — all arithmetic is calendar based and UTC, no timezone drift.
// ---------------------------------------------------------------------------

export function parseDate(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, day ?? 1));
}

export function fmtDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function today(): ISODate {
  return fmtDate(new Date());
}

/** Adds months, clamping to the last day of the target month (Jan 31 + 1mo = Feb 28). */
export function addMonths(d: ISODate, months: number): ISODate {
  const dt = parseDate(d);
  const day = dt.getUTCDate();
  const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fmtDate(target);
}

export function addDays(d: ISODate, days: number): ISODate {
  const dt = parseDate(d);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fmtDate(dt);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

export function yearsBetween(a: ISODate, b: ISODate): number {
  return daysBetween(a, b) / 365.25;
}

/** Whole months elapsed from a to b (partial months do not count). */
export function monthsBetween(a: ISODate, b: ISODate): number {
  const x = parseDate(a), y = parseDate(b);
  let m = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
  if (y.getUTCDate() < x.getUTCDate()) {
    // Handle month-end anchors: Jan 31 -> Feb 28 is a full month.
    const lastDayOfY = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth() + 1, 0)).getUTCDate();
    if (!(y.getUTCDate() === lastDayOfY && x.getUTCDate() > lastDayOfY)) m -= 1;
  }
  return m;
}

/** The n-th `weekday` (0 = Sunday) of a 0-based month, or with n = -1 the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): ISODate {
  if (n < 0) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return fmtDate(new Date(Date.UTC(year, month + 1, -((last.getUTCDay() - weekday + 7) % 7))));
  }
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return fmtDate(new Date(Date.UTC(year, month, 1 + ((weekday - first + 7) % 7) + 7 * (n - 1))));
}

/**
 * Legal holidays in the District of Columbia observed in `year`: the federal
 * holidays of 5 U.S.C. 6103, DC Emancipation Day (April 16) and, every fourth
 * year, Inauguration Day (January 20). A fixed-date holiday on a Saturday is
 * observed the Friday before and one on a Sunday the Monday after, so New
 * Year's Day can be observed on December 31 of the year before.
 */
export function legalHolidays(year: number): Set<ISODate> {
  const out = new Set<ISODate>();
  const fixed = (y: number, month: number, day: number): void => {
    const d = new Date(Date.UTC(y, month, day));
    const shift = d.getUTCDay() === 6 ? -1 : d.getUTCDay() === 0 ? 1 : 0;
    const observed = fmtDate(new Date(Date.UTC(y, month, day + shift)));
    if (observed.startsWith(`${year}-`)) out.add(observed);
  };
  for (const y of [year, year + 1]) fixed(y, 0, 1);              // New Year's Day
  if (year >= 2005) fixed(year, 3, 16);                           // DC Emancipation Day
  if (year >= 2021) fixed(year, 5, 19);                           // Juneteenth
  fixed(year, 6, 4);                                              // Independence Day
  fixed(year, 10, 11);                                            // Veterans Day
  fixed(year, 11, 25);                                            // Christmas Day
  out.add(nthWeekday(year, 0, 1, 3));                             // Martin Luther King Jr. Day
  out.add(nthWeekday(year, 1, 1, 3));                             // Washington's Birthday
  out.add(nthWeekday(year, 4, 1, -1));                            // Memorial Day
  out.add(nthWeekday(year, 8, 1, 1));                             // Labor Day
  out.add(nthWeekday(year, 9, 1, 2));                             // Columbus Day
  out.add(nthWeekday(year, 10, 4, 4));                            // Thanksgiving Day
  if (year >= 1965 && (year - 1965) % 4 === 0) {                  // Inauguration Day, a Monday if the 20th is a Sunday
    out.add(new Date(Date.UTC(year, 0, 20)).getUTCDay() === 0 ? `${year}-01-21` : `${year}-01-20`);
  }
  return out;
}

/**
 * A filing deadline under IRC 7503: the date itself, or when it falls on a
 * Saturday, Sunday or legal holiday, the next day that is none of these.
 */
export function businessDayOnOrAfter(d: ISODate): ISODate {
  let day = d;
  for (;;) {
    const weekday = parseDate(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !legalHolidays(Number(day.slice(0, 4))).has(day)) return day;
    day = addDays(day, 1);
  }
}

export const minDate = (a: ISODate, b: ISODate): ISODate => (a <= b ? a : b);
export const maxDate = (a: ISODate, b: ISODate): ISODate => (a >= b ? a : b);
export const onOrBefore = (a: ISODate | null, b: ISODate): boolean => a !== null && a <= b;

// ---------------------------------------------------------------------------
// Money / share math
// ---------------------------------------------------------------------------

export const dollarsToCents = (d: number): Cents => Math.round(d * CENTS);
export const centsToDollars = (c: Cents): number => c / CENTS;
export const dollarsToPPS = (d: number): PricePerShare => Math.round(d * MICRO);
export const ppsToDollars = (p: PricePerShare): number => p / MICRO;
export const centsToPPS = (c: Cents): PricePerShare => c * (MICRO / CENTS);

/** Value in cents of `shares` at `pps` (micro-cents), rounded to the nearest cent. */
export function shareValue(shares: number, pps: PricePerShare): Cents {
  return Math.round((shares * pps) / (MICRO / CENTS));
}

/** How many whole shares `amount` (cents) buys at `pps`. */
export function sharesForAmount(amount: Cents, pps: PricePerShare, fractional = false): number {
  if (pps <= 0) return 0;
  const raw = (amount * (MICRO / CENTS)) / pps;
  return fractional ? raw : Math.floor(raw + 1e-9);
}

/** Price per share (micro-cents) implied by an amount over a share count. */
export function ppsForAmount(amount: Cents, shares: number): PricePerShare {
  if (shares <= 0) return 0;
  return Math.round((amount * (MICRO / CENTS)) / shares);
}

export const roundShares = (n: number): number => Math.round(n * 1e6) / 1e6;
export const floorShares = (n: number): number => Math.floor(n + 1e-9);

/** Safe percentage: returns 0 rather than NaN when the denominator is 0. */
export function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/**
 * Distributes `total` across `weights` largest-remainder style so the parts
 * always sum exactly to `total` (no rounding leaks in a waterfall).
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) out[order[k].i] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by the API and the UI
// ---------------------------------------------------------------------------

export function formatMoney(cents: Cents, opts: { compact?: boolean; decimals?: number } = {}): string {
  const v = cents / CENTS;
  if (opts.compact) {
    const abs = Math.abs(v);
    const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of units) {
      if (abs >= size) return `$${(v / size).toFixed(abs / size >= 100 ? 0 : 1)}${suffix}`;
    }
  }
  return v.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.decimals ?? 2, maximumFractionDigits: opts.decimals ?? 2,
  });
}

export function formatPPS(pps: PricePerShare): string {
  const v = ppsToDollars(pps);
  const decimals = v !== 0 && Math.abs(v) < 0.01 ? 6 : Math.abs(v) < 1 ? 4 : 2;
  return `$${v.toFixed(decimals)}`;
}

export function formatShares(n: number): string {
  return Math.abs(n % 1) > 1e-9
    ? n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    : Math.round(n).toLocaleString('en-US');
}

export function formatPct(fraction: number, decimals = 2): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 7)}`;
}
