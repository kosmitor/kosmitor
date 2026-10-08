import { useState, type ReactNode } from 'react';
import { Button, Input, Select, cx } from '../../ui.tsx';
import { shares } from '../../format.ts';
import {
  KIND_WORDS, KINDS, cellText, headersOf, plural, replacementsFor, widthOf,
  type Kind, type NumberFormat, type Question, type Schema, type Tab,
} from './model.ts';

export interface FixHandlers {
  setKind: (tab: string, kind: Kind | null) => void;
  setColumn: (tab: string, field: string, source: number | { value: string }) => void;
  setPlan: (choice: { poolId: string } | { name: string }) => void;
  setVesting: (scheduleId: string) => void;
  replaceValue: (q: Extract<Question, { type: 'value' }>, to: string) => void;
  turnOn: (option: 'createMissingStakeholders' | 'createMissingShareClasses') => void;
  setEmail: (rows: { tab: string; row: number }[], email: string) => void;
  setDateOrder: (fileId: string, order: 'MDY' | 'DMY') => void;
  setNumberFormat: (fileId: string, format: NumberFormat) => void;
  raise: (fix: { value: string; className: string }) => void;
  dismiss: (id: string) => void;
}

/** A tab's name as the person knows it: the file for a CSV, the tab for a workbook. */
export const tabName = (t: Tab, single: boolean): string => (single ? t.file : `“${t.name}”`);

