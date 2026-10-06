/**
 * The frame every record page is built in.
 *
 * A share certificate, an equity award, a SAFE, a warrant and a 409A valuation
 * are different things, but the page each one gets asks the same questions in
 * the same order: how do I get back, what am I looking at, where does it stand,
 * what can I do to it, and then section after section of what it holds. Five
 * copies of that frame would drift apart one fix at a time, so it lives here
 * and the pages differ only in what they have to say.
 */
import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Card, CardHeader, Button, EmptyState, StatusBadge, ConceptNote, ActionMenu, cx,
} from './ui.tsx';
import type { ActionItem } from './pickers.tsx';
import { Icon, type IconName } from './icons.tsx';
import type { ConceptId } from './concepts.ts';
import { date, shares } from './format.ts';

/** One thing that happened to a record, as every detail endpoint reports it. */
export interface RecordEvent {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string | null;
  quantity: number | null;
  by: string | null;
}

/** A ledger entry, a signature and an edit are three different kinds of fact, so they read differently. */
const DOT_TONE: Record<string, string> = {
  TRANSACTION: 'bg-brand-500', SIGNATURE: 'bg-secondary-500', CHANGE: 'bg-ink-300',
};

export function RecordPage({ back, backLabel, title, status, badges, subtitle, actions = [], concept, children }: {
  /** The list this record belongs to. */
  back: string;
  backLabel: string;
  title: React.ReactNode;
  /** Rendered as the first badge under the title, when the record has a status. */
  status?: string;
  /** Anything else worth badging: a share class, a type, whether a valuation still stands. */
  badges?: React.ReactNode;
  /** One plain sentence of the facts that identify the record. */
  subtitle?: React.ReactNode;
  actions?: ActionItem[];
  concept?: ConceptId;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="mb-4">
        <Link to={back} className="inline-flex items-center gap-1.5 text-[13px] text-ink-500 hover:text-ink-800">
          <Icon name="chevron" className="size-4 rotate-90" /> {backLabel}
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900">{title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {status && <StatusBadge status={status} />}
            {badges}
            {subtitle && <span className="text-[13px] text-ink-500">{subtitle}</span>}
          </div>
        </div>
        <ActionMenu items={actions} />
      </div>

      {/* A record page builds its own header, so the explainer is placed by hand rather than by PageHeader. */}
      {concept && <ConceptNote key={concept} id={concept} />}

      {children}
    </>
  );
}

/**
 * One section of a record. Every section carries the gap to the section above
 * it, except the first, which sits directly under the header.
 */
export function RecordSection({ title, subtitle, action, first, className, children }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  first?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cx(!first && 'mt-5', className)}>
      <CardHeader title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
  );
}

/** The row that opens every record: what it is on the left, who holds it on the right. */
export function RecordColumns({ children }: { children: React.ReactNode }) {
  return <div className="grid items-start gap-5 lg:grid-cols-3">{children}</div>;
}

/** What has happened to this record, newest first. */
export function RecordTimeline({ events, subtitle, emptyTitle, emptyDescription }: {
  events: RecordEvent[];
  subtitle: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <RecordSection title="Activity" subtitle={subtitle}>
      {events.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <ol className="relative space-y-4 border-l border-ink-200 pl-5">
          {events.map((e) => (
            <li key={`${e.kind}:${e.id}`} className="relative">
              <span className={cx('absolute -left-[25px] top-1.5 size-2.5 rounded-full ring-2 ring-white',
                DOT_TONE[e.kind] ?? 'bg-ink-300')} />
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-[13px] text-ink-900 first-letter:uppercase">{e.title}</p>
                <span className="shrink-0 text-[12px] text-ink-500 tabular">{date(e.at)}</span>
              </div>
              {(e.quantity != null || e.detail || e.by) && (
                <p className="mt-0.5 text-[12px] text-ink-500">
                  {[
                    e.quantity != null ? `${shares(e.quantity)} shares` : null,
                    e.detail,
                    e.by ? `by ${e.by}` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </RecordSection>
  );
}

/**
 * The answer to a record that is not there. A holder who opens someone else's
 * record is told the same thing, because that is what the server says: it
 * answers 404 rather than admitting the record exists.
 */
export function RecordMissing({ icon, title, description, to, label }: {
  icon: IconName;
  title: string;
  description: string;
  to: string;
  label: string;
}) {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState icon={<Icon name={icon} className="size-8" />} title={title} description={description}
        action={<Button onClick={() => navigate(to)}>{label}</Button>} />
    </Card>
  );
}
