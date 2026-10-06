/**
 * Issuing shares for signature, over HTTP: the certificate waits outside the
 * cap table until the holder and the Company have both signed on the
 * platform, then becomes outstanding and enters the ledger.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

delete process.env.SMTP_URL;
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
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

test('shares issued for signature stay pending until both parties sign, then become outstanding', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Signing Co', legalName: 'Signing Co, Inc.' }, admin)).json.id as string;
  const now = new Date().toISOString();
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const schedule = (await one<{ id: string; name: string }>("SELECT id, name FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!;
  await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
  await insert('issuances', { id: 'iss_existing', companyId: cid, certificateNo: 'CS-1', stakeholderId: 'stk_priya', shareClassId: common, quantity: 1_000,
    pricePerShare: 100, issueDate: '2024-01-01', status: 'OUTSTANDING', earlyExercised: 0, createdAt: now });

  // Issue for signature: certificate number assigned, document and two blocks created, nothing outstanding yet.
  const issued = await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, {
    stakeholderId: 'stk_priya', shareClassId: common, quantity: 50_000, pricePerShare: 1_000_000, issueDate: '2026-09-21',
    vestingScheduleId: schedule.id, boardApprovalDate: '2026-09-15', signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer',
    message: 'Welcome aboard.',
  }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.issuance.status, 'PENDING_SIGNATURE');
  assert.equal(issued.json.issuance.certificateNo, 'CS-2');
  assert.equal(issued.json.emailed, false);                                                // no mail server in tests
  assert.equal(issued.json.document.category, 'CERTIFICATE');
  assert.equal(issued.json.document.status, 'AWAITING_SIGNATURE');
  assert.match(issued.json.document.body, /STOCK CERTIFICATE No\. CS-2/);
  assert.match(issued.json.document.body, /50,000 shares of Common Stock, par value \$[\d.]+ per share, of Signing Co, Inc\./);
  assert.match(issued.json.document.body, new RegExp(`"${schedule.name}" vesting schedule`));
  assert.match(issued.json.document.body, /Welcome aboard/);
  assert.equal(issued.json.signatures.length, 2);
  const companyBlock = issued.json.signatures.find((s: any) => s.stakeholderId == null);
  const holderBlock = issued.json.signatures.find((s: any) => s.stakeholderId === 'stk_priya');
  assert.match(companyBlock.signerName, /Avery Stone, Chief Executive Officer — for the Company/);

  const before = await call('GET', `/api/c/${cid}/captable`, undefined, admin);
  assert.equal(before.json.table.totals.outstanding, 1_000);                               // the pending certificate does not count
  assert.equal((await one<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE security_id = ?', issued.json.issuance.id))!.n, 0);
  assert.equal((await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, { stakeholderId: 'stk_priya', shareClassId: common, quantity: 10, certificateNo: 'cs-2', issueDate: '2026-09-21' }, admin)).status, 400);   // duplicate number

  // The holder sees the certificate text in their portal and signs their block — but not the Company's.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  const priya = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'priya-pass-1',
  })).token as string;
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, priya);
  assert.equal(portal.json.pendingSignatures.length, 1);
  assert.equal(portal.json.pendingSignatures[0].id, holderBlock.id);
  assert.match(portal.json.pendingSignatures[0].documentBody, /STOCK CERTIFICATE No\. CS-2/);
  assert.equal(portal.json.issuances.length, 1);                                           // only the outstanding certificate shows as owned
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${companyBlock.id}/sign`, { typedSignature: 'Priya Raman' }, priya)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${holderBlock.id}/sign`, { typedSignature: 'P' }, priya)).status, 400);
  const signed = await call('POST', `/api/c/${cid}/signatures/${holderBlock.id}/sign`, { typedSignature: 'Priya Raman' }, priya);
  assert.equal(signed.status, 200);
  assert.equal(signed.json.status, 'SIGNED');
  assert.equal((await one<{ status: string }>('SELECT status FROM issuances WHERE id = ?', issued.json.issuance.id))!.status, 'PENDING_SIGNATURE');   // still waiting for the Company

  // A reminder now has nothing to remind: the holder has signed.
  assert.equal((await call('POST', `/api/c/${cid}/issuances/${issued.json.issuance.id}/remind`, {}, admin)).status, 400);

  // The Company countersigns: the certificate executes, the shares are outstanding and in the ledger.
  const counter = await call('POST', `/api/c/${cid}/signatures/${companyBlock.id}/sign`, { typedSignature: 'Avery Stone' }, admin);
  assert.equal(counter.status, 200);
  const iss = await one<{ status: string }>('SELECT status FROM issuances WHERE id = ?', issued.json.issuance.id);
  assert.equal(iss!.status, 'OUTSTANDING');
  assert.equal((await one<{ status: string }>('SELECT status FROM documents WHERE id = ?', issued.json.document.id))!.status, 'EXECUTED');
  const tx = await one<{ quantity: number; amount: number; type: string }>('SELECT * FROM transactions WHERE security_id = ?', issued.json.issuance.id);
  assert.equal(tx!.type, 'ISSUANCE');
  assert.equal(Number(tx!.quantity), 50_000);
  assert.equal(Number(tx!.amount), 50_000 * 100);                                          // $1.00 × 50,000 in cents
  const after1 = await call('GET', `/api/c/${cid}/captable`, undefined, admin);
  assert.equal(after1.json.table.totals.outstanding, 51_000);
  assert.equal((await call('GET', `/api/c/${cid}/portal`, undefined, priya)).json.issuances.length, 2);
  assert.ok((await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.some((a: any) => a.action === 'ISSUANCE_EXECUTED'));

  // Withdrawal: a pending certificate can be taken back with its document; an executed one cannot.
  const second = await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, { stakeholderId: 'stk_priya', shareClassId: common, quantity: 5, pricePerShare: 0, issueDate: '2026-09-21' }, admin);
  assert.equal(second.json.issuance.certificateNo, 'CS-3');
  const remind = await call('POST', `/api/c/${cid}/issuances/${second.json.issuance.id}/remind`, {}, admin);
  assert.equal(remind.status, 200);
  assert.equal(remind.json.emailed, false);
  assert.match(remind.json.reason, /not configured/);
  assert.equal((await call('POST', `/api/c/${cid}/issuances/${second.json.issuance.id}/cancel-signing`, {}, admin)).status, 200);
  assert.equal(await one('SELECT 1 FROM issuances WHERE id = ?', second.json.issuance.id), undefined);
  assert.equal(await one('SELECT 1 FROM documents WHERE id = ?', second.json.document.id), undefined);
  assert.equal(await one('SELECT 1 FROM signatures WHERE document_id = ?', second.json.document.id), undefined);
  assert.equal((await call('POST', `/api/c/${cid}/issuances/${issued.json.issuance.id}/cancel-signing`, {}, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, { stakeholderId: 'stk_priya', shareClassId: common, quantity: 5, issueDate: '2026-09-21' }, priya)).status, 403);
});

test('the certificate signing email carries the facts and the link in both parts, and escapes names', async () => {
  const { composeHolderSigningEmail } = await import('../src/routes/workflows.ts');
  const { config, mailSignature } = await import('../src/config.ts');
  const link = 'http://localhost:5173/portal';
  const facts = {
    to: 'priya@example.com', toName: 'Priya Raman', companyName: 'Tidewater Labs', shares: 10_000, className: 'Common Stock',
    reminder: false, what: 'certificate' as const, link, reference: 'CS-3', date: '2026-03-03',
  };
  const m = composeHolderSigningEmail(facts);
  assert.equal(m.to, 'priya@example.com');
  assert.equal(m.toName, 'Priya Raman');
  assert.equal(m.replyTo, undefined, 'no reply-to: the company is contacted directly');
  assert.equal(m.subject, 'Tidewater Labs: sign your share certificate');
  assert.ok(m.subject.length <= 60);
  assert.ok(m.html, 'an HTML part');
  for (const part of [m.text, m.html!]) {
    assert.ok(part.includes(link), 'the portal link');
    assert.ok(part.includes('Review and sign'));
    assert.ok(part.includes('10,000 shares of Common Stock'));
    assert.ok(part.includes('CS-3'));
    assert.ok(part.includes('March 3, 2026'));
    assert.ok(part.includes('Waiting for your signature'));
    assert.match(part, /What happens next/i);
    assert.ok(part.includes(`— ${mailSignature()}`));
    assert.ok(part.includes(`manages its equity with ${config().brand.productName}`), 'the footer says why');
  }
  assert.match(m.text, /^Hi Priya Raman,\n\nTidewater Labs has issued you 10,000 shares of Common Stock\./);
  assert.ok(!m.text.includes('!'), 'no exclamation marks');

  const reminder = composeHolderSigningEmail({ ...facts, reminder: true });
  assert.equal(reminder.subject, 'Tidewater Labs: reminder to sign your share certificate');
  assert.match(reminder.text, /This is a reminder from Tidewater Labs: your share certificate for 10,000 shares of Common Stock is still waiting/);
  assert.ok(reminder.html!.includes(link) && reminder.text.includes(link));

  // Without a number or date on record, those rows are left out rather than shown empty.
  const bare = composeHolderSigningEmail({ ...facts, reference: null, date: null });
  assert.ok(!bare.text.includes('Certificate number') && !bare.text.includes('Issue date'));

  const hostile = '<script>x</script>';
  const h = composeHolderSigningEmail({ ...facts, toName: hostile, companyName: hostile, className: hostile });
  assert.ok(!h.html!.includes('<script>'), 'no markup from a name');
  assert.ok(h.html!.includes('&lt;script&gt;x&lt;/script&gt;'), 'shown as text');
});
