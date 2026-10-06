/**
 * Global search (⌘K / Ctrl+K): one box that finds pages, workflows, settings
 * and the company's records. Pages, actions and settings are matched here in
 * the browser; records come from GET /c/:cid/search, which applies the
 * member's visibility rules.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from './session.tsx';
import { api } from './api.ts';
import { cx } from './ui.tsx';
import { Icon, type IconName } from './icons.tsx';
import { NAV, type Requirement } from './nav.ts';
import { useAssistantPanel } from './assistant/shared.tsx';
import { config, PRODUCT } from './config.ts';

export interface SearchEntry {
  id: string;
  /** Section heading in the results list. */
  group: string;
  title: string;
  subtitle?: string;
  /** Other words people use for it; matched after the title. */
  keywords: string[];
  icon: IconName;
  to?: string;
  run?: 'signOut' | 'openAssistant';
  requires?: Requirement;
}

interface SearchHit { kind: string; id: string; title: string; subtitle: string | null; label?: string | null; stakeholderId?: string | null }

// ---------------------------------------------------------------------------
// What can be found without asking the server
// ---------------------------------------------------------------------------

/** Extra words people use for a page, beyond its label. */
const PAGE_KEYWORDS: Record<string, string[]> = {
  '/': ['dashboard', 'home', 'summary', 'overview'],
  '/cap-table': ['captable', 'ownership', 'fully diluted', 'shareholders', 'percentages', 'dilution'],
  '/stakeholders': ['people', 'holders', 'employees', 'investors', 'advisors', 'shareholders', 'entities'],
  '/share-classes': ['common', 'preferred', 'series', 'liquidation preference', 'seniority', 'anti-dilution'],
  '/certificates': ['shares', 'issuances', 'stock certificates', 'certificate book', 'legends'],
  '/grants': ['options', 'rsu', 'iso', 'nso', 'awards', 'grants', 'vesting', 'exercise', 'strike price'],
  '/offers': ['offer letters', 'candidates', 'hiring', 'job offer', 'recruiting'],
  '/convertibles': ['safe', 'safes', 'notes', 'convertible notes', 'fundraising', 'pre-seed', 'seed', 'valuation cap'],
  '/warrants': ['warrants', 'lender', 'bank'],
  '/plans': ['equity plan', 'option pool', 'pool', 'vesting schedules', 'reserve', 'cliff'],
  '/model/round': ['round modeling', 'priced round', 'series a', 'dilution', 'pro forma', 'scenario', 'pre-money', 'post-money'],
  '/model/exit': ['exit', 'waterfall', 'acquisition', 'payout', 'liquidation', 'sale'],
  '/tools/calculator': ['calculator', 'share value', 'what is my equity worth', 'ownership percentage'],
  '/compliance': ['409a', '83b', 'form 3921', 'rule 701', 'iso 100k', 'boi', 'fincen', 'findings', 'checks', 'tax'],
  '/compliance/409a': ['409a', 'valuation', 'fmv', 'fair market value', 'strike price', 'appraisal', 'record a valuation'],
  '/compliance/iso-100k': ['iso', '100k', 'limit', 'incentive stock option', 'test'],
  '/compliance/rule-701': ['rule 701', '701', 'securities exemption', 'sec', 'compensatory'],
  '/compliance/83b': ['83b', '83(b)', 'election', 'restricted stock', 'irs', 'tax', '30 days', 'election letter'],
  '/compliance/form-3921': ['3921', 'form 3921', 'iso exercise', 'irs', 'tax form', 'employee statement'],
  '/compliance/boi': ['boi', 'beneficial ownership', 'fincen', 'corporate transparency act', 'cta', 'filing'],
  '/documents': ['files', 'agreements', 'signatures', 'e-sign', 'pdf', 'upload', 'data room'],
  '/templates': ['document templates', 'agreement templates', 'merge fields', 'option agreement', 'offer letter template'],
  '/updates': ['investor updates', 'newsletter', 'read receipts', 'communications'],
  '/consents': ['board consents', 'approvals', 'votes', 'stockholder approval', 'resolutions', 'directors'],
  '/ledger': ['transactions', 'journal', 'history of changes'],
  '/reports': ['reports', 'exports', 'csv', 'excel', 'download'],
  '/stock-comp': ['asc 718', 'ifrs 2', 'stock comp', 'expense', 'accounting', 'black-scholes'],
  '/audit': ['audit log', 'who changed what', 'activity', 'history'],
  '/import': ['import', 'upload spreadsheet', 'excel', 'csv', 'pulley', 'carta', 'migration'],
  '/team': ['team', 'members', 'roles', 'access', 'permissions', 'invite', 'lawyer', 'accountant'],
  '/company': ['settings', 'company settings', 'preferences', 'configuration', 'company details', 'company profile', 'legal name', 'entity type', 'jurisdiction', 'delaware', 'incorporation date', 'fiscal year', 'ein', 'employer identification', 'website', 'address', 'signatories', 'signatory', 'board members', 'directors', 'contacts', 'counsel', 'accountant'],
};

