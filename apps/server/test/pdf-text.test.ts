/**
 * Reading the text of a PDF, for the values in a valuation report.
 *
 * Pinned here: the app's own PDFs read back as they were written, compressed or
 * not; the ways other software writes text read too (composite fonts with a
 * ToUnicode map, fonts packed in object streams, glyph names, kerned arrays);
 * and a file that is not a PDF, is encrypted, is damaged or is built to exhaust
 * the server comes back as a reason, never as a crash or a server out of memory.
 *
 * Every PDF here is made up, by the app's own writer or by hand below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeflate, deflateSync } from 'node:zlib';

const { pdfText } = await import('../src/pdf-text.ts');
const { documentPdf } = await import('../src/pdf-writer.ts');

// --- Building PDFs by hand --------------------------------------------------------

/** A PDF from its objects, numbered from 1 in the order given, with a cross-reference table and a trailer. */
function pdf(objects: (string | Buffer)[], trailer = '/Root 1 0 R'): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const bytes = (data: string | Buffer): Buffer => (Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'));
/** A stream object: its dictionary with the length, then the data. */
const stream = (dict: string, data: string | Buffer): Buffer => {
  const d = bytes(data);
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${d.length} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]);
};
/** The same, compressed with Flate. */
const flate = (dict: string, data: string | Buffer): Buffer => stream(`${dict} /Filter /FlateDecode`, deflateSync(bytes(data)));

/** Reads `file`, with how long it took and how much more memory the process holds after. */
function measured(file: Buffer, limits?: Parameters<typeof pdfText>[1]) {
  const rss = process.memoryUsage().rss;
  const started = performance.now();
  const read = pdfText(file, limits);
  return { read, ms: Math.round(performance.now() - started), grew: process.memoryUsage().rss - rss };
}
const MB = 1024 * 1024;
/**
 * How long a file built to make the reader work may take to read here. Each takes
 * a few hundred milliseconds, and what they guard against took minutes or ran the
 * server out of memory; the margin is for a machine busy with the rest of the suite.
 */
const PROMPTLY = 2_000;

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const ONE_PAGE = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
/** A one-page PDF drawing `content` with Helvetica as /F1. */
const simplePdf = (content: string): Buffer => pdf([
  CATALOG, ONE_PAGE,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  HELVETICA, stream('', content),
]);

/** The made-up report the app's own writer produces. */
const REPORT = {
  company: 'Marlowe Systems, Inc.',
  title: 'Valuation of the common stock (Section 409A)',
  body: [
    'Valuation Date: June 30, 2026',
    '',
    'Based on our analysis, we concluded that the fair market value of the common stock is $0.42 per share on a non-marketable, minority basis.',
    '',
    'Café (Paris) & “Partners” \\ backslash — a dash.',
  ].join('\n'),
  signatures: [{ name: 'Ledgerline Valuations', signed: true, typed: 'Rowan Hale', when: '2026-07-01' }],
  footer: 'Prepared for Marlowe Systems, Inc.',
};

// --- The app's own PDFs -------------------------------------------------------------

test('a PDF from the app’s own writer reads back its text, line by line, with its escapes and accents', () => {
  const read = pdfText(documentPdf(REPORT));
  assert.equal(read.readable, true);
  if (!read.readable) return;
  assert.equal(read.pages.length, 1);
  const lines = read.pages[0].split('\n');
  assert.equal(lines[0], 'MARLOWE SYSTEMS, INC.');
  assert.equal(lines[1], 'Valuation of the common stock (Section 409A)');
  assert.ok(lines.includes('Valuation Date: June 30, 2026'), read.pages[0]);
  assert.match(read.pages[0], /we concluded that the fair market value of the common stock is \$0\.42 per share/);
  assert.match(read.pages[0], /Café \(Paris\) & “Partners” \\ backslash — a dash\./);
  // Two pieces of text side by side on one line read with a space between them.
  assert.ok(lines.includes('Ledgerline Valuations Rowan Hale'), read.pages[0]);
});

