import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCapTable, ownershipByGroup } from '../src/captable.ts';
import { seedCompany, $$, seriesA } from './fixtures.ts';
import { dollarsToCents } from '../src/util.ts';

test('fully diluted includes options and the unallocated pool', () => {
  const t = computeCapTable(seedCompany(), { asOf: '2024-01-01' });
  assert.equal(t.totals.outstanding, 8_000_000);
  assert.equal(t.totals.optionsOutstanding, 200_000);
  assert.equal(t.totals.poolAvailable, 1_800_000);
  assert.equal(t.totals.fullyDiluted, 10_000_000);
});

test('ownership percentages are computed on the fully diluted base', () => {
  const t = computeCapTable(seedCompany(), { asOf: '2024-01-01' });
  const avery = t.rows.find((r) => r.name === 'Avery Stone')!;
  assert.equal(avery.fullyDiluted, 4_500_000);
  assert.ok(Math.abs(avery.fullyDilutedPct - 0.45) < 1e-9);
  const elena = t.rows.find((r) => r.name === 'Elena Ruiz')!;
  assert.equal(elena.optionsOutstanding, 200_000);
  assert.ok(Math.abs(elena.fullyDilutedPct - 0.02) < 1e-9);
});

test('option vesting is split between vested and unvested', () => {
  const t = computeCapTable(seedCompany(), { asOf: '2024-03-01' }); // 24 months in
  const elena = t.rows.find((r) => r.name === 'Elena Ruiz')!;
  assert.equal(elena.optionsVested, 100_000);
  assert.equal(elena.optionsUnvested, 100_000);
});

test('the as-of date excludes securities issued later', () => {
  const t = computeCapTable(seedCompany(), { asOf: '2021-06-01' });
  assert.equal(t.totals.optionsOutstanding, 0); // granted 2022-03-01
  assert.equal(t.totals.outstanding, 8_000_000);
});

test('preferred converts at its conversion ratio in the as-converted view', () => {
  const data = seedCompany();
  data.shareClasses.push(seriesA({ conversionRatio: 2 }));
  data.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 1_000_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  const t = computeCapTable(data, { asOf: '2024-01-01' });
  assert.equal(t.totals.outstanding, 9_000_000);
  assert.equal(t.totals.asConverted, 10_000_000); // 1M preferred -> 2M common
  const inv = t.rows.find((r) => r.name === 'Northwind Ventures')!;
  assert.equal(inv.asConverted, 2_000_000);
  assert.equal(inv.investedAmount, dollarsToCents(1_000_000));
});

test('cancelled grants return to the pool when the plan allows it', () => {
  const data = seedCompany();
  data.awards[0].cancelledQuantity = 50_000;
  const t = computeCapTable(data, { asOf: '2024-01-01' });
  assert.equal(t.pools[0].available, 1_850_000);
  assert.equal(t.totals.optionsOutstanding, 150_000);
});

test('over-issuance against authorized shares raises a warning', () => {
  const data = seedCompany();
  data.shareClasses[0].authorized = 5_000_000;
  const t = computeCapTable(data, { asOf: '2024-01-01' });
  assert.ok(t.warnings.some((w) => w.includes('outstanding exceeds')));
});

test('a stock split scales shares issued before it', () => {
  const data = seedCompany();
  data.stockSplits.push({ id: 'sp1', date: '2023-01-01', ratio: 2 });
  const t = computeCapTable(data, { asOf: '2024-01-01' });
  assert.equal(t.totals.outstanding, 16_000_000);
  assert.equal(t.totals.optionsOutstanding, 400_000);
});

test('ownership groups sum to the whole company', () => {
  const groups = ownershipByGroup(computeCapTable(seedCompany(), { asOf: '2024-01-01' }));
  const total = groups.reduce((s, g) => s + g.pct, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(groups.find((g) => g.label === 'Founders')!.shares, 8_000_000);
  assert.equal(groups.find((g) => g.label === 'Unallocated pool')!.shares, 1_800_000);
});

test('the as-converted estimate gives a post-money SAFE exactly principal / cap of the company', () => {
  const data = seedCompany();
  data.pools = []; data.awards = [];
  data.convertibles.push({
    id: 'safe', stakeholderId: 'sh_inv', instrument: 'SAFE_POST', principal: dollarsToCents(1_000_000),
    issueDate: '2023-01-01', valuationCap: dollarsToCents(10_000_000), discount: 0, interestRate: 0,
    compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: true, status: 'OUTSTANDING',
    convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null, notes: null,
  });
  const t = computeCapTable(data, { asOf: '2024-01-01', includeConvertibles: true });
  const inv = t.rows.find((r) => r.name === 'Northwind Ventures')!;
  assert.ok(Math.abs(inv.convertibleAsConverted / t.totals.fullyDiluted - 0.10) < 1e-4);
  assert.equal(inv.convertiblePrincipal, dollarsToCents(1_000_000));
  const without = computeCapTable(data, { asOf: '2024-01-01', includeConvertibles: false });
  assert.equal(without.totals.convertibleAsConverted, 0);
  assert.equal(without.rows.find((r) => r.name === 'Northwind Ventures')!.convertiblePrincipal, dollarsToCents(1_000_000));
});

test('after a split the class summary halves the issue price and keeps the preference', () => {
  const data = seedCompany();
  data.shareClasses.push(seriesA({ originalIssuePrice: $$(1.0) }));
  data.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 1_000_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  data.stockSplits.push({ id: 'sp', date: '2023-12-01', ratio: 2 });
  const c = computeCapTable(data, { asOf: '2024-01-01' }).classes.find((x) => x.shareClassId === 'sc_a')!;
  assert.equal(c.outstanding, 2_000_000);
  assert.equal(c.pricePerShare, $$(0.5));
  assert.equal(c.liquidationPreference, dollarsToCents(1_000_000));
});

test('the pool summary is split-adjusted along with the grants made from it', () => {
  const data = seedCompany();
  data.stockSplits.push({ id: 'sp', date: '2023-01-01', ratio: 2 });
  const t = computeCapTable(data, { asOf: '2024-01-01' });
  assert.equal(t.pools[0].authorized, 4_000_000);
  assert.equal(t.pools[0].granted, 400_000);
  assert.equal(t.pools[0].available, 3_600_000);
});

test('grants that are drafted, awaiting the board or awaiting signatures are not in the cap table until issued', async () => {
  const { stakeholderPosition, computePoolSummaries } = await import('../src/captable.ts');
  const d = seedCompany();
  const opts = { asOf: '2025-01-01', includeUnallocatedPool: false };
  const base = computeCapTable(d, opts).totals.fullyDiluted;
  const template = d.awards[0];
  for (const [i, status] of (['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE'] as const).entries()) {
    d.awards.push({ ...template, id: `pending-${i}`, label: `P-${i}`, quantity: 250_000, exercisedQuantity: 0, cancelledQuantity: 0, status });
  }
  assert.equal(computeCapTable(d, opts).totals.fullyDiluted, base);                                     // nothing changed
  assert.ok(!stakeholderPosition(d, template.stakeholderId, '2025-01-01').awards.some((a) => a.id.startsWith('pending-')));
  const granted = computePoolSummaries(d, '2025-01-01').find((p) => p.poolId === template.poolId)!.granted;
  d.awards.find((a) => a.id === 'pending-2')!.status = 'OUTSTANDING';                                    // once issued it counts
  assert.equal(computeCapTable(d, opts).totals.fullyDiluted, base + 250_000);
  assert.equal(computePoolSummaries(d, '2025-01-01').find((p) => p.poolId === template.poolId)!.granted, granted + 250_000);
});
