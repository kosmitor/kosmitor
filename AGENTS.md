# Kosmitor: notes for agents

Read README.md for the layout and setup. This file only holds rules that the code and the scripts do not show.

## Running things

- Node runs the TypeScript directly. There is no build step for the server or for `packages/core`. Use Node 26, the same version as the Dockerfile.
- Server tests need a running PostgreSQL. Each test file creates and then drops its own database through `PG_ADMIN_URL` (default `postgres://localhost:5432/postgres`). With `docker compose up -d`, use `PG_ADMIN_URL=postgres://postgres@localhost:55432/postgres`.
- In a server test, call `await freshDatabase()` (`apps/server/test/helpers.ts`) at the top level before you import anything from `src/`. Otherwise the code binds to the wrong database.
- `docs/configuration.md` is generated. Edit `kosmitor.config.schema.json` or `kosmitor.config.json`, then run `npm run config:docs`. Local overrides go in `kosmitor.config.local.json` (ignored by git). Secrets go only in `apps/server/.env`.

## Rules

- **Money.** Amounts are integer cents and per-share prices are integer micro-cents. Convert to these units at the parse boundary. One exception: split-adjusted prices in `normalizeSplits` can hold a fraction of a micro-cent, on purpose (see the comment in `packages/core/src/splits.ts`).
- **Roles.** Check roles with `isEditor`, `seesWholeCompany` and `seesWholeVault` from `apps/server/src/auth.ts`. To refuse a member who sees only their own holdings, use `assertFullView(ctx, message)` from `apps/server/src/http.ts`. Do not write a new inline role list.
- **Shared helpers.** Look for an existing helper before you write a new one:
  - server: `esc` (`email.ts`), `longDate` (`certificate-face.ts`), `usd`, `perShare` and `integer` (`templates.ts`);
  - server, for anything the operator should see: `log`, `reportError` and `track` (`telemetry.ts`). Do not add `console.*` calls on a request path.
  - core: `INSTRUMENT_NAMES` and `formatMoney` (`@kosmitor/core`);
  - web: `fileSize` and the other formatters (`apps/web/src/format.ts`).

  `apps/web` does not import `@kosmitor/core`, so the web keeps its own label maps, such as `INSTRUMENT_LABELS`.
- **Ledger.** Every change to a security's dated state writes a dated `transactions` entry for that security, in the shares of the event's date. PostgreSQL enforces this: the deferred trigger `ledger_entry_required` (`apps/server/src/db.ts`) fails the `COMMIT` of a transaction that inserts, deletes or changes an issued security, or changes a stock split, without its entry. Do not work around the trigger. Write the entry (`recordIssuance` in `routes/workflows.ts` for a certificate an event issues). In a test, insert a security with `insertSecurity` from `test/helpers.ts`. `PATCH` refuses a change that an event route makes, and writes a dated `CORRECTION` entry for a corrected count or term, or for a typo in a holder, class or date (with a `reason`). See `docs/design/dated-ledger.md`.
- **Cache.** Call `invalidate(companyId)` after any write that the engine reads.
- **Dependencies.** The server uses `pg`, the official `stripe` SDK and `posthog-node` (for `telemetry.ts`) at runtime. Import parsers, PDF and XLSX writers are written by hand. Do not add a package for something the code already does.
