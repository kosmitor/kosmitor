/**
 * One-shot copy of an earlier SQLite database into PostgreSQL.
 *
 *   npm run db:migrate-sqlite                       # apps/server/data/captable.db
 *   npm run db:migrate-sqlite -- /path/to/other.db
 *
 * Tables are copied in dependency order inside one transaction; rows that
 * already exist in PostgreSQL are left untouched, so it is safe to re-run.
 * Files that earlier builds kept on disk are picked up by the server's own
 * start-up migration afterwards.
 */
import './env.ts';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVER_DIR } from './env.ts';
import { migrate, close, transaction, pool, ONCE } from './db.ts';

const source = resolve(process.argv[2] ?? resolve(SERVER_DIR, 'data/captable.db'));
if (!existsSync(source)) {
  console.error(`No SQLite database at ${source}`);
  process.exit(1);
}

// Parents before children so foreign keys are satisfied.
const TABLES = ['users', 'companies', 'memberships', 'sessions', 'login_nonces', 'share_classes', 'stakeholders',
  'vesting_schedules', 'pools', 'pool_adjustments', 'issuances', 'awards', 'warrants', 'convertibles', 'valuations',
  'stock_splits', 'transactions', 'documents', 'file_blobs', 'signatures', 'board_consents', 'board_votes',
  'scenarios', 'audit_log', 'investor_updates', 'tasks', 'exercises', 'imports'];

await migrate();
const sqlite = new DatabaseSync(source, { readOnly: true });
const present = new Set(
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));

let copied = 0;
const seatless: string[] = [];
await transaction(async () => {
  const client = pool; // inside transaction() every query already uses the transaction's connection
  void client;
  for (const table of TABLES) {
    if (!present.has(table)) continue;
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map((c) => {
        const v = row[c];
        return v instanceof Uint8Array ? Buffer.from(v) : v;
      });
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { run } = await import('./db.ts');
      const added = await run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, ...values);
      copied += added;
      if (table === 'stakeholders' && added && !('board_seat' in row)) seatless.push(String(row.id));
    }
    if (rows.length) console.log(`${table}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  }
  // SQLite predates board seats, and migrate() gave them out before these rows arrived: they get theirs the same way.
  if (seatless.length) {
    const { run } = await import('./db.ts');
    await run(`${ONCE.find((step) => step.name === '2026-10-07-board-seats')!.sql} AND id IN (${seatless.map(() => '?').join(', ')})`, ...seatless);
  }
});
sqlite.close();
await close();
console.log(`Copied ${copied} new row${copied === 1 ? '' : 's'} from ${source}`);
