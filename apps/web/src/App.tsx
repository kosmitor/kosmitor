import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './session.tsx';
import { Avatar, Button, Loading, cx } from './ui.tsx';
import { Icon, Logo } from './icons.tsx';
import { NAV, type NavItem, type Requirement } from './nav.ts';
import { SearchPalette, SearchButton } from './search.tsx';
import { config, PRODUCT } from './config.ts';

import SignIn from './pages/SignIn.tsx';
import ResetPassword from './pages/ResetPassword.tsx';
import { MustChangePasswordGate } from './account.tsx';
import Dashboard from './pages/Dashboard.tsx';
import CapTable from './pages/CapTable.tsx';
import Stakeholders from './pages/Stakeholders.tsx';
import StakeholderDetail from './pages/StakeholderDetail.tsx';
import ShareClasses from './pages/ShareClasses.tsx';
import Certificates from './pages/Certificates.tsx';
import CertificateDetail from './pages/CertificateDetail.tsx';
import Grants from './pages/Grants.tsx';
import AwardDetail from './pages/AwardDetail.tsx';
import Offers from './pages/Offers.tsx';
import OfferView from './pages/OfferView.tsx';
import ValuationDesk from './pages/ValuationDesk.tsx';
import Convertibles from './pages/Convertibles.tsx';
import ConvertibleDetail from './pages/ConvertibleDetail.tsx';
import Warrants from './pages/Warrants.tsx';
import WarrantDetail from './pages/WarrantDetail.tsx';
import ValuationDetail from './pages/ValuationDetail.tsx';
import Plans from './pages/Plans.tsx';
import ModelRound from './pages/ModelRound.tsx';
import ModelExit from './pages/ModelExit.tsx';
import Compliance from './pages/Compliance.tsx';
import Documents from './pages/Documents.tsx';
import Templates from './pages/Templates.tsx';
import Updates from './pages/Updates.tsx';
import Calculator from './pages/Calculator.tsx';
import Consents from './pages/Consents.tsx';
import Ledger from './pages/Ledger.tsx';
import Reports from './pages/Reports.tsx';
import ReportBuilder from './pages/ReportBuilder.tsx';
import StockComp from './pages/StockComp.tsx';
import AuditLog from './pages/AuditLog.tsx';
import Team from './pages/Team.tsx';
import Company from './pages/Company.tsx';
import Portal from './pages/Portal.tsx';
import Preferences from './pages/Preferences.tsx';
import { AccountMenu } from './AccountMenu.tsx';
import { AssistantLauncher } from './assistant/AssistantLauncher.tsx';
import { AssistantPanelProvider, useAssistantPanel } from './assistant/shared.tsx';
import Onboarding from './pages/Onboarding.tsx';
import ImportData from './pages/Import.tsx';

const NAV_LINK = 'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors';
const NAV_ACTIVE = 'bg-brand-50 text-brand-700';
const NAV_IDLE = 'text-ink-800 hover:bg-ink-50 hover:text-ink-950';
const SECTIONS_KEY = 'ct_nav_sections';

/** Whether the current page belongs to a sidebar item: its own route or one of its sub-items, which may live at their own paths. */
function isWithin(item: NavItem, pathname: string): boolean {
  const under = (to: string) => pathname === to || (to !== '/' && pathname.startsWith(`${to}/`));
  return (item.to != null && item.to !== '/' && under(item.to)) || (item.children ?? []).some((child) => under(child.to));
}

