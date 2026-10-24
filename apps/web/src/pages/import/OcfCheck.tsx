import { useEffect, useRef, useState, type RefObject } from 'react';
import { Banner, Button, ErrorNote, Spinner, cx } from '../../ui.tsx';
import { date } from '../../format.ts';
import { BottomBar, FilledIn, NewPeople, WhatThisAdds, type CheckHandlers, type LeftOutRow } from './Check.tsx';
import { QuestionCard } from './FixCards.tsx';
import { OcfSectionTable } from './OcfSection.tsx';
import { plural, type Answers, type Edits, type Review, type Schema } from './model.ts';
import { OCF_SECTION_WORDS, fieldList, isOcfSection, ocfNeedsOwnFix, ocfPending, type OcfQuestion, type OcfSection, type OcfState } from './ocf.ts';

export interface OcfCheckHandlers extends CheckHandlers {
  /** Who a stakeholder of the package is: one on file, or someone new. */
  setOcfPerson: (ocfId: string, stakeholderId: string | 'new') => void;
  /** Whether another company's package fills in this company's details. */
  setOcfCompanyFill: (fill: boolean) => void;
}

export interface OcfCheckProps {
  ocf: OcfState;
  schema: Schema;
  review: Review | null;
  edits: Edits;
  answers: Answers;
  dismissed: string[];
  checking: boolean;
  checkError: string | null;
  commitError: string | null;
  stale: boolean;
  committing: boolean;
  leftOutByBar: number;
  questions: OcfQuestion[];
  askedPeople: string[];
  assistant: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  on: OcfCheckHandlers;
}

const SECTION_COUNTS: [key: string, one: string, many: string][] = [
  ['stakeholders', 'stakeholder', 'stakeholders'], ['shareClasses', 'share class', 'share classes'], ['plans', 'equity plan', 'equity plans'],
  ['captable', 'certificate', 'certificates'], ['grants', 'grant', 'grants'], ['warrants', 'warrant', 'warrants'], ['convertibles', 'SAFE or note', 'SAFEs & notes'],
  ['transactions', 'transaction', 'transactions'],
];

/**
 * Check your import, for an Open Cap Format package: how the package was read, the
 * questions it raises (who a person is; the cap table's warnings after it), what it
 * adds, the people it creates, then a table per section in the order they are
 * applied, what is not imported, and the bar with Import. A package is imported on
 * its own and nothing in it is edited here: a row with a problem is left out, and
 * its family with it.
 */
