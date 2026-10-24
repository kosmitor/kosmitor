/**
 * Import engine: turns mapped spreadsheet rows into cap table records.
 *
 * `prepareImport` resolves every row against the company — matching
 * stakeholders by email then name, share classes and vesting schedules by
 * name or shorthand — and reports per-row errors and warnings without writing
 * anything. `commitImport` runs the same preparation and writes the plan in
 * one transaction, so a spreadsheet either lands completely or not at all.
 *
 * A row that is already on the cap table — the same holder, class, shares and
 * date for a certificate, the same holder, type, shares and date for a grant,
 * the same holder, instrument, amount and date for a SAFE or note, numbered or
 * not — is recognised and skipped, so a file can be imported again after it was
 * fixed and only what is missing lands. Each record answers for one row: a file
 * with two identical rows needs two such records before both are "already
 * there". A row that matches a record but differs from it in what the match
 * does not look at (a price, a cap) says so and changes nothing, and an added
 * row that looks like a record no row matched (the same holder, class and
 * date) says that too, so a correction is never applied twice or silently.
 * Every message carries a `code` (and the `field` and raw `value` it is about),
 * so a page can group the rows one answer fixes; the texts themselves are
 * written here and shown as they are.
 */
import { randomUUID, createHash } from 'node:crypto';
import { all, insert, insertMany, update, transaction, concurrently } from '../db.ts';
import {
  IMPORT_KINDS, coerceText, coerceNumber, coerceMoney, coercePrice, coercePercent, coerceBoolean,
  coerceDate, coerceAwardType, coerceInstrument, coerceConvertibleStatus, coerceStakeholderType, coerceRelation,
  coerceCompounding, guessStakeholderType, parseVestingShorthand, dateParts, detectNumberFormat, isAmbiguousNumber,
  type Cell, type ImportKind, type DateOrder, type FieldSpec, type NumberFormat, type Coerced, type NumberFormatReading,
} from './values.ts';
import { config } from '../config.ts';
import { loadCompanyData } from '../store.ts';
import { usd, perShare } from '../templates.ts';
import { roundShares, today, addMonths, computeCapTable, INSTRUMENT_NAMES } from '@kosmitor/core';
import type { OcfSection, OcfSummary, OcfRun } from '../ocf/read.ts';

/** The relationships a stakeholder can have, as options.relationships takes them. */
export const RELATIONS = ['FOUNDER', 'EMPLOYEE', 'FORMER_EMPLOYEE', 'ADVISOR', 'CONTRACTOR', 'INVESTOR', 'BOARD_MEMBER', 'OTHER'] as const;

export interface ImportOptions {
  /** How to read a date like 03/04/2024. 'auto' (the default) decides once per file, from a date only one order can read. */
  dateOrder?: DateOrder;
  /** How to read a number like 1.000 or 1,000: 'en' (1,234.56) or 'eu' (1.234,56). Without it the sheet's own values decide. */
  numberFormat?: NumberFormat;
  createMissingStakeholders?: boolean;
  createMissingShareClasses?: boolean;
  createMissingPools?: boolean;
  /** The schedule for grants that name none. Certificates do not take it: see certificateVestingScheduleId. */
  defaultVestingScheduleId?: string | null;
  /** The schedule for certificates that name none, which makes them restricted stock. Without it they are fully vested. */
  certificateVestingScheduleId?: string | null;
  defaultPoolId?: string | null;
  /** A plan to draw grants that name none from, by name: an existing plan, or a new one created with this name. */
  defaultPoolName?: string | null;
  skipRowsWithErrors?: boolean;
  /** Spreadsheet row numbers (PreviewRow.row) to leave out of this import. */
  excludeRows?: number[];
  /** Rows the file has below the header, when the page was sent only the first of them: the review says so. */
  fileRowCount?: number | null;
  /** The relationship of a person the import creates without one, by NewPerson.key: their email, or their name in lower case. */
  relationships?: Record<string, string>;
  fileName?: string | null;
}

/** A field reads from a column index, or takes the same fixed value on every row. */
export type MappingValue = number | { value: string } | null;

export interface ImportRequest {
  kind: ImportKind;
  headers: Cell[];
  rows: Cell[][];
  mapping: Record<string, MappingValue>;
  /** 1-based spreadsheet row number of the header, so messages cite real rows. */
  headerRowNumber?: number;
  options?: ImportOptions;
}

/**
 * What a message is about, so a page can group the rows one answer fixes and
 * point at the cell. The list is in docs/importing.md.
 */
export type MessageCode =
  | 'required' | 'bad-date' | 'bad-number' | 'bad-value' | 'unknown-value' | 'ambiguous-award-type' | 'ambiguous-number' | 'ambiguous-date'
  | 'ambiguous-person' | 'differs-from-record' | 'similar-on-record'
  | 'missing-plan' | 'missing-vesting' | 'missing-strike' | 'not-positive' | 'over-granted' | 'cancelled-before-grant'
  | 'no-common-class' | 'create-off' | 'number-taken' | 'duplicate-in-file' | 'same-name' | 'template-example'
  | 'already-imported' | 'up-to-date' | 'excluded' | 'blank-row' | 'plan-size-row' | 'nothing-outstanding'
  | 'relationship-guessed' | 'stakeholder-created' | 'stakeholder-updated' | 'type-as-relationship' | 'relationship-as-type'
  | 'class-created' | 'schedule-created' | 'plan-created' | 'plan-size-smaller'
  | 'no-price' | 'no-83b' | 'expiration-assumed' | 'exercise-date-assumed' | 'exercise-before-grant'
  | 'cancellation-dated-to-termination' | 'cancellation-date-missing' | 'unused-value'
  | 'interest-ignored' | 'no-cap-or-discount' | 'not-outstanding' | 'instrument-assumed' | 'settled-before-issue' | 'settled-date-missing'
  // Open Cap Format packages (src/ocf/plan.ts; docs/importing.md, "OCF packages").
  | 'ocf-bad-object' | 'ocf-unknown-reference' | 'ocf-duplicate-id' | 'ocf-currency' | 'ocf-event-order' | 'ocf-balance-mismatch'
  | 'ocf-unsupported' | 'ocf-split-existing' | 'ocf-depends'
  | 'ocf-no-balance' | 'ocf-acceleration-not-applied' | 'ocf-future-date' | 'ocf-result-date' | 'ocf-option-type-assumed'
  | 'ocf-terms-approximate' | 'ocf-planless-grant' | 'ocf-vesting-ignored'
  | 'ocf-folded' | 'ocf-not-imported' | 'ocf-history-current-only' | 'ocf-vesting-per-security' | 'ocf-vesting-rounding'
  | 'ocf-transfer-as-cancellation' | 'ocf-rounded' | 'ocf-excluded-with' | 'ptep-assumed' | 'class-updated';

export interface RowMessage {
  level: 'error' | 'warning' | 'info';
  text: string;
  code?: MessageCode;
  /** The field key (as in the mapping) the message is about. */
  field?: string;
  /** The cell as the file wrote it, for that field. */
  value?: Cell;
  /** For 'ambiguous-person': the emails of the people the row may mean, one of which is the answer. */
  choices?: string[];
  /** For 'ambiguous-person' in an OCF package: the people on file the row may mean (options.ocfPeople takes the answer). */
  people?: { id: string; name: string; email: string | null }[];
}
/** What becomes of a row: added, an update, already on the cap table, left out by the person, nothing to import, or not imported for an error. */
export type RowOutcome = 'add' | 'update' | 'existing' | 'excluded' | 'skip' | 'error';
export interface PreviewRow {
  row: number;
  status: 'ok' | 'warning' | 'error';
  action: 'create' | 'update' | 'skip';
  outcome: RowOutcome;
  summary: Record<string, string | number | null>;
  messages: RowMessage[];
  /** An OCF package's row: the object's id in the package and its object_type. */
  ocfId?: string;
  object?: string;
}
/** Something about a sheet, or the whole import, rather than one row. */
export interface Notice {
  code: 'truncated' | 'too-wide' | 'mixed-encoding' | 'over-authorized' | 'pool-over-allocated' | 'cap-table'
    // About an OCF package as a whole (src/ocf/read.ts and plan.ts).
    | 'ocf-checksum' | 'ocf-path-resolved' | 'ocf-unlisted-file' | 'ocf-version-older' | 'ocf-other-issuer' | 'ocf-not-imported-file' | 'ocf-legends';
  level: 'warning' | 'info';
  text: string;
  /** One click that settles it: push `value` into options.raiseAuthorized. */
  fix?: { option: 'raiseAuthorized'; value: string; shareClassId: string | null; className: string; to: number };
}
export interface ImportCounts {
  total: number; ok: number; warnings: number; errors: number; skipped: number; willImport: number;
  /** Of the skipped: rows already on the cap table, or people already up to date. */
  existing: number;
  /** Of the skipped: rows the person left out (options.excludeRows). */
  excluded: number;
}
export interface ImportPreview {
  kind: ImportKind;
  rows: PreviewRow[];
  counts: ImportCounts;
  creates: { stakeholders: string[]; shareClasses: string[]; vestingSchedules: string[]; pools: string[] };
  notices: Notice[];
}
export interface ImportedCounts {
  stakeholders: number; shareClasses: number; issuances: number; awards: number; convertibles: number; vestingSchedules: number; pools: number;
  /** Only an OCF package brings these: 0 for spreadsheets. `events` counts the ledger entries written for events, not the entries securities are created with. */
  warrants: number; valuations: number; stockSplits: number; poolAdjustments: number; events: number;
}
export interface ImportResult extends ImportPreview {
  importId: string;
  imported: ImportedCounts & { updated: { stakeholders: number } };
}

/** The most rows one sheet may bring in, limits.importMaxRows. */
export const maxRows = (): number => config().limits.importMaxRows;
/** Shares as the import messages write them, in locale.locale. */
const count = (n: number): string => n.toLocaleString(config().locale.locale);
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** A number as the messages say it: in words up to ten, in digits past that. */
const inWords = (n: number): string => WORDS[n] ?? String(n);
const id = (p: string): string => `${p}_${randomUUID().slice(0, 12)}`;
const now = (): string => new Date().toISOString();
const key = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** A name or email as people and classes are matched by: lower case, spaces collapsed. */
export const nameKey = key;
/** How options.relationships and NewPerson name a person: their email, or their name in lower case. */
export const personKey = (name: string, email: string | null): string => email ?? key(name);

/** Someone else with the same name and another email, which makes this row a different person. */
export interface SameName { name: string; email: string | null; stakeholderId: string }

export interface Plan {
  newStakeholders: Map<string, Record<string, unknown>>;
  stakeholderUpdates: Map<string, Record<string, unknown>>;
  newShareClasses: Map<string, Record<string, unknown> & { authorized: number }>;
  newSchedules: Map<string, Record<string, unknown>>;
  newPools: Map<string, Record<string, unknown> & { authorized: number }>;
  /** Plan size stated in the sheet's footer ("Authorized Shares 1,250,000"), when there is one. */
  poolSizeHint: number | null;
  issuances: Record<string, unknown>[];
  awards: Record<string, unknown>[];
  convertibles: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  /** About each person the plan creates, by stakeholder id: whether their relationship was guessed, and namesakes with other emails. */
  people: Map<string, { key: string; guessed: boolean; sameName: SameName[] }>;
  /** The people the plan creates, by email and by name, so a row finds them without reading them all. */
  plannedByEmail: Map<string, Record<string, unknown>>;
  plannedByName: Map<string, Record<string, unknown>[]>;
  /** People on record with no email whom a row gives one, by that email: a later row with it finds them. */
  emailsGiven: Map<string, Known>;
}

const TYPE_FOR_CODE: Partial<Record<FieldSpec['type'], MessageCode>> = {
  date: 'bad-date', number: 'bad-number', money: 'bad-number', price: 'bad-number', percent: 'bad-number', enum: 'unknown-value',
};
/**
 * The most a row may carry: a trillion shares, and amounts (cents) and prices
 * (micro-dollars) the database stores exactly. More is a typo or a broken cell,
 * and would otherwise fail the write with no row to point at.
 */
const MAX_SHARES = 1e12;
const MAX_UNITS = Number.MAX_SAFE_INTEGER;

interface About { code: MessageCode; field?: string; value?: Cell; choices?: string[] }

class RowContext {
  messages: RowMessage[] = [];
  /** Reverts plan entries this row added, run when the row ends up with errors or is skipped. */
  undo: (() => void)[] = [];
  /** Set when the row carries nothing to import (a total line, a fully repurchased certificate, a record already there). */
  skipReason: RowMessage | null = null;
  /** The row is already on the cap table: it is skipped whatever else is wrong with it. */
  existing = false;
  /** What an existing row says beside "already there": where the file differs from the record. */
  notes: RowMessage[] = [];
  private readonly row: Cell[];
  private readonly mapping: Record<string, MappingValue>;
  private readonly fields: Map<string, FieldSpec>;
  readonly dateOrder: DateOrder;
  readonly numberFormat: NumberFormat;

  constructor(row: Cell[], mapping: Record<string, MappingValue>, fields: Map<string, FieldSpec>, dateOrder: DateOrder, numberFormat: NumberFormat) {
    this.row = row;
    this.mapping = mapping;
    this.fields = fields;
    this.dateOrder = dateOrder;
    this.numberFormat = numberFormat;
  }

  raw(fieldKey: string): Cell {
    const source = this.mapping[fieldKey];
    if (source == null) return undefined;
    return typeof source === 'number' ? this.row[source] : source.value;
  }
  /**
   * True when the row names nothing — every required text, date and choice
   * column is blank. Total rows still carry sums in the numeric columns, so
   * those do not count; a row with a date but no name is an error, not a total.
   */
  get isBlankInRequiredColumns(): boolean {
    const numeric = new Set(['number', 'money', 'price', 'percent']);
    const required = [...this.fields.values()].filter((f) => f.required && typeof this.mapping[f.key] === 'number');
    const identifying = required.filter((f) => !numeric.has(f.type));
    const columns = identifying.length > 0 ? identifying : required;
    return columns.length > 0 && columns.every((f) => { const v = this.raw(f.key); return v == null || String(v).trim() === ''; });
  }
  private say(level: RowMessage['level'], text: string, about?: About): RowMessage {
    const message: RowMessage = { level, text };
    if (about) {
      message.code = about.code;
      if (about.field) {
        message.field = about.field;
        const value = about.value !== undefined ? about.value : this.raw(about.field);
        if (value !== undefined) message.value = value;
      }
      if (about.choices) message.choices = about.choices;
    }
    return message;
  }
  skip(text: string, about: About): void { this.skipReason = this.say('info', text, about); }
  /** The row matches a record on the cap table, so nothing of it is imported. */
  alreadyThere(): void { this.existing = true; this.skip('Already on the cap table — skipped', { code: 'already-imported' }); }
  error(text: string, about?: About): void { this.messages.push(this.say('error', text, about)); }
  warn(text: string, about?: About): void { this.messages.push(this.say('warning', text, about)); }
  info(text: string, about?: About): void { this.messages.push(this.say('info', text, about)); }
  get hasErrors(): boolean { return this.messages.some((m) => m.level === 'error'); }
  /** Nothing stands in the way of writing the row. */
  get clear(): boolean { return !this.hasErrors && !this.skipReason; }

