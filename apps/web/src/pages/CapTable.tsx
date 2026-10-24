import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, downloadReport, downloadFile, api } from '../api.ts';
import {
  PageHeader, Card, CardHeader, TD, TR, Badge, Loading, ErrorNote, Button, Select,
  SegmentedControl, Input, MiniBar, Avatar, Banner, EmptyState, Tooltip, Modal, useToast, cx,
} from '../ui.tsx';
import { OwnershipDonut, ChartLegend, StackedAreaChart } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { ImportDropZone, TemplateMenu } from '../ImportDropZone.tsx';
import { OptionsMenu } from '../CapTableToolbar.tsx';
import { DataTable, TableCard, TableToolbar, TableSearch, TableScroll, pinnedCell, totalCell, totalLabelCell } from '../DataTable.tsx';
import { SortTH, sortRows, useSort, type Sort } from '../sortable.tsx';
import { STAKEHOLDER_TYPES } from './stakeholders/StakeholderForm.tsx';
import { money, shares, percent, pps, date, today, RELATION_LABELS } from '../format.ts';

type View = 'FULLY_DILUTED' | 'OUTSTANDING' | 'AS_CONVERTED' | 'VOTING';

const VIEWS: { value: View; label: string; title: string }[] = [
  { value: 'FULLY_DILUTED', label: 'Fully diluted', title: 'Issued shares plus options, RSUs, warrants and the unallocated pool' },
  { value: 'OUTSTANDING', label: 'Outstanding', title: 'Issued and outstanding shares only' },
  { value: 'AS_CONVERTED', label: 'As converted', title: 'Outstanding shares with preferred converted to common' },
  { value: 'VOTING', label: 'Voting', title: 'Voting power, weighted by votes per share' },
];

/** Individual, Entity, Fund or Trust: the same words as the stakeholder form. */
const TYPE_LABELS: Record<string, string> = Object.fromEntries(STAKEHOLDER_TYPES);

/** The holders table's sortable columns. */
type Column = 'holder' | 'type' | 'shares' | 'io' | 'options' | 'rsus' | 'warrants' | 'convertible' | 'view' | 'invested' | 'value' | 'ownership';
/** Largest holding first, in whichever view is chosen, until someone sorts by another column. */
const BY_SIZE: Sort<Column> = { key: 'view', direction: 'desc' };

const sharesIn = (r: any, view: View): number => ({
  FULLY_DILUTED: r.fullyDiluted, OUTSTANDING: r.outstanding, AS_CONVERTED: r.asConverted, VOTING: r.votes,
})[view];
const percentIn = (r: any, view: View): number => ({
  FULLY_DILUTED: r.fullyDilutedPct, OUTSTANDING: r.outstandingPct, AS_CONVERTED: r.asConvertedPct, VOTING: r.votingPct,
})[view];

/** A cell's value to sort by. A count of zero shows as a dash, so it is a blank and sorts last either way. */
function sortValue(r: any, column: Column, view: View): string | number | null {
  const shown = (n: number) => n || null;
  switch (column) {
    case 'holder': return r.name;
    case 'type': return TYPE_LABELS[r.type] ?? r.type;
    case 'shares': return shown(r.outstanding);
    case 'io': return r.outstanding ? r.outstandingPct : null;
    case 'options': return shown(r.optionsOutstanding);
    case 'rsus': return shown(r.rsusOutstanding);
    case 'warrants': return shown(r.warrantsOutstanding);
    case 'convertible': return shown(r.convertibleAsConverted);
    case 'view': return sharesIn(r, view);
    case 'invested': return shown(r.investedAmount);
    case 'value': return r.currentValue;
    case 'ownership': return percentIn(r, view);
  }
}

/** Whether the money columns show unless someone says otherwise: where there is room for them beside the rest, from 2xl up. */
const roomForMoney = (): boolean => {
  try { return window.matchMedia('(min-width: 96rem)').matches; } catch { return true; }
};

