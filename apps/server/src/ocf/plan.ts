/**
 * An Open Cap Format package checked against a company: what each object becomes,
 * row by row, and the records and ledger entries the import would write
 * (docs/importing.md, "OCF packages"; docs/ocf.md, "Importing").
 *
 * Nothing here writes. `prepareOcf` reads the package and the company and works out:
 *
 * - one row per object a person checks, in sections (stakeholders, share classes,
 *   plans, vesting, valuations, certificates, grants, warrants, SAFEs and notes,
 *   and History for every other transaction), numbered by the object's place in
 *   its files ("item 12");
 * - for each security, its chain (the balance certificates that carry it on, a
 *   re-issue for a split) on one Kosmitor row, and its family: the certificates
 *   its transfers, exercises and conversions created, and theirs. A family is
 *   imported whole, or not at all;
 * - each row's events replayed in date order into the row's final state and the
 *   dated ledger entries that rebuild every earlier date (rewindToDate in
 *   packages/core/src/ledger.ts), in the shares of each event's date;
 * - what is already on the cap table: the same rows of this company when the package
 *   came from it (rule 1), else people, classes and securities matched as a
 *   spreadsheet's are (rule 2). A family is wholly new or wholly there;
 * - the cascade: a row that waits for another's fix, or is left out with it.
 *
 * `runOcf` runs it inside runWorkbook's transaction and, when nothing is blocked,
 * writes it (write.ts).
 */
import { randomUUID } from 'node:crypto';
import { all, one } from '../db.ts';
import {
  roundShares, today, addMonths, shareValue,
  type VestingSchedule,
} from '@kosmitor/core';
import {
  Company, Claims, emptyPlan, findPerson, boardSeatOf, personKey, nameKey, defaultRelation,
  issuanceFingerprint, awardFingerprint, convertibleFingerprint, warrantFingerprint, nearKey, PERSON_FIELDS, FIELD_WORDS, shown, EMPTY_IMPORTED,
  type RowMessage, type PreviewRow, type RowOutcome, type ImportCounts, type Notice, type NewPerson, type WorkbookSheetResult,
  type MessageCode, type OnFile, type Known, type ImportResult, type Recorded,
} from '../import/engine.ts';
import { config } from '../config.ts';
import { SINGLE_ADDRESS } from '../mail.ts';
import { usd, perShare } from '../templates.ts';
import * as C from './convert.ts';
import { readNote, plainComments, type NotedSchedule, type RsaOfCertificateNote } from './notes.ts';
import {
  scheduleFromTerms, evaluateTerms, customSchedule, scheduleTranches, sameTranches, describeSchedule, termsDateCount, VestingTermsError, type Tranche,
} from './vesting.ts';
import { readOcfPackage, OcfRefusal, SECTION_TITLES, OCF_SECTIONS, type OcfSection, type OcfRun, type OcfSummary, type OcfPackageRead } from './read.ts';
import { writeOcfPlan, type OcfWritePlan } from './write.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const id = (p: string): string => `${p}_${randomUUID().slice(0, 12)}`;
/** An OCF id as a memo or message names it: a package may give ids of any length. */
const ref = (ocfId: string): string => (ocfId.length > 120 ? `${ocfId.slice(0, 117)}…` : ocfId);
/** Text from a package, trimmed and cut to what a column holds. */
const cut = (v: unknown, max: number): string | null => { const t = str(v); return t ? t.slice(0, max) : null; };
const count = (n: number): string => n.toLocaleString(config().locale.locale);
const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 + 1e-9 * Math.abs(b);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/**
 * A table's own entry for a key a package gives: never one Object.prototype lends it
 * ("constructor", "toString"), which a package may well use as an id or a type.
 */
