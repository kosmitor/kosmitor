/**
 * Golden cases for vesting and stock-compensation accounting (vesting.ts,
 * accounting.ts), from published worked examples. Each test cites its source. A test
 * marked { todo: 'BUG-ID' } pins the correct value for a confirmed bug
 * (math-audit-2026-10-05.md, section 2) and passes once the bug is fixed.
 *
 * FAS 123(R), Appendix A illustrations (ASC 718-20-55): https://storage.fasb.org/aop_fas123R.pdf
 * PwC Viewpoint, Stock-based compensation 2.8:
 *   https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/stockbased_compensat/stockbased_compensat__3_US/chapter_2_measuremen_US/28_awards_with_grade_US.html
 * OCF AllocationType: https://open-cap-table-coalition.github.io/Open-Cap-Format-OCF/schema_markdown/schema/enums/AllocationType/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVestingSchedule, vestedQuantity, summarizeVesting } from '../src/vesting.ts';
import {
  blackScholes, normalCdf, valueAward, cumulativeExpense, stockCompReport, fiscalYear, fiscalQuarters,
  DEFAULT_STOCK_COMP_ASSUMPTIONS, type AwardValuation, type StockCompAssumptions,
} from '../src/accounting.ts';
import { addDays, dollarsToCents as $, dollarsToPPS as $$ } from '../src/util.ts';
import { awardIsLive } from '../src/captable.ts';
import type { Award, CompanyData } from '../src/types.ts';
import { company, holder, award, schedule, customSchedule, valuation } from './builders.ts';
import { refAddMonths, refMonthlyVested, refTranches } from './reference/vesting.ts';
import { refBlackScholesCall, refNormalCdf } from './reference/black-scholes.ts';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const dollars = (cents: number) => Math.round(cents / 100);

// ---------------------------------------------------------------------------
// Vesting
// ---------------------------------------------------------------------------

const fourYearCliff = schedule();
const grant48k = { schedule: fourYearCliff, totalQuantity: 48_000, vestingStartDate: '2024-01-01' };

test('OCF CUMULATIVE_ROUND_DOWN: 18 shares over four annual tranches vest 4, 5, 4, 5', () => {
  const s = schedule({ cliffMonths: 0, frequency: 'ANNUAL' });
  assert.deepEqual(buildVestingSchedule({ schedule: s, totalQuantity: 18, vestingStartDate: '2024-01-01' }).map((e) => e.quantity), [4, 5, 4, 5]);
  assert.deepEqual(refTranches(18, 4), [4, 5, 4, 5]);
});

test('OCF CUMULATIVE_ROUND_DOWN: 10,001 shares on 4 years with a 1-year cliff vest 2,500, then floor(10,001k/48) steps, 10,001 in all', () => {
  const months = refTranches(10_001, 48);
  const expected = [months.slice(0, 12).reduce((s, q) => s + q, 0), ...months.slice(12)];
  const events = buildVestingSchedule({ schedule: fourYearCliff, totalQuantity: 10_001, vestingStartDate: '2024-01-01' });
  assert.equal(expected[0], 2_500);
  assert.deepEqual(events.map((e) => e.quantity), expected);
  assert.equal(events.reduce((s, e) => s + e.quantity, 0), 10_001);
});

test('Calendar months: a grant starting Jan 31 vests on Feb 29, Mar 31, Apr 30 … Jan 31, with no drift', () => {
  const events = buildVestingSchedule({ schedule: schedule({ durationMonths: 12, cliffMonths: 0 }), totalQuantity: 1_200, vestingStartDate: '2024-01-31' });
  assert.deepEqual(events.map((e) => e.date), ['2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30', '2024-07-31',
    '2024-08-31', '2024-09-30', '2024-10-31', '2024-11-30', '2024-12-31', '2025-01-31']);
  assert.ok(events.every((e) => e.quantity === 100));
});

test('Plan forfeiture terms: leaving the day before the cliff vests nothing, leaving on the cliff date vests 12,000', () => {
  assert.equal(vestedQuantity({ ...grant48k, terminationDate: '2024-12-31' }, '2030-01-01'), 0);
  assert.equal(vestedQuantity({ ...grant48k, terminationDate: '2025-01-01' }, '2030-01-01'), 12_000);
});

test('Independent reference: monthly vesting with a cliff matches cumulative round-down on 6,120 dates', () => {
  // 12 awkward totals x 5 start dates (month ends and leap days) x every month from 0 to 50,
  // on the vest date and the day before. The schedule is built once per grant and read the way
  // vestedQuantity reads it (the last event on or before the date), which keeps this to a second.
  let checked = 0;
  for (const total of [1, 7, 47, 48, 49, 100, 1_001, 10_001, 12_345, 100_001, 200_000, 1_234_567]) {
    for (const start of ['2024-01-31', '2024-02-29', '2023-08-31', '2024-01-01', '2024-03-30']) {
      const ctx = { schedule: fourYearCliff, totalQuantity: total, vestingStartDate: start };
      const events = buildVestingSchedule(ctx);
      const vestedOn = (asOf: string) => events.filter((e) => e.date <= asOf).at(-1)?.cumulative ?? 0;
      assert.equal(vestedQuantity(ctx, '2027-06-15'), vestedOn('2027-06-15'));
      for (let m = 0; m <= 50; m++) {
        const day = refAddMonths(start, m);
        const dayBefore = new Date(Date.parse(day) - 864e5).toISOString().slice(0, 10);
        for (const asOf of [dayBefore, day]) {
          assert.equal(vestedOn(asOf), refMonthlyVested(total, start, 48, 12, asOf), `${total} from ${start} on ${asOf}`);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 6_120);
});

test('Single-trigger acceleration needs service through the change of control: a leaver keeps 17,000', () => {
  // 48,000 on 4y/1y from 2024-01-01, 100% single trigger; left 2025-06-15 with 17,000 vested; change of
  // control 2026-01-01. The forfeited 31,000 do not come back. Before the VA-1 fix the app returned 48,000;
  // the waterfall reaches this path because it sets the change of control to its as-of date.
  const ctx = { ...grant48k, schedule: schedule({ accelerationSingleTrigger: 1 }), terminationDate: '2025-06-15', changeOfControlDate: '2026-01-01' };
  assert.equal(vestedQuantity(ctx, '2026-01-01'), 17_000);
});

test('Partial single trigger then termination: the accelerated half plus the scaled tranches served, 38,500', () => {
  // 24,000 vested at the 2026-01-01 change of control; 50% of the 24,000 unvested accelerate; the other
  // 12,000 keep vesting at 500 a month until the 2026-06-15 departure (5 tranches): 38,500. The app's
  // own test "a partial single trigger scales the remaining tranches" uses the same rule. Before the VA-6
  // fix the app gave 36,000, on every date after the change of control, including before the departure.
  const ctx = { ...grant48k, schedule: schedule({ accelerationSingleTrigger: 0.5 }), changeOfControlDate: '2026-01-01', terminationDate: '2026-06-15' };
  assert.equal(vestedQuantity(ctx, '2030-01-01'), 38_500);
  assert.equal(vestedQuantity(ctx, '2026-02-01'), 36_500);
});

test('Months-of-credit acceleration counts from the termination when the holder left before the change of control', () => {
  // Double trigger with 6 months of credit; left 2025-02-15 with 13,000 vested; change of control
  // 2025-12-01. Six more months of service credit is 6 x 1,000: 19,000. Before the VA-7 fix the app
  // counted the months from the change of control: 29,000.
  const ctx = { ...grant48k, schedule: schedule({ accelerationDoubleTrigger: 1, accelerationMonths: 6 }), terminationDate: '2025-02-15', changeOfControlDate: '2025-12-01' };
  assert.equal(vestedQuantity(ctx, '2030-01-01'), 19_000);
});

test('OCF CUMULATIVE_ROUND_DOWN: a whole-share grant never vests a fraction of a share', () => {
  // 25% upfront on 1,001 shares vests 250 (before the VA-8 fix: 250.25, then 187.6875 …); a 50% single
  // trigger on 48,001 accelerates whole shares (before: 12,000.5).
  const upfront = buildVestingSchedule({ schedule: schedule({ immediatePortion: 0.25 }), totalQuantity: 1_001, vestingStartDate: '2024-01-01' });
  assert.equal(upfront[0].quantity, 250);
  assert.ok(upfront.every((e) => Number.isInteger(e.quantity)), 'fractional tranche');
  assert.equal(upfront.reduce((s, e) => s + e.quantity, 0), 1_001);
  const accelerated = buildVestingSchedule({ schedule: schedule({ accelerationSingleTrigger: 0.5 }), totalQuantity: 48_001, vestingStartDate: '2024-01-01', changeOfControlDate: '2026-01-01' });
  assert.ok(accelerated.every((e) => Number.isInteger(e.quantity)), 'fractional acceleration');
});

test('OCF CUMULATIVE_ROUND_DOWN: custom thirds of 1,000 vest 333, 333, 334 and the grant becomes fully vested', () => {
  // Before the VA-9 fix the app vested 333.333333 three times and never reached 1,000.
  const thirds = customSchedule('vs_thirds', [{ date: '2025-01-01', portion: 1 / 3 }, { date: '2026-01-01', portion: 1 / 3 }, { date: '2027-01-01', portion: 1 / 3 }]);
  const s = summarizeVesting({ schedule: thirds, totalQuantity: 1_000, vestingStartDate: '2024-01-01' }, '2030-01-01');
  assert.deepEqual(s.events.map((e) => e.quantity), [333, 333, 334]);
  assert.equal(s.fullyVestedDate, '2027-01-01');
});

test('Year weights: each weight is its year\'s share of the grant, and a final part-year keeps its whole weight (10/20/30/40 on 42 months)', () => {
  // PwC SC 2-19 reads 10/20/30/40 as the share vesting in each year. VA-16 asked for a definition for a
  // schedule that is not whole years: before it, 42 months read the weights as monthly rates and vested
  // 12.5 / 25 / 37.5 / 25%. Now the fourth year's 40% vests over its six months.
  const ctx = { schedule: schedule({ durationMonths: 42, cliffMonths: 0, yearWeights: [0.1, 0.2, 0.3, 0.4] }), totalQuantity: 1_000, vestingStartDate: '2024-01-01' };
  assert.deepEqual(['2025-01-01', '2026-01-01', '2027-01-01', '2027-04-01', '2027-07-01'].map((d) => vestedQuantity(ctx, d)), [100, 300, 600, 800, 1_000]);
  // Whole years are unchanged, and a ratable schedule with a part-year still vests evenly by month.
  assert.equal(vestedQuantity({ ...ctx, schedule: schedule({ yearWeights: [0.1, 0.2, 0.3, 0.4] }) }, '2026-01-01'), 300);
  assert.equal(vestedQuantity({ ...ctx, schedule: schedule({ durationMonths: 42, cliffMonths: 0 }), totalQuantity: 42_000 }, '2027-01-01'), 36_000);
});

// ---------------------------------------------------------------------------
// Option pricing
// ---------------------------------------------------------------------------

test('Hull Ex.15.6: S 42, K 40, T 0.5, σ 0.2, r 0.10 gives a call of 4.7594', () => {
  const v = blackScholes({ spot: 42, strike: 40, termYears: 0.5, volatility: 0.2, riskFreeRate: 0.10, dividendYield: 0 });
  near(v, 4.759422, 1e-4, 'call');
  near(refBlackScholesCall(42, 40, 0.5, 0.2, 0.10), 4.759422, 1e-6, 'reference');
});

test('Hull Ex.17.1: S 930, K 900, T 2/12, σ 0.2, r 0.08, q 0.03 gives a call of 51.83', () => {
  const v = blackScholes({ spot: 930, strike: 900, termYears: 2 / 12, volatility: 0.2, riskFreeRate: 0.08, dividendYield: 0.03 });
  near(v, 51.832957, 1e-4, 'call');
  near(refBlackScholesCall(930, 900, 2 / 12, 0.2, 0.08, 0.03), 51.832957, 1e-6, 'reference');
});

test('Abramowitz & Stegun 26.2.17: normalCdf is within 7.5e-8 of N(x) on [-6, 6], and N(x) + N(-x) = 1 within twice that', () => {
  let worst = 0;
  for (let i = -600; i <= 600; i++) {
    const x = i / 100;
    worst = Math.max(worst, Math.abs(normalCdf(x) - refNormalCdf(x)));
    near(normalCdf(x) + normalCdf(-x), 1, 1.5e-7, `symmetry at ${x}`);
  }
  assert.ok(worst <= 7.5e-8, `max error ${worst}`);
});

/** One employee, no other grants. */
function oneEmployee(o: Partial<CompanyData> = {}): CompanyData {
  return company({ stakeholders: [holder('h1', 'Employee', 'EMPLOYEE')], ...o });
}
const assume = (o: Partial<StockCompAssumptions> = {}): StockCompAssumptions => ({ ...DEFAULT_STOCK_COMP_ASSUMPTIONS, ...o });

