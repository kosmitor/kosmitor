/**
 * A minimal .xlsx reader: enough of the ZIP container and SpreadsheetML to
 * pull every sheet out as a grid of values, with shared strings resolved,
 * inline strings and booleans handled, and date-formatted numbers converted
 * from Excel serials to ISO dates via the workbook's cell styles.
 *
 * Uploads are untrusted, so the reader is bounded: a ZIP entry is unpacked only
 * when it is read, and never past what the archive may unpack to (a small file
 * that unpacks to gigabytes is a zip bomb); a cell or row outside what Excel
 * allows is refused rather than padded out to; empty rows take no room and
 * trailing empty columns are dropped; columns past MAX_COLUMNS are not read;
 * and every scan moves forward through the text, so a tag left open costs one
 * pass, not one per tag.
 *
 * Not supported, by design: ZIP64 archives (>4GB), encrypted workbooks,
 * formulas (their cached values are used), and the legacy binary .xls format.
 */
import { inflateRawSync } from 'node:zlib';

export type XlsxCell = string | number | boolean | null;
export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
  /** Rows with a value in the sheet, given only when more were there than were kept (`maxRows`). */
  rowCount?: number;
  /** True when cells past MAX_COLUMNS held values, which were not read. */
  columnsCut?: boolean;
}

/** Excel's own limits: a cell past them is not from a real workbook. */
export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLUMNS = 16_384;
/** The columns a sheet is read to. No ledger is wider; a stray cell far to the right would otherwise widen every row. */
export const MAX_COLUMNS = 1_000;
/** The longest text a cell holds, as in Excel. */
export const MAX_CELL_LENGTH = 32_767;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** An archive that unpacks to more than it may. */
export class ZipTooLarge extends Error {}

/** The entries of a ZIP archive by name, each unpacked when it is first read. Map's own has/get/keys, so a Map stands in for one. */
export interface ZipFiles {
  has(name: string): boolean;
  get(name: string): Buffer | undefined;
  keys(): IterableIterator<string>;
}

interface Entry { method: number; compressedSize: number; size: number; localOffset: number }

/**
 * Opens a ZIP archive without unpacking anything: entries are inflated when
 * read, and all of them together may unpack to at most `maxBytes`. An entry
 * whose declared size is over what is left is refused before it is inflated,
 * and inflating stops at what is left whatever the entry declares.
 */
export function openZip(buf: Buffer, maxBytes = 1024 * 1024 * 1024): ZipFiles {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file (no ZIP directory found).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Entry>();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('The .xlsx file is corrupt (bad central directory).');
    const nameLength = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    entries.set(name, { method: buf.readUInt16LE(p + 10), compressedSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), localOffset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }

  let left = maxBytes;
  const read = new Map<string, Buffer>();
  const unpack = (name: string, e: Entry): Buffer => {
    if (buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) throw new Error('The .xlsx file is corrupt (bad local header).');
    const dataStart = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + e.compressedSize);
    if (e.size > left) throw new ZipTooLarge(`${name} unpacks to more than the import reads.`);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(data);
    else if (e.method === 8) {
      try {
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, left) });
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipTooLarge(`${name} unpacks to more than the import reads.`);
        throw err;
      }
    } else throw new Error(`The .xlsx file uses an unsupported compression method (${e.method}).`);
    if (out.length > left) throw new ZipTooLarge(`${name} unpacks to more than the import reads.`);
    left -= out.length;
    return out;
  };
  return {
    has: (name) => entries.has(name),
    keys: () => entries.keys(),
    get: (name) => {
      const done = read.get(name);
      if (done) return done;
      const e = entries.get(name);
      if (!e) return undefined;
      const out = unpack(name, e);
      read.set(name, out);
      return out;
    },
  };
}

