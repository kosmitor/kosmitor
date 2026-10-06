/**
 * Domain types for the equity / cap table engine.
 *
 * Conventions
 *  - Money is stored as integer CENTS (number). $1.00 -> 100.
 *  - Per-share prices are stored as integer MICRO-CENTS (number) to survive
 *    fractional strike prices such as $0.0001. $1.00 -> 1_000_000.
 *  - Share quantities are numbers; fractional shares are permitted internally
 *    and rounded at issuance boundaries via roundShares().
 *  - All dates are ISO-8601 'YYYY-MM-DD' strings.
 */

export type ISODate = string;
export type Cents = number;
export type PricePerShare = number; // micro-cents

export const MICRO = 1_000_000; // micro-cents per dollar
export const CENTS = 100;

// ---------------------------------------------------------------------------
// Share classes
// ---------------------------------------------------------------------------

export type ShareClassKind = 'COMMON' | 'PREFERRED';
export type ParticipationType = 'NON_PARTICIPATING' | 'FULL_PARTICIPATING' | 'CAPPED_PARTICIPATING';
export type DividendType = 'NONE' | 'CUMULATIVE' | 'NON_CUMULATIVE';
export type AntiDilution = 'NONE' | 'BROAD_WEIGHTED' | 'NARROW_WEIGHTED' | 'FULL_RATCHET';

export interface ShareClass {
  id: string;
  name: string;                       // "Common", "Series A Preferred"
  kind: ShareClassKind;
  authorized: number;                 // authorized shares
  parValue: PricePerShare;
  /** Higher number is paid first in a liquidation. Common is always 0. */
  seniority: number;
  originalIssuePrice: PricePerShare;  // OIP used for liquidation preference
  liquidationMultiple: number;        // 1 = 1x
  participation: ParticipationType;
  participationCap: number | null;    // multiple of OIP, e.g. 3 = 3x cap
  conversionRatio: number;            // preferred -> common, 1 = 1:1
  dividendType: DividendType;
  dividendRate: number;               // 0.08 = 8%
  dividendCompounding: boolean;
  dividendsParticipateInResidual: boolean;
  votesPerShare: number;
  antiDilution: AntiDilution;
  payToPlay: boolean;
  /** Date the class was created (the round's closing date). */
  issueDate: ISODate;
  isConvertible: boolean;
}

// ---------------------------------------------------------------------------
// Stakeholders
// ---------------------------------------------------------------------------

export type StakeholderType = 'INDIVIDUAL' | 'ENTITY' | 'TRUST' | 'FUND';
export type StakeholderRelation =
  | 'FOUNDER' | 'EMPLOYEE' | 'ADVISOR' | 'CONTRACTOR' | 'INVESTOR'
  | 'BOARD_MEMBER' | 'FORMER_EMPLOYEE' | 'OTHER';

export interface Stakeholder {
  id: string;
  name: string;
  email: string | null;
  type: StakeholderType;
  relation: StakeholderRelation;
  /** Used for Rule 701 / ISO tests and termination-driven vesting. */
  startDate: ISODate | null;
  terminationDate: ISODate | null;
  taxCountry: string | null;
  taxState: string | null;
  entityGroupId: string | null;       // roll multiple certs into one fund line
}

// ---------------------------------------------------------------------------
// Issuances (actual shares on the books)
// ---------------------------------------------------------------------------

export type IssuanceStatus = 'OUTSTANDING' | 'CANCELLED' | 'REPURCHASED' | 'TRANSFERRED' | 'CONVERTED' | 'PENDING_SIGNATURE';

