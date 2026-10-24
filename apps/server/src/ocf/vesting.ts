/**
 * Vesting schedules and OCF vesting terms, both ways.
 *
 * OCF describes vesting as a graph of conditions: a start, then triggers relative to
 * an earlier condition (a cliff twelve months after the start, then monthly 36 times),
 * on absolute dates, or on events, each vesting a portion of the security or a fixed
 * quantity. Kosmitor's allocation is OCF's CUMULATIVE_ROUND_DOWN: the shares vested
 * by each date are the whole shares of the exact fraction vested by then
 * (`distribute` in packages/core/src/vesting.ts).
 *
 * - termsFromSchedule: a schedule as terms, and whether the terms say exactly what the
 *   schedule does. Every exported schedule carries itself in the Kosmitor note, so a
 *   Kosmitor import gets it back whatever OCF can say.
 * - evaluateTerms: what terms vest for one security, the way an OCF reader works it out.
 *   The export compares it with Kosmitor's own schedule per security, and writes the
 *   security's `vestings` when they differ.
 * - scheduleFromTerms: terms read back as a Kosmitor schedule: from the note while its
 *   digest matches, else by recognising the usual shapes, else per security.
 */
import { buildVestingSchedule, roundShares, addDays, MAX_VESTING_MONTHS, type ISODate, type VestingSchedule } from '@kosmitor/core';
import { CONDITION, type OcfPortion, type OcfVesting, type OcfVestingCondition, type OcfVestingTerms } from './types.ts';
import { fractionOf, isCalendarDate, isNumeric, ocfNumeric } from './convert.ts';
import { commentsWith, readNote, termsDigest, writeNote, type NotedSchedule } from './notes.ts';

const PERIOD_MONTHS: Partial<Record<VestingSchedule['frequency'], number>> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };
const FREQUENCY_OF_MONTHS = new Map<unknown, VestingSchedule['frequency']>([[1, 'MONTHLY'], [3, 'QUARTERLY'], [12, 'ANNUAL']]);

/**
 * Bounds on terms read from a package, so a few bytes cannot ask for millions of dates:
 * conditions in one path, dates one security's vesting may have, and the years a date
 * may fall in. Terms past them are refused (ocf-unsupported) rather than worked out.
 */
export const MAX_CONDITIONS = 500;
export const MAX_TERMS_DATES = 20_000;
const FIRST_DAY = '1900-01-01', LAST_DAY = '2200-12-31';
/** A day vesting may fall on: a calendar day from 1900 to 2200. */
export const isVestingDay = (d: unknown): d is ISODate => typeof d === 'string' && isCalendarDate(d) && d >= FIRST_DAY && d <= LAST_DAY;
const FREQUENCY_WORDS: Record<VestingSchedule['frequency'], string> = { MONTHLY: 'monthly', QUARTERLY: 'quarterly', ANNUAL: 'annually', WEEKLY: 'weekly', DAILY: 'daily' };

/** Shares vesting on a date. */
export interface Tranche { date: ISODate; quantity: number }

/** Terms OCF cannot follow in one path (a condition with two next conditions, a cycle, an unknown id). */
export class VestingTermsError extends Error {
  readonly code = 'ocf-unsupported' as const;
}

