/**
 * Certificates as PDF: the framed landscape face with the number, amount,
 * company name, watermark, certifying text and signature blocks, the legends
 * and signature record flowing over the pages after it, and a book of several
 * documents in one file. Pure rendering; no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { certificatePdf, certificateBookPdf } = await import('../src/pdf-writer.ts');
const { stockFace, awardFace, convertibleFace } = await import('../src/certificate-face.ts');
const { config } = await import('../src/config.ts');
type Input = Parameters<typeof certificatePdf>[0];

const company = { legalName: 'Marlowe Systems, Inc.', jurisdiction: 'Delaware', entityType: 'C_CORP' };
const signer = { signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer' };
const legend = 'THE SECURITIES REFERENCED HEREIN HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT OF 1933, AS AMENDED.';

function stock(holderName = 'Priya Raman', back = legend) {
  return stockFace({ ...company, ...signer, certificateNo: 'CS-2', holderName, quantity: 1_000_000, className: 'Common', parValue: 10, issueDate: '2023-04-11', back });
}

function input(face: Input['face'], extra: Partial<Input> = {}): Input {
  return {
    face,
    signatures: [
      { role: 'COMPANY', name: 'Avery Stone', signed: true, typed: 'Avery Stone', when: '2026-09-22T12:16:00.000Z', ip: '203.0.113.7' },
      { role: 'HOLDER', name: face.signers[1].name, signed: false },
    ],
    executed: false,
    footer: 'Document doc_cs2 · generated 2026-10-04',
    frameColor: '#0f6b4f',
    ...extra,
  };
}

const pageCount = (pdf: string): number => Number(pdf.match(/\/Count (\d+)/)![1]);
/** Every content stream, in page order. */
const streams = (pdf: string): string[] => [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
/** The baselines of every text object: [x, y]. */
const positions = (stream: string): [number, number][] => [...stream.matchAll(/(-?[\d.]+) (-?[\d.]+) Td/g)].map((m) => [Number(m[1]), Number(m[2])]);

test('the face is a framed landscape page set in Times with the certificate’s number, amount, name, watermark and text', () => {
  const pdf = certificatePdf(input(stock())).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  assert.match(pdf, /\/MediaBox \[0 0 792 612\]/);
  for (const font of ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic']) assert.ok(pdf.includes(`/BaseFont /${font} /Encoding /WinAnsiEncoding`), font);
  assert.match(pdf, /\/Title \(Marlowe Systems, Inc\. \\267 ID: CS-2\)/);

  const [face] = streams(pdf);
  // The frame, stroked in the frame colour, 15pt in from every edge.
  assert.match(face, /0\.059 0\.42 0\.31 RG 0\.6 w 15 15 762 582 re S/);
  // The watermark is drawn first, in a pale tint of the frame colour, before any dark text.
  const watermark = face.indexOf('(CERTIFICATE)');
  assert.ok(watermark > 0 && face.indexOf('(OF STOCK)') > watermark);
  assert.match(face, /0\.887 0\.93 0\.917 rg BT \/F4 75 Tf [\d.]+ 311 Td \(CERTIFICATE\)/);
  assert.ok(watermark < face.indexOf('(Marlowe Systems, Inc.)'));
  assert.match(face, /0\.6 g BT \/F4 12 Tf 79 551 Td \(ID: CS-2\) Tj/);
  assert.match(face, /0\.6 g BT \/F4 12 Tf [\d.]+ 551 Td \(1,000,000 Shares\) Tj/);
  assert.match(face, /0\.24 g BT \/F5 38 Tf [\d.]+ 470 Td \(Marlowe Systems, Inc\.\) Tj/);
  // The certifying text is justified rich text with the holder, number, class and state in bold.
  assert.match(face, /\/F5 10 Tf \(Priya Raman\) Tj/);
  assert.match(face, /\/F5 10 Tf \(1,000,000\) Tj/);
  assert.match(face, /\/F5 10 Tf \(Common Stock\) Tj/);
  assert.match(face, /\/F5 10 Tf \(Delaware\) Tj/);
  assert.match(face, /BT [\d.]+ Tw 79 415 Td \/F4 10 Tf \(This certifies that \) Tj/);
  assert.match(face, /\(Dated: April 11, 2023\)/);
  assert.match(face, /\(Page 1 of 2\)/);
  assert.ok(face.includes('(Document doc_cs2 \\267 generated 2026-10-04)'));
  // Everything sits inside the frame.
  for (const [x, y] of positions(face)) assert.ok(x > 15 && x < 777 && y > 15 && y < 597, `text at ${x}, ${y}`);
});

test('a signed block carries the typed signature on its line; an unsigned one is awaiting signature', () => {
  const pdf = certificatePdf(input(stock())).toString('latin1');
  const [face, back] = streams(pdf);
  assert.match(face, /0\.6 G 0\.5 w 79 118 m 349 118 l S/, 'company signature line');
  assert.match(face, /0\.6 G 0\.5 w 443 118 m 713 118 l S/, 'holder signature line');
  assert.match(face, /BT \/F7 16 Tf 83 126 Td \(Avery Stone\) Tj/, 'the typed signature in Times-BoldItalic on the line');
  assert.match(face, /BT \/F6 8\.5 Tf 443 123 Td \(Awaiting signature\) Tj/);
  assert.match(face, /BT \/F5 12 Tf 79 98 Td \(Avery Stone\) Tj/);
  assert.match(face, /BT \/F6 12 Tf 79 80 Td \(Chief Executive Officer\) Tj/);
  assert.match(face, /BT \/F6 12 Tf 443 80 Td \(Stockholder\) Tj/);
  assert.equal((face.match(/\/F7 /g) ?? []).length, 1, 'only the signed block shows a signature');

  // The pages after the face: the legends, then the signature record.
  assert.match(back, /\(Legends and terms\)/);
  assert.match(back, /BT \/F4 11 Tf 79 [\d.]+ Td \(THE SECURITIES REFERENCED HEREIN /, 'the legend, in 11pt Times');
  assert.match(back, /\(Electronic signatures\)/);
  assert.ok(back.includes('(Signed as \\223Avery Stone\\224 on 2026-09-22 12:16 UTC from 203.0.113.7)'));
  assert.ok(back.includes('(Not yet signed)'));
  assert.ok(!back.includes('Fully executed'), 'not executed yet');

  const signed = certificatePdf(input(stock(), {
    executed: true,
    signatures: [
      { role: 'COMPANY', name: 'Avery Stone', signed: true, typed: 'Avery Stone', when: '2026-09-22 12:16 UTC', ip: null },
      { role: 'HOLDER', name: 'Priya Raman', signed: true, typed: 'P. Raman', when: '2026-09-23T08:02:00.000Z', ip: '198.51.100.4' },
    ],
  })).toString('latin1');
  const [signedFace, signedBack] = streams(signed);
  assert.match(signedFace, /BT \/F7 16 Tf 447 126 Td \(P\. Raman\) Tj/);
  assert.ok(!signedFace.includes('Awaiting signature'));
  assert.ok(signedBack.includes('(Signed as \\223Avery Stone\\224 on 2026-09-22 12:16 UTC)'), 'a time already in UTC is not marked twice');
  assert.ok(signedBack.includes('(Signed as \\223P. Raman\\224 on 2026-09-23 08:02 UTC from 198.51.100.4)'));
  assert.ok(signedBack.includes(`(Fully executed electronically on the ${config().brand.productName} platform.)`));
});

test('long legends and terms flow over several framed pages, each numbered', () => {
  const paragraph = 'THE SHARES ARE SUBJECT TO A REPURCHASE OPTION IN FAVOR OF THE COMPANY AND TO FORFEITURE UNDER THE VESTING TERMS OF THAT AGREEMENT. ';
  const back = Array.from({ length: 30 }, (_, i) => `${i + 1}. ${paragraph.repeat(3)}`).join('\n\n');
  const pdf = certificatePdf(input(stock('Priya Raman', back))).toString('latin1');
  const pages = pageCount(pdf);
  assert.ok(pages >= 4, `expected several pages, got ${pages}`);
  const all = streams(pdf);
  assert.equal(all.length, pages);
  all.forEach((s, i) => {
    assert.ok(s.includes(`(Page ${i + 1} of ${pages})`), `page ${i + 1} is numbered`);
    assert.match(s, / 15 15 762 582 re S/, `page ${i + 1} is framed`);
    for (const [x, y] of positions(s)) assert.ok(x >= 79 - 4 && x <= 713 && y >= 27 && y <= 551, `page ${i + 1}: text at ${x}, ${y}`);
  });
  assert.ok(pdf.includes('(30. THE SHARES'), 'the last paragraph is present');
  assert.ok(all[pages - 1].includes('(Electronic signatures)'), 'the signature record closes the document');
});

test('the face shrinks its text to keep clear of the date and signatures, and long names still fit', () => {
  const long = 'Halcyon Ventures Opportunity Fund III, L.P., acting by its general partner Halcyon Ventures Opportunity Management III, L.L.C.';
  const face = stock(long);
  face.heading = 'Tidewater Laboratories for Applied Oceanographic Research and Coastal Engineering, Inc.';
  face.paragraphs = [...face.paragraphs, ...face.paragraphs];
  const [first] = streams(certificatePdf(input(face)).toString('latin1'));
  const body = [...first.matchAll(/BT [\d.]+ Tw ([\d.]+) ([\d.]+) Td \/F\d ([\d.]+) Tf/g)];
  assert.ok(body.length > 8);
  assert.ok(Number(body[0][3]) < 10, `the body shrank from 10pt to ${body[0][3]}pt`);
  for (const m of body) assert.ok(Number(m[2]) >= 245, `body line at ${m[2]} runs into the date`);
  // The company name wraps onto two centred lines rather than shrinking to nothing.
  const heading = [...first.matchAll(/0\.24 g BT \/F5 ([\d.]+) Tf [\d.]+ ([\d.]+) Td/g)];
  assert.equal(heading.length, 2);
  assert.ok(Number(heading[0][1]) >= 20);
  // The holder's long name takes two lines in its block, with the title under them.
  assert.match(first, /BT \/F5 10 Tf 443 98 Td \(Halcyon Ventures/);
  assert.match(first, /BT \/F5 10 Tf 443 86\.5 Td \(/);
  assert.match(first, /BT \/F6 12 Tf 443 70 Td \(Stockholder\) Tj/);
});

test('names with parentheses, backslashes and accents are escaped and encoded, and odd spaces print as spaces', () => {
  const face = stock('Zoé Œuvre (Trustee) \\ Raman–Stone Trust');
  face.idLabel = 'ID: CS-9';
  face.amountLabel = '1 000 Shares';
  const pdf = certificatePdf(input(face, { signatures: [{ role: 'HOLDER', name: face.signers[1].name, signed: true, typed: 'Zoé Œuvre (Trustee)' }] })).toString('latin1');
  assert.ok(pdf.includes('(Zo\\351 \\214uvre \\(Trustee\\) \\\\ Raman\\226Stone Trust)'), 'the holder block, escaped and WinAnsi-encoded');
  assert.match(pdf, /\/F7 16 Tf 447 126 Td \(Zo\\351 \\214uvre \\\(Trustee\\\)\) Tj/, 'the typed signature, escaped');
  assert.ok(pdf.includes('(ID: CS-9)'));
  assert.ok(pdf.includes('(1 000 Shares)'));
  assert.ok(!/\(Zo\? /.test(pdf), 'é is not replaced');
  // Every string literal is balanced: no raw parenthesis escapes the escaping.
  for (const s of streams(pdf)) {
    const unescaped = s.replace(/\\[\\()]/g, '').replace(/\\\d{3}/g, '');
    let depth = 0;
    for (const ch of unescaped) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      assert.ok(depth >= 0 && depth <= 1);
    }
    assert.equal(depth, 0);
  }
});

test('a certificate book holds every document, each on its own pages with its own numbering', () => {
  const option = awardFace({ ...company, ...signer, label: 'OPT-7', type: 'ISO', typeName: 'Incentive stock option', holderName: 'Theo Lindqvist', quantity: 48_000,
    strikePrice: 1_250_000, className: 'Common', planName: '2021 Equity Incentive Plan', grantDate: '2024-06-01', vestingSchedule: '4 years, 1 year cliff',
    vestingStart: '2024-06-01', expirationDate: '2034-05-31', back: 'OPTION AGREEMENT\n\nThe option vests monthly.' });
  const safe = convertibleFace({ ...company, ...signer, label: 'SAFE-3', instrument: 'SAFE_POST', instrumentName: 'Post-money SAFE', holderName: 'Halcyon Ventures',
    principal: 25_000_000, issueDate: '2025-02-10', valuationCap: 1_200_000_000, discount: 0, interestRate: 0, compoundingWords: '', maturityDate: null, back: 'The SAFE terms.' });
  const docs = [input(stock('Priya Raman', Array.from({ length: 40 }, () => legend).join('\n\n'))), input(option), input(safe, { executed: true })];
  const singles = docs.map((d) => pageCount(certificatePdf(d).toString('latin1')));
  const book = certificateBookPdf(docs).toString('latin1');
  assert.equal(pageCount(book), singles.reduce((s, n) => s + n, 0));
  assert.equal((book.match(/\(Page 1 of \d+\)/g) ?? []).length, 3, 'each document starts its own numbering');
  assert.ok(book.includes('(STOCK)') && book.includes('(OPTION)') && book.includes('(SIMPLE AGREEMENT)'));
  // Each document starts on a new page: its face is the first stream after the previous document's pages.
  const all = streams(book);
  assert.ok(all[0].includes('(ID: CS-2)'));
  assert.ok(all[singles[0]].includes('(ID: OPT-7)'));
  assert.ok(all[singles[0] + singles[1]].includes('(ID: SAFE-3)'));
  // Object offsets in the cross-reference table all land on their objects.
  const offsets = [...book.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.match(book.slice(o, o + 12), new RegExp(`^${i + 1} 0 obj`)));
  assert.throws(() => certificateBookPdf([]));
});
