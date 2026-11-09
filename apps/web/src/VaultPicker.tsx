/**
 * Choosing documents already in the vault, several at a time.
 *
 * The appraiser's checklist asks for paperwork most companies have filed
 * already: the charter, the last report, the SAFEs. Uploading a second copy of
 * each would leave the vault with duplicates nobody can tell apart, so the
 * request form can point at the documents where they are. Modelled on the
 * single choice in ValuationReportField.tsx, with a tick per document instead of
 * one selection, since a year of statements is often a file a quarter. The 409A
 * page's import picks one report, and only a PDF, so it can be read.
 */
import { useEffect, useState } from 'react';
import { useSession } from './session.tsx';
import { useQuery } from './api.ts';
import { Button, EmptyState, ErrorNote, Loading, Modal, SearchInput, cx } from './ui.tsx';
import { Icon } from './icons.tsx';
import { dateTime, fileSize } from './format.ts';
import { categoryLabel } from './documents.ts';
import { buildFolderTree, type FolderNode } from './DocumentTree.tsx';

export interface VaultDocument {
  id: string; name: string; category: string; folder: string | null; fileName: string | null; mimeType: string | null;
  body: string | null; sizeBytes: number | null; createdAt: string;
  status?: string; visibility?: string;
}

/** Whether a document in the vault is a PDF file, the one kind a report is read from. */
export const isPdfDocument = (d: VaultDocument): boolean =>
  !!d.fileName && (d.mimeType === 'application/pdf' || /\.pdf$/i.test(d.fileName));

const describe = (d: VaultDocument): string => [
  categoryLabel(d.category), d.sizeBytes ? fileSize(Number(d.sizeBytes)) : null, `added ${dateTime(d.createdAt)}`,
].filter(Boolean).join(' · ');

