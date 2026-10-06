/**
 * The paperwork filed against one instrument, or against one compliance subject.
 *
 * A share certificate, an option grant, a SAFE and a warrant all collect the
 * same kind of documents: the signed agreement, a board consent, an 83(b)
 * filing, a side letter. The documents page can store any of them, but it has
 * no way to say which holding a file belongs to, so the answer to "what is on
 * file for this grant?" lived in someone's head. One endpoint serves all four
 * kinds, so one card serves all four screens.
 *
 * Compliance adds a second kind of anchor. The $100,000 limit and the Rule 701
 * headroom are worked out from the cap table each time they are asked for, so
 * there is no row to hang a file on. Those file against a named subject and a
 * reference instead, through a second endpoint with the same document shape.
 * The list, the drop zone and everything below them do not care which of the
 * two it is, so the anchor is resolved once at the top and nothing else changes.
 */
import { useState } from 'react';
import { useSession } from './session.tsx';
import { useQuery, api, uploadFile, downloadFile } from './api.ts';
import { FormModal, FormGrid } from './crud.tsx';
import {
  Card, CardHeader, Badge, Button, Field, Input, Select, EmptyState,
  ConfirmDialog, Loading, ErrorNote, useToast, cx,
} from './ui.tsx';
import { Icon } from './icons.tsx';
import { PdfViewer } from './PdfViewer.tsx';
import { dateTime, fileSize } from './format.ts';
import { config } from './config.ts';
import { DOCUMENT_CATEGORIES, categoryLabel, readableDocumentPath, documentFilename, downloadDocumentPath } from './documents.ts';

