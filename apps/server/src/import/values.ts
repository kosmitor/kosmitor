/**
 * Import schemas and value coercion.
 *
 * Each import kind declares the fields it can take, with synonyms used to
 * guess a column mapping from the spreadsheet's headers. Coercers turn the
 * messy cell values real spreadsheets contain — "$1,250,000", "20%",
 * "Jan 15, 2024", Excel serial numbers, "Yes" — into the engine's units.
 */
import { excelSerialToISO } from './xlsx.ts';
import { config } from '../config.ts';

export type Cell = string | number | boolean | null | undefined;
export type ImportKind = 'stakeholders' | 'captable' | 'grants' | 'convertibles';
export type FieldType = 'text' | 'number' | 'money' | 'price' | 'percent' | 'date' | 'boolean' | 'enum';
export type DateOrder = 'auto' | 'MDY' | 'DMY';
/** How a file writes numbers: 1,234.56 ('en') or 1.234,56 ('eu'). */
export type NumberFormat = 'en' | 'eu';
export const NUMBER_FORMATS: NumberFormat[] = ['en', 'eu'];

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  synonyms: string[];
  hint?: string;
}

export interface KindSpec {
  key: ImportKind;
  label: string;
  description: string;
  fields: FieldSpec[];
  /** Header row plus two example rows for the downloadable template. */
  template: string[][];
}

const holderFields: FieldSpec[] = [
  { key: 'stakeholderName', label: 'Stakeholder', type: 'text', required: true,
    synonyms: ['stakeholder', 'stakeholder name', 'name', 'holder', 'holder name', 'shareholder', 'shareholder name', 'investor', 'investor name', 'employee', 'employee name', 'full name', 'legal name', 'recipient', 'optionee', 'grantee', 'participant', 'owner'] },
  { key: 'email', label: 'Email', type: 'text',
    synonyms: ['email', 'e mail', 'email address', 'stakeholder email', 'work email'],
    hint: 'Used to match existing stakeholders before falling back to the name.' },
];

