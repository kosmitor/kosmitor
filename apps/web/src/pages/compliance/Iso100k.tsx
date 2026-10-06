import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../session.tsx';
import { useQuery } from '../../api.ts';
import { Card, Table, TH, TD, TR, Badge, Button, Modal, Loading, ErrorNote, EmptyState, Banner, Stat } from '../../ui.tsx';
import { Icon } from '../../icons.tsx';
import { money, shares } from '../../format.ts';
import { SecurityDocuments } from '../../SecurityDocuments.tsx';

/** IRC 422(d): the first-exercisable value of ISOs per employee per year, capped at $100,000. */
export default function Iso100k() {
  const { companyId, canViewAll } = useSession();
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/compliance` : null, [companyId]);
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  if (!canViewAll) return <EmptyState title="Compliance is not available for your role" />;
  if (loading) return <Loading label="Running the $100K test" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const rows: any[] = data.iso100k;
  const exceeded = rows.filter((r) => r.exceeded);
  const employees = new Set(rows.map((r) => r.stakeholderName)).size;

  return (
    <>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat label="Employees tested" value={String(employees)} />
        <Stat label="Grant-years over the limit" value={String(exceeded.length)} tone={exceeded.length ? 'warning' : 'positive'} />
        <Stat label="Shares treated as NSO" value={shares(rows.reduce((n, r) => n + (r.nsoRecharacterized ?? 0), 0))} tone={exceeded.length ? 'warning' : 'default'} />
      </div>
      <div className="mb-5">
        <Banner tone={exceeded.length > 0 ? 'warning' : 'info'} title="How the $100,000 limit works">
          Under section 422(d) the aggregate fair market value, measured at grant, of stock for which incentive stock options first become
          exercisable in any calendar year may not exceed $100,000. Anything above the limit is treated as a non-qualified option
          and must be tracked separately for tax reporting.
        </Banner>
      </div>
      <Card padded={false}>
        {rows.length === 0 ? <EmptyState title="No ISOs granted" description="The test only applies to incentive stock options." /> : (
          <Table>
            <thead>
              <tr>
                <TH>Year</TH><TH>Employee</TH><TH>Grant</TH>
                <TH align="right">Shares first exercisable</TH><TH align="right">Value at grant</TH><TH align="right">Cumulative</TH>
                <TH align="right">Qualifies as ISO</TH><TH align="right">Treated as NSO</TH><TH>Status</TH><TH width={56} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <TR key={i} className={r.exceeded ? 'bg-amber-50/40' : undefined}>
                  <TD mono>{r.year}</TD>
                  {/* The limit is measured per person per year, so the row belongs to the holder. */}
                  <TD className="font-medium">
                    <Link to={`/stakeholders/${r.stakeholderId}`}
                      className="cursor-pointer text-left font-medium text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-400">
                      {r.stakeholderName}
                    </Link>
                  </TD>
                  <TD className="text-ink-600">{r.awardLabel}</TD>
                  <TD align="right" mono>{shares(r.sharesVesting)}</TD>
                  <TD align="right" mono>{money(r.valueAtGrant)}</TD>
                  <TD align="right" mono className={r.exceeded ? 'font-medium text-amber-700' : 'text-ink-600'}>{money(r.cumulativeValue)}</TD>
                  <TD align="right" mono>{shares(r.isoQualified)}</TD>
                  <TD align="right" mono className={r.nsoRecharacterized > 0 ? 'font-medium text-amber-700' : 'text-ink-400'}>{r.nsoRecharacterized > 0 ? shares(r.nsoRecharacterized) : '—'}</TD>
                  <TD>{r.exceeded ? <Badge tone="warning">Over limit</Badge> : <Badge tone="success">Within limit</Badge>}</TD>
                  {/* The test is run per person per year, so the paperwork behind it belongs
                      to that pair rather than to the grant the row happens to show. */}
                  <TD align="right">
                    <Button size="sm" variant="ghost" onClick={() => setDocumentsFor(r)}
                      aria-label={`Documents for ${r.stakeholderName} in ${r.year}`} title={`Documents for ${r.stakeholderName} in ${r.year}`}>
                      <Icon name="document" className="size-4" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!documentsFor} onClose={() => setDocumentsFor(null)} size="lg"
        title={documentsFor ? `$100,000 limit for ${documentsFor.stakeholderName} in ${documentsFor.year}` : 'Documents'}
        description={documentsFor
          ? `Filed against the $100,000 limit for ${documentsFor.stakeholderName} in ${documentsFor.year}. Every grant tested for that person in that year shares these documents.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} stakeholderId={documentsFor.stakeholderId}
            subject={{ kind: 'ISO_100K', ref: `${documentsFor.stakeholderId}:${documentsFor.year}` }} />
        )}
      </Modal>
    </>
  );
}
