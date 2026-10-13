import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScrollToHash } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import { FormGrid } from '../crud.tsx';
import {
  PageHeader, Card, CardHeader, Button, Input, Field, Select, Loading, ErrorNote, Checkbox,
  EmptyState, useToast, Textarea, KeyValue, Banner,
} from '../ui.tsx';
import { money, date, parseMoney, amountHint } from '../format.ts';
import SignatoriesCard from './settings/SignatoriesCard.tsx';
import { config } from '../config.ts';

const COMPANY = config.company;
/** The stock-based compensation assumptions a company uses until it sets its own (stockComp.defaultAssumptions). */
const STOCK_COMP = config.stockComp.defaultAssumptions;

/** A fraction as a percentage for a form field: 0.6 is "60", with at least `decimals` places. */
function percentText(v: number, decimals = 0): string {
  const n = Math.round(v * 10_000) / 100;
  return n.toFixed(Math.max(decimals, (String(n).split('.')[1] ?? '').length));
}

/** The defaults in a sentence, for the note under the stock-based compensation fields. */
function stockCompDefaults(): string {
  const a = STOCK_COMP;
  return [
    `${percentText(a.volatility)}% volatility`,
    `${percentText(a.riskFreeRate)}% risk-free`,
    a.dividendYield ? `${percentText(a.dividendYield)}% dividend yield` : null,
    a.expectedTermYears == null ? 'simplified term' : `${a.expectedTermYears}-year term`,
    a.attribution === 'GRADED' ? 'graded' : 'straight-line',
    a.forfeiturePolicy === 'AS_OCCUR' ? 'forfeitures as they occur' : `forfeitures estimated at ${percentText(a.forfeitureRate)}% a year`,
    a.standard === 'GAAP' ? null : 'IFRS 2',
  ].filter(Boolean).join(', ');
}

