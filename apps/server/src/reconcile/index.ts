/**
 * Reconciles a cap table export from Pulley or Carta against the app's math.
 *
 * The export goes through the same import code the wizard uses — sheet
 * detection, column mapping, row resolution — but against a company held in
 * memory: nothing is written to any database and no company is touched. The
 * records the import would write become CompanyData as the app would load them,
 * computeCapTable runs as of the export's date, and compare.ts sets the result
 * against the export's own figures, level by level, and accounts for every
 * difference. report.ts writes it up.
 *
 * Real exports hold real people's holdings. Run this on your own machine, keep
 * the output under data/reconcile/ (git-ignored and left out of the image), and
 * never turn real rows into fixtures: rebuild a case with invented names instead.
 */
import { randomUUID } from 'node:crypto';
import { computeCapTable, today, type CapTable, type CompanyData } from '@ct/core';
import { Company, emptyPlan, prepareImport, type Plan } from '../import/engine.ts';
import type { DateOrder, ImportKind } from '../import/values.ts';
import { companyDataFromRows, type CompanyRows } from '../store.ts';
import { config, vestingTemplates } from '../config.ts';
import { readSheets, asLedger, readFigures, type ExportFile, type LedgerSheet, type SourceFigures } from './source.ts';
import { Comparer, LEVELS, CATEGORIES, classKey, type Comparison, type Level, type Category, type ImportIssue, type Unit } from './compare.ts';

export type { ExportFile } from './source.ts';
export type { Level, Category } from './compare.ts';

export interface ReconcileOptions {
  /** The date to compare on. Defaults to the date the export states, else today. */
  asOf?: string;
  /** Count the unallocated pool in fully diluted, as the cap table page does by default. */
  includeUnallocatedPool?: boolean;
  /** Add the app's estimate of shares for SAFEs and notes to fully diluted. */
  includeConvertibles?: boolean;
  dateOrder?: DateOrder;
  /**
   * Exports whose figures are compared without importing their ledgers: a
   * past-dated export, say, checked against the ledgers of today's.
   */
  figures?: ExportFile[];
  /** Overrides for what the export says about itself. */
  company?: string;
  system?: string;
}

export interface Difference {
  level: Level; key: string; field: string; unit: Unit;
  source: number | string | null; app: number | string | null; difference: number | null;
  category: Category; bug: string | null; note: string; root: boolean; where: string;
}

export interface Reconciliation {
  asOf: string;
  /** The date of the imported ledgers when the figures come from another export. */
  dataAsOf: string | null;
  company: string | null;
  system: string | null;
  options: { includeUnallocatedPool: boolean; includeConvertibles: boolean; dateOrder: DateOrder; postTerminationExerciseMonths: number; optionTermYears: number };
  files: string[];
  figureFiles: string[];
  sheets: { file: string; sheet: string; use: string }[];
  imported: { rows: number; errors: number; warnings: number; stakeholders: number; certificates: number; grants: number; convertibles: number };
  /** What the comparison takes for granted, in words. */
  assumptions: string[];
  data: CompanyData;
  table: CapTable;
  figures: SourceFigures;
  comparisons: Comparison[];
  differences: Difference[];
  counts: Record<Level, { compared: number; matching: number; differing: number }>;
  categories: Record<Category, number>;
  /** Differences that do not just follow from others. */
  rootCategories: Record<Category, number>;
  bugs: Record<string, number>;
  /** No difference is left unexplained. */
  passed: boolean;
}

const KIND_SEQUENCE: ImportKind[] = ['stakeholders', 'captable', 'grants', 'convertibles'];
const COMPANY_ID = 'co_reconcile';
const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
type Row = Record<string, unknown>;

/** A value as the database would hand it back: booleans as 0/1, arrays and objects as JSON. */
const stored = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0)
  : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
const storedRow = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, stored(v)]));

/** The rows an import would write, kept in memory. */
class MemoryTables {
  stakeholders = new Map<string, Row>();
  shareClasses: Row[] = [];
  vestingSchedules: Row[] = [];
  pools: Row[] = [];
  issuances: Row[] = [];
  awards: Row[] = [];
  convertibles: Row[] = [];

  take(plan: Plan): void {
    for (const s of plan.newStakeholders.values()) this.stakeholders.set(String(s.id), storedRow(s));
    for (const [id, updates] of plan.stakeholderUpdates) {
      const row = this.stakeholders.get(id);
      if (row) Object.assign(row, storedRow(updates));
    }
    this.shareClasses.push(...[...plan.newShareClasses.values()].map(storedRow));
    this.vestingSchedules.push(...[...plan.newSchedules.values()].map(storedRow));
    this.pools.push(...[...plan.newPools.values()].map(storedRow));
    this.issuances.push(...plan.issuances.map(storedRow));
    this.awards.push(...plan.awards.map(storedRow));
    this.convertibles.push(...plan.convertibles.map(storedRow));
  }