  /** Coerces a field by its declared type, recording an error when it cannot. */
  value<T>(fieldKey: string, coerce: (v: Cell) => Coerced<T>): T | null {
    const spec = this.fields.get(fieldKey);
    const result = coerce(this.raw(fieldKey));
    if (result.error) {
      const code = fieldKey === 'awardType' && /ambiguous/.test(result.error) ? 'ambiguous-award-type' : spec ? TYPE_FOR_CODE[spec.type] ?? 'bad-value' : 'bad-value';
      this.error(`${spec?.label ?? fieldKey} ${result.error}`, { code, field: fieldKey });
    } else if (spec?.required && result.value == null) this.error(`${spec.label} is required`, { code: 'required', field: fieldKey });
    return result.value;
  }
  text(k: string) { return this.value(k, coerceText); }
  /** A share count, an amount in cents or a price in micro-dollars, within what a row may carry and flagged when it reads two ways. */
  private sized(k: string, n: number | null, max: number, shown: (n: number) => string): number | null {
    if (n == null) return n;
    if (Math.abs(n) > max) {
      this.error(`${this.fields.get(k)?.label ?? k} is more than the import can record`, { code: 'bad-number', field: k });
      return null;
    }
    // "500.000" read as 500 in a 1,234.56 file, or "1,000" read as 1 in a 1.234,56 one: right only if the file says so.
    const raw = this.raw(k);
    if (isAmbiguousNumber(raw) && String(raw).includes(this.numberFormat === 'en' ? '.' : ',')) {
      const other = this.numberFormat === 'en' ? '1.234,56' : '1,234.56';
      this.warn(`${this.fields.get(k)?.label ?? k} "${String(raw).trim()}" was read as ${shown(n)} — if the file means ${shown(n * 1000)}, read its numbers as ${other}`,
        { code: 'ambiguous-number', field: k });
    }
    return n;
  }
  number(k: string) { return this.sized(k, this.value(k, (v) => coerceNumber(v, this.numberFormat)), MAX_SHARES, count); }
  money(k: string) { return this.sized(k, this.value(k, (v) => coerceMoney(v, this.numberFormat)), MAX_UNITS, usd); }
  price(k: string) { return this.sized(k, this.value(k, (v) => coercePrice(v, this.numberFormat)), MAX_UNITS, perShare); }
  percent(k: string) { return this.value(k, (v) => coercePercent(v, this.numberFormat)); }
  bool(k: string) { return this.value(k, coerceBoolean); }
  /**
   * A date. Where the file writes dates both ways (dateOrder 'auto'), one like
   * 05/07/2024 is read month first and flagged with the other reading, so the
   * page can ask instead of the row taking a guess silently.
   */
  date(k: string) {
    const d = this.value(k, (v) => coerceDate(v, this.dateOrder));
    const raw = this.raw(k);
    const parts = d && this.dateOrder === 'auto' ? dateParts(raw) : null;
    if (parts && parts[0] <= 12 && parts[1] <= 12 && parts[0] !== parts[1]) {
      const dayFirst = coerceDate(raw, 'DMY').value;
      this.warn(`${this.fields.get(k)?.label ?? k} "${String(raw).trim()}" was read as ${d} (month first) — this file writes dates both ways; if it means ${dayFirst}, read its dates day first`,
        { code: 'ambiguous-date', field: k });
    }
    return d;
  }
  /** On an existing row: a field the file gives otherwise than the record, which the import leaves as it is. */
  differs(k: string, onRecord: string, inFile: string): void {
    this.notes.push(this.say('warning', `${this.fields.get(k)?.label ?? k} is ${onRecord} on the cap table and ${inFile} in the file — the import leaves the record as it is`,
      { code: 'differs-from-record', field: k }));
  }
}

/** A plan that adds nothing yet. */
export const emptyPlan = (): Plan => ({
  newStakeholders: new Map(), stakeholderUpdates: new Map(), newShareClasses: new Map(),
  newSchedules: new Map(), newPools: new Map(), poolSizeHint: null, issuances: [], awards: [], convertibles: [], transactions: [],
  people: new Map(), plannedByEmail: new Map(), plannedByName: new Map(), emailsGiven: new Map(),
});

/** Adds a person to the plan, and the undo that takes them out again. */
function planPerson(ctx: RowContext, plan: Plan, planKey: string, record: Record<string, unknown>): void {
  plan.newStakeholders.set(planKey, record);
  const email = record.email ? String(record.email) : null;
  if (email) plan.plannedByEmail.set(email, record);
  const named = plan.plannedByName.get(key(String(record.name))) ?? [];
  named.push(record);
  plan.plannedByName.set(key(String(record.name)), named);
  ctx.undo.push(() => {
    plan.newStakeholders.delete(planKey);
    plan.people.delete(String(record.id));
    if (email && plan.plannedByEmail.get(email) === record) plan.plannedByEmail.delete(email);
    named.splice(named.indexOf(record), 1);
  });
}

/** Gives a person on record who has no email the one a row has for them, as an update. */
function giveEmail(ctx: RowContext, plan: Plan, person: Known, email: string): void {
  const pending = plan.stakeholderUpdates.get(person.id);
  plan.stakeholderUpdates.set(person.id, { ...(pending ?? {}), email });
  plan.emailsGiven.set(email, person);
  ctx.undo.push(() => {
    if (pending) plan.stakeholderUpdates.set(person.id, pending); else plan.stakeholderUpdates.delete(person.id);
    plan.emailsGiven.delete(email);
  });
  ctx.info(`Gives "${person.name}" the email ${email}`, { code: 'stakeholder-updated', field: 'email' });
}

/** Gives a planned person the email a later row has for them. */
function planEmail(ctx: RowContext, plan: Plan, record: Record<string, unknown>, email: string): void {
  record.email = email;
  plan.plannedByEmail.set(email, record);
  ctx.undo.push(() => { record.email = null; plan.plannedByEmail.delete(email); });
}

/** The stakeholder fields an import writes, as they are on record, to say what an update changes. */
export const PERSON_FIELDS = ['email', 'type', 'relation', 'title', 'startDate', 'terminationDate', 'taxCountry', 'taxState', 'address', 'phone', 'notes', 'department'] as const;

/** A stakeholder on record, as the resolver matches rows to them. */
export interface Known {
  id: string; name: string; email: string | null;
  relation?: string | null; seated?: boolean; startDate?: string | null;
  fields: Record<string, unknown>;
}

export const issuanceFingerprint = (stakeholderId: string, shareClassId: string, quantity: number, issueDate: string): string =>
  `${stakeholderId}|${shareClassId}|${Number(quantity)}|${issueDate}`;
export const awardFingerprint = (stakeholderId: string, type: string, quantity: number, grantDate: string): string =>
  `${stakeholderId}|${type}|${Number(quantity)}|${grantDate}`;
export const convertibleFingerprint = (stakeholderId: string, instrument: string, principal: number, issueDate: string): string =>
  `${stakeholderId}|${instrument}|${Number(principal)}|${issueDate}`;
/** A warrant has no number: its holder, class, shares, issue date and strike say which it is. */
export const warrantFingerprint = (stakeholderId: string, shareClassId: string, quantity: number, issueDate: string, strike: number): string =>
  `${stakeholderId}|${shareClassId}|${Number(quantity)}|${issueDate}|${Number(strike)}`;
/**
 * What a record and a row correcting it still share: the holder and the date. Not the
 * class, award type or instrument: a file imported again with another answer to "ISO
 * or NSO?" (or another class for every row) is that record again, not a new one.
 */
export const nearKey = (stakeholderId: string, date: string): string => `${stakeholderId}|${date}`;

/** A certificate, grant or SAFE on record, as a row is compared with it. */
export interface OnFile {
  /** The row's id, when it was read from the database. */
  id?: string;
  /** Its certificate, grant or instrument number, as written. */
  label: string | null;
  fingerprint: string;
  near: string;
  /** Its share class id, award type or instrument, as stored: named when a look-alike row differs in it. */
  what: string;
  /** Shares, or a SAFE's principal in cents. */
  amount: number;
  /** What the fingerprint does not cover, by field key, as stored: compared with an existing row. */
  details: Record<string, unknown>;
}

/** The records of one kind, by number, by contents and by holder, class and date. */
export class Recorded {
  readonly byLabel = new Map<string, OnFile>();
  readonly byFingerprint = new Map<string, OnFile[]>();
  readonly byNear = new Map<string, OnFile[]>();
  add(record: OnFile): void {
    if (record.label) this.byLabel.set(key(record.label), record);
    for (const [index, k] of [[this.byFingerprint, record.fingerprint], [this.byNear, record.near]] as const) {
      const list = index.get(k) ?? [];
      list.push(record);
      index.set(k, list);
    }
  }
}

/**
 * Matches the rows of one sheet to the records on file, each record to one row
 * at most: two identical rows are two certificates, so the second is already
 * there only when the cap table holds two. A numbered row matches the record
 * with its number when the contents agree and clashes when they do not; it
 * also matches an unnumbered record with the same contents (imported before
 * without its number). An unnumbered row matches an unnumbered record with the
 * same contents first, then a numbered one whose number no row of the sheet
 * names.
 */
export class Claims {
  private readonly claimed = new Set<OnFile>();
  private readonly recorded: Recorded;
  private readonly labelsInSheet: Set<string>;
  constructor(recorded: Recorded, labelsInSheet: Set<string>) {
    this.recorded = recorded;
    this.labelsInSheet = labelsInSheet;
  }
  find(label: string | null, fingerprint: string | null): { match: 'existing' | 'clash'; record: OnFile } | null {
    if (label) {
      const held = this.recorded.byLabel.get(key(label));
      if (held) {
        if (held.fingerprint !== fingerprint) return { match: 'clash', record: held };
        this.claimed.add(held);
        return { match: 'existing', record: held };
      }
    }
    if (!fingerprint) return null;
    const same = this.recorded.byFingerprint.get(fingerprint) ?? [];
    const free = same.find((r) => !r.label && !this.claimed.has(r))
      ?? (label ? undefined : same.find((r) => r.label && !this.labelsInSheet.has(key(r.label)) && !this.claimed.has(r)));
    if (!free) return null;
    this.claimed.add(free);
    return { match: 'existing', record: free };
  }
  /** Records with the holder and date of an added row that no row of the sheet matched: perhaps what it corrects, renumbers or reclassifies. */
  unmatched(near: string): OnFile[] {
    return (this.recorded.byNear.get(near) ?? []).filter((r) => !this.claimed.has(r));
  }
}

/** Everything about the company the resolver needs, loaded once per import. */
export class Company {
  stakeholdersByEmail = new Map<string, Known>();
  /** Everyone with each name: two people may share one. */
  stakeholdersByName = new Map<string, Known[]>();
  shareClasses = new Map<string, { id: string; name: string; kind: string; seniority: number }>();
  schedulesByName = new Map<string, { id: string; name: string }>();
  schedules: { id: string; name: string; kind: string; durationMonths: number; cliffMonths: number; frequency: string }[] = [];
  pools: { id: string; name: string }[] = [];
  poolsByName = new Map<string, { id: string; name: string }>();
  certificates = new Recorded();
  awards = new Recorded();
  convertibles = new Recorded();
  /** Warrants on record, by their fingerprint (they have no number). */
  warrants = new Recorded();
  /** When each stakeholder on record left, by id, to date the shares a leaver's grant lost. */
  terminationDates = new Map<string, string>();
  /** Stock splits on record, oldest first. */
  stockSplits: { date: string; ratio: number }[] = [];
  maxSeniority = 0;
  commonClassId: string | null = null;
  readonly companyId: string;

  private constructor(companyId: string) {
    this.companyId = companyId;
  }

  static async load(companyId: string): Promise<Company> {
    const c = new Company(companyId);
    const [stakeholders, classes, schedules, pools, certificates, awards, convertibles, splits, warrants] = await concurrently([
      () => all<Record<string, unknown> & { id: string; name: string; email: string | null; relation: string; board_seat: number; start_date: string | null; termination_date: string | null }>(
        `SELECT id, name, email, type, relation, board_seat, start_date, termination_date, title, tax_country, tax_state, address, phone, notes, department
         FROM stakeholders WHERE company_id = ? ORDER BY created_at, id`, companyId),
      () => all<{ id: string; name: string; kind: string; seniority: number }>('SELECT id, name, kind, seniority FROM share_classes WHERE company_id = ?', companyId),
      () => all<{ id: string; name: string; kind: string; duration_months: number; cliff_months: number; frequency: string }>(
        'SELECT id, name, kind, duration_months, cliff_months, frequency FROM vesting_schedules WHERE company_id = ?', companyId),
      () => all<{ id: string; name: string }>('SELECT id, name FROM pools WHERE company_id = ?', companyId),
      () => all<{ id: string; certificate_no: string | null; stakeholder_id: string; share_class_id: string; quantity: number; issue_date: string; price_per_share: number; vesting_schedule_id: string | null }>(
        'SELECT id, certificate_no, stakeholder_id, share_class_id, quantity, issue_date, price_per_share, vesting_schedule_id FROM issuances WHERE company_id = ? ORDER BY created_at, id', companyId),
      () => all<{ id: string; label: string | null; stakeholder_id: string; type: string; quantity: number; grant_date: string; strike_price: number; pool_id: string | null; expiration_date: string | null }>(
        'SELECT id, label, stakeholder_id, type, quantity, grant_date, strike_price, pool_id, expiration_date FROM awards WHERE company_id = ? ORDER BY created_at, id', companyId),
      () => all<{ id: string; label: string | null; stakeholder_id: string; instrument: string; principal: number; issue_date: string; valuation_cap: number | null; discount: number }>(
        'SELECT id, label, stakeholder_id, instrument, principal, issue_date, valuation_cap, discount FROM convertibles WHERE company_id = ? ORDER BY created_at, id', companyId),
      () => all<{ date: string; ratio: number }>('SELECT date, ratio FROM stock_splits WHERE company_id = ? ORDER BY date', companyId),
      () => all<{ id: string; stakeholder_id: string; share_class_id: string; quantity: number; issue_date: string; strike_price: number }>(
        'SELECT id, stakeholder_id, share_class_id, quantity, issue_date, strike_price FROM warrants WHERE company_id = ? ORDER BY created_at, id', companyId),
    ]);
    for (const s of stakeholders) {
      const fields = {
        email: s.email, type: s.type, relation: s.relation, title: s.title, startDate: s.start_date, terminationDate: s.termination_date,
        taxCountry: s.tax_country, taxState: s.tax_state, address: s.address, phone: s.phone, notes: s.notes, department: s.department,
      };
      c.remember({ id: s.id, name: s.name, email: s.email ? key(s.email) : null, relation: s.relation, seated: s.board_seat === 1, startDate: s.start_date, fields });
      if (s.termination_date) c.terminationDates.set(s.id, s.termination_date);
    }
    c.stockSplits = splits.map((s) => ({ date: s.date, ratio: Number(s.ratio) }));
    for (const cls of classes) {
      c.shareClasses.set(key(cls.name), cls);
      c.maxSeniority = Math.max(c.maxSeniority, cls.seniority);
      if (cls.kind === 'COMMON' && !c.commonClassId) c.commonClassId = cls.id;
    }
    for (const v of schedules) {
      const row = { id: v.id, name: v.name, kind: v.kind, durationMonths: v.duration_months, cliffMonths: v.cliff_months, frequency: v.frequency };
      c.schedules.push(row);
      c.schedulesByName.set(key(v.name), row);
    }
    c.pools = pools;
    for (const p of pools) c.poolsByName.set(key(p.name), p);
    for (const r of certificates) c.recordIssuance(r.certificate_no, r.stakeholder_id, r.share_class_id, Number(r.quantity), r.issue_date, Number(r.price_per_share), r.vesting_schedule_id, r.id);
    for (const r of awards) c.recordAward(r.label, r.stakeholder_id, r.type, Number(r.quantity), r.grant_date, Number(r.strike_price), r.pool_id, r.expiration_date, r.id);
    for (const r of convertibles) c.recordConvertible(r.label, r.stakeholder_id, r.instrument, Number(r.principal), r.issue_date, r.valuation_cap == null ? null : Number(r.valuation_cap), Number(r.discount), r.id);
    for (const r of warrants) {
      c.warrants.add({ id: r.id, label: null, fingerprint: warrantFingerprint(r.stakeholder_id, r.share_class_id, Number(r.quantity), r.issue_date, Number(r.strike_price)),
        near: nearKey(r.stakeholder_id, r.issue_date), what: r.share_class_id, amount: Number(r.quantity), details: { strikePrice: Number(r.strike_price) } });
    }
    return c;
  }

