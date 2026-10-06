/**
 * One share certificate, in full.
 *
 * The certificates list answers "who holds what"; this page answers everything
 * else about a single issuance: the money, the terms it was sold under, where it
 * has reached in its vesting, whether the 83(b) election was filed in time, and
 * what has happened to the shares since. It reads one endpoint, so every number
 * on the page comes from the same computation of the cap table.
 */
import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, api, downloadFile } from '../api.ts';
import { FormModal, FormGrid } from '../crud.tsx';
import {
  Badge, Loading, ErrorNote, Button, Input, Field, Select,
  Checkbox, Textarea, MiniBar, KeyValue, ConfirmDialog, Banner, useToast,
} from '../ui.tsx';
import { RecordPage, RecordSection, RecordColumns, RecordTimeline, RecordMissing } from '../RecordPage.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { HoldingDocumentField, CERTIFICATE_DOCUMENT } from '../HoldingDocumentField.tsx';
import { readableDocumentPath, documentFilename, isUploadedFile, downloadDocumentPath } from '../documents.ts';
import { VestingChart } from '../charts.tsx';
import { money, shares, pps, percent, date, relativeDate } from '../format.ts';

/** The exemptions private shares are sold under, in the words someone would say out loud. */
const FEDERAL_EXEMPTIONS: [string, string][] = [
  ['SECTION_4A2', 'Section 4(a)(2), private placement'],
  ['REG_D_506B', 'Regulation D, Rule 506(b)'],
  ['REG_D_506C', 'Regulation D, Rule 506(c)'],
  ['RULE_701', 'Rule 701, compensatory plan'],
  ['REG_S', 'Regulation S, offshore sale'],
  ['REG_CF', 'Regulation Crowdfunding'],
  ['OTHER', 'Other exemption'],
];
const exemptionLabel = (code: string | null): string =>
  (code ? FEDERAL_EXEMPTIONS.find(([v]) => v === code)?.[1] ?? code : '—');

interface Form {
  certificateNo: string; boardApprovalDate: string; federalExemption: string; stateExemption: string;
  proRata: boolean; issueReason: string; holdingStartDate: string; rule144Date: string;
  accelerationNotes: string; notes: string;
}
const BLANK: Form = {
  certificateNo: '', boardApprovalDate: '', federalExemption: '', stateExemption: '',
  proRata: false, issueReason: '', holdingStartDate: '', rule144Date: '', accelerationNotes: '', notes: '',
};
const formFrom = (i: Record<string, any>): Form => ({
  certificateNo: i.certificateNo ?? '',
  boardApprovalDate: String(i.boardApprovalDate ?? '').slice(0, 10),
  federalExemption: i.federalExemption ?? '',
  stateExemption: i.stateExemption ?? '',
  proRata: !!i.proRata,
  issueReason: i.issueReason ?? '',
  holdingStartDate: String(i.holdingStartDate ?? '').slice(0, 10),
  rule144Date: String(i.rule144Date ?? '').slice(0, 10),
  accelerationNotes: i.accelerationNotes ?? '',
  notes: i.notes ?? '',
});