test('a long document reads page by page, in order', () => {
  const body = Array.from({ length: 140 }, (_, i) => `Paragraph ${i + 1} of the report.`).join('\n');
  const read = pdfText(documentPdf({ ...REPORT, body }));
  assert.ok(read.readable);
  if (!read.readable) return;
  assert.ok(read.pages.length >= 3, `${read.pages.length} pages`);
  assert.match(read.pages[0], /^Paragraph 1 of the report\.$/m);
  assert.match(read.pages.at(-1)!, /^Paragraph 140 of the report\.$/m);
  const order = read.pages.join('\n').match(/Paragraph (\d+)/g)!.map((p) => Number(p.split(' ')[1]));
  assert.deepEqual(order, Array.from({ length: 140 }, (_, i) => i + 1));
});

test('the same PDF with its streams compressed reads the same', () => {
  const plain = documentPdf(REPORT);
  // Every content stream deflated, as most writers store them.
  const source = plain.toString('latin1');
  const parts: Buffer[] = [];
  let last = 0;
  for (const m of source.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    const data = plain.subarray(start, start + Number(m[1]));
    parts.push(plain.subarray(last, m.index!), flate('', data));
    last = start + Number(m[1]) + '\nendstream'.length;
  }
  parts.push(plain.subarray(last));
  const packed = Buffer.concat(parts);
  assert.ok(packed.includes('/FlateDecode') && packed.length < plain.length, 'the streams are compressed');
  assert.deepEqual(pdfText(packed), pdfText(plain));
});

// --- How other software writes text --------------------------------------------------

/**
 * A composite font of the kind word processors embed: two bytes a character, each
 * a glyph number that only the ToUnicode map turns back into a character. The map
 * uses single codes, ranges and a range given as an array.
 */
const CMAP = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Report-UCS def
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar
<0003> <0020>
<0010> <0024>
<0011> <002E>
endbfchar
4 beginbfrange
<0013> <001C> <0030>
<0024> <003D> <0041>
<0044> <005D> <0061>
<0060> <0062> [<003A> <002C> <002D>]
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
/** The glyph numbers the map above gives each character. */
function glyphs(text: string): string {
  return [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    const g = ch === ' ' ? 3 : ch === '$' ? 0x10 : ch === '.' ? 0x11 : ch === ':' ? 0x60 : ch === ',' ? 0x61 : ch === '-' ? 0x62
      : c >= 0x30 && c <= 0x39 ? 0x13 + c - 0x30 : c >= 0x41 && c <= 0x5a ? 0x24 + c - 0x41 : 0x44 + c - 0x61;
    return g.toString(16).padStart(4, '0');
  }).join('');
}

test('a composite font with two-byte codes reads through its ToUnicode map: single codes, ranges and array ranges', () => {
  const file = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Report /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    flate('', `BT /F1 11 Tf 72 700 Td <${glyphs('Fair market value: $0.42')}> Tj 0 -14 Td <${glyphs('Common stock, non-marketable.')}> Tj ET`),
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Report /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /W [3 [250] 16 17 556] >>',
    flate('', CMAP),
  ]);
  assert.deepEqual(pdfText(file), { readable: true, pages: ['Fair market value: $0.42\nCommon stock, non-marketable.'] });
});

test('a font kept in a compressed object stream is found, and its glyph names spell the text', () => {
  // Object 4, the font, lives only inside object 6, an object stream. Its codes
  // are its own, given glyph names through /Differences.
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Serif /Encoding << /Type /Encoding /Differences [1 /F /a /i /r /space /v /l /u /e /colon /dollar /zero /period /four /two /f_i /n.sc /d] >> >>';
  const header = '4 0 ';
  const objstm = flate(`/Type /ObjStm /N 1 /First ${header.length}`, `${header}${font}`);
  const codes = (s: string) => [...s].map((ch) => ({ F: 1, a: 2, i: 3, r: 4, ' ': 5, v: 6, l: 7, u: 8, e: 9, ':': 10, $: 11, '0': 12, '.': 13, '4': 14, '2': 15 } as Record<string, number>)[ch]
    .toString(16).padStart(2, '0')).join('');
  const file = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',   // an older version of object 4, replaced by the one in the stream
    flate('', `BT /F1 12 Tf 72 700 Td <${codes('Fair value: $0.42')}> Tj 0 -14 Td <1011> Tj ET`),
    objstm,
  ]);
  // The ligature and the small capital read as the letters they draw.
  assert.deepEqual(pdfText(file), { readable: true, pages: ['Fair value: $0.42\nfin'] });
});

