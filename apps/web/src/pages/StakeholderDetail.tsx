import { useState, type ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import { FormModal } from '../crud.tsx';
import { STAKEHOLDER_BLANK, STAKEHOLDER_TYPES, EMPLOYMENT_TYPES, TERMINATION_REASONS, TAX_FORMS, ACCREDITED, StakeholderFields, stakeholderFormFrom, stakeholderPayload, labelOf, type StakeholderForm } from './stakeholders/StakeholderForm.tsx';
import {
  Card, CardHeader, Stat, Badge, Loading, ErrorNote, EmptyState, Button,
  MiniBar, KeyValue, Avatar, StatusBadge, useToast, ConceptNote,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { VestingChart, OwnershipDonut, ChartLegend } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import {
  money, shares, pps, percent, date, relativeDate,
  AWARD_LABELS, INSTRUMENT_LABELS, RELATION_LABELS,
} from '../format.ts';
import { hasBoardSeat, isDirector, isFormerDirector } from '../board.ts';

export default function StakeholderDetail() {
  const { id } = useParams<{ id: string }>();
  const { companyId, canEdit, canViewAll } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any>(
    companyId && id ? `/c/${companyId}/stakeholders/${id}/position` : null, [companyId, id]);
  // The full register entry: the position payload carries only what the engine needs.
  const record = useQuery<any>(companyId && id && canEdit !== undefined ? `/c/${companyId}/stakeholders/${id}` : null, [companyId, id]);
  // The register, for the investor who designated a director and the form's list of investors.
  const register = useQuery<any[]>(companyId && canViewAll ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<StakeholderForm>(STAKEHOLDER_BLANK);
  const [busy, setBusy] = useState(false);
  const [allDetails, setAllDetails] = useState(false);

  if (loading) return <Loading label="Loading position" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const { holder, row, portfolio } = data;
  const profile = record.data ?? holder;
  const openEdit = () => { setForm(stakeholderFormFrom(profile)); setEditing(true); };
  const save = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/stakeholders/${id}`, { method: 'PATCH', body: stakeholderPayload(form) });
      toast('Stakeholder updated');
      setEditing(false);
      reload();
      record.reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const address = [profile.address, [profile.city, profile.region, profile.postalCode].filter(Boolean).join(', '), profile.country].filter(Boolean).join('\n');
  // A seat that ended stays on the record: its holder is shown as a former director.
  const designator = (register.data ?? []).find((p) => p.id === profile.boardDesignatedBy);
  const seat = !hasBoardSeat(profile) ? null : (
    <>
      {isDirector(profile) ? (profile.boardSeatStart ? `Director since ${date(profile.boardSeatStart)}` : 'Director')
        : isFormerDirector(profile) ? `Former director, ${profile.boardSeatStart ? `${date(profile.boardSeatStart)} – ${date(profile.boardSeatEnd)}` : `left ${date(profile.boardSeatEnd)}`}`
        : `Joins the board ${date(profile.boardSeatStart)}`}
      {designator && <> · designated by <Link to={`/stakeholders/${designator.id}`} className="text-brand-700 hover:underline">{designator.name}</Link></>}
    </>
  );
  const tags = String(profile.tags ?? '').split(',').map((t: string) => t.trim()).filter(Boolean);

  // The profile runs to twenty fields, which pushed the holdings and awards off the
  // first screen. The handful anyone opens this page for stays visible; the rest is
  // one click away.
  const identity = profile.type === 'INDIVIDUAL'
    ? [
        { label: 'Title', value: profile.title ?? '—' },
        { label: 'Department', value: profile.department ?? '—' },
        { label: 'Employee ID', value: profile.employeeId ?? '—' },
        { label: 'Employment', value: labelOf(EMPLOYMENT_TYPES, profile.employmentType) ?? '—' },
      ]
    : [
        { label: 'Jurisdiction', value: profile.jurisdiction ?? '—' },
        { label: 'Signatory', value: profile.signatoryName ? `${profile.signatoryName}${profile.signatoryTitle ? `, ${profile.signatoryTitle}` : ''}` : '—' },
        { label: 'Signatory email', value: profile.signatoryEmail ?? '—' },
      ];
  const keyDetails: { label: string; value: ReactNode }[] = [
    { label: 'Type', value: labelOf(STAKEHOLDER_TYPES, profile.type) ?? profile.type },
    identity[0],
    { label: 'Email', value: profile.email ?? '—' },
    { label: 'Start date', value: date(profile.startDate) },
    ...(seat ? [{ label: 'Board seat', value: seat }] : []),
    ...(profile.terminationDate
      ? [{ label: 'Termination', value: `${date(profile.terminationDate)}${profile.terminationReason ? ` · ${labelOf(TERMINATION_REASONS, profile.terminationReason)}` : ''}` }]
      : []),
  ];
  const restDetails: { label: string; value: ReactNode }[] = [
    { label: 'Legal name', value: profile.legalName ?? '—' },
    ...identity.slice(1),
    { label: 'Secondary email', value: profile.secondaryEmail ?? '—' },
    { label: 'Phone', value: profile.phone ?? '—' },
    { label: 'Address', value: address ? <span className="whitespace-pre-line">{address}</span> : '—' },
    { label: 'Tax residence', value: [profile.taxState, profile.taxCountry].filter(Boolean).join(', ') || '—' },
    { label: 'Tax form', value: labelOf(TAX_FORMS, profile.taxForm) ?? '—' },
    ...(profile.relation === 'INVESTOR' ? [{ label: 'Accredited investor', value: labelOf(ACCREDITED, profile.accreditedInvestor) ?? 'Unknown' }] : []),
    { label: 'Tags', value: tags.length ? <span className="flex flex-wrap gap-1">{tags.map((t: string) => <Badge key={t} tone="neutral">{t}</Badge>)}</span> : '—' },
    { label: 'Notes', value: profile.notes ? <span className="whitespace-pre-line">{profile.notes}</span> : '—' },
  ];

  // What this person holds, sliced the way their fully diluted number is built:
  // shares by class as converted, then each instrument that would turn into shares.
  const segments: { label: string; shares: number; pct: number }[] = row
    ? [
        ...row.holdings.map((h: any) => ({ label: h.className, shares: h.asConverted })),
        { label: 'Options', shares: row.optionsOutstanding },
        { label: 'RSUs', shares: row.rsusOutstanding },
        { label: 'Warrants', shares: row.warrantsOutstanding },
        { label: 'Convertibles', shares: row.convertibleAsConverted },
      ]
        .filter((s) => s.shares > 0)
        .map((s) => ({ ...s, pct: row.fullyDiluted > 0 ? s.shares / row.fullyDiluted : 0 }))
    : [];

  return (
    <>
      <div className="mb-4">
        <Link to="/stakeholders" className="inline-flex items-center gap-1.5 text-[13px] text-ink-500 hover:text-ink-800">
          <Icon name="chevron" className="size-4 rotate-90" /> All stakeholders
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar name={holder.name} size={52} />
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900">{holder.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge tone={holder.relation === 'INVESTOR' ? 'info' : holder.relation === 'FOUNDER' ? 'purple' : 'neutral'}>
                {RELATION_LABELS[holder.relation] ?? holder.relation}
              </Badge>
              {isDirector(profile) && <Badge tone="brand">Board</Badge>}
              {isFormerDirector(profile) && <Badge tone="neutral">Former director</Badge>}
              {holder.title && <span className="text-[13px] text-ink-500">{holder.title}</span>}
              {holder.email && <span className="text-[13px] text-ink-500">{holder.email}</span>}
              {holder.terminationDate && <Badge tone="warning">Departed {date(holder.terminationDate)}</Badge>}
            </div>
          </div>
        </div>
        {canEdit && <Button icon={<Icon name="edit" />} onClick={openEdit}>Edit</Button>}
      </div>

      {/* This page builds its own header, so the explainer is placed by hand. */}
      <ConceptNote id="stakeholder-position" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Fully diluted position" value={shares(row?.fullyDiluted ?? 0)}
          hint={row ? `${percent(row.fullyDilutedPct)} of the company` : 'No holdings'} />
        <Stat label="Value at current FMV" value={money(portfolio.totalValue, { compact: true })}
          hint={`At ${pps(portfolio.fmv)} per share`} />
        <Stat label="Shares owned" value={shares(portfolio.sharesOwned)}
          hint={portfolio.costBasis ? `${money(portfolio.costBasis, { compact: true })} cost basis` : '—'} />
        <Stat label="Vested options" value={shares(portfolio.vestedOptions)}
          hint={`${shares(portfolio.unvestedOptions)} unvested`} />
      </div>

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Details" action={
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setAllDetails((v) => !v)}>
                {allDetails ? 'Less' : 'All'}
              </Button>
              {canEdit && <Button size="sm" variant="ghost" onClick={openEdit}>Edit</Button>}
            </span>
          } />
          <KeyValue columns={1} items={allDetails ? [...keyDetails, ...restDetails] : keyDetails} />
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Position summary" />
          {row ? (
            <>
              <div className="mb-4">
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[13px] text-ink-600">Ownership on a fully diluted basis</span>
                  <span className="text-[13px] font-medium tabular">{percent(row.fullyDilutedPct)}</span>
                </div>
                <MiniBar value={row.fullyDilutedPct} />
              </div>
              <KeyValue columns={3} items={[
                { label: 'Shares outstanding', value: shares(row.outstanding) },
                { label: 'As converted', value: shares(row.asConverted) },
                { label: 'Options outstanding', value: shares(row.optionsOutstanding) },
                { label: 'RSUs', value: shares(row.rsusOutstanding) },
                { label: 'Warrants', value: shares(row.warrantsOutstanding) },
                { label: 'Voting power', value: percent(row.votingPct) },
                { label: 'Total invested', value: money(row.investedAmount) },
                { label: 'Convertible principal', value: row.convertiblePrincipal ? money(row.convertiblePrincipal) : '—' },
                { label: 'Current value', value: money(row.currentValue) },
              ]} />
            </>
          ) : <EmptyState title="No holdings on the cap table" />}
        </Card>
      </div>

      {segments.length > 0 && (
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
          <Card>
            <CardHeader title="Position breakdown" subtitle="Share of everything this holder owns, as converted" />
            <OwnershipDonut data={segments} height={190} centerLabel="Fully diluted" centerValue={shares(row.fullyDiluted)} />
            <div className="mt-3 border-t border-ink-100 pt-3">
              <ChartLegend data={segments} formatValue={(d) => percent(d.pct, 1)} />
            </div>
          </Card>

          {row.holdings.length > 0 && (
            // The table's wrapper is the grid item here, so it takes min-w-0: a wide table scrolls inside its card rather than widening the grid.
            <DataTable className="min-w-0 lg:col-span-2" title="Holdings by share class"
              rows={row.holdings} rowKey={(h: any) => h.shareClassId}
              columns={[
                { key: 'class', label: 'Class', value: (h) => h.className,
                  cell: (h) => <Badge tone={h.kind === 'PREFERRED' ? 'purple' : 'neutral'}>{h.className}</Badge> },
                { key: 'shares', label: 'Shares', type: 'number', value: (h) => h.shares },
                { key: 'converted', label: 'As converted', type: 'number', value: (h) => h.asConverted },
                { key: 'votes', label: 'Votes', type: 'number', value: (h) => h.votes },
                { key: 'invested', label: 'Invested', type: 'money', value: (h) => h.investedAmount,
                  cell: (h) => money(h.investedAmount, { compact: true }) },
              ]} />
          )}
        </div>
      )}

      {data.issuances.length > 0 && (
        <DataTable className="mt-5" title="Certificates"
          rows={data.issuances} rowKey={(i: any) => i.id}
          columns={[
            { key: 'certificate', label: 'Certificate', className: 'font-medium',
              value: (i) => i.certificateNo ?? i.id.slice(-6).toUpperCase() },
            { key: 'shares', label: 'Shares', type: 'number', value: (i) => i.quantity },
            // Per-share prices are in micro-cents: they sort as numbers and show with pps.
            { key: 'price', label: 'Price', type: 'price', value: (i) => i.pricePerShare },
            { key: 'issued', label: 'Issued', type: 'date', value: (i) => i.issueDate, className: 'text-ink-600' },
            { key: '83b', label: '83(b)',
              value: (i) => (i.election83bFiledOn ? 'Filed' : i.vestingScheduleId ? 'Not filed' : null),
              cell: (i) => (i.election83bFiledOn ? <Badge tone="success">Filed</Badge>
                : i.vestingScheduleId ? <Badge tone="warning">Not filed</Badge> : <span className="text-ink-400">—</span>) },
            { key: 'status', label: 'Status', value: (i) => i.status, cell: (i) => <StatusBadge status={i.status} /> },
          ]} />
      )}

      {portfolio.grants.length > 0 && (
        <div className="mt-5 space-y-5">
          <h2 className="text-[15px] font-semibold text-ink-900">Equity grants</h2>
          {portfolio.grants.map((g: any) => {
            const a = g.award;
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold">{a.label ?? 'Grant'}</h3>
                      <Badge tone={a.type === 'ISO' ? 'brand' : a.type === 'RSU' ? 'info' : 'neutral'}>
                        {AWARD_LABELS[a.type] ?? a.type}
                      </Badge>
                      <StatusBadge status={a.status} />
                      {g.underwater && <Badge tone="warning">Underwater</Badge>}
                    </div>
                    <p className="mt-1 text-[13px] text-ink-500">
                      {shares(a.quantity)} shares granted {date(a.grantDate)}
                      {a.strikePrice > 0 && ` at ${pps(a.strikePrice)}`}
                      {g.schedule && ` · ${g.schedule.name}`}
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-5 border-t border-ink-100 pt-4 lg:grid-cols-[1fr_300px]">
                  <div>
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="text-[13px] text-ink-600">{shares(g.vested)} of {shares(a.quantity)} vested</span>
                      <span className="text-[13px] font-medium tabular">{percent(g.percentVested, 1)}</span>
                    </div>
                    <MiniBar value={g.percentVested} />
                    {g.curve?.length > 0 && <div className="mt-4"><VestingChart data={g.curve} total={a.quantity} height={170} /></div>}
                  </div>
                  <KeyValue columns={1} items={[
                    { label: 'Vested', value: shares(g.vested) },
                    { label: 'Unvested', value: shares(g.unvested) },
                    { label: 'Exercised', value: shares(a.exercisedQuantity) },
                    { label: 'Intrinsic value', value: money(g.intrinsicValue) },
                    { label: 'Next vest',
                      value: g.nextVestDate
                        ? `${shares(g.nextVestQuantity)} on ${date(g.nextVestDate)} (${relativeDate(g.nextVestDate)})`
                        : 'Fully vested' },
                    ...(g.summary?.cliffDate
                      ? [{ label: 'Cliff', value: `${date(g.summary.cliffDate)}${g.summary.cliffPassed ? ' (passed)' : ''}` }] : []),
                  ]} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {data.convertibles.length > 0 && (
        <DataTable className="mt-5" title="Convertible instruments"
          rows={data.convertibles} rowKey={(c: any) => c.id}
          columns={[
            { key: 'instrument', label: 'Instrument', value: (c) => INSTRUMENT_LABELS[c.instrument] ?? c.instrument },
            { key: 'principal', label: 'Principal', type: 'money', value: (c) => c.principal,
              cell: (c) => money(c.principal, { compact: true }) },
            { key: 'cap', label: 'Cap', type: 'money', value: (c) => c.valuationCap || null,
              cell: (c) => (c.valuationCap ? money(c.valuationCap, { compact: true }) : 'Uncapped') },
            { key: 'discount', label: 'Discount', type: 'number', value: (c) => c.discount || null,
              cell: (c) => (c.discount ? percent(c.discount, 0) : '—') },
            { key: 'issued', label: 'Issued', type: 'date', value: (c) => c.issueDate, className: 'text-ink-600' },
            { key: 'maturity', label: 'Maturity', type: 'date', value: (c) => c.maturityDate, className: 'text-ink-600' },
            { key: 'status', label: 'Status', value: (c) => c.status, cell: (c) => <StatusBadge status={c.status} /> },
          ]} />
      )}

      {data.warrants.length > 0 && (
        <DataTable className="mt-5" title="Warrants"
          rows={data.warrants} rowKey={(w: any) => w.id}
          columns={[
            { key: 'shares', label: 'Shares', type: 'number', value: (w) => w.quantity - w.exercisedQuantity },
            { key: 'strike', label: 'Strike', type: 'price', value: (w) => w.strikePrice },
            { key: 'issued', label: 'Issued', type: 'date', value: (w) => w.issueDate, className: 'text-ink-600' },
            { key: 'expires', label: 'Expires', type: 'date', value: (w) => w.expirationDate, className: 'text-ink-600' },
            { key: 'status', label: 'Status', value: (w) => w.status, cell: (w) => <StatusBadge status={w.status} /> },
          ]} />
      )}
      <FormModal open={editing} onClose={() => setEditing(false)} busy={busy} size="lg" title="Edit stakeholder"
        description="Everything the register knows about this holder." onSubmit={save} submitLabel="Save changes">
        <StakeholderFields form={form} setForm={setForm} people={register.data ?? []} selfId={id ?? null} />
      </FormModal>
    </>
  );
}
