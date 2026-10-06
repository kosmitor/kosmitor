/**
 * Golden cases for the cap table and splits (captable.ts, splits.ts), from published
 * worked examples. Each test cites its source. A test marked { todo: 'BUG-ID' } pins
 * the correct value for a confirmed bug (math-audit-2026-10-05.md, section 2): it is
 * reported as todo while the bug stands and passes once it is fixed; then drop the flag.
 *
 * YC Post-Money Safe User Guide (Feb 2023):
 * https://bookface-static.ycombinator.com/assets/ycdc/SAFE%20User%20Guide-a47c6588327d73aa2799e61ed7c2cae9f1a0ee9acfa9c43b62039dc06e715832.pdf
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeValuation, computeCapTable, dilutionHistory, ownershipByGroup, stakeholderPosition, validateAuthorized } from '../src/captable.ts';
import { normalizeSplits } from '../src/splits.ts';
import { computeWaterfall } from '../src/waterfall.ts';
import { portfolioValue } from '../src/tax.ts';
import { shareValue, dollarsToCents as $, dollarsToPPS as $$ } from '../src/util.ts';
import type { CompanyData } from '../src/types.ts';
import { abcInc, company, holder, issuance, award, pool, convertible, warrant, preferred, valuation, fullyVested, entry, election } from './builders.ts';

const row = (t: ReturnType<typeof computeCapTable>, id: string) => t.rows.find((r) => r.stakeholderId === id)!;
const pct2 = (x: number) => Math.round(x * 10_000) / 100;   // a fraction as a percentage with two decimals
const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);

/** ABC, Inc. with YC's two post-money safes: A $200k at a $4M cap, B $800k at an $8M cap. */
function withPostMoneySafes(): CompanyData {
  const d = abcInc();
  d.convertibles.push(convertible('invA', 'SAFE_POST', 200_000, 4_000_000), convertible('invB', 'SAFE_POST', 800_000, 8_000_000));
  return d;
}

// ---------------------------------------------------------------------------
// YC Post-Money Safe User Guide, Appendix II, Example 1
// ---------------------------------------------------------------------------

test('YC App. II Ex.1 pre-financing: FD 10,000,000, founders 92.50%, 100,000 options available', () => {
  // 9,250,000 + 300,000 outstanding + 350,000 promised + 100,000 available = 10,000,000.
  const t = computeCapTable(abcInc(), { asOf: '2022-01-01' });
  assert.equal(t.totals.fullyDiluted, 10_000_000);
  assert.equal(pct2(row(t, 'founders').fullyDilutedPct), 92.5);
  assert.equal(t.totals.poolAvailable, 100_000);
});

test('YC App. II Ex.1 safes: Company Capitalization 11,764,705, A 588,235, B 1,176,470', () => {
  // Company Capitalization = 10,000,000 / (1 - 5% - 10%) = 11,764,705.88; shares are floored.
  const t = computeCapTable(withPostMoneySafes(), { asOf: '2022-01-01', includeConvertibles: true });
  assert.equal(row(t, 'invA').convertibleAsConverted, 588_235);
  assert.equal(row(t, 'invB').convertibleAsConverted, 1_176_470);
  assert.equal(t.totals.fullyDiluted, 11_764_705);
  // YC shows founders at 78.62% because it divides by the unrounded 11,764,705.88; the app divides
  // by whole shares and gets 78.63%. Tolerance 0.01 point for that rounding.
  near(pct2(row(t, 'founders').fullyDilutedPct), 78.62, 0.01, 'founders FD%');
});

test('YC App. II Ex.1 post-Series A: FD 17,946,424 and every holder\'s FD% as in the guide', () => {
  // The guide's closing table: A-1 at $0.34 and A-2 at $0.68 are the safes; Series A at $1.1144;
  // pool topped up by 1,695,000 to 1,795,000 available.
  const d = abcInc();
  d.shareClasses.push(
    preferred('a1', 'Series A-1', 0.34, { issueDate: '2022-01-01' }),
    preferred('a2', 'Series A-2', 0.68, { issueDate: '2022-01-01' }),
    preferred('sa', 'Series A', 1.1144, { issueDate: '2022-01-01' }),
  );
  d.issuances.push(
    issuance('invA', 'a1', 588_235, $$(0.34), '2022-01-01'), issuance('invB', 'a2', 1_176_470, $$(0.68), '2022-01-01'),
    issuance('invB', 'sa', 448_671, $$(1.1144), '2022-01-01'), issuance('invC', 'sa', 3_589_375, $$(1.1144), '2022-01-01'),
    issuance('others', 'sa', 448_673, $$(1.1144), '2022-01-01'),
  );
  d.poolAdjustments.push({ id: 'pa_1', poolId: 'pool', date: '2022-01-01', amount: 1_695_000, reason: 'Series A top-up' });
  const t = computeCapTable(d, { asOf: '2022-01-02' });
  assert.equal(t.totals.fullyDiluted, 17_946_424);
  assert.equal(t.totals.poolAvailable, 1_795_000);
  assert.deepEqual(
    ['founders', 'invA', 'invB', 'invC', 'others', 'optionees', 'promised'].map((id) => pct2(row(t, id).fullyDilutedPct)),
    [51.54, 3.28, 9.06, 20.0, 2.5, 1.67, 1.95],
  );
  assert.equal(pct2(t.totals.poolAvailable / t.totals.fullyDiluted), 10.0);
  // YC's "Outstanding Ownership" counts options (denominator 16,151,424). The app's outstanding is
  // issued shares only, so it pins 15,501,424; the UI labels the definition.
  assert.equal(t.totals.outstanding, 15_501_424);
  near(ownershipByGroup(t).reduce((s, g) => s + g.pct, 0), 1, 1e-12, 'groups');
});

