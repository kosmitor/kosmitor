/**
 * Golden cases for compliance and tax (compliance.ts, tax.ts, valuation-refresh.ts),
 * from the regulations' own examples and the IRS instructions. Each test cites its
 * source. A test marked { todo: 'BUG-ID' } pins the correct value for a confirmed bug
 * (math-audit-2026-10-05.md, section 2) and passes once the bug is fixed.
 *
 * Treas. Reg. 1.422-4: https://www.law.cornell.edu/cfr/text/26/1.422-4
 * 17 CFR 230.701: https://www.law.cornell.edu/cfr/text/17/230.701
 * IRS Form 15620 (83(b) election) instructions: https://www.irs.gov/pub/irs-pdf/f15620.pdf
 * IRS General Instructions for Certain Information Returns (2026), parts C and M: https://www.irs.gov/instructions/i1099gi
 * IRS Instructions for Forms 3921 and 3922: https://www.irs.gov/instructions/i3921
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoHundredKTest, rule701Test, runComplianceChecks, election83bRows, form3921Rows, form3921Status,
  beneficialOwnershipReport, type ISOLimitRow,
} from '../src/compliance.ts';
import { valuationRefresh } from '../src/valuation-refresh.ts';
import { modelExercise, modelSaleProceeds, assessQSBS } from '../src/tax.ts';
import { awardIsLive } from '../src/captable.ts';
import { dollarsToCents as $, dollarsToPPS as $$ } from '../src/util.ts';
import type { Award, CompanyData, Exercise } from '../src/types.ts';
import { company, holder, issuance, award, pool, valuation, schedule, fourYear, fullyVested, customSchedule, shareClass, preferred } from './builders.ts';
import { refIsoLimit, refRule701 } from './reference/tax.ts';
import { refBusinessDayOnOrAfter, refPlusDays, refValuationSupports } from './reference/calendar.ts';

/** Founder F with 10,000,000 common since 2000; employee E; a large plan. */
function taxCompany(o: Partial<CompanyData> = {}): CompanyData {
  return company({
    stakeholders: [holder('E', 'Employee', 'EMPLOYEE', { startDate: '2000-01-01' }), holder('F', 'Founder', 'FOUNDER', { startDate: '2000-01-01' })],
    issuances: [issuance('F', 'common', 10_000_000, $$(0.0001), '2000-01-01')],
    pools: [pool(50_000_000)],
    ...o,
  });
}

// ---------------------------------------------------------------------------
// ISO $100,000 limit, Treas. Reg. 1.422-4(d) examples. FMV $1 a share, so shares = dollars.
// ---------------------------------------------------------------------------

/** An ISO for `dollars` shares at $1, first exercisable in full on `exercisableFrom`. */
const iso = (id: string, grant: string, dollars: number, exercisableFrom: string, o: Partial<Award> = {}) =>
  award('E', dollars, { id, grantDate: grant, vestingStartDate: exercisableFrom, vestingScheduleId: fullyVested.id, strikePrice: $$(1), fmvAtGrant: $$(1), expirationDate: null, ...o });

