/**
 * Board seats over HTTP: the one-time seating of the founders and board members
 * a database had before seats existed, which never runs again; what a seat
 * accepts; and every list of directors (the company's board, consents and the
 * approvals that open one, the board audience of an update) reading the seat
 * rather than the relationship.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

delete process.env.SMTP_URL;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/analytics.ts');
await import('../src/routes/workflows.ts');
await import('../src/routes/fundraising.ts');
await import('../src/routes/company.ts');
const { resolveAudience } = await import('../src/routes/communications.ts');
await import('../src/routes/data.ts');
const { insert, one, all, exec, migrate, ONCE } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const company = async (name: string) => (await call('POST', '/api/companies', { name }, admin)).json.id as string;
const oldCo = await company('Oldboard');
const cid = await company('Boardco');
const otherCo = await company('Elsewhere');
const now = new Date().toISOString();
const person = async (companyId: string, body: Record<string, unknown>) => {
  const res = await call('POST', `/api/c/${companyId}/stakeholders`, { type: 'INDIVIDUAL', ...body }, admin);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json as { id: string; name: string; boardSeat: number; boardSeatStart: string | null; boardSeatEnd: string | null; boardDesignatedBy: string | null };
};

const seats = async () => Object.fromEntries((await all<{ id: string; board_seat: number; board_seat_start: string | null; board_seat_end: string | null }>(
  'SELECT id, board_seat, board_seat_start, board_seat_end FROM stakeholders WHERE company_id = ?', oldCo)).map((r) => [r.id, [r.board_seat, r.board_seat_start, r.board_seat_end]]));
/** The company's board list and its board audience, which read the same before seats. */
const boardOf = async (companyId: string) => ({
  list: (await call('GET', `/api/c/${companyId}/contacts`, undefined, admin)).json.boardMembers.map((b: any) => b.id).sort(),
  audience: (await resolveAudience(companyId, 'BOARD', [])).map((s) => s.id).sort(),
});
const dropSeatColumns = 'ALTER TABLE stakeholders DROP COLUMN board_designated_by, DROP COLUMN board_seat_end, DROP COLUMN board_seat_start, DROP COLUMN board_seat';
const OLD_SEATS = {
  old_founder: [1, null, null], old_left: [1, null, '2024-06-30'], old_leaving: [1, null, '2099-01-31'],
  old_board: [1, '2023-02-01', null], old_gone: [1, '2022-01-10', '2025-03-31'], old_backwards: [1, null, '2024-01-01'],
  old_angel: [0, null, null], old_staff: [0, null, null],
};

