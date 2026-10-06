/**
 * Reading a 409A report's values from its text.
 *
 * Pinned here: the fair market value, the valuation date and the method come out
 * of the ways appraisers actually write them, in sentences and in tables; a
 * preferred price, an enterprise or equity value, an earlier valuation or a date
 * in the future never wins; a reading is only "high" when the report says it in
 * so many words; and a report that says none of it gives nothing rather than a
 * guess. The text of every report here is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectReport, nothingDetected } = await import('../src/report-detect.ts');
const { pdfText } = await import('../src/pdf-text.ts');
const { documentPdf } = await import('../src/pdf-writer.ts');

/** The day every date below is judged against. */
const AS_OF = '2026-10-05';
const read = (...pages: string[]) => detectReport(pages, { asOf: AS_OF });
const fmv = (...pages: string[]) => read(...pages).fairMarketValue;

test('the fair market value comes out of the ways reports state it, in micro-cents, with how sure the reading is', () => {
  const cases: [string, number, string][] = [
    ['Based on our analysis, we concluded that the fair market value of the common stock is $0.42 per share on a non-marketable, minority basis.', 420_000, 'high'],
    ['The Fair Market Value per Share of Common Stock as of the Valuation Date is $1.07.', 1_070_000, 'high'],
    ['Concluded FMV per common share: US$0.89', 890_000, 'high'],
    ['Conclusion of value\nFair market value per common share (non-marketable, minority) $ 0.315', 315_000, 'high'],
    ['Our concluded value is USD 2.10 per common share.', 2_100_000, 'high'],
    // A sentence broken across two lines, as a PDF's text often is.
    ['In our opinion, the fair market value of the Company’s common\nstock, on a non-marketable minority interest basis, was $0.58 per\nshare as of the valuation date.', 580_000, 'high'],
    // Near the right words, without saying it all: offered, with a warning.
    ['Indicated value per share $0.66', 660_000, 'low'],
    ['Common stock value (per share) .......... $0.75', 750_000, 'medium'],
  ];
  for (const [text, value, confidence] of cases) {
    const found = fmv(text);
    assert.ok(found, text);
    assert.equal(found.value, value, text);
    assert.equal(found.confidence, confidence, text);
    assert.equal(found.page, 1);
    assert.ok(found.context.includes(found.text), `${found.context} carries ${found.text}`);
  }
});

test('in a table, the preferred price on the row above does not win, and neither does the enterprise value in millions', () => {
  const table = [
    'Summary of the valuation',
    'Enterprise value $48.2 million',
    'Equity value $51,300,000',
    'Series A Preferred original issue price per share $1.50',
    'Series Seed Preferred price per share $0.80',
    'Fair market value per common share $0.42',
    'Discount for lack of marketability 30%',
  ].join('\n');
  const found = read(table);
  assert.equal(found.fairMarketValue?.value, 420_000);
  assert.equal(found.fairMarketValue?.confidence, 'high');
  assert.deepEqual(found.candidates.fairMarketValue.map((c) => c.value), [420_000], 'nothing else is offered');
});

test('the sentence before, about the preferred stock, does not count against the value in the next one', () => {
  const found = fmv('We calibrated the model to the Series A. The fair market value of the common stock is $0.42 per share.');
  assert.equal(found?.value, 420_000);
  assert.equal(found?.confidence, 'high');
});

test('a sentence that names the preferred price after the common one keeps them apart', () => {
  const found = read('The fair market value of the common stock is $0.42 per share, while the Series A Preferred was sold at $1.50 per share in the financing.');
  assert.equal(found.fairMarketValue?.value, 420_000);
  assert.equal(found.fairMarketValue?.confidence, 'high');
  assert.ok(!found.candidates.fairMarketValue.some((c) => c.value === 1_500_000));
});

