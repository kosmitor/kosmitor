import type { CompanyData, ISODate, Cents, PricePerShare, Award } from './types.ts';
import { activeValuation, PENDING_AWARD, awardIsLive, awardPosition } from './captable.ts';
import { summarizeVesting } from './vesting.ts';
import { shareValue, addDays, addMonths, daysBetween, today } from './util.ts';
import { normalizeSplits } from './splits.ts';
import { enginePolicy, DEFAULT_ENGINE_POLICY } from './policy.ts';

/**
 * Simplified tax estimates for equity decisions. These are planning figures,
 * not tax advice: they use flat marginal rates supplied by the caller rather
 * than modelling brackets, phase-outs, credits or state specifics.
 */
export interface TaxRates {
  federalOrdinary: number;    // e.g. 0.37
  stateOrdinary: number;      // e.g. 0.093
  federalLongTerm: number;    // e.g. 0.20
  stateLongTerm: number;
  amtRate: number;            // 0.26 / 0.28
  medicare: number;           // 0.0145 (+0.009 additional)
  socialSecurity: number;     // 0.062 up to the wage base
  niit: number;               // 0.038 net investment income tax
}

/**
 * The built-in rates. The ones an estimate falls back on are policy,
 * tax.defaultRates in the param file, read when the estimate is made.
 */
export const DEFAULT_RATES: TaxRates = { ...DEFAULT_ENGINE_POLICY.taxRates };

export interface ExerciseScenario {
  awardId: string;
  awardType: Award['type'];
  shares: number;
  strikePrice: PricePerShare;
  fmv: PricePerShare;
  exerciseCost: Cents;
  /** FMV less strike, the "spread" or bargain element. */
  spread: Cents;
  ordinaryIncome: Cents;
  amtPreference: Cents;
  estimatedFederalTax: Cents;
  estimatedStateTax: Cents;
  estimatedAmt: Cents;
  payrollTax: Cents;
  totalTaxDue: Cents;
  totalCashNeeded: Cents;
  /** Date the shares qualify for long-term capital gains. */
  longTermDate: ISODate | null;
  /** ISO qualifying disposition date: 2 years from grant and 1 year from exercise. */
  qualifyingDispositionDate: ISODate | null;
  notes: string[];
}

/**
 * Models the tax consequences of exercising a grant today.
 *
 *  - NSO: the spread is ordinary compensation income at exercise, subject to
 *    withholding and payroll taxes.
 *  - ISO: no regular tax at exercise, but the spread is an AMT preference
 *    item. A qualifying disposition needs 2 years from grant and 1 year from
 *    exercise.
 *  - RSU: income is recognised at settlement on the full FMV.
 */
