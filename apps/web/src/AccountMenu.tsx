/**
 * The signed-in person, as their avatar in the top right corner of the header,
 * and what belongs to them rather than to the company: their own equity, their
 * preferences, and signing out. The menu opens with their name and address, which
 * the avatar alone does not show.
 *
 * It follows the WAI-ARIA menu button pattern. The trigger says it opens a menu
 * and whether it is open. Opening moves focus in: to the first item, or to the
 * last when opened with the up arrow. The arrow keys, Home and End move between
 * items; the menu is a single tab stop, so Tab and Shift+Tab leave it for
 * whatever comes next, from the trigger. Escape, choosing an item, or focus
 * moving anywhere else closes it and returns focus to the trigger.
 *
 * The menu is portalled so the header's blur and its edge never clip it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from './session.tsx';
import { Avatar, cx } from './ui.tsx';
import { Icon, type IconName } from './icons.tsx';
import { useAnchored, useOutsideClose } from './pickers.tsx';

interface Item { label: string; icon: IconName; to?: string; run?: () => void }

const isAt = (pathname: string, to?: string) => !!to && (pathname === to || pathname.startsWith(`${to}/`));

export function AccountMenu() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // Which item takes focus when the menu opens: the first, or the last after ArrowUp.
  const opening = useRef<'first' | 'last'>('first');
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, anchor, popup, false);
  useOutsideClose(open, [anchor, popup], () => setOpen(false));

  const items: Item[] = [
    { label: 'My equity', icon: 'wallet', to: '/portal' },
    { label: 'Preferences', icon: 'settings', to: '/preferences' },
  ];
  const signOutItem: Item = { label: 'Sign out', icon: 'signout', run: () => { void signOut(); } };

  // These pages are reached only through this menu now, so while one is open the
  // trigger shows it and says so, the way a sidebar link marks the page it leads to.
  const here = items.find((i) => isAt(pathname, i.to)) ?? null;

  const menuItems = () => [...(popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const focusItem = (index: number) => {
    const buttons = menuItems();
    if (buttons.length) buttons[(index + buttons.length) % buttons.length].focus();
  };

  /** Closes the menu with focus back on the trigger, so a keyboard user keeps their place. */
  const close = () => { setOpen(false); anchor.current?.focus(); };

  const choose = (item: Item) => {
    close();
    if (item.to) navigate(item.to);
    else item.run?.();
  };

  useEffect(() => {
    if (open) requestAnimationFrame(() => focusItem(opening.current === 'last' ? -1 : 0));
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const at = menuItems().indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(at + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    // Focus goes back to the trigger first, so the browser's own Tab or Shift+Tab
    // moves on from there. Left alone it would move on from the end of the
    // document, where the portalled menu lives.
    else if (e.key === 'Tab') close();
  };

  // Closes when focus goes somewhere other than the menu or its trigger: a click
  // into the page, or the search palette opening over everything.
  const onMenuBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && !popup.current?.contains(next) && !anchor.current?.contains(next)) setOpen(false);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      opening.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  };

  const row = (item: Item) => {
    const current = isAt(pathname, item.to);
    return (
      <button key={item.label} type="button" role="menuitem" tabIndex={-1} onClick={() => choose(item)}
        className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] outline-none transition-colors',
          // Focus shows as clearly as the current page does: a pale grey on white
          // is not enough to follow with the arrow keys.
          'focus:bg-brand-50 focus:text-brand-700',
          current ? 'font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-50')}>
        <Icon name={item.icon} className="size-4 shrink-0 opacity-70" />
        {item.label}
        {/* Said in words rather than with aria-current, which screen readers do not
            reliably read on a menu item, and not both, which reads it twice. */}
        {current && <span className="sr-only">, current page</span>}
      </button>
    );
  };

  return (
    <>
      <button ref={anchor} type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Account menu for ${user?.name ?? 'you'}${here ? `, current page: ${here.label}` : ''}`}
        onClick={() => { opening.current = 'first'; setOpen((v) => !v); }} onKeyDown={onTriggerKey}
        title={user?.name}
        className={cx('grid size-9 place-items-center rounded-full transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          // A ring marks the avatar while My equity or Preferences is open, the way
          // a sidebar link marks the page it leads to.
          here ? 'ring-2 ring-brand-500 ring-offset-1' : open ? 'bg-ink-100' : 'hover:bg-ink-100')}>
        <Avatar name={user?.name ?? '?'} size={28} color={user?.avatarColor ?? undefined} src={user?.avatarUrl} />
      </button>

      {open && createPortal(
        <div ref={popup} role="menu" aria-label="Account" style={style} onKeyDown={onMenuKey} onBlur={onMenuBlur}
          className="animate-in w-60 overflow-auto rounded-lg border border-ink-200 bg-white py-1 shadow-xl outline-none">
          <div role="presentation" className="mb-1 border-b border-ink-100 px-3 pb-2 pt-1.5">
            <p className="truncate text-[13px] font-medium text-ink-900">{user?.name}</p>
            <p className="truncate text-[12px] text-ink-500">{user?.email}</p>
          </div>
          {items.map(row)}
          <div role="separator" className="my-1 border-t border-ink-100" />
          {row(signOutItem)}
        </div>,
        document.body,
      )}
    </>
  );
}
