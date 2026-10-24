/**
 * The Open Cap Format export (src/ocf/export.ts, GET /api/c/:cid/captable/export.ocf.zip).
 *
 * An invented company, Brightwater Kinetics, is built through the routes with a bit of
 * everything: founders' restricted stock, a preferred round with capped participation
 * and a legend, a SAFE that converts, an MFN election, a note repaid and a KISS
 * cancelled, options exercised, cancelled and expired, an RSU, a SAR, a phantom unit,
 * a growth share, a restricted stock award, warrants exercised, cancelled and expired,
 * partial and full transfers (one onward from a transferee), repurchases and
 * cancellations, a 2:1 split between them, a plan increase, 409A and other
 * valuations, every vesting kind, board seats, every stakeholder type and relation,
 * and a grant awaiting signature.
 *
 * Pinned here: every file of the package validates against the vendored OCF 1.2.0
 * schemas; every reference resolves and every security is issued once; balances add
 * up; an OCF reader replaying the transactions gets the cap table Kosmitor computes,
 * holder by holder and class by class, on every date something happened and the day
 * before; two exports differ only in their timestamps and checksums; the certificate
 * each transfer, exercise and conversion created is found with or without
 * resulting_security_id; and the route is audited, open to a viewer, closed to a
 * portfolio-only member and to anyone signed out. The Marlowe sample company and an
 * empty company export valid packages too. Every name and number is invented.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { computeCapTable, addDays, today, roundShares, normalizeSplits, PENDING_AWARD, type CompanyData } from '@kosmitor/core';
import { freshDatabase, sessionCookie, insertSecurity } from './helpers.ts';
import { validateOcf } from './ocf-validate.ts';
import { buildBrightwater } from './ocf-company.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/captable-export.ts');
const { insert, one, all, run } = await import('../src/db.ts');
const { getCompanyData, invalidate } = await import('../src/store.ts');
const { buildOcfPackage } = await import('../src/ocf/export.ts');
const { readNote } = await import('../src/ocf/notes.ts');
const { readZip } = await import('../src/import/xlsx.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (res.status >= 400 && method !== 'GET') throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, json, token: sessionCookie(res) };
}
async function download(path: string, token: string | null) {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, type: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition') ?? '', body: Buffer.from(await res.arrayBuffer()) };
}

// ---------------------------------------------------------------------------
// Brightwater Kinetics, built the way a person would, through the routes (ocf-company.ts)
// ---------------------------------------------------------------------------

const admin = (await call('POST', '/api/auth/register', { email: 'ines@example.com', name: 'Ines Halvorsen', password: 'ines-pass-1' })).token as string;
const {
  cid, common, seriesA, plan, fenwick, cs1, cs2, cs3, cs4, opt1, opt2, opt8, rsu2, rsa1, rsa2, unnumbered, w1, w2, w3, w4, safe1, safe2, safe3, note1, kiss1, tr1,
} = await buildBrightwater(call, admin);

const exportNow = (generatedAt = '2026-01-01T00:00:00.000Z', company = cid) => buildOcfPackage(company, { asOf: today(), generatedAt });
const fileOf = (pkg: { files: { path: string; json: any }[] }, type: string) => pkg.files.find((f) => f.json.file_type === type)!.json;
const itemsOf = (pkg: { files: { path: string; json: any }[] }, type: string) => fileOf(pkg, type).items as any[];

// ---------------------------------------------------------------------------
// An OCF reader, written from the OCF documents rather than from export.ts
// ---------------------------------------------------------------------------

interface Position { shares: Map<string, number>; options: Map<string, number>; rsus: Map<string, number>; warrants: Map<string, number> }

/** The cap table an OCF reader gets from the package on `asOf`: holder | class shares, and each holder's options, RSUs and warrants. */
function replay(pkg: { files: { path: string; json: any }[] }, asOf: string): Position {
  const people = new Map(itemsOf(pkg, 'OCF_STAKEHOLDERS_FILE').map((s) => [s.id, readNote(s, 'STAKEHOLDER').name ?? s.name.legal_name]));
  const classes = new Map(itemsOf(pkg, 'OCF_STOCK_CLASSES_FILE').map((c) => [c.id, c.name]));
  const tx = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE');
  const splits = tx.filter((t) => t.object_type === 'TX_STOCK_CLASS_SPLIT');
  const k = (classId: string | undefined, from: string, to: string) => splits.filter((s) => (!classId || s.stock_class_id === classId) && s.date > from && s.date <= to)
    .reduce((f, s) => f * Number(s.split_ratio.numerator) / Number(s.split_ratio.denominator), 1);
  const anyClass = [...classes.keys()][0];
  const on = (security: string, types: string[]) => tx.filter((t) => t.security_id === security && types.includes(t.object_type) && t.date <= asOf);
  const add = (m: Map<string, number>, key: string, n: number) => { if (Math.abs(n) > 1e-9) m.set(key, roundShares((m.get(key) ?? 0) + n)); };
  const out: Position = { shares: new Map(), options: new Map(), rsus: new Map(), warrants: new Map() };
  for (const t of tx) {
    if (t.date > asOf) continue;
    if (t.object_type === 'TX_STOCK_ISSUANCE') {
      if (on(t.security_id, ['TX_STOCK_TRANSFER', 'TX_STOCK_REPURCHASE', 'TX_STOCK_CANCELLATION', 'TX_STOCK_CONVERSION']).length) continue;
      add(out.shares, `${people.get(t.stakeholder_id)} | ${classes.get(t.stock_class_id)}`, Number(t.quantity) * k(t.stock_class_id, t.date, asOf));
    } else if (t.object_type === 'TX_EQUITY_COMPENSATION_ISSUANCE') {
      if (t.expiration_date && t.expiration_date < asOf) continue;
      const cls = t.stock_class_id ?? anyClass;
      const used = on(t.security_id, ['TX_EQUITY_COMPENSATION_EXERCISE', 'TX_EQUITY_COMPENSATION_RELEASE', 'TX_EQUITY_COMPENSATION_CANCELLATION'])
        .reduce((s, e) => s + Number(e.quantity) * k(cls, e.date, asOf), 0);
      add(t.compensation_type === 'RSU' ? out.rsus : out.options, people.get(t.stakeholder_id)!, Number(t.quantity) * k(cls, t.date, asOf) - used);
    } else if (t.object_type === 'TX_WARRANT_ISSUANCE') {
      if (t.warrant_expiration_date && t.warrant_expiration_date < asOf) continue;
      const cls = t.exercise_triggers[0].conversion_right.converts_to_stock_class_id;
      const used = on(t.security_id, ['TX_WARRANT_EXERCISE', 'TX_WARRANT_CANCELLATION'])
        .reduce((s, e) => s + (e.object_type === 'TX_WARRANT_EXERCISE' ? readNote(e, 'TX_WARRANT_EXERCISE').quantity! : Number(e.quantity)) * k(cls, e.date, asOf), 0);
      add(out.warrants, people.get(t.stakeholder_id)!, Number(t.quantity) * k(cls, t.date, asOf) - used);
    }
  }
  return out;
}

/**
 * The same figures as Kosmitor computes them, and the one difference the manifest states: a restricted stock
 * award with no certificate is issued stock in the package, which Kosmitor counts only once a certificate is
 * issued (finding F1).
 */
