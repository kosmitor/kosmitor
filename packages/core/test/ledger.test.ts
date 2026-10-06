/**
 * rewindToDate (ledger.ts): the cap table as it stood on a date, rebuilt by undoing
 * the ledger entries dated after it (math audit CAP-1, docs/design/dated-ledger.md).
 * Each event below is recorded the way the routes in apps/server/src/routes/workflows.ts
 * record it: the row changed in place, a row the event created dated that day, and a
 * ledger entry in the shares of that day. Every name and number is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewindToDate } from '../src/ledger.ts';
import { normalizeSplits, splitFactor } from '../src/splits.ts';
import { computeCapTable, dilutionHistory } from '../src/captable.ts';
import { roundShares, addDays, dollarsToPPS as $$ } from '../src/util.ts';
import type { CompanyData, LedgerEntry } from '../src/types.ts';
import { company, holder, issuance, award, pool, convertible, preferred, fullyVested, entry, warrant } from './builders.ts';

/** Founder 4,500,000 (CS-1) and cofounder 3,500,000 common from 2020; 200,000 vested options; a 2,000,000 plan. */
function base(): CompanyData {
  return company({
    stakeholders: [holder('f', 'Founder'), holder('g', 'Cofounder'), holder('e', 'Employee', 'EMPLOYEE'), holder('b', 'Buyer', 'INVESTOR')],
    issuances: [
      issuance('f', 'common', 4_500_000, $$(0.0001), '2020-01-15', { id: 'cs1', certificateNo: 'CS-1' }),
      issuance('g', 'common', 3_500_000, $$(0.0001), '2020-01-15', { id: 'cs2', certificateNo: 'CS-2' }),
    ],
    awards: [award('e', 200_000, { id: 'opt', vestingScheduleId: fullyVested.id, grantDate: '2021-03-01' })],
    pools: [pool(2_000_000)],
  });
}
const cert = (d: CompanyData, id: string) => d.issuances.find((i) => i.id === id)!;
const grant = (d: CompanyData, id: string) => d.awards.find((a) => a.id === id)!;

test('a partial transfer dated after the as-of date is added back to the certificate; one dated before it stays', () => {
  const d = base();
  Object.assign(cert(d, 'cs1'), { quantity: 3_000_000 });
  d.ledger = [entry('TRANSFER', '2022-05-01', 'cs1', 500_000), entry('TRANSFER', '2024-06-01', 'cs1', 1_000_000)];
  assert.equal(cert(rewindToDate(d, '2023-01-01'), 'cs1').quantity, 4_000_000);
  assert.equal(cert(rewindToDate(d, '2022-01-01'), 'cs1').quantity, 4_500_000);
  assert.equal(cert(rewindToDate(d, '2024-06-01'), 'cs1').quantity, 3_000_000, 'an entry dated the as-of date has happened');
  assert.deepEqual(rewindToDate(d, '2023-01-01').ledger!.map((e) => e.date), ['2022-05-01'], 'what was undone is not undone again');
});

test('a certificate transferred in full is outstanding again before the transfer, with what it held', () => {
  // The route closes the certificate and leaves the quantity it last held.
  const d = base();
  Object.assign(cert(d, 'cs1'), { status: 'TRANSFERRED' });
  d.issuances.push(issuance('b', 'common', 4_500_000, $$(2), '2024-06-01', { certificateNo: 'TR-1', notes: 'Transferred from certificate CS-1' }));
  d.ledger = [entry('TRANSFER', '2024-06-01', 'cs1', 4_500_000)];
  assert.deepEqual([cert(rewindToDate(d, '2024-05-31'), 'cs1').status, cert(rewindToDate(d, '2024-05-31'), 'cs1').quantity], ['OUTSTANDING', 4_500_000]);
  assert.equal(cert(rewindToDate(d, '2024-06-01'), 'cs1').status, 'TRANSFERRED');
  const t = computeCapTable(d, { asOf: '2024-05-31' });
  assert.deepEqual([t.rows.find((r) => r.stakeholderId === 'f')?.outstanding, t.rows.find((r) => r.stakeholderId === 'b')], [4_500_000, undefined]);
});

