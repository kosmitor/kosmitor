/**
 * Builders for the golden tests. Every name is fictional. A difference found on a
 * real cap table is rebuilt here with made-up holders and round numbers before it
 * is pinned; real rows never go in this folder.
 */
import type {
  Award, CompanyData, Convertible, EquityPool, Issuance, LedgerEntry, ShareClass, Stakeholder, Valuation, VestingSchedule, VestingTranche, Warrant,
} from '../src/types.ts';
import { emptyCompany } from '../src/types.ts';
import { dollarsToCents as $, dollarsToPPS as $$ } from '../src/util.ts';
import type { WaterfallSpec } from './reference/waterfall.ts';

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}`;

export const fourYear: VestingSchedule = {
  id: 'vs_4y', name: '4 years, 1-year cliff', kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY',
  immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null,
  accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null,
};

export const fullyVested: VestingSchedule = {
  ...fourYear, id: 'vs_full', name: 'Fully vested', kind: 'FULLY_VESTED', durationMonths: 0, cliffMonths: 0, immediatePortion: 1,
};

export const schedule = (o: Partial<VestingSchedule> = {}): VestingSchedule => ({ ...fourYear, ...o });

export const customSchedule = (id: string, customTranches: VestingTranche[]): VestingSchedule =>
  ({ ...fourYear, id, name: id, kind: 'CUSTOM', durationMonths: 0, cliffMonths: 0, customTranches });

export function shareClass(o: Partial<ShareClass> & { id: string; name: string }): ShareClass {
  return {
    kind: 'COMMON', authorized: 100_000_000, parValue: $$(0.00001), seniority: 0, originalIssuePrice: $$(0.00001),
    liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null, conversionRatio: 1,
    dividendType: 'NONE', dividendRate: 0, dividendCompounding: false, dividendsParticipateInResidual: false,
    votesPerShare: 1, antiDilution: 'NONE', payToPlay: false, issueDate: '2020-01-01', isConvertible: false, ...o,
  };
}

export const preferred = (id: string, name: string, oip: number, o: Partial<ShareClass> = {}): ShareClass =>
  shareClass({ id, name, kind: 'PREFERRED', seniority: 1, originalIssuePrice: $$(oip), issueDate: '2021-06-01', isConvertible: true, ...o });

export function holder(id: string, name: string, relation: Stakeholder['relation'] = 'FOUNDER', o: Partial<Stakeholder> = {}): Stakeholder {
  return {
    id, name, email: null, type: 'INDIVIDUAL', relation, startDate: '2020-01-01', terminationDate: null,
    taxCountry: 'US', taxState: 'DE', entityGroupId: null, ...o,
  };
}

export function issuance(stakeholderId: string, shareClassId: string, quantity: number, pricePerShare: number, issueDate: string, o: Partial<Issuance> = {}): Issuance {
  return {
    id: nextId('is'), certificateNo: null, stakeholderId, shareClassId, quantity, pricePerShare, issueDate, status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: null, ...o,
  };
}

export function award(stakeholderId: string, quantity: number, o: Partial<Award> = {}): Award {
  return {
    id: nextId('aw'), label: null, stakeholderId, poolId: 'pool', type: 'ISO', quantity, strikePrice: $$(0.10), grantDate: '2021-01-01',
    vestingStartDate: o.grantDate ?? '2021-01-01', vestingScheduleId: fourYear.id, status: 'OUTSTANDING', expirationDate: '2031-01-01',
    ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: null, acceptedDate: null,
    fmvAtGrant: $$(0.10), rsuLiquidityCondition: false, notes: null, ...o,
  };
}

export function pool(authorized: number, o: Partial<EquityPool> = {}): EquityPool {
  return {
    id: 'pool', name: 'Stock Plan', shareClassId: 'common', authorized, boardApprovalDate: '2020-01-01', shareholderApprovalDate: '2020-01-01',
    returnForfeituresToPool: true, evergreenPercent: null, planType: 'STOCK_PLAN', ...o,
  };
}

/** A SAFE or note. Principal and cap are in dollars here, cents in the result. */
export function convertible(stakeholderId: string, instrument: Convertible['instrument'], principal: number, cap: number | null, o: Partial<Convertible> = {}): Convertible {
  return {
    id: nextId('cv'), stakeholderId, instrument, principal: $(principal), issueDate: '2021-06-01', valuationCap: cap == null ? null : $(cap),
    discount: 0, interestRate: 0, compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: false, status: 'OUTSTANDING',
    convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null, notes: null, ...o,
  };
}

export function warrant(stakeholderId: string, shareClassId: string, quantity: number, o: Partial<Warrant> = {}): Warrant {
  return {
    id: nextId('wt'), stakeholderId, shareClassId, quantity, strikePrice: $$(1), issueDate: '2021-01-01', expirationDate: '2031-01-01',
    status: 'OUTSTANDING', exercisedQuantity: 0, netExercise: false, notes: null, ...o,
  };
}

/** A ledger entry for a security, its quantity in the shares of its own date, as the routes write it. */
export function entry(type: LedgerEntry['type'], date: string, securityId: string, quantity: number | null, field?: LedgerEntry['field']): LedgerEntry {
  return { id: nextId('tx'), type, date, securityId, quantity, ...(field ? { field } : {}) };
}

/** The MFN holder of `mfnId` elects, on `date`, the terms of `adoptedId`, as POST /convertibles/:id/mfn-election writes it. */
export const election = (mfnId: string, adoptedId: string, date: string): LedgerEntry => ({ ...entry('MFN_ELECTION', date, mfnId, null), adoptedId });

export function valuation(o: Partial<Valuation> = {}): Valuation {
  return {
    id: nextId('val'), type: '409A', fairMarketValue: $$(1), effectiveDate: '2021-01-01', expirationDate: null,
    provider: null, reportUrl: null, status: 'ACTIVE', ...o,
  };
}

/** A company with one common class ('common'), the two standard schedules and nothing else unless given. */
export function company(o: Partial<CompanyData> = {}): CompanyData {
  return { ...emptyCompany(), shareClasses: [shareClass({ id: 'common', name: 'Common' })], vestingSchedules: [fourYear, fullyVested], ...o };
}

/**
 * ABC, Inc., the pre-financing company in the YC Post-Money Safe User Guide,
 * Appendix II: founders 9,250,000; options outstanding 300,000; promised options
 * 350,000 (modelled as granted, since the engine has no promised options); options
 * available 100,000. Fully diluted 10,000,000.
 */
export function abcInc(): CompanyData {
  return company({
    stakeholders: [
      holder('founders', 'Founders'), holder('optionees', 'Option holders', 'EMPLOYEE'), holder('promised', 'Promised options', 'EMPLOYEE'),
      holder('invA', 'Investor A', 'INVESTOR'), holder('invB', 'Investor B', 'INVESTOR'),
      holder('invC', 'Investor C', 'INVESTOR'), holder('others', 'Other new investors', 'INVESTOR'),
    ],
    issuances: [issuance('founders', 'common', 9_250_000, $$(0.00001), '2020-01-01')],
    awards: [
      award('optionees', 300_000, { type: 'NSO', strikePrice: $$(0.01), fmvAtGrant: $$(0.01), grantDate: '2020-06-01' }),
      award('promised', 350_000, { type: 'NSO', strikePrice: $$(0.01), fmvAtGrant: $$(0.01), grantDate: '2020-06-01' }),
    ],
    pools: [pool(750_000)],
  });
}

/** CompanyData for a waterfall spec: every option fully vested, every class issued on its own date. */
export function waterfallCompany(spec: WaterfallSpec): CompanyData {
  const d = company({ vestingSchedules: [fullyVested] });
  d.shareClasses = [shareClass({ id: 'sc_common', name: 'Common', authorized: 1e12, parValue: 1, originalIssuePrice: 1 })];
  const holders = new Set<string>();
  const add = (h: string) => { holders.add(h); return h; };
  for (const c of spec.common) d.issuances.push(issuance(add(c.holder), 'sc_common', c.shares, 1, '2020-01-01'));
  for (const p of spec.prefs ?? []) {
    const date = p.issueDate ?? '2021-01-01';
    d.shareClasses.push(shareClass({
      id: p.id, name: p.name ?? p.id, kind: 'PREFERRED', authorized: 1e12, parValue: 1, seniority: p.seniority ?? 1,
      originalIssuePrice: $$(p.oip), liquidationMultiple: p.mult ?? 1,
      participation: ({ NP: 'NON_PARTICIPATING', FP: 'FULL_PARTICIPATING', CP: 'CAPPED_PARTICIPATING' } as const)[p.part ?? 'NP'],
      participationCap: p.cap ?? null, conversionRatio: p.ratio ?? 1,
      dividendType: p.divType ?? 'NONE', dividendRate: p.divRate ?? 0, dividendCompounding: p.divCompound ?? false,
      issueDate: date, isConvertible: p.convertible ?? true,
    }));
    d.issuances.push(issuance(add(p.holder ?? `inv_${p.id}`), p.id, p.shares, $$(p.oip), date));
  }
  if ((spec.options ?? []).length) d.pools.push(pool(1e12, { shareClassId: 'sc_common' }));
  for (const o of spec.options ?? []) {
    d.awards.push(award(add(o.holder), o.shares, {
      type: o.type ?? 'NSO', strikePrice: $$(o.strike), fmvAtGrant: $$(o.strike), grantDate: '2020-06-01',
      vestingScheduleId: fullyVested.id, expirationDate: '2030-06-01',
    }));
  }
  for (const w of spec.warrants ?? []) d.warrants.push(warrant(add(w.holder), 'sc_common', w.shares, { strikePrice: $$(w.strike), issueDate: '2020-06-01', expirationDate: null }));
  for (const s of spec.safes ?? []) d.convertibles.push(convertible(add(s.holder), s.instrument ?? 'SAFE_POST', s.amount, s.cap, { id: s.id, issueDate: s.issueDate ?? '2022-01-01', mfn: s.mfn ?? false }));
  const elected = (spec.safes ?? []).filter((s) => s.adopts != null);
  if (elected.length) d.ledger = elected.map((s) => election(s.id, s.adopts!, s.electedOn ?? spec.safes!.find((x) => x.id === s.adopts)!.issueDate ?? '2022-01-01'));
  for (const h of holders) d.stakeholders.push(holder(h, h, 'OTHER'));
  return d;
}
