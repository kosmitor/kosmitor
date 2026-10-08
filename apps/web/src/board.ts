/**
 * Who sits on the board. A seat is kept on the stakeholder apart from the
 * relationship, so an investor can hold one and a founder need not. The server
 * decides it the same way (isDirector in @kosmitor/core, which the web does not
 * import): every director list and the consent forms read it from here.
 */
import { today } from './format.ts';

/** A stakeholder's seat as the API returns it: a 0/1 flag (true from the engine) and the dates it ran. */
export interface Seated { boardSeat?: number | boolean | null; boardSeatStart?: string | null; boardSeatEnd?: string | null }

export const hasBoardSeat = (s: Seated): boolean => s.boardSeat === 1 || s.boardSeat === true;

/** On the board on a day: the seat has started by then and has not yet ended. */
export const isDirector = (s: Seated, on?: string | null): boolean => {
  const day = on || today();
  return hasBoardSeat(s) && (!s.boardSeatStart || s.boardSeatStart <= day) && (!s.boardSeatEnd || s.boardSeatEnd > day);
};

/** Off the board by a day: the seat ended, and stays on the record as a former director's. */
export const isFormerDirector = (s: Seated, on?: string | null): boolean =>
  hasBoardSeat(s) && !!s.boardSeatEnd && s.boardSeatEnd <= (on || today());

/** The stakeholders who are directors on a day, today unless one is given. */
export const directorsOn = <T extends Seated>(stakeholders: T[] | null | undefined, on?: string | null): T[] =>
  (stakeholders ?? []).filter((s) => isDirector(s, on));

/**
 * The directors chosen to approve something, after its date moves from one day to another:
 * those still on the board stay as chosen, those off it that day drop out, and those who join
 * the board by then are added. A director left out on purpose stays out.
 */
export const reselectDirectors = <T extends Seated & { id: string }>(
  chosen: string[], stakeholders: T[] | null | undefined, from: string | null | undefined, to: string | null | undefined,
): string[] => {
  const before = new Set(directorsOn(stakeholders, from).map((d) => d.id));
  return directorsOn(stakeholders, to).map((d) => d.id).filter((id) => chosen.includes(id) || !before.has(id));
};
