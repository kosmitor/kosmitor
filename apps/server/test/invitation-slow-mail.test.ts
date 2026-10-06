/**
 * Invitation emails through a mail server, and one that takes its time. The
 * stand-in below accepts or refuses each message, and holds them until the test
 * lets them through, so what happens while an invitation is still on its way can
 * be checked: the invitation has committed and holds no lock on the company, an
 * email that goes out hands no link back, one that is refused leaves the
 * invitation standing, and a burst of invitations or resends to one address,
 * from one company or several, sends no more than the daily limit. Signing up
 * never waits for its welcome email, and a server that stops waits for it.
 *
 * A file of its own because the mail transport is chosen when the server starts,
 * and invitations.test.ts reads its mail from the console. Nothing here leaves
 * the machine: the only mail server is the stand-in on localhost.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { freshDatabase } from './helpers.ts';

// --- A mail server that holds each message until it is let through --------------

/** Each message the stand-in has accepted, by recipient. */
const received: string[] = [];
/** The messages read while holding, each waiting for the reply that accepts it. */
const waiting: (() => void)[] = [];
let holding = false;
/** Lets every held message through, and the ones after them straight away. */
const release = () => { holding = false; for (const accept of waiting.splice(0)) accept(); };

const smtp: Server = createServer((socket: Socket) => {
  let inData = false;
  let buffer = '';
  let to = '';
  socket.write('220 stand-in ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          const accept = () => { received.push(to); socket.write('250 2.0.0 queued\r\n'); };
          if (holding) waiting.push(accept); else accept();
        }
        continue;
      }
      if (/^EHLO /.test(line)) socket.write('250-stand-in\r\n250 8BITMIME\r\n');   // no STARTTLS: allowed on localhost
      else if (/^MAIL FROM:/.test(line)) socket.write('250 ok\r\n');
      else if (/^RCPT TO:/.test(line)) {
        to = line.match(/<([^>]*)>/)?.[1] ?? '';
        // An address that bounces, as a mistyped one does.
        socket.write(to.startsWith('bounce') ? '550 5.1.1 no such mailbox\r\n' : '250 ok\r\n');
      }
      else if (line === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 what\r\n');
    }
  });
  socket.on('error', () => undefined);
});
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
after(() => { release(); smtp.close(); });

// Mail goes to the stand-in and nowhere else. These win over apps/server/.env.
process.env.SMTP_URL = `smtp://127.0.0.1:${(smtp.address() as AddressInfo).port}`;
process.env.ACS_CONNECTION_STRING = '';
process.env.GOOGLE_CLIENT_ID = '';

await freshDatabase();
const { handle } = await import('../src/http.ts');
const { welcomesSent } = await import('../src/routes/auth.ts');
const { configure, resetConfig } = await import('../src/config.ts');
const { one, all, transaction } = await import('../src/db.ts');

const api: HttpServer = createHttpServer((req, res) => { void handle(req, res); });
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

