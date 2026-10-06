/**
 * Golden cases for the liquidation waterfall (waterfall.ts), from published worked
 * examples. Each test cites its source. A test marked { todo: 'BUG-ID' } pins the
 * correct value for a confirmed bug (math-audit-2026-10-05.md, section 2) and passes
 * once the bug is fixed.
 *
 * NVCA Model COI (Oct 2025): https://nvca.org/wp-content/uploads/2025/10/NVCA-Model-COI-10-1-2025.docx
 * Fenwick & West, "Explanation of certain terms used in venture financing terms survey":
 *   https://www.fenwick.com/insights/publications/explanation-of-certain-terms-used-in-venture-financing-terms-survey
 * YC post-money Safe and Safe User Guide: https://www.ycombinator.com/documents
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWaterfall, computeBreakpoints, waterfallCurve, type WaterfallOptions } from '../src/waterfall.ts';
import { ppsToDollars, dollarsToCents as $ } from '../src/util.ts';
import { waterfallCompany } from './builders.ts';
import { refEquilibria, refModel, type WaterfallSpec } from './reference/waterfall.ts';
import { rng, int, randomWaterfallSpec, randomExit } from './reference/gen.ts';

const AS_OF = '2025-01-01';
const run = (spec: WaterfallSpec, exit: number, o: WaterfallOptions = {}) => computeWaterfall(waterfallCompany(spec), $(exit), { asOf: AS_OF, ...o });
const paid = (w: ReturnType<typeof computeWaterfall>, id: string) => w.classPayouts.find((c) => c.shareClassId === id || c.name === id)!;
const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const breakpoints = (spec: WaterfallSpec) => computeBreakpoints(waterfallCompany(spec), { asOf: AS_OF });

// ---------------------------------------------------------------------------
// Preferences, participation and conversion
// ---------------------------------------------------------------------------

test('NVCA COI §2.3.4 footnote: $150 for 100 common and 100 preferred at $1 pays $100 / $50; a $15 escrow comes out of common', () => {
  const spec: WaterfallSpec = { common: [{ holder: 'c', shares: 100 }], prefs: [{ id: 'P', shares: 100, oip: 1 }] };
  const full = run(spec, 150);
  assert.deepEqual([paid(full, 'P').total, paid(full, 'Common').total], [$(100), $(50)]);
  const escrow = run(spec, 150, { escrowHoldback: $(15) });
  assert.deepEqual([paid(escrow, 'P').total, paid(escrow, 'Common').total], [$(100), $(35)]);
});

/** Fenwick's senior-preference facts: 52.5M common; A 25M at $1 (rank 1); B 10M at $3 (rank 2). */
const fenwickSenior = (bRank: number): WaterfallSpec => ({
  common: [{ holder: 'c', shares: 52_500_000 }],
  prefs: [{ id: 'A', shares: 25_000_000, oip: 1, seniority: 1 }, { id: 'B', shares: 10_000_000, oip: 3, seniority: bRank }],
});

test('Fenwick senior preference: a $40M sale pays Series B $30M, Series A $10M, common nothing', () => {
  const w = run(fenwickSenior(2), 40_000_000);
  assert.deepEqual([paid(w, 'B').total, paid(w, 'A').total, paid(w, 'Common').total], [$(30_000_000), $(10_000_000), 0]);
});

test('NVCA COI §2.1 pari passu: the same $40M shared ratably, A $18,181,818.18 and B $21,818,181.82', () => {
  const w = run(fenwickSenior(1), 40_000_000);
  near(paid(w, 'A').total, 1_818_181_818, 1, 'A');
  near(paid(w, 'B').total, 2_181_818_182, 1, 'B');
});

/** Fenwick's participation facts: 60M common; 40M preferred at $0.75 = $30M preference, 40% as converted. */
const fenwick = (part: 'NP' | 'FP' | 'CP', cap?: number): WaterfallSpec => ({
  common: [{ holder: 'c', shares: 60_000_000 }], prefs: [{ id: 'P', shares: 40_000_000, oip: 0.75, part, cap }],
});

test('Fenwick full participation: a $200M sale pays preferred $98M ($30M + 40% of $170M) and common $102M', () => {
  const w = run(fenwick('FP'), 200_000_000);
  assert.deepEqual([paid(w, 'P').total, paid(w, 'Common').total], [$(98_000_000), $(102_000_000)]);
});

test('Fenwick 3x cap (Feld: the cap includes the preference): $200M pays $90M / $110M; at $275M preferred converts for $110M', () => {
  // https://feld.com/archives/2005/01/term-sheet-liquidation-preference/
  const at200 = run(fenwick('CP', 3), 200_000_000);
  assert.deepEqual([paid(at200, 'P').total, paid(at200, 'Common').total], [$(90_000_000), $(110_000_000)]);
  const at275 = run(fenwick('CP', 3), 275_000_000);
  assert.deepEqual([paid(at275, 'P').total, paid(at275, 'Common').total], [$(110_000_000), $(165_000_000)]);
});

