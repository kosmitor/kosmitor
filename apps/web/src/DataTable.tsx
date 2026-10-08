/**
 * The app's tables, drawn the way the cap table is drawn.
 *
 * A table sits in a card whose header row holds, from left to right: the table's
 * title, if it has one; the page's own controls for it (filters, a date, a view
 * switch); a search box that takes up the room left over; the page's action
 * buttons; and the Full size button, which lays the table over the whole window.
 * The row wraps where it is short of room, and on a phone the search box moves
 * down a line rather than be squeezed beside a filter. Headings sort their
 * column (an arrow says which way, and aria-sort tells a screen reader); the
 * first column stays in view while a wide table scrolls sideways, from small
 * screens up, and so do a row's actions at the other end; a totals row stays at
 * the foot, and in the full size view stays in sight while the rows scroll under
 * it. Rows, cells and numbers are the shared Table, TH, TD and TR from ui.tsx, so
 * a short name, label or status is never broken over two lines, in any column.
 *
 * Most pages need only <DataTable>: a list of columns and the rows. A table whose
 * rows are not one per record (the cap table, with its class breakdown under each
 * holder and the unallocated pool after them) builds the same thing from the
 * parts further down, TableCard, TableToolbar, TableSearch, TableScroll, SortTH
 * and the cell classes, and looks the same for it. Small tables inside a form or
 * a dialog use frame="box": the same rows and headings, in a plain border, with
 * no search and no full size.
 *
 * A plain list. The rows keep the order they are given until someone sorts a
 * column; the table searches itself, by the words `by` returns for each row:
 *
 *   <DataTable caption="Audit log" rows={entries} rowKey={(a) => a.id}
 *     search={{ placeholder: 'Search by person, action or detail', by: (a) => [a.userName, a.action, a.detail] }}
 *     empty={<EmptyState title="Nothing logged yet" />}
 *     columns={[
 *       { key: 'when', label: 'When', type: 'date', value: (a) => a.createdAt, cell: (a) => dateTime(a.createdAt),
 *         className: 'whitespace-nowrap text-ink-600' },
 *       { key: 'who', label: 'Who', value: (a) => a.userName ?? 'System' },
 *       { key: 'detail', label: 'Detail', value: (a) => a.detail, className: 'max-w-lg text-[12px]' },
 *     ]} />
 *
 * Filters in the header row. The page keeps its filter and its search, as it did
 * before, and hands over the rows it has already narrowed; the search box only
 * shows the query and reports changes. Totals go on the columns, and the first
 * column's cell in that row says "Total":
 *
 *   <DataTable caption="Stakeholders" className="mb-5" rows={rows} rowKey={(s) => s.id}
 *     controls={<SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />}
 *     search={{ value: search, onChange: setSearch, placeholder: 'Search by name or email' }}
 *     actions={<Button icon={<Icon name="download" />} onClick={exportCsv}>Export</Button>}
 *     empty={<EmptyState title="No stakeholders match" description="Adjust the filter or add someone new." />}
 *     columns={[
 *       { key: 'name', label: 'Name', value: (s) => s.name,
 *         cell: (s) => <Link to={`/stakeholders/${s.id}`} className="font-medium hover:text-brand-700">{s.name}</Link> },
 *       { key: 'started', label: 'Started', type: 'date', value: (s) => s.startDate },
 *       { key: 'diluted', label: 'Fully diluted', type: 'number', value: (s) => positionOf.get(s.id)?.fullyDiluted,
 *         total: shares(totalDiluted) },
 *       { key: 'actions', label: '', width: 90, hidden: !canEdit, cell: (s) => <RowActions stakeholder={s} /> },
 *     ]} />
 *
 * A small table in a form or a dialog:
 *
 *   <DataTable frame="box" caption="Rows to import" rows={preview} rowKey={(r) => r.row}
 *     columns={[
 *       { key: 'row', label: 'Row', type: 'number', width: 60, value: (r) => r.row, cell: (r) => r.row },
 *       { key: 'holder', label: 'Holder', value: (r) => r.holder },
 *       { key: 'shares', label: 'Shares', type: 'number', value: (r) => r.shares },
 *     ]} />
 *
 * A column with a `value` sorts; one without (row actions) does not. The first
 * click sorts ascending, the next descending; blanks (no value, a dash on screen)
 * stay at the bottom either way, and rows that tie keep the order they were
 * given. Until someone sorts, the rows are in the order given, so a page moving
 * onto DataTable keeps its order by leaving `defaultSort` out; give one only
 * when the page already opens in that order (the cap table opens largest
 * first). While a sort is on a column that is hidden, the table goes back to
 * its opening order. Rows that `pinBottom` picks (a reserve, a line of totals
 * kept among the rows) stay after the others whatever the sort. A page whose
 * order is its own (a report, sorted where it is run) passes `sort` and
 * `onSort`: the headings show and change the page's order, and the rows are
 * drawn as given. Without a `cell`, a cell shows its value: a number with
 * grouping, money (in cents) as money, a price per share (in micro-cents) as a
 * price, a date as a date, a blank as a dash.
 *
 * A row that needs a reader's eye (an error, a missed deadline, the current
 * valuation) takes a tint from `rowTone`, and its first cell, which the others
 * scroll under, the same tint made opaque. A column the window has no room for
 * below a breakpoint is left out there with `hideBelow`, heading and cells.
 *
 * With no rows at all, `empty` (an EmptyState, say) takes the table's place
 * under the header row, so the filters that emptied it stay in reach; the Full
 * size button, and a search box the table keeps itself, wait until there is
 * something to enlarge or to search. A note on what the rows are goes in
 * `before`, between the header row and the table, and one on the figures in
 * `after`, under it. A long table can scroll under its headings within the page
 * (`maxHeight`), as a sheet's rows do in the import's review. The full size
 * view (z-[45]) covers the app's header (z-20, AppHeader.tsx) and the sidebar
 * (z-40), and is on the dialogs' stack (ui.tsx), so a row's dialog opens over
 * it and Escape closes the dialog first; pinned headings (z-[15]) stay under the
 * app's header. A page that wants a menu of switches in the header row, like
 * the cap table's Options, has OptionsMenu in CapTableToolbar.tsx.
 */
