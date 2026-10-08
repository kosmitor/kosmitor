import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionMenu, Banner, Button, Card, ErrorNote, Select, Spinner, cx } from '../../ui.tsx';
import { Icon } from '../../icons.tsx';
import { RELATION_LABELS } from '../../format.ts';
import { IMPORT_ACCEPT } from '../../importHandoff.ts';
import type { FileProblem } from '../../ImportDropZone.tsx';
import { QuestionCard, type FixHandlers } from './FixCards.tsx';
import { TabSection } from './TabSection.tsx';
import {
  BACK_TO, BLOCKING, FILLED_IN, KINDS, cardAnswers, lowerFirst, needsOwnFix, plural, readyWhenFixed, rowsFor, tabOf,
  type Answers, type Edits, type ImportFile, type Kind, type NewPerson, type Question, type Review, type RowMessage, type RowRef, type Schema, type Tab,
} from './model.ts';

/** A row left out, and why: its problems as they read when it was left out. */
export interface LeftOutRow extends RowRef { why: string }

export interface CheckHandlers extends FixHandlers {
  openColumns: (tab: string) => void;
  openSettings: () => void;
  addFiles: (files: File[]) => void;
  chooseDifferent: () => void;
  commit: () => void;
  recheck: () => void;
  /** "Leave out N rows": the rows with an error of their own, for this import. */
  leaveOutRows: (rows: LeftOutRow[]) => void;
  /** "Fix them instead": puts back the rows the bar left out. */
  putBackLeftOut: () => void;
  saveRow: (tab: string, row: number, values: Record<string, string>) => void;
  leaveOutRow: (row: LeftOutRow) => void;
  putBackRow: (tab: string, row: number) => void;
  setRelationship: (key: string, relation: string) => void;
  samePerson: (keep: NewPerson, others: NewPerson[]) => void;
  unraise: (value: string) => void;
  savePdf: (file: File) => void;
  dismissProblems: () => void;
}

export interface CheckProps {
  schema: Schema;
  files: ImportFile[];
  tabs: Tab[];
  edits: Edits;
  answers: Answers;
  /** Notices and namesakes the person left as they are. */
  dismissed: string[];
  review: Review | null;
  checking: boolean;
  checkError: string | null;
  commitError: string | null;
  /** The import was refused because the company changed since the check (or the rows did): the page checked again. */
  stale: boolean;
  committing: boolean;
  /** How many rows "Leave out N rows" left out and are still out: "Fix them instead" puts them back. */
  leftOutByBar: number;
  /** The page the import started from (?kind=): where "Open …" leads when there is nothing new. */
  kind: Kind | null;
  questions: Question[];
  askedPeople: string[];
  reading: string | null;
  problems: FileProblem[];
  pdfs: File[];
  schedules: { id: string; name: string }[];
  pools: { id: string; name: string }[];
  /** The assistant's round button sits at the bottom right: the bar keeps clear of it. */
  assistant: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  on: CheckHandlers;
}

/** A row's problems in one line, as they read when it was left out: for the row and the left-out rows' file. */
const problemsOf = (messages: RowMessage[], hasSchedules: boolean): string => {
  const errors = messages.filter((m) => m.level === 'error');
  const own = errors.filter((m) => !cardAnswers(m, hasSchedules));
  return (own.length ? own : errors.length ? errors : messages.filter((m) => m.level === 'warning')).map((m) => m.text.replace(/\.$/, '')).join('; ');
};

/**
 * Check your import: the dry run of everything dropped, every tab in the order
 * it is applied. Questions come first, one card per cause; problems sit under
 * their row; a bar pinned to the bottom always says what will happen and holds
 * Import. Nothing is saved until Import.
 */