test('SAB 110 fn 77 simplified method: 25% a year for 4 years with a 10-year term gives 5.5 / 6.0 / 6.5 / 7.0, 6.25 overall', () => {
  // https://www.sec.gov/interps/account/sab110.htm. ±0.002 years: the app counts years as days/365.25.
  const d = oneEmployee({ vestingSchedules: [schedule({ cliffMonths: 0, frequency: 'ANNUAL' })] });
  const a = award('h1', 100_000, { type: 'NSO', strikePrice: $$(1), fmvAtGrant: $$(1), grantDate: '2024-01-01', expirationDate: '2034-01-01', vestingScheduleId: 'vs_4y' });
  const v = valueAward(d, a, assume({ expectedTermYears: null }))!;
  v.tranches.forEach((t, i) => near(t.expectedTermYears, 5.5 + 0.5 * i, 0.002, `tranche ${i + 1}`));
  near(v.tranches.reduce((s, t) => s + t.quantity * t.expectedTermYears, 0) / 100_000, 6.25, 0.002, 'weighted');
});

// ---------------------------------------------------------------------------
// ASC 718 attribution: FAS 123(R) Illustration 4
// ---------------------------------------------------------------------------

/** Illustration 4(a): 900,000 options worth $14.69 each, cliff vesting after 3 years from 20X5-01-01. Valued as RSUs so the fair value is exactly $14.69. */
function illustration4a(): { d: CompanyData; a: Award } {
  const a = award('h1', 900_000, { id: 'ill4a', type: 'RSU', strikePrice: 0, fmvAtGrant: $$(14.69), grantDate: '2025-01-01', vestingScheduleId: 'vs_cliff3' });
  return { d: oneEmployee({ vestingSchedules: [schedule({ id: 'vs_cliff3', durationMonths: 36, cliffMonths: 36 })], awards: [a] }), a };
}
const estimate = (rate: number) => assume({ forfeiturePolicy: 'ESTIMATE', forfeitureRate: rate, attribution: 'GRADED' });

