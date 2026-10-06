# As-of cap tables: a dated ledger or effective-dated rows

Status: Option A accepted and built, except for the items listed under "Not built". Math audit 2026-10-05, bug CAP-1. See [Where this stands](#where-this-stands) for what the code does today; the sections after it are the original proposal.

## Where this stands

### Built

- **Database trigger.** PostgreSQL holds the rule, so no writer can skip it: a route, the import, the seed, the sample, a test or a hand-written `UPDATE`. A deferred constraint trigger (`ledger_entry_required` in `apps/server/src/db.ts`) fails the `COMMIT` of any transaction that inserts or deletes a row of `issuances`, `awards`, `warrants` or `convertibles`, or updates one of these columns, unless the same transaction also wrote a `transactions` row for that security:
  - `issuances`: `stakeholder_id`, `share_class_id`, `quantity`, `issue_date`, `status`, `price_per_share`, `vesting_schedule_id`, `vesting_start_date`;
  - `awards`: `stakeholder_id`, `pool_id`, `quantity`, `grant_date`, `status`, `exercised_quantity`, `cancelled_quantity`, `type`, `strike_price`, `vesting_start_date`, `vesting_schedule_id`, `expiration_date`, `ptep_months`, `fmv_at_grant`;
  - `warrants`: `stakeholder_id`, `share_class_id`, `quantity`, `issue_date`, `status`, `exercised_quantity`, `strike_price`, `expiration_date`;
  - `convertibles`: `stakeholder_id`, `instrument`, `principal`, `issue_date`, `valuation_cap`, `discount`, `interest_rate`, `compounding`, `maturity_date`, `mfn`, `qualified_financing_minimum`, `status`, `converted_into_share_class_id`, `converted_on`.

  These are the columns of those rows that a view of an earlier date reads (`packages/core` types, `apps/server/src/store.ts`). Not on the list: labels and notes, the compliance-only flags `early_exercised`, `election_83b_filed_on` and `early_exercise_allowed`, `rsu_liquidity_condition`, `net_exercise` and `pro_rata_right`, which no view reads, and `funds_received_on`, which the store does not load.

  A change to `stock_splits` (insert, delete, or a new `date` or `ratio`) needs a company `STOCK_SPLIT` entry (`security_id` null) in the same transaction. `transactions.xact_id` defaults to `pg_current_xact_id()`, which is how the trigger finds the entries of its own transaction. Because the check is deferred, the entry may be written after the change. Two cases need no entry: a row that is not yet issued (`DRAFT`, `PENDING_APPROVAL`, `PENDING_SIGNATURE`) before and after the change, because it is not on the cap table, and the rows of a company that is deleted in the same transaction. There is no bypass. Tests insert securities with `insertSecurity` (`apps/server/test/helpers.ts`), which writes the row and its entry together.
- **Creation entries.** Every issued security has a dated creation entry: `GRANT` for an award, else `ISSUANCE` (the amount for a convertible). The generic `POST`, signing, approval, the import, the seed and the sample write it. So do the routes that issue a certificate as part of an event: an exercise of a grant or warrant, a transfer, a conversion. Those certificates had no entry of their own before the trigger.
- **Store.** `loadCompanyData` reads `transactions` rows that have a `security_id` into `CompanyData.ledger` (`apps/server/src/store.ts:38`, `:180`).
- **Engine.** `rewindToDate` (`packages/core/src/ledger.ts`) undoes transfers, repurchases, exercises (of grants and warrants), cancellations (of certificates, grants, warrants and convertibles, including an import's `FORFEITURE` and `EXPIRATION`), warrant expiries, conversions, repayments (`REPAYMENT`) and corrections dated after `asOf`.
- **Order.** `normalizeSplits` calls `rewindToDate` first, before it applies splits (`packages/core/src/splits.ts`), not after it as proposed below. The ledger converts units itself with `splitsBetween`, a copy of `splitFactor` that avoids an import cycle.
- **Partial fix.** A convertible counts as outstanding before `convertedOn`. If `convertedOn` is not set, the date of its `CONVERSION` entry is used.
- **Fallback.** When the ledger cannot rebuild a row's history, the row keeps today's state, the same as before the ledger existed. This covers rows older than the ledger, imports, rows edited by hand, and entries without a quantity.
- **Tests.** Unit tests per entry type are in `packages/core/test/ledger.test.ts`. The model-based route test is `apps/server/test/ledger-replay.test.ts`.
- **MFN elections.** `POST /api/c/:cid/convertibles/:id/mfn-election` writes an `MFN_ELECTION` entry naming the adopted instrument (`adopted_security_id`) and leaves the convertible row as issued. From the entry's date every view converts the MFN instrument on the adopted terms as they stood on the election date (`electedTerms`, `packages/core/src/convertibles.ts`); before it, on its own. A later `CORRECTION` of the adopted instrument's terms is not what the holder elected. The adopted instrument's own date cannot be corrected to after the election or before the MFN instrument's date: the election would lapse.
- **Delete guard.** An issued security can be deleted only while its creation entry is all its ledger holds. That is a security entered by mistake. The route writes a `CORRECTION` entry with `field = 'deleted'` (and the `?reason=` given), and keeps the creation entry. A security with any later entry is refused, and the message points to its cancel route. A convertible whose terms an MFN holder elected cannot be deleted (`apps/server/src/routes/entities.ts`).
- **`PATCH` guard.** `PATCH /api/c/:cid/{issuances,awards,warrants,convertibles}/:id` refuses a change that an event route makes, and names the route: a transfer, repurchase, exercise, cancellation, expiry, repayment or conversion status, a raised `exercisedQuantity` or `cancelledQuantity`, or a changed `convertedOn`. It also refuses to reopen a closed security, and any status change into or out of `PENDING_APPROVAL` or `PENDING_SIGNATURE`: only the approval and signing flows move a security there or issue it. `POST` refuses those statuses too.
- **Typo corrections.** On an issued security, a change to the holder (`stakeholderId`), the class or plan (`shareClassId`, `poolId`) or the security's own date (`issueDate`, `grantDate`) is a typo fix. It needs a non-empty `reason`. The route writes one `CORRECTION` entry per field with `field`, `before_value`, `after_value` (JSON) and `reason`. `rewindToDate` ignores these entries, so the corrected value holds on every date: the record always should have said so. It is never a transfer, and the message for a holder change without a reason points to the transfer route. A holder or class correction is refused once the security has any ledger entry besides its creation and corrections (a transfer, repurchase, exercise, cancellation, MFN election and so on): a new holder may then be a transfer in disguise, and the message points to the transfer route. A correction of any of the three is refused if the certificate was issued by a transfer, exercise or conversion: that event sets its holder, class and date. A date correction is also refused if a stock split falls between the old and the new date (the share count would change), or if it moves past one of the security's own events.
- **Creation.** `POST` creates a security in its initial state only: not closed, nothing exercised or cancelled, not converted. A security with a past comes through the import.
- **`CORRECTION` entries.** A changed `quantity`, or a lowered `exercisedQuantity` or `cancelledQuantity`, is a correction. So is a change to an issued security's terms (`CORRECTED_TERMS`, `packages/core/src/types.ts`): a certificate's `pricePerShare`, `vestingScheduleId` and `vestingStartDate`; a grant's `type`, `strikePrice`, `vestingStartDate`, `vestingScheduleId`, `expirationDate`, `ptepMonths` and `fmvAtGrant`; a warrant's `strikePrice` and `expirationDate`; an outstanding convertible's `principal`, `valuationCap`, `discount`, `interestRate`, `compounding`, `instrument`, `maturityDate`, `mfn` and `qualifiedFinancingMinimum`. So a vested-as-of count, a strike or a warrant's expiry in a past view reads the terms of that date. The request must give an `effectiveDate`, on or after the security's own date and not in the future. The route writes one `CORRECTION` entry per count, with the signed change in the shares of that date and the count's name in `transactions.field`. For a term it writes the values before and after instead, and `rewindToDate` restores the value before on earlier dates. A correction dated the security's own date holds for every date. Only an outstanding certificate's count can be corrected, and not a cancelled or expired warrant's. The web forms ask for the date when a share count or a term changes, and for the reason of a typo correction.
- **Stock splits.** A split restates every ledger entry dated on or after it against a security issued before it, because those entries are in the shares of their own day. So a split (created, changed or deleted) is refused when such an entry already exists, and the message names the latest one. Before this rule, a 2:1 split added later and dated 2021 turned a 2022 cancellation of 40 shares into 20 old shares, and a 100-share certificate read 80 in 2020. Every change to a split writes a `STOCK_SPLIT` entry with the split before and after.
- **Consistent corrections.** A grant's or warrant's exercised count cannot fall below the shares its `EXERCISE` entries issued (those certificates stand), and its size cannot fall below what was exercised and cancelled. After a correction the status follows the counts, as the exercise and cancel routes set it: `OUTSTANDING` while something is left, else `EXERCISED` (or `CANCELLED`).
- **Event routes.** Each changes the row, writes a dated entry in the shares of its date, records an audit entry and calls `invalidate()`:
  - `POST /api/c/:cid/warrants/:id/exercise`: issues the shares, `EXERCISE`, as the grant exercise route does;
  - `POST /api/c/:cid/issuances/:id/cancel`: part or all of an outstanding certificate, `CANCELLATION`;
  - `POST /api/c/:cid/warrants/:id/cancel`: what is left of a warrant, `EXPIRATION` (reason `EXPIRED`) or `CANCELLATION`;
  - `POST /api/c/:cid/convertibles/:id/repay` and `/cancel`: `REPAYMENT` (with the amount paid) or `CANCELLATION`.

  The web has buttons for each on the certificate, warrant and SAFE/note lists.
- **Manual ledger route.** `POST /api/c/:cid/transactions` checks `type` against `TRANSACTION_TYPES`, requires a positive integer `quantity` for an entry against a security, checks that the security belongs to the company, and calls `invalidate()`. It refuses an entry the engine rewinds (`REWOUND_TYPES`: transfer, repurchase, exercise, cancellation, forfeiture, expiration, conversion, correction, repayment) against a security: only the event routes, which change the row too, write those.
- **Signed documents.** Once anyone has signed, a document's `body` and `status` cannot be edited, it cannot be deleted, and it cannot be linked to another security or another holder (`stakeholderId`). Its name and category are labels and can change; the audit entry records them before and after. A signature stores the SHA-256 of what it signed: the body and the stored certificate face (`signedHash` in `certificates.ts`; signatures made before that hold the hash of the body alone, which is still checked). The documents list flags `tampered` when either no longer matches, and the printed and PDF copies carry a warning.
- **Withdrawing.** `cancel-signing` on a certificate, grant or SAFE/note deletes a document nobody has signed. A document someone has signed is voided instead: its status becomes `VOID`, it is kept with its signatures, the blocks not yet signed become `VOID` and cannot be signed, and the audit log records it.
- **Corrected certificates.** When an issued certificate's count, price, holder, class or date changes and its certificate document is signed, the route voids that document and sends a replacement, written from the corrected record, for the holder and the Company to sign. Until both sign, the documents list flags the replacement (`resign`), and the certificates page shows the certificate as awaiting re-signing.
- **Event dates.** A transfer, repurchase or cancellation cannot be dated before the security's issue or grant date. Only an outstanding certificate can be repurchased.

### Not built: what the code does instead

- **`resultingSecurityIds`.** `LedgerEntry` is `{ id, type, date, securityId, quantity, field }`. A transfer entry does not record which certificate it created.
- **Backfill and migration report.** No script exists for steps 2 and 3 of [Migration](#migration). Entries written before the CAP-2 fix have not been restated.
- **Import of closed states.** The import writes an `EXERCISE` for a grant's exercised count, dated by the optional `exerciseDate` column, and a `CONVERSION`, `REPAYMENT` or `CANCELLATION` for a settled convertible, dated by the optional `settledDate` column (`convertedOn` too). Without the date, the entry is dated the grant or issue date, so every past view reads the row as today, and the preview says so. The import does not import warrants: that needs a new import kind with its own fields and template.
- **Other signed agreements.** Only certificates are voided and reissued after a correction. A grant agreement or a SAFE/note agreement that was signed still names the old figures after a correction of the grant or the instrument.
- **Splits behind the ledger.** A split dated before entries already recorded is refused. There is no correction that restates those entries in the new units.

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
