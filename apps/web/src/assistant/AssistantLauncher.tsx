/**
 * The round button at the bottom right of every page, and the chat panel it opens.
 *
 * The panel is a non-modal dialog: the page behind it stays usable, so someone
 * can read the cap table while they ask about it. Opening it puts focus in the
 * question box; Escape, the close button or the round button again close it and
 * put focus back on the round button. It stays mounted while closed, so a
 * conversation and a half-typed question are still there when it reopens.
 *
 * Both sit below the navigation drawer, the search palette and every dialog,
 * and above the page, so they never cover something that asks for attention.
 *
 * Only people who see the whole company get the button. The assistant reads the
 * whole cap table, and the server refuses it to anyone else. With ai.enabled off
 * in kosmitor.config.json nobody gets it.
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session.tsx';
import { Icon } from '../icons.tsx';
import { cx } from '../ui.tsx';
import { config } from '../config.ts';
import { AssistantChat } from './AssistantChat.tsx';
import { useAssistantPanel } from './shared.tsx';

export function AssistantLauncher() {
  const { canViewAll, companyId } = useSession();
  const { open, setOpen, unread } = useAssistantPanel();
  const launcher = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  // Mounted the first time it opens, then kept: pages load without fetching a chat
  // nobody asked for, and a conversation survives the panel being closed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { if (open) setMounted(true); }, [open]);

  const allowed = config.ai.enabled && canViewAll && !!companyId;
  // Someone whose role in this company stops them asking is not left with the panel open.
  useEffect(() => { if (!allowed) setOpen(false); }, [allowed, setOpen]);

  const close = () => { setOpen(false); launcher.current?.focus(); };

  // Focus goes into the question box once the panel is showing. On the first
  // open the box may not exist yet while the settings load, so the panel itself
  // takes focus meanwhile and the chat moves it on once the box appears.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => (composer.current ?? panel.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, mounted]);

  if (!allowed) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A dialog opened from the panel is drawn elsewhere on the page but still
    // passes its keys up through here; its Escape closes the dialog alone. The
    // Escape that cancels an input method's suggestion closes nothing.
    if (e.key !== 'Escape' || e.nativeEvent.isComposing || !panel.current?.contains(e.target as Node)) return;
    e.stopPropagation();
    close();
  };

  return (
    <>
      {mounted && (
      <section ref={panel} tabIndex={-1} id="assistant-panel" role="dialog" aria-labelledby="assistant-title" hidden={!open}
        onKeyDown={onKeyDown}
        className={cx(
          // The display class is set from the state as well as the hidden attribute,
          // because a display utility would otherwise override the attribute.
          open ? 'flex' : 'hidden',
          'fixed right-5 bottom-24 z-[25] flex-col overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-2xl outline-none animate-in',
          // As wide and as tall as the window allows, up to a comfortable reading size.
          'w-[min(26rem,calc(100vw-2.5rem))] h-[min(40rem,calc(100dvh-8rem))]',
        )}>
        <AssistantChat open={open} onClose={close} composerRef={composer} />
      </section>
      )}

      <button ref={launcher} type="button" onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open} aria-controls={mounted ? 'assistant-panel' : undefined}
        aria-label={unread && !open ? 'Ask the assistant, new answer' : 'Ask the assistant'}
        title={open ? 'Close the assistant' : 'Ask the assistant'}
        className={cx(
          'fixed right-5 bottom-5 z-[25] grid size-14 place-items-center rounded-full text-white shadow-lg transition-all',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          open ? 'bg-ink-800 hover:bg-ink-900' : 'bg-brand-600 hover:bg-brand-700 hover:scale-105',
        )}>
        <Icon name={open ? 'chevron' : 'chat'} className="size-6" />
        {unread && !open && (
          <span aria-hidden className="absolute right-0.5 top-0.5 size-3.5 rounded-full border-2 border-white bg-red-500" />
        )}
      </button>
    </>
  );
}
