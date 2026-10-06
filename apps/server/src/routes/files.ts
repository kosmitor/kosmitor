/**
 * Document files: upload any file against a company (optionally attached to a
 * stakeholder or security) and download it back under the same access rules
 * as the document list.
 *
 * File contents are stored in the database alongside everything else, so a
 * database backup is a complete backup — no uploads directory to keep in
 * sync. Earlier builds wrote files to data/uploads; any that remain are
 * folded into the database when the server starts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { route, badRequest, notFound, forbidden, audit, newId, nowISO, str } from '../http.ts';
import { one, all, insert, run, toCamel, transaction } from '../db.ts';
import { SERVER_DIR } from '../env.ts';
import { config, megabytes } from '../config.ts';
import { documentFolder } from '../folders.ts';

/** The largest document upload, limits.uploadMb. */
export const maxUploadBytes = (): number => megabytes(config().limits.uploadMb);
/** Where earlier builds kept files. */
export const LEGACY_UPLOAD_DIR = process.env.CT_LEGACY_UPLOAD_DIR ?? resolve(SERVER_DIR, 'data/uploads');

/**
 * The categories a document may carry.
 *
 * The first eight are what someone picks when they file paperwork by hand. The
 * last three are written by the app itself when it generates a document — a
 * stock certificate, an option or RSU agreement, a SAFE or note. Those have to
 * be accepted here too: otherwise a signed copy of a certificate this app
 * produced could not be uploaded back against the shares it belongs to, which
 * is exactly what someone does after the paper comes back from the printer.
 */
export const CHOSEN_CATEGORIES = ['FINANCING', 'GRANT', 'VALUATION', 'CHARTER', 'BOARD', 'AGREEMENT', 'TAX', 'OTHER'] as const;
export const GENERATED_CATEGORIES = ['CERTIFICATE', 'GRANT_AGREEMENT', 'CONVERTIBLE_AGREEMENT'] as const;
export const DOCUMENT_CATEGORIES: readonly string[] = [...CHOSEN_CATEGORIES, ...GENERATED_CATEGORIES];
export const isDocumentCategory = (value: unknown): value is string =>
  typeof value === 'string' && DOCUMENT_CATEGORIES.includes(value);

const CATEGORIES = new Set(DOCUMENT_CATEGORIES);
/** The tables a document may be attached to: everything a stakeholder can hold. */
export const SECURITY_TABLES = ['issuances', 'awards', 'convertibles', 'warrants'] as const;

/**
 * Compliance subjects a document may be filed against.
 *
 * Unlike an instrument, most of these are not rows in a table: the $100,000 test
 * and the Rule 701 calculation are worked out from the cap table each time they
 * are asked for. The paperwork behind them is real all the same, so it is filed
 * against a named subject and a reference that says which one. The reference is
 * whatever identifies that instance to a person: a year, a period, a holder and
 * a year together.
 */
export const SUBJECT_KINDS = ['ISO_100K', 'RULE_701', 'ELECTION_83B', 'FORM_3921', 'BOI'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const isSubjectKind = (v: unknown): v is SubjectKind => SUBJECT_KINDS.includes(v as SubjectKind);

/**
 * Which kind of instrument an id belongs to, or null when it belongs to none of
 * them in this company. The table names come from the list above and never from
 * a request, which is what makes interpolating them into the query safe.
 */
export async function securityKind(companyId: string, securityId: string): Promise<string | null> {
  for (const table of SECURITY_TABLES) {
    if (await one(`SELECT id FROM ${table} WHERE id = ? AND company_id = ?`, securityId, companyId)) return table;
  }
  return null;
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Stores a file's bytes for a document, replacing any previous content. */
export async function storeFile(documentId: string, companyId: string, content: Buffer): Promise<void> {
  await run('DELETE FROM file_blobs WHERE document_id = ?', documentId);
  await insert('file_blobs', {
    documentId, companyId, content, sizeBytes: content.length, sha256: sha256(content), createdAt: nowISO(),
  });
}

export async function readFile(documentId: string): Promise<Buffer | null> {
  const row = await one<{ content: Buffer }>('SELECT content FROM file_blobs WHERE document_id = ?', documentId);
  return row ? Buffer.from(row.content) : null;
}

/**
 * One-time migration of files written to disk by earlier builds. Each is
 * copied into the database, its document re-pointed, and the disk copy
 * removed. Files nothing references are left where they are.
 */
export async function migrateLegacyFiles(): Promise<number> {
  if (!existsSync(LEGACY_UPLOAD_DIR)) return 0;
  const pending = await all<{ id: string; company_id: string; storage_key: string }>(
    `SELECT d.id, d.company_id, d.storage_key FROM documents d
     LEFT JOIN file_blobs b ON b.document_id = d.id
     WHERE d.storage_key IS NOT NULL AND d.storage_key NOT LIKE 'db:%' AND b.document_id IS NULL`);
  let moved = 0;
  for (const doc of pending) {
    const path = resolve(LEGACY_UPLOAD_DIR, doc.storage_key);
    if (!path.startsWith(LEGACY_UPLOAD_DIR) || !existsSync(path)) continue;
    const content = readFileSync(path);
    await transaction(async () => {
      await storeFile(doc.id, doc.company_id, content);
      await run('UPDATE documents SET storage_key = ? WHERE id = ?', `db:${doc.id}`, doc.id);
    });
    rmSync(path, { force: true });
    moved++;
  }
  for (const entry of readdirSync(LEGACY_UPLOAD_DIR)) {
    const dir = resolve(LEGACY_UPLOAD_DIR, entry);
    try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: false }); } catch { /* not a directory */ }
  }
  try { if (readdirSync(LEGACY_UPLOAD_DIR).length === 0) rmSync(LEGACY_UPLOAD_DIR, { recursive: false }); } catch { /* keep it */ }
  if (moved > 0) console.log(`[files] moved ${moved} uploaded file${moved === 1 ? '' : 's'} from disk into the database`);
  return moved;
}

