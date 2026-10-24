import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './api.ts';
import { useSession } from './session.tsx';
import { Banner, Button } from './ui.tsx';

/** URL parameters identify a checkout to ask the server about; they never establish payment. */
export function useCheckoutReturn({ path, onRefresh, canReconcile, confirmed = false }: {
  path: string | null;
  onRefresh: () => void;
  canReconcile: boolean;
  confirmed?: boolean;
}) {
  const { companyId } = useSession();
  const [params, setParams] = useSearchParams();
  const checkout = params.get('checkout');
  const returnCompany = params.get('company');
  const sessionId = params.get('session_id');
  const requestId = params.get('request_id');
  const [nonce, setNonce] = useState(0);
  const key = `${companyId}:${returnCompany}:${sessionId}:${path}:${nonce}`;
  const [state, setState] = useState<{ key: string; checking: boolean; error: string | null }>({ key: '', checking: false, error: null });
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    if (checkout !== 'success' || !companyId || returnCompany !== companyId || !sessionId || !path || !canReconcile || confirmed) return;
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setState({ key, checking: true, error: null });
    void api(path, { body: { sessionId }, quiet: true }).then(() => {
      if (!active) return;
      setState({ key, checking: false, error: null });
      refresh.current();
      // Delayed payment methods may finish after the redirect. Read the server
      // again without creating another checkout or treating the URL as a receipt.
      for (const delay of [3000, 10000, 20000]) timers.push(setTimeout(() => { if (active) refresh.current(); }, delay));
    }).catch((err: Error) => {
      if (!active) return;
      setState({ key, checking: false, error: err.message });
      refresh.current();
    });
    return () => { active = false; timers.forEach(clearTimeout); };
  }, [checkout, companyId, returnCompany, sessionId, path, canReconcile, confirmed, key]);

  const dismiss = () => {
    const next = new URLSearchParams(params);
    for (const name of ['checkout', 'company', 'session_id', 'request_id']) next.delete(name);
    setParams(next, { replace: true });
  };
  return {
    checkout: checkout === 'success' || checkout === 'cancel' || checkout === 'portal' ? checkout : null,
    returnCompany, sessionId, requestId,
    checking: state.key === key && state.checking,
    error: state.key === key ? state.error : null,
    ready: state.key === key && !state.checking,
    incomplete: checkout === 'success' && (!returnCompany || !sessionId || (returnCompany === companyId && !path)),
    recheck: () => setNonce((value) => value + 1), dismiss,
  };
}

export function CheckoutReturnNotice({ result, confirmed = false, adminOnly = false }: {
  result: ReturnType<typeof useCheckoutReturn>; confirmed?: boolean; adminOnly?: boolean;
}) {
  const { companyId, companies, selectCompany, canEdit, isAdmin } = useSession();
  if (!result.checkout) return null;
  const otherCompany = result.returnCompany && result.returnCompany !== companyId;
  if (otherCompany) {
    const target = companies.find((company) => company.id === result.returnCompany && (adminOnly ? company.role === 'ADMIN' : company.role === 'ADMIN' || company.role === 'LEGAL'));
    return <Banner tone="info" title="This checkout belongs to another company">
      <p>{target ? `Switch to ${target.name} to check its payment status.` : 'Select the company that started this checkout to view its payment status.'}</p>
      {target && <Button size="sm" className="mt-3" onClick={() => selectCompany(target.id)}>Switch company</Button>}
    </Banner>;
  }
  const allowed = adminOnly ? isAdmin : canEdit;
  const problem = result.error ?? (result.incomplete ? 'The checkout return is missing information. Open the saved request or billing page and check its status.' : null);
  const title = confirmed ? 'Payment confirmed'
    : result.checkout === 'portal' ? 'Back from billing settings'
    : result.checkout === 'cancel' ? 'Checkout closed'
      : problem ? 'Payment status could not be confirmed'
        : result.checking || !result.ready ? 'Checking payment status' : 'Checkout status refreshed';
  return <Banner tone={confirmed ? 'success' : problem ? 'warning' : 'info'} title={title}>
    <p>{confirmed ? 'Payment has been confirmed by Stripe. Your request’s current status is shown below.'
      : result.checkout === 'portal' ? 'Your current subscription and payment history are shown below.'
      : result.checkout === 'cancel' ? 'Your current payment status is shown below. You can resume checkout if payment is still needed.'
        : problem ?? (allowed ? 'The confirmed status is shown below. If your payment is still processing, check again shortly.' : 'An administrator or editor can confirm this payment.')}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {!confirmed && result.checkout === 'success' && !result.incomplete && allowed && <Button size="sm" loading={result.checking} onClick={result.recheck}>Check status</Button>}
      <Button size="sm" variant="ghost" onClick={result.dismiss}>Dismiss</Button>
    </div>
  </Banner>;
}
