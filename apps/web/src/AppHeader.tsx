/**
 * The bar across the top of the main column, on every page and at every width.
 *
 * On the left it names the sections the page sits in ("Cap table" above Equity
 * grants), from the same list the sidebar draws, each a way back up; never the
 * page itself, whose own title is just below. On a phone it also holds the button
 * that opens the sidebar. On the right are search (a box with its shortcut on a
 * wide screen, an icon on a phone), the tasks button with what is waiting on the
 * person signed in, and, set a little apart, their account menu. It is as tall as the company
 * switcher at the top of the sidebar, so the two lines under them meet, and it
 * stays put while the page scrolls under it.
 */
import { Link, useLocation } from 'react-router-dom';
import { Button } from './ui.tsx';
import { Icon } from './icons.tsx';
import { NAV } from './nav.ts';
import { MyActionsButton } from './MyActions.tsx';
import { AccountMenu } from './AccountMenu.tsx';
import { SearchButton } from './search.tsx';

interface Place { to: string; trail: { label: string; to?: string }[] }

/** Every page the sidebar names, with the section it sits in, and the few it does not. */
const PLACES: Place[] = [
  ...NAV.flatMap((group) => group.items.flatMap((item): Place[] => [
    ...(item.to ? [{ to: item.to, trail: [{ label: item.label }] }] : []),
    ...(item.children ?? []).map((child) => ({ to: child.to, trail: [{ label: item.label, to: item.to }, { label: child.label }] })),
  ])),
  { to: '/portal', trail: [{ label: 'My equity' }] },
  { to: '/preferences', trail: [{ label: 'Preferences' }] },
  { to: '/onboarding', trail: [{ label: 'New company' }] },
  { to: '/valuations', trail: [{ label: 'Compliance & tax', to: '/compliance' }, { label: '409A valuations', to: '/compliance/409a' }] },
  { to: '/reports/builder', trail: [{ label: 'Governance' }, { label: 'Reports', to: '/reports' }, { label: 'Report builder' }] },
];

/** The deepest page the path is on or under: /grants/abc is on Equity grants. */
export function placeOf(pathname: string): Place | null {
  let best: Place | null = null;
  for (const place of PLACES) {
    const on = pathname === place.to || (place.to !== '/' && pathname.startsWith(`${place.to}/`));
    if (on && (!best || place.to.length > best.to.length)) best = place;
  }
  return best;
}

export function AppHeader({ onOpenNav, onSearch }: { onOpenNav: () => void; onSearch: () => void }) {
  const { pathname } = useLocation();
  // The sections above the page; the page's own name is its title, just below.
  const sections = (placeOf(pathname)?.trail ?? []).slice(0, -1);

  return (
    <header className="sticky top-0 z-20 h-14 border-b border-ink-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <Button variant="ghost" size="sm" onClick={onOpenNav} aria-label="Open navigation" className="-ml-1.5 lg:hidden">
          <Icon name="menu" className="size-5" />
        </Button>

        <nav aria-label="Sections" className="min-w-0 flex-1">
          {sections.length > 0 && (
            <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
              {sections.map((step, i) => (
                <li key={`${step.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && <Icon name="chevron" className="size-3.5 shrink-0 -rotate-90 text-ink-300" />}
                  {step.to ? (
                    <Link to={step.to} className="truncate text-ink-500 hover:text-ink-800">{step.label}</Link>
                  ) : (
                    <span className="truncate text-ink-500">{step.label}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <div className="mr-2 hidden w-60 lg:block"><SearchButton onClick={onSearch} /></div>
          <button type="button" onClick={onSearch} aria-label="Search" title="Search"
            className="grid size-9 place-items-center rounded-lg text-ink-600 hover:bg-ink-100 hover:text-ink-900 lg:hidden">
            <Icon name="search" className="size-5" />
          </button>
          <MyActionsButton />
          <div className="ml-3"><AccountMenu /></div>
        </div>
      </div>
    </header>
  );
}