  /** In the order loadCompanyData() reads them, so the engine sees what it would after a real import. */
  rows(): CompanyRows {
    const by = (...keys: string[]) => (a: Row, b: Row) => {
      for (const k of keys) {
        const desc = k.startsWith('-');
        const f = desc ? k.slice(1) : k;
        const x = a[f] ?? '', y = b[f] ?? '';
        if (x < y) return desc ? 1 : -1;
        if (x > y) return desc ? -1 : 1;
      }
      return 0;
    };
    return {
      shareClasses: [...this.shareClasses].sort(by('-seniority', 'sortOrder', 'issueDate')),
      stakeholders: [...this.stakeholders.values()].sort(by('name')),
      issuances: [...this.issuances].sort(by('issueDate', 'certificateNo')),
      awards: [...this.awards].sort(by('grantDate', 'label')),
      pools: this.pools, poolAdjustments: [], warrants: [],
      convertibles: [...this.convertibles].sort(by('issueDate')),
      vestingSchedules: [...this.vestingSchedules].sort(by('name')),
      valuations: [], stockSplits: [], exercises: [], filings: [],
    };
  }
}

/** What a new company starts with in the app: the configured vesting schedules and a common class. */
function newCompanyPlan(): Plan {
  const plan = emptyPlan();
  for (const s of vestingTemplates()) {
    plan.newSchedules.set(`template:${s.name}`, {
      id: newId('vs'), companyId: COMPANY_ID, name: s.name, kind: s.kind,
      durationMonths: s.durationMonths, cliffMonths: s.cliffMonths, frequency: s.frequency,
      immediatePortion: s.immediatePortion, yearWeights: s.yearWeights, milestones: s.milestones, customTranches: s.customTranches,
      accelerationSingle: s.accelerationSingleTrigger, accelerationDouble: s.accelerationDoubleTrigger, accelerationMonths: s.accelerationMonths,
    });
  }
  const common = config().company.commonClass;
  const par = Math.round(common.parValue * 1e6);
  plan.newShareClasses.set(key(common.name), {
    id: newId('sc'), companyId: COMPANY_ID, name: common.name, kind: 'COMMON', authorized: common.authorized,
    parValue: par, seniority: 0, originalIssuePrice: par, liquidationMultiple: 1, participation: 'NON_PARTICIPATING',
    participationCap: null, conversionRatio: 1, dividendType: 'NONE', dividendRate: 0, dividendCompounding: 0,
    dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0, issueDate: null, isConvertible: 0, sortOrder: 0,
  });
  return plan;
}

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Runs every ledger through the import, people first, against one in-memory company. */
async function importInMemory(ledgers: LedgerSheet[], dateOrder: DateOrder) {
  const company = Company.empty(COMPANY_ID);
  const tables = new MemoryTables();
  const start = newCompanyPlan();
  company.absorb(start);
  tables.take(start);
  const issues: ImportIssue[] = [];
  const imported = { rows: 0, errors: 0, warnings: 0, stakeholders: 0, certificates: 0, grants: 0, convertibles: 0 };
  const ordered = [...ledgers].sort((a, b) => KIND_SEQUENCE.indexOf(a.kind) - KIND_SEQUENCE.indexOf(b.kind));
  for (const l of ordered) {
    const prepared = await prepareImport(COMPANY_ID, {
      kind: l.kind, headers: l.headers, rows: l.data, mapping: l.mapping, headerRowNumber: l.headerRow + 1,
      options: { dateOrder, fileName: l.file },
    }, company);
    company.absorb(prepared.plan);
    tables.take(prepared.plan);
    imported.rows += prepared.counts.willImport;
    imported.errors += prepared.counts.errors;
    imported.warnings += prepared.counts.warnings;
    imported.stakeholders += prepared.plan.newStakeholders.size;
    imported.certificates += prepared.plan.issuances.length;
    imported.grants += prepared.plan.awards.length;
    imported.convertibles += prepared.plan.convertibles.length;
    for (const r of prepared.rows) {
      if (r.status !== 'error') continue;
      issues.push({
        file: l.file, sheet: l.name, row: r.row, kind: l.kind,
        holder: text(r.summary.stakeholder), label: text(r.summary.label ?? r.summary.certificate), className: text(r.summary.shareClass),
        messages: r.messages.filter((m) => m.level === 'error').map((m) => m.text),
      });
    }
  }
  return { tables, issues, imported };
}

