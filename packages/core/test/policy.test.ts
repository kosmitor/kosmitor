/**
 * The engine's policy. The server replaces it with the param file's values, so
 * every figure the engine scores, warns or falls back on must be read from it
 * at the moment of calculating, and resetEngine() must put the built-in values
 * back. Each test changes the policy and the after hook resets it.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureEngine, resetEngine, enginePolicy, DEFAULT_ENGINE_POLICY, type EnginePolicy } from '../src/policy.ts';
import { complianceSummary, runComplianceChecks, COMPLIANCE_SCORING } from '../src/compliance.ts';
import { valuationRefresh, EXPIRY_WARNING_DAYS } from '../src/valuation-refresh.ts';
import { awardIsLive } from '../src/captable.ts';
import { vestedQuantity } from '../src/vesting.ts';
import { modelExercise, DEFAULT_RATES } from '../src/tax.ts';
import { valueAward, stockCompReport, DEFAULT_STOCK_COMP_ASSUMPTIONS } from '../src/accounting.ts';
import { seedCompany, sched4yr, $$ } from './fixtures.ts';
import { yearsBetween } from '../src/util.ts';
import type { Award, CompanyData, VestingSchedule } from '../src/types.ts';

afterEach(() => resetEngine());

/** The built-in policy with some of it changed. */
function policy(change: (p: EnginePolicy) => void): EnginePolicy {
  const p = structuredClone(DEFAULT_ENGINE_POLICY);
  change(p);
  return p;
}

function award(o: Partial<Award>): Award {
  return {
    id: `aw_${Math.random().toString(36).slice(2, 8)}`, label: null, stakeholderId: 'sh_e', poolId: 'pool_1',
    type: 'ISO', quantity: 1_000, strikePrice: $$(1.0), grantDate: '2024-01-01', vestingStartDate: '2024-01-01',
    vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: '2034-01-01', ptepMonths: 3,
    earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2024-01-01',
    acceptedDate: null, fmvAtGrant: $$(1.0), rsuLiquidityCondition: false, notes: null, ...o,
  };
}

/** A company with nothing wrong with it on 2024-06-01. */
function company(): CompanyData {
  const d = seedCompany();
  d.awards = [award({ id: 'ok' })];
  d.pools[0].authorized = 50_000_000;
  d.shareClasses[0].authorized = 100_000_000;
  d.valuations = [{ id: 'v', type: '409A', fairMarketValue: $$(1.0), effectiveDate: '2024-01-01',
    expirationDate: '2030-01-01', provider: null, reportUrl: null, status: 'ACTIVE' }];
  return d;
}

const rules = (d: CompanyData, asOf: string) => runComplianceChecks(d, { asOf }).map((i) => `${i.severity}:${i.rule}`);

test('the built-in policy is the one in force until the engine is configured', () => {
  assert.equal(enginePolicy(), DEFAULT_ENGINE_POLICY);
  assert.deepEqual(COMPLIANCE_SCORING, { start: 100, points: { ERROR: 12, WARNING: 4, INFO: 1 }, bands: DEFAULT_ENGINE_POLICY.compliance.scoring.bands });
  assert.equal(EXPIRY_WARNING_DAYS, 90);
  assert.deepEqual(DEFAULT_RATES, DEFAULT_ENGINE_POLICY.taxRates);
  assert.deepEqual(DEFAULT_STOCK_COMP_ASSUMPTIONS, DEFAULT_ENGINE_POLICY.stockCompAssumptions);
});

