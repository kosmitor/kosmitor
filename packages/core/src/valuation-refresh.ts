/**
 * When a company needs a new 409A valuation.
 *
 * Two parts of Treasury Regulation 1.409A-1(b)(5)(iv)(B) decide it. Paragraph
 * (B)(1) says a value is not reasonable if it fails to reflect information
 * available after it was calculated that may materially affect the company's
 * value, or if it was calculated as of a date more than twelve months before it
 * is used. Paragraph (B)(2)(i) gives an independent appraisal the presumption of
 * reasonableness, the safe harbor, when it is as of a date no more than twelve
 * months before the grant.
 *
 * This reads the cap table for evidence of both. It can see dates and
 * financings. It cannot see a lost customer, a change in the business or an
 * acquisition offer, so a clean answer here is not the whole answer, and the
 * wording that goes with it says so.
 */
import type { CompanyData, ISODate, PricePerShare, Cents, Valuation, Issuance } from './types.ts';
import { addMonths, daysBetween, today } from './util.ts';
import { enginePolicy, DEFAULT_ENGINE_POLICY } from './policy.ts';

export type RefreshReason = 'NO_VALUATION' | 'EXPIRED' | 'EXPIRING' | 'PRICED_ROUND' | 'CONVERTIBLE';

export interface RefreshTrigger {
  reason: RefreshReason;
  /**
   * REQUIRED means a grant made today would sit outside the safe harbor.
   * ADVISED means it is worth acting on, or raising with the appraiser, who decides.
   */
  severity: 'REQUIRED' | 'ADVISED';
  /** When it happened, or for an expiry, when it happens. Null when there is no date to give. */
  date: ISODate | null;
  /** The preferred class sold in a priced round. */
  shareClassName?: string;
  /** How many convertibles were issued, and what they raised. */
  count?: number;
  principal?: Cents;
  /** For EXPIRED: true when someone marked it expired, rather than its twelve months running out. */
  marked?: boolean;
}

export interface CurrentValuation {
  id: string;
  effectiveDate: ISODate;
  /** The end of its twelve months, or its stated expiry if sooner. Material events can end it earlier. */
  expiresOn: ISODate;
  fairMarketValue: PricePerShare;
  provider: string | null;
}

export interface ValuationRefresh {
  /** The 409A the company is relying on, or null when there is none. */
  current: CurrentValuation | null;
  /** Why a new one is due or soon will be, the required ones first. */
  triggers: RefreshTrigger[];
  /** True when at least one trigger is REQUIRED. */
  due: boolean;
}

/** How long an appraisal can support grants, counted from its valuation date. */
export const SAFE_HARBOR_MONTHS = 12;

/**
 * How far ahead of the end of the twelve months to start saying so, as built
 * in. The figure in force is policy, compliance.valuationExpiryWarningDays in
 * the param file, and valuationRefresh reads it when called.
 */
export const EXPIRY_WARNING_DAYS = DEFAULT_ENGINE_POLICY.compliance.valuationExpiryWarningDays;

/**
 * The last date a valuation supports a grant on age alone. A report can state a
 * shorter life than twelve months, and that is respected. It cannot state a
 * longer one: the twelve months come from the regulation, not from the report.
 */
export function safeHarborEnds(v: Pick<Valuation, 'effectiveDate' | 'expirationDate'>): ISODate {
  const cap = addMonths(v.effectiveDate, SAFE_HARBOR_MONTHS);
  return v.expirationDate && v.expirationDate < cap ? v.expirationDate : cap;
}

/** Shares that were actually sold, whatever has happened to them since. */
const SOLD = new Set(['OUTSTANDING', 'CONVERTED', 'TRANSFERRED', 'REPURCHASED']);
/** Convertibles that raised money, whatever has happened to them since. */
const RAISED = new Set(['OUTSTANDING', 'CONVERTED', 'REPAID']);
/** Awards whose strike price a 409A exists to support. */
const PRICED = new Set(['ISO', 'NSO', 'SAR']);

