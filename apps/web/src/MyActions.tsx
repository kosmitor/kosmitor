/**
 * The tasks button in the header of every page, and the "My pending actions"
 * panel it opens: what is waiting on the person signed in, from GET
 * /c/:cid/my-actions, each item linking to the page where it is done.
 *
 * The list is asked for again on each page change, after anything is saved, when
 * the panel opens and when the window comes back into focus, so the count follows
 * what the person just did, here or elsewhere. The compliance items take the
 * server a moment to work out again after a change: until then it answers with
 * the last ones and says when to ask again, and the button does. While it
 * reloads, the last answer stays on screen.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, SAVED_EVENT } from './api.ts';
import { useSession } from './session.tsx';
import { Spinner, Button, cx } from './ui.tsx';
import { useOutsideClose } from './pickers.tsx';
import { Icon, type IconName } from './icons.tsx';
import { relativeDate } from './format.ts';

export type ActionKind =
  | 'SIGN' | 'VOTE' | 'EXERCISE_PAYMENT'
  | 'COUNTERSIGN' | 'VALUATION_DUE' | 'VALUATION_REQUEST' | 'COMPLIANCE' | 'EXERCISE_REVIEW' | 'OFFER';

export interface MyAction {
  id: string;
  kind: ActionKind;
  title: string;
  detail: string | null;
  to: string;
  date: string | null;
  urgent: boolean;
}

const ICONS: Record<ActionKind, IconName> = {
  SIGN: 'edit', COUNTERSIGN: 'edit', VOTE: 'gavel', EXERCISE_PAYMENT: 'wallet', EXERCISE_REVIEW: 'award',
  OFFER: 'target', VALUATION_DUE: 'calendar', VALUATION_REQUEST: 'inbox', COMPLIANCE: 'shield',
};

/** A reload asked for this soon after the last one (coming back to the window fires two events) is the same one. */
const RECENT_MS = 3_000;
/** Saves tend to come in bursts, an import or a form with its documents: one reload once they stop. */
const AFTER_SAVE_MS = 400;
/** The longest the button waits on the server's word to ask again. */
const MAX_WAIT_MS = 30_000;

/** The person's pending actions in the selected company, kept on screen while they reload. */
function useMyActions(): { items: MyAction[] | null; error: boolean; loading: boolean; reload: (skipIfRecent?: boolean) => void } {
  const { companyId } = useSession();
  const [items, setItems] = useState<MyAction[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const askedAt = useRef(0);
  const again = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback((skipIfRecent = false) => {
    if (!companyId) return;
    if (skipIfRecent && Date.now() - askedAt.current < RECENT_MS) return;
    const seq = ++latest.current;
    askedAt.current = Date.now();
    clearTimeout(again.current);
    setLoading(true);
    api<{ items: MyAction[]; settlesIn?: number }>(`/c/${companyId}/my-actions`)
      .then((r) => {
        if (seq !== latest.current) return;
        setItems(r.items);
        setError(false);
        if (r.settlesIn) again.current = setTimeout(() => reload(), Math.min(r.settlesIn + 500, MAX_WAIT_MS));
      })
      .catch(() => { if (seq === latest.current) setError(true); })
      .finally(() => { if (seq === latest.current) setLoading(false); });
  }, [companyId]);

  // Another company's list is not this one's, so it goes before the new one arrives.
  useEffect(() => { setItems(null); setError(false); }, [companyId]);
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') reload(true); };
    let pause: ReturnType<typeof setTimeout> | undefined;
    // Unless the list was asked for since, as when the save led to another page.
    const onSaved = () => {
      const savedAt = Date.now();
      clearTimeout(pause);
      pause = setTimeout(() => { if (askedAt.current < savedAt) reload(); }, AFTER_SAVE_MS);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener(SAVED_EVENT, onSaved);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener(SAVED_EVENT, onSaved);
      clearTimeout(pause);
      clearTimeout(again.current);
    };
  }, [reload]);
  return { items, error, loading, reload };
}

