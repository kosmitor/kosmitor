/**
 * What an export says about itself: its as-of date, the company, the system it
 * came from, and every figure the reconciliation compares against — the summary
 * tab, the ownership and voting tables, the ledger tabs' own columns and the
 * plan size block under the grants.
 *
 * The ledger tabs are what the import reads. They are read a second time here,
 * column by column, for the figures the import does not take in: a grant's
 * outstanding and vested counts, a certificate's capital contribution, a SAFE's
 * outstanding principal. Nothing here writes anything or decides anything; the
 * comparison is compare.ts.
 */
import { parseXlsx } from '../import/xlsx.ts';
import { parseCsv } from '../import/csv.ts';
import { parseXmlTable } from '../import/xml.ts';
import {
  detectSheet, guessHeaderRow, normalizeHeader, coerceNumber, coerceDate, coerceText,
  type Cell, type ImportKind,
} from '../import/values.ts';
import { isPlanSizeRow, type MappingValue } from '../import/engine.ts';

export interface ExportFile { name: string; body: Buffer }
export interface Sheet { file: string; name: string; rows: Cell[][] }

/** A tab the import reads, with the mapping the import wizard would guess for it. */
export interface LedgerSheet extends Sheet {
  kind: ImportKind;
  headerRow: number;
  headers: Cell[];
  data: Cell[][];
  mapping: Record<string, MappingValue>;
}

export type Measure =
  | 'authorized' | 'outstanding' | 'available' | 'invested' | 'options' | 'warrants' | 'fullyDiluted'
  | 'outstandingPct' | 'fullyDilutedPct' | 'votes' | 'votingPct';
export const PCT_MEASURES: Measure[] = ['outstandingPct', 'fullyDilutedPct', 'votingPct'];

/** One labelled line of a summary or ownership table: its numbers by what they measure. */
export interface Line {
  name: string;
  /** Every label the line carries, for a summary that writes "CS" in one column and "Common" in the next. */
  aliases: string[];
  where: string;
  values: Partial<Record<Measure, number>>;
  /** Columns named after a share class or plan (ownership tables), by their header. */
  securities: Map<string, number>;
}

export interface Table {
  sheet: string;
  lines: Line[];
  total: Line | null;
  /** A line for the unallocated pool, when the table has one. */
  pool: Line | null;
  /** Half the last shown digit of each percentage column, as a fraction: what display rounding can account for. */
  pctTolerance: Partial<Record<Measure, number>>;
}

export interface CertificateLine {
  where: string; holder: string; className: string | null; certificateNo: string | null;
  outstanding: number | null; issued: number | null; price: number | null; invested: number | null;
}
export interface GrantLine {
  where: string; label: string | null; holder: string; plan: string | null;
  granted: number | null; exercised: number; cancelled: number;
  outstanding: number | null; vested: number | null; vestedExercised: number | null; unvested: number | null;
  strike: number | null; expiration: string | null;
}
export interface ConvertibleLine {
  where: string; label: string | null; holder: string; status: string | null;
  principal: number | null; principalOutstanding: number | null;
  /** Interest accrued to the export's date, in cents, when the export states it. */
  interest: number | null;
}
export interface PlanFooter { plan: string | null; where: string; authorized: number | null; available: number | null }
export interface LedgerTotal { sheet: string; where: string; kind: ImportKind; className: string | null; values: Record<string, number> }

export interface SourceFigures {
  asOf: string | null;
  company: string | null;
  system: string | null;
  summary: Table | null;
  ownership: Table | null;
  voting: Table | null;
  certificates: CertificateLine[];
  grants: GrantLine[];
  convertibles: ConvertibleLine[];
  planFooters: PlanFooter[];
  /** "Total" lines at the foot of the ledgers. */
  ledgerTotals: LedgerTotal[];
  /** The ledger columns found, so the comparison knows what the export states and what the import assumed. */
  columns: { grantOutstanding: boolean; grantVested: boolean; grantVestedExercised: boolean; grantUnvested: boolean; grantExpiration: boolean; certificateInvested: boolean };
  /** What became of every tab. */
  sheets: { file: string; sheet: string; use: string }[];
}