function Sidebar({ open, onClose, onSearch }: { open: boolean; onClose: () => void; onSearch: () => void }) {
  const { company, companies, selectCompany, canEdit, canViewAll, isAdmin } = useSession();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const location = useLocation();
  // Which sections are folded open; remembered per browser, and a section opens itself while you are inside it.
  const [sections, setSections] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}'); } catch { return {}; }
  });
  const setSection = (key: string, expanded: boolean) => setSections((s) => {
    const next = { ...s, [key]: expanded };
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: forget on reload */ }
    return next;
  });

  const meets = (requires?: Requirement): boolean =>
    requires === 'edit' ? canEdit : requires === 'viewAll' ? canViewAll : requires === 'admin' ? isAdmin : true;
  /** An item shows when its requirement is met; a section, when any of its sub-pages is reachable. */
  const allowed = (item: NavItem): boolean =>
    item.children ? item.children.some((child) => meets(child.requires ?? item.requires)) : meets(item.requires);

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-ink-900/30 lg:hidden" onClick={onClose} />}
      <aside className={cx(
        'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-ink-200 bg-white transition-[translate,visibility] lg:translate-x-0',
        // Closed on a phone it is also invisible, which takes it out of the tab order
        // and away from screen readers; sliding it off screen alone left it reachable.
        open ? 'translate-x-0' : '-translate-x-full max-lg:invisible',
      )}>
        {/* Brand + company switcher */}
        <div className="relative border-b border-ink-100 p-3">
          <button onClick={() => setSwitcherOpen((v) => !v)}
            className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-ink-50">
            <Logo className="size-8 shrink-0 text-brand-600" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-ink-900">
                {company?.name ?? PRODUCT}
              </span>
              <span className="block truncate text-[11px] text-ink-500 capitalize">
                {company ? company.role.toLowerCase() : config.brand.tagline}
              </span>
            </span>
            <Icon name="chevron" className="size-4 shrink-0 text-ink-400" />
          </button>

          {switcherOpen && (
            <div className="absolute left-3 right-3 top-full z-50 mt-1 rounded-lg border border-ink-200 bg-white py-1 shadow-xl animate-in">
              {companies.map((c) => (
                <button key={c.id} onClick={() => { selectCompany(c.id); setSwitcherOpen(false); }}
                  className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-ink-50',
                    c.id === company?.id && 'bg-brand-50/60 font-medium text-brand-700')}>
                  <Avatar name={c.name} size={20} />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
              <div className="my-1 border-t border-ink-100" />
              <NavLink to="/onboarding" onClick={() => setSwitcherOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink-600 hover:bg-ink-50">
                <Icon name="plus" className="size-4" /> New company
              </NavLink>
            </div>
          )}
        </div>

        <div className="px-3 pt-3"><SearchButton onClick={() => { onClose(); onSearch(); }} /></div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((group, gi) => {
            const items = group.items.filter(allowed);
            if (items.length === 0) return null;
            return (
              <div key={gi} className={cx(gi > 0 && 'mt-5')}>
                {group.label && (
                  <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {group.label}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const key = item.to ?? item.label;
                    const within = isWithin(item, location.pathname);
                    const children = (item.children ?? []).filter((child) => meets(child.requires ?? item.requires));
                    if (!item.children) {
                      return (
                        <li key={key}>
                          <NavLink to={item.to!} onClick={onClose} end={item.to === '/'}
                            className={({ isActive }) => cx(NAV_LINK, isActive || within ? NAV_ACTIVE : NAV_IDLE)}>
                            <Icon name={item.icon} className="size-4 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </NavLink>
                        </li>
                      );
                    }
                    // A section with a single reachable sub-page (for a portal-only role, say) is just that page.
                    if (!item.to && children.length === 1) {
                      const only = children[0];
                      return (
                        <li key={key}>
                          <NavLink to={only.to} onClick={onClose} end
                            className={({ isActive }) => cx(NAV_LINK, isActive ? NAV_ACTIVE : NAV_IDLE)}>
                            <Icon name={item.icon} className="size-4 shrink-0" />
                            <span className="truncate">{only.label}</span>
                          </NavLink>
                        </li>
                      );
                    }
                    // A section: the row opens its landing page when it has one, otherwise it folds; the chevron always folds.
                    const expanded = sections[key] ?? within;
                    const rowActive = (item.to != null && location.pathname === item.to) || (within && !expanded);
                    return (
                      <li key={key}>
                        <div className={cx(NAV_LINK, 'pr-1', rowActive ? NAV_ACTIVE : NAV_IDLE)}>
                          {item.to ? (
                            <NavLink to={item.to} onClick={() => { onClose(); setSection(key, true); }} className="flex min-w-0 flex-1 items-center gap-2.5">
                              <Icon name={item.icon} className="size-4 shrink-0" />
                              <span className="truncate">{item.label}</span>
                            </NavLink>
                          ) : (
                            <button type="button" onClick={() => setSection(key, !expanded)} aria-expanded={expanded}
                              className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                              <Icon name={item.icon} className="size-4 shrink-0" />
                              <span className="truncate">{item.label}</span>
                            </button>
                          )}
                          <button type="button" onClick={() => setSection(key, !expanded)} aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.label}`}
                            className="grid size-6 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                            <Icon name="chevron" className={cx('size-4 transition-transform', !expanded && '-rotate-90')} />
                          </button>
                        </div>
                        {expanded && (
                          <ul className="ml-[19px] mt-0.5 space-y-0.5 border-l border-ink-200 pl-2">
                            {children.map((child) => (
                              <li key={child.to}>
                                <NavLink to={child.to} onClick={onClose} end
                                  className={({ isActive }) => cx('block truncate rounded-md px-2 py-1 text-[13px] transition-colors',
                                    isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900')}>
                                  {child.label}
                                </NavLink>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* The person: their own equity, their preferences, and signing out. */}
        <div className="border-t border-ink-100 p-2">
          <AccountMenu onNavigate={onClose} />
        </div>
      </aside>
    </>
  );
}

function Shell() {
  const { user, loading, companies, canViewAll, isSample } = useSession();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { setOpen: setAssistantOpen } = useAssistantPanel();
  // On a phone the navigation drawer and the chat panel would sit on top of each other.
  const openNav = () => { setAssistantOpen(false); setNavOpen(true); };

  // ⌘K / Ctrl+K opens the search palette from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading) {
    return <div className="grid min-h-screen place-items-center"><Loading label="Loading your workspace" /></div>;
  }
  // The reset link from an email lands here signed out — and works while signed in too.
  if (pathname === '/reset-password') return <ResetPassword />;
  // A candidate's offer link works without an account.
  if (pathname.startsWith('/offer/')) return <OfferView />;
  // So does the valuation team's link to a 409A request, signed in or not.
  if (pathname === '/409a-desk') return <ValuationDesk />;
  if (!user) return <SignIn />;
  // Only while passwords are in use: with password sign-in off the gate could never be passed.
  if (user.mustChangePassword && config.auth.passwordSignIn) return <MustChangePasswordGate />;
  if (companies.length === 0) return <Onboarding />;

  return (
    <div className="min-h-screen">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} onSearch={() => setSearchOpen(true)} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <div className="min-h-screen bg-canvas lg:pl-60">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-ink-200 bg-white/85 px-4 backdrop-blur lg:hidden">
          <Button variant="ghost" size="sm" onClick={openNav} aria-label="Open navigation">
            <Icon name="menu" className="size-5" />
          </Button>
          <span className="text-sm font-semibold">{PRODUCT}</span>
          <button onClick={() => setSearchOpen(true)} aria-label="Search"
            className="ml-auto rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800">
            <Icon name="search" className="size-5" />
          </button>
        </header>
        {isSample && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-[13px] text-amber-900">
            This is the sample company. Explore every screen freely; its records cannot be changed.
          </div>
        )}
        {/* Room at the foot of every page, so the round assistant button never sits over its last row. */}
        <main className={cx('mx-auto max-w-[1600px] px-4 pt-6 sm:px-6 lg:px-8', canViewAll && config.ai.enabled ? 'pb-24' : 'pb-6')}>
          <Routes>
            {!canViewAll ? (
              // Employees and investors see their own equity and documents; the API refuses everything else.
              <>
                <Route path="/portal" element={<Portal />} />
                <Route path="/documents" element={<Documents />} />
                <Route path="/preferences" element={<Preferences />} />
                <Route path="*" element={<Navigate to="/portal" replace />} />
              </>
            ) : (
              <>
            <Route path="/" element={<Dashboard />} />
            <Route path="/cap-table" element={<CapTable />} />
            <Route path="/stakeholders" element={<Stakeholders />} />
            <Route path="/stakeholders/:id" element={<StakeholderDetail />} />
            <Route path="/share-classes" element={<ShareClasses />} />
            <Route path="/certificates" element={<Certificates />} />
            <Route path="/certificates/:id" element={<CertificateDetail />} />
            <Route path="/grants" element={<Grants />} />
            <Route path="/grants/:id" element={<AwardDetail />} />
            <Route path="/offers" element={<Offers />} />
            <Route path="/convertibles" element={<Convertibles />} />
            <Route path="/convertibles/:id" element={<ConvertibleDetail />} />
            <Route path="/warrants" element={<Warrants />} />
            <Route path="/warrants/:id" element={<WarrantDetail />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/valuations" element={<Navigate to="/compliance/409a" replace />} />
            <Route path="/valuations/:id" element={<ValuationDetail />} />
            <Route path="/model/round" element={<ModelRound />} />
            <Route path="/model/exit" element={<ModelExit />} />
            <Route path="/compliance/:tab?" element={<Compliance />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/updates" element={<Updates />} />
            <Route path="/tools/calculator" element={<Calculator />} />
            {/* The assistant is a panel now, not a page: an old link opens it over the overview. */}
            {config.ai.enabled && <Route path="/assistant" element={<OpenAssistant />} />}
            <Route path="/consents" element={<Consents />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/reports/builder" element={<ReportBuilder />} />
            <Route path="/stock-comp" element={<StockComp />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/portal" element={<Portal />} />
            <Route path="/preferences" element={<Preferences />} />
            <Route path="/company" element={<Company />} />
            <Route path="/team" element={<Team />} />
            <Route path="/settings" element={<Navigate to="/company" replace />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/import" element={<ImportData />} />
            <Route path="*" element={<Navigate to="/" replace />} />
              </>
            )}
          </Routes>
        </main>
      </div>
      <AssistantLauncher />
    </div>
  );
}

/** Where the assistant page used to be: opens the chat panel and shows the overview behind it. */
function OpenAssistant() {
  const { setOpen } = useAssistantPanel();
  useEffect(() => { setOpen(true); }, [setOpen]);
  return <Navigate to="/" replace />;
}

export default function App() {
  return <SessionProvider><AssistantPanelProvider><Shell /></AssistantPanelProvider></SessionProvider>;
}
