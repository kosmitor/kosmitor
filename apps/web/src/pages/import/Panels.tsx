import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { Button, Checkbox, Field, Input, Select, cx } from '../../ui.tsx';
import { Drawer } from './Drawer.tsx';
import {
  KIND_WORDS, KINDS, cellText, dataRowsOf, isKind, isMapped, withConstants, widthOf,
  type Cell, type DateOrder, type ImportFile, type Kind, type MappingValue, type NumberFormat, type ReadAs, type Schema, type Settings, type Tab,
} from './model.ts';

const NONE = '__none__';
const FIXED = '__fixed__';
const LEAVE_OUT = '__leave__';

/** Up to three different values a column holds, for the person to recognise it by. */
function samplesOf(rows: Cell[][], source: MappingValue): string {
  if (source == null) return '';
  if (typeof source !== 'number') return source.value ? `“${source.value}” on every row` : '';
  const seen: string[] = [];
  for (const r of rows) {
    const v = cellText(r[source]).trim();
    if (v && !seen.includes(v)) seen.push(v);
    if (seen.length === 3) break;
  }
  return seen.join(' · ');
}

/**
 * Columns · <tab>: what the tab holds, its header row, and which column feeds
 * each field. Fields that are imported come first, then the file's columns that
 * are not, then the fields nothing fills, behind a disclosure. Nothing changes
 * until Done, which closes the panel and checks the import again.
 */
