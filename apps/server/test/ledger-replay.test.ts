/**
 * Model-based test of the write paths (math audit §4 and §5; CAP-1, CAP-2, CAP-9).
 * Random sequences of issues, grants, SAFEs, warrants, stock splits, transfers,
 * repurchases, certificate cancellations, exercises of grants and warrants, grant
 * cancellations, warrant expiries, conversions, repayments and cancellations of
 * SAFEs, corrected counts and SAFE principals (PATCH with an effective date), typo corrections of a
 * certificate's holder, class or date (PATCH with a reason; refused for a holder or class once the
 * certificate has history or an event issued it), warrant expiries brought in (PATCH with an effective
 * date), and splits dated behind the ledger (refused) go through the real routes. After every
 * step the cap table route, as of each date so far, must equal a plain replay of the
 * events dated on or before it. The replay knows nothing of the engine or the ledger:
 * it keeps share counts in the shares of the day, multiplies them by a split's ratio
 * when it comes, and gives a transferred certificate the price the company was paid
 * for it. Holders and figures are invented.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
const { one } = await import('../src/db.ts');
const { addDays, roundShares, shareValue, today } = await import('@kosmitor/core');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
const admin = (await call('POST', '/api/auth/register', { email: 'quill@example.com', name: 'Quill Marsh', password: 'quill-pass-1' })).token as string;

/** mulberry32, so a failure names the seed that found it. */
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

// ---------------------------------------------------------------------------
// The replay: what happened, in the shares of the day it happened
// ---------------------------------------------------------------------------

type Fact =
  | { kind: 'issue'; date: string; id: string; holder: string; shares: number; price: number }
  | { kind: 'grant'; date: string; id: string; holder: string; shares: number }
  | { kind: 'safe'; date: string; id: string; holder: string; principal: number }
  | { kind: 'split'; date: string; ratio: number }
  | { kind: 'transfer'; date: string; source: string; id: string; to: string; shares: number }
  | { kind: 'repurchase'; date: string; source: string; shares: number }
  | { kind: 'exercise'; date: string; grant: string; id: string; shares: number; price: number }
  | { kind: 'cancel'; date: string; grant: string; shares: number }
  | { kind: 'convert'; date: string; safe: string; id: string; shares: number; price: number }
  | { kind: 'certcancel'; date: string; source: string; shares: number }
  | { kind: 'warrant'; date: string; id: string; holder: string; shares: number }
  | { kind: 'wexercise'; date: string; warrant: string; id: string; shares: number; price: number }
  | { kind: 'wend'; date: string; warrant: string }
  | { kind: 'settle'; date: string; safe: string }
  // An edit of a count from `date` on: a certificate's shares or a grant's size, by `shares` of the day.
  | { kind: 'correct'; date: string; target: 'cert' | 'grant'; id: string; shares: number }
  // A SAFE's principal amended from `date` on.
  | { kind: 'reterm'; date: string; safe: string; principal: number }
  // A typo in a certificate's holder or own date: the record always should have said so, on every date.
  | { kind: 'retype'; date: string; id: string; holder?: string; issued?: string }
  // A warrant's expiry corrected from `date` on: before it, the views read the old expiry.
  | { kind: 'reexpire'; date: string; warrant: string; expires: string }
  // Something the routes refused (a split dated behind the ledger): nothing changed.
  | { kind: 'none'; date: string };

/** The plan every history starts with, approved on 2020-01-01. */
const PLAN = 3_000_000;
const PLAN_APPROVED = '2020-01-01';
/** The expiry every warrant is issued with. */
const WARRANT_EXPIRES = '2040-01-01';

interface Position { outstanding: number; options: number; warrants: number; principal: number }

