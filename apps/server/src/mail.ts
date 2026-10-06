/**
 * Outgoing mail. One transport, chosen by configuration:
 *
 *  - `ACS_CONNECTION_STRING` set: Azure Communication Services, which is what the
 *    Azure deployment provisions. Its REST call is signed with the access key
 *    rather than sent over a session, so there is no connection to keep or
 *    credential to hand to a mail server.
 *  - `SMTP_URL` set (smtp://user:pass@host:587 or smtps://user:pass@host:465):
 *    a small SMTP client over node:net / node:tls — EHLO, STARTTLS when the
 *    server offers it, AUTH PLAIN or LOGIN, then the message. Plain `smtp://`
 *    to anything but localhost insists on STARTTLS unless `?insecure=1`.
 *  - otherwise: the message is printed to the server log and reported as not
 *    delivered, so flows that send mail still work on a laptop.
 *
 * The sender ("Kosmitor <no-reply@example.com>") is mail.from and the public
 * address of the web app, used in links, is app.url, both in kosmitor.config.json
 * (MAIL_FROM and APP_URL set them per deployment). The connection strings are
 * secrets and stay environment variables.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { hostname } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { config } from './config.ts';

export interface Message {
  /**
   * The recipient's address, and only the address. The name travels separately
   * in toName. They used to be spliced into one "Name <address>" string and the
   * address read back out of it, which let a name containing its own <address>
   * redirect the message, a password reset included.
   */
  to: string;
  /** The recipient's name, shown alongside the address. Never parsed for an address. */
  toName?: string;
  subject: string; text: string; html?: string;
  /**
   * Where a reply should go when it should not come back to the sending address.
   * The app sends from a no-reply box, which is right for a password reset and
   * wrong for a message someone outside the company is meant to answer.
   */
  replyTo?: string;
}

/** A header value on one line. A line break in a header is how another header gets smuggled in. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/** One address: no spaces, brackets, quotes, commas or semicolons that could make it two. */
export const SINGLE_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Refuses a message whose recipient or reply-to is anything but one plain address. */
export function assertDeliverable(m: Pick<Message, 'to' | 'replyTo'>): void {
  if (!SINGLE_ADDRESS.test(m.to)) throw new Error('A mail recipient must be a single email address, with any name passed as toName.');
  if (m.replyTo != null && !SINGLE_ADDRESS.test(m.replyTo)) throw new Error('A reply-to must be a single email address.');
}

/**
 * A display name as a header phrase: quoted when it is plain ASCII, so a comma
 * or a quote in it cannot split the header, and encoded when it is not.
 */
export function displayName(name: string): string {
  const one = oneLine(name);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(one)) return `"${one.replace(/(["\\])/g, '\\$1')}"`;
  return `=?UTF-8?B?${Buffer.from(one, 'utf8').toString('base64')}?=`;
}

const recipientHeader = (m: Pick<Message, 'to' | 'toName'>): string =>
  (m.toName && oneLine(m.toName) ? `${displayName(m.toName)} <${m.to}>` : m.to);
export interface Delivery { delivered: boolean; transport: 'smtp' | 'acs' | 'console'; id: string }

/** The sender of every message, mail.from. */
const mailFrom = (): string => config().mail.from;
const SMTP_URL = process.env.SMTP_URL?.trim() || null;
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING?.trim() || null;

export const mailConfigured = (): boolean => ACS_CONNECTION_STRING != null || SMTP_URL != null;

/**
 * The web app's public address, app.url, for links in messages. The argument is
 * ignored and kept only so existing callers compile: links used to fall back to
 * the request's Origin or Referer, which let anyone sending a forged header aim
 * a reset link at a site of their own.
 */
export function appUrl(_originHint?: string | null): string {
  return config().app.url.replace(/\/+$/, '');
}

