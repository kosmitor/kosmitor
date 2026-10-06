/** Joins class names, dropping anything falsy so `cond && 'cls'` works inline. */
export const cx = (...parts: unknown[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');

/** The one look every text field, select and date field shares. */
export const INPUT_CLASS =
  'w-full h-9 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-900 placeholder:text-ink-400 ' +
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition ' +
  'disabled:bg-ink-50 disabled:text-ink-500';