  /**
   * A company with nothing on record, held in memory instead of read from the
   * database. With absorb() it stands in for one through a run of sheets, so the
   * reconcile tool can read an export without a company to write it to.
   */
  static empty(companyId: string): Company {
    return new Company(companyId);
  }

  private recordIssuance(label: string | null, holder: string, shareClassId: string, quantity: number, date: string, price: number, scheduleId: string | null, id?: string): void {
    this.certificates.add({ id, label, fingerprint: issuanceFingerprint(holder, shareClassId, quantity, date), near: nearKey(holder, date), what: shareClassId, amount: quantity,
      details: { pricePerShare: price, vestingSchedule: scheduleId, certificateNo: label } });
  }
  private recordAward(label: string | null, holder: string, type: string, quantity: number, date: string, strike: number, poolId: string | null, expiration: string | null, id?: string): void {
    this.awards.add({ id, label, fingerprint: awardFingerprint(holder, type, quantity, date), near: nearKey(holder, date), what: type, amount: quantity,
      details: { strikePrice: strike, poolName: poolId, expirationDate: expiration, label } });
  }
  private recordConvertible(label: string | null, holder: string, instrument: string, principal: number, date: string, cap: number | null, discount: number, id?: string): void {
    this.convertibles.add({ id, label, fingerprint: convertibleFingerprint(holder, instrument, principal, date), near: nearKey(holder, date), what: instrument, amount: principal,
      details: { valuationCap: cap, discount, label } });
  }

  private remember(person: Known): void {
    if (person.email) this.stakeholdersByEmail.set(person.email, person);
    const named = this.stakeholdersByName.get(key(person.name)) ?? [];
    named.push(person);
    this.stakeholdersByName.set(key(person.name), named);
  }

  /** Takes in what a prepared sheet would write, as load() would find it after the commit, so the next sheet resolves against it. */
  absorb(plan: Plan): void {
    const byId = new Map([...this.stakeholdersByName.values()].flat().map((s) => [s.id, s]));
    for (const s of plan.newStakeholders.values()) {
      const fields = Object.fromEntries(PERSON_FIELDS.map((f) => [f, s[f] ?? null]));
      const row: Known = { id: String(s.id), name: String(s.name), email: s.email ? key(String(s.email)) : null, relation: s.relation as string,
        seated: s.boardSeat === 1, startDate: (s.startDate as string) ?? null, fields };
      this.remember(row);
      if (s.terminationDate) this.terminationDates.set(row.id, String(s.terminationDate));
      byId.set(row.id, row);
    }
    for (const [stakeholderId, updates] of plan.stakeholderUpdates) {
      const row = byId.get(stakeholderId);
      if (row && updates.email) { row.email = key(String(updates.email)); this.stakeholdersByEmail.set(row.email, row); }
      if (row && updates.relation) row.relation = String(updates.relation);
      if (row && updates.boardSeat === 1) row.seated = true;
      if (row && updates.startDate) row.startDate = String(updates.startDate);
      if (row) for (const f of PERSON_FIELDS) if (updates[f] != null) row.fields[f] = updates[f];
      if (updates.terminationDate) this.terminationDates.set(stakeholderId, String(updates.terminationDate));
    }
    for (const c of plan.newShareClasses.values()) {
      const cls = { id: String(c.id), name: String(c.name), kind: String(c.kind), seniority: Number(c.seniority) };
      this.shareClasses.set(key(cls.name), cls);
      this.maxSeniority = Math.max(this.maxSeniority, cls.seniority);
      if (cls.kind === 'COMMON' && !this.commonClassId) this.commonClassId = cls.id;
    }
    for (const v of plan.newSchedules.values()) {
      const row = { id: String(v.id), name: String(v.name), kind: String(v.kind), durationMonths: Number(v.durationMonths), cliffMonths: Number(v.cliffMonths), frequency: String(v.frequency) };
      this.schedules.push(row);
      this.schedulesByName.set(key(row.name), row);
    }
    for (const p of plan.newPools.values()) {
      const pool = { id: String(p.id), name: String(p.name) };
      this.pools.push(pool);
      this.poolsByName.set(key(pool.name), pool);
    }
    for (const i of plan.issuances) {
      this.recordIssuance(i.certificateNo as string | null, String(i.stakeholderId), String(i.shareClassId), Number(i.quantity), String(i.issueDate),
        Number(i.pricePerShare), (i.vestingScheduleId as string | null) ?? null);
    }
    for (const a of plan.awards) {
      this.recordAward(a.label as string | null, String(a.stakeholderId), String(a.type), Number(a.quantity), String(a.grantDate),
        Number(a.strikePrice), (a.poolId as string | null) ?? null, (a.expirationDate as string | null) ?? null);
    }
    for (const c of plan.convertibles) {
      this.recordConvertible(c.label as string | null, String(c.stakeholderId), String(c.instrument), Number(c.principal), String(c.issueDate),
        c.valuationCap == null ? null : Number(c.valuationCap), Number(c.discount));
    }
  }

  /** The splits after `recorded`, up to and including `on`: a row dated `on` is written in that day's shares. */
  splitFactor(recorded: string, on: string): number {
    return this.stockSplits.reduce((k, s) => (s.date > recorded && s.date <= on ? k * s.ratio : k), 1);
  }
}

/**
 * Type and relationship of a stakeholder, read tolerantly. Exports often label
 * a relationship column "Type" ("Investor", "Founder") or put "Individual" in a
 * relationship column, so a word that belongs to the other field is moved there
 * instead of failing the row; only words that fit neither are errors.
 */
function readTypeAndRelation(ctx: RowContext, name: string | null): { type: string | null; relation: string | null } {
  const typeCell = ctx.raw('stakeholderType');
  const relationCell = ctx.raw('relation');
  const typeAsType = coerceStakeholderType(typeCell);
  const typeAsRelation = coerceRelation(typeCell);
  const relationAsRelation = coerceRelation(relationCell);
  const relationAsType = coerceStakeholderType(relationCell);

  let type = typeAsType.value;
  let relation = relationAsRelation.value;
  if (typeAsType.error) {
    if (typeAsRelation.value) {
      relation ??= typeAsRelation.value;
      ctx.info(`Type column says "${String(typeCell)}" — read as the relationship${name ? `; type taken from the name (${guessStakeholderType(name).toLowerCase()})` : ''}`,
        { code: 'type-as-relationship', field: 'stakeholderType' });
    } else ctx.error(`Type ${typeAsType.error}`, { code: 'unknown-value', field: 'stakeholderType' });
  }
  if (relationAsRelation.error) {
    if (relationAsType.value) {
      type ??= relationAsType.value;
      ctx.info(`Relationship column says "${String(relationCell)}" — read as the type`, { code: 'relationship-as-type', field: 'relation' });
    } else ctx.error(`Relationship ${relationAsRelation.error}`, { code: 'unknown-value', field: 'relation' });
  }
  return { type, relation };
}

export function defaultRelation(name: string, classKind: string | null): string {
  if (guessStakeholderType(name) !== 'INDIVIDUAL') return 'INVESTOR';
  if (classKind === 'PREFERRED') return 'INVESTOR';
  return 'EMPLOYEE';
}

/** The relationship the person chose in options.relationships for someone the import creates, by email and then by name. */
function chosenRelation(opts: ImportOptions, name: string, email: string | null): string | null {
  const chosen = opts.relationships ?? {};
  // Names are keys here, so only the object's own entries count: a person called "constructor" chose nothing.
  const pick = (k: string): string | undefined => (Object.hasOwn(chosen, k) && (RELATIONS as readonly string[]).includes(chosen[k]) ? chosen[k] : undefined);
  return (email ? pick(email) : undefined) ?? pick(key(name)) ?? null;
}

const RELATION_WORDS: Record<string, string> = {
  FOUNDER: 'Founder', EMPLOYEE: 'Employee', FORMER_EMPLOYEE: 'Former employee', ADVISOR: 'Advisor', CONTRACTOR: 'Contractor',
  INVESTOR: 'Investor', BOARD_MEMBER: 'Board member', OTHER: 'Other',
  INDIVIDUAL: 'Individual', ENTITY: 'Entity', FUND: 'Fund', TRUST: 'Trust',
};

/**
 * A board member or director brought in by an import sits on the board: the seat is
 * what makes someone a director, the relationship alone does not. It runs over the
 * dates the row gives, as the seats given when seats arrived do (ONCE in db.ts): one
 * who has left is a former director, and dates the wrong way round keep only the end.
 */
export function boardSeatOf(relation: string | null, startDate: string | null, terminationDate: string | null): Record<string, unknown> {
  if (relation !== 'BOARD_MEMBER') return {};
  return { boardSeat: 1, boardSeatStart: terminationDate && startDate && terminationDate < startDate ? null : startDate, boardSeatEnd: terminationDate };
}

/**
 * Whom a row names: someone on record, someone this sheet creates, or nobody
 * yet — with any namesakes who have another email — or, when the row cannot say
 * which of several people of that name it means, all of them.
 */
export interface PersonMatch { existing?: Known; planned?: Record<string, unknown>; sameName: SameName[]; ambiguous?: SameName[] }

/** Whether a person on record has an email, counting one a row of this sheet gives them. */
const hasEmail = (plan: Plan, k: Known): boolean => !!k.email || plan.stakeholderUpdates.get(k.id)?.email != null;

/**
 * A person is found by email first. A row with no email takes the person of
 * that name, when there is only one. A row with an email nobody has takes the
 * person of that name who has no email on file, when there is only one; a
 * person of that name with another email is someone else, and both are kept —
 * the caller says so, so it can be put right. Where several people could be
 * meant, the row is not given to any of them.
 */
export function findPerson(company: Company, plan: Plan, name: string, email: string | null): PersonMatch {
  if (email) {
    const byEmail = company.stakeholdersByEmail.get(email) ?? plan.emailsGiven.get(email);
    if (byEmail) return { existing: byEmail, sameName: [] };
    const plannedByEmail = plan.plannedByEmail.get(email);
    if (plannedByEmail) return { planned: plannedByEmail, sameName: [] };
  }
  const onRecord = company.stakeholdersByName.get(key(name)) ?? [];
  const plannedByName = plan.plannedByName.get(key(name)) ?? [];
  const known = (k: Known): SameName => ({ name: k.name, email: k.email ?? (plan.stakeholderUpdates.get(k.id)?.email as string | undefined) ?? null, stakeholderId: k.id });
  const planned = (p: Record<string, unknown>): SameName => ({ name: String(p.name), email: p.email ? String(p.email) : null, stakeholderId: String(p.id) });
  if (!email) {
    if (onRecord.length + plannedByName.length > 1) return { sameName: [], ambiguous: [...onRecord.map(known), ...plannedByName.map(planned)] };
    if (onRecord[0]) return { existing: onRecord[0], sameName: [] };
    return plannedByName[0] ? { planned: plannedByName[0], sameName: [] } : { sameName: [] };
  }
  const withoutEmail = onRecord.filter((k) => !hasEmail(plan, k));
  const plannedWithoutEmail = plannedByName.filter((p) => !p.email);
  if (withoutEmail.length + plannedWithoutEmail.length > 1) return { sameName: [], ambiguous: [...withoutEmail.map(known), ...plannedWithoutEmail.map(planned)] };
  if (withoutEmail[0]) return { existing: withoutEmail[0], sameName: [] };
  if (plannedWithoutEmail[0]) return { planned: plannedWithoutEmail[0], sameName: [] };
  return { sameName: [...onRecord.map(known), ...plannedByName.map(planned)] };
}

const sameNameText = (name: string, others: SameName[]): string =>
  `Another "${name}" has a different email (${others.map((o) => o.email ?? 'none').join(', ')}) — ${others.length + 1 === 2 ? 'two' : inWords(others.length + 1)} stakeholders will be created`;

/** A row that could be any of several people of one name: it waits for the email that says which. */
function ambiguousPerson(ctx: RowContext, name: string, people: SameName[]): void {
  // In a fixed order, so the message and its choices read the same on every check whatever order the rows came back in.
  const emails = people.map((p) => p.email).filter((e): e is string => !!e).sort();
  const without = people.length - emails.length;
  ctx.error(`${people.length === 2 ? 'Two' : inWords(people.length).replace(/^./, (c) => c.toUpperCase())} people are called "${name}"`
    + `${emails.length ? ` (${emails.join(', ')}${without ? `, and ${inWords(without)} with no email` : ''})` : ''} — add the email of the one this row is about`,
    { code: 'ambiguous-person', field: 'email', choices: emails });
}

/** Example rows the import templates used to carry, by name and email: a file made from an old template may still hold them. */
const TEMPLATE_EXAMPLES = new Set(Object.values(IMPORT_KINDS).flatMap((k) => k.template.slice(1).map((r) => `${key(r[0])}|${key(r[1])}`)));

function warnIfTemplateExample(ctx: RowContext): void {
  const name = coerceText(ctx.raw('stakeholderName')).value;
  const email = coerceText(ctx.raw('email')).value;
  if (name && email && TEMPLATE_EXAMPLES.has(`${key(name)}|${key(email)}`)) {
    ctx.warn(`"${name}" is an example row from the import template — delete it from the file unless it is real`, { code: 'template-example', field: 'stakeholderName' });
  }
}

/**
 * Finds a stakeholder by email, then by name; otherwise creates one in the
 * plan (once, however many rows mention them) when the options allow it.
 */