/** Extracts every entry of a ZIP archive into memory, within `maxBytes` unpacked. */
export function readZip(buf: Buffer, maxBytes?: number): Map<string, Buffer> {
  const zip = openZip(buf, maxBytes);
  return new Map([...zip.keys()].map((name) => [name, zip.get(name)!]));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

const NAME_END = new Set([0x20, 0x09, 0x0a, 0x0d, 0x2f, 0x3e]);   // space, tab, LF, CR, '/', '>'

/**
 * The `<tag …>` elements of `xml` between `from` and `to`, in order: their
 * attributes and what they hold (null for `<tag/>`). Every search moves
 * forward, so the whole text is read once; a tag left open is an error.
 */
function* elements(xml: string, tag: string, from = 0, to = xml.length): Generator<{ attrs: string; inner: string | null }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = xml.indexOf(open, from);
  while (i >= 0 && i < to) {
    if (!NAME_END.has(xml.charCodeAt(i + open.length))) { i = xml.indexOf(open, i + open.length); continue; }   // <rowBreaks>, not <row>
    const gt = xml.indexOf('>', i + open.length);
    if (gt < 0 || gt >= to) throw new Error(`A <${tag}> tag is left open.`);
    if (xml.charCodeAt(gt - 1) === 0x2f) {
      yield { attrs: xml.slice(i + open.length, gt - 1), inner: null };
      i = xml.indexOf(open, gt + 1);
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0 || end >= to) throw new Error(`A <${tag}> element is not closed.`);
    yield { attrs: xml.slice(i + open.length, gt), inner: xml.slice(gt + 1, end) };
    i = xml.indexOf(open, end + close.length);
  }
}

/** The attributes of every `<tag …>` start tag, closed or not, in order. */
function* startTags(xml: string, tag: string, from = 0, to = xml.length): Generator<string> {
  const open = `<${tag}`;
  let i = xml.indexOf(open, from);
  while (i >= 0 && i < to) {
    if (!NAME_END.has(xml.charCodeAt(i + open.length))) { i = xml.indexOf(open, i + open.length); continue; }
    const gt = xml.indexOf('>', i + open.length);
    if (gt < 0 || gt >= to) throw new Error(`A <${tag}> tag is left open.`);
    yield xml.slice(i + open.length, gt);
    i = xml.indexOf(open, gt + 1);
  }
}

/** The text of a `<tag>…</tag>` element inside a fragment, or undefined. */
function inside(fragment: string, tag: string): string | undefined {
  for (const e of elements(fragment, tag)) return e.inner ?? '';
  return undefined;
}

/** All <t> runs inside a fragment, concatenated — rich text is split into runs. */
function textRuns(fragment: string): string {
  let out = '';
  for (const t of elements(fragment, 't')) if (t.inner) out += decodeXml(t.inner);
  return out.length > MAX_CELL_LENGTH ? out.slice(0, MAX_CELL_LENGTH) : out;
}

/** Column letters to a zero-based index: A=0, Z=25, AA=26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel's 1900 date system; serial 25569 is 1970-01-01, which absorbs the Lotus leap-year bug. */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  return new Date(Math.round((serial - 25_569) * 86_400_000)).toISOString().slice(0, 10);
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Which cell style indices render as dates, from styles.xml. */
function dateStyles(stylesXml: string | undefined): Set<number> {
  const result = new Set<number>();
  if (!stylesXml) return result;
  const custom = new Map<number, string>();
  for (const tag of startTags(stylesXml, 'numFmt')) {
    const id = Number(attr(tag, 'numFmtId'));
    const code = attr(tag, 'formatCode') ?? '';
    custom.set(id, code);
  }
  const isDateCode = (code: string): boolean => {
    const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dy]/i.test(stripped) && !/^general$/i.test(code);
  };
  const cellXfs = inside(stylesXml, 'cellXfs') ?? '';
  let index = 0;
  for (const tag of startTags(cellXfs, 'xf')) {
    const id = Number(attr(tag, 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id)!))) result.add(index);
    index++;
  }
  return result;
}

/**
 * What a ZIP archive holds, from its entries: an Excel workbook, or one of the
 * other files that are ZIPs inside — a Word document, a PowerPoint deck, an
 * OpenDocument spreadsheet, an Apple Numbers file — or something else.
 */
export function zipContents(files: ZipFiles): 'xlsx' | 'docx' | 'pptx' | 'ods' | 'numbers' | 'zip' {
  if (files.has('xl/workbook.xml')) return 'xlsx';
  if (files.has('word/document.xml')) return 'docx';
  if (files.has('ppt/presentation.xml')) return 'pptx';
  const mimetype = files.has('mimetype') ? files.get('mimetype')!.subarray(0, 200).toString('utf8') : '';
  if (/opendocument\.spreadsheet/.test(mimetype)) return 'ods';
  if ([...files.keys()].some((name) => name.startsWith('Index/') && name.endsWith('.iwa'))) return 'numbers';
  return 'zip';
}

export function parseXlsx(buf: Buffer): XlsxSheet[] {
  return parseWorkbook(openZip(buf));
}

/**
 * Every sheet of a workbook whose ZIP is open. Only the parts a table needs are
 * unpacked: the workbook, its relationships, shared strings, styles and the
 * sheets themselves. With `maxRows`, each sheet keeps that many rows with a
 * value and counts the rest (`rowCount`).
 */