test('a partial transfer, then one of the rest: between them the certificate holds what the first left', () => {
  const d = base();
  Object.assign(cert(d, 'cs1'), { quantity: 3_000_000, status: 'TRANSFERRED' });
  d.ledger = [entry('TRANSFER', '2023-03-01', 'cs1', 1_500_000), entry('TRANSFER', '2024-03-01', 'cs1', 3_000_000)];
  assert.deepEqual([cert(rewindToDate(d, '2023-12-31'), 'cs1').quantity, cert(rewindToDate(d, '2023-12-31'), 'cs1').status], [3_000_000, 'OUTSTANDING']);
  assert.equal(cert(rewindToDate(d, '2023-01-01'), 'cs1').quantity, 4_500_000);
});

test('OCF StockRepurchase: a repurchase is undone the same way, in part or in full', () => {
  const d = base();
  Object.assign(cert(d, 'cs1'), { quantity: 4_000_000 });
  Object.assign(cert(d, 'cs2'), { status: 'REPURCHASED' });
  d.ledger = [entry('REPURCHASE', '2024-02-01', 'cs1', 500_000), entry('REPURCHASE', '2024-02-01', 'cs2', 3_500_000)];
  const then = rewindToDate(d, '2024-01-31');
  assert.deepEqual([cert(then, 'cs1').quantity, cert(then, 'cs2').quantity, cert(then, 'cs2').status], [4_500_000, 3_500_000, 'OUTSTANDING']);
  assert.equal(computeCapTable(d, { asOf: '2024-01-31' }).totals.outstanding, 8_000_000);
  assert.equal(computeCapTable(d, { asOf: '2024-02-01' }).totals.outstanding, 4_000_000);
});

test('an exercise dated after the as-of date is undone, and a grant exercised in full is outstanding again', () => {
  const d = base();
  Object.assign(grant(d, 'opt'), { exercisedQuantity: 200_000, status: 'EXERCISED' });
  d.ledger = [entry('EXERCISE', '2023-05-01', 'opt', 50_000), entry('EXERCISE', '2024-05-01', 'opt', 150_000)];
  const mid = grant(rewindToDate(d, '2023-12-31'), 'opt');
  assert.deepEqual([mid.exercisedQuantity, mid.status], [50_000, 'OUTSTANDING']);
  assert.equal(grant(rewindToDate(d, '2024-05-01'), 'opt').status, 'EXERCISED');
});

test('a cancellation, and an import\'s forfeiture dated to the holder\'s termination, are undone before their dates', () => {
  const d = base();
  Object.assign(grant(d, 'opt'), { exercisedQuantity: 50_000, cancelledQuantity: 150_000, status: 'CANCELLED' });
  d.ledger = [entry('EXERCISE', '2022-01-10', 'opt', 50_000), entry('FORFEITURE', '2023-02-01', 'opt', 100_000), entry('CANCELLATION', '2024-02-01', 'opt', 50_000)];
  const at = (asOf: string) => { const a = grant(rewindToDate(d, asOf), 'opt'); return [a.exercisedQuantity, a.cancelledQuantity, a.status]; };
  assert.deepEqual(at('2023-12-31'), [50_000, 100_000, 'OUTSTANDING']);
  assert.deepEqual(at('2022-12-31'), [50_000, 0, 'OUTSTANDING']);
  assert.deepEqual(at('2024-02-01'), [50_000, 150_000, 'CANCELLED']);
  assert.equal(computeCapTable(d, { asOf: '2022-12-31' }).totals.poolAvailable, 1_800_000);
  assert.equal(computeCapTable(d, { asOf: '2024-02-01' }).totals.poolAvailable, 1_950_000);
});

test('a convertible converted after the as-of date was outstanding then, dated by convertedOn or by its ledger entry', () => {
  const d = base();
  d.convertibles.push(
    convertible('b', 'SAFE_POST', 250_000, 10_000_000, { id: 'safe1', issueDate: '2022-01-01', status: 'CONVERTED', convertedOn: '2024-06-01', convertedIntoShareClassId: 'common' }),
    // Marked converted by an edit that left convertedOn empty; the convert route's entry dates it.
    convertible('b', 'SAFE_POST', 250_000, 10_000_000, { id: 'safe2', issueDate: '2022-01-01', status: 'CONVERTED' }),
    // Marked converted with no date anywhere: as today.
    convertible('b', 'SAFE_POST', 250_000, 10_000_000, { id: 'safe3', issueDate: '2022-01-01', status: 'CONVERTED' }),
  );
  d.ledger = [entry('CONVERSION', '2024-06-01', 'safe2', 25_000)];
  const then = rewindToDate(d, '2023-01-01').convertibles;
  assert.deepEqual(then.map((c) => c.status), ['OUTSTANDING', 'OUTSTANDING', 'CONVERTED']);
  assert.deepEqual([then[0].convertedOn, then[0].convertedIntoShareClassId], [null, null]);
  assert.deepEqual(rewindToDate(d, '2024-06-01').convertibles.map((c) => c.status), ['CONVERTED', 'CONVERTED', 'CONVERTED']);
});

