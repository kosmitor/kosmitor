/**
 * Stock-based compensation under ASC 718 (and IFRS 2): grant-date fair value
 * of each award, attributed over the requisite service period, with the
 * period expense, unrecognised cost and the option roll-forward that the
 * financial statement footnote needs.
 *
 * Fair value: Black–Scholes for options and SARs (the fair market value at
 * grant is the spot price), the grant-date FMV for RSUs, RSAs and phantom
 * units. Expected term is either the company's assumption or the SAB 107
 * "simplified" midpoint of a tranche's vesting date and the contractual term.
 *
 * Attribution: graded (each vesting tranche over its own service period, as
 * IFRS 2 requires) or straight-line (total value over the whole service
 * period, floored at the value of what has already vested). Forfeitures are
 * either accounted for as they occur (ASU 2016-09) or estimated with an annual
 * rate that is trued up when a tranche vests.
 */
import type { CompanyData, ISODate, Cents, PricePerShare, Award, AwardType } from './types.ts';
import { buildVestingSchedule } from './vesting.ts';
import { normalizeSplits } from './splits.ts';
import { activeValuation } from './captable.ts';
import { today, addDays, addMonths, daysBetween, yearsBetween, shareValue, roundShares } from './util.ts';
import { enginePolicy, DEFAULT_ENGINE_POLICY } from './policy.ts';

export interface StockCompAssumptions {
  /** Annualised volatility, e.g. 0.6 for 60%. */
  volatility: number;
  /** Continuously compounded risk-free rate, e.g. 0.04. */
  riskFreeRate: number;
  dividendYield: number;
  /** Expected term in years for every option; null uses the simplified method per tranche. */
  expectedTermYears: number | null;
  attribution: 'GRADED' | 'STRAIGHT_LINE';
  forfeiturePolicy: 'AS_OCCUR' | 'ESTIMATE';
  /** Annual forfeiture rate used when estimating, e.g. 0.05. */
  forfeitureRate: number;
  standard: 'GAAP' | 'IFRS';
}

/**
 * The built-in assumptions. The ones a report falls back on are policy,
 * stockComp.defaultAssumptions in the param file, read when the report runs.
 */
export const DEFAULT_STOCK_COMP_ASSUMPTIONS: StockCompAssumptions = { ...DEFAULT_ENGINE_POLICY.stockCompAssumptions };

/** Days in the contractual term assumed for an option with no expiration date (3,652 for the default ten years). */
const assumedTermDays = (): number => Math.floor(enginePolicy().optionTermYears * 365.25);

// --- Black–Scholes ---------------------------------------------------------

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, error under 7.5e-8). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI) * poly;
  return x >= 0 ? 1 - tail : tail;
}

export interface OptionPricingInput {
  spot: number;
  strike: number;
  termYears: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield: number;
}

/** Fair value of one call option, in the units of `spot` and `strike`. */
export function blackScholes(i: OptionPricingInput): number {
  if (Object.values(i).some((v) => !Number.isFinite(v)) ||
      i.spot < 0 || i.strike < 0 || i.termYears < 0 || i.volatility < 0) {
    throw new RangeError('Option pricing inputs must be finite; spot, strike, term and volatility must be nonnegative.');
  }
  if (i.spot <= 0) return 0;
  if (i.termYears === 0) return Math.max(0, i.spot - i.strike);
  if (i.volatility === 0) return Math.max(0, i.spot * Math.exp(-i.dividendYield * i.termYears) - i.strike * Math.exp(-i.riskFreeRate * i.termYears));
  if (i.strike <= 0) return i.spot * Math.exp(-i.dividendYield * i.termYears);
  const sqrtT = Math.sqrt(i.termYears);
  const d1 = (Math.log(i.spot / i.strike) + (i.riskFreeRate - i.dividendYield + (i.volatility ** 2) / 2) * i.termYears) / (i.volatility * sqrtT);
  const d2 = d1 - i.volatility * sqrtT;
  return Math.max(0, i.spot * Math.exp(-i.dividendYield * i.termYears) * normalCdf(d1) - i.strike * Math.exp(-i.riskFreeRate * i.termYears) * normalCdf(d2));
}

// --- Fiscal periods --------------------------------------------------------

export interface FiscalPeriod { label: string; start: ISODate; end: ISODate }

