import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import { useSearchQuery } from '../hooks.ts';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field, Select,
  EmptyState, ConfirmDialog, SegmentedControl, useToast, Textarea, Modal, Banner, KeyValue, ActionMenu,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { Icon } from '../icons.tsx';
import { shares, pps, money, date, today, parseShares, parsePPS, AWARD_LABELS } from '../format.ts';
import { config } from '../config.ts';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, SENT: { label: 'Sent', tone: 'info' }, ACCEPTED: { label: 'Accepted', tone: 'success' },
  CONVERTED: { label: 'Granted', tone: 'brand' }, DECLINED: { label: 'Declined', tone: 'danger' }, WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'warning' },
};
const OPEN = new Set(['DRAFT', 'SENT', 'ACCEPTED']);
const AWARD_TYPES = [['ISO', 'ISO'], ['NSO', 'NSO'], ['RSU', 'RSU']];
// equity.awardType, when an offer can carry it; an offer is one of the three above.
const DEFAULT_AWARD = AWARD_TYPES.some(([v]) => v === config.equity.awardType) ? config.equity.awardType : AWARD_TYPES[0][0];

/**
 * The schedule a new offer starts on: a plain one of equity.vestingMonths with an
 * equity.cliffMonths cliff, vesting monthly, with nothing back-loaded or accelerated.
 */
const isStandardSchedule = (s: any): boolean => s.kind === 'TIME'
  && Number(s.durationMonths) === config.equity.vestingMonths && Number(s.cliffMonths) === config.equity.cliffMonths
  && s.frequency === 'MONTHLY' && !s.yearWeights && !s.milestones && !s.customTranches
  && !Number(s.accelerationSingle) && !Number(s.accelerationDouble);

const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const blank = {
  candidateName: '', candidateEmail: '', position: '', department: '', startDate: '', salary: '', poolId: '', awardType: DEFAULT_AWARD,
  quantity: '', strikePrice: '', vestingScheduleId: '', expiresOn: plusDays(config.equity.offerExpiryDays), message: '', templateId: '', signerName: '',
  signerTitle: config.equity.offerSignerTitle,
};