route.post('/api/c/:cid/documents/upload', 'write', async (ctx) => {
  const body = ctx.rawBody;
  if (!body || body.length === 0) throw badRequest('The upload is empty.');
  const fileName = str(ctx.query.get('name') ?? '', 'File name', { max: 255 }).replace(/[\\/]/g, '_');
  const category = String(ctx.query.get('category') ?? 'OTHER').toUpperCase();
  if (!CATEGORIES.has(category)) throw badRequest('Choose a valid document category.');
  const mimeType = String(ctx.req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
  const folder = documentFolder(ctx.query.get('folder'));

  const stakeholderId = ctx.query.get('stakeholderId') || null;
  if (stakeholderId && !(await one('SELECT id FROM stakeholders WHERE id = ? AND company_id = ?', stakeholderId, ctx.companyId))) {
    throw badRequest('That stakeholder does not belong to this company.');
  }

  // The instrument is chosen in the browser, so it is checked here rather than trusted.
  const securityId = ctx.query.get('securityId') || null;
  if (securityId && !(await securityKind(ctx.companyId!, securityId))) {
    throw badRequest('That instrument does not belong to this company.');
  }

  // A compliance subject is a name and a reference rather than a row, so there is
  // nothing to look up; what is checked is that the name is one this app knows and
  // that the two halves arrive together, since either alone files nothing.
  const subjectKind = ctx.query.get('subjectKind') || null;
  const subjectRef = ctx.query.get('subjectRef') || null;
  if (subjectKind && !isSubjectKind(subjectKind)) throw badRequest('That is not a compliance subject this app files against.');
  if (Boolean(subjectKind) !== Boolean(subjectRef)) throw badRequest('A compliance subject needs both a kind and a reference.');

  // Only a document with a holder can be shown to that holder; without one it stays with the administrators.
  const asked = String(ctx.query.get('visibility') ?? '').toUpperCase();
  const visibility = asked === 'ALL' ? 'ALL' : asked === 'HOLDER' && stakeholderId ? 'HOLDER' : 'ADMIN';

  const docId = newId('doc');
  await transaction(async () => {
    await insert('documents', {
      id: docId, companyId: ctx.companyId, name: (ctx.query.get('title') || fileName).slice(0, 200),
      category, folder, body: '',
      stakeholderId, securityId, subjectKind, subjectRef: subjectRef ? String(subjectRef).slice(0, 120) : null,
      requiresSignature: 0, status: 'FINAL',
      visibility,
      fileName, mimeType, sizeBytes: body.length, storageKey: `db:${docId}`, sha256: sha256(body),
      createdBy: ctx.user!.name, createdAt: nowISO(),
    });
    await storeFile(docId, ctx.companyId!, body);
  });
  await audit(ctx, 'UPLOAD', 'documents', docId, `Uploaded "${fileName}" (${Math.round(body.length / 1024)} KB)`);
  return toCamel(await one('SELECT * FROM documents WHERE id = ?', docId));
}, { raw: true, maxBytes: maxUploadBytes });

route.get('/api/c/:cid/documents/:id/download', 'read', async (ctx) => {
  const doc = toCamel<Record<string, unknown>>(
    await one('SELECT * FROM documents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!doc) throw notFound('Document not found.');
  const role = ctx.membership!.role;
  const mine = ctx.membership!.stakeholderId;
  if (!['ADMIN', 'LEGAL', 'BOARD'].includes(role) && doc.visibility !== 'ALL' && doc.stakeholderId !== mine) {
    throw forbidden('You do not have access to this document.');
  }
  if (!doc.storageKey) throw notFound('This document has no file attached.');
  const content = await readFile(String(doc.id));
  if (!content) throw notFound('The file is missing from storage.');

  const fileName = String(doc.fileName ?? doc.name ?? 'document');
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  ctx.res.writeHead(200, {
    'Content-Type': String(doc.mimeType ?? 'application/octet-stream'),
    'Content-Length': content.length,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  ctx.res.end(content);
  await audit(ctx, 'DOWNLOAD', 'documents', String(doc.id), `Downloaded "${fileName}"`);
  return undefined;
});

/** Blobs go with their document via the foreign key; this only removes a disk copy left by an earlier build. */
export async function removeStoredFile(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey || storageKey.startsWith('db:')) return;
  const path = resolve(LEGACY_UPLOAD_DIR, storageKey);
  if (path.startsWith(LEGACY_UPLOAD_DIR)) rmSync(path, { force: true });
}
