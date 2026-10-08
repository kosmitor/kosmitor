import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDirector, isFormerDirector } from '../src/board.ts';
import { beneficialOwnershipReport } from '../src/compliance.ts';
import { seedCompany, $$ } from './fixtures.ts';

test('a director holds a seat that has started and not yet ended; the end day is the first one off the board', () => {
  const seat = { boardSeat: true, boardSeatStart: '2023-05-03', boardSeatEnd: '2025-03-31' };
  assert.equal(isDirector(seat, '2023-05-02'), false);
  assert.equal(isDirector(seat, '2023-05-03'), true);
  assert.equal(isDirector(seat, '2025-03-30'), true);
  assert.equal(isDirector(seat, '2025-03-31'), false);
  assert.equal(isFormerDirector(seat, '2025-03-30'), false);
  assert.equal(isFormerDirector(seat, '2025-03-31'), true);
  // An undated seat runs always; a stored 0/1 flag reads like the boolean; no seat is no director, whatever the dates.
  assert.equal(isDirector({ boardSeat: 1 }, '1999-01-01'), true);
  assert.equal(isDirector({ boardSeat: 0, boardSeatStart: '2020-01-01' }, '2024-01-01'), false);
  assert.equal(isDirector({}, '2024-01-01'), false);
  assert.equal(isFormerDirector({ boardSeat: false, boardSeatEnd: '2020-01-01' }, '2024-01-01'), false);
});

test('beneficial ownership counts a director by seat: an investor on the board controls, a founder still does, a former director does not', () => {
  const d = seedCompany();
  const person = (id: string, name: string, relation: 'INVESTOR' | 'BOARD_MEMBER', seat: object) => ({
    id, name, email: null, type: 'INDIVIDUAL' as const, relation, startDate: null, terminationDate: null, taxCountry: 'US', taxState: 'CA', entityGroupId: null, ...seat,
  });
  d.stakeholders.push(
    person('sh_angel', 'Dev Anand', 'INVESTOR', { boardSeat: true, boardSeatStart: '2023-05-03' }),
    person('sh_gone', 'Marek Hollis', 'BOARD_MEMBER', { boardSeat: true, boardSeatStart: '2021-01-01', boardSeatEnd: '2023-01-01' }),
  );
  for (const [id, holder] of [['is_angel', 'sh_angel'], ['is_gone', 'sh_gone']]) {
    d.issuances.push({ id, certificateNo: id, stakeholderId: holder, shareClassId: 'sc_common', quantity: 10, pricePerShare: $$(0.10), issueDate: '2021-06-01',
      status: 'OUTSTANDING', vestingScheduleId: null, vestingStartDate: null, earlyExercised: false, election83bFiledOn: null, sourceAwardId: null, notes: null });
  }
  const owners = beneficialOwnershipReport(d, { asOf: '2024-09-01' }).owners;
  assert.deepEqual(owners.find((o) => o.stakeholderId === 'sh_angel')?.reasons, ['control']);
  assert.equal(owners.some((o) => o.stakeholderId === 'sh_gone'), false);
  assert.ok(owners.find((o) => o.stakeholderId === 'sh_a')?.reasons.includes('control'));
});
