import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { freshDatabase } from './helpers.ts';
import { parseCsv, toCsv } from '../src/import/csv.ts';
import { parseXlsx, readZip, columnIndex, excelSerialToISO } from '../src/import/xlsx.ts';
import {
  suggestMapping, coerceNumber, coerceMoney, coercePrice, coercePercent, coerceDate, coerceBoolean,
  coerceAwardType, coerceInstrument, coerceConvertibleStatus, coerceRelation, parseVestingShorthand, guessStakeholderType,
  guessHeaderRow, shareClassFromSheetName, detectSheet,
} from '../src/import/values.ts';

// One private database for the file; each end-to-end test uses its own company.
await freshDatabase();

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('CSV: quoted fields, doubled quotes, embedded newlines, CRLF and a BOM', () => {
  const text = '﻿Name,Notes,Shares\r\n"Stone, Avery","She said ""hi""\nthen left",1000\r\nBao,,2000\r\n\r\n';
  assert.deepEqual(parseCsv(text), [
    ['Name', 'Notes', 'Shares'],
    ['Stone, Avery', 'She said "hi"\nthen left', '1000'],
    ['Bao', '', '2000'],
  ]);
});

test('CSV: semicolon and tab delimiters are detected from the header', () => {
  assert.deepEqual(parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('"x, y";z\n1;2'), [['x, y', 'z'], ['1', '2']]);   // commas inside quotes do not vote
});

test('CSV: round-trips through toCsv', () => {
  const rows = [['Name', 'Note'], ['Stone, Avery', 'say "hi"'], ['Bao', 'line\nbreak']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

// ---------------------------------------------------------------------------
// XLSX — built here from raw parts so the reader is tested against real ZIP
// framing (both stored and deflated entries) and real SpreadsheetML.
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, string>, deflate = false): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name), raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0, crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(centrals.length / 2, 8); eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const WORKBOOK = {
  'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Cap table" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  'xl/sharedStrings.xml': `<sst><si><t>Stakeholder</t></si><si><r><t>Avery </t></r><r><t>Stone &amp; Co</t></r></si><si><t xml:space="preserve">Common</t></si></sst>`,
  'xl/styles.xml': `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Class</t></is></c><c r="C1" t="str"><v>Shares</v></c><c r="D1" t="inlineStr"><is><t>Issue date</t></is></c><c r="E1" t="inlineStr"><is><t>Vested?</t></is></c><c r="G1" t="inlineStr"><is><t>Price</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>4200000</v></c><c r="D2" s="1"><v>45306</v></c><c r="E2" t="b"><v>1</v></c><c r="G2" s="3"><v>0.0001</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Bao</t></is></c><c r="B4" t="s"><v>2</v></c><c r="C4"><v>3800000</v></c><c r="D4" s="2"><v>45306.5</v></c><c r="E4" t="b"><v>0</v></c></row>
  </sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>memo</t></is></c></row></sheetData></worksheet>`,
};

test('ZIP: stored and deflated entries are both read back', () => {
  for (const deflate of [false, true]) {
    const files = readZip(zip({ 'a.txt': 'hello', 'dir/b.txt': 'world' }, deflate));
    assert.equal(files.get('a.txt')!.toString(), 'hello');
    assert.equal(files.get('dir/b.txt')!.toString(), 'world');
  }
  assert.throws(() => readZip(Buffer.from('not a zip at all, not even close, really not')), /not a valid \.xlsx/);
});

test('XLSX: shared strings with rich text, inline strings, numbers, booleans, dates by style, gaps and sheets', () => {
  const sheets = parseXlsx(zip(WORKBOOK, true));
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, 'Cap table');
  assert.deepEqual(sheets[0].rows[0], ['Stakeholder', 'Class', 'Shares', 'Issue date', 'Vested?', null, 'Price']);
  assert.deepEqual(sheets[0].rows[1], ['Avery Stone & Co', 'Common', 4_200_000, '2024-01-15', true, null, 0.0001]);
  assert.deepEqual(sheets[0].rows[2], ['Bao', 'Common', 3_800_000, '2024-01-15', false, null, null]);   // empty row 3 dropped, custom date format honoured
  assert.equal(sheets[1].name, 'Notes');
  assert.deepEqual(sheets[1].rows, [['memo']]);
});

test('XLSX helpers: column letters and Excel serial dates', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('Z'), 25);
  assert.equal(columnIndex('AA'), 26);
  assert.equal(columnIndex('AZ'), 51);
  assert.equal(excelSerialToISO(25569), '1970-01-01');
  assert.equal(excelSerialToISO(45306), '2024-01-15');
  assert.equal(excelSerialToISO(60), '1900-02-28');
  assert.equal(excelSerialToISO(0), null);
});

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

test('numbers: currency symbols, thousands separators, parentheses, k/m suffixes', () => {
  assert.equal(coerceNumber('$1,250,000').value, 1_250_000);
  assert.equal(coerceNumber('(100)').value, -100);
  assert.equal(coerceNumber('1.2M').value, 1_200_000);
  assert.equal(coerceNumber('500k').value, 500_000);
  assert.equal(coerceNumber(' 42 ').value, 42);
  assert.equal(coerceNumber('').value, null);
  assert.equal(coerceNumber('n/a').value, null);
  assert.match(coerceNumber('twelve').error!, /not a number/);
  assert.match(coerceNumber('20%').error!, /percentage/);
  assert.equal(coerceMoney('$1,000.50').value, 100_050);
  assert.equal(coercePrice('0.0001').value, 100);
  assert.equal(coercePrice(3.2145).value, 3_214_500);
});

test('percentages: "20%", "20" and "0.2" all mean twenty percent', () => {
  assert.equal(coercePercent('20%').value, 0.2);
  assert.equal(coercePercent('20').value, 0.2);
  assert.equal(coercePercent(0.2).value, 0.2);
  assert.equal(coercePercent('1').value, 1);
  assert.match(coercePercent('150').error!, /between 0 and 100/);
});

test('dates: ISO, numeric in either order, month names, Excel serials, and garbage', () => {
  assert.equal(coerceDate('2024-01-15').value, '2024-01-15');
  assert.equal(coerceDate('2024-01-15T10:00:00Z').value, '2024-01-15');
  assert.equal(coerceDate('01/15/2024').value, '2024-01-15');          // month first by default
  assert.equal(coerceDate('15/01/2024').value, '2024-01-15');          // impossible as month first, so day first
  assert.equal(coerceDate('03/04/2024').value, '2024-03-04');          // ambiguous: US
  assert.equal(coerceDate('03/04/2024', 'DMY').value, '2024-04-03');
  assert.equal(coerceDate('1/5/24').value, '2024-01-05');
  assert.equal(coerceDate('Jan 15, 2024').value, '2024-01-15');
  assert.equal(coerceDate('15 Jan 2024').value, '2024-01-15');
  assert.equal(coerceDate('15-Sep-2026').value, '2026-09-15');
  assert.equal(coerceDate('September 1st 2024').value, '2024-09-01');
  assert.equal(coerceDate(45306).value, '2024-01-15');
  assert.equal(coerceDate('45306').value, '2024-01-15');
  assert.equal(coerceDate('').value, null);
  assert.match(coerceDate('02/30/2024').error!, /not a real date/);
  assert.match(coerceDate('soon').error!, /not a date/);
});

