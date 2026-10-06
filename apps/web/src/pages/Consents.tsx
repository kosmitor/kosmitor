import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import { FormModal, FormGrid } from '../crud.tsx';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field, Select,
  EmptyState, StatusBadge, Textarea, useToast, Avatar, Checkbox, Modal, SegmentedControl, MiniBar, ConfirmDialog,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { date, dateTime, shares, percent } from '../format.ts';
import { config } from '../config.ts';

/** The share of voting shares a stockholder consent needs unless it says otherwise (equity.stockholderConsentThreshold). */
const THRESHOLD = config.equity.stockholderConsentThreshold;

type Kind = 'BOARD' | 'STOCKHOLDER';
const blank = {
  kind: 'BOARD' as Kind, title: '', type: 'WRITTEN_CONSENT', body: '', effectiveDate: new Date().toISOString().slice(0, 10),
  meetingDate: '', directorIds: [] as string[], stakeholderIds: [] as string[], threshold: String(Math.round(THRESHOLD * 10_000) / 100),
};

/** Board consents (unanimous directors) and stockholder approvals (weighted by voting shares). */
export default function Consents() {
  const { companyId, canEdit, membershipStakeholderId } = useSessionExtras();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any[]>(companyId ? `/c/${companyId}/consents` : null, [companyId]);
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const { data: capTable } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/captable` : null, [companyId]);
  const [kindFilter, setKindFilter] = useState<Kind>('BOARD');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(blank);
  const [viewing, setViewing] = useState<any>(null);
  const [voting, setVoting] = useState<{ consent: any; vote: string } | null>(null);
  const [closing, setClosing] = useState<any>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const directors = (stakeholders ?? []).filter((s) => s.relation === 'BOARD_MEMBER' || s.relation === 'FOUNDER');
  /** Holders of voting shares today, for a stockholder consent. */
  const voters: { stakeholderId: string; name: string; weight: number }[] = useMemo(() => (capTable?.table?.rows ?? [])
    .map((r: any) => ({ stakeholderId: r.stakeholderId, name: r.name, weight: r.votes > 0 ? r.votes : r.outstanding }))
    .filter((r: any) => r.weight > 0)
    .sort((a: any, b: any) => b.weight - a.weight), [capTable]);
  const totalVotes = voters.reduce((s, v) => s + v.weight, 0);

  const openNew = (kind: Kind) => {
    setForm({ ...blank, kind, type: kind === 'STOCKHOLDER' ? 'STOCKHOLDER_CONSENT' : 'WRITTEN_CONSENT', directorIds: directors.map((d) => d.id), stakeholderIds: voters.map((v) => v.stakeholderId) });
    setCreating(true);
  };
  const create = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/consents`, {
        body: {
          kind: form.kind, title: form.title, type: form.type, body: form.body,
          effectiveDate: form.effectiveDate, meetingDate: form.meetingDate || null,
          directorIds: form.kind === 'BOARD' ? form.directorIds : [],
          stakeholderIds: form.kind === 'STOCKHOLDER' ? form.stakeholderIds : [],
          threshold: form.kind === 'STOCKHOLDER' ? Number(form.threshold) / 100 : undefined,
        },
      });
      toast(form.kind === 'STOCKHOLDER' ? 'Stockholder approval opened' : 'Consent opened for signature');
      setCreating(false);
      setKindFilter(form.kind);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const castVote = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/consents/${voting!.consent.id}/vote`, { body: { vote: voting!.vote, comment: comment || null } });
      toast(`Vote recorded: ${voting!.vote.toLowerCase()}`);
      setVoting(null);
      setComment('');
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const close = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/consents/${closing.id}/close`, { body: { status: 'WITHDRAWN' } });
      toast('Consent withdrawn');
      setClosing(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  if (loading) return <Loading label="Loading approvals" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  const all = data ?? [];
  const rows = all.filter((c) => (c.kind ?? 'BOARD') === kindFilter);
  const pending = rows.filter((c) => c.status === 'PENDING');
  const countOf = (k: Kind) => all.filter((c) => (c.kind ?? 'BOARD') === k).length;

  return (
    <>
      <PageHeader concept="board-consents" title="Approvals"
        subtitle={`${rows.length} ${kindFilter === 'BOARD' ? 'board resolutions' : 'stockholder approvals'}${pending.length ? ` · ${pending.length} awaiting votes` : ''}`}
        actions={canEdit && (
          <>
            <Button icon={<Icon name="plus" />} onClick={() => openNew('STOCKHOLDER')} disabled={voters.length === 0} title={voters.length === 0 ? 'No stockholder holds voting shares yet' : undefined}>Stockholder approval</Button>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={() => openNew('BOARD')}>Board consent</Button>
          </>
        )} />

      <Card className="mb-5">
        <SegmentedControl value={kindFilter} onChange={setKindFilter} options={[
          { value: 'BOARD', label: `Board consents (${countOf('BOARD')})` }, { value: 'STOCKHOLDER', label: `Stockholder approvals (${countOf('STOCKHOLDER')})` },
        ]} />
      </Card>

      {rows.length === 0 ? (
        <Card><EmptyState icon={<Icon name="gavel" className="size-10" />} title={kindFilter === 'BOARD' ? 'No board consents' : 'No stockholder approvals'}
          description={kindFilter === 'BOARD'
            ? 'Grants, financings and plan changes need board approval. Record the resolution here and collect director votes.'
            : 'Charter amendments, plan increases and financings often need stockholder approval, weighted by voting shares.'}
          action={canEdit && <Button variant="primary" onClick={() => openNew(kindFilter)}>{kindFilter === 'BOARD' ? 'New board consent' : 'New stockholder approval'}</Button>} /></Card>
      ) : (
        <div className="space-y-4">
          {rows.map((c) => {
            const votes = c.votes ?? [];
            const weighted = (c.kind ?? 'BOARD') === 'STOCKHOLDER';
            const approved = votes.filter((v: any) => v.vote === 'APPROVE').length;
            const myVote = votes.find((v: any) => v.stakeholderId === membershipStakeholderId);
            const approvedShare = weighted && c.totalWeight ? c.approvedWeight / c.totalWeight : 0;
            return (
              <Card key={c.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold">{c.title}</h3>
                      <StatusBadge status={c.status} />
                      <Badge tone="neutral">{c.type.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </div>
                    <p className="mt-1 text-[13px] text-ink-500">
                      Effective {date(c.effectiveDate)}
                      {c.meetingDate && ` · meeting held ${date(c.meetingDate)}`}
                      {c.approvedAt && ` · approved ${dateTime(c.approvedAt)}`}
                      {weighted && c.threshold != null && ` · needs ${percent(c.threshold, 0)} of ${shares(c.totalWeight)} voting shares`}
                    </p>
                    {c.body && <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-ink-600">{c.body}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setViewing(c)}>View</Button>
                    {c.status === 'PENDING' && myVote && myVote.vote === 'PENDING' && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => { setComment(''); setVoting({ consent: c, vote: 'REJECT' }); }}>Reject</Button>
                        <Button size="sm" variant="primary" onClick={() => { setComment(''); setVoting({ consent: c, vote: 'APPROVE' }); }}>Approve</Button>
                      </>
                    )}
                    {c.status === 'PENDING' && canEdit && (
                      <Button size="sm" variant="ghost" aria-label="Withdraw" title="Withdraw this consent" onClick={() => setClosing(c)}><Icon name="trash" className="size-4" /></Button>
                    )}
                  </div>
                </div>

                <div className="mt-4 border-t border-ink-100 pt-4">
                  {weighted ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="w-56"><MiniBar value={approvedShare} tone={approvedShare >= (c.threshold ?? THRESHOLD) ? 'brand' : 'amber'} /></div>
                      <span className="text-[12px] font-medium text-ink-600">{percent(approvedShare, 1)} of voting shares approved · {shares(c.approvedWeight)} for, {shares(c.rejectedWeight)} against, {shares(c.pendingWeight)} to vote</span>
                    </div>
                  ) : (
                    <span className="text-[12px] font-medium text-ink-600">{approved} of {votes.length} directors approved</span>
                  )}
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {votes.map((v: any) => (
                      <span key={v.id} title={`${nameOf.get(v.stakeholderId)}: ${v.vote.toLowerCase()}${v.weight ? ` · ${shares(v.weight)} votes` : ''}`}
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                          v.vote === 'APPROVE' ? 'bg-secondary-50 text-secondary-800'
                            : v.vote === 'REJECT' ? 'bg-red-50 text-red-700'
                            : v.vote === 'ABSTAIN' ? 'bg-ink-100 text-ink-600'
                            : 'bg-amber-50 text-amber-700'}`}>
                        {v.vote === 'APPROVE' ? <Icon name="check" className="size-3" /> : <Icon name="clock" className="size-3" />}
                        {(nameOf.get(v.stakeholderId) ?? '?').split(' ')[0]}{weighted && v.weight ? ` · ${shares(v.weight)}` : ''}
                      </span>
                    ))}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <FormModal open={creating} onClose={() => setCreating(false)} busy={busy} size="lg"
        title={form.kind === 'STOCKHOLDER' ? 'New stockholder approval' : 'New board consent'} onSubmit={create} submitLabel="Open for votes"
        description={form.kind === 'STOCKHOLDER'
          ? 'Stockholders vote from their portal. Votes are weighted by voting shares; the approval passes when the threshold of all voting shares outstanding is reached.'
          : 'Directors vote from their portal. The consent is approved once every director has voted in favour.'}>
        <Field label="Title" required>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={form.kind === 'STOCKHOLDER' ? 'Approval of the amended and restated certificate of incorporation' : 'Approval of Q4 employee option grants'} required />
        </Field>
        <FormGrid>
          {form.kind === 'BOARD' ? (
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="WRITTEN_CONSENT">Written consent</option>
                <option value="MEETING_RESOLUTION">Meeting resolution</option>
              </Select>
            </Field>
          ) : (
            <Field label="Approval threshold (% of voting shares)" hint="50 is a simple majority; charters often require more for some matters.">
              <Input type="number" min={1} max={100} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
            </Field>
          )}
          <Field label="Effective date">
            <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
          </Field>
        </FormGrid>
        <Field label="Resolution text">
          <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={5} placeholder="Resolved, that …" />
        </Field>
        {form.kind === 'BOARD' ? (
          <Field label="Directors">
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-ink-200 p-2.5">
              {directors.length === 0
                ? <p className="text-[12px] text-ink-500">No stakeholders are marked as board members or founders.</p>
                : directors.map((d) => (
                  <Checkbox key={d.id} label={d.name} checked={form.directorIds.includes(d.id)}
                    onChange={(v) => setForm({ ...form, directorIds: v ? [...form.directorIds, d.id] : form.directorIds.filter((x) => x !== d.id) })} />
                ))}
            </div>
          </Field>
        ) : (
          <Field label="Stockholders asked to vote" hint={`${shares(totalVotes)} voting shares outstanding today. Leaving someone out does not lower the threshold.`}>
            <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-ink-200 p-2.5">
              {voters.map((v) => (
                <Checkbox key={v.stakeholderId} label={`${v.name} · ${shares(v.weight)} (${percent(totalVotes ? v.weight / totalVotes : 0, 1)})`} checked={form.stakeholderIds.includes(v.stakeholderId)}
                  onChange={(on) => setForm({ ...form, stakeholderIds: on ? [...form.stakeholderIds, v.stakeholderId] : form.stakeholderIds.filter((x) => x !== v.stakeholderId) })} />
              ))}
            </div>
          </Field>
        )}
      </FormModal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.title ?? ''} size="lg">
        {viewing && (
          <>
            <div className="whitespace-pre-wrap rounded-lg bg-ink-50 p-4 text-[13px] leading-relaxed text-ink-800">
              {viewing.body || 'No resolution text recorded.'}
            </div>
            <div className="mt-5">
              <p className="mb-2.5 text-[13px] font-semibold text-ink-800">{(viewing.kind ?? 'BOARD') === 'STOCKHOLDER' ? 'Stockholder votes' : 'Director votes'}</p>
              <ul className="space-y-2">
                {(viewing.votes ?? []).map((v: any) => (
                  <li key={v.id} className="flex items-center gap-3 rounded-lg border border-ink-200 p-3">
                    <Avatar name={nameOf.get(v.stakeholderId) ?? '?'} size={30} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{nameOf.get(v.stakeholderId) ?? 'Voter'}{v.weight ? <span className="ml-1 text-[12px] font-normal text-ink-500">· {shares(v.weight)} votes</span> : null}</p>
                      <p className="text-[11px] text-ink-500">{v.votedAt ? dateTime(v.votedAt) : 'Has not voted'}{v.comment && ` — ${v.comment}`}</p>
                    </div>
                    <StatusBadge status={v.vote} />
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Modal>

      <FormModal open={!!voting} onClose={() => setVoting(null)} busy={busy}
        title={voting?.vote === 'APPROVE' ? 'Approve' : 'Reject'} onSubmit={castVote} danger={voting?.vote === 'REJECT'}
        submitLabel={voting?.vote === 'APPROVE' ? 'Approve' : 'Reject'} description={voting?.consent?.title}>
        <Field label="Comment">
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Optional note recorded with your vote." />
        </Field>
      </FormModal>

      <ConfirmDialog open={!!closing} onClose={() => setClosing(null)} danger loading={busy} title="Withdraw consent" confirmLabel="Withdraw"
        message={<>Withdraw <strong>{closing?.title}</strong>? Votes already cast stay on record; anything waiting on this approval stays pending until you withdraw it too.</>}
        onConfirm={() => void close()} />
    </>
  );
}

/** Small wrapper so the page can read the viewer's linked stakeholder id. */
function useSessionExtras() {
  const s = useSession();
  return { ...s, membershipStakeholderId: s.company?.stakeholderId ?? null };
}