test('kerned text reads with a space where the kerning is a word gap, and without one where it is not', () => {
  const read = pdfText(simplePdf('BT /F1 12 Tf 72 700 Td [(Fair)-250(market)-300(value)50(s) ( ) (are) -20 ( ) (V) -40 (aluation)] TJ ET'));
  assert.deepEqual(read, { readable: true, pages: ['Fair market values are Valuation'] });
});

test('lines follow the drawing, whichever operator moves to them, and table cells on one line keep a space between them', () => {
  const content = [
    'BT /F1 10 Tf 14 TL 72 720 Td (Line one) Tj T* (Line two) Tj (, still two) Tj',
    "(Line three) ' 0 -14 TD (Line four) Tj 1 0 0 1 72 650 Tm (Line five) Tj ET",
    'BT /F1 10 Tf 72 600 Td (Fair market value per common share) Tj ET BT /F1 10 Tf 400 600 Td ($0.42) Tj ET',
    'q 1 0 0 1 0 -20 cm BT /F1 10 Tf 72 600 Td (Moved down by the matrix) Tj ET Q',
  ].join('\n');
  assert.deepEqual(pdfText(simplePdf(content)), {
    readable: true,
    pages: ['Line one\nLine two, still two\nLine three\nLine four\nLine five\nFair market value per common share $0.42\nMoved down by the matrix'],
  });
});

test('an inline image is stepped over, whatever bytes it holds, and a form drawn on the page is read in place', () => {
  const image = Buffer.concat([Buffer.from('BI /W 4 /H 1 /BPC 8 /CS /G ID ', 'latin1'), Buffer.from([0x28, 0x29, 0x54, 0x6a, 0x00, 0xff]), Buffer.from(' EI\n', 'latin1')]);
  const content = Buffer.concat([Buffer.from('BT /F1 12 Tf 72 700 Td (Before the image) Tj ET\n', 'latin1'), image,
    Buffer.from('BT /F1 12 Tf 72 680 Td (After the image) Tj ET\n/Fm1 Do', 'latin1')]);
  const file = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>',
    HELVETICA, stream('', content),
    stream('/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Matrix [1 0 0 1 0 -40]', 'BT /F1 12 Tf 72 680 Td (Inside a form) Tj ET'),
  ]);
  assert.deepEqual(pdfText(file), { readable: true, pages: ['Before the image\nAfter the image\nInside a form'] });
});

