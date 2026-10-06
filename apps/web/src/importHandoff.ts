/**
 * Passes a file chosen on one page (the cap table) to the import wizard on
 * another without a round trip through storage: File objects live only in
 * memory, so this is a one-slot in-memory hand-off consumed on the wizard's
 * first render.
 */
let pending: { file: File; kind: string } | null = null;

export function stashImportFile(file: File, kind: string): void {
  pending = { file, kind };
}

export function takeImportFile(): { file: File; kind: string } | null {
  const p = pending;
  pending = null;
  return p;
}

export const IMPORT_ACCEPT = '.csv,.tsv,.txt,.xml,.xlsx,.pdf,text/csv,text/xml,application/xml,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
