/**
 * Finding who and what an uploaded document is about, so it appears on that
 * person's page and on that certificate, grant or SAFE rather than only in the
 * vault. Only a clear match is used: a name or certificate number that appears
 * once in the company's records and in the file. A file that names several
 * people (a cap table) or none is linked to nobody, since a wrong link would put
 * a paper on a page where it does not belong. Who can see the document does not
 * change: linking never makes it visible to the person it names.
 */
import { all } from './db.ts';

export interface Link {
  stakeholderId: string | null;
  securityId: string | null;
  /** In words, for the person who uploaded it: "Dana Reyes · certificate CS-12". */
  about: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `needle` as a whole word or number, not inside a longer one. */
const has = (haystack: string, needle: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}-])${esc(needle.toLowerCase())}(?![\\p{L}\\p{N}-])`, 'u').test(haystack);

export async function findLinks(companyId: string, fileName: string, text: string): Promise<Link | null> {
  const haystack = `${fileName}\n${text}`.toLowerCase().replace(/\s+/g, ' ');

  const people = await all<{ id: string; name: string; email: string | null }>(
    'SELECT id, name, email FROM stakeholders WHERE company_id = ?', companyId);
  const named = people.filter((p) => {
    const name = p.name.trim().replace(/\s+/g, ' ');
    return (name.includes(' ') && name.length >= 5 && has(haystack, name)) || (!!p.email && has(haystack, p.email.trim()));
  });

  // An instrument named by its certificate number or its label.
  const rows = [
    ...(await all<{ id: string; stakeholder_id: string; key: string | null }>(
      'SELECT id, stakeholder_id, certificate_no AS key FROM issuances WHERE company_id = ?', companyId)).map((r) => ({ ...r, what: 'certificate' })),
    ...(await all<{ id: string; stakeholder_id: string; key: string | null }>(
      'SELECT id, stakeholder_id, label AS key FROM awards WHERE company_id = ?', companyId)).map((r) => ({ ...r, what: 'grant' })),
    ...(await all<{ id: string; stakeholder_id: string; key: string | null }>(
      'SELECT id, stakeholder_id, label AS key FROM convertibles WHERE company_id = ?', companyId)).map((r) => ({ ...r, what: 'convertible' })),
  ];
  const onlyOne = named.length === 1 ? named[0] : null;
  const hits = rows.filter((r) => {
    const key = r.key?.trim() ?? '';
    if (key.length < 4 || !has(haystack, key)) return false;
    // With one person named, the instrument must be theirs; with none, the number alone has to do.
    return !onlyOne || r.stakeholder_id === onlyOne.id;
  });
  const instrument = hits.length === 1 ? hits[0] : null;

  const holder = instrument ? people.find((p) => p.id === instrument.stakeholder_id) ?? null : onlyOne;
  if (!holder && !instrument) return null;
  return {
    stakeholderId: holder?.id ?? null,
    securityId: instrument?.id ?? null,
    about: [holder?.name, instrument ? `${instrument.what} ${instrument.key}` : ''].filter(Boolean).join(' · '),
  };
}
