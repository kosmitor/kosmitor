import type {
  CompanyData, ISODate, Cents, PricePerShare, Award, Stakeholder, Valuation, VestingSchedule, Issuance, Convertible,
} from './types.ts';
import { summarizeVesting } from './vesting.ts';
import { normalizeSplits } from './splits.ts';
import { conversionAmount, resolveMFNs, solvePostMoneySafes, termsOf, type ConversionTerms } from './convertibles.ts';
import { isTransferIssuance } from './valuation-refresh.ts';
import { roundShares, floorShares, pct, shareValue, sharesForAmount, today, onOrBefore, addMonths } from './util.ts';
import { enginePolicy } from './policy.ts';

export type CapTableView = 'OUTSTANDING' | 'FULLY_DILUTED' | 'AS_CONVERTED' | 'VOTING';

export interface Holding {
  shareClassId: string;
  className: string;
  kind: 'COMMON' | 'PREFERRED';
  shares: number;
  asConverted: number;
  votes: number;
  investedAmount: Cents;
}

export interface CapTableRow {
  stakeholderId: string;
  name: string;
  relation: Stakeholder['relation'];
  type: Stakeholder['type'];
  holdings: Holding[];
  /** Issued and outstanding shares (certificates only). */
  outstanding: number;
  /** Outstanding with preferred converted to common. */
  asConverted: number;
  optionsVested: number;
  optionsUnvested: number;
  optionsOutstanding: number;
  optionsExercised: number;
  rsusOutstanding: number;
  warrantsOutstanding: number;
  /** Shares this holder would receive if their convertibles converted today. */
  convertibleAsConverted: number;
  convertiblePrincipal: Cents;
  fullyDiluted: number;
  votes: number;
  outstandingPct: number;
  asConvertedPct: number;
  fullyDilutedPct: number;
  votingPct: number;
  investedAmount: Cents;
  currentValue: Cents;
}

export interface ClassSummary {
  shareClassId: string;
  name: string;
  kind: 'COMMON' | 'PREFERRED';
  authorized: number;
  outstanding: number;
  asConverted: number;
  /**
   * Unissued shares the class must keep for others: grants and the unallocated
   * reserve of plans in it, warrants for it and, for common, what outstanding
   * convertible preferred and warrants for preferred convert into.
   */
  reserved: number;
  /** Authorized less outstanding and reserved; negative when the charter is short. */
  available: number;
  holders: number;
  investedAmount: Cents;
  pricePerShare: PricePerShare;
  liquidationPreference: Cents;
  ownershipPct: number;
}

export interface PoolSummary {
  poolId: string;
  name: string;
  authorized: number;
  granted: number;
  exercised: number;
  cancelledReturned: number;
  available: number;
  utilizationPct: number;
}

export interface CapTableTotals {
  outstanding: number;
  asConverted: number;
  optionsOutstanding: number;
  optionsVested: number;
  optionsUnvested: number;
  rsusOutstanding: number;
  warrantsOutstanding: number;
  poolAvailable: number;
  convertibleAsConverted: number;
  fullyDiluted: number;
  votes: number;
  authorized: number;
  investedAmount: Cents;
  valuationPPS: PricePerShare;
  /**
   * Fully diluted shares at valuationPPS: the equity value the price implies.
   * It is not the sum of the rows' currentValue, which counts options and
   * warrants at their spread and leaves the unallocated pool out.
   */
  companyValue: Cents;
}

/**
 * The price behind the estimate for convertibles with no cap. A safe's discount
 * applies to the price of the preferred sold in the next round, which is not
 * known yet, so the estimate assumes the price the table values common at. The
 * UI says which price that was.
 */
export interface ConversionPriceAssumption {
  pricePerShare: PricePerShare;
  /** GIVEN when the caller set valuationPPS, otherwise the type of the valuation it came from. */
  source: 'GIVEN' | Valuation['type'];
  /** The valuation's effective date; null when GIVEN. */
  effectiveDate: ISODate | null;
  /** The convertibles estimated at this price less their discount. */
  convertibleIds: string[];
}

export interface CapTable {
  asOf: ISODate;
  rows: CapTableRow[];
  classes: ClassSummary[];
  pools: PoolSummary[];
  totals: CapTableTotals;
  /** Set when convertibles are included and at least one has no cap; see ConversionPriceAssumption. */
  uncappedConversionPrice: ConversionPriceAssumption | null;
  /** The terms each outstanding MFN instrument is estimated on, when convertibles are included (resolveMFNs). */
  mfnTerms: Record<string, ConversionTerms>;
  /** Warnings the UI surfaces, e.g. over-issuance against authorized shares. */
  warnings: string[];
}

