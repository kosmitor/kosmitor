import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line, AreaChart, Area,
} from 'recharts';
import { useId } from 'react';
import { money, shares, percent, pps, date as longDate } from './format.ts';
import { config } from './config.ts';

/** Series colours, used in order: brand.colors.charts in kosmitor.config.json. */
export const CHART_COLORS = config.brand.colors.charts;

/** The brand palettes, for the single-series charts below. */
const PRIMARY = config.brand.colors.primary;
const ACCENT = config.brand.colors.accent;

// The axes and grid stay neutral greys (ink-400 and ink-100), whatever the brand.
const AXIS = { stroke: '#8d97ab', fontSize: 11 };
const GRID = { stroke: '#eceef2', strokeDasharray: '3 3' };

function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-ink-200 bg-white px-3 py-2 shadow-lg text-[12px]">
      {label != null && <p className="font-medium text-ink-900 mb-1">{label}</p>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4 tabular">
          <span className="flex items-center gap-1.5 text-ink-600">
            <span className="size-2 rounded-sm" style={{ background: p.color ?? p.fill }} />
            {p.name}
          </span>
          <span className="font-medium text-ink-900">{formatter ? formatter(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Ownership donut with a centred total. */
export function OwnershipDonut({ data, height = 260, centerLabel, centerValue }: {
  data: { label: string; shares: number; pct: number }[];
  height?: number; centerLabel?: string; centerValue?: string;
}) {
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="shares" nameKey="label" innerRadius="62%" outerRadius="92%"
            paddingAngle={1.5} strokeWidth={0}>
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <RTooltip content={<ChartTooltip formatter={(v: number) => shares(v)} />} />
        </PieChart>
      </ResponsiveContainer>
      {centerValue && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[11px] uppercase tracking-wide text-ink-500">{centerLabel}</span>
          <span className="text-xl font-semibold text-ink-900 tabular">{centerValue}</span>
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ data, formatValue }: {
  data: { label: string; pct: number; shares: number }[];
  formatValue?: (d: { label: string; pct: number; shares: number }) => string;
}) {
  return (
    <ul className="space-y-2">
      {data.map((d, i) => (
        <li key={d.label} className="flex items-center justify-between gap-3 text-[13px]">
          <span className="flex min-w-0 items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="truncate text-ink-700">{d.label}</span>
          </span>
          <span className="shrink-0 tabular font-medium text-ink-900">
            {formatValue ? formatValue(d) : percent(d.pct)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Dilution over time — one stacked area per share class. */
export function StackedAreaChart({ data, keys, xKey, height = 280, formatter }: {
  data: Record<string, any>[]; keys: string[]; xKey: string; height?: number;
  formatter?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} />
        <YAxis {...AXIS} tickLine={false} axisLine={false}
          tickFormatter={(v) => (formatter ? formatter(v) : shares(v))} width={70} />
        <RTooltip content={<ChartTooltip formatter={formatter ?? ((v: number) => shares(v))} />} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
        {keys.map((k, i) => (
          <Area key={k} type="monotone" dataKey={k} stackId="1" name={k}
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.75} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Vesting curve: cumulative vested against the total grant. */
export function VestingChart({ data, total, height = 220 }: {
  data: { date: string; vested: number }[]; total: number; height?: number;
}) {
  const points = data.map((d) => ({ ...d, label: d.date.slice(0, 7), unvested: total - d.vested }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="vest" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PRIMARY[500]} stopOpacity={0.45} />
            <stop offset="100%" stopColor={PRIMARY[500]} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={64}
          tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
        <RTooltip content={<ChartTooltip formatter={(v: number) => `${shares(v)} shares`} />} />
        <Area type="stepAfter" dataKey="vested" name="Vested" stroke={PRIMARY[500]} strokeWidth={2} fill="url(#vest)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Exit waterfall payout curve by group. */
export function PayoutCurve({ data, keys, height = 300 }: {
  data: { exitValue: number; [k: string]: number }[]; keys: string[]; height?: number;
}) {
  const points = data.map((d) => ({ ...d, label: money(d.exitValue, { compact: true }) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={64}
          tickFormatter={(v) => money(v, { compact: true })} />
        <RTooltip content={<ChartTooltip formatter={(v: number) => money(v, { compact: true })} />} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
        {keys.map((k, i) => (
          <Area key={k} type="monotone" dataKey={k} stackId="1" name={k}
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.7} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Per-share value across exit outcomes. */
export function PerShareCurve({ data, height = 240 }: {
  data: { exitValue: number; perCommonShare: number }[]; height?: number;
}) {
  const points = data.map((d) => ({ label: money(d.exitValue, { compact: true }), value: d.perCommonShare }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => pps(v)} />
        <RTooltip content={<ChartTooltip formatter={(v: number) => pps(v)} />} />
        <Line type="monotone" dataKey="value" name="Per common share" stroke={ACCENT[600]} strokeWidth={2.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Ownership before/after a modelled round. */
export function DilutionBars({ data, height = 300 }: {
  data: { name: string; pctBefore: number; pctAfter: number }[]; height?: number;
}) {
  const points = data.map((d) => ({
    name: d.name.length > 20 ? `${d.name.slice(0, 19)}…` : d.name,
    Before: Number((d.pctBefore * 100).toFixed(2)),
    After: Number((d.pctAfter * 100).toFixed(2)),
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={points} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" {...AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="name" {...AXIS} tickLine={false} axisLine={false} width={130} />
        <RTooltip content={<ChartTooltip formatter={(v: number) => `${v}%`} />} />
        <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
        <Bar dataKey="Before" fill={PRIMARY[200]} radius={[0, 3, 3, 0]} barSize={9} />
        <Bar dataKey="After" fill={PRIMARY[500]} radius={[0, 3, 3, 0]} barSize={9} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Common stock fair market value over time, one point per 409A. Drawn as steps
 * rather than a curve: a valuation's price holds, unchanged, until the next one
 * replaces it, and a sloping line would show prices nobody ever set. The last
 * price carries on to today.
 */
export function ValuationHistoryChart({ points, today, height = 220 }: {
  points: { date: string; value: number; provider: string | null }[]; today: string; height?: number;
}) {
  const gradient = useId().replace(/:/g, '');
  const at = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  const last = points[points.length - 1];
  const data = [
    ...points.map((p) => ({ t: at(p.date), value: p.value, provider: p.provider, date: p.date, real: true })),
    ...(last && at(today) > at(last.date) ? [{ t: at(today), value: last.value, provider: null, date: today, real: false }] : []),
  ];
  const month = (ms: number) => new Date(ms).toLocaleDateString(config.locale.locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 12, right: 28, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PRIMARY[500]} stopOpacity={0.22} />
            <stop offset="100%" stopColor={PRIMARY[500]} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={month}
          {...AXIS} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => pps(v)} domain={[0, 'auto']} />
        <RTooltip cursor={{ stroke: PRIMARY[200], strokeWidth: 1 }} content={({ active, payload }: any) => {
          const p = active && payload?.[0]?.payload;
          if (!p) return null;
          return (
            <div className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-[12px] shadow-lg">
              <p className="font-medium text-ink-900">{p.real ? longDate(p.date) : 'Today'}</p>
              <p className="mt-0.5 tabular text-ink-700">{pps(p.value)} per share</p>
              {p.real && p.provider && <p className="mt-0.5 text-ink-500">{p.provider}</p>}
            </div>
          );
        }} />
        <Area type="stepAfter" dataKey="value" stroke={PRIMARY[500]} strokeWidth={2.5} fill={`url(#${gradient})`}
          animationDuration={900} activeDot={{ r: 5, fill: PRIMARY[500], stroke: '#fff', strokeWidth: 2 }}
          dot={(d: any) => (d.payload.real
            ? <circle key={`dot-${d.index}`} cx={d.cx} cy={d.cy} r={4} fill="#fff" stroke={PRIMARY[500]} strokeWidth={2} />
            : <g key={`dot-${d.index}`} />)} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

