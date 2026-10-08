/**
 * "My pending actions": what is waiting on the person signed in, gathered from
 * records that already exist, for the tasks button in the header of every page.
 *
 * Everybody gets their own items: the signature blocks assigned to their
 * stakeholder record, the consents they are listed to vote on, and an exercise of
 * theirs that was approved and is waiting for their payment. A member who sees
 * only their own holdings (EMPLOYEE, INVESTOR) gets nothing else, so nothing here
 * tells them about anyone else's paperwork.
 *
 * The company's own work goes to the people who can do it, the editors: the
 * Company's signature blocks addressed to them, accepted offers waiting for their
 * grant, exercise requests to review or complete, a 409A report the valuation team
 * delivered or wrote a note on, a 409A that is running out or no longer holds, and
 * the open compliance findings.
 *
 * The header asks on every page and after every save, so this stays cheap: a
 * handful of indexed queries, and the compliance checks, the one engine run, kept
 * per company (see companyChecks below).
 */
import { route, type Ctx } from '../http.ts';
import { all, one, concurrently } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { config, deskName } from '../config.ts';
import { isEditor, seesWholeCompany } from '../auth.ts';
import { linkedStakeholderId } from './workflows.ts';
import { complianceOptionsFor } from './analytics.ts';
import { OPEN_STATUSES } from './valuation-requests.ts';
import { runComplianceChecks, valuationRefresh, daysBetween, formatShares, today, type ValuationRefresh } from '@kosmitor/core';

export type ActionKind =
  | 'SIGN' | 'VOTE' | 'EXERCISE_PAYMENT'
  | 'COUNTERSIGN' | 'VALUATION_DUE' | 'VALUATION_REQUEST' | 'COMPLIANCE' | 'EXERCISE_REVIEW' | 'OFFER';

export interface MyAction {
  /** Stable across calls, so the list can be keyed on it. */
  id: string;
  kind: ActionKind;
  title: string;
  detail: string | null;
  /** The page in the app where it is done. */
  to: string;
  /** When it arrived, or when it falls due. */
  date: string | null;
  /** Past due or blocking something: drawn in the warning colour. */
  urgent: boolean;
}

const OPEN_REQUESTS = OPEN_STATUSES.map((s) => `'${s}'`).join(', ');
/** How the workflows name the Company's signature block (routes/workflows.ts). */
const COMPANY_BLOCK = ' — for the Company';
/** A note from the valuation team that no one has answered stays in the list this long, then the 409A page keeps it. */
const NOTE_DAYS = 14;
const plural = (n: number, one: string, many = `${one}s`): string => `${formatShares(n)} ${n === 1 ? one : many}`;
const clip = (s: string, max = 140): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const q = encodeURIComponent;

// --- The engine's part, kept between calls ----------------------------------------
//
// The compliance checks are the slow part: a few hundred milliseconds for a company
// of a few dozen holders, and the server does nothing else while they run. So the
// answer is kept per company and worked out again only once the records may have
// moved on: a new entry in the audit log (every write route records one), a new
// day, or a couple of minutes. Even then the request does not wait for it. It gets
// the last answer, with how long until the next one (`settlesIn`, for the header to
// ask again then), and the run starts a moment later, off the path of the page the
// request came with, and no sooner than RUN_GAP_MS after the last one, so a burst
// of saves costs one run. Only the very first request for a company waits.

interface Checked { errors: number; warnings: number; valuationErrors: number; valuationWarnings: number; top: string | null; refresh: ValuationRefresh }
interface Kept {
  key: string; value: Checked; startedAt: number; doneAt: number;
  /** How long the engine took, the part a caller waiting for the next answer waits on. */
  took: number;
  /** When the next run starts, once one is wanted. */
  due: number | null;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}

const FRESH_MS = 120_000;
const RUN_DELAY_MS = 1_000;
const RUN_GAP_MS = 10_000;
const kept = new Map<string, Kept>();
const firstRuns = new Map<string, Promise<Kept>>();

