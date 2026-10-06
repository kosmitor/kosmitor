/**
 * One SAFE, note or KISS, in full.
 *
 * The convertibles list answers "who put money in on what terms"; this page
 * answers everything else about a single instrument: what it cost, the cap and
 * discount that decide its price later, the interest it is accruing, when it
 * comes due, and what it would turn into if it converted today. The conversion
 * figures come from the same solver the cap table uses, so the page and the
 * table can never disagree.
 */
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { RecordPage, RecordSection, RecordColumns, RecordTimeline, RecordMissing } from '../RecordPage.tsx';
import {
  Badge, Loading, ErrorNote, EmptyState, MiniBar, KeyValue, Banner,
} from '../ui.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { money, shares, percent, date, relativeDate, today, INSTRUMENT_LABELS } from '../format.ts';

export default function ConvertibleDetail() {
  const { id } = useParams<{ id: string }>();
  const { companyId, canEdit } = useSession();
  const navigate = useNavigate();
  const { data, error, errorStatus, loading, reload } = useQuery<any>(
    companyId && id ? `/c/${companyId}/convertibles/${id}/detail` : null, [companyId, id]);

  if (loading) return <Loading label="Loading instrument" />;
  if (error) {
    // A holder who opens someone else's instrument is told it is not there, because
    // that is what the server says: it answers 404 rather than admitting it exists.
    return errorStatus === 404 ? (
      <RecordMissing icon="convert" title="That instrument is not here"
        description="It may have been deleted, or it belongs to another holder."
        to="/convertibles" label="Back to SAFEs and notes" />
    ) : <ErrorNote error={error} onRetry={reload} />;
  }
  if (!data) return null;

  const { convertible, holder, conversion, amounts, timeline } = data;
  const label = convertible.label ?? String(convertible.id).slice(-6).toUpperCase();
  const instrument = INSTRUMENT_LABELS[convertible.instrument] ?? convertible.instrument;
  const isNote = convertible.instrument === 'NOTE';
  const matured = convertible.maturityDate != null && String(convertible.maturityDate) <= today();
  const accruedInterest = conversion ? conversion.amount - conversion.principal : 0;

  const actions = [
    ...(holder
      ? [{ label: 'See everything this holder has', icon: 'users' as const,
          onClick: () => navigate(`/stakeholders/${holder.id}`) }] : []),
    { label: 'Model the round it converts in', icon: 'trending' as const, onClick: () => navigate('/model/round') },
    ...(canEdit
      ? [{ label: 'Edit on the SAFEs and notes page', icon: 'edit' as const, onClick: () => navigate('/convertibles') }] : []),
  ];

  return (
    <RecordPage back="/convertibles" backLabel="All SAFEs and notes"
      title={label} status={convertible.status}
      badges={<Badge tone={isNote ? 'warning' : 'brand'}>{instrument}</Badge>}
      subtitle={`${money(amounts.principal)} invested ${date(convertible.issueDate)}`}
      actions={actions} concept="convertible-record">

      {matured && convertible.status === 'OUTSTANDING' && (
        <div className="mb-5">
          <Banner tone="warning" title="This instrument has passed its maturity date">
            It came due on {date(convertible.maturityDate)} and is still outstanding. A matured note is repayable on
            demand unless the holder agrees to extend it or to convert, so the two sides normally settle in writing
            which of those happened.
          </Banner>
        </div>
      )}

      <RecordColumns>
        <RecordSection first title="Overview" className="lg:col-span-2">
          {conversion?.impliedOwnershipPct != null && (
            <div className="mb-4">
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-ink-600">The percentage this instrument is promised on conversion</span>
                <span className="text-[13px] font-medium tabular">{percent(conversion.impliedOwnershipPct)}</span>
              </div>
              <MiniBar value={conversion.impliedOwnershipPct} />
            </div>
          )}
          <KeyValue columns={3} items={[
            { label: 'Principal', value: money(amounts.principal) },
            { label: 'Valuation cap', value: amounts.valuationCap == null ? 'Uncapped' : money(amounts.valuationCap) },
            { label: 'Discount', value: amounts.discount ? percent(amounts.discount, 0) : 'None' },
            {
              label: 'Interest rate',
              value: amounts.interestRate
                ? `${percent(amounts.interestRate, 1)} ${String(convertible.compounding).toLowerCase()}`
                : 'None',
            },
            { label: 'Issue date', value: date(convertible.issueDate) },
            {
              label: 'Maturity date',
              value: convertible.maturityDate
                ? `${date(convertible.maturityDate)} (${relativeDate(convertible.maturityDate)})`
                : 'No maturity date',
            },
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
            {
              label: 'This holder owns in total',
              value: `${shares(amounts.holderFullyDiluted)} fully diluted, ${percent(amounts.holderFullyDilutedPct)} of the company`,
            },
          ]} />
        </RecordSection>
      </RecordColumns>

      <RecordSection title="What it would convert into"
        subtitle="An estimate on today's numbers, not a promise">
        {conversion ? (
          <>
            <div className="mb-4">
              <Banner tone="info" title="These figures move with the next round">
                A convertible has no share count of its own. What it converts into is decided by the price of the next
                priced round, the cap and the discount, and by how much money comes in alongside it. Until that round is
                signed, every figure below is what today's cap table implies and nothing more.
              </Banner>
            </div>
            <KeyValue columns={3} items={[
              { label: 'Principal', value: money(conversion.principal) },
              { label: 'Interest accrued so far', value: accruedInterest > 0 ? money(accruedInterest) : 'None' },
              { label: 'Amount that would convert', value: money(conversion.amount) },
              {
                label: 'Percentage it is promised',
                value: conversion.impliedOwnershipPct == null
                  ? 'Decided by the round price'
                  : percent(conversion.impliedOwnershipPct),
              },
              { label: 'Valuation cap', value: conversion.cap == null ? 'Uncapped' : money(conversion.cap) },
              {
                label: 'Past maturity',
                value: conversion.matured ? <Badge tone="warning">Yes</Badge> : <Badge tone="neutral">No</Badge>,
              },
            ]} />
            {conversion.impliedOwnershipPct == null && (
              <p className="mt-4 text-[13px] leading-relaxed text-ink-600">
                Only a post-money SAFE with a valuation cap fixes its percentage in advance. Everything else converts at
                a price the next round sets, so the shares it buys are known only once that price exists.
              </p>
            )}
          </>
        ) : (
          <EmptyState title="Nothing would convert today"
            description="The estimate covers instruments that are outstanding and already issued. This one has converted, been repaid, been cancelled, or is dated in the future." />
        )}
      </RecordSection>

      <RecordSection title="Details">
        <KeyValue columns={3} items={[
          { label: 'Instrument', value: instrument },
          { label: 'Interest compounding', value: amounts.interestRate ? String(convertible.compounding).toLowerCase() : 'Not applicable' },
          { label: 'Most favoured nation', value: convertible.mfn ? 'Yes' : 'No' },
          { label: 'Pro rata right', value: convertible.proRataRight ? 'Yes' : 'No' },
          {
            label: 'Minimum round to trigger conversion',
            value: convertible.qualifiedFinancingMinimum ? money(convertible.qualifiedFinancingMinimum) : 'None recorded',
          },
          { label: 'Board approval date', value: date(convertible.boardApprovalDate) },
          {
            label: 'Funds received',
            value: convertible.fundsReceivedOn
              ? `${date(convertible.fundsReceivedOn)}${convertible.fundsReference ? ` · ${convertible.fundsReference}` : ''}`
              : 'Not recorded',
          },
          { label: 'Converted on', value: date(convertible.convertedOn) },
        ]} />
        <div className="mt-4">
          <KeyValue columns={1} items={[
            { label: 'Comments', value: convertible.notes ? <span className="whitespace-pre-line">{convertible.notes}</span> : '—' },
          ]} />
        </div>
      </RecordSection>

      <SecurityDocuments className="mt-5" securityId={convertible.id} stakeholderId={holder?.id ?? null}
        title="Documents"
        description="The paperwork filed against this instrument: the signed agreement, the board consent that approved it, side letters." />

      <RecordTimeline events={timeline} subtitle="Everything recorded against this instrument, newest first"
        emptyTitle="Nothing has happened to this instrument yet"
        emptyDescription="Signatures, conversions, repayments and edits all land here." />
    </RecordPage>
  );
}