test('YC guide §B.5: $500k of safes at a $5M post-money cap dilutes 90/8/2 to 81/7.2/1.8/10', () => {
  const d = company({
    stakeholders: [holder('f', 'Founders'), holder('e', 'Employees', 'EMPLOYEE'), holder('s', 'Safe holders', 'INVESTOR')],
    issuances: [issuance('f', 'common', 9_000_000, $$(0.00001), '2020-01-01')],
    awards: [award('e', 800_000)],
    pools: [pool(1_000_000)],
    convertibles: [convertible('s', 'SAFE_POST', 500_000, 5_000_000)],
  });
  const t = computeCapTable(d, { asOf: '2022-01-01', includeConvertibles: true });
  const one = (x: number) => Math.round(x * 1000) / 10;
  assert.deepEqual(
    [one(row(t, 'f').fullyDilutedPct), one(row(t, 'e').fullyDilutedPct), one(t.totals.poolAvailable / t.totals.fullyDiluted), one(row(t, 's').fullyDilutedPct)],
    [81, 7.2, 1.8, 10],
  );
});

test('YC App. II Ex.2: a post-money safe owns exactly principal/cap of a capitalization that includes the pre-money safe', () => {
  // Post-Money Safe Company Capitalization includes all Converting Securities, so B (10%) gets
  // 10% x (10,000,000 + A) / 0.9 shares whatever A is estimated at (YC §C.1, App. II Ex.2).
  // Before the CAP-5 fix the app gave B 1,111,111 = 9.548%.
  const d = abcInc();
  d.convertibles.push(convertible('invA', 'SAFE_PRE', 200_000, 3_800_000), convertible('invB', 'SAFE_POST', 800_000, 8_000_000));
  const t = computeCapTable(d, { asOf: '2022-01-01', includeConvertibles: true });
  const a = row(t, 'invA').convertibleAsConverted;
  const b = row(t, 'invB').convertibleAsConverted;
  assert.equal(b, Math.floor(((10_000_000 + a) / 0.9) * 0.1));
  near(b / t.totals.fullyDiluted, 0.1, 1e-6, 'B ownership');
});

test('YC guide App. I.3: in the cap table an MFN safe is estimated as the instrument it elected, base and all', () => {
  // 9,000,000 common. A $100k post-money MFN safe at a $10M cap, then a $1M pre-money safe at a $6M cap, which
  // the holder elects: the MFN safe becomes the pre-money safe apart from its Purchase Amount, 100,000 /
  // 6,000,000 x 9,000,000 = 150,000 shares. Before the fix it was neither estimated nor solved and showed 0.
  const d = company({
    ledger: [election('mfn', 'pre', '2021-07-01')],
    stakeholders: [holder('f', 'Founders'), holder('m', 'MFN holder', 'INVESTOR'), holder('p', 'Pre-money holder', 'INVESTOR')],
    issuances: [issuance('f', 'common', 9_000_000, $$(0.0001), '2020-01-01')],
    convertibles: [
      convertible('m', 'SAFE_POST', 100_000, 10_000_000, { id: 'mfn', mfn: true, issueDate: '2021-01-01' }),
      convertible('p', 'SAFE_PRE', 1_000_000, 6_000_000, { id: 'pre', issueDate: '2021-06-01' }),
    ],
  });
  const t = computeCapTable(d, { asOf: '2022-01-01', includeConvertibles: true });
  near(row(t, 'm').convertibleAsConverted, 150_000, 1e-6, 'MFN safe');
  near(row(t, 'p').convertibleAsConverted, 1_500_000, 1e-6, 'pre-money safe');
  // The other way round: a $100k uncapped pre-money MFN safe, then a $1.8M post-money safe at a $9M cap, elected.
  // Both are post-money safes at $9M, owning 1/90 and 1/5 of 9,000,000 / (1 - 1/90 - 1/5) = 11,408,450.7. Before
  // the fix the MFN safe was estimated as uncapped at the 409A and also counted in the post-money capitalization.
  const unelected = company({
    stakeholders: [holder('f', 'Founders'), holder('m', 'MFN holder', 'INVESTOR'), holder('q', 'Post-money holder', 'INVESTOR')],
    issuances: [issuance('f', 'common', 9_000_000, $$(0.0001), '2020-01-01')],
    convertibles: [
      convertible('m', 'SAFE_PRE', 100_000, null, { id: 'mfn', mfn: true, issueDate: '2021-01-01' }),
      convertible('q', 'SAFE_POST', 1_800_000, 9_000_000, { id: 'post', issueDate: '2021-06-01' }),
    ],
    valuations: [valuation({ fairMarketValue: $$(0.5), effectiveDate: '2021-01-01' })],
  });
  const u = computeCapTable({ ...unelected, ledger: [election('mfn', 'post', '2021-07-01')] }, { asOf: '2022-01-01', includeConvertibles: true });
  const T = 9_000_000 / (1 - 1 / 90 - 1 / 5);
  assert.deepEqual([row(u, 'm').convertibleAsConverted, row(u, 'q').convertibleAsConverted], [Math.floor(T / 90), Math.floor(T / 5)]);
  assert.equal(u.uncappedConversionPrice, null);
  // Before any election the MFN safe is on its own terms: uncapped, so estimated at the 409A, $100k / $0.50 =
  // 200,000 shares, and the post-money safe owns 1/5 of (9,000,000 + 200,000) / 0.8 = 11,500,000, 2,300,000.
  // The suggestion weighs only the later safe, T / 90 = 126,760: the 409A estimate is the table's assumption
  // for an uncapped safe, not terms the holder could elect, so it is not compared with the candidates.
  const v = computeCapTable(unelected, { asOf: '2022-01-01', includeConvertibles: true });
  assert.deepEqual([row(v, 'm').convertibleAsConverted, row(v, 'q').convertibleAsConverted], [200_000, 2_300_000]);
  assert.deepEqual(v.uncappedConversionPrice?.convertibleIds, ['mfn']);
  assert.deepEqual(v.mfnSuggestions, { mfn: { adoptedId: 'post', shares: Math.floor(T / 90) } });
});

