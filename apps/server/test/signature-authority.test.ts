/**
 * Who may sign what.
 *
 * A certificate carries two signature blocks: the holder's, and the company's.
 * Completing the second one executes the document, makes the shares outstanding
 * and writes the ledger, so it belongs to an officer. The company's block has no
 * stakeholder against it, and neither does the membership of anyone invited by
 * an email that matches no stakeholder, which is why the two must never be
 * allowed to match each other.
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
await import('../src/routes/workflows.ts');
await import('../src/routes/certificates.ts');
const { one, all } = await import('../src/db.ts');

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

async function join(email: string, name: string, role: string, adminToken: string, cid: string, stakeholderId?: string) {
  const invite = await call('POST', `/api/c/${cid}/members`, { email, name, role, ...(stakeholderId ? { stakeholderId } : {}) }, adminToken);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, adminToken);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  return (await call('POST', '/api/auth/reset', { token, password: `${name.replace(/\W/g, '')}-pass-1` })).token as string;
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Signing Co' }, admin)).json.id as string;
const common = (await call('GET', `/api/c/${cid}/share-classes`, undefined, admin)).json[0];
const holder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE' }, admin)).json;

const issued = await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, {
  certificateNo: 'CS-7', stakeholderId: holder.id, shareClassId: common.id,
  quantity: 50_000, pricePerShare: 10_000, issueDate: '2024-01-15',
  signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer',
}, admin);

test('a certificate sent for signature waits on the holder and the company', async () => {
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  const blocks = await all<{ id: string; stakeholder_id: string | null }>(
    'SELECT * FROM signatures WHERE company_id = ?', cid);
  assert.equal(blocks.length, 2);
  assert.equal(blocks.filter((b) => b.stakeholder_id == null).length, 1, 'one of them is the company\'s own');
});

test('a member with no stakeholder of their own cannot countersign for the company', async () => {
  // Invited by an email that matches no stakeholder, so their membership carries no link.
  const board = await join('board@example.com', 'Dana Ward', 'BOARD', admin, cid);
  const membership = await one<{ stakeholder_id: string | null }>(
    'SELECT m.stakeholder_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'board@example.com');
  assert.equal(membership!.stakeholder_id, null, 'the setup this guard has to survive');

  const companyBlock = await one<{ id: string }>('SELECT id FROM signatures WHERE company_id = ? AND stakeholder_id IS NULL', cid);
  const attempt = await call('POST', `/api/c/${cid}/signatures/${companyBlock!.id}/sign`, { typedSignature: 'Dana Ward' }, board);
  assert.equal(attempt.status, 403, 'signing for the company issues the shares, so it is an officer\'s act');
  assert.match(attempt.json.error, /assigned to someone else/);

  const still = await one<{ status: string }>('SELECT status FROM signatures WHERE id = ?', companyBlock!.id);
  assert.equal(still!.status, 'PENDING');
});

test('the holder signs their own block, and only their own', async () => {
  const priya = await join('priya@example.com', 'Priya Raman', 'EMPLOYEE', admin, cid, holder.id);
  const companyBlock = await one<{ id: string }>('SELECT id FROM signatures WHERE company_id = ? AND stakeholder_id IS NULL', cid);
  const theirs = await one<{ id: string }>('SELECT id FROM signatures WHERE company_id = ? AND stakeholder_id = ?', cid, holder.id);

  const notTheirs = await call('POST', `/api/c/${cid}/signatures/${companyBlock!.id}/sign`, { typedSignature: 'Priya Raman' }, priya);
  assert.equal(notTheirs.status, 403);

  const own = await call('POST', `/api/c/${cid}/signatures/${theirs!.id}/sign`, { typedSignature: 'Priya Raman' }, priya);
  assert.equal(own.status, 200, JSON.stringify(own.json));
});

test('an officer countersigns, and that is what makes the shares outstanding', async () => {
  const companyBlock = await one<{ id: string }>('SELECT id FROM signatures WHERE company_id = ? AND stakeholder_id IS NULL', cid);
  const signed = await call('POST', `/api/c/${cid}/signatures/${companyBlock!.id}/sign`, { typedSignature: 'Avery Stone' }, admin);
  assert.equal(signed.status, 200, JSON.stringify(signed.json));

  const issuance = await one<{ status: string }>('SELECT status FROM issuances WHERE company_id = ?', cid);
  assert.equal(issuance!.status, 'OUTSTANDING', 'both signatures in, so the shares are live');
});
