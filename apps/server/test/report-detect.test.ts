/**
 * Reading a 409A report's values from its text.
 *
 * Pinned here: the fair market value, the valuation date and the method come out
 * of the ways appraisers actually write them, in sentences and in tables; a
 * preferred price, an enterprise or equity value, an earlier valuation or a date
 * in the future never wins; a reading is only "high" when the report says it in
 * so many words; and a report that says none of it gives nothing rather than a
 * guess. For the company's own import, the firm that prepared the report and the
 * company's value come out the same way, and the company being valued is never
 * taken for its appraiser; the valuation team's page is given only what it
 * always was. The text of every report here is made up, and so is every firm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectReport, nothingDetected, deskDetection } = await import('../src/report-detect.ts');
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

// --- The appraiser and the company's value, for the company's own import ------------

const appraiser = (...pages: string[]) => read(...pages).appraiser;
const firmOf = (names: string[], ...pages: string[]) => detectReport(pages, { asOf: AS_OF, names }).appraiser;

test('the appraiser is the firm the report says prepared it, in the ways reports name it, with how sure the reading is', () => {
  const cases: [string, string, string][] = [
    ['Prepared by: Saltmarsh Appraisal Partners, LLC', 'Saltmarsh Appraisal Partners, LLC', 'high'],
    ['PREPARED BY\nSALTMARSH APPRAISAL PARTNERS, LLC', 'SALTMARSH APPRAISAL PARTNERS, LLC', 'high'],
    ['Cobalt Ridge Valuation Group, Inc. ("Cobalt Ridge," "we" or "us") was engaged by the Board.', 'Cobalt Ridge Valuation Group, Inc.', 'high'],
    ['The Company engaged Wrenfield Hollow Advisors LLP to estimate the fair market value of its common stock.', 'Wrenfield Hollow Advisors LLP', 'high'],
    ['Saltmarsh Appraisal Partners, LLC, an independent valuation firm, was retained by the Company.', 'Saltmarsh Appraisal Partners, LLC', 'high'],
    // The firm signs the letter, perhaps under the name and title of the person who wrote it.
    ['Very truly yours,\n\nTamsin Vale, ASA\nManaging Director\nOsprey Lane Valuations LLC', 'Osprey Lane Valuations LLC', 'high'],
    ['This report was prepared by Ledgerlight Valuations.', 'Ledgerlight Valuations', 'high'],
    // A footer, after the page number.
    ['Page 3 of 41   Prepared by Saltmarsh Appraisal Partners, LLC', 'Saltmarsh Appraisal Partners, LLC', 'high'],
    // A firm's word without its legal ending, named as the one engaged: offered, with a warning.
    ['The Board engaged Ledgerlight Valuations to value the common stock.', 'Ledgerlight Valuations', 'medium'],
    // A person's name, or a firm's name on the cover and nowhere else: offered as a guess.
    ['Prepared by: Tamsin Vale', 'Tamsin Vale', 'low'],
    ['LARKSPUR STILE ADVISORS, LLC\n409A Valuation Report', 'LARKSPUR STILE ADVISORS, LLC', 'low'],
  ];
  for (const [text, value, confidence] of cases) {
    const found = appraiser(text);
    assert.ok(found, text);
    assert.equal(found.value, value, text);
    assert.equal(found.confidence, confidence, text);
    assert.ok(found.context.includes(found.text), `${found.context} carries ${found.text}`);
  }
  // Names as firms write them: with "The", with partners' names and commas, "& Co.", wrapped onto two lines.
  for (const [text, value] of [
    ['409A Valuation Report\nPrepared by: The Wexmoor Group, LLC', 'The Wexmoor Group, LLC'],
    ['409A Valuation Report\nPrepared by: Brackett, Holm & Wyse LLP', 'Brackett, Holm & Wyse LLP'],
    ['This report was prepared by Marlstone & Co., LLC for the Board of Directors.', 'Marlstone & Co., LLC'],
    ['Ashgrove Tidewater Advisors,\nInc. ("Ashgrove," "we" or "us") has been engaged by the Board of Directors of Pemberly Kitchenworks, Inc.', 'Ashgrove Tidewater Advisors, Inc.'],
  ]) assert.deepEqual([appraiser(text)?.value, appraiser(text)?.confidence], [value, 'high'], text);
  // A person's name before the firm's is not run into it.
  assert.equal(appraiser('Prepared by: Tamsin Vale, Okenshaw Valuation Services, P.C.')?.value, 'Tamsin Vale');
  // Under the signature, the firm's legal name, not a department's line above it, however many lines come first.
  for (const block of [
    'Sincerely,\n/s/ Elsbeth Marrow\nElsbeth Marrow, ASA\nValuation Advisory Services\nOkenshaw Valuation Services, P.C.',
    'Very truly yours,\n/s/ Elsbeth Marrow\nElsbeth Marrow, CFA, ASA\nManaging Director\nHead of Valuation Practice\nOkenshaw Valuation Services, P.C.',
  ]) assert.deepEqual([appraiser(block)?.value, appraiser(block)?.confidence], ['Okenshaw Valuation Services, P.C.', 'high'], block);
  // A cover in capitals and a letter in ordinary case name one firm, and the ordinary case is what is kept.
  const both = read('SALTMARSH APPRAISAL PARTNERS, LLC\nValuation of the common stock', 'Sincerely,\nSaltmarsh Appraisal Partners, LLC').appraiser;
  assert.deepEqual([both?.value, both?.confidence], ['Saltmarsh Appraisal Partners, LLC', 'high']);
});

test('the company the report values is never its appraiser, however the report names it', () => {
  for (const text of [
    'VALUATION OF THE COMMON STOCK OF\nQUILLFEATHER ROBOTICS, INC.\nAs of June 30, 2026',
    'August 4, 2026\nBoard of Directors\nQuillfeather Robotics, Inc.\n100 Kiln Street',
    'Prepared for: Quillfeather Robotics, Inc.',
    'Prepared for: The Board of Directors\nQuillfeather Robotics, Inc.',
    'Quillfeather Robotics, Inc. (the "Company") is engaged in the design of warehouse robots.',
    // Prepared by the company, but not the report: its projections.
    'The financial projections were prepared by Quillfeather Robotics, Inc. management.',
  ]) assert.equal(appraiser(text), null, text);
  // Nor is whoever prepared something else the report relies on.
  assert.equal(appraiser('The financial projections were\nprepared by Pellam Planning Group, Inc.'), null);
  assert.equal(appraiser('Audited statements prepared by Pellam & Strand LLP were reviewed.'), null);

  // Named as the company anywhere, the name is left out wherever else it stands, and the firm is found.
  const report = read(
    'QUILLFEATHER ROBOTICS, INC.\nValuation of the common stock\nPrepared by: Saltmarsh Appraisal Partners, LLC',
    'Saltmarsh Appraisal Partners, LLC has been engaged by Quillfeather Robotics, Inc. (the "Company").',
  ).appraiser;
  assert.deepEqual([report?.value, report?.confidence], ['Saltmarsh Appraisal Partners, LLC', 'high']);

  // The company's own names, given by the caller, are left out even where nothing in the report says whose they are.
  const cover = 'QUILLFEATHER ROBOTICS, INC.\n409A Valuation Report';
  assert.equal(appraiser(cover)?.confidence, 'low', 'without them, a guess');
  assert.equal(firmOf(['Quillfeather Robotics'], cover), null);
  assert.equal(firmOf(['Quillfeather Robotics, Inc.'], cover), null);
  assert.equal(firmOf(['Quillfeather'], 'Prepared by: Quillfeather Valuation Partners, LLC')?.value, 'Quillfeather Valuation Partners, LLC',
    'one word in common is not the same firm');
  // The app's one-word name for the company covers its full name when the rest of it is not a firm's.
  assert.equal(firmOf(['Quillfeather'], cover), null);
  // The company defined with its short name first, and calling itself "we" in its own documents.
  for (const text of [
    'TESSALINE ANALYTICS, INC.\n409A VALUATION REPORT\nTessaline Analytics, Inc. ("Tessaline" or the "Company") was incorporated in Delaware in 2022.',
    'Hexwold Labs, Inc. ("Hexwold," the "Company," "we" or "our") is a Delaware corporation.',
  ]) assert.equal(appraiser(text), null, text);
});

test('other firms a report mentions are not its appraiser, and two firms each named as its author leave the choice to a person', () => {
  assert.equal(appraiser('The Series A was led by Northgate Harbor Ventures, L.P. and counsel was Pellam & Strand LLP.'), null);
  assert.equal(appraiser('Market data was provided by Pellam Data Services, Inc.'), null);
  // Engaged, retained, prepared or performed by: for something else, the firm is not the appraiser.
  for (const text of [
    'In connection with the Series B financing, the Company engaged Larchmere & Pell LLP as its legal counsel.',
    'The Company\'s 2025 audit was performed by Hollis Varnum LLP.',
    'An independent market study was conducted by Fenwright Research Group, Inc. in 2025.',
    'The Company retained Pellbrook Capital Partners as placement agent for the Series B.',
    'This report updates the prior valuation prepared by Ilverton Appraisal Partners, LLC as of December 31, 2025.',
    'The Series B term sheet was prepared by Larchmere & Pell LLP.',
    'Due diligence was conducted by Pellbrook Capital Partners, LLC on behalf of the investors.',
    'Hexwold Labs, Inc. has been retained by three hospital networks.',
  ]) {
    assert.equal(appraiser(text), null, text);
    const signed = appraiser(`${text}\nIn our opinion, the fair market value of the common stock was $0.74 per share.\nSincerely,\nOkenshaw Valuation Services, P.C.`);
    assert.deepEqual([signed?.value, signed?.confidence], ['Okenshaw Valuation Services, P.C.', 'high'], text);
  }
  const two = read('Prepared by: Saltmarsh Appraisal Partners, LLC', 'Sincerely,\nCobalt Ridge Valuation Group, Inc.').appraiser;
  assert.equal(two?.value, 'Saltmarsh Appraisal Partners, LLC');
  assert.equal(two?.confidence, 'medium');
});

test('the enterprise value, or the equity value where the report states no other, comes out in cents with how sure the reading is', () => {
  const cases: [string, number, string, string][] = [
    ['Based on our analysis, we concluded that the enterprise value of the Company was $48.2 million.', 4_820_000_000, 'enterprise', 'high'],
    ['Concluded enterprise value $52,300,000', 5_230_000_000, 'enterprise', 'high'],
    ['Business enterprise value (BEV) ........ $52.3M', 5_230_000_000, 'enterprise', 'medium'],
    // An equity value is never more than medium: the form asks for the enterprise value, which it is not.
    ['We estimated the equity value of the Company at $61.5 million.', 6_150_000_000, 'equity', 'medium'],
    ['Total equity value $61,500,000', 6_150_000_000, 'equity', 'medium'],
  ];
  for (const [text, value, basis, confidence] of cases) {
    const found = read(text).enterpriseValue;
    assert.ok(found, text);
    assert.deepEqual([found.value, found.basis, found.confidence], [value, basis, confidence], text);
    assert.ok(found.context.includes(found.text), `${found.context} carries ${found.text}`);
  }
  // Both stated: the enterprise value, whichever comes first, and each amount with its own label.
  const both = read('We concluded an equity value of $51.3 million and an enterprise value of $48.2 million.').enterpriseValue;
  assert.deepEqual([both?.value, both?.basis], [4_820_000_000, 'enterprise']);
  const derived = read('The equity value of $54 million follows from the enterprise value.').enterpriseValue;
  assert.deepEqual([derived?.value, derived?.basis], [5_400_000_000, 'equity']);
  // A table in thousands or millions, as its heading says: the figure scaled, flagged, with the words as written.
  for (const [text, value] of [
    ['($ in thousands)\nConcluded enterprise value $ 152,300\nNet debt (4,100)\nEquity value $ 148,200', 15_230_000_000],
    ['Conclusion of Value (in thousands)\nEnterprise value $12,500\nPlus: cash 3,100', 1_250_000_000],
    ['($000s)\nEnterprise value $ 152,300', 15_230_000_000],
    ['Summary (in thousands, except per share amounts)\nEnterprise value $ 48,200\nFair market value per common share $ 0.42', 4_820_000_000],
    ['($ in millions)\nConcluded enterprise value $48.2\nEquity value $51.3', 4_820_000_000],
  ] as const) {
    const found = read(text).enterpriseValue;
    assert.deepEqual([found?.value, found?.basis, found?.confidence], [value, 'enterprise', 'medium'], text);
    assert.equal(found?.units, /millions/.test(text) ? 'millions' : 'thousands', text);
    assert.ok(found?.context.includes(found.text), text);
  }
  // A sentence on such a page writes its figure in full, and a figure with its own scale needs none.
  const sentence = read('We concluded that the enterprise value of the Company was $48,200,000.\nBalance sheet (in thousands)\nCash $5,100').enterpriseValue;
  assert.deepEqual([sentence?.value, sentence?.units], [4_820_000_000, undefined]);
  assert.equal(read('(in thousands)\nConcluded enterprise value $48.2 million').enterpriseValue?.value, 4_820_000_000);
  assert.equal(read('Based on our analysis, we concluded that the enterprise value of the Company was $48.2 million.').enterpriseValue?.units, undefined);
});

test('a heading over a row of figures names each in turn, and a row it cannot pair is not read as either', () => {
  for (const text of [
    'Conclusion of value\nEquity value Enterprise value\n$51,300,000 $48,200,000',
    'Conclusion of value\nEnterprise value Equity value\n$48,200,000 $51,300,000',
  ]) {
    const found = read(text).enterpriseValue;
    assert.deepEqual([found?.value, found?.basis, found?.confidence], [4_820_000_000, 'enterprise', 'medium'], text);
  }
  assert.equal(read('Enterprise value Equity value Net debt\n$48,200,000 $51,300,000 $3,100,000 $9,000,000').enterpriseValue, null);
  // One label over several figures, a low, a selected and a high: which is the value is not said.
  assert.equal(read('Enterprise value\n$44,000,000 $47,500,000 $51,000,000').enterpriseValue?.confidence, 'low');
  assert.equal(read('Enterprise value $44,000,000 $47,500,000 $51,000,000').enterpriseValue?.confidence, 'low');
});

test('a range is not the value, the point selected in it is, and a change is read at where the value is now', () => {
  const ranges: [string, number, string][] = [
    ['The market approach indicated an enterprise value range of $44.0 million to $51.0 million.', 4_400_000_000, 'low'],
    ['We concluded that the enterprise value of the Company is between $44.0 million and $51.0 million.', 4_400_000_000, 'low'],
    ['Indicated enterprise value range $44.0 million - $51.0 million\nSelected enterprise value $47.5 million', 4_750_000_000, 'high'],
    ['Based on the market approach, we concluded that the enterprise value of the Company falls within a range of $45.0 million to $52.0 million, and we selected $48.2 million.', 4_820_000_000, 'medium'],
    ['The enterprise value of the Company increased from $30.0 million to $41.5 million.', 4_150_000_000, 'medium'],
    ['The enterprise value of the Company rose to $41.5 million from $30.0 million.', 4_150_000_000, 'medium'],
    ['The enterprise value of the Company increased from $30.0 million in the prior valuation to $41.5 million.', 4_150_000_000, 'medium'],
  ];
  for (const [text, value, confidence] of ranges) {
    const found = read(text).enterpriseValue;
    assert.deepEqual([found?.value, found?.confidence], [value, confidence], text);
  }
  // An earlier valuation's value is at best a guess, however far back in the sentence it says so.
  assert.equal(read('The prior 409A, as of December 31, 2025, concluded an enterprise value of $30.0 million.').enterpriseValue?.confidence, 'low');
});

test('the equity value the report concludes is not displaced by a weaker enterprise value: another company’s, an earlier one, or cash', () => {
  const equity = 'We concluded that the equity value of the Company on a marketable basis was $131.5 million.';
  for (const other of [
    'Guideline Public Company Analysis\nCompany Enterprise Value EV/Revenue\nKestrelmark Systems $1,240.5 million 4.2x',
    'The prior 409A concluded an enterprise value of $30 million.',
    'We did not separately estimate the enterprise value, as the Company holds cash of $8.4 million.',
  ]) {
    const found = read(equity, other).enterpriseValue;
    assert.deepEqual([found?.value, found?.basis, found?.confidence], [13_150_000_000, 'equity', 'medium'], other);
  }
  // On their own, other companies' values and the company's cash are not its value at all.
  assert.equal(read('Guideline Public Company Analysis\nCompany Enterprise Value EV/Revenue\nKestrelmark Systems $1,240.5 million 4.2x\nOndrell Software $860.0 million 3.8x').enterpriseValue, null);
  assert.equal(read('The enterprise value was not separately estimated; the Company\'s cash balance of $8.4 million was added to the backsolved value.').enterpriseValue, null);
  // The company's own value under the same heading as the guideline companies' is still read where a sentence states it.
  assert.equal(read('Based on the guideline public company method, we concluded an\nenterprise value of $44.8 million.').enterpriseValue?.value, 4_480_000_000);
});

test('money that is not the company’s value is never read as it: a round, a cap, revenue, a price per share, an earlier valuation', () => {
  const text = [
    'The Company raised $15,000,000 in its Series A at a post-money valuation of $60,000,000.',
    'Revenue for the year was $4.2 million and cash on hand $9,850,000.',
    'Outstanding SAFEs carry a valuation cap of $20 million.',
    'Equity value per share $0.42',
  ].join('\n');
  assert.equal(read(text).enterpriseValue, null);
  const earlier = read('The prior 409A concluded an enterprise value of $30 million.\nWe concluded that the enterprise value of the Company was $48.2 million.');
  assert.equal(earlier.enterpriseValue?.value, 4_820_000_000);
  assert.equal(read('The prior 409A concluded an enterprise value of $30 million.').enterpriseValue?.confidence, 'low', 'an earlier value alone is at best a guess');
});

test('the appraiser and the company’s value read promptly from pages stuffed with names and figures', () => {
  const pages = [
    'Prepared by Saltmarsh Appraisal Partners, LLC '.repeat(3_000),
    `${' Inc.'.repeat(20_000)}\n${'Sincerely,\n'.repeat(5_000)}`,
    // A long run of spaces after the close of a letter, or after "Board of Directors", which a careless pattern tries every split of.
    `Board of Directors${' '.repeat(90_000)}x`,
    `Sincerely${'\t'.repeat(90_000)}x`,
    `($ in thousands)\n${'Enterprise value $ 152,300 '.repeat(3_000)}`,
    '("we") was engaged by stock of '.repeat(3_000),
    '$48.2 million enterprise value '.repeat(3_000),
    'Prepared by: Cobalt Ridge Valuation Group, Inc.\nWe concluded that the enterprise value of the Company was $48.2 million.',
  ];
  const started = performance.now();
  const found = read(...pages);
  const ms = Math.round(performance.now() - started);
  assert.ok(ms < 2_000, `${ms} ms`);
  assert.ok(found.appraiser);
  assert.equal(found.enterpriseValue?.value, 4_820_000_000);
});

test('the valuation team’s page is given what it always was: the price, the date, the method and the candidates', () => {
  const found = read('Prepared by: Saltmarsh Appraisal Partners, LLC\nValuation Date: June 30, 2026\nWe concluded that the enterprise value of the Company was $48.2 million.');
  assert.ok(found.appraiser && found.enterpriseValue);
  assert.deepEqual(Object.keys(deskDetection(found)).sort(), ['candidates', 'fairMarketValue', 'method', 'readable', 'valuationDate']);
  assert.deepEqual(deskDetection(nothingDetected(false)), { readable: false, fairMarketValue: null, valuationDate: null, method: null, candidates: { fairMarketValue: [], valuationDate: [] } });
});

test('read end to end from a PDF the app writes, the appraiser and the company’s value come out with their pages', () => {
  const file = documentPdf({
    company: 'Saltmarsh Appraisal Partners, LLC',
    title: 'Valuation of the common stock of Quillfeather Robotics, Inc.',
    body: [
      'Valuation Date: June 30, 2026',
      '',
      'Saltmarsh Appraisal Partners, LLC was engaged to estimate the fair market value of the common stock of Quillfeather Robotics, Inc. (the "Company") for Section 409A purposes.',
      'Based on our analysis, we concluded that the enterprise value of the Company was $48.2 million, and its equity value $51.3 million.',
      'We concluded that the fair market value of the common stock is $0.42 per share on a non-marketable, minority basis.',
    ].join('\n'),
    signatures: [],
    footer: 'Prepared by Saltmarsh Appraisal Partners, LLC',
  });
  const text = pdfText(file);
  assert.ok(text.readable);
  if (!text.readable) return;
  const found = detectReport(text.pages, { asOf: AS_OF, names: ['Quillfeather Robotics', 'Quillfeather Robotics, Inc.'] });
  assert.deepEqual([found.appraiser?.value, found.appraiser?.confidence, found.appraiser?.page], ['Saltmarsh Appraisal Partners, LLC', 'high', 1]);
  assert.deepEqual([found.enterpriseValue?.value, found.enterpriseValue?.basis, found.enterpriseValue?.text], [4_820_000_000, 'enterprise', '$48.2 million']);
  assert.equal(found.fairMarketValue?.value, 420_000);
});