const percent = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/** A schedule in a sentence, for the terms' description and the import's summary: "48 months, 12-month cliff, then monthly". */
export function describeSchedule(s: Omit<VestingSchedule, 'id' | 'name'>): string {
  let out: string;
  if (s.kind === 'FULLY_VESTED' || (s.kind === 'TIME' && s.durationMonths === 0)) out = 'Fully vested at the vesting start';
  else if (s.kind === 'CUSTOM') {
    const n = s.customTranches?.length ?? 0;
    out = n === 0 ? 'Nothing vests' : `${n} ${n === 1 ? 'tranche' : 'tranches'} on set dates`;
  } else if (s.kind === 'MILESTONE') {
    const ms = s.milestones ?? [];
    out = ms.length ? `Milestones: ${ms.map((m) => `${m.name} (${percent(m.portion)})`).join(', ')}` : 'Milestones: none';
  } else {
    const freq = FREQUENCY_WORDS[s.frequency];
    out = `${s.durationMonths} months, ${s.cliffMonths > 0 ? `${s.cliffMonths}-month cliff, then ${freq}` : freq}`;
    if (s.immediatePortion > 0) out = `${percent(s.immediatePortion)} at the vesting start, then ${out}`;
    if (s.yearWeights?.length) out += `, weighted ${s.yearWeights.map(percent).join(' / ')} by year`;
  }
  const extra: string[] = [];
  if (s.accelerationSingleTrigger > 0) extra.push(`${percent(s.accelerationSingleTrigger)} of unvested shares accelerate on a change of control`);
  if (s.accelerationDoubleTrigger > 0) extra.push(`${percent(s.accelerationDoubleTrigger)} of unvested shares accelerate on a termination around a change of control`);
  if (s.accelerationMonths != null && (s.accelerationSingleTrigger > 0 || s.accelerationDoubleTrigger > 0)) extra.push(`acceleration credits ${s.accelerationMonths} months`);
  return extra.length ? `${out}; ${extra.join('; ')}` : out;
}

/** A portion as the simplest fraction, or a decimal over 1 when it has none. */
function portionOf(x: number): OcfPortion {
  const f = fractionOf(x, 10_000);
  return f ? { numerator: String(f.n), denominator: String(f.d) } : { numerator: ocfNumeric(x), denominator: '1' };
}