export interface CapTableOptions {
  asOf?: ISODate;
  /** Include estimated share counts for outstanding SAFEs/notes. */
  includeConvertibles?: boolean;
  /** Include the unallocated option pool in fully diluted. */
  includeUnallocatedPool?: boolean;
  /** Price used to value holdings; defaults to the active 409A. */
  valuationPPS?: PricePerShare;
  /** Roll fund entities up into a single line. */
  groupEntities?: boolean;
}

/** The valuation common is priced at: the latest 409A, or failing one the latest valuation of any kind. */
function activeValuationRecord(input: CompanyData, asOf: ISODate): Valuation | null {
  const data = normalizeSplits(input, asOf);
  const candidates = data.valuations
    .filter((v) => v.effectiveDate <= asOf && v.status !== 'DRAFT')
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return candidates.find((v) => v.type === '409A') ?? candidates[0] ?? null;
}

export function activeValuation(input: CompanyData, asOf: ISODate): PricePerShare {
  // A quoted price, which callers store (an exercise's fair market value), so a
  // whole micro-cent even when a split leaves the adjusted price a fraction.
  return Math.round(activeValuationRecord(input, asOf)?.fairMarketValue ?? 0);
}

/** Shares outstanding under an award (granted less exercised and cancelled). */
/** Grants that are not yet issued — drafted, awaiting the board, or awaiting signatures — count for nothing. */
export const PENDING_AWARD = new Set<string>(['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE']);

export function awardOutstanding(a: Award): number {
  return Math.max(0, roundShares(a.quantity - a.exercisedQuantity - a.cancelledQuantity));
}

/**
 * Contractual option rights, including the post-termination exercise window.
 * An award that records no window gets the policy's postTerminationExerciseMonths;
 * a recorded 0 is a window that closes on the day the holder leaves.
 */
export function awardIsLive(a: Award, asOf: ISODate, terminationDate: ISODate | null = null): boolean {
  if (a.status !== 'OUTSTANDING' || a.grantDate > asOf) return false;
  if (a.expirationDate && a.expirationDate < asOf) return false;
  if ((a.type === 'ISO' || a.type === 'NSO') && terminationDate &&
      asOf > addMonths(terminationDate, a.ptepMonths ?? enginePolicy().postTerminationExerciseMonths)) return false;
  return true;
}

/**
 * A live award's outstanding quantity as of a date, split into vested and
 * unvested. Once the holder has left, the part unvested on the termination date
 * has lapsed and is no longer outstanding: "Unvested shares are returned to the
 * equity pool" (Carta, How to terminate stakeholders). The vested part stays
 * until awardIsLive says the exercise window has closed. Restricted stock is
 * issued shares, taken back by a repurchase, so it does not lapse here.
 */
export function awardPosition(
  a: Award, schedule: VestingSchedule | null | undefined, terminationDate: ISODate | null | undefined, asOf: ISODate,
): { outstanding: number; vested: number; unvested: number } {
  let outstanding = awardOutstanding(a);
  let vested = outstanding;
  if (schedule) {
    const summary = summarizeVesting({
      schedule,
      totalQuantity: a.quantity,
      vestingStartDate: a.vestingStartDate,
      terminationDate: terminationDate ?? null,
    }, asOf);
    vested = Math.max(0, Math.min(outstanding, roundShares(summary.vested - a.exercisedQuantity)));
  }
  if (terminationDate && terminationDate <= asOf && a.type !== 'RSA') outstanding = vested;
  return { outstanding, vested, unvested: Math.max(0, roundShares(outstanding - vested)) };
}

/**
 * The price per share the company was paid for a certificate's shares, or null
 * when it cannot be traced. A transfer moves shares between holders and raises
 * nothing (OCF StockTransfer), so the certificate it creates is traced back to
 * the one it came from, through any later transfers, and takes that price, not
 * the one the buyer paid. The transfer route names the source in the notes.
 *
 * A certificate issued on an exercise was paid the grant's strike. After a
 * split the exercise records that strike rounded to the micro-cent, which
 * would shave the aggregate exercise price (26 CFR 1.424-1(e)(4)(v); math
 * audit CAP-3), so it takes the grant's exact split-adjusted strike when the
 * two agree to the micro-cent.
 */
