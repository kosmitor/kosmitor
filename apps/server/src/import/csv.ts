import { MAX_COLUMNS, MAX_CELL_LENGTH } from './xlsx.ts';

/**
 * RFC 4180 CSV parsing: quoted fields, doubled quotes, newlines inside quotes,
 * CRLF and bare CR line endings, a UTF-8 BOM, and delimiter detection between
 * comma, semicolon and tab (European exports often use semicolons).
 */
export function parseCsv(input: string): string[][] {
  return parseCsvTable(input).rows;
}

/**
 * parseCsv with bounds, for files a person uploads: a field is cut at
 * MAX_CELL_LENGTH characters (Excel does the same when it opens a CSV), fields
 * past MAX_COLUMNS are not kept (`columnsCut`), and with `maxRows` only that
 * many rows with a value are kept while all of them are counted (`rowCount`).
 */
export function parseCsvTable(input: string, maxRows = Infinity): { rows: string[][]; rowCount: number; columnsCut: boolean } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let rowCount = 0;
  let columnsCut = false;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let width = 0;   // fields seen in this row, kept or not

  const endField = (): void => {
    if (width < MAX_COLUMNS) row.push(field.length > MAX_CELL_LENGTH ? field.slice(0, MAX_CELL_LENGTH) : field);
    else if (field.trim() !== '') columnsCut = true;
    width++;
    field = '';
  };
  const endRow = (): void => {
    endField();
    const cells = row.map((c) => c.trim());
    if (cells.some((c) => c !== '')) {
      rowCount++;
      if (rows.length < maxRows) rows.push(cells);
    }
    row = [];
    width = 0;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else if (field.length <= MAX_CELL_LENGTH) {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') continue;          // CRLF: the LF ends the row
      endRow();   // bare CR
      continue;
    }
    if (ch === '\n') { endRow(); continue; }
    if (field.length <= MAX_CELL_LENGTH) field += ch;
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, rowCount, columnsCut };
}

/** The text encodings an uploaded table is read in. */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/**
 * Bytes to text. UTF-16 is known by its byte order mark (Excel's "Unicode
 * text"); anything else is read as UTF-8, and when that fails — Excel's plain
 * "CSV" save on Windows writes Windows-1252, where "Tom’s" and "Catégorie" are
 * single bytes that are not UTF-8 — as Windows-1252 instead, so accented
 * names come through rather than as replacement characters. A file pasted
 * together from both is read line by line: each line that is UTF-8 as UTF-8,
 * the others as Windows-1252, and `mixedLines` numbers the others (1-based).
 */
export function decodeText(body: Buffer): { text: string; encoding: TextEncoding; mixedLines?: number[] } {
  if (body[0] === 0xff && body[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(body.subarray(2)), encoding: 'utf-16le' };
  if (body[0] === 0xfe && body[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(body.subarray(2)), encoding: 'utf-16be' };
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return { text: utf8.decode(body), encoding: 'utf-8' };
  } catch {
    // Line by line: a line feed is the same byte in both encodings.
    const latin = new TextDecoder('windows-1252');
    const parts: string[] = [];
    const fallback: number[] = [];
    let wide = false;   // a line that only UTF-8 reads: something beyond ASCII decoded as UTF-8
    let start = 0;
    for (let line = 1; start <= body.length; line++) {
      const lf = body.indexOf(0x0a, start);
      const end = lf < 0 ? body.length : lf + 1;
      const bytes = body.subarray(start, end);
      try {
        const text = utf8.decode(bytes);
        wide ||= bytes.some((b) => b >= 0x80);
        parts.push(text);
      } catch {
        parts.push(latin.decode(bytes));
        fallback.push(line);
      }
      if (lf < 0) break;
      start = end;
    }
    if (!wide) return { text: latin.decode(body), encoding: 'windows-1252' };
    return { text: parts.join(''), encoding: 'utf-8', mixedLines: fallback };
  }
}

/**
 * True when text is not a table: it holds NUL characters, or more than one
 * character in twenty is a control character other than tab, line feed,
 * carriage return and form feed (or a replacement character) — an image, an
 * archive or a program read as text. Only the start is looked at.
 */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 65_536);
  if (sample.length === 0) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13) || (c >= 127 && c < 160) || c === 0xfffd) control++;
  }
  return control / sample.length > 0.05;
}

export function detectDelimiter(text: string): string {
  // The header line decides; its first 64 KB are plenty, however long the line runs.
  const end = text.search(/\r|\n/);
  const firstLine = text.slice(0, Math.min(end < 0 ? text.length : end, 65_536));
  const outsideQuotes = firstLine.replace(/"[^"]*"/g, '');
  const counts: [string, number][] = [
    [',', outsideQuotes.split(',').length - 1],
    [';', outsideQuotes.split(';').length - 1],
    ['\t', outsideQuotes.split('\t').length - 1],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/**
 * A cell a spreadsheet would run as a formula when the file is opened: text
 * starting with =, +, -, @, a tab or a carriage return that is not just a
 * number ("-1,250", "+5%"). Names and addresses come from imports and forms.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const SIGNED_NUMBER = /^[-+]?[$€£¥]?\d[\d.,]*%?$/;

/** Serialises rows back to CSV, quoting whatever needs it, with text that would run as a formula kept as text ('=…). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map((cell) => {
    let s = cell == null ? '' : String(cell);
    if (typeof cell === 'string' && FORMULA_START.test(s) && !SIGNED_NUMBER.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}
