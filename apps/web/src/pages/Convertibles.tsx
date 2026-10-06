import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery, api, downloadFile } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Table, TH, TD, TR, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, StatusBadge, Stat, Checkbox, Banner, SegmentedControl, InfoDot, Modal, Textarea, useToast, ActionMenu,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { DocumentPreview } from '../PdfFrame.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { readableDocumentPath, documentFilename, documentAccess, newestPerHolding, downloadDocumentPath } from '../documents.ts';
import { money, percent, date, today, parseMoney, parsePercent, INSTRUMENT_LABELS, amountHint, shares } from '../format.ts';
import { config } from '../config.ts';

/** Instruments issued on the platform that are not yet outstanding. */
const IN_FLIGHT = new Set(['PENDING_APPROVAL', 'PENDING_SIGNATURE']);
type Approval = 'APPROVED' | 'REQUEST' | 'NONE';

// New instruments start as equity.convertibleInstrument. A recorded note compounds as
// equity.noteCompounding and a raised one as equity.raiseNoteCompounding.
const blank = {
  stakeholderId: '', instrument: config.equity.convertibleInstrument as string, principal: '', issueDate: today(),
  valuationCap: '', discount: '', interestRate: '', compounding: config.equity.noteCompounding as string,
  maturityDate: '', mfn: false, proRataRight: true, qualifiedFinancingMinimum: '', notes: '',
};
const blankTerms = {
  instrument: config.equity.convertibleInstrument as string, valuationCap: '', discount: '', interestRate: '',
  compounding: config.equity.raiseNoteCompounding as string, maturityDate: '',
  mfn: false, proRataRight: true, qualifiedFinancingMinimum: '', issueDate: today(), notes: '',
};
const blankIssue = {
  approval: 'APPROVED' as Approval, boardApprovalDate: today(), directorIds: [] as string[], forSignature: true,
  signerName: '', signerTitle: config.equity.convertibleSignerTitle, templateId: '', message: '',
};
interface InvestorLine { key: string; stakeholderId: string; principal: string; label: string }
const newLine = (stakeholderId = ''): InvestorLine => ({ key: Math.random().toString(36).slice(2), stakeholderId, principal: '', label: '' });

