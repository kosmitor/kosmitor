/**
 * The import page's data: the shapes the import API sends (docs/importing.md,
 * "Building an import page"), the state the page keeps while someone checks an
 * import, and the pure functions between them — the request body, and the
 * grouping of the dry run's messages into the questions the page asks.
 *
 * The server holds no import state. The page keeps every parsed row, applies
 * the person's edits to the cells it sends (never to the file), and sends the
 * same body again to import, with the review's token.
 */
import { AWARD_LABELS, INSTRUMENT_LABELS, RELATION_LABELS } from '../../format.ts';
import { STAKEHOLDER_TYPES } from '../stakeholders/StakeholderForm.tsx';

// ---------------------------------------------------------------------------
// What the API sends
// ---------------------------------------------------------------------------

export type Cell = string | number | boolean | null;
export type Kind = 'stakeholders' | 'captable' | 'grants' | 'convertibles';
/** A field reads a column, or takes one fixed value on every row (a share class named by the tab). */
export type MappingValue = number | { value: string } | null;
export type NumberFormat = 'en' | 'eu';
export type DateOrder = 'MDY' | 'DMY';

export interface FieldSpec { key: string; label: string; type: string; required: boolean; hint: string | null }
export interface KindSpec { key: Kind; label: string; description: string; fields: FieldSpec[] }
export interface Schema {
  maxRows: number; maxSheets: number; maxTotalRows: number; uploadMb: number; unzippedMb: number; maxColumns: number;
  relations: string[]; kinds: KindSpec[];
}

export interface Notice {
  code: string; level: 'warning' | 'info'; text: string;
  fix?: { option: 'raiseAuthorized'; value: string; shareClassId: string | null; className: string; to: number };
}
export interface ParsedSheet {
  name: string; rows: Cell[][]; rowCount: number; truncated: boolean; headerRow: number;
  numberFormat: NumberFormat; numberDecidedBy: 'file' | 'delimiter' | 'default';
  numberEvidence: { text: string; row: number } | null; numberMixed: boolean; notices: Notice[];
}
export interface ParsedFile { fileName: string; format: 'xlsx' | 'csv' | 'xml'; sheets: ParsedSheet[] }
export interface Detection {
  name: string; file: string | null; kind: Kind | null; mapping: Record<string, number | null>;
  constants: Record<string, string>; missing: string[]; ready: boolean; reason: string | null;
}
export interface RowMessage { level: 'error' | 'warning' | 'info'; text: string; code?: string; field?: string; value?: Cell; choices?: string[] }
export type Outcome = 'add' | 'update' | 'existing' | 'excluded' | 'skip' | 'error';
export interface PreviewRow {
  row: number; status: 'ok' | 'warning' | 'error'; action: 'create' | 'update' | 'skip'; outcome: Outcome;
  summary: Record<string, string | number | null>; messages: RowMessage[];
}
export interface Counts { total: number; ok: number; warnings: number; errors: number; skipped: number; willImport: number; existing: number; excluded: number }
export interface Creates { stakeholders: string[]; shareClasses: string[]; vestingSchedules: string[]; pools: string[] }
export interface Imported {
  stakeholders: number; shareClasses: number; issuances: number; awards: number; convertibles: number;
  vestingSchedules: number; pools: number; updated: { stakeholders: number };
}
export interface SheetResult {
  sheetName: string; file: string | null; kind: Kind; blocked: boolean; dateOrder: DateOrder | 'auto';
  numberFormat: NumberFormat; columnsNotImported: string[];
  preview: { rows: PreviewRow[]; counts: Counts; creates: Creates; notices: Notice[] };
}
export interface NewPerson {
  key: string; name: string; email: string | null; type: string; relation: string; guessed: boolean;
  sameName: { name: string; email: string | null; onRecord: boolean }[];
  rows: { file: string | null; sheet: string; row: number }[];
}
export interface ReadAs {
  file: string | null; sheets: string[]; dateOrder: DateOrder | 'mixed'; dateDecidedBy: 'file' | 'setting' | 'default';
  dateEvidence: { text: string; sheet: string | null; row: number } | null; ambiguousDates: number; textDates: number;
  numberFormat: NumberFormat | 'mixed'; numberDecidedBy: string; numberEvidence: { text: string; sheet: string | null; row: number } | null;
}
export interface Review {
  sheets: SheetResult[]; counts: Counts; creates: Creates; imported: Imported; importIds: string[];
  files: (string | null)[]; newPeople: NewPerson[]; readAs: ReadAs[]; notices: Notice[];
  raised: { shareClassId: string; name: string; from: number; to: number }[]; reviewToken: string;
}

