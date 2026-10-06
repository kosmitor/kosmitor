import type { Award, CompanyData, Convertible, ISODate, Issuance, LedgerEntry } from './types.ts';
import { roundShares } from './util.ts';

/**
 * The cap table as it stood on a date (math audit CAP-1; docs/design/dated-ledger.md,
 * Option A). The security rows hold their state of today, because the routes change
 * them in place: a transfer or repurchase lowers a certificate or closes it, an
 * exercise or cancellation raises a grant's counts, a conversion closes a convertible.
 * Each of those routes also writes a dated entry to the ledger, the way the Open Cap
 * Format records StockTransfer, StockRepurchase, EquityCompensationExercise,
 * EquityCompensationCancellation and ConvertibleConversion.
 *
 * rewindToDate starts from today's rows and undoes every entry dated after `asOf`.
 * What an event created (the buyer's certificate, the shares issued on an exercise or
 * a conversion) is dated the event, so the date filters already leave it out.
 *
 * A row whose history the ledger cannot rebuild keeps today's state, as every view
 * read it before the ledger was loaded: rows written before the ledger existed, an
 * import, which records exercised options with no date, or a row edited by hand since.
 */

/** Statuses the transfer and repurchase routes close a certificate with, by entry type. */
const CLOSES: Partial<Record<LedgerEntry['type'], Issuance['status']>> = { TRANSFER: 'TRANSFERRED', REPURCHASE: 'REPURCHASED' };
/** Entries that take options off a grant: the cancel route's, and an import's dated forfeitures. */
const CANCELS = new Set<LedgerEntry['type']>(['CANCELLATION', 'FORFEITURE', 'EXPIRATION']);
/** Statuses the exercise and cancel routes give a grant with nothing left outstanding. */
const USED_UP = new Set<Award['status']>(['EXERCISED', 'CANCELLED', 'EXPIRED', 'FORFEITED']);

/** Share counts that agree but for the rounding of a split-adjusted quantity. */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 + 1e-9 * Math.abs(b);

/**
 * splitFactor (splits.ts): the splits after `on` and on or before `to`. Restated
 * here so that normalizeSplits can call this module without the two importing
 * each other.
 */
function splitsBetween(data: CompanyData, on: ISODate, to: ISODate): number {
  let f = 1;
  for (const s of data.stockSplits) if (s.date > on && s.date <= to) f *= s.ratio;
  return f;
}

/**
 * The snapshot as of `asOf`: every transfer, repurchase, exercise, cancellation
 * and conversion dated after it is undone, and only the entries on or before it
 * are kept, so rewinding twice to the same date is a no-op. With nothing dated
 * after `asOf`, today's view among them, the snapshot is returned as it is.
 *
 * Works on rows in their own units or already split-adjusted by normalizeSplits,
 * which restates the entries it keeps with the rows.
 */
export function rewindToDate(data: CompanyData, asOf: ISODate): CompanyData {
  const ledger = data.ledger ?? [];
  const later = new Set<string>();
  for (const e of ledger) if (e.date > asOf) later.add(e.securityId);
  const convertedLater = data.convertibles.some((c) => c.status === 'CONVERTED' && c.convertedOn != null && c.convertedOn > asOf);
  if (later.size === 0 && !convertedLater) return data;

  const bySecurity = new Map<string, LedgerEntry[]>();
  for (const e of ledger) {
    if (!later.has(e.securityId)) continue;
    const list = bySecurity.get(e.securityId);
    if (list) list.push(e); else bySecurity.set(e.securityId, [e]);
  }
  const entriesOf = (id: string): LedgerEntry[] => bySecurity.get(id) ?? [];

  return {
    ...data,
    issuances: data.issuances.map((i) => (later.has(i.id) ? rewindCertificate(data, i, entriesOf(i.id), asOf) : i)),
    awards: data.awards.map((a) => (later.has(a.id) ? rewindGrant(data, a, entriesOf(a.id), asOf) : a)),
    convertibles: data.convertibles.map((c) => rewindConvertible(c, entriesOf(c.id), asOf)),
    ...(data.ledger ? { ledger: ledger.filter((e) => e.date <= asOf) } : {}),
  };
}

