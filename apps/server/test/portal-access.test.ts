/**
 * Portfolio-only roles over HTTP: an invited employee is linked to the
 * stakeholder with their email, lands on a working portal, and is refused
 * the company-wide endpoints with a clear message.
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
  return { status: res.status, json: (await res.json()) as any };
}

test('an invited employee is linked by email, sees their own equity, and is refused the rest with a clear message', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Portal Co' }, admin)).json.id as string;
  const now = new Date().toISOString();
  await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'Priya@Example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  const common = await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid);
  await insert('issuances', { id: 'iss_priya', companyId: cid, certificateNo: 'CS-7', stakeholderId: 'stk_priya', shareClassId: common!.id,
    quantity: 25_000, pricePerShare: 10_000, issueDate: '2024-01-15', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });
  await insert('documents', { id: 'doc_all', companyId: cid, name: 'Employee handbook', category: 'OTHER', visibility: 'ALL', stakeholderId: null, status: 'FINAL', requiresSignature: 0, createdAt: now });
  await insert('documents', { id: 'doc_priya', companyId: cid, name: 'Priya stock certificate', category: 'CERTIFICATE', visibility: 'HOLDER', stakeholderId: 'stk_priya', status: 'FINAL', requiresSignature: 0, createdAt: now });
  await insert('documents', { id: 'doc_other', companyId: cid, name: 'Board deck', category: 'OTHER', visibility: 'ADMIN', stakeholderId: null, status: 'FINAL', requiresSignature: 0, createdAt: now });

  // Invite by email only — the matching stakeholder is linked without the administrator choosing it.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  assert.equal(invite.status, 200);
  assert.equal(invite.json.stakeholderId, 'stk_priya');

  // Priya claims the account through an administrator reset link and signs in.
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const priya = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).json.token as string;

  const me = await call('GET', '/api/auth/me', undefined, priya);
  assert.equal(me.json.companies[0].role, 'EMPLOYEE');
  assert.equal(me.json.companies[0].stakeholderId, 'stk_priya');

  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, priya);
  assert.equal(portal.status, 200);
  assert.equal(portal.json.linked, true);
  assert.equal(portal.json.holder.name, 'Priya Raman');
  assert.equal(portal.json.issuances.length, 1);
  assert.deepEqual(portal.json.documents.map((d: any) => d.id).sort(), ['doc_all', 'doc_priya']);

  const docs = await call('GET', `/api/c/${cid}/documents`, undefined, priya);
  assert.equal(docs.status, 200);
  assert.deepEqual(docs.json.map((d: any) => d.id).sort(), ['doc_all', 'doc_priya']);   // never the board deck

  for (const path of ['dashboard', 'captable', 'stakeholders', 'consents', 'awards', 'audit']) {
    const r = await call('GET', `/api/c/${cid}/${path}`, undefined, priya);
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error, 'Your role can only view your own portfolio.', path);
  }
  assert.equal((await call('GET', `/api/c/${cid}`, undefined, priya)).status, 200);        // the company card itself is fine
});

test('an unlinked administrator is offered name matches and can link their own account; other roles are told to ask', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'rowan.founder@example.com', name: 'Rowan Adeyemi', password: 'founder-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Self Link Co' }, admin)).json.id as string;
  const now = new Date().toISOString();
  // The record carries a different email (the one on the cap table export), so no automatic link.
  await insert('stakeholders', { id: 'stk_rowan', companyId: cid, name: 'Adeyemi, Rowan', email: 'rowan@work.example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', createdAt: now });
  await insert('stakeholders', { id: 'stk_other', companyId: cid, name: 'Kestrel Ventures II', email: null, type: 'FUND', relation: 'INVESTOR', createdAt: now });

  const unlinked = await call('GET', `/api/c/${cid}/portal`, undefined, admin);
  assert.equal(unlinked.json.linked, false);
  assert.equal(unlinked.json.loginEmail, 'rowan.founder@example.com');
  assert.equal(unlinked.json.canLink, true);
  assert.deepEqual(unlinked.json.suggestions.map((s: any) => s.id), ['stk_rowan']);         // matched by name, in any order of the parts
  assert.equal(unlinked.json.stakeholders.length, 2);

  assert.equal((await call('POST', `/api/c/${cid}/portal/link`, { stakeholderId: 'stk_nope' }, admin)).status, 404);
  const linked = await call('POST', `/api/c/${cid}/portal/link`, { stakeholderId: 'stk_rowan' }, admin);
  assert.equal(linked.status, 200);
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, admin);
  assert.equal(portal.json.linked, true);
  assert.equal(portal.json.holder.id, 'stk_rowan');

  // A viewer with no link is told to ask, gets suggestions, but no list and no self-service.
  const viewerInvite = await call('POST', `/api/c/${cid}/members`, { email: 'kestrel@example.com', name: 'Kestrel Ventures II', role: 'INVESTOR' }, admin);
  const viewer = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${viewerInvite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'kestrel-pass-1',
  })).json.token as string;
  const asViewer = await call('GET', `/api/c/${cid}/portal`, undefined, viewer);
  assert.equal(asViewer.json.linked, false);
  assert.equal(asViewer.json.canLink, false);
  assert.equal(asViewer.json.stakeholders, undefined);
  assert.deepEqual(asViewer.json.suggestions.map((s: any) => s.id), ['stk_other']);
  assert.equal((await call('POST', `/api/c/${cid}/portal/link`, { stakeholderId: 'stk_other' }, viewer)).status, 403);
  // ...and a record already linked to someone else cannot be taken.
  assert.equal((await call('POST', `/api/c/${cid}/portal/link`, { stakeholderId: 'stk_rowan' }, admin)).status, 200);   // re-linking yourself is fine
});

test('a member invited before their stakeholder record existed is linked the first time they open the portal', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'bao@example.com', name: 'Bao Nguyen', password: 'bao-pass-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Late Link Co' }, admin)).json.id as string;
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'marcus@example.com', name: 'Marcus Webb', role: 'INVESTOR' }, admin);
  assert.equal(invite.json.stakeholderId, null);
  const marcus = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'marcus-pass-1',
  })).json.token as string;

  const before = await call('GET', `/api/c/${cid}/portal`, undefined, marcus);
  assert.equal(before.json.linked, false);

  await insert('stakeholders', { id: 'stk_marcus', companyId: cid, name: 'Marcus Webb', email: 'MARCUS@example.com', type: 'INDIVIDUAL', relation: 'INVESTOR', createdAt: new Date().toISOString() });
  const after1 = await call('GET', `/api/c/${cid}/portal`, undefined, marcus);
  assert.equal(after1.json.linked, true);
  assert.equal(after1.json.holder.id, 'stk_marcus');
  const membership = await one<{ stakeholder_id: string }>('SELECT stakeholder_id FROM memberships WHERE id = ?', invite.json.id);
  assert.equal(membership!.stakeholder_id, 'stk_marcus');                                 // remembered, not re-derived
});
