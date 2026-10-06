import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { api } from '../api.ts';
import { useValuationRequests, ValuationRequestPanel, EarlierValuationRequests, OwnAppraiserNote, type ValuationRequest } from '../ValuationRequests.tsx';
import {
  PageHeader, Card, Table, TH, TD, TR, Loading, ErrorNote, Button, Input, Field,
  Select, ConfirmDialog, StatusBadge, Textarea, Badge, useToast, cx,
} from '../ui.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { pps, money, date, today, parsePPS, parseMoney, amountHint } from '../format.ts';
import { ValuationHistoryChart } from '../charts.tsx';
import { useReportOpener, openableLink, type ValuationReport } from '../ValuationReportField.tsx';
import { ReadNote, priceField, reportDocumentOf, type Detected } from '../ReportReading.tsx';
import { config } from '../config.ts';

const blank = {
  type: '409A', fairMarketValue: '', effectiveDate: today(), expirationDate: '',
  provider: '', status: 'ACTIVE', enterpriseValue: '', method: '', notes: '',
};

/**
 * The values of a delivered request's form that only the reading of the report
 * stands behind, because the team did not enter them itself. Each is marked on
 * the form while it holds what was read.
 */
interface ReadOnly {
  fairMarketValue?: Detected<number>;
  effectiveDate?: Detected<string>;
  method?: Detected<string>;
}

/** Twelve calendar months on, clamped to the end of a shorter month. */
function plusTwelveMonths(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** How far a date is from today in whole calendar days, in words. */
function inDays(iso: string): string {
  const days = Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return days < 45 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
  return -days < 45 ? `${-days} days ago` : `${Math.round(-days / 30)} months ago`;
}

/** Whole days from today to a date: negative once it has passed. */
const daysUntil = (iso: string): number =>
  Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);

/** A change in price as a signed percentage, to one decimal. */
const pctChange = (ratio: number): string => `${ratio >= 0 ? '+' : '−'}${Math.abs(ratio * 100).toFixed(1)}%`;

/** Each kind of valuation with the icon the table shows it under. */
const KINDS: Record<string, { label: string; icon: IconName }> = {
  '409A': { label: '409A', icon: 'shield' },
  PREFERRED_PRICE: { label: 'Preferred round', icon: 'trending' },
  BOARD_ESTIMATE: { label: 'Board estimate', icon: 'gavel' },
  SECONDARY: { label: 'Secondary', icon: 'convert' },
};

