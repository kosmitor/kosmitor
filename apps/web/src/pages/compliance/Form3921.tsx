import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../session.tsx';
import { useQuery, api, downloadFile } from '../../api.ts';
import { Card, CardHeader, Table, TH, TD, TR, Loading, ErrorNote, EmptyState, Stat, Banner, Button, Input, Field, Select, Modal, KeyValue, useToast } from '../../ui.tsx';
import { Icon } from '../../icons.tsx';
import { shares, date, pps, money, relativeDate } from '../../format.ts';
import { SecurityDocuments } from '../../SecurityDocuments.tsx';
import { StatusBadge } from './shared.tsx';

/** Form 3921 — one per ISO exercise per tax year: Copy B to the employee, Copy A to the IRS. */
export default function Form3921() {
  const { companyId, canViewAll, canEdit } = useSession();
  const toast = useToast();
  const [year, setYear] = useState<string>('');
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/compliance/form-3921${year ? `?year=${year}` : ''}` : null, [companyId, year]);
  const [recording, setRecording] = useState(false);
  const [documentsFor, setDocumentsFor] = useState<any>(null);
  const [form, setForm] = useState({ filedOn: '', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);

  if (!canViewAll) return <EmptyState title="Compliance is not available for your role" />;
  if (loading && !data) return <Loading label="Collecting ISO exercises" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const record = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/compliance/filings`, { body: { kind: 'FORM_3921', period: String(data.year), filedOn: form.filedOn, reference: form.reference || null, notes: form.notes || null } });
      toast(`Form 3921 for ${data.year} recorded as filed`);
      setRecording(false);
      setForm({ filedOn: '', reference: '', notes: '' });
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const unrecord = async () => {
    setBusy(true);
    try {
      await api(`/c/${companyId}/compliance/filings/${data.filing.id}`, { method: 'DELETE' });
      toast('Filing record removed');
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const years: any[] = data.statuses;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Field label="Tax year" className="w-40">
          <Select value={String(data.year)} onChange={(e) => setYear(e.target.value)}>
            {years.map((s) => <option key={s.year} value={s.year}>{s.year}{s.count ? ` · ${s.count} exercise${s.count === 1 ? '' : 's'}` : ''}</option>)}
          </Select>
        </Field>
        <Button icon={<Icon name="download" />} disabled={data.rows.length === 0}
          onClick={() => downloadFile(`/c/${companyId}/compliance/form-3921.csv?year=${data.year}`, `form-3921-${data.year}.csv`).catch((e: Error) => toast(e.message, 'error'))}>
          Export {data.year} CSV
        </Button>
        <Button disabled={data.rows.length === 0} onClick={() => window.open(`/api/c/${companyId}/compliance/form-3921/${data.year}/statements`, '_blank', 'noopener')}>
          Employee statements
        </Button>
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={`ISO exercises in ${data.year}`} value={String(data.count)} hint={data.count === 0 ? 'No forms to file for this year' : `${data.count} form${data.count === 1 ? '' : 's'} to furnish and file`} />
        <Stat label="Copy B to employees by" value={date(data.deadlines.furnish)} hint={relativeDate(data.deadlines.furnish)} tone={data.state === 'OVERDUE' ? 'negative' : data.state === 'DUE' ? 'warning' : 'default'} />
        <Stat label="Copy A to the IRS by" value={date(data.deadlines.fileElectronic)} hint={`${date(data.deadlines.filePaper)} on paper`} tone={data.state === 'OVERDUE' ? 'negative' : data.state === 'DUE' ? 'warning' : 'default'} />
        <Card>
          <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Status</p>
          <div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={data.state} />
            {data.filing && <span className="text-[12px] text-ink-500">on {date(data.filing.filedOn)}{data.filing.reference ? ` · ${data.filing.reference}` : ''}</span>}
          </div>
          {canEdit && data.count > 0 && (
            <div className="mt-3">
              {data.filing
                ? <Button size="sm" loading={busy} onClick={() => void unrecord()}>Remove filing record</Button>
                : <Button size="sm" variant="primary" onClick={() => setRecording(true)}>Record as filed</Button>}
            </div>
          )}
        </Card>
      </div>

      <div className="mb-5">
        <Banner tone="info" title="What the form reports">
          Section 6039 requires a Form 3921 for every transfer of stock on the exercise of an incentive stock option: the grant date, the exercise
          date, the exercise price, the fair market value on the exercise date and the number of shares. The employee needs it for the alternative
          minimum tax; the IRS matches it against later sales. Electronic filing is mandatory from 10 information returns a year. Non-qualified options
          and RSUs are reported on the W-2 instead and never appear here.
        </Banner>
      </div>

      <Card padded={false}>
        <div className="p-5 pb-0"><CardHeader title={`Exercises in ${data.year}`} subtitle="One form per row — the box numbers follow the IRS form" /></div>
        {data.rows.length === 0 ? (
          <EmptyState title={`No ISO exercises in ${data.year}`} description="Exercises recorded on the Equity awards page appear here in the year they happen." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Employee</TH><TH>Grant</TH><TH>Box 1 · Granted</TH><TH>Box 2 · Exercised</TH>
                <TH align="right">Box 3 · Exercise price</TH><TH align="right">Box 4 · FMV at exercise</TH><TH align="right">Box 5 · Shares</TH><TH align="right">Spread</TH><TH width={56} />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <TR key={r.exerciseId}>
                  <TD><span className="block font-medium">{r.stakeholderName}</span>{!r.address && <span className="block text-[11px] text-amber-700">No address on record</span>}</TD>
                  {/* One row is one exercise of one grant, so the grant is what it opens. */}
                  <TD>
                    <Link to={`/grants/${r.awardId}`}
                      className="cursor-pointer text-left font-medium text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-400">
                      {r.awardLabel ?? String(r.awardId).slice(-6).toUpperCase()}
                    </Link>
                  </TD>
                  <TD className="text-ink-600">{date(r.grantDate)}</TD>
                  <TD className="text-ink-600">{date(r.exerciseDate)}</TD>
                  <TD align="right" mono>{pps(r.exercisePrice)}</TD>
                  <TD align="right" mono>{pps(r.fmvAtExercise)}</TD>
                  <TD align="right" mono>{shares(r.quantity)}</TD>
                  <TD align="right" mono className="text-ink-600">{money(r.spread)}</TD>
                  {/* The form reports an exercise of a grant that exists, so the copies
                      and the receipts are filed against that grant. */}
                  <TD align="right">
                    <Button size="sm" variant="ghost" onClick={() => setDocumentsFor(r)}
                      aria-label={`Documents for ${r.stakeholderName}'s grant`} title={`Documents for ${r.stakeholderName}'s grant`}>
                      <Icon name="document" className="size-4" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {years.length > 1 && (
        <Card className="mt-5">
          <CardHeader title="All years" />
          <KeyValue columns={3} items={years.map((s) => ({
            label: String(s.year),
            value: <span className="flex items-center gap-2"><StatusBadge status={s.state} /><span className="text-[12px] text-ink-500">{s.count} exercise{s.count === 1 ? '' : 's'}</span></span>,
          }))} />
        </Card>
      )}

      <Modal open={!!documentsFor} onClose={() => setDocumentsFor(null)} size="lg"
        title={documentsFor ? `Form 3921 documents for ${documentsFor.awardLabel ?? 'the grant'}` : 'Documents'}
        description={documentsFor
          ? `Filed against grant ${documentsFor.awardLabel ?? String(documentsFor.awardId).slice(-6).toUpperCase()}, held by ${documentsFor.stakeholderName}. The same documents appear on the grant and on every exercise of it.`
          : undefined}>
        {documentsFor && (
          <SecurityDocuments framed={false} securityId={documentsFor.awardId} stakeholderId={documentsFor.stakeholderId} />
        )}
      </Modal>

      <Modal open={recording} onClose={() => setRecording(false)} title={`Record Form 3921 filing for ${data.year}`} size="sm"
        description={`${data.count} form${data.count === 1 ? '' : 's'}: Copy B furnished to employees and Copy A filed with the IRS.`}>
        <div className="space-y-4">
          <Field label="Filed on" required><Input type="date" value={form.filedOn} onChange={(e) => setForm({ ...form, filedOn: e.target.value })} required /></Field>
          <Field label="Reference" hint="IRIS or FIRE receipt, filing service confirmation…"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRecording(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!form.filedOn} onClick={() => void record()}>Record filing</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