const lookup = <T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined =>
  (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
/**
 * The most vesting dates a package's securities may have in all, worked out per
 * security or stored in their schedules: a few bytes of terms could otherwise ask the
 * check for millions of them. A package past it is refused (ocf-too-large).
 */
export const MAX_PACKAGE_VESTING_DATES = 2_000_000;
/** What shares come to at a price (shareValue), in cents: null past what a column holds. */
const cents = (quantity: number, priceMicros: number): number | null => {
  const v = shareValue(quantity, priceMicros);
  return Number.isSafeInteger(v) ? v : null;
};
/** Entries that take options or shares off a grant: one kind for matching, whatever word the package used. */
const CANCELS = new Set(['CANCELLATION', 'FORFEITURE', 'EXPIRATION']);
const sameType = (a: string, b: string): boolean => a === b || (CANCELS.has(a) && CANCELS.has(b));

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One object a person checks: its messages, summary, what it depends on, and what becomes of it. */
class Row {
  readonly section: OcfSection;
  readonly item: number;
  readonly ocfId: string;
  /** The object_type it was read from. */
  object: string | null = null;
  /** How another row names it: "item 12 (CS-3)". */
  label: string;
  messages: RowMessage[] = [];
  summary: Record<string, string | number | null> = {};
  /** What the row does when nothing stops it. */
  base: 'add' | 'update' | 'existing' | 'skip' = 'add';
  /** On a row that is already there: where the package differs from the record. */
  notes: RowMessage[] = [];
  /** The rows it needs: its holder, class, plan, terms, a split before it. */
  deps = new Set<Row>();
  family: Family | null = null;
  excluded = false;
  excludedWith: Row | null = null;
  waitsFor: Row | null = null;
  outcome: RowOutcome = 'add';
  constructor(section: OcfSection, item: number, ocfId: string, label: string) {
    this.section = section;
    this.item = item;
    this.ocfId = ocfId.slice(0, 200);
    this.label = label.slice(0, 120);
  }
  say(level: RowMessage['level'], text: string, code: MessageCode, field?: string, value?: unknown): void {
    const m: RowMessage = { level, text, code };
    if (field) m.field = field;
    if (value !== undefined && value !== null) m.value = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : JSON.stringify(value).slice(0, 200);
    this.messages.push(m);
  }
  error(text: string, code: MessageCode, field?: string, value?: unknown): void { this.say('error', text, code, field, value); }
  warn(text: string, code: MessageCode, field?: string, value?: unknown): void { this.say('warning', text, code, field, value); }
  info(text: string, code: MessageCode, field?: string, value?: unknown): void { this.say('info', text, code, field, value); }
  /** An OCF value that could not be read, as the row's error. */
  issue(i: C.OcfIssue): void { this.error(i.text, i.code === 'not-positive' ? 'not-positive' : i.code, i.field, i.value); }
  get ownError(): boolean { return this.messages.some((m) => m.level === 'error'); }
  /** "item 12 (CS-3)". */
  get named(): string { return `item ${this.item}${this.label ? ` (${this.label})` : ''}`; }
}

interface Family { rows: Row[]; krows: KRow[]; retracted: string | null; existing: 'no' | 'yes' | 'differs'; differs: string | null }

// ---------------------------------------------------------------------------
// Securities
// ---------------------------------------------------------------------------

type SecKind = 'stock' | 'grant' | 'warrant' | 'convertible';
const ISSUANCE_KIND: Record<string, SecKind> = {
  TX_STOCK_ISSUANCE: 'stock', TX_EQUITY_COMPENSATION_ISSUANCE: 'grant', TX_PLAN_SECURITY_ISSUANCE: 'grant',
  TX_WARRANT_ISSUANCE: 'warrant', TX_CONVERTIBLE_ISSUANCE: 'convertible',
};

/** What each stock event is in Kosmitor's ledger. */
const STOCK_EVENTS: Record<string, string> = {
  TX_STOCK_TRANSFER: 'TRANSFER', TX_STOCK_REPURCHASE: 'REPURCHASE', TX_STOCK_CANCELLATION: 'CANCELLATION', TX_STOCK_CONVERSION: 'CONVERSION', TX_STOCK_REISSUANCE: 'TRANSFER',
};

/** A transaction of the package, with its item number. */
interface Tx { obj: Obj; item: number; type: string; date: string | null; ocfId: string }

/** An OCF security: its issuance and the events about it. */
interface Sec {
  ocfId: string;
  kind: SecKind;
  issue: Tx;
  events: Tx[];
  krow: KRow | null;
  /** The event that names it as a result or a balance. */
  producedBy: { tx: Tx; continuation: boolean } | null;
  /** Consumed: a balance or a result carries it on, or it closed. */
  closed: boolean;
}

/** A row of Kosmitor's: a security and the balances and re-issues that carry it on. */
interface KRow {
  id: string;
  kind: 'certificate' | 'rsa' | 'grant' | 'warrant' | 'convertible';
  section: OcfSection;
  secs: Sec[];
  row: Row;
  family: Family | null;
  /** The KRow whose event created this one, and that event. */
  parent: { krow: KRow; tx: Tx } | null;
  holder: Person | null;
  classId: string | null;
  className: string | null;
  label: string;
  date: string;
  record: Obj | null;
  entries: Entry[];
  exercises: Obj[];
  /** The fingerprint the record will be stored with, and what a look-alike shares with it. */
  print: { recorded: Recorded; fingerprint: string; near: string; what: string; amount: number } | null;
  matched: OnFile | null;
  /** Schedules this row needs that only it uses (per security), or a shared one by key. */
  scheduleKey: string | null;
  poolKey: string | null;
  results: KRow[];
  /** Its number is its own (false: the package's custom_id was made up from an id, and Kosmitor keeps none). */
  numbered: boolean;
  /** The restricted stock award a certificate is the shares of, which goes in with it: its record and entries. */
  companion: { record: Obj; entries: Entry[]; scheduleKey: string | null } | null;
}

/** A ledger entry to write, before the ids of what it names are settled. */
interface Entry extends Obj {
  id: string; type: string; date: string; quantity: number | null;
  /** The OCF transaction (or security) it records, for matching the company's own entries. */
  ocfTx: string | null;
}

interface Person {
  id: string; name: string; email: string | null; created: boolean; row: Row | null;
  /** The day they left, as the cap table will have it after the import: Kosmitor lapses their options from it. */
  terminationDate: string | null;
}

/** About how many dates a schedule vests a security on, as Kosmitor builds it (buildVestingSchedule). */
function scheduleSize(s: NotedSchedule): number {
  if (s.kind === 'FULLY_VESTED') return 1;
  if (s.kind === 'CUSTOM') return s.customTranches?.length ?? 0;
  if (s.kind === 'MILESTONE') return s.milestones?.length ?? 0;
  const months = Math.max(0, s.durationMonths);
  if (s.frequency === 'DAILY') return Math.ceil(months * 30.5) + 2;
  if (s.frequency === 'WEEKLY') return Math.ceil((months * 30.5) / 7) + 2;
  return Math.ceil(months / ({ MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 }[s.frequency] ?? 1)) + 2;
}

// ---------------------------------------------------------------------------
// The company as the import needs it
// ---------------------------------------------------------------------------

interface CompanyState {
  company: Company;
  row: Obj;
  currency: string;
  stakeholders: Map<string, Known>;
  classes: Obj[];
  schedules: Obj[];
  pools: Obj[];
  poolAdjustments: Obj[];
  valuations: Obj[];
  splits: Obj[];
  /** Every ledger entry about a security, by security id. */
  ledger: Map<string, { id: string; type: string; date: string; quantity: number | null }[]>;
  ledgerIds: Set<string>;
  securityIds: { issuances: Set<string>; awards: Set<string>; warrants: Set<string>; convertibles: Set<string> };
  hasSecurities: boolean;
  /** Who holds what an earlier OCF import created: the package security id its creation entry's memo names, to its holder. */
  ocfHolders: Map<string, string>;
  /** The date the company was created, and whether its cap table is empty: a new company's defaults are not choices. */
  createdOn: string | null;
}

async function loadState(companyId: string): Promise<CompanyState> {
  const company = await Company.load(companyId);
  const row = (await one<Obj>('SELECT name, legal_name, incorporation_date, jurisdiction, ein, address, currency, created_at FROM companies WHERE id = ?', companyId)) ?? {};
  const q = (sql: string) => all<Obj>(sql, companyId);
  const classes = await q('SELECT * FROM share_classes WHERE company_id = ? ORDER BY issue_date, name, id');
  const schedules = await q('SELECT * FROM vesting_schedules WHERE company_id = ? ORDER BY name, id');
  const pools = await q('SELECT * FROM pools WHERE company_id = ? ORDER BY created_at, id');
  const poolAdjustments = await q('SELECT * FROM pool_adjustments WHERE company_id = ? ORDER BY date, id');
  const valuations = await q('SELECT * FROM valuations WHERE company_id = ? ORDER BY effective_date, id');
  const splits = await q('SELECT * FROM stock_splits WHERE company_id = ? ORDER BY date, id');
  const entries = await q('SELECT id, type, date, quantity, security_id, stakeholder_id, memo FROM transactions WHERE company_id = ? ORDER BY date, created_at, id');
  const ids = async (table: string) => new Set((await q(`SELECT id FROM ${table} WHERE company_id = ?`)).map((r) => String(r.id)));
  const securityIds = { issuances: await ids('issuances'), awards: await ids('awards'), warrants: await ids('warrants'), convertibles: await ids('convertibles') };
  const ledger = new Map<string, { id: string; type: string; date: string; quantity: number | null }[]>();
  for (const e of entries) {
    if (!e.security_id) continue;
    const list = ledger.get(String(e.security_id)) ?? [];
    list.push({ id: String(e.id), type: String(e.type), date: String(e.date), quantity: e.quantity == null ? null : Number(e.quantity) });
    ledger.set(String(e.security_id), list);
  }
  const stakeholders = new Map<string, Known>();
  for (const list of company.stakeholdersByName.values()) for (const k of list) stakeholders.set(k.id, k);
  const ocfHolders = new Map<string, string>();
  for (const e of entries) {
    if ((e.type !== 'ISSUANCE' && e.type !== 'GRANT') || !e.stakeholder_id) continue;
    const named = /\(OCF ([^()]*)\)$/.exec(String(e.memo ?? ''))?.[1];
    if (named) ocfHolders.set(named, String(e.stakeholder_id));
  }
  return {
    company, row, currency: C.currencyOf(row.currency as string | null), stakeholders, classes, schedules, pools, poolAdjustments, valuations, splits,
    ledger, ledgerIds: new Set(entries.map((e) => String(e.id))), securityIds,
    hasSecurities: Object.values(securityIds).some((s) => s.size > 0), ocfHolders,
    createdOn: typeof row.created_at === 'string' ? row.created_at.slice(0, 10) : null,
  };
}

// ---------------------------------------------------------------------------
// The result of a check
// ---------------------------------------------------------------------------

export interface OcfPrepared {
  sections: WorkbookSheetResult[];
  /** Sections have errors and skipRowsWithErrors is off: nothing is written. */
  blocked: boolean;
  plan: OcfWritePlan;
  imported: ImportResult['imported'];
  newPeople: NewPerson[];
  createdClasses: string[];
  summary: OcfSummary;
}

const SUMMARY_KIND: Record<OcfSection, string> = {
  stakeholders: 'stakeholder', shareClasses: 'share class', plans: 'equity plan', vesting: 'vesting schedule', valuations: 'valuation',
  captable: 'certificate', grants: 'grant', warrants: 'warrant', convertibles: 'SAFE or note', events: 'event',
};

/** The object_type of the rows of a section that are one object each. */
const SECTION_OBJECT: Partial<Record<OcfSection, string>> = {
  stakeholders: 'STAKEHOLDER', shareClasses: 'STOCK_CLASS', plans: 'STOCK_PLAN', vesting: 'VESTING_TERMS', valuations: 'VALUATION',
};

/** What becomes of an object type the import does not bring in, in words. */
const NOT_IMPORTED: Record<string, string> = {
  TX_STOCK_ACCEPTANCE: 'Kosmitor records no acceptance of shares',
  TX_WARRANT_ACCEPTANCE: 'Kosmitor records no acceptance of a warrant',
  TX_CONVERTIBLE_ACCEPTANCE: 'Kosmitor records no acceptance of a SAFE or note',
  TX_STOCK_PLAN_RETURN_TO_POOL: 'each plan returns forfeited shares as its own setting says',
  TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT: 'Kosmitor keeps authorized shares by class, not for the company',
};

/** The rows of every section and what writing them would do. Pure: reads the company, writes nothing. */
export async function prepareOcf(companyId: string, run: OcfRun, createdBy: string | null): Promise<OcfPrepared> {
  const pkg = readOcfPackage(run.pkg);
  const state = await loadState(companyId);
  return new Checker(companyId, run, pkg, state, createdBy).check();
}

/** Prepares the package and, when nothing blocks it, writes it in the open transaction. */
export async function runOcf(companyId: string, run: OcfRun, createdBy: string | null): Promise<OcfPrepared & { importId: string | null }> {
  const prepared = await prepareOcf(companyId, run, createdBy);
  if (prepared.blocked) return { ...prepared, imported: EMPTY_IMPORTED(), importId: null };
  const importId = await writeOcfPlan(companyId, prepared.plan, {
    fileName: run.file, createdBy,
    counts: totalCounts(prepared.sections), sections: Object.fromEntries(prepared.sections.map((s) => [s.kind, s.preview.counts])),
    creates: prepared.sections.reduce((c, s) => ({
      stakeholders: [...c.stakeholders, ...s.preview.creates.stakeholders], shareClasses: [...c.shareClasses, ...s.preview.creates.shareClasses],
      vestingSchedules: [...c.vestingSchedules, ...s.preview.creates.vestingSchedules], pools: [...c.pools, ...s.preview.creates.pools],
    }), { stakeholders: [] as string[], shareClasses: [] as string[], vestingSchedules: [] as string[], pools: [] as string[] }),
  });
  return { ...prepared, importId };
}

const ZERO = (): ImportCounts => ({ total: 0, ok: 0, warnings: 0, errors: 0, skipped: 0, willImport: 0, existing: 0, excluded: 0 });
function totalCounts(sections: WorkbookSheetResult[]): ImportCounts {
  const c = ZERO();
  for (const s of sections) for (const k of Object.keys(c) as (keyof ImportCounts)[]) c[k] += s.blocked && k === 'willImport' ? 0 : s.preview.counts[k];
  return c;
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

class Checker {
  private readonly companyId: string;
  private readonly run: OcfRun;
  private readonly pkg: OcfPackageRead;
  private readonly s: CompanyState;
  private readonly createdBy: string | null;
  /** Rule 1: the package came from this company, so its ids are this company's rows. */
  private readonly sameCompany: boolean;
  private readonly today = today();
  private readonly t0 = Date.now();
  private readonly memo: string;

  private readonly rows = new Map<OcfSection, Row[]>(OCF_SECTIONS.map((s) => [s, []]));
  private readonly notImported = new Map<string, { what: string; count: number; reason: string }>();
  private readonly notices: Notice[] = [];

  // What the package's objects became, by their OCF id.
  private readonly people = new Map<string, Person>();
  private readonly classes = new Map<string, { id: string; name: string; kind: string; row: Row; created: boolean; record: Obj | null; issueDate: string }>();
  private readonly plans = new Map<string, { id: string; name: string; classId: string | null; row: Row; created: boolean; record: Obj | null; reserved: number; approval: string | null }>();
  private readonly terms = new Map<string, { obj: Obj; row: Row; reading: ReturnType<typeof scheduleFromTerms>; name: string }>();
  private readonly valuations: { date: string; price: number }[] = [];
  private readonly newPeople: NewPerson[] = [];

  // Write plan pieces.
  private readonly stakeholderRecords = new Map<Row, Obj>();
  private readonly stakeholderUpdates = new Map<Row, { id: string; updates: Obj }>();
  private readonly designations: { row: Row; ocfBy: string }[] = [];
  private readonly classRecords = new Map<Row, Obj>();
  private readonly classUpdates = new Map<Row, { id: string; updates: Obj }>();
  private readonly poolRecords = new Map<Row, Obj>();
  private readonly adjustmentRecords = new Map<Row, Obj>();
  private readonly valuationRecords = new Map<Row, Obj>();
  private readonly splitRecords = new Map<Row, { split: Obj; entry: Obj }>();
  /** Shared schedules by key (a terms object, a milestone variant, fully vested), with the rows that own them. */
  private readonly schedules = new Map<string, { record: Obj | null; existingId: string | null; name: string; row: Row | null }>();
  private readonly txs: Tx[] = [];
  /** The History row of each event, by its transaction. */
  private readonly eventRows = new Map<Tx, Row>();
  private readonly secs = new Map<string, Sec>();
  private readonly krows: KRow[] = [];
  /** The splits the cap table will have: on file, and the package's that are imported. */
  private splitDates: { date: string; ratio: number }[] = [];
  private readonly splitRows: { date: string; ratio: number; rows: Row[]; classes: Set<string> }[] = [];

  constructor(companyId: string, run: OcfRun, pkg: OcfPackageRead, state: CompanyState, createdBy: string | null) {
    this.companyId = companyId;
    this.run = run;
    this.pkg = pkg;
    this.s = state;
    this.createdBy = createdBy;
    this.sameCompany = !!pkg.issuer?.id && pkg.issuer.id === companyId;
    this.memo = `Imported from ${run.file}`;
  }

  /** A timestamp in the package's order, so records made in one import keep the order the package gives them. */
  private stamp(n: number): string { return new Date(this.t0 + n).toISOString(); }

  private readonly byId = new Map<OcfSection, Map<string, Row>>(OCF_SECTIONS.map((s) => [s, new Map()]));
  private add(row: Row): Row {
    this.rows.get(row.section)!.push(row);
    const index = this.byId.get(row.section)!;
    if (!index.has(row.ocfId)) index.set(row.ocfId, row);
    return row;
  }

  /**
   * A reference to another object of the package: its row becomes one this row needs, and
   * what it became is returned (null while that row has its own errors). An id the package
   * does not have is this row's error.
   */
  private ref<T>(row: Row, section: OcfSection, made: Map<string, T>, ocfId: unknown, field: string, what: string): T | null {
    if (typeof ocfId !== 'string' || ocfId === '') { row.error(`${field} is missing`, 'required', field); return null; }
    const target = this.byId.get(section)!.get(ocfId);
    // In plain words, the id after them: the field is in the message's own `field`.
    if (!target) { row.error(`Names ${what} (${ref(ocfId)}) that is not in the package`, 'ocf-unknown-reference', field, ocfId); return null; }
    row.deps.add(target);
    return made.get(ocfId) ?? null;
  }

  private skipped(what: string, reason: string, n = 1): void {
    const k = `${what}|${reason}`;
    const e = this.notImported.get(k);
    if (e) e.count += n; else this.notImported.set(k, { what, count: n, reason });
  }

  /** The items of every listed file of a type, in the manifest's order. */
  private items(fileType: string): unknown[] {
    return this.pkg.files.filter((f) => f.fileType === fileType).flatMap((f) => (Array.isArray(f.content.items) ? f.content.items : []));
  }

  check(): OcfPrepared {
    this.readTransactions();
    this.readStakeholders();
    this.readClasses();
    this.readPlans();
    this.readTerms();
    this.readValuations();
    this.readSplitsAndAdjustments();
    this.buildSecurities();
    for (const k of this.krows) this.resolve(k);
    this.settleTerms();
    for (const k of this.krows) this.replay(k);
    this.transferNotes();
    this.matchFamilies();
    this.exclude();
    this.cascade();
    this.settle();
    return this.finish();
  }

  // -------------------------------------------------------------------------
  // Money, dates and counts, read with the row's error when they cannot be
  // -------------------------------------------------------------------------

  private money(row: Row, m: unknown, field: string, unit: 'cents' | 'micros'): number | null {
    if (m == null) return null;
    const r = C.readMoney(m, field, this.s.currency, unit);
    if (!r.ok) { row.issue(r.issue); return null; }
    if (r.rounded) row.info(`${field} has more decimals than Kosmitor keeps; rounded to ${unit === 'cents' ? usd(r.value) : perShare(r.value)}`, 'ocf-rounded', field);
    return r.value;
  }
  private shares(row: Row, v: unknown, field: string, required = true): number | null {
    if (v == null) { if (required) row.error(`${field} is missing`, 'required', field); return null; }
    const r = C.readShares(v, field);
    if (!r.ok) { row.issue(r.issue); return null; }
    return r.value;
  }
  /** A date; one after today is flagged unless it lies ahead by nature (`ahead`: an expiry, a maturity). */
  private date(row: Row, v: unknown, field: string, required = true, ahead = false): string | null {
    if (v == null || v === '') { if (required) row.error(`${field} is missing`, 'required', field); return null; }
    const r = C.readDate(v, field);
    if (!r.ok) { row.issue(r.issue); return null; }
    if (r.value > this.today && !ahead) row.warn(`${field} ${r.value} is after today`, 'ocf-future-date', field, r.value);
    return r.value;
  }
  private kOf(from: string | null, to: string): number {
    let k = 1;
    for (const s of this.splitDates) if (s.date <= to && (from == null || s.date > from)) k *= s.ratio;
    return k;
  }
  private holderName(ocfId: unknown): string {
    return (typeof ocfId === 'string' && this.people.get(ocfId)?.name) || 'someone not in the package';
  }

  // -------------------------------------------------------------------------
  // Transactions, indexed
  // -------------------------------------------------------------------------

  private readTransactions(): void {
    this.items('OCF_TRANSACTIONS_FILE').forEach((raw, i) => {
      const item = i + 1;
      if (!isObj(raw) || typeof raw.object_type !== 'string' || typeof raw.id !== 'string') {
        const row = this.add(new Row('events', item, isObj(raw) && typeof raw.id === 'string' ? raw.id : `#${item}`, ''));
        row.summary = { date: null, event: isObj(raw) && typeof raw.object_type === 'string' ? raw.object_type : null, security: null, stakeholder: null, quantity: null, amount: null, detail: null };
        row.error('This item is not an OCF object: it needs an object_type and an id', 'ocf-bad-object');
        return;
      }
      this.txs.push({ obj: raw, item, type: raw.object_type.replace(/^TX_PLAN_SECURITY_/, 'TX_EQUITY_COMPENSATION_'), date: typeof raw.date === 'string' ? raw.date : null, ocfId: raw.id });
    });
  }

  // -------------------------------------------------------------------------
  // Stakeholders
  // -------------------------------------------------------------------------

  private readStakeholders(): void {
    const seen = new Set<string>();
    const emails = new Map<string, Row>();
    this.items('OCF_STAKEHOLDERS_FILE').forEach((raw, i) => {
      const obj = isObj(raw) ? raw : {};
      const ocfId = str(obj.id) ?? `#${i + 1}`;
      const legal = isObj(obj.name) ? str(obj.name.legal_name) : null;
      const note = readNote(obj, 'STAKEHOLDER');
      const name = (note.name ?? legal ?? '').slice(0, 300);
      const row = this.add(new Row('stakeholders', i + 1, ocfId, name));
      if (obj.object_type !== 'STAKEHOLDER') { row.error('This item is not a stakeholder', 'ocf-bad-object', 'object_type', obj.object_type); return; }
      if (!str(obj.id)) row.error('The stakeholder has no id', 'ocf-bad-object', 'id');
      else if (seen.has(ocfId)) row.error(`Another stakeholder of the package has the id ${ocfId}`, 'ocf-duplicate-id', 'id', ocfId);
      seen.add(ocfId);
      if (!legal) row.error('The stakeholder has no legal name', 'ocf-bad-object', 'name.legal_name');
      const ocfType = obj.stakeholder_type;
      if (ocfType !== 'INDIVIDUAL' && ocfType !== 'INSTITUTION') row.error('stakeholder_type is not INDIVIDUAL or INSTITUTION', 'ocf-bad-object', 'stakeholder_type', ocfType);
      const type = note.type ?? (ocfType === 'INSTITUTION' ? 'ENTITY' : 'INDIVIDUAL');
      const rel = typeof obj.current_relationship === 'string' && Object.hasOwn(C.RELATION_FROM_OCF, obj.current_relationship)
        ? C.RELATION_FROM_OCF[obj.current_relationship as keyof typeof C.RELATION_FROM_OCF] : null;
      if (typeof obj.current_relationship === 'string' && !rel) row.info(`Relationship ${obj.current_relationship} is not one Kosmitor knows; it is left to you`, 'relationship-guessed', 'current_relationship', obj.current_relationship);
      const contact = isObj(obj.contact_info) ? obj.contact_info : {};
      const primary = isObj(obj.primary_contact) ? obj.primary_contact : {};
      // One plain address each, as the stakeholder form takes them: anything else is left out, with a word.
      const refused: string[] = [];
      const deliverable = (e: string | null | undefined): string | null => {
        if (!e) return null;
        const v = e.trim().toLowerCase().slice(0, 320);
        if (SINGLE_ADDRESS.test(v)) return v;
        refused.push(e.slice(0, 80));
        return null;
      };
      const emailsOf = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((e) => (isObj(e) ? deliverable(str(e.email_address)) : null)).filter((e): e is string => !!e);
      const own = emailsOf(contact.emails);
      const email = own[0] ?? emailsOf(primary.emails)[0] ?? deliverable(note.email) ?? null;
      const phones = (Array.isArray(contact.phone_numbers) ? contact.phone_numbers : []).map((p) => (isObj(p) ? cut(p.phone_number, 100) : null)).filter((p): p is string => !!p);
      const addresses = (Array.isArray(obj.addresses) ? obj.addresses : []).filter(isObj);
      const addr = addresses.find((a) => a.address_type === 'CONTACT') ?? addresses.find((a) => a.address_type === 'LEGAL') ?? addresses[0] ?? null;
      const startDate = note.startDate ?? null, terminationDate = note.terminationDate ?? null;
      const fields = {
        email, type, title: note.title?.slice(0, 200) ?? null, startDate, terminationDate, taxCountry: note.taxCountry?.slice(0, 60) ?? null, taxState: note.taxState?.slice(0, 60) ?? null,
        address: addr ? cut(addr.street_suite, 500) : note.address?.slice(0, 500) ?? null, phone: phones[0] ?? note.phone?.slice(0, 100) ?? null, department: note.department?.slice(0, 200) ?? null,
      };
      const extra = {
        legalName: legal && legal !== name ? legal.slice(0, 300) : null, secondaryEmail: own[1] ?? deliverable(note.secondaryEmail) ?? null, employeeId: cut(obj.issuer_assigned_id, 100),
        city: addr ? cut(addr.city, 200) : null, region: (addr ? cut(addr.country_subdivision, 100) : null) ?? note.region?.slice(0, 100) ?? null, postalCode: addr ? cut(addr.postal_code, 40) : null,
        country: addr ? cut(addr.country, 60) : null,
        signatoryName: ocfType === 'INSTITUTION' ? (isObj(primary.name) ? cut(primary.name.legal_name, 300) : null) ?? note.signatory?.slice(0, 300) ?? null : null,
        signatoryEmail: ocfType === 'INSTITUTION' ? emailsOf(primary.emails)[0] ?? deliverable(note.signatoryEmail) ?? null : null,
      };
      if (refused.length) row.warn(`${refused.length === 1 ? `"${refused[0]}" is not` : `${refused.map((e) => `"${e}"`).join(', ')} are not`} one plain email address, so ${refused.length === 1 ? 'it is' : 'they are'} left out`, 'ocf-bad-object', 'contact_info.emails');
      row.summary = { stakeholder: name || null, email, type, relation: note.relation ?? rel, startDate };
      if (row.ownError) return;
      if (email) {
        const earlier = emails.get(email);
        if (earlier) row.warn(`Has the same email as ${earlier.named}; both are imported as they are`, 'duplicate-in-file', 'email', email);
        else emails.set(email, row);
      }

      // Who this is: the person's answer, this company's own row (rule 1), else by email and name.
      const answer = this.run.ocfPeople?.get(ocfId);
      let match: Known | null = null;
      let sameName: { name: string; email: string | null; stakeholderId: string }[] = [];
      if (answer && answer !== 'new') match = this.s.stakeholders.get(answer) ?? null;
      else if (!answer && this.sameCompany && this.s.stakeholders.has(ocfId)) match = this.s.stakeholders.get(ocfId)!;
      else if (!answer) {
        const found = findPerson(this.s.company, emptyPlan(), name, email);
        // People this name cannot tell apart: the one an earlier import of this package's securities gave them to, when there is one.
        const earlier = found.ambiguous ? this.earlierHolder(ocfId, found.ambiguous.map((p) => p.stakeholderId)) : null;
        if (earlier) { found.existing = this.s.stakeholders.get(earlier) ?? undefined; found.ambiguous = undefined; }
        if (found.ambiguous) {
          const people = found.ambiguous.map((p) => ({ id: p.stakeholderId, name: p.name, email: p.email }));
          const emailsList = people.map((p) => p.email).filter((e): e is string => !!e).sort();
          row.messages.push({ level: 'error', code: 'ambiguous-person', field: 'email', choices: emailsList, people,
            text: `${people.length === 2 ? 'Two' : count(people.length)} people on the cap table are called "${name}" — choose which one this is, or someone new` });
          return;
        }
        match = found.existing ?? null;
        sameName = found.sameName;
      }

      const relation = note.relation ?? rel;
      if (match) {
        // Someone on file: what the package says differently is an update; the rest is up to date.
        const updates: Obj = {};
        const changes: string[] = [];
        const given: Obj = { ...fields, relation };
        for (const f of PERSON_FIELDS) {
          const v = given[f];
          if (v == null || f === 'notes') continue;
          const before = match.fields[f] ?? null;
          if (before != null && nameKey(String(before)) === nameKey(String(v))) continue;
          if (f === 'email' && match.email) continue;
          updates[f] = v;
          changes.push(`${FIELD_WORDS[f]} ${shown(f, before)} → ${shown(f, v)}`);
        }
        const seated = relation === 'BOARD_MEMBER' && match.relation !== 'BOARD_MEMBER' && !match.seated && note.boardSeat !== false;
        if (seated) Object.assign(updates, boardSeatOf('BOARD_MEMBER', note.boardSeatStart ?? startDate ?? match.startDate ?? null, note.boardSeatEnd ?? terminationDate ?? null));
        const left = (updates.terminationDate ?? match.fields.terminationDate ?? null) as string | null;
        this.people.set(ocfId, { id: match.id, name: match.name, email: match.email, created: false, row, terminationDate: left });
        if (changes.length || seated) {
          row.base = 'update';
          row.info(`Updates "${match.name}": ${changes.join(', ')}${seated ? `${changes.length ? ' and gives' : 'gives'} them a board seat` : ''}`, 'stakeholder-updated');
          this.stakeholderUpdates.set(row, { id: match.id, updates });
        } else {
          row.base = 'existing';
          row.messages.push({ level: 'info', text: 'Already up to date', code: 'up-to-date' });
        }
        if (note.boardDesignatedBy) this.designations.push({ row, ocfBy: note.boardDesignatedBy });
        return;
      }

      const answered = (this.run.relationships && Object.hasOwn(this.run.relationships, personKey(name, email)) ? this.run.relationships[personKey(name, email)] : null);
      const chosen = relation ?? answered;
      const finalRelation = chosen ?? defaultRelation(name, ocfType === 'INSTITUTION' ? 'PREFERRED' : null);
      const seat = note.boardSeat === true
        ? { boardSeat: 1, boardSeatStart: note.boardSeatStart ?? null, boardSeatEnd: note.boardSeatEnd ?? null }
        : note.boardSeat === false ? { boardSeat: 0 } : boardSeatOf(finalRelation, startDate, terminationDate);
      const kid = id('stk');
      this.stakeholderRecords.set(row, {
        id: kid, companyId: this.companyId, name, ...fields, relation: finalRelation, entityGroupId: null,
        notes: plainComments(obj).join('\n').slice(0, 4000) || null, ...extra, ...seat, createdAt: this.stamp(i),
      });
      if (note.boardDesignatedBy) this.designations.push({ row, ocfBy: note.boardDesignatedBy });
      this.people.set(ocfId, { id: kid, name, email, created: true, row, terminationDate });
      if (sameName.length) {
        row.warn(sameName.length === 1
          ? `Another "${name}" on the cap table has a different email (${sameName[0].email ?? 'none'}) — both are kept`
          : `${sameName.length} others called "${name}" on the cap table have different emails (${sameName.map((o) => o.email ?? 'none').join(', ')}) — all are kept`, 'same-name', 'email', email);
      }
      row.info(`Creates stakeholder "${name}" as ${finalRelation.toLowerCase().replace('_', ' ')}${chosen ? '' : ' — review the relationship'}`,
        chosen ? 'stakeholder-created' : 'relationship-guessed', 'current_relationship');
      this.newPeople.push({
        key: personKey(name, email), name, email, type, relation: finalRelation, guessed: !chosen,
        sameName: sameName.map((o) => ({ name: o.name, email: o.email, onRecord: true, stakeholderId: o.stakeholderId })),
        rows: [{ file: this.run.file, sheet: SECTION_TITLES.stakeholders, row: i + 1 }], ocfId,
      });
    });
  }

  /**
   * Of people on the cap table one name cannot tell apart, the one an earlier import
   * gave this package person's securities to (its creation entries' memos name the
   * package's security ids), when they all went to one of them.
   */
  private earlierHolder(ocfId: string, candidates: string[]): string | null {
    const holders = new Set<string>();
    for (const t of this.txs) {
      if (!lookup(ISSUANCE_KIND, t.type) || t.obj.stakeholder_id !== ocfId || typeof t.obj.security_id !== 'string') continue;
      const h = this.s.ocfHolders.get(ref(t.obj.security_id));
      if (h) holders.add(h);
    }
    const [only] = holders;
    return holders.size === 1 && candidates.includes(only) ? only : null;
  }

  // -------------------------------------------------------------------------
  // Share classes and legends
  // -------------------------------------------------------------------------

  private readClasses(): void {
    const legends = new Map<string, string>();
    let legendCount = 0;
    for (const raw of this.items('OCF_STOCK_LEGEND_TEMPLATES_FILE')) {
      if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue;
      legendCount++;
      legends.set(raw.id, raw.text.slice(0, 20_000));
    }
    const usedLegends = new Set<string>();
    const seen = new Set<string>();
    const names = new Set<string>();
    const stockIssues = this.txs.filter((t) => t.type === 'TX_STOCK_ISSUANCE');
    const adjustments = this.txs.filter((t) => t.type === 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT' || t.type === 'TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT');
    const rows = new Map<string, Row>();
    this.items('OCF_STOCK_CLASSES_FILE').forEach((raw, i) => {
      const obj = isObj(raw) ? raw : {};
      const ocfId = str(obj.id) ?? `#${i + 1}`;
      const name = (str(obj.name) ?? '').slice(0, 200);
      const row = this.add(new Row('shareClasses', i + 1, ocfId, name));
      if (obj.object_type !== 'STOCK_CLASS') { row.error('This item is not a share class', 'ocf-bad-object', 'object_type', obj.object_type); return; }
      if (!str(obj.id)) row.error('The share class has no id', 'ocf-bad-object', 'id');
      else if (seen.has(ocfId)) row.error(`Another share class of the package has the id ${ocfId}`, 'ocf-duplicate-id', 'id', ocfId);
      seen.add(ocfId);
      rows.set(ocfId, row);
      if (!name) row.error('The share class has no name', 'ocf-bad-object', 'name');
      else if (names.has(nameKey(name))) row.error(`Another share class of the package is called "${name}"`, 'ocf-duplicate-id', 'name', name);
      names.add(nameKey(name));
      const kind = obj.class_type === 'PREFERRED' ? 'PREFERRED' : obj.class_type === 'COMMON' ? 'COMMON' : null;
      if (!kind) row.error('class_type is not COMMON or PREFERRED', 'ocf-bad-object', 'class_type', obj.class_type);
      const note = readNote(obj, 'STOCK_CLASS');
      // Authorized shares: the class's own, or the latest adjustment up to today.
      const auth = obj.initial_shares_authorized;
      let authorized = auth === 'UNLIMITED' || auth === 'NOT APPLICABLE' ? 0 : this.shares(row, auth, 'initial_shares_authorized') ?? 0;
      let ratio: number | null = null;
      const rights = (Array.isArray(obj.conversion_rights) ? obj.conversion_rights : []).filter(isObj);
      for (const r of rights) {
        const mech = isObj(r.conversion_mechanism) ? r.conversion_mechanism : null;
        if (mech?.type === 'RATIO_CONVERSION' && ratio == null) {
          const read = C.readRatio(mech.ratio, 'conversion_rights.conversion_mechanism.ratio');
          if (read.ok && read.value <= 1e6) ratio = read.value; else if (read.ok) row.error('The conversion ratio is not one Kosmitor can record', 'ocf-bad-object', 'conversion_rights'); else row.issue(read.issue);
        }
      }
      for (const a of adjustments.filter((t) => t.obj.stock_class_id === ocfId).sort((x, y) => cmp(x.date ?? '', y.date ?? '') || x.item - y.item)) {
        if (!a.date || a.date > this.today) continue;
        if (a.type === 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT') {
          const v = a.obj.new_shares_authorized;
          if (v === 'UNLIMITED' || v === 'NOT APPLICABLE') authorized = 0;
          else { const r = C.readShares(v, 'new_shares_authorized'); if (r.ok) authorized = r.value; }
        } else {
          const mech = isObj(a.obj.new_ratio_conversion_mechanism) ? a.obj.new_ratio_conversion_mechanism : null;
          const r = C.readRatio(mech?.ratio, 'new_ratio_conversion_mechanism.ratio');
          if (r.ok && r.value <= 1e6) ratio = r.value;
        }
      }
      const votes = obj.votes_per_share == null ? 1 : this.shares(row, obj.votes_per_share, 'votes_per_share') ?? 1;
      const seniority = obj.seniority == null ? 0 : Math.round(this.shares(row, obj.seniority, 'seniority') ?? 0);
      const par = this.money(row, obj.par_value, 'par_value', 'micros');
      const price = this.money(row, obj.price_per_share, 'price_per_share', 'micros');
      const multiple = obj.liquidation_preference_multiple == null ? 1 : this.shares(row, obj.liquidation_preference_multiple, 'liquidation_preference_multiple') ?? 1;
      const cap = obj.participation_cap_multiple == null ? null : this.shares(row, obj.participation_cap_multiple, 'participation_cap_multiple');
      const own = stockIssues.filter((t) => t.obj.stock_class_id === ocfId);
      const issueDate = note.issueDate ?? own.map((t) => t.date).filter((d): d is string => !!d && C.isCalendarDate(d)).sort()[0]
        ?? (this.pkg.asOf && C.isCalendarDate(this.pkg.asOf) ? this.pkg.asOf : this.today);
      // A legend every certificate of the class carries is the class's legend.
      const legendIds = new Set(own.map((t) => (Array.isArray(t.obj.stock_legend_ids) ? t.obj.stock_legend_ids.filter((x) => typeof x === 'string').join('|') : '')));
      const onlyLegend = legendIds.size === 1 ? [...legendIds][0] : '';
      const legend = onlyLegend && !onlyLegend.includes('|') && legends.has(onlyLegend) ? legends.get(onlyLegend)! : null;
      if (legend) usedLegends.add(onlyLegend);
      row.summary = { name: name || null, classType: kind, authorized, price: price != null ? price / 1e6 : null, seniority, votes };
      if (row.ownError || !kind) return;
      const record: Obj = {
        id: id('sc'), companyId: this.companyId, name, kind, authorized, parValue: par ?? 0, seniority,
        originalIssuePrice: price ?? par ?? 0, liquidationMultiple: kind === 'PREFERRED' ? multiple : 1,
        participation: note.participation ?? (cap != null ? 'CAPPED_PARTICIPATING' : 'NON_PARTICIPATING'), participationCap: note.participationCap ?? cap,
        conversionRatio: ratio ?? 1, dividendType: note.dividendType ?? 'NONE', dividendRate: note.dividendRate ?? 0,
        dividendCompounding: note.dividendCompounding ? 1 : 0, dividendsParticipate: note.dividendsParticipateInResidual ? 1 : 0, votesPerShare: votes,
        antiDilution: note.antiDilution ?? 'NONE', payToPlay: note.payToPlay ? 1 : 0, issueDate,
        isConvertible: (note.isConvertible ?? rights.length > 0) ? 1 : 0, sortOrder: 0, legend,
      };
      // Who this is: this company's own class (rule 1), else the class of that name.
      const onFile = (this.sameCompany ? this.s.classes.find((c) => c.id === ocfId) : undefined)
        ?? this.s.classes.find((c) => nameKey(String(c.name)) === nameKey(name));
      if (onFile) {
        const differs: string[] = [];
        const was = (label: string, a: unknown, b: unknown, fmt: (v: unknown) => string = String) => {
          if (a != null && b != null && String(a) !== String(b) && !(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9)) differs.push(`${label} is ${fmt(a)} on the cap table and ${fmt(b)} in the package`);
        };
        was('the type', String(onFile.kind).toLowerCase(), kind.toLowerCase());
        was('the original issue price', Number(onFile.original_issue_price), record.originalIssuePrice, (v) => perShare(Number(v)));
        was('the par value', Number(onFile.par_value), record.parValue, (v) => perShare(Number(v)));
        was('votes per share', Number(onFile.votes_per_share), votes);
        was('the seniority', Number(onFile.seniority), seniority);
        if (kind === 'PREFERRED') was('the liquidation multiple', Number(onFile.liquidation_multiple), record.liquidationMultiple);
        const used = this.s.hasSecurities || this.s.pools.some((p) => p.share_class_id === onFile.id);
        this.classes.set(ocfId, { id: String(onFile.id), name: String(onFile.name), kind: String(onFile.kind), row, created: false, record: null, issueDate: String(onFile.issue_date) });
        const authorizedDiffers = Math.abs(Number(onFile.authorized) - authorized) > 1e-6;
        if (!used && (differs.length || authorizedDiffers || String(onFile.issue_date) !== issueDate)) {
          // A class nothing is issued from yet, in a company with an empty cap table (the Common
          // every new company starts with): it takes the package's terms.
          const { id: _id, companyId: _c, name: _n, ...terms } = record;
          void _id; void _c; void _n;
          this.classUpdates.set(row, { id: String(onFile.id), updates: terms });
          this.classes.get(ocfId)!.issueDate = issueDate;
          row.base = 'update';
          row.info(`Takes the package's terms for "${onFile.name}" (nothing is issued from it yet)${authorizedDiffers ? `: ${count(authorized)} authorized` : ''}`, 'class-updated');
          return;
        }
        row.base = 'existing';
        row.messages.push({ level: 'info', text: 'Already on the cap table', code: 'already-imported' });
        for (const d of differs) row.notes.push({ level: 'warning', code: 'differs-from-record', text: `${d.charAt(0).toUpperCase()}${d.slice(1)} — the import leaves the class as it is` });
        return;
      }
      this.classRecords.set(row, record);
      this.classes.set(ocfId, { id: String(record.id), name, kind, row, created: true, record, issueDate });
      row.info(`Creates ${kind.toLowerCase()} share class "${name}"`, 'class-created', 'name');
    });
    // Class adjustments: History rows, applied as the class's latest value.
    for (const a of adjustments) {
      const row = this.eventRow(a);
      const cls = typeof a.obj.stock_class_id === 'string' ? this.classes.get(a.obj.stock_class_id) : undefined;
      const classRow = typeof a.obj.stock_class_id === 'string' ? rows.get(a.obj.stock_class_id) : undefined;
      row.summary.detail = a.type === 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT' ? `authorized to ${String(a.obj.new_shares_authorized ?? '?')}` : 'conversion ratio changed';
      this.ref(row, 'shareClasses', this.classes, a.obj.stock_class_id, 'stock_class_id', 'a share class');
      if (!classRow) continue;
      row.summary.security = cls?.name ?? null;
      if (classRow.base === 'existing' || !cls?.created) { row.base = 'skip'; row.info('The class is already on the cap table, so its history is not applied', 'ocf-history-current-only'); continue; }
      row.base = 'skip';
      row.info(a.date && a.date > this.today ? 'Dated after today, so not applied' : 'Kosmitor keeps only the latest value: it is the class\'s', 'ocf-history-current-only');
    }
    const unused = [...legends.keys()].filter((l) => !usedLegends.has(l)).length;
    const used = legendCount - unused;
    if (legendCount) {
      this.notices.push({ code: 'ocf-legends', level: 'info', text: unused === 0
        ? `${plural(legendCount, 'legend template')}, each on every certificate of its class: ${legendCount === 1 ? 'it becomes the class\'s legend' : 'each becomes its class\'s legend'}.`
        : used === 0
          ? `${plural(legendCount, 'legend template')} not imported: Kosmitor keeps one legend per class, and no class has one legend on every certificate.`
          : `${plural(legendCount, 'legend template')}: ${count(used)} on every certificate of a class ${used === 1 ? 'becomes its' : 'become their class\'s'} legend; ${count(unused)} ${unused === 1 ? 'is' : 'are'} not imported.` });
      if (unused) this.skipped('Legend templates', 'not on every certificate of one class', unused);
    }
  }

  /** The first common class, of the package or on file. */
  private commonClass(): { id: string; name: string; row: Row | null } | null {
    const pkg = [...this.classes.values()].find((c) => c.kind === 'COMMON');
    if (pkg) return { id: pkg.id, name: pkg.name, row: pkg.row };
    const onFile = this.s.classes.find((c) => c.kind === 'COMMON');
    return onFile ? { id: String(onFile.id), name: String(onFile.name), row: null } : null;
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  private readPlans(): void {
    const seen = new Set<string>();
    this.items('OCF_STOCK_PLANS_FILE').forEach((raw, i) => {
      const obj = isObj(raw) ? raw : {};
      const ocfId = str(obj.id) ?? `#${i + 1}`;
      const name = (str(obj.plan_name) ?? '').slice(0, 200);
      const row = this.add(new Row('plans', i + 1, ocfId, name));
      if (obj.object_type !== 'STOCK_PLAN') { row.error('This item is not an equity plan', 'ocf-bad-object', 'object_type', obj.object_type); return; }
      if (!str(obj.id)) row.error('The plan has no id', 'ocf-bad-object', 'id');
      else if (seen.has(ocfId)) row.error(`Another plan of the package has the id ${ocfId}`, 'ocf-duplicate-id', 'id', ocfId);
      seen.add(ocfId);
      if (!name) row.error('The plan has no name', 'ocf-bad-object', 'plan_name');
      const reserved = this.shares(row, obj.initial_shares_reserved, 'initial_shares_reserved') ?? 0;
      const board = obj.board_approval_date == null ? null : this.date(row, obj.board_approval_date, 'board_approval_date');
      const holders = obj.stockholder_approval_date == null ? null : this.date(row, obj.stockholder_approval_date, 'stockholder_approval_date');
      const classOcf = (Array.isArray(obj.stock_class_ids) ? obj.stock_class_ids.find((x) => typeof x === 'string') : undefined) ?? str(obj.stock_class_id);
      let classId: string | null = null, className: string | null = null;
      if (classOcf) {
        const cls = this.ref(row, 'shareClasses', this.classes, classOcf, 'stock_class_ids', 'a share class');
        if (cls) { classId = cls.id; className = cls.name; }
      } else {
        const common = this.commonClass();
        if (!common) row.error('The plan names no share class, and there is no common class for it to draw on', 'no-common-class', 'stock_class_ids');
        else { classId = common.id; className = common.name; if (common.row) row.deps.add(common.row); }
      }
      const note = readNote(obj, 'STOCK_PLAN');
      row.summary = { name: name || null, shareClass: className, reserved, boardApprovalDate: board };
      if (row.ownError || !classId) return;
      const onFile = (this.sameCompany ? this.s.pools.find((p) => p.id === ocfId) : undefined) ?? this.s.pools.find((p) => nameKey(String(p.name)) === nameKey(name));
      if (onFile) {
        this.plans.set(ocfId, { id: String(onFile.id), name: String(onFile.name), classId: String(onFile.share_class_id), row, created: false, record: null, reserved: Number(onFile.authorized),
          approval: (onFile.board_approval_date as string) ?? (onFile.shareholder_approval_date as string) ?? null });
        row.base = 'existing';
        row.messages.push({ level: 'info', text: 'Already on the cap table', code: 'already-imported' });
        if (Math.abs(Number(onFile.authorized) - reserved) > 1e-6) {
          row.notes.push({ level: 'warning', code: 'differs-from-record', field: 'initial_shares_reserved', text: `Reserves ${count(Number(onFile.authorized))} shares on the cap table and ${count(reserved)} in the package — the import leaves the plan as it is` });
        }
        return;
      }
      const behaviour = obj.default_cancellation_behavior;
      const record: Obj = {
        id: id('pol'), companyId: this.companyId, name, shareClassId: classId, authorized: reserved, boardApprovalDate: board, shareholderApprovalDate: holders,
        returnForfeitures: behaviour === 'RETIRE' || behaviour === 'HOLD_AS_CAPITAL_STOCK' ? 0 : 1, evergreenPercent: note.evergreenPercent ?? null,
        planType: note.planType ?? 'STOCK_PLAN', createdAt: this.stamp(i),
      };
      this.poolRecords.set(row, record);
      this.plans.set(ocfId, { id: String(record.id), name, classId, row, created: true, record, reserved, approval: board ?? holders });
      row.info(`Creates equity plan "${name}" with ${count(reserved)} shares reserved`, 'plan-created', 'plan_name');
    });
  }

  // -------------------------------------------------------------------------
  // Vesting terms
  // -------------------------------------------------------------------------

  private readTerms(): void {
    const seen = new Set<string>();
    this.items('OCF_VESTING_TERMS_FILE').forEach((raw, i) => {
      const obj = isObj(raw) ? raw : {};
      const ocfId = str(obj.id) ?? `#${i + 1}`;
      const name = (str(obj.name) ?? '').slice(0, 200);
      const row = this.add(new Row('vesting', i + 1, ocfId, name));
      if (obj.object_type !== 'VESTING_TERMS') { row.error('This item is not vesting terms', 'ocf-bad-object', 'object_type', obj.object_type); return; }
      if (!str(obj.id)) row.error('The vesting terms have no id', 'ocf-bad-object', 'id');
      else if (seen.has(ocfId)) row.error(`Other vesting terms of the package have the id ${ocfId}`, 'ocf-duplicate-id', 'id', ocfId);
      seen.add(ocfId);
      if (!name) row.error('The vesting terms have no name', 'ocf-bad-object', 'name');
      if (!Array.isArray(obj.vesting_conditions)) row.error('The vesting terms have no conditions', 'ocf-bad-object', 'vesting_conditions');
      if (row.ownError) { row.summary = { name: name || null, reading: null }; return; }
      const reading = scheduleFromTerms(obj as never);
      this.terms.set(ocfId, { obj, row, reading, name });
      if (obj.allocation_type !== 'CUMULATIVE_ROUND_DOWN') {
        row.info(`Shares are allocated ${String(obj.allocation_type ?? 'as not stated').toLowerCase().replace(/_/g, ' ')} in the package; Kosmitor rounds each date's shares down (cumulative round down), which can move a share between dates`, 'ocf-vesting-rounding', 'allocation_type', obj.allocation_type);
      }
      if (reading.kind === 'unsupported') {
        row.summary = { name, reading: null };
        row.error(`${reading.text} Kosmitor cannot follow these terms`, 'ocf-unsupported', 'vesting_conditions');
        return;
      }
      if (reading.kind === 'per-security') {
        row.summary = { name, reading: 'Read for each security' };
        row.base = 'skip';
        row.info('No Kosmitor schedule has this shape: each security on these terms gets its own dated schedule of what they vest for it', 'ocf-vesting-per-security');
        return;
      }
      row.summary = { name, reading: describeSchedule(reading.schedule) };
      // The schedule itself is settled once its securities are known (a milestone schedule's dates come from them).
    });
  }

  /** A schedule's fields as stored, to tell two schedules apart. */
  private scheduleFields(s: Obj | NotedSchedule): string {
    const o = s as Obj;
    const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
    const n = (v: unknown) => (v == null ? null : Number(v));
    return JSON.stringify([o.kind, n(o.durationMonths ?? o.duration_months), n(o.cliffMonths ?? o.cliff_months), o.frequency, n(o.immediatePortion ?? o.immediate_portion),
      json(o.yearWeights ?? o.year_weights ?? null), json(o.milestones ?? null), json(o.customTranches ?? o.custom_tranches ?? null),
      n(o.accelerationSingleTrigger ?? o.acceleration_single ?? 0), n(o.accelerationDoubleTrigger ?? o.acceleration_double ?? 0), n(o.accelerationMonths ?? o.acceleration_months ?? null)]);
  }

  /** A shared schedule by key: an existing one with the same fields, or a new one. Returns its id. */
  private schedule(key: string, name: string, s: NotedSchedule, row: Row | null, termsOcfId: string | null): string {
    const have = this.schedules.get(key);
    if (have) return have.existingId ?? String(have.record!.id);
    if (!this.onFileSchedules) {
      this.onFileSchedules = { byFields: new Map(), byName: new Map(), names: new Set() };
      for (const v of this.s.schedules) {
        const f = this.scheduleFields(v);
        if (!this.onFileSchedules.byFields.has(f)) this.onFileSchedules.byFields.set(f, v);
        if (!this.onFileSchedules.byName.has(nameKey(String(v.name)))) this.onFileSchedules.byName.set(nameKey(String(v.name)), v);
        this.onFileSchedules.names.add(nameKey(String(v.name)));
      }
    }
    const index = this.onFileSchedules;
    const fields = this.scheduleFields(s);
    const byId = this.sameCompany && termsOcfId ? this.s.schedules.find((v) => v.id === termsOcfId && this.scheduleFields(v) === fields) : undefined;
    const sameName = index.byName.get(nameKey(name));
    const reuse = byId ?? (sameName && this.scheduleFields(sameName) === fields ? sameName : undefined) ?? index.byFields.get(fields);
    if (reuse) {
      this.schedules.set(key, { record: null, existingId: String(reuse.id), name: String(reuse.name), row });
      return String(reuse.id);
    }
    const taken = (n: string) => index.names.has(nameKey(n));
    let finalName = name.slice(0, 200);
    if (taken(finalName)) {
      finalName = `${name.slice(0, 190)} (OCF)`;
      for (let n = 2; taken(finalName); n++) finalName = `${name.slice(0, 185)} (OCF ${n})`;
      if (row && sameName) row.info(`"${name}" on the cap table vests differently, so this one is added as "${finalName}"`, 'schedule-created');
    }
    index.names.add(nameKey(finalName));
    const record: Obj = {
      id: id('vs'), companyId: this.companyId, name: finalName, kind: s.kind, durationMonths: s.durationMonths, cliffMonths: s.cliffMonths, frequency: s.frequency,
      immediatePortion: s.immediatePortion, yearWeights: s.yearWeights ?? null, milestones: s.milestones ?? null, customTranches: s.customTranches ?? null,
      accelerationSingle: s.accelerationSingleTrigger ?? 0, accelerationDouble: s.accelerationDoubleTrigger ?? 0, accelerationMonths: s.accelerationMonths ?? null,
      createdAt: this.stamp(this.schedules.size),
    };
    this.schedules.set(key, { record, existingId: null, name: finalName, row });
    return String(record.id);
  }
  private onFileSchedules: { byFields: Map<string, Obj>; byName: Map<string, Obj>; names: Set<string> } | null = null;

  // -------------------------------------------------------------------------
  // Valuations
  // -------------------------------------------------------------------------

  private readValuations(): void {
    const seen = new Set<string>();
    const read: { row: Row; record: Obj; date: string; noted: boolean }[] = [];
    this.items('OCF_VALUATIONS_FILE').forEach((raw, i) => {
      const obj = isObj(raw) ? raw : {};
      const ocfId = str(obj.id) ?? `#${i + 1}`;
      const row = this.add(new Row('valuations', i + 1, ocfId, String(obj.effective_date ?? '')));
      if (obj.object_type !== 'VALUATION') { row.error('This item is not a valuation', 'ocf-bad-object', 'object_type', obj.object_type); return; }
      if (!str(obj.id)) row.error('The valuation has no id', 'ocf-bad-object', 'id');
      else if (seen.has(ocfId)) row.error(`Another valuation of the package has the id ${ocfId}`, 'ocf-duplicate-id', 'id', ocfId);
      seen.add(ocfId);
      const price = this.money(row, obj.price_per_share, 'price_per_share', 'micros');
      if (obj.price_per_share == null) row.error('price_per_share is missing', 'required', 'price_per_share');
      const date = this.date(row, obj.effective_date, 'effective_date');
      const cls = this.ref(row, 'shareClasses', this.classes, obj.stock_class_id, 'stock_class_id', 'a share class');
      if (cls?.kind === 'PREFERRED') row.info(`Priced in ${cls.name}; Kosmitor reads every valuation as the common price`, 'ocf-history-current-only', 'stock_class_id');
      const note = readNote(obj, 'VALUATION');
      row.summary = { effectiveDate: date, price: price != null ? price / 1e6 : null, provider: str(obj.provider), shareClass: cls?.name ?? null };
      if (row.ownError || price == null || !date) return;
      this.valuations.push({ date, price });
      const onFile = (this.sameCompany ? this.s.valuations.find((v) => v.id === ocfId) : undefined)
        ?? this.s.valuations.find((v) => v.effective_date === date && Number(v.fair_market_value) === price);
      if (onFile) {
        row.base = 'existing';
        row.messages.push({ level: 'info', text: 'Already on the cap table', code: 'already-imported' });
        return;
      }
      read.push({ row, date, noted: !!note.status, record: {
        id: id('val'), companyId: this.companyId, type: note.type ?? '409A', fairMarketValue: price, effectiveDate: date, expirationDate: note.expirationDate ?? null,
        provider: str(obj.provider)?.slice(0, 200) ?? null, reportUrl: note.reportUrl ?? null, status: note.status ?? 'SUPERSEDED',
        enterpriseValue: note.enterpriseValue ?? null, method: note.method ?? null, notes: plainComments(obj).join('\n').slice(0, 4000) || null, createdAt: this.stamp(i),
      } });
    });
    // With no status in the package, the latest is the active one.
    const latest = [...read].sort((a, b) => cmp(b.date, a.date))[0];
    if (latest && !latest.noted && !this.s.valuations.some((v) => String(v.effective_date) > latest.date)) latest.record.status = 'ACTIVE';
    for (const r of read) this.valuationRecords.set(r.row, r.record);
  }

  // -------------------------------------------------------------------------
  // Splits and plan adjustments
  // -------------------------------------------------------------------------

  /** A History row for a transaction. */
  private eventRow(t: Tx): Row {
    const row = this.add(new Row('events', t.item, t.ocfId, ''));
    row.object = String(t.obj.object_type);
    row.summary = { date: t.date, event: t.obj.object_type as string, security: null, stakeholder: null, quantity: null, amount: null, detail: null };
    if (t.date != null && !C.isCalendarDate(t.date)) row.error(`date ${t.date} is not a date (YYYY-MM-DD)`, 'bad-date', 'date', t.date);
    else if (t.date == null) row.error('date is missing', 'required', 'date');
    else if (t.date > this.today) row.warn(`Dated ${t.date}, after today`, 'ocf-future-date', 'date', t.date);
    return row;
  }

  private readSplitsAndAdjustments(): void {
    for (const s of this.s.splits) this.splitDates.push({ date: String(s.date), ratio: Number(s.ratio) });
    // Splits: one Kosmitor split for the classes split together on a date.
    const groups = new Map<string, { date: string; ratio: number; rows: Row[]; classes: Set<string>; txs: Tx[] }>();
    for (const t of this.txs.filter((x) => x.type === 'TX_STOCK_CLASS_SPLIT')) {
      const row = this.eventRow(t);
      const cls = this.ref(row, 'shareClasses', this.classes, t.obj.stock_class_id, 'stock_class_id', 'a share class');
      const ratio = C.readRatio(t.obj.split_ratio, 'split_ratio');
      if (!ratio.ok) row.issue(ratio.issue);
      else if (ratio.value < 1e-6 || ratio.value > 1e6) row.error('split_ratio is not a split Kosmitor can record', 'ocf-bad-object', 'split_ratio', t.obj.split_ratio);
      row.summary.security = cls?.name ?? null;
      row.summary.detail = ratio.ok ? `${C.ocfNumeric(ratio.value)}:1 split` : 'split';
      if (row.ownError || !ratio.ok || !t.date || !cls) continue;
      const k = `${t.date}|${ratio.value}`;
      const g = groups.get(k) ?? { date: t.date, ratio: ratio.value, rows: [], classes: new Set<string>(), txs: [] };
      g.rows.push(row);
      g.txs.push(t);
      g.classes.add(String(t.obj.stock_class_id));
      groups.set(k, g);
    }
    for (const g of [...groups.values()].sort((a, b) => cmp(a.date, b.date))) {
      // Kosmitor splits every class at once: every class with shares before the date must be in it.
      const before = new Set(this.txs.filter((t) => t.type === 'TX_STOCK_ISSUANCE' && t.date && t.date < g.date && typeof t.obj.stock_class_id === 'string').map((t) => String(t.obj.stock_class_id)));
      const left = [...before].filter((c) => !g.classes.has(c));
      const onFile = this.s.splits.find((s) => (s.date === g.date && near(Number(s.ratio), g.ratio))
        || (this.sameCompany && g.txs.some((t) => t.ocfId.startsWith(`${String(s.id)}.`))));
      const [first, ...others] = g.rows;
      for (const o of others) o.info(`Part of the ${C.ocfNumeric(g.ratio)}:1 split of ${g.date} (${first.named})`, 'ocf-folded');
      this.splitRows.push({ date: g.date, ratio: g.ratio, rows: g.rows, classes: g.classes });
      if (onFile) {
        for (const r of g.rows) { r.base = 'existing'; r.messages.push({ level: 'info', text: 'Already on the cap table', code: 'already-imported' }); }
        continue;
      }
      if (left.length) {
        const names = left.map((c) => this.classes.get(c)?.name ?? c).join(', ');
        for (const r of g.rows) r.error(`Only some classes split on ${g.date} (not ${names}); Kosmitor splits every class at once`, 'ocf-unsupported', 'stock_class_id');
        continue;
      }
      if (this.s.hasSecurities) {
        for (const r of g.rows) r.error('Import a package with a stock split into a company with an empty cap table', 'ocf-split-existing');
        continue;
      }
      this.splitDates.push({ date: g.date, ratio: g.ratio });
      const splitId = id('spl');
      this.splitRecords.set(first, {
        split: { id: splitId, companyId: this.companyId, date: g.date, ratio: g.ratio, notes: null, createdAt: this.stamp(g.txs[0].item) },
        entry: {
          id: id('tx'), companyId: this.companyId, type: 'STOCK_SPLIT', date: g.date, securityId: null, memo: `${g.ratio}:1 split recorded (OCF ${ref(g.txs[0].ocfId)})`,
          beforeValue: null, afterValue: JSON.stringify({ date: g.date, ratio: g.ratio }), createdAt: this.stamp(g.txs[0].item), createdBy: this.createdBy,
        },
      });
      first.info(`Records a ${C.ocfNumeric(g.ratio)}:1 stock split on ${g.date}`, 'ocf-folded');
    }
    this.splitDates.sort((a, b) => cmp(a.date, b.date));

    // Plan adjustments: the reserve after each, as a change in the shares of its date.
    const byPlan = new Map<string, Tx[]>();
    for (const t of this.txs.filter((x) => x.type === 'TX_STOCK_PLAN_POOL_ADJUSTMENT')) {
      const k = String(t.obj.stock_plan_id ?? '');
      const list = byPlan.get(k); if (list) list.push(t); else byPlan.set(k, [t]);
    }
    for (const [planOcf, list] of byPlan) {
      const plan = this.plans.get(planOcf);
      let total = plan?.reserved ?? 0, totalDate: string | null = plan?.approval ?? null;
      for (const t of list.sort((a, b) => cmp(a.date ?? '', b.date ?? '') || a.item - b.item)) {
        const row = this.eventRow(t);
        row.summary.security = plan?.name ?? null;
        const reserved = this.shares(row, t.obj.shares_reserved, 'shares_reserved');
        row.summary.detail = reserved != null ? `plan to ${count(reserved)}` : null;
        this.ref(row, 'plans', this.plans, planOcf, 'stock_plan_id', 'a plan');
        if (!plan || row.ownError || reserved == null || !t.date) continue;
        const amount = roundShares(reserved - total * this.kOf(totalDate, t.date));
        total = reserved;
        totalDate = t.date;
        row.summary.quantity = amount;
        const onFile = this.s.poolAdjustments.find((a) => (this.sameCompany && a.id === t.ocfId)
          || (a.pool_id === plan.id && a.date === t.date && near(Number(a.amount), amount)));
        if (onFile) {
          row.base = 'existing';
          row.messages.push({ level: 'info', text: 'Already on the cap table', code: 'already-imported' });
          continue;
        }
        this.adjustmentRecords.set(row, {
          id: id('padj'), companyId: this.companyId, poolId: plan.id, date: t.date, amount,
          reason: plainComments(t.obj).join('; ').slice(0, 500) || null, createdAt: this.stamp(t.item),
        });
        row.info(`${amount >= 0 ? 'Adds' : 'Takes'} ${count(Math.abs(amount))} shares ${amount >= 0 ? 'to' : 'from'} the plan`, 'ocf-folded');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Securities: chains and families
  // -------------------------------------------------------------------------

  private buildSecurities(): void {
    // Every issuance is a security, issued once.
    for (const t of this.txs) {
      const kind = lookup(ISSUANCE_KIND, t.type);
      if (!kind) continue;
      const sid = str(t.obj.security_id);
      if (!sid) {
        const row = this.add(new Row(kind === 'stock' ? 'captable' : kind === 'grant' ? 'grants' : kind === 'warrant' ? 'warrants' : 'convertibles', t.item, t.ocfId, str(t.obj.custom_id) ?? ''));
        row.error('The issuance has no security_id', 'ocf-bad-object', 'security_id');
        continue;
      }
      if (this.secs.has(sid)) {
        const row = this.add(new Row(kind === 'stock' ? 'captable' : kind === 'grant' ? 'grants' : kind === 'warrant' ? 'warrants' : 'convertibles', t.item, t.ocfId, str(t.obj.custom_id) ?? ''));
        row.error(`Another issuance (item ${this.secs.get(sid)!.issue.item}) already issued security ${sid}`, 'ocf-duplicate-id', 'security_id', sid);
        continue;
      }
      this.secs.set(sid, { ocfId: sid, kind, issue: t, events: [], krow: null, producedBy: null, closed: false });
    }
    // Events, each about its security; everything else is a History row of its own.
    const handled = new Set(['TX_STOCK_CLASS_SPLIT', 'TX_STOCK_PLAN_POOL_ADJUSTMENT', 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT', 'TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT']);
    const orphans: Tx[] = [];
    for (const t of this.txs) {
      if (lookup(ISSUANCE_KIND, t.type) || handled.has(t.type)) continue;
      const sid = str(t.obj.security_id);
      const sec = sid ? this.secs.get(sid) : undefined;
      if (sec) sec.events.push(t); else orphans.push(t);
    }
    for (const t of orphans) {
      const row = this.eventRow(t);
      const why = lookup(NOT_IMPORTED, t.type);
      if (why) {
        row.base = 'skip';
        row.info(`Not imported: ${why}`, 'ocf-not-imported');
        this.skipped(t.type, why);
      } else if (!str(t.obj.security_id) && !/^TX_/.test(t.type)) {
        row.base = 'skip';
        row.info(`Not imported: ${t.type} is not an OCF 1.2.0 transaction`, 'ocf-not-imported');
        this.skipped(t.type, 'not a transaction of OCF 1.2.0');
      } else if (str(t.obj.security_id)) {
        row.error(`Is about a security (${ref(String(t.obj.security_id))}) the package never issues`, 'ocf-unknown-reference', 'security_id', t.obj.security_id);
      } else {
        row.base = 'skip';
        row.info(`Not imported: Kosmitor does not know ${t.type}`, 'ocf-not-imported');
        this.skipped(t.type, 'a transaction Kosmitor does not know');
      }
    }

    // What each event creates: balances and re-issues carry a row on, results start new ones.
    const problems = new Map<Tx, string>();
    for (const sec of this.secs.values()) {
      sec.events.sort((a, b) => cmp(a.date ?? '', b.date ?? '') || a.item - b.item);
      for (const t of sec.events) {
        const results = (Array.isArray(t.obj.resulting_security_ids) ? t.obj.resulting_security_ids : []).filter((x): x is string => typeof x === 'string');
        const balance = str(t.obj.balance_security_id);
        const name = (target: string, continuation: boolean) => {
          const r = this.secs.get(target);
          if (!r) { problems.set(t, `Names ${continuation ? 'a balance certificate' : 'a resulting security'} (${ref(target)}) the package never issues`); return; }
          if (r.producedBy || r === sec) { problems.set(t, `${target} is named as created by two events`); return; }
          r.producedBy = { tx: t, continuation };
        };
        if (balance) name(balance, true);
        if (t.type === 'TX_STOCK_REISSUANCE' && results.length === 1) {
          const r = this.secs.get(results[0]);
          const same = r && r.kind === 'stock' && r.issue.obj.stakeholder_id === sec.issue.obj.stakeholder_id && r.issue.obj.stock_class_id === sec.issue.obj.stock_class_id;
          name(results[0], !!(str(t.obj.split_transaction_id) || same));
        } else for (const x of results) name(x, false);
      }
    }

    // Rows: a root and its continuations; results are rows of their own in the root's family.
    const kindOf = (sec: Sec): KRow['kind'] => (sec.kind === 'stock'
      ? (readNote(sec.issue.obj, 'TX_STOCK_ISSUANCE').award && this.rsaOnly(sec) ? 'rsa' : 'certificate')
      : sec.kind);
    const sectionOf = (k: KRow['kind']): OcfSection => (k === 'certificate' ? 'captable' : k === 'rsa' || k === 'grant' ? 'grants' : k === 'warrant' ? 'warrants' : 'convertibles');
    const prefix: Record<KRow['kind'], string> = { certificate: 'iss', rsa: 'awa', grant: 'awa', warrant: 'war', convertible: 'cnv' };
    const startRow = (sec: Sec): KRow => {
      const kind = kindOf(sec);
      const row = this.add(new Row(sectionOf(kind), sec.issue.item, sec.ocfId, str(sec.issue.obj.custom_id) ?? ''));
      row.object = String(sec.issue.obj.object_type);
      const k: KRow = {
        id: id(prefix[kind]), kind, section: row.section, secs: [sec], row, family: null, parent: null, holder: null, classId: null, className: null,
        label: str(sec.issue.obj.custom_id)?.slice(0, 120) ?? sec.ocfId.slice(-6).toUpperCase(), date: sec.issue.date ?? '', record: null, entries: [], exercises: [],
        print: null, matched: null, scheduleKey: null, poolKey: null, results: [], numbered: true, companion: null,
      };
      sec.krow = k;
      this.krows.push(k);
      return k;
    };
    /** The row a security lands on: climbs to the first security with a row, or a root, then settles the way down. No recursion: a chain may be thousands long. */
    const rowOf = (start: Sec): KRow | null => {
      const path: Sec[] = [];
      const onPath = new Set<Sec>();
      let sec: Sec | undefined = start;
      while (sec && !sec.krow) {
        if (onPath.has(sec)) return null;     // a loop
        onPath.add(sec);
        path.push(sec);
        sec = sec.producedBy ? this.secs.get(String(sec.producedBy.tx.obj.security_id)) : undefined;
      }
      for (let i = path.length - 1; i >= 0; i--) {
        const s = path[i];
        const by = s.producedBy;
        const parent = by ? this.secs.get(String(by.tx.obj.security_id))?.krow ?? null : null;
        if (by && by.continuation && parent) { s.krow = parent; parent.secs.push(s); continue; }
        const k = startRow(s);
        if (by && parent) { k.parent = { krow: parent, tx: by.tx }; parent.results.push(k); }
      }
      return start.krow;
    };
    for (const sec of [...this.secs.values()].sort((a, b) => a.issue.item - b.issue.item)) {
      const k = rowOf(sec);
      if (!k) {
        const row = this.add(new Row('captable', sec.issue.item, sec.ocfId, str(sec.issue.obj.custom_id) ?? ''));
        row.error('This security is created by an event of its own chain (a loop)', 'ocf-unsupported', 'security_id', sec.ocfId);
      }
    }
    for (const k of this.krows) k.secs.sort((a, b) => cmp(a.issue.date ?? '', b.issue.date ?? '') || a.issue.item - b.issue.item);

    // Families: a root and every row its events created.
    for (const k of this.krows) {
      if (k.parent) continue;
      const family: Family = { rows: [], krows: [], retracted: null, existing: 'no', differs: null };
      for (const stack = [k]; stack.length;) {
        const x = stack.pop()!;
        x.family = family;
        family.krows.push(x);
        family.rows.push(x.row);
        x.row.family = family;
        stack.push(...[...x.results].reverse());
      }
    }
    // Every event of a family's securities is a History row of the family, or folded into its row.
    for (const k of this.krows) {
      for (const sec of k.secs) {
        for (const t of sec.events) {
          const folded = this.folds(t, k);
          if (folded) continue;
          const row = this.eventRow(t);
          row.family = k.family;
          k.family?.rows.push(row);
          row.summary.security = k.label;
          row.summary.stakeholder = this.holderName(k.secs[0].issue.obj.stakeholder_id);
          const problem = problems.get(t);
          if (problem) row.error(problem, problem.includes('two events') ? 'ocf-unsupported' : 'ocf-unknown-reference', 'resulting_security_ids');
          if (/_RETRACTION$/.test(t.type) && k.family) {
            k.family.retracted = `Retracted on ${t.date ?? 'an unknown date'} (${row.named})`;
          }
          this.eventRows.set(t, row);
        }
      }
    }
  }

  /** Whether a stock issuance with an award note stays a restricted stock award: only cancellations and vesting happen to it. */
  private rsaOnly(sec: Sec): boolean {
    const ok = new Set(['TX_STOCK_CANCELLATION', 'TX_VESTING_START', 'TX_VESTING_EVENT', 'TX_VESTING_ACCELERATION', 'TX_STOCK_ACCEPTANCE']);
    const seen = new Set<Sec>();
    for (const stack = [sec]; stack.length;) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const t of s.events) {
        if (!ok.has(t.type)) return false;
        const b = str(t.obj.balance_security_id);
        const next = b ? this.secs.get(b) : undefined;
        if (next) stack.push(next);
      }
    }
    return true;
  }

  /** Events that are not rows: a vesting start, a milestone reached, an acceptance, a balance's issue, a re-issue that carries a row on. */
  private folds(t: Tx, k: KRow): boolean {
    if (t.type === 'TX_VESTING_START' || t.type === 'TX_VESTING_EVENT' || t.type === 'TX_EQUITY_COMPENSATION_ACCEPTANCE') return true;
    if (t.type === 'TX_STOCK_REISSUANCE') {
      const results = Array.isArray(t.obj.resulting_security_ids) ? t.obj.resulting_security_ids : [];
      const r = results.length === 1 && typeof results[0] === 'string' ? this.secs.get(results[0]) : undefined;
      if (r && r.krow === k) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Each row's references and record
  // -------------------------------------------------------------------------

  private resolve(k: KRow): void {
    const root = k.secs[0];
    const o = root.issue.obj;
    const row = k.row;
    const date = this.date(row, o.date, 'date');
    k.date = date ?? '';
    // Holder.
    k.holder = this.ref(row, 'stakeholders', this.people, o.stakeholder_id, 'stakeholder_id', 'a stakeholder');
    // Splits before the row's own date change its shares: it waits for them.
    for (const g of this.splitRows) if (date && g.date > date) for (const r of g.rows) row.deps.add(r);
    if (k.kind === 'certificate' || k.kind === 'rsa') this.resolveStock(k, root, date);
    else if (k.kind === 'grant') this.resolveGrant(k, root, date);
    else if (k.kind === 'warrant') this.resolveWarrant(k, root, date);
    else this.resolveConvertible(k, root, date);
    // A result dated otherwise than the event that created it.
    if (k.parent && k.parent.tx.date && date && k.parent.tx.date !== date) {
      row.warn(`Issued on ${date}, but the ${k.parent.tx.type.replace(/^TX_/, '').toLowerCase().replace(/_/g, ' ')} that created it is dated ${k.parent.tx.date}`, 'ocf-result-date', 'date', date);
    }
    for (const sec of k.secs.slice(1)) row.info(`${sec.ocfId} (issued ${sec.issue.date ?? '?'}) carries this ${k.kind === 'certificate' ? 'certificate' : 'security'} on: it is the same Kosmitor row`, 'ocf-folded');
  }

  private classOf(row: Row, ocfId: unknown, field: string): { id: string; name: string; kind: string } | null {
    return this.ref(row, 'shareClasses', this.classes, ocfId, field, 'a share class');
  }

  /** The vesting a security has: its terms (or its own vestings) as a schedule id, and its vesting start. */
  private vestingOf(k: KRow, quantity: number | null, issueDate: string | null, grant: boolean): { scheduleId: string | null; start: string | null } {
    const root = k.secs[0];
    const o = root.issue.obj;
    const row = k.row;
    const startTx = root.events.find((t) => t.type === 'TX_VESTING_START');
    const start = startTx ? this.date(row, startTx.obj.date, 'vesting start date') : issueDate;
    const termsId = str(o.vesting_terms_id);
    const terms = termsId ? this.ref(row, 'vesting', this.terms, termsId, 'vesting_terms_id', 'vesting terms') ?? undefined : undefined;
    // The security's own vestings, when it gives them.
    let vestings: Tranche[] | null = null;
    if (Array.isArray(o.vestings)) {
      vestings = [];
      for (const v of o.vestings) {
        const d = isObj(v) ? C.readDate(v.date, 'vestings.date') : null;
        const a = isObj(v) ? C.readShares(v.amount, 'vestings.amount') : null;
        if (!d?.ok || !a?.ok || a.value < 0) { row.error('A vesting in vestings has no valid date or amount', 'ocf-bad-object', 'vestings'); return { scheduleId: null, start }; }
        vestings.push({ date: d.value, quantity: a.value });
      }
    }
    // A Map, not an object: a condition may be called "constructor".
    const events = new Map<string, string>();
    for (const t of root.events.filter((x) => x.type === 'TX_VESTING_EVENT')) {
      const c = str(t.obj.vesting_condition_id);
      if (c && t.date && C.isCalendarDate(t.date)) events.set(c, t.date);
    }
    const ownSchedule = (tranches: Tranche[], why: string): string => {
      this.spend(tranches.length);
      const s = customSchedule(tranches, quantity!);
      const key = `sec:${root.ocfId}`;
      const name = `${terms?.name ?? 'Vesting'} — ${k.label}`.slice(0, 200);
      row.info(why, 'ocf-vesting-per-security');
      k.scheduleKey = key;
      return this.schedule(key, name, s, null, null);
    };
    if (!terms || !start || quantity == null) {
      if (vestings?.length && start && quantity != null) return { scheduleId: ownSchedule(vestings, 'Vests on its own dates (its vestings)'), start };
      if (!grant) return { scheduleId: null, start: null };
      // A grant needs a schedule: one that vests everything at once.
      const onFile = this.s.schedules.find((v) => v.kind === 'FULLY_VESTED');
      if (onFile) { k.scheduleKey = null; return { scheduleId: String(onFile.id), start: start ?? issueDate }; }
      k.scheduleKey = 'fully-vested';
      return { scheduleId: this.schedule('fully-vested', 'Fully vested at grant', { kind: 'FULLY_VESTED', durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 1,
        yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null }, null, null), start: start ?? issueDate };
    }
    const reading = terms.reading;
    if (reading.kind === 'unsupported') return { scheduleId: null, start };
    if (reading.kind === 'per-security') {
      let tranches: Tranche[];
      try { tranches = this.evaluate(terms.obj, quantity, start, events); } catch (e) {
        if (e instanceof OcfRefusal) throw e;
        row.error(e instanceof VestingTermsError ? `${e.message} Kosmitor cannot follow these terms` : 'Kosmitor could not work out what these vesting terms vest for this security', 'ocf-unsupported', 'vesting_terms_id');
        return { scheduleId: null, start };
      }
      if (vestings && !sameTranches(tranches, vestings)) tranches = vestings;
      return { scheduleId: ownSchedule(tranches, `"${terms.name}" vests on dates of its own for this security`), start };
    }
    let schedule: NotedSchedule = reading.schedule;
    let key = `terms:${terms.obj.id as string}`;
    let name = terms.name;
    if (schedule.kind === 'MILESTONE') {
      // Milestones reached, from this security's vesting events.
      const ms = (schedule.milestones ?? []).map((m) => {
        const on = events.get(`milestone-${m.id}`) ?? events.get(m.id) ?? null;
        return { ...m, achievedDate: on };
      });
      schedule = { ...schedule, milestones: ms };
      const map = ms.map((m) => m.achievedDate ?? '').join('|');
      const variants = this.milestoneVariants.get(key) ?? [];
      if (!variants.includes(map)) variants.push(map);
      this.milestoneVariants.set(key, variants);
      const n = variants.indexOf(map);
      if (n > 0) { key = `${key}#${n}`; name = `${terms.name} (${n + 1})`; }
    }
    if (vestings && quantity > 0 && !sameTranches(scheduleTranches({ ...schedule, id: 'x', name } as VestingSchedule, quantity, start), vestings)) {
      return { scheduleId: ownSchedule(vestings, `Its vestings differ from "${terms.name}": it vests on its own dates`), start };
    }
    k.scheduleKey = key;
    this.spend(scheduleSize(schedule));
    return { scheduleId: this.termsSchedule(terms, key, name, schedule), start };
  }

  /** What terms vest for one security, worked out once for each security that vests alike, within the package's budget. */
  private evaluate(terms: Obj, quantity: number, start: string, events: Map<string, string>): Tranche[] {
    const key = JSON.stringify([terms.id, quantity, start, [...events.entries()].sort()]);
    const known = this.evaluated.get(key);
    if (known) return known.map((t) => ({ ...t }));
    this.spend(termsDateCount(terms as never));
    const tranches = evaluateTerms(terms as never, { quantity, startDate: start, events });
    this.evaluated.set(key, tranches.map((t) => ({ ...t })));
    return tranches;
  }
  private readonly evaluated = new Map<string, Tranche[]>();
  private vestingDates = 0;
  /** Counts vesting dates against MAX_PACKAGE_VESTING_DATES, and refuses the package past it. */
  private spend(dates: number): void {
    this.vestingDates += dates;
    if (this.vestingDates > MAX_PACKAGE_VESTING_DATES) {
      throw new OcfRefusal('ocf-too-large', `This package's securities vest on more than ${MAX_PACKAGE_VESTING_DATES.toLocaleString('en-US')} dates in all, more than an import works out.`, { limitDates: MAX_PACKAGE_VESTING_DATES });
    }
  }

  /** The schedule of a terms object (or of one of its milestone variants), and what its row says about it. */
  private termsSchedule(terms: { obj: Obj; row: Row; name: string }, key: string, name: string, schedule: NotedSchedule): string {
    const fresh = !this.schedules.has(key);
    const sid = this.schedule(key, name, schedule, terms.row, String(terms.obj.id));
    if (!fresh) return sid;
    const s = this.schedules.get(key)!;
    if (s.record) terms.row.info(`Creates vesting schedule "${s.name}"`, 'schedule-created');
    else if (!key.includes('#')) {
      terms.row.base = 'existing';
      terms.row.messages.push({ level: 'info', text: `Already on the cap table${s.name !== terms.name ? ` as "${s.name}"` : ''}`, code: 'already-imported' });
    }
    return sid;
  }

  /** Terms no security of the package uses still bring their schedule. */
  private settleTerms(): void {
    for (const terms of this.terms.values()) {
      if (terms.reading.kind !== 'schedule' || terms.row.ownError) continue;
      const key = `terms:${terms.obj.id as string}`;
      if (!this.schedules.has(key)) this.termsSchedule(terms, key, terms.name, terms.reading.schedule);
    }
  }
  private readonly milestoneVariants = new Map<string, string[]>();

  private resolveStock(k: KRow, root: Sec, date: string | null): void {
    const o = root.issue.obj;
    const row = k.row;
    const cls = this.classOf(row, o.stock_class_id, 'stock_class_id');
    k.classId = cls?.id ?? null;
    k.className = cls?.name ?? null;
    const quantity = this.shares(row, o.quantity, 'quantity');
    if (quantity != null && quantity <= 0) row.error('quantity must be greater than zero', 'not-positive', 'quantity', o.quantity);
    const price = o.share_price == null ? null : this.money(row, o.share_price, 'share_price', 'micros');
    if (o.share_price == null) row.warn('No share price — recorded at $0.00', 'no-price', 'share_price');
    const note = readNote(o, 'TX_STOCK_ISSUANCE');
    const { scheduleId, start } = this.vestingOf(k, quantity, date, k.kind === 'rsa');
    const exemptions = (Array.isArray(o.security_law_exemptions) ? o.security_law_exemptions : []).filter(isObj).map((e) => str(e.description)).filter((d): d is string => !!d);
    let federal: string | null = null, stateExemption: string | null = null;
    for (const d of exemptions) {
      const code = C.federalExemptionOf(d);
      if (code && !federal) federal = code; else if (!stateExemption) stateExemption = d.slice(0, 200);
    }
    const board = o.board_approval_date == null ? null : this.date(row, o.board_approval_date, 'board_approval_date');
    const numbers = (Array.isArray(o.share_numbers_issued) ? o.share_numbers_issued : []).filter(isObj)
      .map((r) => `${String(r.starting_share_number ?? '?')}–${String(r.ending_share_number ?? '?')}`);
    const notes = [...plainComments(o), ...(numbers.length ? [`Share numbers ${numbers.join(', ')}`] : [])].join('\n').slice(0, 4000) || null;
    const value = quantity != null && price != null ? cents(quantity, price) : 0;
    if (value == null) row.error('quantity times share_price is more money than Kosmitor can record', 'bad-number', 'share_price');
    if (k.kind === 'rsa') {
      const award = note.award!;
      const planOcf = str(o.stock_plan_id);
      const plan = planOcf ? this.ref(row, 'plans', this.plans, planOcf, 'stock_plan_id', 'a plan') : null;
      const poolId = planOcf ? plan?.id ?? null : this.planless(k, row, quantity ?? 0);
      k.row.summary = ({ stakeholder: k.holder?.name ?? null, type: 'RSA', shares: quantity, strike: price != null ? price / 1e6 : null, grantDate: date, vesting: scheduleId ? 'yes' : null, label: award.label ?? k.label, state: null });
      if (row.ownError || quantity == null || !date || !poolId) return;
      // An award with no label of its own has none here either.
      k.numbered = award.label != null;
      k.label = award.label ?? k.label;
      k.record = {
        id: k.id, companyId: this.companyId, label: award.label, stakeholderId: k.holder?.id ?? null, poolId, type: 'RSA', quantity, strikePrice: price ?? 0,
        grantDate: date, vestingStartDate: start ?? date, vestingScheduleId: scheduleId, status: 'OUTSTANDING', expirationDate: award.expirationDate,
        ptepMonths: award.ptepMonths, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: board, acceptedDate: null,
        fmvAtGrant: award.fmvAtGrant, rsuLiquidityCondition: 0, notes, createdAt: this.stamp(root.issue.item),
      };
      k.entries.push(this.entry(k, 'GRANT', date, quantity, { pricePerShare: price ?? 0, amount: null, memo: `${this.memo} (OCF ${ref(root.ocfId)})` }, root.issue.ocfId));
      return;
    }
    k.row.summary = ({ stakeholder: k.holder?.name ?? null, shareClass: k.className, shares: quantity, price: price != null ? price / 1e6 : null, issueDate: date,
      certificate: k.label, vesting: scheduleId ? 'yes' : null, state: null });
    if (row.ownError || quantity == null || !date || !cls) return;
    // A number made up from an id (an unnumbered certificate exported) is not kept as one.
    k.numbered = !note.unnumbered;
    k.record = {
      id: k.id, companyId: this.companyId, certificateNo: k.numbered ? k.label : null, stakeholderId: k.holder?.id ?? null, shareClassId: cls.id, quantity, pricePerShare: price ?? 0,
      issueDate: date, status: 'OUTSTANDING', vestingScheduleId: scheduleId, vestingStartDate: scheduleId ? start ?? date : null,
      earlyExercised: note.earlyExercised ? 1 : 0, election83bFiledOn: note.election83bFiledOn ?? null, sourceAwardId: null, boardApprovalDate: board,
      notes, federalExemption: federal, stateExemption, createdAt: this.stamp(root.issue.item),
    };
    k.entries.push(this.entry(k, 'ISSUANCE', date, quantity, {
      shareClassId: cls.id, pricePerShare: price ?? 0, amount: value ?? 0, memo: `${this.memo} (OCF ${ref(root.ocfId)})`,
    }, root.issue.ocfId));
    if (note.rsaAward) this.rsaCompanion(k, root, note.rsaAward, scheduleId, start);
  }

  /**
   * The restricted stock award a certificate is the shares of (its note's `rsaAward`):
   * an `awards` row of type RSA that the certificate names (sourceAwardId), with its
   * grant and its own cancellations dated in the ledger. Kosmitor counts the shares
   * through the certificate, so the award adds none.
   */
  private rsaCompanion(k: KRow, root: Sec, a: RsaOfCertificateNote, certSchedule: string | null, certStart: string | null): void {
    const row = k.row;
    const o = root.issue.obj;
    const planOcf = str(o.stock_plan_id);
    const plan = planOcf ? this.ref(row, 'plans', this.plans, planOcf, 'stock_plan_id', 'a plan') : null;
    const poolId = planOcf ? plan?.id ?? null : this.planless(k, row, a.quantity);
    if (!poolId || !k.record) return;
    let scheduleKey: string | null = null;
    let scheduleId = certSchedule;
    if (a.vestingTermsId) {
      const terms = this.ref(row, 'vesting', this.terms, a.vestingTermsId, 'rsaAward.vestingTermsId', 'vesting terms');
      if (terms?.reading.kind === 'schedule') {
        scheduleKey = `terms:${String(terms.obj.id)}`;
        this.spend(scheduleSize(terms.reading.schedule));
        scheduleId = this.termsSchedule(terms, scheduleKey, terms.name, terms.reading.schedule);
      }
    }
    if (!scheduleId) {
      const onFile = this.s.schedules.find((v) => v.kind === 'FULLY_VESTED');
      if (onFile) scheduleId = String(onFile.id);
      else {
        scheduleKey = 'fully-vested';
        scheduleId = this.schedule('fully-vested', 'Fully vested at grant', { kind: 'FULLY_VESTED', durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 1,
          yearWeights: null, milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null }, null, null);
      }
    }
    const awardId = id('awa');
    const holder = k.holder?.id ?? null;
    const at = this.stamp(root.issue.item);
    const entries: Entry[] = [{
      id: id('tx'), companyId: this.companyId, type: 'GRANT', date: a.grantDate, stakeholderId: holder, counterpartyId: null, securityId: awardId, shareClassId: null,
      quantity: a.quantity, pricePerShare: a.price, amount: null, memo: `${this.memo} (OCF ${ref(root.ocfId)}, its restricted stock award)`, createdAt: at, createdBy: this.createdBy, ocfTx: null,
    }];
    let cancelled = 0, last: string | null = null;
    (a.entries ?? []).forEach((e) => {
      const units = e.quantity / this.kOf(a.grantDate, e.date);
      if (cancelled + units > a.quantity + 1e-6) return;
      cancelled = roundShares(cancelled + units);
      last = e.type;
      entries.push({
        id: id('tx'), companyId: this.companyId, type: e.type, date: e.date, stakeholderId: holder, counterpartyId: null, securityId: awardId, shareClassId: null,
        quantity: e.quantity, pricePerShare: null, amount: null, memo: `${this.memo} (OCF ${ref(root.ocfId)}, its restricted stock award)`, createdAt: at, createdBy: this.createdBy, ocfTx: null,
      });
    });
    const record: Obj = {
      id: awardId, companyId: this.companyId, label: a.label, stakeholderId: holder, poolId, type: 'RSA', quantity: a.quantity, strikePrice: a.price,
      grantDate: a.grantDate, vestingStartDate: a.vestingStartDate ?? certStart ?? a.grantDate, vestingScheduleId: scheduleId,
      status: cancelled >= a.quantity - 1e-6 ? (last === 'EXPIRATION' ? 'EXPIRED' : 'CANCELLED') : 'OUTSTANDING', expirationDate: a.expirationDate,
      ptepMonths: a.ptepMonths, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: cancelled, boardApprovalDate: null, acceptedDate: null,
      fmvAtGrant: a.fmvAtGrant, rsuLiquidityCondition: 0, notes: null, createdAt: this.stamp(root.issue.item),
    };
    k.record.sourceAwardId = awardId;
    k.companion = { record, entries, scheduleKey };
    row.info(`Brings its restricted stock award${a.label ? ` ${a.label}` : ''} of ${count(a.quantity)} shares, which the certificate is the shares of`, 'ocf-folded');
  }

  /** The plan "Grants outside a plan", for grants that name none. */
  private planless(k: KRow, row: Row, quantity: number): string | null {
    const common = this.commonClass();
    if (!common) { row.error('The grant names no plan, and there is no common class for one to draw on', 'no-common-class', 'stock_plan_id'); return null; }
    row.warn('Names no equity plan: it is put in "Grants outside a plan", sized to such grants', 'ocf-planless-grant', 'stock_plan_id');
    k.poolKey = 'planless';
    const have = this.planlessPool ?? (this.planlessPool = {
      record: {
        id: id('pol'), companyId: this.companyId, name: 'Grants outside a plan', shareClassId: common.id, authorized: 0, boardApprovalDate: null,
        shareholderApprovalDate: null, returnForfeitures: 0, evergreenPercent: null, planType: 'STOCK_PLAN', createdAt: this.stamp(0),
      },
      existingId: (this.s.pools.find((p) => nameKey(String(p.name)) === nameKey('Grants outside a plan'))?.id as string | undefined) ?? null,
    });
    void quantity;
    return have.existingId ?? String(have.record.id);
  }
  private planlessPool: { record: Obj; existingId: string | null } | null = null;

  private resolveGrant(k: KRow, root: Sec, date: string | null): void {
    const o = root.issue.obj;
    const row = k.row;
    const note = readNote(o, 'TX_EQUITY_COMPENSATION_ISSUANCE');
    const comp = str(o.compensation_type) ?? '';
    const typed = C.awardTypeOf(comp, str(o.option_grant_type) ?? undefined, note.type);
    if (!typed) row.error(`compensation_type ${comp || '(none)'} is not one Kosmitor records`, 'ocf-bad-object', 'compensation_type', comp);
    else if (typed.assumed) row.warn('An option with no ISO or NSO type: recorded as an NSO', 'ocf-option-type-assumed', 'option_grant_type', o.option_grant_type ?? null);
    const type = typed?.type ?? null;
    const quantity = this.shares(row, o.quantity, 'quantity');
    if (quantity != null && quantity <= 0) row.error('quantity must be greater than zero', 'not-positive', 'quantity', o.quantity);
    const settles = type === 'RSU' || type === 'PHANTOM';
    let strike = settles ? 0 : this.money(row, o.exercise_price ?? o.base_price, o.exercise_price != null ? 'exercise_price' : 'base_price', 'micros');
    if (strike == null && !settles) { row.warn(`No exercise price — recorded at $0.00`, 'no-price', 'exercise_price'); strike = 0; }
    const planOcf = str(o.stock_plan_id);
    const plan = planOcf ? this.ref(row, 'plans', this.plans, planOcf, 'stock_plan_id', 'a plan') : null;
    if (typeof o.stock_class_id === 'string') this.classOf(row, o.stock_class_id, 'stock_class_id');
    const poolId = plan?.id ?? (planOcf ? null : this.planless(k, row, quantity ?? 0));
    k.classId = plan?.classId ?? this.planlessPool?.record.shareClassId as string ?? null;
    const { scheduleId, start } = this.vestingOf(k, quantity, date, true);
    let expiration = o.expiration_date == null ? null : this.date(row, o.expiration_date, 'expiration_date', true, true);
    // No date: the note says when it never expires; otherwise the usual term is assumed.
    if (!expiration && date && !settles && o.expiration_date == null && !note.noExpiration) {
      const years = type === 'ISO' ? Math.min(10, config().equity.optionTermYears) : config().equity.optionTermYears;
      expiration = addMonths(date, years * 12);
      row.info(`No expiration date — assumed ${years} year${years === 1 ? '' : 's'} from grant`, 'expiration-assumed', 'expiration_date');
    }
    // The post-termination window: a voluntary leaver's, else an involuntary one's, else the first given.
    const windows = (Array.isArray(o.termination_exercise_windows) ? o.termination_exercise_windows : []).filter(isObj);
    const win = windows.find((w) => w.reason === 'VOLUNTARY_OTHER') ?? windows.find((w) => w.reason === 'INVOLUNTARY_OTHER') ?? windows[0];
    let ptep = config().equity.postTerminationExerciseMonths;
    if (win && typeof win.period === 'number' && Number.isFinite(win.period) && win.period >= 0) {
      const months = win.period_type === 'YEARS' ? win.period * 12 : win.period_type === 'DAYS' ? win.period / 30 : win.period;
      ptep = Math.min(1200, Math.round(months));
      if (ptep !== months) row.info(`The exercise window of ${win.period} ${String(win.period_type).toLowerCase()} is recorded as ${ptep} months`, 'ptep-assumed', 'termination_exercise_windows');
    } else row.info(`No post-termination exercise window — assumed ${ptep} months`, 'ptep-assumed', 'termination_exercise_windows');
    const acceptance = root.events.find((t) => t.type === 'TX_EQUITY_COMPENSATION_ACCEPTANCE');
    const accepted = acceptance?.date && C.isCalendarDate(acceptance.date) ? acceptance.date : null;
    const board = o.board_approval_date == null ? null : this.date(row, o.board_approval_date, 'board_approval_date');
    k.row.summary = ({ stakeholder: k.holder?.name ?? null, type, shares: quantity, strike: strike != null ? strike / 1e6 : null, grantDate: date, vesting: scheduleId ? 'yes' : null, label: k.label, state: null });
    if (row.ownError || quantity == null || !date || !type || !poolId || !scheduleId) return;
    k.numbered = !note.unnumbered;
    k.record = {
      id: k.id, companyId: this.companyId, label: k.numbered ? k.label : null, stakeholderId: k.holder?.id ?? null, poolId, type, quantity, strikePrice: strike ?? 0, grantDate: date,
      vestingStartDate: start ?? date, vestingScheduleId: scheduleId, status: 'OUTSTANDING', expirationDate: expiration, ptepMonths: ptep,
      earlyExerciseAllowed: o.early_exercisable === true ? 1 : 0, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: board, acceptedDate: accepted,
      fmvAtGrant: note.fmvAtGrant ?? 0, rsuLiquidityCondition: note.rsuLiquidityCondition ? 1 : 0, notes: plainComments(o).join('\n').slice(0, 4000) || null,
      createdAt: this.stamp(root.issue.item),
    };
    k.entries.push(this.entry(k, 'GRANT', date, quantity, { pricePerShare: strike ?? 0, amount: null, memo: `${this.memo} (OCF ${ref(root.ocfId)})` }, root.issue.ocfId));
  }

  private resolveWarrant(k: KRow, root: Sec, date: string | null): void {
    const o = root.issue.obj;
    const row = k.row;
    const triggers = (Array.isArray(o.exercise_triggers) ? o.exercise_triggers : []).filter(isObj);
    const right = triggers.map((t) => (isObj(t.conversion_right) ? t.conversion_right : null)).find((r) => r) ?? null;
    const mech = right && isObj(right.conversion_mechanism) ? right.conversion_mechanism : null;
    let quantity = o.quantity == null ? null : this.shares(row, o.quantity, 'quantity');
    if (quantity == null && mech?.type === 'FIXED_AMOUNT_CONVERSION') quantity = this.shares(row, mech.converts_to_quantity, 'converts_to_quantity');
    if (quantity == null && !row.ownError) row.error('The warrant states no number of shares', 'required', 'quantity');
    if (quantity != null && quantity <= 0) row.error('quantity must be greater than zero', 'not-positive', 'quantity', o.quantity);
    const classOcf = right?.converts_to_stock_class_id;
    let cls: { id: string; name: string } | null = null;
    if (typeof classOcf === 'string') cls = this.classOf(row, classOcf, 'converts_to_stock_class_id');
    else {
      const common = this.commonClass();
      if (common) { cls = common; if (common.row) row.deps.add(common.row); row.warn(`Names no class it converts into — read as ${common.name}`, 'ocf-terms-approximate', 'exercise_triggers'); }
      else row.error('Names no class it converts into, and there is no common class', 'no-common-class', 'exercise_triggers');
    }
    k.classId = cls?.id ?? null;
    k.className = cls?.name ?? null;
    let strike = o.exercise_price == null ? null : this.money(row, o.exercise_price, 'exercise_price', 'micros');
    if (o.exercise_price == null) { row.warn('No exercise price — recorded at $0.00', 'no-price', 'exercise_price'); strike = 0; }
    const purchase = o.purchase_price == null ? null : this.money(row, o.purchase_price, 'purchase_price', 'cents');
    if (o.vesting_terms_id || Array.isArray(o.vestings)) row.warn('Vesting of a warrant is not imported: Kosmitor\'s warrants do not vest', 'ocf-vesting-ignored', 'vesting_terms_id');
    const expiration = o.warrant_expiration_date == null ? null : this.date(row, o.warrant_expiration_date, 'warrant_expiration_date', true, true);
    const note = readNote(o, 'TX_WARRANT_ISSUANCE');
    k.row.summary = ({ stakeholder: k.holder?.name ?? null, shareClass: k.className, shares: quantity, strike: strike != null ? strike / 1e6 : null, issueDate: date, expirationDate: expiration, state: null });
    if (row.ownError || quantity == null || !date || !cls) return;
    k.record = {
      id: k.id, companyId: this.companyId, stakeholderId: k.holder?.id ?? null, shareClassId: cls.id, quantity, strikePrice: strike ?? 0, issueDate: date,
      expirationDate: expiration, status: 'OUTSTANDING', exercisedQuantity: 0, netExercise: note.netExercise === false ? 0 : 1,
      // Kosmitor's warrants have no number or purchase price: the notes keep them, in a form the export reads back.
      notes: [`Warrant number: ${k.label}${purchase ? `; purchase price: ${C.centsToAmount(purchase)} ${this.s.currency}` : ''}`, ...plainComments(o)].join('\n').slice(0, 4000), createdAt: this.stamp(root.issue.item),
    };
    k.entries.push(this.entry(k, 'ISSUANCE', date, quantity, { shareClassId: cls.id, pricePerShare: strike ?? 0, amount: null, memo: `${this.memo} (OCF ${ref(root.ocfId)})` }, root.issue.ocfId));
  }

  private resolveConvertible(k: KRow, root: Sec, date: string | null): void {
    const o = root.issue.obj;
    const row = k.row;
    const note = readNote(o, 'TX_CONVERTIBLE_ISSUANCE');
    const principal = this.money(row, o.investment_amount, 'investment_amount', 'cents');
    if (o.investment_amount == null) row.error('investment_amount is missing', 'required', 'investment_amount');
    if (principal != null && principal <= 0) row.error('investment_amount must be greater than zero', 'not-positive', 'investment_amount');
    const triggers = (Array.isArray(o.conversion_triggers) ? o.conversion_triggers : []).filter(isObj);
    const rights = triggers.map((t) => (isObj(t.conversion_right) && isObj(t.conversion_right.conversion_mechanism) ? t.conversion_right.conversion_mechanism : null));
    const mech = rights.find((m) => m && (m.type === 'SAFE_CONVERSION' || m.type === 'CONVERTIBLE_NOTE_CONVERSION')) ?? null;
    const other = rights.find((m) => m && m.type !== 'SAFE_CONVERSION' && m.type !== 'CONVERTIBLE_NOTE_CONVERSION');
    if (!mech && other) row.warn(`Converts by ${String(other.type).toLowerCase().replace(/_/g, ' ')}, which Kosmitor does not model: imported with no cap or discount`, 'ocf-terms-approximate', 'conversion_triggers');
    const { instrument, assumed } = C.instrumentOf(String(o.convertible_type ?? ''), mech ? str(mech.conversion_timing) ?? undefined : undefined, note.instrument);
    if (assumed) row.info('A SAFE with no pre- or post-money timing: read as a post-money SAFE', 'instrument-assumed', 'conversion_timing');
    const isSafe = instrument === 'SAFE_POST' || instrument === 'SAFE_PRE';
    let cap: number | null = null, discount = 0, rate = 0, compounding: string = 'SIMPLE', mfn = false;
    if (mech) {
      cap = mech.conversion_valuation_cap == null ? null : this.money(row, mech.conversion_valuation_cap, 'conversion_valuation_cap', 'cents');
      if (mech.conversion_discount != null) {
        const d = C.readPercentage(mech.conversion_discount, 'conversion_discount');
        if (d.ok) discount = d.value; else row.issue(d.issue);
      }
      mfn = mech.conversion_mfn === true;
      if (mech.type === 'CONVERTIBLE_NOTE_CONVERSION') {
        const rates = (Array.isArray(mech.interest_rates) ? mech.interest_rates : []).filter(isObj);
        if (rates.length > 1) row.warn(`Has ${rates.length} interest rates; Kosmitor keeps the first`, 'ocf-terms-approximate', 'interest_rates');
        if (rates[0]) { const r = C.readPercentage(rates[0].rate, 'interest_rates.rate'); if (r.ok) rate = r.value; else row.issue(r.issue); }
        const c = C.compoundingOf(String(mech.compounding_type ?? 'SIMPLE'), String(mech.interest_accrual_period ?? ''));
        compounding = note.compounding ?? c.compounding;
        if (c.approximate && !note.compounding) row.warn(`Compounds ${String(mech.interest_accrual_period).toLowerCase().replace(/_/g, '-')}: recorded as annual`, 'ocf-terms-approximate', 'interest_accrual_period');
      }
    }
    const maturity = triggers.find((t) => t.type === 'AUTOMATIC_ON_DATE' && typeof t.trigger_date === 'string');
    const maturityDate = maturity && !isSafe ? this.date(row, maturity.trigger_date, 'trigger_date', false, true) : null;
    const proRata = note.proRataRight ?? (o.pro_rata != null && Number(o.pro_rata) > 0);
    const board = o.board_approval_date == null ? null : this.date(row, o.board_approval_date, 'board_approval_date');
    k.row.summary = ({ stakeholder: k.holder?.name ?? null, instrument, label: k.label, principal: principal != null ? principal / 100 : null, issueDate: date,
      cap: cap != null ? cap / 100 : null, discount, status: null });
    if (row.ownError || principal == null || !date) return;
    k.numbered = !note.unnumbered;
    k.record = {
      id: k.id, companyId: this.companyId, stakeholderId: k.holder?.id ?? null, label: k.numbered ? k.label : null, instrument, principal, issueDate: date, valuationCap: cap,
      discount, interestRate: isSafe ? 0 : rate, compounding, maturityDate, mfn: mfn ? 1 : 0, proRataRight: proRata ? 1 : 0, status: 'OUTSTANDING',
      convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: note.qualifiedFinancingMinimum ?? null,
      notes: plainComments(o).join('\n').slice(0, 4000) || null, boardApprovalDate: board, createdAt: this.stamp(root.issue.item),
      fundsReceivedOn: note.fundsReceivedOn ?? null, fundsReference: note.fundsReference?.slice(0, 200) ?? null,
    };
    k.entries.push(this.entry(k, 'ISSUANCE', date, null, { amount: principal, memo: `${this.memo} (OCF ${ref(root.ocfId)})` }, root.issue.ocfId));
  }

  /** A ledger entry for a row, in the package's order. */
  private entry(k: KRow, type: string, date: string, quantity: number | null, rest: Obj, ocfTx: string | null, item?: number): Entry {
    return {
      id: id('tx'), companyId: this.companyId, type, date, stakeholderId: k.holder?.id ?? null, counterpartyId: null, securityId: k.id,
      shareClassId: null, quantity, pricePerShare: null, amount: null, memo: this.memo, createdAt: this.stamp(item ?? k.secs[0].issue.item), createdBy: this.createdBy,
      ...rest, ocfTx,
    } as Entry;
  }

  // -------------------------------------------------------------------------
  // Events, replayed
  // -------------------------------------------------------------------------

  private replay(k: KRow): void {
    const rec = k.record;
    const events = k.secs.flatMap((s) => s.events.map((t) => ({ t, sec: s }))).sort((a, b) => cmp(a.t.date ?? '', b.t.date ?? '') || a.t.item - b.t.item);
    // A row with no record (its own errors) still checks its events' references, so they say what is wrong.
    const issued = Number(rec?.quantity ?? 0);
    let remaining = issued, exercised = 0, cancelled = 0;
    let status = 'OUTSTANDING';
    let ended: Tx | null = null;
    const owner = (t: Tx) => this.eventRows.get(t);
    const results = (t: Tx): KRow[] => (Array.isArray(t.obj.resulting_security_ids) ? t.obj.resulting_security_ids : [])
      .map((x) => (typeof x === 'string' ? this.secs.get(x)?.krow : undefined)).filter((x): x is KRow => !!x && x !== k);
    for (const { t, sec } of events) {
      const row = owner(t);
      if (!row) continue;    // folded
      if (k.family?.retracted) { row.base = 'skip'; continue; }
      if (/_RETRACTION$/.test(t.type)) { row.base = 'skip'; row.info('Retracts the security: its family is not imported', 'ocf-not-imported'); continue; }
      if (row.ownError || !t.date || !rec) continue;
      const kOf = this.kOf(k.date, t.date);
      const secDate = sec.issue.date ?? k.date;
      if (t.date < secDate && t.type !== 'TX_VESTING_ACCELERATION') {
        row.error(`Dated ${t.date}, before the security was issued (${secDate})`, 'ocf-event-order', 'date', t.date); continue;
      }
      if (ended && t.type !== 'TX_VESTING_ACCELERATION') {
        row.error(`Dated after the security ${ended.type === t.type ? 'was' : 'had been'} closed by item ${ended.item} on ${ended.date}`, 'ocf-event-order', 'date', t.date); continue;
      }
      if (sec.closed && t.type !== 'TX_VESTING_ACCELERATION') {
        row.error(`About ${sec.ocfId}, which an earlier event carried on to another security`, 'ocf-event-order', 'security_id', sec.ocfId); continue;
      }
      const rs = results(t);
      const balance = str(t.obj.balance_security_id);
      const balanceSec = balance ? this.secs.get(balance) : undefined;
      const quantityOf = (field: string) => this.shares(row, t.obj[field], field);
      const resultText = rs.length ? ` to ${rs.map((r) => `${r.holder?.name ?? 'someone'} (${r.label})`).join(', ')}` : '';
      const reason = str(t.obj.reason_text);
      const memo = (text: string) => `${text} (OCF ${ref(t.ocfId)})`;
      const firstPrice = rs[0]?.record ? Number(rs[0].record.pricePerShare ?? rs[0].record.strikePrice ?? 0) : null;
      row.summary.stakeholder = k.holder?.name ?? row.summary.stakeholder;
      // What a cancellation was in Kosmitor's ledger, when the package says (its note), else what its words say.
      const cancelNote = readNote(t.obj, 'TX_CANCELLATION');
      const cancelType = (guess: boolean): string => (cancelNote.type && cancelNote.type !== 'CORRECTION' ? cancelNote.type
        : guess && /forfeit/i.test(reason ?? '') ? 'FORFEITURE' : guess && /expir/i.test(reason ?? '') ? 'EXPIRATION' : 'CANCELLATION');
      /** What was paid as the package states it ("1250.00 USD"), in cents: undefined when it does not. */
      const consideration = (): number | undefined => {
        const m = /^(\d+(?:\.\d+)?) ([A-Z]{3})$/.exec(str(t.obj.consideration_text) ?? '');
        return m && m[2] === this.s.currency ? C.scaleDecimal(m[1], 2)?.value : undefined;
      };
      const tooMuch = (field: string) => row.error('The amount this comes to is more money than Kosmitor can record', 'bad-number', field);
      // A grant ends expired on an expiry, or when the cancellation's reason is just "Expired" (the cancel route's own word for it).
      const expires = (type: string): boolean => type === 'EXPIRATION' || /^expired\.?$/i.test(reason ?? '');

      // Acceleration: recorded, not applied.
      if (t.type === 'TX_VESTING_ACCELERATION') {
        const q = quantityOf('quantity');
        if (q == null) continue;
        row.summary.quantity = q;
        k.entries.push(this.entry(k, 'VESTING_ACCELERATION', t.date, q, { memo: memo(reason ?? 'Accelerated') }, t.ocfId, t.item));
        row.warn('Recorded in the ledger; Kosmitor\'s vesting does not apply it', 'ocf-acceleration-not-applied');
        continue;
      }

      if (k.kind === 'certificate' || k.kind === 'rsa') {
        const known = lookup(STOCK_EVENTS, t.type);
        if (!known || (k.kind === 'rsa' && t.type !== 'TX_STOCK_CANCELLATION')) { this.notMine(row, t, k); continue; }
        const q = t.type === 'TX_STOCK_REISSUANCE' ? roundShares(remaining * kOf) : t.type === 'TX_STOCK_CONVERSION' ? quantityOf('quantity_converted') : quantityOf('quantity');
        if (q == null) continue;
        if (q <= 0) { row.error('quantity must be greater than zero', 'not-positive', 'quantity'); continue; }
        const units = q / kOf;
        const left = k.kind === 'rsa' ? roundShares(issued - cancelled) : remaining;
        if (units > left + 1e-6 * Math.max(1, left)) { row.error(`Takes ${count(q)} shares; the security holds ${count(roundShares(left * kOf))} on ${t.date}`, 'over-granted', 'quantity', t.obj.quantity ?? null); continue; }
        row.summary.quantity = q;
        const after = roundShares(left - units);
        const full = after <= 1e-6 && !balanceSec;
        // A certificate is cancelled; a restricted stock award may be forfeited or expire.
        const type = k.kind === 'rsa' ? cancelType(true) : t.type === 'TX_STOCK_CANCELLATION' ? 'CANCELLATION' : known;
        const counterparty = t.type === 'TX_STOCK_TRANSFER' || t.type === 'TX_STOCK_REISSUANCE' ? rs[0]?.holder?.id ?? null : null;
        const price = t.type === 'TX_STOCK_REPURCHASE' ? (t.obj.price == null ? Math.round(Number(rec.pricePerShare ?? rec.strikePrice ?? 0) / kOf) : this.money(row, t.obj.price, 'price', 'micros'))
          : t.type === 'TX_STOCK_TRANSFER' ? firstPrice : null;
        // What was paid: as the package states it, else the shares at the price.
        const paid = t.type === 'TX_STOCK_TRANSFER' || t.type === 'TX_STOCK_REPURCHASE' ? consideration() : undefined;
        const amount = paid ?? (price != null && (t.type === 'TX_STOCK_TRANSFER' || t.type === 'TX_STOCK_REPURCHASE') ? cents(q, price) : null);
        if (amount === null && price != null && (t.type === 'TX_STOCK_TRANSFER' || t.type === 'TX_STOCK_REPURCHASE')) { tooMuch('price'); continue; }
        const words = t.type === 'TX_STOCK_REISSUANCE' ? `Reissued as ${rs.map((r) => r.label).join(', ') || 'another certificate'}`
          : t.type === 'TX_STOCK_TRANSFER' ? 'Share transfer' : t.type === 'TX_STOCK_REPURCHASE' ? 'Share repurchase' : t.type === 'TX_STOCK_CONVERSION' ? `Converted into ${rs.map((r) => r.label).join(', ') || 'other shares'}` : reason ?? 'Certificate cancelled';
        k.entries.push(this.entry(k, type, t.date, q, {
          counterpartyId: counterparty, shareClassId: k.classId, pricePerShare: price, amount,
          memo: memo(t.type === 'TX_STOCK_CANCELLATION' ? reason ?? 'Certificate cancelled' : words), resultingSecurityId: rs[0]?.id ?? null,
        }, t.ocfId, t.item));
        row.summary.amount = amount != null ? amount / 100 : null;
        row.summary.detail = `${type.charAt(0)}${type.slice(1).toLowerCase()}${resultText}`;
        if (k.kind === 'rsa') {
          cancelled = roundShares(cancelled + units);
          if (after <= 1e-6) { status = expires(type) ? 'EXPIRED' : 'CANCELLED'; ended = t; }
        } else if (full) {
          status = { TRANSFER: 'TRANSFERRED', REPURCHASE: 'REPURCHASED', CANCELLATION: 'CANCELLED', CONVERSION: 'CONVERTED' }[type]!;
          remaining = left;          // closed with what it held
          ended = t;
        } else remaining = after;
        if (balanceSec) {
          const b = C.readShares(balanceSec.issue.obj.quantity, 'quantity');
          if (!b.ok || !near(b.value, after * kOf)) {
            row.error(`The balance ${balance} holds ${b.ok ? count(b.value) : '?'} shares, but ${count(roundShares(after * kOf))} are left`, 'ocf-balance-mismatch', 'balance_security_id', balance);
          }
          sec.closed = true;
          row.info(`The rest carries on as ${cut(balanceSec.issue.obj.custom_id, 120) ?? ref(balance!)}, a balance certificate: the same Kosmitor certificate`, 'ocf-folded');
        } else if (after > 1e-6 && t.type !== 'TX_STOCK_REISSUANCE') {
          row.warn(`Leaves ${count(roundShares(after * kOf))} shares but names no balance certificate: they stay on this one`, 'ocf-no-balance', 'balance_security_id');
        }
        if (full && k.kind === 'certificate') sec.closed = true;
        continue;
      }

      if (k.kind === 'grant') {
        if (t.type === 'TX_EQUITY_COMPENSATION_EXERCISE' || t.type === 'TX_EQUITY_COMPENSATION_RELEASE') {
          const q = quantityOf('quantity');
          if (q == null) continue;
          const units = q / kOf;
          const quantity = Number(rec.quantity);
          if (exercised + cancelled + units > quantity + 1e-6) { row.error(`Exercises ${count(q)}; only ${count(roundShares((quantity - exercised - cancelled) * kOf))} are outstanding on ${t.date}`, 'over-granted', 'quantity', t.obj.quantity ?? null); continue; }
          const strike = Number(rec.strikePrice ?? 0);
          const price = kOf === 1 ? strike : Math.round(strike / kOf);
          // How it was exercised, as Kosmitor recorded it (the note), else for cash at the strike.
          const how = readNote(t.obj, 'TX_EQUITY_COMPENSATION_EXERCISE');
          const cost = how.amount ?? cents(units, strike);
          if (cost == null) { tooMuch('quantity'); continue; }
          k.entries.push(this.entry(k, 'EXERCISE', t.date, q, {
            shareClassId: k.classId, pricePerShare: price, amount: cost, memo: memo(`Exercise of ${k.label}`), resultingSecurityId: rs[0]?.id ?? null,
          }, t.ocfId, t.item));
          // The fair market value of that day: as recorded, else a release's price, else the latest valuation before it in that day's shares.
          let fmv = how.fmvAtExercise ?? null;
          if (fmv == null && t.type === 'TX_EQUITY_COMPENSATION_RELEASE' && t.obj.release_price != null) fmv = this.money(row, t.obj.release_price, 'release_price', 'micros');
          if (fmv == null) {
            const v = [...this.valuations].filter((x) => x.date <= t.date!).sort((a, b) => cmp(b.date, a.date))[0];
            fmv = v ? Math.round(v.price / this.kOf(v.date, t.date)) : 0;
          }
          const issuedShares = how.sharesIssued ?? rs.reduce((s, r) => s + Number(r.record?.quantity ?? 0), 0);
          const worth = cents(q, fmv);
          if (worth == null) { tooMuch('quantity'); continue; }
          k.exercises.push({
            id: id('exr'), companyId: this.companyId, awardId: k.id, stakeholderId: k.holder?.id ?? null, quantity: q, exerciseDate: t.date, method: how.method ?? 'CASH',
            strikePrice: price, fmvAtExercise: fmv, totalCost: cost, spread: Math.max(0, worth - cost), sharesIssued: issuedShares,
            issuanceId: rs[0]?.id ?? null, status: 'COMPLETED', notes: str(t.obj.consideration_text)?.slice(0, 500) ?? null, createdAt: this.stamp(t.item),
          });
          for (const r of rs) if (r.record && r.kind === 'certificate') r.record.sourceAwardId = k.id;
          exercised = roundShares(exercised + units);
          if (exercised >= roundShares(quantity - cancelled)) { status = 'EXERCISED'; ended = t; }
          row.summary.quantity = q;
          row.summary.amount = cost / 100;
          row.summary.detail = `${t.type === 'TX_EQUITY_COMPENSATION_RELEASE' ? 'Released' : 'Exercised'}${rs.length ? ` (${rs.map((r) => r.label).join(', ')})` : ''}`;
          continue;
        }
        if (t.type === 'TX_EQUITY_COMPENSATION_CANCELLATION' || t.type === 'TX_EQUITY_COMPENSATION_TRANSFER') {
          const q = quantityOf('quantity');
          if (q == null) continue;
          const units = q / kOf;
          const quantity = Number(rec.quantity);
          if (exercised + cancelled + units > quantity + 1e-6) { row.error(`Cancels ${count(q)}; only ${count(roundShares((quantity - exercised - cancelled) * kOf))} are outstanding on ${t.date}`, 'over-granted', 'quantity', t.obj.quantity ?? null); continue; }
          const transfer = t.type === 'TX_EQUITY_COMPENSATION_TRANSFER';
          // Options a leaver lost, which Kosmitor works out from their leaving date: not entered twice.
          const left = k.holder?.terminationDate ?? null;
          if (!transfer && cancelNote.lapse && left && left <= t.date) {
            row.base = 'skip';
            row.summary.quantity = q;
            row.summary.detail = cancelNote.lapse === 'window' ? 'Lapsed: exercise window closed' : 'Lapsed on leaving';
            row.info(`Kosmitor works this out itself from ${k.holder?.name ?? 'the holder'}'s leaving date, ${left}, so it is not entered in the ledger`, 'ocf-folded');
            continue;
          }
          const type = transfer ? 'CANCELLATION' : cancelType(true);
          if (transfer) row.info(`Kosmitor has no transfer of a grant: recorded as a cancellation, and the new grants as grants${resultText}`, 'ocf-transfer-as-cancellation');
          k.entries.push(this.entry(k, type, t.date, q, { memo: memo(transfer ? `Transferred${resultText}` : reason ?? 'Grant cancelled') }, t.ocfId, t.item));
          cancelled = roundShares(cancelled + units);
          if (roundShares(exercised + cancelled) >= quantity) { status = expires(type) ? 'EXPIRED' : 'CANCELLED'; ended = t; }
          row.summary.quantity = q;
          row.summary.detail = transfer ? `Transferred${resultText}` : type.charAt(0) + type.slice(1).toLowerCase();
          continue;
        }
        this.notMine(row, t, k);
        continue;
      }

      if (k.kind === 'warrant') {
        if (t.type === 'TX_WARRANT_EXERCISE') {
          const noted = readNote(t.obj, 'TX_WARRANT_EXERCISE').quantity;
          const fromResults = rs.reduce((s, r) => s + Number(r.record?.quantity ?? 0), 0);
          const q = noted ?? (fromResults > 0 ? fromResults : null);
          if (q == null) { row.error('The exercise says neither how many warrant shares were exercised nor which shares it issued', 'required', 'resulting_security_ids'); continue; }
          const units = q / kOf;
          const quantity = Number(rec.quantity);
          if (exercised + units > quantity + 1e-6) { row.error(`Exercises ${count(q)}; only ${count(roundShares((quantity - exercised) * kOf))} remain on ${t.date}`, 'over-granted', 'quantity'); continue; }
          const strike = Number(rec.strikePrice ?? 0);
          // A net exercise pays nothing: the note says how it was exercised and what was paid.
          const how = readNote(t.obj, 'TX_WARRANT_EXERCISE');
          const paid = how.amount ?? (how.method === 'NET_EXERCISE' ? 0 : cents(units, strike));
          if (paid == null) { tooMuch('quantity'); continue; }
          k.entries.push(this.entry(k, 'EXERCISE', t.date, q, {
            shareClassId: k.classId, pricePerShare: kOf === 1 ? strike : Math.round(strike / kOf), amount: paid,
            memo: memo(`${how.method ? `${how.method} exercise` : 'Exercise'} of warrant ${k.label}`), resultingSecurityId: rs[0]?.id ?? null,
          }, t.ocfId, t.item));
          exercised = roundShares(exercised + units);
          if (exercised >= quantity) { status = 'EXERCISED'; ended = t; }
          row.summary.quantity = q;
          row.summary.detail = `Exercised${rs.length ? ` (${rs.map((r) => r.label).join(', ')})` : ''}`;
          continue;
        }
        if (t.type === 'TX_WARRANT_CANCELLATION' || t.type === 'TX_WARRANT_TRANSFER') {
          const q = quantityOf('quantity');
          if (q == null) continue;
          const units = q / kOf;
          const quantity = Number(rec.quantity);
          const left = roundShares(quantity - exercised);
          if (units > left + 1e-6) { row.error(`Cancels ${count(q)}; only ${count(roundShares(left * kOf))} remain on ${t.date}`, 'over-granted', 'quantity'); continue; }
          const transfer = t.type === 'TX_WARRANT_TRANSFER';
          if (transfer) row.info(`Kosmitor has no transfer of a warrant: recorded as a cancellation, and the new warrants as warrants${resultText}`, 'ocf-transfer-as-cancellation');
          row.summary.quantity = q;
          if (units >= left - 1e-6 && !balanceSec) {
            const type = transfer ? 'CANCELLATION' : cancelType(true) === 'EXPIRATION' ? 'EXPIRATION' : 'CANCELLATION';
            k.entries.push(this.entry(k, type, t.date, q, { shareClassId: k.classId, memo: memo(transfer ? `Transferred${resultText}` : reason ?? 'Warrant cancelled') }, t.ocfId, t.item));
            status = type === 'EXPIRATION' ? 'EXPIRED' : 'CANCELLED';
            ended = t;
            row.summary.detail = transfer ? `Transferred${resultText}` : type === 'EXPIRATION' ? 'Expired' : 'Cancelled';
          } else {
            // Part of a warrant cancelled: the count is corrected from that date.
            k.entries.push(this.entry(k, 'CORRECTION', t.date, -q, {
              field: 'quantity', reason: `Part of the warrant ${transfer ? 'transferred' : 'cancelled'} (OCF ${ref(t.ocfId)})`, memo: memo(transfer ? `Transferred${resultText}` : reason ?? 'Part of the warrant cancelled'),
            }, t.ocfId, t.item));
            rec.quantity = roundShares(quantity - units);
            row.info('Kosmitor records part of a warrant cancelled as a correction of its share count, from this date', 'ocf-folded');
            row.summary.detail = transfer ? `Part transferred${resultText}` : 'Part cancelled';
            if (balanceSec) sec.closed = true;
          }
          continue;
        }
        this.notMine(row, t, k);
        continue;
      }

      // SAFEs and notes.
      if (t.type === 'TX_CONVERTIBLE_CONVERSION' || t.type === 'TX_CONVERTIBLE_CANCELLATION' || t.type === 'TX_CONVERTIBLE_TRANSFER') {
        if (balanceSec) { row.error('Converts, cancels or transfers only part of the instrument; Kosmitor settles a SAFE or note whole', 'ocf-unsupported', 'balance_security_id', balance); continue; }
        if (t.type === 'TX_CONVERTIBLE_CONVERSION') {
          const shares = rs.reduce((s, r) => s + Number(r.record?.quantity ?? 0), 0);
          const cls = rs[0]?.classId ?? null;
          k.entries.push(this.entry(k, 'CONVERSION', t.date, rs.length ? shares : null, {
            shareClassId: cls, pricePerShare: firstPrice, amount: Number(rec.principal), memo: memo(reason ?? 'Converted'), resultingSecurityId: rs[0]?.id ?? null,
          }, t.ocfId, t.item));
          status = 'CONVERTED';
          rec.convertedOn = t.date;
          rec.convertedIntoShareClassId = cls;
          ended = t;
          row.summary.quantity = rs.length ? shares : null;
          row.summary.amount = Number(rec.principal) / 100;
          row.summary.detail = `Converted${rs.length ? ` into ${rs.map((r) => r.label).join(', ')}` : ''}`;
          continue;
        }
        const transfer = t.type === 'TX_CONVERTIBLE_TRANSFER';
        const settled = readNote(t.obj, 'TX_CONVERTIBLE_CANCELLATION');
        const repaid = !transfer && (settled.type ? settled.type === 'REPAYMENT' : /repa(id|y)/i.test(reason ?? ''));
        // The cash repaid, interest included: the note's, else what the reason says ("Repaid 260000.00 USD"), else the amount cancelled.
        const said = /^Repaid (\d+(?:\.\d+)?) ([A-Z]{3})\b/.exec(reason ?? '');
        const saidCents = said && said[2] === this.s.currency ? C.scaleDecimal(said[1], 2)?.value : undefined;
        const amount = repaid ? settled.repaid ?? saidCents ?? (t.obj.amount != null ? this.money(row, t.obj.amount, 'amount', 'cents') : Number(rec.principal)) : null;
        if (transfer) row.info(`Kosmitor has no transfer of a SAFE or note: recorded as a cancellation, and the new ones as their own${resultText}`, 'ocf-transfer-as-cancellation');
        k.entries.push(this.entry(k, repaid ? 'REPAYMENT' : 'CANCELLATION', t.date, null, { amount, memo: memo(transfer ? `Transferred${resultText}` : reason ?? 'Cancelled') }, t.ocfId, t.item));
        status = repaid ? 'REPAID' : 'CANCELLED';
        ended = t;
        row.summary.amount = amount != null ? amount / 100 : null;
        row.summary.detail = transfer ? `Transferred${resultText}` : repaid ? 'Repaid' : 'Cancelled';
        continue;
      }
      this.notMine(row, t, k);
    }

    // MFN elections from the note.
    if (k.kind === 'convertible' && rec) {
      for (const e of readNote(k.secs[0].issue.obj, 'TX_CONVERTIBLE_ISSUANCE').mfnElections ?? []) {
        const adopted = this.secs.get(e.adoptedSecurityId)?.krow;
        if (!adopted || adopted.kind !== 'convertible') { k.row.warn(`The MFN election of ${e.date} adopts ${ref(e.adoptedSecurityId)}, which is not a SAFE or note of the package: it is not imported`, 'ocf-unknown-reference'); continue; }
        // The election names the adopted instrument: it goes in with it, or waits for it.
        if (adopted.family !== k.family) k.row.deps.add(adopted.row);
        k.entries.push(this.entry(k, 'MFN_ELECTION', e.date, null, { adoptedSecurityId: adopted.id, memo: `Elected the terms of ${adopted.label} (OCF ${ref(k.secs[0].ocfId)})` }, `mfn:${e.date}:${e.adoptedSecurityId}`));
        k.row.info(`MFN election of ${e.date}: the terms of ${adopted.label}`, 'ocf-folded');
      }
    }

    if (!rec) return;
    if (k.kind === 'certificate') { rec.quantity = roundShares(remaining); rec.status = status; }
    else if (k.kind === 'rsa' || k.kind === 'grant') { rec.exercisedQuantity = exercised; rec.cancelledQuantity = cancelled; rec.status = status; }
    else if (k.kind === 'warrant') { rec.exercisedQuantity = exercised; rec.status = status; }
    else rec.status = status;
    k.row.summary[k.kind === 'convertible' ? 'status' : 'state'] = status;
  }

  /**
   * A certificate a transfer created names the certificate it came from, as the
   * transfer route writes it ("Transferred from certificate CS-2"), and keeps the grant
   * its shares were exercised from: the cap table traces the price paid in and the
   * original issue date through it. Parents first, without recursion: a chain of
   * transfers may be thousands long.
   */
  private transferNotes(): void {
    const done = new Set<KRow>();
    for (const start of this.krows) {
      const chain: KRow[] = [];
      for (let k: KRow | null = start; k && !done.has(k); k = k.parent?.krow ?? null) chain.push(k);
      for (let i = chain.length - 1; i >= 0; i--) {
        const k = chain[i];
        done.add(k);
        const p = k.parent;
        // Notes that name the security this one came from by its id in the package ("Issued on exercise of warrant
        // <id>") name its Kosmitor row instead.
        const from = p?.krow.secs[0]?.ocfId;
        if (p && from && k.record && typeof k.record.notes === 'string' && k.record.notes.includes(from)) k.record.notes = k.record.notes.split(from).join(p.krow.id);
        if (!p || k.kind !== 'certificate' || !k.record || p.krow.kind !== 'certificate' || !p.krow.record) continue;
        if (p.tx.type !== 'TX_STOCK_TRANSFER' && p.tx.type !== 'TX_STOCK_REISSUANCE') continue;
        k.record.notes = `Transferred from certificate ${String(p.krow.record.certificateNo ?? p.krow.id)}`;
        if (p.krow.record.sourceAwardId) k.record.sourceAwardId = p.krow.record.sourceAwardId;
      }
    }
  }

  /** An event a security of this kind cannot have. */
  private notMine(row: Row, t: Tx, k: KRow): void {
    if (/_ACCEPTANCE$/.test(t.type)) {
      const why = lookup(NOT_IMPORTED, t.type) ?? 'Kosmitor records no acceptance of it';
      row.base = 'skip';
      row.info(`Not imported: ${why}`, 'ocf-not-imported');
      this.skipped(t.type, why);
      return;
    }
    if (t.type === 'TX_STOCK_PLAN_RETURN_TO_POOL') {
      const why = lookup(NOT_IMPORTED, t.type)!;
      row.base = 'skip';
      row.info(`Not imported: ${why}`, 'ocf-not-imported');
      this.skipped(t.type, why);
      return;
    }
    if (!/^TX_/.test(t.type) || !KNOWN_TX.has(t.type)) {
      row.base = 'skip';
      row.info(`Not imported: Kosmitor does not know ${t.type}`, 'ocf-not-imported');
      this.skipped(t.type, 'a transaction Kosmitor does not know');
      return;
    }
    row.error(`A ${t.type} cannot happen to ${k.kind === 'rsa' ? 'a restricted stock award' : `a ${SUMMARY_KIND[k.section]}`}`, 'ocf-unsupported', 'object_type', t.type);
  }

  // -------------------------------------------------------------------------
  // Already there
  // -------------------------------------------------------------------------

  private recordedFor(k: KRow): Recorded {
    const c = this.s.company;
    return k.kind === 'certificate' ? c.certificates : k.kind === 'rsa' || k.kind === 'grant' ? c.awards : k.kind === 'warrant' ? c.warrants : c.convertibles;
  }
  private tableFor(k: KRow): Set<string> {
    const s = this.s.securityIds;
    return k.kind === 'certificate' ? s.issuances : k.kind === 'rsa' || k.kind === 'grant' ? s.awards : k.kind === 'warrant' ? s.warrants : s.convertibles;
  }

  /**
   * Each family is wholly new or wholly there. Its root is found on the cap table by
   * id (rule 1) or by its number and contents, as a spreadsheet row is (rule 2); then
   * each of its events must be an entry of that record, and each row it created must
   * be on the cap table too. A family found only in part writes nothing, and says what
   * differs.
   */
  private matchFamilies(): void {
    const claims = new Map<Recorded, Claims>();
    const labels = new Map<Recorded, Set<string>>();
    // A row's own number, if it has one: a warrant has none, nor a security whose custom_id was made up from its id.
    const numberOf = (k: KRow): string | null => (k.kind === 'warrant' || !k.numbered ? null : k.label);
    for (const k of this.krows) {
      const r = this.recordedFor(k);
      const n = numberOf(k);
      if (n) labels.set(r, (labels.get(r) ?? new Set()).add(nameKey(n)));
    }
    const claimsOf = (k: KRow) => {
      const r = this.recordedFor(k);
      let c = claims.get(r);
      if (!c) { c = new Claims(r, labels.get(r) ?? new Set()); claims.set(r, c); }
      return c;
    };
    const printOf = (k: KRow): string | null => {
      const rec = k.record;
      if (!rec || !k.holder) return null;
      const holder = k.holder.id;
      if (k.kind === 'certificate') return issuanceFingerprint(holder, String(rec.shareClassId), Number(rec.quantity), String(rec.issueDate));
      if (k.kind === 'rsa' || k.kind === 'grant') return awardFingerprint(holder, String(rec.type), Number(rec.quantity), String(rec.grantDate));
      if (k.kind === 'warrant') return warrantFingerprint(holder, String(rec.shareClassId), Number(rec.quantity), String(rec.issueDate), Number(rec.strikePrice));
      return convertibleFingerprint(holder, String(rec.instrument), Number(rec.principal), String(rec.issueDate));
    };
    const whatOf = (k: KRow): string => String(k.kind === 'certificate' || k.kind === 'warrant' ? k.record?.shareClassId : k.kind === 'convertible' ? k.record?.instrument : k.record?.type);
    /**
     * The record a row is: by id when the package came from this company, else by number and
     * contents as a spreadsheet row is found. A number on file for the same holder, class and
     * date with another count is that record too, changed since: the family then differs.
     */
    const find = (k: KRow): { match: 'existing' | 'clash'; record: OnFile } | null => {
      if (this.sameCompany && this.tableFor(k).has(k.secs[0].ocfId)) {
        const onFile = this.onFileById(this.recordedFor(k)).get(k.secs[0].ocfId);
        if (onFile) return { match: 'existing', record: onFile };
      }
      const fingerprint = k.holder?.created || this.classCreated(k) ? null : printOf(k);
      const found = claimsOf(k).find(numberOf(k), fingerprint);
      if (found?.match === 'clash' && k.holder && !k.holder.created && found.record.near === nearKey(k.holder.id, k.date) && found.record.what === whatOf(k)) {
        return { match: 'existing', record: found.record };
      }
      return found;
    };
    const kind = (x: KRow) => `${SUMMARY_KIND[x.section].charAt(0).toUpperCase()}${SUMMARY_KIND[x.section].slice(1)}`;
    for (const k of this.krows) {
      if (k.parent || !k.family || !k.record) continue;
      const fam = k.family;
      const found = find(k);
      if (found?.match === 'clash') { k.row.error(`${kind(k)} number "${k.label}" is on the cap table with different details`, 'number-taken', 'custom_id', k.label); continue; }
      if (!found) {
        // New: its other rows may still clash with a number on file, or look like a record nothing matched.
        for (const x of fam.krows.slice(1)) {
          const n = numberOf(x);
          const f = n ? claimsOf(x).find(n, null) : null;
          if (f?.match === 'clash') x.row.error(`${kind(x)} number "${x.label}" is on the cap table with different details`, 'number-taken', 'custom_id', x.label);
        }
        if (k.holder && !k.holder.created) {
          const like = claimsOf(k).unmatched(nearKey(k.holder.id, k.date));
          if (like.length) {
            k.row.warn(`The cap table already has a ${SUMMARY_KIND[k.section]} for ${k.holder.name} dated ${k.date}${like[0].label ? ` (${like[0].label})` : ''} that nothing in the package matched — if this is that one, leave it out and correct it on its page instead`,
              'similar-on-record', 'custom_id', k.label);
          }
        }
        continue;
      }
      k.matched = found.record;
      // Every event must be an entry of the record, and every other row of the family on the cap table too.
      let differs: string | null = null;
      const members: KRow[] = [k];
      for (const x of fam.krows.slice(1)) {
        const f = find(x);
        if (f?.match !== 'existing') { differs ??= `${x.label}, which a ${x.parent?.tx.type.replace(/^TX_(STOCK_|EQUITY_COMPENSATION_|WARRANT_|CONVERTIBLE_)?/, '').toLowerCase().replace(/_/g, ' ') ?? 'n event'} of ${k.label} created, is not on the cap table`; continue; }
        x.matched = f.record;
        members.push(x);
      }
      for (const x of members) {
        const onFile = [...(this.s.ledger.get(x.matched!.id ?? '') ?? [])];
        for (const e of x.entries) {
          if (e.type === 'ISSUANCE' || e.type === 'GRANT') continue;
          // An export's dating of a state the ledger never dated matches the record itself.
          if (this.sameCompany && e.ocfTx && /\.(closed|exercised|cancelled)$/.test(e.ocfTx)) continue;
          const at = onFile.findIndex((o) => (this.sameCompany && e.ocfTx != null && o.id === e.ocfTx)
            || (sameType(o.type, e.type) && o.date === e.date && (o.quantity == null ? e.quantity == null : e.quantity != null && near(o.quantity, e.quantity))));
          if (at < 0) { differs = `The cap table's ${x.label} has no ${e.type.toLowerCase().replace(/_/g, ' ')} on ${e.date}`; break; }
          onFile.splice(at, 1);
        }
        if (differs) break;
        const print = x.holder && !x.holder.created && !this.classCreated(x) ? printOf(x) : null;
        if (print && x.matched!.fingerprint !== print) differs ??= `The cap table's ${x.label} differs from the package (${x.kind === 'convertible' ? 'its amount' : 'its share count'})`;
      }
      fam.existing = differs ? 'differs' : 'yes';
      fam.differs = differs;
    }
  }

  private readonly byRecordId = new Map<Recorded, Map<string, OnFile>>();
  /** The records of a kind by their row id. */
  private onFileById(r: Recorded): Map<string, OnFile> {
    let m = this.byRecordId.get(r);
    if (!m) {
      m = new Map();
      for (const list of r.byFingerprint.values()) for (const x of list) if (x.id) m.set(x.id, x);
      this.byRecordId.set(r, m);
    }
    return m;
  }
  /** A certificate or warrant of a class this import creates: no record on file can be it. */
  private classCreated(k: KRow): boolean {
    if (k.kind !== 'certificate' && k.kind !== 'warrant') return false;
    return !!k.classId && [...this.classes.values()].some((c) => c.id === k.classId && c.created);
  }

  // -------------------------------------------------------------------------
  // Left out, and waiting
  // -------------------------------------------------------------------------

  private allRows(): Row[] { return OCF_SECTIONS.flatMap((s) => this.rows.get(s)!); }

  private exclude(): void {
    for (const [section, items] of Object.entries(this.run.exclude) as [OcfSection, number[]][]) {
      const set = new Set(items);
      for (const r of this.rows.get(section) ?? []) if (set.has(r.item)) r.excluded = true;
    }
  }

  /**
   * Rows are left out with, or wait for, the rows they need and the rest of their family:
   * a work list from the rows left out and the rows with errors of their own, each edge
   * followed once, so a family of thousands costs what it has.
   */
  private cascade(): void {
    const rows = this.allRows();
    const live = (r: Row) => r.base !== 'existing' && !(r.family && r.family.existing !== 'no');
    const out = (r: Row): boolean => r.excluded || !!r.excludedWith;
    const broken = (r: Row): boolean => !out(r) && r.base !== 'skip' && (r.ownError || !!r.waitsFor);
    const dependents = new Map<Row, Row[]>();
    for (const r of rows) for (const d of r.deps) { const list = dependents.get(d); if (list) list.push(r); else dependents.set(d, [r]); }
    const queue: Row[] = rows.filter((r) => live(r) && (r.excluded || (r.ownError && r.base !== 'skip')));
    const familyOut = new Set<Family>(), familyBroken = new Set<Family>();
    for (let at = 0; at < queue.length; at++) {
      const r = queue[at];
      const leftOut = out(r);
      if (!leftOut && !broken(r)) continue;
      const cause = r.excluded ? r : r.excludedWith ?? r;
      const reach = [...(dependents.get(r) ?? [])];
      const fam = r.family;
      if (fam && !(leftOut ? familyOut : familyBroken).has(fam)) {
        (leftOut ? familyOut : familyBroken).add(fam);
        reach.push(...fam.rows);
      }
      for (const m of reach) {
        if (m === r || !live(m) || out(m)) continue;
        if (leftOut) { m.excludedWith = cause; queue.push(m); continue; }
        if (m.base === 'skip' || m.ownError || m.waitsFor) continue;
        m.waitsFor = r;
        queue.push(m);
      }
    }
  }

  /** Each row's outcome and the messages it shows. */
  private settle(): void {
    for (const r of this.allRows()) {
      const fam = r.family;
      const retracted = fam?.retracted ?? null;
      if (r.excluded) { r.outcome = 'excluded'; r.messages = [{ level: 'info', text: 'Left out by you', code: 'excluded' }]; continue; }
      if (r.excludedWith) { r.outcome = 'excluded'; r.messages = [{ level: 'info', text: `Left out with ${r.excludedWith.named}`, code: 'ocf-excluded-with' }]; continue; }
      if (retracted) { r.outcome = 'skip'; r.messages = [{ level: 'info', text: `Not imported: ${retracted}`, code: 'ocf-not-imported' }]; continue; }
      if (fam && fam.existing !== 'no') {
        r.outcome = 'existing';
        r.messages = [{ level: 'info', text: 'Already on the cap table — skipped', code: 'already-imported' }];
        if (fam.existing === 'differs' && fam.krows[0]?.row === r) {
          r.messages.push({ level: 'warning', code: 'differs-from-record', text: `${fam.differs} — nothing of it is changed: record it on the certificate's page if the package is right` });
        }
        continue;
      }
      if (r.base === 'existing') {
        r.outcome = 'existing';
        r.messages = [...r.messages.filter((m) => m.code === 'already-imported' || m.code === 'up-to-date').slice(0, 1), ...r.notes];
        continue;
      }
      if (r.ownError) { r.outcome = 'error'; continue; }
      if (r.waitsFor) {
        r.outcome = 'error';
        r.messages.unshift({ level: 'error', text: `Waits for ${r.waitsFor.named}`, code: 'ocf-depends' });
        continue;
      }
      r.outcome = r.base === 'skip' ? 'skip' : r.base === 'update' ? 'update' : 'add';
    }
  }

  // -------------------------------------------------------------------------
  // The answer, and what to write
  // -------------------------------------------------------------------------

  private finish(): OcfPrepared {
    const written = (r: Row | null | undefined) => !!r && (r.outcome === 'add' || r.outcome === 'update');
    const errors = this.allRows().some((r) => r.outcome === 'error');
    const blocked = errors && !this.run.skipRowsWithErrors;
    const imported = EMPTY_IMPORTED();
    const plan: OcfWritePlan = {
      companyFill: {}, stakeholders: [], stakeholderUpdates: [], designations: [], classes: [], classUpdates: [], schedules: [], pools: [],
      poolAdjustments: [], valuations: [], splits: [], splitEntries: [], issuances: [], awards: [], warrants: [], convertibles: [], exercises: [], transactions: [],
    };

    // People, classes, plans, valuations, splits and plan adjustments, as their rows say.
    for (const [row, rec] of this.stakeholderRecords) if (written(row)) plan.stakeholders.push(rec);
    for (const [row, u] of this.stakeholderUpdates) if (written(row)) plan.stakeholderUpdates.push(u);
    const personId = (ocfId: string): string | null => {
      const p = this.people.get(ocfId);
      if (!p) return null;
      return p.created ? (written(p.row) ? p.id : null) : p.id;
    };
    // A seat designated by another stakeholder, for the people the import creates.
    for (const d of this.designations) {
      if (!this.stakeholderRecords.has(d.row) || !written(d.row)) continue;
      const self = personId(d.row.ocfId), by = personId(d.ocfBy);
      if (self && by) plan.designations.push({ id: self, designatedBy: by });
    }
    for (const [row, rec] of this.classRecords) if (written(row)) plan.classes.push(rec);
    for (const [row, u] of this.classUpdates) if (written(row)) plan.classUpdates.push(u);
    for (const [row, rec] of this.poolRecords) if (written(row)) plan.pools.push(rec);
    for (const [row, rec] of this.adjustmentRecords) if (written(row)) plan.poolAdjustments.push(rec);
    for (const [row, rec] of this.valuationRecords) if (written(row)) plan.valuations.push(rec);
    for (const [row, s] of this.splitRecords) if (written(row)) { plan.splits.push(s.split); plan.splitEntries.push(s.entry); }

    // Securities, with what they need that only they bring: their own schedules and the planless plan.
    const schedulesUsed = new Set<string>();
    let planlessSize = 0;
    for (const k of this.krows) {
      if (!written(k.row) || !k.record) continue;
      const table = k.kind === 'certificate' ? plan.issuances : k.kind === 'warrant' ? plan.warrants : k.kind === 'convertible' ? plan.convertibles : plan.awards;
      table.push(k.record);
      if (k.scheduleKey) schedulesUsed.add(k.scheduleKey);
      if (k.poolKey === 'planless') planlessSize += Number(k.record.quantity ?? 0);
      plan.exercises.push(...k.exercises);
      for (const e of [...k.entries, ...(k.companion?.entries ?? [])]) {
        const { ocfTx: _o, ...rest } = e;
        void _o;
        plan.transactions.push(rest);
        if (e.type !== 'ISSUANCE' && e.type !== 'GRANT') imported.events++;
      }
      // The restricted stock award a certificate is the shares of goes in with it.
      if (k.companion) {
        plan.awards.push(k.companion.record);
        if (k.companion.scheduleKey) schedulesUsed.add(k.companion.scheduleKey);
      }
    }
    for (const [key, s] of this.schedules) {
      if (!s.record) continue;
      const own = key.startsWith('sec:') || key === 'fully-vested' || key.includes('#');
      if (own ? schedulesUsed.has(key) : written(s.row) || schedulesUsed.has(key)) plan.schedules.push(s.record);
    }
    // The terms rows that create a schedule only for securities that are not imported still create it.
    if (this.planlessPool && !this.planlessPool.existingId && planlessSize > 0) {
      this.planlessPool.record.authorized = planlessSize;
      plan.pools.push(this.planlessPool.record);
    }

    // The company's own fields, from the issuer: the empty ones, and a new company's defaults (its creation date as the
    // incorporation date, the default legal name and jurisdiction) while its cap table is empty. Into a company that is
    // not the issuer, only when the person says so (options.ocfCompanyFill).
    const companyFill: { field: string; value: string }[] = [];
    const issuer = isObj(this.pkg.manifest.issuer) ? this.pkg.manifest.issuer : {};
    const issuerNote = readNote(issuer, 'ISSUER');
    const names = [str(this.s.row.name), str(this.s.row.legal_name)].filter((n): n is string => !!n).map(nameKey);
    const theirs = [str(issuer.legal_name), str(issuer.dba)].filter((n): n is string => !!n);
    const otherIssuer = theirs.length > 0 && !theirs.some((n) => names.includes(nameKey(n)));
    const fresh = !this.s.hasSecurities && !this.s.stakeholders.size;
    const defaults = config().company;
    const placeholder: Record<string, (v: string) => boolean> = {
      legalName: (v) => fresh && !!str(this.s.row.name) && v === `${str(this.s.row.name)}${defaults.legalNameSuffix}`,
      incorporationDate: (v) => fresh && v === this.s.createdOn,
      jurisdiction: (v) => fresh && v === defaults.jurisdiction,
    };
    const wanted: { field: string; label: string; value: string }[] = [];
    const fill = (field: string, label: string, value: string | null) => {
      if (!value) return;
      const now = str(this.s.row[field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]);
      if (now && !(Object.hasOwn(placeholder, field) && placeholder[field](now))) return;
      if (now === value) return;
      wanted.push({ field, label, value });
    };
    fill('legalName', 'legal name', str(issuer.legal_name)?.slice(0, 200) ?? null);
    fill('incorporationDate', 'incorporation date', typeof issuer.formation_date === 'string' && C.isCalendarDate(issuer.formation_date) ? issuer.formation_date : null);
    fill('jurisdiction', 'jurisdiction', issuerNote.jurisdiction?.slice(0, 120) ?? C.jurisdictionOf(issuer.country_of_formation, issuer.country_subdivision_of_formation));
    const ein = (Array.isArray(issuer.tax_ids) ? issuer.tax_ids : []).filter(isObj).find((t) => t.country === 'US' || t.country == null);
    fill('ein', 'EIN', ein ? str(ein.tax_id)?.slice(0, 40) ?? null : null);
    const address = isObj(issuer.address) ? issuer.address : null;
    fill('address', 'address', (address ? [str(address.street_suite), str(address.city), [str(address.country_subdivision), str(address.postal_code)].filter(Boolean).join(' ') || null]
      .filter(Boolean).join(', ').slice(0, 500) || null : null) ?? issuerNote.address?.slice(0, 500) ?? null);
    const applies = this.run.companyFill ?? !otherIssuer;
    for (const w of wanted) {
      companyFill.push({ field: w.label, value: w.value });
      if (applies) plan.companyFill[w.field] = w.value;
    }
    if (otherIssuer) {
      this.notices.push({ code: 'ocf-other-issuer', level: 'warning', text: `This package is the cap table of ${theirs[0]}, not of ${str(this.s.row.name) ?? 'this company'}. Check you are importing into the right company.` });
    }

    imported.stakeholders = plan.stakeholders.length;
    imported.updated.stakeholders = plan.stakeholderUpdates.length;
    imported.shareClasses = plan.classes.length;
    imported.vestingSchedules = plan.schedules.length;
    imported.pools = plan.pools.length;
    imported.poolAdjustments = plan.poolAdjustments.length;
    imported.valuations = plan.valuations.length;
    imported.stockSplits = plan.splits.length;
    imported.issuances = plan.issuances.length;
    imported.awards = plan.awards.length;
    imported.warrants = plan.warrants.length;
    imported.convertibles = plan.convertibles.length;

    // The sections, in the order they are applied.
    const sections: WorkbookSheetResult[] = [];
    for (const section of OCF_SECTIONS) {
      const rows = this.rows.get(section)!.sort((a, b) => a.item - b.item);
      if (!rows.length) continue;
      const preview: PreviewRow[] = rows.map((r) => {
        const status: PreviewRow['status'] = r.outcome === 'error' ? 'error' : r.messages.some((m) => m.level === 'warning') ? 'warning' : 'ok';
        const action: PreviewRow['action'] = r.outcome === 'add' ? 'create' : r.outcome === 'update' ? 'update' : 'skip';
        const object = r.object ?? SECTION_OBJECT[section];
        return { row: r.item, status, action, outcome: r.outcome, summary: r.summary, messages: r.messages, ocfId: r.ocfId, ...(object ? { object } : {}) };
      });
      const errorsHere = preview.filter((r) => r.status === 'error').length;
      const skipped = preview.filter((r) => r.status !== 'error' && r.action === 'skip').length;
      const warnings = preview.filter((r) => r.status === 'warning' && r.action !== 'skip').length;
      const counts: ImportCounts = {
        total: preview.length, ok: preview.length - errorsHere - warnings - skipped, warnings, errors: errorsHere, skipped, willImport: preview.length - errorsHere - skipped,
        existing: preview.filter((r) => r.outcome === 'existing').length, excluded: preview.filter((r) => r.outcome === 'excluded').length,
      };
      const creates = {
        stakeholders: section === 'stakeholders' ? plan.stakeholders.map((s) => String(s.name)) : [],
        shareClasses: section === 'shareClasses' ? plan.classes.map((c) => String(c.name)) : [],
        vestingSchedules: section === 'vesting' ? plan.schedules.map((s) => String(s.name)) : [],
        pools: section === 'plans' ? plan.pools.map((p) => String(p.name)) : [],
      };
      sections.push({
        sheetName: SECTION_TITLES[section], file: this.run.file, kind: section, blocked: blocked && errorsHere > 0,
        dateOrder: 'auto', numberFormat: 'en', columnsNotImported: [],
        preview: { kind: section, rows: preview, counts, creates, notices: [] },
      });
    }

    const notImported = [...this.notImported.values()];
    for (const f of this.pkg.files) {
      if (f.fileType === 'OCF_FINANCINGS_FILE') notImported.push({ what: 'Financings', count: f.items, reason: 'Kosmitor keeps financing details with each security' });
      if (f.fileType === 'OCF_DOCUMENTS_FILE') notImported.push({ what: 'Documents', count: f.items, reason: 'Kosmitor keeps documents in the vault: upload them there' });
    }
    const createdClasses = plan.classes.map((c) => String(c.id));
    const newPeople = this.newPeople.filter((p) => {
      const row = this.people.get(p.ocfId!)?.row;
      return row && (row.outcome === 'add' || row.outcome === 'error');
    });
    return {
      sections, blocked, plan, imported: blocked ? EMPTY_IMPORTED() : imported, newPeople, createdClasses,
      summary: {
        file: this.run.file, version: this.pkg.version, issuer: this.pkg.issuer, asOf: this.pkg.asOf, generatedAt: this.pkg.generatedAt,
        files: this.pkg.files.map(({ content: _c, ...f }) => f), notices: [...this.pkg.notices, ...this.notices], notImported, companyFill,
        companyFillAsked: otherIssuer && companyFill.length > 0, companyFillApplied: applies && companyFill.length > 0,
        classUpdates: plan.classUpdates.map((u) => String(this.s.classes.find((c) => c.id === u.id)?.name ?? u.id)),
      },
    };
  }
}

/** Transaction types of OCF 1.2.0 the import knows, read or not. */
const KNOWN_TX = new Set([
  'TX_STOCK_ISSUANCE', 'TX_STOCK_TRANSFER', 'TX_STOCK_REPURCHASE', 'TX_STOCK_CANCELLATION', 'TX_STOCK_CONVERSION', 'TX_STOCK_REISSUANCE', 'TX_STOCK_RETRACTION', 'TX_STOCK_ACCEPTANCE',
  'TX_EQUITY_COMPENSATION_ISSUANCE', 'TX_EQUITY_COMPENSATION_EXERCISE', 'TX_EQUITY_COMPENSATION_RELEASE', 'TX_EQUITY_COMPENSATION_CANCELLATION', 'TX_EQUITY_COMPENSATION_TRANSFER',
  'TX_EQUITY_COMPENSATION_RETRACTION', 'TX_EQUITY_COMPENSATION_ACCEPTANCE',
  'TX_WARRANT_ISSUANCE', 'TX_WARRANT_EXERCISE', 'TX_WARRANT_CANCELLATION', 'TX_WARRANT_TRANSFER', 'TX_WARRANT_RETRACTION', 'TX_WARRANT_ACCEPTANCE',
  'TX_CONVERTIBLE_ISSUANCE', 'TX_CONVERTIBLE_CONVERSION', 'TX_CONVERTIBLE_CANCELLATION', 'TX_CONVERTIBLE_TRANSFER', 'TX_CONVERTIBLE_RETRACTION', 'TX_CONVERTIBLE_ACCEPTANCE',
  'TX_STOCK_CLASS_SPLIT', 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT', 'TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT', 'TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT',
  'TX_STOCK_PLAN_POOL_ADJUSTMENT', 'TX_STOCK_PLAN_RETURN_TO_POOL', 'TX_VESTING_START', 'TX_VESTING_EVENT', 'TX_VESTING_ACCELERATION',
]);
