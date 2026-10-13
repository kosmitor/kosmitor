/**
 * 409A requests from self-hosted servers, taken here on their behalf.
 *
 * A self-hosted server with valuationDesk.relayUrl pointing here sends what its
 * approval email would carry: the answers, the contact, the notes, the names of
 * the documents and why a 409A is due. Never the cap table or a file. Nothing on
 * that server is verified, so the request waits for its contact to confirm their
 * email address; only then does it reach this server's approval inbox, with every
 * answer in the email, since there is no company here to look at. The team quotes
 * a price and takes payment by hand, then approves or declines from the emailed
 * link. The self-hosted server reads the outcome with the token it was given,
 * and withdraws the request with it when the company cancels or changes contact.
 *
 * Taken only where the desk is on and has an approval inbox to send them to.
 */
import { randomBytes } from 'node:crypto';
import { route, badRequest, notFound, forbidden, HttpError, newId, nowISO, str, date as isoDate, type Ctx } from '../http.ts';
import { one, insert, run } from '../db.ts';
import { sendMail, mailConfigured, type Message } from '../mail.ts';
import { renderEmail } from '../email.ts';
import { config, deskName, mailSignature } from '../config.ts';
import { log } from '../telemetry.ts';
import { tooManyFailures, recordFailure } from '../rate-limit.ts';
import {
  readIntake, intakeLines, intakeTables, email, name, phone, deskOn, approvalAddress, hashToken, TOKEN_SHAPE,
  composeRelayConfirmEmail, composeRelayApprovalEmail, type Intake, type ListedDocument,
} from './valuation-requests.ts';

const DAY = 86_400_000;
const since = (ms: number): string => new Date(Date.now() - ms).toISOString();
const mint = (): string => randomBytes(32).toString('base64url');

interface RelayRow {
  id: string; status: 'UNCONFIRMED' | 'CONFIRMED' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN'; token_hash: string;
  confirm_token_hash: string | null; team_token_hash: string | null;
  company_name: string; contact_name: string; contact_email: string; contact_phone: string;
  request: string; ip: string | null; created_at: string; confirmed_at: string | null; decided_at: string | null;
}

/** What the sending server sent, beyond the contact. */
interface Sent { intake: Intake; notes: string | null; reasons: string[]; documents: ListedDocument[]; requestedBy: string; instanceUrl: string | null }

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Taken only where the desk is on, has an approval inbox, and in production can email. */
const accepting = (): boolean => deskOn() && !!approvalAddress() && (!isProduction() || mailConfigured());

/**
 * Sends, or throws. Without a transport the message is only printed; that is
 * fine on a laptop, but in production it did not go, and its links would sit in the log.
 */
async function deliver(message: Message): Promise<void> {
  if (!(await sendMail(message)).delivered && isProduction()) throw new Error('mail is not set up');
}

/** How many relayed requests reached a step in the last hour. */
const lastHour = async (column: 'created_at' | 'confirmed_at'): Promise<number> =>
  Number((await one<{ n: string }>(`SELECT COUNT(*) AS n FROM desk_relay_requests WHERE ${column} > ?`, since(3_600_000)))?.n ?? 0);

/** The sending server's address, shown to the approval team only: a web address or nothing. */
function webAddress(v: unknown): string | null {
  const s = str(v, 'Server address', { max: 300 });
  try { return /^https?:$/.test(new URL(s).protocol) ? s : null; } catch { return null; }
}

/** A list of short lines, as many as `max`, each at most `chars` long. */
function lines(v: unknown, field: string, max: number, chars: number): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw badRequest(`${field} must be a list of at most ${max}.`);
  return v.map((s) => str(s, field, { max: chars }));
}

/**
 * Takes a request. The sending server makes the token itself and sends the same
 * one on every try, so a retry after a lost answer finds the request already
 * made and sends no second email.
 */
