import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoHundredKTest, rule701Test, runComplianceChecks, complianceSummary } from '../src/compliance.ts';
import { seedCompany, $$ } from './fixtures.ts';
import { dollarsToCents as $ } from '../src/util.ts';
import type { Award, Issuance, VestingSchedule } from '../src/types.ts';

const fullyVested: VestingSchedule = {
  id: 'vs_now', name: 'Fully vested', kind: 'FULLY_VESTED', durationMonths: 0, cliffMonths: 0,
  frequency: 'MONTHLY', immediatePortion: 1, yearWeights: null, milestones: null, customTranches: null,
  accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null,
};

function award(o: Partial<Award>): Award {
  return {
    id: `aw_${Math.random().toString(36).slice(2, 8)}`, label: null, stakeholderId: 'sh_e', poolId: 'pool_1',
    type: 'ISO', quantity: 1_000, strikePrice: $$(1.0), grantDate: '2024-01-01', vestingStartDate: '2024-01-01',
    vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: '2034-01-01', ptepMonths: 3,
    earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2024-01-01',
    acceptedDate: null, fmvAtGrant: $$(1.0), rsuLiquidityCondition: false, notes: null, ...o,
  };
}

function company() {
  const d = seedCompany();
  d.awards = [];
  d.vestingSchedules.push(fullyVested);
  d.pools[0].authorized = 50_000_000;
  d.shareClasses[0].authorized = 100_000_000;
  d.valuations = [{ id: 'v', type: '409A', fairMarketValue: $$(1.0), effectiveDate: '2023-06-01',
    expirationDate: '2030-01-01', provider: null, reportUrl: null, status: 'ACTIVE' }];
  return d;
}

// ---------------------------------------------------------------------------
// ISO $100,000 first-exercisable limit
// ---------------------------------------------------------------------------

test('ISO $100K: shares first exercisable in a year are valued at grant-date FMV and capped at $100,000', () => {
  const d = company();
  // 1,200,000 ISOs at $1.00 on a 4-year, 1-year-cliff monthly schedule: 25,000 a month.
  d.awards.push(award({ id: 'big', quantity: 1_200_000 }));
  const rows = isoHundredKTest(d, '2024-06-01');
  assert.equal(rows.filter((r) => r.year === 2024).length, 0);           // nothing vests before the cliff
  const y2025 = rows.find((r) => r.year === 2025)!;
  assert.equal(y2025.sharesVesting, 575_000);                             // cliff 300,000 + 11 x 25,000
  assert.equal(y2025.valueAtGrant, $(575_000));
  assert.equal(y2025.isoQualified, 100_000);
  assert.equal(y2025.nsoRecharacterized, 475_000);
  assert.equal(y2025.exceeded, true);
  const y2026 = rows.find((r) => r.year === 2026)!;
  assert.equal(y2026.sharesVesting, 300_000);
  assert.equal(y2026.isoQualified, 100_000);
});

