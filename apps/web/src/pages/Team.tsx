import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import { FormModal, FormGrid } from '../crud.tsx';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, Avatar, useToast, Banner, Modal,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import type { AuthConfig } from '../session.tsx';
import { Icon } from '../icons.tsx';
import { date } from '../format.ts';
import { ChangePasswordModal } from '../account.tsx';
import { config, PRODUCT } from '../config.ts';

/** How long a reset link an administrator makes lasts (auth.adminResetLinkHours), in words. */
const linkHours = (h = config.auth.adminResetLinkHours) => `${h} hour${h === 1 ? '' : 's'}`;
/** How long the link in an invitation lasts (auth.inviteLinkDays), in words. */
const inviteDays = (d = config.auth.inviteLinkDays) => `${d} day${d === 1 ? '' : 's'}`;

/**
 * What the server says about an invitation email: whether it went, and the link
 * to pass on when it did not, for someone new to this company alone. `limited`
 * says it was not tried, the address having had its invitation emails for the day.
 */
interface Invitation { emailed: boolean; link?: string; limited?: boolean }
/** An invitation whose link is to be handed over by hand. */
interface PassOn { name: string; email: string; link: string }

const copyText = (toast: ReturnType<typeof useToast>, text: string) =>
  navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy — select the text instead', 'error'));

const ROLES: [string, string, string][] = [
  ['ADMIN', 'Administrator', 'Full access including team management and company settings.'],
  ['LEGAL', 'Legal / finance', 'Can edit every cap table record but cannot manage team access.'],
  ['BOARD', 'Board member', 'Read-only access to the full cap table, plus board consents.'],
  ['VIEWER', 'Viewer', 'Read-only access to the full cap table. Useful for auditors and diligence.'],
  ['EMPLOYEE', 'Employee', 'Sees only their own holdings in the portal.'],
  ['INVESTOR', 'Investor', 'Sees only their own holdings in the portal.'],
];

/** A role's name, as the table and the forms show it. */
const roleLabel = (role: string): string => ROLES.find(([v]) => v === role)?.[1] ?? role;

