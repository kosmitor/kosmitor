import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blackScholes, normalCdf, fiscalYear, fiscalQuarters, valueAward, cumulativeExpense, stockCompReport, DEFAULT_STOCK_COMP_ASSUMPTIONS } from '../src/accounting.ts';
import { seedCompany } from './fixtures.ts';
import type { Award, CompanyData } from '../src/types.ts';

const close = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('Black–Scholes reproduces textbook values', () => {
  close(normalCdf(0), 0.5, 1e-9, 'N(0)');
  close(normalCdf(1.96), 0.9750, 1e-4, 'N(1.96)');
  close(normalCdf(-1.96), 0.0250, 1e-4, 'N(-1.96)');
  // Hull's standard example: S=42, K=40, r=10%, σ=20%, T=0.5 → call 4.76
  close(blackScholes({ spot: 42, strike: 40, termYears: 0.5, volatility: 0.2, riskFreeRate: 0.1, dividendYield: 0 }), 4.76, 0.01, 'Hull call');
  // At the money, S=K=100, T=1, σ=20%, r=5% → 10.4506
  close(blackScholes({ spot: 100, strike: 100, termYears: 1, volatility: 0.2, riskFreeRate: 0.05, dividendYield: 0 }), 10.4506, 0.001, 'ATM call');
  // Degenerate cases: no time or no volatility gives intrinsic value; no strike gives the (dividend-discounted) share.
  assert.equal(blackScholes({ spot: 100, strike: 80, termYears: 0, volatility: 0.2, riskFreeRate: 0.05, dividendYield: 0 }), 20);
  assert.equal(blackScholes({ spot: 100, strike: 0, termYears: 1, volatility: 0.2, riskFreeRate: 0.05, dividendYield: 0 }), 100);
  assert.equal(blackScholes({ spot: 0, strike: 10, termYears: 1, volatility: 0.2, riskFreeRate: 0.05, dividendYield: 0 }), 0);
});

test('fiscal periods follow the company year end', () => {
  assert.deepEqual(fiscalYear(2026), { label: 'FY2026', start: '2026-01-01', end: '2026-12-31' });
  assert.deepEqual(fiscalYear(2026, '06-30'), { label: 'FY2026', start: '2025-07-01', end: '2026-06-30' });
  const q = fiscalQuarters(fiscalYear(2026, '06-30'));
  assert.deepEqual(q.map((x) => [x.start, x.end]), [['2025-07-01', '2025-09-30'], ['2025-10-01', '2025-12-31'], ['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30']]);
});

function company(): CompanyData {
  const d = seedCompany();
  d.awards = [];
  d.exercises = [];
  return d;
}
const award = (o: Partial<Award>): Award => ({
  id: 'aw_1', label: 'OPT-1', stakeholderId: 'sh_e', poolId: 'pool_1', type: 'ISO', quantity: 48_000, strikePrice: 1_000_000,
  grantDate: '2024-01-01', vestingStartDate: '2024-01-01', vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: '2034-01-01',
  ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2024-01-01', acceptedDate: null,
  fmvAtGrant: 1_000_000, rsuLiquidityCondition: false, notes: null, ...o,
});

test('an option is valued tranche by tranche with the simplified expected term; an RSU is worth its grant-date FMV', () => {
  const d = company();
  const iso = award({});
  const v = valueAward(d, iso, { ...DEFAULT_STOCK_COMP_ASSUMPTIONS, volatility: 0.5, riskFreeRate: 0.04 })!;
  assert.ok(v.tranches.length >= 37, `monthly schedule with a cliff yields many tranches, got ${v.tranches.length}`);   // cliff tranche + monthly
  assert.equal(v.serviceStart, '2024-01-01');
  assert.equal(v.serviceEnd, v.tranches[v.tranches.length - 1].vestDate);
  // First (cliff) tranche vests after a year: expected term = (1 + 10) / 2 = 5.5 years.
  close(v.tranches[0].expectedTermYears, 5.5, 0.01, 'cliff expected term');
  const atm = blackScholes({ spot: 1, strike: 1, termYears: 5.5, volatility: 0.5, riskFreeRate: 0.04, dividendYield: 0 });
  close(v.tranches[0].fairValuePerShare / 1e6, atm, 0.001, 'cliff tranche fair value');
  assert.ok(v.fairValuePerShare > 0.4 * 1e6 && v.fairValuePerShare < 0.7 * 1e6, 'a long-dated ATM option at 50% vol is worth roughly half the share');
  assert.equal(v.totalFairValue, v.tranches.reduce((s, t) => s + t.fairValue, 0));

  const rsu = valueAward(d, award({ id: 'rsu', type: 'RSU', strikePrice: 0, fmvAtGrant: 2_500_000 }), DEFAULT_STOCK_COMP_ASSUMPTIONS)!;
  assert.equal(rsu.fairValuePerShare, 2_500_000);
  assert.equal(rsu.totalFairValue, 48_000 * 250);                                        // $2.50 × 48,000 in cents

  const fixed = valueAward(d, iso, { ...DEFAULT_STOCK_COMP_ASSUMPTIONS, expectedTermYears: 6 })!;
  assert.ok(fixed.tranches.every((t) => t.expectedTermYears === 6));
});

