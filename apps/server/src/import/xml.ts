/**
 * XML imports, two flavours:
 *
 *  - Excel "XML Spreadsheet 2003" (`<Workbook xmlns="urn:schemas-microsoft-com:
 *    office:spreadsheet">`), which many tools still write when asked to save
 *    as XML — read as sheets of cells, honouring sparse `ss:Index` positions
 *    and the declared cell types.
 *  - Any generic record export: a root holding repeated elements, one per
 *    record, whose attributes and child elements are the fields. Headers are
 *    the union of field names in the order they first appear. Positional
 *    exports (`<row><cell>…</cell></row>`) come through as plain rows.
 *
 * The parser is a small, forgiving recursive tokenizer: comments, processing
 * instructions, CDATA, a DOCTYPE and the five predefined entities are handled;
 * namespace prefixes are dropped so `ss:Index` and `Index` are the same thing.
 */
import { decodeXml, squareUp, EXCEL_MAX_ROWS, EXCEL_MAX_COLUMNS, MAX_COLUMNS, MAX_CELL_LENGTH } from './xlsx.ts';
import type { Cell } from './values.ts';

/** How deep elements may nest: a table needs a handful of levels, and the readers below recurse through them. */
const MAX_DEPTH = 64;

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const local = (qualified: string): string => qualified.slice(qualified.lastIndexOf(':') + 1);

export function parseXml(input: string): XmlNode {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  const appendText = (t: string): void => {
    if (t.trim() === '') return;
    stack[stack.length - 1].text += decodeXml(t);
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { appendText(text.slice(i)); break; }
    appendText(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('Unterminated comment in the XML.');
      i = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('Unterminated CDATA section in the XML.');
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3; continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      if (end < 0) throw new Error('Unterminated declaration in the XML.');
      i = end + 1; continue;
    }

    const end = findTagEnd(text, lt);
    if (end < 0) throw new Error('Unterminated tag in the XML.');
    const raw = text.slice(lt + 1, end);
    i = end + 1;

    if (raw.startsWith('/')) {
      const name = local(raw.slice(1).trim());
      if (stack.length < 2 || stack[stack.length - 1].name !== name) {
        throw new Error(`Mismatched closing tag </${name}> in the XML.`);
      }
      stack.pop();
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error('Malformed tag in the XML.');
    const node: XmlNode = { name: local(nameMatch[1]), attrs: Object.create(null) as Record<string, string>, children: [], text: '' };
    // A name is at most 256 characters, so a long run with no "=" costs a bounded retry at each position, not a scan to its end from each.
    for (const m of body.slice(nameMatch[0].length).matchAll(/([^\s=/]{1,256})\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      node.attrs[local(m[1])] = decodeXml(m[2] ?? m[3] ?? '');
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new Error('The XML is nested too deeply to be a table.');
      stack.push(node);
    }
  }

  if (stack.length !== 1) throw new Error(`The XML ends before <${stack[stack.length - 1].name}> is closed.`);
  const elements = root.children;
  if (elements.length === 0) throw new Error('The file contains no XML elements.');
  return elements[0];
}

/** Index of the `>` that ends the tag starting at `start`, skipping quoted attribute values. */
function findTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let j = start + 1; j < text.length; j++) {
    const ch = text[j];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return j;
  }
  return -1;
}

/** Text as a cell holds it: at most MAX_CELL_LENGTH characters, as in Excel. */
const cellText = (s: string): string => (s.length > MAX_CELL_LENGTH ? s.slice(0, MAX_CELL_LENGTH) : s);

/** All text beneath a node, in document order. */
function deepText(node: XmlNode): string {
  let out = node.text;
  for (const c of node.children) out += deepText(c);
  return out.trim();
}

export interface XmlSheet {
  name: string;
  rows: Cell[][];
  /** True when values lay past MAX_COLUMNS and were not read. */
  columnsCut?: boolean;
}

export function parseXmlTable(input: string): XmlSheet[] {
  const root = parseXml(input);
  if (root.name === 'Workbook' && root.children.some((c) => c.name === 'Worksheet')) return spreadsheet2003(root);
  return genericRecords(root);
}

// ---------------------------------------------------------------------------
// Excel XML Spreadsheet 2003
// ---------------------------------------------------------------------------