/**
 * True for the new certificate a share transfer creates. Moving shares from one
 * holder to another raises no money and sets no price for the company, so it is
 * not a financing. The transfer route marks the new certificate this way; the
 * ledger would be the stronger signal, but the engine is not given it.
 */
export const isTransferIssuance = (i: Pick<Issuance, 'notes'>): boolean =>
  /^Transferred from certificate\b/.test(i.notes ?? '');

/** The appraisals the company could be relying on as of a date, latest first. */
export function current409As(data: CompanyData, asOf: ISODate): Valuation[] {
  // Only an appraisal carries the safe harbor. A board estimate or the price of
  // the last round is a useful number, but not one a strike price can rest on.
  return data.valuations
    .filter((v) => v.type === '409A' && (v.status === 'ACTIVE' || v.status === 'EXPIRED') && v.effectiveDate <= asOf)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0));
}

export function valuationRefresh(
  data: CompanyData, asOf: ISODate = today(), warningDays: number = enginePolicy().compliance.valuationExpiryWarningDays,
): ValuationRefresh {
  const latest = current409As(data, asOf)[0];

  if (!latest) {
    // Without options to price there is nothing a 409A is holding up yet, so it
    // is advice until the first grant rather than a requirement.
    const grants = data.awards.some((a) => PRICED.has(a.type) && a.status !== 'CANCELLED' && a.status !== 'EXPIRED' && a.status !== 'FORFEITED');
    return {
      current: null,
      triggers: [{ reason: 'NO_VALUATION', severity: grants ? 'REQUIRED' : 'ADVISED', date: null }],
      due: grants,
    };
  }

  const expiresOn = safeHarborEnds(latest);
  const current: CurrentValuation = {
    id: latest.id, effectiveDate: latest.effectiveDate, expiresOn,
    fairMarketValue: latest.fairMarketValue, provider: latest.provider,
  };
  const triggers: RefreshTrigger[] = [];

  // A valuation still supports a grant on its last day, and not the day after.
  if (asOf > expiresOn) {
    triggers.push({ reason: 'EXPIRED', severity: 'REQUIRED', date: expiresOn });
  } else if (latest.status === 'EXPIRED') {
    // Marked expired before its twelve months ran out: there is no past date to
    // give, and printing its future end date as a past one would be wrong.
    triggers.push({ reason: 'EXPIRED', severity: 'REQUIRED', date: null, marked: true });
  } else if (daysBetween(asOf, expiresOn) <= warningDays) {
    triggers.push({ reason: 'EXPIRING', severity: 'ADVISED', date: expiresOn });
  }

  // A priced round sells preferred stock at a price the appraisal never saw. One
  // trigger per class, dated from its first sale after the valuation date.
  const classOf = new Map(data.shareClasses.map((c) => [c.id, c]));
  const firstSale = new Map<string, ISODate>();
  for (const i of data.issuances) {
    const cls = classOf.get(i.shareClassId);
    if (!cls || cls.kind !== 'PREFERRED' || !SOLD.has(i.status) || isTransferIssuance(i)) continue;
    if (i.issueDate <= latest.effectiveDate || i.issueDate > asOf) continue;
    const seen = firstSale.get(cls.id);
    if (!seen || i.issueDate < seen) firstSale.set(cls.id, i.issueDate);
  }
  for (const [classId, date] of firstSale) {
    triggers.push({ reason: 'PRICED_ROUND', severity: 'REQUIRED', date, shareClassName: classOf.get(classId)!.name });
  }

  // A SAFE or a note sets no price for the stock, so whether it is material is a
  // judgment for the appraiser. It is raised, not decided.
  const later = data.convertibles.filter((c) => RAISED.has(c.status) && c.issueDate > latest.effectiveDate && c.issueDate <= asOf);
  if (later.length > 0) {
    triggers.push({
      reason: 'CONVERTIBLE', severity: 'ADVISED',
      date: later.reduce((min, c) => (c.issueDate < min ? c.issueDate : min), later[0].issueDate),
      count: later.length,
      principal: later.reduce((sum, c) => sum + c.principal, 0),
    });
  }

  triggers.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'REQUIRED' ? -1 : 1)
    || String(a.date ?? '').localeCompare(String(b.date ?? ''))
    || String(a.shareClassName ?? '').localeCompare(String(b.shareClassName ?? '')));

  return { current, triggers, due: triggers.some((t) => t.severity === 'REQUIRED') };
}

