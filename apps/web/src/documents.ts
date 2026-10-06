/** Document categories, shared by the Documents page and the import wizard's PDF step. Keep in step with the server's list. */
export const DOCUMENT_CATEGORIES: [string, string][] = [
  ['FINANCING', 'Financing'], ['GRANT', 'Equity grant'], ['VALUATION', 'Valuation'],
  ['CHARTER', 'Charter & bylaws'], ['BOARD', 'Board materials'], ['AGREEMENT', 'Agreement'],
  ['TAX', 'Tax'], ['OTHER', 'Other'],
];

/**
 * Categories the app sets for itself when it generates paperwork. They are not
 * offered in the pickers, because nobody should have to file a document as a
 * stock certificate by hand, but they still have to read as words wherever a
 * generated document is listed.
 */
const GENERATED_CATEGORIES: [string, string][] = [
  ['CERTIFICATE', 'Stock certificate'],
  ['GRANT_AGREEMENT', 'Award agreement'],
  ['CONVERTIBLE_AGREEMENT', 'Convertible agreement'],
];

/** The name to show for a category, never the shouted code and never a blank. */
export const categoryLabel = (category: string | null | undefined): string => {
  if (!category) return 'Other';
  const found = [...DOCUMENT_CATEGORIES, ...GENERATED_CATEGORIES].find(([value]) => value === category);
  return found ? found[1] : category;
};

/** The fields a document carries that decide how, or whether, it can be read. */
export interface ReadableDocument {
  id: string;
  name: string;
  body?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}

/** An uploaded file is a PDF when it says so, or when its name says so. */
export const isPdfDocument = (d: ReadableDocument): boolean =>
  d.mimeType === 'application/pdf' || /\.pdf$/i.test(String(d.fileName ?? ''));

/**
 * The path that renders a document on screen, or null when there is no page to
 * show. An uploaded PDF is served back as it arrived, a document the app wrote
 * is rendered from its body on request, and an uploaded file of any other kind
 * can only be downloaded. The distinction is what `fileName` records: a stored
 * file has one, a document the app composed does not.
 */
export const readableDocumentPath = (companyId: string, d: ReadableDocument): string | null => {
  if (d.fileName) return isPdfDocument(d) ? `/c/${companyId}/documents/${d.id}/download` : null;
  return d.body ? `/c/${companyId}/documents/${d.id}/pdf` : null;
};

/** The name a document should be saved under. */
export const documentFilename = (d: ReadableDocument): string => d.fileName ?? `${d.name}.pdf`;

/** True when the document is a file someone uploaded rather than one the app wrote. */
export const isUploadedFile = (d: ReadableDocument): boolean => Boolean(d.fileName);

/**
 * How a document can be opened, if at all.
 *
 * Three answers, not two. A document with a page to show is read on screen. An
 * uploaded file with no page, such as a Word document, is saved instead. And a
 * document that is neither, which is what a record created with an empty body
 * and no file attached leaves behind, can be opened no way at all: offering to
 * download it would promise something the server cannot deliver.
 */
export type DocumentAccess = 'read' | 'download' | 'none';

export const documentAccess = (companyId: string, d: ReadableDocument): DocumentAccess =>
  (readableDocumentPath(companyId, d) ? 'read' : isUploadedFile(d) ? 'download' : 'none');

/**
 * The one document of a kind filed against each holding.
 *
 * Building a Map from a list of pairs keeps the LAST pair for a repeated key,
 * and the documents endpoint returns them newest first, so the obvious spelling
 * of this quietly picks the oldest. That matters now that a holding can carry
 * more than one document of the same kind: filing a signed scan against a
 * certificate the app already wrote leaves two, and which one wins decides what
 * the row names, what the signature count reads and what a countersign acts on.
 * This keeps the first it meets, which is the newest.
 */
export const newestPerHolding = <T extends { securityId?: string | null }>(documents: readonly T[]): Map<string, T> => {
  const byHolding = new Map<string, T>();
  for (const d of documents) {
    if (!d.securityId || byHolding.has(d.securityId)) continue;
    byHolding.set(d.securityId, d);
  }
  return byHolding;
};

/** Where a document's stored file is served from, when it has one. */
export const downloadDocumentPath = (companyId: string, d: ReadableDocument): string =>
  `/c/${companyId}/documents/${d.id}/download`;