/** What the answer depends on besides the records' contents: the day, and the last thing written. */
async function recordsKey(companyId: string): Promise<string> {
  const head = await one<{ id: string }>('SELECT id FROM audit_log WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', companyId);
  return `${today()}|${head?.id ?? ''}`;
}

/** Runs the checks and keeps the answer. The key is read first, so a write landing meanwhile only makes the next call run them again. */
async function check(companyId: string): Promise<Kept> {
  const key = await recordsKey(companyId);
  const asOf = today();
  const startedAt = Date.now();
  const data = await getCompanyData(companyId);
  const options = await complianceOptionsFor(companyId, asOf);
  const ran = performance.now();
  const open = runComplianceChecks(data, options).filter((i) => i.severity === 'ERROR' || i.severity === 'WARNING');
  const valuation = open.filter((i) => i.rule === 'VALUATION_409A');
  const value: Checked = {
    errors: open.filter((i) => i.severity === 'ERROR').length,
    warnings: open.filter((i) => i.severity === 'WARNING').length,
    valuationErrors: valuation.filter((i) => i.severity === 'ERROR').length,
    valuationWarnings: valuation.filter((i) => i.severity === 'WARNING').length,
    top: open.find((i) => i.rule !== 'VALUATION_409A')?.title ?? null,
    refresh: valuationRefresh(data, asOf, config().compliance.valuationExpiryWarningDays),
  };
  const entry: Kept = { key, value, startedAt, doneAt: Date.now(), took: Math.round(performance.now() - ran), due: null };
  kept.set(companyId, entry);
  return entry;
}

/** The run a stale answer asked for, once however often it is asked. A failed one leaves the last answer, and the next call asks again. */
function runDue(companyId: string, entry: Kept): Promise<void> {
  clearTimeout(entry.timer);
  entry.running ??= check(companyId).then(() => undefined, (err: unknown) => {
    entry.due = null;
    entry.running = undefined;
    console.error('[my-actions] the compliance checks failed:', (err as Error).message);
  });
  return entry.running;
}

async function companyChecks(companyId: string): Promise<{ checks: Checked; settlesIn: number }> {
  let entry = kept.get(companyId);
  if (!entry) {
    let first = firstRuns.get(companyId);
    if (!first) {
      first = check(companyId).finally(() => firstRuns.delete(companyId));
      firstRuns.set(companyId, first);
    }
    entry = await first;
    return { checks: entry.value, settlesIn: 0 };
  }
  const key = await recordsKey(companyId);
  const current = kept.get(companyId)!;
  if (current.due == null && (current.key !== key || Date.now() - current.doneAt >= FRESH_MS)) {
    current.due = Math.max(Date.now() + RUN_DELAY_MS, current.startedAt + RUN_GAP_MS);
    current.timer = setTimeout(() => void runDue(companyId, current), current.due - Date.now());
    current.timer.unref?.();
  }
  return { checks: current.value, settlesIn: current.due == null ? 0 : Math.max(0, current.due - Date.now()) + current.took };
}

/** Runs any checks still waiting for their moment now, and resolves once they are in. Tests use it in place of waiting. */
export async function settleChecks(companyId: string): Promise<void> {
  const entry = kept.get(companyId);
  if (entry?.due != null) await runDue(companyId, entry);
}

// --- Rows ----------------------------------------------------------------------------

interface BlockRow {
  id: string; document_id: string; document_name: string; category: string | null; sent_at: string | null; created_at: string;
  award_label: string | null; certificate_no: string | null; others_pending: number;
}
interface VoteRow { id: string; title: string; kind: string | null; linked_entity_type: string | null; linked_entity_ids: string | null; created_at: string }
interface ExerciseRow { id: string; status: string; quantity: number; award_label: string | null; stakeholder_name: string; requested_at: string; paid_at: string | null; reviewed_at: string | null }
interface OfferRow { id: string; candidate_name: string; position: string; accepted_at: string | null }
interface RequestRow { id: string; status: string; provider: string; appraiser: string | null; updated_at: string | null; created_at: string; last_author: string | null; last_kind: string | null; last_message: string | null; last_at: string | null }

