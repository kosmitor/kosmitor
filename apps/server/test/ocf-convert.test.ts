/**
 * OCF conversions (src/ocf/convert.ts) and the Kosmitor note (src/ocf/notes.ts).
 *
 * Pinned here: numbers, money and prices are written as OCF's decimal strings from
 * Kosmitor's integers and read back by string arithmetic, never through a float, with
 * rounding flagged and amounts in another currency refused; ratios and portions come
 * out as the simplest fractions; dates are real calendar days; the note carries only
 * the keys allowed for its kind, checked, and nothing malformed gets through; the enum
 * maps go both ways. Every value is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../src/ocf/convert.ts');
const { writeNote, readNote, commentsWith, plainComments, termsDigest, NOTE_PREFIX } = await import('../src/ocf/notes.ts');

test('a number is an OCF Numeric: integers as they are, others to ten decimals, never in exponent notation', () => {
  const cases: [number, string][] = [
    [0, '0'], [5, '5'], [-3, '-3'], [4_500_000, '4500000'], [0.1 + 0.2, '0.3'], [1 / 3, '0.3333333333'], [2.5, '2.5'],
    [1e-12, '0'], [-1e-12, '0'], [1e21, '1000000000000000000000'], [123456.000001, '123456.000001'],
  ];
  for (const [n, s] of cases) {
    assert.equal(C.ocfNumeric(n), s, String(n));
    assert.match(C.ocfNumeric(n), C.NUMERIC);
  }
  assert.throws(() => C.ocfNumeric(Number.NaN));
  assert.throws(() => C.ocfNumeric(Infinity));
});

test('cents are written with two decimals and micro-cents with two to six, from the integers', () => {
  assert.equal(C.centsToAmount(125_000_000), '1250000.00');
  assert.equal(C.centsToAmount(5), '0.05');
  assert.equal(C.centsToAmount(-150), '-1.50');
  assert.equal(C.centsToAmount(0), '0.00');
  assert.equal(C.centsToAmount(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(C.microsToAmount(1_000_000), '1.00');
  assert.equal(C.microsToAmount(1_500_000), '1.50');
  assert.equal(C.microsToAmount(1_234_567), '1.234567');
  assert.equal(C.microsToAmount(100), '0.0001');
  assert.equal(C.microsToAmount(1), '0.000001');
  assert.equal(C.microsToAmount(0), '0.00');
  assert.equal(C.microsToAmount(-250_000), '-0.25');
  // A split-adjusted price can hold a fraction of a micro-cent (splits.ts): $1.37 / 3.
  assert.equal(C.microsToAmount(1_370_000 / 3), '0.4566666667');
  assert.equal(C.microsToAmount(0.5), '0.0000005');
  for (const m of [1, 100, 1_000_000, 1_370_000 / 3, 0.5]) assert.match(C.microsToAmount(m), C.NUMERIC);
  assert.deepEqual(C.ocfMoney(25_000_00, 'USD'), { amount: '25000.00', currency: 'USD' });
  assert.deepEqual(C.ocfPrice(420_000, 'EUR'), { amount: '0.42', currency: 'EUR' });
});

test('amounts are read back to cents and micro-cents by string arithmetic, rounded half away from zero, with the rounding flagged', () => {
  const cents = (amount: string) => C.readMoney({ amount, currency: 'USD' }, 'investment_amount', 'USD', 'cents');
  const micros = (amount: string) => C.readMoney({ amount, currency: 'USD' }, 'share_price', 'USD', 'micros');
  assert.deepEqual(cents('1250000.00'), { ok: true, value: 125_000_000, rounded: false });
  assert.deepEqual(cents('1250000'), { ok: true, value: 125_000_000, rounded: false });
  assert.deepEqual(cents('0.005'), { ok: true, value: 1, rounded: true });
  assert.deepEqual(cents('0.0049'), { ok: true, value: 0, rounded: true });
  assert.deepEqual(cents('-0.005'), { ok: true, value: -1, rounded: true });
  assert.deepEqual(cents('1.999'), { ok: true, value: 200, rounded: true });
  assert.deepEqual(cents('+7.10'), { ok: true, value: 710, rounded: false });
  assert.deepEqual(cents('90071992547409.91'), { ok: true, value: Number.MAX_SAFE_INTEGER, rounded: false });
  assert.equal(cents('90071992547409.92').ok, false, 'past the largest safe integer');
  assert.deepEqual(micros('0.0001'), { ok: true, value: 100, rounded: false });
  assert.deepEqual(micros('0.000001'), { ok: true, value: 1, rounded: false });
  assert.deepEqual(micros('0.0000005'), { ok: true, value: 1, rounded: true });
  assert.deepEqual(micros('0.4566666667'), { ok: true, value: 456_667, rounded: true });
  // Written and read back: the integers survive.
  for (const c of [0, 1, 99, 125_000_000, Number.MAX_SAFE_INTEGER, -4_200]) assert.equal((cents(C.centsToAmount(c)) as { value: number }).value, c);
  for (const m of [0, 1, 100, 1_000_000, 123_456_789]) assert.equal((micros(C.microsToAmount(m)) as { value: number }).value, m);
});

test('an amount in another currency is refused, not converted; a malformed one names its field', () => {
  const eur = C.readMoney({ amount: '100.00', currency: 'EUR' }, 'exercise_price', 'USD', 'micros');
  assert.equal(eur.ok, false);
  if (!eur.ok) {
    assert.equal(eur.issue.code, 'ocf-currency');
    assert.equal(eur.issue.text, 'Amount in EUR; this company keeps its cap table in USD.');
    assert.equal(eur.issue.field, 'exercise_price.currency');
  }
  for (const [m, field] of [
    [{ amount: '1e5', currency: 'USD' }, 'p.amount'], [{ amount: 100, currency: 'USD' }, 'p.amount'], [{ amount: '1.12345678901', currency: 'USD' }, 'p.amount'],
    [{ amount: '1.00', currency: 'usd' }, 'p.currency'], ['1.00', 'p'], [null, 'p'],
  ] as [unknown, string][]) {
    const r = C.readMoney(m, 'p', 'USD', 'cents');
    assert.equal(r.ok, false, JSON.stringify(m));
    if (!r.ok) assert.deepEqual([r.issue.code, r.issue.field], ['ocf-bad-object', field]);
  }
});

test('shares, ratios, percentages and dates are read with their checks', () => {
  assert.deepEqual(C.readShares('4500000', 'quantity'), { ok: true, value: 4_500_000, rounded: false });
  assert.deepEqual(C.readShares('100.5', 'quantity'), { ok: true, value: 100.5, rounded: false });
  assert.equal(C.readShares('2000000000000', 'quantity').ok, false, 'more than 1e12');
  assert.equal(C.readShares('ten', 'quantity').ok, false);
  assert.deepEqual(C.readRatio({ numerator: '2', denominator: '1' }, 'split_ratio'), { ok: true, value: 2, rounded: false });
  assert.deepEqual(C.readRatio({ numerator: '1', denominator: '3' }, 'split_ratio'), { ok: true, value: 1 / 3, rounded: false });
  assert.equal(C.readRatio({ numerator: '1', denominator: '0' }, 'split_ratio').ok, false);
  assert.deepEqual(C.readPercentage('0.2', 'conversion_discount'), { ok: true, value: 0.2, rounded: false });
  assert.deepEqual(C.readPercentage('.08', 'rate'), { ok: true, value: 0.08, rounded: false });
  assert.deepEqual(C.readPercentage('1', 'rate'), { ok: true, value: 1, rounded: false });
  assert.equal(C.readPercentage('1.5', 'rate').ok, false);
  assert.equal(C.readPercentage('20%', 'rate').ok, false);
  assert.deepEqual(C.readDate('2024-02-29', 'date'), { ok: true, value: '2024-02-29', rounded: false });
  for (const d of ['2023-02-29', '2024-13-01', '2024-04-31', '2024-1-01', '01/02/2024', 20240101]) {
    const r = C.readDate(d, 'date');
    assert.equal(r.ok, false, String(d));
    if (!r.ok) assert.equal(r.issue.code, 'bad-date');
  }
});

test('ratios and portions are the simplest fractions; percentages stay within 0 and 1', () => {
  assert.deepEqual(C.ocfRatio(2), { numerator: '2', denominator: '1' });
  assert.deepEqual(C.ocfRatio(0.5), { numerator: '1', denominator: '2' });
  assert.deepEqual(C.ocfRatio(1 / 3), { numerator: '1', denominator: '3' });
  assert.deepEqual(C.ocfRatio(1.5), { numerator: '3', denominator: '2' });
  assert.deepEqual(C.ocfRatio(Math.PI), { numerator: '3.1415926536', denominator: '1' });
  assert.deepEqual(C.fractionOf(12 / 48), { n: 1, d: 4 });
  assert.equal(C.ocfPercentage(0.2), '0.2');
  assert.equal(C.ocfPercentage(0), '0');
  assert.equal(C.ocfPercentage(1), '1');
  assert.equal(C.ocfPercentage(1.4), '1');
  for (const f of [0, 0.06, 0.2, 1, 1 / 3]) assert.match(C.ocfPercentage(f), C.PERCENTAGE);
});

test('a jurisdiction gives the country and state of formation; anything else is the US, flagged', () => {
  assert.deepEqual(C.formationOf('Delaware'), { country: 'US', subdivision: 'DE', understood: true });
  assert.deepEqual(C.formationOf('state of new york'), { country: 'US', subdivision: 'NY', understood: true });
  assert.deepEqual(C.formationOf('CA'), { country: 'US', subdivision: 'CA', understood: true });
  assert.deepEqual(C.formationOf('District of Columbia'), { country: 'US', subdivision: 'DC', understood: true });
  assert.deepEqual(C.formationOf('GB'), { country: 'GB', subdivision: null, understood: true });
  // A Canadian province, and a country by name, are where they say (finding F10).
  assert.deepEqual(C.formationOf('Ontario'), { country: 'CA', subdivision: 'ON', understood: true });
  assert.deepEqual(C.formationOf('Province of British Columbia'), { country: 'CA', subdivision: 'BC', understood: true });
  assert.deepEqual(C.formationOf('Cayman Islands'), { country: 'KY', subdivision: null, understood: true });
  assert.deepEqual(C.formationOf('Neverland'), { country: 'US', subdivision: null, understood: false });
  assert.deepEqual(C.formationOf('constructor'), { country: 'US', subdivision: null, understood: false });
  assert.deepEqual(C.formationOf(null), { country: 'US', subdivision: null, understood: false });
  // And back, as Kosmitor keeps a jurisdiction.
  assert.equal(C.jurisdictionOf('US', 'DE'), 'Delaware');
  assert.equal(C.jurisdictionOf('CA', 'ON'), 'Ontario');
  assert.equal(C.jurisdictionOf('KY', null), 'KY');
  assert.equal(C.jurisdictionOf('US', 'toString'), 'US');
  assert.equal(C.jurisdictionOf(undefined, undefined), null);
  assert.equal(Object.keys(C.US_STATES).length, 51);
  assert.equal(C.currencyOf('eur'), 'EUR');
  assert.equal(C.currencyOf('dollars'), 'USD');
  assert.equal(C.currencyOf(null), 'USD');
});

test('the enum maps go both ways', () => {
  for (const r of ['FOUNDER', 'EMPLOYEE', 'ADVISOR', 'CONTRACTOR', 'INVESTOR', 'BOARD_MEMBER', 'FORMER_EMPLOYEE', 'OTHER'] as const) {
    assert.equal(C.RELATION_FROM_OCF[C.RELATION_TO_OCF[r]], r, r);
  }
  assert.equal(C.RELATION_TO_OCF.CONTRACTOR, 'CONSULTANT');
  assert.equal(C.RELATION_TO_OCF.FORMER_EMPLOYEE, 'EX_EMPLOYEE');
  assert.deepEqual(['EXECUTIVE', 'OFFICER', 'NON_US_EMPLOYEE', 'EX_ADVISOR', 'EX_CONSULTANT'].map((r) => C.RELATION_FROM_OCF[r as never]),
    ['EMPLOYEE', 'EMPLOYEE', 'EMPLOYEE', 'ADVISOR', 'CONTRACTOR']);
  assert.deepEqual(['INDIVIDUAL', 'ENTITY', 'TRUST', 'FUND'].map((t) => C.STAKEHOLDER_TYPE_TO_OCF[t as never]), ['INDIVIDUAL', 'INSTITUTION', 'INSTITUTION', 'INSTITUTION']);
  for (const type of ['ISO', 'NSO', 'RSU', 'SAR', 'PHANTOM', 'GROWTH_SHARE'] as const) {
    const out = C.compensationOf(type)!;
    assert.deepEqual(C.awardTypeOf(out.compensationType, out.optionGrantType, out.noted ? type : undefined), { type, assumed: false }, type);
  }
  assert.equal(C.compensationOf('RSA'), null, 'an RSA is exported as stock');
  assert.deepEqual(C.awardTypeOf('OPTION', 'INTL'), { type: 'NSO', assumed: true });
  assert.deepEqual(C.awardTypeOf('OPTION', undefined), { type: 'NSO', assumed: true });
  assert.deepEqual(C.awardTypeOf('OPTION', 'ISO'), { type: 'ISO', assumed: false });
  assert.deepEqual(C.awardTypeOf('CSAR', undefined), { type: 'SAR', assumed: false });
  assert.equal(C.awardTypeOf('WARRANT', undefined), null);
  for (const instrument of ['SAFE_PRE', 'SAFE_POST', 'NOTE', 'KISS'] as const) {
    const t = C.convertibleTypeOf(instrument);
    assert.deepEqual(C.instrumentOf(t.convertibleType, t.timing, instrument === 'KISS' ? 'KISS' : undefined), { instrument, assumed: false }, instrument);
  }
  assert.deepEqual(C.instrumentOf('SAFE', undefined), { instrument: 'SAFE_POST', assumed: true });
  assert.deepEqual(C.instrumentOf('CONVERTIBLE_SECURITY', undefined), { instrument: 'NOTE', assumed: false });
  for (const c of ['SIMPLE', 'ANNUAL', 'MONTHLY', 'DAILY'] as const) {
    const o = C.COMPOUNDING_TO_OCF[c];
    assert.deepEqual(C.compoundingOf(o.compoundingType, o.accrualPeriod), { compounding: c, approximate: false });
  }
  assert.deepEqual(C.compoundingOf('COMPOUNDING', 'QUARTERLY'), { compounding: 'ANNUAL', approximate: true });
  assert.equal(C.federalExemptionOf('Rule 701'), 'RULE_701');
  assert.equal(C.federalExemptionOf('section_4a2'), 'SECTION_4A2');
  assert.equal(C.federalExemptionOf('Texas limited offering'), null);
});

test('the note is written last among the comments, only with something to carry, and read back by kind', () => {
  assert.equal(writeNote({ title: null, department: undefined, name: '' }), null);
  const note = writeNote({ name: 'Ada', startDate: '2021-01-04', boardSeat: false, taxState: null })!;
  assert.equal(note, `${NOTE_PREFIX}{"name":"Ada","startDate":"2021-01-04","boardSeat":false}`);
  const comments = commentsWith(['Founder since day one', `${NOTE_PREFIX}{"name":"old"}`], note)!;
  assert.deepEqual(comments, ['Founder since day one', note], 'an old note is replaced, the new one is last');
  assert.deepEqual(readNote({ comments }, 'STAKEHOLDER'), { name: 'Ada', startDate: '2021-01-04', boardSeat: false });
  assert.deepEqual(plainComments({ comments }), ['Founder since day one']);
  assert.equal(commentsWith([], null), undefined);
});

test('a note from anywhere is read with care: malformed, unknown or ill-typed keys are dropped without a word', () => {
  const read = (raw: string, kind: Parameters<typeof readNote>[1] = 'STAKEHOLDER') => readNote({ comments: ['hello', raw] }, kind);
  assert.deepEqual(read(`${NOTE_PREFIX}{not json`), {});
  assert.deepEqual(read(`${NOTE_PREFIX}[1,2]`), {});
  assert.deepEqual(read(`${NOTE_PREFIX}"text"`), {});
  assert.deepEqual(read('kosmitor:2:{"name":"Later version"}'), {}, 'another version of the note is not read');
  assert.deepEqual(read(`${NOTE_PREFIX}${JSON.stringify({
    name: 'Bram', type: 'SPACESHIP', relation: 'FOUNDER', startDate: '2021-02-30', boardSeat: 'yes', isAdmin: true, __proto__x: 1,
  })}`), { name: 'Bram', relation: 'FOUNDER' });
  assert.deepEqual(read(`${NOTE_PREFIX}{"fmvAtGrant":-5,"type":"GROWTH_SHARE","rsuLiquidityCondition":true}`, 'TX_EQUITY_COMPENSATION_ISSUANCE'),
    { type: 'GROWTH_SHARE', rsuLiquidityCondition: true });
  assert.deepEqual(read(`${NOTE_PREFIX}{"quantity":0}`, 'TX_WARRANT_EXERCISE'), {});
  assert.deepEqual(read(`${NOTE_PREFIX}{"mfnElections":[{"date":"2023-02-01","adoptedSecurityId":"cnv_2"}],"instrument":"KISS"}`, 'TX_CONVERTIBLE_ISSUANCE'),
    { mfnElections: [{ date: '2023-02-01', adoptedSecurityId: 'cnv_2' }], instrument: 'KISS' });
  assert.deepEqual(read(`${NOTE_PREFIX}{"mfnElections":[{"date":"soon"}]}`, 'TX_CONVERTIBLE_ISSUANCE'), {});
  assert.deepEqual(read(`${NOTE_PREFIX}{"award":{"label":"RSA-1","ptepMonths":3,"expirationDate":null,"fmvAtGrant":50000}}`, 'TX_STOCK_ISSUANCE'),
    { award: { label: 'RSA-1', ptepMonths: 3, expirationDate: null, fmvAtGrant: 50_000 } });
  assert.deepEqual(read(`${NOTE_PREFIX}{"reportUrl":"javascript:alert(1)","status":"ACTIVE"}`, 'VALUATION'), { status: 'ACTIVE' });
  assert.deepEqual(readNote(null, 'STOCK_PLAN'), {});
  assert.deepEqual(readNote({ comments: 'not a list' }, 'STOCK_PLAN'), {});
});

test('a schedule in a note is all there or not at all, and its digest follows the conditions', () => {
  const schedule = {
    kind: 'TIME', durationMonths: 48, cliffMonths: 12, frequency: 'MONTHLY', immediatePortion: 0, yearWeights: [0.1, 0.2, 0.3, 0.4],
    milestones: null, customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 1, accelerationMonths: 12,
  };
  const ok = readNote({ comments: [writeNote({ schedule, digest: 'A'.repeat(22) })!] }, 'VESTING_TERMS');
  assert.deepEqual(ok, { schedule, digest: 'A'.repeat(22) });
  const bad = readNote({ comments: [writeNote({ schedule: { ...schedule, cliffMonths: 60 }, digest: 'short' })!] }, 'VESTING_TERMS');
  assert.deepEqual(bad, {}, 'a cliff past the duration and a malformed digest are both dropped');
  const milestones = readNote({ comments: [writeNote({ schedule: { ...schedule, kind: 'MILESTONE', milestones: [{ id: 'm1', name: 'Launch', portion: 0.5, targetDate: '2025-06-01', achievedDate: '2025-05-01' }] } })!] }, 'VESTING_TERMS');
  assert.equal(milestones.schedule?.milestones?.[0].achievedDate, null, 'achieved dates come from each security\'s vesting events, never the note');
  const conditions = [{ id: 'start', quantity: '0', trigger: { type: 'VESTING_START_DATE' }, next_condition_ids: [] }];
  assert.equal(termsDigest('CUMULATIVE_ROUND_DOWN', conditions), termsDigest('CUMULATIVE_ROUND_DOWN', structuredClone(conditions)));
  assert.notEqual(termsDigest('CUMULATIVE_ROUND_DOWN', conditions), termsDigest('CUMULATIVE_ROUNDING', conditions));
  assert.match(termsDigest('CUMULATIVE_ROUND_DOWN', conditions), /^[A-Za-z0-9_-]{22}$/);
});