function kosmitor(data: CompanyData, asOf: string): Position {
  const table = computeCapTable(data, { asOf });
  const out: Position = { shares: new Map(), options: new Map(), rsus: new Map(), warrants: new Map() };
  const then = normalizeSplits(data, asOf);
  for (const a of then.awards) {
    if (a.type !== 'RSA' || a.grantDate > asOf || PENDING_AWARD.has(a.status) || then.issuances.some((i) => i.sourceAwardId === a.id)) continue;
    const left = roundShares(a.quantity - a.cancelledQuantity);
    const holder = then.stakeholders.find((s) => s.id === a.stakeholderId)!.name;
    const cls = then.shareClasses.find((c) => c.id === then.pools.find((p) => p.id === a.poolId)!.shareClassId)!.name;
    if (left > 0) out.shares.set(`${holder} | ${cls}`, roundShares((out.shares.get(`${holder} | ${cls}`) ?? 0) + left));
  }
  for (const r of table.rows) {
    for (const h of r.holdings) if (h.shares) out.shares.set(`${r.name} | ${h.className}`, roundShares((out.shares.get(`${r.name} | ${h.className}`) ?? 0) + h.shares));
    if (r.optionsOutstanding) out.options.set(r.name, roundShares(r.optionsOutstanding));
    if (r.rsusOutstanding) out.rsus.set(r.name, roundShares(r.rsusOutstanding));
    if (r.warrantsOutstanding) out.warrants.set(r.name, roundShares(r.warrantsOutstanding));
  }
  return out;
}
const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

/** Every date something happened in the package, the day before each, yesterday and today. */
function datesOf(pkg: { files: { path: string; json: any }[] }): string[] {
  const dates = new Set<string>([today(), addDays(today(), -1)]);
  for (const t of itemsOf(pkg, 'OCF_TRANSACTIONS_FILE')) { dates.add(t.date); dates.add(addDays(t.date, -1)); }
  return [...dates].sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the download is a zip of the manifest and seven files, each with the checksum the manifest gives it, all valid OCF 1.2.0', async () => {
  const r = await download(`/api/c/${cid}/captable/export.ocf.zip`, admin);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/zip');
  assert.equal(r.disposition, `attachment; filename="cap-table-${today()}.ocf.zip"`);
  const entries = readZip(r.body);
  assert.deepEqual([...entries.keys()].sort(), ['Manifest.ocf.json', 'Stakeholders.ocf.json', 'StockClasses.ocf.json', 'StockLegends.ocf.json',
    'StockPlans.ocf.json', 'Transactions.ocf.json', 'Valuations.ocf.json', 'VestingTerms.ocf.json']);
  const files = [...entries.entries()].map(([path, data]) => ({ path, json: JSON.parse(data.toString('utf8')) }));
  assert.deepEqual(validateOcf(files), []);
  const manifest = files.find((f) => f.path === 'Manifest.ocf.json')!.json;
  assert.equal(manifest.ocf_version, '1.2.0');
  assert.equal(manifest.as_of, today());
  assert.equal(manifest.financings_files, undefined);
  for (const [list, path] of [['stakeholders_files', 'Stakeholders'], ['stock_classes_files', 'StockClasses'], ['stock_legend_templates_files', 'StockLegends'],
    ['stock_plans_files', 'StockPlans'], ['vesting_terms_files', 'VestingTerms'], ['valuations_files', 'Valuations'], ['transactions_files', 'Transactions']]) {
    const data = entries.get(`${path}.ocf.json`)!;
    assert.deepEqual(manifest[list], [{ filepath: `./${path}.ocf.json`, md5: createHash('md5').update(data).digest('hex') }], list);
    assert.ok(data.toString('utf8').endsWith('}\n'), 'two-space JSON with a final newline');
  }
  const audit = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE company_id = ? AND action = 'EXPORT' ORDER BY created_at DESC LIMIT 1", cid);
  assert.equal(audit?.detail, 'Cap table exported as an OCF package');
});

test('every reference resolves, every security is issued exactly once, and every balance holds what its event left', async () => {
  const pkg = await exportNow();
  const ids = (type: string) => new Set(itemsOf(pkg, type).map((i) => i.id));
  const people = ids('OCF_STAKEHOLDERS_FILE'), classes = ids('OCF_STOCK_CLASSES_FILE'), plans = ids('OCF_STOCK_PLANS_FILE');
  const terms = new Map(itemsOf(pkg, 'OCF_VESTING_TERMS_FILE').map((t) => [t.id, t]));
  const legends = ids('OCF_STOCK_LEGEND_TEMPLATES_FILE');
  const tx = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE');
  assert.equal(new Set(tx.map((t) => t.id)).size, tx.length, 'transaction ids are unique');
  const issuances = tx.filter((t) => /_ISSUANCE$/.test(t.object_type));
  const issued = new Map<string, any>();
  for (const i of issuances) {
    assert.ok(!issued.has(i.security_id), `${i.security_id} issued once`);
    issued.set(i.security_id, i);
    assert.ok(people.has(i.stakeholder_id), `${i.id} holder`);
    if (i.stock_class_id) assert.ok(classes.has(i.stock_class_id), `${i.id} class`);
    if (i.stock_plan_id) assert.ok(plans.has(i.stock_plan_id), `${i.id} plan`);
    if (i.vesting_terms_id) assert.ok(terms.has(i.vesting_terms_id), `${i.id} terms`);
    for (const l of i.stock_legend_ids ?? []) assert.ok(legends.has(l), `${i.id} legend`);
    for (const trig of i.exercise_triggers ?? []) assert.ok(classes.has(trig.conversion_right.converts_to_stock_class_id));
  }
  const issuedOn = new Map(issuances.map((i) => [i.security_id, i.date]));
  for (const t of tx) {
    if (['TX_STOCK_CLASS_SPLIT', 'TX_STOCK_PLAN_POOL_ADJUSTMENT'].includes(t.object_type)) {
      assert.ok(classes.has(t.stock_class_id) || plans.has(t.stock_plan_id), t.id);
      continue;
    }
    assert.ok(issued.has(t.security_id), `${t.object_type} ${t.id} is about an issued security`);
    if (!/_ISSUANCE$|^TX_VESTING_START$|^TX_VESTING_EVENT$/.test(t.object_type)) assert.ok(t.date >= issuedOn.get(t.security_id)!, `${t.id} after its issue`);
    for (const r of t.resulting_security_ids ?? []) assert.ok(issued.has(r), `${t.id} result ${r}`);
    if (t.vesting_condition_id) {
      const own = terms.get(issued.get(t.security_id).vesting_terms_id);
      assert.ok(own?.vesting_conditions.some((c: any) => c.id === t.vesting_condition_id), `${t.id} condition`);
    }
    if (t.balance_security_id) {
      const source = issued.get(t.security_id), balance = issued.get(t.balance_security_id);
      assert.ok(balance, `${t.id} balance issued`);
      assert.equal(balance.date, t.date);
      const k = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE').filter((s) => s.object_type === 'TX_STOCK_CLASS_SPLIT' && s.stock_class_id === source.stock_class_id && s.date > source.date && s.date <= t.date)
        .reduce((f, s) => f * Number(s.split_ratio.numerator) / Number(s.split_ratio.denominator), 1);
      assert.ok(Math.abs(Number(source.quantity) * k - Number(t.quantity ?? t.quantity_converted) - Number(balance.quantity)) < 1e-6, `${t.id}: ${source.quantity} x ${k} - ${t.quantity} = ${balance.quantity}`);
    }
  }
  for (const v of itemsOf(pkg, 'OCF_VALUATIONS_FILE')) assert.ok(classes.has(v.stock_class_id));
  for (const p of itemsOf(pkg, 'OCF_STOCK_PLANS_FILE')) for (const c of p.stock_class_ids) assert.ok(classes.has(c));
  for (const c of itemsOf(pkg, 'OCF_STOCK_CLASSES_FILE')) for (const r of c.conversion_rights ?? []) assert.ok(classes.has(r.converts_to_stock_class_id));
  for (const s of itemsOf(pkg, 'OCF_STAKEHOLDERS_FILE')) {
    const by = readNote(s, 'STAKEHOLDER').boardDesignatedBy;
    if (by) assert.ok(people.has(by));
  }
  assert.equal(fileOf(pkg, 'OCF_MANIFEST_FILE').issuer.id, cid);
});

