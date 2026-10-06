import React, { useEffect, useId, useRef, useState, useSyncExternalStore, createContext, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { initials, avatarColor } from './format.ts';

import { cx, INPUT_CLASS } from './style.ts';
import { Select, DateInput, ActionMenu } from './pickers.tsx';
import { ConceptNote } from './ConceptNote.tsx';
import type { ConceptId } from './concepts.ts';
import { makeToast, toastLifetime, TOAST_RELEASE_MS, type Toast, type ToastAction, type ShowToast } from './toasts.ts';
export { cx, Select, DateInput, ConceptNote, ActionMenu };

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
};

const BUTTON_VARIANTS: Record<string, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm disabled:bg-brand-300',
  secondary: 'bg-white text-ink-800 border border-ink-200 hover:bg-ink-50 active:bg-ink-100 shadow-sm',
  ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  subtle: 'bg-ink-100 text-ink-700 hover:bg-ink-200',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-300',
};
const BUTTON_SIZES: Record<string, string> = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        // Labels stay on one line and flex parents may not squeeze a button: a two-word label wrapping inside a fixed-height button spills out of it.
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        'disabled:cursor-not-allowed disabled:opacity-70',
        BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className,
      )}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ children, className, padded = true, id }: { children: React.ReactNode; className?: string; padded?: boolean; id?: string }) {
  // overflow-clip keeps edge-to-edge children (table headers, list rows) inside the rounded
  // corners without creating a scroll container, so sticky headers keep working.
  return (
    <div id={id} className={cx('bg-white rounded-xl border border-ink-200/70 shadow-[0_1px_2px_rgba(16,24,40,.04)] overflow-clip', padded && 'p-5', id && 'scroll-mt-16', className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-ink-900 leading-tight">{title}</h3>
        {subtitle && <p className="text-[13px] text-ink-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, tabs, concept }: {
  title: React.ReactNode; subtitle?: React.ReactNode;
  actions?: React.ReactNode; tabs?: React.ReactNode;
  /** Explain the subject of the page. Naming it here keeps the panel in the same place on every screen. */
  concept?: ConceptId;
}) {
  return (
    <>
      <div className={concept ? 'mb-4' : 'mb-6'}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900">{title}</h1>
            {subtitle && <p className="text-sm text-ink-500 mt-1">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
        {tabs && <div className="mt-4 border-b border-ink-200">{tabs}</div>}
      </div>
      {concept && <ConceptNote key={concept} id={concept} />}
    </>
  );
}

export function Stat({ label, value, hint, tone = 'default', icon }: {
  label: string; value: React.ReactNode; hint?: React.ReactNode;
  tone?: 'default' | 'positive' | 'negative' | 'warning'; icon?: React.ReactNode;
}) {
  const toneClass = {
    default: 'text-ink-900', positive: 'text-secondary-800',
    negative: 'text-red-600', warning: 'text-amber-600',
  }[tone];
  return (
    <Card className="min-w-0">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">{label}</p>
        {icon}
      </div>
      <p className={cx('mt-2 text-[26px] font-semibold tabular leading-none tracking-[-0.02em]', toneClass)}>{value}</p>
      {hint && <p className="mt-2 text-[13px] text-ink-500">{hint}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Badges and pills
// ---------------------------------------------------------------------------

const BADGE_TONES: Record<string, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  success: 'bg-secondary-50 text-secondary-800 ring-secondary-300',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200',
};

export function Badge({ children, tone = 'neutral', className }: {
  children: React.ReactNode; tone?: keyof typeof BADGE_TONES; className?: string;
}) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap',
      BADGE_TONES[tone], className,
    )}>{children}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, keyof typeof BADGE_TONES> = {
    OUTSTANDING: 'success', ACTIVE: 'success', EXECUTED: 'success', APPROVED: 'success',
    SIGNED: 'success', COMPLETED: 'success', FINAL: 'success', SENT: 'success', CONVERTED: 'info',
    PENDING: 'warning', PENDING_APPROVAL: 'warning', AWAITING_SIGNATURE: 'warning', PENDING_SIGNATURE: 'warning', DRAFT: 'neutral',
    OPEN: 'warning', EXPIRED: 'danger', CANCELLED: 'danger', REJECTED: 'danger', FORFEITED: 'danger',
    REPURCHASED: 'neutral', TRANSFERRED: 'neutral', SUPERSEDED: 'neutral', EXERCISED: 'info',
    REPAID: 'neutral', VOID: 'danger', DONE: 'success', REQUESTED: 'info', IN_PROGRESS: 'info', DELIVERED: 'success',
  };
  const label = status.replace(/_/g, ' ').toLowerCase();
  return <Badge tone={map[status] ?? 'neutral'} className="capitalize">{label}</Badge>;
}

export function Avatar({ name, size = 32, color, src }: {
  name: string; size?: number; color?: string; src?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img src={src} alt={name} title={name} width={size} height={size} referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="inline-block shrink-0 rounded-full object-cover select-none bg-ink-100"
        style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none"
      style={{ width: size, height: size, background: color ?? avatarColor(name), fontSize: size * 0.38 }}
      title={name}
    >{initials(name)}</span>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({ label, hint, error, required, children, className }: {
  label?: React.ReactNode; hint?: React.ReactNode; error?: string | null;
  required?: boolean; children: React.ReactNode; className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      {label && (
        <span className="block text-[13px] font-medium text-ink-700 mb-1.5">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </span>
      )}
      {children}
      {hint && !error && <span className="block text-[12px] text-ink-500 mt-1">{hint}</span>}
      {error && <span className="block text-[12px] text-red-600 mt-1">{error}</span>}
    </label>
  );
}


export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type, ...rest }, ref) {
    // Date fields get the themed calendar; everything else is the native control.
    if (type === 'date') return <DateInput ref={ref} type="date" {...rest} className={className} />;
    return <input ref={ref} type={type} {...rest} className={cx(INPUT_CLASS, className)} />;
  });

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(INPUT_CLASS, 'h-auto py-2 min-h-24 leading-relaxed', className)} />;
}

