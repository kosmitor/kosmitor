/**
 * The Kosmitor note: what OCF has no field for travels in one comment.
 *
 * OCF objects allow no extra properties, so the fields Kosmitor keeps beyond them (a
 * stakeholder's start date, a class's dividend terms, a schedule's acceleration) are
 * written as the last element of the object's `comments`:
 *
 *   "kosmitor:1:" + JSON.stringify(fields)
 *
 * only when there is something to carry. Reading takes the first comment with the
 * prefix from any package, not only Kosmitor's, keeps only the keys allowed for the
 * object's kind, each checked like any input, and ignores anything malformed or
 * unknown without a word. A note never overrides a field OCF itself carries; the
 * import decides that, field by field.
 */
import { createHash } from 'node:crypto';
import { MAX_VESTING_MONTHS } from '@kosmitor/core';
import type {
  AntiDilution, AwardType, ConvertibleInstrument, DividendType, InterestCompounding, ParticipationType,
  StakeholderRelation, StakeholderType, Valuation, VestingFrequency, VestingKind, VestingMilestone, VestingSchedule, VestingTranche,
} from '@kosmitor/core';
import { isCalendarDate } from './convert.ts';

export const NOTE_PREFIX = 'kosmitor:1:';

export type NoteKind =
  | 'ISSUER' | 'STAKEHOLDER' | 'STOCK_CLASS' | 'STOCK_PLAN' | 'VESTING_TERMS' | 'VALUATION'
  | 'TX_STOCK_ISSUANCE' | 'TX_EQUITY_COMPENSATION_ISSUANCE' | 'TX_EQUITY_COMPENSATION_EXERCISE' | 'TX_WARRANT_ISSUANCE' | 'TX_WARRANT_EXERCISE'
  | 'TX_CANCELLATION' | 'TX_CONVERTIBLE_ISSUANCE' | 'TX_CONVERTIBLE_CANCELLATION';

export interface IssuerNote {
  /** The company's address as typed, when no country is known for an OCF Address. */
  address?: string;
  /** The jurisdiction as typed, when it is not a US state or a two-letter country code. */
  jurisdiction?: string;
}

