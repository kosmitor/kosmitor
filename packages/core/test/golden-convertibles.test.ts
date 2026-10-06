/**
 * Golden cases for SAFEs, notes and priced rounds (convertibles.ts, round.ts), from
 * published worked examples. Each test cites its source. A test marked
 * { todo: 'BUG-ID' } pins the correct value for a confirmed bug
 * (math-audit-2026-10-05.md, section 2) and passes once the bug is fixed.
 *
 * YC Post-Money Safe User Guide (Feb 2023), "the guide" below:
 * https://bookface-static.ycombinator.com/assets/ycdc/SAFE%20User%20Guide-a47c6588327d73aa2799e61ed7c2cae9f1a0ee9acfa9c43b62039dc06e715832.pdf
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRound, modelConvertibleStack, computeAntiDilution, type RoundModelInput } from '../src/round.ts';
import { solvePostMoneySafes, convertOne, accruedInterest, resolveMFN } from '../src/convertibles.ts';
import { computeCapTable } from '../src/captable.ts';
import { computeWaterfall } from '../src/waterfall.ts';
import { ppsToDollars, sharesForAmount, dollarsToCents as $, dollarsToPPS as $$ } from '../src/util.ts';
import type { CompanyData } from '../src/types.ts';
import { abcInc, convertible, preferred, issuance, company, holder, award, pool } from './builders.ts';
import { refRound, refPostMoneySafes, type RefSafe } from './reference/safes.ts';
import { refActualActualYears } from './reference/calendar.ts';
import { rng, randomRound } from './reference/gen.ts';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const NO_ROUND = Number.MAX_SAFE_INTEGER;   // a liquidity event has no round price

/** ABC, Inc. with safe A ($200k) and safe B ($800k at an $8M post-money cap); A is post-money at $4M or pre-money at $3.8M. */
function abcWithSafes(aPreMoney: boolean): CompanyData {
  const d = abcInc();
  d.convertibles.push(
    aPreMoney ? convertible('invA', 'SAFE_PRE', 200_000, 3_800_000, { id: 'safeA' }) : convertible('invA', 'SAFE_POST', 200_000, 4_000_000, { id: 'safeA' }),
    convertible('invB', 'SAFE_POST', 800_000, 8_000_000, { id: 'safeB' }),
  );
  return d;
}

/** The guide's Series A ($15M pre, $5M) or Series Seed ($8.8M pre, $2.2M), 10% pool in the pre-money. */
function ycRound(seed: boolean, bProRata: number, others: number, o: Partial<RoundModelInput> = {}): RoundModelInput {
  return {
    name: seed ? 'Series Seed' : 'Series A', closeDate: '2022-01-01', preMoney: $(seed ? 8_800_000 : 15_000_000),
    investors: [
      { stakeholderId: 'invC', name: 'Investor C', amount: $(seed ? 1_650_000 : 4_000_000) },
      { stakeholderId: 'invB', name: 'Investor B pro rata', amount: $(bProRata) },
      { stakeholderId: 'others', name: 'Other new investors', amount: $(others) },
    ],
    targetPoolPct: 0.10, poolFromPreMoney: true, convertConvertibles: true, ...o,
  };
}

const ycRef = (seed: boolean, aPreMoney: boolean) => refRound({
  baseFD: 10_000_000, poolAvailable: 100_000, preMoney: seed ? 8_800_000 : 15_000_000, raise: seed ? 2_200_000 : 5_000_000, targetPool: 0.10,
  safes: [{ amount: 200_000, cap: aPreMoney ? 3_800_000 : 4_000_000, discount: 0, kind: aPreMoney ? 'PRE' : 'POST' }, { amount: 800_000, cap: 8_000_000, discount: 0, kind: 'POST' }],
});

const sharesOf = (r: ReturnType<typeof modelRound>, id: string) => r.conversions.find((c) => c.convertibleId === id)!.shares;

// ---------------------------------------------------------------------------
// The guide's four priced rounds (Appendix II)
// ---------------------------------------------------------------------------

test('YC App. II Ex.1 Q2 (p.19-20): price $1.114473, pool +1,694,570, A 588,235, B 1,176,470, pool 10.000%', () => {
  // The guide rounds the pool to 1,695,000 and the price to $1.1144; these are the exact solution.
  const r = modelRound(abcWithSafes(false), ycRound(false, 500_000, 500_000));
  assert.equal(ppsToDollars(r.pricePerShare), 1.114473);
  assert.equal(r.poolIncrease, 1_694_570);
  assert.equal(sharesOf(r, 'safeA'), 588_235);
  assert.equal(sharesOf(r, 'safeB'), 1_176_470);
  near(r.poolPctAfter, 0.10, 5e-6, 'pool after');
  assert.equal(r.converged, true);
});

test('YC App. II Ex.1 Q2 at the guide\'s rounded pool and price: Investor C gets 3,589,375 shares', () => {
  // With the guide's 1,695,000 pool the price is $1.114438, which the guide shows as $1.1144;
  // $4,000,000 at $1.1144 buys exactly the guide's 3,589,375 shares.
  const r = modelRound(abcWithSafes(false), ycRound(false, 500_000, 500_000, { targetPoolPct: 0, poolIncreaseShares: 1_695_000 }));
  assert.equal(Math.round(ppsToDollars(r.pricePerShare) * 10_000) / 10_000, 1.1144);
  assert.equal(sharesForAmount($(4_000_000), $$(1.1144)), 3_589_375);
});

test('YC App. II Ex.1 Q5 (p.22-24): B converts at the round price, A at its cap; price $0.657749, pool +1,572,371', () => {
  // Exact solution A 590,330.x and B 1,216,270.x; ±1 share because the app converts at a price
  // rounded to a micro-cent and floors.
  const r = modelRound(abcWithSafes(false), ycRound(true, 226_599, 323_401));
  const ref = ycRef(true, false);
  assert.equal(ppsToDollars(r.pricePerShare), 0.657749);
  assert.equal(r.poolIncrease, 1_572_371);
  near(sharesOf(r, 'safeA'), Math.floor(ref.postShares[0]), 1, 'A');
  near(sharesOf(r, 'safeB'), Math.floor(ref.postShares[1]), 1, 'B');
  assert.equal(r.conversions.find((c) => c.convertibleId === 'safeB')!.method, 'ROUND_PRICE');
});