const PAGES: SearchEntry[] = NAV.flatMap((group) => group.items.flatMap((item): SearchEntry[] => [
  ...(item.to ? [{
    id: `page:${item.to}`, group: 'Pages', title: item.label, subtitle: group.label ? `${group.label} page` : 'Page',
    keywords: PAGE_KEYWORDS[item.to] ?? [], icon: item.icon, to: item.to, requires: item.requires,
  }] : []),
  ...(item.children ?? []).filter((child) => child.to !== item.to).map((child) => ({
    id: `page:${child.to}`, group: 'Pages', title: `${item.label} › ${child.label}`, subtitle: `${item.label} section`,
    keywords: PAGE_KEYWORDS[child.to] ?? [], icon: item.icon, to: child.to, requires: child.requires ?? item.requires,
  })),
]));

/** Workflows: each lands on the page where the work starts, with the form open where the page supports it. */
const ACTIONS: SearchEntry[] = ([
  { id: 'new-grant', title: 'Issue an equity award', subtitle: 'Options or RSUs from a plan, with board approval and e-signature', keywords: ['grant', 'option', 'iso', 'nso', 'rsu', 'stock option', 'new grant', 'issue options', 'award', 'hire', 'onboard'], to: '/grants?new=1', icon: 'award', requires: 'edit' },
  { id: 'new-offer', title: 'Send an offer letter', subtitle: 'An equity package a candidate accepts online', keywords: ['offer', 'candidate', 'hire', 'recruit', 'job offer', 'equity package'], to: '/offers', icon: 'target', requires: 'edit' },
  { id: 'new-safe', title: 'Issue a SAFE or convertible note', subtitle: 'Batch issuance for signature with funds tracking', keywords: ['safe', 'note', 'convertible', 'fundraising', 'investor', 'raise', 'pre-seed', 'seed', 'mfn', 'valuation cap', 'discount'], to: '/convertibles', icon: 'convert', requires: 'edit' },
  { id: 'new-certificate', title: 'Issue shares and a certificate', subtitle: 'Record a share issuance for a stakeholder', keywords: ['certificate', 'issue shares', 'common', 'preferred', 'stock certificate', 'issuance', 'founder shares'], to: '/certificates', icon: 'certificate', requires: 'edit' },
  { id: 'new-stakeholder', title: 'Add a stakeholder', subtitle: 'An employee, investor, advisor or entity', keywords: ['stakeholder', 'employee', 'investor', 'person', 'add person', 'shareholder', 'holder', 'advisor', 'new hire'], to: '/stakeholders', icon: 'users', requires: 'edit' },
  { id: 'new-share-class', title: 'Create a share class', subtitle: 'Common or preferred, with its liquidation terms', keywords: ['share class', 'preferred', 'series a', 'seniority', 'liquidation preference', 'participation', 'anti-dilution'], to: '/share-classes', icon: 'layers', requires: 'edit' },
  { id: 'new-plan', title: 'Create an equity plan or option pool', subtitle: 'Reserve shares for awards and set vesting schedules', keywords: ['plan', 'pool', 'option pool', 'stock plan', 'reserve', 'vesting schedule', 'cliff', 'increase pool'], to: '/plans', icon: 'calendar', requires: 'edit' },
  { id: 'new-warrant', title: 'Issue a warrant', keywords: ['warrant', 'warrants', 'strike', 'bank', 'lender', 'venture debt'], to: '/warrants', icon: 'ticket', requires: 'edit' },
  { id: 'model-round', title: 'Model a priced round', subtitle: 'Pre-money, new investors, pool shuffle and SAFE conversion', keywords: ['round', 'series a', 'model', 'scenario', 'dilution', 'pre-money', 'post-money', 'pro forma', 'fundraise', 'term sheet'], to: '/model/round', icon: 'trending', requires: 'viewAll' },
  { id: 'model-exit', title: 'Run an exit waterfall', subtitle: 'Who gets what at a given sale price', keywords: ['exit', 'waterfall', 'acquisition', 'liquidation', 'payout', 'sale', 'm&a', 'proceeds'], to: '/model/exit', icon: 'waterfall', requires: 'viewAll' },
  { id: 'import', title: 'Import data from a spreadsheet', subtitle: 'Cap table, grants or stakeholders from Excel, CSV or a Pulley export', keywords: ['import', 'upload', 'spreadsheet', 'excel', 'csv', 'xlsx', 'pulley', 'carta', 'migrate', 'migration'], to: '/import', icon: 'inbox', requires: 'edit' },
  { id: 'new-update', title: 'Send an investor update', subtitle: 'A company update with read receipts', keywords: ['investor update', 'newsletter', 'update', 'announce', 'email investors', 'read receipts'], to: '/updates', icon: 'megaphone', requires: 'edit' },
  { id: 'new-consent', title: 'Start a board or stockholder consent', subtitle: 'Approve grants, rounds or other actions by written consent', keywords: ['board', 'consent', 'approval', 'vote', 'stockholder', 'resolution', 'directors', 'unanimous written consent'], to: '/consents', icon: 'gavel', requires: 'edit' },
  { id: 'report-builder', title: 'Build a custom report', subtitle: 'Pick columns and filters, export CSV or Excel', keywords: ['report', 'export', 'csv', 'excel', 'xlsx', 'custom report', 'builder', 'download', 'columns'], to: '/reports/builder', icon: 'download', requires: 'viewAll' },
  { id: 'exercise-requests', title: 'Review exercise requests', subtitle: 'Approve, record payment and complete exercises holders asked for', keywords: ['exercise', 'request', 'approve exercise', 'payment', 'cashless', 'net exercise'], to: '/grants#exercise-requests', icon: 'award', requires: 'viewAll' },
  { id: 'stock-comp', title: 'Stock-based compensation expense', subtitle: 'ASC 718 / IFRS 2 report', keywords: ['asc 718', 'ifrs 2', 'expense', 'stock comp', 'black-scholes', 'accounting'], to: '/stock-comp', icon: 'scale', requires: 'viewAll' },
  { id: 'print-certificates', title: 'Print the certificate book', keywords: ['print', 'certificate book', 'pdf', 'legends'], to: '/certificates', icon: 'certificate', requires: 'viewAll' },
  { id: 'templates', title: 'Edit document templates', subtitle: 'Option agreements, certificates, offer letters, SAFE agreements', keywords: ['template', 'agreement', 'merge fields', 'document template', 'legal'], to: '/templates', icon: 'copy', requires: 'edit' },
  { id: 'invite', title: 'Invite a team member or change roles', keywords: ['invite', 'team', 'member', 'role', 'access', 'permission', 'admin', 'legal', 'board', 'viewer', 'lawyer', 'accountant'], to: '/team', icon: 'badge', requires: 'admin' },
  { id: 'my-equity', title: 'View my equity', subtitle: 'Your grants, vesting and documents', keywords: ['my equity', 'portal', 'portfolio', 'vesting', 'my grants', 'my shares', 'my documents', 'exercise'], to: '/portal', icon: 'wallet' },
  // The assistant is offered only while ai.enabled is on in kosmitor.config.json.
  ...(config.ai.enabled ? [
    { id: 'assistant', title: 'Ask the assistant', subtitle: 'Questions about this cap table, answered by a language model', keywords: ['assistant', 'ai', 'chat', 'ask', 'question', 'llm', 'model'], run: 'openAssistant', icon: 'chat', requires: 'viewAll' },
    { id: 'assistant-settings', title: 'Assistant model and API key', subtitle: 'In your preferences, and used in every company', keywords: ['assistant', 'api key', 'model', 'provider', 'ai settings', 'openai', 'anthropic'], to: '/preferences#assistant', icon: 'settings', requires: 'viewAll' },
  ] : []),
  { id: 'preferences', title: 'Open my preferences', subtitle: 'Your name, colour, password and how pages open', keywords: ['preferences', 'settings', 'profile', 'my account', 'name', 'colour', 'color', 'avatar', 'password', 'explanations'], to: '/preferences', icon: 'settings' },
  { id: 'new-company', title: 'Create another company', keywords: ['new company', 'workspace', 'onboarding', 'create company', 'add company'], to: '/onboarding', icon: 'plus' },
  { id: 'sign-out', title: 'Sign out', keywords: ['sign out', 'log out', 'logout', 'exit'], run: 'signOut', icon: 'signout' },
] as Omit<SearchEntry, 'group'>[]).map((a) => ({ ...a, group: 'Actions' }));