test('ISO $100K: an early-exercisable grant is first exercisable in full in the grant year', () => {
  const d = company();
  d.awards.push(award({ id: 'early', quantity: 1_200_000, earlyExerciseAllowed: true }));
  const rows = isoHundredKTest(d, '2024-06-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].year, 2024);
  assert.equal(rows[0].sharesVesting, 1_200_000);
  assert.equal(rows[0].isoQualified, 100_000);
  assert.equal(rows[0].nsoRecharacterized, 1_100_000);
});

test('ISO $100K: grants in the same year are tested in grant-date order, so the later grant absorbs the excess', () => {
  const d = company();
  d.awards.push(award({ id: 'first', quantity: 60_000, grantDate: '2024-01-10', vestingStartDate: '2024-01-10', vestingScheduleId: 'vs_now' }));
  d.awards.push(award({ id: 'second', quantity: 60_000, grantDate: '2024-06-10', vestingStartDate: '2024-06-10', vestingScheduleId: 'vs_now' }));
  const rows = isoHundredKTest(d, '2024-12-31');
  const first = rows.find((r) => r.awardId === 'first')!;
  const second = rows.find((r) => r.awardId === 'second')!;
  assert.equal(first.isoQualified, 60_000);
  assert.equal(first.exceeded, false);
  assert.equal(second.isoQualified, 40_000);
  assert.equal(second.nsoRecharacterized, 20_000);
  assert.equal(second.exceeded, true);
});

test('ISO $100K: the limit is per employee, so two employees each get their own $100,000', () => {
  const d = company();
  d.awards.push(award({ id: 'a', stakeholderId: 'sh_e', quantity: 90_000, vestingScheduleId: 'vs_now' }));
  d.awards.push(award({ id: 'b', stakeholderId: 'sh_a', quantity: 90_000, vestingScheduleId: 'vs_now' }));
  const rows = isoHundredKTest(d, '2024-12-31');
  assert.ok(rows.every((r) => !r.exceeded && r.nsoRecharacterized === 0));
});

test('ISO $100K: NSOs are not tested', () => {
  const d = company();
  d.awards.push(award({ id: 'nso', type: 'NSO', quantity: 5_000_000, vestingScheduleId: 'vs_now' }));
  assert.equal(isoHundredKTest(d, '2024-12-31').length, 0);
});

// ---------------------------------------------------------------------------
// Rule 701
// ---------------------------------------------------------------------------

test('Rule 701: grants under $1,000,000 of exercise price are exempt on the cash ceiling', () => {
  const d = company();
  d.awards.push(award({ id: 'g', quantity: 1_000_000, strikePrice: $$(0.10), fmvAtGrant: $$(0.10), grantDate: '2024-01-15' }));
  const r = rule701Test(d, '2024-06-01', 0);
  assert.equal(r.aggregateValue, $(100_000));
  assert.equal(r.exceeded, false);
  assert.equal(r.disclosureThresholdMet, false);
});

test('Rule 701: the share-count ceiling saves a grant that fails both dollar ceilings', () => {
  const d = company();                                                      // 8,000,000 common outstanding
  d.awards.push(award({ id: 'g', quantity: 1_000_000, strikePrice: $$(5.0), fmvAtGrant: $$(5.0), grantDate: '2024-01-15' }));
  const r = rule701Test(d, '2024-06-01', 0);
  assert.equal(r.aggregateValue, $(5_000_000));                             // > $1M cash, no assets figure
  assert.equal(r.sharesLimit, 1_200_000);                                   // 15% of 8,000,000
  assert.equal(r.sharesSold, 1_000_000);
  assert.equal(r.exceeded, false);                                          // 1,000,000 <= 1,200,000 shares
});

test('Rule 701: exceeding all three ceilings fails, and $10M triggers enhanced disclosure', () => {
  const d = company();
  d.awards.push(award({ id: 'g', quantity: 15_000_000, strikePrice: $$(1.0), grantDate: '2024-01-15' }));
  const r = rule701Test(d, '2024-06-01', $(10_000_000));                   // 15% of assets = $1.5M
  assert.equal(r.assetsLimit, $(1_500_000));
  assert.equal(r.exceeded, true);
  assert.equal(r.disclosureThresholdMet, true);
  assert.ok(r.headroom < 0);
});

test('Rule 701: total assets widen the ceiling, and grants outside the trailing twelve months do not count', () => {
  const d = company();
  d.awards.push(award({ id: 'old', quantity: 40_000_000, strikePrice: $$(1.0), grantDate: '2022-01-15' }));
  d.awards.push(award({ id: 'new', quantity: 3_000_000, strikePrice: $$(1.0), grantDate: '2024-03-01' }));
  const r = rule701Test(d, '2024-06-01', $(30_000_000));                   // 15% of assets = $4.5M
  assert.equal(r.grants.length, 1);
  assert.equal(r.aggregateValue, $(3_000_000));
  assert.equal(r.exceeded, false);
  assert.equal(r.headroom, $(1_500_000));
});

test('Rule 701: the class is measured at the last fiscal year end, or on the as-of date for a company formed since', () => {
  // 17 CFR 230.701(d)(2)(iii): "measured at the issuer's most recent balance sheet date (if no older than
  // its last fiscal year end)". 8,000,000 common since 2021; another 2,000,000 issued 2024-02-01.
  const d = company();
  d.issuances.push({ ...d.issuances[0], id: 'later', certificateNo: 'CS-3', quantity: 2_000_000, issueDate: '2024-02-01' });
  const at = (fiscalYearEnd?: string) => { const r = rule701Test(d, '2024-06-01', 0, { fiscalYearEnd }); return [r.balanceSheetDate, r.sharesLimit]; };
  assert.deepEqual(at(), ['2023-12-31', 1_200_000]);
  assert.deepEqual(at('03-31'), ['2024-03-31', 1_500_000]);
  d.issuances = d.issuances.filter((i) => i.id === 'later');
  assert.deepEqual(at(), ['2024-06-01', 300_000]);
});

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

function restricted(o: Partial<Issuance>): Issuance {
  return {
    id: 'rs', certificateNo: 'RS-1', stakeholderId: 'sh_e', shareClassId: 'sc_common', quantity: 10_000,
    pricePerShare: $$(0.10), issueDate: '2024-05-01', status: 'OUTSTANDING', vestingScheduleId: 'vs_4yr',
    vestingStartDate: '2024-05-01', earlyExercised: false, election83bFiledOn: null, sourceAwardId: null,
    notes: null, ...o,
  };
}
const rules = (d: ReturnType<typeof company>, asOf: string) => runComplianceChecks(d, { asOf }).map((i) => `${i.severity}:${i.rule}`);

test('83(b): restricted stock has 30 days from issue, then the window is closed for good', () => {
  const d = company();
  d.issuances.push(restricted({ issueDate: '2024-05-01' }));
  const open = runComplianceChecks(d, { asOf: '2024-05-20' }).find((i) => i.rule === '83B_DEADLINE')!;
  assert.equal(open.severity, 'WARNING');
  assert.equal(open.dueDate, '2024-05-31');
  const closed = runComplianceChecks(d, { asOf: '2024-06-15' }).find((i) => i.rule === '83B_DEADLINE')!;
  assert.equal(closed.severity, 'ERROR');
  d.issuances[d.issuances.length - 1].election83bFiledOn = '2024-05-10';
  assert.ok(!rules(d, '2024-06-15').some((r) => r.includes('83B')));
});

test('83(b): unrestricted stock never needs an election', () => {
  const d = company();
  d.issuances.push(restricted({ vestingScheduleId: null, vestingStartDate: null }));
  assert.ok(!rules(d, '2024-05-20').some((r) => r.includes('83B')));
});

test('83(b): stock that is fully vested at grant is not restricted either, however the schedule is attached', () => {
  const d = company();
  d.vestingSchedules.push({ ...d.vestingSchedules[0], id: 'vs-full', name: 'Fully vested at grant', kind: 'FULLY_VESTED', durationMonths: 0, cliffMonths: 0, immediatePortion: 1 });
  d.issuances.push(restricted({ vestingScheduleId: 'vs-full' }));
  assert.ok(!rules(d, '2024-05-20').some((r) => r.includes('83B')));
  // ...while a time-based schedule still counts, even one that already finished vesting.
  d.issuances.push(restricted({ id: 'iss-time', vestingScheduleId: d.vestingSchedules[0].id }));
  assert.ok(rules(d, '2024-05-20').some((r) => r.includes('83B')));
});

test('409A: an expired valuation is an error, a missing one is an error when options exist, a current one is fine', () => {
  const d = company();
  d.awards.push(award({ id: 'g' }));
  // Valued four months earlier, so well inside its twelve months.
  d.valuations[0] = { ...d.valuations[0], effectiveDate: '2024-02-01', expirationDate: null };
  assert.ok(!rules(d, '2024-06-01').some((r) => r.includes('VALUATION_409A')));
  // Past the expiry the report itself states.
  d.valuations[0].expirationDate = '2024-05-01';
  assert.ok(rules(d, '2024-06-01').includes('ERROR:VALUATION_409A'));
  // A report claiming seven years still runs out after twelve months: the rule
  // sets the limit, not the report. The old check trusted the stated date.
  d.valuations[0] = { ...d.valuations[0], effectiveDate: '2023-01-01', expirationDate: '2030-01-01' };
  assert.ok(rules(d, '2024-06-01').includes('ERROR:VALUATION_409A'));
  d.valuations = [];
  assert.ok(rules(d, '2024-06-01').includes('ERROR:VALUATION_409A'));
});

test('409A: a strike below the fair market value on the grant date is flagged', () => {
  const d = company();
  d.awards.push(award({ id: 'cheap', strikePrice: $$(0.50) }));                // FMV is $1.00
  assert.ok(rules(d, '2024-06-01').includes('ERROR:STRIKE_BELOW_FMV'));
  d.awards[0].strikePrice = $$(1.0);
  assert.ok(!rules(d, '2024-06-01').some((r) => r.includes('STRIKE_BELOW_FMV')));
});

test('board approval: missing is a warning, approval after the grant date is an error', () => {
  const d = company();
  d.awards.push(award({ id: 'g', boardApprovalDate: null }));
  assert.ok(rules(d, '2024-06-01').includes('WARNING:BOARD_APPROVAL'));
  d.awards[0].boardApprovalDate = '2024-02-01';
  assert.ok(rules(d, '2024-06-01').includes('ERROR:BOARD_APPROVAL'));
});

test('post-termination exercise window: vested options lapse three months after departure by default', () => {
  const d = company();
  d.stakeholders.find((s) => s.id === 'sh_e')!.terminationDate = '2024-01-15';
  d.awards.push(award({ id: 'g', quantity: 48_000, grantDate: '2022-01-01', vestingStartDate: '2022-01-01' }));
  assert.ok(rules(d, '2024-03-01').includes('WARNING:PTEP_EXPIRING'));         // closes 2024-04-15
  assert.ok(rules(d, '2024-06-01').includes('WARNING:PTEP_EXPIRED'));
});

test('capacity: issuing more than the authorized shares is an error, over-granting the plan is an error', () => {
  const d = company();
  d.shareClasses[0].authorized = 5_000_000;                                    // 8,000,000 issued
  assert.ok(rules(d, '2024-06-01').includes('ERROR:OVER_ISSUANCE'));
  d.pools[0].authorized = 1_000;
  d.awards.push(award({ id: 'g', quantity: 5_000 }));
  assert.ok(rules(d, '2024-06-01').includes('ERROR:POOL_OVERALLOCATED'));
});

test('convertible notes: maturity is warned ahead and errored once passed', () => {
  const d = company();
  d.convertibles.push({
    id: 'n', stakeholderId: 'sh_inv', instrument: 'NOTE', principal: $(500_000), issueDate: '2023-01-01',
    valuationCap: null, discount: 0.2, interestRate: 0.06, compounding: 'SIMPLE', maturityDate: '2024-07-01',
    mfn: false, proRataRight: false, status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  });
  assert.ok(rules(d, '2024-05-01').includes('WARNING:NOTE_MATURING'));
  assert.ok(rules(d, '2024-08-01').includes('ERROR:NOTE_MATURED'));
});

test('the summary orders errors first and keeps the score within 0..100', () => {
  const d = company();
  d.shareClasses[0].authorized = 1;
  d.awards.push(award({ id: 'g', boardApprovalDate: null, strikePrice: $$(0.01) }));
  const s = complianceSummary(d, { asOf: '2024-06-01' });
  assert.ok(s.errors >= 2);
  assert.ok(s.score >= 0 && s.score <= 100);
  const severities = s.issues.map((i) => i.severity);
  assert.equal(severities.indexOf('WARNING') === -1 || severities.indexOf('WARNING') > severities.lastIndexOf('ERROR'), true);
});

// ---------------------------------------------------------------------------
// 83(b) rows, Form 3921 and beneficial ownership
// ---------------------------------------------------------------------------

test('83(b) rows: every restricted certificate with its window, filed ones included', async () => {
  const { election83bRows } = await import('../src/compliance.ts');
  const d = company();
  d.issuances.push(restricted({ id: 'r1', issueDate: '2024-05-01' }));
  d.issuances.push(restricted({ id: 'r2', issueDate: '2024-03-01', election83bFiledOn: '2024-03-20' }));
  d.issuances.push(restricted({ id: 'u1', vestingScheduleId: null, vestingStartDate: null }));      // unrestricted: not listed
  const rows = election83bRows(d, '2024-05-20').filter((r) => ['r1', 'r2'].includes(r.issuanceId));
  // Day 30 for r2 is Sunday 2024-03-31, so the deadline is Monday 2024-04-01 (IRC 7503, TAX-7).
  assert.deepEqual(rows.map((r) => [r.issuanceId, r.status, r.deadline]), [['r2', 'FILED', '2024-04-01'], ['r1', 'OPEN', '2024-05-31']]);
  assert.equal(rows[1].daysLeft, 11);
  assert.equal(election83bRows(d, '2024-07-01').find((r) => r.issuanceId === 'r1')!.status, 'CLOSED');
  assert.ok(!election83bRows(d, '2024-07-01').some((r) => r.issuanceId === 'u1'));
});

test('Form 3921: ISO exercises are collected by year with the form\'s boxes and the statutory deadlines', async () => {
  const { form3921Rows, form3921Status, form3921Deadlines, runComplianceChecks } = await import('../src/compliance.ts');
  const d = company();
  // 1,200 ISOs exercisable at grant, so both exercises below are ISO stock (Box 5 stops at a grant's ISO shares, TAX-6).
  d.awards.push(award({ id: 'iso', type: 'ISO', grantDate: '2023-02-01', strikePrice: 500_000, quantity: 1_200, vestingScheduleId: 'vs_now', vestingStartDate: '2023-02-01' }));
  d.awards.push(award({ id: 'nso', type: 'NSO', grantDate: '2023-02-01', strikePrice: 500_000 }));
  d.exercises = [
    { id: 'x1', awardId: 'iso', stakeholderId: 'sh_e', quantity: 1_000, exerciseDate: '2025-06-15', method: 'CASH', strikePrice: 500_000, fmvAtExercise: 2_000_000, sharesIssued: 1_000, status: 'COMPLETED' },
    { id: 'x2', awardId: 'nso', stakeholderId: 'sh_e', quantity: 500, exerciseDate: '2025-07-01', method: 'CASH', strikePrice: 500_000, fmvAtExercise: 2_000_000, sharesIssued: 500, status: 'COMPLETED' },
    { id: 'x3', awardId: 'iso', stakeholderId: 'sh_e', quantity: 200, exerciseDate: '2024-12-20', method: 'CASH', strikePrice: 500_000, fmvAtExercise: 1_000_000, sharesIssued: 200, status: 'COMPLETED' },
  ];
  const rows = form3921Rows(d, 2025);
  assert.equal(rows.length, 1);                                                          // the NSO exercise is not reportable
  assert.equal(rows[0].grantDate, '2023-02-01');
  assert.equal(rows[0].spread, 1_000 * 150);                                             // ($2.00 − $0.50) × 1,000, in cents
  assert.equal(form3921Deadlines(2027).filePaper, '2028-02-29');                        // a Tuesday, so no roll-forward

  assert.equal(form3921Status(d, '2025-09-01').find((s) => s.year === 2025)!.state, 'UPCOMING');
  assert.equal(form3921Status(d, '2026-02-10').find((s) => s.year === 2025)!.state, 'DUE');
  assert.equal(form3921Status(d, '2026-04-10').find((s) => s.year === 2025)!.state, 'OVERDUE');
  assert.equal(form3921Status(d, '2026-04-10').find((s) => s.year === 2024)!.state, 'OVERDUE');
  const findings = runComplianceChecks(d, { asOf: '2026-04-10' }).filter((i) => i.rule === 'FORM_3921');
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.severity === 'ERROR'));
  const for2025 = runComplianceChecks(d, { asOf: '2026-02-10' }).find((i) => i.rule === 'FORM_3921' && i.title.includes('2025'))!;
  assert.equal(for2025.severity, 'WARNING');
  assert.equal(for2025.dueDate, '2026-03-31');                                          // past the furnish date, before the e-file date
  d.filings = [{ id: 'f1', kind: 'FORM_3921', period: '2025', filedOn: '2026-01-20', reference: null, notes: null }];
  assert.equal(form3921Status(d, '2026-04-10').find((s) => s.year === 2025)!.state, 'FILED');
  assert.equal(runComplianceChecks(d, { asOf: '2026-04-10' }).filter((i) => i.rule === 'FORM_3921').length, 1);   // 2024 still open
});