test('FAS 123(R) Ill. 4(a), ¶A91: 3% estimated forfeitures recognise $4,022,151 a year, judged at the start of the next year', () => {
  // 900,000 x 0.97^3 = 821,406 expected to vest; $12,066,454 / 3 = $4,022,151. The app raises 0.97 to
  // 1,095 / 365.25 = 2.998 years, which adds $250 a year: tolerance $300 a year.
  const { d, a } = illustration4a();
  const v = valueAward(d, a, estimate(0.03))!;
  near(dollars(cumulativeExpense(v, estimate(0.03), '2026-01-01')), 4_022_151, 300, '20X5');
  near(dollars(cumulativeExpense(v, estimate(0.03), '2027-01-01')), 8_044_303, 600, '20X6');
});

test('FAS 123(R) Ill. 4(a), ¶A92: revising the estimate to 6% in 20X6 brings cumulative cost to $7,320,771', () => {
  // 747,526 options x $14.69 x 2/3. FASB rounds the expected options to whole options and the app
  // uses 2.998 years: tolerance $1,000.
  const { d, a } = illustration4a();
  near(dollars(cumulativeExpense(valueAward(d, a, estimate(0.06))!, estimate(0.06), '2027-01-01')), 7_320_771, 1_000, '20X6');
});

/** Illustration 4(b): the same grant as three tranches valued $13.44, $14.17 and $14.69 (Table 3), net of forfeitures. */
function illustration4b(front = false): AwardValuation {
  const tranche = (vestDate: string, quantity: number, fv: number) =>
    ({ vestDate, quantity, expectedTermYears: 0, fairValuePerShare: $$(fv), fairValue: Math.round(quantity * fv * 100) });
  const tranches = front
    ? [tranche('2026-01-01', 436_500, 13.44), tranche('2027-01-01', 211_725, 14.17), tranche('2028-01-01', 205_350, 14.69)]
    : [tranche('2026-01-01', 218_250, 13.44), tranche('2027-01-01', 211_725, 14.17), tranche('2028-01-01', 410_700, 14.69)];
  return {
    award: {} as Award, fairValuePerShare: 0, totalFairValue: tranches.reduce((s, t) => s + t.fairValue, 0), tranches,
    serviceStart: '2025-01-01', serviceEnd: '2028-01-01',
  };
}

