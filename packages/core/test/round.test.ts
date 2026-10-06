import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRound, computeAntiDilution } from '../src/round.ts';
import { seedCompany, seriesA, $$ } from './fixtures.ts';
import { dollarsToCents as $, ppsToDollars, dollarsToPPS } from '../src/util.ts';
import type { Convertible } from '../src/types.ts';

/** Strip the fixture's pool so the arithmetic is easy to reason about. */
function plainCompany() {
  const d = seedCompany();
  d.pools = []; d.awards = [];
  return d;
}

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

test('a round with no pool increase prices off the existing fully diluted base', () => {
  const r = modelRound(plainCompany(), {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: false,
  });
  assert.equal(ppsToDollars(r.pricePerShare), 1.0); // $8M / 8M shares
  assert.equal(r.newInvestorShares, 2_000_000);
  assert.equal(r.postRoundFullyDiluted, 10_000_000);
  assert.equal(r.postMoney, $(10_000_000));
  near(r.investorAllocations[0].pctPost, 0.2);
});

test('a pre-money pool shuffle dilutes only the existing holders', () => {
  const r = modelRound(plainCompany(), {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0.10, poolFromPreMoney: true, convertConvertibles: false,
  });
  // The classic result: investor 20%, fresh pool 10%, founders diluted to 70%.
  near(r.investorAllocations[0].pctPost, 0.20, 1e-5);
  near(r.poolPctAfter, 0.10, 1e-5);
  const founders = r.ownership.filter((o) => o.group === 'FOUNDER');
  near(founders.reduce((s, o) => s + o.pctAfter, 0), 0.70, 1e-5);
  // The pool and the new money both come out of the pre-money valuation.
  near(ppsToDollars(r.pricePerShare), 0.875, 1e-4);
  assert.ok(r.converged);
});

test('post-money input is equivalent to the matching pre-money', () => {
  const common = {
    name: 'Series A', closeDate: '2024-01-01',
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0.10, poolFromPreMoney: true, convertConvertibles: false,
  };
  const a = modelRound(plainCompany(), { ...common, preMoney: $(8_000_000) });
  const b = modelRound(plainCompany(), { ...common, postMoney: $(10_000_000) });
  assert.equal(a.pricePerShare, b.pricePerShare);
  assert.equal(a.postRoundFullyDiluted, b.postRoundFullyDiluted);
});

