/**
 * Writes a consistent backup of the database — including uploaded files — with
 * pg_dump in its custom format, safe to run while the server is up.
 *
 *   npm run backup                   # apps/server/data/backup-<timestamp>.dump
 *   npm run backup -- /path/to.dump  # somewhere else
 *
 * Restore with:  pg_restore --clean --if-exists -d kosmitor <file>
 */
import './env.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SERVER_DIR } from './env.ts';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/kosmitor';
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const destination = resolve(process.argv[2] ?? resolve(SERVER_DIR, `data/backup-${stamp}.dump`));
mkdirSync(dirname(destination), { recursive: true });

const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', `--file=${destination}`, url], { stdio: 'inherit' });
if (result.error) {
  console.error(`pg_dump is not available on this machine (${result.error.message}). Install the PostgreSQL client tools.`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Backup written to ${destination}`);
console.log(`Restore with: pg_restore --clean --if-exists -d ${new URL(url).pathname.slice(1)} ${destination}`);