/** The fiscal year that ends on `fiscalYearEnd` (MM-DD) in calendar year `endYear`. */
export function fiscalYear(endYear: number, fiscalYearEnd = '12-31'): FiscalPeriod {
  const [mm, dd] = fiscalYearEnd.split('-').map(Number);
  // A year end of Feb 28 or Feb 29 is the last day of February, which moves with leap
  // years (2024-02-29, 2025-02-28): every day falls in exactly one fiscal year and the
  // quarters end on month ends. A day past the end of its month is that month's end.
  const yearEnd = (year: number): ISODate => {
    const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
    const day = mm === 2 && dd >= 28 ? last : Math.min(dd, last);
    return `${year}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  return { label: `FY${endYear}`, start: addDays(yearEnd(endYear - 1), 1), end: yearEnd(endYear) };
}

/** The four quarters of a fiscal year. */
export function fiscalQuarters(year: FiscalPeriod): FiscalPeriod[] {
  const quarters: FiscalPeriod[] = [];
  let start = year.start;
  for (let q = 1; q <= 4; q++) {
    const end = q === 4 ? year.end : addDays(addMonths(year.start, q * 3), -1);
    quarters.push({ label: `Q${q} ${year.label}`, start, end });
    start = addDays(end, 1);
  }
  return quarters;
}

// --- Attribution -----------------------------------------------------------

export interface Tranche {
  vestDate: ISODate;
  quantity: number;
  /** Expected term used to price this tranche, in years. */
  expectedTermYears: number;
  fairValuePerShare: PricePerShare;
  fairValue: Cents;
}

export interface AwardValuation {
  award: Award;
  fairValuePerShare: PricePerShare;   // weighted across tranches
  totalFairValue: Cents;
  tranches: Tranche[];
  serviceStart: ISODate;
  serviceEnd: ISODate;
}

const SETTLES_IN_STOCK_WITHOUT_STRIKE: AwardType[] = ['RSU', 'RSA', 'PHANTOM', 'GROWTH_SHARE'];

/** Grant-date fair value of an award, tranche by tranche. */
export function valueAward(data: CompanyData, award: Award, assumptions: StockCompAssumptions): AwardValuation | null {
  const schedule = data.vestingSchedules.find((v) => v.id === award.vestingScheduleId);
  if (!schedule) return null;
  const events = buildVestingSchedule({ schedule, totalQuantity: award.quantity, vestingStartDate: award.vestingStartDate });
  const contractualYears = award.expirationDate ? Math.max(0, yearsBetween(award.grantDate, award.expirationDate)) : enginePolicy().optionTermYears;
  const tranches: Tranche[] = events.filter((e) => e.quantity > 0).map((e) => {
    const vestDate = e.date < award.grantDate ? award.grantDate : e.date;
    const yearsToVest = Math.max(0, yearsBetween(award.grantDate, vestDate));
    const expectedTermYears = assumptions.expectedTermYears ?? Math.max(yearsToVest, (yearsToVest + contractualYears) / 2);
    // Restricted stock costs its fair value less the price the employee pays for it, which
    // the award keeps as its strike (FAS 123(R) ¶15: $50 - $5 = $45 of compensation).
    const fairValuePerShare = SETTLES_IN_STOCK_WITHOUT_STRIKE.includes(award.type)
      ? Math.max(0, award.fmvAtGrant - (award.type === 'RSA' ? award.strikePrice : 0))
      : Math.round(blackScholes({
        spot: award.fmvAtGrant, strike: award.strikePrice, termYears: expectedTermYears,
        volatility: assumptions.volatility, riskFreeRate: assumptions.riskFreeRate, dividendYield: assumptions.dividendYield,
      }));
    return { vestDate, quantity: e.quantity, expectedTermYears, fairValuePerShare, fairValue: shareValue(e.quantity, fairValuePerShare) };
  });
  if (tranches.length === 0) return null;
  const totalFairValue = tranches.reduce((s, t) => s + t.fairValue, 0);
  const quantity = tranches.reduce((s, t) => s + t.quantity, 0);
  return {
    award, tranches, totalFairValue,
    fairValuePerShare: quantity > 0 ? Math.round(totalFairValue * 1e6 / 100 / quantity) : 0,
    serviceStart: award.grantDate, serviceEnd: tranches[tranches.length - 1].vestDate,
  };
}

/** The same award valued at `pps` a share, for remeasuring a liability award. */
function revalue(v: AwardValuation, pps: PricePerShare): AwardValuation {
  const tranches = v.tranches.map((t) => ({ ...t, fairValuePerShare: pps, fairValue: shareValue(t.quantity, pps) }));
  return { ...v, tranches, fairValuePerShare: pps, totalFairValue: tranches.reduce((s, t) => s + t.fairValue, 0) };
}

/** Fraction of a service period elapsed at `asOf`, by days. */
function elapsed(start: ISODate, end: ISODate, asOf: ISODate): number {
  if (asOf < start) return 0;
  if (asOf >= end) return 1;
  const total = daysBetween(start, end);
  return total <= 0 ? 1 : Math.min(1, Math.max(0, daysBetween(start, asOf) / total));
}

/** Expected-to-vest factor for a tranche under the estimate policy; 1 once it has vested or when forfeitures are taken as they occur. */
function expectedToVest(assumptions: StockCompAssumptions, grantDate: ISODate, tranche: Tranche, asOf: ISODate): number {
  if (assumptions.forfeiturePolicy !== 'ESTIMATE' || asOf >= tranche.vestDate) return 1;
  return (1 - assumptions.forfeitureRate) ** Math.max(0, yearsBetween(grantDate, tranche.vestDate));
}

/** A cancellation of unvested shares: the fraction of each tranche still unvested on that date that was forfeited. */
export interface Cancellation { date: ISODate; fraction: number }

/**
 * The share of a tranche's cost still counted at `asOf` (the start of that day).
 * A cancellation forfeits its fraction of every tranche vesting after its date,
 * from the end of that day: the holder served through it, as vesting.ts keeps
 * a tranche that vests on the termination date.
 */
function trancheWeight(t: Tranche, asOf: ISODate, cancellations: readonly Cancellation[]): number {
  let weight = 1;
  for (const c of cancellations) if (asOf > c.date && t.vestDate > c.date) weight *= 1 - c.fraction;
  return weight;
}

/** The cost expected at `asOf`: tranches not forfeited, the unvested ones scaled by any forfeiture estimate. */
function expectedCost(v: AwardValuation, assumptions: StockCompAssumptions, asOf: ISODate, cancellations: readonly Cancellation[]): number {
  return v.tranches.reduce((s, t) => s + trancheWeight(t, asOf, cancellations) * t.fairValue * expectedToVest(assumptions, v.serviceStart, t, asOf), 0);
}

/**
 * Cumulative expense recognised for an award at the start of `asOf`. After
 * each cancellation date, the forfeited fraction of every tranche that had not
 * vested by then drops out — which reverses what had been recognised on it.
 */
export function cumulativeExpense(v: AwardValuation, assumptions: StockCompAssumptions, asOf: ISODate, cancellation: Cancellation | readonly Cancellation[] | null = null): Cents {
  if (asOf < v.serviceStart) return 0;
  const cancellations: readonly Cancellation[] = cancellation == null ? [] : 'date' in cancellation ? [cancellation] : cancellation;
  const weight = (t: Tranche): number => trancheWeight(t, asOf, cancellations);
  if (assumptions.attribution === 'STRAIGHT_LINE' && assumptions.standard === 'GAAP') {
    const total = expectedCost(v, assumptions, asOf, cancellations);
    const straight = total * elapsed(v.serviceStart, v.serviceEnd, asOf);
    const vestedFloor = v.tranches.filter((t) => t.vestDate <= asOf).reduce((s, t) => s + weight(t) * t.fairValue, 0);
    return Math.round(Math.max(straight, vestedFloor));
  }
  // Graded: every tranche is its own award over grant → vest date (IFRS 2 allows nothing else).
  return Math.round(v.tranches.reduce((s, t) =>
    s + weight(t) * t.fairValue * elapsed(v.serviceStart, t.vestDate, asOf) * expectedToVest(assumptions, v.serviceStart, t, asOf), 0));
}

// --- The report --------------------------------------------------------------

export interface StockCompAwardRow {
  awardId: string;
  label: string | null;
  stakeholderId: string;
  stakeholderName: string;
  department: string | null;
  type: AwardType;
  grantDate: ISODate;
  quantity: number;
  fairValuePerShare: PricePerShare;
  totalFairValue: Cents;
  expense: Cents;               // recognised in the period, net of any forfeiture reversal
  cumulative: Cents;            // recognised through period end
  unrecognized: Cents;
  remainingYears: number;
  status: string;
  cancelledQuantity: number;
  cancellationDate: ISODate | null;
}

export interface OptionRollforward {
  outstandingStart: { count: number; waep: PricePerShare };
  granted: { count: number; waep: PricePerShare; fairValuePerShare: PricePerShare };
  exercised: { count: number; waep: PricePerShare };
  forfeited: { count: number; waep: PricePerShare };
  expired: { count: number; waep: PricePerShare };
  outstandingEnd: { count: number; waep: PricePerShare; remainingContractualYears: number; intrinsicValue: Cents };
  exercisableEnd: { count: number; waep: PricePerShare; remainingContractualYears: number; intrinsicValue: Cents };
}

export interface StockCompReport {
  period: FiscalPeriod;
  quarters: { period: FiscalPeriod; expense: Cents }[];
  assumptions: StockCompAssumptions;
  awards: StockCompAwardRow[];
  totals: { expense: Cents; byType: Partial<Record<AwardType, Cents>>; cumulative: Cents; unrecognized: Cents; weightedRemainingYears: number };
  byDepartment: { department: string; expense: Cents; awards: number }[];
  rollforward: OptionRollforward;
  /** Awards that could not be valued (no vesting schedule) and are excluded. */
  excluded: { awardId: string; label: string | null; reason: string }[];
}

export interface StockCompOptions {
  fiscalYearEnd?: string;
  assumptions?: Partial<StockCompAssumptions>;
  /** Department or cost centre by stakeholder id. */
  departments?: Record<string, string | null>;
  /**
   * When an award's cancelled shares were forfeited. When unknown, the day the
   * holder left, else the report's as-of date: one date whatever the period, so
   * each year's closing cost is the next year's opening.
   */
  cancellationDates?: Record<string, ISODate>;
  /**
   * Every cancellation of an award on record, when there was more than one; takes
   * precedence over cancellationDates. The quantities are read as proportions of the
   * award's cancelledQuantity, so ledger units from before a split do not matter.
   */
  cancellations?: Record<string, { date: ISODate; quantity: number }[]>;
  /** Exercises in the period, for the roll-forward. */
  exercises?: { awardId: string; quantity: number; exerciseDate: ISODate }[];
  asOf?: ISODate;
}

const OPTION_TYPES: AwardType[] = ['ISO', 'NSO', 'SAR'];
const waep = (rows: { count: number; strike: number }[]): PricePerShare => {
  const n = rows.reduce((s, r) => s + r.count, 0);
  return n > 0 ? Math.round(rows.reduce((s, r) => s + r.count * r.strike, 0) / n) : 0;
};

/** Stock-based compensation for the fiscal year ending in `endYear`. */
export function stockCompReport(input: CompanyData, endYear: number, opts: StockCompOptions = {}): StockCompReport {
  const assumptions: StockCompAssumptions = { ...enginePolicy().stockCompAssumptions, ...opts.assumptions };
  if (assumptions.standard === 'IFRS') assumptions.attribution = 'GRADED';
  const period = fiscalYear(endYear, opts.fiscalYearEnd ?? '12-31');
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const before = addDays(period.start, -1);
  const departments = opts.departments ?? {};
  const cancellationDates = opts.cancellationDates ?? {};
  // The report closes a period at the end of its last day, so a tranche vesting the next
  // morning was fully served in it (FAS 123(R) ¶A91, A102: 20X5's cost runs through Dec 31).
  const closeOf = (d: ISODate): ISODate => addDays(d, 1);

  /**
   * An award's recorded cancellations, oldest first, in the expense as in the
   * roll-forward. One with no date on record is taken on the day the holder left,
   * when that is known by the as-of date, and otherwise on the as-of date, by
   * which it had happened. Taking it at each report's own period end instead
   * would reverse it again in every year's report, and one year's closing cost
   * would not be the next year's opening.
   */
  const undated = (a: Award): ISODate => {
    const left = data.stakeholders.find((s) => s.id === a.stakeholderId)?.terminationDate;
    return left && left <= asOf ? left : asOf;
  };
  const recordedCancellations = (a: Award): { date: ISODate; quantity: number }[] => {
    if (a.cancelledQuantity <= 0) return [];
    const listed = (opts.cancellations?.[a.id] ?? []).filter((c) => c.quantity > 0);
    const total = listed.reduce((s, c) => s + c.quantity, 0);
    if (total <= 0) return [{ date: cancellationDates[a.id] ?? undated(a), quantity: a.cancelledQuantity }];
    const scale = a.cancelledQuantity / total;
    return listed.map((c) => ({ date: c.date, quantity: roundShares(c.quantity * scale) })).sort((x, y) => x.date.localeCompare(y.date));
  };

  /**
   * What reverses an award's cost. Under ASC 718-10-35-3 (ASU 2016-09) a forfeiture
   * happens when the service condition fails, on the day the holder leaves: every
   * tranche after it drops out then, whether or not a cancellation is on record yet.
   * Each recorded cancellation forfeits its shares out of the tranches still unvested,
   * and not already forfeited, on its date.
   */
  const forfeitures = (a: Award, v: AwardValuation, leftOn: ISODate | null): Cancellation[] => {
    const out: Cancellation[] = leftOn ? [{ date: leftOn, fraction: 1 }] : [];
    for (const c of recordedCancellations(a)) {
      const unvested = v.tranches.filter((t) => t.vestDate > c.date).reduce((s, t) => s + t.quantity * trancheWeight(t, closeOf(c.date), out), 0);
      out.push({ date: c.date, fraction: unvested > 0 ? Math.min(1, c.quantity / unvested) : 0 });
    }
    return out;
  };

  /** A share's fair value at `d` for remeasuring a liability: the latest valuation since the grant, else the grant-date value. */
  const fairValueAt = (a: Award, d: ISODate): PricePerShare => {
    const since = data.valuations
      .filter((x) => x.status !== 'DRAFT' && x.effectiveDate >= a.grantDate && x.effectiveDate <= d)
      .sort((x, y) => y.effectiveDate.localeCompare(x.effectiveDate));
    return (since.find((x) => x.type === '409A') ?? since[0])?.fairMarketValue ?? a.fmvAtGrant;
  };

  const rows: StockCompAwardRow[] = [];
  const excluded: StockCompReport['excluded'] = [];
  const quarterTotals = fiscalQuarters(period).map((q) => ({ period: q, expense: 0 }));

  for (const award of data.awards) {
    if (award.status === 'DRAFT' || award.status === 'PENDING_APPROVAL' || award.status === 'PENDING_SIGNATURE') continue;
    if (award.grantDate > period.end) continue;
    const v = valueAward(data, award, assumptions);
    if (!v) { excluded.push({ awardId: award.id, label: award.label, reason: 'No vesting schedule' }); continue; }
    const holder = data.stakeholders.find((s) => s.id === award.stakeholderId);
    const cancellations = forfeitures(award, v, holder?.terminationDate ?? null);
    // A phantom unit pays the value of a share in cash, so it is a liability: remeasured at
    // fair value at each reporting date until it settles, the cost to date being the service
    // rendered at that value (ASC 718-30-35-3). Equity awards keep their grant-date value.
    const valuedAt = (d: ISODate): AwardValuation => award.type === 'PHANTOM' ? revalue(v, fairValueAt(award, d < asOf ? d : asOf)) : v;
    const net = (d: ISODate): Cents => cumulativeExpense(valuedAt(d), assumptions, closeOf(d), cancellations);

    const cumulativeEnd = net(period.end);
    const expense = cumulativeEnd - net(before);
    for (const q of quarterTotals) q.expense += net(q.period.end) - net(addDays(q.period.start, -1));
    // What is left to recognise on the cost expected under the policy, so estimated
    // forfeitures are not counted as cost still to come (FAS 123(R) ¶A91).
    const atEnd = valuedAt(period.end);
    const unrecognized = Math.max(0, Math.round(expectedCost(atEnd, assumptions, closeOf(period.end), cancellations)) - cumulativeEnd);
    const remainingYears = v.serviceEnd > closeOf(period.end) ? yearsBetween(closeOf(period.end), v.serviceEnd) : 0;
    rows.push({
      awardId: award.id, label: award.label, stakeholderId: award.stakeholderId, stakeholderName: holder?.name ?? 'Unknown',
      department: departments[award.stakeholderId] ?? null, type: award.type, grantDate: award.grantDate, quantity: award.quantity,
      fairValuePerShare: atEnd.fairValuePerShare, totalFairValue: atEnd.totalFairValue, expense, cumulative: cumulativeEnd, unrecognized, remainingYears,
      status: award.status, cancelledQuantity: award.cancelledQuantity, cancellationDate: recordedCancellations(award)[0]?.date ?? null,
    });
  }

  const totals = rows.reduce((t, r) => {
    t.expense += r.expense; t.cumulative += r.cumulative; t.unrecognized += r.unrecognized;
    t.byType[r.type] = (t.byType[r.type] ?? 0) + r.expense;
    return t;
  }, { expense: 0, cumulative: 0, unrecognized: 0, byType: {} as Partial<Record<AwardType, Cents>>, weightedRemainingYears: 0 });
  const unrecognizedTotal = rows.reduce((s, r) => s + r.unrecognized, 0);
  totals.weightedRemainingYears = unrecognizedTotal > 0
    ? rows.reduce((s, r) => s + r.remainingYears * r.unrecognized, 0) / unrecognizedTotal : 0;

  const byDepartmentMap = new Map<string, { expense: Cents; awards: number }>();
  for (const r of rows) {
    const key = r.department ?? 'Unassigned';
    const d = byDepartmentMap.get(key) ?? { expense: 0, awards: 0 };
    d.expense += r.expense; d.awards += 1;
    byDepartmentMap.set(key, d);
  }
  const byDepartment = [...byDepartmentMap.entries()].map(([department, d]) => ({ department, ...d })).sort((a, b) => b.expense - a.expense);

  // Option roll-forward for the footnote.
  const options = data.awards.filter((a) => OPTION_TYPES.includes(a.type) && a.status !== 'DRAFT' && a.status !== 'PENDING_APPROVAL' && a.status !== 'PENDING_SIGNATURE');
  const exercises = (opts.exercises ?? (data.exercises ?? []).filter((e) => e.status === 'COMPLETED').map((e) => ({ awardId: e.awardId, quantity: e.quantity, exerciseDate: e.exerciseDate })));
  const exercisedBy = (a: Award, d: ISODate) => exercises.filter((e) => e.awardId === a.id && e.exerciseDate <= d).reduce((s, e) => s + e.quantity, 0);
  const cancelledBy = (a: Award, d: ISODate) => recordedCancellations(a).filter((c) => c.date <= d).reduce((s, c) => s + c.quantity, 0);
  const leftOn = (a: Award): ISODate | null => data.stakeholders.find((s) => s.id === a.stakeholderId)?.terminationDate ?? null;
  const vestedAt = (a: Award, d: ISODate) => {
    const schedule = data.vestingSchedules.find((s) => s.id === a.vestingScheduleId);
    if (!schedule) return a.quantity;
    return buildVestingSchedule({ schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate, terminationDate: leftOn(a) })
      .filter((e) => e.date <= d).reduce((s, e) => s + e.quantity, 0);
  };
  // A leaver's options lapse whether or not anything is on record: the unvested ones are
  // forfeited the day the holder leaves, and vested ones not exercised expire when the
  // post-termination window closes. The window is captable.ts awardIsLive's: the policy's
  // months when the grant records none, and a recorded 0 closes it the day the holder leaves.
  const unvestedOnLeaving = new Map<string, number>();
  const forfeitedBy = (a: Award, d: ISODate) => {
    const left = leftOn(a);
    if (!left || left > d) return cancelledBy(a, d);
    if (!unvestedOnLeaving.has(a.id)) unvestedOnLeaving.set(a.id, roundShares(a.quantity - vestedAt(a, left)));
    return Math.max(cancelledBy(a, d), unvestedOnLeaving.get(a.id)!);
  };
  const windowClosesOn = (a: Award): ISODate | null => {
    const left = leftOn(a);
    return left && (a.type === 'ISO' || a.type === 'NSO') ? addMonths(left, a.ptepMonths ?? enginePolicy().postTerminationExerciseMonths) : null;
  };
  const expiredBy = (a: Award, d: ISODate) => {
    const closes = windowClosesOn(a);
    return ((a.expirationDate && a.expirationDate < d) || (closes && closes < d)) ? Math.max(0, a.quantity - exercisedBy(a, d) - forfeitedBy(a, d)) : 0;
  };
  const outstandingAt = (a: Award, d: ISODate) => a.grantDate <= d ? Math.max(0, a.quantity - exercisedBy(a, d) - forfeitedBy(a, d) - expiredBy(a, d)) : 0;
  const fmvEnd = activeValuation(data, period.end <= asOf ? period.end : asOf);
  const startRows = options.map((a) => ({ count: outstandingAt(a, before), strike: a.strikePrice })).filter((r) => r.count > 0);
  const grantedRows = options.filter((a) => a.grantDate >= period.start && a.grantDate <= period.end).map((a) => ({ count: a.quantity, strike: a.strikePrice, fv: rows.find((r) => r.awardId === a.id)?.fairValuePerShare ?? 0 }));
  const exercisedRows = options.map((a) => ({ count: exercisedBy(a, period.end) - exercisedBy(a, before), strike: a.strikePrice })).filter((r) => r.count > 0);
  const forfeitedRows = options.map((a) => ({ count: forfeitedBy(a, period.end) - forfeitedBy(a, before), strike: a.strikePrice })).filter((r) => r.count > 0);
  const expiredRows = options.map((a) => ({ count: expiredBy(a, period.end) - expiredBy(a, before), strike: a.strikePrice })).filter((r) => r.count > 0);
  const endRows = options.map((a) => ({ a, count: outstandingAt(a, period.end), strike: a.strikePrice })).filter((r) => r.count > 0);
  const exercisableRows = options.map((a) => ({ a, count: Math.max(0, Math.min(outstandingAt(a, period.end), vestedAt(a, period.end) - exercisedBy(a, period.end))), strike: a.strikePrice })).filter((r) => r.count > 0);
  const termDays = assumedTermDays();
  const remainingTerm = (rs: { a: Award; count: number }[]) => {
    const n = rs.reduce((s, r) => s + r.count, 0);
    return n > 0 ? rs.reduce((s, r) => s + r.count * Math.max(0, yearsBetween(period.end, r.a.expirationDate ?? addDays(r.a.grantDate, termDays))), 0) / n : 0;
  };
  const intrinsic = (rs: { a: Award; count: number }[]) => rs.reduce((s, r) => s + Math.max(0, shareValue(r.count, fmvEnd) - shareValue(r.count, r.a.strikePrice)), 0);
  const grantedCount = grantedRows.reduce((s, r) => s + r.count, 0);

  const rollforward: OptionRollforward = {
    outstandingStart: { count: startRows.reduce((s, r) => s + r.count, 0), waep: waep(startRows) },
    granted: { count: grantedCount, waep: waep(grantedRows), fairValuePerShare: grantedCount > 0 ? Math.round(grantedRows.reduce((s, r) => s + r.count * r.fv, 0) / grantedCount) : 0 },
    exercised: { count: exercisedRows.reduce((s, r) => s + r.count, 0), waep: waep(exercisedRows) },
    forfeited: { count: forfeitedRows.reduce((s, r) => s + r.count, 0), waep: waep(forfeitedRows) },
    expired: { count: expiredRows.reduce((s, r) => s + r.count, 0), waep: waep(expiredRows) },
    outstandingEnd: { count: endRows.reduce((s, r) => s + r.count, 0), waep: waep(endRows), remainingContractualYears: remainingTerm(endRows), intrinsicValue: intrinsic(endRows) },
    exercisableEnd: { count: exercisableRows.reduce((s, r) => s + r.count, 0), waep: waep(exercisableRows), remainingContractualYears: remainingTerm(exercisableRows), intrinsicValue: intrinsic(exercisableRows) },
  };

  return {
    period, quarters: quarterTotals.map((q) => ({ period: q.period, expense: Math.round(q.expense) })), assumptions,
    awards: rows.sort((a, b) => b.expense - a.expense || a.grantDate.localeCompare(b.grantDate)),
    totals, byDepartment, rollforward, excluded,
  };
}
