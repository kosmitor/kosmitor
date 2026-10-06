/**
 * The one document that defines a holding, read and changed from the line that
 * names it: the certificate behind an issuance of shares, the agreement behind
 * an equity award.
 *
 * That line used to be dead: it said a name or it said nothing, and the only way
 * to put a file there was to know that a document filed against the holding
 * under a particular category is what makes it the one. That is a rule about the
 * database, not something a person should have to learn, so the field itself is
 * the place to do it.
 *
 * Two ways in, because a company has paperwork in two states: the signed scan
 * that is still on someone's desktop, and the one already sitting in the vault
 * from an import or a bulk upload. The first is an upload, the second is a
 * filing, and the second one moves the document rather than copying it, which
 * the list says out loud rather than hiding the documents it would move.
 */
import { useState } from 'react';
import { useSession } from './session.tsx';
import { useQuery, api, uploadFile, downloadFile } from './api.ts';
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Loading,
  Modal, SearchInput, SegmentedControl, StatusBadge, useToast, cx,
} from './ui.tsx';
import { Icon } from './icons.tsx';
import { PdfViewer } from './PdfViewer.tsx';
import { dateTime, fileSize } from './format.ts';
import { config } from './config.ts';
import { categoryLabel, readableDocumentPath, documentFilename, downloadDocumentPath } from './documents.ts';

export interface HoldingDocument {
  id: string;
  name: string;
  category: string;
  folder: string | null;
  body: string | null;
  status: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  securityId: string | null;
  stakeholderId: string | null;
  visibility: string | null;
  createdAt: string;
  /** Present on the record pages, which attach each document's signature blocks. */
  signatures?: { status: string }[];
}

/**
 * What differs between one kind of defining document and another. Everything else,
 * the upload, the filing, the sharing rule and the signing lock, is the same.
 */
export interface HoldingDocumentKind {
  /** The category that makes a stored document this one, rather than any paper on file. */
  category: 'CERTIFICATE' | 'GRANT_AGREEMENT';
  /** Where an upload is filed in the vault. */
  folder: string;
  /** What the field and its dialog are called, in sentence case. */
  title: string;
  /** The thing itself, lower case, for use inside a sentence. */
  noun: string;
  /** The holding, as someone would refer to it in a sentence. */
  holding: string;
  /** The line the dialog opens with. */
  description: string;
}

export const CERTIFICATE_DOCUMENT: HoldingDocumentKind = {
  category: 'CERTIFICATE', folder: 'Certificates',
  title: 'Certificate document', noun: 'certificate', holding: 'these shares',
  description: 'Upload the signed certificate, or file one the company already holds against these shares.',
};

export const AWARD_AGREEMENT: HoldingDocumentKind = {
  category: 'GRANT_AGREEMENT', folder: 'Equity awards',
  title: 'Award agreement', noun: 'award agreement', holding: 'this award',
  description: 'Upload the signed award agreement, or file one the company already holds against this award.',
};

const describe = (d: HoldingDocument): string => [
  categoryLabel(d.category),
  d.folder,
  d.sizeBytes ? fileSize(d.sizeBytes) : null,
  `added ${dateTime(d.createdAt)}`,
].filter(Boolean).join(' · ');

type Mode = 'upload' | 'existing';

