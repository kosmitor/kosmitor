/**
 * Independent vesting arithmetic, written from the Open Cap Table Format, not from
 * src/. OCF AllocationType CUMULATIVE_ROUND_DOWN: after k of n periods the holder
 * has floor(total × k / n) shares, so every tranche is whole and the last one
 * absorbs the remainder.
 * https://open-cap-table-coalition.github.io/Open-Cap-Format-OCF/schema_markdown/schema/enums/AllocationType/
 */

/** Calendar months added to an ISO date, clamped to the last day of a shorter month (Jan 31 + 1 = Feb 28/29). */
export function refAddMonths(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

/** Shares vested on `asOf` under monthly vesting with a cliff, cumulative round-down. */
export function refMonthlyVested(total: number, start: string, durationMonths: number, cliffMonths: number, asOf: string): number {
  let k = 0;
  for (let m = 1; m <= durationMonths; m++) if (refAddMonths(start, m) <= asOf) k = m;
  if (k < cliffMonths) return 0;
  return k === durationMonths ? total : Math.floor((total * k) / durationMonths);
}

/** Tranche sizes for `periods` equal periods, cumulative round-down. */
export function refTranches(total: number, periods: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= periods; k++) out.push(Math.floor((total * k) / periods) - Math.floor((total * (k - 1)) / periods));
  return out;
}