export function VaultPicker({ open, onClose, onPick, purpose, preferCategory, exclude = [], single = false, only, description, pickLabel }: {
  open: boolean;
  onClose: () => void;
  /** Called with the documents ticked, in the order the list shows them. */
  onPick: (documents: VaultDocument[]) => void;
  /** What the documents are for, as the dialog says it: "Certificate of incorporation". */
  purpose: string;
  /** The category listed first, since that is almost always where the document is filed. */
  preferCategory?: string;
  /** Documents already chosen for this purpose, which are not offered again. */
  exclude?: string[];
  /** One document, not several: choosing another lets go of the first. */
  single?: boolean;
  /** The only documents offered, such as PDFs for a report to be read. */
  only?: (d: VaultDocument) => boolean;
  /** What the dialog says under its title, in place of what a request's checklist says. */
  description?: string;
  /** The button that takes the choice, in place of "Attach it". */
  pickLabel?: string;
}) {
  const { companyId } = useSession();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  /** Folders closed by hand, by path. Searching opens everything, so a match is never hidden in a closed folder. */
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  // The vault is only read once someone asks to choose from it, and read afresh each
  // time, so a document uploaded a moment ago from another card is there to pick.
  const listPath = open && companyId ? `/c/${companyId}/documents` : null;
  const { data, error, loading, reload } = useQuery<VaultDocument[]>(listPath, [listPath]);

  useEffect(() => { if (open) { setSearch(''); setPicked([]); setClosed(new Set()); } }, [open]);

  const term = search.trim().toLowerCase();
  const offered = (data ?? [])
    .filter((d) => !exclude.includes(d.id))
    // A record with no file and no text has nothing the appraiser could open.
    .filter((d) => d.fileName || d.body)
    .filter((d) => !only || only(d))
    // The list arrives newest first; the likely category goes to the top without losing that order.
    .sort((a, b) => Number(b.category === preferCategory) - Number(a.category === preferCategory));
  const candidates = offered.filter((d) => !term || d.name.toLowerCase().includes(term) || String(d.fileName ?? '').toLowerCase().includes(term));
  // Everything ticked, whether or not the search shows it now: searching between
  // ticks is how several documents are picked, and a tick a later search hides
  // still counts.
  const chosen = offered.filter((d) => picked.includes(d.id));
  const tree = buildFolderTree(candidates);
  const idsIn = (node: FolderNode<VaultDocument>): string[] => [...node.documents.map((d) => d.id), ...node.folders.flatMap(idsIn)];
  const toggleFolder = (node: FolderNode<VaultDocument>) => {
    const ids = idsIn(node);
    setPicked((p) => (ids.every((id) => p.includes(id)) ? p.filter((id) => !ids.includes(id)) : [...new Set([...p, ...ids])]));
  };

  const row = (d: VaultDocument) => {
    const on = picked.includes(d.id);
    return (
      <label className={cx('relative flex w-full cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-left transition-colors',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
        on ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:bg-ink-50')}>
        {/* A real checkbox underneath, so Space ticks it and a screen reader says whether it is ticked; a radio button for one choice. */}
        <input type={single ? 'radio' : 'checkbox'} name={single ? 'vault-document' : undefined} className="sr-only" checked={on} onChange={() => toggle(d.id)} />
        <span className={cx('grid size-5 shrink-0 place-items-center border transition-colors', single ? 'rounded-full' : 'rounded',
          on ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300 bg-white')} aria-hidden>
          {on && <Icon name="check" className="pop size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-900">{d.name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-ink-500">{describe(d)}</span>
        </span>
      </label>
    );
  };

  const FolderBranch = ({ node, level }: { node: FolderNode<VaultDocument>; level: number }) => {
    const open = !!term || !closed.has(node.path);
    const ids = idsIn(node);
    const all = ids.every((id) => picked.includes(id));
    const some = ids.some((id) => picked.includes(id));
    return (
      <div role="treeitem" aria-expanded={open} aria-selected={undefined} className="space-y-1.5">
        <div className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-ink-50">
          <button type="button" aria-label={`${open ? 'Close' : 'Open'} ${node.name}`} disabled={!!term}
            onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(node.path)) n.delete(node.path); else n.add(node.path); return n; })}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-2 focus-visible:outline-brand-500">
            <Icon name="chevron" className={cx('size-4 shrink-0 text-ink-400 transition-transform', !open && '-rotate-90')} />
            <Icon name="folder" className="size-4 shrink-0 text-ink-400" />
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink-900">{node.name}</span>
            <span className="shrink-0 text-[12px] text-ink-500">({node.count})</span>
          </button>
          {!single && (
            <button type="button" onClick={() => toggleFolder(node)} aria-label={`${all ? 'Untick' : 'Tick'} everything in ${node.name}`}
              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-brand-600 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-500">
              {all ? 'Untick all' : some ? 'Tick the rest' : 'Tick all'}
            </button>
          )}
        </div>
        {open && (
          <div role="group" className="space-y-1.5 border-l border-ink-100 pl-3 ml-2">
            {node.folders.map((f) => <FolderBranch key={f.path} node={f} level={level + 1} />)}
            {node.documents.map((d) => <div key={d.id} role="treeitem" aria-selected={picked.includes(d.id)}>{row(d)}</div>)}
          </div>
        )}
      </div>
    );
  };

  const hiddenTicks = chosen.length - candidates.filter((d) => picked.includes(d.id)).length;

  const toggle = (id: string) => setPicked((p) => (single ? [id] : p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Modal open={open} onClose={onClose} size="md" title="Choose from the vault"
      description={description ?? `For: ${purpose}. The documents stay where they are in the vault; the request points to them.`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={chosen.length === 0} onClick={() => onPick(chosen)}>
          {pickLabel ?? (chosen.length > 1 ? `Attach ${chosen.length} documents` : 'Attach it')}
        </Button>
      </>}>
      <SearchInput value={search} onChange={setSearch} placeholder="Search documents by name" />
      {hiddenTicks > 0 && (
        <p className="mt-2 text-[12px] text-ink-500">
          {hiddenTicks === 1 ? 'One more document is ticked' : `${hiddenTicks} more documents are ticked`} that this search does not show.
        </p>
      )}
      <div className="mt-3">
        {loading ? <Loading label="Loading documents" />
          : error ? <ErrorNote error={error} onRetry={reload} />
            : candidates.length === 0 ? (
              <EmptyState icon={<Icon name="document" className="size-8" />}
                title={term ? 'No document matches that search' : only ? 'There is no PDF on file to choose' : 'There is nothing else on file'}
                description={term ? 'Try part of the file name, or upload the document instead.' : 'Upload the document instead.'} />
            ) : (
              // min-w-0: a fieldset is as wide as its widest row unless told otherwise, and a row's file details would never be cut short.
              <fieldset className="min-w-0">
                <legend className="sr-only">Documents in the vault</legend>
                {/* The same folders as the documents page, so a file is found where it was filed. */}
                <div role="tree" aria-label="Documents by folder" className="max-h-72 space-y-1.5 overflow-y-auto">
                  {tree.map((node) => <FolderBranch key={node.path} node={node} level={0} />)}
                </div>
              </fieldset>
            )}
      </div>
    </Modal>
  );
}