export function OcfCheck(p: OcfCheckProps) {
  const { ocf, review, edits, answers, checking, on } = p;
  const [only, setOnly] = useState<string | null>(null);
  const addsHeading = useRef<HTMLHeadingElement>(null);
  const cards = useRef<HTMLDivElement>(null);

  // A card goes once answered; focus moves to the next card's first control, or to "What this adds".
  const answered = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const a = answered.current;
    if (!a || (p.questions.some((q) => q.id === a.id) && checking)) return;
    answered.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const left = cards.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [];
    const next = left[Math.min(a.index, left.length - 1)];
    (next?.querySelector<HTMLElement>('button:not([disabled])') ?? addsHeading.current ?? p.heading.current)?.focus();
  }, [p.questions, checking, p.heading]);

  const toFix: LeftOutRow[] = [];
  for (const s of review?.sheets ?? []) {
    if (!isOcfSection(s.kind)) continue;
    for (const r of s.preview.rows) {
      if (ocfNeedsOwnFix(r)) toFix.push({ tab: s.kind, row: r.row, why: r.messages.filter((m) => m.level === 'error').map((m) => m.text.replace(/\.$/, '')).join('; ') });
    }
  }
  // A package goes in whole: while a row needs fixing, nothing is ready and every row to add waits for it.
  const { ready, pending } = ocfPending(review);
  const barReview = review && ready !== review.counts.willImport ? { ...review, counts: { ...review.counts, willImport: ready } } : review;
  const blocking = p.questions.filter((q) => q.type === 'ocf-person').length;
  const info = review?.ocf;
  const issuer = (info?.issuer ?? ocf.info.issuer);
  const issuerName = issuer?.legalName ?? issuer?.dba ?? 'a company';
  const counts = SECTION_COUNTS.map(([k, one, many]) => (ocf.info.counts[k] ? plural(ocf.info.counts[k], one, many) : '')).filter(Boolean);
  const notices = info?.notices ?? ocf.info.notices;
  const fill = info?.companyFill ?? [];
  const notImported = [...(info?.notImported ?? []).map((n) => `${n.what === n.what.toUpperCase() ? n.what.replace(/^TX_/, '').toLowerCase().replace(/_/g, ' ') : n.what} (${n.count.toLocaleString()}): ${n.reason}`),
    ...(ocf.leftAside.length ? [`An OCF package is imported on its own — import ${ocf.leftAside.join(', ')} afterwards`] : [])];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 ref={p.heading} tabIndex={-1} className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900 outline-none">Check your import</h1>
          <p className="mt-1 text-sm text-ink-500">Nothing is saved until you press Import.</p>
        </div>
        <Button onClick={on.chooseDifferent}>Choose different files</Button>
      </div>

      <div className="mb-5 space-y-1 text-[13px] text-ink-600">
        <p className="break-words">
          <span className="font-medium text-ink-800">{ocf.name}</span> — Open Cap Format {info?.version ?? ocf.info.version ?? ''} package of {issuerName}
          {(info?.asOf ?? ocf.info.asOf) ? `, as of ${date(info?.asOf ?? ocf.info.asOf)}` : ''}.
          {counts.length > 0 && <span className="text-ink-500"> {counts.join(' · ')}.</span>}
        </p>
        {fill.length > 0 && !info?.companyFillAsked && (
          <p>Fills in the company's {fieldList(fill)}, which {fill.length > 1 ? 'are' : 'is'} empty or {fill.length > 1 ? 'were' : 'was'} set when the company was created.</p>
        )}
        {fill.length > 0 && info?.companyFillAsked && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-amber-900">
            <span className="min-w-0">This package is {issuerName}'s. Copy its {fieldList(fill)} into this company?</span>
            <span className="flex gap-2">
              <Button size="sm" variant={info.companyFillApplied ? 'primary' : 'secondary'} disabled={checking} onClick={() => on.setOcfCompanyFill(true)}>Copy them</Button>
              <Button size="sm" variant={info.companyFillApplied ? 'secondary' : 'primary'} disabled={checking} onClick={() => on.setOcfCompanyFill(false)}>Leave the company as it is</Button>
            </span>
          </div>
        )}
        {(info?.classUpdates.length ?? 0) > 0 && (
          <p>Gives {info!.classUpdates.join(', ')} the package's terms: nothing is issued from {info!.classUpdates.length > 1 ? 'them' : 'it'} yet.</p>
        )}
        {notices.length > 0 && (
          <ul className="space-y-0.5">
            {notices.map((n, i) => <li key={i} className={cx(n.level === 'warning' ? 'text-amber-800' : 'text-ink-500')}>{n.text}</li>)}
          </ul>
        )}
      </div>

      <div className="space-y-5">
        {p.checkError && <ErrorNote error={p.checkError} onRetry={on.recheck} />}
        {p.commitError && <div role="alert"><ErrorNote error={p.commitError} /></div>}
        {p.stale && (
          <div role="alert">
            <Banner tone="info" title="The cap table changed since you checked this package, so nothing was imported.">
              {checking || !review ? 'Checking again…' : 'We checked again against it: look over the rows, then press Import.'}
            </Banner>
          </div>
        )}
        {!review && checking && (
          <div className="flex items-center justify-center gap-2.5 py-16 text-ink-500" aria-live="polite"><Spinner className="size-5" /><span className="text-sm">Checking the package…</span></div>
        )}

        {p.questions.length > 0 && (
          <section aria-labelledby="needs-answer" className="space-y-3">
            <h2 id="needs-answer" className="text-[15px] font-semibold text-ink-900">Needs your answer ({p.questions.length})</h2>
            <div ref={cards} className="space-y-3">
              {p.questions.map((q, i) => (
                <div key={q.id} data-card>
                  {q.type === 'ocf-person'
                    ? <PersonCard q={q} chosen={answers.ocfPeople[q.ocfId]} onChoose={(id) => { answered.current = { id: q.id, index: i }; on.setOcfPerson(q.ocfId, id); }} />
                    : <QuestionCard q={q} tabs={[]} singles={new Set()} schema={p.schema} schedules={[]} pools={[]}
                        on={{ ...on, raise: (fix) => { answered.current = { id: q.id, index: i }; on.raise(fix); }, dismiss: (id) => { answered.current = { id: q.id, index: i }; on.dismiss(id); } }} />}
                </div>
              ))}
            </div>
          </section>
        )}

        {review && <WhatThisAdds review={review} answers={answers} pending={pending} heading={addsHeading} onUndoRaise={on.unraise} />}
        {review && <NewPeople review={review} answers={answers} dismissed={p.dismissed} asked={p.askedPeople} on={on} />}

        {review?.sheets.filter((s) => isOcfSection(s.kind)).map((s) => (
          <OcfSectionTable key={s.kind} section={s.kind as OcfSection} sheet={s} busy={checking} why={edits.why[s.kind] ?? {}} only={only}
            onLeaveOut={(row) => {
              const r = s.preview.rows.find((x) => x.row === row);
              on.leaveOutRow({ tab: s.kind, row, why: r ? r.messages.filter((m) => m.level !== 'info').map((m) => m.text.replace(/\.$/, '')).join('; ') : '' });
            }}
            onPutBack={(row) => on.putBackRow(s.kind, row)} />
        ))}

        {notImported.length > 0 && (
          <section aria-labelledby="not-imported" className="text-[13px] text-ink-600">
            <h2 id="not-imported" className="text-[14px] font-semibold text-ink-900">Not imported</h2>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{notImported.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>
        )}

        {review && <FilledIn review={review} only={only} setOnly={setOnly} />}
      </div>

      <div aria-hidden className="h-32 sm:h-20" />
      <BottomBar review={barReview} checking={checking} failed={!!p.checkError} committing={p.committing}
        blocking={blocking} toFix={toFix} leftOutByBar={p.leftOutByBar} errors={review?.counts.errors ?? 0} pending={pending}
        nothingReady={false} kind="captable" assistant={p.assistant} on={on} />
    </div>
  );
}

/** "Which Robin Vale is this?": the people on file the package's person may be, or someone new. */
function PersonCard({ q, chosen, onChoose }: { q: Extract<OcfQuestion, { type: 'ocf-person' }>; chosen: string | undefined; onChoose: (id: string | 'new') => void }) {
  return (
    <div className="rounded-xl border border-ink-200/70 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04)]">
      <p className="text-[14px] font-medium text-ink-900">Which {q.name} is this?</p>
      <p className="mt-1 text-[13px] text-ink-600">
        {OCF_SECTION_WORDS.stakeholders.title} item {q.item} gives no email that tells {plural(q.people.length, 'person', 'people')} of this name on the cap table apart.
      </p>
      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap [&>*]:max-sm:w-full">
        {q.people.map((x) => (
          <Button key={x.id} size="sm" variant={chosen === x.id ? 'primary' : 'secondary'} onClick={() => onChoose(x.id)}>
            {x.name}{x.email ? ` (${x.email})` : ' (no email)'}
          </Button>
        ))}
        <Button size="sm" variant={chosen === 'new' ? 'primary' : 'ghost'} onClick={() => onChoose('new')}>Someone new</Button>
      </div>
    </div>
  );
}