export function CheckScreen(p: CheckProps) {
  const { schema, files, tabs, edits, answers, review, checking, questions, on } = p;
  const addInput = useRef<HTMLInputElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  const addsHeading = useRef<HTMLHeadingElement>(null);
  const [only, setOnly] = useState<string | null>(null);
  const addFile = () => addInput.current?.click();
  const hasSchedules = p.schedules.length > 0;

  // A card goes once its answer is in, and the focus it held with it: the next card's first
  // control takes it (the one before, when it was the last), or "What this adds" when none is
  // left. Focus someone moved is left alone.
  const answered = useRef<{ id: string; index: number } | null>(null);
  const answering = (q: Question, index: number): CheckHandlers => Object.fromEntries(Object.entries(on).map(([k, fn]) => [k,
    (...args: unknown[]) => { answered.current = { id: q.id, index }; return (fn as (...a: unknown[]) => unknown)(...args); }])) as unknown as CheckHandlers;
  useEffect(() => {
    const a = answered.current;
    if (!a) return;
    const still = questions.some((q) => q.id === a.id);
    if (still && checking) return;
    answered.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const left = cards.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [];
    const next = left[Math.min(a.index, left.length - 1)];
    const control = next?.querySelector<HTMLElement>('button:not([disabled]), input, select, [tabindex="0"]');
    (control ?? addsHeading.current ?? p.heading.current)?.focus();
  }, [questions, checking, p.heading]);

  const singles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tabs) counts.set(t.fileId, (counts.get(t.fileId) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n === 1).map(([id]) => id));
  }, [tabs]);

  // The tabs in the order they are applied: people, certificates, grants, SAFEs; then the file's order.
  const shown = tabs.map((t, i) => ({ t, i })).filter(({ t }) => t.kind && !t.leftOut)
    .sort((a, b) => KINDS.indexOf(a.t.kind!) - KINDS.indexOf(b.t.kind!) || a.i - b.i).map(({ t }) => t);
  const leftOut = tabs.filter((t) => t.leftOut && !t.ask);
  const waitingTabs = new Set(questions.filter((q) => q.type === 'column').map((q) => (q as { tab: string }).tab));

  const blocking = questions.filter((q) => BLOCKING.has(q.type));
  // Rows with an error of their own, which "Leave out N rows" leaves out: not the rows that wait for a card's answer.
  const toFix: LeftOutRow[] = [];
  for (const s of review?.sheets ?? []) {
    const t = tabOf(tabs, s);
    if (t) for (const r of s.preview.rows) if (needsOwnFix(r, hasSchedules)) toFix.push({ tab: t.key, row: r.row, why: problemsOf(r.messages, hasSchedules) });
  }
  const counts = review?.counts;
  const pending = review ? review.sheets.reduce((n, s) => n + readyWhenFixed(s), 0) : 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 ref={p.heading} tabIndex={-1} className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900 outline-none">Check your import</h1>
          <p className="mt-1 text-sm text-ink-500">Nothing is saved until you press Import.</p>
        </div>
        <div className="flex items-center gap-2">
          {p.reading && tabs.length > 0 && <span className="flex items-center gap-2 text-[13px] text-ink-500"><Spinner className="size-4" />{p.reading}</span>}
          <div className="hidden items-center gap-2 sm:flex">
            <Button icon={<Icon name="plus" />} onClick={addFile} disabled={!!p.reading}>Add a file</Button>
            <Button onClick={on.chooseDifferent}>Choose different files</Button>
          </div>
          <div className="sm:hidden">
            <ActionMenu label="Files" items={[
              { label: 'Add a file', icon: 'plus', onClick: addFile, disabled: !!p.reading },
              { label: 'Choose different files', icon: 'inbox', onClick: on.chooseDifferent },
            ]} />
          </div>
          <input ref={addInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden accept={IMPORT_ACCEPT}
            onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (list.length) on.addFiles(list); }} />
        </div>
      </div>

      {tabs.some((t) => t.kind && !t.leftOut) && <ReadingNote files={files} tabs={tabs} review={review} onSettings={on.openSettings} />}

      <div className="space-y-5">
        {p.checkError && <ErrorNote error={p.checkError} onRetry={on.recheck} />}
        {p.commitError && <div role="alert"><ErrorNote error={p.commitError} /></div>}
        {p.stale && (
          <div role="alert">
            <Banner tone="info" title="The cap table changed since you checked these rows, so nothing was imported.">
              {checking || !review ? 'Checking again…' : 'We checked again against it: look over the rows, then press Import.'}
            </Banner>
          </div>
        )}
        {p.problems.length > 0 && (
          <div role="alert">
            <Banner tone="danger" title={p.problems.length === 1 ? 'A file could not be read' : `${p.problems.length} files could not be read`} onDismiss={on.dismissProblems}>
              <ul className="space-y-0.5">{p.problems.map((x, i) => <li key={i}>{x.message}</li>)}</ul>
            </Banner>
          </div>
        )}
        {p.pdfs.map((f, i) => (
          <div key={`${f.name}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-[13px] text-ink-700">
            <Icon name="document" className="size-4 text-ink-400" />
            <span className="min-w-0 flex-1">{f.name} isn't a spreadsheet.</span>
            <Button size="sm" onClick={() => on.savePdf(f)}>Save it as a document</Button>
          </div>
        ))}

        {tabs.length === 0 && p.reading && (
          <div className="flex items-center justify-center gap-2.5 py-16 text-ink-500" aria-live="polite"><Spinner className="size-5" /><span className="text-sm">{p.reading}</span></div>
        )}

        {questions.length > 0 && (
          <section aria-labelledby="needs-answer" className="space-y-3">
            <h2 id="needs-answer" className="text-[15px] font-semibold text-ink-900">Needs your answer ({questions.length})</h2>
            <div ref={cards} className="space-y-3">
              {questions.map((q, i) => (
                <div key={q.id} data-card>
                  <QuestionCard q={q} tabs={tabs} singles={singles} schema={schema} schedules={p.schedules} pools={p.pools} on={answering(q, i)} />
                </div>
              ))}
            </div>
          </section>
        )}

        {review && <WhatThisAdds review={review} answers={answers} pending={pending} heading={addsHeading} onUndoRaise={on.unraise} />}

        {review && <NewPeople review={review} answers={answers} dismissed={p.dismissed} asked={p.askedPeople} on={on} onAddFile={addFile} />}

        {shown.map((t) => {
          const sheet = review?.sheets.find((s) => tabOf([t], s)) ?? null;
          return (
            <TabSection key={t.key} tab={t} sheet={waitingTabs.has(t.key) ? null : sheet}
              fields={schema.kinds.find((k) => k.key === t.kind)?.fields ?? []}
              waiting={waitingTabs.has(t.key)} busy={checking} hasSchedules={hasSchedules} why={edits.why[t.key] ?? {}}
              currentRows={rowsFor(t, edits)} showFile={files.length > 1} single={singles.has(t.fileId)}
              only={only}
              onColumns={() => on.openColumns(t.key)} onSaveRow={(row, values) => on.saveRow(t.key, row, values)}
              onLeaveOut={(row) => {
                const r = sheet?.preview.rows.find((x) => x.row === row);
                on.leaveOutRow({ tab: t.key, row, why: r ? problemsOf(r.messages, hasSchedules) : '' });
              }}
              onPutBack={(row) => on.putBackRow(t.key, row)} />
          );
        })}

        {leftOut.length > 0 && (
          <p className="text-[13px] text-ink-500">
            Not imported:{' '}
            {leftOut.map((t, i) => (
              <span key={t.key}>
                {i > 0 && ' · '}
                <button type="button" className="font-medium text-ink-700 underline decoration-ink-300 underline-offset-2 hover:text-brand-700"
                  onClick={() => on.openColumns(t.key)}>{singles.has(t.fileId) ? t.file : t.name}</button>
                {' '}({t.chosen ? 'you left it out' : /summary/i.test(t.reason ?? '') ? 'a summary, not a ledger' : lowerFirst((t.reason ?? 'not recognised').replace(/\.$/, ''))})
              </span>
            ))}
            . Choose one to import it.
          </p>
        )}

        {review && <FilledIn review={review} only={only} setOnly={setOnly} />}
      </div>

      {/* Room for the bar, so the last row is never under it. */}
      <div aria-hidden className="h-32 sm:h-20" />
      <BottomBar review={review} checking={checking || !!p.reading} failed={!!p.checkError} committing={p.committing}
        blocking={blocking.length} toFix={toFix} leftOutByBar={p.leftOutByBar} errors={counts?.errors ?? 0} pending={pending}
        nothingReady={tabs.length > 0 && shown.filter((t) => !waitingTabs.has(t.key)).length === 0}
        kind={p.kind} assistant={p.assistant} on={on} />
    </div>
  );
}

/** "cap-table.xlsx · dates read as month/day · Import settings": how each file was read, when it matters. */
function ReadingNote({ files, tabs, review, onSettings }: { files: ImportFile[]; tabs: Tab[]; review: Review | null; onSettings: () => void }) {
  const inUse = files.filter((f) => tabs.some((t) => t.fileId === f.id && t.kind && !t.leftOut));
  const parts = inUse.map((f) => {
    const r = review?.readAs.find((x) => x.file === f.name);
    const dates = f.dateOrder ?? (r && r.textDates > 0 ? r.dateOrder : null);
    const numbers = f.numberFormat ?? tabs.find((t) => t.fileId === f.id)?.numberFormat;
    return [f.name,
      dates === 'MDY' ? 'dates read as month/day' : dates === 'DMY' ? 'dates read as day/month' : dates === 'mixed' ? 'dates written both ways' : '',
      numbers === 'eu' ? 'numbers read as 1.234,56' : ''].filter(Boolean).join(' · ');
  });
  return (
    <p className="mb-5 text-[13px] text-ink-500">
      {parts.join('; ')}{parts.length ? ' · ' : ''}
      <button type="button" className="font-medium text-brand-600 hover:text-brand-700" onClick={onSettings}>Import settings</button>
    </p>
  );
}

/** One sentence of what the import adds, from the dry run's counts. A class raised on the person's word can be undone. */
function WhatThisAdds({ review, answers, pending, heading, onUndoRaise }: {
  review: Review; answers: Answers; pending: number; heading: RefObject<HTMLHeadingElement | null>; onUndoRaise: (value: string) => void;
}) {
  const i = review.imported;
  const c = review.creates;
  const parts = [
    i.issuances ? plural(i.issuances, 'certificate') : '',
    i.awards ? plural(i.awards, 'grant') : '',
    i.convertibles ? plural(i.convertibles, 'SAFE or note', 'SAFEs & notes') : '',
    i.stakeholders ? plural(i.stakeholders, 'new stakeholder') : '',
    i.updated.stakeholders ? plural(i.updated.stakeholders, 'stakeholder updated', 'stakeholders updated') : '',
    i.shareClasses ? `${plural(i.shareClasses, 'new share class', 'new share classes')} (${c.shareClasses.join(', ')})` : '',
    i.pools ? `${plural(i.pools, 'new equity plan')} (${c.pools.join(', ')})` : '',
    i.vestingSchedules ? `${plural(i.vestingSchedules, 'new vesting schedule')} (${c.vestingSchedules.join(', ')})` : '',
  ].filter(Boolean);
  // Each raise with the answer that asked for it, so it can be taken back.
  const raised = review.raised.map((r) => ({
    ...r, value: answers.raiseAuthorized.find((v) => v === r.shareClassId || answers.raisedNames[v]?.toLowerCase() === r.name.toLowerCase()) ?? null,
  }));
  const blocked = review.sheets.some((s) => s.blocked);
  const existing = review.counts.existing;
  return (
    <section aria-labelledby="what-this-adds">
      <h2 ref={heading} tabIndex={-1} id="what-this-adds" className="text-[15px] font-semibold text-ink-900 outline-none">What this adds</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-700">
        {parts.length ? parts.join(' · ')
          : blocked ? (pending ? `Nothing yet: ${plural(pending, 'row is', 'rows are')} ready once the rest is fixed.` : 'Nothing yet.')
          : existing ? `Nothing new: ${plural(existing, 'row is', 'rows are')} already on the cap table.`
          : 'Nothing yet.'}
        {parts.length > 0 && existing > 0 && <span className="text-ink-500"> · {plural(existing, 'row')} already there</span>}
      </p>
      {raised.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[14px] text-ink-700">
          {raised.map((r) => (
            <li key={r.shareClassId}>
              {r.name} raised from {r.from.toLocaleString()} to {r.to.toLocaleString()} authorized shares
              {r.value && (
                <> · <button type="button" className="font-medium text-brand-600 hover:text-brand-700"
                    onClick={() => { onUndoRaise(r.value!); heading.current?.focus(); }}>Undo</button></>
              )}
            </li>
          ))}
        </ul>
      )}
      {blocked && parts.length > 0 && (
        <p className="mt-0.5 text-[13px] text-ink-500">A tab with rows to fix adds nothing until they are fixed or left out.</p>
      )}
    </section>
  );
}

const SHOWN_PEOPLE = 6;

/**
 * The people this import creates without a relationship (the file has no
 * column for it), each with a select; and namesakes with two emails. The list
 * stays put while it is answered, so a person does not vanish under the pointer.
 */
function NewPeople({ review, answers, dismissed, asked, on, onAddFile }: {
  review: Review; answers: Answers; dismissed: string[]; asked: string[]; on: CheckHandlers; onAddFile: () => void;
}) {
  const [all, setAll] = useState(false);
  // Everyone asked about stays while answered; someone a later file says the relationship of goes.
  const people = review.newPeople.filter((x) => asked.includes(x.key) && (x.guessed || x.key in answers.relationships));
  // Namesakes with different emails, once per name: the first one met keeps its email if they are one person.
  const twins: { name: string; keep: NewPerson; others: NewPerson[]; emails: string[]; onRecord: boolean }[] = [];
  for (const x of review.newPeople) {
    if (x.sameName.length === 0 || dismissed.includes(`same:${x.name.toLowerCase()}`)) continue;
    const group = twins.find((t) => t.name.toLowerCase() === x.name.toLowerCase());
    if (group) { group.others.push(x); continue; }
    const emails = [x.email, ...x.sameName.map((s) => s.email)].filter((e): e is string => !!e);
    twins.push({ name: x.name, keep: x, others: [], emails: [...new Set(emails)], onRecord: x.sameName.some((s) => s.onRecord) });
  }
  if (people.length === 0 && twins.length === 0) return null;
  const visible = all ? people : people.slice(0, SHOWN_PEOPLE);
  return (
    <Card>
      {people.length > 0 && (
        <>
          <h2 className="text-[15px] font-semibold text-ink-900">New stakeholders ({people.length})</h2>
          <p className="mt-0.5 text-[13px] text-ink-500">Your file doesn't say how these people relate to the company, so we guessed. Check before importing.</p>
          <ul className="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-2">
            {visible.map((x) => <PersonRow key={x.key} person={x} value={answers.relationships[x.key] ?? x.relation} on={on} />)}
          </ul>
          {people.length > SHOWN_PEOPLE && (
            <button type="button" className="mt-3 text-[13px] font-medium text-brand-600 hover:text-brand-700" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${people.length}`}
            </button>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ink-100 pt-3 text-[13px] text-ink-600">
            <span className="min-w-0 flex-1">Have a stakeholder report? Add it and we'll use its relationships and dates.</span>
            <Button size="sm" icon={<Icon name="plus" />} onClick={onAddFile}>Add a file</Button>
          </div>
        </>
      )}
      {twins.length > 0 && (
        <div className={cx(people.length > 0 && 'mt-4 border-t border-ink-100 pt-4')}>
          <h3 className="text-[14px] font-semibold text-ink-900">Same name, different emails</h3>
          <ul className="mt-2 space-y-3">
            {twins.map((x) => (
              <li key={x.name} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 break-words text-[13px] text-ink-700">
                  <span className="font-medium text-ink-900">{x.name}</span> appears with {x.emails.length} emails: {x.emails.join(', ')}
                  {x.onRecord && ' (one is already on the cap table)'}
                </span>
                <span className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => on.samePerson(x.keep, x.others)}>Same person</Button>
                  <Button size="sm" variant="ghost" onClick={() => on.dismiss(`same:${x.name.toLowerCase()}`)}>Two people</Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function PersonRow({ person, value, on }: { person: NewPerson; value: string; on: CheckHandlers }) {
  const id = useId();
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <label htmlFor={id} className="min-w-0 text-[13px]">
        <span className="block truncate font-medium text-ink-900">{person.name}</span>
        {person.email && <span className="block truncate text-[12px] text-ink-500">{person.email}</span>}
      </label>
      <div className="sm:w-44 sm:shrink-0">
        <Select id={id} aria-label={`How ${person.name} relates to the company`} value={value}
          onChange={(e) => on.setRelationship(person.key, e.target.value)}>
          {Object.entries(RELATION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </div>
    </li>
  );
}

/** "We filled in N things your file doesn't say": the assumptions, grouped, each with the rows it touched. */
function FilledIn({ review, only, setOnly }: { review: Review; only: string | null; setOnly: (code: string | null) => void }) {
  const groups = new Map<string, { rows: number; texts: Set<string> }>();
  for (const s of review.sheets) for (const r of s.preview.rows) {
    for (const m of r.messages) {
      if (m.level !== 'info' || !m.code || !(m.code in FILLED_IN)) continue;
      const g = groups.get(m.code) ?? { rows: 0, texts: new Set<string>() };
      g.rows += 1;
      g.texts.add(m.text);
      groups.set(m.code, g);
    }
  }
  if (groups.size === 0) return null;
  return (
    <details className="group rounded-xl border border-ink-200/70 bg-white px-4 py-3" open={!!only}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[14px] font-medium text-ink-800 [&::-webkit-details-marker]:hidden">
        <Icon name="chevron" className="size-4 -rotate-90 text-ink-400 transition-transform group-open:rotate-0" />
        We filled in {plural(groups.size, 'thing')} your file doesn't say
      </summary>
      <ul className="mt-3 space-y-2 text-[13px] text-ink-700">
        {[...groups].map(([code, g]) => (
          <li key={code} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="min-w-0">{g.texts.size === 1 ? [...g.texts][0] : FILLED_IN[code]} <span className="text-ink-500">({plural(g.rows, 'row')})</span></span>
            <button type="button" className="shrink-0 font-medium text-brand-600 hover:text-brand-700" onClick={() => setOnly(only === code ? null : code)}>
              {only === code ? 'Show every row' : 'Show rows'}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The bar pinned to the bottom of the window: what will happen, in one line,
 * and Import. It sits beside the sidebar and under the dialogs, and keeps its
 * right side clear of the assistant's round button. While it is on screen the
 * page keeps that much room at the bottom when it scrolls a control into view
 * (scroll-padding), so a focused row button is never behind it.
 */
function BottomBar({ review, checking, failed, committing, blocking, toFix, leftOutByBar, errors, pending, nothingReady, kind, assistant, on }: {
  review: Review | null; checking: boolean; failed: boolean; committing: boolean; blocking: number; toFix: LeftOutRow[];
  leftOutByBar: number; errors: number; pending: number; nothingReady: boolean; kind: Kind | null; assistant: boolean; on: CheckHandlers;
}) {
  const reasonId = useId();
  const navigate = useNavigate();
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const fit = () => { root.style.scrollPaddingBottom = `${el.offsetHeight + 16}px`; };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => { watch.disconnect(); root.style.scrollPaddingBottom = ''; };
  }, []);

  const c = review?.counts;
  const ready = c?.willImport ?? 0;
  const rowsToFix = toFix.length;
  const blocked = blocking > 0 || rowsToFix > 0 || errors > 0;
  const settled = !!review && !checking && !failed && !blocked && review.sheets.every((s) => !s.blocked);
  const canImport = settled && !committing && ready > 0;
  // Nothing new (a file imported again): the way on is the page the import started from, not a disabled Import.
  const nothingNew = settled && ready === 0;
  const back = BACK_TO[kind ?? 'captable'];

  const todo = [blocking ? plural(blocking, 'question') : '', rowsToFix ? `${plural(rowsToFix, 'row')} to fix` : ''].filter(Boolean).join(' and ');
  const extras = c ? [
    c.warnings ? `${c.warnings.toLocaleString()} to check` : '',
    c.existing ? `${c.existing.toLocaleString()} already there` : '',
    c.excluded ? `${c.excluded.toLocaleString()} left out` : '',
  ].filter(Boolean) : [];
  const status = checking ? 'Checking…'
    : failed && !review ? 'Couldn’t check this import'
    : !review && nothingReady ? (todo ? `${todo} to answer` : 'Nothing to import')
    : !review ? 'Checking…'
    : blocked ? [todo || `${plural(errors, 'row')} to fix`, ready ? `${ready.toLocaleString()} ready` : '',
      pending ? `${pending.toLocaleString()} ${ready ? 'more ' : ''}ready after that` : ''].filter(Boolean).join(' · ')
    : ready === 0 ? (c?.existing ? `Nothing new to import: ${plural(c.existing, 'row is', 'rows are')} already there` : 'Nothing to import')
    : [`${plural(ready, 'row')} ready`, ...extras].join(' · ');
  const reason = canImport || nothingNew ? null
    : checking ? 'Checking your rows.'
    : failed ? 'Fix the problem above, then try again.'
    : blocking && rowsToFix ? 'Answer the questions and fix or leave out the rows first.'
    : blocking ? 'Answer the questions above first.'
    : blocked ? 'Fix or leave out the rows with problems first.' : null;

  return (
    <div ref={bar} className="fixed inset-x-0 bottom-0 z-[21] border-t border-ink-200 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(16,24,40,.06)] backdrop-blur lg:left-60">
      <div className={cx('mx-auto flex max-w-[1600px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6 lg:px-8',
        assistant && 'pr-[5.25rem] sm:pr-24 lg:pr-24')}>
        <div className="min-w-0 flex-1">
          <p aria-live="polite" className="text-[14px] font-medium text-ink-900">{status}</p>
          {reason && <p id={reasonId} className="text-[12px] text-ink-500 max-sm:sr-only">{reason}</p>}
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          {rowsToFix > 0 && (
            <Button variant="ghost" className="max-sm:h-auto max-sm:justify-start max-sm:px-0 max-sm:text-brand-600" disabled={checking} onClick={() => on.leaveOutRows(toFix)}>
              Leave out {plural(rowsToFix, 'row')}
            </Button>
          )}
          {leftOutByBar > 0 && (
            <Button variant="ghost" className="max-sm:h-auto max-sm:justify-start max-sm:px-0 max-sm:text-brand-600" onClick={on.putBackLeftOut}>
              Fix them instead
            </Button>
          )}
          {nothingNew ? (
            <Button variant="primary" size="lg" className="max-sm:w-full" onClick={() => navigate(back.to)} icon={<Icon name="table" />}>
              {back.label}
            </Button>
          ) : (
            <Button variant="primary" size="lg" className="max-sm:w-full" loading={committing} disabled={!canImport}
              aria-describedby={reason ? reasonId : undefined} onClick={on.commit} icon={<Icon name="check" />}>
              {committing ? 'Importing…' : `Import ${plural(ready, 'row')}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
