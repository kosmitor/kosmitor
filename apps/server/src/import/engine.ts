/**
 * Import engine: turns mapped spreadsheet rows into cap table records.
 *
 * `prepareImport` resolves every row against the company — matching
 * stakeholders by email then name, share classes and vesting schedules by
 * name or shorthand — and reports per-row errors and warnings without writing
 * anything. `commitImport` runs the same preparation and writes the plan in
 * one transaction, so a spreadsheet either lands completely or not at all.
 */
import { randomUUID } from 'node:crypto';
import { all, insert, update, transaction, concurrently } from '../db.ts';
import {
  IMPORT_KINDS, coerceText, coerceNumber, coerceMoney, coercePrice, coercePercent, coerceBoolean,
  coerceDate, coerceAwardType, coerceInstrument, coerceConvertibleStatus, coerceStakeholderType, coerceRelation,
  coerceCompounding, guessStakeholderType, parseVestingShorthand,
  type Cell, type ImportKind, type DateOrder, type FieldSpec,
} from './values.ts';
import { config } from '../config.ts';
import { roundShares, today, INSTRUMENT_NAMES } from '@kosmitor/core';

export interface ImportOptions {
  dateOrder?: DateOrder;
  createMissingStakeholders?: boolean;
  createMissingShareClasses?: boolean;
  createMissingPools?: boolean;
  defaultVestingScheduleId?: string | null;
  defaultPoolId?: string | null;
  skipRowsWithErrors?: boolean;
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

export interface RowMessage { level: 'error' | 'warning' | 'info'; text: string }
export interface PreviewRow {
  row: number;
  status: 'ok' | 'warning' | 'error';
  action: 'create' | 'update' | 'skip';
  summary: Record<string, string | number | null>;
  messages: RowMessage[];
}
export interface ImportPreview {
  kind: ImportKind;
  rows: PreviewRow[];
  counts: { total: number; ok: number; warnings: number; errors: number; skipped: number; willImport: number };
  creates: { stakeholders: string[]; shareClasses: string[]; vestingSchedules: string[]; pools: string[] };
}
export interface ImportResult extends ImportPreview {
  importId: string;
  imported: { stakeholders: number; shareClasses: number; issuances: number; awards: number; convertibles: number; vestingSchedules: number; pools: number };
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
}

class RowContext {
  messages: RowMessage[] = [];
  /** Reverts plan entries this row added, run when the row ends up with errors or is skipped. */
  undo: (() => void)[] = [];
  /** Set when the row carries nothing to import (a total line, a fully repurchased certificate). */
  skipReason: string | null = null;
  private readonly row: Cell[];
  private readonly mapping: Record<string, MappingValue>;
  private readonly fields: Map<string, FieldSpec>;
  private readonly dateOrder: DateOrder;