test('the compliance score follows the scoring configured, and resetEngine restores the built-in one', () => {
  const d = company();
  d.awards.push(award({ id: 'unapproved', boardApprovalDate: null }));   // one finding to review
  const before = complianceSummary(d, { asOf: '2024-06-01' });
  assert.deepEqual([before.errors, before.warnings, before.info], [0, 1, 0]);
  assert.equal(before.score, 96);
  assert.equal(before.band, 'In good shape');

  configureEngine(policy((p) => {
    p.compliance.scoring = {
      start: 50, points: { error: 20, warning: 15, info: 0 },
      bands: [{ min: 40, label: 'Fine' }, { min: 0, label: 'Needs work' }],
    };
  }));
  const after = complianceSummary(d, { asOf: '2024-06-01' });
  assert.equal(after.score, 35);
  assert.equal(after.band, 'Needs work');
  // The page explains the score from these figures, so they follow the policy too, in the shape it reads.
  assert.deepEqual(after.scoring, {
    start: 50, points: { ERROR: 20, WARNING: 15, INFO: 0 },
    bands: [{ min: 40, label: 'Fine' }, { min: 0, label: 'Needs work' }],
  });
  assert.equal(COMPLIANCE_SCORING.start, 100, 'the exported constant stays the built-in scoring');

  resetEngine();
  const reset = complianceSummary(d, { asOf: '2024-06-01' });
  assert.equal(reset.score, 96);
  assert.deepEqual(reset.scoring, COMPLIANCE_SCORING);
});

test('the exercise-window warning follows the configured days, in the finding and in the text of the check', () => {
  const d = company();
  d.stakeholders.find((s) => s.id === 'sh_e')!.terminationDate = '2024-01-15';
  d.awards = [award({ id: 'g', quantity: 48_000, grantDate: '2022-01-01', vestingStartDate: '2022-01-01', boardApprovalDate: '2022-01-01' })];
  const window = (asOf: string) => complianceSummary(d, { asOf }).checks.find((c) => c.id === 'EXERCISE_WINDOWS')!;

  // The window closes on 2024-04-15: 26 days after 2024-03-20.
  assert.ok(rules(d, '2024-03-20').includes('WARNING:PTEP_EXPIRING'));
  assert.equal(window('2024-03-20').status, 'REVIEW');
  assert.match(window('2023-12-01').summary, /closing within 45 days/);

  configureEngine(policy((p) => { p.compliance.exerciseWindowWarnDays = 14; }));
  assert.equal(rules(d, '2024-03-20').includes('WARNING:PTEP_EXPIRING'), false);
  assert.equal(window('2024-03-20').status, 'PASS');
  assert.equal(window('2024-03-20').summary, 'No exercise window is lapsed or closing within 14 days for the 1 person who left holding options.');
  assert.ok(rules(d, '2024-04-05').includes('WARNING:PTEP_EXPIRING'), 'ten days out is inside fourteen');

  resetEngine();
  assert.ok(rules(d, '2024-03-20').includes('WARNING:PTEP_EXPIRING'));
});

test('the other thresholds are read from the policy as well', () => {
  const d = company();
  // 83(b): an open window becomes an error this close to the deadline.
  d.issuances.push({ ...d.issuances[0], id: 'is_new', certificateNo: 'CS-3', quantity: 1_000, issueDate: '2024-05-20', vestingStartDate: '2024-05-20', election83bFiledOn: null });
  assert.ok(rules(d, '2024-06-01').includes('WARNING:83B_DEADLINE'), '18 days left is a warning');
  // Grant expiry and note maturity notices.
  d.awards.push(award({ id: 'expiring', expirationDate: '2024-08-15' }));
  d.convertibles.push({
    id: 'n', stakeholderId: 'sh_inv', instrument: 'NOTE', principal: 50_000_000, issueDate: '2023-01-01',
    valuationCap: null, discount: 0.2, interestRate: 0.06, compounding: 'SIMPLE', maturityDate: '2024-08-15',
    mfn: false, proRataRight: false, status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  });
  assert.ok(rules(d, '2024-06-01').includes('INFO:GRANT_EXPIRING'));
  assert.ok(rules(d, '2024-06-01').includes('WARNING:NOTE_MATURING'));
  // Authorized common nearly used up: 8,001,000 outstanding and a 1,000,000-share plan reserve
  // of 9,300,000 leave 299,000, or 3.2% (the plan reserve counts against authorized, CAP-8).
  d.pools[0].authorized = 1_000_000;
  d.shareClasses[0].authorized = 9_300_000;
  assert.ok(rules(d, '2024-06-01').includes('WARNING:AUTHORIZED_CAPACITY'));

  configureEngine(policy((p) => {
    p.compliance.election83bUrgentDays = 20;
    p.compliance.grantExpiryNoticeDays = 30;
    p.compliance.noteMaturityWarnDays = 30;
    p.compliance.authorizedSharesWarnRemaining = 0.01;
  }));
  const now = rules(d, '2024-06-01');
  assert.ok(now.includes('ERROR:83B_DEADLINE'));
  assert.equal(now.includes('INFO:GRANT_EXPIRING'), false);
  assert.equal(now.includes('WARNING:NOTE_MATURING'), false);
  assert.equal(now.includes('WARNING:AUTHORIZED_CAPACITY'), false);
  const notes = complianceSummary(d, { asOf: '2024-06-01' }).checks.find((c) => c.id === 'NOTE_MATURITY')!;
  assert.match(notes.description, /matures within 30 days/);
  assert.equal(notes.summary, 'The outstanding note has not matured and does not mature within 30 days.');
});