test('YC App. II Ex.2 Q2 (p.24-26): pre-money safe A and post-money safe B; price $1.11156, pool +1,699,273', () => {
  // A's Safe Price is $3.8M over a capitalization that includes the pool increase; B's Company
  // Capitalization includes A. Exact A 615,751.2, B 1,179,527.9 (guide, at 4-decimal prices:
  // 615,763 and 1,179,529); ±2 shares for the micro-cent prices.
  const r = modelRound(abcWithSafes(true), ycRound(false, 500_000, 500_000));
  const ref = ycRef(false, true);
  assert.equal(ppsToDollars(r.pricePerShare), 1.11156);
  assert.equal(r.poolIncrease, 1_699_273);
  near(sharesOf(r, 'safeA'), Math.floor(ref.preShares[0]), 2, 'A');
  near(sharesOf(r, 'safeB'), Math.floor(ref.postShares[1]), 2, 'B');
});

test('YC App. II Ex.2 Q5 (p.29-30): price $0.656566, pool +1,575,384, A 609,230, B 1,218,461 ±1', () => {
  const r = modelRound(abcWithSafes(true), ycRound(true, 226_600, 323_400));
  assert.equal(ppsToDollars(r.pricePerShare), 0.656566);
  assert.equal(r.poolIncrease, 1_575_384);
  assert.equal(sharesOf(r, 'safeA'), 609_230);
  near(sharesOf(r, 'safeB'), 1_218_461, 1, 'B');
});

test('Independent reference reproduces the guide: Ex.1 Q2 price $1.114473 and pool 1,694,570; Ex.2 Q2 A 615,751 and B 1,179,527', () => {
  // The reference (test/reference/safes.ts) must pass the golden cases before it checks the engine.
  const q2 = ycRef(false, false);
  near(q2.price, 1.114473, 5e-7, 'price');
  assert.equal(Math.floor(q2.poolIncrease), 1_694_570);
  assert.deepEqual(q2.postShares.map(Math.floor), [588_235, 1_176_470]);
  const ex2 = ycRef(false, true);
  assert.deepEqual([Math.floor(ex2.preShares[0]), Math.floor(ex2.postShares[1])], [615_751, 1_179_527]);
});

// ---------------------------------------------------------------------------
// Liquidity capitalization and implied ownership
// ---------------------------------------------------------------------------

test('YC App. II Ex.1 Q3 (p.21-22): Liquidity Capitalization 11,235,293; A 561,764, B 1,123,529', () => {
  // 9,550,000 / (1 - 5% - 10%), floored per safe.
  const d = abcWithSafes(false);
  const r = solvePostMoneySafes(d.convertibles, 9_550_000, NO_ROUND, '2022-01-01');
  assert.deepEqual([r.shares.get('safeA'), r.shares.get('safeB'), r.totalCapitalization], [561_764, 1_123_529, 11_235_293]);
  const ref = refPostMoneySafes(9_550_000, [{ amount: 200_000, cap: 4_000_000, fixedPrice: Infinity }, { amount: 800_000, cap: 8_000_000, fixedPrice: Infinity }]);
  assert.deepEqual(ref.shares.map(Math.floor), [561_764, 1_123_529]);
});

test('YC App. II Ex.2 Q3 (p.28): pre-money safe A converts on 9,550,000 first, then B; A 502,631, B 1,116,959, total 11,169,590', () => {
  const d = abcWithSafes(true);
  const a = convertOne(d.convertibles[0], { asOf: '2022-01-01', roundPPS: NO_ROUND, preMoneyCapitalization: 9_550_000, postMoneyCapitalization: 9_550_000 });
  assert.equal(a.shares, 502_631);
  const r = solvePostMoneySafes([d.convertibles[1]], 9_550_000 + a.shares, NO_ROUND, '2022-01-01');
  assert.deepEqual([r.shares.get('safeB'), r.totalCapitalization], [1_116_959, 11_169_590]);
});

test('YC Quick Start and App. II Ex.1 Q1: $200k at $4M and $800k at $8M own 5% + 10% = 15%', () => {
  const s = modelConvertibleStack(abcWithSafes(false), '2022-01-01');
  assert.deepEqual(s.instruments.map((i) => i.impliedOwnershipPct), [0.05, 0.10]);
  near(s.guaranteedOwnership, 0.15, 1e-12, 'guaranteed');
});

test('YC Quick Start #2: $500k at $5.5M and $500k at $8.3M own about 9.09% and 6.02%', () => {
  const q1 = convertible('a', 'SAFE_POST', 500_000, 5_500_000, { id: 'q1' });
  const q2 = convertible('b', 'SAFE_POST', 500_000, 8_300_000, { id: 'q2' });
  const r = solvePostMoneySafes([q1, q2], 10_000_000, NO_ROUND, '2022-01-01');
  near(r.shares.get('q1')! / r.totalCapitalization, 0.0909, 1e-4, 'q1');
  near(r.shares.get('q2')! / r.totalCapitalization, 0.0602, 1e-4, 'q2');
});

test('YC pre-money safe, guide Ex.2 Q2 (p.25): $700k at a $7M cap over 6,000,000 converts into 600,000 shares ±1', () => {
  // Safe Price = cap / capitalization = $1.1666…; the app rounds the price to a micro-cent and
  // floors, giving 599,999. The safe sets no rounding rule, so ±1 share is within convention
  // (the audit's skeptic refuted CR-7 as a bug).
  const s = convertible('x', 'SAFE_PRE', 700_000, 7_000_000);
  const r = convertOne(s, { asOf: '2024-01-01', roundPPS: $$(5), preMoneyCapitalization: 6_000_000, postMoneyCapitalization: 6_000_000 });
  near(r.shares, 600_000, 1, 'shares');
});

