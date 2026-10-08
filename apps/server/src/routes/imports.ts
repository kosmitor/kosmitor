/**
 * The import API. A page that imports runs four steps against it; the request
 * and response shapes, message codes and options are written out for client
 * builders in docs/importing.md ("Building an import page").
 *
 *   1. POST imports/parse        one call per file: the raw bytes in, sheets of cells out (nothing is written)
 *   2. POST imports/detect       every sheet's header: what each holds, its column mapping, what is missing
 *   3. POST imports/workbook/preview   all sheets of all files: the exact dry run, rolled back; its reviewToken names it
 *   4. POST imports/workbook/commit    the same body plus reviewToken (or expectedCounts): the same run, kept
 *
 * Errors come back as { error, detail: { code, ... } }; the codes are in the docs.
 * Nothing in a body is trusted: sheets, rows and cells are checked for shape
 * and size before the engine sees them, and an error the import did not expect
 * is a 500 with nothing of it shown.
 */
import { route, badRequest, notFound, audit, str, HttpError } from '../http.ts';
import { all, one, toCamelAll } from '../db.ts';
import { invalidate } from '../store.ts';
import { parseCsvTable, toCsv, decodeText, looksBinary, detectDelimiter } from '../import/csv.ts';
import { openZip, zipContents, parseWorkbook, squareUp, ZipTooLarge, MAX_COLUMNS, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, MAX_CELL_LENGTH, type ZipFiles } from '../import/xlsx.ts';
import { parseXmlTable, toXml } from '../import/xml.ts';
import {
  IMPORT_KINDS, NUMBER_FORMATS, suggestMapping, suggestForSheet, detectSheet, guessHeaderRow, detectNumberFormat,
  type ImportKind, type Cell, type DateOrder, type NumberFormat, type FieldSpec,
} from '../import/values.ts';
import {
  prepareImport, commitImport, runWorkbook, StaleReview, NotReviewed, RowsNeedFixing, RELATIONS,
  type ImportRequest, type ImportOptions, type MappingValue, type WorkbookSheet, type WorkbookExtras, type ImportCounts, type WorkbookResult, type Notice,
} from '../import/engine.ts';
import { xlsx } from '../xlsx-writer.ts';
import { config, megabytes } from '../config.ts';

const isKind = (k: unknown): k is ImportKind => typeof k === 'string' && Object.hasOwn(IMPORT_KINDS, k);

/** A file the import cannot read, with a code the page can show it by. */
const refuse = (code: string, message: string): HttpError => badRequest(message, { code });

/** Field definitions the wizard renders — synonyms stay server-side. */
route.get('/api/c/:cid/imports/schema', 'read', async () => ({
  maxRows: config().limits.importMaxRows,
  maxSheets: config().limits.importMaxSheets,
  maxTotalRows: config().limits.importMaxTotalRows,
  uploadMb: config().limits.importUploadMb,
  unzippedMb: config().limits.importUnzippedMb,
  maxColumns: MAX_COLUMNS,
  relations: RELATIONS,
  kinds: Object.values(IMPORT_KINDS).map((k) => ({
    key: k.key, label: k.label, description: k.description,
    fields: k.fields.map(({ key, label, type, required, hint }) => ({ key, label, type, required: !!required, hint: hint ?? null })),
  })),
}));

const XML_RECORD_NAMES: Record<ImportKind, [root: string, record: string]> = {
  stakeholders: ['stakeholders', 'stakeholder'], captable: ['captable', 'certificate'],
  grants: ['grants', 'grant'], convertibles: ['convertibles', 'instrument'],
};

/**
 * Template as CSV — the header row only, so nothing in it imports as a real
 * person — or as XML (`?format=xml`) with one element per field, named by the
 * field keys, and one example record to show the shape.
 */
route.get('/api/c/:cid/imports/template/:kind', 'read', async (ctx) => {
  const kind = ctx.params.kind;
  if (!isKind(kind)) throw notFound('Unknown import kind.');
  const [headers, ...examples] = IMPORT_KINDS[kind].template;
  if (ctx.query.get('format') === 'xml') {
    const mapping = suggestMapping(kind, headers);
    const keyByColumn = new Map<number, string>();
    for (const [key, col] of Object.entries(mapping)) if (col != null) keyByColumn.set(col, key);
    const names = headers.map((h, i) => keyByColumn.get(i) ?? h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^(\d)/, '_$1'));
    const [root, record] = XML_RECORD_NAMES[kind];
    ctx.res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}-template.xml"`,
    });
    ctx.res.end(toXml(root, record, names, examples.slice(0, 1)));
    return undefined;
  }
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${kind}-template.csv"`,
  });
  ctx.res.end(toCsv([headers]));
  return undefined;
});

