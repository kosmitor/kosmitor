import type { CompanyData, ISODate, Cents, Award, PricePerShare, ComplianceFiling, Exercise, Valuation } from './types.ts';
import { computeCapTable, activeValuation, awardOutstanding, PENDING_AWARD } from './captable.ts';
import { summarizeVesting, buildVestingSchedule } from './vesting.ts';
import { normalizeSplits, splitFactor } from './splits.ts';
import { addDays, addMonths, daysBetween, shareValue, today, roundShares, floorShares, formatMoney, businessDayOnOrAfter, maxDate, fmtDate, pct } from './util.ts';
import { valuationRefresh, describeRefreshTrigger, longDate, safeHarborLapse } from './valuation-refresh.ts';
import { enginePolicy, DEFAULT_ENGINE_POLICY, type EnginePolicy } from './policy.ts';
import { isDirector } from './board.ts';

export type Severity = 'ERROR' | 'WARNING' | 'INFO';

export interface ComplianceIssue {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  subjectType: 'AWARD' | 'ISSUANCE' | 'STAKEHOLDER' | 'COMPANY' | 'VALUATION' | 'POOL' | 'CONVERTIBLE';
  subjectId: string | null;
  dueDate: ISODate | null;
  amount: Cents | null;
}

const ISO_ANNUAL_LIMIT: Cents = 100_000_00; // $100,000

/** A share count or dollar figure with thousands separators, printed the same whatever the host's locale. */
const figure = (n: number): string => n.toLocaleString('en-US');

/**
 * ISO $100,000 rule (IRC 422(d)).
 *
 * The aggregate fair market value (measured at grant) of stock for which ISOs
 * become exercisable for the first time in any calendar year may not exceed
 * $100,000. The excess is treated as an NSO. Grants are tested in grant-date
 * order within each year, except that shares exercised before an acceleration
 * keep their place ahead of it (Treas. Reg. 1.422-4(b)(4)).
 */
export interface ISOLimitRow {
  year: number;
  awardId: string;
  awardLabel: string;
  stakeholderId: string;
  stakeholderName: string;
  sharesVesting: number;
  valueAtGrant: Cents;
  cumulativeValue: Cents;
  isoQualified: number;
  nsoRecharacterized: number;
  exceeded: boolean;
}

export interface ISOLimitOptions {
  /**
   * The date each grant's cancelled shares were cancelled, by award id: its
   * CANCELLATION, FORFEITURE or EXPIRATION entry in the ledger. A grant with
   * cancelled shares and no date here is taken as cancelled on the as-of date.
   */
  cancellationDates?: Record<string, ISODate>;
}

export function isoHundredKTest(input: CompanyData, asOf: ISODate = today(), opts: ISOLimitOptions = {}): ISOLimitRow[] {
  const data = normalizeSplits(input, asOf);
  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  const rows: ISOLimitRow[] = [];

  // Group first-exercisable shares by stakeholder and calendar year. Shares that
  // an acceleration provision makes exercisable carry the day it was triggered.
  type Slice = { award: Award; shares: number; triggeredOn: ISODate | null };
  const byHolderYear = new Map<string, Slice[]>();
  const count = (award: Award, year: number, shares: number, triggeredOn: ISODate | null): void => {
    const key = `${award.stakeholderId}:${year}`;
    if (!byHolderYear.has(key)) byHolderYear.set(key, []);
    const bucket = byHolderYear.get(key)!;
    const existing = bucket.find((b) => b.award.id === award.id && b.triggeredOn === triggeredOn);
    if (existing) existing.shares += shares;
    else bucket.push({ award, shares, triggeredOn });
  };
  for (const award of data.awards) {
    if (award.type !== 'ISO') continue;
    if (PENDING_AWARD.has(award.status) || award.grantDate > asOf) continue;
    // When each share first becomes exercisable, assuming the holder keeps
    // working (Treas. Reg. 1.422-4(b)(4)). An early-exercisable option is
    // exercisable in full from the grant date, so the whole grant is "first
    // exercisable" in the grant year — the vesting schedule only governs the
    // repurchase right. A grant whose schedule is missing is taken as fully
    // vested at grant, as the cap table and the exercise-window check take it.
    // A performance milestone or a change-of-control acceleration is an
    // "acceleration provision": its shares are first exercisable when it is
    // triggered, and that day is kept for the ordering below (b)(4).
    const schedule = scheduleById.get(award.vestingScheduleId);
    let tranches: { date: ISODate; quantity: number; triggered: boolean }[];
    if (award.earlyExerciseAllowed || !schedule) {
      tranches = [{ date: award.grantDate, quantity: award.quantity, triggered: false }];
    } else {
      tranches = buildVestingSchedule({ schedule, totalQuantity: award.quantity, vestingStartDate: award.vestingStartDate })
        .map((e) => ({ date: e.date < award.grantDate ? award.grantDate : e.date, quantity: e.quantity, triggered: e.kind === 'MILESTONE' || e.kind === 'ACCELERATION' }));
    }
    // A cancelled share is left out only of the years that begin after it was
    // cancelled; in the year it is cancelled it counts as outstanding to the
    // year end (1.422-4(b)(5)). The cancelled shares are the last to vest, and
    // shares not yet vested when the holder leaves are forfeited that day.
    const terminationDate = data.stakeholders.find((h) => h.id === award.stakeholderId)?.terminationDate ?? null;
    const lapsed = award.status === 'CANCELLED' || award.status === 'FORFEITED' || award.status === 'EXPIRED';
    const cancelledOn = opts.cancellationDates?.[award.id] ?? asOf;
    let cancelled = lapsed ? Math.max(award.cancelledQuantity, award.quantity - award.exercisedQuantity) : award.cancelledQuantity;
    for (let i = tranches.length - 1; i >= 0; i--) {
      const t = tranches[i];
      const lost = Math.min(Math.max(0, cancelled), t.quantity);
      cancelled = roundShares(cancelled - lost);
      const yearStart = `${t.date.slice(0, 4)}-01-01`;
      if (award.expirationDate && t.date > award.expirationDate) continue;
      if (terminationDate && t.date > terminationDate && terminationDate < yearStart) continue;
      const counted = cancelledOn < yearStart ? roundShares(t.quantity - lost) : t.quantity;
      if (counted > 0) count(award, Number(yearStart.slice(0, 4)), counted, t.triggered ? t.date : null);
    }
  }

  // For (b)(4) below: shares of a grant exercised before a date, in today's
  // shares (an exercise is recorded in the shares of its own date), less those
  // first exercisable in earlier years, since exercises take the oldest first.
  const exercisedInYearBefore = (award: Award, year: number, date: ISODate): number => {
    const exercised = (data.exercises ?? [])
      .filter((x) => x.awardId === award.id && (!x.status || x.status === 'COMPLETED') && x.exerciseDate < date)
      .reduce((s, x) => s + x.quantity * splitFactor(input, x.exerciseDate, asOf), 0);
    let earlier = 0;
    for (const [key, slices] of byHolderYear) {
      if (key.startsWith(`${award.stakeholderId}:`) && Number(key.split(':')[1]) < year) {
        earlier += slices.filter((s) => s.award.id === award.id).reduce((n, s) => n + s.shares, 0);
      }
    }
    return Math.max(0, roundShares(exercised - earlier));
  };

  for (const [key, slices] of byHolderYear) {
    const [stakeholderId, yearStr] = key.split(':');
    const year = Number(yearStr);
    const holder = data.stakeholders.find((s) => s.id === stakeholderId);
    const fmvOf = (a: Award) => a.fmvAtGrant || a.strikePrice;
    // Options are taken into account in the order granted (1.422-4(b)(3)). An
    // option an acceleration provision makes exercisable counts from the day the
    // provision is triggered, and "does not affect the application of the
    // $100,000 limitation with respect to any option (or portion thereof)
    // exercised prior to such acceleration" (b)(4), Example 4: shares exercised
    // before it keep the status they had, and their ISO shares take room first.
    slices.sort((a, b) => a.award.grantDate.localeCompare(b.award.grantDate));
    const settled = new Map<Slice, { shares: number; iso: number }>();
    const allocate = (known: Slice[]): Map<Slice, number> => {
      let used = [...settled].reduce((s, [slice, f]) => s + shareValue(f.iso, fmvOf(slice.award)), 0);
      const iso = new Map<Slice, number>();
      for (const s of known) {
        const fixed = settled.get(s);
        const open = roundShares(s.shares - (fixed?.shares ?? 0));
        const value = shareValue(open, fmvOf(s.award));
        const qualifiedValue = Math.min(value, Math.max(0, ISO_ANNUAL_LIMIT - used));
        used += value;
        iso.set(s, roundShares((fixed?.iso ?? 0) + (value > 0 ? (open * qualifiedValue) / value : open)));
      }
      return iso;
    };
    const triggers = [...new Set(slices.flatMap((s) => (s.triggeredOn ? [s.triggeredOn] : [])))].sort();
    for (const date of triggers) {
      const known = slices.filter((s) => !s.triggeredOn || s.triggeredOn < date);
      const iso = allocate(known);
      const left = new Map<string, number>();
      for (const s of known) {
        if (!left.has(s.award.id)) left.set(s.award.id, exercisedInYearBefore(s.award, year, date));
        const exercised = Math.min(s.shares, left.get(s.award.id)!);
        left.set(s.award.id, roundShares(left.get(s.award.id)! - exercised));
        // The ISO shares of a grant are the first exercised (1.422-4(c)(2)).
        if (exercised > 0) settled.set(s, { shares: exercised, iso: Math.min(exercised, iso.get(s)!) });
      }
    }
    const iso = allocate(slices);

    // One row per grant, those whose exercised shares took their room first
    // leading, the rest in grant order.
    const byAward = new Map<string, { award: Award; shares: number; iso: number; first: boolean }>();
    for (const s of slices) {
      const r = byAward.get(s.award.id) ?? { award: s.award, shares: 0, iso: 0, first: false };
      r.shares += s.shares;
      r.iso += iso.get(s)!;
      r.first ||= settled.has(s);
      byAward.set(s.award.id, r);
    }
    let cumulative = 0;
    for (const r of [...byAward.values()].sort((a, b) => Number(b.first) - Number(a.first))) {
      const value = shareValue(r.shares, fmvOf(r.award));
      const isoShares = roundShares(r.iso);
      cumulative += value;
      rows.push({
        year, awardId: r.award.id, awardLabel: r.award.label ?? r.award.id.slice(-6),
        stakeholderId, stakeholderName: holder?.name ?? 'Unknown',
        sharesVesting: roundShares(r.shares), valueAtGrant: value, cumulativeValue: cumulative,
        isoQualified: isoShares, nsoRecharacterized: roundShares(r.shares - isoShares),
        exceeded: cumulative > ISO_ANNUAL_LIMIT,
      });
    }
  }
  return rows.sort((a, b) => a.year - b.year || a.stakeholderName.localeCompare(b.stakeholderName));
}

