import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, enterLayer, isNewestLayer, leaveLayer, useLayerPlace } from '../../ui.tsx';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A panel at the right of the window, 420px wide, for settings that are
 * reachable but not in the way (an import's columns, its reading options); on
 * a phone it fills the screen. It is a dialog: it sits on the dialogs' stack
 * (ui.tsx), so Escape closes it unless something newer is open, Tab goes round
 * inside it, the page behind does not scroll, and focus goes back to the
 * button that opened it. The footer (Done) stays in view while the body scrolls.
 */
export function Drawer({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [id] = useState(() => Symbol('drawer'));
  const titleId = useId();
  const place = useLayerPlace(id);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    enterLayer(id);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && isNewestLayer(id)) onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    // A radio group is entered at its checked choice, as Tab enters it: never on a choice an arrow key would then pick.
    const unchecked = (el: HTMLElement) => el instanceof HTMLInputElement && el.type === 'radio' && !el.checked
      && !!ref.current?.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
    const first = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .find((el) => el.getClientRects().length > 0 && !el.dataset.close && !unchecked(el));
    (first ?? ref.current)?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      leaveLayer(id);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open, id]);

  const keepTabInside = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const stops = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (!open) return null;
  const covered = place >= 0 && !Number.isInteger(place);
  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 50 + Math.max(0, Math.floor(place)) }} inert={covered || undefined}>
      <div className="absolute inset-0 bg-ink-900/30 backdrop-blur-[1px]" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={keepTabInside}
        className={cx('absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-2xl outline-none animate-in sm:w-[420px]',
          'pb-[env(safe-area-inset-bottom)]')}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
          <h2 id={titleId} className="min-w-0 text-base font-semibold text-ink-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" data-close="1"
            className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 focus-visible:outline-2 focus-visible:outline-brand-500">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-ink-100 bg-ink-50/60 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
