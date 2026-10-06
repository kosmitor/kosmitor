import { useCallback, useState } from 'react';
import { api, useQuery } from './api.ts';
import { useSession } from './session.tsx';
import { useToast, Modal, Button } from './ui.tsx';

/** List + mutate helper shared by every entity screen. */
export function useCrud<T = any>(resource: string) {
  const { companyId } = useSession();
  const base = companyId ? `/c/${companyId}/${resource}` : null;
  const query = useQuery<T[]>(base, [companyId]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (
    fn: () => Promise<unknown>, successMessage: string,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      query.reload();
      toast(successMessage);
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [query, toast]);

  return {
    items: query.data ?? [],
    loading: query.loading,
    error: query.error,
    reload: query.reload,
    busy,
    create: (body: unknown, message = 'Created') =>
      run(() => api(`${base}`, { body }), message),
    update: (id: string, body: unknown, message = 'Saved') =>
      run(() => api(`${base}/${id}`, { body, method: 'PATCH' }), message),
    remove: (id: string, message = 'Deleted') =>
      run(() => api(`${base}/${id}`, { method: 'DELETE' }), message),
    action: (path: string, body: unknown, message: string) =>
      run(() => api(`/c/${companyId}/${path}`, { body }), message),
  };
}

/** Modal wrapper that owns the submit button state for an entity form. */
export function FormModal({ open, onClose, title, description, onSubmit, submitLabel = 'Save', busy, children, size = 'md', danger }: {
  open: boolean; onClose: () => void; title: string; description?: string;
  onSubmit: () => void | Promise<void>; submitLabel?: string; busy?: boolean;
  children: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; danger?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size={size}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy}
            onClick={() => void onSubmit()}>{submitLabel}</Button>
        </>
      }>
      <form onSubmit={(e) => { e.preventDefault(); void onSubmit(); }} className="space-y-4">
        {children}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Two-column grid used inside forms. */
export function FormGrid({ children, columns = 2 }: { children: React.ReactNode; columns?: 1 | 2 | 3 }) {
  const cls = columns === 1 ? '' : columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
  return <div className={`grid gap-4 ${cls}`}>{children}</div>;
}
