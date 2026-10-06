/**
 * Asking the valuation team (valuationDesk in the param file) for a new 409A,
 * from the page that shows the current one. With valuationDesk.enabled off,
 * nothing here offers the team: the banner still says why a valuation is due, and
 * requests made earlier still show, with what can be done to them.
 *
 * Three things live here. The banner says whether a new valuation is due and why,
 * in the server's words, so the page and the team's email never disagree. The
 * request is the appraiser's information request, asked step by step
 * (ValuationChecklist.tsx holds the questions and their rules); sending it emails
 * the team the answers, the names of the documents and the capital structure,
 * and emails a recap to whoever asked. And the open request stays on the page
 * with a tracker the team moves along (started, report delivered) until the
 * valuation it produced is recorded against it, so the history reads straight.
 *
 * When the team uploads the report, the delivered request shows what the server
 * read from it beside a link to read it, and "Review and record" opens the
 * Record valuation form filled in from those values. Nothing is recorded until
 * someone here has checked them and saved the form.
 *
 * Nothing built from the cap table names a holder. The only names in the answers
 * the team reads are the ones typed in answer to the appraiser's questions: the
 * management team, the people on below-market salaries, and how the buyer and
 * the seller of a secondary sale are described, which the form asks for as a
 * role. The documents attached go as they are, since the appraiser asked for
 * them, and may name people (a SAFE names its investor); both emails list them
 * by name, and the files are on the team's page while the request is open.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from './session.tsx';
import { useQuery, api, downloadFile } from './api.ts';
import { FormModal, FormGrid } from './crud.tsx';
import {
  ActionMenu, Banner, Button, Card, CardHeader, ConfirmDialog, ErrorNote, Field, Input, Modal, Textarea, StatusBadge, useToast, cx,
} from './ui.tsx';
import type { ActionItem } from './pickers.tsx';
import { Icon } from './icons.tsx';
import { PdfViewer } from './PdfViewer.tsx';
import { date, dateTime, today, pps } from './format.ts';
import { config } from './config.ts';
import { readableDocumentPath, documentFilename, downloadDocumentPath, documentAccess } from './documents.ts';
import {
  STEPS, Reveal, ValuationStep, DocumentsStep, PeopleStep, TransactionsStep, ContactStep, AnswerTables, RequestDocumentList,
  applyChecklist, attach, blankIntake, contactProblemsOf, fromVault, intakeBody, prefilledIntake, problemsOf, questionsOf, stepOf, vaultContext,
  type AnswerTable, type Checklist, type DocumentItem, type IntakeForm, type Problems, type RequestDocument, type StepId, type StoredAnswers,
} from './ValuationChecklist.tsx';
import { VaultPicker } from './VaultPicker.tsx';
import { useReportOpener } from './ValuationReportField.tsx';
import { reportDocumentOf, type RequestReport } from './ReportReading.tsx';

export interface RefreshTrigger {
  reason: 'NO_VALUATION' | 'EXPIRED' | 'EXPIRING' | 'PRICED_ROUND' | 'CONVERTIBLE';
  severity: 'REQUIRED' | 'ADVISED';
  date: string | null;
  text: string;
}

export interface ValuationRefresh {
  current: { id: string; effectiveDate: string; expiresOn: string; fairMarketValue: number; provider: string | null } | null;
  due: boolean;
  triggers: RefreshTrigger[];
}

export interface RequestEvent {
  id: string;
  kind: 'IN_PROGRESS' | 'DELIVERED' | 'CANCELLED' | 'COMPLETED' | 'MESSAGE' | 'CONTACT_CHANGED';
  message: string | null;
  author: 'company' | 'desk';
  authorName: string;
  createdAt: string;
}

export interface ValuationRequest {
  id: string;
  status: 'REQUESTED' | 'IN_PROGRESS' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED';
  provider: string;
  reasons: string[];
  requestedBy: string;
  createdAt: string;
  /**
   * When it last changed. Sent back when completing it, so the server can refuse
   * if the team changed it after the page read it: reopened, with the report withdrawn.
   */
  updatedAt: string;
  closedAt: string | null;
  /** Made by the person reading it. */
  mine: boolean;
  /** Whether the person who asked is emailed at each step: the emails are on, and their role still reads this page. */
  emailsRequester: boolean;
  /** Null on a request made before the intake questions. */
  answers: StoredAnswers | null;
  answerLines: { label: string; value: string }[];
  /** The answers that are lists, in words. Empty for a request made before the appraiser's checklist. */
  tables: AnswerTable[];
  /** The documents sent with it, in the checklist's order, as far as the reader's role sees them in the vault. */
  documents: RequestDocument[];
  /** Documents sent that the reader's role does not see, and so are not in `documents`. */
  documentsHidden: number;
  notes: string | null;
  contactName: string | null;
  /** Only sent to the people who can make requests. */
  contactEmail: string | null;
  contactPhone: string | null;
  recapSentAt: string | null;
  deskNotifiedAt: string | null;
  /** Set by the team when it delivers the report. */
  appraiser: string | null;
  reportDate: string | null;
  /**
   * The report the team uploaded, what the server read from it, and the price and
   * method the team entered when it delivered. Null when it uploaded nothing.
   */
  report?: RequestReport | null;
  valuationId: string | null;
  completedAt: string | null;
  targetDate: string | null;
  events: RequestEvent[];
}

/** Keep in step with the server's OPEN_STATUSES. */
export const OPEN_STATUSES: ValuationRequest['status'][] = ['REQUESTED', 'IN_PROGRESS', 'DELIVERED'];
const isOpen = (r: ValuationRequest) => OPEN_STATUSES.includes(r.status);

/**
 * What the team is called, as it reads after "the": valuationDesk.name, or the
 * product's name with "valuation team". The server resolves it, uses the same name
 * in its emails and stores it on every request.
 */
const DESK = config.valuationDesk.name;

/** Whether this server offers the team at all (valuationDesk.enabled). */
const DESK_ON = config.valuationDesk.enabled;

/** Whether the person who asked is emailed at each step (valuationDesk.statusEmailsPerRequestPerDay above 0). */
const STATUS_EMAILS = config.valuationDesk.statusEmails;

