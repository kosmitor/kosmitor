import { useSession } from '../../session.tsx';
import { useQuery } from '../../api.ts';
import { Card, CardHeader, Table, TH, TD, TR, Badge, Loading, ErrorNote, EmptyState, MiniBar, KeyValue, InfoDot } from '../../ui.tsx';
import { money, shares, date, percent } from '../../format.ts';
import { SecurityDocuments } from '../../SecurityDocuments.tsx';

/** The Rule 701 exemption over the rolling twelve months. */
export default function Rule701() {
  const { companyId, canViewAll } = useSession();
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/compliance` : null, [companyId]);
  if (!canViewAll) return <EmptyState title="Compliance is not available for your role" />;
  if (loading) return <Loading label="Measuring Rule 701 headroom" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const r = data.rule701;

  return (
    <>
      <div className="space-y-5">
        <Card>
          <CardHeader title="Rule 701 exemption" subtitle={`Rolling twelve months from ${date(r.periodStart)} to ${date(r.periodEnd)}`} />
          <div className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[13px] text-ink-600">{money(r.aggregateValue, { compact: true })} granted of a {money(r.applicableLimit, { compact: true })} limit</span>
              <span className={`text-[13px] font-medium tabular ${r.exceeded ? 'text-red-600' : 'text-ink-900'}`}>{percent(r.aggregateValue / (r.applicableLimit || 1), 1)} used</span>
            </div>
            <MiniBar value={r.aggregateValue / (r.applicableLimit || 1)} tone={r.exceeded ? 'amber' : 'brand'} />
          </div>
          <KeyValue columns={2} items={[
            { label: <>Cash limit<InfoDot text="A flat $1,000,000 in any rolling twelve-month period." /></>, value: money(r.cashLimit, { compact: true }) },
            { label: '15% of total assets', value: money(r.assetsLimit, { compact: true }) },
            { label: '15% of outstanding common (share test)', value: `${shares(r.sharesLimit)} shares — ${shares(r.sharesSold)} granted` },
            { label: 'Applicable limit (the greatest of the three)', value: <span className="font-semibold">{money(r.applicableLimit, { compact: true })}</span> },
            { label: 'Headroom remaining', value: money(r.headroom, { compact: true }) },
            { label: 'Enhanced disclosure threshold', value: r.disclosureThresholdMet ? <Badge tone="warning">Exceeded $10M — disclosure required</Badge> : <Badge tone="success">Below $10M</Badge> },
          ]} />
          <p className="mt-4 rounded-lg bg-ink-50 p-3 text-[12px] leading-relaxed text-ink-600">
            Rule 701 exempts compensatory equity grants by a private company from registration. The exemption holds if any one of the three
            ceilings is respected — the share-count prong is compared in shares, not dollars. Set the company's total assets in Settings so the
            15% of assets test uses a real figure.
          </p>
        </Card>
        <Card padded={false}>
          <div className="p-5 pb-0"><CardHeader title="Grants in the period" /></div>
          {r.grants.length === 0 ? <EmptyState title="No grants in the last twelve months" /> : (
            <Table>
              <thead><tr><TH>Date</TH><TH>Recipient</TH><TH align="right">Value counted</TH></tr></thead>
              <tbody>
                {r.grants.map((g: any) => (
                  <TR key={g.awardId}><TD className="text-ink-600">{date(g.date)}</TD><TD className="font-medium">{g.stakeholderName}</TD><TD align="right" mono>{money(g.value)}</TD></TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {/* The test is a calculation over a rolling window, not a row, so its working
            papers are filed against a subject. The window itself cannot be that
            subject: it is measured back from today, so it moves every day and a
            document filed against it would be unreachable tomorrow. They are kept
            by calendar year instead, which is how the paperwork is produced anyway. */}
        <SecurityDocuments title={`Documents for ${String(r.periodEnd).slice(0, 4)}`}
          description={`Filed against the Rule 701 test for ${String(r.periodEnd).slice(0, 4)}. The test measures a rolling twelve months, which moves daily, so its papers are kept by year.`}
          subject={{ kind: 'RULE_701', ref: String(r.periodEnd).slice(0, 4) }} />
      </div>
    </>
  );
}