export function MyActionsButton() {
  const { company } = useSession();
  const { pathname } = useLocation();
  const { items, error, loading, reload } = useMyActions();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useOutsideClose(open, [button, panel], () => setOpen(false));

  // Each page change asks again, and closes the panel when an item led there.
  useEffect(() => { reload(); setOpen(false); }, [pathname, reload]);
  useEffect(() => {
    if (!open) return;
    reload(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, reload]);

  const count = items?.length ?? 0;
  const urgent = (items ?? []).some((i) => i.urgent);

  return (
    <div className="relative">
      <button ref={button} type="button" onClick={() => setOpen((v) => !v)}
        aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog"
        aria-label={count > 0 ? `My pending actions: ${count} waiting` : 'My pending actions'} title="My pending actions"
        className={cx('relative grid size-9 place-items-center rounded-lg transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          open ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900')}>
        <Icon name="tasks" className="size-5" />
        {count > 0 && (
          <span aria-hidden className={cx('absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1',
            'text-[10px] font-semibold leading-none text-white tabular ring-2 ring-white', urgent ? 'bg-red-500' : 'bg-brand-600')}>
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div ref={panel} id={panelId} role="dialog" aria-label="My pending actions"
          className="absolute right-0 top-full z-30 mt-2 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-ink-200/70 bg-white shadow-xl animate-in">
          <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-ink-900">My pending actions</h2>
              <p className="mt-0.5 truncate text-[12px] text-ink-500">What needs you{company ? ` at ${company.name}` : ''}</p>
            </div>
            {loading && items && <Spinner className="mt-0.5 size-4 shrink-0 text-ink-400" />}
          </div>

          <div className="max-h-[min(28rem,calc(100dvh-8rem))] overflow-y-auto overscroll-contain">
            {items === null ? (
              error ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-[13px] text-ink-700">Your pending actions could not be loaded.</p>
                  <Button size="sm" variant="secondary" className="mt-3" onClick={() => reload()}>Try again</Button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-500"><Spinner className="size-4" />Loading…</div>
              )
            ) : items.length === 0 ? <NothingWaiting /> : <ActionList items={items} onPick={() => setOpen(false)} className="py-1" />}
          </div>
        </div>
      )}
    </div>
  );
}

/** The calm line for an empty list. */
export function NothingWaiting() {
  return (
    <div className="px-6 py-10 text-center">
      <span className="mx-auto grid size-10 place-items-center rounded-full bg-secondary-50 text-secondary-700">
        <Icon name="check" className="size-5" />
      </span>
      <p className="mt-3 text-[14px] font-medium text-ink-800">Nothing needs you right now</p>
      <p className="mx-auto mt-1 max-w-64 text-[12px] leading-relaxed text-ink-500">Documents to sign, votes and anything else waiting on you will show up here.</p>
    </div>
  );
}

/** The items, each a link to where it is done: in the panel, and on the Overview. */
export function ActionList({ items, onPick, className }: { items: MyAction[]; onPick?: () => void; className?: string }) {
  return (
    <ul className={cx('divide-y divide-ink-100', className)}>
      {items.map((item) => (
        <li key={item.id}>
          <Link to={item.to} onClick={onPick}
            className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none">
            <span className={cx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-md',
              item.urgent ? 'bg-amber-50 text-amber-700' : 'bg-brand-50 text-brand-600')}>
              <Icon name={ICONS[item.kind] ?? 'tasks'} className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-snug text-ink-900">{item.title}</span>
              {item.detail && <span className="mt-0.5 block text-[12px] leading-snug text-ink-500 line-clamp-2">{item.detail}</span>}
            </span>
            {item.date && <span className="mt-0.5 shrink-0 whitespace-nowrap text-[11px] text-ink-400">{relativeDate(item.date)}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
