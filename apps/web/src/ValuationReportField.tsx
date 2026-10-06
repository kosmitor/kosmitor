/**
 * The report behind a valuation, read and changed from the line that names it.
 *
 * A 409A is only as good as the appraisal it came from, and the record page used
 * to say "No link on file" with no way to add one. Three ways in, because the
 * report turns up in three states: a PDF on someone's desktop, a document already
 * in the vault from an import or a bulk upload, or a page on the appraiser's own
 * portal. The first two make it a document in the vault, the third a link. It is
 * one or the other, so the page always has a single answer to "where is it".
 */
import { useState } from 'react';
import { useSession } from './session.tsx';
import { useQuery, api, uploadFile, downloadFile } from './api.ts';
import {
  Button, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, SearchInput, SegmentedControl, useToast, cx,
} from './ui.tsx';
import { Icon } from './icons.tsx';
import { PdfViewer } from './PdfViewer.tsx';
import { dateTime } from './format.ts';
import { config } from './config.ts';
import { categoryLabel, readableDocumentPath, documentFilename, downloadDocumentPath, documentAccess } from './documents.ts';

/** The report document as the server describes it: enough to name it and decide how it opens. */
export interface ReportDocument {
  id: string;
  name: string;
  category: string;
  folder: string | null;
  status: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | string | null;
  visibility: string;
  hasBody: boolean;
  createdAt: string;
  /** A report is on file, but the vault keeps it from this reader, so nothing else about it is sent. */
  restricted?: boolean;
}

export interface ValuationReport { document: ReportDocument | null; url: string | null }

interface VaultDocument {
  id: string; name: string; category: string; folder: string | null; fileName: string | null; mimeType: string | null;
  body: string | null; sizeBytes: number | null; createdAt: string;
}

const fileSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

const describe = (d: { category: string; folder: string | null; sizeBytes: number | string | null; createdAt: string }): string => [
  categoryLabel(d.category), d.folder, d.sizeBytes ? fileSize(Number(d.sizeBytes)) : null, `added ${dateTime(d.createdAt)}`,
].filter(Boolean).join(' · ');

/** Only a web address opens from here, whatever was stored before links were checked. */
export const openableLink = (url: string | null | undefined): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };

/**
 * How a report document is opened, for whoever is looking. The documents a
 * company files are kept from viewers unless they are shared with everyone, so
 * a viewer sees the report's name without a button that would be refused.
 */
export function useReportOpener() {
  const { companyId, role } = useSession();
  const toast = useToast();
  const [reading, setReading] = useState<ReportDocument | null>(null);

  // The server says whether a written document has a body rather than sending it,
  // and whether there is one is all these look at.
  const asReadable = (d: ReportDocument) => ({ id: d.id, name: d.name, fileName: d.fileName, mimeType: d.mimeType, body: d.hasBody ? 'yes' : null });
  const readable = (d: ReportDocument): string | null => readableDocumentPath(companyId!, asReadable(d));
  /** Whether this reader can open it, and whether there is anything to open. */
  const canOpen = (d: ReportDocument): boolean => !d.restricted
    && (['ADMIN', 'LEGAL', 'BOARD'].includes(role) || d.visibility === 'ALL')
    && documentAccess(companyId!, asReadable(d)) !== 'none';
  const open = (d: ReportDocument) => {
    if (readable(d)) { setReading(d); return; }
    void downloadFile(downloadDocumentPath(companyId!, { id: d.id, name: d.name, fileName: d.fileName }), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));
  };

  const viewer = (
    <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Report'}
      description={reading ? describe(reading) : undefined}
      path={reading ? readable(reading) : null}
      filename={reading ? documentFilename(reading) : 'report.pdf'} />
  );
  return { open, canOpen, readable, viewer };
}

type Mode = 'upload' | 'existing' | 'link';