test('SEC split explainer: across a 2-for-1 split, an entry in the shares of its date is undone in the units of the row it changed', () => {
  // CS-1 holds 4,500,000 from 2020; a 2:1 split on 2023-01-01; 1,000,000 as recorded (2,000,000 shares
  // of the day) transferred on 2024-06-01, and 100,000 of the pre-split options exercised (200,000 shares).
  const d = base();
  d.stockSplits.push({ id: 'sp', date: '2023-01-01', ratio: 2 });
  Object.assign(cert(d, 'cs1'), { quantity: 3_500_000 });
  d.issuances.push(issuance('b', 'common', 2_000_000, $$(0.00005), '2024-06-01', { notes: 'Transferred from certificate CS-1' }));
  Object.assign(grant(d, 'opt'), { exercisedQuantity: 100_000 });
  d.issuances.push(issuance('e', 'common', 200_000, $$(0.05), '2024-07-01', { sourceAwardId: 'opt' }));
  d.ledger = [entry('TRANSFER', '2024-06-01', 'cs1', 2_000_000), entry('EXERCISE', '2024-07-01', 'opt', 200_000)];
  // In the rows' own units before the split is folded in...
  assert.deepEqual([cert(rewindToDate(d, '2023-06-01'), 'cs1').quantity, grant(rewindToDate(d, '2023-06-01'), 'opt').exercisedQuantity], [4_500_000, 0]);
  // ...and in the shares of the as-of date after it.
  const mid = normalizeSplits(d, '2023-06-01');
  assert.deepEqual([cert(mid, 'cs1').quantity, grant(mid, 'opt').exercisedQuantity, grant(mid, 'opt').quantity], [9_000_000, 0, 400_000]);
  assert.deepEqual([computeCapTable(d, { asOf: '2022-06-01' }).totals.fullyDiluted, computeCapTable(d, { asOf: '2023-06-01' }).totals.fullyDiluted], [10_000_000, 20_000_000]);
  const after = computeCapTable(d, { asOf: '2024-08-01' });
  assert.deepEqual([after.totals.outstanding, after.totals.optionsOutstanding, after.totals.fullyDiluted], [16_200_000, 200_000, 20_000_000]);
  // A view after the split keeps the earlier entries, restated in its shares.
  assert.deepEqual(normalizeSplits(d, '2024-08-01').ledger!.map((e) => e.quantity), [2_000_000, 200_000]);
  assert.deepEqual(normalizeSplits({ ...d, ledger: [entry('CANCELLATION', '2022-01-01', 'opt', 10)] }, '2024-08-01').ledger!.map((e) => e.quantity), [20]);
});

test('rewinding or normalizing twice is the same as once', () => {
  const d = base();
  d.stockSplits.push({ id: 'sp', date: '2023-01-01', ratio: 3 });
  Object.assign(cert(d, 'cs1'), { status: 'TRANSFERRED' });
  d.ledger = [entry('TRANSFER', '2024-06-01', 'cs1', 13_500_000)];
  for (const asOf of ['2022-01-01', '2023-06-01', '2024-07-01']) {
    assert.deepEqual(rewindToDate(rewindToDate(d, asOf), asOf), rewindToDate(d, asOf), asOf);
    assert.deepEqual(normalizeSplits(normalizeSplits(d, asOf), asOf), normalizeSplits(d, asOf), asOf);
  }
  assert.equal(cert(normalizeSplits(d, '2023-06-01'), 'cs1').quantity, 13_500_000);
});

