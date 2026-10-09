/**
 * The welcome email. Someone who creates an account themselves, by signing up
 * or by a first Google sign-in, gets one, once, with links into the app; nobody
 * else does: not an invited person, before or after they accept, not a returning
 * Google user, not the demo account. mail.welcomeEmail turns it off, and
 * mail.welcomeEmailsPerHour caps it across the server, a burst of sign-ups
 * included. A mail failure never fails the sign-up, an attempt cut off by a
 * server that stopped is closed as failed, and a name cannot become markup in
 * the HTML.
 *
 * The mail here is the console transport, read from the log: nothing leaves the
 * machine. Google is a stand-in key server signing ID tokens as Google would.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { freshDatabase, sessionCookie } from './helpers.ts';

// --- a stand-in for https://www.googleapis.com/oauth2/v3/certs -------------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'welcome-test-key', alg: 'RS256', use: 'sig' };
const keyServer: Server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => keyServer.listen(0, '127.0.0.1', resolve));

// The console transport, and Google through the stand-in. Empty values win over
// apps/server/.env, which only fills in what is not set at all.
const CLIENT_ID = '000000000000-welcometest.apps.googleusercontent.com';
process.env.SMTP_URL = '';
process.env.ACS_CONNECTION_STRING = '';
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_ALLOWED_DOMAINS = '';
process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}/certs`;
delete process.env.NODE_ENV;
await freshDatabase();
const { handle } = await import('../src/http.ts');
const { composeWelcomeEmail } = await import('../src/routes/auth.ts');
const { one, all, run } = await import('../src/db.ts');
const { config, configure, resetConfig } = await import('../src/config.ts');
const { ensureDemoCompany } = await import('../src/sample.ts');

// Every message the console transport prints, by recipient. A recipient in
// `refusing` makes the transport throw, as a mail server that is down would.
const mail: { to: string; text: string }[] = [];
const refusing = new Set<string>();
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  const sent = line.match(/^\[mail\] not configured .* would send to (\S+): /);
  if (sent && refusing.has(sent[1])) throw new Error('The mail server refused the message.');
  if (sent) mail.push({ to: sent[1], text: line });
  else realLog(...args);
};
// What the server logs about failures, kept out of the test output and checked.
const errors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
after(() => { console.log = realLog; console.error = realError; });

const mailTo = (email: string) => mail.filter((m) => m.to === email);
const welcomesTo = (email: string) => mailTo(email).filter((m) => m.text.includes(`"Welcome to ${config().brand.productName}"`));

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => { api.close(); keyServer.close(); });

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
const register = (email: string, name: string) => call('POST', '/api/auth/register', { email, name, password: 'a-long-password-1' });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
function mint(claims: Record<string, unknown>): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'welcome-test-key' });
  const p = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, picture: null, iat: NOW - 5, exp: NOW + 3600, ...claims });
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}
async function googleSignIn(claims: { sub: string; email: string; name: string }) {
  const nonce = ((await call('POST', '/api/auth/google/start', {})).json as { nonce: string }).nonce;
  return call('POST', '/api/auth/google', { credential: mint({ ...claims, nonce }), nonce });
}

/** The welcome audit entries of one account, oldest first. */
const welcomeRows = (email: string) => all<{ action: string; detail: string }>(
  `SELECT a.action, a.detail FROM audit_log a JOIN users u ON u.id = a.entity_id
    WHERE u.email = ? AND a.action LIKE 'WELCOME_%' ORDER BY a.created_at, a.id`, email);

/** Waits until every welcome email has gone or failed: they go after the sign-up has answered. */
async function settled(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!await one("SELECT 1 FROM audit_log WHERE action = 'WELCOME_EMAIL_PENDING'")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('A welcome email is still on its way.');
}

/** Moves every welcome sent so far out of the hour the limit counts. */
const anHourAgo = () => run("UPDATE audit_log SET created_at = ? WHERE action LIKE 'WELCOME_%'", new Date(Date.now() - 61 * 60_000).toISOString());

