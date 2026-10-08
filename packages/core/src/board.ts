/**
 * Who sits on the board. A seat is recorded on the stakeholder apart from the
 * relation, so an investor can hold one and a founder need not. A seat that
 * ended stays on the record as a former director's. Every director list, board
 * consent and board audience decides directorship here; the web keeps the same
 * rule in apps/web/src/board.ts.
 */
import type { ISODate } from './types.ts';

/** A seat as the engine or a stored row carries it: a boolean or 0/1 flag, and the dates it ran. */
export interface BoardSeat {
  boardSeat?: boolean | number | null;
  boardSeatStart?: ISODate | null;
  boardSeatEnd?: ISODate | null;
}

const seated = (s: BoardSeat): boolean => s.boardSeat === true || s.boardSeat === 1;

/** A director on `date`: the seat has started by then and has not yet ended (the end day is the first one off the board). */
export function isDirector(s: BoardSeat, date: ISODate): boolean {
  return seated(s) && (!s.boardSeatStart || s.boardSeatStart <= date) && (!s.boardSeatEnd || s.boardSeatEnd > date);
}

/** Off the board by `date`: the seat ended on or before it. */
export function isFormerDirector(s: BoardSeat, date: ISODate): boolean {
  return seated(s) && !!s.boardSeatEnd && s.boardSeatEnd <= date;
}
