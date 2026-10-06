import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCrud, FormModal, FormGrid } from '../crud.tsx';
import { useSession } from '../session.tsx';
import { useQuery, downloadFile } from '../api.ts';
import {
  PageHeader, Card, Table, TH, TD, TR, Loading, ErrorNote, Button, Input, Field,
  Select, EmptyState, ConfirmDialog, StatusBadge, Checkbox, Badge, Modal, ActionMenu, useToast,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { SecurityDocuments } from '../SecurityDocuments.tsx';
import { PdfViewer } from '../PdfViewer.tsx';
import { readableDocumentPath, documentFilename, categoryLabel, documentAccess, downloadDocumentPath } from '../documents.ts';
import { shares, pps, money, date, dateTime, today, parseShares, parsePPS } from '../format.ts';

const blank = {
  stakeholderId: '', shareClassId: '', quantity: '', strikePrice: '',
  issueDate: today(), expirationDate: '', netExercise: true, notes: '', effectiveDate: '', reason: '',
};

export default function Warrants() {
  const { companyId, canEdit } = useSession();
  const navigate = useNavigate();
  const crud = useCrud<any>('warrants');
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const { data: classes } = useQuery<any[]>(companyId ? `/c/${companyId}/share-classes` : null, [companyId]);
  const { data: valuations } = useQuery<any[]>(companyId ? `/c/${companyId}/valuations` : null, [companyId]);
  const { data: documents, reload: reloadDocuments } = useQuery<any[]>(companyId ? `/c/${companyId}/documents` : null, [companyId]);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [exercising, setExercising] = useState<any>(null);
  const [exercise, setExercise] = useState({ quantity: '', exerciseDate: today(), method: 'CASH' });
  const [closing, setClosing] = useState<any>(null);
  const [close, setClose] = useState({ date: today(), reason: 'EXPIRED' });
  const toast = useToast();

  const nameOf = useMemo(() => new Map((stakeholders ?? []).map((s) => [s.id, s.name])), [stakeholders]);
  const classOf = useMemo(() => new Map((classes ?? []).map((c) => [c.id, c.name])), [classes]);
  const fmv = valuations?.find((v) => v.status === 'ACTIVE')?.fairMarketValue ?? 0;

  /**
   * The app writes no agreement of its own for a warrant, so anything filed
   * against one counts, whatever its category or status. All of them are named,
   * not just the newest: a warrant often carries the signed agreement and the
   * board consent together, and naming one would leave the other unreachable
   * from the table.
   */
  const filedOn = useMemo(() => {
    const byHolding = new Map<string, any[]>();
    for (const d of documents ?? []) {
      if (!d.securityId) continue;
      const held = byHolding.get(d.securityId);
      if (held) held.push(d); else byHolding.set(d.securityId, [d]);
    }
    return byHolding;
  }, [documents]);

  // An uploaded file that is not a PDF has no page to render, so it is handed over as a file.
  const download = (d: any) =>
    downloadFile(downloadDocumentPath(companyId!, d), documentFilename(d))
      .catch((err: Error) => toast(err.message, 'error'));

  const openNew = () => {
    setForm({ ...blank, stakeholderId: stakeholders?.[0]?.id ?? '', shareClassId: classes?.[0]?.id ?? '' });
    setEditing({ id: null });
  };
  const openEdit = (w: any) => {
    setForm({
      stakeholderId: w.stakeholderId, shareClassId: w.shareClassId, quantity: String(w.quantity),
      strikePrice: String(w.strikePrice / 1e6), issueDate: w.issueDate,
      expirationDate: w.expirationDate ?? '', netExercise: !!w.netExercise, notes: w.notes ?? '', effectiveDate: w.issueDate, reason: '',
    });
    setEditing(w);
  };
  /** A warrant whose holder, class or issue date is being changed: a correction that needs a reason. */
  const retyped = !!editing?.id
    && (form.stakeholderId !== editing.stakeholderId || form.shareClassId !== editing.shareClassId || form.issueDate !== editing.issueDate);

  const save = async () => {
    const payload = {
      stakeholderId: form.stakeholderId, shareClassId: form.shareClassId,
      quantity: parseShares(form.quantity), strikePrice: parsePPS(form.strikePrice),
      issueDate: form.issueDate, expirationDate: form.expirationDate || null,
      netExercise: form.netExercise, notes: form.notes || null,
    };
    const ok = editing?.id
      // A changed share count is a correction, dated in the ledger (docs/design/dated-ledger.md).
      ? await crud.update(editing.id, { ...payload, effectiveDate: form.effectiveDate || form.issueDate, reason: form.reason || undefined }, 'Warrant updated')
      : await crud.create(payload, 'Warrant issued');
    if (ok) setEditing(null);
  };

  // Each is a dated event in the ledger, so past views still show the warrant as it stood.
  const doExercise = async () => {
    const ok = await crud.action(`warrants/${exercising.id}/exercise`,
      { quantity: parseShares(exercise.quantity), exerciseDate: exercise.exerciseDate, method: exercise.method }, 'Warrant exercised and shares issued');
    if (ok) setExercising(null);
  };
  const doClose = async () => {
    const ok = await crud.action(`warrants/${closing.id}/cancel`, { date: close.date, reason: close.reason },
      close.reason === 'EXPIRED' ? 'Warrant expired' : 'Warrant cancelled');
    if (ok) setClosing(null);
  };

  if (crud.loading) return <Loading label="Loading warrants" />;
  if (crud.error) return <ErrorNote error={crud.error} onRetry={crud.reload} />;

  const total = crud.items.filter((w) => w.status === 'OUTSTANDING')
    .reduce((s, w) => s + (w.quantity - w.exercisedQuantity), 0);

  return (
    <>
      <PageHeader concept="warrants" title="Warrants" subtitle={`${shares(total)} shares under outstanding warrants`}
        actions={canEdit && <Button variant="primary" icon={<Icon name="plus" />} onClick={openNew}>Issue warrant</Button>} />

      <Card padded={false}>
        {crud.items.length === 0 ? (
          <EmptyState title="No warrants"
            description="Warrants are usually issued alongside venture debt or to strategic partners."
            action={canEdit && <Button variant="primary" onClick={openNew}>Issue warrant</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Holder</TH><TH>Class</TH>
                <TH align="right">Shares</TH><TH align="right">Exercised</TH>
                <TH align="right">Strike</TH><TH align="right">Intrinsic value</TH>
                <TH>Issued</TH><TH>Expires</TH><TH>Exercise</TH><TH>Status</TH>
                <TH width={90} />
              </tr>
            </thead>
            <tbody>
              {crud.items.map((w) => {
                const outstanding = w.quantity - w.exercisedQuantity;
                const intrinsic = Math.max(0, Math.round((outstanding * (fmv - w.strikePrice)) / 1e4));
                const filed = filedOn.get(w.id) ?? [];
                return (
                  <TR key={w.id}>
                    <TD>
                      {/* A warrant carries no number of its own, so the row menu is what
                          opens it and the name keeps going to the person. */}
                      <Link to={`/stakeholders/${w.stakeholderId}`} className="font-medium hover:text-brand-700">
                        {nameOf.get(w.stakeholderId) ?? '—'}
                      </Link>
                    </TD>
                    <TD><Badge tone="purple">{classOf.get(w.shareClassId) ?? '—'}</Badge></TD>
                    <TD align="right" mono>{shares(w.quantity)}</TD>
                    <TD align="right" mono className="text-ink-600">{w.exercisedQuantity ? shares(w.exercisedQuantity) : '—'}</TD>
                    <TD align="right" mono>{pps(w.strikePrice)}</TD>
                    <TD align="right" mono className={intrinsic > 0 ? 'text-secondary-800' : 'text-ink-400'}>
                      {intrinsic > 0 ? money(intrinsic, { compact: true }) : 'Underwater'}
                    </TD>
                    <TD className="text-ink-600">{date(w.issueDate)}</TD>
                    <TD className="text-ink-600">{w.expirationDate ? date(w.expirationDate) : '—'}</TD>
                    <TD className="text-[12px] text-ink-600">{w.netExercise ? 'Net exercise' : 'Cash'}</TD>
                    <TD>
                      <StatusBadge status={w.status} />
                      {filed.map((d) => {
                        const access = documentAccess(companyId!, d);
                        // A document that is neither a file nor text has nothing behind it,
                        // so it is named but not offered as something that can be opened.
                        return access === 'none' ? (
                          <span key={d.id} className="mt-1 block max-w-[13rem] truncate text-[11px] text-ink-500" title={d.name}>
                            {d.name}
                          </span>
                        ) : (
                          <button key={d.id} className="mt-1 block max-w-[13rem] truncate text-left text-[11px] text-brand-600 hover:text-brand-700"
                            title={access === 'read' ? `Read ${d.name}` : `Download ${d.name}`}
                            onClick={() => { if (access === 'read') setReading(d); else void download(d); }}>
                            {d.name}
                          </button>
                        );
                      })}
                    </TD>
                    {/* The paperwork is worth reading whether or not you may change anything,
                        so the menu is here for every role and only its edits are gated. */}
                    <TD align="right">
                      <span className="flex flex-nowrap items-center justify-end gap-1">
                        {canEdit && (
                          <Button size="sm" variant="ghost" onClick={() => openEdit(w)} aria-label="Edit" title="Edit">
                            <Icon name="edit" className="size-4" />
                          </Button>
                        )}
                        <ActionMenu items={[
                          { label: 'Open the warrant', icon: 'ticket', onClick: () => navigate(`/warrants/${w.id}`) },
                          { label: 'Documents', icon: 'document', onClick: () => setDocumentsFor(w) },
                          ...(canEdit && w.status === 'OUTSTANDING' ? [
                            { label: 'Exercise the warrant', icon: 'convert' as const,
                              onClick: () => { setExercise({ quantity: String(outstanding), exerciseDate: today(), method: 'CASH' }); setExercising(w); } },
                            { label: 'Cancel or expire', icon: 'trash' as const, danger: true,
                              onClick: () => { setClose({ date: w.expirationDate && w.expirationDate <= today() ? w.expirationDate : today(), reason: 'EXPIRED' }); setClosing(w); } },
                          ] : []),
                          ...(canEdit ? [{ label: 'Delete the warrant', icon: 'trash' as const, danger: true, onClick: () => setConfirmDelete(w) }] : []),
                        ]} />
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <FormModal open={!!editing} onClose={() => setEditing(null)} busy={crud.busy}
        title={editing?.id ? 'Edit warrant' : 'Issue warrant'} onSubmit={save}
        submitLabel={editing?.id ? 'Save changes' : 'Issue warrant'}
        description="Warrants count toward fully diluted shares and participate in an exit whenever they are in the money.">
        <FormGrid>
          <Field label="Holder" required>
            <Select value={form.stakeholderId} onChange={(e) => setForm({ ...form, stakeholderId: e.target.value })} required>
              <option value="">Select a stakeholder</option>
              {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Share class" required>
            <Select value={form.shareClassId} onChange={(e) => setForm({ ...form, shareClassId: e.target.value })} required>
              {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Number of shares" required>
            <Input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="50,000" required />
          </Field>
          {editing?.id && parseShares(form.quantity) !== Number(editing.quantity) && (
            <Field label="Correct from" hint="The ledger dates the change. Keep the issue date if the old count was always wrong.">
              <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
            </Field>
          )}
          {retyped && (
            <Field label="Reason for the correction" required hint="A changed holder, class or issue date says the record was always wrong, on every date.">
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Entered against the wrong holder" required />
            </Field>
          )}
          <Field label="Strike price" required>
            <Input value={form.strikePrice} onChange={(e) => setForm({ ...form, strikePrice: e.target.value })} placeholder="3.2145" required />
          </Field>
          <Field label="Issue date" required>
            <Input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} required />
          </Field>
          <Field label="Expiration date">
            <Input type="date" value={form.expirationDate} onChange={(e) => setForm({ ...form, expirationDate: e.target.value })} />
          </Field>
        </FormGrid>
        <Checkbox label="Net (cashless) exercise permitted" checked={form.netExercise}
          onChange={(v) => setForm({ ...form, netExercise: v })} />
      </FormModal>

      <FormModal open={!!exercising} onClose={() => setExercising(null)} busy={crud.busy} title="Exercise warrant" submitLabel="Record exercise" onSubmit={doExercise}
        description="Issues the shares to the holder and records a dated exercise in the ledger.">
        {exercising && (
          <FormGrid>
            <Field label="Shares to exercise" required hint={`${shares(exercising.quantity - exercising.exercisedQuantity)} remain under this warrant.`}>
              <Input value={exercise.quantity} onChange={(e) => setExercise({ ...exercise, quantity: e.target.value })} required />
            </Field>
            <Field label="Exercise date" required>
              <Input type="date" value={exercise.exerciseDate} onChange={(e) => setExercise({ ...exercise, exerciseDate: e.target.value })} required />
            </Field>
            <Field label="Method">
              <Select value={exercise.method} onChange={(e) => setExercise({ ...exercise, method: e.target.value })}>
                <option value="CASH">Cash</option>
                {!!exercising.netExercise && <option value="NET_EXERCISE">Net exercise</option>}
              </Select>
            </Field>
          </FormGrid>
        )}
      </FormModal>

      <FormModal open={!!closing} onClose={() => setClosing(null)} busy={crud.busy} danger title="Cancel or expire warrant" submitLabel="Record" onSubmit={doClose}
        description="Closes what remains of the warrant as of a date. The ledger records it, so views of earlier dates still show the warrant.">
        <FormGrid>
          <Field label="What happened">
            <Select value={close.reason} onChange={(e) => setClose({ ...close, reason: e.target.value })}>
              <option value="EXPIRED">It expired</option>
              <option value="CANCELLED">It was cancelled</option>
            </Select>
          </Field>
          <Field label="Date" required>
            <Input type="date" value={close.date} onChange={(e) => setClose({ ...close, date: e.target.value })} required />
          </Field>
        </FormGrid>
      </FormModal>

      {/* Closing the dialog is when anything just attached should reach the row behind it. */}
      <Modal open={!!documentsFor} onClose={() => { setDocumentsFor(null); reloadDocuments(); }} size="lg" title="Documents"
        description={documentsFor
          ? `Filed against the warrant held by ${nameOf.get(documentsFor.stakeholderId) ?? 'this holder'}.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} securityId={documentsFor.id} stakeholderId={documentsFor.stakeholderId} />
        )}
      </Modal>

      <PdfViewer open={!!reading} onClose={() => setReading(null)} title={reading?.name ?? 'Document'}
        description={reading ? `${categoryLabel(reading.category)} · added ${dateTime(reading.createdAt)}` : undefined}
        path={reading ? readableDocumentPath(companyId!, reading) : null}
        filename={reading ? documentFilename(reading) : 'document.pdf'} />

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} danger loading={crud.busy}
        title="Delete warrant" confirmLabel="Delete" message="This removes the warrant from the fully diluted cap table."
        onConfirm={async () => { if (await crud.remove(confirmDelete.id, 'Warrant deleted')) setConfirmDelete(null); }} />
    </>
  );
}