test('signing up sends one welcome email to the new address, with the first steps linking into the app', async () => {
  const res = await register('Nadia.Okoro@Example.com', 'Nadia Okoro');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await settled();
  const app = config().app.url;
  const product = config().brand.productName;

  const welcomes = welcomesTo('nadia.okoro@example.com');
  assert.equal(welcomes.length, 1);
  assert.equal(mailTo('nadia.okoro@example.com').length, 1, 'and nothing else');
  const text = welcomes[0].text;
  assert.match(text, /Hi Nadia Okoro,/);
  assert.match(text, new RegExp(`Your ${product} account is ready\\.`));
  assert.match(text, /FIRST STEPS/);
  assert.ok(text.includes(`1. Set up your company: ${app}/import`), text);
  assert.match(text, /import a spreadsheet exported from Pulley or Carta/);
  assert.ok(text.includes(`2. Add your cap table: ${app}/cap-table`), text);
  assert.ok(text.includes(`3. Invite your team: ${app}/team`), text);
  assert.ok(!text.includes('/compliance/409a') && !/409A/.test(text), 'no 409A without the valuation team');
  assert.ok(text.includes(`Open ${product}:\n    ${app}\n`), 'one button, to the app');
  assert.match(text, /Sign in as nadia\.okoro@example\.com with the password you chose\./);
  assert.match(text, new RegExp(`— ${product}`));
  assert.match(text, /because an account was created on .* with nadia\.okoro@example\.com\. This is a one-time email\./);
  // Whoever chose the password holds the account, so the owner of the address is told to take it back, not to ignore it.
  assert.match(text, /If you did not create it, take the account back with "Forgot your password\?" on the sign-in page: the link comes only to this address, and choosing a new password signs everyone else out\./);
  assert.doesNotMatch(text, /ignore/);

  // One attempt in the log, completed once the email went (here, to the console).
  const rows = await welcomeRows('nadia.okoro@example.com');
  assert.deepEqual(rows.map((r) => r.action), ['WELCOME_EMAIL_FAILED']);
  assert.match(rows[0].detail, /mail is not configured/);
});

test('with the valuation team on, the first steps include requesting a 409A', async () => {
  configure({ valuationDesk: { enabled: true, email: 'desk@example.com', approvalEmail: 'approvals@example.com' } });
  try {
    assert.equal((await register('ilse.brandt@example.com', 'Ilse Brandt')).status, 200);
    await settled();
    const [welcome] = welcomesTo('ilse.brandt@example.com');
    assert.ok(welcome.text.includes(`4. Request a 409A: ${config().app.url}/compliance/409a`), welcome.text);
    assert.doesNotMatch(welcome.text, /approvals@example\.com/, 'the internal review inbox is not shown to new users');
  } finally {
    resetConfig();
  }
});

test('a first Google sign-in that creates an account sends one welcome; signing in again sends none', async () => {
  const first = await googleSignIn({ sub: 'g-rafael', email: 'rafael.moreno@example.com', name: 'Rafael Moreno' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  await settled();
  const [welcome, ...more] = welcomesTo('rafael.moreno@example.com');
  assert.equal(more.length, 0);
  assert.match(welcome.text, /Hi Rafael Moreno,/);
  assert.match(welcome.text, /Sign in with Google as rafael\.moreno@example\.com\./);
  assert.match(welcome.text, /rafael\.moreno@example\.com signed in to .* with Google for the first time, which created an account/);

  const again = await googleSignIn({ sub: 'g-rafael', email: 'rafael.moreno@example.com', name: 'Rafael Moreno' });
  assert.equal(again.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { email: 'nadia.okoro@example.com', password: 'a-long-password-1' })).status, 200);
  // An account made by signing up, now linked to Google, is not new either.
  assert.equal((await googleSignIn({ sub: 'g-nadia', email: 'nadia.okoro@example.com', name: 'Nadia Okoro' })).status, 200);
  await settled();
  assert.equal(welcomesTo('rafael.moreno@example.com').length, 1);
  assert.equal(welcomesTo('nadia.okoro@example.com').length, 1);
  assert.equal((await welcomeRows('rafael.moreno@example.com')).length, 1);
  assert.equal((await welcomeRows('nadia.okoro@example.com')).length, 1);
});

