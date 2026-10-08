/**
 * Sortable table columns. A header is a button: the first click sorts that
 * column ascending, the next one descending, and the column says which way it
 * is sorted with an arrow and with aria-sort, so a screen reader hears it too.
 * Rows without a value (a dash on screen) stay at the bottom either way.
 */
import { useState, type ReactNode } from 'react';
import { cx } from './style.ts';

export type SortDirection = 'asc' | 'desc';
export interface Sort<K extends string> { key: K; direction: SortDirection }

/** The sort a table starts with, and what clicking a header does to it. */
export function useSort<K extends string>(initial: Sort<K>) {
  const [sort, setSort] = useState<Sort<K>>(initial);
  const toggle = (key: K) => setSort((s) => (s.key === key
    ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' }));
  return { sort, toggle, setSort };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compares two cell values: text as a reader expects (A before b, 2 before 10), numbers by size, blanks last. */
function compare(a: string | number | null | undefined, b: string | number | null | undefined, direction: SortDirection): number {
  const blankA = a == null || a === '';
  const blankB = b == null || b === '';
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  const order = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return direction === 'asc' ? order : -order;
}

/**
 * The rows in the order the sort asks for, as a new array. Ties keep the order
 * `then` gives them (by name, say), so equal rows do not jump about between clicks.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[], sort: Sort<K>,
  value: (row: T, key: K) => string | number | null | undefined,
  then?: (a: T, b: T) => number,
): T[] {
  return [...rows].sort((a, b) => compare(value(a, sort.key), value(b, sort.key), sort.direction) || (then ? then(a, b) : 0));
}

/** Up and down, faint, on a column that is not sorted; one arrow, darker, on the one that is. */
function SortArrow({ direction, className }: { direction: SortDirection | null; className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={cx('size-3 shrink-0', direction ? 'text-ink-700' : 'text-ink-300 group-hover:text-ink-500', className)}
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {direction !== 'desc' && <path d={direction ? 'M6 10V2.5M3 5.5l3-3 3 3' : 'M3.5 4.5 6 2l2.5 2.5'} />}
      {direction !== 'asc' && <path d={direction ? 'M6 2v7.5M3 6.5l3 3 3-3' : 'M3.5 7.5 6 10l2.5-2.5'} />}
    </svg>
  );
}

/**
 * A column header that sorts its table. It is drawn like the table's other
 * headers (TH in ui.tsx) and holds a button, so it is reached with Tab and
 * sorts with Enter or Space as well as with a click.
 */
export function SortTH<K extends string>({ label, column, sort, onSort, align = 'left', width, title, pinned, className }: {
  label: ReactNode; column: K; onSort: (key: K) => void;
  /** The table's sort, or null while the rows keep the page's own order and no heading shows an arrow. */
  sort: Sort<K> | null;
  align?: 'left' | 'right' | 'center'; width?: string | number; className?: string;
  /** What the heading means, when the label is short for it ("I&O %"). */
  title?: string;
  /**
   * The first column, kept in view while the table scrolls sideways (from small
   * screens up): it sits over the other headings, and under the app's header
   * (z-20, AppHeader.tsx) when the page scrolls.
   */
  pinned?: boolean;
}) {
  const active = sort?.key === column ? sort.direction : null;
  return (
    <th style={{ width }} aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}
      className={cx(
        'sticky top-0 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide',
        'text-ink-500 border-b border-ink-200 whitespace-nowrap',
        pinned ? 'z-[15] bg-ink-50 sm:left-0 sm:shadow-[inset_-1px_0_0_var(--color-ink-200)]' : 'z-10 bg-ink-50/95 backdrop-blur',
        // Said outright: a heading cell is centred unless told otherwise.
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left', className,
      )}>
      {/* The arrow sits on the inner side of the label, so right-aligned headings still line up with their
          numbers, and in the cell's padding rather than beside the label: a column is no wider for being sortable.
          It is as wide as that padding (12px) and starts where the label ends, so it never reaches into the next
          heading's arrow, nor out of the table at either end. */}
      <button type="button" onClick={() => onSort(column)} title={title}
        className={cx('group -mx-1 inline-flex items-center rounded px-1 uppercase tracking-wide transition-colors',
          'hover:text-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500',
          active && 'text-ink-800')}>
        <span className="relative">
          {label}
          <SortArrow direction={active} className={cx('absolute top-1/2 -translate-y-1/2', align === 'right' ? 'right-full' : 'left-full')} />
        </span>
      </button>
    </th>
  );
}
