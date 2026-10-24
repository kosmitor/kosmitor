import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, SegmentedControl, cx } from '../../ui.tsx';
import { DataTable, type Column } from '../../DataTable.tsx';
import { AWARD_LABELS, INSTRUMENT_LABELS, RELATION_LABELS, date, money, percent, pps, shares } from '../../format.ts';
import { plural, verdict, type PreviewRow, type RowMessage, type SheetResult } from './model.ts';
import { OCF_SECTION_WORDS, eventLabel, ocfNeedsOwnFix, ocfWaits, type OcfSection } from './ocf.ts';

type Format = 'text' | 'code' | 'shares' | 'price' | 'money' | 'percent' | 'date' | 'yes' | 'event';

/** The columns of each section, from the row's summary. `wide` columns show from 1280px up. */
const SUMMARY: Record<OcfSection, { key: string; label: string; format: Format; wide?: boolean }[]> = {
  stakeholders: [
    { key: 'stakeholder', label: 'Name', format: 'text' }, { key: 'email', label: 'Email', format: 'text' },
    { key: 'type', label: 'Type', format: 'code', wide: true }, { key: 'relation', label: 'Relationship', format: 'code' },
    { key: 'startDate', label: 'Start date', format: 'date', wide: true },
  ],
  shareClasses: [
    { key: 'name', label: 'Name', format: 'text' }, { key: 'classType', label: 'Type', format: 'code' }, { key: 'authorized', label: 'Authorized', format: 'shares' },
    { key: 'price', label: 'Price', format: 'price' }, { key: 'seniority', label: 'Seniority', format: 'text', wide: true }, { key: 'votes', label: 'Votes', format: 'text', wide: true },
  ],
  plans: [
    { key: 'name', label: 'Name', format: 'text' }, { key: 'shareClass', label: 'Class', format: 'text' },
    { key: 'reserved', label: 'Reserved', format: 'shares' }, { key: 'boardApprovalDate', label: 'Board approval', format: 'date' },
  ],
  vesting: [{ key: 'name', label: 'Name', format: 'text' }, { key: 'reading', label: 'Reads as', format: 'text' }],
  valuations: [
    { key: 'effectiveDate', label: 'Effective', format: 'date' }, { key: 'price', label: 'Price', format: 'price' },
    { key: 'provider', label: 'Provider', format: 'text' }, { key: 'shareClass', label: 'Class', format: 'text', wide: true },
  ],
  captable: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'shareClass', label: 'Class', format: 'text' },
    { key: 'shares', label: 'Shares', format: 'shares' }, { key: 'price', label: 'Price', format: 'price' },
    { key: 'issueDate', label: 'Issue date', format: 'date' }, { key: 'certificate', label: 'Certificate', format: 'text', wide: true },
    { key: 'state', label: 'Today', format: 'code', wide: true },
  ],
  grants: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'type', label: 'Type', format: 'code' },
    { key: 'shares', label: 'Shares', format: 'shares' }, { key: 'strike', label: 'Strike', format: 'price' },
    { key: 'grantDate', label: 'Grant date', format: 'date' }, { key: 'label', label: 'Grant number', format: 'text', wide: true },
    { key: 'state', label: 'Today', format: 'code', wide: true },
  ],
  warrants: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'shareClass', label: 'Class', format: 'text' },
    { key: 'shares', label: 'Shares', format: 'shares' }, { key: 'strike', label: 'Strike', format: 'price' },
    { key: 'issueDate', label: 'Issue date', format: 'date' }, { key: 'expirationDate', label: 'Expires', format: 'date', wide: true },
    { key: 'state', label: 'Today', format: 'code', wide: true },
  ],
  convertibles: [
    { key: 'stakeholder', label: 'Stakeholder', format: 'text' }, { key: 'instrument', label: 'Instrument', format: 'code' },
    { key: 'principal', label: 'Amount', format: 'money' }, { key: 'cap', label: 'Cap', format: 'money', wide: true },
    { key: 'discount', label: 'Discount', format: 'percent', wide: true }, { key: 'issueDate', label: 'Issue date', format: 'date' },
    { key: 'status', label: 'Today', format: 'code', wide: true },
  ],
  events: [
    { key: 'date', label: 'Date', format: 'date' }, { key: 'event', label: 'Event', format: 'event' },
    { key: 'security', label: 'Security', format: 'text' }, { key: 'stakeholder', label: 'Stakeholder', format: 'text', wide: true },
    { key: 'quantity', label: 'Shares', format: 'shares' }, { key: 'detail', label: 'Detail', format: 'text', wide: true },
  ],
};
const NUMERIC = new Set<Format>(['shares', 'price', 'money', 'percent']);

