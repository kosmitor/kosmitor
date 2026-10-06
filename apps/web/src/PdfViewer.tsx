/**
 * Reading a PDF without leaving the page, in a dialog with Open in a tab and
 * Download. The fetching is shared with PdfFrame (see PdfFrame.tsx for why the
 * bytes are fetched rather than pointed at).
 */
import { usePdfUrl } from './PdfFrame.tsx';
import { Modal, Button, Spinner, ErrorNote } from './ui.tsx';
import { Icon } from './icons.tsx';

export function PdfViewer({ open, onClose, title, description, path, filename }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** API path under /api, for example `/c/co_1/documents/doc_2/download`. */
  path: string | null;
  /** Name used when the reader saves a copy. */
  filename: string;
}) {
  const { url, error } = usePdfUrl(path, open);

  const save = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="xl"
      footer={<>
        <Button variant="secondary" onClick={() => url && window.open(url, '_blank', 'noopener')} disabled={!url}
          icon={<Icon name="external" className="size-4" />}>Open in a tab</Button>
        <Button variant="primary" onClick={save} disabled={!url} icon={<Icon name="download" className="size-4" />}>Download</Button>
      </>}>
      {/* Bleed to the dialog's edges: a page of A4 wants every pixel it can get. */}
      <div className="-mx-5 -my-4">
        {error ? (
          <div className="p-5"><ErrorNote error={error} /></div>
        ) : url ? (
          <iframe src={url} title={title} className="h-[min(70vh,calc(100dvh-14rem))] w-full border-0 bg-ink-100" />
        ) : (
          <div className="flex h-[min(70vh,calc(100dvh-14rem))] flex-col items-center justify-center gap-3 text-ink-500">
            <Spinner className="size-6 text-brand-600" />
            <span className="text-[13px]">Opening the document</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