const split = (rows: ISOLimitRow[]) => Object.fromEntries(rows.map((r) => [`${r.awardId}:${r.year}`, { iso: r.isoQualified, nso: r.nsoRecharacterized }]));
const only = <T>(o: Record<string, T>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/**
 * The $100K test given each cancellation's date. Reg 1.422-4(b)(5) turns on when a grant
 * was cancelled, so the dates go in as `cancellationDates` by award id, the way
 * stockCompReport takes them (TAX-1, TAX-3).
 */
const isoTest = (d: CompanyData, asOf: string, cancellationDates: Record<string, string> = {}) =>
  isoHundredKTest(d, asOf, { cancellationDates });

test('Treas. Reg. 1.422-4(d) Ex.1: a $100,000 grant exercisable each January for ten years is all ISO', () => {
  const awards = Array.from({ length: 10 }, (_, i) => iso(`y${2004 + i}`, `${2004 + i}-01-01`, 100_000, `${2004 + i}-01-01`));
  const want = refIsoLimit(awards.map((a) => ({ id: a.id, grant: a.grantDate, byYear: { [Number(a.grantDate.slice(0, 4))]: 100_000 } })));
  assert.deepEqual(split(isoHundredKTest(taxCompany({ awards }), '2014-01-01')), want);
  assert.ok(Object.values(want).every((v) => v.nso === 0));
});

test('Treas. Reg. 1.422-4(d) Ex.2: $100,000 in January then $75,000 in December; the later grant is all NSO', () => {
  const awards = [iso('Y', '2004-01-01', 100_000, '2004-01-01'), iso('Z', '2004-12-31', 75_000, '2004-12-31')];
  assert.deepEqual(split(isoHundredKTest(taxCompany({ awards }), '2005-01-01')), { 'Y:2004': { iso: 100_000, nso: 0 }, 'Z:2004': { iso: 0, nso: 75_000 } });
});

test('Treas. Reg. 1.422-4(d) Ex.3: an acceleration into 2004 makes O2 $40,000 ISO / $10,000 NSO and O3 all NSO', () => {
  // O2's $50,000 was due in 2006 and is accelerated to July 2004, modelled as a tranche on 2004-07-15.
  const awards = [iso('O1', '2004-04-01', 60_000, '2004-04-01'), iso('O2', '2004-05-01', 50_000, '2004-05-01', { vestingScheduleId: 'vs_acc' }), iso('O3', '2004-06-01', 40_000, '2004-06-01')];
  const d = taxCompany({ awards, vestingSchedules: [fullyVested, customSchedule('vs_acc', [{ date: '2004-07-15', quantity: 50_000 }])] });
  assert.deepEqual(split(isoHundredKTest(d, '2004-12-31')),
    { 'O1:2004': { iso: 60_000, nso: 0 }, 'O2:2004': { iso: 40_000, nso: 10_000 }, 'O3:2004': { iso: 0, nso: 40_000 } });
});

/** Reg Ex.5: O1 $60k, O2 $40k, O3 $40k, all first exercisable in 2005. */
const ex5 = (o2: Partial<Award>) => [iso('O1', '2004-04-01', 60_000, '2005-01-01'), iso('O2', '2004-05-01', 40_000, '2005-01-01', o2), iso('O3', '2004-06-01', 40_000, '2005-01-01')];
const ex5Ref = (cancelledOn?: string) => refIsoLimit([
  { id: 'O1', grant: '2004-04-01', byYear: { 2005: 60_000 } }, { id: 'O2', grant: '2004-05-01', byYear: { 2005: 40_000 }, cancelledOn },
  { id: 'O3', grant: '2004-06-01', byYear: { 2005: 40_000 } }]);
const EX5 = ['O1:2005', 'O2:2005', 'O3:2005'];

test('Treas. Reg. 1.422-4(d) Ex.5(ii): O2 cancelled on 2004-12-31, before its first year, is disregarded; O3 is ISO', () => {
  const d = taxCompany({ awards: ex5({ status: 'CANCELLED', cancelledQuantity: 40_000 }) });
  assert.deepEqual(only(split(isoTest(d, '2005-12-31', { O2: '2004-12-31' })), EX5), only(ex5Ref('2004-12-31'), EX5));
});

test('Treas. Reg. 1.422-4(d) Ex.5(iv): O2 exercised and sold in 2005 still counts; O3 is all NSO', () => {
  const d = taxCompany({ awards: ex5({ status: 'EXERCISED', exercisedQuantity: 40_000 }) });
  assert.deepEqual(only(split(isoHundredKTest(d, '2005-12-31')), EX5), only(ex5Ref(), EX5));
  assert.deepEqual(ex5Ref()['O3:2005'], { iso: 0, nso: 40_000 });
});

test('Treas. Reg. 1.422-4(d) Ex.6: one $150,000 option exercisable at once is $100,000 ISO and $50,000 NSO', () => {
  assert.deepEqual(split(isoHundredKTest(taxCompany({ awards: [iso('X', '2004-01-01', 150_000, '2004-01-01')] }), '2004-12-31')), { 'X:2004': { iso: 100_000, nso: 50_000 } });
});

test('IRC 422(d)(1) "exceeds $100,000": exactly $100,000 is within the limit and raises no finding', () => {
  const d = taxCompany({ awards: [iso('E1', '2024-01-01', 100_000, '2024-01-01')] });
  const [r] = isoHundredKTest(d, '2024-12-31');
  assert.deepEqual([r.exceeded, r.nsoRecharacterized], [false, 0]);
  assert.equal(runComplianceChecks(d, { asOf: '2024-12-31' }).filter((i) => i.rule === 'ISO_100K').length, 0);
});

test('Treas. Reg. 1.422-4(d) Ex.4(ii): an exercise before an acceleration is ordered first; O3 ISO, O2 $20,000 ISO / $20,000 NSO', () => {
  // O3 ($20k, first exercisable 2005) is exercised on 2005-06-01; O2 ($40k) is accelerated into 2005 on
  // 2005-09-01. An acceleration provision "does not affect the application of the $100,000 limitation with
  // respect to any option (or portion thereof) exercised prior to such acceleration" (b)(4). (b)(4) names a
  // performance goal as an acceleration provision, so O2 becomes exercisable on a milestone met that day.
  // Before the TAX-4 fix the app ordered by grant date only: O2 $40k ISO, O3 all NSO.
  const awards = [iso('O1', '2004-04-01', 60_000, '2005-01-01'), iso('O2', '2004-05-01', 40_000, '2004-05-01', { vestingScheduleId: 'vs_acc2' }),
    iso('O3', '2004-06-01', 20_000, '2005-01-01', { status: 'EXERCISED', exercisedQuantity: 20_000 })];
  const exercises: Exercise[] = [{ id: 'x_o3', awardId: 'O3', stakeholderId: 'E', quantity: 20_000, exerciseDate: '2005-06-01', method: 'CASH', strikePrice: $$(1), fmvAtExercise: $$(2), sharesIssued: 20_000, status: 'COMPLETED' }];
  const accelerated = schedule({ id: 'vs_acc2', kind: 'MILESTONE', durationMonths: 0, cliffMonths: 0,
    milestones: [{ id: 'm', name: 'Performance goal met', portion: 1, targetDate: null, achievedDate: '2005-09-01' }] });
  const d = taxCompany({ awards, exercises, vestingSchedules: [fullyVested, accelerated] });
  const want = refIsoLimit([
    { id: 'O1', grant: '2004-04-01', byYear: { 2005: 60_000 }, order: 0 }, { id: 'O3', grant: '2004-06-01', byYear: { 2005: 20_000 }, order: 1 },
    { id: 'O2', grant: '2004-05-01', byYear: { 2005: 40_000 }, order: 2 }]);
  assert.deepEqual(want['O2:2005'], { iso: 20_000, nso: 20_000 });
  assert.deepEqual(only(split(isoHundredKTest(d, '2005-12-31')), EX5), only(want, EX5));
  // The ISO_100K finding counts O2's 20,000 shares, not O3's.
  const finding = runComplianceChecks(d, { asOf: '2005-12-31' }).find((i) => i.rule === 'ISO_100K')!;
  assert.match(finding.detail, /20,000 shares are recharacterised/);
  assert.equal(finding.amount, $(20_000));

  // A tranche the schedule set at grant is not an acceleration: an option "will become exercisable at
  // any time during the year" counts for the whole year (b)(4), in grant order (b)(3), whenever O3 was exercised.
  const scheduled = taxCompany({ awards, exercises, vestingSchedules: [fullyVested, customSchedule('vs_acc2', [{ date: '2005-09-01', quantity: 40_000 }])] });
  assert.deepEqual(only(split(isoHundredKTest(scheduled, '2005-12-31')), EX5), only(refIsoLimit([
    { id: 'O1', grant: '2004-04-01', byYear: { 2005: 60_000 } }, { id: 'O2', grant: '2004-05-01', byYear: { 2005: 40_000 } },
    { id: 'O3', grant: '2004-06-01', byYear: { 2005: 20_000 } }]), EX5));
});

test('Treas. Reg. 1.422-4(b)(4): an ISO whose vesting schedule is missing is taken as fully vested, $100,000 ISO / $50,000 NSO', () => {
  // TAX-5. The cap table and the exercise-window check treat a grant with no schedule as fully vested;
  // the $100K test used to leave it out, so a $150,000 grant raised no finding and had no Form 3921 row.
  const d = taxCompany({ awards: [iso('X', '2025-01-01', 150_000, '2025-01-01', { vestingScheduleId: 'missing' })] });
  assert.deepEqual(split(isoHundredKTest(d, '2025-12-31')), { 'X:2025': { iso: 100_000, nso: 50_000 } });
  d.exercises = [{ id: 'x', awardId: 'X', stakeholderId: 'E', quantity: 150_000, exerciseDate: '2025-06-01', method: 'CASH', strikePrice: $$(1), fmvAtExercise: $$(3), sharesIssued: 150_000, status: 'COMPLETED' }];
  assert.deepEqual(form3921Rows(d, 2025).map((r) => r.quantity), [100_000]);
});

test('Treas. Reg. 1.422-4(d) Ex.5(iii): O2 cancelled on 2005-01-01, in its first year, still counts; O3 is all NSO', () => {
  // (b)(5)(ii): a cancellation during the year leaves the option outstanding to year end. Before the TAX-1
  // fix the app dropped every CANCELLED grant from every year: O3 $40k ISO.
  const d = taxCompany({ awards: ex5({ status: 'CANCELLED', cancelledQuantity: 40_000 }) });
  assert.deepEqual(only(split(isoTest(d, '2005-12-31', { O2: '2005-01-01' })), EX5), only(ex5Ref('2005-01-01'), EX5));
});

test('Treas. Reg. 1.422-4(b)(5): a grant exercised in 2024 and cancelled at year end still counts in 2024', () => {
  // A (2023) has $80k first exercisable 2024-01-01, exercised, and $80k due 2025, cancelled 2024-12-31.
  // B: $50k first exercisable 2024-03-01. 2024 holds $130k, so B is $20k ISO / $30k NSO. Before the TAX-1
  // fix the app dropped A entirely and called B all ISO.
  const awards = [
    iso('A', '2023-01-01', 160_000, '2023-01-01', { vestingScheduleId: 'vs_c1', status: 'CANCELLED', exercisedQuantity: 80_000, cancelledQuantity: 80_000 }),
    iso('B', '2024-03-01', 50_000, '2024-03-01')];
  const d = taxCompany({ awards, vestingSchedules: [fullyVested, customSchedule('vs_c1', [{ date: '2024-01-01', quantity: 80_000 }, { date: '2025-01-01', quantity: 80_000 }])] });
  const want = refIsoLimit([{ id: 'A', grant: '2023-01-01', byYear: { 2024: 80_000 } }, { id: 'B', grant: '2024-03-01', byYear: { 2024: 50_000 } }]);
  assert.deepEqual(only(split(isoTest(d, '2025-12-31', { A: '2024-12-31' })), ['A:2024', 'B:2024', 'A:2025']), only(want, ['A:2024', 'B:2024', 'A:2025']));
});

test('Treas. Reg. 1.422-4(b)(4), (b)(5)(ii): tranches forfeited at a mid-year termination still count for that year', () => {
  // E leaves 2025-06-30. A (2023) has $60k on 2025-02-01 and $60k on 2025-11-01; services are assumed
  // performed (b)(4) and the forfeiture leaves the tranche outstanding to year end (b)(5)(ii). B: $50k,
  // early-exercisable, granted 2025-01-15. 2025 holds $170k: A $100k ISO / $20k NSO, B all NSO.
  // Before the TAX-2 fix the app cut vesting at the termination: A $60k ISO, B $40k ISO / $10k NSO.
  const awards = [iso('A', '2023-01-01', 120_000, '2023-01-01', { vestingScheduleId: 'vs_t1' }),
    iso('B', '2025-01-15', 50_000, '2025-01-15', { vestingScheduleId: fourYear.id, earlyExerciseAllowed: true })];
  const d = taxCompany({ awards, vestingSchedules: [fullyVested, fourYear, customSchedule('vs_t1', [{ date: '2025-02-01', quantity: 60_000 }, { date: '2025-11-01', quantity: 60_000 }])] });
  d.stakeholders[0].terminationDate = '2025-06-30';
  const want = refIsoLimit([{ id: 'A', grant: '2023-01-01', byYear: { 2025: 120_000 } }, { id: 'B', grant: '2025-01-15', byYear: { 2025: 50_000 } }]);
  assert.deepEqual(split(isoHundredKTest(d, '2025-12-31')), want);
});

test('Treas. Reg. 1.422-4(d) Ex.5(ii): a part of an outstanding grant cancelled before its first year is disregarded', () => {
  // O2 stays OUTSTANDING with its 40,000 cancelled on 2004-12-31 (the app's cancel route leaves partial
  // cancellations OUTSTANDING). O3 is then all ISO; before the TAX-3 fix the app counted the cancelled shares and made O3 NSO.
  const d = taxCompany({ awards: ex5({ status: 'OUTSTANDING', cancelledQuantity: 40_000 }) });
  const got = split(isoTest(d, '2005-12-31', { O2: '2004-12-31' }));
  assert.deepEqual(got['O3:2005'], { iso: 40_000, nso: 0 });
  assert.equal(got['O2:2005']?.iso ?? 0, 0);
});

// ---------------------------------------------------------------------------
// Rule 701(d) and (e)
// ---------------------------------------------------------------------------

const nso = (id: string, date: string, shares: number, strike: number, o: Partial<Award> = {}) =>
  award('E', shares, { id, type: 'NSO', grantDate: date, strikePrice: $$(strike), fmvAtGrant: $$(strike), vestingScheduleId: fullyVested.id, ...o });
const r701 = (d: CompanyData, assets = 0) => {
  const r = rule701Test(d, '2025-06-30', $(assets));
  return { value: r.aggregateValue, shares: r.sharesSold, exceeded: r.exceeded, disclosure: r.disclosureThresholdMet };
};

test('17 CFR 230.701(d)(2)(i): exactly $1,000,000 of options is within the ceiling; one dollar more exceeds all three', () => {
  // 10,000,000 common outstanding, no assets; both grants also exceed 15% of the class.
  const g = (shares: number) => [{ date: '2025-01-15', shares, kind: 'OPTION' as const, price: 0.5, fmv: 0.5 }];
  assert.deepEqual(r701(taxCompany({ awards: [nso('g', '2025-01-15', 2_000_000, 0.5)] })), refRule701(g(2_000_000), '2025-06-30', '2024-06-30', 0, 10_000_000));
  const over = r701(taxCompany({ awards: [nso('g', '2025-01-15', 2_000_002, 0.5)] }));
  assert.deepEqual(over, refRule701(g(2_000_002), '2025-06-30', '2024-06-30', 0, 10_000_000));
  assert.equal(over.exceeded, true);
});

test('17 CFR 230.701(d)(2)(ii): with $10M of total assets the ceiling is $1.5M, so $1.2M of options is within', () => {
  const r = r701(taxCompany({ awards: [nso('g', '2025-01-15', 2_400_000, 0.5)] }), 10_000_000);
  assert.deepEqual(r, refRule701([{ date: '2025-01-15', shares: 2_400_000, kind: 'OPTION', price: 0.5, fmv: 0.5 }], '2025-06-30', '2024-06-30', 10_000_000, 10_000_000));
  assert.equal(r.exceeded, false);
});

test('17 CFR 230.701(d)(3)(i), C&DI 271.24: RSUs count at the value of the stock, $1,200,000 for 100,000 at $12', () => {
  const r = r701(taxCompany({ awards: [award('E', 100_000, { id: 'r', type: 'RSU', grantDate: '2025-01-15', strikePrice: 0, fmvAtGrant: $$(12) })] }));
  assert.equal(r.value, $(1_200_000));
});

test('17 CFR 230.701(d)(2): the 12-month window ending 2025-06-30 starts after 2024-06-30', () => {
  const d = taxCompany({ awards: [nso('out', '2024-06-30', 1_000_000, 1), nso('in', '2024-07-01', 900_000, 1)] });
  assert.deepEqual(rule701Test(d, '2025-06-30', 0).grants.map((g) => g.awardId), ['in']);
});

test('17 CFR 230.701(d)(1), (d)(3)(ii): a cancelled option still counts, because the sale happened at grant', () => {
  const r = rule701Test(taxCompany({ awards: [nso('g', '2025-01-15', 1_000, 2, { status: 'CANCELLED', cancelledQuantity: 1_000 })] }), '2025-06-30', 0);
  assert.equal(r.aggregateValue, $(2_000));
});

test('17 CFR 230.701(e), C&DI 271.26: $10,000,000 needs no disclosure; $10,000,001 does', () => {
  assert.equal(rule701Test(taxCompany({ awards: [nso('g', '2025-01-15', 10_000_000, 1)] }), '2025-06-30', 0).disclosureThresholdMet, false);
  assert.equal(rule701Test(taxCompany({ awards: [nso('g', '2025-01-15', 10_000_001, 1)] }), '2025-06-30', 0).disclosureThresholdMet, true);
});

test('17 CFR 230.701(d)(3)(i): restricted stock given for services counts at the value of the stock, $1,200,000', () => {
  // 100,000 RSA shares at a $0 price with FMV $12. The app counts the $0 price.
  const r = r701(taxCompany({ awards: [award('E', 100_000, { id: 's', type: 'RSA', grantDate: '2025-01-15', strikePrice: 0, fmvAtGrant: $$(12) })] }));
  assert.equal(r.value, $(1_200_000));
});

test('17 CFR 230.701(d)(2)(iii): 15% of the class is measured at the last balance sheet date (10M at FYE 2024), so 2.5M options exceed', () => {
  // Another 10,000,000 common issued 2025-03-01 must not raise the share ceiling. 2.5M options at $1 on
  // 2025-04-01: $2.5M > $1M and 2.5M > 1.5M shares. The app measures on 2025-06-30 (3M ceiling).
  const d = taxCompany({ awards: [nso('g', '2025-04-01', 2_500_000, 1)] });
  d.issuances.push(issuance('F', 'common', 10_000_000, $$(0.0001), '2025-03-01'));
  assert.equal(r701(d).exceeded, true);
});

test('17 CFR 230.701(d)(2): an exceeded Rule 701 finding reports a positive excess', () => {
  // 2.5M options at $0.50 ($1.25M) with a $5 FMV: $250,000 over $1M and 1,000,000 shares over the
  // share ceiling. The app compares to 1.5M shares x $5 and reports -$6,250,000.
  const d = taxCompany({ valuations: [valuation({ fairMarketValue: $$(5), effectiveDate: '2025-01-01' })], awards: [nso('g', '2025-02-01', 2_500_000, 0.5, { boardApprovalDate: '2025-02-01' })] });
  assert.equal(rule701Test(d, '2025-06-30', 0).exceeded, true);
  const finding = runComplianceChecks(d, { asOf: '2025-06-30' }).find((i) => i.rule === 'RULE_701')!;
  assert.ok((finding.amount ?? 0) > 0, `amount ${finding.amount}`);
});

// ---------------------------------------------------------------------------
// 83(b) and Form 3921 deadlines: IRC 7503 moves a weekend or legal-holiday deadline to the next business day
// ---------------------------------------------------------------------------

/** Restricted stock transferred on `date`, vesting over four years. */
const restricted = (date: string) => taxCompany({ issuances: [issuance('E', 'common', 1_000, $$(0.0001), date, { id: 'rs', vestingScheduleId: fourYear.id, vestingStartDate: date })] });
const deadline83b = (date: string) => election83bRows(restricted(date), date).find((r) => r.issuanceId === 'rs')!.deadline;

test('Treas. Reg. 1.83-2(b): stock transferred 2024-05-01 must have its 83(b) election filed by Friday 2024-05-31', () => {
  assert.equal(deadline83b('2024-05-01'), '2024-05-31');
  assert.equal(refBusinessDayOnOrAfter(refPlusDays('2024-05-01', 30)), '2024-05-31');
});

test('IRS Form 15620 (IRC 7503): day 30 on Saturday 2026-01-31 moves the 83(b) deadline to Monday 2026-02-02, and the window is open that day', () => {
  // Before the TAX-7 fix the app said 2026-01-31 and, on 2026-02-02, "83(b) election window has closed … not extendable".
  assert.equal(deadline83b('2026-01-01'), '2026-02-02');
  assert.equal(election83bRows(restricted('2026-01-01'), '2026-02-02').find((r) => r.issuanceId === 'rs')!.status, 'OPEN');
  assert.ok(!runComplianceChecks(restricted('2026-01-01'), { asOf: '2026-02-02' }).some((i) => i.rule === '83B_DEADLINE' && i.title.includes('closed')));
});

test('IRS Form 15620 (IRC 7503): day 30 on a legal holiday moves the 83(b) deadline (2025-07-04 to 2025-07-07; 2027-02-14 to 2027-02-16)', () => {
  // 2027-02-14 is a Sunday and Monday 2027-02-15 is Washington's Birthday.
  assert.equal(deadline83b('2025-06-04'), '2025-07-07');
  assert.equal(deadline83b('2027-01-15'), '2027-02-16');
});

test('Independent reference reproduces the IRS calendar: tax year 2025 Forms 3921 go out by Feb 2 and are filed by Mar 2 (paper) or Mar 31 (e-file)', () => {
  // The 2026 General Instructions print these dates: "File ... on paper by March 2, 2026, or March 31,
  // 2026, if e-filing", and furnish by February 2, 2026.
  assert.deepEqual(['2026-01-31', '2026-02-28', '2026-03-31'].map(refBusinessDayOnOrAfter), ['2026-02-02', '2026-03-02', '2026-03-31']);
  assert.deepEqual(['2025-06-04', '2027-01-15'].map((d) => refBusinessDayOnOrAfter(refPlusDays(d, 30))), ['2025-07-07', '2027-02-16']);
});

// The Form 3921 dates themselves (tax years 2025 and 2026, TAX-8) are pinned in compliance.test.ts,
// where they replace the old pin of the unrolled dates.

/** An ISO granted 2027-01-01 for 1,000 shares at $1, exercised 2029-06-01 at a $5 FMV. */
function isoExercised2029(): CompanyData {
  const d = taxCompany({ awards: [award('E', 1_000, { id: 'iso', type: 'ISO', grantDate: '2027-01-01', strikePrice: $$(1), fmvAtGrant: $$(1), vestingScheduleId: fullyVested.id })] });
  d.exercises = [{ id: 'x', awardId: 'iso', stakeholderId: 'E', quantity: 1_000, exerciseDate: '2029-06-01', method: 'CASH', strikePrice: $$(1), fmvAtExercise: $$(5), sharesIssued: 1_000, status: 'COMPLETED' }];
  return d;
}

test('IRS Instructions for Form 3921, boxes 1-5: grant date, exercise date, $1.00 price, $5.00 FMV, 1,000 shares; spread $4,000', () => {
  const [r] = form3921Rows(isoExercised2029(), 2029);
  assert.deepEqual([r.grantDate, r.exerciseDate, r.exercisePrice, r.fmvAtExercise, r.quantity, r.spread], ['2027-01-01', '2029-06-01', $$(1), $$(5), 1_000, $(4_000)]);
});

test('IRS General Instructions part C: on Monday 2030-04-01, the real e-file deadline for tax year 2029, Form 3921 is due, not overdue', () => {
  // March 31, 2030 is a Sunday. Before the TAX-8 fix the app marked the year OVERDUE and raised an error that day.
  assert.equal(form3921Status(isoExercised2029(), '2030-04-01').find((s) => s.year === 2029)!.state, 'DUE');
});

test('IRC 6039(a), 422(d); Treas. Reg. 1.422-4(c)(2): Form 3921 reports only the 100,000 ISO shares of a $150,000 grant', () => {
  // The 50,000 shares over the limit are NSO stock and go on the W-2. Before the TAX-6 fix the app reported all 150,000.
  const d = taxCompany({ awards: [award('E', 150_000, { id: 'big', type: 'ISO', grantDate: '2025-01-01', strikePrice: $$(1), fmvAtGrant: $$(1), vestingScheduleId: fullyVested.id })] });
  d.exercises = [{ id: 'x', awardId: 'big', stakeholderId: 'E', quantity: 150_000, exerciseDate: '2025-06-01', method: 'CASH', strikePrice: $$(1), fmvAtExercise: $$(4), sharesIssued: 150_000, status: 'COMPLETED' }];
  assert.deepEqual(form3921Rows(d, 2025).map((r) => r.quantity), [100_000]);
});

test('Treas. Reg. 1.422-4(c)(2): Box 5 counts whole ISO shares, 33,333 at a $3 grant-date FMV and 300,000 after a 3-for-1 split', () => {
  // "Shares are treated as first purchased under an incentive stock option to the extent of the $100,000
  // limitation": 33,333 shares at $3 are $99,999 and the next share would pass $100,000, so it is NSO stock.
  // After a 3-for-1 split the $1 grant's $100,000 is 300,000 shares, though the split price is stored as
  // $0.333333 (CAP-3). Spreads: 33,333 x $2 = $66,666; 300,000 x ($2 - $0.333333) = $500,000.10.
  const exercise = (quantity: number, strike: number, fmv: number): Exercise =>
    ({ id: 'x', awardId: 'g', stakeholderId: 'E', quantity, exerciseDate: '2025-06-01', method: 'CASH', strikePrice: $$(strike), fmvAtExercise: $$(fmv), sharesIssued: quantity, status: 'COMPLETED' });
  const grant = (quantity: number, fmv: number) => award('E', quantity, { id: 'g', type: 'ISO', grantDate: '2025-01-01', strikePrice: $$(fmv), fmvAtGrant: $$(fmv), vestingScheduleId: fullyVested.id });
  const atThree = taxCompany({ awards: [grant(50_000, 3)], exercises: [exercise(50_000, 3, 5)] });
  assert.deepEqual(form3921Rows(atThree, 2025).map((r) => [r.quantity, r.spread]), [[33_333, $(66_666)]]);
  const split = taxCompany({ awards: [grant(150_000, 1)], exercises: [exercise(450_000, 1 / 3, 2)], stockSplits: [{ id: 'sp', date: '2025-03-01', ratio: 3 }] });
  assert.deepEqual(form3921Rows(split, 2025).map((r) => [r.quantity, r.spread]), [[300_000, 50_000_010]]);
});

// ---------------------------------------------------------------------------
// 409A safe harbor, Treas. Reg. 1.409A-1(b)(5)(iv)(B): a valuation more than 12 months old no longer supports a grant
// ---------------------------------------------------------------------------

test('Treas. Reg. 1.409A-1(b)(5)(iv)(B): a 409A supports grants through the 12-month anniversary, leap day included', () => {
  const supports = (v: string, g: string) =>
    !valuationRefresh(taxCompany({ valuations: [valuation({ effectiveDate: v })], awards: [nso('g', '2020-01-01', 1, 1)] }), g).triggers
      .some((t) => t.reason === 'EXPIRED' && t.severity === 'REQUIRED');
  for (const [v, g] of [['2025-01-15', '2026-01-15'], ['2025-01-15', '2026-01-16'], ['2024-02-29', '2025-02-28'], ['2024-02-29', '2025-03-01'], ['2025-08-31', '2026-08-31'], ['2025-08-31', '2026-09-01']]) {
    assert.equal(supports(v, g), refValuationSupports(v, g), `409A of ${v} for a grant on ${g}`);
  }
  assert.deepEqual([supports('2025-01-15', '2026-01-15'), supports('2025-01-15', '2026-01-16'), supports('2024-02-29', '2025-02-28'), supports('2024-02-29', '2025-03-01')], [true, false, true, false]);
});

test('Treas. Reg. 1.409A-1(b)(5)(iv)(B)(2)(i): a grant made outside the safe harbor stays flagged once a new 409A arrives', () => {
  // TAX-14. The 409A of 2024-01-01 supports grants through 2025-01-01; the next is dated 2025-06-01. The grant
  // of 2025-03-01 had no safe harbor, and the later valuation does not give it one. The superseded 409A
  // still supported the grant of 2024-06-01 when it was made.
  const d = taxCompany({
    valuations: [valuation({ effectiveDate: '2024-01-01', status: 'SUPERSEDED' }), valuation({ effectiveDate: '2025-06-01', fairMarketValue: $$(1.2) })],
    awards: [nso('in', '2024-06-01', 1_000, 1), nso('gap', '2025-03-01', 1_000, 1), nso('after', '2025-06-15', 1_000, 1.2)],
  });
  const strike = runComplianceChecks(d, { asOf: '2025-07-01' }).filter((i) => i.rule === 'STRIKE_BELOW_FMV');
  assert.deepEqual(strike.map((i) => [i.subjectId, i.severity, i.title]), [['gap', 'WARNING', 'Grant made outside the 409A safe harbor']]);
  assert.match(strike[0].detail, /the 409A valuation of Jan 1, 2024 had stopped supporting new grants after Jan 1, 2025/);
  assert.ok(!runComplianceChecks(d, { asOf: '2025-07-01' }).some((i) => i.rule === 'VALUATION_409A'), 'the current 409A is fine');
});

test('Treas. Reg. 1.409A-1(b)(5)(i): a strike compared with a preferred price is not called below fair market value', () => {
  // TAX-14. Only a $2.00 preferred price is on file; the NSO is struck at $0.50. A preferred price is not the
  // common stock's fair market value, so the finding names what it was compared with and the missing 409A.
  const d = taxCompany({ valuations: [valuation({ type: 'PREFERRED_PRICE', fairMarketValue: $$(2), effectiveDate: '2024-01-01' })], awards: [nso('g', '2024-06-01', 1_000, 0.5)] });
  const found = runComplianceChecks(d, { asOf: '2024-07-01' }).filter((i) => i.subjectId === 'g' && i.rule === 'STRIKE_BELOW_FMV');
  assert.deepEqual(found.map((i) => [i.severity, i.title]), [['ERROR', 'Strike price below the preferred stock price']]);
  assert.match(found[0].detail, /\$2\.0000 preferred stock price of Jan 1, 2024.*no 409A valuation/);
  assert.doesNotMatch(found[0].detail, /FMV/);
});

test('Treas. Reg. 1.409A-1(b)(5)(i): a strike set at the split-adjusted 409A price, to the micro-cent, is not discounted', () => {
  // A $0.10 409A of 2025-01-15, then a 3-for-1 split on 2025-03-01: $0.0333333... a share, which the app quotes
  // as $0.033333. An NSO granted 2025-04-01 at $0.033333 is at the fair market value as closely as a strike can be
  // stored. A grant before the split struck one micro-cent under the 409A, $0.099999, is still flagged after
  // it. Before the fix the app compared the stored strike with the unrounded price and called the first one
  // discounted.
  const d = taxCompany({
    valuations: [valuation({ fairMarketValue: $$(0.10), effectiveDate: '2025-01-15' })],
    stockSplits: [{ id: 'split', date: '2025-03-01', ratio: 3 }],
    awards: [nso('after', '2025-04-01', 30_000, 0.033333), nso('under', '2025-02-01', 10_000, 0.099999)],
  });
  const strike = runComplianceChecks(d, { asOf: '2025-06-01' }).filter((i) => i.rule === 'STRIKE_BELOW_FMV');
  assert.deepEqual(strike.map((i) => [i.subjectId, i.severity]), [['under', 'ERROR']]);
});

test('NVCA model COI reservation covenant: common short of what it must reserve is an error that says by how much', () => {
  // The audit's CAP-8 case: 10,000,000 common authorized, 8,000,000 issued, a 2,000,000 plan and 1,000,000 Series A
  // converting 1:1, so 3,000,000 must stay reserved and common is 1,000,000 short. Before the fix the app warned
  // "Only -1,000,000 authorized Common shares remain unissued". With 11,500,000 authorized, 3,500,000 are
  // unissued but only 500,000 unreserved, which is what the warning now says.
  const at = (authorized: number) => runComplianceChecks(company({
    shareClasses: [shareClass({ id: 'common', name: 'Common', authorized }), preferred('A', 'Series A', 1, { authorized: 1_000_000 })],
    stakeholders: [holder('F', 'Founder'), holder('I', 'Investor', 'INVESTOR')],
    issuances: [issuance('F', 'common', 8_000_000, $$(0.0001), '2020-01-01'), issuance('I', 'A', 1_000_000, $$(1), '2021-06-01')],
    pools: [pool(2_000_000)],
  }), { asOf: '2025-01-01' }).filter((i) => i.rule === 'AUTHORIZED_CAPACITY');
  const short = at(10_000_000);
  assert.deepEqual(short.map((i) => [i.severity, i.title]), [['ERROR', 'Common authorized shares fall short of what must be reserved']]);
  assert.match(short[0].detail, /^Common is 1,000,000 shares short of what it must keep reserved for plans, warrants and conversion: 10,000,000 authorized, 8,000,000 issued and 3,000,000 reserved\./);
  const tight = at(11_500_000);
  assert.deepEqual(tight.map((i) => i.severity), ['WARNING']);
  assert.match(tight[0].detail, /^Only 500,000 authorized Common shares remain unissued and unreserved: 8,000,000 are issued and 3,000,000 reserved/);
  assert.deepEqual(at(20_000_000), []);
});

// ---------------------------------------------------------------------------
// Tax: IRC 83, 422, 1202, 3121
// ---------------------------------------------------------------------------

const isoAt100 = award('E', 100, { id: 'iso_100', type: 'ISO', grantDate: '2006-06-01', strikePrice: $$(100), fmvAtGrant: $$(100) });

test('Treas. Reg. 1.422-1(b)(3) Ex.1, Ex.3(ii), Ex.3(iv): disqualifying sales of 100 ISO shares exercised at $100 with a $200 FMV', () => {
  // Sold at $250: $10,000 ordinary, $5,000 gain. At $150: $5,000 ordinary, no gain. At $50: no ordinary, $5,000 loss.
  for (const [sale, ordinary, gain] of [[250, 10_000, 5_000], [150, 5_000, 0], [50, 0, -5_000]]) {
    const s = modelSaleProceeds(isoAt100, 100, $$(sale), { exercisedOn: '2006-08-01', saleDate: '2007-06-01', fmvAtExercise: $$(200) });
    assert.deepEqual([s.ordinaryIncomePortion, s.capitalGainPortion], [$(ordinary), $(gain)], `sale at $${sale}`);
  }
});

test('IRC 422(a)(1): a qualifying ISO sale is all long-term gain; grant 2024-03-31 and exercise 2024-06-15 qualify from 2026-04-01', () => {
  // "More than 2 years" from grant and "more than 1 year" from exercise (Rev. Rul. 66-7 day counting).
  const q = modelSaleProceeds(isoAt100, 100, $$(250), { exercisedOn: '2007-06-02', saleDate: '2008-06-03', fmvAtExercise: $$(200) });
  assert.deepEqual([q.ordinaryIncomePortion, q.capitalGainPortion, q.isLongTerm], [0, $(15_000), true]);
  const e = modelExercise(taxCompany(), award('E', 10, { id: 'iso2', type: 'ISO', grantDate: '2024-03-31', strikePrice: $$(1), fmvAtGrant: $$(1) }), 10, { asOf: '2024-06-15', fmv: $$(2) });
  assert.equal(e.qualifyingDispositionDate, '2026-04-01');
});

test('IRC 83(a): RSUs settled at $5 and sold at $10 are $5 a share of ordinary income and $5 of gain; the settlement FMV is required', () => {
  // TAX-17. The RSU was worth $1 at grant. Before the fix an omitted settlement FMV fell back to the grant-date
  // $1, giving $1 of ordinary income and $9 of gain a share.
  const rsu = award('E', 100, { id: 'rsu', type: 'RSU', strikePrice: 0, fmvAtGrant: $$(1) });
  const s = modelSaleProceeds(rsu, 100, $$(10), { exercisedOn: '2025-01-15', saleDate: '2025-06-15', fmvAtExercise: $$(5) });
  assert.deepEqual([s.ordinaryIncomePortion, s.capitalGainPortion], [$(500), $(500)]);
  assert.throws(() => modelSaleProceeds(rsu, 100, $$(10), { exercisedOn: '2025-01-15', saleDate: '2025-06-15' } as never), RangeError);
});

test('IRC 1202 as amended by OBBBA §70431: holding periods for 0 / 50 / 75 / 100% exclusion', () => {
  // Stock acquired before July 5, 2025 needs more than five years; later stock gets 50% at three
  // years, 75% at four, 100% at five ("at least"). The 2009-2010 windows give 75%; earlier stock 50%.
  const pct = (acquired: string, asOf: string) => assessQSBS(acquired, $(1), { asOf, isCCorp: true }).exclusionPct;
  assert.deepEqual([pct('2020-01-01', '2025-01-01'), pct('2020-01-01', '2025-01-02')], [0, 1]);
  assert.deepEqual(['2028-08-01', '2029-08-01', '2030-08-01'].map((d) => pct('2025-08-01', d)), [0.5, 0.75, 1]);
  assert.equal(assessQSBS('2025-07-04', $(1), { asOf: '2026-01-01' }).regime, 'ORIGINAL');
  assert.deepEqual(['2009-02-17', '2009-02-18', '2010-09-27', '2010-09-28'].map((d) => pct(d, '2020-01-01')), [0.5, 0.75, 0.75, 1]);
});

test('IRC 3121(a): exercising 1,000 SARs at a $1 base with a $3 FMV pays $2,000 of wages; Medicare at 2.35% is $47.00', () => {
  // A SAR pays only the appreciation. The app takes the spread as the full $3,000 and charges $70.50.
  const sar = award('E', 1_000, { id: 'sar', type: 'SAR', strikePrice: $$(1), fmvAtGrant: $$(1) });
  const s = modelExercise(taxCompany({ awards: [sar] }), sar, 1_000, { asOf: '2025-01-01', fmv: $$(3), rates: { medicare: 0.0235, socialSecurity: 0 } });
  assert.deepEqual([s.spread, s.ordinaryIncome, s.payrollTax], [$(2_000), $(2_000), $(47)]);
});

// ---------------------------------------------------------------------------
// Beneficial ownership and exercise windows
// ---------------------------------------------------------------------------

test('31 CFR 1010.380(d)(2)(iii): 2.6M of 10M outstanding is 26%, so the holder is a beneficial owner; others\' options do not dilute it', () => {
  // Only the individual's own options count as exercised. The app divides by fully diluted (11M): 23.6%.
  // Domestic companies are now exempt from filing, so this matters only for those that still report.
  const d = taxCompany({
    stakeholders: [holder('ANGEL', 'Angel investor', 'INVESTOR'), holder('F', 'Founder'), holder('E', 'Employee', 'EMPLOYEE')],
    issuances: [issuance('F', 'common', 7_400_000, $$(0.0001), '2020-01-01'), issuance('ANGEL', 'common', 2_600_000, $$(0.0001), '2020-01-01')],
    awards: [nso('opt', '2024-01-01', 1_000_000, 0.1)],
  });
  assert.deepEqual(beneficialOwnershipReport(d, { asOf: '2025-01-01' }).owners.find((o) => o.stakeholderId === 'ANGEL')?.reasons ?? [], ['ownership']);
});

/** An NSO with a recorded 0-month exercise window; the holder left 2025-01-15. */
function zeroWindow(): CompanyData {
  const d = taxCompany({ awards: [nso('g', '2023-01-01', 1_000, 1, { ptepMonths: 0, boardApprovalDate: '2023-01-01' })] });
  d.stakeholders[0].terminationDate = '2025-01-15';
  return d;
}

test('captable.ts awardIsLive contract: a recorded 0-month window closes on the day the holder leaves', () => {
  const a = zeroWindow().awards[0];
  assert.deepEqual([awardIsLive(a, '2025-01-15', '2025-01-15'), awardIsLive(a, '2025-01-16', '2025-01-15')], [true, false]);
});

test('captable.ts awardIsLive contract: compliance agrees that a 0-month window lapsed on 2025-01-15', () => {
  // The cap table drops the grant on 2025-01-16, but compliance reads 0 as "use the 3-month default"
  // and raises nothing until a window closing 2025-04-15. (The server's performExercise has the same
  // problem; it is outside this package.)
  const lapsed = runComplianceChecks(zeroWindow(), { asOf: '2025-02-01' }).filter((i) => i.rule.startsWith('PTEP')).map((i) => `${i.rule}:${i.dueDate}`);
  assert.deepEqual(lapsed, ['PTEP_EXPIRED:2025-01-15']);
});
