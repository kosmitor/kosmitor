import { CORRECTED_TERMS, type Award, type CompanyData, type Convertible, type CorrectedField, type ISODate, type Issuance, type LedgerEntry, type Warrant } from './types.ts';
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
 *
 * An edit of a count (PATCH) writes a CORRECTION entry: the signed change to one
 * field, dated from when the record should read the new value. Dated the security's
 * own date, it says the record was wrong all along and holds for every date.
 */

/** Statuses the transfer, repurchase and cancel routes close a certificate with, by entry type. */
const CLOSES: Partial<Record<LedgerEntry['type'], Issuance['status']>> = { TRANSFER: 'TRANSFERRED', REPURCHASE: 'REPURCHASED', CANCELLATION: 'CANCELLED' };
/** Statuses the cancel route closes a warrant with, by entry type. */
const ENDS_WARRANT: Partial<Record<LedgerEntry['type'], Warrant['status']>> = { CANCELLATION: 'CANCELLED', EXPIRATION: 'EXPIRED' };
/** Statuses the convert, repay and cancel routes settle a convertible with, by entry type. */
const SETTLES: Partial<Record<LedgerEntry['type'], Convertible['status']>> = { CONVERSION: 'CONVERTED', REPAYMENT: 'REPAID', CANCELLATION: 'CANCELLED' };
/** Entries that take options off a grant: the cancel route's, and an import's dated forfeitures. */
const CANCELS = new Set<LedgerEntry['type']>(['CANCELLATION', 'FORFEITURE', 'EXPIRATION']);
/** Statuses the exercise and cancel routes give a grant with nothing left outstanding. */
const USED_UP = new Set<Award['status']>(['EXERCISED', 'CANCELLED', 'EXPIRED', 'FORFEITED']);

/** Share counts that agree but for the rounding of a split-adjusted quantity. */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 + 1e-9 * Math.abs(b);
/** A CORRECTION of `field`. */
const fixes = (field: CorrectedField) => (e: LedgerEntry): boolean => e.type === 'CORRECTION' && e.field === field;

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
    warrants: data.warrants.map((w) => (later.has(w.id) ? rewindWarrant(data, w, entriesOf(w.id), asOf) : w)),
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
  const corrections = entries.filter(fixes('quantity'));
  const undone = moves.filter((e) => e.date > asOf);
  const uncorrected = corrections.filter((e) => e.date > asOf);
  if (undone.length === 0 && uncorrected.length === 0) return i;
  // An entry with no quantity cannot be undone, so the certificate's history cannot be rebuilt.
  if (moves.some((e) => e.quantity == null) || corrections.some((e) => e.quantity == null)) return i;
  const units = (e: LedgerEntry): number => e.quantity! / splitsBetween(data, i.issueDate, e.date);

  let held: number;
  if (i.status === 'OUTSTANDING') held = i.quantity;
  else if (undone.length > 0 && Object.values(CLOSES).includes(i.status) && moves.some((e) => CLOSES[e.type] === i.status && near(units(e), i.quantity))) held = 0;
  // Closed with no entry for what it last held (an edit, a row older than the ledger), or
  // converted, which the ledger does not date on the certificate: today's state.
  else return i;

  held = roundShares(held + undone.reduce((s, e) => s + units(e), 0) - uncorrected.reduce((s, e) => s + units(e), 0));
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
  const undo = counter(data, a.grantDate, entries, asOf);
  const quantity = undo(fixes('quantity'), a.quantity);
  const exercisedQuantity = undo((e) => e.type === 'EXERCISE' || fixes('exercisedQuantity')(e), a.exercisedQuantity);
  const cancelledQuantity = undo((e) => CANCELS.has(e.type) || fixes('cancelledQuantity')(e), a.cancelledQuantity);
  if (quantity === a.quantity && exercisedQuantity === a.exercisedQuantity && cancelledQuantity === a.cancelledQuantity) return a;

  // The routes mark a grant used up when nothing is left. A used-up status the counts
  // do not explain was set by an edit, which the ledger does not date: it stays.
  const usedUpByCounts = USED_UP.has(a.status) && roundShares(a.quantity - a.exercisedQuantity - a.cancelledQuantity) <= 0;
  const reopens = usedUpByCounts && roundShares(quantity - exercisedQuantity - cancelledQuantity) > 0;
  return { ...a, quantity, exercisedQuantity, cancelledQuantity, status: reopens ? 'OUTSTANDING' : a.status };
}