/**
 * Why no 409A supported a grant made on `date`, or null when one did: judged as
 * things stood that day. A valuation superseded or marked expired since was the
 * one in force before then, so status counts for nothing here and only its date,
 * its twelve months and any priced round after it decide. A grant made outside
 * the safe harbor stays outside it whatever valuation comes later
 * (Treas. Reg. 1.409A-1(b)(5)(iv)(B)(2)(i) looks at the valuation "as of a date
 * no more than 12 months before" the grant).
 */
export function safeHarborLapse(data: CompanyData, date: ISODate): { trigger: RefreshTrigger; valuation: CurrentValuation | null } | null {
  const asThen = { ...data, valuations: data.valuations.map((v) => (v.status === 'DRAFT' ? v : { ...v, status: 'ACTIVE' as const })) };
  const refresh = valuationRefresh(asThen, date, 0);
  const trigger = refresh.triggers.find((t) => t.severity === 'REQUIRED' || t.reason === 'NO_VALUATION');
  return trigger ? { trigger, valuation: refresh.current } : null;
}

/** A date the way the app prints dates: Jan 15, 2026. */
export const longDate = (iso: ISODate): string =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * One trigger in a sentence. The company reads it as a reason to act; the
 * appraiser reads it as a fact about the company, so the two are worded apart.
 * The formatters are passed in so each caller prints dates and money its own way.
 */
export function describeRefreshTrigger(
  t: RefreshTrigger,
  formatDate: (d: ISODate) => string,
  formatMoney: (c: Cents) => string,
  audience: 'company' | 'appraiser' = 'company',
): string {
  const forAppraiser = audience === 'appraiser';
  switch (t.reason) {
    case 'NO_VALUATION':
      if (forAppraiser) return 'The company has no current 409A valuation.';
      return t.severity === 'REQUIRED'
        ? 'There is no current 409A valuation on file, so option grants have no safe harbor price to rest on.'
        : 'There is no current 409A valuation on file. You will need one before granting options.';
    case 'EXPIRED':
      if (t.marked) {
        return forAppraiser
          ? 'The current 409A has been marked expired by the company.'
          : 'The current 409A has been marked expired, so it no longer supports new grants.';
      }
      return forAppraiser
        ? `The current 409A reached twelve months, or its stated expiry, on ${formatDate(t.date!)}.`
        : `The current 409A stopped supporting new grants after ${formatDate(t.date!)}. Grants made since then sit outside the safe harbor.`;
    case 'EXPIRING':
      return forAppraiser
        ? `The current 409A reaches twelve months, or its stated expiry, on ${formatDate(t.date!)}.`
        : `The current 409A runs out after ${formatDate(t.date!)}. An appraisal takes time to prepare, so it is worth starting before then.`;
    case 'PRICED_ROUND':
      return forAppraiser
        ? `${t.shareClassName} was sold on ${formatDate(t.date!)}, after the valuation date.`
        : `${t.shareClassName} was sold on ${formatDate(t.date!)}, after the valuation date. A priced round is normally treated as a material event the current 409A does not reflect.`;
    case 'CONVERTIBLE': {
      const one = t.count === 1;
      const fact = `${one ? 'One convertible' : `${t.count} convertibles`} raising ${formatMoney(t.principal ?? 0)} ${one ? 'was' : 'were'} issued ${one ? 'on' : 'from'} ${formatDate(t.date!)}, after the valuation date.`;
      return forAppraiser ? fact : `${fact} Your appraiser will judge whether that is material.`;
    }
  }
}
