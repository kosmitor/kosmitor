/**
 * The reconcile tool: it reads an export through the import code into a company
 * held in memory, computes the cap table and accounts for every difference with
 * the export's own figures. Every company here is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';

await freshDatabase();
const { reconcile } = await import('../src/reconcile/index.ts');
const { writeReport, summaryLines } = await import('../src/reconcile/report.ts');
const { buildWorkbooks, SAMPLE_TOTALS, SAMPLE_AS_OF } = await import('../src/sample.ts');
const { xlsx } = await import('../src/xlsx-writer.ts');
const { all } = await import('../src/db.ts');

type Cell = string | number | boolean | null | undefined;
const sample = () => {
  const { stakeholderReport, capTable } = buildWorkbooks();
  return [{ name: 'marlowe-stakeholder-report.xlsx', body: stakeholderReport }, { name: 'marlowe-cap-table.xlsx', body: capTable }];
};

test('the sample export reconciles at every level with nothing unexplained, and nothing reaches the database', async () => {
  const r = await reconcile(sample());
  assert.equal(r.asOf, SAMPLE_AS_OF);
  assert.equal(r.company, 'Marlowe Systems, Inc.');
  assert.deepEqual(r.differences.filter((d) => d.category === 'unexplained'), []);
  assert.equal(r.passed, true);
  for (const level of ['internal', 'class', 'holder', 'grant', 'percent'] as const) assert.ok(r.counts[level].compared > 0, `${level} was compared`);
  assert.equal(r.differences.length, 0, JSON.stringify(r.differences, null, 1));
  assert.equal(r.imported.errors, 0);
  assert.equal(r.table.totals.fullyDiluted, SAMPLE_TOTALS.fullyDiluted);
  assert.equal(r.table.totals.optionsOutstanding, SAMPLE_TOTALS.optionsOutstanding);
  assert.equal(r.table.totals.poolAvailable, SAMPLE_TOTALS.poolAvailable);
  assert.deepEqual(r.sheets.map((s) => s.use).sort(), ['imported as captable', 'imported as captable', 'imported as convertibles', 'imported as grants', 'imported as stakeholders', 'ownership table', 'summary']);
  for (const table of ['companies', 'stakeholders', 'share_classes', 'issuances', 'awards', 'convertibles', 'imports']) {
    assert.equal((await all(`SELECT id FROM ${table}`)).length, 0, `${table} stays empty`);
  }
});

test('a figure the app does not reproduce is left unexplained, and the totals over it follow', async () => {
  const people = [['Name', 'Email', 'Type', 'Relationship'], ['Ines Corvo', 'ines@corvo.example', 'Individual', 'Founder'], ['Pell Arno', 'pell@arno.example', 'Individual', 'Employee']];
  const cap = (options: number) => xlsx([
    { name: 'Summary', rows: [['Testco, Inc.'], ['Cap table as of', '2026-09-22'], [], ['Security', 'Shares Outstanding'], ['Common', 1_000_000], ['Options Outstanding', options], ['Available for Issuance', 52_000], ['Fully Diluted Shares', 1_000_000 + options + 52_000]] },
    { name: 'Common', rows: [['Stakeholder', 'Certificate ID', 'Shares Outstanding', 'Price Per Share', 'Issue Date'], ['Ines Corvo', 'CS-1', 1_000_000, 0.0001, '2024-01-01']] },
    { name: '2024 Stock Plan', rows: [['Stakeholder', 'Grant ID', 'Type', 'Options Granted', 'Exercise Price', 'Grant Date', 'Vesting Start Date', 'Vesting Schedule'],
      ['Pell Arno', 'OPT-1', 'ISO', 48_000, 0.1, '2024-01-01', '2024-01-01', '4y/1y monthly'], [], ['Authorized Shares', 100_000], ['Available for Issuance', 52_000]] },
  ]);
  const files = (options: number) => [{ name: 'people.xlsx', body: xlsx([{ name: 'Stakeholders', rows: people }]) }, { name: 'cap.xlsx', body: cap(options) }];

  assert.equal((await reconcile(files(48_000))).differences.length, 0);
  const r = await reconcile(files(48_001));
  assert.equal(r.passed, false);
  const options = r.differences.find((d) => d.level === 'class' && d.field === 'options and RSUs outstanding')!;
  assert.deepEqual([options.source, options.app, options.difference, options.category, options.root], [48_001, 48_000, -1, 'unexplained', true]);
  const fd = r.differences.find((d) => d.field === 'fully diluted')!;
  assert.deepEqual([fd.category, fd.root], ['unexplained', false]);
  assert.match(summaryLines(r).join('\n'), /2 unexplained/);
});

test('a holder who left: the app returns the unvested options to the plan, a definition difference, never unexplained', async () => {
  const people = [['Name', 'Email', 'Type', 'Relationship', 'Termination Date'],
    ['Rowan Vale', 'rowan@vale.example', 'Individual', 'Former employee', '2026-08-31'], ['Ines Corvo', 'ines@corvo.example', 'Individual', 'Founder', null]];
  // Rowan's 48,000 options vest monthly from 2024-01-01: 31,000 by the day he left. The export counts those alone.
  const cap = xlsx([
    { name: 'Summary', rows: [['Testco, Inc.'], ['Cap table as of', '2026-09-22'], [], ['Security', 'Shares Outstanding'], ['Common', 1_000_000], ['Options Outstanding', 31_000], ['Available for Issuance', 52_000], ['Fully Diluted Shares', 1_083_000]] },
    { name: 'Common', rows: [['Stakeholder', 'Certificate ID', 'Shares Outstanding', 'Price Per Share', 'Issue Date'], ['Ines Corvo', 'CS-1', 1_000_000, 0.0001, '2024-01-01']] },
    { name: '2024 Stock Plan', rows: [['Stakeholder', 'Grant ID', 'Type', 'Options Granted', 'Exercise Price', 'Grant Date', 'Vesting Start Date', 'Vesting Schedule', 'Outstanding', 'Vested'],
      ['Rowan Vale', 'OPT-1', 'ISO', 48_000, 0.1, '2024-01-01', '2024-01-01', '4 years, 1 year cliff, monthly', 31_000, 31_000], [], ['Authorized Shares', 100_000], ['Available for Issuance', 52_000]] },
  ]);
  const r = await reconcile([{ name: 'people.xlsx', body: xlsx([{ name: 'Stakeholders', rows: people }]) }, { name: 'cap.xlsx', body: cap }]);
  assert.equal(r.passed, true, JSON.stringify(r.differences.filter((d) => d.category === 'unexplained'), null, 1));
  // Since CAP-4 the grant matches: 31,000 outstanding. The plan, though, gets the 17,000 lapsed options back in
  // the app on the day Rowan left, while the export's plan does not until a cancellation is recorded.
  assert.equal(r.differences.find((d) => d.level === 'grant'), undefined);
  const plan = r.differences.find((d) => d.key === 'plan: 2024 Stock Plan' && d.field === 'available')!;
  assert.deepEqual([plan.source, plan.app, plan.category, plan.bug, plan.root], [52_000, 69_000, 'definition', null, true]);
  assert.match(plan.note, /returns the 17,000 unvested options of holders who left to the plan/);
  for (const d of r.differences.filter((x) => x.level !== 'internal')) assert.equal(d.category, 'definition', `${d.key} ${d.field}: ${d.note}`);
});

test('a row the import cannot read is an import mapping difference, and so is everything it moves', async () => {
  const cap = xlsx([
    { name: 'Common', rows: [['Stakeholder', 'Certificate ID', 'Shares Outstanding', 'Price Per Share', 'Issue Date'], ['Ines Corvo', 'CS-1', 1_000_000, 0.0001, '2024-01-01'], ['Pell Arno', 'CS-2', 50_000, 0.0001, 'someday']] },
    { name: 'Summary', rows: [['Security', 'Shares Outstanding'], ['Common', 1_050_000]] },
  ]);
  const r = await reconcile([{ name: 'cap.xlsx', body: cap }], { asOf: '2026-09-22' });
  assert.equal(r.passed, true);
  assert.deepEqual(r.differences.map((d) => `${d.level}:${d.category}`).sort(), ['class:import mapping', 'holder:import mapping', 'import:import mapping']);
  const row = r.differences.find((d) => d.level === 'import')!;
  assert.match(row.note, /"someday" is not a date/);
});

// ---------------------------------------------------------------------------
// The layout of a real Pulley export, with invented figures
// ---------------------------------------------------------------------------

/**
 * Halvard Labs, laid out tab for tab like a Pulley export: title blocks above
 * the headers, one tab per class named "CS-Common" and "PSS-…", a plan tab with
 * the plan size under the grants, a summary whose class names sit in the first
 * column, ownership and voting tables, percentages shown to two decimals, and a
 * seed price shown to four. Two things differ on purpose: the summary's
 * "available" common shares set the plan's reserve aside (CAP-8), and the seed's
 * capital contribution is the amount paid, not shares × the rounded price.
 */
