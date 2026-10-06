import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWaterfall, computeBreakpoints } from '../src/waterfall.ts';
import { seedCompany, seriesA, $$ } from './fixtures.ts';
import { dollarsToCents as $, ppsToDollars } from '../src/util.ts';
import type { CompanyData, ShareClass } from '../src/types.ts';

/** 8M common (founders) + 2M Series A at $1.00 = $2M invested, 10M as-converted. */
function withPreferred(overrides: Partial<ShareClass> = {}): CompanyData {
  const d = seedCompany();
  d.pools = []; d.awards = [];
  d.shareClasses.push(seriesA({ originalIssuePrice: $$(1.0), ...overrides }));
  d.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 2_000_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  return d;
}

const cls = (w: ReturnType<typeof computeWaterfall>, name: string) =>
  w.classPayouts.find((c) => c.name.startsWith(name))!;
const near = (a: number, b: number, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('below the preference, preferred takes its money and common gets the rest', () => {
  const w = computeWaterfall(withPreferred(), $(5_000_000), { asOf: '2024-01-01' });
  near(cls(w, 'Series A').total, $(2_000_000));
  assert.equal(cls(w, 'Series A').converted, false);
  near(cls(w, 'Common').total, $(3_000_000));
  assert.equal(ppsToDollars(w.perCommonShare), 0.375); // $3M / 8M
});

test('preferred is wiped out pro-rata when proceeds fall short', () => {
  const w = computeWaterfall(withPreferred(), $(1_000_000), { asOf: '2024-01-01' });
  near(cls(w, 'Series A').total, $(1_000_000));
  near(cls(w, 'Common').total, 0);
});

test('non-participating preferred converts once converting beats the preference', () => {
  const w = computeWaterfall(withPreferred(), $(20_000_000), { asOf: '2024-01-01' });
  const a = cls(w, 'Series A');
  assert.equal(a.converted, true);
  near(a.total, $(4_000_000));               // 20% of $20M
  near(cls(w, 'Common').total, $(16_000_000));
  assert.equal(ppsToDollars(w.perCommonShare), 2.0);
});

test('the conversion indifference point is preference / ownership', () => {
  // $2M preference at 20% as-converted ownership => indifferent at a $10M exit.
  const below = computeWaterfall(withPreferred(), $(9_000_000), { asOf: '2024-01-01' });
  const above = computeWaterfall(withPreferred(), $(11_000_000), { asOf: '2024-01-01' });
  assert.equal(cls(below, 'Series A').converted, false);
  assert.equal(cls(above, 'Series A').converted, true);
  near(cls(below, 'Series A').total, $(2_000_000));
  near(cls(above, 'Series A').total, $(2_200_000));
});

test('full participation takes the preference and then shares the residual', () => {
  const w = computeWaterfall(withPreferred({ participation: 'FULL_PARTICIPATING' }), $(20_000_000), { asOf: '2024-01-01' });
  const a = cls(w, 'Series A');
  near(a.preferencePaid, $(2_000_000));
  near(a.participation, $(3_600_000));      // 20% of the $18M residual
  near(a.total, $(5_600_000));
  near(cls(w, 'Common').total, $(14_400_000));
});

test('a participation cap clamps the payout and then forces conversion', () => {
  const capped = withPreferred({ participation: 'CAPPED_PARTICIPATING', participationCap: 2 });
  // At $20M the capped total ($4M) equals the as-converted value, so the cap binds.
  const at20 = computeWaterfall(capped, $(20_000_000), { asOf: '2024-01-01' });
  near(cls(at20, 'Series A').total, $(4_000_000));
  // At $30M converting (20% = $6M) beats the $4M cap.
  const at30 = computeWaterfall(capped, $(30_000_000), { asOf: '2024-01-01' });
  assert.equal(cls(at30, 'Series A').converted, true);
  near(cls(at30, 'Series A').total, $(6_000_000));
});

test('a 2x preference is paid before any residual', () => {
  const w = computeWaterfall(withPreferred({ liquidationMultiple: 2 }), $(6_000_000), { asOf: '2024-01-01' });
  near(cls(w, 'Series A').total, $(4_000_000));
  near(cls(w, 'Common').total, $(2_000_000));
});

test('senior preferred is paid ahead of junior preferred', () => {
  const d = withPreferred();                                   // Series A, seniority 1
  d.shareClasses.push(seriesA({
    id: 'sc_b', name: 'Series B Preferred', seniority: 2,
    originalIssuePrice: $$(5.0), issueDate: '2024-01-01',
  }));
  d.issuances.push({
    id: 'is_b', certificateNo: 'PB-1', stakeholderId: 'sh_inv', shareClassId: 'sc_b',
    quantity: 1_000_000, pricePerShare: $$(5.0), issueDate: '2024-01-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  // $6M exit: Series B ($5M, senior) is paid first, Series A takes the last $1M.
  const w = computeWaterfall(d, $(6_000_000), { asOf: '2024-06-01' });
  near(cls(w, 'Series B').total, $(5_000_000));
  near(cls(w, 'Series A').total, $(1_000_000));
  near(cls(w, 'Common').total, 0);
});

test('same-rank preferred shares a shortfall pro-rata', () => {
  const d = withPreferred();
  d.shareClasses.push(seriesA({
    id: 'sc_b', name: 'Series B Preferred', seniority: 1,
    originalIssuePrice: $$(2.0), issueDate: '2024-01-01',
  }));
  d.issuances.push({
    id: 'is_b', certificateNo: 'PB-1', stakeholderId: 'sh_e', shareClassId: 'sc_b',
    quantity: 1_000_000, pricePerShare: $$(2.0), issueDate: '2024-01-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  // $2M claim + $2M claim = $4M, against $2M available: each takes half.
  const w = computeWaterfall(d, $(2_000_000), { asOf: '2024-06-01' });
  near(cls(w, 'Series A').total, $(1_000_000));
  near(cls(w, 'Series B').total, $(1_000_000));
});

test('in-the-money options participate and underwater options are excluded', () => {
  const d = withPreferred();
  d.pools = [{ id: 'pool_1', name: 'Plan', shareClassId: 'sc_common', authorized: 1_000_000, boardApprovalDate: null, shareholderApprovalDate: null, returnForfeituresToPool: true, evergreenPercent: null, planType: 'STOCK_PLAN' }];
  d.awards = [
    { id: 'aw_low', label: 'Cheap', stakeholderId: 'sh_e', poolId: 'pool_1', type: 'ISO', quantity: 500_000, strikePrice: $$(0.10), grantDate: '2022-01-01', vestingStartDate: '2022-01-01', vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: null, ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2022-01-01', acceptedDate: null, fmvAtGrant: $$(0.10), rsuLiquidityCondition: false, notes: null },
    { id: 'aw_high', label: 'Pricey', stakeholderId: 'sh_e', poolId: 'pool_1', type: 'ISO', quantity: 500_000, strikePrice: $$(50.0), grantDate: '2022-01-01', vestingStartDate: '2022-01-01', vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: null, ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2022-01-01', acceptedDate: null, fmvAtGrant: $$(0.10), rsuLiquidityCondition: false, notes: null },
  ];
  const w = computeWaterfall(d, $(20_000_000), { asOf: '2026-02-01', accelerateUnvested: true });
  assert.equal(w.optionsExercised, 500_000);
  assert.equal(w.optionsUnderwater, 500_000);
  const elena = w.stakeholderPayouts.find((s) => s.name === 'Elena Ruiz')!;
  assert.ok(elena.fromOptions > 0);
  // Payout is the spread, net of the exercise cost. Cash exercise gives one common price
  // P = ($20,000,000 + 500,000 x $0.10) / (8M + 2M + 0.5M) = $1.909524, the same P as the
  // treasury stock method (ASC 260-10-45-23), so 500,000 x (P - $0.10) = $904,761.90, ±1 cent.
  near(elena.fromOptions, 90_476_190, 1);
  assert.ok(elena.fromOptions < w.perCommonShare / 1e6 * 500_000 * 100);
});

test('every dollar of the exit is distributed and nothing is created', () => {
  const w = computeWaterfall(withPreferred({ participation: 'FULL_PARTICIPATING' }), $(37_500_000), { asOf: '2024-01-01' });
  const distributed = w.classPayouts.reduce((s, c) => s + c.total, 0);
  near(distributed, $(37_500_000), 5);
  const perHolder = w.stakeholderPayouts.reduce((s, p) => s + p.total, 0);
  near(perHolder, $(37_500_000), 5);
});

test('fees, escrow and debt come off the top before any distribution', () => {
  const d = withPreferred();
  d.convertibles.push({
    id: 'n1', stakeholderId: 'sh_e', instrument: 'NOTE', principal: $(1_000_000),
    issueDate: '2023-01-01', valuationCap: null, discount: 0, interestRate: 0,
    compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: false,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  });
  const w = computeWaterfall(d, $(10_000_000), {
    asOf: '2024-01-01', transactionFees: $(500_000), escrowHoldback: $(500_000), repayNotesAsDebt: true,
  });
  assert.equal(w.debtRepaid, $(1_000_000));
  assert.equal(w.distributable, $(8_000_000));
  near(cls(w, 'Series A').total, $(2_000_000));
  near(cls(w, 'Common').total, $(6_000_000));
});

test('breakpoints identify the preference stack and the conversion point', () => {
  const bps = computeBreakpoints(withPreferred(), { asOf: '2024-01-01' });
  assert.ok(bps.some((b) => b.kind === 'PREFERENCE' && Math.abs(b.exitValue - $(2_000_000)) < $(1)));
  assert.ok(bps.some((b) => b.kind === 'CONVERSION' && Math.abs(b.exitValue - $(10_000_000)) < $(1)));
});

test('payouts rise monotonically with the exit value', () => {
  const d = withPreferred({ participation: 'CAPPED_PARTICIPATING', participationCap: 3 });
  let prevCommon = -1;
  for (let v = 1; v <= 60; v += 1) {
    const w = computeWaterfall(d, $(v * 1_000_000), { asOf: '2024-01-01' });
    const common = cls(w, 'Common').total;
    assert.ok(common >= prevCommon - 5, `common payout fell at $${v}M: ${common} < ${prevCommon}`);
    prevCommon = common;
  }
});

// ---------------------------------------------------------------------------
// Conservation and elections — the properties that must hold at EVERY exit value
// ---------------------------------------------------------------------------

const distributed = (w: ReturnType<typeof computeWaterfall>) =>
  w.stakeholderPayouts.reduce((s, p) => s + p.total, 0);

test('every cent is distributed while a participation cap binds', () => {
  // 2x cap, 20% ownership, $2M preference: the cap binds between $12M and $20M.
  // The old code let the clamped excess vanish; it belongs to common.
  const d = withPreferred({ participation: 'CAPPED_PARTICIPATING', participationCap: 2 });
  for (let m = 8; m <= 30; m += 1) {
    const w = computeWaterfall(d, $(m * 1_000_000), { asOf: '2024-01-01' });
    assert.equal(distributed(w), $(m * 1_000_000), `$${m}M leaked ${$(m * 1_000_000) - distributed(w)} cents`);
  }
  const at16 = computeWaterfall(d, $(16_000_000), { asOf: '2024-01-01' });
  assert.equal(cls(at16, 'Series A').total, $(4_000_000));                  // capped
  assert.equal(cls(at16, 'Series A').cappedOut, true);
  assert.equal(cls(at16, 'Common').total, $(12_000_000));                   // not $11.2M
});

test('a capped class converts exactly when its as-converted value passes the cap', () => {
  // Converting pays 20% of the exit; the cap is $4M; so the switch is at $20M.
  const d = withPreferred({ participation: 'CAPPED_PARTICIPATING', participationCap: 2 });
  const below = computeWaterfall(d, $(19_000_000), { asOf: '2024-01-01' });
  const above = computeWaterfall(d, $(21_000_000), { asOf: '2024-01-01' });
  assert.equal(cls(below, 'Series A').converted, false);
  near(cls(below, 'Series A').total, $(4_000_000));
  assert.equal(cls(above, 'Series A').converted, true);
  near(cls(above, 'Series A').total, $(4_200_000));
  near(cls(above, 'Common').total, $(16_800_000));
});

test('conservation holds with two ranks, capped participation, in-the-money options and a SAFE all at once', () => {
  const d = withPreferred({ participation: 'CAPPED_PARTICIPATING', participationCap: 2.5 });
  d.shareClasses.push(seriesA({ id: 'sc_b', name: 'Series B Preferred', seniority: 2, originalIssuePrice: $$(4.0), issueDate: '2024-01-01' }));
  d.issuances.push({ id: 'is_b', certificateNo: 'PB-1', stakeholderId: 'sh_e', shareClassId: 'sc_b', quantity: 1_000_000,
    pricePerShare: $$(4.0), issueDate: '2024-01-01', status: 'OUTSTANDING', vestingScheduleId: null, vestingStartDate: null,
    earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: null });
  d.pools = [{ id: 'pool_1', name: 'Plan', shareClassId: 'sc_common', authorized: 2_000_000, boardApprovalDate: null,
    shareholderApprovalDate: null, returnForfeituresToPool: true, evergreenPercent: null, planType: 'STOCK_PLAN' }];
  d.awards = [
    { id: 'aw1', label: 'A', stakeholderId: 'sh_e', poolId: 'pool_1', type: 'ISO', quantity: 600_000, strikePrice: $$(0.50), grantDate: '2022-01-01', vestingStartDate: '2022-01-01', vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: null, ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2022-01-01', acceptedDate: null, fmvAtGrant: $$(0.50), rsuLiquidityCondition: false, notes: null },
    { id: 'aw2', label: 'B', stakeholderId: 'sh_b', poolId: 'pool_1', type: 'NSO', quantity: 400_000, strikePrice: $$(3.00), grantDate: '2023-01-01', vestingStartDate: '2023-01-01', vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: null, ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2023-01-01', acceptedDate: null, fmvAtGrant: $$(3.00), rsuLiquidityCondition: false, notes: null },
  ];
  d.convertibles.push({ id: 'safe', stakeholderId: 'sh_a', instrument: 'SAFE_POST', principal: $(500_000), issueDate: '2023-06-01',
    valuationCap: $(15_000_000), discount: 0.2, interestRate: 0, compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: true,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null, notes: null });
  for (let m = 1; m <= 80; m += 3) {
    const w = computeWaterfall(d, $(m * 1_000_000), { asOf: '2026-06-01', accelerateUnvested: true });
    assert.equal(distributed(w), $(m * 1_000_000), `$${m}M`);
    assert.ok(!w.warnings.some((x) => x.includes('did not settle')), `$${m}M settled`);
  }
});

test('a SAFE takes the greater of its cash-out and converting at the cap', () => {
  // 8M common, no pool. A $1M post-money SAFE on a $10M cap owns 10% if it converts,
  // so converting only beats the $1M cash-out above a $10M exit.
  const d = seedCompany(); d.pools = []; d.awards = [];
  d.convertibles.push({ id: 'safe', stakeholderId: 'sh_inv', instrument: 'SAFE_POST', principal: $(1_000_000), issueDate: '2023-01-01',
    valuationCap: $(10_000_000), discount: 0, interestRate: 0, compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: true,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null, notes: null });

  const low = computeWaterfall(d, $(5_000_000), { asOf: '2024-01-01' });
  const safeLow = low.classPayouts.find((c) => c.kind === 'SAFE')!;
  assert.equal(safeLow.converted, false);
  assert.equal(safeLow.total, $(1_000_000));
  assert.equal(low.convertibleCashOut, $(1_000_000));
  assert.equal(cls(low, 'Common').total, $(4_000_000));

  const high = computeWaterfall(d, $(20_000_000), { asOf: '2024-01-01' });
  const safeHigh = high.classPayouts.find((c) => c.kind === 'SAFE')!;
  assert.equal(safeHigh.converted, true);
  near(safeHigh.total, $(2_000_000), $(100));                                // 10% of $20M
  assert.equal(high.convertibleCashOut, 0);
  assert.equal(distributed(high), $(20_000_000));

  const excluded = computeWaterfall(d, $(5_000_000), { asOf: '2024-01-01', convertSafes: false });
  assert.ok(!excluded.classPayouts.some((c) => c.kind === 'SAFE'));
  assert.equal(cls(excluded, 'Common').total, $(5_000_000));
});

test('a note that is not repaid as debt makes the same election as a SAFE, with interest', () => {
  const d = seedCompany(); d.pools = []; d.awards = [];
  d.convertibles.push({ id: 'note', stakeholderId: 'sh_inv', instrument: 'NOTE', principal: $(1_000_000), issueDate: '2023-01-01',
    valuationCap: $(8_000_000), discount: 0, interestRate: 0.08, compounding: 'SIMPLE', maturityDate: '2026-01-01', mfn: false,
    proRataRight: false, status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null, notes: null });
  const w = computeWaterfall(d, $(3_000_000), { asOf: '2024-01-01', repayNotesAsDebt: false });
  const note = w.classPayouts.find((c) => c.kind === 'NOTE')!;
  assert.equal(w.debtRepaid, 0);
  assert.equal(note.converted, false);
  near(note.preferenceClaim, $(1_080_000), $(500));                          // one year at 8%
  near(note.total, $(1_080_000), $(500));
  const holder = w.stakeholderPayouts.find((p) => p.stakeholderId === 'sh_inv')!;
  near(holder.fromConvertibles, $(1_080_000), $(500));
  assert.equal(distributed(w), $(3_000_000));
});

test('cumulative dividends accrue into the preference claim', () => {
  const d = withPreferred({ dividendType: 'CUMULATIVE', dividendRate: 0.08, issueDate: '2022-01-01' });
  d.issuances.find((i) => i.id === 'is_a')!.issueDate = '2022-01-01';
  const w = computeWaterfall(d, $(3_000_000), { asOf: '2025-01-01' });
  const a = cls(w, 'Series A');
  near(a.preferenceClaim, $(2_480_000), $(1_000));                           // $2M x (1 + 3 x 8%)
  near(a.total, $(2_480_000), $(1_000));
  near(cls(w, 'Common').total, $(520_000), $(1_000));
  assert.equal(distributed(w), $(3_000_000));
});

test('a class converts only when strictly better, so the indifference point itself keeps the preference', () => {
  const w = computeWaterfall(withPreferred(), $(10_000_000), { asOf: '2024-01-01' });
  assert.equal(cls(w, 'Series A').converted, false);
  assert.equal(cls(w, 'Series A').total, $(2_000_000));
  assert.equal(cls(w, 'Common').total, $(8_000_000));
});

test('common is never labelled as converted', () => {
  const w = computeWaterfall(withPreferred(), $(50_000_000), { asOf: '2024-01-01' });
  assert.equal(cls(w, 'Common').converted, false);
  assert.equal(cls(w, 'Common').kind, 'COMMON');
});
