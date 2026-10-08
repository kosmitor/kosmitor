import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery, api, downloadFile } from '../api.ts';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, StatusBadge, SegmentedControl, useToast,
  Checkbox, MiniBar, Banner, KeyValue, Textarea, Modal, ActionMenu,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { Icon } from '../icons.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { DocumentPreview } from '../PdfFrame.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { readableDocumentPath, documentFilename, categoryLabel, documentAccess, newestPerHolding, downloadDocumentPath } from '../documents.ts';
import { shares, pps, money, date, today, percent, parseShares, parsePPS, AWARD_LABELS } from '../format.ts';
import ExerciseRequests from './ExerciseRequests.tsx';
import { useSearchQuery } from '../hooks.ts';
import { config } from '../config.ts';
import { directorsOn, reselectDirectors } from '../board.ts';

const AWARD_TYPES = [
  ['ISO', 'Incentive stock option (ISO)'],
  ['NSO', 'Non-qualified stock option (NSO)'],
  ['RSU', 'Restricted stock unit (RSU)'],
  ['SAR', 'Stock appreciation right (SAR)'],
  ['PHANTOM', 'Phantom stock'],
];
// equity.awardType, when a grant can be one; otherwise the first of the list above.
const DEFAULT_AWARD = AWARD_TYPES.some(([v]) => v === config.equity.awardType) ? config.equity.awardType : AWARD_TYPES[0][0];

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** An option's usual term (equity.optionTermYears) in words: "ten years". */
const TERM = `${WORDS[config.equity.optionTermYears] ?? config.equity.optionTermYears} year${config.equity.optionTermYears === 1 ? '' : 's'}`;

/** Grants that exist but are not yet outstanding: they sit outside the cap table until approved and signed. */
const IN_FLIGHT = new Set(['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE']);
type Approval = 'APPROVED' | 'REQUEST' | 'NONE';

const blank = {
  label: '', stakeholderId: '', poolId: '', type: DEFAULT_AWARD, quantity: '',
  strikePrice: '', grantDate: today(), vestingStartDate: '', vestingScheduleId: '',
  expirationDate: '', ptepMonths: String(config.equity.postTerminationExerciseMonths), earlyExerciseAllowed: false,
  boardApprovalDate: today(), fmvAtGrant: '', notes: '', effectiveDate: '', reason: '',
};
const blankIssue = {
  approval: 'APPROVED' as Approval, directorIds: [] as string[], forSignature: true,
  signerName: '', signerTitle: config.equity.signerTitle, templateId: '', message: '',
};