test('booleans and enumerations are read the way spreadsheets spell them', () => {
  assert.equal(coerceBoolean('Yes').value, true);
  assert.equal(coerceBoolean('x').value, true);
  assert.equal(coerceBoolean('No').value, false);
  assert.equal(coerceBoolean(true).value, true);
  assert.match(coerceBoolean('maybe').error!, /yes or no/);
  assert.equal(coerceAwardType('Incentive Stock Option').value, 'ISO');
  assert.equal(coerceAwardType('NQSO').value, 'NSO');
  assert.equal(coerceAwardType('Restricted Stock Units').value, 'RSU');
  assert.match(coerceAwardType('Stock Option').error!, /ambiguous/);
  assert.equal(coerceInstrument('SAFE').value, 'SAFE_POST');
  assert.equal(coerceInstrument('Pre-money SAFE').value, 'SAFE_PRE');
  assert.equal(coerceInstrument('Convertible Note').value, 'NOTE');
  assert.equal(coerceRelation('Co-Founder').value, 'FOUNDER');
  assert.equal(coerceRelation('Ex-employee').value, 'FORMER_EMPLOYEE');
  assert.equal(coerceRelation('Board Director').value, 'BOARD_MEMBER');
  assert.equal(guessStakeholderType('Foundry Seed Fund I, L.P.'), 'FUND');
  assert.equal(guessStakeholderType('The Stone Family Trust'), 'TRUST');
  assert.equal(guessStakeholderType('Acme Holdings Inc.'), 'FUND');
  assert.equal(guessStakeholderType('Priya Raman'), 'INDIVIDUAL');
});

