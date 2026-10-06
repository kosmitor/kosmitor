import type {
  CompanyData, Cents, ISODate, Issuance, PricePerShare, ShareClass, Convertible, ParticipationType,
} from './types.ts';
import { MICRO, CENTS } from './types.ts';
import { computeCapTable, awardPosition, awardIsLive } from './captable.ts';
import { conversionAmount, resolveMFN, solvePostMoneySafes } from './convertibles.ts';
import { summarizeVesting } from './vesting.ts';
import { normalizeSplits } from './splits.ts';
import { isTransferIssuance } from './valuation-refresh.ts';
import { roundShares, shareValue, pct, yearsBetween, today, allocate } from './util.ts';

const CENTS_TO_PPS = MICRO / CENTS;
/** A liquidity event has no round price, so discount-based pricing can never be the lower price. */
const NO_ROUND_PRICE: PricePerShare = Number.MAX_SAFE_INTEGER;

export interface WaterfallOptions {
  asOf?: ISODate;
  /** Transaction costs taken off the top (banker, legal). */
  transactionFees?: Cents;
  /** Escrow / holdback withheld from the distributable proceeds. */
  escrowHoldback?: Cents;
  /** Unvested equity accelerates on the change of control. */
  accelerateUnvested?: boolean;
  /**
   * Outstanding notes are repaid as debt ahead of everyone (default). When
   * false they instead take the greater of principal-plus-interest or
   * converting at their cap, the same election a SAFE makes.
   */
  repayNotesAsDebt?: boolean;
  includeUnvestedOptions?: boolean;
  /**
   * Outstanding SAFEs take the greater of a cash-out of the purchase amount or
   * converting at their cap (default). When false they are left out entirely,
   * as if settled separately.
   */
  convertSafes?: boolean;
}

export interface ClassPayout {
  shareClassId: string;
  name: string;
  kind: 'COMMON' | 'PREFERRED' | 'SAFE' | 'NOTE';
  seniority: number;
  shares: number;
  asConvertedShares: number;
  invested: Cents;
  /** Contractual preference or cash-out amount (shares x OIP x multiple + accrued dividends). */
  preferenceClaim: Cents;
  preferencePaid: Cents;
  participation: Cents;
  converted: boolean;
  cappedOut: boolean;
  total: Cents;
  perShare: PricePerShare;
  multiple: number;
  pctOfExit: number;
}

export interface StakeholderPayout {
  stakeholderId: string;
  name: string;
  relation: string;
  fromPreferred: Cents;
  fromCommon: Cents;
  fromOptions: Cents;
  fromWarrants: Cents;
  fromRsus: Cents;
  fromConvertibles: Cents;
  optionExerciseCost: Cents;
  total: Cents;
  invested: Cents;
  multiple: number;
  pctOfExit: number;
  sharesParticipating: number;
}

export interface WaterfallResult {
  exitValue: Cents;
  transactionFees: Cents;
  escrowHoldback: Cents;
  debtRepaid: Cents;
  distributable: Cents;
  /** Residual with no eligible equity claimant (e.g. no issued securities). */
  undistributedProceeds: Cents;
  /** Liquidation preferences paid to preferred classes. */
  totalPreferencesPaid: Cents;
  /** SAFEs and notes that elected a cash-out rather than converting. */
  convertibleCashOut: Cents;
  residualToCommon: Cents;
  perCommonShare: PricePerShare;
  participatingShares: number;
  classPayouts: ClassPayout[];
  stakeholderPayouts: StakeholderPayout[];
  optionsExercised: number;
  optionsUnderwater: number;
  optionExerciseProceeds: Cents;
  warnings: string[];
  iterations: number;
}

/** A claim ahead of common: a preferred class, or a SAFE/note electing between cash-out and conversion. */
interface Claimant {
  id: string;
  name: string;
  kind: 'PREFERRED' | 'SAFE' | 'NOTE';
  seniority: number;
  shares: number;
  asConverted: number;
  invested: Cents;
  claim: Cents;
  participation: ParticipationType;
  /** Total-payout ceiling for capped participation. */
  cap: Cents | null;
  /** What converting is worth when it is a value, not a share count (a discount-only SAFE). */
  liquidityValue: Cents | null;
  shareClassId: string | null;
  convertible: Convertible | null;
}

interface Derivative {
  kind: 'OPTION' | 'WARRANT' | 'RSU';
  stakeholderId: string;
  shares: number;
  strike: PricePerShare;
}

interface Distribution {
  /** The common price at full precision; rounding it before weighting millions of shares moves cents between holders. */
  perShare: PricePerShare;
  participatingShares: number;
  exercising: Set<number>;
  exerciseProceeds: Cents;
  residual: Cents;
  prefPaid: Map<string, Cents>;
  partPaid: Map<string, Cents>;
  capped: Set<string>;
  /** Converted claimants paid a fixed value out of the residual rather than per share. */
  valued: Set<string>;
}

/**
 * The outstanding certificates of a class, each with the date its shares were
 * first issued: a certificate created by a transfer keeps the date of the one
 * it came from, followed through any later transfers.
 */
function classCertificates(data: CompanyData, classId: string, asOf: ISODate): { quantity: number; issueDate: ISODate }[] {
  const byCertificate = new Map<string, Issuance>();
  for (const iss of data.issuances) {
    byCertificate.set(iss.id, iss);
    if (iss.certificateNo) byCertificate.set(iss.certificateNo, iss);
  }
  const originalDate = (iss: Issuance): ISODate => {
    const seen = new Set<string>();
    let cert: Issuance | undefined = iss;
    let date = iss.issueDate;
    while (cert && isTransferIssuance(cert) && !seen.has(cert.id)) {
      seen.add(cert.id);
      cert = byCertificate.get((cert.notes ?? '').replace(/^Transferred from certificate\s*/, '').trim());
      if (cert) date = cert.issueDate;
    }
    return date;
  };
  return data.issuances
    .filter((i) => i.shareClassId === classId && i.status === 'OUTSTANDING' && i.issueDate <= asOf)
    .map((i) => ({ quantity: roundShares(i.quantity), issueDate: originalDate(i) }));
}