import { createContext, Fragment, memo, useContext, useDeferredValue, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Card, SearchInput, Table, TD, TH, TR, cx, enterLayer, isNewestLayer, leaveLayer, useLayerPlace } from './ui.tsx';
import { SortTH, sortRows, type Sort, type SortDirection } from './sortable.tsx';
import { date, money, pps, shares } from './format.ts';

// ---------------------------------------------------------------------------
// Full size
// ---------------------------------------------------------------------------

/** Four arrows pointing out, or in when the view is already full size. */
function FullSizeIcon({ exit }: { exit: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={exit
        ? 'M9.5 4.5v5h-5M14.5 4.5v5h5M9.5 19.5v-5h-5M14.5 19.5v-5h5'
        : 'M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5'} />
    </svg>
  );
}

/**
 * The button that opens or closes the full size view. Its words show on wide
 * screens; where the toolbar is short of room it is the icon alone, named for
 * screen readers and with the same words on hover. TableToolbar draws it for a
 * table that has a full size view, so a page never places it itself.
 */
export function FullSizeButton({ full, onClick }: { full: boolean; onClick: () => void }) {
  const text = full ? 'Exit full size' : 'Full size';
  return (
    <Button icon={<FullSizeIcon exit={full} />} onClick={onClick} aria-label={text} title={text}
      data-full-size={full ? 'exit' : 'enter'} className="ml-auto max-[1439px]:w-9 max-[1439px]:px-0">
      <span className="hidden min-[1440px]:inline">{text}</span>
    </Button>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/**
 * Lays its children over the whole window, as a dialog. Escape closes it unless
 * something has taken the key first: the calendar or a menu inside it, a row's
 * menu (drawn at the end of the page, with focus in it), or a dialog opened over
 * it from a row, which is newer on the dialogs' stack (ui.tsx) and so closes
 * alone. Tab goes round inside it rather than into the page hidden behind; the
 * page behind does not scroll while it is open, and is let go only when the last
 * of it and the dialogs over it has closed, in whatever order. It sits over the
 * app's header (z-20) and the sidebar (z-40), and under the search palette and
 * the dialogs (z-50 and up), which may open on top of it.
 */
export function FullSize({ open, onClose, label, children }: {
  open: boolean; onClose: () => void; label: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [id] = useState(() => Symbol('full size'));
  const place = useLayerPlace(id);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    enterLayer(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !isNewestLayer(id)) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const root = ref.current;
    (root?.querySelector<HTMLElement>('[data-full-size="exit"]') ?? root)?.focus({ preventScroll: true });
    return () => { document.removeEventListener('keydown', onKey); leaveLayer(id); };
  }, [open, id]);

  const keepTabInside = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const stops = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (!open) return null;
  // Opened over a dialog (a table in one), it goes above that dialog, and while a
  // dialog is open over it, it stays drawn but out of reach, as a dialog under another does.
  const covered = place >= 0 && !Number.isInteger(place);
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={keepTabInside}
      inert={covered || undefined} style={{ zIndex: place >= 1 ? 50 + Math.floor(place) : 45 }}
      className="fixed inset-0 flex flex-col bg-canvas p-2 outline-none sm:p-4">
      {children}
    </div>,
    document.body,
  );
}

