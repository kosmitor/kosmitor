/**
 * Status emails about a 409A request when the mail server takes its time, as a
 * slow or stalled one does. The stand-in below holds each message until the test
 * lets it through, so what happens while an email is still on its way can be
 * checked: a burst of changes from a leaked team link sends no more emails than
 * the daily limit, and a change made at the company has committed, and holds no
 * lock on the company, while its email waits.
 *
 * A file of its own because the mail transport is chosen when the server starts,
 * and valuation-requests.test.ts reads its mail from the console. Nothing here
 * leaves the machine: the only mail server is the stand-in on localhost.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { freshDatabase } from './helpers.ts';

// --- A mail server that holds each message until it is let through --------------

/** Each message the stand-in has read, by recipient. */
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
          received.push(to);
          const accept = () => socket.write('250 2.0.0 queued\r\n');
          if (holding) waiting.push(accept); else accept();
        }
        continue;
      }
      if (/^EHLO /.test(line)) socket.write('250-stand-in\r\n250 8BITMIME\r\n');   // no STARTTLS: allowed on localhost
      else if (/^MAIL FROM:/.test(line)) socket.write('250 ok\r\n');
      else if (/^RCPT TO:/.test(line)) { to = line.match(/<([^>]*)>/)?.[1] ?? ''; socket.write('250 ok\r\n'); }
      else if (line === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 what\r\n');
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
after(() => { release(); smtp.close(); });

// Mail goes to the stand-in and nowhere else. These win over apps/server/.env.
process.env.SMTP_URL = `smtp://127.0.0.1:${(smtp.address() as AddressInfo).port}`;
delete process.env.ACS_CONNECTION_STRING;
process.env.VALUATION_DESK_EMAIL = 'desk@example.test';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/valuation-requests.ts');
const { configure, resetConfig, deskName } = await import('../src/config.ts');
const { run, one, all } = await import('../src/db.ts');

const api: HttpServer = createHttpServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const desk = (token: string, body: unknown) => call('POST', '/api/valuation-desk/status', body, null, { 'X-Desk-Token': token });

/** Waits for something the server does in its own time, for up to five seconds. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Made-up people: Avery asks for the 409A, Morgan is a colleague who can close it.
const avery = await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' });
const cid = (await call('POST', '/api/companies', { name: 'Slow Mail Harbor' }, avery.json.token)).json.id as string;
const morgan = (await call('POST', '/api/auth/register', { email: 'morgan.lee@example.com', name: 'Morgan Lee', password: 'morgan-pass-1' })).json.token as string;
assert.equal((await call('POST', `/api/c/${cid}/members`, { email: 'morgan.lee@example.com', role: 'LEGAL' }, avery.json.token)).status, 200);

/**
 * A request the team has started on, with a link it can use. Written straight to
 * the table: what is checked here is what happens after the request is made,
 * and the team was never notified, so a close sends the team nothing.
 */
async function startedRequest(): Promise<{ id: string; token: string }> {
  const id = `vrq_${randomBytes(6).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  await run(`INSERT INTO valuation_requests (id, company_id, status, provider, requested_by, requested_by_id, desk_token_hash, desk_token_at, created_at, updated_at)
    VALUES (?, ?, 'IN_PROGRESS', ?, 'Avery Stone', ?, ?, ?, ?, ?)`,
  id, cid, deskName(), avery.json.user.id, createHash('sha256').update(token).digest('hex'), now, now, now);
  return { id, token };
}
const statusOf = async (id: string) => (await one<{ status: string }>('SELECT status FROM valuation_requests WHERE id = ?', id))!.status;
const requesterLog = (id: string) => all<{ action: string; user_name: string }>(
  `SELECT action, user_name FROM audit_log WHERE entity_id = ? AND action LIKE 'NOTIFY_REQUESTER%' ORDER BY created_at, id`, id);

test('a burst of changes from the team’s link sends no more status emails than the daily limit, however slow the mail server', async () => {
  try {
    configure({ valuationDesk: { statusEmailsPerRequestPerDay: 2 } });
    const { id, token } = await startedRequest();
    received.length = 0;
    holding = true;
    // Each change commits and goes on to its email, which the mail server holds,
    // before the next is made: the burst a leaked link could send.
    const answers: ReturnType<typeof desk>[] = [];
    for (let i = 0; i < 6; i++) {
      const deliver = i % 2 === 0;
      answers.push(desk(token, deliver ? { action: 'DELIVER', appraiser: 'Ledgerline Valuations', reportDate: '2026-07-01' } : { action: 'REOPEN', message: 'Correcting the date.' }));
      await until(async () => (await statusOf(id)) === (deliver ? 'DELIVERED' : 'IN_PROGRESS'), `change ${i + 1} to commit`);
    }
    await until(() => waiting.length >= 2, 'the emails within the limit to reach the mail server');
    release();
    const emailed = (await Promise.all(answers)).map((a) => { assert.equal(a.status, 200, JSON.stringify(a.json)); return a.json.emailed; });
    assert.deepEqual(emailed, ['sent', 'sent', 'not sent', 'not sent', 'not sent', 'not sent'], 'every change went through');
    assert.deepEqual(received, ['avery@example.com', 'avery@example.com'], 'two emails, the limit, and no more');
    assert.deepEqual((await requesterLog(id)).map((l) => l.action),
      ['NOTIFY_REQUESTER', 'NOTIFY_REQUESTER', 'NOTIFY_REQUESTER_SKIPPED', 'NOTIFY_REQUESTER_SKIPPED', 'NOTIFY_REQUESTER_SKIPPED', 'NOTIFY_REQUESTER_SKIPPED']);
  } finally {
    release();
    resetConfig();
  }
});

test('a colleague’s cancel has committed, and holds no lock on the company, while its email waits on a slow mail server', async () => {
  try {
    const { id } = await startedRequest();
    received.length = 0;
    holding = true;
    const cancel = call('PATCH', `/api/c/${cid}/valuation-requests/${id}`, { status: 'CANCELLED' }, morgan);
    await until(() => waiting.length === 1, 'the email to the person who asked to reach the mail server');
    assert.equal(await statusOf(id), 'CANCELLED', 'the cancel is already committed');
    // Anything else waiting to change the company's records can go ahead.
    assert.ok(await one('SELECT id FROM companies WHERE id = ? FOR UPDATE NOWAIT', cid), 'nothing holds the company’s lock');
    release();
    const done = await cancel;
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(received, ['avery@example.com']);
    assert.deepEqual((await requesterLog(id)).map((l) => [l.action, l.user_name]), [['NOTIFY_REQUESTER', 'Morgan Lee']]);
  } finally {
    release();
  }
});