const where = (s: Sheet, rowIndex: number): string => `${s.file} › ${s.name}, row ${rowIndex + 1}`;
const blank = (c: Cell): boolean => c == null || String(c).trim() === '';
const text = (c: Cell): string | null => coerceText(c).value;
const num = (c: Cell): number | null => coerceNumber(c).value;
/** Dollars per share to micro-cents, like the import. */
const price = (c: Cell): number | null => { const n = num(c); return n == null ? null : Math.round(n * 1_000_000); };
const cents = (c: Cell): number | null => { const n = num(c); return n == null ? null : Math.round(n * 100); };

/** Every non-empty tab of a file: an Excel workbook, an XML table or a CSV. */
export function readSheets(file: ExportFile): Sheet[] {
  const isZip = file.body.length > 4 && file.body.readUInt32LE(0) === 0x04034b50;
  let sheets: { name: string; rows: Cell[][] }[];
  if (isZip) sheets = parseXlsx(file.body);
  else {
    const body = file.body.toString('utf8').replace(/^﻿/, '');
    sheets = /^\s*</.test(body) ? parseXmlTable(body) : [{ name: file.name.replace(/\.[^.]+$/, ''), rows: parseCsv(body) }];
  }
  return sheets.filter((s) => s.rows.length > 0).map((s) => ({ file: file.name, name: s.name, rows: s.rows }));
}

/** The tab as the import wizard would take it, or null when it holds no records (a summary, an ownership table). */
export function asLedger(sheet: Sheet): LedgerSheet | null {
  const headerRow = guessHeaderRow(sheet.rows);
  const headers = sheet.rows[headerRow] ?? [];
  const data = sheet.rows.slice(headerRow + 1);
  const det = detectSheet(sheet.name, headers, data.length);
  // A ledger short of a required column is asked about in the import page; with nobody to ask, it is left out.
  if (!det.kind || det.missing.length > 0) return null;
  const mapping: Record<string, MappingValue> = { ...det.mapping };
  for (const [k, v] of Object.entries(det.constants)) if (mapping[k] == null) mapping[k] = { value: v };
  return { ...sheet, kind: det.kind, headerRow, headers, data, mapping };
}

// ---------------------------------------------------------------------------
// Summary, ownership and voting tables
// ---------------------------------------------------------------------------

/** What a column measures, from its header. Percentages are matched first: "Fully Diluted % Ownership" is not "Fully Diluted". */
const MEASURE_HEADERS: [Measure, RegExp][] = [
  ['fullyDilutedPct', /fully diluted.*(%|percent|ownership)|^fd ?%/],
  ['votingPct', /voting.*(%|percent|ownership)|^votes? ?%/],
  ['outstandingPct', /outstanding.*(%|percent|ownership)|^(% )?ownership( %| percentage)?$/],
  ['authorized', /^(total )?authori[sz]ed( shares)?$/],
  ['outstanding', /^(issued (and|&) outstanding|shares outstanding|outstanding shares|outstanding|issued outstanding)$/],
  ['available', /^(available shares|available|available for (issuance|grant)|shares available|remaining|unallocated)$/],
  ['invested', /^(capital contribution|capital contributed|amount invested|invested|cash paid)$/],
  ['options', /^(stock options|options outstanding|options|outstanding options|awards outstanding)$/],
  ['warrants', /^warrants( outstanding)?$/],
  ['fullyDiluted', /^fully diluted( shares)?$/],
  ['votes', /^(votes|voting shares|number of votes)$/],
];

/** A line whose label names the figure it carries, in whatever column it sits: "Options Outstanding 1,234". */
export const LABELLED_TOTALS: [Measure, RegExp][] = [
  ['options', /^(options outstanding|stock options( outstanding)?|outstanding options|total options( outstanding)?)$/],
  ['available', /^(available for (issuance|grant)|available|unallocated( pool| options)?|shares available|remaining|pool available|available shares)$/],
  ['fullyDiluted', /^(fully diluted( shares| total)?|total fully diluted( shares)?)$/],
  ['warrants', /^warrants( outstanding)?$/],
  ['outstanding', /^(total (shares )?outstanding|issued (and|&) outstanding)$/],
];

