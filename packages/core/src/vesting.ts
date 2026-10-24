import type { ISODate, VestingSchedule, VestingFrequency } from './types.ts';
import { addMonths, addDays, daysBetween, roundShares, floorShares } from './util.ts';
import { enginePolicy } from './policy.ts';

export interface VestingEvent {
  date: ISODate;
  /** Shares vesting on this date. */
  quantity: number;
  /** Running total vested through this date. */
  cumulative: number;
  kind: 'CLIFF' | 'PERIODIC' | 'IMMEDIATE' | 'MILESTONE' | 'CUSTOM' | 'ACCELERATION';
  label?: string;
}

export interface VestingContext {
  schedule: VestingSchedule;
  totalQuantity: number;
  vestingStartDate: ISODate;
  /** Vesting halts here unless acceleration applies. */
  terminationDate?: ISODate | null;
  /** Change-of-control date, drives single/double trigger acceleration. */
  changeOfControlDate?: ISODate | null;
}

/**
 * The longest a vesting schedule may run: 50 years. A schedule is refused past it
 * where one is entered (the API, an OCF package), so no cap table works out a daily
 * schedule over centuries.
 */
export const MAX_VESTING_MONTHS = 600;

const MONTHS_PER_PERIOD: Record<VestingFrequency, number> = {
  MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12, WEEKLY: 0, DAILY: 0,
};

/**
 * Builds the complete vesting schedule as a list of discrete events.
 *
 * Supports: immediate (upfront) vesting, a cliff, ratable periodic vesting,
 * per-year weighting (back-/front-loaded), milestone vesting, fully custom
 * tranches, termination cut-off, and single/double-trigger acceleration.
 *
 * Quantities are allocated with a running-remainder so the events always sum
 * to exactly totalQuantity — no lost or phantom shares from rounding.
 */