test('YC guide §C.1: switching the unissued pool off the display does not change a safe\'s share count', () => {
  // Company Capitalization always includes the Unissued Option Pool; only the displayed
  // denominator should change. Before the CAP-11 fix the app gave 582,352 with the pool off.
  const t = computeCapTable(withPostMoneySafes(), { asOf: '2022-01-01', includeConvertibles: true, includeUnallocatedPool: false });
  assert.equal(row(t, 'invA').convertibleAsConverted, 588_235);
});

// ---------------------------------------------------------------------------
// Stock splits
// SEC/Investor.gov: https://www.sec.gov/answers/stocksplit.htm
// 26 CFR 1.424-1: https://www.law.cornell.edu/cfr/text/26/1.424-1
// 8 Del. C. §155: https://delcode.delaware.gov/title8/c001/sc05/index.html
// ---------------------------------------------------------------------------

/** Founders 8,000,000 at $0.0001 ($800), Series Seed 1,000,000 at $1.37, 300,000 options at $0.10, a 2,000,000 plan. */
function seedRound(): CompanyData {
  return company({
    stakeholders: [holder('f', 'Founder'), holder('g', 'Cofounder'), holder('e', 'Employee', 'EMPLOYEE'), holder('i', 'Seed investor', 'INVESTOR')],
    shareClasses: [company().shareClasses[0], preferred('seed', 'Series Seed', 1.37)],
    issuances: [
      issuance('f', 'common', 4_500_000, $$(0.0001), '2020-01-01'), issuance('g', 'common', 3_500_000, $$(0.0001), '2020-01-01'),
      issuance('i', 'seed', 1_000_000, $$(1.37), '2021-06-01'),
    ],
    awards: [award('e', 300_000, { strikePrice: $$(0.10), fmvAtGrant: $$(0.10) })],
    pools: [pool(2_000_000)],
  });
}
const withSplit = (d: CompanyData, ratio: number) => { d.stockSplits.push({ id: 'split_1', date: '2021-12-01', ratio }); return d; };

test('SEC split explainer: 100 shares at $100 split 2-for-1 become 200 shares at $50, value unchanged', () => {
  const d = company({ stakeholders: [holder('x', 'Holder')], issuances: [issuance('x', 'common', 100, $$(100), '2020-01-01')], stockSplits: [{ id: 's', date: '2021-01-01', ratio: 2 }] });
  const n = normalizeSplits(d, '2022-01-01').issuances[0];
  assert.deepEqual([n.quantity, n.pricePerShare], [200, $$(50)]);
  assert.equal(shareValue(n.quantity, n.pricePerShare), $(10_000));
});

test('26 CFR 1.424-1(a)(10) Ex.4: a 2-for-1 split doubles the option and halves the strike, aggregate price unchanged', () => {
  const a = normalizeSplits(withSplit(seedRound(), 2), '2022-01-01').awards[0];
  assert.deepEqual([a.quantity, a.strikePrice], [600_000, $$(0.05)]);
  assert.equal(shareValue(a.quantity, a.strikePrice), $(30_000));
});

test('SEC split explainer: a 3-for-1 split leaves every holder\'s fully diluted % unchanged', () => {
  const before = computeCapTable(seedRound(), { asOf: '2022-01-01' });
  const after = computeCapTable(withSplit(seedRound(), 3), { asOf: '2022-01-01' });
  assert.equal(after.totals.fullyDiluted, before.totals.fullyDiluted * 3);
  for (const r of before.rows) near(row(after, r.stakeholderId).fullyDilutedPct, r.fullyDilutedPct, 1e-12, r.name);
});

test('8 Del. C. §155: a 1-for-3 reverse split of 100 and 200 shares at $1 leaves 33⅓ and 66⅔ at $3', () => {
  // §155 allows fractional shares or cash in lieu; the app keeps fractions to 6 decimals.
  const d = company({
    stakeholders: [holder('x', 'Holder X'), holder('y', 'Holder Y')],
    issuances: [issuance('x', 'common', 100, $$(1), '2020-01-01'), issuance('y', 'common', 200, $$(1), '2020-01-01')],
    stockSplits: [{ id: 's', date: '2021-01-01', ratio: 1 / 3 }],
  });
  const t = computeCapTable(d, { asOf: '2022-01-01' });
  near(row(t, 'x').outstanding, 100 / 3, 1e-6, 'X');
  near(row(t, 'y').outstanding, 200 / 3, 1e-6, 'Y');
  near(t.totals.outstanding, 100, 1e-6, 'total');
  assert.equal(normalizeSplits(d, '2022-01-01').issuances[0].pricePerShare, $$(3));
});