const NAME_HEADERS = new Set(['stakeholder', 'stakeholder name', 'name', 'holder', 'holder name', 'shareholder', 'shareholder name', 'investor', 'investor name']);
/** Columns of an ownership table that are neither a name, a figure nor a security. */
const IGNORED_HEADERS = /^(stakeholder )?(external id|id|type|stakeholder type|email|relationship|group|-)$/;

const headerText = (c: Cell): string => String(c ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const measureOf = (c: Cell): Measure | null => {
  const h = headerText(c);
  if (!h) return null;
  return MEASURE_HEADERS.find(([, re]) => re.test(h))?.[0] ?? null;
};
const isTotalLabel = (s: string): boolean => /^(grand )?totals?\b/i.test(s.trim());
const isPoolLabel = (s: string): boolean => /^(available|unallocated|remaining|pool available|options available)/i.test(s.trim());

/** Decimal places a number is written with, as a cell holds it. */
function decimalsOf(c: Cell): number {
  const s = typeof c === 'number' ? String(c) : String(c ?? '').replace(/[%,\s$]/g, '');
  if (/e-/i.test(s)) return 12;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Reads a table whose columns are figures: a summary (one line per class or
 * plan, or one figure per labelled line) or an ownership table (one line per
 * holder). Percentages come back as fractions, whatever way the export writes
 * them, with the rounding their shown digits allow.
 */
function readTable(sheet: Sheet, withNames: boolean): Table | null {
  // The header is the row among the first fifteen that names the most figures.
  let headerRow = -1, best = 0;
  sheet.rows.slice(0, 15).forEach((row, i) => {
    const n = row.filter((c) => measureOf(c) != null).length;
    if (n > best) { best = n; headerRow = i; }
  });
  if (headerRow < 0) return null;
  const header = sheet.rows[headerRow];
  const nameCol = withNames ? header.findIndex((c) => NAME_HEADERS.has(normalizeHeader(c))) : -1;
  if (withNames && nameCol < 0) return null;
  const measures = new Map<number, Measure>();
  const securities = new Map<number, string>();
  header.forEach((c, i) => {
    const m = measureOf(c);
    if (m) { if (![...measures.values()].includes(m)) measures.set(i, m); return; }
    if (withNames && i !== nameCol && !blank(c) && !IGNORED_HEADERS.test(headerText(c)) && !NAME_HEADERS.has(normalizeHeader(c))) securities.set(i, String(c).trim());
  });

  // Percentage columns: a cell written "12.5%" is a percentage; numbers are fractions unless the column runs past 1.
  const pctScale = new Map<number, number>();
  const pctTolerance: Partial<Record<Measure, number>> = {};
  for (const [col, m] of measures) {
    if (!PCT_MEASURES.includes(m)) continue;
    const cells = sheet.rows.slice(headerRow + 1).map((r) => r[col]).filter((c) => !blank(c));
    const max = Math.max(0, ...cells.map((c) => Math.abs(num(String(c).replace('%', '')) ?? 0)));
    const scale = cells.some((c) => String(c).trim().endsWith('%')) || max > 1.0001 ? 100 : 1;
    pctScale.set(col, scale);
    const digits = Math.min(12, Math.max(0, ...cells.map(decimalsOf)));
    pctTolerance[m] = Math.max(1e-9, (0.5 * 10 ** -digits) / scale);
  }

  const lines: Line[] = [];
  let total: Line | null = null;
  let pool: Line | null = null;
  sheet.rows.slice(headerRow + 1).forEach((row, i) => {
    const firstMeasure = Math.min(...measures.keys());
    const labels = withNames ? [text(row[nameCol])].filter((c): c is string => !!c)
      : row.slice(0, Math.max(1, firstMeasure)).map((c) => (typeof c === 'string' && num(c) == null ? text(c) : null)).filter((c): c is string => !!c);
    const label = labels[0] ?? null;
    if (!label) return;
    const values: Partial<Record<Measure, number>> = {};
    for (const [col, m] of measures) {
      const c = row[col];
      if (blank(c)) continue;
      if (PCT_MEASURES.includes(m)) {
        const n = num(String(c).replace('%', ''));
        if (n != null) values[m] = n / (pctScale.get(col) ?? 1);
      } else if (m === 'invested') {
        const n = cents(c);
        if (n != null) values[m] = n;
      } else {
        const n = num(c);
        if (n != null) values[m] = n;
      }
    }
    if (!withNames) {
      // A line labelled with its figure ("Fully Diluted Shares") carries it in the first number on the line.
      const labelled = LABELLED_TOTALS.find(([, re]) => re.test(label.toLowerCase().replace(/\s+/g, ' ')));
      if (labelled && values[labelled[0]] == null) {
        const first = row.map(num).find((n) => n != null);
        if (first != null) { for (const k of Object.keys(values) as Measure[]) delete values[k]; values[labelled[0]] = first; }
      }
    }
    const sec = new Map<string, number>();
    for (const [col, name] of securities) { const n = num(row[col]); if (n != null) sec.set(name, n); }
    if (Object.keys(values).length === 0 && sec.size === 0) return;
    const line: Line = { name: label, aliases: labels, where: where(sheet, headerRow + 1 + i), values, securities: sec };
    if (isTotalLabel(label)) total ??= line;
    else if (withNames && isPoolLabel(label)) pool ??= line;
    else lines.push(line);
  });
  if (lines.length === 0 && !total) return null;
  return { sheet: sheet.name, lines, total, pool, pctTolerance };
}

/** "As of Sept 16, 2026", "Cap table as of | 2026-09-22", in the first rows of any tab. */
function findAsOf(sheets: Sheet[]): string | null {
  for (const s of sheets) {
    for (const row of s.rows.slice(0, 8)) {
      for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        if (typeof cell !== 'string') continue;
        const m = /\bas of\b[:\s]*(.*)$/i.exec(cell.trim());
        if (!m) continue;
        const inline = m[1] ? coerceDate(m[1]).value : null;
        if (inline) return inline;
        const next = row.slice(i + 1).find((c) => !blank(c));
        const date = next != null ? coerceDate(next).value : null;
        if (date) return date;
      }
    }
  }
  return null;
}

/** The title lines a tab opens with: its first rows that hold a cell or two, not a record. */
const titleCells = (s: Sheet): string[] =>
  s.rows.slice(0, 4).filter((r) => r.filter((c) => !blank(c)).length <= 2).flat().filter((c): c is string => typeof c === 'string').map((c) => c.trim());

/** The legal name a summary opens with ("Marlowe Systems, Inc."), when it looks like one. */
function findCompany(sheets: Sheet[]): string | null {
  for (const s of sheets) {
    const name = titleCells(s).find((t) => /\b(inc|llc|corp|corporation|ltd|limited|gmbh|plc|s\.?a\.?s?|co)\b\.?/i.test(t) && t.length <= 120);
    if (name) return name;
  }
  return null;
}

/** The system named in a file name, a tab name or a tab's title lines. */
function findSystem(files: string[], sheets: Sheet[]): string | null {
  const words = [...files, ...sheets.map((s) => s.name), ...sheets.flatMap(titleCells)];
  if (words.some((w) => /\bpulley\b/i.test(w))) return 'Pulley';
  if (words.some((w) => /\bcarta\b/i.test(w))) return 'Carta';
  return null;
}

// ---------------------------------------------------------------------------
// Ledgers, read for their own figures
// ---------------------------------------------------------------------------

const columnFor = (headers: Cell[], re: RegExp): number => headers.findIndex((h) => re.test(normalizeHeader(h)));
const mapped = (row: Cell[], m: MappingValue | undefined): Cell => (m == null ? undefined : typeof m === 'number' ? row[m] : m.value);

function readLedger(l: LedgerSheet, out: SourceFigures): void {
  const name = (row: Cell[]) => text(mapped(row, l.mapping.stakeholderName));
  const addTotal = (row: Cell[], i: number, cols: Record<string, number>, className: string | null) => {
    const values: Record<string, number> = {};
    for (const [k, col] of Object.entries(cols)) { const n = col >= 0 ? num(row[col]) : null; if (n != null) values[k] = n; }
    if (Object.keys(values).length) out.ledgerTotals.push({ sheet: l.name, where: where(l, l.headerRow + 1 + i), kind: l.kind, className, values });
  };

  if (l.kind === 'captable') {
    const qty = l.mapping.quantity;
    const issuedCol = columnFor(l.headers, /^(shares issued|issued shares|issued)$/);
    const investedCol = columnFor(l.headers, /^(capital contribution|capital contributed|amount paid|cash paid|invested|amount invested)$/);
    if (investedCol >= 0) out.columns.certificateInvested = true;
    l.data.forEach((row, i) => {
      const holder = name(row);
      const className = text(mapped(row, l.mapping.shareClassName));
      if (!holder) {
        if (isTotalLabel(String(row.find((c) => !blank(c)) ?? ''))) addTotal(row, i, { outstanding: typeof qty === 'number' ? qty : -1, invested: investedCol }, className);
        return;
      }
      if (isTotalLabel(holder)) { addTotal(row, i, { outstanding: typeof qty === 'number' ? qty : -1, invested: investedCol }, className); return; }
      out.certificates.push({
        where: where(l, l.headerRow + 1 + i), holder, className,
        certificateNo: text(mapped(row, l.mapping.certificateNo)),
        outstanding: num(mapped(row, qty)),
        issued: issuedCol >= 0 && issuedCol !== qty ? num(row[issuedCol]) : null,
        price: price(mapped(row, l.mapping.pricePerShare)),
        invested: investedCol >= 0 ? cents(row[investedCol]) : null,
      });
    });
  }

  if (l.kind === 'grants') {
    const outstandingCol = columnFor(l.headers, /^(outstanding|options outstanding|shares outstanding|outstanding options|outstanding shares)$/);
    const vestedCol = columnFor(l.headers, /^(vested|vested shares|shares vested|options vested)$/);
    const vestedExercisedCol = columnFor(l.headers, /^vested (exercised|settled|exercised settled)$/);
    const unvestedCol = columnFor(l.headers, /^(unvested|unvested shares|shares unvested|options unvested)$/);
    out.columns.grantOutstanding ||= outstandingCol >= 0;
    out.columns.grantVested ||= vestedCol >= 0;
    out.columns.grantVestedExercised ||= vestedExercisedCol >= 0;
    out.columns.grantUnvested ||= unvestedCol >= 0;
    out.columns.grantExpiration ||= l.mapping.expirationDate != null;
    const plan = (row: Cell[]) => text(mapped(row, l.mapping.poolName));
    let footerPlan: string | null = null;
    l.data.forEach((row, i) => {
      if (isPlanSizeRow(row)) {
        const labelIdx = row.findIndex((c) => !blank(c));
        const label = String(row[labelIdx]).trim().toLowerCase();
        const value = row.map((c, j) => (j === labelIdx ? null : num(c))).find((n) => n != null) ?? null;
        let footer = out.planFooters.find((f) => f.where.startsWith(`${l.file} › ${l.name},`));
        if (!footer) { footer = { plan: footerPlan ?? text(mapped(row, l.mapping.poolName)), where: where(l, l.headerRow + 1 + i), authorized: null, available: null }; out.planFooters.push(footer); }
        if (/authori[sz]ed|plan size|reserved|pool size/.test(label)) footer.authorized ??= value;
        else footer.available ??= value;
        return;
      }
      const holder = name(row);
      if (!holder || isTotalLabel(holder)) {
        if (isTotalLabel(String(row.find((c) => !blank(c)) ?? ''))) {
          addTotal(row, i, { granted: typeof l.mapping.quantity === 'number' ? l.mapping.quantity : -1, outstanding: outstandingCol, vested: vestedCol }, null);
        }
        return;
      }
      footerPlan ??= plan(row);
      out.grants.push({
        where: where(l, l.headerRow + 1 + i), label: text(mapped(row, l.mapping.label)), holder, plan: plan(row),
        granted: num(mapped(row, l.mapping.quantity)),
        exercised: num(mapped(row, l.mapping.exercisedQuantity)) ?? 0,
        cancelled: num(mapped(row, l.mapping.cancelledQuantity)) ?? 0,
        outstanding: outstandingCol >= 0 ? num(row[outstandingCol]) : null,
        vested: vestedCol >= 0 ? num(row[vestedCol]) : null,
        vestedExercised: vestedExercisedCol >= 0 ? num(row[vestedExercisedCol]) : null,
        unvested: unvestedCol >= 0 ? num(row[unvestedCol]) : null,
        strike: price(mapped(row, l.mapping.strikePrice)),
        expiration: coerceDate(mapped(row, l.mapping.expirationDate)).value,
      });
    });
  }

  if (l.kind === 'convertibles') {
    const outstandingCol = columnFor(l.headers, /^(principal outstanding|outstanding principal|outstanding)$/);
    const interestCol = columnFor(l.headers, /^(interest accrued|accrued interest|accrued interest to date|interest outstanding)$/);
    l.data.forEach((row, i) => {
      const holder = name(row);
      if (!holder || isTotalLabel(holder)) return;
      out.convertibles.push({
        where: where(l, l.headerRow + 1 + i), label: text(mapped(row, l.mapping.label)), holder,
        status: text(mapped(row, l.mapping.status)),
        principal: cents(mapped(row, l.mapping.principal)),
        principalOutstanding: outstandingCol >= 0 && outstandingCol !== l.mapping.principal ? cents(row[outstandingCol]) : null,
        interest: interestCol >= 0 ? cents(row[interestCol]) : null,
      });
    });
  }
}

/**
 * Everything the export states. `ledgers` are the tabs the import reads; the
 * other tabs are looked at as a summary, an ownership table or a voting table.
 */
export function readFigures(files: string[], sheets: Sheet[], ledgers: LedgerSheet[]): SourceFigures {
  const isLedger = (s: Sheet) => ledgers.some((l) => l.file === s.file && l.name === s.name);
  const others = sheets.filter((s) => !isLedger(s));
  const out: SourceFigures = {
    asOf: findAsOf(others) ?? findAsOf(ledgers), company: findCompany(others), system: findSystem(files, sheets),
    summary: null, ownership: null, voting: null,
    certificates: [], grants: [], convertibles: [], planFooters: [], ledgerTotals: [],
    columns: { grantOutstanding: false, grantVested: false, grantVestedExercised: false, grantUnvested: false, grantExpiration: false, certificateInvested: false },
    sheets: [],
  };
  for (const l of ledgers) {
    readLedger(l, out);
    out.sheets.push({ file: l.file, sheet: l.name, use: `imported as ${l.kind}` });
  }
  for (const s of others) {
    const voting = readTable(s, true);
    if (voting && voting.lines.some((l) => l.values.votes != null) && !out.voting) {
      out.voting = voting;
      out.sheets.push({ file: s.file, sheet: s.name, use: 'voting table' });
      continue;
    }
    if (voting && voting.lines.some((l) => l.securities.size > 0 || l.values.fullyDiluted != null || l.values.outstanding != null) && !out.ownership) {
      out.ownership = voting;
      out.sheets.push({ file: s.file, sheet: s.name, use: 'ownership table' });
      continue;
    }
    const summary = readTable(s, false);
    if (summary && !out.summary) {
      out.summary = summary;
      out.sheets.push({ file: s.file, sheet: s.name, use: 'summary' });
      continue;
    }
    out.sheets.push({ file: s.file, sheet: s.name, use: 'not used' });
  }
  return out;
}