// ---------------------------------------------------------------------------
// Option pool shuffle
// Venture Hacks, "The Option Pool Shuffle": https://venturehacks.com/option-pool-shuffle
// ---------------------------------------------------------------------------

function sixMillionFounders(): CompanyData {
  const d = abcInc();
  d.issuances[0].quantity = 6_000_000;
  d.awards = [];
  d.pools = [];
  return d;
}
const shuffle = (pool: number) => modelRound(sixMillionFounders(), {
  name: 'Series A', closeDate: '2022-01-01', preMoney: $(8_000_000), investors: [{ stakeholderId: null, name: 'VC', amount: $(2_000_000) }],
  targetPoolPct: pool, poolFromPreMoney: true, convertConvertibles: false,
});

test('Venture Hacks option pool shuffle, 20% pool: $1.00 a share, pool 2,000,000, founders 60%', () => {
  const r = shuffle(0.2);
  assert.equal(ppsToDollars(r.pricePerShare), 1);
  assert.deepEqual([r.poolIncrease, r.newInvestorShares, r.postRoundFullyDiluted], [2_000_000, 2_000_000, 10_000_000]);
  near(r.ownership.find((o) => o.stakeholderId === 'founders')!.pctAfter, 0.6, 1e-9, 'founders');
});

test('Venture Hacks option pool shuffle, 10% pool: $1.1667 a share, founders 70%, investor 20%', () => {
  const r = shuffle(0.1);
  near(ppsToDollars(r.pricePerShare), 7 / 6, 1e-6, 'price');
  near(r.ownership.find((o) => o.stakeholderId === 'founders')!.pctAfter, 0.7, 1e-6, 'founders');
  near(r.investorAllocations[0].pctPost, 0.2, 1e-6, 'investor');
});

// ---------------------------------------------------------------------------
// Fixed bugs, pinned at the correct value (math audit, section 2)
// ---------------------------------------------------------------------------