test('26 CFR 1.424-1(e)(4)(v): after a 3-for-1 split the aggregate exercise price is not below $30,000', () => {
  // A split is not a modification only if the aggregate exercise price does not fall. Before the
  // CAP-3 fix the app rounded $0.10/3 to $0.033333, so 900,000 options cost $29,999.70.
  const a = normalizeSplits(withSplit(seedRound(), 3), '2022-01-01').awards[0];
  assert.equal(a.quantity, 900_000);
  assert.ok(a.quantity * a.strikePrice >= 300_000 * $$(0.10), `aggregate ${a.quantity * a.strikePrice / 1e6} < 30000`);
});

test('26 CFR 1.424-1(e)(4)(v): 300,000 options at $0.10 exercised after a 3-for-1 split paid in $30,000', () => {
  // The exercise records 900,000 shares at the strike as the app stores a price, rounded to $0.033333, but the
  // aggregate exercise price paid is still $30,000. Before the fix the certificate counted $29,999.70.
  const d = withSplit(seedRound(), 3);
  const grant = d.awards[0];
  d.awards[0] = { ...grant, exercisedQuantity: 300_000, status: 'EXERCISED' };
  d.issuances.push(issuance('e', 'common', 900_000, 33_333, '2022-02-01', { sourceAwardId: grant.id }));
  const t = computeCapTable(d, { asOf: '2022-06-01' });
  assert.equal(row(t, 'e').investedAmount, $(30_000));
  // A certificate whose price does not match its grant's strike keeps its own price.
  d.issuances[d.issuances.length - 1] = { ...d.issuances[d.issuances.length - 1], pricePerShare: $$(0.05) };
  assert.equal(row(computeCapTable(d, { asOf: '2022-06-01' }), 'e').investedAmount, $(45_000));
});

test('SEC split explainer: a 3-for-1 split leaves invested capital ($1,370,800) and the seed preference ($1,370,000) unchanged', () => {
  // Before the CAP-3 fix the app gave $1,370,793 invested and a $1,370,001 preference.
  const t = computeCapTable(withSplit(seedRound(), 3), { asOf: '2022-01-01' });
  assert.equal(t.totals.investedAmount, $(1_370_800));
  assert.equal(t.classes.find((c) => c.shareClassId === 'seed')!.liquidationPreference, $(1_370_000));
});

test('SEC split explainer: stakeholderPosition lists certificates and grants in split-adjusted units', () => {
  // Before the CAP-10 fix the row said 9,000,000 after a 2:1 split, but the certificate list still said
  // 4,500,000 and the grant 300,000 at $0.10 instead of 600,000 at $0.05.
  const d = withSplit(seedRound(), 2);
  const f = stakeholderPosition(d, 'f', '2022-01-01');
  assert.deepEqual([f.row!.outstanding, f.issuances[0].quantity], [9_000_000, 9_000_000]);
  const e = stakeholderPosition(d, 'e', '2022-01-01');
  assert.deepEqual([e.row!.optionsOutstanding, e.awards[0].quantity, e.awards[0].strikePrice], [600_000, 600_000, $$(0.05)]);
});

test('stakeholderPosition lists only what was issued on or before the as-of date (CAP-10)', () => {
  const d = seedRound();
  d.issuances.push(issuance('i', 'seed', 500_000, $$(1.37), '2023-03-01'));
  d.warrants.push(warrant('i', 'seed', 10_000, { issueDate: '2023-03-01' }));
  d.convertibles.push(convertible('i', 'SAFE_POST', 100_000, 20_000_000, { issueDate: '2023-03-01' }));
  const p = stakeholderPosition(d, 'i', '2022-01-01');
  assert.deepEqual([p.issuances.length, p.warrants.length, p.convertibles.length], [1, 0, 0]);
  assert.equal(p.row!.outstanding, 1_000_000);
});

test('a 409A from before a 3-for-1 split is quoted in whole micro-cents, $1.10 becoming $0.366667', () => {
  // The server stores this price with an exercise (a BIGINT column), so it stays whole after CAP-3
  // stopped rounding the prices of the securities themselves.
  const d = withSplit(seedRound(), 3);
  d.valuations.push(valuation({ fairMarketValue: $$(1.10), effectiveDate: '2021-06-01' }));
  assert.equal(activeValuation(d, '2022-01-01'), 366_667);
  assert.equal(normalizeSplits(d, '2022-01-01').issuances[2].pricePerShare, $$(1.37) / 3);
});

// ---------------------------------------------------------------------------
// Terminated holders, values, votes, authorized shares
// ---------------------------------------------------------------------------

/** Founders 8,000,000; one employee with 200,000 options; a 2,000,000 plan. */
function founderAndEmployee(): CompanyData {
  return company({
    stakeholders: [holder('f', 'Founder'), holder('g', 'Cofounder'), holder('e', 'Employee', 'EMPLOYEE'), holder('i', 'Investor', 'INVESTOR'), holder('b', 'Buyer', 'INVESTOR')],
    issuances: [issuance('f', 'common', 4_500_000, $$(0.0001), '2020-01-01', { id: 'cert_f', certificateNo: 'CS-1' }), issuance('g', 'common', 3_500_000, $$(0.0001), '2020-01-01')],
    awards: [award('e', 200_000, { id: 'aw_e' })],
    pools: [pool(2_000_000)],
  });
}

