import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, downloadReport } from '../api.ts';
import { PageHeader, Badge, Loading, ErrorNote, Button, EmptyState, Select } from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { Icon } from '../icons.tsx';
import { money, pps, shares } from '../format.ts';
import { config } from '../config.ts';

const TYPE_TONES: Record<string, any> = {
  ISSUANCE: 'success', GRANT: 'brand', EXERCISE: 'info', TRANSFER: 'neutral',
  REPURCHASE: 'warning', CANCELLATION: 'danger', CONVERSION: 'purple',
  POOL_INCREASE: 'brand', STOCK_SPLIT: 'info', SECONDARY_SALE: 'neutral', DIVIDEND: 'success',
};

/** A type as the badge and the filter say it: "pool increase". */
const typeLabel = (type: string): string => type.replace(/_/g, ' ').toLowerCase();

export default function Ledger() {
  const { companyId, canViewAll } = useSession();
  const { data, error, loading, reload } = useQuery<any[]>(
    companyId && canViewAll ? `/c/${companyId}/transactions?limit=${config.limits.ledgerMaxPageSize}` : null, [companyId]);
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('ALL');

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const types = useMemo(() => [...new Set((data ?? []).map((t) => t.type))].sort(), [data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? [])
      .filter((t) => type === 'ALL' || t.type === type)
      .filter((t) => !q || (t.memo ?? '').toLowerCase().includes(q)
        || (nameOf.get(t.stakeholderId) ?? '').toLowerCase().includes(q));
  }, [data, search, type, nameOf]);

  if (!canViewAll) return <EmptyState title="The transaction ledger is not available for your role" />;
  if (loading) return <Loading label="Loading the ledger" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  return (
    <>
      <PageHeader concept="transactions" title="Transaction ledger"
        subtitle="Every event that changed the cap table, in date order"
        actions={<Button icon={<Icon name="download" />}
          onClick={() => void downloadReport(companyId!, 'transactions')}>Export CSV</Button>} />

      {/* The page keeps its filter and its search, and the table shows the rows they leave.
          The server sends the newest first, which is the order the table opens in. */}
      <DataTable caption="Transaction ledger" rows={rows} rowKey={(t) => t.id}
        defaultSort={{ key: 'date', direction: 'desc' }}
        controls={(
          <span className="block w-full sm:w-52">
            <Select aria-label="Transaction type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="ALL">All transaction types</option>
              {types.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </Select>
          </span>
        )}
        search={{ value: search, onChange: setSearch, placeholder: 'Memo or stakeholder', label: 'Search by memo or stakeholder' }}
        empty={<EmptyState title="No transactions" description="Issuances, exercises, transfers and conversions appear here automatically." />}
        columns={[
          { key: 'date', label: 'Date', type: 'date', value: (t) => t.date, className: 'text-ink-600' },
          { key: 'type', label: 'Type', value: (t) => typeLabel(t.type),
            cell: (t) => <Badge tone={TYPE_TONES[t.type] ?? 'neutral'}>{typeLabel(t.type)}</Badge> },
          { key: 'stakeholder', label: 'Stakeholder', className: 'font-medium',
            value: (t) => (t.stakeholderId ? nameOf.get(t.stakeholderId) : null),
            cell: (t) => (
              <>
                {t.stakeholderId ? nameOf.get(t.stakeholderId) ?? '—' : '—'}
                {t.counterpartyId && <span className="text-ink-500"> → {nameOf.get(t.counterpartyId) ?? '—'}</span>}
              </>
            ) },
          { key: 'quantity', label: 'Quantity', type: 'number', value: (t) => t.quantity || null },
          { key: 'price', label: 'Price', type: 'price', value: (t) => t.pricePerShare || null,
            cell: (t) => (t.pricePerShare ? pps(t.pricePerShare) : '—') },
          { key: 'amount', label: 'Amount', type: 'money', value: (t) => t.amount || null,
            cell: (t) => (t.amount ? money(t.amount, { compact: true }) : '—') },
          { key: 'memo', label: 'Memo', wrap: true, className: 'max-w-md text-[12px] text-ink-600', cell: (t) => t.memo ?? '—' },
          { key: 'recordedBy', label: 'Recorded by', value: (t) => t.createdBy ?? 'System', className: 'text-[12px] text-ink-500' },
        ]}
        // The page loads the newest entries only, so a sort or a search reaches no further back than those.
        after={(data?.length ?? 0) >= config.limits.ledgerMaxPageSize && (
          <p className="border-t border-ink-100 px-5 py-3 text-[12px] text-ink-500">
            The newest {shares(config.limits.ledgerMaxPageSize)} transactions are shown, and sorting and searching cover only these. Export CSV has every one.
          </p>
        )} />
    </>
  );
}