/** Sends through the configured transport; the console transport never fails. */
export async function sendMail(message: Message): Promise<Delivery> {
  assertDeliverable(message);
  const id = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${hostname()}>`;
  if (ACS_CONNECTION_STRING) {
    await acsSend(ACS_CONNECTION_STRING, message);
    return { delivered: true, transport: 'acs', id };
  }
  if (SMTP_URL) {
    await smtpSend(SMTP_URL, { ...message, id });
    return { delivered: true, transport: 'smtp', id };
  }
  console.log(`[mail] not configured (set ACS_CONNECTION_STRING or SMTP_URL) — would send to ${message.to}: "${message.subject}"\n${indent(message.text)}`);
  return { delivered: false, transport: 'console', id };
}

const indent = (s: string): string => s.split('\n').map((l) => `    ${l}`).join('\n');
const addressOf = (s: string): string => (s.match(/<([^>]+)>/)?.[1] ?? s).trim();

function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** RFC 5322 message with a plain-text part and, when given, an HTML alternative. */
export function buildMessage(m: Message & { id: string }, from = mailFrom()): string {
  const headers = [
    `From: ${from}`, `To: ${recipientHeader(m)}`, `Subject: ${encodeHeader(oneLine(m.subject))}`,
    ...(m.replyTo ? [`Reply-To: ${oneLine(m.replyTo)}`] : []),
    `Date: ${new Date().toUTCString()}`, `Message-ID: ${m.id}`, 'MIME-Version: 1.0',
  ];
  const text = Buffer.from(m.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  if (!m.html) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', text].join('\r\n');
  }
  const boundary = `=_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const html = Buffer.from(m.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    ...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', text,
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', html,
    `--${boundary}--`, '',
  ].join('\r\n');
}

// --- SMTP ------------------------------------------------------------------

interface Reply { code: number; lines: string[] }

class SmtpSession {
  private socket: Socket;
  private buffer = '';
  private waiting: ((r: Reply) => void) | null = null;
  private failed: ((e: Error) => void) | null = null;
  private pending: Reply[] = [];
  private closedWith: Error | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.feed(chunk));
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('The mail server closed the connection.')));
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    let lines: string[] = [];
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {                      // "250 last line" ends a reply; "250-more" continues it
        const reply = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        if (this.waiting) { const w = this.waiting; this.waiting = null; this.failed = null; w(reply); }
        else this.pending.push(reply);
      }
    }
  }

  private fail(err: Error): void {
    if (this.closedWith) return;
    this.closedWith = err;
    if (this.failed) { const f = this.failed; this.waiting = null; this.failed = null; f(err); }
  }

  /** Waits for the next reply; rejects on a code outside `okCodes`. */
  read(okCodes: number[], what: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const check = (r: Reply) => (okCodes.includes(r.code) ? resolve(r) : reject(new Error(`${what}: ${r.lines.join(' ')}`)));
      if (this.pending.length) return check(this.pending.shift()!);
      if (this.closedWith) return reject(this.closedWith);
      this.waiting = check;
      this.failed = reject;
    });
  }

  async command(line: string, okCodes: number[], what = line.split(' ')[0]): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.read(okCodes, what);
  }

  /** Upgrades the plain connection in place after a successful STARTTLS. */
  upgrade(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('close');
      this.socket.removeAllListeners('error');
      const secure = tlsConnect({ socket: this.socket, servername: host }, () => resolve());
      secure.once('error', reject);
      this.socket = secure;
      this.buffer = '';
      this.attach(secure);
    });
  }

  write(data: string): void { this.socket.write(data); }
  end(): void { this.socket.end(); }
}

