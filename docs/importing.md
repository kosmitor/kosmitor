# Importing data

**Import data** in the sidebar, the *Import* buttons on the cap table, stakeholder,
certificate, grant and SAFE pages, the drop zone of an empty cap table, the line
on an empty overview and "Create the company and import your cap table" on
company setup all lead to one flow of three screens: **Upload**, **Check your
import**, **Done** (`/import`, `/import/check`, `/import/done`).

## Upload

The drop zone comes first. Drop one file or several, or choose them (on a phone
it says only "Choose files"): Excel (.xlsx), CSV or XML, including the exports of
other cap table tools as they are, or an Open Cap Format package (.ocf.zip, or its
manifest and JSON files dropped together; see [OCF packages](#ocf-packages)). A
Pulley export is two files, the stakeholder report and the cap table workbook;
drop them together. Under the zone,
**Download a template ▾** offers one Excel workbook with a tab per kind and a
"How to fill this in" tab, then a CSV per kind (headers only), then the XML
versions. **Past imports** lists what was imported before, one line per import.

A file that cannot be read (a Word document, an image, an old .xls, a damaged
workbook, a file over the size limit) is named inside the drop zone, which turns
red; the files that can be read go on. A PDF is not read as a table: it opens
**Save this PDF as a document**, which files it in Documents linked to a
stakeholder and one of their instruments. Dropped with spreadsheets, it is listed
on the check screen with a *Save it as a document* button.

Coming from a page's *Import* button (`/import?kind=grants`) changes only the
subtitle, puts that kind's template first, and makes Done lead back to that page;
each tab is still recognised on its own. Files dropped on an empty cap table skip
Upload and open the check directly.

## Check your import

Each file is read, every tab is sorted into what it holds (stakeholders,
certificates, equity grants, SAFEs and notes; summary and ownership tabs are left
out with the reason) and its columns are matched from the headers. The whole
import then runs as a dry run right away, so every row is checked against the
company exactly as it would be saved, and runs again a moment after any change.
From the top:

- **How the files were read**: the file names, and "dates read as day/month" or
  "numbers read as 1.234,56" when that matters, with a link to **Import settings**.
- **Needs your answer**: one card per cause, not per row. A card fixes every row
  it names at once: what a tab holds when nothing recognised it; which column has
  a required field (or one value for every row: "Common"); which equity plan the
  grants are from (or a new plan by name); the vesting schedule for grants that
  name none; whether "Option" means ISO or NSO; what to read a value nobody
  recognises as ("Advisor/Board" → Advisor); which of two people of one name a
  row without an email means; how a file writes dates or numbers when it does
  both; and, without blocking, the cap table's own warnings after the import,
  such as a class with more shares than it has authorized (*Raise to N*).
- **What this adds**: one sentence: certificates, grants, SAFEs and notes, new
  stakeholders, people updated, new share classes and plans, rows already there.
- **New stakeholders**: the people the import creates without a relationship (the
  file has no column for it), each with a choice of Founder, Employee, Advisor
  and the rest, and people of one name with two emails (*Same person* / *Two
  people*). Adding the stakeholder report to the same import answers it from the
  report.
- **One table per tab**, in the order they are applied. Rows that need attention
  show first (*Needs attention* | *All*); a long tab shows five rows and *Show
  all*. Each row says what happens to it: Add, Update, Already there, Check (a
  warning, which does not block), Fix (an error), Left out, Skipped (a total or
  section line). A row's messages sit under it, with **Edit row** (its imported
  fields as text, the bad one first; changes apply to this import, not to the
  file) and **Leave out**; an update says what it changes ("relationship Employee
  → Advisor"). A row that only waits for a card's answer says so, without
  buttons: the card fixes it. A row left out stays in place with why, and **Put
  it back**. **Columns** opens the tab's mapping: what it holds,
  its header row, which column feeds each field, the file's columns that are not
  imported, and the fields nothing fills yet. Columns no field reads are listed
  under the tab.
- **Not imported**: the tabs left out, each a link to bring it in.
- **We filled in N things your file doesn't say**: the assumptions, grouped, each
  with *Show rows*.

A bar pinned to the bottom always says what will happen ("57 rows ready · 3 to
check", or "1 question and 2 rows to fix · 41 ready") and holds **Import**, which
waits until every question is answered and every row with an error is fixed or
left out. When the files bring nothing new, it leads back to the page the import
started from instead. **Leave out N rows** leaves out, for this import only, the rows with an
error of their own (a row that waits only for a question's answer is not one of
them); *Fix them instead* puts them back, and so does *Put it back* on a row.

**Import settings** hold what the import otherwise decides: the date order and
number format of each file (with what in the file decided it), whether to add
stakeholders and share classes that do not exist yet, the vesting schedule for
grants that name none and, separately, for certificates that name none (without
one they are fully vested), and the equity plan for grants that name none (an
existing plan, or a new one by name).

**Add a file** brings another file into the same import; **Choose different
files** starts again (and asks first when answers or edits would be lost, as the
browser's Back button and the *Import data* link do; closing or reloading the
page asks the browser's own question). Reloading the check loses the files, which
live only in the page: it returns to Upload and says so. Choosing another company
in the sidebar clears the import, since every answer was for the company before.

## Done

What was added, what was updated (with what changed, "relationship, start
date"), which classes were raised, which rows were already on the cap table and
skipped, and which were left out, with **Download them (.csv)**: the file's own
cells plus a Problem column, to fix and import again. *Worth a look* links to new
share classes, plans and stakeholders, and the main button leads back to the page
the import started from.

## What an import does

Nothing is saved until **Import** is pressed, and then everything lands in one
database transaction or nothing does — every file dropped together, applied in
dependency order whatever order the files came in: people first, then share
classes and certificates, then grants, then SAFEs and notes. People are matched
across files, so the cap table's holders are the stakeholder report's people,
with their relationships and termination dates. If the company changed between
the check and the import, the import is refused and the page checks again.

Four kinds of records: **stakeholders**, **cap table & certificates** (missing
stakeholders and share classes are created — names containing "preferred" or
"series" become preferred stock), **equity grants** and **SAFEs & notes**.
A relationship that reads as a board member or director ("Board Director") also
gives the stakeholder a board seat, over the row's start and termination dates:
the seat, not the relationship, makes someone a director. An existing stakeholder
gets one only when the file makes them a board member; one who already was keeps
the seat on file, or its absence. A board observer or a "director of" job title
is not read as a board member.

**Importing again is safe.** A row that is already on the cap table is
recognised and skipped ("Already on the cap table"), numbered or not: a
certificate by its holder, class, shares and issue date, a grant by its holder,
type, shares and grant date, a SAFE or note by its holder, instrument, amount and
date (and by its certificate, grant or instrument number when it has one). Each
record answers for one row, so a file with two identical rows needs two such
records before both are skipped: import a file with one of them left out, then
the whole file again, and the second is added. Fix a file and import it again,
and only the rows that were missing land.

Corrections to rows that are already there are flagged, not applied. A row that
matches a record but gives another price, vesting schedule, strike, plan,
expiration, cap or discount says so ("Price per share is $1.00 on the cap table
and $0.0001 in the file") and changes nothing: correct the record on its page. A
row that is added but looks like a record no row of the file matched — the same
holder and date with another share count, another class, award type or
instrument (a file imported again with another answer to "ISO or NSO?"), or the
same contents under another number — says so too, so the page can offer to
leave it out. A number already used by a *different* record is still an
error. A person the file lists again is updated with what changed ("relationship
Employee → Founder"), or skipped as already up to date; a person on file without
an email gets the one a row gives them.

**People.** A row is matched to a person by email first, then by name. A row
with no email whose name belongs to two or more people (on file, or created by
this import) is not given to any of them: it asks which, by email. A row whose
email nobody has, naming someone who has another email, is a new person with a
warning that two people of that name will exist.

**How a file is read.**

- **Dates.** A date written like 03/04/2024 reads two ways. The order is decided
  once per file, from a date only one order can read (15/01/2024 is day first),
  so every date of the file is read the same way; with no such date,
  `locale.importDateOrder` decides (month first by default). When the tabs of
  one workbook disagree (kept by different people), each tab decides from its
  own dates. A tab that has both kinds is read month first, and each of its
  dates that reads two ways is flagged with the other reading until the date
  order is set. Excel date cells carry no order and are read as they are.
- **Numbers.** 1.234,56 and 1,234.56 are both read. A value only one way can read
  ("0,0001", "1.250.000", "1,234.56") decides for its sheet; a CSV separated by
  semicolons is taken as European; otherwise `locale.locale` decides. A share
  count, amount or price like "500.000" in a file read as 1,234.56 gets a
  warning, since it may mean five hundred thousand. A number too large to store
  (over a trillion shares, or an amount the database cannot hold exactly) is a
  row error.
- **Values** are read the way spreadsheets write them — `$1,250,000`, `€900,000`,
  `120k`, `20%`, `Jan 15, 2024`, Excel date serials, `Yes`/`No` — and vesting
  accepts schedule names or shorthand like `4y/1y monthly`.
- **Text encodings.** UTF-8, UTF-16 (Excel's "Unicode text") and Windows-1252
  (Excel's plain "CSV" on Windows) are all read, so accented names come through.
  A file pasted together from both is read line by line, and the lines read as
  Windows-1252 are named.
- **Not a spreadsheet.** Images, archives, PDFs, Word and PowerPoint files, old
  .xls workbooks and text without columns are refused with a plain message. A PDF
  is saved as a document instead, linked to a stakeholder or instrument.
- **Bounds.** Files are read as untrusted. A workbook may unpack to at most
  `limits.importUnzippedMb` (parts the import does not read, such as pictures,
  are never unpacked); a cell or row past what Excel allows is refused as
  damaged; empty rows take no room, trailing empty columns are dropped, columns
  after the first 1,000 are left out with a notice, and a cell holds at most
  32,767 characters, as in Excel. One import takes at most
  `limits.importMaxSheets` sheets and `limits.importMaxTotalRows` rows.

The default schedule for grants does not apply to certificates.

**Templates.** One Excel workbook with a tab per kind (headers only) and a "How
to fill this in" tab, plus a CSV per kind with the header row only. Rows copied
from the examples the old templates carried are flagged.

All three parsers are dependency-free: an RFC 4180 CSV reader; a minimal ZIP +
SpreadsheetML reader over `node:zlib` (shared strings, inline strings,
booleans, and date-formatted numbers resolved through the workbook styles); and
a small forgiving XML parser (comments, CDATA, entities, namespace prefixes).

## Building an import page

The server holds no import state: the page keeps the parsed rows, sends them for
the check, and sends the same body again to import. Edits a person makes ("Edit
row", a value replaced in a column, an email added) are changes to the cells the
page sends; they never touch the file. Every route is under `/api/c/:cid/` and
needs an editor's role (a viewer gets 403, someone signed out 401, both before
the body is read); a sample company can do everything except `workbook/commit`.

| Step | Route | |
|---|---|---|
| 1 | `POST imports/parse?name=<file name>` | one call per file, the raw bytes as the body |
| 2 | `POST imports/detect` | every sheet of every file in one call |
| 3 | `POST imports/workbook/preview` | the dry run; again after every answer |
| 4 | `POST imports/workbook/commit` | the same body plus the preview's `reviewToken` |
| | `POST imports/suggest` | the column guesses for one sheet read as another kind |
| | `GET imports/schema` | kinds, their fields, limits, relationships |
| | `GET imports/template.xlsx`, `GET imports/template/:kind[?format=xml]` | templates |
| | `GET imports` | the last 50 imports, one row per sheet |

`imports/preview` and `imports/commit` take one sheet (the fields of a sheet
below, at the top level of the body, with `options.excludeRows`) and answer with
that sheet's `preview`; they still work, but have no `newPeople`, `readAs`, cap
table notices or review token. A page should use the workbook routes, even for a
single CSV.

Errors are `{ error, detail? }`. `error` is a sentence to show as it is;
`detail.code` says what kind of error it is. An error the import did not expect
is a 500 with `{ error: 'Something went wrong on our side.' }` and nothing of
its cause; nothing is written.

### Limits

From `GET imports/schema`: `maxRows` (`limits.importMaxRows`, rows read per sheet),
`maxSheets` (`limits.importMaxSheets`, per import), `maxTotalRows`
(`limits.importMaxTotalRows`, rows per import, all sheets), `uploadMb`
(`limits.importUploadMb`, per file), `unzippedMb` (`limits.importUnzippedMb`,
what an .xlsx may unpack to), `maxColumns` (1,000, columns read per sheet). Also:
`limits.importJsonMb` (preview and commit body) and 32,767 characters per cell.
The schema also has `relations` and `kinds` (each with `key`, `label`,
`description` and `fields`: `key`, `label`, `type`, `required`, `hint`).

### 1. Parse

The body is the file's bytes (any content type), up to `limits.importUploadMb`.
Nothing is written and no lock is taken.

```ts
{
  fileName: string,
  format: 'xlsx' | 'csv' | 'xml',
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | null,  // null for .xlsx
  delimiter: ',' | ';' | '\t' | null,                                     // CSV only
  sheets: {
    name: string,               // a CSV's one sheet is named after the file, without the extension
    rows: Cell[][],             // Cell = string | number | boolean | null; title and header rows included;
                                // every row as wide as the widest, trailing empty columns dropped
    rowCount: number,           // rows with a value in the sheet, header and title rows included, before truncation:
                                // send it back on the sheet in preview and commit
    truncated: boolean,         // rows below the header were cut to limits.importMaxRows
    headerRow: number,          // 0-based index of the header row in `rows` (the widest of the first ten)
    numberFormat: 'en' | 'eu',  // how the sheet writes numbers: send it back on the sheet
    numberDecidedBy: 'file' | 'delimiter' | 'default',
    numberEvidence: { text: string, row: number } | null,   // row: 1-based in the sheet
    numberMixed: boolean,       // some values only 1,234.56 reads, others only 1.234,56: the larger number decided
    notices: Notice[],          // 'truncated' (warning), 'too-wide' (warning: columns after 1,000 left out),
                                // 'mixed-encoding' (info: lines read as Windows-1252, named)
  }[],
}
```

`rows` holds the rows above the header plus at most `limits.importMaxRows`
below it. Refusals are 400 with `detail.code`: `empty`, `pdf` (save it as a
document instead: `POST documents/upload`), `legacy-xls`, `word-document`,
`powerpoint`, `opendocument`, `numbers` (Apple Numbers), `not-a-spreadsheet` (an
image, an archive, a program), `damaged` (including a cell or row past what
Excel allows, a tag left open, XML nested too deeply), `not-a-table` (text with
one column), `unzips-too-large` (with `limitMb`). A file over the upload limit is
413 with `detail: { code: 'too-large', limitMb }`. With several files, show each
refusal against its file and carry on with the others.

### 2. Detect

```ts
// request: at most max(100, limits.importMaxSheets) sheets, each header at most 16,384 cells
{ preferredKind?: 'stakeholders' | 'captable' | 'grants' | 'convertibles',   // the ?kind= the page came with: a tie-break only
  sheets: { name: string, file?: string, headers: Cell[], rowCount: number }[] }   // headers = rows[headerRow]; rowCount = rows below it
// response: one answer per sheet, in the order of the request
{ sheets: {
    name: string, file: string | null,
    kind: Kind | null,                          // null: left out; `reason` says why ("looks like a summary")
    mapping: Record<FieldKey, number | null>,   // column index per field
    constants: Record<FieldKey, string>,        // values the sheet name implies: a share class ("CS-Common"), a plan ("2022 Stock Plan")
    missing: FieldKey[],                        // required fields with no column: ask for them
    ready: boolean,                             // kind set and nothing missing
    reason: string | null,
    score: number, requiredCount: number, mapped: number,
  }[] }
```

400 codes: `no-sheets`, `too-many-sheets`, `bad-sheet` (a sheet that is not an
object, headers that are not a list of cells). A sheet's mapping for preview and
commit is `mapping` with each of `constants` as `{ value }`. When `missing` is
not empty — certificates with no share class column, say — ask "Which column has
the share class?" and send the answer as a column index or `{ value: 'Common' }`
for every row; preview and commit refuse a sheet with a required field unmapped
(400, `detail: { code: 'missing-column', field }`). For a sheet with kind null,
ask what it holds, then call `imports/suggest` with `{ kind, headers, sheetName }`
for its mapping (same fields as above, without `kind`, `reason` and `ready`).
Field keys and labels are in `imports/schema`.

### 3. Preview (the dry run)

```ts
{
  sheets: {
    file?: string,              // the file the sheet came from; falls back to the body's fileName
    name: string,
    kind: Kind,
    headers: Cell[],            // rows[headerRow]
    rows: Cell[][],             // the rows below the header, with any edits the person made
    headerRowNumber: number,    // headerRow + 1: messages cite real spreadsheet rows
    mapping: Record<FieldKey, number | { value: string } | null>,   // keys that are not the kind's fields are ignored
    rowCount?: number,          // parse's rowCount: a sheet cut short says so in its review ('truncated')
    numberFormat?: 'en' | 'eu',          // from parse, or the person's choice for this file
    dateOrder?: 'auto' | 'MDY' | 'DMY',  // the person's choice for this file; 'auto' decides from the file
    excludeRows?: number[],              // rows the person left out, as PreviewRow.row numbers them
  }[],
  options?: ImportOptions,      // for every sheet; see below
  fileName?: string,            // older clients: the one file all sheets came from
}
```

A cell is a string of at most 32,767 characters, a finite number, a boolean or
null; a row is a list of at most 16,384 cells. The body may be up to
`limits.importJsonMb`, with at most `limits.importMaxSheets` sheets and
`limits.importMaxTotalRows` rows in all; each sheet reads at most
`limits.importMaxRows` rows. A sheet's own `numberFormat` and `dateOrder` win
over the ones in `options`, so the page's Import settings for a file change the
values on that file's sheets.

`ImportOptions` (all optional):

| Option | |
|---|---|
| `dateOrder` | `'auto'` (default) \| `'MDY'` \| `'DMY'`, for sheets that do not say |
| `numberFormat` | `'en'` \| `'eu'`, for sheets that do not say |
| `createMissingStakeholders`, `createMissingShareClasses`, `createMissingPools` | default `true`; off, an unknown name is a row error (`create-off`) |
| `defaultVestingScheduleId` | a schedule of this company, for **grants** that name none |
| `certificateVestingScheduleId` | a schedule of this company, for **certificates** that name none (restricted stock); without it they are fully vested |
| `defaultPoolId` | a plan of this company, for grants that name none |
| `defaultPoolName` | for grants that name none: the plan of that name, or a new plan created with it |
| `relationships` | `{ [NewPerson.key]: 'FOUNDER' \| 'EMPLOYEE' \| 'FORMER_EMPLOYEE' \| 'ADVISOR' \| 'CONTRACTOR' \| 'INVESTOR' \| 'BOARD_MEMBER' \| 'OTHER' }` for people the import creates without a relationship |
| `raiseAuthorized` | `string[]`: the `fix.value` of `over-authorized` notices the person accepted |
| `skipRowsWithErrors` | "Leave out N rows": rows with errors are not imported instead of blocking |

A value outside these is 400 with `detail.code: 'bad-option'`, and so is a
schedule or plan id that is not the company's, and `options.excludeRows` (rows
left out are per sheet here: `sheets[].excludeRows`). Other 400 codes:
`no-sheets`, `too-many-sheets`, `too-many-rows`, `bad-sheet` (a sheet, row, cell,
header row or row number of the wrong shape or size), `missing-column`,
`body-too-large`.

The response, which is also what a commit returns:

```ts
{
  sheets: {                     // in the order they are applied: stakeholders, certificates, grants, SAFEs & notes
    sheetName: string, file: string | null, kind: Kind,
    blocked: boolean,           // has errors and skipRowsWithErrors is off: nothing from it would land
    dateOrder: 'MDY' | 'DMY' | 'auto',   // how its dates were read; 'auto': the tab writes dates both ways,
                                          // each date that reads two ways is flagged ('ambiguous-date')
    numberFormat: 'en' | 'eu',
    columnsNotImported: string[],   // headers of the columns no field reads ("Not imported from this tab: …")
    preview: {
      kind: Kind,
      rows: PreviewRow[],
      counts: Counts,
      creates: Creates,
      notices: Notice[],        // 'truncated' when the sheet had more rows than were read
      importId?: string, imported?: Imported,   // on commit
    },
  }[],
  counts: Counts,               // all sheets; a blocked sheet adds nothing to willImport
  creates: { stakeholders: string[], shareClasses: string[], vestingSchedules: string[], pools: string[] },   // names
  imported: Imported,           // on preview: what the commit would write
  importIds: string[],          // on commit: the rows of `GET imports`, one per sheet (meaningless on preview)
  files: (string | null)[],
  newPeople: NewPerson[],
  readAs: ReadAs[],             // one per file
  notices: Notice[],            // what the cap table would warn about after the import that it does not now
  raised: { shareClassId: string, name: string, from: number, to: number }[],   // what raiseAuthorized did
  reviewToken: string,          // names this review: send it with the commit
}

Counts = { total, ok, warnings, errors, skipped, willImport,
           existing,            // of skipped: already on the cap table, or people already up to date
           excluded }           // of skipped: left out by the person
         // every row counts once: total = ok + warnings + errors + skipped. A skipped row may still have
         // status 'warning' (an existing row whose file values differ); it counts as skipped.
Imported = { stakeholders, shareClasses, issuances, awards, convertibles, vestingSchedules, pools,
             updated: { stakeholders } }   // issuances are certificates, awards are grants, pools are equity plans

PreviewRow = {
  row: number,                  // spreadsheet row number
  status: 'ok' | 'warning' | 'error',
  action: 'create' | 'update' | 'skip',
  outcome: 'add' | 'update' | 'existing' | 'excluded' | 'skip' | 'error',
                                // Add, Update, Already there, Left out, Skipped (a total or empty row), Fix
  summary: Record<string, string | number | null>,   // the row as read; keys depend on the kind (below)
  messages: RowMessage[],
}
RowMessage = { level: 'error' | 'warning' | 'info', text: string,
               code?: MessageCode, field?: FieldKey, value?: Cell,   // value: the cell as the file wrote it
               choices?: string[] }                                  // 'ambiguous-person' only: the emails to choose from

NewPerson = {
  key: string,                  // their email, or their name in lower case: the key for options.relationships
  name: string, email: string | null, type: string, relation: string,
  guessed: boolean,             // no file said how they relate to the company: ask
  sameName: { name: string, email: string | null, onRecord: boolean }[],   // namesakes with another email, kept apart
  rows: { file: string | null, sheet: string, row: number }[],             // every row that names them
}

ReadAs = {
  file: string | null, sheets: string[],
  dateOrder: 'MDY' | 'DMY' | 'mixed',      // mixed: the file has both kinds of unambiguous dates; sheets[].dateOrder says how each tab was read
  dateDecidedBy: 'file' | 'setting' | 'default',
  dateEvidence: { text: string, sheet: string | null, row: number } | null,   // "15/01/2024, row 3"
  ambiguousDates: number,                  // dates like 03/04/2024 the order decided
  textDates: number,                       // dates written as text; 0 means the date order does not matter
  numberFormat: 'en' | 'eu' | 'mixed',     // mixed: its sheets were read differently
  numberDecidedBy: 'given' | 'file' | 'delimiter' | 'default',   // 'given' only when the format sent differs from what the values show
  numberEvidence: { text: string, sheet: string | null, row: number } | null,
  numberMixed: boolean,                    // a sheet has values only one format reads and others only the other reads
}

Notice = { code: 'truncated' | 'too-wide' | 'mixed-encoding' | 'over-authorized' | 'pool-over-allocated' | 'cap-table',
           level: 'warning' | 'info', text: string,
           fix?: { option: 'raiseAuthorized', value: string, shareClassId: string | null, className: string, to: number } }
```

`summary` keys: stakeholders `stakeholder, email, type, relation, startDate`;
certificates `stakeholder, shareClass, shares, price, issueDate, certificate,
vesting`; grants `stakeholder, type, shares, strike, grantDate, vesting, label`;
SAFEs and notes `stakeholder, instrument, label, principal, issueDate, cap,
discount, status`. Money is in dollars and prices in dollars per share here;
`type`, `relation`, `instrument` and `status` are codes (`FOUNDER`, `SAFE_POST`,
`OUTSTANDING`) for the page to label. A left-out row's summary has only
`stakeholder`.

The import can go ahead when no sheet is `blocked` and `counts.willImport > 0`.

**Message codes.** Texts are written on the server; show them as they are, and
use `code` and `field` to group rows that one answer fixes and to point at the
cell. `field` is the field key; `value` is the cell as written.

| Code | Level | Means | The answer |
|---|---|---|---|
| `required` | error | a required field is empty | edit the row, or leave it out |
| `bad-date`, `bad-value` | error | the cell cannot be read | edit the row |
| `bad-number` | error | the cell is not a number, or is too large to record (over a trillion shares, an amount or price the database cannot hold, or shares × price too large) | edit the row |
| `unknown-value` | error | a relationship, type, instrument, status, award type or vesting schedule is not recognised | replace that value in that column for every row |
| `ambiguous-award-type` | error | "Option": ISO or NSO? | replace the value (ISO / NSO) |
| `ambiguous-person` | error | no email, and two or more people have this name (on file or created by this import); `choices` lists their emails | "Which one?": set the row's email to the chosen one. A sheet with no email column needs one: append a header and a cell to every row and map `email` to it |
| `missing-plan` | error | a grant names no plan and none is chosen | `defaultPoolId` or `defaultPoolName` |
| `missing-vesting` | error | a grant names no schedule and none is chosen | `defaultVestingScheduleId` |
| `missing-strike` | error | an option with no exercise price | edit the row |
| `not-positive`, `over-granted`, `cancelled-before-grant` | error | shares or amounts that cannot be | edit the row |
| `create-off` | error | the record does not exist and creating is off | turn the `createMissing…` option on |
| `no-common-class` | error | a new plan has no common class to draw on | import certificates of a common class too |
| `number-taken` | error | the certificate, grant or instrument number is on the cap table with different details | edit the number, or leave the row out |
| `duplicate-in-file` | error | the same number twice in the file | edit one |
| `duplicate-in-file` | warning | the same contents as another row (named; "which is already on the cap table" when that one was), or a person listed again (later rows update the first) | none needed |
| `same-name` | warning | another person of this name has a different email: two people | "Same person": set this row's email to the other's (`NewPerson.sameName`) |
| `ambiguous-number` | warning | a share count, amount or price like "500.000" that reads a thousand times larger in the other format | change the file's `numberFormat` |
| `ambiguous-date` | warning | the tab writes dates both ways and this one reads two ways; the text gives both | set the file's `dateOrder` |
| `similar-on-record` | warning | an added row like a record no row matched: the same holder and date with another amount, another class (or award type, or instrument), or the same contents under another number. A file imported again with another answer to a question (ISO instead of NSO) is caught here | "Leave out" (`excludeRows`) if it corrects, reclassifies or renumbers that record, else none |
| `differs-from-record` | warning | on an existing row: the file gives another price, schedule, strike, plan, expiration, cap, discount or number than the record; nothing is changed | none: correct the record on its page if the file is right |
| `template-example` | warning | a row copied from an old template's example | leave it out |
| `no-price`, `no-cap-or-discount`, `exercise-before-grant`, `settled-before-issue`, `plan-size-smaller` | warning | imported as described | none needed |
| `already-imported`, `up-to-date` | info | already on the cap table (outcome `existing`) | none |
| `excluded` | info | left out by the person | none |
| `blank-row`, `plan-size-row`, `nothing-outstanding` | info | a total, section or fully repurchased row (outcome `skip`) | none |
| `relationship-guessed` | info | a person created with a guessed relationship | `relationships` |
| `stakeholder-created`, `stakeholder-updated` (also: a person on file given the row's email), `class-created`, `schedule-created`, `plan-created`, `type-as-relationship`, `relationship-as-type` | info | what the row does | none |
| `no-83b`, `expiration-assumed`, `exercise-date-assumed`, `cancellation-dated-to-termination`, `cancellation-date-missing`, `unused-value`, `interest-ignored`, `not-outstanding`, `instrument-assumed`, `settled-date-missing` | info | something the file does not say, filled in | none ("We filled in N things") |

**Notices.** `over-authorized`: after the import a class would have more shares
outstanding (plus what it keeps for plans, warrants and conversion) than it has
authorized. Its `fix.to` is what it needs; to accept, add `fix.value` to
`options.raiseAuthorized` and check again — the notice goes and `raised` says what
the import will do. `pool-over-allocated` and `cap-table` are the cap table's own
warnings, new with this import, without a fix. `truncated` on a sheet: the file
has more rows than were read.

### 4. Commit

The body of the preview the person approved, unchanged, plus its `reviewToken`.
The same run happens and is kept, in one transaction with the ledger entries of
every certificate, grant and SAFE, an `imports` row per sheet, and one audit
line naming the files, what was added and updated, and any raised classes.

The token names both what was asked (every sheet, row, mapping and option) and
what the run came to (every row's outcome, the people, classes and plans
created, the raises). Anything the person changes after the check — a row edited
or left out, "Leave out N rows" (`skipRowsWithErrors`), a relationship answered,
a raise accepted — needs a new preview, and its new token, before the commit.

| Status | `detail.code` | |
|---|---|---|
| 200 | | the result, as for preview |
| 409 | `not-reviewed` | the body is not the one the token's preview checked. Nothing was written; check again. |
| 409 | `stale-review` | the same body comes out differently: the cap table changed since the check. `detail.counts` are the new counts. Nothing was written; check again. |
| 400 | `rows-need-fixing` | a sheet has errors and `skipRowsWithErrors` is off. Nothing was written. |
| 400 | the codes of preview | the request itself |
| 403 | | a sample company, or a role that cannot edit |
| 500 | | an error the import did not expect; nothing was written |

An older page may send `expectedCounts` (all eight counts of the preview)
instead of the token, which checks the counts only; a partial `expectedCounts`
is 400 `bad-option`. A page that sends neither is not checked at all; the import
page sends the token.

### Changes an existing client sees

The routes and fields an older page uses are unchanged; responses only gain
fields. What behaves differently:

- A row already on the cap table is skipped (`outcome: 'existing'`, action
  `skip`) where it used to be a "would duplicate" error; it has status `warning`
  when the file differs from the record (`differs-from-record`). Two identical
  rows need two records to both be skipped.
- A row with no email whose name several people have is an error
  (`ambiguous-person`) where it used to go to one of them.
- `defaultVestingScheduleId` applies to grants only; certificates take
  `certificateVestingScheduleId`.
- Detection returns a ledger kind with `missing` fields where it used to fall back
  to a stakeholder list; preview still refuses the sheet until they are mapped.
- Dates are decided per file (per tab when its tabs disagree), not per cell;
  "0,0001" and "1.000.000" are read as numbers; options, sheets, rows and cells
  are checked.
- A person whose email differs from a same-named stakeholder is a new person with
  a `same-name` warning, where the name used to match them silently.
- A stakeholder report row that changes nothing is skipped as up to date, and a
  person listed twice in one file takes the later rows' details.
- `counts.warnings` no longer counts skipped rows, so the counts add up to `total`.
- Parse keeps the rows above the header plus `limits.importMaxRows` below it
  (it used to cut at that many rows in all), pads rows to one width and drops
  trailing empty columns.
- A body is read only after the caller's access is checked.
- CSV templates carry the header row only.
- `Imported` has five more counts, `warrants`, `valuations`, `stockSplits`,
  `poolAdjustments` and `events`, each 0 for spreadsheets; a namesake on record in
  `NewPerson.sameName` carries its `stakeholderId`; parse answers an Open Cap Format
  file with `format: 'ocf'` and no sheets ([OCF packages](#ocf-packages)).

## OCF packages

An [Open Cap Format](ocf.md) package is the whole cap table and its history: people,
classes, plans, vesting terms, valuations, and every issuance and event since. It is
imported on its own, through the same three screens, and lands whole or not at all,
with every event written to the dated ledger, so every earlier date of the cap table
reads as the package says. Kosmitor's own export ([OCF](ocf.md)) imports back to the
same cap table on every date.

### Upload

Drop the .ocf.zip, or the manifest and all of its files together. A loose file
without its manifest, a manifest without one of its files, or two packages at once
is said in the drop zone. Spreadsheets dropped with a package are not read: the
check says to import them afterwards.

### Check your import

The reading note names the package ("cap-table-2026-01-15.ocf.zip — Open Cap Format
1.2.0 package of Brightwater Kinetics, Inc., as of Jan 15, 2026"), what it holds,
the company fields it fills in (legal name, incorporation date, jurisdiction, EIN,
address: empty ones, and while the cap table is empty the ones a new company starts
with), the classes on file that take the package's terms, and its notices: checksums
that do not match (only a notice; many tools write placeholder ones), a file found by
its kind rather than the path the manifest gives, files the manifest does not list,
legend templates, financings and documents (not imported), and a package of another
company than this one. For another company's package the company fields are a choice,
**Copy them** or **Leave the company as it is** (the default).

Then the questions: **Which Robin Vale is this?** for a person the package does not
tell apart from several on file (or *Someone new*), and the cap table's warnings after
the import, with *Raise to N*. New people whose relationship the package does not
give are listed with a choice, as for spreadsheets.

Each part of the package is a table of its own, in the order it is applied:
Stakeholders, Share classes, Equity plans, Vesting schedules, Valuations,
Certificates, Equity grants, Warrants, SAFEs & notes, and **History**, every other
transaction. A row is an **item**: the object's place in its files (a security's,
its issuance transaction's). Nothing is edited here. A row with a problem is left
out (**Leave out**, or *Leave out N rows* in the bar), and its **family** goes with
it: a security, the balance certificates that carry it on, the certificates its
transfers, exercises and conversions created, and their events, which land
together or not at all. A row of a family where another row has a problem says
**Waits for item N**; one left out with another says **Left out with item N**;
neither has buttons. A row that needs another (its holder, class, plan or vesting
terms) waits for or is left out with it too. A package goes in whole, so while any row
needs fixing nothing is ready: the bar and *What this adds* count every row to add as
ready once that is fixed or left out.

Importing a package again, or into the company it came from, finds every row already
there. A family is wholly new or wholly there: when its security is on the cap table
but an event of it is not ("The cap table's PS-1 has no transfer on 2024-09-02"),
nothing of the family is written and the row says so; record the event on the
security's page.

### Done

What was added, warrants, valuations, stock splits, plan changes and history entries
included; the company fields filled in and the classes that took the package's terms;
*Download them (.csv)* lists the items left out (Section, Item, OCF id, Object,
Summary, Problem); the main button opens the cap table.

### The API

**Parse.** `POST imports/parse` answers an OCF file with `format: 'ocf'`, no
`sheets`, and `ocf`:

```ts
ocf: {
  part: 'package' | 'manifest' | 'file',   // a .ocf.zip; a loose manifest; one loose file of a package
  version: string | null, fileType: string | null,
  issuer: { id, legalName, dba } | null, asOf: string | null, generatedAt: string | null,
  files: { path, fileType, items, checksum: 'ok' | 'mismatch' | 'none', md5 }[],
  missing: string[],                          // a loose manifest's files, for the page to find among the files dropped
  counts: Record<OcfSection | 'transactions', number>,
  notices: Notice[],                          // ocf-checksum, ocf-path-resolved, ocf-unlisted-file, ocf-version-older, ocf-not-imported-file
  package: { manifestPath: string | null, manifest: object | null, files: { path, md5, content }[] },
}
```

A zip is read when it holds `.json` entries and no office document; only its JSON
entries are unpacked, within `limits.importJsonMb` (and `limits.importUnzippedMb`), so
an entry that lies about its size stops there. A `.zip` that does not open is refused as
a damaged package ("We couldn't open cap-table.ocf.zip — it may be damaged. Export the
package again and drop it here."), not as a workbook to save again from Excel. The page puts a loose
manifest and its files together (`mergeOcfParts` in `apps/web/src/pages/import/ocf.ts`),
each file under the path its manifest gives it. Refusals, 400 with `detail.code`:
`ocf-no-manifest`, `ocf-two-manifests`, `ocf-missing-file` (the manifest lists a file
the package does not have), `ocf-version` (not OCF 1.x), `ocf-too-large` (more than
`limits.importJsonMb` of JSON, or more than 200 files), `too-many-rows` (more than
`limits.importMaxTotalRows` objects), `damaged` (a zip that does not open, JSON that
does not parse, or nests deeper than 64), `not-utf8` (JSON that is not UTF-8: a Latin-1
or UTF-16 file), `unzips-too-large`, and `not-a-spreadsheet` for JSON that is not OCF.

**Preview and commit.** `imports/workbook/preview` and `/commit` take, instead of
`sheets`:

```ts
{ ocf: { file: string, package, exclude?: Partial<Record<OcfSection, number[]>> },   // package as parse returned it; items left out by section
  options?: { relationships?, raiseAuthorized?, skipRowsWithErrors?,
              ocfPeople?: Record<string, string>,      // package stakeholder id -> a stakeholder of this company, or 'new'
              ocfCompanyFill?: boolean },              // whether the issuer's details fill in the company's; unset: yes unless the package is another company's
  uploadIds?: string[], reviewToken?: string }
```

`OcfSection` is `stakeholders | shareClasses | plans | vesting | valuations | captable
| grants | warrants | convertibles | events`. The package is checked again as parse
checked it. `sheets` with it is 400 `ocf-alone`; an `ocfPeople` value that is not
`'new'` or a stakeholder of this company, an `ocfCompanyFill` that is not true or
false, or an unknown section in `exclude`, is `bad-option`. A package whose securities
would vest on more than 2,000,000 dates in all is 400 `ocf-too-large` (docs/ocf.md,
"Vesting is bounded"). The spreadsheet options (date order, number format, defaults, the
`createMissing…` flags) are not read. The review token covers the package, the items
left out and every answer.

The response is the workbook response, with one `sheets` entry per section that has
rows (`kind` the section, `sheetName` its title, `file` the package's name) and:

- `PreviewRow.row` is the item number; `ocfId` and `object` (the object_type) name it.
  Summary keys: stakeholders, certificates, grants and SAFEs & notes as for
  spreadsheets, plus `state` (the status it ends in) on certificates and grants;
  share classes `name, classType, authorized, price, seniority, votes`; plans `name,
  shareClass, reserved, boardApprovalDate`; vesting `name, reading`; valuations
  `effectiveDate, price, provider, shareClass`; warrants `stakeholder, shareClass,
  shares, strike, issueDate, expirationDate, state`; history `date, event` (the
  object_type) `, security` (its number) `, stakeholder, quantity, amount, detail`.
- `ocf`: `{ file, version, issuer, asOf, generatedAt, files, notices, notImported:
  { what, count, reason }[], companyFill: { field, value }[], companyFillAsked,
  companyFillApplied, classUpdates: string[] }`: the company's fields the issuer's
  details fill in, whether the person is asked (another company's package) and whether
  this check writes them, and the classes on file that take the package's terms.
- `counts.willImport` is 0 while any section is blocked: a package goes in whole.
- `RowMessage.people` on `ambiguous-person`: the people on file it may be (`id`, `name`,
  `email`), answered by `options.ocfPeople`.
- `NewPerson.ocfId`; `NewPerson.sameName[].stakeholderId` names one on record (also for
  spreadsheets).
- `Imported` gains `warrants`, `valuations`, `stockSplits`, `poolAdjustments` and
  `events` (the ledger entries written for events, not those securities are created
  with); each is 0 for spreadsheets.

A package with an error in any section and `skipRowsWithErrors` off writes nothing,
even in the dry run: the sections with errors are `blocked`, and commit is 400
`rows-need-fixing`. One `imports` row is written per package (kind `ocf`), and the
audit line reads "Imported the OCF package <file>: …", ending with the company fields
filled in ("the company's EIN and address filled in") and the classes given the
package's terms.

**Message codes** added for packages:

| Code | Level | Means |
|---|---|---|
| `ocf-bad-object` | error | an object or value that is not what OCF allows (a Numeric, a ratio, a missing name); a warning when an email that is not one plain address is left out |
| `bad-number` | error | an amount past what Kosmitor can record (shares times a price) |
| `ocf-unknown-reference` | error | an id the package does not have (`field` and `value` say which) |
| `ocf-duplicate-id` | error | two objects with one id, or a security issued twice |
| `ocf-currency` | error | money in another currency than the company's; nothing is converted |
| `ocf-event-order` | error | an event before its security was issued, or after it closed |
| `ocf-balance-mismatch` | error | a balance certificate that does not hold what the event left |
| `ocf-unsupported` | error | what Kosmitor cannot record: vesting terms with two paths or past the bounds (dates, periods, conditions), a split of some classes only, part of a SAFE or note converted, an event a security of its kind cannot have |
| `ocf-split-existing` | error | a stock split into a company that already has securities |
| `ocf-depends` | error | waits for another row's fix ("Waits for item N") |
| `ocf-no-balance`, `ocf-acceleration-not-applied`, `ocf-future-date`, `ocf-result-date`, `ocf-option-type-assumed`, `ocf-terms-approximate`, `ocf-planless-grant`, `ocf-vesting-ignored` | warning | imported as described |
| `ocf-history-current-only`, `ocf-vesting-per-security`, `ocf-vesting-rounding`, `ocf-transfer-as-cancellation`, `ocf-rounded`, `ptep-assumed` | info | filled in ("We filled in N things") |
| `ocf-folded`, `class-updated` | info | what a row does: an event folded into its security (a leaver's lapse Kosmitor works out itself among them), a class with nothing issued taking the package's terms |
| `ocf-not-imported` | info | a transaction that is not imported (outcome `skip`) |
| `ocf-excluded-with` | info | left out with another item |

Notices: `ocf-checksum`, `ocf-path-resolved`, `ocf-unlisted-file`,
`ocf-version-older`, `ocf-not-imported-file`, `ocf-legends` (info) and
`ocf-other-issuer` (warning).

The mapping, object by object, is in [docs/ocf.md](ocf.md#importing).

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