/** Whether a table is being drawn in its full size view, and how to switch (null: it has none). */
const FullSizeContext = createContext<{ full: boolean; toggle: (() => void) | null }>({ full: false, toggle: null });

/** True inside the full size view: the table fills the window, scrolls under its own headings, and keeps its totals in sight. */
export const useFullSize = (): boolean => useContext(FullSizeContext).full;

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * The card a table sits in, and its full size view. `children` is called once
 * for the card and, while it is open, once more for the full size view, with
 * `full` saying which; the parts below read it for themselves, so it matters
 * only to cells that change with it (totalCell). While the table is full size,
 * the place it left keeps its height, so the page behind does not jump, and
 * focus goes back to the Full size button on leaving.
 *
 * frame: 'card' (a card on the page, the default), 'box' (a plain border, for a
 * table inside a form or a dialog) or 'none' (the page draws the frame).
 */
export function TableCard({ children, fullSize, frame = 'card', className }: {
  children: (full: boolean) => ReactNode;
  /** The full size view's name for screen readers ("Cap table, full size"). Without it there is no Full size button. */
  fullSize?: string;
  frame?: 'card' | 'box' | 'none';
  /** On the table's place in the page (margins, mostly). */
  className?: string;
}) {
  const [full, setFull] = useState(false);
  const [placeHeight, setPlaceHeight] = useState(0);
  const place = useRef<HTMLDivElement>(null);
  const open = () => { setPlaceHeight(place.current?.offsetHeight ?? 0); setFull(true); };
  const close = () => setFull(false);
  const wasFull = useRef(false);
  useEffect(() => {
    if (wasFull.current && !full) place.current?.querySelector<HTMLElement>('[data-full-size="enter"]')?.focus({ preventScroll: true });
    wasFull.current = full;
  }, [full]);

  const inPage = !full && (frame === 'card' ? <Card padded={false}>{children(false)}</Card>
    : frame === 'box' ? <div className="min-w-0 overflow-clip rounded-lg border border-ink-200 bg-white">{children(false)}</div>
    : children(false));
  return (
    <>
      <FullSizeContext.Provider value={{ full: false, toggle: fullSize ? open : null }}>
        <div ref={place} className={className} style={full ? { height: placeHeight } : undefined}>{inPage}</div>
      </FullSizeContext.Provider>
      {fullSize && (
        <FullSize open={full} onClose={close} label={fullSize}>
          <FullSizeContext.Provider value={{ full: true, toggle: close }}>
            <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-xl border border-ink-200/70 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)]">
              {children(true)}
            </div>
          </FullSizeContext.Provider>
        </FullSize>
      )}
    </>
  );
}

/**
 * The card's header row: the title, then the page's own controls in the order
 * given, then the Full size button when the card has a full size view, at the
 * right. It wraps where it is short of room. A TableSearch among the children
 * takes the room left over, and on a phone moves down a line rather than be
 * squeezed; without one, put a spacer (<span className="flex-1" />) before
 * anything that belongs on the right. The title is a card's title, as
 * CardHeader's is (h3).
 */