test('Form 3921: a deadline on a weekend or legal holiday moves to the next business day', async () => {
  // IRS General Instructions for Certain Information Returns (2026), parts C and M: furnish by
  // February 2, 2026 and file "on paper by March 2, 2026, or March 31, 2026, if e-filing"; a due date
  // on a Saturday, Sunday or legal holiday moves to the next business day. https://www.irs.gov/instructions/i1099gi
  // This used to pin the unrolled 2026-01-31 / 2026-02-28, which are Saturdays.
  const { form3921Deadlines } = await import('../src/compliance.ts');
  assert.deepEqual(form3921Deadlines(2025), { furnish: '2026-02-02', filePaper: '2026-03-02', fileElectronic: '2026-03-31' });
  assert.deepEqual(form3921Deadlines(2026), { furnish: '2027-02-01', filePaper: '2027-03-01', fileElectronic: '2027-03-31' });
});

test('beneficial ownership: 25% holders and controlling individuals, entities flagged for look-through, changes since a filing', async () => {
  const { beneficialOwnershipReport, runComplianceChecks } = await import('../src/compliance.ts');
  const d = company();
  const fund = { id: 's-fund', name: 'Kestrel Ventures II, L.P.', email: null, type: 'FUND' as const, relation: 'INVESTOR' as const, startDate: null, terminationDate: null, taxCountry: null, taxState: null, entityGroupId: null };
  const cfo = { id: 's-cfo', name: 'Lena Fischer', email: null, type: 'INDIVIDUAL' as const, relation: 'EMPLOYEE' as const, startDate: null, terminationDate: null, taxCountry: null, taxState: null, entityGroupId: null };
  d.stakeholders.push(fund, cfo);
  const common = d.shareClasses[0].id;
  const total = d.issuances.reduce((n, i) => n + i.quantity, 0);
  d.issuances.push(restricted({ id: 'fund-1', certificateNo: 'F-1', stakeholderId: 's-fund', shareClassId: common, quantity: total, vestingScheduleId: null, vestingStartDate: null, issueDate: '2024-06-01' }));
  d.issuances.push(restricted({ id: 'cfo-1', certificateNo: 'C-1', stakeholderId: 's-cfo', shareClassId: common, quantity: 10, vestingScheduleId: null, vestingStartDate: null, issueDate: '2024-07-01' }));
  const report = beneficialOwnershipReport(d, { asOf: '2024-09-01', titles: { 's-cfo': 'Chief Financial Officer' } });
  assert.ok(report.owners.some((o) => o.stakeholderId === 's-cfo' && o.reasons.includes('control') && !o.reasons.includes('ownership')));
  assert.ok(report.entitiesToLookThrough.some((e) => e.stakeholderId === 's-fund' && e.reasons.includes('ownership')));
  assert.ok(report.owners.every((o) => o.type === 'INDIVIDUAL'));
  assert.equal(report.changedSince('2024-06-15'), true);                                 // the CFO's holding came after
  assert.equal(report.changedSince('2024-12-31'), false);

  assert.equal(runComplianceChecks(d, { asOf: '2024-09-01' }).some((i) => i.rule.startsWith('BOI')), false);                      // not a reporting company
  const required = runComplianceChecks(d, { asOf: '2024-09-01', boiStatus: 'REQUIRED' });
  assert.equal(required.find((i) => i.rule === 'BOI_REPORT')?.severity, 'ERROR');
  d.filings = [{ id: 'b1', kind: 'BOI', period: 'INITIAL', filedOn: '2024-06-15', reference: 'FinCEN-123', notes: null }];
  const filed = runComplianceChecks(d, { asOf: '2024-09-01', boiStatus: 'REQUIRED', titles: { 's-cfo': 'CFO' } });
  assert.equal(filed.some((i) => i.rule === 'BOI_REPORT'), false);
  assert.equal(filed.find((i) => i.rule === 'BOI_UPDATE')?.severity, 'WARNING');            // the CFO joined after the filing
});