function resolveStakeholder(
  ctx: RowContext, company: Company, plan: Plan, opts: ImportOptions, classKind: string | null,
): { id: string; name: string; created: boolean } | null {
  const name = ctx.text('stakeholderName');
  const email = ctx.text('email')?.toLowerCase() ?? null;
  if (!name) return null;

  const match = findPerson(company, plan, name, email);
  if (match.ambiguous) {
    ambiguousPerson(ctx, name, match.ambiguous);
    return null;
  }
  if (match.existing) {
    // Someone on record with no email, named here with one: they get it, and later rows with it find them.
    if (email && !hasEmail(plan, match.existing)) giveEmail(ctx, plan, match.existing, email);
    return { id: match.existing.id, name: match.existing.name, created: false };
  }
  if (match.planned) {
    // Named again with an email the first mention lacked: the person gets it.
    if (email && !match.planned.email) planEmail(ctx, plan, match.planned, email);
    return { id: match.planned.id as string, name: match.planned.name as string, created: true };
  }

  if (opts.createMissingStakeholders === false) {
    ctx.error(`Stakeholder "${name}" does not exist and creating stakeholders is turned off`, { code: 'create-off', field: 'stakeholderName' });
    return null;
  }
  const { type: typeGiven, relation: relationGiven } = readTypeAndRelation(ctx, name);
  const chosen = relationGiven ?? chosenRelation(opts, name, email);
  const relation = chosen ?? defaultRelation(name, classKind);
  const planKey = email ? `email:${email}` : `name:${key(name)}`;
  const record = {
    id: id('stk'), companyId: company.companyId, name, email,
    type: typeGiven ?? guessStakeholderType(name), relation,
    startDate: null, terminationDate: null, taxCountry: null, taxState: null, entityGroupId: null,
    title: null, address: null, phone: null, notes: null, ...boardSeatOf(relation, null, null), createdAt: now(),
  };
  planPerson(ctx, plan, planKey, record);
  plan.people.set(record.id, { key: personKey(name, email), guessed: !chosen, sameName: match.sameName });
  if (match.sameName.length) ctx.warn(sameNameText(name, match.sameName), { code: 'same-name', field: 'email' });
  ctx.info(`Creates stakeholder "${name}" as ${String(record.relation).toLowerCase().replace('_', ' ')}${chosen ? '' : ' — review the relationship'}`,
    { code: chosen ? 'stakeholder-created' : 'relationship-guessed', field: 'relation' });
  return { id: record.id, name, created: true };
}

function resolveShareClass(
  ctx: RowContext, company: Company, plan: Plan, opts: ImportOptions,
  price: number | null, quantity: number, issueDate: string | null,
): { id: string; name: string; kind: string; created: boolean } | null {
  const name = ctx.text('shareClassName');
  if (!name) return null;
  const existing = company.shareClasses.get(key(name));
  if (existing) return { ...existing, created: false };

  const planned = plan.newShareClasses.get(key(name));
  if (planned) {
    planned.authorized += quantity;
    ctx.undo.push(() => { planned.authorized -= quantity; });
    if (issueDate && (!planned.issueDate || issueDate < String(planned.issueDate))) planned.issueDate = issueDate;
    return { id: planned.id as string, name: planned.name as string, kind: planned.kind as string, created: true };
  }
  if (opts.createMissingShareClasses === false) {
    ctx.error(`Share class "${name}" does not exist and creating share classes is turned off`, { code: 'create-off', field: 'shareClassName' });
    return null;
  }
  const preferred = /preferred|series|pref\b/i.test(name);
  // A new class takes the configured par value (company.commonClass.parValue, in
  // dollars; stored in micro-dollars), and that as its price when the sheet gives
  // none. A preferred one takes the usual preference, equity.preferredClass.
  const { company: companyDefaults, equity } = config();
  const parValue = Math.round(companyDefaults.commonClass.parValue * 1e6);
  const record = {
    id: id('sc'), companyId: company.companyId, name, kind: preferred ? 'PREFERRED' : 'COMMON',
    authorized: quantity, parValue,
    seniority: preferred ? company.maxSeniority + plan.newShareClasses.size + 1 : 0,
    originalIssuePrice: price ?? parValue, liquidationMultiple: preferred ? equity.preferredClass.liquidationMultiple : 1,
    participation: 'NON_PARTICIPATING',
    participationCap: null, conversionRatio: 1, dividendType: 'NONE', dividendRate: 0,
    dividendCompounding: 0, dividendsParticipate: 0, votesPerShare: 1,
    antiDilution: preferred ? 'BROAD_WEIGHTED' : 'NONE', payToPlay: 0,
    issueDate: issueDate ?? now().slice(0, 10), isConvertible: preferred ? 1 : 0, sortOrder: 0,
  };
  plan.newShareClasses.set(key(name), record);
  ctx.undo.push(() => plan.newShareClasses.delete(key(name)));
  ctx.info(`Creates ${preferred ? 'preferred' : 'common'} share class "${name}" — review its terms and authorized shares`, { code: 'class-created', field: 'shareClassName' });
  return { id: record.id, name, kind: record.kind, created: true };
}

/** A schedule by name, by shorthand (matching an existing one when possible), or the chosen default. */
function resolveVestingSchedule(
  ctx: RowContext, company: Company, plan: Plan, defaultScheduleId: string | null | undefined, required: boolean,
): string | null | undefined {
  const text = ctx.text('vestingSchedule');
  if (text) {
    const byName = company.schedulesByName.get(key(text));
    if (byName) return byName.id;
    const parsed = parseVestingShorthand(text);
    if (!parsed) {
      ctx.error(`Vesting schedule "${text}" is not a known schedule or shorthand like "4y/1y monthly"`, { code: 'unknown-value', field: 'vestingSchedule' });
      return undefined;
    }
    if (parsed.fullyVested) {
      const existing = company.schedules.find((s) => s.kind === 'FULLY_VESTED');
      if (existing) return existing.id;
      const planKey = 'fully-vested';
      if (!plan.newSchedules.has(planKey)) {
        ctx.undo.push(() => plan.newSchedules.delete(planKey));
        plan.newSchedules.set(planKey, {
          id: id('vs'), companyId: company.companyId, name: 'Fully vested at grant', kind: 'FULLY_VESTED',
          durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 1, yearWeights: null,
          milestones: null, customTranches: null, accelerationSingle: 0, accelerationDouble: 0,
          accelerationMonths: null, createdAt: now(),
        });
      }
      return plan.newSchedules.get(planKey)!.id as string;
    }
    const match = company.schedules.find((s) => s.kind === 'TIME' && s.durationMonths === parsed.durationMonths
      && s.cliffMonths === parsed.cliffMonths && s.frequency === parsed.frequency);
    if (match) return match.id;
    const planKey = `${parsed.durationMonths}/${parsed.cliffMonths}/${parsed.frequency}`;
    if (!plan.newSchedules.has(planKey)) {
      ctx.undo.push(() => plan.newSchedules.delete(planKey));
      const years = parsed.durationMonths % 12 === 0 ? `${parsed.durationMonths / 12} years` : `${parsed.durationMonths} months`;
      const cliff = parsed.cliffMonths === 0 ? 'no cliff' : parsed.cliffMonths % 12 === 0 ? `${parsed.cliffMonths / 12} year cliff` : `${parsed.cliffMonths} month cliff`;
      const name = `${years}, ${cliff}, ${parsed.frequency.toLowerCase()}`;
      plan.newSchedules.set(planKey, {
        id: id('vs'), companyId: company.companyId, name, kind: 'TIME',
        durationMonths: parsed.durationMonths, cliffMonths: parsed.cliffMonths, frequency: parsed.frequency,
        immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null,
        accelerationSingle: 0, accelerationDouble: 0, accelerationMonths: null, createdAt: now(),
      });
      ctx.info(`Creates vesting schedule "${name}"`, { code: 'schedule-created', field: 'vestingSchedule' });
    }
    return plan.newSchedules.get(planKey)!.id as string;
  }
  if (defaultScheduleId) return defaultScheduleId;
  if (required) ctx.error('Vesting schedule is missing and no default schedule was chosen', { code: 'missing-vesting', field: 'vestingSchedule' });
  return null;
}

const cellIsBlank = (c: Cell): boolean => c == null || String(c).trim() === '';

/**
 * Grant exports end in a summary block — "Authorized Shares 1,250,000",
 * "Available for Issuance 373,450" — that the row loop skips. The plan size
 * lives there, so it is read up front: the authorized line when present,
 * otherwise granted plus available. Without it a new plan is sized to its grants.
 */
const PLAN_SIZE_LABEL = /^(total\s+)?(authorized|authorised)(\s+shares)?$|^plan size$|^shares (authorized|authorised|reserved)$|^reserved shares$|^pool size$|^available( for (issuance|grant))?$|^shares available$|^remaining$|^unallocated$/;
/** A footer line stating the plan size or what is left: a label and numbers, nothing else. */
export function isPlanSizeRow(row: Cell[], format: NumberFormat = 'en'): boolean {
  const labelIdx = row.findIndex((c) => !cellIsBlank(c));
  if (labelIdx < 0 || !PLAN_SIZE_LABEL.test(String(row[labelIdx]).trim().toLowerCase())) return false;
  return row.every((c, i) => i === labelIdx || cellIsBlank(c) || coerceNumber(c, format).value != null);
}

export function findPlanSize(rows: Cell[][], grantedQuantityColumn: number | null, format: NumberFormat = 'en'): number | null {
  let authorized: number | null = null;
  let available: number | null = null;
  let granted = 0;
  const numberIn = (row: Cell[], skip: number): number | null => {
    for (let i = 0; i < row.length; i++) {
      if (i === skip) continue;
      const n = coerceNumber(row[i], format);
      if (n.value != null && n.value > 0) return n.value;
    }
    return null;
  };
  for (const row of rows) {
    const labelIdx = row.findIndex((c) => !cellIsBlank(c));
    if (labelIdx < 0) continue;
    const label = String(row[labelIdx]).trim().toLowerCase();
    if (/^(total\s+)?(authorized|authorised)(\s+shares)?$|^plan size$|^shares (authorized|authorised|reserved)$|^reserved shares$|^pool size$/.test(label)) {
      authorized ??= numberIn(row, labelIdx);
    } else if (/^available( for (issuance|grant))?$|^shares available$|^remaining$|^unallocated$/.test(label)) {
      available ??= numberIn(row, labelIdx);
    } else if (grantedQuantityColumn != null) {
      // Only rows that are grants count towards the granted total, not the total line itself.
      const isGrant = row.some((c, i) => i !== grantedQuantityColumn && i !== labelIdx && !cellIsBlank(c)) && !/^total$/.test(label);
      const q = coerceNumber(row[grantedQuantityColumn], format);
      if (isGrant && q.value != null && q.value > 0) granted += q.value;
    }
  }
  if (authorized != null) return authorized;
  if (available != null && granted > 0) return granted + available;
  return null;
}

/** A new plan in the plan, drawing on the company's common class, sized to the grants so far. */
function planPool(ctx: RowContext, company: Company, plan: Plan, name: string, quantity: number, field: string): string | null {
  const shareClassId = company.commonClassId ?? [...plan.newShareClasses.values()].find((c) => c.kind === 'COMMON')?.id as string | undefined;
  if (!shareClassId) {
    ctx.error(`Equity plan "${name}" does not exist and the company has no common share class for it to draw from`, { code: 'no-common-class', field });
    return null;
  }
  const record = {
    id: id('pol'), companyId: company.companyId, name, shareClassId, authorized: quantity,
    boardApprovalDate: null, shareholderApprovalDate: null, returnForfeitures: 1, evergreenPercent: null,
    planType: 'STOCK_PLAN', createdAt: now(),
  };
  plan.newPools.set(key(name), record);
  ctx.undo.push(() => plan.newPools.delete(key(name)));
  ctx.info(plan.poolSizeHint != null
    ? `Creates equity plan "${name}" with ${count(plan.poolSizeHint)} authorized shares, as the sheet states`
    : `Creates equity plan "${name}" sized to the imported grants — set its authorized shares afterwards`, { code: 'plan-created', field });
  return record.id;
}

/**
 * The plan named on the row, the chosen default (an existing plan, or a new one
 * by name), or the company's only plan. A named plan that does not exist yet is
 * created with the size the sheet states, or — when the sheet says nothing —
 * with the imported grants as its reserve, since grant rows alone never carry
 * the plan size.
 */
function resolvePool(ctx: RowContext, company: Company, plan: Plan, opts: ImportOptions, quantity: number): string | null {
  const name = ctx.text('poolName');
  const byName = (n: string): string | null => {
    const pool = company.poolsByName.get(key(n));
    if (pool) return pool.id;
    const planned = plan.newPools.get(key(n));
    if (!planned) return null;
    planned.authorized += quantity;
    ctx.undo.push(() => { planned.authorized -= quantity; });
    return planned.id as string;
  };
  if (name) {
    const found = byName(name);
    if (found) return found;
    if (opts.createMissingPools === false) {
      ctx.error(`Equity plan "${name}" does not exist and creating plans is turned off`, { code: 'create-off', field: 'poolName' });
      return null;
    }
    return planPool(ctx, company, plan, name, quantity, 'poolName');
  }
  if (opts.defaultPoolId) return opts.defaultPoolId;
  const chosen = opts.defaultPoolName?.trim();
  if (chosen) return byName(chosen) ?? planPool(ctx, company, plan, chosen, quantity, 'poolName');
  if (company.pools.length === 1) return company.pools[0].id;
  ctx.error(company.pools.length === 0
    ? 'The company has no equity plan to grant from — create one first or add an equity plan column'
    : 'Equity plan is missing and no default plan was chosen', { code: 'missing-plan', field: 'poolName' });
  return null;
}

// ---------------------------------------------------------------------------
// How a file writes its dates and numbers
// ---------------------------------------------------------------------------

/** How one sheet's dates and numbers are read: decided for its whole file before any row is. */
export interface Reading { dateOrder: DateOrder; numberFormat: NumberFormat }

/** A date or number that shows how a file is written, and where it is. */
export interface SheetEvidence { text: string; sheet: string | null; row: number }

/** What the dates of a file say about their order. */
export interface DateReading {
  /** The order the rows are read in: 'auto' only when the file has dates that need both. */
  order: DateOrder;
  decidedBy: 'file' | 'setting' | 'default';
  evidence: SheetEvidence | null;
  /** Dates written as text like 03/04/2024, which read two ways. */
  ambiguous: number;
  /** Dates written as text with numbers (not Excel dates, which carry no order). */
  textDates: number;
}

type SheetLike = Pick<ImportRequest, 'kind' | 'rows' | 'mapping' | 'headerRowNumber'> & { sheetName?: string };

/**
 * One day-month order for every date of a file: a date whose first number is
 * above 12 (15/01/2024) is only day-first, one whose second is (01/15/2024)
 * only month-first, and either settles the whole file — so 03/02/2024 in a
 * day-first file is the 3rd of February, not March 2. A file with both kinds is
 * read date by date. With neither, locale.importDateOrder decides ("auto" reads
 * month first). `setting` MDY or DMY is the person's choice and wins.
 */
export function readDates(sheets: SheetLike[], setting: DateOrder = 'auto'): DateReading {
  let dayFirst: SheetEvidence | null = null, monthFirst: SheetEvidence | null = null;
  let ambiguous = 0, textDates = 0;
  for (const sheet of sheets) {
    const columns = IMPORT_KINDS[sheet.kind].fields.filter((f) => f.type === 'date').map((f) => sheet.mapping[f.key]).filter((c): c is number => typeof c === 'number');
    if (columns.length === 0) continue;
    sheet.rows.slice(0, maxRows()).forEach((row, i) => {
      for (const c of columns) {
        const parts = dateParts(row[c]);
        if (!parts) continue;
        textDates++;
        const [a, b] = parts;
        const at = { text: String(row[c]).trim(), sheet: sheet.sheetName ?? null, row: (sheet.headerRowNumber ?? 1) + 1 + i };
        if (a > 12 && b <= 12) dayFirst ??= at;
        else if (b > 12 && a <= 12) monthFirst ??= at;
        else if (a <= 12 && b <= 12 && a !== b) ambiguous++;
      }
    });
  }
  if (setting === 'MDY' || setting === 'DMY') return { order: setting, decidedBy: 'setting', evidence: setting === 'DMY' ? dayFirst : monthFirst, ambiguous, textDates };
  if (dayFirst && !monthFirst) return { order: 'DMY', decidedBy: 'file', evidence: dayFirst, ambiguous, textDates };
  if (monthFirst && !dayFirst) return { order: 'MDY', decidedBy: 'file', evidence: monthFirst, ambiguous, textDates };
  if (dayFirst && monthFirst) return { order: 'auto', decidedBy: 'file', evidence: dayFirst, ambiguous, textDates };
  return { order: config().locale.importDateOrder === 'DMY' ? 'DMY' : 'MDY', decidedBy: 'default', evidence: null, ambiguous, textDates };
}