  constructor(row: Cell[], mapping: Record<string, MappingValue>, fields: Map<string, FieldSpec>, dateOrder: DateOrder) {
    this.row = row;
    this.mapping = mapping;
    this.fields = fields;
    this.dateOrder = dateOrder;
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
  skip(reason: string): void { this.skipReason = reason; }
  error(text: string): void { this.messages.push({ level: 'error', text }); }
  warn(text: string): void { this.messages.push({ level: 'warning', text }); }
  info(text: string): void { this.messages.push({ level: 'info', text }); }
  get hasErrors(): boolean { return this.messages.some((m) => m.level === 'error'); }

  /** Coerces a field by its declared type, recording an error when it cannot. */
  value<T>(fieldKey: string, coerce: (v: Cell) => { value: T | null; error: string | null }): T | null {
    const spec = this.fields.get(fieldKey);
    const result = coerce(this.raw(fieldKey));
    if (result.error) this.error(`${spec?.label ?? fieldKey} ${result.error}`);
    else if (spec?.required && result.value == null) this.error(`${spec.label} is required`);
    return result.value;
  }
  text(k: string) { return this.value(k, coerceText); }
  number(k: string) { return this.value(k, coerceNumber); }
  money(k: string) { return this.value(k, coerceMoney); }
  price(k: string) { return this.value(k, coercePrice); }
  percent(k: string) { return this.value(k, coercePercent); }
  bool(k: string) { return this.value(k, coerceBoolean); }
  date(k: string) { return this.value(k, (v) => coerceDate(v, this.dateOrder)); }
}

/** A plan that adds nothing yet. */
export const emptyPlan = (): Plan => ({
  newStakeholders: new Map(), stakeholderUpdates: new Map(), newShareClasses: new Map(),
  newSchedules: new Map(), newPools: new Map(), poolSizeHint: null, issuances: [], awards: [], convertibles: [], transactions: [],
});

/** Everything about the company the resolver needs, loaded once per import. */
export class Company {
  stakeholdersByEmail = new Map<string, { id: string; name: string }>();
  stakeholdersByName = new Map<string, { id: string; name: string }>();
  shareClasses = new Map<string, { id: string; name: string; kind: string; seniority: number }>();
  schedulesByName = new Map<string, { id: string; name: string }>();
  schedules: { id: string; name: string; kind: string; durationMonths: number; cliffMonths: number; frequency: string }[] = [];
  pools: { id: string; name: string }[] = [];
  poolsByName = new Map<string, { id: string; name: string }>();
  certificateNumbers = new Set<string>();
  awardLabels = new Set<string>();
  convertibleLabels = new Set<string>();
  /** stakeholder|instrument|principal|issue date of every instrument on record, for unlabelled re-imports. */
  convertibleFingerprints = new Set<string>();
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
    const [stakeholders, classes, schedules, pools, certificates, labels, convertibles, splits] = await concurrently([
      () => all<{ id: string; name: string; email: string | null; termination_date: string | null }>('SELECT id, name, email, termination_date FROM stakeholders WHERE company_id = ?', companyId),
      () => all<{ id: string; name: string; kind: string; seniority: number }>('SELECT id, name, kind, seniority FROM share_classes WHERE company_id = ?', companyId),
      () => all<{ id: string; name: string; kind: string; duration_months: number; cliff_months: number; frequency: string }>(
        'SELECT id, name, kind, duration_months, cliff_months, frequency FROM vesting_schedules WHERE company_id = ?', companyId),
      () => all<{ id: string; name: string }>('SELECT id, name FROM pools WHERE company_id = ?', companyId),
      () => all<{ certificate_no: string | null }>('SELECT certificate_no FROM issuances WHERE company_id = ?', companyId),
      () => all<{ label: string | null }>('SELECT label FROM awards WHERE company_id = ?', companyId),
      () => all<{ label: string | null; stakeholder_id: string; instrument: string; principal: number; issue_date: string }>(
        'SELECT label, stakeholder_id, instrument, principal, issue_date FROM convertibles WHERE company_id = ?', companyId),
      () => all<{ date: string; ratio: number }>('SELECT date, ratio FROM stock_splits WHERE company_id = ? ORDER BY date', companyId),
    ]);
    for (const s of stakeholders) {
      const row = { id: s.id, name: s.name };
      if (s.email) c.stakeholdersByEmail.set(key(s.email), row);
      c.stakeholdersByName.set(key(s.name), row);
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
    for (const r of certificates) if (r.certificate_no) c.certificateNumbers.add(key(r.certificate_no));
    for (const r of labels) if (r.label) c.awardLabels.add(key(r.label));
    for (const r of convertibles) {
      if (r.label) c.convertibleLabels.add(key(r.label));
      c.convertibleFingerprints.add(convertibleFingerprint(r.stakeholder_id, r.instrument, r.principal, r.issue_date));
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

  /** Takes in what a prepared sheet would write, as load() would find it after the commit, so the next sheet resolves against it. */
  absorb(plan: Plan): void {
    const byId = new Map([...this.stakeholdersByName.values()].map((s) => [s.id, s]));
    for (const s of plan.newStakeholders.values()) {
      const row = { id: String(s.id), name: String(s.name) };
      if (s.email) this.stakeholdersByEmail.set(key(String(s.email)), row);
      this.stakeholdersByName.set(key(row.name), row);
      if (s.terminationDate) this.terminationDates.set(row.id, String(s.terminationDate));
      byId.set(row.id, row);
    }
    for (const [stakeholderId, updates] of plan.stakeholderUpdates) {
      const row = byId.get(stakeholderId);
      if (row && updates.email) this.stakeholdersByEmail.set(key(String(updates.email)), row);
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
    for (const i of plan.issuances) if (i.certificateNo) this.certificateNumbers.add(key(String(i.certificateNo)));
    for (const a of plan.awards) if (a.label) this.awardLabels.add(key(String(a.label)));
    for (const c of plan.convertibles) {
      if (c.label) this.convertibleLabels.add(key(String(c.label)));
      this.convertibleFingerprints.add(convertibleFingerprint(String(c.stakeholderId), String(c.instrument), Number(c.principal), String(c.issueDate)));
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
      ctx.info(`Type column says "${String(typeCell)}" — read as the relationship${name ? `; type taken from the name (${guessStakeholderType(name).toLowerCase()})` : ''}`);
    } else ctx.error(`Type ${typeAsType.error}`);
  }
  if (relationAsRelation.error) {
    if (relationAsType.value) {
      type ??= relationAsType.value;
      ctx.info(`Relationship column says "${String(relationCell)}" — read as the type`);
    } else ctx.error(`Relationship ${relationAsRelation.error}`);
  }
  return { type, relation };
}

const convertibleFingerprint = (stakeholderId: string, instrument: string, principal: number, issueDate: string): string =>
  `${stakeholderId}|${instrument}|${principal}|${issueDate}`;

function defaultRelation(name: string, classKind: string | null): string {
  if (guessStakeholderType(name) !== 'INDIVIDUAL') return 'INVESTOR';
  if (classKind === 'PREFERRED') return 'INVESTOR';
  return 'EMPLOYEE';
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

  const existing = (email && company.stakeholdersByEmail.get(email)) ?? company.stakeholdersByName.get(key(name));
  if (existing) return { ...existing, created: false };

  const planKey = email ? `email:${email}` : `name:${key(name)}`;
  const planned = plan.newStakeholders.get(planKey) ?? (email ? plan.newStakeholders.get(`name:${key(name)}`) : undefined);
  if (planned) return { id: planned.id as string, name: planned.name as string, created: true };

  if (opts.createMissingStakeholders === false) {
    ctx.error(`Stakeholder "${name}" does not exist and creating stakeholders is turned off`);
    return null;
  }
  const { type: typeGiven, relation: relationGiven } = readTypeAndRelation(ctx, name);
  const record = {
    id: id('stk'), companyId: company.companyId, name, email,
    type: typeGiven ?? guessStakeholderType(name),
    relation: relationGiven ?? defaultRelation(name, classKind),
    startDate: null, terminationDate: null, taxCountry: null, taxState: null, entityGroupId: null,
    title: null, address: null, phone: null, notes: null, createdAt: now(),
  };
  plan.newStakeholders.set(planKey, record);
  ctx.undo.push(() => plan.newStakeholders.delete(planKey));
  ctx.info(`Creates stakeholder "${name}" as ${String(record.relation).toLowerCase().replace('_', ' ')}${relationGiven ? '' : ' — review the relationship'}`);
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
    ctx.error(`Share class "${name}" does not exist and creating share classes is turned off`);
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
  ctx.info(`Creates ${preferred ? 'preferred' : 'common'} share class "${name}" — review its terms and authorized shares`);
  return { id: record.id, name, kind: record.kind, created: true };
}

/** A schedule by name, by shorthand (matching an existing one when possible), or the chosen default. */
function resolveVestingSchedule(
  ctx: RowContext, company: Company, plan: Plan, opts: ImportOptions, required: boolean,
): string | null | undefined {
  const text = ctx.text('vestingSchedule');
  if (text) {
    const byName = company.schedulesByName.get(key(text));
    if (byName) return byName.id;
    const parsed = parseVestingShorthand(text);
    if (!parsed) { ctx.error(`Vesting schedule "${text}" is not a known schedule or shorthand like "4y/1y monthly"`); return undefined; }
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
      ctx.info(`Creates vesting schedule "${name}"`);
    }
    return plan.newSchedules.get(planKey)!.id as string;
  }
  if (opts.defaultVestingScheduleId) return opts.defaultVestingScheduleId;
  if (required) ctx.error('Vesting schedule is missing and no default schedule was chosen');
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
export function isPlanSizeRow(row: Cell[]): boolean {
  const labelIdx = row.findIndex((c) => !cellIsBlank(c));
  if (labelIdx < 0 || !PLAN_SIZE_LABEL.test(String(row[labelIdx]).trim().toLowerCase())) return false;
  return row.every((c, i) => i === labelIdx || cellIsBlank(c) || coerceNumber(c).value != null);
}

export function findPlanSize(rows: Cell[][], grantedQuantityColumn: number | null): number | null {
  let authorized: number | null = null;
  let available: number | null = null;
  let granted = 0;
  const numberIn = (row: Cell[], skip: number): number | null => {
    for (let i = 0; i < row.length; i++) {
      if (i === skip) continue;
      const n = coerceNumber(row[i]);
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
      const q = coerceNumber(row[grantedQuantityColumn]);
      if (isGrant && q.value != null && q.value > 0) granted += q.value;
    }
  }
  if (authorized != null) return authorized;
  if (available != null && granted > 0) return granted + available;
  return null;
}

/**
 * The plan named on the row, the chosen default, or the company's only plan.
 * A named plan that does not exist yet is created with the size the sheet
 * states, or — when the sheet says nothing — with the imported grants as its
 * reserve, since grant rows alone never carry the plan size.
 */
function resolvePool(ctx: RowContext, company: Company, plan: Plan, opts: ImportOptions, quantity: number): string | null {
  const name = ctx.text('poolName');
  if (name) {
    const pool = company.poolsByName.get(key(name));
    if (pool) return pool.id;
    const planned = plan.newPools.get(key(name));
    if (planned) {
      planned.authorized += quantity;
      ctx.undo.push(() => { planned.authorized -= quantity; });
      return planned.id as string;
    }
    if (opts.createMissingPools === false) {
      ctx.error(`Equity plan "${name}" does not exist and creating plans is turned off`);
      return null;
    }
    const shareClassId = company.commonClassId ?? [...plan.newShareClasses.values()].find((c) => c.kind === 'COMMON')?.id as string | undefined;
    if (!shareClassId) {
      ctx.error(`Equity plan "${name}" does not exist and the company has no common share class for it to draw from`);
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
      : `Creates equity plan "${name}" sized to the imported grants — set its authorized shares afterwards`);
    return record.id;
  }
  if (opts.defaultPoolId) return opts.defaultPoolId;
  if (company.pools.length === 1) return company.pools[0].id;
  ctx.error(company.pools.length === 0
    ? 'The company has no equity plan to grant from — create one first or add an equity plan column'
    : 'Equity plan is missing and no default plan was chosen');
  return null;
}

// ---------------------------------------------------------------------------

/**
 * `known` resolves the rows against a company already in hand, such as an
 * in-memory one from Company.empty(), instead of loading it from the database.
 */
export async function prepareImport(companyId: string, req: ImportRequest, known?: Company): Promise<ImportPreview & { plan: Plan }> {
  const spec = IMPORT_KINDS[req.kind];
  if (!spec) throw new Error(`Unknown import kind "${req.kind}".`);
  const rows = (req.rows ?? []).slice(0, maxRows());
  const opts: ImportOptions = { createMissingStakeholders: true, createMissingShareClasses: true, ...req.options };
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  const company = known ?? await Company.load(companyId);
  const plan = emptyPlan();
  if (req.kind === 'grants') {
    const quantityColumn = req.mapping.quantity;
    plan.poolSizeHint = findPlanSize(rows, typeof quantityColumn === 'number' ? quantityColumn : null);
  }
  const memo = `Imported${opts.fileName ? ` from ${opts.fileName}` : ''}`;
  const seenCertificates = new Set<string>();
  const seenLabels = new Set<string>();
  const seenConvertibleLabels = new Set<string>();
  const seenFingerprints = new Set<string>();
  const preview: PreviewRow[] = [];
  const headerRow = req.headerRowNumber ?? 1;

  rows.forEach((row, i) => {
    const ctx = new RowContext(row, req.mapping, fields, opts.dateOrder ?? config().locale.importDateOrder);
    let action: PreviewRow['action'] = 'create';
    let summary: Record<string, string | number | null> = {};

    // Exports end with "Total" lines and summary sections; they carry no record.
    const planSizeLine = req.kind === 'grants' && isPlanSizeRow(row);
    if (ctx.isBlankInRequiredColumns || planSizeLine) {
      const label = row.find((c) => c != null && String(c).trim() !== '');
      preview.push({
        row: headerRow + 1 + i, status: 'ok', action: 'skip', summary: {},
        messages: [{ level: 'info', text: planSizeLine
          ? `Plan size line — read for the plan's authorized shares, not imported as a grant ("${String(label).slice(0, 40)}")`
          : `Nothing in the required columns — skipped as a total or section row${label != null ? ` ("${String(label).slice(0, 40)}")` : ''}` }],
      });
      return;
    }

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
      if (name && !ctx.hasErrors) {
        const existing = (email && company.stakeholdersByEmail.get(email)) ?? company.stakeholdersByName.get(key(name));
        if (existing) {
          action = 'update';
          const updates: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fieldsGiven)) if (v != null) updates[k] = v;
          if (type) updates.type = type;
          if (relation) updates.relation = relation;
          plan.stakeholderUpdates.set(existing.id, { ...(plan.stakeholderUpdates.get(existing.id) ?? {}), ...updates });
          ctx.info(`Updates existing stakeholder "${existing.name}"`);
        } else {
          const planKey = email ? `email:${email}` : `name:${key(name)}`;
          if (plan.newStakeholders.has(planKey) || plan.newStakeholders.has(`name:${key(name)}`)) {
            ctx.warn('Appears more than once in the file — later rows update the first');
            action = 'update';
          } else {
            if (!relation) ctx.info(`No relationship given — defaulting to ${defaultRelation(name, null).toLowerCase()}`);
            plan.newStakeholders.set(planKey, {
              id: id('stk'), companyId, name, type: type ?? guessStakeholderType(name),
              relation: relation ?? defaultRelation(name, null), entityGroupId: null, ...fieldsGiven, createdAt: now(),
            });
            ctx.undo.push(() => plan.newStakeholders.delete(planKey));
          }
        }
      }
    }

    if (req.kind === 'captable') {
      const quantity = ctx.number('quantity');
      const price = ctx.price('pricePerShare');
      const issueDate = ctx.date('issueDate');
      const certificateNo = ctx.text('certificateNo');
      if (quantity === 0) ctx.skip('No shares outstanding on this certificate — nothing to import');
      else if (quantity != null && quantity < 0) ctx.error('Shares must be greater than zero');
      if (price == null && !ctx.skipReason) ctx.warn('No price per share — recorded at $0.00');
      const cls = quantity != null && quantity > 0
        ? resolveShareClass(ctx, company, plan, opts, price, quantity, issueDate) : null;
      const holder = resolveStakeholder(ctx, company, plan, opts, cls?.kind ?? null);
      if (certificateNo) {
        if (company.certificateNumbers.has(key(certificateNo))) ctx.error(`Certificate "${certificateNo}" already exists on the cap table`);
        else if (seenCertificates.has(key(certificateNo))) ctx.error(`Certificate "${certificateNo}" appears more than once in the file`);
        seenCertificates.add(key(certificateNo));
      }
      const scheduleId = resolveVestingSchedule(ctx, company, plan, opts, false);
      const vestingStart = ctx.date('vestingStartDate') ?? (scheduleId ? issueDate : null);
      const election = ctx.date('election83bFiledOn');
      if (scheduleId && !election) ctx.info('Restricted stock with no 83(b) date recorded');
      summary = {
        stakeholder: holder?.name ?? ctx.text('stakeholderName'), shareClass: cls?.name ?? ctx.text('shareClassName'),
        shares: quantity, price: price != null ? price / 1e6 : null, issueDate, certificate: certificateNo,
        vesting: scheduleId ? 'yes' : null,
      };
      if (!ctx.hasErrors && holder && cls && quantity != null && issueDate) {
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
      else if (type && strike == null) ctx.error(`${type} grants need a strike price`);
      if (quantity != null && quantity <= 0) ctx.error('Shares must be greater than zero');
      const holder = resolveStakeholder(ctx, company, plan, opts, null);
      const scheduleId = resolveVestingSchedule(ctx, company, plan, opts, true);
      const poolId = resolvePool(ctx, company, plan, opts, quantity ?? 0);
      const exercised = ctx.number('exercisedQuantity') ?? 0;
      const cancelled = ctx.number('cancelledQuantity') ?? 0;
      if (quantity != null && exercised + cancelled > quantity) ctx.error('Exercised plus cancelled shares exceed the grant');
      const cancelledOn = ctx.date('cancellationDate');
      if (cancelledOn && grantDate && cancelledOn < grantDate) ctx.error('Cancellation date is before the grant date');
      else if (cancelledOn && cancelled <= 0) ctx.info('Cancellation date given with no cancelled shares — not used');
      const label = ctx.text('label');
      if (label) {
        if (company.awardLabels.has(key(label))) ctx.error(`Grant "${label}" already exists — importing it again would duplicate it`);
        else if (seenLabels.has(key(label))) ctx.error(`Grant "${label}" appears more than once in the file`);
        seenLabels.add(key(label));
      }
      const vestingStart = ctx.date('vestingStartDate') ?? grantDate;
      let expiration = ctx.date('expirationDate');
      if (!expiration && grantDate && !settlesForFree) {
        // The term an option has when its paperwork says nothing, equity.optionTermYears.
        // An ISO cannot run past ten years by law, whatever the setting says.
        const years = type === 'ISO' ? Math.min(10, config().equity.optionTermYears) : config().equity.optionTermYears;
        expiration = `${Number(grantDate.slice(0, 4)) + years}${grantDate.slice(4)}`;
        ctx.info(`No expiration date — assumed ${inWords(years)} year${years === 1 ? '' : 's'} from grant`);
      }
      summary = { stakeholder: holder?.name ?? ctx.text('stakeholderName'), type, shares: quantity,
        strike: strike != null ? strike / 1e6 : null, grantDate, vesting: scheduleId ? 'yes' : null, label };
      if (!ctx.hasErrors && holder && type && quantity != null && grantDate && scheduleId && poolId) {
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
            if (!cancelledOn) ctx.info(`${count(cancelled)} cancelled shares dated to ${holder.name}'s termination on ${on}`);
          } else {
            ctx.info(`No cancellation date for the ${count(cancelled)} cancelled shares — add one to place them in the right year for the ISO $100K test`);
          }
        }
      }
    }

    if (req.kind === 'convertibles') {
      const instrument = ctx.value('instrument', coerceInstrument);
      const principal = ctx.money('principal');
      const issueDate = ctx.date('issueDate');
      if (principal != null && principal <= 0) ctx.error('Principal must be greater than zero');
      const holder = resolveStakeholder(ctx, company, plan, opts, 'PREFERRED');
      const isSafe = instrument === 'SAFE_POST' || instrument === 'SAFE_PRE';
      const interest = ctx.percent('interestRate');
      if (isSafe && interest) ctx.info('SAFEs do not bear interest — the rate was ignored');
      let cap = ctx.money('valuationCap');
      if (cap === 0) cap = null;                                   // exports write 0 for "uncapped"
      const discount = ctx.percent('discount') ?? 0;
      const status = ctx.value('status', coerceConvertibleStatus) ?? 'OUTSTANDING';
      if (!cap && !discount && status === 'OUTSTANDING') ctx.warn('No valuation cap or discount — converts at the round price');
      if (status !== 'OUTSTANDING') ctx.info(`Recorded as ${status.toLowerCase()} — excluded from the cap table`);
      const instrumentText = String(ctx.raw('instrument') ?? '').toLowerCase().trim();
      if (instrument && (instrumentText === 'safe' || /^post[\s-]?money$/.test(instrumentText))) ctx.info(`"${ctx.raw('instrument')}" treated as a post-money SAFE`);
      const label = ctx.text('label');
      if (label) {
        if (company.convertibleLabels.has(key(label))) ctx.error(`Instrument "${label}" already exists — importing it again would duplicate it`);
        else if (seenConvertibleLabels.has(key(label))) ctx.error(`Instrument "${label}" appears more than once in the file`);
        seenConvertibleLabels.add(key(label));
      } else if (holder && instrument && principal != null && issueDate) {
        // No reference to go by: the same holder, instrument, amount and date is taken to be the same instrument.
        const fingerprint = convertibleFingerprint(holder.id, instrument, principal, issueDate);
        const kindName = INSTRUMENT_NAMES[instrument]?.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) ?? 'instrument';
        if (company.convertibleFingerprints.has(fingerprint)) ctx.error(`An identical ${kindName} for this holder (same amount and date) already exists — importing it again would duplicate it`);
        else if (seenFingerprints.has(fingerprint)) ctx.error('The same instrument appears more than once in the file');
        seenFingerprints.add(fingerprint);
      }
      summary = { stakeholder: holder?.name ?? ctx.text('stakeholderName'), instrument, label,
        principal: principal != null ? principal / 100 : null, issueDate, cap: cap != null ? cap / 100 : null, discount, status };
      if (!ctx.hasErrors && holder && instrument && principal != null && issueDate) {
        const convertibleId = id('cnv');
        plan.convertibles.push({
          id: convertibleId, companyId, stakeholderId: holder.id, label, instrument, principal, issueDate,
          valuationCap: cap, discount, interestRate: isSafe ? 0 : (interest ?? 0),
          compounding: ctx.value('compounding', coerceCompounding) ?? 'SIMPLE',
          maturityDate: isSafe ? null : ctx.date('maturityDate'), mfn: ctx.bool('mfn') ? 1 : 0,
          proRataRight: ctx.bool('proRata') ? 1 : 0, status, convertedIntoShareClassId: null,
          convertedOn: null, qualifiedFinancingMinimum: null, notes: ctx.text('notes'), createdAt: now(),
        });
        plan.transactions.push({
          id: id('tx'), companyId, type: 'ISSUANCE', date: issueDate, stakeholderId: holder.id, counterpartyId: null,
          securityId: convertibleId, shareClassId: null, quantity: null, pricePerShare: null, amount: principal,
          memo: `${memo} (${instrument})`, createdAt: now(), createdBy: null,
        });
      }
    }

