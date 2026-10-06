/**
 * A small PDF writer with no dependencies, for three kinds of file:
 *  - tabular reports (tablePdf): Letter pages, landscape by default, a title
 *    block, a header row repeated on every page, right-aligned numbers, bold
 *    total rows, notes and page numbers;
 *  - text documents (documentPdf): an agreement and its signature record;
 *  - certificates (certificatePdf, certificateBookPdf): the face of a stock
 *    certificate, equity award or SAFE in the classic framed form, then the
 *    legends, terms and signature record on the pages after it.
 * It uses the standard Helvetica and Times fonts, which every reader ships, so
 * nothing is embedded. Text is WinAnsi-encoded (Windows code page 1252);
 * characters outside it print as "?".
 */
import { config } from './config.ts';
import type { CertificateFace, Run } from './certificate-face.ts';

export interface PdfColumn {
  header: string;
  align?: 'left' | 'right';
  /** Relative width. When omitted for every column, widths follow the content. */
  width?: number;
}

export interface PdfRow {
  cells: string[];
  bold?: boolean;
  muted?: boolean;
}

export interface PdfTableDocument {
  title: string;
  subtitle?: string;
  columns: PdfColumn[];
  rows: PdfRow[];
  /** Small print under the table. */
  notes?: string[];
  /** Left-hand footer on every page, e.g. who generated it and when. */
  footer?: string;
  landscape?: boolean;
}

// Advance widths of Helvetica and Helvetica-Bold for the printable ASCII range
// (codes 32 to 126), in thousandths of the font size, from the AFM files.
const ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
  722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
if (REGULAR.length !== ASCII.length || BOLD.length !== ASCII.length) throw new Error('Font width tables are incomplete.');

// Advance widths of the four Times faces for every WinAnsi code from 32 to 255
// (index = code - 32; 0 where the encoding has no character), in thousandths of
// the font size, from Adobe's Core 14 AFM metrics, which may be freely used and redistributed.
const widths = (s: string): number[] => s.trim().split(/\s+/).map(Number);
const TIMES_ROMAN = widths(`
  250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 500 500 278 278
  564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556 611 722 722 944
  722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389
  278 500 500 722 500 500 444 480 200 480 541 0 500 0 333 500 444 1000 500 500 333 1000 556 333 889 0 611 0 0 333
  333 444 444 350 500 1000 333 980 389 333 722 0 444 722 250 333 500 500 500 500 200 500 333 760 276 500 564 333
  760 333 400 564 300 300 333 500 453 250 333 300 310 500 750 750 750 444 722 722 722 722 722 722 889 667 611 611
  611 611 333 333 333 333 722 722 722 722 722 722 722 564 722 722 722 722 722 722 556 500 444 444 444 444 444 444
  667 444 444 444 444 444 278 278 278 278 500 500 500 500 500 500 500 564 500 500 500 500 500 500 500 500`);
const TIMES_BOLD = widths(`
  250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333
  570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 556 667 722 722 1000
  722 722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 556 278 333 556 278 833 556 500 556 556 444 389
  333 556 500 722 500 500 444 394 220 394 520 0 500 0 333 500 500 1000 500 500 333 1000 556 333 1000 0 667 0 0 333
  333 500 500 350 500 1000 333 1000 389 333 722 0 444 722 250 333 500 500 500 500 220 500 333 747 300 500 570 333
  747 333 400 570 300 300 333 556 540 250 333 300 330 500 750 750 750 500 722 722 722 722 722 722 1000 722 667 667
  667 667 389 389 389 389 722 722 778 778 778 778 778 570 778 722 722 722 722 722 611 556 500 500 500 500 500 500
  722 444 444 444 444 444 278 278 278 278 500 556 500 500 500 500 500 570 500 556 556 556 556 500 556 500`);
const TIMES_ITALIC = widths(`
  250 333 420 500 500 833 778 214 333 333 500 675 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333
  675 675 675 500 920 611 611 667 722 611 611 722 722 333 444 667 556 833 667 722 611 722 611 500 556 722 611 833
  611 556 556 389 278 389 422 500 333 500 500 444 500 444 278 500 500 278 278 444 278 722 500 500 500 500 389 389
  278 500 444 667 444 444 389 400 275 400 541 0 500 0 333 500 556 889 500 500 333 1000 500 333 944 0 556 0 0 333
  333 556 556 350 500 889 333 980 389 333 667 0 389 556 250 389 500 500 500 500 275 500 333 760 276 500 675 333
  760 333 400 675 300 300 333 500 523 250 333 300 310 500 750 750 750 500 611 611 611 611 611 611 889 667 611 611
  611 611 333 333 333 333 722 667 722 722 722 722 722 675 722 722 722 722 722 556 611 500 500 500 500 500 500 500
  667 444 444 444 444 444 278 278 278 278 500 500 500 500 500 500 500 675 500 500 500 500 500 444 500 444`);
