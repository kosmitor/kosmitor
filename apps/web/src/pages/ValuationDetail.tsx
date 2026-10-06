/**
 * One 409A valuation, in full.
 *
 * Compliance is mostly calculated rather than stored, but a valuation is a real
 * record: a price, a date it starts from, and a list of grants that relied on
 * it. This page answers what that price was, whether it is still the one a new
 * grant would use, what it implies the company was worth, and which grants were
 * priced under it. A grant priced below it is the whole reason the page exists,
 * so it is called out rather than listed.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { RecordPage, RecordSection, RecordColumns, RecordMissing } from '../RecordPage.tsx';
import {
  Badge, Loading, ErrorNote, EmptyState, KeyValue, Banner, Table, TH, TD, TR,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { money, shares, pps, date, relativeDate, dateTime, today, AWARD_LABELS } from '../format.ts';
import { readableDocumentPath, documentFilename } from '../documents.ts';
import { ValuationReportField, useReportOpener, openableLink } from '../ValuationReportField.tsx';

/** The kinds of price a company records, in the words the valuation form uses. */
const VALUATION_TYPES: Record<string, string> = {
  '409A': '409A valuation', PREFERRED_PRICE: 'Preferred round price',
  BOARD_ESTIMATE: 'Board estimate', SECONDARY: 'Secondary transaction',
};