test('pages inherit their resources from the page tree, and a page with nothing drawn reads as empty', () => {
  const file = pdf([
    CATALOG,
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    HELVETICA,
    stream('', 'BT /F1 12 Tf 72 700 Td (Inherited font) Tj ET'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ]);
  assert.deepEqual(pdfText(file), { readable: true, pages: ['Inherited font', ''] });
});

// --- What is refused, and how ----------------------------------------------------------

test('a file that is not a PDF says so', () => {
  assert.deepEqual(pdfText(Buffer.from('\x89PNG\r\n\x1a\n not a report', 'latin1')), { readable: false, reason: 'not-pdf' });
  assert.deepEqual(pdfText(Buffer.from('')), { readable: false, reason: 'not-pdf' });
  assert.deepEqual(pdfText(Buffer.from('Fair market value: $0.42')), { readable: false, reason: 'not-pdf' });
});

test('an encrypted PDF is not decrypted, whether its trailer or its cross-reference stream says so', () => {
  const trailer = pdf([CATALOG, ONE_PAGE, '<< /Type /Page /Parent 2 0 R >>', '<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>'], '/Root 1 0 R /Encrypt 4 0 R /ID [<01> <01>]');
  assert.deepEqual(pdfText(trailer), { readable: false, reason: 'encrypted' });
  const xrefStream = pdf([CATALOG, ONE_PAGE, '<< /Type /Page /Parent 2 0 R >>', '<< /Filter /Standard /V 2 /R 3 >>',
    stream('/Type /XRef /Size 6 /W [1 2 1] /Root 1 0 R /Encrypt 4 0 R', Buffer.alloc(24))], '');
  assert.deepEqual(pdfText(xrefStream), { readable: false, reason: 'encrypted' });
});

test('garbage after the PDF header is unreadable, and so is a file with no pages', () => {
  assert.deepEqual(pdfText(Buffer.from('%PDF-1.7\n\x00\x01\x02 garbage (((( <<<< ]]]] 9 9 obj << /Type', 'latin1')), { readable: false, reason: 'unreadable' });
  assert.deepEqual(pdfText(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4096, 0x41)])), { readable: false, reason: 'unreadable' });
  assert.deepEqual(pdfText(pdf([CATALOG, '<< /Type /Pages /Kids [] /Count 0 >>'])), { readable: false, reason: 'unreadable' });
});

test('damage is contained: a broken stream, a page tree that loops and an unknown filter lose only their own text', () => {
  const file = pdf([
    CATALOG,
    '<< /Type /Pages /Kids [3 0 R 2 0 R 6 0 R 7 0 R] /Count 3 >>',   // lists itself
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 8 0 R] >>',
    HELVETICA,
    stream('', 'BT /F1 12 Tf 72 700 Td (Still here) Tj ET'),
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F9 4 0 R >> >> /Contents 10 0 R >>',
    stream('/Filter /FlateDecode', 'this is not deflate data'),
    stream('/Filter /LZWDecode', 'BT /F1 12 Tf (Packed some other way) Tj ET'),
    stream('', 'BT /F1 12 Tf 72 700 Td (No such font, read as Latin-1) Tj ET'),
  ]);
  assert.deepEqual(pdfText(file), { readable: true, pages: ['Still here', '', 'No such font, read as Latin-1'] });
});

/** Deflates `size` zero bytes without ever holding them, the way a crafted file would be made. */
async function deflatedZeros(size: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => { deflate.on('end', resolve); deflate.on('error', reject); });
  const chunk = Buffer.alloc(1024 * 1024);
  for (let written = 0; written < size; written += chunk.length) {
    if (!deflate.write(chunk)) await new Promise((resolve) => deflate.once('drain', resolve));
  }
  deflate.end();
  await done;
  return Buffer.concat(out);
}