export default function Convertibles() {
  const { companyId, canEdit, canViewAll, user } = useSession();
  const navigate = useNavigate();
  const crud = useCrud<any>('convertibles');
  const toast = useToast();
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const { data: stack, reload: reloadStack } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/model/convertibles` : null, [companyId]);
  const { data: documents, reload: reloadDocuments } = useQuery<any[]>(companyId ? `/c/${companyId}/documents` : null, [companyId]);
  const { data: templateData } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/templates` : null, [companyId]);
  const { data: contacts } = useQuery<any>(companyId && canEdit ? `/c/${companyId}/contacts` : null, [companyId]);
  const [status, setStatus] = useState<'OUTSTANDING' | 'ALL'>('OUTSTANDING');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [raising, setRaising] = useState(false);
  const [terms, setTerms] = useState(blankTerms);
  const [investors, setInvestors] = useState<InvestorLine[]>([newLine()]);
  const [issue, setIssue] = useState(blankIssue);
  const [busy, setBusy] = useState(false);
  const [countersigning, setCountersigning] = useState<any>(null);
  const [signature, setSignature] = useState('');
  const [viewing, setViewing] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [withdrawing, setWithdrawing] = useState<any>(null);
  const [funding, setFunding] = useState<any>(null);
  const [funds, setFunds] = useState({ receivedOn: today(), reference: '' });
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  // An MFN holder's election of one later instrument's terms, recorded as a dated ledger entry.
  const [electing, setElecting] = useState<any>(null);
  const [election, setElection] = useState({ adoptedId: '', date: today() });
  const [settling, setSettling] = useState<{ c: any; kind: 'repay' | 'cancel' } | null>(null);
  const [settle, setSettle] = useState({ date: today(), amount: '', reason: '' });

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const directors = useMemo(() => (stakeholders ?? []).filter((s) => s.relation === 'BOARD_MEMBER' || s.relation === 'FOUNDER'), [stakeholders]);
  const agreementOf = useMemo(() => newestPerHolding((documents ?? []).filter((d) => d.category === 'CONVERTIBLE_AGREEMENT')), [documents]);
  /**
   * Everything filed against an instrument, not only the agreement the app wrote
   * for it: a file someone attached to the holding is just as much a part of the
   * row's story, and until it is listed here the table is the one place it cannot
   * be reached from.
   */
  const filedOn = useMemo(() => {
    const byInstrument = new Map<string, any[]>();
    for (const d of documents ?? []) {
      if (!d.securityId) continue;
      const filed = byInstrument.get(d.securityId);
      if (filed) filed.push(d); else byInstrument.set(d.securityId, [d]);
    }
    return byInstrument;
  }, [documents]);
  const blocksOf = (c: any): any[] => agreementOf.get(c.id)?.signatures ?? [];
  const companyBlock = (c: any) => blocksOf(c).find((s) => !s.stakeholderId);
  const holderBlock = (c: any) => blocksOf(c).find((s) => s.stakeholderId);
  const templates: any[] = (templateData?.templates ?? []).filter((t: any) => t.kind === 'CONVERTIBLE_AGREEMENT');
  const rows = crud.items.filter((c) => status === 'ALL' || c.status === 'OUTSTANDING' || IN_FLIGHT.has(c.status));
  const isSafe = form.instrument === 'SAFE_PRE' || form.instrument === 'SAFE_POST';
  const termsAreSafe = terms.instrument !== 'NOTE';
  const inFlight = crud.items.filter((c) => IN_FLIGHT.has(c.status)).length;
  const refreshAll = () => { crud.reload(); reloadDocuments(); reloadStack(); };

  const openNew = () => { setForm({ ...blank, stakeholderId: stakeholders?.[0]?.id ?? '' }); setEditing({ id: null }); };
  const openRaise = () => {
    setTerms(blankTerms);
    setInvestors([newLine((stakeholders ?? []).find((s) => s.relation === 'INVESTOR')?.id ?? '')]);
    setIssue({ ...blankIssue, signerName: contacts?.defaultSignatory?.name ?? user?.name ?? '', signerTitle: contacts?.defaultSignatory?.title ?? blankIssue.signerTitle, directorIds: directors.map((d) => d.id) });
    setRaising(true);
  };
  const openEdit = (c: any) => {
    setForm({
      stakeholderId: c.stakeholderId, instrument: c.instrument, principal: String(c.principal / 100),
      issueDate: c.issueDate, valuationCap: c.valuationCap ? String(c.valuationCap / 100) : '',
      discount: String(c.discount * 100), interestRate: String(c.interestRate * 100),
      compounding: c.compounding, maturityDate: c.maturityDate ?? '', mfn: !!c.mfn,
      proRataRight: !!c.proRataRight,
      qualifiedFinancingMinimum: c.qualifiedFinancingMinimum ? String(c.qualifiedFinancingMinimum / 100) : '',
      notes: c.notes ?? '',
    });
    setEditing(c);
  };

  const save = async () => {
    const safe = form.instrument === 'SAFE_PRE' || form.instrument === 'SAFE_POST';
    const payload = {
      stakeholderId: form.stakeholderId, instrument: form.instrument,
      principal: parseMoney(form.principal), issueDate: form.issueDate,
      valuationCap: form.valuationCap ? parseMoney(form.valuationCap) : null,
      discount: parsePercent(form.discount || '0'),
      interestRate: safe ? 0 : parsePercent(form.interestRate || '0'),
      compounding: form.compounding, maturityDate: safe ? null : (form.maturityDate || null),
      mfn: form.mfn, proRataRight: form.proRataRight,
      qualifiedFinancingMinimum: form.qualifiedFinancingMinimum ? parseMoney(form.qualifiedFinancingMinimum) : null,
      notes: form.notes || null,
    };
    const ok = editing?.id
      ? await crud.update(editing.id, payload, 'Instrument updated')
      : await crud.create(payload, 'Instrument recorded');
    if (ok) { setEditing(null); reloadStack(); }
  };

  const raise = async () => {
    setBusy(true);
    try {
      const r = await api<{ convertibles: any[]; consent: any }>(`/c/${companyId}/convertibles/issue`, {
        body: {
          terms: {
            instrument: terms.instrument, valuationCap: terms.valuationCap ? parseMoney(terms.valuationCap) : null, discount: parsePercent(terms.discount || '0'),
            interestRate: termsAreSafe ? 0 : parsePercent(terms.interestRate || '0'), compounding: terms.compounding, maturityDate: termsAreSafe ? null : terms.maturityDate || null,
            mfn: terms.mfn, proRataRight: terms.proRataRight, qualifiedFinancingMinimum: terms.qualifiedFinancingMinimum ? parseMoney(terms.qualifiedFinancingMinimum) : null,
          },
          issueDate: terms.issueDate, notes: terms.notes || null,
          investors: investors.filter((i) => i.stakeholderId && i.principal).map((i) => ({ stakeholderId: i.stakeholderId, principal: parseMoney(i.principal), label: i.label || null })),
          approval: issue.approval, boardApprovalDate: issue.approval === 'APPROVED' ? issue.boardApprovalDate || today() : null,
          directorIds: issue.approval === 'REQUEST' ? issue.directorIds : [],
          signing: issue.forSignature ? { signerName: issue.signerName, signerTitle: issue.signerTitle, templateId: issue.templateId || null, message: issue.message || null } : null,
        },
      });
      const n = r.convertibles.length;
      const what = `${n} ${INSTRUMENT_LABELS[terms.instrument] ?? 'instrument'}${n > 1 ? 's' : ''}`;
      toast(r.consent ? `${what} drafted — board approval requested` : r.convertibles[0]?.status === 'PENDING_SIGNATURE' ? `${what} sent for signature` : `${what} recorded`);
      setRaising(false);
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
  const remind = async (c: any) => {
    setBusy(true);
    try {
      const r = await api<{ emailed: boolean; reason: string | null }>(`/c/${companyId}/convertibles/${c.id}/remind`, { body: {} });
      toast(r.emailed ? 'Reminder emailed to the investor' : `Not emailed — ${r.reason}`, r.emailed ? 'success' : 'error');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/convertibles/${withdrawing.id}/cancel-signing`, { body: {} });
      toast('Instrument withdrawn');
      setWithdrawing(null);
      refreshAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  /**
   * A stored PDF and a document the app composed both have a page to show, so they
   * open in the reader. An uploaded file of any other kind has none, and handing it
   * to an empty viewer would look broken, so it is saved instead.
   */
  const openDocument = (d: any) => {
    if (!companyId) return;
    if (readableDocumentPath(companyId, d)) { setReading(d); return; }
    void downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));
  };

  const recordFunds = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/convertibles/${funding.id}/funds-received`, { body: { receivedOn: funds.receivedOn, reference: funds.reference || null } });
      toast('Funds recorded');
      setFunding(null);
      crud.reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const mfnOf = new Map<string, any>((stack?.instruments ?? []).filter((i: any) => i.mfn).map((i: any) => [i.id, i]));
  const labelOf = (id: string) => {
    const o = crud.items.find((c) => c.id === id);
    return o ? `${o.label ?? INSTRUMENT_LABELS[o.instrument]} · ${nameOf.get(o.stakeholderId) ?? 'investor'}` : 'another instrument';
  };
  /** Instruments the MFN holder of `c` can elect on `on`: issued on or after it and on or before that date. */
  const candidatesOf = (c: any, on: string) => crud.items.filter((o) => o.id !== c.id && o.issueDate >= c.issueDate && o.issueDate <= on
    && ['OUTSTANDING', 'CONVERTED', 'REPAID'].includes(o.status));
  const openElection = (c: any) => {
    setElection({ adoptedId: mfnOf.get(c.id)?.mfnSuggestion?.adoptedId ?? '', date: today() });
    setElecting(c);
  };
  const recordElection = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/convertibles/${electing.id}/mfn-election`, {
        body: { ...election, correction: !!mfnOf.get(electing.id)?.mfnElection },
      });
      toast('MFN election recorded');
      setElecting(null);
      reloadStack();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  // A dated event in the ledger, so views of earlier dates still show the instrument outstanding.
  const doSettle = async () => {
    const { c, kind } = settling!;
    const ok = await crud.action(`convertibles/${c.id}/${kind}`, kind === 'repay'
      ? { date: settle.date, amount: settle.amount ? parseMoney(settle.amount) : null }
      : { date: settle.date, reason: settle.reason || null }, kind === 'repay' ? 'Repayment recorded' : 'Instrument cancelled');
    if (ok) setSettling(null);
  };

  if (crud.loading) return <Loading label="Loading convertibles" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  const investorTotal = investors.reduce((s, i) => s + (i.principal ? parseMoney(i.principal) : 0), 0);
  const raiseLabel = issue.approval === 'REQUEST' ? 'Request board approval' : issue.forSignature ? 'Send for signature' : 'Record instruments';

  return (
    <>
      <PageHeader concept="convertibles" title="SAFEs & convertible notes"
        subtitle={`Instruments that convert into equity at the next priced round${inFlight ? ` · ${inFlight} in flight` : ''}`}
        actions={canEdit && (
          <>
            <Link to="/import?kind=convertibles"><Button icon={<Icon name="inbox" />}>Import</Button></Link>
            <Button onClick={openNew}>Record instrument</Button>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={openRaise}>Raise with SAFEs</Button>
          </>
        )} />

      {stack && stack.count > 0 && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Outstanding instruments" value={String(stack.count)} />
            <Stat label="Principal" value={money(stack.totalPrincipal, { compact: true })} />
            <Stat label="Accrued interest" value={money(stack.accruedInterest, { compact: true })}
              hint="On convertible notes only" />
            <Stat label="Contracted ownership" value={percent(stack.guaranteedOwnership)}
              hint="Post-money SAFEs, before new money"
              tone={stack.guaranteedOwnership > config.alerts.postMoneySafeOwnershipWarning ? 'warning' : 'default'} />
          </div>
          {stack.guaranteedOwnership > config.alerts.postMoneySafeOwnershipBanner && (
            <div className="mb-5">
              <Banner tone="warning" title="Post-money SAFEs dilute only the existing holders">
                These instruments are entitled to {percent(stack.guaranteedOwnership)} of the company as it stands before
                the next round. That dilution falls entirely on founders, employees and earlier investors —
                model it on the <Link to="/model/round" className="underline">round modeling</Link> screen before setting terms.
              </Banner>
            </div>
          )}
        </>
      )}

      <Card className="mb-5">
        <SegmentedControl value={status} onChange={setStatus} options={[
          { value: 'OUTSTANDING', label: 'Outstanding & in flight' }, { value: 'ALL', label: 'All instruments' },
        ]} />
      </Card>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="No instruments" description="Raise with SAFEs to issue instruments for signature, or record ones signed elsewhere."
            action={canEdit && <Button variant="primary" onClick={openRaise}>Raise with SAFEs</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Holder</TH>
                <TH>Instrument</TH>
                <TH align="right">Principal</TH>
                <TH align="right">Valuation cap</TH>
                <TH align="right">Discount</TH>
                <TH align="right">Interest</TH>
                <TH>Issued</TH>
                <TH>Maturity</TH>
                <TH>Terms</TH>
                <TH>Status</TH>
                <TH width={150} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const pending = IN_FLIGHT.has(c.status);
                const blocks = blocksOf(c);
                const agreement = agreementOf.get(c.id);
                const onPlatform = !!c.signingConfig;
                return (
                  <TR key={c.id}>
                    <TD>
                      {/* A person's name goes to the person. The instrument's own label is
                          what opens the instrument, and the row menu covers the ones with none. */}
                      <Link to={`/stakeholders/${c.stakeholderId}`} className="font-medium hover:text-brand-700">
                        {nameOf.get(c.stakeholderId) ?? '—'}
                      </Link>
                      {c.label && (
                        <Link to={`/convertibles/${c.id}`} className="block text-[11px] text-ink-500 underline decoration-ink-300 underline-offset-2 hover:text-brand-700">
                          {c.label}
                        </Link>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={c.instrument === 'NOTE' ? 'warning' : 'brand'}>
                        {INSTRUMENT_LABELS[c.instrument] ?? c.instrument}
                      </Badge>
                    </TD>
                    <TD align="right" mono className="font-medium">{money(c.principal, { compact: true })}</TD>
                    <TD align="right" mono>{c.valuationCap ? money(c.valuationCap, { compact: true }) : <span className="text-ink-400">Uncapped</span>}</TD>
                    <TD align="right" mono>{c.discount ? percent(c.discount, 0) : '—'}</TD>
                    <TD align="right" mono>{c.interestRate ? `${percent(c.interestRate, 1)} ${c.compounding.toLowerCase()}` : '—'}</TD>
                    <TD className="text-ink-600">{date(c.issueDate)}</TD>
                    <TD className="text-ink-600">{c.maturityDate ? date(c.maturityDate) : '—'}</TD>
                    <TD>
                      <span className="flex flex-wrap gap-1">
                        {!!c.mfn && <Badge tone="info">MFN</Badge>}
                        {!!c.proRataRight && <Badge tone="neutral">Pro rata</Badge>}
                        {!!c.qualifiedFinancingMinimum && (
                          <Badge tone="neutral">Min {money(c.qualifiedFinancingMinimum, { compact: true })}</Badge>
                        )}
                      </span>
                      {mfnOf.get(c.id)?.mfnElection ? (
                        <span className="mt-1 block text-[11px] text-ink-500">
                          Elected {labelOf(mfnOf.get(c.id).mfnElection.adoptedId)} on {date(mfnOf.get(c.id).mfnElection.date)}
                        </span>
                      ) : mfnOf.get(c.id)?.mfnSuggestion && (
                        <span className="mt-1 block text-[11px] text-ink-500">
                          Best for the holder today: {labelOf(mfnOf.get(c.id).mfnSuggestion.adoptedId)}, {shares(mfnOf.get(c.id).mfnSuggestion.shares)} shares as converted
                          {canEdit && (
                            <button className="ml-1 text-brand-600 hover:text-brand-700" onClick={() => openElection(c)}>Record election</button>
                          )}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <StatusBadge status={c.status} />
                      {c.status === 'PENDING_APPROVAL' && <Link to="/consents" className="mt-1 block text-[11px] text-brand-600 hover:text-brand-700">Board consent pending</Link>}
                      {c.status === 'PENDING_SIGNATURE' && blocks.length > 0 && (
                        <span className="mt-1 block text-[11px] text-ink-500">
                          {blocks.filter((s) => s.status === 'SIGNED').length} of {blocks.length} signed
                          {blocks.some((s) => s.status !== 'SIGNED') && ` · waiting for ${blocks.filter((s) => s.status !== 'SIGNED').map((s) => (s.stakeholderId ? nameOf.get(s.stakeholderId) ?? s.signerName : 'the Company')).join(' and ')}`}
                        </span>
                      )}
                      {onPlatform && !pending && c.status !== 'CANCELLED' && (
                        c.fundsReceivedOn
                          ? <span className="mt-1 block text-[11px] text-ink-500">Funded {date(c.fundsReceivedOn)}{c.fundsReference ? ` · ${c.fundsReference}` : ''}</span>
                          : <Badge tone="warning" className="mt-1">Funds pending</Badge>
                      )}
                      {/* The executed agreement keeps its own words and its own dialog, which
                          shows the signature blocks; anything else filed against the instrument
                          is listed by name and opens on a click, for every role. */}
                      {(filedOn.get(c.id) ?? []).map((d) => (
                        // The agreement the app wrote belongs in its own dialog, which carries
                        // the signature blocks, whether or not it has been signed yet. Only the
                        // wording changes with its state.
                        d === agreement ? (
                          <button key={d.id} title={d.name}
                            className="mt-1 block max-w-[13rem] truncate text-left text-[11px] text-brand-600 hover:text-brand-700"
                            onClick={() => setViewing(d)}>
                            {!pending && d.status === 'EXECUTED' ? 'Signed agreement' : d.name}
                          </button>
                        ) : documentAccess(companyId!, d) === 'none' ? (
                          // Neither text nor a stored file: named, but not offered as something
                          // to open, because nothing would come back.
                          <span key={d.id} className="mt-1 block max-w-[13rem] truncate text-[11px] text-ink-500" title={d.name}>
                            {d.name}
                          </span>
                        ) : (
                          <button key={d.id} title={d.name}
                            className="mt-1 block max-w-[13rem] truncate text-left text-[11px] text-brand-600 hover:text-brand-700"
                            onClick={() => openDocument(d)}>{d.name}</button>
                        )
                      ))}
                    </TD>
                    {/* At most one button for the thing this row is waiting on and the rest in
                        the menu: four side by side wrapped into a ragged block. The menu itself
                        is here for every role, because the documents are worth reading whether
                        or not you may change anything. */}
                    <TD align="right">
                      <span className="flex flex-nowrap items-center justify-end gap-1">
                        {canEdit && pending && (
                          companyBlock(c)?.status === 'PENDING' ? (
                            <Button size="sm" variant="primary" onClick={() => { setSignature(user?.name ?? ''); setCountersigning({ ...companyBlock(c), document: agreementOf.get(c.id) }); }}>Countersign</Button>
                          ) : holderBlock(c)?.status === 'PENDING' ? (
                            <Button size="sm" loading={busy} onClick={() => void remind(c)}>Remind</Button>
                          ) : null
                        )}
                        {canEdit && !pending && onPlatform && !c.fundsReceivedOn && c.status === 'OUTSTANDING' && (
                          <Button size="sm" onClick={() => { setFunds({ receivedOn: today(), reference: '' }); setFunding(c); }}>Funds received</Button>
                        )}
                        <ActionMenu items={[
                          { label: 'Open the record', icon: 'convert', onClick: () => navigate(`/convertibles/${c.id}`) },
                          { label: 'Documents', icon: 'document', onClick: () => setDocumentsFor(c) },
                          ...(pending && agreementOf.get(c.id)
                            ? [{ label: 'View the agreement', icon: 'eye' as const, onClick: () => setViewing(agreementOf.get(c.id)) }] : []),
                          ...(canEdit && pending && companyBlock(c)?.status === 'PENDING' && holderBlock(c)?.status === 'PENDING'
                            ? [{ label: 'Remind the holder', icon: 'megaphone' as const, onClick: () => { void remind(c); } }] : []),
                          ...(canEdit && !pending
                            ? [{ label: 'Edit the terms', icon: 'edit' as const, onClick: () => openEdit(c) }] : []),
                          ...(canEdit && mfnOf.has(c.id) && c.status === 'OUTSTANDING'
                            ? [{ label: mfnOf.get(c.id).mfnElection ? 'Correct the MFN election' : 'Record the MFN election', icon: 'convert' as const, onClick: () => openElection(c) }] : []),
                          ...(canEdit && pending
                            ? [{ label: 'Withdraw before signing', icon: 'trash' as const, danger: true, onClick: () => setWithdrawing(c) }] : []),
                          ...(canEdit && c.status === 'OUTSTANDING' ? [
                            { label: 'Record repayment', icon: 'wallet' as const,
                              onClick: () => { setSettle({ date: today(), amount: '', reason: '' }); setSettling({ c, kind: 'repay' }); } },
                            { label: 'Cancel the instrument', icon: 'trash' as const, danger: true,
                              onClick: () => { setSettle({ date: today(), amount: '', reason: '' }); setSettling({ c, kind: 'cancel' }); } },
                          ] : []),
                          ...(canEdit && !pending
                            ? [{ label: 'Delete the instrument', icon: 'trash' as const, danger: true, onClick: () => setConfirmDelete(c) }] : []),
                        ]} />
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {stack && stack.instruments.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Conversion economics"
            subtitle="What each instrument is contractually entitled to at the next priced round" />
          <Table>
            <thead>
              <tr>
                <TH>Holder</TH><TH>Instrument</TH>
                <TH align="right">Converting amount</TH>
                <TH align="right">Implied ownership</TH>
                <TH>Notes</TH>
              </tr>
            </thead>
            <tbody>
              {stack.instruments.map((i: any) => (
                <TR key={i.id}>
                  <TD>{nameOf.get(i.stakeholderId) ?? '—'}</TD>
                  <TD className="text-ink-600">{INSTRUMENT_LABELS[i.instrument] ?? i.instrument}</TD>
                  <TD align="right" mono>{money(i.amount)}</TD>
                  <TD align="right" mono>
                    {i.impliedOwnershipPct != null ? percent(i.impliedOwnershipPct) : <span className="text-ink-400">Price dependent</span>}
                  </TD>
                  <TD className="text-[12px] text-ink-500">
                    {i.matured ? <Badge tone="danger">Matured</Badge>
                      : i.impliedOwnershipPct != null ? 'Fixed share of the pre-new-money company'
                      : 'Converts at the lower of the cap price and the discounted round price'}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* Raise: one set of terms, several investors, approval and signatures */}
      <FormModal open={raising} onClose={() => setRaising(false)} busy={busy} size="lg"
        title="Raise with SAFEs or notes"
        description="Set the terms once, list the investors, then send each instrument for signature. Nothing counts in the conversion math until both sides have signed."
        onSubmit={raise} submitLabel={raiseLabel}>
        <div className="rounded-lg border border-ink-200 p-3.5">
          <p className="mb-3 text-[13px] font-semibold text-ink-900">Terms</p>
          <FormGrid>
            <Field label="Instrument" required>
              <Select value={terms.instrument} onChange={(e) => setTerms({ ...terms, instrument: e.target.value })}>
                <option value="SAFE_POST">SAFE — post-money valuation cap</option>
                <option value="SAFE_PRE">SAFE — pre-money valuation cap</option>
                <option value="NOTE">Convertible note</option>
                <option value="KISS">KISS</option>
              </Select>
            </Field>
            <Field label="Issue date" required>
              <Input type="date" value={terms.issueDate} onChange={(e) => setTerms({ ...terms, issueDate: e.target.value })} required />
            </Field>
            <Field label={<>Valuation cap<InfoDot text={terms.instrument === 'SAFE_POST' ? 'Post-money cap: ownership equals principal divided by the cap.' : 'Pre-money cap, measured against the capitalization before this round.'} /></>}
              hint="Leave empty for an uncapped instrument.">
              <Input value={terms.valuationCap} onChange={(e) => setTerms({ ...terms, valuationCap: e.target.value })} placeholder={amountHint(20_000_000)} />
            </Field>
            <Field label="Discount (%)" hint="Applied to the round price.">
              <Input value={terms.discount} onChange={(e) => setTerms({ ...terms, discount: e.target.value })} placeholder="20" />
            </Field>
            {!termsAreSafe && (
              <>
                <Field label="Interest rate (%)"><Input value={terms.interestRate} onChange={(e) => setTerms({ ...terms, interestRate: e.target.value })} placeholder="8" /></Field>
                <Field label="Compounding">
                  <Select value={terms.compounding} onChange={(e) => setTerms({ ...terms, compounding: e.target.value })}>
                    <option value="SIMPLE">Simple</option><option value="ANNUAL">Annual</option><option value="MONTHLY">Monthly</option><option value="DAILY">Daily</option>
                  </Select>
                </Field>
                <Field label="Maturity date"><Input type="date" value={terms.maturityDate} onChange={(e) => setTerms({ ...terms, maturityDate: e.target.value })} /></Field>
              </>
            )}
            <Field label="Qualified financing minimum" hint="The round must raise at least this much to trigger conversion.">
              <Input value={terms.qualifiedFinancingMinimum} onChange={(e) => setTerms({ ...terms, qualifiedFinancingMinimum: e.target.value })} placeholder={amountHint(3_000_000)} />
            </Field>
          </FormGrid>
          <div className="mt-3 space-y-2">
            <Checkbox label="Most favoured nation (MFN)" hint="Adopts the best terms of any instrument issued after this one." checked={terms.mfn} onChange={(v) => setTerms({ ...terms, mfn: v })} />
            <Checkbox label="Pro rata participation right" hint="Entitles the holder to maintain their ownership in the next round." checked={terms.proRataRight} onChange={(v) => setTerms({ ...terms, proRataRight: v })} />
          </div>
        </div>

        <div className="rounded-lg border border-ink-200 p-3.5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[13px] font-semibold text-ink-900">Investors</p>
            <span className="text-[12px] tabular text-ink-500">{investorTotal ? `${money(investorTotal)} in total` : 'Add each investor and their amount'}</span>
          </div>
          <div className="space-y-2">
            {investors.map((line, idx) => (
              <div key={line.key} className="grid gap-2 sm:grid-cols-[1fr_150px_120px_auto]">
                <Select value={line.stakeholderId} onChange={(e) => setInvestors(investors.map((l) => (l.key === line.key ? { ...l, stakeholderId: e.target.value } : l)))} required={idx === 0}>
                  <option value="">Select an investor</option>
                  {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                <Input value={line.principal} onChange={(e) => setInvestors(investors.map((l) => (l.key === line.key ? { ...l, principal: e.target.value } : l)))} placeholder={amountHint(250_000)} required={idx === 0} />
                <Input value={line.label} onChange={(e) => setInvestors(investors.map((l) => (l.key === line.key ? { ...l, label: e.target.value } : l)))} placeholder="SAFE-7" />
                <Button type="button" variant="ghost" aria-label="Remove investor" disabled={investors.length === 1} onClick={() => setInvestors(investors.filter((l) => l.key !== line.key))}>
                  <Icon name="trash" className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button type="button" size="sm" icon={<Icon name="plus" />} onClick={() => setInvestors([...investors, newLine()])}>Add investor</Button>
            <span className="text-[12px] text-ink-500">Investors must exist as stakeholders. <Link to="/stakeholders" className="underline">Add one</Link> first if needed.</span>
          </div>
        </div>

        <div className="rounded-lg border border-ink-200 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink-900">Board approval</p>
            <SegmentedControl value={issue.approval} onChange={(v: Approval) => setIssue({ ...issue, approval: v })} options={[
              { value: 'APPROVED', label: 'Already approved' }, { value: 'REQUEST', label: 'Request approval' }, { value: 'NONE', label: 'Not recorded' },
            ]} />
          </div>
          {issue.approval === 'APPROVED' && (
            <div className="mt-3 max-w-xs">
              <Field label="Board approval date"><Input type="date" value={issue.boardApprovalDate} onChange={(e) => setIssue({ ...issue, boardApprovalDate: e.target.value })} /></Field>
            </div>
          )}
          {issue.approval === 'REQUEST' && (
            <div className="mt-3">
              <p className="mb-2 text-[12px] text-ink-600">One written consent covers every instrument in this batch. They go out for signature once the directors below have approved.</p>
              {directors.length === 0
                ? <p className="text-[12px] text-amber-700">No directors on file — give a stakeholder the Board member relationship first.</p>
                : directors.map((d) => (
                  <Checkbox key={d.id} label={d.name} checked={issue.directorIds.includes(d.id)}
                    onChange={(v) => setIssue({ ...issue, directorIds: v ? [...issue.directorIds, d.id] : issue.directorIds.filter((id) => id !== d.id) })} />
                ))}
            </div>
          )}
          {issue.approval === 'NONE' && <p className="mt-3 text-[12px] text-ink-500">Recorded without an approval date.</p>}
        </div>

        <div className="rounded-lg border border-ink-200 p-3.5">
          <Checkbox label="Send each agreement for e-signature"
            hint="The investor signs from their portal and the Company countersigns. The instrument is outstanding once both have signed."
            checked={issue.forSignature} onChange={(v) => setIssue({ ...issue, forSignature: v })} />
          {issue.forSignature && (
            <div className="mt-3 space-y-3">
              <FormGrid>
                <Field label="Company signatory" required><Input value={issue.signerName} onChange={(e) => setIssue({ ...issue, signerName: e.target.value })} required /></Field>
                <Field label="Signatory title" required><Input value={issue.signerTitle} onChange={(e) => setIssue({ ...issue, signerTitle: e.target.value })} required /></Field>
                <Field label="Agreement template">
                  <Select value={issue.templateId} onChange={(e) => setIssue({ ...issue, templateId: e.target.value })}>
                    <option value="">Default SAFE / note agreement</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtIn ? ' (built-in)' : ''}{t.isDefault && !t.builtIn ? ' — default' : ''}</option>)}
                  </Select>
                </Field>
              </FormGrid>
              <Field label="Message to the investors" hint="Appears in each agreement as a note from the Company.">
                <Textarea rows={2} value={issue.message} onChange={(e) => setIssue({ ...issue, message: e.target.value })} />
              </Field>
            </div>
          )}
          {!issue.forSignature && issue.approval !== 'REQUEST' && (
            <p className="mt-3 text-[12px] text-ink-500">The instruments are recorded as outstanding immediately, as if signed agreements were on file.</p>
          )}
        </div>
      </FormModal>

      {/* Record or edit a single instrument signed elsewhere */}
      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={crud.busy} size="lg"
        title={editing?.id ? 'Edit instrument' : 'Record a SAFE or note'}
        description="For instruments signed outside the platform. Post-money SAFEs fix the holder's ownership percentage; pre-money SAFEs and notes price against the pre-money capitalization."
        onSubmit={save} submitLabel={editing?.id ? 'Save changes' : 'Record instrument'}>
        <FormGrid>
          <Field label="Holder" required>
            <Select value={form.stakeholderId} onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })} required>
              <option value="">Select a stakeholder</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Instrument" required>
            <Select value={form.instrument} onChange={(e) => setForm({ ...form, instrument: e.target.value })}>
              <option value="SAFE_POST">SAFE — post-money valuation cap</option>
              <option value="SAFE_PRE">SAFE — pre-money valuation cap</option>
              <option value="NOTE">Convertible note</option>
              <option value="KISS">KISS</option>
            </Select>
          </Field>
          <Field label="Principal amount" required>
            <Input value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} placeholder={amountHint(500_000)} required />
          </Field>
          <Field label="Issue date" required>
            <Input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} required />
          </Field>
          <Field label={<>Valuation cap<InfoDot text={isSafe && form.instrument === 'SAFE_POST' ? 'Post-money cap: ownership equals principal divided by the cap.' : 'Pre-money cap, measured against the capitalization before this round.'} /></>}
            hint="Leave empty for an uncapped instrument.">
            <Input value={form.valuationCap} onChange={(e) => setForm({ ...form, valuationCap: e.target.value })} placeholder={amountHint(20_000_000)} />
          </Field>
          <Field label="Discount (%)" hint="Applied to the round price.">
            <Input value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} placeholder="20" />
          </Field>
          {!isSafe && (
            <>
              <Field label="Interest rate (%)">
                <Input value={form.interestRate} onChange={(e) => setForm({ ...form, interestRate: e.target.value })} placeholder="8" />
              </Field>
              <Field label="Compounding">
                <Select value={form.compounding} onChange={(e) => setForm({ ...form, compounding: e.target.value })}>
                  <option value="SIMPLE">Simple</option>
                  <option value="ANNUAL">Annual</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="DAILY">Daily</option>
                </Select>
              </Field>
              <Field label="Maturity date">
                <Input type="date" value={form.maturityDate} onChange={(e) => setForm({ ...form, maturityDate: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Qualified financing minimum" hint="The round must raise at least this much to trigger conversion.">
            <Input value={form.qualifiedFinancingMinimum}
              onChange={(e) => setForm({ ...form, qualifiedFinancingMinimum: e.target.value })} placeholder={amountHint(3_000_000)} />
          </Field>
        </FormGrid>
        <div className="space-y-2">
          <Checkbox label="Most favoured nation (MFN)"
            hint="Adopts the best terms of any instrument issued after this one."
            checked={form.mfn} onChange={(v) => setForm({ ...form, mfn: v })} />
          <Checkbox label="Pro rata participation right"
            hint="Entitles the holder to maintain their ownership in the next round."
            checked={form.proRataRight} onChange={(v) => setForm({ ...form, proRataRight: v })} />
        </div>
      </FormModal>

      <FormModal open={!!funding} onClose={() => setFunding(null)} busy={busy} title="Record funds received" submitLabel="Record" onSubmit={recordFunds}
        description={funding ? `${money(funding.principal)} from ${nameOf.get(funding.stakeholderId) ?? 'the investor'} for ${funding.label ?? INSTRUMENT_LABELS[funding.instrument]}.` : undefined}>
        <FormGrid>
          <Field label="Date received" required><Input type="date" value={funds.receivedOn} onChange={(e) => setFunds({ ...funds, receivedOn: e.target.value })} required /></Field>
          <Field label="Reference" hint="Wire reference or bank memo."><Input value={funds.reference} onChange={(e) => setFunds({ ...funds, reference: e.target.value })} /></Field>
        </FormGrid>
      </FormModal>

      <FormModal open={!!electing} onClose={() => setElecting(null)} busy={busy}
        title={electing && mfnOf.get(electing.id)?.mfnElection ? 'Correct the MFN election' : 'Record the MFN election'} submitLabel="Record" onSubmit={recordElection}
        description="The holder's safe is amended to match one later instrument: its cap, discount and pre- or post-money basis. Every view uses those terms from the election date.">
        <FormGrid>
          <Field label="Adopted instrument" required>
            <Select value={election.adoptedId} onChange={(e) => setElection({ ...election, adoptedId: e.target.value })} required>
              <option value="">Choose…</option>
              {electing && candidatesOf(electing, election.date).map((o) => <option key={o.id} value={o.id}>{labelOf(o.id)}</option>)}
            </Select>
          </Field>
          <Field label="Election date" required><Input type="date" value={election.date} onChange={(e) => setElection({ ...election, date: e.target.value })} required /></Field>
        </FormGrid>
      </FormModal>

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

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.name ?? 'Agreement'} size="xl" footer={<>
        {viewing?.id && viewing.status === 'EXECUTED' && <Button icon={<Icon name="eye" />} onClick={() => setReading(viewing)}>Read PDF</Button>}
        <Button onClick={() => setViewing(null)}>Close</Button>
      </>}>
        {viewing?.status === 'EXECUTED' && <div className="mb-3"><Banner tone="success" title="Fully executed">Every party has signed; the instrument is outstanding.</Banner></div>}
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

      <Modal open={!!documentsFor} onClose={() => setDocumentsFor(null)} size="lg" title="Documents"
        description={documentsFor
          ? `Filed against the ${INSTRUMENT_LABELS[documentsFor.instrument] ?? 'instrument'} held by ${nameOf.get(documentsFor.stakeholderId) ?? 'this holder'}.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} securityId={documentsFor.id} stakeholderId={documentsFor.stakeholderId} />
        )}
      </Modal>

      <ConfirmDialog open={!!withdrawing} onClose={() => setWithdrawing(null)} danger loading={busy}
        title="Withdraw instrument" confirmLabel="Withdraw"
        message={<>Withdraw the {withdrawing ? INSTRUMENT_LABELS[withdrawing.instrument] : 'instrument'} for <strong>{withdrawing ? nameOf.get(withdrawing.stakeholderId) : ''}</strong> before it is issued? Its agreement and signature requests are removed; nothing was ever outstanding.</>}
        onConfirm={() => void withdraw()} />

      <FormModal open={!!settling} onClose={() => setSettling(null)} busy={crud.busy} danger={settling?.kind === 'cancel'}
        title={settling?.kind === 'repay' ? 'Record repayment' : 'Cancel instrument'}
        submitLabel={settling?.kind === 'repay' ? 'Record repayment' : 'Record cancellation'} onSubmit={doSettle}
        description="Closes the instrument as of a date. The ledger records it, so views of earlier dates still show it outstanding.">
        <FormGrid>
          <Field label={settling?.kind === 'repay' ? 'Repaid on' : 'Cancelled on'} required>
            <Input type="date" value={settle.date} onChange={(e) => setSettle({ ...settle, date: e.target.value })} required />
          </Field>
          {settling?.kind === 'repay' ? (
            <Field label="Amount repaid" hint="Principal and interest paid back. Optional.">
              <Input value={settle.amount} onChange={(e) => setSettle({ ...settle, amount: e.target.value })} placeholder="$250,000" />
            </Field>
          ) : (
            <Field label="Reason"><Input value={settle.reason} onChange={(e) => setSettle({ ...settle, reason: e.target.value })} placeholder="Recorded in error" /></Field>
          )}
        </FormGrid>
      </FormModal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={crud.busy}
        title="Delete instrument" confirmLabel="Delete"
        message="This removes the instrument from the cap table entirely. Mark it converted or repaid instead to keep the history."
        onConfirm={async () => { if (await crud.remove(confirmDelete.id, 'Instrument deleted')) { setConfirmDelete(null); reloadStack(); } }} />
      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        path={reading && companyId ? readableDocumentPath(companyId, reading) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />

    </>
  );
}
