/**
 * The equity routes take their defaults from the param file rather than from
 * constants: where a company is formed when it records nothing, who signs for
 * it, how long a new grant runs, what a stockholder consent needs, how much of
 * the ledger one page holds, what the portal shows, and the address every link
 * points at whatever the request says it came from. The exercise model also
 * stops treating every company as a C corporation, and a holder's exit curve
 * can no longer be asked for an unbounded number of points.
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase } from './helpers.ts';

delete process.env.SMTP_URL;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/offers.ts');
await import('../src/routes/fundraising.ts');
await import('../src/routes/data.ts');
const { insert, one, run } = await import('../src/db.ts');
const { invalidate } = await import('../src/store.ts');
const { config, configure, resetConfig } = await import('../src/config.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());
afterEach(() => resetConfig());

async function call(method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Settingsco', legalName: 'Settingsco, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
await insert('pools', { id: 'pool_set', companyId: cid, name: '2026 Stock Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
const holder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Rowan Adeyemi', email: 'rowan@example.com', relation: 'EMPLOYEE' }, admin)).json.id as string;
// Voting shares, so a stockholder consent has someone to ask.
await call('POST', `/api/c/${cid}/issuances`, { stakeholderId: holder, shareClassId: common, quantity: 100_000, pricePerShare: 1_000, issueDate: '2025-01-10', status: 'OUTSTANDING' }, admin);

/** The company as if it predates the column: nothing recorded, so the param file decides. */
async function forgetCompanyFacts(): Promise<void> {
  await run('UPDATE companies SET jurisdiction = NULL, fiscal_year_end = NULL, portal_settings = NULL WHERE id = ?', cid);
  invalidate(cid);
}

test('a grant, a certificate and a SAFE take their defaults from the param file', async () => {
  configure({ company: { jurisdiction: 'Nevada' }, equity: { signerTitle: 'President', optionTermYears: 7, postTerminationExerciseMonths: 6, noteCompounding: 'ANNUAL', convertibleInstrument: 'NOTE' } });
  await forgetCompanyFacts();

  const grant = await call('POST', `/api/c/${cid}/awards/issue`, {
    stakeholderId: holder, poolId: 'pool_set', type: 'ISO', quantity: 1_000, strikePrice: 1_000_000, grantDate: '2026-01-15', vestingScheduleId: schedule, signing: {},
  }, admin);
  assert.equal(grant.status, 200, JSON.stringify(grant.json));
  assert.equal(grant.json.award.expirationDate, '2033-01-15', 'equity.optionTermYears after the grant date');
  assert.equal(grant.json.award.ptepMonths, 6);
  assert.equal(grant.json.signatures[0].signerName, 'Avery Stone, President — for the Company');
  assert.match(grant.json.document.body, /no later than 6 months after the Optionee's service ends/);

  const certificate = await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, { stakeholderId: holder, shareClassId: common, quantity: 2_500, pricePerShare: 10_000 }, admin);
  assert.equal(certificate.status, 200, JSON.stringify(certificate.json));
  assert.match(certificate.json.document.body, /^A Nevada corporation, formed /m);
  assert.match(certificate.json.document.body, /For the Company: Avery Stone, President/);

  const raised = await call('POST', `/api/c/${cid}/convertibles/issue`, {
    terms: { interestRate: 0.06 }, investors: [{ stakeholderId: holder, principal: 5_000_000 }], signing: {},
  }, admin);
  assert.equal(raised.status, 200, JSON.stringify(raised.json));
  assert.equal(raised.json.convertibles[0].instrument, 'NOTE');
  assert.equal(raised.json.convertibles[0].compounding, 'ANNUAL');
  assert.match(raised.json.documents[0].body, /a Nevada corporation/);

  const recorded = await call('POST', `/api/c/${cid}/convertibles`, { stakeholderId: holder, instrument: 'NOTE', principal: 1_000_000, issueDate: '2026-02-01', interestRate: 0.05 }, admin);
  assert.equal(recorded.json.compounding, 'ANNUAL', 'a note recorded without compounding uses equity.noteCompounding');
  const plain = await call('POST', `/api/c/${cid}/awards`, { stakeholderId: holder, poolId: 'pool_set', type: 'NSO', quantity: 10, grantDate: '2026-01-15', vestingScheduleId: schedule }, admin);
  assert.equal(plain.json.ptepMonths, 6, 'a grant recorded without a window uses equity.postTerminationExerciseMonths');
});

test('a stockholder consent needs equity.stockholderConsentThreshold unless it says otherwise', async () => {
  configure({ equity: { stockholderConsentThreshold: 0.75 } });
  const consent = await call('POST', `/api/c/${cid}/consents`, { kind: 'STOCKHOLDER', title: 'Approve the 2026 plan' }, admin);
  assert.equal(consent.status, 200, JSON.stringify(consent.json));
  assert.equal(consent.json.threshold, 0.75);
  const majority = await call('POST', `/api/c/${cid}/consents`, { kind: 'STOCKHOLDER', title: 'Ratify the board', threshold: 0.5 }, admin);
  assert.equal(majority.json.threshold, 0.5);
});