export default function Team() {
  const { companyId, isAdmin, user, refresh } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any[]>(companyId ? `/c/${companyId}/members` : null, [companyId]);
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'VIEWER', stakeholderId: '' });
  const [editing, setEditing] = useState<any>(null);
  const [confirmRemove, setConfirmRemove] = useState<any>(null);
  const [resetting, setResetting] = useState<any>(null);
  const [changingOwn, setChangingOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [passOn, setPassOn] = useState<PassOn | null>(null);
  const { data: authConfig } = useQuery<AuthConfig>('/auth/config');
  const mailOff = authConfig ? !authConfig.mailConfigured : false;
  // Without passwords, Google is the way in, and an invitation carries no link.
  const passwords = config.auth.passwordSignIn;
  const googleDomains = authConfig?.googleAllowedDomains ?? [];

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  // Someone who also belongs to another company owns their account: this company
  // sets their role here, but their name and sign-in email are theirs to change.
  const accountLocked = !!editing && !editing.managedHere && editing.userId !== user?.id;

  /**
   * Says whether the invitation was emailed. One that was not, with a link back,
   * offers the link in the toast and opens it in a dialog, where focus lands on it.
   */
  const tell = (person: { name: string; email: string }, invitation: Invitation | undefined, again: boolean) => {
    const granted = again ? '' : 'Access granted. ';
    const why = invitation?.limited ? ': the address has reached its daily limit of invitation emails'
      : mailOff ? ', since email is not set up on this server' : '';
    if (invitation?.emailed) {
      toast(again ? `Invitation emailed to ${person.email} again` : `${granted}Invitation emailed to ${person.email}.`);
    } else if (invitation?.link) {
      const link = invitation.link;
      toast(`${granted}The invitation was not emailed${why}. Copy its link to pass it on.`, 'info',
        { label: 'Copy link', onClick: () => void copyText(toast, link) });
      setPassOn({ ...person, link });
    } else if (invitation) {
      toast(again ? `The invitation to ${person.email} was not emailed${why}. Try again later.`
        : `${granted}The invitation was not emailed${why}, so let ${person.email} know.`, 'info');
    } else {
      toast('Access granted');
    }
  };

  const invite = async () => {
    setBusy(true);
    try {
      const email = form.email.trim().toLowerCase();
      const res = await api<{ invitation?: Invitation }>(`/c/${companyId}/members`, {
        body: { email: form.email, name: form.name || undefined, role: form.role, stakeholderId: form.stakeholderId || null },
      });
      setInviting(false);
      setForm({ email: '', name: '', role: 'VIEWER', stakeholderId: '' });
      tell({ name: form.name.trim() || email, email }, res.invitation, false);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  /** Sends a member who has not signed in yet their invitation again, with a new link. */
  const resend = async (m: { id: string; name: string; email: string }) => {
    setResending(m.id);
    try {
      const res = await api<{ invitation: Invitation }>(`/c/${companyId}/members/${m.id}/invite`, { body: {} });
      tell(m, res.invitation, true);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setResending(null); }
  };

  const saveMember = async () => {
    setBusy(true);
    try {
      const before = (data ?? []).find((m) => m.id === editing.id);
      const saved = await api<{ id: string; name: string; email: string; neverSignedIn?: boolean }>(`/c/${companyId}/members/${editing.id}`, {
        method: 'PATCH',
        body: {
          ...(accountLocked ? {} : { name: editing.name, email: editing.email }),
          role: editing.role, stakeholderId: editing.stakeholderId || null,
        },
      });
      if (before && saved.email !== before.email && saved.neverSignedIn) {
        // Their invitation was for the old address, emailed or handed over, and its link stopped working with the change.
        toast(`Member updated. The invitation to ${before.email} no longer works, so send it again to ${saved.email}.`, 'info',
          { label: 'Resend invitation', onClick: () => void resend(saved) });
      } else {
        toast('Member updated');
      }
      const self = editing.userId === user?.id;
      setEditing(null);
      reload();
      if (self) await refresh(); // your own name or email shows in the sidebar
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  if (!isAdmin) return <EmptyState title="Only administrators can manage team access" />;
  if (loading) return <Loading label="Loading team" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  return (
    <>
      <PageHeader concept="team-access" title="Team & access"
        subtitle="Who can see and change the cap table"
        actions={<Button variant="primary" icon={<Icon name="plus" />} onClick={() => setInviting(true)}>Invite person</Button>} />

      <div className="mb-5">
        <Banner tone="info" title="Linking accounts to stakeholders">
          An account linked to a stakeholder record sees that holder's grants, vesting and documents in
          the portal. Employees and investors see nothing beyond their own position.
        </Banner>
      </div>

      <DataTable caption="Team members" rows={data ?? []} rowKey={(m) => m.id}
        search={{ placeholder: 'Search by name, email or role', by: (m) => [m.name, m.email, roleLabel(m.role), m.stakeholderId ? nameOf.get(m.stakeholderId) : null] }}
        columns={[
          { key: 'person', label: 'Person', value: (m) => m.name, cell: (m) => (
            <span className="flex items-center gap-2.5">
              <Avatar name={m.name} size={30} color={m.avatarColor ?? undefined} src={m.avatarUrl} />
              <span className="min-w-0">
                <span className="block truncate font-medium" title={m.name}>
                  {m.name}{m.userId === user?.id && <span className="ml-1.5 text-[11px] text-ink-500">(you)</span>}
                </span>
                <span className="block truncate text-[11px] text-ink-500" title={m.email}>{m.email}</span>
              </span>
            </span>
          ) },
          { key: 'role', label: 'Role', value: (m) => roleLabel(m.role), cell: (m) => (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={m.role === 'ADMIN' ? 'brand' : m.role === 'LEGAL' ? 'purple' : 'neutral'}>{roleLabel(m.role)}</Badge>
              {m.authProvider === 'GOOGLE' && <Badge tone="info">Google</Badge>}
              {m.neverSignedIn && <Badge tone="warning">Invited</Badge>}
            </span>
          ) },
          { key: 'linked', label: 'Linked stakeholder', className: 'text-ink-600',
            value: (m) => (m.stakeholderId ? nameOf.get(m.stakeholderId) : null),
            cell: (m) => (m.stakeholderId ? nameOf.get(m.stakeholderId) ?? '—' : <span className="text-ink-400">Not linked</span>) },
          // Below xl the date gives way, so the row's actions (four for someone invited) stay in view rather than scrolled off.
          { key: 'granted', label: 'Access granted', type: 'date', hideBelow: 'xl', className: 'text-ink-600',
            value: (m) => m.createdAt?.slice(0, 10) },
          { key: 'actions', label: '', width: 150, align: 'right', cell: (m) => (
            <span className="flex justify-end gap-1">
              {/* Someone who has never signed in can be sent their invitation again, with a new link. */}
              {m.neverSignedIn && (
                <Button size="sm" variant="ghost" aria-label={`Resend invitation to ${m.name}`} title="Resend invitation"
                  icon={<Icon name="send" className="size-4" />} loading={resending === m.id} disabled={!!resending}
                  onClick={() => void resend(m)} />
              )}
              <Button size="sm" variant="ghost" aria-label="Edit member" title="Edit member"
                onClick={() => setEditing({ id: m.id, userId: m.userId, authProvider: m.authProvider, managedHere: m.managedHere, role: m.role, stakeholderId: m.stakeholderId ?? '', name: m.name, email: m.email })}>
                <Icon name="edit" className="size-4" />
              </Button>
              {!config.auth.passwordSignIn ? null : m.userId === user?.id ? (
                <Button size="sm" variant="ghost" aria-label="Change your password" title="Change your password" onClick={() => setChangingOwn(true)}>
                  <Icon name="lock" className="size-4" />
                </Button>
              ) : (
                <Button size="sm" variant="ghost" aria-label="Reset password" title="Reset password" onClick={() => setResetting(m)}>
                  <Icon name="lock" className="size-4" />
                </Button>
              )}
              <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setConfirmRemove(m)}>
                <Icon name="trash" className="size-4" />
              </Button>
            </span>
          ) },
        ]} />

      <Card className="mt-5">
        <h3 className="mb-3 text-[15px] font-semibold">What each role can do</h3>
        <dl className="space-y-2.5">
          {ROLES.map(([value, label, description]) => (
            <div key={value} className="flex gap-3">
              <dt className="w-32 shrink-0 text-[13px] font-medium text-ink-800">{label}</dt>
              <dd className="text-[13px] leading-relaxed text-ink-600">{description}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <FormModal open={inviting} onClose={() => setInviting(false)} busy={busy}
        title="Invite someone" onSubmit={invite} submitLabel={mailOff ? 'Give access' : 'Send invitation'}
        description={`${mailOff ? 'They sign in' : 'We email them an invitation to sign in'} ${passwords ? 'with this address' : 'with Google as this address'}.${
          passwords && !mailOff ? ` Someone new chooses a password from its link, which lasts ${inviteDays()}.` : ''} Link them to a stakeholder so they see their own equity.`}>
        <FormGrid>
          <Field label="Email" required
            hint={!passwords && googleDomains.length ? `Google sign-in on this server only accepts ${googleDomains.map((d) => `@${d}`).join(' or ')} accounts.` : undefined}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="person@company.com" required />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jordan Ellis" />
          </Field>
          <Field label="Role" required>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Link to stakeholder" hint="Left empty, a stakeholder with the same email is linked automatically.">
            <Select value={form.stakeholderId} onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })}>
              <option value="">Match by email</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </FormGrid>
        <p className="rounded-lg bg-ink-50 p-3 text-[12px] leading-relaxed text-ink-600">
          {ROLES.find(([v]) => v === form.role)?.[2]}
        </p>
        {mailOff && (
          <p className="rounded-lg bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-800">
            Email is not set up on this server, so the invitation is not emailed.{' '}
            {passwords
              ? `For someone new to ${PRODUCT}, you get its link to pass on instead: with it they choose a password, and it lasts ${inviteDays()}.`
              : 'Let them know to sign in with Google as this address.'}
          </p>
        )}
      </FormModal>

      <PassOnModal invite={passOn} onClose={() => setPassOn(null)} />

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={busy}
        title="Edit member" onSubmit={saveMember} submitLabel="Save member">
        {accountLocked && (
          <div className="mb-4">
            <Banner tone="info">{editing.name} also belongs to another company, so their name and sign-in email are theirs to change. You can still set their role and linked stakeholder here.</Banner>
          </div>
        )}
        {editing?.authProvider === 'GOOGLE' && !accountLocked && (
          <div className="mb-4">
            <Banner tone="info">This person signs in with Google. Google sign-in keeps working only while the email here matches their Google account; a password lets them sign in with any address.</Banner>
          </div>
        )}
        {editing?.userId === user?.id && (
          <div className="mb-4">
            <Banner tone="warning">This is your own account. The email is the address you sign in with, for every company you belong to.</Banner>
          </div>
        )}
        <FormGrid>
          <Field label="Name" required>
            <Input value={editing?.name ?? ''} readOnly={accountLocked} className={accountLocked ? 'bg-ink-50 text-ink-600' : undefined}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="Email" required hint="Their sign-in address, shared across every company they belong to.">
            <Input type="email" value={editing?.email ?? ''} readOnly={accountLocked} className={accountLocked ? 'bg-ink-50 text-ink-600' : undefined}
              onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={editing?.role ?? 'VIEWER'} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
              {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Linked stakeholder">
            <Select value={editing?.stakeholderId ?? ''} onChange={(e) => setEditing({ ...editing, stakeholderId: e.target.value })}>
              <option value="">Not linked</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </FormGrid>
      </FormModal>

      <ChangePasswordModal open={changingOwn} onClose={() => setChangingOwn(false)} />
      <ResetPasswordModal member={resetting} companyId={companyId!} mailConfigured={!!authConfig?.mailConfigured}
        onClose={() => setResetting(null)} />

      <ConfirmDialog open={!!confirmRemove} onClose={() => setConfirmRemove(null)} danger loading={busy}
        title="Remove access" confirmLabel="Remove access"
        message={<>Remove <strong>{confirmRemove?.name}</strong>'s access to this company? Their stakeholder record and holdings are unaffected.</>}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api(`/c/${companyId}/members/${confirmRemove.id}`, { method: 'DELETE' });
            toast('Access removed'); setConfirmRemove(null); reload();
          } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
        }} />
    </>
  );
}

/**
 * The link of an invitation that was not emailed, to hand over by hand. Focus
 * lands on the link with it selected, so it can be copied straight away.
 */
function PassOnModal({ invite, onClose }: { invite: PassOn | null; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open={!!invite} onClose={onClose} title="Pass the invitation on" size="md"
      description={invite ? `The invitation to ${invite.email} was not emailed. Send them this link over a channel you trust.` : undefined}>
      {invite && (
        <div className="space-y-4">
          <Field label="Invitation link"
            hint={`It works once and lasts ${inviteDays()}. Whoever opens it chooses the password for ${invite.email} and is signed in, so send it to ${invite.name} alone.`}>
            <Input readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button onClick={onClose}>Done</Button>
            <Button variant="primary" icon={<Icon name="copy" />} onClick={() => void copyText(toast, invite.link)}>Copy link</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

type ResetMode = 'email' | 'link' | 'temporary';
interface ResetResult { mode: ResetMode; emailed?: boolean; resetUrl?: string; expiresAt?: string; temporaryPassword?: string }

/**
 * Administrator reset for one member: email them a link, get a link to pass
 * on, or set a temporary password they must change at their next sign-in.
 */
function ResetPasswordModal({ member, companyId, mailConfigured, onClose }: {
  member: any; companyId: string; mailConfigured: boolean; onClose: () => void;
}) {
  const toast = useToast();
  // A link or a password handed to an administrator is a way into the account, so
  // it is only offered when this company is the only one the person belongs to.
  const managed = !!member?.managedHere;
  const firstMode: ResetMode = mailConfigured || !managed ? 'email' : 'link';
  const [mode, setMode] = useState<ResetMode>(firstMode);
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<ResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setResult(null); setError(null); setPassword(''); setMode(firstMode); onClose(); };
  // The first choice depends on the person, so it is set again for each one.
  useEffect(() => { setMode(firstMode); }, [member?.id, firstMode]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<ResetResult>(`/c/${companyId}/members/${member.id}/reset-password`, {
        body: { mode, password: mode === 'temporary' && password ? password : undefined },
      }));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const copy = (text: string) => copyText(toast, text);

  const elsewhere = 'only for someone who belongs to no other company';
  const options: [ResetMode, string, string, string | null][] = [
    ['email', 'Email them a reset link', `They choose a new password themselves. The link works once and for ${linkHours()}.`, mailConfigured ? null : 'email is not configured'],
    ['link', 'Give me a reset link to pass on', `Share it over a channel you trust. Works once, for ${linkHours()}.`, managed ? null : elsewhere],
    ['temporary', 'Set a temporary password', 'Tell it to them directly; they must choose their own at the next sign-in.', managed ? null : elsewhere],
  ];
  const nothingAvailable = options.every(([, , , unavailable]) => unavailable);

  return (
    <Modal open={!!member} onClose={close} title={`Reset password for ${member?.name ?? ''}`} size="md"
      description={member ? (managed
        ? `${member.email} — this changes their sign-in for every company they belong to, and signs them out everywhere.`
        : `${member.email} — they also belong to another company, so the link goes to them and nothing changes until they use it.`) : undefined}>
      {!result ? (
        <div className="space-y-4">
          {error && <ErrorNote error={error} />}
          {nothingAvailable && (
            <Banner tone="warning">
              {member?.name} also belongs to another company, so this company can only email them a reset link, and email is not configured on this server.
            </Banner>
          )}
          {member?.authProvider === 'GOOGLE' && (
            <Banner tone="info">This person signs in with Google. Setting a password also lets them sign in with their email.</Banner>
          )}
          <div className="space-y-2">
            {options.map(([value, label, hint, unavailable]) => (
              <label key={value} className={`flex gap-3 rounded-lg border p-3 ${mode === value && !unavailable ? 'border-brand-500 bg-brand-50/50' : 'border-ink-200'} ${unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                <input type="radio" name="reset-mode" className="mt-0.5 accent-brand-600" checked={mode === value && !unavailable} disabled={!!unavailable}
                  onChange={() => setMode(value)} />
                <span>
                  <span className="block text-[13px] font-medium text-ink-900">{label}{unavailable && ` — ${unavailable}`}</span>
                  <span className="block text-[12px] text-ink-500">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {mode === 'temporary' && (
            <Field label="Temporary password" hint={`Leave empty to generate one. At least ${config.auth.passwordMinLength} characters.`}>
              <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Generated if left empty" autoComplete="off" />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={run} disabled={nothingAvailable}>
              {mode === 'email' ? 'Send reset link' : mode === 'link' ? 'Create reset link' : 'Set temporary password'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {result.mode === 'email' && result.emailed && (
            <Banner tone="success" title="Reset link sent">
              {member.name} has an email with a link to choose a new password. It works once and expires {result.expiresAt ? `on ${date(result.expiresAt.slice(0, 10))}` : `in ${linkHours()}`}.
            </Banner>
          )}
          {result.resetUrl && (
            <>
              <Banner tone="success" title="Reset link ready">
                Pass it to {member.name} over a channel you trust. It works once and expires in {linkHours()}; their old sessions are already signed out.
              </Banner>
              <div className="flex items-start gap-2 rounded-lg bg-ink-50 p-3">
                <code className="min-w-0 flex-1 break-all text-[12px] text-ink-800">{result.resetUrl}</code>
                <Button size="sm" onClick={() => void copy(result.resetUrl!)} icon={<Icon name="copy" />}>Copy</Button>
              </div>
            </>
          )}
          {result.temporaryPassword && (
            <>
              <Banner tone="success" title="Temporary password set">
                Tell {member.name} this password directly — it is shown only now. They will be asked to choose their own the moment they sign in.
              </Banner>
              <div className="flex items-center gap-2 rounded-lg bg-ink-50 p-3">
                <code className="flex-1 font-mono text-[15px] tracking-wide text-ink-900">{result.temporaryPassword}</code>
                <Button size="sm" onClick={() => void copy(result.temporaryPassword!)} icon={<Icon name="copy" />}>Copy</Button>
              </div>
            </>
          )}
          <div className="flex justify-end"><Button variant="primary" onClick={close}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}