export function Checkbox({ label, hint, checked, onChange, disabled }: {
  label: React.ReactNode; hint?: React.ReactNode; checked: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={cx('flex items-start gap-2.5 cursor-pointer select-none', disabled && 'opacity-60 cursor-not-allowed')}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-ink-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 cursor-pointer" />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink-800 leading-snug">{label}</span>
        {hint && <span className="block text-[12px] text-ink-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-brand-600' : 'bg-ink-300')}>
      <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

/** Segmented control used for cap table views and scenario tabs. */
export function SegmentedControl<T extends string>({ value, onChange, options, size = 'md' }: {
  value: T; onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; title?: string }[];
  size?: 'sm' | 'md';
}) {
  return (
    <div className={cx('inline-flex rounded-lg bg-ink-100 p-0.5', size === 'sm' ? 'text-[12px]' : 'text-[13px]')}>
      {options.map((o) => (
        // aria-pressed is what tells a screen reader which option is chosen; the
        // white background alone only tells someone who can see it.
        <button key={o.value} type="button" title={o.title} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={cx('px-3 rounded-md font-medium transition-all whitespace-nowrap',
            size === 'sm' ? 'h-6' : 'h-7',
            value === o.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (v: T) => void; tabs: { value: T; label: React.ReactNode; count?: number }[];
}) {
  return (
    <nav className="flex gap-1 -mb-px overflow-x-auto">
      {tabs.map((t) => (
        <button key={t.value} onClick={() => onChange(t.value)}
          className={cx('px-3 py-2 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap',
            value === t.value
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-ink-500 hover:text-ink-800 hover:border-ink-300')}>
          {t.label}
          {t.count != null && (
            <span className={cx('ml-1.5 rounded px-1 py-px text-[11px] tabular',
              value === t.value ? 'bg-brand-50 text-brand-700' : 'bg-ink-100 text-ink-500')}>{t.count}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto -mx-px', className)}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function TH({ children, align = 'left', className, width }: {
  children?: React.ReactNode; align?: 'left' | 'right' | 'center'; className?: string; width?: string | number;
}) {
  return (
    <th style={{ width }} className={cx(
      'sticky top-0 z-10 bg-ink-50/95 backdrop-blur px-3 py-2 text-[11px] font-semibold uppercase tracking-wide',
      'text-ink-500 border-b border-ink-200 whitespace-nowrap',
      align === 'right' && 'text-right', align === 'center' && 'text-center', className,
    )}>{children}</th>
  );
}

export function TD({ children, align = 'left', className, mono, colSpan, title }: {
  children?: React.ReactNode; align?: 'left' | 'right' | 'center';
  className?: string; mono?: boolean; colSpan?: number; title?: string;
}) {
  return (
    <td colSpan={colSpan} title={title} className={cx(
      'px-3 py-2.5 border-b border-ink-100 text-ink-800 align-middle',
      align === 'right' && 'text-right', align === 'center' && 'text-center',
      mono && 'tabular', className,
    )}>{children}</td>
  );
}

export function TR({ children, onClick, className, selected }: {
  children: React.ReactNode; onClick?: () => void; className?: string; selected?: boolean;
}) {
  return (
    <tr onClick={onClick} className={cx(
      'transition-colors', onClick && 'cursor-pointer hover:bg-brand-50/40',
      selected && 'bg-brand-50/60', className,
    )}>{children}</tr>
  );
}

export function EmptyState({ title, description, action, icon }: {
  title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode;
}) {
  return (
    <div className="text-center py-14 px-6">
      {icon && <div className="mx-auto mb-3 text-ink-300 flex justify-center">{icon}</div>}
      <p className="text-[15px] font-medium text-ink-800">{title}</p>
      {description && <p className="text-sm text-ink-500 mt-1.5 max-w-md mx-auto leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-ink-500">
      <Spinner className="size-5" /><span className="text-sm">{label}…</span>
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-start gap-3">
      <svg viewBox="0 0 20 20" className="size-5 shrink-0 text-red-500 mt-px" fill="currentColor" aria-hidden>
        <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm1-5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-1-8a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1Z" clipRule="evenodd" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-red-800">{error}</p>
        {onRetry && <Button size="sm" variant="secondary" className="mt-2.5" onClick={onRetry}>Try again</Button>}
      </div>
    </div>
  );
}

export function Banner({ tone = 'info', title, children, onDismiss }: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: React.ReactNode; children?: React.ReactNode; onDismiss?: () => void;
}) {
  const styles = {
    info: 'bg-sky-50 border-sky-200 text-sky-900',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
    danger: 'bg-red-50 border-red-200 text-red-900',
    success: 'bg-secondary-50 border-secondary-300 text-secondary-900',
  }[tone];
  return (
    <div className={cx('rounded-lg border p-3.5 text-sm flex items-start gap-3', styles)}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx('leading-relaxed', title && 'mt-1 opacity-90')}>{children}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-50 hover:opacity-100" aria-label="Dismiss">
          <svg viewBox="0 0 20 20" className="size-4" fill="currentColor"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * The dialogs open right now, oldest first. A dialog can open another on top of
 * it, such as the vault picker over the 409A request, and the one underneath
 * stays where it is, so nobody loses their place. Only the newest answers Escape
 * and takes clicks and focus, and the page behind stays locked until the last
 * one closes, whatever order they close in.
 */
const openDialogs: symbol[] = [];
const dialogListeners = new Set<() => void>();
let pageOverflow = '';
const dialogsChanged = () => { for (const listener of dialogListeners) listener(); };
const watchDialogs = (listener: () => void) => { dialogListeners.add(listener); return () => { dialogListeners.delete(listener); }; };

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode;
  children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [id] = useState(() => Symbol('dialog'));
  // The title and the description are what a screen reader says on opening, so
  // someone whose focus lands on a field still hears what the dialog is for.
  const titleId = useId();
  const descriptionId = useId();
  // Where this dialog sits in the stack, and whether anything is open above it.
  const place = useSyncExternalStore(watchDialogs, () => {
    const at = openDialogs.indexOf(id);
    return at < 0 ? -1 : at === openDialogs.length - 1 ? at : at + 0.5;
  });
  const covered = place >= 0 && !Number.isInteger(place);

  // Callers pass `onClose` as an inline arrow, so its identity changes on every
  // parent render. Holding it in a ref keeps the effects below dependent on
  // `open` alone — otherwise every keystroke in a field would tear down and
  // re-run them, and the focus call would pull the caret out of the field.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    if (openDialogs.length === 0) {
      pageOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openDialogs.push(id);
    dialogsChanged();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openDialogs.at(-1) === id) onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      if (openDialogs.length === 0) document.body.style.overflow = pageOverflow;
      dialogsChanged();
    };
  }, [open, id]);

  // Move focus into the dialog once, on opening. Landing on the first field
  // rather than the wrapper means you can start typing straight away. Closing
  // puts focus back where it was, so a keyboard user carries on from the control
  // that opened the dialog instead of starting again from the top of the page.
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = root.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    );
    (first ?? root).focus();
    return () => {
      if (!before?.isConnected) return;
      // Opened from another dialog, the control to return to is still inert at this
      // moment (the dialog underneath is released on its next render) and would
      // refuse focus, so it gets it a frame later instead.
      if (before.closest('[inert]')) requestAnimationFrame(() => { if (before.isConnected) before.focus({ preventScroll: true }); });
      else before.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

  // Drawn at the end of the page rather than where it is declared: a dialog opened
  // from inside something animated, clipped or layered, such as the assistant
  // panel, would otherwise be sized, clipped and stacked by that container.
  //
  // In a window at least 36rem tall the dialog never grows past it, so its header
  // and footer stay in view and the layer behind has nothing to scroll: a wheel over
  // the header or the footer used to scroll that layer and slide the whole dialog
  // off the screen. In a shorter window (a small laptop zoomed in) pinning both
  // would leave the body almost no room, so there the dialog scrolls as a whole.
  // The body is where scrolling happens, and it is positioned so that anything
  // absolutely placed inside it (screen-reader text, a hidden file input) is
  // measured and clipped there too, rather than against the dialog, where it hung
  // below the body and made the layer behind scrollable after all. Rows that hide
  // such things should be positioned themselves, so they are clipped where they sit.
  return createPortal(
    // A dialog with another over it stays drawn but out of reach (inert), so a tab
    // or a click cannot wander into it while the one on top is open.
    <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ zIndex: 50 + Math.max(0, Math.floor(place)) }} inert={covered || undefined}>
      <div className="fixed inset-0 bg-ink-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
        className={cx('relative flex w-full flex-col bg-white rounded-xl shadow-2xl animate-in my-auto outline-none [@media(min-height:36rem)]:max-h-[calc(100dvh-2rem)] sm:[@media(min-height:36rem)]:max-h-[calc(100dvh-4rem)]', widths[size])}>
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-3 border-b border-ink-100">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink-900">{title}</h2>
            {description && <p id={descriptionId} className="text-[13px] text-ink-500 mt-1 leading-relaxed">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="relative min-h-0 flex-1 overscroll-contain px-5 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 px-5 py-3.5 border-t border-ink-100 bg-ink-50/60 rounded-b-xl flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading }: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm text-ink-700 leading-relaxed">{message}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const ToastContext = createContext<ShowToast>(() => {});
/** toast(message), toast(message, tone), or toast(message, tone, { label: 'Undo', onClick }) for a toast with a button. */
export const useToast = () => useContext(ToastContext);
export type { ToastAction };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());
  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const schedule = useCallback((id: number, ms: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
  }, [dismiss]);
  const push = useCallback<ShowToast>((message, tone = 'success', action) => {
    const toast = makeToast(Date.now() + Math.random(), message, tone, action);
    setToasts((t) => [...t, toast]);
    schedule(toast.id, toastLifetime(toast));
  }, [schedule]);
  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);

  // A toast with a button stays while the pointer is over it or focus is in it,
  // so it never disappears from under someone reaching for Undo, and goes a
  // moment after they leave it.
  const hold = (id: number) => { window.clearTimeout(timers.current.get(id)); timers.current.delete(id); };
  const release = (id: number, el: HTMLElement, to: EventTarget | null) => {
    if ((to instanceof Node && el.contains(to)) || el.matches(':hover') || el.contains(document.activeElement)) return;
    schedule(id, TOAST_RELEASE_MS);
  };

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* A live region, so a confirmation or a refusal is heard as well as seen.
          Errors are alerts, which interrupt; everything else waits its turn. */}
      {/* Beside the assistant's round button, not on top of it: right of the page,
          left of the button, and on a phone across the bottom clear of it. */}
      <div role="status" aria-live="polite" className="fixed bottom-5 left-5 right-24 z-[60] flex flex-col items-end gap-2 pointer-events-none sm:left-auto">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : undefined}
            onMouseEnter={t.action ? () => hold(t.id) : undefined}
            onMouseLeave={t.action ? (e) => release(t.id, e.currentTarget, null) : undefined}
            onFocus={t.action ? () => hold(t.id) : undefined}
            onBlur={t.action ? (e) => release(t.id, e.currentTarget, e.relatedTarget) : undefined}
            className={cx(
              'animate-in pointer-events-auto rounded-lg px-4 py-2.5 text-sm shadow-lg max-w-sm',
              t.action && 'flex items-center gap-3',
              t.tone === 'success' && 'bg-ink-900 text-white',
              t.tone === 'error' && 'bg-red-600 text-white',
              t.tone === 'info' && 'bg-white text-ink-800 border border-ink-200',
            )}>
            {t.action ? (
              <>
                <span className="min-w-0">{t.message}</span>
                <button type="button" onClick={() => { dismiss(t.id); t.action!.onClick(); }}
                  className={cx('-my-1 -mr-2 shrink-0 rounded-md px-2 py-1 text-[13px] font-semibold transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-1',
                    t.tone === 'info'
                      ? 'text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-500'
                      : t.tone === 'error' ? 'text-white underline hover:bg-white/15 focus-visible:outline-white'
                      : 'text-brand-300 hover:bg-white/10 focus-visible:outline-brand-300')}>
                  {t.action.label}
                </button>
              </>
            ) : t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Horizontal share-of-total bar used in ownership tables. */
export function MiniBar({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'teal' | 'amber' }) {
  const colors = { brand: 'bg-brand-500', teal: 'bg-secondary-500', amber: 'bg-amber-500' };
  return (
    <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
      <div className={cx('h-full rounded-full transition-all', colors[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Tooltip({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="relative inline-flex group">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap
        rounded-md bg-ink-900 px-2 py-1 text-[11px] font-normal text-white shadow-lg group-hover:block">
        {label}
      </span>
    </span>
  );
}

export function InfoDot({ text }: { text: string }) {
  return (
    <Tooltip label={text}>
      <span className="ml-1 inline-flex size-3.5 items-center justify-center rounded-full bg-ink-200 text-[9px] font-bold text-ink-600 cursor-help align-middle">i</span>
    </Tooltip>
  );
}

export function KeyValue({ items, columns = 2 }: {
  items: { label: React.ReactNode; value: React.ReactNode }[]; columns?: 1 | 2 | 3;
}) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3',
      columns === 1 && 'grid-cols-1', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-3')}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12px] text-ink-500">{it.label}</dt>
          <dd className="text-sm text-ink-900 mt-0.5 tabular break-words">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Search box with a debounced value for filtering long tables. */
export function SearchInput({ value, onChange, placeholder = 'Search' }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className="relative">
      <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="9" cy="9" r="5.5" /><path d="m13.5 13.5 3 3" strokeLinecap="round" />
      </svg>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" />
    </div>
  );
}
