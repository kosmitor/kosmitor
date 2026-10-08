/**
 * Importing a 409A report on the company's 409A page.
 *
 * Most companies get their 409A as a PDF from an appraiser and used to type its
 * figures into the form by hand. Here the PDF comes from the computer or from
 * the vault, the server reads it (report-detect.ts, in the same bounded worker
 * as the valuation team's uploads) and the form to record the valuation opens
 * filled in from what it states, each value marked with where it was read.
 *
 * Reading keeps nothing on the server: the file stays in the browser until the
 * valuation is saved, and only then is it filed in the vault as the valuation's
 * report, in one step with the link to it. A report chosen from the vault is
 * pointed to where it is, and reading it is logged as opening it is. So closing
 * the form, or choosing another report, leaves nothing behind.
 */
import { useRef, useState } from 'react';
import { useSession } from './session.tsx';
import { api, uploadFile } from './api.ts';
import { Button, Modal, Spinner, cx } from './ui.tsx';
import { Icon } from './icons.tsx';
import { fileSize } from './format.ts';
import { config } from './config.ts';
import { VaultPicker, isPdfDocument, type VaultDocument } from './VaultPicker.tsx';
import type { ReportReading } from './ReportReading.tsx';
import type { ReportDocument } from './ValuationReportField.tsx';

/** Where an imported report came from: a file from the computer, held until the valuation is saved, or a document in the vault. */
export type ImportSource = { kind: 'file'; file: File } | { kind: 'vault'; document: VaultDocument };

export interface ImportedReport {
  source: ImportSource;
  /** The report's name, as its file or the vault names it. */
  name: string;
  sizeBytes: number | null;
  detected: ReportReading;
}

/** The most the server takes, limits.uploadMb, checked here first so a large file is not sent only to be refused. */
const MAX_UPLOAD = Math.round(config.limits.uploadMb * 1024 * 1024);

/** A document in the vault in the shape the report opener takes. */
export const vaultReportDocument = (d: VaultDocument): ReportDocument => ({
  id: d.id, name: d.name, category: d.category, folder: d.folder, status: d.status ?? 'FINAL', fileName: d.fileName, mimeType: d.mimeType,
  sizeBytes: d.sizeBytes, visibility: d.visibility ?? 'ADMIN', hasBody: !!d.body, createdAt: d.createdAt,
});

/**
 * Files the imported report as a valuation's report, once the valuation is
 * saved: an uploaded file goes to the vault and onto the valuation together,
 * and a document from the vault is pointed to where it is.
 */
export async function fileImportedReport(companyId: string, valuationId: string, imported: ImportedReport): Promise<void> {
  if (imported.source.kind === 'file') await uploadFile(`/c/${companyId}/valuations/${valuationId}/report`, imported.source.file);
  else await api(`/c/${companyId}/valuations/${valuationId}/report`, { method: 'PUT', body: { documentId: imported.source.document.id } });
}

/**
 * Asks for the report, a PDF from the computer or from the vault, and has the
 * server read it. The dialog stays open while it is read, says what went wrong
 * when it cannot be, and hands what was read to `onRead`.
 */
export function ReportImportDialog({ open, onClose, onRead }: {
  open: boolean;
  onClose: () => void;
  onRead: (report: ImportedReport) => void;
}) {
  const { companyId } = useSession();
  const [reading, setReading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // A PDF dragged over the upload choice, which takes it as the file chooser would.
  const [dragging, setDragging] = useState(false);
  // Each reading has a number, so one the person walked away from is not handed on when it comes back.
  const attempt = useRef(0);

  const close = () => {
    attempt.current++;
    setReading(null);
    setProblem(null);
    onClose();
  };

  const read = async (source: ImportSource) => {
    const mine = ++attempt.current;
    const name = source.kind === 'file' ? source.file.name : source.document.name;
    setProblem(null);
    setReading(name);
    try {
      const { detected } = source.kind === 'file'
        ? await uploadFile<{ detected: ReportReading }>(`/c/${companyId}/valuations/report-reading`, source.file)
        : await api<{ detected: ReportReading }>(`/c/${companyId}/valuations/report-reading?documentId=${encodeURIComponent(source.document.id)}`, { method: 'POST' });
      if (mine !== attempt.current) return;
      setReading(null);
      onRead({ source, name, sizeBytes: source.kind === 'file' ? source.file.size : source.document.sizeBytes, detected });
    } catch (err) {
      if (mine !== attempt.current) return;
      setReading(null);
      setProblem((err as Error).message);
    }
  };

  /** Checked here first for what the server would refuse anyway, so the person is told at once rather than after sending a large file. */
  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { setProblem(`“${file.name}” is not a PDF.`); return; }
    if (file.size > MAX_UPLOAD) {
      setProblem(`That file is ${fileSize(file.size)}. The limit is ${config.limits.uploadMb} MB.`);
      return;
    }
    void read({ kind: 'file', file });
  };

  const option = 'flex w-full items-center gap-3 rounded-lg border border-ink-200 p-3.5 text-left transition-colors hover:bg-ink-50';

  return (
    <>
      {/* Said once and short: what happens (the form fills in), and that nothing is
          saved yet. Where the file goes is said on the choice it depends on. */}
      <Modal open={open} onClose={close} size="sm" title="Import a 409A report"
        description="The valuation form fills in from the PDF for you to check. Nothing is saved until you record it."
        footer={<Button variant="secondary" onClick={close}>Cancel</Button>}>
        {reading ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
            <Spinner className="size-6 text-brand-600" />
            <p className="max-w-full text-[13px] text-ink-700 [overflow-wrap:anywhere]">Reading <span className="font-medium text-ink-900">{reading}</span></p>
            <p className="text-[12px] text-ink-500">Usually a few seconds.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* The input stays in the tab order, visually hidden rather than removed, so
                the file chooser opens from the keyboard and the dialog has somewhere to put focus. */}
            <label className={cx(option, 'relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
              dragging && 'border-brand-400 bg-brand-50/60')}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files?.[0]); }}>
              <input type="file" className="sr-only" accept="application/pdf,.pdf"
                onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                <Icon name="download" className="size-5 rotate-180" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink-900">Upload a PDF</span>
                <span className="mt-0.5 block text-[12px] text-ink-500">Up to {config.limits.uploadMb} MB. Saved to the vault when you record.</span>
              </span>
            </label>
            <button type="button" className={option} onClick={() => setChoosing(true)}>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                <Icon name="folder" className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink-900">Choose from the vault</span>
                <span className="mt-0.5 block text-[12px] text-ink-500">It stays where it is. The valuation links to it.</span>
              </span>
            </button>
            {problem && (
              <p role="alert" className="flex items-start gap-1.5 pt-1 text-[13px] text-red-700">
                <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{problem}</span>
              </p>
            )}
          </div>
        )}
      </Modal>

      <VaultPicker open={choosing} onClose={() => setChoosing(false)} single only={isPdfDocument}
        purpose="The 409A report" preferCategory="VALUATION" pickLabel="Read it"
        description="Only PDFs are listed. The report stays where it is."
        onPick={([document]) => { setChoosing(false); if (document) void read({ kind: 'vault', document }); }} />
    </>
  );
}