route.post('/api/409a-relay', 'public', async (ctx) => {
  if (!accepting()) throw forbidden('This server does not take 409A requests from other servers.');
  const b = ctx.body;
  const token = String(b.token ?? '');
  if (!TOKEN_SHAPE.test(token)) throw badRequest('Send the request with a token of 32 random bytes in base64url.');
  const made = await one<{ id: string }>('SELECT id FROM desk_relay_requests WHERE token_hash = ?', hashToken(token));
  if (made) return { id: made.id };
  const contactEmail = email(b.contactEmail, 'Contact email', false)!;

  const answers = (b.answers ?? {}) as Record<string, unknown>;
  const fiscalYearEnd = answers.fiscalYearEnd == null ? null : str(answers.fiscalYearEnd, 'Fiscal year end', { max: 5 });
  if (fiscalYearEnd && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(fiscalYearEnd)) throw badRequest('The fiscal year end must read MM-DD.');
  const sent: Sent = {
    intake: { ...readIntake(answers), incorporationDate: answers.incorporationDate == null ? null : isoDate(answers.incorporationDate, 'Incorporation date'), fiscalYearEnd },
    notes: str(b.notes, 'Notes', { max: 2000, optional: true }) || null,
    reasons: lines(b.reasons, 'Reasons', 20, 500),
    documents: (Array.isArray(b.documents) ? b.documents.slice(0, 100) : []).map((d: any) => ({
      itemLabel: str(d?.itemLabel, 'Document item', { max: 200 }), name: str(d?.name, 'Document name', { max: 300 }),
    })),
    requestedBy: name(b.requestedBy, 'Requested by', false)!,
    instanceUrl: b.instanceUrl == null ? null : webAddress(b.instanceUrl),
  };
  const companyName = str(b.companyName, 'Company name', { max: 200 }).replace(/\s+/g, ' ');
  const contactName = name(b.contactName, 'Contact name', true);
  const contactPhone = phone(b.contactPhone, 'Contact phone');

  // Anyone can post here, and each request emails the address it names: limited
  // per sending server, per address, and in all per hour. Each allowance is taken
  // before the email is awaited, so requests arriving together cannot all pass on
  // a count that none of them has added to yet: the daily ones are checked and
  // taken with no wait between, and the hourly one counts the row once it is in.
  // Unconfirmed requests get a looser hourly allowance of their own, so a flood of
  // them cannot use up the one confirmed requests need (taken when the contact confirms).
  // A send that then fails keeps its allowance used: rare, and it errs on the side of fewer emails.
  const { requestsPerPersonPerDay, relayRequestsPerServerPerDay, noticesPerHour } = config().valuationDesk;
  const limits: [string, number][] = [[`relay-ip:${ctx.ip}`, relayRequestsPerServerPerDay], [`relay-email:${contactEmail}`, requestsPerPersonPerDay]];
  if (limits.some(([k, n]) => tooManyFailures(k, n, DAY))) throw new HttpError(429, 'Too many 409A requests today. Try again tomorrow.');
  for (const [k] of limits) recordFailure(k, DAY);

  const id = newId('rly');
  const confirmToken = mint();
  try {
    await insert('desk_relay_requests', {
      id, status: 'UNCONFIRMED', tokenHash: hashToken(token), confirmTokenHash: hashToken(confirmToken),
      companyName, contactName: contactName ?? '', contactEmail, contactPhone, request: JSON.stringify(sent), ip: ctx.ip, createdAt: nowISO(),
    });
  } catch (err) {
    // The same token at the same moment: the other try made it.
    const other = await one<{ id: string }>('SELECT id FROM desk_relay_requests WHERE token_hash = ?', hashToken(token));
    if (other) return { id: other.id };
    throw err;
  }
  // A request whose contact cannot be reached is not kept, so the sending server can try again.
  const drop = () => run('DELETE FROM desk_relay_requests WHERE id = ?', id);
  if (await lastHour('created_at') > noticesPerHour * 4) {
    await drop();
    throw new HttpError(429, 'The valuation team is receiving a lot of requests right now. Try again in an hour.');
  }
  try {
    await deliver(composeRelayConfirmEmail({
      companyName, to: contactEmail, toName: contactName,
      link: `${config().app.url}/409a-relay#confirm.${confirmToken}`, linkDays: config().valuationDesk.linkOpenDays,
    }));
  } catch (err) {
    await drop();
    log('warn', '409A relay confirmation email failed', { id, error: (err as Error).message });
    throw new HttpError(502, 'The confirmation email could not be sent. Try again later.');
  }
  log('info', '409A relay request received', { id, instanceUrl: sent.instanceUrl });
  return { id };
});

