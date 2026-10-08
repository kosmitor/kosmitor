/**
 * The board as the server reads it: the stakeholders with a seat on a given day
 * (isDirector in @kosmitor/core), whatever their relationship. The board list,
 * the board audience of an update and every consent that asks directors to
 * approve something read it from here.
 */
import { isDirector } from '@kosmitor/core';
import { badRequest } from './http.ts';
import { all, one, toCamelAll } from './db.ts';

export interface Director {
  id: string; name: string; email: string | null; relation: string; title: string | null;
  boardSeat: number; boardSeatStart: string | null; boardSeatEnd: string | null; boardDesignatedBy: string | null;
  /** The name of the investor who designated them, when one did. */
  designatedByName: string | null;
}

/** The company's directors on `date`, by name. */
export async function directorsOn(companyId: string, date: string): Promise<Director[]> {
  const rows = toCamelAll<Director>(await all(
    `SELECT s.id, s.name, s.email, s.relation, s.title, s.board_seat, s.board_seat_start, s.board_seat_end, s.board_designated_by,
            d.name AS designated_by_name
       FROM stakeholders s LEFT JOIN stakeholders d ON d.id = s.board_designated_by AND d.company_id = s.company_id
      WHERE s.company_id = ? ORDER BY s.name`, companyId));
  return rows.filter((r) => isDirector(r, date));
}

/**
 * The directors named to approve something that takes effect on `date`, each once.
 * Every one must hold a board seat that day: a founder or a Board member without
 * one is not a director, and a stakeholder of another company is nobody's here.
 * No ids names nobody; ids that are not a list are refused, not read as nobody.
 */
export async function namedDirectors(companyId: string, ids: unknown, date: string): Promise<string[]> {
  const list = ids == null ? [] : Array.isArray(ids) ? ids : null;
  if (!list) throw badRequest('Directors must be a list of stakeholder ids.');
  const named = [...new Set(list.map(String))];
  if (named.length === 0) return [];
  const board = new Set((await directorsOn(companyId, date)).map((d) => d.id));
  for (const id of named) {
    if (board.has(id)) continue;
    const who = await one<{ name: string }>('SELECT name FROM stakeholders WHERE id = ? AND company_id = ?', id, companyId);
    throw badRequest(who
      ? `${who.name} does not hold a board seat on ${date}, so cannot approve as a director. Give them a seat on their stakeholder record first.`
      : 'Every director must be a stakeholder of this company.');
  }
  return named;
}