function paidInPrice(iss: Issuance, byCertificate: Map<string, Issuance>, awardById: Map<string, Award>): PricePerShare | null {
  const seen = new Set<string>();
  let cert: Issuance | undefined = iss;
  while (cert && isTransferIssuance(cert)) {
    if (seen.has(cert.id)) return null;
    seen.add(cert.id);
    cert = byCertificate.get((cert.notes ?? '').replace(/^Transferred from certificate\s*/, '').trim());
  }
  if (!cert) return null;
  const award = cert.sourceAwardId ? awardById.get(cert.sourceAwardId) : undefined;
  return award && Math.abs(award.strikePrice - cert.pricePerShare) < 1 ? award.strikePrice : cert.pricePerShare;
}

export function computePoolSummaries(input: CompanyData, asOf: ISODate): PoolSummary[] {
  const data = normalizeSplits(input, asOf);
  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  return data.pools.filter((p) => !p.boardApprovalDate || p.boardApprovalDate <= asOf).map((pool) => {
    const adjustments = data.poolAdjustments
      .filter((p) => p.poolId === pool.id && p.date <= asOf)
      .reduce((sum, p) => sum + p.amount, 0);
    const authorized = pool.authorized + adjustments;

    const awards = data.awards.filter((a) => a.poolId === pool.id && a.grantDate <= asOf);
    let granted = 0, exercised = 0, cancelledReturned = 0;
    for (const a of awards) {
      if (PENDING_AWARD.has(a.status)) continue;
      granted += a.quantity;
      exercised += a.exercisedQuantity;
      if (pool.returnForfeituresToPool) {
        const holder = data.stakeholders.find((h) => h.id === a.stakeholderId);
        const live = a.status === 'OUTSTANDING' && awardIsLive(a, asOf, holder?.terminationDate);
        const lapsed = ['CANCELLED', 'FORFEITED', 'EXPIRED'].includes(a.status) || (a.status === 'OUTSTANDING' && !live);
        // A leaver's unvested part comes back on the termination date (awardPosition).
        const forfeited = live && holder?.terminationDate && holder.terminationDate <= asOf
          ? awardOutstanding(a) - awardPosition(a, scheduleById.get(a.vestingScheduleId), holder.terminationDate, asOf).outstanding
          : 0;
        cancelledReturned += lapsed ? Math.max(0, a.quantity - a.exercisedQuantity) : a.cancelledQuantity + forfeited;
      }
    }
    const available = roundShares(authorized - granted + cancelledReturned);
    return {
      poolId: pool.id,
      name: pool.name,
      authorized,
      granted: roundShares(granted),
      exercised: roundShares(exercised),
      cancelledReturned: roundShares(cancelledReturned),
      available,
      utilizationPct: pct(granted - cancelledReturned, authorized),
    };
  });
}

/**
 * Builds the complete capitalization table as of a date.
 *
 * Fully diluted = outstanding shares + outstanding options + RSUs + warrants
 *               + unallocated pool (optional) + as-converted convertibles (optional).
 */
