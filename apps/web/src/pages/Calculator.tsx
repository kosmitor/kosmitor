import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { PageHeader, Card, CardHeader, Field, Input, Loading, ErrorNote, KeyValue, SegmentedControl, Banner } from '../ui.tsx';
import { shares, pps, money, percent, parseShares, parseMoney } from '../format.ts';

type Basis = 'FULLY_DILUTED' | 'OUTSTANDING';
const parsePct = (s: string) => { const n = Number(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n / 100 : 0; };

/** Back-of-the-envelope conversions between shares, ownership and value, on the live cap table. */
export default function Calculator() {
  const { companyId } = useSession();
  const { data, error, loading, reload } = useQuery<any>(companyId ? `/c/${companyId}/captable` : null, [companyId]);
  const { data: valuations } = useQuery<any[]>(companyId ? `/c/${companyId}/valuations` : null, [companyId]);
  const [basis, setBasis] = useState<Basis>('FULLY_DILUTED');
  const [sharesIn, setSharesIn] = useState('100,000');
  const [pctIn, setPctIn] = useState('1');
  const [valuationIn, setValuationIn] = useState('');

  const fmv = valuations?.find((v) => v.status === 'ACTIVE')?.fairMarketValue ?? valuations?.[0]?.fairMarketValue ?? 0;
  const totals = data?.table?.totals;
  const denominator = useMemo(() => (basis === 'FULLY_DILUTED' ? totals?.fullyDiluted ?? 0 : totals?.outstanding ?? 0), [basis, totals]);

  if (loading && !data) return <Loading label="Loading the cap table" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!totals) return null;

  const qty = parseShares(sharesIn);
  const pct = parsePct(pctIn);
  const valuation = valuationIn ? parseMoney(valuationIn) : 0;
  const pricePerShare = valuation && totals.fullyDiluted ? Math.round((valuation / totals.fullyDiluted) * 10_000) : 0;   // cents / shares → micro-dollars

  return (
    <>
      <PageHeader concept="calculator" title="Share calculator" subtitle="Convert between shares, ownership and value on today's cap table." />

      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl value={basis} onChange={setBasis} options={[{ value: 'FULLY_DILUTED', label: 'Fully diluted' }, { value: 'OUTSTANDING', label: 'Outstanding shares' }]} />
          <KeyValue columns={3} items={[
            { label: 'Fully diluted', value: shares(totals.fullyDiluted) },
            { label: 'Outstanding', value: shares(totals.outstanding) },
            { label: 'Fair market value', value: fmv ? pps(fmv) : <Link to="/compliance/409a" className="text-brand-600 hover:text-brand-700">No 409A on file</Link> },
          ]} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Shares → ownership" subtitle="What a grant or certificate represents" />
          <Field label="Number of shares"><Input value={sharesIn} onChange={(e) => setSharesIn(e.target.value)} /></Field>
          <div className="mt-4 rounded-lg bg-ink-50 p-3">
            <KeyValue columns={1} items={[
              { label: `Ownership (${basis === 'FULLY_DILUTED' ? 'fully diluted' : 'outstanding'})`, value: denominator ? percent(qty / denominator, 4) : '—' },
              { label: 'Value at fair market value', value: fmv ? money(Math.round((qty * fmv) / 10_000)) : '—' },
              { label: 'Value at the valuation below', value: pricePerShare ? money(Math.round((qty * pricePerShare) / 10_000)) : '—' },
            ]} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Ownership → shares" subtitle="How many shares a percentage needs" />
          <Field label="Ownership (%)"><Input value={pctIn} onChange={(e) => setPctIn(e.target.value)} placeholder="1" /></Field>
          <div className="mt-4 rounded-lg bg-ink-50 p-3">
            <KeyValue columns={1} items={[
              { label: `Shares today (${basis === 'FULLY_DILUTED' ? 'fully diluted' : 'outstanding'})`, value: shares(Math.round(pct * denominator)) },
              { label: 'Shares if issued new (post-issue ownership)', value: pct < 1 ? shares(Math.round((pct * denominator) / (1 - pct))) : '—' },
              { label: 'Value at fair market value', value: fmv ? money(Math.round((Math.round(pct * denominator) * fmv) / 10_000)) : '—' },
            ]} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Valuation → price per share" subtitle="Implied by a post-money valuation" />
          <Field label="Company valuation" hint="Divided by fully diluted shares."><Input value={valuationIn} onChange={(e) => setValuationIn(e.target.value)} placeholder={money(2_500_000_000, { decimals: 0 })} /></Field>
          <div className="mt-4 rounded-lg bg-ink-50 p-3">
            <KeyValue columns={1} items={[
              { label: 'Price per share', value: pricePerShare ? pps(pricePerShare) : '—' },
              { label: 'Versus fair market value', value: pricePerShare && fmv ? `${(pricePerShare / fmv).toFixed(2)}×` : '—' },
              { label: `Value of ${shares(qty)} shares`, value: pricePerShare ? money(Math.round((qty * pricePerShare) / 10_000)) : '—' },
            ]} />
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <Banner tone="info" title="Planning arithmetic only">
          These figures use the cap table as it stands and ignore liquidation preferences, option strike prices and conversion terms. For a real round or exit use <Link to="/model/round" className="underline">round modeling</Link> and the <Link to="/model/exit" className="underline">exit waterfall</Link>.
        </Banner>
      </div>
    </>
  );
}
