/**
 * Vesting schedules as OCF vesting terms and back (src/ocf/vesting.ts).
 *
 * Pinned here: every built-in schedule, and custom, milestone, weekly and back-loaded
 * ones, become terms of the expected shape, flagged exact or not; for the exact ones,
 * an OCF reader's evaluation of the terms vests what Kosmitor vests, share for share,
 * whatever the grant size and start date (the 31st, Feb 29); a 4-year, 1-year-cliff
 * graph typed by hand from the OCF explainer reads as the standard schedule; the note
 * gives the schedule back only while its digest matches; graphs with branches are
 * refused. Every term written validates against the vendored OCF schemas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_SCHEDULES, type VestingSchedule } from '@kosmitor/core';
import { validateOcf } from './ocf-validate.ts';

const V = await import('../src/ocf/vesting.ts');
const { readNote } = await import('../src/ocf/notes.ts');

const base: Omit<VestingSchedule, 'id' | 'name' | 'kind'> = {
  durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null, customTranches: null,
  accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null,
};
const schedule = (name: string, s: Partial<VestingSchedule>): VestingSchedule => ({ id: `vs_${name.replace(/\W+/g, '_')}`, name, kind: 'TIME', ...base, ...s });
const standard = STANDARD_SCHEDULES.map((s, i) => ({ id: `vs_std_${i}`, ...s }));
const custom = schedule('Thirds on set dates', { kind: 'CUSTOM', customTranches: [{ date: '2026-01-01', portion: 1 / 3 }, { date: '2025-01-01', portion: 1 / 3 }, { date: '2027-01-01', portion: 1 / 3 }] });
const customQuantities = schedule('Fixed tranches', { kind: 'CUSTOM', customTranches: [{ date: '2025-03-01', quantity: 250 }, { date: '2025-09-01', portion: 0.5 }] });
const quarterlyAnnual = [
  schedule('3 years quarterly, 6-month cliff', { durationMonths: 36, cliffMonths: 6, frequency: 'QUARTERLY' }),
  schedule('4 years annually', { durationMonths: 48, cliffMonths: 12, frequency: 'ANNUAL' }),
  schedule('Cliff only', { durationMonths: 12, cliffMonths: 12 }),
];
const milestone = schedule('Product milestones', {
  kind: 'MILESTONE', milestones: [
    { id: 'beta', name: 'Beta ships', portion: 0.25, targetDate: '2025-06-01', achievedDate: '2025-07-15' },
    { id: 'ga', name: 'General availability', portion: 0.5, targetDate: '2025-12-01', achievedDate: null },
    { id: 'pilot', name: 'First pilot', portion: 0.25, targetDate: '2025-03-01', achievedDate: '2025-02-20' },
  ],
});
const weekly = schedule('2 years weekly', { durationMonths: 24, cliffMonths: 6, frequency: 'WEEKLY' });
const upfront = schedule('25% upfront, then 3 years monthly', { durationMonths: 36, immediatePortion: 0.25 });
const backLoaded = standard.find((s) => s.yearWeights)!;
const exactOnes = [...standard.filter((s) => !s.yearWeights), custom, customQuantities, ...quarterlyAnnual];
const STARTS = ['2024-01-31', '2024-02-29', '2023-03-15', '2022-08-31', '2021-12-01', '2023-05-30'];
const QUANTITIES = [1, 7, 18, 48, 1000, 4_500_000, 123_457, 999_999, 100.5];

test('every exact schedule vests, read from its terms the OCF way, exactly what Kosmitor vests: every size, every start', () => {
  for (const s of exactOnes) {
    const { terms, exact } = V.termsFromSchedule(s);
    assert.equal(exact, true, s.name);
    for (const start of STARTS) for (const quantity of QUANTITIES) {
      if (s.customTranches?.some((t) => (t.quantity ?? 0) > quantity)) continue; // more than the grant: Kosmitor refuses it too
      const own = V.scheduleTranches(s, quantity, start);
      const ocf = V.evaluateTerms(terms, { quantity, startDate: start });
      assert.ok(V.sameTranches(own, ocf), `${s.name}, ${quantity} from ${start}: ${JSON.stringify(own.slice(0, 3))} against ${JSON.stringify(ocf.slice(0, 3))}`);
      assert.equal(V.vestingsFor(s, terms, quantity, start), undefined, 'the terms are enough: no vestings');
    }
  }
});

test('the standard 4-year, 1-year-cliff schedule is the OCF explainer\'s graph: 12/48 at a year, then 1/48 monthly 36 times', () => {
  const { terms } = V.termsFromSchedule(standard[0]);
  assert.equal(terms.allocation_type, 'CUMULATIVE_ROUND_DOWN');
  assert.equal(terms.description, '48 months, 12-month cliff, then monthly');
  const [start, cliff, monthly] = terms.vesting_conditions;
  assert.deepEqual(start, { id: 'start', description: 'Vesting start', quantity: '0', trigger: { type: 'VESTING_START_DATE' }, next_condition_ids: ['cliff'] });
  assert.deepEqual(cliff.portion, { numerator: '12', denominator: '48' });
  assert.deepEqual(cliff.trigger, { type: 'VESTING_SCHEDULE_RELATIVE', period: { type: 'MONTHS', length: 12, occurrences: 1, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' }, relative_to_condition_id: 'start' });
  assert.deepEqual(cliff.next_condition_ids, ['periodic']);
  assert.deepEqual(monthly.portion, { numerator: '1', denominator: '48' });
  assert.deepEqual(monthly.trigger, { type: 'VESTING_SCHEDULE_RELATIVE', period: { type: 'MONTHS', length: 1, occurrences: 36, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' }, relative_to_condition_id: 'cliff' });
  assert.deepEqual(monthly.next_condition_ids, []);
  // 18 shares over four tranches round down cumulatively (OCF AllocationType): 4-5-4-5.
  const yearly = V.termsFromSchedule(quarterlyAnnual[1]).terms;
  assert.deepEqual(V.evaluateTerms(yearly, { quantity: 18, startDate: '2024-01-01' }).map((t) => t.quantity), [4, 5, 4, 5]);
  // A start on January 30: the cliff on January 30, then February's last day, then the 30th again (OCF explainer, example 3).
  const dates = V.evaluateTerms(terms, { quantity: 480, startDate: '2021-01-30' }).map((t) => t.date);
  assert.deepEqual(dates.slice(0, 3), ['2022-01-30', '2022-02-28', '2022-03-30']);
  assert.equal(dates.at(-1), '2025-01-30');
});

test('schedules OCF cannot state exactly are flagged, keep the same shape in decimals, and give each security its vestings', () => {
  const events = new Map([['milestone-pilot', '2025-02-20'], ['milestone-beta', '2025-07-15']]);
  for (const s of [backLoaded, weekly, upfront, milestone]) {
    const { terms, exact } = V.termsFromSchedule(s);
    assert.equal(exact, false, s.name);
    for (const quantity of [4800, 4801, 123_457]) {
      const vestings = V.vestingsFor(s, terms, quantity, '2024-01-15', s.kind === 'MILESTONE' ? events : new Map());
      const own = V.scheduleTranches(s, quantity, '2024-01-15');
      // Kosmitor's own dates and amounts, unless the terms happen to say the same for this security.
      if (vestings) assert.deepEqual(vestings.map((v) => [v.date, Number(v.amount)]), own.map((t) => [t.date, t.quantity]), s.name);
      else assert.ok(V.sameTranches(own, V.evaluateTerms(terms, { quantity, startDate: '2024-01-15', events })), s.name);
    }
  }
  // A quarter of 4,801 rounds down differently in Kosmitor's milestone order and on OCF's achieved-first path.
  for (const s of [backLoaded, weekly, milestone]) assert.ok(V.vestingsFor(s, V.termsFromSchedule(s).terms, 4801, '2024-01-15', s.kind === 'MILESTONE' ? events : new Map()), s.name);
  const w = V.termsFromSchedule(weekly).terms;
  assert.equal(w.vesting_conditions[2].trigger.type, 'VESTING_SCHEDULE_RELATIVE');
  assert.deepEqual((w.vesting_conditions[2].trigger as { period: unknown }).period, { type: 'DAYS', length: 7, occurrences: 79 });
  assert.equal(V.termsFromSchedule(upfront).terms.vesting_conditions[0].portion?.numerator, '1');
  assert.equal(V.termsFromSchedule(upfront).terms.vesting_conditions[0].portion?.denominator, '4');
  assert.equal(V.termsFromSchedule(backLoaded).terms.description, '48 months, 12-month cliff, then monthly, weighted 10% / 20% / 30% / 40% by year');
});

test('milestones are events, achieved ones first by date; each security\'s vesting events date them', () => {
  const { terms } = V.termsFromSchedule(milestone);
  assert.deepEqual(terms.vesting_conditions.map((c) => c.id), ['start', 'milestone-pilot', 'milestone-beta', 'milestone-ga']);
  assert.ok(terms.vesting_conditions.slice(1).every((c) => c.trigger.type === 'VESTING_EVENT'));
  assert.equal(terms.description, 'Milestones: Beta ships (25%), General availability (50%), First pilot (25%)');
  const tranches = V.evaluateTerms(terms, { quantity: 1000, startDate: '2024-01-01', events: new Map([['milestone-pilot', '2025-02-20'], ['milestone-beta', '2025-07-15']]) });
  assert.deepEqual(tranches, [{ date: '2025-02-20', quantity: 250 }, { date: '2025-07-15', quantity: 250 }], 'an event that never happened never vests');
  assert.deepEqual(V.evaluateTerms(terms, { quantity: 1000, startDate: '2024-01-01', events: new Map([['milestone-beta', '2025-07-15']]) }), [], 'nor does anything after it');
});

test('a 4-year, 1-year-cliff graph typed by hand reads as the standard schedule; other shapes are recognised too', () => {
  // The OCF explainer's example 3, re-typed: ids and descriptions of our own, no Kosmitor note.
  const handTyped = {
    id: 'four-year-one-cliff', object_type: 'VESTING_TERMS' as const, name: 'Four years with a one year cliff', description: 'Monthly after a one year cliff',
    allocation_type: 'CUMULATIVE_ROUND_DOWN' as const,
    vesting_conditions: [
      { id: 'begin', trigger: { type: 'VESTING_START_DATE' as const }, quantity: '0', next_condition_ids: ['one-year'] },
      { id: 'one-year', portion: { numerator: '1', denominator: '4' }, trigger: { type: 'VESTING_SCHEDULE_RELATIVE' as const, relative_to_condition_id: 'begin',
        period: { type: 'MONTHS' as const, length: 12, occurrences: 1, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' as const } }, next_condition_ids: ['monthly'] },
      { id: 'monthly', portion: { numerator: '1', denominator: '48' }, trigger: { type: 'VESTING_SCHEDULE_RELATIVE' as const, relative_to_condition_id: 'one-year',
        period: { type: 'MONTHS' as const, length: 1, occurrences: 36, day_of_month: 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' as const } }, next_condition_ids: [] },
    ],
  };
  const read = V.scheduleFromTerms(handTyped);
  assert.equal(read.kind, 'schedule');
  if (read.kind !== 'schedule') return;
  assert.equal(read.how, 'recognised');
  const { name: _n, id: _i, ...std } = standard[0];
  assert.deepEqual(read.schedule, { ...std, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0 });
  for (const start of STARTS) {
    assert.ok(V.sameTranches(V.evaluateTerms(handTyped, { quantity: 4_000_000, startDate: start }), V.scheduleTranches(standard[0], 4_000_000, start)));
  }
  // Written by us and stripped of the note, every exact shape is recognised as what it was.
  for (const s of exactOnes) {
    const { terms } = V.termsFromSchedule(s);
    const plain = V.scheduleFromTerms({ ...terms, comments: undefined });
    assert.equal(plain.kind, 'schedule', s.name);
    if (plain.kind !== 'schedule') continue;
    const back = { ...plain.schedule, id: s.id, name: s.name };
    for (const start of STARTS.slice(0, 3)) assert.ok(V.sameTranches(V.scheduleTranches(back, 1000, start), V.scheduleTranches(s, 1000, start)), s.name);
  }
  const ms = V.scheduleFromTerms({ ...V.termsFromSchedule(milestone).terms, comments: undefined });
  assert.equal(ms.kind === 'schedule' && ms.schedule.kind, 'MILESTONE');
  assert.deepEqual(ms.kind === 'schedule' && ms.schedule.milestones!.map((m) => [m.id, m.name, m.portion, m.achievedDate]),
    [['pilot', 'First pilot', 0.25, null], ['beta', 'Beta ships', 0.25, null], ['ga', 'General availability', 0.5, null]]);
});

test('the note gives the schedule back exactly while its digest matches the conditions, and only then', () => {
  for (const s of [...standard, custom, milestone, weekly, upfront]) {
    const { terms } = V.termsFromSchedule(s);
    const read = V.scheduleFromTerms(terms);
    assert.equal(read.kind === 'schedule' && read.how, 'note', s.name);
    const { id: _i, name: _n, ...rest } = s;
    assert.deepEqual(read.kind === 'schedule' && read.schedule, { ...rest, milestones: rest.milestones?.map((m) => ({ ...m, achievedDate: null })) ?? null }, s.name);
  }
  // Another tool changed the cliff to a sixth: the note no longer describes the terms.
  const { terms } = V.termsFromSchedule(backLoaded);
  const edited = structuredClone(terms);
  edited.vesting_conditions[1].portion = { numerator: '1', denominator: '6' };
  assert.ok(readNote(edited, 'VESTING_TERMS').schedule, 'the note is still there');
  assert.equal(V.scheduleFromTerms(edited).kind, 'per-security', 'but it is not used');
});

test('linear graphs Kosmitor has no schedule for are read per security; graphs with branches are refused', () => {
  const relative = (to: string, type: 'MONTHS' | 'DAYS', length: number, occurrences: number, day = 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH') => ({
    type: 'VESTING_SCHEDULE_RELATIVE' as const, relative_to_condition_id: to,
    period: type === 'MONTHS' ? { type, length, occurrences, day_of_month: day as 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH' } : { type, length, occurrences },
  });
  const terms = {
    id: 't', object_type: 'VESTING_TERMS' as const, name: 'Odd', description: 'Odd', allocation_type: 'CUMULATIVE_ROUND_DOWN' as const,
    vesting_conditions: [
      { id: 's', trigger: { type: 'VESTING_START_DATE' as const }, quantity: '100', next_condition_ids: ['d'] },
      { id: 'd', portion: { numerator: '1', denominator: '2', remainder: true }, trigger: relative('s', 'DAYS', 90, 2), next_condition_ids: ['m'] },
      { id: 'm', quantity: '10', trigger: relative('d', 'MONTHS', 1, 1, '15'), next_condition_ids: [] },
    ],
  };
  assert.deepEqual(V.scheduleFromTerms(terms), { kind: 'per-security' });
  // 100 at the start; half of the 900 left after 90 days, half of the 450 left after 180; then 10 on the 15th of the next month.
  assert.deepEqual(V.evaluateTerms(terms, { quantity: 1000, startDate: '2024-01-31' }),
    [{ date: '2024-01-31', quantity: 100 }, { date: '2024-04-30', quantity: 450 }, { date: '2024-07-29', quantity: 225 }, { date: '2024-08-15', quantity: 10 }]);
  // A security's own schedule says what part of it vests on each date, so a split or a transfer of some of it keeps it right.
  const perSecurity = V.customSchedule(V.evaluateTerms(terms, { quantity: 1000, startDate: '2024-01-31' }), 1000);
  assert.deepEqual(perSecurity.customTranches, [{ date: '2024-01-31', portion: 0.1 }, { date: '2024-04-30', portion: 0.45 }, { date: '2024-07-29', portion: 0.225 }, { date: '2024-08-15', portion: 0.01 }]);
  assert.deepEqual(V.scheduleTranches({ ...perSecurity, id: 'x', name: 'x' } as never, 1000, '2024-01-31'), V.evaluateTerms(terms, { quantity: 1000, startDate: '2024-01-31' }));

  const branching = { ...terms, vesting_conditions: [{ ...terms.vesting_conditions[0], next_condition_ids: ['d', 'm'] }, ...terms.vesting_conditions.slice(1)] };
  assert.equal(V.scheduleFromTerms(branching).kind, 'unsupported');
  assert.throws(() => V.evaluateTerms(branching, { quantity: 10, startDate: '2024-01-01' }), (e: Error & { code?: string }) => e.code === 'ocf-unsupported');
  const loop = { ...terms, vesting_conditions: [terms.vesting_conditions[0], terms.vesting_conditions[1], { ...terms.vesting_conditions[2], next_condition_ids: ['d'] }] };
  assert.equal(V.scheduleFromTerms(loop).kind, 'unsupported');
  const dangling = { ...terms, vesting_conditions: [{ ...terms.vesting_conditions[0], next_condition_ids: ['nowhere'] }] };
  assert.equal(V.scheduleFromTerms(dangling).kind, 'unsupported');
});

test('every term written validates against the OCF 1.2.0 schemas', () => {
  const items = [...standard, custom, customQuantities, ...quarterlyAnnual, milestone, weekly, upfront].map((s) => V.termsFromSchedule(s).terms);
  assert.deepEqual(validateOcf([{ path: 'VestingTerms.ocf.json', json: { file_type: 'OCF_VESTING_TERMS_FILE', items } }]), []);
});
