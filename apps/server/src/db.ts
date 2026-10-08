/**
 * PostgreSQL data layer.
 *
 * Every query goes through `pool`, except inside `transaction()`, where a
 * dedicated connection is carried implicitly via AsyncLocalStorage — so a
 * helper called five functions deep still joins the caller's transaction
 * without a handle being threaded through.
 *
 * Money is stored in integer cents and per-share prices in integer
 * micro-cents (BIGINT), matching the units the core engine works in, so no
 * floating point ever touches a monetary value on the way to or from disk.
 * Dates are ISO-8601 text, which sorts correctly and never shifts time zones.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import './env.ts';
import { config } from './config.ts';

// BIGINT and NUMERIC arrive as strings by default; every integer we store fits a JS number.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/kosmitor';

/**
 * Under the test runner only a private test database may be touched. A test file
 * that imports src/ before calling freshDatabase() binds this module to the real
 * database; pure tests may still load it, but the first query is refused.
 */
function guardTestDatabase(): void {
  if (process.env.NODE_TEST_CONTEXT && !/\/kosmitor_test_[0-9a-f]+$/.test(DATABASE_URL)) {
    throw new Error(`Refusing to query ${DATABASE_URL} from a test: call freshDatabase() before importing anything from src/.`);
  }
}

/**
 * TLS the way libpq means it: `sslmode=require` encrypts without checking the
 * certificate (managed servers with private DNS zones present names their
 * certificates do not cover), `verify-full` checks it, and no sslmode means plain
 * TCP as for a local database.
 */
function connectionOptions(url: string): pg.PoolConfig {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  const ssl = mode === 'verify-full' || mode === 'verify-ca' ? {} : mode && mode !== 'disable' ? { rejectUnauthorized: false } : undefined;
  return { connectionString: parsed.toString(), ...(ssl !== undefined ? { ssl } : {}) };
}

/** One pool per process, sized by database.poolMax (PG_POOL_MAX sets it per deployment). */
export const pool = new pg.Pool({
  ...connectionOptions(DATABASE_URL),
  max: config().database.poolMax,
});
pool.on('error', (err) => console.error('[db] idle connection error', err.message));

interface Executor { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }
const activeTransaction = new AsyncLocalStorage<Executor>();
const executor = (): Executor => { guardTestDatabase(); return activeTransaction.getStore() ?? pool; };
export const inTransaction = (): boolean => !!activeTransaction.getStore();
let savepointSequence = 0;

export type Row = Record<string, unknown>;

/** Rewrites `?` placeholders to `$1..$n`, leaving quoted literals alone. */
export function toPositional(sql: string): string {
  let n = 0, out = '', quote: string | null = null;
  for (const ch of sql) {
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

function normalize(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return v;                    // BYTEA
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export async function all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await executor().query(toPositional(sql), params.map(normalize));
  return res.rows as T[];
}
export async function one<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  return (await all<T>(sql, ...params))[0];
}
export async function run(sql: string, ...params: unknown[]): Promise<number> {
  const res = await executor().query(toPositional(sql), params.map(normalize));
  return res.rowCount ?? 0;
}
/** Runs one or more statements with no parameters (DDL, BEGIN/COMMIT). */
export async function exec(sql: string): Promise<void> {
  await executor().query(sql);
}

/** Inserts an object as a row, mapping camelCase keys to snake_case columns. */
export async function insert(table: string, values: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const cols = keys.map(snake).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  await executor().query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, keys.map((k) => normalize(values[k])));
}

/**
 * Inserts many objects as rows, as insert() does one: rows with the same
 * columns go in together, as many to a statement as PostgreSQL's limit on
 * parameters allows. For writes of hundreds or thousands of rows, such as an import.
 */
export async function insertMany(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const groups = new Map<string, { keys: string[]; rows: Record<string, unknown>[] }>();
  for (const values of rows) {
    const keys = Object.keys(values).filter((k) => values[k] !== undefined);
    const signature = keys.join(',');
    const group = groups.get(signature) ?? { keys, rows: [] };
    group.rows.push(values);
    groups.set(signature, group);
  }
  for (const { keys, rows: same } of groups.values()) {
    const cols = keys.map(snake).join(', ');
    const perStatement = Math.max(1, Math.floor(60_000 / Math.max(1, keys.length)));
    for (let start = 0; start < same.length; start += perStatement) {
      const chunk = same.slice(start, start + perStatement);
      const params: unknown[] = [];
      const tuples = chunk.map((values) => `(${keys.map((k) => { params.push(normalize(values[k])); return `$${params.length}`; }).join(', ')})`);
      await executor().query(`INSERT INTO ${table} (${cols}) VALUES ${tuples.join(', ')}`, params);
    }
  }
}