/** One page for the company: its legal identity, the people who act for it, and how this workspace behaves. */
export default function Company() {
  const { companyId, isAdmin, refresh } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any>(companyId ? `/c/${companyId}` : null, [companyId]);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deletingCompany, setDeletingCompany] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!data) return;
    setForm({
      name: data.name ?? '', legalName: data.legalName ?? '', entityType: data.entityType ?? COMPANY.entityType,
      jurisdiction: data.jurisdiction ?? '', incorporationDate: data.incorporationDate ?? '',
      fiscalYearEnd: data.fiscalYearEnd ?? COMPANY.fiscalYearEnd, ein: data.ein ?? '', address: data.address ?? '',
      website: data.website ?? '', totalAssets: data.totalAssetsCents ? String(data.totalAssetsCents / 100) : '',
      exerciseRequestsEnabled: data.exerciseRequestsEnabled == null ? COMPANY.exerciseRequests : Number(data.exerciseRequestsEnabled) === 1, paymentInstructions: data.paymentInstructions ?? '',
      certificateTerms: data.certificateTerms ?? '',
      portal: (() => { const defaults = { ...COMPANY.portal }; try { return { ...defaults, ...(data.portalSettings ? JSON.parse(data.portalSettings) : {}) }; } catch { return defaults; } })(),
      accounting: (() => {
        let a: any = {};
        try { a = data.accountingAssumptions ? JSON.parse(data.accountingAssumptions) : {}; } catch { a = {}; }
        const pct = (v: unknown) => (v == null || v === '' ? '' : String(Number(v) * 100));
        return { volatility: pct(a.volatility), riskFreeRate: pct(a.riskFreeRate), dividendYield: pct(a.dividendYield), forfeitureRate: pct(a.forfeitureRate),
          expectedTermYears: a.expectedTermYears == null ? '' : String(a.expectedTermYears), attribution: a.attribution ?? STOCK_COMP.attribution,
          forfeiturePolicy: a.forfeiturePolicy ?? STOCK_COMP.forfeiturePolicy, standard: a.standard ?? STOCK_COMP.standard, set: !!data.accountingAssumptions };
      })(),
    });
  }, [data]);
  useScrollToHash(!!data); // /company#portal and friends, from the search palette

  if (!isAdmin) return <EmptyState title="Only administrators can open the company page" />;
  if (loading || !form) return <Loading label="Loading the company" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  const save = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}`, {
        method: 'PATCH',
        body: {
          name: form.name, legalName: form.legalName || null, entityType: form.entityType,
          jurisdiction: form.jurisdiction || null, incorporationDate: form.incorporationDate || null,
          fiscalYearEnd: form.fiscalYearEnd, ein: form.ein || null, address: form.address || null,
          website: form.website || null, totalAssetsCents: parseMoney(form.totalAssets || '0'),
          exerciseRequestsEnabled: form.exerciseRequestsEnabled, paymentInstructions: form.paymentInstructions || null, portalSettings: form.portal, certificateTerms: form.certificateTerms || null,
          accountingAssumptions: (() => {
            const c = form.accounting;
            const frac = (v: string) => (v === '' ? null : Number(String(v).replace(/[%\s]/g, '')) / 100);
            const any = [c.volatility, c.riskFreeRate, c.dividendYield, c.forfeitureRate, c.expectedTermYears].some((v) => v !== '') || c.set;
            if (!any) return null;
            return {
              volatility: frac(c.volatility), riskFreeRate: frac(c.riskFreeRate), dividendYield: frac(c.dividendYield), forfeitureRate: frac(c.forfeitureRate),
              expectedTermYears: c.expectedTermYears === '' ? null : Number(c.expectedTermYears),
              attribution: c.attribution, forfeiturePolicy: c.forfeiturePolicy, standard: c.standard,
            };
          })(),
        },
      });
      toast('Changes saved');
      reload();
      await refresh();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader concept="company-settings" title="Company" subtitle="Legal identity, the people who act for the company, and how this workspace behaves"
        actions={<Button variant="primary" onClick={save} loading={busy}>Save changes</Button>} />

      <div className="grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-5 lg:col-span-2">
          <Card id="company">
            <CardHeader title="Company details" />
            <div className="space-y-4">
              <FormGrid>
                <Field label="Display name" required>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="Legal name">
                  <Input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                    placeholder={`Northstar Robotics${COMPANY.legalNameSuffix}`} />
                </Field>
                <Field label="Entity type">
                  <Select value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
                    <option value="C_CORP">C corporation</option>
                    <option value="S_CORP">S corporation</option>
                    <option value="LLC">Limited liability company</option>
                    <option value="LTD">Limited company</option>
                  </Select>
                </Field>
                <Field label="Jurisdiction">
                  <Input value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} placeholder={COMPANY.jurisdiction} />
                </Field>
                <Field label="Incorporation date">
                  <Input type="date" value={form.incorporationDate} onChange={(e) => setForm({ ...form, incorporationDate: e.target.value })} />
                </Field>
                <Field label="Fiscal year end">
                  <Input value={form.fiscalYearEnd} onChange={(e) => setForm({ ...form, fiscalYearEnd: e.target.value })} placeholder={COMPANY.fiscalYearEnd} />
                </Field>
                <Field label="Employer identification number">
                  <Input value={form.ein} onChange={(e) => setForm({ ...form, ein: e.target.value })} placeholder="12-3456789" />
                </Field>
                <Field label="Website">
                  <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="company.com" />
                </Field>
              </FormGrid>
              <Field label="Registered address">
                <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} />
              </Field>
            </div>
          </Card>

          <div id="signatories" className="scroll-mt-16"><SignatoriesCard /></div>

          <Card id="compliance">
            <CardHeader title="Compliance inputs"
              subtitle="Figures the automated checks rely on" />
            <Field label="Total assets"
              hint="Used for the Rule 701 test, which permits grants up to the greater of $1,000,000, 15% of total assets, or 15% of the outstanding class.">
              <Input value={form.totalAssets} onChange={(e) => setForm({ ...form, totalAssets: e.target.value })}
                placeholder={amountHint(14_800_000)} />
            </Field>
            {!form.totalAssets && (
              <div className="mt-4">
                <Banner tone="info">
                  Without a total assets figure the Rule 701 test falls back to the $1,000,000 cash limit,
                  which understates your real headroom.
                </Banner>
              </div>
            )}
          </Card>

          <Card id="certificates">
            <CardHeader title="Certificates" subtitle="Terms printed on every certificate issued from the platform" />
            <Field label="Certificate terms" hint="Transfer restrictions, right of first refusal, drag-along — printed under the standard legend. Each share class can add its own legend on the Share classes page.">
              <Textarea value={form.certificateTerms} onChange={(e) => setForm({ ...form, certificateTerms: e.target.value })} rows={4}
                placeholder="The shares may not be transferred without first offering them to the Company under the right of first refusal in the bylaws…" />
            </Field>
          </Card>

          <Card id="portal">
            <CardHeader title="Stakeholder portal" subtitle="What holders see on My equity" />
            <div className="space-y-2">
              <Checkbox label="Show ownership percentage and the company's fully diluted share count" checked={form.portal.showOwnership} onChange={(v) => setForm({ ...form, portal: { ...form.portal, showOwnership: v } })} />
              <Checkbox label="Show values at the current 409A fair market value" hint="Hides the fair market value, position value and intrinsic value of options." checked={form.portal.showValuation} onChange={(v) => setForm({ ...form, portal: { ...form.portal, showValuation: v } })} />
              <Checkbox label="Show the exit-value model" checked={form.portal.showExitModel} onChange={(v) => setForm({ ...form, portal: { ...form.portal, showExitModel: v } })} />
              <Checkbox label="Show company documents" hint="Documents awaiting the holder's signature always show." checked={form.portal.showDocuments} onChange={(v) => setForm({ ...form, portal: { ...form.portal, showDocuments: v } })} />
              <Checkbox label="Show company updates" checked={form.portal.showUpdates} onChange={(v) => setForm({ ...form, portal: { ...form.portal, showUpdates: v } })} />
            </div>
          </Card>

          <Card id="exercise-requests">
            <CardHeader title="Exercise requests" subtitle="Let option holders ask to exercise from My equity" />
            <Checkbox label="Accept exercise requests from holders" checked={form.exerciseRequestsEnabled}
              hint="Requests land on Equity grants for review; nothing is recorded until you complete them."
              onChange={(v) => setForm({ ...form, exerciseRequestsEnabled: v })} />
            <div className="mt-4">
              <Field label="Payment instructions" hint="Shown to the holder once a request is approved — bank and wire details, who to notify, deadlines.">
                <Textarea value={form.paymentInstructions} onChange={(e) => setForm({ ...form, paymentInstructions: e.target.value })} rows={4}
                  placeholder={'Wire the exercise price to…\nReference: your name and grant number'} />
              </Field>
            </div>
          </Card>

          <Card id="stock-comp">
            <CardHeader title="Stock-based compensation" subtitle="Assumptions behind the ASC 718 / IFRS 2 expense report" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Expected volatility (%)" hint="From comparable public companies; early-stage companies commonly use 50–80%.">
                <Input value={form.accounting.volatility} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, volatility: e.target.value } })} placeholder={percentText(STOCK_COMP.volatility)} />
              </Field>
              <Field label="Risk-free rate (%)" hint="US Treasury yield matching the expected term at grant.">
                <Input value={form.accounting.riskFreeRate} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, riskFreeRate: e.target.value } })} placeholder={percentText(STOCK_COMP.riskFreeRate, 1)} />
              </Field>
              <Field label="Dividend yield (%)">
                <Input value={form.accounting.dividendYield} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, dividendYield: e.target.value } })} placeholder={percentText(STOCK_COMP.dividendYield)} />
              </Field>
              <Field label="Expected term (years)" hint="Leave empty for the SAB 107 simplified method, tranche by tranche.">
                <Input value={form.accounting.expectedTermYears} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, expectedTermYears: e.target.value } })}
                  placeholder={STOCK_COMP.expectedTermYears == null ? 'Simplified' : String(STOCK_COMP.expectedTermYears)} />
              </Field>
              <Field label="Attribution">
                <Select value={form.accounting.attribution} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, attribution: e.target.value } })}>
                  <option value="GRADED">Graded (each tranche over its own period)</option>
                  <option value="STRAIGHT_LINE">Straight-line over the total service period</option>
                </Select>
              </Field>
              <Field label="Reporting standard">
                <Select value={form.accounting.standard} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, standard: e.target.value } })}>
                  <option value="GAAP">US GAAP — ASC 718</option>
                  <option value="IFRS">IFRS 2 (graded attribution)</option>
                </Select>
              </Field>
              <Field label="Forfeitures">
                <Select value={form.accounting.forfeiturePolicy} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, forfeiturePolicy: e.target.value } })}>
                  <option value="AS_OCCUR">Account for as they occur</option>
                  <option value="ESTIMATE">Estimate an annual rate</option>
                </Select>
              </Field>
              {form.accounting.forfeiturePolicy === 'ESTIMATE' && (
                <Field label="Annual forfeiture rate (%)">
                  <Input value={form.accounting.forfeitureRate} onChange={(e) => setForm({ ...form, accounting: { ...form.accounting, forfeitureRate: e.target.value } })} placeholder={percentText(STOCK_COMP.forfeitureRate)} />
                </Field>
              )}
            </div>
            <p className="mt-4 text-[12px] leading-relaxed text-ink-500">
              Leave every field empty to use the defaults ({stockCompDefaults()}). The report shows which is in use.
            </p>
          </Card>
        </div>

        <div className="space-y-5">

          {config.billing.enabled && <BillingCard companyId={companyId!} status={data.billingStatus} periodEnd={data.billingPeriodEnd} />}

          <Card>
            <CardHeader title="Summary" />
            <KeyValue columns={1} items={[
              { label: 'Legal name', value: data.legalName ?? '—' },
              { label: 'Jurisdiction', value: data.jurisdiction ?? '—' },
              { label: 'Incorporated', value: data.incorporationDate ? date(data.incorporationDate) : '—' },
              { label: 'Total assets', value: data.totalAssetsCents ? money(data.totalAssetsCents, { compact: true }) : 'Not set' },
              { label: 'Your role', value: data.role },
            ]} />
          </Card>

          <Card id="delete">
            <CardHeader title="Delete this company" subtitle="Removes the cap table, documents, ledger and audit trail for good" />
            <p className="text-[12px] leading-relaxed text-ink-500">Only administrators can do this, and only for this company. Members lose access at once; other companies are untouched. There is no undo.</p>
            <div className="mt-3">
              <Field label={`Type “${data.name}” to confirm`}>
                <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={data.name} />
              </Field>
            </div>
            <Button className="mt-3" variant="primary" disabled={confirmName.trim() !== String(data.name).trim()} loading={deletingCompany}
              onClick={async () => {
                setDeletingCompany(true);
                try {
                  await api(`/c/${companyId}?confirm=${encodeURIComponent(confirmName.trim())}`, { method: 'DELETE' });
                  toast('Company deleted');
                  localStorage.removeItem('kosmitor_company');
                  await refresh();
                  navigate('/', { replace: true });
                } catch (err) { toast((err as Error).message, 'error'); } finally { setDeletingCompany(false); }
              }}>
              Delete {data.name}
            </Button>
          </Card>
        </div>
      </div>
    </>
  );
}

const BILLING_STATUS: Record<string, string> = {
  active: 'Active', trialing: 'Trial', past_due: 'Payment overdue', unpaid: 'Unpaid', incomplete: 'Awaiting payment',
  incomplete_expired: 'Checkout expired', canceled: 'Canceled', paused: 'Paused',
};
/** Statuses in which the company has a subscription to manage rather than start (LIVE in routes/billing.ts). */
const LIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

/** The company's subscription: start it in Stripe Checkout, or manage it in Stripe's portal. */
function BillingCard({ companyId, status, periodEnd }: { companyId: string; status: string | null; periodEnd: string | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const live = !!status && LIVE.includes(status);
  const justPaid = new URLSearchParams(window.location.search).get('billing') === 'done';
  const go = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/c/${companyId}/billing/${live ? 'portal' : 'checkout'}`, { method: 'POST' });
      window.location.assign(url);
    } catch (err) { toast((err as Error).message, 'error'); setBusy(false); }
  };
  return (
    <Card id="billing">
      <CardHeader title="Billing" subtitle="Your subscription, invoices and payment method" />
      {justPaid && !live && <div className="mb-3"><Banner tone="success">Thanks! Your payment is being confirmed; this updates in a moment.</Banner></div>}
      <KeyValue columns={1} items={[
        { label: 'Status', value: status ? BILLING_STATUS[status] ?? status : 'No subscription' },
        ...(live && periodEnd ? [{ label: status === 'trialing' ? 'Trial ends' : 'Renews', value: date(periodEnd) }] : []),
      ]} />
      <Button className="mt-3" variant={live ? 'secondary' : 'primary'} loading={busy} onClick={go}>
        {live ? 'Manage billing' : 'Subscribe'}
      </Button>
    </Card>
  );
}
