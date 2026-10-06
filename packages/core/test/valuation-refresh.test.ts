/**
 * When a new 409A is due. The twelve months and the material events are the two
 * things that end the safe harbor, and the edges of both are pinned here: the
 * last day a valuation still counts, a report claiming a longer life than the
 * rule allows, and the financings that do and do not count as having happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valuationRefresh, safeHarborEnds, describeRefreshTrigger, isTransferIssuance } from '../src/valuation-refresh.ts';
import { seedCompany, seriesA, $, $$ } from './fixtures.ts';
import type { CompanyData, Valuation } from '../src/types.ts';

const appraisal = (overrides: Partial<Valuation> = {}): Valuation => ({
  id: 'v_409a', type: '409A', fairMarketValue: $$(0.25), effectiveDate: '2025-01-15',
  expirationDate: null, provider: 'Appraiser LLP', reportUrl: null, status: 'ACTIVE', ...overrides,
});
const withValuations = (...valuations: Valuation[]): CompanyData => ({ ...seedCompany(), valuations });

test('with no appraisal on file a new 409A is required, and a board estimate does not count as one', () => {
  const none = valuationRefresh(withValuations(), '2025-06-01');
  assert.equal(none.current, null);
  assert.equal(none.due, true);
  assert.deepEqual(none.triggers.map((t) => t.reason), ['NO_VALUATION']);

  const estimateOnly = valuationRefresh(withValuations(appraisal({ type: 'BOARD_ESTIMATE' })), '2025-06-01');
  assert.deepEqual(estimateOnly.triggers.map((t) => t.reason), ['NO_VALUATION']);
});

test('a fresh appraisal with nothing since it asks for nothing', () => {
  const r = valuationRefresh(withValuations(appraisal()), '2025-03-01');
  assert.equal(r.due, false);
  assert.deepEqual(r.triggers, []);
  assert.equal(r.current?.expiresOn, '2026-01-15');
});

test('twelve months is the most a report can claim, and a shorter stated life is respected', () => {
  assert.equal(safeHarborEnds({ effectiveDate: '2025-01-15', expirationDate: '2026-07-15' }), '2026-01-15', 'capped at twelve months');
  assert.equal(safeHarborEnds({ effectiveDate: '2025-01-15', expirationDate: '2025-10-01' }), '2025-10-01', 'a shorter life stands');
  assert.equal(safeHarborEnds({ effectiveDate: '2025-01-15', expirationDate: null }), '2026-01-15');
});

test('it still supports a grant on its last day, and not the day after', () => {
  const data = withValuations(appraisal({ expirationDate: '2026-07-15' }));
  const lastDay = valuationRefresh(data, '2026-01-15');
  assert.equal(lastDay.due, false);
  assert.deepEqual(lastDay.triggers.map((t) => t.reason), ['EXPIRING']);

  const dayAfter = valuationRefresh(data, '2026-01-16');
  assert.equal(dayAfter.due, true);
  assert.deepEqual(dayAfter.triggers.map((t) => [t.reason, t.date]), [['EXPIRED', '2026-01-15']]);
});

test('the warning starts ninety days out and is advice rather than a requirement', () => {
  const data = withValuations(appraisal());
  assert.deepEqual(valuationRefresh(data, '2025-10-17').triggers.map((t) => t.reason), ['EXPIRING'], 'ninety days out is inside');
  assert.deepEqual(valuationRefresh(data, '2025-10-16').triggers, [], 'ninety-one days out says nothing yet');
  assert.equal(valuationRefresh(data, '2025-12-01').due, false);
});

test('a valuation marked expired is expired whatever its dates say', () => {
  const r = valuationRefresh(withValuations(appraisal({ status: 'EXPIRED' })), '2025-03-01');
  assert.equal(r.due, true);
  assert.equal(r.triggers[0].reason, 'EXPIRED');
});

test('the latest appraisal is the one relied on, and one dated in the future is not yet', () => {
  const r = valuationRefresh(withValuations(
    appraisal({ id: 'old', effectiveDate: '2024-01-15' }),
    appraisal({ id: 'new', effectiveDate: '2025-01-15' }),
    appraisal({ id: 'future', effectiveDate: '2025-09-01' }),
  ), '2025-03-01');
  assert.equal(r.current?.id, 'new');
});

test('a priced round after the valuation date requires a new one, counted from its first sale', () => {
  const data = withValuations(appraisal());
  data.shareClasses.push(seriesA());
  const sold = (id: string, issueDate: string, status: any = 'OUTSTANDING') => ({
    id, certificateNo: id, stakeholderId: 'sh_inv', shareClassId: 'sc_a', quantity: 1_000_000,
    pricePerShare: $$(1), issueDate, status, vestingScheduleId: null, vestingStartDate: null,
    earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  data.issuances.push(
    sold('PA-0', '2024-12-01'),                       // before the valuation: already reflected
    sold('PA-2', '2025-05-20'),
    sold('PA-1', '2025-05-01'),                       // the first sale after it
    sold('PA-3', '2025-06-01', 'PENDING_SIGNATURE'),  // not sold yet
  );

  const r = valuationRefresh(data, '2025-07-01');
  assert.equal(r.due, true);
  const round = r.triggers.find((t) => t.reason === 'PRICED_ROUND');
  assert.equal(round?.shareClassName, 'Series A Preferred');
  assert.equal(round?.date, '2025-05-01');

  assert.equal(valuationRefresh(data, '2025-04-30').triggers.find((t) => t.reason === 'PRICED_ROUND'), undefined,
    'a sale after the as-of date has not happened yet');
});

test('convertibles after the valuation are raised for the appraiser, not decided', () => {
  const data = withValuations(appraisal());
  const safe = (id: string, issueDate: string, principal: number, status: any = 'OUTSTANDING') => ({
    id, stakeholderId: 'sh_inv', instrument: 'SAFE_POST' as const, principal, issueDate,
    valuationCap: $(8_000_000), discount: 0, interestRate: 0, compounding: 'SIMPLE' as const,
    maturityDate: null, mfn: false, proRataRight: false, status, convertedIntoShareClassId: null, convertedOn: null,
    qualifiedFinancingMinimum: null, notes: null,
  });
  data.convertibles.push(
    safe('c1', '2025-03-01', $(250_000)),
    safe('c2', '2025-04-01', $(500_000), 'CONVERTED'),
    safe('c3', '2025-04-15', $(100_000), 'CANCELLED'),
    safe('c0', '2024-11-01', $(300_000)),
  ) as any;

  const r = valuationRefresh(data, '2025-06-01');
  assert.equal(r.due, false, 'a convertible alone does not end the safe harbor');
  const t = r.triggers.find((x) => x.reason === 'CONVERTIBLE')!;
  assert.equal(t.severity, 'ADVISED');
  assert.equal(t.count, 2);
  assert.equal(t.principal, $(750_000));
  assert.equal(t.date, '2025-03-01');
});

test('each trigger reads as a sentence, required ones first', () => {
  const data = withValuations(appraisal());
  data.shareClasses.push(seriesA());
  data.issuances.push({
    id: 'PA-1', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a', quantity: 1, pricePerShare: $$(1),
    issueDate: '2025-05-01', status: 'OUTSTANDING', vestingScheduleId: null, vestingStartDate: null,
    earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  const r = valuationRefresh(data, '2025-12-01');
  assert.deepEqual(r.triggers.map((t) => t.reason), ['PRICED_ROUND', 'EXPIRING']);
  const words = r.triggers.map((t) => describeRefreshTrigger(t, (d) => d, (c) => `$${c / 100}`));
  assert.match(words[0], /^Series A Preferred was sold on 2025-05-01, after the valuation date\. A priced round/);
  assert.match(words[1], /runs out after 2026-01-15/);
});

test('a share transfer is not a financing, even though it creates a new preferred certificate', () => {
  const data = withValuations(appraisal());
  data.shareClasses.push(seriesA());
  data.issuances.push({
    id: 'TR-1', certificateNo: 'TR-100200', stakeholderId: 'sh_b', shareClassId: 'sc_a', quantity: 50_000, pricePerShare: $$(1),
    issueDate: '2025-05-01', status: 'OUTSTANDING', vestingScheduleId: null, vestingStartDate: null,
    earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: 'Transferred from certificate PA-0',
  });
  assert.equal(isTransferIssuance(data.issuances.at(-1)!), true);
  const r = valuationRefresh(data, '2025-07-01');
  assert.equal(r.triggers.find((t) => t.reason === 'PRICED_ROUND'), undefined);
  assert.equal(r.due, false);
});

test('a 409A marked expired before its twelve months gives no date, rather than a future one in the past tense', () => {
  const r = valuationRefresh(withValuations(appraisal({ status: 'EXPIRED' })), '2025-03-01');
  assert.deepEqual([r.triggers[0].reason, r.triggers[0].date, r.triggers[0].marked], ['EXPIRED', null, true]);
  const text = describeRefreshTrigger(r.triggers[0], (d) => d, (c) => String(c));
  assert.match(text, /has been marked expired/);
  assert.doesNotMatch(text, /2026/);
});

test('with no options to price, a missing 409A is advice until the first grant', () => {
  const data = { ...withValuations(), awards: [] };
  const r = valuationRefresh(data, '2025-06-01');
  assert.equal(r.due, false);
  assert.equal(r.triggers[0].severity, 'ADVISED');
  assert.match(describeRefreshTrigger(r.triggers[0], (d) => d, (c) => String(c)), /before granting options/);
});

test('the appraiser is told facts, not what the company should do', () => {
  const data = withValuations(appraisal());
  data.convertibles.push({
    id: 'c1', stakeholderId: 'sh_inv', instrument: 'SAFE_POST', principal: $(250_000), issueDate: '2025-03-01',
    valuationCap: $(8_000_000), discount: 0, interestRate: 0, compounding: 'SIMPLE', maturityDate: null, mfn: false,
    proRataRight: false, status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null,
  } as any);
  const r = valuationRefresh(data, '2025-12-01');
  for (const t of r.triggers) {
    const text = describeRefreshTrigger(t, (d) => d, (c) => `$${c / 100}`, 'appraiser');
    assert.doesNotMatch(text, /your appraiser|worth starting|safe harbor|you will need/i, text);
  }
});
