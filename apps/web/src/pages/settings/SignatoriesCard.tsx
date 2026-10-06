import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../session.tsx';
import { useQuery, api } from '../../api.ts';
import { FormModal, FormGrid } from '../../crud.tsx';
import { Card, CardHeader, Button, Input, Field, Select, Badge, Checkbox, ConfirmDialog, useToast, Textarea } from '../../ui.tsx';
import { Icon } from '../../icons.tsx';

const blank = { kind: 'SIGNATORY', name: '', title: '', email: '', phone: '', isDefault: false, notes: '' };

/** Who signs for the Company, who to reach, and who sits on the board. */
export default function SignatoriesCard() {
  const { companyId, isAdmin } = useSession();
  const toast = useToast();
  const { data, reload } = useQuery<{ signatories: any[]; contacts: any[]; boardMembers: any[] }>(companyId ? `/c/${companyId}/contacts` : null, [companyId]);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [deleting, setDeleting] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const openNew = (kind: string) => { setForm({ ...blank, kind, isDefault: kind === 'SIGNATORY' && (data?.signatories.length ?? 0) === 0 }); setEditing({ id: null }); };
  const openEdit = (c: any) => { setForm({ kind: c.kind, name: c.name, title: c.title ?? '', email: c.email ?? '', phone: c.phone ?? '', isDefault: !!c.isDefault, notes: c.notes ?? '' }); setEditing(c); };
  const save = async () => {
    setBusy(true);
    try {
      const body = { kind: form.kind, name: form.name, title: form.title || null, email: form.email || null, phone: form.phone || null, isDefault: form.isDefault, notes: form.notes || null };
      if (editing?.id) await api(`/c/${companyId}/contacts/${editing.id}`, { method: 'PATCH', body });
      else await api(`/c/${companyId}/contacts`, { body });
      toast('Saved');
      setEditing(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/contacts/${deleting.id}`, { method: 'DELETE' });
      toast('Removed');
      setDeleting(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const Row = ({ c }: { c: any }) => (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink-900">{c.name}{!!c.isDefault && <Badge tone="brand">Default</Badge>}</span>
        <span className="block text-[12px] text-ink-500">{[c.title, c.email, c.phone].filter(Boolean).join(' · ') || '—'}</span>
      </span>
      {isAdmin && (
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => openEdit(c)}><Icon name="edit" className="size-4" /></Button>
          <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setDeleting(c)}><Icon name="trash" className="size-4" /></Button>
        </span>
      )}
    </li>
  );

  return (
    <Card>
      <CardHeader title="Signatories, board and contacts" subtitle="Who signs for the Company on certificates and agreements, who approves, and who to reach" />
      <div className="grid gap-5 md:grid-cols-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">Signatories</p>
            {isAdmin && <Button size="sm" variant="ghost" onClick={() => openNew('SIGNATORY')} icon={<Icon name="plus" />}>Add</Button>}
          </div>
          {(data?.signatories ?? []).length === 0
            ? <p className="text-[12px] text-ink-500">None yet. The issuing forms default to whoever is signed in.</p>
            : <ul className="divide-y divide-ink-100">{data!.signatories.map((c) => <Row key={c.id} c={c} />)}</ul>}
        </div>
        <div>
          <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-500">Board members</p>
          {(data?.boardMembers ?? []).length === 0
            ? <p className="text-[12px] text-ink-500">Give a stakeholder the <em>Board member</em> or <em>Founder</em> relationship to seat them.</p>
            : (
              <ul className="divide-y divide-ink-100">
                {data!.boardMembers.map((b) => (
                  <li key={b.id} className="py-2">
                    <Link to={`/stakeholders/${b.id}`} className="text-[13px] font-medium text-ink-900 hover:text-brand-700">{b.name}</Link>
                    <span className="block text-[12px] text-ink-500">{b.relation === 'FOUNDER' ? 'Founder' : 'Board member'}{b.email ? ` · ${b.email}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          <p className="mt-2 text-[11px] text-ink-400">Directors vote on board consents from their portal.</p>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">Contacts</p>
            {isAdmin && <Button size="sm" variant="ghost" onClick={() => openNew('CONTACT')} icon={<Icon name="plus" />}>Add</Button>}
          </div>
          {(data?.contacts ?? []).length === 0
            ? <p className="text-[12px] text-ink-500">Counsel, accountants, 409A provider, transfer agent.</p>
            : <ul className="divide-y divide-ink-100">{data!.contacts.map((c) => <Row key={c.id} c={c} />)}</ul>}
        </div>
      </div>

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={busy} onSubmit={save}
        title={editing?.id ? 'Edit' : form.kind === 'SIGNATORY' ? 'Add a signatory' : 'Add a contact'} submitLabel="Save">
        <FormGrid>
          <Field label="Role">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="SIGNATORY">Signatory (signs for the Company)</option>
              <option value="CONTACT">Contact</option>
            </Select>
          </Field>
          <Field label="Name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={form.kind === 'SIGNATORY' ? 'Chief Executive Officer' : 'Outside counsel'} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </FormGrid>
        {form.kind === 'SIGNATORY' && (
          <Checkbox label="Default signatory" hint="Pre-filled on certificates, grant agreements, SAFEs and offer letters." checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} />
        )}
        <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </FormModal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy} title="Remove" confirmLabel="Remove"
        message={<>Remove <strong>{deleting?.name}</strong>? Documents already signed keep their signatures.</>} onConfirm={() => void remove()} />
    </Card>
  );
}
