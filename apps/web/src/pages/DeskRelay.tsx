/**
 * The two emailed links of a 409A request a self-hosted server sent here
 * (apps/server/src/routes/desk-relay.ts): #confirm.<token>, where its contact
 * confirms the request, and #team.<token>, where the approval team approves or
 * declines it once paid. Opening either page decides nothing by itself.
 */
import { useEffect, useState } from 'react';
import { AnswerTables, type AnswerTable } from '../ValuationChecklist.tsx';
import { Banner, Button, ErrorNote, Loading } from '../ui.tsx';
import { Logo } from '../icons.tsx';
import { PRODUCT } from '../config.ts';
import { date, dateTime } from '../format.ts';

interface TeamView {
  status: 'UNCONFIRMED' | 'CONFIRMED' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';
  companyName: string; requestedBy: string; instanceUrl: string | null;
  contact: { name: string | null; email: string; phone: string };
  createdAt: string; confirmedAt: string | null; decidedAt: string | null;
  answerLines: { label: string; value: string }[]; tables: AnswerTable[];
  documents: { itemLabel: string; name: string }[]; notes: string | null; reasons: string[];
}

/** The link's kind and token, taken out of the address bar so they stay out of history. */
function takeLink(): { kind: string; token: string } {
  const [kind = '', token = ''] = window.location.hash.replace(/^#/, '').split('.');
  if (token) {
    try { sessionStorage.setItem('kosmitor_relay_link', `${kind}.${token}`); } catch { /* this visit still works */ }
    window.history.replaceState(null, '', window.location.pathname);
    return { kind, token };
  }
  try {
    const [k = '', t = ''] = (sessionStorage.getItem('kosmitor_relay_link') ?? '').split('.');
    return { kind: k, token: t };
  } catch { return { kind: '', token: '' }; }
}

async function call<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/409a-relay${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error ?? `Request failed (${res.status})`);
  return payload as T;
}

export default function DeskRelay() {
  const [link] = useState(takeLink);
  return (
    <div className="min-h-screen bg-ink-50/60 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
          <span className="ml-2 text-[13px] text-ink-500">409A request</span>
        </div>
        {link.kind === 'confirm' ? <Confirm token={link.token} />
          : link.kind === 'team' ? <Team token={link.token} />
            : <ErrorNote error="Open the link from the email." />}
      </div>
    </div>
  );
}

function Confirm({ token }: { token: string }) {
  const [done, setDone] = useState<{ companyName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try { setDone(await call('/confirm', token, { token })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="rounded-xl border border-ink-200 bg-white p-8">
      {done ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Thanks, your request is confirmed</h1>
          <p className="mt-2 text-sm text-ink-600">Our team reviews the 409A request for {done.companyName} and writes to you with the price and the next steps.</p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Confirm your 409A request</h1>
          <p className="mt-2 text-sm text-ink-600">Confirm that you asked for this 409A, and our team reviews it and writes to you.</p>
          {error && <div className="mt-4"><ErrorNote error={error} /></div>}
          <Button className="mt-6" variant="primary" loading={busy} onClick={() => void confirm()}>Confirm the request</Button>
        </>
      )}
    </section>
  );
}

function Team({ token }: { token: string }) {
  const [view, setView] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<TeamView>('/team', token).then(setView, (err: Error) => setError(err.message)); }, [token]);
  const decide = async (decision: 'APPROVED' | 'DECLINED') => {
    setBusy(true);
    setError(null);
    try { setView(await call<TeamView>('/team/decide', token, { decision })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (!view) return error ? <ErrorNote error={error} /> : <Loading label="Opening the request" />;
  const r = view;
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-ink-200 bg-white p-6 sm:p-8">
        <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Self-hosted request · internal review</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-900">{r.companyName}</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          Submitted on {date(r.createdAt.slice(0, 10))} by {r.requestedBy}{r.instanceUrl ? ` from ${r.instanceUrl}` : ''}. Email confirmed {dateTime(r.confirmedAt)}.
        </p>
        <div className="mt-6">
          {r.status === 'CONFIRMED' ? (
            <Banner tone="info" title="Approve once it is paid">
              Write to the contact with the price and a payment link. Approving tells their server the request is accepted; declining closes it there.
            </Banner>
          ) : (
            <Banner tone={r.status === 'APPROVED' ? 'success' : 'warning'}
              title={r.status === 'APPROVED' ? 'Approved' : r.status === 'WITHDRAWN' ? 'Withdrawn by the company' : 'Declined'}>
              {r.status === 'WITHDRAWN' ? 'The company cancelled it, or sent it again with new contact details,' : 'Decided'} on {dateTime(r.decidedAt)}.
            </Banner>
          )}
        </div>
        {error && <div className="mt-4" role="alert"><ErrorNote error={error} /></div>}
        {r.status === 'CONFIRMED' && (
          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="primary" loading={busy} onClick={() => void decide('APPROVED')}>Approve</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void decide('DECLINED')}>Decline</Button>
          </div>
        )}
      </section>
      <section className="rounded-xl border border-ink-200 bg-white p-6">
        <h2 className="text-[15px] font-semibold text-ink-900">Contact</h2>
        <p className="mt-3 break-words text-[13px] text-ink-700">{[r.contact.name, r.contact.email, r.contact.phone].filter(Boolean).join(' · ')}</p>
        <h2 className="mt-6 text-[15px] font-semibold text-ink-900">Request details</h2>
        <dl className="mt-3 space-y-2 text-[13px]">
          {r.answerLines.map((line) => (
            <div key={line.label} className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
              <dt className="text-ink-500">{line.label}</dt><dd className="min-w-0 break-words text-ink-900">{line.value}</dd>
            </div>
          ))}
        </dl>
        {r.tables.length > 0 && <div className="mt-5"><AnswerTables tables={r.tables} level={3} /></div>}
        {r.notes && <><h3 className="mt-5 text-[13px] font-semibold text-ink-900">Notes from the company</h3><p className="mt-1 whitespace-pre-line text-[13px] text-ink-700">{r.notes}</p></>}
        {r.reasons.length > 0 && <><h3 className="mt-5 text-[13px] font-semibold text-ink-900">Why now</h3><ul className="mt-1 list-disc space-y-1 pl-4 text-[13px] text-ink-700">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
        <h3 className="mt-5 text-[13px] font-semibold text-ink-900">Documents they will send</h3>
        {r.documents.length ? (
          <ul className="mt-1 space-y-1 text-[13px] text-ink-700">{r.documents.map((d, i) => <li key={i}>{d.itemLabel}: {d.name}</li>)}</ul>
        ) : <p className="mt-1 text-[13px] text-ink-500">None listed.</p>}
      </section>
    </div>
  );
}