export function TableToolbar({ title, subtitle, children, fullSizeButton = true }: {
  title?: ReactNode; subtitle?: ReactNode; children?: ReactNode;
  /** False leaves out the Full size button for now (a table with no rows has nothing to enlarge). */
  fullSizeButton?: boolean;
}) {
  const { full, toggle } = useContext(FullSizeContext);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3">
      {/* On a phone the title gives the Full size button room beside it rather than a line to itself. */}
      {(title || subtitle) && (
        <div className="mr-2 min-w-0 max-sm:flex-[1_1_12rem]">
          {title && <h3 className="text-[15px] font-semibold leading-tight text-ink-900">{title}</h3>}
          {subtitle && <p className="mt-0.5 text-[13px] text-ink-500">{subtitle}</p>}
        </div>
      )}
      {children}
      {toggle && (full || fullSizeButton) && <FullSizeButton full={full} onClick={toggle} />}
    </div>
  );
}

/**
 * The search box in a table's header row: it grows into the room the controls
 * leave, and is named for screen readers by `label`. On a phone it is never
 * narrower than its hint needs (7rem for "Search", about half a rem a letter
 * more for a longer one), short of the line less the Full size button: rather
 * than squeeze in beside a filter and cut the hint short, it moves down a line,
 * and the Full size button stays beside it. `className` gives it a width of its
 * own where growing would be wrong (sm:w-72 sm:flex-initial, say).
 */
export function TableSearch({ value, onChange, label, placeholder = 'Search', className }: {
  value: string; onChange: (query: string) => void; label: string; placeholder?: string; className?: string;
}) {
  const hint = Math.max(7, Math.ceil(placeholder.length * 0.45 + 3));
  return (
    <label style={{ '--hint-width': `${hint}rem` } as CSSProperties}
      className={cx('min-w-[min(var(--hint-width),calc(100%-2.75rem))] flex-1 sm:min-w-36', className)}>
      <span className="sr-only">{label}</span>
      <SearchInput value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  );
}

/**
 * The table itself, under the header row. It scrolls sideways inside the card
 * when it is wider; full size, it fills the window and scrolls under its own
 * headings. With `maxHeight` (a CSS length, "60vh") a long table in the page
 * scrolls under its headings within that height too. While `busy` (new rows on
 * the way, the old ones still shown) it is dimmed.
 */
export function TableScroll({ busy, maxHeight, children }: { busy?: boolean; maxHeight?: string; children: ReactNode }) {
  const full = useFullSize();
  return (
    <div aria-busy={busy || undefined} className={cx('transition-opacity', busy && 'opacity-60', full && 'flex min-h-0 flex-1 flex-col')}>
      <Table className={full ? 'min-h-0 flex-1 overflow-y-auto' : maxHeight ? 'overflow-y-auto' : undefined}
        style={!full && maxHeight ? { maxHeight } : undefined}>{children}</Table>
    </div>
  );
}

/**
 * A first-column cell kept in view while the table scrolls sideways, so every
 * figure keeps its name. Not on a phone, where it would leave room for one narrow
 * column beside it: there the whole table scrolls. Its `background` must be
 * opaque (white, or a tint mixed with white), or the cells scrolling under it show through.
 */
export const pinnedCell = (background: string): string =>
  cx('sm:sticky sm:left-0 sm:z-[1] sm:shadow-[inset_-1px_0_0_var(--color-ink-100)]', background);

/** A row's actions, kept in view at the right while a wide table scrolls sideways, as the first column is at the left. */
export const pinnedEndCell = (background: string): string =>
  cx('sm:sticky sm:right-0 sm:z-[1] sm:shadow-[inset_1px_0_0_var(--color-ink-100)]', background);

/** A cell of the totals row: bold, and in the full size view kept in sight at the foot while the rows scroll. */
export const totalCell = (full: boolean): string =>
  cx('font-semibold', full && 'sticky bottom-0 z-10 bg-white shadow-[0_-1px_0_var(--color-ink-200)]');

/** The totals row's first cell, its label ("Total"): pinned like the column above it, unless `pinned` is false. */
export const totalLabelCell = (full: boolean, pinned = true): string => (pinned
  ? cx('bg-white font-semibold whitespace-nowrap sm:sticky sm:left-0', full
    ? 'sticky bottom-0 z-20 shadow-[0_-1px_0_var(--color-ink-200)] sm:shadow-[inset_-1px_0_0_var(--color-ink-100),0_-1px_0_var(--color-ink-200)]'
    : 'sm:z-[1] sm:shadow-[inset_-1px_0_0_var(--color-ink-100)]')
  : cx('bg-white font-semibold whitespace-nowrap', full && 'sticky bottom-0 z-20 shadow-[0_-1px_0_var(--color-ink-200)]'));