test('with nothing dated after the as-of date, today\'s view among them, the snapshot is returned as it is', () => {
  const d = base();
  Object.assign(cert(d, 'cs1'), { quantity: 3_500_000 });
  d.ledger = [entry('TRANSFER', '2024-06-01', 'cs1', 1_000_000)];
  assert.equal(rewindToDate(d, '2024-06-01'), d);
  assert.equal(rewindToDate(base(), '2019-01-01').issuances.length, 2);
});

test('a row whose history the ledger cannot rebuild keeps today\'s state', () => {
  const d = base();
  d.issuances.push(
    // Closed before the ledger existed, or by an edit: nothing says when.
    issuance('f', 'common', 1_000, $$(1), '2020-01-15', { id: 'old', status: 'TRANSFERRED' }),
    // Closed, but the only entry is a partial transfer: the closing one is missing.
    issuance('f', 'common', 2_000, $$(1), '2020-01-15', { id: 'gap', status: 'TRANSFERRED' }),
    // Cancelled by an edit, which the ledger does not date, after a recorded partial transfer.
    issuance('f', 'common', 3_000, $$(1), '2020-01-15', { id: 'edit', quantity: 2_500, status: 'CANCELLED' }),
    // A manual entry with no quantity cannot be undone.
    issuance('f', 'common', 4_000, $$(1), '2020-01-15', { id: 'blank' }),
  );
  d.awards.push(
    // An edit lowered the count below what the ledger records.
    award('e', 10_000, { id: 'edited', vestingScheduleId: fullyVested.id, exercisedQuantity: 1_000 }),
    // An edit set the status with options still outstanding.
    award('e', 10_000, { id: 'statused', vestingScheduleId: fullyVested.id, exercisedQuantity: 4_000, status: 'CANCELLED' }),
  );
  d.ledger = [
    entry('TRANSFER', '2024-01-01', 'gap', 500), entry('TRANSFER', '2024-01-01', 'edit', 500), entry('TRANSFER', '2024-01-01', 'blank', null),
    entry('EXERCISE', '2024-01-01', 'edited', 3_000), entry('EXERCISE', '2024-01-01', 'statused', 4_000),
  ];
  const then = rewindToDate(d, '2023-01-01');
  for (const id of ['old', 'gap', 'edit', 'blank']) assert.deepEqual(cert(then, id), cert(d, id), id);
  assert.deepEqual(grant(then, 'edited'), grant(d, 'edited'));
  assert.deepEqual([grant(then, 'statused').exercisedQuantity, grant(then, 'statused').status], [0, 'CANCELLED']);
});

test('an import\'s exercised options with no entry stay exercised from the grant date; the dated part of a count is undone', () => {
  // The import records 120,000 exercised with no date; the exercise route adds 30,000 on 2024-04-01.
  const d = base();
  Object.assign(grant(d, 'opt'), { exercisedQuantity: 150_000 });
  d.ledger = [entry('EXERCISE', '2024-04-01', 'opt', 30_000)];
  assert.equal(grant(rewindToDate(d, '2024-03-31'), 'opt').exercisedQuantity, 120_000);
  assert.equal(grant(rewindToDate(d, '2021-03-01'), 'opt').exercisedQuantity, 120_000);
  assert.equal(computeCapTable(d, { asOf: '2024-03-31' }).totals.optionsOutstanding, 80_000);
});

// ---------------------------------------------------------------------------
// Audit §4: the table as of date t depends only on events dated on or before t
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a failure names the seed that found it. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Event =
  | { kind: 'issue'; date: string; id: string; holder: string; quantity: number; price: number }
  | { kind: 'grant'; date: string; id: string; holder: string; quantity: number }
  | { kind: 'safe'; date: string; id: string; holder: string }
  | { kind: 'split'; date: string; ratio: number }
  | { kind: 'transfer' | 'repurchase'; date: string; source: string; quantity: number; to: string; id: string }
  | { kind: 'exercise' | 'cancel'; date: string; award: string; quantity: number; id: string }
  | { kind: 'convert'; date: string; convertible: string; shares: number; id: string };

/**
 * Applies an event to the rows the way its route does (apps/server/src/routes/workflows.ts):
 * the row changed in place, the rows it created dated the event, and the ledger entry in the
 * shares of the event's date. Quantities a route takes are in the row's own units.
 */
