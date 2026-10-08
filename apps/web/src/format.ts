/**
 * Display helpers. Money is in cents, per-share prices in micro-cents. Numbers,
 * money and dates are written the way locale.locale and locale.currency in
 * kosmitor.config.json say.
 */
import { config } from './config.ts';

const locale = (): string => config.locale.locale;

let symbol: string | null = null;
/** The currency's own sign in this locale ("$" for US dollars), for the short forms Intl has no style for. */
export function currencySymbol(): string {
  if (symbol == null) {
    const { currency } = config.locale;
    symbol = new Intl.NumberFormat(locale(), { style: 'currency', currency }).formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency;
  }
  return symbol;
}

/** An example amount for an input's placeholder, in the configured currency: "$2,000,000". */
export const amountHint = (dollars: number): string => `${currencySymbol()}${dollars.toLocaleString(locale())}`;

export function money(cents: number | null | undefined, opts: { compact?: boolean; decimals?: number } = {}): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const v = cents / 100;
  if (opts.compact) {
    const abs = Math.abs(v);
    const sign = currencySymbol();
    if (abs >= 1e9) return `${sign}${(v / 1e9).toFixed(abs >= 1e10 ? 1 : 2)}B`;
    if (abs >= 1e6) return `${sign}${(v / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
    if (abs >= 1e3) return `${sign}${(v / 1e3).toFixed(0)}K`;
  }
  return v.toLocaleString(locale(), {
    style: 'currency', currency: config.locale.currency,
    minimumFractionDigits: opts.decimals ?? 2, maximumFractionDigits: opts.decimals ?? 2,
  });
}

export function pps(micro: number | null | undefined): string {
  if (micro == null || !Number.isFinite(micro)) return '—';
  const v = micro / 1e6;
  if (v === 0) return `${currencySymbol()}0.00`;
  const decimals = Math.abs(v) < 0.01 ? 6 : Math.abs(v) < 1 ? 4 : 2;
  return `${currencySymbol()}${v.toFixed(decimals)}`;
}

export function shares(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.abs(n % 1) > 1e-6
    ? n.toLocaleString(locale(), { maximumFractionDigits: 4 })
    : Math.round(n).toLocaleString(locale());
}

export function percent(fraction: number | null | undefined, decimals = 2): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function multiple(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x) || x === 0) return '—';
  if (x > 1000) return '>1000x';
  return `${x.toFixed(2)}x`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale(), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relativeDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Day against day: measured from this moment, anything dated today read as "yesterday" every afternoon.
  const days = Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return days < 45 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
  return -days < 45 ? `${-days} days ago` : `${Math.round(-days / 30)} months ago`;
}

/** A length of time as a sentence says it: "an hour", "3 hours", "30 minutes". */
export function duration(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? 'an hour' : `${minutes / 60} hours`;
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/** A file size as a list shows it: "820 B", "14 KB", "2.3 MB". */
export const fileSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

export const today = (): string => new Date().toISOString().slice(0, 10);

/** Takes the currency sign out of typed money, whichever currency the app shows. */
const withoutSymbol = (input: string): string => input.split(currencySymbol()).join('');

/** Parses a user-typed money amount into cents. Accepts "1.2m", "$450,000", "3k". */
export function parseMoney(input: string): number {
  const raw = withoutSymbol(String(input).trim()).toLowerCase().replace(/[$,\s]/g, '');
  if (!raw) return 0;
  const m = raw.match(/^(-?[\d.]+)([kmb])?$/);
  if (!m) return 0;
  const mult = m[2] === 'b' ? 1e9 : m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
  return Math.round(Number(m[1]) * mult * 100);
}

/** Parses a user-typed per-share price into micro-cents. */
export function parsePPS(input: string): number {
  const raw = withoutSymbol(String(input).trim()).replace(/[$,\s]/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 1e6) : 0;
}

/**
 * A number as a field starts out holding it: grouped with commas, which is what
 * parseMoney and parseShares read, whatever locale the app displays in.
 */
export const fieldNumber = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

export function parseShares(input: string): number {
  const n = Number(String(input).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Parses "12.5" or "12.5%" into the fraction 0.125. */
export function parsePercent(input: string): number {
  const n = Number(String(input).replace(/[%\s]/g, ''));
  return Number.isFinite(n) ? n / 100 : 0;
}

export const RELATION_LABELS: Record<string, string> = {
  FOUNDER: 'Founder', EMPLOYEE: 'Employee', FORMER_EMPLOYEE: 'Former employee',
  ADVISOR: 'Advisor', CONTRACTOR: 'Contractor', INVESTOR: 'Investor',
  BOARD_MEMBER: 'Board member', OTHER: 'Other',
};

export const AWARD_LABELS: Record<string, string> = {
  ISO: 'ISO', NSO: 'NSO', RSU: 'RSU', RSA: 'RSA', SAR: 'SAR',
  PHANTOM: 'Phantom', GROWTH_SHARE: 'Growth share',
};

export const INSTRUMENT_LABELS: Record<string, string> = {
  SAFE_PRE: 'SAFE (pre-money)', SAFE_POST: 'SAFE (post-money)',
  NOTE: 'Convertible note', KISS: 'KISS',
};

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** Deterministic colour per name, from brand.colors.initialsFallback, so avatars stay stable between renders. */
export function avatarColor(name: string): string {
  const palette = config.brand.colors.initialsFallback;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}
