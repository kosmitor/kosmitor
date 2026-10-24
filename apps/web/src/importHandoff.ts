/**
 * Passes files chosen on one page (the cap table's empty state) to the import
 * page on another without a round trip through storage: File objects live only
 * in memory, so this is a one-slot in-memory hand-off taken on the import
 * page's first render. A reload loses it, and the import page says so.
 */
let pending: { files: File[]; kind: string | null } | null = null;

export function stashImportFiles(files: File[], kind: string | null): void {
  pending = { files, kind };
}

export function takeImportFiles(): { files: File[]; kind: string | null } | null {
  const p = pending;
  pending = null;
  return p;
}

/** What the file picker offers: spreadsheets, Open Cap Format packages (.ocf.zip, or their JSON files), and PDFs, which are saved as documents instead. */
export const IMPORT_ACCEPT = '.csv,.tsv,.txt,.xml,.xlsx,.zip,.json,.pdf,text/csv,text/xml,application/xml,application/zip,application/json,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A PDF is never read as a table: it is saved as a document. */
export const isPdf = (file: File): boolean => /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