/**
 * How a sheet writes numbers: the format given for it, or what its own values
 * show. A format given back as parse read it is still the file's own reading;
 * 'given' means the person chose otherwise.
 */
export function readNumbers(sheet: SheetLike, given?: NumberFormat | null): Omit<NumberFormatReading, 'decidedBy'> & { decidedBy: NumberFormatReading['decidedBy'] | 'given' } {
  const seen = detectNumberFormat(sheet.rows.slice(0, maxRows()), null, (sheet.headerRowNumber ?? 1) + 1);
  return given && given !== seen.format ? { ...seen, format: given, decidedBy: 'given' } : seen;
}

// ---------------------------------------------------------------------------

/** Every row that named a stakeholder, by stakeholder id, so a run can say where each new person appears. */
export interface Ref { stakeholderId: string; row: number }

/**
 * `known` resolves the rows against a company already in hand, such as an
 * in-memory one from Company.empty(), instead of loading it from the database.
 * `reading` is how the file's dates and numbers were decided for all its
 * sheets; without it this sheet decides on its own.
 */
export async function prepareImport(
  companyId: string, req: ImportRequest, known?: Company, reading?: Reading,
): Promise<ImportPreview & { plan: Plan; refs: Ref[] }> {
  if (!Object.hasOwn(IMPORT_KINDS, req.kind)) throw new Error(`Unknown import kind "${req.kind}".`);
  const spec = IMPORT_KINDS[req.kind];
  const allRows = req.rows ?? [];
  const rows = allRows.slice(0, maxRows());
  const opts: ImportOptions = { createMissingStakeholders: true, createMissingShareClasses: true, ...req.options };
  const read: Reading = reading ?? {
    dateOrder: readDates([req], opts.dateOrder).order,
    numberFormat: readNumbers(req, opts.numberFormat).format,
  };
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  const company = known ?? await Company.load(companyId);
  const plan = emptyPlan();
  if (req.kind === 'grants') {
    const quantityColumn = req.mapping.quantity;
    plan.poolSizeHint = findPlanSize(rows, typeof quantityColumn === 'number' ? quantityColumn : null, read.numberFormat);
  }
  const notices: Notice[] = [];
  // The page sends what parse kept of a long file; fileRowCount says how long the file was.
  const inFile = Math.max(allRows.length, opts.fileRowCount ?? 0);
  if (inFile > rows.length) {
    notices.push({ code: 'truncated', level: 'warning',
      text: `Only the first ${count(rows.length)} of ${count(inFile)} rows are included. Import the rest as a second file.` });
  }
  const memo = `Imported${opts.fileName ? ` from ${opts.fileName}` : ''}`;
  const excluded = new Set(opts.excludeRows ?? []);
  const seenCertificates = new Set<string>();
  const seenLabels = new Set<string>();
  const seenConvertibleLabels = new Set<string>();
  /** Fingerprints of rows earlier in this sheet, with the row number each came from and whether it was already there. */
  const seenFingerprints = new Map<string, { row: number; existing: boolean }>();
  const preview: PreviewRow[] = [];
  const refs: Ref[] = [];
  const headerRow = req.headerRowNumber ?? 1;
  const labelField = req.kind === 'captable' ? 'certificateNo' : 'label';
  const labelsInSheet = new Set<string>();
  rows.forEach((row, i) => {
    if (excluded.has(headerRow + 1 + i)) return;
    const label = coerceText(new RowContext(row, req.mapping, fields, read.dateOrder, read.numberFormat).raw(labelField)).value;
    if (label) labelsInSheet.add(key(label));
  });
  const recorded = req.kind === 'captable' ? company.certificates : req.kind === 'grants' ? company.awards : company.convertibles;
  const claims = new Claims(recorded, labelsInSheet);
  /** Rows the sheet adds, with what a record they may correct would share with them: checked once every row has had its match. */
  interface LookAlike { near: string; field: string; say: (r: OnFile) => string }
  const added: (LookAlike & { preview: PreviewRow })[] = [];
  /** The duplicate-in-file warning for a row with the contents of an earlier one. */
  const sameAs = (earlier: { row: number; existing: boolean }, what: string): string => (earlier.existing
    ? `Same ${what} as row ${earlier.row}, which is already on the cap table — this one is added as another`
    : `Same ${what} as row ${earlier.row} — both are imported`);

  rows.forEach((row, i) => {
    const rowNumber = headerRow + 1 + i;
    const ctx = new RowContext(row, req.mapping, fields, read.dateOrder, read.numberFormat);
    let action: PreviewRow['action'] = 'create';
    let summary: Record<string, string | number | null> = {};
    let holderId: string | null = null;
    let lookAlike: LookAlike | null = null;

    // Rows the person left out are not read at all.
    if (excluded.has(rowNumber)) {
      preview.push({ row: rowNumber, status: 'ok', action: 'skip', outcome: 'excluded', summary: { stakeholder: coerceText(ctx.raw('stakeholderName')).value },
        messages: [{ level: 'info', text: 'Left out by you', code: 'excluded' }] });
      return;
    }

    // Exports end with "Total" lines and summary sections; they carry no record.
    const planSizeLine = req.kind === 'grants' && isPlanSizeRow(row, read.numberFormat);
    if (ctx.isBlankInRequiredColumns || planSizeLine) {
      const label = row.find((c) => c != null && String(c).trim() !== '');
      preview.push({
        row: rowNumber, status: 'ok', action: 'skip', outcome: 'skip', summary: {},
        messages: [planSizeLine
          ? { level: 'info', code: 'plan-size-row', text: `Plan size line — read for the plan's authorized shares, not imported as a grant ("${String(label).slice(0, 40)}")` }
          : { level: 'info', code: 'blank-row', text: `Nothing in the required columns — skipped as a total or section row${label != null ? ` ("${String(label).slice(0, 40)}")` : ''}` }],
      });
      return;
    }
    warnIfTemplateExample(ctx);

    if (req.kind === 'stakeholders') {
      const name = ctx.text('stakeholderName');
      const email = ctx.text('email')?.toLowerCase() ?? null;
      const { type, relation } = readTypeAndRelation(ctx, name);
      const fieldsGiven = {
        email, title: ctx.text('title'), startDate: ctx.date('startDate'), terminationDate: ctx.date('terminationDate'),
        taxCountry: ctx.text('taxCountry'), taxState: ctx.text('taxState'), address: ctx.text('address'),
        phone: ctx.text('phone'), notes: ctx.text('notes'), department: ctx.text('department'),
      };
      summary = { stakeholder: name, email, type: type ?? (name ? guessStakeholderType(name) : null), relation, startDate: fieldsGiven.startDate };
      const match = name && !ctx.hasErrors ? findPerson(company, plan, name, email) : null;
      if (name && match?.ambiguous) ambiguousPerson(ctx, name, match.ambiguous);
      else if (name && match) {
        if (match.existing) {
          const existing = match.existing;
          holderId = existing.id;
          const updates: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fieldsGiven)) if (v != null) updates[k] = v;
          if (type) updates.type = type;
          if (relation) updates.relation = relation;
          // Only what differs from the record (and from earlier rows for the same person) is an update.
          const current = { ...existing.fields, ...(plan.stakeholderUpdates.get(existing.id) ?? {}) };
          const changes: string[] = [];
          for (const f of PERSON_FIELDS) {
            if (!(f in updates)) continue;
            const before = current[f] ?? null;
            if (before != null && key(String(before)) === key(String(updates[f]))) { delete updates[f]; continue; }
            changes.push(`${FIELD_WORDS[f]} ${shown(f, before)} → ${shown(f, updates[f])}`);
          }
          // Someone the file makes a Board member gets a seat. One who was a Board member already keeps
          // the seat as it is on file, or its absence: a seat an administrator took away stays away.
          const seated = relation === 'BOARD_MEMBER' && existing.relation !== 'BOARD_MEMBER' && !existing.seated;
          if (seated) Object.assign(updates, boardSeatOf(relation, fieldsGiven.startDate ?? existing.startDate ?? null,
            fieldsGiven.terminationDate ?? company.terminationDates.get(existing.id) ?? null));
          if (changes.length === 0 && !seated) {
            ctx.skip('Already up to date', { code: 'up-to-date' });
          } else {
            const pending = plan.stakeholderUpdates.get(existing.id);
            plan.stakeholderUpdates.set(existing.id, { ...(pending ?? {}), ...updates });
            const given = typeof updates.email === 'string' && !existing.email ? updates.email : null;
            if (given) plan.emailsGiven.set(given, existing);
            ctx.undo.push(() => {
              if (pending) plan.stakeholderUpdates.set(existing.id, pending); else plan.stakeholderUpdates.delete(existing.id);
              if (given) plan.emailsGiven.delete(given);
            });
            action = 'update';
            ctx.info(`Updates "${existing.name}": ${changes.join(', ')}${seated ? ' and gives them a board seat' : ''}`, { code: 'stakeholder-updated' });
          }
        } else if (match.planned) {
          // The same person again: later rows fill in and correct what the first gave.
          const planned = match.planned;
          holderId = String(planned.id);
          const before = { ...planned };
          if (email && !planned.email) planEmail(ctx, plan, planned, email);
          for (const [k, v] of Object.entries(fieldsGiven)) if (v != null && k !== 'email') planned[k] = v;
          if (type) planned.type = type;
          if (relation) {
            planned.relation = relation;
            Object.assign(planned, boardSeatOf(relation, (planned.startDate as string) ?? null, (planned.terminationDate as string) ?? null));
            const note = plan.people.get(holderId);
            if (note) note.guessed = false;
          }
          ctx.undo.push(() => { for (const k of Object.keys(planned)) delete planned[k]; Object.assign(planned, before); });
          ctx.warn('Appears more than once in the file — later rows update the first', { code: 'duplicate-in-file', field: 'stakeholderName' });
          action = 'update';
        } else {
          const planKey = email ? `email:${email}` : `name:${key(name)}`;
          const chosen = relation ?? chosenRelation(opts, name, email);
          if (!chosen) ctx.info(`No relationship given — defaulting to ${defaultRelation(name, null).toLowerCase()}`, { code: 'relationship-guessed', field: 'relation' });
          if (match.sameName.length) ctx.warn(sameNameText(name, match.sameName), { code: 'same-name', field: 'email' });
          const given = chosen ?? defaultRelation(name, null);
          const stakeholderId = id('stk');
          holderId = stakeholderId;
          planPerson(ctx, plan, planKey, {
            id: stakeholderId, companyId, name, type: type ?? guessStakeholderType(name),
            relation: given, entityGroupId: null, ...fieldsGiven, ...boardSeatOf(given, fieldsGiven.startDate, fieldsGiven.terminationDate), createdAt: now(),
          });
          plan.people.set(stakeholderId, { key: personKey(name, email), guessed: !chosen, sameName: match.sameName });
        }
      }
    }

    if (req.kind === 'captable') {
      const quantity = ctx.number('quantity');
      const price = ctx.price('pricePerShare');
      const issueDate = ctx.date('issueDate');
      const certificateNo = ctx.text('certificateNo');
      if (quantity === 0) ctx.skip('No shares outstanding on this certificate — nothing to import', { code: 'nothing-outstanding', field: 'quantity' });
      else if (quantity != null && quantity < 0) ctx.error('Shares must be greater than zero', { code: 'not-positive', field: 'quantity' });
      if (price == null && !ctx.skipReason) ctx.warn('No price per share — recorded at $0.00', { code: 'no-price', field: 'pricePerShare' });
      // The ledger records what the shares cost, which must fit too.
      if (quantity != null && price != null && Math.abs((quantity * price) / 10_000) > MAX_UNITS) {
        ctx.error('Shares times the price per share is more than the import can record', { code: 'bad-number', field: 'pricePerShare' });
      }
      const cls = quantity != null && quantity > 0
        ? resolveShareClass(ctx, company, plan, opts, price, quantity, issueDate) : null;
      const holder = resolveStakeholder(ctx, company, plan, opts, cls?.kind ?? null);
      holderId = holder?.id ?? null;
      const fingerprint = holder && cls && quantity != null && issueDate ? issuanceFingerprint(holder.id, cls.id, quantity, issueDate) : null;
      const found = holder?.created || cls?.created ? (certificateNo ? claims.find(certificateNo, null) : null) : claims.find(certificateNo, fingerprint);
      if (found?.match === 'existing' && !ctx.skipReason) ctx.alreadyThere();
      else if (found?.match === 'clash') ctx.error(`Certificate "${certificateNo}" already exists on the cap table with different details`, { code: 'number-taken', field: 'certificateNo' });
      else if (certificateNo && seenCertificates.has(key(certificateNo))) ctx.error(`Certificate "${certificateNo}" appears more than once in the file`, { code: 'duplicate-in-file', field: 'certificateNo' });
      else if (!certificateNo && fingerprint && seenFingerprints.has(fingerprint) && !ctx.skipReason) {
        ctx.warn(sameAs(seenFingerprints.get(fingerprint)!, 'holder, class, shares and issue date'), { code: 'duplicate-in-file', field: 'stakeholderName' });
      }
      if (certificateNo) seenCertificates.add(key(certificateNo));
      if (fingerprint && !seenFingerprints.has(fingerprint)) seenFingerprints.set(fingerprint, { row: rowNumber, existing: ctx.existing });
      const scheduleId = resolveVestingSchedule(ctx, company, plan, opts.certificateVestingScheduleId, false);
      if (found?.match === 'existing' && ctx.existing) {
        const was = found.record.details;
        if (price != null && price !== was.pricePerShare) ctx.differs('pricePerShare', perShare(Number(was.pricePerShare)), perShare(price));
        if (ctx.text('vestingSchedule') && scheduleId !== undefined && (scheduleId ?? null) !== (was.vestingSchedule ?? null)) {
          ctx.differs('vestingSchedule', scheduleName(company, plan, was.vestingSchedule as string | null), scheduleName(company, plan, scheduleId ?? null));
        }
        if (certificateNo && !was.certificateNo) ctx.differs('certificateNo', 'not numbered', `"${certificateNo}"`);
      }
      if (holder && cls && quantity != null && issueDate && !ctx.existing) {
        lookAlike = { near: nearKey(holder.id, issueDate), field: certificateNo ? 'certificateNo' : 'quantity',
          say: (r) => {
            const named = r.what === cls.id ? cls.name : className(company, plan, r.what);
            return r.amount === quantity
              ? `The cap table already has a ${named} certificate for ${holder.name} with these shares and this date${r.label ? ` (${r.label})` : ''} — if this row is that certificate${r.what !== cls.id ? '' : certificateNo ? ' renumbered' : ''}, leave the row out`
              : `The cap table already has a ${named} certificate for ${holder.name} dated ${issueDate} for ${count(r.amount)} shares${r.label ? ` (${r.label})` : ''} — if this row corrects it, leave the row out and correct that certificate instead`;
          } };
      }
      const vestingStart = ctx.date('vestingStartDate') ?? (scheduleId ? issueDate : null);
      const election = ctx.date('election83bFiledOn');
      if (scheduleId && !election) ctx.info('Restricted stock with no 83(b) date recorded', { code: 'no-83b', field: 'election83bFiledOn' });
      summary = {
        stakeholder: holder?.name ?? ctx.text('stakeholderName'), shareClass: cls?.name ?? ctx.text('shareClassName'),
        shares: quantity, price: price != null ? price / 1e6 : null, issueDate, certificate: certificateNo,
        vesting: scheduleId ? 'yes' : null,
      };
      if (ctx.clear && holder && cls && quantity != null && issueDate) {
        const issuanceId = id('iss');
        plan.issuances.push({
          id: issuanceId, companyId, certificateNo, stakeholderId: holder.id, shareClassId: cls.id,
          quantity, pricePerShare: price ?? 0, issueDate, status: 'OUTSTANDING',
          vestingScheduleId: scheduleId ?? null, vestingStartDate: vestingStart, earlyExercised: 0,
          election83bFiledOn: election, sourceAwardId: null, boardApprovalDate: ctx.date('boardApprovalDate'),
          notes: ctx.text('notes'), createdAt: now(),
        });
        plan.transactions.push({
          id: id('tx'), companyId, type: 'ISSUANCE', date: issueDate, stakeholderId: holder.id, counterpartyId: null,
          securityId: issuanceId, shareClassId: cls.id, quantity, pricePerShare: price ?? 0,
          amount: Math.round((quantity * (price ?? 0)) / 10_000), memo, createdAt: now(), createdBy: null,
        });
      }
    }

    if (req.kind === 'grants') {
      const type = ctx.value('awardType', coerceAwardType);
      const quantity = ctx.number('quantity');
      const grantDate = ctx.date('grantDate');
      const settlesForFree = type === 'RSU' || type === 'PHANTOM';
      let strike = ctx.price('strikePrice');
      if (settlesForFree) strike = 0;
      else if (type && strike == null) ctx.error(`${type} grants need a strike price`, { code: 'missing-strike', field: 'strikePrice' });
      if (quantity != null && quantity <= 0) ctx.error('Shares must be greater than zero', { code: 'not-positive', field: 'quantity' });
      const holder = resolveStakeholder(ctx, company, plan, opts, null);
      holderId = holder?.id ?? null;
      const label = ctx.text('label');
      const fingerprint = holder && type && quantity != null && grantDate ? awardFingerprint(holder.id, type, quantity, grantDate) : null;
      const found = holder?.created ? (label ? claims.find(label, null) : null) : claims.find(label, fingerprint);
      if (found?.match === 'existing') ctx.alreadyThere();
      else if (found?.match === 'clash') ctx.error(`Grant "${label}" already exists with different details — importing it again would duplicate it`, { code: 'number-taken', field: 'label' });
      else if (label && seenLabels.has(key(label))) ctx.error(`Grant "${label}" appears more than once in the file`, { code: 'duplicate-in-file', field: 'label' });
      else if (!label && fingerprint && seenFingerprints.has(fingerprint)) {
        ctx.warn(sameAs(seenFingerprints.get(fingerprint)!, 'holder, type, shares and grant date'), { code: 'duplicate-in-file', field: 'stakeholderName' });
      }
      if (label) seenLabels.add(key(label));
      if (fingerprint && !seenFingerprints.has(fingerprint)) seenFingerprints.set(fingerprint, { row: rowNumber, existing: ctx.existing });
      const scheduleId = resolveVestingSchedule(ctx, company, plan, opts.defaultVestingScheduleId, true);
      const poolId = resolvePool(ctx, company, plan, opts, quantity ?? 0);
      if (found?.match === 'existing') {
        const was = found.record.details;
        if (strike != null && ctx.raw('strikePrice') != null && !settlesForFree && strike !== was.strikePrice) ctx.differs('strikePrice', perShare(Number(was.strikePrice)), perShare(strike));
        if (ctx.text('poolName') && poolId && poolId !== was.poolName) ctx.differs('poolName', poolName(company, plan, was.poolName as string | null), poolName(company, plan, poolId));
        const expires = ctx.date('expirationDate');
        if (expires && expires !== was.expirationDate) ctx.differs('expirationDate', String(was.expirationDate ?? 'not set'), expires);
        if (label && !was.label) ctx.differs('label', 'not numbered', `"${label}"`);
      } else if (holder && type && quantity != null && grantDate) {
        lookAlike = { near: nearKey(holder.id, grantDate), field: label ? 'label' : 'quantity',
          say: (r) => {
            const typeName = awardTypeName(r.what);
            // "an NSO", "an RSU": an initialism is read letter by letter.
            const a = /^[AEIOU]|^[FHLMNRSX][A-Z]/.test(typeName) ? 'an' : 'a';
            return r.amount === quantity
              ? `The cap table already has ${a} ${typeName} grant for ${holder.name} with these shares and this date${r.label ? ` (${r.label})` : ''} — if this row is that grant${r.what !== type ? '' : label ? ' renumbered' : ''}, leave the row out`
              : `The cap table already has ${a} ${typeName} grant for ${holder.name} dated ${grantDate} for ${count(r.amount)} shares${r.label ? ` (${r.label})` : ''} — if this row corrects it, leave the row out and correct that grant instead`;
          } };
      }
      const exercised = ctx.number('exercisedQuantity') ?? 0;
      const cancelled = ctx.number('cancelledQuantity') ?? 0;
      if (quantity != null && exercised + cancelled > quantity) ctx.error('Exercised plus cancelled shares exceed the grant', { code: 'over-granted', field: 'exercisedQuantity' });
      const cancelledOn = ctx.date('cancellationDate');
      if (cancelledOn && grantDate && cancelledOn < grantDate) ctx.error('Cancellation date is before the grant date', { code: 'cancelled-before-grant', field: 'cancellationDate' });
      else if (cancelledOn && cancelled <= 0) ctx.info('Cancellation date given with no cancelled shares — not used', { code: 'unused-value', field: 'cancellationDate' });
      const vestingStart = ctx.date('vestingStartDate') ?? grantDate;
      let expiration = ctx.date('expirationDate');
      if (!expiration && grantDate && !settlesForFree) {
        // The term an option has when its paperwork says nothing, equity.optionTermYears.
        // An ISO cannot run past ten years by law, whatever the setting says. A grant
        // of February 29 expires on February 28 of a year that has no 29th.
        const years = type === 'ISO' ? Math.min(10, config().equity.optionTermYears) : config().equity.optionTermYears;
        expiration = addMonths(grantDate, years * 12);
        ctx.info(`No expiration date — assumed ${inWords(years)} year${years === 1 ? '' : 's'} from grant`, { code: 'expiration-assumed', field: 'expirationDate' });
      }
      summary = { stakeholder: holder?.name ?? ctx.text('stakeholderName'), type, shares: quantity,
        strike: strike != null ? strike / 1e6 : null, grantDate, vesting: scheduleId ? 'yes' : null, label };
      if (ctx.clear && holder && type && quantity != null && grantDate && scheduleId && poolId) {
        const awardId = id('awa');
        const status = cancelled >= quantity ? 'CANCELLED' : exercised + cancelled >= quantity ? 'EXERCISED' : 'OUTSTANDING';
        plan.awards.push({
          id: awardId, companyId, label, stakeholderId: holder.id, poolId, type, quantity, strikePrice: strike ?? 0,
          grantDate, vestingStartDate: vestingStart, vestingScheduleId: scheduleId, status, expirationDate: expiration,
          ptepMonths: config().equity.postTerminationExerciseMonths, earlyExerciseAllowed: ctx.bool('earlyExercise') ? 1 : 0, exercisedQuantity: exercised,
          cancelledQuantity: cancelled, boardApprovalDate: ctx.date('boardApprovalDate'), acceptedDate: null,
          fmvAtGrant: ctx.price('fmvAtGrant') ?? strike ?? 0, rsuLiquidityCondition: 0, notes: ctx.text('notes'), createdAt: now(),
        });
        plan.transactions.push({
          id: id('tx'), companyId, type: 'GRANT', date: grantDate, stakeholderId: holder.id, counterpartyId: null,
          securityId: awardId, shareClassId: null, quantity, pricePerShare: strike ?? 0, amount: null, memo,
          createdAt: now(), createdBy: null,
        });
        // Past cap tables show the options outstanding until they were exercised. With no date
        // the exercise is dated the grant, which reads every past cap table as today's.
        if (exercised > 0) {
          const exercisedOn = ctx.date('exerciseDate');
          const on = exercisedOn && exercisedOn >= grantDate ? exercisedOn : grantDate;
          if (exercisedOn && exercisedOn < grantDate) ctx.warn('Exercise date is before the grant date — dated to the grant instead', { code: 'exercise-before-grant', field: 'exerciseDate' });
          else if (!exercisedOn) ctx.info(`No exercise date — the ${count(exercised)} exercised options count as exercised from the grant date`, { code: 'exercise-date-assumed', field: 'exerciseDate' });
          plan.transactions.push({
            id: id('tx'), companyId, type: 'EXERCISE', date: on, stakeholderId: holder.id, counterpartyId: null,
            securityId: awardId, shareClassId: null, quantity: roundShares(exercised * company.splitFactor(grantDate, on)), pricePerShare: strike ?? 0, amount: null,
            memo: exercisedOn ? memo : `${memo} (no exercise date; dated to the grant)`, createdAt: now(), createdBy: null,
          });
        }
        // The ISO $100K test and the stock comp report place cancelled shares in their year by the
        // ledger's date. A leaver's grant that names none lost its shares when the holder left.
        if (cancelled > 0) {
          const left = company.terminationDates.get(holder.id) ?? null;
          const on = cancelledOn ?? (left && left >= grantDate && left <= today() ? left : null);
          if (on) {
            plan.transactions.push({
              id: id('tx'), companyId, type: cancelledOn ? 'CANCELLATION' : 'FORFEITURE', date: on, stakeholderId: holder.id, counterpartyId: null,
              securityId: awardId, shareClassId: null, quantity: roundShares(cancelled * company.splitFactor(grantDate, on)), pricePerShare: null, amount: null,
              memo: cancelledOn ? memo : `${memo} (dated to the holder's termination)`, createdAt: now(), createdBy: null,
            });
            if (!cancelledOn) ctx.info(`${count(cancelled)} cancelled shares dated to ${holder.name}'s termination on ${on}`, { code: 'cancellation-dated-to-termination', field: 'cancellationDate' });
          } else {
            ctx.info(`No cancellation date for the ${count(cancelled)} cancelled shares — add one to place them in the right year for the ISO $100K test`,
              { code: 'cancellation-date-missing', field: 'cancellationDate' });
          }
        }
      }
    }

    if (req.kind === 'convertibles') {
      const instrument = ctx.value('instrument', coerceInstrument);
      const principal = ctx.money('principal');
      const issueDate = ctx.date('issueDate');
      if (principal != null && principal <= 0) ctx.error('Principal must be greater than zero', { code: 'not-positive', field: 'principal' });
      const holder = resolveStakeholder(ctx, company, plan, opts, 'PREFERRED');
      holderId = holder?.id ?? null;
      const isSafe = instrument === 'SAFE_POST' || instrument === 'SAFE_PRE';
      const interest = ctx.percent('interestRate');
      if (isSafe && interest) ctx.info('SAFEs do not bear interest — the rate was ignored', { code: 'interest-ignored', field: 'interestRate' });
      let cap = ctx.money('valuationCap');
      if (cap === 0) cap = null;                                   // exports write 0 for "uncapped"
      const discount = ctx.percent('discount') ?? 0;
      const status = ctx.value('status', coerceConvertibleStatus) ?? 'OUTSTANDING';
      if (!cap && !discount && status === 'OUTSTANDING') ctx.warn('No valuation cap or discount — converts at the round price', { code: 'no-cap-or-discount', field: 'valuationCap' });
      if (status !== 'OUTSTANDING') ctx.info(`Recorded as ${status.toLowerCase()} — excluded from the cap table`, { code: 'not-outstanding', field: 'status' });
      const instrumentText = String(ctx.raw('instrument') ?? '').toLowerCase().trim();
      if (instrument && (instrumentText === 'safe' || /^post[\s-]?money$/.test(instrumentText))) {
        ctx.info(`"${ctx.raw('instrument')}" treated as a post-money SAFE`, { code: 'instrument-assumed', field: 'instrument' });
      }
      const label = ctx.text('label');
      const fingerprint = holder && instrument && principal != null && issueDate ? convertibleFingerprint(holder.id, instrument, principal, issueDate) : null;
      const found = holder?.created ? (label ? claims.find(label, null) : null) : claims.find(label, fingerprint);
      const kindName = instrument ? instrumentName(instrument) : 'instrument';
      if (found?.match === 'existing') ctx.alreadyThere();
      else if (found?.match === 'clash') ctx.error(`Instrument "${label}" already exists with different details — importing it again would duplicate it`, { code: 'number-taken', field: 'label' });
      else if (label && seenConvertibleLabels.has(key(label))) ctx.error(`Instrument "${label}" appears more than once in the file`, { code: 'duplicate-in-file', field: 'label' });
      else if (!label && fingerprint && seenFingerprints.has(fingerprint)) {
        const earlier = seenFingerprints.get(fingerprint)!;
        ctx.warn(earlier.existing
          ? `The same ${kindName} (holder, amount and date) as row ${earlier.row}, which is already on the cap table — this one is added as another`
          : `The same ${kindName} (holder, amount and date) as row ${earlier.row} — both are imported`, { code: 'duplicate-in-file', field: 'stakeholderName' });
      }
      if (label) seenConvertibleLabels.add(key(label));
      if (fingerprint && !seenFingerprints.has(fingerprint)) seenFingerprints.set(fingerprint, { row: rowNumber, existing: ctx.existing });
      if (found?.match === 'existing') {
        const was = found.record.details;
        // A column the sheet has speaks for every row: an empty cap there is no cap.
        if (req.mapping.valuationCap != null && (cap ?? null) !== (was.valuationCap ?? null)) {
          ctx.differs('valuationCap', was.valuationCap == null ? 'no cap' : usd(Number(was.valuationCap)), cap == null ? 'no cap' : usd(cap));
        }
        if (req.mapping.discount != null && Math.abs(discount - Number(was.discount ?? 0)) > 1e-9) {
          ctx.differs('discount', `${roundPercent(Number(was.discount ?? 0))}%`, `${roundPercent(discount)}%`);
        }
        if (label && !was.label) ctx.differs('label', 'not numbered', `"${label}"`);
      } else if (holder && instrument && principal != null && issueDate) {
        lookAlike = { near: nearKey(holder.id, issueDate), field: label ? 'label' : 'principal',
          say: (r) => {
            const named = r.what === instrument ? kindName : instrumentName(r.what);
            return r.amount === principal
              ? `The cap table already has a ${named} from ${holder.name} for this amount on this date${r.label ? ` (${r.label})` : ''} — if this row is that one${r.what !== instrument ? '' : label ? ' renumbered' : ''}, leave the row out`
              : `The cap table already has a ${named} from ${holder.name} dated ${issueDate} for ${usd(r.amount)}${r.label ? ` (${r.label})` : ''} — if this row corrects it, leave the row out and correct that one instead`;
          } };
      }
      summary = { stakeholder: holder?.name ?? ctx.text('stakeholderName'), instrument, label,
        principal: principal != null ? principal / 100 : null, issueDate, cap: cap != null ? cap / 100 : null, discount, status };
      // A settled instrument leaves the cap table the day it settled; with no date given, on its issue date.
      const settledGiven = status !== 'OUTSTANDING' ? ctx.date('settledDate') : null;
      const settledOn = settledGiven && issueDate && settledGiven >= issueDate ? settledGiven : issueDate;
      if (settledGiven && issueDate && settledGiven < issueDate) ctx.warn('Settled before it was issued — dated to the issue date instead', { code: 'settled-before-issue', field: 'settledDate' });
      else if (status !== 'OUTSTANDING' && !settledGiven) ctx.info(`No date it was ${status.toLowerCase()} — left out of every past cap table too`, { code: 'settled-date-missing', field: 'settledDate' });
      if (ctx.clear && holder && instrument && principal != null && issueDate) {
        const convertibleId = id('cnv');
        plan.convertibles.push({
          id: convertibleId, companyId, stakeholderId: holder.id, label, instrument, principal, issueDate,
          valuationCap: cap, discount, interestRate: isSafe ? 0 : (interest ?? 0),
          compounding: ctx.value('compounding', coerceCompounding) ?? 'SIMPLE',
          maturityDate: isSafe ? null : ctx.date('maturityDate'), mfn: ctx.bool('mfn') ? 1 : 0,
          proRataRight: ctx.bool('proRata') ? 1 : 0, status, convertedIntoShareClassId: null,
          convertedOn: status === 'CONVERTED' ? settledOn : null, qualifiedFinancingMinimum: null, notes: ctx.text('notes'), createdAt: now(),
        });
        plan.transactions.push({
          id: id('tx'), companyId, type: 'ISSUANCE', date: issueDate, stakeholderId: holder.id, counterpartyId: null,
          securityId: convertibleId, shareClassId: null, quantity: null, pricePerShare: null, amount: principal,
          memo: `${memo} (${instrument})`, createdAt: now(), createdBy: null,
        });
        if (status !== 'OUTSTANDING') {
          plan.transactions.push({
            id: id('tx'), companyId, type: status === 'CONVERTED' ? 'CONVERSION' : status === 'REPAID' ? 'REPAYMENT' : 'CANCELLATION', date: settledOn,
            stakeholderId: holder.id, counterpartyId: null, securityId: convertibleId, shareClassId: null, quantity: null, pricePerShare: null,
            amount: status === 'CANCELLED' ? null : principal, memo: settledGiven ? memo : `${memo} (no settlement date; dated to the issue)`, createdAt: now(), createdBy: null,
          });
        }
      }
    }

    // A row already on the cap table is skipped whatever else is wrong with it; a row with errors —
    // or nothing to import — is skipped too, so nothing it planned may survive.
    let outcome: RowOutcome = action === 'update' ? 'update' : 'add';
    if (ctx.existing || (ctx.skipReason && !ctx.hasErrors)) {
      ctx.messages = [ctx.skipReason!, ...(ctx.existing ? ctx.notes : [])];
      action = 'skip';
      outcome = ctx.existing || ctx.skipReason!.code === 'up-to-date' ? 'existing' : 'skip';
    }
    if (ctx.hasErrors || ctx.skipReason) for (const revert of ctx.undo.reverse()) revert();

    const status: PreviewRow['status'] = ctx.hasErrors ? 'error'
      : ctx.messages.some((m) => m.level === 'warning') ? 'warning' : 'ok';
    if (status === 'error') outcome = 'error';
    else if (holderId && action !== 'skip') refs.push({ stakeholderId: holderId, row: rowNumber });
    const done: PreviewRow = { row: rowNumber, status, action: ctx.hasErrors ? 'skip' : action, outcome, summary, messages: ctx.messages };
    preview.push(done);
    if (lookAlike && outcome === 'add') added.push({ ...lookAlike, preview: done });
  });

  // Once every row has had its match: an added row like a record no row matched may be what it corrects or renumbers.
  for (const a of added) {
    const like = claims.unmatched(a.near);
    if (like.length === 0) continue;
    a.preview.messages.push({ level: 'warning', code: 'similar-on-record', field: a.field, text: a.say(like[0]) });
    if (a.preview.status === 'ok') a.preview.status = 'warning';
  }

  // Plans created here were accumulated grant by grant; the sheet's stated size wins when it covers them.
  for (const pool of plan.newPools.values()) {
    if (plan.poolSizeHint == null) continue;
    if (plan.poolSizeHint >= pool.authorized) pool.authorized = plan.poolSizeHint;
    else {
      const creator = preview.find((r) => r.messages.some((m) => m.text.startsWith(`Creates equity plan "${String(pool.name)}"`)));
      creator?.messages.push({ level: 'warning', code: 'plan-size-smaller', field: 'poolName',
        text: `The sheet says ${count(plan.poolSizeHint)} authorized shares but the grants total ${count(pool.authorized)} — kept the grants total` });
      if (creator && creator.status === 'ok') creator.status = 'warning';
    }
  }

  // Every row counts once: as an error, as skipped (an existing row may carry a warning), as a warning, or as ok.
  const errors = preview.filter((r) => r.status === 'error').length;
  const skipped = preview.filter((r) => r.status !== 'error' && r.action === 'skip').length;
  const warnings = preview.filter((r) => r.status === 'warning' && r.action !== 'skip').length;
  return {
    kind: req.kind, rows: preview,
    counts: {
      total: preview.length, ok: preview.length - errors - warnings - skipped, warnings, errors, skipped, willImport: preview.length - errors - skipped,
      existing: preview.filter((r) => r.outcome === 'existing').length, excluded: preview.filter((r) => r.outcome === 'excluded').length,
    },
    creates: {
      stakeholders: [...plan.newStakeholders.values()].map((s) => String(s.name)),
      shareClasses: [...plan.newShareClasses.values()].map((c) => String(c.name)),
      vestingSchedules: [...plan.newSchedules.values()].map((s) => String(s.name)),
      pools: [...plan.newPools.values()].map((p) => String(p.name)),
    },
    notices,
    plan, refs,
  };
}