/** The request the sending server names, with the token it was given for it. */
async function bySender(ctx: Ctx): Promise<RelayRow> {
  ctx.res.setHeader('Cache-Control', 'no-store');
  const token = String(ctx.req.headers.authorization ?? '').replace(/^Bearer /i, '');
  const row = TOKEN_SHAPE.test(token)
    ? await one<RelayRow>('SELECT * FROM desk_relay_requests WHERE id = ? AND token_hash = ?', ctx.params.id, hashToken(token)) : undefined;
  if (!row) throw notFound('No such request.');
  return row;
}

/** The status, for the server that sent the request. */
route.get('/api/409a-relay/:id', 'public', async (ctx) => {
  const row = await bySender(ctx);
  return { status: row.status, confirmedAt: row.confirmed_at, decidedAt: row.decided_at };
});

/**
 * The company cancelled, or changed its contact and sent the request again. A
 * request still waiting can no longer be approved; the approval inbox is told
 * if it had already heard of it, since someone may be quoting or charging it.
 */
route.post('/api/409a-relay/:id/withdraw', 'public', async (ctx) => {
  const row = await bySender(ctx);
  if (!await run(`UPDATE desk_relay_requests SET status = 'WITHDRAWN', decided_at = ? WHERE id = ? AND status IN ('UNCONFIRMED', 'CONFIRMED', 'APPROVED')`,
    nowISO(), row.id)) return { status: row.status };
  log('info', '409A relay request withdrawn', { id: row.id, was: row.status });
  if (row.status !== 'UNCONFIRMED') {
    const subject = `409A request withdrawn: ${row.company_name}`;
    const { html, text } = renderEmail({
      preview: 'The company cancelled it or sent it again with new contact details.',
      heading: 'A self-hosted 409A request was withdrawn',
      intro: [`${row.company_name} withdrew the 409A request it made on ${row.created_at.slice(0, 10)}, ${row.status === 'APPROVED' ? 'after you approved it' : 'before you decided on it'}.`,
        'Its server cancelled the request, or sent it again with new contact details, in which case a new one follows once the new contact confirms. Check whether a payment needs refunding.'],
      details: [{ label: 'Contact', value: [row.contact_name, row.contact_email, row.contact_phone].filter(Boolean).join('\n') }],
      signoff: `— ${mailSignature()}`,
      footer: `Sent to the internal approval inbox configured for ${config().brand.productName}.`,
    }, subject);
    // Best effort: the withdrawal stands whether or not the note goes.
    await deliver({ to: approvalAddress(), toName: 'Internal review team', subject, text, html })
      .catch((err: Error) => log('warn', '409A relay withdrawal email failed', { id: row.id, error: err.message }));
  }
  return { status: 'WITHDRAWN' };
});

/** The request a link's token opens, if it is still fresh. `kind` says which of the two links. */
async function byLink(token: unknown, kind: 'confirm' | 'team'): Promise<RelayRow> {
  const t = String(token ?? '');
  const row = TOKEN_SHAPE.test(t)
    ? await one<RelayRow>(`SELECT * FROM desk_relay_requests WHERE ${kind}_token_hash = ?`, hashToken(t)) : undefined;
  const sentAt = kind === 'confirm' ? row?.created_at : row?.confirmed_at;
  if (!row || !sentAt || sentAt <= since(config().valuationDesk.linkOpenDays * DAY)) throw notFound('This link is not valid. It may have expired.');
  return row;
}

/**
 * The contact confirms. Only then does the approval inbox hear of the request.
 * The request is claimed before the email goes, so two clicks at once send it
 * once; a failed send gives the claim back, for the link to be opened again.
 */