// ---------------------------------------------------------------------------
// What is in good order, and how the score is worked out
// ---------------------------------------------------------------------------

test('a clean company scores 100, and every area that applies says what it found in good order', () => {
  const d = company();
  d.valuations[0].effectiveDate = '2024-01-01';   // well inside its twelve months on the day checked
  d.awards.push(award({ id: 'ok', quantity: 1_000 }));
  const s = complianceSummary(d, { asOf: '2024-06-01' });
  assert.equal(s.score, 100);
  assert.equal(s.band, 'In good shape');
  const byId = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  for (const id of ['VALUATION_409A', 'STRIKE_PRICE', 'BOARD_APPROVAL', 'ISO_100K', 'RULE_701', 'AUTHORIZED_SHARES', 'PLAN_RESERVE']) {
    assert.equal(byId[id].status, 'PASS', `${id}: ${byId[id].summary}`);
  }
  assert.equal(byId.BOARD_APPROVAL.summary, 'The one outstanding grant has board approval dated on or before the grant.');
  assert.match(byId.VALUATION_409A.summary, /supports new grants until/);
  // Nothing to look at is not the same as passing.
  assert.equal(byId.NOTE_MATURITY.status, 'NOT_APPLICABLE');
  assert.equal(byId.BOI.status, 'NOT_APPLICABLE');
  assert.ok(s.checks.every((c) => c.summary.length > 0 && c.description.length > 0));
});