test('FAS 123(R) Ill. 4(b), Table 4: graded attribution reaches $6,444,412 / $9,955,545 / $11,966,606 by each anniversary', () => {
  // ±$2: FASB rounds each tranche's yearly cost to dollars.
  const v = illustration4b();
  near(dollars(v.totalFairValue), 11_966_606, 1, 'total cost');
  const graded = assume({ forfeiturePolicy: 'AS_OCCUR', attribution: 'GRADED' });
  [6_444_412, 9_955_545, 11_966_606].forEach((want, i) =>
    near(dollars(cumulativeExpense(v, graded, `${2026 + i}-01-01`)), want, 2, `year ${i + 1}`));
});

test('FAS 123(R) ¶42 and ¶A102: straight-line recognises $3,988,868 a year, and the vested portion is a floor ($5,866,560 with 50% vesting in year 1)', () => {
  const sl = assume({ forfeiturePolicy: 'AS_OCCUR', attribution: 'STRAIGHT_LINE' });
  [11_966_606 / 3, 11_966_606 * 2 / 3, 11_966_606].forEach((want, i) =>
    near(dollars(cumulativeExpense(illustration4b(), sl, `${2026 + i}-01-01`)), want, 1, `year ${i + 1}`));
  near(dollars(cumulativeExpense(illustration4b(true), sl, '2026-01-01')), 5_866_560, 1, 'floor');
});

