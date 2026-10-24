/**
 * Every conversion between Kosmitor's units and the Open Cap Format's, both ways.
 *
 * OCF writes numbers as decimal strings (Numeric: `^[+-]?[0-9]+(\.[0-9]{1,10})?$`),
 * money as `{ amount, currency }` in whole currency units, ratios as a numerator and a
 * denominator, and percentages as fractions from 0 to 1. Kosmitor keeps money in
 * integer cents and per-share prices in integer micro-cents (AGENTS.md, "Money"), so
 * an amount read from a package is converted with string arithmetic, never through a
 * float, and one written is printed from the integers.
 *
 * The enum maps say how Kosmitor's kinds read in OCF and back (docs/ocf.md, "Enums").
 */
import type {
  AwardType, ConvertibleInstrument, InterestCompounding, StakeholderRelation, StakeholderType,
} from '@kosmitor/core';
import { config } from '../config.ts';
import type { OcfCompensationType, OcfMonetary, OcfRatio, OcfRelationship } from './types.ts';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export const NUMERIC = /^[+-]?[0-9]+(\.[0-9]{1,10})?$/;
export const PERCENTAGE = /^0?(\.[0-9]{1,10})?$|^1(\.0{1,10})?$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const COUNTRY = /^[A-Z]{2}$/;
export const SUBDIVISION = /^[A-Z0-9]{1,3}$/;
/** OCF Phone: `+1 415 555 0100` style, as the schema has it. */
export const PHONE = /^\+\d{1,3}\s\d{2,3}\s\d{2,3}\s\d{4}(\s(ext.|extension)\s\d+)?$/;
/**
 * The email check of ajv-formats' "full" mode, which the vendored schemas are
 * validated with: an address that fails it cannot go in an Email object.
 */
export const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

// ---------------------------------------------------------------------------
// Kosmitor to OCF
// ---------------------------------------------------------------------------

/**
 * A number as an OCF Numeric: integers as they are, anything else to at most ten
 * decimals with the trailing zeros dropped. Never exponent notation.
 */
export function ocfNumeric(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`${n} is not a number OCF can hold.`);
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? String(n) : BigInt(n).toString();
  const s = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** Whole cents as an OCF amount with two decimals: 125000000 is "1250000.00". */
