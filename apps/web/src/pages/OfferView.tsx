import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api.ts';
import { Button, Input, Field, Textarea, ErrorNote, Loading, KeyValue, Banner } from '../ui.tsx';
import { Logo } from '../icons.tsx';
import { date } from '../format.ts';
import { PRODUCT } from '../config.ts';

interface PublicOffer {
  status: string; expired: boolean; company: { name: string; legalName: string }; candidateName: string; position: string;
  startDate: string | null; salary: string | null; equity: { quantity: string; awardTypeName: string; strikePrice: string | null; vestingSchedule: string | null; planName: string | null };
  body: string; expiresOn: string | null; acceptedAt: string | null; acceptedName: string | null; declinedAt: string | null;
}

/** The candidate's side of an offer letter: read it, then accept with a typed name or decline. Reached from the emailed link, signed out. */
export default function OfferView() {
  const { pathname } = useLocation();
  const token = decodeURIComponent(pathname.split('/')[2] ?? '');
  const [state, setState] = useState<{ status: 'loading' } | { status: 'invalid' } | { status: 'ready'; offer: PublicOffer }>({ status: 'loading' });
  const [typedName, setTypedName] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<PublicOffer>(`/offers/${encodeURIComponent(token)}`)
    .then((offer) => setState({ status: 'ready', offer }))
    .catch(() => setState({ status: 'invalid' }));
  useEffect(() => { if (!token) setState({ status: 'invalid' }); else void load(); }, [token]);  // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: 'accept' | 'decline') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/offers/${encodeURIComponent(token)}/${action}`, { body: action === 'accept' ? { typedName } : { reason: reason || null } });
      await load();
      setDeclining(false);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-ink-50/60 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
        </div>

        {state.status === 'loading' && <Loading label="Opening your offer" />}

        {state.status === 'invalid' && (
          <div className="rounded-xl border border-ink-200 bg-white p-8">
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This offer link is not valid</h1>
            <p className="mt-2 text-sm text-ink-500">The link may have been mistyped or the offer withdrawn. Ask the company for a fresh link.</p>
          </div>
        )}

        {state.status === 'ready' && (() => {
          const o = state.offer;
          const open = o.status === 'SENT' && !o.expired;
          return (
            <div className="space-y-5">
              <div className="rounded-xl border border-ink-200 bg-white p-8">
                <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">{o.company.name}</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-900">Your offer, {o.candidateName}</h1>
                <p className="mt-1.5 text-sm text-ink-500">
                  {open && o.expiresOn && <>Please answer by <span className="font-medium text-ink-700">{date(o.expiresOn)}</span>.</>}
                  {o.status === 'ACCEPTED' && <>You accepted on {date(String(o.acceptedAt).slice(0, 10))} as “{o.acceptedName}”. The company will be in touch about your paperwork.</>}
                  {o.status === 'CONVERTED' && <>You accepted this offer; your equity grant has been prepared by the company.</>}
                  {o.status === 'DECLINED' && <>You declined this offer on {date(String(o.declinedAt).slice(0, 10))}.</>}
                  {o.status === 'WITHDRAWN' && <>The company has withdrawn this offer.</>}
                  {o.status === 'SENT' && o.expired && <>This offer expired on {date(o.expiresOn!)}. Contact the company if you would still like to accept.</>}
                </p>
                <div className="mt-6 rounded-lg bg-ink-50 p-4">
                  <KeyValue columns={3} items={[
                    { label: 'Position', value: o.position },
                    { label: 'Start date', value: o.startDate ? date(o.startDate) : 'To be agreed' },
                    { label: 'Base salary', value: o.salary ?? '—' },
                    { label: 'Equity', value: `${o.equity.quantity} ${o.equity.awardTypeName}s` },
                    { label: o.equity.strikePrice ? 'Indicative exercise price' : 'Exercise price', value: o.equity.strikePrice ?? 'Set at grant (fair market value)' },
                    { label: 'Vesting', value: o.equity.vestingSchedule ?? '—' },
                  ]} />
                </div>
              </div>

              <div className="rounded-xl border border-ink-200 bg-white p-8">
                <div className="whitespace-pre-wrap font-serif text-[14px] leading-relaxed text-ink-800">{o.body}</div>
              </div>

              {open && (
                <div className="rounded-xl border border-ink-200 bg-white p-8">
                  {error && <div className="mb-4"><ErrorNote error={error} /></div>}
                  {!declining ? (
                    <form onSubmit={(e) => { e.preventDefault(); void act('accept'); }} className="space-y-4">
                      <h2 className="text-lg font-semibold text-ink-900">Accept this offer</h2>
                      <p className="text-sm text-ink-500">Typing your full name below is your electronic signature. The company is notified at once, and the equity is granted under its plan once the board has approved it.</p>
                      <Field label="Type your full name" required hint={o.candidateName}>
                        <Input value={typedName} onChange={(e) => setTypedName(e.target.value)} className="font-[cursive] text-lg" required />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" variant="primary" size="lg" loading={busy}>Accept the offer</Button>
                        <Button type="button" size="lg" onClick={() => setDeclining(true)}>Decline instead</Button>
                      </div>
                    </form>
                  ) : (
                    <form onSubmit={(e) => { e.preventDefault(); void act('decline'); }} className="space-y-4">
                      <h2 className="text-lg font-semibold text-ink-900">Decline this offer</h2>
                      <Field label="Anything you would like the company to know" hint="Optional.">
                        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" variant="primary" size="lg" loading={busy}>Decline the offer</Button>
                        <Button type="button" size="lg" onClick={() => setDeclining(false)}>Back</Button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {o.status === 'ACCEPTED' && (
                <Banner tone="success" title="Accepted">Thank you. Keep this page for your records; the company will send your equity documents to sign separately.</Banner>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