test('money that is not a share’s value is never read as one: rounds, caps, salaries, earlier valuations', () => {
  const text = [
    'The Company raised $15,000,000 in its Series A at a post-money valuation of $60,000,000.',
    'Revenue for the year was $4.2 million and cash on hand $9,850,000.',
    'Outstanding SAFEs carry a valuation cap of $20 million.',
    'The founders are paid a salary of $90,000.',
  ].join('\n');
  assert.equal(fmv(text), null);
  // The last valuation, mentioned for comparison, is at best a weak reading, and the new one beats it.
  const both = read('The prior 409A valuation concluded $0.25 per share.\nWe concluded the fair market value per share of common stock is $0.31.');
  assert.equal(both.fairMarketValue?.value, 310_000);
  assert.ok(both.candidates.fairMarketValue.findIndex((c) => c.value === 250_000) !== 0);
});

test('a sentence the PDF wrapped after a year or a company’s "Inc." keeps its words, and beats a marketable price on the row above', () => {
  const marketable = 'Value per share of common stock (marketable basis) $0.60';
  for (const conclusion of [
    'Based on our analysis, the fair market value of the common stock as of June 30, 2026\nwas $0.42 per share on a non-marketable, minority basis.',
    'Based on our analysis, the fair market value of the common stock of Marlowe Systems, Inc.\nwas $0.42 per share on a non-marketable, minority basis.',
  ]) {
    assert.equal(fmv(conclusion)?.confidence, 'high', conclusion);
    const found = read(`${marketable}\n${conclusion}`);
    assert.equal(found.fairMarketValue?.value, 420_000, conclusion);
    assert.equal(found.fairMarketValue?.confidence, 'high', conclusion);
    assert.equal(read(marketable, conclusion).fairMarketValue?.value, 420_000, 'with the row on an earlier page');
  }
  // A row of a table that ends in a year is still another row when the next starts one of its own.
  const table = read('Series A Preferred issued in 2025\nFair market value per common share $0.42');
  assert.equal(table.fairMarketValue?.confidence, 'high');
});

test('in a change of value, the later amount is the value now, and a list of prices goes with its classes in order', () => {
  const change = read('The fair market value of the common stock increased from $0.25 per share to $0.42 per share.');
  assert.equal(change.fairMarketValue?.value, 420_000);
  assert.equal(change.fairMarketValue?.confidence, 'high');
  assert.ok(change.candidates.fairMarketValue.every((c) => c.value !== 250_000 || c.confidence === 'low'), 'the earlier value is only ever a weak reading');
  assert.equal(fmv('The fair market value of the common stock rose to $0.42 per share from $0.25 per share.')?.value, 420_000);

  const respectively = read('The fair market value per share of the Series A Preferred Stock and the Common Stock is $1.62 and $0.42, respectively.');
  assert.equal(respectively.fairMarketValue?.value, 420_000);
  assert.equal(respectively.fairMarketValue?.confidence, 'medium', 'two prices in one clause are never read with full confidence');
  assert.ok(!respectively.candidates.fairMarketValue.some((c) => c.value === 1_620_000), 'the preferred price is not offered');
  const reversed = read('The fair market values of the Common Stock and the Series Seed Preferred Stock are $0.42 per share and $0.95 per share, respectively.');
  assert.equal(reversed.fairMarketValue?.value, 420_000);
});

test('a value stated in the summary and again in the body ranks first, and the candidates list each value once, best first', () => {
  const pages = [
    'Executive summary\nWe concluded that the fair market value per share of common stock is $0.42.',
    'Indicated value per share $0.39 under the market approach.\nConclusion\nFair market value per common share $0.42',
  ];
  const found = read(...pages);
  assert.equal(found.fairMarketValue?.value, 420_000);
  assert.equal(found.fairMarketValue?.page, 1);
  assert.deepEqual(found.candidates.fairMarketValue.map((c) => c.value), [420_000, 390_000]);
  assert.ok(found.candidates.fairMarketValue.length <= 5);
});

