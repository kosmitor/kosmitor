/**
 * The compliance findings in the assistant's snapshot are the Compliance page's:
 * worked out with the same options (total assets, the BOI standing, titles and
 * the ledger's cancellation dates), so the model is never handed a finding the
 * page does not show, or a score that differs from it.
 *
 * Facts, fictional, shaped like Treas. Reg. 1.422-4(d) Ex.5(ii): Rosa Lindqvist
 * holds three ISOs at a $1.00 strike and FMV, exercisable a year after grant:
 * 60,000 (2022-02-07), 50,000 (2022-04-11) and 40,000 (2022-06-13). The 50,000 are
 * cancelled on 2022-12-05, before their first year, so 2023 holds $100,000 and no
 * ISO is over the limit. Without the cancellation date the 50,000 would count and
 * 2023 would hold $150,000. The company was formed in Ontario, so it files a BOI
 * report.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/ai.ts');
const { insert, one } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const owner = (await call('POST', '/api/auth/register', { email: 'rosa.lindqvist@example.com', name: 'Rosa Lindqvist', password: 'rosa-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Northlight Ceramics', jurisdiction: 'Ontario', incorporationDate: '2021-10-04' }, owner)).json.id as string;
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const holder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Rosa Lindqvist', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, owner)).json.id as string;
const now = new Date().toISOString();
await insert('pools', { id: 'pool_n', companyId: cid, name: 'Plan', shareClassId: common, authorized: 500_000, returnForfeitures: 1, planType: 'STOCK_PLAN', boardApprovalDate: '2022-01-03', createdAt: now });
await insert('vesting_schedules', { id: 'vs_cliff', companyId: cid, name: 'One year cliff', kind: 'TIME', durationMonths: 12,
  cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, accelerationSingle: 0, accelerationDouble: 0, createdAt: now });
const iso = (id: string, quantity: number, grantDate: string) => insert('awards', { id, companyId: cid, label: id.toUpperCase(), stakeholderId: holder, poolId: 'pool_n', type: 'ISO',
  quantity, strikePrice: 1_000_000, grantDate, vestingStartDate: grantDate, vestingScheduleId: 'vs_cliff', status: 'OUTSTANDING', expirationDate: `${Number(grantDate.slice(0, 4)) + 10}${grantDate.slice(4)}`,
  ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 1_000_000, rsuLiquidityCondition: 0, createdAt: now });
await iso('nl_1', 60_000, '2022-02-07');
await iso('nl_2', 50_000, '2022-04-11');
await iso('nl_3', 40_000, '2022-06-13');
assert.equal((await call('POST', `/api/c/${cid}/awards/nl_2/cancel`, { date: '2022-12-05', reason: 'Declined by the holder' }, owner)).status, 200);

test('the snapshot leaves out the ISO finding the ledger\'s cancellation date rules out', async () => {
  const snapshot = (await call('GET', `/api/c/${cid}/ai/context`, undefined, owner)).json;
  assert.doesNotMatch(snapshot.text, /ISO \$100K limit exceeded/);
});

test('and carries the Compliance page\'s score and findings, BOI included', async () => {
  const page = (await call('GET', `/api/c/${cid}/compliance`, undefined, owner)).json;
  const snapshot = (await call('GET', `/api/c/${cid}/ai/context`, undefined, owner)).json.text as string;
  assert.ok(page.issues.some((i: any) => i.rule.startsWith('BOI')), 'the page has a BOI finding to compare');
  assert.match(snapshot, new RegExp(`Score: ${page.score} out of ${page.scoring.start}\\b`));
  assert.match(snapshot, new RegExp(`Counts: ${page.errors} error, ${page.warnings} warning, ${page.info} informational`));
  for (const i of page.issues) assert.ok(snapshot.includes(i.title), `the snapshot lists "${i.title}"`);
});