test('Carta termination guide: unvested options of a leaver return to the pool at termination', () => {
  // 200,000 ISOs, 4y/1y cliff from 2021-01-01; left 2022-07-01 with 18/48 vested = 75,000.
  // "Unvested shares are returned to the equity pool."
  // https://support.carta.com/kb/guide/en/how-to-terminate-stakeholders-in-carta-z3cVZe50mM/Steps/3789107
  const d = founderAndEmployee();
  d.stakeholders.find((s) => s.id === 'e')!.terminationDate = '2022-07-01';
  const t = computeCapTable(d, { asOf: '2022-08-01' });
  assert.deepEqual([row(t, 'e').optionsOutstanding, row(t, 'e').optionsVested, row(t, 'e').optionsUnvested], [75_000, 75_000, 0]);
  assert.equal(t.totals.poolAvailable, 1_925_000);
});

test('Carta termination guide: the exit model and the holder\'s portfolio count the leaver\'s 75,000 options too', () => {
  // The same leaver, a $1.00 409A. Acceleration in a sale reaches only what was still outstanding: the 125,000
  // unvested options lapsed at termination (VA-1), so a $10M exit exercises 75,000 options whether or not
  // unvested options accelerate. Before the fix the waterfall exercised 200,000 with acceleration on (the exit
  // model's default) and the portfolio showed 125,000 unvested options.
  const d = founderAndEmployee();
  d.stakeholders.find((s) => s.id === 'e')!.terminationDate = '2022-07-01';
  d.valuations.push(valuation({ fairMarketValue: $$(1), effectiveDate: '2021-01-01' }));
  const options = (accelerateUnvested: boolean) => computeWaterfall(d, $(10_000_000), { asOf: '2022-08-01', accelerateUnvested });
  assert.deepEqual([options(true).optionsExercised, options(false).optionsExercised], [75_000, 75_000]);
  const leaver = (accelerateUnvested: boolean) => options(accelerateUnvested).stakeholderPayouts.find((s) => s.stakeholderId === 'e')!.fromOptions;
  assert.equal(leaver(true), leaver(false));
  const p = portfolioValue(d, 'e', '2022-08-01');
  assert.deepEqual([p.vestedOptions, p.unvestedOptions, p.grants[0].outstanding], [75_000, 0, 75_000]);
});

test('Carta termination guide: unvested RSUs of a leaver lapse', () => {
  // Same facts as an RSU grant; before the CAP-4 fix the app still showed 200,000 RSUs in 2025.
  const d = founderAndEmployee();
  d.awards[0] = { ...d.awards[0], type: 'RSU', strikePrice: 0, expirationDate: null };
  d.stakeholders.find((s) => s.id === 'e')!.terminationDate = '2022-07-01';
  assert.equal(row(computeCapTable(d, { asOf: '2025-01-01' }), 'e').rsusOutstanding, 75_000);
});

test('ASC 718 intrinsic value (Deloitte Roadmap 4.1): 200,000 options at $1.00 with FMV $1.10 are worth $20,000', () => {
  // https://dart.deloitte.com/USDART/home/codification/expenses/71x/asc718-10/roadmap-share-based-payments/chapter-4-measurement/4-1-fair-value-based-measurement
  // Before the CAP-7 fix the app valued them at the full FMV, $220,000.
  const d = founderAndEmployee();
  d.awards[0] = { ...d.awards[0], strikePrice: $$(1), fmvAtGrant: $$(1), vestingScheduleId: fullyVested.id };
  d.valuations.push(valuation({ fairMarketValue: $$(1.10), effectiveDate: '2021-01-01' }));
  assert.equal(row(computeCapTable(d, { asOf: '2022-01-01' }), 'e').currentValue, $(20_000));
});

test('NVCA charter §3.1 (Navan S-1 Ex.3.1): preferred votes as the whole common shares it converts into', () => {
  // https://www.sec.gov/Archives/edgar/data/1639723/000162828025042130/exhibit31-sx1.htm
  // 1,000,001 shares at a 1.0345 ratio convert into 1,034,501 whole shares; before the CAP-13 fix the app gave 1,034,501.0345 votes.
  const d = founderAndEmployee();
  d.shareClasses.push(preferred('pa', 'Series A', 1, { conversionRatio: 1.0345 }));
  d.issuances.push(issuance('i', 'pa', 1_000_001, $$(1), '2021-06-01'));
  assert.equal(row(computeCapTable(d, { asOf: '2022-01-01' }), 'i').votes, 1_034_501);
});

test('NVCA model COI reservation covenant: common reserved for the plan and for conversion counts against authorized', () => {
  // https://nvca.org/model-legal-documents/ ("Reservation of Stock Issuable Upon Conversion").
  // 10,000,000 authorized - 8,000,000 issued - 2,000,000 plan - 1,000,000 for Series A conversion = -1,000,000.
  // Before the CAP-8 fix the app reported 2,000,000 available and no warning.
  const d = founderAndEmployee();
  d.shareClasses[0] = { ...d.shareClasses[0], authorized: 10_000_000 };
  d.shareClasses.push(preferred('pa', 'Series A', 1));
  d.issuances.push(issuance('i', 'pa', 1_000_000, $$(1), '2021-06-01'));
  const t = computeCapTable(d, { asOf: '2022-01-01' });
  assert.equal(t.classes.find((c) => c.shareClassId === 'common')!.available, -1_000_000);
  assert.ok(validateAuthorized(d, '2022-01-01').length > 0, 'no authorized-share warning');
});