/** How far through its twelve months a 409A is, drawn as a bar that fills in when the page opens. */
function SafeHarborBar({ from, to, tone }: { from: string; to: string; tone: 'good' | 'soon' | 'ended' }) {
  const span = Date.parse(to) - Date.parse(from);
  const done = span > 0 ? Math.min(1, Math.max(0, (Date.parse(today()) - Date.parse(from)) / span)) : 1;
  // Starts empty and grows to where today is, so the bar reads as time passing.
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = setTimeout(() => setShown(done), 60); return () => clearTimeout(t); }, [done]);
  const color = tone === 'ended' ? 'bg-red-500' : tone === 'soon' ? 'bg-amber-500' : 'bg-brand-500';
  return (
    <div>
      <div className="relative h-2.5 rounded-full bg-ink-100" role="img"
        aria-label={`${Math.round(done * 100)} percent of the way from ${date(from)} to ${date(to)}`}>
        <div className={cx('h-full rounded-full transition-[width] duration-1000 ease-out', color)} style={{ width: `${shown * 100}%` }} />
        {tone !== 'ended' && (
          <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-ink-900 shadow transition-[left] duration-1000 ease-out"
            style={{ left: `${shown * 100}%` }} aria-hidden />
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular text-ink-500">
        <span>{date(from)}</span>
        <span>{date(to)}</span>
      </div>
    </div>
  );
}

export default function Valuations({ embedded = false }: { embedded?: boolean } = {}) {
  const { canEdit, companyId, isSample, role } = useSession();
  // The vault keeps documents from viewers unless they are shared with everyone.
  const readsVault = ['ADMIN', 'LEGAL', 'BOARD'].includes(role);
  const crud = useCrud<any>('valuations');
  const toast = useToast();
  const requests = useValuationRequests();
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [requesting, setRequesting] = useState(false);
  // The request a valuation being recorded will answer, when it came from one.
  const [completing, setCompleting] = useState<ValuationRequest | null>(null);
  const [readOnly, setReadOnly] = useState<ReadOnly>({});
  const [saving, setSaving] = useState(false);
  const report = useReportOpener();

  /** Opens a valuation's report from the table: the document in the vault, or the link. */
  const openReport = async (v: any) => {
    const link = openableLink(v.reportUrl);
    if (!v.reportDocumentId && link) { window.open(link, '_blank', 'noopener'); return; }
    try {
      const found = await api<ValuationReport>(`/c/${companyId}/valuations/${v.id}/report`);
      if (!found.document) toast('That report is no longer in the vault.', 'error');
      else if (!report.canOpen(found.document)) toast('Administrators, legal and the board can open this report.', 'info');
      else report.open(found.document);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  // Every figure in the stat row comes from one valuation: the 409A the server says
  // the company is relying on today. Only while that answer loads does the page
  // fall back to the newest active 409A in the list.
  const current = requests.refresh?.current ?? null;
  const active = (current ? crud.items.find((v) => v.id === current.id) : null)
    ?? crud.items.find((v) => v.status === 'ACTIVE' && v.type === '409A' && v.effectiveDate <= today());
  const statedExpiry: string | null = active?.expirationDate ?? null;
  // Twelve months from the valuation date, or the report's own expiry if sooner.
  // A report cannot outlast the rule, whatever date it states.
  const twelveMonths = active ? plusTwelveMonths(active.effectiveDate) : null;
  const expiry: string | null = current?.expiresOn
    ?? (twelveMonths && statedExpiry && statedExpiry < twelveMonths ? statedExpiry : twelveMonths);
  const expired = expiry ? expiry < today() : false;
  // A priced round since the valuation ends the safe harbor before the date does,
  // so when a new 409A is required the stat says so rather than showing a date.
  const requiredNow = (requests.refresh?.triggers ?? []).find((t) => t.severity === 'REQUIRED');

  const openNew = () => { setForm(blank); setCompleting(null); setReadOnly({}); setEditing({ id: null }); };

  /** The Record valuation form, filled in from the request it answers. */
  const openFromRequest = (r: ValuationRequest) => {
    // Type and status are fixed for a request's result: the server completes a
    // request only with an active 409A, so offering anything else would fail after saving.
    // The firm and the date come from what the team entered when it delivered the
    // report. The team's own name is never the provider: it arranged the appraisal
    // and did not perform it.
    // A request from before the team existed named its firm itself.
    const firm = r.answers ? r.appraiser ?? '' : r.provider;
    // The price and the method come from the delivered report: what the team
    // entered first, and what the server read from the report where it entered
    // nothing. Only a delivered report fills them in; a 409A recorded from another
    // appraiser while the team is still working starts blank.
    const report = r.status === 'DELIVERED' ? r.report ?? null : null;
    const read = report?.detected?.readable ? report.detected : null;
    const marks: ReadOnly = {
      fairMarketValue: report?.fairMarketValue == null ? read?.fairMarketValue ?? undefined : undefined,
      effectiveDate: !r.reportDate ? read?.valuationDate ?? undefined : undefined,
      method: !report?.method ? read?.method ?? undefined : undefined,
    };
    const price = report?.fairMarketValue ?? marks.fairMarketValue?.value ?? null;
    setForm({
      ...blank, type: '409A', provider: firm, status: 'ACTIVE',
      effectiveDate: r.reportDate ?? marks.effectiveDate?.value ?? r.targetDate ?? today(),
      fairMarketValue: price != null ? priceField(price) : '',
      method: report?.method ?? marks.method?.value ?? '',
    });
    setReadOnly(marks);
    setCompleting(r);
    setEditing({ id: null });
  };
  const openEdit = (v: any) => {
    setReadOnly({});
    setForm({
      type: v.type, fairMarketValue: String(v.fairMarketValue / 1e6), effectiveDate: v.effectiveDate,
      expirationDate: v.expirationDate ?? '', provider: v.provider ?? '',
      status: v.status, enterpriseValue: v.enterpriseValue ? String(v.enterpriseValue / 100) : '',
      method: v.method ?? '', notes: v.notes ?? '',
    });
    setEditing(v);
  };

  const save = async () => {
    const payload = {
      type: form.type, fairMarketValue: parsePPS(form.fairMarketValue),
      effectiveDate: form.effectiveDate, expirationDate: form.expirationDate || null,
      // The report is added on the valuation's own page, so the form leaves it as it is.
      provider: form.provider || null, status: form.status,
      enterpriseValue: form.enterpriseValue ? parseMoney(form.enterpriseValue) : null,
      method: form.method || null, notes: form.notes || null,
    };
    if (completing && !editing?.id) {
      // Recording the result of a request is two writes: the valuation, then the
      // request closed against it. The second can fail on its own, and if it does
      // the valuation is still recorded, so the message says exactly that.
      setSaving(true);
      try {
        const created = await api<{ id: string }>(`/c/${companyId}/valuations`, { body: payload });
        try {
          // Completing a delivered request also files the report the team uploaded
          // against the new valuation, so it needs no second step here. The request
          // goes with when it last changed as the form read it: if the team has
          // changed it since, reopened it and withdrawn the report for instance, the
          // server refuses, and the message below says so. Whether the report was
          // filed is the server's answer, not this page's earlier copy of the request.
          const done = await api<ValuationRequest & { reportAttached?: boolean }>(`/c/${companyId}/valuation-requests/${completing.id}`, {
            method: 'PATCH', body: { status: 'COMPLETED', valuationId: created.id, updatedAt: completing.updatedAt },
          });
          toast(done.reportAttached === true
            ? 'Valuation recorded with the report, and the request completed'
            : 'Valuation recorded and the request completed');
        } catch (err) {
          toast(`Valuation recorded, but the request could not be completed: ${(err as Error).message}`, 'error');
        }
        setEditing(null);
        setCompleting(null);
        crud.reload();
        requests.reload();
      } catch (err) {
        toast((err as Error).message, 'error');
      } finally {
        setSaving(false);
      }
      return;
    }
    const ok = editing?.id
      ? await crud.update(editing.id, payload, 'Valuation updated')
      : await crud.create(payload, 'Valuation recorded');
    if (ok) { setEditing(null); requests.reload(); }
  };

  if (crud.loading) return <Loading label="Loading valuations" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  // A second request cannot be opened while one is, so the button goes rather
  // than offering something the server will refuse. Nor is it offered when the
  // server does not offer the valuation team at all (valuationDesk.enabled).
  const empty = crud.items.length === 0;
  const canRequest = config.valuationDesk.enabled && requests.loaded && !requests.open;
  const headerActions = (
    <>
      {canRequest && (
        <Button variant="secondary" icon={<Icon name="send" />} onClick={() => setRequesting(true)}>Request a new 409A</Button>
      )}
      <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew}>Record valuation</Button>
    </>
  );

  // The 409As in date order, for the chart, the change from one to the next and how long each covers.
  const appraisals = crud.items.filter((v) => v.type === '409A' && v.status !== 'DRAFT')
    .sort((a, b) => String(a.effectiveDate).localeCompare(String(b.effectiveDate)));
  const changeOf = (v: any): number | null => {
    const i = appraisals.findIndex((x) => x.id === v.id);
    const before = i > 0 ? appraisals[i - 1] : null;
    return before && before.fairMarketValue > 0 ? v.fairMarketValue / before.fairMarketValue - 1 : null;
  };
  const coversUntil = (v: any): string | null => {
    if (v.type !== '409A') return null;
    const twelve = plusTwelveMonths(v.effectiveDate);
    return v.expirationDate && v.expirationDate < twelve ? v.expirationDate : twelve;
  };
  const first = appraisals[0];
  const sinceFirst = active && first && first.id !== active.id && first.fairMarketValue > 0 ? active.fairMarketValue / first.fairMarketValue - 1 : null;

  // Where the current 409A stands, in one word and a colour.
  const endedByEvent = requiredNow && requiredNow.reason !== 'EXPIRED' ? requiredNow : null;
  const left = expiry ? daysUntil(expiry) : null;
  const standing: { label: string; tone: 'success' | 'warning' | 'danger'; bar: 'good' | 'soon' | 'ended' } =
    endedByEvent ? { label: 'New 409A due', tone: 'danger', bar: 'ended' }
      : expired ? { label: 'Expired', tone: 'danger', bar: 'ended' }
        : left != null && left <= config.compliance.valuationExpiryWarningDays ? { label: `Ends in ${left} day${left === 1 ? '' : 's'}`, tone: 'warning', bar: 'soon' }
          : { label: 'Supports new grants', tone: 'success', bar: 'good' };
  const activeChange = active ? changeOf(active) : null;
  const hasReport = (v: any) => !!v.reportDocumentId || !!openableLink(v.reportUrl);

  // A delivered request's form says where its values came from, and opens the report to check them against.
  const delivered = completing?.status === 'DELIVERED' ? completing.report ?? null : null;
  const reportDoc = reportDocumentOf(delivered);
  const marked = !!readOnly.fairMarketValue || !!readOnly.effectiveDate || !!readOnly.method;
  const fromReport = !!delivered && (!!reportDoc || delivered.fairMarketValue != null || !!delivered.method || marked);
  // Where the values really came from: read from the report, and marked, or what
  // the team entered when it delivered. A file being attached does not mean
  // anything was read from it: a scan gives nothing, and the team types it all.
  const fromReportNote = !completing || !delivered ? '' : [
    marked
      ? `Some of these were read from the report the ${completing.provider} uploaded, and are marked. The rest are what the ${completing.provider} entered when it delivered.`
      : `These are the values the ${completing.provider} entered when it delivered the report.`,
    delivered.fairMarketValue == null && !readOnly.fairMarketValue ? 'No price per share came with the report, so enter the one it concludes.' : '',
    'Check them against the report, then record.',
  ].filter(Boolean).join(' ');
  /** A field's aria-describedby: the note above the form for the first, and the field's own note once it has one. */
  const describedBy = (...ids: (string | false | undefined)[]): string | undefined => ids.filter(Boolean).join(' ') || undefined;

  return (
    <>
      {/* With nothing on file, the buttons live in the empty state below and nowhere else. */}
      {embedded ? (
        canEdit && !empty && (
          <div className="mb-4 flex flex-wrap justify-end gap-2">{headerActions}</div>
        )
      ) : (
        <PageHeader title="409A valuations"
          subtitle="Fair market value history that sets option strike prices"
          actions={canEdit && !empty && <span className="flex flex-wrap justify-end gap-2">{headerActions}</span>} />
      )}

      {/* The banner that said a valuation had expired now comes from the server's
          refresh check, which also sees a priced round or a SAFE since the report. */}
      <ValuationRequestPanel data={requests} requesting={requesting} setRequesting={setRequesting} showReasons={!empty}
        onRecordResult={openFromRequest}
        recorded={requests.open
          ? crud.items.filter((v) => v.type === '409A' && v.status === 'ACTIVE' && String(v.createdAt) >= String(requests.open!.createdAt))
          : []} />

      {active && (
        <Card padded={false} className="rise mb-5 overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="bg-linear-to-br from-brand-50/80 via-white to-white p-5 sm:p-6 lg:border-r lg:border-ink-100">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Current fair market value</p>
                <Badge tone={standing.tone}>
                  <span className={cx('size-1.5 rounded-full', standing.tone === 'success' ? 'bg-secondary-600' : standing.tone === 'warning' ? 'bg-amber-500' : 'bg-red-500')} aria-hidden />
                  {standing.label}
                </Badge>
              </div>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
                <span className="text-4xl font-semibold tracking-tight text-ink-900 tabular">{pps(active.fairMarketValue)}</span>
                <span className="text-[13px] text-ink-500">per common share</span>
              </p>
              {(activeChange != null || sinceFirst != null) && (
                <p className="mt-2 flex flex-wrap gap-2 text-[12px]">
                  {activeChange != null && (
                    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
                      activeChange >= 0 ? 'bg-secondary-100 text-secondary-800' : 'bg-red-50 text-red-700')}>
                      <Icon name="trending" className={cx('size-3.5', activeChange < 0 && '-scale-y-100')} />
                      {pctChange(activeChange)} on the previous 409A
                    </span>
                  )}
                  {sinceFirst != null && appraisals.length > 2 && (
                    <span className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-ink-600">
                      {pctChange(sinceFirst)} since {date(first.effectiveDate)}
                    </span>
                  )}
                </p>
              )}
              <dl className="mt-5 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Icon name="calendar" className="size-4 shrink-0 text-ink-400" />
                  <dt className="sr-only">Valued as of</dt><dd className="text-ink-700">Valued as of {date(active.effectiveDate)}</dd>
                </div>
                <div className="flex items-center gap-2">
                  <Icon name="badge" className="size-4 shrink-0 text-ink-400" />
                  <dt className="sr-only">Appraiser</dt><dd className="truncate text-ink-700">{active.provider ?? 'Appraiser not recorded'}</dd>
                </div>
                {active.method && (
                  <div className="flex items-center gap-2">
                    <Icon name="calculator" className="size-4 shrink-0 text-ink-400" />
                    <dt className="sr-only">Method</dt><dd className="truncate text-ink-700">{active.method}</dd>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Icon name="document" className="size-4 shrink-0 text-ink-400" />
                  <dt className="sr-only">Report</dt>
                  <dd>
                    {hasReport(active) && (readsVault || !active.reportDocumentId) ? (
                      <button type="button" onClick={() => void openReport(active)} className="font-medium text-brand-600 hover:text-brand-700">Open the report</button>
                    ) : hasReport(active) ? <span className="text-ink-500">Report on file</span> : (
                      <Link to={`/valuations/${active.id}`} className="text-ink-500 hover:text-brand-600">{canEdit && !isSample ? 'Add the report' : 'No report on file'}</Link>
                    )}
                  </dd>
                </div>
              </dl>
              <Link to={`/valuations/${active.id}`} className="mt-5 inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700">
                Open this valuation <Icon name="chevron" className="size-3.5 -rotate-90" />
              </Link>
            </div>

            <div className="p-5 sm:p-6">
              <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Safe harbor</p>
              <p className="mt-3 text-[15px] font-semibold text-ink-900">
                {endedByEvent ? 'Ended before its twelve months'
                  : !expiry ? 'The end date could not be worked out'
                    : expired ? `Ended ${inDays(expiry)}` : `Covers grants until ${date(expiry)}`}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-600">
                {endedByEvent ? endedByEvent.text
                  : !expiry ? 'Record the valuation date to see how long it lasts.'
                    : expired ? 'Grants priced off it no longer have the presumption. Record a new 409A before the next grant.'
                      : `${left === 0 ? 'Last day today' : `${left} day${left === 1 ? '' : 's'} left`}, ${statedExpiry && statedExpiry <= expiry ? "the report's own expiry" : 'twelve months after the valuation date'}. A priced round before then ends it sooner.`}
              </p>
              {expiry && (
                <div className="mt-5">
                  <SafeHarborBar from={active.effectiveDate} to={expiry} tone={standing.bar} />
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {appraisals.length >= 2 && (
        <Card className="rise mb-5" >
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className="text-[15px] font-semibold text-ink-900">Fair market value over time</h3>
              <p className="text-[13px] text-ink-500">Common stock, one step per 409A</p>
            </div>
            <p className="text-[12px] text-ink-500">{appraisals.length} valuations since {date(first.effectiveDate)}</p>
          </div>
          <ValuationHistoryChart height={220} today={today()}
            points={appraisals.map((v) => ({ date: v.effectiveDate, value: v.fairMarketValue, provider: v.provider ?? null }))} />
        </Card>
      )}

      {empty ? (
        <Card className="rise">
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <span className="grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600">
              <Icon name="shield" className="size-7" />
            </span>
            <h3 className="mt-4 text-[16px] font-semibold text-ink-900">No valuations on file</h3>
            <p className="mt-1 max-w-md text-[13px] leading-relaxed text-ink-600">
              A current 409A sets the lowest strike price an option can safely have.{' '}
              {config.valuationDesk.enabled
                ? `Ask the ${config.valuationDesk.name} for one, or record one you already have.`
                : 'Record one you already have, or the one your appraiser delivers.'}
            </p>
            {/* Options already granted with nothing to price them against: the one case worth more than the sentence above. */}
            {requests.refresh?.due && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-[12px] font-medium text-red-700">
                <Icon name="alert" className="size-3.5" /> Options have been granted, so one is needed now.
              </p>
            )}
            {canEdit && (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {canRequest && (
                  <Button variant="primary" icon={<Icon name="send" />} onClick={() => setRequesting(true)}>Request a new 409A</Button>
                )}
                <Button variant={canRequest ? 'secondary' : 'primary'} icon={<Icon name="plus" />} onClick={openNew}>
                  Record one you have
                </Button>
              </div>
            )}
          </div>
        </Card>
      ) : (
        <Card padded={false} className="rise overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
            <h3 className="text-[15px] font-semibold text-ink-900">All valuations <span className="ml-1 font-normal text-ink-500">({crud.items.length})</span></h3>
          </div>
          <Table>
            <thead>
              <tr>
                <TH>Valuation</TH><TH align="right">Fair market value</TH>
                <TH>Valued as of</TH><TH>Covers grants to</TH><TH>Appraiser</TH>
                <TH align="right" className="hidden 2xl:table-cell">Enterprise value</TH><TH>Report</TH><TH>Status</TH>
                {canEdit && <TH width={90} />}
              </tr>
            </thead>
            <tbody>
              {crud.items.map((v) => {
                const kind = KINDS[v.type] ?? { label: v.type, icon: 'shield' as IconName };
                const isCurrent = active?.id === v.id;
                const change = changeOf(v);
                const until = isCurrent ? expiry : coversUntil(v);
                return (
                  <TR key={v.id} className={isCurrent ? 'bg-brand-50/40' : undefined}>
                    <TD>
                      <span className="flex items-center gap-2.5">
                        <span className={cx('grid size-8 shrink-0 place-items-center rounded-lg', isCurrent ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500')}>
                          <Icon name={kind.icon} className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <Link to={`/valuations/${v.id}`} className="font-medium text-ink-900 hover:text-brand-700">{kind.label}</Link>
                          {isCurrent && <span className="ml-2 align-middle"><Badge tone="brand">Current</Badge></span>}
                        </span>
                      </span>
                    </TD>
                    <TD align="right">
                      <span className="block whitespace-nowrap font-semibold tabular text-ink-900">{pps(v.fairMarketValue)}</span>
                      {change != null && (
                        <span className={cx('block text-[11px] font-medium tabular', change >= 0 ? 'text-secondary-700' : 'text-red-600')}>{pctChange(change)}</span>
                      )}
                    </TD>
                    <TD>
                      <span className="block whitespace-nowrap text-ink-800">{date(v.effectiveDate)}</span>
                      <span className="block whitespace-nowrap text-[11px] text-ink-500">{inDays(v.effectiveDate)}</span>
                    </TD>
                    <TD>
                      {until ? (
                        <>
                          <span className={cx('block whitespace-nowrap', until < today() ? 'text-ink-400' : 'text-ink-800')}>{date(until)}</span>
                          <span className="block whitespace-nowrap text-[11px] text-ink-500">{until < today() ? 'ended' : inDays(until)}</span>
                        </>
                      ) : <span className="text-ink-400">—</span>}
                    </TD>
                    <TD>
                      <span className="block max-w-[12rem] truncate text-ink-800" title={v.provider ?? undefined}>{v.provider ?? '—'}</span>
                      {v.method && <span className="block max-w-[12rem] truncate text-[11px] text-ink-500">{v.method}</span>}
                    </TD>
                    <TD align="right" mono className="hidden 2xl:table-cell">{v.enterpriseValue ? money(v.enterpriseValue, { compact: true }) : '—'}</TD>
                    <TD>
                      {v.reportDocumentId && !readsVault ? (
                        <span className="text-[12px] text-ink-500" title="Administrators, legal and the board can open it">On file</span>
                      ) : hasReport(v) ? (
                        <button type="button" onClick={() => void openReport(v)} title="Open the report"
                          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-brand-600 hover:bg-brand-50 hover:text-brand-700">
                          <Icon name={v.reportDocumentId ? 'document' : 'external'} className="size-3.5" /> Open
                        </button>
                      ) : (
                        <Link to={`/valuations/${v.id}`} className="text-[12px] text-ink-400 hover:text-brand-600">
                          {canEdit && !isSample ? '+ Add' : '—'}
                        </Link>
                      )}
                    </TD>
                    <TD><StatusBadge status={v.status} /></TD>
                    {canEdit && (
                      <TD align="right">
                        <span className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(v)} aria-label="Edit"><Icon name="edit" className="size-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(v)} aria-label="Delete"><Icon name="trash" className="size-4" /></Button>
                        </span>
                      </TD>
                    )}
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      <OwnAppraiserNote />
      <EarlierValuationRequests data={requests} />

      <FormModal open={!!editing} onClose={() => { setEditing(null); setCompleting(null); setReadOnly({}); }} busy={crud.busy || saving}
        title={editing?.id ? 'Edit valuation' : completing ? `Record the 409A from ${(completing.answers ? completing.appraiser : completing.provider) ?? 'the report'}` : 'Record a valuation'} onSubmit={save}
        submitLabel={editing?.id ? 'Save changes' : completing ? 'Record and complete the request' : 'Record valuation'}
        description={completing
          // Someone else's request is theirs to hear about, and the email names whoever completed it.
          ? `${fromReport ? 'Check these against the report.' : 'Enter what the report says.'} Saving it completes the request, and the history links the two.${!completing.mine && completing.emailsRequester ? ` ${completing.requestedBy} is emailed that you completed it.` : ''}`
          : 'Option strike prices must be at or above the fair market value on the grant date to stay outside section 409A.'}>
        {completing && fromReport && (
          <div className="flex items-start gap-2.5 rounded-lg bg-sky-50 px-3 py-2.5 text-[13px] text-sky-900 ring-1 ring-inset ring-sky-200">
            <Icon name="sparkle" className="mt-0.5 size-4 shrink-0 text-sky-600" />
            <div className="min-w-0">
              {/* The form opens with focus in the price, past this note, so the price names it in aria-describedby. */}
              <p id="record-from-report">{fromReportNote}</p>
              {reportDoc && (report.canOpen(reportDoc) ? (
                <button type="button" onClick={() => report.open(reportDoc)}
                  className="mt-1 inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700">
                  <Icon name="document" className="size-4" /> Read the report
                </button>
              ) : (
                <p className="mt-1 text-[12px] opacity-80">Administrators, legal and the board can open the report.</p>
              ))}
            </div>
          </div>
        )}
        <FormGrid>
          <Field label="Valuation type">
            <Select value={form.type} disabled={!!completing} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="409A">409A valuation</option>
              <option value="PREFERRED_PRICE">Preferred round price</option>
              <option value="BOARD_ESTIMATE">Board estimate</option>
              <option value="SECONDARY">Secondary transaction</option>
            </Select>
          </Field>
          <div>
            <Field label="Fair market value per share" required>
              <Input value={form.fairMarketValue} onChange={(e) => setForm({ ...form, fairMarketValue: e.target.value })} placeholder="0.96" required
                aria-describedby={describedBy(fromReport && 'record-from-report',!!readOnly.fairMarketValue && 'record-read-fmv')} />
            </Field>
            {readOnly.fairMarketValue && (
              <ReadNote id="record-read-fmv" field="fair market value" unconfirmed detected={readOnly.fairMarketValue} shown={pps(readOnly.fairMarketValue.value)}
                matches={parsePPS(form.fairMarketValue) === readOnly.fairMarketValue.value}
                onUse={() => setForm({ ...form, fairMarketValue: priceField(readOnly.fairMarketValue!.value) })} />
            )}
          </div>
          <div>
            <Field label="Effective date" required>
              <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} required
                aria-describedby={describedBy(!!readOnly.effectiveDate && 'record-read-date')} />
            </Field>
            {readOnly.effectiveDate && (
              <ReadNote id="record-read-date" field="valuation date" unconfirmed detected={readOnly.effectiveDate} shown={date(readOnly.effectiveDate.value)}
                matches={form.effectiveDate === readOnly.effectiveDate.value}
                onUse={() => setForm({ ...form, effectiveDate: readOnly.effectiveDate!.value })} />
            )}
          </div>
          <Field label="Expiration date" hint="409A reports are generally valid for twelve months.">
            <Input type="date" value={form.expirationDate} onChange={(e) => setForm({ ...form, expirationDate: e.target.value })} />
          </Field>
          <Field label="Provider">
            <Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="Valuation firm" />
          </Field>
          <div>
            <Field label="Method">
              <Input value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} placeholder="OPM backsolve"
                aria-describedby={describedBy(!!readOnly.method && 'record-read-method')} />
            </Field>
            {readOnly.method && (
              <ReadNote id="record-read-method" field="method" unconfirmed detected={readOnly.method} shown={readOnly.method.value}
                matches={form.method.trim() === readOnly.method.value}
                onUse={() => setForm({ ...form, method: readOnly.method!.value })} />
            )}
          </div>
          <Field label="Enterprise value">
            <Input value={form.enterpriseValue} onChange={(e) => setForm({ ...form, enterpriseValue: e.target.value })} placeholder={amountHint(42_000_000)} />
          </Field>
          <Field label="Status">
            <Select value={form.status} disabled={!!completing} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="SUPERSEDED">Superseded</option>
              <option value="EXPIRED">Expired</option>
            </Select>
          </Field>
        </FormGrid>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </Field>
      </FormModal>

      {report.viewer}

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={crud.busy}
        title="Delete valuation" confirmLabel="Delete"
        message="Deleting a valuation changes the fair market value used for grants and portfolio values."
        onConfirm={async () => { if (await crud.remove(confirmDelete.id, 'Valuation deleted')) { setConfirmDelete(null); requests.reload(); } }} />
    </>
  );
}