route.post('/api/409a-relay/confirm', 'public', async (ctx) => {
  const row = await byLink(ctx.body.token, 'confirm');
  if (row.status === 'UNCONFIRMED' && !accepting()) throw forbidden('409A requests are turned off on this server.');
  const teamToken = mint();
  const claimed = row.status === 'UNCONFIRMED' && await run(
    `UPDATE desk_relay_requests SET status = 'CONFIRMED', confirmed_at = ?, team_token_hash = ? WHERE id = ? AND status = 'UNCONFIRMED'`,
    nowISO(), hashToken(teamToken), row.id);
  if (!claimed) {
    const now = await one<{ status: string }>('SELECT status FROM desk_relay_requests WHERE id = ?', row.id);
    return { companyName: row.company_name, status: now!.status };
  }
  const unclaim = () => run(`UPDATE desk_relay_requests SET status = 'UNCONFIRMED', confirmed_at = NULL, team_token_hash = NULL WHERE id = ? AND status = 'CONFIRMED'`, row.id);
  // Counted with this one in, so confirmations arriving together cannot all pass.
  if (await lastHour('confirmed_at') > config().valuationDesk.noticesPerHour) {
    await unclaim();
    throw new HttpError(429, 'Our team is receiving a lot of requests right now. Open the link again in an hour.');
  }
  const sent = JSON.parse(row.request) as Sent;
  try {
    await deliver(composeRelayApprovalEmail({
      companyName: row.company_name, to: approvalAddress(), requestedBy: sent.requestedBy, requestedAt: row.created_at,
      contact: { name: row.contact_name || null, email: row.contact_email, phone: row.contact_phone }, instanceUrl: sent.instanceUrl,
      intake: sent.intake, documents: sent.documents, notes: sent.notes, reasons: sent.reasons,
      link: `${config().app.url}/409a-relay#team.${teamToken}`,
    }));
  } catch (err) {
    log('warn', '409A relay approval email failed', { id: row.id, error: (err as Error).message });
    await unclaim();
    throw new HttpError(502, 'Your request could not be passed to our team just now. Open the link again in a few minutes.');
  }
  return { companyName: row.company_name, status: 'CONFIRMED' };
});

/** What the approval team's page shows. A GET only reads, so a mail scanner opening the link decides nothing. */
function teamView(row: RelayRow) {
  const sent = JSON.parse(row.request) as Sent;
  return {
    id: row.id, status: row.status, deskName: deskName(), companyName: row.company_name,
    contact: { name: row.contact_name || null, email: row.contact_email, phone: row.contact_phone },
    requestedBy: sent.requestedBy, instanceUrl: sent.instanceUrl, createdAt: row.created_at, confirmedAt: row.confirmed_at, decidedAt: row.decided_at,
    answerLines: intakeLines(sent.intake), tables: intakeTables(sent.intake), documents: sent.documents, notes: sent.notes, reasons: sent.reasons,
  };
}

const teamToken = (ctx: Ctx) => { ctx.res.setHeader('Cache-Control', 'no-store'); return ctx.req.headers['x-relay-token']; };

route.get('/api/409a-relay/team', 'public', async (ctx) => teamView(await byLink(teamToken(ctx), 'team')));

route.post('/api/409a-relay/team/decide', 'public', async (ctx) => {
  const row = await byLink(teamToken(ctx), 'team');
  const decision = ctx.body.decision;
  if (decision !== 'APPROVED' && decision !== 'DECLINED') throw badRequest('Approve or decline the request.');
  if (row.status !== 'CONFIRMED') throw badRequest(`This request is already ${row.status.toLowerCase()}.`);
  await run(`UPDATE desk_relay_requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'CONFIRMED'`, decision, nowISO(), row.id);
  log('info', `409A relay request ${decision.toLowerCase()}`, { id: row.id });
  return teamView((await one<RelayRow>('SELECT * FROM desk_relay_requests WHERE id = ?', row.id))!);
});