test('PwC SC 2-19: 10/20/30/40 vesting on straight-line recognises $250,000 a year', () => {
  // 100,000 awards worth $10. ±$700: PwC divides by whole years, the app by days, and one of the four
  // years is a leap year (one day of a 1,461-day service period is $684).
  const d = oneEmployee({ vestingSchedules: [schedule({ cliffMonths: 0, frequency: 'ANNUAL', yearWeights: [0.1, 0.2, 0.3, 0.4] })] });
  const v = valueAward(d, award('h1', 100_000, { type: 'RSU', strikePrice: 0, fmvAtGrant: $$(10), grantDate: '2024-01-01' }), assume())!;
  const sl = assume({ attribution: 'STRAIGHT_LINE' });
  ['2025-01-01', '2026-01-01', '2027-01-01', '2028-01-01'].forEach((asOf, i) =>
    near(dollars(cumulativeExpense(v, sl, asOf)), 250_000 * (i + 1), 700, asOf));
});

test('PwC SC 2-20: with a forfeiture estimate the vested 25% still sets the floor, $250,000 in year 1', () => {
  // The estimate alone would give $242,500.
  const d = oneEmployee({ vestingSchedules: [schedule({ cliffMonths: 0, frequency: 'ANNUAL' })] });
  const v = valueAward(d, award('h1', 100_000, { type: 'RSU', strikePrice: 0, fmvAtGrant: $$(10), grantDate: '2024-01-01' }), assume())!;
  near(dollars(cumulativeExpense(v, assume({ attribution: 'STRAIGHT_LINE', forfeiturePolicy: 'ESTIMATE', forfeitureRate: 0.03 }), '2025-01-01')), 250_000, 1, 'year 1');
});

// The report closes a fiscal year at the end of its last day. Before the VA-3 fix it evaluated Dec 31
// as the start of that day, so the last day of service fell into the next year. These pin the
// year-end figures the sources give.

test('FAS 123(R) Ill. 4(a), ¶A91: the 20X5 report shows $4,022,151 of expense', () => {
  // Tolerance $300 for the 2.998-year exponent (see the Jan 1 test). Before the VA-3 fix: $4,011,381.
  const { d } = illustration4a();
  const r = stockCompReport(d, 2025, { asOf: '2030-01-01', assumptions: { forfeiturePolicy: 'ESTIMATE', forfeitureRate: 0.03, attribution: 'GRADED' } });
  near(dollars(r.totals.expense), 4_022_151, 300, 'FY2025');
});