export function modelExercise(
  input: CompanyData,
  grant: Award,
  shares: number,
  opts: { asOf?: ISODate; fmv?: PricePerShare; rates?: Partial<TaxRates> } = {},
): ExerciseScenario {
  const asOf = opts.asOf ?? today();
  const data = normalizeSplits(input, asOf);
  const award = data.awards.find((a) => a.id === grant.id) ?? grant;
  const rates = { ...enginePolicy().taxRates, ...opts.rates };
  const fmv = opts.fmv ?? activeValuation(data, asOf);
  const notes: string[] = [];

  if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(fmv) || fmv < 0) throw new RangeError('Shares and fair market value must be finite and nonnegative.');
  const exerciseCost = shareValue(shares, award.type === 'RSU' || award.type === 'PHANTOM' || award.type === 'SAR' ? 0 : award.strikePrice);
  // A SAR costs nothing to exercise and pays only the appreciation over its base
  // price; that payment is the wage (IRC 3121(a)), so it is the spread too.
  const spread = Math.max(0, shareValue(shares, fmv) - (award.type === 'SAR' ? shareValue(shares, award.strikePrice) : exerciseCost));

  let ordinaryIncome = 0;
  let amtPreference = 0;
  let payrollTax = 0;

  if (award.type === 'NSO' || award.type === 'SAR') {
    ordinaryIncome = spread;
    payrollTax = Math.round(spread * (rates.medicare + rates.socialSecurity));
    notes.push('The spread is ordinary income at exercise and is reported on Form W-2 with withholding due.');
  } else if (award.type === 'ISO') {
    amtPreference = spread;
    notes.push('No regular income tax is due at exercise, but the spread is an alternative minimum tax preference item reported on Form 6251.');
    const qualifying = maxDateOf(addDays(addMonths(award.grantDate, 24), 1), addDays(addMonths(asOf, 12), 1));
    notes.push(`Hold until ${qualifying} for a qualifying disposition taxed entirely at long-term capital gains rates.`);
  } else if (award.type === 'RSU' || award.type === 'PHANTOM') {
    ordinaryIncome = shareValue(shares, fmv);
    payrollTax = Math.round(ordinaryIncome * (rates.medicare + rates.socialSecurity));
    notes.push('RSUs are taxed on the full fair market value at settlement; shares are usually sold or withheld to cover it.');
  } else if (award.type === 'RSA') {
    ordinaryIncome = spread;
    notes.push('Filing an 83(b) election within 30 days taxes the spread now and starts the capital gains clock immediately.');
  }

  const estimatedFederalTax = Math.round(ordinaryIncome * rates.federalOrdinary);
  const estimatedStateTax = Math.round(ordinaryIncome * rates.stateOrdinary);
  const estimatedAmt = Math.round(amtPreference * rates.amtRate);
  const totalTaxDue = estimatedFederalTax + estimatedStateTax + estimatedAmt + payrollTax;

  if (award.type === 'ISO' && estimatedAmt > 0) {
    notes.push('AMT paid on an ISO exercise generally creates a minimum tax credit usable against regular tax in later years.');
  }
  if (exerciseCost > 0 && spread === 0) {
    notes.push('The grant is at or under water at the current fair market value — exercising has no bargain element today.');
  }

  return {
    awardId: award.id, awardType: award.type, shares,
    strikePrice: award.strikePrice, fmv, exerciseCost, spread,
    ordinaryIncome, amtPreference,
    estimatedFederalTax, estimatedStateTax, estimatedAmt, payrollTax,
    totalTaxDue, totalCashNeeded: exerciseCost + totalTaxDue,
    longTermDate: addDays(addMonths(asOf, 12), 1),
    qualifyingDispositionDate: award.type === 'ISO'
      ? maxDateOf(addDays(addMonths(award.grantDate, 24), 1), addDays(addMonths(asOf, 12), 1)) : null,
    notes,
  };
}

const maxDateOf = (a: ISODate, b: ISODate): ISODate => (a >= b ? a : b);

export interface ExitProceedsScenario {
  exitPricePerShare: PricePerShare;
  shares: number;
  grossProceeds: Cents;
  exerciseCost: Cents;
  ordinaryIncomePortion: Cents;
  capitalGainPortion: Cents;
  isLongTerm: boolean;
  estimatedTax: Cents;
  netProceeds: Cents;
  effectiveTaxRate: number;
}

/**
 * Net proceeds from selling exercised shares at an exit price. The fair market
 * value at exercise, or at settlement for an RSU, is required: it sets the
 * ordinary income (IRC 83(a)), and the grant-date value is no stand-in for it.
 */