const STATES: Record<string, string> = {
  OUTSTANDING: 'Outstanding', TRANSFERRED: 'Transferred', REPURCHASED: 'Repurchased', CANCELLED: 'Cancelled', CONVERTED: 'Converted',
  EXERCISED: 'Exercised', EXPIRED: 'Expired', FORFEITED: 'Forfeited', REPAID: 'Repaid', COMMON: 'Common', PREFERRED: 'Preferred',
  INDIVIDUAL: 'Individual', ENTITY: 'Entity', TRUST: 'Trust', FUND: 'Fund',
};
const codeLabel = (section: OcfSection, key: string, v: string): string => {
  if (key === 'relation') return RELATION_LABELS[v] ?? v;
  if (key === 'type' && section === 'grants') return AWARD_LABELS[v] ?? v;
  if (key === 'instrument') return INSTRUMENT_LABELS[v] ?? v;
  return STATES[v] ?? v;
};

function shown(section: OcfSection, key: string, format: Format, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (format === 'shares') return shares(v);
    if (format === 'price') return pps(Math.round(v * 1e6));
    if (format === 'money') return money(Math.round(v * 100), { decimals: 0 });
    if (format === 'percent') return percent(v, (v * 100) % 1 ? 1 : 0);
    return String(v);
  }
  if (format === 'date') return /^\d{4}-\d{2}-\d{2}/.test(v) ? date(v) : v;
  if (format === 'event') return eventLabel(v);
  if (format === 'code') return codeLabel(section, key, v);
  return v;
}

/** The phone's line under the first cell: what the row is, in a few words. */
function brief(section: OcfSection, s: PreviewRow['summary']): string {
  const cols = SUMMARY[section].slice(1, 4);
  return cols.map((c) => (s[c.key] == null || s[c.key] === '' ? '' : shown(section, c.key, c.format, s[c.key]))).filter(Boolean).join(' · ');
}

const MESSAGE_TONE: Record<string, string> = { error: 'text-red-700', warning: 'text-amber-800', info: 'text-ink-600' };
/** Info messages shown under a row: what an update or a fold does, why a row is skipped, and the rows "Show rows" asked for. */
const shownInfo = (r: PreviewRow, m: RowMessage, only: string | null): boolean =>
  ['stakeholder-updated', 'class-updated', 'ocf-folded', 'ocf-excluded-with', 'ocf-not-imported', 'ocf-acceleration-not-applied'].includes(m.code ?? '')
  || r.outcome === 'skip' || (!!only && m.code === only);

export interface OcfSectionProps {
  section: OcfSection;
  sheet: SheetResult;
  busy: boolean;
  /** Why each row the person left out was left out. */
  why: Record<number, string>;
  only: string | null;
  onLeaveOut: (row: number) => void;
  onPutBack: (row: number) => void;
}

/**
 * One section of an OCF package: its rows ("Item N", the object's place in its
 * files) with what happens to each, and problems under the row. A row left out with
 * its family, or waiting for another row's fix, says so and has no buttons: the
 * other row is where it is settled.
 */