/** Where the Company's signature on a document is given: the page of the instrument it issues. */
function countersignPage(b: BlockRow): string {
  if (b.category === 'GRANT_AGREEMENT' && b.award_label) return `/grants?q=${q(b.award_label)}`;
  if (b.category === 'CERTIFICATE' && b.certificate_no) return `/certificates?q=${q(b.certificate_no)}`;
  if (b.category === 'CONVERTIBLE_AGREEMENT') return '/convertibles';
  return `/documents?q=${q(b.document_name)}`;
}

const BLOCK_SQL = `
  SELECT s.id, s.document_id, d.name AS document_name, d.category, s.sent_at, s.created_at,
         a.label AS award_label, i.certificate_no,
         (SELECT COUNT(*) FROM signatures o WHERE o.document_id = s.document_id AND o.id <> s.id AND o.status = 'PENDING')::int AS others_pending
  FROM signatures s
  JOIN documents d ON d.id = s.document_id AND d.company_id = s.company_id
  LEFT JOIN awards a ON a.id = d.security_id AND a.company_id = d.company_id
  LEFT JOIN issuances i ON i.id = d.security_id AND i.company_id = d.company_id
  WHERE s.company_id = ? AND s.status = 'PENDING' AND d.status <> 'VOID'`;

/**
 * What waits on the person signed in, and, for an editor, `settlesIn`: the
 * milliseconds until the compliance items are worked out again after a change
 * (0 when they are current), so the header knows when to ask again.
 */
