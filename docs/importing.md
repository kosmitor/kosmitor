# Importing data

**Import data** in the sidebar — or the *Import* button and drop zone on the
cap table page itself — takes a CSV, XML or Excel (.xlsx) file, including exports
from other cap table tools, through a four-step wizard: upload, map columns,
review, import. XML can be a generic record export (one element per row, fields
as child elements or attributes) or Excel's "XML Spreadsheet 2003" format. Nothing is written until the review step, which checks
every row against the company and reports errors and warnings per row.

Four kinds of import: **cap table & certificates** (creates missing stakeholders
and share classes for you — names containing "preferred" or "series" become
preferred stock), **stakeholders**, **equity awards** and **SAFEs & notes**.
Column mapping is guessed from headers; values are read the way spreadsheets
write them — `$1,250,000`, `20%`, `Jan 15, 2024`, `01/15/2024`, Excel date
serials, `Yes`/`No` — and vesting accepts schedule names or shorthand like
`4y/1y monthly`. Templates for each kind are downloadable from the wizard.
Everything from one file lands in a single database transaction.

All three parsers are dependency-free: an RFC 4180 CSV reader; a minimal ZIP +
SpreadsheetML reader over `node:zlib` (shared strings, inline strings,
booleans, and date-formatted numbers resolved through the workbook styles); and
a small forgiving XML parser (comments, CDATA, entities, namespace prefixes).

## Checking the math against a Pulley or Carta export

`npm run reconcile` reads an export the way the import wizard does (the same
sheet detection, column mapping and row checks) into a company held in memory,
computes the cap table as of the export's date, and compares it with the
export's own figures. Nothing is written to any database and no company is touched.

```bash
npm run reconcile -- ~/Downloads/stakeholders.xlsx ~/Downloads/cap-table.xlsx
npm run sample -- --files-only && npm run reconcile -- apps/server/samples/marlowe-*.xlsx   # the fictional sample
```

Give it every file of the export: the stakeholder report (termination dates
matter) and the cap table workbook, or the CSVs. It compares at five levels:

- **internal checks**: the export's summary against its own ledgers and plan
  footer, and the app's table against itself (fully diluted adds up, percentages
  sum to 100%, vested + unvested = outstanding);
- **class totals**: outstanding, available and capital contribution per class,
  plan size and available shares, options outstanding, fully diluted, SAFEs;
- **holder × class**: shares per class, options, fully diluted, votes, SAFE principal;
- **grants**: outstanding, exercised, cancelled, vested, unvested, exercise price, expiration;
- **percentages**, last: fully diluted, outstanding and voting, to the export's display rounding.

Every difference gets a cause: **import mapping** (the data came in wrong, or the
export leaves out something the import had to assume), **known bug** with its ID
from the math audit (CAP-4 for a holder who left, CAP-8 for reserved shares,
CAP-1 for a past date, …), **definition** (both right under different
definitions), **source system** (the export is wrong or does not add up), or
**unexplained**, which is a possible new bug. A total that differs only because
the lines under it do takes their cause and says so. The run passes when nothing
is unexplained, and exits with 1 otherwise.

`report.md` and `differences.csv` (one row per difference: level, key, field,
export value, app value, difference, cause, bug ID, note, where the export
states it) go to `data/reconcile/<company>/<as-of>/`, or to `--out <dir>`.
`data/` is ignored by git and left out of the Docker image. The console prints
counts, causes and bug IDs only.

| Option | |
|---|---|
| `--as-of YYYY-MM-DD` | compare on another date than the export's |
| `--figures <file>` | take the figures from another export without importing its ledgers: a past-dated export checked against today's ledgers shows where history views go wrong (CAP-1) |
| `--no-pool`, `--with-convertibles` | match how the export counts fully diluted |
| `--date-order MDY\|DMY` | read an ambiguous date such as 03/04/2024 |
| `--company`, `--source` | when the export does not say |

Exports state no post-termination exercise window, so every grant gets
`equity.postTerminationExerciseMonths`; a grant without an expiration date gets
`equity.optionTermYears`; authorized shares are taken from the export's summary
when it has them, since the import sizes a new class to the shares it issues.

A real export holds real people's holdings. Keep the files and the report on
your own machine, never commit them or paste them anywhere, and never turn a
real row into a test: rebuild the case with invented names, as
`apps/server/test/reconcile.test.ts` does.
