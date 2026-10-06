import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { downloadReport } from '../api.ts';
import { PageHeader, Card, Button, Input, Field, EmptyState, useToast } from '../ui.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { today } from '../format.ts';

const REPORTS: { key: string; title: string; description: string; icon: IconName }[] = [
  { key: 'captable', title: 'Capitalization table', icon: 'table',
    description: 'Every holder with shares, options, RSUs, warrants, fully diluted position, ownership percentage and current value.' },
  { key: 'ownership-by-class', title: 'Ownership by share class', icon: 'layers',
    description: 'Authorized, outstanding and as-converted shares per class with invested capital and liquidation preference.' },
  { key: 'grants', title: 'Equity award register', icon: 'award',
    description: 'All grants with quantities, strike prices, vested and unvested balances, exercises and cancellations.' },
  { key: 'vesting', title: 'Vesting schedule detail', icon: 'calendar',
    description: 'Every vesting tranche for every grant, with dates, amounts and running cumulative totals.' },
  { key: 'convertibles', title: 'Convertible instruments', icon: 'convert',
    description: 'SAFEs and notes with principal, valuation caps, discounts, interest rates and maturity dates.' },
  { key: 'transactions', title: 'Transaction ledger', icon: 'ledger',
    description: 'Chronological record of issuances, exercises, transfers, repurchases and conversions.' },
];

export default function Reports() {
  const { companyId, canViewAll } = useSession();
  const toast = useToast();
  const [asOf, setAsOf] = useState(today());
  const [downloading, setDownloading] = useState<string | null>(null);

  if (!canViewAll) return <EmptyState title="Reports are not available for your role" />;

  const download = async (key: string) => {
    setDownloading(key);
    try {
      await downloadReport(companyId!, key, asOf);
      toast('Report downloaded');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally { setDownloading(null); }
  };

  return (
    <>
      <PageHeader concept="reports" title="Reports"
        subtitle="Export the cap table and supporting schedules as CSV for auditors, counsel and diligence" />

      <Card className="mb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Field label="As of date" hint="Reports are computed as of this date, so you can reproduce a historical position."
            className="w-48">
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <div className="flex items-start gap-3.5 rounded-lg border border-brand-200 bg-brand-50/60 p-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white text-brand-600"><Icon name="filter" className="size-5" /></span>
            <div>
              <p className="text-[14px] font-semibold text-brand-900">Need something specific?</p>
              <p className="mt-0.5 text-[12px] text-brand-900/70">Pick your own columns and filters over stakeholders, certificates, grants, SAFEs, warrants or the ledger, then export to Excel or CSV.</p>
              <Link to="/reports/builder"><Button size="sm" variant="primary" className="mt-2">Open the report builder</Button></Link>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {REPORTS.map((r) => (
          <Card key={r.key}>
            <div className="flex items-start gap-3.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                <Icon name={r.icon} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-semibold text-ink-900">{r.title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-500">{r.description}</p>
                <Button size="sm" className="mt-3.5" icon={<Icon name="download" className="size-3.5" />}
                  loading={downloading === r.key} onClick={() => void download(r.key)}>
                  Download CSV
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
