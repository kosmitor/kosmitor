import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, api, downloadFile } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Table, TH, TD, TR, Badge, Loading, ErrorNote, Button, Input, Field, Select, EmptyState,
  Checkbox, ConfirmDialog, useToast, Modal, cx,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { money, pps, percent, shares, date, today } from '../format.ts';
import { config } from '../config.ts';

interface Column { key: string; label: string; type: 'text' | 'number' | 'money' | 'pps' | 'date' | 'percent' | 'boolean' }
interface Dataset { key: string; label: string; description: string; columns: Column[] }
interface Filter { column: string; op: string; value: string }
interface Saved { id: string; name: string; dataset: string; config: any; updatedAt?: string | null; createdAt: string }

const OP_LABELS: Record<string, string> = { eq: 'is', neq: 'is not', contains: 'contains', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', in: 'is one of', empty: 'is empty', notEmpty: 'is not empty' };
const NO_VALUE = new Set(['empty', 'notEmpty']);

const format = (v: unknown, type: Column['type']) => {
  if (v == null || v === '') return <span className="text-ink-300">—</span>;
  switch (type) {
    case 'money': return money(Number(v));
    case 'pps': return pps(Number(v));
    case 'percent': return percent(Number(v), 2);
    case 'number': return shares(Number(v));
    case 'date': return date(String(v));
    case 'boolean': return v ? 'Yes' : 'No';
    default: return String(v);
  }
};

/** Pick a dataset, the columns, filters and order; preview, export, save. */
export default function ReportBuilder() {
  const { companyId, canViewAll, canEdit } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<{ datasets: Dataset[]; operators: string[]; saved: Saved[] }>(companyId && canViewAll ? `/c/${companyId}/report-builder` : null, [companyId]);
  const [datasetKey, setDatasetKey] = useState('captable');
  const [columns, setColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [asOf, setAsOf] = useState(today());
  const [totals, setTotals] = useState(true);
  const [result, setResult] = useState<{ columns: Column[]; rows: unknown[][]; total: number; truncated: boolean; totalsRow: unknown[] | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [loadedSaved, setLoadedSaved] = useState<Saved | null>(null);
  const [deleting, setDeleting] = useState<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(true);

  const datasets = data?.datasets ?? [];
  const dataset = useMemo(() => datasets.find((d) => d.key === datasetKey) ?? datasets[0], [datasets, datasetKey]);
  const spec = { dataset: dataset?.key, columns, filters: filters.filter((f) => f.column && (NO_VALUE.has(f.op) || f.value !== '')).map((f) => ({ column: f.column, op: f.op, value: f.op === 'in' ? f.value.split(',').map((s) => s.trim()) : f.value })), sort, asOf, totals };

  // A fresh dataset starts with every column.
  useEffect(() => { if (dataset && (columns.length === 0 || !columns.every((c) => dataset.columns.some((d) => d.key === c)))) setColumns(dataset.columns.map((c) => c.key)); }, [dataset]);   // eslint-disable-line react-hooks/exhaustive-deps

  const runNow = async () => {
    if (!dataset) return;
    setRunning(true);
    try { setResult(await api(`/c/${companyId}/report-builder/run`, { body: { ...spec, limit: config.limits.reportPreviewRows } })); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setRunning(false); }
  };
  useEffect(() => { if (dataset && columns.length) void runNow(); }, [dataset?.key, columns.join(','), JSON.stringify(spec.filters), JSON.stringify(sort), asOf, totals]);   // eslint-disable-line react-hooks/exhaustive-deps

  const exportAs = async (fmt: 'csv' | 'xlsx') => {
    setBusy(true);
    try {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(spec)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const name = (loadedSaved?.name ?? dataset?.label ?? 'report').replace(/[^\w.-]+/g, '_');
      await downloadFile(`/c/${companyId}/report-builder/export?format=${fmt}&name=${encodeURIComponent(name)}&spec=${encoded}`, `${name}_${asOf}.${fmt}`);
      toast(fmt === 'xlsx' ? 'Excel workbook downloaded' : 'CSV downloaded');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      if (loadedSaved && saveName === loadedSaved.name) await api(`/c/${companyId}/report-builder/saved/${loadedSaved.id}`, { method: 'PATCH', body: { config: spec } });
      else {
        const s = await api<Saved>(`/c/${companyId}/report-builder/saved`, { body: { name: saveName, config: spec } });
        setLoadedSaved(s);
      }
      toast('Report saved');
      setSaving(false);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const load = (s: Saved) => {
    setLoadedSaved(s);
    setDatasetKey(s.config.dataset);
    setColumns(s.config.columns ?? []);
    setFilters((s.config.filters ?? []).map((f: any) => ({ column: f.column, op: f.op, value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '') })));
    setSort(s.config.sort ?? null);
    setAsOf(s.config.asOf && s.config.asOf < today() ? today() : s.config.asOf ?? today());
    setTotals(!!s.config.totals);
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/report-builder/saved/${deleting!.id}`, { method: 'DELETE' });
      if (loadedSaved?.id === deleting!.id) setLoadedSaved(null);
      setDeleting(null);
      toast('Report deleted');
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const move = (key: string, delta: number) => {
    const i = columns.indexOf(key); const j = i + delta;
    if (i < 0 || j < 0 || j >= columns.length) return;
    const next = [...columns]; [next[i], next[j]] = [next[j], next[i]]; setColumns(next);
  };

  if (!canViewAll) return <EmptyState title="Reports are not available for your role" />;
  if (loading && !data) return <Loading label="Loading the report builder" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!dataset) return null;

  const ordered = columns.map((k) => dataset.columns.find((c) => c.key === k)!).filter(Boolean);

  return (
    <>
      <PageHeader concept="report-builder" title="Report builder" subtitle="Choose a dataset, the columns, filters and order. Preview it here, export to Excel or CSV, and save it to run again."
        actions={<>
          <Link to="/reports"><Button>Standard reports</Button></Link>
          <Button onClick={() => void exportAs('csv')} loading={busy} icon={<Icon name="download" />}>CSV</Button>
          <Button variant="primary" onClick={() => void exportAs('xlsx')} loading={busy} icon={<Icon name="download" />}>Excel</Button>
        </>} />

      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Dataset" />
            <Select value={dataset.key} onChange={(e) => { setDatasetKey(e.target.value); setFilters([]); setSort(null); setLoadedSaved(null); setColumns([]); }}>
              {datasets.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Select>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-500">{dataset.description}</p>
            <div className="mt-3">
              <Field label="As of"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
            </div>
            <div className="mt-3"><Checkbox label="Totals row for number columns" checked={totals} onChange={setTotals} /></div>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <CardHeader title={`Columns (${ordered.length} of ${dataset.columns.length})`} />
              <button type="button" className="text-[12px] text-brand-600 hover:text-brand-700" onClick={() => setColumnsOpen(!columnsOpen)}>{columnsOpen ? 'Collapse' : 'Expand'}</button>
            </div>
            {columnsOpen && (
              <>
                <div className="mb-2 flex gap-2 text-[12px]">
                  <button type="button" className="text-brand-600 hover:text-brand-700" onClick={() => setColumns(dataset.columns.map((c) => c.key))}>All</button>
                  <button type="button" className="text-brand-600 hover:text-brand-700" onClick={() => setColumns(dataset.columns.slice(0, 1).map((c) => c.key))}>None</button>
                </div>
                <ul className="max-h-80 space-y-1 overflow-auto">
                  {dataset.columns.map((c) => {
                    const on = columns.includes(c.key);
                    return (
                      <li key={c.key} className={cx('flex items-center justify-between gap-2 rounded px-1', on && 'bg-ink-50')}>
                        <Checkbox label={c.label} checked={on} onChange={(v) => setColumns(v ? [...columns, c.key] : columns.filter((k) => k !== c.key))} />
                        {on && (
                          <span className="flex shrink-0">
                            <button type="button" className="px-1 text-ink-400 hover:text-ink-700" aria-label="Move up" onClick={() => move(c.key, -1)}>↑</button>
                            <button type="button" className="px-1 text-ink-400 hover:text-ink-700" aria-label="Move down" onClick={() => move(c.key, 1)}>↓</button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>

          <Card>
            <CardHeader title="Saved reports" />
            {(data?.saved ?? []).length === 0
              ? <p className="text-[12px] text-ink-500">Save a definition to run it again with fresh data.</p>
              : (
                <ul className="divide-y divide-ink-100">
                  {data!.saved.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                      <button type="button" className={cx('min-w-0 text-left text-[13px] hover:text-brand-700', loadedSaved?.id === s.id && 'font-semibold text-brand-700')} onClick={() => load(s)}>
                        <span className="block truncate">{s.name}</span>
                        <span className="block text-[11px] font-normal text-ink-500">{datasets.find((d) => d.key === s.dataset)?.label ?? s.dataset}</span>
                      </button>
                      {canEdit && <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(s)}><Icon name="trash" className="size-4" /></Button>}
                    </li>
                  ))}
                </ul>
              )}
            {canEdit && <Button size="sm" className="mt-3" icon={<Icon name="plus" />} onClick={() => { setSaveName(loadedSaved?.name ?? ''); setSaving(true); }}>{loadedSaved ? 'Save changes' : 'Save this report'}</Button>}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardHeader title="Filters and order" />
              <Button size="sm" icon={<Icon name="plus" />} onClick={() => setFilters([...filters, { column: dataset.columns[0].key, op: 'eq', value: '' }])}>Add filter</Button>
            </div>
            {filters.length === 0 && <p className="text-[12px] text-ink-500">No filters: every row of the dataset is included.</p>}
            <div className="space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_150px_1fr_auto]">
                  <Select value={f.column} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
                    {dataset.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </Select>
                  <Select value={f.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
                    {(data?.operators ?? []).map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
                  </Select>
                  <Input value={f.value} disabled={NO_VALUE.has(f.op)} placeholder={f.op === 'in' ? 'a, b, c' : dataset.columns.find((c) => c.key === f.column)?.type === 'date' ? 'YYYY-MM-DD' : 'Value'}
                    onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Button variant="ghost" aria-label="Remove filter" onClick={() => setFilters(filters.filter((_, j) => j !== i))}><Icon name="trash" className="size-4" /></Button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="Sort by" className="w-56">
                <Select value={sort?.column ?? ''} onChange={(e) => setSort(e.target.value ? { column: e.target.value, dir: sort?.dir ?? 'asc' } : null)}>
                  <option value="">Dataset order</option>
                  {dataset.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </Select>
              </Field>
              {sort && (
                <Field label="Direction" className="w-40">
                  <Select value={sort.dir} onChange={(e) => setSort({ ...sort, dir: e.target.value as 'asc' | 'desc' })}>
                    <option value="asc">Ascending</option><option value="desc">Descending</option>
                  </Select>
                </Field>
              )}
              <p className="text-[12px] text-ink-500">Money is exported in dollars, prices per share to six decimals, percentages as numbers (12.5 = 12.5%).</p>
            </div>
          </Card>

          <Card padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 p-4">
              <p className="text-[13px] font-semibold text-ink-900">Preview{result ? ` · ${result.total} row${result.total === 1 ? '' : 's'}${result.truncated ? ` (first ${config.limits.reportPreviewRows} shown)` : ''}` : ''}</p>
              {running && <Badge tone="neutral">Running…</Badge>}
            </div>
            {!result ? <div className="p-6"><Loading label="Running the report" /></div> : result.rows.length === 0 ? <EmptyState title="No rows match" description="Loosen the filters or pick another dataset." /> : (
              <div className="overflow-auto">
                <Table>
                  <thead><tr>{result.columns.map((c) => <TH key={c.key} align={['number', 'money', 'pps', 'percent'].includes(c.type) ? 'right' : undefined}>{c.label}</TH>)}</tr></thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <TR key={i}>{r.map((v, j) => <TD key={j} align={['number', 'money', 'pps', 'percent'].includes(result.columns[j].type) ? 'right' : undefined} mono={['number', 'money', 'pps', 'percent'].includes(result.columns[j].type)}>{format(v, result.columns[j].type)}</TD>)}</TR>
                    ))}
                    {result.totalsRow && (
                      <TR>{result.totalsRow.map((v, j) => <TD key={j} align={['number', 'money'].includes(result.columns[j].type) ? 'right' : undefined} mono className="font-semibold">{typeof v === 'number' ? format(v, result.columns[j].type) : String(v)}</TD>)}</TR>
                    )}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal open={saving} onClose={() => setSaving(false)} title="Save report" size="md"
        footer={<><Button onClick={() => setSaving(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!saveName.trim()} onClick={() => void save()}>Save</Button></>}>
        <Field label="Name" required><Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Board deck — option ledger" autoFocus /></Field>
        <p className="mt-2 text-[12px] text-ink-500">Saved reports keep the dataset, columns, filters and order; they run against current data whenever you open them.</p>
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy} title="Delete saved report" confirmLabel="Delete"
        message={<>Delete <strong>{deleting?.name}</strong>?</>} onConfirm={() => void remove()} />
    </>
  );
}
