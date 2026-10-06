import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSplits, splitFactor } from '../src/splits.ts';
import { computeCapTable } from '../src/captable.ts';
import { computeWaterfall } from '../src/waterfall.ts';
import { seedCompany, seriesA, $$ } from './fixtures.ts';
import { dollarsToCents as $, shareValue } from '../src/util.ts';

function withPreferred() {
  const d = seedCompany();
  d.shareClasses.push(seriesA({ originalIssuePrice: $$(1.0) }));
  d.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 2_000_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  return d;
}

test('the split factor only counts splits after the security and on or before the as-of date', () => {
  const d = seedCompany();
  d.stockSplits.push({ id: 'a', date: '2022-06-01', ratio: 2 }, { id: 'b', date: '2024-06-01', ratio: 3 });
  assert.equal(splitFactor(d, '2021-01-01', '2025-01-01'), 6);
  assert.equal(splitFactor(d, '2023-01-01', '2025-01-01'), 3);   // issued after the first split
  assert.equal(splitFactor(d, '2021-01-01', '2023-01-01'), 2);   // second split not yet effective
  assert.equal(splitFactor(d, '2024-06-01', '2025-01-01'), 1);   // issued on the split date: already post-split
  assert.equal(splitFactor(d, null, '2025-01-01'), 6);
});

test('a 2:1 split doubles share counts and halves per-share prices', () => {
  const d = withPreferred();
  d.stockSplits.push({ id: 'sp', date: '2023-12-01', ratio: 2 });
  const n = normalizeSplits(d, '2024-01-01');
  const founder = n.issuances.find((i) => i.id === 'is_1')!;
  assert.equal(founder.quantity, 9_000_000);
  assert.equal(founder.pricePerShare, $$(0.00005));
  const a = n.shareClasses.find((c) => c.id === 'sc_a')!;
  assert.equal(a.originalIssuePrice, $$(0.5));
  assert.equal(a.authorized, 10_000_000);
  const option = n.awards[0];
  assert.equal(option.quantity, 400_000);
  assert.equal(option.strikePrice, $$(0.05));
  assert.equal(option.fmvAtGrant, $$(0.05));
  assert.equal(n.pools[0].authorized, 4_000_000);
  assert.equal(n.valuations[0].fairMarketValue, $$(0.05));
  assert.deepEqual(n.stockSplits, []);
});

test('economics are invariant under a split: invested capital, preference and intrinsic value', () => {
  const d = withPreferred();
  const before = computeCapTable(d, { asOf: '2024-01-01' });
  d.stockSplits.push({ id: 'sp', date: '2023-12-01', ratio: 2 });
  const after = computeCapTable(d, { asOf: '2024-01-01' });

  assert.equal(after.totals.investedAmount, before.totals.investedAmount);
  const prefBefore = before.classes.find((c) => c.shareClassId === 'sc_a')!.liquidationPreference;
  const prefAfter = after.classes.find((c) => c.shareClassId === 'sc_a')!.liquidationPreference;
  assert.equal(prefAfter, prefBefore);
  assert.equal(after.totals.fullyDiluted, before.totals.fullyDiluted * 2);
  // Every holder keeps exactly the same ownership percentage.
  for (const r of before.rows) {
    const same = after.rows.find((x) => x.stakeholderId === r.stakeholderId)!;
    assert.ok(Math.abs(same.fullyDilutedPct - r.fullyDilutedPct) < 1e-9, r.name);
  }
});

test('the waterfall pays every class the same dollars before and after a split', () => {
  const d = withPreferred();
  d.pools = []; d.awards = [];
  const before = computeWaterfall(d, $(5_000_000), { asOf: '2024-01-01' });
  d.stockSplits.push({ id: 'sp', date: '2023-12-01', ratio: 2 });
  const after = computeWaterfall(d, $(5_000_000), { asOf: '2024-01-01' });
  for (const c of before.classPayouts) {
    const same = after.classPayouts.find((x) => x.name === c.name)!;
    assert.equal(same.total, c.total, c.name);
    assert.equal(same.preferenceClaim, c.preferenceClaim, c.name);
    assert.ok(Math.abs(same.perShare * 2 - c.perShare) <= 2, `${c.name} per-share halves`);
  }
});

test('a split dated after the securities does not touch securities issued after it', () => {
  const d = seedCompany();
  d.stockSplits.push({ id: 'sp', date: '2021-06-01', ratio: 2 });
  const n = normalizeSplits(d, '2024-01-01');
  assert.equal(n.issuances[0].quantity, 9_000_000);   // founder stock from 2021-01-01 doubles
  assert.equal(n.awards[0].quantity, 200_000);         // 2022 grant is already post-split
  assert.equal(n.awards[0].strikePrice, $$(0.10));
});

test('splits dated after the as-of date are left unapplied, and normalising twice is a no-op', () => {
  const d = seedCompany();
  d.stockSplits.push({ id: 'future', date: '2030-01-01', ratio: 10 });
  const n = normalizeSplits(d, '2024-01-01');
  assert.equal(n.issuances[0].quantity, 4_500_000);
  assert.equal(n.stockSplits.length, 1);
  d.stockSplits.push({ id: 'past', date: '2023-01-01', ratio: 2 });
  const once = normalizeSplits(d, '2024-01-01');
  const twice = normalizeSplits(once, '2024-01-01');
  assert.deepEqual(twice, once);
});

test('a reverse split halves shares and doubles prices', () => {
  const d = seedCompany();
  d.stockSplits.push({ id: 'rs', date: '2023-01-01', ratio: 0.5 });
  const n = normalizeSplits(d, '2024-01-01');
  assert.equal(n.issuances[0].quantity, 2_250_000);
  assert.equal(n.awards[0].quantity, 100_000);
  assert.equal(n.awards[0].strikePrice, $$(0.20));
  assert.equal(shareValue(n.awards[0].quantity, n.awards[0].strikePrice),
    shareValue(d.awards[0].quantity, d.awards[0].strikePrice));
});