/** The template workbook's tabs: named so detection reads each as its kind once it has rows. */
const TEMPLATE_TABS: [ImportKind, string][] = [['stakeholders', 'Stakeholders'], ['captable', 'Certificates'], ['grants', 'Equity grants'], ['convertibles', 'SAFEs & notes']];
const WHAT_TO_WRITE: Partial<Record<FieldSpec['type'], string>> = {
  date: 'A date, like 2024-01-15', number: 'A number of shares, like 4,200,000', money: 'Dollars, like 1,250,000',
  price: 'Dollars per share, like 0.0001', percent: 'A percentage, like 20%', boolean: 'Yes or No',
};

/**
 * One Excel workbook for everything: a tab per kind with its headers and no
 * rows, and a "How to fill this in" tab, which the import leaves out (it has
 * no ledger columns). Tabs left empty are left out too.
 */
route.get('/api/c/:cid/imports/template.xlsx', 'read', async (ctx) => {
  const guide: Cell[][] = [
    ['How to fill this in'],
    ['Fill in the tabs you need and leave the others empty, then import the whole workbook. One row per person, certificate, grant or SAFE.'],
    ['Tab', 'Column', 'Needed', 'What to write'],
  ];
  for (const [kind, tab] of TEMPLATE_TABS) {
    const headers = IMPORT_KINDS[kind].template[0];
    const mapping = suggestMapping(kind, headers);
    headers.forEach((header, column) => {
      const field = IMPORT_KINDS[kind].fields.find((f) => mapping[f.key] === column);
      guide.push([tab, header, field?.required ? 'Yes' : '', field?.hint ?? (field ? WHAT_TO_WRITE[field.type] ?? '' : '')]);
    });
  }
  const body = xlsx([{ name: 'How to fill this in', rows: guide }, ...TEMPLATE_TABS.map(([kind, tab]) => ({ name: tab, rows: [IMPORT_KINDS[kind].template[0]] }))]);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="import-template.xlsx"',
  });
  ctx.res.end(body);
  return undefined;
});

/** Which parser a file wants, from its bytes first and its name second. 'ole' is the pre-2007 Office format (.xls, .doc). */
export function detectFormat(body: Buffer, fileName: string): 'xlsx' | 'xml' | 'csv' | 'pdf' | 'ole' {
  if (body.length > 4 && body.readUInt32LE(0) === 0x04034b50) return 'xlsx';
  if (body.length > 8 && body.readUInt32BE(0) === 0xd0cf11e0 && body.readUInt32BE(4) === 0xa1b11ae1) return 'ole';
  if (body.subarray(0, 1024).toString('latin1').includes('%PDF-') || /\.pdf$/i.test(fileName)) return 'pdf';
  const head = body.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || /^<[A-Za-z_]/.test(head)) return 'xml';
  if (/\.xlsx$/i.test(fileName)) return 'xlsx';
  if (/\.xml$/i.test(fileName)) return 'xml';
  return 'csv';
}

const LEGACY_XLS = 'Legacy .xls workbooks are not supported — save the file as .xlsx, .xml or .csv and try again.';
const NOT_A_SPREADSHEET = 'This file isn\'t a spreadsheet. Save it from Excel as .xlsx or .csv and try again.';
const DAMAGED = 'We couldn\'t open this workbook — it may be damaged. Open it in Excel, save it again as .xlsx and drop it here.';
/** Rows a parser keeps of a sheet: the header is looked for among the first ten, then limits.importMaxRows below it. */
const HEADER_SCAN = 10;

interface UploadSheet { name: string; rows: Cell[][]; rowCount?: number; columnsCut?: boolean }