export default function CertificateDetail() {
  const { id } = useParams<{ id: string }>();
  const { companyId, canEdit } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, errorStatus, loading, reload } = useQuery<any>(
    companyId && id ? `/c/${companyId}/issuances/${id}/detail` : null, [companyId, id]);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reading, setReading] = useState<any>(null);
  // Null until someone types: the field then shows whatever the server last recorded.
  const [filed, setFiled] = useState<string | null>(null);

  if (loading) return <Loading label="Loading certificate" />;
  if (error) {
    // A holder who opens someone else's certificate is told it is not there, because
    // that is what the server says: it answers 404 rather than admitting the record exists.
    // Keyed off the status rather than the wording, which is free to change.
    return errorStatus === 404 ? (
      <RecordMissing icon="certificate" title="That certificate is not here"
        description="It may have been deleted, or it belongs to another holder."
        to="/certificates" label="Back to certificates" />
    ) : <ErrorNote error={error} onRetry={reload} />;
  }
  if (!data) return null;

  const { issuance, stakeholder, shareClass, amounts, vesting, certificate, election83b, timeline } = data;
  const certificateNo = issuance.certificateNo ?? String(issuance.id).slice(-6).toUpperCase();
  const filedValue = filed ?? (election83b.filedOn ? String(election83b.filedOn).slice(0, 10) : '');

  const openEdit = () => { setForm(formFrom(issuance)); setEditing(true); };

  const patch = async (body: Record<string, unknown>, message: string): Promise<boolean> => {
    setBusy(true);
    try {
      // While it is out for signature the certificate is a draft, and correcting it
      // has to rewrite the document that repeats its terms. That is the draft route.
      const path = issuance.status === 'PENDING_SIGNATURE'
        ? `/c/${companyId}/issuances/${id}/draft`
        : `/c/${companyId}/issuances/${id}`;
      await api(path, { method: 'PATCH', body });
      toast(message);
      reload();
      return true;
    } catch (err) { toast((err as Error).message, 'error'); return false; } finally { setBusy(false); }
  };

  const save = async () => {
    // Only the fields that moved. A full row would overwrite share counts, prices and
    // vesting, which this form does not show and other screens own.
    const base = formFrom(issuance);
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(form) as (keyof Form)[]) {
      if (form[key] === base[key]) continue;
      const value = form[key];
      changed[key] = typeof value === 'boolean' ? value : value.trim() || null;
    }
    if (Object.keys(changed).length === 0) { setEditing(false); return; }
    if (await patch(changed, 'Certificate updated')) setEditing(false);
  };

  const saveElection = async (value: string | null) => {
    if (await patch({ election83bFiledOn: value }, value ? 'Election recorded' : 'Election cleared')) setFiled(null);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/issuances/${id}`, { method: 'DELETE' });
      toast('Certificate deleted');
      navigate('/certificates');
    } catch (err) { toast((err as Error).message, 'error'); setDeleting(false); } finally { setBusy(false); }
  };

  const acceleration = vesting?.acceleration;
  const accelerationText = [
    acceleration?.single ? `${percent(acceleration.single, 0)} on a single trigger` : null,
    acceleration?.double ? `${percent(acceleration.double, 0)} on a double trigger` : null,
    acceleration?.months ? `${acceleration.months} months of extra vesting credit` : null,
  ].filter(Boolean).join(', ') || 'None';

  // What can be done with the certificate document depends on what it is. A
  // document the app wrote can be rendered and printed from its text. An uploaded
  // file has no text, so printing it would hand back an empty sheet: it is read if
  // it is a PDF and saved otherwise. Before, all of this hung on the document being
  // EXECUTED, which no uploaded certificate ever is.
  const certificatePath = certificate ? readableDocumentPath(companyId!, certificate) : null;
  const actions = [
    ...(certificatePath
      ? [{ label: 'Read the certificate', icon: 'eye' as const, onClick: () => setReading(certificate) }] : []),
    ...(certificate && isUploadedFile(certificate)
      ? [{ label: 'Download the certificate', icon: 'download' as const,
          onClick: () => { void downloadFile(downloadDocumentPath(companyId!, certificate), documentFilename(certificate))
            .catch((err: Error) => toast(err.message, 'error')); } }]
      : certificate?.body
        ? [{ label: 'Print the certificate', icon: 'document' as const,
            onClick: () => window.open(`/api/c/${companyId}/documents/${certificate.id}/print`, '_blank', 'noopener') }] : []),
    ...(canEdit ? [{ label: 'Edit the details', icon: 'edit' as const, onClick: openEdit }] : []),
    ...(canEdit ? [{ label: 'Delete', icon: 'trash' as const, danger: true, onClick: () => setDeleting(true) }] : []),
  ];

  return (
    <RecordPage back="/certificates" backLabel="All certificates"
      title={`${certificateNo} Shares`} status={issuance.status}
      badges={shareClass && <Badge tone={shareClass.kind === 'PREFERRED' ? 'purple' : 'neutral'}>{shareClass.name}</Badge>}
      subtitle={`${shares(issuance.quantity)} shares issued ${date(issuance.issueDate)}`}
      actions={actions} concept="certificate-record">

      <RecordColumns>
        <RecordSection first title="Overview" className="lg:col-span-2">
          <div className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-ink-600">These shares as a share of the company fully diluted</span>
              <span className="text-[13px] font-medium tabular">{percent(amounts.pctOfCompany)}</span>
            </div>
            <MiniBar value={amounts.pctOfCompany} />
          </div>
          <KeyValue columns={3} items={[
            { label: 'Shares issued', value: shares(issuance.quantity) },
            { label: 'Price per share', value: pps(issuance.pricePerShare) },
            { label: 'Par value', value: shareClass ? pps(shareClass.parValue) : '—' },
            { label: 'Capital contribution', value: money(amounts.capitalContribution) },
            { label: 'Issue date', value: date(issuance.issueDate) },
            {
              label: 'Certificate document',
              value: (
                <HoldingDocumentField kind={CERTIFICATE_DOCUMENT} document={certificate} securityId={issuance.id}
                  stakeholderId={stakeholder?.id ?? null} stakeholderName={stakeholder?.name ?? null}
                  onChange={reload} />
              ),
            },
          ]} />
        </RecordSection>

        <RecordSection first title="Stakeholder">
          <KeyValue columns={1} items={[
            {
              label: 'Name',
              value: stakeholder
                ? <Link to={`/stakeholders/${stakeholder.id}`} className="font-medium text-brand-600 hover:text-brand-700">{stakeholder.name}</Link>
                : '—',
            },
            { label: 'Email', value: stakeholder?.email ?? '—' },
            {
              label: 'This holder owns in total',
              value: `${shares(amounts.holderFullyDiluted)} fully diluted, ${percent(amounts.holderFullyDilutedPct)} of the company`,
            },
          ]} />
        </RecordSection>
      </RecordColumns>

      <RecordSection title="Details"
        action={canEdit ? <Button size="sm" variant="ghost" onClick={openEdit}>Edit</Button> : undefined}>
        <KeyValue columns={3} items={[
          { label: 'Board approval date', value: date(issuance.boardApprovalDate) },
          { label: 'Federal exemption', value: exemptionLabel(issuance.federalExemption) },
          { label: 'State exemption', value: issuance.stateExemption ?? '—' },
          { label: 'Pro rata', value: issuance.proRata ? 'Yes' : 'No' },
          { label: 'Holding start date', value: date(issuance.holdingStartDate) },
          { label: 'Issue reason', value: issuance.issueReason ?? '—' },
        ]} />

        <div className="mt-4">
          <p className="text-[12px] text-ink-500">Share class legend</p>
          {/* The legend runs to several paragraphs of restrictive text, and it would
              push everything below it off the screen if it were laid out in full. */}
          <div className="mt-1 max-h-44 overflow-y-auto whitespace-pre-line rounded-lg border border-ink-200 bg-ink-50/60 p-3 text-[13px] leading-relaxed text-ink-700">
            {shareClass?.legend ?? 'No legend is recorded on this share class.'}
          </div>
        </div>

        <div className="mt-4">
          <KeyValue columns={3} items={[
            { label: 'Acceleration', value: accelerationText },
            { label: 'Acceleration notes', value: issuance.accelerationNotes ? <span className="whitespace-pre-line">{issuance.accelerationNotes}</span> : '—' },
            { label: 'Rule 144 date', value: date(issuance.rule144Date) },
          ]} />
        </div>
      </RecordSection>

      <RecordSection title="Additional information">
        <KeyValue columns={1} items={[
          { label: 'Comments', value: issuance.notes ? <span className="whitespace-pre-line">{issuance.notes}</span> : '—' },
        ]} />
      </RecordSection>

      {vesting && (
        <RecordSection title="Vesting" subtitle={vesting.scheduleName}>
          <div className="grid items-start gap-5 lg:grid-cols-[1fr_300px]">
            <div>
              <p className="mb-2 text-[13px] text-ink-600">
                {shares(vesting.summary.vested)} of {shares(issuance.quantity)} shares
                {' '}({percent(vesting.summary.percentVested, 1)}) have vested
              </p>
              <MiniBar value={vesting.summary.percentVested} />
              {vesting.curve?.length > 0 && (
                <div className="mt-4"><VestingChart data={vesting.curve} total={issuance.quantity} height={190} /></div>
              )}
            </div>
            <KeyValue columns={1} items={[
              { label: 'Schedule', value: vesting.scheduleName },
              { label: 'Start date', value: date(vesting.startDate) },
              {
                label: 'Next vest',
                value: vesting.summary.nextVestDate
                  ? `${shares(vesting.summary.nextVestQuantity)} on ${date(vesting.summary.nextVestDate)} (${relativeDate(vesting.summary.nextVestDate)})`
                  : 'Fully vested',
              },
              {
                label: 'Cliff',
                value: vesting.summary.cliffDate
                  ? `${date(vesting.summary.cliffDate)}${vesting.summary.cliffPassed ? ' (passed)' : ''}`
                  : 'No cliff',
              },
            ]} />
          </div>
        </RecordSection>
      )}

      {election83b.relevant && (
        <RecordSection title="83(b) election">
          {election83b.overdue && (
            <div className="mb-4">
              <Banner tone="danger" title="The filing window has closed">
                These shares were issued on {date(issuance.issueDate)} and the election was due by {date(election83b.dueBy)}.
                The Internal Revenue Service does not extend that window, so the tax is measured again at every vesting date.
              </Banner>
            </div>
          )}
          <KeyValue columns={3} items={[
            {
              label: 'Filed',
              value: election83b.filedOn
                ? <span className="flex items-center gap-2"><Badge tone="success">Filed</Badge>{date(election83b.filedOn)}</span>
                : <Badge tone={election83b.overdue ? 'danger' : 'warning'}>Not filed</Badge>,
            },
            { label: 'Due by', value: date(election83b.dueBy) },
            {
              label: 'Filed election',
              value: election83b.document ? (
                <button type="button" onClick={() => setReading(election83b.document)}
                  className="cursor-pointer font-medium text-brand-600 hover:text-brand-700">{election83b.document.name}</button>
              ) : 'No document on file',
            },
          ]} />

          {canEdit && (
            <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-4">
              <Field label="Date the election was filed" className="w-52">
                <Input type="date" value={filedValue} onChange={(e) => setFiled(e.target.value)} />
              </Field>
              <Button variant="primary" loading={busy} onClick={() => void saveElection(filedValue || null)}>Save</Button>
              {election83b.filedOn && (
                <Button variant="ghost" onClick={() => void saveElection(null)}>Clear</Button>
              )}
            </div>
          )}
        </RecordSection>
      )}

      <SecurityDocuments className="mt-5" securityId={issuance.id} stakeholderId={stakeholder.id}
        title="Documents"
        description="The paperwork filed against these shares: the signed agreement, board consents, the 83(b) election, side letters." />

      <RecordTimeline events={timeline} subtitle="Everything recorded against these shares, newest first"
        emptyTitle="Nothing has happened to these shares yet"
        emptyDescription="Signatures, transfers, repurchases and edits all land here." />

      <FormModal open={editing} onClose={() => setEditing(false)} busy={busy} size="lg"
        title="Edit certificate details"
        description="The terms these shares were issued under. Share counts, prices and vesting are changed from the certificates list."
        onSubmit={save} submitLabel="Save changes">
        <FormGrid>
          <Field label="Certificate number">
            <Input value={form.certificateNo} onChange={(e) => setForm({ ...form, certificateNo: e.target.value })} placeholder="CS-1" />
          </Field>
          <Field label="Board approval date">
            <Input type="date" value={form.boardApprovalDate} onChange={(e) => setForm({ ...form, boardApprovalDate: e.target.value })} />
          </Field>
          <Field label="Federal exemption" hint="The rule the sale relied on instead of registering.">
            <Select value={form.federalExemption} onChange={(e) => setForm({ ...form, federalExemption: e.target.value })} placeholder="Not recorded">
              <option value="">Not recorded</option>
              {FEDERAL_EXEMPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </Field>
          <Field label="State exemption">
            <Input value={form.stateExemption} onChange={(e) => setForm({ ...form, stateExemption: e.target.value })} placeholder="California 25102(f)" />
          </Field>
          <Field label="Issue reason">
            <Input value={form.issueReason} onChange={(e) => setForm({ ...form, issueReason: e.target.value })} placeholder="Founder purchase" />
          </Field>
          <Field label="Holding start date" hint="When the Rule 144 holding period starts counting.">
            <Input type="date" value={form.holdingStartDate} onChange={(e) => setForm({ ...form, holdingStartDate: e.target.value })} />
          </Field>
          <Field label="Rule 144 date">
            <Input type="date" value={form.rule144Date} onChange={(e) => setForm({ ...form, rule144Date: e.target.value })} />
          </Field>
        </FormGrid>
        <Checkbox label="Issued under a pro rata right"
          hint="The holder took these shares to keep their percentage in a financing."
          checked={form.proRata} onChange={(v) => setForm({ ...form, proRata: v })} />
        <Field label="Acceleration notes">
          <Textarea value={form.accelerationNotes} onChange={(e) => setForm({ ...form, accelerationNotes: e.target.value })}
            placeholder="Anything the schedule itself does not capture." />
        </Field>
        <Field label="Comments">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </FormModal>

      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} danger loading={busy}
        title="Delete certificate" confirmLabel="Delete"
        message={<>Deleting certificate <strong>{certificateNo}</strong> removes those shares from the cap table. Prefer cancelling or repurchasing so the history stays intact.</>}
        onConfirm={() => void remove()} />

      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        path={reading ? readableDocumentPath(companyId!, reading) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />
    </RecordPage>
  );
}
