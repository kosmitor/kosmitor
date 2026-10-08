/**
 * "My pending actions" (GET /c/:cid/my-actions): each member gets what waits on
 * them. Their own signature blocks, votes and approved exercises for everyone; the
 * Company's signatures, offers, exercise reviews, the 409A and compliance for the
 * editors only; nothing from another company; and the kept compliance checks
 * are worked out again once a write is recorded, without the request waiting on them.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie, insertSecurity } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/my-actions.ts');
const { insert, one, run } = await import('../src/db.ts');
const { settleChecks } = await import('../src/routes/my-actions.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
async function memberToken(cid: string, admin: string, email: string, name: string, role: string): Promise<string> {
  const invite = await call('POST', `/api/c/${cid}/members`, { email, name, role }, admin);
  const link = (await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl;
  return (await call('POST', '/api/auth/reset', { token: new URL(link).searchParams.get('token'), password: `${name.split(' ')[0].toLowerCase()}-pass-1` })).token as string;
}
type Item = { id: string; kind: string; title: string; detail: string | null; to: string; urgent: boolean };
const actions = async (cid: string, token: string): Promise<{ status: number; items: Item[]; count: number; settlesIn: number }> => {
  const r = await call('GET', `/api/c/${cid}/my-actions`, undefined, token);
  return { status: r.status, items: r.json.items ?? [], count: r.json.count, settlesIn: r.json.settlesIn };
};
const byId = (items: Item[], id: string) => items.find((i) => i.id === id);

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Taskco' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;

for (const [id, name, email, relation] of [
  ['stk_avery', 'Avery Stone', 'avery@example.com', 'FOUNDER'], ['stk_priya', 'Priya Raman', 'priya@example.com', 'EMPLOYEE'],
  ['stk_lark', 'Larkspur Ventures', 'ops@larkspur.example', 'INVESTOR'], ['stk_dana', 'Dana Whitfield', 'dana@example.com', 'ADVISOR'],
] as const) {
  await insert('stakeholders', { id, companyId: cid, name, email, type: 'INDIVIDUAL', relation, createdAt: now });
}
await insert('pools', { id: 'pool_x', companyId: cid, name: '2024 Stock Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
const option = { companyId: cid, stakeholderId: 'stk_priya', poolId: 'pool_x', type: 'ISO', strikePrice: 500_000, grantDate: '2024-01-01', vestingStartDate: '2024-01-01',
  vestingScheduleId: schedule, expirationDate: '2034-01-01', ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 500_000,
  rsuLiquidityCondition: 0, createdAt: now };
await insertSecurity('awards', { ...option, id: 'awa_7', label: 'OPT-7', quantity: 10_000, status: 'OUTSTANDING' });
await insert('awards', { ...option, id: 'awa_8', label: 'OPT-8', quantity: 4_000, status: 'PENDING_APPROVAL' });   // not issued yet: no ledger entry
await insertSecurity('issuances', { id: 'iss_3', companyId: cid, certificateNo: 'CS-3', stakeholderId: 'stk_lark', shareClassId: common,
  quantity: 250_000, pricePerShare: 420_000, issueDate: '2024-03-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });

// The option agreement for OPT-7 waits on Priya and on the Company, which Avery signs for.
const doc = (id: string, name: string, category: string, securityId: string | null, status = 'AWAITING_SIGNATURE') =>
  insert('documents', { id, companyId: cid, name, category, folder: 'General', stakeholderId: null, securityId, requiresSignature: 1, status, visibility: 'HOLDER', createdAt: now });
const block = (id: string, documentId: string, stakeholderId: string | null, signerName: string, signerEmail: string | null, status = 'PENDING') =>
  insert('signatures', { id, companyId: cid, documentId, stakeholderId, signerName, signerEmail, status, token: `tok_${id}`, sentAt: now, createdAt: now });
await doc('doc_opt7', 'Option agreement OPT-7 — Priya Raman', 'GRANT_AGREEMENT', 'awa_7');
await block('sig_co7', 'doc_opt7', null, 'Avery Stone, CEO — for the Company', 'Avery@Example.com');
await block('sig_pr7', 'doc_opt7', 'stk_priya', 'Priya Raman', 'priya@example.com');
// A certificate another officer is to sign for the Company, and a voided document whose block was never signed.
await doc('doc_cs3', 'Stock certificate CS-3', 'CERTIFICATE', 'iss_3');
await block('sig_co3', 'doc_cs3', null, 'Morgan Lee, Secretary — for the Company', 'morgan@example.com');
await doc('doc_void', 'Superseded side letter', 'OTHER', null, 'VOID');
await block('sig_void', 'doc_void', 'stk_priya', 'Priya Raman', 'priya@example.com');
// A side letter for Larkspur to sign, and an NDA for an outside signer with no stakeholder record, which is not the Company's to sign.
await doc('doc_lark', 'Larkspur side letter', 'OTHER', null);
await block('sig_lark', 'doc_lark', 'stk_lark', 'Larkspur Ventures', 'ops@larkspur.example');
await doc('doc_nda', 'Vendor NDA', 'OTHER', null);
await block('sig_nda', 'doc_nda', null, 'Outside counsel', null);

// A board consent approving OPT-8, open; and a closed one nobody voted on.
await insert('board_consents', { id: 'con_open', companyId: cid, title: 'Approve the option grant OPT-8', kind: 'BOARD', type: 'WRITTEN_CONSENT', status: 'PENDING',
  effectiveDate: '2026-09-01', linkedEntityType: 'awards', linkedEntityIds: JSON.stringify(['awa_8']), createdAt: now });
await insert('board_consents', { id: 'con_closed', companyId: cid, title: 'Approve the 2025 budget', kind: 'BOARD', type: 'WRITTEN_CONSENT', status: 'WITHDRAWN', createdAt: now });
// And a stockholder consent open for Larkspur's vote.
await insert('board_consents', { id: 'con_holders', companyId: cid, title: 'Approve the charter amendment', kind: 'STOCKHOLDER', type: 'WRITTEN_CONSENT', status: 'PENDING', createdAt: now });
for (const [id, consentId, stakeholderId] of [
  ['vot_1', 'con_open', 'stk_avery'], ['vot_2', 'con_open', 'stk_priya'], ['vot_3', 'con_closed', 'stk_avery'],
  ['vot_4', 'con_open', 'stk_dana'], ['vot_5', 'con_holders', 'stk_lark'],
]) {
  await insert('board_votes', { id, consentId, stakeholderId, vote: 'PENDING', createdAt: now });
}

const exercise = (id: string, status: string, quantity: number) => insert('exercise_requests', {
  id, companyId: cid, awardId: 'awa_7', stakeholderId: 'stk_priya', quantity, method: 'CASH', strikePrice: 500_000, fmv: 0, estimatedCost: quantity * 50, spread: 0,
  status, requestedBy: 'Priya Raman', requestedAt: now, createdAt: now, ...(status === 'PAID' ? { paidAt: now } : {}), ...(status !== 'REQUESTED' ? { reviewedAt: now } : {}),
});
await exercise('exq_new', 'REQUESTED', 1_000);
await exercise('exq_ok', 'APPROVED', 500);
await exercise('exq_paid', 'PAID', 250);
await exercise('exq_done', 'COMPLETED', 100);
await insert('offers', { id: 'off_1', companyId: cid, candidateName: 'Jordan Lee', position: 'Staff engineer', status: 'ACCEPTED', quantity: 20_000, acceptedAt: now, createdAt: now });
await insert('offers', { id: 'off_2', companyId: cid, candidateName: 'Sam Ortiz', position: 'Designer', status: 'SENT', quantity: 5_000, createdAt: now });

// Another company, with paperwork that names Avery and Priya by address: none of it belongs to Taskco.
const blair = (await call('POST', '/api/auth/register', { email: 'blair@example.com', name: 'Blair Okafor', password: 'blair-pass-1' })).token as string;
const other = (await call('POST', '/api/companies', { name: 'Otherco' }, blair)).json.id as string;
await insert('stakeholders', { id: 'stk_b_priya', companyId: other, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insert('documents', { id: 'doc_b', companyId: other, name: 'Otherco side letter', category: 'OTHER', folder: 'General', stakeholderId: 'stk_b_priya', requiresSignature: 1, status: 'AWAITING_SIGNATURE', visibility: 'HOLDER', createdAt: now });
await insert('signatures', { id: 'sig_b_co', companyId: other, documentId: 'doc_b', stakeholderId: null, signerName: 'Avery Stone — for the Company', signerEmail: 'avery@example.com', status: 'PENDING', token: 'tok_b_co', sentAt: now, createdAt: now });
await insert('signatures', { id: 'sig_b_pr', companyId: other, documentId: 'doc_b', stakeholderId: 'stk_b_priya', signerName: 'Priya Raman', signerEmail: 'priya@example.com', status: 'PENDING', token: 'tok_b_pr', sentAt: now, createdAt: now });

test('an administrator sees the Company\'s work as well as their own vote', async () => {
  const { status, items, count } = await actions(cid, admin);
  assert.equal(status, 200);
  assert.equal(count, items.length);

  const vote = byId(items, 'vote:con_open')!;
  assert.equal(vote.kind, 'VOTE');
  assert.equal(vote.to, '/consents');
  assert.match(vote.detail!, /approves 1 grant\b/);
  assert.equal(byId(items, 'vote:con_closed'), undefined);

  const countersign = byId(items, 'countersign:sig_co7')!;
  assert.equal(countersign.kind, 'COUNTERSIGN');
  assert.equal(countersign.title, 'Sign for the Company: Option agreement OPT-7 — Priya Raman');
  assert.equal(countersign.detail, 'Others have yet to sign as well.');
  assert.equal(countersign.to, '/grants?q=OPT-7');
  assert.equal(byId(items, 'countersign:sig_co3'), undefined, 'a block addressed to another officer is theirs');
  assert.equal(byId(items, 'countersign:sig_nda'), undefined, 'an outside signer\'s block is not the Company\'s');
  assert.equal(byId(items, 'sign:sig_pr7'), undefined, 'the holder\'s own block is not the administrator\'s');

  assert.equal(byId(items, 'exercise:exq_new')?.title, 'Exercise request from Priya Raman');
  assert.match(byId(items, 'exercise:exq_new')!.detail!, /^1,000 options of OPT-7/);
  assert.equal(byId(items, 'exercise:exq_paid')?.title, 'Complete Priya Raman\'s exercise');
  assert.equal(byId(items, 'exercise:exq_ok'), undefined, 'an approved exercise waits on the holder\'s payment');
  assert.equal(byId(items, 'exercise:exq_done'), undefined);

  const offer = byId(items, 'offer:off_1')!;
  assert.equal(offer.to, '/grants?offer=off_1');
  assert.equal(byId(items, 'offer:off_2'), undefined, 'an offer not yet accepted needs nothing');

  // Options were granted and no 409A is on file: that blocks the next grant, so it comes up on its own.
  const due = byId(items, '409a:refresh')!;
  assert.equal(due.kind, 'VALUATION_DUE');
  assert.equal(due.title, 'No 409A valuation on file');
  assert.equal(due.urgent, true);
  // The other findings are one item, counted as the compliance page counts them, without the 409A ones the item above stands for.
  const summary = (await call('GET', `/api/c/${cid}/compliance`, undefined, admin)).json;
  const others = (summary.issues as { rule: string; severity: string }[]).filter((i) => i.rule !== 'VALUATION_409A');
  const warnings = others.filter((i) => i.severity === 'WARNING').length;
  assert.ok(warnings > 0 && others.every((i) => i.severity !== 'ERROR'));
  assert.ok(summary.issues.some((i: { rule: string; severity: string }) => i.rule === 'VALUATION_409A' && i.severity === 'ERROR'));
  const findings = byId(items, 'compliance')!;
  assert.equal(findings.title, `${warnings} compliance finding${warnings === 1 ? '' : 's'} to review`);
  assert.equal(findings.to, '/compliance');
  assert.equal(findings.urgent, false, 'nothing left to fix once the 409A is set apart');

  // Nothing from the other company, even where it names this administrator.
  assert.ok(items.every((i) => !/sig_b_|doc_b/.test(i.id) && !/Otherco/.test(i.title)));
});

test('a member who sees only their own holdings gets only their own items', async () => {
  const priya = await memberToken(cid, admin, 'priya@example.com', 'Priya Raman', 'EMPLOYEE');
  const { status, items } = await actions(cid, priya);
  assert.equal(status, 200);
  assert.deepEqual(items.map((i) => i.id).sort(), ['pay:exq_ok', 'sign:sig_pr7', 'vote:con_open']);
  assert.equal(byId(items, 'sign:sig_pr7')!.to, '/portal');
  assert.equal(byId(items, 'vote:con_open')!.to, '/portal', 'the consents page is not theirs to open');
  assert.equal(byId(items, 'pay:exq_ok')!.title, 'Pay for your exercise of OPT-7');

  // Their account in this company says nothing about the other one, and that one is closed to them.
  assert.equal((await call('GET', `/api/c/${other}/my-actions`, undefined, priya)).status, 403);
  assert.equal((await call('GET', `/api/c/${other}/my-actions`, undefined, admin)).status, 403);
});

test('legal works for the Company like an administrator; the board and investors get only their own', async () => {
  // Legal: an editor with no holding, so the Company's work addressed to them and none of anyone's own paperwork.
  const morgan = await memberToken(cid, admin, 'morgan@example.com', 'Morgan Lee', 'LEGAL');
  const legal = (await actions(cid, morgan)).items;
  assert.equal(byId(legal, 'countersign:sig_co3')?.title, 'Sign for the Company: Stock certificate CS-3');
  assert.equal(byId(legal, 'countersign:sig_co3')?.to, '/certificates?q=CS-3');
  assert.equal(byId(legal, 'countersign:sig_co7'), undefined, 'addressed to Avery');
  assert.equal(byId(legal, 'countersign:sig_nda'), undefined);
  for (const id of ['offer:off_1', 'exercise:exq_new', 'exercise:exq_paid', '409a:refresh', 'compliance']) assert.ok(byId(legal, id), id);
  assert.ok(legal.every((i) => i.kind !== 'SIGN' && i.kind !== 'VOTE'));

  // A director: their vote, on the consents page they can open, and none of the Company's work.
  const dana = await memberToken(cid, admin, 'dana@example.com', 'Dana Whitfield', 'BOARD');
  const board = (await actions(cid, dana)).items;
  assert.deepEqual(board.map((i) => i.id), ['vote:con_open']);
  assert.equal(board[0].to, '/consents');

  // An investor: their own signature and stockholder vote, both on My equity.
  const lark = await memberToken(cid, admin, 'ops@larkspur.example', 'Larkspur Ventures', 'INVESTOR');
  const investor = (await actions(cid, lark)).items;
  assert.deepEqual(investor.map((i) => i.id).sort(), ['sign:sig_lark', 'vote:con_holders']);
  assert.ok(investor.every((i) => i.to === '/portal'));
  assert.match(byId(investor, 'vote:con_holders')!.detail!, /^Stockholder consent/);
});

test('a reader with nothing waiting on them gets an empty list', async () => {
  const casey = await memberToken(cid, admin, 'casey@example.com', 'Casey Fox', 'VIEWER');
  const { status, items, count } = await actions(cid, casey);
  assert.equal(status, 200);
  assert.deepEqual(items, []);
  assert.equal(count, 0);
});

test('a 409A request in hand replaces the warning, and its delivered report or a note from the team comes up', async () => {
  await insert('valuation_requests', { id: 'vrq_1', companyId: cid, status: 'IN_PROGRESS', provider: 'Kosmitor valuation team', requestedBy: 'Avery Stone', createdAt: now, updatedAt: now });
  await insert('valuation_request_events', { id: 'vre_1', requestId: 'vrq_1', companyId: cid, kind: 'STARTED', message: null, author: 'desk', authorName: 'Desk', createdAt: '2026-01-01T00:00:00.000Z' });
  let items = (await actions(cid, admin)).items;
  assert.equal(byId(items, '409a:refresh'), undefined, 'a request is open, so the 409A is already being handled');
  assert.equal(byId(items, '409a:vrq_1'), undefined, 'the team starting work needs nothing from the company');

  // A note weeks old has had its turn in the list; the 409A page keeps it.
  await insert('valuation_request_events', { id: 'vre_2', requestId: 'vrq_1', companyId: cid, kind: 'MESSAGE', message: 'We have started on the report.', author: 'desk', authorName: 'Desk', createdAt: '2026-01-02T00:00:00.000Z' });
  items = (await actions(cid, admin)).items;
  assert.equal(byId(items, '409a:vrq_1'), undefined);

  await insert('valuation_request_events', { id: 'vre_3', requestId: 'vrq_1', companyId: cid, kind: 'MESSAGE', message: 'Could you send the latest board deck?', author: 'desk', authorName: 'Desk', createdAt: new Date().toISOString() });
  items = (await actions(cid, admin)).items;
  assert.match(byId(items, '409a:vrq_1')!.title, /^Note from the /);
  assert.equal(byId(items, '409a:vrq_1')!.detail, 'Could you send the latest board deck?');

  await run("UPDATE valuation_requests SET status = 'DELIVERED', appraiser = 'Northwind Appraisals' WHERE id = 'vrq_1'");
  items = (await actions(cid, admin)).items;
  assert.equal(byId(items, '409a:vrq_1')!.title, 'Record the 409A from Northwind Appraisals');
  assert.equal(byId(items, '409a:vrq_1')!.to, '/compliance/409a');

  const priya = await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'priya-pass-1' });
  assert.ok((await actions(cid, priya.token!)).items.every((i) => !i.id.startsWith('409a')));
  await run("UPDATE valuation_requests SET status = 'CANCELLED' WHERE id = 'vrq_1'");
});

test('the compliance checks are worked out again once a write is recorded, without the request waiting on them', async () => {
  await settleChecks(cid);
  const before = await actions(cid, admin);
  assert.equal(byId(before.items, '409a:refresh')?.title, 'No 409A valuation on file');
  assert.equal(before.settlesIn, 0);
  const recorded = await call('POST', `/api/c/${cid}/valuations`, { type: '409A', fairMarketValue: 400_000, effectiveDate: new Date().toISOString().slice(0, 10), provider: 'Northwind Appraisals', status: 'ACTIVE' }, admin);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json));

  // The next answer is the last one, saying when the new one will be in; asking again then has it.
  const stale = await actions(cid, admin);
  assert.ok(stale.settlesIn > 0, 'the checks are due again');
  assert.equal(byId(stale.items, '409a:refresh')?.title, 'No 409A valuation on file');
  await settleChecks(cid);
  const fresh = await actions(cid, admin);
  assert.equal(fresh.settlesIn, 0);
  assert.equal(byId(fresh.items, '409a:refresh'), undefined);
  // Someone who sees only their own items never waits for the checks.
  const priya = await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'priya-pass-1' });
  assert.equal((await actions(cid, priya.token!)).settlesIn, 0);
});
