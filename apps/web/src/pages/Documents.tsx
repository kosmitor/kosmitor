import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, api, uploadFile, downloadFile, ApiError } from '../api.ts';
import { useSearchQuery } from '../hooks.ts';
import { FormModal, FormGrid } from '../crud.tsx';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, StatusBadge, Textarea, useToast, Modal, SearchInput, Checkbox, Avatar, ActionMenu,
} from '../ui.tsx';
import type { ActionItem } from '../pickers.tsx';
import { Icon } from '../icons.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { DocumentPreview } from '../PdfFrame.tsx';
import { date, dateTime, fileSize } from '../format.ts';
import { config } from '../config.ts';
import { DOCUMENT_CATEGORIES, categoryLabel, readableDocumentPath, isPdfDocument, downloadDocumentPath, documentFilename } from '../documents.ts';
import {
  DocumentTree, MoveToFolderDialog, NewFolderDialog, SelectionBar, useFolderExpansion, buildFolderTree, listFolders,
  folderPath, folderProblem, folderLabel, DEFAULT_FOLDER, NO_SELECTION, type TreeColumn,
} from '../DocumentTree.tsx';

const blank = {
  name: '', category: 'AGREEMENT', folder: DEFAULT_FOLDER, body: '',
  stakeholderId: '', requiresSignature: false, visibility: 'ADMIN', signerIds: [] as string[],
};

const FOLDER_HINT = 'Use / to put one folder inside another, such as Financing/Series A.';
const DRAG_HINT = 'Drag documents onto a folder to move them. Shift-click selects a range.';

// On a phone the tree keeps the name, a menu of actions and any signature
// waiting; the columns that describe a document come back as the screen widens.
const COLUMNS: TreeColumn[] = [
  { key: 'category', label: 'Category', className: 'hidden md:table-cell' },
  { key: 'related', label: 'Related to', className: 'hidden md:table-cell' },
  { key: 'signatures', label: 'Signatures', className: 'hidden md:table-cell' },
  { key: 'created', label: 'Created', className: 'hidden whitespace-nowrap sm:table-cell' },
  { key: 'status', label: 'Status', className: 'hidden sm:table-cell' },
  { key: 'actions', label: '', align: 'right', className: 'whitespace-nowrap' },
];
/** Shown while searching in place of folders made on the page, which hold nothing to match. */
const NO_FOLDERS: string[] = [];
/** The move dialog is closed. */
const NOTHING_TO_MOVE: never[] = [];

/** A move asked for: a document and the folder it should go to. */
type Move = { id: string; to: string };
/** A move as it was made, kept so it can be undone: where the document was and where it went. */
type Made = { id: string; name: string; from: string; to: string };

/** "Moved “Board consent” to Financing / Series A", or "Moved 3 documents back". */
function movedMessage(done: Made[], back: boolean): string {
  const what = done.length === 1 ? `“${done[0].name}”` : `${done.length} documents`;
  const into = new Set(done.map((d) => d.to));
  return `Moved ${what}${back ? ' back' : ''}${into.size === 1 ? ` to ${folderLabel(done[0].to)}` : ''}`;
}