export function buildVestingSchedule(ctx: VestingContext): VestingEvent[] {
  const { schedule, totalQuantity, vestingStartDate } = ctx;
  const events: VestingEvent[] = [];
  if (!Number.isFinite(totalQuantity) || totalQuantity < 0) throw new RangeError('Grant quantity must be finite and nonnegative.');
  if (totalQuantity <= 0) return events;

  if (schedule.kind === 'FULLY_VESTED') {
    return applyTerminationAndAcceleration([{ date: vestingStartDate, quantity: totalQuantity, cumulative: totalQuantity, kind: 'IMMEDIATE' }], ctx);
  }

  if (schedule.kind === 'CUSTOM') {
    let cum = 0;
    const tranches = (schedule.customTranches ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    // Portions are allocated together with a cumulative round-down, as milestones are, so thirds of
    // 1,000 vest 333 / 333 / 334 and reach the grant (OCF AllocationType CUMULATIVE_ROUND_DOWN).
    const portions = tranches.filter((t) => t.quantity == null).map((t) => t.portion ?? 0);
    validateTranches(portions, 1);
    const portionShares = distribute(totalQuantity, [...portions, Math.max(0, 1 - portions.reduce((s, p) => s + p, 0))]);
    let p = 0;
    const rows = tranches.map((t) => ({ date: t.date, quantity: t.quantity ?? portionShares[p++] }));
    validateTranches(rows.map((r) => r.quantity), totalQuantity);
    for (const r of rows) {
      cum = roundShares(cum + r.quantity);
      events.push({ date: r.date, quantity: r.quantity, cumulative: cum, kind: 'CUSTOM' });
    }
    return applyTerminationAndAcceleration(events, ctx);
  }

  if (schedule.kind === 'MILESTONE') {
    let cum = 0;
    const milestones = schedule.milestones ?? [];
    const weights = milestones.map((m) => m.portion);
    validateTranches(weights, 1);
    // Portions are fractions of the grant, not relative weights. Unspecified
    // portions must remain unvested instead of being awarded to the last row.
    const portions = distribute(totalQuantity, [...weights, Math.max(0, 1 - weights.reduce((s, w) => s + w, 0))]);
    const rows = milestones.map((m, i) => ({
      date: m.achievedDate ?? m.targetDate ?? vestingStartDate,
      quantity: portions[i],
      achieved: m.achievedDate != null,
      label: m.name,
    }));
    rows.sort((a, b) => a.date.localeCompare(b.date));
    for (const r of rows) {
      if (!r.achieved) continue; // unachieved milestones never vest
      cum = roundShares(cum + r.quantity);
      events.push({ date: r.date, quantity: r.quantity, cumulative: cum, kind: 'MILESTONE', label: r.label });
    }
    return applyTerminationAndAcceleration(events, ctx);
  }

  // ---- Time-based -------------------------------------------------------
  if (!Number.isInteger(schedule.durationMonths) || schedule.durationMonths < 0 ||
      !Number.isInteger(schedule.cliffMonths) || schedule.cliffMonths < 0 ||
      schedule.cliffMonths > schedule.durationMonths) {
    throw new RangeError('Vesting duration and cliff must be nonnegative whole months, with the cliff within the duration.');
  }
  if (schedule.yearWeights?.some((w) => !Number.isFinite(w) || w < 0) ||
      (schedule.yearWeights?.length && !schedule.yearWeights.some((w) => w > 0))) {
    throw new RangeError('Vesting year weights must be finite, nonnegative and have a positive total.');
  }
  const periodMonths = MONTHS_PER_PERIOD[schedule.frequency];
  // Rounded down on a whole-share grant, like every other tranche (see distribute).
  const immediateQty = wholeShareFloor(totalQuantity * clamp01(schedule.immediatePortion), totalQuantity);
  const remaining = totalQuantity - immediateQty;

  type Row = { date: ISODate; quantity: number; kind: VestingEvent['kind'] };
  const rows: Row[] = [];
  if (immediateQty > 0) rows.push({ date: vestingStartDate, quantity: immediateQty, kind: 'IMMEDIATE' });

  const periodDates: ISODate[] = [];
  const endDate = addMonths(vestingStartDate, schedule.durationMonths);
  const cliffDate = schedule.cliffMonths > 0 ? addMonths(vestingStartDate, schedule.cliffMonths) : null;
  if (periodMonths > 0) {
    for (let month = periodMonths; month < schedule.durationMonths; month += periodMonths) {
      periodDates.push(addMonths(vestingStartDate, month));
    }
  } else {
    // A duration in months ends on its calendar anniversary. Include a final
    // short week so weekly grants do not finish early or lose their remainder.
    const step = schedule.frequency === 'WEEKLY' ? 7 : 1;
    const totalDays = daysBetween(vestingStartDate, endDate);
    for (let d = step; d < totalDays; d += step) periodDates.push(addDays(vestingStartDate, d));
  }
  periodDates.push(endDate);
  if (cliffDate && !periodDates.includes(cliffDate)) periodDates.push(cliffDate);
  periodDates.sort();

  const weights = periodWeights(periodDates, vestingStartDate, schedule);
  const amounts = distribute(remaining, weights);
  for (let i = 0; i < periodDates.length; i++) {
    rows.push({ date: periodDates[i], quantity: amounts[i], kind: 'PERIODIC' });
  }

  // Roll everything at or before the cliff into a single cliff event.
  const merged: Row[] = [];
  if (cliffDate) {
    let cliffQty = 0;
    for (const r of rows) {
      if (r.kind !== 'IMMEDIATE' && r.date <= cliffDate) cliffQty += r.quantity;
      else merged.push(r);
    }
    if (cliffQty > 0) merged.push({ date: cliffDate, quantity: cliffQty, kind: 'CLIFF' });
    merged.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'IMMEDIATE' ? -1 : 1));
  } else {
    merged.push(...rows);
  }

  let cum = 0;
  for (const r of merged) {
    if (r.quantity === 0) continue;
    cum = roundShares(cum + r.quantity);
    events.push({ date: r.date, quantity: r.quantity, cumulative: cum, kind: r.kind });
  }
  return applyTerminationAndAcceleration(events, ctx);
}

/**
 * Relative weight of each vesting period, honouring per-year weighting.
 *
 * Year weights: weight n is the share of the grant that vests in year n of the
 * schedule (months 12(n-1) to 12n from the vesting start), spread evenly over
 * that year. A final part-year keeps its whole weight over the months it has,
 * so 10/20/30/40 on 42 months still vests 10/20/30/40, the last 40% in six
 * months. The weights are scaled to the grant over the years the schedule has:
 * a weight past the end is dropped, and years past the last weight reuse it.
 */