function FixCard({ title, children, tone = 'question' }: { title: ReactNode; children: ReactNode; tone?: 'question' | 'notice' }) {
  return (
    <div className={cx('rounded-xl border bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04)]',
      tone === 'notice' ? 'border-amber-200 bg-amber-50/40' : 'border-ink-200/70')}>
      <p className="text-[14px] font-medium text-ink-900">{title}</p>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

/** Controls that sit in a row on a wide screen and stack, full width, on a phone. */
const Controls = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center [&>*]:max-sm:w-full">{children}</div>
);

/**
 * One card per cause, not per row: each holds the control that fixes every row
 * it names at once. Answering checks the import again.
 */
export function QuestionCard({ q, tabs, singles, schema, schedules, pools, on }: {
  q: Question; tabs: Tab[]; singles: Set<string>; schema: Schema;
  schedules: { id: string; name: string }[]; pools: { id: string; name: string }[]; on: FixHandlers;
}) {
  const tab = 'tab' in q ? tabs.find((t) => t.key === q.tab) : undefined;
  switch (q.type) {
    case 'kind': {
      if (!tab) return null;
      const heads = headersOf(tab).map((h) => cellText(h).trim()).filter(Boolean);
      return (
        <FixCard title={`What's in ${tabName(tab, singles.has(tab.fileId))}?`}>
          <p className="mb-3 text-[13px] text-ink-600">
            We couldn't tell from its columns{heads.length ? `: ${heads.slice(0, 6).join(', ')}${heads.length > 6 ? '…' : ''}` : ''}.
          </p>
          <Controls>
            {KINDS.map((k) => <Button key={k} size="sm" onClick={() => on.setKind(tab.key, k)}>{KIND_WORDS[k].title}</Button>)}
            <Button size="sm" variant="ghost" onClick={() => on.setKind(tab.key, null)}>Leave it out</Button>
          </Controls>
        </FixCard>
      );
    }
    case 'column': {
      if (!tab) return null;
      const field = schema.kinds.find((k) => k.key === tab.kind)?.fields.find((f) => f.key === q.field);
      return field ? <ColumnCard tab={tab} single={singles.has(tab.fileId)} field={field} on={on} /> : null;
    }
    case 'plan':
      return <PlanCard count={q.rows.length} pools={pools} on={on} />;
    case 'vesting':
      return <VestingCard count={q.rows.length} schedules={schedules} on={on} />;
    case 'value':
      return <ValueCard q={q} schema={schema} schedules={schedules} on={on} />;
    case 'create':
      return (
        <FixCard title={q.option === 'createMissingShareClasses'
          ? `${plural(q.rows.length, 'row names a share class', 'rows name share classes')} the company doesn't have, and adding share classes is turned off.`
          : `${plural(q.rows.length, 'row names someone who isn’t', 'rows name people who aren’t')} in the company, and adding stakeholders is turned off.`}>
          <Button size="sm" onClick={() => on.turnOn(q.option)}>
            {q.option === 'createMissingShareClasses' ? 'Turn on adding share classes' : 'Turn on adding stakeholders'}
          </Button>
        </FixCard>
      );
    case 'person':
      return (
        <FixCard title={`Which “${q.name}”?`}>
          <p className="mb-3 text-[13px] text-ink-600">
            {plural(q.rows.length, 'row gives', 'rows give')} no email, and {q.choices.length} people have this name. Choose the one {q.rows.length === 1 ? 'it means' : 'they mean'}.
          </p>
          <Controls>{q.choices.map((email) => <Button key={email} size="sm" onClick={() => on.setEmail(q.rows, email)}>{email}</Button>)}</Controls>
        </FixCard>
      );
    case 'date':
      return (
        <FixCard tone="notice" title={`Some dates in ${q.file} read two ways${q.example ? `, like ${q.example}` : ''}.`}>
          <p className="mb-3 text-[13px] text-ink-600">How does this file write its dates?</p>
          <Controls>
            <Button size="sm" onClick={() => on.setDateOrder(q.fileId, 'MDY')}>Month first</Button>
            <Button size="sm" onClick={() => on.setDateOrder(q.fileId, 'DMY')}>Day first</Button>
          </Controls>
        </FixCard>
      );
    case 'number': {
      const other: NumberFormat = q.format === 'en' ? 'eu' : 'en';
      return (
        <FixCard tone="notice" title={`${q.text.replace(/\.$/, '')}${q.rows.length > 1 ? ` (${plural(q.rows.length, 'row')})` : ''}.`}>
          <Controls>
            <Button size="sm" onClick={() => on.setNumberFormat(q.fileId, other)}>Read numbers as {other === 'eu' ? '1.234,56' : '1,234.56'}</Button>
            <Button size="sm" variant="ghost" onClick={() => on.dismiss(q.id)}>Keep as read</Button>
          </Controls>
        </FixCard>
      );
    }
    case 'dropped': {
      if (!tab) return null;
      const cols = q.columns.length > 1 ? `${q.columns.slice(0, -1).join(', ')} and ${q.columns.at(-1)}` : q.columns[0];
      return (
        <FixCard tone="notice" title={`${cols} ${q.columns.length > 1 ? "aren't" : "isn't"} imported, because ${tabName(tab, singles.has(tab.fileId))} is read as a stakeholder list.`}>
          <Controls>
            <Button size="sm" onClick={() => on.setKind(tab.key, 'captable')}>Read it as certificates</Button>
            <Button size="sm" variant="ghost" onClick={() => on.dismiss(q.id)}>Leave it</Button>
          </Controls>
        </FixCard>
      );
    }
    case 'notice': {
      const fix = q.notice.fix;
      return (
        <FixCard tone="notice" title={`${q.notice.text.replace(/\.$/, '')}.`}>
          <Controls>
            {fix && <Button size="sm" onClick={() => on.raise(fix)}>Raise to {shares(fix.to)}</Button>}
            <Button size="sm" variant="ghost" onClick={() => on.dismiss(q.id)}>{fix ? 'Leave it' : 'Got it'}</Button>
          </Controls>
        </FixCard>
      );
    }
  }
}

function ColumnCard({ tab, single, field, on }: { tab: Tab; single: boolean; field: { key: string; label: string }; on: FixHandlers }) {
  const [column, setColumn] = useState('');
  const [fixed, setFixed] = useState('');
  const width = widthOf(tab);
  const heads = headersOf(tab).map((h, i) => ({ i, name: cellText(h).trim() || `Column ${i + 1}` })).filter((c) => c.i < width);
  const name = field.label.toLowerCase();
  return (
    <FixCard title={`Which column has the ${name}?`}>
      <p className="mb-3 text-[13px] text-ink-600">{single ? tab.file : `The ${tabName(tab, false)} tab`} needs one for every row.</p>
      <Controls>
        <div className="sm:w-56">
          <Select aria-label={`Column with the ${name}`} value={column} placeholder="Choose a column"
            onChange={(e) => { setColumn(e.target.value); if (e.target.value) on.setColumn(tab.key, field.key, Number(e.target.value)); }}>
            {heads.map((c) => <option key={c.i} value={String(c.i)}>{c.name}</option>)}
          </Select>
        </div>
        <span className="text-[13px] text-ink-500">or the same for every row</span>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (fixed.trim()) on.setColumn(tab.key, field.key, { value: fixed.trim() }); }}>
          <Input aria-label={`${field.label} for every row`} value={fixed} onChange={(e) => setFixed(e.target.value)}
            placeholder={field.key === 'shareClassName' ? 'Common' : field.label} className="min-w-0 sm:w-40" />
          <Button type="submit" size="md" disabled={!fixed.trim()}>Apply</Button>
        </form>
      </Controls>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[13px] text-ink-500">
        {tab.kind && (
          <>
            <span>Not {KIND_WORDS[tab.kind].many}? Read it as</span>
            {KINDS.filter((k) => k !== tab.kind).map((k, i, all) => (
              <span key={k}>
                <button type="button" className="font-medium text-brand-600 hover:text-brand-700" onClick={() => on.setKind(tab.key, k)}>
                  {KIND_WORDS[k].many}
                </button>{i < all.length - 1 ? ',' : ''}
              </span>
            ))}
            <span aria-hidden>·</span>
          </>
        )}
        <button type="button" className="font-medium text-ink-500 hover:text-ink-800" onClick={() => on.setKind(tab.key, null)}>
          Leave this {single ? 'file' : 'tab'} out
        </button>
      </p>
    </FixCard>
  );
}

