/**
 * Password recovery over HTTP: forgot-password links (issued, single-use,
 * expiring, throttled, never revealing whether an address exists), signed-in
 * password changes, and administrator resets by link or temporary password
 * with the forced change at the next sign-in.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase } from './helpers.ts';

delete process.env.SMTP_URL;                 // the console transport: links come back in the response
delete process.env.NODE_ENV;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
const { one, run } = await import('../src/db.ts');

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
const tokenFrom = (url: string): string => new URL(url).searchParams.get('token')!;

test('a forgotten password is reset through a single-use link that signs the person in and out everywhere else', async () => {
  const reg = await call('POST', '/api/auth/register', { email: 'Priya@Example.com', name: 'Priya Raman', password: 'first-password' });
  assert.equal(reg.status, 200);
  const oldSession = reg.json.token as string;
  const secondSession = (await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'first-password' })).json.token as string;

  // Unknown addresses get the same answer as known ones.
  const unknown = await call('POST', '/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, { ok: true, mailConfigured: false });
  assert.equal((await call('POST', '/api/auth/forgot', { email: 'not-an-email' })).status, 400);

  // Known address: mail is not configured, so the link comes back for development use.
  const forgot = await call('POST', '/api/auth/forgot', { email: 'priya@example.com' });
  assert.equal(forgot.status, 200);
  assert.match(forgot.json.resetUrl, /^http:\/\/localhost:5173\/reset-password\?token=/);
  const token = tokenFrom(forgot.json.resetUrl);
  const stored = await one<{ token_hash: string; used_at: string | null }>('SELECT * FROM password_resets');
  assert.notEqual(stored!.token_hash, token);                                          // only a hash is kept
  assert.equal(stored!.used_at, null);

  // The page can check the link before asking for a password.
  const peek = await call('GET', `/api/auth/reset/${token}`);
  assert.deepEqual(peek.json, { valid: true, email: 'priya@example.com', name: 'Priya Raman', purpose: 'RESET' });
  assert.deepEqual((await call('GET', '/api/auth/reset/garbage')).json, { valid: false });

  // Weak passwords are refused without spending the link.
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await call('GET', `/api/auth/reset/${token}`)).json.valid, true);

  const reset = await call('POST', '/api/auth/reset', { token, password: 'second-password' });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.user.email, 'priya@example.com');
  assert.equal(reset.json.user.mustChangePassword, false);
  const newSession = reset.json.token as string;
  assert.equal((await call('GET', '/api/auth/me', undefined, newSession)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, oldSession)).status, 401);      // earlier sessions are gone
  assert.equal((await call('GET', '/api/auth/me', undefined, secondSession)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'first-password' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'priya@example.com', password: 'second-password' })).status, 200);

  // The link is spent.
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'third-password' })).status, 400);
  assert.deepEqual((await call('GET', `/api/auth/reset/${token}`)).json, { valid: false });

  // Audit trail, without a company.
  const audits = await one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET')");
  assert.equal(audits!.n, 2);
});

test('links expire, a new request replaces the old link, and requests are throttled to three an hour', async () => {
  await call('POST', '/api/auth/register', { email: 'bao@example.com', name: 'Bao Nguyen', password: 'bao-password-1' });
  const first = tokenFrom((await call('POST', '/api/auth/forgot', { email: 'bao@example.com' })).json.resetUrl);
  const second = tokenFrom((await call('POST', '/api/auth/forgot', { email: 'bao@example.com' })).json.resetUrl);
  assert.equal((await call('GET', `/api/auth/reset/${first}`)).json.valid, false);          // superseded
  assert.equal((await call('GET', `/api/auth/reset/${second}`)).json.valid, true);

  await run('UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL', new Date(Date.now() - 1000).toISOString());
  assert.equal((await call('GET', `/api/auth/reset/${second}`)).json.valid, false);
  assert.equal((await call('POST', '/api/auth/reset', { token: second, password: 'bao-password-2' })).status, 400);

  const third = await call('POST', '/api/auth/forgot', { email: 'bao@example.com' });
  assert.ok(third.json.resetUrl);
  const fourth = await call('POST', '/api/auth/forgot', { email: 'bao@example.com' });
  assert.equal(fourth.status, 200);
  assert.equal(fourth.json.resetUrl, undefined);                                           // throttled, silently
});

test('a signed-in person changes their password; other sessions end, this one stays', async () => {
  const a = (await call('POST', '/api/auth/register', { email: 'marcus@example.com', name: 'Marcus Webb', password: 'marcus-pass-1' })).json.token as string;
  const b = (await call('POST', '/api/auth/login', { email: 'marcus@example.com', password: 'marcus-pass-1' })).json.token as string;

  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'marcus-pass-2' }, a)).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'marcus-pass-1', newPassword: 'short' }, a)).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'marcus-pass-1', newPassword: 'marcus-pass-1' }, a)).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'marcus-pass-1', newPassword: 'marcus-pass-2' })).status, 401);

  const ok = await call('POST', '/api/auth/change-password', { currentPassword: 'marcus-pass-1', newPassword: 'marcus-pass-2' }, a);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, a)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, b)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'marcus@example.com', password: 'marcus-pass-2' })).status, 200);
});

test('an administrator resets a member by link or temporary password; the member must then choose their own', async () => {
  const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
  const company = (await call('POST', '/api/companies', { name: 'Reset Co' }, admin)).json;
  const cid = company.id as string;
  const lena = (await call('POST', '/api/auth/register', { email: 'lena@example.com', name: 'Lena Fischer', password: 'lena-pass-1' })).json.token as string;
  const legal = (await call('POST', '/api/auth/register', { email: 'legal@example.com', name: 'Legal Eagle', password: 'legal-pass-1' })).json.token as string;
  const member = (await call('POST', `/api/c/${cid}/members`, { email: 'lena@example.com', role: 'VIEWER' }, admin)).json;
  const legalMember = (await call('POST', `/api/c/${cid}/members`, { email: 'legal@example.com', role: 'LEGAL' }, admin)).json;
  const me = (await call('GET', `/api/c/${cid}/members`, undefined, admin)).json.find((m: any) => m.email === 'avery@example.com');

  // Only administrators, only for others, only known modes.
  assert.equal((await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'link' }, legal)).status, 403);
  assert.equal((await call('POST', `/api/c/${cid}/members/${me.id}/reset-password`, { mode: 'link' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'carrier-pigeon' }, admin)).status, 400);
  assert.equal((await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'email' }, admin)).status, 400);   // mail not configured
  assert.equal((await call('POST', `/api/c/${cid}/members/mem_nope/reset-password`, { mode: 'link' }, admin)).status, 404);
  void legalMember;

  // A link to pass on: Lena's sessions end at once, the link works for a day.
  const link = await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'link' }, admin);
  assert.equal(link.status, 200);
  assert.equal(link.json.emailed, false);
  assert.match(link.json.resetUrl, /\/reset-password\?token=/);
  assert.ok(new Date(link.json.expiresAt).getTime() - Date.now() > 23 * 3_600_000);
  assert.equal((await call('GET', '/api/auth/me', undefined, lena)).status, 401);
  const viaLink = await call('POST', '/api/auth/reset', { token: tokenFrom(link.json.resetUrl), password: 'lena-pass-2' });
  assert.equal(viaLink.status, 200);
  assert.equal(viaLink.json.user.mustChangePassword, false);

  // A temporary password: generated when none is given, must be changed at the next sign-in.
  const temp = await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'temporary' }, admin);
  assert.equal(temp.status, 200);
  assert.match(temp.json.temporaryPassword, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  assert.equal((await call('GET', '/api/auth/me', undefined, viaLink.json.token)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'lena@example.com', password: 'lena-pass-2' })).status, 401);
  const tempLogin = await call('POST', '/api/auth/login', { email: 'lena@example.com', password: temp.json.temporaryPassword });
  assert.equal(tempLogin.status, 200);
  assert.equal(tempLogin.json.user.mustChangePassword, true);
  assert.equal((await call('GET', '/api/auth/me', undefined, tempLogin.json.token)).json.user.mustChangePassword, true);
  const changed = await call('POST', '/api/auth/change-password', { currentPassword: temp.json.temporaryPassword, newPassword: 'lena-owns-this-1' }, tempLogin.json.token);
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, tempLogin.json.token)).json.user.mustChangePassword, false);

  // An administrator may also choose the temporary password, within the same rules.
  assert.equal((await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'temporary', password: 'short' }, admin)).status, 400);
  const chosen = await call('POST', `/api/c/${cid}/members/${member.id}/reset-password`, { mode: 'temporary', password: 'Welcome-Lena-2026' }, admin);
  assert.equal(chosen.json.temporaryPassword, 'Welcome-Lena-2026');
  assert.equal((await call('POST', '/api/auth/login', { email: 'lena@example.com', password: 'Welcome-Lena-2026' })).status, 200);

  const trail = await one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'PASSWORD_RESET' AND company_id = ?", cid);
  assert.equal(trail!.n, 3);
});

test('a reset link always points at app.url, whatever Origin the request claims', async () => {
  const { config } = await import('../src/config.ts');
  await call('POST', '/api/auth/register', { email: 'nadia@example.com', name: 'Nadia Okafor', password: 'nadia-pass-1' });
  const res = await fetch(`${base}/api/auth/forgot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Referer: 'https://evil.example/phish' },
    body: JSON.stringify({ email: 'nadia@example.com' }),
  });
  const json = (await res.json()) as { resetUrl: string };
  assert.equal(res.status, 200);
  assert.ok(json.resetUrl.startsWith(`${config().app.url}/reset-password?token=`), json.resetUrl);
});

test('password rules, link lifetimes and the product name in the email follow the settings', async () => {
  const { configure, resetConfig } = await import('../src/config.ts');
  configure({ auth: { passwordMinLength: 12, resetLinkMinutes: 30 }, brand: { productName: 'Ledgerly' } });
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const short = await call('POST', '/api/auth/register', { email: 'omar@example.com', name: 'Omar Haddad', password: 'eleven-char' });
    assert.equal(short.status, 400);
    assert.match(short.json.error, /at least 12 characters/);
    assert.equal((await call('POST', '/api/auth/register', { email: 'omar@example.com', name: 'Omar Haddad', password: 'twelve-chars' })).status, 200);

    const forgot = await call('POST', '/api/auth/forgot', { email: 'omar@example.com' });
    const minutes = (new Date(forgot.json.expiresAt).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 29 && minutes <= 30, `the link lasts resetLinkMinutes (${minutes})`);
    // Signing up sent Omar a welcome first; the reset email is the other one.
    const mail = logged.find((l) => l.includes('omar@example.com') && !l.includes('"Welcome to Ledgerly"')) ?? '';
    assert.match(mail, /Reset your Ledgerly password/);
    assert.match(mail, /reset the password for your Ledgerly account\./);
    assert.match(mail, /Account: +omar@example\.com/);
    assert.match(mail, /works once and expires in 30 minutes/);
    assert.match(mail, /Choose a new password:\s+http:\/\/localhost:5173\/reset-password\?token=/);
    assert.match(mail, /— Ledgerly/);
    assert.doesNotMatch(mail, /Kosmitor/);
  } finally {
    console.log = realLog;
    resetConfig();
  }
});

test('an operator can turn off self-service sign-up and password sign-in; invitations keep working', async () => {
  const { configure, resetConfig } = await import('../src/config.ts');
  const owner = (await call('POST', '/api/auth/register', { email: 'jo@example.com', name: 'Jo Marsh', password: 'jo-password-1' })).json.token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Closed Doors' }, owner)).json.id as string;
  const defaults = (await call('GET', '/api/auth/config')).json;
  assert.equal(defaults.passwordSignIn, true);
  assert.equal(defaults.selfSignup, true);

  configure({ auth: { selfSignup: false } });
  try {
    const shown = (await call('GET', '/api/auth/config')).json;
    assert.equal(shown.selfSignup, false);
    assert.equal(shown.passwordSignIn, true);
    const refused = await call('POST', '/api/auth/register', { email: 'walk-in@example.com', name: 'Walk In', password: 'walk-in-pass-1' });
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /invitation only/);
    assert.equal(await one('SELECT id FROM users WHERE email = ?', 'walk-in@example.com'), undefined);
    // Existing accounts still sign in, and an administrator can still invite someone new.
    assert.equal((await call('POST', '/api/auth/login', { email: 'jo@example.com', password: 'jo-password-1' })).status, 200);
    assert.equal((await call('POST', `/api/c/${cid}/members`, { email: 'invitee@example.com', name: 'Ivy Invitee', role: 'VIEWER' }, owner)).status, 200);
  } finally {
    resetConfig();
  }

  configure({ auth: { passwordSignIn: false } });
  try {
    assert.equal((await call('GET', '/api/auth/config')).json.passwordSignIn, false);
    const login = await call('POST', '/api/auth/login', { email: 'jo@example.com', password: 'jo-password-1' });
    assert.equal(login.status, 403);
    assert.match(login.json.error, /Password sign-in is turned off/);
    assert.equal((await call('POST', '/api/auth/register', { email: 'walk-in@example.com', name: 'Walk In', password: 'walk-in-pass-1' })).status, 403);
    // Nothing else that sets a password works either, or a reset would be a way round Google.
    assert.equal((await call('POST', '/api/auth/forgot', { email: 'jo@example.com' })).status, 403);
    assert.equal((await call('POST', '/api/auth/reset', { token: 'x'.repeat(43), password: 'another-pass-1' })).status, 403);
  } finally {
    resetConfig();
  }
  assert.equal((await call('POST', '/api/auth/login', { email: 'jo@example.com', password: 'jo-password-1' })).status, 200);
});

test('the reset email someone asks for reads the same in HTML and plain text, with the link, the account and the reassurance', async () => {
  const { composeResetEmail } = await import('../src/routes/auth.ts');
  const { config } = await import('../src/config.ts');
  const product = config().brand.productName;
  const link = `${config().app.url}/reset-password?token=abc123-XYZ_789`;
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const mail = composeResetEmail({ to: { email: 'hana@example.com', name: 'Hana Ito' }, link, expiresAt, byAdmin: null });

  assert.equal(mail.to, 'hana@example.com');
  assert.equal(mail.toName, 'Hana Ito');
  assert.equal(mail.replyTo, undefined);
  assert.equal(mail.subject, `Reset your ${product} password`);
  assert.ok(mail.subject.length <= 60, mail.subject);
  assert.ok(mail.html && mail.text, 'both parts are present');
  assert.ok(mail.html.includes(`href="${link}"`), 'the button links to the reset page');
  assert.ok(mail.text.includes(link), 'the plain text carries the link');
  for (const part of [mail.html, mail.text]) {
    assert.match(part, /Hi Hana Ito,/);
    assert.match(part, /hana@example\.com/);
    assert.match(part, /Choose a new password/);
    assert.match(part, /works once and expires in 1 hour/);
    assert.match(part, /If it was not you, you can ignore this email\. Your password stays the same, and nothing changes until the link is used\./);
    assert.match(part, /do not forward this email/);
    assert.match(part, /Forgot your password\?/);
    assert.ok(part.includes(`— ${product}`), 'signed by the product');
  }
  assert.doesNotMatch(mail.text, /<[a-z]/i, 'the plain text has no markup');
  // The plain text has no heading, so its first sentence must say what this is on its own.
  assert.match(mail.text.split('\n\n')[1], /^Someone asked to reset the password for your .+ account\./);
});

test('a reset by an administrator says who did it and from which company, and escapes every name', async () => {
  const { composeResetEmail } = await import('../src/routes/auth.ts');
  const { config } = await import('../src/config.ts');
  const product = config().brand.productName;
  const link = `${config().app.url}/reset-password?token=def456`;
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const mail = composeResetEmail({
    to: { email: 'lena@example.com', name: 'Lena Fischer' }, link, expiresAt, byAdmin: 'Avery Stone', company: 'Reset Co',
  });
  assert.equal(mail.subject, `Set a new password for your ${product} account`);
  assert.ok(mail.subject.length <= 60, mail.subject);
  assert.ok(mail.html!.includes(`href="${link}"`));
  assert.ok(mail.text.includes(link));
  for (const part of [mail.html!, mail.text]) {
    assert.match(part, /Avery Stone, an administrator of Reset Co, sent you a link to set a new password for your .+ account\./);
    assert.match(part, /Reset by/);
    assert.match(part, /lena@example\.com/);
    assert.match(part, /expires in 24 hours/);
    assert.match(part, /ask Avery Stone for a new one/);
    // Nothing a person who asked for it would be told: this one was not their request.
    assert.doesNotMatch(part, /Someone asked/);
  }

  const hostile = '<script>x</script>';
  const evil = composeResetEmail({
    to: { email: 'lena@example.com', name: hostile }, link, expiresAt, byAdmin: hostile, company: `${hostile} & Co`,
  });
  assert.ok(!evil.html!.includes(hostile), 'no name reaches the HTML as markup');
  assert.ok(evil.html!.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(evil.html!.includes('&lt;script&gt;x&lt;/script&gt; &amp; Co'));
  assert.ok(evil.text.includes(`Hi ${hostile},`), 'the plain text keeps the name as typed');
  assert.ok(!/[\r\n]/.test(evil.subject), 'no name reaches the subject line');
  assert.equal(evil.to, 'lena@example.com');
});
