import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelExercise, modelSaleProceeds, assessQSBS, portfolioValue } from '../src/tax.ts';
import { seedCompany, $$ } from './fixtures.ts';
import { dollarsToCents as $ } from '../src/util.ts';
import type { Award } from '../src/types.ts';

const grant = (o: Partial<Award> = {}): Award => ({
  id: 'g', label: 'G-1', stakeholderId: 'sh_e', poolId: 'pool_1', type: 'NSO', quantity: 10_000,
  strikePrice: $$(1.0), grantDate: '2022-01-01', vestingStartDate: '2022-01-01', vestingScheduleId: 'vs_4yr',
  status: 'OUTSTANDING', expirationDate: '2032-01-01', ptepMonths: 3, earlyExerciseAllowed: false,
  exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2022-01-01', acceptedDate: null,
  fmvAtGrant: $$(1.0), rsuLiquidityCondition: false, notes: null, ...o,
});

// Default flat rates: 37% federal, 9.3% state, 28% AMT, 2.35% Medicare.

test('NSO exercise: the spread is ordinary income with withholding and payroll tax', () => {
  const s = modelExercise(seedCompany(), grant({ type: 'NSO' }), 10_000, { asOf: '2024-01-01', fmv: $$(3.0) });
  assert.equal(s.exerciseCost, $(10_000));
  assert.equal(s.spread, $(20_000));
  assert.equal(s.ordinaryIncome, $(20_000));
  assert.equal(s.amtPreference, 0);
  assert.equal(s.estimatedFederalTax, $(7_400));
  assert.equal(s.estimatedStateTax, $(1_860));
  assert.equal(s.payrollTax, $(470));
  assert.equal(s.totalTaxDue, $(9_730));
  assert.equal(s.totalCashNeeded, $(19_730));
});

test('ISO exercise: no regular tax, the spread is an AMT preference item', () => {
  const s = modelExercise(seedCompany(), grant({ type: 'ISO' }), 10_000, { asOf: '2024-01-01', fmv: $$(3.0) });
  assert.equal(s.ordinaryIncome, 0);
  assert.equal(s.amtPreference, $(20_000));
  assert.equal(s.estimatedAmt, $(5_600));
  assert.equal(s.payrollTax, 0);
  assert.equal(s.totalTaxDue, $(5_600));
  // Qualifying disposition needs MORE than two years from grant and one from exercise.
  assert.equal(s.qualifyingDispositionDate, '2025-01-02');
  assert.equal(s.longTermDate, '2025-01-02');
});

test('RSU settlement: the full fair market value is ordinary income', () => {
  const s = modelExercise(seedCompany(), grant({ type: 'RSU', strikePrice: 0 }), 10_000, { asOf: '2024-01-01', fmv: $$(3.0) });
  assert.equal(s.exerciseCost, 0);
  assert.equal(s.ordinaryIncome, $(30_000));
});

test('an underwater option has no spread and says so', () => {
  const s = modelExercise(seedCompany(), grant(), 1_000, { asOf: '2024-01-01', fmv: $$(0.5) });
  assert.equal(s.spread, 0);
  assert.equal(s.totalTaxDue, 0);
  assert.ok(s.notes.some((n) => n.includes('under water')));
});

test('long-term treatment needs more than one year: the anniversary itself does not qualify', () => {
  const a = grant();
  const onAnniversary = modelSaleProceeds(a, 100, $$(10), { exercisedOn: '2024-01-15', saleDate: '2025-01-15', fmvAtExercise: $$(3) });
  const dayAfter = modelSaleProceeds(a, 100, $$(10), { exercisedOn: '2024-01-15', saleDate: '2025-01-16', fmvAtExercise: $$(3) });
  assert.equal(onAnniversary.isLongTerm, false);
  assert.equal(dayAfter.isLongTerm, true);
  // Leap day acquisition: the anniversary is 28 February.
  const leap = modelSaleProceeds(a, 100, $$(10), { exercisedOn: '2024-02-29', saleDate: '2025-02-28', fmvAtExercise: $$(3) });
  const leapAfter = modelSaleProceeds(a, 100, $$(10), { exercisedOn: '2024-02-29', saleDate: '2025-03-01', fmvAtExercise: $$(3) });
  assert.equal(leap.isLongTerm, false);
  assert.equal(leapAfter.isLongTerm, true);
});

test('ISO qualifying disposition: the whole gain is long-term capital gain', () => {
  const a = grant({ type: 'ISO', grantDate: '2022-01-01' });
  const s = modelSaleProceeds(a, 1_000, $$(10), { exercisedOn: '2024-01-01', saleDate: '2025-06-01', fmvAtExercise: $$(3) });
  assert.equal(s.ordinaryIncomePortion, 0);
  assert.equal(s.capitalGainPortion, $(9_000));                 // ($10 - $1) x 1,000
  assert.equal(s.isLongTerm, true);
  assert.equal(s.netProceeds, s.grossProceeds - s.exerciseCost - s.estimatedTax);
});