export function computeCapTable(input: CompanyData, opts: CapTableOptions = {}): CapTable {
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const includePool = opts.includeUnallocatedPool ?? true;
  const includeConv = opts.includeConvertibles ?? false;
  const warnings: string[] = [];
  const valuation = opts.valuationPPS != null ? null : activeValuationRecord(data, asOf);
  const valuationPPS = opts.valuationPPS ?? activeValuation(data, asOf);

  const classById = new Map(data.shareClasses.map((c) => [c.id, c]));
  const rowById = new Map<string, CapTableRow>();

  const stakeholderKey = (id: string): string => {
    if (!opts.groupEntities) return id;
    const sh = data.stakeholders.find((s) => s.id === id);
    return sh?.entityGroupId ?? id;
  };

  const rowFor = (stakeholderId: string): CapTableRow => {
    const key = stakeholderKey(stakeholderId);
    let row = rowById.get(key);
    if (!row) {
      const sh = data.stakeholders.find((s) => s.id === key)
        ?? data.stakeholders.find((s) => s.id === stakeholderId);
      row = {
        stakeholderId: key,
        name: sh?.name ?? 'Unknown holder',
        relation: sh?.relation ?? 'OTHER',
        type: sh?.type ?? 'INDIVIDUAL',
        holdings: [], outstanding: 0, asConverted: 0,
        optionsVested: 0, optionsUnvested: 0, optionsOutstanding: 0, optionsExercised: 0,
        rsusOutstanding: 0, warrantsOutstanding: 0,
        convertibleAsConverted: 0, convertiblePrincipal: 0,
        fullyDiluted: 0, votes: 0,
        outstandingPct: 0, asConvertedPct: 0, fullyDilutedPct: 0, votingPct: 0,
        investedAmount: 0, currentValue: 0,
      };
      rowById.set(key, row);
    }
    return row;
  };

  // ---- Issued shares ----------------------------------------------------
  const classOutstanding = new Map<string, number>();
  const classAsConverted = new Map<string, number>();
  const classInvested = new Map<string, Cents>();
  const classHolders = new Map<string, Set<string>>();
  const byCertificate = new Map<string, Issuance>();
  for (const iss of data.issuances) {
    byCertificate.set(iss.id, iss);
    if (iss.certificateNo) byCertificate.set(iss.certificateNo, iss);
  }
  const awardById = new Map(data.awards.map((a) => [a.id, a]));

  for (const iss of data.issuances) {
    if (iss.issueDate > asOf) continue;
    if (iss.status !== 'OUTSTANDING') continue;
    const cls = classById.get(iss.shareClassId);
    if (!cls) { warnings.push(`Issuance ${iss.id} references an unknown share class.`); continue; }

    const shares = roundShares(iss.quantity);
    const converted = cls.kind === 'PREFERRED' ? roundShares(shares * cls.conversionRatio) : shares;
    const votes = converted * cls.votesPerShare;
    const paid = paidInPrice(iss, byCertificate, awardById);
    if (paid == null) {
      warnings.push(`Certificate ${iss.certificateNo ?? iss.id} was transferred from a certificate that is not on record, so the capital paid for its shares is not counted.`);
    }
    const invested = shareValue(iss.quantity, paid ?? 0);

    const row = rowFor(iss.stakeholderId);
    let holding = row.holdings.find((h) => h.shareClassId === cls.id);
    if (!holding) {
      holding = { shareClassId: cls.id, className: cls.name, kind: cls.kind, shares: 0, asConverted: 0, votes: 0, investedAmount: 0 };
      row.holdings.push(holding);
    }
    holding.shares = roundShares(holding.shares + shares);
    holding.asConverted = roundShares(holding.asConverted + converted);
    holding.votes = roundShares(holding.votes + votes);
    holding.investedAmount += invested;

    row.outstanding = roundShares(row.outstanding + shares);
    row.asConverted = roundShares(row.asConverted + converted);
    row.votes = roundShares(row.votes + votes);
    row.investedAmount += invested;

    classOutstanding.set(cls.id, roundShares((classOutstanding.get(cls.id) ?? 0) + shares));
    classAsConverted.set(cls.id, roundShares((classAsConverted.get(cls.id) ?? 0) + converted));
    classInvested.set(cls.id, (classInvested.get(cls.id) ?? 0) + invested);
    if (!classHolders.has(cls.id)) classHolders.set(cls.id, new Set());
    classHolders.get(cls.id)!.add(iss.stakeholderId);
  }
  // Preferred votes as the whole shares of common it converts into, counted over
  // everything the holder has: NVCA model charter §3.1 (e.g. Navan S-1 Ex.3.1).
  for (const row of rowById.values()) {
    const preferred = row.holdings.filter((h) => h.kind === 'PREFERRED');
    const fractional = preferred.reduce((s, h) => s + h.votes, 0);
    for (const h of preferred) h.votes = floorShares(h.votes);
    row.votes = roundShares(row.votes - fractional + floorShares(fractional));
  }

  // ---- Awards -----------------------------------------------------------
  // Each class keeps unissued shares for what can still be issued in it: the
  // grants and unallocated reserve of plans in it, warrants for it and, in
  // common, what preferred converts into. NVCA model certificate of
  // incorporation, "Reservation of Stock Issuable Upon Conversion".
  const reserved = new Map<string, number>();
  const reserve = (classId: string | null | undefined, n: number): void => {
    if (classId && n > 0) reserved.set(classId, roundShares((reserved.get(classId) ?? 0) + n));
  };
  const commonId = data.shareClasses.find((c) => c.kind === 'COMMON')?.id ?? null;
  const poolClass = new Map(data.pools.map((p) => [p.id, p.shareClassId]));

  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  for (const award of data.awards) {
    // An exercise stays an exercise whatever became of the rest of the grant.
    if (award.exercisedQuantity > 0 && award.grantDate <= asOf && !PENDING_AWARD.has(award.status)) {
      const row = rowFor(award.stakeholderId);
      row.optionsExercised = roundShares(row.optionsExercised + award.exercisedQuantity);
    }
    const holder = data.stakeholders.find((s) => s.id === award.stakeholderId);
    if (!awardIsLive(award, asOf, holder?.terminationDate)) continue;
    const row = rowFor(award.stakeholderId);
    const { outstanding, vested, unvested } =
      awardPosition(award, scheduleById.get(award.vestingScheduleId), holder?.terminationDate, asOf);
    if (outstanding <= 0) continue;

    if (award.type === 'RSU' || award.type === 'PHANTOM') {
      row.rsusOutstanding = roundShares(row.rsusOutstanding + outstanding);
    } else if (award.type === 'RSA') {
      // RSAs are issued shares — already counted through their issuance record.
    } else {
      row.optionsOutstanding = roundShares(row.optionsOutstanding + outstanding);
      row.optionsVested = roundShares(row.optionsVested + vested);
      row.optionsUnvested = roundShares(row.optionsUnvested + unvested);
      // An option is worth its spread, the share price less the strike, and
      // nothing when underwater: intrinsic value (ASC 718; Deloitte Roadmap 4.1).
      if (valuationPPS > award.strikePrice) row.currentValue += shareValue(outstanding, valuationPPS - award.strikePrice);
    }
    if (award.type !== 'RSA') reserve(poolClass.get(award.poolId) ?? commonId, outstanding);
  }

  // ---- Warrants ---------------------------------------------------------
  for (const w of data.warrants) {
    if (w.issueDate > asOf || w.status !== 'OUTSTANDING' || (w.expirationDate && w.expirationDate < asOf)) continue;
    const outstanding = roundShares(w.quantity - w.exercisedQuantity);
    if (outstanding <= 0) continue;
    // A warrant for preferred counts as the common it converts into, as issued
    // preferred does (YC Post-Money Safe User Guide, "Company Capitalization").
    const cls = classById.get(w.shareClassId);
    const converted = cls?.kind === 'PREFERRED' ? roundShares(outstanding * cls.conversionRatio) : outstanding;
    const row = rowFor(w.stakeholderId);
    row.warrantsOutstanding = roundShares(row.warrantsOutstanding + converted);
    row.currentValue += Math.max(0, shareValue(converted, valuationPPS) - shareValue(outstanding, w.strikePrice));
    reserve(w.shareClassId, outstanding);
    if (cls?.kind === 'PREFERRED' && cls.isConvertible) reserve(commonId, converted);
  }

  // ---- Convertibles (as-converted estimate) ------------------------------
  // Pre-money instruments price at their cap against the current fully diluted
  // base; uncapped ones at their discount to the price common is valued at.
  // Post-money SAFEs are then solved together: each owns principal / cap of a
  // capitalization that includes the others and every other converting
  // security (YC Post-Money Safe User Guide §C.1, Appendix II Example 2).
  let uncappedConversionPrice: ConversionPriceAssumption | null = null;
  const mfnTerms: Record<string, ConversionTerms> = {};
  const liveConvertibles = data.convertibles.filter((c) => c.issueDate <= asOf && c.status === 'OUTSTANDING');
  for (const c of liveConvertibles) rowFor(c.stakeholderId).convertiblePrincipal += c.principal;
  if (includeConv && liveConvertibles.length > 0) {
    // That capitalization includes the unissued pool whether or not the table
    // shows it (guide §C.1), so the toggle cannot change an estimate.
    const base = sumFullyDiluted(rowById, data, asOf);
    // An MFN holder that adopts a later instrument's terms becomes that
    // instrument, base and all (YC Safe User Guide App. I.3), so each one is
    // estimated or solved by the terms it ends up with: those that give it the
    // most shares here (resolveMFNs).
    const estimate = (terms: Map<string, ConversionTerms>) => {
      const postMoneyCapped = (c: Convertible): boolean => { const t = termsOf(c, terms); return t.instrument === 'SAFE_POST' && t.cap != null; };
      const shares = new Map<string, number>();
      const uncapped: string[] = [];
      for (const c of liveConvertibles) {
        if (postMoneyCapped(c)) continue;
        const { cap, discount } = termsOf(c, terms);
        const amount = conversionAmount(c, asOf);
        let n = 0;
        if (cap && base > 0) n = (amount * base) / cap;
        else if (valuationPPS > 0) {
          n = sharesForAmount(amount, Math.max(1, Math.round(valuationPPS * (1 - discount))), true);
          uncapped.push(c.id);
        }
        shares.set(c.id, n);
      }
      const others = [...shares.values()].reduce((s, n) => s + n, 0);
      // There is no round price to cap the conversion price here, so the solver is
      // given an unreachable one and capped instruments price at their cap alone.
      const postMoney = solvePostMoneySafes(
        liveConvertibles.filter(postMoneyCapped), base + others, Number.MAX_SAFE_INTEGER, asOf, terms,
      ).shares;
      for (const [id, n] of postMoney) shares.set(id, n);
      return { shares, uncapped };
    };
    // An uncapped estimate at the price common is valued at is the table's
    // assumption, not a conversion the terms give, so it counts for nothing here.
    const terms = resolveMFNs(liveConvertibles, data.convertibles, asOf, (id, t) => {
      const e = estimate(t);
      return e.uncapped.includes(id) ? 0 : e.shares.get(id) ?? 0;
    });
    const { shares, uncapped } = estimate(terms);
    if (uncapped.length) {
      uncappedConversionPrice = {
        pricePerShare: valuationPPS, source: valuation?.type ?? 'GIVEN',
        effectiveDate: valuation?.effectiveDate ?? null, convertibleIds: uncapped,
      };
    }
    for (const c of liveConvertibles) {
      if (c.mfn) mfnTerms[c.id] = termsOf(c, terms);
      const row = rowFor(c.stakeholderId);
      row.convertibleAsConverted = roundShares(row.convertibleAsConverted + (shares.get(c.id) ?? 0));
    }
  }

  // ---- Pools ------------------------------------------------------------
  const pools = computePoolSummaries(data, asOf);
  const poolAvailable = includePool ? pools.reduce((s, p) => s + Math.max(0, p.available), 0) : 0;
  for (const p of pools) {
    if (p.available < 0) warnings.push(`Pool "${p.name}" is over-allocated by ${Math.abs(p.available).toLocaleString('en-US')} shares.`);
    reserve(poolClass.get(p.poolId), Math.max(0, p.available));
  }

  // ---- Totals -----------------------------------------------------------
  const rows = [...rowById.values()];
  const totals: CapTableTotals = {
    outstanding: sum(rows, (r) => r.outstanding),
    asConverted: sum(rows, (r) => r.asConverted),
    optionsOutstanding: sum(rows, (r) => r.optionsOutstanding),
    optionsVested: sum(rows, (r) => r.optionsVested),
    optionsUnvested: sum(rows, (r) => r.optionsUnvested),
    rsusOutstanding: sum(rows, (r) => r.rsusOutstanding),
    warrantsOutstanding: sum(rows, (r) => r.warrantsOutstanding),
    convertibleAsConverted: sum(rows, (r) => r.convertibleAsConverted),
    poolAvailable,
    fullyDiluted: 0,
    votes: sum(rows, (r) => r.votes),
    authorized: data.shareClasses.reduce((s, c) => s + c.authorized, 0),
    investedAmount: sum(rows, (r) => r.investedAmount),
    valuationPPS,
    companyValue: 0,
  };
  totals.fullyDiluted = roundShares(
    totals.asConverted + totals.optionsOutstanding + totals.rsusOutstanding +
    totals.warrantsOutstanding + totals.poolAvailable + totals.convertibleAsConverted,
  );
  totals.companyValue = shareValue(totals.fullyDiluted, totals.valuationPPS);

  for (const r of rows) {
    r.fullyDiluted = roundShares(
      r.asConverted + r.optionsOutstanding + r.rsusOutstanding + r.warrantsOutstanding + r.convertibleAsConverted,
    );
    r.outstandingPct = pct(r.outstanding, totals.outstanding);
    r.asConvertedPct = pct(r.asConverted, totals.asConverted);
    r.fullyDilutedPct = pct(r.fullyDiluted, totals.fullyDiluted);
    r.votingPct = pct(r.votes, totals.votes);
    // Options and warrants were valued above at their spread.
    r.currentValue += shareValue(r.asConverted + r.rsusOutstanding + r.convertibleAsConverted, totals.valuationPPS);
  }
  rows.sort((a, b) => b.fullyDiluted - a.fullyDiluted || a.name.localeCompare(b.name));

  // ---- Class summaries --------------------------------------------------
  for (const c of data.shareClasses) {
    if (c.kind === 'PREFERRED' && c.isConvertible) reserve(commonId, classAsConverted.get(c.id) ?? 0);
  }
  const classes: ClassSummary[] = data.shareClasses
    .filter((c) => c.issueDate <= asOf)
    .map((c) => {
      const outstanding = classOutstanding.get(c.id) ?? 0;
      const asConv = classAsConverted.get(c.id) ?? 0;
      const invested = classInvested.get(c.id) ?? 0;
      const held = reserved.get(c.id) ?? 0;
      const available = roundShares(c.authorized - outstanding - held);
      if (outstanding > c.authorized) {
        warnings.push(`${c.name}: ${outstanding.toLocaleString('en-US')} shares outstanding exceeds ${c.authorized.toLocaleString('en-US')} authorized.`);
      } else if (available < 0) {
        warnings.push(`${c.name}: ${outstanding.toLocaleString('en-US')} shares outstanding and ${held.toLocaleString('en-US')} reserved for plans, warrants and conversion exceed ${c.authorized.toLocaleString('en-US')} authorized.`);
      }
      return {
        shareClassId: c.id, name: c.name, kind: c.kind,
        authorized: c.authorized, outstanding, asConverted: asConv,
        reserved: held, available,
        holders: classHolders.get(c.id)?.size ?? 0,
        investedAmount: invested,
        pricePerShare: c.originalIssuePrice,
        liquidationPreference: Math.round(shareValue(outstanding, c.originalIssuePrice) * c.liquidationMultiple),
        ownershipPct: pct(asConv, totals.fullyDiluted),
      };
    });

  return { asOf, rows, classes, pools, totals, uncappedConversionPrice, mfnTerms, warnings };
}