export const IMPORT_KINDS: Record<ImportKind, KindSpec> = {
  stakeholders: {
    key: 'stakeholders', label: 'Stakeholders',
    description: 'People and entities on the register — founders, employees, advisors and investors — without any securities.',
    fields: [
      { key: 'stakeholderName', label: 'Name', type: 'text', required: true, synonyms: holderFields[0].synonyms },
      holderFields[1],
      { key: 'stakeholderType', label: 'Type', type: 'enum', synonyms: ['type', 'stakeholder type', 'entity type', 'holder type'], hint: 'Individual, entity, fund or trust. Guessed from the name when empty.' },
      { key: 'relation', label: 'Relationship', type: 'enum', synonyms: ['relationship', 'relation', 'role', 'category', 'stakeholder group', 'group'], hint: 'Founder, employee, advisor, contractor, investor, board member or other.' },
      { key: 'department', label: 'Department', type: 'text',
        synonyms: ['department', 'team', 'cost center', 'cost centre', 'business unit', 'division', 'group'],
        hint: 'Used to allocate stock-based compensation expense by cost centre.' },
      { key: 'title', label: 'Title', type: 'text', synonyms: ['title', 'job title', 'position'] },
      { key: 'startDate', label: 'Start date', type: 'date', synonyms: ['start date', 'hire date', 'joined', 'date joined', 'employment start', 'start'] },
      { key: 'terminationDate', label: 'Termination date', type: 'date', synonyms: ['termination date', 'end date', 'left', 'departure date', 'separation date', 'terminated'] },
      { key: 'taxCountry', label: 'Tax country', type: 'text', synonyms: ['country', 'tax country', 'tax residence', 'residence'] },
      { key: 'taxState', label: 'Tax state', type: 'text', synonyms: ['state', 'tax state', 'province', 'region'] },
      { key: 'address', label: 'Address', type: 'text', synonyms: ['address', 'mailing address', 'street address'] },
      { key: 'phone', label: 'Phone', type: 'text', synonyms: ['phone', 'phone number', 'telephone', 'mobile'] },
      { key: 'notes', label: 'Notes', type: 'text', synonyms: ['notes', 'note', 'comments', 'comment', 'memo'] },
    ],
    template: [
      ['Name', 'Email', 'Type', 'Relationship', 'Title', 'Start date', 'Termination date', 'Tax country', 'Tax state'],
      ['Avery Stone', 'avery@example.com', 'Individual', 'Founder', 'CEO', '2021-02-01', '', 'US', 'CA'],
      ['Foundry Seed Fund I, L.P.', 'ir@foundry.example', 'Fund', 'Investor', '', '', '', 'US', 'DE'],
    ],
  },

  captable: {
    key: 'captable', label: 'Cap table & certificates',
    description: 'Issued shares — one row per certificate. Missing stakeholders and share classes are created for you.',
    fields: [
      ...holderFields,
      { key: 'shareClassName', label: 'Share class', type: 'text', required: true,
        synonyms: ['share class', 'class', 'class name', 'security', 'security type', 'stock class', 'series', 'class of stock', 'share type', 'stock type', 'equity class', 'security class'],
        hint: 'Classes containing "preferred" or "series" are created as preferred.' },
      { key: 'quantity', label: 'Shares', type: 'number', required: true,
        synonyms: ['shares outstanding', 'outstanding shares', 'shares', 'quantity', 'number of shares', 'no of shares', 'qty', 'share count', 'shares issued', 'issued shares', 'amount', 'units', 'total shares'],
        hint: 'When an export has both, shares outstanding is preferred over shares issued.' },
      { key: 'pricePerShare', label: 'Price per share', type: 'price',
        synonyms: ['price per share', 'price', 'issue price', 'pps', 'purchase price', 'original issue price', 'price share', 'cost per share', 'share price', 'issue price per share'] },
      { key: 'issueDate', label: 'Issue date', type: 'date', required: true,
        synonyms: ['issue date', 'date issued', 'issued', 'date', 'issuance date', 'acquisition date', 'purchase date', 'date of issue', 'transaction date'] },
      { key: 'certificateNo', label: 'Certificate number', type: 'text',
        synonyms: ['certificate', 'certificate no', 'certificate number', 'cert', 'cert no', 'cert number', 'certificate id', 'security id', 'cert id', 'id'] },
      { key: 'vestingSchedule', label: 'Vesting schedule', type: 'text',
        synonyms: ['vesting schedule', 'vesting', 'schedule', 'vesting terms'],
        hint: 'A schedule name, or shorthand like "4y/1y monthly". Empty means not subject to vesting.' },
      { key: 'vestingStartDate', label: 'Vesting start', type: 'date',
        synonyms: ['vesting start date', 'vesting start', 'vesting commencement date', 'vest start', 'vesting commencement', 'vcd'] },
      { key: 'election83bFiledOn', label: '83(b) filed', type: 'date',
        synonyms: ['83b', '83 b', '83b filed', '83 b filed', '83b election', '83 b election', '83b date', 'election date'] },
      { key: 'boardApprovalDate', label: 'Board approval', type: 'date',
        synonyms: ['board approval', 'board approval date', 'approved', 'approval date', 'board approved'] },
      { key: 'relation', label: 'Relationship', type: 'enum', synonyms: ['relationship', 'relation', 'role', 'category', 'group'],
        hint: 'Used when a stakeholder has to be created.' },
      { key: 'stakeholderType', label: 'Stakeholder type', type: 'enum', synonyms: ['type', 'stakeholder type', 'entity type', 'holder type'] },
      { key: 'notes', label: 'Notes', type: 'text', synonyms: ['notes', 'note', 'comments', 'comment', 'memo'] },
    ],
    template: [
      ['Stakeholder', 'Email', 'Share class', 'Shares', 'Price per share', 'Issue date', 'Certificate', 'Vesting schedule', 'Vesting start', '83(b) filed'],
      ['Avery Stone', 'avery@example.com', 'Common', '4,200,000', '0.0001', '2021-02-01', 'CS-1', '4y/1y monthly', '2021-02-01', '2021-02-12'],
      ['Foundry Seed Fund I, L.P.', 'ir@foundry.example', 'Series Seed Preferred', '2,290,000', '0.8734', '2022-09-15', 'PS-1', '', '', ''],
    ],
  },

  grants: {
    key: 'grants', label: 'Equity awards',
    description: 'Options, RSUs and other awards — one row per grant, drawn from an equity plan.',
    fields: [
      ...holderFields,
      { key: 'awardType', label: 'Award type', type: 'enum', required: true,
        synonyms: ['award type', 'type', 'grant type', 'option type', 'security type', 'instrument', 'kind'],
        hint: 'ISO, NSO, RSU, RSA, SAR or phantom.' },
      { key: 'quantity', label: 'Shares', type: 'number', required: true,
        synonyms: ['shares', 'quantity', 'number of shares', 'no of shares', 'qty', 'options', 'options granted', 'shares granted', 'granted', 'units', 'amount', 'number of options', 'total granted'] },
      { key: 'strikePrice', label: 'Strike price', type: 'price',
        synonyms: ['strike price', 'strike', 'exercise price', 'price per share', 'price', 'exercise price per share'] },
      { key: 'grantDate', label: 'Grant date', type: 'date', required: true,
        synonyms: ['grant date', 'date of grant', 'date granted', 'granted on', 'date', 'award date', 'issue date'] },
      { key: 'vestingStartDate', label: 'Vesting start', type: 'date',
        synonyms: ['vesting start date', 'vesting start', 'vesting commencement date', 'vest start', 'vesting commencement', 'vcd', 'vesting date'] },
      { key: 'vestingSchedule', label: 'Vesting schedule', type: 'text',
        synonyms: ['vesting schedule', 'vesting', 'schedule', 'vesting terms', 'vesting period'],
        hint: 'A schedule name, or shorthand like "4y/1y monthly". Falls back to the default schedule you choose.' },
      { key: 'poolName', label: 'Equity plan', type: 'text',
        synonyms: ['plan', 'equity plan', 'pool', 'option pool', 'plan name', 'stock plan', 'incentive plan'],
        hint: 'Falls back to the default plan you choose.' },
      { key: 'expirationDate', label: 'Expiration date', type: 'date',
        synonyms: ['expiration date', 'expiry', 'expiry date', 'expires', 'expiration', 'term end'] },
      { key: 'boardApprovalDate', label: 'Board approval', type: 'date',
        synonyms: ['board approval', 'board approval date', 'approved', 'approval date', 'board approved'] },
      { key: 'exercisedQuantity', label: 'Exercised', type: 'number',
        synonyms: ['exercised settled', 'exercised', 'exercised shares', 'shares exercised', 'exercised quantity', 'options exercised'] },
      { key: 'exerciseDate', label: 'Exercise date', type: 'date',
        synonyms: ['exercise date', 'exercised date', 'date exercised', 'exercised on', 'last exercise date'],
        hint: 'When the exercised options were exercised. Without it they count as exercised from the grant date, in every past cap table.' },
      { key: 'cancelledQuantity', label: 'Cancelled', type: 'number',
        synonyms: ['amount cancelled', 'cancelled', 'canceled', 'forfeited', 'cancelled shares', 'shares cancelled', 'forfeited shares'] },
      { key: 'cancellationDate', label: 'Cancellation date', type: 'date',
        synonyms: ['cancellation date', 'cancelled date', 'canceled date', 'date cancelled', 'date canceled', 'cancelled on', 'canceled on', 'forfeiture date', 'forfeited on', 'date forfeited'],
        hint: 'When the cancelled shares were cancelled or forfeited. Without it, the holder\'s termination date is used when one is on record.' },
      { key: 'fmvAtGrant', label: 'FMV at grant', type: 'price',
        synonyms: ['fmv', 'fair market value', 'fmv at grant', '409a', '409a price', 'fmv per share'] },
      { key: 'label', label: 'Grant number', type: 'text',
        synonyms: ['grant number', 'grant id', 'grant no', 'award id', 'award number', 'option id', 'certificate id', 'certificate', 'id', 'reference'] },
      { key: 'earlyExercise', label: 'Early exercise', type: 'boolean',
        synonyms: ['early exercise', 'early exercisable', 'early exercise allowed', 'can early exercise'] },
      { key: 'notes', label: 'Notes', type: 'text', synonyms: ['notes', 'note', 'comments', 'comment', 'memo'] },
    ],
    template: [
      ['Stakeholder', 'Email', 'Award type', 'Shares', 'Strike price', 'Grant date', 'Vesting start', 'Vesting schedule', 'Expiration date', 'Board approval'],
      ['Priya Raman', 'priya@example.com', 'ISO', '420,000', '0.01', '2021-11-08', '2021-11-08', '4 years, 1 year cliff, monthly', '2031-11-08', '2021-11-08'],
      ['Lena Fischer', 'lena@example.com', 'RSU', '55,000', '', '2024-09-01', '2024-09-01', '4y/1y', '', '2024-09-01'],
    ],
  },

  convertibles: {
    key: 'convertibles', label: 'SAFEs & convertible notes',
    description: 'Outstanding SAFEs, KISSes and convertible notes — one row per instrument.',
    fields: [
      ...holderFields,
      { key: 'label', label: 'Instrument ID', type: 'text',
        synonyms: ['convertible id', 'safe id', 'note id', 'instrument id', 'security id', 'certificate id', 'id', 'reference', 'label'],
        hint: 'Used to recognise an instrument that was imported before.' },
      { key: 'instrument', label: 'Instrument', type: 'enum', required: true,
        synonyms: ['instrument', 'conversion type', 'safe type', 'type', 'security type', 'security', 'instrument type', 'kind', 'note type'],
        hint: 'Post-money SAFE, pre-money SAFE, convertible note or KISS. A plain "SAFE" or "Post-Money" is treated as a post-money SAFE.' },
      { key: 'principal', label: 'Principal', type: 'money', required: true,
        synonyms: ['principal', 'principal issued', 'principal amount', 'purchase amount', 'amount', 'investment', 'investment amount', 'amount invested', 'invested', 'principal outstanding'] },
      { key: 'issueDate', label: 'Issue date', type: 'date', required: true,
        synonyms: ['issue date', 'date', 'date issued', 'issued', 'grant date', 'investment date', 'closing date', 'signed', 'date signed', 'effective date'] },
      { key: 'valuationCap', label: 'Valuation cap', type: 'money',
        synonyms: ['valuation cap', 'cap', 'val cap', 'post money cap', 'pre money cap', 'valuation'] },
      { key: 'discount', label: 'Discount', type: 'percent',
        synonyms: ['discount', 'discount rate', 'conversion discount'], hint: '"20%" or "20" both mean twenty percent.' },
      { key: 'interestRate', label: 'Interest rate', type: 'percent',
        synonyms: ['interest', 'interest rate', 'rate', 'coupon'] },
      { key: 'compounding', label: 'Compounding', type: 'enum',
        synonyms: ['compounding', 'compound', 'interest type', 'accrual'], hint: 'Simple, annual, monthly or daily.' },
      { key: 'maturityDate', label: 'Maturity date', type: 'date',
        synonyms: ['maturity date', 'maturity', 'matures', 'due date'] },
      { key: 'mfn', label: 'MFN', type: 'boolean', synonyms: ['mfn', 'most favored nation', 'most favoured nation'] },
      { key: 'proRata', label: 'Pro rata right', type: 'boolean', synonyms: ['pro rata', 'pro rata right', 'pro rata rights', 'participation right'] },
      { key: 'status', label: 'Status', type: 'enum', synonyms: ['status', 'state'],
        hint: 'Outstanding, converted, cancelled or repaid. Cancelled instruments are kept for the record but excluded from the cap table.' },
      { key: 'settledDate', label: 'Settled on', type: 'date',
        synonyms: ['conversion date', 'converted on', 'date converted', 'repaid on', 'repayment date', 'cancelled on', 'settled on', 'settlement date'],
        hint: 'When a converted, repaid or cancelled instrument left the cap table. Without it, it is left out of every past cap table too.' },
      { key: 'notes', label: 'Notes', type: 'text', synonyms: ['notes', 'note', 'comments', 'comment', 'memo'] },
    ],
    template: [
      ['Stakeholder', 'Email', 'Instrument', 'Principal', 'Issue date', 'Valuation cap', 'Discount', 'Interest rate', 'Maturity date', 'MFN'],
      ['Juniper Angels SPV', 'spv@juniper.example', 'Post-money SAFE', '$400,000', '2023-11-02', '$24,000,000', '15%', '', '', 'No'],
      ['Bridgepoint Venture Debt', 'debt@bridgepoint.example', 'Convertible note', '$1,000,000', '2024-11-01', '$45,000,000', '20%', '8%', '2026-11-01', 'No'],
    ],
  },
};

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

