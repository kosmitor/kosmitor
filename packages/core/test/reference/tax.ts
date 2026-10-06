/**
 * Independent tax and securities-law tests, written from the regulations, not from src/.
 */

/**
 * ISO $100,000 limit, Treas. Reg. 1.422-4. Per holder and calendar year, options are
 * taken in the order granted (b)(3), valued at FMV on the grant date (b)(2); a
 * tranche cancelled before its first-exercisable year is disregarded (b)(5)(i),
 * otherwise it stays outstanding through that year (b)(5)(ii); dispositions are
 * ignored (b)(6). `byYear` is the dollar value first exercisable in each year.
 */
export interface RefIsoOption {
  id: string;
  grant: string;
  byYear: Record<number, number>;
  cancelledOn?: string;
  /** Overrides grant order, e.g. an exercise before an acceleration (b)(4). */
  order?: number;
}

export function refIsoLimit(opts: RefIsoOption[], limit = 100_000): Record<string, { iso: number; nso: number }> {
  const out: Record<string, { iso: number; nso: number }> = {};
  const years = new Set<number>();
  opts.forEach((o) => Object.keys(o.byYear).forEach((y) => years.add(Number(y))));
  for (const y of [...years].sort()) {
    let room = limit;
    const sorted = opts.filter((o) => o.byYear[y])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.grant.localeCompare(b.grant));
    for (const o of sorted) {
      if (o.cancelledOn && o.cancelledOn < `${y}-01-01`) continue;
      const v = o.byYear[y];
      const iso = Math.min(v, room);
      room -= iso;
      out[`${o.id}:${y}`] = { iso, nso: v - iso };
    }
  }
  return out;
}

/**
 * Rule 701(d), 17 CFR 230.701. Sales in a consecutive 12-month window may not
 * exceed the greatest of $1,000,000, 15% of total assets, or 15% of the class
 * outstanding, the last two measured at the most recent balance sheet date.
 * Options count at their exercise price (d)(3)(ii); securities issued for services
 * count at the value of the securities (d)(3)(i); cash-settled units are not
 * securities sold. Above $10,000,000 the 701(e) disclosure is required.
 */
export interface RefRule701Grant {
  date: string;
  shares: number;
  kind: 'OPTION' | 'RSU' | 'STOCK_FOR_SERVICES' | 'PHANTOM_CASH';
  price: number;   // dollars per share paid or exercise price
  fmv: number;     // dollars per share at grant
}

export function refRule701(
  grants: RefRule701Grant[], asOf: string, windowStartExclusive: string, totalAssets: number, classOutstandingAtBalanceSheet: number,
): { value: number; shares: number; exceeded: boolean; disclosure: boolean } {
  const inWindow = grants.filter((g) => g.date > windowStartExclusive && g.date <= asOf && g.kind !== 'PHANTOM_CASH');
  const value = inWindow.reduce((s, g) => s + Math.round(g.shares * (g.kind === 'OPTION' ? g.price : Math.max(g.price, g.fmv)) * 100), 0);
  const shares = inWindow.reduce((s, g) => s + g.shares, 0);
  const within = value <= 100_000_000 || value <= Math.round(totalAssets * 0.15 * 100) || shares <= classOutstandingAtBalanceSheet * 0.15;
  return { value, shares, exceeded: !within, disclosure: value > 1_000_000_000 };
}