function sum<T>(items: T[], f: (t: T) => number): number {
  return roundShares(items.reduce((s, i) => s + f(i), 0));
}

/** Fully diluted before convertibles, with the unallocated pool. */
function sumFullyDiluted(rowById: Map<string, CapTableRow>, data: CompanyData, asOf: ISODate): number {
  const rows = [...rowById.values()];
  const base = sum(rows, (r) => r.asConverted + r.optionsOutstanding + r.rsusOutstanding + r.warrantsOutstanding);
  const pools = computePoolSummaries(data, asOf);
  return roundShares(base + pools.reduce((s, p) => s + Math.max(0, p.available), 0));
}

/** Ownership grouped by relation — the donut on the dashboard. */
/**
 * How a holder's relationship to the company is named in ownership charts, and
 * the order those names stack in: the people who were there first at the bottom,
 * the shares nobody holds yet at the top.
 */
export const GROUP_LABELS: Record<string, string> = {
  FOUNDER: 'Founders', EMPLOYEE: 'Employees', FORMER_EMPLOYEE: 'Former employees',
  INVESTOR: 'Investors', ADVISOR: 'Advisors', BOARD_MEMBER: 'Board', CONTRACTOR: 'Contractors', OTHER: 'Other',
};
export const GROUP_ORDER: string[] = [
  'Founders', 'Employees', 'Former employees', 'Advisors', 'Board', 'Contractors',
  'Investors', 'Other', 'Unallocated pool',
];