test('vesting shorthand covers the ways people write schedules', () => {
  assert.deepEqual(parseVestingShorthand('4y/1y monthly'), { durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('48/12'), { durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('4 years, 1 year cliff, quarterly'), { durationMonths: 48, cliffMonths: 12, frequency: 'QUARTERLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('1 year cliff, 4 years'), { durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('3 years no cliff'), { durationMonths: 36, cliffMonths: 0, frequency: 'MONTHLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('36 months, 6 month cliff'), { durationMonths: 36, cliffMonths: 6, frequency: 'MONTHLY', fullyVested: false });
  assert.equal(parseVestingShorthand('Fully vested')!.fullyVested, true);
  assert.equal(parseVestingShorthand('whenever'), null);
  // The "one share in N per period" phrasing cap table exports use.
  assert.deepEqual(parseVestingShorthand('1/48 monthly, 25% vest at 12 month cliff'), { durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('1/48 monthly, 25% vest at 1 year cliff'), { durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('1/16 quarterly, no cliff'), { durationMonths: 48, cliffMonths: 0, frequency: 'QUARTERLY', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('1/4 annually after 12 months'), { durationMonths: 48, cliffMonths: 12, frequency: 'ANNUAL', fullyVested: false });
  assert.deepEqual(parseVestingShorthand('1/36 monthly'), { durationMonths: 36, cliffMonths: 0, frequency: 'MONTHLY', fullyVested: false });
});

test('export layouts: header behind a title block, class named by the sheet, and status words', () => {
  assert.equal(guessHeaderRow([['CS-Common', 'Pulley'], ['As of Sept 16, 2026'], [], ['Certificate ID', 'Stakeholder Name', 'Issue Date', 'Shares Issued'], ['CS-1', 'A', '2021-01-01', 100]]), 3);
  assert.equal(guessHeaderRow([['Name', 'Email'], ['a', 'b']]), 0);
  assert.equal(shareClassFromSheetName('CS-Common'), 'Common');
  assert.equal(shareClassFromSheetName('PSS-Series Seed Preferred'), 'Series Seed Preferred');
  assert.equal(shareClassFromSheetName('Series A Preferred'), 'Series A Preferred');
  assert.equal(shareClassFromSheetName('Summary'), null);
  assert.equal(shareClassFromSheetName('2022 Stock Plan'), null);
  assert.equal(coerceInstrument('Post-Money').value, 'SAFE_POST');
  assert.equal(coerceInstrument('Pre-Money').value, 'SAFE_PRE');
  assert.equal(coerceInstrument('Pre-money SAFE').value, 'SAFE_PRE');
  assert.equal(coerceInstrument('Convertible Note').value, 'NOTE');
  assert.equal(coerceNumber('Uncapped').value, null);
  assert.equal(coerceNumber('Uncapped').error, null);
  assert.equal(coerceNumber('None').value, null);
  assert.equal(coerceConvertibleStatus('Outstanding').value, 'OUTSTANDING');
  assert.equal(coerceConvertibleStatus('Cancelled').value, 'CANCELLED');
  assert.equal(coerceConvertibleStatus('Converted').value, 'CONVERTED');
  assert.ok(coerceConvertibleStatus('Purple').error);
});

test('column mapping guesses from headers and keeps specific matches away from generic ones', () => {
  const headers = ['Shareholder', 'Email Address', 'Class of Stock', 'No. of Shares', 'Price per Share', 'Vesting Start Date', 'Date Issued', 'Cert #', 'Vesting', 'Random'];
  const m = suggestMapping('captable', headers);
  assert.equal(m.stakeholderName, 0);
  assert.equal(m.email, 1);
  assert.equal(m.shareClassName, 2);
  assert.equal(m.quantity, 3);
  assert.equal(m.pricePerShare, 4);
  assert.equal(m.vestingStartDate, 5);
  assert.equal(m.issueDate, 6);
  assert.equal(m.certificateNo, 7);
  assert.equal(m.vestingSchedule, 8);
  assert.equal(m.notes, null);
  const g = suggestMapping('grants', ['Optionee', 'Type', 'Options Granted', 'Exercise Price', 'Grant Date', 'Expiry']);
  assert.deepEqual([g.stakeholderName, g.awardType, g.quantity, g.strikePrice, g.grantDate, g.expirationDate], [0, 1, 2, 3, 4, 5]);
});

test('column mapping follows the headers of a cap table export', () => {
  // A certificate ledger: both issued and outstanding counts, dates for vesting, board approval and issue.
  const cert = suggestMapping('captable', ['Certificate ID', 'Stakeholder Name', 'Stakeholder External ID', 'Issue Date', 'Shares Issued',
    'Shares Outstanding', 'Ownership Percentage', 'Price Per Share', 'Vesting Start Date', 'Vesting Schedule', 'Shares Vested', 'Shares Unvested',
    'Capital Contribution', 'Board Approval Date', 'Equity Plan Name', 'Acceleration', 'Comments']);
  assert.equal(cert.certificateNo, 0);
  assert.equal(cert.stakeholderName, 1);
  assert.equal(cert.issueDate, 3);
  assert.equal(cert.quantity, 5);                 // outstanding, not issued
  assert.equal(cert.pricePerShare, 7);
  assert.equal(cert.vestingStartDate, 8);
  assert.equal(cert.vestingSchedule, 9);
  assert.equal(cert.boardApprovalDate, 13);
  assert.equal(cert.notes, 16);
  assert.equal(cert.shareClassName, null);        // the sheet name carries it
  // An option ledger.
  const grant = suggestMapping('grants', ['Certificate ID', 'Stakeholder Name', 'Grant Date', 'Expiration Date', 'Equity Plan', 'Grant Type',
    'Exercise Price', 'Granted', 'Outstanding', 'Vested', 'Unvested', 'Vested Exercised/Settled', 'Exercised/Settled', 'Amount Cancelled',
    'Board Approval Date', 'Share Class Name', 'Vesting Schedule', 'Vesting Start Date', 'Early Exercise']);
  assert.deepEqual(
    [grant.label, grant.stakeholderName, grant.grantDate, grant.expirationDate, grant.poolName, grant.awardType, grant.strikePrice, grant.quantity,
      grant.exercisedQuantity, grant.cancelledQuantity, grant.boardApprovalDate, grant.vestingSchedule, grant.vestingStartDate, grant.earlyExercise],
    [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 16, 17, 18]);
  // A SAFE ledger.
  const conv = suggestMapping('convertibles', ['Convertible ID', 'Stakeholder', 'Grant Date', 'Principal Issued', 'Principal Outstanding',
    'Interest Rate', 'Valuation Cap', 'Conversion Discount', 'MFN', 'Maturity Date', 'Cancellation Date', 'Status', 'Conversion Type']);
  assert.deepEqual(
    [conv.stakeholderName, conv.issueDate, conv.principal, conv.interestRate, conv.valuationCap, conv.discount, conv.mfn, conv.maturityDate, conv.status, conv.instrument],
    [1, 2, 3, 5, 6, 7, 8, 9, 11, 12]);
});

// ---------------------------------------------------------------------------
// End to end against a temporary database
// ---------------------------------------------------------------------------

test('a cap table spreadsheet becomes stakeholders, share classes and certificates that reconcile', async () => {
  const { insert } = await import('../src/db.ts');
  const { prepareImport, commitImport } = await import('../src/import/engine.ts');
  const { loadCompanyData } = await import('../src/store.ts');
  const { computeCapTable } = await import('@kosmitor/core');

  const companyId = 'co_test';
  await insert('companies', { id: companyId, name: 'Test Co', createdAt: new Date().toISOString() });
  await insert('share_classes', { id: 'sc_common', companyId, name: 'Common', kind: 'COMMON', authorized: 20_000_000, parValue: 100,
    seniority: 0, originalIssuePrice: 100, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null,
    conversionRatio: 1, dividendType: 'NONE', dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0,
    votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0, issueDate: '2021-01-01', isConvertible: 0, sortOrder: 0 });
  await insert('stakeholders', { id: 'stk_avery', companyId, name: 'Avery Stone', email: 'avery@example.com', type: 'INDIVIDUAL',
    relation: 'FOUNDER', createdAt: new Date().toISOString() });
  await insert('vesting_schedules', { id: 'vs_std', companyId, name: '4 years, 1 year cliff, monthly', kind: 'TIME', durationMonths: 48,
    cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, accelerationSingle: 0, accelerationDouble: 0, createdAt: new Date().toISOString() });
  await insert('issuances', { id: 'iss_existing', companyId, certificateNo: 'CS-1', stakeholderId: 'stk_avery', shareClassId: 'sc_common',
    quantity: 1_000_000, pricePerShare: 100, issueDate: '2021-01-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: new Date().toISOString() });

  const headers = ['Stakeholder', 'Email', 'Share class', 'Shares', 'Price per share', 'Issue date', 'Certificate', 'Vesting schedule'];
  const rows = [
    ['AVERY STONE', '', 'Common', '4,200,000', '$0.0001', '02/01/2021', 'CS-2', '4y/1y monthly'],          // existing holder by name, existing schedule by shorthand
    ['Bao Nguyen', 'bao@example.com', 'Common', '3,800,000', '0.0001', 'Feb 1, 2021', 'CS-3', '3 years, no cliff'],  // new holder, new schedule
    ['Foundry Seed Fund I, L.P.', 'ir@foundry.example', 'Series Seed Preferred', '2,290,000', '0.8734', '2022-09-15', 'PS-1', ''],  // new fund + new preferred class
    ['Foundry Seed Fund I, L.P.', 'ir@foundry.example', 'Series Seed Preferred', '10,000', '0.8734', '2022-09-15', 'PS-2', ''],     // same new holder and class again
    ['Ghost Holder', '', 'Common', '0', '0.0001', '2021-02-01', 'CS-9', ''],                                     // skipped: nothing outstanding
    ['Dup Holder', '', 'Common', '100', '0.0001', '2021-02-01', 'CS-1', ''],                                     // error: certificate exists
  ];
  const request = {
    kind: 'captable' as const, headers, rows, headerRowNumber: 1,
    mapping: { stakeholderName: 0, email: 1, shareClassName: 2, quantity: 3, pricePerShare: 4, issueDate: 5, certificateNo: 6, vestingSchedule: 7 },
    options: { fileName: 'captable.csv' },
  };

  const preview = await prepareImport(companyId, request);
  assert.equal(preview.counts.total, 6);
  assert.equal(preview.counts.errors, 1);
  assert.equal(preview.counts.skipped, 1);
  assert.equal(preview.counts.willImport, 4);
  assert.equal(preview.rows[0].row, 2);
  assert.equal(preview.rows[0].status, 'ok');
  assert.equal(preview.rows[0].summary.stakeholder, 'Avery Stone');           // matched the existing record despite the casing
  assert.equal(preview.rows[4].action, 'skip');
  assert.equal(preview.rows[4].status, 'ok');
  assert.match(preview.rows[4].messages[0].text, /No shares outstanding/);
  assert.ok(!preview.creates.stakeholders.includes('Ghost Holder'));          // a skipped row creates nothing
  assert.match(preview.rows[5].messages.map((m) => m.text).join(' '), /already exists/);
  assert.deepEqual(preview.creates.stakeholders, ['Bao Nguyen', 'Foundry Seed Fund I, L.P.']);
  assert.deepEqual(preview.creates.shareClasses, ['Series Seed Preferred']);
  assert.deepEqual(preview.creates.vestingSchedules, ['3 years, no cliff, monthly']);

  // Errors block the commit unless the caller opts to skip those rows.
  await assert.rejects(() => commitImport(companyId, request, 'Tester'), /1 row has errors/);
  const result = await commitImport(companyId, { ...request, options: { ...request.options, skipRowsWithErrors: true } }, 'Tester');
  assert.deepEqual(result.imported, { stakeholders: 2, shareClasses: 1, issuances: 4, awards: 0, convertibles: 0, vestingSchedules: 1, pools: 0 });

  const data = await loadCompanyData(companyId);
  const table = computeCapTable(data, { asOf: '2023-01-01' });
  assert.equal(table.totals.outstanding, 1_000_000 + 4_200_000 + 3_800_000 + 2_290_000 + 10_000);
  const foundry = data.stakeholders.find((s) => s.name === 'Foundry Seed Fund I, L.P.')!;
  assert.equal(foundry.type, 'FUND');
  assert.equal(foundry.relation, 'INVESTOR');
  const seed = data.shareClasses.find((c) => c.name === 'Series Seed Preferred')!;
  assert.equal(seed.kind, 'PREFERRED');
  assert.equal(seed.originalIssuePrice, 873_400);
  assert.equal(seed.authorized, 2_300_000);
  assert.equal(seed.seniority, 1);
  const bao = data.issuances.find((i) => i.certificateNo === 'CS-3')!;
  assert.equal(bao.vestingStartDate, '2021-02-01');
  assert.ok(data.vestingSchedules.some((v) => v.id === bao.vestingScheduleId && v.durationMonths === 36 && v.cliffMonths === 0));
  assert.equal(data.issuances.find((i) => i.certificateNo === 'CS-2')!.vestingScheduleId, 'vs_std');

  // Running the same file again is refused where it would duplicate certificates.
  const again = await prepareImport(companyId, request);
  assert.equal(again.rows.filter((r) => r.status === 'error').length, 5);   // the zero-share row is still just skipped
});

test('grants and convertibles import with defaults, and notes take the default plan when there is only one', async () => {
  const { insert } = await import('../src/db.ts');
  const { commitImport } = await import('../src/import/engine.ts');
  const { loadCompanyData } = await import('../src/store.ts');

  const companyId = 'co_grants';
  const now = new Date().toISOString();
  await insert('companies', { id: companyId, name: 'Grants Co', createdAt: now });
  await insert('share_classes', { id: 'sc_cg', companyId, name: 'Common', kind: 'COMMON', authorized: 10_000_000, parValue: 100, seniority: 0,
    originalIssuePrice: 100, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', conversionRatio: 1, dividendType: 'NONE',
    dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0,
    issueDate: '2021-01-01', isConvertible: 0, sortOrder: 0 });
  await insert('pools', { id: 'pool_g', companyId, name: '2021 Plan', shareClassId: 'sc_cg', authorized: 2_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
  await insert('vesting_schedules', { id: 'vs_g', companyId, name: '4 years, 1 year cliff, monthly', kind: 'TIME', durationMonths: 48,
    cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, accelerationSingle: 0, accelerationDouble: 0, createdAt: now });

  const grants = await commitImport(companyId, {
    kind: 'grants', headers: ['Optionee', 'Type', 'Options', 'Strike', 'Grant date', 'Vesting', 'Exercised'],
    rows: [
      ['Priya Raman', 'ISO', '420,000', '0.01', '2021-11-08', '', ''],
      ['Lena Fischer', 'RSU', '55,000', '', '2024-09-01', '4y/1y', ''],
      ['Marcus Webb', 'NSO', '100,000', '0.19', '2022-03-14', '', '100,000'],
      ['Nobody', 'Stock Option', '10', '1', '2022-01-01', '', ''],          // ambiguous type -> error
    ],
    mapping: { stakeholderName: 0, awardType: 1, quantity: 2, strikePrice: 3, grantDate: 4, vestingSchedule: 5, exercisedQuantity: 6 },
    options: { defaultVestingScheduleId: 'vs_g', skipRowsWithErrors: true, fileName: 'grants.xlsx' },
  }, 'Tester');
  assert.equal(grants.counts.errors, 1);
  assert.equal(grants.imported.awards, 3);
  assert.equal(grants.imported.stakeholders, 3);

  const data = await loadCompanyData(companyId);
  const priya = data.awards.find((a) => a.stakeholderId === data.stakeholders.find((s) => s.name === 'Priya Raman')!.id)!;
  assert.equal(priya.poolId, 'pool_g');                                   // the only plan is used without being named
  assert.equal(priya.vestingScheduleId, 'vs_g');
  assert.equal(priya.expirationDate, '2031-11-08');                       // ten years assumed
  assert.equal(priya.strikePrice, 10_000);
  const lena = data.awards.find((a) => a.type === 'RSU')!;
  assert.equal(lena.strikePrice, 0);
  assert.equal(lena.vestingScheduleId, 'vs_g');                            // "4y/1y" matched the existing schedule
  const marcus = data.awards.find((a) => a.type === 'NSO')!;
  assert.equal(marcus.status, 'EXERCISED');

  const safes = await commitImport(companyId, {
    kind: 'convertibles', headers: ['Investor', 'Instrument', 'Amount', 'Date', 'Cap', 'Discount', 'Interest', 'Maturity'],
    rows: [
      ['Juniper Angels SPV', 'SAFE', '$400,000', '11/02/2023', '$24M', '15%', '', ''],
      ['Bridgepoint Venture Debt', 'Convertible note', '1000000', '2024-11-01', '45,000,000', '20', '8%', '2026-11-01'],
    ],
    mapping: { stakeholderName: 0, instrument: 1, principal: 2, issueDate: 3, valuationCap: 4, discount: 5, interestRate: 6, maturityDate: 7 },
    options: { fileName: 'safes.csv' },
  }, 'Tester');
  assert.equal(safes.imported.convertibles, 2);
  const after = await loadCompanyData(companyId);
  const juniper = after.convertibles.find((c) => c.instrument === 'SAFE_POST')!;
  assert.equal(juniper.principal, 40_000_000);
  assert.equal(juniper.valuationCap, 2_400_000_000);
  assert.equal(juniper.discount, 0.15);
  assert.equal(juniper.interestRate, 0);
  const note = after.convertibles.find((c) => c.instrument === 'NOTE')!;
  assert.equal(note.interestRate, 0.08);
  assert.equal(note.discount, 0.2);
  assert.equal(note.maturityDate, '2026-11-01');
  assert.equal(after.stakeholders.find((s) => s.name === 'Juniper Angels SPV')!.relation, 'INVESTOR');
});

test('a "Type" column holding relationships (Investor, Founder) is read as the relationship, not an error', async () => {
  const { insert } = await import('../src/db.ts');
  const { prepareImport, commitImport } = await import('../src/import/engine.ts');
  const { loadCompanyData } = await import('../src/store.ts');
  const companyId = 'co_typewords';
  await insert('companies', { id: companyId, name: 'Type Words Co', createdAt: new Date().toISOString() });

  // The shape of an ownership export: "Stakeholder Type" is really the relationship.
  const request = {
    kind: 'stakeholders' as const, headers: ['Stakeholder', 'Stakeholder Type', 'Common'],
    rows: [
      ['Kestrel Ventures II, L.P.', 'Investor', 518_400],
      ['Priya Raman', 'Founder', 9_000_000],
      ['Marcus Webb', 'Employee', 0],
      ['Odd One', 'Purple', 0],                        // fits neither field — still an error
    ],
    mapping: { stakeholderName: 0, stakeholderType: 1 },
    options: { skipRowsWithErrors: true },
  };
  const preview = await prepareImport(companyId, request);
  assert.equal(preview.counts.errors, 1);
  assert.match(preview.rows[3].messages[0].text, /Type "Purple" is not individual, entity, fund or trust/);
  assert.match(preview.rows[0].messages[0].text, /read as the relationship; type taken from the name \(fund\)/);
  assert.deepEqual([preview.rows[0].summary.type, preview.rows[0].summary.relation], ['FUND', 'INVESTOR']);
  assert.deepEqual([preview.rows[1].summary.type, preview.rows[1].summary.relation], ['INDIVIDUAL', 'FOUNDER']);

  await commitImport(companyId, request, 'Tester');
  const data = await loadCompanyData(companyId);
  assert.equal(data.stakeholders.find((s) => s.name === 'Priya Raman')!.relation, 'FOUNDER');
  assert.equal(data.stakeholders.find((s) => s.name.startsWith('Kestrel'))!.type, 'FUND');
  assert.equal(data.stakeholders.find((s) => s.name === 'Marcus Webb')!.relation, 'EMPLOYEE');

  // The reverse mix-up — "Individual" in the relationship column — and both given properly.
  const reverse = await prepareImport(companyId, {
    kind: 'stakeholders', headers: ['Name', 'Type', 'Relationship'],
    rows: [['Lena Fischer', 'Employee', 'Individual'], ['Foundry Seed Fund I, L.P.', 'Institution', 'Investor']],
    mapping: { stakeholderName: 0, stakeholderType: 1, relation: 2 },
  });
  assert.equal(reverse.counts.errors, 0);
  assert.deepEqual([reverse.rows[0].summary.type, reverse.rows[0].summary.relation], ['INDIVIDUAL', 'EMPLOYEE']);
  assert.deepEqual([reverse.rows[1].summary.type, reverse.rows[1].summary.relation], ['ENTITY', 'INVESTOR']);

  // Certificates whose stakeholders do not exist yet get the same tolerance when they are created.
  const certs = await prepareImport(companyId, {
    kind: 'captable', headers: ['Holder', 'Type', 'Class', 'Shares', 'Date'],
    rows: [['New Angel', 'Investor', 'Common', 100, '2024-01-01']],
    mapping: { stakeholderName: 0, stakeholderType: 1, shareClassName: 2, quantity: 3, issueDate: 4 },
  });
  assert.equal(certs.counts.errors, 0);
  assert.match(certs.rows[0].messages.map((m) => m.text).join(' '), /Creates stakeholder "New Angel" as investor/);
});

test('a stakeholders sheet updates people it recognises and creates the rest', async () => {
  const { insert } = await import('../src/db.ts');
  const { commitImport } = await import('../src/import/engine.ts');
  const { loadCompanyData } = await import('../src/store.ts');
  const companyId = 'co_people';
  await insert('companies', { id: companyId, name: 'People Co', createdAt: new Date().toISOString() });
  await insert('stakeholders', { id: 'stk_p', companyId, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'OTHER', createdAt: new Date().toISOString() });

  const result = await commitImport(companyId, {
    kind: 'stakeholders', headers: ['Name', 'Email', 'Relationship', 'Title', 'Start'],
    rows: [
      ['Priya R.', 'PRIYA@example.com', 'Employee', 'VP Engineering', '2021-11-08'],   // same email -> update
      ['Wendell Grant', '', 'Board member', '', ''],
      ['Foundry Seed Fund I, L.P.', '', '', '', ''],                                  // relationship defaulted from the name
    ],
    mapping: { stakeholderName: 0, email: 1, relation: 2, title: 3, startDate: 4 },
  }, 'Tester');
  assert.equal(result.imported.stakeholders, 2);
  assert.equal(result.rows[0].action, 'update');
  const data = await loadCompanyData(companyId);
  assert.equal(data.stakeholders.length, 3);
  const priya = data.stakeholders.find((s) => s.id === 'stk_p')!;
  assert.equal(priya.name, 'Priya Raman');                                  // an update never renames
  assert.equal(priya.relation, 'EMPLOYEE');
  assert.equal(priya.startDate, '2021-11-08');
  assert.equal(data.stakeholders.find((s) => s.name === 'Wendell Grant')!.relation, 'BOARD_MEMBER');
  assert.equal(data.stakeholders.find((s) => s.name.startsWith('Foundry'))!.relation, 'INVESTOR');
});

test('a workbook export imports sheet by sheet: fixed share class, total rows, a plan that does not exist yet, cancelled SAFEs', async () => {
  const { insert } = await import('../src/db.ts');
  const { prepareImport, commitImport } = await import('../src/import/engine.ts');
  const { loadCompanyData } = await import('../src/store.ts');
  const { computeCapTable } = await import('@kosmitor/core');
  const companyId = 'co_export';
  const now = new Date().toISOString();
  await insert('companies', { id: companyId, name: 'Export Co', createdAt: now });
  await insert('share_classes', { id: 'sc_ex', companyId, name: 'Common', kind: 'COMMON', authorized: 16_000_000, parValue: 100, seniority: 0,
    originalIssuePrice: 100, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', conversionRatio: 1, dividendType: 'NONE',
    dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0,
    issueDate: '2021-01-01', isConvertible: 0, sortOrder: 0 });
  await insert('vesting_schedules', { id: 'vs_ex', companyId, name: '4 years, 1 year cliff, monthly', kind: 'TIME', durationMonths: 48,
    cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, accelerationSingle: 0, accelerationDouble: 0, createdAt: now });
  await insert('vesting_schedules', { id: 'vs_ex_full', companyId, name: 'Fully vested at grant', kind: 'FULLY_VESTED', durationMonths: 0,
    cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 1, accelerationSingle: 0, accelerationDouble: 0, createdAt: now });

  // Certificate sheet "CS-Common": no share class column, a repurchased certificate, a Total footer.
  const certHeaders = ['Certificate ID', 'Stakeholder Name', 'Issue Date', 'Shares Issued', 'Shares Outstanding', 'Price Per Share', 'Vesting Start Date', 'Vesting Schedule'];
  const certs = await commitImport(companyId, {
    kind: 'captable', headers: certHeaders, headerRowNumber: 3,
    rows: [
      ['CS-1', 'Founder One', '2021-02-01', 8_000_000, 8_000_000, 0.0001, '2021-02-01', 'Fully vested'],
      ['CS-2', 'Founder Two', '2021-02-01', 1_500_000, 1_500_000, 0.0001, '2021-02-01', '1/48 monthly, 25% vest at 12 month cliff'],
      ['CS-3', 'Gone Early', '2021-06-01', 500_000, 0, 0.0001, '2021-06-01', '1/48 monthly, 25% vest at 12 month cliff'],
      ['Total', '', '', 10_000_000, 9_500_000, '', '', ''],
    ],
    mapping: { certificateNo: 0, stakeholderName: 1, issueDate: 2, quantity: 4, pricePerShare: 5, vestingStartDate: 6, vestingSchedule: 7,
      shareClassName: { value: 'Common' } },
    options: { fileName: 'Cap Table.xlsx' },
  }, 'Tester');
  assert.equal(certs.counts.total, 4);
  assert.equal(certs.counts.errors, 0);
  assert.equal(certs.counts.skipped, 2);
  assert.equal(certs.imported.issuances, 2);
  assert.equal(certs.imported.shareClasses, 0);                              // "Common" already existed
  assert.equal(certs.imported.stakeholders, 2);                              // the repurchased holder was not created
  assert.equal(certs.rows[2].action, 'skip');
  assert.match(certs.rows[3].messages[0].text, /total or section row/);
  assert.equal(certs.rows[3].row, 7);                                        // header on row 3 -> data starts on row 4

  // Option sheet: the plan is named but does not exist, and the sheet ends in a summary block.
  const grantHeaders = ['Certificate ID', 'Stakeholder Name', 'Grant Date', 'Equity Plan', 'Grant Type', 'Exercise Price', 'Granted', 'Exercised/Settled', 'Amount Cancelled', 'Vesting Schedule', 'Vesting Start Date'];
  const grantRows = [
    ['ES-1', 'Founder Two', '2023-05-10', '2022 Stock Plan', 'ISO', 0.1, 812_400, 0, 0, '1/48 monthly, 25% vest at 12 month cliff', '2023-05-10'],
    ['ES-2', 'New Hire', '2024-01-15', '2022 Stock Plan', 'ISO', 0.1, 64_150, 0, 0, '1/48 monthly, 25% vest at 12 month cliff', '2024-01-15'],
    ['Total', '', '', '', '', '', 876_550, 0, 0, '', ''],
    ['Summary of 2022 Stock Plan', '', '', '', '', '', '', '', '', '', ''],
    ['Authorized Shares', '', '', '', '', '', 1_250_000, '', '', '', ''],
  ];
  const grantRequest = {
    kind: 'grants' as const, headers: grantHeaders, headerRowNumber: 3, rows: grantRows,
    mapping: { label: 0, stakeholderName: 1, grantDate: 2, poolName: 3, awardType: 4, strikePrice: 5, quantity: 6, exercisedQuantity: 7, cancelledQuantity: 8, vestingSchedule: 9, vestingStartDate: 10 },
    options: { fileName: 'Cap Table.xlsx' },
  };
  const grantsPreview = await prepareImport(companyId, grantRequest);
  assert.equal(grantsPreview.counts.errors, 0);
  assert.equal(grantsPreview.counts.skipped, 3);
  assert.deepEqual(grantsPreview.creates.pools, ['2022 Stock Plan']);
  assert.match(grantsPreview.rows[0].messages.map((m) => m.text).join(' '), /1,250,000 authorized shares, as the sheet states/);
  assert.equal(grantsPreview.creates.vestingSchedules.length, 0);            // matched the existing 48/12 monthly schedule
  const grants = await commitImport(companyId, grantRequest, 'Tester');
  assert.equal(grants.imported.pools, 1);
  assert.equal(grants.imported.awards, 2);

  // SAFE sheet: instrument given as "Post-Money", caps as numbers, "Uncapped" and 0, one cancelled.
  const safeHeaders = ['Convertible ID', 'Stakeholder', 'Grant Date', 'Principal Issued', 'Principal Outstanding', 'Valuation Cap', 'Conversion Discount', 'MFN', 'Status', 'Conversion Type'];
  const safes = await commitImport(companyId, {
    kind: 'convertibles', headers: safeHeaders, headerRowNumber: 3,
    rows: [
      ['SAFE-1', 'Angel One', '2022-03-01', 100_000, 100_000, 8_000_000, 0, 'No', 'Outstanding', 'Post-Money'],
      ['SAFE-2', 'Angel Two', '2022-04-01', 15_000, 15_000, 'Uncapped', 0.2, 'Yes', 'Outstanding', 'Post-Money'],
      ['SAFE-3', 'Seed Fund', '2023-01-01', 1_950_000, 0, 15_000_000, 0, 'No', 'Cancelled', 'Post-Money'],
      ['SAFE-4', 'Angel Three', '2024-02-01', 125_000, 125_000, 0, 0.2, 'No', 'Outstanding', 'Post-Money'],
      ['Total', '', '', 2_190_000, 240_000, '', '', '', '', ''],
    ],
    mapping: { label: 0, stakeholderName: 1, issueDate: 2, principal: 3, valuationCap: 5, discount: 6, mfn: 7, status: 8, instrument: 9 },
    options: { fileName: 'Cap Table.xlsx' },
  }, 'Tester');
  assert.equal(safes.counts.errors, 0);
  assert.equal(safes.counts.skipped, 1);
  assert.equal(safes.imported.convertibles, 4);

  const data = await loadCompanyData(companyId);
  const pool = data.pools.find((p) => p.name === '2022 Stock Plan')!;
  assert.equal(pool.authorized, 1_250_000);                                  // from the sheet's "Authorized Shares" line, not the grants total
  assert.equal(pool.shareClassId, 'sc_ex');
  const founderTwo = data.stakeholders.find((s) => s.name === 'Founder Two')!;
  const es1 = data.awards.find((a) => a.label === 'ES-1')!;
  assert.equal(es1.stakeholderId, founderTwo.id);                            // one stakeholder across both sheets
  assert.equal(es1.vestingScheduleId, 'vs_ex');
  assert.equal(es1.poolId, pool.id);
  assert.equal(es1.strikePrice, 100_000);                                    // $0.10 in micro-cents
  assert.equal(data.issuances.find((i) => i.certificateNo === 'CS-1')!.vestingScheduleId, 'vs_ex_full');
  assert.equal(data.issuances.find((i) => i.certificateNo === 'CS-2')!.vestingScheduleId, 'vs_ex');
  const byHolder = (name: string) => data.convertibles.find((c) => c.stakeholderId === data.stakeholders.find((s) => s.name === name)!.id)!;
  assert.equal(byHolder('Angel One').valuationCap, 800_000_000);
  assert.equal(byHolder('Angel Two').valuationCap, null);                     // "Uncapped"
  assert.equal(byHolder('Angel Three').valuationCap, null);                   // 0 means uncapped in the export
  assert.equal(byHolder('Angel Two').mfn, true);
  assert.equal(byHolder('Seed Fund').status, 'CANCELLED');
  assert.equal(byHolder('Seed Fund').principal, 195_000_000);
  for (const c of data.convertibles) assert.equal(c.instrument, 'SAFE_POST');

  const table = computeCapTable(data, { asOf: '2026-09-16' });
  assert.equal(table.totals.outstanding, 9_500_000);
  const outstandingSafes = data.convertibles.filter((c) => c.status === 'OUTSTANDING').reduce((sum, c) => sum + c.principal, 0);
  assert.equal(outstandingSafes, 24_000_000);                                 // $240,000 — the cancelled SAFE is excluded

  // Running the same tabs again duplicates nothing: certificates, grants and instruments are all recognised.
  const again = await prepareImport(companyId, grantRequest);
  assert.equal(again.counts.willImport, 0);
  assert.match(again.rows[0].messages.map((m) => m.text).join(' '), /Grant "ES-1" already exists/);
  const safesAgain = await prepareImport(companyId, {
    kind: 'convertibles', headers: safeHeaders, headerRowNumber: 3,
    rows: [
      ['SAFE-1', 'Angel One', '2022-03-01', 100_000, 100_000, 8_000_000, 0, 'No', 'Outstanding', 'Post-Money'],
      ['', 'Angel Two', '2022-04-01', 15_000, 15_000, 'Uncapped', 0.2, 'Yes', 'Outstanding', 'Post-Money'],   // no id, same holder, amount and date
      ['SAFE-9', 'Angel Two', '2022-04-01', 15_000, 15_000, 'Uncapped', 0.2, 'Yes', 'Outstanding', 'Post-Money'], // new id: a genuinely new instrument
    ],
    mapping: { label: 0, stakeholderName: 1, issueDate: 2, principal: 3, valuationCap: 5, discount: 6, mfn: 7, status: 8, instrument: 9 },
  });
  const texts = (i: number) => safesAgain.rows[i].messages.map((m) => m.text).join(' ');
  assert.match(texts(0), /Instrument "SAFE-1" already exists/);
  assert.match(texts(1), /identical post-money SAFE .*already exists/);
  assert.equal(safesAgain.rows[2].status, 'ok');
  assert.equal(safesAgain.counts.willImport, 1);
  assert.equal(data.convertibles.find((c) => c.label === 'SAFE-3')?.status, 'CANCELLED');   // the reference is kept
});

// ---------------------------------------------------------------------------
// Workbooks: every tab considered
// ---------------------------------------------------------------------------

const EXPORT_TABS = {
  summary: ['Share Class', 'Authorized', 'Issued', 'Outstanding', 'Capital Contribution'],
  ownership: ['Stakeholder External ID', 'Stakeholder', 'Stakeholder Type', 'Common', 'Series Seed Preferred', 'Issued and Outstanding',
    'Issued and Outstanding % Ownership', '2022 Stock Plan', 'Awards Issued Outside of a Plan', 'Fully Diluted', 'Fully Diluted % Ownership'],
  common: ['Certificate ID', 'Stakeholder Name', 'Stakeholder External ID', 'Issue Date', 'Shares Issued', 'Shares Outstanding', 'Price Per Share',
    'Vesting Start Date', 'Vesting Schedule', 'Capital Contribution', 'Board Approval Date', 'Equity Plan Name', 'Comments'],
  plan: ['Certificate ID', 'Stakeholder Name', 'Grant Date', 'Expiration Date', 'Equity Plan', 'Grant Type', 'Exercise Price', 'Granted', 'Outstanding',
    'Vested', 'Exercised/Settled', 'Amount Cancelled', 'Board Approval Date', 'Share Class Name', 'Vesting Schedule', 'Vesting Start Date', 'Early Exercise'],
  convertibles: ['Convertible ID', 'Stakeholder', 'Grant Date', 'Principal Issued', 'Principal Outstanding', 'Interest Rate', 'Valuation Cap',
    'Conversion Discount', 'MFN', 'Maturity Date', 'Cancellation Date', 'Status', 'Conversion Type'],
  people: ['Name', 'External ID', 'Email', 'Type', 'Relationship', 'Address', 'City', 'Zip Code', 'State', 'Country', 'Termination Date', 'SSN', 'Comments'],
  voting: ['Stakeholder Name', 'Stakeholder External ID', 'Votes', 'Voting Ownership Percentage', '-'],
  summaryReal: [null, null, null, null, null, 'Authorized', 'Issued and Outstanding', 'Available Shares', null, 'Capital Contribution', null,
    'Issued and Outstanding % Ownership', null, 'Stock Options', 'Fully Diluted', 'Fully Diluted % Ownership', null] as (string | null)[],
};

test('sheet detection sorts a workbook\'s tabs into kinds and leaves summaries out', () => {
  assert.equal(detectSheet('Summary', EXPORT_TABS.summary, 5).kind, null);
  assert.match(detectSheet('Summary', EXPORT_TABS.summary, 5).reason!, /summary/i);
  const summary = detectSheet('Summary', EXPORT_TABS.summaryReal, 5);
  assert.equal(summary.kind, null);
  assert.match(summary.reason!, /no column for stakeholder.*Probably a summary/);          // "% Ownership" is not a stakeholder column
  const ownership = detectSheet('Ownership', EXPORT_TABS.ownership, 20);                  // name + type + numbers is a summary, not a list
  assert.equal(ownership.kind, null);
  assert.match(ownership.reason!, /summary/i);
  const voting = detectSheet('Voting Ownership', EXPORT_TABS.voting, 20);
  assert.equal(voting.kind, null);
  assert.match(voting.reason!, /summary/i);
  assert.equal(detectSheet('Sheet1', ['Name', 'Relationship'], 5).kind, null);            // no contact details, no telling name
  assert.equal(detectSheet('Team', ['Name', 'Email'], 5).kind, 'stakeholders');
  const common = detectSheet('CS-Common', EXPORT_TABS.common, 3);
  assert.equal(common.kind, 'captable');
  assert.deepEqual(common.constants, { shareClassName: 'Common' });
  assert.equal(common.mapping.quantity, 5);
  assert.equal(detectSheet('PSS-Series Seed Preferred', EXPORT_TABS.common, 13).constants.shareClassName, 'Series Seed Preferred');
  const plan = detectSheet('2022 Stock Plan', EXPORT_TABS.plan, 24);
  assert.equal(plan.kind, 'grants');                                                      // also covers certificates, but the name says plan
  assert.equal(plan.mapping.poolName, 4);
  assert.equal(detectSheet('Convertibles', EXPORT_TABS.convertibles, 9).kind, 'convertibles');
  const people = detectSheet('Stakeholders', EXPORT_TABS.people, 29);
  assert.equal(people.kind, 'stakeholders');
  assert.ok(!Object.values(people.mapping).includes(EXPORT_TABS.people.indexOf('SSN')));  // never mapped
  assert.equal(detectSheet('Sheet1', EXPORT_TABS.common, 0).kind, null);                  // header only
  // The caller's preference breaks ties when the name says nothing and both kinds fit.
  const ambiguous = ['Stakeholder Name', 'Grant Date', 'Grant Type', 'Granted', 'Exercise Price', 'Share Class Name'];
  assert.equal(detectSheet('Sheet1', ambiguous, 5, 'grants').kind, 'grants');
  // A lone sheet without a recognisable shape still comes back with a mapping for the preferred kind.
  const odd = detectSheet('Data', ['Person', 'Amount'], 5, 'stakeholders');
  assert.equal(odd.kind, null);
  assert.equal(odd.mapping.stakeholderName, null);
});

test('the plan size is read from a grant sheet\'s summary block', async () => {
  const { findPlanSize } = await import('../src/import/engine.ts');   // src is only imported after freshDatabase()
  const grants = [
    ['OPT-1', 'A', 'ISO', 812_400, '2023-05-10'],
    ['OPT-2', 'B', 'ISO', 64_150, '2024-01-15'],
    ['Total', '', '', 876_550, ''],
  ];
  assert.equal(findPlanSize([...grants, ['Summary of 2022 Stock Plan'], ['Authorized Shares', '', '', 1_250_000], ['Available for Issuance', '', '', 373_450]], 3), 1_250_000);
  assert.equal(findPlanSize([...grants, ['Available for Issuance', '', '', 373_450]], 3), 876_550 + 373_450);   // granted + available
  assert.equal(findPlanSize([...grants, ['Authorized', '1,250,000']], 3), 1_250_000);                          // formatted text
  assert.equal(findPlanSize(grants, 3), null);                                                                    // nothing stated
  assert.equal(findPlanSize([['Name', 'Authorized Signatory', 100]], 2), null);                                   // not a size line
});

test('a workbook is applied tab by tab in one transaction — later tabs see earlier ones, a dry run leaves nothing', async () => {
  const { insert, one } = await import('../src/db.ts');
  const { runWorkbook } = await import('../src/import/engine.ts');
  type WorkbookSheet = import('../src/import/engine.ts').WorkbookSheet;
  const { loadCompanyData } = await import('../src/store.ts');
  const companyId = 'co_workbook';
  const now = new Date().toISOString();
  await insert('companies', { id: companyId, name: 'Workbook Co', createdAt: now });
  await insert('share_classes', { id: 'sc_wb', companyId, name: 'Common', kind: 'COMMON', authorized: 16_000_000, parValue: 100, seniority: 0,
    originalIssuePrice: 100, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', conversionRatio: 1, dividendType: 'NONE',
    dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0,
    issueDate: '2021-01-01', isConvertible: 0, sortOrder: 0 });
  await insert('vesting_schedules', { id: 'vs_wb', companyId, name: '4 years, 1 year cliff, monthly', kind: 'TIME', durationMonths: 48,
    cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, accelerationSingle: 0, accelerationDouble: 0, createdAt: now });

  // Tabs in workbook order — the engine reorders them so people come first.
  const sheets: WorkbookSheet[] = [
    { sheetName: 'PSS-Series Seed Preferred', kind: 'captable' as const, headerRowNumber: 3,
      headers: ['Certificate ID', 'Stakeholder Name', 'Issue Date', 'Shares Outstanding', 'Price Per Share'],
      rows: [['PS-1', 'Kestrel Ventures II', '2023-06-01', 518_400, 0.4125], ['Total', '', '', 518_400, '']],
      mapping: { certificateNo: 0, stakeholderName: 1, issueDate: 2, quantity: 3, pricePerShare: 4, shareClassName: { value: 'Series Seed Preferred' } } },
    { sheetName: '2022 Stock Plan', kind: 'grants' as const, headerRowNumber: 3,
      headers: ['Certificate ID', 'Stakeholder Name', 'Grant Date', 'Equity Plan', 'Grant Type', 'Exercise Price', 'Granted', 'Vesting Schedule'],
      rows: [['OPT-1', 'Priya Raman', '2023-05-10', '2022 Stock Plan', 'ISO', 0.1, 64_150, '1/48 monthly, 25% vest at 12 month cliff']],
      mapping: { label: 0, stakeholderName: 1, grantDate: 2, poolName: 3, awardType: 4, strikePrice: 5, quantity: 6, vestingSchedule: 7 } },
    { sheetName: 'Stakeholders', kind: 'stakeholders' as const, headerRowNumber: 3,
      headers: ['Name', 'Email', 'Type', 'Relationship'],
      rows: [['Kestrel Ventures II', 'ir@kestrel.example', 'Institution', 'Investor'], ['Priya Raman', 'priya@example.com', 'Individual', 'Employee']],
      mapping: { stakeholderName: 0, email: 1, stakeholderType: 2, relation: 3 } },
  ];

  const dry = await runWorkbook(companyId, sheets, 'Tester', true);
  assert.deepEqual(dry.sheets.map((s) => s.sheetName), ['Stakeholders', 'PSS-Series Seed Preferred', '2022 Stock Plan']);
  assert.equal(dry.counts.total, 5);
  assert.equal(dry.counts.skipped, 1);
  assert.equal(dry.counts.willImport, 4);
  assert.deepEqual(dry.creates.stakeholders, ['Kestrel Ventures II', 'Priya Raman']);   // created once, by the people tab
  assert.deepEqual(dry.creates.shareClasses, ['Series Seed Preferred']);
  assert.deepEqual(dry.creates.pools, ['2022 Stock Plan']);
  assert.equal(dry.sheets[1].preview.rows[0].messages.some((m) => /Creates stakeholder/.test(m.text)), false);  // it already exists by then
  assert.equal(dry.imported.stakeholders, 2);
  assert.equal(dry.importIds.length, 3);
  // ...and yet nothing was written.
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM stakeholders WHERE company_id = ?', companyId))!.n, 0);
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM imports WHERE company_id = ?', companyId))!.n, 0);

  // A tab with a blocking error stops the whole file.
  const broken = sheets.map((s) => s.sheetName === '2022 Stock Plan' ? { ...s, rows: [...s.rows, ['OPT-2', 'Nobody', '2023-05-10', '2022 Stock Plan', 'Stock Option', 0.1, 10, '']] } : s);
  const dryBroken = await runWorkbook(companyId, broken, 'Tester', true);
  assert.equal(dryBroken.sheets[2].blocked, true);
  assert.equal(dryBroken.counts.willImport, 3);                                          // the blocked tab contributes nothing
  await assert.rejects(() => runWorkbook(companyId, broken, 'Tester', false), /"2022 Stock Plan" has 1 row with errors.*nothing was imported/);
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM stakeholders WHERE company_id = ?', companyId))!.n, 0);

  const committed = await runWorkbook(companyId, sheets, 'Tester', false);
  assert.deepEqual(committed.imported, { stakeholders: 2, shareClasses: 1, issuances: 1, awards: 1, convertibles: 0, vestingSchedules: 0, pools: 1 });
  const data = await loadCompanyData(companyId);
  const kestrel = data.stakeholders.find((s) => s.name === 'Kestrel Ventures II')!;
  assert.equal(kestrel.type, 'ENTITY');                                                  // from the people tab, not guessed
  assert.equal(kestrel.relation, 'INVESTOR');
  assert.equal(data.issuances[0].stakeholderId, kestrel.id);                             // the certificate found the person the people tab created
  const priya = data.stakeholders.find((s) => s.name === 'Priya Raman')!;
  assert.equal(data.awards[0].stakeholderId, priya.id);
  assert.equal(data.awards[0].vestingScheduleId, 'vs_wb');
  assert.equal(data.pools[0].name, '2022 Stock Plan');
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM imports WHERE company_id = ?', companyId))!.n, 3);
});
