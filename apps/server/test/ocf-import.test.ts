/**
 * Importing an Open Cap Format package (src/ocf/read.ts, plan.ts, write.ts; the
 * imports routes), through the API the import page uses: parse, the workbook
 * preview and the commit.
 *
 * Pinned here:
 * - parse reads a .ocf.zip (a nested folder and a wrong manifest path included), a
 *   loose manifest and a loose file; it refuses an archive with no manifest, a later
 *   major version, damaged JSON, a zip bomb, non-OCF JSON, too many objects and
 *   hostile shapes, and a checksum mismatch is only a notice;
 * - each object becomes a row with what happens to it, and the problems a package can
 *   have each give their code: unknown references, events out of order, a balance
 *   that does not add up, a missing balance, a retraction, a partial conversion of a
 *   SAFE, a split of some classes only, a split into a company that has securities,
 *   a family waiting for one row's fix or left out with it, a person the package
 *   cannot tell apart (answered with ocfPeople), guessed relationships, a class over
 *   its authorized shares, money in another currency;
 * - the review token and the commit: all or nothing, the sample company refused, the
 *   imports row, the audit line and the counts;
 * - the round trip: the invented Brightwater Kinetics (ocf-company.ts) exported and
 *   imported into an empty company gives the same cap table on every date something
 *   happened and the day before, the same plan reserves and vesting, the same ledger,
 *   and the same package again; importing it again, or into the company it came
 *   from, adds nothing; one extra transfer makes its family differ and writes nothing.
 *
 * Every name and number is invented.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  computeCapTable, computePoolSummaries, computeWaterfall, summarizeVesting, addDays, today, roundShares, type CompanyData,
} from '@kosmitor/core';
import { freshDatabase, sessionCookie } from './helpers.ts';
import { buildBrightwater } from './ocf-company.ts';
import { validateOcf } from './ocf-validate.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/captable-export.ts');
await import('../src/routes/imports.ts');
const { all, one, run } = await import('../src/db.ts');
const { getCompanyData, invalidate } = await import('../src/store.ts');
const { buildOcfPackage, ocfZip } = await import('../src/ocf/export.ts');
const { readZip } = await import('../src/import/xlsx.ts');
const { zip } = await import('../src/xlsx-writer.ts');
const { configure, resetConfig } = await import('../src/config.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

let admin: string | null = null;
async function call(method: string, path: string, body?: unknown, token: string | null = admin) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as any, token: sessionCookie(res) };
}
/** For the fixture: refuses what fails, as a person would see it. */
async function must(method: string, path: string, body?: unknown, token: string | null = admin) {
  const r = await call(method, path, body, token);
  if (r.status >= 400 && method !== 'GET') throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}
