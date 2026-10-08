/**
 * Investor updates: a company writes an update with a few headline metrics,
 * picks an audience, and sends it. Every recipient gets a row so the company
 * can see who was emailed and who has opened the update in their portal.
 */
import { route, newId, nowISO, audit, badRequest, notFound, str, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll } from '../db.ts';
import { sendMail, mailConfigured, type Message } from '../mail.ts';
import { config } from '../config.ts';
import { renderEmail, paragraphsOf } from '../email.ts';
import { directorsOn } from '../board.ts';
import { today } from '@kosmitor/core';

/**
 * Who an update can go to. The board is whoever holds a seat today, by the seat's own
 * dates and whatever their relationship, so an investor who is a director gets both the
 * investor and the board updates, and a founder without a seat gets neither of the board's.
 */
export const AUDIENCES: Record<string, { label: string; relations: string[] | null; directors?: boolean }> = {
  ALL: { label: 'Everyone on the cap table', relations: null },
  INVESTORS: { label: 'Investors', relations: ['INVESTOR'] },
  TEAM: { label: 'Team (founders, employees, advisors, contractors)', relations: ['FOUNDER', 'EMPLOYEE', 'ADVISOR', 'CONTRACTOR'] },
  BOARD: { label: 'Board of directors', relations: [], directors: true },
  CUSTOM: { label: 'Chosen stakeholders', relations: [] },
};

interface UpdateRow {
  id: string; company_id: string; title: string; period: string | null; body: string; metrics: string | null; status: string; sent_at: string | null;
  audience: string; recipient_ids: string | null; sent_by: string | null; created_by: string | null; created_at: string; updated_at: string | null;
}
export type Metric = { label: string; value: string };

/** Metrics are stored as JSON: a list of label/value pairs, or the older object form. */
export function parseMetrics(raw: string | null): Metric[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((m) => m && typeof m.label === 'string').map((m) => ({ label: String(m.label), value: String(m.value ?? '') }));
    if (parsed && typeof parsed === 'object') return Object.entries(parsed).map(([label, value]) => ({ label, value: String(value) }));
  } catch { /* fall through */ }
  return [];
}

async function updateRow(ctx: Ctx, id: string): Promise<UpdateRow> {
  const row = await one<UpdateRow>('SELECT * FROM investor_updates WHERE id = ? AND company_id = ?', id, ctx.companyId);
  if (!row) throw notFound('Update not found.');
  return row;
}

/** Stakeholders an audience resolves to, right now. */
export async function resolveAudience(companyId: string, audience: string, recipientIds: string[]): Promise<{ id: string; name: string; email: string | null; relation: string }[]> {
  const spec = AUDIENCES[audience];
  if (!spec) throw badRequest('Unknown audience.');
  if (spec.directors) return (await directorsOn(companyId, today())).map(({ id, name, email, relation }) => ({ id, name, email, relation }));
  const rows = await all<{ id: string; name: string; email: string | null; relation: string; termination_date: string | null }>(
    'SELECT id, name, email, relation, termination_date FROM stakeholders WHERE company_id = ? ORDER BY name', companyId);
  if (audience === 'CUSTOM') return rows.filter((s) => recipientIds.includes(s.id));
  return rows.filter((s) => !s.termination_date && (spec.relations === null || spec.relations.includes(s.relation)));
}

function readUpdate(b: Record<string, unknown>) {
  const audience = String(b.audience ?? 'INVESTORS');
  if (!AUDIENCES[audience]) throw badRequest('Choose an audience.');
  const recipientIds: string[] = Array.isArray(b.recipientIds) ? b.recipientIds.map(String) : [];
  if (audience === 'CUSTOM' && recipientIds.length === 0) throw badRequest('Choose at least one recipient.');
  const metrics: Metric[] = Array.isArray(b.metrics)
    ? (b.metrics as Record<string, unknown>[]).filter((m) => m && String(m.label ?? '').trim()).map((m) => ({ label: String(m.label).trim().slice(0, 80), value: String(m.value ?? '').trim().slice(0, 80) }))
    : [];
  return {
    title: str(b.title, 'Title', { max: 200 }), period: b.period ? str(b.period, 'Period', { max: 60 }) : null,
    body: str(b.body, 'Update', { max: 50_000 }), metrics: JSON.stringify(metrics), audience, recipientIds: JSON.stringify(recipientIds),
  };
}

async function present(ctx: Ctx, rows: UpdateRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const stats = await all<{ update_id: string; recipients: number; emailed: number; viewed: number }>(
    `SELECT update_id, COUNT(*) AS recipients, SUM(emailed) AS emailed, COUNT(viewed_at) AS viewed
     FROM update_recipients WHERE update_id IN (${ids.map(() => '?').join(',')}) GROUP BY update_id`, ...ids);
  const statOf = new Map(stats.map((s) => [s.update_id, s]));
  return rows.map((r) => {
    const s = statOf.get(r.id);
    return {
      ...toCamel<Record<string, unknown>>(r as unknown as Record<string, unknown>), metrics: parseMetrics(r.metrics),
      recipientIds: r.recipient_ids ? JSON.parse(r.recipient_ids) : [], audienceLabel: AUDIENCES[r.audience]?.label ?? r.audience,
      recipientCount: Number(s?.recipients ?? 0), emailedCount: Number(s?.emailed ?? 0), viewedCount: Number(s?.viewed ?? 0),
    };
  });
}

