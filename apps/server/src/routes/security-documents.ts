/**
 * The paperwork filed against one instrument.
 *
 * A certificate, an option grant, a SAFE and a warrant all collect documents:
 * the signed agreement, a board consent, an 83(b) filing, a side letter. They
 * are all rows in the same vault, joined to the instrument by security_id, so
 * one route serves all four and the page that asks does not need to know which
 * kind it is looking at.
 */
import { route, notFound, badRequest, str } from '../http.ts';
import { all, toCamelAll } from '../db.ts';
import { securityKind, isSubjectKind } from './files.ts';

/** Reading the whole vault is for the roles that may see the whole company. */
const WIDE = ['ADMIN', 'LEGAL', 'BOARD'];

route.get('/api/c/:cid/securities/:id/documents', 'read', async (ctx) => {
  const kind = await securityKind(ctx.companyId!, ctx.params.id);
  if (!kind) throw notFound('That instrument does not exist.');

  // Same rule as the documents page: anyone else sees what is published to
  // everyone, plus what is filed against them.
  const mine = ctx.membership!.stakeholderId;
  const documents = toCamelAll<Record<string, unknown>>(WIDE.includes(ctx.membership!.role)
    ? await all('SELECT * FROM documents WHERE company_id = ? AND security_id = ? ORDER BY created_at DESC', ctx.companyId, ctx.params.id)
    : await all(`SELECT * FROM documents WHERE company_id = ? AND security_id = ?
                 AND (visibility = 'ALL' OR stakeholder_id = ?) ORDER BY created_at DESC`, ctx.companyId, ctx.params.id, mine));

  const signatures = toCamelAll<Record<string, unknown>>(
    await all('SELECT * FROM signatures WHERE company_id = ?', ctx.companyId));

  return {
    kind,
    documents: documents.map((d) => ({ ...d, signatures: signatures.filter((s) => s.documentId === d.id) })),
  };
});

/**
 * The paperwork filed against a compliance subject.
 *
 * The $100,000 limit and the Rule 701 calculation have no row to hang a document
 * on, so a document names the subject and a reference instead: a year, a period,
 * a holder and a year together. The reference is whatever the page uses to
 * identify one instance, and it is matched exactly.
 */
route.get('/api/c/:cid/compliance-documents', 'read', async (ctx) => {
  const kind = ctx.query.get('kind');
  if (!isSubjectKind(kind)) throw badRequest('That is not a compliance subject this app files against.');
  const ref = str(ctx.query.get('ref'), 'Reference', { max: 120 });

  const mine = ctx.membership!.stakeholderId;
  const documents = toCamelAll<Record<string, unknown>>(WIDE.includes(ctx.membership!.role)
    ? await all(`SELECT * FROM documents WHERE company_id = ? AND subject_kind = ? AND subject_ref = ?
                 ORDER BY created_at DESC`, ctx.companyId, kind, ref)
    : await all(`SELECT * FROM documents WHERE company_id = ? AND subject_kind = ? AND subject_ref = ?
                 AND (visibility = 'ALL' OR stakeholder_id = ?) ORDER BY created_at DESC`, ctx.companyId, kind, ref, mine));

  const signatures = toCamelAll<Record<string, unknown>>(
    await all('SELECT * FROM signatures WHERE company_id = ?', ctx.companyId));

  return {
    kind,
    ref,
    documents: documents.map((d) => ({ ...d, signatures: signatures.filter((s) => s.documentId === d.id) })),
  };
});