export interface StakeholderNote {
  /** The display name, when it differs from the legal name OCF carries. */
  name?: string;
  type?: StakeholderType;
  relation?: StakeholderRelation;
  title?: string;
  department?: string;
  startDate?: string;
  terminationDate?: string;
  taxCountry?: string;
  taxState?: string;
  boardSeat?: boolean;
  boardSeatStart?: string;
  boardSeatEnd?: string;
  /** The OCF stakeholder id, within the same package, of the investor who designated the director. */
  boardDesignatedBy?: string;
  /** The address as typed, when it has no two-letter country to go in an OCF Address. */
  address?: string;
  /** The phone number as typed, when it is not in the international form OCF requires. */
  phone?: string;
  /** The region (state, county) as typed, when it is not an ISO subdivision code. */
  region?: string;
  /** Emails as typed that OCF's email format refuses. */
  email?: string;
  secondaryEmail?: string;
  /** An institution's signatory, when there is no email to give them an OCF primary contact (which needs one). */
  signatory?: string;
  signatoryEmail?: string;
}
export interface StockClassNote {
  issueDate?: string;
  participation?: ParticipationType;
  participationCap?: number;
  dividendType?: DividendType;
  dividendRate?: number;
  dividendCompounding?: boolean;
  dividendsParticipateInResidual?: boolean;
  antiDilution?: AntiDilution;
  payToPlay?: boolean;
  isConvertible?: boolean;
}
export interface StockPlanNote { evergreenPercent?: number; planType?: 'STOCK_PLAN' | 'INDUCEMENT' | 'ESPP' }
/** A vesting schedule as Kosmitor stores it, without its id and name (the terms carry the name). */
export type NotedSchedule = Omit<VestingSchedule, 'id' | 'name'>;
export interface VestingTermsNote {
  schedule?: NotedSchedule;
  /** termsDigest of the terms as written; the schedule is used only while it still matches. */
  digest?: string;
}
export interface ValuationNote {
  type?: Valuation['type'];
  status?: Valuation['status'];
  expirationDate?: string;
  method?: string;
  /** Cents. */
  enterpriseValue?: number;
  reportUrl?: string;
}
/** A restricted stock award (an `awards` row of type RSA) as a note: the award's own terms and its dated entries. */
export interface RsaAwardNote {
  label: string | null; ptepMonths: number; expirationDate: string | null; fmvAtGrant: number;
}
/** The award a certificate is the shares of, with what the award records beyond the certificate. */
export interface RsaOfCertificateNote extends RsaAwardNote {
  quantity: number;
  grantDate: string;
  /** Micro-cents. */
  price: number;
  /** The award's own terms, when they are not the certificate's (an OCF vesting terms id in the package). */
  vestingTermsId?: string;
  vestingStartDate?: string;
  /** The award's own cancellations, in the shares of their dates. */
  entries?: { date: string; type: 'CANCELLATION' | 'FORFEITURE' | 'EXPIRATION'; quantity: number }[];
}
export interface StockIssuanceNote {
  earlyExercised?: boolean;
  election83bFiledOn?: string;
  /** Set when the issuance is a restricted stock award with no certificate on record (an `awards` row of type RSA only). */
  award?: RsaAwardNote;
  /** Set when the certificate is the shares of a restricted stock award: the award goes in with it. */
  rsaAward?: RsaOfCertificateNote;
  /** The certificate has no number of its own: custom_id was made up from its id. */
  unnumbered?: boolean;
}
export interface EquityCompensationNote {
  /** The Kosmitor type when the compensation type does not say it: PHANTOM, GROWTH_SHARE. */
  type?: AwardType;
  /** Micro-cents. */
  fmvAtGrant?: number;
  rsuLiquidityCondition?: boolean;
  /** The grant never expires: expiration_date null means that, not "unknown". */
  noExpiration?: boolean;
  unnumbered?: boolean;
}
/** An exercise (or an RSU's release) as Kosmitor recorded it. */
export interface ExerciseNote {
  method?: 'CASH' | 'CASHLESS' | 'NET_EXERCISE' | 'PROMISSORY_NOTE';
  /** Micro-cents per share of the exercise date. */
  fmvAtExercise?: number;
  sharesIssued?: number;
  /** Cents paid. */
  amount?: number;
}
export interface WarrantIssuanceNote { netExercise?: boolean }
/** Warrant shares exercised, in the shares of the exercise date (OCF's WarrantExercise has no quantity), and how. */
export interface WarrantExerciseNote { quantity?: number; method?: 'CASH' | 'NET_EXERCISE'; amount?: number }
/** A cancellation of shares, options or warrants: the ledger entry it was, and when it is a lapse Kosmitor works out itself. */
export interface CancellationNote {
  type?: 'CANCELLATION' | 'FORFEITURE' | 'EXPIRATION' | 'CORRECTION';
  /** Options lapsed when the holder left (unvested, `termination`) or when the exercise window closed (`window`): no ledger entry in Kosmitor. */
  lapse?: 'termination' | 'window';
}
export interface ConvertibleIssuanceNote {
  instrument?: ConvertibleInstrument;
  compounding?: InterestCompounding;
  /** Cents. */
  qualifiedFinancingMinimum?: number;
  proRataRight?: boolean;
  /** MFN_ELECTION entries, which OCF has no transaction for; `adoptedSecurityId` is an OCF security id in the package. */
  mfnElections?: { date: string; adoptedSecurityId: string }[];
  fundsReceivedOn?: string;
  fundsReference?: string;
  unnumbered?: boolean;
}
export interface ConvertibleCancellationNote {
  type?: 'REPAYMENT' | 'CANCELLATION';
  /** Cents repaid, interest included. */
  repaid?: number;
}

export interface NoteFields {
  ISSUER: IssuerNote;
  STAKEHOLDER: StakeholderNote;
  STOCK_CLASS: StockClassNote;
  STOCK_PLAN: StockPlanNote;
  VESTING_TERMS: VestingTermsNote;
  VALUATION: ValuationNote;
  TX_STOCK_ISSUANCE: StockIssuanceNote;
  TX_EQUITY_COMPENSATION_ISSUANCE: EquityCompensationNote;
  TX_EQUITY_COMPENSATION_EXERCISE: ExerciseNote;
  TX_WARRANT_ISSUANCE: WarrantIssuanceNote;
  TX_WARRANT_EXERCISE: WarrantExerciseNote;
  TX_CANCELLATION: CancellationNote;
  TX_CONVERTIBLE_ISSUANCE: ConvertibleIssuanceNote;
  TX_CONVERTIBLE_CANCELLATION: ConvertibleCancellationNote;
}

// ---------------------------------------------------------------------------
// Checks: each returns the value to keep, or undefined to drop it
// ---------------------------------------------------------------------------