function halvard(): { name: string; body: Buffer }[] {
  const title = (tab: string): Cell[][] => [[tab, 'Pulley'], ['As of Sept 16, 2026'], []];
  const pct = (n: number, of: number) => Number(((n / of) * 100).toFixed(2));
  const issued = 8_817_500 + 2_424_242;
  const fd = issued + 312_500 + 1_170_000;
  const people: Cell[][] = [
    ['Name', 'External ID', 'Email', 'Type', 'Relationship', 'Address', 'City', 'Zip Code', 'State', 'Country', 'Termination Date', 'SSN', 'Comments'],
    ['Maren Holt', 'H-1', 'maren@halvard.example', 'Individual', 'Founder', null, null, null, 'CA', 'US', null, null, null],
    ['Tobias Wren', 'H-2', 'tobias@halvard.example', 'Individual', 'Founder', null, null, null, 'CA', 'US', null, null, null],
    ['Lio Barros', 'H-3', 'lio@halvard.example', 'Individual', 'Employee', null, null, null, 'NY', 'US', null, null, null],
    ['Sefa Mensah', 'H-4', 'sefa@mail.example', 'Individual', 'Former Employee', null, null, null, 'WA', 'US', '2026-03-31', null, null],
    ['Northwind Seed Fund I, L.P.', 'H-5', 'ir@northwind.example', 'Institution', 'Investor', null, null, null, 'DE', 'US', null, null, null],
    ['Cormac Ide', 'H-6', 'cormac@mail.example', 'Individual', 'Investor', null, null, null, 'TX', 'US', null, null, null],
  ];
  const certHeader = ['Certificate ID', 'Stakeholder Name', 'Stakeholder External ID', 'Issue Date', 'Shares Issued', 'Shares Outstanding', 'Price Per Share', 'Vesting Start Date', 'Vesting Schedule', 'Capital Contribution', 'Board Approval Date', 'Equity Plan Name', 'Comments'];
  const founders = '1/48 monthly, 25% vest at 12 month cliff';
  const common: Cell[][] = [...title('CS-Common'), certHeader,
    ['CS-1', 'Maren Holt', 'H-1', 'Feb 1, 2024', 5_000_000, 5_000_000, 0.0001, '2024-02-01', founders, 500, '2024-02-01', null, null],
    ['CS-2', 'Tobias Wren', 'H-2', 'Feb 1, 2024', 4_000_000, 3_800_000, 0.0001, '2024-02-01', founders, 380, '2024-02-01', null, 'Partly repurchased'],
    ['CS-3', 'Lio Barros', 'H-3', '2026-01-10', 7_500, 7_500, 0.05, null, null, 375, '2024-06-03', '2024 Equity Incentive Plan', 'Exercise of OPT-1'],
    ['CS-4', 'Sefa Mensah', 'H-4', '2026-05-15', 10_000, 10_000, 0.05, null, null, 500, '2024-09-02', '2024 Equity Incentive Plan', 'Exercise of OPT-2'],
    ['Total', null, null, null, 9_017_500, 8_817_500, null, null, null, 1_755, null, null, null]];
  const seed: Cell[][] = [...title('PSS-Series Seed Preferred'), certHeader,
    ['PSS-1', 'Northwind Seed Fund I, L.P.', 'H-5', '2025-03-03', 2_424_242, 2_424_242, 0.4125, null, null, 1_000_000, '2025-03-01', null, null],
    ['Total', null, null, null, 2_424_242, 2_424_242, null, null, null, 1_000_000, null, null, null]];
  const plan: Cell[][] = [...title('2024 Equity Incentive Plan'),
    ['Certificate ID', 'Stakeholder Name', 'Grant Date', 'Expiration Date', 'Equity Plan', 'Grant Type', 'Exercise Price', 'Granted', 'Outstanding', 'Vested', 'Unvested',
      'Vested Exercised/Settled', 'Exercised/Settled', 'Amount Cancelled', 'Board Approval Date', 'Share Class Name', 'Vesting Schedule', 'Vesting Start Date', 'Early Exercise'],
    ['OPT-1', 'Lio Barros', '2024-06-03', '2034-06-03', '2024 Equity Incentive Plan', 'ISO', 0.05, 120_000, 112_500, 67_500, 52_500, 7_500, 7_500, 0, '2024-06-03', 'Common', founders, '2024-06-01', 'No'],
    ['OPT-2', 'Sefa Mensah', '2024-09-02', '2034-09-02', '2024 Equity Incentive Plan', 'ISO', 0.05, 60_000, 0, 22_500, 0, 10_000, 10_000, 50_000, '2024-09-02', 'Common', founders, '2024-09-01', 'No'],
    ['OPT-3', 'Maren Holt', '2025-01-15', '2035-01-15', '2024 Equity Incentive Plan', 'NSO', 0.1, 200_000, 200_000, 83_333, 116_667, 0, 0, 0, '2025-01-15', 'Common', founders, '2025-01-15', 'No'],
    ['Total', null, null, null, null, null, null, 380_000, 312_500, null, null, null, 17_500, 50_000],
    [], ['Summary of 2024 Equity Incentive Plan'], ['Authorized Shares', null, null, null, null, null, null, 1_500_000], ['Available for Issuance', null, null, null, null, null, null, 1_170_000]];
  const convertibles: Cell[][] = [...title('Convertibles'),
    ['Convertible ID', 'Stakeholder', 'Grant Date', 'Principal Issued', 'Principal Outstanding', 'Interest Rate', 'Valuation Cap', 'Conversion Discount', 'MFN', 'Maturity Date', 'Cancellation Date', 'Status', 'Conversion Type'],
    ['SAFE-1', 'Cormac Ide', '2025-06-01', 150_000, 150_000, 0, 12_000_000, 0, 'No', null, null, 'Outstanding', 'Post-Money'],
    ['SAFE-2', 'Northwind Seed Fund I, L.P.', '2024-11-01', 250_000, 0, 0, 10_000_000, 0, 'No', null, '2025-03-03', 'Cancelled', 'Post-Money']];
  const summary: Cell[][] = [['Halvard Labs, Inc.'], ['Pulley'], ['As of Sept 16, 2026'], [],
    [null, null, null, null, null, 'Authorized', 'Issued and Outstanding', 'Available Shares', null, 'Capital Contribution', null, 'Issued and Outstanding % Ownership', null, 'Stock Options', 'Fully Diluted', 'Fully Diluted % Ownership', null],
    ['Common', null, null, null, null, 12_000_000, 8_817_500, 1_700_000, null, 1_755, null, pct(8_817_500, issued), null, null, 8_817_500, pct(8_817_500, fd), null],
    ['Series Seed Preferred', null, null, null, null, 2_424_242, 2_424_242, 0, null, 1_000_000, null, pct(2_424_242, issued), null, null, 2_424_242, pct(2_424_242, fd), null],
    ['2024 Equity Incentive Plan', null, null, null, null, 1_500_000, null, 1_170_000, null, null, null, null, null, 312_500, 1_482_500, pct(1_482_500, fd), null],
    ['Total', null, null, null, null, null, issued, null, null, 1_001_755, null, 100, null, 312_500, fd, 100, null]];
  const holders: [string, string, number, number, number][] = [
    ['Maren Holt', 'Individual', 5_000_000, 0, 200_000], ['Tobias Wren', 'Individual', 3_800_000, 0, 0], ['Lio Barros', 'Individual', 7_500, 0, 112_500],
    ['Sefa Mensah', 'Individual', 10_000, 0, 0], ['Northwind Seed Fund I, L.P.', 'Institution', 0, 2_424_242, 0],
  ];
  const ownership: Cell[][] = [...title('Ownership'),
    ['Stakeholder External ID', 'Stakeholder', 'Stakeholder Type', 'Common', 'Series Seed Preferred', 'Issued and Outstanding', 'Issued and Outstanding % Ownership', '2024 Equity Incentive Plan', 'Awards Issued Outside of a Plan', 'Fully Diluted', 'Fully Diluted % Ownership'],
    ...holders.map(([name, type, c, s, o], i): Cell[] => [`H-${i + 1}`, name, type, c, s, c + s, pct(c + s, issued), o, 0, c + s + o, pct(c + s + o, fd)]),
    [null, 'Options Available for Issuance', null, null, null, null, null, 1_170_000, null, 1_170_000, pct(1_170_000, fd)],
    [null, 'Total', null, 8_817_500, 2_424_242, issued, 100, 1_482_500, 0, fd, 100]];
  const voting: Cell[][] = [...title('Voting Ownership'), ['Stakeholder Name', 'Stakeholder External ID', 'Votes', 'Voting Ownership Percentage', '-'],
    ...holders.map(([name, , c, s], i): Cell[] => [name, `H-${i + 1}`, c + s, pct(c + s, issued), null])];
  return [
    { name: 'Halvard Labs - Stakeholders.xlsx', body: xlsx([{ name: 'Stakeholders', rows: people }]) },
    { name: 'Halvard Labs - Cap Table.xlsx', body: xlsx([{ name: 'Summary', rows: summary }, { name: 'Ownership', rows: ownership }, { name: 'Voting Ownership', rows: voting },
      { name: 'CS-Common', rows: common }, { name: 'PSS-Series Seed Preferred', rows: seed }, { name: '2024 Equity Incentive Plan', rows: plan }, { name: 'Convertibles', rows: convertibles }]) },
  ];
}

