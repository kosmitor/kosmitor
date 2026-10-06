import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVestingSchedule, summarizeVesting, vestedQuantity } from '../src/vesting.ts';
import { sched4yr } from './fixtures.ts';

const base = { schedule: sched4yr, totalQuantity: 48_000, vestingStartDate: '2024-01-01' };

test('nothing vests before the cliff', () => {
  assert.equal(vestedQuantity(base, '2024-12-31'), 0);
});

test('the cliff vests 12/48ths on its anniversary', () => {
  assert.equal(vestedQuantity(base, '2025-01-01'), 12_000);
});

test('vesting continues monthly after the cliff', () => {
  assert.equal(vestedQuantity(base, '2025-02-01'), 13_000);
  assert.equal(vestedQuantity(base, '2025-07-01'), 18_000);
});

test('the grant is fully vested at the end and never over-vests', () => {
  assert.equal(vestedQuantity(base, '2028-01-01'), 48_000);
  assert.equal(vestedQuantity(base, '2030-01-01'), 48_000);
});

test('events sum exactly to the grant size with an awkward quantity', () => {
  const events = buildVestingSchedule({ ...base, totalQuantity: 100_001 });
  const sum = events.reduce((s, e) => s + e.quantity, 0);
  assert.equal(sum, 100_001);
  assert.equal(events[events.length - 1].cumulative, 100_001);
});

test('termination halts vesting', () => {
  const v = vestedQuantity({ ...base, terminationDate: '2025-06-15' }, '2027-01-01');
  assert.equal(v, 17_000); // cliff 12k + 5 monthly through 2025-06-01
});

test('single-trigger acceleration vests everything on a change of control', () => {
  const schedule = { ...sched4yr, accelerationSingleTrigger: 1 };
  const v = vestedQuantity({ ...base, schedule, changeOfControlDate: '2025-06-01' }, '2025-06-01');
  assert.equal(v, 48_000);
});

test('double-trigger acceleration needs both a change of control and a termination', () => {
  const schedule = { ...sched4yr, accelerationDoubleTrigger: 1 };
  const withoutTermination = vestedQuantity({ ...base, schedule, changeOfControlDate: '2025-06-01' }, '2025-06-01');
  assert.equal(withoutTermination, 17_000);
  const withTermination = vestedQuantity(
    { ...base, schedule, changeOfControlDate: '2025-06-01', terminationDate: '2025-07-01' }, '2025-08-01');
  assert.equal(withTermination, 48_000);
});

test('back-loaded weighting vests 10/20/30/40 by year', () => {
  const schedule = { ...sched4yr, yearWeights: [0.1, 0.2, 0.3, 0.4] };
  const ctx = { ...base, schedule };
  assert.equal(vestedQuantity(ctx, '2025-01-01'), 4_800);   // 10%
  assert.equal(vestedQuantity(ctx, '2026-01-01'), 14_400);  // 30% cumulative
  assert.equal(vestedQuantity(ctx, '2027-01-01'), 28_800);  // 60% cumulative
  assert.equal(vestedQuantity(ctx, '2028-01-01'), 48_000);  // 100%
});

test('milestone vesting only credits achieved milestones', () => {
  const schedule = {
    ...sched4yr, kind: 'MILESTONE' as const,
    milestones: [
      { id: 'm1', name: 'Launch', portion: 0.5, targetDate: '2024-06-01', achievedDate: '2024-05-01' },
      { id: 'm2', name: 'Revenue', portion: 0.5, targetDate: '2025-06-01', achievedDate: null },
    ],
  };
  assert.equal(vestedQuantity({ ...base, schedule }, '2026-01-01'), 24_000);
});

test('summary reports the next vesting date and cliff state', () => {
  const s = summarizeVesting(base, '2025-03-15');
  assert.equal(s.vested, 14_000);
  assert.equal(s.unvested, 34_000);
  assert.equal(s.nextVestDate, '2025-04-01');
  assert.equal(s.nextVestQuantity, 1_000);
  assert.equal(s.cliffPassed, true);
  assert.equal(s.fullyVestedDate, '2028-01-01');
});

test('month-end anchors do not drift', () => {
  const ctx = { schedule: sched4yr, totalQuantity: 48_000, vestingStartDate: '2024-01-31' };
  const events = buildVestingSchedule(ctx);
  assert.equal(events[0].date, '2025-01-31');
  assert.ok(events.some((e) => e.date === '2025-02-28'));
});

test('months-of-credit acceleration is honoured after a termination', () => {
  const schedule = { ...sched4yr, accelerationDoubleTrigger: 0.5, accelerationMonths: 12 };
  // 24 months vested at the change of control; the termination two weeks later
  // triggers a credit of the next 12 months of the ORIGINAL schedule.
  const ctx = { ...base, schedule, changeOfControlDate: '2026-01-01', terminationDate: '2026-01-15' };
  assert.equal(vestedQuantity(ctx, '2026-01-14'), 24_000);
  assert.equal(vestedQuantity(ctx, '2026-02-01'), 36_000);
  assert.equal(vestedQuantity(ctx, '2030-01-01'), 36_000);      // and nothing more, ever
});

test('a partial single trigger scales the remaining tranches so vesting still ends on the original date', () => {
  const schedule = { ...sched4yr, accelerationSingleTrigger: 0.5 };
  const ctx = { ...base, schedule, changeOfControlDate: '2026-01-01' }; // 24,000 vested, 24,000 unvested
  assert.equal(vestedQuantity(ctx, '2026-01-01'), 36_000);      // half of the unvested vests now
  assert.equal(vestedQuantity(ctx, '2026-02-01'), 36_500);      // the rest at 500 a month instead of 1,000
  assert.equal(vestedQuantity(ctx, '2027-01-01'), 42_000);
  assert.equal(vestedQuantity(ctx, '2028-01-01'), 48_000);
  const s = summarizeVesting(ctx, '2026-06-01');
  assert.equal(s.fullyVestedDate, '2028-01-01');
  assert.equal(s.events.reduce((t, e) => t + e.quantity, 0), 48_000);
});

test('acceleration can never push a grant past its total', () => {
  const schedule = { ...sched4yr, accelerationSingleTrigger: 1, accelerationDoubleTrigger: 1 };
  const ctx = { ...base, schedule, changeOfControlDate: '2025-06-01', terminationDate: '2025-09-01' };
  const s = summarizeVesting(ctx, '2030-01-01');
  assert.equal(s.vested, 48_000);
  assert.equal(s.events.reduce((t, e) => t + e.quantity, 0), 48_000);
});

test('quarterly and annual frequencies vest in whole tranches', () => {
  const quarterly = vestedQuantity({ ...base, schedule: { ...sched4yr, frequency: 'QUARTERLY' } }, '2025-04-01');
  assert.equal(quarterly, 15_000);                               // 5 of 16 quarters
  const annual = vestedQuantity({ ...base, schedule: { ...sched4yr, frequency: 'ANNUAL', cliffMonths: 0 } }, '2026-12-31');
  assert.equal(annual, 24_000);                                  // 2 of 4 years
});

test('an immediate portion vests on the start date ahead of the cliff', () => {
  const schedule = { ...sched4yr, immediatePortion: 0.25 };
  assert.equal(vestedQuantity({ ...base, schedule }, '2024-01-01'), 12_000);
  assert.equal(vestedQuantity({ ...base, schedule }, '2024-12-31'), 12_000);
  assert.equal(vestedQuantity({ ...base, schedule }, '2025-01-01'), 21_000);   // 12,000 + 12/48 of 36,000
  assert.equal(vestedQuantity({ ...base, schedule }, '2028-01-01'), 48_000);
});