export function ValuationReportField({ valuationId, report, onChange }: {
  valuationId: string;
  report: ValuationReport;
  /** Called after anything changes, so the page can read itself again. */
  onChange: () => void;
}) {
  const { companyId, canEdit, isSample } = useSession();
  const toast = useToast();
  const opener = useReportOpener();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  // The vault is only read once someone asks to choose from it.
  const listPath = open && mode === 'existing' && companyId ? `/c/${companyId}/documents` : null;
  const { data: vault, error: listError, loading: listLoading, reload: reloadList } = useQuery<VaultDocument[]>(listPath, [listPath]);

  const current = report.document?.restricted ? null : report.document;
  const restricted = !!report.document?.restricted;
  const currentLink = openableLink(report.url);
  const hasReport = !!report.document || !!report.url;
  const editable = canEdit && !isSample;

  const start = () => {
    // A link opens on the link, so it can be corrected; anything else opens on an upload, the usual way a report arrives.
    setMode(!current && report.url ? 'link' : 'upload');
    setLink(report.url ?? '');
    setOpen(true);
  };
  const reset = () => { setFile(null); setPicked(null); setSearch(''); setLink(''); };
  const close = () => { if (busy) return; setOpen(false); reset(); };

  const save = async (body: { documentId?: string; url?: string } | Record<string, never>, message: string) => {
    await api(`/c/${companyId}/valuations/${valuationId}/report`, { method: 'PUT', body });
    toast(message);
    setOpen(false);
    setRemoving(false);
    reset();
    onChange();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const upload = () => run(async () => {
    if (!file) return;
    // Filed under valuations, so it is also listed with the company's other valuation paperwork.
    const doc = await uploadFile<{ id: string }>(`/c/${companyId}/documents/upload`, file, { category: 'VALUATION', folder: 'Valuations' });
    await save({ documentId: doc.id }, hasReport ? 'Report replaced' : 'Report uploaded');
  });
  const assign = () => run(async () => {
    if (!picked) return;
    await save({ documentId: picked }, hasReport ? 'Report replaced' : 'Report linked');
  });
  const saveLink = () => run(async () => {
    await save({ url: link.trim() }, hasReport ? 'Report link updated' : 'Report link saved');
  });
  const remove = () => run(() => save({}, 'Report removed'));

  const linkProblem = link.trim() && !/^https?:\/\/\S+\.\S+/i.test(link.trim()) ? 'Enter the full address, starting with https://.' : null;

  const term = search.trim().toLowerCase();
  const candidates = (vault ?? [])
    .filter((d) => d.id !== report.document?.id)
    // A record with no file and no text has nothing anyone could open as a report.
    .filter((d) => d.fileName || d.body)
    .filter((d) => !term || d.name.toLowerCase().includes(term) || String(d.fileName ?? '').toLowerCase().includes(term))
    // Valuation paperwork first, since that is almost always where the report is.
    .sort((a, b) => Number(b.category === 'VALUATION') - Number(a.category === 'VALUATION'));

  const linkClass = 'shrink-0 cursor-pointer font-medium text-brand-600 hover:text-brand-700';

  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {restricted ? (
          <span className="text-ink-700">On file. Administrators, legal and the board can open it.</span>
        ) : current ? (
          <>
            <span className="min-w-0 truncate" title={current.name}>{current.name}</span>
            {opener.canOpen(current) ? (
              <button type="button" className={linkClass} onClick={() => opener.open(current)}>
                {opener.readable(current) ? 'Read it' : 'Download it'}
              </button>
            ) : documentAccess(companyId!, { id: current.id, name: current.name, fileName: current.fileName, body: current.hasBody ? 'yes' : null }) === 'none' ? (
              <span className="text-[12px] text-ink-500">It has no file or text to open</span>
            ) : (
              <span className="text-[12px] text-ink-500">Administrators, legal and the board can open it</span>
            )}
          </>
        ) : report.url ? (
          currentLink ? (
            <a href={currentLink} target="_blank" rel="noreferrer noopener" className={cx(linkClass, 'inline-flex items-center gap-1')}>
              Open the report on {hostOf(currentLink)} <Icon name="external" className="size-3.5" />
            </a>
          ) : <span className="text-ink-600">A link that is not a web address is on file</span>
        ) : 'No report on file'}
        {editable && (
          <button type="button" className={linkClass} onClick={start}>{hasReport ? 'Change' : 'Add one'}</button>
        )}
      </span>

      <Modal open={open && !removing} onClose={close} size="md" title="Valuation report"
        description="Upload the appraiser's report, choose one already in the vault, or link to where the appraiser keeps it."
        footer={<>
          <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
          {mode === 'upload' ? (
            <Button variant="primary" loading={busy} disabled={!file} onClick={() => void upload()}>{hasReport ? 'Replace it' : 'Upload'}</Button>
          ) : mode === 'existing' ? (
            <Button variant="primary" loading={busy} disabled={!picked} onClick={() => void assign()}>Link it</Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={!link.trim() || !!linkProblem} onClick={() => void saveLink()}>Save the link</Button>
          )}
        </>}>

        {hasReport && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-ink-200 p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
              <Icon name={current ? 'document' : 'external'} className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink-900">{current ? current.name : report.url ? hostOf(report.url) : 'A document on file'}</p>
              <p className="mt-0.5 truncate text-[11px] text-ink-500">On file now · {current ? describe(current) : report.url ?? 'kept from your view by the vault'}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>Remove</Button>
          </div>
        )}

        <SegmentedControl<Mode> value={mode} onChange={setMode} options={[
          { value: 'upload', label: 'Upload a file' },
          { value: 'existing', label: 'Choose one on file' },
          { value: 'link', label: 'Paste a link' },
        ]} />

        {mode === 'upload' && (
          <div className="mt-4">
            {/* The input stays in the tab order, visually hidden rather than removed, so
                the file chooser opens from the keyboard and the dialog has somewhere to put focus. */}
            <label className="cursor-pointer">
              <input type="file" className="peer sr-only" accept="application/pdf,.pdf,.doc,.docx,.xlsx"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
              <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-ink-200 bg-white px-3.5 text-sm font-medium text-ink-800 shadow-sm hover:bg-ink-50 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500">
                <Icon name="download" className="size-4 rotate-180" />
                {file ? 'Choose a different file' : 'Choose a file'}
              </span>
            </label>
            <p className="mt-2 text-[12px] text-ink-500">
              Up to {config.limits.uploadMb} MB, usually the PDF the appraiser sent. It is filed in the vault under valuations, where administrators,
              legal and the board can read it.
            </p>
            {file && (
              <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-700">
                <Icon name="document" className="size-4 shrink-0 text-ink-400" />
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="shrink-0 tabular text-ink-500">{fileSize(file.size)}</span>
              </p>
            )}
          </div>
        )}

        {mode === 'existing' && (
          <div className="mt-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search documents by name" />
            <div className="mt-3">
              {listLoading ? <Loading label="Loading documents" />
                : listError ? <ErrorNote error={listError} onRetry={reloadList} />
                  : candidates.length === 0 ? (
                    <EmptyState icon={<Icon name="document" className="size-8" />}
                      title={term ? 'No document matches that search' : 'There is nothing else on file'}
                      description={term ? 'Try part of the file name, or upload the report instead.' : 'Upload the report instead, or paste a link to it.'} />
                  ) : (
                    <ul className="max-h-72 space-y-2 overflow-y-auto">
                      {candidates.map((d) => (
                        <li key={d.id}>
                          <button type="button" onClick={() => setPicked(d.id)} aria-pressed={picked === d.id}
                            className={cx('flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                              picked === d.id ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:bg-ink-50')}>
                            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-inset ring-ink-200">
                              <Icon name="document" className="size-5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-ink-900">{d.name}</span>
                              <span className="mt-0.5 block truncate text-[11px] text-ink-500">{describe(d)}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
            </div>
            <p className="mt-3 text-[12px] text-ink-500">The document stays where it is in the vault. The valuation points to it.</p>
          </div>
        )}

        {mode === 'link' && (
          <div className="mt-4">
            <Field label="Link to the report" error={linkProblem}
              hint="Where the appraiser keeps it, such as their client portal or a shared folder.">
              <Input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={removing} onClose={() => { if (!busy) setRemoving(false); }} loading={busy}
        title="Remove the report" confirmLabel="Remove"
        message={current
          ? <>Stop linking <strong>{current.name}</strong> to this valuation? The document stays in the vault.</>
          : 'Stop linking this valuation to the report? Nothing is deleted.'}
        onConfirm={() => void remove()} />

      {opener.viewer}
    </>
  );
}
