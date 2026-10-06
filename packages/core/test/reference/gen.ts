/**
 * Seeded generators for property and differential tests, from the audit's fuzz
 * scripts. Same seed, same cases, so a failure can be replayed and then pinned as a
 * golden test. Names are fictional ("Holder 7"). Imports only types.
 */
import type { CompanyData, VestingSchedule, VestingFrequency } from '../../src/types.ts';
import { emptyCompany } from '../../src/types.ts';
import type { WaterfallSpec } from './waterfall.ts';
import type { RefRound, RefSafe } from './safes.ts';

export type Rng = () => number;

/** mulberry32: a 32-bit seeded generator returning numbers in [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: Rng, list: readonly T[]): T => list[Math.floor(r() * list.length)];
/** A date between two years inclusive, on day 1..28 so month arithmetic never clamps. */
export const date = (r: Rng, fromYear: number, toYear: number): string =>
  `${int(r, fromYear, toYear)}-${String(int(r, 1, 12)).padStart(2, '0')}-${String(int(r, 1, 28)).padStart(2, '0')}`;

/** 1-3 preferred classes over common, with optional options; the shape of the audit's 12,400-table fuzz. */
export function randomWaterfallSpec(r: Rng): WaterfallSpec {
  const prefs: NonNullable<WaterfallSpec['prefs']> = [];
  const nPref = int(r, 1, 3);
  for (let i = 0; i < nPref; i++) {
    const part = pick(r, ['NP', 'NP', 'FP', 'CP'] as const);
    prefs.push({
      id: `P${i}`, shares: 500_000 + int(r, 0, 3_999) * 1000, oip: pick(r, [0.5, 1, 1.25, 2, 3.5, 5]),
      mult: pick(r, [1, 1, 1, 1.5, 2]), seniority: int(r, 1, 3), part, cap: part === 'CP' ? pick(r, [2, 2.5, 3, 4]) : null,
    });
  }
  const options: NonNullable<WaterfallSpec['options']> = [];
  const nOpt = int(r, 0, 2);
  for (let i = 0; i < nOpt; i++) options.push({ holder: `Holder ${i + 1}`, shares: 100_000 + int(r, 0, 899) * 1000, strike: pick(r, [0.01, 0.1, 0.5, 1, 2, 4]) });
  return { common: [{ holder: 'Founder', shares: 2_000_000 + int(r, 0, 9_999) * 1000 }], prefs, options };
}

/** An exit value between 0.3x and 6.3x the total preference of a spec, in dollars. */
export function randomExit(r: Rng, spec: WaterfallSpec): number {
  const prefTotal = (spec.prefs ?? []).reduce((s, p) => s + p.shares * p.oip * (p.mult ?? 1), 0);
  return Math.round(prefTotal * (0.3 + r() * 6));
}

/** Post-money SAFEs for solvePostMoneySafes, in dollars; caps never take 95% or more. */
export function randomPostSafes(r: Rng): { base: number; roundPrice: number; safes: { amount: number; cap: number | null; discount: number }[] } {
  for (;;) {
    const n = int(r, 1, 4);
    const base = Math.round(1e6 + r() * 2e7);
    const roundPrice = Math.round(1e5 + r() * 3e6) / 1e6;
    const safes = Array.from({ length: n }, () => ({
      amount: Math.round(5e4 + r() * 3e6), cap: r() < 0.85 ? Math.round(2e6 + r() * 3e7) : null,
      discount: r() < 0.5 ? Math.round(r() * 30) / 100 : 0,
    }));
    if (safes.reduce((s, c) => s + (c.cap ? c.amount / c.cap : 0), 0) < 0.95) return { base, roundPrice, safes };
  }
}

