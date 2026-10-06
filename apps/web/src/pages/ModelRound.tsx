import { useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Table, TH, TD, TR, Badge, Button, Input, Field, Select,
  Stat, ErrorNote, Banner, Checkbox, EmptyState, Loading, useToast, KeyValue, InfoDot, Spinner,
} from '../ui.tsx';
import { DilutionBars } from '../charts.tsx';
import { Icon } from '../icons.tsx';
import { money, shares, pps, percent, date, today, parseMoney, parsePercent, currencySymbol, INSTRUMENT_LABELS, amountHint } from '../format.ts';
import { config } from '../config.ts';

/** The round a new model starts from (modeling in the param file). */
const MODEL = config.modeling;
/** Whole currency units the way the money fields read them back: digits grouped with commas. */
const grouped = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

interface InvestorRow { id: number; name: string; stakeholderId: string; amount: string }

export default function ModelRound() {
  const { companyId, canViewAll, canEdit } = useSession();
  const toast = useToast();
  const { data: stakeholders } = useQuery<any[]>(companyId ? `/c/${companyId}/stakeholders` : null, [companyId]);
  const { data: convertibles } = useQuery<any[]>(companyId ? `/c/${companyId}/convertibles` : null, [companyId]);
  const { data: saved, reload: reloadSaved } = useQuery<any[]>(companyId ? `/c/${companyId}/scenarios` : null, [companyId]);

  const [name, setName] = useState(MODEL.roundName);
  const [closeDate, setCloseDate] = useState(today());
  const [valuationMode, setValuationMode] = useState<'pre' | 'post'>('pre');
  const [valuation, setValuation] = useState(grouped(MODEL.preMoneyValuation));
  const [investors, setInvestors] = useState<InvestorRow[]>([
    { id: 1, name: 'New lead investor', stakeholderId: '', amount: grouped(MODEL.leadInvestment) },
  ]);
  const [targetPoolPct, setTargetPoolPct] = useState(String(MODEL.targetPoolPercent));
  const [poolFromPreMoney, setPoolFromPreMoney] = useState(true);
  const [convertConvertibles, setConvertConvertibles] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [antiDilution, setAntiDilution] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const totalRaise = useMemo(
    () => investors.reduce((s, i) => s + parseMoney(i.amount), 0), [investors]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const body = {
        name, closeDate,
        preMoney: valuationMode === 'pre' ? parseMoney(valuation) : undefined,
        postMoney: valuationMode === 'post' ? parseMoney(valuation) : undefined,
        investors: investors.filter((i) => parseMoney(i.amount) > 0).map((i) => ({
          name: i.name || 'Investor', stakeholderId: i.stakeholderId || null, amount: parseMoney(i.amount),
        })),
        targetPoolPct: parsePercent(targetPoolPct || '0'),
        poolFromPreMoney, convertConvertibles,
      };
      const res = await api(`/c/${companyId}/model/round`, { body });
      setResult(res.result);
      setAntiDilution(res.antiDilution ?? []);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally { setRunning(false); }
  };

  const saveScenario = async () => {
    try {
      await api(`/c/${companyId}/scenarios`, {
        body: {
          name, type: 'ROUND',
          payload: { name, closeDate, valuationMode, valuation, investors, targetPoolPct, poolFromPreMoney, convertConvertibles },
        },
      });
      toast('Scenario saved');
      reloadSaved();
    } catch (err) { toast((err as Error).message, 'error'); }
  };

  const loadScenario = (s: any) => {
    const p = s.payload;
    setName(p.name ?? s.name); setCloseDate(p.closeDate ?? today());
    setValuationMode(p.valuationMode ?? 'pre'); setValuation(p.valuation ?? '');
    setInvestors(p.investors ?? []); setTargetPoolPct(p.targetPoolPct ?? '0');
    setPoolFromPreMoney(p.poolFromPreMoney !== false);
    setConvertConvertibles(p.convertConvertibles !== false);
    setResult(null);
  };

  if (!canViewAll) return <EmptyState title="Round modeling is not available for your role"
    description="Ask an administrator for broader access." />;

  const liveConvertibles = (convertibles ?? []).filter((c) => c.status === 'OUTSTANDING');

  return (
    <>
      <PageHeader concept="round-modeling" title="Round modeling"
        subtitle="Price a round, refresh the option pool and convert the SAFE stack"
        actions={
          <>
            {canEdit && result && <Button onClick={saveScenario} icon={<Icon name="copy" />}>Save scenario</Button>}
            <Button variant="primary" onClick={run} loading={running} icon={<Icon name="sparkle" />}>Run model</Button>
          </>
        } />

      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Round terms" />
            <div className="space-y-4">
              <Field label="Round name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={MODEL.roundName} />
              </Field>
              <Field label="Closing date">
                <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
              </Field>
              <Field label="Valuation">
                <div className="flex gap-2">
                  <Select value={valuationMode} onChange={(e) => setValuationMode(e.target.value as 'pre' | 'post')} className="w-28">
                    <option value="pre">Pre-money</option>
                    <option value="post">Post-money</option>
                  </Select>
                  <Input value={valuation} onChange={(e) => setValuation(e.target.value)} placeholder={`${currencySymbol()}${grouped(MODEL.preMoneyValuation)}`} />
                </div>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Investors" subtitle={`${money(totalRaise, { compact: true })} total`}
              action={
                <Button size="sm" variant="ghost" icon={<Icon name="plus" className="size-3.5" />}
                  onClick={() => setInvestors([...investors, { id: Date.now(), name: '', stakeholderId: '', amount: '' }])}>
                  Add
                </Button>
              } />
            <div className="space-y-3">
              {investors.map((inv, idx) => (
                <div key={inv.id} className="rounded-lg border border-ink-200 p-3">
                  <div className="flex items-center gap-2">
                    <Input value={inv.name} placeholder="Investor name" className="flex-1"
                      onChange={(e) => setInvestors(investors.map((x) => x.id === inv.id ? { ...x, name: e.target.value } : x))} />
                    {investors.length > 1 && (
                      <Button size="sm" variant="ghost" aria-label="Remove"
                        onClick={() => setInvestors(investors.filter((x) => x.id !== inv.id))}>
                        <Icon name="trash" className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Select value={inv.stakeholderId} className="flex-1"
                      onChange={(e) => {
                        const sh = (stakeholders ?? []).find((s) => s.id === e.target.value);
                        setInvestors(investors.map((x) => x.id === inv.id
                          ? { ...x, stakeholderId: e.target.value, name: sh?.name ?? x.name } : x));
                      }}>
                      <option value="">New investor</option>
                      {(stakeholders ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                    <Input value={inv.amount} placeholder={amountHint(5_000_000)} className="w-36"
                      onChange={(e) => setInvestors(investors.map((x) => x.id === inv.id ? { ...x, amount: e.target.value } : x))} />
                  </div>
                  {idx === 0 && <p className="mt-2 text-[11px] text-ink-500">Link to an existing stakeholder to model their follow-on.</p>}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Option pool" />
            <Field label="Target pool after closing (%)"
              hint="The model solves for the top-up that leaves this much unallocated.">
              <Input value={targetPoolPct} onChange={(e) => setTargetPoolPct(e.target.value)} placeholder={String(MODEL.targetPoolPercent)} />
            </Field>
            <div className="mt-3">
              <Checkbox
                label="Pool comes out of the pre-money"
                hint="The standard pool shuffle: the increase dilutes existing holders only, not the new investors."
                checked={poolFromPreMoney} onChange={setPoolFromPreMoney} />
            </div>
          </Card>

          {liveConvertibles.length > 0 && (
            <Card>
              <CardHeader title="Convertibles" subtitle={`${liveConvertibles.length} outstanding`} />
              <Checkbox label="Convert SAFEs and notes in this round"
                hint="Instruments below their qualified financing minimum will not convert."
                checked={convertConvertibles} onChange={setConvertConvertibles} />
              <ul className="mt-3 space-y-1.5 border-t border-ink-100 pt-3">
                {liveConvertibles.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2 text-[12px]">
                    <span className="truncate text-ink-600">{INSTRUMENT_LABELS[c.instrument]}</span>
                    <span className="shrink-0 tabular">{money(c.principal, { compact: true })}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {(saved ?? []).length > 0 && (
            <Card>
              <CardHeader title="Saved scenarios" />
              <ul className="space-y-1">
                {saved!.filter((s) => s.type === 'ROUND').map((s) => (
                  <li key={s.id}>
                    <button onClick={() => loadScenario(s)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-ink-50">
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 text-[11px] text-ink-400">{date(s.createdAt?.slice(0, 10))}</span>
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
            <Card><EmptyState icon={<Icon name="trending" className="size-10" />}
              title="Set your terms and run the model"
              description="The round price, the pool top-up and every SAFE conversion depend on one another. The model solves them together and shows exactly who is diluted."
              action={<Button variant="primary" onClick={run}>Run model</Button>} /></Card>
          )}

          {running && <Card><Loading label="Solving the round" /></Card>}

          {result && !running && (
            <>
              {result.warnings?.length > 0 && (
                <Banner tone="warning" title="Model notes">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {result.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
                  </ul>
                </Banner>
              )}

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Price per share" value={pps(result.pricePerShare)}
                  hint={`Converged in ${result.iterations} iterations`} />
                <Stat label="Post-money valuation" value={money(result.postMoney, { compact: true })}
                  hint={Math.abs(result.impliedPostMoney - result.postMoney) > 100
                    ? `${money(result.preMoney, { compact: true })} pre-money; the price implies ${money(result.impliedPostMoney, { compact: true })}`
                    : `${money(result.preMoney, { compact: true })} pre-money`} />
                <Stat label="New investors own" value={percent(result.newInvestorShares / result.postRoundFullyDiluted)}
                  hint={`${shares(result.newInvestorShares)} shares`} />
                <Stat label="Existing holder dilution" value={percent(result.existingHolderDilution)}
                  tone="warning" hint={`Pool refreshed to ${percent(result.poolPctAfter)}`} />
              </div>

              <Card>
                <CardHeader title="Capitalization bridge" subtitle="How the share count moves through the round" />
                <Table>
                  <tbody>
                    {[
                      ['Fully diluted before the round', result.preRoundFullyDiluted],
                      ['Shares issued on conversion of SAFEs and notes', result.conversionShares],
                      ['Option pool increase', result.poolIncrease],
                      ['Shares issued to new investors', result.newInvestorShares],
                    ].map(([label, value]) => (
                      <TR key={label as string}>
                        <TD className="text-ink-700">{label}</TD>
                        <TD align="right" mono>{(value as number) > 0 && label !== 'Fully diluted before the round' ? '+' : ''}{shares(value as number)}</TD>
                      </TR>
                    ))}
                    <TR className="bg-ink-50">
                      <TD className="font-semibold">Fully diluted after the round</TD>
                      <TD align="right" mono className="font-semibold">{shares(result.postRoundFullyDiluted)}</TD>
                    </TR>
                  </tbody>
                </Table>
              </Card>

              {result.conversions.length > 0 && (
                <Card padded={false}>
                  <div className="p-5 pb-0">
                    <CardHeader title="Convertible conversions"
                      subtitle="Each instrument converts at the lower of its cap price and the discounted round price" />
                  </div>
                  <Table>
                    <thead>
                      <tr>
                        <TH>Instrument</TH><TH align="right">Converting amount</TH>
                        <TH align="right">Cap price</TH><TH align="right">Discount price</TH>
                        <TH align="right">Conversion price</TH><TH>Basis</TH>
                        <TH align="right">Shares</TH><TH align="right">Value multiple</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {result.conversions.map((c: any) => (
                        <TR key={c.convertibleId}>
                          <TD>{INSTRUMENT_LABELS[c.instrument] ?? c.instrument}</TD>
                          <TD align="right" mono>{money(c.amount)}</TD>
                          <TD align="right" mono className="text-ink-600">{c.capPrice ? pps(c.capPrice) : '—'}</TD>
                          <TD align="right" mono className="text-ink-600">{c.discountPrice ? pps(c.discountPrice) : '—'}</TD>
                          <TD align="right" mono className="font-medium">{pps(c.conversionPrice)}</TD>
                          <TD><Badge tone={c.method.includes('CAP') ? 'brand' : c.method.includes('DISCOUNT') ? 'info' : 'neutral'}>
                            {c.method.replace(/_/g, ' ').toLowerCase()}</Badge></TD>
                          <TD align="right" mono>{shares(c.shares)}</TD>
                          <TD align="right" mono className="text-secondary-800">{c.valueMultiple.toFixed(2)}x</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}

              {antiDilution.length > 0 && (
                <Card padded={false}>
                  <div className="p-5 pb-0">
                    <CardHeader title="Anti-dilution adjustment"
                      subtitle="This round prices below an earlier class, which triggers protection" />
                  </div>
                  <Table>
                    <thead>
                      <tr>
                        <TH>Class</TH><TH>Formula</TH>
                        <TH align="right">Old conversion price</TH><TH align="right">New conversion price</TH>
                        <TH align="right">New ratio</TH><TH align="right">Additional shares</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {antiDilution.map((a) => (
                        <TR key={a.shareClassId}>
                          <TD className="font-medium">{a.className}</TD>
                          <TD><Badge tone="warning">{a.formula.replace(/_/g, ' ').toLowerCase()}</Badge></TD>
                          <TD align="right" mono>{pps(a.oldConversionPrice)}</TD>
                          <TD align="right" mono className="text-red-600">{pps(a.newConversionPrice)}</TD>
                          <TD align="right" mono>{a.newConversionRatio.toFixed(4)}:1</TD>
                          <TD align="right" mono className="font-medium">{shares(a.additionalShares)}</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}

              <Card padded={false}>
                <div className="p-5 pb-0">
                  <CardHeader title="Ownership before and after" subtitle="Every holder's position through the round" />
                </div>
                <Table>
                  <thead>
                    <tr>
                      <TH>Holder</TH>
                      <TH align="right">Shares before</TH><TH align="right">Ownership before</TH>
                      <TH align="right">Shares after</TH><TH align="right">Ownership after</TH>
                      <TH align="right">Change</TH><TH align="right">Value at round price</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {result.ownership.map((o: any) => (
                      <TR key={o.stakeholderId}>
                        <TD>
                          <span className="font-medium">{o.name}</span>
                          {o.sharesBefore === 0 && <Badge tone="success" className="ml-2">New</Badge>}
                        </TD>
                        <TD align="right" mono>{o.sharesBefore ? shares(o.sharesBefore) : '—'}</TD>
                        <TD align="right" mono className="text-ink-600">{o.sharesBefore ? percent(o.pctBefore) : '—'}</TD>
                        <TD align="right" mono className="font-medium">{shares(o.sharesAfter)}</TD>
                        <TD align="right" mono className="font-medium">{percent(o.pctAfter)}</TD>
                        <TD align="right" mono className={o.dilutionPct > 0 ? 'text-red-600' : 'text-secondary-800'}>
                          {o.sharesBefore ? `${o.dilutionPct > 0 ? '−' : '+'}${percent(Math.abs(o.dilutionPct))}` : '—'}
                        </TD>
                        <TD align="right" mono className="text-ink-600">{money(o.valueAfter, { compact: true })}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Card>

              <Card>
                <CardHeader title="Dilution" subtitle="Ownership before and after, by holder" />
                <DilutionBars data={result.ownership.slice(0, 10)} height={Math.max(220, result.ownership.slice(0, 10).length * 34)} />
              </Card>

              <Card>
                <CardHeader title={<>How this price was reached<InfoDot text="The round price, pool top-up and conversions are solved together because each one depends on the others." /></>} />
                <KeyValue columns={2} items={[
                  { label: 'Pre-money valuation', value: money(result.preMoney) },
                  { label: 'Amount raised', value: money(result.amountRaised) },
                  { label: 'Pre-money shares carrying the valuation',
                    value: shares(poolFromPreMoney
                      ? result.preRoundFullyDiluted + result.poolIncrease + result.conversionShares
                      : result.preRoundFullyDiluted + result.conversionShares) },
                  { label: 'Price per share', value: pps(result.pricePerShare) },
                  { label: 'Implied post-money (price × post-round fully diluted)', value: money(result.impliedPostMoney) },
                  { label: 'Pool available after closing', value: `${shares(result.poolAvailableAfter)} (${percent(result.poolPctAfter)})` },
                  { label: 'Solver', value: result.converged ? `Converged in ${result.iterations} iterations` : 'Did not fully converge' },
                ]} />
              </Card>
            </>
          )}
        </div>
      </div>
      {running && <span className="sr-only"><Spinner /></span>}
    </>
  );
}