export async function myActions(ctx: Ctx): Promise<{ items: MyAction[]; settlesIn: number }> {
  const cid = ctx.companyId!;
  const role = ctx.membership!.role;
  const wholeCompany = seesWholeCompany(role);
  const editor = isEditor(role);
  const mine = await linkedStakeholderId(ctx);
  const email = (ctx.user?.email ?? '').toLowerCase();
  const none = async () => [] as never[];

  const [own, votes, payments, company, offers, exercises, requests] = await concurrently([
    () => (mine ? all<BlockRow>(`${BLOCK_SQL} AND s.stakeholder_id = ? ORDER BY s.created_at`, cid, mine) : none()),
    () => (mine ? all<VoteRow>(
      `SELECT c.id, c.title, c.kind, c.linked_entity_type, c.linked_entity_ids, c.created_at
       FROM board_votes v JOIN board_consents c ON c.id = v.consent_id
       WHERE c.company_id = ? AND v.stakeholder_id = ? AND v.vote = 'PENDING' AND c.status = 'PENDING' ORDER BY c.created_at`, cid, mine) : none()),
    () => (mine ? all<ExerciseRow>(
      `SELECT r.id, r.status, r.quantity, a.label AS award_label, '' AS stakeholder_name, r.requested_at, r.paid_at, r.reviewed_at
       FROM exercise_requests r JOIN awards a ON a.id = r.award_id AND a.company_id = r.company_id
       WHERE r.company_id = ? AND r.stakeholder_id = ? AND r.status = 'APPROVED' ORDER BY r.requested_at`, cid, mine) : none()),
    // The Company's own block, signed by an officer: the one it was addressed to, or any when it names nobody. The
    // workflows write it as "Name, Title — for the Company"; a block for someone outside with no stakeholder record is not it.
    () => (editor ? all<BlockRow>(
      `${BLOCK_SQL} AND s.stakeholder_id IS NULL AND s.signer_name LIKE ? AND (COALESCE(s.signer_email, '') = '' OR LOWER(s.signer_email) = ?)
       ORDER BY s.created_at`, cid, `%${COMPANY_BLOCK}`, email) : none()),
    () => (editor ? all<OfferRow>("SELECT id, candidate_name, position, accepted_at FROM offers WHERE company_id = ? AND status = 'ACCEPTED' ORDER BY accepted_at", cid) : none()),
    () => (editor ? all<ExerciseRow>(
      `SELECT r.id, r.status, r.quantity, a.label AS award_label, s.name AS stakeholder_name, r.requested_at, r.paid_at, r.reviewed_at
       FROM exercise_requests r JOIN awards a ON a.id = r.award_id AND a.company_id = r.company_id
       JOIN stakeholders s ON s.id = r.stakeholder_id AND s.company_id = r.company_id
       WHERE r.company_id = ? AND r.status IN ('REQUESTED', 'PAID') ORDER BY r.requested_at`, cid) : none()),
    () => (editor ? all<RequestRow>(
      `SELECT r.id, r.status, r.provider, r.appraiser, r.updated_at, r.created_at,
              e.author AS last_author, e.kind AS last_kind, e.message AS last_message, e.created_at AS last_at
       FROM valuation_requests r
       LEFT JOIN LATERAL (SELECT author, kind, message, created_at FROM valuation_request_events
                          WHERE request_id = r.id AND company_id = r.company_id ORDER BY created_at DESC, id DESC LIMIT 1) e ON TRUE
       WHERE r.company_id = ? AND r.status IN (${OPEN_REQUESTS}) ORDER BY r.created_at`, cid) : none()),
  ]);

  const items: MyAction[] = [];

  // Things only this person can do come first.
  for (const b of own) {
    items.push({
      id: `sign:${b.id}`, kind: 'SIGN', title: b.document_name, detail: 'Waiting for your signature',
      to: '/portal', date: b.sent_at ?? b.created_at, urgent: false,
    });
  }
  for (const v of votes) {
    const linked: string[] = (() => { try { return v.linked_entity_ids ? JSON.parse(v.linked_entity_ids) as string[] : []; } catch { return []; } })();
    const approves = v.linked_entity_type === 'awards' && linked.length ? ` It approves ${plural(linked.length, 'grant')}.`
      : v.linked_entity_type === 'convertibles' && linked.length ? ` It approves ${plural(linked.length, 'SAFE or note', 'SAFEs or notes')}.` : '';
    items.push({
      id: `vote:${v.id}`, kind: 'VOTE', title: v.title,
      detail: `${v.kind === 'STOCKHOLDER' ? 'Stockholder' : 'Board'} consent waiting for your vote.${approves}`,
      to: wholeCompany ? '/consents' : '/portal', date: v.created_at, urgent: false,
    });
  }
  for (const r of payments) {
    items.push({
      id: `pay:${r.id}`, kind: 'EXERCISE_PAYMENT', title: `Pay for your exercise of ${r.award_label ?? 'your grant'}`,
      detail: `${plural(Number(r.quantity), 'option')} approved. The payment instructions are on My equity.`,
      to: '/portal', date: r.reviewed_at ?? r.requested_at, urgent: false,
    });
  }
  if (!editor) return { items, settlesIn: 0 };

  // Named for what is asked, so it does not read as the holder's own signature on the same document.
  for (const b of company) {
    items.push({
      id: `countersign:${b.id}`, kind: 'COUNTERSIGN', title: `Sign for the Company: ${b.document_name}`,
      detail: b.others_pending > 0 ? 'Others have yet to sign as well.' : 'Everyone else has signed; the Company\'s signature is the last one.',
      to: countersignPage(b), date: b.sent_at ?? b.created_at, urgent: false,
    });
  }

  // The 409A: a report to record or a note from the team, and, with no request open, one that is running out.
  for (const r of requests) {
    if (r.status === 'DELIVERED') {
      items.push({
        id: `409a:${r.id}`, kind: 'VALUATION_REQUEST', title: `Record the 409A from ${r.appraiser || r.provider}`,
        detail: 'The report was delivered. Check its figures and record the valuation.', to: '/compliance/409a',
        date: r.last_at ?? r.updated_at ?? r.created_at, urgent: false,
      });
    } else if (r.last_author === 'desk' && r.last_kind === 'MESSAGE' && r.last_at && daysBetween(r.last_at.slice(0, 10), today()) <= NOTE_DAYS) {
      items.push({
        id: `409a:${r.id}`, kind: 'VALUATION_REQUEST', title: `Note from the ${deskName()}`,
        detail: r.last_message ? clip(r.last_message) : 'On your 409A request', to: '/compliance/409a',
        date: r.last_at, urgent: false,
      });
    }
  }
  const { checks, settlesIn } = await companyChecks(cid);
  const trigger = checks.refresh.triggers.find((t) => t.severity === 'REQUIRED' || t.reason === 'EXPIRING');
  const valuationShown = !!trigger && requests.length === 0;
  if (valuationShown) {
    const asOf = today();
    const titles: Record<string, string> = {
      NO_VALUATION: 'No 409A valuation on file',
      EXPIRED: 'The 409A valuation no longer supports new grants',
      EXPIRING: `The 409A valuation runs out in ${plural(trigger!.date ? Math.max(0, daysBetween(asOf, trigger!.date)) : 0, 'day')}`,
      PRICED_ROUND: `A priced round since the 409A${trigger!.shareClassName ? ` (${trigger!.shareClassName})` : ''} calls for a new one`,
    };
    items.push({
      id: '409a:refresh', kind: 'VALUATION_DUE', title: titles[trigger!.reason] ?? 'A new 409A valuation is due',
      detail: trigger!.reason === 'EXPIRING' ? 'Ask for a new 409A before granting more options.' : 'Options granted now have no 409A behind their strike price.',
      to: '/compliance/409a', date: trigger!.date ?? null, urgent: trigger!.severity === 'REQUIRED',
    });
  }
  // Findings about the 409A are the item above when it shows, and in hand while a request is open.
  const handled = valuationShown || requests.length > 0;
  const errors = checks.errors - (handled ? checks.valuationErrors : 0);
  const warnings = checks.warnings - (handled ? checks.valuationWarnings : 0);
  if (errors + warnings > 0) {
    items.push({
      id: 'compliance', kind: 'COMPLIANCE',
      title: errors > 0 ? `${plural(errors, 'compliance finding')} to fix` : `${plural(warnings, 'compliance finding')} to review`,
      detail: [errors > 0 && warnings > 0 ? `And ${formatShares(warnings)} to review.` : null, checks.top].filter(Boolean).join(' ') || null,
      to: '/compliance', date: null, urgent: errors > 0,
    });
  }

  for (const r of exercises) {
    items.push(r.status === 'PAID'
      ? {
          id: `exercise:${r.id}`, kind: 'EXERCISE_REVIEW', title: `Complete ${r.stakeholder_name}'s exercise`,
          detail: `Payment received for ${plural(Number(r.quantity), 'option')} of ${r.award_label ?? 'a grant'}. Record the exercise.`,
          to: '/grants#exercise-requests', date: r.paid_at ?? r.requested_at, urgent: false,
        }
      : {
          id: `exercise:${r.id}`, kind: 'EXERCISE_REVIEW', title: `Exercise request from ${r.stakeholder_name}`,
          detail: `${plural(Number(r.quantity), 'option')} of ${r.award_label ?? 'a grant'}, waiting for review.`,
          to: '/grants#exercise-requests', date: r.requested_at, urgent: false,
        });
  }
  for (const o of offers) {
    items.push({
      id: `offer:${o.id}`, kind: 'OFFER', title: `Grant the equity ${o.candidate_name} accepted`,
      detail: `${o.position} offer accepted. The grant is not made until it is issued.`,
      to: `/grants?offer=${q(o.id)}`, date: o.accepted_at, urgent: false,
    });
  }
  return { items, settlesIn };
}

route.get('/api/c/:cid/my-actions', 'read', async (ctx) => {
  const { items, settlesIn } = await myActions(ctx);
  return { items, count: items.length, settlesIn };
});