function periodWeights(dates: ISODate[], start: ISODate, schedule: VestingSchedule): number[] {
  if (schedule.durationMonths === 0) return dates.map(() => 1);
  // Integrate the scheduled monthly/yearly weight between endpoints. This
  // preserves the smaller final tranche for durations such as 10 quarters and
  // uses actual calendar days for daily and weekly schedules.
  const calendarPeriods = MONTHS_PER_PERIOD[schedule.frequency] > 0;
  const yearWeights = schedule.yearWeights?.length ? schedule.yearWeights : null;
  const D = schedule.durationMonths;
  // Month boundaries, worked out once. The dates are in order, so each date only
  // looks at the months between the date before it and itself: linear in the dates
  // and the months together, where a daily schedule over decades used to cost
  // every month for every date.
  const bounds: ISODate[] = [];
  for (let m = 0; m <= D; m++) bounds.push(addMonths(start, m));
  const at = (m: number): ISODate => (m <= D ? bounds[m] : addMonths(start, m));
  const end = bounds[D];
  let previous = start;
  let first = 0;
  return dates.map((date) => {
    let weight = 0;
    // Months that end on or before the previous date add nothing to this one.
    while (first < D && bounds[first + 1] <= previous) first++;
    for (let m = first; m < D; m++) {
      const monthStart = bounds[m], monthEnd = bounds[m + 1];
      if (monthStart >= date) break;
      const lo = previous > monthStart ? previous : monthStart;
      const hi = date < monthEnd ? date : monthEnd;
      if (hi <= lo) continue;
      const year = Math.floor(m / 12);
      // The part of a full year the schedule covers (1, or less in a final part-year) and
      // the length of a month to weigh this slice by.
      let covered = Math.min(12, D - year * 12) / 12;
      let denominator: number;
      if (calendarPeriods) {
        denominator = daysBetween(monthStart, monthEnd);
      } else {
        const yearStart = at(year * 12), yearEnd = at((year + 1) * 12);
        covered = daysBetween(yearStart, end < yearEnd ? end : yearEnd) / daysBetween(yearStart, yearEnd);
        denominator = daysBetween(yearStart, yearEnd) / 12;
      }
      const yearWeight = yearWeights ? yearWeights[Math.min(year, yearWeights.length - 1)] / covered : 1;
      weight += yearWeight * daysBetween(lo, hi) / denominator;
    }
    previous = date;
    return weight;
  });
}

/**
 * Splits `total` across `weights` using cumulative-floor allocation: the amount
 * vested through period i is floor(total x cumulativeWeight_i / totalWeight).
 *
 * This is the convention equity administrators use — a grant never vests ahead
 * of schedule because of rounding, and the final period absorbs the remainder
 * so the tranches always sum to exactly `total`. A 200,000 share grant over 48
 * months is therefore exactly half vested at month 24, not 100,008 shares.
 */
function distribute(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const wholeShares = Number.isInteger(total);
  const out: number[] = new Array(n);
  let cumWeight = 0;
  let previous = 0;
  for (let i = 0; i < n; i++) {
    cumWeight += weights[i];
    const exact = (total * cumWeight) / totalWeight;
    const cumulative = i === n - 1 ? total : wholeShares ? Math.floor(exact + 1e-9) : roundShares(exact);
    out[i] = roundShares(cumulative - previous);
    previous = cumulative;
  }
  return out;
}

/** Rounds down to a whole share on a whole-share grant, as distribute does; to the micro-share otherwise. */
function wholeShareFloor(n: number, total: number): number {
  return Number.isInteger(total) ? floorShares(n) : roundShares(n);
}

function validateTranches(quantities: number[], total: number): void {
  if (quantities.some((q) => !Number.isFinite(q) || q < 0) ||
      quantities.reduce((s, q) => s + q, 0) > total + 1e-9) {
    throw new RangeError('Vesting tranches must be nonnegative and cannot exceed the grant.');
  }
}

