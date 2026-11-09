import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDocument } from '../src/classify.ts';

const text = (s: string) => Buffer.from(s);
const run = (name: string, body = '') => classifyDocument(name, 'text/plain', text(body));

test('files by what the paper says', () => {
  assert.deepEqual(run('Series A Term Sheet.txt', 'Pre-money valuation, liquidation preference').folder, 'Financing/Series A');
  assert.equal(run('notes.txt', 'Notice of Stock Option Grant. Exercise price $1. Vesting schedule: 4 years.').category, 'GRANT');
  assert.equal(run('report.txt', 'This 409A valuation report states the fair market value of common stock').category, 'VALUATION');
  assert.equal(run('w9.txt').category, 'TAX');
  assert.equal(run('minutes.txt', 'Minutes of the meeting. Unanimous written consent of the board.').folder, 'Board');
});

test('a SAFE that says "this agreement" is still financing', () => {
  const r = run('post-money-safe.txt', 'This agreement is a Simple Agreement for Future Equity (SAFE). Post-money valuation cap.');
  assert.equal(r.category, 'FINANCING');
});

test('leaves what it cannot tell in Other / General', () => {
  const r = run('IMG_2041.txt', 'lunch on friday?');
  assert.deepEqual([r.category, r.folder, r.confident], ['OTHER', 'General', false]);
});