export function ownershipByGroup(table: CapTable): { label: string; shares: number; pct: number }[] {
  const groups = new Map<string, number>();
  const labels = GROUP_LABELS;
  for (const r of table.rows) {
    const label = labels[r.relation] ?? 'Other';
    groups.set(label, (groups.get(label) ?? 0) + r.fullyDiluted);
  }
  if (table.totals.poolAvailable > 0) groups.set('Unallocated pool', table.totals.poolAvailable);
  return [...groups.entries()]
    .map(([label, shares]) => ({ label, shares, pct: pct(shares, table.totals.fullyDiluted) }))
    .filter((g) => g.shares > 0)
    .sort((a, b) => b.shares - a.shares);
}

export interface DilutionPoint {
  date: ISODate;
  /** The share class issued on this date, or the date itself when a convertible caused the point. */
  label: string;
  fullyDiluted: number;
  pps: PricePerShare;
  /** Fully diluted split by share class. Every band in `bands` has an entry, zero before it exists. */
  shares: Record<string, number>;
  /**
   * The same total split by who holds it instead. Founders and employees both
   * hold common stock, so the class view cannot tell them apart and this one can.
   */
  holders: Record<string, number>;
}

export interface DilutionHistory {
  /** Stacking order: share classes oldest first, then the instruments that dilute them. */
  bands: string[];
  /** Stacking order for the holder view, oldest relationship to the company first. */
  groups: string[];
  points: DilutionPoint[];
}