export function modelSaleProceeds(
  award: Award,
  shares: number,
  exitPricePerShare: PricePerShare,
  opts: { exercisedOn?: ISODate; saleDate?: ISODate; rates?: Partial<TaxRates>; fmvAtExercise: PricePerShare },
): ExitProceedsScenario {
  const rates = { ...enginePolicy().taxRates, ...opts.rates };
  const saleDate = opts.saleDate ?? today();
  const exercisedOn = opts.exercisedOn ?? saleDate;
  const fmvAtExercise = opts.fmvAtExercise;

  if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(exitPricePerShare) || exitPricePerShare < 0) throw new RangeError('Shares and sale price must be finite and nonnegative.');
  if (!Number.isFinite(fmvAtExercise) || fmvAtExercise < 0) throw new RangeError('The fair market value at exercise or settlement is required and must be nonnegative.');
  if (saleDate < exercisedOn) throw new RangeError('Sale date cannot precede exercise.');
  const grossProceeds = shareValue(shares, exitPricePerShare);
  const exerciseCost = shareValue(shares, award.strikePrice);
  // "More than one year" / "more than two years": the holding period begins
  // the day after acquisition, so the anniversary itself does not qualify.
  const isLongTerm = saleDate > addMonths(exercisedOn, 12);
  const twoYearsFromGrant = saleDate > addMonths(award.grantDate, 24);

  let ordinaryIncomePortion = 0;
  let capitalGainPortion = 0;

  if (award.type === 'ISO') {
    const qualifying = isLongTerm && twoYearsFromGrant;
    if (qualifying) {
      capitalGainPortion = grossProceeds - exerciseCost;
    } else {
      // Disqualifying disposition: the spread at exercise becomes ordinary income.
      ordinaryIncomePortion = Math.max(0, Math.min(grossProceeds, shareValue(shares, fmvAtExercise)) - exerciseCost);
      capitalGainPortion = grossProceeds - exerciseCost - ordinaryIncomePortion;
    }
  } else if (award.type === 'RSU') {
    ordinaryIncomePortion = shareValue(shares, fmvAtExercise);
    capitalGainPortion = grossProceeds - ordinaryIncomePortion;
  } else {
    ordinaryIncomePortion = Math.max(0, shareValue(shares, fmvAtExercise) - exerciseCost);
    capitalGainPortion = grossProceeds - exerciseCost - ordinaryIncomePortion;
  }

  const gainRate = isLongTerm
    ? rates.federalLongTerm + rates.stateLongTerm + rates.niit
    : rates.federalOrdinary + rates.stateOrdinary + rates.niit;
  const estimatedTax =
    Math.round(ordinaryIncomePortion * (rates.federalOrdinary + rates.stateOrdinary)) +
    // Preserve reported capital losses, but do not invent a tax refund without
    // knowing the holder's other gains and annual deduction limits.
    Math.round(Math.max(0, capitalGainPortion) * gainRate);

  const netProceeds = grossProceeds - exerciseCost - estimatedTax;
  return {
    exitPricePerShare, shares, grossProceeds, exerciseCost,
    ordinaryIncomePortion, capitalGainPortion, isLongTerm,
    estimatedTax, netProceeds,
    effectiveTaxRate: grossProceeds > 0 ? estimatedTax / grossProceeds : 0,
  };
}

/**
 * QSBS (section 1202) eligibility screen for a holding.
 *
 * Stock issued on or before 4 July 2025: original issuance by a domestic C
 * corporation with gross assets of $50M or less, held more than five years;
 * the exclusion is capped at the greater of $10M or 10x basis.
 *
 * Stock issued after 4 July 2025 falls under the One Big Beautiful Bill Act
 * amendments: the gross-asset ceiling rises to $75M, the per-issuer cap to
 * $15M, and the holding period becomes tiered — 50% of the gain is excludable
 * after three years, 75% after four and 100% after five.
 */
export interface QSBSAssessment {
  eligible: boolean;
  holdingPeriodMet: boolean;
  /** Portion of the gain excludable today: 0, 0.5, 0.75 or 1. */
  exclusionPct: number;
  regime: 'ORIGINAL' | 'OBBBA_2025';
  /** First day the full (100%) exclusion is available. */
  fiveYearDate: ISODate;
  /** First day any exclusion is available. */
  firstExclusionDate: ISODate;
  daysRemaining: number;
  basis: Cents;
  exclusionCap: Cents;
  grossAssetLimit: Cents;
  reasons: string[];
}

/** Stock issued after this date is governed by the amended section 1202. */
export const OBBBA_QSBS_CUTOVER: ISODate = '2025-07-04';