type Check = (v: unknown) => unknown;
const text: Check = (v) => (typeof v === 'string' && v.trim() !== '' && v.length <= 2000 ? v : undefined);
const day: Check = (v) => (typeof v === 'string' && isCalendarDate(v) ? v : undefined);
/** A date a schedule vests on: a calendar day from 1900 to 2200, as evaluateTerms keeps them. */
const vestingDay: Check = (v) => (typeof v === 'string' && isCalendarDate(v) && v >= '1900-01-01' && v <= '2200-12-31' ? v : undefined);
/** Months of vesting: at most 50 years (MAX_VESTING_MONTHS), as a schedule can say. */
const months: Check = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_VESTING_MONTHS ? v : undefined);
const nullableDay: Check = (v) => (v === null ? null : day(v));
const nonNegative: Check = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const integer: Check = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const fraction: Check = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined);
const flag: Check = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...allowed: string[]): Check => (v) => (typeof v === 'string' && allowed.includes(v) ? v : undefined);
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const positive: Check = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1e12 ? v : undefined);
const shares: Check = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12 ? v : undefined);


const VESTING_KINDS: VestingKind[] = ['TIME', 'MILESTONE', 'CUSTOM', 'FULLY_VESTED'];
const FREQUENCIES: VestingFrequency[] = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'WEEKLY', 'DAILY'];

/** A schedule in a note, checked field by field; anything off and the whole schedule is dropped. */
const schedule: Check = (v) => {
  const s = record(v);
  if (!s) return undefined;
  const kind = oneOf(...VESTING_KINDS)(s.kind) as VestingKind | undefined;
  const frequency = oneOf(...FREQUENCIES)(s.frequency) as VestingFrequency | undefined;
  const durationMonths = months(s.durationMonths) as number | undefined;
  const cliffMonths = months(s.cliffMonths) as number | undefined;
  const immediatePortion = fraction(s.immediatePortion) as number | undefined;
  if (!kind || !frequency || durationMonths == null || cliffMonths == null || cliffMonths > durationMonths || immediatePortion == null) return undefined;
  let yearWeights: number[] | null = null;
  if (s.yearWeights != null) {
    if (!Array.isArray(s.yearWeights) || s.yearWeights.length > 50 || s.yearWeights.some((w) => nonNegative(w) === undefined)) return undefined;
    yearWeights = s.yearWeights as number[];
  }
  let milestones: VestingMilestone[] | null = null;
  if (s.milestones != null) {
    if (!Array.isArray(s.milestones) || s.milestones.length > 500) return undefined;
    milestones = [];
    for (const raw of s.milestones) {
      const m = record(raw);
      const id = text(m?.id) as string | undefined, name = text(m?.name) as string | undefined, portion = fraction(m?.portion) as number | undefined;
      const targetDate = m?.targetDate == null ? null : vestingDay(m.targetDate);
      if (!m || !id || !name || portion == null || targetDate === undefined) return undefined;
      milestones.push({ id, name, portion, targetDate: targetDate as string | null, achievedDate: null });
    }
  }
  let customTranches: VestingTranche[] | null = null;
  if (s.customTranches != null) {
    if (!Array.isArray(s.customTranches) || s.customTranches.length > 1000) return undefined;
    customTranches = [];
    for (const raw of s.customTranches) {
      const t = record(raw);
      const date = vestingDay(t?.date) as string | undefined;
      const quantity = t?.quantity == null ? undefined : shares(t.quantity) as number | undefined;
      const portion = t?.portion == null ? undefined : fraction(t.portion) as number | undefined;
      if (!t || !date || (t.quantity != null && quantity === undefined) || (t.portion != null && portion === undefined) || (quantity == null && portion == null)) return undefined;
      customTranches.push({ date, ...(quantity != null ? { quantity } : { portion }) });
    }
  }
  const accelerationSingleTrigger = fraction(s.accelerationSingleTrigger ?? 0) as number | undefined;
  const accelerationDoubleTrigger = fraction(s.accelerationDoubleTrigger ?? 0) as number | undefined;
  const accelerationMonths = s.accelerationMonths == null ? null : months(s.accelerationMonths) as number | undefined;
  if (accelerationSingleTrigger == null || accelerationDoubleTrigger == null || accelerationMonths === undefined) return undefined;
  const out: NotedSchedule = {
    kind, durationMonths, cliffMonths, frequency, immediatePortion, yearWeights, milestones, customTranches,
    accelerationSingleTrigger, accelerationDoubleTrigger, accelerationMonths,
  };
  return out;
};

const rsaAward: Check = (v) => {
  const a = record(v);
  if (!a) return undefined;
  const label = a.label === null ? null : text(a.label);
  const ptepMonths = integer(a.ptepMonths);
  const expirationDate = nullableDay(a.expirationDate ?? null);
  const fmvAtGrant = integer(a.fmvAtGrant ?? 0);
  if (label === undefined || ptepMonths === undefined || expirationDate === undefined || fmvAtGrant === undefined) return undefined;
  return { label, ptepMonths, expirationDate, fmvAtGrant };
};

