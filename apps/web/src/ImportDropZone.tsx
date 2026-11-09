import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useSession } from './session.tsx';
import { downloadFile } from './api.ts';
import { stashImportFiles, isPdf, IMPORT_ACCEPT } from './importHandoff.ts';
import { Icon } from './icons.tsx';
import { Button, Spinner, cx, useToast } from './ui.tsx';
import { useAnchored, useOutsideClose } from './pickers.tsx';
import { useMediaQuery } from './hooks.ts';
import { SavePdfDialog } from './SavePdfDialog.tsx';
import { useSavedDocuments, savedDocumentId } from './SavedDocuments.tsx';
import { fromDrop, fromInput, rememberDir, type Picked } from './folderImport.ts';

/** A file that could not be read, with the reason in plain words. */
export interface FileProblem { file: string; message: string }

/**
 * The one drop zone every import starts from: the import page, and the cap
 * table's empty state. It takes several files at once, by dropping them or
 * choosing them; the file field is hidden from sight but not from the
 * keyboard (Tab reaches it, the zone shows the focus, Enter opens the picker).
 *
 * On the import page it hands the files to `onFiles`. Anywhere else it keeps
 * them in memory and opens the import page's check screen, which reads them;
 * a PDF on its own opens "Save this PDF as a document" right where it was
 * dropped. A file that cannot be read is shown inside the zone, which turns
 * red and takes focus, so the reason is where the person is looking.
 */
export function ImportDropZone({ onFiles, kind = null, compact = false, busy = null, problems = [], keepable = [], onKeep }: {
  onFiles?: (files: File[]) => void;
  /** The ?kind= of the page it is on: a hint for detection, and where Done leads back to. */
  kind?: string | null;
  compact?: boolean;
  /** While files are read: "Reading cap-table.xlsx…". */
  busy?: string | null;
  problems?: FileProblem[];
  /** Files that could not be read, and what to do with them: keep them as documents, as they are. */
  keepable?: File[];
  onKeep?: (files: File[]) => void;
}) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pdfs, setPdfs] = useState<File[]>([]);
  // A phone or tablet has nothing to drop from, so the zone says only what a tap does.
  const touch = useMediaQuery('(pointer: coarse)');

  useEffect(() => { if (problems.length) alert.current?.focus(); }, [problems]);

  const toast = useToast();
  const saved = useSavedDocuments({
    onFiles: (files) => receive(files),
    accepts: (name) => IMPORT_ACCEPT.split(',').some((a) => a.startsWith('.') && name.toLowerCase().endsWith(a)),
    purpose: 'An import', description: 'Spreadsheets, CSV and XML files saved in Documents. They stay where they are.',
  });
  const folderInput = useRef<HTMLInputElement>(null);

  /**
   * Files from folders: only the kinds an import reads are kept, found at any
   * depth. Two files with the same name in different subfolders keep their
   * folder in the name, so neither replaces the other.
   */
  const fromFolders = (picked: Picked[]): File[] => {
    const ext = IMPORT_ACCEPT.split(',').filter((a) => a.startsWith('.'));
    const kept = picked.filter(({ file }) => ext.some((e) => file.name.toLowerCase().endsWith(e)));
    const seen = new Map<string, number>();
    for (const { file } of kept) seen.set(file.name, (seen.get(file.name) ?? 0) + 1);
    if (kept.length < picked.length) toast(`${picked.length - kept.length} file${picked.length - kept.length === 1 ? '' : 's'} skipped: not a format an import reads.`);
    return kept.map(({ file, dir }) => rememberDir(dir && (seen.get(file.name) ?? 0) > 1
      ? new File([file], `${dir}/${file.name}`, { type: file.type, lastModified: file.lastModified }) : file, dir));
  };
  const receivePicked = (picked: Picked[]) => {
    const files = fromFolders(picked);
    if (files.length === 0 && picked.length > 0) toast('Nothing in that folder can be imported. Use Excel, CSV, XML or JSON files.', 'error');
    else receive(files);
  };

  const receive = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length === 0 || busy) return;
    if (onFiles) { onFiles(files); return; }
    if (files.every(isPdf)) {
      // A PDF from the saved documents is in Documents already, so it is not offered for saving again.
      const fresh = files.filter((f) => !savedDocumentId(f));
      if (fresh.length === 0) { toast('That PDF is already in Documents. PDFs are not read as tables.'); return; }
      setPdfs(fresh); return;
    }
    stashImportFiles(files, kind);
    navigate(`/import/check${kind ? `?kind=${kind}` : ''}`);
  };

  const failed = problems.length > 0 && !busy;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void fromDrop(e.dataTransfer).then(receivePicked).catch(() => toast('That folder could not be read.', 'error')); }}
      className={cx('relative rounded-xl border-2 border-dashed text-center transition-colors',
        compact ? 'px-5 py-6' : 'px-6 py-10',
        failed ? 'border-red-300 bg-red-50/60'
          : dragging ? 'border-brand-500 bg-brand-50'
          : 'border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50/50',
        'has-[input:focus-visible]:border-brand-500 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand-500/20')}>
      {failed ? (
        <div ref={alert} role="alert" tabIndex={-1} className="flex flex-col items-center gap-3 outline-none">
          <span className="grid size-11 place-items-center rounded-full bg-red-100 text-red-600"><Icon name="alert" className="size-5" /></span>
          <ul className="max-w-md space-y-1.5 text-[14px] text-red-800">
            {problems.map((p, i) => <li key={i}>{p.message}</li>)}
          </ul>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onKeep && keepable.length > 0 && (
              <Button variant="primary" onClick={() => onKeep(keepable)}>
                Save {keepable.length === 1 ? 'it' : `${keepable.length} files`} as {keepable.length === 1 ? 'a document' : 'documents'}, as {keepable.length === 1 ? 'it is' : 'they are'}
              </Button>
            )}
            <Button onClick={() => input.current?.click()}>Choose another file</Button>
          </div>
        </div>
      ) : (
        <label className="group flex cursor-pointer flex-col items-center justify-center gap-2">
          {busy ? (
            <span className="grid size-11 place-items-center"><Spinner className="size-6 text-brand-600" /></span>
          ) : (
            <span className="grid size-11 place-items-center rounded-full bg-brand-50 text-brand-600"><Icon name="inbox" className="size-5" /></span>
          )}
          <span className="text-[14px] font-medium text-ink-800" aria-live="polite">
            {busy ?? (touch
              ? <span className="text-brand-600">Choose files</span>
              : <>Drop your files here, or <span className="text-brand-600 group-hover:text-brand-700 group-hover:underline">choose files</span></>)}
          </span>
          {!busy && (
            <span className="max-w-md text-[12px] leading-relaxed text-ink-500">
              Excel (.xlsx), CSV, XML or an Open Cap Format package (.ocf.zip). Pulley and Carta exports work as they are — {touch ? 'choose' : 'drop'} all their files together.
            </span>
          )}
          <input ref={input} type="file" multiple className="sr-only" accept={IMPORT_ACCEPT} disabled={!!busy}
            onChange={(e) => { receive(e.target.files); e.target.value = ''; }} />
        </label>
      )}
      {/* The field stays in the page while the zone shows a problem, so "Choose another file" can open it. */}
      {failed && (
        <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} accept={IMPORT_ACCEPT} aria-hidden
          onChange={(e) => { receive(e.target.files); e.target.value = ''; }} />
      )}
      {!failed && !busy && (
        <>
          <button type="button" onClick={() => folderInput.current?.click()}
            className="mt-3 inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-brand-600 hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            <Icon name="folder" className="size-4" /> Or choose a folder (subfolders included)
          </button>
          <span aria-hidden className="mx-2 text-ink-300">·</span>
          <button type="button" onClick={saved.open}
            className="mt-3 inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-brand-600 hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            <Icon name="document" className="size-4" /> Use saved documents
          </button>
          <input ref={folderInput} type="file" className="sr-only" tabIndex={-1} aria-hidden {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => { if (e.target.files) receivePicked(fromInput(e.target.files)); e.target.value = ''; }} />
        </>
      )}
      {saved.dialog}
      <SavePdfDialog file={pdfs[0] ?? null} onClose={() => setPdfs((p) => p.slice(1))} />
    </div>
  );
}

