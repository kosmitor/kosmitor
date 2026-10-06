import { useState } from 'react';
import { useSession } from './session.tsx';
import { api } from './api.ts';
import { Modal, Button, Field, Input, ErrorNote, useToast } from './ui.tsx';
import { Logo } from './icons.tsx';
import { config, PRODUCT } from './config.ts';

/** Three password fields with the checks the server also makes, so mistakes are caught before a round trip. */
function PasswordFields({ current, next, confirm, onChange, currentLabel = 'Current password' }: {
  current: string; next: string; confirm: string; currentLabel?: string;
  onChange: (patch: Partial<{ current: string; next: string; confirm: string }>) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label={currentLabel} required>
        <Input type="password" value={current} onChange={(e) => onChange({ current: e.target.value })} autoComplete="current-password" required autoFocus />
      </Field>
      <Field label="New password" required hint={`At least ${config.auth.passwordMinLength} characters.`}>
        <Input type="password" value={next} onChange={(e) => onChange({ next: e.target.value })} autoComplete="new-password" required
          minLength={config.auth.passwordMinLength} maxLength={config.auth.passwordMaxLength} />
      </Field>
      <Field label="Repeat new password" required>
        <Input type="password" value={confirm} onChange={(e) => onChange({ confirm: e.target.value })} autoComplete="new-password" required />
      </Field>
    </div>
  );
}

/** The length rule is auth.passwordMinLength in kosmitor.config.json, the same one the server applies. */
export function passwordProblem(next: string, confirm: string): string | null {
  if (next.length < config.auth.passwordMinLength) return `Use at least ${config.auth.passwordMinLength} characters.`;
  if (next !== confirm) return 'The two new passwords do not match.';
  return null;
}

/** Change your own password. Other sessions are signed out; this one stays. */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setForm({ current: '', next: '', confirm: '' }); setError(null); onClose(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(form.next, form.confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', { body: { currentPassword: form.current, newPassword: form.next } });
      toast('Password changed — your other devices were signed out');
      close();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} title="Change your password" size="sm"
      description="Your other devices and browsers will be signed out.">
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNote error={error} />}
        <PasswordFields {...form} onChange={(patch) => setForm({ ...form, ...patch })} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Change password</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Shown instead of the app after an administrator set a temporary password:
 * the person chooses their own before going any further.
 */
export function MustChangePasswordGate() {
  const { user, refresh, signOut } = useSession();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(form.next, form.confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', { body: { currentPassword: form.current, newPassword: form.next } });
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Choose a new password</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          An administrator gave <span className="font-medium text-ink-700">{user?.email}</span> a temporary password. Pick your own to continue.
        </p>
        {error && <div className="mt-6"><ErrorNote error={error} /></div>}
        <form onSubmit={submit} className="mt-7 space-y-4">
          <PasswordFields {...form} currentLabel="Temporary password" onChange={(patch) => setForm({ ...form, ...patch })} />
          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Save and continue</Button>
        </form>
        <p className="mt-6 text-center text-[13px] text-ink-500">
          Not you? <button onClick={() => void signOut()} className="font-medium text-brand-600 hover:text-brand-700">Sign out</button>
        </p>
      </div>
    </div>
  );
}