const relativeMonths = (relativeTo: string, length: number, occurrences: number): OcfVestingCondition['trigger'] => ({
  type: 'VESTING_SCHEDULE_RELATIVE',
  period: { type: 'MONTHS', length, occurrences, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' },
  relative_to_condition_id: relativeTo,
});

/**
 * A schedule as OCF vesting terms (id and name the schedule's), with
 * `allocation_type` CUMULATIVE_ROUND_DOWN, and whether the conditions say exactly
 * what the schedule vests:
 *
 * - TIME: start, a cliff of C/D after C months, then p/D every p months. Exact for
 *   monthly, quarterly or annual vesting with no year weights, nothing at the start,
 *   and a cliff and duration in whole periods; otherwise the same shape in decimals.
 * - FULLY_VESTED: everything at the start. Exact.
 * - CUSTOM: start, then each tranche on its date. Exact.
 * - MILESTONE: start, then each milestone as an event, achieved ones first by date
 *   (OCF follows one path). Not exact: the security's TX_VESTING_EVENTs say when.
 *
 * Acceleration has no OCF form: it is in the description and the note.
 */
export function termsFromSchedule(s: VestingSchedule): { terms: OcfVestingTerms; exact: boolean } {
  const conditions: OcfVestingCondition[] = [];
  let exact = true;
  const start: OcfVestingCondition = { id: CONDITION.start, description: 'Vesting start', quantity: '0', trigger: { type: 'VESTING_START_DATE' }, next_condition_ids: [] };
  conditions.push(start);
  const chain = (c: OcfVestingCondition): void => {
    conditions[conditions.length - 1].next_condition_ids = [c.id];
    conditions.push(c);
  };

  if (s.kind === 'FULLY_VESTED' || (s.kind === 'TIME' && s.durationMonths === 0)) {
    delete start.quantity;
    start.portion = { numerator: '1', denominator: '1' };
  } else if (s.kind === 'TIME') {
    const D = s.durationMonths, C = s.cliffMonths;
    const p = PERIOD_MONTHS[s.frequency] ?? null;
    const imm = Math.min(1, Math.max(0, s.immediatePortion));
    exact = p != null && !s.yearWeights?.length && imm === 0 && C % p === 0 && D % p === 0;
    if (imm > 0) { delete start.quantity; start.portion = portionOf(imm); }
    const rest = 1 - imm;
    const cliffPortion = C > 0 ? (rest * C) / D : 0;
    if (C > 0) {
      chain({
        id: CONDITION.cliff, description: `${C}-month cliff`,
        portion: exact ? { numerator: String(C), denominator: String(D) } : portionOf(cliffPortion),
        trigger: relativeMonths(CONDITION.start, C, 1), next_condition_ids: [],
      });
    }
    if (D > C) {
      const after = C > 0 ? CONDITION.cliff : CONDITION.start;
      if (p != null) {
        const occurrences = exact ? (D - C) / p : Math.ceil((D - C) / p);
        chain({
          id: CONDITION.periodic, description: `Every ${p === 1 ? 'month' : `${p} months`}`,
          portion: exact ? { numerator: String(p), denominator: String(D) } : portionOf((rest - cliffPortion) / occurrences),
          trigger: relativeMonths(after, p, occurrences), next_condition_ids: [],
        });
      } else {
        const length = s.frequency === 'WEEKLY' ? 7 : 1;
        const occurrences = Math.max(1, Math.ceil(Math.round(((D - C) * 365.25) / 12) / length));
        chain({
          id: CONDITION.periodic, description: s.frequency === 'WEEKLY' ? 'Every week' : 'Every day',
          portion: portionOf((rest - cliffPortion) / occurrences),
          trigger: { type: 'VESTING_SCHEDULE_RELATIVE', period: { type: 'DAYS', length, occurrences }, relative_to_condition_id: after },
          next_condition_ids: [],
        });
      }
    }
  } else if (s.kind === 'CUSTOM') {
    const tranches = (s.customTranches ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    tranches.forEach((t, i) => chain({
      id: CONDITION.tranche(i + 1), description: `Tranche ${i + 1}`,
      ...(t.quantity != null ? { quantity: ocfNumeric(t.quantity) } : { portion: portionOf(t.portion ?? 0) }),
      trigger: { type: 'VESTING_SCHEDULE_ABSOLUTE', date: t.date }, next_condition_ids: [],
    }));
  } else {
    exact = false;
    const ms = (s.milestones ?? []).map((m, i) => ({ m, i }));
    const achieved = ms.filter(({ m }) => m.achievedDate).sort((a, b) => a.m.achievedDate!.localeCompare(b.m.achievedDate!) || a.i - b.i);
    const pending = ms.filter(({ m }) => !m.achievedDate).sort((a, b) => (a.m.targetDate ?? '9999').localeCompare(b.m.targetDate ?? '9999') || a.i - b.i);
    for (const { m } of [...achieved, ...pending]) {
      chain({
        id: CONDITION.milestone(m.id), description: m.name, portion: portionOf(m.portion),
        trigger: { type: 'VESTING_EVENT' }, next_condition_ids: [],
      });
    }
  }

  const terms: OcfVestingTerms = {
    id: s.id, object_type: 'VESTING_TERMS', name: s.name, description: describeSchedule(s),
    allocation_type: 'CUMULATIVE_ROUND_DOWN', vesting_conditions: conditions,
  };
  const { id: _id, name: _name, ...rest } = s;
  const schedule: NotedSchedule = { ...rest, milestones: s.milestones?.map((m) => ({ ...m, achievedDate: null })) ?? null };
  const comments = commentsWith([], writeNote({ schedule, digest: termsDigest(terms.allocation_type, terms.vesting_conditions) }));
  if (comments) terms.comments = comments;
  return { terms, exact };
}

/**
 * What a schedule vests for one security, merged by date, with no termination or
 * change of control: the dates and amounts an exported security's `vestings` lists.
 */
export function scheduleTranches(schedule: VestingSchedule, quantity: number, vestingStartDate: ISODate): Tranche[] {
  return mergeByDate(buildVestingSchedule({ schedule, totalQuantity: quantity, vestingStartDate })
    .filter((e) => e.kind !== 'ACCELERATION').map((e) => ({ date: e.date, quantity: e.quantity })));
}

function mergeByDate(tranches: Tranche[]): Tranche[] {
  const out: Tranche[] = [];
  for (const t of tranches.slice().sort((a, b) => a.date.localeCompare(b.date))) {
    const last = out[out.length - 1];
    if (last && last.date === t.date) last.quantity = roundShares(last.quantity + t.quantity);
    else out.push({ ...t });
  }
  return out.filter((t) => t.quantity > 0);
}

/** Two lists of tranches that vest the same shares on the same dates. */
export function sameTranches(a: Tranche[], b: Tranche[]): boolean {
  const x = mergeByDate(a), y = mergeByDate(b);
  return x.length === y.length && x.every((t, i) => t.date === y[i].date && Math.abs(t.quantity - y[i].quantity) <= 1e-6);
}

/**
 * The `vestings` an exported security needs: none when the terms, read the way an OCF
 * reader reads them, vest what Kosmitor vests for it; else Kosmitor's own dates and
 * amounts (a single zero on the start date when nothing vests).
 */
export function vestingsFor(schedule: VestingSchedule, terms: OcfVestingTerms, quantity: number, vestingStartDate: ISODate, events: ReadonlyMap<string, ISODate> = new Map()): OcfVesting[] | undefined {
  const own = scheduleTranches(schedule, quantity, vestingStartDate);
  try {
    if (sameTranches(own, evaluateTerms(terms, { quantity, startDate: vestingStartDate, events }))) return undefined;
  } catch { /* terms OCF cannot follow: the vestings say it all */ }
  return own.length ? own.map((t) => ({ date: t.date, amount: ocfNumeric(t.quantity) })) : [{ date: vestingStartDate, amount: '0' }];
}

// ---------------------------------------------------------------------------
// Reading terms
// ---------------------------------------------------------------------------

/**
 * The conditions in the order OCF follows them: from the first, each to its one next
 * condition. Conditions off that path are never reached. Two next conditions, a
 * cycle or an id that is not there throw VestingTermsError.
 */
export function linearChain(conditions: OcfVestingCondition[]): OcfVestingCondition[] {
  if (!Array.isArray(conditions) || conditions.length === 0) throw new VestingTermsError('The vesting terms have no conditions.');
  if (conditions.length > MAX_CONDITIONS) throw new VestingTermsError(`The vesting terms have ${conditions.length.toLocaleString('en-US')} conditions; Kosmitor reads at most ${MAX_CONDITIONS}.`);
  const byId = new Map<string, OcfVestingCondition>();
  for (const c of conditions) {
    if (!c || typeof c.id !== 'string' || !c.trigger || typeof c.trigger !== 'object' || !Array.isArray(c.next_condition_ids)) throw new VestingTermsError('A vesting condition is missing its id, trigger or next conditions.');
    if (byId.has(c.id)) throw new VestingTermsError(`Two vesting conditions have the id ${c.id}.`);
    byId.set(c.id, c);
  }
  const chain: OcfVestingCondition[] = [];
  const seen = new Set<string>();
  let c: OcfVestingCondition | undefined = conditions[0];
  while (c) {
    if (seen.has(c.id)) throw new VestingTermsError(`The vesting conditions loop back to ${c.id}.`);
    seen.add(c.id);
    chain.push(c);
    if (c.next_condition_ids.length > 1) throw new VestingTermsError(`Vesting condition ${c.id} leads to ${c.next_condition_ids.length} conditions; Kosmitor follows vesting terms with one path.`);
    const next: string | undefined = c.next_condition_ids[0];
    if (next === undefined) break;
    c = byId.get(next);
    if (!c) throw new VestingTermsError(`Vesting condition ${chain[chain.length - 1].id} leads to ${next}, which is not in the terms.`);
  }
  return chain;
}

// Exact fractions, so portions such as 1/48 add up to the whole grant.
type Q = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const q = (n: bigint, d = 1n): Q => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const less = (a: Q, b: Q): boolean => a.n * b.d < b.n * a.d;
const floorQ = (a: Q): bigint => (a.n >= 0n ? a.n / a.d : -((-a.n + a.d - 1n) / a.d));
const toNumber = (a: Q): number => Number(a.n) / Number(a.d);
function decimal(s: string): Q {
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace(/^[+-]/, '').split('.');
  const v = q(BigInt(whole + frac), 10n ** BigInt(frac.length));
  return neg ? q(-v.n, v.d) : v;
}
const exact = (n: number): Q => decimal(ocfNumeric(n));

/** `months` calendar months after `base`, on the day `rule` says (OCF VestingDayOfMonth), or the month's last day when it has no such day. */
export function monthsAfter(base: ISODate, months: number, rule: string, vestingStartDate: ISODate): ISODate {
  const [y, m, d] = base.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const ty = Math.floor(index / 12), tm = index - ty * 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const wanted = rule === 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' ? Number(vestingStartDate.slice(8, 10))
    : /^\d\d/.test(rule) ? Number(rule.slice(0, 2)) : d;
  return `${String(ty).padStart(4, '0')}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(wanted, last)).padStart(2, '0')}`;
}

/** A relative trigger's period, checked: whole lengths, 1 to 10,000 occurrences, at most 200 years in all. */
function periodOf(c: OcfVestingCondition): { type: 'MONTHS' | 'DAYS'; length: number; occurrences: number; day_of_month?: string } {
  const t = c.trigger as { period?: { type?: unknown; length?: unknown; occurrences?: unknown; day_of_month?: unknown } };
  const p = t.period;
  const ok = !!p && (p.type === 'MONTHS' || p.type === 'DAYS') && Number.isInteger(p.length) && (p.length as number) >= 0
    && Number.isInteger(p.occurrences) && (p.occurrences as number) >= 1 && (p.occurrences as number) <= 10_000
    && (p.length as number) * (p.occurrences as number) <= (p.type === 'MONTHS' ? 2_400 : 73_100);
  if (!ok) throw new VestingTermsError(`Vesting condition ${c.id} has a period Kosmitor cannot follow.`);
  return p as { type: 'MONTHS' | 'DAYS'; length: number; occurrences: number; day_of_month?: string };
}

/** How many dates evaluateTerms works out for terms (refused past MAX_TERMS_DATES), without working them out. */
export function termsDateCount(terms: Pick<OcfVestingTerms, 'vesting_conditions'>): number {
  let n = 0;
  for (const c of linearChain(terms.vesting_conditions)) n += c.trigger.type === 'VESTING_SCHEDULE_RELATIVE' ? periodOf(c).occurrences : 1;
  return n;
}

/**
 * What terms vest for one security of `quantity`, the way an OCF reader works it out:
 * along the one path from the first condition, the start on `startDate`, an absolute
 * trigger on its date, a relative one `occurrences` times after the condition it is
 * relative to (months on the day `day_of_month` says, or days), an event on the date of
 * the security's TX_VESTING_EVENT for it (`events`; one that never happened stops the
 * path there). Each condition vests its quantity, or its portion of the security, or
 * of what is still unvested with `remainder`. Shares are allocated cumulatively
 * rounded down (CUMULATIVE_ROUND_DOWN): whole shares on a whole-share security, to the
 * micro-share otherwise. A condition never fires before the one before it.
 *
 * Terms with more than MAX_TERMS_DATES dates, a period past 200 years, or a date
 * outside 1900 to 2200 throw VestingTermsError, as terms OCF cannot follow do.
 */
export function evaluateTerms(terms: Pick<OcfVestingTerms, 'vesting_conditions'>, opts: { quantity: number; startDate: ISODate | null; events?: ReadonlyMap<string, ISODate> }): Tranche[] {
  const chain = linearChain(terms.vesting_conditions);
  const dateCount = termsDateCount(terms);
  if (dateCount > MAX_TERMS_DATES) throw new VestingTermsError(`These vesting terms vest on ${dateCount.toLocaleString('en-US')} dates; Kosmitor reads at most ${MAX_TERMS_DATES.toLocaleString('en-US')}.`);
  const ids = new Set(terms.vesting_conditions.map((c) => c.id));
  const total = exact(Math.max(0, opts.quantity));
  const whole = Number.isInteger(opts.quantity);
  const fired = new Map<string, ISODate>();
  const out: Tranche[] = [];
  let cum = q(0n);
  let vested = 0;
  let prev: ISODate | null = null;
  const later = (d: ISODate): ISODate => (prev && d < prev ? prev : d);
  const checked = (c: OcfVestingCondition, d: unknown): ISODate => {
    if (!isVestingDay(d)) throw new VestingTermsError(`Vesting condition ${c.id} vests on ${typeof d === 'string' ? d.slice(0, 40) : 'no date'}, which is not a date from 1900 to 2200.`);
    return d;
  };

  const credit = (date: ISODate, amount: Q): void => {
    cum = add(cum, amount);
    if (less(total, cum)) cum = total;
    if (less(cum, q(0n))) cum = q(0n);
    const target = whole ? Number(floorQ(cum)) : roundShares(toNumber(cum));
    const delta = roundShares(target - vested);
    if (delta <= 0) return;
    vested = target;
    const last = out[out.length - 1];
    if (last && last.date === date) last.quantity = roundShares(last.quantity + delta);
    else out.push({ date, quantity: delta });
  };
  const amountOf = (c: OcfVestingCondition): Q => {
    if (c.quantity != null) {
      if (!isNumeric(c.quantity)) throw new VestingTermsError(`Vesting condition ${c.id} has a quantity that is not a number.`);
      return decimal(c.quantity);
    }
    const p = c.portion;
    if (!p || !isNumeric(p.numerator) || !isNumeric(p.denominator) || Number(p.denominator) === 0) throw new VestingTermsError(`Vesting condition ${c.id} has no portion or quantity Kosmitor can read.`);
    const share = div(decimal(p.numerator), decimal(p.denominator));
    return mul(share, p.remainder ? sub(total, cum) : total);
  };

  for (const c of chain) {
    const t = c.trigger;
    let dates: ISODate[];
    if (t.type === 'VESTING_START_DATE') {
      if (!opts.startDate) break;
      dates = [later(checked(c, opts.startDate))];
    } else if (t.type === 'VESTING_SCHEDULE_ABSOLUTE') {
      dates = [later(checked(c, t.date))];
    } else if (t.type === 'VESTING_EVENT') {
      const on = opts.events?.get(c.id);
      if (!on) break;
      dates = [later(checked(c, on))];
    } else if (t.type === 'VESTING_SCHEDULE_RELATIVE') {
      if (typeof t.relative_to_condition_id !== 'string' || !ids.has(t.relative_to_condition_id)) throw new VestingTermsError(`Vesting condition ${c.id} is relative to ${String(t.relative_to_condition_id).slice(0, 120)}, which is not in the terms.`);
      const base = fired.get(t.relative_to_condition_id);
      if (!base) break;
      const period = periodOf(c);
      dates = [];
      for (let k = 1; k <= period.occurrences; k++) {
        dates.push(later(checked(c, period.type === 'MONTHS'
          ? monthsAfter(base, k * period.length, String(period.day_of_month ?? ''), opts.startDate ?? base)
          : addDays(base, k * period.length))));
      }
    } else {
      throw new VestingTermsError(`Vesting condition ${c.id} has a trigger Kosmitor does not know.`);
    }
    // The same amount on every date of a condition, but for a portion of what is left.
    const fixed = c.portion?.remainder ? null : amountOf(c);
    for (const d of dates) credit(d, fixed ?? amountOf(c));
    prev = dates[dates.length - 1];
    fired.set(c.id, prev);
  }
  return out;
}

/** How terms read as a Kosmitor schedule. */
export type ScheduleReading =
  /** One schedule for every security on the terms: the note's (`how` note) or a shape Kosmitor has (`recognised`). */
  | { kind: 'schedule'; schedule: NotedSchedule; how: 'note' | 'recognised' }
  /** A path Kosmitor has no schedule for: each security gets a CUSTOM schedule of what evaluateTerms vests for it. */
  | { kind: 'per-security' }
  /** Terms OCF itself would follow down more than one path (error ocf-unsupported). */
  | { kind: 'unsupported'; text: string };

const BLANK: NotedSchedule = {
  kind: 'CUSTOM', durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null,
  milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null,
};
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9;

/** A plain portion (no `remainder`) as a number, or null. */
function plainPortion(c: OcfVestingCondition): number | null {
  if (c.quantity != null || !c.portion || c.portion.remainder) return null;
  const { numerator, denominator } = c.portion;
  if (!isNumeric(numerator) || !isNumeric(denominator) || Number(denominator) <= 0) return null;
  return Number(numerator) / Number(denominator);
}
const zeroStart = (c: OcfVestingCondition): number | null =>
  c.quantity != null ? (isNumeric(c.quantity) && Number(c.quantity) === 0 ? 0 : null) : plainPortion(c);

/**
 * Terms as a Kosmitor schedule (the name is the terms'):
 * 1. the Kosmitor note's schedule, while its digest matches the conditions;
 * 2. a start with portion 1: FULLY_VESTED;
 * 3. a start, an optional cliff of C months, then every 1, 3 or 12 months on the vesting
 *    start's day, in ratable portions: TIME;
 * 4. a start, then absolute dates in order: CUSTOM;
 * 5. a start, then events: MILESTONE (each security's TX_VESTING_EVENTs date them).
 * Any other single path is read per security; more than one path is unsupported.
 */
export function scheduleFromTerms(terms: OcfVestingTerms): ScheduleReading {
  let chain: OcfVestingCondition[];
  try { chain = linearChain(terms.vesting_conditions); } catch (e) { return { kind: 'unsupported', text: (e as Error).message }; }

  const note = readNote(terms, 'VESTING_TERMS');
  if (note.schedule && note.digest && note.digest === termsDigest(terms.allocation_type, terms.vesting_conditions)) {
    return { kind: 'schedule', schedule: note.schedule, how: 'note' };
  }
  const recognised = (s: Partial<NotedSchedule>): ScheduleReading => ({ kind: 'schedule', schedule: { ...BLANK, ...s }, how: 'recognised' });
  const [first, ...rest] = chain;
  if (first.trigger.type !== 'VESTING_START_DATE') return { kind: 'per-security' };
  const p0 = zeroStart(first);
  if (p0 == null || p0 < 0 || p0 > 1 + 1e-9) return { kind: 'per-security' };
  if (rest.length === 0) return near(p0, 1) ? recognised({ kind: 'FULLY_VESTED', immediatePortion: 1 }) : { kind: 'per-security' };

  // TIME: [cliff] then periodic, months after the start on the start's day.
  const wholePeriod = (p: { length?: unknown; occurrences?: unknown } | undefined): boolean => !!p && Number.isInteger(p.length) && (p.length as number) > 0
    && Number.isInteger(p.occurrences) && (p.occurrences as number) >= 1 && (p.length as number) * (p.occurrences as number) <= MAX_VESTING_MONTHS;
  const months = rest.map((c) => (c.trigger.type === 'VESTING_SCHEDULE_RELATIVE' && c.trigger.period?.type === 'MONTHS' && wholePeriod(c.trigger.period)
    && c.trigger.period.day_of_month === 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' ? { c, period: c.trigger.period, to: c.trigger.relative_to_condition_id, portion: plainPortion(c) } : null));
  if (rest.length <= 2 && months.every((m) => m && m.portion != null)) {
    const m = months as { c: OcfVestingCondition; period: { length: number; occurrences: number }; to: string; portion: number }[];
    const left = 1 - p0;
    if (m.length === 1 && m[0].to === first.id) {
      const [r] = m;
      if (r.period.occurrences === 1 && r.period.length > 0 && near(r.portion, left)) {
        return recognised({ kind: 'TIME', durationMonths: r.period.length, cliffMonths: r.period.length, frequency: 'MONTHLY', immediatePortion: p0 });
      }
      const D = r.period.length * r.period.occurrences;
      const frequency = FREQUENCY_OF_MONTHS.get(r.period.length);
      if (frequency && D > 0 && near(r.portion, (left * r.period.length) / D)) {
        return recognised({ kind: 'TIME', durationMonths: D, cliffMonths: 0, frequency, immediatePortion: p0 });
      }
    }
    if (m.length === 2 && m[0].to === first.id && m[1].to === m[0].c.id && m[0].period.occurrences === 1) {
      const C = m[0].period.length, p = m[1].period.length, D = C + p * m[1].period.occurrences;
      const frequency = FREQUENCY_OF_MONTHS.get(p);
      if (frequency && C > 0 && C % p === 0 && D <= MAX_VESTING_MONTHS && near(m[0].portion, (left * C) / D) && near(m[1].portion, (left * p) / D)) {
        return recognised({ kind: 'TIME', durationMonths: D, cliffMonths: C, frequency, immediatePortion: p0 });
      }
    }
  }
  if (p0 !== 0) return { kind: 'per-security' };

  // CUSTOM: absolute dates in order, each a quantity or a portion.
  if (rest.every((c) => c.trigger.type === 'VESTING_SCHEDULE_ABSOLUTE')) {
    const tranches: { date: string; quantity?: number; portion?: number }[] = [];
    for (const c of rest) {
      const date = (c.trigger as { date: unknown }).date;
      if (!isVestingDay(date)) return { kind: 'per-security' };
      if (tranches.length && date < tranches[tranches.length - 1].date) return { kind: 'per-security' };
      if (c.quantity != null) {
        if (!isNumeric(c.quantity) || Number(c.quantity) < 0) return { kind: 'per-security' };
        tranches.push({ date, quantity: Number(c.quantity) });
      } else {
        const portion = plainPortion(c);
        if (portion == null || portion < 0 || portion > 1) return { kind: 'per-security' };
        tranches.push({ date, portion });
      }
    }
    return recognised({ kind: 'CUSTOM', customTranches: tranches });
  }

  // MILESTONE: events, each a portion.
  if (rest.every((c) => c.trigger.type === 'VESTING_EVENT' && plainPortion(c) != null)) {
    return recognised({
      kind: 'MILESTONE',
      milestones: rest.map((c) => ({
        id: (c.id.replace(/^milestone-/, '') || c.id).slice(0, 200), name: (typeof c.description === 'string' && c.description.trim() ? c.description.trim() : c.id).slice(0, 200),
        portion: plainPortion(c)!, targetDate: null, achievedDate: null,
      })),
    });
  }
  return { kind: 'per-security' };
}

/**
 * A per-security schedule from what evaluateTerms (or a security's `vestings`) says it
 * vests for `total` shares: each tranche as its portion of the security, so the
 * schedule still vests the right part of it after a split, a transfer of some of a
 * certificate or a repurchase, as every other schedule does. When portions cannot say
 * exactly what the tranches are (Kosmitor's rounding of them misses a share), the
 * tranches keep their share counts.
 */
export function customSchedule(tranches: Tranche[], total: number): NotedSchedule {
  const merged = mergeByDate(tranches);
  const counts: NotedSchedule = { ...BLANK, kind: 'CUSTOM', customTranches: merged.map((t) => ({ date: t.date, quantity: t.quantity })) };
  const sum = merged.reduce((n, t) => n + t.quantity, 0);
  if (!(total > 0) || !merged.length || sum > total + 1e-6) return counts;
  const portions: NotedSchedule = { ...BLANK, kind: 'CUSTOM', customTranches: merged.map((t) => ({ date: t.date, portion: t.quantity / total })) };
  try {
    const built = scheduleTranches({ ...portions, id: 'check', name: 'check' } as VestingSchedule, total, merged[0].date);
    if (sameTranches(built, merged)) return portions;
  } catch { /* the counts, then */ }
  return counts;
}