test('a deflate bomb is refused as too large, without inflating it, and the total across streams is capped too', async () => {
  // Half a gigabyte of zeros in under a megabyte of file. Inflating it whole would
  // take the memory with it; the ceiling stops it at the limit.
  const bomb = await deflatedZeros(512 * 1024 * 1024);
  assert.ok(bomb.length < 1024 * 1024, `${bomb.length} bytes`);
  const file = pdf([CATALOG, ONE_PAGE, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', HELVETICA,
    stream('/Filter /FlateDecode', bomb)]);
  const before = process.memoryUsage().rss;
  const started = Date.now();
  assert.deepEqual(pdfText(file), { readable: false, reason: 'too-large' });
  assert.ok(Date.now() - started < 10_000, 'it stops promptly');
  assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024, 'it never holds the inflated data');

  // Many small streams that together pass the total.
  const megabyte = deflateSync(Buffer.alloc(1024 * 1024, 0x20));
  const pages = Array.from({ length: 3 }, (_, i) => i);
  const many = pdf([
    CATALOG,
    `<< /Type /Pages /Kids [${pages.map((i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    HELVETICA,
    ...pages.flatMap(() => ['', '']).map((_, n) => (n % 2 === 0
      ? `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + n} 0 R >>`
      : stream('/Filter /FlateDecode', megabyte))),
  ]);
  assert.equal(pdfText(many).readable, true, 'within the default limits');
  assert.deepEqual(pdfText(many, { totalBytes: 2 * 1024 * 1024 }), { readable: false, reason: 'too-large' });
  assert.deepEqual(pdfText(many, { streamBytes: 512 * 1024 }), { readable: false, reason: 'too-large' });
});

test('a file with more objects than the limit is too large', () => {
  const objects = [CATALOG, ONE_PAGE, '<< /Type /Page /Parent 2 0 R >>', ...Array.from({ length: 50 }, () => 'null')];
  assert.equal(pdfText(pdf(objects)).readable, true);
  assert.deepEqual(pdfText(pdf(objects), { objects: 20 }), { readable: false, reason: 'too-large' });
});

// --- What a small file can make the reader do over and over --------------------------

/** A ToUnicode map of four ranges, each as wide as a range may be: a few lines that ask for hundreds of thousands of codes. */
const WIDE_CMAP = 'begincmap\n4 beginbfrange\n<0000> <FFFF> <0041>\n<010000> <01FFFF> <0041>\n<020000> <02FFFF> <0041>\n<030000> <03FFFF> <0041>\nendbfrange\nendcmap';

/** One page whose resources name `fonts` fonts, each with the ToUnicode map at the object `map(n)` gives. */
function manyFonts(fonts: number, maps: number): Buffer {
  // 1 catalog, 2 pages, 3 the page, 4 its content, then the maps, then the fonts.
  const fontObject = (n: number) => 5 + maps + n;
  return pdf([
    CATALOG, ONE_PAGE,
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${Array.from({ length: fonts }, (_, n) => `/F${n} ${fontObject(n)} 0 R`).join(' ')} >> >> >>`,
    stream('', 'BT /F0 12 Tf 72 700 Td (A) Tj ET'),
    ...Array.from({ length: maps }, () => flate('', WIDE_CMAP)),
    ...Array.from({ length: fonts }, (_, n) => `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${5 + (n % maps)} 0 R >>`),
  ]);
}

test('fonts that share a character map read it once, and maps past the file’s budget are too large, before they fill memory', () => {
  // Hundreds of fonts pointing at one wide map: built once, not once a font.
  let { read, ms, grew } = measured(manyFonts(300, 1));
  assert.equal(read.readable, true);
  assert.ok(ms < PROMPTLY && grew < 100 * MB, `${ms} ms, ${Math.round(grew / MB)} MB: one map in memory, not three hundred`);
  // Counted once too: a budget for less than two such maps is enough.
  assert.equal(pdfText(manyFonts(300, 1), { fontCodes: 300_000 }).readable, true);
  // As many maps, each its own: together they pass the budget for every font's map.
  ({ read, ms, grew } = measured(manyFonts(300, 300)));
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY && grew < 200 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);
  assert.deepEqual(pdfText(manyFonts(3, 1), { fontCodes: 1000 }), { readable: false, reason: 'too-large' });

  // A composite font's widths given as one range grow the same way, and count the same.
  const wide = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream('', 'BT /F1 12 Tf 72 700 Td <0041> Tj ET'),
    '<< /Type /Font /Subtype /Type0 /BaseFont /Wide /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Wide /W [0 65535 500] >>',
  ]);
  assert.equal(pdfText(wide).readable, true);
  assert.deepEqual(pdfText(wide, { fontCodes: 1000 }), { readable: false, reason: 'too-large' });
});

