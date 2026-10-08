import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import {
  Card, CardHeader, PageHeader, Stat, Badge, Loading, ErrorNote, EmptyState,
  MiniBar, Button, Banner, StatusBadge, Avatar,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { OwnershipDonut, ChartLegend } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { money, shares, percent, pps, date, relativeDate, dateTime, RELATION_LABELS } from '../format.ts';
import { config } from '../config.ts';
import { scoreGauge } from './compliance/shared.tsx';
import { ActionList, NothingWaiting, type MyAction } from '../MyActions.tsx';

export default function Dashboard() {
  const { companyId, company, canEdit } = useSession();
  const { data, error, loading, reload } = useQuery<any>(companyId ? `/c/${companyId}/dashboard` : null, [companyId]);
  const { data: mine, error: pendingError } = useQuery<{ items: MyAction[] }>(companyId ? `/c/${companyId}/my-actions` : null, [companyId]);
  const pending = mine?.items ?? null;

  if (loading) return <Loading label="Building your overview" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const t = data.totals;
  const poolPct = t.fullyDiluted > 0 ? t.poolAvailable / t.fullyDiluted : 0;
  // Scored with compliance.scoring: the server's own when it sends it, the page's copy otherwise.
  const gauge = scoreGauge(data.compliance.score, data.compliance.scoring ?? undefined);

  return (
    <>
      <PageHeader
        title={company?.name ?? 'Overview'}
        subtitle={`Fully diluted position as of ${date(data.asOf)}`}
      />

      {canEdit && data.topHolders.length === 0 && (
        <p className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-3 text-[13px] text-ink-700">
          <Icon name="inbox" className="size-4 text-brand-600" />
          Have a spreadsheet or a Pulley or Carta export?
          <Link to="/import" className="font-medium text-brand-600 hover:text-brand-700">Import your cap table</Link>
        </p>
      )}

      {data.warnings?.length > 0 && (
        <div className="mb-5">
          <Banner tone="warning" title="Cap table warnings">
            <ul className="list-disc space-y-0.5 pl-4">
              {data.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          </Banner>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Fully diluted shares" value={shares(t.fullyDiluted)}
          hint={`${shares(t.outstanding)} issued and outstanding`} />
        <Stat label="409A fair market value" value={pps(data.valuation)}
          hint={`Implies ${money(t.companyValue, { compact: true })} on a fully diluted basis`} />
        <Stat label="Capital raised" value={money(t.investedAmount, { compact: true })}
          hint={`Across ${data.classes.filter((c: any) => c.kind === 'PREFERRED').length} preferred rounds`} />
        <Stat label="Option pool available" value={shares(t.poolAvailable)}
          hint={`${percent(poolPct)} of fully diluted`}
          tone={poolPct < config.alerts.optionPoolLow ? 'warning' : 'default'} />
      </div>

      {/* Cards that may shrink, so a wide table scrolls inside its card rather than widening the page on a phone. */}
      <div className="mt-5 grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-1">
          <CardHeader title="Ownership" subtitle="Fully diluted, by group" />
          <OwnershipDonut data={data.groups} centerLabel="Fully diluted"
            centerValue={shares(t.fullyDiluted)} />
          <div className="mt-4 border-t border-ink-100 pt-4">
            <ChartLegend data={data.groups} />
          </div>
        </Card>

        {/* Largest first, as the cap table orders its holders. The card stretches to the height of the one beside it (grid). */}
        <DataTable className="grid lg:col-span-2" title="Largest holders" subtitle="By fully diluted ownership" caption="Largest holders"
          actions={<Link to="/cap-table"><Button size="sm" variant="ghost">View all</Button></Link>}
          rows={data.topHolders} rowKey={(r) => r.stakeholderId}
          defaultSort={{ key: 'fullyDiluted', direction: 'desc' }}
          empty={<p className="px-5 py-8 text-center text-[13px] text-ink-500">No holders yet.</p>}
          columns={[
            {
              key: 'holder', label: 'Holder', value: (r) => r.name,
              cell: (r) => (
                <Link to={`/stakeholders/${r.stakeholderId}`} className="flex items-center gap-2.5 hover:text-brand-700">
                  <Avatar name={r.name} size={26} />
                  <span className="min-w-0">
                    {/* Two thirds of the page wide beside the chart, the card has room for a name 12rem long
                        beside the figures in a 1280-pixel window; a longer one is cut there, whole on hover. */}
                    <span className="block max-w-48 truncate font-medium" title={r.name}>{r.name}</span>
                    <span className="block text-[11px] text-ink-500">{RELATION_LABELS[r.relation] ?? r.relation}</span>
                  </span>
                </Link>
              ),
            },
            { key: 'shares', label: 'Shares', type: 'number', value: (r) => r.outstanding },
            { key: 'options', label: 'Options', type: 'number', value: (r) => r.optionsOutstanding || null, className: 'text-ink-600' },
            { key: 'fullyDiluted', label: 'Fully diluted', type: 'number', value: (r) => r.fullyDiluted, className: 'font-medium' },
            {
              key: 'ownership', label: 'Ownership', width: 120, value: (r) => r.fullyDilutedPct,
              cell: (r) => (
                <div className="flex items-center gap-2">
                  <MiniBar value={r.fullyDilutedPct} />
                  <span className="w-12 shrink-0 text-right text-[12px] tabular text-ink-600">
                    {percent(r.fullyDilutedPct, 1)}
                  </span>
                </div>
              ),
            },
          ]} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Compliance & tax" subtitle="Automated checks across the company"
            action={<Link to="/compliance"><Button size="sm" variant="ghost">Review</Button></Link>} />
          <div className="flex items-center gap-4">
            <div className="relative grid size-20 shrink-0 place-items-center">
              <svg viewBox="0 0 36 36" className="absolute size-20 -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke={gauge.track} strokeWidth="4" />
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="4" strokeLinecap="round"
                  stroke={gauge.color}
                  strokeDasharray={`${gauge.filled * 97.4} 97.4`} />
              </svg>
              <span className="text-lg font-semibold tabular">{data.compliance.score}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-2">
                {data.compliance.errors > 0 && <Badge tone="danger">{data.compliance.errors} to fix</Badge>}
                {data.compliance.warnings > 0 && <Badge tone="warning">{data.compliance.warnings} to review</Badge>}
                {data.compliance.errors === 0 && data.compliance.warnings === 0 && <Badge tone="success">All clear</Badge>}
              </div>
              <ul className="mt-3 space-y-1.5">
                {data.compliance.top.slice(0, 3).map((i: any) => (
                  <li key={i.id} className="flex items-start gap-2 text-[12px] leading-snug text-ink-600">
                    <span className={`mt-1 size-1.5 shrink-0 rounded-full ${i.severity === 'ERROR' ? 'bg-red-500' : 'bg-amber-500'}`} />
                    <span className="truncate">{i.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Upcoming vesting" subtitle="Next tranches across all grants" />
          {data.upcomingVests.length === 0
            ? <EmptyState title="Nothing vesting soon" description="Every outstanding grant is fully vested." />
            : (
              <ul className="space-y-2.5">
                {data.upcomingVests.slice(0, 5).map((v: any) => (
                  <li key={v.awardId} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink-800">{v.stakeholderName}</p>
                      <p className="text-[11px] text-ink-500">{v.label} · {percent(v.percentVested, 0)} vested</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[13px] font-medium tabular">{shares(v.quantity)}</p>
                      <p className="text-[11px] text-ink-500">{relativeDate(v.date)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </Card>

        <Card>
          <CardHeader title="Convertible stack" subtitle="Outstanding SAFEs and notes"
            action={<Link to="/convertibles"><Button size="sm" variant="ghost">Manage</Button></Link>} />
          {data.convertibles.count === 0
            ? <EmptyState title="No open instruments" description="Every SAFE and note has converted or been repaid." />
            : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Principal</p>
                    <p className="mt-1 text-lg font-semibold tabular">{money(data.convertibles.totalPrincipal, { compact: true })}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">With interest</p>
                    <p className="mt-1 text-lg font-semibold tabular">{money(data.convertibles.totalWithInterest, { compact: true })}</p>
                  </div>
                </div>
                {data.convertibles.guaranteedOwnership > 0 && (
                  <p className="mt-4 rounded-lg bg-ink-50 p-3 text-[12px] leading-relaxed text-ink-600">
                    Post-money SAFEs are contractually entitled to{' '}
                    <span className="font-semibold text-ink-900">{percent(data.convertibles.guaranteedOwnership)}</span>{' '}
                    of the company immediately before the next priced round — the round's new money and pool top-up then dilute them like everyone else.
                  </p>
                )}
              </>
            )}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {/* The same list as the header's tasks button, then any task recorded for the company. */}
        <Card padded={false}>
          <div className="p-5 pb-0"><CardHeader title="My pending actions" subtitle="What needs you" /></div>
          {pendingError ? <p className="px-5 pb-5 text-[13px] text-ink-500">Your pending actions could not be loaded.</p>
            : pending === null ? <Loading label="Looking for what needs you" />
              : pending.length === 0 && data.openTasks.length === 0 ? <NothingWaiting />
                : <ActionList items={pending} className="[&>li>a]:px-5" />}
          {data.openTasks.length > 0 && (
            <ul className="divide-y divide-ink-100 border-t border-ink-100">
              {data.openTasks.map((task: any) => (
                <li key={task.id} className="flex items-start gap-3 px-5 py-3">
                  <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-600">
                    <Icon name="clock" className="size-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-ink-800">{task.title}</p>
                    {task.detail && <p className="mt-0.5 text-[12px] leading-snug text-ink-500">{task.detail}</p>}
                  </div>
                  {task.dueDate && (
                    <span className="shrink-0 text-[11px] text-ink-500">{relativeDate(task.dueDate)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader title="Recent activity" subtitle="Everything that changed the cap table"
              action={<Link to="/audit"><Button size="sm" variant="ghost">Audit log</Button></Link>} />
          </div>
          <ul className="divide-y divide-ink-100">
            {data.recentActivity.slice(0, 7).map((a: any) => (
              <li key={a.id} className="flex items-start gap-3 px-5 py-2.5">
                <Avatar name={a.userName ?? 'System'} size={22} />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-ink-700">
                    <span className="font-medium text-ink-900">{a.userName}</span>{' '}
                    {a.detail ?? a.action.toLowerCase()}
                  </p>
                  <p className="text-[11px] text-ink-400">{dateTime(a.createdAt)}</p>
                </div>
                <StatusBadge status={a.action} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
