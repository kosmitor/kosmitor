import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, downloadReport } from '../api.ts';
import {
  PageHeader, Card, Table, TH, TD, TR, Badge, Loading, ErrorNote, Button,
  EmptyState, SearchInput, Select, Field,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { money, shares, pps, date } from '../format.ts';
import { config } from '../config.ts';

const TYPE_TONES: Record<string, any> = {
  ISSUANCE: 'success', GRANT: 'brand', EXERCISE: 'info', TRANSFER: 'neutral',
  REPURCHASE: 'warning', CANCELLATION: 'danger', CONVERSION: 'purple',
  POOL_INCREASE: 'brand', STOCK_SPLIT: 'info', SECONDARY_SALE: 'neutral', DIVIDEND: 'success',
};

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

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Type" className="w-52">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="ALL">All transaction types</option>
              {types.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
            </Select>
          </Field>
          <div className="ml-auto w-72">
            <Field label="Search"><SearchInput value={search} onChange={setSearch} placeholder="Memo or stakeholder" /></Field>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="No transactions" description="Issuances, exercises, transfers and conversions appear here automatically." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Date</TH><TH>Type</TH><TH>Stakeholder</TH>
                <TH align="right">Quantity</TH><TH align="right">Price</TH><TH align="right">Amount</TH>
                <TH>Memo</TH><TH>Recorded by</TH>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <TR key={t.id}>
                  <TD className="whitespace-nowrap text-ink-600">{date(t.date)}</TD>
                  <TD><Badge tone={TYPE_TONES[t.type] ?? 'neutral'}>{t.type.replace(/_/g, ' ').toLowerCase()}</Badge></TD>
                  <TD className="font-medium">
                    {t.stakeholderId ? nameOf.get(t.stakeholderId) ?? '—' : '—'}
                    {t.counterpartyId && <span className="text-ink-500"> → {nameOf.get(t.counterpartyId) ?? '—'}</span>}
                  </TD>
                  <TD align="right" mono>{t.quantity ? shares(t.quantity) : '—'}</TD>
                  <TD align="right" mono>{t.pricePerShare ? pps(t.pricePerShare) : '—'}</TD>
                  <TD align="right" mono>{t.amount ? money(t.amount, { compact: true }) : '—'}</TD>
                  <TD className="max-w-md text-[12px] text-ink-600">{t.memo ?? '—'}</TD>
                  <TD className="text-[12px] text-ink-500">{t.createdBy ?? 'System'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