/** The audit's CR-3 case: ABC with 650,000 options and a 2,000,000 unissued pool, Series A at $2, a $3M round at $1. */
function downRound(seriesA: [string, number][] = [['invA', 1_000_000]]) {
  const d = abcInc();
  d.pools[0].authorized = 650_000 + 2_000_000;
  d.shareClasses.push(preferred('sa', 'Series A', 2, { antiDilution: 'BROAD_WEIGHTED' }));
  for (const [holderId, shares] of seriesA) d.issuances.push(issuance(holderId, 'sa', shares, $$(2), '2021-06-01'));
  const r = modelRound(d, {
    name: 'Series B', closeDate: '2022-01-01', preMoney: $(12_900_000), investors: [{ stakeholderId: null, name: 'New investor', amount: $(3_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: false,
  });
  return { r, ad: computeAntiDilution(d, r)[0] };
}

test('NVCA Model COI §4.4.4 broad-based weighted average: CP2 $1.7842 and 120,950 more whole shares', () => {
  // https://nvca.org/wp-content/uploads/2025/10/NVCA-Model-COI-10-1-2025.docx
  // A = 9,250,000 common + 650,000 options + 1,000,000 Series A = 10,900,000 (the reserved pool is
  // not in A); B = $3M / $2 = 1,500,000; C = 3,000,000. CP2 = 2 x 12.4M / 13.9M, to the nearest
  // hundredth of a cent (§4.4.4). §4.3 issues no fractional shares: 1,000,000 x $2 / $1.7842 =
  // 1,120,950.57 converts into 1,120,950 shares and cash for the fraction.
  // Before the CR-3 fix the app counted the 2,000,000 unissued pool in A: CP2 $1.811321, 104,166.52 shares;
  // then it rounded the class to the nearest share, 120,951, which neither bracket of §4.3 gives.
  const { r, ad } = downRound();
  assert.equal(r.pricePerShare, $$(1));
  assert.equal(ad.newConversionPrice, $$(1.7842));
  assert.equal(ad.additionalShares, 120_950);
});

test('NVCA Model COI §4.3: each holder\'s fraction is settled on its own, so three holders get 120,948 more shares', () => {
  // The same round with the Series A held 333,334 / 333,333 / 333,333: each holder's extra 40,316.94 or
  // 40,316.82 shares are 40,316 whole shares and cash, 120,948 in all, not the class's 120,950.
  const { ad } = downRound([['invA', 333_334], ['invB', 333_333], ['invC', 333_333]]);
  assert.equal(ad.newConversionPrice, $$(1.7842));
  assert.equal(ad.additionalShares, 3 * 40_316);
});

test('Holloway annotated note: one full year of 6% simple interest on $1,000,000 is $60,000.00, leap year or not', () => {
  // https://www.holloway.com/g/angel-investing/sections/annotated-convertible-note
  // "a 365-day or 366-day year, as the case may be, for the actual number of days elapsed".
  // Before the CR-5 fix the app divided by 365.25: $59,958.93 for 2023 and $60,123.20 for 2024.
  const note = (issueDate: string) => convertible('x', 'NOTE', 1_000_000, null, { interestRate: 0.06, issueDate });
  assert.equal(accruedInterest(note('2023-01-01'), '2024-01-01'), $(60_000));
  assert.equal(accruedInterest(note('2024-01-01'), '2025-01-01'), $(60_000));
});

test('Holloway annotated note: interest accrues from the date the funds are received', () => {
  // Issued 2023-01-01, funded 2023-07-01: 184 days of 2023 at 6% on $1M, Actual/Actual = $30,246.58.
  // Before the CR-5 fix the app accrued from the issue date: $59,958.93.
  const n = convertible('x', 'NOTE', 1_000_000, null, { interestRate: 0.06, issueDate: '2023-01-01', fundsReceivedOn: '2023-07-01' });
  near(accruedInterest(n, '2024-01-01'), Math.round(1_000_000_00 * 0.06 * refActualActualYears('2023-07-01', '2024-01-01')), 1, 'interest');
});

test('Compound interest: whole compounding periods give (1 + r)^n - 1 exactly', () => {
  // 8% annual over two years: $166,400.00. 12% monthly (1% a month) over 12 months: $126,825.03.
  // Before the CR-5 fix the app gave $166,522.89 and $126,732.94.
  const annual = convertible('x', 'NOTE', 1_000_000, null, { interestRate: 0.08, compounding: 'ANNUAL', issueDate: '2023-01-01' });
  assert.equal(accruedInterest(annual, '2025-01-01'), $(166_400));
  const monthly = convertible('x', 'NOTE', 1_000_000, null, { interestRate: 0.12, compounding: 'MONTHLY', issueDate: '2023-01-01' });
  near(accruedInterest(monthly, '2024-01-01'), Math.round((1.01 ** 12 - 1) * 1_000_000_00), 1, 'monthly');
});

test('Compound interest: between compounding dates interest is simple on the compounded balance', () => {
  // $1M at 8% compounded annually from 2023-01-01 to 2024-07-01: a year compounded, then 182 of 2024's 366 days
  // simple on $1.08M, 1.08 x (1 + 0.08 x 182/366) - 1 = $122,963.93. 12% monthly to 2024-01-16: twelve months
  // compounded, then 15 of January's 31 days at 1%. Before the fix the period in progress compounded too:
  // $122,132.94 for the first.
  const annual = convertible('x', 'NOTE', 1_000_000, null, { interestRate: 0.08, compounding: 'ANNUAL', issueDate: '2023-01-01' });
  assert.equal(accruedInterest(annual, '2024-07-01'), Math.round((1.08 * (1 + 0.08 * 182 / 366) - 1) * 1_000_000_00));
  const monthly = convertible('x', 'NOTE', 1_000_000, null, { interestRate: 0.12, compounding: 'MONTHLY', issueDate: '2023-01-01' });
  assert.equal(accruedInterest(monthly, '2024-01-16'), Math.round((1.01 ** 12 * (1 + 0.01 * 15 / 31) - 1) * 1_000_000_00));
});

test('YC guide p.12-13, 22-23: a post-money safe the round price no longer beats converts at its cap', () => {
  // Y $1M at a $3.6M cap, Z $2M at a $20M cap, base 1,000,000, round price $1.00. Z converts at the
  // round price; with Z's shares in Company Capitalization, Y's cap price ($0.87) beats $1.00 again.
  // Unique fixed point: T = 3,000,000 / (1 - 1/3.6) = 4,153,846, Y 1,153,846 = 1/3.6 of T.
  // Before the CR-1 fix the app dropped Y's cap for good and gave Y 1,111,111, T 4,111,111.
  const Y = convertible('y', 'SAFE_POST', 1_000_000, 3_600_000, { id: 'Y' });
  const Z = convertible('z', 'SAFE_POST', 2_000_000, 20_000_000, { id: 'Z' });
  const r = solvePostMoneySafes([Y, Z], 1_000_000, $$(1), '2024-01-01');
  assert.deepEqual([r.shares.get('Y'), r.shares.get('Z'), r.totalCapitalization], [1_153_846, 2_000_000, 4_153_846]);
});

test('Independent reference: the CR-1 safes solve to T 4,153,846 and Y 1,153,846', () => {
  const ref = refPostMoneySafes(1_000_000, [{ amount: 1_000_000, cap: 3_600_000, fixedPrice: 1 }, { amount: 2_000_000, cap: 20_000_000, fixedPrice: 1 }]);
  assert.deepEqual([Math.floor(ref.T), Math.floor(ref.shares[0]), Math.floor(ref.shares[1])], [4_153_846, 1_153_846, 2_000_000]);
});

test('YC guide p.20, 22: a round with no solution is refused, not reported as converged', () => {
  // An uncapped $6M pre-money safe converting at the round price out of a $5M pre-money: the
  // pre-money shares S satisfy S(1 - 6/5) = 10,000,000, which has no positive root. Before the CR-2 fix
  // the app reported converged with a $0.000002 price and 3 trillion conversion shares. Throwing or
  // warning both pass.
  const d = abcInc();
  d.convertibles.push(convertible('invA', 'SAFE_PRE', 6_000_000, null));
  let r: ReturnType<typeof modelRound>;
  try {
    r = modelRound(d, {
      name: 'Series A', closeDate: '2022-01-01', preMoney: $(5_000_000), investors: [{ stakeholderId: null, name: 'Investor C', amount: $(2_000_000) }],
      targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
    });
  } catch {
    return;
  }
  assert.ok(!r.converged || r.warnings.length > 0, `converged at $${ppsToDollars(r.pricePerShare)} with ${r.conversionShares} conversion shares and no warning`);
});

/** 10,000,000 founder shares and one safe; a round of `raise` dollars on a $5M pre-money with a 20% pool. */
const poolRound = (safe: Parameters<typeof convertible> | null, raise: number, o: Partial<RoundModelInput> = {}) => modelRound(
  company({
    stakeholders: [holder('f', 'Founders'), holder('i', 'Safe holder', 'INVESTOR')],
    issuances: [issuance('f', 'common', 10_000_000, $$(0.0001), '2020-01-01')],
    convertibles: safe ? [convertible(...safe)] : [],
  }),
  {
    name: 'Series A', closeDate: '2022-01-01', preMoney: $(5_000_000), investors: [{ stakeholderId: null, name: 'Lead', amount: $(raise) }],
    targetPoolPct: 0.20, poolFromPreMoney: true, convertConvertibles: true, ...o,
  },
);

test('YC guide p.20, 22: the pool increase counts toward a round with no solution', () => {
  // Price = pre-money / (pre-round FD + conversions + pool increase). An uncapped $3.2M pre-money safe takes
  // 3.2/5 = 64% of the pre-money shares; a pool of 20% of a post-round total that is (5 + 5)/5 of them takes
  // another 40%: 104%, so no price solves it. With $2.5M (50% + 40%) the pre-money shares are
  // 10,000,000 / (1 - 0.9) = 100,000,000 and the price $0.05. Before the fix the app left the pool out of
  // the test and reported converged at $0.00001 with 320,000,000,000 conversion shares and no warning.
  assert.throws(() => poolRound(['i', 'SAFE_PRE', 3_200_000, null], 5_000_000), /^RangeError: No round price solves these terms: .* 104% of the pre-money valuation/);
  const ok = poolRound(['i', 'SAFE_PRE', 2_500_000, null], 5_000_000);
  near(ppsToDollars(ok.pricePerShare), 0.05, 0.00001, 'price');
  assert.deepEqual([ok.converged, ok.warnings], [true, []]);
});

test('YC guide p.20, 22: a pre-money cap priced on a base that includes the pool grows with the pool', () => {
  // $5M pre-money, $20M raised, a 20% pool out of the pre-money: the pool alone is 20% of (5 + 20)/5 = 100%
  // of the pre-money shares. A $3M safe at a $4M cap on a base that includes the pool adds 3/4 of the pool
  // again. Before the fix the app reported converged at $0.000001 with 3,000,000,000,000 conversion shares.
  assert.throws(() => poolRound(null, 20_000_000), /^RangeError: No round price solves these terms: the option pool increase would take 100%/);
  assert.throws(() => poolRound(['i', 'SAFE_PRE', 3_000_000, 4_000_000], 20_000_000), /^RangeError: No round price solves these terms: .* 175% of the pre-money valuation/);
  // Pool from the post-money: the price divides only founders and conversions, but a $3M safe at a $2M cap
  // takes 1.5 shares per share of its base, and the pool in that base grows by 20% x (1 + 20/5) / 80% = 1.25
  // per pre-money share: 188%. Priced on a base without the pool, the same safe converts at $0.20.
  assert.throws(() => poolRound(['i', 'SAFE_PRE', 3_000_000, 2_000_000], 20_000_000, { poolFromPreMoney: false }), /188% of the pre-money valuation/);
  const noPool = poolRound(['i', 'SAFE_PRE', 3_000_000, 2_000_000], 20_000_000, { poolFromPreMoney: false, capIncludesNewPool: false });
  assert.deepEqual([noPool.pricePerShare, noPool.conversionShares, noPool.converged], [$$(0.2), 15_000_000, true]);
});

test('Seeded rounds: modelRound refuses exactly the rounds no price solves', () => {
  // 600 random rounds with the pre-money shrunk so that many have no solution, against an exact real-valued
  // iteration of price = pre-money / (pre-round FD + conversions + pool increase) that diverges when none
  // exists. Before the fix seed 34 drove the price to zero and failed with 'Round price must be positive and
  // finite', and others in a longer run converged at a few millionths of a dollar with trillions of shares.
  const exact = (rr: ReturnType<typeof randomRound>, fromPre: boolean): 'solves' | 'none' => {
    const E = rr.baseFD, A = rr.poolAvailable, t = rr.targetPool;
    let M = E, Q = 0;
    for (let k = 0; k < 200_000; k++) {
      const p = rr.preMoney / M;
      const pre = rr.safes.filter((s) => s.kind === 'PRE')
        .reduce((s, x) => s + x.amount / Math.min(x.cap ? x.cap / (E + Q) : Infinity, p * (1 - x.discount)), 0);
      const posts = rr.safes.filter((s) => s.kind === 'POST').map((x) => ({ amount: x.amount, cap: x.cap, fixedPrice: p * (1 - x.discount) }));
      const C = refPostMoneySafes(E + pre, posts).T - E;
      const nextQ = t > 0 ? Math.max(0, (t * (E + C + rr.raise / p) - A) / (1 - t)) : 0;
      const nextM = fromPre ? E + nextQ + C : E + C;
      if (nextM > 1e7 * E) return 'none';
      if (Math.abs(nextM - M) < 1e-9 * M) return 'solves';
      M = nextM; Q = nextQ;
    }
    throw new Error('the reference did not settle');
  };
  let refused = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed * 31);
    const rr = randomRound(r);
    rr.preMoney = Math.round(rr.preMoney * (0.05 + r() * 0.5));
    const fromPre = seed % 2 === 0;
    const d = company({
      stakeholders: [holder('f', 'Founder'), holder('e', 'Employee', 'EMPLOYEE'), holder('i', 'Safe holder', 'INVESTOR')],
      issuances: [issuance('f', 'common', rr.founders, 1, '2020-01-01')],
      awards: rr.granted > 0 ? [award('e', rr.granted, { vestingScheduleId: 'vs_full', grantDate: '2020-06-01' })] : [],
      pools: [pool(rr.granted + rr.poolAvailable)],
      convertibles: rr.safes.map((s, k) => convertible('i', s.kind === 'POST' ? 'SAFE_POST' : 'SAFE_PRE', s.amount, s.cap, { id: `c${k}`, discount: s.discount, issueDate: `2021-0${k + 1}-01` })),
    });
    let outcome: 'solves' | 'none';
    try {
      const res = modelRound(d, {
        name: 'Series A', closeDate: '2023-01-01', preMoney: $(rr.preMoney), investors: [{ stakeholderId: null, name: 'Lead', amount: $(rr.raise) }],
        targetPoolPct: rr.targetPool, poolFromPreMoney: fromPre, convertConvertibles: true,
      });
      assert.ok(res.converged, `seed ${seed} did not converge`);
      outcome = 'solves';
    } catch (e) {
      assert.match(String(e), /^RangeError: No round price solves these terms/, `seed ${seed}`);
      outcome = 'none';
      refused++;
    }
    assert.equal(outcome, exact(rr, fromPre), `seed ${seed}`);
  }
  assert.ok(refused > 50, `only ${refused} of 600 had no solution; the sweep tests little`);
});

test('YC guide App. I.3: an MFN safe that adopts a later pre-money safe becomes that safe, base and all', () => {
  // The amended safe is identical to the later safe apart from the Purchase Amount, so $100k on a
  // $6M pre-money cap over a 9,000,000 pre-money base: 150,000 shares (±1 for price rounding).
  // Before the CR-4 fix the app kept its post-money base: $0.60 and 166,666 shares.
  const mfn = convertible('x', 'SAFE_POST', 100_000, null, { id: 'mfn', mfn: true, issueDate: '2023-01-01' });
  const later = convertible('y', 'SAFE_PRE', 100_000, 6_000_000, { id: 'later', issueDate: '2023-03-01' });
  const r = convertOne(mfn, { asOf: '2024-01-01', roundPPS: $$(2), preMoneyCapitalization: 9_000_000, postMoneyCapitalization: 10_000_000, allConvertibles: [mfn, later] });
  near(r.shares, 150_000, 1, 'shares');
});

test('YC guide App. I.3: a safe not yet signed does not trigger an MFN', () => {
  // An MFN adopts terms of safes the company has issued. A later safe awaiting signature has not
  // been issued, so the MFN (no cap, no discount) converts at the $2.00 round price: 50,000 shares.
  // Before the CR-4 fix the pending safe's $5M cap applied.
  const mfn = convertible('x', 'SAFE_POST', 100_000, null, { id: 'mfn', mfn: true, issueDate: '2023-01-01' });
  const pending = convertible('y', 'SAFE_POST', 100_000, 5_000_000, { id: 'pending', issueDate: '2023-03-01', status: 'PENDING_SIGNATURE' });
  const r = convertOne(mfn, { asOf: '2024-01-01', roundPPS: $$(2), preMoneyCapitalization: 9_000_000, postMoneyCapitalization: 10_000_000, allConvertibles: [mfn, pending] });
  assert.equal(r.shares, 50_000);
});

test('YC guide p.19: a post-money safe owning 98% by its cap converts into 98% of Company Capitalization', () => {
  // 10,000,000 existing; $9.8M at a $10M post-money cap; $100M pre-money, $10M raise, no pool.
  // S = 0.98 x (10,000,000 + S), so S = 490,000,000. Before the CR-6 fix the app stalled on its
  // rounded price and reported converged with 489,412,704.
  const d = abcInc();
  d.convertibles.push(convertible('invA', 'SAFE_POST', 9_800_000, 10_000_000, { id: 'big' }));
  const r = modelRound(d, {
    name: 'Series A', closeDate: '2022-01-01', preMoney: $(100_000_000), investors: [{ stakeholderId: null, name: 'Investor C', amount: $(10_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
  });
  near(sharesOf(r, 'big'), 490_000_000, 1, 'conversion shares');
});

test('Pool from the post-money: the round also reports the post-money it implies, price x post-round fully diluted', () => {
  // 8,000,000 founder shares; $10M pre-money; $2.5M raised; a 10% pool out of the post-money. The price is
  // $10M / 8,000,000 = $1.25, the investor buys 2,000,000 shares and the pool is 10% of 11,111,111. Pre-money
  // plus new money is $12.5M, but $1.25 x 11,111,111 = $13,888,888.75, because the new pool is priced in
  // too (CR-8). With the pool in the pre-money the two agree, up to the micro-cent price.
  const d = company({ stakeholders: [holder('f', 'Founders')], issuances: [issuance('f', 'common', 8_000_000, $$(0.0001), '2020-01-01')] });
  const round = (poolFromPreMoney: boolean) => modelRound(d, {
    name: 'Series A', closeDate: '2022-01-01', preMoney: $(10_000_000), investors: [{ stakeholderId: null, name: 'Lead', amount: $(2_500_000) }],
    targetPoolPct: 0.10, poolFromPreMoney, convertConvertibles: false,
  });
  const post = round(false);
  assert.equal(post.pricePerShare, $$(1.25));
  assert.deepEqual([post.newInvestorShares, post.poolIncrease, post.postRoundFullyDiluted], [2_000_000, 1_111_111, 11_111_111]);
  assert.deepEqual([post.postMoney, post.impliedPostMoney], [$(12_500_000), 1_388_888_875]);
  const pre = round(true);
  near(pre.impliedPostMoney, pre.postMoney, $(10), 'implied post-money');
});

// A pre-money safe through modelRound against the reference, for a case the guide does not cover.
test('Independent reference agrees with modelRound on a mixed stack with discounts (within 2 shares per safe)', () => {
  const safes: RefSafe[] = [
    { kind: 'POST', amount: 500_000, cap: 6_000_000, discount: 0.2 },
    { kind: 'PRE', amount: 300_000, cap: 5_000_000, discount: 0 },
    { kind: 'POST', amount: 250_000, cap: null, discount: 0.15 },
  ];
  const d = company({
    stakeholders: [holder('f', 'Founders'), holder('s0', 'Safe 0', 'INVESTOR'), holder('s1', 'Safe 1', 'INVESTOR'), holder('s2', 'Safe 2', 'INVESTOR')],
    issuances: [issuance('f', 'common', 8_000_000, $$(0.0001), '2020-01-01')],
  });
  safes.forEach((s, i) => d.convertibles.push(convertible(`s${i}`, s.kind === 'POST' ? 'SAFE_POST' : 'SAFE_PRE', s.amount, s.cap, { id: `safe${i}`, discount: s.discount })));
  const r = modelRound(d, {
    name: 'Series A', closeDate: '2022-01-01', preMoney: $(12_000_000), investors: [{ stakeholderId: null, name: 'Lead', amount: $(3_000_000) }],
    targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
  });
  const ref = refRound({ baseFD: 8_000_000, poolAvailable: 0, preMoney: 12_000_000, raise: 3_000_000, targetPool: 0, safes });
  near(ppsToDollars(r.pricePerShare), ref.price, 1e-6, 'price');
  safes.forEach((_, i) => near(sharesOf(r, `safe${i}`), Math.floor(ref.preShares[i] + ref.postShares[i]), 2, `safe ${i}`));
});

// ---------------------------------------------------------------------------
// MFN safes. YC Safe (MFN), "MFN Amendment Provision": if the company issues
// Subsequent Convertible Securities and the investor finds their terms
// preferable, the company amends the safe "to be identical to" that instrument.
// The holder takes ONE later instrument in full: cap, discount and basis.
// ---------------------------------------------------------------------------

/** 10,000,000 founder shares, no pool, and the given safes; each safe has its own holder. */
const mfnCompany = (...safes: ReturnType<typeof convertible>[]) => company({
  stakeholders: [holder('f', 'Founders'), ...safes.map((s) => holder(s.stakeholderId, s.stakeholderId, 'INVESTOR'))],
  issuances: [issuance('f', 'common', 10_000_000, $$(0.0001), '2020-01-01')],
  convertibles: safes,
});
const mfnRound = (d: CompanyData, preMoney: number, closeDate: string) => modelRound(d, {
  name: 'Series A', closeDate, preMoney: $(preMoney), investors: [{ stakeholderId: null, name: 'Lead', amount: $(5_000_000) }],
  targetPoolPct: 0, poolFromPreMoney: true, convertConvertibles: true,
});

test('YC MFN Amendment Provision: the best cap and the best discount sit on two later safes; the MFN adopts one of them whole', () => {
  // MFN $1M pre-money, no cap, no discount (Jan 2022). A: $1M pre-money, $8M cap, no discount (Mar 2022).
  // B: $1M pre-money, $20M cap, 20% discount (Jun 2022). Round: $30M pre-money, $5M raised, no pool.
  // Effective valuation at $30M: A = min($8M, $30M) = $8M; B = min($20M, $30M x 0.8 = $24M) = $20M. A wins,
  // so the MFN is A: $8M cap, no discount. Cap price $8M / 10,000,000 = $0.80 -> MFN and A 1,250,000 each.
  // Price p = $30M / (10,000,000 + S). B at its $2.00 cap would be 500,000, S = 3,000,000, p = $2.3077,
  // and B's discount price 0.8p = $1.846 beats $2.00, so B converts at 0.8p: p x 12,500,000 + $1M / 0.8 =
  // $30M, p = $28.75M / 12,500,000 = $2.30, B = $1M / $1.84 = 543,478. The MFN has no discount price:
  // before the fix it took A's cap and B's 20% discount.
  const mfn = convertible('m', 'SAFE_PRE', 1_000_000, null, { id: 'mfn', mfn: true, issueDate: '2022-01-01' });
  const a = convertible('a', 'SAFE_PRE', 1_000_000, 8_000_000, { id: 'A', issueDate: '2022-03-01' });
  const b = convertible('b', 'SAFE_PRE', 1_000_000, 20_000_000, { id: 'B', discount: 0.2, issueDate: '2022-06-01' });
  const d = mfnCompany(mfn, a, b);
  assert.deepEqual(resolveMFN(mfn, d.convertibles, '2023-01-01', $(30_000_000)), { cap: $(8_000_000), discount: 0, instrument: 'SAFE_PRE' });
  const r = mfnRound(d, 30_000_000, '2023-01-01');
  const m = r.conversions.find((c) => c.convertibleId === 'mfn')!;
  assert.equal(m.discountPrice, null);
  assert.equal(m.method, 'MFN_CAP');
  near(m.shares, 1_250_000, 1, 'MFN');
  near(sharesOf(r, 'A'), 1_250_000, 1, 'A');
  near(sharesOf(r, 'B'), 543_478, 1, 'B');
  near(ppsToDollars(r.pricePerShare), 2.30, 1e-6, 'price');
});

test('YC MFN Amendment Provision: when the discount is worth more, the MFN adopts the discounted safe whole, cap included', () => {
  // Same safes, a $9M pre-money. A = min($8M, $9M) = $8M; B = min($20M, $9M x 0.8 = $7.2M) = $7.2M. B wins:
  // the MFN takes B's $20M cap and 20% discount and drops A's $8M cap.
  const mfn = convertible('m', 'SAFE_PRE', 1_000_000, null, { id: 'mfn', mfn: true, issueDate: '2022-01-01' });
  const all = [mfn, convertible('a', 'SAFE_PRE', 1_000_000, 8_000_000, { issueDate: '2022-03-01' }),
    convertible('b', 'SAFE_POST', 1_000_000, 20_000_000, { discount: 0.2, issueDate: '2022-06-01' })];
  assert.deepEqual(resolveMFN(mfn, all, '2023-01-01', $(9_000_000)), { cap: $(20_000_000), discount: 0.2, instrument: 'SAFE_POST' });
});

test('YC MFN Amendment Provision: a safe issued after the round is not a Subsequent Convertible Security the MFN can adopt', () => {
  // MFN $1M pre-money, no cap (Jan 2022); A $1M pre-money at $10M (Jun 2022); C $1M pre-money at $2M,
  // issued Jun 2023, after the Jan 2023 round. The MFN adopts A only: cap price $10M / 10,000,000 = $1.00,
  // 1,000,000 shares, as A. Round price $30M / 12,000,000 = $2.50, above the cap price. With C's cap
  // it would have been $0.20 and 5,000,000 shares.
  const d = mfnCompany(
    convertible('m', 'SAFE_PRE', 1_000_000, null, { id: 'mfn', mfn: true, issueDate: '2022-01-01' }),
    convertible('a', 'SAFE_PRE', 1_000_000, 10_000_000, { id: 'A', issueDate: '2022-06-01' }),
    convertible('c', 'SAFE_PRE', 1_000_000, 2_000_000, { id: 'C', issueDate: '2023-06-01' }),
  );
  const r = mfnRound(d, 30_000_000, '2023-01-01');
  near(sharesOf(r, 'mfn'), 1_000_000, 1, 'MFN');
  near(ppsToDollars(r.pricePerShare), 2.5, 1e-6, 'price');
});

test('One MFN resolution: the cap table, modelRound and the waterfall give an MFN safe the same shares', () => {
  // 10,000,000 common. The MFN ($1M, no cap, Jan 2022) adopts a later $1M safe's cap (Jun 2022).
  //  - Pre-money later safe at $5M: both price at $5M / 10,000,000 = $0.50 -> 2,000,000 shares each,
  //    whether the MFN was pre- or post-money, since it takes the later safe's basis.
  //  - Post-money later safe at $10M: each owns $1M / $10M = 10% of T = 10,000,000 + 2S with S = 0.1T,
  //    so T = 12,500,000 and S = 1,250,000.
  // The round ($50M pre-money, $5M) prices above every cap price ($50M / 14M = $3.57, $50M / 12.5M = $4),
  // so the caps bind there too; the $100M exit is far above the $1M cash-outs.
  const cases = [
    { mfn: 'SAFE_PRE', later: 'SAFE_PRE', cap: 5_000_000, shares: 2_000_000 },
    { mfn: 'SAFE_POST', later: 'SAFE_PRE', cap: 5_000_000, shares: 2_000_000 },
    { mfn: 'SAFE_POST', later: 'SAFE_POST', cap: 10_000_000, shares: 1_250_000 },
    { mfn: 'SAFE_PRE', later: 'SAFE_POST', cap: 10_000_000, shares: 1_250_000 },
  ] as const;
  for (const k of cases) {
    const d = mfnCompany(
      convertible('m', k.mfn, 1_000_000, null, { id: 'mfn', mfn: true, issueDate: '2022-01-01' }),
      convertible('l', k.later, 1_000_000, k.cap, { id: 'later', issueDate: '2022-06-01' }),
    );
    const what = `${k.mfn} MFN adopting ${k.later}`;
    const table = computeCapTable(d, { asOf: '2025-01-01', includeConvertibles: true });
    const row = (id: string) => table.rows.find((x) => x.stakeholderId === id)!.convertibleAsConverted;
    near(row('m'), k.shares, 1, `${what}: cap table`);
    near(row('l'), k.shares, 1, `${what}: cap table, later safe`);
    near(sharesOf(mfnRound(d, 50_000_000, '2025-01-01'), 'mfn'), k.shares, 1, `${what}: modelRound`);
    const w = computeWaterfall(d, $(100_000_000), { asOf: '2025-01-01' });
    near(w.classPayouts.find((c) => c.shareClassId === 'mfn')!.asConvertedShares, k.shares, 1, `${what}: waterfall`);
    // The bridge view: a post-money $1M at $10M is guaranteed $1M / $10M = 10%; a pre-money cap guarantees nothing.
    const stack = modelConvertibleStack(d, '2025-01-01').instruments.find((i) => i.id === 'mfn')!;
    assert.deepEqual([stack.cap, stack.impliedOwnershipPct], [$(k.cap), k.later === 'SAFE_POST' ? 0.1 : null], `${what}: bridge`);
  }
});

test('Seeded rounds with an MFN safe: modelRound agrees with the independent reference (300 tables)', () => {
  // As randomRound, with an MFN safe issued before the others. The reference adopts one later safe whole
  // (refAdoptMFN, written from the YC MFN text) and solves the round in full precision.
  let compared = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed * 7919);
    const rr = randomRound(r);
    rr.safes.unshift({ kind: r() < 0.5 ? 'POST' : 'PRE', cap: r() < 0.3 ? Math.round(5e6 + r() * 4e7) : null, amount: Math.round(5e4 + r() * 2e6),
      discount: r() < 0.3 ? Math.round(r() * 25) / 100 : 0, mfn: true });
    const d = company({
      stakeholders: [holder('f', 'Founder'), holder('e', 'Employee', 'EMPLOYEE'), holder('i', 'Safe holder', 'INVESTOR')],
      issuances: [issuance('f', 'common', rr.founders, 1, '2020-01-01')],
      awards: rr.granted > 0 ? [award('e', rr.granted, { vestingScheduleId: 'vs_full', grantDate: '2020-06-01' })] : [],
      pools: [pool(rr.granted + rr.poolAvailable)],
      convertibles: rr.safes.map((s, k) => convertible('i', s.kind === 'POST' ? 'SAFE_POST' : 'SAFE_PRE', s.amount, s.cap,
        { id: `c${k}`, discount: s.discount, mfn: s.mfn ?? false, issueDate: `2021-0${k + 1}-01` })),
    });
    let res;
    try {
      res = modelRound(d, {
        name: 'Series A', closeDate: '2023-01-01', preMoney: $(rr.preMoney), investors: [{ stakeholderId: null, name: 'Lead', amount: $(rr.raise) }],
        targetPoolPct: rr.targetPool, poolFromPreMoney: true, convertConvertibles: true,
      });
    } catch (e) {
      assert.match(String(e), /^RangeError: (No round price solves these terms|Post-money SAFE caps allocate 100%)/, `seed ${seed}`);
      continue;
    }
    const ref = refRound(rr);
    // The engine's price moves in $0.000001 steps, so below $0.05 rounding alone exceeds 0.1%; such rounds are skipped.
    if (ref.price < 0.05) continue;
    near(ppsToDollars(res.pricePerShare), ref.price, ref.price * 1e-3, `seed ${seed} price`);
    rr.safes.forEach((_, k) => {
      const want = ref.preShares[k] + ref.postShares[k];
      near(sharesOf(res, `c${k}`), want, Math.max(3, want * 1e-3), `seed ${seed} safe ${k}`);
    });
    compared++;
  }
  assert.ok(compared > 200, `only ${compared} of 300 rounds compared`);
});
