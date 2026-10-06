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