test('an invited person gets their invitation and no welcome, before or after accepting it', async () => {
  const owner = (await register('owen.price@example.com', 'Owen Price')).token as string;
  const cid = (await call('POST', '/api/companies', { name: 'Fenwick Labs' }, owner)).json.id as string;

  // Accepted by choosing a password from the invitation's link.
  const lena = await call('POST', `/api/c/${cid}/members`, { email: 'lena.vogel@example.com', name: 'Lena Vogel', role: 'EMPLOYEE' }, owner);
  assert.equal(lena.status, 200, JSON.stringify(lena.json));
  const token = new URL(lena.json.invitation.link).searchParams.get('token');
  const accepted = await call('POST', '/api/auth/reset', { token, password: 'lena-chose-this-1' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));

  // Accepted by signing in with Google as the invited address.
  assert.equal((await call('POST', `/api/c/${cid}/members`, { email: 'bao.tran@example.com', name: 'Bao Tran', role: 'VIEWER' }, owner)).status, 200);
  assert.equal((await googleSignIn({ sub: 'g-bao', email: 'bao.tran@example.com', name: 'Bao Tran' })).status, 200);

  await settled();
  for (const email of ['lena.vogel@example.com', 'bao.tran@example.com']) {
    assert.equal(mailTo(email).length, 1, `${email} got the invitation`);
    assert.match(mailTo(email)[0].text, /invited you to Fenwick Labs/);
    assert.equal(welcomesTo(email).length, 0, `${email} got no welcome`);
    assert.deepEqual(await welcomeRows(email), []);
  }
});

test('the demo account is never welcomed', async () => {
  configure({ demo: { enabled: true } });
  try {
    // Created at server start, as the sample and seed scripts create theirs: never through sign-up.
    assert.ok(await ensureDemoCompany());
    const { email, password } = config().demo;
    assert.equal((await call('POST', '/api/auth/login', { email, password })).status, 200);
    await settled();
    assert.equal(mailTo(email).length, 0);
    assert.deepEqual(await welcomeRows(email), []);
  } finally {
    resetConfig();
  }
  // Even made through the sign-up form, the shared demo login is nobody's to welcome.
  configure({ demo: { enabled: true, email: 'demo.visitor@example.com' } });
  try {
    assert.equal((await register('demo.visitor@example.com', 'Demo Visitor')).status, 200);
    await settled();
    assert.equal(mailTo('demo.visitor@example.com').length, 0);
    assert.deepEqual(await welcomeRows('demo.visitor@example.com'), []);
  } finally {
    resetConfig();
  }
});

test('with welcome emails turned off, signing up sends none', async () => {
  for (const [i, mailSettings] of [{ welcomeEmail: false }, { welcomeEmailsPerHour: 0 }].entries()) {
    configure({ mail: mailSettings });
    try {
      const email = `off.${i}@example.com`;
      assert.equal((await register(email, 'Kit Ward')).status, 200);
      assert.equal((await googleSignIn({ sub: `g-off-${i}`, email: `off.google.${i}@example.com`, name: 'Kit Ward' })).status, 200);
      await settled();
      assert.equal(mailTo(email).length, 0);
      assert.equal(mailTo(`off.google.${i}@example.com`).length, 0);
      assert.deepEqual(await welcomeRows(email), []);
    } finally {
      resetConfig();
    }
  }
});

test('no more than mail.welcomeEmailsPerHour go out in an hour, across the server', async () => {
  await anHourAgo();
  configure({ mail: { welcomeEmailsPerHour: 2 } });
  try {
    for (const name of ['cap.a', 'cap.b', 'cap.c']) assert.equal((await register(`${name}@example.com`, 'Ada Lowe')).status, 200);
    assert.equal((await googleSignIn({ sub: 'g-cap-d', email: 'cap.d@example.com', name: 'Dev Lowe' })).status, 200);
    await settled();
    assert.equal(welcomesTo('cap.a@example.com').length, 1);
    assert.equal(welcomesTo('cap.b@example.com').length, 1);
    for (const email of ['cap.c@example.com', 'cap.d@example.com']) {
      assert.equal(mailTo(email).length, 0, `${email} is over the limit`);
      const rows = await welcomeRows(email);
      assert.deepEqual(rows.map((r) => r.action), ['WELCOME_EMAIL_SKIPPED']);
      assert.match(rows[0].detail, /the server has reached its limit of 2 welcome emails an hour/);
    }

    // An hour later there is room again.
    await anHourAgo();
    assert.equal((await register('cap.e@example.com', 'Eve Lowe')).status, 200);
    await settled();
    assert.equal(welcomesTo('cap.e@example.com').length, 1);
  } finally {
    resetConfig();
  }
});