export default function Documents() {
  const { companyId, canEdit, canViewAll, role } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any[]>(companyId ? `/c/${companyId}/documents` : null, [companyId]);
  // Only full-view roles may list stakeholders; portfolio-only roles see their own documents without it.
  const { data: stakeholders } = useQuery<any[]>(companyId && canViewAll ? `/c/${companyId}/stakeholders` : null, [companyId, canViewAll]);
  // A document can be filed against a holding as well as a person, and from this
  // side that was invisible: the column named the holder and said nothing about
  // the certificate or grant the paperwork actually belongs to. These four lists
  // are what turn a stored security_id back into something a reader recognises.
  const { data: issuances } = useQuery<any[]>(companyId && canViewAll ? `/c/${companyId}/issuances` : null, [companyId, canViewAll]);
  const { data: awards } = useQuery<any[]>(companyId && canViewAll ? `/c/${companyId}/awards` : null, [companyId, canViewAll]);
  const { data: convertibles } = useQuery<any[]>(companyId && canViewAll ? `/c/${companyId}/convertibles` : null, [companyId, canViewAll]);
  const { data: warrants } = useQuery<any[]>(companyId && canViewAll ? `/c/${companyId}/warrants` : null, [companyId, canViewAll]);
  const [search, setSearch] = useSearchQuery();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(blank);
  const [viewing, setViewing] = useState<any>(null);
  const [signing, setSigning] = useState<any>(null);
  const [signature, setSignature] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadMeta, setUploadMeta] = useState({ folder: DEFAULT_FOLDER, category: 'OTHER', stakeholderId: '', visibility: 'ADMIN' });
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<any>(null);
  /** What the move dialog is moving, and the selection it was opened for, if it was. */
  const [moving, setMoving] = useState<{ docs: any[]; selection: ReadonlySet<string> | null } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const folderListId = useId();

  const expansion = useFolderExpansion(companyId, search);
  /** The folder of the row last picked in the tree, where a new folder goes unless someone chooses otherwise. */
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  // Folders made with "New folder" that nothing has been moved into yet. They
  // are not stored anywhere, so they belong to this company's page only.
  const [madeFolders, setMadeFolders] = useState<string[]>([]);
  useEffect(() => { setMadeFolders([]); setActiveFolder(null); }, [companyId]);

  // Where documents were moved to on this page, laid over the list the server
  // last sent. Reloading the list would blank the page while it loads, so a move
  // shows at once and the next load (after an upload, say) brings the server's
  // own copy. A document whose move is still being saved keeps its place over a
  // fresh list, which may have been read before that move was written.
  const [moved, setMoved] = useState<ReadonlyMap<string, string>>(new Map());
  /**
   * Per document while a move of it is being saved: how many moves of it were
   * asked for, and the folder the server last said it is in.
   */
  const saving = useRef(new Map<string, { asked: number; saved: string }>());
  /** Moves are sent one request at a time, in the order they were asked for. */
  const line = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    setMoved((m) => (m.size === 0 ? m : new Map([...m].filter(([id]) => saving.current.has(id)))));
  }, [data]);

  const documents = useMemo(
    () => (data ?? []).map((d) => (moved.has(d.id) ? { ...d, folder: moved.get(d.id) } : d)),
    [data, moved]);
  // Where each document is on screen, for a move asked for after this render,
  // such as Undo pressed in a toast some seconds later.
  const onScreen = useRef(documents);
  useEffect(() => { onScreen.current = documents; }, [documents]);
  const searching = search.trim() !== '';
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? documents.filter((d) => d.name.toLowerCase().includes(q)) : documents;
  }, [documents, search]);
  const allFolders = useMemo(() => listFolders(buildFolderTree(documents, madeFolders)).map((f) => f.path), [documents, madeFolders]);

  // The documents selected in the tree, to move together. A selection only
  // ever holds documents on screen: one a search hides or that is deleted is
  // dropped, and does not come back when it shows again. While the list is
  // reloading nothing has gone, so nothing is dropped then.
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  useEffect(() => {
    if (!data) return;
    const ids = new Set(shown.map((d) => d.id));
    setSelected((s) => ([...s].every((id) => ids.has(id)) ? s : new Set([...s].filter((id) => ids.has(id)))));
  }, [data, shown]);
  const picked = useMemo(() => shown.filter((d) => selected.has(d.id)), [shown, selected]);
  const selectionBar = useRef<HTMLDivElement>(null);
  const treeArea = useRef<HTMLDivElement>(null);
  /**
   * Lets go of the selection. The bar goes with it, so focus that was on one of
   * its buttons comes back to the tree rather than being dropped at the top of
   * the page. `only` lets go of it only if it is still that selection.
   */
  const clearSelection = (only?: ReadonlySet<string>) => {
    const fromBar = !!selectionBar.current?.contains(document.activeElement);
    setSelected((s) => (only && s !== only ? s : NO_SELECTION));
    if (fromBar) {
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        treeArea.current?.querySelector<HTMLElement>('tbody tr[tabindex="0"]')?.focus();
      });
    }
  };

  const startUpload = (files: FileList | File[], folder?: string) => {
    const list = Array.from(files).filter((f) => f.size > 0);
    if (list.length === 0) return;
    if (folder) setUploadMeta((m) => ({ ...m, folder }));
    setUploadFiles(list);
    setUploading(true);
  };

  const runUpload = async () => {
    const problem = folderProblem(uploadMeta.folder);
    if (problem) { toast(problem, 'error'); return; }
    setBusy(true);
    setUploadProgress({ done: 0, total: uploadFiles.length });
    let failed = 0;
    for (const file of uploadFiles) {
      try {
        await uploadFile(`/c/${companyId}/documents/upload`, file, {
          folder: uploadMeta.folder || DEFAULT_FOLDER, category: uploadMeta.category,
          stakeholderId: uploadMeta.stakeholderId, visibility: uploadMeta.visibility,
        });
      } catch (err) {
        failed++;
        toast(`${file.name}: ${(err as Error).message}`, 'error');
      }
      setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    }
    setBusy(false);
    setUploadProgress(null);
    if (failed < uploadFiles.length) toast(`${uploadFiles.length - failed} file${uploadFiles.length - failed === 1 ? '' : 's'} uploaded`);
    setUploading(false);
    setUploadFiles([]);
    // Open the folder the files went into, so they can be seen once the list is back.
    expansion.reveal(folderPath(uploadMeta.folder));
    reload();
  };

  /**
   * Files documents under other folders, all in one request that moves every
   * one of them or none. The tree shows them there at once.
   *
   * Requests are sent one after another, so the server ends up with the last
   * folder asked for each document whatever order they would arrive in, and a
   * document moved again before its request's turn goes with the later move
   * instead. If a request is refused, each document in it goes back to the
   * folder the server last said it is in, not to one it was only dragged
   * through, and the reason is shown. Once moved, the toast offers to undo it.
   *
   * `selection` is the selection the documents were moved as, which is let go
   * of once they are moved. `back` is an Undo, which offers no Undo of its own.
   */
  const move = (wanted: Move[], { reveal = false, selection = null, back = false }:
    { reveal?: boolean; selection?: ReadonlySet<string> | null; back?: boolean } = {}) => {
    const now = new Map(onScreen.current.map((d) => [d.id, d]));
    const asked = wanted.flatMap(({ id, to }) => {
      const doc = now.get(id);
      // Where it is on screen now. With no move of it being saved, that is where the server has it.
      const from = doc ? folderPath(doc.folder) : to;
      if (!doc || from === to) return [];
      const entry = saving.current.get(id) ?? { asked: 0, saved: from };
      saving.current.set(id, entry);
      return [{ id, name: String(doc.name), from, to, entry, turn: ++entry.asked }];
    });
    if (asked.length === 0) return;
    type Asked = (typeof asked)[number];
    const latest = (a: Asked) => a.entry.asked === a.turn;
    const show = (list: Asked[], folder: (a: Asked) => string) =>
      setMoved((m) => { const next = new Map(m); for (const a of list) next.set(a.id, folder(a)); return next; });

    show(asked, (a) => a.to);
    // From the dialog, the folder they went to is opened, so they stay in view
    // and focus can return to the row a document was moved from.
    if (reveal) for (const to of new Set(asked.map((a) => a.to))) expansion.reveal(to);

    line.current = line.current.then(async () => {
      const sending = asked.filter(latest);
      if (sending.length > 0) {
        try {
          const reply = await api<{ id: string; folder: string | null }[]>(`/c/${companyId}/documents/move`, {
            body: { moves: sending.map((a) => ({ id: a.id, folder: a.to })) },
          });
          const confirmed = new Map(reply.map((d) => [d.id, folderPath(d.folder)]));
          for (const a of sending) a.entry.saved = confirmed.get(a.id) ?? a.to;
          const done = sending.filter(latest);
          show(done, (a) => a.entry.saved);
          if (selection) clearSelection(selection);
          if (done.length > 0) {
            const made: Made[] = done.map((a) => ({ id: a.id, name: a.name, from: a.from, to: a.entry.saved }));
            toast(movedMessage(made, back), 'success', back ? undefined : { label: 'Undo', onClick: () => undo(made) });
          }
        } catch (err) {
          show(sending.filter(latest), (a) => a.entry.saved);
          toast((err as Error).message, 'error');
          // One of them is gone (deleted in another tab, say), so the list is
          // fetched again: it disappears, and so does its place in the selection.
          if (err instanceof ApiError && err.status === 404) reload();
        }
      }
      // Once the last move asked for is answered, the next list from the server is its word again.
      for (const a of asked) if (latest(a)) saving.current.delete(a.id);
    });
  };

  /**
   * Sends each document back to the folder it was in before, in one request.
   * One moved again since stays where it was put last: Undo takes back this
   * move, not a later one.
   */
  const undo = (made: Made[]) => {
    const now = new Map(onScreen.current.map((d) => [d.id, folderPath(d.folder)]));
    const still = made.filter((m) => now.get(m.id) === m.to);
    if (still.length === 0) {
      toast(made.length === 1 ? 'It has been moved again since, so there is nothing to undo.' : 'They have been moved again since, so there is nothing to undo.', 'info');
      return;
    }
    move(still.map((m) => ({ id: m.id, to: m.from })), { back: true });
  };

  const download = (d: any) =>
    downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));

  // What to read on screen, decided the one way the whole app decides it.
  const readable = (d: any) => readableDocumentPath(companyId!, d);

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);

  /** What a holding is called, and where its record lives. */
  const holdingOf = useMemo(() => {
    const tail = (id: string) => String(id).slice(-6).toUpperCase();
    const found = new Map<string, { label: string; to: string }>();
    for (const i of issuances ?? []) found.set(i.id, { label: `Certificate ${i.certificateNo ?? tail(i.id)}`, to: `/certificates/${i.id}` });
    for (const a of awards ?? []) found.set(a.id, { label: `Grant ${a.label ?? tail(a.id)}`, to: `/grants/${a.id}` });
    for (const c of convertibles ?? []) found.set(c.id, { label: c.label ?? `${c.instrument === 'NOTE' ? 'Note' : 'SAFE'} ${tail(c.id)}`, to: `/convertibles/${c.id}` });
    for (const w of warrants ?? []) found.set(w.id, { label: `Warrant ${tail(w.id)}`, to: `/warrants/${w.id}` });
    return found;
  }, [issuances, awards, convertibles, warrants]);

  const create = async () => {
    const problem = folderProblem(form.folder);
    if (problem) { toast(problem, 'error'); return; }
    setBusy(true);
    try {
      await api(`/c/${companyId}/documents`, {
        body: {
          name: form.name, category: form.category, folder: form.folder || DEFAULT_FOLDER,
          body: form.body, stakeholderId: form.stakeholderId || null,
          requiresSignature: form.requiresSignature, visibility: form.visibility,
          signers: form.signerIds.map((id) => ({
            stakeholderId: id, name: nameOf.get(id) ?? 'Signer',
            email: (stakeholders ?? []).find((s) => s.id === id)?.email ?? null,
          })),
        },
      });
      toast('Document created');
      expansion.reveal(folderPath(form.folder));
      setCreating(false);
      setForm(blank);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const sign = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/signatures/${signing.id}/sign`, { body: { typedSignature: signature } });
      toast('Signed');
      setSigning(null);
      setSignature('');
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  if (loading) return <Loading label="Loading documents" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  const pendingCount = (data ?? []).reduce(
    (n, d) => n + (d.signatures ?? []).filter((s: any) => s.status === 'PENDING').length, 0);

  const renderName = (d: any) => (
    <>
      <span className="block font-medium">{d.name}</span>
      {d.fileName && (
        <span className="mt-0.5 block text-[11px] text-ink-500">
          {d.fileName}{d.sizeBytes ? ` · ${fileSize(d.sizeBytes)}` : ''}
        </span>
      )}
    </>
  );

  const actionsFor = (d: any) => {
    const mySig = (d.signatures ?? []).find((s: any) => s.status === 'PENDING');
    // Until the screen has room for every column and the buttons as well, every
    // action but signing is in one menu, so the document's name keeps the width.
    // Beside the sidebar on a laptop the buttons alone would leave it a few letters.
    const menu: ActionItem[] = [
      ...(readable(d) ? [{ label: 'Read', icon: 'eye', onClick: () => setReading(d) }] : []),
      ...(d.fileName && !isPdfDocument(d) ? [{ label: 'Download', icon: 'download', onClick: () => void download(d) }] : []),
      { label: 'Details', icon: 'document', onClick: () => setViewing(d) },
      ...(canEdit ? [
        { label: 'Move to folder', icon: 'folder', onClick: () => setMoving({ docs: [d], selection: null }) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => setConfirmDelete(d) },
      ] : []),
    ];
    return (
      <span className="flex items-center justify-end gap-1">
        <span className="hidden items-center gap-1 xl:flex">
          {readable(d) && (
            <Button size="sm" variant="ghost" onClick={() => setReading(d)} aria-label="Read the document" title="Read the document">
              <Icon name="eye" className="size-4" />
            </Button>
          )}
          {d.fileName && !isPdfDocument(d) && (
            <Button size="sm" variant="ghost" onClick={() => void download(d)} aria-label="Download">
              <Icon name="download" className="size-4" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setViewing(d)}>Details</Button>
        </span>
        {mySig && (
          <Button size="sm" variant="primary" onClick={() => { setSignature(''); setSigning(mySig); }}>Sign</Button>
        )}
        {canEdit && (
          <span className="hidden items-center gap-1 xl:flex">
            <Button size="sm" variant="ghost" onClick={() => setMoving({ docs: [d], selection: null })} aria-label="Move to folder" title="Move to folder">
              <Icon name="folder" className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(d)} aria-label="Delete">
              <Icon name="trash" className="size-4" />
            </Button>
          </span>
        )}
        <span className="xl:hidden"><ActionMenu items={menu} label={`Actions for ${d.name}`} /></span>
      </span>
    );
  };

  const renderCells = (d: any) => {
    const sigs = d.signatures ?? [];
    return [
      <Badge tone="neutral">{categoryLabel(d.category)}</Badge>,
      <span className="text-ink-600">
        {d.stakeholderId ? nameOf.get(d.stakeholderId) ?? '—' : !d.securityId ? '—' : null}
        {d.securityId && (
          holdingOf.get(d.securityId)
            ? <Link to={holdingOf.get(d.securityId)!.to} draggable={false} className="block text-[11px] text-brand-600 hover:text-brand-700">
                {holdingOf.get(d.securityId)!.label}
              </Link>
            : <span className="block text-[11px] text-ink-400">A holding</span>
        )}
      </span>,
      sigs.length === 0 ? <span className="text-ink-400">—</span> : (
        <span className="flex flex-wrap items-center gap-1">
          {sigs.map((s: any) => (
            <span key={s.id} title={`${s.signerName}: ${s.status.toLowerCase()}`}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                s.status === 'SIGNED' ? 'bg-secondary-50 text-secondary-800' : 'bg-amber-50 text-amber-700'}`}>
              {s.status === 'SIGNED' ? <Icon name="check" className="size-3" /> : <Icon name="clock" className="size-3" />}
              {s.signerName.split(' ')[0]}
            </span>
          ))}
        </span>
      ),
      <span className="text-ink-600">{date(d.createdAt?.slice(0, 10))}</span>,
      <StatusBadge status={d.status} />,
      actionsFor(d),
    ];
  };

  const filesOnly = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <>
      <PageHeader concept="documents" title="Documents"
        subtitle={`${(data ?? []).length} documents${pendingCount > 0 ? ` · ${pendingCount} awaiting signature` : ''}`}
        actions={canEdit && (
          <>
            <label className="cursor-pointer">
              <input type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) startUpload(e.target.files); e.target.value = ''; }} />
              <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-ink-200 bg-white px-3.5 text-sm font-medium text-ink-800 shadow-sm hover:bg-ink-50">
                <Icon name="download" className="size-4 rotate-180" /> Upload files
              </span>
            </label>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={() => { setForm(blank); setCreating(true); }}>New document</Button>
          </>
        )} />

      {canEdit && (
        // Only files from the computer: a document dragged within the tree is not an upload.
        // Its contents let the pointer through, so passing over the words is not leaving
        // it, and the highlight does not flicker off and on.
        <div
          onDragOver={(e) => { if (!filesOnly(e)) return; e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { if (!filesOnly(e)) return; e.preventDefault(); setDragging(false); startUpload(e.dataTransfer.files); }}
          className={`mb-5 flex items-center justify-center gap-3 rounded-xl border-2 border-dashed px-5 py-5 text-[13px] transition-colors [&_*]:pointer-events-none ${
            dragging ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 bg-white text-ink-500'}`}>
          <Icon name="inbox" className="size-5 shrink-0" />
          <span>Drop PDFs, agreements, board decks or any other files here to store them with the company{' '}
            <span className="text-ink-400">(up to {config.limits.uploadMb} MB each)</span></span>
        </div>
      )}

      {(data ?? []).length === 0 && madeFolders.length === 0 ? (
        <Card><EmptyState icon={<Icon name="document" className="size-10" />} title="No documents"
          description="Store financing agreements, grant notices, valuations and board materials here."
          action={canEdit && <Button variant="primary" onClick={() => setCreating(true)}>New document</Button>} /></Card>
      ) : (
        <Card padded={false}>
          <div ref={treeArea}>
            <DocumentTree label="Documents" documents={shown} extraFolders={searching ? NO_FOLDERS : madeFolders}
              expansion={expansion} canEdit={canEdit} columns={COLUMNS} renderName={renderName} renderCells={renderCells}
              selected={selected} onSelect={setSelected}
              onOpen={setViewing}
              onMove={(docs, folder, asSelection) => move(docs.map((d) => ({ id: d.id, to: folder })), { selection: asSelection ? selected : null })}
              onDropFiles={(files, folder) => startUpload(files, folder)}
              onActiveFolderChange={setActiveFolder}
              toolbar={
                // Selecting a document swaps the hint for the bar, and the rows below
                // must not move when it does, or the next click lands on another row.
                // So from a tablet up it is one row whatever is in it: the search box
                // gives way and the hint is cut short, rather than either wrapping.
                // On a phone the search box has a line to itself.
                <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
                  <div className="w-full sm:w-72 sm:min-w-40"><SearchInput value={search} onChange={setSearch} placeholder="Search documents" /></div>
                  {canEdit && (picked.length > 0 ? (
                    <>
                      {/* In the row New folder has on a phone, and no taller, so the rows below stay put. */}
                      <SelectionBar ref={selectionBar} count={picked.length}
                        onMove={() => setMoving({ docs: picked, selection: selected })} onClear={() => clearSelection()} />
                      <span className="hidden shrink-0 lg:ml-auto lg:block">
                        <Button icon={<Icon name="folderPlus" className="size-4" />} onClick={() => setCreatingFolder(true)}>New folder</Button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="hidden min-w-0 truncate text-[12px] text-ink-500 lg:block" title={DRAG_HINT}>{DRAG_HINT}</span>
                      <Button className="shrink-0 sm:ml-auto" icon={<Icon name="folderPlus" className="size-4" />} onClick={() => setCreatingFolder(true)}>New folder</Button>
                    </>
                  ))}
                </div>
              }
              empty={<EmptyState icon={<Icon name="search" className="size-10" />} title="No documents match"
                description="Try another name, or clear the search to see every folder." />} />
          </div>
        </Card>
      )}

      <datalist id={folderListId}>
        {allFolders.map((path) => <option key={path} value={path} />)}
      </datalist>

      <FormModal open={creating} onClose={() => setCreating(false)} busy={busy} size="lg"
        title="New document" onSubmit={create} submitLabel="Create document"
        description="Documents can be routed for signature. Signers see them in their holder portal.">
        <FormGrid>
          <Field label="Document name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Stock Option Grant Notice" required />
          </Field>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {DOCUMENT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Folder" hint={FOLDER_HINT} error={folderProblem(form.folder)}>
            <Input value={form.folder} list={folderListId} onChange={(e) => setForm({ ...form, folder: e.target.value })} placeholder="Series B" />
          </Field>
          <Field label="Related stakeholder">
            <Select value={form.stakeholderId} onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })}>
              <option value="">Not specific to one person</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Visibility">
            <Select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              <option value="ADMIN">Administrators only</option>
              <option value="ALL">Visible to the related stakeholder</option>
            </Select>
          </Field>
        </FormGrid>
        <Field label="Contents">
          <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={6}
            placeholder="Paste or write the document text." />
        </Field>
        <Checkbox label="Route for signature" checked={form.requiresSignature}
          onChange={(v) => setForm({ ...form, requiresSignature: v })} />
        {form.requiresSignature && (
          <Field label="Signers">
            <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg border border-ink-200 p-2.5">
              {(stakeholders ?? []).map((s) => (
                <Checkbox key={s.id} label={s.name} checked={form.signerIds.includes(s.id)}
                  onChange={(v) => setForm({
                    ...form,
                    signerIds: v ? [...form.signerIds, s.id] : form.signerIds.filter((x) => x !== s.id),
                  })} />
              ))}
            </div>
          </Field>
        )}
      </FormModal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.name ?? ''} size={viewing?.hasFace ? 'xl' : 'lg'}
        description={viewing ? `${categoryLabel(viewing.category)} · ${folderLabel(folderPath(viewing.folder))} · created ${dateTime(viewing.createdAt)}` : undefined}>
        {viewing && (
          <>
            {viewing.fileName && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-200 p-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon name="document" className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{viewing.fileName}</p>
                    <p className="text-[11px] text-ink-500">
                      {viewing.mimeType ?? 'file'}{viewing.sizeBytes ? ` · ${fileSize(viewing.sizeBytes)}` : ''}
                      {viewing.sha256 && <span className="font-mono"> · sha256 {String(viewing.sha256).slice(0, 12)}…</span>}
                    </p>
                  </div>
                </div>
                <span className="flex shrink-0 gap-2">
                  {isPdfDocument(viewing) && (
                    <Button size="sm" variant="primary" icon={<Icon name="eye" className="size-3.5" />} onClick={() => setReading(viewing)}>Read</Button>
                  )}
                  <Button size="sm" variant={isPdfDocument(viewing) ? 'secondary' : 'primary'} icon={<Icon name="download" className="size-3.5" />} onClick={() => void download(viewing)}>Download</Button>
                </span>
              </div>
            )}
            {viewing.hasFace ? (
              <DocumentPreview companyId={companyId!} document={viewing} />
            ) : (
              <div className="whitespace-pre-wrap rounded-lg bg-ink-50 p-4 text-[13px] leading-relaxed text-ink-800">
                {viewing.body || (viewing.fileName ? 'The contents are in the attached file.' : 'This document has no stored text.')}
              </div>
            )}
            {(viewing.signatures ?? []).length > 0 && (
              <div className="mt-5">
                <p className="mb-2.5 text-[13px] font-semibold text-ink-800">Signatures</p>
                <ul className="space-y-2">
                  {viewing.signatures.map((s: any) => (
                    <li key={s.id} className="flex items-center gap-3 rounded-lg border border-ink-200 p-3">
                      <Avatar name={s.signerName} size={30} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium">{s.signerName}</p>
                        <p className="text-[11px] text-ink-500">
                          {s.status === 'SIGNED'
                            ? `Signed ${dateTime(s.signedAt)}${s.ipAddress ? ` from ${s.ipAddress}` : ''}`
                            : 'Awaiting signature'}
                        </p>
                      </div>
                      {s.status === 'SIGNED'
                        ? <span className="shrink-0 font-[cursive] text-[15px] text-ink-700">{s.typedSignature}</span>
                        : <Badge tone="warning">Pending</Badge>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Modal>

      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? ''}
        description={reading ? `${categoryLabel(reading.category)} · created ${dateTime(reading.createdAt)}` : undefined}
        path={reading ? readable(reading) : null} filename={reading?.fileName ?? `${reading?.name ?? 'document'}.pdf`} />

      <FormModal open={uploading} onClose={() => { if (!busy) { setUploading(false); setUploadFiles([]); } }} busy={busy}
        title={`Upload ${uploadFiles.length} file${uploadFiles.length === 1 ? '' : 's'}`} onSubmit={runUpload}
        submitLabel={uploadProgress ? `Uploading ${uploadProgress.done} of ${uploadProgress.total}…` : 'Upload'}
        description="Files are stored with the company and can be attached to a stakeholder so they appear in that person's portal.">
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-ink-200 p-2.5">
          {uploadFiles.map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="flex min-w-0 items-center gap-2"><Icon name="document" className="size-4 shrink-0 text-ink-400" /><span className="truncate">{f.name}</span></span>
              <span className="shrink-0 tabular text-ink-500">{fileSize(f.size)}</span>
            </li>
          ))}
        </ul>
        <FormGrid>
          <Field label="Folder" hint={FOLDER_HINT} error={folderProblem(uploadMeta.folder)}>
            <Input value={uploadMeta.folder} list={folderListId} onChange={(e) => setUploadMeta({ ...uploadMeta, folder: e.target.value })} placeholder="Series B" />
          </Field>
          <Field label="Category">
            <Select value={uploadMeta.category} onChange={(e) => setUploadMeta({ ...uploadMeta, category: e.target.value })}>
              {DOCUMENT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Related stakeholder">
            <Select value={uploadMeta.stakeholderId} onChange={(e) => setUploadMeta({ ...uploadMeta, stakeholderId: e.target.value })}>
              <option value="">Not specific to one person</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Visibility">
            <Select value={uploadMeta.visibility} onChange={(e) => setUploadMeta({ ...uploadMeta, visibility: e.target.value })}>
              <option value="ADMIN">Administrators only</option>
              <option value="ALL">Visible to the related stakeholder</option>
            </Select>
          </Field>
        </FormGrid>
      </FormModal>

      <MoveToFolderDialog documents={moving?.docs ?? NOTHING_TO_MOVE} folders={allFolders} onClose={() => setMoving(null)}
        onMove={(folder) => {
          if (!moving) return;
          setMoving(null);
          move(moving.docs.map((d) => ({ id: d.id, to: folder })), { reveal: true, selection: moving.selection });
        }} />

      <NewFolderDialog open={creatingFolder} folders={allFolders} inside={activeFolder}
        onClose={() => setCreatingFolder(false)}
        onCreate={(path) => {
          setMadeFolders((made) => (made.includes(path) ? made : [...made, path]));
          expansion.reveal(path);
          setCreatingFolder(false);
          toast(`Folder ${folderLabel(path)} created`);
        }} />

      <FormModal open={!!signing} onClose={() => setSigning(null)} busy={busy}
        title="Sign document" onSubmit={sign} submitLabel="Sign"
        description={config.legal.esignConsent}>
        <Field label="Type your full name" required>
          <Input value={signature} onChange={(e) => setSignature(e.target.value)}
            placeholder={signing?.signerName} className="font-[cursive] text-lg" required />
        </Field>
        <p className="text-[12px] leading-relaxed text-ink-500">
          {config.legal.esignAgreement}
        </p>
      </FormModal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={busy}
        title="Delete document" confirmLabel="Delete"
        message={<>Delete <strong>{confirmDelete?.name}</strong>? Signatures recorded against it are deleted too.</>}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api(`/c/${companyId}/documents/${confirmDelete.id}`, { method: 'DELETE' });
            toast('Document deleted'); setConfirmDelete(null); reload();
          } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
        }} />
      {role === 'VIEWER' && null}
    </>
  );
}
