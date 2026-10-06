/**
 * One search box for everything a member may see. Pages, actions and
 * settings are matched in the browser; this route covers the records:
 * people, grants, certificates, SAFEs and notes, offers, documents,
 * investor updates, board consents, share classes, plans, templates and
 * saved reports. Each kind returns a handful of hits and the browser groups
 * and ranks them.
 *
 * Portfolio-only roles (employees, investors) get the documents they may
 * open and nothing else, the same rule the documents list applies.
 */
import { route } from '../http.ts';
import { all } from '../db.ts';
import { linkedStakeholderId } from './workflows.ts';
import { INSTRUMENT_NAMES } from './fundraising.ts';
import { config } from '../config.ts';

export type SearchKind =
  | 'stakeholder' | 'award' | 'certificate' | 'convertible' | 'offer' | 'document'
  | 'update' | 'consent' | 'share_class' | 'pool' | 'template' | 'saved_report';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** What a page's own search box can be prefilled with: a grant or certificate number, a document or candidate name. */
  label?: string | null;
  stakeholderId?: string | null;
}

const PER_KIND = 6;
const FULL_ACCESS = ['ADMIN', 'LEGAL', 'BOARD', 'VIEWER'];

/** `%term%`, with LIKE wildcards inside the term itself escaped (the default escape character is a backslash). */
const likePattern = (term: string): string => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** OUTSTANDING → Outstanding, CONVERTIBLE_NOTE → Convertible note. */
const pretty = (s: unknown): string => (typeof s === 'string' && s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '');
/** Whole units of money, written as locale.locale and locale.currency say. */
const money = (cents: unknown): string | null => {
  const n = Number(cents);
  if (!Number.isFinite(n) || cents == null) return null;
  const { locale, currency } = config().locale;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n / 100);
};
const join = (...parts: (string | null | undefined)[]): string | null => parts.filter((p) => p).join(' · ') || null;