/** Every card on the Settings page, reachable by its hash. */
const SETTINGS: SearchEntry[] = ([
  { id: 'settings-compliance', title: 'Compliance inputs', subtitle: 'Figures the automated checks rely on', keywords: ['total assets', 'compliance inputs', 'rule 701 assets'], to: '/company#compliance' },
  { id: 'settings-certificates', title: 'Certificate terms and legends', keywords: ['certificate terms', 'legend', 'legends', 'restrictions', 'printed on certificates'], to: '/company#certificates' },
  { id: 'settings-portal', title: 'Stakeholder portal visibility', subtitle: 'What holders see on My equity: ownership, FMV values, exit model, documents, updates', keywords: ['portal', 'visibility', 'what employees see', 'show ownership', 'fully diluted', '409a values', 'exit model', 'documents', 'updates', 'holder view', 'my equity', 'hide'], to: '/company#portal' },
  { id: 'settings-exercise', title: 'Exercise requests and payment instructions', keywords: ['exercise requests', 'accept requests', 'payment instructions', 'wire', 'exercise', 'bank details'], to: '/company#exercise-requests' },
  { id: 'settings-stock-comp', title: 'Stock-based compensation assumptions', subtitle: 'Volatility, risk-free rate, dividend yield, expected term, attribution, forfeitures, standard', keywords: ['volatility', 'risk-free', 'dividend yield', 'expected term', 'attribution', 'forfeiture', 'asc 718', 'ifrs 2', 'black-scholes', 'assumptions', 'gaap'], to: '/company#stock-comp' },
  { id: 'settings-delete', title: 'Delete this company', subtitle: 'Removes the cap table, documents, ledger and audit trail for good', keywords: ['delete company', 'remove company', 'danger', 'wipe', 'close account'], to: '/company#delete' },
] as { id: string; title: string; subtitle?: string; keywords: string[]; to: string }[]).map((s) => ({ ...s, group: 'Company settings', icon: 'settings' as IconName, requires: 'admin' as Requirement }));

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokensOf = (q: string): string[] => norm(q).split(/\s+/).filter(Boolean);

