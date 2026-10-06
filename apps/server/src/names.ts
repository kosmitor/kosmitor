/**
 * The rules for a person's name, kept apart from the HTTP layer so the sign-in
 * code can use them without importing it.
 *
 * A name is printed in emails, on certificates and PDFs, and in the audit trail.
 * Control characters and invisible formatting characters (zero widths, direction
 * overrides, NUL) have no business in any of those, and <, > and " are syntax in
 * an email header, so none of them is stored.
 */
export const UNSHOWABLE = /[\p{Cc}\p{Cf}]/u;
export const HEADER_SYNTAX = /[<>"]/;
export const HAS_SUBSTANCE = /[\p{L}\p{N}]/u;
export const NAME_MAX = 120;

/**
 * A name from somewhere the person cannot edit, such as a Google profile: what
 * cannot be stored is taken out rather than refused, since refusing would lock
 * them out of signing in.
 */
export function cleanPersonName(v: string, fallback: string): string {
  const tidy = v.normalize('NFC').replace(/[\p{Cc}\p{Cf}<>"]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return HAS_SUBSTANCE.test(tidy) ? tidy : fallback;
}