test('FAS 123(R) Ill. 4(b), Table 4: the yearly reports show cumulative $6,444,412 / $9,955,545 / $11,966,606', () => {
  // Three RSU-valued grants, one per tranche, vesting on the anniversaries. Before the VA-3 fix: $6,426,757 for 20X5.
  const tranches: [string, number, number][] = [['2026-01-01', 218_250, 13.44], ['2027-01-01', 211_725, 14.17], ['2028-01-01', 410_700, 14.69]];
  const d = oneEmployee({
    vestingSchedules: tranches.map(([date, quantity], i) => customSchedule(`vs_t${i}`, [{ date, quantity }])),
    awards: tranches.map(([, quantity, fv], i) => award('h1', quantity, { id: `t${i}`, type: 'RSU', strikePrice: 0, fmvAtGrant: $$(fv), grantDate: '2025-01-01', vestingScheduleId: `vs_t${i}` })),
  });
  const cumulative = (year: number) => dollars(stockCompReport(d, year, { asOf: '2030-01-01', assumptions: { forfeiturePolicy: 'AS_OCCUR', attribution: 'GRADED' } }).totals.cumulative);
  [6_444_412, 9_955_545, 11_966_606].forEach((want, i) => near(cumulative(2025 + i), want, 2, `FY${2025 + i}`));
});

test('FAS 123(R) ¶A102: with 50% vesting after year 1, the 20X5 report recognises at least $5,866,560', () => {
  // 436,500 of 853,575 shares at $13.44 vest on 2026-01-01, after a full year of service. Before the
  // VA-3 fix the app gave $3,813,539 at 2025-12-31.
  const s = customSchedule('vs_front', [{ date: '2026-01-01', quantity: 436_500 }, { date: '2027-01-01', quantity: 211_725 }, { date: '2028-01-01', quantity: 205_350 }]);
  const d = oneEmployee({ vestingSchedules: [s], awards: [award('h1', 853_575, { type: 'RSU', strikePrice: 0, fmvAtGrant: $$(13.44), grantDate: '2025-01-01', vestingScheduleId: 'vs_front' })] });
  const r = stockCompReport(d, 2025, { asOf: '2030-01-01', assumptions: { forfeiturePolicy: 'AS_OCCUR', attribution: 'STRAIGHT_LINE' } });
  near(dollars(r.totals.cumulative), 5_866_560, 1, 'FY2025');
});

test('PwC SC 2-21: front-loaded restricted stock (50/25/25) granted July 1 has at least $150 of $300 recognised by June 30', () => {
  // Fiscal year ending June 30, 20X2, straight-line. Before the VA-3 fix: $99.64.
  const d = oneEmployee({
    vestingSchedules: [schedule({ durationMonths: 36, cliffMonths: 0, frequency: 'ANNUAL', yearWeights: [0.5, 0.25, 0.25] })],
    awards: [award('h1', 300, { type: 'RSU', strikePrice: 0, fmvAtGrant: $$(1), grantDate: '2021-07-01' })],
  });
  const r = stockCompReport(d, 2022, { fiscalYearEnd: '06-30', asOf: '2030-01-01', assumptions: { attribution: 'STRAIGHT_LINE' } });
  assert.ok(r.totals.cumulative >= $(150), `cumulative ${r.totals.cumulative / 100}`);
});

test('FAS 123(R) ¶15: restricted stock bought at fair value carries no compensation cost', () => {
  // The cost is fair value less what the employee pays ($50 - $5 = $45 in ¶15). 1,000,000 shares bought
  // at the $0.10 FMV cost nothing; before the VA-5 fix the app booked $100,000.
  const d = oneEmployee();
  const a = award('h1', 1_000_000, { type: 'RSA', strikePrice: $$(0.10), fmvAtGrant: $$(0.10), grantDate: '2024-01-01' });
  assert.equal(valueAward(d, a, assume())!.totalFairValue, 0);
  // ¶15's own figures: a $50 share bought for $5 costs $45.
  const paid = award('h1', 1, { type: 'RSA', strikePrice: $$(5), fmvAtGrant: $$(50), grantDate: '2024-01-01' });
  assert.equal(valueAward(d, paid, assume())!.totalFairValue, $(45));
});

