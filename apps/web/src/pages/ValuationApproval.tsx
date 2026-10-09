/** Internal review of a 409A request. Viewing this page never approves or sends it. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnswerTables, type AnswerTable, type RequestDocument } from '../ValuationChecklist.tsx';
import { RequestHistory, RequestTracker, stepsOf, type RequestEvent, type RequestSendOutcome, type ValuationRequest } from '../ValuationRequests.tsx';
import { Banner, Button, ErrorNote, Loading, StatusBadge, useToast } from '../ui.tsx';
import { Icon, Logo } from '../icons.tsx';
import { PRODUCT } from '../config.ts';
import { date, dateTime } from '../format.ts';

interface ApprovalRequest {
  id: string;
  companyName: string;
  deskName: string;
  requestedBy?: string;
  createdAt: string;
  closedAt: string | null;
  status: ValuationRequest['status'];
  open: boolean;
  approvalRequired: boolean;
  approvedAt: string | null;
  approvalNotifiedAt: string | null;
  deskNotifiedAt: string | null;
  canApprove: boolean;
  contact?: { name: string | null; email: string | null; phone: string | null };
  answerLines?: { label: string; value: string }[];
  tables?: AnswerTable[];
  documents?: RequestDocument[];
  notes?: string | null;
  situation?: string[];
  events: RequestEvent[];
}

const TOKEN_KEY = 'kosmitor_approval_token';

/** Keep the emailed credential out of request URLs, browser history and referrers. */
function takeToken(): string | null {
  const fromLink = window.location.hash.replace(/^#/, '');
  if (fromLink) {
    try { sessionStorage.setItem(TOKEN_KEY, fromLink); } catch { /* This visit still works without storage. */ }
    window.history.replaceState(null, '', window.location.pathname);
    return fromLink;
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

class ApprovalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function approvalApi<T>(token: string, approve = false, again = false): Promise<T> {
  const response = await fetch(`/api/valuation-approval${approve ? '/approve' : ''}`, {
    method: approve ? 'POST' : 'GET',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Approval-Token': token },
    ...(approve ? { body: JSON.stringify(again ? { again: true } : {}) } : {}),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: 'The server returned an unreadable response. Try again.' }; }
  if (!response.ok) throw new ApprovalError(response.status, payload?.error ?? `Request failed (${response.status})`);
  return payload as T;
}

type State = { status: 'loading' } | { status: 'invalid' | 'failed'; message: string } | { status: 'ready'; request: ApprovalRequest };

export default function ValuationApproval() {
  const [token, setToken] = useState(takeToken);
  const currentToken = useRef(token);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialDelivery, setPartialDelivery] = useState(false);
  const toast = useToast();
  const loadVersion = useRef(0);

  const load = useCallback(() => {
    const version = ++loadVersion.current;
    if (!token) { setState({ status: 'invalid', message: 'Open the review link from the approval email.' }); return; }
    void approvalApi<ApprovalRequest>(token)
      .then((request) => { if (version === loadVersion.current) setState({ status: 'ready', request }); })
      .catch((err: ApprovalError) => {
        if (version !== loadVersion.current) return;
        setState({ status: err.status === 404 ? 'invalid' : 'failed', message: err.message || 'The request could not be loaded.' });
      });
  }, [token]);

  useEffect(() => {
    currentToken.current = token;
    load();
    return () => { ++loadVersion.current; currentToken.current = null; };
  }, [token, load]);

  useEffect(() => {
    const onHash = () => {
      const next = takeToken();
      if (!next || next === token) return;
      currentToken.current = next;
      ++loadVersion.current;
      setBusy(false);
      setError(null);
      setPartialDelivery(false);
      setState({ status: 'loading' });
      setToken(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [token]);

  const approve = async () => {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    ++loadVersion.current;
    try {
      const result = await approvalApi<RequestSendOutcome & { request: ApprovalRequest }>(token, true, partialDelivery);
      if (token !== currentToken.current) return;
      setState({ status: 'ready', request: result.request });
      setPartialDelivery(result.desk === 'partial');
      if (result.desk === 'failed') {
        setError('Approval is recorded, but the evaluator email did not go out. Retry sending it below.');
        toast('Approved. The evaluator email still needs to be sent.', 'info');
      } else if (result.desk === 'partial') {
        setError('Approval is recorded. The notice reached some evaluator recipients, but not all. Retry sending it below.');
        toast('Approved. Some evaluator recipients could not be reached.', 'info');
      } else {
        toast(result.desk === 'sent' ? 'Approved and sent to the evaluator.' : 'This request is already approved and sent.');
      }
    } catch (err) {
      if (token !== currentToken.current) return;
      const failure = err as ApprovalError;
      if (failure.status === 404) setState({ status: 'invalid', message: failure.message });
      else {
        setError(failure.message || 'The request could not be approved. Try again.');
        // A response may be lost after approval succeeded; reread before offering another action.
        load();
      }
    } finally {
      if (token === currentToken.current) setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-50/60 px-4 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
          <span className="ml-2 text-[13px] text-ink-500">409A approval</span>
        </div>
        {state.status === 'loading' && <Loading label="Opening the request" />}
        {state.status === 'failed' && <ErrorNote error={state.message} onRetry={() => { setState({ status: 'loading' }); load(); }} />}
        {state.status === 'invalid' && (
          <section className="rounded-xl border border-ink-200 bg-white p-8">
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This link does not open a request</h1>
            <p className="mt-2 text-sm text-ink-600">{state.message}</p>
            <p className="mt-2 text-sm text-ink-500">Use the most recent approval email. Resending the request replaces the earlier review link.</p>
          </section>
        )}
        {state.status === 'ready' && (() => {
          const r = state.request;
          const pending = r.approvalRequired && !r.approvedAt;
          const retry = !!r.approvedAt && (!r.deskNotifiedAt || partialDelivery);
          return (
            <div className="space-y-5">
              <section className="rounded-xl border border-ink-200 bg-white p-6 sm:p-8">
                <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Internal review</p>
                <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight text-ink-900">
                  {r.companyName} <StatusBadge status={!r.open ? r.status : pending ? 'PENDING_APPROVAL' : r.approvedAt ? 'APPROVED' : r.status} />
                </h1>
                <p className="mt-1.5 text-sm text-ink-500">Submitted on {date(r.createdAt.slice(0, 10))}{r.requestedBy ? ` by ${r.requestedBy}` : ''}.</p>
                <div className="mt-6"><RequestTracker steps={stepsOf(r, 'company')} cancelled={r.status === 'CANCELLED'} /></div>
                <div className="mt-6">
                  {!r.open ? (
                    <Banner tone={r.status === 'COMPLETED' ? 'success' : 'warning'} title="This request is closed">
                      It can no longer be approved or sent to the evaluator.
                    </Banner>
                  ) : pending ? (
                    <Banner tone="info" title="Review before sending to the evaluator">
                      Check the request below. Approving sends the company’s answers, capital structure and attached documents to the {r.deskName}.
                    </Banner>
                  ) : r.approvedAt ? (
                    <Banner tone={retry ? 'warning' : 'success'} title={retry ? 'Approved · evaluator delivery incomplete' : 'Approved and sent to the evaluator'}>
                      Approved on {dateTime(r.approvedAt)}. {retry ? 'Retry the delivery to complete the handoff.' : 'The evaluator can now begin working on this request.'}
                    </Banner>
                  ) : <Banner tone="info" title="No approval needed">This request follows the earlier workflow.</Banner>}
                </div>
                {error && <div className="mt-4" role="alert"><ErrorNote error={error} /></div>}
                {r.open && ((pending && r.canApprove) || retry) && (
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Button variant="primary" loading={busy} icon={<Icon name={retry ? 'send' : 'check'} />} onClick={() => void approve()}>
                      {retry ? 'Retry sending to evaluator' : 'Approve and send to evaluator'}
                    </Button>
                    <p className="text-[12px] text-ink-500">{retry ? 'The approval is already recorded.' : 'Opening this page does not approve the request.'}</p>
                  </div>
                )}
              </section>
              {r.open && (
                <div className="grid gap-5 lg:grid-cols-3">
                  <section className="min-w-0 rounded-xl border border-ink-200 bg-white p-6 lg:col-span-2">
                    <h2 className="text-[15px] font-semibold text-ink-900">Company contact</h2>
                    <p className="mt-3 break-words text-[13px] text-ink-700">{[r.contact?.name, r.contact?.email, r.contact?.phone].filter(Boolean).join(' · ') || 'No contact details provided.'}</p>
                    <h2 className="mt-6 text-[15px] font-semibold text-ink-900">Request details</h2>
                    <dl className="mt-3 space-y-2 text-[13px]">
                      {(r.answerLines ?? []).map((line) => (
                        <div key={line.label} className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
                          <dt className="text-ink-500">{line.label}</dt><dd className="min-w-0 break-words text-ink-900">{line.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {!!r.tables?.length && <div className="mt-5"><AnswerTables tables={r.tables} level={3} /></div>}
                    {r.notes && <><h3 className="mt-5 text-[13px] font-semibold text-ink-900">Notes from the company</h3><p className="mt-1 whitespace-pre-line text-[13px] text-ink-700">{r.notes}</p></>}
                    <h2 className="mt-6 text-[15px] font-semibold text-ink-900">Attached documents</h2>
                    {r.documents?.length ? (
                      <ul className="mt-3 space-y-2">{r.documents.map((document) => (
                        <li key={document.id} className="flex items-start gap-2 text-[13px] text-ink-700"><Icon name="document" className="mt-0.5 size-4 shrink-0 text-ink-400" /><span className="break-words">{document.name}</span></li>
                      ))}</ul>
                    ) : <p className="mt-2 text-[13px] text-ink-500">No documents attached.</p>}
                  </section>
                  <aside className="space-y-5">
                    {!!r.situation?.length && <section className="rounded-xl border border-ink-200 bg-white p-5"><h2 className="text-[15px] font-semibold text-ink-900">Why a valuation is due</h2><ul className="mt-3 list-disc space-y-2 pl-4 text-[13px] text-ink-700">{r.situation.map((reason, i) => <li key={i}>{reason}</li>)}</ul></section>}
                    <section className="rounded-xl border border-ink-200 bg-white p-5"><h2 className="mb-4 text-[15px] font-semibold text-ink-900">History</h2><RequestHistory request={{ createdAt: r.createdAt, requestedBy: r.requestedBy ?? 'the company', events: r.events }} /></section>
                  </aside>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