export async function reconcile(files: ExportFile[], options: ReconcileOptions = {}): Promise<Reconciliation> {
  const settings = config();
  const dateOrder = options.dateOrder ?? settings.locale.importDateOrder;
  const includeUnallocatedPool = options.includeUnallocatedPool ?? true;
  const includeConvertibles = options.includeConvertibles ?? false;

  const sheets = files.flatMap(readSheets);
  const ledgers = sheets.map(asLedger).filter((l): l is LedgerSheet => l !== null);
  const dataFigures = readFigures(files.map((f) => f.name), sheets, ledgers);
  let figures = dataFigures;
  if (options.figures?.length) {
    const figureSheets = options.figures.flatMap(readSheets);
    figures = readFigures(options.figures.map((f) => f.name), figureSheets, figureSheets.map(asLedger).filter((l): l is LedgerSheet => l !== null));
  }
  const asOf = options.asOf ?? figures.asOf ?? dataFigures.asOf ?? today();
  const dataAsOf = options.figures?.length ? dataFigures.asOf : null;
  const assumptions: string[] = [];

  const { tables, issues, imported } = await importInMemory(ledgers, dateOrder);

  // Authorized shares: the import sizes a new class to what it issues, so the export's own figure is set, as you would after importing.
  const issuedIn = (c: Row) => tables.issuances.some((i) => i.shareClassId === c.id);
  for (const line of figures.summary?.lines ?? []) {
    if (line.values.authorized == null) continue;
    const named = (match: (c: Row, alias: string) => boolean) =>
      line.aliases.map((a) => tables.shareClasses.filter((c) => match(c, a))).find((list) => list.length);
    const candidates = named((c, a) => key(String(c.name)) === key(a)) ?? named((c, a) => classKey(String(c.name)) === classKey(a)) ?? [];
    const cls = candidates.find(issuedIn) ?? candidates[0];
    if (cls) {
      cls.authorized = line.values.authorized;
      assumptions.push(`Authorized ${line.name} shares taken from the export (${line.values.authorized.toLocaleString('en-US')}); the import sizes a new class to the shares it issues.`);
    }
  }
  // A new company's common class dates from its incorporation; here, from its first certificate.
  for (const cls of tables.shareClasses) {
    if (cls.issueDate) continue;
    const first = tables.issuances.filter((i) => i.shareClassId === cls.id).map((i) => String(i.issueDate)).sort()[0];
    cls.issueDate = first && first < asOf ? first : asOf;
  }
  if (figures.grants.length && !figures.columns.grantExpiration) assumptions.push(`The grants carry no expiration date; the import assumed ${settings.equity.optionTermYears} years from grant (equity.optionTermYears).`);
  if (figures.grants.length) assumptions.push(`Exports do not state post-termination exercise windows; every grant gets ${settings.equity.postTerminationExerciseMonths} months (equity.postTerminationExerciseMonths).`);
  if (dataAsOf && dataAsOf !== asOf) assumptions.push(`The ledgers are as of ${dataAsOf} and the figures as of ${asOf}: a history check.`);

  const data = companyDataFromRows(tables.rows());
  const table = computeCapTable(data, { asOf, includeUnallocatedPool, includeConvertibles });

  const comparer = new Comparer(data, table, figures, {
    asOf, dataAsOf, includeUnallocatedPool, includeConvertibles,
    ptepMonths: settings.equity.postTerminationExerciseMonths, optionTermYears: settings.equity.optionTermYears,
    importIssues: issues, ledgerCertificates: dataFigures.certificates,
  });
  comparer.compareGrants();
  comparer.compareHolders();
  comparer.compareClasses();
  comparer.compareInternal();
  comparer.comparePercentages();
  comparer.addImportIssues();
  comparer.classify();

  const comparisons = comparer.comparisons;
  const differences: Difference[] = comparisons.filter((c) => c.differs).map((c) => ({
    level: c.level, key: c.key, field: c.field, unit: c.unit, source: c.source, app: c.app, difference: c.difference,
    category: c.explanation!.category, bug: c.explanation!.bug ?? null, note: c.explanation!.note, root: c.explanation!.root !== false, where: c.where,
  }));
  const counts = Object.fromEntries(LEVELS.map((level) => {
    const at = comparisons.filter((c) => c.level === level);
    const differing = at.filter((c) => c.differs).length;
    return [level, { compared: at.length, matching: at.length - differing, differing }];
  })) as Reconciliation['counts'];
  const tally = (list: Difference[]) => Object.fromEntries(CATEGORIES.map((cat) => [cat, list.filter((d) => d.category === cat).length])) as Record<Category, number>;
  const bugs: Record<string, number> = {};
  for (const d of differences) for (const b of d.bug?.split(' ') ?? []) bugs[b] = (bugs[b] ?? 0) + 1;

  return {
    asOf, dataAsOf,
    company: options.company ?? figures.company ?? dataFigures.company,
    system: options.system ?? figures.system ?? dataFigures.system,
    options: { includeUnallocatedPool, includeConvertibles, dateOrder, postTerminationExerciseMonths: settings.equity.postTerminationExerciseMonths, optionTermYears: settings.equity.optionTermYears },
    files: files.map((f) => f.name), figureFiles: options.figures?.map((f) => f.name) ?? [],
    sheets: [...dataFigures.sheets, ...(options.figures?.length ? figures.sheets.map((s) => ({ ...s, use: `${s.use} (figures only)` })) : [])],
    imported, assumptions, data, table, figures, comparisons, differences, counts,
    categories: tally(differences), rootCategories: tally(differences.filter((d) => d.root)), bugs,
    passed: !differences.some((d) => d.category === 'unexplained'),
  };
}
