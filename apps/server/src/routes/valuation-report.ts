/**
 * The report behind a valuation: the appraisal a 409A came from.
 *
 * A valuation is a price and a date, and the report is the evidence for both.
 * It is either a document in the company's vault, uploaded or already there, or
 * a link to wherever the appraiser keeps it. One or the other, never both, so
 * the record page has a single answer to "where is the report".
 *
 * update() matches on the id alone, so the valuation and the document are both
 * confirmed as this company's before anything is written.
 */
import { route, badRequest, notFound, audit, str, type Ctx } from '../http.ts';
import { one, update, toCamel } from '../db.ts';
import { seesWholeCompany, seesWholeVault } from '../auth.ts';

/** The document fields the page needs to name the report and decide how it opens. */
export interface ReportDocument {
  id: string; name: string; category: string; folder: string | null; status: string;
  fileName: string | null; mimeType: string | null; sizeBytes: number | null;
  visibility: string; hasBody: boolean; createdAt: string;
  /** True when a report is on file but the vault keeps it from this reader, who is told only that. */
  restricted?: boolean;
}

/**
 * The report document, if it is still this company's. The body of a document the
 * app wrote can be long, and all the page needs to know is that there is one.
 *
 * A record page must not become a way around the vault: someone the vault would
 * not show the document to learns that a report is on file, and nothing about it.
 */
export async function reportDocumentOf(companyId: string, documentId: string | null, role?: string, stakeholderId?: string | null): Promise<ReportDocument | null> {
  if (!documentId) return null;
  const d = await one<Record<string, any>>(
    `SELECT id, name, category, folder, status, file_name, mime_type, size_bytes, visibility, stakeholder_id, created_at,
            (body IS NOT NULL AND body <> '') AS has_body
     FROM documents WHERE id = ? AND company_id = ?`, documentId, companyId);
  if (!d) return null;
  const shared = role === undefined || seesWholeVault(role) || d.visibility === 'ALL' || (stakeholderId != null && d.stakeholder_id === stakeholderId);
  if (!shared) {
    return { id: d.id, name: '', category: d.category, folder: null, status: d.status, fileName: null, mimeType: null,
      sizeBytes: null, visibility: d.visibility, hasBody: false, createdAt: d.created_at, restricted: true };
  }
  const { stakeholderId: _holder, ...doc } = toCamel<ReportDocument & { stakeholderId: string | null }>(d)!;
  return doc;
}

/**
 * A link a person can open, and nothing else. A javascript: or data: address
 * put here would run in the browser of whoever clicked "Open the report".
 */
export function reportLink(v: unknown): string | null {
  const s = str(v, 'Report link', { max: 2000, optional: true });
  if (!s) return null;
  let url: URL;
  try { url = new URL(s); } catch { throw badRequest('The report link must be a full web address, starting with https://.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('The report link must be a web address, starting with https://.');
  }
  return url.toString();
}

async function ownValuation(ctx: Ctx): Promise<{ id: string; report_document_id: string | null; report_url: string | null }> {
  const v = await one<{ id: string; report_document_id: string | null; report_url: string | null }>(
    'SELECT id, report_document_id, report_url FROM valuations WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!v) throw notFound('Valuation not found.');
  return v;
}

/** Where the report is, for the valuations table: a document to open, a link, or nothing. */
route.get('/api/c/:cid/valuations/:id/report', 'read', async (ctx) => {
  if (!seesWholeCompany(ctx.membership?.role ?? '')) throw notFound('Valuation not found.');
  const v = await ownValuation(ctx);
  return {
    document: await reportDocumentOf(ctx.companyId!, v.report_document_id, ctx.membership!.role, ctx.membership!.stakeholderId),
    url: v.report_url,
  };
});

/**
 * Sets the report: `documentId` for a document in the vault, `url` for a link,
 * or neither to take the report off. Setting one clears the other.
 */
route.put('/api/c/:cid/valuations/:id/report', 'write', async (ctx) => {
  const v = await ownValuation(ctx);
  const documentId = ctx.body.documentId ? String(ctx.body.documentId) : null;
  const url = reportLink(ctx.body.url);
  if (documentId && url) throw badRequest('A report is a document or a link, not both.');

  if (documentId) {
    const doc = await one<{ id: string }>('SELECT id FROM documents WHERE id = ? AND company_id = ?', documentId, ctx.companyId);
    if (!doc) throw badRequest('That document is not in this company’s vault.');
  }

  await update('valuations', v.id, { reportDocumentId: documentId, reportUrl: url });
  const document = await reportDocumentOf(ctx.companyId!, documentId);
  await audit(ctx, 'UPDATE', 'valuations', v.id,
    document ? `Report set to the document "${document.name}"` : url ? 'Report set to a link' : 'Report removed');
  return { document, url };
});