/** The sheets of an uploaded file, or the reason it cannot be read as a table. */
function readUpload(body: Buffer, fileName: string): { format: 'xlsx' | 'xml' | 'csv'; encoding: string | null; delimiter: string | null; mixedLines: number[]; sheets: UploadSheet[] } {
  const format = detectFormat(body, fileName);
  const keep = config().limits.importMaxRows + HEADER_SCAN;
  // A PDF is kept as a document and linked to an instrument; it is never read as a table.
  if (format === 'pdf') throw refuse('pdf', 'PDF files are stored as documents rather than read as tables. Save it as a document instead, linked to a stakeholder or instrument.');
  if (format === 'ole') {
    if (/\.docx?$/i.test(fileName)) throw refuse('word-document', `${fileName} is a Word document, not a spreadsheet. Save your table from Excel as .xlsx or .csv and drop it here.`);
    if (/\.pptx?$/i.test(fileName)) throw refuse('powerpoint', `${fileName} is a PowerPoint file, not a spreadsheet. Save your table from Excel as .xlsx or .csv and drop it here.`);
    throw refuse('legacy-xls', LEGACY_XLS);
  }
  if (/\.xls$/i.test(fileName) && format !== 'xlsx' && format !== 'xml') throw refuse('legacy-xls', LEGACY_XLS);

  if (format === 'xlsx') {
    // Parts are unpacked as they are read, within limits.importUnzippedMb for the whole file: a small
    // file that unpacks to gigabytes (a zip bomb) is refused rather than unpacked.
    const unzippedMb = config().limits.importUnzippedMb;
    const tooLarge = (): HttpError => badRequest(`This workbook unpacks to more than ${unzippedMb} MB, more than an import reads. Save the tabs you need as their own .xlsx or .csv file and drop those here.`,
      { code: 'unzips-too-large', limitMb: unzippedMb });
    let files: ZipFiles;
    try { files = openZip(body, megabytes(unzippedMb)); } catch { throw refuse('damaged', DAMAGED); }
    let contents: ReturnType<typeof zipContents>;
    try { contents = zipContents(files); } catch (err) { throw err instanceof ZipTooLarge ? tooLarge() : refuse('damaged', DAMAGED); }
    if (contents === 'docx') throw refuse('word-document', `${fileName} is a Word document, not a spreadsheet. Save your table from Excel as .xlsx or .csv and drop it here.`);
    if (contents === 'pptx') throw refuse('powerpoint', `${fileName} is a PowerPoint file, not a spreadsheet. Save your table from Excel as .xlsx or .csv and drop it here.`);
    if (contents === 'ods') throw refuse('opendocument', `${fileName} is an OpenDocument spreadsheet. Save it as .xlsx or .csv and drop it here.`);
    if (contents === 'numbers') throw refuse('numbers', `${fileName} is an Apple Numbers file. Export it as .xlsx or .csv and drop it here.`);
    if (contents !== 'xlsx') throw refuse('not-a-spreadsheet', NOT_A_SPREADSHEET);
    try {
      return { format, encoding: null, delimiter: null, mixedLines: [], sheets: parseWorkbook(files, { maxRows: keep }) };
    } catch (err) { throw err instanceof ZipTooLarge ? tooLarge() : refuse('damaged', DAMAGED); }
  }
  const { text, encoding, mixedLines = [] } = decodeText(body);
  if (looksBinary(text)) throw refuse('not-a-spreadsheet', NOT_A_SPREADSHEET);
  if (format === 'xml') {
    try {
      const sheets = parseXmlTable(text).map((sh) => {
        const rows = sh.rows.slice(0, keep);
        return { ...sh, rows, ...(sh.rows.length > rows.length ? { rowCount: sh.rows.length } : {}) };
      });
      return { format, encoding, delimiter: null, mixedLines, sheets };
    } catch (err) {
      // The XML reader's own messages say what is wrong with the file; anything else is the file breaking the reader.
      throw refuse('damaged', err instanceof RangeError || err instanceof TypeError ? DAMAGED : (err as Error).message);
    }
  }
  const delimiter = detectDelimiter(text.replace(/^\uFEFF/, ''));
  const table = parseCsvTable(text, keep);
  return { format, encoding, delimiter, mixedLines,
    sheets: [{ name: fileName.replace(/\.[^.]+$/, ''), rows: squareUp(table.rows), rowCount: table.rowCount, columnsCut: table.columnsCut }] };
}

/**
 * Parses one uploaded file into sheets of raw cells. Nothing is written; the
 * page detects and previews before anything touches the cap table. The file
 * may be up to limits.importUploadMb, and an .xlsx may unpack to
 * limits.importUnzippedMb. A CSV that is not UTF-8 is read as Windows-1252
 * (Excel's plain "CSV" on Windows), line by line when only some lines are;
 * images, archives, Word and PowerPoint files, PDFs and text with no columns
 * are refused with a code. Each sheet keeps the rows above its header and
 * limits.importMaxRows below it, and says how many it has (`rowCount`, which
 * preview and commit take back) and how it writes numbers (`numberFormat`).
 * The route reads and writes no company data, so it holds no lock.
 *
 * Response: { fileName, format, encoding, delimiter, sheets: [{ name, rows, rowCount, truncated, headerRow,
 *   numberFormat, numberDecidedBy, numberEvidence, numberMixed, notices }] }.
 * Refusals: 400 with detail.code empty | pdf | legacy-xls | word-document | powerpoint | opendocument | numbers |
 * not-a-spreadsheet | damaged | not-a-table | unzips-too-large (with limitMb); 413 too-large (with limitMb).
 */