test('OCF StockTransfer: a secondary sale between holders does not change the company\'s invested capital', () => {
  // The transfer route lowers the founder certificate and adds the buyer's certificate at the sale
  // price. The company received nothing, so invested stays $800; before the CAP-9 fix the app showed $500,790.
  // https://open-cap-table-coalition.github.io/Open-Cap-Format-OCF/schema_markdown/schema/objects/transactions/transfer/StockTransfer/
  const d = founderAndEmployee();
  d.issuances.find((i) => i.id === 'cert_f')!.quantity = 4_400_000;
  d.issuances.push(issuance('b', 'common', 100_000, $$(5), '2024-06-01', { notes: 'Transferred from certificate CS-1' }));
  assert.equal(computeCapTable(d, { asOf: '2024-07-01' }).totals.investedAmount, $(800));
});

test('YC Company Capitalization: a warrant for preferred counts as converted into common', () => {
  // A warrant for 100,000 Series A at a conversion ratio of 2 adds 200,000 to FD; before the CAP-12 fix the app added 100,000.
  const d = seedRound();
  d.shareClasses[1] = { ...d.shareClasses[1], conversionRatio: 2 };
  d.warrants.push(warrant('i', 'seed', 100_000));
  assert.equal(row(computeCapTable(d, { asOf: '2022-01-01' }), 'i').warrantsOutstanding, 200_000);
});

test('Internal consistency: optionsExercised counts a grant exercised in full', () => {
  // Nothing reads the field today; before the CAP-14 fix a fully exercised 200,000 grant showed 0.
  const d = founderAndEmployee();
  Object.assign(d.awards[0], { exercisedQuantity: 200_000, status: 'EXERCISED' });
  assert.equal(row(computeCapTable(d, { asOf: '2022-01-01' }), 'e')?.optionsExercised ?? 0, 200_000);
});

// ---------------------------------------------------------------------------
// More cases for the fixes above
// ---------------------------------------------------------------------------

test('Carta termination guide: once the exercise window closes the vested part returns as well, and nothing is counted twice (CAP-4)', () => {
  // Left 2022-07-01 with a 3-month window: on 2022-10-02 the 75,000 vested options lapse too.
  const d = founderAndEmployee();
  d.stakeholders.find((s) => s.id === 'e')!.terminationDate = '2022-07-01';
  const t = computeCapTable(d, { asOf: '2022-10-02' });
  assert.equal(row(t, 'e')?.optionsOutstanding ?? 0, 0);
  assert.equal(t.totals.poolAvailable, 2_000_000);
  // A leaver whose unvested part the company has already cancelled gets nothing more back.
  d.awards[0] = { ...d.awards[0], cancelledQuantity: 125_000 };
  const u = computeCapTable(d, { asOf: '2022-08-01' });
  assert.deepEqual([row(u, 'e').optionsOutstanding, u.totals.poolAvailable], [75_000, 1_925_000]);
  // Before the termination date nothing has lapsed.
  assert.equal(row(computeCapTable(d, { asOf: '2022-06-30' }), 'e').optionsOutstanding, 75_000);
});

test('ASC 718 intrinsic value: an underwater option is worth nothing and a warrant is worth its spread (CAP-7)', () => {
  const d = founderAndEmployee();
  d.awards[0] = { ...d.awards[0], strikePrice: $$(1.20), fmvAtGrant: $$(1.20), vestingScheduleId: fullyVested.id };
  d.warrants.push(warrant('i', 'common', 50_000, { strikePrice: $$(0.60) }));
  d.valuations.push(valuation({ fairMarketValue: $$(1.10), effectiveDate: '2021-01-01' }));
  const t = computeCapTable(d, { asOf: '2022-01-01' });
  assert.equal(row(t, 'e').currentValue, 0);
  assert.equal(row(t, 'i').currentValue, $(25_000));   // 50,000 x ($1.10 - $0.60)
  assert.equal(row(t, 'f').currentValue, $(4_950_000)); // 4,500,000 shares x $1.10
});

test('NVCA charter §3.1: whole votes are counted over everything a holder converts, not series by series (CAP-13)', () => {
  // 1 share of each of two series at a 1.5 ratio converts into 3 whole shares together, 1 + 1 apart.
  const d = founderAndEmployee();
  d.shareClasses.push(preferred('pa', 'Series A', 1, { conversionRatio: 1.5 }), preferred('pb', 'Series B', 1, { conversionRatio: 1.5 }));
  d.issuances.push(issuance('i', 'pa', 1, $$(1), '2021-06-01'), issuance('i', 'pb', 1, $$(1), '2021-06-01'));
  const t = computeCapTable(d, { asOf: '2022-01-01' });
  assert.equal(row(t, 'i').votes, 3);
  assert.equal(t.totals.votes, 8_000_003);
});

test('NVCA model COI reservation covenant: a warrant for preferred reserves the preferred and the common it converts into (CAP-8, CAP-12)', () => {
  // Series A authorized 1,000,000: 600,000 issued and a warrant for 100,000 at a ratio of 2.
  // Common 10,500,000: 8,000,000 issued, a 2,000,000 plan, 1,200,000 + 200,000 for conversion: short 1,700,000.
  const d = founderAndEmployee();
  d.shareClasses[0] = { ...d.shareClasses[0], authorized: 10_500_000 };
  d.shareClasses.push(preferred('pa', 'Series A', 1, { conversionRatio: 2, authorized: 1_000_000 }));
  d.issuances.push(issuance('i', 'pa', 600_000, $$(1), '2021-06-01'));
  d.warrants.push(warrant('i', 'pa', 100_000));
  const t = computeCapTable(d, { asOf: '2022-01-01' });
  const cls = (id: string) => t.classes.find((c) => c.shareClassId === id)!;
  assert.deepEqual([cls('pa').reserved, cls('pa').available], [100_000, 300_000]);
  assert.deepEqual([cls('common').reserved, cls('common').available], [3_400_000, -900_000]);
  assert.ok(t.warnings.some((w) => w.startsWith('Common: 8,000,000 shares outstanding and 3,400,000 reserved')), t.warnings.join(' | '));
  assert.equal(validateAuthorized(d, '2022-01-01').length, 1);
});