export function centsToAmount(cents: number): string {
  const c = BigInt(Math.round(cents));
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/**
 * A per-share price in micro-cents as an OCF amount in dollars, with up to six
 * decimals and at least two: 1000000 is "1.00", 100 is "0.0001", 1 is "0.000001". A
 * split-adjusted price can hold a fraction of a micro-cent (splits.ts); it is written
 * with up to ten decimals.
 */
export function microsToAmount(micros: number): string {
  if (!Number.isInteger(micros)) {
    const s = ocfNumeric(micros / 1e6);
    const [whole, frac = ''] = s.split('.');
    return `${whole}.${frac.padEnd(2, '0')}`;
  }
  const m = BigInt(micros);
  const neg = m < 0n;
  const a = neg ? -m : m;
  let frac = String(a % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${a / 1_000_000n}.${frac}`;
}

export const ocfMoney = (cents: number, currency: string): OcfMonetary => ({ amount: centsToAmount(cents), currency });
export const ocfPrice = (micros: number, currency: string): OcfMonetary => ({ amount: microsToAmount(micros), currency });

/**
 * The simplest fraction n/d (d up to `maxDenominator`) equal to x, or null: 0.25 is
 * 1/4, 1/3 is 1/3, 2 is 2/1. Portions and ratios are written this way, so a reader
 * that adds them up exactly gets back what Kosmitor added up in floats.
 */
export function fractionOf(x: number, maxDenominator = 1000): { n: number; d: number } | null {
  if (!Number.isFinite(x)) return null;
  for (let d = 1; d <= maxDenominator; d++) {
    const n = Math.round(x * d);
    if (Math.abs(n / d - x) <= 1e-12 * Math.max(1, Math.abs(x))) return { n, d };
  }
  return null;
}

/** A ratio such as a split's or a conversion's: 2 is 2/1, 0.5 is 1/2, 1/3 is 1/3, anything else a decimal over 1. */
export function ocfRatio(r: number): OcfRatio {
  const f = fractionOf(r);
  return f ? { numerator: String(f.n), denominator: String(f.d) } : { numerator: ocfNumeric(r), denominator: '1' };
}

/** A fraction from 0 to 1 as an OCF Percentage (0.2 is "0.2"). */
export function ocfPercentage(fraction: number): string {
  const s = ocfNumeric(Math.min(1, Math.max(0, fraction)));
  return s === '1' || PERCENTAGE.test(s) ? s : '0';
}

/** The currency a company's money is written in: its own when it is a three-letter code, else locale.currency. */
export function currencyOf(companyCurrency: string | null | undefined): string {
  const c = String(companyCurrency ?? '').trim().toUpperCase();
  return CURRENCY.test(c) ? c : config().locale.currency;
}

/** The fifty states and the District of Columbia, by USPS code. */
export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));
/** Canada's provinces and territories, by ISO 3166-2 code. */
export const CA_PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',
  NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const PROVINCE_BY_NAME = new Map(Object.entries(CA_PROVINCES).map(([code, name]) => [name.toLowerCase(), code]));
/** Countries companies are often formed in, by name, for a jurisdiction typed as one. */
const COUNTRY_BY_NAME = new Map<string, string>([
  ['united states', 'US'], ['usa', 'US'], ['canada', 'CA'], ['united kingdom', 'GB'], ['england and wales', 'GB'], ['england', 'GB'], ['scotland', 'GB'],
  ['ireland', 'IE'], ['cayman islands', 'KY'], ['british virgin islands', 'VG'], ['bermuda', 'BM'], ['singapore', 'SG'], ['israel', 'IL'],
  ['germany', 'DE'], ['france', 'FR'], ['netherlands', 'NL'], ['luxembourg', 'LU'], ['switzerland', 'CH'], ['australia', 'AU'], ['india', 'IN'],
]);

/**
 * Where a company was formed, from its jurisdiction: a US state by name or code is the
 * US and that state; a Canadian province by name is Canada and that province; a
 * country by name or any other two letters are that country; anything else is taken
 * as the US, and `understood` is false so the export can say so.
 */
export function formationOf(jurisdiction: string | null | undefined): { country: string; subdivision: string | null; understood: boolean } {
  const j = String(jurisdiction ?? '').trim().replace(/^(state|province) of\s+/i, '');
  const key = j.toLowerCase();
  const byName = STATE_BY_NAME.get(key);
  if (byName) return { country: 'US', subdivision: byName, understood: true };
  const province = PROVINCE_BY_NAME.get(key);
  if (province) return { country: 'CA', subdivision: province, understood: true };
  const country = COUNTRY_BY_NAME.get(key);
  if (country) return { country, subdivision: null, understood: true };
  const code = j.toUpperCase();
  if (Object.hasOwn(US_STATES, code)) return { country: 'US', subdivision: code, understood: true };
  if (COUNTRY.test(code)) return { country: code, subdivision: null, understood: true };
  return { country: 'US', subdivision: null, understood: false };
}

/**
 * A jurisdiction as Kosmitor keeps it, from where OCF says a company was formed: a US
 * state or Canadian province by name, else the country code; null when there is none.
 */
export function jurisdictionOf(country: unknown, subdivision: unknown): string | null {
  const c = typeof country === 'string' ? country.trim().toUpperCase() : '';
  const s = typeof subdivision === 'string' ? subdivision.trim().toUpperCase() : '';
  if (c === 'US' && Object.hasOwn(US_STATES, s)) return US_STATES[s];
  if (c === 'CA' && Object.hasOwn(CA_PROVINCES, s)) return CA_PROVINCES[s];
  return COUNTRY.test(c) ? c : null;
}

/** The federal exemptions a certificate records (entities.ts FEDERAL_EXEMPTIONS), as an OCF SecurityExemption describes them. */
export const FEDERAL_EXEMPTION_LABELS: Record<string, string> = {
  SECTION_4A2: 'Section 4(a)(2) of the Securities Act',
  REG_D_506B: 'Regulation D, Rule 506(b)',
  REG_D_506C: 'Regulation D, Rule 506(c)',
  RULE_701: 'Rule 701',
  REG_S: 'Regulation S',
  REG_CF: 'Regulation Crowdfunding',
  OTHER: 'Other exemption',
};
/** A SecurityExemption's description back to the code, when it is one of ours. */
export function federalExemptionOf(description: string): string | null {
  const d = description.trim().toLowerCase();
  for (const [code, label] of Object.entries(FEDERAL_EXEMPTION_LABELS)) if (label.toLowerCase() === d || code.toLowerCase() === d) return code;
  return null;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const RELATION_TO_OCF: Record<StakeholderRelation, OcfRelationship> = {
  FOUNDER: 'FOUNDER', EMPLOYEE: 'EMPLOYEE', ADVISOR: 'ADVISOR', CONTRACTOR: 'CONSULTANT', INVESTOR: 'INVESTOR',
  BOARD_MEMBER: 'BOARD_MEMBER', FORMER_EMPLOYEE: 'EX_EMPLOYEE', OTHER: 'OTHER',
};
export const RELATION_FROM_OCF: Record<OcfRelationship, StakeholderRelation> = {
  ADVISOR: 'ADVISOR', BOARD_MEMBER: 'BOARD_MEMBER', CONSULTANT: 'CONTRACTOR', EMPLOYEE: 'EMPLOYEE', EX_ADVISOR: 'ADVISOR',
  EX_CONSULTANT: 'CONTRACTOR', EX_EMPLOYEE: 'FORMER_EMPLOYEE', EXECUTIVE: 'EMPLOYEE', FOUNDER: 'FOUNDER', INVESTOR: 'INVESTOR',
  NON_US_EMPLOYEE: 'EMPLOYEE', OFFICER: 'EMPLOYEE', OTHER: 'OTHER',
};
/** An entity, trust or fund is an INSTITUTION; the Kosmitor note keeps which. */
export const STAKEHOLDER_TYPE_TO_OCF: Record<StakeholderType, 'INDIVIDUAL' | 'INSTITUTION'> = {
  INDIVIDUAL: 'INDIVIDUAL', ENTITY: 'INSTITUTION', TRUST: 'INSTITUTION', FUND: 'INSTITUTION',
};
export const STAKEHOLDER_TYPE_FROM_OCF: Record<'INDIVIDUAL' | 'INSTITUTION', StakeholderType> = { INDIVIDUAL: 'INDIVIDUAL', INSTITUTION: 'ENTITY' };

/**
 * How a grant reads in OCF. An RSA is exported as stock (TX_STOCK_ISSUANCE with
 * issuance_type RSA), so it has none. A phantom unit reads as an RSU and a growth
 * share as an international option with its price; the note says which they were.
 */
export function compensationOf(type: AwardType): { compensationType: OcfCompensationType; optionGrantType?: 'ISO' | 'NSO' | 'INTL'; price: 'exercise_price' | 'base_price' | null; noted: boolean } | null {
  switch (type) {
    case 'ISO': return { compensationType: 'OPTION_ISO', optionGrantType: 'ISO', price: 'exercise_price', noted: false };
    case 'NSO': return { compensationType: 'OPTION_NSO', optionGrantType: 'NSO', price: 'exercise_price', noted: false };
    case 'RSU': return { compensationType: 'RSU', price: null, noted: false };
    case 'SAR': return { compensationType: 'SSAR', price: 'base_price', noted: false };
    case 'PHANTOM': return { compensationType: 'RSU', price: null, noted: true };
    case 'GROWTH_SHARE': return { compensationType: 'OPTION', optionGrantType: 'INTL', price: 'exercise_price', noted: true };
    case 'RSA': return null;
  }
}

/**
 * A grant's Kosmitor type from OCF: the note's when it gives one, else the compensation
 * type; an OPTION without ISO or NSO is taken as an NSO, and `assumed` says so
 * (warning ocf-option-type-assumed).
 */
export function awardTypeOf(compensationType: string, optionGrantType: string | undefined, noteType?: string): { type: AwardType; assumed: boolean } | null {
  const NOTED: AwardType[] = ['ISO', 'NSO', 'RSU', 'SAR', 'PHANTOM', 'GROWTH_SHARE', 'RSA'];
  if (noteType && (NOTED as string[]).includes(noteType)) return { type: noteType as AwardType, assumed: false };
  switch (compensationType) {
    case 'OPTION_ISO': return { type: 'ISO', assumed: false };
    case 'OPTION_NSO': return { type: 'NSO', assumed: false };
    case 'OPTION': return optionGrantType === 'ISO' || optionGrantType === 'NSO' ? { type: optionGrantType, assumed: false } : { type: 'NSO', assumed: true };
    case 'RSU': return { type: 'RSU', assumed: false };
    case 'CSAR': case 'SSAR': return { type: 'SAR', assumed: false };
    default: return null;
  }
}

/** A SAFE or note as OCF's convertible type and conversion mechanism. */
export function convertibleTypeOf(instrument: ConvertibleInstrument): { convertibleType: 'SAFE' | 'NOTE' | 'CONVERTIBLE_SECURITY'; mechanism: 'SAFE_CONVERSION' | 'CONVERTIBLE_NOTE_CONVERSION'; timing?: 'PRE_MONEY' | 'POST_MONEY' } {
  switch (instrument) {
    case 'SAFE_POST': return { convertibleType: 'SAFE', mechanism: 'SAFE_CONVERSION', timing: 'POST_MONEY' };
    case 'SAFE_PRE': return { convertibleType: 'SAFE', mechanism: 'SAFE_CONVERSION', timing: 'PRE_MONEY' };
    case 'NOTE': return { convertibleType: 'NOTE', mechanism: 'CONVERTIBLE_NOTE_CONVERSION' };
    case 'KISS': return { convertibleType: 'CONVERTIBLE_SECURITY', mechanism: 'CONVERTIBLE_NOTE_CONVERSION' };
  }
}

/**
 * A convertible's instrument from OCF: the note's when it gives one; a SAFE by its
 * timing, post-money when it has none (`assumed`, info instrument-assumed); a note or
 * any other convertible security as a NOTE.
 */
export function instrumentOf(convertibleType: string, timing: string | undefined, noteInstrument?: string): { instrument: ConvertibleInstrument; assumed: boolean } {
  if (noteInstrument === 'SAFE_PRE' || noteInstrument === 'SAFE_POST' || noteInstrument === 'NOTE' || noteInstrument === 'KISS') return { instrument: noteInstrument, assumed: false };
  if (convertibleType === 'SAFE') return timing === 'PRE_MONEY' ? { instrument: 'SAFE_PRE', assumed: false } : { instrument: 'SAFE_POST', assumed: timing !== 'POST_MONEY' };
  return { instrument: 'NOTE', assumed: false };
}

/** A note's compounding as OCF's compounding type and accrual period (simple interest accrues daily). */
export const COMPOUNDING_TO_OCF: Record<InterestCompounding, { compoundingType: 'SIMPLE' | 'COMPOUNDING'; accrualPeriod: 'DAILY' | 'MONTHLY' | 'ANNUAL' }> = {
  SIMPLE: { compoundingType: 'SIMPLE', accrualPeriod: 'DAILY' },
  ANNUAL: { compoundingType: 'COMPOUNDING', accrualPeriod: 'ANNUAL' },
  MONTHLY: { compoundingType: 'COMPOUNDING', accrualPeriod: 'MONTHLY' },
  DAILY: { compoundingType: 'COMPOUNDING', accrualPeriod: 'DAILY' },
};
/** Back from OCF: quarterly and semi-annual compounding are taken as annual (`approximate`, warning ocf-terms-approximate). */
export function compoundingOf(compoundingType: string, accrualPeriod: string): { compounding: InterestCompounding; approximate: boolean } {
  if (compoundingType !== 'COMPOUNDING') return { compounding: 'SIMPLE', approximate: false };
  if (accrualPeriod === 'MONTHLY' || accrualPeriod === 'DAILY' || accrualPeriod === 'ANNUAL') return { compounding: accrualPeriod, approximate: false };
  return { compounding: 'ANNUAL', approximate: true };
}

// ---------------------------------------------------------------------------
// OCF to Kosmitor
// ---------------------------------------------------------------------------

/** What a value read from a package came to, or why it could not be read. */
export interface OcfIssue {
  code: 'ocf-bad-object' | 'ocf-currency' | 'bad-date' | 'not-positive';
  text: string;
  /** The JSON path of the field within its object, as `exercise_price.amount`. */
  field: string;
  value?: string;
}
export type Read<T> = { ok: true; value: T; rounded: boolean } | { ok: false; issue: OcfIssue };

const fail = <T>(code: OcfIssue['code'], field: string, text: string, value?: unknown): Read<T> =>
  ({ ok: false, issue: { code, field, text, ...(value === undefined ? {} : { value: typeof value === 'string' ? value : JSON.stringify(value) }) } });
const got = <T>(value: T, rounded = false): Read<T> => ({ ok: true, value, rounded });

export const isNumeric = (v: unknown): v is string => typeof v === 'string' && NUMERIC.test(v);

/**
 * A Numeric string times 10^scale as an integer, by string arithmetic: the integer
 * part shifted left, plus the first `scale` fraction digits, rounded half away from
 * zero on the rest. Null when it is not a Numeric or the result passes
 * Number.MAX_SAFE_INTEGER.
 */
export function scaleDecimal(s: string, scale: number): { value: number; rounded: boolean } | null {
  if (!NUMERIC.test(s)) return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace(/^[+-]/, '').split('.');
  const kept = (frac + '0'.repeat(scale)).slice(0, scale);
  const rest = frac.slice(scale);
  let n = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept || '0');
  const rounded = /[1-9]/.test(rest);
  if (rest !== '' && rest[0] >= '5') n += 1n;
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(n);
  return { value: neg && value !== 0 ? -value : value, rounded };
}

/**
 * An OCF Monetary as integer cents (`unit` cents) or micro-cents (`unit` micros). An
 * amount in another currency than the company's is refused (ocf-currency): nothing is
 * converted. `rounded` says the amount had more decimals than the unit keeps (info ocf-rounded).
 */
export function readMoney(m: unknown, field: string, companyCurrency: string, unit: 'cents' | 'micros'): Read<number> {
  if (!m || typeof m !== 'object') return fail('ocf-bad-object', field, `${field} is not an amount with a currency.`, m);
  const { amount, currency } = m as { amount?: unknown; currency?: unknown };
  if (!isNumeric(amount)) return fail('ocf-bad-object', `${field}.amount`, `${field}.amount is not a number OCF allows.`, amount);
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return fail('ocf-bad-object', `${field}.currency`, `${field}.currency is not a three-letter currency code.`, currency);
  if (currency !== companyCurrency) return fail('ocf-currency', `${field}.currency`, `Amount in ${currency}; this company keeps its cap table in ${companyCurrency}.`, currency);
  const scaled = scaleDecimal(amount, unit === 'cents' ? 2 : 6);
  if (!scaled) return fail('ocf-bad-object', `${field}.amount`, `${field}.amount is too large.`, amount);
  return got(scaled.value, scaled.rounded);
}

/** A share count: a Numeric, finite, at most 1e12 either way. Fractions are allowed (roundShares). */
export function readShares(s: unknown, field: string): Read<number> {
  if (!isNumeric(s)) return fail('ocf-bad-object', field, `${field} is not a number OCF allows.`, s);
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) return fail('ocf-bad-object', field, `${field} is out of range.`, s);
  return got(n);
}

/** Any other Numeric (a multiple, a seniority, votes per share) as a number. */
export function readNumber(s: unknown, field: string): Read<number> {
  if (!isNumeric(s)) return fail('ocf-bad-object', field, `${field} is not a number OCF allows.`, s);
  const n = Number(s);
  return Number.isFinite(n) ? got(n) : fail('ocf-bad-object', field, `${field} is out of range.`, s);
}

/** A Ratio as one number (numerator / denominator), positive. */
export function readRatio(r: unknown, field: string): Read<number> {
  if (!r || typeof r !== 'object') return fail('ocf-bad-object', field, `${field} is not a ratio.`, r);
  const { numerator, denominator } = r as { numerator?: unknown; denominator?: unknown };
  if (!isNumeric(numerator)) return fail('ocf-bad-object', `${field}.numerator`, `${field}.numerator is not a number OCF allows.`, numerator);
  if (!isNumeric(denominator)) return fail('ocf-bad-object', `${field}.denominator`, `${field}.denominator is not a number OCF allows.`, denominator);
  const n = Number(numerator), d = Number(denominator);
  if (!(d > 0) || !(n > 0)) return fail('ocf-bad-object', field, `${field} must be greater than zero.`, r);
  return got(n / d);
}

/** A Percentage (0 to 1) as a fraction. */
export function readPercentage(s: unknown, field: string): Read<number> {
  if (typeof s !== 'string' || !PERCENTAGE.test(s) || s === '' || s === '.') return fail('ocf-bad-object', field, `${field} is not a percentage from 0 to 1.`, s);
  return got(Number(s.startsWith('.') ? `0${s}` : s));
}

/** A date: YYYY-MM-DD and a real day of the calendar (bad-date otherwise). */
export function readDate(s: unknown, field: string): Read<string> {
  if (typeof s !== 'string' || !isCalendarDate(s)) return fail('bad-date', field, `${field} is not a date (YYYY-MM-DD).`, s);
  return got(s);
}

export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
