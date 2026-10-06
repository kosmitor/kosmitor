/**
 * Off-provider backup job. Dumps the database with pg_dump, checks the archive,
 * and uploads it to an Azure Blob Storage container using the job's managed
 * identity (no keys anywhere). With --drill it also restores the fresh dump into
 * a scratch database on the same server and compares row counts with the live
 * database, so the backups are proven restorable every week.
 *
 *   node src/backup-upload.ts            nightly backup
 *   node src/backup-upload.ts --drill    backup + restore drill
 *
 * Environment: DATABASE_URL, BACKUP_ACCOUNT_URL (https://<account>.blob.core.windows.net),
 * AZURE_CLIENT_ID (user-assigned identity). The container, the blob name prefix,
 * the scratch database and the row drift the drill tolerates are backup.* in
 * kosmitor.config.json; BACKUP_CONTAINER, BACKUP_PREFIX and DRILL_DATABASE set
 * the first three per deployment.
 * For a local run: BACKUP_TOKEN=$(az account get-access-token --resource https://storage.azure.com/ --query accessToken -o tsv)
 */
import './env.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { config, ConfigError, type KosmitorConfig } from './config.ts';

function fail(message: string): never {
  console.error(`backup: ${message}`);
  process.exit(1);
}

/** The backup settings, read once: this is a job that runs and exits. */
function backupSettings(): KosmitorConfig['backup'] {
  try {
    return config().backup;
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const ACCOUNT_URL = (process.env.BACKUP_ACCOUNT_URL ?? '').replace(/\/$/, '');
const { container: CONTAINER, prefix: PREFIX, drillDatabase: DRILL_DB, maxRowDrift: MAX_ROW_DRIFT } = backupSettings();
const drill = process.argv.includes('--drill');

if (!DATABASE_URL) fail('DATABASE_URL is not set.');
if (!ACCOUNT_URL) fail('BACKUP_ACCOUNT_URL is not set.');

function sh(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) fail(`${cmd} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} exited with ${result.status}`);
}

/** A bearer token for Azure Storage from the container's managed identity, or BACKUP_TOKEN when set. */
async function storageToken(): Promise<string> {
  if (process.env.BACKUP_TOKEN) return process.env.BACKUP_TOKEN;
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) fail('No managed identity endpoint in the environment and no BACKUP_TOKEN provided.');
  const url = new URL(endpoint);
  url.searchParams.set('resource', 'https://storage.azure.com/');
  url.searchParams.set('api-version', '2019-08-01');
  if (process.env.AZURE_CLIENT_ID) url.searchParams.set('client_id', process.env.AZURE_CLIENT_ID);
  const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!res.ok) fail(`Managed identity token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function upload(path: string, blobName: string, token: string): Promise<void> {
  const body = readFileSync(path);
  const res = await fetch(`${ACCOUNT_URL}/${CONTAINER}/${blobName}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`, 'x-ms-version': '2021-12-02', 'x-ms-blob-type': 'BlockBlob',
      'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'x-ms-date': new Date().toUTCString(),
    },
    body,
  });
  if (!res.ok) fail(`Upload failed: ${res.status} ${await res.text()}`);
}

const TABLES = ['companies', 'stakeholders', 'share_classes', 'issuances', 'awards', 'convertibles', 'documents', 'file_blobs', 'transactions', 'audit_log'];

async function rowCounts(connectionString: string): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number((await client.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
    return out;
  } finally { await client.end(); }
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function restoreDrill(dumpPath: string): Promise<void> {
  const live = DATABASE_URL!;
  // The drill drops and recreates its database, so it must never be the live one or a system one.
  const liveName = decodeURIComponent(new URL(live).pathname.replace(/^\//, ''));
  if (DRILL_DB === liveName || DRILL_DB === 'postgres' || DRILL_DB.startsWith('template')) {
    fail(`backup.drillDatabase is "${DRILL_DB}", which is ${DRILL_DB === liveName ? 'the live database' : 'a system database'}; the drill would drop it. Name a scratch database.`);
  }
  const admin = new pg.Client({ connectionString: withDatabase(live, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DRILL_DB}"`);
  } finally { await admin.end(); }
  console.log(`backup: restoring into ${DRILL_DB}…`);
  sh('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${withDatabase(live, DRILL_DB)}`, dumpPath]);
  const [expected, actual] = await Promise.all([rowCounts(live), rowCounts(withDatabase(live, DRILL_DB))]);
  const mismatches = TABLES.filter((t) => expected[t] !== actual[t]);
  for (const t of TABLES) console.log(`backup:   ${t.padEnd(14)} live ${String(expected[t]).padStart(8)}   restored ${String(actual[t]).padStart(8)}${mismatches.includes(t) ? '   MISMATCH' : ''}`);
  const cleanup = new pg.Client({ connectionString: withDatabase(live, 'postgres') });
  await cleanup.connect();
  try { await cleanup.query(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`); } finally { await cleanup.end(); }
  // Rows written between the dump and the count are legitimate differences; more than backup.maxRowDrift is not.
  const drift = mismatches.filter((t) => Math.abs(expected[t] - actual[t]) > MAX_ROW_DRIFT);
  if (drift.length) fail(`Restore drill found row-count differences beyond normal drift in: ${drift.join(', ')}`);
  console.log('backup: restore drill passed — the dump restores and matches the live database.');
}

const dir = mkdtempSync(join(tmpdir(), 'kosmitor-backup-'));
try {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(dir, `${PREFIX}-${stamp}.dump`);
  console.log('backup: dumping the database…');
  sh('pg_dump', ['--format=custom', '--no-owner', '--compress=6', `--file=${file}`, DATABASE_URL!]);
  sh('pg_restore', ['--list', file], { PAGER: 'cat' });                                        // the archive is readable
  const size = statSync(file).size;
  const blobName = `${PREFIX}/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${PREFIX}-${stamp}.dump`;
  console.log(`backup: uploading ${(size / 1024 / 1024).toFixed(1)} MB to ${ACCOUNT_URL}/${CONTAINER}/${blobName}`);
  await upload(file, blobName, await storageToken());
  console.log('backup: upload complete.');
  if (drill) await restoreDrill(file);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
