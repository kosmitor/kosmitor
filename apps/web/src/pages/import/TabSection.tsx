import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Input, SegmentedControl, cx } from '../../ui.tsx';
import { DataTable, type Column } from '../../DataTable.tsx';
import { Icon } from '../../icons.tsx';
import { date, money, percent, pps, shares } from '../../format.ts';
import {
  KIND_WORDS, cardAnswers, cellText, codeLabel, indexOfRow, mappingOf, needsOwnFix, plural, verdict,
  type Cell, type FieldSpec, type Kind, type Notice, type PreviewRow, type RowMessage, type SheetResult, type Tab,
} from './model.ts';

type Format = 'text' | 'code' | 'shares' | 'price' | 'money' | 'percent' | 'date' | 'yes';
/**
 * The columns of each kind's review, from the row's summary: the row as read
 * from the file. `field` is the summary's key when the column's own key would
 * clash with the Status column's; `wide` columns show from 1280px up (a laptop
 * with the sidebar has room for the rest; Edit row shows every field).
 */
const SUMMARY: Record<Kind, { key: string; field?: string; label: string; format: Format; wide?: boolean }[]> = {
  stakeholders: [
    { key: 'stakeholder', label: 'Name', format: 'text' }, { key: 'email', label: 'Email', format: 'text' },
    { key: 'type', label: 'Type', format: 'code', wide: true }, { key: 'relation', label: 'Relationship', format: 'code' },
    { key: 'startDate', label: 'Start date', format: 'date' },
  ],
  captable: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'shareClass', label: 'Class', format: 'text' },
    { key: 'shares', label: 'Shares', format: 'shares' }, { key: 'price', label: 'Price', format: 'price' },
    { key: 'issueDate', label: 'Issue date', format: 'date' }, { key: 'certificate', label: 'Certificate', format: 'text', wide: true },
    { key: 'vesting', label: 'Vesting', format: 'yes', wide: true },
  ],
  grants: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'type', label: 'Type', format: 'code' },
    { key: 'shares', label: 'Shares', format: 'shares' }, { key: 'strike', label: 'Strike', format: 'price' },
    { key: 'grantDate', label: 'Grant date', format: 'date' }, { key: 'label', label: 'Grant number', format: 'text', wide: true },
    { key: 'vesting', label: 'Vesting', format: 'yes', wide: true },
  ],
  convertibles: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'instrument', label: 'Instrument', format: 'code' },
    { key: 'principal', label: 'Amount', format: 'money' }, { key: 'cap', label: 'Cap', format: 'money' },
    { key: 'discount', label: 'Discount', format: 'percent', wide: true }, { key: 'issueDate', label: 'Issue date', format: 'date' },
    { key: 'label', label: 'ID', format: 'text', wide: true }, { key: 'state', field: 'status', label: 'State', format: 'code', wide: true },
  ],
};
const NUMERIC = new Set<Format>(['shares', 'price', 'money', 'percent']);

/** A summary value as the rest of the app writes it. Money is in dollars here, prices in dollars per share. */
function shown(kind: Kind, key: string, format: Format, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (format === 'shares') return shares(v);
    if (format === 'price') return pps(Math.round(v * 1e6));
    if (format === 'money') return money(Math.round(v * 100), { decimals: 0 });
    if (format === 'percent') return percent(v, v * 100 % 1 ? 1 : 0);
    return String(v);
  }
  if (format === 'date') return /^\d{4}-\d{2}-\d{2}/.test(v) ? date(v) : v;
  if (format === 'yes') return v === 'yes' ? 'Yes' : v;
  if (format === 'code') return codeLabel(kind, key, v);
  return v;
}

/** The phone's second line under the name: what the row is, in a few words. */
function brief(kind: Kind, s: PreviewRow['summary']): string {
  const at = (k: string, f: Format) => (s[k] == null || s[k] === '' ? '' : shown(kind, k, f, s[k]));
  const parts = kind === 'captable' ? [[at('shares', 'shares'), at('shareClass', 'text')].filter(Boolean).join(' '), at('issueDate', 'date')]
    : kind === 'grants' ? [[at('shares', 'shares'), at('type', 'code')].filter(Boolean).join(' '), at('grantDate', 'date')]
    : kind === 'convertibles' ? [[at('principal', 'money'), at('instrument', 'code')].filter(Boolean).join(' '), at('issueDate', 'date')]
    : [at('relation', 'code'), at('email', 'text')];
  return parts.filter(Boolean).join(' · ');
}

const MESSAGE_TONE: Record<string, string> = { error: 'text-red-700', warning: 'text-amber-800', info: 'text-ink-600' };

/** Info messages a row shows under it: what an update changes, and why a row is skipped. */
const shownInfo = (r: PreviewRow, m: RowMessage, only: string | null): boolean =>
  m.code === 'stakeholder-updated' || r.outcome === 'skip' || (!!only && m.code === only);