export async function update(table: string, id: string, values: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(values).filter((k) => k !== 'id' && values[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${snake(k)} = $${i + 1}`).join(', ');
  await executor().query(`UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1}`, [...keys.map((k) => normalize(values[k])), id]);
}

/**
 * What the open transaction queued with afterCommit(). Kept beside the
 * connection rather than on it, so a savepoint that rolls back can drop what
 * was queued inside it.
 */
const commitQueue = new AsyncLocalStorage<(() => Promise<unknown>)[]>();

/**
 * Queues `fn` to run once the open transaction commits: for what must not happen
 * for a change that is rolled back, nor while the transaction holds its locks,
 * such as sending an email. It is dropped if the transaction, or the savepoint it
 * was queued in, rolls back. Queued work runs in turn on the pool once the
 * connection is released, before transaction() returns, and work that fails is
 * logged rather than thrown, since the change it follows is already committed.
 */
export function afterCommit(fn: () => Promise<unknown>): void {
  const queue = commitQueue.getStore();
  if (!queue) throw new Error('afterCommit() needs an open transaction.');
  queue.push(fn);
}

/**
 * Runs `fn` inside one transaction on a dedicated connection. Nested calls
 * use savepoints so a failed or preview-only nested operation cannot leak writes.
 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const active = activeTransaction.getStore();
  if (active) {
    const name = `nested_${++savepointSequence}`;
    const queue = commitQueue.getStore()!;
    const queued = queue.length;
    await active.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await active.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      // What the part that rolls back queued goes with it.
      queue.length = queued;
      await active.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await active.query(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  }
  guardTestDatabase();
  const queue: (() => Promise<unknown>)[] = [];
  const client = await pool.connect();
  let result: T;
  try {
    await client.query('BEGIN');
    result = await activeTransaction.run(client, () => commitQueue.run(queue, fn));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  for (const next of queue) {
    try { await next(); } catch (err) { console.error('[db] work queued after a commit failed:', (err as Error).stack ?? err); }
  }
  return result;
}

/**
 * Runs independent queries at once on the pool, or one after another inside a
 * transaction: its single connection must never be handed a query while another
 * is in flight (pg 8 queues it with a deprecation warning, pg 9 refuses). Takes
 * thunks so nothing starts before the mode is chosen.
 */
export async function concurrently<T extends readonly (() => Promise<unknown>)[] | []>(
  tasks: T,
): Promise<{ -readonly [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never }> {
  if (!inTransaction()) return Promise.all(tasks.map((task) => task())) as never;
  const results: unknown[] = [];
  for (const task of tasks) results.push(await task());
  return results as never;
}

export const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Converts a snake_case row into a camelCase object. */
export function toCamel<T = Row>(row: Row | undefined): T | undefined {
  if (!row) return undefined;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out as T;
}
export function toCamelAll<T = Row>(rows: Row[]): T[] {
  return rows.map((r) => toCamel<T>(r)!) as T[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT,
  avatar_url TEXT,
  google_sub TEXT,
  auth_provider TEXT DEFAULT 'PASSWORD',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0;
-- A reading preference that follows the person rather than the browser: whether the
-- explanation at the top of each page starts open.
ALTER TABLE users ADD COLUMN IF NOT EXISTS explanations_open INTEGER NOT NULL DEFAULT 0;
-- When the address was shown to be the person's. Signing up now sends a link to open first,
-- and an account nobody has opened one from cannot sign in with its password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TEXT;

-- Single-use, hashed links for "forgot password" and administrator resets.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
-- The same links invite someone new to choose their first password. An invitation
-- lasts auth.inviteLinkDays rather than auth.resetLinkMinutes, and keeps the
-- company it is for, so the page it opens can name it. Deleting the company
-- removes the link with it.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'RESET';
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS company_id TEXT;
-- An invitation link given to the administrator to pass on, rather than emailed to
-- its owner. It stops working once the person belongs to another company as well.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS handed_out INTEGER NOT NULL DEFAULT 0;

-- Every invitation email tried, by address, which auth.inviteEmailsPerAddressPerDay
-- counts. Apart from the audit log, which each company owns: with no company_id,
-- deleting a company does not clear it, and kept by address rather than account,
-- moving an invitation to a new account does not either.
CREATE TABLE IF NOT EXISTS invite_emails (
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_emails ON invite_emails(email, created_at);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  entity_type TEXT DEFAULT 'C_CORP',
  jurisdiction TEXT DEFAULT 'Delaware',
  incorporation_date TEXT,
  fiscal_year_end TEXT DEFAULT '12-31',
  ein TEXT,
  address TEXT,
  website TEXT,
  currency TEXT DEFAULT 'USD',
  brand_color TEXT DEFAULT '#3d5afe',
  total_assets_cents BIGINT DEFAULT 0,
  created_at TEXT NOT NULL
);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS boi_status TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS accounting_assumptions TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS exercise_requests_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_instructions TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_settings TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS certificate_terms TEXT;

-- The company's own document templates; built-ins live in code.
CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Offer letters: a candidate's equity offer, accepted or declined from a public link, then turned into a grant.
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  candidate_name TEXT NOT NULL,
  candidate_email TEXT,
  position TEXT NOT NULL,
  department TEXT,
  start_date TEXT,
  salary_cents DOUBLE PRECISION,
  pool_id TEXT,
  award_type TEXT NOT NULL DEFAULT 'ISO',
  quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  strike_price DOUBLE PRECISION,
  vesting_schedule_id TEXT,
  expires_on TEXT,
  message TEXT,
  template_id TEXT,
  signer_name TEXT,
  signer_title TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  token TEXT UNIQUE,
  sent_at TEXT,
  viewed_at TEXT,
  accepted_at TEXT,
  accepted_name TEXT,
  accepted_ip TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  stakeholder_id TEXT,
  award_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Custom report definitions from the report builder.
CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dataset TEXT NOT NULL,
  config TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Option holders ask to exercise; the company reviews, collects payment and records the exercise.
CREATE TABLE IF NOT EXISTS exercise_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  award_id TEXT NOT NULL,
  stakeholder_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL DEFAULT 'CASH',
  strike_price BIGINT NOT NULL DEFAULT 0,
  fmv BIGINT NOT NULL DEFAULT 0,
  estimated_cost BIGINT NOT NULL DEFAULT 0,
  spread BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  note TEXT,
  admin_note TEXT,
  payment_reference TEXT,
  requested_by TEXT,
  reviewed_by TEXT,
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  paid_at TEXT,
  completed_at TEXT,
  exercise_id TEXT,
  created_at TEXT NOT NULL
);

-- Regulatory filings the company records as made (Form 3921 per tax year, BOI reports).
CREATE TABLE IF NOT EXISTS compliance_filings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  filed_on TEXT NOT NULL,
  reference TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  stakeholder_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, company_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS share_classes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  authorized DOUBLE PRECISION NOT NULL DEFAULT 0,
  par_value BIGINT NOT NULL DEFAULT 0,
  seniority INTEGER NOT NULL DEFAULT 0,
  original_issue_price BIGINT NOT NULL DEFAULT 0,
  liquidation_multiple DOUBLE PRECISION NOT NULL DEFAULT 1,
  participation TEXT NOT NULL DEFAULT 'NON_PARTICIPATING',
  participation_cap DOUBLE PRECISION,
  conversion_ratio DOUBLE PRECISION NOT NULL DEFAULT 1,
  dividend_type TEXT NOT NULL DEFAULT 'NONE',
  dividend_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  dividend_compounding INTEGER NOT NULL DEFAULT 0,
  dividends_participate INTEGER NOT NULL DEFAULT 0,
  votes_per_share DOUBLE PRECISION NOT NULL DEFAULT 1,
  anti_dilution TEXT NOT NULL DEFAULT 'NONE',
  pay_to_play INTEGER NOT NULL DEFAULT 0,
  issue_date TEXT NOT NULL,
  is_convertible INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);
-- Legend text printed on certificates of this class, on top of the standard securities-law legend.
ALTER TABLE share_classes ADD COLUMN IF NOT EXISTS legend TEXT;

CREATE TABLE IF NOT EXISTS stakeholders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  type TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  relation TEXT NOT NULL DEFAULT 'OTHER',
  start_date TEXT,
  termination_date TEXT,
  tax_country TEXT,
  tax_state TEXT,
  entity_group_id TEXT,
  title TEXT,
  address TEXT,
  phone TEXT,
  portal_invited_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS secondary_email TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS employee_id TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS employment_type TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS termination_reason TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS tax_form TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS accredited_investor TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS signatory_name TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS signatory_title TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS signatory_email TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS tags TEXT;
-- A seat on the board, apart from the relationship: an investor can hold one, and a
-- founder is a director only with one (isDirector in @kosmitor/core). The dates are
-- when it ran, the end day being the first one off the board; a seat that ended stays
-- as a former director's. board_designated_by is the investor who named the director,
-- and deleting that investor leaves the seat with no designator.
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS board_seat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS board_seat_start TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS board_seat_end TEXT;
ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS board_designated_by TEXT REFERENCES stakeholders(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS issuances (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  certificate_no TEXT,
  stakeholder_id TEXT NOT NULL,
  share_class_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  price_per_share BIGINT NOT NULL DEFAULT 0,
  issue_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OUTSTANDING',
  vesting_schedule_id TEXT,
  vesting_start_date TEXT,
  early_exercised INTEGER NOT NULL DEFAULT 0,
  election83b_filed_on TEXT,
  source_award_id TEXT,
  board_approval_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- The paperwork a certificate carries beyond the numbers: which exemption the
-- shares were sold under, when the Rule 144 holding period starts, and the terms
-- a holder reads before signing.
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS federal_exemption TEXT;
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS state_exemption TEXT;
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS pro_rata INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS issue_reason TEXT;
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS holding_start_date TEXT;
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS rule144_date TEXT;
ALTER TABLE issuances ADD COLUMN IF NOT EXISTS acceleration_notes TEXT;

CREATE TABLE IF NOT EXISTS awards (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label TEXT,
  stakeholder_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  strike_price BIGINT NOT NULL DEFAULT 0,
  grant_date TEXT NOT NULL,
  vesting_start_date TEXT NOT NULL,
  vesting_schedule_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OUTSTANDING',
  expiration_date TEXT,
  ptep_months INTEGER NOT NULL DEFAULT 3,
  early_exercise_allowed INTEGER NOT NULL DEFAULT 0,
  exercised_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  cancelled_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  board_approval_date TEXT,
  accepted_date TEXT,
  fmv_at_grant BIGINT NOT NULL DEFAULT 0,
  rsu_liquidity_condition INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
-- How a grant issued for signature is to be papered: signatory, template, note.
ALTER TABLE awards ADD COLUMN IF NOT EXISTS signing_config TEXT;

CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  share_class_id TEXT NOT NULL,
  authorized DOUBLE PRECISION NOT NULL DEFAULT 0,
  board_approval_date TEXT,
  shareholder_approval_date TEXT,
  return_forfeitures INTEGER NOT NULL DEFAULT 1,
  evergreen_percent DOUBLE PRECISION,
  plan_type TEXT NOT NULL DEFAULT 'STOCK_PLAN',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_adjustments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warrants (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  share_class_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  strike_price BIGINT NOT NULL DEFAULT 0,
  issue_date TEXT NOT NULL,
  expiration_date TEXT,
  status TEXT NOT NULL DEFAULT 'OUTSTANDING',
  exercised_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_exercise INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS convertibles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  principal BIGINT NOT NULL,
  issue_date TEXT NOT NULL,
  valuation_cap BIGINT,
  discount DOUBLE PRECISION NOT NULL DEFAULT 0,
  interest_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  compounding TEXT NOT NULL DEFAULT 'SIMPLE',
  maturity_date TEXT,
  mfn INTEGER NOT NULL DEFAULT 0,
  pro_rata_right INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OUTSTANDING',
  converted_into_share_class_id TEXT,
  converted_on TEXT,
  qualified_financing_minimum BIGINT,
  notes TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE convertibles ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE convertibles ADD COLUMN IF NOT EXISTS funds_received_on TEXT;
ALTER TABLE convertibles ADD COLUMN IF NOT EXISTS funds_reference TEXT;
ALTER TABLE convertibles ADD COLUMN IF NOT EXISTS board_approval_date TEXT;
ALTER TABLE convertibles ADD COLUMN IF NOT EXISTS signing_config TEXT;

CREATE TABLE IF NOT EXISTS vesting_schedules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'TIME',
  duration_months INTEGER NOT NULL DEFAULT 48,
  cliff_months INTEGER NOT NULL DEFAULT 12,
  frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  immediate_portion DOUBLE PRECISION NOT NULL DEFAULT 0,
  year_weights TEXT,
  milestones TEXT,
  custom_tranches TEXT,
  acceleration_single DOUBLE PRECISION NOT NULL DEFAULT 0,
  acceleration_double DOUBLE PRECISION NOT NULL DEFAULT 0,
  acceleration_months INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS valuations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT '409A',
  fair_market_value BIGINT NOT NULL,
  effective_date TEXT NOT NULL,
  expiration_date TEXT,
  provider TEXT,
  report_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  enterprise_value BIGINT,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- A request for a new 409A, from the day it is asked for to the day the valuation
-- it produced is recorded. The reasons are kept as
-- they stood when it was asked for, because the cap table will have moved on by the
-- time anyone reads them back.
CREATE TABLE IF NOT EXISTS valuation_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  reasons TEXT,
  provider TEXT NOT NULL,
  provider_email TEXT,
  contact_name TEXT,
  contact_email TEXT,
  target_date TEXT,
  notes TEXT,
  requested_by TEXT NOT NULL,
  sent_at TEXT,
  valuation_id TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
-- A request now goes to the valuation team (valuationDesk) with the company's answers to
-- its intake questions. The team works it from a private link emailed to them:
-- only a hash of the link's token is kept, and each new notice replaces it.
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS answers TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS requested_by_id TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS desk_token_hash TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS desk_token_at TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS recap_sent_at TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS desk_notified_at TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS appraiser TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS report_date TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS closed_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_valreq_desk_token ON valuation_requests(desk_token_hash) WHERE desk_token_hash IS NOT NULL;

-- What happened to a request after it was sent, in order: the team starting it,
-- delivering the report, a note from the team, a change of contact details, and
-- how it closed. The company's page reads its status history from here.
CREATE TABLE IF NOT EXISTS valuation_request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES valuation_requests(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valreq_events ON valuation_request_events(request_id, created_at);

CREATE TABLE IF NOT EXISTS stock_splits (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  ratio DOUBLE PRECISION NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  stakeholder_id TEXT,
  counterparty_id TEXT,
  security_id TEXT,
  share_class_id TEXT,
  quantity DOUBLE PRECISION,
  price_per_share BIGINT,
  amount BIGINT,
  memo TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
-- MFN_ELECTION: the later convertible whose terms the MFN instrument (security_id) adopts.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS adopted_security_id TEXT;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'OTHER',
  folder TEXT DEFAULT 'General',
  body TEXT,
  stakeholder_id TEXT,
  security_id TEXT,
  requires_signature INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  visibility TEXT NOT NULL DEFAULT 'ADMIN',
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  storage_key TEXT,
  sha256 TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS file_blobs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content BYTEA NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Compliance work that is a calculation rather than a stored row still collects
-- paperwork: the appraisal behind a test, the return that was filed, the worksheet
-- a filing was based on. Those attach to a named subject instead of an instrument,
-- because there is no instrument to attach them to.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS subject_kind TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS subject_ref TEXT;
-- The certificate-style front page of a generated certificate, award or SAFE/note,
-- as JSON (certificate-face.ts). Written once at generation, so the signed document
-- never changes with later edits; NULL for documents made before it existed.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS face TEXT;

-- The appraisal report a valuation came from, when it is a document in the vault
-- rather than a link to somewhere else. Deleting the document leaves the
-- valuation standing with no report, not a pointer to nothing.
ALTER TABLE valuations ADD COLUMN IF NOT EXISTS report_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

-- The documents a request hands the valuation team, one row per checklist item a
-- document answers (financial statements, the pitch deck, the charter and so on).
-- They stay in the company's vault; the request only points at them, and the team
-- reaches them through its link only while the request is open. A document deleted
-- from the vault leaves the request without it, not pointing at nothing.
CREATE TABLE IF NOT EXISTS valuation_request_documents (
  request_id TEXT NOT NULL REFERENCES valuation_requests(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, item, document_id)
);
CREATE INDEX IF NOT EXISTS idx_valreq_docs_document ON valuation_request_documents(document_id);

-- The report the valuation team uploads from its page, kept in the company's vault:
-- the document, what the app read from it (fair market value, valuation date and
-- method, as JSON, for a person to check), and the fair market value per common
-- share, in micro-cents, and the method the team gave when it delivered. Deleting
-- the document leaves the request with no upload, not a pointer to nothing.
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS report_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS report_detected TEXT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS report_fmv BIGINT;
ALTER TABLE valuation_requests ADD COLUMN IF NOT EXISTS report_method TEXT;

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  stakeholder_id TEXT,
  signer_name TEXT NOT NULL,
  signer_email TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  typed_signature TEXT,
  signed_at TEXT,
  ip_address TEXT,
  token TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_consents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'WRITTEN_CONSENT',
  body TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  meeting_date TEXT,
  effective_date TEXT,
  approved_at TEXT,
  linked_entity_type TEXT,
  linked_entity_ids TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_votes (
  id TEXT PRIMARY KEY,
  consent_id TEXT NOT NULL REFERENCES board_consents(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  vote TEXT NOT NULL DEFAULT 'PENDING',
  comment TEXT,
  voted_at TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE board_consents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'BOARD';
ALTER TABLE board_consents ADD COLUMN IF NOT EXISTS threshold DOUBLE PRECISION;
ALTER TABLE board_consents ADD COLUMN IF NOT EXISTS total_weight DOUBLE PRECISION;
ALTER TABLE board_consents ADD COLUMN IF NOT EXISTS closed_note TEXT;
ALTER TABLE board_votes ADD COLUMN IF NOT EXISTS weight DOUBLE PRECISION;

-- Signatories and contacts for the company; who sits on the board is the stakeholders' board seats.
CREATE TABLE IF NOT EXISTS company_contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  stakeholder_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investor_updates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  period TEXT,
  body TEXT,
  metrics TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  sent_at TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE investor_updates ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'INVESTORS';
ALTER TABLE investor_updates ADD COLUMN IF NOT EXISTS recipient_ids TEXT;
ALTER TABLE investor_updates ADD COLUMN IF NOT EXISTS sent_by TEXT;
ALTER TABLE investor_updates ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE investor_updates ADD COLUMN IF NOT EXISTS updated_at TEXT;
-- The count a CORRECTION entry changes (PATCH on a security), and the SHA-256 of the body each signer signed.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS field TEXT;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS body_sha256 TEXT;
-- A CORRECTION of a term or of a holder, class or date: the value before and after, as JSON, and why.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS before_value TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS after_value TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reason TEXT;

-- Every change to a security's dated state is a dated ledger entry (docs/design/dated-ledger.md).
-- The database holds every writer to it, not only the routes: an INSERT, a DELETE, or an UPDATE
-- of a column below (holder, class or plan, counts, own date, status, conversion, and the terms in
-- CORRECTED_TERMS, packages/core/src/types.ts) on issuances, awards, warrants or convertibles fails at COMMIT unless the
-- same transaction also wrote a transactions row for that security, and a change to a stock
-- split unless it wrote a company STOCK_SPLIT entry. The check is deferred, so the entry may
-- follow the change. A row not yet issued (draft, awaiting approval or signatures) is not on
-- the cap table and needs none; nor does a company being deleted. xact_id records which
-- transaction wrote an entry; older rows have none.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS xact_id xid8;
ALTER TABLE transactions ALTER COLUMN xact_id SET DEFAULT pg_current_xact_id();
CREATE INDEX IF NOT EXISTS idx_tx_security ON transactions(security_id);

CREATE OR REPLACE FUNCTION ledger_entry_required() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  company TEXT;
  security TEXT;
  unissued CONSTANT TEXT[] := ARRAY['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE'];
BEGIN
  IF TG_OP = 'DELETE' THEN company := OLD.company_id; security := OLD.id; ELSE company := NEW.company_id; security := NEW.id; END IF;
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = company) THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'stock_splits' THEN
    IF EXISTS (SELECT 1 FROM transactions WHERE company_id = company AND type = 'STOCK_SPLIT' AND security_id IS NULL AND xact_id = pg_current_xact_id()) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'A change to stock split % needs a dated STOCK_SPLIT ledger entry in the same transaction.', security USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = ANY (unissued) THEN RETURN NULL; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = ANY (unissued) THEN RETURN NULL; END IF;
  ELSIF OLD.status = ANY (unissued) AND NEW.status = ANY (unissued) THEN RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM transactions WHERE security_id = security AND xact_id = pg_current_xact_id()) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'A change to % % needs a dated ledger entry for it in the same transaction.', TG_TABLE_NAME, security USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;

DROP TRIGGER IF EXISTS ledger_required_write ON issuances;
CREATE CONSTRAINT TRIGGER ledger_required_write AFTER INSERT OR DELETE ON issuances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_required();
DROP TRIGGER IF EXISTS ledger_required_update ON issuances;
CREATE CONSTRAINT TRIGGER ledger_required_update AFTER UPDATE ON issuances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.stakeholder_id, OLD.share_class_id, OLD.quantity, OLD.issue_date, OLD.status, OLD.price_per_share, OLD.vesting_schedule_id, OLD.vesting_start_date)
    IS DISTINCT FROM (NEW.stakeholder_id, NEW.share_class_id, NEW.quantity, NEW.issue_date, NEW.status, NEW.price_per_share, NEW.vesting_schedule_id, NEW.vesting_start_date))
  EXECUTE FUNCTION ledger_entry_required();

DROP TRIGGER IF EXISTS ledger_required_write ON awards;
CREATE CONSTRAINT TRIGGER ledger_required_write AFTER INSERT OR DELETE ON awards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_required();
DROP TRIGGER IF EXISTS ledger_required_update ON awards;
CREATE CONSTRAINT TRIGGER ledger_required_update AFTER UPDATE ON awards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.stakeholder_id, OLD.pool_id, OLD.quantity, OLD.grant_date, OLD.status, OLD.exercised_quantity, OLD.cancelled_quantity,
         OLD.type, OLD.strike_price, OLD.vesting_start_date, OLD.vesting_schedule_id, OLD.expiration_date, OLD.ptep_months, OLD.fmv_at_grant)
    IS DISTINCT FROM (NEW.stakeholder_id, NEW.pool_id, NEW.quantity, NEW.grant_date, NEW.status, NEW.exercised_quantity, NEW.cancelled_quantity,
         NEW.type, NEW.strike_price, NEW.vesting_start_date, NEW.vesting_schedule_id, NEW.expiration_date, NEW.ptep_months, NEW.fmv_at_grant))
  EXECUTE FUNCTION ledger_entry_required();

DROP TRIGGER IF EXISTS ledger_required_write ON warrants;
CREATE CONSTRAINT TRIGGER ledger_required_write AFTER INSERT OR DELETE ON warrants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_required();
DROP TRIGGER IF EXISTS ledger_required_update ON warrants;
CREATE CONSTRAINT TRIGGER ledger_required_update AFTER UPDATE ON warrants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.stakeholder_id, OLD.share_class_id, OLD.quantity, OLD.issue_date, OLD.status, OLD.exercised_quantity, OLD.strike_price, OLD.expiration_date)
    IS DISTINCT FROM (NEW.stakeholder_id, NEW.share_class_id, NEW.quantity, NEW.issue_date, NEW.status, NEW.exercised_quantity, NEW.strike_price, NEW.expiration_date))
  EXECUTE FUNCTION ledger_entry_required();

DROP TRIGGER IF EXISTS ledger_required_write ON convertibles;
CREATE CONSTRAINT TRIGGER ledger_required_write AFTER INSERT OR DELETE ON convertibles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_required();
DROP TRIGGER IF EXISTS ledger_required_update ON convertibles;
CREATE CONSTRAINT TRIGGER ledger_required_update AFTER UPDATE ON convertibles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.stakeholder_id, OLD.instrument, OLD.principal, OLD.issue_date, OLD.valuation_cap, OLD.discount, OLD.interest_rate, OLD.compounding,
         OLD.maturity_date, OLD.mfn, OLD.qualified_financing_minimum, OLD.status, OLD.converted_into_share_class_id, OLD.converted_on)
    IS DISTINCT FROM (NEW.stakeholder_id, NEW.instrument, NEW.principal, NEW.issue_date, NEW.valuation_cap, NEW.discount, NEW.interest_rate, NEW.compounding,
         NEW.maturity_date, NEW.mfn, NEW.qualified_financing_minimum, NEW.status, NEW.converted_into_share_class_id, NEW.converted_on))
  EXECUTE FUNCTION ledger_entry_required();

DROP TRIGGER IF EXISTS ledger_required_write ON stock_splits;
CREATE CONSTRAINT TRIGGER ledger_required_write AFTER INSERT OR DELETE ON stock_splits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_required();
DROP TRIGGER IF EXISTS ledger_required_update ON stock_splits;
CREATE CONSTRAINT TRIGGER ledger_required_update AFTER UPDATE ON stock_splits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.date, OLD.ratio) IS DISTINCT FROM (NEW.date, NEW.ratio))
  EXECUTE FUNCTION ledger_entry_required();

-- Who each update went to, whether they were emailed, and when they opened it in their portal.
CREATE TABLE IF NOT EXISTS update_recipients (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES investor_updates(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  email TEXT,
  emailed INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  viewed_at TEXT,
  UNIQUE (update_id, stakeholder_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  kind TEXT DEFAULT 'GENERAL',
  entity_type TEXT,
  entity_id TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  assignee TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  award_id TEXT NOT NULL,
  stakeholder_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  exercise_date TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'CASH',
  strike_price BIGINT NOT NULL,
  fmv_at_exercise BIGINT NOT NULL DEFAULT 0,
  total_cost BIGINT NOT NULL DEFAULT 0,
  spread BIGINT NOT NULL DEFAULT 0,
  shares_issued DOUBLE PRECISION NOT NULL DEFAULT 0,
  issuance_id TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  file_name TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- --- Assistant ------------------------------------------------------------
-- The API key belongs to the person, not the company: it is their account and
-- their quota, it must not be visible to the other administrators of a company,
-- and it should follow them to every company they can open.
CREATE TABLE IF NOT EXISTS user_ai_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- Sealed with AES-256-GCM. Nothing reads this column except the one function
  -- that opens it on the way to the provider, and it is never returned or logged.
  api_key TEXT NOT NULL,
  -- The few characters shown back so someone can tell which key is stored.
  key_hint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_chats (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Changes to data that have run on this database, by name (ONCE, below). Each runs once
-- and is never repeated, so what people change afterwards stays changed.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Secrets the server generates for itself when the environment supplies none.
CREATE TABLE IF NOT EXISTS server_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sc_company ON share_classes(company_id);
CREATE INDEX IF NOT EXISTS idx_sh_company ON stakeholders(company_id);
-- Deleting a stakeholder clears board_designated_by on the directors they designated; this finds them.
CREATE INDEX IF NOT EXISTS idx_sh_designated_by ON stakeholders(board_designated_by) WHERE board_designated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iss_company ON issuances(company_id);
CREATE INDEX IF NOT EXISTS idx_aw_company ON awards(company_id);
CREATE INDEX IF NOT EXISTS idx_conv_company ON convertibles(company_id);
CREATE INDEX IF NOT EXISTS idx_tx_company ON transactions(company_id, date);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_docs_company ON documents(company_id);
CREATE INDEX IF NOT EXISTS idx_docs_subject ON documents(company_id, subject_kind, subject_ref);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_chats_owner ON ai_chats(company_id, user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_chat ON ai_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_valreq_company ON valuation_requests(company_id, created_at);
-- What the header's "My pending actions" asks for on every page (routes/my-actions.ts).
CREATE INDEX IF NOT EXISTS idx_sig_company_status ON signatures(company_id, status);
CREATE INDEX IF NOT EXISTS idx_sig_document ON signatures(document_id);
CREATE INDEX IF NOT EXISTS idx_votes_stakeholder ON board_votes(stakeholder_id);
CREATE INDEX IF NOT EXISTS idx_exreq_company_status ON exercise_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_company_status ON offers(company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
-- The limit on invitation emails used to be counted from the audit log; invite_emails counts them now.
DROP INDEX IF EXISTS idx_audit_invite_emails;
-- Welcome emails tried in the last hour, across the server, for mail.welcomeEmailsPerHour.
CREATE INDEX IF NOT EXISTS idx_audit_welcome_emails ON audit_log(created_at)
  WHERE action IN ('WELCOME_EMAIL_PENDING', 'WELCOME_EMAILED', 'WELCOME_EMAIL_FAILED');

-- An account that has never been signed in to is one an invitation made, which is
-- what an invitation email offers a password link for. Signing up did not use to
-- record a sign-in, so an account with a session, or anything it did in the audit
-- log, is marked as signed in on the day it was made. Asking for a reset link is
-- the one thing someone not yet signed in can do. Nothing matches a second time.
UPDATE users SET last_login_at = created_at
 WHERE last_login_at IS NULL AND google_sub IS NULL
   AND (EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = users.id)
     OR EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = users.id AND a.action <> 'PASSWORD_RESET_REQUESTED'
                AND a.action NOT LIKE 'WELCOME_EMAIL%'));

-- Addresses were not verified before; an account someone has signed in to is taken as
-- theirs. Every sign-in since records the verification too, so nothing matches a second time.
UPDATE users SET email_verified_at = COALESCE(last_login_at, created_at)
 WHERE email_verified_at IS NULL AND (last_login_at IS NOT NULL OR google_sub IS NOT NULL);
`;

/**
 * Changes to data that must happen once per database and never again. SCHEMA runs at
 * every start of every replica, so a backfill written there runs each time and undoes
 * whatever people changed since; one that did once caused a security bug. Each of these
 * runs in the transaction that records its name in schema_migrations, under migrate()'s
 * lock, so two replicas starting together run it once between them. Never rename one:
 * a new name runs again. A step that is wrong is put right by a new step.
 *
 * `fills` is the column a step fills in. A table restored from a dump taken before the
 * column existed comes back without it, while schema_migrations, which that dump did not
 * hold, still names the step; so when SCHEMA has to add the column, the step runs again.
 */
export const ONCE: { name: string; fills?: { table: string; column: string }; sql: string }[] = [
  {
    // Directors used to be every Founder and Board member by relationship alone, less anyone with
    // a termination date (the board list and the board audience passed over them). Each gets a seat
    // that ends on that date, so the board is the same the day seats arrive and whoever left is a
    // former director. A Board member's seat starts with the relationship, unless its dates run
    // backwards; a founder's has no start. A seat removed afterwards stays removed.
    name: '2026-10-07-board-seats', fills: { table: 'stakeholders', column: 'board_seat' },
    sql: `UPDATE stakeholders SET board_seat = 1,
            board_seat_start = CASE WHEN relation = 'BOARD_MEMBER' AND (termination_date IS NULL OR termination_date >= start_date) THEN start_date END,
            board_seat_end = termination_date
          WHERE relation IN ('BOARD_MEMBER', 'FOUNDER') AND board_seat = 0`,
  },
];

/** Creates anything missing and runs what ONCE has not run yet. Safe to run on every start; concurrent starts are serialised by an advisory lock. */
export async function migrate(): Promise<void> {
  guardTestDatabase();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7245001)');
    // Steps whose column SCHEMA is about to add (again), before it does.
    const refill = new Set<string>();
    for (const step of ONCE) {
      if (!step.fills) continue;
      const found = await client.query('SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
        [step.fills.table, step.fills.column]);
      if (found.rowCount === 0) refill.add(step.name);
    }
    await client.query(SCHEMA);
    for (const step of ONCE) {
      await client.query('BEGIN');
      try {
        if (refill.has(step.name)) await client.query('DELETE FROM schema_migrations WHERE name = $1', [step.name]);
        const first = await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [step.name, new Date().toISOString()]);
        if (first.rowCount === 1) await client.query(step.sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7245001)').catch(() => undefined);
    client.release();
  }
}

export async function close(): Promise<void> {
  await pool.end();
}