/**
 * Rule 701 exemption test.
 *
 * In any rolling 12-month period a private company may sell securities under
 * compensatory plans up to the GREATEST of three ceilings: $1,000,000 of
 * aggregate sales price; 15% of total assets (also a dollar test); or 15% of
 * the outstanding shares of the class being offered — a share-count test, so
 * shares granted are compared with shares outstanding. The exemption holds if
 * any one ceiling is respected. Above $10,000,000 of sales enhanced disclosure
 * is required. Options count at their exercise price when granted; stock given
 * for services counts at the value of the stock. The class is measured at the
 * most recent balance sheet date, taken as the last fiscal year end.
 */
export interface Rule701Result {
  periodStart: ISODate;
  periodEnd: ISODate;
  aggregateValue: Cents;
  sharesSold: number;
  cashLimit: Cents;
  assetsLimit: Cents;
  /** The balance sheet date the class outstanding is measured at. */
  balanceSheetDate: ISODate;
  outstandingShares: number;
  sharesLimit: number;
  /** Dollar equivalent of the share-count ceiling at the current FMV, for display. */
  outstandingLimit: Cents;
  /** The most generous ceiling expressed in dollars. */
  applicableLimit: Cents;
  headroom: Cents;
  exceeded: boolean;
  disclosureThresholdMet: boolean;
  grants: { awardId: string; date: ISODate; value: Cents; shares: number; stakeholderName: string }[];
}