// ---------------------------------------------------------------------------
// What the page keeps
// ---------------------------------------------------------------------------

/** One file in this import. Its date order and number format are the person's choice, when they made one. */
export interface ImportFile {
  id: string;
  /** The name sent to the server: the file's own, made unique within the import. */
  name: string;
  /** The file's own name. */
  original: string;
  size: number;
  lastModified: number;
  numberFormat?: NumberFormat;
  dateOrder?: DateOrder;
}

/** One tab of one file, and how it is imported. */
export interface Tab {
  key: string;
  fileId: string;
  file: string;
  name: string;
  /** Every row parse kept: the title rows, the header and the rows below it. */
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  headerRow: number;
  numberFormat: NumberFormat;
  numberDecidedBy: string;
  numberEvidence: { text: string; row: number } | null;
  notices: Notice[];
  /** What the tab holds; null when it is not imported. */
  kind: Kind | null;
  detectedKind: Kind | null;
  reason: string | null;
  mapping: Record<string, MappingValue>;
  /** Not imported: a summary tab, or one the person left out. */
  leftOut: boolean;
  /** The person chose what the tab holds, or to leave it out. */
  chosen?: boolean;
  /** Nothing recognised it and it is the file's only table: the page asks what it holds. */
  ask: boolean;
  /**
   * Columns the page added to every row, after the file's own: an email to tell
   * two people apart, or a field a row edit filled in. `fill` is every other
   * row's value (what the field held for every row before, if anything).
   */
  added: { field: string; header: string; fill?: Cell }[];
}

/** The person's changes to the cells, for this import only: by tab, by spreadsheet row, by column. */
export interface Edits {
  cells: Record<string, Record<number, Record<number, Cell>>>;
  /** A value replaced wherever it appears in a field's column ("Option" → "ISO"): by tab, field, value as written. */
  replace: Record<string, Record<string, Record<string, string>>>;
  /** Rows left out, by tab. */
  exclude: Record<string, number[]>;
  /** Why each row was left out, as its problems read when it was: for the row and the left-out rows' file. */
  why: Record<string, Record<number, string>>;
}

export interface Settings {
  createMissingStakeholders: boolean;
  createMissingShareClasses: boolean;
  defaultVestingScheduleId: string;
  certificateVestingScheduleId: string;
  defaultPoolId: string;
  defaultPoolName: string;
}

/** Answers sent with the check. What the person dismissed is kept apart: it changes nothing the server reads. */
export interface Answers {
  relationships: Record<string, string>;
  raiseAuthorized: string[];
  /** The class each raise is for, by its value: so "Common raised to N" can be undone. */
  raisedNames: Record<string, string>;
}

