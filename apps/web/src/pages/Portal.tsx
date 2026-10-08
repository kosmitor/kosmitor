import { useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, api, downloadFile } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Stat, Badge, Loading, ErrorNote, Button,
  MiniBar, KeyValue, Field, Input, Select, Modal, useToast, Banner, InfoDot, StatusBadge,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { VestingChart } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { DocumentPreview } from '../PdfFrame.tsx';
import { money, shares, pps, percent, date, relativeDate, AWARD_LABELS, INSTRUMENT_LABELS, parseMoney, fieldNumber } from '../format.ts';
import { categoryLabel, documentAccess, readableDocumentPath, documentFilename, downloadDocumentPath } from '../documents.ts';
import { config } from '../config.ts';

export default function Portal() {
  const { companyId, company } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any>(companyId ? `/c/${companyId}/portal` : null, [companyId]);
  const [modeling, setModeling] = useState<any>(null);
  const [openUpdate, setOpenUpdate] = useState<string | null>(null);
  const [reading, setReading] = useState<any>(null);
  // The exit model starts at modeling.portalMaxExit in kosmitor.config.json, in dollars.
  const [exitValue, setExitValue] = useState(() => fieldNumber(config.modeling.portalMaxExit));
  const [curve, setCurve] = useState<any[] | null>(null);
  const [signing, setSigning] = useState<any>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkTo, setLinkTo] = useState('');
  const [requesting, setRequesting] = useState<any>(null);
  const [request, setRequest] = useState({ quantity: '', method: 'CASH', note: '' });

  if (loading) return <Loading label="Loading your equity" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  if (!data.linked) {
    const suggestions: { id: string; name: string; relation: string }[] = data.suggestions ?? [];
    const link = async (stakeholderId: string) => {
      setBusy(true);
      try {
        await api(`/c/${companyId}/portal/link`, { body: { stakeholderId } });
        toast('Your account is now linked');
        reload();
      } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
    };
    return (
      <>
        <PageHeader concept="my-equity" title="My equity" subtitle={`Your position in ${company?.name ?? 'the company'}`} />
        <Card>
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500"><Icon name="wallet" className="size-6" /></span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold text-ink-900">Your account is not linked to a stakeholder record yet</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-600">
                This page shows the shares, options and documents of the stakeholder record linked to your sign-in.
                You sign in as <span className="font-medium text-ink-800">{data.loginEmail}</span>; accounts are linked automatically
                only when a stakeholder record carries the same email.
              </p>
              {suggestions.length > 0 && (
                <div className="mt-4">
                  <p className="text-[13px] font-medium text-ink-800">{suggestions.length === 1 ? 'Is this you?' : 'Is one of these you?'}</p>
                  <ul className="mt-2 space-y-2">
                    {suggestions.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 px-3 py-2">
                        <span className="text-[13px]"><span className="font-medium text-ink-900">{s.name}</span> <span className="text-ink-500">· {s.relation.toLowerCase().replace('_', ' ')}</span></span>
                        {data.canLink && <Button size="sm" variant="primary" loading={busy} onClick={() => void link(s.id)}>Link my account</Button>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.canLink ? (
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <Field label={suggestions.length ? 'Or choose another stakeholder' : 'Choose your stakeholder record'} className="w-80">
                    <Select value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
                      <option value="">Select…</option>
                      {(data.stakeholders ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  </Field>
                  <Button variant="primary" disabled={!linkTo} loading={busy} onClick={() => void link(linkTo)}>Link</Button>
                </div>
              ) : (
                <p className="mt-4 text-[13px] text-ink-600">
                  Ask an administrator to link your account{suggestions.length ? ` to ${suggestions.map((s) => s.name).join(' or ')}` : ''} on
                  the <span className="font-medium">Team &amp; access</span> page (Edit access → Linked stakeholder), or to put
                  {' '}<span className="font-medium text-ink-800">{data.loginEmail}</span> on your stakeholder record.
                </p>
              )}
            </div>
          </div>
        </Card>
      </>
    );
  }

  const p = data.portfolio;

  const runExitModel = async () => {
    setBusy(true);
    try {
      const res = await api(`/c/${companyId}/model/exit-curve`, {
        body: { stakeholderId: data.holder.id, maxExit: parseMoney(exitValue), points: 20 },
      });
      setCurve(res);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const submitRequest = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/exercise-requests`, { body: { awardId: requesting.award.id, quantity: Number(String(request.quantity).replace(/[^0-9.]/g, '')), method: request.method, note: request.note || null } });
      toast('Request sent — the company will review it');
      setRequesting(null);
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const withdraw = async (id: string) => {
    setBusy(true);
    try { await api(`/c/${companyId}/exercise-requests/${id}/withdraw`, { body: {} }); toast('Request withdrawn'); reload(); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const castVote = async (consentId: string, vote: 'APPROVE' | 'REJECT') => {
    setBusy(true);
    try { await api(`/c/${companyId}/consents/${consentId}/vote`, { body: { vote } }); toast(vote === 'APPROVE' ? 'Approved' : 'Rejected'); reload(); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const sign = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/signatures/${signing.id}/sign`, { body: { typedSignature: signature } });
      toast('Signed');
      setSigning(null);
      setSignature('');
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader concept="my-equity" title="My equity"
        subtitle={`Your position in ${company?.name ?? 'the company'} as of today`} />

      {data.pendingSignatures.length > 0 && (
        <div className="mb-5">
          <Banner tone="warning" title={`${data.pendingSignatures.length} document${data.pendingSignatures.length > 1 ? 's' : ''} awaiting your signature`}>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.pendingSignatures.map((s: any) => (
                // A long document name is cut short inside the button rather than pushing it out of the banner.
                <Button key={s.id} size="sm" variant="primary" className="max-w-full" title={s.documentName ?? undefined}
                  onClick={() => { setSignature(''); setSigning(s); }}>
                  <span className="min-w-0 truncate">Review &amp; sign{s.documentName ? ` · ${s.documentName}` : ''}</span>
                </Button>
              ))}
            </div>
          </Banner>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {p.fmv != null
          ? <Stat label="Total value today" value={money(p.totalValue, { compact: true })} hint={`At the ${pps(p.fmv)} fair market value`} />
          : <Stat label="Total value today" value="—" hint="Valuations are not shared here" />}
        <Stat label="Shares owned" value={shares(p.sharesOwned)}
          hint={p.costBasis ? `${money(p.costBasis, { compact: true })} cost basis` : 'No purchased shares'} />
        <Stat label="Vested options" value={shares(p.vestedOptions)}
          hint={`${shares(p.unvestedOptions)} still unvested`} />
        {data.ownershipPct != null
          ? <Stat label="Ownership" value={percent(data.ownershipPct)} hint={`of ${shares(data.companyFullyDiluted)} fully diluted shares`} />
          : <Stat label="Ownership" value="—" hint="Ownership percentages are not shared here" />}
      </div>

      {p.grants.length > 0 && (
        <div className="mt-5 space-y-5">
          {p.grants.map((g: any) => {
            const a = g.award;
            const exerciseCost = Math.round((g.vested * a.strikePrice) / 1e4);
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold">{a.label ?? 'Equity grant'}</h3>
                      <Badge tone={a.type === 'ISO' ? 'brand' : a.type === 'RSU' ? 'info' : 'neutral'}>
                        {AWARD_LABELS[a.type] ?? a.type}
                      </Badge>
                      {g.underwater && <Badge tone="warning">Underwater</Badge>}
                    </div>
                    <p className="mt-1 text-[13px] text-ink-500">
                      {shares(a.quantity)} shares granted {date(a.grantDate)}
                      {a.strikePrice > 0 && ` at ${pps(a.strikePrice)} per share`}
                      {` · ${g.scheduleName}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setModeling(g)}>Model an exercise</Button>
                    {data.exerciseRequestsEnabled && a.type !== 'RSU' && a.type !== 'PHANTOM' && g.vested - a.exercisedQuantity > 0 && (
                      <Button size="sm" variant="primary" onClick={() => { setRequest({ quantity: String(Math.round(g.vested - a.exercisedQuantity)), method: 'CASH', note: '' }); setRequesting(g); }}>Request exercise</Button>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-5 border-t border-ink-100 pt-4 lg:grid-cols-[1fr_320px]">
                  <div>
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="text-[13px] text-ink-600">
                        {shares(g.vested)} of {shares(a.quantity)} vested
                      </span>
                      <span className="text-[13px] font-medium tabular">{percent(g.percentVested, 1)}</span>
                    </div>
                    <MiniBar value={g.percentVested} />
                    {g.curve.length > 0 && <div className="mt-4"><VestingChart data={g.curve} total={a.quantity} height={180} /></div>}
                  </div>
                  <div>
                    <KeyValue columns={1} items={[
                      { label: 'Vested and exercisable', value: shares(g.vested) },
                      { label: 'Unvested', value: shares(g.unvested) },
                      { label: 'Already exercised', value: shares(a.exercisedQuantity) },
                      ...(a.strikePrice > 0 ? [
                        { label: 'Cost to exercise all vested', value: money(exerciseCost) },
                        { label: <>Intrinsic value<InfoDot text="Current fair market value less the strike price, on your vested shares." /></>,
                          value: g.intrinsicValue == null ? '—' : <span className={g.intrinsicValue > 0 ? 'font-semibold text-secondary-800' : ''}>{money(g.intrinsicValue)}</span> },
                      ] : [
                        { label: 'Value at current FMV', value: p.fmv == null ? '—' : money(Math.round((g.vested * p.fmv) / 1e4)) },
                      ]),
                      { label: 'Next vesting date',
                        value: g.nextVestDate
                          ? <>{date(g.nextVestDate)} <span className="text-ink-500">({shares(g.nextVestQuantity)} shares, {relativeDate(g.nextVestDate)})</span></>
                          : 'Fully vested' },
                      ...(a.expirationDate ? [{ label: 'Expires', value: date(a.expirationDate) }] : []),
                    ]} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {data.issuances.length > 0 && (
        <DataTable className="mt-5" title="Shares you own" subtitle="Certificates issued in your name" caption="Shares you own"
          rows={data.issuances} rowKey={(i) => i.id}
          columns={[
            { key: 'certificate', label: 'Certificate', value: (i) => i.certificateNo ?? i.id.slice(-6).toUpperCase(), className: 'font-medium' },
            { key: 'quantity', label: 'Shares', type: 'number', value: (i) => i.quantity },
            { key: 'price', label: 'Price paid', type: 'price', value: (i) => i.pricePerShare },
            { key: 'issued', label: 'Issued', type: 'date', value: (i) => i.issueDate, className: 'text-ink-600' },
            {
              key: 'election', label: '83(b) election',
              cell: (i) => (i.election83bFiledOn
                ? <Badge tone="success">Filed {date(i.election83bFiledOn)}</Badge>
                : i.vestingScheduleId || i.earlyExercised
                  ? <span className="flex flex-wrap items-center gap-2"><Badge tone="warning">Not filed</Badge><button type="button" className="text-[12px] text-brand-600 hover:text-brand-700" onClick={() => window.open(`/api/c/${companyId}/compliance/83b/${i.id}/print`, '_blank', 'noopener')}>Election letter</button></span>
                  : <span className="text-ink-400">Not applicable</span>),
            },
          ]} />
      )}

      {data.convertibles.length > 0 && (
        <DataTable className="mt-5" title="Your convertible instruments" caption="Your convertible instruments"
          rows={data.convertibles} rowKey={(c) => c.id}
          columns={[
            { key: 'instrument', label: 'Instrument', value: (c) => INSTRUMENT_LABELS[c.instrument] ?? c.instrument },
            { key: 'principal', label: 'Principal', type: 'money', value: (c) => c.principal, cell: (c) => money(c.principal, { compact: true }) },
            {
              key: 'cap', label: 'Cap', type: 'money', value: (c) => c.valuationCap || null,
              cell: (c) => (c.valuationCap ? money(c.valuationCap, { compact: true }) : 'Uncapped'),
            },
            { key: 'discount', label: 'Discount', type: 'number', value: (c) => c.discount || null, cell: (c) => (c.discount ? percent(c.discount, 0) : '—') },
            { key: 'issued', label: 'Issued', type: 'date', value: (c) => c.issueDate, className: 'text-ink-600' },
            { key: 'status', label: 'Status', value: (c) => c.status, cell: (c) => <Badge tone={c.status === 'OUTSTANDING' ? 'success' : 'neutral'}>{c.status.toLowerCase()}</Badge> },
          ]} />
      )}

      {data.documents.length > 0 && (
        // Newest first, as the server sends them.
        <DataTable className="mt-5" title="Your documents" caption="Your documents" rows={data.documents} rowKey={(d) => d.id}
          search={{ placeholder: 'Search by name or category', by: (d) => [d.name, d.fileName, categoryLabel(d.category)] }}
          defaultSort={{ key: 'created', direction: 'desc' }}
          columns={[
            {
              key: 'name', label: 'Document', value: (d) => d.name, wrap: true, className: 'font-medium',
              cell: (d) => <>{d.name}{d.fileName && <span className="ml-2 text-[11px] text-ink-500">{d.fileName}</span>}</>,
            },
            { key: 'category', label: 'Category', value: (d) => categoryLabel(d.category), className: 'text-ink-600' },
            { key: 'created', label: 'Created', type: 'date', value: (d) => d.createdAt, cell: (d) => date(d.createdAt?.slice(0, 10)), className: 'text-ink-600' },
            {
              key: 'status', label: 'Status', value: (d) => d.status,
              cell: (d) => <Badge tone={d.status === 'EXECUTED' ? 'success' : 'warning'}>{d.status.replace(/_/g, ' ').toLowerCase()}</Badge>,
            },
            {
              key: 'actions', label: '', align: 'right',
              cell: (d) => (
                <span className="flex justify-end gap-1">
                  {/* Whether a holder can read their own paperwork is decided the one way
                      the rest of the app decides it. This used to insist on a document
                      being EXECUTED before offering to read it, which meant a file the
                      company filed against their shares could be seen but not opened. */}
                  {d.body && (
                    <Button size="sm" variant="ghost" icon={<Icon name="download" className="size-3.5" />}
                      onClick={() => window.open(`/api/c/${companyId}/documents/${d.id}/print`, '_blank', 'noopener')}>
                      Print
                    </Button>
                  )}
                  {documentAccess(companyId!, d) === 'read' && (
                    <Button size="sm" variant="ghost" icon={<Icon name="eye" className="size-3.5" />}
                      onClick={() => setReading({ ...d, path: readableDocumentPath(companyId!, d), file: documentFilename(d) })}>
                      Read
                    </Button>
                  )}
                  {documentAccess(companyId!, d) === 'download' && (
                    <Button size="sm" variant="ghost" icon={<Icon name="download" className="size-3.5" />}
                      onClick={() => downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d)).catch((e: Error) => toast(e.message, 'error'))}>
                      Download
                    </Button>
                  )}
                </span>
              ),
            },
          ]} />
      )}

      {(data.pendingVotes ?? []).length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Approvals waiting for you" subtitle="Resolutions the company has asked you to vote on" />
          <ul className="divide-y divide-ink-100">
            {data.pendingVotes.map((c: any) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink-900">{c.title}</p>
                  <p className="text-[12px] text-ink-500">
                    {c.kind === 'STOCKHOLDER' ? `Stockholder approval · your ${shares(Number(c.myWeight ?? 0))} votes count toward a ${percent(Number(c.threshold ?? 0.5), 0)} threshold` : 'Board consent · every director must approve'} · effective {date(c.effectiveDate)}
                  </p>
                  {c.body && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-700">{c.body}</p>}
                </div>
                <span className="flex shrink-0 gap-2">
                  <Button size="sm" loading={busy} onClick={() => void castVote(c.id, 'REJECT')}>Reject</Button>
                  <Button size="sm" variant="primary" loading={busy} onClick={() => void castVote(c.id, 'APPROVE')}>Approve</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(data.updates ?? []).length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Company updates" subtitle="News the company has shared with you" />
          <ul className="divide-y divide-ink-100">
            {data.updates.map((u: any) => (
              <li key={u.id} className="py-3">
                <button type="button" className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => { setOpenUpdate(openUpdate === u.id ? null : u.id); if (!u.viewedAt) void api(`/c/${companyId}/portal/updates/${u.id}/read`, { body: {} }).then(() => reload()).catch(() => undefined); }}>
                  <span>
                    <span className="block text-[14px] font-medium text-ink-900">{u.title}</span>
                    <span className="block text-[12px] text-ink-500">{u.period ? `${u.period} · ` : ''}{date(String(u.sentAt).slice(0, 10))}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {!u.viewedAt && <Badge tone="brand">New</Badge>}
                    <Icon name="chevron" className={`size-4 text-ink-400 transition ${openUpdate === u.id ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {openUpdate === u.id && (
                  <div className="mt-3">
                    {u.metrics.length > 0 && (
                      <div className="mb-3 rounded-lg bg-ink-50 p-3">
                        <KeyValue columns={Math.min(3, u.metrics.length) as 1 | 2 | 3} items={u.metrics.map((m: any) => ({ label: m.label, value: m.value }))} />
                      </div>
                    )}
                    <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-800">{u.body}</div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.portalSettings?.showExitModel !== false && (
      <Card className="mt-5">
        <CardHeader title="What is my equity worth at an exit?"
          subtitle="Models your net proceeds across exit values, accounting for liquidation preferences ahead of you" />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Maximum exit value" className="w-56">
            <Input value={exitValue} onChange={(e) => setExitValue(e.target.value)} placeholder={money(config.modeling.portalMaxExit * 100, { decimals: 0 })} />
          </Field>
          <Button variant="primary" onClick={runExitModel} loading={busy}>Model outcomes</Button>
        </div>
        {curve && (
          // The model's points from the lowest exit to the highest, numbered so each row keeps its key.
          <DataTable frame="box" className="mt-4" caption="Your proceeds at each exit value"
            rows={curve.filter((_, i) => i % 2 === 1).map((c: any, i: number) => ({ ...c, row: i }))} rowKey={(c) => c.row}
            defaultSort={{ key: 'exitValue', direction: 'asc' }}
            columns={[
              { key: 'exitValue', label: 'Exit value', type: 'money', align: 'left', value: (c) => c.exitValue, cell: (c) => money(c.exitValue, { compact: true }) },
              { key: 'payout', label: 'Your proceeds', type: 'money', value: (c) => c.payout, cell: (c) => money(c.payout, { compact: true }), className: 'font-medium' },
              {
                key: 'multiple', label: 'Return on your investment', type: 'number', value: (c) => (c.multiple > 0 ? c.multiple : null),
                cell: (c) => (c.multiple > 0 ? `${c.multiple.toFixed(2)}x` : '—'), className: 'text-ink-600',
              },
            ]} />
        )}
      </Card>
      )}

      <Modal open={!!modeling} onClose={() => setModeling(null)} size="lg"
        title="Model an exercise" description="Estimates the cash and tax consequences of exercising today.">
        {modeling && <ExerciseModel grant={modeling} companyId={companyId!} fmv={p.fmv ?? 0} />}
      </Modal>

      {(data.exerciseRequests ?? []).length > 0 && (
        // Newest first, as the server sends them.
        <DataTable className="mt-5" title="Your exercise requests" caption="Your exercise requests"
          subtitle="The company reviews each request, then confirms payment and records the exercise"
          rows={data.exerciseRequests} rowKey={(r) => r.id}
          defaultSort={{ key: 'requested', direction: 'desc' }}
          columns={[
            { key: 'requested', label: 'Requested', type: 'date', value: (r) => r.requestedAt, cell: (r) => date(String(r.requestedAt).slice(0, 10)), className: 'text-ink-600' },
            { key: 'grant', label: 'Grant', value: (r) => r.awardLabel, className: 'whitespace-nowrap font-medium' },
            { key: 'quantity', label: 'Options', type: 'number', value: (r) => r.quantity },
            { key: 'method', label: 'Method', value: (r) => String(r.method).toLowerCase().replace('_', ' '), className: 'whitespace-nowrap text-ink-600' },
            { key: 'cost', label: 'Exercise price', type: 'money', value: (r) => r.estimatedCost },
            {
              key: 'status', label: 'Status', value: (r) => r.status,
              cell: (r) => (
                <>
                  <StatusBadge status={r.status === 'APPROVED' ? 'PENDING' : r.status} />
                  <span className="block text-[11px] text-ink-500">
                    {r.status === 'REQUESTED' && 'Waiting for the company to review'}
                    {r.status === 'APPROVED' && 'Approved — please pay the exercise price'}
                    {r.status === 'PAID' && 'Payment received — being recorded'}
                    {r.status === 'COMPLETED' && 'Shares issued to you'}
                    {r.status === 'REJECTED' && (r.adminNote ?? 'Not approved')}
                  </span>
                  {r.status === 'APPROVED' && data.paymentInstructions && <span className="mt-1 block whitespace-pre-wrap rounded bg-ink-50 p-2 text-[11px] text-ink-700">{data.paymentInstructions}</span>}
                </>
              ),
            },
            {
              key: 'actions', label: '', align: 'right',
              cell: (r) => ['REQUESTED', 'APPROVED'].includes(r.status) && <Button size="sm" variant="ghost" loading={busy} onClick={() => void withdraw(r.id)}>Withdraw</Button>,
            },
          ]} />
      )}

      <Modal open={!!requesting} onClose={() => setRequesting(null)} title={`Request to exercise ${requesting?.award?.label ?? 'options'}`} size="sm"
        description={requesting ? `${shares(Math.max(0, requesting.vested - requesting.award.exercisedQuantity))} vested options are exercisable at ${pps(requesting.award.strikePrice)} each.` : undefined}
        footer={<>
          <Button onClick={() => setRequesting(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submitRequest()}>Send request</Button>
        </>}>
        <div className="space-y-4">
          <Field label="Options to exercise" required><Input value={request.quantity} onChange={(e) => setRequest({ ...request, quantity: e.target.value })} /></Field>
          <Field label="How you will pay">
            <Select value={request.method} onChange={(e) => setRequest({ ...request, method: e.target.value })}>
              <option value="CASH">Cash — pay the exercise price</option>
              <option value="NET_EXERCISE">Net exercise — give up shares worth the price</option>
              <option value="PROMISSORY_NOTE">Promissory note (if your agreement allows)</option>
            </Select>
          </Field>
          <Field label="Note to the company"><Input value={request.note} onChange={(e) => setRequest({ ...request, note: e.target.value })} placeholder="Optional" /></Field>
          {requesting && <p className="rounded-lg bg-ink-50 p-3 text-[12px] text-ink-600">Estimated exercise price: {money(Math.round((Number(String(request.quantity).replace(/[^0-9.]/g, '')) || 0) * requesting.award.strikePrice / 1e4))}. The company confirms the amount and payment details when it approves.</p>}
        </div>
      </Modal>

      <Modal open={!!signing} onClose={() => setSigning(null)} title={signing?.documentName ?? 'Sign document'} size="xl"
        description="Read the document, then type your full name: that is your binding electronic signature, recorded with the time and your network address."
        footer={<>
          <Button variant="secondary" onClick={() => setSigning(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={sign}>Sign</Button>
        </>}>
        {signing?.documentId && (
          <div className="mb-4">
            <DocumentPreview companyId={companyId!} className="h-[52vh]"
              document={{ id: signing.documentId, name: signing.documentName, body: signing.documentBody, hasFace: !!signing.documentHasFace }} />
          </div>
        )}
        <Field label="Type your full name" required>
          <Input value={signature} onChange={(e) => setSignature(e.target.value)}
            placeholder={signing?.signerName} className="font-[cursive] text-lg" />
        </Field>
      </Modal>
      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        path={reading?.path ?? null} filename={reading?.file ?? 'document.pdf'} />
    </>
  );
}

/**
 * Interactive exercise and sale model for a single grant. The sale price starts
 * at modeling.portalSalePriceMultiple times the current fair market value.
 */
function ExerciseModel({ grant, companyId, fmv }: { grant: any; companyId: string; fmv: number }) {
  const [quantity, setQuantity] = useState(String(Math.round(grant.vested)));
  const [exitPrice, setExitPrice] = useState(String((fmv / 1e6) * config.modeling.portalSalePriceMultiple));
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await api(`/c/${companyId}/model/exercise`, {
        body: {
          awardId: grant.award.id, shares: Number(quantity.replace(/,/g, '')),
          exitPricePerShare: Math.round(Number(exitPrice.replace(/[$,]/g, '')) * 1e6),
        },
      });
      setResult(res);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shares to exercise" hint={`${shares(grant.vested)} vested`}>
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Assumed sale price per share">
          <Input value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} />
        </Field>
      </div>
      <Button variant="primary" className="mt-4" onClick={run} loading={busy}>Calculate</Button>

      {result && (
        <div className="mt-5 space-y-4">
          <div className="rounded-lg border border-ink-200 p-4">
            <p className="mb-3 text-[13px] font-semibold">At exercise</p>
            <KeyValue columns={2} items={[
              { label: 'Cost to exercise', value: money(result.scenario.exerciseCost) },
              { label: 'Spread', value: money(result.scenario.spread) },
              { label: result.scenario.awardType === 'ISO' ? 'AMT preference item' : 'Ordinary income',
                value: money(result.scenario.awardType === 'ISO' ? result.scenario.amtPreference : result.scenario.ordinaryIncome) },
              { label: 'Estimated tax', value: money(result.scenario.totalTaxDue) },
              { label: 'Total cash needed', value: <span className="font-semibold">{money(result.scenario.totalCashNeeded)}</span> },
            ]} />
          </div>

          {result.sale && (
            <div className="rounded-lg border border-secondary-300 bg-secondary-50/60 p-4">
              <p className="mb-3 text-[13px] font-semibold text-secondary-900">If you sell at that price</p>
              <KeyValue columns={2} items={[
                { label: 'Gross proceeds', value: money(result.sale.grossProceeds) },
                { label: 'Ordinary income portion', value: money(result.sale.ordinaryIncomePortion) },
                { label: 'Capital gain portion', value: money(result.sale.capitalGainPortion) },
                { label: 'Treatment', value: result.sale.isLongTerm ? 'Long-term capital gains' : 'Short-term' },
                { label: 'Estimated tax', value: money(result.sale.estimatedTax) },
                { label: 'Net proceeds', value: <span className="font-semibold text-secondary-800">{money(result.sale.netProceeds)}</span> },
              ]} />
            </div>
          )}

          <ul className="space-y-1.5">
            {result.scenario.notes.map((n: string, i: number) => (
              <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-600">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-400" />{n}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-ink-400">
            Planning estimates using flat marginal rates. They are not tax advice — talk to your own adviser.
          </p>
        </div>
      )}
    </>
  );
}