/** The instruments that sit on top of the issued classes, in the order they stack. */
const DILUTION_INSTRUMENTS = ['Options & RSUs', 'Warrants', 'Convertibles', 'Unallocated pool'];

/**
 * Dilution across historical rounds — one point per share class issue date, each
 * broken into the parts that add up to fully diluted, so a stacked chart of the
 * points shows where every share came from and who was diluted by what. Each point
 * is the cap table as of its date, so transfers, exercises, cancellations and
 * conversions recorded since are undone there as in any other past view (CAP-1).
 */
export function dilutionHistory(data: CompanyData): DilutionHistory {
  const dates = new Set<ISODate>();
  for (const c of data.shareClasses) dates.add(c.issueDate);
  for (const c of data.convertibles) dates.add(c.issueDate);
  const sorted = [...dates].sort();

  // Oldest class at the bottom of the stack, so later rounds pile on top of the founders.
  const classNames: string[] = [];
  for (const c of [...data.shareClasses].sort((a, b) => a.issueDate.localeCompare(b.issueDate))) {
    if (!classNames.includes(c.name)) classNames.push(c.name);
  }
  const bands = [...classNames, ...DILUTION_INSTRUMENTS];

  const points: DilutionPoint[] = sorted.map((d) => {
    const t = computeCapTable(data, { asOf: d, includeConvertibles: true });
    const shares: Record<string, number> = {};
    for (const band of bands) shares[band] = 0;
    // Classes can share a name across entities, so add rather than assign.
    for (const c of t.classes) shares[c.name] = (shares[c.name] ?? 0) + c.asConverted;
    shares['Options & RSUs'] = t.totals.optionsOutstanding + t.totals.rsusOutstanding;
    shares.Warrants = t.totals.warrantsOutstanding;
    shares.Convertibles = t.totals.convertibleAsConverted;
    shares['Unallocated pool'] = t.totals.poolAvailable;

    const holders: Record<string, number> = {};
    for (const group of GROUP_ORDER) holders[group] = 0;
    for (const g of ownershipByGroup(t)) holders[g.label] = (holders[g.label] ?? 0) + g.shares;

    const cls = data.shareClasses.find((c) => c.issueDate === d);
    return { date: d, label: cls?.name ?? d, fullyDiluted: t.totals.fullyDiluted, pps: t.totals.valuationPPS, shares, holders };
  });

  // A band nobody ever held is noise in the legend.
  return {
    bands: bands.filter((b) => points.some((p) => p.shares[b] > 0)),
    groups: GROUP_ORDER.filter((g) => points.some((p) => p.holders[g] > 0)),
    points,
  };
}