    // A row with errors — or nothing to import — is skipped, so nothing it planned may survive.
    if (ctx.skipReason && !ctx.hasErrors) {
      ctx.messages = [{ level: 'info', text: ctx.skipReason }];
      action = 'skip';
    }
    if (ctx.hasErrors || ctx.skipReason) for (const revert of ctx.undo.reverse()) revert();

    const status: PreviewRow['status'] = ctx.hasErrors ? 'error'
      : ctx.messages.some((m) => m.level === 'warning') ? 'warning' : 'ok';
    preview.push({ row: headerRow + 1 + i, status, action: ctx.hasErrors ? 'skip' : action, summary, messages: ctx.messages });
  });

  // Plans created here were accumulated grant by grant; the sheet's stated size wins when it covers them.
  for (const pool of plan.newPools.values()) {
    if (plan.poolSizeHint == null) continue;
    if (plan.poolSizeHint >= pool.authorized) pool.authorized = plan.poolSizeHint;
    else {
      const creator = preview.find((r) => r.messages.some((m) => m.text.startsWith(`Creates equity plan "${String(pool.name)}"`)));
      creator?.messages.push({ level: 'warning', text: `The sheet says ${count(plan.poolSizeHint)} authorized shares but the grants total ${count(pool.authorized)} — kept the grants total` });
      if (creator && creator.status === 'ok') creator.status = 'warning';
    }
  }