test('the seats a database had as relationships are given once, and a seat removed afterwards stays removed', async () => {
  // A database from before seats: no seat columns and no record of the backfill.
  await exec(`${dropSeatColumns}; DROP TABLE schema_migrations;`);
  const old = (id: string, name: string, relation: string, start: string | null = null, end: string | null = null) =>
    insert('stakeholders', { id, companyId: oldCo, name, type: 'INDIVIDUAL', relation, startDate: start, terminationDate: end, createdAt: now });
  await old('old_founder', 'Wren Ashby', 'FOUNDER', '2021-01-04');
  await old('old_left', 'Idris Vale', 'FOUNDER', '2021-01-04', '2024-06-30');          // left: the board passed over them
  await old('old_leaving', 'Rosa Quill', 'FOUNDER', '2021-01-04', '2099-01-31');       // leaves later: on the board until then
  await old('old_board', 'Ottilie Grange', 'BOARD_MEMBER', '2023-02-01');
  await old('old_gone', 'Marek Hollis', 'BOARD_MEMBER', '2022-01-10', '2025-03-31');    // a Board member's own dates are the seat's
  await old('old_backwards', 'Kofi Brandt', 'BOARD_MEMBER', '2025-03-01', '2024-01-01'); // imported with its dates the wrong way round
  await old('old_angel', 'Noor Haddad', 'INVESTOR');
  await old('old_staff', 'Priya Raman', 'EMPLOYEE', '2022-05-02');

  await migrate();
  assert.deepEqual(await seats(), OLD_SEATS);
  assert.deepEqual((await all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name), ONCE.map((s) => s.name).sort());
  // The board reads as it did: whoever had left is a former director, in neither the list nor the audience.
  assert.deepEqual(await boardOf(oldCo), { list: ['old_board', 'old_founder', 'old_leaving'], audience: ['old_board', 'old_founder', 'old_leaving'] });

  // An administrator takes a founder off the board. Restarts, and two replicas
  // starting at once, do not put the seat back.
  const removed = await call('PATCH', `/api/c/${oldCo}/stakeholders/old_founder`, { boardSeat: false }, admin);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(removed.json.boardSeat, 0);
  await migrate();
  await Promise.all([migrate(), migrate()]);
  assert.deepEqual(await seats(), { ...OLD_SEATS, old_founder: [0, null, null] });
  assert.equal((await one<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations'))!.n, ONCE.length);
  assert.deepEqual(await boardOf(oldCo), { list: ['old_board', 'old_leaving'], audience: ['old_board', 'old_leaving'] });
});

test('a stakeholders table restored from a dump taken before seats is seated again, and only then', async () => {
  // pg_restore --clean of such a dump recreates the table without the seat columns and leaves
  // schema_migrations, which the dump did not hold, naming the step that gave the seats.
  await exec(dropSeatColumns);
  await migrate();
  assert.deepEqual(await seats(), OLD_SEATS);
  assert.deepEqual(await boardOf(oldCo), { list: ['old_board', 'old_founder', 'old_leaving'], audience: ['old_board', 'old_founder', 'old_leaving'] });
  assert.equal((await call('PATCH', `/api/c/${oldCo}/stakeholders/old_founder`, { boardSeat: false }, admin)).status, 200);
  await migrate();
  assert.deepEqual((await seats()).old_founder, [0, null, null]);
});

test('a seat takes real dates in order and a designator from the same company, and keeps nothing once removed', async () => {
  const fund = await person(cid, { name: 'Larkspur Ventures Fund II, L.P.', type: 'FUND', relation: 'INVESTOR' });
  // A new Board member starts with a seat unless told otherwise; another relationship starts without one.
  assert.equal((await person(cid, { name: 'Beatrix Holm', relation: 'BOARD_MEMBER' })).boardSeat, 1);
  assert.equal((await person(cid, { name: 'Gideon Marsh', relation: 'BOARD_MEMBER', boardSeat: false })).boardSeat, 0);
  assert.equal((await person(cid, { name: 'Theo Lindqvist', relation: 'FOUNDER' })).boardSeat, 0);

  const refused = async (body: Record<string, unknown>, message: RegExp) => {
    const res = await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Refused', relation: 'INVESTOR', ...body }, admin);
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(res.json.error, message);
  };
  await refused({ boardSeat: true, boardSeatStart: '2024-06-01', boardSeatEnd: '2024-05-31' }, /cannot end before it starts/);
  await refused({ boardSeat: true, boardSeatStart: '2024-02-30' }, /real date/);
  await refused({ boardSeat: 'yes' }, /true or false/);
  assert.equal(await one("SELECT 1 FROM stakeholders WHERE name = 'Refused'"), undefined);

  // The angel who holds shares personally and sits on the board, named there by the fund: an investor and a director.
  const angel = await person(cid, { name: 'Dev Anand', relation: 'INVESTOR', boardSeat: true, boardSeatStart: '2024-02-01', boardDesignatedBy: fund.id });
  assert.deepEqual([angel.boardSeat, angel.boardSeatStart, angel.boardSeatEnd, angel.boardDesignatedBy], [1, '2024-02-01', null, fund.id]);

  // Nobody designates themselves, and the designator must be on this company's register:
  // update() matches on id alone, so another company's investor would otherwise be written.
  const self = await call('PATCH', `/api/c/${cid}/stakeholders/${angel.id}`, { boardDesignatedBy: angel.id }, admin);
  assert.equal(self.status, 400);
  assert.match(self.json.error, /themselves/);
  const elsewhere = await person(otherCo, { name: 'Halcyon Ventures', type: 'FUND', relation: 'INVESTOR' });
  const foreign = await call('PATCH', `/api/c/${cid}/stakeholders/${angel.id}`, { boardDesignatedBy: elsewhere.id }, admin);
  assert.equal(foreign.status, 400);
  assert.match(foreign.json.error, /must belong to this company/);
  assert.equal((await one<{ board_designated_by: string }>('SELECT board_designated_by FROM stakeholders WHERE id = ?', angel.id))!.board_designated_by, fund.id);
  // Nor is another company's stakeholder seated through this one.
  assert.equal((await call('PATCH', `/api/c/${cid}/stakeholders/${elsewhere.id}`, { boardSeat: true }, admin)).status, 404);
  assert.equal((await one<{ board_seat: number }>('SELECT board_seat FROM stakeholders WHERE id = ?', elsewhere.id))!.board_seat, 0);

  // Leaving the board keeps the seat as a former director's; taking it away clears everything about it.
  const left = await call('PATCH', `/api/c/${cid}/stakeholders/${angel.id}`, { boardSeatEnd: '2025-01-01' }, admin);
  assert.deepEqual([left.json.boardSeat, left.json.boardSeatStart, left.json.boardSeatEnd, left.json.boardDesignatedBy], [1, '2024-02-01', '2025-01-01', fund.id]);
  const off = await call('PATCH', `/api/c/${cid}/stakeholders/${angel.id}`, { boardSeat: false, boardSeatStart: '2024-03-01' }, admin);
  assert.deepEqual([off.json.boardSeat, off.json.boardSeatStart, off.json.boardSeatEnd, off.json.boardDesignatedBy], [0, null, null, null]);

  // Deleting the investor who designated a director leaves the director seated, with no designator.
  const spv = await person(cid, { name: 'Alder Grove Capital SPV', type: 'ENTITY', relation: 'INVESTOR' });
  const designee = await person(cid, { name: 'Corinne Ashdown', relation: 'BOARD_MEMBER', boardSeatStart: '2023-05-03', boardDesignatedBy: spv.id });
  assert.equal((await call('DELETE', `/api/c/${cid}/stakeholders/${spv.id}`, undefined, admin)).status, 200);
  const kept = await one<{ board_seat: number; board_designated_by: string | null }>('SELECT board_seat, board_designated_by FROM stakeholders WHERE id = ?', designee.id);
  assert.deepEqual([kept!.board_seat, kept!.board_designated_by], [1, null]);
});

test('the board, consents, approvals and the board audience follow the seat, not the relationship', async () => {
  const co = await company('Seatco');
  const fund = await person(co, { name: 'Tidewater Seed Partners', type: 'FUND', relation: 'INVESTOR' });
  const founder = await person(co, { name: 'Mira Castellanos', relation: 'FOUNDER', boardSeat: true, boardSeatStart: '2022-03-08' });
  const unseated = await person(co, { name: 'Theo Lindqvist', relation: 'FOUNDER' });                       // a founder who is not on the board
  const former = await person(co, { name: 'Marek Hollis', relation: 'BOARD_MEMBER', boardSeatStart: '2022-03-08', boardSeatEnd: '2024-05-25' });
  const future = await person(co, { name: 'Ines Calder', relation: 'BOARD_MEMBER', boardSeatStart: '2099-01-01' });
  const angel = await person(co, { name: 'Priyanka Nair', relation: 'INVESTOR', boardSeat: true, boardSeatStart: '2023-05-03', boardDesignatedBy: fund.id });
  await person(co, { name: 'Sana Qureshi', relation: 'EMPLOYEE' });
  const stranger = await person(otherCo, { name: 'Wendell Grant', relation: 'BOARD_MEMBER' });

  // The company's board: whoever holds a seat today, with the investor who named them.
  const board = (await call('GET', `/api/c/${co}/contacts`, undefined, admin)).json.boardMembers;
  assert.deepEqual(board.map((b: any) => b.id), [founder.id, angel.id]);
  assert.equal(board.find((b: any) => b.id === angel.id).designatedByName, fund.name);
  assert.equal(board.find((b: any) => b.id === angel.id).relation, 'INVESTOR');

  // A board consent names directors of its effective date, each once; with nobody named it asks the whole board of that day.
  const open = (body: Record<string, unknown>) => call('POST', `/api/c/${co}/consents`, { title: 'Approve the 2026 budget', ...body }, admin);
  const votersOf = async (consentId: string) => (await all<{ stakeholder_id: string }>('SELECT stakeholder_id FROM board_votes WHERE consent_id = ? ORDER BY stakeholder_id', consentId)).map((v) => v.stakeholder_id);
  const notADirector = await open({ directorIds: [unseated.id] });
  assert.equal(notADirector.status, 400);
  assert.match(notADirector.json.error, /Theo Lindqvist does not hold a board seat/);
  assert.equal((await open({ directorIds: [former.id] })).status, 400);                                     // left the board
  assert.equal((await open({ directorIds: [future.id] })).status, 400);                                     // not yet on it
  assert.match((await open({ directorIds: [stranger.id] })).json.error, /stakeholder of this company/);
  const past = await open({ directorIds: [former.id, founder.id], effectiveDate: '2023-01-16' });          // on the board that day
  assert.equal(past.status, 200, JSON.stringify(past.json));
  assert.deepEqual(await votersOf(past.json.id), [former.id, founder.id].sort());
  const whole = await open({});
  assert.equal(whole.status, 200, JSON.stringify(whole.json));
  assert.deepEqual(await votersOf(whole.json.id), [founder.id, angel.id].sort());
  assert.deepEqual(await votersOf((await open({ directorIds: [angel.id, angel.id] })).json.id), [angel.id]);
  assert.match((await open({ effectiveDate: '2021-06-01' })).json.error, /Nobody holds a board seat on 2021-06-01/);
  assert.match((await open({ directorIds: founder.id })).json.error, /must be a list/);                     // not read as nobody named

  // Approvals that open a consent check the board of the instrument's date the same way.
  const raise = (directorIds: string[], issueDate = '2026-09-21') => call('POST', `/api/c/${co}/convertibles/issue`, {
    terms: { instrument: 'SAFE_POST', valuationCap: 1_200_000_000 }, issueDate, approval: 'REQUEST', directorIds, signing: null,
    investors: [{ stakeholderId: fund.id, principal: 25_000_000 }],
  }, admin);
  assert.match((await raise([unseated.id])).json.error, /does not hold a board seat/);
  assert.equal((await raise([former.id])).status, 400);
  const raised = await raise([angel.id, founder.id]);
  assert.equal(raised.status, 200, JSON.stringify(raised.json));
  assert.deepEqual(await votersOf(raised.json.consent.id), [founder.id, angel.id].sort());

  // The angel is in the investors' audience by relationship and the board's by seat; the founder without a seat is in neither of the board's.
  const audiences = Object.fromEntries((await call('GET', `/api/c/${co}/updates`, undefined, admin)).json.audiences.map((a: any) => [a.key, a]));
  assert.equal(audiences.BOARD.label, 'Board of directors');
  assert.equal(audiences.BOARD.count, 2);
  const previewOf = async (audience: string) => {
    const draft = await call('POST', `/api/c/${co}/updates`, { title: `To ${audience}`, audience, body: 'Q3 numbers attached.' }, admin);
    return (await call('GET', `/api/c/${co}/updates/${draft.json.id}`, undefined, admin)).json.preview.map((p: any) => p.id).sort();
  };
  assert.deepEqual(await previewOf('BOARD'), [founder.id, angel.id].sort());
  assert.deepEqual(await previewOf('INVESTORS'), [fund.id, angel.id].sort());
  assert.ok((await previewOf('TEAM')).includes(unseated.id));
});

test('an import that reads a board member or director gives the seat; other relationships do not', async () => {
  const { commitImport } = await import('../src/import/engine.ts');
  const { loadCompanyData } = await import('../src/store.ts');
  const co = await company('Importco');
  const existing = await person(co, { name: 'Ottilie Grange', email: 'ottilie@example.com', relation: 'ADVISOR' });
  const departed = await person(co, { name: 'Lisbet Arnaud', relation: 'ADVISOR' });
  const unseated = await person(co, { name: 'Pell Ostrander', relation: 'BOARD_MEMBER', boardSeat: false });
  const seatedAlready = await person(co, { name: 'Saoirse Dunn', relation: 'INVESTOR', boardSeat: true, boardSeatStart: '2023-05-03' });

  await commitImport(co, {
    kind: 'stakeholders', headers: ['Name', 'Email', 'Relationship', 'Start', 'Termination'],
    rows: [
      ['Beatrix Holm', '', 'Board member', '2024-05-25', ''],
      ['Marek Hollis', '', 'Board Director', '2022-01-10', '2025-03-31'],
      ['Ottilie G.', 'OTTILIE@example.com', 'Director', '', ''],      // the existing advisor, now on the board
      ['Lisbet Arnaud', '', 'Board member', '2022-01-10', '2025-03-31'], // an existing advisor who sat on the board and left
      ['Pell Ostrander', '', 'Board member', '', ''],                    // a Board member whose seat was taken away keeps it away
      ['Saoirse Dunn', '', 'Board member', '2024-01-01', ''],           // a director already keeps the seat on file
      ['Gus Pemberton', '', 'Board observer', '', ''],
      ['Dev Anand', '', 'Angel investor', '', ''],
      ['Wren Ashby', '', 'Co-founder', '2021-01-04', ''],
    ],
    mapping: { stakeholderName: 0, email: 1, relation: 2, startDate: 3, terminationDate: 4 },
  }, 'Tester');
  // A certificate whose holder does not exist yet creates them with the relationship the row gives.
  await commitImport(co, {
    kind: 'captable', headers: ['Holder', 'Type', 'Class', 'Shares', 'Date'],
    rows: [['Corinne Ashdown', 'Board member', 'Common', 1_000, '2024-01-01']],
    mapping: { stakeholderName: 0, stakeholderType: 1, shareClassName: 2, quantity: 3, issueDate: 4 },
  }, 'Tester');

  const data = await loadCompanyData(co);
  const seat = (name: string) => {
    const s = data.stakeholders.find((x) => x.name === name)!;
    return [s.relation, s.boardSeat, s.boardSeatStart, s.boardSeatEnd];
  };
  assert.deepEqual(seat('Beatrix Holm'), ['BOARD_MEMBER', true, '2024-05-25', null]);
  assert.deepEqual(seat('Marek Hollis'), ['BOARD_MEMBER', true, '2022-01-10', '2025-03-31']);
  assert.deepEqual(seat(existing.name), ['BOARD_MEMBER', true, null, null]);
  assert.deepEqual(seat(departed.name), ['BOARD_MEMBER', true, '2022-01-10', '2025-03-31']);
  assert.deepEqual(seat(unseated.name), ['BOARD_MEMBER', false, null, null]);
  assert.deepEqual(seat(seatedAlready.name), ['BOARD_MEMBER', true, '2023-05-03', null]);
  assert.deepEqual(seat('Gus Pemberton'), ['OTHER', false, null, null]);
  assert.deepEqual(seat('Dev Anand'), ['INVESTOR', false, null, null]);
  assert.deepEqual(seat('Wren Ashby'), ['FOUNDER', false, null, null]);                                  // a founder is not seated by the relationship
  assert.deepEqual(seat('Corinne Ashdown'), ['BOARD_MEMBER', true, null, null]);
});