export function OcfSectionTable({ section, sheet, busy, why, only, onLeaveOut, onPutBack }: OcfSectionProps) {
  const rows = sheet.preview.rows;
  const attention = rows.filter((r) => (r.status !== 'ok' && r.outcome !== 'excluded') || (r.outcome === 'excluded' && r.messages.some((m) => m.code === 'excluded')));
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [showAll, setShowAll] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<{ row: number; sheet: SheetResult } | null>(null);
  useEffect(() => {
    const f = focusAfter.current;
    if (!f || busy || f.sheet === sheet || !root.current) return;
    focusAfter.current = null;
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
  const c = sheet.preview.counts;
  const words = OCF_SECTION_WORDS[section];
  const own = rows.filter(ocfNeedsOwnFix).length;
  const waiting = rows.filter(ocfWaits).length;
  const skipped = rows.filter((r) => r.outcome === 'skip').length;
  const subtitle = [
    plural(c.total, 'item'),
    c.errors === 0 && c.warnings === 0 && c.existing === 0 && c.excluded === 0 && skipped === 0 ? 'all ready' : '',
    own ? `${own} to fix` : '', waiting ? `${waiting} waiting` : '', c.warnings ? `${c.warnings} to check` : '',
    c.existing ? `${c.existing} already there` : '', c.excluded ? `${c.excluded} left out` : '', skipped ? `${skipped} not imported` : '',
  ].filter(Boolean).join(' · ');
  const title = words.title;

  const columns = useMemo<Column<PreviewRow>[]>(() => [
    { key: 'row', label: 'Item', type: 'number', width: 64, value: (r) => r.row, cell: (r) => r.row, className: 'text-ink-500' },
    { key: 'status', label: 'Status', width: 112, value: (r) => verdict(r).word, cell: (r) => { const v = verdict(r); return <Badge tone={v.tone}>{ocfWaits(r) ? 'Waits' : r.outcome === 'skip' ? 'Not imported' : v.word}</Badge>; } },
    ...SUMMARY[section].map((col, i): Column<PreviewRow> => ({
      key: col.key, label: col.label, type: NUMERIC.has(col.format) ? 'number' : col.format === 'date' ? 'date' : 'text',
      value: (r) => { const v = r.summary[col.key]; return typeof v === 'number' || typeof v === 'string' ? v : null; },
      hideBelow: i === 0 ? undefined : col.wide ? 'xl' : 'sm',
      cell: i === 0
        ? (r) => (
          <>
            <span className="font-medium text-ink-900">{shown(section, col.key, col.format, r.summary[col.key])}</span>
            <span className="block text-[12px] text-ink-500 sm:hidden">{brief(section, r.summary)}</span>
          </>
        )
        : (r) => shown(section, col.key, col.format, r.summary[col.key]),
      className: i === 0 ? 'max-sm:whitespace-normal' : col.format === 'text' ? 'max-w-[240px] truncate' : undefined,
    })),
  ], [section]);

  const detailOf = (r: PreviewRow): boolean => r.outcome === 'excluded' || r.messages.some((m) => m.level !== 'info' || shownInfo(r, m, only));

  return (
    <div ref={root} role="group" aria-label={title} tabIndex={-1} className="outline-none">
      <DataTable caption={title} title={title} subtitle={subtitle}
        controls={attention.length > 0 && !(only && onlyRows.length) ? (
          <SegmentedControl size="sm" value={shownFilter} onChange={(v) => { setFilter(v); setShowAll(false); }} options={[
            { value: 'attention', label: `Needs attention (${attention.length})` },
            { value: 'all', label: `All (${rows.length})` },
          ]} />
        ) : undefined}
        fullSize={filtered.length > 10 ? `${title}, full size` : false}
        busy={busy}
        maxHeight={showAll && filtered.length > 10 ? '70vh' : undefined}
        rows={limited} rowKey={(r) => r.row} columns={columns}
        rowTone={(r) => (r.status === 'error' ? 'red' : r.status === 'warning' && r.outcome !== 'existing' ? 'amber' : undefined)}
        rowClassName={(r) => cx(detailOf(r) && '[&>td]:border-b-0', (r.outcome === 'excluded' || r.outcome === 'skip') && 'text-ink-400')}
        expand={(r) => (detailOf(r) ? (
          <RowDetail key={`d${r.row}`} section={section} row={r} only={only} why={why[r.row]}
            onLeaveOut={() => { focusAfter.current = { row: r.row, sheet }; onLeaveOut(r.row); }}
            onPutBack={() => { focusAfter.current = { row: r.row, sheet }; onPutBack(r.row); }} />
        ) : null)}
        empty={<p className="px-5 py-8 text-center text-[13px] text-ink-500">{busy ? 'Checking…' : `No ${words.many} in this package.`}</p>}
        after={filtered.length > 10 || (only && onlyRows.length) ? (
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] text-ink-500">
            {filtered.length > 10 && (
              <button type="button" className="font-medium text-brand-600 hover:text-brand-700" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer items' : `Show all ${filtered.length.toLocaleString()} items`}
              </button>
            )}
          </div>
        ) : undefined} />
    </div>
  );
}

/** A row's messages under it, and Leave out or Put it back. A row that waits for another, or was left out with one, has no buttons. */
function RowDetail({ section, row, only, why, onLeaveOut, onPutBack }: {
  section: OcfSection; row: PreviewRow; only: string | null; why: string | undefined; onLeaveOut: () => void; onPutBack: () => void;
}) {
  const byPerson = row.outcome === 'excluded' && row.messages.some((m) => m.code === 'excluded');
  const messages = byPerson ? [] : row.messages.filter((m) => m.level !== 'info' || shownInfo(row, m, only));
  const tone = row.status === 'error' ? 'bg-red-50/40' : row.status === 'warning' && row.outcome !== 'existing' ? 'bg-amber-50/40' : '';
  const asked = row.messages.some((m) => m.code === 'ambiguous-person');
  const actionable = !byPerson && row.outcome !== 'existing' && row.outcome !== 'excluded' && row.outcome !== 'skip' && !ocfWaits(row)
    && (row.status === 'warning' || ocfNeedsOwnFix(row) || asked);
  return (
    <tr className={tone}>
      <td colSpan={SUMMARY[section].length + 2} className="border-b border-ink-100 px-3 pb-3 pt-0 text-[13px]">
        <div className="sm:pl-[4rem]">
          <ul className="space-y-0.5">
            {byPerson && <li className="text-ink-600">{why ? `Left out: ${why}` : 'Left out by you'}</li>}
            {messages.map((m, i) => <li key={i} className={MESSAGE_TONE[m.level]}>{m.code === 'ambiguous-person' ? `${m.text} — answer it above.` : m.text}</li>)}
          </ul>
          {(actionable || byPerson) && (
            <div data-row-actions={row.row} className="mt-2 flex flex-wrap gap-2">
              {actionable && <Button size="sm" variant="ghost" onClick={onLeaveOut}>Leave out</Button>}
              {byPerson && <Button size="sm" onClick={onPutBack}>Put it back</Button>}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