test('graded attribution front-loads expense; straight-line spreads it but never lags what has vested', () => {
  const d = company();
  const rsu = award({ id: 'rsu', type: 'RSU', strikePrice: 0, fmvAtGrant: 1_000_000 });   // $1.00 × 48,000 = $48,000 total
  const graded = valueAward(d, rsu, { ...DEFAULT_STOCK_COMP_ASSUMPTIONS, attribution: 'GRADED' })!;
  const straightA = { ...DEFAULT_STOCK_COMP_ASSUMPTIONS, attribution: 'STRAIGHT_LINE' as const };
  const gradedA = { ...DEFAULT_STOCK_COMP_ASSUMPTIONS, attribution: 'GRADED' as const };
  const total = graded.totalFairValue;
  assert.equal(total, 48_000 * 100);
  // Straight-line: half way through four years, half the value; graded: well over half.
  const mid = '2026-01-01';
  close(cumulativeExpense(graded, straightA, mid), total / 2, total * 0.01, 'straight-line at midpoint');
  // Graded at the midpoint: half the tranches are fully recognised and each later monthly tranche k of 48 is 24/k done,
  // so ½ + ½·Σ(1/k, k=25..48) ≈ 0.84 of the total.
  const g = cumulativeExpense(graded, gradedA, mid);
  close(g / total, 0.836, 0.01, 'graded at midpoint');
  // Both reach the full value at the end and are zero before the grant.
  assert.equal(cumulativeExpense(graded, straightA, '2028-01-01'), total);
  assert.equal(cumulativeExpense(graded, gradedA, '2028-01-01'), total);
  assert.equal(cumulativeExpense(graded, gradedA, '2023-12-31'), 0);
  // Straight-line floor: at the cliff date a quarter has vested, so at least a quarter is recognised.
  const cliff = graded.tranches[0].vestDate;
  assert.ok(cumulativeExpense(graded, straightA, cliff) >= total / 4 - 1);
  // IFRS forces graded whatever the setting says.
  assert.equal(cumulativeExpense(graded, { ...straightA, standard: 'IFRS' }, mid), g);
});