/** Waits for something the server does in its own time, for up to five seconds. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const welcomeLogOf = async (email: string) => (await all<{ action: string }>(
  `SELECT a.action FROM audit_log a JOIN users u ON u.id = a.entity_id WHERE u.email = ? AND a.action LIKE 'WELCOME_%' ORDER BY a.created_at, a.id`, email)).map((r) => r.action);
const logOf = (email: string) => all<{ action: string }>(
  `SELECT a.action FROM audit_log a JOIN users u ON u.id = a.entity_id WHERE u.email = ? AND a.action LIKE 'INVITE_EMAIL%' ORDER BY a.created_at, a.id`, email);

// Made-up people: Avery runs four companies and invites people to them.
const avery = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).json.token as string;
// Signing up sends a welcome email without waiting for it; it is let through before any test counts what arrives.
await until(() => received.includes('avery@example.com'), 'Avery’s welcome email');
const companies: string[] = [];
for (const name of ['Slow Mail Harbor', 'Kestrel Works', 'Fernhill Bio', 'Quarry Point']) {
  companies.push((await call('POST', '/api/companies', { name }, avery)).json.id as string);
}
const [cid] = companies;

test('an invitation that goes out says so and hands no link back', async () => {
  received.length = 0;
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, avery);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  assert.deepEqual(invite.json.invitation, { emailed: true }, 'the link went to Priya, and only to her');
  assert.deepEqual(received, ['priya@example.com']);
  assert.deepEqual((await logOf('priya@example.com')).map((r) => r.action), ['INVITE_EMAILED']);
});

test('an invitation has committed, and holds no lock on the company, while its email waits on a slow mail server', async () => {
  try {
    received.length = 0;
    holding = true;
    const invite = call('POST', `/api/c/${cid}/members`, { email: 'hana@example.com', name: 'Hana Ito', role: 'VIEWER' }, avery);
    await until(() => waiting.length === 1, 'the invitation to reach the mail server');
    assert.ok(await one("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'hana@example.com' AND m.company_id = ?", cid),
      'the access is already committed');
    assert.ok(await one('SELECT id FROM companies WHERE id = ? FOR UPDATE NOWAIT', cid), 'nothing holds the company’s lock');
    assert.deepEqual((await logOf('hana@example.com')).map((r) => r.action), ['INVITE_EMAIL_PENDING'], 'the attempt is logged before it is sent');
    release();
    const done = await invite;
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(done.json.invitation, { emailed: true });
    assert.deepEqual(received, ['hana@example.com']);
    assert.deepEqual((await logOf('hana@example.com')).map((r) => r.action), ['INVITE_EMAILED']);
  } finally {
    release();
  }
});

test('an email the mail server refuses never undoes the invitation, and the link comes back instead', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'bounce.bao@example.com', name: 'Bao Nguyen', role: 'VIEWER' }, avery);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));
  assert.equal(invite.json.invitation.emailed, false);
  assert.match(invite.json.invitation.link, /\/reset-password\?token=/, 'a new account belongs to this company alone, so the link can be passed on');
  assert.ok(await one("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'bounce.bao@example.com'"));
  assert.deepEqual((await logOf('bounce.bao@example.com')).map((r) => r.action), ['INVITE_EMAIL_FAILED']);
  const token = new URL(invite.json.invitation.link).searchParams.get('token')!;
  assert.equal((await call('GET', `/api/auth/reset/${token}`)).json.company, 'Slow Mail Harbor');
});

test('a burst of resends while the mail server holds them sends no more than the daily limit', async () => {
  configure({ auth: { inviteEmailsPerAddressPerDay: 2 } });
  try {
    received.length = 0;
    holding = true;
    const invite = call('POST', `/api/c/${cid}/members`, { email: 'sam@example.com', name: 'Sam Ortiz', role: 'EMPLOYEE' }, avery);
    await until(() => waiting.length === 1, 'the invitation to reach the mail server');
    const memberId = (await one<{ id: string }>("SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'sam@example.com'"))!.id;
    // The first email has not gone yet, so a limit counted from emails sent would let every resend through.
    const resends = [1, 2, 3].map(() => call('POST', `/api/c/${cid}/members/${memberId}/invite`, {}, avery));
    await until(() => waiting.length >= 2, 'the resend within the limit to reach the mail server');
    release();
    const answers = await Promise.all([invite, ...resends]);
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 200, 400, 400], JSON.stringify(answers.map((a) => a.json)));
    assert.deepEqual(received, ['sam@example.com', 'sam@example.com'], 'two emails, the limit, and no more');
    assert.deepEqual((await logOf('sam@example.com')).map((r) => r.action), ['INVITE_EMAILED', 'INVITE_EMAILED']);
  } finally {
    release();
    resetConfig();
  }
});

test('invitations to one address from several companies at once send no more than the daily limit', async () => {
  configure({ auth: { inviteEmailsPerAddressPerDay: 2 } });
  try {
    await call('POST', '/api/auth/register', { email: 'zoe@example.com', name: 'Zoe Park', password: 'zoe-pass-123' });
    await until(() => received.includes('zoe@example.com'), 'Zoe’s welcome email');
    received.length = 0;
    holding = true;
    // Each company has its own lock, so only the person's own row keeps these from all
    // counting at once. The test holds that row while the four arrive, so that they all
    // set off together the moment it lets go.
    let invites: ReturnType<typeof call>[] = [];
    await transaction(async () => {
      await one("SELECT id FROM users WHERE email = 'zoe@example.com' FOR UPDATE");
      invites = companies.map((company) => call('POST', `/api/c/${company}/members`, { email: 'zoe@example.com', role: 'BOARD' }, avery));
      // pg_stat_activity is read once per transaction unless the snapshot is cleared.
      await until(async () => {
        await one('SELECT pg_stat_clear_snapshot()');
        const blocked = await one<{ n: number }>("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        return Number(blocked!.n) >= companies.length;
      }, 'the four invitations to wait for Zoe’s row');
    });
    await until(() => waiting.length >= 2, 'the invitations within the limit to reach the mail server');
    release();
    const answers = await Promise.all(invites);
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200], 'everyone invited has access');
    assert.deepEqual(answers.map((a) => a.json.invitation.emailed).sort(), [false, false, true, true]);
    assert.ok(answers.every((a) => a.json.invitation.link === undefined), 'Zoe signs in already, so there is no link');
    assert.deepEqual(received, ['zoe@example.com', 'zoe@example.com']);
    assert.deepEqual((await logOf('zoe@example.com')).map((r) => r.action).sort(),
      ['INVITE_EMAILED', 'INVITE_EMAILED', 'INVITE_EMAIL_SKIPPED', 'INVITE_EMAIL_SKIPPED']);
  } finally {
    release();
    resetConfig();
  }
});

test('signing up answers while its welcome email waits on a slow mail server, and stopping the server waits for the email', async () => {
  try {
    received.length = 0;
    holding = true;
    const signUp = call('POST', '/api/auth/register', { email: 'mina@example.com', name: 'Mina Sato', password: 'mina-pass-123' });
    await until(() => waiting.length === 1, 'the welcome email to reach the mail server');
    // The mail server still holds the email, so an answer now is one that did not wait for it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([signUp, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000); })]);
    clearTimeout(timer);
    assert.ok(answer, 'the sign-up answered while its welcome email was held');
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual(await welcomeLogOf('mina@example.com'), ['WELCOME_EMAIL_PENDING']);

    // What the server waits for when it is told to stop, after the open requests.
    let finished = false;
    const stopping = welcomesSent().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(finished, false, 'the welcome on its way is waited for');
    release();
    await stopping;
    assert.deepEqual(received, ['mina@example.com']);
    assert.deepEqual(await welcomeLogOf('mina@example.com'), ['WELCOME_EMAILED']);
  } finally {
    release();
  }
});