test('an area with a finding is marked by the most serious one, and a note for information does not fail it', () => {
  const d = company();
  d.awards.push(award({ id: 'noapproval', boardApprovalDate: null }));
  d.awards.push(award({ id: 'soon', expirationDate: '2024-07-01' }));
  const s = complianceSummary(d, { asOf: '2024-06-01' });
  const byId = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(byId.BOARD_APPROVAL.status, 'REVIEW');
  assert.equal(byId.BOARD_APPROVAL.findings, 1);
  assert.equal(byId.GRANT_EXPIRY.status, 'PASS', 'expiring within 90 days is for information only');

  d.shareClasses[0].authorized = 1;
  const worse = complianceSummary(d, { asOf: '2024-06-01' });
  assert.equal(worse.checks.find((c) => c.id === 'AUTHORIZED_SHARES')!.status, 'FAIL');
});

test('the score is 100 less the published points for each finding, and never below zero', () => {
  const d = company();
  d.awards.push(award({ id: 'a1', boardApprovalDate: null }));
  d.awards.push(award({ id: 'a2', expirationDate: '2024-07-01' }));
  d.shareClasses[0].authorized = 1;
  const s = complianceSummary(d, { asOf: '2024-06-01' });
  const { start, points } = s.scoring;
  assert.equal(s.score, Math.max(0, start - s.errors * points.ERROR - s.warnings * points.WARNING - s.info * points.INFO));
  assert.deepEqual(points, { ERROR: 12, WARNING: 4, INFO: 1 });
  assert.equal(s.band, s.scoring.bands.find((b) => s.score >= b.min)!.label);

  for (let i = 0; i < 12; i++) d.awards.push(award({ id: `x${i}`, boardApprovalDate: '2024-02-01' }));   // approved after grant: must fix
  assert.equal(complianceSummary(d, { asOf: '2024-06-01' }).score, 0);
});