test('the report: period expense, forfeiture reversal, unrecognised cost and the option roll-forward', () => {
  const d = company();
  d.awards.push(
    award({ id: 'a', label: 'OPT-A', grantDate: '2024-01-01', vestingStartDate: '2024-01-01', type: 'RSU', strikePrice: 0, fmvAtGrant: 1_000_000 }),       // $48,000 over 4 years
    award({ id: 'b', label: 'OPT-B', grantDate: '2025-07-01', vestingStartDate: '2025-07-01', quantity: 12_000, strikePrice: 2_000_000, fmvAtGrant: 2_000_000 }),
    award({ id: 'c', label: 'OPT-C', grantDate: '2024-01-01', vestingStartDate: '2024-01-01', type: 'RSU', strikePrice: 0, fmvAtGrant: 1_000_000, quantity: 48_000, cancelledQuantity: 36_000, status: 'CANCELLED' }),
  );
  d.exercises = [{ id: 'x', awardId: 'b', stakeholderId: 'sh_e', quantity: 1_000, exerciseDate: '2026-08-01', method: 'CASH', strikePrice: 2_000_000, fmvAtExercise: 3_000_000, sharesIssued: 1_000, status: 'COMPLETED' }];
  d.valuations = [{ id: 'v', type: '409A', fairMarketValue: 3_000_000, effectiveDate: '2026-01-01', expirationDate: '2026-12-31', provider: null, reportUrl: null, status: 'ACTIVE' }];

  const opts = { asOf: '2026-12-31', assumptions: { attribution: 'STRAIGHT_LINE' as const }, cancellationDates: { c: '2025-01-01' } };
  const r2025 = stockCompReport(d, 2025, opts);
  const a2025 = r2025.awards.find((x) => x.awardId === 'a')!;
  close(a2025.expense, 48_000 * 100 / 4, 48_000 * 100 * 0.01, 'RSU A expenses a quarter of its value in 2025');       // straight-line over 4 years
  // C: 48,000 granted, 12,000 vested at the 2025-01-01 cliff, the other 36,000 forfeited that day → 2025 nets out
  // to the cliff tranche's value less what had already been recognised on the forfeited part in 2024.
  const c2025 = r2025.awards.find((x) => x.awardId === 'c')!;
  assert.equal(c2025.cancellationDate, '2025-01-01');
  assert.equal(c2025.cumulative, 12_000 * 100);                                          // only what vested stays recognised
  assert.equal(c2025.unrecognized, 0);
  // Straight-line had recognised almost exactly the cliff's value by then, so 2025 is a rounding sliver...
  assert.ok(Math.abs(c2025.expense) < 12_000, `straight-line 2025 expense for C is near zero: ${c2025.expense}`);
  const c2024 = stockCompReport(d, 2024, opts).awards.find((x) => x.awardId === 'c')!;
  assert.equal(c2024.cumulative + c2025.expense, 12_000 * 100);                          // 2024 recognised, 2025 trued up
  // ...whereas graded attribution had front-loaded the forfeited tranches, and reverses them.
  const cGraded = stockCompReport(d, 2025, { ...opts, assumptions: { attribution: 'GRADED' } }).awards.find((x) => x.awardId === 'c')!;
  assert.ok(cGraded.expense < 0, `graded reversal is negative: ${cGraded.expense}`);
  assert.equal(cGraded.cumulative, 12_000 * 100);
  // B was granted mid-2025: half a year of its first tranche's service.
  const b2025 = r2025.awards.find((x) => x.awardId === 'b')!;
  assert.ok(b2025.expense > 0 && b2025.unrecognized > b2025.expense, 'B has barely started');
  assert.equal(r2025.totals.expense, a2025.expense + b2025.expense + c2025.expense);
  assert.ok(r2025.totals.weightedRemainingYears > 1 && r2025.totals.weightedRemainingYears < 4);
  assert.equal(r2025.quarters.reduce((s, q) => s + q.expense, 0), r2025.totals.expense);
  assert.deepEqual(r2025.byDepartment.map((x) => x.department), ['Unassigned']);

  // Roll-forward for options (B only): none outstanding at the start of 2025, 12,000 granted, none exercised yet.
  assert.equal(r2025.rollforward.outstandingStart.count, 0);
  assert.equal(r2025.rollforward.granted.count, 12_000);
  assert.equal(r2025.rollforward.granted.waep, 2_000_000);
  assert.ok(r2025.rollforward.granted.fairValuePerShare > 0);
  assert.equal(r2025.rollforward.outstandingEnd.count, 12_000);
  const r2026 = stockCompReport(d, 2026, { ...opts, departments: { sh_e: 'Engineering' } });
  assert.equal(r2026.rollforward.outstandingStart.count, 12_000);
  assert.equal(r2026.rollforward.exercised.count, 1_000);
  assert.equal(r2026.rollforward.outstandingEnd.count, 11_000);
  assert.equal(r2026.rollforward.outstandingEnd.intrinsicValue, 11_000 * 100);            // ($3.00 − $2.00) × 11,000 in cents
  assert.ok(r2026.rollforward.exercisableEnd.count > 0 && r2026.rollforward.exercisableEnd.count <= 11_000);
  close(r2026.rollforward.outstandingEnd.remainingContractualYears, 7.0, 0.05, 'remaining term to the 2034-01-01 expiry');
  assert.deepEqual(r2026.byDepartment.map((x) => x.department), ['Engineering']);
  assert.equal(r2026.excluded.length, 0);
});