test('a post-money SAFE keeps exactly its contracted ownership through the round', () => {
  const data = plainCompany();
  const safe: Convertible = {
    id: 'safe1', stakeholderId: 'sh_inv', instrument: 'SAFE_POST', principal: $(1_000_000),
    issueDate: '2023-01-01', valuationCap: $(10_000_000), discount: 0, interestRate: 0,
    compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: true,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  };
  data.convertibles.push(safe);
  const r = modelRound(data, {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(20_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'NewCo', amount: $(5_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
  });
  // A $1M post-money SAFE on a $10M cap owns 10% of the pre-new-money company.
  const preNewMoney = r.preRoundFullyDiluted + r.conversionShares;
  near(r.conversionShares / preNewMoney, 0.10, 1e-4);
  assert.equal(r.conversions[0].method, 'CAP');
});

test('a convertible below the qualified financing minimum does not convert', () => {
  const data = plainCompany();
  data.convertibles.push({
    id: 'note1', stakeholderId: 'sh_inv', instrument: 'NOTE', principal: $(500_000),
    issueDate: '2023-01-01', valuationCap: $(8_000_000), discount: 0.2, interestRate: 0.05,
    compounding: 'SIMPLE', maturityDate: '2025-01-01', mfn: false, proRataRight: true,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: $(3_000_000), notes: null,
  });
  const r = modelRound(data, {
    name: 'Bridge', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ name: 'Angel', stakeholderId: null, amount: $(1_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
  });
  assert.equal(r.conversionShares, 0);
  assert.ok(r.warnings.some((w) => w.includes('qualified financing minimum')));
});

test('dilution is reported per holder and sums to the whole company', () => {
  const r = modelRound(plainCompany(), {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: false,
  });
  near(r.ownership.reduce((s, o) => s + o.pctAfter, 0), 1.0, 1e-6);
  const avery = r.ownership.find((o) => o.name === 'Avery Stone')!;
  near(avery.pctBefore, 0.5625);   // 4.5M / 8M
  near(avery.pctAfter, 0.45);      // 4.5M / 10M
  near(avery.dilutionRelative, 0.2);
  near(r.existingHolderDilution, 0.2, 1e-6);
});

test('broad-based weighted average anti-dilution reprices a down round', () => {
  const data = plainCompany();
  data.shareClasses.push(seriesA({ originalIssuePrice: $$(2.0), antiDilution: 'BROAD_WEIGHTED' }));
  data.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 1_000_000, pricePerShare: $$(2.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  const down = modelRound(data, {
    name: 'Series B (down)', closeDate: '2024-01-01', preMoney: $(4_500_000),
    investors: [{ name: 'Bridge Fund', stakeholderId: null, amount: $(1_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: false,
  });
  assert.ok(ppsToDollars(down.pricePerShare) < 2.0);
  const ad = computeAntiDilution(data, down);
  assert.equal(ad.length, 1);
  assert.ok(ad[0].newConversionPrice < ad[0].oldConversionPrice);
  assert.ok(ad[0].newConversionRatio > 1);
  assert.ok(ad[0].additionalShares > 0);
});

test('full ratchet resets the conversion price to the new round price', () => {
  const data = plainCompany();
  data.shareClasses.push(seriesA({ originalIssuePrice: $$(2.0), antiDilution: 'FULL_RATCHET' }));
  data.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 1_000_000, pricePerShare: $$(2.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  const down = modelRound(data, {
    name: 'Series B', closeDate: '2024-01-01', preMoney: $(4_500_000),
    investors: [{ name: 'Bridge Fund', stakeholderId: null, amount: $(1_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: false,
  });
  const ad = computeAntiDilution(data, down);
  assert.equal(ad[0].newConversionPrice, down.pricePerShare);
});

test('an up round triggers no anti-dilution adjustment', () => {
  const data = plainCompany();
  data.shareClasses.push(seriesA({ originalIssuePrice: $$(1.0), antiDilution: 'BROAD_WEIGHTED' }));
  data.issuances.push({
    id: 'is_a', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 1_000_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  const up = modelRound(data, {
    name: 'Series B', closeDate: '2024-01-01', preMoney: $(45_000_000),
    investors: [{ name: 'Growth Fund', stakeholderId: null, amount: $(5_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: false,
  });
  assert.equal(computeAntiDilution(data, up).length, 0);
  void dollarsToPPS;
});

test('a post-money SAFE owns principal / cap of the company capitalization, which excludes the round\'s pool top-up', () => {
  const data = plainCompany();
  data.convertibles.push({
    id: 'safe1', stakeholderId: 'sh_inv', instrument: 'SAFE_POST', principal: $(1_000_000),
    issueDate: '2023-01-01', valuationCap: $(10_000_000), discount: 0, interestRate: 0,
    compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: true,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  });
  const r = modelRound(data, {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(20_000_000),
    investors: [{ stakeholderId: null, name: 'NewCo', amount: $(5_000_000) }],
    targetPoolPct: 0.10, poolFromPreMoney: true, convertConvertibles: true,
  });
  // Existing fully diluted plus every converting SAFE — but not the pool increase.
  const companyCapitalization = r.preRoundFullyDiluted + r.conversionShares;
  near(r.conversionShares / companyCapitalization, 0.10, 1e-4);
  // So the pool top-up and the new money both dilute the SAFE holder, like founders.
  assert.ok(r.conversionShares / r.postRoundFullyDiluted < 0.10);
  assert.ok(r.poolIncrease > 0);
});

test('existing-holder dilution measures people, not the pool', () => {
  const r = modelRound(plainCompany(), {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0.10, poolFromPreMoney: true, convertConvertibles: false,
  });
  near(r.existingHolderDilution, 0.30, 1e-5);                   // founders 100% -> 70%
});

test('a post-money pool increase dilutes the new investors too', () => {
  const r = modelRound(plainCompany(), {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0.10, poolFromPreMoney: false, convertConvertibles: false,
  });
  assert.equal(ppsToDollars(r.pricePerShare), 1.0);              // pool is not in the pre-money share count
  near(r.investorAllocations[0].pctPost, 0.18, 1e-5);           // 20% diluted by a 10% pool
  near(r.poolPctAfter, 0.10, 1e-5);
});

test('an explicit pool increase overrides the target percentage', () => {
  const r = modelRound(plainCompany(), {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: 'sh_inv', name: 'Northwind', amount: $(2_000_000) }],
    targetPoolPct: 0.5, poolIncreaseShares: 1_000_000, poolFromPreMoney: true, convertConvertibles: false,
  });
  assert.equal(r.poolIncrease, 1_000_000);
  near(ppsToDollars(r.pricePerShare), 8 / 9, 1e-6);              // $8M over 9M pre-money shares
});

test('a note accrues interest into the converting amount and the discount beats a generous cap', () => {
  const data = plainCompany();
  data.convertibles.push({
    id: 'note', stakeholderId: 'sh_inv', instrument: 'NOTE', principal: $(1_000_000),
    issueDate: '2023-01-01', valuationCap: $(100_000_000), discount: 0.2, interestRate: 0.05,
    compounding: 'SIMPLE', maturityDate: '2026-01-01', mfn: false, proRataRight: true,
    status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  });
  const r = modelRound(data, {
    name: 'Series A', closeDate: '2024-01-01', preMoney: $(8_000_000),
    investors: [{ stakeholderId: null, name: 'X', amount: $(2_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
  });
  const c = r.conversions[0];
  assert.equal(c.method, 'DISCOUNT');
  near(c.amount / 100, 1_050_000, 200);                          // one year of 5% simple interest
  near(c.conversionPrice / r.pricePerShare, 0.8, 1e-6);
});