const RSA_ENTRY_TYPES = ['CANCELLATION', 'FORFEITURE', 'EXPIRATION'];
const rsaOfCertificate: Check = (v) => {
  const base = rsaAward(v) as RsaAwardNote | undefined;
  const a = record(v);
  if (!base || !a) return undefined;
  const quantity = positive(a.quantity), grantDate = day(a.grantDate), price = integer(a.price ?? 0);
  if (quantity === undefined || grantDate === undefined || price === undefined) return undefined;
  const out: RsaOfCertificateNote = { ...base, quantity: quantity as number, grantDate: grantDate as string, price: price as number };
  if (a.vestingTermsId != null) { const t = text(a.vestingTermsId); if (t === undefined) return undefined; out.vestingTermsId = t as string; }
  if (a.vestingStartDate != null) { const d = day(a.vestingStartDate); if (d === undefined) return undefined; out.vestingStartDate = d as string; }
  if (a.entries != null) {
    if (!Array.isArray(a.entries) || a.entries.length > 1000) return undefined;
    out.entries = [];
    for (const raw of a.entries) {
      const e = record(raw);
      const date = day(e?.date), quantity = positive(e?.quantity);
      if (!e || date === undefined || quantity === undefined || typeof e.type !== 'string' || !RSA_ENTRY_TYPES.includes(e.type)) return undefined;
      out.entries.push({ date: date as string, type: e.type as 'CANCELLATION', quantity: quantity as number });
    }
  }
  return out;
};

const mfnElections: Check = (v) => {
  if (!Array.isArray(v) || v.length > 100) return undefined;
  const out: { date: string; adoptedSecurityId: string }[] = [];
  for (const raw of v) {
    const e = record(raw);
    const date = day(e?.date) as string | undefined, adoptedSecurityId = text(e?.adoptedSecurityId) as string | undefined;
    if (!date || !adoptedSecurityId) return undefined;
    out.push({ date, adoptedSecurityId });
  }
  return out;
};

const NOTE_KEYS: { [K in NoteKind]: Record<keyof NoteFields[K] & string, Check> } = {
  ISSUER: { address: text, jurisdiction: text },
  STAKEHOLDER: {
    name: text, type: oneOf('INDIVIDUAL', 'ENTITY', 'TRUST', 'FUND'),
    relation: oneOf('FOUNDER', 'EMPLOYEE', 'ADVISOR', 'CONTRACTOR', 'INVESTOR', 'BOARD_MEMBER', 'FORMER_EMPLOYEE', 'OTHER'),
    title: text, department: text, startDate: day, terminationDate: day, taxCountry: text, taxState: text,
    boardSeat: flag, boardSeatStart: day, boardSeatEnd: day, boardDesignatedBy: text, address: text, phone: text,
    region: text, email: text, secondaryEmail: text, signatory: text, signatoryEmail: text,
  },
  STOCK_CLASS: {
    issueDate: day, participation: oneOf('NON_PARTICIPATING', 'FULL_PARTICIPATING', 'CAPPED_PARTICIPATING'), participationCap: nonNegative,
    dividendType: oneOf('NONE', 'CUMULATIVE', 'NON_CUMULATIVE'), dividendRate: nonNegative, dividendCompounding: flag,
    dividendsParticipateInResidual: flag, antiDilution: oneOf('NONE', 'BROAD_WEIGHTED', 'NARROW_WEIGHTED', 'FULL_RATCHET'),
    payToPlay: flag, isConvertible: flag,
  },
  STOCK_PLAN: { evergreenPercent: nonNegative, planType: oneOf('STOCK_PLAN', 'INDUCEMENT', 'ESPP') },
  VESTING_TERMS: { schedule, digest: (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v) ? v : undefined) },
  VALUATION: {
    type: oneOf('409A', 'PREFERRED_PRICE', 'BOARD_ESTIMATE', 'SECONDARY'), status: oneOf('DRAFT', 'ACTIVE', 'EXPIRED', 'SUPERSEDED'),
    expirationDate: day, method: text, enterpriseValue: integer, reportUrl: (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 2000 ? v : undefined),
  },
  TX_STOCK_ISSUANCE: { earlyExercised: flag, election83bFiledOn: day, award: rsaAward, rsaAward: rsaOfCertificate, unnumbered: flag },
  TX_EQUITY_COMPENSATION_ISSUANCE: {
    type: oneOf('ISO', 'NSO', 'RSU', 'RSA', 'SAR', 'PHANTOM', 'GROWTH_SHARE'), fmvAtGrant: integer, rsuLiquidityCondition: flag,
    noExpiration: flag, unnumbered: flag,
  },
  TX_EQUITY_COMPENSATION_EXERCISE: {
    method: oneOf('CASH', 'CASHLESS', 'NET_EXERCISE', 'PROMISSORY_NOTE'), fmvAtExercise: integer, sharesIssued: shares, amount: integer,
  },
  TX_WARRANT_ISSUANCE: { netExercise: flag },
  TX_WARRANT_EXERCISE: { quantity: positive, method: oneOf('CASH', 'NET_EXERCISE'), amount: integer },
  TX_CANCELLATION: { type: oneOf('CANCELLATION', 'FORFEITURE', 'EXPIRATION', 'CORRECTION'), lapse: oneOf('termination', 'window') },
  TX_CONVERTIBLE_ISSUANCE: {
    instrument: oneOf('SAFE_PRE', 'SAFE_POST', 'NOTE', 'KISS'), compounding: oneOf('SIMPLE', 'ANNUAL', 'MONTHLY', 'DAILY'),
    qualifiedFinancingMinimum: integer, proRataRight: flag, mfnElections, fundsReceivedOn: day, fundsReference: text, unnumbered: flag,
  },
  TX_CONVERTIBLE_CANCELLATION: { type: oneOf('REPAYMENT', 'CANCELLATION'), repaid: integer },
};