test('an export laid out like Pulley\'s is read tab for tab and every difference is accounted for', async () => {
  const r = await reconcile(halvard());
  assert.equal(r.asOf, '2026-09-16');
  assert.equal(r.system, 'Pulley');
  assert.equal(r.company, 'Halvard Labs, Inc.');
  assert.equal(r.imported.errors, 0);
  assert.deepEqual(Object.fromEntries(r.sheets.map((s) => [s.sheet, s.use])), {
    Stakeholders: 'imported as stakeholders', 'CS-Common': 'imported as captable', 'PSS-Series Seed Preferred': 'imported as captable',
    '2024 Equity Incentive Plan': 'imported as grants', Convertibles: 'imported as convertibles',
    Summary: 'summary', Ownership: 'ownership table', 'Voting Ownership': 'voting table',
  });
  for (const level of ['internal', 'class', 'holder', 'grant', 'percent'] as const) assert.ok(r.counts[level].compared > 0, `${level} was compared`);
  assert.equal(r.passed, true, JSON.stringify(r.differences.filter((d) => d.category === 'unexplained'), null, 1));
  const found = r.differences.map((d) => `${d.key} / ${d.field}: ${d.category}${d.bug ? ` ${d.bug}` : ''}`).sort();
  // The export keeps only the plan's 1,482,500 shares back from common; since CAP-8 the app also keeps the
  // 2,424,242 the Series Seed converts into.
  assert.deepEqual(found, ['Common / available: definition', 'Series Seed Preferred / capital contribution: import mapping']);
  assert.match(r.differences.find((d) => d.key === 'Common')!.note, /sets aside only the plan's 1,482,500 shares; the app also keeps 2,424,242 reserved for what preferred converts into/);
  assert.equal(r.table.totals.fullyDiluted, 8_817_500 + 2_424_242 + 312_500 + 1_170_000);
});

test('the report and the CSV list every difference, and the console summary names nobody', async () => {
  const r = await reconcile(halvard());
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  try {
    const paths = writeReport(r, dir);
    const md = readFileSync(paths.report, 'utf8');
    assert.match(md, /^# Reconciliation: Halvard Labs, Inc\. as of 2026-09-16/);
    assert.match(md, /\| Result \| \*\*Pass\*\*/);
    assert.match(md, /No known bug is behind any difference\./);
    const csv = readFileSync(paths.csv, 'utf8').trim().split('\r\n');
    assert.equal(csv[0], 'level,key,field,source_value,app_value,difference,category,bug_id,note,where,follows_from_others');
    assert.equal(csv.length, 1 + r.differences.length);
    assert.ok(csv.some((l) => l.startsWith('class,Common,available,1700000,-724242,-2424242,definition,,')), csv.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const console = summaryLines(r).join('\n');
  for (const name of ['Maren', 'Tobias', 'Lio', 'Sefa', 'Northwind', 'Cormac', 'Halvard']) assert.ok(!console.includes(name), `${name} stays out of the console`);
  assert.doesNotMatch(console, /8,817,500|8817500|2,424,242/);
});

test('a past-dated export checked against today\'s ledgers puts the later exercise down to CAP-1', async () => {
  // Today's ledgers record Lio's 7,500 exercised options; an export as of 2025-12-31, before the exercise, shows all 120,000 outstanding.
  const before = xlsx([
    { name: 'Summary', rows: [['Halvard Labs, Inc.'], ['As of Dec 31, 2025'], [], ['Security', 'Shares Outstanding'], ['Options Outstanding', 380_000]] },
    { name: '2024 Equity Incentive Plan', rows: [['Certificate ID', 'Stakeholder Name', 'Grant Date', 'Equity Plan', 'Grant Type', 'Exercise Price', 'Granted', 'Outstanding', 'Exercised/Settled', 'Amount Cancelled', 'Vesting Schedule', 'Vesting Start Date'],
      ['OPT-1', 'Lio Barros', '2024-06-03', '2024 Equity Incentive Plan', 'ISO', 0.05, 120_000, 120_000, 0, 0, '1/48 monthly, 25% vest at 12 month cliff', '2024-06-01'],
      ['OPT-2', 'Sefa Mensah', '2024-09-02', '2024 Equity Incentive Plan', 'ISO', 0.05, 60_000, 60_000, 0, 0, '1/48 monthly, 25% vest at 12 month cliff', '2024-09-01'],
      ['OPT-3', 'Maren Holt', '2025-01-15', '2024 Equity Incentive Plan', 'NSO', 0.1, 200_000, 200_000, 0, 0, '1/48 monthly, 25% vest at 12 month cliff', '2025-01-15']] },
  ]);
  const r = await reconcile(halvard(), { figures: [{ name: 'Halvard Labs - Cap Table 2025-12-31.xlsx', body: before }] });
  assert.equal(r.asOf, '2025-12-31');
  assert.equal(r.dataAsOf, '2026-09-16');
  const lio = r.differences.find((d) => d.level === 'grant' && d.key.startsWith('OPT-1') && d.field === 'outstanding');
  assert.equal(lio?.bug, 'CAP-1', JSON.stringify(r.differences, null, 1));
  assert.equal(r.passed, true, JSON.stringify(r.differences.filter((d) => d.category === 'unexplained'), null, 1));
});

test('interest a note has accrued is compared where the export states it, and a 365-day count is put down to CR-5', async () => {
  // $1,000,000 at 6% simple for a year to the day: $60,000 counted over 365 days.
  const cap = xlsx([
    { name: 'Summary', rows: [['Testco, Inc.'], ['Cap table as of', '2026-09-16']] },
    { name: 'Convertibles', rows: [['Convertible ID', 'Stakeholder', 'Instrument', 'Issue Date', 'Principal', 'Interest Rate', 'Interest Accrued', 'Valuation Cap', 'Maturity Date', 'Status'],
      ['NOTE-1', 'Quarry Bridge Capital', 'Convertible note', '2025-09-16', 1_000_000, '6%', 60_000, 20_000_000, '2027-09-16', 'Outstanding']] },
  ]);
  const r = await reconcile([{ name: 'cap.xlsx', body: cap }]);
  assert.equal(r.imported.convertibles, 1);
  assert.equal(r.passed, true, JSON.stringify(r.differences, null, 1));
  const interest = r.comparisons.find((c) => c.field === 'accrued interest')!;
  assert.equal(interest.source, 6_000_000);
  // Once CR-5 is fixed the two agree; until then the difference is CR-5.
  if (interest.differs) assert.equal(interest.explanation?.bug, 'CR-5');
});