test('content drawn again and again counts each time it is drawn: a form drawn over and over, or pages sharing one stream', () => {
  const line = 'BT /F1 12 Tf 72 700 Td (Fair market value) Tj ET\n';
  const megabyte = line.repeat(Math.ceil(1024 * 1024 / line.length));
  // One page drawing the same one-megabyte form over and over, from a file of a few kilobytes.
  const formDrawn = (times: number) => pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >> >>',
    flate('', '/X Do\n'.repeat(times)),
    HELVETICA,
    flate('/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >>', megabyte),
  ]);
  const drawn = formDrawn(300);
  assert.ok(drawn.length < 20_000, `${drawn.length} bytes`);
  let { read, ms, grew } = measured(drawn);
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY && grew < 200 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);
  // Each draw counts against the bytes read, the text it makes aside: room for four
  // megabytes reads the form three times, and not five.
  const reading = { readBytes: 4 * MB, characters: Infinity, pageCharacters: Infinity };
  assert.equal(pdfText(formDrawn(3), reading).readable, true);
  assert.deepEqual(pdfText(formDrawn(5), reading), { readable: false, reason: 'too-large' });

  // Three hundred pages over one shared stream.
  const pages = 300;
  const shared = pdf([
    CATALOG,
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, n) => `${5 + n} 0 R`).join(' ')}] /Count ${pages} /Resources << /Font << /F1 3 0 R >> >> >>`,
    HELVETICA,
    flate('', megabyte),
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'),
  ]);
  ({ read, ms, grew } = measured(shared));
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY && grew < 200 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);

  // A tiny form drawn more times than the limit, and more text than the limit.
  const tiny = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >> >>',
    stream('', '/X Do\n'.repeat(100)),
    HELVETICA,
    stream('/Type /XObject /Subtype /Form /BBox [0 0 612 792]', 'BT /F1 12 Tf 72 700 Td (Fair market value) Tj ET'),
  ]);
  assert.equal(pdfText(tiny).readable, true);
  assert.deepEqual(pdfText(tiny, { forms: 50 }), { readable: false, reason: 'too-large' });
  assert.deepEqual(pdfText(tiny, { characters: 1000 }), { readable: false, reason: 'too-large' });
});

test('a page drawn all on one line reads in time that grows with its length, not with its square', () => {
  // Every piece of text at the same height, each a little further across: one
  // line of most of a megabyte, which once took the reader minutes.
  const draws = Array.from({ length: 30_000 }, (_, n) => `BT /F1 10 Tf ${72 + n * 0.01} 700 Td (The fair market value is $0.42) Tj ET`).join('\n');
  const file = pdf([CATALOG, ONE_PAGE, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', flate('', draws), HELVETICA]);
  const started = Date.now();
  const read = pdfText(file);
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
  assert.ok(read.readable);
  if (read.readable) assert.equal(read.pages[0].split('\n').length, 1);
});

test('what a file may inflate to grows with the file: a small one that inflates far is too large, the same text in a larger one is not', () => {
  // Ten megabytes of content in ten kilobytes of file: past the four a small file is allowed.
  const content = stream('/Filter /FlateDecode', deflateSync(Buffer.alloc(10 * MB, 0x20)));
  const page = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  const small = pdf([CATALOG, ONE_PAGE, page, HELVETICA, content]);
  assert.ok(small.length < 20_000, `${small.length} bytes`);
  const { read, ms } = measured(small);
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY, `${ms} ms`);
  // The same content in a file of a megabyte and a half, the rest an image that is
  // never inflated: eight times the file is room for it.
  const image = stream('/Type /XObject /Subtype /Image /Width 1536 /Height 1024 /BitsPerComponent 8 /ColorSpace /DeviceGray', Buffer.alloc(1.5 * MB));
  assert.deepEqual(pdfText(pdf([CATALOG, ONE_PAGE, page, HELVETICA, content, image])), { readable: true, pages: [''] });
  // And a caller can still allow more.
  assert.equal(pdfText(small, { totalBytes: 16 * MB, readBytes: 16 * MB }).readable, true);
});

test('a table many fonts share is built and counted once: widths, glyph names, and the fonts many pages’ resources share', () => {
  const fonts = 2000;
  const names = (first: number) => Array.from({ length: fonts }, (_, n) => `/F${n} ${first + n} 0 R`).join(' ');
  // Two thousand composite fonts whose widths are one /W array of a hundred thousand codes, by reference.
  const cid = pdf([
    CATALOG, ONE_PAGE,
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${names(7)} >> >> >>`,
    stream('', 'BT /F0 12 Tf 72 700 Td <0041> Tj ET'),
    '[0 65535 500 70000 105535 600]',
    '<< /Type /Font /Subtype /CIDFontType2 /W 5 0 R >>',
    ...Array.from({ length: fonts }, () => '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [6 0 R] >>'),
  ]);
  let { read, ms, grew } = measured(cid, { fontCodes: 150_000 });
  assert.equal(read.readable, true, 'counted once, the widths fit a budget a tenth of what two thousand copies would take');
  assert.ok(ms < PROMPTLY && grew < 100 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);

  // Two thousand simple fonts sharing one /Widths array and one /Differences of sixty thousand entries each.
  const simple = pdf([
    CATALOG, ONE_PAGE,
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${names(7)} >> >> >>`,
    stream('', 'BT /F0 12 Tf 72 700 Td (A) Tj ET'),
    `[${'500 '.repeat(60_000)}]`,
    `<< /Type /Encoding /Differences [0 ${'/a '.repeat(60_000)}] >>`,
    ...Array.from({ length: fonts }, () => '<< /Type /Font /Subtype /Type1 /FirstChar 0 /Widths 5 0 R /Encoding 6 0 R >>'),
  ]);
  ({ read, ms, grew } = measured(simple, { fontCodes: 150_000 }));
  assert.deepEqual(read, { readable: true, pages: ['a'] });
  assert.ok(ms < PROMPTLY && grew < 100 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);

  // Five thousand pages, each with resources of its own naming one font dictionary of two thousand fonts.
  const pages = 5000;
  const shared = pdf([
    CATALOG,
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, n) => `${6 + n} 0 R`).join(' ')}] /Count ${pages} >>`,
    stream('', 'BT /F0 12 Tf 72 700 Td (A) Tj ET'),
    `<< ${Array.from({ length: fonts }, (_, n) => `/F${n} 5 0 R`).join(' ')} >>`,
    HELVETICA,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /Contents 3 0 R /Resources << /Font 4 0 R >> >>'),
  ]);
  ({ read, ms, grew } = measured(shared));
  assert.ok(read.readable && read.pages.length === pages && read.pages.every((p) => p === 'A'));
  assert.ok(ms < PROMPTLY && grew < 100 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);

  // One map that gives the same wide range over and over counts each time it gives it.
  const repeated = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream('', 'BT /F1 12 Tf 72 700 Td (A) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /ToUnicode 6 0 R >>',
    flate('', `begincmap\n100000 beginbfrange\n${'<0000> <FFFF> <0041>\n'.repeat(100_000)}endbfrange\nendcmap`),
  ]);
  assert.ok(repeated.length < 20_000, `${repeated.length} bytes`);
  ({ read, ms, grew } = measured(repeated));
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY && grew < 200 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);
});