test('an OCF reader replaying the transactions gets Kosmitor\'s cap table on every date something happened, and the day before', async () => {
  const pkg = await exportNow();
  const data = await getCompanyData(cid);
  const dates = datesOf(pkg);
  assert.ok(dates.length > 40);
  for (const d of dates) {
    const ours = kosmitor(data, d), theirs = replay(pkg, d);
    assert.deepEqual(sorted(theirs.shares), sorted(ours.shares), `shares on ${d}`);
    assert.deepEqual(sorted(theirs.options), sorted(ours.options), `options on ${d}`);
    assert.deepEqual(sorted(theirs.rsus), sorted(ours.rsus), `RSUs on ${d}`);
    assert.deepEqual(sorted(theirs.warrants), sorted(ours.warrants), `warrants on ${d}`);
  }
  // A few figures by hand: before the split Ada held 4,000,000 less 100,000 repurchased; after it, twice that, less 400,000 cancelled and 100,000 repurchased.
  assert.equal(replay(pkg, '2023-01-01').shares.get('Ada Fernsby | Common'), 3_900_000);
  assert.equal(replay(pkg, '2024-07-01').shares.get('Ada Fernsby | Common'), 7_300_000);
  assert.equal(replay(pkg, '2024-07-01').shares.get('Mina Osei | Common'), 200_000);
});