const TIMES_BOLD_ITALIC = widths(`
  250 389 555 500 500 833 778 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333
  570 570 570 500 832 667 667 667 722 667 667 722 778 389 500 667 611 889 722 722 611 722 667 556 611 722 667 889
  667 611 611 333 278 333 570 500 333 500 500 444 500 444 333 500 556 278 278 500 278 778 556 500 500 500 389 389
  278 556 444 667 500 444 389 348 220 348 570 0 500 0 333 500 500 1000 500 500 333 1000 556 333 944 0 611 0 0 333
  333 500 500 350 500 1000 333 1000 389 333 722 0 389 611 250 389 500 500 500 500 220 500 333 747 266 500 606 333
  747 333 400 570 300 300 333 576 500 250 333 300 300 500 750 750 750 500 667 667 667 667 667 667 944 667 667 667
  667 667 389 389 389 389 722 722 722 722 722 722 722 570 722 722 722 722 722 611 611 500 500 500 500 500 500 500
  722 444 444 444 444 444 278 278 278 278 500 556 500 500 500 500 500 570 500 556 556 556 556 444 500 444`);
if ([TIMES_ROMAN, TIMES_BOLD, TIMES_ITALIC, TIMES_BOLD_ITALIC].some((t) => t.length !== 224)) throw new Error('Times width tables are incomplete.');

type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic';

/** Every font a page may use: its resource name in the content streams and its widths (Helvetica's only cover ASCII). */
const FONTS: Record<FontName, { key: string; widths: number[] }> = {
  Helvetica: { key: 'F1', widths: REGULAR },
  'Helvetica-Bold': { key: 'F2', widths: BOLD },
  'Helvetica-Oblique': { key: 'F3', widths: REGULAR },
  'Times-Roman': { key: 'F4', widths: TIMES_ROMAN },
  'Times-Bold': { key: 'F5', widths: TIMES_BOLD },
  'Times-Italic': { key: 'F6', widths: TIMES_ITALIC },
  'Times-BoldItalic': { key: 'F7', widths: TIMES_BOLD_ITALIC },
};

/** Unicode characters that WinAnsi (code page 1252) has at a code outside Latin-1. */
const WINANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
  // No-break, figure, thin and narrow no-break spaces (number formats use them) print as a plain space.
  ' ': 0x20, ' ': 0x20, ' ': 0x20, ' ': 0x20,
};

/**
 * Text as WinAnsi codes. The standard fonts are not embedded, so only the 1252
 * code page can print: anything outside it (Greek, Cyrillic, CJK, emoji, most
 * symbols) becomes "?". Embedding a TrueType font would be the way past that.
 */
function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) out.push(code);
    else if (WINANSI[ch] != null) out.push(WINANSI[ch]);
    else if (code >= 0xa1 && code <= 0xff) out.push(code);
    else out.push(63); // ?
  }
  return out;
}

function width(text: string, size: number, font: FontName = 'Helvetica'): number {
  const table = FONTS[font].widths;
  let total = 0;
  for (const code of encode(text)) {
    const i = code - 32;
    total += i >= 0 && i < table.length ? table[i] : code === 0x85 ? 1000 : code === 0x97 ? 1000 : 556;
  }
  return (total / 1000) * size;
}

