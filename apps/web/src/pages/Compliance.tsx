import { Link, useParams } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { useQuery } from '../api.ts';
import { PageHeader, Card, Loading, ErrorNote, Stat, EmptyState } from '../ui.tsx';
import type { ConceptId } from '../concepts.ts';
import { Icon } from '../icons.tsx';
import { money, date, relativeDate } from '../format.ts';
import { RuleBadge, RULE_SECTIONS, scoreGauge } from './compliance/shared.tsx';
import { config } from '../config.ts';
import Valuations from './Valuations.tsx';
import Iso100k from './compliance/Iso100k.tsx';
import Rule701 from './compliance/Rule701.tsx';
import Elections83b from './compliance/Elections83b.tsx';
import Form3921 from './compliance/Form3921.tsx';
import BoiReporting from './compliance/BoiReporting.tsx';

type Section = 'findings' | '409a' | 'iso-100k' | 'rule-701' | '83b' | 'form-3921' | 'boi';
/** Titles match the sidebar's sub-items; /compliance itself shows the findings. */
const SECTIONS: Record<Section, { title: string; subtitle: string; concept: ConceptId }> = {
  findings: { title: 'Compliance & tax', subtitle: 'Automated checks across valuations, grants, elections, filings and securities exemptions', concept: 'compliance' },
  '409a': { title: '409A valuations', subtitle: 'Fair market value history that sets option strike prices', concept: '409a' },
  'iso-100k': { title: 'ISO $100K limit', subtitle: 'Incentive stock options first exercisable in a calendar year, per employee', concept: 'iso-100k' },
  'rule-701': { title: 'Rule 701', subtitle: 'The securities exemption for compensatory grants, over the rolling twelve months', concept: 'rule-701' },
  '83b': { title: '83(b) elections', subtitle: 'Restricted stock has 30 days from the transfer to elect; the window does not extend', concept: '83b' },
  'form-3921': { title: 'Form 3921', subtitle: 'Exercise of an incentive stock option — furnished to each employee and filed with the IRS for every calendar year with ISO exercises', concept: 'form-3921' },
  boi: { title: 'BOI reporting', subtitle: 'Beneficial ownership information for FinCEN under the Corporate Transparency Act', concept: 'boi' },
};
const isSection = (t: string | undefined): t is Section => t != null && t in SECTIONS;

/** The compliance sections share one route; the section lives in the URL (and the sidebar) so findings can link into it. */
export default function Compliance() {
  const { companyId, canViewAll } = useSession();
  const { tab: sectionParam } = useParams();
  const tab: Section = isSection(sectionParam) ? sectionParam : 'findings';
  const { data, error, loading, reload } = useQuery<any>(companyId && canViewAll ? `/c/${companyId}/compliance` : null, [companyId]);

  if (!canViewAll) return <EmptyState title="Compliance & tax is not available for your role" />;

  return (
    <>
      <PageHeader concept={SECTIONS[tab].concept} title={SECTIONS[tab].title} subtitle={SECTIONS[tab].subtitle} />

      {tab === 'findings' && <Findings data={data} error={error} loading={loading} reload={reload} />}
      {tab === '409a' && <Valuations embedded />}
      {tab === 'iso-100k' && <Iso100k />}
      {tab === 'rule-701' && <Rule701 />}
      {tab === '83b' && <Elections83b />}
      {tab === 'form-3921' && <Form3921 />}
      {tab === 'boi' && <BoiReporting />}
    </>
  );
}

interface Check {
  id: string; label: string; rules: string[];
  status: 'PASS' | 'REVIEW' | 'FAIL' | 'NOT_APPLICABLE';
  description: string; summary: string; findings: number;
}
interface Scoring { start: number; points: Record<'ERROR' | 'WARNING' | 'INFO', number>; bands: { min: number; label: string }[] }

/** Where an area is worked on, when it has a page of its own. */
const sectionOf = (c: Check): string | null => c.rules.map((r) => RULE_SECTIONS[r]).find(Boolean) ?? null;