export async function smtpSend(url: string, message: Message & { id: string }, timeoutMs = config().mail.smtpTimeoutSeconds * 1000): Promise<void> {
  assertDeliverable(message);
  const u = new URL(url);
  const secureFromStart = u.protocol === 'smtps:';
  if (!secureFromStart && u.protocol !== 'smtp:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  const host = u.hostname;
  const port = Number(u.port || (secureFromStart ? 465 : 587));
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  const allowPlain = local || u.searchParams.get('insecure') === '1';

  const socket = secureFromStart
    ? tlsConnect({ host, port, servername: host })
    : netConnect({ host, port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The mail server did not respond in time.')));
  const session = new SmtpSession(socket);
  const me = hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';

  try {
    await session.read([220], 'Greeting');
    let ehlo = await session.command(`EHLO ${me}`, [250]);
    if (!secureFromStart) {
      if (ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
        await session.command('STARTTLS', [220]);
        await session.upgrade(host);
        ehlo = await session.command(`EHLO ${me}`, [250]);
      } else if (!allowPlain) {
        throw new Error(`${host} does not offer STARTTLS; use smtps:// or add ?insecure=1 to SMTP_URL.`);
      }
    }
    if (user) {
      const auth = ehlo.lines.find((l) => /^250[- ]AUTH\b/i.test(l)) ?? '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, [235], 'Authentication');
      } else {
        await session.command('AUTH LOGIN', [334], 'Authentication');
        await session.command(Buffer.from(user, 'utf8').toString('base64'), [334], 'Authentication');
        await session.command(Buffer.from(pass, 'utf8').toString('base64'), [235], 'Authentication');
      }
    }
    const from = mailFrom();
    await session.command(`MAIL FROM:<${addressOf(from)}>`, [250]);
    await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await session.command('DATA', [354]);
    const body = buildMessage(message, from).replace(/\r?\n\./g, (m) => `${m}.`);   // dot-stuffing
    session.write(`${body}\r\n.\r\n`);
    await session.read([250], 'Sending the message');
    await session.command('QUIT', [221]).catch(() => undefined);
  } finally {
    session.end();
  }
}

// ---------------------------------------------------------------------------
// Azure Communication Services
// ---------------------------------------------------------------------------

export interface AcsConfig { endpoint: string; accessKey: string }

/** `endpoint=https://x.communication.azure.com/;accesskey=...`, in either order. */
export function parseAcsConnectionString(value: string): AcsConfig {
  const parts = new Map(value.split(';').map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim()] as [string, string];
  }));
  const endpoint = parts.get('endpoint');
  const accessKey = parts.get('accesskey');
  if (!endpoint || !accessKey) throw new Error('ACS_CONNECTION_STRING needs both endpoint= and accesskey=.');
  return { endpoint: endpoint.replace(/\/+$/, ''), accessKey };
}

/**
 * The signature Azure expects on a Communication Services request.
 *
 * It covers the verb, the path with its query, the date, the host and a hash of
 * the body, so a captured request cannot be replayed against another path or
 * with the body swapped. Exported because the only honest way to test signing is
 * to sign something known and compare.
 */
export function signAcsRequest(
  config: AcsConfig, method: string, url: string, body: string, date: string,
): Record<string, string> {
  const target = new URL(url);
  const contentHash = createHash('sha256').update(body, 'utf8').digest('base64');
  const stringToSign = [method.toUpperCase(), `${target.pathname}${target.search}`, `${date};${target.host};${contentHash}`].join('\n');
  const signature = createHmac('sha256', Buffer.from(config.accessKey, 'base64')).update(stringToSign, 'utf8').digest('base64');
  return {
    'x-ms-date': date,
    'x-ms-content-sha256': contentHash,
    Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  };
}

/** The request body Azure takes for one message. */
export function acsPayload(message: Message, from = mailFrom()): Record<string, unknown> {
  return {
    senderAddress: addressOf(from),
    content: { subject: oneLine(message.subject), plainText: message.text, ...(message.html ? { html: message.html } : {}) },
    recipients: { to: [{ address: message.to, ...(message.toName && oneLine(message.toName) ? { displayName: oneLine(message.toName) } : {}) }] },
    // A reply-to the caller names wins. Otherwise the display name belongs on the
    // sender, which Azure takes separately.
    ...(message.replyTo
      ? { replyTo: [{ address: oneLine(message.replyTo) }] }
      : from.includes('<') ? { replyTo: [{ address: addressOf(from), displayName: from.split('<')[0].trim().replace(/^"|"$/g, '') }] } : {}),
  };
}

const ACS_API_VERSION = '2023-03-31';

export async function acsSend(connectionString: string, message: Message, from = mailFrom(), now = new Date()): Promise<void> {
  assertDeliverable(message);
  const acs = parseAcsConnectionString(connectionString);
  const url = `${acs.endpoint}/emails:send?api-version=${ACS_API_VERSION}`;
  const body = JSON.stringify(acsPayload(message, from));
  const headers = { 'Content-Type': 'application/json', ...signAcsRequest(acs, 'POST', url, body, now.toUTCString()) };

  // Routes that send mail do so inside the request's transaction, which holds the
  // company's write lock, so a provider that hangs must not be allowed to hang it.
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(config().mail.acsTimeoutSeconds * 1000) });
  // Sending is asynchronous: 202 means Azure has taken the message, and the
  // Operation-Location header is where its progress would be read.
  if (res.status === 202 || res.ok) return;
  const detail = await res.text().catch(() => '');
  throw new Error(`Azure Communication Services refused the message (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
}
