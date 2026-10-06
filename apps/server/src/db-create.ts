/**
 * Creates the database named in DATABASE_URL if it does not exist yet, using
 * the server's maintenance database. Idempotent.
 *
 *   npm run db:create
 */
import './env.ts';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/kosmitor');
const name = url.pathname.slice(1);
if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Refusing to create a database named "${name}".`);

const admin = new URL(url.toString());
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
if (exists.rowCount) {
  console.log(`Database "${name}" already exists.`);
} else {
  await client.query(`CREATE DATABASE "${name}"`);
  console.log(`Created database "${name}".`);
}
await client.end();