export function parseWorkbook(files: ZipFiles, options: { maxRows?: number } = {}): XlsxSheet[] {
  const read = (name: string): string | undefined => files.get(name)?.toString('utf8');

  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('This is not a valid .xlsx workbook.');
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map<string, string>();
  for (const tag of startTags(rels, 'Relationship')) {
    const id = attr(tag, 'Id'), target = attr(tag, 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const shared: string[] = [];
  const sst = read('xl/sharedStrings.xml');
  if (sst) for (const si of elements(sst, 'si')) shared.push(si.inner ? textRuns(si.inner) : '');
  const dates = dateStyles(read('xl/styles.xml'));

  const sheets: XlsxSheet[] = [];
  for (const tag of startTags(workbook, 'sheet')) {
    const name = attr(tag, 'name') ?? `Sheet ${sheets.length + 1}`;
    const rId = attr(tag, 'r:id') ?? attr(tag, 'id');
    const path = (rId && targets.get(rId)) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = read(path);
    if (!xml) continue;
    sheets.push({ name, ...parseSheet(xml, shared, dates, options.maxRows ?? Infinity) });
  }
  return sheets;
}

const blank = (c: XlsxCell): boolean => c === null || c === '';

/**
 * Rows with a value, as a grid as wide as the widest of them: trailing columns
 * that are empty in every row are dropped, and so are empty rows.
 */
export function squareUp(rows: XlsxCell[][]): XlsxCell[][] {
  let width = 0;
  for (const r of rows) {
    let last = r.length - 1;
    while (last >= 0 && blank(r[last])) last--;
    width = Math.max(width, last + 1);
  }
  return rows.map((r) => {
    const row = r.length > width ? r.slice(0, width) : r.slice();
    while (row.length < width) row.push(null);
    return row;
  });
}

function parseSheet(xml: string, shared: string[], dateStyleIds: Set<number>, maxRows: number): Omit<XlsxSheet, 'name'> {
  const kept: { index: number; cells: XlsxCell[] }[] = [];
  let rowCount = 0;
  let columnsCut = false;
  let nextRow = 0;
  for (const rowEl of elements(xml, 'row')) {
    const r = attr(rowEl.attrs, 'r');
    const rowIndex = r != null ? Number(r) - 1 : nextRow;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= EXCEL_MAX_ROWS) throw new Error('A row lies outside what Excel allows.');
    nextRow = rowIndex + 1;
    if (!rowEl.inner) continue;
    const cells: XlsxCell[] = [];
    let cursor = 0;
    let filled = false;
    for (const cellEl of elements(rowEl.inner, 'c')) {
      const tag = cellEl.attrs;
      const inner = cellEl.inner ?? '';
      const ref = attr(tag, 'r');
      const letters = ref?.replace(/\d+$/, '');
      if (letters != null && !/^[A-Z]{1,3}$/.test(letters)) throw new Error('A cell lies outside what Excel allows.');
      const col = letters != null ? columnIndex(letters) : cursor;
      if (col >= EXCEL_MAX_COLUMNS) throw new Error('A cell lies outside what Excel allows.');
      cursor = col + 1;
      const type = attr(tag, 't');
      const style = Number(attr(tag, 's') ?? '-1');
      const v = inside(inner, 'v');

      let value: XlsxCell = null;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textRuns(inner);
      else if (type === 'str') value = decodeXml(v ?? '').slice(0, MAX_CELL_LENGTH);
      else if (type === 'b') value = v === '1';
      else if (type === 'd') value = (v ?? '').slice(0, 10);
      else if (v != null && v !== '') {
        const n = Number(v);
        value = Number.isFinite(n) ? (dateStyleIds.has(style) ? excelSerialToISO(n) ?? n : n) : decodeXml(v).slice(0, MAX_CELL_LENGTH);
      }
      if (value === null) continue;
      if (col >= MAX_COLUMNS) { columnsCut ||= value !== ''; continue; }
      while (cells.length < col) cells.push(null);
      cells[col] = value;
      filled ||= value !== '';
    }
    if (!filled) continue;
    rowCount++;
    if (kept.length < maxRows) kept.push({ index: rowIndex, cells });
  }
  kept.sort((a, b) => a.index - b.index);
  const sheet: Omit<XlsxSheet, 'name'> = { rows: squareUp(kept.map((k) => k.cells)) };
  if (rowCount > kept.length) sheet.rowCount = rowCount;
  if (columnsCut) sheet.columnsCut = true;
  return sheet;
}