export default function ValuationDetail() {
  const { id } = useParams<{ id: string }>();
  const { companyId, canEdit } = useSession();
  const navigate = useNavigate();
  const { data, error, errorStatus, loading, reload } = useQuery<any>(
    companyId && id ? `/c/${companyId}/valuations/${id}/detail` : null, [companyId, id]);
  const [reading, setReading] = useState<any>(null);
  const report = useReportOpener();
  // A reload empties the query while it runs. The page keeps showing what it had
  // meanwhile, so saving the report does not blank it and lose focus and scroll.
  const [shown, setShown] = useState<any>(null);
  useEffect(() => { if (data) setShown(data); }, [data]);
  const view = data ?? (shown && shown.valuation?.id === id ? shown : null);

  if (loading && !view) return <Loading label="Loading valuation" />;
  if (error) {
    // Roles without the compliance screens are told it is not there, because that is
    // what the server says: it answers 404 rather than admitting the record exists.
    return errorStatus === 404 ? (
      <RecordMissing icon="shield" title="That valuation is not here"
        description="It may have been deleted, or it is not available to your role."
        to="/compliance/409a" label="Back to 409A valuations" />
    ) : <ErrorNote error={error} onRetry={reload} />;
  }
  if (!view) return null;

  const { valuation, supersededBy, current, company, pricedGrants, documents, reportDocument } = view;
  const reportLink = openableLink(valuation.reportUrl);
  const title = VALUATION_TYPES[valuation.type] ?? `${valuation.type} valuation`;
  const below = pricedGrants.filter((g: any) => g.belowFairMarketValue);
  const expired = valuation.expirationDate != null && String(valuation.expirationDate) < today();

  const actions = [
    ...(reportDocument && !reportDocument.restricted && report.canOpen(reportDocument)
      ? [{ label: 'Open the report', icon: 'document' as const, onClick: () => report.open(reportDocument) }]
      : !reportDocument && reportLink
        ? [{ label: 'Open the report', icon: 'external' as const, onClick: () => window.open(reportLink, '_blank', 'noopener') }]
        : []),
    { label: 'See the equity awards', icon: 'award' as const, onClick: () => navigate('/grants') },
    ...(canEdit
      ? [{ label: 'Edit on the valuations page', icon: 'edit' as const, onClick: () => navigate('/compliance/409a') }] : []),
  ];

  return (
    <RecordPage back="/compliance/409a" backLabel="All 409A valuations"
      title={title} status={valuation.status}
      // The status badge already says superseded when the record is marked so; this
      // one adds it only when a later valuation replaced one still marked active.
      badges={current
        ? <Badge tone="success">Current</Badge>
        : supersededBy && valuation.status !== 'SUPERSEDED' ? <Badge tone="neutral">Superseded</Badge> : null}
      subtitle={`${pps(valuation.fairMarketValue)} per share, effective ${date(valuation.effectiveDate)}`}
      actions={actions} concept="valuation-record">

      {below.length > 0 && (
        <div className="mb-5">
          <Banner tone="danger" title={`${below.length} grant${below.length === 1 ? '' : 's'} priced below this valuation`}>
            An option priced under the fair market value on its grant date is treated as deferred compensation under
            section 409A. The holder then owes income tax as it vests, plus an extra 20 percent federal tax, and an
            incentive stock option loses its treatment as well. The grants are listed below and each one needs to be
            looked at with counsel.
          </Banner>
        </div>
      )}

      <RecordColumns>
        <RecordSection first title="Overview" className="lg:col-span-2">
          <KeyValue columns={3} items={[
            { label: 'Fair market value per share', value: pps(valuation.fairMarketValue) },
            { label: 'Effective date', value: date(valuation.effectiveDate) },
            {
              label: 'Expires on',
              value: valuation.expirationDate
                ? `${date(valuation.expirationDate)}${expired ? ' (passed)' : ` (${relativeDate(valuation.expirationDate)})`}`
                : 'No expiry recorded',
            },
            { label: 'Type', value: title },
            { label: 'Provider', value: valuation.provider ?? '—' },
            {
              label: 'Report',
              value: <ValuationReportField valuationId={valuation.id} onChange={reload}
                report={{ document: reportDocument ?? null, url: valuation.reportUrl ?? null }} />,
            },
          ]} />
        </RecordSection>

        <RecordSection first title="Where it stands">
          <KeyValue columns={1} items={[
            {
              label: 'Prices new grants',
              value: current
                ? <span className="flex items-center gap-2"><Badge tone="success">Yes</Badge>this is the price a grant made today would use</span>
                : <Badge tone="neutral">No</Badge>,
            },
            {
              label: 'Replaced by',
              value: supersededBy
                ? `A valuation effective ${date(supersededBy)}`
                : 'Nothing later has replaced it',
            },
            { label: 'Grants priced off it', value: String(pricedGrants.length) },
          ]} />
        </RecordSection>
      </RecordColumns>

      <RecordSection title="What it implies the company was worth"
        subtitle={`Every share that existed on ${date(valuation.effectiveDate)}, at this price`}>
        <KeyValue columns={3} items={[
          { label: 'Fully diluted shares on that date', value: shares(company.fullyDilutedAtEffective) },
          { label: 'Fair market value per share', value: pps(valuation.fairMarketValue) },
          { label: 'Implied value of the company', value: money(company.impliedValue, { compact: true }) },
        ]} />
        <p className="mt-4 text-[13px] leading-relaxed text-ink-600">
          This is the common stock price multiplied by the fully diluted share count, so it is not what an investor
          paid for preferred stock. Common stock is appraised lower because it has none of the preferences that make
          preferred stock worth more.
        </p>
      </RecordSection>

      <RecordSection title="Grants priced off this valuation"
        subtitle={supersededBy
          ? `Granted between ${date(valuation.effectiveDate)} and ${date(supersededBy)}`
          : `Granted since ${date(valuation.effectiveDate)}`}>
        {pricedGrants.length === 0 ? (
          <EmptyState title="No grants were made under this valuation"
            description="Grants made while this was the most recent valuation appear here with the strike price they were given." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Grant</TH><TH>Holder</TH><TH>Type</TH>
                <TH align="right">Shares</TH><TH align="right">Strike price</TH>
                <TH>Grant date</TH><TH>Against this valuation</TH>
              </tr>
            </thead>
            <tbody>
              {pricedGrants.map((g: any) => (
                <TR key={g.id} className={g.belowFairMarketValue ? 'bg-red-50/40' : undefined}>
                  <TD className="font-medium">
                    <Link to={`/grants/${g.id}`}
                      className="cursor-pointer text-left font-medium text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-400">
                      {g.label ?? String(g.id).slice(-6).toUpperCase()}
                    </Link>
                  </TD>
                  <TD className="text-ink-600">{g.holder}</TD>
                  <TD><Badge tone={g.type === 'ISO' ? 'brand' : g.type === 'RSU' ? 'info' : 'neutral'}>{AWARD_LABELS[g.type] ?? g.type}</Badge></TD>
                  <TD align="right" mono>{shares(g.quantity)}</TD>
                  <TD align="right" mono className={g.belowFairMarketValue ? 'font-medium text-red-700' : undefined}>{pps(g.strikePrice)}</TD>
                  <TD className="text-ink-600">{date(g.grantDate)}</TD>
                  <TD>
                    {g.belowFairMarketValue
                      ? <Badge tone="danger">Below fair market value</Badge>
                      : <Badge tone="success">At or above</Badge>}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </RecordSection>

      <RecordSection title="Documents" subtitle="Everything filed under valuations for this company, newest first">
        {documents.length === 0 ? (
          <EmptyState icon={<Icon name="document" className="size-8" />} title="No valuation documents on file"
            description="Upload the appraisal and the board consent that adopted it on the documents page, under the valuation category." />
        ) : (
          <ul className="space-y-2">
            {documents.map((d: any) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-200 p-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                  <Icon name="document" className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink-900">{d.name}</p>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    added{d.createdBy ? ` by ${d.createdBy}` : ''} {dateTime(d.createdAt)}
                  </p>
                </div>
                {/* Only a document the app wrote can be rendered here; an uploaded file is read on the documents page. */}
                {!d.fileName && d.hasBody && (
                  <button type="button" onClick={() => setReading(d)}
                    className="shrink-0 cursor-pointer text-[13px] font-medium text-brand-600 hover:text-brand-700">Read it</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-[13px] text-ink-600">
          <Link to="/documents" className="font-medium text-brand-600 hover:text-brand-700">Open the documents page</Link>
          {' '}to upload an appraisal or read a file that was uploaded.
        </p>
      </RecordSection>

      {report.viewer}
      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        path={reading ? readableDocumentPath(companyId!, { ...reading, body: reading.hasBody ? 'yes' : null }) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />
    </RecordPage>
  );
}
