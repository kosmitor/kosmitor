/**
 * Raising with SAFEs over HTTP: one set of terms for several investors, a
 * single board consent, an agreement per investor signed on the platform,
 * funds tracked separately. Pending instruments stay out of the conversion math.
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
await import('../src/routes/fundraising.ts');
await import('../src/routes/data.ts');
const { insert, one, all } = await import('../src/db.ts');

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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Raiseco', legalName: 'Raiseco, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
await insert('stakeholders', { id: 'stk_halcyon', companyId: cid, name: 'Halcyon Ventures', email: 'deals@halcyon.example.com', type: 'FUND', relation: 'INVESTOR', createdAt: now });
await insert('stakeholders', { id: 'stk_noor', companyId: cid, name: 'Noor Haddad', email: 'noor@example.com', type: 'INDIVIDUAL', relation: 'INVESTOR', createdAt: now });
await insert('stakeholders', { id: 'stk_dana', companyId: cid, name: 'Dana Okafor', email: 'dana@example.com', type: 'INDIVIDUAL', relation: 'BOARD_MEMBER', boardSeat: 1, createdAt: now });
const terms = { instrument: 'SAFE_POST', valuationCap: 1_200_000_000, discount: 0.2, mfn: true, proRataRight: true };
const signing = { signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer', message: 'Thank you for backing us.' };

test('a batch of SAFEs goes through one consent, then agreements each investor signs; only executed ones count', async () => {
  const issued = await call('POST', `/api/c/${cid}/convertibles/issue`, {
    terms, issueDate: '2026-09-21', approval: 'REQUEST', directorIds: ['stk_dana'], signing,
    investors: [{ stakeholderId: 'stk_halcyon', principal: 25_000_000 }, { stakeholderId: 'stk_noor', principal: 5_000_000 }],
  }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.convertibles.length, 2);
  assert.deepEqual(issued.json.convertibles.map((c: any) => c.status), ['PENDING_APPROVAL', 'PENDING_APPROVAL']);
  assert.deepEqual(issued.json.convertibles.map((c: any) => c.label), ['SAFE-1', 'SAFE-2']);
  assert.equal(issued.json.documents.length, 0);                                                 // no agreement before the board approves
  assert.equal(issued.json.consent.linkedEntityType, 'convertibles');
  assert.deepEqual(JSON.parse(issued.json.consent.linkedEntityIds), issued.json.convertibles.map((c: any) => c.id));
  assert.match(issued.json.consent.title, /Approve 2 Post-money SAFEs totalling \$300,000\.00/);
  assert.match(issued.json.consent.body, /post-money valuation cap of \$12,000,000\.00 and a 20% discount/);
  assert.equal((await call('GET', `/api/c/${cid}/model/convertibles`, undefined, admin)).json.count, 0);   // pending: not in the stack

  const voted = await call('POST', `/api/c/${cid}/consents/${issued.json.consent.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_dana' }, admin);
  assert.equal(voted.json.status, 'APPROVED');
  const [halcyon, noor] = issued.json.convertibles as { id: string }[];
  for (const c of [halcyon, noor]) {
    const row = await one<{ status: string; board_approval_date: string }>('SELECT status, board_approval_date FROM convertibles WHERE id = ?', c.id);
    assert.equal(row!.status, 'PENDING_SIGNATURE');
    assert.equal(row!.board_approval_date, '2026-09-21');
  }
  const doc = await one<{ id: string; name: string; body: string; status: string }>("SELECT * FROM documents WHERE security_id = ? AND category = 'CONVERTIBLE_AGREEMENT'", halcyon.id);
  assert.equal(doc!.status, 'AWAITING_SIGNATURE');
  assert.equal(doc!.name, 'Post-money SAFE SAFE-1 — Halcyon Ventures');
  assert.match(doc!.body, /SIMPLE AGREEMENT FOR FUTURE EQUITY — Post-money SAFE/);
  assert.match(doc!.body, /^THIS INSTRUMENT AND ANY SECURITIES ISSUABLE PURSUANT HERETO HAVE NOT BEEN REGISTERED/, 'the signers read the legend first');
  {
    // The certificate-style front page, stored with the document.
    const { parseFace } = await import('../src/certificate-face.ts');
    const stored = await one<{ face: string | null }>('SELECT face FROM documents WHERE id = ?', doc!.id);
    const face = parseFace(stored!.face)!;
    assert.equal(face.kind, 'SAFE');
    assert.equal(face.idLabel, 'ID: SAFE-1');
    assert.equal(face.amountLabel, '$250,000');
    assert.deepEqual(face.watermark, ['SIMPLE AGREEMENT', 'FOR FUTURE EQUITY']);
    assert.match(face.paragraphs[0].map((r) => r.text).join(''), /Halcyon Ventures has paid \$250,000 \(the "Purchase Amount"\)/);
    assert.deepEqual(face.signers.map((s) => s.role), ['COMPANY', 'HOLDER']);
    assert.match(face.back, /^THIS INSTRUMENT AND ANY SECURITIES/, 'the legend opens the pages after the face');
    assert.match(face.back, /SIMPLE AGREEMENT FOR FUTURE EQUITY — Post-money SAFE/);
  }
  assert.match(doc!.body, /payment by Halcyon Ventures \(the "Investor"\) of \$250,000\.00/);
  assert.match(doc!.body, /post-money valuation of \$12,000,000\.00 \(the "Valuation Cap"\) and \(b\) the price paid by the financing's investors less a 20% discount/);
  assert.match(doc!.body, /The Investor may invest in the Equity Financing/);
  assert.match(doc!.body, /may adopt those terms/);
  assert.doesNotMatch(doc!.body, /INTEREST AND MATURITY/);
  assert.match(doc!.body, /Thank you for backing us\./);
  assert.equal((await call('GET', `/api/c/${cid}/model/convertibles`, undefined, admin)).json.count, 0);   // still pending

  // The investor signs from the portal; the Company countersigns; the SAFE is outstanding.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'deals@halcyon.example.com', name: 'Halcyon Ventures', role: 'INVESTOR' }, admin);
  const investor = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'halcyon-pass-1',
  })).token as string;
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, investor);
  assert.equal(portal.json.pendingSignatures.length, 1);
  assert.match(portal.json.pendingSignatures[0].documentBody, /SIMPLE AGREEMENT FOR FUTURE EQUITY/);
  assert.equal((await call('POST', `/api/c/${cid}/convertibles/issue`, { terms, investors: [{ stakeholderId: 'stk_halcyon', principal: 1 }], approval: 'NONE' }, investor)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${portal.json.pendingSignatures[0].id}/sign`, { typedSignature: 'Halcyon Ventures' }, investor)).status, 200);
  assert.equal((await call('POST', `/api/c/${cid}/convertibles/${halcyon.id}/remind`, {}, admin)).status, 400);   // the investor has signed already
  const companyBlock = (await all<{ id: string }>("SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id IS NULL", doc!.id))[0];
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${companyBlock.id}/sign`, { typedSignature: 'Avery Stone' }, admin)).status, 200);
  assert.equal((await one<{ status: string }>('SELECT status FROM convertibles WHERE id = ?', halcyon.id))!.status, 'OUTSTANDING');
  assert.equal((await one<{ status: string }>('SELECT status FROM documents WHERE id = ?', doc!.id))!.status, 'EXECUTED');
  const stack = await call('GET', `/api/c/${cid}/model/convertibles`, undefined, admin);
  assert.equal(stack.json.count, 1);
  assert.equal(stack.json.totalPrincipal, 25_000_000);
  assert.ok((await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.some((a: any) => a.action === 'CONVERTIBLE_EXECUTED'));

  // Money arrives; the other SAFE is reminded then withdrawn with its agreement.
  const funded = await call('POST', `/api/c/${cid}/convertibles/${halcyon.id}/funds-received`, { receivedOn: '2026-09-23', reference: 'Wire 4471' }, admin);
  assert.equal(funded.status, 200, JSON.stringify(funded.json));
  assert.equal(funded.json.fundsReceivedOn, '2026-09-23');
  assert.equal(funded.json.fundsReference, 'Wire 4471');
  const remind = await call('POST', `/api/c/${cid}/convertibles/${noor.id}/remind`, {}, admin);
  assert.equal(remind.status, 200);
  assert.match(remind.json.reason, /not configured/);
  const noorDoc = await one<{ id: string }>("SELECT id FROM documents WHERE security_id = ?", noor.id);
  assert.equal((await call('POST', `/api/c/${cid}/convertibles/${noor.id}/cancel-signing`, {}, admin)).status, 200);
  assert.equal(await one('SELECT 1 FROM convertibles WHERE id = ?', noor.id), undefined);
  assert.equal(await one('SELECT 1 FROM documents WHERE id = ?', noorDoc!.id), undefined);
  assert.equal((await call('POST', `/api/c/${cid}/convertibles/${halcyon.id}/cancel-signing`, {}, admin)).status, 400);   // outstanding: not withdrawable
});

test('notes and directly recorded instruments; validation of terms', async () => {
  const note = await call('POST', `/api/c/${cid}/convertibles/issue`, {
    terms: { instrument: 'NOTE', valuationCap: 800_000_000, discount: 0.15, interestRate: 0.08, compounding: 'ANNUAL', maturityDate: '2028-09-21', mfn: false, proRataRight: false },
    issueDate: '2026-09-21', approval: 'APPROVED', boardApprovalDate: '2026-09-20', signing,
    investors: [{ stakeholderId: 'stk_noor', principal: 10_000_000, label: 'NOTE-A' }],
  }, admin);
  assert.equal(note.status, 200, JSON.stringify(note.json));
  assert.equal(note.json.convertibles[0].status, 'PENDING_SIGNATURE');
  assert.equal(note.json.convertibles[0].label, 'NOTE-A');
  assert.equal(note.json.convertibles[0].boardApprovalDate, '2026-09-20');
  assert.equal(note.json.consent, null);
  assert.equal(note.json.documents.length, 1);
  assert.match(note.json.documents[0].body, /CONVERTIBLE PROMISSORY NOTE — Convertible note/);
  assert.match(note.json.documents[0].body, /bears interest at 8% per year, compounded annually/);
  assert.match(note.json.documents[0].body, /due on 2028-09-21/);
  assert.match(note.json.documents[0].body, /pre-money valuation of \$8,000,000\.00/);
  assert.match(note.json.documents[0].body, /The Investor has no rights as a stockholder/);
  assert.doesNotMatch(note.json.documents[0].body, /maintain its as-converted ownership/);

  const direct = await call('POST', `/api/c/${cid}/convertibles/issue`, {
    terms: { instrument: 'SAFE_PRE', discount: 0.1 }, issueDate: '2026-09-21', approval: 'NONE', signing: null,
    investors: [{ stakeholderId: 'stk_noor', principal: 2_000_000 }],
  }, admin);
  assert.equal(direct.status, 200, JSON.stringify(direct.json));
  assert.equal(direct.json.convertibles[0].status, 'OUTSTANDING');
  assert.match(direct.json.convertibles[0].label, /^SAFE-\d+$/);
  assert.equal(direct.json.convertibles[0].valuationCap, null);
  assert.equal((await call('GET', `/api/c/${cid}/model/convertibles`, undefined, admin)).json.count, 2);   // the executed SAFE and the direct one

  const bad = (body: unknown) => call('POST', `/api/c/${cid}/convertibles/issue`, body, admin);
  assert.equal((await bad({ terms, investors: [], approval: 'NONE' })).status, 400);
  assert.equal((await bad({ terms: { ...terms, discount: 1.5 }, investors: [{ stakeholderId: 'stk_noor', principal: 1 }], approval: 'NONE' })).status, 400);
  assert.equal((await bad({ terms, investors: [{ stakeholderId: 'stk_nobody', principal: 1 }], approval: 'NONE' })).status, 400);
  assert.equal((await bad({ terms, investors: [{ stakeholderId: 'stk_noor', principal: 1 }], approval: 'REQUEST', directorIds: [] })).status, 400);
  assert.equal((await bad({ terms: { instrument: 'NOTE', interestRate: 2 }, investors: [{ stakeholderId: 'stk_noor', principal: 1 }], approval: 'NONE' })).status, 400);
  assert.equal((await bad({ terms: { instrument: 'BOND' }, investors: [{ stakeholderId: 'stk_noor', principal: 1 }], approval: 'NONE' })).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/convertibles/${direct.json.convertibles[0].id}/funds-received`, { receivedOn: 'soon' }, admin)).status, 400);
});

test('the SAFE and note signing emails carry the facts and the link in both parts, and escape names', async () => {
  const { composeInvestorSigningEmail } = await import('../src/routes/fundraising.ts');
  const { config, mailSignature } = await import('../src/config.ts');
  const link = 'http://localhost:5173/portal';
  const facts = {
    to: 'deals@halcyon.example.com', toName: 'Halcyon Ventures', companyName: 'Tidewater Labs', principal: 25_000_000,
    instrument: 'Post-money SAFE', reminder: false, link, reference: 'SAFE-1', date: '2026-03-03',
  };
  const m = composeInvestorSigningEmail(facts);
  assert.equal(m.to, 'deals@halcyon.example.com');
  assert.equal(m.toName, 'Halcyon Ventures');
  assert.equal(m.replyTo, undefined);
  assert.equal(m.subject, 'Tidewater Labs: your post-money SAFE is ready to sign');
  assert.ok(m.subject.length <= 60);
  assert.ok(m.html, 'an HTML part');
  for (const part of [m.text, m.html!]) {
    assert.ok(part.includes(link), 'the portal link');
    assert.ok(part.includes('Review and sign'));
    assert.ok(part.includes('Post-money SAFE'));
    assert.ok(part.includes('$250,000'), 'a whole amount without cents');
    assert.ok(part.includes('SAFE-1'));
    assert.ok(part.includes('March 3, 2026'));
    assert.ok(part.includes('Waiting for your signature'));
    assert.ok(part.includes('A SAFE is an agreement for future shares'), 'the term explained once');
    assert.ok(part.includes(`— ${mailSignature()}`));
    assert.ok(part.includes(`manages its equity with ${config().brand.productName}`));
  }
  assert.match(m.text, /^Hi Halcyon Ventures,\n\nTidewater Labs has prepared your post-money SAFE for \$250,000\./);
  assert.ok(!m.text.includes('!'), 'no exclamation marks');

  const reminder = composeInvestorSigningEmail({ ...facts, reminder: true });
  assert.equal(reminder.subject, 'Tidewater Labs: reminder to sign your post-money SAFE');
  assert.match(reminder.text, /This is a reminder from Tidewater Labs: your post-money SAFE for \$250,000 is still waiting/);
  assert.ok(reminder.html!.includes(link) && reminder.text.includes(link));

  const note = composeInvestorSigningEmail({ ...facts, instrument: 'Convertible note', principal: 123_450 });
  assert.equal(note.subject, 'Tidewater Labs: your convertible note is ready to sign');
  assert.ok(note.text.includes('$1,234.50'), 'cents kept when there are some');
  assert.ok(note.text.includes('A convertible note is a loan to the company'));

  const hostile = '<script>x</script>';
  const h = composeInvestorSigningEmail({ ...facts, toName: hostile, companyName: hostile, instrument: hostile });
  assert.ok(!h.html!.includes('<script>'), 'no markup from a name');
  assert.ok(h.html!.includes('&lt;script&gt;x&lt;/script&gt;'), 'shown as text');
});
