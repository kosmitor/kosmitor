/**
 * The documents page as a tree of folders.
 *
 * A folder is not stored on its own: it is the text on each document, and a
 * slash in it separates levels, so "Financing/Series A" is "Series A" inside
 * "Financing". Names saved before folders could nest have no slash, so they are
 * simply top-level folders. The server cleans every path the same way
 * (apps/server/src/folders.ts); the rules are repeated here so the page can say
 * what is wrong with a path before sending it, and so a row saved before those
 * rules existed is still shown in the folder it reads as.
 *
 * The tree is a treegrid: one row per folder or document, with the arrow keys
 * moving between rows and opening or closing folders, the way a file browser
 * does. Editors can select documents (a checkbox, Shift for a range, Cmd or Ctrl
 * for one more, Space from the keyboard) and drag a document onto a folder to
 * move it, taking the rest of the selection with it when it is selected. A whole
 * folder is somewhere to drop: its row, and every folder and document shown
 * inside it. Files dragged in from the computer upload into the folder they are
 * let go over. Dragging works with neither a keyboard nor most phones, so every
 * move can also be made from the "Move to folder" dialog below.
 *
 * It is drawn as every other table is (DataTable.tsx): the page's search and
 * buttons in the header row, with the Full size button when the page puts the
 * tree in a TableCard, and headings that sort. A sort orders the documents inside
 * each folder, which the page does before handing them over; the folders keep
 * their order by name, turned round when the names themselves are sorted Z to A.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { cx } from './style.ts';
import { Icon } from './icons.tsx';
import { TH, Field, Input, Select, Badge, Button, SHORT_TEXT } from './ui.tsx';
import { FormModal } from './crud.tsx';
import { SortTH, TableToolbar, useFullSize } from './DataTable.tsx';
import type { Sort } from './sortable.tsx';

/** Where a document goes when nobody says. The top level of the tree means this folder. */
export const DEFAULT_FOLDER = 'General';
export const FOLDER_MAX_DEPTH = 5;
export const FOLDER_NAME_MAX = 60;
export const FOLDER_PATH_MAX = 120;

/**
 * The data type dragged documents carry: their ids, as a JSON list. It is ours
 * alone, so documents dragged within the page are never mistaken for files
 * dragged in from the computer, and nothing else dropped on the page is mistaken
 * for a document. Browsers lower-case these names, so it is written in lower case.
 */
const DOCUMENT_DRAG_TYPE = 'application/x-kosmitor-document';

const levelsOf = (value: string): string[] =>
  value.normalize('NFC').split('/').map((level) => level.replace(/\s+/g, ' ').trim()).filter((level) => level !== '');

/** The folder a stored value reads as, cleaned the way the server cleans it. It never refuses. */
export function folderPath(value: unknown): string {
  const levels = typeof value === 'string' ? levelsOf(value) : [];
  return levels.length > 0 ? levels.join('/') : DEFAULT_FOLDER;
}

/** Why the server would refuse a folder path, or null when it would take it. */
export function folderProblem(value: string): string | null {
  const levels = levelsOf(value);
  if (levels.some((level) => /[\p{Cc}\p{Cf}]/u.test(level))) return 'A folder name cannot contain hidden characters.';
  if (levels.length > FOLDER_MAX_DEPTH) return `Folders can be at most ${FOLDER_MAX_DEPTH} levels deep.`;
  if (levels.some((level) => [...level].length > FOLDER_NAME_MAX)) return `A folder name can be at most ${FOLDER_NAME_MAX} characters.`;
  if ([...levels.join('/')].length > FOLDER_PATH_MAX) return `A folder path can be at most ${FOLDER_PATH_MAX} characters.`;
  return null;
}

/** "Financing/Series A" read aloud and on screen: the slashes get room to breathe. */
export const folderLabel = (path: string): string => path.split('/').join(' / ');
const folderName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string): string | null => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null);
/** A folder and every folder above it, outermost first. */
const lineOf = (path: string): string[] => path.split('/').map((_, i, all) => all.slice(0, i + 1).join('/'));

export interface TreeDocument { id: string; name: string; folder?: string | null }

export interface FolderNode<D> {
  path: string;
  name: string;
  folders: FolderNode<D>[];
  documents: D[];
  /** Documents in this folder and every folder inside it. */
  count: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = <D,>(a: FolderNode<D>, b: FolderNode<D>) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path);

/**
 * The top-level folders, each holding its subfolders sorted by name and then
 * its documents in the order they were given. `extra` adds folders that hold
 * nothing yet, such as one just made on the page.
 */
export function buildFolderTree<D extends TreeDocument>(documents: D[], extra: string[] = []): FolderNode<D>[] {
  const top: FolderNode<D>[] = [];
  const nodes = new Map<string, FolderNode<D>>();
  const ensure = (path: string): FolderNode<D> => {
    const found = nodes.get(path);
    if (found) return found;
    const node: FolderNode<D> = { path, name: folderName(path), folders: [], documents: [], count: 0 };
    const parent = parentOf(path);
    (parent === null ? top : ensure(parent).folders).push(node);
    nodes.set(path, node);
    return node;
  };
  for (const d of documents) ensure(folderPath(d.folder)).documents.push(d);
  for (const path of extra) ensure(folderPath(path));
  const finish = (node: FolderNode<D>): number => {
    node.folders.sort(byName);
    node.count = node.documents.length + node.folders.reduce((n, f) => n + finish(f), 0);
    return node.count;
  };
  top.sort(byName).forEach(finish);
  return top;
}

/** Every folder in the tree, depth first, with how deep it sits (1 for a top-level folder). */
export function listFolders<D>(top: FolderNode<D>[]): { path: string; name: string; level: number }[] {
  const out: { path: string; name: string; level: number }[] = [];
  const walk = (nodes: FolderNode<D>[], level: number) => {
    for (const node of nodes) { out.push({ path: node.path, name: node.name, level }); walk(node.folders, level + 1); }
  };
  walk(top, 1);
  return out;
}