/** The totals row's cell under the row actions, pinned at the right as they are. */
const totalEndCell = (full: boolean): string => cx('bg-white font-semibold sm:sticky sm:right-0', full
  ? 'sticky bottom-0 z-20 shadow-[0_-1px_0_var(--color-ink-200)] sm:shadow-[inset_1px_0_0_var(--color-ink-100),0_-1px_0_var(--color-ink-200)]'
  : 'sm:z-[1] sm:shadow-[inset_1px_0_0_var(--color-ink-100)]');

export { SortTH };

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

/**
 * text and date columns sit left; number, money and price columns sit right, in
 * figures of one width. Money is in cents and a price per share in micro-cents,
 * as everywhere else (AGENTS.md). Only text wraps, and only past a short line.
 */
export type ColumnType = 'text' | 'number' | 'money' | 'price' | 'date';

/** A breakpoint below which a column is left out (Tailwind's sm, md, lg, xl, 2xl). */
export type Breakpoint = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** A row's tint: red for something wrong or missed, amber for something to look at, brand for the current one. */
export type RowTone = 'red' | 'amber' | 'brand';

export interface Column<T> {
  /** Names the column for sorting (defaultSort) and React. */
  key: string;
  /** The heading. Empty ('') for a column of row actions. */
  label: ReactNode;
  /** What the heading means, on hover, when the label is short for it ("I&O %"). */
  title?: string;
  /** Default 'text'. */
  type?: ColumnType;
  /**
   * What the column sorts by: text, a number (money in cents, a price in
   * micro-cents), or for a date column an ISO date or time. Blank (null,
   * undefined, '') sorts last. Without it the column does not sort.
   */
  value?: (row: T) => string | number | null | undefined;
  /** What the cell shows. Without it, the value, formatted for the column's type. */
  cell?: (row: T) => ReactNode;
  /** The cell's words on hover: the whole of a value the cell cuts short. */
  cellTitle?: (row: T) => string | undefined;
  /** False keeps a column with a value from sorting. */
  sortable?: boolean;
  /** Overrides the type's alignment. */
  align?: 'left' | 'right' | 'center';
  width?: string | number;
  /**
   * On every cell of the column (TD). A first column that sets its own
   * background (bg-…) keeps it; make it opaque, as pinnedCell says.
   */
  className?: string | ((row: T) => string | undefined);
  /** A cell that holds a sentence may wrap (TD wrap). */
  wrap?: boolean;
  /** Leaves the column out, as for a role that may not act on the rows. */
  hidden?: boolean;
  /** Leaves the column out below this breakpoint, heading and cells, where the window has no room for it. */
  hideBelow?: Breakpoint;
  /** The column's figure in the totals row. A totals row shows when any column has one. */
  total?: ReactNode;
}

type SearchSetting<T> = {
  /** The box's hint. Default "Search". */
  placeholder?: string;
  /** Its name for screen readers. Default the placeholder. */
  label?: string;
} & (
  /** The table searches itself: a row is shown when any of these contains the query, ignoring case. */
  | { by: (row: T) => readonly (string | null | undefined)[] }
  /** The page keeps the query and narrows the rows it passes in. */
  | { value: string; onChange: (query: string) => void }
);

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string | number;
  /** In the header row, for a table that the page around it does not already name. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** What the rows are, for screen readers ("Stakeholders"); it also names the full size view. Default the title, when it is words. */
  caption?: string;
  /** The page's filters, date and view switches for this table, at the left of the header row. */
  controls?: ReactNode;
  /** The page's buttons for this table, at the right of the header row. */
  actions?: ReactNode;
  search?: SearchSetting<T>;
  /** The order the table opens in. Without it the rows keep the order given until a heading is clicked. */
  defaultSort?: { key: string; direction: SortDirection };
  /**
   * The page's own order, for rows the page sorts (a report run in that order):
   * the headings show it and `onSort` is told which one was clicked; the rows
   * are drawn as given.
   */
  sort?: Sort<string> | null;
  onSort?: (key: string) => void;
  /** Rows that stay after the others whatever the sort, in the order given. */
  pinBottom?: (row: T) => boolean;
  /** Keeps the first column in view while the table scrolls sideways. Default on in a card, off in a box. */
  pinFirst?: boolean;
  /** The first cell of the totals row. Default "Total", or "Total of all rows" while the table's own search narrows them. */
  totalLabel?: ReactNode;
  /** Shown in place of the table when there are no rows at all. */
  empty?: ReactNode;
  /** Shown in the table when the table's own search finds nothing. Default: Nothing matches “query”. */
  noMatch?: (query: string) => ReactNode;
  /**
   * Rows drawn under a row, such as its details or a breakdown: TR elements, with
   * a TD per column or a colSpan. While the first column is pinned, their first
   * cell takes pinnedCell(background) too, as the cap table's class breakdown does.
   */
  expand?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** A row's tint, carried into its pinned first cell. */
  rowTone?: (row: T) => RowTone | null | undefined;
  isSelected?: (row: T) => boolean;
  /** The Full size button. Default on in a card, off in a box; a string names the view for screen readers. */
  fullSize?: boolean | string;
  frame?: 'card' | 'box' | 'none';
  /** On the table's place in the page (margins, mostly). */
  className?: string;
  /** Dims the rows while new ones are on the way. */
  busy?: boolean;
  /** A long table scrolls under its headings within this height (a CSS length, "60vh") in the page; full size shows it all. */
  maxHeight?: string;
  /** Between the header row and the table, inside the card: a word on what the rows are, say. */
  before?: ReactNode;
  /** Under the table, inside the card: a note on the figures, say. */
  after?: ReactNode;
}

