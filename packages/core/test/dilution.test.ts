/**
 * The dilution history is what a stacked chart is drawn from, so the bands have
 * to add up to the fully diluted total at every point. If they drift, the
 * picture lies about who owns what.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dilutionHistory } from '../src/captable.ts';
import { seedCompany, seriesA, $$ } from './fixtures.ts';

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

test('a company with one round has one point, split into its parts', () => {
  const { bands, points } = dilutionHistory(seedCompany());
  assert.equal(points.length, 1);
  assert.equal(points[0].label, 'Common');
  assert.equal(points[0].date, '2021-01-01');
  // Founders hold 8M, the plan reserves 2M, and no options had been granted yet.
  assert.equal(points[0].shares.Common, 8_000_000);
  assert.equal(points[0].shares['Unallocated pool'], 2_000_000);
  assert.equal(points[0].fullyDiluted, 10_000_000);
  assert.deepEqual(bands, ['Common', 'Unallocated pool']);
});

test('a later round adds its own band and dilutes the one below it', () => {
  const data = seedCompany();
  data.shareClasses.push(seriesA());
  data.issuances.push({
    id: 'is_3', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 2_500_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });

  const { bands, points } = dilutionHistory(data);
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((p) => p.label), ['Common', 'Series A Preferred']);
  // Oldest class at the bottom, instruments on top.
  assert.deepEqual(bands, ['Common', 'Series A Preferred', 'Options & RSUs', 'Unallocated pool']);

  const [founding, seriesARound] = points;
  assert.equal(founding.shares['Series A Preferred'], 0, 'a class shows nothing before it exists');
  assert.equal(seriesARound.shares['Series A Preferred'], 2_500_000);

  // The dilution itself: the common band holds its shares while the total grows.
  assert.equal(founding.shares.Common, seriesARound.shares.Common);
  assert.ok(seriesARound.fullyDiluted > founding.fullyDiluted);
});

test('the bands add up to fully diluted at every point', () => {
  const data = seedCompany();
  data.shareClasses.push(seriesA());
  data.issuances.push({
    id: 'is_3', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 2_500_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });
  data.warrants.push({
    id: 'wt_1', stakeholderId: 'sh_inv', shareClassId: 'sc_common', quantity: 100_000,
    strikePrice: $$(1.0), issueDate: '2023-06-01', expirationDate: '2033-06-01',
    status: 'OUTSTANDING', exercisedQuantity: 0, netExercise: false, notes: null,
  });

  const { bands, points } = dilutionHistory(data);
  assert.ok(bands.includes('Warrants'));
  for (const p of points) {
    assert.equal(sum(bands.map((b) => p.shares[b])), p.fullyDiluted, `bands do not add up at ${p.date}`);
  }
});

test('a company with nothing issued has no history to draw', () => {
  const data = seedCompany();
  data.shareClasses = [];
  data.issuances = [];
  const { bands, points } = dilutionHistory(data);
  assert.deepEqual(points, []);
  assert.deepEqual(bands, []);
});

test('the same total splits by who holds it, so founders and employees are told apart', () => {
  const data = seedCompany();
  data.shareClasses.push(seriesA());
  data.issuances.push({
    id: 'is_3', certificateNo: 'PA-1', stakeholderId: 'sh_inv', shareClassId: 'sc_a',
    quantity: 2_500_000, pricePerShare: $$(1.0), issueDate: '2023-06-01', status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: false,
    election83bFiledOn: null, sourceAwardId: null, notes: null,
  });

  const { groups, points } = dilutionHistory(data);
  // Founders and the employee both hold common, which the class view cannot separate.
  assert.deepEqual(groups, ['Founders', 'Employees', 'Investors', 'Unallocated pool']);

  const seed = points[1];
  assert.equal(seed.holders.Founders, 8_000_000, 'the two founders, together');
  assert.equal(seed.holders.Employees, 200_000, 'the option holder, on their own');
  assert.equal(seed.holders.Investors, 2_500_000);
  assert.equal(seed.shares.Common, 8_000_000, 'while the class view sees only common stock');

  for (const p of points) {
    assert.equal(sum(groups.map((g) => p.holders[g])), p.fullyDiluted, `holders do not add up at ${p.date}`);
  }
});