export function assessQSBS(
  acquiredOn: ISODate, basis: Cents, opts: { asOf?: ISODate; isCCorp?: boolean; grossAssetsAtIssuance?: Cents } = {},
): QSBSAssessment {
  const asOf = opts.asOf ?? today();
  const amended = acquiredOn > OBBBA_QSBS_CUTOVER;
  // IRC 1202(a): the amended regime says "at least" 3/4/5 years;
  // pre-amendment stock still requires more than five years.
  const holdingMet = (years: number): boolean => amended
    ? asOf >= addMonths(acquiredOn, years * 12) : asOf > addMonths(acquiredOn, years * 12);
  const originalPct = acquiredOn > '2010-09-27' ? 1 : acquiredOn > '2009-02-17' ? 0.75 : 0.5;
  let exclusionPct = 0;
  if (holdingMet(5)) exclusionPct = amended ? 1 : originalPct;
  else if (amended && holdingMet(4)) exclusionPct = 0.75;
  else if (amended && holdingMet(3)) exclusionPct = 0.5;

  const fiveYearDate = addDays(addMonths(acquiredOn, 60), amended ? 0 : 1);
  const firstExclusionDate = amended ? addMonths(acquiredOn, 36) : fiveYearDate;
  const grossAssetLimit: Cents = amended ? 75_000_000_00 : 50_000_000_00;
  const capBase: Cents = amended ? 15_000_000_00 : 10_000_000_00;

  const reasons: string[] = [];
  if (acquiredOn <= '1993-08-10') reasons.push('QSBS must have been originally issued after August 10, 1993.');
  if (opts.isCCorp === false) reasons.push('QSBS requires stock in a domestic C corporation.');
  if ((opts.grossAssetsAtIssuance ?? 0) > grossAssetLimit) {
    reasons.push(`Gross assets exceeded $${(grossAssetLimit / 100).toLocaleString('en-US')} at issuance.`);
  }
  const structurallyEligible = reasons.length === 0;
  if (exclusionPct === 0) {
    reasons.push(`The ${amended ? 'three' : 'five'}-year holding period is met on ${firstExclusionDate}.`);
  } else if (amended && exclusionPct < 1) {
    reasons.push(`${Math.round(exclusionPct * 100)}% of the gain is excludable now; 100% from ${fiveYearDate}.`);
  }

  return {
    eligible: structurallyEligible && exclusionPct > 0,
    holdingPeriodMet: exclusionPct > 0,
    exclusionPct,
    regime: amended ? 'OBBBA_2025' : 'ORIGINAL',
    fiveYearDate, firstExclusionDate,
    daysRemaining: Math.max(0, daysBetween(asOf, exclusionPct >= 1 ? asOf : fiveYearDate)),
    basis,
    exclusionCap: Math.max(capBase, basis * 10),
    grossAssetLimit,
    reasons,
  };
}

/** A holder's full equity picture, valued at the current FMV. */
export function portfolioValue(input: CompanyData, stakeholderId: string, asOf: ISODate = today()) {
  const data = normalizeSplits(input, asOf);
  const fmv = activeValuation(data, asOf);
  const scheduleById = new Map(data.vestingSchedules.map((s) => [s.id, s]));
  const holder = data.stakeholders.find((s) => s.id === stakeholderId);

  let sharesOwned = 0, costBasis = 0;
  for (const iss of data.issuances) {
    if (iss.stakeholderId !== stakeholderId || iss.status !== 'OUTSTANDING' || iss.issueDate > asOf) continue;
    sharesOwned += iss.quantity;
    costBasis += shareValue(iss.quantity, iss.pricePerShare);
  }

  let vestedOptions = 0, unvestedOptions = 0, exerciseCostVested = 0, intrinsicVested = 0;
  const grants = [];
  for (const a of data.awards) {
    if (a.stakeholderId !== stakeholderId || !awardIsLive(a, asOf, holder?.terminationDate) || a.type === 'RSA') continue;
    const schedule = scheduleById.get(a.vestingScheduleId);
    const summary = schedule
      ? summarizeVesting({ schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate, terminationDate: holder?.terminationDate ?? null }, asOf)
      : null;
    // As the cap table counts it: a leaver's unvested part lapsed at termination.
    const { outstanding, vested, unvested } = awardPosition(a, schedule, holder?.terminationDate, asOf);
    vestedOptions += vested;
    unvestedOptions += unvested;
    exerciseCostVested += shareValue(vested, a.strikePrice);
    intrinsicVested += Math.max(0, shareValue(vested, fmv) - shareValue(vested, a.strikePrice));
    grants.push({
      award: a, outstanding, vested, unvested,
      percentVested: summary?.percentVested ?? 1,
      nextVestDate: summary?.nextVestDate ?? null,
      nextVestQuantity: summary?.nextVestQuantity ?? 0,
      intrinsicValue: Math.max(0, shareValue(vested, fmv) - shareValue(vested, a.strikePrice)),
      underwater: a.strikePrice > fmv,
    });
  }

  const sharesValue = shareValue(sharesOwned, fmv);
  return {
    fmv, sharesOwned, costBasis, sharesValue,
    unrealizedGain: sharesValue - costBasis,
    vestedOptions, unvestedOptions,
    exerciseCostVested, intrinsicVested,
    totalValue: sharesValue + intrinsicVested,
    grants,
  };
}
