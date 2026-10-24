import type { ReactNode, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card } from '../../ui.tsx';
import { Icon } from '../../icons.tsx';
import {
  BACK_TO, cellText, changedFields, csvCell, dataRowsOf, headersOf, indexOfRow, isKind, plural, tabOf,
  type PreviewRow, type Review, type Tab,
} from './model.ts';
import { fieldList, ocfLeftOutCsv } from './ocf.ts';

/** A row that did not go in: left out by the person, or, with "Leave out N rows", for its errors. */
const leftOut = (r: PreviewRow): boolean => r.outcome === 'excluded' || r.status === 'error';

/**
 * The rows that were left out, as a CSV: the file's own cells as they came,
 * plus a Problem column (what was wrong with the row when it was left out).
 * Rows of several tabs go in one file, each tab with its own header line and
 * the file and tab it came from.
 */
function leftOutCsv(result: Review, tabs: Tab[], why: Record<string, Record<number, string>>): string {
  const groups = result.sheets.map((s) => ({ s, t: tabOf(tabs, s), rows: s.preview.rows.filter(leftOut) })).filter((g) => g.t && g.rows.length);
  const several = groups.length > 1;
  const lines: string[] = [];
  for (const { s, t, rows } of groups) {
    const tab = t!;
    if (lines.length) lines.push('');
    lines.push([...(several ? ['File', 'Tab'] : []), 'Row', ...headersOf(tab).map((h) => cellText(h)), 'Problem'].map(csvCell).join(','));
    const data = dataRowsOf(tab);
    for (const r of rows) {
      const cells = data[indexOfRow(tab, r.row)] ?? [];
      const problem = r.messages.filter((m) => m.level === 'error').map((m) => m.text).join(' ') || why[tab.key]?.[r.row] || 'Left out by you';
      lines.push([...(several ? [s.file ?? '', s.sheetName] : []), r.row, ...cells, problem].map(csvCell).join(','));
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Done: what was added, what was updated, what was already there and what was left out, and where to check it. */
export function DoneScreen({ result, files, tabs, why, kind, ocf = false, heading, onMore }: {
  result: Review; files: string[]; tabs: Tab[]; why: Record<string, Record<number, string>>; kind: string | null;
  /** An Open Cap Format package was imported: its sections are the tabs. */
  ocf?: boolean;
  heading: RefObject<HTMLHeadingElement | null>; onMore: () => void;
}) {
  const navigate = useNavigate();
  const i = result.imported;
  const added = [
    i.stakeholders ? plural(i.stakeholders, 'stakeholder') : '',
    i.shareClasses ? plural(i.shareClasses, 'share class', 'share classes') : '',
    i.pools ? plural(i.pools, 'equity plan') : '',
    i.vestingSchedules ? plural(i.vestingSchedules, 'vesting schedule') : '',
    i.issuances ? plural(i.issuances, 'certificate') : '',
    i.awards ? plural(i.awards, 'grant') : '',
    i.convertibles ? plural(i.convertibles, 'SAFE or note', 'SAFEs & notes') : '',
    i.warrants ? plural(i.warrants, 'warrant') : '',
    i.valuations ? plural(i.valuations, 'valuation') : '',
    i.stockSplits ? plural(i.stockSplits, 'stock split') : '',
    i.poolAdjustments ? plural(i.poolAdjustments, 'plan change') : '',
    i.events ? plural(i.events, 'history entry', 'history entries') : '',
  ].filter(Boolean);
  const changed = changedFields(result);
  const guessed = result.newPeople.filter((p) => p.guessed).length;
  const out = result.sheets.reduce((n, s) => n + s.preview.rows.filter(leftOut).length, 0);
  const back = isKind(kind) ? BACK_TO[kind] : BACK_TO.captable;
  const lines: { label: string; value: ReactNode }[] = [
    { label: 'Added', value: added.length ? added.join(', ') : 'Nothing new' },
    ...(i.updated.stakeholders ? [{ label: 'Updated', value: `${plural(i.updated.stakeholders, 'stakeholder')}${changed.length ? ` (${changed.join(', ')})` : ''}` }] : []),
    // What a package changed of the company's own record and of classes already on file.
    ...(result.ocf?.companyFillApplied && result.ocf.companyFill.length ? [{ label: 'Company', value: `${fieldList(result.ocf.companyFill)} filled in from the package` }] : []),
    ...(result.ocf?.classUpdates.length ? [{ label: 'Share classes', value: `${result.ocf.classUpdates.join(', ')} took the package's terms` }] : []),
    ...(result.raised.length ? [{ label: 'Raised', value: result.raised.map((r) => `${r.name}: ${r.from.toLocaleString()} → ${r.to.toLocaleString()} authorized shares`).join('; ') }] : []),
    ...(result.counts.existing ? [{ label: 'Already there', value: `${plural(result.counts.existing, ocf ? 'item was' : 'row was', ocf ? 'items were' : 'rows were')} on the cap table and ${result.counts.existing === 1 ? 'was' : 'were'} skipped` }] : []),
    ...(out ? [{
      label: 'Left out',
      value: (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {plural(out, ocf ? 'item' : 'row')}
          <button type="button" className="inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700"
            onClick={() => download(ocf ? 'left-out-items.csv' : 'left-out-rows.csv', ocf ? ocfLeftOutCsv(result, why) : leftOutCsv(result, tabs, why))}>
            <Icon name="download" className="size-3.5" />Download them (.csv)
          </button>
        </span>
      ),
    }] : []),
  ];

  const worth = [
    ...(result.creates.shareClasses.length ? [{
      what: result.creates.shareClasses.join(', '),
      why: ocf ? 'created with the package\'s terms; check them'
        : result.creates.shareClasses.length === 1
          ? 'its authorized shares were set to the shares issued; check them and its terms'
          : 'their authorized shares were set to the shares issued; check them and their terms',
      to: '/share-classes', link: 'Share classes',
    }] : []),
    ...(result.creates.pools.length ? [{ what: result.creates.pools.join(', '), why: 'check its size against your plan documents', to: '/plans', link: 'Plans & vesting' }] : []),
    // Only people whose relationship was a guess nobody answered: the file's, or the person's, choice needs no second look.
    ...(guessed ? [{ what: plural(guessed, 'new stakeholder'), why: guessed === 1 ? 'the relationship is a guess; check it' : 'their relationships are guesses; check them', to: '/stakeholders', link: 'Stakeholders' }] : []),
  ];

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-secondary-50 text-secondary-800"><Icon name="check" className="size-5" /></span>
        <div className="min-w-0">
          <h1 ref={heading} tabIndex={-1} className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900 outline-none">Import complete</h1>
          <p className="mt-0.5 break-words text-sm text-ink-500">{files.join(' + ')} · just now</p>
        </div>
      </div>

      <Card className="mt-6">
        <dl className="divide-y divide-ink-100">
          {lines.map((l) => (
            <div key={l.label} className="grid gap-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt className="text-[13px] font-medium text-ink-500">{l.label}</dt>
              <dd className="text-[14px] text-ink-900">{l.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {worth.length > 0 && (
        <section className="mt-6" aria-labelledby="worth-a-look">
          <h2 id="worth-a-look" className="text-[15px] font-semibold text-ink-900">Worth a look</h2>
          <ul className="mt-2 divide-y divide-ink-100 rounded-xl border border-ink-200/70 bg-white">
            {worth.map((w) => (
              <li key={w.to} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 text-[13px] text-ink-700"><span className="font-medium text-ink-900">{w.what}</span>: {w.why}</span>
                <Button size="sm" className="shrink-0" onClick={() => navigate(w.to)}>{w.link}</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button variant="primary" className="max-sm:w-full" icon={<Icon name="table" />} onClick={() => navigate(back.to)}>{back.label}</Button>
        <Button className="max-sm:w-full" icon={<Icon name="inbox" />} onClick={onMore}>Import more files</Button>
      </div>
    </div>
  );
}

