import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from './api.ts';
import type { ValuationRefresh } from './ValuationRequests.tsx';
import { FormGrid } from './crud.tsx';
import { Avatar, Badge, Banner, Button, Checkbox, Field, Input, Modal, Select, Textarea, useToast } from './ui.tsx';
import { Icon } from './icons.tsx';
import { date, fieldNumber, money, parsePPS, parseShares, percent, pps, shares, today } from './format.ts';
import { ownershipForShares, sharesForOwnership } from './issuance-ownership.ts';

interface IssuanceForm {
  certificateNo: string; stakeholderId: string; shareClassId: string; quantity: string;
  pricePerShare: string; issueDate: string; vestingScheduleId: string; vestingStartDate: string;
  earlyExercised: boolean; election83bFiledOn: string; boardApprovalDate: string; notes: string;
  effectiveDate: string; reason: string;
}

interface Signer { name: string; title: string; message: string; templateId: string }
interface Stakeholder { id: string; name: string; email?: string | null }
interface ShareClass { id: string; name: string; kind: 'COMMON' | 'PREFERRED'; conversionRatio: number; issueDate: string }
interface Schedule { id: string; name: string }
interface Template { id: string; name: string; kind: string; builtIn: boolean; isDefault: boolean }
interface OwnershipCapTable { table: { asOf: string; totals: { fullyDiluted: number } } }

function Section({ number, title, description, children }: {
  number: number; title: string; description?: string; children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-200/80 bg-white shadow-[0_2px_6px_rgba(16,24,40,0.025)]">
      <div className="flex items-start gap-3 border-b border-ink-100 px-4 py-4 sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[12px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-100">{String(number).padStart(2, '0')}</span>
        <div>
          <h3 className="text-[14px] font-semibold text-ink-900">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{description}</p>}
        </div>
      </div>
      <div className="space-y-4 p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-ink-800">{children}</dd>
    </div>
  );
}