test('Fenwick 3x cap kinks, derived from the same facts: $170M pays $86M, $180M pays $90M, $226M pays $90.4M', () => {
  // The cap binds where 30 + 0.4(E - 30) = 90, E = $180M; converting beats the cap above 90 / 0.4 = $225M.
  assert.deepEqual([170_000_000, 180_000_000, 226_000_000].map((e) => paid(run(fenwick('CP', 3), e), 'P').total),
    [$(86_000_000), $(90_000_000), $(90_400_000)]);
});

test('NVCA term sheet ("or, if greater, ... as-converted"): non-participating keeps $30M at $74M and converts for $30.4M at $76M', () => {
  // https://nvca.org/recommends/nvca-2020-term-sheet-2 ; the indifference point is 30 / 0.4 = $75M.
  assert.deepEqual([74_000_000, 76_000_000].map((e) => paid(run(fenwick('NP'), e), 'P').total), [$(30_000_000), $(30_400_000)]);
});

test('Independent reference reproduces Fenwick: senior $30M / $10M, 3x cap $90M at $200M, conversion $110M at $275M', () => {
  // The reference (test/reference/waterfall.ts) must pass the golden cases before it checks the engine.
  const only = (spec: WaterfallSpec, e: number) => { const eq = refEquilibria(e, refModel(spec)); assert.equal(eq.length, 1); return eq[0].payouts; };
  const senior = only(fenwickSenior(2), 40_000_000);
  assert.deepEqual([Math.round(senior.B), Math.round(senior.A)], [30_000_000, 10_000_000]);
  near(only(fenwick('CP', 3), 200_000_000).P, 90_000_000, 0.01, 'capped');
  near(only(fenwick('CP', 3), 275_000_000).P, 110_000_000, 0.01, 'converted');
});

// ---------------------------------------------------------------------------
// SAFEs at a liquidity event (YC Safe User Guide, Liquidity Event questions)
// ---------------------------------------------------------------------------

/** Founders 9,250,000; 300,000 options (strike 0, so they take the full price); A $200k at $4M; B $800k at $8M. */
const ycSafes: WaterfallSpec = {
  common: [{ holder: 'founders', shares: 9_250_000 }],
  options: [{ holder: 'optionees', shares: 300_000, strike: 0 }],
  safes: [{ id: 'SA', holder: 'invA', amount: 200_000, cap: 4_000_000 }, { id: 'SB', holder: 'invB', amount: 800_000, cap: 8_000_000 }],
};

test('YC Safe User Guide Q3: a $10M acquisition converts both safes, A 561,764 and B 1,123,529 shares', () => {
  // Liquidity Capitalization 9,550,000 / 0.85 = 11,235,293. A gets $10M x 561,764 / 11,235,293 =
  // $499,999.42 (the guide rounds the price to $0.8901 and shows $500,026). ±2 cents of rounding.
  const w = run(ycSafes, 10_000_000);
  assert.deepEqual([paid(w, 'SA').asConvertedShares, paid(w, 'SB').asConvertedShares], [561_764, 1_123_529]);
  near(paid(w, 'SA').total, 49_999_942, 2, 'A');
  near(paid(w, 'SB').total, 99_999_973, 2, 'B');
  near(paid(w, 'Common').total, 823_298_511, 2, 'founders');
});

test('YC Safe User Guide Q4: a $3M acquisition cashes both safes out, $200,000 and $800,000; founders get $1,937,172.77', () => {
  // The remaining $2M is split over 9,550,000 shares: 9,250,000 / 9,550,000 x $2M.
  const w = run(ycSafes, 3_000_000);
  assert.deepEqual([paid(w, 'SA').total, paid(w, 'SB').total], [$(200_000), $(800_000)]);
  near(paid(w, 'Common').total, 193_717_277, 2, 'founders');
});

test('Independent reference, YC Liquidity Capitalization at $6M: B cashes out, A converts on 9,550,000 / 0.95 for 5% of $5.2M', () => {
  const eq = refEquilibria(6_000_000, refModel(ycSafes));
  assert.equal(eq.length, 1);
  assert.deepEqual(eq[0].converted, ['SA']);
  near(eq[0].payouts.SA, 260_000, 0.01, 'A');
  assert.equal(Math.floor(eq[0].safeShares.SA), 502_631);
});

test('YC post-money Safe, Liquidity Capitalization: at $6M B cashes out and A converts on a capitalization without B', () => {
  // Liquidity Capitalization excludes "Safes ... where the holders ... are receiving Cash-Out
  // Amounts": A = 9,550,000 x 0.05 / 0.95 = 502,631 shares, 5% of the $5.2M left = $259,999.72.
  // Before the WF-1 fix the app kept B in the capitalization: 561,764 shares and $288,888.55.
  const w = run(ycSafes, 6_000_000);
  assert.equal(paid(w, 'SB').total, $(800_000));
  assert.equal(paid(w, 'SA').asConvertedShares, 502_631);
  near(paid(w, 'SA').total, 25_999_972, 2, 'A');
});

