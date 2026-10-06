/**
 * A minimal .xlsx reader: enough of the ZIP container and SpreadsheetML to
 * pull every sheet out as a grid of values, with shared strings resolved,
 * inline strings and booleans handled, and date-formatted numbers converted
 * from Excel serials to ISO dates via the workbook's cell styles.
 *
 * Not supported, by design: ZIP64 archives (>4GB), encrypted workbooks,
 * formulas (their cached values are used), and the legacy binary .xls format.
 */
import { inflateRawSync } from 'node:zlib';

export type XlsxCell = string | number | boolean | null;
export interface XlsxSheet { name: string; rows: XlsxCell[][] }

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Extracts every entry of a ZIP archive into memory. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file (no ZIP directory found).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('The .xlsx file is corrupt (bad central directory).');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error('The .xlsx file is corrupt (bad local header).');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`The .xlsx file uses an unsupported compression method (${method}).`);

    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

/** All <t> runs inside a fragment, concatenated — rich text is split into runs. */
function textRuns(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
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
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') ?? '';
    custom.set(id, code);
  }
  const isDateCode = (code: string): boolean => {
    const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dy]/i.test(stripped) && !/^general$/i.test(code);
  };
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let index = 0;
  for (const m of cellXfs.matchAll(/<xf\b[^>]*\/?>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id)!))) result.add(index);
    index++;
  }
  return result;
}

export function parseXlsx(buf: Buffer): XlsxSheet[] {
  const files = readZip(buf);
  const read = (name: string): string | undefined => files.get(name)?.toString('utf8');

  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('This is not a valid .xlsx workbook.');
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const shared: string[] = [];
  const sst = read('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));
  const dates = dateStyles(read('xl/styles.xml'));

  const sheets: XlsxSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet ${sheets.length + 1}`;
    const rId = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    const path = (rId && targets.get(rId)) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = read(path);
    if (!xml) continue;
    sheets.push({ name, rows: parseSheet(xml, shared, dates) });
  }
  return sheets;
}

function parseSheet(xml: string, shared: string[], dateStyleIds: Set<number>): XlsxCell[][] {
  const grid: XlsxCell[][] = [];
  let width = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number(attr(rowMatch[1], 'r') ?? grid.length + 1) - 1;
    const cells: XlsxCell[] = [];
    let cursor = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cellMatch[1];
      const inner = cellMatch[2] ?? '';
      const ref = attr(tag, 'r');
      const col = ref ? columnIndex(ref.replace(/\d+/g, '')) : cursor;
      const type = attr(tag, 't');
      const style = Number(attr(tag, 's') ?? '-1');
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];

      let value: XlsxCell = null;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textRuns(inner);
      else if (type === 'str') value = decodeXml(v ?? '');
      else if (type === 'b') value = v === '1';
      else if (type === 'd') value = (v ?? '').slice(0, 10);
      else if (v != null && v !== '') {
        const n = Number(v);
        value = Number.isFinite(n) ? (dateStyleIds.has(style) ? excelSerialToISO(n) ?? n : n) : decodeXml(v);
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value;
      cursor = col + 1;
    }
    while (grid.length < rowIndex) grid.push([]);
    grid[rowIndex] = cells;
    width = Math.max(width, cells.length);
  }
  return grid
    .map((r) => { const row = r.slice(); while (row.length < width) row.push(null); return row; })
    .filter((r) => r.some((c) => c !== null && c !== ''));
}