function apply(d: CompanyData, ev: Event): void {
  const ledger = (d.ledger ??= []);
  const note = (e: Omit<LedgerEntry, 'id'>) => ledger.push({ id: `tx_${ledger.length + 1}`, ...e });
  switch (ev.kind) {
    case 'issue':
      d.issuances.push(issuance(ev.holder, 'common', ev.quantity, ev.price, ev.date, { id: ev.id, certificateNo: ev.id }));
      break;
    case 'grant':
      d.awards.push(award(ev.holder, ev.quantity, { id: ev.id, grantDate: ev.date, vestingStartDate: ev.date, vestingScheduleId: fullyVested.id, expirationDate: '2040-01-01' }));
      break;
    case 'safe':
      d.convertibles.push(convertible(ev.holder, 'SAFE_POST', 100_000, 8_000_000, { id: ev.id, issueDate: ev.date }));
      break;
    case 'split':
      d.stockSplits.push({ id: `split_${ev.date}`, date: ev.date, ratio: ev.ratio });
      break;
    case 'transfer':
    case 'repurchase': {
      const src = d.issuances.find((i) => i.id === ev.source)!;
      const k = splitFactor(d, src.issueDate, ev.date);
      const moved = roundShares(ev.quantity * k);
      if (ev.kind === 'transfer') {
        d.issuances.push(issuance(ev.to, src.shareClassId, moved, Math.round(src.pricePerShare / k), ev.date,
          { id: ev.id, certificateNo: ev.id, notes: `Transferred from certificate ${src.certificateNo ?? src.id}` }));
      }
      if (ev.quantity >= src.quantity) src.status = ev.kind === 'transfer' ? 'TRANSFERRED' : 'REPURCHASED';
      else src.quantity = roundShares(src.quantity - ev.quantity);
      note({ type: ev.kind === 'transfer' ? 'TRANSFER' : 'REPURCHASE', date: ev.date, securityId: src.id, quantity: moved });
      break;
    }
    case 'exercise':
    case 'cancel': {
      const a = d.awards.find((x) => x.id === ev.award)!;
      const k = splitFactor(d, a.grantDate, ev.date);
      if (ev.kind === 'exercise') {
        d.issuances.push(issuance(a.stakeholderId, 'common', roundShares(ev.quantity * k), Math.round(a.strikePrice / k), ev.date, { id: ev.id, sourceAwardId: a.id }));
        a.exercisedQuantity = roundShares(a.exercisedQuantity + ev.quantity);
        a.status = a.exercisedQuantity >= roundShares(a.quantity - a.cancelledQuantity) ? 'EXERCISED' : 'OUTSTANDING';
      } else {
        a.cancelledQuantity = roundShares(a.cancelledQuantity + ev.quantity);
        a.status = a.cancelledQuantity >= roundShares(a.quantity - a.exercisedQuantity) ? 'CANCELLED' : 'OUTSTANDING';
      }
      note({ type: ev.kind === 'exercise' ? 'EXERCISE' : 'CANCELLATION', date: ev.date, securityId: a.id, quantity: roundShares(ev.quantity * k) });
      break;
    }
    case 'convert': {
      const c = d.convertibles.find((x) => x.id === ev.convertible)!;
      d.issuances.push(issuance(c.stakeholderId, 'seed', ev.shares, $$(1), ev.date, { id: ev.id, notes: 'Issued on conversion of SAFE_POST' }));
      Object.assign(c, { status: 'CONVERTED', convertedOn: ev.date, convertedIntoShareClassId: 'seed' });
      note({ type: 'CONVERSION', date: ev.date, securityId: c.id, quantity: ev.shares });
      break;
    }
  }
}

function start(): CompanyData {
  const d = company({
    stakeholders: ['h0', 'h1', 'h2', 'h3', 'h4'].map((id) => holder(id, `Holder ${id}`, 'OTHER')),
    pools: [pool(5_000_000)],
  });
  d.shareClasses.push(preferred('seed', 'Seed', 1, { issueDate: '2020-01-01' }));
  d.ledger = [];
  return d;
}