export function ColumnsPanel({ tab, schema, companyId, onClose, onApply }: {
  tab: Tab | null; schema: Schema; companyId: string; onClose: () => void;
  onApply: (key: string, patch: Pick<Tab, 'kind' | 'headerRow' | 'mapping' | 'leftOut'>) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<Record<string, MappingValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest guess counts: choosing another kind quickly never gets the earlier kind's columns.
  const guesses = useRef(0);

  useEffect(() => {
    guesses.current++;
    setBusy(false);
    if (!tab) return;
    setKind(tab.leftOut ? null : tab.kind);
    setHeaderRow(tab.headerRow);
    setMapping(tab.mapping);
    setError(null);
  }, [tab]);

  const headers = useMemo(() => (tab ? (tab.rows[headerRow] ?? []) : []), [tab, headerRow]);
  const rows = useMemo(() => (tab ? dataRowsOf({ ...tab, headerRow }) : []), [tab, headerRow]);
  const fields = schema.kinds.find((k) => k.key === kind)?.fields ?? [];
  const width = tab ? widthOf(tab) : 0;

  /** The column guesses for the tab read as `k`, with `row` as its header. */
  const guess = async (k: Kind, row: number) => {
    if (!tab) return;
    const id = ++guesses.current;
    setBusy(true);
    setError(null);
    try {
      const s = await api<{ mapping: Record<string, number | null>; constants: Record<string, string> }>(`/c/${companyId}/imports/suggest`,
        { body: { kind: k, headers: tab.rows[row] ?? [], sheetName: tab.name }, quiet: true });
      if (id === guesses.current) setMapping(withConstants(s));
    } catch (err) { if (id === guesses.current) setError((err as Error).message); } finally { if (id === guesses.current) setBusy(false); }
  };

  if (!tab) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;

  const used = new Set(Object.values(mapping).filter((m): m is number => typeof m === 'number'));
  const imported = fields.filter((f) => isMapped(mapping[f.key]) || (mapping[f.key] != null && typeof mapping[f.key] !== 'number'));
  const unused = fields.filter((f) => !imported.includes(f));
  // The file's columns, then the ones this import added (an email to tell two people apart, a field a row edit filled in).
  const columns = [
    ...headers.map((h, i) => ({ i, name: cellText(h).trim() || `Column ${i + 1}` })).filter((c) => c.i < width),
    ...tab.added.map((a, j) => ({ i: width + j, name: `${a.header} (added in this import)` })),
  ];
  const sample = (source: MappingValue) => (typeof source === 'number' && source >= width ? 'What you entered in this import' : samplesOf(rows, source) || 'Empty');
  const notImported = columns.filter((c) => !used.has(c.i));

  const setField = (key: string, choice: string) => setMapping((m) => ({
    ...m, [key]: choice === NONE ? null : choice === FIXED ? { value: '' } : Number(choice),
  }));
  /** A column of the file given to a field: whichever field had it before lets it go. */
  const setColumn = (col: number, field: string) => setMapping((m) => {
    const next: Record<string, MappingValue> = {};
    for (const [k, v] of Object.entries(m)) next[k] = v === col ? null : v;
    if (field !== NONE) next[field] = col;
    return next;
  });

  const fieldRow = (f: { key: string; label: string; required: boolean }, extra?: string) => {
    const source = mapping[f.key] ?? null;
    const fixed = source != null && typeof source !== 'number';
    const missing = f.required && !isMapped(source);
    return (
      <div key={f.key} className="grid gap-1.5 py-2.5 sm:grid-cols-[8.5rem_1fr] sm:items-start sm:gap-3">
        <span className="pt-2 text-[13px] font-medium text-ink-800">{f.label}{f.required && <span className="text-red-500"> *</span>}</span>
        <div className="min-w-0">
          <Select aria-label={f.label} value={source == null ? NONE : fixed ? FIXED : String(source)}
            className={cx(missing && 'border-red-300')} onChange={(e) => setField(f.key, e.target.value)}>
            <option value={NONE}>{extra ?? "Don't import"}</option>
            {columns.map((c) => <option key={c.i} value={c.i}>{c.name}</option>)}
            <option value={FIXED}>Same for every row…</option>
          </Select>
          {fixed && (
            <Input className="mt-1.5" aria-label={`${f.label} for every row`} value={source.value} placeholder={`${f.label} for every row`}
              onChange={(e) => setMapping((m) => ({ ...m, [f.key]: { value: e.target.value } }))} />
          )}
          {!fixed && source != null && <p className="mt-1 truncate text-[12px] text-ink-500">{sample(source)}</p>}
        </div>
      </div>
    );
  };

  const missingNow = fields.filter((f) => f.required && !isMapped(mapping[f.key]));
  return (
    <Drawer open={!!tab} onClose={onClose} title={`Columns · ${tab.name}`}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || (!!kind && missingNow.length > 0)}
          onClick={() => onApply(tab.key, { kind, headerRow, mapping, leftOut: kind == null })}>Done</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="This tab holds">
          <Select value={kind ?? LEAVE_OUT} onChange={(e) => {
            const next = isKind(e.target.value) ? e.target.value : null;
            setKind(next);
            if (next) void guess(next, headerRow);
          }}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_WORDS[k].title}</option>)}
            <option value={LEAVE_OUT}>Leave it out</option>
          </Select>
        </Field>
        <Field label="Header row">
          <Select value={String(headerRow)} onChange={(e) => { const r = Number(e.target.value); setHeaderRow(r); if (kind) void guess(kind, r); }}>
            {tab.rows.slice(0, 10).map((_, i) => <option key={i} value={i}>Row {i + 1}</option>)}
          </Select>
        </Field>
      </div>
      {error && <p role="alert" className="mt-3 text-[13px] text-red-700">{error}</p>}
      {!kind ? (
        <p className="mt-5 text-[13px] text-ink-500">This tab is not imported{tab.reason ? ` (${tab.reason.replace(/\.$/, '').toLowerCase()})` : ''}. Choose what it holds to bring it in.</p>
      ) : (
        <div className={cx('mt-4 transition-opacity', busy && 'opacity-60')} aria-busy={busy || undefined}>
          {missingNow.length > 0 && (
            <p className="mb-2 text-[13px] text-red-700">Choose a column for {missingNow.map((f) => f.label.toLowerCase()).join(', ')}.</p>
          )}
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">Imported</h3>
          <div className="divide-y divide-ink-100">{imported.concat(unused.filter((f) => f.required)).map((f) => fieldRow(f))}</div>
          {notImported.length > 0 && (
            <>
              <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-ink-500">Not imported from your file</h3>
              <div className="divide-y divide-ink-100">
                {notImported.map((c) => (
                  <div key={c.i} className="grid gap-1.5 py-2.5 sm:grid-cols-[8.5rem_1fr] sm:items-start sm:gap-3">
                    <span className="truncate pt-2 text-[13px] font-medium text-ink-800" title={c.name}>{c.name}</span>
                    <div className="min-w-0">
                      <Select aria-label={`Import ${c.name} as`} value={NONE} onChange={(e) => setColumn(c.i, e.target.value)}>
                        <option value={NONE}>Don't import</option>
                        {unused.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </Select>
                      <p className="mt-1 truncate text-[12px] text-ink-500">{sample(c.i)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {unused.filter((f) => !f.required).length > 0 && (
            <details className="group mt-5">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-ink-600 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
                More fields you can fill ({unused.filter((f) => !f.required).length})
                <svg viewBox="0 0 24 24" className="size-3.5 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="m7 10 5 5 5-5" /></svg>
              </summary>
              <div className="mt-1 divide-y divide-ink-100">{unused.filter((f) => !f.required).map((f) => fieldRow(f, 'Nothing'))}</div>
            </details>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** How a date or number reading was decided, in a sentence. */
function dateEvidence(r: ReadAs | undefined, chosen: boolean): string {
  if (chosen) return 'You chose this.';
  if (!r) return '';
  if (r.dateOrder === 'mixed') return 'This file writes dates both ways. Choose how to read the ones like 03/04/2024.';
  if (r.dateDecidedBy === 'file' && r.dateEvidence) {
    return `We read ${r.dateOrder === 'DMY' ? 'day' : 'month'} first because ${r.dateEvidence.sheet && r.sheets.length > 1 ? `“${r.dateEvidence.sheet}” ` : ''}row ${r.dateEvidence.row} has ${r.dateEvidence.text}.`;
  }
  return 'Nothing in the file says otherwise.';
}

function numberEvidence(t: Tab | undefined, chosen: boolean): string {
  if (chosen) return 'You chose this.';
  if (!t) return '';
  if (t.numberDecidedBy === 'file' && t.numberEvidence) return `We read it this way because row ${t.numberEvidence.row} has ${t.numberEvidence.text}.`;
  if (t.numberDecidedBy === 'delimiter') return 'The file is separated by semicolons, as European files are.';
  return 'Nothing in the file says otherwise.';
}

function Radio<T extends string>({ name, value, options, onChange, label }: {
  name: string; value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-x-5 gap-y-1.5">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-800">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)}
            className="size-4 accent-brand-600" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const NEW_PLAN = '__new__';

/**
 * Import settings: everything the import otherwise decides on its own. How each
 * file writes dates and numbers (with what in the file decided it), whether new
 * stakeholders and share classes may be added, and the defaults for grants and
 * certificates that name no vesting schedule or plan. Applied on Done.
 */
export function SettingsPanel({ open, onClose, files, tabs, readAs, settings, schedules, pools, onApply }: {
  open: boolean; onClose: () => void; files: ImportFile[]; tabs: Tab[]; readAs: ReadAs[];
  settings: Settings; schedules: { id: string; name: string }[]; pools: { id: string; name: string }[];
  onApply: (files: { id: string; dateOrder?: DateOrder; numberFormat?: NumberFormat }[], settings: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [reading, setReading] = useState<Record<string, { dateOrder?: DateOrder; numberFormat?: NumberFormat }>>({});
  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setReading(Object.fromEntries(files.map((f) => [f.id, { dateOrder: f.dateOrder, numberFormat: f.numberFormat }])));
  }, [open, settings, files]);

  const imported = tabs.filter((t) => t.kind && !t.leftOut);
  const has = (k: Kind) => imported.some((t) => t.kind === k);
  const inUse = files.filter((f) => imported.some((t) => t.fileId === f.id));
  const onlyPlan = pools.length === 1 ? pools[0] : null;
  const planChoice = draft.defaultPoolId || (draft.defaultPoolName ? NEW_PLAN : '');
  // Done with nothing changed only closes: no second check, and nothing for Back to warn about.
  const changed = (Object.keys(draft) as (keyof Settings)[]).some((k) => draft[k] !== settings[k])
    || files.some((f) => reading[f.id] && (reading[f.id].dateOrder !== f.dateOrder || reading[f.id].numberFormat !== f.numberFormat));

  return (
    <Drawer open={open} onClose={onClose} title="Import settings"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => (changed ? onApply(Object.entries(reading).map(([id, r]) => ({ id, ...r })), draft) : onClose())}>Done</Button>
      </>}>
      <div className="space-y-6">
        {inUse.map((f) => {
          const r = readAs.find((x) => x.file === f.name);
          const first = imported.find((t) => t.fileId === f.id);
          const mine = reading[f.id] ?? {};
          const dates = mine.dateOrder ?? (r && r.dateOrder !== 'mixed' ? r.dateOrder : undefined);
          const numbers = mine.numberFormat ?? first?.numberFormat;
          return (
            <section key={f.id} className="space-y-4">
              {inUse.length > 1 && <h3 className="truncate text-[13px] font-semibold text-ink-900" title={f.name}>{f.name}</h3>}
              {(r?.textDates ?? 0) > 0 || mine.dateOrder ? (
                <div>
                  <p className="mb-1.5 text-[13px] font-medium text-ink-700">Dates like 03/04/2024</p>
                  <Radio name={`dates-${f.id}`} label="Dates like 03/04/2024" value={dates}
                    options={[{ value: 'MDY', label: 'Month first' }, { value: 'DMY', label: 'Day first' }]}
                    onChange={(v) => setReading((x) => ({ ...x, [f.id]: { ...x[f.id], dateOrder: v } }))} />
                  <p className="mt-1 text-[12px] text-ink-500">{dateEvidence(r, !!f.dateOrder)}</p>
                </div>
              ) : (
                <p className="text-[13px] text-ink-500">Dates: every date in this file reads only one way.</p>
              )}
              <div>
                <p className="mb-1.5 text-[13px] font-medium text-ink-700">Numbers</p>
                <Radio name={`numbers-${f.id}`} label="Numbers" value={numbers}
                  options={[{ value: 'en', label: '1,234.56' }, { value: 'eu', label: '1.234,56' }]}
                  onChange={(v) => setReading((x) => ({ ...x, [f.id]: { ...x[f.id], numberFormat: v } }))} />
                <p className="mt-1 text-[12px] text-ink-500">{numberEvidence(first, !!f.numberFormat)}</p>
              </div>
            </section>
          );
        })}

        <section className="space-y-3 border-t border-ink-100 pt-5">
          <Checkbox label="Add stakeholders who aren't in the company yet" checked={draft.createMissingStakeholders}
            onChange={(v) => setDraft({ ...draft, createMissingStakeholders: v })} />
          {has('captable') && (
            <Checkbox label="Add share classes that don't exist yet" hint="Names with “preferred” or “series” become preferred stock."
              checked={draft.createMissingShareClasses} onChange={(v) => setDraft({ ...draft, createMissingShareClasses: v })} />
          )}
        </section>

        {(has('grants') || has('captable')) && (
          <section className="space-y-4 border-t border-ink-100 pt-5">
            {has('grants') && (
              <Field label="Grants with no vesting schedule">
                <Select value={draft.defaultVestingScheduleId} onChange={(e) => setDraft({ ...draft, defaultVestingScheduleId: e.target.value })}>
                  <option value="">Ask me</option>
                  {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            )}
            {has('captable') && (
              <Field label="Certificates with no vesting schedule">
                <Select value={draft.certificateVestingScheduleId} onChange={(e) => setDraft({ ...draft, certificateVestingScheduleId: e.target.value })}>
                  <option value="">Fully vested</option>
                  {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            )}
            {has('grants') && (
              <Field label="Grants with no plan">
                <Select value={planChoice} onChange={(e) => setDraft({
                  ...draft, defaultPoolId: e.target.value === NEW_PLAN ? '' : e.target.value,
                  defaultPoolName: e.target.value === NEW_PLAN ? draft.defaultPoolName || 'Stock Plan' : '',
                })}>
                  <option value="">{onlyPlan ? `${onlyPlan.name} (only plan)` : 'Ask me'}</option>
                  {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  <option value={NEW_PLAN}>New plan named…</option>
                </Select>
                {planChoice === NEW_PLAN && (
                  <Input className="mt-1.5" aria-label="New plan name" value={draft.defaultPoolName}
                    onChange={(e) => setDraft({ ...draft, defaultPoolName: e.target.value })} />
                )}
              </Field>
            )}
          </section>
        )}
      </div>
    </Drawer>
  );
}