test('the Rule 701 warning starts at the configured headroom', () => {
  const d = company();
  // $1,000,000 of grants against the 15%-of-outstanding ceiling (1,200,000 shares at $1) leaves under 20% headroom.
  d.awards = [award({ id: 'big', type: 'NSO', quantity: 1_000_000 })];
  assert.ok(rules(d, '2024-06-01').includes('WARNING:RULE_701'));
  configureEngine(policy((p) => { p.compliance.rule701WarnHeadroom = 0.05; }));
  assert.equal(rules(d, '2024-06-01').includes('WARNING:RULE_701'), false);
});

test('the 409A expiry warning reads its days from the policy unless the caller gives them', () => {
  const d: CompanyData = { ...seedCompany(), valuations: [{ id: 'v', type: '409A', fairMarketValue: $$(0.25), effectiveDate: '2025-01-15',
    expirationDate: null, provider: null, reportUrl: null, status: 'ACTIVE' }] };
  assert.deepEqual(valuationRefresh(d, '2025-10-17').triggers.map((t) => t.reason), ['EXPIRING']);

  configureEngine(policy((p) => { p.compliance.valuationExpiryWarningDays = 30; }));
  assert.deepEqual(valuationRefresh(d, '2025-10-17').triggers, []);
  assert.deepEqual(valuationRefresh(d, '2025-12-20').triggers.map((t) => t.reason), ['EXPIRING']);
  assert.deepEqual(valuationRefresh(d, '2025-10-17', 90).triggers.map((t) => t.reason), ['EXPIRING'], 'an explicit figure still wins');
  assert.equal(rules(d, '2025-10-17').some((r) => r.endsWith('VALUATION_409A')), false, 'the compliance check agrees');
});