/** A priced round over a pre-round table of founders, granted options and an unissued pool, with 0-4 SAFEs. */
export function randomRound(r: Rng): RefRound & { founders: number; granted: number } {
  for (;;) {
    const founders = Math.round(1e6 + r() * (r() < 0.3 ? 2e8 : 2e7));
    const granted = Math.round(founders * r() * 0.15);
    const unissued = Math.round(founders * r() * 0.1);
    const safes: RefSafe[] = [];
    const n = int(r, 0, 4);
    for (let i = 0; i < n; i++) {
      safes.push({ kind: r() < 0.7 ? 'POST' : 'PRE', cap: r() < 0.85 ? Math.round(2e6 + r() * 4e7) : null,
        amount: Math.round(5e4 + r() * 2e6), discount: r() < 0.4 ? Math.round(r() * 25) / 100 : 0 });
    }
    if (safes.filter((s) => s.kind === 'POST' && s.cap).reduce((a, s) => a + s.amount / s.cap!, 0) > 0.6) continue;
    return {
      founders, granted, baseFD: founders + granted + unissued, poolAvailable: unissued,
      preMoney: Math.round(2e6 + r() * 6e7), raise: Math.round(5e5 + r() * 2e7),
      targetPool: r() < 0.3 ? 0 : Math.round(r() * 20) / 100, safes,
    };
  }
}

/** A vesting schedule with optional termination and change of control, as in the audit's 3,527-schedule sweep. */
export function randomVesting(r: Rng): { schedule: VestingSchedule; totalQuantity: number; vestingStartDate: string; terminationDate: string | null; changeOfControlDate: string | null } {
  const durationMonths = int(r, 0, 60);
  const frequency = pick(r, ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'WEEKLY', 'DAILY'] as VestingFrequency[]);
  const schedule: VestingSchedule = {
    id: 'vs_random', name: 'Random', kind: 'TIME', durationMonths, cliffMonths: int(r, 0, durationMonths), frequency,
    immediatePortion: pick(r, [0, 0, 0.1, 0.25]), yearWeights: r() < 0.25 ? [0.1, 0.2, 0.3, 0.4] : null, milestones: null,
    customTranches: null, accelerationSingleTrigger: pick(r, [0, 0, 0.5, 1, 0.33]), accelerationDoubleTrigger: pick(r, [0, 0.5, 1]),
    accelerationMonths: r() < 0.25 ? int(r, 1, 24) : null,
  };
  const start = date(r, 2020, 2023);
  const later = () => date(r, Number(start.slice(0, 4)), Number(start.slice(0, 4)) + 5);
  return {
    schedule, totalQuantity: int(r, 1, 250_000), vestingStartDate: start,
    terminationDate: r() < 0.5 ? later() : null, changeOfControlDate: r() < 0.5 ? later() : null,
  };
}

