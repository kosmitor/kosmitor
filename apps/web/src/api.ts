import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Fired on the window after any request that may have changed something (one
 * that is not a GET) succeeds, so what is drawn outside the page that made it,
 * such as the count on the header's tasks button, can ask again.
 */
export const SAVED_EVENT = 'kosmitor:saved';
const saved = (method: string, res: Response) => {
  if (res.ok && method !== 'GET' && method !== 'HEAD') window.dispatchEvent(new Event(SAVED_EVENT));
};

export async function api<T = any>(
  path: string,
  /** `quiet`: a POST that only reads (an import's dry run), so nothing outside the page needs to ask again. */
  options: { method?: string; body?: unknown; raw?: boolean; quiet?: boolean } = {},
): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  // The session is the HttpOnly cookie the server set; nothing here can read it, or leak it.
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!options.quiet) saved(method, res);
  if (options.raw) return res as unknown as T;

  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.error ?? `Request failed (${res.status})`, payload?.detail);
  }
  return payload as T;
}

/** Downloads any authenticated endpoint as a file, using the browser's save flow. Resolves to the response's headers. */
export async function downloadFile(path: string, filename: string): Promise<Headers> {
  const res = await fetch(`/api${path}`, { credentials: 'include' });
  if (!res.ok) {
    let message = 'That file could not be downloaded.';
    try { message = (await res.json()).error ?? message; } catch { /* keep the default */ }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return res.headers;
}

/** Downloads a CSV report through the authenticated endpoint. */
export function downloadReport(companyId: string, report: string, asOf?: string): Promise<Headers> {
  const qs = asOf ? `?asOf=${asOf}` : '';
  return downloadFile(`/c/${companyId}/reports/${report}${qs}`, `${report}-${asOf ?? 'current'}.csv`);
}

/**
 * Uploads a single file as the raw request body. Metadata travels in the
 * query string, so no multipart parsing is needed on either side.
 */
export async function uploadFile<T = any>(path: string, file: File, meta: Record<string, string> = {}, { quiet = false } = {}): Promise<T> {
  const qs = new URLSearchParams({ name: file.name, ...meta }).toString();
  const res = await fetch(`/api${path}?${qs}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!quiet) saved('POST', res);
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, payload?.error ?? `Upload failed (${res.status})`, payload?.detail);
  return payload as T;
}

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  /** The HTTP status behind `error`, so a caller can tell "not there" from "went wrong". */
  errorStatus: number | null;
  loading: boolean;
  reload: () => void;
}

/** Fetches on mount and whenever a dependency changes, with cancellation. */
export function useQuery<T = any>(path: string | null, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const seq = ++latest.current;
    setData(null);
    setError(null);
    setErrorStatus(null);
    if (!path) { setLoading(false); return; }
    setLoading(true);
    api<T>(path)
      .then((result) => { if (seq === latest.current) { setData(result); setLoading(false); } })
      .catch((err: Error) => {
        if (seq !== latest.current) return;
        setError(err.message);
        setErrorStatus(err instanceof ApiError ? err.status : null);
        setLoading(false);
      });
    return () => { if (latest.current === seq) latest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, errorStatus, loading, reload };
}

/** Posts a body and tracks the in-flight/error state for a form. */
export function useMutation<T = any>() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (
    path: string, body?: unknown, method = 'POST',
  ): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      return await api<T>(path, { method, body });
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { mutate, loading, error, setError };
}
