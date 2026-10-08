import { useState } from 'react';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, Checkbox, MiniBar, Tabs, KeyValue, InfoDot,
} from '../ui.tsx';
import { DataTable } from '../DataTable.tsx';
import { Icon } from '../icons.tsx';
import { shares, percent, date, today, parseShares, parsePercent } from '../format.ts';
import { config } from '../config.ts';

/** The share of a back-loaded grant that vests in each year (equity.backLoadedWeights). */
const BACK_LOADED = config.equity.backLoadedWeights;

const poolBlank = {
  name: '', shareClassId: '', authorized: '', boardApprovalDate: today(),
  shareholderApprovalDate: '', returnForfeitures: true, evergreenPercent: '', planType: 'STOCK_PLAN',
};
const scheduleBlank = {
  name: '', kind: 'TIME', durationMonths: String(config.equity.vestingMonths), cliffMonths: String(config.equity.cliffMonths), frequency: 'MONTHLY',
  immediatePortion: '0', accelerationSingle: '0', accelerationDouble: '0', accelerationMonths: '',
  backLoaded: false,
};

export default function Plans() {
  const { companyId, canEdit } = useSession();
  const [tab, setTab] = useState<'pools' | 'schedules'>('pools');
  const pools = useCrud<any>('pools');
  const schedules = useCrud<any>('vesting-schedules');
  const adjustments = useCrud<any>('pool-adjustments');
  const { data: classes } = useQuery<any[]>(companyId ? `/c/${companyId}/share-classes` : null, [companyId]);
  const { data: summary, reload: reloadSummary } = useQuery<any[]>(companyId ? `/c/${companyId}/pools/summary` : null, [companyId]);

  const [editingPool, setEditingPool] = useState<any>(null);
  const [poolForm, setPoolForm] = useState(poolBlank);
  const [editingSchedule, setEditingSchedule] = useState<any>(null);
  const [scheduleForm, setScheduleForm] = useState(scheduleBlank);
  const [adjusting, setAdjusting] = useState<any>(null);
  const [adjustForm, setAdjustForm] = useState({ amount: '', date: today(), reason: '' });
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'pool' | 'schedule'; row: any } | null>(null);

  const savePool = async () => {
    const payload = {
      name: poolForm.name, shareClassId: poolForm.shareClassId,
      authorized: parseShares(poolForm.authorized),
      boardApprovalDate: poolForm.boardApprovalDate || null,
      shareholderApprovalDate: poolForm.shareholderApprovalDate || null,
      returnForfeitures: poolForm.returnForfeitures,
      evergreenPercent: poolForm.evergreenPercent ? parsePercent(poolForm.evergreenPercent) : null,
      planType: poolForm.planType,
    };
    const ok = editingPool?.id
      ? await pools.update(editingPool.id, payload, 'Plan updated')
      : await pools.create(payload, 'Equity plan created');
    if (ok) { setEditingPool(null); reloadSummary(); }
  };

  const saveSchedule = async () => {
    const payload = {
      name: scheduleForm.name, kind: scheduleForm.kind,
      durationMonths: Number(scheduleForm.durationMonths) || 0,
      cliffMonths: Number(scheduleForm.cliffMonths) || 0,
      frequency: scheduleForm.frequency,
      immediatePortion: parsePercent(scheduleForm.immediatePortion || '0'),
      yearWeights: scheduleForm.backLoaded ? JSON.stringify(BACK_LOADED) : null,
      accelerationSingle: parsePercent(scheduleForm.accelerationSingle || '0'),
      accelerationDouble: parsePercent(scheduleForm.accelerationDouble || '0'),
      accelerationMonths: scheduleForm.accelerationMonths ? Number(scheduleForm.accelerationMonths) : null,
    };
    const ok = editingSchedule?.id
      ? await schedules.update(editingSchedule.id, payload, 'Schedule updated')
      : await schedules.create(payload, 'Schedule created');
    if (ok) setEditingSchedule(null);
  };

  const saveAdjustment = async () => {
    const ok = await adjustments.create({
      poolId: adjusting.id, date: adjustForm.date,
      amount: parseShares(adjustForm.amount), reason: adjustForm.reason || 'Plan reserve change',
    }, 'Plan reserve adjusted');
    if (ok) { setAdjusting(null); reloadSummary(); pools.reload(); }
  };

  if (pools.loading || schedules.loading) return <Loading label="Loading plans" />;
  if (pools.error) return <ErrorNote error={pools.error} onRetry={pools.reload} />;

  const summaryOf = (id: string) => (summary ?? []).find((s) => s.poolId === id);

  return (
    <>
      <PageHeader concept="equity-plans" title="Plans & vesting"
        subtitle="Equity incentive plans and the vesting schedules available to grants"
        tabs={<Tabs value={tab} onChange={setTab} tabs={[
          { value: 'pools', label: 'Equity plans', count: pools.items.length },
          { value: 'schedules', label: 'Vesting schedules', count: schedules.items.length },
        ]} />}
        actions={canEdit && (tab === 'pools'
          ? <Button variant="primary" icon={<Icon name="plus" />}
              onClick={() => { setPoolForm({ ...poolBlank, shareClassId: classes?.find((c) => c.kind === 'COMMON')?.id ?? '' }); setEditingPool({ id: null }); }}>
              New plan</Button>
          : <Button variant="primary" icon={<Icon name="plus" />}
              onClick={() => { setScheduleForm(scheduleBlank); setEditingSchedule({ id: null }); }}>
              New schedule</Button>)} />

      {tab === 'pools' && (
        pools.items.length === 0 ? (
          <Card><EmptyState title="No equity plans"
            description="An equity incentive plan reserves shares that can be granted as options or RSUs." /></Card>
        ) : (
          <div className="space-y-4">
            {pools.items.map((p) => {
              const s = summaryOf(p.id);
              const poolAdjustments = adjustments.items.filter((a) => a.poolId === p.id);
              return (
                <Card key={p.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[15px] font-semibold">{p.name}</h3>
                        <Badge tone="neutral">{p.planType.replace(/_/g, ' ').toLowerCase()}</Badge>
                        {p.evergreenPercent && <Badge tone="info">Evergreen {percent(p.evergreenPercent, 0)}</Badge>}
                      </div>
                      <p className="mt-1 text-[13px] text-ink-500">
                        Board approved {date(p.boardApprovalDate)}
                        {p.shareholderApprovalDate && ` · stockholders approved ${date(p.shareholderApprovalDate)}`}
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="secondary"
                          onClick={() => { setAdjustForm({ amount: '', date: today(), reason: '' }); setAdjusting(p); }}>
                          Adjust reserve
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Edit"
                          onClick={() => {
                            setPoolForm({
                              name: p.name, shareClassId: p.shareClassId, authorized: String(p.authorized),
                              boardApprovalDate: p.boardApprovalDate ?? '', shareholderApprovalDate: p.shareholderApprovalDate ?? '',
                              returnForfeitures: !!p.returnForfeitures,
                              evergreenPercent: p.evergreenPercent ? String(p.evergreenPercent * 100) : '',
                              planType: p.planType,
                            });
                            setEditingPool(p);
                          }}>
                          <Icon name="edit" className="size-4" />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Delete"
                          onClick={() => setConfirmDelete({ kind: 'pool', row: p })}>
                          <Icon name="trash" className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {s && (
                    <div className="mt-4 border-t border-ink-100 pt-4">
                      <div className="mb-3 flex items-baseline justify-between">
                        <span className="text-[13px] text-ink-600">{shares(s.granted - s.cancelledReturned)} granted of {shares(s.authorized)} reserved</span>
                        <span className={`text-[13px] font-medium tabular ${s.available < 0 ? 'text-red-600' : 'text-ink-900'}`}>
                          {shares(s.available)} available
                        </span>
                      </div>
                      <MiniBar value={s.utilizationPct} tone={s.available < 0 ? 'amber' : 'brand'} />
                      <div className="mt-4">
                        <KeyValue columns={3} items={[
                          { label: 'Reserved', value: shares(s.authorized) },
                          { label: 'Granted', value: shares(s.granted) },
                          { label: 'Exercised', value: shares(s.exercised) },
                          { label: 'Returned from cancellations', value: shares(s.cancelledReturned) },
                          { label: 'Available to grant', value: shares(s.available) },
                          { label: 'Utilisation', value: percent(s.utilizationPct, 1) },
                        ]} />
                      </div>
                    </div>
                  )}

                  {poolAdjustments.length > 0 && (
                    <div className="mt-4 border-t border-ink-100 pt-3">
                      <p className="mb-2 text-[12px] font-medium text-ink-600">Reserve changes</p>
                      <ul className="space-y-1">
                        {poolAdjustments.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-3 text-[12px]">
                            <span className="text-ink-600">{date(a.date)} — {a.reason}</span>
                            <span className={`shrink-0 tabular font-medium ${a.amount > 0 ? 'text-secondary-800' : 'text-red-600'}`}>
                              {a.amount > 0 ? '+' : ''}{shares(a.amount)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )
      )}

      {/* In the order the server gives (by name); a heading sorts by another column. */}
      {tab === 'schedules' && (
        <DataTable caption="Vesting schedules" rows={schedules.items} rowKey={(s) => s.id}
          search={{ placeholder: 'Search schedules', by: (s) => [s.name] }}
          empty={<p className="px-5 py-8 text-center text-[13px] text-ink-500">No vesting schedules yet.</p>}
          columns={[
            { key: 'name', label: 'Schedule', value: (s) => s.name, className: 'font-medium' },
            { key: 'kind', label: 'Type', value: (s) => s.kind.toLowerCase(),
              cell: (s) => <Badge tone="neutral">{s.kind.toLowerCase()}</Badge> },
            { key: 'duration', label: 'Duration', type: 'number', value: (s) => s.durationMonths, cell: (s) => `${s.durationMonths} mo` },
            { key: 'cliff', label: 'Cliff', type: 'number', value: (s) => s.cliffMonths || null,
              cell: (s) => (s.cliffMonths ? `${s.cliffMonths} mo` : '—') },
            { key: 'frequency', label: 'Frequency', value: (s) => s.frequency.toLowerCase(), className: 'text-ink-600 capitalize' },
            { key: 'acceleration', label: 'Acceleration',
              cell: (s) => (
                <span className="flex flex-wrap gap-1">
                  {s.accelerationSingle > 0 && <Badge tone="info">Single {percent(s.accelerationSingle, 0)}</Badge>}
                  {s.accelerationDouble > 0 && <Badge tone="purple">Double {percent(s.accelerationDouble, 0)}</Badge>}
                  {!s.accelerationSingle && !s.accelerationDouble && <span className="text-ink-400">—</span>}
                </span>
              ) },
            { key: 'actions', label: '', width: 90, align: 'right', hidden: !canEdit,
              cell: (s) => (
                <span className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" aria-label="Edit"
                    onClick={() => {
                      setScheduleForm({
                        name: s.name, kind: s.kind, durationMonths: String(s.durationMonths),
                        cliffMonths: String(s.cliffMonths), frequency: s.frequency,
                        immediatePortion: String(s.immediatePortion * 100),
                        accelerationSingle: String(s.accelerationSingle * 100),
                        accelerationDouble: String(s.accelerationDouble * 100),
                        accelerationMonths: s.accelerationMonths ? String(s.accelerationMonths) : '',
                        backLoaded: !!s.yearWeights,
                      });
                      setEditingSchedule(s);
                    }}>
                    <Icon name="edit" className="size-4" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Delete"
                    onClick={() => setConfirmDelete({ kind: 'schedule', row: s })}>
                    <Icon name="trash" className="size-4" />
                  </Button>
                </span>
              ) },
          ]} />
      )}

      <FormModal open={!!editingPool} onClose={() => setEditingPool(null)} busy={pools.busy}
        title={editingPool?.id ? 'Edit equity plan' : 'New equity plan'} onSubmit={savePool}
        submitLabel={editingPool?.id ? 'Save changes' : 'Create plan'}
        description="A plan reserves authorized shares for grants. Increases usually happen alongside a financing round.">
        <FormGrid>
          <Field label="Plan name" required>
            <Input value={poolForm.name} onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })} placeholder="2024 Equity Incentive Plan" required />
          </Field>
          <Field label="Plan type">
            <Select value={poolForm.planType} onChange={(e) => setPoolForm({ ...poolForm, planType: e.target.value })}>
              <option value="STOCK_PLAN">Stock plan</option>
              <option value="INDUCEMENT">Inducement grant</option>
              <option value="ESPP">Employee stock purchase plan</option>
            </Select>
          </Field>
          <Field label="Share class" required>
            <Select value={poolForm.shareClassId} onChange={(e) => setPoolForm({ ...poolForm, shareClassId: e.target.value })} required>
              {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Shares reserved" required>
            <Input value={poolForm.authorized} onChange={(e) => setPoolForm({ ...poolForm, authorized: e.target.value })} placeholder="2,000,000" required />
          </Field>
          <Field label="Board approval date">
            <Input type="date" value={poolForm.boardApprovalDate} onChange={(e) => setPoolForm({ ...poolForm, boardApprovalDate: e.target.value })} />
          </Field>
          <Field label="Stockholder approval date" hint="Required for ISOs to qualify.">
            <Input type="date" value={poolForm.shareholderApprovalDate} onChange={(e) => setPoolForm({ ...poolForm, shareholderApprovalDate: e.target.value })} />
          </Field>
          <Field label="Evergreen top-up (%)" hint="Annual automatic increase as a percentage of outstanding shares.">
            <Input value={poolForm.evergreenPercent} onChange={(e) => setPoolForm({ ...poolForm, evergreenPercent: e.target.value })} placeholder="5" />
          </Field>
        </FormGrid>
        <Checkbox label="Cancelled and forfeited grants return to the reserve"
          checked={poolForm.returnForfeitures} onChange={(v) => setPoolForm({ ...poolForm, returnForfeitures: v })} />
      </FormModal>

      <FormModal open={!!adjusting} onClose={() => setAdjusting(null)} busy={adjustments.busy}
        title="Adjust plan reserve" onSubmit={saveAdjustment} submitLabel="Record adjustment"
        description="Records an increase or decrease to the shares reserved under the plan.">
        <FormGrid>
          <Field label="Change in shares" required hint="Use a negative number to reduce the reserve.">
            <Input value={adjustForm.amount} onChange={(e) => setAdjustForm({ ...adjustForm, amount: e.target.value })} placeholder="1,000,000" required />
          </Field>
          <Field label="Effective date" required>
            <Input type="date" value={adjustForm.date} onChange={(e) => setAdjustForm({ ...adjustForm, date: e.target.value })} required />
          </Field>
        </FormGrid>
        <Field label="Reason">
          <Input value={adjustForm.reason} onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })} placeholder="Series B pool refresh" />
        </Field>
      </FormModal>

      <FormModal open={!!editingSchedule} onClose={() => setEditingSchedule(null)} busy={schedules.busy}
        title={editingSchedule?.id ? 'Edit vesting schedule' : 'New vesting schedule'} onSubmit={saveSchedule}
        submitLabel={editingSchedule?.id ? 'Save changes' : 'Create schedule'}
        description="Schedules are reusable across grants and restricted stock.">
        <Field label="Schedule name" required>
          <Input value={scheduleForm.name} onChange={(e) => setScheduleForm({ ...scheduleForm, name: e.target.value })}
            placeholder="4 years, 1 year cliff, monthly" required />
        </Field>
        <FormGrid columns={3}>
          <Field label="Duration (months)">
            <Input type="number" value={scheduleForm.durationMonths} onChange={(e) => setScheduleForm({ ...scheduleForm, durationMonths: e.target.value })} />
          </Field>
          <Field label="Cliff (months)">
            <Input type="number" value={scheduleForm.cliffMonths} onChange={(e) => setScheduleForm({ ...scheduleForm, cliffMonths: e.target.value })} />
          </Field>
          <Field label="Frequency">
            <Select value={scheduleForm.frequency} onChange={(e) => setScheduleForm({ ...scheduleForm, frequency: e.target.value })}>
              <option value="MONTHLY">Monthly</option>
              <option value="QUARTERLY">Quarterly</option>
              <option value="ANNUAL">Annually</option>
              <option value="WEEKLY">Weekly</option>
              <option value="DAILY">Daily</option>
            </Select>
          </Field>
        </FormGrid>
        <FormGrid columns={3}>
          <Field label="Vests upfront (%)" hint="Portion vesting at the start date.">
            <Input value={scheduleForm.immediatePortion} onChange={(e) => setScheduleForm({ ...scheduleForm, immediatePortion: e.target.value })} placeholder="0" />
          </Field>
          <Field label={<>Single trigger (%)<InfoDot text="Accelerates on a change of control alone." /></>}>
            <Input value={scheduleForm.accelerationSingle} onChange={(e) => setScheduleForm({ ...scheduleForm, accelerationSingle: e.target.value })} placeholder="0" />
          </Field>
          <Field label={<>Double trigger (%)<InfoDot text="Accelerates when a termination follows a change of control." /></>}>
            <Input value={scheduleForm.accelerationDouble} onChange={(e) => setScheduleForm({ ...scheduleForm, accelerationDouble: e.target.value })} placeholder="100" />
          </Field>
        </FormGrid>
        <Checkbox label={`Back-loaded vesting (${BACK_LOADED.map((w) => Math.round(w * 1000) / 10).join(' / ')} by year)`}
          hint="Vests a smaller portion in early years, weighting later service more heavily."
          checked={scheduleForm.backLoaded} onChange={(v) => setScheduleForm({ ...scheduleForm, backLoaded: v })} />
      </FormModal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger
        loading={pools.busy || schedules.busy}
        title={confirmDelete?.kind === 'pool' ? 'Delete equity plan' : 'Delete vesting schedule'}
        confirmLabel="Delete"
        message={`Delete "${confirmDelete?.row?.name}"? This is only possible while nothing references it.`}
        onConfirm={async () => {
          const ok = confirmDelete!.kind === 'pool'
            ? await pools.remove(confirmDelete!.row.id, 'Plan deleted')
            : await schedules.remove(confirmDelete!.row.id, 'Schedule deleted');
          if (ok) { setConfirmDelete(null); reloadSummary(); }
        }} />
    </>
  );
}
