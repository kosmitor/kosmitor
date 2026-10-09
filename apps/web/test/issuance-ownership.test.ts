import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownershipForShares, sharesForOwnership } from '../src/issuance-ownership.ts';

test('target includes the new issuance in post-issuance ownership', () => {
  // 1,000,000 added to 9,000,000 existing shares owns 10%, not 11.11%.
  assert.equal(sharesForOwnership(10, 9_000_000), 1_000_000);
  assert.equal(ownershipForShares(1_000_000, 9_000_000), 10);
  assert.equal(sharesForOwnership(25, 9_000_000), 3_000_000);
  assert.equal(ownershipForShares(3_000_000, 9_000_000), 25);
});

test('preferred shares use their common-equivalent conversion ratio', () => {
  assert.equal(sharesForOwnership(10, 9_000_000, 2), 500_000);
  assert.equal(ownershipForShares(500_000, 9_000_000, 2), 10);
  assert.equal(sharesForOwnership(10, 9_000_000, 0.5), 2_000_000);
});

test('target rounds to the nearest whole share and preview reflects that rounding', () => {
  assert.equal(sharesForOwnership(10, 100), 11);
  assert.equal(ownershipForShares(11, 100), 11 / 111 * 100);
  assert.equal(sharesForOwnership(20, 6), 2);
  assert.equal(sharesForOwnership(1, 1), null);
});

test('an empty cap table cannot determine quantity but positive shares would own 100%', () => {
  assert.equal(sharesForOwnership(50, 0), null);
  assert.equal(ownershipForShares(1, 0), 100);
  assert.equal(ownershipForShares(1, 0, 2), 100);
});

test('rejects blank-as-zero, endpoints, invalid percentages and invalid basis', () => {
  for (const percent of [Number(''), 0, -1, 100, 101, NaN, Infinity, -Infinity]) {
    assert.equal(sharesForOwnership(percent, 1_000), null);
  }
  for (const basis of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(sharesForOwnership(10, basis), null);
    assert.equal(ownershipForShares(10, basis), null);
  }
  for (const ratio of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(sharesForOwnership(10, 1_000, ratio), null);
    assert.equal(ownershipForShares(10, 1_000, ratio), null);
  }
  for (const quantity of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(ownershipForShares(quantity, 1_000), null);
  }
});

test('rejects unsafe share counts and common-equivalent totals', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(sharesForOwnership(50, max), null);
  assert.equal(sharesForOwnership(99.99999999999999, 1_000_000), null);
  assert.equal(sharesForOwnership(10, 1_000, Number.MIN_VALUE), null);
  assert.equal(sharesForOwnership(10, max + 1), null);
  assert.equal(ownershipForShares(max + 1, 0), null);
  assert.equal(ownershipForShares(1, max), null);
  assert.equal(ownershipForShares(max, 0, 2), null);
  assert.equal(ownershipForShares(1, max + 1), null);
  assert.equal(ownershipForShares(0.5, 0, Number.MIN_VALUE), null);
  assert.equal(ownershipForShares(max, 0), 100);
});
