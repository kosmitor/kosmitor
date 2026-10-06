/**
 * Test databases. Each test file calls `freshDatabase()` at the top level,
 * before importing anything from src/, so the server code binds to a private
 * PostgreSQL database that is dropped again when the file finishes.
 */
import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import pg from 'pg';

const ADMIN_URL = process.env.PG_ADMIN_URL ?? 'postgres://localhost:5432/postgres';

// pg 9 refuses a query sent to a connection still running one (a transaction's,
// say); pg 8 only warns, once per process. Fail the test that does it instead.
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && /already executing a query/.test(warning.message)) throw warning;
});

/** The session a response signed in: the kosmitor_session cookie, which the API also takes as a bearer token. */
export const sessionCookie = (res: Response): string | undefined =>
  res.headers.get('set-cookie')?.match(/kosmitor_session=([^;]+)/)?.[1];

export async function freshDatabase(): Promise<string> {
  const name = `kosmitor_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();

  const db = await import('../src/db.ts');
  await db.migrate();

  after(async () => {
    await db.close();
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  });
  return name;
}

/**
 * Inserts a security with the ledger entry it is issued with, in one transaction, as the
 * routes and the import do: the database refuses the row alone (db.ts, ledger_entry_required).
 */
export async function insertSecurity(table: 'issuances' | 'awards' | 'warrants' | 'convertibles', row: Record<string, unknown>): Promise<void> {
  const db = await import('../src/db.ts');
  await db.transaction(async () => {
    await db.insert(table, row);
    await db.insert('transactions', {
      id: `tx_${String(row.id)}`, companyId: row.companyId, type: table === 'awards' ? 'GRANT' : 'ISSUANCE', date: row.grantDate ?? row.issueDate,
      stakeholderId: row.stakeholderId, securityId: row.id, quantity: row.quantity ?? null, amount: row.principal ?? null, createdAt: new Date().toISOString(),
    });
  });
}
