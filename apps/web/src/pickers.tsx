/**
 * Themed replacements for the two native controls whose pop-ups the browser
 * draws in its own style: the select and the date field. Both keep the native
 * component's API (value, onChange with `e.target.value`, disabled, min/max),
 * so call sites need no change, and both float their pop-up through a portal
 * so cards that clip their content and scrolling dialogs cannot cut it off.
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx, INPUT_CLASS } from './style.ts';
import { Icon, type IconName } from './icons.tsx';
import { config } from './config.ts';

// ---------------------------------------------------------------------------
// Anchored pop-ups
// ---------------------------------------------------------------------------

/** Places a fixed pop-up under (or, when short of room, above) its anchor and follows scrolling and resizing. */
export function useAnchored(open: boolean, anchor: React.RefObject<HTMLElement | null>, popup: React.RefObject<HTMLElement | null>, matchWidth: boolean): React.CSSProperties {
  // Parked at the corner (not hidden) until placed, so focus can land on it during the first commit.
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', top: 0, left: 0, zIndex: 70 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const height = popup.current?.offsetHeight ?? 320;
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const openBelow = below >= Math.min(height, 220) || below >= above;
      const width = matchWidth ? Math.max(r.width, 160) : (popup.current?.offsetWidth ?? 288);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      // The pop-up is never taller than the room it has, so in a short window or at
      // high zoom it scrolls instead of running off the edge where it cannot be reached.
      setStyle(openBelow
        ? { position: 'fixed', top: r.bottom + 4, left, minWidth: matchWidth ? width : undefined, maxHeight: Math.max(0, below), zIndex: 70 }
        : { position: 'fixed', bottom: window.innerHeight - r.top + 4, left, minWidth: matchWidth ? width : undefined, maxHeight: Math.max(0, above), zIndex: 70 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchor, popup, matchWidth]);
  return style;
}

/** Closes the pop-up on a press outside both the anchor and the pop-up itself. */
export function useOutsideClose(open: boolean, refs: React.RefObject<HTMLElement | null>[], close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!refs.some((r) => r.current?.contains(t))) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, refs, close]);
}

const POPUP_CLASS = 'rounded-lg border border-ink-200 bg-white shadow-xl outline-none animate-in';

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

interface Option { value: string; label: React.ReactNode; text: string; disabled: boolean }

const textOf = (node: React.ReactNode): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  return '';
};

/** The `<option>` children of a select, flattened through fragments, arrays and groups. */
function optionsFrom(children: React.ReactNode): Option[] {
  const out: Option[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const el = child as React.ReactElement<Record<string, unknown>>;
    if (el.type === React.Fragment || el.type === 'optgroup') { out.push(...optionsFrom(el.props.children as React.ReactNode)); return; }
    if (el.type === 'option') {
      const label = el.props.children as React.ReactNode;
      const value = el.props.value !== undefined ? String(el.props.value) : textOf(label);
      out.push({ value, label, text: textOf(label), disabled: !!el.props.disabled });
    }
  });
  return out;
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string };

