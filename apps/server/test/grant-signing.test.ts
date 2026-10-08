/**
 * Issuing option grants the way a company does it: optionally through a board
 * consent, then an award agreement generated from a template that the holder
 * and the Company sign on the platform. The grant is outside the cap table
 * until both have signed.
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
const cid = (await call('POST', '/api/companies', { name: 'Grantco', legalName: 'Grantco, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string; name: string }>("SELECT id, name FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!;
await insert('pools', { id: 'pool_1', companyId: cid, name: '2026 Stock Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'VP Engineering', createdAt: now });
await insert('stakeholders', { id: 'stk_dana', companyId: cid, name: 'Dana Okafor', email: 'dana@example.com', type: 'INDIVIDUAL', relation: 'BOARD_MEMBER', boardSeat: 1, createdAt: now });
const grant = {
  stakeholderId: 'stk_priya', poolId: 'pool_1', type: 'ISO', quantity: 48_000, strikePrice: 960_000, grantDate: '2026-09-21',
  vestingStartDate: '2026-09-01', vestingScheduleId: schedule.id, ptepMonths: 3, fmvAtGrant: 960_000,
};
const signing = { signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer', message: 'Welcome to Grantco.' };

test('templates: built-ins are listed, a company template can become the default, and previews flag unknown fields', async () => {
  const listed = await call('GET', `/api/c/${cid}/templates`, undefined, admin);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.kinds.map((k: any) => k.kind), ['OPTION_AGREEMENT', 'RSU_AGREEMENT', 'CERTIFICATE', 'OFFER_LETTER', 'CONVERTIBLE_AGREEMENT']);
  assert.equal(listed.json.templates.filter((t: any) => t.builtIn).length, 5);
  assert.ok(listed.json.templates.find((t: any) => t.id === 'builtin:OPTION_AGREEMENT').isDefault);
  assert.ok(listed.json.fields.some((f: any) => f.token === 'grant.quantity'));

  const preview = await call('POST', `/api/c/${cid}/templates/preview`, { body: 'Dear {{holder.name}}, {{grant.quantity}} {{grant.typeName}}s{{#if message}} — {{message}}{{/if}}{{#unless message}} (no note{{#if grant.isIso}}, ISO{{/if}}{{#unless grant.isIso}}, NSO{{/unless}}){{/unless}}. {{bogus.field}}' }, admin);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.rendered, 'Dear Priya Raman, 48,000 Incentive Stock Options (no note, ISO).');   // nested blocks resolve innermost first
  assert.deepEqual(preview.json.unknownTokens, ['bogus.field']);

  const created = await call('POST', `/api/c/${cid}/templates`, {
    kind: 'OPTION_AGREEMENT', name: 'Grantco option agreement', isDefault: true,
    body: 'GRANTCO OPTION AGREEMENT {{grant.label}}\n{{company.legalName}} grants {{holder.name}} ({{holder.title}}) {{grant.quantity}} {{grant.typeName}}s at {{grant.strikePrice}} vesting per "{{grant.vestingSchedule}}".\n{{#if message}}Note: {{message}}{{/if}}\nSigned {{signer.name}}, {{signer.title}}',
  }, admin);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const again = await call('GET', `/api/c/${cid}/templates`, undefined, admin);
  assert.ok(again.json.templates.find((t: any) => t.id === created.json.id).isDefault);
  assert.equal(again.json.templates.find((t: any) => t.id === 'builtin:OPTION_AGREEMENT').isDefault, false);   // the built-in yields to the company default
  assert.equal((await call('POST', `/api/c/${cid}/templates`, { kind: 'NOPE', name: 'x', body: 'y' }, admin)).status, 400);
});

test('a grant issued for signature is outstanding only once the holder and the Company have both signed', async () => {
  const issued = await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, approval: 'APPROVED', boardApprovalDate: '2026-09-15', signing }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.award.status, 'PENDING_SIGNATURE');
  assert.equal(issued.json.award.label, 'OPT-1');
  assert.equal(issued.json.award.boardApprovalDate, '2026-09-15');
  assert.equal(issued.json.award.expirationDate, '2036-09-21');
  assert.equal(issued.json.consent, null);
  assert.equal(issued.json.document.category, 'GRANT_AGREEMENT');
  assert.equal(issued.json.document.status, 'AWAITING_SIGNATURE');
  assert.match(issued.json.document.body, /^GRANTCO OPTION AGREEMENT OPT-1/);                    // the company default template was used
  {
    // The front page comes from the grant; the company's agreement follows it.
    const { parseFace } = await import('../src/certificate-face.ts');
    const face = parseFace(issued.json.document.face)!;
    assert.equal(face.kind, 'OPTION');
    assert.equal(face.idLabel, 'ID: OPT-1');
    assert.equal(face.amountLabel, '48,000 Options');
    assert.deepEqual(face.watermark, ['STOCK', 'OPTION']);
    assert.match(face.paragraphs[0].map((r) => r.text).join(''), /Priya Raman has been granted an Incentive Stock Option to purchase 48,000 shares of Common Stock of Grantco, Inc\./);
    assert.equal(face.back, issued.json.document.body);
  }
  assert.match(issued.json.document.body, /Grantco, Inc\. grants Priya Raman \(VP Engineering\) 48,000 Incentive Stock Options at \$0\.96/);
  assert.match(issued.json.document.body, new RegExp(`vesting per "${schedule.name}"`));
  assert.match(issued.json.document.body, /Note: Welcome to Grantco\./);
  assert.match(issued.json.document.body, /Signed Avery Stone, Chief Executive Officer/);
  assert.equal(issued.json.signatures.length, 2);
  const companyBlock = issued.json.signatures.find((s: any) => s.stakeholderId == null);
  const holderBlock = issued.json.signatures.find((s: any) => s.stakeholderId === 'stk_priya');

  // Not in the plan's usage, the cap table or the ledger while pending.
  const pools = await call('GET', `/api/c/${cid}/pools/summary`, undefined, admin);
  assert.equal(pools.json[0].granted, 0);
  assert.equal((await one<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE security_id = ?', issued.json.award.id))!.n, 0);

  // The holder signs from their portal; the Company's block is not theirs to sign.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, admin);
  const priya = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'priya-pass-1',
  })).token as string;
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, priya);
  assert.equal(portal.json.pendingSignatures.length, 1);
  assert.match(portal.json.pendingSignatures[0].documentBody, /GRANTCO OPTION AGREEMENT/);
  assert.equal(portal.json.portfolio.grants.length, 0);                                                    // nothing granted yet from the holder's point of view
  assert.equal((await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, approval: 'NONE' }, priya)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${companyBlock.id}/sign`, { typedSignature: 'Priya Raman' }, priya)).status, 403);
  const remind = await call('POST', `/api/c/${cid}/awards/${issued.json.award.id}/remind`, {}, admin);
  assert.equal(remind.status, 200);
  assert.equal(remind.json.emailed, false);
  assert.match(remind.json.reason, /not configured/);
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${holderBlock.id}/sign`, { typedSignature: 'Priya Raman' }, priya)).status, 200);
  assert.equal((await one<{ status: string }>('SELECT status FROM awards WHERE id = ?', issued.json.award.id))!.status, 'PENDING_SIGNATURE');
  assert.equal((await call('POST', `/api/c/${cid}/awards/${issued.json.award.id}/remind`, {}, admin)).status, 400);   // nothing left for the holder to sign

  // The Company countersigns: outstanding, accepted, in the plan and the ledger.
  assert.equal((await call('POST', `/api/c/${cid}/signatures/${companyBlock.id}/sign`, { typedSignature: 'Avery Stone' }, admin)).status, 200);
  const award = await one<{ status: string; accepted_date: string | null }>('SELECT status, accepted_date FROM awards WHERE id = ?', issued.json.award.id);
  assert.equal(award!.status, 'OUTSTANDING');
  assert.ok(award!.accepted_date);
  assert.equal((await one<{ status: string }>('SELECT status FROM documents WHERE id = ?', issued.json.document.id))!.status, 'EXECUTED');
  const tx = await one<{ type: string; quantity: number; price_per_share: number }>('SELECT * FROM transactions WHERE security_id = ?', issued.json.award.id);
  assert.equal(tx!.type, 'GRANT');
  assert.equal(Number(tx!.quantity), 48_000);
  assert.equal(Number(tx!.price_per_share), 960_000);
  assert.equal((await call('GET', `/api/c/${cid}/pools/summary`, undefined, admin)).json[0].granted, 48_000);
  assert.equal((await call('GET', `/api/c/${cid}/portal`, undefined, priya)).json.portfolio.grants.length, 1);
  assert.ok((await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.some((a: any) => a.action === 'GRANT_EXECUTED'));
  assert.equal((await call('POST', `/api/c/${cid}/awards/${issued.json.award.id}/cancel-signing`, {}, admin)).status, 400);   // executed grants are cancelled, not withdrawn
});

test('requesting board approval drafts a consent; approval sends the agreement out, and a pending grant can be withdrawn', async () => {
  assert.equal((await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, approval: 'REQUEST', directorIds: [], signing }, admin)).status, 400);
  const issued = await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, quantity: 10_000, approval: 'REQUEST', directorIds: ['stk_dana'], signing }, admin);
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.award.status, 'PENDING_APPROVAL');
  assert.equal(issued.json.award.label, 'OPT-2');
  assert.equal(issued.json.award.boardApprovalDate, null);
  assert.equal(issued.json.document, null);                                                      // no agreement until the board has approved
  assert.equal(issued.json.consent.status, 'PENDING');
  assert.equal(issued.json.consent.linkedEntityType, 'awards');
  assert.match(issued.json.consent.title, /Approve Incentive Stock Option grant of 10,000 shares to Priya Raman/);
  assert.match(issued.json.consent.body, /RESOLVED.*\$0\.96 per share/);
  assert.equal((await all('SELECT * FROM board_votes WHERE consent_id = ?', issued.json.consent.id)).length, 1);

  // The director approves (recorded by the admin on their behalf): the agreement goes out.
  const voted = await call('POST', `/api/c/${cid}/consents/${issued.json.consent.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_dana' }, admin);
  assert.equal(voted.status, 200, JSON.stringify(voted.json));
  assert.equal(voted.json.status, 'APPROVED');
  const award = await one<{ status: string; board_approval_date: string | null }>('SELECT status, board_approval_date FROM awards WHERE id = ?', issued.json.award.id);
  assert.equal(award!.status, 'PENDING_SIGNATURE');
  assert.equal(award!.board_approval_date, '2026-09-21');                                       // the consent's effective date
  const doc = await one<{ id: string; body: string; status: string }>("SELECT * FROM documents WHERE security_id = ? AND category = 'GRANT_AGREEMENT'", issued.json.award.id);
  assert.equal(doc!.status, 'AWAITING_SIGNATURE');
  assert.match(doc!.body, /OPT-2/);
  assert.equal((await all('SELECT * FROM signatures WHERE document_id = ?', doc!.id)).length, 2);

  // Withdrawn before anyone signs: the grant, its agreement and blocks are gone.
  assert.equal((await call('POST', `/api/c/${cid}/awards/${issued.json.award.id}/cancel-signing`, {}, admin)).status, 200);
  assert.equal(await one('SELECT 1 FROM awards WHERE id = ?', issued.json.award.id), undefined);
  assert.equal(await one('SELECT 1 FROM documents WHERE id = ?', doc!.id), undefined);
  assert.equal(await one('SELECT 1 FROM signatures WHERE document_id = ?', doc!.id), undefined);

  // Withdrawing while the consent is still pending removes the consent too.
  const second = await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, quantity: 5_000, approval: 'REQUEST', directorIds: ['stk_dana'], signing: null }, admin);
  assert.equal(second.json.award.status, 'PENDING_APPROVAL');
  assert.equal((await call('POST', `/api/c/${cid}/awards/${second.json.award.id}/cancel-signing`, {}, admin)).status, 200);
  assert.equal(await one('SELECT 1 FROM board_consents WHERE id = ?', second.json.consent.id), undefined);
});

test('grants approved without an agreement, or recorded directly, are outstanding at once with a ledger entry', async () => {
  const requested = await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, quantity: 2_000, type: 'NSO', approval: 'REQUEST', directorIds: ['stk_dana'] }, admin);
  assert.equal(requested.json.award.status, 'PENDING_APPROVAL');
  await call('POST', `/api/c/${cid}/consents/${requested.json.consent.id}/vote`, { vote: 'APPROVE', stakeholderId: 'stk_dana' }, admin);
  assert.equal((await one<{ status: string }>('SELECT status FROM awards WHERE id = ?', requested.json.award.id))!.status, 'OUTSTANDING');
  assert.equal((await one<{ type: string }>('SELECT type FROM transactions WHERE security_id = ?', requested.json.award.id))!.type, 'GRANT');

  const direct = await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, quantity: 1_000, label: 'ISO-X', approval: 'NONE', signing: null }, admin);
  assert.equal(direct.status, 200, JSON.stringify(direct.json));
  assert.equal(direct.json.award.status, 'OUTSTANDING');
  assert.equal(direct.json.award.label, 'ISO-X');
  assert.equal(direct.json.award.boardApprovalDate, null);
  assert.equal((await one<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE security_id = ?', direct.json.award.id))!.n, 1);
  assert.equal((await call('GET', `/api/c/${cid}/pools/summary`, undefined, admin)).json[0].granted, 48_000 + 2_000 + 1_000);

  // RSUs use the RSU agreement and need no strike.
  const rsu = await call('POST', `/api/c/${cid}/awards/issue`, { ...grant, quantity: 500, type: 'RSU', strikePrice: undefined, approval: 'APPROVED', signing }, admin);
  assert.equal(rsu.status, 200, JSON.stringify(rsu.json));
  assert.equal(rsu.json.award.strikePrice, 0);
  assert.match(rsu.json.document.name, /^RSU award agreement/);
  assert.match(rsu.json.document.body, /RESTRICTED STOCK UNIT AWARD AGREEMENT/);
  assert.match(rsu.json.document.body, /500 restricted stock units/);
});

test('the award agreement signing email carries the facts and the link in both parts, and escapes names', async () => {
  const { composeHolderSigningEmail } = await import('../src/routes/workflows.ts');
  const { mailSignature } = await import('../src/config.ts');
  const link = 'http://localhost:5173/portal';
  const facts = {
    to: 'priya@example.com', toName: 'Priya Raman', companyName: 'Tidewater Labs', shares: 48_000, className: 'Incentive Stock Options',
    reminder: false, what: 'agreement' as const, link, reference: 'OPT-7', date: '2026-09-01',
  };
  const m = composeHolderSigningEmail(facts);
  assert.equal(m.to, 'priya@example.com');
  assert.equal(m.toName, 'Priya Raman');
  assert.equal(m.subject, 'Tidewater Labs: sign your equity award agreement');
  assert.ok(m.subject.length <= 60);
  assert.ok(m.html, 'an HTML part');
  for (const part of [m.text, m.html!]) {
    assert.ok(part.includes(link), 'the portal link');
    assert.ok(part.includes('Review and sign'));
    assert.ok(part.includes('48,000 Incentive Stock Options'));
    assert.ok(part.includes('OPT-7'));
    assert.ok(part.includes('September 1, 2026'));
    assert.ok(part.includes('Waiting for your signature'));
    assert.ok(part.includes('the grant is recorded as outstanding'));
    assert.ok(part.includes(`— ${mailSignature()}`));
  }
  assert.match(m.text, /^Hi Priya Raman,\n\nTidewater Labs has granted you 48,000 Incentive Stock Options\./);

  const reminder = composeHolderSigningEmail({ ...facts, reminder: true });
  assert.equal(reminder.subject, 'Tidewater Labs: reminder to sign your equity award agreement');
  assert.match(reminder.text, /This is a reminder from Tidewater Labs: the award agreement for your grant of 48,000 Incentive Stock Options is still waiting/);
  assert.ok(reminder.html!.includes(link) && reminder.text.includes(link));

  const hostile = '<script>x</script>';
  const h = composeHolderSigningEmail({ ...facts, toName: hostile, className: hostile, reference: hostile });
  assert.ok(!h.html!.includes('<script>'), 'no markup from a name');
  assert.ok(h.html!.includes('&lt;script&gt;x&lt;/script&gt;'), 'shown as text');
});