/** How the update messages name a stakeholder's fields. */
export const FIELD_WORDS: Record<typeof PERSON_FIELDS[number], string> = {
  email: 'email', type: 'type', relation: 'relationship', title: 'title', startDate: 'start date', terminationDate: 'termination date',
  taxCountry: 'tax country', taxState: 'tax state', address: 'address', phone: 'phone', notes: 'notes', department: 'department',
};
/** A field's value as an update message shows it: words for codes, a dash for nothing, long text cut short. */
export function shown(field: string, v: unknown): string {
  if (v == null || v === '') return '—';
  const s = String(v);
  if (field === 'relation' || field === 'type') return RELATION_WORDS[s] ?? s;
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** A schedule as a message names it, whether on record or created by this import. */
function scheduleName(company: Company, plan: Plan, id: string | null): string {
  if (!id) return 'none';
  const name = company.schedules.find((v) => v.id === id)?.name ?? [...plan.newSchedules.values()].find((v) => v.id === id)?.name;
  return name ? `"${String(name)}"` : 'another schedule';
}
/** A share class as a message names it, whether on record or created by this import. */
function className(company: Company, plan: Plan, id: string): string {
  const cls = [...company.shareClasses.values()].find((c) => c.id === id) ?? [...plan.newShareClasses.values()].find((c) => c.id === id);
  return cls ? String(cls.name) : 'share';
}
/** An award type as a message names it: ISO, RSU, phantom, growth share. */
const awardTypeName = (type: string): string => (type === 'PHANTOM' ? 'phantom' : type === 'GROWTH_SHARE' ? 'growth share' : type);
/** An instrument as a message names it: post-money SAFE, convertible note. */
const instrumentName = (instrument: string): string =>
  INSTRUMENT_NAMES[instrument]?.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) ?? 'instrument';
