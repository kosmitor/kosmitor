/**
 * The text of a Word document, to become a template body. Only words are kept:
 * paragraphs become lines, table rows become lines with tab-separated cells,
 * and styling, images, headers and footers are dropped. A merge field typed as
 * {{holder.name}} survives even when Word split it over several runs.
 */
import { openZip, zipContents, decodeXml, ZipTooLarge } from './import/xlsx.ts';

export class DocxRefusal extends Error {
  code: 'damaged' | 'not-docx' | 'empty' | 'too-large';
  constructor(code: 'damaged' | 'not-docx' | 'empty' | 'too-large', message: string) { super(message); this.code = code; }
}

const UNPACKED_MAX = 50 * 1024 * 1024;

/** Paragraph text: runs joined, with tabs and line breaks kept. */
function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:cr\s*\/>/g)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else out += m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return out;
}

export function docxToText(buf: Buffer): string {
  let xml: string;
  try {
    const files = openZip(buf, UNPACKED_MAX);
    if (zipContents(files) !== 'docx') throw new DocxRefusal('not-docx', 'This is not a Word (.docx) document.');
    // Word writes a text box twice, as a drawing and as a fallback for old readers; read it once.
    xml = files.get('word/document.xml')!.toString('utf8').replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  } catch (err) {
    if (err instanceof DocxRefusal) throw err;
    if (err instanceof ZipTooLarge) throw new DocxRefusal('too-large', 'This document unpacks to more than a template can hold.');
    throw new DocxRefusal('damaged', 'This file could not be opened. Save it again from Word as a .docx and retry.');
  }

  const lines: string[] = [];
  // A table row is one line, its cells separated by tabs; every other paragraph is its own line.
  const blocks = xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b[\s\S]*?<\/w:p>/g);
  let rowEnd = -1;
  for (const b of blocks) {
    const at = b.index ?? 0;
    if (at < rowEnd) continue;
    if (b[0].startsWith('<w:tr')) {
      rowEnd = at + b[0].length;
      const cells = [...b[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) =>
        [...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0]).trim()).filter(Boolean).join(' '));
      lines.push(cells.join('\t'));
    } else lines.push(paragraphText(b[0]));
  }

  // Blank lines between paragraphs stay (one at most in a row); the ends are trimmed.
  const text = lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new DocxRefusal('empty', 'This document has no text.');
  return text;
}