const NEW_PLAN = '__new__';

function PlanCard({ count, pools, on }: { count: number; pools: { id: string; name: string }[]; on: FixHandlers }) {
  const [choice, setChoice] = useState(pools[0]?.id ?? NEW_PLAN);
  const [name, setName] = useState('Stock Plan');
  const ready = choice !== NEW_PLAN || name.trim() !== '';
  return (
    <FixCard title={`Which equity plan ${count === 1 ? 'is this grant' : `are these ${count} grants`} from?`}>
      <form onSubmit={(e) => { e.preventDefault(); if (ready) on.setPlan(choice === NEW_PLAN ? { name: name.trim() } : { poolId: choice }); }}>
        <Controls>
          <div className="sm:w-60">
            <Select aria-label="Equity plan" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value={NEW_PLAN}>New plan named…</option>
            </Select>
          </div>
          {choice === NEW_PLAN && (
            <Input aria-label="New plan name" value={name} onChange={(e) => setName(e.target.value)} className="sm:w-52" />
          )}
          <Button type="submit" variant="primary" disabled={!ready}>Apply to {plural(count, 'grant')}</Button>
        </Controls>
      </form>
    </FixCard>
  );
}

function VestingCard({ count, schedules, on }: { count: number; schedules: { id: string; name: string }[]; on: FixHandlers }) {
  const [choice, setChoice] = useState('');
  return (
    <FixCard title={`${count === 1 ? 'A grant has' : `${count} grants have`} no vesting schedule.`}>
      <Controls>
        <div className="sm:w-72">
          <Select aria-label="Vesting schedule" value={choice} placeholder="Choose a schedule" onChange={(e) => setChoice(e.target.value)}>
            {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <Button variant="primary" disabled={!choice} onClick={() => on.setVesting(choice)}>Apply to {plural(count, 'grant')}</Button>
      </Controls>
    </FixCard>
  );
}

function ValueCard({ q, schema, schedules, on }: {
  q: Extract<Question, { type: 'value' }>; schema: Schema; schedules: { id: string; name: string }[]; on: FixHandlers;
}) {
  const options = replacementsFor(q.field, schedules);
  const [to, setTo] = useState('');
  const label = schema.kinds.flatMap((k) => k.fields).find((f) => f.key === q.field)?.label ?? 'Value';
  if (q.code === 'ambiguous-award-type') {
    return (
      <FixCard title={`“${q.value}” could be an ISO or an NSO (${plural(q.rows.length, 'grant')}).`}>
        <Controls>
          <Button size="sm" onClick={() => on.replaceValue(q, 'ISO')}>ISO</Button>
          <Button size="sm" onClick={() => on.replaceValue(q, 'NSO')}>NSO</Button>
        </Controls>
      </FixCard>
    );
  }
  return (
    <FixCard title={`${label} “${q.value}” isn't one we recognise (${plural(q.rows.length, 'row')}).`}>
      {options.length === 0 ? (
        <p className="text-[13px] text-ink-600">Edit the rows below, or leave them out.</p>
      ) : (
        <Controls>
          <div className="sm:w-60">
            <Select aria-label={`Treat “${q.value}” as`} value={to} placeholder="Treat it as…" onChange={(e) => setTo(e.target.value)}>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </div>
          <Button variant="primary" disabled={!to} onClick={() => on.replaceValue(q, to)}>Apply to {plural(q.rows.length, 'row')}</Button>
        </Controls>
      )}
    </FixCard>
  );
}