const RIGHT_ALIGNED = new Set<ColumnType>(['number', 'money', 'price']);

/** Literal class names, so Tailwind finds them: the column shows from the breakpoint up. */
const HIDE_BELOW: Record<Breakpoint, string> = {
  sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell', '2xl': 'hidden 2xl:table-cell',
};

/** Each tone on the row, and mixed with white for the first cell, which the cells scrolling under it must not show through. */
const TONES: Record<RowTone, { row: string; first: string }> = {
  red: { row: 'bg-red-50/40', first: 'bg-[color-mix(in_srgb,var(--color-red-50)_40%,white)]' },
  amber: { row: 'bg-amber-50/40', first: 'bg-[color-mix(in_srgb,var(--color-amber-50)_40%,white)]' },
  brand: { row: 'bg-brand-50/40', first: 'bg-[color-mix(in_srgb,var(--color-brand-50)_40%,white)]' },
};

/** A date column's value as a time to compare, so 9 Mar comes before 10 Feb of the next year whatever the text says. */
function asTime(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** A cell's value on screen when the column draws no cell of its own. */
function shown(type: ColumnType, value: string | number | null | undefined): ReactNode {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') {
    return type === 'money' ? money(value) : type === 'price' ? pps(value) : type === 'date' ? date(new Date(value).toISOString()) : shares(value);
  }
  // An ISO time shows as its day; a date column whose rows want the time give it a cell (dateTime).
  return type === 'date' ? date(value) : value;
}

/** A first cell's tint, mixed with white so the cells scrolling under it do not show through. */
const PINNED_SELECTED = 'bg-[color-mix(in_srgb,var(--color-brand-50)_60%,white)]';
const PINNED_HOVER = 'group-hover/row:bg-[color-mix(in_srgb,var(--color-brand-50)_40%,white)]';