test('ASU 2016-09, ASC 718-10-35-3: a leaver\'s unvested RSUs stop costing anything at termination ($17,000 for good)', () => {
  // 48,000 RSUs at $1 on 4y/1y from 2024-01-01; left 2025-06-15 with 17,000 vested; no cancellation on
  // record yet. Forfeitures as they occur: cumulative $17,000 from FY2025. Before the VA-4 fix the app
  // kept expensing: $40,384, $46,230, $47,999.
  const d = oneEmployee({ awards: [award('h1', 48_000, { type: 'RSU', strikePrice: 0, fmvAtGrant: $$(1), grantDate: '2024-01-01' })] });
  d.stakeholders[0].terminationDate = '2025-06-15';
  for (const year of [2025, 2026, 2027]) {
    const r = stockCompReport(d, year, { asOf: '2030-01-01', assumptions: { forfeiturePolicy: 'AS_OCCUR', attribution: 'GRADED' } });
    assert.equal(r.totals.cumulative, $(17_000), `FY${year}`);
  }
});

test('FAS 123(R) ¶A91: under estimated forfeitures, recognised plus unrecognised cost is the expected cost, $12,066,454', () => {
  // Before the VA-11 fix the app put the gross $13,221,000 on the unrecognised side. Tolerance $800 for
  // the 2.998-year exponent (see the Jan 1 test).
  const { d } = illustration4a();
  const r = stockCompReport(d, 2025, { asOf: '2030-01-01', assumptions: { forfeiturePolicy: 'ESTIMATE', forfeitureRate: 0.03, attribution: 'GRADED' } });
  near(dollars(r.totals.cumulative + r.totals.unrecognized), 12_066_454, 800, 'expected cost');
});

test('Calendar: a fiscal year ending on the last day of February has month-end quarters and a real end date', () => {
  // Before the VA-14 fix, '02-28' gave quarters ending May 28, Aug 28, Nov 28 in FY2025 but May 31, Aug 31,
  // Nov 30 in FY2026; '02-29' gave the impossible 2025-02-29 and left 2025-03-01 in no fiscal year.
  assert.deepEqual(fiscalQuarters(fiscalYear(2025, '02-28')).map((q) => q.end), ['2024-05-31', '2024-08-31', '2024-11-30', '2025-02-28']);
  assert.equal(fiscalYear(2025, '02-29').end, '2025-02-28');
  assert.equal(fiscalYear(2026, '02-29').start, '2025-03-01');
});

test('ASC 718-30-35-3: cash-settled phantom units are remeasured each period ($3 FMV, halfway: $15,000)', () => {
  // 10,000 units granted at $1, vesting 25% a year from 2024-01-01; FMV $3 at the end of year 2.
  // Liability accounting: 10,000 x $3 x 2/4. ±$30 for the day count at the year end. Before the VA-15
  // fix the app kept the grant-date value: $4,997.
  const d = oneEmployee({
    vestingSchedules: [schedule({ cliffMonths: 0, frequency: 'ANNUAL' })],
    awards: [award('h1', 10_000, { type: 'PHANTOM', strikePrice: 0, fmvAtGrant: $$(1), grantDate: '2024-01-01' })],
    valuations: [valuation({ fairMarketValue: $$(3), effectiveDate: '2025-12-01' })],
  });
  const r = stockCompReport(d, 2025, { asOf: '2030-01-01', assumptions: { attribution: 'STRAIGHT_LINE' } });
  near(dollars(r.totals.cumulative), 15_000, 30, 'FY2025');
});