export interface Issuance {
  id: string;
  certificateNo: string | null;
  stakeholderId: string;
  shareClassId: string;
  quantity: number;
  pricePerShare: PricePerShare;
  issueDate: ISODate;
  status: IssuanceStatus;
  /** Restricted stock (RSA / early-exercised options) vests on this schedule. */
  vestingScheduleId: string | null;
  vestingStartDate: ISODate | null;
  /** Shares bought by exercising an unvested option, subject to repurchase. */
  earlyExercised: boolean;
  /** 83(b) election filed for restricted stock. */
  election83bFiledOn: ISODate | null;
  sourceAwardId: string | null;       // set when created from an option exercise
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Equity awards
// ---------------------------------------------------------------------------

export type AwardType = 'ISO' | 'NSO' | 'RSU' | 'RSA' | 'SAR' | 'PHANTOM' | 'GROWTH_SHARE';
export type AwardStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'OUTSTANDING' | 'EXERCISED' | 'CANCELLED' | 'EXPIRED' | 'FORFEITED' | 'PENDING_SIGNATURE';

export interface Award {
  id: string;
  label: string | null;               // grant number, e.g. "ISO-0042"
  stakeholderId: string;
  poolId: string;
  type: AwardType;
  quantity: number;
  strikePrice: PricePerShare;         // 0 for RSU
  grantDate: ISODate;
  vestingStartDate: ISODate;
  vestingScheduleId: string;
  status: AwardStatus;
  /** Contractual expiration, normally grantDate + 10y. */
  expirationDate: ISODate | null;
  /** Post-termination exercise window in months. */
  ptepMonths: number;
  earlyExerciseAllowed: boolean;
  exercisedQuantity: number;
  cancelledQuantity: number;
  boardApprovalDate: ISODate | null;
  acceptedDate: ISODate | null;
  /** FMV (409A) at grant, used for the ISO $100k test and tax math. */
  fmvAtGrant: PricePerShare;
  /** RSU double-trigger: vests on time AND a liquidity event. */
  rsuLiquidityCondition: boolean;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Option pools (equity incentive plans)
// ---------------------------------------------------------------------------

export interface EquityPool {
  id: string;
  name: string;                       // "2024 Stock Plan"
  shareClassId: string;               // usually Common
  authorized: number;                 // shares reserved
  boardApprovalDate: ISODate | null;
  shareholderApprovalDate: ISODate | null;
  /** Cancelled/forfeited awards flow back into the pool. */
  returnForfeituresToPool: boolean;
  evergreenPercent: number | null;    // annual auto top-up as % of outstanding
  planType: 'STOCK_PLAN' | 'INDUCEMENT' | 'ESPP';
}

export interface PoolAdjustment {
  id: string;
  poolId: string;
  date: ISODate;
  amount: number;                     // positive = increase
  reason: string;
}

// ---------------------------------------------------------------------------
// Warrants
// ---------------------------------------------------------------------------

export interface Warrant {
  id: string;
  stakeholderId: string;
  shareClassId: string;
  quantity: number;
  strikePrice: PricePerShare;
  issueDate: ISODate;
  expirationDate: ISODate | null;
  status: 'OUTSTANDING' | 'EXERCISED' | 'EXPIRED' | 'CANCELLED';
  exercisedQuantity: number;
  /** Cashless / net exercise permitted. */
  netExercise: boolean;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Convertible instruments
// ---------------------------------------------------------------------------

export type ConvertibleInstrument = 'SAFE_PRE' | 'SAFE_POST' | 'NOTE' | 'KISS';
export type InterestCompounding = 'SIMPLE' | 'ANNUAL' | 'MONTHLY' | 'DAILY';

export interface Convertible {
  id: string;
  stakeholderId: string;
  instrument: ConvertibleInstrument;
  principal: Cents;
  issueDate: ISODate;
  /** Valuation cap. Pre-money cap for SAFE_PRE/NOTE, post-money for SAFE_POST. */
  valuationCap: Cents | null;
  discount: number;                   // 0.2 = 20% discount
  interestRate: number;               // 0.05 = 5%/yr, notes only
  compounding: InterestCompounding;
  maturityDate: ISODate | null;
  /** Most-favoured-nation: adopts the best terms of any later instrument. */
  mfn: boolean;
  proRataRight: boolean;
  /** Pending statuses cover instruments issued on the platform that await board approval or signatures. */
  status: 'PENDING_APPROVAL' | 'PENDING_SIGNATURE' | 'OUTSTANDING' | 'CONVERTED' | 'REPAID' | 'CANCELLED';
  /** When the investor's money arrived, for instruments issued on the platform. */
  fundsReceivedOn?: ISODate | null;
  boardApprovalDate?: ISODate | null;
  /** The instrument's reference in documents or an import ("SAFE-3"), when known. */
  label?: string | null;
  convertedIntoShareClassId: string | null;
  convertedOn: ISODate | null;
  /** Conversion trigger threshold — a round must raise at least this to be "qualified". */
  qualifiedFinancingMinimum: Cents | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Vesting
// ---------------------------------------------------------------------------

export type VestingFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'WEEKLY' | 'DAILY';
export type VestingKind = 'TIME' | 'MILESTONE' | 'CUSTOM' | 'FULLY_VESTED';

export interface VestingMilestone {
  id: string;
  name: string;
  /** Portion of the grant, 0..1. */
  portion: number;
  targetDate: ISODate | null;
  achievedDate: ISODate | null;
}

export interface VestingTranche {
  date: ISODate;
  quantity?: number;                  // absolute, or
  portion?: number;                   // fraction of grant 0..1
}

export interface VestingSchedule {
  id: string;
  name: string;
  kind: VestingKind;
  /** Total length of the schedule. */
  durationMonths: number;
  cliffMonths: number;
  frequency: VestingFrequency;
  /** Percent vesting instantly at the vesting start date, 0..1. */
  immediatePortion: number;
  /**
   * Per-year weights for back/front-loaded schedules, e.g. [0.1,0.2,0.3,0.4].
   * When null the schedule vests ratably.
   */
  yearWeights: number[] | null;
  milestones: VestingMilestone[] | null;
  customTranches: VestingTranche[] | null;
  /** Vesting stops at termination unless the award accelerates. */
  accelerationSingleTrigger: number;  // 0..1 portion of unvested
  accelerationDoubleTrigger: number;  // 0..1 portion of unvested
  /** Months of additional credit on a double-trigger event. */
  accelerationMonths: number | null;
}

// ---------------------------------------------------------------------------
// Valuations
// ---------------------------------------------------------------------------

export interface Valuation {
  id: string;
  type: '409A' | 'PREFERRED_PRICE' | 'BOARD_ESTIMATE' | 'SECONDARY';
  fairMarketValue: PricePerShare;
  effectiveDate: ISODate;
  expirationDate: ISODate | null;
  provider: string | null;
  reportUrl: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'SUPERSEDED';
}

// ---------------------------------------------------------------------------
// Transactions (the immutable ledger)
// ---------------------------------------------------------------------------

export const TRANSACTION_TYPES = [
  'ISSUANCE', 'TRANSFER', 'REPURCHASE', 'CANCELLATION', 'EXERCISE',
  'CONVERSION', 'STOCK_SPLIT', 'GRANT', 'VESTING_ACCELERATION',
  'POOL_INCREASE', 'SECONDARY_SALE', 'RETIREMENT', 'DIVIDEND',
  // An import dates a leaver's cancelled options to the termination when the file names no date.
  'FORFEITURE', 'EXPIRATION',
  // An edit that says the record was wrong from `date` on (PATCH on a security): `quantity` is the signed change to `field`.
  'CORRECTION',
  // An MFN holder's election of a later convertible's terms (LedgerEntry.adoptedId).
  'MFN_ELECTION',
  // A note paid back in cash (the repay route): it leaves the cap table on `date`.
  'REPAYMENT',
] as const;
export type TransactionType = typeof TRANSACTION_TYPES[number];

/**
 * Entries rewindToDate undoes. Against a security they come only from the event routes,
 * which change the row and write the entry together; a manual one would rewind a change
 * the row never had.
 */
export const REWOUND_TYPES: readonly TransactionType[] = [
  'TRANSFER', 'REPURCHASE', 'EXERCISE', 'CANCELLATION', 'FORFEITURE', 'EXPIRATION', 'CONVERSION', 'CORRECTION', 'REPAYMENT',
];

/** The counts a CORRECTION entry changes by a signed `quantity`. */
export const CORRECTED_COUNTS = ['quantity', 'exercisedQuantity', 'cancelledQuantity'] as const;
/** A convertible's terms: the entry carries the value `before` and `after`, and the rewind restores `before` on earlier dates. */
export const CORRECTED_TERMS = ['principal', 'valuationCap', 'discount', 'interestRate', 'compounding', 'instrument', 'maturityDate', 'mfn', 'qualifiedFinancingMinimum'] as const;
/**
 * A typo in who holds a security, its class or plan, or its own date: the record always
 * should have read `after`, so the rewind applies it on every date. Never a transfer.
 * The entry needs a `reason`.
 */
export const CORRECTED_IDENTITY = ['stakeholderId', 'shareClassId', 'poolId', 'issueDate', 'grantDate'] as const;
/** What a CORRECTION entry changes. `deleted`: a security entered by mistake was removed. */
export type CorrectedField = typeof CORRECTED_COUNTS[number] | typeof CORRECTED_TERMS[number] | typeof CORRECTED_IDENTITY[number] | 'deleted';

export interface Transaction {
  id: string;
  type: TransactionType;
  date: ISODate;
  stakeholderId: string | null;
  counterpartyId: string | null;
  securityId: string | null;
  shareClassId: string | null;
  quantity: number | null;
  pricePerShare: PricePerShare | null;
  amount: Cents | null;
  memo: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * A dated change to a security since it was issued, as the engine reads the
 * transactions ledger: shares transferred or repurchased off a certificate,
 * options exercised or cancelled, a convertible converted, an MFN safe's terms
 * elected. The rows hold the state of today; these say when it changed
 * (rewindToDate, ledger.ts). The quantity is in the shares of the entry's own date.
 */
export interface LedgerEntry {
  id: string;
  type: TransactionType;
  date: ISODate;
  securityId: string;
  quantity: number | null;
  /** MFN_ELECTION: the later convertible whose terms the MFN instrument `securityId` adopts from `date` (mfnElections). */
  adoptedId?: string | null;
  /** For a CORRECTION: the count it changed, by `quantity` (signed), or the term or identity field it changed. */
  field?: CorrectedField | null;
  /** For a CORRECTION of a term or identity field: the value before and after. */
  before?: unknown;
  after?: unknown;
}

// ---------------------------------------------------------------------------
// Aggregate company snapshot consumed by the engine
// ---------------------------------------------------------------------------

/** An option exercise as recorded, the source of Form 3921 reporting for ISOs. */
export interface Exercise {
  id: string;
  awardId: string;
  stakeholderId: string;
  quantity: number;
  exerciseDate: ISODate;
  method: string;
  strikePrice: PricePerShare;
  fmvAtExercise: PricePerShare;
  sharesIssued: number;
  status: string;
}

/** A regulatory filing the company records as done: Form 3921 for a tax year, a BOI report. */
export interface ComplianceFiling {
  id: string;
  kind: 'FORM_3921' | 'BOI';
  /** The tax year for Form 3921 ("2025"), or "INITIAL" / "UPDATE" for BOI. */
  period: string;
  filedOn: ISODate;
  reference: string | null;
  notes: string | null;
}

export interface CompanyData {
  shareClasses: ShareClass[];
  stakeholders: Stakeholder[];
  issuances: Issuance[];
  awards: Award[];
  pools: EquityPool[];
  poolAdjustments: PoolAdjustment[];
  warrants: Warrant[];
  convertibles: Convertible[];
  vestingSchedules: VestingSchedule[];
  valuations: Valuation[];
  /** Applied to every share count, e.g. a 2:1 split has ratio 2. */
  stockSplits: { id: string; date: ISODate; ratio: number }[];
  /** Option exercises on record; absent in fixtures that predate Form 3921 reporting. */
  exercises?: Exercise[];
  /** Filings the company has recorded as made. */
  filings?: ComplianceFiling[];
  /**
   * The ledger entries that refer to a security. Absent in fixtures and in a
   * snapshot built from an export, whose rows carry no history: a view of an
   * earlier date then reads the rows as they are today, but for a conversion,
   * which the convertible dates itself (convertedOn).
   */
  ledger?: LedgerEntry[];
}

export const emptyCompany = (): CompanyData => ({
  shareClasses: [], stakeholders: [], issuances: [], awards: [], pools: [],
  poolAdjustments: [], warrants: [], convertibles: [], vestingSchedules: [],
  valuations: [], stockSplits: [],
});