export const NO_EDITS: Edits = { cells: {}, replace: {}, exclude: {}, why: {} };
export const NO_ANSWERS: Answers = { relationships: {}, raiseAuthorized: [], raisedNames: {} };
export const DEFAULT_SETTINGS: Settings = {
  createMissingStakeholders: true, createMissingShareClasses: true,
  defaultVestingScheduleId: '', certificateVestingScheduleId: '', defaultPoolId: '', defaultPoolName: '',
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** What each kind is called on screen: the app's own words, not the import's internal ones. */
export const KIND_WORDS: Record<Kind, { title: string; one: string; many: string }> = {
  stakeholders: { title: 'Stakeholders', one: 'stakeholder', many: 'stakeholders' },
  captable: { title: 'Certificates', one: 'certificate', many: 'certificates' },
  grants: { title: 'Equity grants', one: 'grant', many: 'grants' },
  convertibles: { title: 'SAFEs & notes', one: 'SAFE or note', many: 'SAFEs & notes' },
};
export const KINDS: Kind[] = ['stakeholders', 'captable', 'grants', 'convertibles'];
/** Where Done (and a check with nothing new) leads back to, for the page the import was started from. */
export const BACK_TO: Record<Kind, { to: string; label: string }> = {
  captable: { to: '/cap-table', label: 'Open the cap table' },
  stakeholders: { to: '/stakeholders', label: 'Open stakeholders' },
  grants: { to: '/grants', label: 'Open equity grants' },
  convertibles: { to: '/convertibles', label: 'Open SAFEs & notes' },
};
export const isKind = (k: unknown): k is Kind => typeof k === 'string' && (KINDS as string[]).includes(k);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const cellText = (c: Cell | undefined): string =>
  (c === null || c === undefined ? '' : typeof c === 'boolean' ? (c ? 'Yes' : 'No') : String(c));
export const isMapped = (m: MappingValue | undefined): boolean => m != null && (typeof m === 'number' || m.value.trim() !== '');
export const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

const TYPE_LABELS = Object.fromEntries(STAKEHOLDER_TYPES) as Record<string, string>;
const CONVERTIBLE_STATUS: Record<string, string> = { OUTSTANDING: 'Outstanding', CONVERTED: 'Converted', CANCELLED: 'Cancelled', REPAID: 'Repaid' };
const COMPOUNDING: Record<string, string> = { SIMPLE: 'Simple', ANNUAL: 'Annual', MONTHLY: 'Monthly', DAILY: 'Daily' };

/** A code from a row's summary in words: Founder, Post-money SAFE, Individual. */
export function codeLabel(kind: Kind, key: string, v: string): string {
  if (key === 'relation') return RELATION_LABELS[v] ?? v;
  if (key === 'type') return kind === 'grants' ? AWARD_LABELS[v] ?? v : TYPE_LABELS[v] ?? v;
  if (key === 'instrument') return INSTRUMENT_LABELS[v] ?? v;
  if (key === 'status') return CONVERTIBLE_STATUS[v] ?? v;
  return v;
}

/**
 * The words that replace a value nobody recognised, by field: written into the
 * cell, they read as the right code ("Board member" is read as a board member).
 */
export function replacementsFor(field: string, schedules: { name: string }[]): string[] {
  switch (field) {
    case 'relation': return Object.values(RELATION_LABELS);
    case 'stakeholderType': return Object.values(TYPE_LABELS);
    case 'awardType': return Object.values(AWARD_LABELS);
    case 'instrument': return ['Post-money SAFE', 'Pre-money SAFE', 'Convertible note', 'KISS'];
    case 'status': return Object.values(CONVERTIBLE_STATUS);
    case 'compounding': return Object.values(COMPOUNDING);
    case 'vestingSchedule': return schedules.map((s) => s.name);
    default: return [];
  }
}

/** A row's verdict in the words of its badge, and the badge's tone. */
export function verdict(r: PreviewRow): { word: string; tone: 'success' | 'info' | 'neutral' | 'warning' | 'danger' } {
  if (r.status === 'error' || r.outcome === 'error') return { word: 'Fix', tone: 'danger' };
  if (r.outcome === 'excluded') return { word: 'Left out', tone: 'neutral' };
  if (r.outcome === 'skip') return { word: 'Skipped', tone: 'neutral' };
  if (r.outcome === 'existing') return r.status === 'warning' ? { word: 'Already there', tone: 'warning' } : { word: 'Already there', tone: 'neutral' };
  if (r.status === 'warning') return { word: 'Check', tone: 'warning' };
  if (r.outcome === 'update') return { word: 'Update', tone: 'info' };
  return { word: 'Add', tone: 'success' };
}

// ---------------------------------------------------------------------------
// Tabs and the request
// ---------------------------------------------------------------------------

export const withConstants = (d: { mapping: Record<string, number | null>; constants?: Record<string, string> }): Record<string, MappingValue> => ({
  ...d.mapping,
  ...Object.fromEntries(Object.entries(d.constants ?? {}).map(([k, v]) => [k, { value: v }])),
});

export const headersOf = (t: Tab): Cell[] => t.rows[t.headerRow] ?? [];
/** How wide the file's own rows are: added columns go after this. */
export const widthOf = (t: Tab): number => t.rows.reduce((w, r) => Math.max(w, r.length), 0);
/** Rows below the header, as the file has them. */
export const dataRowsOf = (t: Tab): Cell[][] => t.rows.slice(t.headerRow + 1);
/** A row's spreadsheet number from its place below the header, and back. */
export const rowNumberOf = (t: Tab, index: number): number => t.headerRow + 2 + index;
export const indexOfRow = (t: Tab, row: number): number => row - t.headerRow - 2;

/**
 * The tab's mapping. A column the page added is mapped like any other (to its
 * field, when it is added), so the Columns panel can map that field elsewhere.
 */
export function mappingOf(t: Tab): Record<string, MappingValue> {
  return { ...t.mapping };
}

/** The longest sheet name the check takes (imports/workbook/preview). */
export const SHEET_NAME_MAX = 120;
/**
 * The names a file's tabs are sent under: trimmed and cut to the check's limit,
 * as the server reads them, and unique within the file, so a review's sheet can
 * always be found again by its name. A CSV's one tab is named after the file.
 */
export function sheetNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((raw, i) => {
    const base = (raw.trim() || `Sheet ${i + 1}`).slice(0, SHEET_NAME_MAX).trim();
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trim()}${suffix}`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

/** The kind's required fields that have no column and no value for every row. */
export function missingOf(t: Tab, schema: Schema): string[] {
  if (!t.kind) return [];
  const m = mappingOf(t);
  return (schema.kinds.find((k) => k.key === t.kind)?.fields ?? []).filter((f) => f.required && !isMapped(m[f.key])).map((f) => f.key);
}

/** Goes to the check as it is: what it holds is known, it is not left out, and nothing required is missing. */
export const isReady = (t: Tab, schema: Schema): boolean => !!t.kind && !t.leftOut && missingOf(t, schema).length === 0;

const same = (a: Cell | undefined, raw: string): boolean => cellText(a).trim().toLowerCase() === raw.trim().toLowerCase();

/** The rows below the header as the check sees them: added columns, values replaced, cells edited. */
export function rowsFor(t: Tab, edits: Edits): Cell[][] {
  const width = widthOf(t);
  const mapping = mappingOf(t);
  const replace = edits.replace[t.key] ?? {};
  const cells = edits.cells[t.key] ?? {};
  const columns = Object.entries(replace)
    .map(([field, values]) => ({ col: mapping[field], values }))
    .filter((x): x is { col: number; values: Record<string, string> } => typeof x.col === 'number');
  return dataRowsOf(t).map((r, i) => {
    const edited = cells[rowNumberOf(t, i)];
    if (t.added.length === 0 && columns.length === 0 && !edited) return r;
    const row: Cell[] = [...r];
    while (row.length < width) row.push(null);
    for (const a of t.added) row.push(a.fill ?? null);
    for (const { col, values } of columns) {
      for (const [raw, to] of Object.entries(values)) if (same(row[col], raw)) row[col] = to;
    }
    if (edited) for (const [col, v] of Object.entries(edited)) row[Number(col)] = v;
    return row;
  });
}

/** One sheet of the preview and commit body. */
export function sheetBody(t: Tab, file: ImportFile | undefined, edits: Edits) {
  const mapping = mappingOf(t);
  // A value for every row (a class named by the tab) is replaced as a cell would be.
  for (const [field, values] of Object.entries(edits.replace[t.key] ?? {})) {
    const m = mapping[field];
    if (m && typeof m !== 'number') for (const [raw, to] of Object.entries(values)) if (same(m.value, raw)) mapping[field] = { value: to };
  }
  const exclude = edits.exclude[t.key] ?? [];
  return {
    file: t.file, name: t.name, kind: t.kind,
    headers: [...headersOf(t), ...t.added.map((a) => a.header)],
    rows: rowsFor(t, edits),
    headerRowNumber: t.headerRow + 1,
    mapping,
    rowCount: t.rowCount,
    numberFormat: file?.numberFormat ?? t.numberFormat,
    ...(file?.dateOrder ? { dateOrder: file.dateOrder } : {}),
    ...(exclude.length ? { excludeRows: [...exclude].sort((a, b) => a - b) } : {}),
  };
}

export function requestBody(tabs: Tab[], files: ImportFile[], edits: Edits, settings: Settings, answers: Answers, schema: Schema) {
  const ready = tabs.filter((t) => isReady(t, schema));
  return {
    sheets: ready.map((t) => sheetBody(t, files.find((f) => f.id === t.fileId), edits)),
    options: {
      createMissingStakeholders: settings.createMissingStakeholders,
      createMissingShareClasses: settings.createMissingShareClasses,
      ...(settings.defaultVestingScheduleId ? { defaultVestingScheduleId: settings.defaultVestingScheduleId } : {}),
      ...(settings.certificateVestingScheduleId ? { certificateVestingScheduleId: settings.certificateVestingScheduleId } : {}),
      ...(settings.defaultPoolId ? { defaultPoolId: settings.defaultPoolId } : {}),
      ...(!settings.defaultPoolId && settings.defaultPoolName.trim() ? { defaultPoolName: settings.defaultPoolName.trim() } : {}),
      ...(Object.keys(answers.relationships).length ? { relationships: answers.relationships } : {}),
      ...(answers.raiseAuthorized.length ? { raiseAuthorized: answers.raiseAuthorized } : {}),
    },
  };
}

/** The tab a sheet of the review came from. */
export const tabOf = (tabs: Tab[], s: { file: string | null; sheetName?: string; sheet?: string }): Tab | undefined =>
  tabs.find((t) => t.file === s.file && t.name === (s.sheetName ?? s.sheet));

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface RowRef { tab: string; row: number }

/** One answer that fixes every row it names. The first five block the import until answered. */
export type Question =
  | { type: 'kind'; id: string; tab: string }
  | { type: 'column'; id: string; tab: string; field: string }
  | { type: 'plan'; id: string; rows: RowRef[] }
  | { type: 'vesting'; id: string; rows: RowRef[] }
  | { type: 'value'; id: string; code: string; field: string; value: string; text: string; rows: RowRef[] }
  | { type: 'create'; id: string; option: 'createMissingStakeholders' | 'createMissingShareClasses'; rows: RowRef[] }
  | { type: 'person'; id: string; name: string; choices: string[]; rows: RowRef[] }
  | { type: 'date'; id: string; fileId: string; file: string; example: string; rows: RowRef[] }
  | { type: 'number'; id: string; fileId: string; file: string; text: string; format: NumberFormat; rows: RowRef[] }
  | { type: 'notice'; id: string; notice: Notice }
  /** A tab read as a stakeholder list whose ledger columns (shares, price, dates) are dropped. */
  | { type: 'dropped'; id: string; tab: string; columns: string[] };

export const BLOCKING = new Set<Question['type']>(['kind', 'column', 'plan', 'vesting', 'value', 'create', 'person']);

/** Fields whose unrecognised values a card can replace with the app's own words (replacementsFor). */
const REPLACEABLE = new Set(['relation', 'stakeholderType', 'awardType', 'instrument', 'status', 'compounding']);
/**
 * An error one of the cards answers for every row it names at once, as
 * questionsOf groups them. Any other error is fixed on its row (Edit row) or
 * the row is left out.
 */
export function cardAnswers(m: RowMessage, hasSchedules: boolean): boolean {
  if (m.level !== 'error') return false;
  switch (m.code) {
    case 'missing-plan': case 'create-off': return true;
    case 'missing-vesting': return hasSchedules;
    case 'ambiguous-award-type': return !!m.field && m.value != null;
    case 'unknown-value': return !!m.field && m.value != null && (REPLACEABLE.has(m.field) || (m.field === 'vestingSchedule' && hasSchedules));
    case 'ambiguous-person': return !!m.choices?.length;
    default: return false;
  }
}

/** Info codes for what the import filled in that the file does not say ("We filled in N things"). */
export const FILLED_IN: Record<string, string> = {
  'no-83b': 'Restricted stock with no 83(b) date recorded',
  'expiration-assumed': 'No expiration date: set from the grant date and the option term',
  'exercise-date-assumed': 'No exercise date: exercised options count from the grant date',
  'cancellation-dated-to-termination': "Cancelled shares dated to the holder's termination",
  'cancellation-date-missing': 'No cancellation date',
  'unused-value': 'A value that is not used',
  'interest-ignored': "SAFEs don't bear interest: the rate was ignored",
  'not-outstanding': 'Recorded as no longer outstanding',
  'instrument-assumed': 'Read as a post-money SAFE',
  'settled-date-missing': 'No date it was settled',
  'type-as-relationship': 'A type column read as the relationship',
  'relationship-as-type': 'A relationship column read as the type',
};

/** Everything the review asks, in the order the cards show. `dismissed` holds the ids of notices the person left as they are. */
export function questionsOf(review: Review | null, tabs: Tab[], files: ImportFile[], schema: Schema, dismissed: string[], hasSchedules: boolean): Question[] {
  const out: Question[] = [];
  for (const t of tabs) {
    if (t.leftOut) continue;
    if (!t.kind) { if (t.ask) out.push({ type: 'kind', id: `kind:${t.key}`, tab: t.key }); continue; }
    for (const field of missingOf(t, schema)) out.push({ type: 'column', id: `column:${t.key}:${field}`, tab: t.key, field });
  }
  if (!review) return out;

  const groups = new Map<string, Question>();
  const add = (id: string, make: () => Question, ref: RowRef) => {
    let q = groups.get(id);
    if (!q) { q = make(); groups.set(id, q); }
    if ('rows' in q && !q.rows.some((r) => r.tab === ref.tab && r.row === ref.row)) q.rows.push(ref);
  };
  for (const s of review.sheets) {
    const t = tabOf(tabs, s);
    if (!t) continue;
    const file = files.find((f) => f.id === t.fileId);
    for (const r of s.preview.rows) {
      const ref = { tab: t.key, row: r.row };
      for (const m of r.messages) {
        // An error no card can answer (a value with nothing to replace it by) is fixed on its row.
        if (m.level === 'error' && !cardAnswers(m, hasSchedules)) continue;
        if (m.code === 'missing-plan') add('plan', () => ({ type: 'plan', id: 'plan', rows: [] }), ref);
        else if (m.code === 'missing-vesting') add('vesting', () => ({ type: 'vesting', id: 'vesting', rows: [] }), ref);
        else if ((m.code === 'unknown-value' || m.code === 'ambiguous-award-type') && m.field && m.value != null) {
          const value = cellText(m.value).trim();
          add(`value:${m.field}:${value.toLowerCase()}`, () => ({ type: 'value', id: `value:${m.field}:${value.toLowerCase()}`, code: m.code!, field: m.field!, value, text: m.text, rows: [] }), ref);
        } else if (m.code === 'create-off') {
          const option = m.field === 'shareClassName' ? 'createMissingShareClasses' : 'createMissingStakeholders';
          add(`create:${option}`, () => ({ type: 'create', id: `create:${option}`, option, rows: [] }), ref);
        } else if (m.code === 'ambiguous-person' && m.choices?.length) {
          const name = cellText(r.summary.stakeholder);
          const id = `person:${name.toLowerCase()}:${m.choices.join('|')}`;
          add(id, () => ({ type: 'person', id, name, choices: m.choices!, rows: [] }), ref);
        } else if (m.code === 'ambiguous-date' && file && !file.dateOrder) {
          add(`date:${file.id}`, () => ({ type: 'date', id: `date:${file.id}`, fileId: file.id, file: file.name, example: cellText(m.value), rows: [] }), ref);
        } else if (m.code === 'ambiguous-number' && file && !file.numberFormat && !dismissed.includes(`number:${file.id}`)) {
          add(`number:${file.id}`, () => ({ type: 'number', id: `number:${file.id}`, fileId: file.id, file: file.name, text: m.text, format: s.numberFormat, rows: [] }), ref);
        }
      }
    }
  }
  out.push(...groups.values());
  for (const s of review.sheets) {
    const t = tabOf(tabs, s);
    const ledger = s.columnsNotImported.filter((c) => /share|price|issue|grant|strike|amount|principal|quantity|certificate/i.test(c));
    if (t && s.kind === 'stakeholders' && ledger.length && !t.chosen && !dismissed.includes(`dropped:${t.key}`)) {
      out.push({ type: 'dropped', id: `dropped:${t.key}`, tab: t.key, columns: ledger });
    }
  }
  for (const n of review.notices) {
    const id = `notice:${n.fix?.value ?? n.text}`;
    if (!dismissed.includes(id)) out.push({ type: 'notice', id, notice: n });
  }
  return out;
}

/** A row that needs a fix of its own: an error no card answers. */
export const needsOwnFix = (r: PreviewRow, hasSchedules: boolean): boolean =>
  r.status === 'error' && r.messages.some((m) => m.level === 'error' && !cardAnswers(m, hasSchedules));

/** Rows that go in once the rest of their tab is fixed: a tab with an open error adds nothing yet. */
export const readyWhenFixed = (s: SheetResult): number =>
  (s.blocked ? s.preview.rows.filter((r) => r.status !== 'error' && (r.outcome === 'add' || r.outcome === 'update')).length : 0);

/** "relationship, start date": what the updates to people change, from their messages. */
export function changedFields(review: Review): string[] {
  const words = ['email', 'type', 'relationship', 'title', 'start date', 'termination date', 'tax country', 'tax state', 'address', 'phone', 'notes', 'department'];
  const found = new Set<string>();
  for (const s of review.sheets) for (const r of s.preview.rows) for (const m of r.messages) {
    if (m.code !== 'stakeholder-updated') continue;
    const changes = m.text.replace(/^[^:]*:\s*/, '');
    for (const w of words) if (new RegExp(`(^|, )${w} `).test(changes)) found.add(w);
    if (/board seat/.test(changes)) found.add('board seat');
    if (/^Gives /.test(m.text)) found.add('email');
  }
  return words.concat('board seat').filter((w) => found.has(w));
}

/** A CSV cell: quoted when it must be, and text that a spreadsheet would run as a formula kept as text. */
export function csvCell(c: Cell): string {
  let s = cellText(c);
  if (typeof c === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