export default function CapTable() {
  const { companyId, canViewAll, canEdit } = useSession();
  const [view, setView] = useState<View>('FULLY_DILUTED');
  const [asOf, setAsOf] = useState(today());
  const [includeConvertibles, setIncludeConvertibles] = useState(false);
  const [includePool, setIncludePool] = useState(true);
  const [groupEntities, setGroupEntities] = useState(false);
  const [search, setSearch] = useState('');
  const [expandHoldings, setExpandHoldings] = useState(false);
  const [showMoney, setShowMoney] = useState(roomForMoney);
  const { sort: chosenSort, toggle: sortBy, setSort } = useSort<Column>(BY_SIZE);
  // A sort on the convertibles column ends with the column: the table goes back to largest first.
  const showConvertibles = (on: boolean) => {
    setIncludeConvertibles(on);
    if (!on && chosenSort.key === 'convertible') setSort(BY_SIZE);
  };

  const qs = `asOf=${asOf}&includeConvertibles=${includeConvertibles}&includePool=${includePool}&groupEntities=${groupEntities}`;
  const toast = useToast();

  // Export menu: Excel and PDF mirror the view on screen; CSV is the fully diluted table; the
  // Open Cap Format package is the whole cap table and its history to today, for another tool.
  // What the package leaves out or shows differently is in its manifest; after a download the
  // page says how many such notes there are, and lists them on request.
  const [exportOpen, setExportOpen] = useState(false);
  const [ocfNotes, setOcfNotes] = useState<{ asOf: string; notes: string[] } | null>(null);
  const showOcfNotes = () => {
    api<{ asOf: string; notes: string[] }>(`/c/${companyId}/captable/export.ocf.notes`)
      .then(setOcfNotes)
      .catch((err: Error) => toast(err.message, 'error'));
  };
  const exportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => { if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [exportOpen]);
  const exportAs = (format: 'csv' | 'xlsx' | 'pdf' | 'ocf') => {
    setExportOpen(false);
    const run = format === 'csv'
      ? downloadReport(companyId!, 'captable', asOf)
      : format === 'ocf'
        ? downloadFile(`/c/${companyId}/captable/export.ocf.zip`, `cap-table-${today()}.ocf.zip`).then((headers) => {
          const n = Number(headers.get('X-Ocf-Notes') ?? 0);
          if (n > 0) toast(`Downloaded. The package notes ${n === 1 ? 'one thing' : `${n} things`} it leaves out or shows differently from Kosmitor.`, 'info', { label: 'See what', onClick: showOcfNotes });
          else toast('Downloaded the Open Cap Format package.');
          return headers;
        })
        : downloadFile(`/c/${companyId}/captable/export.${format}?${qs}&view=${view}`, `cap-table-${asOf}.${format}`);
    run.catch((err: Error) => toast(err.message, 'error'));
  };
  const { data: fresh, error, loading, reload } = useQuery<any>(
    companyId && canViewAll ? `/c/${companyId}/captable?${qs}` : null,
    [companyId, qs],
  );
  // A new date or option fetches the table again. The last one stays on screen,
  // dimmed, until the new one arrives, so the toolbar, an open menu and the full
  // size view stay where they are instead of giving way to a loading screen.
  const [kept, setKept] = useState<{ companyId: string; data: any } | null>(null);
  useEffect(() => { if (fresh && companyId) setKept({ companyId, data: fresh }); }, [fresh, companyId]);
  const data = fresh ?? (kept && kept.companyId === companyId ? kept.data : null);
  const refreshing = loading && !fresh && data != null;

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

  // A column the company has nothing in (no RSUs, say) is left out, and so are the
  // money columns when switched off; a sort on one that is not shown is largest first.
  const totals = data?.table.totals;
  const shown: Record<Column, boolean> = {
    holder: true, type: true, shares: true, io: true, view: true, ownership: true,
    options: !!totals?.optionsOutstanding, rsus: !!totals?.rsusOutstanding, warrants: !!totals?.warrantsOutstanding,
    convertible: includeConvertibles, invested: showMoney, value: showMoney,
  };
  const sort = shown[chosenSort.key] ? chosenSort : BY_SIZE;

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? data.table.rows.filter((r: any) => [r.name, RELATION_LABELS[r.relation], TYPE_LABELS[r.type]]
        .some((text) => (text ?? '').toLowerCase().includes(q)))
      : data.table.rows;
    // Equal rows keep the largest holding first, then the name, so a sort never shuffles them.
    return sortRows(filtered, sort, (r: any, column) => sortValue(r, column, view),
      (a: any, b: any) => sharesIn(b, view) - sharesIn(a, view) || a.name.localeCompare(b.name));
  }, [data, search, view, sort]);

  if (!canViewAll) {
    return <EmptyState title="Your role cannot view the full cap table"
      description="Ask an administrator for broader access, or open My equity to see your own position."
      action={<Link to="/portal"><Button variant="primary">Open my equity</Button></Link>} />;
  }
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return loading ? <Loading label="Computing the cap table" /> : null;

  const t = data.table.totals;
  const viewLabel = VIEWS.find((v) => v.value === view)!.label;
  const totalFor = sharesIn(t, view);
  // Each row values shares at the price per share and options and warrants at
  // their spread, so the column's total is the sum of the rows, not price x fully diluted.
  const valueTotal = data.table.rows.reduce((s: number, r: any) => s + r.currentValue, 0);
  const uncapped = includeConvertibles ? data.table.uncappedConversionPrice : null;
  // The unallocated pool is part of fully diluted only; in the other views it is no one's share.
  const showPool = includePool && view === 'FULLY_DILUTED' && t.poolAvailable > 0;
  const optionsOn = [includePool, includeConvertibles, groupEntities].filter(Boolean).length;
  const columnCount = Object.values(shown).filter(Boolean).length;
  const searching = search.trim() !== '';
  const header = (column: Column, label: React.ReactNode, more: { align?: 'right'; width?: number; title?: string; pinned?: boolean } = {}) =>
    shown[column] && <SortTH column={column} label={label} sort={sort} onSort={sortBy} {...more} />;
  // The pool row's empty run of cells, from Type to just before the view's column, and from after it to Ownership.
  const beforeView = (['type', 'shares', 'io', 'options', 'rsus', 'warrants', 'convertible'] as Column[]).filter((c) => shown[c]).length;
  const afterView = (['invested', 'value'] as Column[]).filter((c) => shown[c]).length;

  // One row above the table: the view, the date, the switches and the search (and, from the card, full size).
  const toolbar = (
    <TableToolbar>
      {/* Four segments do not fit beside anything on a phone, so there the view is a list. */}
      <div className="w-full sm:hidden">
        <Select aria-label="View" value={view} onChange={(e) => setView(e.target.value as View)}>
          {VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </Select>
      </div>
      <div role="group" aria-label="View" className="hidden sm:block">
        <SegmentedControl value={view} onChange={setView} options={VIEWS} />
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink-500">
        As of
        <span className="block w-36"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></span>
      </label>
      <OptionsMenu count={optionsOn} sections={[
        { title: 'Calculation', items: [
          { label: 'Include unallocated pool', hint: 'Plan shares not granted yet count toward fully diluted', checked: includePool, onChange: setIncludePool },
          { label: 'Include SAFEs and notes as converted', hint: 'Adds the shares they would convert into', checked: includeConvertibles, onChange: showConvertibles },
          { label: 'Roll up fund entities', hint: 'Related funds show as one holder', checked: groupEntities, onChange: setGroupEntities },
        ] },
        { title: 'Display', items: [
          { label: 'Show class breakdown', hint: "Each holder's shares by share class", checked: expandHoldings, onChange: setExpandHoldings },
          { label: 'Show invested and value', hint: 'What each holder paid, and what their holding is worth at the latest price', checked: showMoney, onChange: setShowMoney },
        ] },
      ]} />
      <TableSearch label="Search holders" value={search} onChange={setSearch} />
    </TableToolbar>
  );

  // The holders table, in the page or full size. Full size, the table scrolls
  // under its own header and its totals stay in view at the foot.
  const holders = (full: boolean) => {
    const total = totalCell(full);
    return (
      <>
        {toolbar}
        <TableScroll busy={refreshing}>
          <caption className="sr-only">Holders, {viewLabel.toLowerCase()}, as of {date(asOf)}</caption>
          <thead>
            <tr>
              {header('holder', 'Holder', { pinned: true })}
              {header('type', 'Type')}
              {header('shares', 'Shares', { align: 'right', title: 'Issued and outstanding shares' })}
              {header('io', 'I&O %', { align: 'right', title: 'Percent of the issued and outstanding shares' })}
              {header('options', 'Options', { align: 'right' })}
              {header('rsus', 'RSUs', { align: 'right' })}
              {header('warrants', 'Warrants', { align: 'right' })}
              {includeConvertibles && header('convertible', 'Convertible', { align: 'right' })}
              {header('view', viewLabel, { align: 'right' })}
              {header('invested', 'Invested', { align: 'right' })}
              {header('value', 'Value', { align: 'right' })}
              {header('ownership', 'Ownership', { width: 130, title: `Percent of the ${viewLabel.toLowerCase()} total` })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <Fragment key={r.stakeholderId}>
                <TR>
                  {/* Names show in full; only a very long one is cut (at the width the shared table gives a first-column name), and its whole name is on hover. */}
                  <TD className={pinnedCell('whitespace-nowrap bg-white')}>
                    <Link to={`/stakeholders/${r.stakeholderId}`} title={r.name} className="flex items-center gap-2.5 hover:text-brand-700">
                      <Avatar name={r.name} size={26} />
                      <span className="min-w-0">
                        <span className="block max-w-56 truncate font-medium">{r.name}</span>
                        <span className="block text-[11px] text-ink-500">{RELATION_LABELS[r.relation] ?? r.relation}</span>
                      </span>
                    </Link>
                  </TD>
                  <TD className="whitespace-nowrap text-ink-600">{TYPE_LABELS[r.type] ?? r.type}</TD>
                  <TD align="right" mono>{r.outstanding ? shares(r.outstanding) : '—'}</TD>
                  <TD align="right" mono className="text-ink-600">{r.outstanding ? percent(r.outstandingPct, 2) : '—'}</TD>
                  {shown.options && (
                    <TD align="right" mono>
                      {r.optionsOutstanding ? (
                        <Tooltip label={`${shares(r.optionsVested)} vested · ${shares(r.optionsUnvested)} unvested`}>
                          <span className="border-b border-dotted border-ink-300">{shares(r.optionsOutstanding)}</span>
                        </Tooltip>
                      ) : '—'}
                    </TD>
                  )}
                  {shown.rsus && <TD align="right" mono>{r.rsusOutstanding ? shares(r.rsusOutstanding) : '—'}</TD>}
                  {shown.warrants && <TD align="right" mono>{r.warrantsOutstanding ? shares(r.warrantsOutstanding) : '—'}</TD>}
                  {shown.convertible && (
                    <TD align="right" mono className="text-ink-600">
                      {r.convertibleAsConverted ? shares(r.convertibleAsConverted) : '—'}
                    </TD>
                  )}
                  <TD align="right" mono className="font-semibold">{shares(sharesIn(r, view))}</TD>
                  {shown.invested && <TD align="right" mono className="text-ink-600">{r.investedAmount ? money(r.investedAmount, { compact: true }) : '—'}</TD>}
                  {shown.value && <TD align="right" mono className="text-ink-600">{money(r.currentValue, { compact: true })}</TD>}
                  <TD>
                    <div className="flex items-center gap-2">
                      <MiniBar value={percentIn(r, view)} />
                      <span className="w-12 shrink-0 text-right text-[12px] tabular">{percent(percentIn(r, view), 2)}</span>
                    </div>
                  </TD>
                </TR>
                {expandHoldings && r.holdings.map((h: any) => (
                  <TR key={`${r.stakeholderId}-${h.shareClassId}`} className="bg-ink-50/40">
                    <TD className={pinnedCell('whitespace-nowrap bg-[color-mix(in_srgb,var(--color-ink-50)_40%,white)] pl-12 text-[12px] text-ink-600')}>{h.className}</TD>
                    <TD />
                    <TD align="right" mono className="text-[12px]">{shares(h.shares)}</TD>
                    <TD colSpan={beforeView - 2} />
                    <TD align="right" mono className="text-[12px]">{shares(h.asConverted)}</TD>
                    {shown.invested && <TD align="right" mono className="text-[12px] text-ink-500">{money(h.investedAmount, { compact: true })}</TD>}
                    <TD colSpan={afterView - (shown.invested ? 1 : 0) + 1} />
                  </TR>
                ))}
              </Fragment>
            ))}

            {rows.length === 0 && (
              <tr>
                <TD colSpan={columnCount} className="py-8 text-center text-[13px] text-ink-500">
                  {searching ? <>No holder matches “{search.trim()}”.</> : 'No holders yet.'}
                </TD>
              </tr>
            )}

            {/* The pool is no one's, so a search for holders leaves it out. */}
            {showPool && !searching && (
              <TR className="bg-ink-50/60">
                <TD className={pinnedCell('whitespace-nowrap bg-[color-mix(in_srgb,var(--color-ink-50)_60%,white)]')}>
                  <span className="flex items-center gap-2.5">
                    <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-ink-200 text-ink-600">
                      <Icon name="award" className="size-3.5" />
                    </span>
                    <span>
                      <span className="block font-medium text-ink-700">Unallocated option pool</span>
                      <span className="block text-[11px] text-ink-500">Reserved, not yet granted</span>
                    </span>
                  </span>
                </TD>
                <TD colSpan={beforeView} />
                <TD align="right" mono className="font-semibold">{shares(t.poolAvailable)}</TD>
                {afterView > 0 && <TD colSpan={afterView} />}
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
          {/* A table with no holders has nothing to add up. While a search narrows the rows, the line is still the whole company's, and says so. */}
          {data.table.rows.length > 0 && (
            <tfoot>
              <tr className="bg-white">
                <TD className={totalLabelCell(full)}>{searching ? 'Company total' : 'Total'}</TD>
                <TD className={total} />
                <TD align="right" mono className={total}>{shares(t.outstanding)}</TD>
                <TD align="right" mono className={total}>{t.outstanding ? '100.00%' : '—'}</TD>
                {shown.options && <TD align="right" mono className={total}>{shares(t.optionsOutstanding)}</TD>}
                {shown.rsus && <TD align="right" mono className={total}>{shares(t.rsusOutstanding)}</TD>}
                {shown.warrants && <TD align="right" mono className={total}>{shares(t.warrantsOutstanding)}</TD>}
                {shown.convertible && <TD align="right" mono className={total}>{shares(t.convertibleAsConverted)}</TD>}
                <TD align="right" mono className={total}>{shares(totalFor)}</TD>
                {shown.invested && <TD align="right" mono className={total}>{money(t.investedAmount, { compact: true })}</TD>}
                {shown.value && (
                  <TD align="right" mono className={total}>
                    <Tooltip label="Shares at the price per share, options and warrants at their spread; the unallocated pool is worth nothing until granted">
                      <span className="border-b border-dotted border-ink-300">{money(valueTotal, { compact: true })}</span>
                    </Tooltip>
                  </TD>
                )}
                <TD align="right" className={cx(total, 'tabular')}>100.00%</TD>
              </tr>
            </tfoot>
          )}
        </TableScroll>
        {uncapped && (
          <p className="shrink-0 border-t border-ink-100 px-5 py-3 text-[12px] text-ink-500">
            SAFEs and notes without a valuation cap are estimated at their discount to {uncapped.source === 'GIVEN' ? 'the price given' : `the ${uncapped.source === '409A' ? '409A fair market value' : 'latest valuation'}`} of {pps(uncapped.pricePerShare)}
            {uncapped.effectiveDate ? ` (${date(uncapped.effectiveDate)})` : ''}. They convert at a discount to the next round's price, which is not known yet.
          </p>
        )}
      </>
    );
  };

  return (
    <>
      <PageHeader concept="cap-table"
        title="Cap table"
        subtitle={`${shares(totalFor)} ${viewLabel.toLowerCase()} shares as of ${date(asOf)}`}
        actions={
          <>
            {canEdit && <Link to="/import?kind=captable"><Button icon={<Icon name="inbox" />}>Import</Button></Link>}
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
                    ['ocf', 'Open Cap Format (.ocf.zip)', 'Cap table and history in Open Cap Format 1.2.0, for another cap table tool. Some details are approximated; the package lists them'],
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
            {canEdit ? (
              <div>
                <ImportDropZone kind="captable" compact />
                <p className="mt-2 text-center text-[12px] text-ink-500">Starting from scratch? <TemplateMenu kind="captable" /></p>
              </div>
            ) : (
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

      {/* The shape of the table before its rows: who owns it, how much of each plan is
          used, and the totals. Three cards of one height side by side, the ownership one
          widest so its legend reads in full beside the donut; two and one on a tablet, one
          above the other on a phone. */}
      <div className="mb-5 grid gap-5 md:grid-cols-2 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card className="h-full">
          <CardHeader title="Ownership split" subtitle={`Fully diluted, by relationship · ${data.table.rows.length} holders`} />
          {/* Side by side when the card has room for the legend in full, the donut above it when not. */}
          <div className="@container">
            <div className="flex flex-col items-stretch gap-4 @xs:flex-row @xs:items-center">
              <div className="mx-auto w-[120px] shrink-0 @xs:mx-0">
                <OwnershipDonut data={data.groups} height={120} centerLabel="Holders" centerValue={String(data.table.rows.length)} />
              </div>
              <div className="min-w-0 flex-1"><ChartLegend data={data.groups} /></div>
            </div>
          </div>
        </Card>

        <Card className="h-full">
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

        <Card className="h-full md:col-span-2 xl:col-span-1">
          <CardHeader title="Summary" />
          {/* The two totals people quote first, then everything that adds up to them. */}
          <div className="grid grid-cols-2 gap-4 border-b border-ink-100 pb-4">
            <div>
              <p className="text-[11px] text-ink-500">Fully diluted</p>
              <p className="mt-0.5 text-xl font-semibold tracking-tight tabular text-ink-900">{shares(t.fullyDiluted)}</p>
            </div>
            <div>
              <p className="text-[11px] text-ink-500">Price × fully diluted</p>
              <p className="mt-0.5 text-xl font-semibold tracking-tight tabular text-ink-900">{money(t.companyValue, { compact: true })}</p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
            {([
              ['Issued & outstanding', shares(t.outstanding), null],
              ['As converted', shares(t.asConverted), null],
              ['Options outstanding', shares(t.optionsOutstanding), `${shares(t.optionsVested)} vested`],
              ['RSUs outstanding', shares(t.rsusOutstanding), null],
              ['Warrants', shares(t.warrantsOutstanding), null],
              ['Unallocated pool', shares(t.poolAvailable), null],
              ['Total authorized', shares(t.authorized), null],
            ] as const).map(([k, v, note]) => (
              <div key={k} className="min-w-0">
                <dt className="truncate text-[11px] text-ink-500" title={k}>{k}</dt>
                <dd className="tabular font-medium text-ink-900">
                  {v}{note && <span className="ml-1.5 text-[11px] font-normal text-ink-500">{note}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <TableCard className="mb-5" fullSize="Cap table, full size">{holders}</TableCard>

      <div className="space-y-5">
        <div className="min-w-0">
          <DataTable title="Share classes" subtitle="Authorized, issued, reserved and liquidation preference" caption="Share classes"
            rows={data.table.classes} rowKey={(c) => c.shareClassId}
            columns={[
              { key: 'class', label: 'Class', value: (c) => c.name,
                cell: (c) => (
                  <span className="flex items-center gap-2">
                    <span className="whitespace-nowrap font-medium">{c.name}</span>
                    <Badge tone={c.kind === 'PREFERRED' ? 'purple' : 'neutral'}>{c.kind === 'PREFERRED' ? 'Preferred' : 'Common'}</Badge>
                  </span>
                ) },
              { key: 'authorized', label: 'Authorized', type: 'number', value: (c) => c.authorized },
              { key: 'outstanding', label: 'Outstanding', type: 'number', value: (c) => c.outstanding },
              {
                key: 'reserved', type: 'number', value: (c) => c.reserved || null, className: 'text-ink-600',
                label: (
                  <Tooltip label="Unissued shares kept for plan grants and the plan's reserve, warrants and, in common, what preferred converts into">
                    <span className="border-b border-dotted border-ink-300">Reserved</span>
                  </Tooltip>
                ),
              },
              { key: 'available', label: 'Available', type: 'number', value: (c) => c.available, cell: (c) => shares(c.available),
                className: (c) => (c.available < 0 ? 'text-red-600 font-medium' : 'text-ink-600') },
              { key: 'holders', label: 'Holders', type: 'number', value: (c) => c.holders, cell: (c) => c.holders },
              { key: 'price', label: 'Issue price', type: 'price', value: (c) => c.pricePerShare },
              { key: 'invested', label: 'Invested', type: 'money', value: (c) => c.investedAmount, cell: (c) => money(c.investedAmount, { compact: true }) },
              { key: 'preference', label: 'Liquidation preference', type: 'money', value: (c) => (c.kind === 'PREFERRED' ? c.liquidationPreference : null),
                cell: (c) => (c.kind === 'PREFERRED' ? money(c.liquidationPreference, { compact: true }) : '—') },
              { key: 'ownership', label: 'Ownership', type: 'number', value: (c) => c.ownershipPct, cell: (c) => percent(c.ownershipPct) },
            ]} />

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
      </div>
      <Modal open={!!ocfNotes} onClose={() => setOcfNotes(null)} title="What the Open Cap Format package leaves out"
        description={ocfNotes ? `As its manifest (Manifest.ocf.json) says, for the package of ${date(ocfNotes.asOf)}. Kosmitor-specific details travel in comments beginning kosmitor:1:, which another tool may ignore.` : undefined}
        footer={<Button onClick={() => setOcfNotes(null)}>Close</Button>}>
        {ocfNotes && (ocfNotes.notes.length
          ? <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-700">{ocfNotes.notes.map((n, i) => <li key={i} className="break-words">{n}</li>)}</ul>
          : <p className="text-[13px] text-ink-700">Nothing: the package says everything the cap table does.</p>)}
      </Modal>
    </>
  );
}