// T defaults to any: rows of a page's own `any` data (a report, a portfolio) give
// nothing to infer from, and without the default the rows would be unknown.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DataTable<T = any>({
  rows, columns, rowKey, title, subtitle, caption, controls, actions, search, defaultSort, sort, onSort, pinBottom,
  pinFirst, totalLabel, empty, noMatch, expand, onRowClick, rowClassName, rowTone, isSelected,
  fullSize, frame = 'card', className, busy, maxHeight, before, after,
}: DataTableProps<T>) {
  const [ownQuery, setOwnQuery] = useState('');
  const [chosen, setChosen] = useState<Sort<string> | null>(defaultSort ?? null);
  // While the table searches itself, its rows follow the box a moment behind, so
  // typing never waits for a long list to be drawn again.
  const deferredQuery = useDeferredValue(ownQuery);
  const own = search && 'by' in search ? search : undefined;
  const query = own ? ownQuery : search && 'value' in search ? search.value : '';
  // A table that searches itself and has no rows has nothing to search. A page's
  // own search stays, since it may be what emptied the table.
  const box = own && rows.length === 0 ? undefined : search;
  const name = caption ?? (typeof title === 'string' ? title : undefined);
  const searchLabel = search?.label ?? search?.placeholder ?? 'Search';
  const fullLabel = (fullSize ?? frame === 'card')
    ? (typeof fullSize === 'string' ? fullSize : `${name ?? 'Table'}, full size`)
    : undefined;
  const headed = !!(title || subtitle || controls || actions || box || (fullLabel && rows.length > 0));

  return (
    <TableCard frame={frame} fullSize={fullLabel} className={className}>
      {(full) => (
        <>
          {headed && (
            <TableToolbar title={title} subtitle={subtitle} fullSizeButton={rows.length > 0}>
              {controls}
              {box
                ? <TableSearch label={searchLabel} placeholder={box.placeholder} value={query}
                    onChange={'by' in box ? setOwnQuery : box.onChange} />
                : (actions || (fullLabel && rows.length > 0)) && <span aria-hidden className="flex-1" />}
              {actions}
            </TableToolbar>
          )}
          {before}
          {rows.length === 0 ? (empty ?? <p className="px-5 py-8 text-center text-[13px] text-ink-500">Nothing here yet.</p>) : (
            <Rows rows={rows} columns={columns} rowKey={rowKey} caption={name} by={own?.by} query={own ? deferredQuery : ''}
              chosen={chosen} choose={setChosen} defaultSort={defaultSort} sort={sort} onSort={onSort}
              pinBottom={pinBottom} pin={pinFirst ?? frame === 'card'} totalLabel={totalLabel} noMatch={noMatch}
              expand={expand} onRowClick={onRowClick} rowClassName={rowClassName} rowTone={rowTone} isSelected={isSelected}
              full={full} busy={busy} maxHeight={maxHeight} />
          )}
          {after}
        </>
      )}
    </TableCard>
  );
}

interface RowsProps<T> extends Pick<DataTableProps<T>, 'rows' | 'columns' | 'rowKey' | 'caption' | 'defaultSort' | 'sort' | 'onSort'
  | 'pinBottom' | 'totalLabel' | 'noMatch' | 'expand' | 'onRowClick' | 'rowClassName' | 'rowTone' | 'isSelected' | 'busy' | 'maxHeight'> {
  /** The words the table's own search looks for in a row, and what was typed (a moment behind the box). */
  by?: (row: T) => readonly (string | null | undefined)[];
  query: string;
  /** The heading someone clicked last, and how to change it. */
  chosen: Sort<string> | null;
  choose: (sort: Sort<string>) => void;
  pin: boolean;
  full: boolean;
}

/**
 * The table under the header row. Every value it is given stays the same while
 * someone types in the table's own search, until the rows catch up with the box
 * (`query`), so while typing it is not drawn again (memo).
 */
