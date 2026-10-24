# Open Cap Format (OCF)

Kosmitor exports a company's cap table, with its history, as an
[Open Cap Format](https://github.com/Open-Cap-Table-Coalition/Open-Cap-Format-OCF)
package: the Open Cap Table Coalition's JSON format for moving cap tables between
tools. It writes **OCF 1.2.0**, the latest tagged release. Kosmitor's model already
follows OCF: the dated ledger (`docs/design/dated-ledger.md`) records the same
transfers, repurchases, cancellations, exercises and conversions that OCF records as
transactions, and vesting is allocated the way OCF calls `CUMULATIVE_ROUND_DOWN`.

Kosmitor also imports a package, its own or another tool's, through the import page:
see [Importing](#importing) below, and [Importing data](importing.md#ocf-packages) for
the screens and the API.

## Exporting

On the cap table, **Export ▾ → Open Cap Format (.ocf.zip)** ("Cap table and history in
Open Cap Format 1.2.0, for another cap table tool. Some details are approximated; the
package lists them") downloads `cap-table-<today>.ocf.zip`: the cap table and its
history as of today. It takes none of the page's options (date, view, convertibles,
pool): OCF records the history, and a reader works out any date from it. After the
download the page says how many things the package leaves out or shows differently
from Kosmitor, with **See what** to list them.

`GET /api/c/:cid/captable/export.ocf.zip` serves it (`read` access; a member who sees
only their own holdings gets 403). Each download writes an `EXPORT` audit entry,
"Cap table exported as an OCF package". The sample company may be exported. Its
`X-Ocf-Notes` header is the number of those notes (the manifest's comments after the
first two); `GET /api/c/:cid/captable/export.ocf.notes` returns `{ asOf, notes }`, the
same comments for the package of today, for the page to list. It exports nothing, so it
writes no audit entry.

### The package

A zip with its files flat at the root, named as in the coalition's samples. Every file
is always there, with `items: []` when there is nothing; there is no financings or
documents file.

| File | `file_type` | Holds |
|---|---|---|
| `Manifest.ocf.json` | `OCF_MANIFEST_FILE` | the issuer, `as_of` (today), `generated_at`, comments, and each file below with the MD5 of its bytes |
| `Stakeholders.ocf.json` | `OCF_STAKEHOLDERS_FILE` | every stakeholder |
| `StockClasses.ocf.json` | `OCF_STOCK_CLASSES_FILE` | every share class |
| `StockLegends.ocf.json` | `OCF_STOCK_LEGEND_TEMPLATES_FILE` | each class's legend |
| `StockPlans.ocf.json` | `OCF_STOCK_PLANS_FILE` | every equity plan |
| `VestingTerms.ocf.json` | `OCF_VESTING_TERMS_FILE` | each vesting schedule an exported security uses |
| `Valuations.ocf.json` | `OCF_VALUATIONS_FILE` | 409A valuations that are not drafts |
| `Transactions.ocf.json` | `OCF_TRANSACTIONS_FILE` | every issuance and event to `as_of`, in the order they became known |

The package is the cap table **as of its `as_of`**, today: a security issued after it,
and an event, valuation or plan increase dated after it, is left out, with a comment
("Securities, events and valuations dated after 2026-10-24, the date of this package,
are not included: 3."). A vesting start is a term of its security and stays with it,
whatever its date.

Files are two-space JSON with a final newline. The manifest's first two comments are
"Exported by Kosmitor from <company>." and where the Kosmitor note is; the others say
what the package leaves out or shows differently (the page lists them after a
download), for example:

- "2 securities not yet issued (drafts, or awaiting approval or signatures) are not included."
- "1 valuation of a type OCF 1.2.0 has no place for (PREFERRED_PRICE) is not included."
- "Share counts corrected after issue are shown as corrected from the issue date: CS-4 (corrected on 2025-02-01)."
- "The certificate a transfer created is not on record; the transfer is shown as a cancellation: CS-9 on 2024-06-01."
- "OCF's vesting conditions cannot state these schedules exactly, so each security on them also lists its own vestings: 4 years back-loaded (10/20/30/40)."
- "Options a holder lost on leaving, which Kosmitor works out from the leaving date with no ledger entry, are given as cancellations: OPT-8 (unvested on 2023-06-30), OPT-8 (window closed on 2023-10-01)."
- "SAFE-2 elected the terms of SAFE-3 on 2023-02-01 (MFN); its conversion terms in the package are as issued."
- "Restricted stock awards with no certificate on record are given as stock issuances with issuance_type RSA and their plan. Kosmitor counts such shares only once a certificate is issued, so another tool shows them as outstanding where Kosmitor does not: RSA-1."
- "Emails OCF's format does not accept, and signatories with no email, are kept only in Kosmitor's notes: Gale Street Trust."

Two exports of the same company differ only in the manifest's `generated_at`,
`as_of` and checksums.

### Ids

Objects keep Kosmitor's ids, so an export is stable from one day to the next and a
package can be matched back to the company it came from.

| OCF object | `id` / `security_id` |
|---|---|
| Issuer | the company's id |
| Stakeholder, StockClass, StockPlan, VestingTerms, Valuation | the row's id |
| StockLegendTemplate | `<shareClassId>.legend` |
| A security (`security_id`) | the row's id (`issuances`, `awards`, `warrants`, `convertibles`) |
| A balance certificate | `<rowId>.b<n>`, n = 1, 2, … in event order; its `custom_id` is the original's with `-B<n>` (CS-1-B2) |
| An issuance transaction | `<securityId>.issue` |
| An event from the ledger | the `transactions` entry's id |
| Vesting start | `<securityId>.vesting-start` |
| A milestone's vesting event | `<securityId>.milestone.<milestoneId>` |
| A grant's acceptance | `<awardId>.accept` |
| A stock split | `<stockSplitId>.<shareClassId>`, one per class |
| A plan increase | the `pool_adjustments` row's id |
| A state the ledger does not date | `<securityId>.closed`, `.exercised` or `.cancelled` |
| Options a leaver lost | `<awardId>.lapsed` (unvested on leaving), `<awardId>.window-closed` (vested, when the exercise window closed) |
| Vesting conditions | `start`, `cliff`, `periodic`, `tranche-<k>`, `milestone-<milestoneId>` |

A security's `custom_id` is its certificate number or label, else the last six
characters of its id in capitals, and then its note says `unnumbered`, so an import
keeps no number for it. Warrants have no number column: they are `W-1`, `W-2`, … by
issue date, unless an import kept the package's number in the warrant's notes
("Warrant number: WX-7; purchase price: 100.00 USD"), which the export reads back.

### Units

Money is written from integer cents (`{ "amount": "1250000.00", "currency": "USD" }`)
and per-share prices from integer micro-cents, with two to six decimals ("1.00",
"0.0001"); a split-adjusted price that holds a fraction of a micro-cent gets up to
ten. Counts are decimal strings, never in exponent notation. Ratios and vesting
portions are the simplest fractions (2 is 2/1, a third is 1/3). The currency is the
company's when it is a three-letter code, else `locale.currency`. The code is in
`apps/server/src/ocf/convert.ts`, which reads amounts back by string arithmetic for the
import.

### What each object holds

- **Issuer**: the legal name (`dba` the display name when they differ), the
  incorporation date as `formation_date` (else the earliest date on the cap table,
  with a comment), the country and state of formation from the jurisdiction (a US
  state or Canadian province by name or code, a country by name or two-letter code;
  anything else is given as the US with a comment, and the jurisdiction as typed in
  the issuer's note), the EIN, and the address when the country is known (else the
  address is in the note).
- **Stakeholder**: the legal name, INDIVIDUAL or INSTITUTION, the employee id as
  `issuer_assigned_id`, the relationship (a contractor is a `CONSULTANT`, a former
  employee an `EX_EMPLOYEE`), emails in OCF's email format and a phone in its
  international form (others in the note, with a comment), an institution's signatory
  as `primary_contact` when there is an email for them (OCF needs one; else the note),
  the address when it has a two-letter country (a region that is not an ISO code in
  the note), and the notes as a plain comment.
- **StockClass**: authorized shares, votes, par and original issue price, seniority
  (higher is paid first, as in Kosmitor), for preferred the liquidation multiple, the
  participation cap and a conversion right into the first common class at the
  conversion ratio. `default_id_prefix` is the class's most common certificate prefix.
- **StockPlan**: the reserve, approval dates, `RETURN_TO_POOL` or `RETIRE`, and the
  class. Each plan increase is a `TX_STOCK_PLAN_POOL_ADJUSTMENT` with the reserve after it.
- **VestingTerms**: see [Vesting](#vesting).
- **Valuation**: 409A valuations that are not drafts, priced in the first common class.
- **Certificates**: a `TX_STOCK_ISSUANCE` of what the certificate was issued with,
  rebuilt from today's row and its ledger entries, then each transfer
  (`TX_STOCK_TRANSFER` to the certificate it created, with what was paid as
  `consideration_text`), repurchase, cancellation and conversion. One that leaves
  shares behind names a balance certificate, issued the same day for what is left,
  which carries on. A certificate's federal and state exemptions are
  `security_law_exemptions`; its class's legend is in `stock_legend_ids`; its notes are
  a plain comment. A cancellation's note says which ledger entry it was.
- **Restricted stock awards**: shares, so a stock issuance with `issuance_type` RSA and
  the award's plan. When a certificate on record is the award's shares (it names the
  award as its source, or has its holder, class, date and count), that certificate
  carries the award in its note (`rsaAward`) and there is no second issuance of the
  same shares. An award with no certificate is a stock issuance of its own (the note's
  `award`), with a comment: Kosmitor counts its shares only once a certificate is
  issued, and another tool counts them now (see [Differences](#differences-a-reader-sees)).
- **Grants**: a `TX_EQUITY_COMPENSATION_ISSUANCE` (ISO and NSO as `OPTION_ISO` and
  `OPTION_NSO`, a SAR as `SSAR` with its `base_price`, an RSU; a phantom unit reads as
  an RSU and a growth share as an `OPTION` of type `INTL`, with the note saying which),
  the expiry (null, with `noExpiration` in the note, for one that never expires), the
  post-termination window for every termination reason, the acceptance, then
  exercises (an RSU's as a release; the note keeps the method, the fair market value,
  the shares issued and what was paid), cancellations, forfeitures and expiries. A
  grant keeps one security throughout.
- **A leaver's options**: Kosmitor drops a leaver's options with no ledger entry (the
  part unvested on the leaving date, and for an ISO or NSO the vested part once the
  post-termination window has closed: `awardPosition` and `awardIsLive` in
  `packages/core/src/captable.ts`). The export writes each as a dated
  `TX_EQUITY_COMPENSATION_CANCELLATION` (`<awardId>.lapsed`, `<awardId>.window-closed`),
  in the shares of its date, with the note `lapse`, so another tool sees them go; an
  import that brings the leaving date with it does not enter them again.
- **Warrants**: a `TX_WARRANT_ISSUANCE` with an at-will exercise trigger for a fixed
  number of shares of its class, then exercises (the number exercised, the method and
  what was paid in the note: OCF's `WarrantExercise` has no quantity), cancellations
  and expiries. A count lowered after the issue date (a correction, or a part
  cancelled) is a dated `TX_WARRANT_CANCELLATION` of that part, and the issuance says
  what was issued.
- **SAFEs and notes**: a `TX_CONVERTIBLE_ISSUANCE` with a conversion on the next
  equity financing (a SAFE's cap, discount, MFN and pre- or post-money timing; a
  note's interest, compounding, cap and discount), a second trigger at maturity, the
  board approval date, then the conversion, a repayment or a cancellation
  (`TX_CONVERTIBLE_CANCELLATION`). A repayment cancels the principal, OCF's "amount
  cancelled"; the cash repaid, interest included, is in the reason ("Repaid 260000.00
  USD") and the note. An MFN election is a sentence on the SAFE that elected and in the
  manifest; its terms in the package are the ones it was issued with.
- **Stock splits**: one `TX_STOCK_CLASS_SPLIT` per class in use on the date.

Quantities are in the shares of each transaction's own date, as the ledger keeps them.
Transactions are in the order they became known: by date, then splits and plan
increases, issuances, vesting starts and acceptances, events, balances, and vesting
events; a vesting start (or a milestone reached) comes right after the issuance of its
security whatever its own date, so a reader never meets it before the security. A
balance's vesting start is dated as the original's (the balance vests on the original
schedule).

States the ledger does not date (a row older than the ledger, an import's exercised
options, a security closed by an edit) are dated the security's own date, which is how
every view of an earlier date reads them, with a comment.

Not exported: unissued securities; anything dated after `as_of`; valuations other
than 409A; documents and financings; corrections of terms, holders or dates (the
current values are); share counts corrected after issue on a certificate or grant
(folded into the issue, with a comment); secondary sales, retirements and dividends;
the history of authorized shares.

### The Kosmitor note

OCF objects allow no extra properties, so the fields Kosmitor keeps beyond them travel
in one comment, the last of the object's `comments`:

```
kosmitor:1:{"startDate":"2021-01-04","boardSeat":true,"boardSeatStart":"2021-01-04"}
```

It is written only when there is something to carry. Reading (`readNote` in
`apps/server/src/ocf/notes.ts`) takes the first comment with the prefix from any
package, keeps only the keys allowed for the object, checks each, and ignores anything
malformed or unknown. A note never overrides a field OCF itself has.

| Object | Keys |
|---|---|
| ISSUER | `address`, `jurisdiction` (as typed, when the country of formation is not known) |
| STAKEHOLDER | `name` (when it differs from the legal name), `type` (TRUST or FUND), `title`, `department`, `startDate`, `terminationDate`, `taxCountry`, `taxState`, `boardSeat`, `boardSeatStart`, `boardSeatEnd`, `boardDesignatedBy` (a stakeholder id in the package), and as typed when OCF cannot hold them: `address`, `phone`, `region`, `email`, `secondaryEmail`, `signatory`, `signatoryEmail` |
| STOCK_CLASS | `issueDate`, `participation`, `participationCap`, `dividendType`, `dividendRate`, `dividendCompounding`, `dividendsParticipateInResidual`, `antiDilution`, `payToPlay`, `isConvertible` |
| STOCK_PLAN | `evergreenPercent`, `planType` |
| VESTING_TERMS | `schedule` (the whole schedule, milestones without achieved dates; at most 600 months) and `digest` |
| VALUATION | `type`, `status`, `expirationDate`, `method`, `enterpriseValue` (cents), `reportUrl` |
| TX_STOCK_ISSUANCE | `earlyExercised`, `election83bFiledOn`, `unnumbered`; for an RSA with no certificate `award` (`label`, `ptepMonths`, `expirationDate`, `fmvAtGrant`); for the certificate of an RSA's shares `rsaAward` (those, and `quantity`, `grantDate`, `price`, `vestingTermsId` and `vestingStartDate` when they are not the certificate's, and its own cancellations as `entries`) |
| TX_EQUITY_COMPENSATION_ISSUANCE | `type` (PHANTOM, GROWTH_SHARE), `fmvAtGrant` (micro-cents), `rsuLiquidityCondition`, `noExpiration`, `unnumbered` |
| TX_EQUITY_COMPENSATION_EXERCISE, _RELEASE | `method`, `fmvAtExercise` (micro-cents), `sharesIssued`, `amount` (cents) |
| TX_WARRANT_ISSUANCE | `netExercise` |
| TX_WARRANT_EXERCISE | `quantity`, `method`, `amount` (cents) |
| TX_STOCK_CANCELLATION, TX_EQUITY_COMPENSATION_CANCELLATION, TX_WARRANT_CANCELLATION | `type` (the ledger entry: CANCELLATION, FORFEITURE, EXPIRATION, or CORRECTION for a warrant's lowered count), `lapse` (`termination` or `window`) |
| TX_CONVERTIBLE_ISSUANCE | `instrument`, `compounding`, `qualifiedFinancingMinimum` (cents), `proRataRight`, `mfnElections` (`date`, `adoptedSecurityId`), `fundsReceivedOn`, `fundsReference`, `unnumbered` |
| TX_CONVERTIBLE_CANCELLATION | `type` (REPAYMENT or CANCELLATION), `repaid` (cents) |

### Vesting

Every exported schedule is OCF vesting terms with `allocation_type`
`CUMULATIVE_ROUND_DOWN`, which is how Kosmitor allocates shares: the shares vested by a
date are the whole shares of the exact fraction vested by then. The description says
the schedule in a sentence ("48 months, 12-month cliff, then monthly").

- **Time-based**: a start, a cliff of C/D after C months, then p/D every p months,
  on the vesting start's day or the month's last day. Exact for monthly, quarterly or
  annual vesting with no year weights, nothing at the start, and a cliff and duration
  in whole periods.
- **Fully vested**: everything at the start. Exact.
- **Custom**: the start, then each tranche on its date. Exact.
- **Milestones**: the start, then each milestone as an event, achieved ones first;
  each security on the schedule gets a `TX_VESTING_EVENT` per achieved milestone.

Acceleration has no OCF form: it is in the description and the note. For each
security the export works out what the terms vest the way an OCF reader would
(`evaluateTerms`), and when that differs from what Kosmitor vests (a back-loaded or
weekly schedule, an amount at the start, milestones), it adds the security's own
`vestings`: the dates and amounts Kosmitor vests, with no termination or change of
control.

## Importing

A package goes through the import page like a spreadsheet ([Importing
data](importing.md#ocf-packages)): parse, the check, the import. `src/ocf/read.ts`
reads it, `src/ocf/plan.ts` works out every row and what it would write, and
`src/ocf/write.ts` writes it, in the transaction the import holds, so it lands whole or
not at all. Nothing in a package is trusted: the zip is opened with the import's
unpacking limit and only its JSON is unpacked, within `limits.importJsonMb`; the JSON
must be UTF-8 and is bounded in size, depth and object count; keys that reach a
prototype are dropped, and ids and types are looked up only as a table's own keys, so
"constructor" is an id like any other; every value is read as OCF allows it or is the
row's error, an amount past what a column holds included; vesting is bounded (below);
and ids are only ever looked up, never used as Kosmitor ids. Kosmitor mints its own ids and keeps the package's in the memo of each
ledger entry, "Imported from cap-table.ocf.zip (OCF <id>)" (the export leaves that
part out when it reads a memo back as a reason).

**Securities and their history.** Each security is a row: its issuance and the
events about it, in date order, replayed into the state it ends in, with a dated
ledger entry for each event in the shares of its date, so every earlier date reads as
the package says. A balance certificate (`balance_security_id`), or a re-issue for a
split or to the same holder, carries a row on rather than starting one; each
certificate a transfer, exercise or conversion creates is a row of its own, and its
`resulting_security_id` is recorded. A row and every row its events created are a
**family**, imported whole or not at all: an error anywhere in it holds the rest back
("Waits for item N"), and leaving one out leaves them all out.

| OCF | Kosmitor |
|---|---|
| TX_STOCK_TRANSFER, _REPURCHASE, _CANCELLATION, _CONVERSION | TRANSFER, REPURCHASE, CANCELLATION, CONVERSION; a whole one closes the certificate, a part lowers it. One that leaves shares and names no balance keeps them on the certificate (`ocf-no-balance`) |
| TX_STOCK_REISSUANCE | folded into the certificate for a split or the same holder; else a transfer to the same holder |
| TX_EQUITY_COMPENSATION_EXERCISE, _RELEASE | EXERCISE, an `exercises` row (method, fair market value and shares issued from the note; else cash, the release price, or the latest valuation before it restated in the shares of that day), and the shares issued (with `source_award_id`) |
| TX_EQUITY_COMPENSATION_CANCELLATION | CANCELLATION, FORFEITURE or EXPIRATION, as its note says, else by its reason. A lapse the note marks is not entered when the holder's leaving date comes with the package: Kosmitor works it out from that date |
| TX_WARRANT_EXERCISE | EXERCISE of the note's quantity, else the shares it issued; what was paid from the note (nothing for a net exercise), else the strike |
| TX_WARRANT_CANCELLATION | CANCELLATION or EXPIRATION when it ends the warrant; a part is a CORRECTION of its count |
| TX_CONVERTIBLE_CONVERSION, _CANCELLATION | CONVERSION; REPAYMENT (the note, or a reason like "Repaid", with the cash repaid from the note or the reason) or CANCELLATION. A part of one is refused (`ocf-unsupported`) |
| Transfers of grants, warrants, SAFEs | a cancellation, and the new ones as their own (`ocf-transfer-as-cancellation`) |
| TX_VESTING_ACCELERATION | VESTING_ACCELERATION in the ledger, not applied to vesting (`ocf-acceleration-not-applied`) |
| TX_VESTING_START, TX_VESTING_EVENT, acceptances of grants | the vesting start, a milestone's date, the accepted date |
| A retraction | the whole family is not imported |
| TX_STOCK_CLASS_SPLIT | one split for the classes split together on a date; all classes with shares before it, into an empty cap table only |
| TX_STOCK_PLAN_POOL_ADJUSTMENT | a plan adjustment of the change in the reserve |
| Class authorized-share and conversion-ratio adjustments | the latest one is the class's (`ocf-history-current-only`) |

A certificate a transfer created names the one it came from in its notes,
"Transferred from certificate CS-2", as the transfer route writes it, and keeps the
grant its shares were exercised from: the cap table traces the price paid in, and the
waterfall the date cumulative dividends run from, through it. A note that names the
security it came from by its package id names its Kosmitor row instead. What a
transfer or repurchase paid is its `consideration_text` ("50000.00 USD") when it gives
one, else the shares at the price.

**Objects.** A stakeholder takes its name (the note's display name, else the legal
name), its first email (one plain address, as the stakeholder form takes it: any other
is left out with a warning), phone, address, employee id and, for an institution, its
signatory; the relationship from `current_relationship` (a consultant is a
contractor, an ex-employee a former employee, an executive or officer an employee),
or a guess the check asks about. People the name cannot tell apart (two on file of
that name with no email) are told apart by what an earlier import of the package gave
them, through its ledger entries' "(OCF <id>)"; else the check asks. A share class takes its terms and its authorized
shares; a class of the same name on file is that class, and one nothing is issued
from yet takes the package's terms (the Common every new company starts with). Vesting
terms are the note's schedule while its digest matches, else a shape Kosmitor has
(fully vested, time-based with a cliff, dated tranches, milestones), else each
security on them gets a schedule of its own dates, each tranche as its portion of the
security, so a later split, or a transfer of some of a certificate, still vests the
right part of it; a security's own `vestings` win when they differ. A grant with no
plan goes in "Grants outside a plan"; one with no expiration gets
`equity.optionTermYears`, unless the note says it never expires; its post-termination
window is the voluntary leaver's, in months. The Kosmitor note is read from any package
and fills in what OCF has no field for.

**Vesting is bounded**, so a few bytes of terms cannot ask the check for millions of
dates: one path of at most 500 conditions; at most 20,000 dates for one security; a
period of at most 10,000 occurrences and 200 years; every date from 1900 to 2200; a
noted schedule of at most 600 months (the API refuses longer ones too). Terms past
these are the row's error (`ocf-unsupported`). The package as a whole may have at most
2,000,000 vesting dates across its securities; past that it is refused
(`ocf-too-large`).

**The company's own fields.** The issuer's legal name, formation date, jurisdiction
(from the country and state of formation, or the note), EIN and address fill in the
company's, where they are empty, and while the cap table is empty where they are what
a new company starts with (its creation date as the incorporation date, the default
legal name and jurisdiction). When the package is another company's (its legal name
and dba are not this one's: notice `ocf-other-issuer`), they go in only when the person
says so (`options.ocfCompanyFill`, the "Copy them" choice on the check). The audit line
and the Done screen say what was filled in, and which classes on file took the
package's terms.

**Already there.** When the package came from this company (its issuer id is the
company's), its ids are this company's rows and ledger entries. Otherwise people are
found by email then name, classes and plans by name, schedules by name and terms,
valuations by date and price, and securities as a spreadsheet's are: by number, else
by holder, class or type, final count and date. A family is wholly there when its
security is on the cap table, every event is one of its ledger entries and every
certificate it created is there too. When only part is, nothing of it is written and
the row says what differs. So importing a package again, or into the company it came
from, adds nothing.

**Not imported.** Financings and documents; legend templates that are not on every
certificate of one class; acceptances of shares, warrants and SAFEs; returns to the
plan; the company's authorized-share adjustments; transaction types of later OCF
versions. The check lists them under "Not imported".

## Coverage

"Full" means a reader of the package sees what Kosmitor shows, on every date; "partial"
says what is not carried, or differs. The round trip (export, then import into an
empty company) is tested on every date something happened and the day before: the cap
table (shares, options, RSUs, warrants, votes, invested amounts), the plans, vesting,
the waterfall, the exercises, what each event paid and the ledger entry by entry.

| OCF item | Export | Import |
|---|---|---|
| Manifest, Issuer | partial: the formation date is the earliest date on the cap table when none is on record, and an unknown jurisdiction is given as the US (the jurisdiction as typed in the note) | fills the company's empty fields and a new company's defaults; another company's only when the person says so |
| Stakeholder | partial: no relationship history (not in OCF 1.2.0); dates, board seat, exact type, and emails or a signatory OCF's formats refuse only in the note | full with the note; without it, no dates, and a guessed relationship when none is given |
| StockClass | partial: dividends, anti-dilution and the participation flag only in the note; `initial_shares_authorized` is today's authorized, not the first | full with the note; a class of the same name on file is that class |
| StockLegendTemplate | the class legends | a class's legend when every certificate of it has the same one |
| StockPlan, TX_STOCK_PLAN_POOL_ADJUSTMENT | full | full |
| VestingTerms, TX_VESTING_START, TX_VESTING_EVENT | full for time-based (monthly, quarterly, annual, no year weights, nothing at the start), fully vested and custom; others with each security's `vestings`; acceleration only in the description and the note | full with the note; usual shapes recognised; others per security, as portions; two paths and terms past the bounds refused |
| Valuation | partial: 409A only | full |
| Document, Financing | none (files stay in the vault) | none |
| TX_STOCK_ISSUANCE | full, balances included; partial for a count corrected after issue, shown as corrected from the issue date (dates in between read the corrected count), and for a restricted stock award with no certificate (see below) | full |
| TX_STOCK_TRANSFER, _REPURCHASE, _CANCELLATION, _CONVERSION | full | full (a missing balance kept on the certificate) |
| Restricted stock awards (as TX_STOCK_ISSUANCE with `issuance_type` RSA) | full with their certificate; partial without one: issued stock in the package, which Kosmitor does not count until a certificate is issued | the certificate and its award; an award alone as an award |
| TX_STOCK_REISSUANCE, _RETRACTION, _ACCEPTANCE | none | re-issues folded or a transfer to the same holder; a retraction leaves its family out; acceptances not imported |
| TX_EQUITY_COMPENSATION_ISSUANCE, _ACCEPTANCE | full; partial for a count corrected after the grant date (as for certificates) | full |
| TX_EQUITY_COMPENSATION_EXERCISE, _RELEASE | full (an RSU's exercise as a release; method and fair market value in the note) | full |
| TX_EQUITY_COMPENSATION_CANCELLATION | full, a leaver's lapses included | full; lapses not entered twice |
| TX_WARRANT_ISSUANCE, _CANCELLATION | full, a count lowered after issue as a cancellation of that part | full (a part cancelled is a correction of the count) |
| TX_WARRANT_EXERCISE | partial: the warrant shares exercised are only in the note (OCF 1.2.0 has no quantity) | full with the note; else the shares it issued |
| TX_CONVERTIBLE_ISSUANCE | full; partial for an MFN election (a sentence and the note; the terms are as issued) | full; custom mechanisms with no cap or discount |
| TX_CONVERTIBLE_CONVERSION, _CANCELLATION | full (a repayment cancels the principal; the cash repaid in the reason and the note) | full; a part of one refused |
| Transfers of grants, warrants, convertibles | none (Kosmitor has no such event) | a cancellation and a new one |
| TX_STOCK_CLASS_SPLIT | full | all classes at once, into an empty cap table |
| Authorized-share and conversion-ratio adjustments | none (no history kept) | a class's latest value; the company's not imported |
| TX_VESTING_ACCELERATION | full | recorded, not applied |
| Anything dated after `as_of` | none: the package is the cap table of its date | — |

### Differences a reader sees

- **A restricted stock award with no certificate.** Kosmitor counts restricted stock
  through the certificate of its shares and counts an award without one as nothing on
  the cap table. The package gives such an award as issued stock, which is what
  restricted stock is, so another tool shows those shares as outstanding; the manifest
  names the awards. Issuing the award's certificate in Kosmitor (naming the award as
  its source) makes the two agree. Whether Kosmitor itself should count an award
  without a certificate is a decision for the cap table, not for the export.
- **Share counts corrected after issue** on a certificate or grant are shown as
  corrected from the issue date, so dates between the issue and the correction read
  the corrected count (a warrant's lowered count is a dated cancellation instead).
- **Kosmitor-only details** (dividend terms, board seats, MFN elections, a warrant's
  exercised count) travel in the Kosmitor note, which another tool may ignore.

## The official schemas, for tests only

The official JSON Schemas of the 1.2.0 release are vendored unmodified in
`apps/server/test/ocf-schema/v1.2.0` (see its README for the source, the checksum and
the licence, which is the coalition's *Schema and Documentation License*, not MIT).
`apps/server/test/ocf-validate.ts` validates a package with them, file by file and
item by item; every export test runs it. `ajv` and `ajv-formats` are dev dependencies
of `@kosmitor/server`, so production installs (`npm ci --omit=dev`) never get them,
and nothing in `src/` reads the schemas.

## The code

`apps/server/src/ocf/`:

- `types.ts`: the files of a package, the objects, the id scheme (`ocfId`,
  `CONDITION`, `TRIGGER`).
- `convert.ts`: units both ways (`ocfNumeric`, `ocfMoney`, `ocfPrice`, `ocfRatio`,
  `ocfPercentage`; `readMoney`, `readShares`, `readRatio`, `readPercentage`,
  `readDate`), the enum maps, the jurisdiction and currency.
- `notes.ts`: `writeNote`, `readNote`, `commentsWith`, `plainComments` (without the
  sentences the export writes for other readers), `mfnComment`, `termsDigest`.
- `vesting.ts`: `termsFromSchedule`, `evaluateTerms` (and `termsDateCount`, its bounds),
  `vestingsFor`, `scheduleFromTerms`, `customSchedule`, `describeSchedule`.
- `export.ts`: `buildOcfPackage`, `serializeOcf`, `ocfZip`, `STANDARD_COMMENTS`.
- `read.ts`: a package as parse and the check read it (`readOcfUpload`, `readPackageBody`,
  `readOcfPackage`), its limits, and the sections of the check.
- `plan.ts`: `prepareOcf` (the rows, the families, the replay, what is already there, the
  cascade) and `runOcf`, which runWorkbook calls.
- `write.ts`: `writeOcfPlan`.