export function Select({ className, children, value, defaultValue, onChange, disabled, name, id, placeholder, ...rest }: SelectProps) {
  const options = useMemo(() => optionsFrom(children), [children]);
  const current = String(value ?? defaultValue ?? '');
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  const style = useAnchored(open, button, list, true);
  const refs = useMemo(() => [button, list], []);
  useOutsideClose(open, refs, () => setOpen(false));

  const emit = (next: string) => {
    if (next === current) return;
    const target = { value: next, name } as unknown as HTMLSelectElement;
    onChange?.({ target, currentTarget: target } as unknown as React.ChangeEvent<HTMLSelectElement>);
  };
  const show = () => {
    if (disabled) return;
    const i = options.findIndex((o) => o.value === current);
    setActive(i >= 0 ? i : Math.max(0, options.findIndex((o) => !o.disabled)));
    setOpen(true);
  };
  const choose = (o: Option) => {
    if (o.disabled) return;
    setOpen(false);
    button.current?.focus();
    emit(o.value);
  };
  const move = (delta: number) => {
    if (!options.length) return;
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + delta + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  useEffect(() => { if (open) list.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    e.stopPropagation(); // a dialog behind us must not also act on Escape
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(Math.max(0, options.findIndex((o) => !o.disabled))); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = options[active]; if (o) choose(o); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = options.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  };
  const onButtonKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
  };

  return (
    <>
      <button ref={button} type="button" id={id} disabled={disabled} aria-label={rest['aria-label']} title={rest.title}
        role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={onButtonKey}
        className={cx(INPUT_CLASS, 'flex items-center justify-between gap-2 text-left', !selected && 'text-ink-400', className)}>
        <span className="min-w-0 flex-1 truncate">{selected ? selected.label : (current || placeholder || ' ')}</span>
        <Icon name="chevron" className={cx('size-4 shrink-0 text-ink-400 transition-transform', open && 'rotate-180')} />
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {open && createPortal(
        <ul ref={list} id={listId} role="listbox" tabIndex={-1} aria-activedescendant={`${listId}-${active}`} onKeyDown={onListKey}
          style={style} className={cx(POPUP_CLASS, 'overflow-y-auto p-1')}>
          {options.length === 0 && <li className="px-2.5 py-2 text-[13px] text-ink-500">No options</li>}
          {options.map((o, i) => (
            <li key={`${o.value}-${i}`} id={`${listId}-${i}`} role="option" aria-selected={o.value === current} aria-disabled={o.disabled || undefined}
              data-index={i} onMouseEnter={() => { if (!o.disabled) setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}
              className={cx('flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm',
                o.disabled ? 'cursor-not-allowed text-ink-300' : i === active ? 'cursor-pointer bg-brand-50 text-brand-700' : 'cursor-pointer text-ink-800',
                o.value === current && !o.disabled && 'font-medium')}>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.value === current && <Icon name="check" className="size-4 shrink-0 text-brand-600" />}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Date field
// ---------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number): string => String(n).padStart(2, '0');
const toISO = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayISO = (): string => { const t = new Date(); return toISO(t.getFullYear(), t.getMonth(), t.getDate()); };
const partsOf = (iso: string): { y: number; m: number; d: number } | null => {
  const m = ISO.exec(iso);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo && probe.getUTCDate() === d ? { y, m: mo, d } : null;
};
const shiftDays = (iso: string, days: number): string => {
  const p = partsOf(iso) ?? partsOf(todayISO())!;
  const t = new Date(Date.UTC(p.y, p.m, p.d + days));
  return toISO(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};
const shiftMonths = (iso: string, months: number): string => {
  const p = partsOf(iso) ?? partsOf(todayISO())!;
  const first = new Date(Date.UTC(p.y, p.m + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return toISO(first.getUTCFullYear(), first.getUTCMonth(), Math.min(p.d, last));
};
// Written in locale.locale from kosmitor.config.json. Typed dates are still read month first (parseLoose).
const DISPLAY = new Intl.DateTimeFormat(config.locale.locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat(config.locale.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat(config.locale.locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** Column heads, Sunday first: the first two letters of each short day name ("Su", "Mo" in English). 1 January 2023 was a Sunday. */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => [...new Intl.DateTimeFormat(config.locale.locale, { weekday: 'short', timeZone: 'UTC' })
  .format(new Date(Date.UTC(2023, 0, 1 + i)))].slice(0, 2).join(''));
const display = (iso: string): string => (partsOf(iso) ? DISPLAY.format(new Date(`${iso}T00:00:00Z`)) : iso);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** What someone typed, as an ISO date: 2024-03-15, 3/15/2024, 15 Mar 2024, Mar 15, 2024. Empty clears; unreadable is null. */
function parseLoose(text: string): string | null {
  const t = text.trim();
  if (!t) return '';
  if (ISO.test(t)) return partsOf(t) ? t : null;
  const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (us) {
    const y = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const iso = toISO(y, Number(us[1]) - 1, Number(us[2]));
    return partsOf(iso) ? iso : null;
  }
  const words = t.toLowerCase().replace(/,/g, ' ').split(/\s+/);
  const monthIdx = words.findIndex((w) => MONTHS.some((m) => w.startsWith(m)));
  if (monthIdx >= 0) {
    const m = MONTHS.findIndex((mm) => words[monthIdx].startsWith(mm));
    const nums = words.filter((_, i) => i !== monthIdx).map(Number).filter((n) => Number.isInteger(n));
    const day = nums.find((n) => n >= 1 && n <= 31);
    const year = nums.find((n) => n >= 1000) ?? new Date().getFullYear();
    if (day != null) { const iso = toISO(year, m, day); return partsOf(iso) ? iso : null; }
  }
  return null;
}

type DateInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { className, value, defaultValue, onChange, min, max, disabled, required, placeholder, name, id, onBlur, onFocus, onKeyDown, type, ...rest }, ref,
) {
  void type; // always a text field with a calendar, whatever the caller asked for
  const iso = String(value ?? defaultValue ?? '');
  const [text, setText] = useState(() => display(iso));
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(iso || todayISO()); // the day the keyboard is on; also names the month shown
  const wrap = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, wrap, popup, false);
  const refs = useMemo(() => [wrap, popup], []);
  useOutsideClose(open, refs, () => setOpen(false));
  useEffect(() => { if (!editing) setText(display(iso)); }, [iso, editing]);

  const setInputRef = (el: HTMLInputElement | null) => {
    input.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
  };
  const lo = typeof min === 'string' && partsOf(min) ? min : null;
  const hi = typeof max === 'string' && partsOf(max) ? max : null;
  const inRange = (d: string): boolean => (!lo || d >= lo) && (!hi || d <= hi);

  const emit = (next: string) => {
    if (next === iso) return;
    const target = { value: next, name } as unknown as HTMLInputElement;
    onChange?.({ target, currentTarget: target } as unknown as React.ChangeEvent<HTMLInputElement>);
  };
  const openCalendar = () => {
    if (disabled) return;
    setCursor(iso && partsOf(iso) ? iso : todayISO());
    setOpen(true);
  };
  const pick = (day: string) => {
    if (!inRange(day)) return;
    emit(day);
    setText(display(day));
    setOpen(false);
    input.current?.focus();
  };
  const commitText = () => {
    setEditing(false);
    const parsed = parseLoose(text);
    if (parsed === null || (parsed && !inRange(parsed))) { setText(display(iso)); return; }
    emit(parsed);
    setText(display(parsed));
  };

  // Keyboard focus follows the cursor day while the calendar is open.
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLElement>(`[data-day="${cursor}"]`)?.focus({ preventScroll: true });
  }, [open, cursor]);

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const moves: Record<string, () => string> = {
      ArrowLeft: () => shiftDays(cursor, -1), ArrowRight: () => shiftDays(cursor, 1),
      ArrowUp: () => shiftDays(cursor, -7), ArrowDown: () => shiftDays(cursor, 7),
      PageUp: () => shiftMonths(cursor, e.shiftKey ? -12 : -1), PageDown: () => shiftMonths(cursor, e.shiftKey ? 12 : 1),
      Home: () => shiftDays(cursor, -new Date(`${cursor}T00:00:00Z`).getUTCDay()),
      End: () => shiftDays(cursor, 6 - new Date(`${cursor}T00:00:00Z`).getUTCDay()),
    };
    if (moves[e.key]) { e.preventDefault(); setCursor(moves[e.key]()); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(cursor); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); setOpen(false); input.current?.focus(); }
  };

  const month = partsOf(cursor) ?? partsOf(todayISO())!;
  const firstWeekday = new Date(Date.UTC(month.y, month.m, 1)).getUTCDay();
  const start = shiftDays(toISO(month.y, month.m, 1), -firstWeekday);
  const days = Array.from({ length: 42 }, (_, i) => shiftDays(start, i));
  const today = todayISO();

  return (
    <div ref={wrap} className="relative">
      <input ref={setInputRef} type="text" id={id} value={text} disabled={disabled} required={required} autoComplete="off"
        placeholder={placeholder ?? 'Pick a date'} aria-haspopup="dialog" aria-expanded={open} {...rest}
        onChange={(e) => { setEditing(true); setText(e.target.value); }}
        onFocus={(e) => { setEditing(true); onFocus?.(e); }}
        onBlur={(e) => { commitText(); onBlur?.(e); }}
        onClick={() => { if (!open) openCalendar(); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || (e.key === 'Enter' && e.altKey)) { e.preventDefault(); openCalendar(); }
          else if (e.key === 'Enter' && text !== display(iso)) { e.preventDefault(); commitText(); }
          else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); } // the calendar closes, not a dialog behind it
          onKeyDown?.(e);
        }}
        className={cx(INPUT_CLASS, 'pr-9', className)} />
      {name && <input type="hidden" name={name} value={iso} />}
      <button type="button" tabIndex={-1} disabled={disabled} aria-label="Open calendar" onClick={() => (open ? setOpen(false) : openCalendar())}
        className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:hover:bg-transparent">
        <Icon name="calendar" className="size-4" />
      </button>
      {open && createPortal(
        <div ref={popup} role="dialog" aria-label="Choose a date" style={style} className={cx(POPUP_CLASS, 'w-72 p-3')}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-0.5">
              <button type="button" aria-label="Previous year" onClick={() => setCursor(shiftMonths(cursor, -12))} className="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                <span className="text-[13px] font-medium">«</span>
              </button>
              <button type="button" aria-label="Previous month" onClick={() => setCursor(shiftMonths(cursor, -1))} className="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                <Icon name="chevron" className="size-4 rotate-90" />
              </button>
            </div>
            <span className="text-[13px] font-semibold text-ink-900">{MONTH.format(new Date(Date.UTC(month.y, month.m, 1)))}</span>
            <div className="flex items-center gap-0.5">
              <button type="button" aria-label="Next month" onClick={() => setCursor(shiftMonths(cursor, 1))} className="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                <Icon name="chevron" className="size-4 -rotate-90" />
              </button>
              <button type="button" aria-label="Next year" onClick={() => setCursor(shiftMonths(cursor, 12))} className="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                <span className="text-[13px] font-medium">»</span>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-y-0.5 text-center text-[11px] font-medium uppercase tracking-wide text-ink-400">
            {WEEKDAYS.map((d, i) => <span key={i} className="py-1">{d}</span>)}
          </div>
          <div ref={grid} role="grid" aria-label={MONTH.format(new Date(Date.UTC(month.y, month.m, 1)))} onKeyDown={onGridKey} className="grid grid-cols-7 gap-y-0.5">
            {days.map((day) => {
              const p = partsOf(day)!;
              const inMonth = p.m === month.m;
              const selected = day === iso;
              const allowed = inRange(day);
              return (
                <button key={day} type="button" role="gridcell" data-day={day} tabIndex={day === cursor ? 0 : -1} disabled={!allowed}
                  aria-label={LONG.format(new Date(`${day}T00:00:00Z`))} aria-selected={selected} aria-current={day === today ? 'date' : undefined}
                  onClick={() => pick(day)} onMouseEnter={() => { if (allowed) setCursor(day); }}
                  className={cx('mx-auto grid size-8 place-items-center rounded-md text-[13px] tabular transition-colors',
                    selected ? 'bg-brand-600 font-semibold text-white' : allowed ? 'hover:bg-brand-50 hover:text-brand-700' : 'cursor-not-allowed text-ink-300',
                    !selected && allowed && (inMonth ? 'text-ink-800' : 'text-ink-400'),
                    !selected && day === today && 'ring-1 ring-inset ring-brand-400',
                    !selected && day === cursor && allowed && 'bg-ink-100')}>
                  {p.d}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-ink-100 pt-2 text-[12px]">
            <button type="button" onClick={() => pick(today)} disabled={!inRange(today)} className="rounded-md px-2 py-1 font-medium text-brand-700 hover:bg-brand-50 disabled:text-ink-300 disabled:hover:bg-transparent">Today</button>
            {!required && <button type="button" onClick={() => { emit(''); setText(''); setOpen(false); }} className="rounded-md px-2 py-1 text-ink-500 hover:bg-ink-100 hover:text-ink-800">Clear</button>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

export interface ActionItem {
  label: string;
  onClick: () => void;
  icon?: IconName;
  /** Destructive actions are separated from the rest and coloured. */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * The overflow menu for a table row.
 *
 * A row with five buttons needs about three hundred pixels, which a wide table
 * never has, so the buttons wrap and the column turns into a ragged block. The
 * primary action stays a button at the call site and everything else comes here,
 * where the label has room to be a readable sentence instead of a guessable icon.
 * Like the other pop-ups in this file it floats through a portal, because the
 * cards that hold tables clip their content.
 */
export function ActionMenu({ items, label = 'More actions' }: { items: ActionItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, anchor, popup, false);
  useOutsideClose(open, [anchor, popup], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    // Taken, so that nothing behind the menu, such as a table's full size view, closes with it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The menu is drawn at the end of the page, so Tab would never reach it from
  // the button. Focus goes into it on opening instead, the arrow keys move
  // between its items, and Tab closes it and carries on from the button.
  useEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = Array.from(popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const at = enabled.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      e.stopPropagation();
      enabled[(i + enabled.length) % enabled.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    // Escape closes the menu and nothing behind it: not a dialog the row is in, nor a table's full size view.
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); anchor.current?.focus(); }
    // Focus is put on the button before the browser acts on Tab, so the next
    // stop is the one after the button rather than the end of the page.
    else if (e.key === 'Tab') { setOpen(false); anchor.current?.focus(); }
  };

  if (items.length === 0) return null;
  const ordinary = items.filter((i) => !i.danger);
  const destructive = items.filter((i) => i.danger);

  // Focus goes back to the button before the item acts, so a dialog the item
  // opens returns focus there on closing instead of to the top of the page.
  const row = (item: ActionItem) => (
    <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
      onClick={() => { setOpen(false); anchor.current?.focus(); item.onClick(); }}
      className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] outline-none transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        item.danger ? 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50' : 'text-ink-700 hover:bg-ink-50 focus-visible:bg-ink-50')}>
      {item.icon && <Icon name={item.icon} className="size-4 shrink-0 opacity-70" />}
      {item.label}
    </button>
  );

  return (
    <>
      <button ref={anchor} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cx('inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          open ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900')}>
        <Icon name="more" className="size-4" />
      </button>
      {open && createPortal(
        <div ref={popup} role="menu" aria-label={label} style={style} onKeyDown={onMenuKey} className={cx(POPUP_CLASS, 'min-w-44 overflow-auto py-1')}>
          {ordinary.map(row)}
          {destructive.length > 0 && ordinary.length > 0 && <div className="my-1 border-t border-ink-100" />}
          {destructive.map(row)}
        </div>,
        document.body,
      )}
    </>
  );
}