test('the valuation date comes from its label, in any common form, and an explicit "Valuation Date:" is preferred', () => {
  const cases: [string, string, string][] = [
    ['Valuation Date: June 30, 2026', '2026-06-30', 'high'],
    ['VALUATION DATE\nJun. 30, 2026', '2026-06-30', 'high'],
    ['Date of valuation: 30 June 2026', '2026-06-30', 'high'],
    ['Effective date: 06/30/2026', '2026-06-30', 'medium'],
    ['The valuation date for this analysis is 2026-06-30.', '2026-06-30', 'medium'],
    ['We valued the common stock as of September 1st, 2026.', '2026-09-01', 'low'],
    ['Measurement date: 31/07/2026', '2026-07-31', 'medium'],
  ];
  for (const [text, value, confidence] of cases) {
    const found = read(text).valuationDate;
    assert.equal(found?.value, value, text);
    assert.equal(found?.confidence, confidence, text);
  }
  const both = read('Report date: July 15, 2026\nBalance sheet as of August 31, 2026\nValuation Date: June 30, 2026');
  assert.equal(both.valuationDate?.value, '2026-06-30', 'the labelled date, not the report’s own date or another "as of"');
  assert.equal(both.valuationDate?.confidence, 'high');
});

test('a date in the future, one more than eighteen months back, or one that does not exist is never the valuation date', () => {
  assert.equal(read('Valuation Date: December 31, 2026').valuationDate, null, 'after today');
  assert.equal(read('Valuation Date: March 31, 2025').valuationDate, null, 'more than eighteen months old');
  assert.equal(read('Valuation Date: June 31, 2026').valuationDate, null, 'no such day');
  assert.equal(read('Valuation Date: April 6, 2025').valuationDate?.value, '2025-04-06', 'just inside eighteen months');
  // A date with no label is not taken for the valuation date.
  assert.equal(read('This report was prepared on July 15, 2026.').valuationDate, null);
  // The default day is today, so a date written today is never in the future.
  assert.equal(detectReport([`Valuation Date: ${new Date().toISOString().slice(0, 10)}`]).valuationDate?.confidence, 'high');
});

test('the method is the one the report relied on, the most specific when several are named', () => {
  const cases: [string, string][] = [
    ['We relied on the OPM backsolve method, calibrated to the Series A financing.', 'OPM backsolve'],
    ['The equity value was allocated using the option pricing method (OPM).', 'Option pricing method'],
    ['We applied the probability-weighted expected return method (PWERM) to allocate value.', 'PWERM'],
    ['We considered the income approach and the market approach but did not rely on them. We used a hybrid method combining the PWERM and the OPM.', 'Hybrid'],
    ['Given the early stage of the Company, we relied on the current value method.', 'Current value method'],
    ['We selected the income approach, using a discounted cash flow analysis.', 'Income approach (DCF)'],
    ['We used the market approach, with guideline public companies.', 'Market approach'],
  ];
  for (const [text, value] of cases) assert.equal(read(text).method?.value, value, text);
  const relied = read('We relied on the OPM backsolve method.').method!;
  assert.equal(relied.text, 'backsolve');
  assert.match(relied.context, /relied on the OPM backsolve method/);
  assert.equal(read('The OPM backsolve is mentioned once, in passing').method?.confidence, 'low');
});

test('a method only described, in a glossary or an account of the methods, does not outweigh the one the report relied on', () => {
  // The word "weighted" in the PWERM's own name is not a sign of reliance.
  const described = read('Appendix B describes the probability-weighted expected return method.').method;
  assert.equal(described?.value, 'PWERM');
  assert.equal(described?.confidence, 'low');

  const glossary = read('PWERM: the probability-weighted expected return method.\nOPM: the option pricing method.', 'We relied on the OPM backsolve method.').method;
  assert.equal(glossary?.value, 'OPM backsolve');
  assert.equal(glossary?.confidence, 'high');

  const practiceAid = read(
    'The AICPA Practice Aid describes the methods used to allocate equity value: the current value method (CVM), the option pricing method (OPM) '
    + 'and the probability-weighted expected return method (PWERM). Each method applies in different circumstances, and a PWERM is used when exits can be foreseen.',
    'Given the Series A financing in March, we relied on the OPM backsolve.',
  ).method;
  assert.equal(practiceAid?.value, 'OPM backsolve');
  assert.equal(practiceAid?.confidence, 'high');
});