test('OCF StockTransfer: a certificate transferred twice still carries the price the company was paid (CAP-9)', () => {
  // The founder sells the whole CS-1 certificate at $5, and the buyer sells it on at $7. Invested stays $800.
  const d = founderAndEmployee();
  d.issuances.find((i) => i.id === 'cert_f')!.status = 'TRANSFERRED';
  d.issuances.push(
    issuance('b', 'common', 4_500_000, $$(5), '2024-06-01', { status: 'TRANSFERRED', certificateNo: 'TR-000001', notes: 'Transferred from certificate CS-1' }),
    issuance('i', 'common', 4_500_000, $$(7), '2024-09-01', { certificateNo: 'TR-000002', notes: 'Transferred from certificate TR-000001' }),
  );
  const t = computeCapTable(d, { asOf: '2024-10-01' });
  assert.equal(t.totals.investedAmount, $(800));
  assert.equal(row(t, 'i').investedAmount, $(450));
  assert.deepEqual(t.warnings, []);
  // A transfer whose source is not on record counts for nothing, with a warning.
  d.issuances.push(issuance('b', 'common', 1_000, $$(9), '2024-09-15', { certificateNo: 'TR-000003', notes: 'Transferred from certificate CS-404' }));
  const u = computeCapTable(d, { asOf: '2024-10-01' });
  assert.equal(u.totals.investedAmount, $(800));
  assert.equal(u.warnings.length, 1);
});

test('YC guide §B: an uncapped safe is estimated at its discount to the price common is valued at, and the table says which price (CAP-6)', () => {
  // $1,000,000 uncapped post-money safe at a 20% discount; 409A $1.10, last preferred price $4.00.
  // The safe's discount applies to the next round's preferred price, which is unknown, so the estimate
  // is a labelled assumption: 1,000,000 / (0.8 x $1.10) = 1,136,363.64 shares at the 409A.
  const d = founderAndEmployee();
  const safe = convertible('i', 'SAFE_POST', 1_000_000, null, { discount: 0.2 });
  d.convertibles.push(safe);
  d.valuations.push(valuation({ fairMarketValue: $$(1.10), effectiveDate: '2021-01-01' }));
  d.valuations.push(valuation({ type: 'PREFERRED_PRICE', fairMarketValue: $$(4), effectiveDate: '2021-06-01' }));
  const t = computeCapTable(d, { asOf: '2022-01-01', includeConvertibles: true });
  near(row(t, 'i').convertibleAsConverted, 1_000_000 / 0.88, 1e-5, 'estimate');
  assert.deepEqual(t.uncappedConversionPrice, { pricePerShare: $$(1.10), source: '409A', effectiveDate: '2021-01-01', convertibleIds: [safe.id] });
  // At a price the caller gives, here the preferred price: 1,000,000 / (0.8 x $4.00) = 312,500.
  const at4 = computeCapTable(d, { asOf: '2022-01-01', includeConvertibles: true, valuationPPS: $$(4) });
  assert.equal(row(at4, 'i').convertibleAsConverted, 312_500);
  assert.deepEqual([at4.uncappedConversionPrice!.source, at4.uncappedConversionPrice!.effectiveDate], ['GIVEN', null]);
  // Capped instruments use no price, and a table without convertibles makes no assumption.
  assert.equal(computeCapTable(withPostMoneySafes(), { asOf: '2022-01-01', includeConvertibles: true }).uncappedConversionPrice, null);
  assert.equal(computeCapTable(d, { asOf: '2022-01-01' }).uncappedConversionPrice, null);
});

// ---------------------------------------------------------------------------
// As-of views: the table on a date depends only on what happened by then
// ---------------------------------------------------------------------------

/**
 * The audit's CAP-1 case: founders hold 4,500,000 and 3,500,000 common from 2020, the employee
 * 200,000 vested options, and the plan 2,000,000. One event follows on 2024-06-01, recorded as the
 * routes record it: the row changed in place, what the event created dated that day, and a dated
 * ledger entry in the shares of that day. As of 2023-01-01 the table still reads 8,000,000
 * outstanding, 200,000 options, 1,800,000 unallocated and 10,000,000 fully diluted.
 */
function beforeTheEvent(): CompanyData {
  const d = founderAndEmployee();
  d.awards[0] = { ...d.awards[0], vestingScheduleId: fullyVested.id };
  return d;
}
const counts = (t: ReturnType<typeof computeCapTable>) =>
  [t.totals.outstanding, t.totals.optionsOutstanding, t.totals.poolAvailable, t.totals.fullyDiluted];