test('ledger and audit pages hold limits.ledgerPageSize rows, and no more than limits.ledgerMaxPageSize', async () => {
  configure({ limits: { ledgerPageSize: 2, ledgerMaxPageSize: 3 } });
  assert.equal((await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.length, 2);
  assert.equal((await call('GET', `/api/c/${cid}/audit?limit=1`, undefined, admin)).json.length, 1);
  assert.equal((await call('GET', `/api/c/${cid}/audit?limit=50`, undefined, admin)).json.length, 3);
  assert.equal((await call('GET', `/api/c/${cid}/audit?limit=nonsense`, undefined, admin)).json.length, 2);
  resetConfig();
  assert.ok((await call('GET', `/api/c/${cid}/audit?limit=50`, undefined, admin)).json.length > 3);
});

test('an offer link points at app.url, not at the site the request claims to come from', async () => {
  configure({ equity: { offerSignerTitle: 'Head of People', awardType: 'RSA' } });
  const offer = await call('POST', `/api/c/${cid}/offers`, {
    candidateName: 'Priya Raman', position: 'VP Engineering', poolId: 'pool_set', quantity: 48_000, vestingScheduleId: schedule, expiresOn: '2099-12-31',
  }, admin);
  assert.equal(offer.status, 200, JSON.stringify(offer.json));
  assert.equal(offer.json.signerTitle, 'Head of People');
  assert.equal(offer.json.awardType, 'ISO', 'an award type no offer can carry falls back to the first one that can');

  const sent = await call('POST', `/api/c/${cid}/offers/${offer.json.id}/send`, {}, admin, { Origin: 'https://attacker.example', Referer: 'https://attacker.example/x' });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.ok(sent.json.link.startsWith(`${config().app.url}/offer/`), sent.json.link);
  assert.doesNotMatch(sent.json.link, /attacker/);
});

test('the portal, the stock-comp report and the exercise model read their defaults from the param file', async () => {
  await forgetCompanyFacts();
  assert.equal((await call('POST', `/api/c/${cid}/portal/link`, { stakeholderId: holder }, admin)).status, 200);
  configure({
    company: { fiscalYearEnd: '06-30', portal: { showValuation: false } },
    stockComp: { defaultAssumptions: { volatility: 0.45 } },
  });
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, admin);
  assert.equal(portal.json.portalSettings.showValuation, false);
  assert.equal(portal.json.portalSettings.showOwnership, true);
  assert.equal(portal.json.portfolio.fmv, null);

  const comp = await call('GET', `/api/c/${cid}/reports/stock-comp`, undefined, admin);
  assert.equal(comp.status, 200, JSON.stringify(comp.json));
  assert.equal(comp.json.fiscalYearEnd, '06-30');
  assert.equal(comp.json.defaults.volatility, 0.45);
  assert.equal(comp.json.report.assumptions.volatility, 0.45);

  const outstanding = await call('POST', `/api/c/${cid}/awards/issue`, {
    stakeholderId: holder, poolId: 'pool_set', type: 'ISO', quantity: 1_000, strikePrice: 1_000_000, grantDate: '2024-01-15', vestingScheduleId: schedule,
  }, admin);
  assert.equal(outstanding.json.award.status, 'OUTSTANDING');
  const model = () => call('POST', `/api/c/${cid}/model/exercise`, { awardId: outstanding.json.award.id, shares: 100 }, admin);
  const cCorp = 'QSBS requires stock in a domestic C corporation.';
  assert.ok(!(await model()).json.qsbs.reasons.includes(cCorp));
  await run("UPDATE companies SET entity_type = 'LLC' WHERE id = ?", cid);
  assert.ok((await model()).json.qsbs.reasons.includes(cCorp), 'an LLC is not a C corporation');
  await run('UPDATE companies SET entity_type = NULL WHERE id = ?', cid);
  assert.ok(!(await model()).json.qsbs.reasons.includes(cCorp), 'nothing recorded reads as company.entityType');
  await run("UPDATE companies SET entity_type = 'C_CORP' WHERE id = ?", cid);
});

test('a holder exit curve is bounded in points and in size', async () => {
  const curve = await call('POST', `/api/c/${cid}/model/exit-curve`, { stakeholderId: holder, maxExit: -5, points: 100_000 }, admin);
  assert.equal(curve.status, 200, JSON.stringify(curve.json));
  assert.equal(curve.json.length, 200);
  assert.equal(curve.json.at(-1).exitValue, config().modeling.portalMaxExit * 100, 'a nonsense maximum falls back on modeling.portalMaxExit');
  const huge = await call('POST', `/api/c/${cid}/model/exit-curve`, { stakeholderId: holder, maxExit: 1e300, points: 2 }, admin);
  assert.equal(huge.json.at(-1).exitValue, 1_000_000_000_000_00);
  const waterfall = await call('POST', `/api/c/${cid}/model/waterfall`, { exitValue: 10_000_000_00, points: 5_000 }, admin);
  assert.equal(waterfall.json.curve.length, 200);
  assert.equal((await call('POST', `/api/c/${cid}/model/exit-curve`, { stakeholderId: holder, maxExit: 10_000_000_00 }, admin)).json.length, 24, 'the default is unchanged');
});
