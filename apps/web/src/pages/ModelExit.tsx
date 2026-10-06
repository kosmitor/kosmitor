import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { api } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Table, TH, TD, TR, Badge, Button, Input, Field,
  Stat, ErrorNote, Banner, Checkbox, EmptyState, Loading, KeyValue, InfoDot, SegmentedControl,
} from '../ui.tsx';
import { PayoutCurve, PerShareCurve } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { money, shares, pps, percent, multiple, today, parseMoney, currencySymbol, RELATION_LABELS, amountHint } from '../format.ts';
import { config } from '../config.ts';

/** One-click exit values, in millions (modeling.exitPresetsMillions). */
const PRESETS = config.modeling.exitPresetsMillions;
/** Whole currency units the way the exit value field reads them back: digits grouped with commas. */
const grouped = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export default function ModelExit() {
  const { companyId, canViewAll } = useSession();
  const [exitValue, setExitValue] = useState(grouped(config.modeling.exitValue));
  const [fees, setFees] = useState('');
  const [escrow, setEscrow] = useState('');
  const [accelerate, setAccelerate] = useState(true);
  const [repayNotes, setRepayNotes] = useState(true);
  const [asOf, setAsOf] = useState(today());
  const [result, setResult] = useState<any>(null);
  const [breakpoints, setBreakpoints] = useState<any[]>([]);
  const [curve, setCurve] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [curveMode, setCurveMode] = useState<'class' | 'group'>('class');

  const run = async (override?: number) => {
    setRunning(true);
    setError(null);
    try {
      const value = override ?? parseMoney(exitValue);
      const res = await api(`/c/${companyId}/model/waterfall`, {
        body: {
          exitValue: value, asOf,
          transactionFees: parseMoney(fees || '0'),
          escrowHoldback: parseMoney(escrow || '0'),
          accelerateUnvested: accelerate, repayNotesAsDebt: repayNotes, points: 36,
        },
      });
      setResult(res.result);
      setBreakpoints(res.breakpoints ?? []);
      setCurve(res.curve ?? []);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally { setRunning(false); }
  };

  const curveData = useMemo(() => {
    if (curve.length === 0) return { data: [], keys: [] as string[] };
    const source = curveMode === 'class' ? 'byClass' : 'byGroup';
    const keys = [...new Set(curve.flatMap((p) => Object.keys(p[source] ?? {})))];
    const data = curve.map((p) => ({
      exitValue: p.exitValue,
      ...Object.fromEntries(keys.map((k) => [
        curveMode === 'group' ? (RELATION_LABELS[k] ?? k) : k,
        p[source]?.[k] ?? 0,
      ])),
    }));
    const labels = curveMode === 'group' ? keys.map((k) => RELATION_LABELS[k] ?? k) : keys;
    return { data, keys: labels };
  }, [curve, curveMode]);

  if (!canViewAll) return <EmptyState title="Exit modeling is not available for your role"
    description="Open My equity to model your own outcome instead." />;

  return (
    <>
      <PageHeader concept="exit-waterfall" title="Exit waterfall"
        subtitle="Who gets paid what, in what order, at any exit value"
        actions={<Button variant="primary" onClick={() => void run()} loading={running} icon={<Icon name="waterfall" />}>Run waterfall</Button>} />

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Exit assumptions" />
            <div className="space-y-4">
              <Field label="Exit value" hint="Total proceeds available to the company's securityholders.">
                <Input value={exitValue} onChange={(e) => setExitValue(e.target.value)} placeholder={`${currencySymbol()}${grouped(config.modeling.exitValue)}`} />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((m) => (
                  <button key={m} onClick={() => { setExitValue(grouped(m * 1_000_000)); void run(Math.round(m * 1_000_000 * 100)); }}
                    className="rounded-md bg-ink-100 px-2 py-1 text-[12px] font-medium text-ink-700 hover:bg-ink-200">
                    {currencySymbol()}{m}M
                  </button>
                ))}
              </div>
              <Field label="Transaction fees" hint="Banker and legal costs taken off the top.">
                <Input value={fees} onChange={(e) => setFees(e.target.value)} placeholder={amountHint(2_000_000)} />
              </Field>
              <Field label="Escrow holdback">
                <Input value={escrow} onChange={(e) => setEscrow(e.target.value)} placeholder={amountHint(5_000_000)} />
              </Field>
              <Field label="As of date">
                <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </Field>
              <div className="space-y-2 border-t border-ink-100 pt-3">
                <Checkbox label="Accelerate unvested equity" hint="Treats the transaction as a change of control triggering acceleration."
                  checked={accelerate} onChange={setAccelerate} />
                <Checkbox label="Repay convertible notes as debt" hint="Otherwise they are treated as having converted."
                  checked={repayNotes} onChange={setRepayNotes} />
              </div>
            </div>
          </Card>

          {breakpoints.length > 0 && (
            <Card>
              <CardHeader title="Breakpoints"
                subtitle="Exit values where the distribution changes shape" />
              <ul className="space-y-2">
                {breakpoints.slice(0, 10).map((b, i) => (
                  <li key={i}>
                    <button onClick={() => { setExitValue(grouped(b.exitValue / 100)); void run(b.exitValue); }}
                      className="flex w-full items-start gap-2.5 rounded-md p-1.5 text-left hover:bg-ink-50">
                      <Badge tone={b.kind === 'PREFERENCE' ? 'purple' : b.kind === 'CONVERSION' ? 'brand' : b.kind === 'CAP' ? 'warning' : 'neutral'}>
                        {b.kind === 'ZERO' ? 'off the top' : b.kind.toLowerCase()}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] leading-snug text-ink-700">{b.label}</span>
                        <span className="block text-[12px] font-medium tabular text-ink-900">{money(b.exitValue, { compact: true })}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {error && <ErrorNote error={error} />}

          {!result && !running && (
            <Card><EmptyState icon={<Icon name="waterfall" className="size-10" />}
              title="Model an exit"
              description="Preferences pay by seniority, participating classes take a second bite, and every non-participating class converts the moment converting beats its preference."
              action={<Button variant="primary" onClick={() => void run()}>Run waterfall</Button>} /></Card>
          )}

          {running && <Card><Loading label="Running the waterfall" /></Card>}

          {result && !running && (
            <>
              {result.warnings?.length > 0 && (
                <Banner tone="warning" title="Waterfall notes">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {result.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
                  </ul>
                </Banner>
              )}

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Distributable proceeds" value={money(result.distributable, { compact: true })}
                  hint={`${money(result.exitValue, { compact: true })} exit, less fees and debt`} />
                <Stat label="Preferences paid" value={money(result.totalPreferencesPaid, { compact: true })}
                  hint={result.convertibleCashOut > 0
                    ? `plus ${money(result.convertibleCashOut, { compact: true })} of SAFE and note cash-outs`
                    : `${percent(result.totalPreferencesPaid / (result.exitValue || 1))} of proceeds`} />
                <Stat label="Per common share" value={pps(result.perCommonShare)}
                  hint={`${shares(result.participatingShares)} shares participate`} />
                <Stat label="Options in the money" value={shares(result.optionsExercised)}
                  hint={result.optionsUnderwater > 0 ? `${shares(result.optionsUnderwater)} underwater and cancelled` : 'All options participate'}
                  tone={result.optionsUnderwater > 0 ? 'warning' : 'positive'} />
              </div>

              <Card padded={false}>
                <div className="p-5 pb-0">
                  <CardHeader title="Distribution by share class"
                    subtitle="Preferences pay by seniority; classes convert whenever converting beats taking the preference" />
                </div>
                <Table>
                  <thead>
                    <tr>
                      <TH>Class</TH><TH align="right">Shares</TH>
                      <TH align="right">Preference claim</TH><TH align="right">Preference paid</TH>
                      <TH align="right">Participation</TH><TH align="right">Total</TH>
                      <TH align="right">Per share</TH><TH align="right">Return</TH><TH>Outcome</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {result.classPayouts.map((c: any) => (
                      <TR key={c.shareClassId}>
                        <TD>
                          <span className="flex items-center gap-2">
                            <span className="font-medium">{c.name}</span>
                            {c.kind === 'PREFERRED' && <Badge tone="neutral">Rank {c.seniority}</Badge>}
                          </span>
                        </TD>
                        <TD align="right" mono>{shares(c.shares)}</TD>
                        <TD align="right" mono className="text-ink-600">{c.preferenceClaim ? money(c.preferenceClaim, { compact: true }) : '—'}</TD>
                        <TD align="right" mono>{c.preferencePaid ? money(c.preferencePaid, { compact: true }) : '—'}</TD>
                        <TD align="right" mono>{c.participation ? money(c.participation, { compact: true }) : '—'}</TD>
                        <TD align="right" mono className="font-semibold">{money(c.total, { compact: true })}</TD>
                        <TD align="right" mono>{pps(c.perShare)}</TD>
                        <TD align="right" mono className={c.multiple >= 1 ? 'text-secondary-800' : 'text-red-600'}>
                          {c.kind === 'COMMON' ? '—' : multiple(c.multiple)}
                        </TD>
                        <TD>
                          {c.kind === 'COMMON' ? <Badge tone="neutral">Common</Badge>
                            : c.converted ? <Badge tone="brand">Converted to common</Badge>
                            : c.cappedOut ? <Badge tone="warning">Participation capped</Badge>
                            : c.kind === 'PREFERRED' ? <Badge tone="purple">Took preference</Badge>
                            : <Badge tone="info">Cashed out</Badge>}
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Card>

              <Card padded={false}>
                <div className="p-5 pb-0">
                  <CardHeader title="Proceeds by stakeholder" subtitle="Net of the cost to exercise options and warrants" />
                </div>
                <Table>
                  <thead>
                    <tr>
                      <TH>Stakeholder</TH><TH>Relationship</TH>
                      <TH align="right">From preferred</TH><TH align="right">From common</TH>
                      <TH align="right">From options</TH><TH align="right">Other</TH>
                      <TH align="right">Total</TH><TH align="right">Invested</TH>
                      <TH align="right">Return</TH><TH align="right">% of exit</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stakeholderPayouts.map((p: any) => (
                      <TR key={p.stakeholderId}>
                        <TD className="font-medium">{p.name}</TD>
                        <TD><Badge tone="neutral">{RELATION_LABELS[p.relation] ?? p.relation}</Badge></TD>
                        <TD align="right" mono>{p.fromPreferred ? money(p.fromPreferred, { compact: true }) : '—'}</TD>
                        <TD align="right" mono>{p.fromCommon ? money(p.fromCommon, { compact: true }) : '—'}</TD>
                        <TD align="right" mono>{p.fromOptions ? money(p.fromOptions, { compact: true }) : '—'}</TD>
                        <TD align="right" mono className="text-ink-600">
                          {p.fromWarrants + p.fromRsus + p.fromConvertibles
                            ? money(p.fromWarrants + p.fromRsus + p.fromConvertibles, { compact: true }) : '—'}
                        </TD>
                        <TD align="right" mono className="font-semibold">{money(p.total, { compact: true })}</TD>
                        <TD align="right" mono className="text-ink-600">{p.invested ? money(p.invested, { compact: true }) : '—'}</TD>
                        <TD align="right" mono className={p.multiple >= 1 ? 'text-secondary-800' : 'text-red-600'}>
                          {p.invested > 100 ? multiple(p.multiple) : '—'}
                        </TD>
                        <TD align="right" mono>{percent(p.pctOfExit)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Card>

              {curveData.data.length > 0 && (
                <Card>
                  <CardHeader title="Payouts across exit values"
                    subtitle="How the split changes as the exit value moves"
                    action={<SegmentedControl size="sm" value={curveMode} onChange={setCurveMode} options={[
                      { value: 'class', label: 'By class' }, { value: 'group', label: 'By group' },
                    ]} />} />
                  <PayoutCurve data={curveData.data} keys={curveData.keys} />
                </Card>
              )}

              {curve.length > 0 && (
                <Card>
                  <CardHeader title="Value per common share"
                    subtitle="What a single common share is worth at each exit value" />
                  <PerShareCurve data={curve} />
                </Card>
              )}

              <Card>
                <CardHeader title={<>Order of payment<InfoDot text="This is the sequence the model applies to every exit value." /></>} />
                <KeyValue columns={2} items={[
                  { label: '1. Transaction fees', value: money(result.transactionFees) },
                  { label: '2. Escrow holdback', value: money(result.escrowHoldback) },
                  { label: '3. Debt repaid', value: money(result.debtRepaid) },
                  { label: '4. Liquidation preferences', value: money(result.totalPreferencesPaid) },
                  { label: '5. Residual to common and participating preferred', value: money(result.residualToCommon) },
                  { label: 'Option exercise proceeds added back', value: money(result.optionExerciseProceeds) },
                ]} />
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