/**
 * A holder's row with the certificates, grants and instruments behind it: those
 * dated on or before `asOf`, in the same split-adjusted shares and prices as the
 * row, so a 2:1 split shows a 4,500,000 certificate as 9,000,000 in both.
 */
export function stakeholderPosition(input: CompanyData, stakeholderId: string, asOf: ISODate = today()) {
  const table = computeCapTable(input, { asOf, includeConvertibles: true });
  const data = normalizeSplits(input, asOf);
  const row = table.rows.find((r) => r.stakeholderId === stakeholderId);
  const awards = data.awards.filter((a) => a.stakeholderId === stakeholderId && !PENDING_AWARD.has(a.status) && a.grantDate <= asOf);
  const issuances = data.issuances.filter((i) => i.stakeholderId === stakeholderId && i.status === 'OUTSTANDING' && i.issueDate <= asOf);
  const convertibles = data.convertibles.filter((c) => c.stakeholderId === stakeholderId && c.issueDate <= asOf);
  const warrants = data.warrants.filter((w) => w.stakeholderId === stakeholderId && w.issueDate <= asOf);
  return { row: row ?? null, awards, issuances, convertibles, warrants, table };
}

export function validateAuthorized(data: CompanyData, asOf: ISODate = today()): string[] {
  const table = computeCapTable(data, { asOf });
  const issues: string[] = [];
  for (const c of table.classes) {
    if (c.outstanding > c.authorized) issues.push(`${c.name} is over-issued by ${(c.outstanding - c.authorized).toLocaleString('en-US')} shares.`);
    else if (c.available < 0) issues.push(`${c.name} is ${Math.abs(c.available).toLocaleString('en-US')} shares short of what it must keep reserved for plans, warrants and conversion.`);
  }
  for (const p of table.pools) {
    if (p.available < 0) issues.push(`${p.name} is over-granted by ${Math.abs(p.available).toLocaleString('en-US')} shares.`);
  }
  void onOrBefore;
  return issues;
}