test('content listed again and again counts before it is copied: a page listing one stream a thousand times, pages sharing a list of nothing', () => {
  const line = 'BT /F1 12 Tf 72 700 Td (Fair market value) Tj ET\n';
  const megabyte = line.repeat(Math.ceil(MB / line.length));
  const listed = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `[${'6 0 R '.repeat(1000)}]`,
    HELVETICA,
    flate('', megabyte),
  ]);
  let { read, ms, grew } = measured(listed);
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY && grew < 100 * MB, `${ms} ms, ${Math.round(grew / MB)} MB: the gigabyte the list asks for is never put together`);

  // Twenty thousand pages, each listing the same hundred thousand references to objects that do not exist.
  const pages = 20_000;
  const nothing = pdf([
    CATALOG,
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, n) => `${4 + n} 0 R`).join(' ')}] >>`,
    `[${'999999 0 R '.repeat(100_000)}]`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>'),
  ]);
  ({ read, ms } = measured(nothing));
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY, `${ms} ms`);
});

test('a file built to be read over and over is read in time that grows with the file: shared values, open trailers, deep nesting', () => {
  // An object stream whose header points a thousand objects at one array of a megabyte.
  const header = `${Array.from({ length: 1000 }, (_, n) => `${1000 + n} 0`).join(' ')} `;
  const objects = pdf([CATALOG, ONE_PAGE, '<< /Type /Page /Parent 2 0 R >>',
    flate(`/Type /ObjStm /N 1000 /First ${header.length}`, `${header}[${'1 '.repeat(MB / 2)}]`)]);
  let { read, ms } = measured(objects, { readBytes: 2 * MB });
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY, `${ms} ms`);

  // A form drawn forty thousand times whose /Matrix is a list of a million numbers.
  const matrix = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>',
    flate('', '/X Do\n'.repeat(40_000)),
    stream('/Type /XObject /Subtype /Form /Matrix 6 0 R', ''),
    `[${'1 '.repeat(1_000_000)}]`,
  ]);
  ({ read, ms } = measured(matrix));
  assert.deepEqual(read, { readable: true, pages: [''] });
  assert.ok(ms < PROMPTLY, `${ms} ms`);

  // Thirty thousand page-tree nodes that all share one list of kids naming every one of them.
  const nodes = 30_000;
  const kids = pdf([CATALOG, '<< /Type /Pages /Kids 3 0 R >>', `[${Array.from({ length: nodes }, (_, n) => `${4 + n} 0 R`).join(' ')}]`,
    ...Array.from({ length: nodes }, () => '<< /Type /Pages /Kids 3 0 R >>')]);
  ({ read, ms } = measured(kids));
  assert.deepEqual(read, { readable: false, reason: 'unreadable' });
  assert.ok(ms < PROMPTLY, `${ms} ms`);

  // A trailer left open, three hundred thousand times; then objects nested inside one another past the limit.
  ({ read, ms } = measured(Buffer.from(`%PDF-1.7\n${'trailer<<'.repeat(300_000)}`)));
  assert.deepEqual(read, { readable: false, reason: 'unreadable' });
  assert.ok(ms < PROMPTLY, `${ms} ms`);
  const nested = Buffer.from(`%PDF-1.7\n${Array.from({ length: 60 }, (_, k) => `${k + 1} 0 obj [ `).join('')}${'1 '.repeat(500_000)}${'['.repeat(80)}`, 'latin1');
  ({ read, ms } = measured(nested));
  assert.deepEqual(read, { readable: false, reason: 'unreadable' });
  assert.ok(ms < PROMPTLY, `${ms} ms`);
});

test('a page that comes to more text than a page holds is too large, however few the bytes that draw it', () => {
  // One code that stands for ten thousand characters, drawn a hundred thousand times: a billion characters asked for.
  const long = '0041'.repeat(10_000);
  const file = pdf([
    CATALOG, ONE_PAGE,
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    flate('', `BT /F1 12 Tf 72 700 Td <${'01'.repeat(100_000)}> Tj ET`),
    '<< /Type /Font /Subtype /Type1 /ToUnicode 6 0 R >>',
    flate('', `begincmap\n1 beginbfchar\n<01> <${long}>\nendbfchar\nendcmap`),
  ]);
  const { read, ms, grew } = measured(file);
  assert.deepEqual(read, { readable: false, reason: 'too-large' });
  assert.ok(ms < PROMPTLY && grew < 100 * MB, `${ms} ms, ${Math.round(grew / MB)} MB`);

  // The limit is a page's: the same text over pages of their own reads, until the whole file's limit.
  const page = 'BT /F1 12 Tf 72 700 Td (The fair market value is $0.42) Tj ET\n'.repeat(1000);
  const two = pdf([
    CATALOG, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    HELVETICA, stream('', page),
  ]);
  assert.equal(pdfText(two, { pageCharacters: 40_000 }).readable, true);
  assert.deepEqual(pdfText(two, { pageCharacters: 20_000 }), { readable: false, reason: 'too-large' });
  assert.deepEqual(pdfText(two, { pageCharacters: 40_000, characters: 40_000 }), { readable: false, reason: 'too-large' });
});