/** A plan as a message names it, whether on record or created by this import. */
function poolName(company: Company, plan: Plan, id: string | null): string {
  if (!id) return 'none';
  const name = company.pools.find((p) => p.id === id)?.name ?? [...plan.newPools.values()].find((p) => p.id === id)?.name;
  return name ? `"${String(name)}"` : 'another plan';
}
const roundPercent = (fraction: number): number => Math.round(fraction * 10_000) / 100;

const updatedPeople = (plan: Plan): number => [...plan.stakeholderUpdates.values()].filter((u) => Object.keys(u).length > 0).length;

/** Writes what a sheet was prepared into, with its ledger entries, in one transaction. */
async function writePlan(companyId: string, req: ImportRequest, prepared: ImportPreview & { plan: Plan }, createdBy: string | null): Promise<ImportResult> {
  const { plan } = prepared;
  const importId = id('imp');

  // Everything from one file lands together or not at all. Rows go in many to a statement, so a
  // long sheet costs a few round trips rather than one per record.
  await transaction(async () => {
    await insertMany('stakeholders', [...plan.newStakeholders.values()]);
    for (const [stakeholderId, updates] of plan.stakeholderUpdates) if (Object.keys(updates).length) await update('stakeholders', stakeholderId, updates);
    await insertMany('share_classes', [...plan.newShareClasses.values()]);
    await insertMany('vesting_schedules', [...plan.newSchedules.values()]);
    await insertMany('pools', [...plan.newPools.values()]);
    await insertMany('issuances', plan.issuances);
    await insertMany('awards', plan.awards);
    await insertMany('convertibles', plan.convertibles);
    await insertMany('transactions', plan.transactions.map((t) => ({ ...t, createdBy })));
    await insert('imports', {
      id: importId, companyId, kind: req.kind, fileName: req.options?.fileName ?? null,
      rowCount: prepared.counts.total, importedCount: prepared.counts.willImport,
      skippedCount: prepared.counts.errors + prepared.counts.skipped,
      summary: JSON.stringify({ creates: prepared.creates, counts: prepared.counts }),
      createdBy, createdAt: now(),
    });
  });

  const { plan: _plan, refs: _refs, ...preview } = prepared as ImportPreview & { plan: Plan; refs?: Ref[] };
  void _plan; void _refs;
  return {
    ...preview, importId,
    imported: {
      stakeholders: plan.newStakeholders.size, shareClasses: plan.newShareClasses.size,
      issuances: plan.issuances.length, awards: plan.awards.length, convertibles: plan.convertibles.length,
      vestingSchedules: plan.newSchedules.size, pools: plan.newPools.size,
      warrants: 0, valuations: 0, stockSplits: 0, poolAdjustments: 0, events: 0,
      updated: { stakeholders: updatedPeople(plan) },
    },
  };
}

/** The count a run with errors gives, as the commit refuses it. */
const rowsHaveErrors = (n: number): string => `${n} row${n === 1 ? ' has' : 's have'} errors. Fix them or choose to skip rows with errors.`;

/** Rows with errors stop the whole commit. */
export class RowsNeedFixing extends Error {}

export async function commitImport(companyId: string, req: ImportRequest, createdBy: string | null): Promise<ImportResult> {
  const prepared = await prepareImport(companyId, req);
  if (prepared.counts.errors > 0 && !req.options?.skipRowsWithErrors) throw new RowsNeedFixing(rowsHaveErrors(prepared.counts.errors));
  return writePlan(companyId, req, prepared, createdBy);
}

// ---------------------------------------------------------------------------
// Workbooks: the sheets of one file or several, applied together
// ---------------------------------------------------------------------------

export interface WorkbookSheet extends ImportRequest {
  sheetName: string;
  /** The file the sheet came from, when several files are imported together. */
  file?: string | null;
}
export interface WorkbookSheetResult {
  sheetName: string;
  file: string | null;
  /** What the sheet holds; for an OCF package, the section (src/ocf/read.ts, OCF_SECTIONS). */
  kind: ImportKind | OcfSection;
  /** True when the sheet has errors the options do not allow skipping — nothing from it is applied. */
  blocked: boolean;
  /** How the sheet's dates and numbers were read. */
  dateOrder: DateOrder;
  numberFormat: NumberFormat;
  /** Headers of the columns no field reads, so the page can say what is left behind. */
  columnsNotImported: string[];
  preview: Omit<ImportPreview, 'kind'> & { kind: ImportKind | OcfSection; importId?: string; imported?: ImportResult['imported'] };
}
/** A person the import creates, for the page to confirm how they relate to the company. */
export interface NewPerson {
  /** What options.relationships takes for them: their email, or their name in lower case. */
  key: string;
  name: string;
  email: string | null;
  type: string;
  relation: string;
  /** No file said how they relate to the company: the relationship is a guess. */
  guessed: boolean;
  /** People with the same name and another email; the import keeps them apart. `onRecord` is false for one this import also creates. */
  /** `stakeholderId` names the one on record. */
  sameName: { name: string; email: string | null; onRecord: boolean; stakeholderId?: string }[];
  /** Every row that names them. */
  rows: { file: string | null; sheet: string; row: number }[];
  /** For an OCF package: the stakeholder's id in the package, the key options.ocfPeople takes. */
  ocfId?: string;
}
/** How one file's dates and numbers were read, for the line that says so above the rows. */
export interface ReadAs {
  file: string | null;
  sheets: string[];
  /** 'mixed' when the file has dates only day-first reads and dates only month-first reads: each is read the way it can be. */
  dateOrder: 'MDY' | 'DMY' | 'mixed';
  dateDecidedBy: DateReading['decidedBy'];
  dateEvidence: SheetEvidence | null;
  /** Dates like 03/04/2024 that the order decides. */
  ambiguousDates: number;
  /** Dates written as text (an Excel date cell has no order to decide). */
  textDates: number;
  numberFormat: NumberFormat | 'mixed';
  /** 'given' only when the format sent for a sheet is not the one its values show. */
  numberDecidedBy: NumberFormatReading['decidedBy'] | 'given';
  numberEvidence: SheetEvidence | null;
  /** A sheet has values only 1,234.56 reads and others only 1.234,56 reads: the larger number of them decided. */
  numberMixed: boolean;
}
/** A share class whose authorized shares the import raised, at options.raiseAuthorized. */
export interface Raised { shareClassId: string; name: string; from: number; to: number }

export interface WorkbookResult {
  sheets: WorkbookSheetResult[];
  counts: ImportCounts;
  creates: ImportPreview['creates'];
  imported: ImportResult['imported'];
  importIds: string[];
  /** Files in the order they were given. */
  files: (string | null)[];
  newPeople: NewPerson[];
  readAs: ReadAs[];
  /** What the cap table would warn about after the import that it does not warn about now. */
  notices: Notice[];
  raised: Raised[];
  /** Names this review: send it with the commit, which is refused unless it would write exactly what was reviewed. */
  reviewToken: string;
  /** An OCF package's reading: what it is, what is not imported, what the company takes from it (docs/importing.md, "OCF packages"). */
  ocf?: OcfSummary;
}

/** What the import as a whole asks for, beside the sheets. */
export interface WorkbookExtras {
  /** Share classes (ids, or names for classes the import creates) whose authorized shares rise to what the import leaves them needing. */
  raiseAuthorized?: string[];
  /** The counts the person reviewed: a commit whose own run comes out differently is refused, so nothing unseen is written. */
  expectedCounts?: Partial<ImportCounts>;
  /** The reviewToken of the preview the person approved: stricter than expectedCounts, it covers every row's outcome. */
  reviewToken?: string;
  /** An OCF package instead of sheets (src/ocf/plan.ts). */
  ocf?: OcfRun;
}

