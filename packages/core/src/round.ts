import type { CompanyData, Cents, ISODate, PricePerShare, ShareClass, Convertible } from './types.ts';
import { computeCapTable } from './captable.ts';
import { convertAll, conversionAmount, resolveMFN, solvePostMoneySafes, type ConversionResult } from './convertibles.ts';
import { normalizeSplits } from './splits.ts';
import { sharesForAmount, ppsForAmount, roundShares, floorShares, shareValue, pct } from './util.ts';
import { MICRO, CENTS } from './types.ts';

const CENTS_TO_PPS = MICRO / CENTS;
/** One-hundredth of a cent, the precision of a weighted-average conversion price (NVCA Model COI §4.4.4). */
const HUNDREDTH_CENT: PricePerShare = MICRO / 10_000;

export interface RoundInvestor {
  id?: string;
  stakeholderId: string | null;
  name: string;
  amount: Cents;
  /** Investor gets shares at a negotiated discount to the round price. */
  discount?: number;
}

export interface RoundModelInput {
  name: string;                       // "Series A"
  closeDate: ISODate;
  /** Supply exactly one of preMoney / postMoney. */
  preMoney?: Cents;
  postMoney?: Cents;
  investors: RoundInvestor[];
  /** Desired unallocated pool as a % of post-round fully diluted, 0..1. */
  targetPoolPct: number;
  /** True = pool increase comes out of the pre-money (dilutes existing holders only). */
  poolFromPreMoney: boolean;
  /** Explicit pool increase in shares; overrides targetPoolPct when set. */
  poolIncreaseShares?: number | null;
  poolId?: string | null;
  convertConvertibles: boolean;
  /** Restrict conversion to specific instruments; default is all outstanding. */
  convertibleIds?: string[] | null;
  /**
   * Whether the pre-money SAFE cap price is computed against a capitalization
   * that includes the new option pool. Most pre-money SAFEs say it does.
   */
  capIncludesNewPool?: boolean;
  /** Series terms applied to the new preferred class. */
  terms?: Partial<ShareClass>;
}

export interface OwnershipDelta {
  stakeholderId: string;
  name: string;
  group: string;
  sharesBefore: number;
  pctBefore: number;
  sharesAfter: number;
  pctAfter: number;
  dilutionPct: number;                // pctBefore - pctAfter
  dilutionRelative: number;           // (pctBefore - pctAfter) / pctBefore
  valueAfter: Cents;
}

export interface RoundModelResult {
  input: RoundModelInput;
  pricePerShare: PricePerShare;
  preMoney: Cents;
  /** Pre-money plus the new money: the headline post-money valuation. */
  postMoney: Cents;
  /**
   * Price per share x post-round fully diluted. It equals postMoney when the
   * pool increase comes out of the pre-money; when it comes out of the
   * post-money the new pool is priced in too, so the round implies more.
   */
  impliedPostMoney: Cents;
  amountRaised: Cents;
  preRoundFullyDiluted: number;
  postRoundFullyDiluted: number;
  newInvestorShares: number;
  conversionShares: number;
  poolIncrease: number;
  poolAvailableAfter: number;
  poolPctAfter: number;
  conversions: ConversionResult[];
  investorAllocations: { name: string; stakeholderId: string | null; amount: Cents; shares: number; pctPost: number; pps: PricePerShare }[];
  ownership: OwnershipDelta[];
  /** Total dilution suffered by pre-round holders. */
  existingHolderDilution: number;
  iterations: number;
  converged: boolean;
  warnings: string[];
}

/**
 * Models a priced round.
 *
 * The round price, the option pool top-up and the SAFE/note conversion all
 * depend on one another, so the system is solved by fixed-point iteration:
 *
 *   PPS  = preMoney / (existingFD + poolIncrease + convertedShares)
 *   N    = investment / PPS
 *   T    = (existingFD + converted + N - existingPoolAvailable) / (1 - targetPool%)
 *   pool = targetPool% x T - existingPoolAvailable
 *
 * Iterating these to a fixed point reproduces the standard "pool shuffle"
 * result where the new pool and the converting instruments come out of the
 * pre-money valuation.
 */