export function rule701Test(
  input: CompanyData, asOf: ISODate = today(), totalAssets: Cents = 0, opts: { fiscalYearEnd?: string } = {},
): Rule701Result {
  const data = normalizeSplits(input, asOf);
  const periodStart = addMonths(asOf, -12);
  // 15% of the class is "measured at the issuer's most recent balance sheet
  // date (if no older than its last fiscal year end)" (17 CFR 230.701(d)(2)(iii)),
  // so shares issued since do not raise it. The engine knows of no interim
  // balance sheet and takes the last fiscal year end; a company with none of
  // the class then was formed since, and the as-of date stands in for its first.
  // The class is counted in today's shares, like the grants.
  const commonAt = (date: ISODate): number =>
    computeCapTable(data, { asOf: date, includeUnallocatedPool: false }).classes.find((c) => c.kind === 'COMMON')?.outstanding ?? 0;
  let balanceSheetDate = lastYearEnd(asOf, opts.fiscalYearEnd ?? '12-31');
  let outstandingShares = commonAt(balanceSheetDate);
  if (outstandingShares === 0) {
    balanceSheetDate = asOf;
    outstandingShares = commonAt(asOf);
  }
  const grants = data.awards
    .filter((a) => a.grantDate > periodStart && a.grantDate <= asOf && !PENDING_AWARD.has(a.status))
    .map((a) => ({
      awardId: a.id, date: a.grantDate, shares: a.quantity,
      // "The value of services exchanged for securities issued must be measured
      // by reference to the value of the securities issued" (701(d)(3)(i)), so
      // RSUs and restricted stock count at the stock's value, not the price paid.
      value: shareValue(a.quantity, a.type === 'RSU' || a.type === 'RSA' ? Math.max(a.strikePrice, a.fmvAtGrant || 0) : a.strikePrice),
      stakeholderName: data.stakeholders.find((s) => s.id === a.stakeholderId)?.name ?? 'Unknown',
    }));
  const aggregateValue = grants.reduce((s, g) => s + g.value, 0);
  const sharesSold = roundShares(grants.reduce((s, g) => s + g.shares, 0));

  const cashLimit = 1_000_000_00;
  const assetsLimit = Math.round(totalAssets * 0.15);
  const sharesLimit = roundShares(outstandingShares * 0.15);
  const fmv = activeValuation(data, asOf);
  const outstandingLimit = shareValue(sharesLimit, fmv);
  const applicableLimit = Math.max(cashLimit, assetsLimit, outstandingLimit);

  const underCash = aggregateValue <= cashLimit;
  const underAssets = aggregateValue <= assetsLimit;
  const underShares = sharesSold <= sharesLimit;
  const exceeded = !(underCash || underAssets || underShares);
  // Headroom under the most generous ceiling; negative when every ceiling is breached.
  const headroom = Math.max(
    cashLimit - aggregateValue,
    assetsLimit - aggregateValue,
    shareValue(sharesLimit - sharesSold, fmv),
  );

  return {
    periodStart, periodEnd: asOf, aggregateValue, sharesSold,
    cashLimit, assetsLimit, balanceSheetDate, outstandingShares, sharesLimit, outstandingLimit, applicableLimit,
    headroom, exceeded,
    disclosureThresholdMet: aggregateValue > 10_000_000_00,
    grants: grants.sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/**
 * The last fiscal year end (MM-DD) on or before a date. A year end past the end
 * of its month in a given year (02-29) falls on the month's last day.
 */
function lastYearEnd(date: ISODate, fiscalYearEnd: string): ISODate {
  const [mm, dd] = fiscalYearEnd.split('-').map(Number);
  const inYear = (y: number) => fmtDate(new Date(Date.UTC(y, mm - 1, Math.min(dd, new Date(Date.UTC(y, mm, 0)).getUTCDate()))));
  const y = Number(date.slice(0, 4));
  return inYear(y) <= date ? inYear(y) : inYear(y - 1);
}

/**
 * Runs every compliance check and returns a single prioritised issue list.
 */
export interface ComplianceOptions {
  asOf?: ISODate;
  totalAssets?: Cents;
  /** Whether the company must file beneficial ownership information with FinCEN. */
  boiStatus?: BoiStatus;
  /** Job titles by stakeholder id, used to spot senior officers for the BOI control test. */
  titles?: Record<string, string | null>;
  /** When each grant's cancelled shares were cancelled, by award id, for the ISO $100K test. */
  cancellationDates?: Record<string, ISODate>;
  /** The company's fiscal year end (MM-DD), whose last balance sheet the Rule 701 class test uses. Defaults to 12-31. */
  fiscalYearEnd?: string;
}

export function runComplianceChecks(
  input: CompanyData, opts: ComplianceOptions = {},
): ComplianceIssue[] {
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const policy = enginePolicy().compliance;
  const issues: ComplianceIssue[] = [];
  const push = (i: Omit<ComplianceIssue, 'id'>) =>
    issues.push({ ...i, id: `${i.rule}:${i.subjectId ?? 'company'}:${issues.length}` });

  // --- 83(b) elections: 30 days from the transfer of restricted stock ----
  // Stock is restricted when it can still be forfeited: it vests over time or
  // was early-exercised. A "fully vested at grant" schedule carries no risk of
  // forfeiture, so those certificates — typically investors' — need no election.
  // The thirty days are law, and a thirtieth day on a weekend or legal holiday
  // moves to the next business day (IRC 7503); how close to the end an open
  // window becomes an error is policy (compliance.election83bUrgentDays).
  for (const iss of data.issuances) {
    const schedule = iss.vestingScheduleId ? data.vestingSchedules.find((v) => v.id === iss.vestingScheduleId) : undefined;
    const vestsOverTime = schedule ? schedule.kind !== 'FULLY_VESTED' && !(schedule.durationMonths === 0 && schedule.cliffMonths === 0) : iss.vestingScheduleId != null;
    const restricted = vestsOverTime || iss.earlyExercised;
    if (!restricted || iss.status !== 'OUTSTANDING') continue;
    if (iss.election83bFiledOn) continue;
    const deadline = businessDayOnOrAfter(addDays(iss.issueDate, 30));
    const daysLeft = daysBetween(asOf, deadline);
    const holder = data.stakeholders.find((s) => s.id === iss.stakeholderId);
    if (daysLeft < 0) {
      push({
        rule: '83B_DEADLINE', severity: 'ERROR', subjectType: 'ISSUANCE', subjectId: iss.id,
        title: '83(b) election window has closed',
        detail: `${holder?.name ?? 'A holder'} did not file an 83(b) election for certificate ${iss.certificateNo ?? iss.id.slice(-6)} within 30 days of the ${iss.issueDate} purchase. The deadline is not extendable.`,
        dueDate: deadline, amount: null,
      });
    } else if (daysLeft <= 30) {
      push({
        rule: '83B_DEADLINE', severity: daysLeft <= policy.election83bUrgentDays ? 'ERROR' : 'WARNING',
        subjectType: 'ISSUANCE', subjectId: iss.id,
        title: `83(b) election due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        detail: `${holder?.name ?? 'A holder'} must postmark an 83(b) election for certificate ${iss.certificateNo ?? iss.id.slice(-6)} by ${deadline}.`,
        dueDate: deadline, amount: null,
      });
    }
  }

  // --- ISO $100k --------------------------------------------------------
  const isoRows = isoHundredKTest(data, asOf, { cancellationDates: opts.cancellationDates });
  const exceededByHolder = new Map<string, ISOLimitRow[]>();
  for (const r of isoRows) {
    if (!r.exceeded) continue;
    const key = `${r.stakeholderId}:${r.year}`;
    if (!exceededByHolder.has(key)) exceededByHolder.set(key, []);
    exceededByHolder.get(key)!.push(r);
  }
  for (const [key, rows] of exceededByHolder) {
    const [, year] = key.split(':');
    const excess = rows.reduce((s, r) => s + r.nsoRecharacterized, 0);
    push({
      rule: 'ISO_100K', severity: 'WARNING', subjectType: 'AWARD', subjectId: rows[0].awardId,
      title: `ISO $100K limit exceeded in ${year}`,
      detail: `${rows[0].stakeholderName} has ISOs first exercisable in ${year} above the $100,000 limit. ${figure(Math.round(excess))} shares are recharacterised as NSOs and must be tracked separately for tax reporting.`,
      dueDate: null, amount: rows[rows.length - 1].cumulativeValue - ISO_ANNUAL_LIMIT,
    });
  }

  // --- Rule 701 ---------------------------------------------------------
  const r701 = rule701Test(data, asOf, opts.totalAssets ?? 0, { fiscalYearEnd: opts.fiscalYearEnd });
  if (r701.exceeded) {
    // Exceeded means over all three ceilings (701(d)(2)). The two dollar
    // ceilings are compared with the sales price and the class ceiling with the
    // share count; turning shares into dollars at today's FMV would set option
    // exercise prices against stock values and can give a negative excess.
    const dollarCeiling = Math.max(r701.cashLimit, r701.assetsLimit);
    push({
      rule: 'RULE_701', severity: 'ERROR', subjectType: 'COMPANY', subjectId: null,
      title: 'Rule 701 12-month limit exceeded',
      detail: `Compensatory grants over the trailing 12 months total $${figure(r701.aggregateValue / 100)}, $${figure((r701.aggregateValue - dollarCeiling) / 100)} above the $${figure(dollarCeiling / 100)} ceiling, and ${figure(r701.sharesSold)} shares, ${figure(roundShares(r701.sharesSold - r701.sharesLimit))} above the ${figure(r701.sharesLimit)} shares that are 15% of the class. Additional grants may need another exemption.`,
      dueDate: null, amount: r701.aggregateValue - dollarCeiling,
    });
  } else if (r701.headroom < r701.applicableLimit * policy.rule701WarnHeadroom) {
    push({
      rule: 'RULE_701', severity: 'WARNING', subjectType: 'COMPANY', subjectId: null,
      title: 'Approaching the Rule 701 limit',
      detail: `Only $${figure(r701.headroom / 100)} of Rule 701 headroom remains in the current 12-month window.`,
      dueDate: null, amount: r701.headroom,
    });
  }
  if (r701.disclosureThresholdMet) {
    push({
      rule: 'RULE_701_DISCLOSURE', severity: 'WARNING', subjectType: 'COMPANY', subjectId: null,
      title: 'Rule 701 enhanced disclosure required',
      detail: 'Grants exceed $10,000,000 in the trailing 12 months, which triggers the enhanced disclosure requirements (financial statements and risk factors delivered to recipients).',
      dueDate: null, amount: r701.aggregateValue,
    });
  }

  // --- 409A validity ----------------------------------------------------
  // Built on the same rule as the 409A page, so the two tabs of Compliance & tax
  // never disagree about the same valuation: twelve months at most from the
  // valuation date, the report's own expiry if sooner, and a priced round since.
  const refresh = valuationRefresh(data, asOf, policy.valuationExpiryWarningDays);
  const money = (c: number) => formatMoney(c, { compact: true });
  for (const t of refresh.triggers) {
    if (t.reason === 'NO_VALUATION' && t.severity !== 'REQUIRED') continue;
    const titles: Record<string, string> = {
      NO_VALUATION: 'No current 409A valuation on file',
      EXPIRED: '409A valuation no longer supports new grants',
      EXPIRING: `409A valuation runs out in ${t.date ? daysBetween(asOf, t.date) : 0} days`,
      PRICED_ROUND: `A priced round since the 409A: ${t.shareClassName ?? 'preferred stock'}`,
      CONVERTIBLE: 'Convertibles issued since the 409A',
    };
    push({
      rule: 'VALUATION_409A', severity: t.severity === 'REQUIRED' ? 'ERROR' : 'WARNING',
      subjectType: 'VALUATION', subjectId: refresh.current?.id ?? null,
      title: titles[t.reason],
      detail: describeRefreshTrigger(t, longDate, money),
      dueDate: t.reason === 'EXPIRING' || (t.reason === 'EXPIRED' && t.date) ? t.date : null, amount: t.principal ?? null,
    });
  }

  // --- Strike prices, and the 409A behind each grant --------------------
  // Each option or SAR is compared with the price activeValuation() gives its
  // grant date: the latest 409A on or before it or, with none, the latest
  // valuation of any kind. Only a 409A sets the common stock's fair market
  // value, so the finding names what the strike was compared with. A grant that
  // no 409A supported when it was made has no presumption of reasonableness
  // (Treas. Reg. 1.409A-1(b)(5)(iv)(B)(2)(i)), and a later valuation does not
  // give it one, so it stays flagged after a new 409A arrives.
  const priceNames: Record<Valuation['type'], string> = {
    '409A': '409A fair market value', PREFERRED_PRICE: 'preferred stock price', BOARD_ESTIMATE: "board's estimate of value", SECONDARY: 'secondary sale price',
  };
  const pps = (p: PricePerShare) => `$${(p / 1e6).toFixed(4)}`;
  for (const award of data.awards) {
    if (PENDING_AWARD.has(award.status) || award.grantDate > asOf || !['ISO', 'NSO', 'SAR'].includes(award.type)) continue;
    const holder = data.stakeholders.find((s) => s.id === award.stakeholderId);
    const grant = `${award.label ?? 'Grant'} to ${holder?.name ?? 'a holder'}`;
    const onFile = data.valuations
      .filter((v) => v.effectiveDate <= award.grantDate && v.status !== 'DRAFT')
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
    const price = onFile.find((v) => v.type === '409A') ?? onFile[0];
    // Compared in the shares of the grant date, where the board set the strike
    // in whole micro-cents against the price as quoted that day, also in whole
    // micro-cents: a split since divides both exactly, and a 409A from before a
    // split that left the price a fraction cannot be matched more closely.
    const k = splitFactor(input, award.grantDate, asOf);
    const quoted = price ? Math.round(price.fairMarketValue * k) : 0;
    if (price && quoted > 0 && Math.round(award.strikePrice * k) < quoted) {
      push({
        rule: 'STRIKE_BELOW_FMV', severity: 'ERROR', subjectType: 'AWARD', subjectId: award.id,
        title: price.type === '409A' ? 'Strike price below fair market value' : `Strike price below the ${priceNames[price.type]}`,
        detail: price.type === '409A'
          ? `${grant} has a ${pps(award.strikePrice)} strike against a ${pps(price.fairMarketValue)} FMV on ${award.grantDate}, from the 409A valuation of ${longDate(price.effectiveDate)}. Discounted options are subject to section 409A penalties.`
          : `${grant} has a ${pps(award.strikePrice)} strike against the ${pps(price.fairMarketValue)} ${priceNames[price.type]} of ${longDate(price.effectiveDate)}, the only price on record when it was granted on ${award.grantDate}. That is not a fair market value for common stock, but with no 409A valuation behind the grant nothing shows the strike was not discounted; have an appraiser look at it.`,
        dueDate: null, amount: null,
      });
      continue;
    }
    const lapse = safeHarborLapse(data, award.grantDate);
    if (lapse) {
      const { trigger: t, valuation: v } = lapse;
      const why = t.reason === 'PRICED_ROUND' && v
        ? `${t.shareClassName} had been sold on ${longDate(t.date!)}, after the 409A valuation of ${longDate(v.effectiveDate)}`
        : t.reason === 'EXPIRED' && v && t.date
          ? `the 409A valuation of ${longDate(v.effectiveDate)} had stopped supporting new grants after ${longDate(t.date)}`
          : 'no 409A valuation was on file';
      push({
        rule: 'STRIKE_BELOW_FMV', severity: 'WARNING', subjectType: 'AWARD', subjectId: award.id,
        title: 'Grant made outside the 409A safe harbor',
        detail: `${grant} was granted on ${longDate(award.grantDate)}, when ${why}. A later valuation does not reach back to it, so its ${pps(award.strikePrice)} strike has no presumption of reasonableness. Your appraiser can say whether it reflected the fair market value that day.`,
        dueDate: null, amount: null,
      });
    }
  }

  // --- Board approval ---------------------------------------------------
  for (const award of data.awards) {
    if (award.status !== 'OUTSTANDING' || award.grantDate > asOf) continue;
    if (!award.boardApprovalDate) {
      push({
        rule: 'BOARD_APPROVAL', severity: 'WARNING', subjectType: 'AWARD', subjectId: award.id,
        title: 'Grant is missing board approval',
        detail: `${award.label ?? 'A grant'} dated ${award.grantDate} has no recorded board approval. Grants are not validly issued until approved by the board or a delegated committee.`,
        dueDate: null, amount: null,
      });
    } else if (award.boardApprovalDate > award.grantDate) {
      push({
        rule: 'BOARD_APPROVAL', severity: 'ERROR', subjectType: 'AWARD', subjectId: award.id,
        title: 'Grant date precedes board approval',
        detail: `${award.label ?? 'A grant'} is dated ${award.grantDate} but was approved on ${award.boardApprovalDate}. Backdated grants create 409A and accounting exposure.`,
        dueDate: null, amount: null,
      });
    }
  }

  // --- Authorized share capacity ---------------------------------------
  const table = computeCapTable(data, { asOf });
  for (const c of table.classes) {
    if (c.outstanding > c.authorized) {
      push({
        rule: 'OVER_ISSUANCE', severity: 'ERROR', subjectType: 'COMPANY', subjectId: c.shareClassId,
        title: `${c.name} is over-issued`,
        detail: `${figure(c.outstanding)} shares are outstanding against ${figure(c.authorized)} authorized. File a charter amendment to increase the authorized count.`,
        dueDate: null, amount: null,
      });
    } else if (c.available < 0) {
      // The charter must keep enough unissued shares reserved for everything
      // that can still be issued in the class: plan grants and the plan's
      // reserve, warrants, and in common what preferred converts into (NVCA
      // model COI, "Reservation of Stock Issuable Upon Conversion").
      push({
        rule: 'AUTHORIZED_CAPACITY', severity: 'ERROR', subjectType: 'COMPANY', subjectId: c.shareClassId,
        title: `${c.name} authorized shares fall short of what must be reserved`,
        detail: `${c.name} is ${figure(-c.available)} shares short of what it must keep reserved for plans, warrants and conversion: ${figure(c.authorized)} authorized, ${figure(c.outstanding)} issued and ${figure(c.reserved)} reserved. File a charter amendment to increase the authorized count, or reduce what is reserved.`,
        dueDate: null, amount: null,
      });
    } else if (c.available < c.authorized * policy.authorizedSharesWarnRemaining && c.kind === 'COMMON') {
      // Measured on what is neither issued nor reserved: the room left for a new
      // grant, plan increase or financing.
      push({
        rule: 'AUTHORIZED_CAPACITY', severity: 'WARNING', subjectType: 'COMPANY', subjectId: c.shareClassId,
        title: `${c.name} authorized shares nearly exhausted`,
        detail: `Only ${figure(c.available)} authorized ${c.name} shares remain unissued and unreserved: ${figure(c.outstanding)} are issued and ${figure(c.reserved)} reserved for plans, warrants and conversion, of ${figure(c.authorized)} authorized.`,
        dueDate: null, amount: null,
      });
    }
  }
  for (const p of table.pools) {
    if (p.available < 0) {
      push({
        rule: 'POOL_OVERALLOCATED', severity: 'ERROR', subjectType: 'POOL', subjectId: p.poolId,
        title: `${p.name} is over-granted`,
        detail: `Grants exceed the reserve by ${figure(Math.abs(p.available))} shares. Increase the plan reserve or cancel grants.`,
        dueDate: null, amount: null,
      });
    }
  }

  // --- Post-termination exercise windows --------------------------------
  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  for (const holder of data.stakeholders) {
    if (!holder.terminationDate) continue;
    for (const award of data.awards) {
      if (award.stakeholderId !== holder.id || award.status !== 'OUTSTANDING') continue;
      if (award.type === 'RSU') continue;
      // A recorded 0 is a window that closes on the day the holder leaves, as
      // awardIsLive() (captable.ts) reads it; only a missing one takes the policy.
      const months = award.ptepMonths ?? enginePolicy().postTerminationExerciseMonths;
      const deadline = addMonths(holder.terminationDate, months);
      const daysLeft = daysBetween(asOf, deadline);
      const schedule = scheduleById.get(award.vestingScheduleId);
      const vested = schedule
        ? summarizeVesting({ schedule, totalQuantity: award.quantity, vestingStartDate: award.vestingStartDate, terminationDate: holder.terminationDate }, asOf).vested
        : award.quantity;
      const exercisable = Math.max(0, roundShares(vested - award.exercisedQuantity));
      if (exercisable <= 0) continue;
      if (daysLeft < 0) {
        push({
          rule: 'PTEP_EXPIRED', severity: 'WARNING', subjectType: 'AWARD', subjectId: award.id,
          title: 'Post-termination exercise window has lapsed',
          detail: `${holder.name} left on ${holder.terminationDate}; ${months === 0 ? 'the exercise window closed that day' : `the ${months}-month window closed on ${deadline}`} with ${figure(Math.round(exercisable))} vested shares unexercised. The grant should be marked expired.`,
          dueDate: deadline, amount: null,
        });
      } else if (daysLeft <= policy.exerciseWindowWarnDays) {
        push({
          rule: 'PTEP_EXPIRING', severity: 'WARNING', subjectType: 'AWARD', subjectId: award.id,
          title: `Exercise window closes in ${daysLeft} days`,
          detail: `${holder.name} has ${figure(Math.round(exercisable))} vested shares that expire on ${deadline}.`,
          dueDate: deadline, amount: null,
        });
      }
    }
  }

  // --- Option expirations ----------------------------------------------
  for (const award of data.awards) {
    if (award.status !== 'OUTSTANDING' || !award.expirationDate) continue;
    const daysLeft = daysBetween(asOf, award.expirationDate);
    const outstanding = awardOutstanding(award);
    if (outstanding <= 0) continue;
    if (daysLeft < 0) {
      push({
        rule: 'GRANT_EXPIRED', severity: 'WARNING', subjectType: 'AWARD', subjectId: award.id,
        title: 'Grant has passed its expiration date',
        detail: `${award.label ?? 'A grant'} expired on ${award.expirationDate} with ${figure(Math.round(outstanding))} shares outstanding.`,
        dueDate: award.expirationDate, amount: null,
      });
    } else if (daysLeft <= policy.grantExpiryNoticeDays) {
      push({
        rule: 'GRANT_EXPIRING', severity: 'INFO', subjectType: 'AWARD', subjectId: award.id,
        title: `Grant expires in ${daysLeft} days`,
        detail: `${award.label ?? 'A grant'} expires on ${award.expirationDate}.`,
        dueDate: award.expirationDate, amount: null,
      });
    }
  }

  // --- Convertible maturity ---------------------------------------------
  for (const c of data.convertibles) {
    if (c.status !== 'OUTSTANDING' || !c.maturityDate) continue;
    const daysLeft = daysBetween(asOf, c.maturityDate);
    const holder = data.stakeholders.find((s) => s.id === c.stakeholderId);
    if (daysLeft < 0) {
      push({
        rule: 'NOTE_MATURED', severity: 'ERROR', subjectType: 'CONVERTIBLE', subjectId: c.id,
        title: 'Convertible note has matured',
        detail: `The note held by ${holder?.name ?? 'an investor'} matured on ${c.maturityDate} and is repayable on demand unless extended or converted.`,
        dueDate: c.maturityDate, amount: c.principal,
      });
    } else if (daysLeft <= policy.noteMaturityWarnDays) {
      push({
        rule: 'NOTE_MATURING', severity: 'WARNING', subjectType: 'CONVERTIBLE', subjectId: c.id,
        title: `Note matures in ${daysLeft} days`,
        detail: `The note held by ${holder?.name ?? 'an investor'} matures on ${c.maturityDate}.`,
        dueDate: c.maturityDate, amount: c.principal,
      });
    }
  }

  // --- Form 3921: ISO exercises are reported to the IRS and the employee each year ----
  for (const status of form3921Status(input, asOf, { cancellationDates: opts.cancellationDates })) {
    if (status.state !== 'DUE' && status.state !== 'OVERDUE') continue;
    push({
      rule: 'FORM_3921', severity: status.state === 'OVERDUE' ? 'ERROR' : 'WARNING',
      subjectType: 'COMPANY', subjectId: null,
      title: status.state === 'OVERDUE'
        ? `Form 3921 for ${status.year} is overdue`
        : `Form 3921 for ${status.year} — ${status.count} ISO exercise${status.count === 1 ? '' : 's'} to report`,
      detail: status.state === 'OVERDUE'
        ? `${status.count} incentive stock option exercise${status.count === 1 ? '' : 's'} in ${status.year} ${status.count === 1 ? 'has' : 'have'} not been recorded as reported. Copy B was due to employees by ${status.deadlines.furnish} and the IRS filing by ${status.deadlines.fileElectronic}; penalties accrue per form.`
        : `Furnish Copy B to each employee by ${status.deadlines.furnish} and file with the IRS by ${status.deadlines.filePaper} on paper or ${status.deadlines.fileElectronic} electronically. Record the filing here once done.`,
      dueDate: asOf <= status.deadlines.furnish ? status.deadlines.furnish : status.deadlines.fileElectronic,
      amount: null,
    });
  }

  // --- Beneficial ownership information (Corporate Transparency Act) ----
  if (opts.boiStatus === 'REQUIRED') {
    const report = beneficialOwnershipReport(data, { asOf, titles: opts.titles });
    const filings = (data.filings ?? []).filter((f) => f.kind === 'BOI').sort((a, b) => a.filedOn.localeCompare(b.filedOn));
    const last = filings[filings.length - 1];
    if (!last) {
      push({
        rule: 'BOI_REPORT', severity: 'ERROR', subjectType: 'COMPANY', subjectId: null,
        title: 'Beneficial ownership report not filed',
        detail: `The company is marked as a reporting company but no BOI report is on record. Initial reports are due within 30 days of registering to do business; ${report.owners.length} beneficial owner${report.owners.length === 1 ? '' : 's'} identified so far.`,
        dueDate: null, amount: null,
      });
    } else if (report.changedSince(last.filedOn)) {
      push({
        rule: 'BOI_UPDATE', severity: 'WARNING', subjectType: 'COMPANY', subjectId: null,
        title: 'Beneficial ownership may have changed since the last report',
        detail: `Ownership or control changed after the report filed on ${last.filedOn}. Updated reports are due within 30 days of a change in beneficial owners or their details.`,
        dueDate: null, amount: null,
      });
    }
  }

  const order: Record<Severity, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
}

/**
 * How the score is worked out. It starts at `start` and every finding takes
 * points off by how serious it is; passing a check adds nothing, so a company
 * with no findings scores `start` and the number only ever says how much there
 * is to fix. The score takes the words of the first band, highest first, whose
 * `min` it reaches. The page prints these same figures, so its explanation and
 * the number cannot drift apart.
 */
export interface ComplianceScoring {
  start: number;
  points: Record<Severity, number>;
  bands: { min: number; label: string }[];
}

const scoringFrom = (s: EnginePolicy['compliance']['scoring']): ComplianceScoring => ({
  start: s.start,
  points: { ERROR: s.points.error, WARNING: s.points.warning, INFO: s.points.info },
  bands: s.bands.map((b) => ({ min: b.min, label: b.label })),
});

/** The scoring in force: compliance.scoring in the param file, read when the score is worked out. */
export const complianceScoring = (): ComplianceScoring => scoringFrom(enginePolicy().compliance.scoring);

/**
 * The built-in scoring (start at 100; 12, 4 and 1 points off), before any param
 * file is applied. Kept for callers that want the defaults; complianceScoring()
 * is the one the score uses.
 */
export const COMPLIANCE_SCORING: ComplianceScoring = scoringFrom(DEFAULT_ENGINE_POLICY.compliance.scoring);

export type CheckStatus = 'PASS' | 'REVIEW' | 'FAIL' | 'NOT_APPLICABLE';

/**
 * One area the checks cover, and how it came out. Findings say what is wrong;
 * this says what was looked at, so a company can see what is in good order as
 * well as what is not, and which checks had nothing to look at.
 */
export interface ComplianceCheck {
  id: string;
  label: string;
  /** The finding rules this area produces, for linking a finding to its area. */
  rules: string[];
  status: CheckStatus;
  /** What the check looks at, in one sentence. */
  description: string;
  /** How it came out: the good point when it passes, or why it does not apply. */
  summary: string;
  findings: number;
}

export interface ComplianceSummary {
  errors: number;
  warnings: number;
  info: number;
  score: number;      // 0..scoring.start
  /** The words for the band the score falls in. */
  band: string;
  issues: ComplianceIssue[];
  checks: ComplianceCheck[];
  scoring: ComplianceScoring;
}

export function complianceSummary(data: CompanyData, opts: ComplianceOptions = {}): ComplianceSummary {
  const issues = runComplianceChecks(data, opts);
  const errors = issues.filter((i) => i.severity === 'ERROR').length;
  const warnings = issues.filter((i) => i.severity === 'WARNING').length;
  const info = issues.filter((i) => i.severity === 'INFO').length;
  const scoring = complianceScoring();
  const { start, points } = scoring;
  const score = Math.max(0, Math.round(start - errors * points.ERROR - warnings * points.WARNING - info * points.INFO));
  const band = (scoring.bands.find((b) => score >= b.min) ?? scoring.bands.at(-1))?.label ?? '';
  return { errors, warnings, info, score, band, issues, checks: complianceChecks(data, issues, opts), scoring };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${figure(n)} ${n === 1 ? one : many}`;

/**
 * Every area the checks cover, with what it found. An area passes when it
 * produced no must-fix or should-review finding; a for-information note alone
 * does not stop it passing. An area with nothing to look at, such as ISOs at a
 * company that has granted none, is not applicable rather than passed, so the
 * good points are ones the company has earned.
 */
export function complianceChecks(input: CompanyData, issues: ComplianceIssue[], opts: ComplianceOptions = {}): ComplianceCheck[] {
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const policy = enginePolicy().compliance;
  const money = (c: number) => formatMoney(c, { compact: true });
  const granted = data.awards.filter((a) => !PENDING_AWARD.has(a.status) && a.grantDate <= asOf);
  const priced = granted.filter((a) => ['ISO', 'NSO', 'SAR'].includes(a.type));
  const isos = granted.filter((a) => a.type === 'ISO');
  const outstanding = data.awards.filter((a) => a.status === 'OUTSTANDING' && a.grantDate <= asOf);
  const table = computeCapTable(data, { asOf });
  const restricted = election83bRows(input, asOf);
  const r701 = rule701Test(input, asOf, opts.totalAssets ?? 0, { fiscalYearEnd: opts.fiscalYearEnd });
  const refresh = valuationRefresh(data, asOf, policy.valuationExpiryWarningDays);
  const departed = new Set(data.stakeholders.filter((s) => s.terminationDate).map((s) => s.id));
  const leaversWithOptions = new Set(outstanding.filter((a) => a.type !== 'RSU' && departed.has(a.stakeholderId)).map((a) => a.stakeholderId));
  const expiring = outstanding.filter((a) => a.expirationDate && awardOutstanding(a) > 0);
  const notes = data.convertibles.filter((c) => c.status === 'OUTSTANDING' && c.maturityDate);
  const iso3921 = form3921Status(input, asOf, { cancellationDates: opts.cancellationDates }).filter((s) => s.count > 0);
  const boiFiled = (data.filings ?? []).filter((f) => f.kind === 'BOI').sort((a, b) => a.filedOn.localeCompare(b.filedOn)).at(-1);

  // Each area: its rules, what it checks, and, when it passes or has nothing to
  // check, the sentence that says so. Null for `na` means it always applies.
  const areas: { id: string; label: string; rules: string[]; description: string; na: string | null; pass: string }[] = [
    {
      id: 'VALUATION_409A', label: '409A valuation', rules: ['VALUATION_409A'],
      description: 'A current 409A valuation supports the strike price of new option grants, for twelve months at most and until a priced round.',
      na: !refresh.current && priced.length === 0 ? 'No options or rights with a strike price have been granted, so no 409A valuation is needed yet.' : null,
      pass: refresh.current
        ? `The 409A valuation of ${longDate(refresh.current.effectiveDate)} supports new grants until ${longDate(refresh.current.expiresOn)}, and no financing since has ended it.`
        : 'A current 409A valuation is on file.',
    },
    {
      id: 'STRIKE_PRICE', label: 'Strike prices', rules: ['STRIKE_BELOW_FMV'],
      description: 'Every option and stock appreciation right is priced at or above the fair market value on its grant date, with a 409A valuation behind it.',
      na: priced.length === 0 ? 'No options or rights with a strike price have been granted.' : null,
      pass: priced.length === 1
        ? 'The one option granted was priced at or above the fair market value on its grant date, with a 409A valuation behind it.'
        : `All ${plural(priced.length, 'option or right', 'options and rights')} were granted at or above the fair market value on their grant date, each with a 409A valuation behind it.`,
    },
    {
      id: 'BOARD_APPROVAL', label: 'Board approval', rules: ['BOARD_APPROVAL'],
      description: 'Every outstanding grant has board approval, dated on or before the grant.',
      na: outstanding.length === 0 ? 'No grants are outstanding.' : null,
      pass: outstanding.length === 1
        ? 'The one outstanding grant has board approval dated on or before the grant.'
        : `All ${plural(outstanding.length, 'outstanding grant')} have board approval dated on or before the grant.`,
    },
    {
      id: '83B', label: '83(b) elections', rules: ['83B_DEADLINE'],
      description: 'Restricted stock, which vests over time or was bought early, has its 83(b) election filed within the 30 days.',
      na: restricted.length === 0 ? 'No restricted stock is outstanding, so no 83(b) election is needed.' : null,
      pass: `An 83(b) election is on file for ${restricted.length === 1 ? 'the one restricted stock purchase' : `all ${plural(restricted.length, 'restricted stock purchase')}`}.`,
    },
    {
      id: 'ISO_100K', label: 'ISO $100K limit', rules: ['ISO_100K'],
      description: 'No employee has more than $100,000 of incentive stock options first exercisable in one calendar year.',
      na: isos.length === 0 ? 'No incentive stock options have been granted.' : null,
      pass: `No employee is over the $100,000 limit in any year, across ${plural(isos.length, 'ISO grant')}.`,
    },
    {
      id: 'RULE_701', label: 'Rule 701', rules: ['RULE_701', 'RULE_701_DISCLOSURE'],
      description: 'Compensatory grants over the last twelve months stay within the Rule 701 limit, and below the level that calls for enhanced disclosure.',
      na: null,
      pass: r701.aggregateValue === 0
        ? 'No compensatory grants in the last twelve months, so nothing counts towards the Rule 701 limit.'
        : `Compensatory grants over the last twelve months total ${money(r701.aggregateValue)}, within the ${money(r701.applicableLimit)} limit, with ${money(r701.headroom)} to spare.`,
    },
    {
      id: 'FORM_3921', label: 'Form 3921', rules: ['FORM_3921'],
      description: 'Every calendar year with incentive stock option exercises has its Form 3921 furnished to employees and filed with the IRS on time.',
      na: iso3921.length === 0 ? 'No incentive stock options have been exercised, so there is nothing to report.' : null,
      pass: iso3921.every((s) => s.state === 'FILED')
        ? `Form 3921 is recorded as filed for ${iso3921.length === 1 ? String(iso3921[0].year) : `every year with ISO exercises (${iso3921.map((s) => s.year).join(', ')})`}.`
        : `Nothing is due yet: ${iso3921.filter((s) => s.state !== 'FILED').map((s) => `${s.year}'s forms go out by ${longDate(s.deadlines.furnish)}`).join('; ')}.`,
    },
    {
      id: 'AUTHORIZED_SHARES', label: 'Authorized shares', rules: ['OVER_ISSUANCE', 'AUTHORIZED_CAPACITY'],
      description: 'No share class has more shares outstanding than the charter authorizes, or fewer left unissued than it must keep reserved, and common stock has room left to issue.',
      na: table.classes.length === 0 ? 'No share classes are set up yet.' : null,
      pass: `${table.classes.length === 1 ? 'The share class is' : `All ${plural(table.classes.length, 'share class', 'share classes')} are`} within the authorized shares, with room to issue more common stock.`,
    },
    {
      id: 'PLAN_RESERVE', label: 'Plan reserve', rules: ['POOL_OVERALLOCATED'],
      description: 'Grants from each equity plan stay within the shares it reserves.',
      na: table.pools.length === 0 ? 'No equity plan is set up.' : null,
      pass: `Grants are within the reserve of ${table.pools.length === 1 ? 'the equity plan' : `all ${plural(table.pools.length, 'equity plan')}`}.`,
    },
    {
      id: 'EXERCISE_WINDOWS', label: 'Exercise windows', rules: ['PTEP_EXPIRED', 'PTEP_EXPIRING'],
      description: 'People who left with vested options are not about to lose them, and lapsed windows have been dealt with.',
      na: leaversWithOptions.size === 0 ? 'Nobody who has left still holds outstanding options.' : null,
      pass: `No exercise window is lapsed or closing within ${plural(policy.exerciseWindowWarnDays, 'day')} for the ${plural(leaversWithOptions.size, 'person', 'people')} who left holding options.`,
    },
    {
      id: 'GRANT_EXPIRY', label: 'Grant expiry', rules: ['GRANT_EXPIRED', 'GRANT_EXPIRING'],
      description: 'No outstanding grant is still on the books after its expiration date.',
      na: expiring.length === 0 ? 'No outstanding grant has an expiration date set.' : null,
      pass: expiring.length === 1
        ? 'The one grant with an expiration date is not past it.'
        : `None of the ${plural(expiring.length, 'grant')} with an expiration date is past it.`,
    },
    {
      id: 'NOTE_MATURITY', label: 'Note maturity', rules: ['NOTE_MATURED', 'NOTE_MATURING'],
      description: `No convertible note has matured, or matures within ${plural(policy.noteMaturityWarnDays, 'day')}, without being converted or extended.`,
      na: notes.length === 0 ? 'No convertible notes with a maturity date are outstanding.' : null,
      pass: notes.length === 1
        ? `The outstanding note has not matured and does not mature within ${plural(policy.noteMaturityWarnDays, 'day')}.`
        : `None of the ${plural(notes.length, 'outstanding note')} has matured or matures within ${plural(policy.noteMaturityWarnDays, 'day')}.`,
    },
    {
      id: 'BOI', label: 'BOI reporting', rules: ['BOI_REPORT', 'BOI_UPDATE'],
      description: 'A reporting company has its beneficial ownership report filed with FinCEN, and updated after changes.',
      na: opts.boiStatus !== 'REQUIRED' ? 'The company is marked as exempt from beneficial ownership reporting.' : null,
      pass: boiFiled ? `The beneficial ownership report filed on ${longDate(boiFiled.filedOn)} is current.` : 'The beneficial ownership report is current.',
    },
  ];

  return areas.map((a) => {
    const found = issues.filter((i) => a.rules.includes(i.rule));
    const status: CheckStatus = found.some((i) => i.severity === 'ERROR') ? 'FAIL'
      : found.some((i) => i.severity === 'WARNING') ? 'REVIEW'
        : a.na ? 'NOT_APPLICABLE' : 'PASS';
    const serious = found.filter((i) => i.severity !== 'INFO').length;
    return {
      id: a.id, label: a.label, rules: a.rules, status, description: a.description, findings: found.length,
      summary: status === 'PASS' ? a.pass : status === 'NOT_APPLICABLE' ? a.na!
        : `${plural(serious, 'finding')} to deal with, listed above.`,
    };
  });
}

export { ISO_ANNUAL_LIMIT };

// ---------------------------------------------------------------------------
// 83(b) elections, certificate by certificate
// ---------------------------------------------------------------------------

export interface Election83bRow {
  issuanceId: string;
  certificateNo: string | null;
  stakeholderId: string;
  stakeholderName: string;
  shareClassId: string;
  quantity: number;
  issueDate: ISODate;
  /**
   * Thirty days from the transfer, or the next business day when the thirtieth
   * is a weekend or legal holiday (IRC 7503); the IRS does not extend it.
   */
  deadline: ISODate;
  filedOn: ISODate | null;
  /** Why the stock is restricted: it vests over time, or was early-exercised. */
  reason: 'vesting' | 'early exercise';
  status: 'FILED' | 'OPEN' | 'CLOSED';
  daysLeft: number;
}

/** Every outstanding certificate that carries a risk of forfeiture, and where its election stands. */
export function election83bRows(input: CompanyData, asOf: ISODate = today()): Election83bRow[] {
  const data = normalizeSplits(input, asOf);
  const rows: Election83bRow[] = [];
  for (const iss of data.issuances) {
    if (iss.status !== 'OUTSTANDING') continue;
    const schedule = iss.vestingScheduleId ? data.vestingSchedules.find((v) => v.id === iss.vestingScheduleId) : undefined;
    const vestsOverTime = schedule ? schedule.kind !== 'FULLY_VESTED' && !(schedule.durationMonths === 0 && schedule.cliffMonths === 0) : iss.vestingScheduleId != null;
    if (!vestsOverTime && !iss.earlyExercised) continue;
    const deadline = businessDayOnOrAfter(addDays(iss.issueDate, 30));
    const daysLeft = daysBetween(asOf, deadline);
    const holder = data.stakeholders.find((s) => s.id === iss.stakeholderId);
    rows.push({
      issuanceId: iss.id, certificateNo: iss.certificateNo, stakeholderId: iss.stakeholderId,
      stakeholderName: holder?.name ?? 'Unknown holder', shareClassId: iss.shareClassId, quantity: iss.quantity,
      issueDate: iss.issueDate, deadline, filedOn: iss.election83bFiledOn,
      reason: vestsOverTime ? 'vesting' : 'early exercise',
      status: iss.election83bFiledOn ? 'FILED' : daysLeft < 0 ? 'CLOSED' : 'OPEN', daysLeft,
    });
  }
  return rows.sort((a, b) => a.deadline.localeCompare(b.deadline));
}

// ---------------------------------------------------------------------------
// Form 3921 — exercise of an incentive stock option (IRC 6039)
// ---------------------------------------------------------------------------

export interface Form3921Row {
  exerciseId: string;
  stakeholderId: string;
  stakeholderName: string;
  awardId: string;
  awardLabel: string | null;
  /** Box 1 */ grantDate: ISODate;
  /** Box 2 */ exerciseDate: ISODate;
  /** Box 3 */ exercisePrice: PricePerShare;
  /** Box 4 */ fmvAtExercise: PricePerShare;
  /** Box 5 */ quantity: number;
  spread: Cents;
}

export interface Form3921Deadlines {
  /** Copy B to the employee. */
  furnish: ISODate;
  /** Copy A to the IRS on paper. */
  filePaper: ISODate;
  /** Copy A to the IRS electronically (required at 10 or more information returns). */
  fileElectronic: ISODate;
}

export interface Form3921Status {
  year: number;
  count: number;
  deadlines: Form3921Deadlines;
  filing: ComplianceFiling | null;
  state: 'NOTHING_TO_FILE' | 'UPCOMING' | 'DUE' | 'OVERDUE' | 'FILED';
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * The dates for exercises in `year`: January 31, February 28 (29) and March 31
 * of the next year, each moved to the next business day when it falls on a
 * weekend or legal holiday (IRC 7503; General Instructions for Certain
 * Information Returns, part C).
 */
export function form3921Deadlines(year: number): Form3921Deadlines {
  const next = year + 1;
  return {
    furnish: businessDayOnOrAfter(`${next}-01-31`),
    filePaper: businessDayOnOrAfter(`${next}-02-${isLeap(next) ? '29' : '28'}`),
    fileElectronic: businessDayOnOrAfter(`${next}-03-31`),
  };
}

/**
 * ISO exercises in a calendar year, with the boxes the form asks for. Only ISO
 * stock is reported: shares over the $100,000 limit are NSO stock and go on the
 * W-2 (IRC 422(d), 6039(a)). With no designation the ISO shares of a grant are
 * the first exercised (Treas. Reg. 1.422-4(c)(2)), so Box 5 takes each exercise's
 * shares up to what the grant has left of its ISO shares first exercisable by
 * then, and an exercise of NSO stock alone has no form.
 */
export function form3921Rows(input: CompanyData, year: number, opts: ISOLimitOptions = {}): Form3921Row[] {
  // Every grant that can have been exercised in the year is in the ISO test.
  const asOf = maxDate(today(), `${year}-12-31`);
  const data = normalizeSplits(input, asOf);
  const exercises: Exercise[] = [...(data.exercises ?? [])].sort((a, b) => a.exerciseDate.localeCompare(b.exerciseDate));
  const isoRows = isoHundredKTest(input, asOf, opts);
  // ISO shares used by earlier exercises, by award, on today's split-adjusted
  // basis; exercises are recorded in the shares of their own date.
  const isoUsed = new Map<string, number>();
  const rows: Form3921Row[] = [];
  for (const ex of exercises) {
    if (ex.status && ex.status !== 'COMPLETED') continue;
    const exerciseYear = Number(ex.exerciseDate.slice(0, 4));
    if (exerciseYear > year) break;
    const award = data.awards.find((a) => a.id === ex.awardId);
    if (!award || award.type !== 'ISO') continue;
    const k = splitFactor(input, ex.exerciseDate, asOf);
    const isoShares = isoRows.filter((r) => r.awardId === award.id && r.year <= exerciseYear).reduce((s, r) => s + r.isoQualified, 0);
    // Whole shares: the share that would carry the grant past $100,000 is NSO
    // stock (at a $3 grant-date FMV, 33,333 shares are ISO stock, not 33,333.33).
    const left = Math.max(0, isoShares - (isoUsed.get(award.id) ?? 0));
    const quantity = Math.min(ex.quantity, floorShares(roundShares(left / k)));
    isoUsed.set(award.id, (isoUsed.get(award.id) ?? 0) + quantity * k);
    if (exerciseYear !== year || quantity <= 0) continue;
    const holder = data.stakeholders.find((s) => s.id === ex.stakeholderId);
    rows.push({
      exerciseId: ex.id, stakeholderId: ex.stakeholderId, stakeholderName: holder?.name ?? 'Unknown holder',
      awardId: award.id, awardLabel: award.label ?? null, grantDate: award.grantDate, exerciseDate: ex.exerciseDate,
      exercisePrice: ex.strikePrice, fmvAtExercise: ex.fmvAtExercise, quantity,
      spread: Math.max(0, shareValue(quantity, ex.fmvAtExercise) - shareValue(quantity, ex.strikePrice)),
    });
  }
  return rows.sort((a, b) => a.exerciseDate.localeCompare(b.exerciseDate) || a.stakeholderName.localeCompare(b.stakeholderName));
}

/** Where each year with ISO exercises stands — plus the current and previous year, so the page always has something to show. */
export function form3921Status(input: CompanyData, asOf: ISODate = today(), opts: ISOLimitOptions = {}): Form3921Status[] {
  const currentYear = Number(asOf.slice(0, 4));
  const years = new Set<number>([currentYear - 1, currentYear]);
  for (const ex of input.exercises ?? []) years.add(Number(ex.exerciseDate.slice(0, 4)));
  return [...years].sort().map((year) => {
    const count = form3921Rows(input, year, opts).length;
    const deadlines = form3921Deadlines(year);
    const filing = (input.filings ?? []).find((f) => f.kind === 'FORM_3921' && f.period === String(year)) ?? null;
    let state: Form3921Status['state'];
    if (filing) state = 'FILED';
    else if (count === 0) state = 'NOTHING_TO_FILE';
    else if (year >= currentYear) state = 'UPCOMING';
    else if (asOf > deadlines.fileElectronic) state = 'OVERDUE';
    else state = 'DUE';
    return { year, count, deadlines, filing, state };
  });
}

// ---------------------------------------------------------------------------
// Beneficial ownership information (Corporate Transparency Act / FinCEN)
// ---------------------------------------------------------------------------

export type BoiStatus = 'EXEMPT_DOMESTIC' | 'REQUIRED' | 'EXEMPT_OTHER';

export interface BeneficialOwner {
  stakeholderId: string;
  name: string;
  type: string;
  relation: string;
  title: string | null;
  /** Ownership interests with the person's own options treated as exercised, as the rule measures. */
  ownershipPct: number;
  reasons: ('ownership' | 'control')[];
  /** Date of the earliest holding or appointment on record, to tell new owners from long-standing ones. */
  since: ISODate | null;
}

export interface BeneficialOwnershipReport {
  asOf: ISODate;
  owners: BeneficialOwner[];
  /** Entities at or above the threshold: the individuals behind them must be identified. */
  entitiesToLookThrough: BeneficialOwner[];
  /** True when an owner's holding began after the given date. */
  changedSince: (date: ISODate) => boolean;
}

const OWNERSHIP_THRESHOLD = 0.25;
const SENIOR_OFFICER = /\b(chief|ceo|cfo|coo|cto|president|general counsel|gc|founder|co-founder|cofounder|managing (director|member)|director)\b/i;

/**
 * Who FinCEN's rule would call a beneficial owner: anyone with 25% or more of
 * the ownership interests (options counted as exercised for that person) and
 * anyone with substantial control — senior officers, founders and directors.
 */
export function beneficialOwnershipReport(
  input: CompanyData, opts: { asOf?: ISODate; titles?: Record<string, string | null> } = {},
): BeneficialOwnershipReport {
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const table = computeCapTable(data, { asOf, includeUnallocatedPool: false });
  const titles = opts.titles ?? {};
  const owners: BeneficialOwner[] = [];
  const entities: BeneficialOwner[] = [];
  for (const row of table.rows) {
    if (!row.stakeholderId) continue;
    const holder = data.stakeholders.find((s) => s.id === row.stakeholderId);
    if (!holder) continue;
    const title = titles[holder.id] ?? null;
    // "Any options or similar interests of the individual shall be treated as
    // exercised" (31 CFR 1010.380(d)(2)(iii)), and nobody else's: the base is
    // the shares outstanding plus this holder's own options, RSUs and warrants,
    // not the fully diluted count with everyone's options and the pool.
    const own = roundShares(row.fullyDiluted - row.asConverted);
    const ownershipPct = pct(row.fullyDiluted, table.totals.asConverted + own);
    const reasons: BeneficialOwner['reasons'] = [];
    if (ownershipPct >= OWNERSHIP_THRESHOLD) reasons.push('ownership');
    // A director is whoever holds a board seat that day, whatever the relation says.
    const controls = holder.relation === 'FOUNDER' || isDirector(holder, asOf) || (title != null && SENIOR_OFFICER.test(title));
    if (controls && holder.type === 'INDIVIDUAL') reasons.push('control');
    if (reasons.length === 0) continue;
    const firstDates = [
      ...data.issuances.filter((i) => i.stakeholderId === holder.id).map((i) => i.issueDate),
      ...data.awards.filter((a) => a.stakeholderId === holder.id).map((a) => a.grantDate),
      ...(holder.startDate ? [holder.startDate] : []),
    ].sort();
    const entry: BeneficialOwner = {
      stakeholderId: holder.id, name: holder.name, type: holder.type, relation: holder.relation, title,
      ownershipPct, reasons, since: firstDates[0] ?? null,
    };
    (holder.type === 'INDIVIDUAL' ? owners : entities).push(entry);
  }
  const byShare = (a: BeneficialOwner, b: BeneficialOwner) => b.ownershipPct - a.ownershipPct || a.name.localeCompare(b.name);
  owners.sort(byShare);
  entities.sort(byShare);
  return {
    asOf, owners, entitiesToLookThrough: entities,
    changedSince: (date) => [...owners, ...entities].some((o) => o.since != null && o.since > date),
  };
}