test('accounting.ts contract: a cancellation with no date on record is taken on one date in every report, so the years tie', () => {
  // 48,000 RSUs at $1 from 2023-01-01, 4y/1y, 24,000 cancelled with no date; every report run on 2026-06-01.
  // The cancellation is taken on the as-of date in each fiscal year's report, so each year's closing cost is
  // the next year's opening. Before the fix each report dated it at its own period end and reversed it again
  // every year: FY2024 opened at $28,265.55 although FY2023 closed at $14,132.78.
  const d = oneEmployee({ awards: [award('h1', 48_000, { id: 'aw_c', type: 'RSU', strikePrice: 0, fmvAtGrant: $$(1), grantDate: '2023-01-01', expirationDate: null, cancelledQuantity: 24_000 })] });
  const opts = { asOf: '2026-06-01', assumptions: { forfeiturePolicy: 'AS_OCCUR' as const, attribution: 'GRADED' as const } };
  const years = [2023, 2024, 2025, 2026].map((y) => stockCompReport(d, y, opts));
  assert.deepEqual(years.map((r) => r.awards[0].cancellationDate), ['2026-06-01', '2026-06-01', '2026-06-01', '2026-06-01']);
  assert.equal(years[0].totals.expense, years[0].totals.cumulative);
  for (let i = 1; i < years.length; i++) assert.equal(years[i - 1].totals.cumulative + years[i].totals.expense, years[i].totals.cumulative, `FY${2023 + i}`);
  // The same as dating it 2026-06-01 outright; and a holder who left is taken to have forfeited on leaving.
  assert.equal(years[1].totals.cumulative, stockCompReport(d, 2024, { ...opts, cancellationDates: { aw_c: '2026-06-01' } }).totals.cumulative);
  d.stakeholders[0].terminationDate = '2024-03-01';
  assert.deepEqual([2023, 2024, 2025].map((y) => stockCompReport(d, y, opts).awards[0].cancellationDate), ['2024-03-01', '2024-03-01', '2024-03-01']);
});

test('accounting.ts contract: each of several cancellations reverses cost from its own date, not from the first one', () => {
  // 1,000 options cancelled in 2023 and 30,000 in 2025 on one grant. Until the 2025 cancellation the
  // cost is that of the grant with only the 2023 one; before the VA-18 fix all 31,000 reversed from 2023.
  const grant = (cancelledQuantity: number) => oneEmployee({ awards: [award('h1', 48_000, { id: 'aw_m', strikePrice: $$(1), fmvAtGrant: $$(1), grantDate: '2023-01-01', expirationDate: '2033-01-01', cancelledQuantity })] });
  const both = { asOf: '2030-01-01', cancellations: { aw_m: [{ date: '2025-06-01', quantity: 30_000 }, { date: '2023-06-01', quantity: 1_000 }] } };
  const firstOnly = { asOf: '2030-01-01', cancellationDates: { aw_m: '2023-06-01' } };
  for (const year of [2023, 2024]) {
    assert.equal(stockCompReport(grant(31_000), year, both).totals.cumulative, stockCompReport(grant(1_000), year, firstOnly).totals.cumulative, `FY${year}`);
  }
  assert.deepEqual([2023, 2024, 2025].map((y) => stockCompReport(grant(31_000), y, both).rollforward.forfeited.count), [1_000, 0, 30_000]);
});

test('captable.ts awardIsLive contract: the option roll-forward lets a leaver\'s options lapse when the exercise window closes, a recorded 0 on the day they leave', () => {
  // PTEP-0, the roll-forward side. An NSO for 48,000 on 4y/1y from 2024-01-01; the holder left 2025-06-15
  // with 17,000 vested and nothing on record. The 31,000 unvested are forfeited that day and the 17,000
  // vested expire when the window closes, on the same day the cap table stops counting the grant.
  for (const [ptepMonths, closes] of [[0, '2025-06-15'], [3, '2025-09-15']] as const) {
    const a = award('h1', 48_000, { id: 'aw_ptep', type: 'NSO', strikePrice: $$(1), fmvAtGrant: $$(1), grantDate: '2024-01-01', expirationDate: '2034-01-01', ptepMonths });
    const d = oneEmployee({ awards: [a] });
    d.stakeholders[0].terminationDate = '2025-06-15';
    for (const day of [closes, addDays(closes, 1)]) {
      // A fiscal year ending on `day` reads the roll-forward at the end of that day.
      const rf = stockCompReport(d, 2025, { fiscalYearEnd: day.slice(5), asOf: '2030-01-01' }).rollforward;
      assert.equal(rf.outstandingEnd.count, awardIsLive(a, day, '2025-06-15') ? 17_000 : 0, `${ptepMonths}-month window, ${day}`);
    }
    const fy = stockCompReport(d, 2025, { asOf: '2030-01-01' }).rollforward;
    assert.deepEqual([fy.forfeited.count, fy.expired.count, fy.outstandingEnd.count, fy.exercisableEnd.count], [31_000, 17_000, 0, 0], `${ptepMonths}-month window`);
  }
});