test('a burst of sign-ups at once cannot pass the hourly limit', async () => {
  await anHourAgo();
  configure({ mail: { welcomeEmailsPerHour: 3 } });
  try {
    const emails = Array.from({ length: 8 }, (_, i) => `burst.${i}@example.com`);
    const answers = await Promise.all(emails.map((email) => register(email, 'Bea Hart')));
    assert.deepEqual(answers.map((a) => a.status), emails.map(() => 200), 'every sign-up goes through');
    await settled();
    assert.equal(emails.flatMap(welcomesTo).length, 3);
    const actions = (await Promise.all(emails.map(welcomeRows))).flat().map((r) => r.action).sort();
    assert.deepEqual(actions, [...Array(3).fill('WELCOME_EMAIL_FAILED'), ...Array(5).fill('WELCOME_EMAIL_SKIPPED')]);
  } finally {
    resetConfig();
  }
});

test('a welcome email that fails does not fail the sign-up', async () => {
  await anHourAgo();
  refusing.add('ivy.chen@example.com');
  try {
    const res = await register('ivy.chen@example.com', 'Ivy Chen');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal((await call('GET', '/api/auth/me', undefined, res.token)).status, 200, 'signed in');
    await settled();
    assert.deepEqual((await welcomeRows('ivy.chen@example.com')).map((r) => r.action), ['WELCOME_EMAIL_FAILED']);
    assert.ok(errors.some((e) => e.includes('welcome email to ivy.chen@example.com failed') && e.includes('refused')), errors.join('\n'));
  } finally {
    refusing.clear();
  }
});

test('a welcome cut off by a server that stopped is closed as failed once its hour is over', async () => {
  await anHourAgo();
  assert.equal((await register('hugo.lind@example.com', 'Hugo Lind')).status, 200);
  await settled();
  // What a server killed while sending leaves behind: an attempt still on its way, two hours on.
  await run(`UPDATE audit_log SET action = 'WELCOME_EMAIL_PENDING', detail = 'Emailing a welcome to hugo.lind@example.com', created_at = ?
              WHERE action LIKE 'WELCOME_%' AND entity_id = (SELECT id FROM users WHERE email = 'hugo.lind@example.com')`,
    new Date(Date.now() - 2 * 3_600_000).toISOString());

  // The next sign-up closes it, and is welcomed as usual.
  assert.equal((await register('june.amari@example.com', 'June Amari')).status, 200);
  await settled();
  assert.deepEqual(await welcomeRows('hugo.lind@example.com'), [{
    action: 'WELCOME_EMAIL_FAILED',
    detail: 'The welcome email to hugo.lind@example.com may not have gone out: the server stopped while sending it',
  }]);
  assert.equal(welcomesTo('june.amari@example.com').length, 1);
});

test('a name cannot become markup in the HTML, and the email carries no images or tracking', async () => {
  const product = config().brand.productName;
  const app = config().app.url;
  const { html, text, subject } = composeWelcomeEmail({ to: { email: 'mallory@example.com', name: '<img src=x onerror=alert(1)> & "Co"' }, via: 'password', valuationDesk: true });
  assert.equal(subject, `Welcome to ${product}`);
  assert.ok(!html!.includes('<img'), 'no tag from the name');
  assert.ok(html!.includes('Hi &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;,'), 'the name is escaped');
  assert.ok(text.includes('Hi <img src=x onerror=alert(1)> & "Co",'), 'and kept as typed in the plain text');
  for (const path of ['/import', '/cap-table', '/team', '/compliance/409a']) assert.ok(html!.includes(`href="${app}${path}"`), `a link to ${path}`);
  assert.ok(html!.includes(`href="${app}"`), 'the button');
  assert.ok(!/<img|<link|src=|<script/i.test(html!.replace(/Hi &lt;img src=x[^,]*,/, '')), 'nothing remote to load or track');
  assert.ok(html!.includes(config().brand.colors.primary['600']), 'the brand colour');

  // The same through sign-up, with a name the form accepts.
  assert.equal((await register('zoe.ohara@example.com', 'Zoë O\'Hara & Partners')).status, 200);
  await settled();
  assert.match(welcomesTo('zoe.ohara@example.com')[0].text, /Hi Zoë O'Hara & Partners,/);
  const signedUp = composeWelcomeEmail({ to: { email: 'zoe.ohara@example.com', name: 'Zoë O\'Hara & Partners' }, via: 'password' });
  assert.ok(signedUp.html!.includes('Hi Zoë O&#39;Hara &amp; Partners,'));
});
