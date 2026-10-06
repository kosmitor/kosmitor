/**
 * Stockholder approvals weighted by voting shares, consents closed without a
 * vote, holders voting from the portal, company signatories, and the portal
 * visibility settings.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/company.ts');
await import('../src/routes/data.ts');
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
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
async function memberToken(cid: string, admin: string, email: string, name: string, role: string): Promise<string> {
  const invite = await call('POST', `/api/c/${cid}/members`, { email, name, role }, admin);
  const link = (await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl;
  return (await call('POST', '/api/auth/reset', { token: new URL(link).searchParams.get('token'), password: `${name.split(' ')[0].toLowerCase()}-pass-1` })).token as string;
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Voteco' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
for (const [id, name, email, relation, qty] of [
  ['stk_avery', 'Avery Stone', 'avery@example.com', 'FOUNDER', 6_000_000], ['stk_halcyon', 'Halcyon Ventures', 'deals@halcyon.example.com', 'INVESTOR', 3_000_000],
  ['stk_noor', 'Noor Haddad', 'noor@example.com', 'INVESTOR', 1_000_000], ['stk_priya', 'Priya Raman', 'priya@example.com', 'EMPLOYEE', 0],
] as [string, string, string, string, number][]) {
  await insert('stakeholders', { id, companyId: cid, name, email, type: 'INDIVIDUAL', relation, createdAt: now });
  if (qty) await insert('issuances', { id: `iss_${id}`, companyId: cid, certificateNo: `CS-${id}`, stakeholderId: id, shareClassId: common, quantity: qty, pricePerShare: 100, issueDate: '2024-01-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
}

test('a stockholder approval is weighted by voting shares and passes at the threshold of all voting shares', async () => {
  const opened = await call('POST', `/api/c/${cid}/consents`, {
    kind: 'STOCKHOLDER', title: 'Approve the 2026 plan increase', body: 'RESOLVED, that the plan be increased by 1,000,000 shares.', effectiveDate: '2026-09-21', threshold: 0.6,
  }, admin);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.kind, 'STOCKHOLDER');
  assert.equal(opened.json.type, 'STOCKHOLDER_CONSENT');
  assert.equal(Number(opened.json.totalWeight), 10_000_000);
  const listed = (await call('GET', `/api/c/${cid}/consents`, undefined, admin)).json.find((c: any) => c.id === opened.json.id);
  assert.equal(listed.votes.length, 3);                                                         // the option-less employee has no vote
  assert.equal(Number(listed.votes.find((v: any) => v.stakeholderId === 'stk_avery').weight), 6_000_000);
  assert.equal(listed.pendingWeight, 10_000_000);

  // The founder (60%) approves alone: 6M of 10M meets the 60% threshold exactly.
  const halcyon = await memberToken(cid, admin, 'deals@halcyon.example.com', 'Halcyon Ventures', 'INVESTOR');
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, halcyon);
  assert.equal(portal.json.pendingVotes.length, 1);
  assert.equal(portal.json.pendingVotes[0].title, 'Approve the 2026 plan increase');
  assert.equal(Number(portal.json.pendingVotes[0].myWeight), 3_000_000);
  assert.equal((await call('POST', `/api/c/${cid}/consents/${opened.json.id}/vote`, { vote: 'REJECT' }, halcyon)).status, 200);   // the investor votes against, from the portal
  let state = (await call('GET', `/api/c/${cid}/consents`, undefined, admin)).json.find((c: any) => c.id === opened.json.id);
  assert.equal(state.status, 'PENDING');
  assert.equal(state.rejectedWeight, 3_000_000);
  assert.equal((await call('GET', `/api/c/${cid}/portal`, undefined, halcyon)).json.pendingVotes.length, 0);
  assert.equal((await call('POST', `/api/c/${cid}/consents/${opened.json.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_avery' }, admin)).status, 200);
  state = (await call('GET', `/api/c/${cid}/consents`, undefined, admin)).json.find((c: any) => c.id === opened.json.id);
  assert.equal(state.status, 'APPROVED');
  assert.equal(state.approvedWeight, 6_000_000);
  assert.ok(state.approvedAt);

  // Two thirds needed: once 3M reject, 6M + 1M pending can no longer reach 6.67M → rejected outright.
  const supermajority = await call('POST', `/api/c/${cid}/consents`, { kind: 'STOCKHOLDER', title: 'Sell the company', threshold: 2 / 3, effectiveDate: '2026-09-21' }, admin);
  assert.equal((await call('POST', `/api/c/${cid}/consents/${supermajority.json.id}/vote`, { vote: 'REJECT', stakeholderId: 'stk_halcyon' }, admin)).json.status, 'PENDING');
  assert.equal((await call('POST', `/api/c/${cid}/consents/${supermajority.json.id}/vote`, { vote: 'REJECT', stakeholderId: 'stk_noor' }, admin)).json.status, 'REJECTED');

  // A subset of voters does not lower the threshold; closing withdraws a pending consent.
  const subset = await call('POST', `/api/c/${cid}/consents`, { kind: 'STOCKHOLDER', title: 'Founder-only vote', stakeholderIds: ['stk_avery'], threshold: 0.5 }, admin);
  assert.equal(Number(subset.json.totalWeight), 10_000_000);
  assert.equal((await call('GET', `/api/c/${cid}/consents`, undefined, admin)).json.find((c: any) => c.id === subset.json.id).votes.length, 1);
  const closed = await call('POST', `/api/c/${cid}/consents/${subset.json.id}/close`, { status: 'WITHDRAWN', note: 'Superseded' }, admin);
  assert.equal(closed.json.status, 'WITHDRAWN');
  assert.equal((await call('POST', `/api/c/${cid}/consents/${subset.json.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_avery' }, admin)).status, 400);   // no votes on a closed consent
  assert.equal((await call('GET', `/api/c/${cid}/consents`, undefined, admin)).json.find((c: any) => c.id === subset.json.id).status, 'WITHDRAWN');
  assert.equal((await call('POST', `/api/c/${cid}/consents/${subset.json.id}/close`, {}, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/consents`, { kind: 'STOCKHOLDER', title: 'x', threshold: 1.5 }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/consents`, { kind: 'STOCKHOLDER', title: 'x', stakeholderIds: ['stk_priya'] }, admin)).status, 400);

  // Board consents still need every director.
  const board = await call('POST', `/api/c/${cid}/consents`, { title: 'Approve grants', directorIds: ['stk_avery'] }, admin);
  assert.equal(board.json.kind, 'BOARD');
  assert.equal((await call('POST', `/api/c/${cid}/consents/${board.json.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_avery' }, admin)).json.status, 'APPROVED');
});

test('signatories and contacts; the default signatory is one per company', async () => {
  assert.equal((await call('GET', `/api/c/${cid}/contacts`, undefined, admin)).json.boardMembers.length, 1);   // the founder
  const first = await call('POST', `/api/c/${cid}/contacts`, { kind: 'SIGNATORY', name: 'Avery Stone', title: 'Chief Executive Officer', email: 'Avery@Example.com', isDefault: true }, admin);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.email, 'avery@example.com');
  const second = await call('POST', `/api/c/${cid}/contacts`, { kind: 'SIGNATORY', name: 'Dana Okafor', title: 'Secretary', isDefault: true }, admin);
  const contacts = await call('GET', `/api/c/${cid}/contacts`, undefined, admin);
  assert.deepEqual(contacts.json.defaultSignatory, { name: 'Dana Okafor', title: 'Secretary' });
  assert.equal(contacts.json.signatories.find((s: any) => s.id === first.json.id).isDefault, 0);
  await call('PATCH', `/api/c/${cid}/contacts/${first.json.id}`, { isDefault: true }, admin);
  assert.equal((await call('GET', `/api/c/${cid}/contacts`, undefined, admin)).json.defaultSignatory.name, 'Avery Stone');
  const counsel = await call('POST', `/api/c/${cid}/contacts`, { kind: 'CONTACT', name: 'Lee & Park LLP', title: 'Outside counsel', email: 'counsel@example.com' }, admin);
  assert.equal((await call('GET', `/api/c/${cid}/contacts`, undefined, admin)).json.contacts.length, 1);
  assert.equal((await call('DELETE', `/api/c/${cid}/contacts/${second.json.id}`, undefined, admin)).status, 200);
  assert.equal((await call('POST', `/api/c/${cid}/contacts`, { kind: 'ROBOT', name: 'x' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/contacts`, { kind: 'CONTACT', name: 'x', email: 'nope' }, admin)).status, 400);
  assert.equal((await call('DELETE', `/api/c/${cid}/contacts/${counsel.json.id}`, undefined, admin)).status, 200);
});

test('portal settings hide ownership, values, documents and updates from holders', async () => {
  const noor = await memberToken(cid, admin, 'noor@example.com', 'Noor Haddad', 'INVESTOR');
  const before = await call('GET', `/api/c/${cid}/portal`, undefined, noor);
  assert.equal(before.json.portalSettings.showOwnership, true);
  assert.ok(before.json.ownershipPct > 0);
  assert.equal(before.json.companyFullyDiluted, 10_000_000);
  assert.equal(typeof before.json.portfolio.fmv, 'number');

  assert.equal((await call('PATCH', `/api/c/${cid}`, { portalSettings: { showOwnership: false, showValuation: false, showDocuments: false } }, admin)).status, 200);
  const after1 = await call('GET', `/api/c/${cid}/portal`, undefined, noor);
  assert.equal(after1.json.portalSettings.showOwnership, false);
  assert.equal(after1.json.ownershipPct, null);
  assert.equal(after1.json.companyFullyDiluted, null);
  assert.equal(after1.json.portfolio.fmv, null);
  assert.equal(after1.json.portfolio.sharesValue, null);
  assert.equal(after1.json.portalSettings.showUpdates, true);                                    // untouched keys keep their default
  assert.equal((await call('PATCH', `/api/c/${cid}`, { portalSettings: 'yes' }, admin)).status, 400);
  assert.equal((await call('PATCH', `/api/c/${cid}`, { portalSettings: null }, admin)).status, 200);
  assert.equal((await call('GET', `/api/c/${cid}/portal`, undefined, noor)).json.ownershipPct > 0, true);
});