/**
 * A certificate before the transfers and repurchases dated after `asOf`. A partial
 * one lowered the quantity; one for everything left closed the certificate and kept
 * the quantity it held. So what the holder had on `asOf` is what they hold today, or
 * nothing once closed, plus every later entry restated in the certificate's units.
 */
function rewindCertificate(data: CompanyData, i: Issuance, entries: LedgerEntry[], asOf: ISODate): Issuance {
  const moves = entries.filter((e) => CLOSES[e.type] != null);
  const undone = moves.filter((e) => e.date > asOf);
  if (undone.length === 0) return i;
  // An entry with no quantity cannot be undone, so the certificate's history cannot be rebuilt.
  if (moves.some((e) => e.quantity == null)) return i;
  const units = (e: LedgerEntry): number => e.quantity! / splitsBetween(data, i.issueDate, e.date);

  let held: number;
  if (i.status === 'OUTSTANDING') held = i.quantity;
  else if (Object.values(CLOSES).includes(i.status) && moves.some((e) => CLOSES[e.type] === i.status && near(units(e), i.quantity))) held = 0;
  // Closed with no entry for what it last held (an edit, a row older than the ledger), or
  // cancelled or converted by an edit, which the ledger does not date: today's state.
  else return i;

  held = roundShares(held + undone.reduce((s, e) => s + units(e), 0));
  return held > 0 ? { ...i, quantity: held, status: 'OUTSTANDING' } : i;
}

/**
 * A grant before the exercises and cancellations dated after `asOf`, each restated
 * in the grant's units. A count the ledger only partly explains (an import's
 * exercised options, a grant older than the ledger) keeps the part it does not
 * explain from the grant date, as today. One the ledger claims more of than the
 * grant holds was edited since, so it is read as today.
 */
function rewindGrant(data: CompanyData, a: Award, entries: LedgerEntry[], asOf: ISODate): Award {
  const units = (e: LedgerEntry): number => (e.quantity ?? 0) / splitsBetween(data, a.grantDate, e.date);
  const undo = (counts: (e: LedgerEntry) => boolean, recorded: number): number => {
    const own = entries.filter(counts);
    const undone = own.filter((e) => e.date > asOf);
    if (undone.length === 0 || own.some((e) => e.quantity == null)) return recorded;
    const onLedger = own.reduce((s, e) => s + units(e), 0);
    if (onLedger > recorded && !near(onLedger, recorded)) return recorded;
    return Math.max(0, roundShares(recorded - undone.reduce((s, e) => s + units(e), 0)));
  };
  const exercisedQuantity = undo((e) => e.type === 'EXERCISE', a.exercisedQuantity);
  const cancelledQuantity = undo((e) => CANCELS.has(e.type), a.cancelledQuantity);
  if (exercisedQuantity === a.exercisedQuantity && cancelledQuantity === a.cancelledQuantity) return a;

  // The routes mark a grant used up when nothing is left. A used-up status the counts
  // do not explain was set by an edit, which the ledger does not date: it stays.
  const usedUpByCounts = USED_UP.has(a.status) && roundShares(a.quantity - a.exercisedQuantity - a.cancelledQuantity) <= 0;
  const reopens = usedUpByCounts && roundShares(a.quantity - exercisedQuantity - cancelledQuantity) > 0;
  return { ...a, exercisedQuantity, cancelledQuantity, status: reopens ? 'OUTSTANDING' : a.status };
}

/**
 * A convertible that converted after `asOf` was still outstanding then. The
 * convert route dates the conversion on the instrument and in the ledger; an
 * edit can give either, or neither, and then nothing says when.
 */
function rewindConvertible(c: Convertible, entries: LedgerEntry[], asOf: ISODate): Convertible {
  if (c.status !== 'CONVERTED') return c;
  const on = c.convertedOn ?? entries.filter((e) => e.type === 'CONVERSION').map((e) => e.date).sort()[0] ?? null;
  return on != null && on > asOf ? { ...c, status: 'OUTSTANDING', convertedOn: null, convertedIntoShareClassId: null } : c;
}