route.get('/api/c/:cid/updates', 'read', async (ctx) => {
  const rows = await all<UpdateRow>('SELECT * FROM investor_updates WHERE company_id = ? ORDER BY COALESCE(sent_at, created_at) DESC', ctx.companyId);
  const audienceCounts: Record<string, number> = {};
  for (const key of Object.keys(AUDIENCES)) if (key !== 'CUSTOM') audienceCounts[key] = (await resolveAudience(ctx.companyId!, key, [])).length;
  return { updates: await present(ctx, rows), audiences: Object.entries(AUDIENCES).map(([key, a]) => ({ key, label: a.label, count: audienceCounts[key] ?? null })) };
});

route.get('/api/c/:cid/updates/:id', 'read', async (ctx) => {
  const row = await updateRow(ctx, ctx.params.id);
  const [presented] = await present(ctx, [row]);
  const recipients = toCamelAll<Record<string, unknown>>(await all(
    `SELECT r.*, s.name, s.relation FROM update_recipients r JOIN stakeholders s ON s.id = r.stakeholder_id WHERE r.update_id = ? ORDER BY s.name`, row.id));
  const preview = row.status === 'DRAFT' ? await resolveAudience(ctx.companyId!, row.audience, row.recipient_ids ? JSON.parse(row.recipient_ids) : []) : [];
  return { ...presented, recipients, preview: preview.map((s) => ({ id: s.id, name: s.name, email: s.email, relation: s.relation })) };
});

route.post('/api/c/:cid/updates', 'write', async (ctx) => {
  const values = readUpdate(ctx.body);
  const id = newId('upd');
  await insert('investor_updates', { id, companyId: ctx.companyId, ...values, status: 'DRAFT', sentAt: null, createdBy: ctx.user!.name, createdAt: nowISO() });
  await audit(ctx, 'CREATE', 'investor_updates', id, `Update "${values.title}" drafted`);
  return (await present(ctx, [await updateRow(ctx, id)]))[0];
});

route.patch('/api/c/:cid/updates/:id', 'write', async (ctx) => {
  const existing = await updateRow(ctx, ctx.params.id);
  if (existing.status !== 'DRAFT') throw badRequest('A sent update cannot be edited; draft a new one.');
  const current = { title: existing.title, period: existing.period, body: existing.body, audience: existing.audience, recipientIds: existing.recipient_ids ? JSON.parse(existing.recipient_ids) : [], metrics: parseMetrics(existing.metrics) };
  const values = readUpdate({ ...current, ...ctx.body });
  await update('investor_updates', existing.id, { ...values, updatedAt: nowISO() });
  await audit(ctx, 'UPDATE', 'investor_updates', existing.id, `Update "${values.title}" edited`);
  return (await present(ctx, [await updateRow(ctx, existing.id)]))[0];
});

route.del('/api/c/:cid/updates/:id', 'write', async (ctx) => {
  const existing = await updateRow(ctx, ctx.params.id);
  await run('DELETE FROM investor_updates WHERE id = ?', existing.id);
  await audit(ctx, 'DELETE', 'investor_updates', existing.id, `Update "${existing.title}" deleted`);
  return { ok: true };
});

// --- The email -------------------------------------------------------------------

/** Cuts a typed name or title for a subject line, which mail apps show only the start of. */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s);
/** A sentence from a typed title: a full stop unless it already ends in one, a question or an exclamation. */
const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
/** A title that already says it is an update, so the subject does not say so twice. */
const SAYS_WHAT_IT_IS = /\b(update|updates|newsletter|letter|report|memo|news|recap)\b/i;

export interface InvestorUpdateEmail {
  companyName: string;
  /** The stakeholder's address, and their name for the greeting. */
  to: string;
  toName: string;
  title: string;
  period: string | null;
  /** The update as the company typed it; blank lines separate paragraphs. */
  body: string;
  metrics: Metric[];
  /** The holder's portal, which keeps every update sent to them. */
  portalUrl: string;
}

/**
 * The update as an email to one stakeholder: the headline numbers in a box, the
 * full text below, and a link to the portal, where opening it tells the company
 * it has been read. Pure, so the wording can be tested without sending anything.
 */