test('what the package says, object by object', async () => {
  const pkg = await exportNow();
  const manifest = fileOf(pkg, 'OCF_MANIFEST_FILE');
  assert.deepEqual(manifest.issuer, {
    id: cid, object_type: 'ISSUER', legal_name: 'Brightwater Kinetics, Inc.', dba: 'Brightwater Kinetics', formation_date: '2021-01-04',
    country_of_formation: 'US', country_subdivision_of_formation: 'DE', tax_ids: [{ tax_id: '00-0000001', country: 'US' }],
    address: { address_type: 'LEGAL', street_suite: '12 Example Quay, Springfield', country: 'US' },
  });
  assert.deepEqual(manifest.comments.slice(0, 2), ['Exported by Kosmitor from Brightwater Kinetics.', 'Kosmitor-specific details are kept in comments beginning kosmitor:1:.']);
  for (const line of [
    '1 security not yet issued (a draft, or awaiting approval or signatures) is not included.',
    '1 valuation of a type OCF 1.2.0 has no place for (PREFERRED_PRICE) is not included.',
    '1 draft valuation is not included.',
    'Share counts corrected after issue are shown as corrected from the issue date: CS-3 (corrected on 2022-02-01).',
    '1 ledger entry with no OCF transaction (SECONDARY_SALE) is not included.',
    // Findings F1, F2, F4, F9: what the package gives differently is said where a reader looks.
    'Restricted stock awards are given with the certificates of their shares, as stock issuances with issuance_type RSA: RSA-2 (CS-4).',
    'Restricted stock awards with no certificate on record are given as stock issuances with issuance_type RSA and their plan. Kosmitor counts such shares only once a certificate is issued, so another tool shows them as outstanding where Kosmitor does not: RSA-1.',
    'Options a holder lost on leaving, which Kosmitor works out from the leaving date with no ledger entry, are given as cancellations: OPT-8 (unvested on 2023-06-30), OPT-8 (window closed on 2023-10-01), RSU-2 (unvested on 2023-06-30).',
    'SAFE-2 elected the terms of SAFE-3 on 2023-02-01 (MFN); its conversion terms in the package are as issued.',
    'Emails OCF\'s format does not accept, and signatories with no email, are kept only in Kosmitor\'s notes: Gale Street Trust, Jonah Pell.',
  ]) assert.ok(manifest.comments.includes(line), line);
  assert.ok(manifest.comments.includes('OCF\'s vesting conditions cannot state these schedules exactly, so each security on them also lists its own vestings: 2 years weekly, 6-month cliff; 4 years back-loaded (10/20/30/40); Launch milestones.'), manifest.comments.join('\n'));

  const people = new Map(itemsOf(pkg, 'OCF_STAKEHOLDERS_FILE').map((s) => [s.name.legal_name, s]));
  const adaOut = people.get('Ada Fernsby');
  assert.equal(adaOut.current_relationship, 'FOUNDER');
  assert.deepEqual(adaOut.contact_info, { emails: [{ email_type: 'OTHER', email_address: 'ada@brightwater.example' }], phone_numbers: [{ phone_type: 'OTHER', phone_number: '+1 415 555 0100' }] });
  assert.deepEqual(adaOut.addresses, [{ address_type: 'CONTACT', street_suite: '7 Lantern Lane', city: 'Oakview', country_subdivision: 'CA', country: 'US', postal_code: '94000' }]);
  assert.deepEqual(readNote(adaOut, 'STAKEHOLDER'), { title: 'CEO', department: 'Leadership', startDate: '2021-01-04', taxCountry: 'US', taxState: 'CA', boardSeat: true, boardSeatStart: '2021-01-04' });
  assert.deepEqual(readNote(people.get('Bramwell Holloway'), 'STAKEHOLDER'), { name: 'Bram Holloway', phone: '(415) 555-0199' });
  const fund = people.get('Fenwick Capital Fund I, L.P.');
  assert.equal(fund.stakeholder_type, 'INSTITUTION');
  assert.deepEqual(fund.primary_contact, { name: { legal_name: 'Petra Lindqvist-Rowe' }, emails: [{ email_type: 'OTHER', email_address: 'petra@fenwick.example' }] });
  assert.equal(readNote(fund, 'STAKEHOLDER').type, 'FUND');
  const galeOut = people.get('Gale Street Trust');
  assert.deepEqual(readNote(galeOut, 'STAKEHOLDER'), { type: 'TRUST', address: '3 Gale Street, Port Ellery', signatory: 'Rhea Gale' });
  assert.equal(galeOut.primary_contact, undefined, 'OCF\'s primary contact needs an email or a phone besides the name');
  assert.equal(galeOut.comments[0], 'The other Gale trust', 'notes travel as a plain comment');
  const harrowOut = people.get('Harrow Angels LLC');
  assert.deepEqual([harrowOut.addresses, readNote(harrowOut, 'STAKEHOLDER').region], [[{ address_type: 'CONTACT', street_suite: '9 Example Mews', city: 'London', country: 'GB' }], 'Greater London']);
  assert.deepEqual([people.get('Jonah Pell').contact_info.emails.length, readNote(people.get('Jonah Pell'), 'STAKEHOLDER').secondaryEmail], [1, 'jonah@péll.example']);
  assert.equal(people.get('Harrow Angels LLC').stakeholder_type, 'INSTITUTION');
  assert.equal(readNote(people.get('Harrow Angels LLC'), 'STAKEHOLDER').type, undefined, 'an entity is what an institution reads as');
  assert.deepEqual([people.get('Cleo Marchetti').issuer_assigned_id, people.get('Cleo Marchetti').contact_info.emails.length], ['E-1001', 2]);
  assert.equal(people.get('Jonah Pell').current_relationship, 'CONSULTANT');
  assert.equal(people.get('Kira Moss').current_relationship, 'EX_EMPLOYEE');
  assert.deepEqual(readNote(people.get('Lark Ostrander'), 'STAKEHOLDER'), { boardSeat: true, boardSeatStart: '2022-03-01', boardDesignatedBy: fenwick });
  assert.deepEqual(readNote(people.get('Nadia Quist'), 'STAKEHOLDER'), { boardSeat: false });

  const series = itemsOf(pkg, 'OCF_STOCK_CLASSES_FILE').find((c) => c.name === 'Series A Preferred');
  assert.deepEqual({ ...series, comments: undefined }, {
    id: seriesA, object_type: 'STOCK_CLASS', name: 'Series A Preferred', class_type: 'PREFERRED', default_id_prefix: 'PS-', initial_shares_authorized: '5000000',
    votes_per_share: '1', par_value: { amount: '0.0001', currency: 'USD' }, price_per_share: { amount: '1.25', currency: 'USD' }, seniority: '1',
    liquidation_preference_multiple: '1', participation_cap_multiple: '3',
    conversion_rights: [{ type: 'STOCK_CLASS_CONVERSION_RIGHT', conversion_mechanism: { type: 'RATIO_CONVERSION', conversion_price: { amount: '1.25', currency: 'USD' }, ratio: { numerator: '1', denominator: '1' }, rounding_type: 'NORMAL' }, converts_to_stock_class_id: common }],
    comments: undefined,
  });
  assert.deepEqual(readNote(series, 'STOCK_CLASS'), { issueDate: '2022-03-01', participation: 'CAPPED_PARTICIPATING', participationCap: 3, dividendType: 'CUMULATIVE', dividendRate: 0.06,
    dividendCompounding: false, dividendsParticipateInResidual: false, antiDilution: 'BROAD_WEIGHTED', payToPlay: false, isConvertible: true });
  assert.deepEqual(itemsOf(pkg, 'OCF_STOCK_LEGEND_TEMPLATES_FILE').map((l) => [l.id, l.name]), [[`${seriesA}.legend`, 'Series A Preferred legend']]);
  assert.deepEqual(itemsOf(pkg, 'OCF_STOCK_PLANS_FILE').map((p) => [p.plan_name, p.initial_shares_reserved, p.default_cancellation_behavior, p.stock_class_ids]),
    [['2021 Equity Incentive Plan', '2000000', 'RETURN_TO_POOL', [common]]]);
  assert.deepEqual(itemsOf(pkg, 'OCF_VALUATIONS_FILE').map((v) => [v.effective_date, v.price_per_share.amount, v.stock_class_id, readNote(v, 'VALUATION').status]),
    [['2021-03-01', '0.05', common, 'SUPERSEDED'], ['2022-04-01', '0.25', common, 'ACTIVE']]);
  assert.deepEqual(new Set(itemsOf(pkg, 'OCF_VESTING_TERMS_FILE').map((t) => t.name)), new Set([
    '4 years, 1 year cliff, monthly', '4 years, no cliff, monthly', 'Three dated tranches', 'Launch milestones', '2 years weekly, 6-month cliff',
    '4 years back-loaded (10/20/30/40)', '1 year, monthly', 'Fully vested at grant', '2 years, monthly (advisor)', '4 years, 1 year cliff, quarterly',
  ]), 'only the schedules a security uses');

  const tx = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE');
  const of = (security: string) => tx.filter((t) => t.security_id === security || t.security_id?.startsWith(`${security}.`)).map((t) => [t.object_type, t.date, t.security_id.replace(security, '#'), t.quantity ?? t.quantity_converted ?? null]);
  // In the order things became known: by date, but a vesting start (or a milestone reached) comes after the issuance
  // of its security, whatever its own date (finding F11), so no reader meets one before its security.
  const issuedAt = new Map(tx.filter((t) => /_ISSUANCE$/.test(t.object_type)).map((t) => [t.security_id, t.date]));
  const known = tx.map((t) => (/^TX_VESTING_(START|EVENT)$/.test(t.object_type) && t.date < issuedAt.get(t.security_id)! ? issuedAt.get(t.security_id)! : t.date));
  assert.deepEqual(known, [...known].sort(), 'in the order things became known');
  const position = new Map(tx.map((t, i) => [t.id, i]));
  for (const t of tx) {
    if (/^TX_VESTING_(START|EVENT)$/.test(t.object_type)) assert.ok(position.get(t.id)! > position.get(`${t.security_id}.issue`)!, `${t.id} after its security's issuance`);
  }
  assert.ok(tx.some((t) => t.object_type === 'TX_VESTING_START' && t.date < issuedAt.get(t.security_id)!), 'CS-1 vests from before its issue date');
  assert.deepEqual(tx.filter((t) => t.object_type === 'TX_STOCK_CLASS_SPLIT').map((t) => [t.stock_class_id, t.split_ratio]),
    [[common, { numerator: '2', denominator: '1' }], [seriesA, { numerator: '2', denominator: '1' }]]);
  assert.deepEqual(tx.filter((t) => t.object_type === 'TX_STOCK_PLAN_POOL_ADJUSTMENT').map((t) => [t.date, t.shares_reserved, t.comments]), [['2022-12-01', '2500000', ['Board increased the plan']]]);
  // A balance certificate has a number of its own (finding F12).
  assert.deepEqual(tx.filter((t) => t.object_type === 'TX_STOCK_ISSUANCE' && t.security_id.startsWith(cs1)).map((t) => t.custom_id), ['CS-1', 'CS-1-B1', 'CS-1-B2', 'CS-1-B3']);
  // CS-1: issued as 4,000,000, then a repurchase, a split, a cancellation, a repurchase, each leaving a balance.
  assert.deepEqual(of(cs1).filter(([type]) => type !== 'TX_VESTING_START'), [
    ['TX_STOCK_ISSUANCE', '2021-01-15', '#', '4000000'], ['TX_STOCK_REPURCHASE', '2022-09-01', '#', '100000'], ['TX_STOCK_ISSUANCE', '2022-09-01', '#.b1', '3900000'],
    ['TX_STOCK_CANCELLATION', '2023-10-01', '#.b1', '400000'], ['TX_STOCK_ISSUANCE', '2023-10-01', '#.b2', '7400000'],
    ['TX_STOCK_REPURCHASE', '2024-06-01', '#.b2', '100000'], ['TX_STOCK_ISSUANCE', '2024-06-01', '#.b3', '7300000'],
    ['TX_VESTING_ACCELERATION', '2024-08-01', '#.b3', '1000'],
  ]);
  assert.deepEqual(of(cs1).filter(([type]) => type === 'TX_VESTING_START').map(([, date, security]) => [date, security]),
    [['2021-01-04', '#'], ['2021-01-04', '#.b1'], ['2021-01-04', '#.b2'], ['2021-01-04', '#.b3']], 'each balance vests from the original start');
  const cs1Issue = tx.find((t) => t.id === `${cs1}.issue`);
  assert.deepEqual([cs1Issue.share_price, cs1Issue.security_law_exemptions, cs1Issue.board_approval_date, readNote(cs1Issue, 'TX_STOCK_ISSUANCE')],
    [{ amount: '0.0001', currency: 'USD' }, [{ description: 'Section 4(a)(2) of the Securities Act', jurisdiction: 'US' }], '2021-01-10', { election83bFiledOn: '2021-02-01' }]);
  assert.equal(tx.find((t) => t.id === `${cs1}.b2.issue`).share_price.amount, '0.00005', 'a balance after the split is priced in its own shares');
  // CS-2: a partial transfer before the split, the rest after it.
  const cs2tx = tx.filter((t) => t.security_id?.startsWith(cs2) && /TRANSFER/.test(t.object_type));
  assert.deepEqual(cs2tx.map((t) => [t.date, t.security_id.replace(cs2, '#'), t.quantity, t.resulting_security_ids.length, t.balance_security_id?.replace(cs2, '#') ?? null]),
    [['2021-12-01', '#', '500000', 1, '#.b1'], ['2023-09-01', '#.b1', '5000000', 1, null]]);
  assert.equal(cs2tx[0].resulting_security_ids[0], tr1.id);
  assert.equal(cs2tx[0].consideration_text, '50000.00 USD');
  // RSA-1: stock of its plan, cancelled in part, then the rest after the split.
  assert.deepEqual(of(rsa1).filter(([type]) => type !== 'TX_VESTING_START'), [
    ['TX_STOCK_ISSUANCE', '2021-09-01', '#', '60000'], ['TX_STOCK_CANCELLATION', '2022-11-01', '#', '15000'], ['TX_STOCK_ISSUANCE', '2022-11-01', '#.b1', '45000'],
    ['TX_STOCK_CANCELLATION', '2024-07-01', '#.b1', '90000'],
  ]);
  const rsa = tx.find((t) => t.id === `${rsa1}.issue`);
  assert.deepEqual([rsa.issuance_type, rsa.stock_plan_id, readNote(rsa, 'TX_STOCK_ISSUANCE').award], ['RSA', plan, { label: 'RSA-1', ptepMonths: 3, expirationDate: '2031-09-01', fmvAtGrant: 0 }]);
  // RSA-2 is the shares of CS-4: one stock issuance, the certificate's, carrying the award (finding F1).
  assert.equal(tx.find((t) => t.security_id === rsa2), undefined, 'no second issuance of the same shares');
  const cs4Issue = tx.find((t) => t.id === `${cs4}.issue`);
  assert.deepEqual([cs4Issue.quantity, cs4Issue.issuance_type, cs4Issue.stock_plan_id], ['30000', 'RSA', plan]);
  assert.deepEqual(readNote(cs4Issue, 'TX_STOCK_ISSUANCE').rsaAward, {
    label: 'RSA-2', ptepMonths: 3, expirationDate: '2031-10-01', fmvAtGrant: 0, quantity: 30_000, grantDate: '2021-10-01', price: 50_000,
    entries: [{ date: '2022-12-15', type: 'CANCELLATION', quantity: 5_000 }],
  });
  // An unnumbered certificate's custom_id is made up from its id, and the note says so (finding RT-10).
  assert.equal(readNote(tx.find((t) => t.id === `${unnumbered}.issue`), 'TX_STOCK_ISSUANCE').unnumbered, true);
  assert.equal(tx.find((t) => t.id === `${cs3}.issue`).comments[0], 'Advisor shares for the 2022 roadmap');
  // OPT-1: accepted, exercised before and after the split, partly cancelled.
  assert.deepEqual(of(opt1).map(([type, date, , q]) => [type, date, q]), [
    ['TX_EQUITY_COMPENSATION_ISSUANCE', '2021-06-01', '200000'], ['TX_VESTING_START', '2021-06-01', null], ['TX_EQUITY_COMPENSATION_ACCEPTANCE', '2021-06-03', null],
    ['TX_EQUITY_COMPENSATION_EXERCISE', '2022-06-01', '50000'], ['TX_EQUITY_COMPENSATION_EXERCISE', '2024-01-15', '40000'], ['TX_EQUITY_COMPENSATION_CANCELLATION', '2024-02-01', '20000'],
  ]);
  const opt1Issue = tx.find((t) => t.id === `${opt1}.issue`);
  assert.deepEqual([opt1Issue.compensation_type, opt1Issue.option_grant_type, opt1Issue.exercise_price, opt1Issue.expiration_date, opt1Issue.termination_exercise_windows.length, readNote(opt1Issue, 'TX_EQUITY_COMPENSATION_ISSUANCE')],
    ['OPTION_ISO', 'ISO', { amount: '0.10', currency: 'USD' }, '2031-06-01', 7, { fmvAtGrant: 50_000 }]);
  assert.ok(tx.filter((t) => t.object_type === 'TX_EQUITY_COMPENSATION_EXERCISE').every((t) => t.resulting_security_ids.length === 1));
  // How each was exercised, as the exercise on record has it (finding RT-2): the second, cashless, after the split.
  assert.deepEqual(tx.filter((t) => t.security_id === opt1 && t.object_type === 'TX_EQUITY_COMPENSATION_EXERCISE').map((t) => readNote(t, 'TX_EQUITY_COMPENSATION_EXERCISE')), [
    { method: 'CASH', fmvAtExercise: 250_000, sharesIssued: 50_000, amount: 500_000 },
    { method: 'CASHLESS', fmvAtExercise: 125_000, sharesIssued: 24_000, amount: 200_000 },
  ]);
  // A leaver's options lapse with no ledger entry in Kosmitor; the package cancels them on the dates they go (finding F2).
  assert.deepEqual(tx.filter((t) => t.security_id === opt8 || t.security_id === rsu2).filter((t) => /CANCELLATION/.test(t.object_type)).map((t) => [t.id.replace(/^awa_[^.]+/, '#'), t.date, t.quantity, readNote(t, 'TX_CANCELLATION')]), [
    ['#.lapsed', '2023-06-30', '62000', { type: 'FORFEITURE', lapse: 'termination' }],
    ['#.lapsed', '2023-06-30', '2000', { type: 'FORFEITURE', lapse: 'termination' }],
    ['#.window-closed', '2023-10-01', '34000', { type: 'EXPIRATION', lapse: 'window' }],
  ]);
  // A grant that never expires says so; OCF's null alone reads as unknown (finding RT-5).
  const opt8Issue = tx.find((t) => t.id === `${opt8}.issue`);
  assert.deepEqual([opt8Issue.expiration_date, readNote(opt8Issue, 'TX_EQUITY_COMPENSATION_ISSUANCE').noExpiration], [null, true]);
  const byLabel = (label: string) => tx.find((t) => t.custom_id === label && /_ISSUANCE$/.test(t.object_type));
  assert.deepEqual([byLabel('GS-1').compensation_type, byLabel('GS-1').option_grant_type, readNote(byLabel('GS-1'), 'TX_EQUITY_COMPENSATION_ISSUANCE').type], ['OPTION', 'INTL', 'GROWTH_SHARE']);
  assert.deepEqual([byLabel('PH-1').compensation_type, readNote(byLabel('PH-1'), 'TX_EQUITY_COMPENSATION_ISSUANCE').type], ['RSU', 'PHANTOM']);
  assert.deepEqual([byLabel('SAR-1').compensation_type, byLabel('SAR-1').base_price.amount], ['SSAR', '0.20']);
  assert.deepEqual(readNote(byLabel('RSU-1'), 'TX_EQUITY_COMPENSATION_ISSUANCE'), { rsuLiquidityCondition: true });
  assert.ok(byLabel('OPT-5').vestings?.length > 0, 'weekly vesting is given per security');
  assert.equal(byLabel('OPT-1').vestings, undefined, 'the standard schedule needs none');
  assert.deepEqual(tx.filter((t) => t.object_type === 'TX_VESTING_EVENT').map((t) => [t.date, t.vesting_condition_id]), [['2022-08-15', 'milestone-proto']]);
  assert.equal(of(opt2).at(-1)![0], 'TX_EQUITY_COMPENSATION_CANCELLATION');
  assert.equal(tx.filter((t) => t.security_id === opt2 && t.object_type === 'TX_EQUITY_COMPENSATION_CANCELLATION').at(-1).reason_text, 'EXPIRED');
  assert.equal(tx.find((t) => /^awa_pending/.test(t.security_id ?? '')), undefined, 'the grant awaiting signature is left out');
  // Warrants: custom ids by issue date, exercises with their quantity in the note, a cancellation and an expiry.
  assert.deepEqual([byLabel('W-1').security_id, byLabel('W-2').security_id, byLabel('W-3').security_id], [w1, w2, w3]);
  assert.deepEqual(tx.filter((t) => t.security_id === w1 && t.object_type === 'TX_WARRANT_EXERCISE').map((t) => [t.date, readNote(t, 'TX_WARRANT_EXERCISE').quantity, t.resulting_security_ids.length]),
    [['2023-01-15', 40_000, 1], ['2024-03-01', 20_000, 1]]);
  assert.deepEqual(tx.filter((t) => t.object_type === 'TX_WARRANT_CANCELLATION').map((t) => [t.security_id, t.date, t.quantity, t.reason_text, readNote(t, 'TX_CANCELLATION').type]), [
    // W-4's count lowered after its issue is the dated cancellation of part of it (finding RT-4).
    [w4, '2023-02-01', '10000', 'quantity corrected from 30000 to 20000', 'CORRECTION'],
    [w2, '2023-05-01', '50000', 'Surrendered', 'CANCELLATION'], [w3, '2023-05-02', '25000', 'Warrant expired', 'EXPIRATION'],
  ]);
  assert.deepEqual([byLabel('W-4').quantity, byLabel('W-4').exercise_triggers[0].conversion_right.conversion_mechanism.converts_to_quantity], ['30000', '30000'], 'issued as it was');
  assert.deepEqual(tx.filter((t) => t.security_id === w1 && t.object_type === 'TX_WARRANT_EXERCISE').map((t) => readNote(t, 'TX_WARRANT_EXERCISE')),
    [{ quantity: 40_000, method: 'CASH', amount: 5_000_000 }, { quantity: 20_000, method: 'CASH', amount: 1_250_000 }]);
  // SAFEs and notes.
  const s1 = tx.find((t) => t.id === `${safe1}.issue`);
  assert.deepEqual(s1.conversion_triggers[0].conversion_right.conversion_mechanism, { type: 'SAFE_CONVERSION', conversion_mfn: false, conversion_valuation_cap: { amount: '8000000.00', currency: 'USD' }, conversion_timing: 'POST_MONEY' });
  assert.deepEqual(tx.filter((t) => t.security_id === safe1 && t.object_type === 'TX_CONVERTIBLE_CONVERSION').map((t) => [t.date, t.quantity_converted, t.resulting_security_ids.length]), [['2022-03-01', '500000', 1]]);
  const s2 = tx.find((t) => t.id === `${safe2}.issue`);
  assert.deepEqual(s2.conversion_triggers[0].conversion_right.conversion_mechanism, { type: 'SAFE_CONVERSION', conversion_mfn: true, conversion_discount: '0.2', conversion_valuation_cap: { amount: '5000000.00', currency: 'USD' }, conversion_timing: 'PRE_MONEY' });
  assert.deepEqual(readNote(s2, 'TX_CONVERTIBLE_ISSUANCE'), { instrument: 'SAFE_PRE', mfnElections: [{ date: '2023-02-01', adoptedSecurityId: safe3 }] });
  assert.equal(s2.comments[0], 'Elected the terms of SAFE-3 on 2023-02-01 (MFN); the conversion terms here are as issued.', 'said where a reader of the SAFE looks (finding F4)');
  const s3 = tx.find((t) => t.id === `${safe3}.issue`);
  assert.equal(s3.conversion_triggers[0].trigger_condition, 'An equity financing raising at least 1000000.00 USD');
  assert.deepEqual(readNote(s3, 'TX_CONVERTIBLE_ISSUANCE'), { instrument: 'SAFE_POST', qualifiedFinancingMinimum: 100_000_000, proRataRight: true, fundsReceivedOn: '2022-05-03', fundsReference: 'WIRE-2207' });
  assert.deepEqual([s3.board_approval_date, s3.comments[0]], ['2022-04-20', 'Signed at the Harbor Row offsite'], 'finding RT-9');
  const n1 = tx.find((t) => t.id === `${note1}.issue`);
  assert.deepEqual(n1.conversion_triggers.map((t: any) => [t.type, t.trigger_id, t.trigger_date ?? null]), [['AUTOMATIC_ON_CONDITION', 'conversion', null], ['AUTOMATIC_ON_DATE', 'maturity', '2023-06-15']]);
  assert.deepEqual(n1.conversion_triggers[0].conversion_right.conversion_mechanism, {
    type: 'CONVERTIBLE_NOTE_CONVERSION', interest_rates: [{ rate: '0.06', accrual_start_date: '2021-06-15' }], day_count_convention: 'ACTUAL_365', interest_payout: 'DEFERRED',
    interest_accrual_period: 'ANNUAL', compounding_type: 'COMPOUNDING', conversion_valuation_cap: { amount: '6000000.00', currency: 'USD' }, conversion_mfn: false,
  });
  // A repayment cancels the principal; the cash repaid, interest included, is in the reason and the note (finding F7).
  assert.deepEqual(tx.filter((t) => t.object_type === 'TX_CONVERTIBLE_CANCELLATION').map((t) => [t.security_id, t.amount.amount, t.reason_text, readNote(t, 'TX_CONVERTIBLE_CANCELLATION')]),
    [[note1, '250000.00', 'Repaid 260000.00 USD', { type: 'REPAYMENT', repaid: 26_000_000 }], [kiss1, '50000.00', 'Withdrawn by agreement', { type: 'CANCELLATION' }]]);
  assert.equal(tx.find((t) => t.id === `${kiss1}.issue`).convertible_type, 'CONVERTIBLE_SECURITY');
});

