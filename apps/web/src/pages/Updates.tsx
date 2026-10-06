import { useMemo, useState } from 'react';
import { FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import {
  PageHeader, Card, Table, TH, TD, TR, Badge, Loading, ErrorNote, Button, Input, Field, Select, EmptyState,
  ConfirmDialog, SegmentedControl, useToast, Textarea, Modal, Banner, KeyValue, Checkbox,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { date, dateTime, currencySymbol } from '../format.ts';

interface Metric { label: string; value: string }
const blank = { title: '', period: '', body: '', audience: 'INVESTORS', recipientIds: [] as string[], metrics: [{ label: '', value: '' }] as Metric[] };

/** Company updates to investors and the team, with who was emailed and who has read them. */
export default function Updates() {
  const { companyId, canEdit } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<{ updates: any[]; audiences: { key: string; label: string; count: number | null }[] }>(companyId ? `/c/${companyId}/updates` : null, [companyId]);
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const [filter, setFilter] = useState<'ALL' | 'DRAFT' | 'SENT'>('ALL');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<any>(null);
  const [sendPreview, setSendPreview] = useState<any>(null);
  const [viewing, setViewing] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const updates = data?.updates ?? [];
  const rows = updates.filter((u) => filter === 'ALL' || u.status === filter);
  const audiences = data?.audiences ?? [];

  const openNew = () => { setForm({ ...blank, metrics: [{ label: '', value: '' }] }); setEditing({ id: null }); };
  const openEdit = (u: any) => {
    setForm({ title: u.title, period: u.period ?? '', body: u.body, audience: u.audience, recipientIds: u.recipientIds ?? [], metrics: u.metrics.length ? u.metrics : [{ label: '', value: '' }] });
    setEditing(u);
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: form.title, period: form.period || null, body: form.body, audience: form.audience, recipientIds: form.recipientIds, metrics: form.metrics.filter((m) => m.label.trim()) };
      if (editing?.id) await api(`/c/${companyId}/updates/${editing.id}`, { method: 'PATCH', body });
      else await api(`/c/${companyId}/updates`, { body });
      toast(editing?.id ? 'Update saved' : 'Update drafted');
      setEditing(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const openSend = async (u: any) => {
    setBusy(true);
    try {
      const d = await api<any>(`/c/${companyId}/updates/${u.id}`);
      setSendPreview(d);
      setSending(u);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ sent: number; emailed: number; withoutEmail: number; reason: string | null }>(`/c/${companyId}/updates/${sending.id}/send`, { body: {} });
      toast(`Sent to ${r.sent} recipient${r.sent === 1 ? '' : 's'}${r.emailed ? `, ${r.emailed} emailed` : ''}${r.reason ? ` — ${r.reason}` : ''}`, r.emailed || !r.reason ? 'success' : 'error');
      setSending(null);
      setSendPreview(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const openDetail = async (u: any) => {
    setBusy(true);
    try { setDetail(await api<any>(`/c/${companyId}/updates/${u.id}`)); } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/updates/${deleting.id}`, { method: 'DELETE' });
      toast('Update deleted');
      setDeleting(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const setMetric = (i: number, patch: Partial<Metric>) => setForm({ ...form, metrics: form.metrics.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });

  if (loading && !data) return <Loading label="Loading updates" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  const sent = updates.filter((u) => u.status === 'SENT');
  const totalRecipients = sent.reduce((s, u) => s + u.recipientCount, 0);
  const totalViews = sent.reduce((s, u) => s + u.viewedCount, 0);

  return (
    <>
      <PageHeader concept="investor-updates" title="Investor updates" subtitle="Write once, send to the right audience, and see who has read it in their portal."
        actions={canEdit && <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew}>New update</Button>} />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        {[
          ['Updates sent', String(sent.length), sent.length ? `Last on ${date(String(sent[0].sentAt).slice(0, 10))}` : 'Nothing sent yet'],
          ['Recipients reached', String(totalRecipients), `${sent.reduce((s, u) => s + u.emailedCount, 0)} by email`],
          ['Opened in the portal', totalRecipients ? `${Math.round((totalViews / totalRecipients) * 100)}%` : '—', `${totalViews} of ${totalRecipients} recipients`],
        ].map(([label, value, hint]) => (
          <Card key={label}>
            <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular text-ink-900">{value}</p>
            <p className="text-[12px] text-ink-500">{hint}</p>
          </Card>
        ))}
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 p-4">
          <SegmentedControl value={filter} onChange={setFilter} options={[{ value: 'ALL', label: 'All' }, { value: 'DRAFT', label: 'Drafts' }, { value: 'SENT', label: 'Sent' }]} />
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No updates yet" description="Share progress with investors and the team. Recipients read updates in their portal and by email."
            action={canEdit && <Button variant="primary" onClick={openNew}>New update</Button>} />
        ) : (
          <Table>
            <thead>
              <tr><TH>Update</TH><TH>Audience</TH><TH>Status</TH><TH align="right">Recipients</TH><TH align="right">Emailed</TH><TH align="right">Opened</TH>{canEdit && <TH width={230} />}</tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <button type="button" className="text-left font-medium text-ink-900 hover:text-brand-700" onClick={() => setViewing(u)}>{u.title}</button>
                    <span className="block text-[12px] text-ink-500">{u.period ? `${u.period} · ` : ''}{u.status === 'SENT' ? `Sent ${date(String(u.sentAt).slice(0, 10))}${u.sentBy ? ` by ${u.sentBy}` : ''}` : `Drafted ${date(String(u.createdAt).slice(0, 10))}`}</span>
                  </TD>
                  <TD className="text-ink-600">{u.audience === 'CUSTOM' ? `${u.recipientIds.length} chosen` : u.audienceLabel}</TD>
                  <TD><Badge tone={u.status === 'SENT' ? 'success' : 'neutral'}>{u.status === 'SENT' ? 'Sent' : 'Draft'}</Badge></TD>
                  <TD align="right" mono>{u.status === 'SENT' ? u.recipientCount : '—'}</TD>
                  <TD align="right" mono>{u.status === 'SENT' ? u.emailedCount : '—'}</TD>
                  <TD align="right" mono>{u.status === 'SENT' ? `${u.viewedCount} (${u.recipientCount ? Math.round((u.viewedCount / u.recipientCount) * 100) : 0}%)` : '—'}</TD>
                  {canEdit && (
                    <TD align="right">
                      <span className="flex flex-wrap justify-end gap-1">
                        {u.status === 'SENT' && <Button size="sm" variant="ghost" loading={busy} onClick={() => void openDetail(u)}>Recipients</Button>}
                        {u.status === 'DRAFT' && <Button size="sm" variant="primary" loading={busy} onClick={() => void openSend(u)}>Send</Button>}
                        {u.status === 'DRAFT' && <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => openEdit(u)}><Icon name="edit" className="size-4" /></Button>}
                        <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(u)}><Icon name="trash" className="size-4" /></Button>
                      </span>
                    </TD>
                  )}
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={busy} size="lg"
        title={editing?.id ? 'Edit update' : 'New update'} onSubmit={save} submitLabel={editing?.id ? 'Save draft' : 'Save draft'}
        description="Drafts are private. Sending emails everyone in the audience who has an address and shows the update in their portal.">
        <FormGrid>
          <Field label="Title" required><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Q3 2026 investor update" required /></Field>
          <Field label="Period" hint="Optional: the quarter or month the update covers."><Input value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} placeholder="Q3 2026" /></Field>
          <Field label="Audience" required>
            <Select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              {audiences.map((a) => <option key={a.key} value={a.key}>{a.label}{a.count != null ? ` (${a.count})` : ''}</option>)}
            </Select>
          </Field>
        </FormGrid>
        {form.audience === 'CUSTOM' && (
          <div className="max-h-48 overflow-auto rounded-lg border border-ink-200 p-3">
            {(stakeholders ?? []).map((s) => (
              <Checkbox key={s.id} label={`${s.name}${s.email ? ` · ${s.email}` : ' · no email'}`} checked={form.recipientIds.includes(s.id)}
                onChange={(v) => setForm({ ...form, recipientIds: v ? [...form.recipientIds, s.id] : form.recipientIds.filter((id) => id !== s.id) })} />
            ))}
          </div>
        )}
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink-800">Headline metrics</p>
          <div className="space-y-2">
            {form.metrics.map((m, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Input value={m.label} onChange={(e) => setMetric(i, { label: e.target.value })} placeholder="ARR" />
                <Input value={m.value} onChange={(e) => setMetric(i, { value: e.target.value })} placeholder={`${currencySymbol()}4.2M (+41% QoQ)`} />
                <Button type="button" variant="ghost" aria-label="Remove metric" disabled={form.metrics.length === 1} onClick={() => setForm({ ...form, metrics: form.metrics.filter((_, idx) => idx !== i) })}>
                  <Icon name="trash" className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" size="sm" className="mt-2" icon={<Icon name="plus" />} onClick={() => setForm({ ...form, metrics: [...form.metrics, { label: '', value: '' }] })}>Add metric</Button>
        </div>
        <Field label="Update" required>
          <Textarea rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required placeholder="Highlights, lowlights, asks…" />
        </Field>
      </FormModal>

      <Modal open={!!sending} onClose={() => { setSending(null); setSendPreview(null); }} title={sending ? `Send “${sending.title}”` : 'Send update'} size="md"
        description="Recipients with an email address are emailed; everyone in the audience sees the update in their portal."
        footer={<><Button onClick={() => { setSending(null); setSendPreview(null); }}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void send()} disabled={!sendPreview?.preview?.length}>Send to {sendPreview?.preview?.length ?? 0}</Button></>}>
        {sendPreview && (
          sendPreview.preview.length === 0
            ? <Banner tone="warning" title="Nobody matches this audience">Add stakeholders with the right relationship, or choose recipients one by one.</Banner>
            : (
              <ul className="max-h-72 space-y-1 overflow-auto">
                {sendPreview.preview.map((r: any) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-ink-50">
                    <span className="font-medium text-ink-900">{r.name}</span>
                    <span className="text-[12px] text-ink-500">{r.email ?? <Badge tone="warning">No email — portal only</Badge>}</span>
                  </li>
                ))}
              </ul>
            )
        )}
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.title ?? 'Update'} size="lg" footer={<Button onClick={() => setViewing(null)}>Close</Button>}>
        {viewing && (
          <>
            {viewing.metrics.length > 0 && (
              <div className="mb-4 rounded-lg bg-ink-50 p-3">
                <KeyValue columns={Math.min(3, viewing.metrics.length) as 1 | 2 | 3} items={viewing.metrics.map((m: Metric) => ({ label: m.label, value: m.value }))} />
              </div>
            )}
            <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-800">{viewing.body}</div>
            <p className="mt-4 text-[11px] text-ink-400">{viewing.status === 'SENT' ? `Sent ${dateTime(viewing.sentAt)} to ${viewing.audience === 'CUSTOM' ? `${viewing.recipientIds.length} chosen recipients` : viewing.audienceLabel.toLowerCase()}` : 'Draft'}</p>
          </>
        )}
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Recipients — ${detail.title}` : 'Recipients'} size="lg" footer={<Button onClick={() => setDetail(null)}>Close</Button>}>
        {detail && (
          <Table>
            <thead><tr><TH>Recipient</TH><TH>Email</TH><TH>Delivery</TH><TH>Opened</TH></tr></thead>
            <tbody>
              {detail.recipients.map((r: any) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.name ?? nameOf.get(r.stakeholderId) ?? '—'}</TD>
                  <TD className="text-ink-600">{r.email ?? <span className="text-ink-400">None on file</span>}</TD>
                  <TD>{r.emailed ? <Badge tone="success">Emailed</Badge> : <Badge tone="neutral">Portal only</Badge>}</TD>
                  <TD className="text-ink-600">{r.viewedAt ? dateTime(r.viewedAt) : <span className="text-ink-400">Not yet</span>}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy} title="Delete update" confirmLabel="Delete"
        message={<>Delete <strong>{deleting?.title}</strong>?{deleting?.status === 'SENT' ? ' Recipients will no longer see it in their portal.' : ''}</>} onConfirm={() => void remove()} />
    </>
  );
}