/** A random history, each event chosen from the rows as the earlier ones left them, in date order. */
function history(seed: number): Event[] {
  const rnd = random(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  /** All of what is left about a third of the time, else part of it. */
  const some = (max: number) => (rnd() < 0.3 ? max : 1 + Math.floor(rnd() * max));
  const d = start();
  const events: Event[] = [];
  let date = '2020-02-01';
  for (let n = 0; n < 24; n++) {
    date = addDays(date, Math.floor(rnd() * 120));
    const who = pick(d.stakeholders).id;
    const certs = d.issuances.filter((i) => i.status === 'OUTSTANDING' && i.issueDate <= date && i.quantity >= 1);
    const grants = d.awards.filter((a) => a.status === 'OUTSTANDING' && roundShares(a.quantity - a.exercisedQuantity - a.cancelledQuantity) >= 1);
    const safes = d.convertibles.filter((c) => c.status === 'OUTSTANDING');
    let ev: Event;
    switch (pick(['issue', 'grant', 'safe', 'split', 'transfer', 'transfer', 'repurchase', 'exercise', 'cancel', 'convert'])) {
      case 'grant':
        ev = { kind: 'grant', date, id: `opt_${n}`, holder: who, quantity: 1_000 * (1 + Math.floor(rnd() * 200)) };
        break;
      case 'safe':
        ev = { kind: 'safe', date, id: `safe_${n}`, holder: who };
        break;
      case 'split':
        // A split is recorded when it happens, after everything recorded before it.
        date = addDays(date, 1);
        ev = { kind: 'split', date, ratio: pick([2, 3]) };
        break;
      case 'transfer':
      case 'repurchase':
        if (!certs.length) continue;
        {
          const src = pick(certs);
          ev = { kind: rnd() < 0.7 ? 'transfer' : 'repurchase', date, source: src.id, quantity: some(Math.floor(src.quantity)), to: who, id: `tr_${n}` };
        }
        break;
      case 'exercise':
      case 'cancel':
        if (!grants.length) continue;
        {
          const a = pick(grants);
          ev = { kind: rnd() < 0.5 ? 'exercise' : 'cancel', date, award: a.id, quantity: some(Math.floor(roundShares(a.quantity - a.exercisedQuantity - a.cancelledQuantity))), id: `ex_${n}` };
        }
        break;
      case 'convert':
        if (!safes.length) continue;
        ev = { kind: 'convert', date, convertible: pick(safes).id, shares: 10_000 * (1 + Math.floor(rnd() * 20)), id: `cv_${n}` };
        break;
      default:
        ev = { kind: 'issue', date, id: `cs_${n}`, holder: who, quantity: 1_000 * (1 + Math.floor(rnd() * 1_000)), price: pick([100, 10_000, 1_370_000]) };
    }
    apply(d, ev);
    events.push(ev);
  }
  return events;
}

const replay = (events: Event[]): CompanyData => { const d = start(); for (const ev of events) apply(d, ev); return d; };
const dayBefore = (d: string) => addDays(d, -1);

test('Audit §4 invariant: in 40 random histories the table as of every date is the table of the events up to that date', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const events = history(seed);
    const today = replay(events);
    const dates = [...new Set(events.flatMap((e) => [e.date, dayBefore(e.date)]))].sort();
    for (const asOf of ['2020-01-01', ...dates, '2027-01-01']) {
      const then = replay(events.filter((e) => e.date <= asOf));
      for (const includeConvertibles of [false, true]) {
        const got = computeCapTable(today, { asOf, includeConvertibles });
        const want = computeCapTable(then, { asOf, includeConvertibles });
        assert.deepEqual(got, want, `seed ${seed}, as of ${asOf}${includeConvertibles ? ', with convertibles' : ''}`);
      }
    }
    // The dilution history is the table at each of its dates.
    for (const p of dilutionHistory(today).points) {
      assert.equal(p.fullyDiluted, computeCapTable(replay(events.filter((e) => e.date <= p.date)), { asOf: p.date, includeConvertibles: true }).totals.fullyDiluted, `seed ${seed}, history ${p.date}`);
    }
  }
});

test('today\'s view is the same with the ledger as without it', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const d = replay(history(seed));
    const bare: CompanyData = { ...d };
    delete bare.ledger;
    assert.deepEqual(computeCapTable(d, { asOf: '2026-01-01', includeConvertibles: true }), computeCapTable(bare, { asOf: '2026-01-01', includeConvertibles: true }), `seed ${seed}`);
    assert.equal(rewindToDate(d, '2026-01-01'), d);
  }
});

// ---------------------------------------------------------------------------
// Corrections (PATCH) and warrant exercises
// ---------------------------------------------------------------------------