export function composeInvestorUpdateEmail(u: InvestorUpdateEmail): Message {
  const product = config().brand.productName;
  const company = u.companyName;
  const paragraphs = paragraphsOf(u.body);
  const prefix = `${clip(company, 40)}${SAYS_WHAT_IT_IS.test(u.title) ? '' : ' update'}: `;
  const subject = `${prefix}${clip(u.title, Math.max(30, 78 - prefix.length))}`;
  const lead = `${company} has sent you a new update, “${u.title}”.`;
  const glimpse = u.metrics.length
    ? u.metrics.slice(0, 3).map((m) => `${m.label}: ${m.value}`).join('; ')
    : clip(paragraphs[0] ?? '', 140);
  const content = {
    preview: `${u.period ? `${company} update for ${u.period}.` : `New update from ${company}.`}${glimpse ? ` ${sentence(glimpse)}` : ''}`,
    from: company,
    heading: u.title,
    greeting: `Hi ${u.toName},`,
    intro: [`${lead} ${u.metrics.length ? 'The key numbers are first, followed by the full update.' : 'The full update is below.'}`],
    details: [
      ...(u.period ? [{ label: 'Period', value: u.period }] : []),
      ...u.metrics.map((m) => ({ label: m.label, value: m.value || '—' })),
    ],
    action: { label: 'Read it in your portal', url: u.portalUrl },
    actionNote: `Your portal keeps this update with the others ${company} has sent you. Opening it there lets ${company} see that you have read it.`,
    sections: paragraphs.length ? [{ title: 'The full update', paragraphs }] : [],
    signoff: `— ${company}`,
    footer: `You are receiving this because you are a stakeholder of ${company}, which shares its updates through ${product}. Questions about this update? Contact ${company} directly.`,
  };
  return { to: u.to, toName: u.toName, subject, ...renderEmail(content, subject) };
}

/** Sends a draft: one recipient row per stakeholder in the audience, an email to each address on file. */
route.post('/api/c/:cid/updates/:id/send', 'write', async (ctx) => {
  const row = await updateRow(ctx, ctx.params.id);
  if (row.status !== 'DRAFT') throw badRequest('This update has already been sent.');
  const recipients = await resolveAudience(ctx.companyId!, row.audience, row.recipient_ids ? JSON.parse(row.recipient_ids) : []);
  if (recipients.length === 0) throw badRequest('Nobody matches this audience yet.');
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  const link = `${config().app.url}/portal`;
  const metrics = parseMetrics(row.metrics);
  let emailed = 0;
  for (const r of recipients) {
    let delivered = false;
    // One recipient's unusable address must not stop the update reaching the rest.
    if (r.email && mailConfigured()) {
      try {
        delivered = (await sendMail(composeInvestorUpdateEmail({
          companyName: company.name, to: r.email, toName: r.name,
          title: row.title, period: row.period, body: row.body, metrics, portalUrl: link,
        }))).delivered;
      } catch (err) {
        console.error(`[mail] investor update to ${r.name} failed:`, err);
      }
    }
    if (delivered) emailed += 1;
    await insert('update_recipients', { id: newId('upr'), updateId: row.id, stakeholderId: r.id, email: r.email, emailed: delivered ? 1 : 0, sentAt: nowISO(), viewedAt: null });
  }
  await update('investor_updates', row.id, { status: 'SENT', sentAt: nowISO(), sentBy: ctx.user!.name, updatedAt: nowISO() });
  await audit(ctx, 'SEND', 'investor_updates', row.id, `Update "${row.title}" sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}${emailed ? ` (${emailed} emailed)` : ''}`);
  const withoutEmail = recipients.filter((r) => !r.email).length;
  return {
    update: (await present(ctx, [await updateRow(ctx, row.id)]))[0], sent: recipients.length, emailed, withoutEmail,
    reason: emailed ? null : !mailConfigured() ? 'Email is not configured on this server; recipients see the update in their portal.' : withoutEmail === recipients.length ? 'None of the recipients has an email address.' : null,
  };
});

/** Updates addressed to a stakeholder, newest first, with whether they have opened each. */
export async function updatesFor(companyId: string, stakeholderId: string) {
  const rows = await all<UpdateRow & { viewed_at: string | null; recipient_id: string }>(
    `SELECT u.*, r.viewed_at, r.id AS recipient_id FROM update_recipients r JOIN investor_updates u ON u.id = r.update_id
     WHERE u.company_id = ? AND r.stakeholder_id = ? AND u.status = 'SENT' ORDER BY u.sent_at DESC`, companyId, stakeholderId);
  return rows.map((r) => ({ id: r.id, title: r.title, period: r.period, body: r.body, metrics: parseMetrics(r.metrics), sentAt: r.sent_at, viewedAt: r.viewed_at }));
}

/** A recipient opened the update in their portal. */
export async function markUpdateRead(companyId: string, stakeholderId: string, updateId: string): Promise<boolean> {
  const row = await one<{ id: string; viewed_at: string | null }>(
    'SELECT r.id, r.viewed_at FROM update_recipients r JOIN investor_updates u ON u.id = r.update_id WHERE u.company_id = ? AND r.stakeholder_id = ? AND r.update_id = ?', companyId, stakeholderId, updateId);
  if (!row) return false;
  if (!row.viewed_at) await update('update_recipients', row.id, { viewedAt: nowISO() });
  return true;
}
