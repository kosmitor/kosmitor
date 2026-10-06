# As-of cap tables: a dated ledger or effective-dated rows

Status: Option A accepted and partly built. Math audit 2026-10-05, bug CAP-1. See [Where this stands](#where-this-stands) for what the code does today; the sections after it are the original proposal.

## Where this stands

### Built

- **Store.** `loadCompanyData` reads `transactions` rows that have a `security_id` into `CompanyData.ledger` (`apps/server/src/store.ts:38`, `:180`).
- **Engine.** `rewindToDate` (`packages/core/src/ledger.ts`) undoes transfers, repurchases, exercises, cancellations (including an import's `FORFEITURE` and `EXPIRATION`) and conversions dated after `asOf`.
- **Order.** `normalizeSplits` calls `rewindToDate` first, before it applies splits (`packages/core/src/splits.ts`), not after it as proposed below. The ledger converts units itself with `splitsBetween`, a copy of `splitFactor` that avoids an import cycle.
- **Partial fix.** A convertible counts as outstanding before `convertedOn`. If `convertedOn` is not set, the date of its `CONVERSION` entry is used.
- **Fallback.** When the ledger cannot rebuild a row's history, the row keeps today's state, the same as before the ledger existed. This covers rows older than the ledger, imports, rows edited by hand, and entries without a quantity.
- **Tests.** Unit tests per entry type are in `packages/core/test/ledger.test.ts`. The model-based route test is `apps/server/test/ledger-replay.test.ts`.
- **Delete guard.** A security that has ledger history cannot be deleted (`apps/server/src/routes/entities.ts`).

### Not built: what the code does instead

- **`PATCH` guard and `CORRECTION` entries.** `PATCH /api/c/:cid/<entity>/:id` still changes `quantity`, `status`, `exercisedQuantity` and `cancelledQuantity` without writing a ledger entry (`apps/server/src/routes/entities.ts`). `CORRECTION` is not a `TransactionType`. The rewind detects such an edit only when the counts no longer agree with the ledger, and then it falls back to today's state.
- **`resultingSecurityIds`.** `LedgerEntry` is `{ id, type, date, securityId, quantity }`. A transfer entry does not record which certificate it created.
- **Backfill and migration report.** No script exists for steps 2 and 3 of [Migration](#migration). Entries written before the CAP-2 fix have not been restated.
- **Manual ledger route.** `POST /api/c/:cid/transactions` was not in this proposal. The rewind reads its entries. It does not validate `type` or `quantity`, does not check that `securityId` belongs to the company, and does not call `invalidate()`.

## The problem

At the time of the proposal, every engine entry point took an `asOf` date and filters securities by their own date (`issueDate`, `grantDate`). It does not filter by the date of what happened to them since. The rows only hold their current state, because the write paths change them in place (`apps/server/src/routes/workflows.ts`):

| Event | What the route changes |
| --- | --- |
| Transfer | Source certificate: `status = TRANSFERRED`, or `quantity` reduced for a partial transfer |
| Repurchase | Source certificate: `status = REPURCHASED`, or `quantity` reduced |
| Exercise | Grant: `exercisedQuantity` raised, `status = EXERCISED` once used up |
| Cancellation | Grant: `cancelledQuantity` raised, `status = CANCELLED` or `EXPIRED` |
| Conversion | Convertible: `status = CONVERTED` |
| Any edit (`PATCH /api/c/:cid/<entity>/:id`) | Any field, including `quantity`, `status`, `exercisedQuantity` |

Each route also writes a dated row to `transactions`. The store never loads that table, so the engine cannot see it.

The result is that a view of an earlier date shows today's statuses and quantities. The audit's case: founders hold 4.5M and 3.5M common from 2020, there are 200k vested options and a 2M pool, and an event happens in 2024. Viewed as of 2023-01-01, the table should still read 8.0M outstanding, 200k options, a 1.8M unallocated pool and 10.0M fully diluted. What it reads instead:
- **Partial transfer of 1M:** 7.0M outstanding and 9.0M fully diluted.
- **Exercise:** 0 options and 9.8M fully diluted.
- **Cancellation:** 0 options and a 2.0M pool.
- **A SAFE converted in 2024:** gone from 2023 and from `dilutionHistory`.

The same goes for every as-of reader:
- the cap table and history routes;
- `dilutionHistory`;
- the waterfall at a past date;
- Rule 701 and the other compliance checks run for a past date;
- reports with an as-of date;
- the history reconciliation in section 6A of the audit.

Dates that are already recorded are fine: terminations, vesting, splits, valuations and pool adjustments all carry their own date.

## The units rule both options keep

A row keeps the share count and price of its own date, and `normalizeSplits` applies later splits when the data is read. Since the CAP-2 fix, a row written for an event (the new certificate on a transfer, the shares issued on an exercise, and every `transactions` entry from the transfer, exercise, repurchase and cancellation routes) is in the shares of the event's date.

Either design below has to keep this rule, so that undoing or replaying an event converts its quantity with `splitFactor(data, eventDate, recordedOn)`. Before the CAP-2 fix, the routes wrote the quantity as typed: the certificate's or grant's own units. Any migration has to tell the two apart (see Migration).

## Option A: a dated transactions ledger

The security rows hold their terms as issued. Every later change is a dated entry in `transactions`, which already exists with `type`, `date`, `security_id`, `quantity`, `price_per_share` and `amount`. This is how the Open Cap Format models the same facts: `StockTransfer`, `StockRepurchase`, `StockCancellation`, `EquityCompensationExercise` and `ConvertibleConversion` are dated transaction objects that refer to a security.

What changes:
- **Core types.** `CompanyData` gains `ledger: LedgerEntry[]`. Each entry has `{ type, date, securityId, quantity, resultingSecurityIds? }`, in the shares of its date.
- **Core engine.** A new `rewindToDate(data, asOf)` runs right after `normalizeSplits` in every entry point, the way `normalizeSplits` runs today. It starts from the current rows and undoes each entry dated after `asOf`:
  - a transfer or repurchase adds the quantity back to the source and restores `OUTSTANDING`;
  - an exercise lowers `exercisedQuantity`;
  - a cancellation lowers `cancelledQuantity` and restores `OUTSTANDING`;
  - a conversion restores `OUTSTANDING`.

  The certificates an event created are already dated after `asOf`, so the existing date filters drop them. Rewinding never touches today's view, which stays the fast path. A replay from the issue terms would also work, but it needs the original quantities, which the rows no longer hold.
- **Store.** `loadCompanyData` reads `transactions` alongside the other tables. The cache is per company, as now.
- **Write paths.** No new tables. The routes already write the entries.
  - A transfer needs the id of the certificate it created in the entry, which the route has.
  - `PATCH` on `quantity`, `status`, `exercisedQuantity` or `cancelledQuantity` of a security with ledger history must either be refused (deletion already is) or write a `CORRECTION` entry. A correction changes the record for every date, because it says the record was wrong, not that something happened.
  - The import engine and the sample already write `ISSUANCE`, `GRANT`, `EXERCISE` and `CANCELLATION` entries. They need the same types as the routes.
- **UI.** Nothing has to change. A ledger page per security already exists (`detail-shared.ts`).

Cost and risk:
- About one to two weeks with the model-based route test the audit asks for (random event sequences through the routes, compared with an in-memory replay at every earlier date).
- The main risk is a write path that edits a row without writing an entry. The `PATCH` guard and the model-based test are the defence.

## Option B: effective-dated rows

Each mutable security row gets a validity interval (`valid_from`, `valid_to`). An event closes the current version and inserts a new one, and the engine picks the version valid at `asOf`.

What changes:
- **Schema.** Security ids are referenced from many places:
  - `exercises.award_id`;
  - `issuances.source_award_id`;
  - `transactions.security_id`;
  - documents and signatures;
  - the certificate and grant pages.

  So versions cannot be new rows under new ids. They need a separate `security_versions` table keyed by `(security_id, valid_from)`, or a composite key on each security table.
- **Every reader.** Each query on `issuances`, `awards`, `warrants` or `convertibles` that wants the current state must add `valid_to IS NULL`. That covers the store, search, certificates, documents, exports, the AI context, report builder, tax forms and imports, which is several dozen queries.
- **Core types.** Each security carries its versions, or the store builds a `CompanyData` per as-of date. That breaks the one-snapshot cache that every route relies on.
- **Write paths.** Every route that changes a security closes and opens a version inside its transaction, and `PATCH` has to choose between correcting the current version and adding a new one.

Cost and risk:
- About two to four weeks, mostly in the readers and the cache.
- The main risk is a reader that forgets the `valid_to` filter. It would double-count a security, and today's view would break, not just past ones.

## Migration

The same for both options, since both start from the `transactions` rows the routes have written so far.

1. Back up first (`npm run backup`). Run the migration on a copy of the database before production.
2. **Find each existing entry's units.** Entries written before the CAP-2 fix hold the quantity as typed: the security's own units. For entries created before the release that carries the fix was deployed, multiply by `splitFactor(data, recordedOn, entry.date)` to restate them in the shares of their date. This only matters where a split falls between the security's date and the entry's. A certificate created by a transfer (`TR-…`, its notes name the source) confirms the factor: the new certificate and the entry must agree.
3. **Check each security against its entries.**
   - A transferred or repurchased certificate: current quantity plus Σ entries equals the quantity originally issued.
   - A grant: `exercisedQuantity` equals Σ `exercises`, and `cancelledQuantity` equals Σ cancellation entries.
   - A converted convertible has a `CONVERSION` entry on `convertedOn`.

   Where they disagree (rows imported or edited without entries), write a `CORRECTION` entry dated the security's own date. Its history then reads as it does today, and it is listed in a migration report for review. Nothing is guessed silently.
4. For Option B only: create one version per security, valid from its own date, and split it at each entry date.
5. Re-run the cap table at today's date before and after, for every company. It must not change. Then compare as-of views at each round's closing date against the exports, as in section 6A step 6 of the audit.

A partial fix needs no schema change and can ship first: a convertible already stores `convertedOn`, and grants have dated `exercises` rows. The engine can treat a convertible as outstanding before `convertedOn`, and count only exercises dated on or before `asOf`. Transfers, repurchases and cancellations still need the ledger.

## Recommendation

Option A, the dated ledger:
- **The data is already there.** The `transactions` table exists, every route writes to it, and the import and the sample fill it.
- **It fits the engine.** Rewinding is one more normalisation step at the entry points, next to `normalizeSplits`. No reader outside the engine changes, and today's view is untouched.
- **It matches the standard.** It is the Open Cap Format's model and the audit's source for CAP-1 (OCF `StockTransfer`). An OCF export or import later maps onto it directly.
- **It is the smaller change.** Option B touches every query on four tables and the cache, for the same result.

Suggested order:
1. The partial fix above.
2. Load the ledger, and add the `PATCH` guard and `CORRECTION` entries.
3. `rewindToDate` with unit tests for each entry type, including one across a split.
4. The backfill script with its report, run on a copy.
5. The model-based route test in `apps/server/test`. Import `src` only after `freshDatabase()`.