/** Everything the 409A page needs about refreshing its valuation, read once. */
export function useValuationRequests() {
  const { companyId } = useSession();
  const refresh = useQuery<ValuationRefresh>(companyId ? `/c/${companyId}/valuation-refresh` : null, [companyId]);
  const list = useQuery<ValuationRequest[]>(companyId ? `/c/${companyId}/valuation-requests` : null, [companyId]);
  const requests = list.data ?? [];
  return {
    refresh: refresh.data ?? null,
    requests,
    open: requests.find(isOpen) ?? null,
    earlier: requests.filter((r) => !isOpen(r)),
    // Until both have answered, nothing that depends on them is offered: the list
    // empties while it reloads, and for that moment it looks as if nothing is open.
    loaded: refresh.data != null && list.data != null && !list.loading && !refresh.loading,
    error: refresh.error ?? list.error,
    reload: () => { refresh.reload(); list.reload(); },
  };
}

type Requests = ReturnType<typeof useValuationRequests>;

/** The workbook an appraiser calculates from, downloaded by the person asking. */
export function useDataWorkbook() {
  const { companyId } = useSession();
  const toast = useToast();
  return () => downloadFile(`/c/${companyId}/valuation-requests/package.xlsx`, `409a-data-${today()}.xlsx`)
    .catch((err: Error) => toast(err.message, 'error'));
}

// --- The tracker and the history, shared with the team's page --------------------

interface Step { label: string; done: boolean; when: string | null; note?: string }

/** The four steps a request goes through, and how far this one has got. */
export function stepsOf(r: Pick<ValuationRequest, 'status' | 'createdAt' | 'events' | 'deskNotifiedAt' | 'closedAt'>, audience: 'company' | 'desk'): Step[] {
  const first = (kind: RequestEvent['kind']) => r.events.find((e) => e.kind === kind)?.createdAt ?? null;
  const last = (kind: RequestEvent['kind']) => [...r.events].reverse().find((e) => e.kind === kind)?.createdAt ?? null;
  const started = r.status === 'IN_PROGRESS' || r.status === 'DELIVERED' || (r.status === 'COMPLETED' && !!first('IN_PROGRESS'));
  const delivered = r.status === 'DELIVERED' || (r.status === 'COMPLETED' && !!first('DELIVERED'));
  return [
    {
      label: 'Sent', done: true, when: r.createdAt,
      note: audience === 'company' && !r.deskNotifiedAt && r.status === 'REQUESTED' && !r.events.some((e) => e.author === 'desk')
        ? 'Not yet with the team' : undefined,
    },
    { label: 'In progress', done: started, when: first('IN_PROGRESS') },
    { label: 'Report delivered', done: delivered, when: delivered ? last('DELIVERED') : null },
    { label: audience === 'company' ? 'Recorded' : 'Recorded by the company', done: r.status === 'COMPLETED', when: r.status === 'COMPLETED' ? r.closedAt : null },
  ];
}