test('the work is bounded by the length of the text: a page of nothing but amounts on one line reads promptly', () => {
  for (const page of ['$1 '.repeat(1_000_000), `${'Value per share $0.42 '.repeat(150_000)}`, 'Valuation Date: June 30, 2026 '.repeat(100_000)]) {
    const started = Date.now();
    read(page);
    assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms for ${page.slice(0, 30)}…`);
  }
});

test('pages stuffed with figures, dates and a method’s name read promptly, and do not crowd out the page that states the conclusion', () => {
  const pages = [
    '$1.50 '.repeat(700_000),
    '1/1/2025 '.repeat(450_000),
    'backsolve '.repeat(400_000),
    'Valuation Date: June 30, 2026\nWe concluded that the fair market value per share of common stock is $0.42.\nWe relied on the OPM backsolve, calibrated to the Series A financing.',
  ];
  const started = performance.now();
  const found = read(...pages);
  const ms = Math.round(performance.now() - started);
  assert.ok(ms < 1_000, `${ms} ms`);
  // Each stuffed page has more of its kind than the whole report is allowed, so
  // only a limit on each page leaves room for the last one.
  assert.equal(found.fairMarketValue?.value, 420_000);
  assert.equal(found.fairMarketValue?.page, 4);
  assert.equal(found.valuationDate?.value, '2026-06-30');
  assert.equal(found.method?.value, 'OPM backsolve');
});

test('a report that states none of it gives nothing, and a report with no text says it could not be read', () => {
  const found = read('Thank you for the opportunity to work with the Company.\nPlease contact us with any questions.');
  assert.deepEqual(found, { ...nothingDetected(true), readable: true });
  assert.deepEqual(read('', '  \n '), nothingDetected(false));
  assert.deepEqual(detectReport([]), nothingDetected(false));
});

test('the same pages and the same day always give the same answer', () => {
  const pages = ['Valuation Date: June 30, 2026\nThe fair market value per share of common stock is $0.42. We relied on the OPM backsolve.'];
  assert.deepEqual(detectReport(pages, { asOf: AS_OF }), detectReport(pages, { asOf: AS_OF }));
});

test('read end to end from a PDF the app writes, every value comes out with its page and the words around it', () => {
  const file = documentPdf({
    company: 'Marlowe Systems, Inc.',
    title: 'Valuation of the common stock of Marlowe Systems, Inc.',
    body: [
      'Valuation Date: June 30, 2026',
      '',
      'Ledgerline Valuations was engaged to estimate the fair market value of the common stock for Section 409A purposes.',
      'The Series A Preferred was issued at $1.50 per share in March 2026.',
      '',
      'Based on our analysis, we concluded that the fair market value of the common stock is $0.42 per share on a non-marketable, minority basis.',
      'We relied on the OPM backsolve method, calibrated to the Series A financing.',
    ].join('\n'),
    signatures: [],
    footer: 'Prepared by Ledgerline Valuations',
  });
  const text = pdfText(file);
  assert.ok(text.readable);
  if (!text.readable) return;
  const found = detectReport(text.pages, { asOf: AS_OF });
  assert.equal(found.fairMarketValue?.value, 420_000);
  assert.equal(found.fairMarketValue?.text, '$0.42');
  assert.match(found.fairMarketValue!.context, /fair market value of the common stock is \$0\.42 per share/);
  assert.equal(found.valuationDate?.value, '2026-06-30');
  assert.equal(found.method?.value, 'OPM backsolve');
  assert.ok(found.fairMarketValue!.context.length <= 200, found.fairMarketValue!.context);
});