test('a CORRECTION of a certificate\'s quantity is undone before its date; one dated the issue date holds for every date', () => {
  const d = base();
  // The edit raised CS-1 from 4,500,000 to 4,600,000 effective 2024-01-01, and lowered CS-2 to 3,400,000 as always wrong.
  Object.assign(cert(d, 'cs1'), { quantity: 4_600_000 });
  Object.assign(cert(d, 'cs2'), { quantity: 3_400_000 });
  d.ledger = [entry('CORRECTION', '2024-01-01', 'cs1', 100_000, 'quantity'), entry('CORRECTION', '2020-01-15', 'cs2', -100_000, 'quantity')];
  assert.equal(cert(rewindToDate(d, '2023-12-31'), 'cs1').quantity, 4_500_000);
  assert.equal(cert(rewindToDate(d, '2024-01-01'), 'cs1').quantity, 4_600_000);
  assert.equal(cert(rewindToDate(d, '2021-01-01'), 'cs2').quantity, 3_400_000);
});

test('a certificate corrected, then transferred in full: before either it held what it held before the correction', () => {
  const d = base();
  Object.assign(cert(d, 'cs1'), { quantity: 4_000_000, status: 'TRANSFERRED' });
  d.ledger = [entry('CORRECTION', '2023-01-01', 'cs1', -500_000, 'quantity'), entry('TRANSFER', '2024-01-01', 'cs1', 4_000_000)];
  const at = (asOf: string) => [cert(rewindToDate(d, asOf), 'cs1').quantity, cert(rewindToDate(d, asOf), 'cs1').status];
  assert.deepEqual(at('2023-06-01'), [4_000_000, 'OUTSTANDING']);
  assert.deepEqual(at('2022-06-01'), [4_500_000, 'OUTSTANDING']);
});

test('CORRECTION entries on a grant: quantity and exercised count are undone with the exercises, across a split', () => {
  const d = base();
  d.stockSplits = [{ id: 'sp', date: '2023-01-01', ratio: 2 }];
  // A grant of 200,000 options in its own units. 50,000 exercised on 2024-01-01 (100,000 shares of the day);
  // then an edit on 2024-06-01 lowered the exercised count by 10,000 options (20,000 shares of the day)
  // and raised the grant by 5,000 options (10,000 shares of the day).
  Object.assign(grant(d, 'opt'), { quantity: 205_000, exercisedQuantity: 40_000 });
  d.ledger = [
    entry('EXERCISE', '2024-01-01', 'opt', 100_000),
    entry('CORRECTION', '2024-06-01', 'opt', -20_000, 'exercisedQuantity'),
    entry('CORRECTION', '2024-06-01', 'opt', 10_000, 'quantity'),
  ];
  const mid = grant(rewindToDate(d, '2024-03-01'), 'opt');
  assert.deepEqual([mid.quantity, mid.exercisedQuantity], [200_000, 50_000]);
  const before = grant(rewindToDate(d, '2023-06-01'), 'opt');
  assert.deepEqual([before.quantity, before.exercisedQuantity], [200_000, 0]);
  assert.equal(computeCapTable(d, { asOf: '2024-03-01' }).totals.optionsOutstanding, 300_000);
});

test('a warrant exercised after the as-of date is outstanding again then, with what it held', () => {
  const d = base();
  d.warrants = [warrant('b', 'common', 100_000, { id: 'w1', issueDate: '2021-01-01', exercisedQuantity: 100_000, status: 'EXERCISED' })];
  d.ledger = [entry('EXERCISE', '2023-01-01', 'w1', 40_000), entry('EXERCISE', '2024-01-01', 'w1', 60_000)];
  const w = (asOf: string) => rewindToDate(d, asOf).warrants.find((x) => x.id === 'w1')!;
  assert.deepEqual([w('2023-06-01').exercisedQuantity, w('2023-06-01').status], [40_000, 'OUTSTANDING']);
  assert.deepEqual([w('2022-06-01').exercisedQuantity, w('2022-06-01').status], [0, 'OUTSTANDING']);
  assert.equal(w('2024-01-01').status, 'EXERCISED');
  assert.equal(computeCapTable(d, { asOf: '2023-06-01' }).totals.warrantsOutstanding, 60_000);
});