export default function Grants() {
  const { companyId, canEdit, user } = useSession();
  const crud = useCrud<any>('awards');
  const toast = useToast();
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const { data: pools } = useQuery<any[]>(companyId ? `/c/${companyId}/pools` : null, [companyId]);
  const { data: schedules } = useQuery<any[]>(companyId ? `/c/${companyId}/vesting-schedules` : null, [companyId]);
  const { data: valuations } = useQuery<any[]>(companyId ? `/c/${companyId}/valuations` : null, [companyId]);
  const { data: poolSummary, reload: reloadPools } = useQuery<any[]>(companyId ? `/c/${companyId}/pools/summary` : null, [companyId]);
  const { data: documents, reload: reloadDocuments } = useQuery<any[]>(companyId ? `/c/${companyId}/documents` : null, [companyId]);
  const { data: templateData } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/templates` : null, [companyId]);
  const { data: contacts } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/contacts` : null, [companyId]);

  const [search, setSearch] = useSearchQuery();
  const [status, setStatus] = useState<'OUTSTANDING' | 'ALL'>('OUTSTANDING');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [issue, setIssue] = useState(blankIssue);
  const [confirmCancel, setConfirmCancel] = useState<any>(null);
  const [cancel, setCancel] = useState({ quantity: '', date: today(), reason: '' });
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  const [exercising, setExercising] = useState<any>(null);
  const [exercise, setExercise] = useState({ quantity: '', exerciseDate: today(), method: 'CASH', notes: '' });
  const [exercisePreview, setExercisePreview] = useState<any>(null);
  const [countersigning, setCountersigning] = useState<any>(null);
  const [signature, setSignature] = useState('');
  const [viewing, setViewing] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [withdrawing, setWithdrawing] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [searchParams] = useSearchParams();
  const offerParam = searchParams.get('offer');
  const [offer, setOffer] = useState<any>(null);
  const openedOffer = useRef<string | null>(null);

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const scheduleOf = useMemo(() => new Map((schedules ?? []).map((s) => [s.id, s])), [schedules]);
  // The consent takes effect on the grant date, so it goes to the board of that day.
  const directors = useMemo(() => directorsOn(stakeholders, form.grantDate), [stakeholders, form.grantDate]);
  /** The award agreement behind a grant, with its signature blocks. */
  const agreementOf = useMemo(() => newestPerHolding((documents ?? []).filter((d) => d.category === 'GRANT_AGREEMENT')), [documents]);
  /**
   * Everything filed against a grant, newest first. The agreement the app writes is
   * only one of them: a signed copy someone uploaded, an 83(b) filing or a side
   * letter is filed the same way and is just as much a part of the row.
   */
  const filedOn = useMemo(() => {
    const byGrant = new Map<string, any[]>();
    for (const d of documents ?? []) {
      if (!d.securityId) continue;
      byGrant.set(d.securityId, [...(byGrant.get(d.securityId) ?? []), d]);
    }
    return byGrant;
  }, [documents]);
  const blocksOf = (a: any): any[] => agreementOf.get(a.id)?.signatures ?? [];
  const companyBlock = (a: any) => blocksOf(a).find((s) => !s.stakeholderId);
  const holderBlock = (a: any) => blocksOf(a).find((s) => s.stakeholderId);
  const currentFmv = valuations?.find((v) => v.status === 'ACTIVE')?.fairMarketValue
    ?? valuations?.[0]?.fairMarketValue ?? 0;
  const settlesForFree = form.type === 'RSU' || form.type === 'PHANTOM';
  const templateKind = settlesForFree ? 'RSU_AGREEMENT' : 'OPTION_AGREEMENT';
  const templates: any[] = (templateData?.templates ?? []).filter((t: any) => t.kind === templateKind);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return crud.items
      .filter((a) => status === 'ALL' || a.status === 'OUTSTANDING' || IN_FLIGHT.has(a.status))
      .filter((a) => !q || (nameOf.get(a.stakeholderId) ?? '').toLowerCase().includes(q)
        || (a.label ?? '').toLowerCase().includes(q));
  }, [crud.items, search, status, nameOf]);

  const outstandingOf = (a: any) => Math.max(0, a.quantity - a.exercisedQuantity - a.cancelledQuantity);
  const refreshAll = () => { crud.reload(); reloadPools(); reloadDocuments(); };

  /**
   * Open a document filed against a grant. Most are read on screen, but an
   * uploaded file that is not a PDF has no page to render, so it is handed over
   * as a file rather than opening an empty reader.
   */
  const openDocument = (d: any) => {
    if (!companyId) return;
    if (readableDocumentPath(companyId, d)) { setReading(d); return; }
    downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));
  };

  const openNew = () => {
    setForm({
      ...blank, poolId: pools?.[0]?.id ?? '',
      vestingScheduleId: schedules?.[0]?.id ?? '',
      strikePrice: currentFmv ? String(currentFmv / 1e6) : '',
      fmvAtGrant: currentFmv ? String(currentFmv / 1e6) : '',
    });
    setIssue({ ...blankIssue, signerName: contacts?.defaultSignatory?.name ?? user?.name ?? '', signerTitle: contacts?.defaultSignatory?.title ?? blankIssue.signerTitle, directorIds: directorsOn(stakeholders, blank.grantDate).map((d) => d.id) });
    setEditing({ id: null });
  };

  // An accepted offer letter lands here with its equity package filled in; the grant closes the offer.
  useEffect(() => {
    if (!offerParam || !companyId || !pools || !schedules || openedOffer.current === offerParam) return;
    openedOffer.current = offerParam;
    api<any>(`/c/${companyId}/offers/${offerParam}`).then((o) => {
      if (o.status !== 'ACCEPTED' || !o.stakeholderId) return;
      setOffer(o);
      setForm({
        ...blank, stakeholderId: o.stakeholderId, poolId: o.poolId ?? pools[0]?.id ?? '', type: o.awardType, quantity: String(o.quantity),
        strikePrice: o.strikePrice != null ? String(o.strikePrice / 1e6) : currentFmv ? String(currentFmv / 1e6) : '',
        fmvAtGrant: currentFmv ? String(currentFmv / 1e6) : o.strikePrice != null ? String(o.strikePrice / 1e6) : '',
        vestingStartDate: o.startDate ?? '', vestingScheduleId: o.vestingScheduleId ?? schedules[0]?.id ?? '',
        notes: `From the offer letter accepted ${String(o.acceptedAt ?? '').slice(0, 10)} for the ${o.position} role.`,
      });
      setIssue({ ...blankIssue, signerName: contacts?.defaultSignatory?.name ?? user?.name ?? '', signerTitle: contacts?.defaultSignatory?.title ?? blankIssue.signerTitle, directorIds: directorsOn(stakeholders, blank.grantDate).map((d) => d.id) });
      setEditing({ id: null });
    }).catch(() => undefined);
  }, [offerParam, companyId, pools, schedules, currentFmv, stakeholders, user, contacts]);

  // "Issue an equity grant" from the search palette lands here with the form already open.
  const newParam = searchParams.get('new');
  const openedNew = useRef(false);
  useEffect(() => {
    if (!newParam || openedNew.current || !canEdit || !pools || pools.length === 0 || !schedules) return;
    openedNew.current = true;
    openNew();
  }, [newParam, canEdit, pools, schedules]);

  const openEdit = (a: any) => {
    setForm({
      label: a.label ?? '', stakeholderId: a.stakeholderId, poolId: a.poolId, type: a.type,
      quantity: String(a.quantity), strikePrice: String(a.strikePrice / 1e6), grantDate: a.grantDate,
      vestingStartDate: a.vestingStartDate, vestingScheduleId: a.vestingScheduleId,
      expirationDate: a.expirationDate ?? '', ptepMonths: String(a.ptepMonths),
      earlyExerciseAllowed: !!a.earlyExerciseAllowed, boardApprovalDate: a.boardApprovalDate ?? '',
      fmvAtGrant: String(a.fmvAtGrant / 1e6), notes: a.notes ?? '', effectiveDate: a.grantDate, reason: '',
    });
    setEditing(a);
  };
  /** An issued grant whose holder, plan or grant date is being changed: a correction that needs a reason. */
  const retyped = !!editing?.id && !IN_FLIGHT.has(editing.status)
    && (form.stakeholderId !== editing.stakeholderId || form.poolId !== editing.poolId || form.grantDate !== editing.grantDate);

  /** An issued grant whose count or terms (strike, vesting, expiry) change: a correction dated in the ledger. */
  const redated = !!editing?.id && (parseShares(form.quantity) !== Number(editing.quantity)
    || form.type !== editing.type || parsePPS(form.strikePrice) !== Number(editing.strikePrice)
    || (form.vestingStartDate || form.grantDate) !== editing.vestingStartDate || form.vestingScheduleId !== editing.vestingScheduleId
    || (form.expirationDate || null) !== (editing.expirationDate ?? null) || Number(form.ptepMonths) !== Number(editing.ptepMonths)
    || parsePPS(form.fmvAtGrant || form.strikePrice) !== Number(editing.fmvAtGrant));

  const save = async () => {
    const payload = {
      label: form.label || null, stakeholderId: form.stakeholderId, poolId: form.poolId,
      type: form.type, quantity: parseShares(form.quantity),
      strikePrice: settlesForFree ? 0 : parsePPS(form.strikePrice),
      grantDate: form.grantDate, vestingStartDate: form.vestingStartDate || form.grantDate,
      vestingScheduleId: form.vestingScheduleId,
      expirationDate: form.expirationDate || null, ptepMonths: Number(form.ptepMonths) || config.equity.postTerminationExerciseMonths,
      earlyExerciseAllowed: form.earlyExerciseAllowed,
      fmvAtGrant: parsePPS(form.fmvAtGrant || form.strikePrice), notes: form.notes || null,
    };
    if (editing?.id) {
      // A changed share count is a correction, dated in the ledger (docs/design/dated-ledger.md).
      const ok = await crud.update(editing.id, { ...payload, boardApprovalDate: form.boardApprovalDate || null, status: editing.status ?? 'OUTSTANDING', effectiveDate: form.effectiveDate || form.grantDate, reason: form.reason || undefined }, 'Grant updated');
      if (ok) { setEditing(null); reloadPools(); }
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ award: any; emailed?: boolean }>(`/c/${companyId}/awards/issue`, {
        body: {
          ...payload, approval: issue.approval, offerId: offer?.id ?? null,
          boardApprovalDate: issue.approval === 'APPROVED' ? form.boardApprovalDate || today() : null,
          directorIds: issue.approval === 'REQUEST' ? issue.directorIds.filter((d) => directors.some((x) => x.id === d)) : [],
          signing: issue.forSignature
            ? { signerName: issue.signerName, signerTitle: issue.signerTitle, templateId: issue.templateId || null, message: issue.message || null }
            : null,
        },
      });
      toast(r.award.status === 'PENDING_APPROVAL' ? `Grant ${r.award.label} drafted — board approval requested`
        : r.award.status === 'PENDING_SIGNATURE' ? `Agreement for ${r.award.label} sent for signature` : `Grant ${r.award.label} recorded`);
      setEditing(null);
      setOffer(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const countersign = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/signatures/${countersigning.id}/sign`, { body: { typedSignature: signature } });
      toast('Signed for the Company');
      setCountersigning(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remind = async (a: any) => {
    setBusy(true);
    try {
      const r = await api<{ emailed: boolean; reason: string | null }>(`/c/${companyId}/awards/${a.id}/remind`, { body: {} });
      toast(r.emailed ? 'Reminder emailed to the holder' : `Not emailed — ${r.reason}`, r.emailed ? 'success' : 'error');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/awards/${withdrawing.id}/cancel-signing`, { body: {} });
      toast('Grant withdrawn');
      setWithdrawing(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  // The quantity is in options as the grant records them, as the exercise takes
  // it; the preview converts it into the shares of the exercise date.
  const previewExercise = async (award: any, quantity: string, exerciseDate: string) => {
    const qty = parseShares(quantity);
    if (!qty) { setExercisePreview(null); return; }
    try {
      const res = await api(`/c/${companyId}/model/exercise`, { body: { awardId: award.id, quantity: qty, asOf: exerciseDate } });
      setExercisePreview(res.scenario);
    } catch { setExercisePreview(null); }
  };

  const doExercise = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/awards/${exercising.id}/exercise`, {
        body: {
          quantity: parseShares(exercise.quantity), exerciseDate: exercise.exerciseDate,
          method: exercise.method, notes: exercise.notes || null,
        },
      });
      toast('Options exercised and shares issued');
      setExercising(null);
      setExercisePreview(null);
      crud.reload();
      reloadPools();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/awards/${confirmCancel.id}/cancel`, {
        body: { quantity: parseShares(cancel.quantity), date: cancel.date, reason: cancel.reason || 'Cancelled' },
      });
      toast('Grant cancelled');
      setConfirmCancel(null);
      crud.reload();
      reloadPools();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  if (crud.loading) return <Loading label="Loading equity grants" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  const outstandingRows = rows.filter((a) => a.status === 'OUTSTANDING');
  const inFlight = crud.items.filter((a) => IN_FLIGHT.has(a.status)).length;
  const totalOutstanding = outstandingRows.reduce((s, a) => s + outstandingOf(a), 0);
  const noPools = (pools ?? []).length === 0;
  const submitLabel = editing?.id ? 'Save changes'
    : issue.approval === 'REQUEST' ? 'Request board approval'
    : issue.forSignature ? 'Send for signature' : 'Record grant';

  const grantNoOf = (a: any): string => a.label ?? a.id.slice(-6).toUpperCase();
  /** What the outstanding options are worth over their strike today, in cents; nothing for one underwater. */
  const intrinsicOf = (a: any): number => Math.max(0, Math.round((outstandingOf(a) * (currentFmv - a.strikePrice)) / 1e4));
  const underwaterOf = (a: any): boolean => a.strikePrice > currentFmv && a.type !== 'RSU';

  /** The status, the consent or signatures it waits on, and what is filed against the grant. */
  const statusCell = (a: any) => {
    const blocks = blocksOf(a);
    return (
      <>
        <StatusBadge status={a.status} />
        {a.status === 'PENDING_APPROVAL' && (
          <Link to="/consents" className="mt-1 block text-[11px] text-brand-600 hover:text-brand-700">Board consent pending</Link>
        )}
        {a.status === 'PENDING_SIGNATURE' && blocks.length > 0 && (
          <span className="mt-1 block text-[11px] text-ink-500">
            {blocks.filter((s) => s.status === 'SIGNED').length} of {blocks.length} signed
            {blocks.some((s) => s.status !== 'SIGNED') && ` · waiting for ${blocks.filter((s) => s.status !== 'SIGNED').map((s) => (s.stakeholderId ? nameOf.get(s.stakeholderId) ?? s.signerName : 'the Company')).join(' and ')}`}
          </span>
        )}
        {(filedOn.get(a.id) ?? []).map((d) => {
          // The agreement the app wrote keeps its own viewer, which carries the
          // signature blocks and the countersign flow; anything else is a file.
          const isAgreement = agreementOf.get(a.id)?.id === d.id;
          const executed = isAgreement && a.status === 'OUTSTANDING' && d.status === 'EXECUTED';
          // A document with neither text nor a stored file has nothing behind it,
          // so its name is stated rather than offered as something to open. The
          // app's own agreement always has text, so it is never in this case.
          if (!isAgreement && documentAccess(companyId!, d) === 'none') {
            return (
              <span key={d.id} className="mt-1 block max-w-[13rem] truncate text-[11px] text-ink-500" title={d.name}>
                {d.name}
              </span>
            );
          }
          return (
            <button key={d.id} title={d.name}
              className="mt-1 block max-w-[13rem] truncate text-left text-[11px] text-brand-600 hover:text-brand-700"
              onClick={() => (isAgreement ? setViewing(d) : openDocument(d))}>
              {executed ? 'Signed agreement' : d.name}
            </button>
          );
        })}
      </>
    );
  };

  // At most one button for the thing this row is waiting on and the rest in
  // the menu: four side by side wrapped into a ragged block. The menu itself
  // is here for every role, because the documents are worth reading whether
  // or not you may change anything.
  const rowActions = (a: any) => {
    const pending = IN_FLIGHT.has(a.status);
    return (
      <span className="flex flex-nowrap items-center justify-end gap-1">
        {canEdit && pending && (
          companyBlock(a)?.status === 'PENDING' ? (
            <Button size="sm" variant="primary" onClick={() => { setSignature(user?.name ?? ''); setCountersigning({ ...companyBlock(a), document: agreementOf.get(a.id) }); }}>Countersign</Button>
          ) : holderBlock(a)?.status === 'PENDING' ? (
            <Button size="sm" loading={busy} onClick={() => void remind(a)}>Remind</Button>
          ) : null
        )}
        <ActionMenu items={[
          { label: 'Documents', icon: 'document', onClick: () => setDocumentsFor(a) },
          ...(pending && agreementOf.get(a.id)
            ? [{ label: 'View the agreement', icon: 'eye' as const, onClick: () => setViewing(agreementOf.get(a.id)) }] : []),
          ...(canEdit && pending && companyBlock(a)?.status === 'PENDING' && holderBlock(a)?.status === 'PENDING'
            ? [{ label: 'Remind the holder', icon: 'megaphone' as const, onClick: () => { void remind(a); } }] : []),
          ...(canEdit && !pending && a.status === 'OUTSTANDING' && a.type !== 'RSU' && a.type !== 'PHANTOM'
            ? [{ label: 'Exercise the grant', icon: 'check' as const,
                onClick: () => { setExercise({ quantity: '', exerciseDate: today(), method: 'CASH', notes: '' }); setExercisePreview(null); setExercising(a); } }] : []),
          ...(canEdit && !pending
            ? [{ label: 'Edit the grant', icon: 'edit' as const, onClick: () => openEdit(a) }] : []),
          ...(canEdit && pending
            ? [{ label: 'Withdraw before signing', icon: 'trash' as const, danger: true, onClick: () => setWithdrawing(a) }] : []),
          ...(canEdit && !pending && a.status === 'OUTSTANDING'
            ? [{ label: 'Cancel the grant', icon: 'trash' as const, danger: true, onClick: () => { setCancel({ quantity: String(outstandingOf(a)), date: today(), reason: '' }); setConfirmCancel(a); } }] : []),
        ]} />
      </span>
    );
  };

  return (
    <>
      <PageHeader concept="equity-awards" title="Equity grants"
        subtitle={`${shares(totalOutstanding)} shares under ${outstandingRows.length} outstanding grants${inFlight ? ` · ${inFlight} in flight` : ''}`}
        actions={canEdit && (
          <>
            <Link to="/import?kind=grants"><Button icon={<Icon name="inbox" />}>Import</Button></Link>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew} disabled={noPools}>New grant</Button>
          </>
        )} />

      {noPools && (
        <div className="mb-5">
          <Banner tone="warning" title="Create an equity plan first">
            Grants are made from a plan reserve. <Link to="/plans" className="underline">Set up a plan</Link> before issuing awards.
          </Banner>
        </div>
      )}

      {(poolSummary ?? []).length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {poolSummary!.map((p) => (
            <Card key={p.poolId}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-[13px] font-medium">{p.name}</p>
                <span className="shrink-0 text-[12px] tabular text-ink-500">{percent(p.utilizationPct, 0)}</span>
              </div>
              <div className="mt-2"><MiniBar value={p.utilizationPct} tone={p.available < 0 ? 'amber' : 'brand'} /></div>
              <div className="mt-2 flex justify-between text-[12px] tabular text-ink-500">
                <span>{shares(p.granted - p.cancelledReturned)} granted</span>
                <span className={p.available < 0 ? 'font-medium text-red-600' : ''}>{shares(p.available)} available</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <DataTable caption="Equity grants" rows={rows} rowKey={(a) => a.id}
        controls={<SegmentedControl value={status} onChange={setStatus} options={[
          { value: 'OUTSTANDING', label: 'Outstanding & in flight' }, { value: 'ALL', label: 'All grants' },
        ]} />}
        search={{ value: search, onChange: setSearch, placeholder: 'Holder or grant number', label: 'Search grants' }}
        empty={<EmptyState title="No grants" description="Issue options or RSUs from an equity plan."
          action={canEdit && !noPools && <Button variant="primary" onClick={openNew}>New grant</Button>} />}
        columns={[
          { key: 'grant', label: 'Grant', value: grantNoOf, className: 'font-medium',
            // The number is the grant, so it opens the grant, whatever the role:
            // reading one is not editing it.
            cell: (a) => (
              <Link to={`/grants/${a.id}`}
                className="cursor-pointer text-left font-medium text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-400">
                {grantNoOf(a)}
              </Link>
            ) },
          { key: 'holder', label: 'Holder', value: (a) => nameOf.get(a.stakeholderId),
            cell: (a) => <Link to={`/stakeholders/${a.stakeholderId}`} className="hover:text-brand-700">{nameOf.get(a.stakeholderId) ?? '—'}</Link> },
          { key: 'type', label: 'Type', value: (a) => AWARD_LABELS[a.type] ?? a.type,
            cell: (a) => <Badge tone={a.type === 'ISO' ? 'brand' : a.type === 'RSU' ? 'info' : 'neutral'}>{AWARD_LABELS[a.type] ?? a.type}</Badge> },
          { key: 'granted', label: 'Granted', type: 'number', value: (a) => a.quantity },
          // A grant still in flight has nothing outstanding yet, and no value; it shows a dash and sorts last.
          { key: 'outstanding', label: 'Outstanding', type: 'number', value: (a) => (IN_FLIGHT.has(a.status) ? null : outstandingOf(a)),
            className: (a) => (IN_FLIGHT.has(a.status) ? 'text-ink-400' : 'font-medium') },
          { key: 'strike', label: 'Strike', type: 'price', value: (a) => (a.type === 'RSU' ? null : a.strikePrice),
            cell: (a) => (a.type === 'RSU' ? '—' : pps(a.strikePrice)) },
          { key: 'intrinsic', label: 'Intrinsic value', type: 'money', value: (a) => (IN_FLIGHT.has(a.status) ? null : intrinsicOf(a)),
            cell: (a) => (IN_FLIGHT.has(a.status) ? '—' : underwaterOf(a) ? 'Underwater' : money(intrinsicOf(a), { compact: true })),
            className: (a) => (IN_FLIGHT.has(a.status) || underwaterOf(a) ? 'text-ink-400' : 'text-secondary-800') },
          { key: 'vesting', label: 'Vesting', value: (a) => scheduleOf.get(a.vestingScheduleId)?.name, className: 'text-[12px] text-ink-600' },
          { key: 'status', label: 'Status', value: (a) => a.status, cell: statusCell },
          { key: 'actions', label: '', width: 150, align: 'right', cell: rowActions },
        ]} />

      <Modal open={!!documentsFor} onClose={() => { setDocumentsFor(null); reloadDocuments(); }} size="lg" title="Documents"
        description={documentsFor
          ? `Filed against ${documentsFor.label ?? String(documentsFor.id).slice(-6).toUpperCase()}, held by ${nameOf.get(documentsFor.stakeholderId) ?? 'this holder'}.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} securityId={documentsFor.id} stakeholderId={documentsFor.stakeholderId} />
        )}
      </Modal>

      {/* Exercise requests raised by holders, for the company to act on */}
      <ExerciseRequests />

      {/* Grant form */}
      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={crud.busy || busy} size="lg"
        title={editing?.id ? 'Edit grant' : offer ? `Grant for ${offer.candidateName}'s accepted offer` : 'New equity grant'}
        description="Options must be struck at or above the current 409A fair market value to stay outside section 409A."
        onSubmit={save} submitLabel={submitLabel}>
        <FormGrid>
          <Field label="Recipient" required>
            <Select value={form.stakeholderId} onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })} required>
              <option value="">Select a stakeholder</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Award type" required>
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {AWARD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Equity plan" required>
            <Select value={form.poolId} onChange={(e) => setForm({ ...form, poolId: e.target.value })} required>
              {(pools ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Grant number" hint="Left blank, the next number is assigned.">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="OPT-42" />
          </Field>
          <Field label="Number of shares" required>
            <Input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="50,000" required />
          </Field>
          {redated && (
            <Field label="Correct from" hint="The ledger dates the change. Keep the grant date if the old count or terms were always wrong.">
              <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
            </Field>
          )}
          {retyped && (
            <Field label="Reason for the correction" required hint="A changed holder, plan or grant date says the record was always wrong, on every date.">
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Entered against the wrong holder" required />
            </Field>
          )}
          {!settlesForFree && (
            <Field label="Strike price" required
              hint={currentFmv ? `Current 409A fair market value is ${pps(currentFmv)}.` : 'No 409A valuation on file.'}
              error={form.strikePrice && parsePPS(form.strikePrice) < currentFmv
                ? 'Below the current fair market value — this creates 409A exposure.' : null}>
              <Input value={form.strikePrice} onChange={(e) => setForm({ ...form, strikePrice: e.target.value })} placeholder="0.96" />
            </Field>
          )}
          <Field label="Grant date" required>
            <Input type="date" value={form.grantDate} required onChange={(e) => {
              setForm({ ...form, grantDate: e.target.value });
              // The consent goes to the board of the grant date: who joined it by then is asked too, and who left is not.
              setIssue({ ...issue, directorIds: reselectDirectors(issue.directorIds, stakeholders, form.grantDate, e.target.value) });
            }} />
          </Field>
          <Field label="Vesting start date" hint="Often the hire date rather than the grant date.">
            <Input type="date" value={form.vestingStartDate} onChange={(e) => setForm({ ...form, vestingStartDate: e.target.value })} />
          </Field>
          <Field label="Vesting schedule" required>
            <Select value={form.vestingScheduleId} onChange={(e) => setForm({ ...form, vestingScheduleId: e.target.value })} required>
              <option value="">Select a schedule</option>
              {(schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          {editing?.id && (
            <Field label="Board approval date" hint="Grants are not valid until approved.">
              <Input type="date" value={form.boardApprovalDate} onChange={(e) => setForm({ ...form, boardApprovalDate: e.target.value })} />
            </Field>
          )}
          <Field label="Expiration date" hint={`Usually ${TERM} from grant.`}>
            <Input type="date" value={form.expirationDate} onChange={(e) => setForm({ ...form, expirationDate: e.target.value })} />
          </Field>
          <Field label="Post-termination exercise window (months)">
            <Input type="number" value={form.ptepMonths} onChange={(e) => setForm({ ...form, ptepMonths: e.target.value })} />
          </Field>
        </FormGrid>
        <Checkbox label="Allow early exercise of unvested shares"
          hint="Exercised shares remain subject to repurchase until vested. Recipients should file an 83(b) election within 30 days."
          checked={form.earlyExerciseAllowed} onChange={(v) => setForm({ ...form, earlyExerciseAllowed: v })} />
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </Field>

        {!editing?.id && (
          <>
            <div className="rounded-lg border border-ink-200 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-semibold text-ink-900">Board approval</p>
                <SegmentedControl value={issue.approval} onChange={(v: Approval) => setIssue({ ...issue, approval: v })} options={[
                  { value: 'APPROVED', label: 'Already approved' }, { value: 'REQUEST', label: 'Request approval' }, { value: 'NONE', label: 'Not recorded' },
                ]} />
              </div>
              {issue.approval === 'APPROVED' && (
                <div className="mt-3 max-w-xs">
                  <Field label="Board approval date" hint="From the consent or minutes that approved the grant.">
                    <Input type="date" value={form.boardApprovalDate} onChange={(e) => setForm({ ...form, boardApprovalDate: e.target.value })} />
                  </Field>
                </div>
              )}
              {issue.approval === 'REQUEST' && (
                <div className="mt-3">
                  <p className="mb-2 text-[12px] text-ink-600">
                    A written consent is drafted for the directors below. The grant goes out for signature once they have approved it.
                  </p>
                  {directors.length === 0 ? (
                    <p className="text-[12px] text-amber-700">Nobody holds a board seat on the grant date — give each director a seat on their stakeholder record first.</p>
                  ) : directors.map((d) => (
                    <Checkbox key={d.id} label={d.name} checked={issue.directorIds.includes(d.id)}
                      onChange={(v) => setIssue({ ...issue, directorIds: v ? [...issue.directorIds, d.id] : issue.directorIds.filter((id) => id !== d.id) })} />
                  ))}
                </div>
              )}
              {issue.approval === 'NONE' && (
                <p className="mt-3 text-[12px] text-ink-500">The grant is recorded without an approval date; the compliance checks will flag it until one is added.</p>
              )}
            </div>

            <div className="rounded-lg border border-ink-200 p-3.5">
              <Checkbox label="Send the award agreement for e-signature"
                hint={issue.approval === 'REQUEST'
                  ? 'After the board approves, the holder signs in their portal and the Company countersigns. The grant is outstanding once both have signed.'
                  : 'The holder signs in their portal and the Company countersigns. The grant is outstanding once both have signed.'}
                checked={issue.forSignature} onChange={(v) => setIssue({ ...issue, forSignature: v })} />
              {issue.forSignature && (
                <div className="mt-3 space-y-3">
                  <FormGrid>
                    <Field label="Company signatory" required>
                      <Input value={issue.signerName} onChange={(e) => setIssue({ ...issue, signerName: e.target.value })} required />
                    </Field>
                    <Field label="Signatory title" required>
                      <Input value={issue.signerTitle} onChange={(e) => setIssue({ ...issue, signerTitle: e.target.value })} required />
                    </Field>
                    <Field label="Agreement template">
                      <Select value={issue.templateId} onChange={(e) => setIssue({ ...issue, templateId: e.target.value })}>
                        <option value="">Default for this award type</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>{t.name}{t.builtIn ? ' (built-in)' : ''}{t.isDefault && !t.builtIn ? ' — default' : ''}</option>
                        ))}
                      </Select>
                    </Field>
                  </FormGrid>
                  <Field label="Message to the recipient" hint="Appears in the agreement as a note from the Company.">
                    <Textarea rows={2} value={issue.message} onChange={(e) => setIssue({ ...issue, message: e.target.value })} />
                  </Field>
                  <p className="text-[12px] text-ink-500">
                    Agreements are generated from <Link to="/templates" className="underline">your document templates</Link>.
                  </p>
                </div>
              )}
              {!issue.forSignature && issue.approval !== 'REQUEST' && (
                <p className="mt-3 text-[12px] text-ink-500">The grant is recorded as outstanding immediately, as if a signed agreement were on file.</p>
              )}
            </div>
          </>
        )}
      </FormModal>

      {/* Exercise */}
      <FormModal open={!!exercising} onClose={() => { setExercising(null); setExercisePreview(null); }} busy={busy}
        title="Exercise options" submitLabel="Record exercise" onSubmit={doExercise}
        description="Vested shares only, unless the grant allows early exercise. Shares are issued and the transaction is written to the ledger.">
        {exercising && (
          <>
            <div className="rounded-lg bg-ink-50 p-3">
              <KeyValue columns={3} items={[
                { label: 'Grant', value: exercising.label ?? exercising.id.slice(-6) },
                { label: 'Strike price', value: pps(exercising.strikePrice) },
                { label: 'Outstanding', value: shares(outstandingOf(exercising)) },
              ]} />
            </div>
            <FormGrid>
              <Field label="Shares to exercise" required>
                <Input value={exercise.quantity} required
                  onChange={(e) => { setExercise({ ...exercise, quantity: e.target.value }); void previewExercise(exercising, e.target.value, exercise.exerciseDate); }}
                  placeholder="10,000" />
              </Field>
              <Field label="Exercise date">
                <Input type="date" value={exercise.exerciseDate} onChange={(e) => { setExercise({ ...exercise, exerciseDate: e.target.value }); void previewExercise(exercising, exercise.quantity, e.target.value); }} />
              </Field>
            </FormGrid>
            <Field label="Method"
              hint="A net exercise withholds shares to cover the strike instead of taking cash.">
              <Select value={exercise.method} onChange={(e) => setExercise({ ...exercise, method: e.target.value })}>
                <option value="CASH">Cash</option>
                <option value="NET_EXERCISE">Net exercise (share withholding)</option>
                <option value="CASHLESS">Cashless (broker-assisted)</option>
                <option value="PROMISSORY_NOTE">Promissory note</option>
              </Select>
            </Field>

            {exercisePreview && (
              <div className="rounded-lg border border-brand-200 bg-brand-50/60 p-3.5">
                <p className="mb-2.5 text-[13px] font-semibold text-brand-900">Estimated tax consequences</p>
                <KeyValue columns={2} items={[
                  { label: 'Exercise cost', value: money(exercisePreview.exerciseCost) },
                  { label: 'Spread at exercise', value: money(exercisePreview.spread) },
                  { label: exercisePreview.awardType === 'ISO' ? 'AMT preference' : 'Ordinary income',
                    value: money(exercisePreview.awardType === 'ISO' ? exercisePreview.amtPreference : exercisePreview.ordinaryIncome) },
                  { label: 'Estimated tax due', value: money(exercisePreview.totalTaxDue) },
                  { label: 'Total cash needed', value: <span className="font-semibold">{money(exercisePreview.totalCashNeeded)}</span> },
                  ...(exercisePreview.qualifyingDispositionDate
                    ? [{ label: 'Qualifying disposition after', value: date(exercisePreview.qualifyingDispositionDate) }] : []),
                ]} />
                <ul className="mt-3 space-y-1 border-t border-brand-200 pt-2.5">
                  {exercisePreview.notes.map((n: string, i: number) => (
                    <li key={i} className="text-[12px] leading-relaxed text-brand-900/80">{n}</li>
                  ))}
                </ul>
                <p className="mt-2.5 text-[11px] text-brand-900/60">
                  {config.legal.taxEstimateNote}
                </p>
              </div>
            )}
          </>
        )}
      </FormModal>

      {/* Countersign the award agreement */}
      <Modal open={!!countersigning} onClose={() => setCountersigning(null)} title={countersigning?.document?.name ?? 'Countersign agreement'} size="xl"
        description="Read the agreement, then type your full name to sign it for the Company."
        footer={<>
          <Button onClick={() => setCountersigning(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void countersign()}>Sign for the Company</Button>
        </>}>
        {countersigning?.document && (
          <div className="mb-4"><DocumentPreview companyId={companyId!} document={countersigning.document} className="h-[52vh]" /></div>
        )}
        <Field label="Type your full name" required hint={countersigning?.signerName}>
          <Input value={signature} onChange={(e) => setSignature(e.target.value)} className="font-[cursive] text-lg" />
        </Field>
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.name ?? 'Award agreement'} size="xl"
        footer={<>
          {viewing?.id && viewing.status === 'EXECUTED' && <Button icon={<Icon name="eye" />} onClick={() => setReading(viewing)}>Read PDF</Button>}
          <Button onClick={() => setViewing(null)}>Close</Button>
        </>}>
        {viewing?.status === 'EXECUTED' && <div className="mb-3"><Banner tone="success" title="Fully executed">Every party has signed; the grant is outstanding.</Banner></div>}
        {viewing && <DocumentPreview companyId={companyId!} document={viewing} />}
        {(viewing?.signatures ?? []).length > 0 && (
          <ul className="mt-4 space-y-2">
            {viewing.signatures.map((s: any) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 px-3 py-2 text-[13px]">
                <span className="font-medium text-ink-900">{s.signerName}</span>
                {s.status === 'SIGNED'
                  ? <span className="text-[12px] text-ink-600">Signed <span className="font-[cursive] text-[14px] text-ink-900">{s.typedSignature}</span> · {date(String(s.signedAt).slice(0, 10))}{s.ipAddress ? ` · ${s.ipAddress}` : ''}</span>
                  : <Badge tone="warning">Awaiting signature</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog open={!!withdrawing} onClose={() => setWithdrawing(null)} danger loading={busy}
        title="Withdraw grant" confirmLabel="Withdraw"
        message={<>Withdraw <strong>{withdrawing?.label ?? 'this grant'}</strong> before it is issued? Its agreement, signature requests and any pending board consent are removed; nothing was ever outstanding.</>}
        onConfirm={() => void withdraw()} />

      <FormModal open={!!confirmCancel} onClose={() => setConfirmCancel(null)} busy={busy} title="Cancel options" submitLabel="Record cancellation" onSubmit={doCancel}
        description="Cancels options under the grant as of a date. The ledger records the cancellation, so views of earlier dates still show the options. They return to the plan reserve if the plan allows it.">
        {confirmCancel && (
          <FormGrid>
            <Field label="Options to cancel" required hint={`${shares(outstandingOf(confirmCancel))} outstanding under ${confirmCancel.label ?? 'this grant'}. Fewer leaves the rest outstanding.`}>
              <Input value={cancel.quantity} onChange={(e) => setCancel({ ...cancel, quantity: e.target.value })} required />
            </Field>
            <Field label="Cancellation date" required><Input type="date" value={cancel.date} onChange={(e) => setCancel({ ...cancel, date: e.target.value })} required /></Field>
            <Field label="Reason"><Input value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} placeholder="Unvested options forfeited on departure" /></Field>
          </FormGrid>
        )}
      </FormModal>
      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        description={reading ? categoryLabel(reading.category) : undefined}
        path={reading && companyId ? readableDocumentPath(companyId, reading) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />

    </>
  );
}
