/**
 * A PDF from the API shown inside the page, and the document preview built on it.
 *
 * Every document endpoint is behind the session, so an iframe cannot simply
 * point at the API: it would be an unauthenticated request. The bytes are
 * fetched the way the rest of the app fetches, turned into an object URL and
 * handed to the browser's own PDF reader. The URL is released when the frame
 * goes away, because an object URL pins its blob in memory until it is revoked.
 */
import { useEffect, useState } from 'react';
import { ApiError } from './api.ts';
import { Spinner, ErrorNote } from './ui.tsx';

/** Fetches a PDF while `enabled`, and returns an object URL for it or the reason it failed. */
export function usePdfUrl(path: string | null, enabled = true): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !path) return;
    let revoked = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);

    void (async () => {
      try {
        const res = await fetch(`/api${path}`, { credentials: 'include' });
        if (!res.ok) {
          let message = 'That document could not be opened.';
          try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* keep the default */ }
          throw new ApiError(res.status, message);
        }
        // The endpoint may label the bytes as a generic download, so the type is
        // set here; the browser picks its reader from the blob, not the response.
        const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        if (!revoked) setError((err as Error).message);
      }
    })();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [enabled, path]);

  return { url, error };
}

/** The PDF itself, with a loading state and its error in place. */
export function PdfFrame({ path, title, className = 'h-[70vh]' }: {
  /** API path under /api, for example `/c/co_1/documents/doc_2/pdf?inline=1`. */
  path: string;
  /** Read out by screen readers for the frame. */
  title: string;
  className?: string;
}) {
  const { url, error } = usePdfUrl(path);
  if (error) return <div className="p-5"><ErrorNote error={error} /></div>;
  if (!url) {
    return (
      <div className={`flex w-full flex-col items-center justify-center gap-3 bg-ink-50 text-ink-500 ${className}`}>
        <Spinner className="size-6 text-brand-600" />
        <span className="text-[13px]">Opening the document</span>
      </div>
    );
  }
  return <iframe src={url} title={title} className={`w-full border-0 bg-ink-100 ${className}`} />;
}

/**
 * How a generated certificate, award or SAFE/note is read inside a dialog: the
 * certificate itself, exactly as it prints, with its plain text a click away
 * (to search it, or for a screen reader). A document without a front page, made
 * before they existed, shows its text as it always has.
 */
export function DocumentPreview({ companyId, document, className = 'h-[60vh]' }: {
  companyId: string;
  document: { id: string; name?: string | null; body?: string | null; hasFace?: boolean | null };
  className?: string;
}) {
  const [asText, setAsText] = useState(false);
  const text = (
    <div className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-ink-200 bg-ink-50 p-4 font-serif text-[13px] leading-relaxed text-ink-800">
      {document.body}
    </div>
  );
  if (!document.hasFace) return document.body ? text : null;
  return (
    <div>
      {asText ? text : (
        <div className="overflow-hidden rounded-lg border border-ink-200">
          <PdfFrame path={`/c/${companyId}/documents/${document.id}/pdf?inline=1`} title={document.name ?? 'Document'} className={className} />
        </div>
      )}
      {document.body && (
        <button type="button" onClick={() => setAsText(!asText)}
          className="mt-2 text-[12px] font-medium text-brand-700 underline-offset-2 hover:underline">
          {asText ? 'Show the certificate' : 'Show as text'}
        </button>
      )}
    </div>
  );
}