/**
 * Accrued (cumulative) dividends owed to a preferred class at exit. They
 * accrue on each share from the day it was issued (NVCA Model COI §1), so a
 * second closing of a series accrues for less time than the first.
 */
function accruedDividends(cls: ShareClass, certificates: { quantity: number; issueDate: ISODate }[], asOf: ISODate): Cents {
  if (cls.dividendType !== 'CUMULATIVE' || cls.dividendRate <= 0) return 0;
  let total = 0;
  for (const { quantity, issueDate } of certificates) {
    const base = shareValue(quantity, cls.originalIssuePrice);
    const years = Math.max(0, yearsBetween(issueDate, asOf));
    total += cls.dividendCompounding
      ? base * (Math.pow(1 + cls.dividendRate, years) - 1)
      : base * cls.dividendRate * years;
  }
  return Math.round(total);
}

/**
 * Distributes the proceeds for one fixed set of conversion elections.
 *
 *  1. Claims pay by seniority; a rank that cannot be covered shares pro-rata.
 *  2. The residual is split per share among common, converted claimants,
 *     participating preferred, and every option or warrant that is in the
 *     money — where "in the money" depends on the resulting price, so that is
 *     solved as a fixed point (it is monotone, so it settles quickly).
 *  3. A capped participating class whose total would exceed its cap is fixed
 *     at the cap and removed from the per-share split, and the split is
 *     recomputed for everyone else — so nothing is lost to the cap.
 *
 * Conserves value exactly: claims + participation + net derivative proceeds
 * equal the distributable amount, up to the per-share rounding that the
 * caller assigns to common.
 */
function distribute(
  claimants: Claimant[], converted: Set<string>, commonShares: number,
  derivatives: Derivative[], distributable: Cents,
): Distribution {
  const prefPaid = new Map<string, Cents>();
  let pot = distributable;
  const ranks = [...new Set(claimants.filter((c) => !converted.has(c.id)).map((c) => c.seniority))]
    .sort((a, b) => b - a);
  for (const rank of ranks) {
    const inRank = claimants.filter((c) => !converted.has(c.id) && c.seniority === rank);
    const claim = inRank.reduce((s, c) => s + c.claim, 0);
    if (claim <= 0) { for (const c of inRank) prefPaid.set(c.id, 0); continue; }
    if (pot >= claim) {
      for (const c of inRank) prefPaid.set(c.id, c.claim);
      pot -= claim;
    } else {
      const parts = allocate(Math.max(0, pot), inRank.map((c) => c.claim));
      inRank.forEach((c, i) => prefPaid.set(c.id, parts[i]));
      pot = 0;
    }
  }
  for (const c of claimants) if (!prefPaid.has(c.id)) prefPaid.set(c.id, 0);
  const residual = Math.max(0, pot);

  // A converted discount-only SAFE takes Purchase Amount / Discount Rate out of
  // the residual whatever the common price, so it is paid before the per-share
  // split rather than counted in it; short of that, it takes what is there.
  // The Safe does not settle that case: no Liquidity Price gives it that much
  // when the residual is smaller, and this engine reads "the greater of" its
  // cash-out and conversion as the whole residual, leaving common nothing until
  // the amount is covered (a decision; computeBreakpoints reports the point).
  const valued = claimants.filter((c) => converted.has(c.id) && c.liquidityValue != null);
  const valuedClaim = valued.reduce((s, c) => s + c.liquidityValue!, 0);
  const valuedParts = valuedClaim <= residual ? valued.map((c) => c.liquidityValue!) : allocate(residual, valued.map((c) => c.liquidityValue!));
  const valuedPaid = new Map(valued.map((c, i) => [c.id, valuedParts[i]]));
  const shareResidual = residual - valuedParts.reduce((s, n) => s + n, 0);

  const eligible = claimants.filter((c) => !valuedPaid.has(c.id) &&
    (converted.has(c.id) || c.participation === 'FULL_PARTICIPATING' || c.participation === 'CAPPED_PARTICIPATING'));
  const capEligible = eligible.filter((c) =>
    !converted.has(c.id) && c.participation === 'CAPPED_PARTICIPATING' && c.cap != null);

  let capped = new Set<string>();
  let perShare: PricePerShare = 0;
  let exercising = new Set<number>();
  let exerciseProceeds: Cents = 0;
  let participatingShares = 0;

  for (let guard = 0; guard < 32; guard++) {
    const fixed = capEligible.filter((c) => capped.has(c.id))
      .reduce((s, c) => s + Math.max(0, c.cap! - prefPaid.get(c.id)!), 0);
    const pool = Math.max(0, shareResidual - fixed);
    const base = commonShares + eligible.filter((c) => !capped.has(c.id)).reduce((s, c) => s + c.asConverted, 0);

    // Which options are in the money depends on the price they help set.
    let active = new Set<number>(derivatives.map((_, i) => i));
    for (let inner = 0; inner < 48; inner++) {
      let dShares = 0, dProceeds = 0;
      derivatives.forEach((d, i) => {
        if (active.has(i)) { dShares += d.shares; dProceeds += shareValue(d.shares, d.strike); }
      });
      const denom = base + dShares;
      const price = denom > 0 ? ((pool + dProceeds) * CENTS_TO_PPS) / denom : 0;
      const next = new Set<number>();
      derivatives.forEach((d, i) => { if (d.strike < price) next.add(i); });
      const same = next.size === active.size && [...next].every((i) => active.has(i));
      perShare = price; exerciseProceeds = dProceeds; participatingShares = denom; exercising = active;
      if (same) break;
      active = next;
    }

    const nextCapped = new Set<string>();
    for (const c of capEligible) {
      if (prefPaid.get(c.id)! + shareValue(c.asConverted, perShare) > c.cap!) nextCapped.add(c.id);
    }
    const stable = nextCapped.size === capped.size && [...nextCapped].every((id) => capped.has(id));
    capped = nextCapped;
    if (stable) break;
  }

  const partPaid = new Map<string, Cents>();
  for (const c of claimants) {
    if (valuedPaid.has(c.id)) partPaid.set(c.id, valuedPaid.get(c.id)!);
    else if (!eligible.includes(c)) partPaid.set(c.id, 0);
    else if (capped.has(c.id)) partPaid.set(c.id, Math.max(0, c.cap! - prefPaid.get(c.id)!));
    else partPaid.set(c.id, shareValue(c.asConverted, perShare));
  }
  return { perShare, participatingShares, exercising, exerciseProceeds, residual, prefPaid, partPaid, capped, valued: new Set(valuedPaid.keys()) };
}