/** How well an entry answers the query; 0 when any word of the query is missing from it. */
function score(entry: SearchEntry, tokens: string[], phrase: string): number {
  const title = norm(entry.title);
  const words = title.split(/[\s/&(),-]+/);
  const keywords = entry.keywords.map(norm);
  const subtitle = norm(entry.subtitle ?? '');
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    if (title.startsWith(t)) best = 6;
    else if (words.some((w) => w.startsWith(t))) best = 5;
    else if (title.includes(t)) best = 4;
    else if (keywords.some((k) => k === t || k.startsWith(t))) best = 3;
    else if (keywords.some((k) => k.split(' ').some((w) => w.startsWith(t)))) best = 2.5;
    else if (keywords.some((k) => k.includes(t))) best = 2;
    else if (subtitle.includes(t)) best = 1;
    if (!best) return 0;
    total += best;
  }
  if (phrase && title.includes(phrase)) total += 2;
  return total;
}

/** Where each kind of record opens, and under which heading it is listed. */
const RECORDS: Record<string, { group: string; icon: IconName; to: (h: SearchHit) => string }> = {
  stakeholder: { group: 'Stakeholders', icon: 'users', to: (h) => `/stakeholders/${h.id}` },
  award: { group: 'Equity awards', icon: 'award', to: (h) => `/grants?q=${encodeURIComponent(h.label ?? h.title)}` },
  certificate: { group: 'Certificates', icon: 'certificate', to: (h) => `/certificates?q=${encodeURIComponent(h.label ?? h.title)}` },
  convertible: { group: 'SAFEs & notes', icon: 'convert', to: (h) => (h.stakeholderId ? `/stakeholders/${h.stakeholderId}` : '/convertibles') },
  offer: { group: 'Offer letters', icon: 'target', to: (h) => `/offers?q=${encodeURIComponent(h.label ?? h.title)}` },
  document: { group: 'Documents', icon: 'document', to: (h) => `/documents?q=${encodeURIComponent(h.label ?? h.title)}` },
  update: { group: 'Investor updates', icon: 'megaphone', to: () => '/updates' },
  consent: { group: 'Board consents', icon: 'gavel', to: () => '/consents' },
  share_class: { group: 'Share classes', icon: 'layers', to: () => '/share-classes' },
  pool: { group: 'Plans & vesting', icon: 'calendar', to: () => '/plans' },
  template: { group: 'Templates', icon: 'copy', to: () => '/templates' },
  saved_report: { group: 'Saved reports', icon: 'download', to: () => '/reports/builder' },
};