test('two exports differ only in the manifest\'s timestamps and checksums', async () => {
  const a = await exportNow('2026-01-01T00:00:00.000Z');
  invalidate(cid);
  const b = await exportNow('2026-02-02T12:00:00.000Z');
  assert.deepEqual(a.files.map((f) => f.path), b.files.map((f) => f.path));
  for (let i = 1; i < a.files.length; i++) assert.deepEqual(a.files[i].json, b.files[i].json, a.files[i].path);
  const strip = (m: any) => ({ ...m, generated_at: null });
  assert.deepEqual(strip(a.files[0].json), strip(b.files[0].json));
});

test('the certificate each transfer, exercise and conversion created is found the same without resulting_security_id', async () => {
  const recorded = await all<{ id: string; type: string; resulting_security_id: string }>('SELECT id, type, resulting_security_id FROM transactions WHERE company_id = ? AND resulting_security_id IS NOT NULL ORDER BY id', cid);
  // Four transfers, a conversion, two exercises of a grant and two of a warrant.
  assert.deepEqual([...new Set(recorded.map((r) => r.type))].sort(), ['CONVERSION', 'EXERCISE', 'TRANSFER'], 'the four routes record it');
  assert.equal(recorded.length, 9);
  const withIt = await exportNow();
  await run('UPDATE transactions SET resulting_security_id = NULL WHERE company_id = ?', cid);
  try {
    const without = await exportNow();
    assert.deepEqual(itemsOf(without, 'OCF_TRANSACTIONS_FILE'), itemsOf(withIt, 'OCF_TRANSACTIONS_FILE'));
  } finally {
    for (const r of recorded) await run('UPDATE transactions SET resulting_security_id = ? WHERE id = ?', r.resulting_security_id, r.id);
  }
});