export function modelRound(data: CompanyData, input: RoundModelInput): RoundModelResult {
  const warnings: string[] = [];
  const asOf = input.closeDate;
  if ((input.preMoney == null) === (input.postMoney == null)) throw new RangeError('Supply exactly one pre-money or post-money valuation.');
  if (!Number.isFinite(input.targetPoolPct) || input.targetPoolPct < 0 || input.targetPoolPct >= 1) throw new RangeError('Target pool must be between 0% and 100%, excluding 100%.');
  if (input.poolIncreaseShares != null && (!Number.isFinite(input.poolIncreaseShares) || input.poolIncreaseShares < 0)) throw new RangeError('Pool increase must be finite and nonnegative.');
  for (const inv of input.investors) {
    if (!Number.isSafeInteger(inv.amount) || inv.amount < 0) throw new RangeError('Investment must be a nonnegative integer amount in cents.');
    if (!Number.isFinite(inv.discount ?? 0) || (inv.discount ?? 0) < 0 || (inv.discount ?? 0) >= 1) throw new RangeError('Investor discount must be between 0% and 100%, excluding 100%.');
  }

  const before = computeCapTable(data, { asOf, includeConvertibles: false, includeUnallocatedPool: true });
  const existingFD = before.totals.fullyDiluted;
  const existingPoolAvailable = before.totals.poolAvailable;

  const amountRaised = input.investors.reduce((s, i) => s + i.amount, 0);
  let preMoney: Cents;
  if (input.preMoney != null) preMoney = input.preMoney;
  else if (input.postMoney != null) preMoney = input.postMoney - amountRaised;
  else throw new Error('modelRound requires either preMoney or postMoney.');
  if (!Number.isSafeInteger(preMoney) || preMoney <= 0) throw new RangeError('Pre-money valuation must be a positive integer amount in cents.');
  if (existingFD <= 0) throw new RangeError('Round pricing requires existing shares or an equity pool.');

  const convertibles: Convertible[] = input.convertConvertibles
    ? data.convertibles.filter(
        (c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf &&
          (!input.convertibleIds || input.convertibleIds.includes(c.id)) &&
          (c.qualifiedFinancingMinimum == null || amountRaised >= c.qualifiedFinancingMinimum),
      )
    : [];
  if (input.convertConvertibles) {
    const skipped = data.convertibles.filter(
      (c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf &&
        c.qualifiedFinancingMinimum != null && amountRaised < c.qualifiedFinancingMinimum,
    );
    for (const s of skipped) {
      warnings.push(`${s.instrument} ${s.id.slice(-6)} does not convert: the round is below its qualified financing minimum.`);
    }
  }

  // Post-money SAFEs (by their own terms or an MFN's) are solved together on
  // Company Capitalization; everything else prices on its own.
  const terms = new Map(convertibles.map((c) => [c.id, resolveMFN(c, data.convertibles, asOf, preMoney)]));
  const isPostMoney = (c: Convertible): boolean => terms.get(c.id)!.instrument === 'SAFE_POST';
  const preMoneyInstruments = convertibles.filter((c) => !isPostMoney(c));
  const postMoneySafes = convertibles.filter(isPostMoney);
  const investorPrice = (inv: RoundInvestor, at: PricePerShare): PricePerShare =>
    inv.discount ? Math.max(1, Math.round(at * (1 - inv.discount))) : at;

  // ---- Fixed point ------------------------------------------------------
  const priceTooLow = 'No round price solves these terms: the price per share would fall below $0.000001. Raise the pre-money valuation.';
  let pps: PricePerShare = ppsForAmount(preMoney, Math.max(1, existingFD));
  if (pps < 1) throw new RangeError(priceTooLow);
  let poolIncrease = 0;
  let conversions: ConversionResult[] = [];
  let conversionShares = 0;
  let newInvestorShares = 0;
  let postFD = existingFD;
  let iterations = 0;
  let converged = false;

  for (let i = 0; i < 500; i++) {
    iterations = i + 1;
    const prevPPS = pps;
    const prevPool = poolIncrease;
    const prevConversions = conversionShares;

    // 1. Convert the instruments at the current round price.
    //    Pre-money SAFEs and notes price against the pre-money capitalization,
    //    which by their terms includes the pool increase made for the round.
    //    Post-money SAFEs price against the "company capitalization", which
    //    includes every converting SAFE but EXCLUDES the pool increase made in
    //    connection with the financing — so the top-up dilutes SAFE holders
    //    exactly as it dilutes founders. That capitalization includes the
    //    post-money SAFEs' own shares, so they are solved exactly at this price
    //    rather than by iterating on a rounded cap price, which stalls short
    //    when the safes own most of the company (YC Safe User Guide p.19).
    const preMoneyCap = existingFD + (input.capIncludesNewPool === false ? 0 : poolIncrease);
    const preConversions = preMoneyInstruments.length
      ? convertAll(preMoneyInstruments, {
          asOf, roundPPS: pps,
          preMoneyCapitalization: Math.max(1, preMoneyCap),
          postMoneyCapitalization: Math.max(1, existingFD + conversionShares),
          allConvertibles: data.convertibles, valuation: preMoney,
        })
      : [];
    const preShares = preConversions.reduce((s, c) => s + c.shares, 0);
    let postConversions: ConversionResult[] = [];
    if (postMoneySafes.length) {
      const solved = solvePostMoneySafes(postMoneySafes, existingFD + preShares, pps, asOf, data.convertibles, preMoney);
      postConversions = convertAll(postMoneySafes, {
        asOf, roundPPS: pps,
        preMoneyCapitalization: Math.max(1, preMoneyCap),
        postMoneyCapitalization: Math.max(1, solved.totalCapitalization),
        allConvertibles: data.convertibles, valuation: preMoney,
      }).map((r) => ({ ...r, shares: solved.shares.get(r.convertibleId) ?? r.shares }));
    }
    conversions = [...preConversions, ...postConversions];
    conversionShares = roundShares(conversions.reduce((s, c) => s + c.shares, 0));

    // 2. New investor shares at the current price.
    newInvestorShares = roundShares(
      input.investors.reduce((s, inv) => s + sharesForAmount(inv.amount, investorPrice(inv, pps)), 0),
    );

    // 3. Solve for the post-round total and the pool top-up.
    if (input.poolIncreaseShares != null) {
      poolIncrease = Math.max(0, input.poolIncreaseShares);
      postFD = roundShares(existingFD + poolIncrease + conversionShares + newInvestorShares);
    } else if (input.targetPoolPct > 0) {
      const target = input.targetPoolPct;
      const numerator = existingFD + conversionShares + newInvestorShares - existingPoolAvailable;
      const total = numerator / (1 - target);
      poolIncrease = Math.max(0, Math.round(target * total - existingPoolAvailable));
      postFD = roundShares(existingFD + poolIncrease + conversionShares + newInvestorShares);
    } else {
      poolIncrease = 0;
      postFD = roundShares(existingFD + conversionShares + newInvestorShares);
    }

    // 4. Is there a price at all? The pre-money shares the price divides are
    //    a fixed part plus parts that grow with them as the price falls: shares
    //    converting at the round price (or a discount to it); post-money SAFEs
    //    at their cap, a fixed slice of Company Capitalization; the pool top-up,
    //    a fixed share of a post-round total that grows with the pre-money
    //    shares; and pre-money caps priced on a base that includes that top-up.
    //    If the growing parts claim the whole pre-money no price solves the
    //    round (YC Safe User Guide p.20, 22: price = pre-money / (pre-round FD
    //    + conversions + pool increase)); iterating would only drive the price
    //    toward zero until rounding stalls it. Each part only grows as the price
    //    falls, so testing at every step catches it before the price collapses.
    const raised = input.investors.reduce((s, inv) => s + (inv.amount * pps) / (investorPrice(inv, pps) * preMoney), 0);
    const poolGrowth = input.poolIncreaseShares != null || poolIncrease <= 0 ? 0
      : input.poolFromPreMoney ? input.targetPoolPct * (1 + raised)
        : (input.targetPoolPct * (1 + raised)) / (1 - input.targetPoolPct);
    let postCapped = 0, preCapped = 0, atRoundPrice = 0;
    for (const c of conversions) {
      const { cap, instrument } = terms.get(c.convertibleId)!;
      if (c.method !== 'CAP' && c.method !== 'MFN_CAP') atRoundPrice += (c.amount * pps) / (c.conversionPrice * preMoney);
      else if (!cap) continue;
      else if (instrument === 'SAFE_POST') postCapped += c.amount / cap;
      else if (input.capIncludesNewPool !== false) preCapped += c.amount / cap;
    }
    // The pool sits outside Company Capitalization, so post-money caps do not
    // grow with it; pre-money caps whose base includes it grow in proportion.
    const poolClaim = (input.poolFromPreMoney ? poolGrowth * (1 - postCapped) : 0) + preCapped * poolGrowth;
    const claimed = postCapped + atRoundPrice + poolClaim;
    if (claimed >= 1) {
      const parts = poolClaim > 0 && conversions.length ? 'the converting SAFEs and notes and the option pool increase'
        : poolClaim > 0 ? 'the option pool increase' : 'the converting SAFEs and notes';
      const remedy = poolClaim > 0 && conversions.length ? ', lower the target pool or leave some of the SAFEs and notes out of the round'
        : poolClaim > 0 ? ' or lower the target pool' : ' or leave some of them out of the round';
      throw new RangeError(`No round price solves these terms: ${parts} would take ${Math.round(claimed * 100)}% of the pre-money valuation. Raise the pre-money valuation${remedy}.`);
    }

    // 5. Reprice. Pre-money shares carry the valuation when the pool and the
    //    conversions come out of the pre-money.
    const preMoneyShares = input.poolFromPreMoney
      ? existingFD + poolIncrease + conversionShares
      : existingFD + conversionShares;
    pps = ppsForAmount(preMoney, Math.max(1, preMoneyShares));
    if (pps < 1) throw new RangeError(priceTooLow);

    if (pps === prevPPS && poolIncrease === prevPool && conversionShares === prevConversions) { converged = true; break; }
  }
  if (!converged) warnings.push('Round pricing did not fully converge; results are approximate.');

  // ---- Allocations ------------------------------------------------------
  const investorAllocations = input.investors.map((inv) => {
    const price = investorPrice(inv, pps);
    const shares = sharesForAmount(inv.amount, price);
    return {
      name: inv.name, stakeholderId: inv.stakeholderId, amount: inv.amount,
      shares, pctPost: pct(shares, postFD), pps: price,
    };
  });

  // Allocate at the returned price, then use exactly those issued shares in
  // every total and percentage (including when quantization prevents convergence).
  newInvestorShares = roundShares(investorAllocations.reduce((s, a) => s + a.shares, 0));
  postFD = roundShares(existingFD + poolIncrease + conversionShares + newInvestorShares);
  for (const a of investorAllocations) a.pctPost = pct(a.shares, postFD);
  const poolAvailableAfter = roundShares(existingPoolAvailable + poolIncrease);

  // ---- Ownership before / after ----------------------------------------
  const sharesAfterByHolder = new Map<string, number>();
  const nameByHolder = new Map<string, string>();
  const groupByHolder = new Map<string, string>();
  for (const r of before.rows) {
    sharesAfterByHolder.set(r.stakeholderId, r.fullyDiluted);
    nameByHolder.set(r.stakeholderId, r.name);
    groupByHolder.set(r.stakeholderId, r.relation);
  }
  for (const c of conversions) {
    sharesAfterByHolder.set(c.stakeholderId, (sharesAfterByHolder.get(c.stakeholderId) ?? 0) + c.shares);
    if (!nameByHolder.has(c.stakeholderId)) {
      nameByHolder.set(c.stakeholderId, data.stakeholders.find((s) => s.id === c.stakeholderId)?.name ?? 'Convertible holder');
      groupByHolder.set(c.stakeholderId, 'INVESTOR');
    }
  }
  for (const a of investorAllocations) {
    const key = a.stakeholderId ?? `new:${a.name}`;
    sharesAfterByHolder.set(key, (sharesAfterByHolder.get(key) ?? 0) + a.shares);
    if (!nameByHolder.has(key)) { nameByHolder.set(key, a.name); groupByHolder.set(key, 'INVESTOR'); }
  }

  const beforeTotal = before.totals.fullyDiluted;
  const ownership: OwnershipDelta[] = [...sharesAfterByHolder.entries()].map(([id, sharesAfter]) => {
    const rowBefore = before.rows.find((r) => r.stakeholderId === id);
    const sharesBefore = rowBefore?.fullyDiluted ?? 0;
    const pctBefore = pct(sharesBefore, beforeTotal);
    const pctAfter = pct(sharesAfter, postFD);
    return {
      stakeholderId: id,
      name: nameByHolder.get(id) ?? 'Unknown',
      group: groupByHolder.get(id) ?? 'OTHER',
      sharesBefore, pctBefore, sharesAfter, pctAfter,
      dilutionPct: pctBefore - pctAfter,
      dilutionRelative: pctBefore > 0 ? (pctBefore - pctAfter) / pctBefore : 0,
      valueAfter: shareValue(sharesAfter, pps),
    };
  });
  if (poolAvailableAfter > 0) {
    const poolBefore = pct(existingPoolAvailable, beforeTotal);
    const poolAfter = pct(poolAvailableAfter, postFD);
    ownership.push({
      stakeholderId: 'pool', name: 'Unallocated option pool', group: 'POOL',
      sharesBefore: existingPoolAvailable, pctBefore: poolBefore,
      sharesAfter: poolAvailableAfter, pctAfter: poolAfter,
      dilutionPct: poolBefore - poolAfter,
      dilutionRelative: poolBefore > 0 ? (poolBefore - poolAfter) / poolBefore : 0,
      valueAfter: shareValue(poolAvailableAfter, pps),
    });
  }
  ownership.sort((a, b) => b.sharesAfter - a.sharesAfter);

  // The unallocated pool is not a holder; leaving it in would understate the
  // dilution people actually suffered because the pool grows in the round.
  const existingHolderPctAfter = ownership
    .filter((o) => o.sharesBefore > 0 && o.stakeholderId !== 'pool')
    .reduce((s, o) => s + o.pctAfter, 0);

  return {
    input,
    pricePerShare: pps,
    preMoney,
    postMoney: preMoney + amountRaised,
    impliedPostMoney: shareValue(postFD, pps),
    amountRaised,
    preRoundFullyDiluted: existingFD,
    postRoundFullyDiluted: postFD,
    newInvestorShares,
    conversionShares,
    poolIncrease,
    poolAvailableAfter,
    poolPctAfter: pct(poolAvailableAfter, postFD),
    conversions,
    investorAllocations,
    ownership,
    existingHolderDilution: ownership.filter((o) => o.sharesBefore > 0 && o.stakeholderId !== 'pool')
      .reduce((s, o) => s + o.pctBefore, 0) - existingHolderPctAfter,
    iterations,
    converged,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Anti-dilution
// ---------------------------------------------------------------------------

export interface AntiDilutionResult {
  shareClassId: string;
  className: string;
  formula: ShareClass['antiDilution'];
  oldConversionPrice: PricePerShare;
  newConversionPrice: PricePerShare;
  oldConversionRatio: number;
  newConversionRatio: number;
  additionalShares: number;
  triggered: boolean;
}

/**
 * Applies anti-dilution protection when a round prices below a prior class's
 * original issue price.
 *
 *  Weighted average: NCP = OCP x (A + B) / (A + C)
 *    A = shares outstanding before the round (broad includes outstanding
 *        options and convertible securities but not the unissued pool,
 *        narrow counts only outstanding shares)
 *    B = shares the new money would have bought at the old price
 *    C = shares actually issued in the new round
 *  Full ratchet: NCP = new round price.
 *
 * NVCA Model COI (Oct 2025) §4.4.4: A is the Common outstanding plus the
 * Common issuable on outstanding Options and Convertible Securities (shares
 * merely reserved under the plan are not issuable on anything outstanding),
 * and the new price is rounded to the nearest one-hundredth of a cent. §4.3
 * issues no fractional shares, so the extra conversion shares are whole, each
 * holder's fraction paid in cash.
 */
export function computeAntiDilution(
  input: CompanyData, result: RoundModelResult,
): AntiDilutionResult[] {
  const asOf = result.input.closeDate;
  const data = normalizeSplits(input, asOf);
  const table = computeCapTable(data, { asOf, includeUnallocatedPool: true });
  const newMoney = result.amountRaised;
  const newShares = result.newInvestorShares;
  const out: AntiDilutionResult[] = [];

  for (const cls of data.shareClasses) {
    if (cls.kind !== 'PREFERRED' || cls.antiDilution === 'NONE') continue;
    if (cls.issueDate > asOf) continue;
    const summary = table.classes.find((c) => c.shareClassId === cls.id);
    if (!summary || summary.outstanding <= 0) continue;

    const oldCP = Math.round(cls.originalIssuePrice / (cls.conversionRatio || 1));
    if (result.pricePerShare >= oldCP) continue; // no down round for this class

    let newCP: PricePerShare;
    if (cls.antiDilution === 'FULL_RATCHET') {
      newCP = result.pricePerShare;
    } else {
      const broad = cls.antiDilution === 'BROAD_WEIGHTED';
      const A = broad
        ? roundShares(table.totals.fullyDiluted - table.totals.poolAvailable)
        : table.totals.asConverted;
      const B = oldCP > 0 ? (newMoney * CENTS_TO_PPS) / oldCP : 0;
      const C = newShares;
      newCP = C + A > 0 ? Math.max(HUNDREDTH_CENT, Math.round((oldCP * (A + B)) / (A + C) / HUNDREDTH_CENT) * HUNDREDTH_CENT) : oldCP;
    }
    if (newCP >= oldCP) continue;

    // §4.3 issues no fractional shares: each holder converts everything they
    // hold at once into whole shares and is paid cash for the fraction (the
    // model's first bracket; the other rounds each holder up instead).
    const newRatio = cls.originalIssuePrice / newCP;
    const held = table.rows.flatMap((r) => r.holdings.filter((h) => h.shareClassId === cls.id).map((h) => h.shares));
    const whole = (ratio: number): number => held.reduce((s, n) => s + floorShares(n * ratio), 0);
    const additional = whole(newRatio) - whole(cls.conversionRatio);
    out.push({
      shareClassId: cls.id, className: cls.name, formula: cls.antiDilution,
      oldConversionPrice: oldCP, newConversionPrice: newCP,
      oldConversionRatio: cls.conversionRatio, newConversionRatio: newRatio,
      additionalShares: Math.max(0, additional), triggered: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convertible-only (bridge) modeling — what the stack looks like with no round
// ---------------------------------------------------------------------------

export function modelConvertibleStack(input: CompanyData, asOf: ISODate) {
  const data = normalizeSplits(input, asOf);
  const table = computeCapTable(data, { asOf });
  const live = data.convertibles.filter((c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf);
  const totalPrincipal = live.reduce((s, c) => s + c.principal, 0);
  const totalWithInterest = live.reduce((s, c) => s + conversionAmount(c, asOf), 0);
  const impliedOwnership = live.map((c) => {
    const amount = conversionAmount(c, asOf);
    const t = resolveMFN(c, data.convertibles, asOf);
    const own = t.instrument === 'SAFE_POST' && t.cap ? amount / t.cap : null;
    return {
      id: c.id, stakeholderId: c.stakeholderId, instrument: c.instrument,
      principal: c.principal, amount, cap: t.cap, discount: t.discount,
      impliedOwnershipPct: own,
      matured: c.maturityDate != null && c.maturityDate <= asOf,
    };
  });
  return {
    count: live.length,
    totalPrincipal,
    totalWithInterest,
    accruedInterest: totalWithInterest - totalPrincipal,
    guaranteedOwnership: impliedOwnership.reduce((s, i) => s + (i.impliedOwnershipPct ?? 0), 0),
    instruments: impliedOwnership,
    fullyDilutedBefore: table.totals.fullyDiluted,
  };
}
