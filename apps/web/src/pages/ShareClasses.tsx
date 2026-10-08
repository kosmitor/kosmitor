import { useState } from 'react';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import {
  PageHeader, Card, Badge, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, Checkbox, KeyValue, InfoDot,
  Textarea,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { shares, pps, percent, date, today, parseShares, parsePPS, parsePercent } from '../format.ts';
import { config } from '../config.ts';

const PARTICIPATION = [
  ['NON_PARTICIPATING', 'Non-participating — takes the preference or converts, whichever is greater'],
  ['FULL_PARTICIPATING', 'Full participation — takes the preference and shares the residual'],
  ['CAPPED_PARTICIPATING', 'Capped participation — participates up to a multiple of the issue price'],
];
const ANTI_DILUTION = [
  ['NONE', 'None'],
  ['BROAD_WEIGHTED', 'Broad-based weighted average'],
  ['NARROW_WEIGHTED', 'Narrow-based weighted average'],
  ['FULL_RATCHET', 'Full ratchet'],
];

/** A price for the form: in cents when it is a whole number of them (1 is "1.00"), in full otherwise. */
const priceText = (n: number): string => (Math.abs(Math.round(n * 100) - n * 100) < 1e-9 ? n.toFixed(2) : String(n));

/** A new class starts as preferred, on equity.preferredClass, at common's par value (company.commonClass.parValue). */
const PREFERRED = config.equity.preferredClass;
const PAR = String(config.company.commonClass.parValue);

const blank = {
  name: '', kind: 'PREFERRED', authorized: String(PREFERRED.authorized), parValue: PAR, seniority: '1',
  originalIssuePrice: priceText(PREFERRED.originalIssuePrice), liquidationMultiple: String(PREFERRED.liquidationMultiple), participation: 'NON_PARTICIPATING',
  participationCap: '2', conversionRatio: '1', dividendType: 'NONE', dividendRate: '8',
  dividendCompounding: false, votesPerShare: '1', antiDilution: 'BROAD_WEIGHTED',
  payToPlay: false, issueDate: today(), isConvertible: true, legend: '',
};

export default function ShareClasses() {
  const { canEdit } = useSession();
  const crud = useCrud<any>('share-classes');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);

  const openNew = () => {
    const nextSeniority = Math.max(0, ...crud.items.map((c) => c.seniority)) + 1;
    setForm({ ...blank, seniority: String(nextSeniority) });
    setEditing({ id: null });
  };

  const openEdit = (c: any) => {
    setForm({
      name: c.name, kind: c.kind, authorized: String(c.authorized),
      parValue: String(c.parValue / 1e6), seniority: String(c.seniority),
      originalIssuePrice: String(c.originalIssuePrice / 1e6),
      liquidationMultiple: String(c.liquidationMultiple),
      participation: c.participation, participationCap: String(c.participationCap ?? 2),
      conversionRatio: String(c.conversionRatio), dividendType: c.dividendType,
      dividendRate: String(c.dividendRate * 100), dividendCompounding: !!c.dividendCompounding,
      votesPerShare: String(c.votesPerShare), antiDilution: c.antiDilution,
      payToPlay: !!c.payToPlay, issueDate: c.issueDate, isConvertible: !!c.isConvertible, legend: c.legend ?? '',
    });
    setEditing(c);
  };

  const save = async () => {
    const isCommon = form.kind === 'COMMON';
    const payload = {
      name: form.name, kind: form.kind,
      authorized: parseShares(form.authorized),
      parValue: parsePPS(form.parValue),
      seniority: isCommon ? 0 : Number(form.seniority),
      originalIssuePrice: parsePPS(form.originalIssuePrice),
      liquidationMultiple: isCommon ? 1 : Number(form.liquidationMultiple),
      participation: isCommon ? 'NON_PARTICIPATING' : form.participation,
      participationCap: form.participation === 'CAPPED_PARTICIPATING' ? Number(form.participationCap) : null,
      conversionRatio: Number(form.conversionRatio) || 1,
      legend: form.legend || null,
      dividendType: form.dividendType, dividendRate: parsePercent(form.dividendRate),
      dividendCompounding: form.dividendCompounding, votesPerShare: Number(form.votesPerShare) || 1,
      antiDilution: isCommon ? 'NONE' : form.antiDilution, payToPlay: form.payToPlay,
      issueDate: form.issueDate, isConvertible: !isCommon,
    };
    const ok = editing?.id
      ? await crud.update(editing.id, payload, 'Share class updated')
      : await crud.create(payload, 'Share class created');
    if (ok) setEditing(null);
  };

  if (crud.loading) return <Loading label="Loading share classes" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  return (
    <>
      <PageHeader concept="share-classes" title="Share classes"
        subtitle="Authorized capital and the economic terms that drive the liquidation waterfall"
        actions={canEdit && <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew}>New share class</Button>} />

      {crud.items.length === 0 ? (
        <Card><EmptyState title="No share classes yet"
          description="Create a common class first, then add a preferred class for each priced round."
          action={canEdit && <Button variant="primary" onClick={openNew}>Create a share class</Button>} /></Card>
      ) : (
        <div className="space-y-4">
          {crud.items.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold">{c.name}</h3>
                    <Badge tone={c.kind === 'PREFERRED' ? 'purple' : 'neutral'}>
                      {c.kind === 'PREFERRED' ? 'Preferred' : 'Common'}
                    </Badge>
                    {c.kind === 'PREFERRED' && <Badge tone="brand">Seniority {c.seniority}</Badge>}
                    {!!c.payToPlay && <Badge tone="warning">Pay to play</Badge>}
                  </div>
                  <p className="mt-1 text-[13px] text-ink-500">Authorized {date(c.issueDate)}</p>
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)} icon={<Icon name="edit" className="size-4" />}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(c)} aria-label="Delete">
                      <Icon name="trash" className="size-4" />
                    </Button>
                  </div>
                )}
              </div>

              <div className="mt-4 border-t border-ink-100 pt-4">
                <KeyValue columns={3} items={[
                  { label: 'Authorized shares', value: shares(c.authorized) },
                  { label: 'Original issue price', value: pps(c.originalIssuePrice) },
                  { label: 'Par value', value: pps(c.parValue) },
                  ...(c.kind === 'PREFERRED' ? [
                    { label: <>Liquidation preference<InfoDot text="Multiple of the original issue price paid before common in a liquidation." /></>,
                      value: `${c.liquidationMultiple}x` },
                    { label: 'Participation',
                      value: c.participation === 'NON_PARTICIPATING' ? 'Non-participating'
                        : c.participation === 'FULL_PARTICIPATING' ? 'Full participation'
                        : `Capped at ${c.participationCap}x` },
                    { label: 'Conversion ratio', value: `${c.conversionRatio}:1` },
                    { label: 'Anti-dilution', value: ANTI_DILUTION.find(([v]) => v === c.antiDilution)?.[1] ?? c.antiDilution },
                    { label: 'Dividends', value: c.dividendType === 'NONE' ? 'None'
                        : `${percent(c.dividendRate, 1)} ${c.dividendType === 'CUMULATIVE' ? 'cumulative' : 'non-cumulative'}${c.dividendCompounding ? ', compounding' : ''}` },
                    { label: 'Votes per share', value: String(c.votesPerShare) },
                  ] : [
                    { label: 'Votes per share', value: String(c.votesPerShare) },
                  ]),
                ]} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={crud.busy} size="lg"
        title={editing?.id ? `Edit ${editing.name}` : 'New share class'}
        description="These terms drive the liquidation waterfall, anti-dilution protection and voting calculations."
        onSubmit={save} submitLabel={editing?.id ? 'Save changes' : 'Create class'}>
        <FormGrid>
          <Field label="Class name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Series A Preferred" required />
          </Field>
          <Field label="Type">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="COMMON">Common</option>
              <option value="PREFERRED">Preferred</option>
            </Select>
          </Field>
          <Field label="Authorized shares" required>
            <Input value={form.authorized} onChange={(e) => setForm({ ...form, authorized: e.target.value })} placeholder="5,000,000" />
          </Field>
          <Field label="Issue date" required>
            <Input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
          </Field>
          <Field label="Original issue price" hint="Price per share paid in the round.">
            <Input value={form.originalIssuePrice} onChange={(e) => setForm({ ...form, originalIssuePrice: e.target.value })} placeholder="3.2145" />
          </Field>
          <Field label="Par value">
            <Input value={form.parValue} onChange={(e) => setForm({ ...form, parValue: e.target.value })} placeholder={PAR} />
          </Field>
        </FormGrid>
        <Field label="Certificate legend" hint="Printed in capitals on certificates of this class, under the standard securities-law legend. Company-wide terms live in Settings → Certificates.">
          <Textarea value={form.legend} onChange={(e) => setForm({ ...form, legend: e.target.value })} rows={2}
            placeholder="The shares are subject to a right of first refusal and co-sale agreement dated…" />
        </Field>

        {form.kind === 'PREFERRED' && (
          <>
            <div className="border-t border-ink-100 pt-4">
              <p className="mb-3 text-[13px] font-semibold text-ink-800">Liquidation terms</p>
              <FormGrid>
                <Field label="Seniority rank" hint="Higher ranks are paid first. Same rank shares pro-rata.">
                  <Input type="number" value={form.seniority} onChange={(e) => setForm({ ...form, seniority: e.target.value })} />
                </Field>
                <Field label="Liquidation multiple">
                  <Input value={form.liquidationMultiple} onChange={(e) => setForm({ ...form, liquidationMultiple: e.target.value })} placeholder="1" />
                </Field>
              </FormGrid>
              <Field label="Participation" className="mt-4">
                <Select value={form.participation} onChange={(e) => setForm({ ...form, participation: e.target.value })}>
                  {PARTICIPATION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
              {form.participation === 'CAPPED_PARTICIPATING' && (
                <Field label="Participation cap" hint="Total payout is capped at this multiple of the original issue price." className="mt-4">
                  <Input value={form.participationCap} onChange={(e) => setForm({ ...form, participationCap: e.target.value })} placeholder="2" />
                </Field>
              )}
            </div>

            <div className="border-t border-ink-100 pt-4">
              <p className="mb-3 text-[13px] font-semibold text-ink-800">Conversion, dividends and protection</p>
              <FormGrid>
                <Field label="Conversion ratio" hint="Common shares per preferred share.">
                  <Input value={form.conversionRatio} onChange={(e) => setForm({ ...form, conversionRatio: e.target.value })} />
                </Field>
                <Field label="Votes per share">
                  <Input value={form.votesPerShare} onChange={(e) => setForm({ ...form, votesPerShare: e.target.value })} />
                </Field>
                <Field label="Anti-dilution">
                  <Select value={form.antiDilution} onChange={(e) => setForm({ ...form, antiDilution: e.target.value })}>
                    {ANTI_DILUTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
                <Field label="Dividends">
                  <Select value={form.dividendType} onChange={(e) => setForm({ ...form, dividendType: e.target.value })}>
                    <option value="NONE">None</option>
                    <option value="NON_CUMULATIVE">Non-cumulative</option>
                    <option value="CUMULATIVE">Cumulative</option>
                  </Select>
                </Field>
                {form.dividendType !== 'NONE' && (
                  <Field label="Dividend rate (%)">
                    <Input value={form.dividendRate} onChange={(e) => setForm({ ...form, dividendRate: e.target.value })} placeholder="8" />
                  </Field>
                )}
              </FormGrid>
              <div className="mt-4 space-y-2">
                {form.dividendType === 'CUMULATIVE' && (
                  <Checkbox label="Dividends compound annually" checked={form.dividendCompounding}
                    onChange={(v) => setForm({ ...form, dividendCompounding: v })} />
                )}
                <Checkbox label="Pay-to-play provision" hint="Holders who do not participate in a future round lose preferred protections."
                  checked={form.payToPlay} onChange={(v) => setForm({ ...form, payToPlay: v })} />
              </div>
            </div>
          </>
        )}
      </FormModal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={crud.busy}
        title="Delete share class" confirmLabel="Delete"
        message={<>Delete <strong>{confirmDelete?.name}</strong>? This is only possible while no shares have been issued in the class.</>}
        onConfirm={async () => { if (await crud.remove(confirmDelete.id, 'Share class deleted')) setConfirmDelete(null); }} />
    </>
  );
}
