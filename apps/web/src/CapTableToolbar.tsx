/**
 * The cap table's own control in its toolbar: the Options menu that holds the
 * table's switches. The rest of the toolbar (the search box, the Full size
 * button and the full size view) is every table's, in DataTable.tsx.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchored, useOutsideClose } from './pickers.tsx';
import { Button, cx } from './ui.tsx';
import { Icon } from './icons.tsx';

export interface MenuSwitch { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }

/** One switch in the menu: it flips on Enter, Space or a click, and the menu stays open for the next. */
function SwitchItem({ item }: { item: MenuSwitch }) {
  const hintId = useId();
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={item.checked} aria-describedby={item.hint ? hintId : undefined}
      onClick={() => item.onChange(!item.checked)}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-ink-50 focus-visible:bg-ink-50">
      <span aria-hidden className={cx('mt-px grid size-4 shrink-0 place-items-center rounded border transition-colors',
        item.checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300 bg-white')}>
        {item.checked && <Icon name="check" className="size-3" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-snug text-ink-800">{item.label}</span>
        {item.hint && <span id={hintId} className="mt-0.5 block text-[12px] leading-snug text-ink-500">{item.hint}</span>}
      </span>
    </button>
  );
}

/**
 * A button that opens a menu of switches, with a count on the button of how
 * many of the counted ones are on, so a table that is not showing its defaults
 * says so without opening the menu. The menu is drawn at the end of the page,
 * so focus goes into it on opening, the arrow keys move between its switches,
 * and Escape or Tab closes it and returns to the button.
 */
export function OptionsMenu({ sections, count, label = 'Options' }: {
  sections: { title: string; items: MenuSwitch[] }[]; count: number; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, anchor, popup, false);
  const refs = useMemo(() => [anchor, popup], []);
  useOutsideClose(open, refs, () => setOpen(false));
  const button = () => anchor.current?.querySelector('button');

  useEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus({ preventScroll: true });
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(popup.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    // Escape closes the menu and nothing behind it, such as the full size view.
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button()?.focus(); }
    // Focus is put back on the button before the browser acts on Tab, so the next stop is the one after it.
    else if (e.key === 'Tab') { setOpen(false); button()?.focus(); }
  };

  return (
    <>
      <span ref={anchor} className="inline-flex">
        <Button icon={<Icon name="settings" />} aria-haspopup="menu" aria-expanded={open} aria-label={`${label}, ${count} on`}
          onClick={() => setOpen((v) => !v)} className={cx(open && 'bg-ink-50')}>
          {label}
          {count > 0 && (
            <span aria-hidden className="-mr-1 grid h-5 min-w-5 place-items-center rounded-full bg-brand-50 px-1.5 text-[11px] font-semibold tabular text-brand-700">
              {count}
            </span>
          )}
        </Button>
      </span>
      {/* Inside the dialog it was opened from, if any (full size), so a reader told the rest of the page is out of reach can still reach it. */}
      {open && createPortal(
        <div ref={popup} role="menu" aria-label={label} style={style} onKeyDown={onMenuKey}
          className="w-80 max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-ink-200 bg-white py-1 shadow-xl outline-none animate-in">
          {sections.map((section, i) => (
            <div key={section.title} role="group" aria-label={section.title} className={cx(i > 0 && 'mt-1 border-t border-ink-100 pt-1')}>
              <p aria-hidden className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{section.title}</p>
              {section.items.map((item) => <SwitchItem key={item.label} item={item} />)}
            </div>
          ))}
        </div>,
        anchor.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body,
      )}
    </>
  );
}