const TEMPLATE_KINDS: [kind: string, label: string][] = [
  ['stakeholders', 'Stakeholders'], ['captable', 'Certificates'], ['grants', 'Equity grants'], ['convertibles', 'SAFEs & notes'],
];

/**
 * "Download a template ▾": one menu for every page that imports. The Excel
 * workbook comes first, with a tab per kind and a "How to fill this in" tab;
 * then a CSV per kind (the page's own kind first), headers only; then the XML
 * versions, behind one more item.
 */
export function TemplateMenu({ kind = null, label = 'Download a template' }: { kind?: string | null; label?: string }) {
  const { companyId } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [xml, setXml] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, anchor, popup, false);
  useOutsideClose(open, [anchor, popup], () => setOpen(false));

  useEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    else setXml(false);
  }, [open]);

  const close = () => { setOpen(false); anchor.current?.focus(); };
  const get = (path: string, name: string) => {
    close();
    downloadFile(`/c/${companyId}/imports/${path}`, name).catch((e: Error) => toast(e.message, 'error'));
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); e.stopPropagation(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  };

  const kinds = kind ? [...TEMPLATE_KINDS.filter(([k]) => k === kind), ...TEMPLATE_KINDS.filter(([k]) => k !== kind)] : TEMPLATE_KINDS;
  const item = (key: string, text: string, onClick: () => void, hint?: string) => (
    <button key={key} type="button" role="menuitem" onClick={onClick}
      className="flex w-full flex-col items-start px-3 py-2 text-left text-[13px] text-ink-800 outline-none hover:bg-ink-50 focus-visible:bg-ink-50">
      <span>{text}</span>
      {hint && <span className="text-[11px] text-ink-500">{hint}</span>}
    </button>
  );

  return (
    <>
      <button ref={anchor} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded font-medium text-brand-600 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
        {label}
        <Icon name="chevron" className={cx('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && createPortal(
        <div ref={popup} role="menu" aria-label="Templates" style={style} onKeyDown={onKey}
          className="w-72 overflow-auto rounded-lg border border-ink-200 bg-white py-1 shadow-xl outline-none animate-in">
          {item('xlsx', 'Excel workbook', () => get('template.xlsx', 'import-template.xlsx'), 'All four tabs, and how to fill them in')}
          <div className="my-1 border-t border-ink-100" />
          {kinds.map(([k, text]) => item(k, `${text} (CSV)`, () => get(`template/${k}`, `${k}-template.csv`)))}
          <div className="my-1 border-t border-ink-100" />
          {xml
            ? kinds.map(([k, text]) => item(`xml-${k}`, `${text} (XML)`, () => get(`template/${k}?format=xml`, `${k}-template.xml`)))
            : item('xml', 'XML versions…', () => {
                setXml(true);
                setTimeout(() => popup.current?.querySelector<HTMLElement>('[role="menuitem"]:nth-last-child(4)')?.focus());
              })}
        </div>,
        document.body,
      )}
    </>
  );
}