test('ISO disqualifying disposition: the exercise spread becomes ordinary income, the rest is gain', () => {
  const a = grant({ type: 'ISO', grantDate: '2022-01-01' });
  const s = modelSaleProceeds(a, 1_000, $$(10), { exercisedOn: '2024-01-01', saleDate: '2024-06-01', fmvAtExercise: $$(3) });
  assert.equal(s.ordinaryIncomePortion, $(2_000));               // ($3 - $1) x 1,000
  assert.equal(s.capitalGainPortion, $(7_000));                  // ($10 - $3) x 1,000
  assert.equal(s.isLongTerm, false);
});

test('ISO disqualifying disposition below the exercise FMV: ordinary income is limited to the actual gain', () => {
  const a = grant({ type: 'ISO', grantDate: '2022-01-01' });
  const s = modelSaleProceeds(a, 1_000, $$(2), { exercisedOn: '2024-01-01', saleDate: '2024-06-01', fmvAtExercise: $$(3) });
  assert.equal(s.ordinaryIncomePortion, $(1_000));               // min($2, $3) - $1
  assert.equal(s.capitalGainPortion, 0);
});

test('QSBS under the original rules: five full years, $50M assets, $10M cap', () => {
  const met = assessQSBS('2020-01-01', $(100_000), { asOf: '2025-01-02', isCCorp: true });
  assert.equal(met.regime, 'ORIGINAL');
  assert.equal(met.eligible, true);
  assert.equal(met.exclusionPct, 1);
  assert.equal(met.exclusionCap, $(10_000_000));
  assert.equal(met.grossAssetLimit, $(50_000_000));
  const anniversary = assessQSBS('2020-01-01', $(100_000), { asOf: '2025-01-01', isCCorp: true });
  assert.equal(anniversary.eligible, false);                     // "more than five years"
  assert.equal(anniversary.exclusionPct, 0);
  const early = assessQSBS('2024-01-01', $(100_000), { asOf: '2027-06-01', isCCorp: true });
  assert.equal(early.exclusionPct, 0);                           // no tiered exclusion pre-2025
});

test('QSBS for stock issued after 4 July 2025: tiered 50/75/100% exclusion, $75M assets, $15M cap', () => {
  const q = (asOf: string, assets = 0) => assessQSBS('2025-08-01', $(200_000), { asOf, isCCorp: true, grossAssetsAtIssuance: $(assets) });
  assert.equal(q('2028-07-31').exclusionPct, 0);
  assert.equal(q('2028-08-01').exclusionPct, 0.5);
  assert.equal(q('2028-08-02').exclusionPct, 0.5);
  assert.equal(q('2029-08-02').exclusionPct, 0.75);
  assert.equal(q('2030-08-02').exclusionPct, 1);
  assert.equal(q('2028-08-02').regime, 'OBBBA_2025');
  assert.equal(q('2028-08-02').exclusionCap, $(15_000_000));
  assert.equal(q('2028-08-02', 60_000_000).eligible, true);      // under the raised $75M ceiling
  assert.equal(q('2028-08-02', 80_000_000).eligible, false);
  assert.equal(assessQSBS('2024-01-01', $(1), { asOf: '2030-01-01', isCCorp: true, grossAssetsAtIssuance: $(60_000_000) }).eligible, false);
});

test('QSBS: the cap is the greater of the statutory amount and ten times basis, and requires a C corporation', () => {
  const big = assessQSBS('2018-01-01', $(3_000_000), { asOf: '2025-01-01', isCCorp: true });
  assert.equal(big.exclusionCap, $(30_000_000));
  assert.equal(assessQSBS('2018-01-01', $(1), { asOf: '2025-01-01', isCCorp: false }).eligible, false);
});

test('portfolio value splits options into vested and unvested and values the vested spread', () => {
  const d = seedCompany();
  d.valuations[0].fairMarketValue = $$(0.60);
  const p = portfolioValue(d, 'sh_e', '2024-03-01');                  // 24 of 48 months
  assert.equal(p.vestedOptions, 100_000);
  assert.equal(p.unvestedOptions, 100_000);
  assert.equal(p.exerciseCostVested, $(10_000));                      // 100,000 x $0.10
  assert.equal(p.intrinsicVested, $(50_000));                         // 100,000 x ($0.60 - $0.10)
  assert.equal(p.totalValue, $(50_000));
});