// ---------------------------------------------------------------------------
// Which folders are open
// ---------------------------------------------------------------------------

export interface FolderExpansion {
  isOpen: (path: string) => boolean;
  /** Opens or closes one folder; without `open` it flips it. */
  toggle: (path: string, open?: boolean) => void;
  /** Opens a folder and every folder above it, so whatever is in it can be seen. */
  reveal: (path: string) => void;
}

const storeFor = (companyId: string) => `kosmitor_documents_closed_${companyId}`;
/** One empty set, so a render with nothing closed does not look like a change to everything that depends on it. */
const NOTHING_CLOSED: ReadonlySet<string> = new Set();

function readClosed(companyId: string | null): Set<string> {
  if (!companyId) return new Set();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storeFor(companyId)) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : []);
  } catch { return new Set(); }
}

/**
 * Which folders are open, remembered per company in this browser.
 *
 * What is stored is the folders someone closed rather than the ones they
 * opened, so a folder nobody has touched (a new one, or every folder on a first
 * visit) starts open and the page shows every document, as it did before
 * folders could nest.
 *
 * A search opens every folder that holds a match. Closing one while searching
 * only lasts for that search, so looking for something never rearranges the
 * tree someone left behind.
 */
export function useFolderExpansion(companyId: string | null, query: string): FolderExpansion {
  const [closed, setClosed] = useState(() => ({ companyId, paths: readClosed(companyId) }));
  const current = closed.companyId === companyId ? closed.paths : readClosed(companyId);
  useEffect(() => {
    if (closed.companyId !== companyId) setClosed({ companyId, paths: readClosed(companyId) });
  }, [closed.companyId, companyId]);

  const searching = query.trim() !== '';
  const [searchClosed, setSearchClosed] = useState(() => ({ query, paths: new Set<string>() }));
  const closedInSearch = searchClosed.query === query ? searchClosed.paths : NOTHING_CLOSED;

  const update = useCallback((change: (paths: Set<string>) => void) => {
    if (searching) {
      setSearchClosed((s) => {
        const paths = new Set(s.query === query ? s.paths : []);
        change(paths);
        return { query, paths };
      });
      return;
    }
    setClosed((c) => {
      const paths = new Set(c.companyId === companyId ? c.paths : readClosed(companyId));
      change(paths);
      if (companyId) {
        try { localStorage.setItem(storeFor(companyId), JSON.stringify([...paths])); } catch { /* storage unavailable: forget on reload */ }
      }
      return { companyId, paths };
    });
  }, [searching, query, companyId]);

  return useMemo(() => {
    const shut = searching ? closedInSearch : current;
    return {
      isOpen: (path) => !shut.has(path),
      toggle: (path, open) => update((paths) => {
        if (open ?? paths.has(path)) paths.delete(path); else paths.add(path);
      }),
      reveal: (path) => update((paths) => { for (const p of lineOf(folderPath(path))) paths.delete(p); }),
    };
  }, [searching, closedInSearch, current, update]);
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface TreeColumn {
  key: string;
  label: string;
  /** Classes for the header and every cell in the column, such as when to hide it on a small screen. */
  className?: string;
  width?: number | string;
  align?: 'left' | 'right';
  /** Its heading sorts the documents, when the tree is given `onSort`. */
  sortable?: boolean;
}

type FolderRow<D> = { kind: 'folder'; id: string; level: number; setsize: number; posinset: number; parent: string | null; node: FolderNode<D>; open: boolean };
type DocumentRow<D> = { kind: 'document'; id: string; level: number; setsize: number; posinset: number; parent: string; doc: D; folder: string };
type Row<D> = FolderRow<D> | DocumentRow<D>;

const folderRowId = (path: string) => `f:${path}`;

/**
 * The rows that can be seen: every top-level folder, and inside each open folder
 * its subfolders and then its documents. `zToA` turns the folders round, for a
 * sort by name from Z to A.
 */
function visibleRows<D extends TreeDocument>(top: FolderNode<D>[], isOpen: (path: string) => boolean, zToA = false): Row<D>[] {
  const rows: Row<D>[] = [];
  const walk = (parent: FolderNode<D> | null, inOrder: FolderNode<D>[], documents: D[], level: number) => {
    const folders = zToA ? [...inOrder].reverse() : inOrder;
    const setsize = folders.length + documents.length;
    folders.forEach((node, i) => {
      const open = isOpen(node.path);
      rows.push({ kind: 'folder', id: folderRowId(node.path), level, setsize, posinset: i + 1, parent: parent && folderRowId(parent.path), node, open });
      if (open) walk(node, node.folders, node.documents, level + 1);
    });
    if (!parent) return;
    documents.forEach((doc, i) => rows.push({
      kind: 'document', id: `d:${doc.id}`, level, setsize, posinset: folders.length + i + 1,
      parent: folderRowId(parent.path), doc, folder: parent.path,
    }));
  };
  walk(null, top, [], 1);
  return rows;
}

/** The folder a row belongs to: a folder's own, or the one a document is in. A drop anywhere on the row goes there. */
const folderOfRow = <D,>(row: Row<D>): string => (row.kind === 'folder' ? row.node.path : row.folder);
/** Whether `path` is the folder `block` or anywhere inside it. */
const within = (path: string, block: string): boolean => path === block || path.startsWith(`${block}/`);

/** Nothing selected. One set, so a render with nothing selected does not look like a change to everything that depends on it. */
export const NO_SELECTION: ReadonlySet<string> = new Set();

/** Keys typed here are text, not commands for the tree. */
const isTextField = (el: Element): boolean =>
  el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable=""], [contenteditable="true"]');

const CELL = 'px-3 py-2.5 border-b border-ink-100 text-ink-800 align-middle';

