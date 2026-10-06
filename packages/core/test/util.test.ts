import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, addDays, monthsBetween, daysBetween, yearsBetween, parseDate, fmtDate,
  shareValue, sharesForAmount, ppsForAmount, allocate, dollarsToCents, dollarsToPPS, centsToPPS,
} from '../src/util.ts';

test('adding months clamps to the end of a shorter month, including leap years', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addMonths('2024-03-31', -1), '2024-02-29');
  assert.equal(addMonths('2024-11-30', 3), '2025-02-28');
});

test('adding days crosses month and year boundaries', () => {
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
});

test('whole months elapsed honours anniversaries and month-end anchors', () => {
  assert.equal(monthsBetween('2024-01-15', '2024-02-14'), 0);
  assert.equal(monthsBetween('2024-01-15', '2024-02-15'), 1);
  assert.equal(monthsBetween('2024-01-31', '2024-02-29'), 1);   // Feb 29 is the Jan 31 anniversary
  assert.equal(monthsBetween('2024-01-31', '2024-03-30'), 1);   // one day short of the March anniversary
  assert.equal(monthsBetween('2024-01-31', '2024-03-31'), 2);
  assert.equal(monthsBetween('2021-01-01', '2025-01-01'), 48);
});

test('day counts are exact across a leap year', () => {
  assert.equal(daysBetween('2024-01-01', '2024-12-31'), 365);
  assert.equal(daysBetween('2023-01-01', '2023-12-31'), 364);
  assert.equal(daysBetween('2024-03-01', '2024-02-01'), -29);
  assert.ok(Math.abs(yearsBetween('2023-01-01', '2024-01-01') - 1) < 0.002);
});

test('date parsing and formatting round-trip in UTC', () => {
  for (const d of ['2024-02-29', '1999-12-31', '2030-01-01']) assert.equal(fmtDate(parseDate(d)), d);
});

test('money units: shares x micro-cents gives cents', () => {
  assert.equal(shareValue(1_000, dollarsToPPS(0.10)), dollarsToCents(100));
  assert.equal(shareValue(2_000_000, dollarsToPPS(3.2145)), dollarsToCents(6_429_000));
  assert.equal(shareValue(1, dollarsToPPS(0.0001)), 0);              // rounds to the cent
  assert.equal(centsToPPS(dollarsToCents(1)), dollarsToPPS(1));
});

test('shares for an amount floor to whole shares unless fractional is requested', () => {
  assert.equal(sharesForAmount(dollarsToCents(1_000_000), dollarsToPPS(2.0)), 500_000);
  assert.equal(sharesForAmount(dollarsToCents(100), dollarsToPPS(0.30)), 333);
  assert.ok(Math.abs(sharesForAmount(dollarsToCents(100), dollarsToPPS(0.30), true) - 333.3333) < 1e-3);
  assert.equal(sharesForAmount(dollarsToCents(100), 0), 0);
});

test('price per share inverts shares for an amount', () => {
  assert.equal(ppsForAmount(dollarsToCents(8_000_000), 8_000_000), dollarsToPPS(1));
  assert.equal(ppsForAmount(dollarsToCents(8_000_000), 9_142_857), 875_000); // $0.875
  assert.equal(ppsForAmount(dollarsToCents(100), 0), 0);
});

test('largest-remainder allocation always sums exactly to the total', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(7, [2, 3, 5]), [1, 2, 4]);
  assert.deepEqual(allocate(10, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(0, [3, 4]), [0, 0]);
  for (let total = 1; total < 500; total += 37) {
    const parts = allocate(total, [1.5, 2.25, 7, 0.001, 3]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(parts.every((p) => p >= 0));
  }
});
