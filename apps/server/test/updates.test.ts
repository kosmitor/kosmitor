/**
 * Investor updates over HTTP: drafted with metrics and an audience, sent as
 * recipient rows (emailed where possible), read from the holder's portal with
 * the company seeing who opened it.
 */
import { test, after } from 'node:test';
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
await import('../src/routes/communications.ts');
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

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
const cid = (await call('POST', '/api/companies', { name: 'Updateco' }, admin)).json.id as string;
const now = new Date().toISOString();
await insert('stakeholders', { id: 'stk_halcyon', companyId: cid, name: 'Halcyon Ventures', email: 'deals@halcyon.example.com', type: 'FUND', relation: 'INVESTOR', createdAt: now });
await insert('stakeholders', { id: 'stk_noor', companyId: cid, name: 'Noor Haddad', email: null, type: 'INDIVIDUAL', relation: 'INVESTOR', createdAt: now });
await insert('stakeholders', { id: 'stk_priya', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', createdAt: now });
await insert('stakeholders', { id: 'stk_gone', companyId: cid, name: 'Former Investor', email: 'gone@example.com', type: 'INDIVIDUAL', relation: 'INVESTOR', terminationDate: '2025-01-01', createdAt: now });

test('an update is drafted, sent to its audience, read from the portal and tracked', async () => {
  const listed = await call('GET', `/api/c/${cid}/updates`, undefined, admin);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.updates, []);
  assert.equal(listed.json.audiences.find((a: any) => a.key === 'INVESTORS').count, 2);            // the terminated investor is left out
  assert.equal(listed.json.audiences.find((a: any) => a.key === 'TEAM').count, 1);
  assert.equal(listed.json.audiences.find((a: any) => a.key === 'ALL').count, 3);

  const draft = await call('POST', `/api/c/${cid}/updates`, {
    title: 'Q3 2026 update', period: 'Q3 2026', audience: 'INVESTORS', body: 'Revenue grew 41% quarter over quarter.\n\nWe closed two enterprise pilots.',
    metrics: [{ label: 'ARR', value: '$4.2M' }, { label: 'Runway', value: '22 months' }, { label: '', value: 'ignored' }],
  }, admin);
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.equal(draft.json.status, 'DRAFT');
  assert.deepEqual(draft.json.metrics, [{ label: 'ARR', value: '$4.2M' }, { label: 'Runway', value: '22 months' }]);
  assert.equal(draft.json.audienceLabel, 'Investors');
  const edited = await call('PATCH', `/api/c/${cid}/updates/${draft.json.id}`, { metrics: [{ label: 'ARR', value: '$4.4M' }] }, admin);
  assert.equal(edited.json.metrics[0].value, '$4.4M');
  assert.equal(edited.json.title, 'Q3 2026 update');
  const detail = await call('GET', `/api/c/${cid}/updates/${draft.json.id}`, undefined, admin);
  assert.deepEqual(detail.json.preview.map((r: any) => r.name), ['Halcyon Ventures', 'Noor Haddad']);

  // Send: one recipient row each; nobody is emailed without a mail server.
  const sent = await call('POST', `/api/c/${cid}/updates/${draft.json.id}/send`, {}, admin);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.sent, 2);
  assert.equal(sent.json.emailed, 0);
  assert.equal(sent.json.withoutEmail, 1);
  assert.match(sent.json.reason, /not configured/);
  assert.equal(sent.json.update.status, 'SENT');
  assert.equal(sent.json.update.recipientCount, 2);
  assert.equal((await call('POST', `/api/c/${cid}/updates/${draft.json.id}/send`, {}, admin)).status, 400);   // once
  assert.equal((await call('PATCH', `/api/c/${cid}/updates/${draft.json.id}`, { title: 'x' }, admin)).status, 400);

  // The investor reads it in the portal; the company sees the open.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'deals@halcyon.example.com', name: 'Halcyon Ventures', role: 'INVESTOR' }, admin);
  const halcyon = (await call('POST', '/api/auth/reset', {
    token: new URL((await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, admin)).json.resetUrl).searchParams.get('token'),
    password: 'halcyon-pass-1',
  })).json.token as string;
  assert.equal((await call('GET', `/api/c/${cid}/updates`, undefined, halcyon)).status, 403);                      // limited roles do not see the hub
  const portal = await call('GET', `/api/c/${cid}/portal`, undefined, halcyon);
  assert.equal(portal.json.updates.length, 1);
  assert.equal(portal.json.updates[0].title, 'Q3 2026 update');
  assert.equal(portal.json.updates[0].viewedAt, null);
  assert.deepEqual(portal.json.updates[0].metrics, [{ label: 'ARR', value: '$4.4M' }]);
  assert.equal((await call('POST', `/api/c/${cid}/portal/updates/${draft.json.id}/read`, {}, halcyon)).status, 200);
  assert.ok((await call('GET', `/api/c/${cid}/portal`, undefined, halcyon)).json.updates[0].viewedAt);
  const after1 = await call('GET', `/api/c/${cid}/updates/${draft.json.id}`, undefined, admin);
  assert.equal(after1.json.viewedCount, 1);
  assert.equal(after1.json.recipients.find((r: any) => r.stakeholderId === 'stk_halcyon').emailed, 0);
  assert.ok(after1.json.recipients.find((r: any) => r.stakeholderId === 'stk_halcyon').viewedAt);
  assert.equal(after1.json.recipients.find((r: any) => r.stakeholderId === 'stk_noor').viewedAt, null);
  assert.equal((await call('POST', `/api/c/${cid}/portal/updates/nope/read`, {}, halcyon)).status, 404);

  // A custom audience and the team audience; an employee sees only what was addressed to them.
  const custom = await call('POST', `/api/c/${cid}/updates`, { title: 'Board pack', audience: 'CUSTOM', recipientIds: ['stk_priya'], body: 'For the team only.' }, admin);
  assert.equal((await call('POST', `/api/c/${cid}/updates/${custom.json.id}/send`, {}, admin)).json.sent, 1);
  assert.equal((await call('POST', `/api/c/${cid}/updates`, { title: 'x', audience: 'CUSTOM', recipientIds: [], body: 'y' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/updates`, { title: 'x', audience: 'MARTIANS', body: 'y' }, admin)).status, 400);
  assert.equal((await call('GET', `/api/c/${cid}/portal`, undefined, halcyon)).json.updates.length, 1);            // the board pack is not theirs
  const list = await call('GET', `/api/c/${cid}/updates`, undefined, admin);
  assert.equal(list.json.updates.length, 2);
  assert.equal(list.json.updates[0].title, 'Board pack');                                                       // newest first

  const empty = await call('POST', `/api/c/${cid}/updates`, { title: 'Nobody', audience: 'BOARD', body: 'No directors yet.' }, admin);
  assert.equal((await call('POST', `/api/c/${cid}/updates/${empty.json.id}/send`, {}, admin)).status, 400);
  assert.equal((await call('DELETE', `/api/c/${cid}/updates/${empty.json.id}`, undefined, admin)).status, 200);
  assert.equal(await one('SELECT 1 FROM investor_updates WHERE id = ?', empty.json.id), undefined);
  assert.equal((await call('DELETE', `/api/c/${cid}/updates/${draft.json.id}`, undefined, admin)).status, 200);
  assert.equal(await one('SELECT 1 FROM update_recipients WHERE update_id = ?', draft.json.id), undefined);      // rows go with the update
});

test('the update email carries the numbers, the full text and the portal link in both parts, and escapes what people typed', async () => {
  const { composeInvestorUpdateEmail } = await import('../src/routes/communications.ts');
  const { config } = await import('../src/config.ts');
  const portal = `${config().app.url}/portal`;
  const hostile = '<script>x</script>';
  const m = composeInvestorUpdateEmail({
    companyName: 'Tidewater Labs', to: 'deals@halcyon.example.com', toName: hostile,
    title: `Q3 2026 update ${hostile}`, period: 'Q3 2026', body: 'Revenue grew 41% quarter over quarter.\n\nWe closed two enterprise pilots.',
    metrics: [{ label: 'ARR', value: '$4.4M' }, { label: 'Runway', value: '22 months' }], portalUrl: portal,
  });
  assert.equal(m.to, 'deals@halcyon.example.com');
  assert.equal(m.toName, hostile);
  assert.equal(m.replyTo, undefined);
  assert.match(m.subject, /^Tidewater Labs: Q3 2026 update/);
  assert.ok(m.html && m.text, 'both parts');
  for (const part of [m.html!, m.text]) {
    assert.ok(part.includes(portal), 'the portal link');
    for (const fact of ['Read it in your portal', 'Q3 2026', 'ARR', '$4.4M', 'Runway', '22 months', 'Revenue grew 41% quarter over quarter.',
      'We closed two enterprise pilots.', '— Tidewater Labs', 'stakeholder of Tidewater Labs', config().brand.productName]) {
      assert.ok(part.includes(fact), `${fact} is in the ${part === m.text ? 'text' : 'HTML'}`);
    }
  }
  assert.ok(!m.html!.includes('<script>'), 'a typed name or title never becomes markup');
  assert.ok(m.html!.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(m.text.includes(`Hi ${hostile},`), 'the plain text keeps it as typed');
});

test('an update subject says it is an update, stays short, and leaves out what the update does not have', async () => {
  const { composeInvestorUpdateEmail } = await import('../src/routes/communications.ts');
  const base = { companyName: 'Tidewater Labs', to: 'a@example.com', toName: 'Jo Park', period: null, body: 'A quiet month.', metrics: [], portalUrl: 'https://equity.example.com/portal' };
  const plain = composeInvestorUpdateEmail({ ...base, title: 'October' });
  assert.equal(plain.subject, 'Tidewater Labs update: October');
  assert.ok(!plain.text.includes('Period:'), 'no period row without a period');
  assert.ok(plain.text.includes('A quiet month.'));
  const long = composeInvestorUpdateEmail({ ...base, title: 'A very long title about everything that happened this quarter and the one before it, in detail' });
  assert.ok(long.subject.length <= 80, long.subject);
  assert.ok(long.text.includes('in detail'), 'the full title is still in the email');
});