/**
 * Truncates the schedule at termination and layers acceleration on top.
 *
 *  - Single trigger fires on the change of control alone, for a holder still
 *    in service on that date.
 *  - Double trigger fires when a termination follows a change of control
 *    (or the CoC follows the termination — both orders are honoured) within
 *    the policy's doubleTriggerWindowDays of it.
 *  - `accelerationMonths` credits additional months of vesting instead of a
 *    flat percentage when set, counted from the termination for a holder who
 *    has left: the months they would have vested had service continued.
 *
 * Order matters. A single trigger reshapes the whole remaining schedule at the
 * change of control; a later termination then cuts that reshaped schedule
 * off, so the holder keeps the tranches served after the change of control.
 * The double trigger fires at the later of the two dates, after the cut.
 */
function applyTerminationAndAcceleration(events: VestingEvent[], ctx: VestingContext): VestingEvent[] {
  const { terminationDate, changeOfControlDate, schedule, totalQuantity } = ctx;

  // Work on copies so acceleration can reshape tranches without touching
  // `events`, which stays the untouched original schedule for months-of-credit maths.
  let kept: VestingEvent[] = events.map((e) => ({ ...e }));

  /**
   * Vests `portion` of whatever is unvested on `when`, pulling the shares
   * forward out of the remaining future tranches so the grant never
   * over-vests. With accelerationMonths set, credits that many months of
   * additional vesting, counted from `creditFrom`, instead of a flat percentage.
   */
  const fire = (portion: number, when: ISODate, label: string, creditFrom: ISODate = when): void => {
    if (portion <= 0) return;
    const vestedAtWhen = kept.filter((e) => e.date <= when).reduce((s, e) => s + e.quantity, 0);
    const unvested = roundShares(totalQuantity - vestedAtWhen);
    if (unvested <= 0) return;

    let qty: number;
    if (schedule.accelerationMonths != null) {
      // Credit N further months of the ORIGINAL schedule. Measured against the
      // untruncated events so the credit is honoured after a termination too.
      const creditedTo = addMonths(creditFrom, schedule.accelerationMonths);
      qty = Math.max(0, Math.min(unvested, roundShares(vestedThrough(events, creditedTo) - vestedAtWhen)));
    } else {
      // Whole shares on a whole-share grant; the fraction stays on the schedule.
      qty = wholeShareFloor(unvested * clamp01(portion), totalQuantity);
    }
    if (qty <= 0) return;

    // Take the accelerated shares out of the remaining future tranches:
    //  - a months credit consumes the next tranches in order (those months
    //    simply vest now);
    //  - a percentage scales every remaining tranche pro-rata, so the balance
    //    keeps vesting on the original timeline and still ends on the same
    //    date — "50% of the unvested shares vest, the rest per the schedule".
    const future = kept.filter((e) => e.date > when).sort((a, b) => a.date.localeCompare(b.date));
    const futureTotal = future.reduce((s, e) => s + e.quantity, 0);
    if (schedule.accelerationMonths != null) {
      let toConsume = qty;
      for (const e of future) {
        if (toConsume <= 1e-9) break;
        const take = Math.min(e.quantity, toConsume);
        e.quantity = roundShares(e.quantity - take);
        toConsume = roundShares(toConsume - take);
      }
    } else if (futureTotal > 0) {
      const scaled = distribute(Math.max(0, roundShares(futureTotal - qty)), future.map((e) => e.quantity));
      future.forEach((e, i) => { e.quantity = scaled[i]; });
    }
    kept.push({ date: when, quantity: qty, cumulative: 0, kind: 'ACCELERATION', label });
  };

  // Single trigger rewards service through the change of control. A holder who
  // left before it forfeited the unvested shares then, and a later sale of the
  // company does not bring them back.
  if (changeOfControlDate && schedule.accelerationSingleTrigger > 0 && (!terminationDate || terminationDate >= changeOfControlDate)) {
    fire(schedule.accelerationSingleTrigger, changeOfControlDate, 'Single-trigger acceleration');
  }

  // Termination stops the schedule dead — later tranches never vest.
  if (terminationDate) kept = kept.filter((e) => e.date <= terminationDate);

  if (changeOfControlDate && schedule.accelerationDoubleTrigger > 0 && terminationDate) {
    const gapDays = Math.abs(daysBetween(changeOfControlDate, terminationDate));
    if (gapDays <= enginePolicy().doubleTriggerWindowDays) { // within the window either side of the change of control
      const when = terminationDate > changeOfControlDate ? terminationDate : changeOfControlDate;
      fire(schedule.accelerationDoubleTrigger, when, 'Double-trigger acceleration', terminationDate);
    }
  }

  kept = kept.filter((e) => e.quantity > 1e-9);
  kept.sort((a, b) => a.date.localeCompare(b.date));
  let cum = 0;
  for (const e of kept) { cum = roundShares(cum + e.quantity); e.cumulative = cum; }
  return kept;
}