export interface TabSectionProps {
  tab: Tab;
  sheet: SheetResult | null;
  fields: FieldSpec[];
  /** The tab waits for a question to be answered before it is checked. */
  waiting: boolean;
  busy: boolean;
  /** The company has vesting schedules, so the vesting card can answer rows that name none. */
  hasSchedules: boolean;
  /** Why each row the person left out was left out, by row. */
  why: Record<number, string>;
  /** The rows as the check sees them, with the person's edits: what Edit row starts from. */
  currentRows: Cell[][];
  /** Shown as part of the tab's name when the import has several files. */
  showFile: boolean;
  /** One file, one table (a CSV): named by the file rather than the tab. */
  single: boolean;
  /** "Show rows" from the assumptions: only the rows with this info code, with their note. */
  only: string | null;
  onColumns: () => void;
  onSaveRow: (row: number, values: Record<string, string>) => void;
  onLeaveOut: (row: number) => void;
  onPutBack: (row: number) => void;
}

/**
 * One tab of the import: its rows with their verdicts, problems under the row
 * they belong to. After Edit row, Leave out or Put it back, once the check has
 * run again, focus goes to that row's buttons, or the next row's that has any,
 * or the table: never back to the top of the page.
 */
export function TabSection({ tab, sheet, fields, waiting, busy, hasSchedules, why, currentRows, showFile, single, only,
  onColumns, onSaveRow, onLeaveOut, onPutBack }: TabSectionProps) {
  const kind = tab.kind!;
  const rows = sheet?.preview.rows ?? [];
  // Rows with problems, and those left out for theirs: a row left out stays in place, with Put it back.
  const attention = rows.filter((r) => (r.status !== 'ok' && r.outcome !== 'excluded') || (r.outcome === 'excluded' && !!why[r.row]));
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // The row acted on, and the review it was acted on in: focus moves once a newer one is drawn.
  const focusAfter = useRef<{ row: number; sheet: SheetResult | null | undefined } | null>(null);
  const after = (row: number, recheck: boolean) => { focusAfter.current = { row, sheet: recheck ? sheet : undefined }; };
  useEffect(() => {
    const f = focusAfter.current;
    if (!f || busy || (f.sheet !== undefined && f.sheet === sheet) || !root.current) return;
    focusAfter.current = null;
    // Only focus that was lost (to the page) is moved: someone who went on elsewhere stays there.
    const active = document.activeElement;
    if (active && active !== document.body && !root.current.contains(active)) return;
    const holders = Array.from(root.current.querySelectorAll<HTMLElement>('[data-row-actions]'));
    const at = (el: HTMLElement) => Number(el.dataset.rowActions);
    const target = holders.find((el) => at(el) === f.row) ?? holders.find((el) => at(el) > f.row) ?? holders.filter((el) => at(el) < f.row).at(-1);
    (target?.querySelector<HTMLElement>('button') ?? root.current).focus();
  });
  const onlyRows = only ? rows.filter((r) => r.messages.some((m) => m.code === only)) : [];
  const shownFilter = filter === 'attention' && attention.length > 0 ? 'attention' : 'all';
  const filtered = only && onlyRows.length ? onlyRows : shownFilter === 'attention' ? attention : rows;
  const limited = filtered.length > 10 && !showAll ? filtered.slice(0, 5) : filtered;
  const counts = sheet?.preview.counts;

  const title = `${KIND_WORDS[kind].title} · ${single ? tab.file : `“${tab.name}” tab`}`;
  // Rows with an error of their own, and rows that wait only for a question's answer above.
  const own = rows.filter((r) => needsOwnFix(r, hasSchedules)).length;
  const answering = rows.filter((r) => r.status === 'error' && !needsOwnFix(r, hasSchedules)).length;
  const skipped = rows.filter((r) => r.outcome === 'skip').length;
  const subtitle = waiting ? 'Waiting for your answer' : !counts ? 'Checking…' : [
    plural(counts.total, 'row'),
    counts.errors === 0 && counts.warnings === 0 && counts.existing === 0 && counts.excluded === 0 && skipped === 0 ? 'all ready' : '',
    own ? `${own} to fix` : '',
    answering ? `${answering} waiting for an answer` : '',
    counts.warnings ? `${counts.warnings} to check` : '',
    counts.existing ? `${counts.existing} already there` : '',
    counts.excluded ? `${counts.excluded} left out` : '',
    skipped ? `${skipped} skipped` : '',
    showFile && !single ? tab.file : '',
  ].filter(Boolean).join(' · ');

  const notices: Notice[] = [];
  for (const n of [...tab.notices, ...(sheet?.preview.notices ?? [])]) if (!notices.some((x) => x.code === n.code)) notices.push(n);

  const columns = useMemo<Column<PreviewRow>[]>(() => [
    { key: 'row', label: 'Row', type: 'number', width: 56, value: (r) => r.row, cell: (r) => r.row, className: 'text-ink-500' },
    {
      key: 'status', label: 'Status', width: 112, value: (r) => verdict(r).word,
      cell: (r) => { const v = verdict(r); return <Badge tone={v.tone}>{v.word}</Badge>; },
    },
    ...SUMMARY[kind].map((c, i): Column<PreviewRow> => {
      const field = c.field ?? c.key;
      return {
        key: c.key, label: c.label, type: NUMERIC.has(c.format) ? 'number' : c.format === 'date' ? 'date' : 'text',
        value: (r) => { const v = r.summary[field]; return typeof v === 'number' || typeof v === 'string' ? v : null; },
        // On a phone only the row, its verdict and the name show; the rest is a line under the name.
        hideBelow: i === 0 ? undefined : c.wide ? 'xl' : 'sm',
        cell: i === 0
          ? (r) => (
            <>
              <span className="font-medium text-ink-900">{shown(kind, field, c.format, r.summary[field])}</span>
              <span className="block text-[12px] text-ink-500 sm:hidden">{brief(kind, r.summary)}</span>
            </>
          )
          : (r) => shown(kind, field, c.format, r.summary[field]),
        className: i === 0 ? 'max-sm:whitespace-normal' : c.format === 'text' ? 'max-w-[220px] truncate' : undefined,
      };
    }),
  ], [kind]);

  const detailOf = (r: PreviewRow): boolean => r.outcome === 'excluded'
    || r.messages.some((m) => m.level !== 'info' || shownInfo(r, m, only));

  return (
    <div ref={root} role="group" aria-label={title} tabIndex={-1} className="outline-none">
    <DataTable caption={title} title={title} subtitle={subtitle}
      controls={!waiting && attention.length > 0 && !(only && onlyRows.length) ? (
        <SegmentedControl size="sm" value={shownFilter} onChange={(v) => { setFilter(v); setShowAll(false); }} options={[
          { value: 'attention', label: `Needs attention (${attention.length})` },
          { value: 'all', label: `All (${rows.length})` },
        ]} />
      ) : undefined}
      actions={<Button size="sm" icon={<Icon name="settings" />} onClick={onColumns}>Columns</Button>}
      fullSize={filtered.length > 10 ? `${title}, full size` : false}
      busy={busy}
      maxHeight={showAll && filtered.length > 10 ? '70vh' : undefined}
      rows={waiting ? [] : limited} rowKey={(r) => r.row} columns={columns}
      rowTone={(r) => (r.status === 'error' ? 'red' : r.status === 'warning' && r.outcome !== 'existing' ? 'amber' : undefined)}
      rowClassName={(r) => cx(detailOf(r) && '[&>td]:border-b-0', (r.outcome === 'excluded' || r.outcome === 'skip') && 'text-ink-400')}
      expand={(r) => (detailOf(r) ? (
        <RowDetail key={`d${r.row}`} tab={tab} row={r} fields={fields} only={only} hasSchedules={hasSchedules} why={why[r.row]}
          current={currentRows[indexOfRow(tab, r.row)] ?? []} editing={editing === r.row}
          onEdit={() => setEditing(r.row)} onCancel={() => { after(r.row, false); setEditing(null); }}
          onSave={(values) => { after(r.row, true); setEditing(null); onSaveRow(r.row, values); }}
          onLeaveOut={() => { after(r.row, true); onLeaveOut(r.row); }} onPutBack={() => { after(r.row, true); onPutBack(r.row); }} />
      ) : null)}
      empty={
        <p className="px-5 py-8 text-center text-[13px] text-ink-500">
          {waiting ? 'Waiting for your answer above.' : busy || !sheet ? 'Checking…' : 'This tab has no rows to import.'}
        </p>
      }
      before={notices.length > 0 && !waiting ? (
        <ul className="space-y-1 border-b border-ink-100 bg-amber-50/50 px-4 py-2.5 text-[13px] text-amber-900">
          {notices.map((n) => <li key={n.code}>{n.text}</li>)}
        </ul>
      ) : undefined}
      after={!waiting && (filtered.length > 10 || (only && onlyRows.length) || (sheet?.columnsNotImported.length ?? 0) > 0) ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] text-ink-500">
          {sheet && sheet.columnsNotImported.length > 0 ? (
            <span className="min-w-0">Not imported from this tab: {sheet.columnsNotImported.join(', ')}</span>
          ) : <span />}
          {filtered.length > 10 && (
            <button type="button" className="font-medium text-brand-600 hover:text-brand-700" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer rows' : `Show all ${filtered.length.toLocaleString()} rows`}
            </button>
          )}
        </div>
      ) : undefined} />
    </div>
  );
}