test('YC post-money Safe, Liquidity Capitalization: at $4.6M A takes its $200,000 cash-out', () => {
  // Converting on the correct capitalization is worth $189,999.79, less than the $200,000 Purchase
  // Amount; before the WF-1 fix the app had A convert for $211,110.86.
  const w = run(ycSafes, 4_600_000);
  assert.equal(paid(w, 'SA').converted, false);
  assert.equal(paid(w, 'SA').total, $(200_000));
});

/** YC Ex.2: the same table with A a pre-money safe, $200k at a $3.8M cap. */
const ycMixed: WaterfallSpec = {
  ...ycSafes,
  safes: [{ id: 'SA', holder: 'invA', amount: 200_000, cap: 3_800_000, instrument: 'SAFE_PRE' }, { id: 'SB', holder: 'invB', amount: 800_000, cap: 8_000_000 }],
};

test('YC Safe User Guide Ex.2 Q3: a converting pre-money safe is in the post-money safe\'s Liquidity Capitalization; B gets 1,116,959 shares, 10% of $10M', () => {
  // A = $200,000 / ($3.8M / 9,550,000) = 502,631; B = $800,000 / ($8M / ((9,550,000 + 502,631) / 90%)) =
  // 1,116,959. B owns 10% of the 11,169,590 and takes $1M (the guide shows $1,000,013 at a price rounded
  // to $0.8953), A $450,000 ($450,006). ±$1: B's shares are floored to a whole share worth $0.90.
  // Before this was fixed the app left A out of B's capitalization: 1,061,111 shares and $954,773.78.
  const w = run(ycMixed, 10_000_000);
  assert.equal(paid(w, 'SB').asConvertedShares, 1_116_959);
  near(paid(w, 'SB').total, $(1_000_000), 100, 'B');
  near(paid(w, 'SA').total, $(450_000), 100, 'A');
  const eq = refEquilibria(10_000_000, refModel(ycMixed));
  assert.equal(eq.length, 1);
  assert.equal(Math.floor(eq[0].safeShares.SB), 1_116_959);
});

test('YC Safe User Guide Q3, Q4 method: two $1M safes at $5M each both convert at $5.5M for $1.1M, though "both take cash" is also stable', () => {
  // The guide works each Conversion Amount on the full Liquidity Capitalization and then pays the
  // Cash-Out Amount to those it beats. On 6M common, both converting gives each 2M of 10M shares,
  // 20% of $5.5M = $1.1M, more than the $1M cash. Had one taken cash, the other would get only 20% of
  // $4.5M, so "both take cash" is stable too, and a search starting from nobody converting stops there.
  const twin: WaterfallSpec = {
    common: [{ holder: 'founders', shares: 6_000_000 }],
    safes: [{ id: 'S1', holder: 'inv1', amount: 1_000_000, cap: 5_000_000 }, { id: 'S2', holder: 'inv2', amount: 1_000_000, cap: 5_000_000 }],
  };
  assert.deepEqual(refEquilibria(5_500_000, refModel(twin)).map((e) => e.converted.join('+')), ['', 'S1+S2']);
  const w = run(twin, 5_500_000);
  assert.deepEqual([paid(w, 'S1').converted, paid(w, 'S2').converted], [true, true]);
  assert.deepEqual([paid(w, 'S1').total, paid(w, 'S2').total, paid(w, 'Common').total], [$(1_100_000), $(1_100_000), $(3_300_000)]);
});

test('YC Postmoney Safe - Discount Only, "Liquidity Price": a $500k safe at 80% takes $625,000 in a $20M sale', () => {
  // Liquidity Price = FMV of common x Discount Rate, so the safe converts into Purchase / (0.8 P)
  // shares worth $500,000 / 0.8. Before the WF-2 fix the app paid the $500,000 cash-out only.
  const d = waterfallCompany({ common: [{ holder: 'f', shares: 10_000_000 }], safes: [{ id: 'S', holder: 'inv', amount: 500_000, cap: null }] });
  d.convertibles[0].discount = 0.2;
  near(paid(computeWaterfall(d, $(20_000_000), { asOf: AS_OF }), 'S').total, $(625_000), 2, 'safe');
});

// ---------------------------------------------------------------------------
// Options and dividends
// ---------------------------------------------------------------------------

test('ASC 260-10-45-23 treasury stock method: options at $0.10 net $904,761.90 in a $20M sale; options at $50 stay out', () => {
  // 8M common; Series A 2M at $1 converts; 500k options at $0.10 and 500k at $50. Cash exercise gives
  // P = (20,000,000 + 50,000) / 10,500,000 = $1.909524, and the treasury method gives the same P.
  const w = run({
    common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', shares: 2_000_000, oip: 1 }],
    options: [{ holder: 'e', shares: 500_000, strike: 0.10 }, { holder: 'e', shares: 500_000, strike: 50 }],
  }, 20_000_000);
  assert.equal(ppsToDollars(w.perCommonShare), 1.909524);
  assert.equal(paid(w, 'A').converted, true);
  near(paid(w, 'A').total, 381_904_762, 1, 'Series A');
  near(w.stakeholderPayouts.find((s) => s.stakeholderId === 'e')!.fromOptions, 90_476_190, 1, 'options net');
  assert.deepEqual([w.optionsExercised, w.optionsUnderwater], [500_000, 500_000]);
});