route.get('/api/c/:cid/search', 'read', async (ctx) => {
  const q = (ctx.query.get('q') ?? '').trim().slice(0, 80);
  if (q.length < 2) return { query: q, results: [] as SearchHit[] };
  const like = likePattern(q);
  const cid = ctx.companyId!;
  const results: SearchHit[] = [];

  const documentHit = (d: { id: string; name: string; category: string | null; status: string | null; folder: string | null }): SearchHit =>
    ({ kind: 'document', id: d.id, title: d.name, subtitle: join(pretty(d.category), d.folder, pretty(d.status)), label: d.name });

  if (!FULL_ACCESS.includes(ctx.membership!.role)) {
    const mine = await linkedStakeholderId(ctx);
    const docs = await all<{ id: string; name: string; category: string | null; status: string | null; folder: string | null }>(
      `SELECT id, name, category, status, folder FROM documents
       WHERE company_id = ? AND (visibility = 'ALL' OR stakeholder_id = ?) AND name ILIKE ?
       ORDER BY created_at DESC LIMIT ?`, cid, mine, like, PER_KIND);
    return { query: q, results: docs.map(documentHit) };
  }

  const stakeholders = await all<{ id: string; name: string; email: string | null; relation: string | null }>(
    `SELECT id, name, email, relation FROM stakeholders
     WHERE company_id = ? AND (name ILIKE ? OR email ILIKE ?) ORDER BY name LIMIT ?`, cid, like, like, PER_KIND);
  for (const s of stakeholders) results.push({ kind: 'stakeholder', id: s.id, title: s.name, subtitle: join(pretty(s.relation), s.email), stakeholderId: s.id });

  const awards = await all<{ id: string; label: string | null; type: string; status: string; stakeholder_id: string; holder: string }>(
    `SELECT a.id, a.label, a.type, a.status, a.stakeholder_id, s.name AS holder
     FROM awards a JOIN stakeholders s ON s.id = a.stakeholder_id
     WHERE a.company_id = ? AND (a.label ILIKE ? OR s.name ILIKE ?)
     ORDER BY a.grant_date DESC NULLS LAST, a.label LIMIT ?`, cid, like, like, PER_KIND);
  for (const a of awards) results.push({ kind: 'award', id: a.id, title: join(a.label, a.holder)!, subtitle: join(a.type, pretty(a.status)), label: a.label, stakeholderId: a.stakeholder_id });

  const certificates = await all<{ id: string; certificate_no: string | null; status: string; stakeholder_id: string; holder: string; share_class: string }>(
    `SELECT i.id, i.certificate_no, i.status, i.stakeholder_id, s.name AS holder, c.name AS share_class
     FROM issuances i JOIN stakeholders s ON s.id = i.stakeholder_id JOIN share_classes c ON c.id = i.share_class_id
     WHERE i.company_id = ? AND (i.certificate_no ILIKE ? OR s.name ILIKE ?)
     ORDER BY i.issue_date DESC NULLS LAST LIMIT ?`, cid, like, like, PER_KIND);
  for (const c of certificates) results.push({ kind: 'certificate', id: c.id, title: join(c.certificate_no, c.holder)!, subtitle: join(c.share_class, pretty(c.status)), label: c.certificate_no ?? c.holder, stakeholderId: c.stakeholder_id });

  const convertibles = await all<{ id: string; instrument: string; status: string; principal: unknown; stakeholder_id: string; holder: string }>(
    `SELECT c.id, c.instrument, c.status, c.principal, c.stakeholder_id, s.name AS holder
     FROM convertibles c JOIN stakeholders s ON s.id = c.stakeholder_id
     WHERE c.company_id = ? AND (s.name ILIKE ? OR c.instrument ILIKE ?)
     ORDER BY c.issue_date DESC NULLS LAST LIMIT ?`, cid, like, like, PER_KIND);
  for (const c of convertibles) results.push({ kind: 'convertible', id: c.id, title: join(INSTRUMENT_NAMES[c.instrument] ?? pretty(c.instrument), c.holder)!, subtitle: join(money(c.principal), pretty(c.status)), stakeholderId: c.stakeholder_id });

  const offers = await all<{ id: string; candidate_name: string; position: string | null; status: string }>(
    `SELECT id, candidate_name, position, status FROM offers
     WHERE company_id = ? AND (candidate_name ILIKE ? OR position ILIKE ?) ORDER BY created_at DESC LIMIT ?`, cid, like, like, PER_KIND);
  for (const o of offers) results.push({ kind: 'offer', id: o.id, title: o.candidate_name, subtitle: join(o.position, pretty(o.status)), label: o.candidate_name });

  const documents = await all<{ id: string; name: string; category: string | null; status: string | null; folder: string | null }>(
    `SELECT id, name, category, status, folder FROM documents
     WHERE company_id = ? AND name ILIKE ? ORDER BY created_at DESC LIMIT ?`, cid, like, PER_KIND);
  for (const d of documents) results.push(documentHit(d));

  const updates = await all<{ id: string; title: string; period: string | null; status: string }>(
    `SELECT id, title, period, status FROM investor_updates
     WHERE company_id = ? AND title ILIKE ? ORDER BY created_at DESC LIMIT ?`, cid, like, PER_KIND);
  for (const u of updates) results.push({ kind: 'update', id: u.id, title: u.title, subtitle: join(u.period, pretty(u.status)) });

  const consents = await all<{ id: string; title: string; type: string | null; status: string }>(
    `SELECT id, title, type, status FROM board_consents
     WHERE company_id = ? AND title ILIKE ? ORDER BY created_at DESC LIMIT ?`, cid, like, PER_KIND);
  for (const c of consents) results.push({ kind: 'consent', id: c.id, title: c.title, subtitle: join(pretty(c.type), pretty(c.status)) });

  const classes = await all<{ id: string; name: string; kind: string | null }>(
    `SELECT id, name, kind FROM share_classes WHERE company_id = ? AND name ILIKE ? ORDER BY sort_order, name LIMIT ?`, cid, like, PER_KIND);
  for (const c of classes) results.push({ kind: 'share_class', id: c.id, title: c.name, subtitle: pretty(c.kind) || null });

  const pools = await all<{ id: string; name: string; plan_type: string | null }>(
    `SELECT id, name, plan_type FROM pools WHERE company_id = ? AND name ILIKE ? ORDER BY name LIMIT ?`, cid, like, PER_KIND);
  for (const p of pools) results.push({ kind: 'pool', id: p.id, title: p.name, subtitle: pretty(p.plan_type) || 'Equity plan' });

  const templates = await all<{ id: string; name: string; kind: string | null }>(
    `SELECT id, name, kind FROM document_templates WHERE company_id = ? AND name ILIKE ? ORDER BY name LIMIT ?`, cid, like, PER_KIND);
  for (const t of templates) results.push({ kind: 'template', id: t.id, title: t.name, subtitle: pretty(t.kind) || null });

  const reports = await all<{ id: string; name: string; dataset: string | null }>(
    `SELECT id, name, dataset FROM saved_reports WHERE company_id = ? AND name ILIKE ? ORDER BY name LIMIT ?`, cid, like, PER_KIND);
  for (const r of reports) results.push({ kind: 'saved_report', id: r.id, title: r.name, subtitle: join('Saved report', pretty(r.dataset)) });

  return { query: q, results };
});