/**
 * Everything about a waterfall that does not depend on the exit value: the cap
 * table, the claimants, the options and warrants, and how the post-money SAFEs'
 * shares move with the elections. Built once, it prices any number of exits.
 */
interface WaterfallSetup {
  data: CompanyData;
  asOf: ISODate;
  classById: Map<string, ShareClass>;
  /** Warnings that hold at every exit value. */
  warnings: string[];
  notes: Convertible[];
  repayNotes: boolean;
  debtClaim: Cents;
  claimants: Claimant[];
  commonClasses: { cls: ShareClass; shares: number; invested: Cents }[];
  commonShares: number;
  derivatives: Derivative[];
  choosers: Claimant[];
  electing: (converted: Set<string>) => Claimant[];
}

function setupWaterfall(input: CompanyData, opts: WaterfallOptions): WaterfallSetup {
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const warnings: string[] = [];
  const table = computeCapTable(data, { asOf, includeUnallocatedPool: false });
  const classById = new Map(data.shareClasses.map((c) => [c.id, c]));
  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  const holderName = (id: string): string => data.stakeholders.find((s) => s.id === id)?.name ?? 'Unknown';

  const repayNotes = opts.repayNotesAsDebt !== false;
  const includeSafes = opts.convertSafes !== false;
  const isNote = (c: Convertible): boolean => c.instrument === 'NOTE' || c.instrument === 'KISS';
  const live = data.convertibles.filter((c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf);
  const notes = live.filter(isNote);
  const safes = live.filter((c) => !isNote(c));
  const debtClaim = repayNotes ? notes.reduce((s, n) => s + conversionAmount(n, asOf), 0) : 0;

  // ---- Claimants: preferred classes -------------------------------------
  const claimants: Claimant[] = [];
  const commonClasses: { cls: ShareClass; shares: number; invested: Cents }[] = [];
  let commonShares = 0;
  for (const summary of table.classes) {
    const cls = classById.get(summary.shareClassId);
    if (!cls || summary.outstanding <= 0) continue;
    if (cls.kind === 'COMMON') {
      commonShares += summary.outstanding;
      commonClasses.push({ cls, shares: summary.outstanding, invested: summary.investedAmount });
      continue;
    }
    const oip = shareValue(summary.outstanding, cls.originalIssuePrice);
    claimants.push({
      id: cls.id, name: cls.name, kind: 'PREFERRED', seniority: cls.seniority,
      shares: summary.outstanding, asConverted: summary.asConverted, invested: summary.investedAmount,
      claim: Math.round(oip * cls.liquidationMultiple) + accruedDividends(cls, classCertificates(data, cls.id, asOf), asOf),
      participation: cls.participation,
      cap: cls.participation === 'CAPPED_PARTICIPATING' && cls.participationCap != null
        ? Math.round(oip * cls.participationCap) : null,
      liquidityValue: null, shareClassId: cls.id, convertible: null,
    });
  }

  // ---- Claimants: SAFEs, and notes not repaid as debt --------------------
  // A SAFE at a liquidity event takes the greater of its purchase amount and
  // the value of converting at the liquidity price (cap over the fully diluted
  // capitalization, excluding the unissued pool). The cash-out ranks alongside the
  // most senior preferred. A post-money SAFE's Liquidity Capitalization leaves out
  // every SAFE taking its cash-out and counts every other security that converts,
  // a pre-money SAFE or a note included (YC post-money safe; Safe User Guide
  // Ex.2 Q3: (9,550,000 + 502,631) / 90%), so its share count depends on which of
  // the others convert; electing() below solves it for each set.
  // An MFN instrument converts as the later instrument it adopts (resolveMFN),
  // chosen among every instrument issued, not only the ones converting here.
  const instruments = [...(includeSafes ? safes : []), ...(repayNotes ? [] : notes)].map((c): Convertible => {
    const t = resolveMFN(c, data.convertibles, asOf);
    return { ...c, valuationCap: t.cap, discount: t.discount, instrument: t.instrument, mfn: false };
  });
  const noteIds = new Set(notes.map((n) => n.id));
  const liquidityCapitalization = table.totals.fullyDiluted;
  const postMoneySafes = instruments.filter((c) => c.instrument === 'SAFE_POST');
  /** A pre-money SAFE or a note converts at its cap over the Liquidity Capitalization, whatever the others do. */
  const fixedShares = new Map(instruments
    .filter((c) => c.instrument !== 'SAFE_POST' && c.valuationCap != null && c.valuationCap > 0)
    .map((c) => [c.id, roundShares((conversionAmount(c, asOf) * liquidityCapitalization) / c.valuationCap!)]));
  /** Shares of the post-money SAFEs in `converting` when exactly those securities convert. */
  const postMoneyShares = (converting: Set<string>): Map<string, number> => solvePostMoneySafes(
    postMoneySafes.filter((c) => converting.has(c.id)),
    liquidityCapitalization + [...fixedShares].reduce((s, [id, n]) => s + (converting.has(id) ? n : 0), 0),
    NO_ROUND_PRICE, asOf,
  ).shares;
  if (instruments.length > 0) {
    const postMoney = postMoneyShares(new Set(instruments.map((c) => c.id)));
    const topRank = Math.max(1, ...claimants.map((c) => c.seniority));
    for (const c of instruments) {
      const amount = conversionAmount(c, asOf);
      const asConverted = c.instrument === 'SAFE_POST' ? postMoney.get(c.id) ?? 0 : fixedShares.get(c.id) ?? 0;
      const name = `${noteIds.has(c.id) ? 'Note' : 'SAFE'} — ${holderName(c.stakeholderId)}`;
      // A discount-only safe converts at a Liquidity Price of the common price
      // times the Discount Rate (YC Postmoney Safe - Discount Only), so its
      // shares are worth Purchase Amount / Discount Rate whatever that price is.
      const liquidityValue = !noteIds.has(c.id) && c.valuationCap == null && c.discount > 0 && c.discount < 1
        ? Math.round(amount / (1 - c.discount)) : null;
      if (asConverted <= 0 && liquidityValue == null) warnings.push(`${name} has no valuation cap, so it is modelled as a cash-out only.`);
      claimants.push({
        id: c.id, name, kind: noteIds.has(c.id) ? 'NOTE' : 'SAFE', seniority: topRank,
        shares: 0, asConverted: liquidityValue == null ? asConverted : 0, invested: c.principal, claim: amount,
        participation: 'NON_PARTICIPATING', cap: null, liquidityValue, shareClassId: null, convertible: c,
      });
    }
  }

  // ---- Derivatives -------------------------------------------------------
  const derivatives: Derivative[] = [];
  for (const a of data.awards) {
    const holder = data.stakeholders.find((s) => s.id === a.stakeholderId);
    if (!awardIsLive(a, asOf, holder?.terminationDate)) continue;
    if (a.type === 'RSA') continue; // already issued shares
    // A leaver's unvested part lapsed at termination, as in the cap table
    // (CAP-4), and accelerating the rest cannot bring it back (VA-1).
    const schedule = scheduleById.get(a.vestingScheduleId);
    const outstanding = awardPosition(a, schedule, holder?.terminationDate, asOf).outstanding;
    if (outstanding <= 0) continue;
    let count = outstanding;
    if (!opts.accelerateUnvested && !opts.includeUnvestedOptions) {
      if (schedule) {
        const v = summarizeVesting({
          schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate,
          terminationDate: holder?.terminationDate ?? null, changeOfControlDate: asOf,
        }, asOf);
        count = Math.max(0, Math.min(outstanding, roundShares(v.vested - a.exercisedQuantity)));
      }
    }
    if (count <= 0) continue;
    const settlesForFree = a.type === 'RSU' || a.type === 'PHANTOM';
    derivatives.push({
      kind: settlesForFree ? 'RSU' : 'OPTION', stakeholderId: a.stakeholderId,
      shares: count, strike: settlesForFree ? 0 : a.strikePrice,
    });
  }
  for (const w of data.warrants) {
    if (w.issueDate > asOf || w.status !== 'OUTSTANDING' || (w.expirationDate && w.expirationDate < asOf)) continue;
    const outstanding = roundShares(w.quantity - w.exercisedQuantity);
    if (outstanding > 0) derivatives.push({ kind: 'WARRANT', stakeholderId: w.stakeholderId, shares: outstanding, strike: w.strikePrice });
  }

  /**
   * The claimants under one set of elections. Each post-money SAFE carries the
   * shares it gets converting alongside the securities in the set: its actual
   * shares when it is in the set, what it would get by joining them when it is not.
   */
  const electing = (converted: Set<string>): Claimant[] => {
    if (postMoneySafes.length === 0 || instruments.length < 2) return claimants;
    const together = postMoneyShares(converted);
    return claimants.map((c) => {
      if (c.convertible?.instrument !== 'SAFE_POST' || c.asConverted <= 0) return c;
      const shares = converted.has(c.id) ? together : postMoneyShares(new Set([...converted, c.id]));
      return { ...c, asConverted: shares.get(c.id) ?? 0 };
    });
  };
  const choosers = claimants.filter((c) => (c.asConverted > 0 || c.liquidityValue != null) &&
    (c.kind !== 'PREFERRED' || classById.get(c.id)?.isConvertible !== false));

  return {
    data, asOf, classById, warnings, notes, repayNotes, debtClaim,
    claimants, commonClasses, commonShares, derivatives, choosers, electing,
  };
}

function assertCents(values: Record<string, number>): void {
  for (const [label, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative integer amount in cents.`);
  }
}

/**
 * Steps 1 and 2 for one exit value: fees off the top, then the debt, then the
 * escrow. Escrow holds back part of the consideration payable to the
 * stockholders (NVCA Model COI §2.3.4), so it comes out after the debt is repaid
 * and can never exceed what the stockholders would receive.
 */
function offTheTop(s: WaterfallSetup, exitValue: Cents, opts: WaterfallOptions) {
  const fees = Math.min(exitValue, opts.transactionFees ?? 0);
  const afterFees = exitValue - fees;
  const debtRepaid = Math.min(afterFees, s.debtClaim);
  const escrow = Math.min(afterFees - debtRepaid, opts.escrowHoldback ?? 0);
  return {
    fees, afterFees, debtRepaid, escrow,
    distributable: Math.max(0, afterFees - debtRepaid - escrow),
    shortfall: afterFees < s.debtClaim || (opts.transactionFees ?? 0) > exitValue,
  };
}

/**
 * Steps 3 and 4: the conversion elections by best response for one
 * distributable amount, and the distribution they settle on.
 */
function settle(s: WaterfallSetup, distributable: Cents): { converted: Set<string>; dist: Distribution; iterations: number; unsettled: boolean } {
  const { choosers, electing, commonShares, derivatives } = s;
  const key = (set: Set<string>): string => [...set].sort().join('|');
  // The search starts with every SAFE and note converting, the way the Safe User
  // Guide works a Liquidity Event (Q3, Q4): each Conversion Amount on the full
  // Liquidity Capitalization, then out go those better off with their cash.
  // Converting safes raise each other's Conversion Amounts, so "all take cash"
  // can hold as well as "these convert"; starting from nobody converting would
  // stop at the first and pay the safes less than the greater of the two.
  // With nothing to distribute every election pays nothing, so none is made: no
  // SAFE is shown converting into $0, and no breakpoint is found at $0.01.
  if (distributable <= 0) {
    const none = new Set<string>();
    return { converted: none, dist: distribute(electing(none), none, commonShares, derivatives, 0), iterations: 0, unsettled: false };
  }
  let converted = new Set<string>(choosers.filter((c) => c.convertible).map((c) => c.id));
  let dist = distribute(electing(converted), converted, commonShares, derivatives, distributable);
  const seen = new Set<string>([key(converted)]);
  let iterations = 0;
  let unsettled = false;
  for (;;) {
    iterations += 1;
    let flipped = false;
    for (const c of choosers) {
      const stay = dist.prefPaid.get(c.id)! + dist.partPaid.get(c.id)!;
      const alt = new Set(converted);
      if (alt.has(c.id)) alt.delete(c.id); else alt.add(c.id);
      const altDist = distribute(electing(alt), alt, commonShares, derivatives, distributable);
      const go = altDist.prefPaid.get(c.id)! + altDist.partPaid.get(c.id)!;
      if (go > stay + 1) { converted = alt; dist = altDist; flipped = true; break; } // more than a cent better
    }
    if (!flipped) break;
    const k = key(converted);
    if (seen.has(k) || iterations >= 64) { unsettled = true; break; }
    seen.add(k);
  }
  return { converted, dist, iterations, unsettled };
}

/**
 * Runs the liquidation waterfall for a given exit value.
 *
 * Order of operations:
 *  1. transaction fees come off the top
 *  2. debt (notes, unless told otherwise) is repaid, then escrow is held back
 *     from what is left for the stockholders
 *  3. claims pay by seniority, pro-rata within a rank — preferred liquidation
 *     preferences, and the cash-out amount of any SAFE or unrepaid note
 *  4. the residual goes per share to common, participating preferred,
 *     anything that converted, and in-the-money options and warrants
 *
 * Every claimant may instead convert to common. Each one is given whichever
 * election pays it more given everyone else's election, re-evaluated until no
 * one wants to change — a best-response search. For a lone non-participating
 * class this reproduces the textbook indifference point (preference divided
 * by ownership); for capped participation it converts exactly when the
 * as-converted value passes the cap, which the naive test misses.
 */
export function computeWaterfall(
  input: CompanyData, exitValue: Cents, opts: WaterfallOptions = {},
): WaterfallResult {
  assertCents({ exitValue, transactionFees: opts.transactionFees ?? 0, escrowHoldback: opts.escrowHoldback ?? 0 });
  const s = setupWaterfall(input, opts);
  const { data, asOf, classById, notes, repayNotes, claimants, commonClasses, commonShares, derivatives, electing } = s;
  const warnings: string[] = [];

  // ---- Steps 1 & 2: off the top -----------------------------------------
  const { fees, afterFees, debtRepaid, escrow, distributable, shortfall } = offTheTop(s, exitValue, opts);
  if (shortfall) warnings.push('Exit proceeds do not cover fees and outstanding debt.');
  warnings.push(...s.warnings);

  // ---- Steps 3 & 4: elections by best response ---------------------------
  const { converted, dist, iterations, unsettled } = settle(s, distributable);
  if (unsettled) {
    warnings.push('Conversion elections did not settle — one class only prefers converting when another does not. Showing the last consistent state.');
  }
  const perShare = dist.perShare;
  const settled = electing(converted);

  // ---- Class payouts -------------------------------------------------------
  const classPayouts: ClassPayout[] = settled.map((c) => {
    const pref = dist.prefPaid.get(c.id)!;
    const part = dist.partPaid.get(c.id)!;
    const total = pref + part;
    const isConverted = converted.has(c.id);
    // A converted discount-only safe holds Purchase Amount / Liquidity Price shares.
    const asConverted = dist.valued.has(c.id) && perShare > 0
      ? Math.floor((c.claim * CENTS_TO_PPS) / (perShare * (1 - c.convertible!.discount)) + 1e-9) : c.asConverted;
    const denominator = c.kind === 'PREFERRED' || isConverted ? asConverted : 0;
    return {
      shareClassId: c.shareClassId ?? c.id, name: c.name, kind: c.kind, seniority: c.seniority,
      shares: c.shares, asConvertedShares: asConverted, invested: c.invested,
      preferenceClaim: c.claim, preferencePaid: pref, participation: part,
      converted: isConverted, cappedOut: dist.capped.has(c.id), total,
      perShare: denominator > 0 ? Math.round((total * CENTS_TO_PPS) / denominator) : 0,
      multiple: c.invested > 0 ? total / c.invested : 0, pctOfExit: pct(total, exitValue),
    };
  });

  let optionsExercised = 0, optionsUnderwater = 0;
  const exercised: { d: Derivative; gross: Cents; cost: Cents }[] = [];
  derivatives.forEach((d, i) => {
    if (!dist.exercising.has(i)) { if (d.kind !== 'RSU') optionsUnderwater += d.shares; return; }
    exercised.push({ d, gross: shareValue(d.shares, perShare), cost: shareValue(d.shares, d.strike) });
    if (d.kind === 'OPTION') optionsExercised += d.shares;
  });
  // Allocate the residual in cents after fixing preferences and capped
  // participation. Rounding a per-share price before multiplying millions of
  // shares must never create dollars or lose them when there is no common.
  const variableClasses = classPayouts.filter((cp) => !dist.valued.has(cp.shareClassId) && (cp.converted ||
    (cp.kind === 'PREFERRED' && !cp.cappedOut && classById.get(cp.shareClassId)?.participation !== 'NON_PARTICIPATING')));
  const fixedTotal = classPayouts.reduce((sum, cp) => sum + cp.preferencePaid +
    (cp.cappedOut || dist.valued.has(cp.shareClassId) ? cp.participation : 0), 0);
  const residualBudget = Math.max(0, distributable - fixedTotal);
  const weights = [commonShares * perShare / CENTS_TO_PPS,
    ...variableClasses.map((cp) => cp.asConvertedShares * perShare / CENTS_TO_PPS),
    ...exercised.map(({ d }) => Math.max(0, d.shares * (perShare - d.strike) / CENTS_TO_PPS))];
  const residualParts = allocate(residualBudget, weights);
  const commonTotal = residualParts[0] ?? 0;
  variableClasses.forEach((cp, i) => {
    cp.participation = residualParts[i + 1];
    cp.total = cp.preferencePaid + cp.participation;
    cp.perShare = cp.asConvertedShares > 0 ? Math.round(cp.total * CENTS_TO_PPS / cp.asConvertedShares) : 0;
    cp.multiple = cp.invested > 0 ? cp.total / cp.invested : 0;
    cp.pctOfExit = pct(cp.total, exitValue);
  });
  exercised.forEach((x, i) => { x.gross = x.cost + residualParts[1 + variableClasses.length + i]; });
  const undistributedProceeds = residualBudget - residualParts.reduce((sum, n) => sum + n, 0);
  if (undistributedProceeds > 0) warnings.push('Some proceeds have no eligible residual claimant and remain undistributed.');
  const commonParts = allocate(commonTotal, commonClasses.map((c) => c.shares));
  commonClasses.forEach((c, i) => classPayouts.push({
    shareClassId: c.cls.id, name: c.cls.name, kind: 'COMMON', seniority: 0,
    shares: c.shares, asConvertedShares: c.shares, invested: c.invested,
    preferenceClaim: 0, preferencePaid: 0, participation: commonParts[i],
    converted: false, cappedOut: false, total: commonParts[i],
    perShare: c.shares > 0 ? Math.round((commonParts[i] * CENTS_TO_PPS) / c.shares) : 0,
    multiple: c.invested > 0 ? commonParts[i] / c.invested : 0, pctOfExit: pct(commonParts[i], exitValue),
  }));
  classPayouts.sort((a, b) => b.seniority - a.seniority || b.total - a.total);

  // ---- Per stakeholder -----------------------------------------------------
  const byHolder = new Map<string, StakeholderPayout>();
  const holderRow = (id: string): StakeholderPayout => {
    let p = byHolder.get(id);
    if (!p) {
      const sh = data.stakeholders.find((s) => s.id === id);
      p = {
        stakeholderId: id, name: sh?.name ?? 'Unknown', relation: sh?.relation ?? 'OTHER',
        fromPreferred: 0, fromCommon: 0, fromOptions: 0, fromWarrants: 0, fromRsus: 0,
        fromConvertibles: 0, optionExerciseCost: 0, total: 0, invested: 0, multiple: 0,
        pctOfExit: 0, sharesParticipating: 0,
      };
      byHolder.set(id, p);
    }
    return p;
  };

  for (const cp of classPayouts) {
    if (cp.kind === 'SAFE' || cp.kind === 'NOTE') continue;
    const cls = classById.get(cp.shareClassId);
    const holders = data.issuances.filter(
      (i) => i.shareClassId === cp.shareClassId && i.status === 'OUTSTANDING' && i.issueDate <= asOf);
    const totalShares = holders.reduce((s, h) => s + h.quantity, 0);
    if (totalShares <= 0 || !cls) continue;
    const parts = allocate(cp.total, holders.map((h) => h.quantity));
    holders.forEach((h, i) => {
      const row = holderRow(h.stakeholderId);
      if (cp.kind === 'PREFERRED') row.fromPreferred += parts[i]; else row.fromCommon += parts[i];
      row.invested += shareValue(h.quantity, h.pricePerShare);
      row.sharesParticipating += cp.kind === 'COMMON' ? h.quantity : roundShares(h.quantity * cls.conversionRatio);
    });
  }
  for (const c of settled) {
    if (c.kind === 'PREFERRED') continue;
    const row = holderRow(c.convertible!.stakeholderId);
    const cp = classPayouts.find((p) => p.shareClassId === c.id)!;
    row.fromConvertibles += cp.total;
    row.invested += c.invested;
    if (converted.has(c.id)) row.sharesParticipating += cp.asConvertedShares;
  }
  for (const { d, gross, cost } of exercised) {
    const row = holderRow(d.stakeholderId);
    const net = Math.max(0, gross - cost);
    row.sharesParticipating += d.shares;
    if (d.kind === 'OPTION') { row.fromOptions += net; row.optionExerciseCost += cost; }
    else if (d.kind === 'WARRANT') { row.fromWarrants += net; row.optionExerciseCost += cost; }
    else row.fromRsus += net;
  }
  if (repayNotes && notes.length > 0) {
    const cover = Math.min(debtRepaid, Math.max(0, afterFees));
    const parts = allocate(cover, notes.map((n) => conversionAmount(n, asOf)));
    notes.forEach((n, i) => {
      const row = holderRow(n.stakeholderId);
      row.fromConvertibles += parts[i];
      row.invested += n.principal;
    });
  }

  const stakeholderPayouts = [...byHolder.values()].map((p) => {
    p.total = p.fromPreferred + p.fromCommon + p.fromOptions + p.fromWarrants + p.fromRsus + p.fromConvertibles;
    p.multiple = p.invested > 0 ? p.total / p.invested : 0;
    p.pctOfExit = pct(p.total, exitValue);
    return p;
  }).sort((a, b) => b.total - a.total);

  return {
    exitValue, transactionFees: fees, escrowHoldback: escrow, debtRepaid, distributable, undistributedProceeds,
    totalPreferencesPaid: claimants.filter((c) => c.kind === 'PREFERRED').reduce((s, c) => s + dist.prefPaid.get(c.id)!, 0),
    convertibleCashOut: claimants.filter((c) => c.kind !== 'PREFERRED').reduce((s, c) => s + dist.prefPaid.get(c.id)!, 0),
    residualToCommon: dist.residual, perCommonShare: Math.round(perShare), participatingShares: dist.participatingShares,
    classPayouts, stakeholderPayouts,
    optionsExercised, optionsUnderwater, optionExerciseProceeds: dist.exerciseProceeds,
    warnings, iterations,
  };
}

// ---------------------------------------------------------------------------
// Breakpoint analysis
// ---------------------------------------------------------------------------

export interface Breakpoint {
  exitValue: Cents;
  label: string;
  kind: 'PREFERENCE' | 'CONVERSION' | 'CAP' | 'STRIKE' | 'ZERO';
  perShareAfter: PricePerShare;
}

/**
 * Finds the exit values at which the distribution changes shape: fees, notes
 * repaid as debt and escrow each covered in turn, each rank's claims filling
 * up, each class or SAFE starting to convert, a converted discount-only SAFE's
 * Purchase Amount / Discount Rate covered, a participation cap starting to
 * bind, and each option strike coming into the money.
 *
 * Each one is found on the waterfall itself, by bisecting to the cent on the
 * engine's own elections, so it sits exactly where computeWaterfall changes
 * course: behind senior preferences and accrued dividends, after a whole rank
 * is paid ratably (NVCA Model COI §2.1), after SAFE cash-outs, fees, debt and
 * escrow, and with unconverted non-participating preferred left out of the
 * option price (§2.2). A participation cap binding and the class converting
 * past it are two breakpoints (Fenwick & West venture terms glossary).
 * Between two consecutive breakpoints every payout is linear in the exit.
 */
export function computeBreakpoints(input: CompanyData, opts: WaterfallOptions = {}): Breakpoint[] {
  assertCents({ transactionFees: opts.transactionFees ?? 0, escrowHoldback: opts.escrowHoldback ?? 0 });
  const s = setupWaterfall(input, opts);
  const { claimants, derivatives, classById } = s;
  const strikes = [...new Set(derivatives.filter((d) => d.strike > 0).map((d) => d.strike))].sort((a, b) => a - b);

  /**
   * Per claimant: its rank paid in full (or it converted), converted, cap
   * binding, and for a converted discount-only SAFE its Purchase Amount /
   * Discount Rate paid in full; per strike: in the money. A rank short of its
   * claims is shared ratably, so it is paid in full all at once, not class by
   * class.
   */
  const PER = 4;
  const sample = (exitValue: Cents): { flags: boolean[]; perShare: PricePerShare } => {
    const { converted, dist } = settle(s, offTheTop(s, exitValue, opts).distributable);
    const rankPaid = new Map<number, boolean>();
    for (const c of claimants) {
      if (!converted.has(c.id)) rankPaid.set(c.seniority, (rankPaid.get(c.seniority) ?? true) && dist.prefPaid.get(c.id)! >= c.claim);
    }
    const flags: boolean[] = [];
    for (const c of claimants) {
      const isConverted = converted.has(c.id);
      flags.push(isConverted || (c.claim > 0 && rankPaid.get(c.seniority) === true), isConverted, dist.capped.has(c.id),
        dist.valued.has(c.id) && dist.partPaid.get(c.id)! >= c.liquidityValue!);
    }
    for (const strike of strikes) flags.push(dist.perShare > strike);
    return { flags, perShare: dist.perShare };
  };
  const breakpointAt = (flag: number, exitValue: Cents, perShare: PricePerShare): Breakpoint => {
    const perShareAfter = Math.round(perShare);
    if (flag >= claimants.length * PER) {
      const strike = strikes[flag - claimants.length * PER];
      const kinds = new Set(derivatives.filter((d) => d.strike === strike).map((d) => d.kind));
      const what = !kinds.has('WARRANT') ? 'Options' : kinds.size > 1 ? 'Options and warrants' : 'Warrants';
      return { exitValue, kind: 'STRIKE', label: `${what} at $${(strike / MICRO).toFixed(4)} come into the money`, perShareAfter };
    }
    const c = claimants[Math.floor(flag / PER)];
    if (flag % PER === 0) {
      return { exitValue, kind: 'PREFERENCE', label: `${c.name} ${c.kind === 'PREFERRED' ? 'preference' : 'cash-out'} fully paid`, perShareAfter };
    }
    if (flag % PER === 1) return { exitValue, kind: 'CONVERSION', label: `${c.name} prefers converting to common`, perShareAfter };
    if (flag % PER === 2) return { exitValue, kind: 'CAP', label: `${c.name} reaches its ${classById.get(c.id)?.participationCap}x participation cap`, perShareAfter };
    return { exitValue, kind: 'PREFERENCE', label: `${c.name} converted value fully paid (purchase amount / discount rate)`, perShareAfter };
  };

  // Past this exit every claim is paid, every class that can gain by converting
  // has, and every option is in the money: the common price is at least
  // (exit - all claims and charges) / every share that could share it, so a
  // class converts by its claim or cap x shares / its fewest as-converted shares.
  const charges = (opts.transactionFees ?? 0) + (opts.escrowHoldback ?? 0) + s.debtClaim
    + claimants.reduce((t, c) => t + Math.max(c.claim, c.cap ?? 0, c.liquidityValue ?? 0), 0);
  const everyShare = s.commonShares + claimants.reduce((t, c) => t + c.asConverted, 0) + derivatives.reduce((t, d) => t + d.shares, 0);
  const reach = s.electing(new Set()).reduce((most, c) => c.asConverted > 0 && c.participation !== 'FULL_PARTICIPATING'
    ? Math.max(most, (Math.max(c.claim, c.cap ?? 0) * everyShare) / c.asConverted) : most, 0);
  const maxExit = Math.min(Number.MAX_SAFE_INTEGER,
    Math.ceil((charges + reach + ((strikes.at(-1) ?? 0) * everyShare) / CENTS_TO_PPS) * 1.01) + 100);

  // Bisect every stretch whose two ends differ down to a single cent; a flag
  // that turns on at the upper cent is a breakpoint there. Below the first
  // exit nothing is paid in full, converted, capped or in the money.
  const out: Breakpoint[] = [];
  const search = (lo: Cents, a: ReturnType<typeof sample>, hi: Cents, b: ReturnType<typeof sample>): void => {
    if (a.flags.every((f, i) => f === b.flags[i])) return;
    if (hi - lo <= 1) {
      b.flags.forEach((f, i) => { if (f && !a.flags[i]) out.push(breakpointAt(i, hi, b.perShare)); });
      return;
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    const m = sample(mid);
    search(lo, a, mid, m);
    search(mid, m, hi, b);
  };
  const GRID = 32;
  let lo = 0;
  let a = { flags: new Array<boolean>(claimants.length * PER + strikes.length).fill(false), perShare: 0 };
  for (let k = 1; k <= GRID; k++) {
    const hi = Math.round((maxExit * k) / GRID);
    const b = sample(hi);
    search(lo, a, hi, b);
    lo = hi; a = b;
  }

  // Off the top, in order: fees, then the notes repaid as debt, then the
  // escrow. Each one filling up changes what the next exit dollar does, and
  // stockholders are paid nothing until all three are covered.
  const fees = opts.transactionFees ?? 0, escrow = opts.escrowHoldback ?? 0, debt = s.debtClaim;
  if (fees > 0 && debt > 0) out.push({ exitValue: fees, kind: 'ZERO', label: 'Transaction fees paid: the notes start to be repaid', perShareAfter: 0 });
  if (debt > 0 && escrow > 0) out.push({ exitValue: fees + debt, kind: 'ZERO', label: 'Notes repaid in full: the escrow starts to fill', perShareAfter: 0 });
  if (fees + debt + escrow > 0) {
    const once = [fees > 0 && 'the transaction fees are paid', debt > 0 && 'the notes are repaid', escrow > 0 && 'the escrow is held back'].filter(Boolean) as string[];
    const list = once.length > 1 ? `${once.slice(0, -1).join(', ')} and ${once.at(-1)}` : once[0];
    out.push({ exitValue: fees + debt + escrow, kind: 'ZERO', label: `Stockholders start to be paid once ${list}`, perShareAfter: 0 });
  }
  // What holds from the first cent stockholders receive is where the payouts
  // start, not a change of shape: a SAFE whose cash-out and conversion both
  // take everything there is converts from that cent, the way the Safe User
  // Guide starts every SAFE converting.
  const first = fees + debt + escrow + 1;
  return out.filter((b) => b.kind === 'ZERO' || b.exitValue > first).sort((x, y) => x.exitValue - y.exitValue);
}

/** Payout curve across a range of exit values — powers the scenario chart. */
export function waterfallCurve(
  data: CompanyData, maxExit: Cents, points = 40, opts: WaterfallOptions = {},
): { exitValue: Cents; perCommonShare: PricePerShare; byClass: Record<string, Cents>; byGroup: Record<string, Cents> }[] {
  const out = [];
  for (let i = 1; i <= points; i++) {
    const exitValue = Math.round((maxExit * i) / points);
    const w = computeWaterfall(data, exitValue, opts);
    // Classes are keyed by name for the chart, and two can share one (a holder's
    // two SAFEs): they are added together so no payout drops out of the chart.
    const byClass: Record<string, Cents> = {};
    for (const c of w.classPayouts) byClass[c.name] = (byClass[c.name] ?? 0) + c.total;
    const byGroup: Record<string, Cents> = {};
    for (const s of w.stakeholderPayouts) byGroup[s.relation] = (byGroup[s.relation] ?? 0) + s.total;
    out.push({ exitValue, perCommonShare: w.perCommonShare, byClass, byGroup });
  }
  return out;
}

/** What one stakeholder nets across a range of exit values. */
export function stakeholderExitCurve(
  data: CompanyData, stakeholderId: string, maxExit: Cents, points = 30, opts: WaterfallOptions = {},
): { exitValue: Cents; payout: Cents; multiple: number }[] {
  const out = [];
  for (let i = 1; i <= points; i++) {
    const exitValue = Math.round((maxExit * i) / points);
    const w = computeWaterfall(data, exitValue, opts);
    const row = w.stakeholderPayouts.find((s) => s.stakeholderId === stakeholderId);
    out.push({ exitValue, payout: row?.total ?? 0, multiple: row?.multiple ?? 0 });
  }
  return out;
}