/** A new issuance uses the same save routes as the certificate list and keeps corrections in its existing editor. */
export function IssueShares({ companyId, form, setForm, stakeholders, classes, schedules,
  forSignature, setForSignature, signer, setSigner, busy, onClose, onSubmit, onVestingScheduleChange,
  schedulesLoading, schedulesError, onRetrySchedules,
}: {
  companyId: string; form: IssuanceForm; setForm: (form: IssuanceForm) => void;
  stakeholders: Stakeholder[]; classes: ShareClass[]; schedules: Schedule[];
  forSignature: boolean; setForSignature: (value: boolean) => void;
  signer: Signer; setSigner: (signer: Signer) => void;
  busy: boolean; onClose: () => void; onSubmit: (form: IssuanceForm) => Promise<void>;
  onVestingScheduleChange: (scheduleId: string) => void;
  schedulesLoading: boolean; schedulesError: string | null; onRetrySchedules: () => void;
}) {
  const formId = useId();
  const formElement = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const [useBoardDate, setUseBoardDate] = useState(true);
  const [amountMode, setAmountMode] = useState<'shares' | 'ownership'>('shares');
  const [targetOwnership, setTargetOwnership] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setError(''); }, [form, targetOwnership]);
  useEffect(() => {
    // The shared modal focuses the first text input. Here that skips the selectors
    // and can scroll the valuation warning away before the user has seen it.
    formElement.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus({ preventScroll: true });
    formElement.current?.parentElement?.scrollTo({ top: 0 });
  }, []);
  // This is today's on-file status, not a historical pricing opinion about the issue date.
  // The server accounts for expiration and material events as well as missing reports.
  const valuation = useQuery<ValuationRefresh>(`/c/${companyId}/valuation-refresh`, [companyId]);
  const templates = useQuery<{ templates: Template[] }>(`/c/${companyId}/templates`, [companyId]);
  useEffect(() => {
    window.addEventListener('focus', valuation.reload);
    return () => window.removeEventListener('focus', valuation.reload);
  }, [valuation.reload]);
  const current = valuation.data?.current;
  const missingValuation = !!valuation.data && !current;
  const outdatedValuation = !!current && valuation.data?.due;
  const holder = stakeholders.find((s) => s.id === form.stakeholderId);
  const shareClass = classes.find((c) => c.id === form.shareClassId);
  const schedule = schedules.find((s) => s.id === form.vestingScheduleId);
  const price = parsePPS(form.pricePerShare);
  const issueDate = useBoardDate ? form.boardApprovalDate : form.issueDate;
  const ownershipDate = issueDate || today();
  const capTable = useQuery<OwnershipCapTable>(
    `/c/${companyId}/captable?asOf=${encodeURIComponent(ownershipDate)}&includeConvertibles=false&includePool=true`, [companyId],
  );
  // Both the existing capitalization and the new shares are in the issue date's
  // units. A preferred share contributes its common-equivalent conversion ratio.
  const basis = !capTable.loading && capTable.data?.table.asOf === ownershipDate ? capTable.data.table.totals.fullyDiluted : null;
  const conversionRatio = shareClass?.kind === 'PREFERRED' ? shareClass.conversionRatio : 1;
  const ownershipUnavailable = capTable.error ? 'The ownership estimate is unavailable. Enter shares directly or retry.'
    : basis === null ? 'Loading the cap table for the ownership estimate…'
      : !shareClass ? 'Select a share class to calculate target ownership.'
        : shareClass.issueDate > ownershipDate ? `Choose an issue date on or after ${date(shareClass.issueDate)} to calculate ownership for this class.`
          : basis === 0 ? 'The cap table is empty. Enter a share count directly; this issuance will represent 100%.'
            : !Number.isFinite(basis) || basis < 0 || !Number.isFinite(conversionRatio) || conversionRatio <= 0
              ? 'Ownership cannot be calculated for this share class. Enter shares directly.' : '';
  const targetQuantity = !ownershipUnavailable && basis !== null
    ? sharesForOwnership(Number(targetOwnership), basis, conversionRatio) : null;
  // Derive the quantity rather than saving a stale calculation while a new date
  // or share class is loading. Submit the same quantity the form and summary show.
  const quantityInput = amountMode === 'ownership' ? (targetQuantity === null ? '' : fieldNumber(targetQuantity)) : form.quantity;
  const quantity = parseShares(quantityInput);
  const ownership = basis !== null && shareClass && shareClass.issueDate <= ownershipDate
    ? ownershipForShares(quantity, basis, conversionRatio) : null;
  const ownershipInput = amountMode === 'ownership' ? targetOwnership
    : ownership === null ? '' : String(Number(ownership.toFixed(6)));
  const ownershipError = amountMode === 'ownership' && targetOwnership && !ownershipUnavailable
    ? Number(targetOwnership) <= 0 || Number(targetOwnership) >= 100 || !Number.isFinite(Number(targetOwnership))
      ? 'Enter a percentage greater than 0 and less than 100.'
      : targetQuantity === null ? 'Choose a target that produces at least one share and a supported share count.' : null
    : null;
  const invalidTarget = amountMode === 'ownership' && targetQuantity === null;
  const submitLabel = forSignature ? 'Issue & send for signature' : 'Record issuance';
  const valuationLink = (
    <Link to="/compliance/409a" target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">
      Go to 409A valuations <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span>
    </Link>
  );

  const submit = () => {
    if (busy || valuation.loading || schedulesLoading || schedulesError) return;
    const problem = !holder || !shareClass ? 'Select a recipient and share class.'
      : invalidTarget ? ownershipUnavailable || ownershipError || 'Enter a target ownership percentage.'
        : quantity < 1 ? 'Enter at least one share.'
          : !issueDate ? 'Choose an issue date.' : '';
    if (problem) { setError(problem); toast(problem, 'error'); return; }
    setError('');
    void onSubmit({ ...form, quantity: quantityInput, issueDate });
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} size="xl" bodyClassName="bg-ink-50/70 px-4 py-5 sm:px-6 sm:py-6"
      title={<span className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100"><Icon name="certificate" className="size-6" /></span>
        <span><span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-600">New certificate</span><span className="block text-[20px] font-semibold tracking-tight">Issue shares</span></span>
      </span>}
      description="Set the terms for your stakeholder. Review the summary before issuing."
      footer={<>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <span className="mr-auto hidden items-center gap-1.5 text-[12px] text-ink-500 lg:inline-flex"><Icon name="document" />{forSignature ? 'Prepared for electronic signature' : 'Record signed paperwork'}</span>
          <Button disabled={busy} onClick={onClose} className="h-10">Cancel</Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={valuation.loading || invalidTarget || schedulesLoading || !!schedulesError}
            icon={<Icon name={forSignature ? 'send' : 'check'} />} className="h-10 shadow-sm">{submitLabel}</Button>
        </div>
      </>}>
      <form ref={formElement} id={formId} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset disabled={busy} className="min-w-0">
          <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_16rem] lg:gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 space-y-4">
              <div aria-live="polite">
                {valuation.loading ? <p className="text-[12px] text-ink-500">Checking your 409A valuation…</p>
                  : valuation.error ? (
                    <Banner tone="warning" title="Could not check your 409A valuation">
                      <p className="text-[12px]">Your valuation status is unavailable. Review your records before issuing.</p>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
                        <Button type="button" size="sm" onClick={valuation.reload}>Retry valuation check</Button>{valuationLink}
                      </div>
                    </Banner>
                  ) : missingValuation || outdatedValuation ? (
                    <Banner tone="warning" title={<span className="flex items-center gap-2"><Icon name="alert" className="size-4 shrink-0" />{missingValuation ? 'No current 409A valuation on file' : 'Your 409A valuation needs updating'}</span>}>
                      <p className="text-[12px]">{missingValuation
                        ? 'No active 409A valuation is recorded for your company. Add or request a valuation to reference when reviewing your share price.'
                        : valuation.data?.triggers.filter((t) => t.severity === 'REQUIRED').map((t) => t.text).join(' ')}</p>
                      <p className="mt-1 text-[12px]">You can continue recording this share issuance.</p>
                      <div className="mt-2 text-[12px]">{valuationLink}</div>
                    </Banner>
                  ) : current ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-secondary-200 bg-secondary-50 px-4 py-3 text-[12px] text-secondary-900">
                      <span className="inline-flex items-center gap-2"><Icon name="shield" />409A on file · {date(current.effectiveDate)}</span>
                      {valuationLink}
                    </div>
                  ) : null}
              </div>

              <Section number={1} title="Recipient & share class" description="Choose who will receive the shares.">
                <Field label="Share class" required>
                  <Select value={form.shareClassId} required onChange={(e) => setForm({ ...form, shareClassId: e.target.value })}>
                    <option value="">Select a class</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Recipient" required>
                  <Select value={form.stakeholderId} required onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })}>
                    <option value="">Select a stakeholder</option>
                    {stakeholders.map((s) => <option key={s.id} value={s.id}>{s.name}{s.email ? ` (${s.email})` : ''}</option>)}
                  </Select>
                </Field>
              </Section>

              <Section number={2} title="Share amount" description="Enter shares or a target ownership percentage.">
                <FormGrid>
                  <Field label="Number of shares" required>
                    <Input value={quantityInput} required inputMode="decimal" pattern="[0-9]+(,[0-9]{3})*([.][0-9]+)?"
                      title="Enter a positive share count, such as 50,000." placeholder="50,000" className="h-11 text-[15px] font-medium tabular"
                      onChange={(e) => { setAmountMode('shares'); setForm({ ...form, quantity: e.target.value }); }} />
                  </Field>
                  <Field label="Target ownership (%)" error={ownershipError}>
                    <Input type="number" min="0" max="100" step="any" inputMode="decimal" placeholder="1.00" className="h-11 text-[15px] font-medium tabular"
                      value={ownershipInput} disabled={!!ownershipUnavailable} required={amountMode === 'ownership'}
                      onChange={(e) => { setAmountMode('ownership'); setTargetOwnership(e.target.value); }} />
                  </Field>
                </FormGrid>
                <div className="rounded-lg bg-ink-50 px-3.5 py-3 text-[12px] leading-relaxed text-ink-500">
                  {ownershipUnavailable ? <p>{ownershipUnavailable}</p> : <>
                    <p className="flex items-start gap-2"><Icon name="calculator" className="mt-0.5 size-4 shrink-0 text-ink-400" /><span>This issuance only, on a fully diluted basis after issuance.{ownership !== null && amountMode === 'ownership' ? ` Estimated ownership: ${percent(ownership / 100, 4)}.` : ''}</span></p>
                    <details className="mt-2 pl-6">
                      <summary className="w-fit cursor-pointer font-medium text-ink-600 hover:text-brand-700">How ownership is calculated</summary>
                      <p className="mt-2">Based on {shares(basis)} fully diluted shares as of {date(ownershipDate)}, including the option pool and excluding unconverted SAFEs, notes, and pending issuances. The recipient’s existing holdings are not part of this target. Percentage targets round to the nearest whole share.</p>
                    </details>
                  </>}
                  {capTable.error && <Button type="button" size="sm" onClick={capTable.reload}>Retry ownership estimate</Button>}
                </div>
              </Section>

              <Section number={3} title="Issue date" description="Use the board approval date or choose a different date.">
                <div className={`rounded-lg border p-3.5 ${useBoardDate ? 'border-brand-200 bg-brand-50/40' : 'border-ink-200 bg-ink-50/60'}`}>
                  <Checkbox label="Use the board approval date as the issue date" checked={useBoardDate}
                    hint="Turn this off to enter a different issue date."
                    onChange={(value) => {
                      setUseBoardDate(value);
                      if (value) setForm({ ...form, issueDate: form.boardApprovalDate || today() });
                    }} />
                </div>
                <FormGrid columns={useBoardDate ? 1 : 2}>
                  <Field label="Board approval date" required={useBoardDate} hint="From the consent or minutes approving this issuance.">
                    <Input type="date" value={form.boardApprovalDate} required={useBoardDate}
                      onChange={(e) => setForm({ ...form, boardApprovalDate: e.target.value, ...(useBoardDate ? { issueDate: e.target.value } : {}) })} />
                  </Field>
                  {!useBoardDate && <Field label="Issue date" required>
                    <Input type="date" value={form.issueDate} required onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
                  </Field>}
                </FormGrid>
                {!form.boardApprovalDate && <p className="flex items-start gap-2 text-[12px] text-amber-800">
                  <Icon name="alert" className="mt-0.5 size-4 shrink-0" />No board approval date is recorded for this issuance.
                </p>}
              </Section>

              <Section number={4} title="Vesting schedule" description="Choose when the recipient’s shares vest.">
                <Field label="Vesting schedule" hint={schedulesLoading ? 'Loading vesting schedules…' : undefined}>
                  <Select value={form.vestingScheduleId} disabled={schedulesLoading || !!schedulesError} onChange={(e) => onVestingScheduleChange(e.target.value)}>
                    <option value="">{schedulesLoading ? 'Loading schedules…' : 'Not subject to vesting'}</option>
                    {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                {schedulesError && <Banner tone="warning" title="Vesting schedules could not be loaded">
                  <Button type="button" size="sm" onClick={onRetrySchedules}>Retry vesting schedules</Button>
                </Banner>}
                {form.vestingScheduleId && <Field label="Vesting start date" hint="Defaults to the issue date when left empty.">
                  <Input type="date" value={form.vestingStartDate} onChange={(e) => setForm({ ...form, vestingStartDate: e.target.value })} />
                </Field>}
              </Section>

              <Section number={5} title="Purchase price" description="Record the agreed price for this share class.">
                <Field label="Price per share" required>
                  <Input type="number" min="0" step="0.000001" required value={form.pricePerShare}
                    onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })} />
                </Field>
                <div className="flex items-center justify-between rounded-lg border border-brand-100 bg-brand-50/50 px-4 py-3 text-[13px]">
                  <span className="text-ink-600">Total purchase price</span>
                  <span className="font-semibold tabular text-ink-900">{quantityInput && form.pricePerShare !== '' ? money(Math.round(quantity * price / 1e4)) : '—'}</span>
                </div>
              </Section>

              <Section number={6} title="Certificate & signatures" description="Choose the certificate and how it will be signed.">
                <Checkbox label="Send the certificate for electronic signature" checked={forSignature} onChange={setForSignature}
                  hint="The holder signs in My equity and the Company countersigns. Shares become outstanding after both have signed." />
                {forSignature ? <>
                  <Field label="Certificate template">
                    <Select value={signer.templateId} onChange={(e) => setSigner({ ...signer, templateId: e.target.value })}>
                      <option value="">Company default certificate</option>
                      {(templates.data?.templates ?? []).filter((t) => t.kind === 'CERTIFICATE').map((t) => (
                        <option key={t.id} value={t.id}>{t.name}{t.builtIn ? ' (built-in)' : t.isDefault ? ' — default' : ''}</option>
                      ))}
                    </Select>
                  </Field>
                  {templates.error && <p className="text-[12px] text-amber-800">Templates could not be loaded. The company default will be used.</p>}
                  <FormGrid>
                    <Field label="Company signatory" required>
                      <Input value={signer.name} required onChange={(e) => setSigner({ ...signer, name: e.target.value })} />
                    </Field>
                    <Field label="Signatory title" required>
                      <Input value={signer.title} required onChange={(e) => setSigner({ ...signer, title: e.target.value })} />
                    </Field>
                  </FormGrid>
                  <Field label="Note to the holder" hint="Printed on the certificate.">
                    <Input value={signer.message} placeholder="Optional" onChange={(e) => setSigner({ ...signer, message: e.target.value })} />
                  </Field>
                </> : <Banner tone="info"><p className="text-[12px]">Use this for paperwork signed elsewhere. The shares are recorded as outstanding immediately; no certificate is sent for signature.</p></Banner>}
              </Section>

              <details className="group rounded-xl border border-ink-200/80 bg-white shadow-[0_2px_6px_rgba(16,24,40,0.025)]">
                <summary className="flex cursor-pointer list-none items-center gap-3 p-4 text-[13px] font-semibold text-ink-800 sm:px-5 [&::-webkit-details-marker]:hidden">
                  <span className="grid size-8 place-items-center rounded-lg bg-ink-50 text-ink-500"><Icon name="settings" /></span>
                  <span className="flex-1">Advanced settings<span className="mt-0.5 block text-[12px] font-normal text-ink-500">Certificate number, 83(b) filing and notes</span></span>
                  <Icon name="chevron" className="size-4 text-ink-400 transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-4 border-t border-ink-100 p-4 sm:p-5">
                  <Field label="Certificate number" hint="Leave empty to assign the next number automatically.">
                    <Input value={form.certificateNo} placeholder="Automatic" onChange={(e) => setForm({ ...form, certificateNo: e.target.value })} />
                  </Field>
                  <Checkbox label="Shares acquired by early exercising an unvested option" checked={form.earlyExercised}
                    hint="Subject to repurchase at cost if the holder leaves before vesting."
                    onChange={(value) => setForm({ ...form, earlyExercised: value })} />
                  <Field label="83(b) election filed" hint="Record the filing date, if applicable.">
                    <Input type="date" value={form.election83bFiledOn} onChange={(e) => setForm({ ...form, election83bFiledOn: e.target.value })} />
                  </Field>
                  <Field label="Internal notes">
                    <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  </Field>
                </div>
              </details>

              <section className="px-1 py-3 sm:px-2">
                <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-500">What happens next</h3>
                <ol className="space-y-4 text-[13px]">
                  <li className="flex items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full border border-brand-100 bg-white text-brand-600"><Icon name={forSignature ? 'send' : 'document'} /></span><div>
                    <p className="font-medium text-ink-800">{forSignature ? 'Send for signature' : 'Record the issuance'}</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{forSignature ? 'The recipient and the Company sign the certificate.' : 'Confirm the details match your signed paperwork.'}</p></div></li>
                  <li className="flex items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full border border-brand-100 bg-white text-brand-600"><Icon name="table" /></span><div>
                    <p className="font-medium text-ink-800">Update the cap table</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{forSignature ? 'Shares become outstanding once both parties sign.' : 'Shares become outstanding when you record them.'}</p></div></li>
                </ol>
              </section>
              {error && <div role="alert"><Banner tone="danger">{error}</Banner></div>}
            </div>

            <aside aria-label="Issuance summary" tabIndex={0} className="min-w-0 overflow-hidden rounded-xl border border-brand-100 bg-white shadow-[0_4px_16px_rgba(16,24,40,0.04)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 md:sticky md:top-0 md:max-h-[min(calc(70dvh-3rem),calc(100dvh-17rem))] md:overflow-y-auto">
              <div className="flex items-center justify-between gap-2 border-b border-brand-100 bg-brand-50/40 px-4 py-3.5">
                <h3 className="text-[13px] font-semibold text-ink-900">Issuance summary</h3>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[10px] font-medium text-brand-700 ring-1 ring-brand-100"><span className="size-1.5 rounded-full bg-brand-500" />Live</span>
              </div>
              <div className="p-4">
                <div className="rounded-xl bg-brand-50 px-4 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-600">Shares to issue</p>
                  <p className="mt-1 break-words text-[28px] font-semibold leading-tight tracking-tight tabular text-brand-900">{quantityInput ? shares(quantity) : '—'}</p>
                  <p className="mt-1 text-[12px] text-brand-700">{shareClass?.name ?? 'Select a share class'}</p>
                </div>
                <dl className="grid grid-cols-2 gap-3 border-b border-ink-100 py-4 text-[11px]">
                  <div><dt className="text-ink-500">Ownership</dt><dd className="mt-1 break-words text-[15px] font-semibold tabular text-ink-900">{ownership === null ? '—' : percent(ownership / 100, 4)}<span className="mt-0.5 block text-[10px] font-normal text-ink-400">After issuance</span></dd></div>
                  <div className="border-l border-ink-100 pl-3"><dt className="text-ink-500">Total price</dt><dd className="mt-1 break-words text-[15px] font-semibold tabular text-ink-900">{quantityInput && form.pricePerShare !== '' ? money(Math.round(quantity * price / 1e4)) : '—'}</dd></div>
                </dl>
                <div className="border-b border-ink-100 py-4">
                  <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">Issued to</p>
                  {holder ? <div className="flex items-center gap-2.5"><Avatar name={holder.name} size={32} />
                    <div className="min-w-0"><p className="break-words text-[13px] font-medium text-ink-900">{holder.name}</p><p className="mt-0.5 break-words text-[11px] text-ink-500">{holder.email || 'No email on file'}</p></div>
                  </div> : <div className="flex items-center gap-2.5 text-ink-400"><span className="grid size-8 place-items-center rounded-full bg-ink-50"><Icon name="users" /></span><p className="text-[12px]">Select a recipient</p></div>}
                </div>
                <dl className="divide-y divide-ink-100 py-1 text-[11px]">
                  <Detail label="Price per share">{form.pricePerShare !== '' ? pps(price) : '—'}</Detail>
                  <Detail label="Issue date">{date(issueDate)}</Detail>
                  <Detail label="Vesting">{schedule?.name ?? 'Fully vested'}</Detail>
                  {schedule && <Detail label="Vesting starts">{date(form.vestingStartDate || issueDate)}</Detail>}
                  {forSignature && <Detail label="Company signatory">{signer.name || '—'}</Detail>}
                </dl>
                <div className="border-t border-ink-100 pt-3">
                  <Badge tone={valuation.loading || valuation.error || !valuation.data ? 'neutral' : missingValuation || outdatedValuation ? 'warning' : 'success'}>
                    {valuation.loading ? 'Checking 409A' : valuation.error || !valuation.data ? '409A status unavailable' : missingValuation ? '409A not on file' : outdatedValuation ? '409A update needed' : '409A on file'}
                  </Badge>
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-500">{forSignature ? 'Outstanding after both parties sign.' : 'Outstanding when recorded.'}</p>
                </div>
              </div>
            </aside>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