/** Equity offers to candidates: drafted from a template, accepted from a link, then turned into a grant. */
export default function Offers() {
  const { companyId, canEdit, user } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useQuery<{ offers: any[]; counts: Record<string, number> }>(companyId ? `/c/${companyId}/offers` : null, [companyId]);
  const { data: pools } = useQuery<any[]>(companyId ? `/c/${companyId}/pools` : null, [companyId]);
  const { data: schedules } = useQuery<any[]>(companyId ? `/c/${companyId}/vesting-schedules` : null, [companyId]);
  const { data: valuations } = useQuery<any[]>(companyId ? `/c/${companyId}/valuations` : null, [companyId]);
  const { data: templateData } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/templates` : null, [companyId]);
  const { data: contacts } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/contacts` : null, [companyId]);

  const [filter, setFilter] = useState<'OPEN' | 'ALL'>('OPEN');
  const [search, setSearch] = useSearchQuery();
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ offer: any; link: string; emailed: boolean; reason: string | null } | null>(null);
  const [viewing, setViewing] = useState<any>(null);
  const [withdrawing, setWithdrawing] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);

  const currentFmv = valuations?.find((v) => v.status === 'ACTIVE')?.fairMarketValue ?? valuations?.[0]?.fairMarketValue ?? 0;
  const templates: any[] = (templateData?.templates ?? []).filter((t: any) => t.kind === 'OFFER_LETTER');
  const shownStatus = (o: any) => (o.status === 'SENT' && o.expired ? 'EXPIRED' : o.status);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.offers ?? [])
      .filter((o) => filter === 'ALL' || OPEN.has(o.status))
      .filter((o) => !q || o.candidateName.toLowerCase().includes(q) || (o.position ?? '').toLowerCase().includes(q));
  }, [data, filter, search]);

  const openNew = () => {
    setForm({
      ...blank, poolId: pools?.[0]?.id ?? '', vestingScheduleId: schedules?.find(isStandardSchedule)?.id ?? schedules?.[0]?.id ?? '',
      strikePrice: currentFmv ? String(currentFmv / 1e6) : '', signerName: contacts?.defaultSignatory?.name ?? user?.name ?? '', signerTitle: contacts?.defaultSignatory?.title ?? blank.signerTitle,
    });
    setEditing({ id: null });
  };
  const openEdit = (o: any) => {
    setForm({
      candidateName: o.candidateName, candidateEmail: o.candidateEmail ?? '', position: o.position, department: o.department ?? '',
      startDate: o.startDate ?? '', salary: o.salaryCents != null ? String(o.salaryCents / 100) : '', poolId: o.poolId ?? '', awardType: o.awardType,
      quantity: String(o.quantity), strikePrice: o.strikePrice != null ? String(o.strikePrice / 1e6) : '', vestingScheduleId: o.vestingScheduleId ?? '',
      expiresOn: o.expiresOn ?? '', message: o.message ?? '', templateId: o.templateId ?? '', signerName: o.signerName ?? user?.name ?? '', signerTitle: o.signerTitle ?? config.equity.offerSignerTitle,
    });
    setEditing(o);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        candidateName: form.candidateName, candidateEmail: form.candidateEmail || null, position: form.position, department: form.department || null,
        startDate: form.startDate || null, salary: form.salary ? Math.round(Number(form.salary.replace(/[^0-9.]/g, '')) * 100) : null,
        poolId: form.poolId || null, awardType: form.awardType, quantity: parseShares(form.quantity),
        strikePrice: form.awardType === 'RSU' || !form.strikePrice ? null : parsePPS(form.strikePrice), vestingScheduleId: form.vestingScheduleId || null,
        expiresOn: form.expiresOn || null, message: form.message || null, templateId: form.templateId || null, signerName: form.signerName, signerTitle: form.signerTitle,
      };
      if (editing?.id) await api(`/c/${companyId}/offers/${editing.id}`, { method: 'PATCH', body });
      else await api(`/c/${companyId}/offers`, { body });
      toast(editing?.id ? 'Offer updated' : 'Offer drafted');
      setEditing(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const send = async (o: any) => {
    setBusy(true);
    try {
      const r = await api<{ offer: any; link: string; emailed: boolean; reason: string | null }>(`/c/${companyId}/offers/${o.id}/send`, { body: {} });
      setSent(r);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/offers/${withdrawing.id}/withdraw`, { body: {} });
      toast('Offer withdrawn');
      setWithdrawing(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/offers/${deleting.id}`, { method: 'DELETE' });
      toast('Offer deleted');
      setDeleting(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const convert = async (o: any) => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/offers/${o.id}/convert`, { body: {} });
      navigate(`/grants?offer=${o.id}`);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast('Link copied')).catch(() => toast('Copy the link manually', 'error')); };

  if (loading && !data) return <Loading label="Loading offers" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  const counts = data?.counts ?? {};
  const noPools = (pools ?? []).length === 0;

  // One button for the thing you came to do, the rest in the menu: five
  // side by side needed three times the width this column ever gets.
  const rowActions = (o: any) => (
    <span className="flex flex-nowrap items-center justify-end gap-1">
      {o.status === 'DRAFT' && (
        <Button size="sm" variant="primary" loading={busy} onClick={() => void send(o)}>Send</Button>
      )}
      {o.status === 'SENT' && (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void send(o)}>Resend</Button>
      )}
      {o.status === 'ACCEPTED' && (
        <Button size="sm" variant="primary" loading={busy} onClick={() => void convert(o)}>Create grant</Button>
      )}
      <ActionMenu items={[
        { label: 'View the letter', icon: 'document', onClick: () => setViewing(o) },
        ...(o.status === 'SENT' && o.link
          ? [{ label: 'Copy the accept link', icon: 'link' as const, onClick: () => copy(o.link) }] : []),
        ...(o.status === 'DRAFT' || o.status === 'SENT'
          ? [{ label: 'Edit the offer', icon: 'edit' as const, onClick: () => openEdit(o) }] : []),
        ...(o.status === 'SENT'
          ? [{ label: 'Withdraw the offer', icon: 'alert' as const, danger: true, onClick: () => setWithdrawing(o) }] : []),
        ...(['DRAFT', 'DECLINED', 'WITHDRAWN'].includes(o.status)
          ? [{ label: 'Delete', icon: 'trash' as const, danger: true, onClick: () => setDeleting(o) }] : []),
      ]} />
    </span>
  );

  return (
    <>
      <PageHeader concept="offer-letters" title="Offer letters" subtitle="Equity offers to candidates: draft from a template, send an accept link, then turn accepted offers into grants."
        actions={canEdit && <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew} disabled={noPools}>New offer</Button>} />

      {noPools && (
        <div className="mb-5"><Banner tone="warning" title="Create an equity plan first">Offers promise shares from a plan reserve. <Link to="/plans" className="underline">Set up a plan</Link> first.</Banner></div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[['DRAFT', 'Drafts', 'Not yet sent'], ['SENT', 'Awaiting an answer', 'Sent, not expired'], ['ACCEPTED', 'Accepted', 'Ready to grant'], ['CONVERTED', 'Granted', 'Turned into equity awards']].map(([k, label, hint]) => (
          <Card key={k}>
            <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular text-ink-900">{counts[k] ?? 0}</p>
            <p className="text-[12px] text-ink-500">{hint}</p>
          </Card>
        ))}
      </div>

      <DataTable caption="Offer letters" rows={rows} rowKey={(o) => o.id}
        controls={<SegmentedControl value={filter} onChange={setFilter} options={[{ value: 'OPEN', label: 'Open' }, { value: 'ALL', label: 'All offers' }]} />}
        search={{ value: search, onChange: setSearch, placeholder: 'Candidate or position', label: 'Search offers' }}
        empty={<EmptyState title={filter === 'OPEN' ? 'No open offers' : 'No offers yet'} description="Draft an offer letter with the equity package; the candidate accepts it from a link."
          action={canEdit && !noPools && <Button variant="primary" onClick={openNew}>New offer</Button>} />}
        columns={[
          { key: 'candidate', label: 'Candidate', value: (o) => o.candidateName,
            cell: (o) => (
              <>
                <p className="font-medium text-ink-900">{o.candidateName}</p>
                {o.candidateEmail && <p className="text-[12px] text-ink-500">{o.candidateEmail}</p>}
              </>
            ) },
          { key: 'position', label: 'Position', value: (o) => o.position,
            cell: (o) => <>{o.position}{o.department && <span className="block text-[12px] text-ink-500">{o.department}</span>}</> },
          { key: 'start', label: 'Start', type: 'date', value: (o) => o.startDate, className: 'text-ink-600' },
          // Sorts by the number of shares; the plan and the price sit under the figure.
          { key: 'equity', label: 'Equity', type: 'number', value: (o) => o.quantity,
            cell: (o) => (
              <>
                <span className="tabular font-medium">{shares(o.quantity)}</span> <Badge tone={o.awardType === 'RSU' ? 'info' : 'brand'}>{AWARD_LABELS[o.awardType] ?? o.awardType}</Badge>
                <span className="block text-[12px] text-ink-500">{o.poolName ?? '—'}{o.strikePrice != null && o.awardType !== 'RSU' ? ` · ${pps(o.strikePrice)}` : ''}</span>
              </>
            ) },
          { key: 'salary', label: 'Salary', type: 'money', value: (o) => o.salaryCents,
            cell: (o) => (o.salaryCents != null ? money(o.salaryCents, { compact: true }) : '—'), className: 'text-ink-600' },
          { key: 'expires', label: 'Expires', type: 'date', value: (o) => o.expiresOn, className: 'text-ink-600' },
          { key: 'status', label: 'Status', value: (o) => STATUS[shownStatus(o)]?.label ?? shownStatus(o),
            cell: (o) => {
              const st = shownStatus(o);
              return (
                <>
                  <Badge tone={STATUS[st]?.tone ?? 'neutral'}>{STATUS[st]?.label ?? st}</Badge>
                  {o.status === 'ACCEPTED' && o.acceptedAt && <span className="mt-1 block text-[11px] text-ink-500">Accepted {date(String(o.acceptedAt).slice(0, 10))} as “{o.acceptedName}”</span>}
                  {o.status === 'DECLINED' && o.declineReason && <span className="mt-1 block max-w-[220px] truncate text-[11px] text-ink-500" title={o.declineReason}>“{o.declineReason}”</span>}
                  {o.status === 'SENT' && !o.expired && o.viewedAt && <span className="mt-1 block text-[11px] text-ink-500">Opened {date(String(o.viewedAt).slice(0, 10))}</span>}
                  {o.status === 'CONVERTED' && <Link to="/grants" className="mt-1 block text-[11px] text-brand-600 hover:text-brand-700">See the grant</Link>}
                </>
              );
            } },
          { key: 'actions', label: '', width: 150, align: 'right', hidden: !canEdit, cell: rowActions },
        ]} />

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={busy} size="lg"
        title={editing?.id ? 'Edit offer' : 'New offer letter'}
        description="The letter is generated from your offer letter template. Equity is granted separately once the offer is accepted and the board has approved."
        onSubmit={save} submitLabel={editing?.id ? 'Save changes' : 'Save draft'}>
        <FormGrid>
          <Field label="Candidate" required><Input value={form.candidateName} onChange={(e) => setForm({ ...form, candidateName: e.target.value })} required /></Field>
          <Field label="Email" hint="Where the accept link is sent."><Input type="email" value={form.candidateEmail} onChange={(e) => setForm({ ...form, candidateEmail: e.target.value })} /></Field>
          <Field label="Position" required><Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} required /></Field>
          <Field label="Department"><Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
          <Field label="Start date"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
          <Field label="Base salary (per year)"><Input value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} placeholder="185000" /></Field>
          <Field label="Equity plan" required>
            <Select value={form.poolId} onChange={(e) => setForm({ ...form, poolId: e.target.value })} required>
              {(pools ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Award type" required>
            <Select value={form.awardType} onChange={(e) => setForm({ ...form, awardType: e.target.value })}>
              {AWARD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Number of shares" required><Input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="48,000" required /></Field>
          {form.awardType !== 'RSU' && (
            <Field label="Indicative exercise price" hint={currentFmv ? `Current 409A fair market value is ${pps(currentFmv)}; the final price is set at grant.` : 'Left blank, the letter says the price is set at grant.'}>
              <Input value={form.strikePrice} onChange={(e) => setForm({ ...form, strikePrice: e.target.value })} placeholder="0.96" />
            </Field>
          )}
          <Field label="Vesting schedule" required>
            <Select value={form.vestingScheduleId} onChange={(e) => setForm({ ...form, vestingScheduleId: e.target.value })} required>
              <option value="">Select a schedule</option>
              {(schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Offer expires on" required><Input type="date" value={form.expiresOn} min={today()} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} required /></Field>
          <Field label="Signed by" required><Input value={form.signerName} onChange={(e) => setForm({ ...form, signerName: e.target.value })} required /></Field>
          <Field label="Signer title" required><Input value={form.signerTitle} onChange={(e) => setForm({ ...form, signerTitle: e.target.value })} required /></Field>
          <Field label="Letter template">
            <Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
              <option value="">Default offer letter</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtIn ? ' (built-in)' : ''}</option>)}
            </Select>
          </Field>
        </FormGrid>
        <Field label="Personal note" hint="Added to the letter as its own paragraph.">
          <Textarea rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        </Field>
      </FormModal>

      <Modal open={!!sent} onClose={() => setSent(null)} title="Offer sent" size="md"
        footer={<><Button onClick={() => sent && copy(sent.link)} icon={<Icon name="copy" />}>Copy link</Button><Button variant="primary" onClick={() => setSent(null)}>Done</Button></>}>
        {sent && (
          <div className="space-y-3">
            {sent.emailed
              ? <Banner tone="success" title="Emailed to the candidate">{sent.offer.candidateName} received the accept link at {sent.offer.candidateEmail}.</Banner>
              : <Banner tone="info" title="Share the link yourself">{sent.reason ?? 'Email is not configured.'} Send the candidate this link; it works until the offer expires or is withdrawn.</Banner>}
            <Input readOnly value={sent.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
          </div>
        )}
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing ? `Offer letter — ${viewing.candidateName}` : 'Offer letter'} size="lg"
        footer={<Button onClick={() => setViewing(null)}>Close</Button>}>
        {viewing && (
          <>
            <div className="mb-3 rounded-lg bg-ink-50 p-3">
              <KeyValue columns={3} items={[
                { label: 'Status', value: STATUS[shownStatus(viewing)]?.label ?? viewing.status },
                { label: 'Sent', value: viewing.sentAt ? date(String(viewing.sentAt).slice(0, 10)) : '—' },
                { label: 'Answered', value: viewing.acceptedAt ? `Accepted ${date(String(viewing.acceptedAt).slice(0, 10))}` : viewing.declinedAt ? `Declined ${date(String(viewing.declinedAt).slice(0, 10))}` : '—' },
              ]} />
            </div>
            <div className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg border border-ink-200 bg-ink-50 p-4 font-serif text-[13px] leading-relaxed text-ink-800">{viewing.body}</div>
          </>
        )}
      </Modal>

      <ConfirmDialog open={!!withdrawing} onClose={() => setWithdrawing(null)} danger loading={busy} title="Withdraw offer" confirmLabel="Withdraw"
        message={<>Withdraw the offer to <strong>{withdrawing?.candidateName}</strong>? The accept link stops working immediately.</>} onConfirm={() => void withdraw()} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy} title="Delete offer" confirmLabel="Delete"
        message={<>Delete the offer to <strong>{deleting?.candidateName}</strong>? This cannot be undone.</>} onConfirm={() => void remove()} />
    </>
  );
}
