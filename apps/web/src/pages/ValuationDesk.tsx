/**
 * The valuation team's side of a 409A request, reached from the emailed link
 * with no account.
 *
 * Everything needed to start is here: who to call, what the company said in
 * answer to the appraiser's information request, the documents it sent, why a
 * new valuation is due, and the workbook to value it from. The team moves the
 * request along from the same page; the company sees each step on its own, and
 * the person who asked is emailed about each one.
 *
 * Nothing built from the cap table names a holder: the capital structure and the
 * workbook carry share classes, instruments and grants by number and price only.
 * The only names in the answers are the ones the company typed in answer to the
 * appraiser's questions: its management team, the people on below-market
 * salaries, and how the buyer and seller of a secondary sale are described,
 * which the form asks for as a role rather than a name. The documents are the
 * company's own files, sent as they are because the appraiser asked for them,
 * and may name people: a SAFE names its investor.
 *
 * The link's token rides after the #, so no server ever logs it. The page reads
 * it once, keeps it for this tab only, and takes it out of the address bar, so it
 * is not left in the history or passed on with a screenshot of the address.
 * Every file, the documents included, is fetched with the token in a header and
 * saved from memory, for the same reason: no download link ever carries it.
 *
 * The team can upload the report itself when it delivers. The server reads the
 * PDF and the delivery form fills in from what it found, each value with the
 * words it came from, for the team to check and correct. The company sees the
 * same values and records the 409A from them only once someone there has
 * checked them against the report.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Textarea, Loading, ErrorNote, Banner, Spinner, StatusBadge, useToast, cx } from '../ui.tsx';
import { Icon, Logo } from '../icons.tsx';
import { date, dateTime, today, pps, parsePPS } from '../format.ts';
import { RequestTracker, RequestHistory, stepsOf, type RequestEvent } from '../ValuationRequests.tsx';
import { AnswerTables, RequestDocumentList, type AnswerTable, type RequestDocument } from '../ValuationChecklist.tsx';
import { documentFilename } from '../documents.ts';
import { PRODUCT, config } from '../config.ts';
import { ReadNote, nothingRead, priceField, type DeskReport, type ReportDetection } from '../ReportReading.tsx';

interface DeskRequest {
  id: string;
  status: 'REQUESTED' | 'IN_PROGRESS' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED';
  open: boolean;
  deskName: string;
  companyName: string;
  createdAt: string;
  closedAt: string | null;
  appraiser: string | null;
  reportDate: string | null;
  events: RequestEvent[];
  // Only while the request is open.
  requestedBy?: string;
  contact?: { name: string | null; email: string | null; phone: string | null };
  answerLines?: { label: string; value: string }[];
  /** The answers that are lists, in words, and the documents sent with the request. */
  tables?: AnswerTable[];
  documents?: RequestDocument[];
  notes?: string | null;
  situation?: string[];
  /** The report the team uploaded, and what was read from it. Null when none was. */
  report?: DeskReport | null;
}

const TOKEN_KEY = 'ct_desk_token';