test('OCF StockTransfer: a partial transfer in 2024 leaves the 2023 table at 8,000,000 outstanding and 10,000,000 fully diluted (CAP-1)', () => {
  // Before the CAP-1 fix the 2023 view read today's certificate: 7,000,000 outstanding, 9,000,000 fully diluted.
  // https://open-cap-table-coalition.github.io/Open-Cap-Format-OCF/schema_markdown/schema/objects/transactions/transfer/StockTransfer/
  const d = beforeTheEvent();
  d.issuances.find((i) => i.id === 'cert_f')!.quantity = 3_500_000;
  d.issuances.push(issuance('b', 'common', 1_000_000, $$(5), '2024-06-01', { certificateNo: 'TR-000001', notes: 'Transferred from certificate CS-1' }));
  d.ledger = [entry('TRANSFER', '2024-06-01', 'cert_f', 1_000_000)];
  const then = computeCapTable(d, { asOf: '2023-01-01' });
  assert.deepEqual(counts(then), [8_000_000, 200_000, 1_800_000, 10_000_000]);
  assert.equal(row(then, 'f').outstanding, 4_500_000);
  assert.equal(stakeholderPosition(d, 'f', '2023-01-01').issuances[0].quantity, 4_500_000);
  const now = computeCapTable(d, { asOf: '2024-07-01' });
  assert.deepEqual([row(now, 'f').outstanding, row(now, 'b').outstanding], [3_500_000, 1_000_000]);
  assert.deepEqual(counts(now), [8_000_000, 200_000, 1_800_000, 10_000_000]);
  // The buyer's $5 is not capital on either date (CAP-9).
  assert.deepEqual([then.totals.investedAmount, now.totals.investedAmount], [$(800), $(800)]);
});

test('OCF EquityCompensationExercise: an exercise in 2024 leaves 200,000 options in the 2023 table (CAP-1)', () => {
  // Before the fix the 2023 view read 0 options and 9,800,000 fully diluted.
  const d = beforeTheEvent();
  Object.assign(d.awards[0], { exercisedQuantity: 200_000, status: 'EXERCISED' });
  d.issuances.push(issuance('e', 'common', 200_000, $$(0.10), '2024-06-01', { sourceAwardId: 'aw_e', notes: 'Issued on exercise of aw_e' }));
  d.ledger = [entry('EXERCISE', '2024-06-01', 'aw_e', 200_000)];
  const then = computeCapTable(d, { asOf: '2023-01-01' });
  assert.deepEqual(counts(then), [8_000_000, 200_000, 1_800_000, 10_000_000]);
  assert.deepEqual([row(then, 'e').optionsOutstanding, row(then, 'e').optionsExercised], [200_000, 0]);
  assert.deepEqual(counts(computeCapTable(d, { asOf: '2024-07-01' })), [8_200_000, 0, 1_800_000, 10_000_000]);
});

test('OCF EquityCompensationCancellation: a cancellation in 2024 leaves 200,000 options and 1,800,000 unallocated in the 2023 table (CAP-1)', () => {
  // Before the fix the 2023 view read 0 options and 2,000,000 unallocated.
  const d = beforeTheEvent();
  Object.assign(d.awards[0], { cancelledQuantity: 200_000, status: 'CANCELLED' });
  d.ledger = [entry('CANCELLATION', '2024-06-01', 'aw_e', 200_000)];
  assert.deepEqual(counts(computeCapTable(d, { asOf: '2023-01-01' })), [8_000_000, 200_000, 1_800_000, 10_000_000]);
  assert.deepEqual(counts(computeCapTable(d, { asOf: '2024-07-01' })), [8_000_000, 0, 2_000_000, 10_000_000]);
});

test('OCF ConvertibleConversion: a SAFE converted in 2024 is outstanding in 2023 and in the dilution history (CAP-1)', () => {
  // A $500,000 post-money safe at a $10,000,000 cap, issued 2022-01-01, owns 5% of a capitalization
  // of 10,000,000 / 0.95 = 10,526,315.79, so 526,315 whole shares (YC guide §C.1). It converts on
  // 2024-06-01. Before the fix it was gone from 2023 and from dilutionHistory.
  const d = beforeTheEvent();
  d.shareClasses.push(preferred('seed', 'Series Seed', 0.95, { issueDate: '2024-06-01' }));
  d.convertibles.push(convertible('i', 'SAFE_POST', 500_000, 10_000_000, {
    id: 'safe_i', issueDate: '2022-01-01', status: 'CONVERTED', convertedOn: '2024-06-01', convertedIntoShareClassId: 'seed',
  }));
  d.issuances.push(issuance('i', 'seed', 526_315, $$(0.95), '2024-06-01', { notes: 'Issued on conversion of SAFE_POST' }));
  d.ledger = [entry('CONVERSION', '2024-06-01', 'safe_i', 526_315)];
  const then = computeCapTable(d, { asOf: '2023-01-01', includeConvertibles: true });
  assert.deepEqual([row(then, 'i').convertiblePrincipal, row(then, 'i').convertibleAsConverted], [$(500_000), 526_315]);
  assert.equal(then.totals.fullyDiluted, 10_526_315);
  const history = dilutionHistory(d);
  const point = history.points.find((p) => p.date === '2022-01-01')!;
  assert.deepEqual([point.shares.Convertibles, point.fullyDiluted], [526_315, 10_526_315]);
  for (const p of history.points) {
    assert.equal(p.fullyDiluted, computeCapTable(d, { asOf: p.date, includeConvertibles: true }).totals.fullyDiluted, p.date);
  }
  // Once converted the safe is shares, not a convertible.
  const now = computeCapTable(d, { asOf: '2024-07-01', includeConvertibles: true });
  assert.deepEqual([row(now, 'i').convertiblePrincipal, row(now, 'i').convertibleAsConverted, row(now, 'i').outstanding], [0, 0, 526_315]);
});
