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
 *
 * A report can also be read before its valuation is recorded: the 409A page
 * imports a PDF, from the computer or from the vault, and fills its form in from
 * what the report states. The reading records nothing and keeps nothing, but for
 * the line in the log that opening a document in the vault always writes. The
 * values go back to the page, and the file stays in the browser, or in the vault
 * where it already was. An uploaded file reaches the vault only once the
 * valuation is saved, in the same transaction as the link to it, so an import
 * that is cancelled leaves nothing behind and no report sits in the vault
 * without the valuation it belongs to.
 */
import { createHash } from 'node:crypto';
import { route, badRequest, notFound, forbidden, audit, str, newId, nowISO, HttpError, type Ctx } from '../http.ts';
import { one, insert, update, toCamel } from '../db.ts';
import { seesWholeCompany, seesWholeVault } from '../auth.ts';
import { readFile, storeFile, maxUploadBytes, uploadName } from './files.ts';
import { readReport, ReaderBusy } from '../report-reader.ts';

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

// --- Importing a report -----------------------------------------------------------

/** Whether the bytes are a PDF's: whatever the file is called, only a PDF is read or filed as a report. */
const isPdf = (bytes: Buffer): boolean => bytes.toString('latin1', 0, 5) === '%PDF-';

/** The uploaded file, when it is a PDF. Its size was checked as it arrived (limits.uploadMb). */
function uploadedPdf(body: Buffer | null): Buffer {
  if (!body || body.length === 0) throw badRequest('The upload is empty. Choose the report’s PDF.');
  if (!isPdf(body)) throw badRequest('That file is not a PDF the app can open. Choose the report’s PDF.');
  return body;
}

/** The file of a document in this company's vault, when it is a PDF this member may open. */
async function vaultPdf(ctx: Ctx, documentId: string): Promise<{ id: string; name: string; file: Buffer }> {
  const doc = await one<{ id: string; name: string; visibility: string; stakeholder_id: string | null }>(
    'SELECT id, name, visibility, stakeholder_id FROM documents WHERE id = ? AND company_id = ?', documentId, ctx.companyId);
  if (!doc) throw badRequest('That document is not in this company’s vault.');
  const { role, stakeholderId } = ctx.membership!;
  if (!seesWholeVault(role) && doc.visibility !== 'ALL' && doc.stakeholder_id !== stakeholderId) {
    throw forbidden('You do not have access to this document.');
  }
  const file = await readFile(doc.id);
  if (!file) throw badRequest('That document has no file to read. Choose the report’s PDF.');
  if (!isPdf(file)) throw badRequest('That document is not a PDF. Choose the report’s PDF.');
  return { id: doc.id, name: doc.name, file };
}

/**
 * The companies, and the people, a report is being read for now: one report at
 * a time for each, so a second press waits for the first rather than taking
 * another place in the server's line, and nobody fills the line by importing for
 * several companies at once.
 */
const reading = new Set<string>();

/**
 * Reads a 409A report and answers with what it states, recording nothing: the
 * PDF as the body, or ?documentId= for one in the vault. It is read in the
 * worker the valuation team's uploads are read in (report-reader.ts), with the
 * same limits on time and memory, and outside the company's lock, since a report
 * takes a moment and no change at the company needs to wait for it.
 */
route.post('/api/c/:cid/valuations/report-reading', 'write', async (ctx) => {
  const documentId = ctx.query.get('documentId');
  if (documentId && ctx.rawBody?.length) throw badRequest('Send the report or choose one in the vault, not both.');
  const vault = documentId ? await vaultPdf(ctx, documentId) : null;
  const pdf = vault?.file ?? uploadedPdf(ctx.rawBody);
  const company = await one<{ name: string; legal_name: string | null }>('SELECT name, legal_name FROM companies WHERE id = ?', ctx.companyId);
  // Nothing waits between this check and the marks, so two presses cannot both pass it.
  const marks = [`company:${ctx.companyId}`, `user:${ctx.user!.id}`];
  if (marks.some((mark) => reading.has(mark))) {
    throw new HttpError(429, 'An earlier report is still being read. Wait a moment for it to finish, then try again.');
  }
  for (const mark of marks) reading.add(mark);
  try {
    // The company's own names are never read as the appraiser's, however the report
    // sets them out. A place in the line is left for the valuation team's uploads.
    const names = [company?.name, company?.legal_name].filter((n): n is string => !!n);
    const detected = await readReport(pdf, { names, leave: 1 });
    // A document in the vault was opened, which is logged as a download of it is.
    if (vault) await audit(ctx, 'VIEW', 'documents', vault.id, `Read "${vault.name}" to fill in a valuation`);
    return { detected };
  } catch (err) {
    if (err instanceof ReaderBusy) throw new HttpError(503, 'The server is busy reading other reports. Try again in a moment.');
    throw err;
  } finally {
    for (const mark of marks) reading.delete(mark);
  }
}, { raw: true, maxBytes: maxUploadBytes, unlocked: true });

/** Where a report uploaded with its valuation is filed: with the valuations, for administrators, as the valuation team's uploads are. */
const REPORT_FILING = { category: 'VALUATION', folder: 'Valuations', visibility: 'ADMIN' } as const;

/**
 * Files an uploaded PDF as the valuation's report: the file as the body, its
 * name in ?name=. The document and the link to it are written in one
 * transaction, so nothing reaches the vault that the valuation does not point
 * to. Like PUT, it replaces a report on file before, which stays in the vault.
 */
route.post('/api/c/:cid/valuations/:id/report', 'write', async (ctx) => {
  const v = await ownValuation(ctx);
  const pdf = uploadedPdf(ctx.rawBody);
  const fileName = uploadName(ctx.query.get('name'));
  const docId = newId('doc');
  await insert('documents', {
    id: docId, companyId: ctx.companyId, name: fileName.slice(0, 200), ...REPORT_FILING, body: '',
    requiresSignature: 0, status: 'FINAL', fileName, mimeType: 'application/pdf', sizeBytes: pdf.length, storageKey: `db:${docId}`,
    sha256: createHash('sha256').update(pdf).digest('hex'), createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  await storeFile(docId, ctx.companyId!, pdf);
  await update('valuations', v.id, { reportDocumentId: docId, reportUrl: null });
  await audit(ctx, 'UPLOAD', 'documents', docId, `Uploaded "${fileName}" (${Math.round(pdf.length / 1024)} KB) as a valuation’s report`);
  await audit(ctx, 'UPDATE', 'valuations', v.id, `Report set to the uploaded document "${fileName}"`);
  return { document: await reportDocumentOf(ctx.companyId!, docId), url: null };
}, { raw: true, maxBytes: maxUploadBytes });