/**
 * The name cell stays in view while the tree scrolls sideways, as a table's first
 * column does (pinnedCell in DataTable.tsx), from small screens up, with the same
 * line after it. Its background is the row's, made opaque, so the cells passing
 * under it do not show through: the drop target's tint, a selected document's,
 * a focused row's, a folder under the pointer, else white. The bar down its left
 * edge (a drop target, the row with focus) is drawn with that line. The class
 * names are whole, so Tailwind finds them.
 */
interface RowLook { drop: boolean; selected: boolean; folder: boolean }
/** The row's background, opaque. */
const rowBackground = ({ drop, selected, folder }: RowLook): string => (drop ? 'bg-brand-50'
  : selected ? 'bg-[color-mix(in_srgb,var(--color-brand-50)_60%,white)] group-focus-visible:bg-brand-50'
  : cx('bg-white group-focus-visible:bg-[color-mix(in_srgb,var(--color-brand-50)_50%,white)]', folder && 'group-hover:bg-ink-50'));
const pinnedName = (look: RowLook): string => cx('sm:sticky sm:left-0 sm:z-[1]', rowBackground(look),
  look.drop ? 'shadow-[inset_3px_0_0_0_var(--color-brand-500)] sm:shadow-[inset_3px_0_0_0_var(--color-brand-500),inset_-1px_0_0_var(--color-ink-100)]'
    : cx('sm:shadow-[inset_-1px_0_0_var(--color-ink-100)] group-focus-visible:shadow-[inset_3px_0_0_0_var(--color-brand-600)]',
      'sm:group-focus-visible:shadow-[inset_3px_0_0_0_var(--color-brand-600),inset_-1px_0_0_var(--color-ink-100)]'));
/** The row's actions (a last column with no heading), kept in view at the right as a table's are (pinnedEndCell in DataTable.tsx). */
const pinnedActions = (look: RowLook): string =>
  cx('sm:sticky sm:right-0 sm:z-[1] sm:shadow-[inset_1px_0_0_var(--color-ink-100)]', rowBackground(look));

/**
 * A folder or document name this short stays on one line beside the other
 * columns, from a small tablet up, as short text in the first column of every
 * table does (ui.tsx, Table): "Equity awards" used to break in two under its
 * folder icon. A longer name wraps between words there, in a column wide enough
 * (the heading's min-width) for two or three lines: let it break anywhere and the
 * table squeezed "Option agreement OPT-4 — Rowan Vale" to a word a line. On a
 * phone a name may break anywhere, so a file name with no spaces still fits.
 */
const nameFit = (name: unknown): string => ([...String(name ?? '')].length <= SHORT_TEXT ? 'wrap-anywhere sm:whitespace-nowrap' : 'wrap-anywhere sm:break-words');
/** How long a dragged document has to rest on a closed folder before it opens, so a deeper folder can be reached. */
const SPRING_MS = 700;

/** The documents being dragged: their ids, the folders they come from, and whether they are the selection. */
interface Carried { ids: string[]; folders: string[]; selection: boolean }
/** Where a drag would land: the top-level strip over the toolbar, or a folder and everything shown inside it. */
type Over = { at: 'top' | 'folder'; path: string; effect: 'move' | 'copy' };

