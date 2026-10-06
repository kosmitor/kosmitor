import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import {
  PageHeader, Card, Table, TH, TD, TR, Badge, Loading, ErrorNote,
  EmptyState, SearchInput, Avatar,
} from '../ui.tsx';
import { dateTime } from '../format.ts';
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

      <Card className="mb-5">
        <div className="w-80"><SearchInput value={search} onChange={setSearch} placeholder="Search by person, action or detail" /></div>
      </Card>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing logged yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>When</TH><TH>Who</TH><TH>Action</TH><TH>Entity</TH><TH>Detail</TH><TH>IP address</TH>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap text-ink-600">{dateTime(a.createdAt)}</TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <Avatar name={a.userName ?? 'System'} size={22} />
                      <span className="font-medium">{a.userName ?? 'System'}</span>
                    </span>
                  </TD>
                  <TD><Badge tone={ACTION_TONES[a.action] ?? 'neutral'}>{a.action.toLowerCase()}</Badge></TD>
                  <TD className="text-[12px] text-ink-600">{(a.entityType ?? '—').replace(/_/g, ' ')}</TD>
                  <TD className="max-w-lg text-[12px] text-ink-700">{a.detail ?? '—'}</TD>
                  <TD className="text-[12px] text-ink-400">{a.ipAddress || '—'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