route.post('/api/c/:cid/imports/parse', 'write', async (ctx) => {
  const body = ctx.rawBody;
  const fileName = str(ctx.query.get('name') ?? 'upload', 'File name', { max: 255 });
  if (!body || body.length === 0) throw refuse('empty', 'This file is empty.');
  const upload = readUpload(body, fileName);
  const sheets = upload.sheets.filter((s) => s.rows.length > 0);
  if (sheets.length === 0) throw refuse('empty', 'This file has no rows.');
  // A table has columns: text with one value per line is a list or prose, not something to import.
  if (!sheets.some((s) => s.rows.some((r) => r.filter((c) => c != null && String(c).trim() !== '').length >= 2))) {
    throw refuse('not-a-table', upload.format === 'xlsx'
      ? 'None of the tabs in this workbook has more than one column. Each tab needs a header row and a column for each field.'
      : 'This file has only one column, so it can\'t be read as a table. Save it from Excel as .xlsx or .csv, with a column for each field.');
  }
  const limit = config().limits.importMaxRows;
  const n = (x: number): string => x.toLocaleString(config().locale.locale);
  return {
    fileName, format: upload.format, encoding: upload.encoding, delimiter: upload.delimiter,
    sheets: sheets.map((s) => {
      const headerRow = guessHeaderRow(s.rows);
      const rows = s.rows.slice(0, headerRow + 1 + limit);
      const rowCount = s.rowCount ?? s.rows.length;
      const below = rowCount - headerRow - 1;
      const truncated = rowCount > rows.length;
      const numbers = detectNumberFormat(rows, upload.delimiter, 1);
      const notices: Notice[] = [];
      if (truncated) notices.push({ code: 'truncated', level: 'warning', text: `Only the first ${n(limit)} of ${n(below)} rows are included. Import the rest as a second file.` });
      if (s.columnsCut) notices.push({ code: 'too-wide', level: 'warning', text: `Only the first ${n(MAX_COLUMNS)} columns are read; the columns after them are left out.` });
      if (upload.mixedLines.length) {
        const lines = upload.mixedLines;
        notices.push({ code: 'mixed-encoding', level: 'info',
          text: `${lines.length === 1 ? `Line ${lines[0]} was` : `${n(lines.length)} lines (${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''}) were`} saved in another encoding (Windows-1252) and read that way — check the accents there` });
      }
      return {
        name: s.name, rows, rowCount, truncated, headerRow,
        numberFormat: numbers.format, numberDecidedBy: numbers.decidedBy, numberEvidence: numbers.evidence, numberMixed: numbers.mixed,
        notices,
      };
    }),
  };
}, { raw: true, unlocked: true, maxBytes: () => megabytes(config().limits.importUploadMb) });

/** A header row as sent: an array of cells, no wider than Excel allows. */
function readHeaders(v: unknown, where = ''): Cell[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > EXCEL_MAX_COLUMNS || !v.every(isCell)) throw badRequest(`The header row${where} must be a list of at most ${EXCEL_MAX_COLUMNS.toLocaleString('en-US')} cells.`, { code: 'bad-sheet' });
  return v as Cell[];
}
/** A cell as a page sends one: text of at most MAX_CELL_LENGTH characters, a finite number, true or false, or nothing. */
const isCell = (c: unknown): boolean => c == null || typeof c === 'boolean' || (typeof c === 'number' && Number.isFinite(c))
  || (typeof c === 'string' && c.length <= MAX_CELL_LENGTH);

/**
 * Column guesses for a header row, plus fixed values the sheet itself implies
 * (a share class named by the sheet). `score` counts required fields covered,
 * and `missing` names the required fields still without a column.
 */
route.post('/api/c/:cid/imports/suggest', 'read', async (ctx) => {
  const kind = ctx.body.kind;
  if (!isKind(kind)) throw badRequest('Unknown import kind.');
  return suggestForSheet(kind, typeof ctx.body.sheetName === 'string' ? ctx.body.sheetName : null, readHeaders(ctx.body.headers));
});

