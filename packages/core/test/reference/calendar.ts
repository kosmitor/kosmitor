/**
 * Independent date rules for filing deadlines and day counts, written from the
 * sources, not from src/.
 *
 *  - IRC 7503: a deadline on a Saturday, Sunday or legal holiday moves to the next
 *    day that is none of these. The IRS reads "legal holiday" as a District of
 *    Columbia legal holiday, which adds Emancipation Day (April 16) and Inauguration
 *    Day to the federal list. A holiday on a Saturday is observed on the Friday and
 *    one on a Sunday on the Monday (5 U.S.C. 6103).
 *  - Actual/Actual: each calendar year's days count against that year's length
 *    (365 or 366), the basis of the Wallin & Baltaxe annotated note ("a 365-day or
 *    366-day year, as the case may be, for the actual number of days elapsed").
 */

const D = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function refPlusDays(s: string, n: number): string {
  const d = D(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export const refIsLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The n-th (or, for n < 0, the last) weekday `wd` (0 = Sunday) of month `m` (0-based). */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1));
    const off = (wd - first.getUTCDay() + 7) % 7;
    return iso(new Date(Date.UTC(y, m, 1 + off + 7 * (n - 1))));
  }
  const last = new Date(Date.UTC(y, m + 1, 0));
  const off = (last.getUTCDay() - wd + 7) % 7;
  return iso(new Date(Date.UTC(y, m + 1, -off)));
}

/** Federal and District of Columbia legal holidays observed in year `y`. */
export function refLegalHolidays(y: number): Set<string> {
  // New Year's Day, DC Emancipation Day, Juneteenth, Independence Day, Veterans Day, Christmas.
  const fixed: [number, number][] = [[0, 1], [3, 16], [5, 19], [6, 4], [10, 11], [11, 25]];
  const out = new Set<string>();
  for (const [m, d] of fixed) {
    const dt = new Date(Date.UTC(y, m, d));
    out.add(iso(dt));
    if (dt.getUTCDay() === 6) out.add(iso(new Date(Date.UTC(y, m, d - 1))));
    if (dt.getUTCDay() === 0) out.add(iso(new Date(Date.UTC(y, m, d + 1))));
  }
  out.add(nthWeekday(y, 0, 1, 3));   // Martin Luther King Jr. Day
  out.add(nthWeekday(y, 1, 1, 3));   // Washington's Birthday
  out.add(nthWeekday(y, 4, 1, -1));  // Memorial Day
  out.add(nthWeekday(y, 8, 1, 1));   // Labor Day
  out.add(nthWeekday(y, 9, 1, 2));   // Columbus Day
  out.add(nthWeekday(y, 10, 4, 4));  // Thanksgiving
  if ((y - 1965) % 4 === 0) out.add(`${y}-01-20`); // Inauguration Day, a DC legal holiday
  return out;
}

/** The deadline under IRC 7503: `s` itself, or the next day that is not a weekend or legal holiday. */
export function refBusinessDayOnOrAfter(s: string): string {
  let d = s;
  for (;;) {
    const wd = D(d).getUTCDay();
    if (wd !== 0 && wd !== 6 && !refLegalHolidays(Number(d.slice(0, 4))).has(d)) return d;
    d = refPlusDays(d, 1);
  }
}

/** Years between two dates on an Actual/Actual basis. */
export function refActualActualYears(a: string, b: string): number {
  let t = 0, cur = a;
  while (cur < b) {
    const y = Number(cur.slice(0, 4));
    const yearEnd = `${y + 1}-01-01`;
    const end = yearEnd < b ? yearEnd : b;
    t += ((D(end).getTime() - D(cur).getTime()) / 864e5) / (refIsLeap(y) ? 366 : 365);
    cur = end;
  }
  return t;
}

/**
 * Treas. Reg. 1.409A-1(b)(5)(iv)(B): a valuation dated V can support a grant on G
 * when it is not more than 12 months old, i.e. V >= G minus 12 calendar months
 * (Feb 29 minus a year is Feb 28).
 */
export function refValuationSupports(valuationDate: string, grantDate: string): boolean {
  const [y, m, d] = grantDate.split('-').map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  const yearBefore = `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  return valuationDate >= yearBefore;
}