  const errors = preview.filter((r) => r.status === 'error').length;
  const warnings = preview.filter((r) => r.status === 'warning').length;
  const skipped = preview.filter((r) => r.status !== 'error' && r.action === 'skip').length;
  return {
    kind: req.kind, rows: preview,
    counts: { total: preview.length, ok: preview.length - errors - warnings - skipped, warnings, errors, skipped, willImport: preview.length - errors - skipped },
    creates: {
      stakeholders: [...plan.newStakeholders.values()].map((s) => String(s.name)),
      shareClasses: [...plan.newShareClasses.values()].map((c) => String(c.name)),
      vestingSchedules: [...plan.newSchedules.values()].map((s) => String(s.name)),
      pools: [...plan.newPools.values()].map((p) => String(p.name)),
    },
    plan,
  };
}

export async function commitImport(companyId: string, req: ImportRequest, createdBy: string | null): Promise<ImportResult> {
  const prepared = await prepareImport(companyId, req);
  if (prepared.counts.errors > 0 && !req.options?.skipRowsWithErrors) {
    throw new Error(`${prepared.counts.errors} row${prepared.counts.errors === 1 ? ' has' : 's have'} errors. Fix them or choose to skip rows with errors.`);
  }
  const { plan } = prepared;
  const importId = id('imp');

  // Everything from one file lands together or not at all.
  await transaction(async () => {
    for (const s of plan.newStakeholders.values()) await insert('stakeholders', s);
    for (const [stakeholderId, updates] of plan.stakeholderUpdates) if (Object.keys(updates).length) await update('stakeholders', stakeholderId, updates);
    for (const c of plan.newShareClasses.values()) await insert('share_classes', c);
    for (const v of plan.newSchedules.values()) await insert('vesting_schedules', v);
    for (const p of plan.newPools.values()) await insert('pools', p);
    for (const i of plan.issuances) await insert('issuances', i);
    for (const a of plan.awards) await insert('awards', a);
    for (const c of plan.convertibles) await insert('convertibles', c);
    for (const t of plan.transactions) await insert('transactions', { ...t, createdBy });
    await insert('imports', {
      id: importId, companyId, kind: req.kind, fileName: req.options?.fileName ?? null,
      rowCount: prepared.counts.total, importedCount: prepared.counts.willImport,
      skippedCount: prepared.counts.errors + prepared.counts.skipped,
      summary: JSON.stringify({ creates: prepared.creates, counts: prepared.counts }),
      createdBy, createdAt: now(),
    });
  });

  const { plan: _omit, ...preview } = prepared;
  void _omit;
  return {
    ...preview, importId,
    imported: {
      stakeholders: plan.newStakeholders.size, shareClasses: plan.newShareClasses.size,
      issuances: plan.issuances.length, awards: plan.awards.length, convertibles: plan.convertibles.length,
      vestingSchedules: plan.newSchedules.size, pools: plan.newPools.size,
    },
  };
}