/**
 * Sorts sheets into the kinds they hold. Every sheet is considered: ledgers
 * come back with a kind and a column mapping, summary tabs with kind null and
 * the reason they are left out, and a ledger short of a required column with
 * its kind and the `missing` fields to ask for. `ready` is true when the sheet
 * can go to preview as it is. Answers come in the order of the request.
 *
 * Request: { preferredKind?, sheets: [{ name, file?, headers, rowCount }] }, at most
 * max(100, limits.importMaxSheets) sheets (more is 400 too-many-sheets).
 * Response: { sheets: [{ name, file, kind, mapping, constants, missing, ready, reason, score, requiredCount, mapped }] }.
 */
route.post('/api/c/:cid/imports/detect', 'read', async (ctx) => {
  if (!Array.isArray(ctx.body.sheets)) throw badRequest('No sheets to detect.', { code: 'no-sheets' });
  // Detection looks at more tabs than an import takes, since summary tabs are sorted out here.
  const most = Math.max(100, config().limits.importMaxSheets);
  if (ctx.body.sheets.length > most) throw badRequest(`Detection takes at most ${most} sheets at a time.`, { code: 'too-many-sheets' });
  const preferred = isKind(ctx.body.preferredKind) ? ctx.body.preferredKind : null;
  return {
    sheets: (ctx.body.sheets as unknown[]).map((sh, i) => {
      if (!sh || typeof sh !== 'object' || Array.isArray(sh)) throw badRequest(`Sheet ${i + 1} is not a sheet.`, { code: 'bad-sheet' });
      const { name: rawName, file, headers: rawHeaders, rowCount } = sh as { name?: unknown; file?: unknown; headers?: unknown; rowCount?: unknown };
      const name = String(rawName ?? '').slice(0, 255);
      const headers = readHeaders(rawHeaders, ` of sheet "${name}"`);
      const detection = detectSheet(name, headers, Number(rowCount ?? 0) || 0, preferred);
      return { name, file: typeof file === 'string' ? file : null, ...detection, ready: detection.kind != null && detection.missing.length === 0 };
    }),
  };
});

const DATE_ORDERS: DateOrder[] = ['auto', 'MDY', 'DMY'];
const optional = <T>(v: unknown, check: (v: unknown) => v is T, what: string): T | undefined => {
  if (v == null) return undefined;
  if (!check(v)) throw badRequest(`${what} is not valid.`, { code: 'bad-option' });
  return v;
};
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isDateOrder = (v: unknown): v is DateOrder => DATE_ORDERS.includes(v as DateOrder);
const isNumberFormat = (v: unknown): v is NumberFormat => NUMBER_FORMATS.includes(v as NumberFormat);
const isRowList = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 100_000 && v.every((n) => Number.isInteger(n) && n > 0);
const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 200 && v.every((s) => typeof s === 'string' && s.length <= 255);
const isRelationships = (v: unknown): v is Record<string, string> => typeof v === 'object' && !Array.isArray(v) && v !== null
  && Object.keys(v).length <= 100_000 && Object.entries(v).every(([k, r]) => k.length <= 320 && (RELATIONS as readonly string[]).includes(r as string));
const isToken = (v: unknown): v is string => typeof v === 'string' && v.length <= 100;