const KIND_SEQUENCE: ImportKind[] = ['stakeholders', 'captable', 'grants', 'convertibles'];
const IMPORTED_KEYS: (keyof ImportedCounts)[] = ['stakeholders', 'shareClasses', 'issuances', 'awards', 'convertibles', 'vestingSchedules', 'pools',
  'warrants', 'valuations', 'stockSplits', 'poolAdjustments', 'events'];
export const EMPTY_IMPORTED = (): ImportResult['imported'] => ({
  stakeholders: 0, shareClasses: 0, issuances: 0, awards: 0, convertibles: 0, vestingSchedules: 0, pools: 0,
  warrants: 0, valuations: 0, stockSplits: 0, poolAdjustments: 0, events: 0, updated: { stakeholders: 0 },
});

/** A short fingerprint of what a review covered. */
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);

class DryRunRollback extends Error {
  result: WorkbookResult;
  constructor(result: WorkbookResult) { super('dry run'); this.result = result; }
}

/** The commit came out differently from the review it was asked for under: the company changed in between. */
export class StaleReview extends Error {
  counts: ImportCounts;
  constructor(counts: ImportCounts) { super('The cap table changed since you checked these rows. Check again'); this.counts = counts; }
}
/** The commit carries other rows, mappings or options than the review it names: what would be written was never shown. */
export class NotReviewed extends Error {
  constructor() { super('These rows were checked with other settings or other cells. Check them again before importing'); }
}

/**
 * How every sheet's dates and numbers are read. Dates are decided once per
 * file, from all its sheets together, unless a sheet's options name the order;
 * numbers once per sheet, from the format given for it or its own values.
 */
function decideReadings(sheets: WorkbookSheet[]): { readings: Map<WorkbookSheet, Reading>; readAs: ReadAs[] } {
  const readings = new Map<WorkbookSheet, Reading>();
  const readAs: ReadAs[] = [];
  const files = [...new Set(sheets.map((s) => s.file ?? null))];
  for (const file of files) {
    const group = sheets.filter((s) => (s.file ?? null) === file);
    const dates = readDates(group);
    // Tabs kept by different people may write dates differently: when the file's tabs disagree, each
    // decides from its own dates, and one that cannot ('auto') has every date that reads two ways flagged.
    const own = dates.order === 'auto' && group.length > 1 ? new Map(group.map((s) => [s, readDates([s])])) : null;
    const numbers = new Map(group.map((s) => [s, readNumbers(s, s.options?.numberFormat)]));
    for (const s of group) {
      const setting = s.options?.dateOrder ?? 'auto';
      const mine = own?.get(s);
      const order = setting !== 'auto' ? setting : mine ? (mine.decidedBy === 'file' ? mine.order : 'auto') : dates.order;
      readings.set(s, { dateOrder: order, numberFormat: numbers.get(s)!.format });
    }
    const settings = new Set(group.map((s) => s.options?.dateOrder ?? 'auto'));
    const chosen = settings.size === 1 && !settings.has('auto') ? readDates(group, [...settings][0]) : dates;
    const formats = new Set([...numbers.values()].map((n) => n.format));
    const telling = group.map((s) => ({ s, n: numbers.get(s)! })).find(({ n }) => n.evidence);
    readAs.push({
      file, sheets: group.map((s) => s.sheetName),
      dateOrder: chosen.order === 'auto' ? 'mixed' : chosen.order === 'DMY' ? 'DMY' : 'MDY',
      dateDecidedBy: chosen.decidedBy, dateEvidence: chosen.evidence, ambiguousDates: chosen.ambiguous, textDates: chosen.textDates,
      numberFormat: formats.size === 1 ? [...formats][0] : 'mixed',
      numberDecidedBy: (telling ? numbers.get(telling.s)! : numbers.get(group[0])!).decidedBy,
      numberEvidence: telling ? { text: telling.n.evidence!.text, sheet: telling.s.sheetName, row: telling.n.evidence!.row } : null,
      numberMixed: [...numbers.values()].some((n) => n.mixed),
    });
  }
  return { readings, readAs };
}

/** The cap table's warnings today, with its share classes, to tell what an import adds. */
async function capTableCheck(companyId: string) {
  const table = computeCapTable(await loadCompanyData(companyId), { asOf: today() });
  return { warnings: table.warnings, classes: table.classes };
}

/** What a class needs authorized to cover its outstanding shares and what it must keep for plans, warrants and conversion. */
const needed = (c: { outstanding: number; reserved: number }): number => Math.ceil(roundShares(c.outstanding + c.reserved));

/**
 * Raises the authorized shares of the classes asked for to what they need,
 * where they need more. Only the company's own classes are matched, by id or
 * by name (a class the import creates has no id until it is written).
 */
async function raiseAuthorized(companyId: string, wanted: string[]): Promise<Raised[]> {
  const asked = new Set(wanted.map((w) => key(w)));
  const raised: Raised[] = [];
  for (const c of (await capTableCheck(companyId)).classes) {
    if (!asked.has(key(c.shareClassId)) && !asked.has(key(c.name))) continue;
    const to = needed(c);
    if (to <= c.authorized) continue;
    await update('share_classes', c.shareClassId, { authorized: to });
    raised.push({ shareClassId: c.shareClassId, name: c.name, from: c.authorized, to });
  }
  return raised;
}

/** The cap table's warnings after the import that it did not give before, each class's with the raise that settles it. */
function newNotices(before: string[], after: Awaited<ReturnType<typeof capTableCheck>>, createdClasses: Set<string>): Notice[] {
  const seen = new Set(before);
  const notices: Notice[] = [];
  const claimed = new Set<string>();
  for (const c of after.classes) {
    const warning = after.warnings.find((w) => w.startsWith(`${c.name}: `));
    if (!warning) continue;
    claimed.add(warning);
    if (seen.has(warning)) continue;
    const to = needed(c);
    const created = createdClasses.has(c.shareClassId);
    notices.push({
      code: 'over-authorized', level: 'warning',
      text: c.reserved > 0
        ? `After this import ${c.name} needs ${count(to)} shares — ${count(c.outstanding)} outstanding and ${count(c.reserved)} kept for plans, warrants and conversion — but has ${count(c.authorized)} authorized`
        : `After this import ${c.name} has ${count(c.outstanding)} shares outstanding but ${count(c.authorized)} authorized`,
      fix: { option: 'raiseAuthorized', value: created ? c.name : c.shareClassId, shareClassId: created ? null : c.shareClassId, className: c.name, to },
    });
  }
  for (const w of after.warnings) {
    if (seen.has(w) || claimed.has(w)) continue;
    notices.push({ code: /^Pool "/.test(w) ? 'pool-over-allocated' : 'cap-table', level: 'warning', text: w.replace(/\.$/, '') });
  }
  return notices;
}

/**
 * Applies every sheet in dependency order — people, then certificates, grants
 * and convertibles — inside one transaction, whatever file each came from and
 * in whatever order the files were given. A certificate sheet finds the
 * stakeholders a people sheet created, so a stakeholder report and a cap table
 * workbook dropped together are matched person by person, and everything lands
 * or nothing does. With `dryRun` the same run happens and is rolled back, which
 * makes the preview exact: later sheets are checked against what earlier ones
 * would add, and the cap table's warnings after the import are known before it.
 */
export async function runWorkbook(
  companyId: string, sheets: WorkbookSheet[], createdBy: string | null, dryRun: boolean, extras: WorkbookExtras = {},
): Promise<WorkbookResult> {
  const ordered = [...sheets].sort((a, b) => KIND_SEQUENCE.indexOf(a.kind) - KIND_SEQUENCE.indexOf(b.kind));
  const { readings, readAs } = decideReadings(sheets);
  // What was asked: every sheet as sent, with its options, and the raises accepted. A commit names the review it follows by this and by what the run came to.
  const asked = extras.ocf
    ? digest(['ocf', extras.ocf.file, createHash('sha256').update(JSON.stringify(extras.ocf.pkg)).digest('base64url'), extras.ocf.exclude,
      extras.ocf.relationships ?? {}, [...(extras.ocf.ocfPeople ?? new Map()).entries()], !!extras.ocf.skipRowsWithErrors, extras.raiseAuthorized ?? [],
      extras.ocf.companyFill ?? null])
    : digest([sheets.map((s) => [s.file ?? null, s.sheetName, s.kind, s.headers, s.rows, s.mapping, s.headerRowNumber ?? 1, s.options ?? {}]), extras.raiseAuthorized ?? []]);
  const run = async (): Promise<WorkbookResult> => {
    const before = await capTableCheck(companyId);
    const results: WorkbookSheetResult[] = [];
    const imported = EMPTY_IMPORTED();
    const importIds: string[] = [];
    const people = new Map<string, NewPerson>();
    const createdClasses = new Set<string>();
    let ocf: OcfSummary | undefined;
    if (extras.ocf) {
      // An OCF package is imported on its own: its sections stand in for the sheets (src/ocf/plan.ts).
      const { runOcf } = await import('../ocf/plan.ts');
      const out = await runOcf(companyId, extras.ocf, createdBy);
      results.push(...out.sections);
      for (const k of IMPORTED_KEYS) imported[k] += out.imported[k];
      imported.updated.stakeholders += out.imported.updated.stakeholders;
      if (out.importId) importIds.push(out.importId);
      for (const p of out.newPeople) people.set(p.ocfId ?? p.key, p);
      for (const c of out.createdClasses) createdClasses.add(c);
      ocf = out.summary;
    }
    for (const sheet of extras.ocf ? [] : ordered) {
      const reading = readings.get(sheet)!;
      const prepared = await prepareImport(companyId, sheet, undefined, reading);
      for (const s of prepared.plan.newStakeholders.values()) {
        const note = prepared.plan.people.get(String(s.id));
        people.set(String(s.id), {
          key: note?.key ?? personKey(String(s.name), s.email ? String(s.email) : null), name: String(s.name), email: s.email ? String(s.email) : null,
          type: String(s.type), relation: String(s.relation), guessed: note?.guessed ?? false,
          sameName: (note?.sameName ?? []).map((o) => ({ name: o.name, email: o.email, onRecord: !people.has(o.stakeholderId),
            ...(people.has(o.stakeholderId) ? {} : { stakeholderId: o.stakeholderId }) })), rows: [],
        });
      }
      for (const ref of prepared.refs) people.get(ref.stakeholderId)?.rows.push({ file: sheet.file ?? null, sheet: sheet.sheetName, row: ref.row });
      for (const c of prepared.plan.newShareClasses.values()) createdClasses.add(String(c.id));

      const used = new Set(Object.values(sheet.mapping).filter((v): v is number => typeof v === 'number'));
      const shape = {
        sheetName: sheet.sheetName, file: sheet.file ?? null, kind: sheet.kind, dateOrder: reading.dateOrder, numberFormat: reading.numberFormat,
        columnsNotImported: sheet.headers.map((h, i) => (used.has(i) || h == null || String(h).trim() === '' ? null : String(h).trim())).filter((h): h is string => h !== null),
      };
      const blocked = prepared.counts.errors > 0 && !sheet.options?.skipRowsWithErrors;
      if (blocked) {
        const { plan: _plan, refs: _refs, ...preview } = prepared;
        void _plan; void _refs;
        results.push({ ...shape, blocked, preview });
        continue;
      }
      const result = await writePlan(companyId, sheet, prepared, createdBy);
      for (const k of IMPORTED_KEYS) imported[k] += result.imported[k];
      imported.updated.stakeholders += result.imported.updated.stakeholders;
      importIds.push(result.importId);
      results.push({ ...shape, blocked: false, preview: result });
    }
    const counts: ImportCounts = { total: 0, ok: 0, warnings: 0, errors: 0, skipped: 0, willImport: 0, existing: 0, excluded: 0 };
    const creates: ImportPreview['creates'] = { stakeholders: [], shareClasses: [], vestingSchedules: [], pools: [] };
    for (const r of results) {
      for (const k of Object.keys(counts) as (keyof ImportCounts)[]) counts[k] += r.blocked && k === 'willImport' ? 0 : r.preview.counts[k];
      for (const k of Object.keys(creates) as (keyof typeof creates)[]) creates[k].push(...r.preview.creates[k]);
    }
    // A package goes in whole or not at all: while any of it is blocked, none of it will be imported.
    if (extras.ocf && results.some((r) => r.blocked)) counts.willImport = 0;
    const raised = extras.raiseAuthorized?.length ? await raiseAuthorized(companyId, extras.raiseAuthorized) : [];
    const notices = newNotices(before.warnings, await capTableCheck(companyId), createdClasses);

    // The same person reached by two sheets (one of them blocked, say) is one entry.
    const newPeople: NewPerson[] = [];
    for (const p of people.values()) {
      // An OCF package's people are its own objects, each one person whatever their name.
      const same = extras.ocf ? undefined : newPeople.find((q) => q.key === p.key);
      if (same) { same.rows.push(...p.rows); same.guessed &&= p.guessed; } else newPeople.push(p);
    }
    // A namesake the import also creates names this person back: the first of the two did not know of the second yet.
    for (const p of newPeople) {
      for (const o of p.sameName.filter((x) => !x.onRecord)) {
        const q = newPeople.find((x) => x !== p && x.email === o.email && key(x.name) === key(o.name));
        if (q && !q.sameName.some((x) => x.email === p.email)) q.sameName.push({ name: p.name, email: p.email, onRecord: false });
      }
    }
    const reviewToken = `${asked}.${digest([
      results.map((r) => [r.file, r.sheetName, r.kind, r.blocked, r.preview.rows.map((x) => [x.row, x.outcome, x.status, x.summary])]),
      creates, newPeople.map((p) => [p.key, p.relation]), raised.map((r) => [r.name, r.from, r.to]),
    ])}`;
    if (!dryRun) {
      const [reviewedAsk, reviewedOutcome] = (extras.reviewToken ?? '').split('.');
      if (extras.reviewToken && reviewedAsk !== asked) throw new NotReviewed();
      if (extras.reviewToken && reviewedOutcome !== reviewToken.split('.')[1]) throw new StaleReview(counts);
      const expected = extras.expectedCounts;
      if (expected && (Object.keys(expected) as (keyof ImportCounts)[]).some((k) => k in counts && expected[k] !== counts[k])) throw new StaleReview(counts);
    }
    const summary: WorkbookResult = {
      sheets: results, counts, creates, imported, importIds, files: extras.ocf ? [extras.ocf.file] : [...new Set(sheets.map((s) => s.file ?? null))],
      newPeople, readAs, notices, raised, reviewToken, ...(ocf ? { ocf } : {}),
    };
    if (dryRun) throw new DryRunRollback(summary);
    const blockedSheets = results.filter((r) => r.blocked);
    if (blockedSheets.length > 0) {
      throw new RowsNeedFixing(blockedSheets.map((r) => `"${r.sheetName}" has ${r.preview.counts.errors} ${extras.ocf ? 'item' : 'row'}${r.preview.counts.errors === 1 ? '' : 's'} with errors`).join('; ')
        + '. Fix them or choose to skip rows with errors — nothing was imported.');
    }
    return summary;
  };
  try {
    return await transaction(run);
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}
