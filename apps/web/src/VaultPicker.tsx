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

export interface VaultDocument {
  id: string; name: string; category: string; folder: string | null; fileName: string | null; mimeType: string | null;
  body: string | null; sizeBytes: number | null; createdAt: string;
  status?: string; visibility?: string;
}

/** Whether a document in the vault is a PDF file, the one kind a report is read from. */
export const isPdfDocument = (d: VaultDocument): boolean =>
  !!d.fileName && (d.mimeType === 'application/pdf' || /\.pdf$/i.test(d.fileName));

const describe = (d: VaultDocument): string => [
  categoryLabel(d.category), d.folder, d.sizeBytes ? fileSize(Number(d.sizeBytes)) : null, `added ${dateTime(d.createdAt)}`,
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

  // The vault is only read once someone asks to choose from it, and read afresh each
  // time, so a document uploaded a moment ago from another card is there to pick.
  const listPath = open && companyId ? `/c/${companyId}/documents` : null;
  const { data, error, loading, reload } = useQuery<VaultDocument[]>(listPath, [listPath]);

  useEffect(() => { if (open) { setSearch(''); setPicked([]); } }, [open]);

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
                <ul className="max-h-72 space-y-2 overflow-y-auto">
                  {candidates.map((d) => {
                    const on = picked.includes(d.id);
                    return (
                      <li key={d.id}>
                        {/* A real checkbox underneath, so Space ticks it and a screen reader says whether it is ticked; a radio button for one choice. */}
                        <label className={cx('relative flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                          'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
                          on ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:bg-ink-50')}>
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
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            )}
      </div>
    </Modal>
  );
}
