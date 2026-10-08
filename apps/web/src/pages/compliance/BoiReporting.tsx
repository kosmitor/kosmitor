import { useState } from 'react';
import { useSession } from '../../session.tsx';
import { useQuery, api } from '../../api.ts';
import { Card, Loading, ErrorNote, EmptyState, Stat, Banner, Button, Input, Field, Select, Modal, Badge, useToast } from '../../ui.tsx';
import { DataTable } from '../../DataTable.tsx';
import { Icon } from '../../icons.tsx';
import { date, percent } from '../../format.ts';
import { SecurityDocuments } from '../../SecurityDocuments.tsx';

const STATUS_LABELS: Record<string, string> = {
  EXEMPT_DOMESTIC: 'Exempt — formed in the United States',
  REQUIRED: 'Reporting company — must file',
  EXEMPT_OTHER: 'Exempt — another exemption applies',
};

/** Beneficial ownership information under the Corporate Transparency Act. */
export default function BoiReporting() {
  const { companyId, canViewAll, isAdmin, canEdit, refresh } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/compliance/boi` : null, [companyId]);
  const [recording, setRecording] = useState(false);
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  const [form, setForm] = useState({ period: 'INITIAL', filedOn: '', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);

  if (!canViewAll) return <EmptyState title="Compliance is not available for your role" />;
  if (loading && !data) return <Loading label="Identifying beneficial owners" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const setStatus = async (boiStatus: string) => {
    setBusy(true);
    try {
      await api(`/c/${companyId}`, { method: 'PATCH', body: { boiStatus } });
      toast('BOI status updated');
      await refresh();
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const record = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/compliance/filings`, { body: { kind: 'BOI', ...form, reference: form.reference || null, notes: form.notes || null } });
      toast('BOI report recorded');
      setRecording(false);
      setForm({ period: 'UPDATE', filedOn: '', reference: '', notes: '' });
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try { await api(`/c/${companyId}/compliance/filings/${id}`, { method: 'DELETE' }); toast('Record removed'); reload(); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const required = data.status === 'REQUIRED';
  const reasonLabel = (r: string) => (r === 'ownership' ? '≥ 25% ownership' : 'substantial control');
  const roleOf = (o: any): string => o.title ?? o.relation.toLowerCase().replace('_', ' ');

  return (
    <>
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="xl:col-span-2">
          <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Company standing</p>
          <p className="mt-2 text-[15px] font-semibold text-ink-900">{STATUS_LABELS[data.status] ?? data.status}</p>
          <p className="mt-1 text-[12px] text-ink-500">
            {data.statusSource === 'derived' ? `Derived from the jurisdiction (${data.jurisdiction ?? 'not set'}) — ` : 'Set by an administrator — '}
            {data.entityType ?? 'entity'}{data.incorporationDate ? `, formed ${date(data.incorporationDate)}` : ''}.
          </p>
          {isAdmin && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Set the standing" className="w-72">
                <Select value={data.status} disabled={busy} onChange={(e) => void setStatus(e.target.value)}>
                  <option value="EXEMPT_DOMESTIC">Exempt — formed in the United States</option>
                  <option value="REQUIRED">Reporting company — must file</option>
                  <option value="EXEMPT_OTHER">Exempt — another exemption (large operating company, etc.)</option>
                </Select>
              </Field>
            </div>
          )}
        </Card>
        <Stat label="Beneficial owners" value={String(data.owners.length)} hint={`${data.entitiesToLookThrough.length} entit${data.entitiesToLookThrough.length === 1 ? 'y' : 'ies'} to look through`} />
        <Card>
          <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Last report</p>
          <p className="mt-2 text-[15px] font-semibold text-ink-900">{data.lastFiledOn ? date(data.lastFiledOn) : required ? 'Not filed' : '—'}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {required && !data.lastFiledOn && <Badge tone="danger">Initial report due</Badge>}
            {required && data.updateDue && <Badge tone="warning">Update may be due</Badge>}
            {required && data.lastFiledOn && !data.updateDue && <Badge tone="success">Current</Badge>}
          </div>
          {canEdit && required && <div className="mt-3"><Button size="sm" variant="primary" onClick={() => { setForm({ ...form, period: data.lastFiledOn ? 'UPDATE' : 'INITIAL' }); setRecording(true); }}>Record a filing</Button></div>}
        </Card>
      </div>

      <div className="mb-5">
        <Banner tone={required ? 'warning' : 'info'} title={required ? 'What a reporting company files' : 'Why most US companies do not file'}>
          {required ? (
            <>An initial report identifies the company and every beneficial owner — legal name, date of birth, residential address and an identifying
            document — and must be filed within 30 days of registering to do business. Any change in owners or their details must be reported within
            30 days. The worksheet below is drawn from the cap table; confirm it against the company's records before filing.</>
          ) : (
            <>Under FinCEN's interim final rule of 26 March 2025, entities created in the United States and their beneficial owners are exempt from
            beneficial ownership reporting. Only foreign reporting companies — formed abroad and registered to do business in a US state — must file.
            If that describes this company, set its standing to "Reporting company". The worksheet below is kept up to date regardless, so it is ready
            if the rules change or a bank asks for it.</>
          )}
        </Banner>
      </div>

      {/* Three short lists, each a few rows long, so they are drawn without a search box or a full size view.
          The two narrow ones fit their card, so their first column is not pinned either. */}
      <DataTable title="Beneficial owners" caption="Beneficial owners"
        subtitle="Individuals with 25% or more of the ownership interests (their own options counted as exercised) or substantial control — senior officers, founders and directors"
        rows={data.owners} rowKey={(o) => o.stakeholderId}
        empty={<EmptyState title="No individual meets the tests yet" />}
        columns={[
          { key: 'individual', label: 'Individual', value: (o) => o.name, className: 'font-medium' },
          { key: 'role', label: 'Role', value: roleOf, className: 'text-ink-600' },
          { key: 'ownership', label: 'Ownership', type: 'number', value: (o) => o.ownershipPct, cell: (o) => percent(o.ownershipPct) },
          { key: 'reasons', label: 'Qualifies by', value: (o) => o.reasons.map(reasonLabel).join(', '),
            cell: (o) => <span className="flex flex-wrap gap-1">{o.reasons.map((r: string) => <Badge key={r} tone={r === 'ownership' ? 'brand' : 'purple'}>{reasonLabel(r)}</Badge>)}</span> },
          { key: 'since', label: 'Since', type: 'date', value: (o) => o.since, className: 'text-ink-600' },
          { key: 'file', label: 'Information on file', value: (o) => (o.address ? 'Address ✓' : 'Address missing'), className: 'text-[12px]', wrap: true,
            cell: (o) => (
              <>
                <span className={o.address ? 'text-secondary-800' : 'text-amber-700'}>{o.address ? 'Address ✓' : 'Address missing'}</span>
                <span className="text-ink-400"> · </span><span className="text-ink-500">date of birth and ID document are collected at filing</span>
              </>
            ) },
        ]} />

      {data.entitiesToLookThrough.length > 0 && (
        <DataTable title="Entities to look through" caption="Entities to look through" className="mt-5" pinFirst={false}
          subtitle="An entity is never a beneficial owner itself: report the individuals who own or control it, in proportion to their interest"
          rows={data.entitiesToLookThrough} rowKey={(e) => e.stakeholderId}
          columns={[
            { key: 'entity', label: 'Entity', value: (e) => e.name, className: 'font-medium' },
            { key: 'type', label: 'Type', value: (e) => e.type.toLowerCase(), className: 'text-ink-600' },
            { key: 'ownership', label: 'Ownership', type: 'number', value: (e) => e.ownershipPct, cell: (e) => percent(e.ownershipPct) },
            { key: 'since', label: 'Since', type: 'date', value: (e) => e.since, className: 'text-ink-600' },
          ]} />
      )}

      {data.filings.length > 0 && (
        <DataTable title="Reports on record" caption="BOI reports on record" className="mt-5" pinFirst={false}
          rows={data.filings} rowKey={(f) => f.id}
          columns={[
            { key: 'report', label: 'Report', value: (f) => f.period.toLowerCase(), className: 'font-medium capitalize' },
            { key: 'filed', label: 'Filed on', type: 'date', value: (f) => f.filedOn },
            { key: 'reference', label: 'Reference', value: (f) => f.reference, className: 'text-ink-600' },
            { key: 'notes', label: 'Notes', value: (f) => f.notes, className: 'text-ink-600' },
            // There is no instrument behind a BOI report, so the submission receipt
            // and the confirmation are filed against the report's own id. A row
            // without one is left alone rather than given a made-up reference.
            { key: 'actions', label: '', width: 150, align: 'right',
              cell: (f) => (
                <span className="flex justify-end gap-1">
                  {f.id && (
                    <Button size="sm" variant="ghost" onClick={() => setDocumentsFor(f)}
                      aria-label="Documents for this report" title="Documents for this report">
                      <Icon name="document" className="size-4" />
                    </Button>
                  )}
                  {canEdit && <Button size="sm" variant="ghost" loading={busy} onClick={() => void remove(f.id)}>Remove</Button>}
                </span>
              ) },
          ]} />
      )}

      <Modal open={!!documentsFor} onClose={() => setDocumentsFor(null)} size="lg"
        title={documentsFor ? `Documents for the ${String(documentsFor.period).toLowerCase()} BOI report` : 'Documents'}
        description={documentsFor
          ? `Filed against the ${String(documentsFor.period).toLowerCase()} BOI report of ${date(documentsFor.filedOn)}${documentsFor.reference ? `, reference ${documentsFor.reference}` : ''}.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} subject={{ kind: 'BOI', ref: documentsFor.id }} />
        )}
      </Modal>

      <Modal open={recording} onClose={() => setRecording(false)} title="Record a BOI filing" size="sm"
        description="Kept here as the company's own record; FinCEN issues the confirmation.">
        <div className="space-y-4">
          <Field label="Report" required>
            <Select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
              <option value="INITIAL">Initial report</option><option value="UPDATE">Updated report</option><option value="CORRECTION">Corrected report</option>
            </Select>
          </Field>
          <Field label="Filed on" required><Input type="date" value={form.filedOn} onChange={(e) => setForm({ ...form, filedOn: e.target.value })} required /></Field>
          <Field label="Reference" hint="FinCEN submission or BOIR ID"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRecording(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!form.filedOn} onClick={() => void record()}>Record filing</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