function replay(facts: Fact[], asOf: string) {
  const certs = new Map<string, { holder: string; shares: number; paid: number }>();
  const grants = new Map<string, { holder: string; granted: number; exercised: number; cancelled: number }>();
  const safes = new Map<string, { holder: string; principal: number; live: boolean }>();
  const warrants = new Map<string, { holder: string; size: number; exercised: number; live: boolean; expires: string }>();
  let plan = asOf >= PLAN_APPROVED ? PLAN : 0;
  // A typo fix holds on every date: the certificate always had that holder and date.
  const holderOf = new Map<string, string>(), issuedOn = new Map<string, string>();
  for (const f of facts) if (f.kind === 'retype') { if (f.holder) holderOf.set(f.id, f.holder); if (f.issued) issuedOn.set(f.id, f.issued); }
  for (const f of facts) {
    if ((f.kind === 'issue' ? issuedOn.get(f.id) ?? f.date : f.date) > asOf) continue;
    switch (f.kind) {
      case 'issue': certs.set(f.id, { holder: holderOf.get(f.id) ?? f.holder, shares: f.shares, paid: f.price }); break;
      case 'reterm': safes.get(f.safe)!.principal = f.principal; break;
      case 'retype': case 'none': break;
      case 'grant': grants.set(f.id, { holder: f.holder, granted: f.shares, exercised: 0, cancelled: 0 }); break;
      case 'safe': safes.set(f.id, { holder: f.holder, principal: f.principal, live: true }); break;
      case 'split':
        for (const c of certs.values()) { c.shares *= f.ratio; c.paid /= f.ratio; }
        for (const g of grants.values()) { g.granted *= f.ratio; g.exercised *= f.ratio; g.cancelled *= f.ratio; }
        for (const w of warrants.values()) { w.size *= f.ratio; w.exercised *= f.ratio; }
        plan *= f.ratio;
        break;
      case 'transfer': {
        const src = certs.get(f.source)!;
        src.shares -= f.shares;
        // The company was paid for the shares once, whoever holds them now (OCF StockTransfer).
        certs.set(f.id, { holder: holderOf.get(f.id) ?? f.to, shares: f.shares, paid: src.paid });
        break;
      }
      case 'repurchase': case 'certcancel': certs.get(f.source)!.shares -= f.shares; break;
      case 'warrant': warrants.set(f.id, { holder: f.holder, size: f.shares, exercised: 0, live: true, expires: WARRANT_EXPIRES }); break;
      case 'reexpire': warrants.get(f.warrant)!.expires = f.expires; break;
      case 'wexercise': {
        const w = warrants.get(f.warrant)!;
        w.exercised += f.shares;
        certs.set(f.id, { holder: holderOf.get(f.id) ?? w.holder, shares: f.shares, paid: f.price });
        break;
      }
      case 'wend': warrants.get(f.warrant)!.live = false; break;
      case 'settle': safes.get(f.safe)!.live = false; break;
      case 'exercise': {
        const g = grants.get(f.grant)!;
        g.exercised += f.shares;
        certs.set(f.id, { holder: holderOf.get(f.id) ?? g.holder, shares: f.shares, paid: f.price });
        break;
      }
      case 'cancel': grants.get(f.grant)!.cancelled += f.shares; break;
      case 'correct':
        if (f.target === 'cert') certs.get(f.id)!.shares += f.shares;
        else grants.get(f.id)!.granted += f.shares;
        break;
      case 'convert': {
        const s = safes.get(f.safe)!;
        s.live = false;
        certs.set(f.id, { holder: holderOf.get(f.id) ?? s.holder, shares: f.shares, paid: f.price });
        break;
      }
    }
  }
  const holders = new Map<string, Position>();
  const at = (id: string) => holders.get(id) ?? holders.set(id, { outstanding: 0, options: 0, warrants: 0, principal: 0 }).get(id)!;
  let invested = 0, held = 0;
  for (const c of certs.values()) {
    if (c.shares <= 1e-9) continue;
    at(c.holder).outstanding += c.shares;
    invested += shareValue(c.shares, c.paid);
    held++;
  }
  let options = 0, granted = 0, returned = 0;
  for (const g of grants.values()) {
    const left = g.granted - g.exercised - g.cancelled;
    at(g.holder).options += left;
    options += left; granted += g.granted; returned += g.cancelled;
  }
  for (const s of safes.values()) if (s.live) at(s.holder).principal += s.principal;
  let warranted = 0;
  for (const w of warrants.values()) {
    // The views drop a warrant the day after it expires.
    if (!w.live || w.expires < asOf) continue;
    at(w.holder).warrants += w.size - w.exercised;
    warranted += w.size - w.exercised;
  }
  const outstanding = [...holders.values()].reduce((n, h) => n + h.outstanding, 0);
  const pool = plan - granted + returned;
  return { holders, outstanding, options, warrants: warranted, pool, fullyDiluted: outstanding + options + warranted + pool, invested, certificates: held };
}

/** The splits after `on` and on or before `to`, from the facts: what the routes multiply a recorded quantity by. */
const splitsBetween = (facts: Fact[], on: string, to: string): number =>
  facts.reduce((k, f) => (f.kind === 'split' && f.date > on && f.date <= to ? k * f.ratio : k), 1);

