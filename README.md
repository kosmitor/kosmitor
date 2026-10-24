# Kosmitor — equity & cap table management

A full-stack cap table platform: ownership tracking, equity grants and vesting,
SAFE/note conversion, priced-round modeling, exit waterfalls, compliance checks,
e-signature and a stakeholder portal.

The interesting part is `packages/core` — a dependency-free domain engine that does
the real financial math, covered by tests whose expected values are derived from
the underlying rules rather than from the code.

> **Not legal, tax or financial advice.** Kosmitor computes ownership, vesting,
> conversions, waterfalls, compliance checks and tax estimates to help you manage
> equity records. Its results can be wrong or incomplete, and the rules it models
> change. Check every figure and filing with a qualified attorney, accountant or
> valuation provider before you rely on it. The software comes with no warranty;
> see the [license](LICENSE).

## Running it

You need PostgreSQL 14 or newer running locally (Homebrew: `brew install postgresql@17 && brew services start postgresql@17`).

Or use Docker: `docker compose up -d` starts PostgreSQL on port 55432, so it does not conflict with another server on 5432. Then point the server and the tests at it:

```bash
echo 'DATABASE_URL=postgres://postgres@localhost:55432/kosmitor' >> apps/server/.env
export PG_ADMIN_URL=postgres://postgres@localhost:55432/postgres   # for npm test
```

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
> every session. It refuses to run without `--yes` (`npm run seed -- --yes`). Use it
> only on a throwaway database.

```bash
npm test              # engine, web helper, then server tests (each server test file gets its own scratch database)
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
infra/tfstate     Terraform for the storage of every stack's state; apply it first (see its README)
docs              the reference for settings, the math, imports and the rest (see below)
```

## Configuration

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

Secrets such as `DATABASE_URL` and `SMTP_URL` stay environment variables in
`apps/server/.env` (copy `apps/server/.env.example`), never in either file.
[docs/configuration.md](docs/configuration.md) lists every setting, its default and
the environment variables that override it. A change takes effect when the server
restarts, with no rebuild; the container image copies `kosmitor.config.local.json`
when the build context has one. The page is generated: run `npm run config:docs`
after changing the schema or the defaults.

## Units

Money is integer **cents**; per-share prices are integer **micro-cents** (so
$0.0001 strike prices survive). No floating point value ever touches a monetary
amount on the way to or from disk.

## Roles

`ADMIN` and `LEGAL` can edit; `BOARD` and `VIEWER` read the whole company;
`EMPLOYEE` and `INVESTOR` see only their own position in the portal.

A role is about access. Who sits on the board is each stakeholder's **board seat**,
recorded apart from their relationship with the dates it ran and the investor who
designated the director: an investor can hold one, and a founder is a director only
with one. The seat decides who votes on board consents and who gets the board's updates.

## Docs

- [Configuration](docs/configuration.md): every setting and its default
- [The math](docs/math.md): vesting, priced rounds, SAFEs, waterfalls, splits, compliance checks
- [Importing data](docs/importing.md): the import wizard (spreadsheets and OCF packages), and checking the math against a Pulley or Carta export
- [Open Cap Format](docs/ocf.md): the OCF package the cap table exports and the import reads, and what it holds
- [Signing in](docs/auth.md): Google sign-in, invitations, password resets, email
- [Data and files](docs/data.md): documents, where data lives, backups
- [Dated ledger](docs/design/dated-ledger.md): design notes on past-date views