function toEntry(h: SearchHit): SearchEntry {
  const meta = RECORDS[h.kind] ?? { group: 'Records', icon: 'document' as IconName, to: () => '/' };
  return { id: `${h.kind}:${h.id}`, group: meta.group, title: h.title, subtitle: h.subtitle ?? undefined, keywords: [], icon: meta.icon, to: meta.to(h) };
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { companyId, canEdit, canViewAll, isAdmin, signOut } = useSession();
  const { setOpen: openAssistant } = useAssistantPanel();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<SearchEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const catalogue = useMemo(() => {
    const allowed = (e: SearchEntry): boolean =>
      e.requires === 'edit' ? canEdit : e.requires === 'viewAll' ? canViewAll : e.requires === 'admin' ? isAdmin : true;
    return [...PAGES, ...ACTIONS, ...SETTINGS].filter(allowed);
  }, [canEdit, canViewAll, isAdmin]);

  const tokens = useMemo(() => tokensOf(q), [q]);
  const matches = useMemo<SearchEntry[]>(() => {
    if (tokens.length === 0) {
      // Nothing typed yet: a few places to jump to and the most common workflows.
      return [...catalogue.filter((e) => e.group === 'Pages').slice(0, 6), ...catalogue.filter((e) => e.group === 'Actions').slice(0, 5)];
    }
    const phrase = norm(q.trim());
    return catalogue.map((e) => ({ e, s: score(e, tokens, phrase) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title)).slice(0, 14).map((x) => x.e);
  }, [catalogue, tokens, q]);

  // Records come from the API a moment after typing pauses.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2 || !companyId) { setRecords([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ results: SearchHit[] }>(`/c/${companyId}/search?q=${encodeURIComponent(query)}`)
        .then((r) => { if (!cancelled) setRecords(r.results.map(toEntry)); })
        .catch(() => { if (!cancelled) setRecords([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, open, companyId]);

  // One flat, keyboard-navigable list, grouped under section headings in ranked order of first appearance.
  const items = useMemo(() => {
    const grouped = new Map<string, SearchEntry[]>();
    for (const e of [...matches, ...records]) {
      const list = grouped.get(e.group);
      if (list) list.push(e); else grouped.set(e.group, [e]);
    }
    return [...grouped.values()].flat();
  }, [matches, records]);

  useEffect(() => {
    if (!open) return;
    setQ(''); setRecords([]); setActive(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { clearTimeout(timer); document.body.style.overflow = previous; };
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  const select = (entry: SearchEntry) => {
    onClose();
    if (entry.run === 'signOut') { void signOut(); return; }
    if (entry.run === 'openAssistant') { openAssistant(true); return; }
    if (entry.to) navigate(entry.to);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (items.length ? (i + 1) % items.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const entry = items[active]; if (entry) select(entry); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  if (!open) return null;

  const sections: { group: string; items: { entry: SearchEntry; index: number }[] }[] = [];
  items.forEach((entry, index) => {
    const last = sections[sections.length - 1];
    if (last && last.group === entry.group) last.items.push({ entry, index });
    else sections.push({ group: entry.group, items: [{ entry, index }] });
  });
  const typed = q.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh] sm:pt-[14vh]" role="dialog" aria-modal="true" aria-label={`Search ${PRODUCT}`}>
      <div className="fixed inset-0 bg-ink-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-clip rounded-xl border border-ink-200/70 bg-white shadow-2xl animate-in">
        <div className="flex items-center gap-2.5 border-b border-ink-100 px-4">
          <Icon name="search" className="size-4 shrink-0 text-ink-400" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search pages, actions, settings, people, grants, documents…" aria-label="Search"
            autoComplete="off" spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400" />
          {searching && <span className="shrink-0 text-[11px] text-ink-400">Searching…</span>}
          <Key>esc</Key>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-ink-500">
              {typed.length < 2 && companyId
                ? 'Keep typing to search people, grants and documents.'
                : <>No matches for “{typed}”. Try a page name, a person, a grant number or a document.</>}
            </p>
          ) : sections.map((section) => (
            <div key={section.group} className="px-2 pb-1">
              <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">{section.group}</p>
              {section.items.map(({ entry, index }) => (
                <button key={entry.id} type="button" data-index={index} onMouseEnter={() => setActive(index)} onClick={() => select(entry)}
                  className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                    index === active ? 'bg-brand-50 text-brand-700' : 'text-ink-800 hover:bg-ink-50')}>
                  <span className={cx('grid size-7 shrink-0 place-items-center rounded-md', index === active ? 'bg-white text-brand-600' : 'bg-ink-100 text-ink-500')}>
                    <Icon name={entry.icon} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{entry.title}</span>
                    {entry.subtitle && (
                      <span className={cx('block truncate text-[12px]', index === active ? 'text-brand-700/80' : 'text-ink-500')}>{entry.subtitle}</span>
                    )}
                  </span>
                  {index === active && <Key>↵</Key>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-ink-100 bg-ink-50/60 px-4 py-2 text-[11px] text-ink-500">
          <span><Key>↑</Key> <Key>↓</Key> move</span>
          <span><Key>↵</Key> open</span>
          <span><Key>esc</Key> close</span>
          <span className="ml-auto hidden sm:inline">⌘K or Ctrl+K from anywhere</span>
        </div>
      </div>
    </div>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-200 bg-white px-1.5 py-0.5 font-sans text-[10px] text-ink-500">{children}</kbd>;
}

/** The sidebar's search field look-alike; opens the palette. */
export function SearchButton({ onClick }: { onClick: () => void }) {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
  return (
    <button type="button" onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-ink-200 bg-canvas px-2.5 py-1.5 text-left text-[13px] text-ink-500 transition-colors hover:border-ink-300 hover:text-ink-700">
      <Icon name="search" className="size-4" />
      <span className="flex-1">Search…</span>
      <kbd className="rounded border border-ink-200 bg-white px-1.5 font-sans text-[10px] text-ink-500">{mac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}
