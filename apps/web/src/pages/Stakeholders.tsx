import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCrud, FormModal } from '../crud.tsx';
import { STAKEHOLDER_BLANK, StakeholderFields, stakeholderFormFrom, stakeholderPayload, type StakeholderForm } from './stakeholders/StakeholderForm.tsx';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { useSearchQuery } from '../hooks.ts';
import {
  PageHeader, Card, CardHeader, Badge, Loading, ErrorNote, Button,
  Avatar, EmptyState, ConfirmDialog, SegmentedControl, MiniBar,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { OwnershipDonut, ChartLegend } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { shares, percent, date, money, RELATION_LABELS } from '../format.ts';
import { isDirector } from '../board.ts';


export default function Stakeholders() {
  const { companyId, canEdit, canViewAll } = useSession();
  const crud = useCrud<any>('stakeholders');
  const { data: capTable } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/captable` : null, [companyId]);
  const [search, setSearch] = useSearchQuery();
  const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'INVESTOR' | 'BOARD' | 'FORMER'>('ALL');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<StakeholderForm>(STAKEHOLDER_BLANK);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);

  const positionOf = useMemo(() => {
    const map = new Map<string, any>();
    for (const r of capTable?.table?.rows ?? []) map.set(r.stakeholderId, r);
    return map;
  }, [capTable]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return crud.items
      .filter((s) => {
        if (filter === 'ACTIVE') return !s.terminationDate && s.relation !== 'INVESTOR';
        // Investors by relationship, the board by seat: an investor who is a director is in both.
        if (filter === 'INVESTOR') return s.relation === 'INVESTOR';
        if (filter === 'BOARD') return isDirector(s);
        if (filter === 'FORMER') return !!s.terminationDate;
        return true;
      })
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.email ?? '').toLowerCase().includes(q))
      .sort((a, b) => (positionOf.get(b.id)?.fullyDiluted ?? 0) - (positionOf.get(a.id)?.fullyDiluted ?? 0)
        || a.name.localeCompare(b.name));
  }, [crud.items, search, filter, positionOf]);

  const openNew = () => { setForm(STAKEHOLDER_BLANK); setEditing({ id: null }); };
  const openEdit = (s: any) => { setForm(stakeholderFormFrom(s)); setEditing(s); };

  const save = async () => {
    const payload = stakeholderPayload(form);
    const ok = editing?.id
      ? await crud.update(editing.id, payload, 'Stakeholder updated')
      : await crud.create(payload, 'Stakeholder added');
    if (ok) setEditing(null);
  };

  if (crud.loading) return <Loading label="Loading stakeholders" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  const total = capTable?.table?.totals?.fullyDiluted ?? 0;
  const groups = capTable?.groups ?? [];

  return (
    <>
      <PageHeader concept="stakeholders" title="Stakeholders" subtitle={`${crud.items.length} people and entities on the register`}
        actions={canEdit && (
          <>
            <Link to="/import?kind=stakeholders"><Button icon={<Icon name="inbox" />}>Import</Button></Link>
            <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew}>Add stakeholder</Button>
          </>
        )} />

      {groups.length > 0 && (
        <Card className="mb-5">
          <CardHeader title="Ownership" subtitle="Fully diluted, by relationship to the company" />
          <div className="grid items-center gap-x-10 gap-y-5 sm:grid-cols-[180px_minmax(0,1fr)]">
            <OwnershipDonut data={groups} height={180} centerLabel="Fully diluted" centerValue={shares(total)} />
            <ChartLegend data={groups} detailed />
          </div>
        </Card>
      )}

      {/* Largest position first, as the cap table opens; a heading sorts by its column instead. */}
      <DataTable caption="Stakeholders" rows={rows} rowKey={(s) => s.id}
        controls={
          // Five filters are wider than a phone: they scroll rather than run off the card.
          <div className="max-w-full overflow-x-auto">
            <SegmentedControl value={filter} onChange={setFilter} options={[
              { value: 'ALL', label: `All (${crud.items.length})` },
              { value: 'ACTIVE', label: 'Active team' },
              { value: 'INVESTOR', label: 'Investors' },
              { value: 'BOARD', label: 'Board' },
              { value: 'FORMER', label: 'Departed' },
            ]} />
          </div>
        }
        search={{ value: search, onChange: setSearch, placeholder: 'Search by name or email' }}
        defaultSort={{ key: 'diluted', direction: 'desc' }}
        empty={
          <EmptyState title="No stakeholders match" description="Adjust the filter or add someone new."
            action={canEdit && <Button variant="primary" onClick={openNew}>Add stakeholder</Button>} />
        }
        columns={[
          { key: 'name', label: 'Name', value: (s) => s.name, cell: (s) => (
            <Link to={`/stakeholders/${s.id}`} className="flex items-center gap-2.5 hover:text-brand-700">
              <Avatar name={s.name} size={28} />
              <span className="min-w-0">
                <span className="block truncate font-medium" title={s.name}>{s.name}</span>
                <span className="block truncate text-[11px] text-ink-500" title={s.email ?? s.title ?? undefined}>{s.email ?? s.title ?? '—'}</span>
              </span>
            </Link>
          ) },
          { key: 'relation', label: 'Relationship', value: (s) => RELATION_LABELS[s.relation] ?? s.relation, cell: (s) => (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={s.relation === 'INVESTOR' ? 'info' : s.relation === 'FOUNDER' ? 'purple' : 'neutral'}>
                {RELATION_LABELS[s.relation] ?? s.relation}
              </Badge>
              {isDirector(s) && <Badge tone="brand">Board</Badge>}
              {s.terminationDate && <Badge tone="warning">Departed {date(s.terminationDate)}</Badge>}
            </span>
          ) },
          { key: 'started', label: 'Started', type: 'date', value: (s) => s.startDate, className: 'text-ink-600' },
          // A count of zero shows as a dash, so it sorts with the blanks, last either way.
          { key: 'shares', label: 'Shares', type: 'number', value: (s) => positionOf.get(s.id)?.outstanding || null },
          { key: 'options', label: 'Options', type: 'number', value: (s) => positionOf.get(s.id)?.optionsOutstanding || null },
          // A holder with a position shows its figure, 0 included (a SAFE alone), and sorts by it; no position is a dash.
          { key: 'diluted', label: 'Fully diluted', type: 'number', className: 'font-medium',
            value: (s) => positionOf.get(s.id)?.fullyDiluted,
            cell: (s) => { const p = positionOf.get(s.id); return p ? shares(p.fullyDiluted) : '—'; } },
          { key: 'ownership', label: 'Ownership', width: 120, value: (s) => positionOf.get(s.id)?.fullyDilutedPct, cell: (s) => {
            const p = positionOf.get(s.id);
            return p ? (
              <div className="flex items-center gap-2">
                <MiniBar value={p.fullyDiluted / (total || 1)} />
                <span className="w-11 shrink-0 text-right text-[12px] tabular">{percent(p.fullyDilutedPct, 1)}</span>
              </div>
            ) : <span className="text-ink-400">—</span>;
          } },
          { key: 'value', label: 'Value', type: 'money', className: 'text-ink-600', value: (s) => positionOf.get(s.id)?.currentValue,
            cell: (s) => { const p = positionOf.get(s.id); return p ? money(p.currentValue, { compact: true }) : '—'; } },
          { key: 'actions', label: '', width: 90, align: 'right', hidden: !canEdit, cell: (s) => (
            <span className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => openEdit(s)} aria-label="Edit">
                <Icon name="edit" className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(s)} aria-label="Delete">
                <Icon name="trash" className="size-4" />
              </Button>
            </span>
          ) },
        ]} />

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={crud.busy} size="lg"
        title={editing?.id ? 'Edit stakeholder' : 'Add stakeholder'}
        description="Stakeholders hold shares, options, SAFEs and notes. Departures drive vesting cut-off and exercise windows."
        onSubmit={save} submitLabel={editing?.id ? 'Save changes' : 'Add stakeholder'}>
        <StakeholderFields form={form} setForm={setForm} people={crud.items} selfId={editing?.id ?? null} isNew={!editing?.id} />
      </FormModal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={crud.busy}
        title="Remove stakeholder" confirmLabel="Remove"
        message={<>Remove <strong>{confirmDelete?.name}</strong> from the register? This is only possible while they hold no securities.</>}
        onConfirm={async () => { if (await crud.remove(confirmDelete.id, 'Stakeholder removed')) setConfirmDelete(null); }} />
    </>
  );
}