export function DocumentTree<D extends TreeDocument>({
  label, documents, extraFolders, expansion, canEdit, columns, renderName, renderCells,
  selected, onSelect, onOpen, onMove, onDropFiles, onActiveFolderChange, toolbar, empty, sort = null, onSort,
}: {
  label: string;
  /** The documents to show, already narrowed by any search. */
  documents: D[];
  /** Folders to show even though nothing is in them yet. */
  extraFolders: string[];
  expansion: FolderExpansion;
  canEdit: boolean;
  /** The columns after the first, which holds the tree. */
  columns: TreeColumn[];
  renderName: (doc: D) => React.ReactNode;
  /** One cell's contents per column, in the same order. */
  renderCells: (doc: D) => React.ReactNode[];
  /** The ids of the documents selected. Only editors select, since moving them is what a selection is for. */
  selected: ReadonlySet<string>;
  onSelect: (ids: ReadonlySet<string>) => void;
  /** Enter on a document row. */
  onOpen: (doc: D) => void;
  /** Documents dropped on a folder; `selection` says they were the selection, dragged together. */
  onMove: (docs: D[], folder: string, selection: boolean) => void;
  onDropFiles: (files: File[], folder: string) => void;
  /** The folder of the row last chosen, or null before one is. */
  onActiveFolderChange?: (folder: string | null) => void;
  toolbar?: React.ReactNode;
  /** Shown in place of the rows when there are none. */
  empty?: React.ReactNode;
  /** How the documents are sorted (the page sorts them), or null for the order given. "name" is the Document column. */
  sort?: Sort<string> | null;
  /** A heading clicked. Without it the headings do not sort. */
  onSort?: (key: string) => void;
}) {
  const full = useFullSize();
  // The row's actions, last and with no heading, stay in view at the right while the tree scrolls sideways.
  const actionsAt = (i: number): boolean => i === columns.length - 1 && columns[i].label === '';
  const zToA = sort?.key === 'name' && sort.direction === 'desc';
  const tree = useMemo(() => buildFolderTree(documents, extraFolders), [documents, extraFolders]);
  const rows = useMemo(() => visibleRows(tree, expansion.isOpen, zToA), [tree, expansion, zToA]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // One row is in the tab order at a time; the arrow keys move between rows.
  // Before anyone picks a row it is the first one.
  const [active, setActive] = useState<string | null>(null);
  const chosen = rows.find((r) => r.id === active) ?? null;
  const tabStop = chosen?.id ?? rows[0]?.id ?? null;
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const focusRow = (id: string) => { setActive(id); rowRefs.current.get(id)?.focus(); };

  const activeFolder = chosen ? folderOfRow(chosen) : null;
  useEffect(() => { onActiveFolderChange?.(activeFolder); }, [activeFolder, onActiveFolderChange]);

  // The buttons and links in a row are in the tab order only while that row is,
  // so Tab goes through the one row's actions and then leaves the tree instead
  // of stopping on every button of every row. The cells come from the page, so
  // this is set on the drawn rows after each render.
  useLayoutEffect(() => {
    rowRefs.current.forEach((el, id) => {
      el.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea')
        .forEach((widget) => { widget.tabIndex = id === tabStop ? 0 : -1; });
    });
  });

  // --- Selection -----------------------------------------------------------
  // A checkbox on each document, Shift for a range in the order the rows are
  // shown, Cmd or Ctrl to pick one more, the way a file browser does. The page
  // keeps the set, so it can move the documents and clear it afterwards.
  const selectedCount = useMemo(() => documents.reduce((n, d) => n + (selected.has(d.id) ? 1 : 0), 0), [documents, selected]);
  /**
   * Where Shift extends from: the row picked last on its own, what was selected
   * apart from the range, and the selection that made, so a selection changed
   * from outside (cleared after a move, say) is taken as the new starting point.
   */
  const anchor = useRef<{ id: string; base: ReadonlySet<string>; made: ReadonlySet<string> } | null>(null);

  const toggle = (row: DocumentRow<D>) => {
    const next = new Set(selected);
    if (next.has(row.doc.id)) next.delete(row.doc.id); else next.add(row.doc.id);
    anchor.current = { id: row.id, base: next, made: next };
    onSelect(next);
  };
  /** Selects every document from the anchor to the row `to`, as the rows are shown, alongside what was selected before. */
  const extendTo = (to: string) => {
    let from = anchor.current;
    if (!from || !rowById.has(from.id)) from = { id: chosen?.id ?? to, base: selected, made: selected };
    else if (from.made !== selected) from = { ...from, base: selected };
    const a = rows.findIndex((r) => r.id === from.id);
    const b = rows.findIndex((r) => r.id === to);
    if (a < 0 || b < 0) return;
    const next = new Set(from.base);
    for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) if (r.kind === 'document') next.add(r.doc.id);
    anchor.current = { id: from.id, base: from.base, made: next };
    onSelect(next);
  };
  /** Every document in an open folder, added to what is already selected (which may include some in closed folders). */
  const selectAllShown = () => {
    const next = new Set(selected);
    for (const r of rows) if (r.kind === 'document') next.add(r.doc.id);
    anchor.current = null;
    onSelect(next);
  };
  const clearSelection = () => { anchor.current = null; onSelect(NO_SELECTION); };

  // How many are selected is said as it changes, politely, so it never cuts
  // across the name of the row someone has just moved to.
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    setSpoken((said) => (selectedCount > 0
      ? `${selectedCount} document${selectedCount === 1 ? '' : 's'} selected`
      : said ? 'Selection cleared' : ''));
  }, [selectedCount]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    const el = e.target as HTMLElement;
    // A menu opened from a row is drawn at the end of the page, but its keys
    // still reach here through React. They belong to the menu.
    if (!e.currentTarget.contains(el)) return;
    // Every document in sight, from a row or from a checkbox in one.
    if (canEdit && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && !isTextField(el)) {
      e.preventDefault();
      selectAllShown();
      return;
    }
    // Keys pressed on a button inside a row belong to that button.
    if (el.tagName !== 'TR' || e.altKey || e.ctrlKey || e.metaKey) return;
    const at = rows.findIndex((r) => r.id === el.dataset.row);
    if (at < 0) return;
    const row = rows[at];
    let next: string | null | undefined;
    switch (e.key) {
      case 'ArrowDown': next = rows[at + 1]?.id; break;
      case 'ArrowUp': next = rows[at - 1]?.id; break;
      case 'Home': next = rows[0]?.id; break;
      case 'End': next = rows.at(-1)?.id; break;
      case 'ArrowRight':
        if (row.kind !== 'folder') break;
        if (!row.open) expansion.toggle(row.node.path, true);
        else if (rows[at + 1] && rows[at + 1].level > row.level) next = rows[at + 1].id;
        break;
      case 'ArrowLeft':
        if (row.kind === 'folder' && row.open) expansion.toggle(row.node.path, false);
        else next = row.parent;
        break;
      case 'Enter':
        if (row.kind === 'document') onOpen(row.doc); else expansion.toggle(row.node.path);
        break;
      case ' ':
        if (!canEdit || row.kind !== 'document') return;
        toggle(row);
        break;
      default: return;
    }
    e.preventDefault();
    if (!next) return;
    // Shift with a move extends the selection to the row moved to.
    if (canEdit && e.shiftKey && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) extendTo(next);
    focusRow(next);
  };

  // Escape lets go of the selection from anywhere in the tree, the bar above it included.
  const tbody = useRef<HTMLTableSectionElement>(null);
  const onAreaKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !canEdit || selectedCount === 0 || e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    if (!e.currentTarget.contains(el) || isTextField(el)) return;
    e.preventDefault();
    clearSelection();
    // A button in the bar goes with the selection, so focus comes back to the rows.
    if (!tbody.current?.contains(el) && tabStop) focusRow(tabStop);
  };

  /** A click that lands on a link, a button or the checkbox is theirs, not a click on the row. */
  const onControl = (e: React.MouseEvent<HTMLElement>) => {
    const hit = (e.target as Element).closest?.('a, button, input, select, textarea, label');
    return !e.currentTarget.contains(e.target as Node) || (!!hit && e.currentTarget.contains(hit));
  };

  // --- Drag and drop -------------------------------------------------------
  // What is being dragged is kept in a ref for the handlers, which run many
  // times a second, and in state for drawing. The state is set a moment after the
  // drag starts: changing the page inside dragstart can make a browser drop the drag.
  const dragging = useRef<Carried | null>(null);
  const [carried, setCarried] = useState<Carried | null>(null);
  const carriedIds = useMemo(() => new Set(carried?.ids), [carried]);
  const [over, setOver] = useState<Over | null>(null);
  const spring = useRef<{ path: string; timer: number } | null>(null);
  const stopSpring = () => { if (spring.current) window.clearTimeout(spring.current.timer); spring.current = null; };
  useEffect(() => stopSpring, []);
  /** The label drawn under the pointer while documents are dragged. */
  const dragLabel = useRef<HTMLDivElement>(null);
  const topTarget = useRef<HTMLDivElement>(null);
  /**
   * How many elements in the rows the pointer is inside. Every element entered
   * counts one up and every one left counts one down, so moving from one cell to
   * the next never reads as leaving, and the highlight only goes once the pointer
   * has left the rows altogether. That holds in Safari too, which gives no
   * element being moved to when a drag leaves one.
   */
  const depth = useRef(0);

  const letGo = () => { depth.current = 0; setOver(null); stopSpring(); };
  const endDrag = () => { dragging.current = null; setCarried(null); letGo(); };

  // A drag can still end up somewhere the count did not see it go, such as when
  // a row under the pointer is redrawn. Any dragover outside the tree, or a drop
  // anywhere, lets go of the highlight then.
  const highlighting = over !== null;
  useEffect(() => {
    if (!highlighting) return;
    const elsewhere = (e: DragEvent) => {
      const target = e.target as Node;
      if (!tbody.current?.contains(target) && !topTarget.current?.contains(target)) letGo();
    };
    document.addEventListener('dragover', elsewhere);
    document.addEventListener('drop', letGo);
    return () => { document.removeEventListener('dragover', elsewhere); document.removeEventListener('drop', letGo); };
  }, [highlighting]);

  const isDrag = (e: React.DragEvent, type: string) => Array.from(e.dataTransfer.types).includes(type);

  /** What a drop on `path` would do, or null when it would do nothing. */
  const effectFor = (e: React.DragEvent, path: string, topLevel = false): 'move' | 'copy' | null => {
    if (!canEdit) return null;
    // A folder saved before the current limits (a name too long, or too deep) is
    // still shown, but the server files nothing new in it, so it takes no drop.
    if (folderProblem(path)) return null;
    if (isDrag(e, DOCUMENT_DRAG_TYPE)) {
      // Dropping documents into the folder they are all in already does nothing, so the folder does not light up.
      return dragging.current?.folders.some((f) => f !== path) ? 'move' : null;
    }
    return isDrag(e, 'Files') && !topLevel ? 'copy' : null;
  };

  const drop = (e: React.DragEvent, folder: string, effect: 'move' | 'copy') => {
    e.preventDefault();
    if (effect === 'move') {
      const picked = dragging.current;
      const ids = new Set(picked?.ids ?? idsIn(e.dataTransfer.getData(DOCUMENT_DRAG_TYPE)));
      const docs = documents.filter((d) => ids.has(d.id));
      endDrag();
      if (docs.length > 0) onMove(docs, folder, picked?.selection ?? false);
    } else {
      const files = Array.from(e.dataTransfer.files);
      endDrag();
      if (files.length > 0) onDropFiles(files, folder);
    }
  };

  /** The row a drag event is over, found from the element under the pointer. */
  const rowAt = (e: React.DragEvent<HTMLElement>): Row<D> | null => {
    const node = e.target as Node;
    const el = node instanceof Element ? node : node.parentElement;
    const tr = el?.closest<HTMLElement>('tr[data-row]');
    return tr && e.currentTarget.contains(tr) ? rowById.get(tr.dataset.row ?? '') ?? null : null;
  };

  // The whole of a folder is somewhere to drop: its own row, the folders inside
  // it and every document in it, however deep. A drop goes to the nearest folder
  // around the row it lands on, and that folder lights up with everything shown
  // inside it, so it is clear where the documents will go.
  const area = {
    onDragEnter: () => { depth.current += 1; },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current > 0) return;
      setOver((o) => (o?.at === 'folder' ? null : o));
      stopSpring();
    },
    onDragOver: (e: React.DragEvent<HTMLTableSectionElement>) => {
      const row = rowAt(e);
      if (!row) return;
      const path = folderOfRow(row);
      // Resting on a closed folder opens it after a moment, so a folder inside
      // it can be reached. It opens even for documents that are all in it already.
      const closed = row.kind === 'folder' && !row.open && canEdit && !folderProblem(path)
        && (isDrag(e, DOCUMENT_DRAG_TYPE) || isDrag(e, 'Files'));
      if (!closed) stopSpring();
      else if (spring.current?.path !== path) {
        stopSpring();
        spring.current = { path, timer: window.setTimeout(() => { spring.current = null; expansion.toggle(path, true); }, SPRING_MS) };
      }
      const effect = effectFor(e, path);
      if (!effect) {
        if (over?.at === 'folder') setOver(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = effect;
      if (over?.at !== 'folder' || over.path !== path || over.effect !== effect) setOver({ at: 'folder', path, effect });
    },
    onDrop: (e: React.DragEvent<HTMLTableSectionElement>) => {
      depth.current = 0;
      const row = rowAt(e);
      const path = row && folderOfRow(row);
      const effect = path && effectFor(e, path);
      if (path && effect) drop(e, path, effect);
    },
  };

  // Its contents let the pointer through, so leaving it is only ever leaving it.
  const topLevel = {
    onDragOver: (e: React.DragEvent) => {
      const effect = effectFor(e, DEFAULT_FOLDER, true);
      if (!effect) { if (over?.at === 'top') setOver(null); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = effect;
      if (over?.at !== 'top') setOver({ at: 'top', path: DEFAULT_FOLDER, effect });
    },
    onDragLeave: () => setOver((o) => (o?.at === 'top' ? null : o)),
    onDrop: (e: React.DragEvent) => {
      const effect = effectFor(e, DEFAULT_FOLDER, true);
      if (effect) drop(e, DEFAULT_FOLDER, effect);
    },
  };

  // Files let go anywhere else over the tree would otherwise make the browser
  // leave the page to open them, so they are caught here and nothing happens.
  const guard = {
    onDragOver: (e: React.DragEvent) => {
      if (e.defaultPrevented || !isDrag(e, 'Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    },
    onDrop: (e: React.DragEvent) => {
      if (e.defaultPrevented || !isDrag(e, 'Files')) return;
      e.preventDefault();
      letGo();
    },
  };

  const startDrag = (e: React.DragEvent, doc: D) => {
    // A selected document carries the whole selection with it. One that is not
    // selected goes on its own and leaves the selection as it was.
    const withSelection = selected.has(doc.id);
    const docs = withSelection ? documents.filter((d) => selected.has(d.id)) : [doc];
    const ids = docs.map((d) => d.id);
    e.dataTransfer.setData(DOCUMENT_DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    // Under the pointer, the document's name, or how many are going. Set here
    // rather than drawn, since the page cannot redraw before the drag begins.
    const tag = dragLabel.current;
    const text = tag?.querySelector('[data-text]');
    if (tag && text) {
      text.textContent = docs.length === 1 ? docs[0].name : `Moving ${docs.length} documents`;
      e.dataTransfer.setDragImage(tag, 14, 16);
    }
    const picked: Carried = { ids, folders: [...new Set(docs.map((d) => folderPath(d.folder)))], selection: withSelection };
    dragging.current = picked;
    window.setTimeout(() => { if (dragging.current === picked) setCarried(picked); }, 0);
  };

  const indent = (level: number): React.CSSProperties => ({ paddingLeft: `calc(0.75rem + ${level - 1} * var(--tree-indent))` });
  /** Whether a row is inside the folder a drag would land in, so the whole block lights up. */
  const lit = (path: string) => over?.at === 'folder' && within(path, over.path);
  const hint = (path: string) => over?.at === 'folder' && over.path === path && (
    <span className="pointer-events-none ml-auto shrink-0 rounded bg-brand-600 px-1.5 py-0.5 text-[11px] font-medium text-white">
      {over.effect === 'move' ? 'Move here' : 'Upload here'}
    </span>
  );
  const allInTop = carried?.folders.length === 1 && carried.folders[0] === DEFAULT_FOLDER;
  const many = (carried?.ids.length ?? 0) > 1;

  return (
    <div {...guard} onKeyDown={onAreaKeyDown} className={full ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      <div className="relative shrink-0">
        <TableToolbar fullSizeButton={rows.length > 0}>{toolbar}</TableToolbar>
        {carried && (
          // Over the toolbar rather than above it, so the rows do not jump down
          // under the pointer the moment a drag begins.
          <div ref={topTarget} {...topLevel}
            className={cx('absolute inset-1.5 flex items-center gap-2 rounded-lg border-2 border-dashed px-3 text-[13px] transition-colors [&_*]:pointer-events-none',
              over?.at === 'top' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-300 bg-white text-ink-600')}>
            <Icon name="layers" className="size-4 shrink-0" />
            <span className="font-medium">Top level</span>
            <span className="truncate text-ink-500">
              {allInTop
                ? `${many ? 'All already' : 'Already'} in ${DEFAULT_FOLDER}, the top-level folder`
                : `Drop here to file ${many ? 'them' : 'it'} in ${DEFAULT_FOLDER}`}
            </span>
          </div>
        )}
      </div>

      {canEdit && <p role="status" className="sr-only">{spoken}</p>}
      {canEdit && (
        // Drawn out of sight; a drag takes its picture from it.
        <div ref={dragLabel} aria-hidden
          className="pointer-events-none fixed top-[-1000px] left-0 flex max-w-xs items-center gap-2 rounded-lg bg-ink-900 px-3 py-1.5 text-[13px] font-medium text-white shadow-lg">
          <Icon name="document" className="size-4 shrink-0" />
          <span data-text className="truncate" />
        </div>
      )}

      {rows.length === 0 ? empty : (
        // Full size, the rows scroll under their headings inside the window.
        <div className={cx('-mx-px overflow-x-auto', full && 'min-h-0 flex-1 overflow-y-auto')}>
          <table role="treegrid" aria-label={label} aria-multiselectable={canEdit || undefined}
            className={cx('w-full border-collapse text-sm [--tree-indent:0.75rem] sm:[--tree-indent:1.25rem]',
              // While anything is dragged over the rows, only the rows and their
              // cells are under the pointer, so nothing redrawn inside a cell can
              // throw the count of elements entered and left.
              (carried || over) && '[&_td_*]:pointer-events-none')}>
            <thead>
              <tr>
                {/* A name may break anywhere, so without a floor the other columns
                    squeeze this one to a letter a line once folders are nested. */}
                {onSort
                  ? <SortTH column="name" label="Document" sort={sort} onSort={onSort} pinned className="min-w-44 sm:min-w-64" />
                  : <TH pinned className="min-w-44 sm:min-w-64">Document</TH>}
                {columns.map((c, i) => (c.sortable && onSort
                  ? <SortTH key={c.key} column={c.key} label={c.label} sort={sort} onSort={onSort} className={c.className} width={c.width} align={c.align} />
                  : <TH key={c.key} className={c.className} width={c.width} align={c.align} pinned={actionsAt(i) && 'end'}>{c.label}</TH>))}
              </tr>
            </thead>
            <tbody ref={tbody} onKeyDown={onKeyDown} {...area}>
              {rows.map((row) => {
                const shared = {
                  role: 'row',
                  'data-row': row.id,
                  ref: (el: HTMLTableRowElement | null) => { if (el) rowRefs.current.set(row.id, el); else rowRefs.current.delete(row.id); },
                  'aria-level': row.level, 'aria-setsize': row.setsize, 'aria-posinset': row.posinset,
                  tabIndex: row.id === tabStop ? 0 : -1,
                  onFocus: () => setActive(row.id),
                };
                const inDrop = lit(folderOfRow(row));

                if (row.kind === 'folder') {
                  const { node } = row;
                  const target = over?.at === 'folder' && over.path === node.path;
                  return (
                    <tr key={row.id} {...shared}
                      aria-expanded={row.open}
                      aria-label={`${node.name}, ${node.count} document${node.count === 1 ? '' : 's'}`}
                      // Shift-clicking down the rows to pick a range can land on a folder, which
                      // would otherwise select the text of everything between the two clicks.
                      onMouseDown={canEdit ? (e) => { if (e.shiftKey) e.preventDefault(); } : undefined}
                      onClick={() => { setActive(row.id); expansion.toggle(node.path); }}
                      className={cx('group cursor-pointer outline-none transition-colors',
                        inDrop ? 'bg-brand-50' : 'hover:bg-ink-50 focus-visible:bg-brand-50/50')}>
                      <td role="gridcell" className={cx(CELL, pinnedName({ drop: inDrop, selected: false, folder: true }))} style={indent(row.level)}>
                        <span className="flex items-center gap-1.5">
                          <Icon name="chevron" className={cx('size-4 shrink-0 text-ink-400 transition-transform', !row.open && '-rotate-90')} />
                          <Icon name="folder" className={cx('size-4 shrink-0', target ? 'text-brand-600' : 'text-ink-400')} />
                          <span className={cx('min-w-0 font-semibold text-ink-900', nameFit(node.name))}>{node.name}</span>
                          <span className="shrink-0 text-[13px] text-ink-500">({node.count})</span>
                          {hint(node.path)}
                        </span>
                      </td>
                      {columns.map((c, i) => (
                        <td key={c.key} role="gridcell"
                          className={cx(CELL, c.className, actionsAt(i) && pinnedActions({ drop: inDrop, selected: false, folder: true }))} />
                      ))}
                    </tr>
                  );
                }

                const { doc } = row;
                const cells = renderCells(doc);
                const isSelected = canEdit && selected.has(doc.id);
                return (
                  <tr key={row.id} {...shared}
                    aria-selected={canEdit ? isSelected : undefined}
                    draggable={canEdit || undefined}
                    onDragStart={canEdit ? (e) => startDrag(e, doc) : undefined}
                    onDragEnd={canEdit ? endDrag : undefined}
                    // Shift would otherwise select the text between the two clicks.
                    onMouseDown={canEdit ? (e) => { if (e.shiftKey) e.preventDefault(); } : undefined}
                    onClick={canEdit ? (e) => {
                      if (onControl(e)) return;
                      if (e.shiftKey) { extendTo(row.id); focusRow(row.id); }
                      else if (e.metaKey || e.ctrlKey) toggle(row);
                    } : undefined}
                    className={cx('group outline-none transition-colors',
                      inDrop ? 'bg-brand-50' : isSelected ? 'bg-brand-50/60 focus-visible:bg-brand-50' : 'focus-visible:bg-brand-50/50',
                      canEdit && 'cursor-grab active:cursor-grabbing',
                      carriedIds.has(doc.id) && 'opacity-50')}>
                    <td role="gridcell" className={cx(CELL, pinnedName({ drop: inDrop, selected: isSelected, folder: false }))} style={indent(row.level)}>
                      <span className="flex items-start gap-1.5">
                        {canEdit ? (
                          // Where a folder has its arrow, so a document lines up with the
                          // folders beside it. The label reaches past the box, so it is
                          // easy to hit with a finger as well.
                          <label className="relative mt-0.5 flex size-4 shrink-0 cursor-pointer select-none before:absolute before:-inset-1.5 before:content-['']">
                            <input type="checkbox" checked={isSelected} aria-label={`Select ${doc.name}`}
                              className="m-0 size-4 cursor-pointer"
                              onChange={(e) => {
                                if ((e.nativeEvent as MouseEvent).shiftKey) extendTo(row.id); else toggle(row);
                              }} />
                          </label>
                        ) : (
                          // As wide as a folder's chevron, so a document lines up with the folders beside it.
                          <span className="size-4 shrink-0" />
                        )}
                        <Icon name="document" className="mt-0.5 size-4 shrink-0 text-ink-400" />
                        {/* A file name with no spaces may break anywhere, so it never widens the table past a phone's screen. */}
                        <span className={cx('min-w-0', nameFit(doc.name))}>{renderName(doc)}</span>
                      </span>
                    </td>
                    {columns.map((c, i) => (
                      <td key={c.key} role="gridcell"
                        className={cx(CELL, c.className, c.align === 'right' && 'text-right', actionsAt(i) && pinnedActions({ drop: inDrop, selected: isSelected, folder: false }))}>
                        {cells[i]}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The ids a dragged document carries, read back from the drag's data. */
function idsIn(data: string): string[] {
  try {
    const ids: unknown = JSON.parse(data);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/**
 * What can be done with the documents selected, shown while there are any. The
 * page puts it in the tree's toolbar.
 */
export function SelectionBar({ count, onMove, onClear, ref }: {
  count: number;
  onMove: () => void;
  onClear: () => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    // It never gives way to what is beside it: squeezed, it would wrap and push the rows below down.
    <div ref={ref} role="group" aria-label="Selected documents" className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="mr-1 text-[13px] font-semibold text-ink-900 tabular">{count} selected</span>
      <Button size="sm" variant="primary" icon={<Icon name="folder" className="size-4" />} onClick={onMove}>Move to folder</Button>
      <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection">Clear</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * Moving documents without dragging them, one from its row or the whole
 * selection: pick a folder from the tree, or type a path for one that does not
 * exist yet.
 */
export function MoveToFolderDialog({ documents, folders, onClose, onMove }: {
  /** What is being moved. The dialog is open while there is anything. */
  documents: TreeDocument[];
  /** Every folder there is, as paths. */
  folders: string[];
  onClose: () => void;
  onMove: (folder: string) => void;
}) {
  const open = documents.length > 0;
  const homes = [...new Set(documents.map((d) => folderPath(d.folder)))];
  /** The folder they are all in, or null when they come from more than one. */
  const current = homes.length === 1 ? homes[0] : null;
  const [choice, setChoice] = useState<string | null>(current);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A fresh start each time the dialog opens on something to move. It is done
  // while rendering rather than in an effect, so the focus call below already
  // sees the folder they are in chosen.
  const movingNow = documents.map((d) => d.id).join('\n') || null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (movingNow !== openedFor) {
    setOpenedFor(movingNow);
    setChoice(current); setTyped(''); setError(null);
  }
  // The dialog puts focus on its first field, which here is the first folder in
  // the list. Starting on the folder the documents are in instead means the arrow
  // keys move from where they are, as they do in any other group of choices.
  // This runs after the dialog's own focus call, since a child's effects run
  // first. Documents from several folders have no folder chosen, so focus stays
  // on the first one.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openedFor) list.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
  }, [openedFor]);

  const options = useMemo(() => listFolders(buildFolderTree([], [DEFAULT_FOLDER, ...folders])), [folders]);

  const submit = () => {
    const target = typed.trim() ? folderPath(typed) : choice;
    const problem = typed.trim() ? folderProblem(typed) : null;
    if (problem) { setError(problem); return; }
    if (!target) { setError('Choose a folder, or name a new one.'); return; }
    // Choosing the folder they are all in already leaves them there, as dropping them there does.
    if (target === current) { onClose(); return; }
    onMove(target);
  };

  return (
    <FormModal open={open} onClose={onClose} title={documents.length > 1 ? `Move ${documents.length} documents` : 'Move to folder'}
      submitLabel="Move" onSubmit={submit}
      description={documents.length > 1 ? `Choose where these ${documents.length} documents go.`
        : open ? `Choose where “${documents[0].name}” goes.` : undefined}>
      <div ref={list} role="radiogroup" aria-label="Folders"
        className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-ink-200 p-1.5 [--tree-indent:0.75rem] sm:[--tree-indent:1.25rem]">
        {options.map((o) => {
          // A folder saved before the current limits is shown, but nothing new can go in it.
          const blocked = folderProblem(o.path);
          const chosen = !typed.trim() && choice === o.path;
          return (
            <label key={o.path}
              style={{ paddingLeft: `calc(0.5rem + ${o.level - 1} * var(--tree-indent))` }}
              className={cx('flex items-center gap-2 rounded-md py-1.5 pr-2 text-[13px] transition-colors',
                blocked ? 'cursor-not-allowed text-ink-400' : chosen ? 'cursor-pointer bg-brand-50 text-brand-800' : 'cursor-pointer text-ink-800 hover:bg-ink-50')}>
              {/* Named by its whole path: the indent cannot be heard, and two folders in different places can share a name. */}
              <input type="radio" name="move-folder" value={o.path} checked={chosen} disabled={!!blocked}
                aria-label={[folderLabel(o.path), o.path === current && 'current folder', blocked].filter(Boolean).join(', ')}
                onChange={() => { setChoice(o.path); setTyped(''); setError(null); }} />
              <Icon name="folder" className="size-4 shrink-0 text-ink-400" />
              <span className="min-w-0">
                <span className="block truncate">{o.name}</span>
                {blocked && <span className="block text-[11px] text-ink-500">{blocked}</span>}
              </span>
              {o.path === current && <Badge tone="neutral" className="ml-auto shrink-0">Current</Badge>}
            </label>
          );
        })}
      </div>
      <Field label="Or a new folder" hint={error ? undefined : 'Use / to put one folder inside another, such as Financing/Series B.'}>
        <Input value={typed} onChange={(e) => { setTyped(e.target.value); setError(null); }} placeholder="Financing/Series B"
          aria-invalid={error ? true : undefined} />
        {/* Read out as it appears, since focus is usually on the Move button rather than here when it does. */}
        {error && <span role="alert" className="mt-1 block text-[12px] text-red-600">{error}</span>}
      </Field>
    </FormModal>
  );
}

/**
 * Making a folder before anything is in it. It is only kept on this page:
 * folders are stored as part of their documents, so one with none in it is not
 * saved anywhere, and the dialog says so.
 */
export function NewFolderDialog({ open, folders, inside, onClose, onCreate }: {
  open: boolean;
  folders: string[];
  /** The folder to make it in, unless someone picks another; null for the top level. */
  inside: string | null;
  onClose: () => void;
  onCreate: (path: string) => void;
}) {
  const [parent, setParent] = useState(inside ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A fresh start each time it opens, set while rendering so the old name never shows for a moment.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setParent(inside ?? ''); setName(''); setError(null); }
  }

  const options = useMemo(() => listFolders(buildFolderTree([], folders)), [folders]);

  const submit = () => {
    if (!name.trim()) { setError('Name the folder.'); return; }
    const raw = parent ? `${parent}/${name}` : name;
    const problem = folderProblem(raw);
    if (problem) { setError(problem); return; }
    const path = folderPath(raw);
    if (options.some((o) => o.path === path)) { setError('There is already a folder with that name here.'); return; }
    onCreate(path);
  };

  return (
    <FormModal open={open} onClose={onClose} title="New folder" submitLabel="Create folder" onSubmit={submit}
      description="A folder is saved once a document is in it. Until then it is only on this page, and it is gone when you leave or reload.">
      <Field label="Folder name" required error={error ?? undefined}>
        <Input value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="Series B" required />
      </Field>
      <Field label="Inside">
        <Select value={parent} onChange={(e) => { setParent(e.target.value); setError(null); }}>
          <option value="">Top level</option>
          {options.map((o) => <option key={o.path} value={o.path}>{folderLabel(o.path)}</option>)}
        </Select>
      </Field>
    </FormModal>
  );
}