/** Common plus one preferred class, eight holders, grants, a warrant and SAFEs: the audit's 800-table cap table fuzz. */
export function randomCapTable(r: Rng): CompanyData {
  const d = emptyCompany();
  const cls = (id: string, name: string, kind: 'COMMON' | 'PREFERRED', oip: number, ratio: number, issueDate: string) => ({
    id, name, kind, authorized: 100_000_000, parValue: 10, seniority: kind === 'COMMON' ? 0 : 1, originalIssuePrice: oip,
    liquidationMultiple: 1, participation: 'NON_PARTICIPATING' as const, participationCap: null, conversionRatio: ratio,
    dividendType: 'NONE' as const, dividendRate: 0, dividendCompounding: false, dividendsParticipateInResidual: false,
    votesPerShare: 1, antiDilution: 'NONE' as const, payToPlay: false, issueDate, isConvertible: kind === 'PREFERRED',
  });
  d.shareClasses = [cls('common', 'Common', 'COMMON', 100, 1, '2020-01-01'),
    cls('pa', 'Series A', 'PREFERRED', int(r, 10, 300) * 10_000, pick(r, [1, 1, 1.0345, 2]), '2022-01-01')];
  d.vestingSchedules = [{
    id: 'vs_4y', name: '4 years, 1-year cliff', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0,
    yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null,
  }];
  for (let i = 0; i < 8; i++) {
    d.stakeholders.push({ id: `h${i}`, name: `Holder ${i}`, email: null, type: 'INDIVIDUAL', relation: pick(r, ['FOUNDER', 'EMPLOYEE', 'INVESTOR', 'ADVISOR'] as const),
      startDate: '2020-01-01', terminationDate: r() < 0.2 ? date(r, 2022, 2024) : null, taxCountry: 'US', taxState: 'DE', entityGroupId: null });
  }
  let n = 0;
  const iss = (classId: string, quantity: number, price: number, issueDate: string) => d.issuances.push({
    id: `is_${++n}`, certificateNo: null, stakeholderId: `h${int(r, 0, 7)}`, shareClassId: classId, quantity, pricePerShare: price, issueDate,
    status: 'OUTSTANDING', vestingScheduleId: null, vestingStartDate: null, earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  for (let i = 0; i < 6; i++) iss('common', int(r, 1, 5_000_000), 100, date(r, 2020, 2021));
  for (let i = 0; i < 3; i++) iss('pa', int(r, 1, 2_000_000), 1_000_000, date(r, 2022, 2023));
  d.pools = [{ id: 'pool', name: 'Stock Plan', shareClassId: 'common', authorized: int(r, 1_000_000, 4_000_000), boardApprovalDate: '2020-01-01',
    shareholderApprovalDate: '2020-01-01', returnForfeituresToPool: true, evergreenPercent: null, planType: 'STOCK_PLAN' }];
  for (let i = 0; i < 6; i++) {
    const quantity = int(r, 1_000, 300_000);
    const status = pick(r, ['OUTSTANDING', 'OUTSTANDING', 'OUTSTANDING', 'CANCELLED', 'EXPIRED', 'DRAFT'] as const);
    d.awards.push({
      id: `aw_${i}`, label: null, stakeholderId: `h${int(r, 0, 7)}`, poolId: 'pool', type: pick(r, ['ISO', 'NSO', 'RSU'] as const), quantity,
      strikePrice: 100_000, grantDate: date(r, 2020, 2023), vestingStartDate: '2021-01-01', vestingScheduleId: 'vs_4y', status,
      expirationDate: '2031-01-01', ptepMonths: 3, earlyExerciseAllowed: false,
      exercisedQuantity: status === 'OUTSTANDING' ? int(r, 0, Math.floor(quantity / 4)) : 0,
      cancelledQuantity: status === 'OUTSTANDING' ? int(r, 0, Math.floor(quantity / 4)) : 0,
      boardApprovalDate: null, acceptedDate: null, fmvAtGrant: 100_000, rsuLiquidityCondition: false, notes: null,
    });
  }
  d.warrants.push({ id: 'wt_1', stakeholderId: `h${int(r, 0, 7)}`, shareClassId: 'common', quantity: int(r, 1, 100_000), strikePrice: 1_000_000,
    issueDate: date(r, 2020, 2023), expirationDate: '2031-01-01', status: 'OUTSTANDING', exercisedQuantity: 0, netExercise: false, notes: null });
  const safe = (instrument: 'SAFE_POST' | 'SAFE_PRE', i: number) => d.convertibles.push({
    id: `cv_${i}`, stakeholderId: `h${int(r, 0, 7)}`, instrument, principal: int(r, 1, 20) * 50_000_00, issueDate: date(r, 2020, 2023),
    valuationCap: int(r, 5, 40) * 1_000_000_00, discount: 0, interestRate: 0, compounding: 'SIMPLE', maturityDate: null, mfn: false,
    proRataRight: false, status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null, notes: null,
  });
  if (r() < 0.7) safe('SAFE_POST', 1);
  if (r() < 0.4) safe('SAFE_PRE', 2);
  d.valuations.push({ id: 'val_1', type: '409A', fairMarketValue: 250_000, effectiveDate: '2020-06-01', expirationDate: null, provider: null, reportUrl: null, status: 'ACTIVE' });
  return d;
}