test('a viewer may export; a portfolio-only member and anyone signed out may not', async () => {
  const member = async (email: string, name: string, role: string) => {
    const invite = await call('POST', `/api/c/${cid}/members`, { email, name, role }, admin);
    const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
    const token = new URL(link.json.resetUrl).searchParams.get('token')!;
    return (await call('POST', '/api/auth/reset', { token, password: `${name.split(' ')[0].toLowerCase()}-pass-1` })).token as string;
  };
  const viewer = await member('quinn@example.com', 'Quinn Viewer', 'VIEWER');
  const r = await download(`/api/c/${cid}/captable/export.ocf.zip`, viewer);
  assert.equal(r.status, 200);
  assert.deepEqual(validateOcf([...readZip(r.body).entries()].map(([path, data]) => ({ path, json: JSON.parse(data.toString('utf8')) }))), []);
  const employee = await member('cleo@brightwater.example', 'Cleo Marchetti', 'EMPLOYEE');
  assert.equal((await download(`/api/c/${cid}/captable/export.ocf.zip`, employee)).status, 403);
  assert.equal((await download(`/api/c/${cid}/captable/export.ocf.zip`, null)).status, 401);
});

test('a company with nothing on its cap table exports a valid package with empty files', async () => {
  const empty = (await call('POST', '/api/companies', { name: 'Quiet Fern Studio', jurisdiction: 'Neverland' }, admin)).json.id as string;
  const pkg = await exportNow(undefined, empty);
  assert.deepEqual(validateOcf(pkg.files), []);
  assert.deepEqual(pkg.files.map((f) => [f.path, (f.json as any).items?.length ?? null]), [
    ['Manifest.ocf.json', null], ['Stakeholders.ocf.json', 0], ['StockClasses.ocf.json', 1], ['StockLegends.ocf.json', 0], ['StockPlans.ocf.json', 0],
    ['VestingTerms.ocf.json', 0], ['Valuations.ocf.json', 0], ['Transactions.ocf.json', 0],
  ]);
  const manifest = fileOf(pkg, 'OCF_MANIFEST_FILE');
  assert.equal(manifest.issuer.country_of_formation, 'US');
  assert.equal(manifest.issuer.country_subdivision_of_formation, undefined);
  assert.ok(manifest.comments.includes('The jurisdiction "Neverland" is not a US state, a Canadian province or a country Kosmitor knows, so the country of formation is given as the US; the jurisdiction as typed is in the issuer\'s Kosmitor note.'));
  assert.deepEqual(readNote(manifest.issuer, 'ISSUER'), { jurisdiction: 'Neverland' }, 'finding F10');
});

