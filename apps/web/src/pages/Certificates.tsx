import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery, api, downloadFile } from '../api.ts';
import { useSearchQuery } from '../hooks.ts';
import {
  PageHeader, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, StatusBadge, SegmentedControl, useToast, Checkbox, Modal, Banner,
  KeyValue, ActionMenu,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { Icon } from '../icons.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { DocumentPreview } from '../PdfFrame.tsx';
import { shares, money, date, today, parseShares, parsePPS } from '../format.ts';
import { readableDocumentPath, documentFilename, isUploadedFile, documentAccess, newestPerHolding, downloadDocumentPath } from '../documents.ts';
import { config } from '../config.ts';
import { IssueShares } from '../IssueShares.tsx';

/** Common stock's par value (company.commonClass.parValue), the price a founder's shares are usually bought at. */
const PAR = String(config.company.commonClass.parValue);

const blank = {
  certificateNo: '', stakeholderId: '', shareClassId: '', quantity: '',
  pricePerShare: PAR, issueDate: today(), vestingScheduleId: '', vestingStartDate: '',
  earlyExercised: false, election83bFiledOn: '', boardApprovalDate: '', notes: '', effectiveDate: '', reason: '',
};

export default function Certificates() {
  const { companyId, canEdit, user } = useSession();
  const crud = useCrud<any>('issuances');
  const toast = useToast();
  const { data: documents, reload: reloadDocuments } = useQuery<any[]>(companyId ? `/c/${companyId}/documents` : null, [companyId]);
  const { data: contacts } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/contacts` : null, [companyId]);
  const [forSignature, setForSignature] = useState(true);
  const [signer, setSigner] = useState({ name: '', title: config.equity.signerTitle, message: '', templateId: '' });
  const [countersigning, setCountersigning] = useState<any>(null);
  const [signature, setSignature] = useState('');
  const [viewing, setViewing] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [withdrawing, setWithdrawing] = useState<any>(null);
  const [emailing, setEmailing] = useState(false);
  const [repurchasing, setRepurchasing] = useState<any>(null);
  const [repurchase, setRepurchase] = useState({ quantity: '', date: today(), pricePerShare: '', memo: '' });
  const [cancelling, setCancelling] = useState<any>(null);
  const [cancel, setCancel] = useState({ quantity: '', date: today(), reason: '' });
  /** The signing certificate behind a pending issuance, with its signature blocks. */
  const certificateOf = useMemo(() => newestPerHolding((documents ?? []).filter((d) => d.category === 'CERTIFICATE')), [documents]);
  /**
   * Everything filed against a holding, newest first. A certificate is only one
   * of the documents a holding collects, and one that was uploaded or assigned
   * by hand is FINAL rather than EXECUTED, so reading the rows off the signing
   * flow alone left every other document invisible from this table.
   */
  const documentsOf = useMemo(() => {
    const bySecurity = new Map<string, any[]>();
    for (const d of documents ?? []) {
      if (!d.securityId) continue;
      const filed = bySecurity.get(d.securityId);
      if (filed) filed.push(d); else bySecurity.set(d.securityId, [d]);
    }
    return bySecurity;
  }, [documents]);
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const { data: classes } = useQuery<any[]>(companyId ? `/c/${companyId}/share-classes` : null, [companyId]);
  const { data: schedules, loading: schedulesLoading, error: schedulesError, reload: reloadSchedules } = useQuery<any[]>(companyId ? `/c/${companyId}/vesting-schedules` : null, [companyId]);

  const [search, setSearch] = useSearchQuery();
  const [status, setStatus] = useState<'OUTSTANDING' | 'ALL'>('OUTSTANDING');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const pendingVestingDefault = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [transferring, setTransferring] = useState<any>(null);
  const [transfer, setTransfer] = useState({ toStakeholderId: '', quantity: '', date: today(), pricePerShare: '' });
  const [busy, setBusy] = useState(false);

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const classOf = useMemo(() => new Map((classes ?? []).map((c) => [c.id, c])), [classes]);
  const defaultVestingScheduleId = schedules?.find((s) => s.name === '4 years, 1 year cliff, monthly')?.id ?? '';

  useEffect(() => {
    // A new issuance can open before schedules finish loading. Apply its default
    // once, while preserving any schedule the user has already chosen.
    if (!pendingVestingDefault.current || !editing || editing.id || !schedules) return;
    pendingVestingDefault.current = false;
    setForm((current) => ({ ...current, vestingScheduleId: defaultVestingScheduleId }));
  }, [editing, schedules, defaultVestingScheduleId]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return crud.items
      .filter((i) => status === 'ALL' || i.status === 'OUTSTANDING' || i.status === 'PENDING_SIGNATURE')
      .filter((i) => !q
        || (nameOf.get(i.stakeholderId) ?? '').toLowerCase().includes(q)
        || (i.certificateNo ?? '').toLowerCase().includes(q));
  }, [crud.items, search, status, nameOf]);

  const openNew = () => {
    pendingVestingDefault.current = !schedules;
    setForm({ ...blank, issueDate: today(), shareClassId: classes?.[0]?.id ?? '', vestingScheduleId: defaultVestingScheduleId });
    setForSignature(true);
    setSigner({ name: contacts?.defaultSignatory?.name ?? user?.name ?? '', title: contacts?.defaultSignatory?.title ?? config.equity.signerTitle, message: '', templateId: '' });
    setEditing({ id: null });
  };
  const refreshAll = () => { crud.reload(); reloadDocuments(); };

  const countersign = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/signatures/${countersigning.id}/sign`, { body: { typedSignature: signature } });
      toast('Signed for the Company');
      setCountersigning(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remind = async (i: any) => {
    setBusy(true);
    try {
      const r = await api<{ emailed: boolean; reason: string | null }>(`/c/${companyId}/issuances/${i.id}/remind`, { body: {} });
      toast(r.emailed ? 'Reminder emailed to the holder' : `Not emailed — ${r.reason}`, r.emailed ? 'success' : 'error');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/issuances/${withdrawing.id}/cancel-signing`, { body: {} });
      toast('Certificate withdrawn');
      setWithdrawing(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const printUrl = (docId: string) => `/api/c/${companyId}/documents/${docId}/print`;
  const executedCount = (documents ?? []).filter((d) => d.category === 'CERTIFICATE' && d.status === 'EXECUTED').length;
  const emailCertificates = async () => {
    setBusy(true);
    try {
      const r = await api<{ holders: number; certificates: number; emailed: number; withoutEmail: number; reason: string | null }>(`/c/${companyId}/certificates/email`, { body: {} });
      toast(r.emailed ? `Emailed ${r.emailed} of ${r.holders} holders about ${r.certificates} certificate${r.certificates === 1 ? '' : 's'}` : `Nothing emailed — ${r.reason}`, r.emailed ? 'success' : 'error');
      setEmailing(false);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const doRepurchase = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/issuances/${repurchasing.id}/repurchase`, {
        body: { quantity: parseShares(repurchase.quantity), date: repurchase.date, pricePerShare: parsePPS(repurchase.pricePerShare), memo: repurchase.memo || null },
      });
      toast('Shares repurchased and returned to the authorized pool');
      setRepurchasing(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const doCancel = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/issuances/${cancelling.id}/cancel`, {
        body: { quantity: parseShares(cancel.quantity), date: cancel.date, reason: cancel.reason || null },
      });
      toast('Shares cancelled');
      setCancelling(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const openEdit = (i: any) => {
    setForm({
      certificateNo: i.certificateNo ?? '', stakeholderId: i.stakeholderId, shareClassId: i.shareClassId,
      quantity: String(i.quantity), pricePerShare: String(i.pricePerShare / 1e6), issueDate: i.issueDate,
      vestingScheduleId: i.vestingScheduleId ?? '', vestingStartDate: i.vestingStartDate ?? '',
      earlyExercised: !!i.earlyExercised, election83bFiledOn: i.election83bFiledOn ?? '',
      boardApprovalDate: i.boardApprovalDate ?? '', notes: i.notes ?? '', effectiveDate: i.issueDate, reason: '',
    });
    setEditing(i);
  };

  /** An issued certificate whose holder, class or date is being changed: a correction that needs a reason. */
  const retyped = !!editing?.id && editing.status !== 'PENDING_SIGNATURE'
    && (form.stakeholderId !== editing.stakeholderId || form.shareClassId !== editing.shareClassId || form.issueDate !== editing.issueDate);
  /** An issued certificate whose count, price or vesting changes: a correction dated in the ledger. */
  const redated = !!editing?.id && (parseShares(form.quantity) !== Number(editing.quantity)
    || parsePPS(form.pricePerShare) !== Number(editing.pricePerShare) || (form.vestingScheduleId || null) !== (editing.vestingScheduleId ?? null)
    || (form.vestingStartDate || (form.vestingScheduleId ? form.issueDate : null)) !== (editing.vestingStartDate ?? null));
  const signedCertificate = (i: any) => (documentsOf.get(i.id) ?? []).some((d: any) => d.category === 'CERTIFICATE' && d.status === 'EXECUTED');

  const save = async (values = form) => {
    const payload = {
      certificateNo: values.certificateNo || null, stakeholderId: values.stakeholderId,
      shareClassId: values.shareClassId, quantity: parseShares(values.quantity),
      pricePerShare: parsePPS(values.pricePerShare), issueDate: values.issueDate,
      vestingScheduleId: values.vestingScheduleId || null,
      vestingStartDate: values.vestingStartDate || (values.vestingScheduleId ? values.issueDate : null),
      earlyExercised: values.earlyExercised,
      election83bFiledOn: values.election83bFiledOn || null,
      boardApprovalDate: values.boardApprovalDate || null, notes: values.notes || null,
    };
    if (!editing?.id && forSignature) {
      setBusy(true);
      try {
        const r = await api<{ emailed: boolean; issuance: any }>(`/c/${companyId}/issuances/issue-for-signature`, {
          body: { ...payload, signerName: signer.name, signerTitle: signer.title, message: signer.message || null, templateId: signer.templateId || null },
        });
        toast(`Certificate ${r.issuance.certificateNo} sent for signature${r.emailed ? ' — the holder has been emailed' : ''}`);
        setEditing(null);
        refreshAll();
      } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
      return;
    }
    // A certificate still out for signature carries a document repeating its terms,
    // so its corrections go through the route that rewrites that document too.
    if (editing?.id && editing.status === 'PENDING_SIGNATURE') {
      setBusy(true);
      try {
        await api(`/c/${companyId}/issuances/${editing.id}/draft`, { method: 'PATCH', body: payload });
        toast('Draft certificate updated');
        setEditing(null);
        refreshAll();
      } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
      return;
    }
    const ok = editing?.id
      // A changed share count is a correction, dated in the ledger (docs/design/dated-ledger.md).
      ? await crud.update(editing.id, { ...payload, effectiveDate: form.effectiveDate || form.issueDate, reason: form.reason || undefined }, 'Certificate updated')
      : await crud.create(payload, 'Shares issued');
    if (ok) setEditing(null);
  };

  const doTransfer = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/issuances/${transferring.id}/transfer`, {
        body: {
          toStakeholderId: transfer.toStakeholderId,
          quantity: transfer.quantity ? parseShares(transfer.quantity) : undefined,
          date: transfer.date,
          pricePerShare: transfer.pricePerShare ? parsePPS(transfer.pricePerShare) : undefined,
        },
      });
      toast('Shares transferred');
      setTransferring(null);
      crud.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  if (crud.loading) return <Loading label="Loading certificates" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  const totalShares = rows.filter((r) => r.status === 'OUTSTANDING').reduce((s, r) => s + r.quantity, 0);
  const pendingCount = crud.items.filter((r) => r.status === 'PENDING_SIGNATURE').length;
  /**
   * Opens one document filed against a holding. The dialog below renders a
   * document's text, which a stored file does not have, so an uploaded PDF is
   * handed to the reader and any other uploaded file is saved instead.
   */
  const openDocument = (d: any) => {
    if (readableDocumentPath(companyId!, d)) { setReading(d); return; }
    void downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));
  };

  /**
   * Opens the certificate document for an issuance. Not every issuance has one:
   * shares recorded by hand or imported never went through the signing flow, so
   * the dialog is given something that says so rather than an empty page. A
   * scan someone uploaded is the certificate just as much as one the platform
   * wrote, which is why this looks past the signing flow to what else is filed.
   */
  const openCertificate = (i: any) => {
    // Only a certificate counts as the certificate. Falling back to whatever else was
    // filed against the holding would put a board consent behind a menu item that
    // promises the certificate, and would hide the honest "nothing on file" answer.
    const doc = certificateOf.get(i.id)
      ?? (documentsOf.get(i.id) ?? []).find((d: any) => d.category === 'CERTIFICATE');
    if (doc && isUploadedFile(doc)) { openDocument(doc); return; }
    setViewing(doc ?? {
      name: `Certificate ${i.certificateNo ?? i.id.slice(-6).toUpperCase()}`,
      body: '',
      missing: true,
    });
  };

  const blocksOf = (i: any): any[] => certificateOf.get(i.id)?.signatures ?? [];
  const companyBlock = (i: any) => blocksOf(i).find((s) => s.stakeholderId == null);
  const holderBlock = (i: any) => blocksOf(i).find((s) => s.stakeholderId != null);

  const certificateNoOf = (i: any): string => i.certificateNo ?? i.id.slice(-6).toUpperCase();
  /** What the holder paid, in cents. */
  const paidOf = (i: any): number => Math.round((i.quantity * i.pricePerShare) / 1e4);
  const scheduleOf = (i: any) => (schedules ?? []).find((s) => s.id === i.vestingScheduleId);
  /** The status, how far the signing has got, and what is filed against the holding. */
  const statusCell = (i: any) => {
    const certificate = certificateOf.get(i.id);
    // The executed certificate keeps the words it has always had.
    const signed = i.status === 'OUTSTANDING' && certificate?.status === 'EXECUTED' ? certificate : null;
    // Everything else on file, newest first as the vault returns them. The
    // executed certificate is pulled out above because it keeps its own wording.
    const filed = (documentsOf.get(i.id) ?? []).filter((d) => d.id !== signed?.id);
    return (
      <>
        <StatusBadge status={i.status} />
        {certificate?.resign && <Badge tone="warning" className="ml-1">Corrected: awaiting re-signing</Badge>}
        {(i.status === 'PENDING_SIGNATURE' || certificate?.resign) && blocksOf(i).length > 0 && (
          <span className="mt-1 block text-[11px] text-ink-500">
            {blocksOf(i).filter((s) => s.status === 'SIGNED').length} of {blocksOf(i).length} signed
            {blocksOf(i).some((s) => s.status !== 'SIGNED') && ` · waiting for ${blocksOf(i).filter((s) => s.status !== 'SIGNED').map((s) => (s.stakeholderId ? nameOf.get(s.stakeholderId) ?? s.signerName : 'the Company')).join(' and ')}`}
          </span>
        )}
        {signed && (
          <button className="mt-1 block text-[11px] text-brand-600 hover:text-brand-700" onClick={() => openCertificate(i)}>Signed certificate</button>
        )}
        {filed.map((d) => {
          const access = documentAccess(companyId!, d);
          // A document with neither text nor a stored file has nothing behind
          // it, so its name is stated rather than offered as something to open.
          if (access === 'none') {
            return (
              <span key={d.id} className="mt-1 block max-w-[13rem] truncate text-[11px] text-ink-500" title={d.name}>
                {d.name}
              </span>
            );
          }
          // The certificate the platform wrote belongs in the certificate dialog,
          // which shows who signed it. That is true before it is executed as well.
          const own = d.id === certificate?.id && !isUploadedFile(d);
          return (
            <button key={d.id} type="button" title={own ? `Open ${d.name}` : access === 'read' ? `Read ${d.name}` : `Download ${d.name}`}
              onClick={() => (own ? openCertificate(i) : openDocument(d))}
              className="mt-1 block max-w-[13rem] truncate text-left text-[11px] text-brand-600 hover:text-brand-700">
              {d.name}
            </button>
          );
        })}
      </>
    );
  };

  const rowActions = (i: any) => {
    const certificate = certificateOf.get(i.id);
    // At most one button for the thing this row is waiting on, and the rest
    // in the menu. Five side by side wrapped into a ragged block.
    return (
      <span className="flex flex-nowrap items-center justify-end gap-1">
        {i.status === 'PENDING_SIGNATURE' ? (
          <>
            {companyBlock(i)?.status === 'PENDING' ? (
              <Button size="sm" variant="primary" onClick={() => { setSignature(user?.name ?? ''); setCountersigning({ ...companyBlock(i), document: certificateOf.get(i.id) }); }}>Countersign</Button>
            ) : holderBlock(i)?.status === 'PENDING' ? (
              <Button size="sm" loading={busy} onClick={() => void remind(i)}>Remind</Button>
            ) : null}
            <ActionMenu items={[
              { label: 'View the certificate', icon: 'certificate', onClick: () => openCertificate(i) },
              ...(companyBlock(i)?.status === 'PENDING' && holderBlock(i)?.status === 'PENDING'
                ? [{ label: 'Remind the holder', icon: 'megaphone' as const, onClick: () => { void remind(i); } }] : []),
              // Editable only while it is genuinely still a draft. Once a
              // party has signed, changing the terms would alter what they signed.
              ...(blocksOf(i).every((sig) => sig.status !== 'SIGNED')
                ? [{ label: 'Edit the draft', icon: 'edit' as const, onClick: () => openEdit(i) }] : []),
              { label: 'Withdraw before signing', icon: 'trash', danger: true, onClick: () => setWithdrawing(i) },
            ]} />
          </>
        ) : (
          <>
            {certificate?.resign && companyBlock(i)?.status === 'PENDING' && (
              <Button size="sm" variant="primary" onClick={() => { setSignature(user?.name ?? ''); setCountersigning({ ...companyBlock(i), document: certificate }); }}>Countersign</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => openEdit(i)} aria-label="Edit" title="Edit">
              <Icon name="edit" className="size-4" />
            </Button>
            <ActionMenu items={[
              { label: 'View the certificate', icon: 'certificate', onClick: () => openCertificate(i) },
              ...(i.status === 'OUTSTANDING' ? [
                { label: 'Transfer the shares', icon: 'convert' as const,
                  onClick: () => { setTransfer({ toStakeholderId: '', quantity: String(i.quantity), date: today(), pricePerShare: String(i.pricePerShare / 1e6) }); setTransferring(i); } },
                { label: 'Repurchase the shares', icon: 'wallet' as const,
                  onClick: () => { setRepurchase({ quantity: String(i.quantity), date: today(), pricePerShare: String(i.pricePerShare / 1e6), memo: '' }); setRepurchasing(i); } },
                { label: 'Cancel the certificate', icon: 'trash' as const, danger: true,
                  onClick: () => { setCancel({ quantity: String(i.quantity), date: today(), reason: '' }); setCancelling(i); } },
              ] : []),
              { label: 'Delete', icon: 'trash', danger: true, onClick: () => setConfirmDelete(i) },
            ]} />
          </>
        )}
      </span>
    );
  };

  return (
    <>
      <PageHeader concept="certificates" title="Share & certificates"
        subtitle={`${shares(totalShares)} shares outstanding across ${rows.length - (status === 'ALL' ? 0 : rows.filter((r) => r.status === 'PENDING_SIGNATURE').length)} certificates${pendingCount ? ` · ${pendingCount} awaiting signature${pendingCount === 1 ? '' : 's'}` : ''}`}
        actions={canEdit && (
          <>
            {executedCount > 0 && <Button onClick={() => window.open(`/api/c/${companyId}/certificates/print`, '_blank', 'noopener')} icon={<Icon name="download" />}>Print all</Button>}
            {executedCount > 0 && <Button onClick={() => setEmailing(true)}>Email certificates</Button>}
            <Link to="/import?kind=captable"><Button icon={<Icon name="inbox" />}>Import</Button></Link>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew}>Issue shares</Button>
          </>
        )} />

      <DataTable caption="Certificates" rows={rows} rowKey={(i) => i.id}
        controls={<SegmentedControl value={status} onChange={setStatus} options={[
          { value: 'OUTSTANDING', label: 'Active' }, { value: 'ALL', label: 'All certificates' },
        ]} />}
        search={{ value: search, onChange: setSearch, placeholder: 'Holder or certificate number', label: 'Search certificates' }}
        empty={<EmptyState title="No certificates" description="Issue founder stock or record an investor purchase to get started."
          action={canEdit && <Button variant="primary" onClick={openNew}>Issue shares</Button>} />}
        columns={[
          { key: 'certificate', label: 'Certificate', value: certificateNoOf, className: 'font-medium',
            // The number is the certificate, so it opens the certificate. This is
            // outside the canEdit column on purpose: reading one is not editing it.
            cell: (i) => (
              <Link to={`/certificates/${i.id}`}
                className="cursor-pointer text-left font-medium text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-400">
                {certificateNoOf(i)}
              </Link>
            ) },
          { key: 'holder', label: 'Holder', value: (i) => nameOf.get(i.stakeholderId),
            cell: (i) => <Link to={`/stakeholders/${i.stakeholderId}`} className="hover:text-brand-700">{nameOf.get(i.stakeholderId) ?? '—'}</Link> },
          { key: 'class', label: 'Class', value: (i) => classOf.get(i.shareClassId)?.name,
            cell: (i) => <Badge tone={classOf.get(i.shareClassId)?.kind === 'PREFERRED' ? 'purple' : 'neutral'}>{classOf.get(i.shareClassId)?.name ?? '—'}</Badge> },
          { key: 'shares', label: 'Shares', type: 'number', value: (i) => i.quantity, className: 'font-medium' },
          // Prices are in micro-cents, so they sort as numbers and show as a price per share.
          { key: 'price', label: 'Price', type: 'price', value: (i) => i.pricePerShare },
          { key: 'paid', label: 'Paid', type: 'money', value: paidOf, cell: (i) => money(paidOf(i), { compact: true }), className: 'text-ink-600' },
          { key: 'issued', label: 'Issued', type: 'date', value: (i) => i.issueDate, className: 'text-ink-600' },
          { key: 'vesting', label: 'Vesting', value: (i) => scheduleOf(i)?.name, className: 'text-[12px] text-ink-600',
            cell: (i) => (
              <>
                {scheduleOf(i) ? scheduleOf(i).name : <span className="text-ink-400">Not subject to vesting</span>}
                {i.election83bFiledOn && <Badge tone="success" className="ml-1">83(b)</Badge>}
              </>
            ) },
          { key: 'status', label: 'Status', value: (i) => i.status, cell: statusCell },
          { key: 'actions', label: '', width: 120, align: 'right', hidden: !canEdit, cell: rowActions },
        ]} />

      {editing && !editing.id && (
        <IssueShares companyId={companyId!} form={form} setForm={setForm}
          stakeholders={stakeholders ?? []} classes={classes ?? []} schedules={schedules ?? []}
          schedulesLoading={schedulesLoading} schedulesError={schedulesError} onRetrySchedules={reloadSchedules}
          onVestingScheduleChange={(vestingScheduleId) => {
            pendingVestingDefault.current = false;
            setForm((current) => ({ ...current, vestingScheduleId, vestingStartDate: vestingScheduleId ? current.vestingStartDate : '' }));
          }}
          forSignature={forSignature} setForSignature={setForSignature} signer={signer} setSigner={setSigner}
          busy={crud.busy || busy} onClose={() => setEditing(null)} onSubmit={save} />
      )}

      <FormModal open={!!editing?.id} onClose={() => setEditing(null)} busy={crud.busy || busy} size="lg"
        title="Edit certificate"
        description="Records an issuance of shares against a class. Restricted stock can carry a vesting schedule and an 83(b) election."
        onSubmit={save} submitLabel="Save changes">
        <FormGrid>
          <Field label="Holder" required>
            <Select value={form.stakeholderId} onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })} required>
              <option value="">Select a stakeholder</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Share class" required>
            <Select value={form.shareClassId} onChange={(e) => setForm({ ...form, shareClassId: e.target.value })} required>
              <option value="">Select a class</option>
              {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Number of shares" required>
            <Input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="1,000,000" required />
          </Field>
          {redated && (
            <Field label="Correct from" hint="The ledger dates the change. Keep the issue date if the old count or terms were always wrong.">
              <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
            </Field>
          )}
          <Field label="Price per share">
            <Input value={form.pricePerShare} onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })} placeholder={PAR} />
          </Field>
          <Field label="Certificate number">
            <Input value={form.certificateNo} onChange={(e) => setForm({ ...form, certificateNo: e.target.value })} placeholder="CS-1" />
          </Field>
          <Field label="Issue date" required>
            <Input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} required />
          </Field>
          {retyped && (
            <Field label="Reason for the correction" required
              hint="A changed holder, class or issue date says the record was always wrong, on every date. To move shares to someone else, transfer them instead.">
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Entered against the wrong holder" required />
            </Field>
          )}
        </FormGrid>
        {editing?.id && signedCertificate(editing) && (retyped || parseShares(form.quantity) !== Number(editing.quantity) || parsePPS(form.pricePerShare) !== Number(editing.pricePerShare)) && (
          <Banner tone="warning">The signed certificate will no longer match. Saving voids it, keeps it with its signatures, and sends a corrected certificate to the holder and the Company to sign.</Banner>
        )}

        <div className="border-t border-ink-100 pt-4">
          <p className="mb-3 text-[13px] font-semibold text-ink-800">Restrictions</p>
          <FormGrid>
            <Field label="Vesting schedule" hint="Leave empty for fully vested shares.">
              <Select value={form.vestingScheduleId} onChange={(e) => setForm({ ...form, vestingScheduleId: e.target.value })}>
                <option value="">Not subject to vesting</option>
                {(schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Vesting start date">
              <Input type="date" value={form.vestingStartDate} onChange={(e) => setForm({ ...form, vestingStartDate: e.target.value })} />
            </Field>
            <Field label="83(b) election filed" hint="Must be postmarked within 30 days of purchase.">
              <Input type="date" value={form.election83bFiledOn} onChange={(e) => setForm({ ...form, election83bFiledOn: e.target.value })} />
            </Field>
            <Field label="Board approval date">
              <Input type="date" value={form.boardApprovalDate} onChange={(e) => setForm({ ...form, boardApprovalDate: e.target.value })} />
            </Field>
          </FormGrid>
          <div className="mt-3">
            <Checkbox label="Shares acquired by early exercising an unvested option"
              hint="Subject to repurchase at cost if the holder leaves before vesting."
              checked={form.earlyExercised} onChange={(v) => setForm({ ...form, earlyExercised: v })} />
          </div>
        </div>
      </FormModal>

      <Modal open={!!countersigning} onClose={() => setCountersigning(null)} title={countersigning?.document?.name ?? 'Countersign certificate'} size="xl"
        description="Read the certificate, then type your full name to sign it for the Company."
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

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.name ?? 'Certificate'} size="xl"
        footer={<>
          {viewing?.id && <Button onClick={() => window.open(printUrl(viewing.id), '_blank', 'noopener')}>Print</Button>}
          {viewing?.id && readableDocumentPath(companyId!, viewing) && <Button icon={<Icon name="eye" />} onClick={() => setReading(viewing)}>Read PDF</Button>}
          <Button onClick={() => setViewing(null)}>Close</Button>
        </>}>
        {viewing?.status === 'EXECUTED' && <div className="mb-3"><Banner tone="success" title="Fully executed">Every party has signed; the shares are outstanding.</Banner></div>}
        {viewing?.missing ? (
          <EmptyState title="No certificate document for these shares"
            description="These shares were recorded directly rather than issued through the signing flow, so there is no certificate to show. The holding itself is on the cap table either way." />
        ) : viewing ? (
          <DocumentPreview companyId={companyId!} document={viewing} />
        ) : null}
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
        title="Withdraw certificate" confirmLabel="Withdraw"
        message={<>Withdraw certificate <strong>{withdrawing?.certificateNo}</strong> before it is signed? The document and its signature requests are removed; nothing was ever outstanding.</>}
        onConfirm={() => void withdraw()} />

      <ConfirmDialog open={emailing} onClose={() => setEmailing(false)} loading={busy} title="Email certificates" confirmLabel="Send"
        message={<>Email every holder with an executed certificate a link to view and print it in their portal? {executedCount} certificate{executedCount === 1 ? '' : 's'} qualify.</>}
        onConfirm={() => void emailCertificates()} />

      <FormModal open={!!repurchasing} onClose={() => setRepurchasing(null)} busy={busy} title="Repurchase shares" submitLabel="Record repurchase" onSubmit={doRepurchase}
        description="Buys shares back from the holder, for example unvested shares when they leave. The shares leave the cap table and return to the class's authorized pool; the ledger records the repurchase.">
        {repurchasing && (
          <>
            <div className="rounded-lg bg-ink-50 p-3">
              <KeyValue columns={3} items={[
                { label: 'Certificate', value: repurchasing.certificateNo ?? repurchasing.id.slice(-6) },
                { label: 'Holder', value: nameOf.get(repurchasing.stakeholderId) ?? '—' },
                { label: 'Shares held', value: shares(repurchasing.quantity) },
              ]} />
            </div>
            <FormGrid>
              <Field label="Shares to repurchase" required hint="Fewer than the whole certificate leaves the rest outstanding.">
                <Input value={repurchase.quantity} onChange={(e) => setRepurchase({ ...repurchase, quantity: e.target.value })} required />
              </Field>
              <Field label="Repurchase date" required><Input type="date" value={repurchase.date} onChange={(e) => setRepurchase({ ...repurchase, date: e.target.value })} required /></Field>
              <Field label="Price per share" required hint="Unvested shares are usually repurchased at the lower of cost and fair market value.">
                <Input value={repurchase.pricePerShare} onChange={(e) => setRepurchase({ ...repurchase, pricePerShare: e.target.value })} required />
              </Field>
              <Field label="Memo"><Input value={repurchase.memo} onChange={(e) => setRepurchase({ ...repurchase, memo: e.target.value })} placeholder="Unvested shares on departure" /></Field>
            </FormGrid>
          </>
        )}
      </FormModal>

      <FormModal open={!!cancelling} onClose={() => setCancelling(null)} busy={busy} title="Cancel shares" submitLabel="Record cancellation" onSubmit={doCancel}
        description="Cancels shares on the certificate as of a date. The ledger records the cancellation, so views of earlier dates still show the shares.">
        {cancelling && (
          <FormGrid>
            <Field label="Shares to cancel" required hint={`${shares(cancelling.quantity)} held. Fewer leaves the rest outstanding.`}>
              <Input value={cancel.quantity} onChange={(e) => setCancel({ ...cancel, quantity: e.target.value })} required />
            </Field>
            <Field label="Cancellation date" required><Input type="date" value={cancel.date} onChange={(e) => setCancel({ ...cancel, date: e.target.value })} required /></Field>
            <Field label="Reason"><Input value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} placeholder="Issued in error" /></Field>
          </FormGrid>
        )}
      </FormModal>

      <FormModal open={!!transferring} onClose={() => setTransferring(null)} busy={busy}
        title="Transfer shares" submitLabel="Transfer" onSubmit={doTransfer}
        description="Splits the certificate and issues a new one to the recipient. The transfer is written to the ledger.">
        <Field label="Transfer to" required>
          <Select value={transfer.toStakeholderId} onChange={(e) => setTransfer({ ...transfer, toStakeholderId: e.target.value })} required>
            <option value="">Select a stakeholder</option>
            {(stakeholders ?? []).filter((s) => s.id !== transferring?.stakeholderId)
              .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <FormGrid>
          <Field label="Shares to transfer" hint={`${shares(transferring?.quantity ?? 0)} available`}>
            <Input value={transfer.quantity} onChange={(e) => setTransfer({ ...transfer, quantity: e.target.value })} />
          </Field>
          <Field label="Transfer date">
            <Input type="date" value={transfer.date} onChange={(e) => setTransfer({ ...transfer, date: e.target.value })} />
          </Field>
        </FormGrid>
        <Field label="Price per share" hint="Recorded on the ledger as the transfer consideration.">
          <Input value={transfer.pricePerShare} onChange={(e) => setTransfer({ ...transfer, pricePerShare: e.target.value })} />
        </Field>
      </FormModal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={crud.busy}
        title="Delete certificate" confirmLabel="Delete"
        message="Deleting a certificate removes those shares from the cap table. Prefer cancelling or repurchasing so the history stays intact."
        onConfirm={async () => { if (await crud.remove(confirmDelete.id, 'Certificate deleted')) setConfirmDelete(null); }} />
      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        path={reading ? readableDocumentPath(companyId!, reading) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />

    </>
  );
}