/** The token from the link, read once and moved out of the address bar. */
function takeToken(): string | null {
  const fromLink = window.location.hash.replace(/^#/, '');
  if (fromLink) {
    try { sessionStorage.setItem(TOKEN_KEY, fromLink); } catch { /* storage refused: it still works for this visit */ }
    window.history.replaceState(null, '', window.location.pathname);
    return fromLink;
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

class DeskError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The answer to one of the team's calls, or the error it carries. */
async function deskAnswer<T>(res: Response): Promise<T> {
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!res.ok) throw new DeskError(res.status, payload?.error ?? `Request failed (${res.status})`);
  return payload as T;
}

/** Calls the team's API with the link's token and nothing else, whoever this browser is signed in as. */
async function deskApi<T>(token: string, path: string, body?: unknown, method?: 'DELETE'): Promise<T> {
  const res = await fetch(`/api/valuation-desk${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'X-Desk-Token': token },
    credentials: 'omit',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return deskAnswer<T>(res);
}

/**
 * Sends the report as the raw body, as the app's other uploads do. Its name goes
 * in the query string; the token, as everywhere on this page, in a header.
 */
async function deskUpload<T>(token: string, file: File): Promise<T> {
  const res = await fetch(`/api/valuation-desk/report?${new URLSearchParams({ name: file.name })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-Desk-Token': token },
    credentials: 'omit',
    body: file,
  });
  return deskAnswer<T>(res);
}

/** The delivery form's fields. The price is as typed, in dollars; it goes to the server in micro-cents. */
interface Delivery { appraiser: string; reportDate: string; fairMarketValue: string; method: string; message: string }
const blankDelivery = (): Delivery => ({ appraiser: '', reportDate: today(), fairMarketValue: '', method: '', message: '' });

/** The fields a report fills in. */
type ReadField = 'reportDate' | 'fairMarketValue' | 'method';

/**
 * The delivery form with what a report gives put in every field the team has not
 * typed in itself. A field the report has nothing for goes back to how it
 * started, so a replaced report leaves nothing of the one before behind; what
 * the team typed stays whatever is uploaded.
 */
function filledFrom(f: Delivery, d: ReportDetection | null, typed: Partial<Record<ReadField, boolean>>): Delivery {
  const start = blankDelivery();
  const found = d?.readable ? d : null;
  return {
    ...f,
    reportDate: typed.reportDate ? f.reportDate : found?.valuationDate?.value ?? start.reportDate,
    fairMarketValue: typed.fairMarketValue ? f.fairMarketValue : found?.fairMarketValue ? priceField(found.fairMarketValue.value) : start.fairMarketValue,
    method: typed.method ? f.method : found?.method?.value ?? start.method,
  };
}

/** The most a price per share can be, as the server checks it: a million dollars, in micro-cents. */
const MAX_PRICE = 1e12;

/** What is wrong with a typed price, if anything. Empty is fine: the price is optional. */
function priceProblem(typed: string): string | null {
  if (!typed.trim()) return null;
  const micro = parsePPS(typed);
  return micro > 0 && micro <= MAX_PRICE ? null : 'Enter the price for one common share, such as 0.42.';
}

const fileSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/** The most the server takes, limits.uploadMb, checked here first so a large file is not sent only to be refused. */
const MAX_UPLOAD = Math.round(config.limits.uploadMb * 1024 * 1024);

type Pending = null | 'START' | 'DELIVER' | 'REOPEN' | 'NOTE' | 'CLOSE';

/** Whether the person who asked was emailed about a change of status. A note is never emailed, so it is always 'not sent'. */
type Emailed = 'sent' | 'failed' | 'not sent';

/**
 * What the toast adds about that email, so the team knows whether it needs to
 * tell the company itself. Not sent means nobody was: the emails are off, the
 * day's limit was reached, or the person who asked has left the company.
 */
const EMAILED: Record<Emailed, string> = {
  sent: 'The company was emailed.',
  failed: 'The email to the company did not go out.',
  'not sent': 'Nobody was emailed about it.',
};

/** Whether the person who asked is emailed at each step at all (valuationDesk.statusEmailsPerRequestPerDay above 0). */
const STATUS_EMAILS = config.valuationDesk.statusEmails;
/**
 * Whether the team can upload the report at all (valuationDesk.reportUploadsPerRequestPerDay
 * above 0). Off, the page does not offer it, rather than take a large file only to refuse it.
 */
const REPORT_UPLOADS = config.valuationDesk.reportUploads;

type DeskState =
  | { status: 'loading' }
  | { status: 'invalid'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'ready'; request: DeskRequest; loadedAt: string };

export default function ValuationDesk() {
  const toast = useToast();
  const [token, setToken] = useState(takeToken);
  const [state, setState] = useState<DeskState>({ status: 'loading' });
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [deliver, setDeliver] = useState<Delivery>(blankDelivery);
  /** The fields the team has typed in itself, which a report uploaded afterwards leaves alone. */
  const [typed, setTyped] = useState<Partial<Record<ReadField, boolean>>>({});
  /** The report on its way up, or on its way out. */
  const [fileBusy, setFileBusy] = useState<null | 'upload' | 'remove'>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * The control keyboard focus goes to once the panel has changed under it: an
   * upload or a removal, a step taken (started, delivered, back in progress), or a
   * form opened or put away in place of the button that was pressed. The one
   * pressed is gone, and focus would drop to the page.
   */
  const [focusNext, setFocusNext] = useState<string | null>(null);
  useEffect(() => {
    if (!focusNext) return;
    document.getElementById(focusNext)?.focus();
    setFocusNext(null);
  }, [focusNext]);
  const [closeReason, setCloseReason] = useState('');
  const [closing, setClosing] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);
  /**
   * The files being fetched, so each one's button shows a spinner and a second
   * click on it does not fetch it twice. Several can be on their way at once: a
   * document asked for while the ZIP is still being put together is not dropped.
   */
  const [saving, setSaving] = useState<string[]>([]);

  const load = () => {
    if (!token) { setState({ status: 'invalid', message: 'This page opens from the link in the email about a request.' }); return; }
    deskApi<DeskRequest>(token, '')
      .then((request) => setState({ status: 'ready', request, loadedAt: new Date().toISOString() }))
      // Only a 404 means the link is no good. Anything else, a dropped connection
      // or a fault on the server, is worth trying again, and saying the link is
      // dead would send the team to ask for a new one and retire this one.
      .catch((err: DeskError) => setState(err.status === 404
        ? { status: 'invalid', message: err.message }
        : { status: 'failed', message: err.message || 'The request could not be loaded.' }));
  };
  useEffect(load, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another request's link opened in this tab changes only what follows the #, so
  // the page is not reloaded; it switches to that request here instead.
  useEffect(() => {
    const onHash = () => {
      const next = takeToken();
      if (!next || next === token) return;
      setPending(null);
      setError(null);
      setNote('');
      setDeliver(blankDelivery());
      setTyped({});
      setFileBusy(null);
      setFileError(null);
      setCloseReason('');
      setClosing(false);
      setDelivering(false);
      setReopenReason('');
      setReopening(false);
      setState({ status: 'loading' });
      setToken(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [token]);

  const act = async (action: Exclude<Pending, null>, body: Record<string, unknown>, done: string) => {
    if (!token) return;
    const before = state.status === 'ready' ? state.request : null;
    setPending(action);
    setError(null);
    try {
      const { emailed, ...request } = await deskApi<DeskRequest & { emailed: Emailed }>(token, '/status', { action, ...body });
      setState({ status: 'ready', request, loadedAt: new Date().toISOString() });
      // A note is never emailed, and a start pressed on a request already started
      // adds no step, so neither says anything about email.
      const stepped = action !== 'NOTE' && request.events.length > (before?.events.length ?? 0);
      const told = stepped ? EMAILED[emailed] : null;
      // The change stands either way, so an email that did not go is news, not an error.
      toast(told ? `${done}. ${told}` : done, told && emailed !== 'sent' ? 'info' : 'success');
      return true;
    } catch (err) {
      const e = err as DeskError;
      if (e.status === 404) setState({ status: 'invalid', message: e.message });
      else {
        setError(e.message);
        // The request may have changed under the page, closed by the company for
        // instance, so it is read again and shows what now stands.
        if (e.status === 400) load();
      }
      return false;
    } finally {
      setPending(null);
    }
  };

  /** Fetches one of the team's files with the link's token in a header, and saves it under the name given. */
  const save = async (path: string, filename: string, failure: string) => {
    if (!token || saving.includes(path)) return;
    setSaving((s) => [...s, path]);
    try {
      const res = await fetch(`/api/valuation-desk${path}`, { headers: { 'X-Desk-Token': token }, credentials: 'omit' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? failure);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving((s) => s.filter((p) => p !== path));
    }
  };
  const download = () => save('/package.xlsx', `409a-data-${today()}.xlsx`, 'The workbook could not be downloaded.');
  const documentPath = (d: RequestDocument) => `/documents/${encodeURIComponent(d.id)}`;

  /**
   * A failed upload or removal, said beside the upload. Refused because the
   * request moved on, delivered or closed meanwhile, or the upload is already
   * gone, the page reads the request again and shows what now stands; that read
   * is also what finds a link that no longer works, and says so for the whole page.
   */
  const fileFailed = (err: unknown) => {
    const e = err as DeskError;
    setFileError(e.message || 'That did not work. Try again.');
    if (e.status === 400 || e.status === 404 || e.status === 409) load();
  };

  /**
   * Uploads the report and fills the form in from what the server read in it.
   * Checked here first for what the server would refuse anyway, so the team is
   * told at once rather than after sending a large file.
   */
  const upload = async (file: File) => {
    if (!token || fileBusy) return;
    setFileError(null);
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { setFileError('Upload the report as a PDF.'); return; }
    if (file.size > MAX_UPLOAD) {
      setFileError(`That file is ${fileSize(file.size)}. The most this page takes is ${config.limits.uploadMb} MB.`);
      return;
    }
    setFileBusy('upload');
    try {
      const { detected, ...request } = await deskUpload<DeskRequest & { detected?: ReportDetection | null }>(token, file);
      setState({ status: 'ready', request, loadedAt: new Date().toISOString() });
      const read = detected ?? request.report?.detected ?? null;
      setDeliver((f) => filledFrom(f, read, typed));
      setFocusNext('desk-report-replace');
      toast(nothingRead(read) ? 'Report uploaded. No values could be read from it.' : 'Report uploaded and read', nothingRead(read) ? 'info' : 'success');
    } catch (err) {
      fileFailed(err);
    } finally {
      setFileBusy(null);
    }
  };

  /** Takes the upload back before delivering. The fields it filled in go back to how they started. */
  const removeReport = async () => {
    if (!token || fileBusy) return;
    setFileError(null);
    setFileBusy('remove');
    try {
      const answer = await deskApi<DeskRequest | null>(token, '/report', undefined, 'DELETE');
      // Read again here rather than left to load(), so the file has gone from the
      // page by the time focus moves off the Remove button that goes with it.
      const request = answer && Array.isArray(answer.events) ? answer : await deskApi<DeskRequest>(token, '');
      setState({ status: 'ready', request, loadedAt: new Date().toISOString() });
      setDeliver((f) => filledFrom(f, null, typed));
      // Where the team goes next: choosing another PDF, or, with uploads off, the
      // form's first field; with the form closed, opening it.
      setFocusNext(!delivering ? 'desk-deliver-open' : REPORT_UPLOADS ? 'desk-report-choose' : 'desk-appraiser');
      toast('Report removed');
    } catch (err) {
      fileFailed(err);
    } finally {
      setFileBusy(null);
    }
  };

  /**
   * Opens the delivery form, filled in from a report uploaded earlier wherever the
   * team has not typed. The button pressed gives way to the form, so focus goes to
   * the form's first control: the upload, or with uploads off, the firm's name.
   */
  const startDelivering = (detected: ReportDetection | null, uploaded: boolean) => {
    setDeliver((f) => filledFrom(f, detected, typed));
    setFileError(null);
    setDelivering(true);
    setFocusNext(!REPORT_UPLOADS ? 'desk-appraiser' : uploaded ? 'desk-report-replace' : 'desk-report-choose');
  };

  /**
   * Closes the delivery form. A report uploaded stays where the upload put it, in
   * the company's documents, so the team is told rather than left to think Cancel
   * took it back.
   */
  const cancelDelivering = (uploaded: boolean) => {
    setDelivering(false);
    setFileError(null);
    setFocusNext('desk-deliver-open');
    if (uploaded) toast('The report you uploaded stays in the company’s documents until you remove it.', 'info');
  };

  /** A field the report can fill, typed in by the team: from now on an upload leaves it alone. */
  const typeIn = (field: ReadField, value: string) => {
    setDeliver((f) => ({ ...f, [field]: value }));
    setTyped((t) => (t[field] ? t : { ...t, [field]: true }));
  };
  /** A field put back to what the report reads: it follows the report again, a replacement included. */
  const takeRead = (field: ReadField, value: string) => {
    setDeliver((f) => ({ ...f, [field]: value }));
    setTyped((t) => ({ ...t, [field]: false }));
  };

  return (
    <div className="min-h-screen bg-ink-50/60 px-4 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
          <span className="ml-2 text-[13px] text-ink-500">409A requests</span>
        </div>

        {state.status === 'loading' && <Loading label="Opening the request" />}

        {state.status === 'failed' && <ErrorNote error={state.message} onRetry={() => { setState({ status: 'loading' }); load(); }} />}

        {state.status === 'invalid' && (
          <div className="rounded-xl border border-ink-200 bg-white p-8">
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This link does not open a request</h1>
            <p className="mt-2 text-sm text-ink-500">{state.message}</p>
            <p className="mt-2 text-sm text-ink-500">Each new email about a request carries a fresh link and retires the one before it. Use the most recent.</p>
          </div>
        )}

        {state.status === 'ready' && (() => {
          const r = state.request;
          const cancelled = r.status === 'CANCELLED';
          return (
            <div className="space-y-5">
              <section className="rounded-xl border border-ink-200 bg-white p-6 sm:p-8">
                <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">409A request</p>
                <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight text-ink-900">
                  {r.companyName} <StatusBadge status={r.status} />
                </h1>
                <p className="mt-1.5 text-sm text-ink-500">
                  Sent on {date(r.createdAt.slice(0, 10))}{r.requestedBy ? ` by ${r.requestedBy}` : ''}.
                  {!r.open && r.closedAt && ` ${cancelled ? 'Closed' : 'Completed'} on ${date(r.closedAt.slice(0, 10))}.`}
                </p>
                <div className="mt-6">
                  <RequestTracker steps={stepsOf({ ...r, deskNotifiedAt: null }, 'desk')} cancelled={cancelled} />
                </div>
                {r.status === 'DELIVERED' && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p className="min-w-0 flex-1 text-[13px] text-ink-600">
                      Delivered: {r.appraiser}
                      {r.report?.fairMarketValue != null ? `, ${pps(r.report.fairMarketValue)} per common share` : ''}
                      {r.report?.method ? ` (${r.report.method})` : ''}, valued as of {r.reportDate ? date(r.reportDate) : '—'}.
                      The company checks the values against the report and records the 409A to finish.
                    </p>
                    {r.open && r.report?.document && (
                      <Button size="sm" variant="ghost" icon={<Icon name="download" />} loading={saving.includes('/report')}
                        onClick={() => void save('/report', r.report!.document!.fileName ?? `${r.report!.document!.name}.pdf`, 'The report could not be downloaded.')}>
                        Download the report
                      </Button>
                    )}
                  </div>
                )}
                {!r.open && (
                  <div className="mt-5">
                    <Banner tone={cancelled ? 'warning' : 'success'} title={cancelled ? 'This request is closed' : 'The company recorded the 409A'}>
                      Nothing more can be changed here, and the company’s details and data are no longer shown.
                    </Banner>
                  </div>
                )}
              </section>

              {r.open && (
                <div className="grid gap-5 lg:grid-cols-3">
                  <section className="min-w-0 rounded-xl border border-ink-200 bg-white p-6 lg:col-span-2">
                    <h2 className="text-[15px] font-semibold text-ink-900">Contact</h2>
                    <dl className="mt-3 space-y-1 text-[13px]">
                      {r.contact?.name && <div><dt className="sr-only">Name</dt><dd className="font-medium text-ink-900">{r.contact.name}</dd></div>}
                      {r.contact?.email && (
                        <div><dt className="sr-only">Email</dt>
                          <dd><a className="font-medium text-brand-600 hover:text-brand-700" href={`mailto:${r.contact.email}`}>{r.contact.email}</a></dd></div>
                      )}
                      {r.contact?.phone && (
                        <div><dt className="sr-only">Phone</dt>
                          <dd><a className="font-medium text-brand-600 hover:text-brand-700" href={`tel:${r.contact.phone.replace(/[^\d+]/g, '')}`}>{r.contact.phone}</a></dd></div>
                      )}
                    </dl>

                    <h2 className="mt-6 text-[15px] font-semibold text-ink-900">Their answers</h2>
                    <dl className="mt-3 space-y-1.5 text-[13px]">
                      {(r.answerLines ?? []).map((l) => (
                        <div key={l.label} className="flex gap-3">
                          <dt className="w-32 shrink-0 text-ink-500 sm:w-48">{l.label}</dt><dd className="min-w-0 text-ink-900">{l.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {/* Their titles sit under this page's h2s, so they are h3s here. */}
                    {(r.tables ?? []).length > 0 && <div className="mt-5"><AnswerTables tables={r.tables ?? []} level={3} /></div>}
                    {r.notes && (
                      <>
                        <h3 className="mt-4 text-[13px] font-semibold text-ink-900">Notes from the company</h3>
                        <p className="mt-1 whitespace-pre-line text-[13px] text-ink-700">{r.notes}</p>
                      </>
                    )}

                    {(r.documents ?? []).length > 0 && (
                      <>
                        <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
                          <h2 className="text-[15px] font-semibold text-ink-900">Documents</h2>
                          <Button size="sm" icon={<Icon name="download" />} loading={saving.includes('/documents.zip')}
                            onClick={() => void save('/documents.zip', `409a-documents-${today()}.zip`, 'The documents could not be downloaded.')}>
                            Download every document (.zip)
                          </Button>
                        </div>
                        <p className="mt-1 text-[12px] text-ink-500">What the company sent for each item of the information request.</p>
                        <div className="mt-3">
                          <RequestDocumentList documents={r.documents ?? []} level={3} action={(d) => (
                            <Button size="sm" variant="ghost" icon={<Icon name="download" />} loading={saving.includes(documentPath(d))}
                              aria-label={`Download ${d.name}`}
                              onClick={() => void save(documentPath(d), documentFilename(d), 'That document could not be downloaded.')}>
                              Download
                            </Button>
                          )} />
                        </div>
                      </>
                    )}

                    <h2 className="mt-6 text-[15px] font-semibold text-ink-900">The company today</h2>
                    <div className="mt-3 space-y-0.5 text-[13px] leading-relaxed text-ink-700">
                      {(r.situation ?? []).map((line, i) => (
                        line === '' ? <div key={i} className="h-2" />
                          : /^(Why now|The current 409A|Capital structure as of)/.test(line)
                            ? <p key={i} className="pt-1 font-medium text-ink-900">{line}</p>
                            : <p key={i}>{line}</p>
                      ))}
                    </div>
                    <div className="mt-4">
                      <Button icon={<Icon name="download" />} loading={saving.includes('/package.xlsx')} onClick={() => void download()}>Download the data workbook</Button>
                      <p className="mt-1.5 text-[12px] text-ink-500">Share classes, financings, grants and valuation history, with no holder names.</p>
                    </div>
                  </section>

                  <section className="min-w-0 space-y-4 rounded-xl border border-ink-200 bg-white p-6">
                    <div>
                      <h2 className="text-[15px] font-semibold text-ink-900">Move it along</h2>
                      <p className="mt-1 text-[12px] text-ink-500">
                        Each step shows on the company’s 409A page{STATUS_EMAILS ? ' and is emailed to the person who asked' : ''}.
                      </p>
                    </div>
                    {error && <ErrorNote error={error} />}

                    {r.status === 'REQUESTED' && (
                      <Button variant="primary" className="w-full" loading={pending === 'START'}
                        onClick={() => void act('START', {}, 'Marked as started').then((ok) => { if (ok) setFocusNext('desk-deliver-open'); })}>Mark as started</Button>
                    )}

                    {(r.status === 'REQUESTED' || r.status === 'IN_PROGRESS') && (() => {
                      const uploaded = r.report?.document ?? null;
                      // What was read counts only while the file it was read from is still there.
                      const read = uploaded ? r.report?.detected ?? null : null;
                      const found = read?.readable ? read : null;
                      const fmvProblem = priceProblem(deliver.fairMarketValue);
                      // One live region, there from the start, so a screen reader hears each
                      // change of what it says: the upload under way, then what came of it.
                      // With the form closed there are no fields to speak of, only where the file is.
                      const fileStatus = fileBusy === 'upload' ? 'Uploading and reading the report'
                        : fileBusy === 'remove' ? 'Removing the report'
                          : fileError ? ''
                            : !uploaded ? `Optional, up to ${config.limits.uploadMb} MB. It goes straight into the company’s documents, for their administrators, and the fields below fill in from it.`
                              : !delivering ? 'It is in the company’s documents already, for their administrators, and stays there until you remove it.'
                                : nothingRead(read) ? 'We could not read values from this PDF. Enter them below.'
                                  : 'The fields below were filled in from it. Check each one against the report.';
                      const fileWarns = !fileBusy && !!uploaded && delivering && nothingRead(read);
                      // Not a Field: that is a label, and the Replace and Remove buttons cannot sit inside one.
                      // The form and the closed form each show it, never both, so its ids are used once.
                      const uploadGroup = (
                        <div role="group" aria-labelledby="desk-report-upload" aria-busy={!!fileBusy}>
                          <p id="desk-report-upload" className="mb-1.5 text-[13px] font-medium text-ink-700">
                            {delivering ? 'Upload the report (PDF)' : 'The report you uploaded'}
                          </p>
                          <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="sr-only" tabIndex={-1} aria-hidden
                            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
                          {/* The button pressed stays where it is while the file goes up or away, marked busy
                              rather than disabled, so keyboard focus is not dropped from under it. */}
                          {uploaded ? (
                            // The form sits in the page's narrow column, so the buttons go under the name rather than beside it.
                            <div className="rounded-lg border border-ink-200 px-3 pb-1.5 pt-2">
                              <div className="flex items-start gap-2">
                                <Icon name="document" className="mt-0.5 size-4 shrink-0 text-ink-400" />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-[13px] text-ink-900 [overflow-wrap:anywhere]">{uploaded.fileName ?? uploaded.name}</span>
                                  <span className="block text-[11px] text-ink-500">
                                    {[uploaded.sizeBytes ? fileSize(Number(uploaded.sizeBytes)) : null, `uploaded ${date(uploaded.createdAt.slice(0, 10))}`].filter(Boolean).join(' · ')}
                                  </span>
                                </span>
                              </div>
                              <div className="-ml-2 mt-1 flex gap-1 pl-6">
                                {REPORT_UPLOADS && (
                                  <Button id="desk-report-replace" type="button" size="sm" variant="ghost" className="aria-disabled:opacity-70"
                                    aria-disabled={!!fileBusy || undefined} icon={fileBusy === 'upload' ? <Spinner className="size-4" /> : undefined}
                                    onClick={() => { if (!fileBusy) fileInput.current?.click(); }} aria-label="Replace the report">Replace</Button>
                                )}
                                <Button type="button" size="sm" variant="ghost" className="aria-disabled:opacity-70"
                                  aria-disabled={!!fileBusy || undefined} icon={fileBusy === 'remove' ? <Spinner className="size-4" /> : undefined}
                                  onClick={() => void removeReport()} aria-label="Remove the report">Remove</Button>
                              </div>
                            </div>
                          ) : (
                            <Button id="desk-report-choose" type="button" className="aria-disabled:opacity-70" aria-disabled={!!fileBusy || undefined}
                              icon={fileBusy === 'upload' ? <Spinner className="size-4" /> : <Icon name="download" className="size-4 rotate-180" />}
                              onClick={() => { if (!fileBusy) fileInput.current?.click(); }}>
                              Choose the PDF
                            </Button>
                          )}
                          <p role="status" className={cx('mt-1 text-[12px]', fileWarns ? 'text-amber-800' : 'text-ink-500')}>{fileStatus}</p>
                          {fileError && <p role="alert" className="mt-1 text-[12px] text-red-600">{fileError}</p>}
                        </div>
                      );
                      if (!delivering) {
                        return (
                          <div className="space-y-3">
                            {/* The upload is in the company's documents already, form open or not, so it shows
                                here too, with what takes it back out. */}
                            {uploaded && uploadGroup}
                            <Button id="desk-deliver-open" className="w-full" onClick={() => startDelivering(read, !!uploaded)}>Mark the report delivered</Button>
                          </div>
                        );
                      }
                      return (
                        <form className="space-y-3 rounded-lg border border-ink-200 p-3" onSubmit={(e) => {
                          e.preventDefault();
                          if (fmvProblem || fileBusy) return;
                          void act('DELIVER', {
                            appraiser: deliver.appraiser, reportDate: deliver.reportDate,
                            fairMarketValue: deliver.fairMarketValue.trim() ? parsePPS(deliver.fairMarketValue) : null,
                            method: deliver.method.trim() || null,
                            message: deliver.message || null,
                          }, 'Report marked delivered')
                            .then((ok) => { if (ok) { setDelivering(false); setFocusNext('desk-reopen-open'); } });
                        }}>
                          {/* With uploads off on this server it is left out, unless a report was uploaded before, which can still be removed. */}
                          {(REPORT_UPLOADS || uploaded) && uploadGroup}

                          <Field label="Appraisal firm" required hint="The firm that signed the report. It becomes the provider on the company’s 409A.">
                            <Input id="desk-appraiser" value={deliver.appraiser} onChange={(e) => setDeliver({ ...deliver, appraiser: e.target.value })} required />
                          </Field>
                          <div>
                            <Field label="Fair market value per common share" error={fmvProblem}
                              hint={found?.fairMarketValue ? undefined : 'The price the report concludes for one common share. The company checks it before recording.'}>
                              <Input inputMode="decimal" value={deliver.fairMarketValue} placeholder="0.42" autoComplete="off"
                                aria-describedby={found?.fairMarketValue ? 'desk-read-fmv' : undefined}
                                onChange={(e) => typeIn('fairMarketValue', e.target.value)} />
                            </Field>
                            {found?.fairMarketValue && (
                              <ReadNote id="desk-read-fmv" field="fair market value" detected={found.fairMarketValue} shown={pps(found.fairMarketValue.value)}
                                matches={parsePPS(deliver.fairMarketValue) === found.fairMarketValue.value}
                                onUse={() => takeRead('fairMarketValue', priceField(found.fairMarketValue!.value))} />
                            )}
                          </div>
                          <div>
                            <Field label="Valuation date" required hint={found?.valuationDate ? undefined : 'The date the report values the common stock as of.'}>
                              <Input type="date" value={deliver.reportDate} onChange={(e) => typeIn('reportDate', e.target.value)} required
                                aria-describedby={found?.valuationDate ? 'desk-read-date' : undefined} />
                            </Field>
                            {found?.valuationDate && (
                              <ReadNote id="desk-read-date" field="valuation date" detected={found.valuationDate} shown={date(found.valuationDate.value)}
                                matches={deliver.reportDate === found.valuationDate.value}
                                onUse={() => takeRead('reportDate', found.valuationDate!.value)} />
                            )}
                          </div>
                          <div>
                            <Field label="Valuation method" hint={found?.method ? undefined : 'Optional, such as OPM backsolve.'}>
                              <Input value={deliver.method} maxLength={120} placeholder="OPM backsolve" autoComplete="off"
                                aria-describedby={found?.method ? 'desk-read-method' : undefined}
                                onChange={(e) => typeIn('method', e.target.value)} />
                            </Field>
                            {found?.method && (
                              <ReadNote id="desk-read-method" field="method" detected={found.method} shown={found.method.value}
                                matches={deliver.method.trim() === found.method.value}
                                onUse={() => takeRead('method', found.method!.value)} />
                            )}
                          </div>
                          <Field label="Note for the company">
                            <Textarea rows={2} value={deliver.message} maxLength={2000} onChange={(e) => setDeliver({ ...deliver, message: e.target.value })}
                              placeholder={uploaded ? 'Anything the company should know about the report' : 'Such as: the report is in your inbox'} />
                          </Field>
                          <div className="flex gap-2">
                            <Button type="submit" variant="primary" loading={pending === 'DELIVER'}
                              disabled={!deliver.appraiser.trim() || !deliver.reportDate || !!fmvProblem || !!fileBusy}>Mark delivered</Button>
                            <Button type="button" variant="ghost" onClick={() => cancelDelivering(!!uploaded)}>Cancel</Button>
                          </div>
                        </form>
                      );
                    })()}

                    {/* The company is told the delivered report is withdrawn, so it is also told why. */}
                    {r.status === 'DELIVERED' && (
                      reopening ? (
                        <form className="space-y-2 rounded-lg border border-ink-200 p-3" onSubmit={(e) => {
                          e.preventDefault();
                          void act('REOPEN', { message: reopenReason }, 'Back in progress')
                            .then((ok) => { if (ok) { setReopening(false); setReopenReason(''); setFocusNext('desk-deliver-open'); } });
                        }}>
                          <Field label="What changes?" required
                            hint={STATUS_EMAILS ? 'Emailed to the person who asked and shown on the company’s 409A page.' : 'Shown on the company’s 409A page.'}>
                            <Textarea rows={2} value={reopenReason} maxLength={2000} onChange={(e) => setReopenReason(e.target.value)}
                              placeholder="Such as: we are correcting the valuation date" autoFocus />
                          </Field>
                          <div className="flex gap-2">
                            <Button type="submit" size="sm" variant="primary" loading={pending === 'REOPEN'} disabled={!reopenReason.trim()}>Put it back in progress</Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => { setReopening(false); setFocusNext('desk-reopen-open'); }}>Cancel</Button>
                          </div>
                        </form>
                      ) : (
                        <Button id="desk-reopen-open" className="w-full" onClick={() => setReopening(true)}>Put it back in progress</Button>
                      )
                    )}

                    <form className="space-y-2" onSubmit={(e) => {
                      e.preventDefault();
                      void act('NOTE', { message: note }, 'Note added').then((ok) => { if (ok) setNote(''); });
                    }}>
                      <Field label="Add a note for the company"
                        hint="Shown on the company’s 409A page. It is not emailed, so email them for anything they need to act on.">
                        <Textarea rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
                      </Field>
                      <Button type="submit" size="sm" loading={pending === 'NOTE'} disabled={!note.trim()}>Add the note</Button>
                    </form>

                    <div className="border-t border-ink-100 pt-4">
                      {closing ? (
                        <form className="space-y-2" onSubmit={(e) => {
                          e.preventDefault();
                          void act('CLOSE', { message: closeReason }, 'Request closed').then((ok) => { if (ok) setClosing(false); });
                        }}>
                          <Field label="Why is it being closed?" required hint="The company reads this.">
                            <Textarea rows={2} value={closeReason} maxLength={2000} onChange={(e) => setCloseReason(e.target.value)} autoFocus />
                          </Field>
                          <div className="flex gap-2">
                            <Button type="submit" size="sm" variant="danger" loading={pending === 'CLOSE'} disabled={!closeReason.trim()}>Close the request</Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => { setClosing(false); setFocusNext('desk-close-open'); }}>Keep it open</Button>
                          </div>
                        </form>
                      ) : (
                        <button id="desk-close-open" type="button" onClick={() => setClosing(true)}
                          className="text-[13px] font-medium text-red-600 hover:text-red-700">Close without a report</button>
                      )}
                    </div>
                  </section>
                </div>
              )}

              <section className="rounded-xl border border-ink-200 bg-white p-6">
                <h2 className="mb-3 text-[15px] font-semibold text-ink-900">History</h2>
                <RequestHistory request={{ createdAt: r.createdAt, requestedBy: r.requestedBy ?? 'the company', events: r.events }} />
                <p className="mt-4 text-[11px] text-ink-400">
                  Keep this page’s link to yourself: whoever has it can change what the company sees. Last loaded {dateTime(state.loadedAt)}.
                </p>
              </section>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
