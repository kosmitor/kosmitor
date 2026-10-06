/**
 * One equity award, in full.
 *
 * The grants list answers "who was given what"; this page answers everything
 * else about a single award: how much of it is still live, what it would cost
 * to exercise and what that would be worth, where it has reached in its
 * vesting, the deadlines that end it, and what has happened to it so far. It
 * reads one endpoint, so every number on the page comes from the same
 * computation of the cap table.
 */
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { RecordPage, RecordSection, RecordColumns, RecordTimeline, RecordMissing } from '../RecordPage.tsx';
import {
  Badge, Loading, ErrorNote, EmptyState, MiniBar, KeyValue, StatusBadge, Banner,
  Table, TH, TD, TR,
} from '../ui.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { HoldingDocumentField, AWARD_AGREEMENT } from '../HoldingDocumentField.tsx';
import { VestingChart } from '../charts.tsx';
import {
  money, shares, pps, percent, date, relativeDate, dateTime, today,
  AWARD_LABELS, RELATION_LABELS,
} from '../format.ts';

/** How a holder said they would pay for the shares, in the words the request form uses. */
const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash', NET_EXERCISE: 'Net exercise', CASHLESS: 'Cashless', PROMISSORY_NOTE: 'Promissory note',
};

export default function AwardDetail() {
  const { id } = useParams<{ id: string }>();
  const { companyId, canEdit } = useSession();
  const navigate = useNavigate();
  const { data, error, errorStatus, loading, reload } = useQuery<any>(
    companyId && id ? `/c/${companyId}/awards/${id}/detail` : null, [companyId, id]);

  if (loading) return <Loading label="Loading equity award" />;
  if (error) {
    // A holder who opens someone else's grant is told it is not there, because that
    // is what the server says: it answers 404 rather than admitting the record exists.
    return errorStatus === 404 ? (
      <RecordMissing icon="award" title="That grant is not here"
        description="It may have been deleted, or it belongs to another holder."
        to="/grants" label="Back to equity awards" />
    ) : <ErrorNote error={error} onRetry={reload} />;
  }
  if (!data) return null;

  const { award, holder, plan, amounts, vesting, exercisable, isoLimit, exerciseRequests, timeline } = data;
  // The newest award agreement filed against this grant. The detail endpoint returns
  // documents newest first, so the first match is the current one.
  const agreement = (data.documents ?? []).find((d: any) => d.category === 'GRANT_AGREEMENT') ?? null;
  const label = award.label ?? String(award.id).slice(-6).toUpperCase();
  // A restricted stock unit is delivered rather than bought, so the price columns do not apply to it.
  const priced = award.type !== 'RSU';
  const asOf = today();

  const deadline: string | null = exercisable.postTerminationDeadline;
  const deadlinePassed = deadline != null && deadline < asOf;
  const expiryPassed = award.expirationDate != null && String(award.expirationDate) < asOf;
  const shareOfPlan = plan && plan.authorized > 0 ? award.quantity / plan.authorized : null;

  const acceleration = vesting?.acceleration;
  const accelerationText = [
    acceleration?.single ? `${percent(acceleration.single, 0)} on a single trigger` : null,
    acceleration?.double ? `${percent(acceleration.double, 0)} on a double trigger` : null,
    acceleration?.months ? `${acceleration.months} months of extra vesting credit` : null,
  ].filter(Boolean).join(', ') || 'None';

  // Everything a grant can be changed by lives on the list page, which owns the
  // forms for it; this page reads, and sends you there to act.
  const actions = [
    ...(holder
      ? [{ label: 'See everything this holder has', icon: 'users' as const,
          onClick: () => navigate(`/stakeholders/${holder.id}`) }] : []),
    { label: 'Open the equity plan', icon: 'layers' as const, onClick: () => navigate('/plans') },
    ...(canEdit
      ? [{ label: 'Edit on the equity awards page', icon: 'edit' as const, onClick: () => navigate('/grants') }] : []),
  ];

  return (
    <RecordPage back="/grants" backLabel="All equity awards"
      title={label} status={award.status}
      badges={<Badge tone={award.type === 'ISO' ? 'brand' : award.type === 'RSU' ? 'info' : 'neutral'}>
        {AWARD_LABELS[award.type] ?? award.type}
      </Badge>}
      subtitle={`${shares(award.quantity)} granted ${date(award.grantDate)}`}
      actions={actions} concept="award-record">

      {/* Only worth shouting about while there is still something left to exercise. */}
      {deadline && amounts.outstanding > 0 && (
        <div className="mb-5">
          <Banner tone={deadlinePassed ? 'danger' : 'warning'}
            title={deadlinePassed ? 'The exercise window has closed' : 'This holder has left and the clock is running'}>
            {holder?.name ?? 'The holder'} left the company, which started the
            {' '}{exercisable.postTerminationMonths} month window this grant sets for exercising.
            {deadlinePassed
              ? ` It ended on ${date(deadline)}, so anything still unexercised is gone.`
              : ` Options not exercised by ${date(deadline)} (${relativeDate(deadline)}) are lost.`}
          </Banner>
        </div>
      )}

      <RecordColumns>
        <RecordSection first title="Overview" className="lg:col-span-2">
          {shareOfPlan != null && (
            <div className="mb-4">
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-ink-600">This grant as a share of the {plan.name} reserve</span>
                <span className="text-[13px] font-medium tabular">{percent(shareOfPlan)}</span>
              </div>
              <MiniBar value={shareOfPlan} />
            </div>
          )}
          <KeyValue columns={3} items={[
            { label: 'Granted', value: shares(award.quantity) },
            { label: 'Outstanding', value: shares(amounts.outstanding) },
            { label: 'Exercised', value: amounts.exercised ? shares(amounts.exercised) : '—' },
            { label: 'Cancelled', value: amounts.cancelled ? shares(amounts.cancelled) : '—' },
            { label: 'Strike price', value: priced ? pps(amounts.strikePrice) : 'No purchase price' },
            { label: 'Fair market value at grant', value: pps(amounts.fmvAtGrant) },
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
            {
              label: 'Plan',
              value: plan
                ? <Link to="/plans" className="font-medium text-brand-600 hover:text-brand-700">{plan.name}</Link>
                : '—',
            },
            {
              label: 'Award agreement',
              value: (
                <HoldingDocumentField kind={AWARD_AGREEMENT} document={agreement} securityId={award.id}
                  stakeholderId={holder?.id ?? null} stakeholderName={holder?.name ?? null}
                  onChange={reload} />
              ),
            },
          ]} />
        </RecordSection>
      </RecordColumns>

      <RecordSection title="What it is worth today"
        subtitle={`Measured against a fair market value of ${pps(amounts.fmv)} per share`}>
        {priced && amounts.underwater && (
          <div className="mb-4">
            <Banner tone="warning" title="This grant is underwater">
              The strike price of {pps(amounts.strikePrice)} is above the current fair market value of {pps(amounts.fmv)}.
              Exercising today would cost more than the shares are worth, so the grant is worth nothing until the
              share price passes the strike price again.
            </Banner>
          </div>
        )}
        <KeyValue columns={3} items={[
          { label: 'Fair market value per share', value: pps(amounts.fmv) },
          {
            label: priced ? 'Gain per share' : 'Value per unit',
            value: amounts.spreadPerShare > 0 ? pps(amounts.spreadPerShare) : 'None',
          },
          {
            label: priced ? 'What the outstanding options are worth' : 'What the outstanding units are worth',
            value: amounts.underwater ? 'Underwater' : money(amounts.intrinsicValue),
          },
          ...(priced ? [
            { label: 'Cost to exercise everything outstanding', value: money(amounts.costToExercise) },
            { label: 'Shares that would be bought', value: shares(amounts.outstanding) },
          ] : []),
        ]} />
      </RecordSection>

      <RecordSection title="Details">
        <KeyValue columns={3} items={[
          { label: 'Award type', value: AWARD_LABELS[award.type] ?? award.type },
          { label: 'Grant date', value: date(award.grantDate) },
          { label: 'Vesting start date', value: date(award.vestingStartDate) },
          { label: 'Board approval date', value: date(award.boardApprovalDate) },
          { label: 'Accepted by the holder', value: date(award.acceptedDate) },
          { label: 'Early exercise', value: award.earlyExerciseAllowed ? 'Allowed before vesting' : 'Not allowed' },
          ...(award.type === 'RSU' ? [{
            label: 'Liquidity condition',
            value: award.rsuLiquidityCondition ? 'Shares deliver only after a liquidity event' : 'None',
          }] : []),
          { label: 'Acceleration', value: accelerationText },
        ]} />
        <div className="mt-4">
          <KeyValue columns={1} items={[
            { label: 'Comments', value: award.notes ? <span className="whitespace-pre-line">{award.notes}</span> : '—' },
          ]} />
        </div>
      </RecordSection>

      <RecordSection title="Exercise window" subtitle="When the right to buy these shares ends">
        <KeyValue columns={3} items={[
          {
            label: 'Exercisable now',
            value: exercisable.live
              ? <Badge tone="success">Yes</Badge>
              : <Badge tone="neutral">No</Badge>,
          },
          {
            label: 'Expires on',
            value: award.expirationDate
              ? `${date(award.expirationDate)}${expiryPassed ? ' (passed)' : ` (${relativeDate(award.expirationDate)})`}`
              : 'No expiry recorded',
          },
          {
            label: 'Window after leaving',
            value: `${exercisable.postTerminationMonths} months`,
          },
          ...(deadline ? [{
            label: 'Deadline after leaving',
            value: (
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={deadlinePassed ? 'danger' : 'warning'}>{deadlinePassed ? 'Closed' : 'Open'}</Badge>
                {date(deadline)} ({relativeDate(deadline)})
              </span>
            ),
          }] : []),
        ]} />
      </RecordSection>

      {vesting && (
        <RecordSection title="Vesting" subtitle={vesting.scheduleName}>
          <div className="grid items-start gap-5 lg:grid-cols-[1fr_300px]">
            <div>
              <p className="mb-2 text-[13px] text-ink-600">
                {shares(vesting.summary.vested)} of {shares(award.quantity)}
                {' '}({percent(vesting.summary.percentVested, 1)}) have vested
              </p>
              <MiniBar value={vesting.summary.percentVested} />
              {vesting.curve?.length > 0 && (
                <div className="mt-4"><VestingChart data={vesting.curve} total={award.quantity} height={190} /></div>
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

      {award.type === 'ISO' && isoLimit.length > 0 && (
        <RecordSection title="The $100,000 limit"
          subtitle="Every incentive stock option this holder has, tested year by year">
          <div className="mb-4">
            <Banner tone={isoLimit.some((r: any) => r.exceeded) ? 'warning' : 'info'}
              title="Why other grants appear here">
              The limit under section 422(d) is measured per person per calendar year, not per grant, and grants count in
              the order they were made. So the rows below cover all of this holder's incentive stock options, and a later
              grant is the one that spills past the limit.
            </Banner>
          </div>
          <Table>
            <thead>
              <tr>
                <TH>Year</TH><TH>Grant</TH>
                <TH align="right">Shares first exercisable</TH><TH align="right">Value at grant</TH>
                <TH align="right">Cumulative</TH><TH align="right">Qualifies as ISO</TH>
                <TH align="right">Treated as NSO</TH><TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {isoLimit.map((r: any, i: number) => (
                <TR key={i} className={r.exceeded ? 'bg-amber-50/40' : undefined}>
                  <TD mono>{r.year}</TD>
                  <TD className={r.awardId === award.id ? 'font-medium' : 'text-ink-600'}>
                    {r.awardId === award.id ? `${r.awardLabel} (this grant)` : (
                      <Link to={`/grants/${r.awardId}`} className="hover:text-brand-700">{r.awardLabel}</Link>
                    )}
                  </TD>
                  <TD align="right" mono>{shares(r.sharesVesting)}</TD>
                  <TD align="right" mono>{money(r.valueAtGrant)}</TD>
                  <TD align="right" mono className={r.exceeded ? 'font-medium text-amber-700' : 'text-ink-600'}>{money(r.cumulativeValue)}</TD>
                  <TD align="right" mono>{shares(r.isoQualified)}</TD>
                  <TD align="right" mono className={r.nsoRecharacterized > 0 ? 'font-medium text-amber-700' : 'text-ink-400'}>
                    {r.nsoRecharacterized > 0 ? shares(r.nsoRecharacterized) : '—'}
                  </TD>
                  <TD>{r.exceeded ? <Badge tone="warning">Over limit</Badge> : <Badge tone="success">Within limit</Badge>}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </RecordSection>
      )}

      <RecordSection title="Exercise requests" subtitle="What the holder has asked to buy, and where each request stands">
        {exerciseRequests.length === 0 ? (
          <EmptyState title="No exercise requests against this grant"
            description="A holder raises a request from My equity, and it lands on the equity awards page for review." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Requested</TH><TH align="right">Options</TH><TH>Method</TH>
                <TH align="right">Cost</TH><TH align="right">Gain at the time</TH><TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {exerciseRequests.map((r: any) => (
                <TR key={r.id}>
                  <TD className="text-ink-600">{dateTime(r.requestedAt)}</TD>
                  <TD align="right" mono>{shares(r.quantity)}</TD>
                  <TD className="text-ink-600">{METHOD_LABELS[r.method] ?? r.method}</TD>
                  <TD align="right" mono>{money(r.estimatedCost)}</TD>
                  <TD align="right" mono className="text-ink-600">{money(r.spread)}</TD>
                  <TD><StatusBadge status={r.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </RecordSection>

      <SecurityDocuments className="mt-5" securityId={award.id} stakeholderId={holder?.id ?? null}
        title="Documents"
        description="The paperwork filed against this grant: the signed agreement, the board consent that approved it, side letters." />

      <RecordTimeline events={timeline} subtitle="Everything recorded against this grant, newest first"
        emptyTitle="Nothing has happened to this grant yet"
        emptyDescription="Signatures, exercises, cancellations and edits all land here." />
    </RecordPage>
  );
}