async function parse(cid: string, name: string, body: Buffer, token: string | null = admin) {
  const res = await fetch(`${base}/api/c/${cid}/imports/parse?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(body) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any };
}
const preview = (cid: string, body: unknown) => call('POST', `/api/c/${cid}/imports/workbook/preview`, body);
const commit = (cid: string, body: unknown, token: string) => call('POST', `/api/c/${cid}/imports/workbook/commit`, { ...(body as object), reviewToken: token });

admin = (await must('POST', '/api/auth/register', { email: 'ines@example.com', name: 'Ines Halvorsen', password: 'ines-pass-1' }, null)).token as string;
const company = async (name: string, extra: Record<string, unknown> = {}) => (await must('POST', '/api/companies', { name, incorporationDate: '2020-01-02', ...extra })).json.id as string;

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

interface Pkg { files: { path: string; json: any }[] }
const json = (x: unknown) => Buffer.from(`${JSON.stringify(x, null, 2)}\n`);
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

/** A package's zip, with the manifest's checksums worked out (or not). */
function zipOf(pkg: Pkg, opts: { folder?: string; checksums?: boolean } = {}): Buffer {
  const files = pkg.files.map((f) => ({ ...f, json: structuredClone(f.json) }));
  const manifest = files.find((f) => f.json.file_type === 'OCF_MANIFEST_FILE')!;
  if (opts.checksums !== false) {
    for (const [list, refs] of Object.entries(manifest.json)) {
      if (!list.endsWith('_files') || !Array.isArray(refs)) continue;
      for (const ref of refs as any[]) {
        const f = files.find((x) => x.path === ref.filepath.replace(/^\.\//, ''));
        if (f) ref.md5 = md5(json(f.json));
      }
    }
  }
  return zip(files.map((f) => ({ name: `${opts.folder ?? ''}${f.path}`, data: json(f.json) })));
}

/** A small package from scratch: a manifest and the files it lists. */
function pkgOf(parts: { stakeholders?: any[]; classes?: any[]; plans?: any[]; terms?: any[]; valuations?: any[]; legends?: any[]; tx?: any[] }, issuer: Record<string, unknown> = {}): Pkg {
  const file = (path: string, file_type: string, items: any[]) => ({ path, json: { file_type, items } });
  const files = [
    file('Stakeholders.ocf.json', 'OCF_STAKEHOLDERS_FILE', parts.stakeholders ?? []),
    file('StockClasses.ocf.json', 'OCF_STOCK_CLASSES_FILE', parts.classes ?? []),
    file('StockLegends.ocf.json', 'OCF_STOCK_LEGEND_TEMPLATES_FILE', parts.legends ?? []),
    file('StockPlans.ocf.json', 'OCF_STOCK_PLANS_FILE', parts.plans ?? []),
    file('VestingTerms.ocf.json', 'OCF_VESTING_TERMS_FILE', parts.terms ?? []),
    file('Valuations.ocf.json', 'OCF_VALUATIONS_FILE', parts.valuations ?? []),
    file('Transactions.ocf.json', 'OCF_TRANSACTIONS_FILE', parts.tx ?? []),
  ];
  const list = (type: string) => files.filter((f) => f.json.file_type === type).map((f) => ({ filepath: `./${f.path}`, md5: '0'.repeat(32) }));
  const manifest = {
    file_type: 'OCF_MANIFEST_FILE', ocf_version: '1.2.0', as_of: '2024-12-31', generated_at: '2024-12-31T00:00:00Z',
    issuer: { id: 'issuer-1', object_type: 'ISSUER', legal_name: 'Tidewater Looms, Inc.', formation_date: '2020-01-02', country_of_formation: 'US', ...issuer },
    stakeholders_files: list('OCF_STAKEHOLDERS_FILE'), stock_classes_files: list('OCF_STOCK_CLASSES_FILE'), stock_legend_templates_files: list('OCF_STOCK_LEGEND_TEMPLATES_FILE'),
    stock_plans_files: list('OCF_STOCK_PLANS_FILE'), vesting_terms_files: list('OCF_VESTING_TERMS_FILE'), valuations_files: list('OCF_VALUATIONS_FILE'),
    transactions_files: list('OCF_TRANSACTIONS_FILE'),
  };
  return { files: [{ path: 'Manifest.ocf.json', json: manifest }, ...files] };
}

const usd = (amount: string) => ({ amount, currency: 'USD' });
const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, object_type: 'STAKEHOLDER', name: { legal_name: name }, stakeholder_type: 'INDIVIDUAL', current_relationship: 'EMPLOYEE',
  contact_info: { emails: [{ email_type: 'OTHER', email_address: `${id}@tidewater.example` }] }, ...extra,
});
const commonClass = { id: 'cls-common', object_type: 'STOCK_CLASS', name: 'Common', class_type: 'COMMON', default_id_prefix: 'CS-', initial_shares_authorized: '10000000', votes_per_share: '1', seniority: '1', par_value: usd('0.0001'), price_per_share: usd('0.0001') };
const seriesSeed = { id: 'cls-seed', object_type: 'STOCK_CLASS', name: 'Series Seed', class_type: 'PREFERRED', default_id_prefix: 'PS-', initial_shares_authorized: '2000000', votes_per_share: '1', seniority: '2', price_per_share: usd('1.00') };
const stock = (id: string, holder: string, quantity: string, date: string, extra: Record<string, unknown> = {}) => ({
  id: `${id}.issue`, object_type: 'TX_STOCK_ISSUANCE', date, security_id: id, custom_id: id.toUpperCase(), stakeholder_id: holder, stock_class_id: 'cls-common',
  share_price: usd('0.10'), quantity, security_law_exemptions: [], stock_legend_ids: [], ...extra,
});

/** The body a page sends for a parsed package. */
const bodyOf = (parsed: any, options: Record<string, unknown> = {}, exclude?: Record<string, number[]>) =>
  ({ ocf: { file: parsed.fileName, package: parsed.ocf.package, ...(exclude ? { exclude } : {}) }, options });

/** Parse a package into a company and check it. */
async function check(cid: string, pkg: Pkg, options: Record<string, unknown> = {}, exclude?: Record<string, number[]>) {
  const parsed = await parse(cid, 'tidewater.ocf.zip', zipOf(pkg));
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  const body = bodyOf(parsed.json, options, exclude);
  const r = await preview(cid, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { review: r.json, body };
}
/** A section's row by item number. */
const rowOf = (review: any, section: string, item: number) => review.sheets.find((s: any) => s.kind === section)?.preview.rows.find((r: any) => r.row === item);
const codesOf = (row: any) => (row?.messages ?? []).map((m: any) => m.code);

// ---------------------------------------------------------------------------
// The cap table, as the engine computes it, by holder name and class
// ---------------------------------------------------------------------------

function capTable(data: CompanyData, asOf: string) {
  const table = computeCapTable(data, { asOf });
  const out: Record<string, number | string> = {};
  for (const r of table.rows) {
    for (const h of r.holdings) if (h.shares) out[`${r.name} | ${h.className}`] = roundShares(h.shares);
    // investedAmount: what was paid in, which a transferee's certificate traces to the one it came from (finding RT-1).
    for (const k of ['optionsOutstanding', 'optionsVested', 'optionsExercised', 'rsusOutstanding', 'warrantsOutstanding', 'convertiblePrincipal', 'votes', 'investedAmount'] as const) {
      if (r[k]) out[`${r.name} | ${k}`] = roundShares(r[k]);
    }
  }
  for (const c of table.classes) out[`class ${c.name}`] = `${roundShares(c.outstanding)} / ${roundShares(c.authorized)}`;
  return out;
}
/** The waterfall at an exit: each class's and each holder's payout, by name. */
function waterfall(data: CompanyData, asOf: string, exit: number) {
  const w = computeWaterfall(data, exit, { asOf });
  return {
    classes: Object.fromEntries(w.classPayouts.map((c) => [c.name, [c.preferenceClaim, c.preferencePaid, c.total]])),
    holders: Object.fromEntries(w.stakeholderPayouts.map((x) => [x.name, [x.invested, x.total]])),
  };
}
function pools(data: CompanyData, asOf: string) {
  return Object.fromEntries(computePoolSummaries(data, asOf).map((p) => [p.name, JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !/id$/i.test(k)).map(([k, v]) => [k, typeof v === 'number' ? roundShares(v) : v])))]));
}
function vesting(data: CompanyData, asOf: string) {
  const out: Record<string, string> = {};
  const name = (id: string) => data.stakeholders.find((s) => s.id === id)?.name;
  for (const a of data.awards) {
    const s = data.vestingSchedules.find((v) => v.id === a.vestingScheduleId);
    if (!s || a.status === 'PENDING_SIGNATURE') continue;
    const v = summarizeVesting({ schedule: s, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate, terminationDate: data.stakeholders.find((x) => x.id === a.stakeholderId)?.terminationDate ?? null }, asOf);
    out[`${name(a.stakeholderId)} ${a.label}`] = `${roundShares(v.vested)}/${roundShares(v.unvested)}`;
  }
  for (const i of data.issuances) {
    const s = data.vestingSchedules.find((v) => v.id === i.vestingScheduleId);
    if (!s || !i.vestingStartDate) continue;
    const v = summarizeVesting({ schedule: s, totalQuantity: i.quantity, vestingStartDate: i.vestingStartDate, terminationDate: null }, asOf);
    out[`${name(i.stakeholderId)} ${i.certificateNo}`] = `${roundShares(v.vested)}/${roundShares(v.unvested)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const A = await buildBrightwater(must, admin);
const exported = await (await fetch(`${base}/api/c/${A.cid}/captable/export.ocf.zip`, { headers: { Authorization: `Bearer ${admin}` } })).arrayBuffer();
const packageA = Buffer.from(exported);

test('the round trip: Brightwater Kinetics exported and imported into an empty company is the same cap table on every date', async () => {
  // A new company, as someone would create it to import into: its EIN and address come from the package.
  const B = await company('Brightwater Kinetics', { legalName: 'Brightwater Kinetics, Inc.', incorporationDate: '2021-01-04' });
  const parsed = await parse(B, 'brightwater.ocf.zip', packageA);
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  assert.equal(parsed.json.format, 'ocf');
  assert.equal(parsed.json.ocf.part, 'package');
  assert.equal(parsed.json.ocf.version, '1.2.0');
  assert.ok(parsed.json.ocf.files.every((f: any) => f.checksum === 'ok'));
  const body = bodyOf(parsed.json);
  const r = await preview(B, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const problems = r.json.sheets.flatMap((s: any) => s.preview.rows.filter((x: any) => x.status !== 'ok' || x.outcome === 'error').map((x: any) => `${s.kind} ${x.row} ${x.outcome}: ${x.messages.map((m: any) => `${m.level} ${m.code} ${m.text}`).join(' | ')}`));
  assert.equal(r.json.counts.errors, 0, problems.join('\n'));
  assert.deepEqual(r.json.ocf.companyFill, [{ field: 'EIN', value: '00-0000001' }, { field: 'address', value: '12 Example Quay, Springfield' }]);
  assert.deepEqual(r.json.ocf.notices.map((n: any) => n.code), ['ocf-legends']);
  const done = await commit(B, body, r.json.reviewToken);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  invalidate(A.cid); invalidate(B);
  const a = await getCompanyData(A.cid), b = await getCompanyData(B);

  // Every date something happened, the day before each, and the dates a leaver's options lapse with no ledger entry.
  const dates = new Set<string>([today(), addDays(today(), -1)]);
  const packageDates = [...readZip(packageA).entries()].flatMap(([, data]) => {
    const f = JSON.parse(data.toString('utf8'));
    return f.file_type === 'OCF_TRANSACTIONS_FILE' ? f.items.map((t: any) => t.date as string) : [];
  });
  for (const d of [...(await all<{ date: string }>('SELECT DISTINCT date FROM transactions WHERE company_id = ?', A.cid)).map((t) => t.date), ...packageDates]) { dates.add(d); dates.add(addDays(d, -1)); }
  assert.ok(dates.size > 40);
  for (const d of [...dates].sort()) {
    assert.deepEqual(capTable(b, d), capTable(a, d), `cap table on ${d}`);
    assert.deepEqual(pools(b, d), pools(a, d), `plans on ${d}`);
    assert.deepEqual(vesting(b, d), vesting(a, d), `vesting on ${d}`);
  }
  // The waterfall: cumulative dividends accrue from when a transferee's preferred shares were first issued (finding RT-1).
  for (const d of ['2023-01-01', '2024-07-01', today()]) {
    for (const exit of [5_000_000_000, 50_000_000_000]) assert.deepEqual(waterfall(b, d, exit), waterfall(a, d, exit), `waterfall of ${exit} on ${d}`);
  }

  // The records themselves, field by field where the package carries them.
  // Ids differ from one company to the other, and notes may name one ("Issued on exercise of warrant war_…").
  const rows = async (cid: string, sql: string) => (await all<Record<string, unknown>>(sql, cid)).map((x) => JSON.stringify(x).replace(/\b[a-z]{2,5}_[0-9a-f]{8}-[0-9a-f]{3}\b/g, '#id')).sort();
  // Exercises as recorded: method, fair market value and shares issued, after the split too (finding RT-2).
  const exercisesOf = (cid: string) => rows(cid, `SELECT a.label, e.exercise_date, e.quantity, e.method, e.strike_price, e.fmv_at_exercise, e.total_cost, e.spread, e.shares_issued
    FROM exercises e JOIN awards a ON a.id = e.award_id WHERE e.company_id = ?`);
  assert.deepEqual(await exercisesOf(B), await exercisesOf(A.cid), 'exercises');
  // What each event paid (finding RT-7).
  const amountsOf = (cid: string) => rows(cid, "SELECT type, date, quantity, price_per_share, amount FROM transactions WHERE company_id = ? AND type IN ('TRANSFER', 'REPURCHASE', 'EXERCISE', 'CONVERSION', 'REPAYMENT')");
  assert.deepEqual(await amountsOf(B), await amountsOf(A.cid), 'amounts paid');
  // Grants: expiry kept as it is, none assumed (finding RT-5); the restricted stock award of CS-4 is there, and CS-4 names it (finding F1).
  const grantsOf = (cid: string) => rows(cid, `SELECT a.label, a.type, a.quantity, a.strike_price, a.expiration_date, a.status, a.exercised_quantity, a.cancelled_quantity, a.ptep_months,
    (SELECT certificate_no FROM issuances i WHERE i.source_award_id = a.id AND i.certificate_no NOT LIKE 'EX-%' LIMIT 1) AS certificate FROM awards a WHERE a.company_id = ? AND a.status <> 'PENDING_SIGNATURE'`);
  assert.deepEqual(await grantsOf(B), await grantsOf(A.cid), 'grants');
  // People, SAFEs and certificates: notes, regions, refused emails and signatories, funds received, numbers (findings RT-9, RT-10, F9).
  const peopleOf = (cid: string) => rows(cid, 'SELECT name, email, secondary_email, region, country, notes, signatory_name, termination_date, relation FROM stakeholders WHERE company_id = ?');
  assert.deepEqual(await peopleOf(B), await peopleOf(A.cid), 'people');
  const safesOf = (cid: string) => rows(cid, 'SELECT label, board_approval_date, funds_received_on, funds_reference, notes FROM convertibles WHERE company_id = ?');
  assert.deepEqual(await safesOf(B), await safesOf(A.cid), 'SAFEs and notes');
  const certificatesOf = (cid: string) => rows(cid, "SELECT certificate_no, quantity, status, notes FROM issuances WHERE company_id = ? AND (certificate_no IS NULL OR certificate_no NOT LIKE 'TR-%')");
  assert.deepEqual(await certificatesOf(B), await certificatesOf(A.cid), 'certificates');
  // A leaver's lapsed options are not entered twice: Kosmitor works them out from the leaving date (finding F2).
  const lapses = r.json.sheets.find((x: any) => x.kind === 'events').preview.rows.filter((x: any) => /^Lapsed/.test(x.summary.detail ?? ''));
  assert.deepEqual(lapses.map((x: any) => [x.summary.date, x.outcome, x.messages[0].code]), [['2023-06-30', 'skip', 'ocf-folded'], ['2023-06-30', 'skip', 'ocf-folded'], ['2023-10-01', 'skip', 'ocf-folded']]);

  // The same ledger, entry type by entry type: a cancellation stays a cancellation whatever its words say (the note
  // says which it was, finding RT-8), and the corrections and the secondary sale the export leaves out are not there.
  const types = async (cid: string) => {
    const out: Record<string, number> = {};
    for (const e of await all<{ type: string }>('SELECT type FROM transactions WHERE company_id = ?', cid)) out[e.type] = (out[e.type] ?? 0) + 1;
    return out;
  };
  const ledgerA = await types(A.cid);
  delete ledgerA.SECONDARY_SALE;
  // Of the corrections, only W-4's lowered count is an event OCF carries (a cancellation of part of the warrant, finding RT-4).
  ledgerA.CORRECTION = (await all("SELECT id FROM transactions WHERE company_id = ? AND type = 'CORRECTION' AND quantity < 0 AND security_id IN (SELECT id FROM warrants WHERE company_id = ?)", A.cid, A.cid)).length;
  assert.deepEqual(await types(B), ledgerA);
  const ended = (cid: string) => all<{ type: string; date: string }>("SELECT type, date FROM transactions WHERE company_id = ? AND type IN ('CANCELLATION', 'FORFEITURE', 'EXPIRATION') ORDER BY date, type", cid);
  assert.deepEqual(await ended(B), await ended(A.cid), 'each cancellation is the entry it was');

  // The company's own records: what the import wrote, and how it says so.
  assert.deepEqual(done.json.imported, {
    stakeholders: 16, shareClasses: 1, issuances: 16, awards: 15, convertibles: 5, vestingSchedules: 3, pools: 1, warrants: 4,
    valuations: 2, stockSplits: 1, poolAdjustments: 1, events: 27, updated: { stakeholders: 0 },
  });
  const imp = await one<{ kind: string; file_name: string; row_count: number; imported_count: number; summary: string }>('SELECT * FROM imports WHERE company_id = ?', B);
  assert.deepEqual([imp?.kind, imp?.file_name, imp?.row_count, imp?.imported_count], ['ocf', 'brightwater.ocf.zip', r.json.counts.total, r.json.counts.willImport]);
  assert.ok(JSON.parse(imp!.summary).sections.events.total > 20);
  const audit = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE company_id = ? AND action = 'IMPORT'", B);
  assert.match(audit!.detail, /^Imported the OCF package brightwater\.ocf\.zip: 16 stakeholders, 1 share classes, 1 equity plans, 16 certificates, 15 grants, 4 warrants, 5 convertibles, 2 valuations, 1 stock splits, 1 plan changes, 27 history entries/);
  const memo = await one<{ memo: string }>("SELECT memo FROM transactions WHERE company_id = ? AND type = 'ISSUANCE' AND security_id = (SELECT id FROM issuances WHERE company_id = ? AND certificate_no = 'CS-1')", B, B);
  assert.equal(memo?.memo, `Imported from brightwater.ocf.zip (OCF ${A.cs1})`);
  const people = await one<{ legal_name: string; phone: string; board_seat: number; board_designated_by: string | null }>("SELECT * FROM stakeholders WHERE company_id = ? AND name = 'Lark Ostrander'", B);
  assert.equal(people?.board_seat, 1);
  assert.equal((await one<{ name: string }>('SELECT name FROM stakeholders WHERE id = ?', people!.board_designated_by))?.name, 'Fenwick Capital Fund I, L.P.');

  // Exported again, B is the package A was, but for ids and what A had that a package does not carry.
  const normalize = (pkg: { files: { path: string; json: any }[] }) => {
    const seen = new Map<string, string>();
    const text = JSON.stringify(pkg.files.map((f) => {
      if (f.json.file_type !== 'OCF_MANIFEST_FILE') return f;
      const { generated_at: _g, as_of: _a, comments: _c, issuer: { id: _i, ...issuer }, ...rest } = f.json;
      void _g; void _a; void _c; void _i;
      return { path: f.path, json: { ...rest, issuer, ...Object.fromEntries(Object.entries(rest).filter(([k]) => k.endsWith('_files')).map(([k, v]) => [k, (v as any[]).map((x) => x.filepath)])) } };
    }));
    const out = JSON.parse(text.replace(/\b[a-z]{2,5}_[0-9a-f]{8}-[0-9a-f]{3}\b/g, (id) => { if (!seen.has(id)) seen.set(id, `#${seen.size + 1}`); return seen.get(id)!; }));
    // An unnumbered security's custom_id is made up from its id, as is its balances'.
    for (const f of out) {
      if (f.json.file_type !== 'OCF_TRANSACTIONS_FILE') continue;
      const made = new Set(f.json.items.filter((t: any) => (t.comments ?? []).some((c: string) => c.includes('"unnumbered":true'))).map((t: any) => t.security_id));
      for (const t of f.json.items) if (t.custom_id && made.has(String(t.security_id).replace(/\.b\d+$/, ''))) t.custom_id = t.custom_id.replace(/^[0-9A-Z]{2}-[0-9A-Z]{3}/, 'made-up');
    }
    return out;
  };
  const again = await buildOcfPackage(B, { asOf: today(), generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(validateOcf(again.files), []);
  const was = { files: [...readZip(packageA).entries()].map(([path, data]) => ({ path, json: JSON.parse(data.toString('utf8')) })) };
  const order = <T extends { path: string }>(p: { files: T[] }) => ({ files: [...p.files].sort((x, y) => (x.path < y.path ? -1 : 1)) });
  const [x, y] = [normalize(order(again)), normalize(order(was))];
  for (let i = 0; i < y.length; i++) {
    // Item by item, so a difference names the object it is in.
    const [xi, yi] = [x[i].json.items, y[i].json.items];
    if (Array.isArray(yi)) for (let j = 0; j < Math.max(xi.length, yi.length); j++) assert.deepEqual(xi[j], yi[j], `${y[i].path} item ${j + 1}`);
    assert.deepEqual(x[i], y[i], y[i].path);
  }

  // Imported again, nothing is new; nor into the company it came from.
  for (const into of [B, A.cid]) {
    const p = await parse(into, 'brightwater.ocf.zip', packageA);
    const again = await preview(into, bodyOf(p.json));
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const left = again.json.sheets.flatMap((s: any) => s.preview.rows.filter((x: any) => x.outcome !== 'existing' && x.outcome !== 'skip').map((x: any) => `${s.kind} ${x.row} ${x.outcome}: ${x.messages.map((m: any) => m.text).join(' | ')}`));
    assert.deepEqual(left, [], into === B ? 'again into B' : 'into A');
    assert.equal(again.json.counts.willImport, 0);
    assert.equal(again.json.imported.events, 0);
  }
});

test('a package with a transfer the cap table does not have: its family is already there, differs, and nothing of it is written', async () => {
  const B = (await one<{ id: string }>("SELECT company_id AS id FROM imports WHERE kind = 'ocf' ORDER BY created_at LIMIT 1"))!.id;
  const files = [...readZip(packageA).entries()].map(([path, data]) => ({ path, json: JSON.parse(data.toString('utf8')) }));
  const tx = files.find((f) => f.json.file_type === 'OCF_TRANSACTIONS_FILE')!.json;
  const ps1 = tx.items.find((t: any) => t.object_type === 'TX_STOCK_ISSUANCE' && t.custom_id === 'PS-1');
  tx.items.push(
    { id: 'extra-transfer', object_type: 'TX_STOCK_TRANSFER', date: '2024-09-02', security_id: ps1.security_id, quantity: '100000', resulting_security_ids: ['extra-cert'], balance_security_id: 'extra-balance' },
    { ...ps1, id: 'extra-cert.issue', security_id: 'extra-cert', custom_id: 'PS-9', stakeholder_id: A.mina, date: '2024-09-02', quantity: '100000' },
    { ...ps1, id: 'extra-balance.issue', security_id: 'extra-balance', date: '2024-09-02', quantity: '3900000' },
  );
  const before = (await all('SELECT id FROM transactions WHERE company_id = ?', B)).length;
  const p = await parse(B, 'brightwater-plus.ocf.zip', zipOf({ files }));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const r = await preview(B, bodyOf(p.json));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const root = r.json.sheets.find((s: any) => s.kind === 'captable').preview.rows.find((x: any) => x.summary.certificate === 'PS-1');
  assert.deepEqual([root.outcome, root.status], ['existing', 'warning']);
  assert.match(root.messages.find((m: any) => m.code === 'differs-from-record').text, /^The cap table's PS-1 has no transfer on 2024-09-02 — nothing of it is changed/);
  const added = r.json.sheets.flatMap((s: any) => s.preview.rows.filter((x: any) => x.outcome === 'add' || x.outcome === 'update'));
  assert.deepEqual(added, [], 'nothing else is new either');
  assert.equal(r.json.counts.willImport, 0);
  assert.equal((await all('SELECT id FROM transactions WHERE company_id = ?', B)).length, before);
});

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const tidewater = () => pkgOf({
  stakeholders: [person('ana', 'Ana Brightly', { current_relationship: 'FOUNDER' }), person('bo', 'Bo Kestrel')],
  classes: [commonClass],
  tx: [stock('cs-1', 'ana', '1000000', '2021-02-01'), stock('cs-2', 'bo', '50000', '2022-03-01')],
});

test('parse: a zip, a zip in a folder whose manifest names a file wrongly, a loose manifest and a loose file', async () => {
  const cid = await company('Parse Works');
  const r = await parse(cid, 'tidewater.ocf.zip', zipOf(tidewater()));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.format, r.json.sheets, r.json.ocf.part, r.json.ocf.issuer, r.json.ocf.asOf], ['ocf', [], 'package', { id: 'issuer-1', legalName: 'Tidewater Looms, Inc.', dba: null }, '2024-12-31']);
  assert.deepEqual(r.json.ocf.counts, { stakeholders: 2, shareClasses: 1, plans: 0, vesting: 0, valuations: 0, captable: 2, grants: 0, warrants: 0, convertibles: 0, events: 0, transactions: 2 });
  assert.deepEqual(r.json.ocf.files.map((f: any) => [f.path, f.items]).sort(), [
    ['Stakeholders.ocf.json', 2], ['StockClasses.ocf.json', 1], ['StockLegends.ocf.json', 0], ['StockPlans.ocf.json', 0],
    ['Transactions.ocf.json', 2], ['Valuations.ocf.json', 0], ['VestingTerms.ocf.json', 0],
  ]);
  assert.ok(r.json.ocf.files.every((f: any) => f.checksum === 'ok'));

  // In a folder, and the manifest names the transactions file wrongly: the file of that kind is read for it.
  const moved = tidewater();
  moved.files[0].json.transactions_files = [{ filepath: './Ledger/History.ocf.json', md5: '0'.repeat(32) }];
  const nested = await parse(cid, 'nested.ocf.zip', zipOf(moved, { folder: 'export-2024/', checksums: false }));
  assert.equal(nested.status, 200, JSON.stringify(nested.json));
  assert.deepEqual(nested.json.ocf.notices.filter((n: any) => n.code === 'ocf-path-resolved').map((n: any) => n.text),
    ['The manifest lists ./Ledger/History.ocf.json; export-2024/Transactions.ocf.json was read for it (the same kind of file).']);
  assert.ok(nested.json.ocf.notices.some((n: any) => n.code === 'ocf-checksum'), 'placeholder checksums are only a notice');
  const fromNested = await preview(cid, bodyOf(nested.json));
  assert.equal(fromNested.status, 200, JSON.stringify(fromNested.json));
  assert.equal(fromNested.json.counts.willImport, 5);

  // A manifest on its own, then one of its files: the page puts them together.
  const manifest = await parse(cid, 'Manifest.ocf.json', json(tidewater().files[0].json));
  assert.deepEqual([manifest.status, manifest.json.ocf.part, manifest.json.ocf.missing.length, manifest.json.ocf.package.manifestPath], [200, 'manifest', 7, 'Manifest.ocf.json']);
  const one = await parse(cid, 'Stakeholders.ocf.json', json(tidewater().files[1].json));
  assert.deepEqual([one.status, one.json.ocf.part, one.json.ocf.fileType, one.json.ocf.files[0].items], [200, 'file', 'OCF_STAKEHOLDERS_FILE', 2]);
  assert.match(one.json.ocf.files[0].md5, /^[0-9a-f]{32}$/);
});

test('parse refuses what is not a package it can read, each with its code', async () => {
  const cid = await company('Parse Refusals');
  const refused = async (name: string, body: Buffer) => { const r = await parse(cid, name, body); return [r.status, r.json.detail?.code, r.json.error]; };
  assert.deepEqual(await refused('no-manifest.zip', zip([{ name: 'a.json', data: json({ file_type: 'OCF_STAKEHOLDERS_FILE', items: [] }) }])),
    [400, 'ocf-no-manifest', 'This archive holds JSON files but no OCF manifest.']);
  const two = tidewater();
  assert.deepEqual((await refused('two.zip', zip([...two.files, { path: 'other/Manifest.ocf.json', json: two.files[0].json }].map((f) => ({ name: f.path, data: json(f.json) })))))[1], 'ocf-two-manifests');
  const later = tidewater();
  later.files[0].json.ocf_version = '2.0.0';
  assert.deepEqual(await refused('later.ocf.zip', zipOf(later)), [400, 'ocf-version', 'This package is OCF 2.0.0; Kosmitor reads OCF 1.x.']);
  const missing = tidewater();
  missing.files = missing.files.filter((f) => f.json.file_type !== 'OCF_TRANSACTIONS_FILE');
  assert.deepEqual(await refused('missing.ocf.zip', zipOf(missing)), [400, 'ocf-missing-file', 'The manifest lists Transactions.ocf.json, which is not in the package.']);
  assert.deepEqual((await refused('broken.ocf.zip', zip([{ name: 'Manifest.ocf.json', data: Buffer.from('{"file_type": "OCF_MANIFEST_FILE", ') }])))[1], 'damaged');
  assert.deepEqual((await refused('broken.json', Buffer.from('{"file_type": ')))[1], 'damaged');
  assert.deepEqual(await refused('notes.json', Buffer.from('{"hello": "world"}')), [400, 'not-a-spreadsheet', 'This JSON file is not an Open Cap Format file.']);
  // Nested deeper than any OCF object is: refused, not a stack overflow.
  assert.deepEqual((await refused('deep.json', Buffer.from(`{"file_type":"OCF_STAKEHOLDERS_FILE","items":${'['.repeat(5000)}${']'.repeat(5000)}}`)))[1], 'damaged');
  // A zip of JSON that unpacks past the limit, and too many objects.
  configure({ limits: { importUnzippedMb: 2 } });
  try {
    const bomb = zip([{ name: 'Manifest.ocf.json', data: json(tidewater().files[0].json) }, { name: 'Big.json', data: Buffer.from(`{"x":"${' '.repeat(8 * 1024 * 1024)}"}`) }]);
    assert.ok(bomb.length < 100_000);
    assert.deepEqual((await refused('bomb.ocf.zip', bomb)).slice(0, 2), [400, 'unzips-too-large']);
  } finally { resetConfig(); }
  configure({ limits: { importMaxTotalRows: 3 } });
  try {
    assert.deepEqual((await refused('many.ocf.zip', zipOf(tidewater()))).slice(0, 2), [400, 'too-many-rows']);
  } finally { resetConfig(); }
});

test('the package the page sends back is checked again: shape, size, keys that reach a prototype, and sheets beside it', async () => {
  const cid = await company('Request Checks');
  const p = (await parse(cid, 'tidewater.ocf.zip', zipOf(tidewater()))).json;
  const bad = async (body: unknown) => { const r = await preview(cid, body); return [r.status, r.json.detail?.code]; };
  assert.deepEqual(await bad({ ...bodyOf(p), sheets: [{ name: 'x' }] }), [400, 'ocf-alone']);
  assert.deepEqual(await bad({ ocf: { file: 'x.ocf.zip', package: { files: 'nope' } } }), [400, 'bad-sheet']);
  assert.deepEqual(await bad({ ocf: { file: 'x.ocf.zip', package: { files: [{ path: 'a' }] } } }), [400, 'bad-sheet']);
  assert.deepEqual(await bad({ ocf: { file: 'x.ocf.zip', package: { manifestPath: null, manifest: null, files: [] } } }), [400, 'ocf-no-manifest']);
  assert.deepEqual(await bad({ ...bodyOf(p), ocf: { ...bodyOf(p).ocf, exclude: { nonsense: [1] } } }), [400, 'bad-option']);
  assert.deepEqual(await bad(bodyOf(p, { ocfPeople: { ana: 'stk_someone-elses' } })), [400, 'bad-option']);
  // A key that would reach the prototype of what the server builds is dropped, not obeyed.
  const text = JSON.stringify(bodyOf(p)).replace('"object_type":"STAKEHOLDER"', '"__proto__":{"polluted":true},"object_type":"STAKEHOLDER"');
  assert.ok(text.includes('__proto__'));
  const res = await fetch(`${base}/api/c/${cid}/imports/workbook/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: text });
  assert.equal(res.status, 200);
  assert.equal(({} as any).polluted, undefined);
  configure({ limits: { importMaxTotalRows: 3 } });
  try { assert.deepEqual(await bad(bodyOf(p)), [400, 'too-many-rows']); } finally { resetConfig(); }
});

// ---------------------------------------------------------------------------
// What each object becomes, case by case
// ---------------------------------------------------------------------------

const transfer = (id: string, security: string, quantity: string, date: string, extra: Record<string, unknown> = {}) =>
  ({ id, object_type: 'TX_STOCK_TRANSFER', date, security_id: security, quantity, resulting_security_ids: [], ...extra });

test('references, the order of events and balances: each problem on its row, and the rows that wait for it', async () => {
  const cid = await company('Faults Ltd');
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly'), person('bo', 'Bo Kestrel')],
    classes: [commonClass],
    tx: [
      stock('cs-1', 'ana', '1000000', '2021-02-01'),                                                           // 1: fine
      stock('cs-2', 'ghost', '1000', '2021-02-01'),                                                            // 2: nobody
      stock('cs-3', 'bo', '100000', '2022-01-01'),                                                              // 3
      transfer('tr-3', 'cs-3', '100000', '2021-06-01'),                                                         // 4: before its issue
      stock('cs-4', 'bo', '200000', '2022-01-01'),                                                              // 5
      transfer('tr-4', 'cs-4', '60000', '2022-06-01', { resulting_security_ids: ['cs-4r'], balance_security_id: 'cs-4b' }),   // 6: balance does not add up
      stock('cs-4b', 'bo', '999', '2022-06-01'),                                                               // 7
      stock('cs-4r', 'ana', '60000', '2022-06-01'),                                                            // 8
      stock('cs-5', 'ana', '300000', '2022-01-01'),                                                            // 9
      { id: 'cx-5', object_type: 'TX_STOCK_CANCELLATION', date: '2022-02-01', security_id: 'cs-5', quantity: '100000', reason_text: 'Returned' },  // 10: no balance
      { id: 'acc-1', object_type: 'TX_STOCK_ACCEPTANCE', date: '2021-02-02', security_id: 'cs-1' },             // 11: not imported
      { id: 'odd-1', object_type: 'TX_STOCK_TRANSFER', date: '2022-02-01', security_id: 'nowhere', quantity: '1', resulting_security_ids: [] },   // 12: no such security
    ],
  }));
  assert.deepEqual([rowOf(review, 'captable', 1).outcome, codesOf(rowOf(review, 'captable', 1))], ['add', []]);
  assert.deepEqual([rowOf(review, 'captable', 2).outcome, rowOf(review, 'captable', 2).messages[0].code, rowOf(review, 'captable', 2).messages[0].field], ['error', 'ocf-unknown-reference', 'stakeholder_id']);
  assert.deepEqual([rowOf(review, 'events', 4).outcome, codesOf(rowOf(review, 'events', 4))], ['error', ['ocf-event-order']]);
  assert.deepEqual([rowOf(review, 'captable', 3).outcome, rowOf(review, 'captable', 3).messages[0].text], ['error', 'Waits for item 4']);
  assert.deepEqual(codesOf(rowOf(review, 'events', 6))[0], 'ocf-balance-mismatch');
  assert.equal(rowOf(review, 'events', 6).messages[0].text, 'The balance cs-4b holds 999 shares, but 140,000 are left');
  for (const item of [5, 8]) assert.deepEqual([rowOf(review, 'captable', item).outcome, codesOf(rowOf(review, 'captable', item))[0]], ['error', 'ocf-depends'], `item ${item}`);
  assert.equal(rowOf(review, 'captable', 7), undefined, 'a balance is folded into its certificate');
  assert.deepEqual([rowOf(review, 'events', 10).outcome, rowOf(review, 'events', 10).status, codesOf(rowOf(review, 'events', 10))], ['add', 'warning', ['ocf-no-balance']]);
  assert.deepEqual([rowOf(review, 'events', 11).outcome, codesOf(rowOf(review, 'events', 11))], ['skip', ['ocf-not-imported']]);
  assert.deepEqual([rowOf(review, 'events', 12).outcome, codesOf(rowOf(review, 'events', 12))], ['error', ['ocf-unknown-reference']]);
  assert.deepEqual(review.ocf.notImported, [{ what: 'TX_STOCK_ACCEPTANCE', count: 1, reason: 'Kosmitor records no acceptance of shares' }]);
  assert.ok(review.sheets.find((s: any) => s.kind === 'captable').blocked);

  // Left out: the errors' rows, which take their families with them; the rest goes in.
  const { review: skipping, body } = await check(cid, pkgOf({ stakeholders: [person('ana', 'Ana Brightly'), person('bo', 'Bo Kestrel')], classes: [commonClass],
    tx: [stock('cs-1', 'ana', '1000000', '2021-02-01'), stock('cs-5', 'ana', '300000', '2022-01-01'),
      { id: 'cx-5', object_type: 'TX_STOCK_CANCELLATION', date: '2022-02-01', security_id: 'cs-5', quantity: '100000', reason_text: 'Returned' },
      stock('cs-2', 'ghost', '1000', '2021-02-01')] }), { skipRowsWithErrors: true });
  assert.equal(skipping.counts.errors, 1);
  const done = await commit(cid, body, skipping.reviewToken);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const rows = await all<{ certificate_no: string; quantity: number; status: string }>('SELECT certificate_no, quantity, status FROM issuances WHERE company_id = ? ORDER BY certificate_no', cid);
  assert.deepEqual(rows.map((r) => [r.certificate_no, r.quantity, r.status]), [['CS-1', 1_000_000, 'OUTSTANDING'], ['CS-5', 200_000, 'OUTSTANDING']]);
  const cancel = await one<{ type: string; quantity: number; memo: string }>("SELECT type, quantity, memo FROM transactions WHERE company_id = ? AND type = 'CANCELLATION'", cid);
  assert.deepEqual([cancel?.quantity, cancel?.memo], [100_000, 'Returned (OCF cx-5)']);
  invalidate(cid);
  const data = await getCompanyData(cid);
  assert.equal(capTable(data, '2022-01-15')['Ana Brightly | Common'], 1_300_000, 'before the cancellation, the ledger gives the shares back');
  assert.equal(capTable(data, '2022-02-01')['Ana Brightly | Common'], 1_200_000);
});

test('a family is left out with any of its rows, and a retracted one is not imported at all', async () => {
  const cid = await company('Family Matters');
  const pkg = pkgOf({
    stakeholders: [person('ana', 'Ana Brightly'), person('bo', 'Bo Kestrel')],
    classes: [commonClass],
    tx: [
      stock('cs-1', 'ana', '1000', '2021-02-01'),
      transfer('tr-1', 'cs-1', '400', '2021-03-01', { resulting_security_ids: ['cs-2'], balance_security_id: 'cs-1b' }),
      stock('cs-1b', 'ana', '600', '2021-03-01'),
      stock('cs-2', 'bo', '400', '2021-03-01'),
      stock('cs-3', 'bo', '50', '2021-02-01'),
      { id: 'rt-3', object_type: 'TX_STOCK_RETRACTION', date: '2021-02-05', security_id: 'cs-3', reason_text: 'Issued by mistake' },
    ],
  });
  const { review } = await check(cid, pkg, {}, { captable: [4] });
  assert.deepEqual([rowOf(review, 'captable', 4).outcome, rowOf(review, 'captable', 4).messages[0].code], ['excluded', 'excluded']);
  for (const [section, item] of [['captable', 1], ['events', 2]] as const) {
    assert.deepEqual([rowOf(review, section, item).outcome, rowOf(review, section, item).messages], ['excluded', [{ level: 'info', text: 'Left out with item 4 (CS-2)', code: 'ocf-excluded-with' }]], `${section} ${item}`);
  }
  for (const [section, item] of [['captable', 5], ['events', 6]] as const) {
    assert.deepEqual([rowOf(review, section, item).outcome, codesOf(rowOf(review, section, item))], ['skip', ['ocf-not-imported']], `${section} ${item}`);
  }
  assert.match(rowOf(review, 'captable', 5).messages[0].text, /^Not imported: Retracted on 2021-02-05/);
  assert.equal(review.counts.willImport, 3, 'the two people, and the terms of the company\'s Common, which has nothing issued yet');
  assert.deepEqual(codesOf(rowOf(review, 'shareClasses', 1)), ['class-updated']);
});

test('SAFEs and notes: a partial conversion cannot be, a retraction leaves it out, another currency is refused', async () => {
  const cid = await company('Convertible Co');
  const safe = (id: string, holder: string, amount: string, extra: Record<string, unknown> = {}) => ({
    id: `${id}.issue`, object_type: 'TX_CONVERTIBLE_ISSUANCE', date: '2021-05-01', security_id: id, custom_id: id.toUpperCase(), stakeholder_id: holder,
    investment_amount: usd(amount), convertible_type: 'SAFE', seniority: 1, security_law_exemptions: [],
    conversion_triggers: [{ type: 'AUTOMATIC_ON_CONDITION', trigger_id: 'next', trigger_condition: 'Next round', conversion_right: { type: 'CONVERTIBLE_CONVERSION_RIGHT', converts_to_future_round: true,
      conversion_mechanism: { type: 'SAFE_CONVERSION', conversion_mfn: false, conversion_valuation_cap: usd('8000000.00'), conversion_timing: 'POST_MONEY' } } }], ...extra,
  });
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass],
    tx: [
      safe('safe-1', 'ana', '100000.00'),
      { id: 'cv-1', object_type: 'TX_CONVERTIBLE_CONVERSION', date: '2022-01-01', security_id: 'safe-1', trigger_id: 'next', reason_text: 'Seed round', quantity_converted: '50000.00', resulting_security_ids: [], balance_security_id: 'safe-1b' },
      safe('safe-1b', 'ana', '50000.00', { date: '2022-01-01' }),
      safe('safe-2', 'ana', '25000.00'),
      { id: 'rt-2', object_type: 'TX_CONVERTIBLE_RETRACTION', date: '2021-05-03', security_id: 'safe-2', reason_text: 'Never signed' },
      safe('safe-3', 'ana', '1000.00', { investment_amount: { amount: '1000.00', currency: 'EUR' } }),
      safe('safe-4', 'ana', '1000.005'),
    ],
  }));
  assert.deepEqual([rowOf(review, 'events', 2).outcome, codesOf(rowOf(review, 'events', 2))], ['error', ['ocf-unsupported']]);
  assert.deepEqual([rowOf(review, 'convertibles', 1).outcome, codesOf(rowOf(review, 'convertibles', 1))[0]], ['error', 'ocf-depends']);
  assert.equal(rowOf(review, 'convertibles', 4).outcome, 'skip');
  assert.deepEqual([rowOf(review, 'convertibles', 6).outcome, rowOf(review, 'convertibles', 6).messages[0]], ['error',
    { level: 'error', code: 'ocf-currency', field: 'investment_amount.currency', value: 'EUR', text: 'Amount in EUR; this company keeps its cap table in USD.' }]);
  assert.deepEqual([rowOf(review, 'convertibles', 7).outcome, codesOf(rowOf(review, 'convertibles', 7))], ['add', ['ocf-rounded']]);
  assert.equal(rowOf(review, 'convertibles', 7).summary.principal, 1000.01);
});

test('splits: every class at once, only into an empty cap table, and what was issued before one waits for it', async () => {
  const cid = await company('Split Co');
  const pkg = (classes: string[]) => pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass, seriesSeed],
    tx: [
      stock('cs-1', 'ana', '1000', '2021-02-01'), stock('ps-1', 'ana', '500', '2021-02-01', { stock_class_id: 'cls-seed', share_price: usd('1.00') }),
      ...classes.map((c) => ({ id: `split.${c}`, object_type: 'TX_STOCK_CLASS_SPLIT', date: '2022-01-01', stock_class_id: c, split_ratio: { numerator: '2', denominator: '1' } })),
      transfer('tr-1', 'cs-1', '2000', '2022-06-01', { resulting_security_ids: ['cs-2'] }),
      stock('cs-2', 'ana', '2000', '2022-06-01'),
    ],
  });
  const { review: partial } = await check(cid, pkg(['cls-common']));
  assert.deepEqual([rowOf(partial, 'events', 3).outcome, codesOf(rowOf(partial, 'events', 3))], ['error', ['ocf-unsupported']]);
  assert.match(rowOf(partial, 'events', 3).messages[0].text, /Only some classes split on 2022-01-01 \(not Series Seed\); Kosmitor splits every class at once/);
  assert.deepEqual([rowOf(partial, 'captable', 1).outcome, rowOf(partial, 'captable', 1).messages[0].text], ['error', 'Waits for item 3']);

  const { review: whole, body } = await check(cid, pkg(['cls-common', 'cls-seed']));
  assert.equal(whole.counts.errors, 0, JSON.stringify(whole.sheets.map((s: any) => s.preview.rows.filter((r: any) => r.status === 'error'))));
  assert.deepEqual(codesOf(rowOf(whole, 'events', 4)), ['ocf-folded'], 'the second class is part of the one split');
  const done = await commit(cid, body, whole.reviewToken);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(await all('SELECT date, ratio FROM stock_splits WHERE company_id = ?', cid), [{ date: '2022-01-01', ratio: 2 }]);
  assert.equal((await one<{ memo: string }>("SELECT memo FROM transactions WHERE company_id = ? AND type = 'STOCK_SPLIT'", cid))?.memo, '2:1 split recorded (OCF split.cls-common)');
  invalidate(cid);
  const data = await getCompanyData(cid);
  assert.deepEqual([capTable(data, '2021-12-31')['Ana Brightly | Common'], capTable(data, '2022-01-01')['Ana Brightly | Common'], capTable(data, '2022-06-01')['Ana Brightly | Common']], [1000, 2000, 2000]);

  // Into a company that already has securities: refused, unless the split is already there.
  const other = await company('Split Later Co');
  const holder = (await must('POST', `/api/c/${other}/stakeholders`, { name: 'Wren Hollis', relation: 'FOUNDER' })).json.id;
  const cls = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', other))!.id;
  await must('POST', `/api/c/${other}/issuances`, { certificateNo: 'X-1', stakeholderId: holder, shareClassId: cls, quantity: 10, pricePerShare: 1, issueDate: '2020-05-01' });
  const { review: late } = await check(other, pkg(['cls-common', 'cls-seed']));
  assert.deepEqual([rowOf(late, 'events', 3).outcome, codesOf(rowOf(late, 'events', 3))], ['error', ['ocf-split-existing']]);
  const { review: again } = await check(cid, pkg(['cls-common', 'cls-seed']));
  assert.deepEqual([rowOf(again, 'events', 3).outcome, again.counts.willImport], ['existing', 0]);
});

test('plans, grants and warrants: a plan in error holds its grants back, a grant with no plan or no option type is read as it says, a warrant is exercised and partly cancelled', async () => {
  const cid = await company('Grants Co');
  const option = (id: string, extra: Record<string, unknown>) => ({
    id: `${id}.issue`, object_type: 'TX_EQUITY_COMPENSATION_ISSUANCE', date: '2021-06-01', security_id: id, custom_id: id.toUpperCase(), stakeholder_id: 'bo',
    compensation_type: 'OPTION', option_grant_type: 'NSO', quantity: '48000', exercise_price: usd('0.25'), expiration_date: '2031-06-01', security_law_exemptions: [],
    termination_exercise_windows: [{ reason: 'VOLUNTARY_OTHER', period: 100, period_type: 'DAYS' }], ...extra,
  });
  const { review, body } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly'), person('bo', 'Bo Kestrel')],
    classes: [commonClass],
    plans: [
      { id: 'plan-x', object_type: 'STOCK_PLAN', plan_name: 'Broken Plan', initial_shares_reserved: '100000', stock_class_ids: ['cls-missing'] },
      { id: 'plan-1', object_type: 'STOCK_PLAN', plan_name: '2021 Plan', initial_shares_reserved: '500000', stock_class_ids: ['cls-common'], default_cancellation_behavior: 'RETURN_TO_POOL' },
    ],
    tx: [
      option('opt-1', { stock_plan_id: 'plan-x' }),                                  // 1: waits for the plan
      option('opt-2', { stock_plan_id: 'plan-1', option_grant_type: undefined }),     // 2: an option, ISO or NSO not said
      option('opt-3', {}),                                                            // 3: no plan
      { id: 'ex-2', object_type: 'TX_EQUITY_COMPENSATION_EXERCISE', date: '2023-01-01', security_id: 'opt-2', quantity: '1000', resulting_security_ids: ['cs-ex'] },
      stock('cs-ex', 'bo', '1000', '2023-01-01', { share_price: usd('0.25') }),
      { id: 'w-1.issue', object_type: 'TX_WARRANT_ISSUANCE', date: '2021-07-01', security_id: 'w-1', custom_id: 'W-1', stakeholder_id: 'ana', quantity: '10000', exercise_price: usd('0.50'),
        purchase_price: usd('0.00'), security_law_exemptions: [], exercise_triggers: [{ type: 'ELECTIVE_AT_WILL', trigger_id: 'go', conversion_right: { type: 'WARRANT_CONVERSION_RIGHT', converts_to_stock_class_id: 'cls-common',
          conversion_mechanism: { type: 'FIXED_AMOUNT_CONVERSION', converts_to_quantity: '10000' } } }] },
      { id: 'wx-1', object_type: 'TX_WARRANT_EXERCISE', date: '2022-01-01', security_id: 'w-1', trigger_id: 'go', resulting_security_ids: ['cs-w'] },
      stock('cs-w', 'ana', '3000', '2022-01-01', { share_price: usd('0.50') }),
      { id: 'wc-1', object_type: 'TX_WARRANT_CANCELLATION', date: '2022-06-01', security_id: 'w-1', quantity: '2000', reason_text: 'Part surrendered' },
    ],
  }), { skipRowsWithErrors: true });
  assert.deepEqual([rowOf(review, 'plans', 1).outcome, codesOf(rowOf(review, 'plans', 1))], ['error', ['ocf-unknown-reference']]);
  assert.deepEqual([rowOf(review, 'grants', 1).outcome, rowOf(review, 'grants', 1).messages[0].text], ['error', 'Waits for item 1 (Broken Plan)']);
  assert.deepEqual([rowOf(review, 'grants', 2).status, codesOf(rowOf(review, 'grants', 2))], ['warning', ['ocf-option-type-assumed', 'ptep-assumed']]);
  assert.equal(rowOf(review, 'grants', 2).messages[1].text, 'The exercise window of 100 days is recorded as 3 months');
  assert.deepEqual([rowOf(review, 'grants', 3).status, codesOf(rowOf(review, 'grants', 3))], ['warning', ['ocf-planless-grant', 'ptep-assumed']]);
  assert.deepEqual(codesOf(rowOf(review, 'events', 9)), ['ocf-folded'], 'a partial cancellation of a warrant is a correction of its count');
  const done = await commit(cid, body, review.reviewToken);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const awards = await all<{ label: string; type: string; pool: string; exercised_quantity: number; ptep_months: number }>(
    'SELECT a.label, a.type, p.name AS pool, a.exercised_quantity, a.ptep_months FROM awards a JOIN pools p ON p.id = a.pool_id WHERE a.company_id = ? ORDER BY a.label', cid);
  assert.deepEqual(awards.map((a) => [a.label, a.type, a.pool, a.exercised_quantity, a.ptep_months]), [['OPT-2', 'NSO', '2021 Plan', 1000, 3], ['OPT-3', 'NSO', 'Grants outside a plan', 0, 3]]);
  assert.deepEqual((await one<{ authorized: number }>("SELECT authorized FROM pools WHERE company_id = ? AND name = 'Grants outside a plan'", cid))?.authorized, 48_000);
  const exercise = await one<{ quantity: number; issuance_id: string; shares_issued: number }>('SELECT * FROM exercises WHERE company_id = ?', cid);
  assert.equal((await one<{ certificate_no: string; source_award_id: string }>('SELECT * FROM issuances WHERE id = ?', exercise!.issuance_id))?.certificate_no, 'CS-EX');
  const warrant = await one<{ quantity: number; exercised_quantity: number; status: string }>('SELECT * FROM warrants WHERE company_id = ?', cid);
  assert.deepEqual([warrant?.quantity, warrant?.exercised_quantity, warrant?.status], [8_000, 3_000, 'OUTSTANDING']);
  assert.deepEqual(await all('SELECT type, quantity, field FROM transactions WHERE company_id = ? AND security_id = (SELECT id FROM warrants WHERE company_id = ?) ORDER BY date', cid, cid),
    [{ type: 'ISSUANCE', quantity: 10_000, field: null }, { type: 'EXERCISE', quantity: 3_000, field: null }, { type: 'CORRECTION', quantity: -2_000, field: 'quantity' }]);
  invalidate(cid);
  const data = await getCompanyData(cid);
  assert.deepEqual([capTable(data, '2021-12-31')['Ana Brightly | warrantsOutstanding'], capTable(data, '2022-01-01')['Ana Brightly | warrantsOutstanding'], capTable(data, '2022-06-01')['Ana Brightly | warrantsOutstanding']], [10_000, 7_000, 5_000]);
});

test('people: one the package cannot tell apart is asked about, guessed relationships are asked too, and the answers take', async () => {
  const cid = await company('People Co');
  for (const email of [null, 'robin.v@mail.example']) await must('POST', `/api/c/${cid}/stakeholders`, { name: 'Robin Vale', relation: 'ADVISOR', ...(email ? { email } : {}) });
  const onFile = await all<{ id: string; email: string | null }>("SELECT id, email FROM stakeholders WHERE company_id = ? ORDER BY email NULLS FIRST", cid);
  const pkg = pkgOf({
    stakeholders: [
      { id: 'robin', object_type: 'STAKEHOLDER', name: { legal_name: 'Robin Vale' }, stakeholder_type: 'INDIVIDUAL', current_relationship: 'ADVISOR' },
      { id: 'fund', object_type: 'STAKEHOLDER', name: { legal_name: 'Lowfield Ventures LP' }, stakeholder_type: 'INSTITUTION', contact_info: { emails: [{ email_type: 'BUSINESS', email_address: 'deals@lowfield.example' }] } },
    ],
    classes: [commonClass],
    tx: [stock('cs-1', 'robin', '1000', '2021-02-01')],
  });
  const { review } = await check(cid, pkg);
  const robin = rowOf(review, 'stakeholders', 1);
  assert.deepEqual([robin.outcome, robin.messages[0].code, robin.messages[0].choices], ['error', 'ambiguous-person', ['robin.v@mail.example']]);
  assert.deepEqual(robin.messages[0].people.map((p: any) => p.id).sort(), onFile.map((p) => p.id).sort());
  assert.equal(rowOf(review, 'captable', 1).messages[0].code, 'ocf-depends');
  const fund = review.newPeople.find((p: any) => p.ocfId === 'fund');
  assert.deepEqual([fund.guessed, fund.relation, fund.type, fund.key], [true, 'INVESTOR', 'ENTITY', 'deals@lowfield.example']);

  const { review: answered, body } = await check(cid, pkg, { ocfPeople: { robin: onFile[0].id }, relationships: { 'deals@lowfield.example': 'OTHER' } });
  assert.deepEqual([rowOf(answered, 'stakeholders', 1).outcome, rowOf(answered, 'captable', 1).outcome], ['existing', 'add']);
  assert.equal(answered.newPeople.find((p: any) => p.ocfId === 'fund').guessed, false);
  assert.equal((await commit(cid, body, answered.reviewToken)).status, 200);
  assert.equal((await one<{ stakeholder_id: string }>('SELECT stakeholder_id FROM issuances WHERE company_id = ?', cid))?.stakeholder_id, onFile[0].id);
  assert.equal((await one<{ relation: string }>("SELECT relation FROM stakeholders WHERE company_id = ? AND email = 'deals@lowfield.example'", cid))?.relation, 'OTHER');
});

test('vesting terms: the usual shape is the schedule on file, other single paths are read per security, two paths are refused', async () => {
  const cid = await company('Vesting Co');
  const std = {   // A four-year, one-year-cliff, monthly schedule, as another tool would write it.
    id: 'four-one', object_type: 'VESTING_TERMS', name: 'Standard 4/1', description: '25% after a year, then monthly', allocation_type: 'CUMULATIVE_ROUNDING',
    vesting_conditions: [
      { id: 'vs', trigger: { type: 'VESTING_START_DATE' }, quantity: '0', next_condition_ids: ['cliff'] },
      { id: 'cliff', trigger: { type: 'VESTING_SCHEDULE_RELATIVE', relative_to_condition_id: 'vs', period: { type: 'MONTHS', length: 12, occurrences: 1, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' } }, portion: { numerator: '1', denominator: '4' }, next_condition_ids: ['monthly'] },
      { id: 'monthly', trigger: { type: 'VESTING_SCHEDULE_RELATIVE', relative_to_condition_id: 'cliff', period: { type: 'MONTHS', length: 1, occurrences: 36, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' } }, portion: { numerator: '1', denominator: '48' }, next_condition_ids: [] },
    ],
  };
  const odd = { id: 'odd', object_type: 'VESTING_TERMS', name: 'Half and half', description: '', allocation_type: 'CUMULATIVE_ROUND_DOWN', vesting_conditions: [
    { id: 's', trigger: { type: 'VESTING_START_DATE' }, quantity: '0', next_condition_ids: ['a'] },
    { id: 'a', trigger: { type: 'VESTING_SCHEDULE_RELATIVE', relative_to_condition_id: 's', period: { type: 'MONTHS', length: 6, occurrences: 1, day_of_month: '01' } }, portion: { numerator: '1', denominator: '2' }, next_condition_ids: ['b'] },
    { id: 'b', trigger: { type: 'VESTING_SCHEDULE_RELATIVE', relative_to_condition_id: 'a', period: { type: 'DAYS', length: 30, occurrences: 1 } }, portion: { numerator: '1', denominator: '1', remainder: true }, next_condition_ids: [] },
  ] };
  const fork = { id: 'fork', object_type: 'VESTING_TERMS', name: 'Either way', description: '', allocation_type: 'CUMULATIVE_ROUND_DOWN', vesting_conditions: [
    { id: 's', trigger: { type: 'VESTING_START_DATE' }, quantity: '0', next_condition_ids: ['a', 'b'] },
    { id: 'a', trigger: { type: 'VESTING_EVENT' }, portion: { numerator: '1', denominator: '1' }, next_condition_ids: [] },
    { id: 'b', trigger: { type: 'VESTING_EVENT' }, portion: { numerator: '1', denominator: '1' }, next_condition_ids: [] },
  ] };
  const { review, body } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], terms: [std, odd, fork],
    tx: [
      stock('cs-1', 'ana', '4800', '2021-01-01', { vesting_terms_id: 'four-one' }),
      stock('cs-2', 'ana', '1000', '2021-01-15', { vesting_terms_id: 'odd' }),
      stock('cs-3', 'ana', '100', '2021-01-01', { vesting_terms_id: 'fork' }),
    ],
  }), { skipRowsWithErrors: true });
  assert.deepEqual([rowOf(review, 'vesting', 1).outcome, rowOf(review, 'vesting', 1).summary.reading, rowOf(review, 'vesting', 1).messages[0].text],
    ['existing', '48 months, 12-month cliff, then monthly', 'Already on the cap table as "4 years, 1 year cliff, monthly"']);
  assert.deepEqual([rowOf(review, 'vesting', 2).outcome, codesOf(rowOf(review, 'vesting', 2))], ['skip', ['ocf-vesting-per-security']]);
  assert.deepEqual([rowOf(review, 'vesting', 3).outcome, codesOf(rowOf(review, 'vesting', 3))], ['error', ['ocf-unsupported']]);
  assert.deepEqual([rowOf(review, 'captable', 3).outcome, rowOf(review, 'captable', 3).messages[0].text], ['error', 'Waits for item 3 (Either way)']);
  assert.equal((await commit(cid, body, review.reviewToken)).status, 200);
  const certs = await all<{ certificate_no: string; name: string; kind: string; custom_tranches: string | null }>(
    'SELECT i.certificate_no, v.name, v.kind, v.custom_tranches FROM issuances i JOIN vesting_schedules v ON v.id = i.vesting_schedule_id WHERE i.company_id = ? ORDER BY i.certificate_no', cid);
  assert.deepEqual(certs.map((c) => [c.certificate_no, c.name, c.kind]), [['CS-1', '4 years, 1 year cliff, monthly', 'TIME'], ['CS-2', 'Half and half — CS-2', 'CUSTOM']]);
  // Portions of the certificate, so a split or a transfer of some of it later still vests the right part (finding RT-3).
  assert.deepEqual(JSON.parse(certs[1].custom_tranches!), [{ date: '2021-07-01', portion: 0.5 }, { date: '2021-07-31', portion: 0.5 }]);
});

test('a class over its authorized shares is offered the raise; the token covers every answer and the cap table as checked', async () => {
  const cid = await company('Raise Co');
  const small = { ...commonClass, name: 'Ordinary', initial_shares_authorized: '1000' };
  const pkg = pkgOf({ stakeholders: [person('ana', 'Ana Brightly')], classes: [small], tx: [stock('cs-1', 'ana', '5000', '2021-02-01')] });
  const { review, body } = await check(cid, pkg);
  const notice = review.notices.find((n: any) => n.code === 'over-authorized');
  assert.deepEqual(notice.fix, { option: 'raiseAuthorized', value: 'Ordinary', shareClassId: null, className: 'Ordinary', to: 5000 });
  // An answer given after the check: the commit is refused until it is checked.
  const raised = { ...body, options: { raiseAuthorized: ['Ordinary'] } };
  assert.deepEqual([(await commit(cid, raised, review.reviewToken)).json.detail.code], ['not-reviewed']);
  const left = { ...body, ocf: { ...body.ocf, exclude: { captable: [1] } } };
  assert.equal((await commit(cid, left, review.reviewToken)).json.detail.code, 'not-reviewed');
  const checked = (await preview(cid, raised)).json;
  assert.deepEqual(checked.raised.map((r: any) => [r.name, r.from, r.to]), [['Ordinary', 1000, 5000]]);
  // The cap table changes between the check and the import: refused, nothing written.
  const holder = (await must('POST', `/api/c/${cid}/stakeholders`, { name: 'Cass Dunmore', relation: 'FOUNDER', email: 'ana@tidewater.example' })).json.id;
  void holder;
  const stale = await commit(cid, raised, checked.reviewToken);
  assert.deepEqual([stale.status, stale.json.detail.code], [409, 'stale-review']);
  assert.equal((await all('SELECT id FROM issuances WHERE company_id = ?', cid)).length, 0);
});

test('the commit: a blocked package writes nothing, a sample company may check but not import', async () => {
  const cid = await company('Blocked Co');
  const pkg = pkgOf({ stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], tx: [stock('cs-1', 'ana', '5000', '2021-02-01'), stock('cs-2', 'ghost', '1', '2021-02-01')] });
  const { review, body } = await check(cid, pkg);
  assert.equal(review.counts.errors, 1);
  const refused = await commit(cid, body, review.reviewToken);
  assert.deepEqual([refused.status, refused.json.detail.code], [400, 'rows-need-fixing']);
  assert.match(refused.json.error, /^"Certificates" has 1 item with errors\. Fix them or choose to skip rows with errors — nothing was imported\.$/);
  for (const table of ['stakeholders', 'issuances', 'transactions', 'imports']) {
    const n = (await all(`SELECT id FROM ${table} WHERE company_id = ?`, cid)).length;
    assert.equal(n, table === 'transactions' ? 0 : table === 'stakeholders' ? 0 : 0, table);
  }

  const { createSampleCompany } = await import('../src/sample.ts');
  const sample = await createSampleCompany('ines@example.com', 'Ines Halvorsen');
  const p = await parse(sample, 'tidewater.ocf.zip', zipOf(pkgOf({ stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], tx: [stock('cs-1', 'ana', '5000', '2021-02-01')] })));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const checked = await preview(sample, bodyOf(p.json));
  assert.equal(checked.status, 200);
  assert.equal((await commit(sample, bodyOf(p.json), checked.json.reviewToken)).status, 403);
});

test('signed out, a viewer: refused before the package is read', async () => {
  const cid = await company('Closed Co');
  const p = (await parse(cid, 'tidewater.ocf.zip', zipOf(tidewater()))).json;
  assert.equal((await call('POST', `/api/c/${cid}/imports/workbook/preview`, bodyOf(p), null)).status, 401);
  assert.equal((await parse(cid, 'tidewater.ocf.zip', zipOf(tidewater()), null)).status, 401);
});

test('the Marlowe sample company, exported and imported into an empty company, is the same cap table today and on every date before', async () => {
  const { createSampleCompany } = await import('../src/sample.ts');
  const sample = await createSampleCompany('sample-owner@example.com', 'Sample Owner');
  const pkg = await buildOcfPackage(sample, { asOf: today(), generatedAt: '2026-01-01T00:00:00.000Z' });
  const into = await company('Marlowe Systems', { legalName: 'Marlowe Systems, Inc.', incorporationDate: '2022-03-08' });
  const parsed = await parse(into, 'marlowe.ocf.zip', ocfZip(pkg));
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  const body = bodyOf(parsed.json);
  const r = await preview(into, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.counts.errors, 0, JSON.stringify(r.json.sheets.flatMap((s: any) => s.preview.rows.filter((x: any) => x.status === 'error'))));
  assert.equal((await commit(into, body, r.json.reviewToken)).status, 200);
  invalidate(sample); invalidate(into);
  const a = await getCompanyData(sample), b = await getCompanyData(into);
  const dates = new Set<string>([today(), addDays(today(), -1), '2022-12-31', '2023-12-31', '2024-06-30']);
  for (const t of await all<{ date: string }>('SELECT DISTINCT date FROM transactions WHERE company_id = ?', sample)) { dates.add(t.date); dates.add(addDays(t.date, -1)); }
  for (const d of [...dates].sort()) {
    assert.deepEqual(capTable(b, d), capTable(a, d), `cap table on ${d}`);
    assert.deepEqual(pools(b, d), pools(a, d), `plans on ${d}`);
  }
});

test('hostile shapes: odd ids, objects that are not objects, absurd ratios and long texts are each a row\'s problem, never the server\'s', async () => {
  const cid = await company('Hostile Co');
  const long = 'x'.repeat(10_000);
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('__proto__', 'Proto Person'), person('constructor', 'Constructor Person'), 42 as any, { object_type: 'STAKEHOLDER' }, person(long, `${'N'.repeat(5000)}`)],
    classes: [commonClass, { ...seriesSeed, conversion_rights: [{ type: 'STOCK_CLASS_CONVERSION_RIGHT', conversion_mechanism: { type: 'RATIO_CONVERSION', ratio: { numerator: '1e999', denominator: '1' } } }] }],
    tx: [
      stock('cs-1', '__proto__', '100', '2021-01-01'),
      stock('cs-2', 'constructor', '-5', '2021-01-01'),
      stock('cs-3', 'constructor', '1000', '2021-02-30'),
      { id: 'split-1', object_type: 'TX_STOCK_CLASS_SPLIT', date: '2022-01-01', stock_class_id: 'cls-common', split_ratio: { numerator: '1000000000', denominator: '1' } },
      'not an object' as any,
      { id: 'later', object_type: 'TX_STAKEHOLDER_RELATIONSHIP_CHANGE_EVENT', date: '2022-01-01', stakeholder_id: '__proto__' },
      { ...stock('cs-4', 'constructor', '10', '2021-01-01'), custom_id: long, comments: [long] },
    ],
  }));
  assert.equal(({} as any).polluted, undefined);
  const outcomes = review.sheets.flatMap((s: any) => s.preview.rows.map((r: any) => `${s.kind} ${r.row} ${r.outcome} ${r.messages.map((m: any) => m.code).join(',')}`));
  assert.ok(outcomes.includes('stakeholders 1 add stakeholder-created'), outcomes.join('\n'));
  assert.ok(outcomes.includes('stakeholders 3 error ocf-bad-object'), outcomes.join('\n'));
  assert.ok(outcomes.some((o: string) => o.startsWith('captable 1 ') && !o.includes('error')), 'an id named __proto__ is an id like any other');
  assert.ok(outcomes.some((o: string) => /^captable 2 error .*not-positive/.test(o)));
  assert.ok(outcomes.some((o: string) => /^captable 3 error .*bad-date/.test(o)));
  assert.ok(outcomes.some((o: string) => /^events 4 error .*ocf-bad-object/.test(o)), 'a billion-to-one split');
  assert.ok(outcomes.some((o: string) => /^events 5 error ocf-bad-object/.test(o)));
  assert.ok(outcomes.some((o: string) => /^events 6 skip ocf-not-imported/.test(o)), 'a transaction of a later OCF version');
  assert.ok(outcomes.some((o: string) => /^shareClasses 2 error ocf-bad-object/.test(o)));
  assert.ok(JSON.stringify(review).length < 2_000_000);
});

// ---------------------------------------------------------------------------
// Since the reviews: bounds, lookups, money, files and the company's own fields
// ---------------------------------------------------------------------------

const optionPlan = { id: 'plan-1', object_type: 'STOCK_PLAN', plan_name: '2021 Plan', initial_shares_reserved: '5000000', stock_class_ids: ['cls-common'] };
const option = (id: string, holder: string, quantity: string, date: string, extra: Record<string, unknown> = {}) => ({
  id: `${id}.issue`, object_type: 'TX_EQUITY_COMPENSATION_ISSUANCE', date, security_id: id, custom_id: id.toUpperCase(), stakeholder_id: holder,
  compensation_type: 'OPTION_NSO', quantity, exercise_price: usd('0.10'), expiration_date: '2031-01-01', stock_plan_id: 'plan-1',
  termination_exercise_windows: [{ reason: 'VOLUNTARY_OTHER', period: 3, period_type: 'MONTHS' }], security_law_exemptions: [], ...extra,
});
/** Terms of one start and conditions after it, chained. */
const chainTerms = (id: string, conditions: any[]) => ({
  id, object_type: 'VESTING_TERMS', name: id, description: '', allocation_type: 'CUMULATIVE_ROUND_DOWN',
  vesting_conditions: [{ id: 'start', trigger: { type: 'VESTING_START_DATE' }, quantity: '0', next_condition_ids: conditions.length ? [conditions[0].id] : [] },
    ...conditions.map((c, i) => ({ ...c, next_condition_ids: conditions[i + 1] ? [conditions[i + 1].id] : [] }))],
});
const days = (to: string, length: number, occurrences: number) => ({ type: 'VESTING_SCHEDULE_RELATIVE', relative_to_condition_id: to, period: { type: 'DAYS', length, occurrences } });
const months = (to: string, length: number, occurrences: number) => ({ type: 'VESTING_SCHEDULE_RELATIVE', relative_to_condition_id: to, period: { type: 'MONTHS', length, occurrences, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' } });

test('a few bytes of vesting terms cannot ask for millions of dates: refused on the row, or for the whole package, in moments (finding SEC-1)', async () => {
  const cid = await company('Vesting Bounds Co');
  // Thirty conditions of 10,000 days each: 300,000 dates for one grant.
  const many = chainTerms('many', Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, portion: { numerator: '1', denominator: '300000' }, trigger: days(i ? `c${i - 1}` : 'start', 1, 10_000) })));
  // A note claiming a daily schedule over a century, its digest worked out to match.
  const conditions = [{ id: 'start', trigger: { type: 'VESTING_START_DATE' }, portion: { numerator: '1', denominator: '1' }, next_condition_ids: [] }];
  const { termsDigest } = await import('../src/ocf/notes.ts');
  const century = { id: 'century', object_type: 'VESTING_TERMS', name: 'Century', description: '', allocation_type: 'CUMULATIVE_ROUND_DOWN', vesting_conditions: conditions,
    comments: [`kosmitor:1:${JSON.stringify({ schedule: { kind: 'TIME', durationMonths: 1200, cliffMonths: 0, frequency: 'DAILY', immediatePortion: 0 }, digest: termsDigest('CUMULATIVE_ROUND_DOWN', conditions) })}`] };
  const t0 = Date.now();
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], plans: [optionPlan], terms: [many, century],
    tx: [option('opt-1', 'ana', '1000', '2021-01-01', { vesting_terms_id: 'many' }), option('opt-2', 'ana', '1000', '2021-01-01', { vesting_terms_id: 'century' })],
  }));
  assert.ok(Date.now() - t0 < 5_000, `checked in ${Date.now() - t0} ms`);
  const first = rowOf(review, 'grants', 1);
  assert.deepEqual([first.outcome, codesOf(first).includes('ocf-unsupported')], ['error', true]);
  assert.match(first.messages.find((m: any) => m.code === 'ocf-unsupported').text, /vest on 300,001 dates; Kosmitor reads at most 20,000/);
  // The century is not a schedule a note may give (at most 50 years): the terms are read for what they say, fully vested.
  assert.deepEqual([rowOf(review, 'vesting', 2).summary.reading, rowOf(review, 'grants', 2).outcome], ['Fully vested at the vesting start', 'add']);

  // Per-security terms on many grants: past the package's budget, the whole package is refused.
  // 15,001 dates a grant, within what one security may have; 140 grants of different sizes are past the package's 2,000,000.
  const daily = chainTerms('daily', [{ id: 'd1', portion: { numerator: '1', denominator: '15000' }, trigger: days('start', 1, 10_000) }, { id: 'd2', portion: { numerator: '1', denominator: '15000' }, trigger: days('d1', 1, 5_000) }]);
  const grants = Array.from({ length: 140 }, (_, i) => option(`g-${i}`, 'ana', String(1000 + i), '2021-01-01', { vesting_terms_id: 'daily' }));
  const t1 = Date.now();
  const parsed = await parse(cid, 'budget.ocf.zip', zipOf(pkgOf({ stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], plans: [optionPlan], terms: [daily], tx: grants })));
  const r = await preview(cid, bodyOf(parsed.json));
  assert.deepEqual([r.status, r.json.detail?.code], [400, 'ocf-too-large']);
  assert.ok(Date.now() - t1 < 15_000, `refused in ${Date.now() - t1} ms`);
  // Nor can the API store a schedule that runs for centuries.
  const api = await call('POST', `/api/c/${cid}/vesting-schedules`, { name: 'Forever', kind: 'TIME', durationMonths: 1200, cliffMonths: 0, frequency: 'DAILY', immediatePortion: 0 });
  assert.deepEqual([api.status, api.json.error], [400, 'Vesting can run for at most 600 months (50 years).']);
});

test('dates a period would reach past 2200, and periods past 200 years, are refused on the row, never stored or thrown (finding SEC-4)', async () => {
  const cid = await company('Far Dates Co');
  const far = chainTerms('far', [{ id: 'm', portion: { numerator: '1', denominator: '1' }, trigger: months('start', 1_300_000, 1) }]);
  const huge = chainTerms('huge', [{ id: 'd', portion: { numerator: '1', denominator: '1' }, trigger: days('start', 1_000_000_000, 1) }]);
  const bad = chainTerms('bad', [{ id: 'a', portion: { numerator: '1', denominator: '1' }, trigger: { type: 'VESTING_SCHEDULE_ABSOLUTE', date: 'someday' } }]);
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], plans: [optionPlan], terms: [far, huge, bad],
    tx: [option('opt-1', 'ana', '900', '2023-01-01', { vesting_terms_id: 'far' }), option('opt-2', 'ana', '900', '2023-01-01', { vesting_terms_id: 'huge' }), option('opt-3', 'ana', '900', '2023-01-01', { vesting_terms_id: 'bad' })],
  }));
  for (const item of [1, 2, 3]) {
    const row = rowOf(review, 'grants', item);
    assert.equal(row.outcome, 'error', `grant ${item}`);
    const text = row.messages.find((m: any) => m.code === 'ocf-unsupported')?.text ?? '';
    assert.match(text, /Kosmitor cannot follow these terms$/, `grant ${item}: ${text}`);
    assert.doesNotMatch(text, /Invalid time value/);
  }
  assert.equal((await all('SELECT id FROM vesting_schedules WHERE company_id = ? AND custom_tranches IS NOT NULL', cid)).length, 0);
});

test('ids and types that are names of Object.prototype are ids and types like any other (finding SEC-3)', async () => {
  const cid = await company('Prototype Names Co');
  const events = chainTerms('events', [{ id: 'constructor', portion: { numerator: '1', denominator: '2' }, trigger: { type: 'VESTING_EVENT' } }, { id: 'toString', portion: { numerator: '1', denominator: '2' }, trigger: months('constructor', 1, 1) }]);
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], plans: [optionPlan], terms: [events],
    tx: [
      option('opt-1', 'ana', '1000', '2021-01-01', { vesting_terms_id: 'events' }),
      { id: 'ev-1', object_type: 'TX_VESTING_EVENT', date: '2021-06-01', security_id: 'opt-1', vesting_condition_id: 'constructor' },
      { id: 'odd-1', object_type: 'toString', date: '2021-06-01', security_id: 'odd-a' },
      { id: 'odd-2', object_type: 'constructor', date: '2021-06-01', security_id: 'odd-b' },
      { id: 'odd-3', object_type: 'hasOwnProperty', date: '2021-06-01' },
    ],
  }));
  assert.equal(rowOf(review, 'grants', 1).outcome, 'add', JSON.stringify(rowOf(review, 'grants', 1)));
  assert.equal(review.sheets.find((s: any) => s.kind === 'convertibles'), undefined, 'not read as SAFEs');
  assert.deepEqual([3, 4, 5].map((n) => rowOf(review, 'events', n)?.outcome), ['error', 'error', 'skip']);
  assert.equal(rowOf(review, 'events', 3).messages[0].code, 'ocf-unknown-reference');
});

test('amounts past what Kosmitor can record are the row\'s error, not a failed check (finding SEC-2)', async () => {
  const cid = await company('Big Money Co');
  const huge = { ...commonClass, initial_shares_authorized: '999999999999' };
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [huge],
    tx: [stock('cs-1', 'ana', '999999999999', '2021-01-01', { share_price: usd('9000000000.00') })],
  }));
  const row = rowOf(review, 'captable', 1);
  assert.deepEqual([row.outcome, codesOf(row)], ['error', ['bad-number']]);
});

test('a damaged .ocf.zip, JSON that is not UTF-8, and an entry that lies about its size: each refused with the right words (findings UX-2, UX-4, SEC-5)', async () => {
  const cid = await company('Damaged Files Co');
  const refused = async (name: string, body: Buffer) => { const r = await parse(cid, name, body); return [r.status, r.json.detail?.code, r.json.error]; };
  const whole = zipOf(tidewater());
  assert.deepEqual(await refused('cap-table.ocf.zip', whole.subarray(0, whole.length - 40)),
    [400, 'damaged', 'We couldn\'t open cap-table.ocf.zip — it may be damaged. Export the package again and drop it here.']);
  const latin1 = Buffer.from(JSON.stringify({ file_type: 'OCF_STAKEHOLDERS_FILE', items: [person('jp', 'José Pérez')] }), 'latin1');
  assert.deepEqual(await refused('Stakeholders.ocf.json', latin1), [400, 'not-utf8', 'Stakeholders.ocf.json is not UTF-8 text, which JSON must be. Export it again as UTF-8 and drop it here.']);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(tidewater().files[0].json), 'utf16le')]);
  assert.deepEqual((await refused('Manifest.ocf.json', utf16))[1], 'not-utf8');
  // A JSON entry declaring 100 bytes that unpacks to more than the JSON an import reads stops there, not at the larger unpacking limit.
  configure({ limits: { importJsonMb: 1, importUnzippedMb: 256 } });
  try {
    const big = zip([{ name: 'Manifest.ocf.json', data: json(tidewater().files[0].json) }, { name: 'Big.json', data: Buffer.from(`{"x":"${' '.repeat(3 * 1024 * 1024)}"}`) }]);
    // Say the entry is 100 bytes, in both headers.
    const lie = Buffer.from(big);
    for (let i = 0; i < lie.length - 4; i++) {
      const sig = lie.readUInt32LE(i);
      const at = sig === 0x04034b50 ? i + 22 : sig === 0x02014b50 ? i + 24 : -1;
      if (at > 0 && lie.readUInt32LE(at) > 1_000_000) lie.writeUInt32LE(100, at);
    }
    assert.deepEqual((await refused('lie.ocf.zip', lie)).slice(0, 2), [400, 'unzips-too-large']);
    const r = await parse(cid, 'lie.ocf.zip', lie);
    assert.equal(r.json.detail.limitMb, 1);
  } finally { resetConfig(); }
});

test('emails: only one plain address each, as the stakeholder form takes them (finding SEC-6); wording a person reads (finding UX-5)', async () => {
  const cid = await company('Email Checks Co');
  const { review } = await check(cid, pkgOf({
    stakeholders: [
      person('two', 'Two Addresses', { contact_info: { emails: [{ email_type: 'OTHER', email_address: 'a@b.example, c@d.example' }, { email_type: 'OTHER', email_address: 'second@ok.example' }] } }),
      person('space', 'Spaced Out', { contact_info: { emails: [{ email_type: 'OTHER', email_address: 'not an address' }] } }),
    ],
    classes: [commonClass], tx: [stock('cs-1', 'ghost', '100', '2021-01-01')],
  }));
  const two = rowOf(review, 'stakeholders', 1);
  assert.equal(two.summary.email, 'second@ok.example');
  assert.match(two.messages.find((m: any) => m.code === 'ocf-bad-object').text, /^"a@b.example, c@d.example" is not one plain email address, so it is left out$/);
  assert.equal(rowOf(review, 'stakeholders', 2).summary.email, null);
  assert.equal(rowOf(review, 'captable', 1).messages.find((m: any) => m.code === 'ocf-unknown-reference').text, 'Names a stakeholder (ghost) that is not in the package');
});

test('a package blocked by one row reports nothing ready: it goes in whole or not at all (finding UX-3)', async () => {
  const cid = await company('Whole Or Nothing Co');
  const { review } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass],
    tx: [stock('cs-1', 'ana', '100', '2021-01-01'), stock('cs-2', 'ghost', '100', '2021-01-01')],
  }));
  assert.ok(review.sheets.some((s: any) => s.blocked));
  assert.equal(review.counts.willImport, 0);
  assert.ok(review.sheets.find((s: any) => s.kind === 'stakeholders').preview.counts.willImport > 0, 'each section still says what it holds');
});

test('the company\'s own fields: a new company\'s defaults are filled in from the issuer; another company\'s only when asked (findings RT-6, UX-1)', async () => {
  // Created to import into: incorporation date today and the default jurisdiction, as the create route sets them.
  const fresh = (await must('POST', '/api/companies', { name: 'Tidewater Looms' })).json.id as string;
  const pkg = pkgOf({ stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], tx: [stock('cs-1', 'ana', '100', '2021-01-01')] },
    { country_subdivision_of_formation: 'CA', tax_ids: [{ tax_id: '00-0000002', country: 'US' }], address: { address_type: 'LEGAL', street_suite: '4 Example Pier', country: 'US' } });
  const { review, body } = await check(fresh, pkg);
  // Its legal name, "Tidewater Looms, Inc.", is already the issuer's.
  assert.deepEqual(review.ocf.companyFill, [
    { field: 'incorporation date', value: '2020-01-02' }, { field: 'jurisdiction', value: 'California' },
    { field: 'EIN', value: '00-0000002' }, { field: 'address', value: '4 Example Pier' },
  ]);
  assert.deepEqual([review.ocf.companyFillAsked, review.ocf.companyFillApplied], [false, true]);
  assert.equal((await commit(fresh, body, review.reviewToken)).status, 200);
  const row = await one<Record<string, unknown>>('SELECT legal_name, incorporation_date, jurisdiction, ein, address FROM companies WHERE id = ?', fresh);
  assert.deepEqual(row, { legal_name: 'Tidewater Looms, Inc.', incorporation_date: '2020-01-02', jurisdiction: 'California', ein: '00-0000002', address: '4 Example Pier' });
  const audit = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE company_id = ? AND action = 'IMPORT'", fresh);
  assert.match(audit!.detail, /company's incorporation date, jurisdiction, EIN and address filled in/);

  // Another company's package: nothing of the issuer's is copied unless the person says so.
  const other = (await must('POST', '/api/companies', { name: 'Quayside Mills' })).json.id as string;
  const asked = await check(other, pkg);
  assert.deepEqual([asked.review.ocf.companyFillAsked, asked.review.ocf.companyFillApplied], [true, false]);
  assert.ok(asked.review.ocf.notices.some((n: any) => n.code === 'ocf-other-issuer'));
  assert.equal((await commit(other, asked.body, asked.review.reviewToken)).status, 200);
  assert.equal((await one<{ ein: string | null }>('SELECT ein FROM companies WHERE id = ?', other))?.ein, null);
  const yes = (await must('POST', '/api/companies', { name: 'Harbour Mills' })).json.id as string;
  const said = await check(yes, pkg, { ocfCompanyFill: true });
  assert.deepEqual([said.review.ocf.companyFillAsked, said.review.ocf.companyFillApplied], [true, true]);
  assert.equal((await commit(yes, said.body, said.review.reviewToken)).status, 200);
  assert.equal((await one<{ ein: string | null }>('SELECT ein FROM companies WHERE id = ?', yes))?.ein, '00-0000002');
});

test('per-security vesting is a part of the security, so a later split, reverse or forward, still vests all of it (finding RT-3)', async () => {
  const cid = await company('Odd Shapes Co');
  // 30% at a year, then 7% a month: no Kosmitor schedule has this shape.
  const odd = chainTerms('odd', [{ id: 'y', portion: { numerator: '3', denominator: '10' }, trigger: months('start', 12, 1) }, { id: 'm', portion: { numerator: '7', denominator: '100' }, trigger: months('y', 1, 10) }]);
  const { review, body } = await check(cid, pkgOf({
    stakeholders: [person('ana', 'Ana Brightly')], classes: [commonClass], plans: [optionPlan], terms: [odd],
    tx: [
      option('opt-1', 'ana', '30001', '2021-01-01', { vesting_terms_id: 'odd' }),
      { id: 'split-1', object_type: 'TX_STOCK_CLASS_SPLIT', date: '2023-01-01', stock_class_id: 'cls-common', split_ratio: { numerator: '1', denominator: '2' } },
    ],
  }));
  assert.equal(review.counts.errors, 0, JSON.stringify(review.sheets.map((s: any) => s.preview.rows)));
  assert.equal((await commit(cid, body, review.reviewToken)).status, 200);
  const tranches = JSON.parse((await one<{ custom_tranches: string }>("SELECT v.custom_tranches FROM vesting_schedules v JOIN awards a ON a.vesting_schedule_id = v.id WHERE a.company_id = ?", cid))!.custom_tranches);
  assert.ok(tranches.every((t: any) => t.portion != null && t.quantity == null), JSON.stringify(tranches));
  // A forward split after it too, through the route: the cap table works out, and all of the grant vests.
  await must('POST', `/api/c/${cid}/stock-splits`, { date: '2024-01-01', ratio: 3 });
  invalidate(cid);
  const ana = computeCapTable(await getCompanyData(cid), { asOf: today() }).rows.find((r) => r.name === 'Ana Brightly')!;
  assert.equal(ana.optionsOutstanding, roundShares(30001 * 0.5 * 3));
  assert.equal(ana.optionsVested, ana.optionsOutstanding, 'fully vested, all of it');
  // Before the forward split, after the reverse one: half the options, 30% of them vested at the year.
  const mid = computeCapTable(await getCompanyData(cid), { asOf: '2023-06-01' }).rows.find((r) => r.name === 'Ana Brightly')!;
  assert.equal(mid.optionsOutstanding, roundShares(30001 * 0.5));
});

test('people a name cannot tell apart are told apart by what an earlier import gave them (finding RT-11)', async () => {
  const cid = await company('Namesakes Co');
  const twins = [person('t1', 'Robin Vale', { contact_info: undefined }), person('t2', 'Robin Vale', { contact_info: undefined })];
  const pkg = pkgOf({ stakeholders: twins, classes: [commonClass], tx: [stock('cs-1', 't1', '100', '2021-01-01'), stock('cs-2', 't2', '200', '2021-01-01')] });
  const first = await check(cid, pkg);
  assert.equal((await commit(cid, first.body, first.review.reviewToken)).status, 200);
  // The same package again, into the same company: both Robins are found, with no question asked.
  const again = await check(cid, pkg);
  assert.deepEqual(again.review.sheets.flatMap((s: any) => s.preview.rows.map((r: any) => r.outcome)), ['existing', 'existing', 'existing', 'existing', 'existing']);
  assert.equal(again.review.counts.willImport, 0);
});

test('a lapse the package notes is not entered twice when the holder\'s leaving date comes with it, and is entered when it does not (finding F2)', async () => {
  const cid = await company('Leavers Co');
  const lapse = (id: string, date: string, quantity: string, what: string) => ({
    id, object_type: 'TX_EQUITY_COMPENSATION_CANCELLATION', date, security_id: 'opt-1', quantity, reason_text: 'Unvested when they left',
    comments: [`kosmitor:1:${JSON.stringify({ type: 'FORFEITURE', lapse: what })}`],
  });
  const left = person('lee', 'Lee Ostrow', { comments: ['kosmitor:1:{"terminationDate":"2022-06-30"}'] });
  const stayed = person('kai', 'Kai Ostrow');
  const { review, body } = await check(cid, pkgOf({
    stakeholders: [left, stayed], classes: [commonClass], plans: [optionPlan],
    tx: [option('opt-1', 'lee', '4800', '2021-01-01'), lapse('l-1', '2022-06-30', '1200', 'termination'),
      { ...option('opt-2', 'kai', '4800', '2021-01-01') }, { ...lapse('l-2', '2022-06-30', '1200', 'termination'), security_id: 'opt-2' }],
  }));
  assert.deepEqual([rowOf(review, 'events', 2).outcome, rowOf(review, 'events', 2).messages[0].code], ['skip', 'ocf-folded']);
  assert.equal(rowOf(review, 'events', 4).outcome, 'add', 'Kai has no leaving date: the cancellation is entered');
  assert.equal((await commit(cid, body, review.reviewToken)).status, 200);
  assert.deepEqual((await all<{ type: string; quantity: number }>("SELECT type, quantity FROM transactions WHERE company_id = ? AND type = 'FORFEITURE'", cid)).map((x) => x.quantity), [1200]);
});