/** Rows and header of a parsed file trimmed for transport. */
export function limitRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  const limit = maxRows();
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// ---------------------------------------------------------------------------
// Workbooks: several sheets of one file, applied together
// ---------------------------------------------------------------------------

export interface WorkbookSheet extends ImportRequest {
  sheetName: string;
}
export interface WorkbookSheetResult {
  sheetName: string;
  kind: ImportKind;
  /** True when the sheet has errors the options do not allow skipping — nothing from it is applied. */
  blocked: boolean;
  preview: ImportPreview & { importId?: string; imported?: ImportResult['imported'] };
}
export interface WorkbookResult {
  sheets: WorkbookSheetResult[];
  counts: ImportPreview['counts'];
  creates: ImportPreview['creates'];
  imported: ImportResult['imported'];
  importIds: string[];
}

const KIND_SEQUENCE: ImportKind[] = ['stakeholders', 'captable', 'grants', 'convertibles'];
const EMPTY_IMPORTED = (): ImportResult['imported'] =>
  ({ stakeholders: 0, shareClasses: 0, issuances: 0, awards: 0, convertibles: 0, vestingSchedules: 0, pools: 0 });

class DryRunRollback extends Error {
  result: WorkbookResult;
  constructor(result: WorkbookResult) { super('dry run'); this.result = result; }
}

