import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useQuery } from '../api.ts';
import { useSession } from '../session.tsx';
import { Badge, Banner, Button, Card, CardHeader, EmptyState, ErrorNote, Loading, PageHeader, useToast } from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { date, dateTime } from '../format.ts';
import { billingAmount, billingInterval, stripeUrl } from '../billing-format.ts';
import { CheckoutReturnNotice, useCheckoutReturn } from '../BillingCheckout.tsx';

interface BillingPlan { key: string; name: string; amount: number; currency: string; interval: string; intervalCount: number }
interface BillingPayment {
  id: string; kind: 'subscription' | 'valuation'; requestId: string | null;
  status: 'pending' | 'processing' | 'paid' | 'failed' | 'expired' | 'refunded';
  amount: number | null; currency: string; createdAt: string; paidAt: string | null;
  refundedAmount?: number;
}
interface BillingData {
  enabled: boolean; configured: boolean; plans: BillingPlan[];
  valuationPrice: { amount: number; currency: string } | null;
  customerExists: boolean;
  subscription: { status: string; planName: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  payments: BillingPayment[];
  error?: string;
}

const toneOf = (status: string): string => ['active', 'trialing', 'paid'].includes(status) ? 'success'
  : ['past_due', 'unpaid', 'failed'].includes(status) ? 'danger'
    : ['pending', 'processing', 'incomplete'].includes(status) ? 'warning' : 'neutral';

export default function Billing() {
  const { companyId } = useSession();
  return <CompanyBilling key={companyId ?? 'no-company'} />;
}

function CompanyBilling() {
  const { companyId, company, isAdmin, isSample } = useSession();
  const query = useQuery<BillingData>(companyId && isAdmin ? `/c/${companyId}/billing` : null, [companyId, isAdmin]);
  const [pending, setPending] = useState<string | null>(null);
  const currentCompany = useRef(companyId);
  currentCompany.current = companyId;
  const toast = useToast();
  const checkout = useCheckoutReturn({ path: companyId ? `/c/${companyId}/billing/reconcile` : null, onRefresh: query.reload, canReconcile: isAdmin });
  useEffect(() => { setPending(null); }, [companyId]);
  useEffect(() => { currentCompany.current = companyId; return () => { currentCompany.current = null; }; }, [companyId]);

  const openStripe = async (kind: 'checkout' | 'portal', planKey?: string) => {
    if (!companyId || !isAdmin || isSample || pending) return;
    const originCompany = companyId;
    setPending(kind === 'portal' ? 'portal' : `checkout:${planKey}`);
    try {
      const result = await api<{ url: string }>(`/c/${originCompany}/billing/${kind}`, { body: kind === 'portal' ? {} : { planKey } });
      if (currentCompany.current !== originCompany) return;
      window.location.assign(stripeUrl(result.url, window.location.origin));
    } catch (err) {
      if (currentCompany.current === originCompany) toast((err as Error).message, 'error');
    } finally {
      if (currentCompany.current === originCompany) setPending(null);
    }
  };
  const data = query.data;
  const subscription = data?.subscription;
  const hasSubscription = !!subscription && !['canceled', 'incomplete_expired'].includes(subscription.status);
  const available = !!data?.enabled && !!data.configured && !isSample;

  return <>
    <PageHeader title="Billing" subtitle={`Manage ${company?.name ?? 'your company'}’s subscription and 409A payments.`}
      actions={isAdmin && data?.customerExists && <Button icon={<Icon name="external" />} disabled={!data.configured || isSample || !!pending} loading={pending === 'portal'} onClick={() => void openStripe('portal')}>Manage billing</Button>} />
    {checkout.checkout && <div className="mb-5"><CheckoutReturnNotice result={checkout} adminOnly /></div>}
    {!isAdmin ? <EmptyState title="Only administrators can manage billing" />
      : query.loading ? <Loading label="Loading billing" />
        : query.error ? <ErrorNote error={query.error} onRetry={query.reload} />
          : data && <div className="space-y-6">
            {(!data.enabled || !data.configured) && <Banner tone="info" title={data.enabled ? 'Payments are not ready yet' : 'Billing is not enabled'}>
              {data.error ?? 'Checkout will become available when billing is configured. No payment can be started yet.'}
            </Banner>}
            {data.error && data.enabled && data.configured && <ErrorNote error={data.error} onRetry={query.reload} />}
            <Card>
              <CardHeader title="Current subscription" subtitle="Your company’s recurring plan" />
              {subscription ? <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p className="text-xl font-semibold text-ink-900">{subscription.planName}</p><p className="mt-2 text-[13px] text-ink-500">{subscription.currentPeriodEnd ? `${subscription.cancelAtPeriodEnd ? 'Ends' : 'Current period ends'} ${date(subscription.currentPeriodEnd.slice(0, 10))}` : 'Your billing period will appear here once confirmed.'}</p></div>
                <Badge tone={toneOf(subscription.status)} className="capitalize">{subscription.status.replace(/_/g, ' ')}</Badge>
              </div> : <p className="text-sm text-ink-600">No subscription is active. Choose a plan below to continue to Stripe checkout.</p>}
            </Card>
            <section aria-labelledby="billing-plans">
              <div className="mb-4"><h2 id="billing-plans" className="text-base font-semibold text-ink-900">Company plans</h2><p className="mt-1 text-[13px] text-ink-500">Recurring subscriptions. Review the total and payment details on Stripe before subscribing.</p></div>
              {data.plans.length ? <div className={`grid gap-4 md:grid-cols-2 ${data.plans.length >= 3 ? 'xl:grid-cols-3' : ''}`}>
                {data.plans.map((plan) => <Card key={plan.key} className="flex flex-col">
                  <h3 className="text-base font-semibold text-ink-900">{plan.name}</h3>
                  <p className="mt-5 text-[28px] font-semibold tracking-tight text-ink-900">{billingAmount(plan.amount, plan.currency)} <span className="text-[12px] font-medium text-ink-500">{plan.currency.toUpperCase()}</span></p>
                  <p className="mt-1 text-[13px] text-ink-500">{billingInterval(plan.interval, plan.intervalCount)}</p>
                  <Button className="mt-6 w-full" variant={hasSubscription ? 'secondary' : 'primary'} disabled={!available || !!pending || hasSubscription}
                    loading={pending === `checkout:${plan.key}`} onClick={() => void openStripe('checkout', plan.key)}>
                    {hasSubscription ? 'Use billing portal' : 'Choose plan'}
                  </Button>
                </Card>)}
              </div> : <Card><p className="text-[13px] text-ink-500">No subscription plans are available yet.</p></Card>}
              {hasSubscription && <p className="mt-3 text-[13px] text-ink-500">Use Manage billing to change your plan, payment method, or subscription.</p>}
            </section>
            <Card>
              <CardHeader title="409A valuations" subtitle="A separate payment for each valuation request" />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>{data.valuationPrice ? <p className="text-xl font-semibold text-ink-900">{billingAmount(data.valuationPrice.amount, data.valuationPrice.currency)} <span className="text-[13px] font-normal text-ink-500">{data.valuationPrice.currency.toUpperCase()} · one time</span></p> : <p className="text-sm text-ink-600">Valuation pricing is not available yet.</p>}
                  <p className="mt-2 text-[13px] text-ink-500">Payment is completed before internal approval and delivery to the evaluator.</p></div>
                <Link to="/compliance/409a" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700">View valuation requests <Icon name="external" /></Link>
              </div>
            </Card>
            <Card padded={false}>
              <div className="p-5 pb-0"><CardHeader title="Payment history" subtitle="Initial subscriptions and 409A payments. Renewal invoices are available in Manage billing." /></div>
              {data.payments.length ? <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
                <caption className="sr-only">Payment history</caption>
                <thead className="border-y border-ink-100 bg-ink-50 text-[11px] uppercase tracking-wide text-ink-500"><tr><th className="px-5 py-3 font-medium">Payment</th><th className="px-5 py-3 font-medium">Created</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 text-right font-medium">Order amount</th><th className="px-5 py-3 font-medium">Paid on</th></tr></thead>
                <tbody className="divide-y divide-ink-100">{data.payments.map((payment) => <tr key={payment.id}>
                  <td className="px-5 py-3 font-medium text-ink-900">{payment.kind === 'valuation' ? <Link className="text-brand-600 hover:text-brand-700" to="/compliance/409a">409A valuation</Link> : 'Company subscription'}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-ink-600">{dateTime(payment.createdAt)}</td>
                  <td className="px-5 py-3"><Badge tone={(payment.refundedAmount ?? 0) > 0 ? 'neutral' : toneOf(payment.status)} className="capitalize">{(payment.refundedAmount ?? 0) > 0 && payment.status !== 'refunded' ? 'Partially refunded' : payment.status}</Badge></td>
                  <td className="whitespace-nowrap px-5 py-3 text-right tabular text-ink-900">{payment.amount === null ? '—' : billingAmount(payment.amount, payment.currency)} <span className="text-[11px] text-ink-500">{payment.currency.toUpperCase()}</span>
                    {(payment.refundedAmount ?? 0) > 0 && <span className="mt-1 block text-[11px] text-ink-500">{billingAmount(payment.refundedAmount!, payment.currency)} refunded</span>}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-ink-600">{payment.paidAt ? dateTime(payment.paidAt) : '—'}</td>
                </tr>)}</tbody>
              </table></div> : <p className="px-5 pb-5 text-[13px] text-ink-500">No payments yet.</p>}
            </Card>
          </div>}
  </>;
}