function spreadsheet2003(workbook: XmlNode): XmlSheet[] {
  const sheets: XmlSheet[] = [];
  for (const ws of workbook.children.filter((c) => c.name === 'Worksheet')) {
    const table = ws.children.find((c) => c.name === 'Table');
    // Only rows with a value are kept, in order: a row index far down takes no room.
    const kept: { index: number; cells: Cell[] }[] = [];
    let rowIndex = 0;
    let columnsCut = false;
    for (const row of table?.children.filter((c) => c.name === 'Row') ?? []) {
      if (row.attrs.Index) rowIndex = Number(row.attrs.Index) - 1;
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= EXCEL_MAX_ROWS) throw new Error('A row of the XML spreadsheet lies outside what Excel allows.');
      const cells: Cell[] = [];
      let col = 0;
      for (const cell of row.children.filter((c) => c.name === 'Cell')) {
        if (cell.attrs.Index) col = Number(cell.attrs.Index) - 1;
        if (!Number.isInteger(col) || col < 0 || col >= EXCEL_MAX_COLUMNS) throw new Error('A cell of the XML spreadsheet lies outside what Excel allows.');
        const data = cell.children.find((c) => c.name === 'Data');
        const value = data ? typedValue(data.attrs.Type, deepText(data)) : null;
        if (value != null && value !== '') {
          if (col >= MAX_COLUMNS) columnsCut = true;
          else {
            while (cells.length < col) cells.push(null);
            cells[col] = value;
          }
        }
        col += Math.max(0, Math.min(Number(cell.attrs.MergeAcross ?? 0) || 0, EXCEL_MAX_COLUMNS)) + 1;
      }
      if (cells.length > 0) kept.push({ index: rowIndex, cells });
      rowIndex++;
    }
    kept.sort((a, b) => a.index - b.index);
    const sheet: XmlSheet = { name: ws.attrs.Name ?? `Sheet ${sheets.length + 1}`, rows: squareUp(kept.map((k) => k.cells as (string | number | boolean | null)[])) };
    if (columnsCut) sheet.columnsCut = true;
    sheets.push(sheet);
  }
  return sheets;
}

function typedValue(type: string | undefined, raw: string): Cell {
  const text = raw.length > MAX_CELL_LENGTH ? raw.slice(0, MAX_CELL_LENGTH) : raw;
  if (text === '') return null;
  switch (type) {
    case 'Number': { const n = Number(text); return Number.isFinite(n) ? n : text; }
    case 'Boolean': return text === '1' || text.toLowerCase() === 'true';
    case 'DateTime': return text.slice(0, 10);
    default: return text;
  }
}

// ---------------------------------------------------------------------------
// Generic record exports
// ---------------------------------------------------------------------------

/** Descends through single-child wrappers to the element whose children repeat. */
function findRecords(node: XmlNode, depth = 0): { name: string; records: XmlNode[] } {
  const counts = new Map<string, number>();
  for (const c of node.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  let best: string | null = null;
  for (const [name, n] of counts) if (best === null || n > counts.get(best)!) best = name;

  if (best !== null && counts.get(best)! >= 2) return { name: best, records: node.children.filter((c) => c.name === best) };
  if (node.children.length === 1 && node.children[0].children.length > 0 && depth < 6) return findRecords(node.children[0], depth + 1);
  if (best !== null) return { name: best, records: node.children.filter((c) => c.name === best) };
  throw new Error('No repeating records were found in the XML — expected one element per row under the root.');
}

function genericRecords(root: XmlNode): XmlSheet[] {
  const { name, records } = findRecords(root);

  // Positional rows: every child of every record carries the same tag name.
  const positional = records.every((r) => r.children.length > 0 && Object.keys(r.attrs).length === 0
    && r.children.every((c) => c.name === r.children[0].name));
  if (positional && records.some((r) => r.children.length > 1)) {
    const columnsCut = records.some((r) => r.children.length > MAX_COLUMNS);
    const rows: Cell[][] = records.map((r) => r.children.slice(0, MAX_COLUMNS).map((c) => cellText(deepText(c))));
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const sheet: XmlSheet = { name, rows: rows.map((r) => { while (r.length < width) r.push(null); return r; }) };
    if (columnsCut) sheet.columnsCut = true;
    return [sheet];
  }

  const headers: string[] = [];
  const seen = new Set<string>();
  const fieldRows: Record<string, string>[] = [];
  for (const r of records) {
    const fields: Record<string, string> = Object.create(null);   // a field may be called "constructor"
    for (const [k, v] of Object.entries(r.attrs)) fields[k] = v;
    for (const c of r.children) fields[c.name] = fields[c.name] != null ? `${fields[c.name]}, ${deepText(c)}` : deepText(c);
    if (Object.keys(fields).length === 0 && r.text.trim()) fields[name] = r.text.trim();
    for (const k of Object.keys(fields)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
    // Every record adds a column per new field name: records that all name different fields are not a table.
    if (headers.length > MAX_COLUMNS) throw new Error(`The XML records name more than ${MAX_COLUMNS.toLocaleString('en-US')} different fields — that is not a table the import can read.`);
    fieldRows.push(fields);
  }
  if (headers.length === 0) throw new Error('The XML records have no fields — expected attributes or child elements on each record.');
  const rows: Cell[][] = [headers, ...fieldRows.map((f) => headers.map((h) => (f[h] === undefined || f[h] === '' ? null : cellText(f[h]))))];
  return [{ name, rows }];
}

/** Escapes text for use in an element body or attribute value. */
export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Emits records as `<root><record><field>…</field></record></root>`. */
export function toXml(root: string, record: string, headers: string[], rows: (string | number | null)[][]): string {
  const body = rows.map((r) =>
    `  <${record}>\n${headers.map((h, i) => `    <${h}>${escapeXml(String(r[i] ?? ''))}</${h}>`).join('\n')}\n  </${record}>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n${body}\n</${root}>\n`;
}