function vestedThrough(events: VestingEvent[], date: ISODate): number {
  let total = 0;
  for (const e of events) { if (e.date <= date) total = e.cumulative; else break; }
  return total;
}

/** Shares vested as of a date. */
export function vestedQuantity(ctx: VestingContext, asOf: ISODate): number {
  return vestedThrough(buildVestingSchedule(ctx), asOf);
}

export interface VestingSummary {
  total: number;
  vested: number;
  unvested: number;
  percentVested: number;
  nextVestDate: ISODate | null;
  nextVestQuantity: number;
  fullyVestedDate: ISODate | null;
  cliffDate: ISODate | null;
  cliffPassed: boolean;
  events: VestingEvent[];
}

export function summarizeVesting(ctx: VestingContext, asOf: ISODate): VestingSummary {
  const events = buildVestingSchedule(ctx);
  const vested = vestedThrough(events, asOf);
  const next = events.find((e) => e.date > asOf) ?? null;
  const cliffDate = ctx.schedule.cliffMonths > 0 ? addMonths(ctx.vestingStartDate, ctx.schedule.cliffMonths) : null;
  return {
    total: ctx.totalQuantity,
    vested,
    unvested: roundShares(ctx.totalQuantity - vested),
    percentVested: ctx.totalQuantity ? vested / ctx.totalQuantity : 0,
    nextVestDate: next?.date ?? null,
    nextVestQuantity: next?.quantity ?? 0,
    fullyVestedDate: events.find((e) => e.cumulative >= ctx.totalQuantity)?.date ?? null,
    cliffDate,
    cliffPassed: cliffDate ? asOf >= cliffDate : true,
    events,
  };
}

/** Monthly cumulative series for charting a grant's vesting curve. */
export function vestingCurve(ctx: VestingContext, months = 60): { date: ISODate; vested: number; unvested: number }[] {
  const events = buildVestingSchedule(ctx);
  const out: { date: ISODate; vested: number; unvested: number }[] = [];
  for (let i = 0; i <= months; i++) {
    const d = addMonths(ctx.vestingStartDate, i);
    const v = vestedThrough(events, d);
    out.push({ date: d, vested: v, unvested: roundShares(ctx.totalQuantity - v) });
    if (v >= ctx.totalQuantity && i > 0) break;
  }
  return out;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The library's built-in standard schedules. The server seeds a new company's
 * schedules from company.vestingSchedules in the param file, which ships with
 * these same ones.
 */
export const STANDARD_SCHEDULES: Omit<VestingSchedule, 'id'>[] = [
  { name: '4 years, 1 year cliff, monthly', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '4 years, no cliff, monthly', kind: 'TIME', durationMonths: 48, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '4 years, 1 year cliff, quarterly', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'QUARTERLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '3 years, 6 month cliff, monthly', kind: 'TIME', durationMonths: 36, cliffMonths: 6, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '2 years, monthly (advisor)', kind: 'TIME', durationMonths: 24, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 1, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '1 year, monthly', kind: 'TIME', durationMonths: 12, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '4 years back-loaded (10/20/30/40)', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: [0.1, 0.2, 0.3, 0.4], milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
  { name: '4 years, double-trigger 100%', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 1, accelerationMonths: null },
  { name: 'Fully vested at grant', kind: 'FULLY_VESTED', durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 1, yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null },
];