const Rows = memo(function Rows<T>({
  rows, columns, rowKey, caption, by, query, chosen, choose, defaultSort, sort, onSort, pinBottom, pin, totalLabel,
  noMatch, expand, onRowClick, rowClassName, rowTone, isSelected, full, busy, maxHeight,
}: RowsProps<T>) {
  const visible = columns.filter((c) => !c.hidden);
  const sorts = (c: Column<T>) => c.value != null && c.sortable !== false;
  const usable = (s: Sort<string> | null | undefined): Sort<string> | null =>
    (s && visible.some((c) => c.key === s.key && sorts(c)) ? s : null);
  // The page's own order, or the heading clicked last; a sort on a column that is
  // not shown (any more) gives way to the table's opening order.
  const ordering = onSort ? (sort ?? null) : (usable(chosen) ?? usable(defaultSort));
  const toggle = onSort ?? ((key: string) => choose(ordering?.key === key
    ? { key, direction: ordering.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' }));

  const q = query.trim().toLowerCase();
  const found = q && by ? rows.filter((row) => by(row).some((text) => (text ?? '').toLowerCase().includes(q))) : rows;
  const free = pinBottom ? found.filter((row) => !pinBottom(row)) : found;
  const sortColumn = !onSort && ordering ? visible.find((c) => c.key === ordering.key) : undefined;
  const read = sortColumn?.value;
  const ordered = [
    // Each row's value is read once rather than at every comparison; the sort is
    // stable, so rows that tie keep the order they were given.
    ...(ordering && read
      ? sortRows(free.map((row) => ({ row, key: sortColumn.type === 'date' ? asTime(read(row)) : read(row) })), ordering, (k) => k.key)
        .map((k) => k.row)
      : free),
    ...(pinBottom ? found.filter((row) => pinBottom(row)) : []),
  ];

  const alignOf = (c: Column<T>) => c.align ?? (RIGHT_ALIGNED.has(c.type ?? 'text') ? 'right' : 'left');
  const classOf = (c: Column<T>, row: T) => (typeof c.className === 'function' ? c.className(row) : c.className);
  const hideOf = (c: Column<T>) => c.hideBelow && HIDE_BELOW[c.hideBelow];
  const hasTotals = visible.some((c) => c.total !== undefined);
  // The row's actions (a last column with no heading and nothing to sort by) stay
  // in view at the right while the first column does at the left, so Edit or ⋯ is
  // never scrolled out of reach on a table wider than its card.
  const end = visible.length - 1;
  const pinEnd = pin && end > 0 && visible[end].label === '' && !sorts(visible[end]);
  const pinnedAt = (i: number) => (pin && i === 0 ? 'start' : pinEnd && i === end ? 'end' : null);

  // A pinned cell's background: its own, else the row's tint, selected or hover tint, mixed with white.
  const pinnedBackground = (c: Column<T>, row: T) => {
    if (/(^|\s)bg-/.test(classOf(c, row) ?? '')) return '';
    const tone = rowTone?.(row);
    if (tone) return TONES[tone].first;
    if (isSelected?.(row)) return PINNED_SELECTED;
    return cx('bg-white', onRowClick && PINNED_HOVER);
  };

  return (
    <TableScroll busy={busy} maxHeight={maxHeight}>
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>
          {visible.map((c, i) => (sorts(c)
            ? <SortTH key={c.key} column={c.key} label={c.label} sort={ordering} onSort={toggle} align={alignOf(c)}
                width={c.width} title={c.title} pinned={pin && i === 0} className={hideOf(c)} />
            : <TH key={c.key} align={alignOf(c)} width={c.width} pinned={pinnedAt(i) === 'end' ? 'end' : pinnedAt(i) === 'start'} className={hideOf(c)}>
                {c.title ? <span title={c.title}>{c.label}</span> : c.label}
              </TH>))}
        </tr>
      </thead>
      <tbody>
        {ordered.map((row) => {
          const tone = rowTone?.(row);
          return (
            <Fragment key={rowKey(row)}>
              <TR onClick={onRowClick && (() => onRowClick(row))} selected={isSelected?.(row)}
                className={cx(onRowClick && pin && 'group/row', tone && TONES[tone].row, rowClassName?.(row))}>
                {visible.map((c, i) => (
                  <TD key={c.key} align={alignOf(c)} mono={RIGHT_ALIGNED.has(c.type ?? 'text')} wrap={c.wrap} title={c.cellTitle?.(row)}
                    className={cx(pinnedAt(i) === 'start' && pinnedCell(pinnedBackground(c, row)), pinnedAt(i) === 'end' && pinnedEndCell(pinnedBackground(c, row)),
                      c.type && c.type !== 'text' && 'whitespace-nowrap', hideOf(c), classOf(c, row))}>
                    {c.cell ? c.cell(row) : shown(c.type ?? 'text', c.value?.(row))}
                  </TD>
                ))}
              </TR>
              {expand?.(row)}
            </Fragment>
          );
        })}
        {ordered.length === 0 && (
          <tr>
            <TD colSpan={visible.length} className="py-8 text-center text-[13px] text-ink-500">
              {noMatch ? noMatch(query.trim()) : <>Nothing matches “{query.trim()}”.</>}
            </TD>
          </tr>
        )}
      </tbody>
      {hasTotals && (
        <tfoot>
          <tr className="bg-white">
            {visible.map((c, i) => (i === 0
              ? <TD key={c.key} className={totalLabelCell(full, pin)}>{c.total ?? totalLabel ?? (q ? 'Total of all rows' : 'Total')}</TD>
              : <TD key={c.key} align={alignOf(c)} mono={RIGHT_ALIGNED.has(c.type ?? 'text')}
                  className={cx(pinnedAt(i) === 'end' ? totalEndCell(full) : totalCell(full), hideOf(c))}>{c.total}</TD>))}
          </tr>
        </tfoot>
      )}
    </TableScroll>
  );
}) as <T>(props: RowsProps<T>) => ReactNode;