/**
 * What a row needs, under the row: its messages as the server wrote them, and
 * Edit row (the row's imported fields as text, the bad one first) and Leave out.
 * An error a question above answers for every row is not repeated here: the
 * row says it waits for that answer, and has no buttons for it.
 */
function RowDetail({ tab, row, fields, only, hasSchedules, why, current, editing, onEdit, onCancel, onSave, onLeaveOut, onPutBack }: {
  tab: Tab; row: PreviewRow; fields: FieldSpec[]; only: string | null; hasSchedules: boolean; why: string | undefined; current: Cell[]; editing: boolean;
  onEdit: () => void; onCancel: () => void; onSave: (values: Record<string, string>) => void; onLeaveOut: () => void; onPutBack: () => void;
}) {
  const excluded = row.outcome === 'excluded';
  const waitsForAnswer = row.messages.some((m) => cardAnswers(m, hasSchedules));
  const messages = excluded ? [] : row.messages.filter((m) => (m.level === 'info' ? shownInfo(row, m, only) : !cardAnswers(m, hasSchedules)));
  const tone = row.status === 'error' ? 'bg-red-50/40' : row.status === 'warning' && row.outcome !== 'existing' ? 'bg-amber-50/40' : '';
  const actionable = row.outcome !== 'existing' && !excluded
    && (row.status === 'warning' || (row.status === 'error' && needsOwnFix(row, hasSchedules)));
  return (
    <tr className={tone}>
      <td colSpan={SUMMARY[tab.kind!].length + 2} className="border-b border-ink-100 px-3 pb-3 pt-0 text-[13px]">
        <div className="sm:pl-[3.5rem]">
          <ul className="space-y-0.5">
            {excluded && <li className="text-ink-600">{why ? `Left out: ${why}` : 'Left out by you'}</li>}
            {messages.map((m, i) => <li key={i} className={MESSAGE_TONE[m.level]}>{m.text}</li>)}
            {waitsForAnswer && !excluded && (
              <li className="text-ink-600">{messages.some((m) => m.level === 'error') ? 'It also waits for your answer above.' : 'Waits for your answer above.'}</li>
            )}
          </ul>
          {editing ? (
            <EditRow tab={tab} row={row} fields={fields} hasSchedules={hasSchedules} current={current} onCancel={onCancel} onSave={onSave} />
          ) : (actionable || excluded) && (
            <div data-row-actions={row.row} className="mt-2 flex flex-wrap gap-2">
              {actionable && <Button size="sm" icon={<Icon name="edit" />} onClick={onEdit}>Edit row</Button>}
              {actionable && <Button size="sm" variant="ghost" onClick={onLeaveOut}>Leave out</Button>}
              {excluded && <Button size="sm" onClick={onPutBack}>Put it back</Button>}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/** The row's imported fields as text, the ones its messages name first and marked. Changes apply to this import only. */
function EditRow({ tab, row, fields, hasSchedules, current, onCancel, onSave }: {
  tab: Tab; row: PreviewRow; fields: FieldSpec[]; hasSchedules: boolean; current: Cell[]; onCancel: () => void; onSave: (values: Record<string, string>) => void;
}) {
  const mapping = mappingOf(tab);
  const bad = new Set(row.messages.filter((m) => m.level !== 'info' && m.field && !cardAnswers(m, hasSchedules)).map((m) => m.field!));
  const editable = fields.filter((f) => typeof mapping[f.key] === 'number' || bad.has(f.key));
  const ordered = [...editable.filter((f) => bad.has(f.key)), ...editable.filter((f) => !bad.has(f.key))];
  const start = useMemo(() => Object.fromEntries(ordered.map((f) => {
    const col = mapping[f.key];
    return [f.key, typeof col === 'number' ? cellText(current[col]) : ''];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), []);
  const [values, setValues] = useState<Record<string, string>>(start);
  const first = useRef<HTMLInputElement>(null);
  // The page keeps room under the pinned bar (scroll-padding), so the field is never behind it.
  useEffect(() => { first.current?.focus({ preventScroll: true }); first.current?.scrollIntoView({ block: 'nearest' }); }, []);

  const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== start[k]));
  return (
    <form className="mt-3" onSubmit={(e) => { e.preventDefault(); onSave(changed); }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((f, i) => (
          <label key={f.key} className="block min-w-0">
            <span className="mb-1 block text-[12px] font-medium text-ink-700">{f.label}</span>
            <Input ref={i === 0 ? first : undefined} value={values[f.key] ?? ''} aria-invalid={bad.has(f.key) || undefined}
              className={cx(bad.has(f.key) && 'border-red-300 bg-red-50/40')}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-ink-500">Changes apply to this import, not to your file: fix the file too if you will import it again.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={Object.keys(changed).length === 0}>Check again</Button>
        <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