test('NVCA COI §1: cumulative dividends accrue on each share from its own issuance', () => {
  // 1M Series A closed 2021-01-01 and 1M more 2024-01-01, 8% simple, as of 2025-01-01:
  // $2,000,000 + $80,000 x 4.0 + $80,000 x 1.0021 = $2,400,164.27 on days/365.25. NVCA sets no day
  // count (actual/365 gives $2,400,438.36), so the tolerance is $300. Before the WF-4 fix the app
  // accrued every share from the class date: $2,640,000.
  const d = waterfallCompany({ common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', holder: 'inv1', shares: 1_000_000, oip: 1, divType: 'CUMULATIVE', divRate: 0.08, issueDate: '2021-01-01' }] });
  d.issuances.push({ ...d.issuances.find((i) => i.shareClassId === 'A')!, id: 'is_second_close', stakeholderId: 'inv2', issueDate: '2024-01-01' });
  d.stakeholders.push({ ...d.stakeholders[0], id: 'inv2', name: 'inv2' });
  near(paid(computeWaterfall(d, $(5_000_000), { asOf: AS_OF }), 'A').preferenceClaim, 240_016_427, $(300), 'claim');
});

test('NVCA COI §1: a transfer does not restart the dividend clock; the shares accrue from their original issuance', () => {
  // 2M Series A issued 2021-01-01 at $1, 8% cumulative, all sold to another holder on 2024-01-01: the
  // claim on 2025-01-01 is still $2,000,000 + $160,000 x 4.0 = $2,640,000, not $2,160,164.27.
  const d = waterfallCompany({ common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', holder: 'inv1', shares: 2_000_000, oip: 1, divType: 'CUMULATIVE', divRate: 0.08, issueDate: '2021-01-01' }] });
  const original = d.issuances.find((i) => i.shareClassId === 'A')!;
  d.issuances.push({ ...original, id: 'is_transfer', stakeholderId: 'inv2', issueDate: '2024-01-01', notes: `Transferred from certificate ${original.id}` });
  original.status = 'TRANSFERRED';
  d.stakeholders.push({ ...d.stakeholders[0], id: 'inv2', name: 'inv2' });
  assert.equal(paid(computeWaterfall(d, $(5_000_000), { asOf: AS_OF }), 'A').preferenceClaim, $(2_640_000));
});

// ---------------------------------------------------------------------------
// Breakpoints: each must be where the app's own waterfall changes shape
// ---------------------------------------------------------------------------

const bp = (spec: WaterfallSpec, kind: string, label: string) => breakpoints(spec).filter((b) => b.kind === kind && b.label.startsWith(label)).map((b) => b.exitValue);

test('NVCA COI §2.1 greater-of: behind a $5M senior preference, A converts above $15M and B above $55M', () => {
  // 8M common; A 2M at $1 (rank 1); B 1M at $5 (rank 2). A converts when 2/10 x (E - $5M) > $2M;
  // B when E/11 x 1 > $5M with A converted. The app's own waterfall converts A a few cents above
  // $15M; before the WF-5 fix computeBreakpoints said $11M.
  const spec: WaterfallSpec = { common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', shares: 2_000_000, oip: 1, seniority: 1 }, { id: 'B', shares: 1_000_000, oip: 5, seniority: 2 }] };
  near(bp(spec, 'CONVERSION', 'A ')[0], $(15_000_000), $(10), 'A');
  near(bp(spec, 'CONVERSION', 'B ')[0], $(55_000_000), $(10), 'B');
});

test('NVCA COI §2.1 greater-of: accrued dividends move the conversion point ($2.64M claim converts above $13.2M)', () => {
  // Series A 2M at $1 with 8% cumulative dividends from 2021-01-01: claim $2,640,000 on 2025-01-01,
  // 20% as converted, so 2,640,000 / 0.2. Before the WF-5 fix the breakpoint dropped the dividends: $10M.
  const spec: WaterfallSpec = { common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', shares: 2_000_000, oip: 1, divType: 'CUMULATIVE', divRate: 0.08 }] };
  near(bp(spec, 'CONVERSION', 'A ')[0], $(13_200_000), $(10), 'A');
});

test('Fenwick 3x cap: the cap binds at $180M and the class converts at $225M', () => {
  // Before the WF-6 fix the app reported one breakpoint, CAP at $225M, which is the conversion point.
  near(bp(fenwick('CP', 3), 'CAP', 'P ')[0] ?? 0, $(180_000_000), $(10), 'cap');
  near(bp(fenwick('CP', 3), 'CONVERSION', 'P ')[0] ?? 0, $(225_000_000), $(10), 'conversion');
});

test('NVCA COI §2.1-2.2: options at $0.50 come into the money at $6.0M while non-participating preferred holds its preference', () => {
  // Below A's conversion point A does not share the residual: (E - 2M + 0.5M) / 9M = $0.50 at E = $6M.
  // Before the WF-7 fix the breakpoint counted A in the price and said $7.5M.
  const spec: WaterfallSpec = { common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', shares: 2_000_000, oip: 1 }], options: [{ holder: 'e', shares: 1_000_000, strike: 0.5 }] };
  near(bp(spec, 'STRIKE', 'Options')[0], $(6_000_000), $(10), 'strike');
});

test('NVCA COI §2.1 ratable: two $2M preferences at one rank are both paid in full only at $4M', () => {
  // At $2M the app pays A $1M and B $1M; before the WF-8 fix the breakpoint said "A preference fully paid" at $2M.
  const spec: WaterfallSpec = { common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', shares: 2_000_000, oip: 1, seniority: 1 }, { id: 'B', shares: 1_000_000, oip: 2, seniority: 1 }] };
  assert.deepEqual(bp(spec, 'PREFERENCE', 'A '), [$(4_000_000)]);
});

test('Between two consecutive breakpoints every payout is linear in the exit (40 seeded random tables)', () => {
  // The audit's property (section 3): before WF-5 to WF-8 were fixed it failed on most multi-class
  // tables. The midpoint of each stretch must pay every class the average of its quarter points.
  const r = rng(20261006);
  for (let n = 0; n < 40; n++) {
    const spec = randomWaterfallSpec(r);
    if (r() < 0.5) spec.safes = [{ id: 'S', holder: 'Holder 9', amount: 100_000 + int(r, 0, 20) * 50_000, cap: r() < 0.8 ? 5_000_000 + int(r, 0, 30) * 1_000_000 : null }];
    const d = waterfallCompany(spec);
    const edges = [0, ...computeBreakpoints(d, { asOf: AS_OF }).map((b) => b.exitValue)];
    edges.push(Math.max(2 * edges[edges.length - 1], $(1_000_000)));
    const pays = (e: number) => new Map(computeWaterfall(d, Math.round(e), { asOf: AS_OF }).classPayouts.map((c) => [c.shareClassId, c.total]));
    for (let i = 0; i + 1 < edges.length; i++) {
      const [lo, hi] = [edges[i], edges[i + 1]];
      if (hi - lo < 400) continue;
      const [q1, mid, q3] = [0.25, 0.5, 0.75].map((f) => pays(lo + (hi - lo) * f));
      for (const [id, total] of mid) near(total, ((q1.get(id) ?? 0) + (q3.get(id) ?? 0)) / 2, 3, `table ${n}, ${id} between ${lo} and ${hi}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Charts, debt and rounding
// ---------------------------------------------------------------------------

test('Conservation in the exit chart: two same-named safes keep both payouts ($1.5M of a $3M exit)', () => {
  // classPayouts pay $1,000,000 and $500,000; before the WF-10 fix waterfallCurve keyed by name and kept only one.
  const d = waterfallCompany({ common: [{ holder: 'c', shares: 8_000_000 }], safes: [
    { id: 'S1', holder: 'fund', amount: 1_000_000, cap: 100_000_000 }, { id: 'S2', holder: 'fund', amount: 500_000, cap: 100_000_000 }] });
  const [point] = waterfallCurve(d, $(3_000_000), 1, { asOf: AS_OF });
  assert.equal(Object.values(point.byClass).reduce((s, v) => s + v, 0), $(3_000_000));
});

test('NVCA COI §2.3.4: escrow comes out of what stockholders receive, after debt', () => {
  // $10M exit, $9.5M note repaid as debt, $1M escrow: the debt is paid in full and at most the $0.5M
  // left for stockholders is escrowed. Before the WF-11 fix the app repaid $9.0M and warned of a shortfall.
  const w = run({ common: [{ holder: 'c', shares: 8_000_000 }], safes: [{ id: 'N', holder: 'lender', amount: 9_500_000, cap: null, instrument: 'NOTE' }] },
    10_000_000, { escrowHoldback: $(1_000_000) });
  assert.equal(w.debtRepaid, $(9_500_000));
  assert.ok(w.escrowHoldback <= $(500_000), `escrow ${w.escrowHoldback}`);
});

test('Arithmetic: common gets $143,076.92 when 80 option grants share a $5M exit with 100,000 common', () => {
  // Exact P solves 100,000 P + Σ 1,000,000 max(0, P - K) = 5,000,000 for strikes $1.00..$2.58:
  // P = $1.430769231, so common = $143,076.92. Before the WF-13 fix the app weighted with the rounded P: $143,077.05.
  const options = Array.from({ length: 80 }, (_, i) => ({ holder: `e${i}`, shares: 1_000_000, strike: Number((1 + 0.02 * i).toFixed(2)) }));
  near(paid(run({ common: [{ holder: 'c', shares: 100_000 }], options }, 5_000_000), 'Common').total, 14_307_692, 1, 'common');
});

// ---------------------------------------------------------------------------
// Breakpoints where the payouts start
// ---------------------------------------------------------------------------

test('A $0 distribution makes no election: a note repaid as debt and a SAFE give no breakpoint at $0.01', () => {
  // 8,000,000 common; a $750k note at 6% simple from 2022-01-01, repaid as debt ($885,000 on 2025-01-01); a
  // $1M post-money safe at a $10M cap. Stockholders are paid from $885,000; the safe's $1M cash-out is covered
  // at $1,885,000 and it converts once 10% of what is left beats $1M. Before the fix the app also reported
  // the cash-out paid and the safe converting at $0.01, and showed it converted into $0 at a $50,000 exit.
  const d = waterfallCompany({ common: [{ holder: 'f', shares: 8_000_000 }], safes: [
    { id: 'N', holder: 'lender', amount: 750_000, cap: null, instrument: 'NOTE' }, { id: 'S', holder: 'angel', amount: 1_000_000, cap: 10_000_000 }] });
  d.convertibles.find((c) => c.id === 'N')!.interestRate = 0.06;
  const opts = { asOf: AS_OF, repayNotesAsDebt: true };
  const bps = computeBreakpoints(d, opts);
  assert.deepEqual(bps.map((b) => [b.kind, b.exitValue]).slice(0, 2), [['ZERO', $(885_000)], ['PREFERENCE', $(1_885_000)]]);
  assert.match(bps[0].label, /^Stockholders start to be paid once the notes are repaid$/);
  assert.deepEqual(bps.slice(2).map((b) => b.kind), ['CONVERSION']);
  near(bps[2].exitValue, $(885_000 + 10_000_000), $(10), 'conversion');
  const small = computeWaterfall(d, $(50_000), opts);
  assert.deepEqual([paid(small, 'S').converted, paid(small, 'S').total, small.debtRepaid], [false, 0, $(50_000)]);
});

test('NVCA COI §2.3.4: the exit at which fees, debt and escrow are covered is a breakpoint', () => {
  // 8,000,000 common and Series A 2,000,000 at $1 non-participating, a $1M escrow: Series A is paid nothing at
  // $1M and $1M at $2M, so its payout bends at $1M. Before the fix the first breakpoint was $3M.
  const spec: WaterfallSpec = { common: [{ holder: 'c', shares: 8_000_000 }], prefs: [{ id: 'A', shares: 2_000_000, oip: 1 }] };
  const escrowed = computeBreakpoints(waterfallCompany(spec), { asOf: AS_OF, escrowHoldback: $(1_000_000) });
  assert.deepEqual(escrowed.map((b) => [b.kind, b.exitValue]).slice(0, 2), [['ZERO', $(1_000_000)], ['PREFERENCE', $(3_000_000)]]);
  // With fees and a note as well, each stage off the top is one: fees $50k, the $500k note, then the escrow.
  const withNote = waterfallCompany({ ...spec, safes: [{ id: 'N', holder: 'lender', amount: 500_000, cap: null, instrument: 'NOTE' }] });
  const all = computeBreakpoints(withNote, { asOf: AS_OF, transactionFees: $(50_000), escrowHoldback: $(1_000_000), repayNotesAsDebt: true });
  assert.deepEqual(all.filter((b) => b.kind === 'ZERO').map((b) => [b.exitValue, b.label]), [
    [$(50_000), 'Transaction fees paid: the notes start to be repaid'],
    [$(550_000), 'Notes repaid in full: the escrow starts to fill'],
    [$(1_550_000), 'Stockholders start to be paid once the transaction fees are paid, the notes are repaid and the escrow is held back'],
  ]);
});

test('YC Postmoney Safe - Discount Only: the exit that covers Purchase Amount / Discount Rate is a breakpoint', () => {
  // 10,000,000 common and a $500k safe at 80%: converted, it takes everything up to $625,000 (the Liquidity
  // Price leaves no consistent share of less; this engine gives it what there is) and $625,000 above. Common is
  // paid from $625,000 on, so the payouts bend there. Before the fix nothing was reported but two
  // breakpoints at $0.01.
  const d = waterfallCompany({ common: [{ holder: 'f', shares: 10_000_000 }], safes: [{ id: 'D', holder: 'd', amount: 500_000, cap: null }] });
  d.convertibles[0].discount = 0.2;
  const bps = computeBreakpoints(d, { asOf: AS_OF });
  assert.deepEqual(bps.map((b) => [b.kind, b.exitValue]), [['PREFERENCE', $(625_000)]]);
  assert.deepEqual([paid(computeWaterfall(d, $(600_000), { asOf: AS_OF }), 'D').total, paid(computeWaterfall(d, $(700_000), { asOf: AS_OF }), 'Common').total], [$(600_000), $(75_000)]);
});

test('Between two consecutive breakpoints every payout is linear, with fees, escrow, debt and discount-only safes (60 seeded tables)', () => {
  // As the property above, with what sits off the top and safes and notes of every kind. A stretch whose
  // elections never settle is left out: the waterfall warns about those.
  const r = rng(20261007);
  for (let n = 0; n < 60; n++) {
    const spec = randomWaterfallSpec(r);
    spec.safes = Array.from({ length: int(r, 0, 3) }, (_, k) => ({
      id: `S${k}`, holder: `Safe holder ${k}`, amount: 100_000 + int(r, 0, 40) * 50_000, cap: r() < 0.7 ? 3_000_000 + int(r, 0, 40) * 1_000_000 : null,
      instrument: (['SAFE_POST', 'SAFE_POST', 'SAFE_PRE', 'NOTE'] as const)[int(r, 0, 3)],
    }));
    const d = waterfallCompany(spec);
    for (const c of d.convertibles) {
      if (c.instrument === 'NOTE') c.interestRate = 0.06;
      else if (c.valuationCap == null && r() < 0.7) c.discount = 0.2;
    }
    const opts: WaterfallOptions = { asOf: AS_OF, transactionFees: r() < 0.4 ? $(500_000) : 0, escrowHoldback: r() < 0.4 ? $(1_000_000) : 0, repayNotesAsDebt: r() < 0.5 };
    const edges = [0, ...computeBreakpoints(d, opts).map((b) => b.exitValue)];
    edges.push(Math.max(2 * edges[edges.length - 1], $(1_000_000)));
    const at = (e: number) => computeWaterfall(d, Math.round(e), opts);
    const pays = (w: ReturnType<typeof at>) => new Map([...w.classPayouts.map((c) => [c.shareClassId, c.total] as const), ['debt', w.debtRepaid]]);
    for (let i = 0; i + 1 < edges.length; i++) {
      const [lo, hi] = [edges[i], edges[i + 1]];
      if (hi - lo < 400) continue;
      const ws = [0.25, 0.5, 0.75].map((f) => at(lo + (hi - lo) * f));
      if (ws.some((w) => w.warnings.some((x) => /did not settle/.test(x)))) continue;
      const [q1, mid, q3] = ws.map(pays);
      for (const [id, total] of mid) near(total, ((q1.get(id) ?? 0) + (q3.get(id) ?? 0)) / 2, 3, `table ${n}, ${id} between ${lo} and ${hi}`);
    }
  }
});

// ---------------------------------------------------------------------------
// MFN safes. YC Safe (MFN), "MFN Amendment Provision": the safe is amended "to be
// identical to" one later convertible security whose terms the holder prefers.
// ---------------------------------------------------------------------------

/** 10,000,000 common; an uncapped $1M MFN safe (Jan 2022) and later $1M safes. */
const mfnSpec = (mfn: 'SAFE_PRE' | 'SAFE_POST', ...later: NonNullable<WaterfallSpec['safes']>): WaterfallSpec => ({
  common: [{ holder: 'founders', shares: 10_000_000 }],
  safes: [{ id: 'M', holder: 'mfn', amount: 1_000_000, cap: null, instrument: mfn, mfn: true, issueDate: '2022-01-01' }, ...later],
});

test('YC MFN safe in a $100M sale: an uncapped MFN adopts the later $5M pre-money cap and converts like it, $14,285,714.29 each', () => {
  // Liquidity Capitalization 10,000,000. Both safes are $1M at a $5M pre-money cap: 1,000,000 x 10,000,000 /
  // 5,000,000 = 2,000,000 shares each, as the cap table shows. 14,000,000 shares share $100M: each safe
  // $100M x 2 / 14 = $14,285,714.29, common $100M x 10 / 14 = $71,428,571.43. Before the fix the waterfall
  // read the MFN's own (absent) cap: it took its $1M cash-out and the later safe got $99M x 2 / 12 = $16.5M.
  const spec = mfnSpec('SAFE_PRE', { id: 'L', holder: 'later', amount: 1_000_000, cap: 5_000_000, instrument: 'SAFE_PRE', issueDate: '2022-06-01' });
  const w = run(spec, 100_000_000);
  assert.deepEqual([paid(w, 'M').asConvertedShares, paid(w, 'L').asConvertedShares], [2_000_000, 2_000_000]);
  near(paid(w, 'M').total, 1_428_571_429, 2, 'MFN');
  near(paid(w, 'L').total, 1_428_571_429, 2, 'later');
  near(paid(w, 'Common').total, 7_142_857_143, 2, 'common');
  assert.ok(!w.warnings.some((x) => /no valuation cap/.test(x)), w.warnings.join('; '));
  assert.equal(Math.floor(refEquilibria(100_000_000, refModel(spec))[0].safeShares.M), 2_000_000);
});

test('YC MFN safe: a post-money MFN that adopts a pre-money cap converts on the pre-money base, 2,000,000 shares, not 3,000,000', () => {
  // The amended safe is identical to the later pre-money safe, so it prices on 10,000,000 as above. Had it kept a
  // post-money basis at $5M it would own 20% of 10,000,000 + 2,000,000 + itself: 0.2 x 12,000,000 / 0.8 = 3,000,000.
  const w = run(mfnSpec('SAFE_POST', { id: 'L', holder: 'later', amount: 1_000_000, cap: 5_000_000, instrument: 'SAFE_PRE', issueDate: '2022-06-01' }), 100_000_000);
  assert.deepEqual([paid(w, 'M').asConvertedShares, paid(w, 'L').asConvertedShares], [2_000_000, 2_000_000]);
  near(paid(w, 'M').total, 1_428_571_429, 2, 'MFN');
});

test('YC MFN safe: a safe issued after the sale is not one the MFN can adopt', () => {
  // A ($10M pre-money cap, Jun 2022) is adopted; C ($2M cap) is issued Jun 2025, after the 1 Jan 2025 sale, and
  // is not outstanding then. MFN and A get 1,000,000 shares each on 10,000,000: $100M x 1 / 12 = $8,333,333.33.
  // Adopting C would have given 5,000,000 shares and $31.25M.
  const w = run(mfnSpec('SAFE_PRE',
    { id: 'A', holder: 'a', amount: 1_000_000, cap: 10_000_000, instrument: 'SAFE_PRE', issueDate: '2022-06-01' },
    { id: 'C', holder: 'c', amount: 1_000_000, cap: 2_000_000, instrument: 'SAFE_PRE', issueDate: '2025-06-01' }), 100_000_000);
  assert.equal(paid(w, 'M').asConvertedShares, 1_000_000);
  near(paid(w, 'M').total, 833_333_333, 2, 'MFN');
});

test('YC MFN safe in a $100M sale: the MFN adopts the later safe that gives it the most shares, $5.5M post-money over $5M pre-money', () => {
  // 10,000,000 common; MFN $1M uncapped (Jan 2022), X $1M pre-money at $5M (Mar 2022), Y $1M post-money at $5.5M (Jun 2022).
  // X converts on the 10,000,000 base: $1M x 10M / $5M = 2,000,000.
  //  - As X: MFN 2,000,000; Y owns 1/5.5 of (10M + 4M) / (1 - 1/5.5) = 17,111,111, so 3,111,111. MFN $100M x 2 / 17.11 = $11.69M.
  //  - As Y: MFN and Y own 1/5.5 each of (10M + 2M) / (1 - 2/5.5) = 18,857,142.9, so 3,428,571 each.
  // Y gives more. 18,857,142 shares share $100M: MFN and Y $100M x 3,428,571 / 18,857,142 = $18,181,816.74,
  // X $10,606,061.09, common $53,030,305.44. Ranking by the lower cap took X's $5M.
  const spec = mfnSpec('SAFE_PRE',
    { id: 'X', holder: 'x', amount: 1_000_000, cap: 5_000_000, instrument: 'SAFE_PRE', issueDate: '2022-03-01' },
    { id: 'Y', holder: 'y', amount: 1_000_000, cap: 5_500_000, instrument: 'SAFE_POST', issueDate: '2022-06-01' });
  const w = run(spec, 100_000_000);
  assert.deepEqual(['M', 'X', 'Y'].map((id) => paid(w, id).asConvertedShares), [3_428_571, 2_000_000, 3_428_571]);
  near(paid(w, 'M').total, 1_818_181_674, 2, 'MFN');
  near(paid(w, 'X').total, 1_060_606_109, 2, 'X');
  near(paid(w, 'Common').total, 5_303_030_544, 2, 'common');
  assert.equal(Math.floor(refEquilibria(100_000_000, refModel(spec))[0].safeShares.M), 3_428_571);
});

test('Seeded waterfalls with MFN safes: the engine agrees with the independent reference (80 tables)', () => {
  // randomWaterfallSpec plus an MFN safe and one to three later capped safes, pre- or post-money. Only exits
  // where the reference finds a single stable set of elections are compared.
  const pickKind = (r: () => number) => (r() < 0.5 ? 'SAFE_PRE' : 'SAFE_POST') as 'SAFE_PRE' | 'SAFE_POST';
  let compared = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const r = rng(seed * 104_729);
    const spec = randomWaterfallSpec(r);
    spec.safes = [
      { id: 'M', holder: 'MFN holder', amount: 100_000 + int(r, 0, 10) * 50_000, cap: r() < 0.3 ? 5_000_000 + int(r, 0, 30) * 1_000_000 : null,
        instrument: pickKind(r), mfn: true, issueDate: '2021-06-01' },
      ...Array.from({ length: int(r, 1, 3) }, (_, k) => ({
        id: `S${k}`, holder: `Safe holder ${k}`, amount: 100_000 + int(r, 0, 10) * 50_000, cap: 5_000_000 + int(r, 0, 30) * 1_000_000,
        instrument: pickKind(r), issueDate: `2022-0${k + 1}-01`,
      })),
    ];
    const exit = randomExit(r, spec);
    const eq = refEquilibria(exit, refModel(spec));
    if (eq.length !== 1) continue;
    const w = run(spec, exit);
    for (const [id, want] of Object.entries(eq[0].payouts)) {
      if (id === 'common' || id.startsWith('opt')) continue;
      near(paid(w, id).total, want * 100, Math.max(500, exit * 1e-3), `seed ${seed}, ${id} at $${exit}`);
    }
    compared++;
  }
  assert.ok(compared > 50, `only ${compared} of 80 tables compared`);
});