export const normalizeHeader = (h: Cell): string =>
  String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Guesses which spreadsheet column feeds each field. Exact synonym matches
 * are claimed first across all fields — each field trying its synonyms in
 * preference order, so "Shares outstanding" beats "Shares issued" when an
 * export has both — then partial matches, so a header like "Vesting start
 * date" is never stolen by the generic "date" synonym.
 */
/** Whether a synonym appears in a header as whole words — "owner" is not in "ownership". */
const hasWords = (header: string, synonym: string): boolean => ` ${header} `.includes(` ${synonym} `);

export function suggestMapping(kind: ImportKind, headers: Cell[]): Record<string, number | null> {
  const spec = IMPORT_KINDS[kind];
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: Record<string, number | null> = {};
  for (const f of spec.fields) mapping[f.key] = null;

  for (const f of spec.fields) {
    for (const synonym of f.synonyms) {
      const idx = normalized.findIndex((h, i) => !used.has(i) && h === synonym);
      if (idx >= 0) { mapping[f.key] = idx; used.add(idx); break; }
    }
  }
  for (const f of spec.fields) {
    if (mapping[f.key] != null) continue;
    const idx = normalized.findIndex((h, i) =>
      !used.has(i) && h !== '' && f.synonyms.some((s) => s.length >= 4 && (hasWords(h, s) || s.includes(h))));
    if (idx >= 0) { mapping[f.key] = idx; used.add(idx); }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

export interface Coerced<T> { value: T | null; error: string | null }
const ok = <T>(value: T): Coerced<T> => ({ value, error: null });
/** An empty cell: no value and no error. Typed from the caller's return type. */
const empty = <T>(): Coerced<T> => ({ value: null, error: null });
const bad = <T>(error: string): Coerced<T> => ({ value: null, error });
const blank = (v: Cell): boolean => v == null || (typeof v === 'string' && v.trim() === '');

export function coerceText(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  return ok(String(v).trim());
}

/** Currency signs and the spaces, underscores and apostrophes some locales group digits with ("1 234", "1'000"). */
const NUMBER_NOISE = /[$€£¥\s_'’  ]/g;
/** One separator once, after one to three digits and before exactly three: "1,000" and "500.000" read either way. */
const AMBIGUOUS_GROUPING = /^-?[1-9]\d{0,2}[.,]\d{3}$/;

/**
 * The digits of a number as written, as Number() reads them. With both
 * separators the last is the decimal point ("1,234.56", "1.234,56"); one kind
 * used more than once groups thousands ("1,000,000", "1.000.000"); one used
 * once is a decimal point ("0,0001", "1.5") unless it could also group
 * thousands ("1,000", "500.000"), where the file's format decides: commas
 * group in 'en', dots in 'eu'.
 */
function plainDigits(s: string, format: NumberFormat): string {
  const commas = s.split(',').length - 1;
  const dots = s.split('.').length - 1;
  if (commas && dots) return s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (commas + dots === 0) return s;
  const separator = commas ? ',' : '.';
  if (commas + dots > 1) return s.split(separator).join('');
  if (AMBIGUOUS_GROUPING.test(s) && (separator === ',') === (format === 'en')) return s.replace(separator, '');
  return s.replace(',', '.');
}

/** True for a value like "1,000" or "500.000", which means a thousand times more in one number format than in the other. */
export function isAmbiguousNumber(v: Cell): boolean {
  return typeof v === 'string' && AMBIGUOUS_GROUPING.test(v.trim().replace(NUMBER_NOISE, ''));
}

export function coerceNumber(v: Cell, format: NumberFormat = 'en'): Coerced<number> {
  if (blank(v)) return empty();
  if (typeof v === 'number') return Number.isFinite(v) ? ok(v) : bad('is not a number');
  if (typeof v === 'boolean') return bad('is not a number');
  let s = String(v).trim();
  if (/^(-|—|n\/?a|none|null|uncapped|no cap|tbd)$/i.test(s)) return empty();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(NUMBER_NOISE, '');
  if (s.endsWith('%')) return bad(`"${v}" is a percentage, not a number`);
  let multiplier = 1;
  const scaled = /^(-?[\d.,]+)([kmb])$/i.exec(s);
  if (scaled) {
    multiplier = { k: 1e3, m: 1e6, b: 1e9 }[scaled[2].toLowerCase() as 'k' | 'm' | 'b'];
    s = scaled[1];
  }
  const n = Number(plainDigits(s, format)) * multiplier;
  if (s === '' || !Number.isFinite(n)) return bad(`"${v}" is not a number`);
  return ok(negative ? -n : n);
}

/** Dollars to integer cents. */
export function coerceMoney(v: Cell, format: NumberFormat = 'en'): Coerced<number> {
  const n = coerceNumber(v, format);
  return n.value == null ? n : ok(Math.round(n.value * 100));
}

/** Dollars per share to integer micro-cents. */
export function coercePrice(v: Cell, format: NumberFormat = 'en'): Coerced<number> {
  const n = coerceNumber(v, format);
  return n.value == null ? n : ok(Math.round(n.value * 1_000_000));
}

/** "20%", "20" and "0.2" all become 0.2; values at or below 1 are already fractions. */
export function coercePercent(v: Cell, format: NumberFormat = 'en'): Coerced<number> {
  if (blank(v)) return empty();
  const s = String(v).trim();
  const hasSign = s.endsWith('%');
  const n = coerceNumber(hasSign ? s.slice(0, -1) : s, format);
  if (n.value == null) return n.error ? bad(`"${v}" is not a percentage`) : n;
  const fraction = hasSign || n.value > 1 ? n.value / 100 : n.value;
  if (fraction < 0 || fraction > 1) return bad(`"${v}" is not a percentage between 0 and 100`);
  return ok(fraction);
}

export function coerceBoolean(v: Cell): Coerced<boolean> {
  if (blank(v)) return empty();
  if (typeof v === 'boolean') return ok(v);
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', 't', '1', 'x', '✓', '✔', 'on'].includes(s)) return ok(true);
  if (['no', 'n', 'false', 'f', '0', 'off', '-', '—'].includes(s)) return ok(false);
  return bad(`"${v}" is not yes or no`);
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function ymd(y: number, m: number, d: number): Coerced<string> {
  if (m < 1 || m > 12 || d < 1 || d > 31) return bad('is not a real date');
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return bad('is not a real date');
  return ok(date.toISOString().slice(0, 10));
}

const fullYear = (y: number): number => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/**
 * Accepts ISO dates and datetimes, numeric d/m/y in either order (ambiguous
 * ones follow `order`, by default locale.importDateOrder, whose "auto" reads
 * them month-first), month names in either position, and Excel serial numbers.
 */
export function coerceDate(v: Cell, order: DateOrder = config().locale.importDateOrder): Coerced<string> {
  if (blank(v)) return empty();
  if (typeof v === 'number') {
    const iso = excelSerialToISO(v);
    return iso ? ok(iso) : bad(`${v} is not a date`);
  }
  if (typeof v === 'boolean') return bad('is not a date');
  const s = String(v).trim();

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return withRaw(ymd(+m[1], +m[2], +m[3]), s);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    const dayFirst = order === 'DMY' || (order === 'auto' && a > 12 && b <= 12);
    return withRaw(dayFirst ? ymd(y, b, a) : ymd(y, a, b), s);
  }

  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return withRaw(ymd(fullYear(+m[3]), MONTHS[m[1].toLowerCase()], +m[2]), s);

  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return withRaw(ymd(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]), s);

  if (/^\d{5}$/.test(s)) {
    const iso = excelSerialToISO(Number(s));
    if (iso) return ok(iso);
  }
  return bad(`"${s}" is not a date`);
}

const withRaw = (c: Coerced<string>, raw: string): Coerced<string> => (c.error ? bad(`"${raw}" ${c.error}`) : c);

/** The first two numbers of a date written as text like 03/04/2024 or 15.01.24, which the day-month order decides; null for any other cell. */
export function dateParts(v: Cell): [number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Where a sheet shows how it writes something: the cell as written and its 1-based row in the spreadsheet. */
export interface Evidence { text: string; row: number }

export interface NumberFormatReading {
  format: NumberFormat;
  /** 'file' when a value can only be read one way, 'delimiter' for a semicolon CSV, 'default' from locale.locale. */
  decidedBy: 'file' | 'delimiter' | 'default';
  evidence: Evidence | null;
  /** Values that can only be read as 'en' and others only as 'eu': the majority won. */
  mixed: boolean;
}

/** Text that is only a number, with what grouping and currency it carries taken away. */
const numberText = (c: Cell): string | null => {
  if (typeof c !== 'string') return null;
  const s = c.trim().replace(/^\((.*)\)$/, '$1').replace(NUMBER_NOISE, '').replace(/%$/, '').replace(/[kmb]$/i, '');
  return /^-?\d[\d.,]*$/.test(s) && /[.,]/.test(s) ? s : null;
};
/** Written only the European way: "1.234,56", "1.000.000", "0,0001", "1,5". */
const ONLY_EU = [/^-?\d{1,3}(\.\d{3})+,\d+$/, /^-?\d{1,3}(\.\d{3}){2,}$/, /^-?\d+,\d+$/];
/** Written only the English way: "1,234.56", "1,000,000", "0.0001", "1.5". */
const ONLY_EN = [/^-?\d{1,3}(,\d{3})+\.\d+$/, /^-?\d{1,3}(,\d{3}){2,}$/, /^-?\d+\.\d+$/];

/** The decimal separator of locale.locale decides when the file does not. */
const localeFormat = (): NumberFormat => {
  try { return new Intl.NumberFormat(config().locale.locale).format(1.5).includes(',') ? 'eu' : 'en'; } catch { return 'en'; }
};

/**
 * How a sheet writes its numbers, from the values that can only be read one way:
 * "0,0001" or "1.234,56" only as 1.234,56, "0.0001" or "1,234,567" only as
 * 1,234.56. "1,000" and "500.000" say nothing. With no telling value, a CSV
 * separated by semicolons is taken as European, and anything else follows
 * locale.locale. `firstRow` is the spreadsheet row of rows[0], for the evidence.
 */
export function detectNumberFormat(rows: Cell[][], delimiter: string | null = null, firstRow = 1): NumberFormatReading {
  let eu: Evidence | null = null, en: Evidence | null = null;
  let euCount = 0, enCount = 0;
  rows.slice(0, 5000).forEach((row, i) => {
    for (const cell of row) {
      const s = numberText(cell);
      if (!s || AMBIGUOUS_GROUPING.test(s)) continue;
      if (ONLY_EU.some((p) => p.test(s))) { euCount++; eu ??= { text: String(cell).trim(), row: firstRow + i }; }
      else if (ONLY_EN.some((p) => p.test(s))) { enCount++; en ??= { text: String(cell).trim(), row: firstRow + i }; }
    }
  });
  if (euCount || enCount) {
    const format: NumberFormat = euCount > enCount ? 'eu' : 'en';
    return { format, decidedBy: 'file', evidence: format === 'eu' ? eu : en, mixed: euCount > 0 && enCount > 0 };
  }
  if (delimiter === ';') return { format: 'eu', decidedBy: 'delimiter', evidence: null, mixed: false };
  return { format: localeFormat(), decidedBy: 'default', evidence: null, mixed: false };
}

// ---------------------------------------------------------------------------
// Enumerations — tolerant of the many ways spreadsheets spell them
// ---------------------------------------------------------------------------

const clean = (v: Cell): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function coerceAwardType(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  const s = clean(v);
  if (/^(iso|incentive stock options?|incentive)$/.test(s)) return ok('ISO');
  if (/^(nso|nqso|nq|non ?qualified( stock)?( options?)?|non ?statutory( stock options?)?|nsq)$/.test(s)) return ok('NSO');
  if (/^(rsus?|restricted stock units?)$/.test(s)) return ok('RSU');
  if (/^(rsas?|restricted stock awards?|restricted stock)$/.test(s)) return ok('RSA');
  if (/^(sars?|stock appreciation rights?)$/.test(s)) return ok('SAR');
  if (/^(phantom( stock| shares?)?)$/.test(s)) return ok('PHANTOM');
  if (/^(growth shares?|hurdle shares?)$/.test(s)) return ok('GROWTH_SHARE');
  if (/^(options?|stock options?)$/.test(s)) return bad(`"${v}" is ambiguous — use ISO or NSO`);
  return bad(`"${v}" is not a recognised award type`);
}

export function coerceInstrument(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  const s = clean(v);
  if (/kiss/.test(s)) return ok('KISS');
  if (/note|debt|loan|\bcn\b/.test(s)) return ok('NOTE');
  if (/safe/.test(s)) return ok(/\bpre\b/.test(s) ? 'SAFE_PRE' : 'SAFE_POST');
  if (/\bpost\b/.test(s)) return ok('SAFE_POST');          // "Post-Money" on its own, as some exports put it
  if (/\bpre\b/.test(s)) return ok('SAFE_PRE');
  return bad(`"${v}" is not a recognised instrument`);
}

export function coerceConvertibleStatus(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  const s = clean(v);
  if (/outstanding|active|open|issued/.test(s)) return ok('OUTSTANDING');
  if (/convert/.test(s)) return ok('CONVERTED');
  if (/cancel|void|terminat|rescind/.test(s)) return ok('CANCELLED');
  if (/repaid|paid|redeem|settled|matured/.test(s)) return ok('REPAID');
  return bad(`"${v}" is not outstanding, converted, cancelled or repaid`);
}

export function coerceStakeholderType(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  const s = clean(v);
  if (/^(individual|person|natural person|human|private individual)$/.test(s)) return ok('INDIVIDUAL');
  if (/^(fund|venture fund|vc|vc fund|lp|limited partnership|investment fund|fund of funds)$/.test(s)) return ok('FUND');
  if (/^(trust|family trust|living trust|revocable trust)$/.test(s)) return ok('TRUST');
  if (/^(entity|legal entity|company|corporation|corp|llc|inc|ltd|organisation|organization|institution|institutional|firm|partnership|spv|holding|holdings|government|non profit|nonprofit)$/.test(s)) return ok('ENTITY');
  return bad(`"${v}" is not individual, entity, fund or trust`);
}

export function coerceRelation(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  const s = clean(v);
  if (/founder|co founder|cofounder/.test(s)) return ok('FOUNDER');
  if (/former|ex employee|departed|alumni|terminated/.test(s)) return ok('FORMER_EMPLOYEE');
  if (/employee|staff|team|officer|executive|exec/.test(s)) return ok('EMPLOYEE');
  if (/advisor|adviser|advisory/.test(s)) return ok('ADVISOR');
  if (/contractor|consultant|freelance/.test(s)) return ok('CONTRACTOR');
  if (/investor|fund|angel|vc|venture|lp|shareholder|lender/.test(s)) return ok('INVESTOR');
  // A board member is given a seat (boardSeatOf in engine.ts), so what only sounds like one is not:
  // an observer attends without a seat, and a "director of" something is a job title.
  if (/observer/.test(s)) return ok('OTHER');
  if (/director of/.test(s)) return ok('EMPLOYEE');
  if (/board|director/.test(s)) return ok('BOARD_MEMBER');
  if (/other|misc/.test(s)) return ok('OTHER');
  return bad(`"${v}" is not a recognised relationship`);
}

export function coerceCompounding(v: Cell): Coerced<string> {
  if (blank(v)) return empty();
  const s = clean(v);
  if (/simple|none|no/.test(s)) return ok('SIMPLE');
  if (/annual|year/.test(s)) return ok('ANNUAL');
  if (/month/.test(s)) return ok('MONTHLY');
  if (/da(y|ily)/.test(s)) return ok('DAILY');
  return bad(`"${v}" is not simple, annual, monthly or daily`);
}

/** Entity-looking names default to entities so investors do not become "individuals". */
export function guessStakeholderType(name: string): 'INDIVIDUAL' | 'ENTITY' | 'FUND' | 'TRUST' {
  const s = name.toLowerCase();
  if (/\btrust\b/.test(s)) return 'TRUST';
  if (/\b(l\.?p\.?|fund|capital|ventures|partners|spv|holdings|investments?)\b/.test(s)) return 'FUND';
  if (/\b(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|gmbh|s\.?a\.?|plc|co\.?)\b/.test(s)) return 'ENTITY';
  return 'INDIVIDUAL';
}

/** "4y/1y monthly", "48/12", "4 years, 1 year cliff", "fully vested". */
export function parseVestingShorthand(text: string): { durationMonths: number; cliffMonths: number; frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'; fullyVested: boolean } | null {
  const t = text.toLowerCase().trim();
  // A shorthand is a phrase: the cliff patterns below would take time over a long run of digits.
  if (!t || t.length > 300) return null;
  if (/^(fully\s*vested|immediate(ly)?|vested|none|n\/?a|no vesting|100\s*%)$/.test(t)) {
    return { durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', fullyVested: true };
  }
  // "1/48 monthly, 25% vest at 12 month cliff" — one share in N per period, cliff stated separately.
  const fraction = /(?:^|[^\d.])1\s*\/\s*(\d{1,3})\b/.exec(t);
  if (fraction) {
    const frequency = /quarter/.test(t) ? 'QUARTERLY' : /annual|yearly/.test(t) ? 'ANNUAL' : 'MONTHLY';
    const durationMonths = Number(fraction[1]) * (frequency === 'QUARTERLY' ? 3 : frequency === 'ANNUAL' ? 12 : 1);
    let cliffMonths = 0;
    const cliff = /(\d+)\s*(months?|mos?|years?|yrs?)\s*cliff|(?:at|after)\s*(\d+)\s*(months?|mos?|years?|yrs?)/.exec(t);
    if (cliff) {
      const n = Number(cliff[1] ?? cliff[3]);
      cliffMonths = (cliff[2] ?? cliff[4] ?? 'm').startsWith('y') ? n * 12 : n;
    }
    if (/no\s*cliff/.test(t)) cliffMonths = 0;
    return { durationMonths, cliffMonths: Math.min(cliffMonths, durationMonths), frequency, fullyVested: false };
  }
  const numbers = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(years?|yrs?|y|months?|mos?|m)?\b/g)];
  if (numbers.length === 0) return null;
  const toMonths = (n: string, unit: string | undefined): number => {
    const value = Number(n);
    if (unit?.startsWith('y')) return Math.round(value * 12);
    if (unit?.startsWith('m')) return Math.round(value);
    return value <= 10 ? Math.round(value * 12) : Math.round(value);   // bare small numbers are years
  };
  let duration = toMonths(numbers[0][1], numbers[0][2]);
  let cliff = numbers[1] ? toMonths(numbers[1][1], numbers[1][2]) : 0;
  // "1 year cliff, 4 years" — the number that is followed by "cliff" is the cliff.
  const firstIsCliff = /^\s*cliff/.test(t.slice(numbers[0].index! + numbers[0][0].length));
  if (firstIsCliff && numbers[1]) [duration, cliff] = [cliff, duration];
  if (/no\s*cliff/.test(t)) cliff = 0;
  const frequency = /quarter/.test(t) ? 'QUARTERLY' : /annual|yearly/.test(t) ? 'ANNUAL' : 'MONTHLY';
  if (duration <= 0) return null;
  return { durationMonths: duration, cliffMonths: Math.min(cliff, duration), frequency, fullyVested: false };
}

/**
 * Which row holds the column headers. Exports often open with a title block
 * ("CS-Common", "Pulley", a date) before the real header, so the widest row
 * among the first ten — the one naming the most columns — wins over the first.
 */
export function guessHeaderRow(rows: Cell[][]): number {
  let best = 0;
  let bestCount = -1;
  rows.slice(0, 10).forEach((row, i) => {
    const count = row.filter((c) => c != null && String(c).trim() !== '').length;
    if (count > bestCount) { best = i; bestCount = count; }
  });
  return best;
}

/**
 * Some exports put one share class per sheet and name the sheet after it:
 * "CS-Common", "PSS-Series Seed Preferred", "Series A Preferred". When a
 * certificate sheet has no share class column, the sheet name fills in.
 */
export function shareClassFromSheetName(sheetName: string | null | undefined): string | null {
  if (!sheetName) return null;
  const name = sheetName.trim().replace(/^[A-Z]{1,5}\s*-\s*(?=\S)/, '').trim();
  if (!/common|preferred|series\s+[a-z0-9]|ordinary|class\s+[a-z]\b|founders?\s+stock/i.test(name)) return null;
  return name;
}

export interface SheetDetection {
  kind: ImportKind | null;
  mapping: Record<string, number | null>;
  constants: Record<string, string>;
  score: number;
  requiredCount: number;
  mapped: number;
  reason: string | null;
  /**
   * Required fields of `kind` with no column and no fixed value. Empty when the
   * sheet is ready; set when the sheet is plainly a ledger short of a column
   * (certificates with no share class), so the person is asked for it.
   */
  missing: string[];
}

const KIND_ORDER: ImportKind[] = ['stakeholders', 'captable', 'grants', 'convertibles'];
/** Columns only a real stakeholder list has. */
const STAKEHOLDER_EVIDENCE = ['email', 'address', 'phone', 'title', 'taxCountry', 'taxState', 'startDate', 'terminationDate'];

/** What a sheet's name says it holds, checked most specific first ("2022 Stock Plan" is grants, not stock). */
function kindHintFromName(name: string): ImportKind | null {
  const n = name.toLowerCase();
  if (/convertible|safe|note|kiss|debt|bridge/.test(n)) return 'convertibles';
  if (/plan|option|grant|award|rsu|esop|equity incentive/.test(n)) return 'grants';
  if (/stakeholder|holder|people|investor|contact|employee|member/.test(n)) return 'stakeholders';
  if (/common|preferred|series|certificate|share|stock|ordinary|class/.test(n)) return 'captable';
  return null;
}

/** Column guesses plus the fixed values a sheet implies, for one kind. */
export function suggestForSheet(kind: ImportKind, sheetName: string | null, headers: Cell[]): Omit<SheetDetection, 'kind' | 'reason'> {
  const mapping = suggestMapping(kind, headers);
  const constants: Record<string, string> = {};
  if (kind === 'captable' && mapping.shareClassName == null) {
    const fromSheet = shareClassFromSheetName(sheetName);
    if (fromSheet) constants.shareClassName = fromSheet;
  }
  // A grants tab named after its plan ("2022 Stock Plan") names the plan the same way a class tab names its class.
  if (kind === 'grants' && mapping.poolName == null && sheetName && kindHintFromName(sheetName) === 'grants' && /plan|esop|equity incentive/i.test(sheetName)) {
    constants.poolName = sheetName.trim();
  }
  const required = IMPORT_KINDS[kind].fields.filter((f) => f.required);
  const score = required.filter((f) => mapping[f.key] != null || f.key in constants).length;
  const mapped = Object.values(mapping).filter((v) => v != null).length + Object.keys(constants).length;
  return { mapping, constants, score, requiredCount: required.length, mapped, missing: missingFields(kind, { mapping, constants }) };
}

/** Required fields of a kind that a suggestion leaves without a column or a fixed value. */
export function missingFields(kind: ImportKind, s: { mapping: Record<string, unknown>; constants?: Record<string, string> }): string[] {
  return IMPORT_KINDS[kind].fields.filter((f) => f.required && s.mapping[f.key] == null && !(f.key in (s.constants ?? {}))).map((f) => f.key);
}

/**
 * Which kind of records a sheet holds, from its headers and name. A kind is a
 * candidate only when every required field has a column (or a value the sheet
 * name implies); summary and ownership tabs fail that test and are left out.
 * Among candidates the most specific wins — more required fields covered, then
 * what the name says, then the caller's preference, then the most columns used.
 *
 * A ledger short of one column is still a ledger: rows of holders and share
 * counts (or amounts) with no share class column are certificates that need
 * the class, not a stakeholder list whose numbers can be dropped. Such a sheet
 * comes back with its kind and the fields it is `missing`, so the person is
 * asked for them instead of losing the columns without a word.
 */
export function detectSheet(name: string, headers: Cell[], rowCount: number, preferred: ImportKind | null = null): SheetDetection {
  const hint = kindHintFromName(name);
  const perKind = KIND_ORDER.map((kind) => ({ kind, ...suggestForSheet(kind, name, headers) }));
  const fallback = perKind.find((k) => k.kind === (preferred ?? 'captable'))!;
  if (rowCount <= 0) return { ...fallback, kind: null, missing: [], reason: 'No data rows below the header' };

  // A holder column and a share count or amount, but not every required column: a ledger with a gap. A sheet
  // named for people ("Shareholders") needs one more ledger column than that, since a people list may carry a total.
  const nearLedger = perKind
    .filter((k) => k.kind !== 'stakeholders' && k.score < k.requiredCount && k.score >= (hint === 'stakeholders' ? 3 : 2)
      && k.mapping.stakeholderName != null && (k.mapping.quantity != null || k.mapping.principal != null)
      && (hint == null || hint === k.kind || hint === 'stakeholders'))
    .sort((a, b) => b.score - a.score || (hint === b.kind ? 1 : 0) - (hint === a.kind ? 1 : 0)
      || (preferred === b.kind ? 1 : 0) - (preferred === a.kind ? 1 : 0) || b.mapped - a.mapped)[0];
  const withGap = (k: typeof perKind[number]): SheetDetection => {
    const labels = k.missing.map((key) => IMPORT_KINDS[k.kind].fields.find((f) => f.key === key)!.label.toLowerCase());
    return { ...k, reason: `Looks like ${IMPORT_KINDS[k.kind].label.toLowerCase()}, but no column holds the ${labels.join(' or the ')}.` };
  };

  // A stakeholder list carries contact details; an ownership summary has a name, maybe a type, and numbers.
  const isPeopleList = (k: typeof perKind[number]): boolean =>
    hint === 'stakeholders' || STAKEHOLDER_EVIDENCE.some((f) => k.mapping[f] != null);
  const candidates = perKind.filter((k) => k.score === k.requiredCount && (k.kind !== 'stakeholders' || isPeopleList(k)));
  if (candidates.length === 0) {
    if (nearLedger) return withGap(nearLedger);
    const closest = [...perKind].filter((k) => k.kind !== 'stakeholders').sort((a, b) => b.score - a.score || b.mapped - a.mapped)[0];
    if (closest.score < 2) {
      const people = perKind.find((k) => k.kind === 'stakeholders')!;
      return {
        ...fallback, kind: null, missing: [],
        reason: people.mapping.stakeholderName != null
          ? 'Names without contact details or ledger columns — looks like an ownership summary, not a stakeholder list.'
          : 'No ledger columns — looks like a summary.',
      };
    }
    const missing = missingFields(closest.kind, closest).map((key) => IMPORT_KINDS[closest.kind].fields.find((f) => f.key === key)!.label.toLowerCase());
    return {
      ...fallback, kind: null, missing: [],
      reason: `Not a ${IMPORT_KINDS[closest.kind].label.toLowerCase()} sheet — no column for ${missing.join(', ')}. Probably a summary.`,
    };
  }
  const rank = (k: typeof candidates[number]): number =>
    k.score * 1000 + (hint === k.kind ? 100 : 0) + (preferred === k.kind ? 10 : 0) + Math.min(k.mapped, 9);
  const best = candidates.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  // Only a stakeholder list fits, yet the sheet has share counts or amounts: read as people, they would be dropped.
  if (best.kind === 'stakeholders' && nearLedger) return withGap(nearLedger);
  return { ...best, reason: null };
}