/** The options a request may carry, checked; anything else in them is ignored. */
function readOptions(raw: unknown): ImportOptions & { raiseAuthorized?: string[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const relationships = optional(o.relationships, isRelationships, 'options.relationships (each value one of the relationships in the schema)');
  return {
    dateOrder: optional(o.dateOrder, isDateOrder, 'options.dateOrder'),
    numberFormat: optional(o.numberFormat, isNumberFormat, 'options.numberFormat'),
    createMissingStakeholders: optional(o.createMissingStakeholders, isBoolean, 'options.createMissingStakeholders'),
    createMissingShareClasses: optional(o.createMissingShareClasses, isBoolean, 'options.createMissingShareClasses'),
    createMissingPools: optional(o.createMissingPools, isBoolean, 'options.createMissingPools'),
    defaultVestingScheduleId: optional(o.defaultVestingScheduleId, isString, 'options.defaultVestingScheduleId') || null,
    certificateVestingScheduleId: optional(o.certificateVestingScheduleId, isString, 'options.certificateVestingScheduleId') || null,
    defaultPoolId: optional(o.defaultPoolId, isString, 'options.defaultPoolId') || null,
    defaultPoolName: optional(o.defaultPoolName, isString, 'options.defaultPoolName')?.trim().slice(0, 120) || null,
    skipRowsWithErrors: optional(o.skipRowsWithErrors, isBoolean, 'options.skipRowsWithErrors'),
    excludeRows: optional(o.excludeRows, isRowList, 'options.excludeRows'),
    // Keyed by people's names, which may be anything ("constructor"): no prototype to find a key on.
    relationships: relationships && Object.assign(Object.create(null) as Record<string, string>,
      Object.fromEntries(Object.entries(relationships).map(([k, r]) => [k.toLowerCase().replace(/\s+/g, ' ').trim(), r]))),
    raiseAuthorized: optional(o.raiseAuthorized, isNameList, 'options.raiseAuthorized'),
    fileName: optional(o.fileName, isString, 'options.fileName')?.slice(0, 255) ?? null,
  };
}

/** Default schedules and plans must be the company's own: their ids are written onto the records. */
async function assertOwnDefaults(companyId: string, options: ImportOptions): Promise<void> {
  for (const [id, table, what] of [
    [options.defaultVestingScheduleId, 'vesting_schedules', 'default vesting schedule'],
    [options.certificateVestingScheduleId, 'vesting_schedules', 'vesting schedule for certificates'],
    [options.defaultPoolId, 'pools', 'default equity plan'],
  ] as const) {
    if (id && !(await one(`SELECT id FROM ${table} WHERE id = ? AND company_id = ?`, id, companyId))) throw badRequest(`The ${what} is not one of this company's.`, { code: 'bad-option' });
  }
}

/**
 * One sheet of a request, checked: its kind, a mapping of the kind's own fields
 * to column indexes or fixed values, rows as lists of cells no wider than
 * Excel allows, and every required field mapped. `rowCount` is parse's count
 * of the sheet's rows (header and above included), which says whether the
 * rows sent are all of them.
 */
function readRequest(body: Record<string, unknown>, where = '', options = readOptions(body.options)): ImportRequest {
  const kind = body.kind;
  if (!isKind(kind)) throw badRequest(`Unknown import kind${where}.`);
  if (!Array.isArray(body.rows)) throw badRequest(`No rows to import${where}.`);
  const rows = body.rows as unknown[];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length > EXCEL_MAX_COLUMNS || !row.every(isCell)) {
      throw badRequest(`Each row${where} must be a list of at most ${EXCEL_MAX_COLUMNS.toLocaleString('en-US')} cells, each text of at most ${MAX_CELL_LENGTH.toLocaleString('en-US')} characters, a number, true or false, or empty.`, { code: 'bad-sheet' });
    }
  }
  if (!body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping)) throw badRequest(`Map the columns first${where}.`);
  const fields = new Set(IMPORT_KINDS[kind].fields.map((f) => f.key));
  const mapping: Record<string, MappingValue> = {};
  for (const [k, v] of Object.entries(body.mapping as Record<string, unknown>)) {
    if (!fields.has(k)) continue;   // a field this kind does not have reads nothing
    if (v == null) mapping[k] = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < EXCEL_MAX_COLUMNS) mapping[k] = v;
    else if (typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') {
      const value = (v as { value: string }).value.trim();
      mapping[k] = value === '' ? null : { value: value.slice(0, 500) };
    } else throw badRequest(`Mapping for "${k}" must be a column index or a fixed value.`);
  }
  for (const f of IMPORT_KINDS[kind].fields) {
    if (f.required && mapping[f.key] == null) throw badRequest(`Map a column to "${f.label}"${where} — it is required.`, { code: 'missing-column', field: f.key });
  }
  const headerRowNumber = body.headerRowNumber == null ? 1 : Number(body.headerRowNumber);
  if (!Number.isInteger(headerRowNumber) || headerRowNumber < 1 || headerRowNumber > EXCEL_MAX_ROWS) throw badRequest(`headerRowNumber${where} must be a row number.`, { code: 'bad-sheet' });
  const rowCount = body.rowCount == null ? null : Number(body.rowCount);
  // A CSV may have more rows than Excel allows: only its first rows were kept, and rowCount says how many there were.
  if (rowCount != null && (!Number.isSafeInteger(rowCount) || rowCount < 0)) throw badRequest(`rowCount${where} must be parse's row count.`, { code: 'bad-sheet' });
  const { raiseAuthorized: _raise, ...rest } = options;
  void _raise;
  return {
    kind, headers: readHeaders(body.headers, where), rows: rows as Cell[][], mapping, headerRowNumber,
    options: { ...rest, fileRowCount: rowCount != null ? Math.max(0, rowCount - headerRowNumber) : null },
  };
}

/** One sheet on its own: the dry run of its rows. The workbook routes below are what a page uses. */
route.post('/api/c/:cid/imports/preview', 'write', async (ctx) => {
  const req = readRequest(ctx.body);
  await assertOwnDefaults(ctx.companyId!, req.options!);
  const { plan: _plan, refs: _refs, ...preview } = await prepareImport(ctx.companyId!, req);
  void _plan; void _refs;
  return preview;
});

