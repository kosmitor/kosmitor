import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, downloadFile } from '../api.ts';
import { PageHeader, Card, CardHeader, Table, TH, TD, TR, Badge, Loading, ErrorNote, EmptyState, Stat, Banner, Button, Select, Field, KeyValue, useToast } from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { money, shares, pps, date, percent } from '../format.ts';

/** Stock-based compensation expense under ASC 718 / IFRS 2, by fiscal year. */
export default function StockComp() {
  const { companyId, canViewAll, isAdmin } = useSession();
  const toast = useToast();
  const [year, setYear] = useState('');
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/reports/stock-comp${year ? `?year=${year}` : ''}` : null, [companyId, year]);

  if (!canViewAll) return <EmptyState title="Stock compensation reporting is not available for your role" />;
  if (loading && !data) return <Loading label="Valuing awards and attributing expense" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const r = data.report;
  const a = r.assumptions;
  const rf = r.rollforward;
  const yrs = (n: number) => `${n.toFixed(1)} yr${n === 1 ? '' : 's'}`;

  return (
    <>
      <PageHeader concept="stock-comp" title="Stock-based compensation" subtitle={`${a.standard === 'IFRS' ? 'IFRS 2' : 'ASC 718'} expense for ${r.period.label} (${date(r.period.start)} – ${date(r.period.end)})`}
        actions={
          <div className="flex items-center gap-2">
            <Select value={String(r.period.label.replace('FY', ''))} onChange={(e) => setYear(e.target.value)} className="w-32">
              {data.years.map((y: number) => <option key={y} value={y}>FY{y}</option>)}
            </Select>
            <Button icon={<Icon name="download" />} disabled={r.awards.length === 0}
              onClick={() => downloadFile(`/c/${companyId}/reports/stock-comp.csv?year=${r.period.label.replace('FY', '')}`, `stock-comp-${r.period.label}.csv`).catch((e: Error) => toast(e.message, 'error'))}>
              Export CSV
            </Button>
          </div>
        } />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={`Expense ${r.period.label}`} value={money(r.totals.expense, { compact: true })} hint={Object.entries(r.totals.byType).map(([t, v]) => `${t} ${money(v as number, { compact: true })}`).join(' · ') || 'No awards in service'} />
        <Stat label="Recognised to date" value={money(r.totals.cumulative, { compact: true })} hint={`Through ${date(r.period.end)}`} />
        <Stat label="Unrecognised cost" value={money(r.totals.unrecognized, { compact: true })} hint={r.totals.unrecognized > 0 ? `over a weighted ${yrs(r.totals.weightedRemainingYears)}` : 'Everything has been expensed'} />
        <Card>
          <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">By quarter</p>
          <ul className="mt-2 space-y-1 text-[13px]">
            {r.quarters.map((q: any) => <li key={q.period.label} className="flex justify-between"><span className="text-ink-600">{q.period.label}</span><span className="tabular font-medium">{money(q.expense, { compact: true })}</span></li>)}
          </ul>
        </Card>
      </div>

      {!data.assumptionsSet && (
        <div className="mb-5">
          <Banner tone="warning" title="Using default valuation assumptions">
            {/* The defaults are stockComp.defaultAssumptions in the param file, so each one is said as it is. */}
            Volatility {percent(a.volatility, 0)}, risk-free {percent(a.riskFreeRate, 1)},
            {' '}{a.dividendYield ? `dividend yield ${percent(a.dividendYield, 1)}` : 'no dividends'},
            {' '}{a.expectedTermYears ? `expected term ${yrs(a.expectedTermYears)}` : 'simplified expected term'}, {a.attribution === 'GRADED' ? 'graded' : 'straight-line'} attribution,
            forfeitures {a.forfeiturePolicy === 'AS_OCCUR' ? 'as they occur' : `estimated at ${percent(a.forfeitureRate, 0)} a year`}.
            {isAdmin ? <> Set the company's own assumptions on the <Link className="font-medium underline" to="/company#stock-comp">Company page</Link> — auditors will ask where they come from.</> : ' An administrator can set the company\'s own on the Company page.'}
          </Banner>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <Card padded={false}>
            <div className="p-5 pb-0"><CardHeader title="Expense by award" subtitle="Grant-date fair value attributed over each award's service period" /></div>
            {r.awards.length === 0 ? <EmptyState title="No awards to expense" description="Options, RSUs and other awards appear here from the fiscal year they are granted." /> : (
              <Table>
                <thead>
                  <tr>
                    <TH>Award</TH><TH>Holder</TH><TH>Type</TH><TH>Granted</TH><TH align="right">Quantity</TH><TH align="right">Fair value / share</TH>
                    <TH align="right">Total fair value</TH><TH align="right">Expense {r.period.label}</TH><TH align="right">Recognised</TH><TH align="right">Unrecognised</TH><TH>Status</TH>
                  </tr>
                </thead>
                <tbody>
                  {r.awards.map((x: any) => (
                    <TR key={x.awardId} className={x.expense < 0 ? 'bg-amber-50/30' : undefined}>
                      <TD className="font-medium">{x.label ?? x.awardId.slice(-6)}</TD>
                      <TD><span className="block">{x.stakeholderName}</span>{x.department && <span className="block text-[11px] text-ink-500">{x.department}</span>}</TD>
                      <TD><Badge tone={x.type === 'ISO' ? 'brand' : x.type === 'RSU' ? 'info' : 'neutral'}>{x.type}</Badge></TD>
                      <TD className="text-ink-600">{date(x.grantDate)}</TD>
                      <TD align="right" mono>{shares(x.quantity)}</TD>
                      <TD align="right" mono>{pps(x.fairValuePerShare)}</TD>
                      <TD align="right" mono>{money(x.totalFairValue)}</TD>
                      <TD align="right" mono className={x.expense < 0 ? 'font-medium text-amber-700' : 'font-medium'}>{money(x.expense)}</TD>
                      <TD align="right" mono className="text-ink-600">{money(x.cumulative)}</TD>
                      <TD align="right" mono className="text-ink-600">{money(x.unrecognized)}</TD>
                      <TD><span className="capitalize">{x.status.toLowerCase()}</span>{x.cancelledQuantity > 0 && <span className="block text-[11px] text-ink-500">{shares(x.cancelledQuantity)} forfeited{x.cancellationDate ? ` ${date(x.cancellationDate)}` : ''}</span>}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0"><CardHeader title="Option activity" subtitle={`Footnote roll-forward for options and SARs, ${r.period.label}`} /></div>
            <Table>
              <thead><tr><TH></TH><TH align="right">Options</TH><TH align="right">Weighted-average exercise price</TH><TH align="right">Weighted-average remaining term</TH><TH align="right">Aggregate intrinsic value</TH></tr></thead>
              <tbody>
                <TR><TD>Outstanding at {date(r.period.start)}</TD><TD align="right" mono>{shares(rf.outstandingStart.count)}</TD><TD align="right" mono>{pps(rf.outstandingStart.waep)}</TD><TD /><TD /></TR>
                <TR><TD>Granted</TD><TD align="right" mono>{shares(rf.granted.count)}</TD><TD align="right" mono>{pps(rf.granted.waep)}</TD><TD colSpan={2} className="text-[12px] text-ink-500">weighted-average grant-date fair value {pps(rf.granted.fairValuePerShare)}</TD></TR>
                <TR><TD>Exercised</TD><TD align="right" mono>({shares(rf.exercised.count)})</TD><TD align="right" mono>{pps(rf.exercised.waep)}</TD><TD /><TD /></TR>
                <TR><TD>Forfeited</TD><TD align="right" mono>({shares(rf.forfeited.count)})</TD><TD align="right" mono>{pps(rf.forfeited.waep)}</TD><TD /><TD /></TR>
                <TR><TD>Expired</TD><TD align="right" mono>({shares(rf.expired.count)})</TD><TD align="right" mono>{pps(rf.expired.waep)}</TD><TD /><TD /></TR>
                <TR className="font-medium"><TD>Outstanding at {date(r.period.end)}</TD><TD align="right" mono>{shares(rf.outstandingEnd.count)}</TD><TD align="right" mono>{pps(rf.outstandingEnd.waep)}</TD><TD align="right" mono>{yrs(rf.outstandingEnd.remainingContractualYears)}</TD><TD align="right" mono>{money(rf.outstandingEnd.intrinsicValue, { compact: true })}</TD></TR>
                <TR><TD>Exercisable at {date(r.period.end)}</TD><TD align="right" mono>{shares(rf.exercisableEnd.count)}</TD><TD align="right" mono>{pps(rf.exercisableEnd.waep)}</TD><TD align="right" mono>{yrs(rf.exercisableEnd.remainingContractualYears)}</TD><TD align="right" mono>{money(rf.exercisableEnd.intrinsicValue, { compact: true })}</TD></TR>
              </tbody>
            </Table>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Valuation assumptions" subtitle={data.assumptionsSet ? 'Set by the company' : 'Defaults'} />
            <KeyValue columns={1} items={[
              { label: 'Model', value: 'Black–Scholes for options and SARs; grant-date FMV for RSUs and RSAs' },
              { label: 'Expected volatility', value: percent(a.volatility, 0) },
              { label: 'Risk-free rate', value: percent(a.riskFreeRate, 2) },
              { label: 'Dividend yield', value: percent(a.dividendYield, 1) },
              { label: 'Expected term', value: a.expectedTermYears ? yrs(a.expectedTermYears) : 'Simplified method (midpoint of vesting and contractual term, per tranche)' },
              { label: 'Attribution', value: a.attribution === 'GRADED' ? 'Graded — each tranche over its own service period' : 'Straight-line over the total service period, floored at the vested value' },
              { label: 'Forfeitures', value: a.forfeiturePolicy === 'AS_OCCUR' ? 'Recognised as they occur' : `Estimated at ${percent(a.forfeitureRate, 1)} a year, trued up on vesting` },
              { label: 'Standard', value: a.standard === 'IFRS' ? 'IFRS 2 (graded attribution required)' : 'US GAAP — ASC 718' },
            ]} />
            {isAdmin && <div className="mt-4"><Link to="/company#stock-comp"><Button size="sm">Change assumptions</Button></Link></div>}
          </Card>
          <Card padded={false}>
            <div className="p-5 pb-0"><CardHeader title="By department" subtitle="Expense allocated by the holder's department" /></div>
            <Table>
              <thead><tr><TH>Department</TH><TH align="right">Awards</TH><TH align="right">Expense</TH></tr></thead>
              <tbody>
                {r.byDepartment.map((d: any) => (
                  <TR key={d.department}><TD className={d.department === 'Unassigned' ? 'text-ink-500' : 'font-medium'}>{d.department}</TD><TD align="right" mono>{d.awards}</TD><TD align="right" mono>{money(d.expense)}</TD></TR>
                ))}
                {r.byDepartment.length === 0 && <TR><TD colSpan={3} className="py-6 text-center text-ink-500">Nothing to allocate</TD></TR>}
              </tbody>
            </Table>
            {r.byDepartment.some((d: any) => d.department === 'Unassigned') && (
              <p className="px-5 py-3 text-[12px] text-ink-500">Set a department on each stakeholder (or import one) to split the expense by cost centre.</p>
            )}
          </Card>
          {r.excluded.length > 0 && (
            <Banner tone="warning" title={`${r.excluded.length} award${r.excluded.length === 1 ? '' : 's'} left out`}>
              {r.excluded.map((e: any) => `${e.label ?? e.awardId}: ${e.reason}`).join('; ')}.
            </Banner>
          )}
        </div>
      </div>
    </>
  );
}
