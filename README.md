# Kosmitor — equity & cap table management

A full-stack cap table platform: ownership tracking, equity grants and vesting,
SAFE/note conversion, priced-round modeling, exit waterfalls, compliance checks,
e-signature and a stakeholder portal.

The interesting part is `packages/core` — a dependency-free domain engine that does
the real financial math, covered by tests whose expected values are derived from
the underlying rules rather than from the code.

## Running it

You need PostgreSQL 14 or newer running locally (Homebrew: `brew install postgresql@17 && brew services start postgresql@17`).

```bash
npm install
npm run db:create     # creates the "kosmitor" database (set DATABASE_URL to use another)
npm run sample        # adds a fictional company, Marlowe Systems, and leaves everything else alone
npm run dev           # API on :4000, web on :5173
```

Open http://localhost:5173 and sign in with the demo login, `founder@example.com` /
`password123` (`demo.email` and `demo.password` in the [configuration](#configuration)).
To have the sign-in page show that login and fill it in, put
`{ "demo": { "enabled": true } }` in `kosmitor.config.local.json`.
`npm run sample -- --replace` rebuilds the sample company from scratch.

> **Do not run `npm run seed` on a database you care about.** It builds an older demo
> company, and to do so it first **deletes every company in the database**, along with
> every session. Use it only on a throwaway database.

```bash
npm test              # engine tests, then server tests (each server test file gets its own scratch database)
```

## Layout

```
packages/core     domain engine — pure TypeScript, no dependencies
  types.ts        share classes, securities, vesting, valuations
  util.ts         calendar-safe date math, integer money math
  vesting.ts      cliffs, back-loading, milestones, single/double-trigger acceleration
  captable.ts     fully diluted / outstanding / as-converted / voting views
  convertibles.ts pre- and post-money SAFEs, notes, MFN, interest accrual
  round.ts        priced rounds (pool shuffle fixed point), anti-dilution
  waterfall.ts    liquidation preferences, participation caps, breakpoints
  compliance.ts   ISO $100K, Rule 701, 83(b), 409A, PTEP, board approval
  tax.ts          exercise/sale tax estimates, AMT, QSBS (pre- and post-OBBBA)
  splits.ts       folds stock splits into share counts and prices once, at every entry point

apps/server       Node HTTP API over PostgreSQL (pg driver)
apps/web          React + Vite + Tailwind, 24 screens
infra/azure       Terraform for a production deployment on Azure (see its README)
docs              configuration.md, the reference for every setting
```

## Configuration

Everything an operator might want to change (the product name, logo and colours,
the sign-in options, limits, what a new company and a new award start with, the
assistant's providers, and so on) is a setting in **`kosmitor.config.json`** at the
repository root, described entry by entry in `kosmitor.config.schema.json`. Editors
that understand JSON Schema complete and check the file as you type.

Leave `kosmitor.config.json` as shipped and put your changes in
**`kosmitor.config.local.json`** next to it (ignored by git). It only needs the
entries you change:

```json
{
  "$schema": "./kosmitor.config.schema.json",
  "brand": { "productName": "Acme Equity", "pageTitle": "Acme Equity" },
  "app": { "url": "https://equity.example.com" },
  "auth": { "selfSignup": false }
}
```

To keep the file somewhere else, point `KOSMITOR_CONFIG` at it. A few environment
variables win over both files, for values that differ per deployment: `APP_URL`,
`PORT`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `PG_POOL_MAX`, `MAIL_FROM`,
`GOOGLE_CLIENT_ID`, `GOOGLE_ALLOWED_DOMAINS`, `VALUATION_DESK_EMAIL`,
`BACKUP_CONTAINER`, `BACKUP_PREFIX` and `DRILL_DATABASE`. They can live in
`apps/server/.env` (copy `apps/server/.env.example`).

Secrets never go in either file. `DATABASE_URL`, `SMTP_URL`, `ACS_CONNECTION_STRING`,
`CT_SECRET_KEY` and the backup job's credentials stay environment variables.

The server checks the result against the schema when it starts and refuses to start
on a misspelt key or a wrong type, naming the entry. Settings the web app needs reach
it with the page, so a change takes effect when the server restarts; no rebuild is
needed. The container image copies `kosmitor.config.json`, the schema and, when the
build context has one, `kosmitor.config.local.json`.

[docs/configuration.md](docs/configuration.md) lists every setting with its default.
It is generated from the schema and the defaults: run `npm run config:docs` after
changing either (`npm run config:docs -- --check` fails when it is out of date).

## Units

Money is integer **cents**; per-share prices are integer **micro-cents** (so
$0.0001 strike prices survive). No floating point value ever touches a monetary
amount on the way to or from disk.

## The math worth knowing about

**Vesting** uses cumulative-floor allocation — shares vested through period *i*
are `floor(total × i / n)`. A grant never vests ahead of schedule from rounding,
and tranches always sum exactly to the grant.

**Priced rounds** are a fixed point. The share price depends on the option pool
top-up and the converting SAFEs; the pool depends on the post-round total, which
depends on the price. The solver iterates:

```
PPS  = preMoney / (existingFD + poolIncrease + convertedShares)
N    = investment / PPS
T    = (existingFD + converted + N − existingPool) / (1 − targetPool%)
pool = targetPool% × T − existingPool
```

This reproduces the standard pool-shuffle result: on a $8M pre / $2M raise with a
10% post-close pool, investors get 20%, the pool is 10%, founders hold 70%.

**Post-money SAFEs** take a fixed ownership slice (`principal / cap`) of the
company before new money, so the set is solved together rather than sequentially.

**Waterfalls** are a best-response search over conversion elections. Every
claimant — each preferred class, and each SAFE or unrepaid note choosing between
its cash-out and converting at its cap — is given whichever election pays it
more given everyone else's, re-evaluated until nobody wants to change. Inside
each evaluation, which options are in the money is a fixed point (they help set
the price that decides it), and a capped participating class is fixed at its
cap and removed from the per-share split so the excess flows to the others
rather than vanishing. Common absorbs the per-share rounding, so payouts
reconcile to the distributable amount to the cent at every exit value.

**Stock splits** are normalised away before any formula runs: share counts are
multiplied and per-share prices divided, so a $2M preference stays $2M and a
$1.00 strike on 100 options becomes $0.50 on 200.

## Compliance checks

ISO $100,000 first-exercisable limit with NSO recharacterisation (an
early-exercisable grant counts in full in its grant year), Rule 701's three
ceilings (the 15%-of-outstanding prong is compared in shares, not dollars),
83(b) 30-day deadlines, 409A expiry and below-FMV strikes, missing or backdated
board approval, post-termination exercise windows, note maturity, authorized
share and plan-reserve capacity.

## Importing data

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

## Documents and files

**Documents** accepts any file up to `limits.uploadMb` (25 MB by default) — drop
it on the page or use *Upload files* — optionally attached to a stakeholder so it
appears in their portal. File contents are stored in the database (`BYTEA`) with a SHA-256, so a
database backup is a complete backup, and are served back as attachments with
the same access rules as the document list.

The page shows documents as a tree of folders. A folder is a path stored on each
document, with `/` between levels (`Financing/Series A`), so a folder exists for
as long as something is in it. Editors move a document by dragging it onto a
folder, or with *Move to folder* from the keyboard or a phone; files dragged onto
a folder are uploaded into it. The server cleans every path the same way
(`apps/server/src/folders.ts`): at most 5 levels, 60 characters a level and 120
in all, with an empty path meaning *General*.

## Where data lives

Everything — users, sessions, the cap table, documents and their files, the
audit trail, sign-in nonces — is in one PostgreSQL database (`DATABASE_URL`,
default `postgres://localhost:5432/kosmitor`). Money is stored in integer cents and
per-share prices in integer micro-cents; dates are ISO text.

```bash
npm run backup                 # pg_dump custom-format backup into apps/server/data/
npm run db:migrate-sqlite      # one-shot copy of a database from the earlier SQLite build
```

Administrators can see the database, its size and per-table counts under
Settings → Data & persistence.

## Sign in with Google

Password sign-in works out of the box. To offer "Continue with Google":

1. In [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Add your origins under *Authorized JavaScript origins* — for development both
   `http://localhost` and `http://localhost:5173` (Google insists on the bare
   origin as well), plus your production origin. No redirect URI is needed: the
   browser posts the ID token straight to the API. New origins can take a few
   minutes to become active.
3. Copy `apps/server/.env.example` to `apps/server/.env` and set `GOOGLE_CLIENT_ID`
   (or `auth.google.clientId` in `kosmitor.config.local.json`). Optionally set
   `GOOGLE_ALLOWED_DOMAINS=yourcompany.com` to accept only your workspace's accounts.
4. Restart the API. The button appears on the sign-in page automatically.

`auth.passwordSignIn: false` then leaves Google as the only way in, and
`auth.selfSignup: false` stops strangers creating accounts: only invited people and
existing accounts get in, and Google sign-in no longer creates an account.

The server verifies each ID token itself — RS256 signature against Google's
published keys, issuer, audience, expiry, verified email, and a single-use nonce
issued per attempt — with no extra dependencies. Accounts link by Google-verified
email, so someone an administrator invited can claim their access by signing in
with Google without ever setting a password.

## Passwords and recovery

- **Welcome email** — someone who creates an account themselves, by signing up or by
  a first Google sign-in, is emailed once with the first steps; invited people get
  their invitation instead. `mail.welcomeEmail: false` turns it off, and
  `mail.welcomeEmailsPerHour` (50) caps it across the server, below the mail
  provider's hourly limit so resets and invitations still go out.
- **Invitations** — inviting someone on *Team & access* emails them. A new address,
  or an account nobody has signed in to yet, gets a single-use link that chooses
  their password and signs them in, valid for `auth.inviteLinkDays` (7 by default),
  with Google offered beside it when Google sign-in accepts the address; with
  `auth.passwordSignIn: false` the email says to sign in with Google as the address
  invited, and an address `auth.google.allowedDomains` turns away cannot be invited. Someone who already
  signs in is only told about the new company. The email names who sent it, the
  company and the role, and never carries a password. When it does not go out, the
  administrator gets the link to pass on, for an account that belongs to that
  company alone. Members who have not signed in yet show *Invited* and can be sent
  the invitation again, with a new link that retires the old one; one address gets
  at most `auth.inviteEmailsPerAddressPerDay` (five) invitation emails a day, from
  every company together, deleted ones included. The link stops working once its
  owner signs in by any way, or their address is changed, and a link handed to an
  administrator also stops once the person belongs to another company.
- **Forgot password** — the sign-in page sends a single-use link that expires after
  `auth.resetLinkMinutes` (an hour by default; at most `auth.resetEmailsPerHour`,
  three, per address per hour; the response is the same whether or not the address
  has an account). Using the link sets the password, signs the person in, and
  signs out every other session.
- **Change password** — open the menu on your name at the foot of the sidebar,
  choose *Preferences*, then *Signing in*. Other sessions are signed out; the
  current one stays.
- **Preferences** — the same menu holds *My equity*, *Preferences* and *Sign out*.
  Preferences covers your name and colour, your password, whether the explanation
  at the top of each page starts open, and the assistant's model and API key.
- **Assistant** — the round button at the bottom right of every page opens the
  chat, for roles that see the whole company. It needs a model and your own API
  key, set once in Preferences and used in every company you belong to. Each
  question sends a summary of the cap table to the provider chosen;
  `ai.enabled: false` removes the assistant, and `ai.providers.<id>.enabled: false`
  removes one provider.
- **Administrator reset** — on *Team & access*, the key icon on a member offers
  three options: email them a link, get a link to pass on yourself (single use,
  valid for `auth.adminResetLinkHours`, 24 by default), or set a temporary
  password they must replace at their next sign-in. Every option is written to the audit log. Accounts are global, so a
  link to pass on, a temporary password, and changes to a member's name or
  sign-in email are only offered for someone who belongs to no other company;
  anyone else can only be emailed a link, which goes to them.

Links are emailed through `SMTP_URL` in `apps/server/.env`
(`smtp://user:pass@host:587` uses STARTTLS, `smtps://…:465` implicit TLS), sent
from `MAIL_FROM` (`mail.from`). Every link points at `APP_URL` (`app.url`), never
at whatever address a request came from, so set it to the public address in
production. Without `SMTP_URL` the server prints messages to its log and —
outside production — the sign-in page and the administrator dialog show the link
directly, so the flow works on a laptop.
Only a hash of each reset token is stored.

## 409A requests and reports

Requesting a 409A from inside the app is an optional service for an operator who
runs, or works with, a valuation team. It is off until `valuationDesk.enabled` is
true; while it is off nothing offers it and new requests are refused, and requests
made earlier keep their history and their status links.

- **Request a new 409A** — on *Compliance & tax → 409A valuations*, the appraiser's
  information request, in five steps, every question required:
  - **The valuation:** the valuation date (or the most recent date), company size
    and stage, plans to grant options or close a round, a ballpark of options to
    grant in the next 6 to 12 months, and the last 409A.
  - **Documents:** historical and year-to-date financial statements, the pitch
    deck, earlier valuation reports, the certificate of incorporation, SAFE and
    note agreements, and projections (or revenue and EBITDA guidance instead).
    Documents are uploaded or chosen from the vault; the charter, earlier 409A
    reports and outstanding SAFE agreements are attached for you. The founder also
    confirms the cap table and option ledger are up to date, since the team gets
    them from the app.
  - **People:** the management team, and anyone on a below-market salary.
  - **Transactions:** secondary sales of the company's stock, and expenses
    recorded below market rates.
  - **Software and contact.**

  The server refuses a request missing any required answer or document, not only
  the form. The answer lists are in `valuationDesk.intake`. Sending it emails the
  valuation team the answers, the capital structure (no holder names) and the
  documents' names, and emails a recap to the account of the person who asked. The
  documents themselves never travel by email: the team downloads them from its
  page while the request is open.
- **Status** — the team works the request from a private link in its email: it
  marks the request started, adds notes, delivers the report (naming the
  appraisal firm and the valuation date) or closes it. The company sees each step
  on its 409A page, and recording the 409A from the report closes the request.
  The person who asked is emailed at each step, at their account address: when
  the team starts, delivers, puts the report back in progress or closes the
  request, and when someone else at the company completes or cancels it. Notes
  are not emailed. `valuationDesk.statusEmailsPerRequestPerDay` (10) caps these
  emails per request, and 0 turns them off.
- **The report, uploaded** — on its page the team can upload the appraisal report
  as a PDF before it marks the request delivered. The file goes into the
  company's vault (category *Valuation*, folder *Valuations*, administrators
  only), and the app reads the fair market value per common share, the valuation
  date and the method from its text, with no service outside the server. The
  delivery form fills in from what was read, each value with the sentence it came
  from and a warning when the reading is unsure; the team corrects anything and
  delivers. A scanned or encrypted PDF is still stored, and the team types the
  values instead. On the company's 409A page the delivered report shows those
  values, and *Review and record* opens *Record valuation* filled in from them:
  nothing is recorded until someone at the company has checked them against the
  report and saved the form, which records the 409A with the report attached and
  closes the request. Uploading again replaces the earlier file, and putting the
  report back in progress removes it, unless something in the company already
  uses it. `valuationDesk.reportUploadsPerRequestPerDay` (10) caps uploads per
  request, and 0 turns uploading off; delivering by email works either way.
- **The team's link** — only a hash of its token is stored, each new notice
  replaces it, and it stops working `valuationDesk.linkClosedDays` (30) days after
  the request closes. The team's inbox is `valuationDesk.email` (or
  `VALUATION_DESK_EMAIL`); with none set, requests are saved but nobody is told.
  `valuationDesk.name` is what the team is called in the app and in emails.
- **Your own appraiser** — the data workbook stays downloadable from the 409A
  page, and *Record valuation* takes the result.
- **Reports** — a valuation's page has a *Report* field: upload the appraisal,
  choose a document already in the vault, or paste a link. The valuations table
  opens it directly.

## Roles

`ADMIN` and `LEGAL` can edit; `BOARD` and `VIEWER` read the whole company;
`EMPLOYEE` and `INVESTOR` see only their own position in the portal.