export function RequestTracker({ steps, cancelled }: { steps: Step[]; cancelled?: boolean }) {
  // A closed request has no next step, whether it was cancelled or recorded, even
  // if it skipped a step on the way (recorded before the team marked it delivered).
  const current = cancelled || steps[steps.length - 1]?.done ? -1 : steps.findIndex((s) => !s.done);
  return (
    <ol className="grid gap-3 sm:grid-cols-4" aria-label="Where the request is">
      {steps.map((s, i) => (
        <li key={s.label} aria-current={i === current ? 'step' : undefined} className="flex items-start gap-2.5">
          <span className={cx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
            s.done ? 'bg-brand-600 text-white' : i === current ? 'bg-white text-brand-700 ring-2 ring-brand-500' : 'bg-ink-100 text-ink-500')}>
            {s.done ? <Icon name="check" className="size-3.5" /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={cx('block text-[13px] font-medium', s.done || i === current ? 'text-ink-900' : 'text-ink-500')}>
              {s.label}<span className="sr-only">{s.done ? ', done' : i === current ? ', next' : ''}</span>
            </span>
            {s.when && <span className="block text-[11px] text-ink-500">{date(s.when.slice(0, 10))}</span>}
            {s.note && <span className="block text-[11px] font-medium text-amber-700">{s.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

const EVENT_LABELS = (e: RequestEvent, previous: RequestEvent[]): string => {
  switch (e.kind) {
    case 'IN_PROGRESS': return previous.some((p) => p.kind === 'DELIVERED') ? 'Back in progress' : 'Started';
    case 'DELIVERED': return 'Report delivered';
    case 'MESSAGE': return 'Note';
    case 'CONTACT_CHANGED': return 'Contact details changed';
    case 'CANCELLED': return e.author === 'desk' ? 'Closed by the team' : 'Cancelled';
    case 'COMPLETED': return '409A recorded';
    default: return e.kind;
  }
};

/** What happened to the request, oldest first, with the team's notes in full. */
export function RequestHistory({ request }: { request: Pick<ValuationRequest, 'createdAt' | 'requestedBy' | 'events'> }) {
  return (
    <ol className="space-y-3 border-l border-ink-200 pl-4">
      <li className="relative">
        <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-ink-300" aria-hidden />
        <p className="text-[13px] text-ink-900"><span className="font-medium">Sent</span> by {request.requestedBy}</p>
        <p className="text-[11px] text-ink-500">{dateTime(request.createdAt)}</p>
      </li>
      {request.events.map((e, i) => (
        <li key={e.id} className="relative">
          <span className={cx('absolute -left-[21px] top-1.5 size-2 rounded-full', e.author === 'desk' ? 'bg-brand-500' : 'bg-ink-300')} aria-hidden />
          <p className="text-[13px] text-ink-900">
            <span className="font-medium">{EVENT_LABELS(e, request.events.slice(0, i))}</span> by {e.authorName}
          </p>
          <p className="text-[11px] text-ink-500">{dateTime(e.createdAt)}</p>
          {e.message && <p className="mt-1 whitespace-pre-line rounded-lg bg-ink-50 px-3 py-2 text-[13px] text-ink-700">{e.message}</p>}
        </li>
      ))}
    </ol>
  );
}

// --- The request form ------------------------------------------------------------

/** Where the answers are kept, said where it can be read before leaving the page to fix the cap table. */
const KEPT = 'Your answers are kept while the app is open, even if you go to another page.';

/** What the form is and what happens after it, said before the first question so nobody starts it with five minutes to spare. */
const WHAT_HAPPENS = `The appraiser’s information request. It takes about ten minutes with the documents to hand; the ${DESK} takes it from there, and you follow each step here${STATUS_EMAILS ? ' and by email' : ''}.`;

/** The form in progress: what was typed, how far it has got, and which steps Next or Send has checked. */
interface Draft {
  form: IntakeForm;
  /**
   * 'fresh' until the dialog first opens and is filled in, 'filled' until the
   * checklist's suggestions have been applied once, then 'ready'. Back to
   * 'fresh' only once a request has been sent, so closing the dialog loses nothing.
   */
  phase: 'fresh' | 'filled' | 'ready';
  step: number;
  furthest: number;
  checked: StepId[];
}

/**
 * The forms in progress, one per person and company, kept outside the page. The
 * form sends people to the cap table to put it right, to check the workbook or
 * add a grant that is missing, and leaving the page unmounts it; kept here, the
 * answers and the documents attached are waiting when they come back. Kept while
 * the app is open in this tab and never written to the browser's storage, since
 * the answers name people and what they are paid. An upload that finishes after
 * the page was left still lands in the form it was chosen for.
 */
const drafts = new Map<string, Draft>();
const draftListeners = new Set<() => void>();
const NO_DRAFT: Draft = { form: blankIntake(), phase: 'fresh', step: 0, furthest: 0, checked: [] };
const subscribeDrafts = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; };
function changeDraft(key: string, fn: (d: Draft) => Partial<Draft>): void {
  const d = drafts.get(key) ?? NO_DRAFT;
  drafts.set(key, { ...d, ...fn(d) });
  for (const listener of draftListeners) listener();
}

/** What the step summary says, on the page and to a screen reader. */
const stillNeeded = (n: number): string => (n === 1 ? 'One answer is still needed on this step.' : `${n} answers are still needed on this step.`);

/** The nearest ancestor that scrolls, so a new step starts at the top of the dialog rather than wherever the last one was left. */
const scrollerOf = (el: HTMLElement | null): HTMLElement | null => {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return null;
};

/**
 * The banner, the open request and the dialog that opens one. The button that
 * starts a request sits in the page header, so the page owns whether the dialog
 * is open and hands that in.
 */
export function ValuationRequestPanel({ data, requesting, setRequesting, onRecordResult, recorded, showReasons = true }: {
  data: Requests;
  /**
   * Whether to show the banner saying why a new 409A is due, with its button. Off
   * when the page has nothing on file, because its empty state already says both.
   */
  showReasons?: boolean;
  requesting: boolean;
  setRequesting: (open: boolean) => void;
  /** Opens the page's Record valuation form for the result of this request. */
  onRecordResult: (request: ValuationRequest) => void;
  /**
   * Active 409As recorded since the open request was made. Any of them can be
   * its answer: one recorded with the plain Record valuation button, or one whose
   * save succeeded when completing the request did not.
   */
  recorded: {
    id: string; effectiveDate: string; provider: string | null;
    /** Micro-cents, to set beside the delivered report's price. */
    fairMarketValue: number;
    /** A valuation with a report of its own keeps it: completing the request files the team's upload only on one with none. */
    reportDocumentId?: string | null; reportUrl?: string | null;
  }[];
}) {
  const { companyId, canEdit, user, role } = useSession();
  const toast = useToast();
  const workbook = useDataWorkbook();
  // Keyed by the person as well as the company, since signing out does not reload the app.
  const draftKey = `${user?.id ?? ''}:${companyId ?? ''}`;
  const draft = useSyncExternalStore(subscribeDrafts, () => drafts.get(draftKey) ?? NO_DRAFT);
  /** The steps Next or Send has checked are `checked`; only their problems are shown. */
  const { form, phase, step, furthest, checked } = draft;
  const change = (fn: (d: Draft) => Partial<Draft>) => changeDraft(draftKey, fn);
  const setForm = (v: IntakeForm | ((f: IntakeForm) => IntakeForm)) => change((d) => ({ form: typeof v === 'function' ? v(d.form) : v }));
  const setPhase = (next: Draft['phase']) => change(() => ({ phase: next }));
  const setStep = (next: number) => change(() => ({ step: next }));
  const setFurthest = (v: number | ((n: number) => number)) => change((d) => ({ furthest: typeof v === 'function' ? v(d.furthest) : v }));
  const setChecked = (v: StepId[] | ((c: StepId[]) => StepId[])) => change((d) => ({ checked: typeof v === 'function' ? v(d.checked) : v }));
  const [attempt, setAttempt] = useState(0);
  /** The step summary as a screen reader is told it: once for each press of Next or Send that finds problems. */
  const [said, setSaid] = useState('');
  const say = (text: string) => setSaid((prev) => (prev === text ? `${text}\u00a0` : text));
  const focusAfter = useRef<'heading' | 'problem' | null>(null);
  /** The item whose vault picker is open. The wizard steps aside meanwhile, so Escape closes one dialog, not both. */
  const [picking, setPicking] = useState<DocumentItem | null>(null);
  const returnTo = useRef<DocumentItem | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState({ contactName: '', contactEmail: '', contactPhone: '', notes: '' });
  const [reading, setReading] = useState<RequestDocument | null>(null);
  const reportOpener = useReportOpener();

  const { refresh, open } = data;
  const due = refresh?.due ?? false;
  const triggers = refresh?.triggers ?? [];

  // Read once the dialog has been opened, and kept while the form is: closing it
  // should not throw away what the vault suggested, and the form after a request
  // has been sent asks for it afresh, the documents just sent included.
  const checklistPath = phase !== 'fresh' && companyId ? `/c/${companyId}/valuation-requests/checklist` : null;
  const checklist = useQuery<Checklist>(checklistPath, [checklistPath]);

  // Filled in the first time the dialog opens, whichever button opened it, and
  // again only after a request has been sent: what was typed survives closing it.
  useEffect(() => {
    if (!requesting || phase !== 'fresh') return;
    // The company's answers carry over from its last request. Contact details carry
    // over only from the reader's own, so nobody sends a request under a colleague's phone number.
    const previous = data.requests.find((r) => r.answers);
    const mine = data.requests.find((r) => r.answers && r.mine);
    const current = data.refresh?.current ?? null;
    setForm({
      ...prefilledIntake(previous?.answers ?? null),
      last409a: current ? 'DATE' : '',
      last409aDate: current?.effectiveDate ?? '',
      contactName: mine?.contactName ?? user?.name ?? '',
      contactEmail: mine?.contactEmail ?? user?.email ?? '',
      contactPhone: mine?.contactPhone ?? '',
    });
    setStep(0);
    setFurthest(0);
    setChecked([]);
    setWhyOpen(false);
    setPhase('filled');
  }, [requesting, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the cap table and the vault already answer goes in once, when it arrives,
  // and never again over what someone has changed since.
  useEffect(() => {
    if (phase !== 'filled' || !checklist.data) return;
    const c = checklist.data;
    setForm((f) => applyChecklist(f, c));
    setPhase('ready');
  }, [phase, checklist.data]);

  // A new step starts at its top with its heading in focus, so a screen reader says
  // where it is; a step with problems puts the cursor in the first one instead.
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (!target) return;
    requestAnimationFrame(() => {
      const root = document.querySelector<HTMLElement>('[data-intake]');
      if (!root) return;
      const first = target === 'problem' ? root.querySelector<HTMLElement>('[data-problem]') : null;
      if (first) {
        first.scrollIntoView({ block: 'center' });
        first.querySelector<HTMLElement>('input, button, textarea')?.focus({ preventScroll: true });
        return;
      }
      scrollerOf(root)?.scrollTo({ top: 0 });
      root.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
    });
  }, [step, attempt]);

  // Back from the vault, the cursor returns to the button that opened it. The picker
  // hands focus back to whatever had it when it opened, but a browser that does not
  // focus a button on click (Safari) leaves nothing to hand back, so it is set here.
  useEffect(() => {
    if (picking || !returnTo.current) return;
    const item = returnTo.current;
    returnTo.current = null;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const button = document.querySelector<HTMLElement>(`[data-intake] [data-item="${item}"] [data-vault]`);
      button?.scrollIntoView({ block: 'center' });
      button?.focus({ preventScroll: true });
    }));
  }, [picking]);

  const problems = problemsOf(form, checklist.data);
  const flagged = new Set(Object.keys(problems).map(stepOf));
  const shown: Problems = Object.fromEntries(Object.entries(problems).filter(([k]) => checked.includes(stepOf(k))));
  const update = (fn: (f: IntakeForm) => IntakeForm) => setForm(fn);
  const questions = questionsOf(form, problems);
  const REQUIRED = questions.length;
  const answered = questions.filter((q) => q.done).length;
  const here = STEPS[step];
  const hereProblems = Object.keys(shown).filter((k) => stepOf(k) === here.id).length;

  const problemsOn = (id: StepId) => Object.keys(problems).filter((k) => stepOf(k) === id).length;
  const go = (i: number) => {
    focusAfter.current = 'heading';
    setSaid('');
    setStep(i);
    setFurthest((n) => Math.max(n, i));
  };
  /**
   * Checks this step and moves on, or shows what is missing here. The cursor goes
   * to the first problem, which is read with its control, and the count follows
   * politely, once, rather than every problem being announced at the same moment.
   */
  const goNext = () => {
    setChecked((c) => (c.includes(here.id) ? c : [...c, here.id]));
    if (flagged.has(here.id)) { focusAfter.current = 'problem'; setAttempt((n) => n + 1); say(stillNeeded(problemsOn(here.id))); return; }
    go(step + 1);
  };
  const closePicker = () => { returnTo.current = picking; setPicking(null); };

  /**
   * Runs one change and says how it went, in words that may depend on the server's
   * answer. Returns whether it worked, so a dialog stays open when it did not.
   */
  const act = async <T,>(fn: () => Promise<T>, message: string | ((answer: T) => string)): Promise<boolean> => {
    setBusy(true);
    try {
      const answer = await fn();
      toast(typeof message === 'string' ? message : message(answer));
      data.reload();
      return true;
    } catch (err) { toast((err as Error).message, 'error'); return false; } finally { setBusy(false); }
  };

  /** Sends what has not gone yet, and says exactly what went: nothing more, and to whom it really went. */
  const send = async (requestId: string, again = false) => {
    type Outcome = 'sent' | 'failed' | 'not needed';
    const res = await api<{ recap: Outcome; recapTo: string | null; recapError: string | null; desk: Outcome; deskError: string | null }>(
      `/c/${companyId}/valuation-requests/${requestId}/send`, { body: again ? { again: true } : {} });
    const recapTo = res.recapTo && res.recapTo !== user?.name ? res.recapTo : 'you';
    const noMail = [res.deskError, res.recapError].filter(Boolean).every((e) => /Mail is not set up/.test(String(e)));
    if (res.desk === 'failed' && res.recap !== 'sent' && noMail) {
      toast('Request saved. Mail is not set up on this server, so nothing was emailed.', 'info');
    } else if (res.desk === 'failed') {
      toast(`Request saved, but it did not reach the ${DESK}. ${res.deskError ?? ''}${res.recap === 'sent' ? ` A recap went to ${recapTo}.` : ''}`, 'error');
    } else if (res.recap === 'failed') {
      toast(`${res.desk === 'sent' ? `Sent to the ${DESK}. ` : ''}The recap email did not go out. ${res.recapError ?? ''}`, 'error');
    } else {
      const parts = [res.desk === 'sent' ? `Sent to the ${DESK}${again ? ' with a new link' : ''}.` : null, res.recap === 'sent' ? `A recap is on its way to ${recapTo}.` : null].filter(Boolean);
      toast(parts.length ? parts.join(' ') : 'Nothing was waiting to be sent.');
    }
  };

  /** Checks every step, opens the first with a problem, and only then saves and sends. */
  const submit = async () => {
    setChecked(STEPS.map((s) => s.id));
    const bad = STEPS.findIndex((s) => flagged.has(s.id));
    if (bad >= 0) {
      focusAfter.current = 'problem';
      setStep(bad);
      setFurthest((n) => Math.max(n, bad));
      setAttempt((n) => n + 1);
      say(stillNeeded(problemsOn(STEPS[bad].id)));
      return;
    }
    setBusy(true);
    try {
      const made = await api<ValuationRequest>(`/c/${companyId}/valuation-requests`, { body: intakeBody(form) });
      setRequesting(false);
      // The next request starts again from the answers this one leaves behind, and
      // from the vault as it now stands, the documents sent this time included.
      change(() => ({ form: blankIntake(), phase: 'fresh' }));
      // Saved first, then sent, so a message that fails leaves a request to retry
      // rather than nothing at all.
      try { await send(made.id); } catch (err) { toast(`Request saved, but it could not be sent: ${(err as Error).message}`, 'error'); }
      data.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const resend = (r: ValuationRequest, again: boolean) => {
    setBusy(true);
    send(r.id, again).catch((err: Error) => toast(err.message, 'error')).finally(() => { setBusy(false); data.reload(); });
  };

  /**
   * Completes the request with a 409A already recorded. It goes with when the
   * request last changed as this page read it, and a refusal because the team has
   * changed it since reads the request again, so the page shows what now stands.
   * Whether the team's report was filed with that 409A is the server's answer.
   */
  const completeWith = (r: ValuationRequest, v: { id: string; effectiveDate: string }) =>
    act(() => api<ValuationRequest & { reportAttached?: boolean }>(`/c/${companyId}/valuation-requests/${r.id}`, {
      method: 'PATCH', body: { status: 'COMPLETED', valuationId: v.id, updatedAt: r.updatedAt },
    }), (done) => (done.reportAttached ? `Request completed, and the report filed with the 409A of ${date(v.effectiveDate)}` : 'Request completed'))
      .then((ok) => { if (!ok) data.reload(); });

  const startEdit = (r: ValuationRequest) => {
    setContact({ contactName: r.contactName ?? '', contactEmail: r.contactEmail ?? '', contactPhone: r.contactPhone ?? '', notes: r.notes ?? '' });
    setEditing(true);
  };
  const contactProblems = contactProblemsOf(contact);
  const [contactTried, setContactTried] = useState(false);
  const saveContact = async () => {
    if (!open) return;
    setContactTried(true);
    if (contactProblems.contactEmail || contactProblems.contactPhone) return;
    const ok = await act(() => api(`/c/${companyId}/valuation-requests/${open.id}`, {
      method: 'PATCH',
      body: { contactName: contact.contactName || null, contactEmail: contact.contactEmail.trim(), contactPhone: contact.contactPhone.trim(), notes: contact.notes || null },
    }), 'Contact details updated');
    // A refused change keeps the dialog and what was typed, so it can be put right.
    if (ok) { setEditing(false); setContactTried(false); }
  };

  const required = triggers.filter((t) => t.severity === 'REQUIRED');
  const canRequest = DESK_ON && canEdit && data.loaded && !open;
  const keyOf = (t: RefreshTrigger & { shareClassName?: string }, i: number) => `${t.reason}-${t.date ?? ''}-${t.shareClassName ?? ''}-${i}`;
  const answer = recorded[0] ?? null;

  // The documents a request sent are the company's own, opened through the vault's
  // usual routes. The vault keeps them from viewers, so a viewer sees their names only.
  const readsVault = ['ADMIN', 'LEGAL', 'BOARD'].includes(role);
  const asReadable = (d: RequestDocument) => ({ id: d.id, name: d.name, fileName: d.fileName, mimeType: d.mimeType, body: d.hasBody ? 'yes' : null });
  const openDocument = (d: RequestDocument) => {
    if (readableDocumentPath(companyId!, asReadable(d))) { setReading(d); return; }
    void downloadFile(downloadDocumentPath(companyId!, asReadable(d)), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));
  };
  const documentAction = (d: RequestDocument) => {
    if (!readsVault) return null;
    const access = documentAccess(companyId!, asReadable(d));
    if (access === 'none') return <span className="shrink-0 text-[12px] text-ink-500">Nothing to open</span>;
    return (
      <Button size="sm" variant="ghost" onClick={() => openDocument(d)} aria-label={`${access === 'read' ? 'Read' : 'Download'} ${d.name}`}>
        {access === 'read' ? 'Read' : 'Download'}
      </Button>
    );
  };

  if (data.error) {
    return <div className="mb-5"><ErrorNote error={data.error} onRetry={data.reload} /></div>;
  }

  const legacy = open && !open.answers;
  const sent = open?.documents ?? [];
  const hiddenSent = open?.documentsHidden ?? 0;
  const delivered = open?.status === 'DELIVERED';
  const reached = !!open && (!!open.deskNotifiedAt || open.events.some((e) => e.author === 'desk'));

  // The one thing to do next, when it is the company's to do. Recording from a
  // delivered report is offered beside the report's values, in the banner, so
  // the button sits with what it records.
  const reviewInBanner = delivered && !answer;
  const main: { label: string; onClick: () => void } | null = !open ? null
    : answer ? { label: `Complete with the 409A of ${date(answer.effectiveDate)}`, onClick: () => void completeWith(open, answer) }
      : legacy ? { label: 'Record the result', onClick: () => onRecordResult(open) }
        : null;
  // What happens next, in a line, so a card with no main button does not look stuck.
  // While the team has the next step, it also says who hears about it by email:
  // the person who asked, who may not be the one reading. Not when nobody does:
  // the emails are off, or that person's role no longer reads this page.
  const emailedAtEachStep = !open?.emailsRequester ? '' : open.mine ? ' You get an email at each step.' : ` ${open.requestedBy} gets an email at each step.`;
  // A colleague's request is theirs to hear about: whoever closes it is named in the email.
  const toldYouClosed = (what: string) => (open && !open.mine && open.emailsRequester ? ` ${open.requestedBy} is emailed that you ${what} it.` : '');
  const next = !open || legacy ? null
    : answer ? null
      : delivered ? 'check the values against the report and record the 409A. This request closes against it.'
        : !reached ? null
          : open.status === 'IN_PROGRESS' ? `the ${open.provider} delivers the report. Nothing to do on your side meanwhile.${emailedAtEachStep}`
            : `the ${open.provider} starts on it and contacts you. Nothing to do on your side meanwhile.${emailedAtEachStep}`;
  const menu: ActionItem[] = !open ? [] : [
    ...(!legacy && !delivered ? [{ label: 'Edit contact details', icon: 'edit' as const, onClick: () => startEdit(open), disabled: busy }] : []),
    // A fresh notice mints a new link and retires the old one, for an email the team lost.
    // With the service turned off, the team is sent nothing.
    ...(DESK_ON && !legacy && reached ? [{ label: 'Send to the team again, with a new link', icon: 'send' as const, onClick: () => resend(open, true), disabled: busy }] : []),
    ...(main?.label !== 'Record the result' && !reviewInBanner
      ? [{ label: answer ? 'Record a different 409A' : 'Record a 409A from another appraiser', icon: 'document' as const, onClick: () => onRecordResult(open), disabled: busy }]
      : []),
  ];

  return (
    <>
      {showReasons && triggers.length > 0 && !open && (
        <div className="mb-5">
          <Banner tone={due ? 'danger' : 'warning'} title={due ? 'A new 409A is due' : 'Worth starting a new 409A'}>
            <ul className="list-disc space-y-1 pl-4">
              {(due ? [...required, ...triggers.filter((t) => t.severity !== 'REQUIRED')] : triggers)
                .map((t, i) => <li key={keyOf(t, i)}>{t.text}</li>)}
            </ul>
            <p className="mt-2 text-[12px] opacity-80">
              This reads the dates and financings on the cap table. It cannot see other changes in the business,
              which the appraiser will ask about.
            </p>
            {canRequest && (
              <div className="mt-3">
                <Button size="sm" variant="primary" onClick={() => setRequesting(true)}>Request a new 409A</Button>
              </div>
            )}
          </Banner>
        </div>
      )}

      {open && (
        <Card className="mb-5">
          {/* One main action at most, and only when the next step is the company's;
              everything else is in the menu. While the team is working there is
              nothing for the company to do, and the line under the title says so. */}
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 sm:flex-1">
              <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold leading-tight text-ink-900">
                {legacy ? `409A requested from ${open.provider}` : `409A request to the ${open.provider}`} <StatusBadge status={open.status} />
              </h3>
              <p className="mt-0.5 text-[13px] text-ink-500">Sent on {date(open.createdAt.slice(0, 10))} by {open.requestedBy}</p>
              {next && <p className="mt-1.5 text-[13px] text-ink-700"><span className="font-medium">Next:</span> {next}</p>}
            </div>
            {canEdit && (
              <div className="flex items-center gap-2 sm:shrink-0">
                {main && (
                  <Button size="sm" variant="primary" disabled={busy} onClick={main.onClick}>{main.label}</Button>
                )}
                {/* Cancelling stays in plain sight: inside the menu, people could not find it. */}
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setCancelling(true)}>Cancel request</Button>
                <ActionMenu label="More actions for this request" items={menu} />
              </div>
            )}
          </div>

          {!legacy && (
            <>
              <RequestTracker steps={stepsOf(open, 'company')} />

              {/* Once the team has done anything, it plainly has the request, whatever the mail said. */}
              {canEdit && !open.deskNotifiedAt && !open.events.some((e) => e.author === 'desk') && (
                <div className="mt-4">
                  <Banner tone="warning" title={`The ${open.provider} has not been told about this request yet`}>
                    <p>The notice with your answers did not go out, so nobody has started on it.{!open.recapSentAt && ' Your recap email did not go out either.'}</p>
                    {DESK_ON ? (
                      <div className="mt-2">
                        <Button size="sm" variant="primary" loading={busy} onClick={() => resend(open, false)}>Send it to the team</Button>
                      </div>
                    ) : (
                      <p className="mt-1">Requests to the team are turned off on this server. Cancel this one, or record a 409A from your own appraiser.</p>
                    )}
                  </Banner>
                </div>
              )}
              {DESK_ON && canEdit && (open.deskNotifiedAt || open.events.some((e) => e.author === 'desk')) && !open.recapSentAt && (
                <p className="mt-3 text-[12px] text-ink-600">
                  Your recap email did not go out.{' '}
                  <button type="button" className="font-medium text-brand-600 hover:text-brand-700" onClick={() => resend(open, false)}>Send it again</button>
                </p>
              )}

              {delivered && (() => {
                // The team's price when it gave one. One only read from the report is
                // nobody's conclusion yet (the delivered email leaves it out for that
                // reason), so it is said as a reading, apart from what the firm found.
                const teamPrice = open.report?.fairMarketValue ?? null;
                const read = open.report?.detected?.readable ? open.report.detected.fairMarketValue ?? null : null;
                const readPrice = teamPrice == null ? read?.value ?? null : null;
                const price = teamPrice ?? readPrice;
                const doc = reportDocumentOf(open.report);
                // A 409A recorded since the request is what the main button completes it
                // with, so where it disagrees with the report, that is said before the press.
                const priceDiffers = !!answer && price != null && answer.fairMarketValue !== price;
                const dateDiffers = !!answer && !!open.reportDate && answer.effectiveDate !== open.reportDate;
                const gives = teamPrice == null ? 'seems to give' : 'gives';
                const disagreement = !answer ? null
                  : priceDiffers && dateDiffers ? `That 409A is at ${pps(answer.fairMarketValue)} per share as of ${date(answer.effectiveDate)}; the report ${gives} ${pps(price)} as of ${date(open.reportDate)}.`
                    : priceDiffers ? `That 409A is at ${pps(answer.fairMarketValue)} per share; the report ${gives} ${pps(price)}.`
                      : dateDiffers ? `That 409A is valued as of ${date(answer.effectiveDate)}; the report as of ${date(open.reportDate)}.`
                        : null;
                const reportFiled = !!answer && !answer.reportDocumentId && !answer.reportUrl;
                return (
                  <div className="mt-4">
                    <Banner tone="success" title="The report is ready">
                      <p>
                        {open.appraiser ?? 'The appraiser'} valued the common stock
                        {teamPrice != null && <> at <strong className="font-semibold">{pps(teamPrice)} per share</strong></>}
                        {open.reportDate ? ` as of ${date(open.reportDate)}` : ''}.
                      </p>
                      {readPrice != null && read && (
                        <p className="mt-1 flex items-start gap-1.5 text-[13px] text-amber-800">
                          <Icon name="alert" className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                          <span className="min-w-0">
                            The report seems to give {pps(readPrice)} per share. That was read from the file, not entered by the team,
                            {read.confidence === 'high' ? ' so nobody has checked it yet.' : ' and the reading is not sure of it.'}
                          </span>
                        </p>
                      )}
                      <p className="mt-1">
                        {answer
                          ? `The 409A of ${date(answer.effectiveDate)} has been recorded since the request was made. Completing the request with it closes the request${reportFiled ? ' and files this report with that 409A' : ''}.`
                          : canEdit
                            ? 'Check the values against the report, then record the 409A: its price then sets strike prices, and this request closes against it.'
                            : 'Once the 409A is recorded from it, its price sets strike prices and this request closes against it.'}
                      </p>
                      {disagreement && (
                        <p className="mt-1 flex items-start gap-1.5 text-[13px] text-amber-800">
                          <Icon name="alert" className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                          <span className="min-w-0">{disagreement}{canEdit ? ' Check which is right before completing.' : ''}</span>
                        </p>
                      )}
                      {((canEdit && !answer) || doc) && (
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                          {canEdit && !answer && (
                            <Button size="sm" variant="primary" disabled={busy} onClick={() => onRecordResult(open)}>Review and record</Button>
                          )}
                          {doc && (reportOpener.canOpen(doc) ? (
                            <button type="button" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700"
                              onClick={() => reportOpener.open(doc)}>
                              <Icon name="document" className="size-4" /> Read the report
                            </button>
                          ) : (
                            <span className="text-[12px] opacity-80">The report is on file. Administrators, legal and the board can open it.</span>
                          ))}
                        </div>
                      )}
                    </Banner>
                  </div>
                );
              })()}

              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <div className="min-w-0">
                  <h4 className="mb-2 text-[13px] font-semibold text-ink-900">What you told the team</h4>
                  <dl className="space-y-1.5 text-[13px]">
                    {open.answerLines.map((l) => (
                      <div key={l.label} className="flex gap-3">
                        <dt className="w-32 shrink-0 text-ink-500 sm:w-44">{l.label}</dt><dd className="min-w-0 text-ink-900">{l.value}</dd>
                      </div>
                    ))}
                    {(open.contactEmail || open.contactName) && (
                      <div className="flex gap-3">
                        <dt className="w-32 shrink-0 text-ink-500 sm:w-44">Contact</dt>
                        <dd className="min-w-0 text-ink-900">
                          {[open.contactName, open.contactEmail, open.contactPhone].filter(Boolean).join(' · ')}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {open.notes && <p className="mt-3 whitespace-pre-line text-[13px] text-ink-700">{open.notes}</p>}
                  {(open.tables ?? []).length > 0 && <div className="mt-4"><AnswerTables tables={open.tables} /></div>}
                  {(sent.length > 0 || hiddenSent > 0) && (
                    <div className="mt-4">
                      <h4 className="mb-2 text-[13px] font-semibold text-ink-900">Documents sent</h4>
                      {sent.length > 0 && <RequestDocumentList documents={sent} action={documentAction} />}
                      {/* The vault keeps some documents from this role, and the list says so rather than pass for everything the team received. */}
                      {hiddenSent > 0 && (
                        <p className="mt-2 text-[12px] text-ink-500">
                          {hiddenSent === 1
                            ? (sent.length ? 'One more document was' : 'One document was')
                            : `${hiddenSent} ${sent.length ? 'more ' : ''}documents were`} sent that only administrators, legal and the board can see.
                        </p>
                      )}
                      {!readsVault && sent.length > 0 && (
                        <p className="mt-2 text-[12px] text-ink-500">Administrators, legal and the board can open these in the vault.</p>
                      )}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <h4 className="mb-2 text-[13px] font-semibold text-ink-900">History</h4>
                  <RequestHistory request={open} />
                </div>
              </div>
            </>
          )}

          {legacy && (
            <p className="text-[13px] text-ink-600">
              This request was made before requests went to the {DESK}. Record the result when it comes back, or cancel it and make a new one.
            </p>
          )}

          {canEdit && answer && (
            <p className="mt-4 text-[12px] text-ink-500">
              A 409A valued as of {date(answer.effectiveDate)}{answer.provider ? ` by ${answer.provider}` : ''} was recorded after this
              request was made. If it is the one that came back, complete the request with it. If not, record the right one from
              the menu.{toldYouClosed('completed')}
            </p>
          )}
        </Card>
      )}

      {/* Stays open under the vault picker: dialogs stack, so the request keeps its place. */}
      <Modal open={requesting && DESK_ON} onClose={() => setRequesting(false)} size="xl"
        title="Request a new 409A" description={WHAT_HAPPENS}
        footer={<>
          <p className="mr-auto hidden self-center text-[12px] text-ink-500 sm:block">{KEPT}</p>
          {step > 0
            ? <Button variant="secondary" onClick={() => go(step - 1)} disabled={busy}>Back</Button>
            : <Button variant="secondary" onClick={() => setRequesting(false)}>Close</Button>}
          {step < STEPS.length - 1
            ? <Button variant="primary" onClick={goNext}>Next</Button>
            : <Button variant="primary" loading={busy} onClick={() => void submit()}>Send to the team</Button>}
        </>}>
        <form data-intake className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); if (step < STEPS.length - 1) goNext(); else void submit(); }}>
          {/* How far along the form is: one answer per required question, on every step. */}
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100" role="progressbar"
              aria-label="Answers given" aria-valuemin={0} aria-valuemax={REQUIRED} aria-valuenow={answered}>
              <div className={cx('h-full rounded-full transition-[width] duration-500 ease-out', answered === REQUIRED ? 'bg-secondary-500' : 'bg-brand-500')}
                style={{ width: `${(answered / REQUIRED) * 100}%` }} />
            </div>
            <span className="shrink-0 text-[12px] tabular text-ink-500">{answered} of {REQUIRED}</span>
          </div>

          {/* The steps, which can be revisited once reached. Each says whether it still needs answers. */}
          <ol className="flex gap-1.5" aria-label="Steps">
            {STEPS.map((s, i) => {
              const current = i === step;
              const needs = checked.includes(s.id) && flagged.has(s.id);
              const done = !flagged.has(s.id) && (checked.includes(s.id) || i < furthest);
              return (
                <li key={s.id} className="min-w-0 flex-1">
                  <button type="button" disabled={i > furthest || current} onClick={() => go(i)} aria-current={current ? 'step' : undefined}
                    className={cx('flex w-full min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center transition-colors sm:flex-row sm:gap-2 sm:px-2 sm:text-left',
                      current ? 'bg-brand-50' : i <= furthest ? 'hover:bg-ink-50' : 'cursor-default')}>
                    <span className={cx('grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                      needs ? 'bg-red-50 text-red-700 ring-2 ring-red-300'
                        : done ? 'bg-brand-600 text-white'
                          : current ? 'bg-white text-brand-700 ring-2 ring-brand-500' : 'bg-ink-100 text-ink-500')}>
                      {needs ? '!' : done ? <Icon name="check" className="size-3.5" /> : i + 1}
                    </span>
                    <span className={cx('sr-only sm:not-sr-only sm:truncate sm:text-[12px] sm:font-medium',
                      current ? 'text-ink-900' : i <= furthest ? 'text-ink-600' : 'text-ink-400')}>
                      {s.title}
                    </span>
                    <span className="sr-only">{needs ? ', needs answers' : done ? ', done' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <section aria-labelledby="intake-step-heading" className="space-y-3 pt-1">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">Step {step + 1} of {STEPS.length}</p>
              <h3 id="intake-step-heading" data-step-heading tabIndex={-1} className="text-[15px] font-semibold text-ink-900 outline-none">
                {here.title}
              </h3>
              <p className="mt-0.5 text-[13px] text-ink-500">{here.intro}</p>
            </div>

            {hereProblems > 0 && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700">{stillNeeded(hereProblems)}</p>
            )}

            {here.id === 'valuation' && triggers.length > 0 && (
              <div className="rise flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900" style={{ animationDelay: '0ms' }}>
                <Icon name="alert" className="mt-px size-4 shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <span className="font-medium">Why now: </span>{triggers[0].text}
                  {triggers.length > 1 && (
                    <>
                      {' '}
                      <button type="button" className="font-medium underline underline-offset-2" onClick={() => setWhyOpen((v) => !v)} aria-expanded={whyOpen}>
                        {whyOpen ? 'Show less' : `+${triggers.length - 1} more`}
                      </button>
                      <Reveal open={whyOpen}>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">{triggers.slice(1).map((t, i) => <li key={keyOf(t, i)}>{t.text}</li>)}</ul>
                      </Reveal>
                    </>
                  )}
                </div>
              </div>
            )}

            {here.id === 'valuation' && (
              <ValuationStep form={form} update={update} problems={problems} shown={shown} fromRecords={data.refresh?.current?.effectiveDate ?? null} />
            )}
            {here.id === 'documents' && (
              <DocumentsStep form={form} update={update} problems={problems} shown={shown}
                checklist={checklist.data} checklistError={checklist.error}
                onChooseVault={setPicking} onDownloadWorkbook={() => void workbook()} />
            )}
            {here.id === 'people' && <PeopleStep form={form} update={update} problems={problems} shown={shown} />}
            {here.id === 'transactions' && <TransactionsStep form={form} update={update} problems={problems} shown={shown} />}
            {here.id === 'contact' && <ContactStep form={form} update={update} problems={problems} shown={shown} />}
          </section>
          {/* On a phone the footer has room for the buttons only, so this goes at the end of the step. */}
          <p className="text-[12px] text-ink-500 sm:hidden">{KEPT}</p>
          <p className="sr-only" role="status">{said}</p>
          <button type="submit" hidden />
        </form>
      </Modal>

      {picking && (() => {
        const v = vaultContext(form, picking);
        return (
          <VaultPicker open onClose={closePicker} purpose={v.label} preferCategory={v.category} exclude={v.attached}
            onPick={(docs) => { const item = picking; update((f) => attach(f, item, docs.map(fromVault))); closePicker(); }} />
        );
      })()}

      <FormModal open={editing} onClose={() => { setEditing(false); setContactTried(false); }} busy={busy} title="Edit contact details"
        submitLabel="Save changes" onSubmit={saveContact}
        description="The team uses these to reach you. Your answers stay as they were sent.">
        <FormGrid>
          <Field label="Your name">
            <Input value={contact.contactName} maxLength={200} onChange={(e) => setContact({ ...contact, contactName: e.target.value })} />
          </Field>
          <Field label="Your email" required error={contactTried ? contactProblems.contactEmail : undefined}>
            <Input type="email" value={contact.contactEmail} onChange={(e) => setContact({ ...contact, contactEmail: e.target.value })} />
          </Field>
          <Field label="Your phone number" required error={contactTried ? contactProblems.contactPhone : undefined}>
            <Input type="tel" value={contact.contactPhone} onChange={(e) => setContact({ ...contact, contactPhone: e.target.value })} />
          </Field>
        </FormGrid>
        <Field label="Notes for the team">
          <Textarea rows={3} value={contact.notes} maxLength={2000} onChange={(e) => setContact({ ...contact, notes: e.target.value })} />
        </Field>
        <p className="text-[12px] text-ink-500">The change shows on the team’s page. Nobody is emailed.</p>
      </FormModal>

      {reportOpener.viewer}

      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        description={reading ? `Sent with the request as: ${reading.itemLabel}` : undefined}
        path={reading ? readableDocumentPath(companyId!, asReadable(reading)) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />

      <ConfirmDialog open={cancelling} onClose={() => setCancelling(false)} loading={busy} danger
        title="Cancel this 409A request" confirmLabel="Cancel the request"
        message={open?.deskNotifiedAt
          ? <>Stop the request to the <strong>{open.provider}</strong>? They are emailed that you cancelled, and their link stops accepting changes.{toldYouClosed('cancelled')}</>
          : <>Stop the request{open ? <> to {open.answers ? 'the ' : ''}<strong>{open.provider}</strong></> : null}?{toldYouClosed('cancelled') || ' Nothing more is sent.'}</>}
        onConfirm={async () => {
          if (open) await act(() => api(`/c/${companyId}/valuation-requests/${open.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } }), 'Request cancelled');
          setCancelling(false);
        }} />
    </>
  );
}

/** For a company that works with its own appraiser: the same workbook the team gets, to send them directly. */
export function OwnAppraiserNote() {
  const { canViewAll } = useSession();
  const workbook = useDataWorkbook();
  if (!canViewAll) return null;
  return (
    <div className="rise mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-ink-300 bg-white/60 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-500"><Icon name="download" className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink-900">Working with your own appraiser?</p>
        <p className="text-[12px] text-ink-500">Send them the data workbook (no holder names), then record their valuation here.</p>
      </div>
      <Button size="sm" variant="secondary" onClick={() => void workbook()}>Download the workbook</Button>
    </div>
  );
}

/** Requests that are finished, with the valuation each one produced. */
export function EarlierValuationRequests({ data }: { data: Requests }) {
  if (data.earlier.length === 0) return null;
  return (
    <Card className="mt-5">
      <CardHeader title="Earlier requests" subtitle="409A valuations asked for, and what came of them" />
      <ul className="divide-y divide-ink-100 text-[13px]">
        {data.earlier.map((r) => {
          const closedByTeam = r.status === 'CANCELLED' ? r.events.find((e) => e.kind === 'CANCELLED' && e.author === 'desk') : null;
          return (
            <li key={r.id} className="py-2.5">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-ink-900">{r.appraiser ?? r.provider}</span>
                <StatusBadge status={r.status} />
                <span className="text-ink-500">Asked for on {date(r.createdAt.slice(0, 10))}</span>
                {r.status === 'COMPLETED' && r.valuationId && (
                  <Link to={`/valuations/${r.valuationId}`} className="font-medium text-brand-600 hover:text-brand-700">
                    Open the valuation it produced
                  </Link>
                )}
              </span>
              {closedByTeam?.message && (
                <p className="mt-1 text-[12px] text-ink-600">Closed by the team: {closedByTeam.message}</p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
