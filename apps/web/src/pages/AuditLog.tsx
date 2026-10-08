import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { PageHeader, Badge, Loading, ErrorNote, EmptyState, Avatar } from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { dateTime, shares } from '../format.ts';
import { config } from '../config.ts';

const ACTION_TONES: Record<string, any> = {
  CREATE: 'success', UPDATE: 'info', DELETE: 'danger', EXERCISE: 'brand',
  TRANSFER: 'neutral', CANCEL: 'warning', SIGN: 'success', VOTE: 'purple',
  INVITE: 'info', REVOKE: 'danger', EXPORT: 'neutral', CONVERT: 'purple',
  REPURCHASE: 'warning', SEED: 'neutral',
};

export default function AuditLog() {
  const { companyId, canViewAll } = useSession();
  const { data, error, loading, reload } = useQuery<any[]>(
    companyId && canViewAll ? `/c/${companyId}/audit?limit=${config.limits.ledgerMaxPageSize}` : null, [companyId]);
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((a) => !q
      || (a.detail ?? '').toLowerCase().includes(q)
      || (a.userName ?? '').toLowerCase().includes(q)
      || a.action.toLowerCase().includes(q));
  }, [data, search]);

  if (!canViewAll) return <EmptyState title="The audit log is not available for your role" />;
  if (loading) return <Loading label="Loading the audit log" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  return (
    <>
      <PageHeader concept="audit-log" title="Audit log"
        subtitle="An append-only record of every change, who made it and when" />

      {/* The server sends the newest first, which is the order the table opens in. */}
      <DataTable caption="Audit log" rows={rows} rowKey={(a) => a.id}
        search={{ value: search, onChange: setSearch, placeholder: 'Search by person, action or detail' }}
        defaultSort={{ key: 'when', direction: 'desc' }}
        empty={<EmptyState title="Nothing logged yet" />}
        columns={[
          { key: 'when', label: 'When', type: 'date', value: (a) => a.createdAt, cell: (a) => dateTime(a.createdAt), className: 'text-ink-600' },
          // A name keeps to one line, as a holder's does on the cap table.
          { key: 'who', label: 'Who', value: (a) => a.userName ?? 'System', className: 'whitespace-nowrap', cell: (a) => (
            <span className="flex items-center gap-2">
              <Avatar name={a.userName ?? 'System'} size={22} />
              <span className="font-medium">{a.userName ?? 'System'}</span>
            </span>
          ) },
          { key: 'action', label: 'Action', value: (a) => a.action.toLowerCase(),
            cell: (a) => <Badge tone={ACTION_TONES[a.action] ?? 'neutral'}>{a.action.toLowerCase()}</Badge> },
          { key: 'entity', label: 'Entity', value: (a) => a.entityType?.replace(/_/g, ' '), className: 'text-[12px] text-ink-600' },
          { key: 'detail', label: 'Detail', value: (a) => a.detail, className: 'max-w-lg text-[12px] text-ink-700' },
          { key: 'ip', label: 'IP address', value: (a) => a.ipAddress, className: 'text-[12px] text-ink-400' },
        ]}
        // The page loads the newest entries only, so a sort or a search reaches no further back than those.
        after={(data?.length ?? 0) >= config.limits.ledgerMaxPageSize && (
          <p className="border-t border-ink-100 px-5 py-3 text-[12px] text-ink-500">
            The newest {shares(config.limits.ledgerMaxPageSize)} entries are shown, and sorting and searching cover only these.
          </p>
        )} />
    </>
  );
}