test('an award with no exercise window recorded gets the configured one, in the checks and in awardIsLive', () => {
  const d = company();
  d.stakeholders.find((s) => s.id === 'sh_e')!.terminationDate = '2024-01-15';
  const unset = award({ id: 'unset', type: 'NSO', ptepMonths: 0, grantDate: '2022-01-01', vestingStartDate: '2022-01-01', boardApprovalDate: '2022-01-01' });
  const explicit = award({ ...unset, id: 'explicit', ptepMonths: 3 });
  // A recorded 0 is a window that closes on the day the holder leaves, in awardIsLive and in the
  // checks alike (PTEP-0); only a window that is missing takes the configured one. This test used to
  // put the recorded 0 through the checks as if it were missing.
  const missing = { ...unset, id: 'missing', ptepMonths: undefined as unknown as number };
  d.awards = [unset];
  assert.equal(runComplianceChecks(d, { asOf: '2024-02-01' }).find((i) => i.rule === 'PTEP_EXPIRED')?.dueDate, '2024-01-15');
  d.awards = [missing];

  // The built-in three months close the window on 2024-04-15.
  assert.ok(rules(d, '2024-06-01').includes('WARNING:PTEP_EXPIRED'));
  assert.match(runComplianceChecks(d, { asOf: '2024-06-01' }).find((i) => i.rule === 'PTEP_EXPIRED')!.detail, /the 3-month window closed on 2024-04-15/);
  assert.equal(awardIsLive(unset, '2024-01-16', '2024-01-15'), false, 'a recorded 0 closes the window at termination');
  assert.equal(awardIsLive(missing, '2024-06-01', '2024-01-15'), false);
  assert.equal(awardIsLive(missing, '2024-04-15', '2024-01-15'), true, 'live on the last day');

  configureEngine(policy((p) => { p.postTerminationExerciseMonths = 6; }));
  assert.ok(rules(d, '2024-06-01').includes('WARNING:PTEP_EXPIRING'), 'closes 2024-07-15');
  assert.equal(awardIsLive(missing, '2024-06-01', '2024-01-15'), true);
  assert.equal(awardIsLive(explicit, '2024-06-01', '2024-01-15'), false, 'a window the grant records is its own');
});

test('double-trigger acceleration fires within the configured window of the change of control', () => {
  const schedule: VestingSchedule = { ...sched4yr, accelerationDoubleTrigger: 1 };
  const ctx = { schedule, totalQuantity: 48_000, vestingStartDate: '2022-01-01', changeOfControlDate: '2024-01-01', terminationDate: '2025-01-01' };
  // A year after the change of control is inside the built-in 548 days: everything vests.
  assert.equal(vestedQuantity(ctx, '2025-06-01'), 48_000);
  configureEngine(policy((p) => { p.doubleTriggerWindowDays = 180; }));
  assert.equal(vestedQuantity(ctx, '2025-06-01'), 36_000, 'outside the window, vesting stops at termination');
});

test('tax estimates fall back on the configured rates, and a caller\'s rates still win', () => {
  const d = seedCompany();
  const nso = award({ id: 'nso', type: 'NSO', quantity: 10_000, grantDate: '2022-01-01' });
  const fmv = $$(3.0);
  assert.equal(modelExercise(d, nso, 10_000, { asOf: '2024-01-01', fmv }).estimatedFederalTax, 740_000);
  configureEngine(policy((p) => { p.taxRates.federalOrdinary = 0.5; }));
  assert.equal(modelExercise(d, nso, 10_000, { asOf: '2024-01-01', fmv }).estimatedFederalTax, 1_000_000);
  assert.equal(modelExercise(d, nso, 10_000, { asOf: '2024-01-01', fmv, rates: { federalOrdinary: 0.1 } }).estimatedFederalTax, 200_000);
});

test('stock compensation falls back on the configured assumptions and option term', () => {
  const d = seedCompany();
  d.awards = [award({ id: 'opt', quantity: 48_000, expirationDate: null })];
  configureEngine(policy((p) => {
    p.stockCompAssumptions = { ...p.stockCompAssumptions, volatility: 0.3 };
    p.optionTermYears = 6;
  }));
  assert.equal(stockCompReport(d, 2024, { asOf: '2024-12-31' }).assumptions.volatility, 0.3);
  const v = valueAward(d, d.awards[0], { ...enginePolicy().stockCompAssumptions })!;
  const first = v.tranches[0];
  const yearsToVest = yearsBetween('2024-01-01', first.vestDate);
  assert.ok(Math.abs(first.expectedTermYears - (yearsToVest + 6) / 2) < 1e-9, 'the simplified term runs to the configured contractual term');
  // The roll-forward assumes the same term for an option with no expiration date.
  const remaining = stockCompReport(d, 2024, { asOf: '2024-12-31' }).rollforward.outstandingEnd.remainingContractualYears;
  assert.ok(Math.abs(remaining - 5) < 0.01, `about five years left of six at the end of the first year, got ${remaining}`);
});
