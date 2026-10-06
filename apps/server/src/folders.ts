/**
 * Document folders.
 *
 * A folder is not a row of its own: it is the text stored on each document, and
 * a slash in it separates levels, so "Financing/Series A" is "Series A" inside
 * "Financing". The documents page builds its tree from those paths. Names saved
 * before folders could nest have no slash and so stay top-level folders.
 *
 * Three routes write the path (creating a document, uploading a file and
 * editing a document), and they all go through documentFolder() below. One rule
 * for all three is what keeps "Series A", " Series A " and "Series  A" from
 * becoming three folders that look the same on the page.
 */
import { badRequest } from './http.ts';
import { UNSHOWABLE } from './names.ts';

/** Where a document goes when nobody says. */
export const DEFAULT_FOLDER = 'General';
/** How deep folders may nest. Past this the tree is harder to read than a longer name would be. */
export const FOLDER_MAX_DEPTH = 5;
/** The longest one folder's name may be, in characters. */
export const FOLDER_NAME_MAX = 60;
/** The longest a whole path may be, in characters, slashes included. */
export const FOLDER_PATH_MAX = 120;

// Control characters are what remain after every run of whitespace (tabs and
// line breaks included) has become one space, and formatting characters (zero
// widths, direction overrides) are never drawn at all. Neither can be seen on
// the page, so two names that differ only by one would look like the same
// folder, and a direction override would also turn the name around in the audit
// log. People's names keep out the same characters (names.ts).

/**
 * The folder a document is filed under, cleaned up the one way every route
 * cleans it: each level is trimmed and its inner whitespace collapsed, empty
 * levels are dropped (so "a//b" and "/a/b/" are both "a/b"), and nothing at all
 * means the default folder. A value that is not text, or a path too deep or too
 * long, is refused rather than shortened, because a shortened path would put
 * the document somewhere the person did not ask for.
 */
export function documentFolder(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_FOLDER;
  if (typeof value !== 'string') throw badRequest('A folder must be text.');

  const levels = value.normalize('NFC').split('/')
    .map((level) => level.replace(/\s+/g, ' ').trim())
    .filter((level) => level !== '');
  if (levels.length === 0) return DEFAULT_FOLDER;

  if (levels.some((level) => UNSHOWABLE.test(level))) throw badRequest('A folder name cannot contain hidden characters.');
  if (levels.length > FOLDER_MAX_DEPTH) throw badRequest(`Folders can be at most ${FOLDER_MAX_DEPTH} levels deep.`);
  // Counted in characters rather than in the two-byte units JavaScript strings
  // are made of, so a name with an emoji or a less common script in it is not
  // treated as longer than it looks.
  if (levels.some((level) => [...level].length > FOLDER_NAME_MAX)) {
    throw badRequest(`A folder name can be at most ${FOLDER_NAME_MAX} characters.`);
  }
  const path = levels.join('/');
  if ([...path].length > FOLDER_PATH_MAX) throw badRequest(`A folder path can be at most ${FOLDER_PATH_MAX} characters.`);
  return path;
}