/** The keys a note may hold for each kind of object, for docs and tests. */
export const NOTE_KEY_NAMES: { [K in NoteKind]: string[] } = Object.fromEntries(
  Object.entries(NOTE_KEYS).map(([k, v]) => [k, Object.keys(v)])) as { [K in NoteKind]: string[] };

/** The note for these fields, or null when none is worth writing. Null, undefined and empty strings are left out. */
export function writeNote(fields: Record<string, unknown>): string | null {
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return Object.keys(kept).length ? NOTE_PREFIX + JSON.stringify(kept) : null;
}

/** An object's comments with the note last, or undefined when there are none. */
export function commentsWith(comments: (string | null | undefined)[], note: string | null): string[] | undefined {
  const out = comments.filter((c): c is string => typeof c === 'string' && c.trim() !== '' && !c.startsWith(NOTE_PREFIX));
  if (note) out.push(note);
  return out.length ? out : undefined;
}

/** What an object's note says, keeping only the keys allowed for its kind, each checked. Never throws. */
export function readNote<K extends NoteKind>(object: { comments?: unknown } | null | undefined, kind: K): NoteFields[K] {
  const comments = Array.isArray(object?.comments) ? object!.comments : [];
  const raw = comments.find((c): c is string => typeof c === 'string' && c.startsWith(NOTE_PREFIX));
  if (!raw) return {} as NoteFields[K];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(NOTE_PREFIX.length)); } catch { return {} as NoteFields[K]; }
  const fields = record(parsed);
  if (!fields) return {} as NoteFields[K];
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(NOTE_KEYS[kind] as Record<string, Check>)) {
    if (!Object.hasOwn(fields, key)) continue;
    const v = check(fields[key]);
    if (v !== undefined) out[key] = v;
  }
  return out as NoteFields[K];
}

/**
 * Sentences the export writes for other readers about what OCF cannot hold (an MFN
 * election), which say nothing a note does not: an import does not keep them as notes.
 */
const GENERATED = [/^Elected the terms of .+ on \d{4}-\d{2}-\d{2} \(MFN\); the conversion terms here are as issued\.$/];
export const mfnComment = (adopted: string, date: string): string => `Elected the terms of ${adopted} on ${date} (MFN); the conversion terms here are as issued.`;

/** The comments that are not the note: what a person wrote, which the import may keep as notes. */
export const plainComments = (object: { comments?: unknown } | null | undefined): string[] =>
  (Array.isArray(object?.comments) ? object!.comments : [])
    .filter((c): c is string => typeof c === 'string' && !c.startsWith(NOTE_PREFIX) && !GENERATED.some((g) => g.test(c)));

/**
 * The digest a vesting terms note is written with: SHA-256 (base64url, 22 characters)
 * of the allocation type and the conditions. Terms another tool edited no longer match,
 * and the import reads their conditions instead of the noted schedule.
 */
export function termsDigest(allocationType: unknown, conditions: unknown): string {
  return createHash('sha256').update(JSON.stringify([allocationType, conditions])).digest('base64url').slice(0, 22);
}