test('states the ledger does not date (an import\'s, an edit\'s) are dated the security\'s own date, as every view reads them', async () => {
  const co = (await call('POST', '/api/companies', { name: 'Ledgerless Oak', incorporationDate: '2020-01-02' }, admin)).json.id as string;
  const cls = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', co))!.id;
  const fixed = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", co))!.id;
  const now = new Date().toISOString();
  await insert('stakeholders', { id: 'stk_lo_1', companyId: co, name: 'Orla Penn', type: 'INDIVIDUAL', relation: 'FOUNDER', createdAt: now });
  await insert('stakeholders', { id: 'stk_lo_2', companyId: co, name: 'Silas Fenn', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  await insert('pools', { id: 'pol_lo', companyId: co, name: 'Plan', shareClassId: cls, authorized: 100_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
  await insertSecurity('issuances', { id: 'iss_lo_1', companyId: co, certificateNo: 'CS-1', stakeholderId: 'stk_lo_1', shareClassId: cls, quantity: 900_000, pricePerShare: 100, issueDate: '2020-01-10', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
  await insertSecurity('issuances', { id: 'iss_lo_2', companyId: co, certificateNo: 'CS-2', stakeholderId: 'stk_lo_1', shareClassId: cls, quantity: 50_000, pricePerShare: 100, issueDate: '2020-01-10', status: 'CANCELLED', earlyExercised: 0, createdAt: now });
  await insertSecurity('awards', { id: 'awa_lo_1', companyId: co, label: 'OPT-1', stakeholderId: 'stk_lo_2', poolId: 'pol_lo', type: 'NSO', quantity: 10_000, strikePrice: 10_000, grantDate: '2020-06-01',
    vestingStartDate: '2020-06-01', vestingScheduleId: fixed, status: 'OUTSTANDING', ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 1_000, cancelledQuantity: 500, fmvAtGrant: 0, rsuLiquidityCondition: 0, createdAt: now });
  await insertSecurity('awards', { id: 'awa_lo_2', companyId: co, label: 'OPT-2', stakeholderId: 'stk_lo_2', poolId: 'pol_lo', type: 'NSO', quantity: 4_000, strikePrice: 10_000, grantDate: '2020-06-01',
    vestingStartDate: '2020-06-01', vestingScheduleId: fixed, status: 'CANCELLED', ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 0, rsuLiquidityCondition: 0, createdAt: now });
  await insertSecurity('warrants', { id: 'war_lo', companyId: co, stakeholderId: 'stk_lo_1', shareClassId: cls, quantity: 7_000, strikePrice: 10_000, issueDate: '2020-03-01', status: 'EXPIRED', exercisedQuantity: 2_000, netExercise: 1, createdAt: now });
  await insertSecurity('convertibles', { id: 'cnv_lo', companyId: co, stakeholderId: 'stk_lo_1', instrument: 'SAFE_POST', principal: 2_500_000, issueDate: '2020-02-01', status: 'CONVERTED', convertedOn: '2021-02-01', createdAt: now });
  const pkg = await exportNow(undefined, co);
  assert.deepEqual(validateOcf(pkg.files), []);
  const tx = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE');
  assert.deepEqual(tx.filter((t) => !/_ISSUANCE$/.test(t.object_type)).map((t) => [t.id, t.object_type, t.date, t.quantity ?? null]), [
    ['iss_lo_2.closed', 'TX_STOCK_CANCELLATION', '2020-01-10', '50000'],
    ['war_lo.exercised', 'TX_WARRANT_EXERCISE', '2020-03-01', null],
    ['war_lo.closed', 'TX_WARRANT_CANCELLATION', '2020-03-01', '5000'],
    ['awa_lo_1.vesting-start', 'TX_VESTING_START', '2020-06-01', null],
    ['awa_lo_2.vesting-start', 'TX_VESTING_START', '2020-06-01', null],
    ['awa_lo_1.exercised', 'TX_EQUITY_COMPENSATION_EXERCISE', '2020-06-01', '1000'],
    ['awa_lo_1.cancelled', 'TX_EQUITY_COMPENSATION_CANCELLATION', '2020-06-01', '500'],
    ['awa_lo_2.cancelled', 'TX_EQUITY_COMPENSATION_CANCELLATION', '2020-06-01', '4000'],
    ['cnv_lo.closed', 'TX_CONVERTIBLE_CONVERSION', '2021-02-01', null],
  ]);
  const data = await getCompanyData(co);
  for (const d of ['2020-01-10', '2020-03-01', '2020-06-01', '2021-01-01', today()]) {
    const ours = kosmitor(data, d), theirs = replay(pkg, d);
    assert.deepEqual([sorted(theirs.shares), sorted(theirs.options), sorted(theirs.warrants)], [sorted(ours.shares), sorted(ours.options), sorted(ours.warrants)], d);
  }
  const comments = fileOf(pkg, 'OCF_MANIFEST_FILE').comments as string[];
  for (const line of [
    'CS-2 is closed (cancelled) with no date on record; it is shown as cancelled on 2020-01-10.',
    'Exercises of OPT-1 with no date on record are dated the grant.',
    'Cancellations of OPT-2 with no date on record are dated the grant.',
    'Warrant W-1 is expired with no date on record; it is shown as ended on its issue date.',
  ]) assert.ok(comments.includes(line), `${line}\n${comments.join('\n')}`);
});

test('the Marlowe sample company exports a valid package whose shares replay to its cap table', async () => {
  const { createSampleCompany } = await import('../src/sample.ts');
  const sample = await createSampleCompany('sample-owner@example.com', 'Sample Owner');
  const pkg = await exportNow(undefined, sample);
  assert.deepEqual(validateOcf(pkg.files), []);
  const manifest = fileOf(pkg, 'OCF_MANIFEST_FILE');
  assert.equal(manifest.issuer.legal_name, 'Marlowe Systems, Inc.');
  assert.ok(manifest.comments.includes('1 security not yet issued (a draft, or awaiting approval or signatures) is not included.'));
  assert.ok(!itemsOf(pkg, 'OCF_TRANSACTIONS_FILE').some((t) => t.custom_id === 'OPT-11'));
  const data = await getCompanyData(sample);
  for (const d of datesOf(pkg)) assert.deepEqual(sorted(replay(pkg, d).shares), sorted(kosmitor(data, d).shares), `shares on ${d}`);
  const tx = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE');
  const exercise = tx.find((t) => t.object_type === 'TX_EQUITY_COMPENSATION_EXERCISE');
  assert.equal(tx.find((t) => t.security_id === exercise.resulting_security_ids[0] && t.object_type === 'TX_STOCK_ISSUANCE').custom_id, 'EX-1', 'found through the exercise on record');
});

test('the package is the cap table as of its date: securities issued and events dated after it are left out, and the manifest says so (finding F3)', async () => {
  const co = (await call('POST', '/api/companies', { name: 'Lumen Future Co', incorporationDate: '2020-01-02', jurisdiction: 'Ontario', address: '1 Example Lane, Toronto' }, admin)).json.id as string;
  const post = async (path: string, body: Record<string, unknown>) => (await call('POST', `/api/c/${co}/${path}`, body, admin)).json;
  const cls = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', co))!.id;
  const ana = (await post('stakeholders', { name: 'Ana Lumen', relation: 'FOUNDER', email: 'ana@lumen.example' })).id as string;
  const bo = (await post('stakeholders', { name: 'Bo Lumen', relation: 'INVESTOR', email: 'bo@lumen.example' })).id as string;
  const cs1 = (await post('issuances', { certificateNo: 'CS-1', stakeholderId: ana, shareClassId: cls, quantity: 1_000_000, pricePerShare: 100, issueDate: '2021-01-01' })).id as string;
  await post(`issuances/${cs1}/transfer`, { toStakeholderId: bo, quantity: 100_000, date: '2030-01-01', pricePerShare: 100 });
  await post('issuances', { certificateNo: 'CS-9', stakeholderId: bo, shareClassId: cls, quantity: 5_000, pricePerShare: 100, issueDate: '2031-05-05' });
  const pkg = await exportNow(undefined, co);
  assert.deepEqual(validateOcf(pkg.files), []);
  const tx = itemsOf(pkg, 'OCF_TRANSACTIONS_FILE');
  assert.deepEqual(tx.map((t) => [t.object_type, t.date, t.custom_id ?? null, t.quantity]), [['TX_STOCK_ISSUANCE', '2021-01-01', 'CS-1', '1000000']], 'CS-1 as it stands today, nothing after');
  const manifest = fileOf(pkg, 'OCF_MANIFEST_FILE');
  // The transfer, the certificate it made and CS-9; and no word about a transfer whose certificate is "not on record".
  assert.deepEqual(manifest.comments.slice(2), [`Securities, events and valuations dated after ${today()}, the date of this package, are not included: 3.`]);
  // Today's cap table is what the package says.
  const data = await getCompanyData(co);
  assert.deepEqual(sorted(replay(pkg, today()).shares), sorted(kosmitor(data, today()).shares));
  // A province is where the company was formed (finding F10).
  assert.deepEqual([manifest.issuer.country_of_formation, manifest.issuer.country_subdivision_of_formation, manifest.issuer.address], ['CA', 'ON', { address_type: 'LEGAL', street_suite: '1 Example Lane, Toronto', country: 'CA' }]);
});

test('the download says how many things the package leaves out or shows differently, and the page can list them (finding F5)', async () => {
  const res = await fetch(`${base}/api/c/${cid}/captable/export.ocf.zip`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(res.status, 200);
  const manifest = JSON.parse(readZip(Buffer.from(await res.arrayBuffer())).get('Manifest.ocf.json')!.toString('utf8'));
  const notes = manifest.comments.slice(2);
  assert.ok(notes.length >= 10);
  assert.equal(res.headers.get('x-ocf-notes'), String(notes.length));
  const listed = await call('GET', `/api/c/${cid}/captable/export.ocf.notes`, undefined, admin);
  assert.deepEqual(listed.json, { asOf: today(), notes });
  const before = (await all('SELECT id FROM audit_log WHERE company_id = ?', cid)).length;
  await call('GET', `/api/c/${cid}/captable/export.ocf.notes`, undefined, admin);
  assert.equal((await all('SELECT id FROM audit_log WHERE company_id = ?', cid)).length, before, 'nothing exported, nothing audited');
  assert.equal((await fetch(`${base}/api/c/${cid}/captable/export.ocf.notes`)).status, 401);
});
