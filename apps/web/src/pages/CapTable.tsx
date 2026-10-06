import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, downloadReport, downloadFile } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Table, TH, TD, TR, Badge, Loading, ErrorNote, Button,
  SegmentedControl, Input, Field, SearchInput, MiniBar, Avatar, Banner, Checkbox, EmptyState, Tooltip, Modal, useToast, cx,
} from '../ui.tsx';
import { OwnershipDonut, ChartLegend, StackedAreaChart } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { ImportDropZone } from '../ImportDropZone.tsx';
import { money, shares, percent, pps, date, today, RELATION_LABELS } from '../format.ts';

type View = 'FULLY_DILUTED' | 'OUTSTANDING' | 'AS_CONVERTED' | 'VOTING';

const VIEWS: { value: View; label: string; title: string }[] = [
  { value: 'FULLY_DILUTED', label: 'Fully diluted', title: 'Issued shares plus options, RSUs, warrants and the unallocated pool' },
  { value: 'OUTSTANDING', label: 'Outstanding', title: 'Issued and outstanding shares only' },
  { value: 'AS_CONVERTED', label: 'As converted', title: 'Outstanding shares with preferred converted to common' },
  { value: 'VOTING', label: 'Voting', title: 'Voting power, weighted by votes per share' },
];

export default function CapTable() {
  const { companyId, canViewAll, canEdit } = useSession();
  const [view, setView] = useState<View>('FULLY_DILUTED');
  const [asOf, setAsOf] = useState(today());
  const [includeConvertibles, setIncludeConvertibles] = useState(false);
  const [includePool, setIncludePool] = useState(true);
  const [groupEntities, setGroupEntities] = useState(false);
  const [search, setSearch] = useState('');
  const [expandHoldings, setExpandHoldings] = useState(false);
  const [importing, setImporting] = useState(false);

  const qs = `asOf=${asOf}&includeConvertibles=${includeConvertibles}&includePool=${includePool}&groupEntities=${groupEntities}`;
  const toast = useToast();

  // Export menu: Excel and PDF mirror the view on screen; CSV is the fully diluted table.
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => { if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [exportOpen]);
  const exportAs = (format: 'csv' | 'xlsx' | 'pdf') => {
    setExportOpen(false);
    const run = format === 'csv'
      ? downloadReport(companyId!, 'captable', asOf)
      : downloadFile(`/c/${companyId}/captable/export.${format}?${qs}&view=${view}`, `cap-table-${asOf}.${format}`);
    run.catch((err: Error) => toast(err.message, 'error'));
  };
  const { data, error, loading, reload } = useQuery<any>(
    companyId && canViewAll ? `/c/${companyId}/captable?${qs}` : null,
    [companyId, qs],
  );

  // Dilution is a property of the whole history, not of the as-of date or the
  // view, so it is fetched once and left alone as those controls change.
  const { data: history } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/captable/history` : null, [companyId]);
  // Founders and employees both hold common stock, so the class view cannot tell
  // them apart. The holder view is the one that answers who was diluted.
  const [dilutionBy, setDilutionBy] = useState<'holders' | 'classes'>('holders');
  const dilution = useMemo(() => {
    const points = history?.points ?? [];
    if (points.length < 2) return null;
    const byHolders = dilutionBy === 'holders';
    return {
      keys: (byHolders ? history.groups : history.bands) as string[],
      rows: points.map((p: any) => ({
        ...(byHolders ? p.holders : p.shares),
        label: /^\d{4}-\d{2}-\d{2}$/.test(p.label) ? date(p.label) : p.label,
      })),
    };
  }, [history, dilutionBy]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? data.table.rows.filter((r: any) => r.name.toLowerCase().includes(q)
        || (RELATION_LABELS[r.relation] ?? '').toLowerCase().includes(q))
      : data.table.rows;
    const keyOf = (r: any) => ({
      FULLY_DILUTED: r.fullyDiluted, OUTSTANDING: r.outstanding,
      AS_CONVERTED: r.asConverted, VOTING: r.votes,
    })[view];
    return [...filtered].sort((a: any, b: any) => keyOf(b) - keyOf(a));
  }, [data, search, view]);

  if (!canViewAll) {
    return <EmptyState title="Your role cannot view the full cap table"
      description="Ask an administrator for broader access, or open My equity to see your own position."
      action={<Link to="/portal"><Button variant="primary">Open my equity</Button></Link>} />;
  }
  if (loading) return <Loading label="Computing the cap table" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const t = data.table.totals;
  const columnFor = (r: any) => ({
    FULLY_DILUTED: r.fullyDiluted, OUTSTANDING: r.outstanding,
    AS_CONVERTED: r.asConverted, VOTING: r.votes,
  })[view];
  const pctFor = (r: any) => ({
    FULLY_DILUTED: r.fullyDilutedPct, OUTSTANDING: r.outstandingPct,
    AS_CONVERTED: r.asConvertedPct, VOTING: r.votingPct,
  })[view];
  const totalFor = { FULLY_DILUTED: t.fullyDiluted, OUTSTANDING: t.outstanding, AS_CONVERTED: t.asConverted, VOTING: t.votes }[view];
  // Each row values shares at the price per share and options and warrants at
  // their spread, so the column's total is the sum of the rows, not price x fully diluted.
  const valueTotal = data.table.rows.reduce((s: number, r: any) => s + r.currentValue, 0);
  const uncapped = includeConvertibles ? data.table.uncappedConversionPrice : null;

  return (
    <>
      <PageHeader concept="cap-table"
        title="Cap table"
        subtitle={`${shares(totalFor)} ${VIEWS.find((v) => v.value === view)!.label.toLowerCase()} shares as of ${date(asOf)}`}
        actions={
          <>
            {canEdit && <Button icon={<Icon name="inbox" />} onClick={() => setImporting(true)}>Import</Button>}
            <div ref={exportRef} className="relative">
              <Button icon={<Icon name="download" />} onClick={() => setExportOpen((v) => !v)} aria-haspopup="menu" aria-expanded={exportOpen}>
                Export <Icon name="chevron" className={cx('size-3.5 transition-transform', exportOpen && 'rotate-180')} />
              </Button>
              {exportOpen && (
                <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-ink-200 bg-white py-1 shadow-xl animate-in">
                  {([
                    ['xlsx', 'Excel workbook (.xlsx)', 'This view, plus share classes and a summary sheet'],
                    ['pdf', 'PDF document', 'Print-ready table of this view'],
                    ['csv', 'CSV file', 'Fully diluted cap table for any spreadsheet'],
                  ] as const).map(([format, label, hint]) => (
                    <button key={format} role="menuitem" type="button" onClick={() => exportAs(format)}
                      className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-ink-50">
                      <span className="text-[13px] font-medium text-ink-900">{label}</span>
                      <span className="text-[11px] text-ink-500">{hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Link to="/model/round"><Button variant="primary" icon={<Icon name="trending" />}>Model a round</Button></Link>
          </>
        }
      />

      <Modal open={importing} onClose={() => setImporting(false)} title="Import a cap table"
        description="Bring in stakeholders, share classes and certificates from a CSV, XML or Excel file. Missing stakeholders and share classes are created for you. A PDF is kept as a document instead of being read as a table.">
        <ImportDropZone kind="captable" />
        <p className="mt-4 text-center text-[12px] text-ink-500">
          Importing grants or SAFEs instead? <Link to="/import" className="font-medium text-brand-600 hover:text-brand-700" onClick={() => setImporting(false)}>Open the import wizard</Link>.
        </p>
      </Modal>

      {data.table.rows.length === 0 && (
        <Card className="mb-5">
          <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr] lg:items-center">
            <div>
              <h3 className="text-[17px] font-semibold text-ink-900">This cap table is empty</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
                The fastest way to get started is to import the spreadsheet or export you already have — one row per
                certificate. Or build it by hand: add stakeholders, then issue shares.
              </p>
              {canEdit && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link to="/stakeholders"><Button icon={<Icon name="users" />}>Add stakeholders</Button></Link>
                  <Link to="/certificates"><Button icon={<Icon name="certificate" />}>Issue shares</Button></Link>
                </div>
              )}
            </div>
            {canEdit ? <ImportDropZone kind="captable" compact /> : (
              <p className="text-[13px] text-ink-500">Ask an administrator to import or issue the first shares.</p>
            )}
          </div>
        </Card>
      )}

      {data.table.warnings.length > 0 && (
        <div className="mb-5">
          <Banner tone="warning" title="Review these before relying on the table">
            <ul className="list-disc space-y-0.5 pl-4">
              {data.table.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          </Banner>
        </div>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink-700">View</p>
            <SegmentedControl value={view} onChange={setView} options={VIEWS} />
          </div>
          <Field label="As of date" className="w-40">
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <div className="w-56"><Field label="Search"><SearchInput value={search} onChange={setSearch} placeholder="Filter holders" /></Field></div>
          <div className="ml-auto space-y-1.5 pb-1">
            <Checkbox label="Include unallocated pool" checked={includePool} onChange={setIncludePool} />
            <Checkbox label="Include SAFEs and notes as converted" checked={includeConvertibles} onChange={setIncludeConvertibles} />
            <Checkbox label="Roll up fund entities" checked={groupEntities} onChange={setGroupEntities} />
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Card padded={false}>
            <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-3">
              <h3 className="text-[15px] font-semibold">Holders</h3>
              <button onClick={() => setExpandHoldings((v) => !v)}
                className="text-[12px] font-medium text-brand-600 hover:text-brand-700">
                {expandHoldings ? 'Hide' : 'Show'} class breakdown
              </button>
            </div>
            <Table>
              <thead>
                <tr>
                  <TH>Holder</TH>
                  <TH align="right">Shares</TH>
                  <TH align="right">Options</TH>
                  <TH align="right">RSUs</TH>
                  <TH align="right">Warrants</TH>
                  {includeConvertibles && <TH align="right">Convertible</TH>}
                  <TH align="right">{VIEWS.find((v) => v.value === view)!.label}</TH>
                  <TH align="right">Invested</TH>
                  <TH align="right">Value</TH>
                  <TH width={130}>Ownership</TH>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <Fragment key={r.stakeholderId}>
                    <TR>
                      <TD>
                        <Link to={`/stakeholders/${r.stakeholderId}`} className="flex items-center gap-2.5 hover:text-brand-700">
                          <Avatar name={r.name} size={26} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{r.name}</span>
                            <span className="block text-[11px] text-ink-500">{RELATION_LABELS[r.relation] ?? r.relation}</span>
                          </span>
                        </Link>
                      </TD>
                      <TD align="right" mono>{r.outstanding ? shares(r.outstanding) : '—'}</TD>
                      <TD align="right" mono>
                        {r.optionsOutstanding ? (
                          <Tooltip label={`${shares(r.optionsVested)} vested · ${shares(r.optionsUnvested)} unvested`}>
                            <span className="border-b border-dotted border-ink-300">{shares(r.optionsOutstanding)}</span>
                          </Tooltip>
                        ) : '—'}
                      </TD>
                      <TD align="right" mono>{r.rsusOutstanding ? shares(r.rsusOutstanding) : '—'}</TD>
                      <TD align="right" mono>{r.warrantsOutstanding ? shares(r.warrantsOutstanding) : '—'}</TD>
                      {includeConvertibles && (
                        <TD align="right" mono className="text-ink-600">
                          {r.convertibleAsConverted ? shares(r.convertibleAsConverted) : '—'}
                        </TD>
                      )}
                      <TD align="right" mono className="font-semibold">{shares(columnFor(r))}</TD>
                      <TD align="right" mono className="text-ink-600">{r.investedAmount ? money(r.investedAmount, { compact: true }) : '—'}</TD>
                      <TD align="right" mono className="text-ink-600">{money(r.currentValue, { compact: true })}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <MiniBar value={pctFor(r)} />
                          <span className="w-12 shrink-0 text-right text-[12px] tabular">{percent(pctFor(r), 2)}</span>
                        </div>
                      </TD>
                    </TR>
                    {expandHoldings && r.holdings.map((h: any) => (
                      <TR key={`${r.stakeholderId}-${h.shareClassId}`} className="bg-ink-50/40">
                        <TD className="pl-12 text-[12px] text-ink-600">{h.className}</TD>
                        <TD align="right" mono className="text-[12px]">{shares(h.shares)}</TD>
                        <TD colSpan={includeConvertibles ? 4 : 3} />
                        <TD align="right" mono className="text-[12px]">{shares(h.asConverted)}</TD>
                        <TD align="right" mono className="text-[12px] text-ink-500">{money(h.investedAmount, { compact: true })}</TD>
                        <TD colSpan={2} />
                      </TR>
                    ))}
                  </Fragment>
                ))}

                {includePool && data.table.totals.poolAvailable > 0 && (
                  <TR className="bg-ink-50/60">
                    <TD>
                      <span className="flex items-center gap-2.5">
                        <span className="grid size-[26px] place-items-center rounded-full bg-ink-200 text-ink-600">
                          <Icon name="award" className="size-3.5" />
                        </span>
                        <span>
                          <span className="block font-medium text-ink-700">Unallocated option pool</span>
                          <span className="block text-[11px] text-ink-500">Reserved, not yet granted</span>
                        </span>
                      </span>
                    </TD>
                    <TD colSpan={includeConvertibles ? 5 : 4} />
                    <TD align="right" mono className="font-semibold">{shares(t.poolAvailable)}</TD>
                    <TD colSpan={2} />
                    <TD>
                      <div className="flex items-center gap-2">
                        <MiniBar value={t.poolAvailable / (totalFor || 1)} tone="amber" />
                        <span className="w-12 shrink-0 text-right text-[12px] tabular">
                          {percent(t.poolAvailable / (totalFor || 1), 2)}
                        </span>
                      </div>
                    </TD>
                  </TR>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-white">
                  <TD className="font-semibold">Total</TD>
                  <TD align="right" mono className="font-semibold">{shares(t.outstanding)}</TD>
                  <TD align="right" mono className="font-semibold">{shares(t.optionsOutstanding)}</TD>
                  <TD align="right" mono className="font-semibold">{shares(t.rsusOutstanding)}</TD>
                  <TD align="right" mono className="font-semibold">{shares(t.warrantsOutstanding)}</TD>
                  {includeConvertibles && <TD align="right" mono className="font-semibold">{shares(t.convertibleAsConverted)}</TD>}
                  <TD align="right" mono className="font-semibold">{shares(totalFor)}</TD>
                  <TD align="right" mono className="font-semibold">{money(t.investedAmount, { compact: true })}</TD>
                  <TD align="right" mono className="font-semibold">
                    <Tooltip label="Shares at the price per share, options and warrants at their spread; the unallocated pool is worth nothing until granted">
                      <span className="border-b border-dotted border-ink-300">{money(valueTotal, { compact: true })}</span>
                    </Tooltip>
                  </TD>
                  <TD align="right" className="font-semibold tabular">100.00%</TD>
                </tr>
              </tfoot>
            </Table>
            {uncapped && (
              <p className="border-t border-ink-100 px-5 py-3 text-[12px] text-ink-500">
                SAFEs and notes without a valuation cap are estimated at their discount to {uncapped.source === 'GIVEN' ? 'the price given' : `the ${uncapped.source === '409A' ? '409A fair market value' : 'latest valuation'}`} of {pps(uncapped.pricePerShare)}
                {uncapped.effectiveDate ? ` (${date(uncapped.effectiveDate)})` : ''}. They convert at a discount to the next round's price, which is not known yet.
              </p>
            )}
          </Card>

          <Card className="mt-5" padded={false}>
            <div className="p-5 pb-0"><CardHeader title="Share classes" subtitle="Authorized, issued, reserved and liquidation preference" /></div>
            <Table>
              <thead>
                <tr>
                  <TH>Class</TH>
                  <TH align="right">Authorized</TH>
                  <TH align="right">Outstanding</TH>
                  <TH align="right">
                    <Tooltip label="Unissued shares kept for plan grants and the plan's reserve, warrants and, in common, what preferred converts into">
                      <span className="border-b border-dotted border-ink-300">Reserved</span>
                    </Tooltip>
                  </TH>
                  <TH align="right">Available</TH>
                  <TH align="right">Holders</TH>
                  <TH align="right">Issue price</TH>
                  <TH align="right">Invested</TH>
                  <TH align="right">Liquidation preference</TH>
                  <TH align="right">Ownership</TH>
                </tr>
              </thead>
              <tbody>
                {data.table.classes.map((c: any) => (
                  <TR key={c.shareClassId}>
                    <TD>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        <Badge tone={c.kind === 'PREFERRED' ? 'purple' : 'neutral'}>
                          {c.kind === 'PREFERRED' ? 'Preferred' : 'Common'}
                        </Badge>
                      </span>
                    </TD>
                    <TD align="right" mono>{shares(c.authorized)}</TD>
                    <TD align="right" mono>{shares(c.outstanding)}</TD>
                    <TD align="right" mono className="text-ink-600">{c.reserved ? shares(c.reserved) : '—'}</TD>
                    <TD align="right" mono className={c.available < 0 ? 'text-red-600 font-medium' : 'text-ink-600'}>
                      {shares(c.available)}
                    </TD>
                    <TD align="right" mono>{c.holders}</TD>
                    <TD align="right" mono>{pps(c.pricePerShare)}</TD>
                    <TD align="right" mono>{money(c.investedAmount, { compact: true })}</TD>
                    <TD align="right" mono>{c.kind === 'PREFERRED' ? money(c.liquidationPreference, { compact: true }) : '—'}</TD>
                    <TD align="right" mono>{percent(c.ownershipPct)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>

          {dilution && (
            <Card className="mt-5">
              <CardHeader title="Dilution over time"
                subtitle={dilutionBy === 'holders'
                  ? 'Fully diluted shares after each round, one band per group of holders. A band that keeps its height while the stack grows is that group being diluted.'
                  : 'Fully diluted shares after each round, one band per share class. Founders and employees both hold common stock, so this view does not separate them.'}
                action={<SegmentedControl value={dilutionBy} onChange={setDilutionBy} options={[
                  { value: 'holders', label: 'By holder' },
                  { value: 'classes', label: 'By share class' },
                ]} />} />
              <StackedAreaChart data={dilution.rows} keys={dilution.keys} xKey="label" height={300} />
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Ownership split" />
            <OwnershipDonut data={data.groups} height={200} centerLabel="Holders" centerValue={String(data.table.rows.length)} />
            <div className="mt-3 border-t border-ink-100 pt-3"><ChartLegend data={data.groups} /></div>
          </Card>

          <Card>
            <CardHeader title="Plan reserves" subtitle="Option pool utilisation" />
            <div className="space-y-4">
              {data.table.pools.map((p: any) => (
                <div key={p.poolId}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-ink-800">{p.name}</span>
                    <span className="shrink-0 text-[12px] tabular text-ink-500">{percent(p.utilizationPct, 0)} used</span>
                  </div>
                  <MiniBar value={p.utilizationPct} tone={p.available < 0 ? 'amber' : 'brand'} />
                  <div className="mt-1.5 flex justify-between text-[11px] tabular text-ink-500">
                    <span>{shares(p.granted - p.cancelledReturned)} granted</span>
                    <span className={p.available < 0 ? 'font-medium text-red-600' : ''}>{shares(p.available)} available</span>
                  </div>
                </div>
              ))}
              {data.table.pools.length === 0 && (
                <p className="text-[13px] text-ink-500">No equity plans have been created yet.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Summary" />
            <dl className="space-y-2.5 text-[13px]">
              {[
                ['Issued and outstanding', shares(t.outstanding)],
                ['As converted', shares(t.asConverted)],
                ['Options outstanding', shares(t.optionsOutstanding)],
                ['  of which vested', shares(t.optionsVested)],
                ['RSUs outstanding', shares(t.rsusOutstanding)],
                ['Warrants', shares(t.warrantsOutstanding)],
                ['Unallocated pool', shares(t.poolAvailable)],
                ['Fully diluted', shares(t.fullyDiluted)],
                ['Price × fully diluted', money(t.companyValue, { compact: true })],
                ['Total authorized', shares(t.authorized)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className={`text-ink-500 ${k.startsWith('  ') ? 'pl-3 text-[12px]' : ''}`}>{k.trim()}</dt>
                  <dd className="tabular font-medium text-ink-900">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
