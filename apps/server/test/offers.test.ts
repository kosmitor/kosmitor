/**
 * Offer letters over HTTP: drafted from the template, sent as a public link,
 * accepted or declined by the candidate without an account, then turned into
 * a stakeholder and a grant that closes the offer.
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
await import('../src/routes/offers.ts');
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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Offerco', legalName: 'Offerco, Inc.' }, admin)).json.id as string;
const now = new Date().toISOString();
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string; name: string }>("SELECT id, name FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!;
await insert('pools', { id: 'pool_1', companyId: cid, name: '2026 Stock Plan', shareClassId: common, authorized: 1_000_000, returnForfeitures: 1, planType: 'STOCK_PLAN', createdAt: now });
const draft = {
  candidateName: 'Priya Raman', candidateEmail: 'Priya@Example.com', position: 'VP Engineering', department: 'Engineering', startDate: '2026-11-02',
  salary: 18_500_000, poolId: 'pool_1', awardType: 'ISO', quantity: 48_000, strikePrice: 960_000, vestingScheduleId: schedule.id, expiresOn: '2026-12-31',
  message: 'We loved your systems design round.', signerName: 'Avery Stone', signerTitle: 'CEO',
};
const tokenOf = (link: string) => link.split('/offer/')[1];

test('an offer is drafted from the template, sent as a link, accepted by the candidate and granted', async () => {
  assert.equal((await call('GET', `/api/c/${cid}/offers`)).status, 401);
  const created = await call('POST', `/api/c/${cid}/offers`, draft, admin);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.status, 'DRAFT');
  assert.equal(created.json.candidateEmail, 'priya@example.com');
  assert.equal(created.json.poolName, '2026 Stock Plan');
  assert.equal(created.json.link, null);
  assert.equal(created.json.token, undefined);                                                 // the accept token never leaves the server through the list
  assert.match(created.json.body, /Dear Priya Raman,/);
  assert.match(created.json.body, /position of VP Engineering at Offerco, starting 2026-11-02/);
  assert.match(created.json.body, /\$185,000\.00 per year/);
  assert.match(created.json.body, /48,000 Incentive Stock Options under the 2026 Stock Plan/);
  assert.match(created.json.body, /currently \$0\.96 per share/);
  assert.match(created.json.body, new RegExp(`"${schedule.name}" schedule`));
  assert.match(created.json.body, /We loved your systems design round\./);
  assert.match(created.json.body, /expires on 2026-12-31/);
  assert.match(created.json.body, /Avery Stone\nCEO, Offerco/);
  assert.equal((await call('GET', `/api/c/${cid}/offers`, undefined, admin)).json.counts.DRAFT, 1);

  const edited = await call('PATCH', `/api/c/${cid}/offers/${created.json.id}`, { salary: 19_000_000, awardType: 'RSU' }, admin);
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.match(edited.json.body, /\$190,000\.00/);
  assert.match(edited.json.body, /48,000 Restricted Stock Units/);
  assert.doesNotMatch(edited.json.body, /exercise price/);                                        // RSUs carry no strike
  await call('PATCH', `/api/c/${cid}/offers/${created.json.id}`, { awardType: 'ISO', strikePrice: 960_000 }, admin);

  // Send: the link is minted, mail is not configured here so the admin shares it.
  const sent = await call('POST', `/api/c/${cid}/offers/${created.json.id}/send`, {}, admin);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.offer.status, 'SENT');
  assert.equal(sent.json.emailed, false);
  assert.match(sent.json.reason, /not configured/);
  assert.match(sent.json.link, /\/offer\/[A-Za-z0-9_-]{20,}$/);
  const token = tokenOf(sent.json.link);
  const resent = await call('POST', `/api/c/${cid}/offers/${created.json.id}/send`, {}, admin);
  assert.equal(tokenOf(resent.json.link), token);                                                // re-sending keeps the same link

  // The candidate opens the link with no account.
  assert.equal((await call('GET', '/api/offers/not-a-real-token')).status, 404);
  const seen = await call('GET', `/api/offers/${token}`);
  assert.equal(seen.status, 200, JSON.stringify(seen.json));
  assert.equal(seen.json.status, 'SENT');
  assert.equal(seen.json.expired, false);
  assert.equal(seen.json.company.legalName, 'Offerco, Inc.');
  assert.equal(seen.json.candidateName, 'Priya Raman');
  assert.equal(seen.json.salary, '$190,000.00');
  assert.deepEqual(seen.json.equity, { quantity: '48,000', awardType: 'ISO', awardTypeName: 'Incentive Stock Option', strikePrice: '$0.96', vestingSchedule: schedule.name, planName: '2026 Stock Plan' });
  assert.match(seen.json.body, /Dear Priya Raman,/);
  assert.ok((await call('GET', `/api/c/${cid}/offers/${created.json.id}`, undefined, admin)).json.viewedAt);

  assert.equal((await call('POST', `/api/offers/${token}/accept`, { typedName: 'P' })).status, 400);
  const accepted = await call('POST', `/api/offers/${token}/accept`, { typedName: 'Priya Raman' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal((await call('GET', `/api/offers/${token}`)).json.status, 'ACCEPTED');
  assert.equal((await call('POST', `/api/offers/${token}/accept`, { typedName: 'Priya Raman' })).status, 400);
  assert.equal((await call('POST', `/api/offers/${token}/decline`, {})).status, 400);
  const listed = await call('GET', `/api/c/${cid}/offers`, undefined, admin);
  assert.equal(listed.json.counts.ACCEPTED, 1);
  assert.equal(listed.json.offers[0].acceptedName, 'Priya Raman');
  assert.equal((await call('PATCH', `/api/c/${cid}/offers/${created.json.id}`, { salary: 1 }, admin)).status, 400);   // answered offers are fixed
  assert.equal((await call('DELETE', `/api/c/${cid}/offers/${created.json.id}`, undefined, admin)).status, 400);

  // Convert: the candidate becomes a stakeholder; the grant then closes the offer.
  const converted = await call('POST', `/api/c/${cid}/offers/${created.json.id}/convert`, {}, admin);
  assert.equal(converted.status, 200, JSON.stringify(converted.json));
  const stakeholder = await one<{ name: string; email: string; relation: string; title: string; department: string; start_date: string }>('SELECT * FROM stakeholders WHERE id = ?', converted.json.stakeholderId);
  assert.equal(stakeholder!.name, 'Priya Raman');
  assert.equal(stakeholder!.email, 'priya@example.com');
  assert.equal(stakeholder!.relation, 'EMPLOYEE');
  assert.equal(stakeholder!.title, 'VP Engineering');
  assert.equal(stakeholder!.department, 'Engineering');
  assert.equal(stakeholder!.start_date, '2026-11-02');
  assert.equal((await call('POST', `/api/c/${cid}/offers/${created.json.id}/convert`, {}, admin)).json.stakeholderId, converted.json.stakeholderId);   // idempotent
  const granted = await call('POST', `/api/c/${cid}/awards/issue`, {
    stakeholderId: converted.json.stakeholderId, poolId: 'pool_1', type: 'ISO', quantity: 48_000, strikePrice: 960_000, grantDate: '2026-11-02',
    vestingScheduleId: schedule.id, approval: 'APPROVED', boardApprovalDate: '2026-10-30', signing: null, offerId: created.json.id,
  }, admin);
  assert.equal(granted.status, 200, JSON.stringify(granted.json));
  const closed = await call('GET', `/api/c/${cid}/offers/${created.json.id}`, undefined, admin);
  assert.equal(closed.json.status, 'CONVERTED');
  assert.equal(closed.json.awardId, granted.json.award.id);
  assert.equal((await call('GET', `/api/offers/${token}`)).json.status, 'CONVERTED');
  const actions = (await call('GET', `/api/c/${cid}/audit`, undefined, admin)).json.map((a: any) => a.action);
  for (const a of ['SEND', 'RESEND', 'ACCEPT', 'CONVERT']) assert.ok(actions.includes(a), `audit has ${a}`);
});

test('declined, withdrawn and expired offers cannot be accepted; drafts can be deleted', async () => {
  const declined = await call('POST', `/api/c/${cid}/offers`, { ...draft, candidateName: 'Noor Haddad', candidateEmail: null }, admin);
  const sentD = await call('POST', `/api/c/${cid}/offers/${declined.json.id}/send`, {}, admin);
  assert.match(sentD.json.reason, /no email address/);
  const tokenD = tokenOf(sentD.json.link);
  assert.equal((await call('POST', `/api/offers/${tokenD}/decline`, { reason: 'Took another role.' })).status, 200);
  assert.equal((await call('GET', `/api/offers/${tokenD}`)).json.status, 'DECLINED');
  assert.equal((await call('POST', `/api/offers/${tokenD}/accept`, { typedName: 'Noor Haddad' })).status, 400);
  assert.equal((await call('GET', `/api/c/${cid}/offers/${declined.json.id}`, undefined, admin)).json.declineReason, 'Took another role.');

  const withdrawn = await call('POST', `/api/c/${cid}/offers`, { ...draft, candidateName: 'Sam Ortiz' }, admin);
  const tokenW = tokenOf((await call('POST', `/api/c/${cid}/offers/${withdrawn.json.id}/send`, {}, admin)).json.link);
  assert.equal((await call('POST', `/api/c/${cid}/offers/${withdrawn.json.id}/withdraw`, {}, admin)).json.status, 'WITHDRAWN');
  assert.equal((await call('GET', `/api/offers/${tokenW}`)).json.status, 'WITHDRAWN');
  assert.equal((await call('POST', `/api/offers/${tokenW}/accept`, { typedName: 'Sam Ortiz' })).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/offers/${withdrawn.json.id}/send`, {}, admin)).status, 400);

  const stale = await call('POST', `/api/c/${cid}/offers`, { ...draft, candidateName: 'Lee Park', expiresOn: '2020-01-01' }, admin);
  assert.equal((await call('POST', `/api/c/${cid}/offers/${stale.json.id}/send`, {}, admin)).status, 400);          // cannot send an already-expired offer
  await call('PATCH', `/api/c/${cid}/offers/${stale.json.id}`, { expiresOn: '2999-01-01' }, admin);
  const tokenS = tokenOf((await call('POST', `/api/c/${cid}/offers/${stale.json.id}/send`, {}, admin)).json.link);
  await one("UPDATE offers SET expires_on = '2020-01-01' WHERE id = ?", stale.json.id);
  const expired = await call('GET', `/api/offers/${tokenS}`);
  assert.equal(expired.json.status, 'SENT');
  assert.equal(expired.json.expired, true);
  assert.equal((await call('POST', `/api/offers/${tokenS}/accept`, { typedName: 'Lee Park' })).status, 400);
  assert.equal((await call('GET', `/api/c/${cid}/offers`, undefined, admin)).json.counts.EXPIRED, 1);

  const junk = await call('POST', `/api/c/${cid}/offers`, { ...draft, candidateName: 'Draft Only' }, admin);
  assert.equal((await call('DELETE', `/api/c/${cid}/offers/${junk.json.id}`, undefined, admin)).status, 200);
  assert.equal((await call('GET', `/api/c/${cid}/offers/${junk.json.id}`, undefined, admin)).status, 404);
  assert.equal((await call('POST', `/api/c/${cid}/offers`, { ...draft, awardType: 'SAR' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/offers`, { ...draft, candidateEmail: 'nope' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/offers`, { ...draft, poolId: 'pool_other' }, admin)).status, 400);
});

test('the offer email names the role and the deadline, links the offer page in both parts, and escapes what people typed', async () => {
  const { composeOfferEmail } = await import('../src/routes/offers.ts');
  const { config } = await import('../src/config.ts');
  const link = `${config().app.url}/offer/tok_abcdefghijklmnopqrstuvwx`;
  const hostile = '<script>x</script>';
  const m = composeOfferEmail({
    companyName: 'Offerco', to: 'priya@example.com', candidateName: hostile, position: 'VP Engineering', link,
    expiresOn: '2026-12-31', startDate: '2026-11-02', signerName: 'Avery Stone', signerTitle: 'CEO',
  });
  assert.equal(m.to, 'priya@example.com');
  assert.equal(m.toName, hostile);
  assert.equal(m.replyTo, undefined);
  assert.equal(m.subject, 'Offerco: review your offer letter');
  assert.ok(m.html && m.text, 'both parts');
  for (const part of [m.html!, m.text]) {
    assert.ok(part.includes(link), 'the offer link');
    for (const fact of ['Read your offer', 'Offerco', 'VP Engineering', 'November 2, 2026', 'December 31, 2026', 'do not forward', 'What happens next', '— Avery Stone, CEO']) {
      assert.ok(part.toLowerCase().includes(fact.toLowerCase()), `${fact} is in the ${part === m.text ? 'text' : 'HTML'}`);
    }
  }
  assert.ok(!m.html!.includes('<script>'), 'a typed name never becomes markup');
  assert.ok(m.html!.includes('&lt;script&gt;x&lt;/script&gt;'));

  // Without a deadline, start date or named signer, the email says nothing about them and the company signs.
  const open = composeOfferEmail({ companyName: 'Offerco', to: 'sam@example.com', candidateName: 'Sam Ortiz', position: 'Designer', link, expiresOn: null, signerName: null });
  for (const part of [open.html!, open.text]) {
    assert.ok(!/open until|Start date/i.test(part));
    assert.ok(part.includes('— Offerco'));
  }
});