function Findings({ data, error, loading, reload }: { data: any; error: string | null; loading: boolean; reload: () => void }) {
  if (loading) return <Loading label="Running compliance checks" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const errors = data.issues.filter((i: any) => i.severity === 'ERROR');
  const warnings = data.issues.filter((i: any) => i.severity === 'WARNING');
  const info = data.issues.filter((i: any) => i.severity === 'INFO');
  const checks: Check[] = data.checks ?? [];
  const good = checks.filter((c) => c.status === 'PASS');
  const notApplicable = checks.filter((c) => c.status === 'NOT_APPLICABLE');
  const applicable = checks.length - notApplicable.length;
  // The scoring the server used; the page's copy of compliance.scoring only if it does not say.
  const scoring: { start: number; bands: { min: number }[] } = data.scoring ?? config.compliance.scoring;
  const gauge = scoreGauge(data.score, scoring);

  return (
    <>
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <p className="text-[12px] font-medium uppercase tracking-wide text-ink-500">Compliance score</p>
          <div className="mt-3 flex items-center gap-4">
            <div className="relative grid size-16 shrink-0 place-items-center">
              <svg viewBox="0 0 36 36" className="absolute size-16 -rotate-90" aria-hidden>
                <circle cx="18" cy="18" r="15.5" fill="none" stroke={gauge.track} strokeWidth="4" />
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="4" strokeLinecap="round"
                  stroke={gauge.color}
                  strokeDasharray={`${gauge.filled * 97.4} 97.4`} />
              </svg>
              <span className="text-base font-semibold tabular">{data.score}<span className="sr-only"> out of {scoring.start}</span></span>
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium leading-snug text-ink-800">{data.band ?? ''}</p>
              <a href="#how-the-score-works" className="mt-1 inline-block text-[12px] font-medium text-brand-600 hover:text-brand-700">How the score works</a>
            </div>
          </div>
        </Card>
        <Stat label="Must fix" value={String(data.errors)} tone={data.errors > 0 ? 'negative' : 'positive'} hint="Findings with legal or tax consequences" />
        <Stat label="Should review" value={String(data.warnings)} tone={data.warnings > 0 ? 'warning' : 'positive'} hint="Deadlines and limits approaching" />
        <Stat label="In good order" value={`${good.length} of ${applicable}`} tone={good.length === applicable ? 'positive' : 'default'}
          hint={notApplicable.length ? `Areas with nothing to fix. ${notApplicable.length} more do not apply.` : 'Areas with nothing to fix'} />
      </div>

      <div className="space-y-5">
        {data.issues.length === 0 && (
          <Card><EmptyState icon={<Icon name="shield" className="size-10" />} title="Nothing to fix"
            description="Every check that applies passed. What each one looked at is listed under In good order." /></Card>
        )}

        {([['Must fix', errors, 'danger'], ['Should review', warnings, 'warning'], ['For information', info, 'info']] as [string, any[], string][])
          .filter(([, list]) => list.length > 0)
          .map(([title, list, tone]) => (
            <Card key={title} padded={false}>
              <div className="flex items-center gap-2 border-b border-ink-100 px-5 py-3">
                <span className={`size-2 rounded-full ${tone === 'danger' ? 'bg-red-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-sky-500'}`} />
                <h3 className="text-[15px] font-semibold">{title}</h3>
                <span className="text-[13px] text-ink-500">({list.length})</span>
              </div>
              <ul className="divide-y divide-ink-100">
                {list.map((issue) => (
                  <li key={issue.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[14px] font-medium text-ink-900">{issue.title}</p>
                          <RuleBadge rule={issue.rule} />
                        </div>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-600">{issue.detail}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        {issue.dueDate && (<><p className="text-[12px] font-medium text-ink-800">{date(issue.dueDate)}</p><p className="text-[11px] text-ink-500">{relativeDate(issue.dueDate)}</p></>)}
                        {issue.amount != null && <p className="text-[12px] tabular text-ink-600">{money(issue.amount, { compact: true })}</p>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}

        {good.length > 0 && (
          <Card padded={false}>
            <div className="flex items-center gap-2 border-b border-ink-100 px-5 py-3">
              <span className="size-2 rounded-full bg-secondary-500" />
              <h3 className="text-[15px] font-semibold">In good order</h3>
              <span className="text-[13px] text-ink-500">({good.length})</span>
            </div>
            <ul className="divide-y divide-ink-100">
              {good.map((c) => <CheckRow key={c.id} check={c} />)}
            </ul>
          </Card>
        )}

        {notApplicable.length > 0 && (
          <Card>
            <h3 className="text-[15px] font-semibold">Not applicable</h3>
            <p className="mt-0.5 text-[13px] text-ink-500">Checked, with nothing to look at yet. They start to count once there is.</p>
            <ul className="mt-3 space-y-2">
              {notApplicable.map((c) => (
                <li key={c.id} className="flex gap-3 text-[13px]">
                  <span className="w-40 shrink-0 font-medium text-ink-700">{c.label}</span>
                  <span className="min-w-0 text-ink-500">{c.summary}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {data.scoring && <ScoreExplained data={data} checks={checks} scoring={data.scoring} />}
      </div>
    </>
  );
}

/** One area that passed: what it looked at, and what it found. */
function CheckRow({ check }: { check: Check }) {
  const to = sectionOf(check);
  return (
    <li className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-secondary-100 text-secondary-700" aria-hidden>
        <Icon name="check" className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* What the check looks at is on hover: under a result that already says it, it mostly repeated it. */}
        <p className="text-[14px] font-medium text-ink-900" title={check.description}>
          {to ? <Link to={to} className="hover:text-brand-700">{check.label}</Link> : check.label}
          <span className="sr-only">: in good order</span>
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-600">{check.summary}</p>
      </div>
    </li>
  );
}

/**
 * The score's arithmetic, with this company's numbers in it, and where the
 * points went. The figures come from the server with the score, so the
 * explanation always matches the number above it.
 */
function ScoreExplained({ data, checks, scoring }: { data: any; checks: Check[]; scoring: Scoring }) {
  const rows: [string, number, number][] = [
    ['must fix', data.errors, scoring.points.ERROR],
    ['should review', data.warnings, scoring.points.WARNING],
    ['for information', data.info, scoring.points.INFO],
  ];
  const lost = rows.reduce((sum, [, n, p]) => sum + n * p, 0);
  const floored = scoring.start - lost < 0;
  const bySeverity = { ERROR: scoring.points.ERROR, WARNING: scoring.points.WARNING, INFO: scoring.points.INFO } as Record<string, number>;
  // Points lost in each area, biggest first: fixing the top one raises the score most.
  const areas = checks
    .map((c) => ({ c, points: data.issues.filter((i: any) => c.rules.includes(i.rule)).reduce((s: number, i: any) => s + (bySeverity[i.severity] ?? 0), 0) }))
    .filter((a) => a.points > 0)
    .sort((a, b) => b.points - a.points);

  return (
    <Card id="how-the-score-works">
      <h3 className="text-[15px] font-semibold">How the score works</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-600">
        It starts at {scoring.start}. Each finding takes points off by how serious it is: {scoring.points.ERROR} for one you must fix,
        {' '}{scoring.points.WARNING} for one to review and {scoring.points.INFO} for a note for information. Areas in good order add nothing,
        so a company with no findings scores {scoring.start}, and the score never goes below 0. It counts findings rather than areas,
        so ten grants missing board approval take off ten times as much as one.
      </p>

      <div className="mt-4 rounded-lg bg-ink-50 p-4 text-[13px]">
        <p className="font-medium text-ink-900">This company</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 tabular text-ink-700">
          <span>{scoring.start}</span>
          {rows.map(([label, n, p]) => (
            <span key={label} className={n === 0 ? 'text-ink-400' : undefined}>
              − {n} {label} × {p}
            </span>
          ))}
          <span>=</span>
          <span className="font-semibold text-ink-900">{data.score}</span>
          {floored && <span className="text-ink-500">(held at 0)</span>}
        </p>
        <p className="mt-2 text-ink-600">
          {scoring.bands.map((b, i) => {
            const higher = scoring.bands[i - 1];
            const range = i === 0 ? `${b.min} and above` : b.min === 0 ? `Below ${higher.min}` : `${b.min} to ${higher.min - 1}`;
            return `${range}: ${b.label.toLowerCase()}`;
          }).join('. ')}.
        </p>
      </div>

      {areas.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-medium text-ink-900">Where the points went</p>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {areas.map(({ c, points }) => {
              const to = sectionOf(c);
              return (
                <li key={c.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-ink-700">
                    {to ? <Link to={to} className="font-medium text-brand-600 hover:text-brand-700">{c.label}</Link> : <span className="font-medium">{c.label}</span>}
                    <span className="text-ink-500"> · {c.findings} finding{c.findings === 1 ? '' : 's'}</span>
                  </span>
                  <span className="shrink-0 tabular font-medium text-red-600">−{points}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[12px] text-ink-500">Fixing the area at the top raises the score the most.</p>
        </div>
      )}
    </Card>
  );
}
