import { useState, type ReactNode } from 'react';
import { useSession } from './session.tsx';
import { fetchStoredFile } from './api.ts';
import { VaultPicker, type VaultDocument } from './VaultPicker.tsx';
import { useToast } from './ui.tsx';

/**
 * Every import can start from what is already saved in Documents as well as from
 * the computer: the person picks documents from the vault, they are read back
 * into memory as files, and the import carries on exactly as if they had been
 * dropped. The documents stay where they are.
 */
const fromVault = new WeakMap<File, string>();
/** The id of the saved document a file was read from, or undefined for one that came from the computer. */
export const savedDocumentId = (file: File): string | undefined => fromVault.get(file);

export function useSavedDocuments({ onFiles, accepts, purpose, description, single = false }: {
  onFiles: (files: File[]) => void;
  /** Which saved documents can be used here; the rest are not listed. */
  accepts: (fileName: string, d: VaultDocument) => boolean;
  purpose: string;
  description: string;
  single?: boolean;
}): { open: () => void; dialog: ReactNode } {
  const { companyId } = useSession();
  const toast = useToast();
  const [choosing, setChoosing] = useState(false);

  const pick = async (docs: VaultDocument[]) => {
    setChoosing(false);
    if (!companyId || docs.length === 0) return;
    const files: File[] = [];
    for (const d of docs) {
      try {
        const file = await fetchStoredFile(`/c/${companyId}/documents/${d.id}/download`, d.fileName ?? d.name, d.mimeType ?? '');
        fromVault.set(file, d.id);
        files.push(file);
      } catch (err) { toast((err as Error).message, 'error'); }
    }
    if (files.length > 0) onFiles(files);
  };

  return {
    open: () => setChoosing(true),
    dialog: (
      <VaultPicker open={choosing} onClose={() => setChoosing(false)} single={single} purpose={purpose}
        only={(d) => !!d.fileName && accepts(d.fileName, d)} pickLabel="Use these" description={description}
        onPick={(docs) => void pick(docs)} />
    ),
  };
}
