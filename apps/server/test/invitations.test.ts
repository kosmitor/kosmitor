/**
 * Invitation emails over HTTP. Inviting someone emails them: a new address, or an
 * account nobody has signed in to, gets a single-use link that chooses a password
 * and signs them in; with password sign-in off, it is told to use Google; an
 * account that already signs in is only told about the company. The link comes
 * back to the administrator when the email did not go out, and only for an account
 * that belongs to this company alone. An administrator can send the invitation
 * again, and an address is sent no more than auth.inviteEmailsPerAddressPerDay.
 * A link stops working once its owner signs in, when their address is changed,
 * and, handed to an administrator, once they belong to another company too.
 *
 * The mail here is the console transport, read from the log: nothing leaves the
 * machine. invitation-slow-mail.test.ts covers a mail server that takes its time.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

// The console transport, and no Google unless a test turns it on. Empty values
// win over apps/server/.env, which only fills in what is not set at all.
process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_ALLOWED_DOMAINS = '';
delete process.env.NODE_ENV;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
const { composeInviteEmail } = await import('../src/routes/auth.ts');
const { one, all, run } = await import('../src/db.ts');
const { upsertGoogleUser } = await import('../src/auth.ts');
const { config, configure, resetConfig } = await import('../src/config.ts');

// Every message the console transport prints, by recipient; anything else is passed on.
const mail: { to: string; text: string }[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  const sent = line.match(/^\[mail\] not configured .* would send to (\S+): /);
  if (sent) mail.push({ to: sent[1], text: line });
  else realLog(...args);
};
after(() => { console.log = realLog; });
const mailTo = (email: string) => mail.filter((m) => m.to === email);
const lastMailTo = (email: string): string => mailTo(email).at(-1)?.text ?? '';

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
const tokenFrom = (url: string): string => new URL(url).searchParams.get('token')!;
const product = config().brand.productName;
const app = config().app.url;
const linkIn = (text: string): string => text.match(/https?:\/\/\S+\/reset-password\?token=[A-Za-z0-9_%-]+/)?.[0] ?? '';
const inviteRows = (email: string) => all<{ action: string; company_id: string }>(
  `SELECT a.action, a.company_id FROM audit_log a JOIN users u ON u.id = a.entity_id
    WHERE u.email = ? AND a.action LIKE 'INVITE_EMAIL%' ORDER BY a.created_at, a.id`, email);

// Made-up people. Avery runs Harbor Lane; Morgan runs Tidewater Labs.
const avery = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Harbor Lane' }, avery)).json.id as string;
const morgan = (await call('POST', '/api/auth/register', { email: 'morgan@example.com', name: 'Morgan Lee', password: 'morgan-pass-1' })).token as string;
const otherCid = (await call('POST', '/api/companies', { name: 'Tidewater Labs' }, morgan)).json.id as string;
const members = async (company = cid, token = avery) => (await call('GET', `/api/c/${company}/members`, undefined, token)).json as any[];

test('a new address gets an invitation whose link chooses a password, signs them in and names the company', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'Priya.Raman@Example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, avery);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  assert.equal(invite.json.role, 'EMPLOYEE');
  // Mail is not set up, so the email did not go out and the link comes back to pass on.
  assert.equal(invite.json.invitation.emailed, false);
  assert.ok(invite.json.invitation.link.startsWith(`${app}/reset-password?token=`), invite.json.invitation.link);

  const text = lastMailTo('priya.raman@example.com');
  assert.match(text, new RegExp(`"Avery Stone invited you to Harbor Lane on ${product}"`));
  assert.match(text, /Hi Priya Raman,/);
  assert.match(text, /Avery Stone invited you to join Harbor Lane/);
  assert.match(text, /As an employee, you can see your own equity/);
  assert.match(text, /What you see: +Your own equity/);
  assert.match(text, /Sign in as: +priya\.raman@example\.com/);
  assert.match(text, /works once and expires in 7 days/);
  assert.match(text, /If you did not expect it, you can ignore this email/);
  assert.doesNotMatch(text, /Google/, 'Google is off on this server');
  assert.doesNotMatch(text, /tmp_/, 'never the placeholder password');
  assert.equal(linkIn(text), invite.json.invitation.link, 'the email and the answer carry the same link');

  // The link is an invitation, for this company, and lasts auth.inviteLinkDays.
  const token = tokenFrom(invite.json.invitation.link);
  const stored = await one<{ purpose: string; company_id: string; expires_at: string }>(
    "SELECT r.purpose, r.company_id, r.expires_at FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'priya.raman@example.com' AND r.used_at IS NULL");
  assert.equal(stored!.purpose, 'INVITE');
  assert.equal(stored!.company_id, cid);
  const days = (new Date(stored!.expires_at).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6.99 && days <= 7, `the link lasts inviteLinkDays (${days})`);

  const peek = await call('GET', `/api/auth/reset/${token}`);
  assert.deepEqual(peek.json, {
    valid: true, email: 'priya.raman@example.com', name: 'Priya Raman', purpose: 'INVITE',
    companyId: cid, company: 'Harbor Lane', invitedBy: 'Avery Stone',
  });

  // Until they take it up, the team page shows them as invited.
  const before = (await members()).find((m) => m.email === 'priya.raman@example.com');
  assert.equal(before.neverSignedIn, true);
  assert.equal((await members()).find((m) => m.email === 'avery@example.com').neverSignedIn, false, 'signing up counts as signing in');
  assert.deepEqual((await inviteRows('priya.raman@example.com')).map((r) => [r.action, r.company_id]), [['INVITE_EMAIL_FAILED', cid]]);

  const accepted = await call('POST', '/api/auth/reset', { token, password: 'priya-chose-this' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.user.email, 'priya.raman@example.com');
  const me = await call('GET', '/api/auth/me', undefined, accepted.token);
  assert.deepEqual(me.json.companies.map((c: any) => [c.id, c.role]), [[cid, 'EMPLOYEE']]);
  assert.equal((await call('POST', '/api/auth/login', { email: 'priya.raman@example.com', password: 'priya-chose-this' })).status, 200);
  assert.equal((await members()).find((m) => m.email === 'priya.raman@example.com').neverSignedIn, false);
  assert.deepEqual((await call('GET', `/api/auth/reset/${token}`)).json, { valid: false }, 'the link is spent');
  const acceptedRow = await one<{ company_id: string; detail: string }>("SELECT company_id, detail FROM audit_log WHERE action = 'INVITE_ACCEPTED'");
  assert.equal(acceptedRow!.company_id, cid, 'written to the log of the company that invited them');
  assert.match(acceptedRow!.detail, /priya\.raman@example\.com chose a password from an invitation/);
});

test('with Google on, the invitation offers Google as the address invited, beside the password link', async () => {
  configure({ auth: { google: { clientId: 'invite-test.apps.googleusercontent.com' } } });
  try {
    const invite = await call('POST', `/api/c/${cid}/members`, { email: 'hana@example.com', name: 'Hana Ito', role: 'VIEWER' }, avery);
    assert.equal(invite.status, 200, JSON.stringify(invite.json));
    const text = lastMailTo('hana@example.com');
    assert.match(text, /Choose a password:/);
    assert.match(text, /OR SIGN IN WITH GOOGLE/);
    assert.match(text, /Sign in with Google as hana@example\.com/);
    assert.match(text, /As a viewer, you can see the whole company’s cap table, without changing it\./);
    assert.match(text, /What you see: +The whole company/);
    assert.ok(linkIn(text));
  } finally {
    resetConfig();
  }
});

test('with password sign-in off, a new address is told to sign in with Google, and no link is made', async () => {
  configure({ auth: { passwordSignIn: false, google: { clientId: 'invite-test.apps.googleusercontent.com' } } });
  try {
    const invite = await call('POST', `/api/c/${cid}/members`, { email: 'bao@example.com', role: 'BOARD' }, avery);
    assert.equal(invite.status, 200, JSON.stringify(invite.json));
    assert.deepEqual(invite.json.invitation, { emailed: false }, 'there is no link to pass on');
    const text = lastMailTo('bao@example.com');
    assert.match(text, /Hello,/, 'a placeholder named after its address is not greeted by it');
    assert.match(text, /Sign in with Google using bao@example\.com, the address the invitation is for\. There is no password to choose\./);
    assert.match(text, new RegExp(`Sign in with Google:\\s+${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`));
    assert.match(text, /choose bao@example\.com/);
    assert.doesNotMatch(text, /reset-password|Choose a password/);
    assert.equal(await one("SELECT r.token_hash FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'bao@example.com'"), undefined);
  } finally {
    resetConfig();
  }
});

test('someone who already signs in is told they were added, with no link anywhere', async () => {
  await call('POST', '/api/auth/register', { email: 'lena@example.com', name: 'Lena Fischer', password: 'lena-pass-1' });
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'lena@example.com', role: 'LEGAL' }, avery);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  assert.deepEqual(invite.json.invitation, { emailed: false });
  const text = lastMailTo('lena@example.com');
  assert.match(text, new RegExp(`"Avery Stone added you to Harbor Lane on ${product}"`));
  assert.match(text, /Avery Stone added you to Harbor Lane on .+\. Sign in as you usually do to see it\./);
  assert.match(text, /As part of legal \/ finance, you can see the whole company and change its cap table records\./);
  assert.match(text, new RegExp(`Open ${product}:`));
  assert.match(text, /ask Avery Stone to remove your access/);
  assert.doesNotMatch(text, /reset-password|password:/i);
  assert.equal(await one("SELECT r.token_hash FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'lena@example.com'"), undefined);
  assert.equal((await members()).find((m) => m.email === 'lena@example.com').neverSignedIn, false);
});

test('an invitation that fails sends nothing', async () => {
  const sent = mail.length;
  const rows = (await all("SELECT id FROM audit_log WHERE action LIKE 'INVITE_EMAIL%'")).length;
  const again = await call('POST', `/api/c/${cid}/members`, { email: 'lena@example.com', role: 'VIEWER' }, avery);
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already has access/);
  const badRole = await call('POST', `/api/c/${cid}/members`, { email: 'quinn@example.com', role: 'KING' }, avery);
  assert.equal(badRole.status, 400);
  const badAddress = await call('POST', `/api/c/${cid}/members`, { email: 'quinn at example', role: 'VIEWER' }, avery);
  assert.equal(badAddress.status, 400);
  assert.equal(mail.length, sent, 'no email');
  assert.equal((await all("SELECT id FROM audit_log WHERE action LIKE 'INVITE_EMAIL%'")).length, rows, 'and no attempt logged');
  assert.equal(await one("SELECT id FROM users WHERE email = 'quinn@example.com'"), undefined);
});

test('the link comes back only for an account nobody has signed in to that belongs to this company alone', async () => {
  // Rowan is new to Harbor Lane: the link comes back, as above.
  const first = await call('POST', `/api/c/${cid}/members`, { email: 'rowan@example.com', name: 'Rowan Park', role: 'INVESTOR' }, avery);
  assert.ok(first.json.invitation.link);
  // Tidewater invites the same Rowan. The email has a fresh link, which goes to Rowan,
  // but Rowan also belongs to Harbor Lane, so Tidewater is not handed a way in.
  const second = await call('POST', `/api/c/${otherCid}/members`, { email: 'rowan@example.com', role: 'VIEWER' }, morgan);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.deepEqual(second.json.invitation, { emailed: false });
  const text = lastMailTo('rowan@example.com');
  assert.match(text, /Morgan Lee invited you to join Tidewater Labs/);
  const emailed = linkIn(text);
  assert.ok(emailed, 'the email still carries a link');
  assert.equal((await call('GET', `/api/auth/reset/${tokenFrom(emailed)}`)).json.company, 'Tidewater Labs');
  assert.equal((await call('GET', `/api/auth/reset/${tokenFrom(first.json.invitation.link)}`)).json.valid, false, 'the newest link replaces the earlier one');
  // Members who signed in are never handed one, as shown for Lena above.
});

test('an administrator sends an invitation again to someone who has not signed in, with a link that replaces the old one', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'sam@example.com', name: 'Sam Ortiz', role: 'EMPLOYEE' }, avery);
  const memberId = invite.json.id as string;
  const oldLink = invite.json.invitation.link as string;

  const resent = await call('POST', `/api/c/${cid}/members/${memberId}/invite`, {}, avery);
  assert.equal(resent.status, 200, JSON.stringify(resent.json));
  assert.equal(resent.json.invitation.emailed, false);
  const newLink = resent.json.invitation.link as string;
  assert.ok(newLink && newLink !== oldLink);
  assert.equal(linkIn(lastMailTo('sam@example.com')), newLink);
  assert.equal(mailTo('sam@example.com').length, 2);
  assert.equal((await call('GET', `/api/auth/reset/${tokenFrom(oldLink)}`)).json.valid, false, 'the old link is retired');
  assert.equal((await call('GET', `/api/auth/reset/${tokenFrom(newLink)}`)).json.valid, true);

  // Administrators only, members of this company only, and only for someone still to sign in.
  const lena = (await call('POST', '/api/auth/login', { email: 'lena@example.com', password: 'lena-pass-1' })).token as string;
  assert.equal((await call('POST', `/api/c/${cid}/members/${memberId}/invite`, {}, lena)).status, 403, 'Lena is legal / finance, not an administrator');
  const tidewaterMember = (await members(otherCid, morgan)).find((m) => m.email === 'rowan@example.com');
  assert.equal((await call('POST', `/api/c/${cid}/members/${tidewaterMember.id}/invite`, {}, avery)).status, 404, 'another company’s member');
  assert.equal((await call('POST', `/api/c/${cid}/members/mem_nope/invite`, {}, avery)).status, 404);
  const lenaMember = (await members()).find((m) => m.email === 'lena@example.com');
  const signedIn = await call('POST', `/api/c/${cid}/members/${lenaMember.id}/invite`, {}, avery);
  assert.equal(signedIn.status, 400);
  assert.match(signedIn.json.error, /has signed in already/);
  assert.equal(mailTo('lena@example.com').filter((m) => !m.text.includes(`"Welcome to ${product}"`)).length, 1,
    'Lena was emailed once, when she was added, besides the welcome when she signed up');

  // Removing someone's access retires the invitation they have not used.
  assert.equal((await call('DELETE', `/api/c/${cid}/members/${memberId}`, undefined, avery)).status, 200);
  assert.equal((await call('GET', `/api/auth/reset/${tokenFrom(newLink)}`)).json.valid, false);
});

test('an address is sent no more invitation emails a day than the limit, even in a burst', async () => {
  configure({ auth: { inviteEmailsPerAddressPerDay: 3 } });
  try {
    const invite = await call('POST', `/api/c/${cid}/members`, { email: 'tess@example.com', name: 'Tess Wynn', role: 'VIEWER' }, avery);
    const memberId = invite.json.id as string;
    // Four resends at once on top of the invitation: two fit under the limit of three.
    const burst = await Promise.all([1, 2, 3, 4].map(() => call('POST', `/api/c/${cid}/members/${memberId}/invite`, {}, avery)));
    assert.deepEqual(burst.map((r) => r.status).sort(), [200, 200, 400, 400], JSON.stringify(burst.map((r) => r.json)));
    const refused = burst.find((r) => r.status === 400)!;
    assert.equal(refused.json.error, 'tess@example.com has reached the limit of 3 invitation emails a day. Try again tomorrow.');
    assert.equal(mailTo('tess@example.com').length, 3);
    assert.equal((await inviteRows('tess@example.com')).length, 3, 'one log entry per email');

    // Over the limit, inviting still grants access but sends nothing. Tess belongs to
    // Harbor Lane too, so Tidewater is not handed a link instead.
    const elsewhere = await call('POST', `/api/c/${otherCid}/members`, { email: 'tess@example.com', role: 'VIEWER' }, morgan);
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
    assert.deepEqual(elsewhere.json.invitation, { emailed: false, limited: true });
    assert.equal(mailTo('tess@example.com').length, 3);
    assert.ok(await one("SELECT id FROM audit_log WHERE action = 'INVITE_EMAIL_SKIPPED' AND company_id = ?", otherCid));

    // A day later the count starts again.
    await run('UPDATE invite_emails SET created_at = ?', new Date(Date.now() - 25 * 3_600_000).toISOString());
    assert.equal((await call('POST', `/api/c/${cid}/members/${memberId}/invite`, {}, avery)).status, 200);
    assert.equal(mailTo('tess@example.com').length, 4);
  } finally {
    resetConfig();
  }
});

test('an invitation link lasts auth.inviteLinkDays, while a forgotten-password link still lasts auth.resetLinkMinutes', async () => {
  configure({ auth: { inviteLinkDays: 3, resetLinkMinutes: 45 } });
  try {
    const invite = await call('POST', `/api/c/${cid}/members`, { email: 'uma@example.com', name: 'Uma Bell', role: 'VIEWER' }, avery);
    const row = await one<{ expires_at: string }>("SELECT expires_at FROM password_resets WHERE purpose = 'INVITE' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1");
    const days = (new Date(row!.expires_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 2.99 && days <= 3, `${days}`);
    assert.match(lastMailTo('uma@example.com'), /expires in 3 days/);
    assert.ok(invite.json.invitation.link);

    // An ordinary reset is unchanged: its own lifetime, no company, and the usual audit entry.
    await call('POST', '/api/auth/register', { email: 'vic@example.com', name: 'Vic Hale', password: 'vic-pass-123' });
    const forgot = await call('POST', '/api/auth/forgot', { email: 'vic@example.com' });
    const minutes = (new Date(forgot.json.expiresAt).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 44 && minutes <= 45, `${minutes}`);
    const token = tokenFrom(forgot.json.resetUrl);
    assert.deepEqual((await call('GET', `/api/auth/reset/${token}`)).json, { valid: true, email: 'vic@example.com', name: 'Vic Hale', purpose: 'RESET' });
    assert.match(lastMailTo('vic@example.com'), /Reset your .+ password/);
    const reset = await call('POST', '/api/auth/reset', { token, password: 'vic-pass-456' });
    assert.equal(reset.status, 200);
    assert.ok(await one("SELECT id FROM audit_log WHERE action = 'PASSWORD_RESET' AND entity_id = ? AND company_id IS NULL", reset.json.user.id));
    assert.equal((await one<{ purpose: string }>("SELECT r.purpose FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'vic@example.com'"))!.purpose, 'RESET');
  } finally {
    resetConfig();
  }
});

test('the invitation email escapes the names it carries, and keeps them out of the subject’s line breaks', () => {
  const hostile = '<script>x</script>';
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  for (const kind of ['password', 'google', 'existing'] as const) {
    const message = composeInviteEmail({
      to: { email: 'wren@example.com', name: hostile }, inviter: `${hostile} "Boss"`, company: `${hostile} & Co\nBcc: x@example.com`,
      role: 'ADMIN', kind, link: kind === 'password' ? `${app}/reset-password?token=abc` : app, expiresAt, google: true,
    });
    assert.ok(!message.html!.includes(hostile), `${kind}: no name reaches the HTML as markup`);
    assert.ok(message.html!.includes('&lt;script&gt;x&lt;/script&gt; &amp; Co'));
    assert.ok(message.html!.includes('&lt;script&gt;x&lt;/script&gt; &quot;Boss&quot;'));
    assert.ok(!/[\r\n]/.test(message.subject), `${kind}: the subject is one line`);
    assert.equal(message.to, 'wren@example.com');
    assert.ok(message.text.includes(`${hostile} "Boss"`), 'the plain text keeps the names as typed');
    assert.match(message.text, /As an administrator, you can see the whole company, change its records and settings, and decide who has access\./);
    assert.doesNotMatch(message.text, /<(a|p|table|td|h1|h2|ul|li|br)\b/, 'and has no markup of its own');
  }
});

test('an invitation link stops working once its owner signs in, so it is no way into a company they join later', async () => {
  // Mail is off, so Avery is handed Xan's link to pass on.
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'xan@example.com', name: 'Xan Reyes', role: 'VIEWER' }, avery);
  const token = tokenFrom(invite.json.invitation.link);
  assert.equal((await call('GET', `/api/auth/reset/${token}`)).json.valid, true);
  // Xan takes up the invitation with Google instead, as the email can offer…
  await upsertGoogleUser({ sub: 'google-xan', email: 'xan@example.com', emailVerified: true, name: 'Xan Reyes', picture: null, hostedDomain: null });
  const row = await one<{ used_at: string | null }>("SELECT r.used_at FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'xan@example.com'");
  assert.ok(row!.used_at, 'claiming the account retires the link');
  // …and Tidewater then adds Xan, who signs in already, so nothing new is issued.
  const elsewhere = await call('POST', `/api/c/${otherCid}/members`, { email: 'xan@example.com', role: 'ADMIN' }, morgan);
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
  assert.deepEqual(elsewhere.json.invitation, { emailed: false });
  // The link Avery holds can neither be read nor set Xan's password, so it does not open Tidewater.
  assert.deepEqual((await call('GET', `/api/auth/reset/${token}`)).json, { valid: false });
  const used = await call('POST', '/api/auth/reset', { token, password: 'avery-takes-over' });
  assert.equal(used.status, 400);
  assert.match(used.json.error, /not valid any more/);

  // However someone signs in, an invitation still waiting for them stops working.
  const yara = await call('POST', `/api/c/${cid}/members`, { email: 'yara@example.com', name: 'Yara Cole', role: 'VIEWER' }, avery);
  const yaraToken = tokenFrom(yara.json.invitation.link);
  await run("UPDATE users SET last_login_at = ? WHERE email = 'yara@example.com'", new Date().toISOString());
  assert.deepEqual((await call('GET', `/api/auth/reset/${yaraToken}`)).json, { valid: false });
  assert.equal((await call('POST', '/api/auth/reset', { token: yaraToken, password: 'not-yara-at-all' })).status, 400);
});

test('a link handed to an administrator stops working once the person belongs to another company too', async () => {
  configure({ auth: { inviteEmailsPerAddressPerDay: 2 } });
  try {
    const invite = await call('POST', `/api/c/${cid}/members`, { email: 'yusuf@example.com', name: 'Yusuf Adler', role: 'VIEWER' }, avery);
    const resent = await call('POST', `/api/c/${cid}/members/${invite.json.id}/invite`, {}, avery);
    assert.equal(resent.status, 200, JSON.stringify(resent.json));
    const token = tokenFrom(resent.json.invitation.link);
    assert.equal((await call('GET', `/api/auth/reset/${token}`)).json.valid, true);
    // Tidewater's invitation is over the limit, so it sends nothing and makes no new link to replace Avery's…
    const elsewhere = await call('POST', `/api/c/${otherCid}/members`, { email: 'yusuf@example.com', role: 'ADMIN' }, morgan);
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
    assert.deepEqual(elsewhere.json.invitation, { emailed: false, limited: true });
    // …but Yusuf belongs to Tidewater now as well, so the link Avery was handed lets nobody in.
    assert.deepEqual((await call('GET', `/api/auth/reset/${token}`)).json, { valid: false });
    assert.equal((await call('POST', '/api/auth/reset', { token, password: 'avery-takes-over' })).status, 400);
  } finally {
    resetConfig();
  }
});

test('changing the address of someone invited retires the link sent to the old one', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'jon@exmaple.com', name: 'Jon Varga', role: 'ADMIN' }, avery);
  const token = tokenFrom(linkIn(lastMailTo('jon@exmaple.com')));
  assert.equal(token, tokenFrom(invite.json.invitation.link));
  const fixed = await call('PATCH', `/api/c/${cid}/members/${invite.json.id}`, { email: 'jon@example.com' }, avery);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal(fixed.json.neverSignedIn, true, 'so the page offers to send the invitation again');
  assert.deepEqual((await call('GET', `/api/auth/reset/${token}`)).json, { valid: false });
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'typo-owner-1' })).status, 400);
  // Sent again, it goes to the corrected address with a link of its own.
  const resent = await call('POST', `/api/c/${cid}/members/${invite.json.id}/invite`, {}, avery);
  assert.equal(resent.status, 200, JSON.stringify(resent.json));
  const fresh = tokenFrom(linkIn(lastMailTo('jon@example.com')));
  assert.equal((await call('GET', `/api/auth/reset/${fresh}`)).json.email, 'jon@example.com');
});

test('the daily limit holds for an address when the company that invited it is deleted, or its invitation moves to a new account', async () => {
  configure({ auth: { inviteEmailsPerAddressPerDay: 2 } });
  try {
    const first = (await call('POST', '/api/companies', { name: 'Gone Tomorrow' }, avery)).json.id as string;
    const invite = await call('POST', `/api/c/${first}/members`, { email: 'zed@example.com', name: 'Zed Moss', role: 'VIEWER' }, avery);
    assert.equal((await call('POST', `/api/c/${first}/members/${invite.json.id}/invite`, {}, avery)).status, 200);
    assert.equal(mailTo('zed@example.com').length, 2);
    assert.equal((await call('DELETE', `/api/c/${first}?confirm=${encodeURIComponent('Gone Tomorrow')}`, undefined, avery)).status, 200);

    // A new company's invitation still finds the address at its limit…
    const second = (await call('POST', '/api/companies', { name: 'Back Again' }, avery)).json.id as string;
    const again = await call('POST', `/api/c/${second}/members`, { email: 'zed@example.com', role: 'VIEWER' }, avery);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.invitation.limited, true);
    assert.equal(mailTo('zed@example.com').length, 2);

    // …and so does one to a new account for the address, once the first has been moved to another.
    const moved = await call('PATCH', `/api/c/${second}/members/${again.json.id}`, { email: 'zed.old@example.com' }, avery);
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    const fresh = await call('POST', `/api/c/${second}/members`, { email: 'zed@example.com', role: 'VIEWER' }, avery);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
    assert.equal(fresh.json.invitation.limited, true);
    assert.equal(mailTo('zed@example.com').length, 2);
  } finally {
    resetConfig();
  }
});

test('Google is offered only to an address it accepts, and with passwords off an address it turns away cannot be invited', async () => {
  const clientId = 'invite-test.apps.googleusercontent.com';
  configure({ auth: { google: { clientId, allowedDomains: ['marlowe.example'] } } });
  try {
    assert.equal((await call('POST', `/api/c/${cid}/members`, { email: 'oona@outside.example', name: 'Oona Lund', role: 'VIEWER' }, avery)).status, 200);
    assert.match(lastMailTo('oona@outside.example'), /Choose a password:/);
    assert.doesNotMatch(lastMailTo('oona@outside.example'), /Google/, 'Google would turn Oona away');
    assert.equal((await call('POST', `/api/c/${cid}/members`, { email: 'pia@marlowe.example', name: 'Pia Holt', role: 'VIEWER' }, avery)).status, 200);
    assert.match(lastMailTo('pia@marlowe.example'), /Sign in with Google as pia@marlowe\.example/);
  } finally {
    resetConfig();
  }

  configure({ auth: { passwordSignIn: false, google: { clientId, allowedDomains: ['marlowe.example'] } } });
  try {
    const sent = mail.length;
    const refused = await call('POST', `/api/c/${cid}/members`, { email: 'quill@outside.example', role: 'VIEWER' }, avery);
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error,
      'quill@outside.example could not sign in: password sign-in is turned off on this server, and Google sign-in only accepts @marlowe.example accounts.');
    assert.equal(mail.length, sent, 'no email');
    assert.equal(await one("SELECT id FROM users WHERE email = 'quill@outside.example'"), undefined, 'and no account or access');
    assert.equal((await call('POST', `/api/c/${cid}/members`, { email: 'rue@marlowe.example', role: 'VIEWER' }, avery)).status, 200);
    assert.match(lastMailTo('rue@marlowe.example'), /Sign in with Google using rue@marlowe\.example/);
  } finally {
    resetConfig();
  }
});
