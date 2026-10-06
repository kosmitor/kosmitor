import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../session.tsx';
import { useQuery, api } from '../../api.ts';
import { Card, Table, TH, TD, TR, Loading, ErrorNote, EmptyState, Stat, Banner, Button, Input, Field, Modal, ActionMenu, useToast } from '../../ui.tsx';
import { shares, date, relativeDate } from '../../format.ts';
import { SecurityDocuments } from '../../SecurityDocuments.tsx';
import { StatusBadge } from './shared.tsx';

/** Every restricted certificate and where its 83(b) election stands. */
export default function Elections83b() {
  const { companyId, canViewAll, canEdit } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/compliance/83b` : null, [companyId]);
  const [recording, setRecording] = useState<any>(null);
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  const [filedOn, setFiledOn] = useState('');
  const [busy, setBusy] = useState(false);

  if (!canViewAll) return <EmptyState title="Compliance is not available for your role" />;
  if (loading) return <Loading label="Checking 83(b) elections" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const save = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/issuances/${recording.issuanceId}`, { method: 'PATCH', body: { election83bFiledOn: filedOn || null } });
      toast(filedOn ? 'Election recorded' : 'Election cleared');
      setRecording(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Restricted certificates" value={String(data.rows.length)} hint={`${data.unrestricted} unrestricted, no election needed`} />
        <Stat label="Filed" value={String(data.counts.filed)} tone="positive" />
        <Stat label="Window open" value={String(data.counts.open)} tone={data.counts.open ? 'warning' : 'default'} hint="File before the deadline" />
        <Stat label="Window closed, not filed" value={String(data.counts.closed)} tone={data.counts.closed ? 'negative' : 'positive'} hint="Tax on vesting instead of at purchase" />
      </div>
      {data.counts.closed > 0 && (
        <div className="mb-5">
          <Banner tone="warning" title="Missed elections cannot be cured">
            Without a timely election, each vesting tranche is taxed as ordinary income at its fair market value when it vests. If a holder did file
            within 30 days but it was never recorded here, add the date so the finding clears.
          </Banner>
        </div>
      )}
      <Card padded={false}>
        {data.rows.length === 0 ? (
          <EmptyState title="No restricted stock outstanding" description="Certificates that vest over time or were early-exercised appear here with their election window." />
        ) : (
          <Table>
            <thead>
              <tr><TH>Certificate</TH><TH>Holder</TH><TH>Class</TH><TH align="right">Shares</TH><TH>Issued</TH><TH>Deadline</TH><TH>Restricted because</TH><TH>Election</TH><TH width={140} /></tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <TR key={r.issuanceId} className={r.status === 'CLOSED' ? 'bg-red-50/30' : r.status === 'OPEN' ? 'bg-amber-50/30' : undefined}>
                  {/* Every row is one issuance, so the certificate number opens that certificate. */}
                  <TD mono>
                    <Link to={`/certificates/${r.issuanceId}`}
                      className="cursor-pointer text-left font-medium text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-400">
                      {r.certificateNo ?? String(r.issuanceId).slice(-6).toUpperCase()}
                    </Link>
                  </TD>
                  <TD className="font-medium">{r.stakeholderName}</TD>
                  <TD className="text-ink-600">{r.shareClassName ?? '—'}</TD>
                  <TD align="right" mono>{shares(r.quantity)}</TD>
                  <TD className="text-ink-600">{date(r.issueDate)}</TD>
                  <TD><span className="block text-ink-800">{date(r.deadline)}</span><span className="block text-[11px] text-ink-500">{r.status === 'OPEN' ? `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left` : relativeDate(r.deadline)}</span></TD>
                  <TD className="text-ink-600">{r.reason}</TD>
                  <TD><StatusBadge status={r.status} />{r.filedOn && <span className="ml-2 text-[12px] text-ink-500">{date(r.filedOn)}</span>}</TD>
                  {/* Three actions will not sit side by side in this column, so only the
                      one an administrator reaches for every time stays a button. */}
                  <TD align="right">
                    <span className="flex justify-end gap-1">
                      {canEdit && (
                        <Button size="sm" onClick={() => { setRecording(r); setFiledOn(r.filedOn ?? ''); }}>{r.filedOn ? 'Edit date' : 'Record filing'}</Button>
                      )}
                      <ActionMenu items={[
                        { label: 'Documents', icon: 'document', onClick: () => setDocumentsFor(r) },
                        ...(canEdit
                          ? [{ label: 'Election letter', icon: 'external' as const,
                            onClick: () => window.open(`/api/c/${companyId}/compliance/83b/${r.issuanceId}/print`, '_blank', 'noopener') }]
                          : []),
                      ]} />
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* An election belongs to a certificate that exists, so it is filed against
          that certificate rather than against a subject of its own. */}
      <Modal open={!!documentsFor} onClose={() => setDocumentsFor(null)} size="lg"
        title={documentsFor ? `83(b) documents for ${documentsFor.certificateNo ?? 'the certificate'}` : 'Documents'}
        description={documentsFor
          ? `Filed against certificate ${documentsFor.certificateNo ?? String(documentsFor.issuanceId).slice(-6).toUpperCase()}, held by ${documentsFor.stakeholderName}. The same documents appear on the certificate itself.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} securityId={documentsFor.issuanceId} stakeholderId={documentsFor.stakeholderId} />
        )}
      </Modal>

      <Modal open={!!recording} onClose={() => setRecording(null)} title={`83(b) election for ${recording?.certificateNo ?? 'certificate'}`} size="sm"
        description={recording ? `${recording.stakeholderName} · ${shares(recording.quantity)} shares issued ${date(recording.issueDate)}. The election had to be postmarked by ${date(recording.deadline)}.` : undefined}>
        <div className="space-y-4">
          <Field label="Date the election was filed" hint="Leave empty to record that no election was made.">
            <Input type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
          </Field>
          {filedOn && recording && filedOn > recording.deadline && (
            <Banner tone="warning">This date is after the 30-day deadline. The IRS does not accept late elections; record it only if it reflects what happened.</Banner>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRecording(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
