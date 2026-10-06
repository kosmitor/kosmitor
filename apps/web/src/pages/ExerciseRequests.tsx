import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import { Card, Table, TH, TD, TR, Badge, ErrorNote, EmptyState, Button, Input, Field, Modal, StatusBadge, SegmentedControl, useToast, Banner } from '../ui.tsx';
import { money, shares, pps, date, dateTime } from '../format.ts';
import { useScrollToHash } from '../hooks.ts';

type Filter = 'OPEN' | 'ALL';
type Action = 'approve' | 'reject' | 'mark-paid' | 'complete';

const METHOD_LABELS: Record<string, string> = { CASH: 'Cash', NET_EXERCISE: 'Net exercise', CASHLESS: 'Cashless', PROMISSORY_NOTE: 'Promissory note' };
const TITLES: Record<Action, string> = { approve: 'Approve exercise request', reject: 'Reject exercise request', 'mark-paid': 'Record payment', complete: 'Complete the exercise' };
const OPEN_STATUSES = ['REQUESTED', 'APPROVED', 'PAID'];

/**
 * Exercise requests that option holders raised from My equity, for the company
 * to approve, record payment for and complete. Rendered on Equity awards, and
 * hidden while the feature is off and nothing was ever requested.
 */
export default function ExerciseRequests() {
  const { companyId, canViewAll, canEdit } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/exercise-requests` : null, [companyId]);
  useScrollToHash(!!data); // /grants#exercise-requests from the search palette lands on this section
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [acting, setActing] = useState<{ request: any; action: Action } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!canViewAll || (loading && !data)) return null;
  if (error) return <div className="mt-5"><ErrorNote error={error} onRetry={reload} /></div>;
  if (!data) return null;

  const requests: any[] = data.requests;
  if (!data.enabled && requests.length === 0) return null;
  const open = requests.filter((r) => OPEN_STATUSES.includes(r.status));
  const rows = filter === 'OPEN' ? open : requests;

  const start = (request: any, action: Action) => { setNote(''); setActing({ request, action }); };

  const act = async () => {
    if (!acting) return;
    setBusy(true);
    try {
      const body = acting.action === 'mark-paid' ? { paymentReference: note || null }
        : acting.action === 'complete' ? { exerciseDate: note || undefined }
        : { adminNote: note || null };
      await api(`/c/${companyId}/exercise-requests/${acting.request.id}/${acting.action}`, { body });
      toast({ approve: 'Approved — the holder can pay now', reject: 'Request rejected', 'mark-paid': 'Payment recorded', complete: 'Exercise recorded and shares issued' }[acting.action]);
      setActing(null);
      setNote('');
      reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <section id="exercise-requests" className="mt-5 scroll-mt-16">
      {!data.paymentInstructions && data.enabled && (
        <div className="mb-5">
          <Banner tone="info" title="Tell holders how to pay">
            Approved requests show the holder your payment instructions. Add them in <Link className="font-medium underline" to="/company#exercise-requests">Company → Exercise requests</Link>.
          </Banner>
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 p-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink-900">Exercise requests</h2>
            <p className="text-[12px] text-ink-500">
              {data.enabled ? 'Holders request from My equity; each request lands here for review.' : 'Turned off in Settings; earlier requests stay on record.'}
            </p>
          </div>
          <SegmentedControl value={filter} onChange={setFilter} options={[{ value: 'OPEN', label: `Open (${open.length})` }, { value: 'ALL', label: `All (${requests.length})` }]} />
        </div>
        {rows.length === 0 ? <EmptyState title={filter === 'OPEN' ? 'No open requests' : 'No exercise requests yet'} description="Option holders request exercises from My equity; each request lands here for review." /> : (
          <Table>
            <thead>
              <tr><TH>Requested</TH><TH>Holder</TH><TH>Grant</TH><TH align="right">Options</TH><TH>Method</TH><TH align="right">Exercise price</TH><TH align="right">Spread at FMV</TH><TH>Status</TH>{canEdit && <TH width={260} />}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="text-ink-600">{dateTime(r.requestedAt)}</TD>
                  <TD><Link to={`/stakeholders/${r.stakeholderId}`} className="font-medium hover:text-brand-700">{r.stakeholderName}</Link>{r.note && <span className="block max-w-xs truncate text-[11px] text-ink-500" title={r.note}>“{r.note}”</span>}</TD>
                  <TD><span className="font-medium">{r.awardLabel ?? '—'}</span> <Badge tone="neutral" className="ml-1">{r.awardType}</Badge></TD>
                  <TD align="right" mono>{shares(r.quantity)}</TD>
                  <TD className="text-ink-600">{METHOD_LABELS[r.method] ?? r.method}</TD>
                  <TD align="right" mono>{money(r.estimatedCost)}<span className="block text-[11px] text-ink-500">{pps(r.strikePrice)} / share</span></TD>
                  <TD align="right" mono className="text-ink-600">{money(r.spread)}</TD>
                  <TD>
                    <StatusBadge status={r.status === 'APPROVED' ? 'PENDING' : r.status} />
                    <span className="block text-[11px] text-ink-500">
                      {r.status === 'APPROVED' && 'Awaiting payment'}{r.status === 'PAID' && `Paid${r.paymentReference ? ` · ${r.paymentReference}` : ''}`}
                      {r.status === 'COMPLETED' && r.completedAt && `Recorded ${date(String(r.completedAt).slice(0, 10))}`}{r.status === 'REJECTED' && r.adminNote && r.adminNote}
                    </span>
                  </TD>
                  {canEdit && (
                    <TD align="right">
                      <span className="flex flex-wrap justify-end gap-1">
                        {r.status === 'REQUESTED' && <Button size="sm" variant="primary" onClick={() => start(r, 'approve')}>Approve</Button>}
                        {r.status === 'APPROVED' && <Button size="sm" variant="primary" onClick={() => start(r, 'mark-paid')}>Mark paid</Button>}
                        {(r.status === 'PAID' || r.status === 'APPROVED') && <Button size="sm" onClick={() => start(r, 'complete')}>Record exercise</Button>}
                        {OPEN_STATUSES.includes(r.status) && <Button size="sm" variant="ghost" onClick={() => start(r, 'reject')}>Reject</Button>}
                      </span>
                    </TD>
                  )}
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!acting} onClose={() => setActing(null)} title={acting ? TITLES[acting.action] : ''} size="sm"
        description={acting ? `${acting.request.stakeholderName} · ${shares(acting.request.quantity)} options of ${acting.request.awardLabel ?? 'the grant'} · ${money(acting.request.estimatedCost)} exercise price` : undefined}
        footer={<>
          <Button onClick={() => setActing(null)}>Cancel</Button>
          <Button variant={acting?.action === 'reject' ? 'danger' : 'primary'} loading={busy} onClick={() => void act()}>{acting ? TITLES[acting.action].split(' ')[0] : 'Confirm'}</Button>
        </>}>
        {acting?.action === 'approve' && <Field label="Note to the holder" hint="Shown with your payment instructions."><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field>}
        {acting?.action === 'reject' && <Field label="Reason" required><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Blackout period until…" /></Field>}
        {acting?.action === 'mark-paid' && <Field label="Payment reference" hint="Wire confirmation, cheque number…"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field>}
        {acting?.action === 'complete' && <Field label="Exercise date" hint="Defaults to today. Shares are issued and the ledger written on this date."><Input type="date" value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
      </Modal>
    </section>
  );
}