// ---------------------------------------------------------------------------
// One random history through the routes
// ---------------------------------------------------------------------------

/** The kinds of step the histories took, so a change that stops one from happening shows. */
const exercised = new Set<string>();

async function runHistory(seed: number, steps: number): Promise<void> {
  const rnd = random(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  /** All of what is left about a third of the time, else part of it. */
  const some = (max: number) => (rnd() < 0.3 ? max : 1 + Math.floor(rnd() * max));

  const cid = (await call('POST', '/api/companies', { name: `Replay Co ${seed}`, incorporationDate: '2020-01-01', authorizedCommon: 900_000_000 }, admin)).json.id as string;
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, `/api/c/${cid}${path}`, body, admin);
    assert.equal(r.status, 200, `seed ${seed}: ${method} ${path} ${JSON.stringify(body)} → ${JSON.stringify(r.json)}`);
    return r.json;
  };
  /** A request the routes may refuse for a reason the model does not track (a split or an event in the way): 200 or 400. */
  const attempt = async (method: string, path: string, body?: unknown): Promise<boolean> => {
    const r = await call(method, `/api/c/${cid}${path}`, body, admin);
    assert.ok(r.status === 200 || r.status === 400, `seed ${seed}: ${method} ${path} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.status === 200;
  };
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const vested = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'FULLY_VESTED'", cid))!.id;
  const seedClass = (await send('POST', '/share-classes', { name: 'Seed Preferred', kind: 'PREFERRED', authorized: 900_000_000, issueDate: '2020-01-01', originalIssuePrice: 1_000_000, conversionRatio: 1, isConvertible: 1, seniority: 1 })).id as string;
  const plan = (await send('POST', '/pools', { name: 'Stock Plan', shareClassId: common, authorized: PLAN, boardApprovalDate: PLAN_APPROVED, returnForfeitures: 1, planType: 'STOCK_PLAN' })).id as string;
  const holders: string[] = [];
  for (const name of ['Ada Penrose', 'Bram Okafor', 'Cleo Varga', 'Dev Halloran']) {
    holders.push((await send('POST', '/stakeholders', { name, type: 'INDIVIDUAL', relation: 'OTHER' })).id);
  }

  const facts: Fact[] = [];
  const checked: string[] = ['2019-12-31'];
  let date = '2020-02-01';

  for (let n = 0; n < steps; n++) {
    date = addDays(date, Math.floor(rnd() * 60));
    const who = pick(holders);
    const certs = ((await send('GET', '/issuances')) as any[]).filter((i) => i.status === 'OUTSTANDING' && i.issueDate <= date && Number(i.quantity) >= 1);
    const grants = ((await send('GET', '/awards')) as any[]).filter((a) => a.status === 'OUTSTANDING' && roundShares(a.quantity - a.exercisedQuantity - a.cancelledQuantity) >= 1);
    const safes = ((await send('GET', '/convertibles')) as any[]).filter((c) => c.status === 'OUTSTANDING');
    const live = ((await send('GET', '/warrants')) as any[]).filter((w) => w.status === 'OUTSTANDING' && w.expirationDate >= date && roundShares(w.quantity - w.exercisedQuantity) >= 1);
    let fact: Fact;
    let what = pick(['issue', 'grant', 'safe', 'split', 'transfer', 'transfer', 'repurchase', 'certcancel', 'exercise', 'cancel', 'convert', 'settle', 'correct',
      'warrant', 'wexercise', 'wend', 'reterm', 'retype', 'retype', 'backsplit', 'reexpire']);
    if (what === 'correct' && !certs.length && !grants.length) what = 'issue';
    if (what === 'retype' && !certs.length) what = 'issue';
    if (what === 'reterm' && !safes.length) what = 'safe';
    if ((what === 'transfer' || what === 'repurchase' || what === 'certcancel') && !certs.length) what = 'issue';
    if ((what === 'wexercise' || what === 'wend' || what === 'reexpire') && !live.length) what = 'warrant';
    if (what === 'settle' && !safes.length) what = 'safe';
    if ((what === 'exercise' || what === 'cancel') && !grants.length) what = 'grant';
    if (what === 'convert' && !safes.length) what = 'safe';

    switch (what) {
      case 'issue': {
        const shares = 1_000 * (1 + Math.floor(rnd() * 1_000));
        const price = pick([100, 10_000, 1_370_000]);
        const iss = await send('POST', '/issuances', { stakeholderId: who, shareClassId: common, quantity: shares, pricePerShare: price, issueDate: date, certificateNo: `CS-${n + 1}` });
        fact = { kind: 'issue', date, id: iss.id, holder: who, shares, price };
        break;
      }
      case 'grant': {
        const shares = 1_000 * (1 + Math.floor(rnd() * 200));
        const award = await send('POST', '/awards', {
          stakeholderId: who, poolId: plan, type: 'NSO', quantity: shares, strikePrice: 100_000, grantDate: date,
          vestingScheduleId: vested, status: 'OUTSTANDING', expirationDate: '2040-01-01', fmvAtGrant: 100_000,
        });
        fact = { kind: 'grant', date, id: award.id, holder: who, shares };
        break;
      }
      case 'safe': {
        const principal = 1_000 * (1 + Math.floor(rnd() * 500)) * 100;
        const c = await send('POST', '/convertibles', { stakeholderId: who, instrument: 'SAFE_POST', principal, valuationCap: 2_000_000_000, issueDate: date, status: 'OUTSTANDING' });
        fact = { kind: 'safe', date, id: c.id, holder: who, principal };
        break;
      }
      case 'split': {
        // A split is recorded when it happens, after everything dated before it.
        date = addDays(date, 1);
        const ratio = pick([2, 3]);
        await send('POST', '/stock-splits', { date, ratio });
        fact = { kind: 'split', date, ratio };
        break;
      }
      case 'backsplit': {
        // A split dated before what the ledger already holds would restate it: refused. One the
        // ledger does not reach yet is recorded; it is taken back at once, as the model has no place for it.
        const on = facts.length ? pick(facts).date : addDays(date, -1);
        const r = await call('POST', `/api/c/${cid}/stock-splits`, { date: on, ratio: 2 }, admin);
        if (r.status === 200) await send('DELETE', `/stock-splits/${r.json.id}`);
        else assert.match(r.json.error, /would restate ledger entries/, `seed ${seed}: backsplit on ${on}`);
        exercised.add(r.status === 200 ? 'split behind nothing' : 'split behind the ledger refused');
        fact = { kind: 'none', date };
        break;
      }
      case 'reterm': {
        const c = pick(safes);
        const principal = 1_000 * (1 + Math.floor(rnd() * 500)) * 100;
        await send('PATCH', `/convertibles/${c.id}`, { principal, effectiveDate: date, reason: 'Amended purchase amount' });
        fact = { kind: 'reterm', date, safe: c.id, principal };
        exercised.add('principal corrected');
        break;
      }
      case 'retype': {
        // A certificate an event issued, or one with an event since, may only change holder or class by that event.
        const hasHistory = (id: string) => facts.some((f) => ('source' in f && f.source === id) || (['transfer', 'exercise', 'wexercise', 'convert'].includes(f.kind) && 'id' in f && f.id === id));
        const plain = certs.filter((c) => !hasHistory(c.id));
        const row = plain.length > 0 && rnd() < 0.8 ? pick(plain) : pick(certs);
        const history = hasHistory(row.id);
        const choice = rnd();
        if (choice < 0.5) {
          const to = pick(holders.filter((h) => h !== row.stakeholderId));
          const done = await attempt('PATCH', `/issuances/${row.id}`, { stakeholderId: to, reason: 'Entered against the wrong holder' });
          assert.equal(done, !history, `seed ${seed}: a holder correction of ${row.id} is refused exactly when it has history`);
          fact = done ? { kind: 'retype', date, id: row.id, holder: to } : { kind: 'none', date };
          exercised.add(done ? 'holder corrected' : 'holder or class correction refused');
        } else if (choice < 0.75) {
          // The class is not in the model's totals; the views must not move.
          const done = await attempt('PATCH', `/issuances/${row.id}`, { shareClassId: row.shareClassId === common ? seedClass : common, reason: 'Wrong class' });
          assert.equal(done, !history, `seed ${seed}: a class correction of ${row.id} is refused exactly when it has history`);
          fact = { kind: 'none', date };
          exercised.add(done ? 'class corrected' : 'holder or class correction refused');
        } else {
          let issued = addDays(row.issueDate, Math.floor(rnd() * 61) - 30);
          if (issued < '2020-01-02') issued = '2020-01-02';
          if (issued > date) issued = date;
          const done = issued !== row.issueDate && await attempt('PATCH', `/issuances/${row.id}`, { issueDate: issued, reason: 'Board minutes give another date' });
          fact = done ? { kind: 'retype', date, id: row.id, issued } : { kind: 'none', date };
          if (done) exercised.add('date corrected');
          if (done && issued < row.issueDate) for (const d of [addDays(issued, -1), issued]) if (!checked.includes(d)) checked.push(d);
        }
        break;
      }
      case 'warrant': {
        const shares = 1_000 * (1 + Math.floor(rnd() * 100));
        const w = await send('POST', '/warrants', { stakeholderId: who, shareClassId: common, quantity: shares, strikePrice: 50_000, issueDate: date, expirationDate: WARRANT_EXPIRES, netExercise: 0 });
        fact = { kind: 'warrant', date, id: w.id, holder: who, shares };
        break;
      }
      case 'wexercise': {
        const w = pick(live);
        const quantity = some(Math.floor(roundShares(w.quantity - w.exercisedQuantity)));
        const k = splitsBetween(facts, w.issueDate, date);
        const r = await send('POST', `/warrants/${w.id}/exercise`, { quantity, exerciseDate: date, method: 'CASH' });
        fact = { kind: 'wexercise', date, warrant: w.id, id: r.issuance.id, shares: roundShares(quantity * k), price: k === 1 ? 50_000 : Math.round(50_000 / k) };
        break;
      }
      case 'reexpire': {
        // The expiry brought in to a day already past, from today on: the views drop the warrant from today, not before.
        const w = pick(live);
        const expires = addDays(w.issueDate, Math.floor(rnd() * 30));
        await send('PATCH', `/warrants/${w.id}`, { expirationDate: expires, effectiveDate: date });
        fact = { kind: 'reexpire', date, warrant: w.id, expires };
        exercised.add('expiry corrected');
        break;
      }
      case 'wend': {
        const w = pick(live);
        await send('POST', `/warrants/${w.id}/cancel`, { date, reason: rnd() < 0.5 ? 'EXPIRED' : 'Holder waived' });
        fact = { kind: 'wend', date, warrant: w.id };
        break;
      }
      case 'settle': {
        const c = pick(safes);
        await send('POST', `/convertibles/${c.id}/${rnd() < 0.5 ? 'repay' : 'cancel'}`, { date });
        fact = { kind: 'settle', date, safe: c.id };
        break;
      }
      case 'certcancel': {
        const src = pick(certs);
        const quantity = some(Math.floor(Number(src.quantity)));
        await send('POST', `/issuances/${src.id}/cancel`, { quantity, date });
        fact = { kind: 'certcancel', date, source: src.id, shares: roundShares(quantity * splitsBetween(facts, src.issueDate, date)) };
        break;
      }
      case 'transfer':
      case 'repurchase': {
        // Quantities are typed as the certificate records them; the ledger and the new certificate are in the shares of the day.
        const src = pick(certs);
        const quantity = some(Math.floor(Number(src.quantity)));
        const shares = roundShares(quantity * splitsBetween(facts, src.issueDate, date));
        if (what === 'transfer') {
          const created = await send('POST', `/issuances/${src.id}/transfer`, { toStakeholderId: who, quantity, date, pricePerShare: pick([50_000, 5_000_000]) });
          assert.equal(Number(created.quantity), shares, `seed ${seed}: the new certificate is in the shares of the day (CAP-2)`);
          fact = { kind: 'transfer', date, source: src.id, id: created.id, to: who, shares };
        } else {
          await send('POST', `/issuances/${src.id}/repurchase`, { quantity, date });
          fact = { kind: 'repurchase', date, source: src.id, shares };
        }
        break;
      }
      case 'exercise':
      case 'cancel': {
        const g = pick(grants);
        // Only what is outstanding: the exercise route checks vested options and not cancelled ones.
        const quantity = some(Math.floor(roundShares(g.quantity - g.exercisedQuantity - g.cancelledQuantity)));
        const k = splitsBetween(facts, g.grantDate, date);
        const shares = roundShares(quantity * k);
        if (what === 'exercise') {
          const r = await send('POST', `/awards/${g.id}/exercise`, { quantity, exerciseDate: date, method: 'CASH' });
          assert.equal(Number(r.issuance.quantity), shares, `seed ${seed}: the shares issued are in the shares of the day (CAP-2)`);
          // The capital paid is the grant's strike in the shares of the day, unrounded (paidInPrice in captable.ts).
          fact = { kind: 'exercise', date, grant: g.id, id: r.issuance.id, shares, price: 100_000 / k };
        } else {
          await send('POST', `/awards/${g.id}/cancel`, { quantity, date });
          fact = { kind: 'cancel', date, grant: g.id, shares };
        }
        break;
      }
      case 'correct': {
        // A count edited from today on, typed in the row's own units: lowered while some stays, or raised.
        const onCert = certs.length > 0 && (!grants.length || rnd() < 0.5);
        const row = onCert ? pick(certs) : pick(grants);
        const room = onCert ? Math.floor(Number(row.quantity)) - 1 : Math.floor(roundShares(row.quantity - row.exercisedQuantity - row.cancelledQuantity)) - 1;
        const delta = room > 0 && rnd() < 0.5 ? -(1 + Math.floor(rnd() * room)) : 1 + Math.floor(rnd() * 1_000);
        await send('PATCH', `/${onCert ? 'issuances' : 'awards'}/${row.id}`, { quantity: roundShares(Number(row.quantity) + delta), effectiveDate: date });
        const shares = roundShares(delta * splitsBetween(facts, onCert ? row.issueDate : row.grantDate, date));
        fact = { kind: 'correct', date, target: onCert ? 'cert' : 'grant', id: row.id, shares };
        break;
      }
      default: {
        const c = pick(safes);
        const shares = 10_000 * (1 + Math.floor(rnd() * 20));
        const created = await send('POST', `/convertibles/${c.id}/convert`, { shareClassId: seedClass, shares, date, pricePerShare: 800_000 });
        fact = { kind: 'convert', date, safe: c.id, id: created.id, shares, price: 800_000 };
      }
    }
    facts.push(fact);
    if (fact.kind === 'split') exercised.add('split');
    for (const d of [addDays(date, -1), date]) if (!checked.includes(d)) checked.push(d);

    // Every date so far, as the cap table route shows it and as the replay has it.
    for (const asOf of checked) {
      const t = (await send('GET', `/captable?asOf=${asOf}`)).table;
      const want = replay(facts, asOf);
      const where = `seed ${seed}, step ${n + 1} (${fact.kind} on ${fact.date}), as of ${asOf}`;
      assert.deepEqual(
        [t.totals.outstanding, t.totals.optionsOutstanding, t.totals.warrantsOutstanding, t.totals.poolAvailable, t.totals.fullyDiluted].map(roundShares),
        [want.outstanding, want.options, want.warrants, want.pool, want.fullyDiluted].map(roundShares), where);
      for (const h of holders) {
        const r = t.rows.find((x: any) => x.stakeholderId === h);
        const m = want.holders.get(h) ?? { outstanding: 0, options: 0, warrants: 0, principal: 0 };
        assert.deepEqual([roundShares(r?.outstanding ?? 0), roundShares(r?.optionsOutstanding ?? 0), roundShares(r?.warrantsOutstanding ?? 0), r?.convertiblePrincipal ?? 0],
          [roundShares(m.outstanding), roundShares(m.options), roundShares(m.warrants), m.principal], `${where}, holder ${h}`);
      }
      // A cent per certificate for the rounding of split-adjusted prices.
      assert.ok(Math.abs(t.totals.investedAmount - want.invested) <= want.certificates, `${where}: invested ${t.totals.investedAmount} vs ${want.invested} (CAP-9)`);
    }
    // The dilution history is the as-of table at each of its dates.
    const history = await send('GET', '/captable/history');
    for (const p of history.points) {
      const t = (await send('GET', `/captable?asOf=${p.date}&includeConvertibles=true`)).table;
      assert.equal(p.fullyDiluted, t.totals.fullyDiluted, `seed ${seed}, step ${n + 1}: history point ${p.date}`);
    }
  }

  // Every event is in the past, so today's view is the replay of all of them.
  const now = (await send('GET', '/captable')).table;
  const all = replay(facts, today());
  assert.deepEqual([now.totals.outstanding, now.totals.fullyDiluted].map(roundShares), [all.outstanding, all.fullyDiluted].map(roundShares), `seed ${seed}: today`);
}

for (const seed of [11, 23, 37, 41, 53, 67]) {
  test(`random history ${seed}: every view of an earlier date equals the replay of the events up to it`, async () => {
    await runHistory(seed, 22);
  });
}

test('the histories took every kind of step the model knows', () => {
  assert.deepEqual([...exercised].sort(), ['class corrected', 'date corrected', 'expiry corrected', 'holder corrected', 'holder or class correction refused', 'principal corrected', 'split',
    'split behind the ledger refused', 'split behind nothing'].sort());
});