/**
 * Applies every sheet in dependency order — people, then certificates, grants
 * and convertibles — inside one transaction, so a certificate sheet finds the
 * stakeholders its sibling sheet created and the whole file lands or nothing
 * does. With `dryRun` the same run happens and is rolled back, which makes the
 * preview exact: later sheets are checked against what earlier ones would add.
 */
export async function runWorkbook(
  companyId: string, sheets: WorkbookSheet[], createdBy: string | null, dryRun: boolean,
): Promise<WorkbookResult> {
  const ordered = [...sheets].sort((a, b) => KIND_SEQUENCE.indexOf(a.kind) - KIND_SEQUENCE.indexOf(b.kind));
  const run = async (): Promise<WorkbookResult> => {
    const results: WorkbookSheetResult[] = [];
    const imported = EMPTY_IMPORTED();
    const importIds: string[] = [];
    for (const sheet of ordered) {
      const prepared = await prepareImport(companyId, sheet);
      const blocked = prepared.counts.errors > 0 && !sheet.options?.skipRowsWithErrors;
      if (blocked) {
        const { plan: _plan, ...preview } = prepared;
        void _plan;
        results.push({ sheetName: sheet.sheetName, kind: sheet.kind, blocked, preview });
        continue;
      }
      const result = await commitImport(companyId, sheet, createdBy);
      for (const k of Object.keys(imported) as (keyof ImportResult['imported'])[]) imported[k] += result.imported[k];
      importIds.push(result.importId);
      results.push({ sheetName: sheet.sheetName, kind: sheet.kind, blocked: false, preview: result });
    }
    const counts: ImportPreview['counts'] = { total: 0, ok: 0, warnings: 0, errors: 0, skipped: 0, willImport: 0 };
    const creates: ImportPreview['creates'] = { stakeholders: [], shareClasses: [], vestingSchedules: [], pools: [] };
    for (const r of results) {
      for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += r.blocked && k === 'willImport' ? 0 : r.preview.counts[k];
      for (const k of Object.keys(creates) as (keyof typeof creates)[]) creates[k].push(...r.preview.creates[k]);
    }
    const summary = { sheets: results, counts, creates, imported, importIds };
    if (dryRun) throw new DryRunRollback(summary);
    const blockedSheets = results.filter((r) => r.blocked);
    if (blockedSheets.length > 0) {
      throw new Error(blockedSheets.map((r) => `"${r.sheetName}" has ${r.preview.counts.errors} row${r.preview.counts.errors === 1 ? '' : 's'} with errors`).join('; ')
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