route.post('/api/c/:cid/imports/commit', 'write', async (ctx) => {
  const req = readRequest(ctx.body);
  await assertOwnDefaults(ctx.companyId!, req.options!);
  let result;
  try {
    result = await commitImport(ctx.companyId!, req, ctx.user!.name);
  } catch (err) {
    if (err instanceof RowsNeedFixing) throw badRequest(err.message, { code: 'rows-need-fixing' });
    throw err;
  }
  invalidate(ctx.companyId!);
  const i = result.imported;
  await audit(ctx, 'IMPORT', 'imports', result.importId,
    `Imported ${IMPORT_KINDS[req.kind].label.toLowerCase()}${req.options?.fileName ? ` from ${req.options.fileName}` : ''}: ` +
    [i.stakeholders && `${i.stakeholders} stakeholders`, i.shareClasses && `${i.shareClasses} share classes`,
     i.pools && `${i.pools} equity plans`, i.issuances && `${i.issuances} certificates`, i.awards && `${i.awards} grants`,
     i.convertibles && `${i.convertibles} convertibles`, i.updated.stakeholders && `${i.updated.stakeholders} stakeholders updated`].filter(Boolean).join(', '));
  return result;
});

const COUNT_KEYS: (keyof ImportCounts)[] = ['total', 'ok', 'warnings', 'errors', 'skipped', 'willImport', 'existing', 'excluded'];

/**
 * The sheets of one file or several, each with its kind and mapping, sharing
 * the options. A sheet names its file (`file`, else the body's `fileName`) and
 * may carry its own `numberFormat`, `dateOrder`, `excludeRows` and `rowCount`.
 * Rows left out are per sheet: `options.excludeRows` is refused here, since a
 * row number means nothing without its sheet.
 */
function readWorkbook(body: Record<string, unknown>): { sheets: WorkbookSheet[]; files: string[]; extras: WorkbookExtras; options: ImportOptions } {
  if (!Array.isArray(body.sheets) || body.sheets.length === 0) throw badRequest('Choose at least one sheet to import.', { code: 'no-sheets' });
  const { importMaxSheets: maxSheets, importMaxTotalRows: maxTotal } = config().limits;
  if (body.sheets.length > maxSheets) throw badRequest(`An import takes at most ${maxSheets} sheet${maxSheets === 1 ? '' : 's'}.`, { code: 'too-many-sheets' });
  const fileName = body.fileName ? str(body.fileName, 'File name', { max: 255 }) : null;
  const raw = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
  if (raw.excludeRows != null) throw badRequest('options.excludeRows is per sheet in a workbook: send each sheet\'s rows as sheets[].excludeRows.', { code: 'bad-option' });
  const { raiseAuthorized, excludeRows: _excludeRows, ...shared } = readOptions(body.options);
  void _excludeRows;
  const sheets = (body.sheets as unknown[]).map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest(`Sheet ${i + 1} is not a sheet.`, { code: 'bad-sheet' });
    const sh = entry as Record<string, unknown>;
    const sheetName = str(sh.name ?? sh.sheetName ?? 'Sheet', 'Sheet name', { max: 120 });
    const file = sh.file != null ? str(sh.file, 'File name', { max: 255 }) : fileName;
    const own = readOptions({ numberFormat: sh.numberFormat, dateOrder: sh.dateOrder, excludeRows: sh.excludeRows });
    const options: ImportOptions = {
      ...shared, numberFormat: own.numberFormat ?? shared.numberFormat, dateOrder: own.dateOrder ?? shared.dateOrder, excludeRows: own.excludeRows,
      fileName: file && sheetName ? `${file} › ${sheetName}` : file,
    };
    const where = ` on sheet "${sheetName}"${file && fileName !== file ? ` of ${file}` : ''}`;
    return { ...readRequest(sh, where, options), sheetName, file };
  });
  // Every row is checked and, on commit, written in one transaction holding the company's lock: the whole import is bounded too.
  const total = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (total > maxTotal) throw badRequest(`An import takes at most ${maxTotal.toLocaleString('en-US')} rows across its sheets; this one has ${total.toLocaleString('en-US')}. Import the files in turn.`, { code: 'too-many-rows' });
  let expectedCounts: Partial<ImportCounts> | undefined;
  if (body.expectedCounts != null) {
    const given = body.expectedCounts as Record<string, unknown>;
    if (typeof given !== 'object' || !COUNT_KEYS.every((k) => typeof given[k] === 'number')) {
      throw badRequest('expectedCounts must be the counts of the preview, all of them.', { code: 'bad-option' });
    }
    expectedCounts = Object.fromEntries(COUNT_KEYS.map((k) => [k, given[k] as number]));
  }
  const reviewToken = optional(body.reviewToken, isToken, 'reviewToken');
  return { sheets, files: [...new Set(sheets.map((s) => s.file).filter((f): f is string => !!f))], extras: { raiseAuthorized, expectedCounts, reviewToken }, options: shared };
}