/**
 * A warrant before the exercises and corrections dated after `asOf`, as a grant is
 * rewound, and still open if the cancel route closed it after `asOf`.
 */
function rewindWarrant(data: CompanyData, w: Warrant, entries: LedgerEntry[], asOf: ISODate): Warrant {
  const undo = counter(data, w.issueDate, entries, asOf);
  const quantity = undo(fixes('quantity'), w.quantity);
  const exercisedQuantity = undo((e) => e.type === 'EXERCISE' || fixes('exercisedQuantity')(e), w.exercisedQuantity);
  if (entries.some((e) => e.date > asOf && ENDS_WARRANT[e.type] === w.status)) return { ...w, quantity, exercisedQuantity, status: 'OUTSTANDING' };
  if (quantity === w.quantity && exercisedQuantity === w.exercisedQuantity) return w;
  const usedUpByCounts = w.status === 'EXERCISED' && roundShares(w.quantity - w.exercisedQuantity) <= 0;
  const reopens = usedUpByCounts && roundShares(quantity - exercisedQuantity) > 0;
  return { ...w, quantity, exercisedQuantity, status: reopens ? 'OUTSTANDING' : w.status };
}

/**
 * Undoes one count of a grant or warrant: the entries `counts` picks, dated after
 * `asOf`, each restated in the units of the row dated `on`. A count the ledger only
 * partly explains (an import's exercised options, a grant older than the ledger)
 * keeps the part it does not explain from the grant date, as today. One the ledger
 * claims more of than the row holds was edited since, so it is read as today.
 */
function counter(data: CompanyData, on: ISODate, entries: LedgerEntry[], asOf: ISODate) {
  const units = (e: LedgerEntry): number => (e.quantity ?? 0) / splitsBetween(data, on, e.date);
  return (counts: (e: LedgerEntry) => boolean, recorded: number): number => {
    const own = entries.filter(counts);
    const undone = own.filter((e) => e.date > asOf);
    if (undone.length === 0 || own.some((e) => e.quantity == null)) return recorded;
    const onLedger = own.reduce((s, e) => s + units(e), 0);
    if (onLedger > recorded && !near(onLedger, recorded)) return recorded;
    return Math.max(0, roundShares(recorded - undone.reduce((s, e) => s + units(e), 0)));
  };
}

const TERMS = new Set<string>(CORRECTED_TERMS);

/**
 * A convertible whose terms were corrected after `asOf` (an amendment, or a fix
 * dated from when it applies) had the terms of before the earliest such entry.
 * One that converted, was repaid or was cancelled after `asOf` was still
 * outstanding then. The convert route dates the conversion on the instrument and in
 * the ledger, the repay and cancel routes in the ledger; a row older than the
 * ledger may have neither, and then nothing says when.
 */
function rewindConvertible(input: Convertible, entries: LedgerEntry[], asOf: ISODate): Convertible {
  let c = input;
  // Latest first, so each term ends at the value before its earliest correction after asOf.
  const amended = entries.filter((e) => e.type === 'CORRECTION' && e.date > asOf && TERMS.has(String(e.field)))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const e of amended) c = { ...c, [e.field!]: e.before };
  if (c.status === 'OUTSTANDING' || !Object.values(SETTLES).includes(c.status)) return c;
  const on = (c.status === 'CONVERTED' ? c.convertedOn : null)
    ?? entries.filter((e) => SETTLES[e.type] === c.status).map((e) => e.date).sort()[0] ?? null;
  return on != null && on > asOf ? { ...c, status: 'OUTSTANDING', convertedOn: null, convertedIntoShareClassId: null } : c;
}
