# Data and files

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


## Import uploads

Every spreadsheet handed to the import wizard is kept as it was uploaded, in
`import_uploads`, with how it ended: parsed, parse failed, committed or failed,
and the error when there was one. That is what lets a failed import be replayed
and the parser fixed. Files older than `limits.importUploadRetentionDays`
(90 by default) are removed when the next one arrives; 0 keeps none.

## Logs and analytics

The server prints one JSON line per API call (method, path, status,
milliseconds, user, company, and the message a refused request answered with)
and every server error with its stack. Set `analytics.posthog.key` (or
`POSTHOG_KEY`) and the same goes to PostHog: the lines to Logs, errors to Error
tracking, and the page loads PostHog's browser SDK for pageviews, clicks and
uncaught errors, with sign-ups, companies, imports and assistant questions as
events. `apps/server/src/telemetry.ts` is the whole of it.
