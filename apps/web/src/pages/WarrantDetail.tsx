/**
 * One warrant, in full.
 *
 * The warrants list answers "who can buy shares later"; this page answers
 * everything else about a single warrant: how much of it is still unexercised,
 * what buying those shares would cost against what they are worth today, which
 * class they would come from, and the date after which none of it is worth
 * anything. It reads one endpoint, so every number comes from the same
 * computation of the cap table.
 */
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { RecordPage, RecordSection, RecordColumns, RecordTimeline, RecordMissing } from '../RecordPage.tsx';
import { Badge, Loading, ErrorNote, MiniBar, KeyValue, Banner } from '../ui.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { money, shares, pps, percent, date, relativeDate, RELATION_LABELS } from '../format.ts';

export default function WarrantDetail() {
  const { id } = useParams<{ id: string }>();
  const { companyId, canEdit } = useSession();
  const navigate = useNavigate();
  const { data, error, errorStatus, loading, reload } = useQuery<any>(
    companyId && id ? `/c/${companyId}/warrants/${id}/detail` : null, [companyId, id]);

  if (loading) return <Loading label="Loading warrant" />;
  if (error) {
    // A holder who opens someone else's warrant is told it is not there, because
    // that is what the server says: it answers 404 rather than admitting it exists.
    return errorStatus === 404 ? (
      <RecordMissing icon="ticket" title="That warrant is not here"
        description="It may have been deleted, or it belongs to another holder."
        to="/warrants" label="Back to warrants" />
    ) : <ErrorNote error={error} onRetry={reload} />;
  }
  if (!data) return null;

  const { warrant, holder, shareClass, amounts, timeline } = data;
  const label = `Warrant ${String(warrant.id).slice(-6).toUpperCase()}`;
  const exercisedShare = warrant.quantity > 0 ? amounts.exercised / warrant.quantity : 0;

  const actions = [
    ...(holder
      ? [{ label: 'See everything this holder has', icon: 'users' as const,
          onClick: () => navigate(`/stakeholders/${holder.id}`) }] : []),
    { label: 'Open the share classes', icon: 'layers' as const, onClick: () => navigate('/share-classes') },
    ...(canEdit
      ? [{ label: 'Edit on the warrants page', icon: 'edit' as const, onClick: () => navigate('/warrants') }] : []),
  ];

  return (
    <RecordPage back="/warrants" backLabel="All warrants"
      title={label} status={warrant.status}
      badges={shareClass && <Badge tone={shareClass.kind === 'PREFERRED' ? 'purple' : 'neutral'}>{shareClass.name}</Badge>}
      subtitle={`${shares(warrant.quantity)} shares at ${pps(amounts.strikePrice)} issued ${date(warrant.issueDate)}`}
      actions={actions} concept="warrant-record">

      {amounts.expired && amounts.outstanding > 0 && (
        <div className="mb-5">
          <Banner tone="danger" title="This warrant has expired">
            It expired on {date(warrant.expirationDate)} with {shares(amounts.outstanding)} shares never bought. A
            warrant delivers nothing after its expiry date, and those shares leave the fully diluted count.
          </Banner>
        </div>
      )}

      <RecordColumns>
        <RecordSection first title="Overview" className="lg:col-span-2">
          <div className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-ink-600">How much of this warrant has been exercised</span>
              <span className="text-[13px] font-medium tabular">{percent(exercisedShare)}</span>
            </div>
            <MiniBar value={exercisedShare} />
          </div>
          <KeyValue columns={3} items={[
            { label: 'Shares under warrant', value: shares(warrant.quantity) },
            { label: 'Still outstanding', value: shares(amounts.outstanding) },
            { label: 'Already exercised', value: amounts.exercised ? shares(amounts.exercised) : '—' },
            { label: 'Strike price', value: pps(amounts.strikePrice) },
            {
              label: 'Shares it buys',
              value: shareClass
                ? <Link to="/share-classes" className="font-medium text-brand-600 hover:text-brand-700">{shareClass.name}</Link>
                : '—',
            },
            { label: 'Issue date', value: date(warrant.issueDate) },
          ]} />
        </RecordSection>

        <RecordSection first title="Holder">
          <KeyValue columns={1} items={[
            {
              label: 'Name',
              value: holder
                ? <Link to={`/stakeholders/${holder.id}`} className="font-medium text-brand-600 hover:text-brand-700">{holder.name}</Link>
                : '—',
            },
            { label: 'Email', value: holder?.email ?? '—' },
            { label: 'Relation to the company', value: holder ? RELATION_LABELS[holder.relation] ?? holder.relation : '—' },
          ]} />
        </RecordSection>
      </RecordColumns>

      <RecordSection title="What it is worth today"
        subtitle={`Measured against a fair market value of ${pps(amounts.fmv)} per share`}>
        {amounts.underwater && (
          <div className="mb-4">
            <Banner tone="warning" title="This warrant is underwater">
              The strike price of {pps(amounts.strikePrice)} is above the current fair market value of {pps(amounts.fmv)}.
              Exercising today would cost more than the shares are worth, so the warrant is worth nothing until the
              share price passes the strike price again.
            </Banner>
          </div>
        )}
        <KeyValue columns={3} items={[
          { label: 'Fair market value per share', value: pps(amounts.fmv) },
          { label: 'Gain per share', value: amounts.spreadPerShare > 0 ? pps(amounts.spreadPerShare) : 'None' },
          {
            label: 'What the outstanding shares are worth',
            value: amounts.underwater ? 'Underwater' : money(amounts.intrinsicValue),
          },
          { label: 'Cost to exercise everything outstanding', value: money(amounts.costToExercise) },
        ]} />
      </RecordSection>

      <RecordSection title="Details">
        <KeyValue columns={3} items={[
          {
            label: 'Expires on',
            value: warrant.expirationDate
              ? `${date(warrant.expirationDate)}${amounts.expired ? ' (passed)' : ` (${relativeDate(warrant.expirationDate)})`}`
              : 'No expiry recorded',
          },
          {
            label: 'Exercise method',
            value: warrant.netExercise ? 'Net exercise permitted' : 'Cash only',
          },
          { label: 'Share class', value: shareClass?.name ?? '—' },
        ]} />
        <div className="mt-4">
          <KeyValue columns={1} items={[
            { label: 'Comments', value: warrant.notes ? <span className="whitespace-pre-line">{warrant.notes}</span> : '—' },
          ]} />
        </div>
      </RecordSection>

      <SecurityDocuments className="mt-5" securityId={warrant.id} stakeholderId={holder?.id ?? null}
        title="Documents"
        description="The paperwork filed against this warrant: the signed agreement, the board consent that approved it, side letters." />

      <RecordTimeline events={timeline} subtitle="Everything recorded against this warrant, newest first"
        emptyTitle="Nothing has happened to this warrant yet"
        emptyDescription="Signatures, exercises, expiries and edits all land here." />
    </RecordPage>
  );
}