/** A PDF string literal: parentheses and backslashes escaped, non-ASCII bytes as octal escapes. */
function literal(text: string): string {
  let s = '(';
  for (const code of encode(text)) {
    if (code === 0x28 || code === 0x29 || code === 0x5c) s += `\\${String.fromCharCode(code)}`;
    else if (code < 32 || code > 126) s += `\\${code.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(code);
  }
  return `${s})`;
}

function fit(text: string, maxWidth: number, size: number, font: FontName = 'Helvetica'): string {
  if (width(text, size, font) <= maxWidth) return text;
  const ellipsis = '…';
  let cut = text;
  while (cut.length > 0 && width(cut + ellipsis, size, font) > maxWidth) cut = cut.slice(0, -1);
  return cut.trimEnd() + ellipsis;
}

const n = (v: number): string => (Math.round(v * 100) / 100).toString();

export function tablePdf(doc: PdfTableDocument): Buffer {
  const landscape = doc.landscape !== false;
  const W = landscape ? 792 : 612;
  const H = landscape ? 612 : 792;
  const margin = 40;
  const usable = W - margin * 2;
  const bodySize = 8.5;
  const rowHeight = 15;
  const headerHeight = 18;
  const pad = 6;

  // Column widths: fixed ratios when given, otherwise from the widest content, scaled to the page.
  const cols = doc.columns;
  let widths: number[];
  if (cols.every((c) => c.width != null)) {
    const total = cols.reduce((s, c) => s + (c.width as number), 0);
    widths = cols.map((c) => (usable * (c.width as number)) / total);
  } else {
    widths = cols.map((c, i) => {
      const content = doc.rows.reduce((m, r) => Math.max(m, width(r.cells[i] ?? '', bodySize, r.bold ? 'Helvetica-Bold' : 'Helvetica')), 0);
      return Math.max(width(c.header, bodySize, 'Helvetica-Bold'), content) + pad * 2;
    });
    const total = widths.reduce((s, w) => s + w, 0);
    if (total > usable) {
      widths = widths.map((w) => Math.max(40, (w * usable) / total));
    } else {
      // Spare room goes to the text columns first; numbers stay compact.
      const left = cols.map((c, i) => ((c.align ?? 'left') === 'left' ? i : -1)).filter((i) => i >= 0);
      const targets = left.length ? left : cols.map((_, i) => i);
      const extra = (usable - total) / targets.length;
      for (const i of targets) widths[i] += extra;
    }
  }

  // Pagination: how many rows fit on each page.
  const titleBlock = doc.title ? 44 + (doc.subtitle ? 14 : 0) : 0;
  const footerZone = 24;
  const pages: PdfRow[][] = [];
  let remaining = doc.rows.slice();
  let first = true;
  do {
    const top = H - margin - (first ? titleBlock : 0) - headerHeight;
    const capacity = Math.max(1, Math.floor((top - margin - footerZone) / rowHeight));
    pages.push(remaining.slice(0, capacity));
    remaining = remaining.slice(capacity);
    first = false;
  } while (remaining.length > 0);

  const streams: string[] = pages.map((rows, pageIndex) => {
    const c: string[] = [];
    let y = H - margin;
    if (pageIndex === 0 && doc.title) {
      c.push(`BT /F2 15 Tf ${n(margin)} ${n(y - 15)} Td ${literal(doc.title)} Tj ET`);
      y -= 15;
      if (doc.subtitle) {
        c.push(`0.42 0.46 0.54 rg BT /F1 9.5 Tf ${n(margin)} ${n(y - 14)} Td ${literal(doc.subtitle)} Tj ET 0 0 0 rg`);
        y -= 14;
      }
      y -= titleBlock - 15 - (doc.subtitle ? 14 : 0);
    }

    // Header row.
    c.push(`0.953 0.961 0.973 rg ${n(margin)} ${n(y - headerHeight)} ${n(usable)} ${n(headerHeight)} re f 0 0 0 rg`);
    c.push(`0.85 0.87 0.9 RG 0.5 w ${n(margin)} ${n(y - headerHeight)} m ${n(margin + usable)} ${n(y - headerHeight)} l S`);
    let x = margin;
    cols.forEach((col, i) => {
      const text = fit(col.header, widths[i] - pad * 2, bodySize, 'Helvetica-Bold');
      const tx = (col.align ?? 'left') === 'right' ? x + widths[i] - pad - width(text, bodySize, 'Helvetica-Bold') : x + pad;
      c.push(`0.33 0.36 0.43 rg BT /F2 ${n(bodySize)} Tf ${n(tx)} ${n(y - headerHeight + 6)} Td ${literal(text)} Tj ET 0 0 0 rg`);
      x += widths[i];
    });
    y -= headerHeight;

    for (const row of rows) {
      if (row.bold) c.push(`0.7 0.73 0.78 RG 0.8 w ${n(margin)} ${n(y)} m ${n(margin + usable)} ${n(y)} l S`);
      x = margin;
      cols.forEach((col, i) => {
        const raw = row.cells[i] ?? '';
        const font: FontName = row.bold ? 'Helvetica-Bold' : 'Helvetica';
        const text = fit(raw, widths[i] - pad * 2, bodySize, font);
        const tx = (col.align ?? 'left') === 'right' ? x + widths[i] - pad - width(text, bodySize, font) : x + pad;
        const color = row.muted ? '0.5 0.53 0.6 rg ' : '';
        c.push(`${color}BT /F${row.bold ? 2 : 1} ${n(bodySize)} Tf ${n(tx)} ${n(y - rowHeight + 4.5)} Td ${literal(text)} Tj ET${row.muted ? ' 0 0 0 rg' : ''}`);
        x += widths[i];
      });
      y -= rowHeight;
      c.push(`0.9 0.92 0.94 RG 0.4 w ${n(margin)} ${n(y)} m ${n(margin + usable)} ${n(y)} l S`);
    }

    if (pageIndex === pages.length - 1 && doc.notes?.length) {
      y -= 12;
      for (const note of doc.notes) {
        if (y < margin + footerZone + 10) break;
        c.push(`0.42 0.46 0.54 rg BT /F1 7.5 Tf ${n(margin)} ${n(y)} Td ${literal(fit(note, usable, 7.5))} Tj ET 0 0 0 rg`);
        y -= 10;
      }
    }

    // Footer.
    const pageLabel = `Page ${pageIndex + 1} of ${pages.length}`;
    c.push(`0.55 0.58 0.65 rg BT /F1 7.5 Tf ${n(margin + usable - width(pageLabel, 7.5))} ${n(margin - 8)} Td ${literal(pageLabel)} Tj ET`);
    if (doc.footer) c.push(`BT /F1 7.5 Tf ${n(margin)} ${n(margin - 8)} Td ${literal(fit(doc.footer, usable - 80, 7.5))} Tj ET`);
    c.push('0 0 0 rg');
    return c.join('\n');
  });

  return assemble(streams, W, H, doc.title);
}

/** Catalog, page tree, the standard fonts, document info, then a page and a content stream per page, and the cross-reference table. */
function assemble(streams: string[], W: number, H: number, title: string): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };
  add(''); // 1: catalog, filled in once the page tree exists
  add(''); // 2: pages
  const font = (name: FontName): string => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const fontIds: Partial<Record<FontName, number>> = {};
  fontIds.Helvetica = add(font('Helvetica')); // 3
  fontIds['Helvetica-Bold'] = add(font('Helvetica-Bold')); // 4
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  add(`<< /Producer ${literal(config().brand.productName)} /Title ${literal(title)} /CreationDate (D:${stamp}Z) >>`); // 5: info
  for (const name of ['Helvetica-Oblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'] as const) fontIds[name] = add(font(name));
  const fontDict = (Object.keys(fontIds) as FontName[]).map((name) => `/${FONTS[name].key} ${fontIds[name]} 0 R`).join(' ');
  const pageIds: number[] = [];
  for (const stream of streams) {
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << ${fontDict} >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${position}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Text documents: agreements and certificates with their signature record
// ---------------------------------------------------------------------------

export interface PdfSignature { name: string; signed: boolean; typed?: string | null; when?: string | null; ip?: string | null }
export interface PdfDocument {
  /** Small line above the title, usually the company's legal name. */
  company: string;
  title: string;
  /** Plain text; line breaks are kept, blank lines separate paragraphs. */
  body: string;
  signatures: PdfSignature[];
  /** Small print at the foot of every page. */
  footer: string;
}

/** Breaks text into lines no wider than `maxWidth`, keeping the author's own line breaks. */
function wrap(text: string, size: number, font: FontName, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate, size, font) <= maxWidth) { line = candidate; continue; }
      if (line) out.push(line);
      let chunk = word;
      while (width(chunk, size, font) > maxWidth && chunk.length > 1) {
        let cut = chunk.length - 1;
        while (cut > 1 && width(chunk.slice(0, cut), size, font) > maxWidth) cut--;
        out.push(chunk.slice(0, cut));
        chunk = chunk.slice(cut);
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

interface Row { text: string; size: number; font: 1 | 2 | 3; height: number; color?: string; x?: number; rule?: boolean; second?: { text: string; size: number; font: 1 | 2 | 3; color?: string; x: number } }

export function documentPdf(doc: PdfDocument): Buffer {
  const W = 612, H = 792, margin = 60;
  const usable = W - margin * 2;
  const grey = '0.42 0.46 0.54 rg';
  const rows: Row[] = [];
  const push = (text: string, size: number, font: 1 | 2 | 3, height: number, extra: Partial<Row> = {}) => rows.push({ text, size, font, height, ...extra });

  push(doc.company.toUpperCase(), 8.5, 2, 16, { color: grey });
  for (const line of wrap(doc.title, 15, 'Helvetica-Bold', usable)) push(line, 15, 2, 20);
  push('', 6, 1, 10);
  for (const line of wrap(doc.body, 10.5, 'Helvetica', usable)) push(line, 10.5, 1, line ? 15 : 8);

  if (doc.signatures.length) {
    push('', 6, 1, 14);
    push('Signatures', 9, 2, 18, { color: grey, rule: true });
    const column = margin + 200;
    for (const s of doc.signatures) {
      const detail = s.signed
        ? { text: `${s.typed ?? s.name}`, size: 12, font: 3 as const, x: column }
        : { text: 'Not yet signed', size: 9.5, font: 1 as const, color: grey, x: column };
      push(fit(s.name, 190, 10, 'Helvetica-Bold'), 10, 2, 16, { second: detail });
      if (s.signed) push('', 8.5, 1, 13, { second: { text: `signed ${s.when ?? ''}${s.ip ? ` \u00b7 ${s.ip}` : ''}`.trim(), size: 8.5, font: 1, color: grey, x: column } });
    }
  }

  // Pagination: fill each page down to the footer zone.
  const pages: Row[][] = [[]];
  let y = H - margin;
  for (const row of rows) {
    if (y - row.height < margin + 24 && pages[pages.length - 1].length) { pages.push([]); y = H - margin; }
    pages[pages.length - 1].push(row);
    y -= row.height;
  }

  const streams = pages.map((page, index) => {
    const c: string[] = [];
    let cursor = H - margin;
    for (const row of page) {
      const baseline = cursor - row.size;
      if (row.rule) c.push(`0.8 0.83 0.87 RG 0.6 w ${n(margin)} ${n(cursor - 2)} m ${n(W - margin)} ${n(cursor - 2)} l S`);
      if (row.text) c.push(`${row.color ?? '0 0 0 rg'} BT /F${row.font} ${n(row.size)} Tf ${n(row.x ?? margin)} ${n(baseline)} Td ${literal(row.text)} Tj ET 0 0 0 rg`);
      if (row.second?.text) {
        const s = row.second;
        c.push(`${s.color ?? '0 0 0 rg'} BT /F${s.font} ${n(s.size)} Tf ${n(s.x)} ${n(baseline)} Td ${literal(fit(s.text, W - margin - s.x, s.size, s.font === 2 ? 'Helvetica-Bold' : 'Helvetica'))} Tj ET 0 0 0 rg`);
      }
      cursor -= row.height;
    }
    const pageLabel = `Page ${index + 1} of ${pages.length}`;
    c.push(`0.55 0.58 0.65 rg BT /F1 7.5 Tf ${n(W - margin - width(pageLabel, 7.5))} ${n(margin - 18)} Td ${literal(pageLabel)} Tj ET`);
    c.push(`BT /F1 7.5 Tf ${n(margin)} ${n(margin - 18)} Td ${literal(fit(doc.footer, usable - 80, 7.5))} Tj ET 0 0 0 rg`);
    return c.join('\n');
  });
  return assemble(streams, W, H, doc.title);
}

// ---------------------------------------------------------------------------
// Certificates: the face in the classic framed form, then the legends, terms
// and signature record on the pages after it
// ---------------------------------------------------------------------------

export interface CertificatePdfInput {
  face: CertificateFace;
  /** The signature record for this document, in order; role COMPANY is the block with no stakeholder, HOLDER the holder's. */
  signatures: { role: 'COMPANY' | 'HOLDER'; name: string; signed: boolean; typed?: string | null; when?: string | null; ip?: string | null }[];
  executed: boolean;
  /** e.g. "Document doc_x · generated 2026-10-04" */
  footer: string;
  /** Hex colour of the frame; the watermark is a pale tint of it. */
  frameColor: string;
}

type CertificateSignature = CertificatePdfInput['signatures'][number];

// Letter landscape, laid out like a classic certificate: a thin frame 15pt in
// from the edges and the text between x 79 and 713, all set in Times.
const CERT_W = 792, CERT_H = 612;
const FRAME_INSET = 15;
const LEFT = 79, RIGHT = 713, MEASURE = RIGHT - LEFT;
/** The widest the watermark and the heading may run, centred on the page. */
const DISPLAY_WIDTH = 640;
const INK = 0.12;
/** The face's body starts at this baseline and stops above this one, clear of the date and the signatures. */
const BODY_TOP = 415, BODY_FLOOR = 245, DATED_Y = 230;
/** Sizes and line spacings tried in turn until the face's paragraphs fit. */
const BODY_SIZES: [number, number][] = [[10, 1.68], [9.5, 1.68], [9, 1.68], [8.5, 1.68], [8, 1.68], [8, 1.5], [8, 1.35], [7.5, 1.35], [7, 1.35]];
/** The flowing pages after the face: first line's top, and the lowest any line may reach. */
const BACK_TOP = 562, BACK_BOTTOM = 50;

const c3 = (v: number): string => (Math.round(v * 1000) / 1000).toString();
const gray = (level: number): string => `${c3(level)} g`;

/** "#0f6b4f" (or "#0f6") as RGB fractions; anything unreadable falls back to a dark green. */
function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return [0.059, 0.42, 0.31];
  const h = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** One line of text with its baseline at (x, y). */
function textAt(x: number, y: number, font: FontName, size: number, value: string, color: string): string {
  return `${color} BT /${FONTS[font].key} ${n(size)} Tf ${n(x)} ${n(y)} Td ${literal(value)} Tj ET`;
}

/** The text at the largest size up to `size` (not below `min`) that fits `maxWidth`, cut with an ellipsis if even `min` is too wide. */
function shrink(value: string, maxWidth: number, size: number, min: number, font: FontName): { value: string; size: number } {
  const unit = width(value, 1, font);
  const fitted = unit > 0 ? Math.floor(Math.min(size, maxWidth / unit) * 10) / 10 : size;
  const s = Math.max(min, fitted);
  return { value: fit(value, maxWidth, s, font), size: s };
}

// --- Rich text: paragraphs of runs, some bold ---------------------------------------------

interface Piece { text: string; bold: boolean }
/** A word, which may change weight inside it (a bold name followed by a comma) but never breaks there. */
interface Word { pieces: Piece[]; width: number; gapBold: boolean }
interface RichLine { words: Word[]; width: number }

const runFont = (bold: boolean): FontName => (bold ? 'Times-Bold' : 'Times-Roman');
const pieceWidth = (pieces: Piece[], size: number): number => pieces.reduce((s, p) => s + width(p.text, size, runFont(p.bold)), 0);

/** A word too wide for the line, cut into pieces that each fit. */
function splitWord(word: Word, size: number, maxWidth: number): Word[] {
  const out: Word[] = [];
  let pieces: Piece[] = [];
  const push = () => { if (pieces.length) out.push({ pieces, width: pieceWidth(pieces, size), gapBold: word.gapBold }); pieces = []; };
  for (const piece of word.pieces) {
    for (const ch of piece.text) {
      const last = pieces[pieces.length - 1];
      const next = last && last.bold === piece.bold ? [...pieces.slice(0, -1), { text: last.text + ch, bold: piece.bold }] : [...pieces, { text: ch, bold: piece.bold }];
      if (pieces.length && pieceWidth(next, size) > maxWidth) { push(); pieces = [{ text: ch, bold: piece.bold }]; } else pieces = next;
    }
  }
  push();
  return out;
}

/** Breaks a paragraph of runs into lines no wider than `maxWidth`. */
function richLines(runs: Run[], size: number, maxWidth: number): RichLine[] {
  const words: Word[] = [];
  let pieces: Piece[] = [];
  let gapBold = false;
  const flush = () => {
    if (pieces.length) words.push({ pieces, width: pieceWidth(pieces, size), gapBold });
    pieces = [];
  };
  for (const run of runs) {
    const bold = !!run.bold;
    for (const part of run.text.split(/([ \t\r\n]+)/)) {
      if (!part) continue;
      if (/^[ \t\r\n]+$/.test(part)) { flush(); gapBold = bold; continue; }
      const last = pieces[pieces.length - 1];
      if (last && last.bold === bold) last.text += part; else pieces.push({ text: part, bold });
    }
  }
  flush();

  const lines: RichLine[] = [];
  let line: RichLine = { words: [], width: 0 };
  for (const word of words.flatMap((w) => (w.width > maxWidth ? splitWord(w, size, maxWidth) : [w]))) {
    const gap = line.words.length ? width(' ', size, runFont(word.gapBold)) : 0;
    if (line.words.length && line.width + gap + word.width > maxWidth) {
      lines.push(line);
      line = { words: [word], width: word.width };
    } else {
      line.words.push(word);
      line.width += gap + word.width;
    }
  }
  if (line.words.length) lines.push(line);
  return lines;
}

/** A line of runs as one text object; `justify` widens its spaces so it ends at the right margin. */
function richLine(line: RichLine, x: number, y: number, size: number, maxWidth: number, justify: boolean): string {
  const segments: Piece[] = [];
  line.words.forEach((word, i) => {
    for (const p of i ? [{ text: ' ', bold: word.gapBold }, ...word.pieces] : word.pieces) {
      const last = segments[segments.length - 1];
      if (last && last.bold === p.bold) last.text += p.text; else segments.push({ ...p });
    }
  });
  const spaces = segments.reduce((s, p) => s + encode(p.text).filter((code) => code === 32).length, 0);
  const slack = maxWidth - line.width;
  // Word spacing applies to every space byte; a line that would need gaps wider than an em stays ragged.
  const tw = justify && spaces > 0 && slack > 0 && slack / spaces < size ? slack / spaces : 0;
  const body = segments.map((p) => `/${FONTS[runFont(p.bold)].key} ${n(size)} Tf ${literal(p.text)} Tj`).join(' ');
  return `${gray(INK)} BT ${c3(tw)} Tw ${n(x)} ${n(y)} Td ${body} 0 Tw ET`;
}

// --- The face -------------------------------------------------------------------------------

/** The company's name on one line at up to 38pt, or on up to three smaller lines when it is long. */
function headingLayout(value: string): { lines: string[]; size: number } {
  const unit = width(value, 1, 'Times-Bold');
  if (unit * 22 <= DISPLAY_WIDTH || !/\s/.test(value.trim())) return { lines: [value], size: unit > 0 ? Math.min(38, Math.floor((DISPLAY_WIDTH / unit) * 10) / 10) : 38 };
  let lines: string[] = [];
  for (let size = 24; size >= 12; size--) {
    lines = wrap(value, size, 'Times-Bold', DISPLAY_WIDTH).filter(Boolean);
    if (lines.length <= 3) return { lines, size };
  }
  return { lines, size: 12 };
}

/** The face's paragraphs at the largest size that keeps them above the date line. */
function bodyLayout(paragraphs: Run[][]): { size: number; leading: number; blocks: RichLine[][] } {
  let layout = { size: 10, leading: 16.8, blocks: [] as RichLine[][] };
  for (const [size, factor] of BODY_SIZES) {
    const blocks = paragraphs.map((p) => richLines(p, size, MEASURE)).filter((b) => b.length);
    layout = { size, leading: size * factor, blocks };
    const rows = blocks.reduce((s, b) => s + b.length, 0) + Math.max(0, blocks.length - 1);
    if (BODY_TOP - (rows - 1) * layout.leading >= BODY_FLOOR) break;
  }
  return layout;
}

function facePage(doc: CertificatePdfInput, frame: [number, number, number]): string[] {
  const { face } = doc;
  const c: string[] = [];

  // The faint title behind everything: a pale tint of the frame colour, drawn first.
  const marks = (face.watermark ?? []).map((l) => l.trim()).filter(Boolean);
  if (marks.length) {
    const widest = Math.max(...marks.map((l) => width(l, 1, 'Times-Roman')));
    const size = widest > 0 ? Math.min(75, Math.floor((DISPLAY_WIDTH / widest) * 10) / 10) : 75;
    const tint = `${frame.map((v) => c3(0.88 + 0.12 * v)).join(' ')} rg`;
    const lead = size * 1.08;
    // The last line shares the date's baseline, as on a classic certificate; a line wide
    // enough to run into the date moves up, the whole title with it, until it clears it.
    let centre = 270.5;
    const lastBaseline = centre - ((marks.length - 1) / 2) * lead;
    const lastLeft = CERT_W / 2 - width(marks[marks.length - 1], size, 'Times-Roman') / 2;
    if (face.dated && lastLeft < LEFT + width(face.dated, 11, 'Times-Roman') + 12) centre += Math.max(0, DATED_Y + 10 + 0.22 * size - lastBaseline);
    marks.forEach((line, i) => {
      const y = centre + ((marks.length - 1) / 2 - i) * lead;
      c.push(textAt(CERT_W / 2 - width(line, size, 'Times-Roman') / 2, y, 'Times-Roman', size, line, tint));
    });
  }

  // Number and amount across the top.
  const half = MEASURE / 2 - 12;
  c.push(textAt(LEFT, 551, 'Times-Roman', 12, fit(face.idLabel, half, 12, 'Times-Roman'), gray(0.6)));
  const amount = fit(face.amountLabel, half, 12, 'Times-Roman');
  c.push(textAt(RIGHT - width(amount, 12, 'Times-Roman'), 551, 'Times-Roman', 12, amount, gray(0.6)));

  // The company's legal name.
  const heading = headingLayout(face.heading ?? '');
  heading.lines.forEach((line, i) => {
    const y = 470 + ((heading.lines.length - 1) / 2 - i) * heading.size * 1.15;
    c.push(textAt(CERT_W / 2 - width(line, heading.size, 'Times-Bold') / 2, y, 'Times-Bold', heading.size, line, gray(0.24)));
  });

  // The certifying paragraphs, a blank line between them.
  const body = bodyLayout(face.paragraphs);
  let y = BODY_TOP;
  body.blocks.forEach((lines, p) => {
    if (p) y -= body.leading;
    lines.forEach((line, i) => {
      c.push(richLine(line, LEFT, y, body.size, MEASURE, i < lines.length - 1));
      y -= body.leading;
    });
  });

  if (face.dated) c.push(textAt(LEFT, DATED_Y, 'Times-Roman', 11, fit(face.dated, MEASURE, 11, 'Times-Roman'), gray(0.45)));

  // Signature blocks: the typed signature on the line, then the name and the title.
  const signers = face.signers ?? [];
  const count = signers.length;
  const lineLength = count <= 2 ? 270 : (MEASURE - 24 * (count - 1)) / count;
  const used = new Set<CertificateSignature>();
  signers.forEach((signer, i) => {
    const x = count <= 2 ? (i === 0 ? LEFT : RIGHT - lineLength) : LEFT + i * (lineLength + 24);
    const sig = doc.signatures.find((s) => s.role === signer.role && !used.has(s));
    if (sig) used.add(sig);
    c.push(`${c3(0.6)} G 0.5 w ${n(x)} 118 m ${n(x + lineLength)} 118 l S`);
    if (sig?.signed) {
      const typed = shrink(sig.typed || sig.name, lineLength - 8, 16, 10, 'Times-BoldItalic');
      c.push(textAt(x + 4, 126, 'Times-BoldItalic', typed.size, typed.value, '0.11 0.16 0.33 rg'));
    } else if (sig) {
      c.push(textAt(x, 123, 'Times-Italic', 8.5, 'Awaiting signature', gray(0.55)));
    }
    // A name too long for one line at 10pt takes two, and the title moves down under it.
    let nameLines = [shrink(signer.name, lineLength, 12, 10, 'Times-Bold')];
    if (width(signer.name, 10, 'Times-Bold') > lineLength) {
      const [first, ...rest] = wrap(signer.name, 10, 'Times-Bold', lineLength).filter(Boolean);
      nameLines = [{ value: first, size: 10 }, { value: fit(rest.join(' '), lineLength, 10, 'Times-Bold'), size: 10 }].filter((l) => l.value);
    }
    nameLines.forEach((l, j) => c.push(textAt(x, 98 - j * 11.5, 'Times-Bold', l.size, l.value, gray(0.15))));
    const title = shrink(signer.title, lineLength, 12, 9, 'Times-Italic');
    if (title.value) c.push(textAt(x, nameLines.length > 1 ? 70 : 80, 'Times-Italic', title.size, title.value, gray(0.3)));
  });
  return c;
}

// --- The pages after the face -----------------------------------------------------------------

interface FlowPart { x: number; font: FontName; size: number; text: string; color: string }
/** A line of the flowing pages: `keep` more lines must fit on the same page (a heading with its first lines). */
interface FlowLine { height: number; size: number; parts: FlowPart[]; gap?: boolean; keep?: number }

/** "2026-09-22T12:16:00.000Z" or "2026-09-22 12:16" as "2026-09-22 12:16 UTC"; a time that already names its zone stays as it is. */
function utc(when: string): string {
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]00:?00)?$/.exec(when.trim());
  if (iso) return `${iso[1]} ${iso[2]} UTC`;
  return /\b(UTC|GMT)\b|Z$|[+-]\d{2}:?\d{2}$/.test(when.trim()) ? when.trim() : `${when.trim()} UTC`;
}

function signedAs(s: CertificateSignature): string {
  return `Signed as “${s.typed || s.name}”${s.when ? ` on ${utc(s.when)}` : ''}${s.ip ? ` from ${s.ip}` : ''}`;
}

function backLines(doc: CertificatePdfInput): FlowLine[] {
  const out: FlowLine[] = [];
  const line = (parts: FlowPart[], height: number, keep = 0) => out.push({ parts, height, keep, size: Math.max(...parts.map((p) => p.size)) });
  const gap = (height: number) => out.push({ parts: [], height, size: 0, gap: true });

  const back = (doc.face.back ?? '').replace(/\r\n?/g, '\n').trim();
  if (back) {
    for (const t of wrap((doc.face.backTitle ?? '').trim(), 14, 'Times-Bold', MEASURE).filter(Boolean)) line([{ x: LEFT, font: 'Times-Bold', size: 14, text: t, color: gray(0.24) }], 20, 2);
    gap(8);
    // The author's line breaks are kept; a run of blank lines is one paragraph break.
    let blank = false;
    for (const t of wrap(back, 11, 'Times-Roman', MEASURE)) {
      if (!t.trim()) { blank = true; continue; }
      if (blank) gap(8);
      blank = false;
      line([{ x: LEFT, font: 'Times-Roman', size: 11, text: t, color: gray(INK) }], 15);
    }
  }

  if (doc.signatures.length || doc.executed) {
    if (out.length) gap(16);
    line([{ x: LEFT, font: 'Times-Bold', size: 12, text: 'Electronic signatures', color: gray(0.24) }], 20, 2);
    const column = LEFT + 210;
    for (const s of doc.signatures) {
      const details = wrap(s.signed ? signedAs(s) : 'Not yet signed', 11, 'Times-Roman', RIGHT - column).filter(Boolean);
      details.forEach((d, i) => line([
        ...(i === 0 ? [{ x: LEFT, font: 'Times-Bold' as const, size: 11, text: fit(s.name, column - LEFT - 12, 11, 'Times-Bold'), color: gray(INK) }] : []),
        { x: column, font: 'Times-Roman', size: 11, text: d, color: gray(s.signed ? INK : 0.45) },
      ], 16, i === 0 ? details.length - 1 : 0));
    }
    if (doc.executed) {
      gap(6);
      line([{ x: LEFT, font: 'Times-Italic', size: 11, text: `Fully executed electronically on the ${config().brand.productName} platform.`, color: gray(INK) }], 16);
    }
  }
  return out;
}

/** Fills each page down to the footer, never starting one with a blank and keeping headings with what follows. */
function paginate(lines: FlowLine[]): FlowLine[][] {
  const pages: FlowLine[][] = [];
  let page: FlowLine[] = [];
  let cursor = BACK_TOP;
  lines.forEach((line, i) => {
    const need = line.height + lines.slice(i + 1, i + 1 + (line.keep ?? 0)).reduce((s, l) => s + l.height, 0);
    if (page.length && cursor - need < BACK_BOTTOM) { pages.push(page); page = []; cursor = BACK_TOP; }
    if (line.gap && !page.length) return;
    page.push(line);
    cursor -= line.height;
  });
  if (page.length) pages.push(page);
  return pages;
}

function backPage(lines: FlowLine[]): string[] {
  const c: string[] = [];
  let cursor = BACK_TOP;
  for (const line of lines) {
    for (const p of line.parts) c.push(textAt(p.x, cursor - line.size, p.font, p.size, p.text, p.color));
    cursor -= line.height;
  }
  return c;
}

/** Every page of one document: the frame, the face or the flowing text, and the footer with its own page numbers. */
function certificatePages(doc: CertificatePdfInput): string[] {
  const frame = rgb(doc.frameColor);
  const border = `${frame.map(c3).join(' ')} RG 0.6 w ${FRAME_INSET} ${FRAME_INSET} ${CERT_W - FRAME_INSET * 2} ${CERT_H - FRAME_INSET * 2} re S`;
  const pages = [facePage(doc, frame), ...paginate(backLines(doc)).map(backPage)];
  return pages.map((ops, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const labelWidth = width(label, 7.5, 'Times-Roman');
    const footer = [
      textAt(RIGHT - labelWidth, 27, 'Times-Roman', 7.5, label, gray(0.5)),
      textAt(LEFT, 27, 'Times-Roman', 7.5, fit(doc.footer, MEASURE - labelWidth - 24, 7.5, 'Times-Roman'), gray(0.5)),
    ];
    return [border, ...ops, ...footer].join('\n');
  });
}

const certificateTitle = (face: CertificateFace): string => [face.heading, face.idLabel].filter(Boolean).join(' · ');

/** A certificate, equity award or SAFE: its face, then its legends, terms and signature record. */
export function certificatePdf(doc: CertificatePdfInput): Buffer {
  return assemble(certificatePages(doc), CERT_W, CERT_H, certificateTitle(doc.face));
}

/** Several documents in one file, each starting on a new page with its own page numbers. */
export function certificateBookPdf(docs: CertificatePdfInput[]): Buffer {
  if (docs.length === 0) throw new Error('A certificate book needs at least one document.');
  const title = docs.length === 1 ? certificateTitle(docs[0].face) : `${docs[0].face.heading} · ${docs.length} documents`;
  return assemble(docs.flatMap(certificatePages), CERT_W, CERT_H, title);
}