/**
 * The dry run of everything the page would import: every sheet of every file,
 * in dependency order, inside a transaction that is rolled back. Its response
 * is the review: rows, counts, new people, how each file was read, what the
 * cap table would warn about afterwards, and the reviewToken that names it.
 * Bodies may be up to limits.importJsonMb, with at most limits.importMaxSheets
 * sheets and limits.importMaxTotalRows rows in all.
 *
 * Request: { sheets: [{ file?, name, kind, headers, rows, headerRowNumber, mapping, rowCount?, numberFormat?, dateOrder?, excludeRows? }],
 *   options?, fileName? }. Response: WorkbookResult (engine.ts), shapes in docs/importing.md.
 * 400 codes: no-sheets, too-many-sheets, too-many-rows, bad-sheet, missing-column, bad-option, body-too-large.
 */
route.post('/api/c/:cid/imports/workbook/preview', 'write', async (ctx) => {
  const { sheets, extras, options } = readWorkbook(ctx.body);
  await assertOwnDefaults(ctx.companyId!, options);
  return runWorkbook(ctx.companyId!, sheets, ctx.user!.name, true, { raiseAuthorized: extras.raiseAuthorized });
}, { maxBytes: () => megabytes(config().limits.importJsonMb) });

/**
 * The same run, kept: all files or nothing. Send the preview's body again with
 * its `reviewToken`. When the body differs from the one that was checked (a
 * row edited or left out, an option changed), nothing is written and the
 * answer is 409 "not-reviewed"; when the run here comes out differently (the
 * cap table changed since the review), 409 "stale-review" with the new counts.
 * An older page may send `expectedCounts` (all eight counts) instead, which
 * checks the counts only; with neither, nothing is checked.
 *
 * 409 codes: not-reviewed, stale-review. 400 codes: rows-need-fixing and those of preview.
 * An error the import did not expect is a 500, and nothing is written.
 */
route.post('/api/c/:cid/imports/workbook/commit', 'write', async (ctx) => {
  const { sheets, files, extras, options } = readWorkbook(ctx.body);
  await assertOwnDefaults(ctx.companyId!, options);
  let result: WorkbookResult;
  try {
    result = await runWorkbook(ctx.companyId!, sheets, ctx.user!.name, false, extras);
  } catch (err) {
    if (err instanceof NotReviewed) throw new HttpError(409, err.message, { code: 'not-reviewed' });
    if (err instanceof StaleReview) throw new HttpError(409, err.message, { code: 'stale-review', counts: err.counts });
    if (err instanceof RowsNeedFixing) throw badRequest(err.message, { code: 'rows-need-fixing' });
    throw err;
  }
  invalidate(ctx.companyId!);
  const i = result.imported;
  const from = files.length ? ` from ${files.length > 2 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)}` : files.join(' and ')}` : '';
  await audit(ctx, 'IMPORT', 'imports', result.importIds[0] ?? null,
    `Imported ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}${from}: ` +
    [i.stakeholders && `${i.stakeholders} stakeholders`, i.shareClasses && `${i.shareClasses} share classes`,
     i.pools && `${i.pools} equity plans`, i.issuances && `${i.issuances} certificates`, i.awards && `${i.awards} grants`,
     i.convertibles && `${i.convertibles} convertibles`, i.updated.stakeholders && `${i.updated.stakeholders} stakeholders updated`,
     ...result.raised.map((r) => `${r.name} authorized shares raised from ${r.from.toLocaleString('en-US')} to ${r.to.toLocaleString('en-US')}`)].filter(Boolean).join(', '));
  return result;
}, { maxBytes: () => megabytes(config().limits.importJsonMb) });

route.get('/api/c/:cid/imports', 'read', async (ctx) =>
  toCamelAll<Record<string, unknown>>(await all('SELECT * FROM imports WHERE company_id = ? ORDER BY created_at DESC LIMIT 50', ctx.companyId))
    .map((r) => ({ ...r, summary: r.summary ? JSON.parse(String(r.summary)) : null })));
