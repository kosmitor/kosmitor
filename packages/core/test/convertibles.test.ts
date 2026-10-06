import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertOne, accruedInterest, solvePostMoneySafes } from '../src/convertibles.ts';
import type { Convertible } from '../src/types.ts';
import { dollarsToCents as $, dollarsToPPS as $$, ppsToDollars } from '../src/util.ts';

const safe = (o: Partial<Convertible> = {}): Convertible => ({
  id: 'c1', stakeholderId: 'sh_inv', instrument: 'SAFE_POST', principal: $(1_000_000),
  issueDate: '2023-01-01', valuationCap: $(10_000_000), discount: 0, interestRate: 0,
  compounding: 'SIMPLE', maturityDate: null, mfn: false, proRataRight: true,
  status: 'OUTSTANDING', convertedIntoShareClassId: null, convertedOn: null,
  qualifiedFinancingMinimum: null, notes: null, ...o,
});

const ctx = {
  asOf: '2024-01-01', roundPPS: $$(2.0),
  preMoneyCapitalization: 9_000_000, postMoneyCapitalization: 10_000_000,
};

test('a post-money SAFE converts at the cap price', () => {
  const r = convertOne(safe(), ctx);
  assert.equal(ppsToDollars(r.conversionPrice), 1.0); // $10M cap / 10M shares
  assert.equal(r.shares, 1_000_000);
  assert.equal(r.method, 'CAP');
  assert.equal(r.valueMultiple, 2); // round price is 2x the conversion price
});

test('a post-money SAFE owns exactly principal / cap of the company', () => {
  const r = solvePostMoneySafes([safe()], 9_000_000, $$(2.0), '2024-01-01');
  const shares = r.shares.get('c1')!;
  assert.equal(shares, 1_000_000);
  assert.ok(Math.abs(shares / r.totalCapitalization - 0.1) < 1e-9); // 1M / 10M cap = 10%
});

test('two post-money SAFEs each take their full contracted slice', () => {
  const a = safe({ id: 'a', principal: $(1_000_000), valuationCap: $(10_000_000) });
  const b = safe({ id: 'b', principal: $(500_000), valuationCap: $(10_000_000) });
  const r = solvePostMoneySafes([a, b], 8_500_000, $$(2.0), '2024-01-01');
  const total = r.totalCapitalization;
  assert.ok(Math.abs(r.shares.get('a')! / total - 0.10) < 1e-6);
  assert.ok(Math.abs(r.shares.get('b')! / total - 0.05) < 1e-6);
});

test('a pre-money SAFE prices against the pre-money capitalization', () => {
  const r = convertOne(safe({ instrument: 'SAFE_PRE' }), ctx);
  assert.ok(Math.abs(ppsToDollars(r.conversionPrice) - 10 / 9) < 1e-4);
  assert.equal(r.shares, 900_000);
});

test('the discount wins when it beats the cap', () => {
  const r = convertOne(safe({ valuationCap: $(100_000_000), discount: 0.2 }), ctx);
  assert.equal(ppsToDollars(r.conversionPrice), 1.6); // $2.00 x 0.8
  assert.equal(r.method, 'DISCOUNT');
  assert.equal(r.shares, 625_000);
});

test('the lower of cap and discount applies', () => {
  const r = convertOne(safe({ valuationCap: $(10_000_000), discount: 0.2 }), ctx);
  assert.equal(ppsToDollars(r.conversionPrice), 1.0); // cap $1.00 beats discount $1.60
  assert.equal(r.method, 'CAP');
});

test('an uncapped undiscounted SAFE converts at the round price', () => {
  const r = convertOne(safe({ valuationCap: null, discount: 0 }), ctx);
  assert.equal(r.conversionPrice, $$(2.0));
  assert.equal(r.method, 'NO_CAP_NO_DISCOUNT');
  assert.equal(r.shares, 500_000);
});

test('MFN adopts the better terms of a later instrument', () => {
  const early = safe({ id: 'early', valuationCap: null, discount: 0, mfn: true, issueDate: '2023-01-01' });
  const later = safe({ id: 'later', valuationCap: $(6_000_000), discount: 0.25, issueDate: '2023-09-01' });
  const r = convertOne(early, { ...ctx, allConvertibles: [early, later] });
  assert.equal(r.method, 'MFN_CAP');
  // Post-money SAFE, so the adopted $6M cap prices against the 10M post-money base.
  assert.equal(ppsToDollars(r.conversionPrice), 0.6);
});

test('note interest accrues and converts alongside principal', () => {
  const note = safe({
    instrument: 'NOTE', principal: $(1_000_000), interestRate: 0.06,
    compounding: 'SIMPLE', issueDate: '2023-01-01', valuationCap: $(9_000_000),
  });
  const interest = accruedInterest(note, '2024-01-01');
  assert.ok(Math.abs(interest - $(60_000)) < $(200)); // ~6% for one year
  const r = convertOne(note, ctx);
  assert.equal(r.amount, note.principal + interest);
  assert.ok(r.shares > 1_000_000); // $1.00/share cap, plus interest
});

test('compounding interest exceeds simple interest', () => {
  const simple = safe({ instrument: 'NOTE', interestRate: 0.1, compounding: 'SIMPLE' });
  const monthly = safe({ instrument: 'NOTE', interestRate: 0.1, compounding: 'MONTHLY' });
  assert.ok(accruedInterest(monthly, '2026-01-01') > accruedInterest(simple, '2026-01-01'));
});