export function HoldingDocumentField({ kind, document: current, securityId, stakeholderId, stakeholderName, onChange }: {
  /** Which defining document this is: the current, or the award agreement. */
  kind: HoldingDocumentKind;
  /** The document that is the defining one today, or null when nothing is filed. */
  document: HoldingDocument | null;
  /** The holding the document is filed against. */
  securityId: string;
  /** The holder, so an upload can be published to them rather than kept from them. */
  stakeholderId: string | null;
  /** The holder's name, for saying plainly who will be able to read it. */
  stakeholderName: string | null;
  /** Called after anything changes, so the page can read itself again. */
  onChange: () => void;
}) {
  const { companyId, canEdit } = useSession();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reading, setReading] = useState(false);

  // The vault is only read once someone asks to choose from it: on a company with
  // years of paperwork that list is long, and most visits to this field are uploads.
  const listPath = open && mode === 'existing' && companyId ? `/c/${companyId}/documents` : null;
  const { data: vault, error: listError, loading: listLoading, reload: reloadList } =
    useQuery<HoldingDocument[]>(listPath, [listPath]);

  /**
   * What can be read on screen, decided the way the documents card decides it:
   * an uploaded PDF is served back as it arrived, a document the app wrote is
   * rendered on request, and anything else is a download rather than a page.
   */
  const readable = (d: HoldingDocument): string | null => readableDocumentPath(companyId!, d);

  const download = (d: HoldingDocument) =>
    downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));

  const close = () => {
    if (busy) return;
    setOpen(false);
    setFile(null);
    setPicked(null);
    setSearch('');
  };

  const finish = (message: string) => {
    toast(message);
    setBusy(false);
    setFile(null);
    setPicked(null);
    setSearch('');
    setOpen(false);
    onChange();
  };

  /**
   * Take the outgoing document off the holding once a replacement has landed.
   *
   * A holding has one defining document, and the dialog says the outgoing one
   * stays in the vault. Without this the holding would end up claiming two, and
   * which of them the page showed would come down to whichever was filed most
   * recently. It runs after the replacement, so a failure here leaves the new
   * document in place rather than leaving the holding with nothing.
   */
  const detachOutgoing = async (outgoing: string) => {
    await api(`/c/${companyId}/documents/${outgoing}`, { method: 'PATCH', body: { securityId: null } });
  };

  const upload = async () => {
    if (!file) return;
    const outgoing = current?.id ?? null;
    setBusy(true);
    try {
      // The category and the holding together are what make a stored file the
      // defining one, so both travel with the upload rather than being set after.
      await uploadFile(`/c/${companyId}/documents/upload`, file, {
        category: kind.category, folder: kind.folder,
        securityId, stakeholderId: stakeholderId ?? '', visibility: 'HOLDER',
      });
      if (outgoing) await detachOutgoing(outgoing);
      finish(outgoing ? `${kind.title} replaced` : `${kind.title} uploaded`);
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  const assign = async () => {
    if (!picked) return;
    const outgoing = current?.id ?? null;
    setBusy(true);
    try {
      await api(`/c/${companyId}/documents/${picked}`, {
        method: 'PATCH', body: { securityId, category: kind.category, ...sharing(pickedDoc) },
      });
      if (outgoing) await detachOutgoing(outgoing);
      finish(outgoing ? `${kind.title} replaced` : `${kind.title} assigned`);
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  const unfile = async () => {
    if (!current) return;
    setBusy(true);
    try {
      // Unfiled, not deleted: the company keeps the paperwork, the holding just
      // stops claiming it. Deleting would take it out of the vault as well.
      await api(`/c/${companyId}/documents/${current.id}`, { method: 'PATCH', body: { securityId: null } });
      setRemoving(false);
      finish(`${kind.title} removed`);
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  /**
   * Who can read a document once it is the holding's defining one.
   *
   * Uploading through this field publishes to the holder, and filing one from the
   * vault has to reach the same place or the same dialog would produce two
   * different answers. A document already published to everyone is left alone:
   * filing it is not a reason to take it away from people who can see it today.
   */
  const sharing = (d: HoldingDocument | null): Record<string, unknown> =>
    (!d || d.visibility === 'ALL' ? {} : { visibility: 'HOLDER', stakeholderId });

  /** True when assigning this one would show it to the holder for the first time. */
  const newlyShared = (d: HoldingDocument | null): boolean =>
    Boolean(d && stakeholderId && d.visibility !== 'ALL'
      && !(d.visibility === 'HOLDER' && d.stakeholderId === stakeholderId));

  const term = search.trim().toLowerCase();
  const candidates = (vault ?? [])
    // The one already on file is the thing being replaced, so offering it changes nothing.
    .filter((d) => d.id !== current?.id)
    .filter((d) => !term || d.name.toLowerCase().includes(term) || String(d.fileName ?? '').toLowerCase().includes(term));
  const pickedDoc = candidates.find((d) => d.id === picked) ?? null;

  const path = current ? readable(current) : null;
  // A document out for signature is not the finished article, and the field says so.
  // A final or executed one needs no badge: its name is the whole answer.
  const settled = current?.status === 'EXECUTED' || current?.status === 'FINAL';

  /**
   * A document out for signature cannot be swapped or taken off while it is out.
   * The signing flow finds it through the holding, so unfiling it midway would
   * leave the holder's signature block pointing at paper the holding no longer
   * claims, and the countersignature that issues the equity would have nothing to
   * act on. Once every block is signed it is an ordinary document again.
   */
  const outForSignature = (current?.signatures ?? []).some((s) => s.status === 'PENDING');

  const linkClass = 'shrink-0 cursor-pointer font-medium text-brand-600 hover:text-brand-700';

  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        {current ? (
          <>
            <span className="min-w-0 truncate">{current.name}</span>
            {!settled && <StatusBadge status={current.status} />}
            {path ? (
              <button type="button" className={linkClass} onClick={() => setReading(true)}>Read it</button>
            ) : current.fileName ? (
              <button type="button" className={linkClass} onClick={() => void download(current)}>Download it</button>
            ) : null}
          </>
        ) : 'None on file'}
        {canEdit && !outForSignature && (
          <button type="button" className={linkClass} onClick={() => { setMode('upload'); setOpen(true); }}>
            {current ? 'Change' : 'Add one'}
          </button>
        )}
        {canEdit && outForSignature && (
          <span className="shrink-0 text-[12px] text-ink-500" title="It can be changed once every party has signed.">
            Locked until signed
          </span>
        )}
      </span>

      <Modal open={open && !removing} onClose={close} size="md" title={kind.title}
        description={kind.description}
        footer={<>
          <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
          {mode === 'upload' ? (
            <Button variant="primary" loading={busy} disabled={!file} onClick={() => void upload()}>
              {current ? 'Replace it' : 'Upload'}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={!picked} onClick={() => void assign()}>Assign</Button>
          )}
        </>}>

        {current && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-ink-200 p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
              <Icon name="document" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink-900">{current.name}</p>
              <p className="mt-0.5 text-[11px] text-ink-500">On file now · {describe(current)}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>Remove</Button>
          </div>
        )}

        <SegmentedControl<Mode> value={mode} onChange={setMode} options={[
          { value: 'upload', label: 'Upload a file' },
          { value: 'existing', label: 'Choose one on file' },
        ]} />

        {mode === 'upload' ? (
          <div className="mt-4">
            <label className="cursor-pointer">
              <input type="file" className="hidden"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
              <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-ink-200 bg-white px-3.5 text-sm font-medium text-ink-800 shadow-sm hover:bg-ink-50">
                <Icon name="download" className="size-4 rotate-180" />
                {file ? 'Choose a different file' : 'Choose a file'}
              </span>
            </label>
            <p className="mt-2 text-[12px] text-ink-500">
              Up to {config.limits.uploadMb} MB. It is kept with {kind.holding} and the holder can see it.
            </p>
            {file && (
              <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-700">
                <Icon name="document" className="size-4 shrink-0 text-ink-400" />
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="shrink-0 tabular text-ink-500">{fileSize(file.size)}</span>
              </p>
            )}
            {current && (
              <p className="mt-3 text-[12px] text-ink-500">
                The document on file now stays in the vault. It is no longer the {kind.noun} for {kind.holding}.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search documents by name" />
            <div className="mt-3">
              {listLoading ? <Loading label="Loading documents" />
                : listError ? <ErrorNote error={listError} onRetry={reloadList} />
                  : candidates.length === 0 ? (
                    <EmptyState icon={<Icon name="document" className="size-8" />}
                      title={term ? 'No document matches that search' : 'There is nothing else on file'}
                      description={term
                        ? `Try part of the file name, or upload the ${kind.noun} instead.`
                        : `Nothing in the company vault can be filed here yet. Upload the ${kind.noun} instead.`} />
                  ) : (
                    <ul className="max-h-72 space-y-2 overflow-y-auto">
                      {candidates.map((d) => (
                        <li key={d.id}>
                          <button type="button" onClick={() => setPicked(d.id)}
                            className={cx('flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                              picked === d.id ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:bg-ink-50')}>
                            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-inset ring-ink-200">
                              <Icon name="document" className="size-5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-ink-900">{d.name}</span>
                              <span className="mt-0.5 block truncate text-[11px] text-ink-500">{describe(d)}</span>
                            </span>
                            {d.securityId === securityId
                              ? <Badge tone="info">Already with {kind.holding}</Badge>
                              : d.securityId ? <Badge tone="warning">Filed elsewhere</Badge> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
            </div>
            {pickedDoc?.securityId && pickedDoc.securityId !== securityId && (
              <p className="mt-3 text-[12px] text-ink-500">
                This document is filed against another holding. Assigning it here moves it off that one.
              </p>
            )}
            {newlyShared(pickedDoc) && (
              <p className="mt-2 text-[12px] text-ink-500">
                {stakeholderName ?? 'The holder'} will be able to read it, as with an upload.
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog open={removing} onClose={() => { if (!busy) setRemoving(false); }} loading={busy}
        title={`Remove the ${kind.title.toLowerCase()}`} confirmLabel="Remove"
        message={<>Take <strong>{current?.name}</strong> off {kind.holding}? It stays in the company vault and can be filed again later.</>}
        onConfirm={() => void unfile()} />

      <PdfViewer open={reading} onClose={() => setReading(false)} title={current?.name ?? kind.title}
        description={current ? describe(current) : undefined}
        path={reading ? path : null}
        filename={current ? documentFilename(current) : `${kind.noun}.pdf`} />
    </>
  );
}