interface SecurityDocument {
  id: string;
  name: string;
  category: string;
  folder: string | null;
  body: string | null;
  status: string;
  visibility: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  stakeholderId: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** A compliance area that is calculated rather than stored, and which instance of it. */
export interface DocumentSubject {
  kind: 'ISO_100K' | 'RULE_701' | 'ELECTION_83B' | 'FORM_3921' | 'BOI';
  /**
   * Whatever identifies one instance of that subject to a person: a holder and a
   * year, a period, a filing. The server matches it exactly, so a caller has to
   * build it the same way every time or the files stop coming back.
   */
  ref: string;
}

/** Exactly one anchor: an instrument that exists, or a subject that is worked out. */
type Anchor =
  | { securityId: string; subject?: never }
  | { securityId?: never; subject: DocumentSubject };

/** Who each stored visibility lets in, in the words the upload form uses. */
const VISIBILITY: Record<string, { label: string; tone: 'neutral' | 'info' | 'brand' }> = {
  ADMIN: { label: 'Administrators only', tone: 'neutral' },
  HOLDER: { label: 'The holder', tone: 'info' },
  ALL: { label: 'Everyone in the company', tone: 'brand' },
};

export function SecurityDocuments({ securityId, subject, stakeholderId, title = 'Documents', description, framed = true, className }: Anchor & {
  /** The holder of the instrument, or the person a compliance subject is about. Without one the server cannot publish a file to that person. */
  stakeholderId?: string | null;
  title?: string;
  description?: string;
  /** False inside a dialog, which is already a frame: a second border around the list adds nothing. */
  framed?: boolean;
  className?: string;
}) {
  const { companyId, canEdit } = useSession();
  const toast = useToast();

  // The anchor decides both where the list is read from and where an upload is
  // filed, so the two are derived together and cannot drift apart.
  const path = !companyId ? null
    : subject ? `/c/${companyId}/compliance-documents?kind=${subject.kind}&ref=${encodeURIComponent(subject.ref)}`
      : securityId ? `/c/${companyId}/securities/${securityId}/documents`
        : null;
  const anchorParams: Record<string, string> = subject
    ? { subjectKind: subject.kind, subjectRef: subject.ref }
    : { securityId: securityId ?? '' };

  const { data, error, errorStatus, loading, reload } = useQuery<{ kind: string; documents: SecurityDocument[] }>(path, [path]);

  const [files, setFiles] = useState<File[]>([]);
  const [meta, setMeta] = useState({ folder: 'General', category: 'AGREEMENT', visibility: 'ADMIN' });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<SecurityDocument | null>(null);
  const [deleting, setDeleting] = useState<SecurityDocument | null>(null);

  const documents = data?.documents ?? [];

  // A calculation has no certificate number to call it by, so the sentences that
  // name what a file is kept with say "record" where an instrument says so itself.
  const thing = subject ? 'record' : 'instrument';

  const startUpload = (picked: FileList | File[]) => {
    const list = Array.from(picked).filter((f) => f.size > 0);
    if (list.length === 0) return;
    setFiles(list);
  };

  const runUpload = async () => {
    setBusy(true);
    setProgress({ done: 0, total: files.length });
    let failed = 0;
    for (const file of files) {
      try {
        await uploadFile(`/c/${companyId}/documents/upload`, file, {
          folder: meta.folder || 'General', category: meta.category,
          ...anchorParams, stakeholderId: stakeholderId ?? '', visibility: meta.visibility,
        });
      } catch (err) {
        failed++;
        toast(`${file.name}: ${(err as Error).message}`, 'error');
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    }
    setBusy(false);
    setProgress(null);
    const stored = files.length - failed;
    if (stored > 0) toast(`${stored} file${stored === 1 ? '' : 's'} uploaded`);
    setFiles([]);
    reload();
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/c/${companyId}/documents/${deleting.id}`, { method: 'DELETE' });
      toast('Document deleted');
      setDeleting(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const download = (d: SecurityDocument) =>
    downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));

  // What can be read on screen, decided the one way the whole app decides it.
  const readable = (d: SecurityDocument): string | null => readableDocumentPath(companyId!, d);

  // Nothing can be filed against an instrument the server will not admit to, so the
  // ways in are hidden rather than left to fail on upload.
  const missing = errorStatus === 404;

  const picker = canEdit && !missing && (
    <label className="cursor-pointer">
      <input type="file" multiple className="hidden"
        onChange={(e) => { if (e.target.files) startUpload(e.target.files); e.target.value = ''; }} />
      <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2.5 text-[13px] font-medium text-ink-800 shadow-sm hover:bg-ink-50">
        <Icon name="download" className="size-4 rotate-180" /> Attach files
      </span>
    </label>
  );

  const body = (
    <>
      {canEdit && !missing && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); startUpload(e.dataTransfer.files); }}
          className={cx('mb-4 flex items-center justify-center gap-3 rounded-xl border-2 border-dashed px-5 py-4 text-center text-[13px] transition-colors',
            dragging ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 bg-white text-ink-500')}>
          <Icon name="inbox" className="size-5 shrink-0" />
          <span>{subject
            ? <>Drop the working papers, a filing receipt, an adviser's memo or any other file here to keep it with this record </>
            : <>Drop the signed agreement, a board consent, an 83(b) filing or any other file here to keep it with this instrument </>}
            <span className="text-ink-400">(up to {config.limits.uploadMb} MB each)</span></span>
        </div>
      )}

      {loading ? <Loading label="Loading documents" />
        : error ? (
          // A holder who reaches an instrument that is not theirs is told it is not
          // there, because that is what the server says rather than admitting it exists.
          missing
            ? <EmptyState icon={<Icon name="document" className="size-8" />} title="That instrument is not here"
                description="It may have been deleted, or it belongs to another holder." />
            : <ErrorNote error={error} onRetry={reload} />
        ) : documents.length === 0 ? (
          <EmptyState icon={<Icon name="document" className="size-8" />} title="Nothing is filed against this yet"
            description={subject
              ? 'Attach the working papers, a filing receipt or an adviser’s memo so the evidence sits with the finding it supports.'
              : 'Attach the signed agreement, a board consent, an 83(b) filing or a side letter so it sits with the holding it belongs to.'} />
        ) : (
          <ul className="space-y-2">
            {documents.map((d) => {
              const path = readable(d);
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-200 p-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon name="document" className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink-900">{d.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {[
                        categoryLabel(d.category),
                        d.folder,
                        d.sizeBytes ? fileSize(d.sizeBytes) : null,
                        `added${d.createdBy ? ` by ${d.createdBy}` : ''} ${dateTime(d.createdAt)}`,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Badge tone={VISIBILITY[d.visibility]?.tone ?? 'neutral'}>
                    {VISIBILITY[d.visibility]?.label ?? d.visibility}
                  </Badge>
                  <span className="flex shrink-0 items-center gap-1">
                    {path && (
                      <Button size="sm" variant="ghost" onClick={() => setReading(d)} aria-label="Read the document" title="Read the document">
                        <Icon name="eye" className="size-4" />
                      </Button>
                    )}
                    {d.fileName && (
                      <Button size="sm" variant="ghost" onClick={() => void download(d)} aria-label="Download" title="Download">
                        <Icon name="download" className="size-4" />
                      </Button>
                    )}
                    {canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(d)} aria-label="Delete" title="Delete">
                        <Icon name="trash" className="size-4" />
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

      <FormModal open={files.length > 0} onClose={() => { if (!busy) setFiles([]); }} busy={busy}
        title={`Attach ${files.length} file${files.length === 1 ? '' : 's'}`} onSubmit={runUpload}
        submitLabel={progress ? `Uploading ${progress.done} of ${progress.total}…` : 'Upload'}
        description={`Files are filed against this ${thing} and stay with it wherever it is shown.`}>
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-ink-200 p-2.5">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="document" className="size-4 shrink-0 text-ink-400" /><span className="truncate">{f.name}</span>
              </span>
              <span className="shrink-0 tabular text-ink-500">{fileSize(f.size)}</span>
            </li>
          ))}
        </ul>
        <FormGrid>
          <Field label="Folder">
            <Input value={meta.folder} onChange={(e) => setMeta({ ...meta, folder: e.target.value })} placeholder="Series B" />
          </Field>
          <Field label="Category">
            <Select value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })}>
              {DOCUMENT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Who can see it" className="sm:col-span-2"
            hint={stakeholderId ? undefined : `This ${thing} has no holder on file, so only administrators can be given access.`}>
            <Select value={meta.visibility} onChange={(e) => setMeta({ ...meta, visibility: e.target.value })}>
              <option value="ADMIN">Administrators only</option>
              <option value="HOLDER" disabled={!stakeholderId}>The holder</option>
              <option value="ALL">Everyone in the company</option>
            </Select>
          </Field>
        </FormGrid>
      </FormModal>

      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        description={reading ? `${categoryLabel(reading.category)} · added ${dateTime(reading.createdAt)}` : undefined}
        path={reading ? readable(reading) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy}
        title="Delete document" confirmLabel="Delete"
        message={<>Delete <strong>{deleting?.name}</strong>? It is removed from the document vault as well as from this {thing}.</>}
        onConfirm={() => void remove()} />
    </>
  );

  if (!framed) {
    return (
      <>
        {picker && <div className="mb-4 flex justify-end">{picker}</div>}
        {body}
      </>
    );
  }

  return (
    <Card className={className}>
      <CardHeader title={title} subtitle={description} action={picker} />
      {body}
    </Card>
  );
}
