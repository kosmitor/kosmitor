/**
 * Writes a reconciliation up: report.md for a person, differences.csv with one
 * row per difference for a spreadsheet. Both name holders and state holdings,
 * so they belong in data/reconcile/ on your own machine and nowhere else.
 * `summaryLines` is the part safe to show anywhere: counts, causes and bug IDs,
 * with no name or figure from the export.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVER_DIR } from '../env.ts';
import { toCsv } from '../import/csv.ts';
import { LEVELS, CATEGORIES, type Level, type Unit } from './compare.ts';
import type { Reconciliation, Difference } from './index.ts';

/** data/reconcile/ at the root of the repository: ignored by git and left out of the Docker image. */
export const RECONCILE_DIR = resolve(SERVER_DIR, '..', '..', 'data', 'reconcile');

export const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'company';

export function defaultReportDir(r: Reconciliation, fallbackName: string): string {
  return resolve(RECONCILE_DIR, slug(r.company ?? fallbackName), r.asOf);
}

const LEVEL_NAMES: Record<Level, string> = {
  import: 'Import (rows that did not import)', internal: 'Internal checks', class: 'Class totals',
  holder: 'Holder × class', grant: 'Grants', percent: 'Percentages',
};

function format(v: number | string | null, unit: Unit, csv: boolean): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const group = !csv;
  const n = (x: number, digits: number) => x.toLocaleString('en-US', { useGrouping: group, minimumFractionDigits: 0, maximumFractionDigits: digits });
  switch (unit) {
    case 'cents': return `${v < 0 ? '-' : ''}$${(Math.abs(v) / 100).toLocaleString('en-US', { useGrouping: group, minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'price': return `${v < 0 ? '-' : ''}$${n(Math.abs(v) / 1e6, 6)}`;
    case 'pct': return `${n(v * 100, 6)}%`;
    default: return n(v, 6);
  }
}
const formatDiff = (d: Difference, csv: boolean): string =>
  d.difference == null ? '' : d.unit === 'pct' ? `${(d.difference * 100).toLocaleString('en-US', { maximumFractionDigits: 6 })} pt` : format(d.difference, d.unit, csv);

/** The engine's version, and when its code last changed, so a report says which app it checked. */
function appVersion(): string {
  const root = resolve(SERVER_DIR, '..', '..');
  let newest = 0;
  for (const dir of ['packages/core/src', 'apps/server/src/import', 'apps/server/src/reconcile']) {
    try {
      for (const f of readdirSync(resolve(root, dir))) newest = Math.max(newest, statSync(resolve(root, dir, f)).mtimeMs);
    } catch { /* a missing folder says nothing */ }
  }
  return `@ct/core 1.0.0, engine and import code last changed ${newest ? new Date(newest).toISOString().slice(0, 10) : 'unknown'}`;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(r: Reconciliation, exportDates: string[] = []): string {
  const unexplained = r.categories.unexplained;
  const out: string[] = [];
  out.push(`# Reconciliation: ${r.company ?? 'company'} as of ${r.asOf}`, '');
  out.push('| | |', '|---|---|');
  out.push(`| As of | ${r.asOf}${r.dataAsOf && r.dataAsOf !== r.asOf ? ` (ledgers as of ${r.dataAsOf})` : ''} |`);
  out.push(`| Source system | ${r.system ?? 'not stated in the files'} |`);
  out.push(`| Export | ${cell(r.files.join(', '))}${r.figureFiles.length ? `; figures from ${cell(r.figureFiles.join(', '))}` : ''}${exportDates.length ? ` (files dated ${exportDates.join(', ')})` : ''} |`);
  out.push(`| App | ${appVersion()} |`);
  out.push(`| Options | unallocated pool in fully diluted: ${r.options.includeUnallocatedPool ? 'yes' : 'no'}; SAFE and note estimates in fully diluted: ${r.options.includeConvertibles ? 'yes' : 'no'}; ambiguous dates read ${r.options.dateOrder === 'DMY' ? 'day first' : 'month first'}; exercise window ${r.options.postTerminationExerciseMonths} months; option term ${r.options.optionTermYears} years |`);
  out.push(`| Compared | ${r.comparisons.length.toLocaleString('en-US')} items: ${(r.comparisons.length - r.differences.length).toLocaleString('en-US')} match, ${r.differences.length.toLocaleString('en-US')} differ |`);
  out.push(`| Result | ${r.passed ? '**Pass**: every difference is accounted for' : `**${unexplained} unexplained** ${unexplained === 1 ? 'difference' : 'differences'}: each is a possible bug to investigate`} |`, '');

  out.push('## Counts', '', '| Level | Compared | Match | Differ |', '|---|---:|---:|---:|');
  for (const level of LEVELS) out.push(`| ${LEVEL_NAMES[level]} | ${r.counts[level].compared} | ${r.counts[level].matching} | ${r.counts[level].differing} |`);
  out.push('', '| Cause | Differences | Not just following from others |', '|---|---:|---:|');
  for (const c of CATEGORIES) out.push(`| ${c} | ${r.categories[c]} | ${r.rootCategories[c]} |`);
  const bugs = Object.entries(r.bugs).sort();
  out.push('', bugs.length ? `Known bugs behind differences: ${bugs.map(([b, n]) => `${b} (${n})`).join(', ')}. The IDs are those of the math audit.` : 'No known bug is behind any difference.', '');

  out.push('## What was read', '');
  for (const s of r.sheets) out.push(`- ${cell(s.file)} › ${cell(s.sheet)}: ${s.use}`);
  out.push('', `The import read ${r.imported.rows} rows (${r.imported.stakeholders} stakeholders, ${r.imported.certificates} certificates, ${r.imported.grants} grants, ${r.imported.convertibles} SAFEs and notes); ${r.imported.errors} rows had errors and ${r.imported.warnings} warnings. Nothing was written to any database.`, '');
  if (r.assumptions.length) {
    out.push('## Assumptions', '');
    for (const a of r.assumptions) out.push(`- ${cell(a)}`);
    out.push('');
  }

  out.push('## Differences', '');
  if (!r.differences.length) out.push('None.', '');
  for (const level of LEVELS) {
    const list = r.differences.filter((d) => d.level === level);
    if (!list.length) continue;
    out.push(`### ${LEVEL_NAMES[level]}`, '', '| Key | Field | Export | App | Difference | Cause | Bug | Note | Where |', '|---|---|---:|---:|---:|---|---|---|---|');
    for (const d of list) {
      out.push(`| ${cell(d.key)} | ${cell(d.field)} | ${cell(format(d.source, d.unit, false))} | ${cell(format(d.app, d.unit, false))} | ${formatDiff(d, false)} | ${d.category}${d.root ? '' : ' (follows)'} | ${d.bug ?? ''} | ${cell(d.note)} | ${cell(d.where)} |`);
    }
    out.push('');
  }

  out.push('## Reading this', '',
    '- **import mapping**: the data came in wrong, or the export leaves out something the import had to assume.',
    '- **known bug**: a confirmed bug from the math audit, by its ID.',
    '- **definition**: both figures are right under different definitions.',
    '- **source system**: the export is wrong, stale, or does not add up on its own terms. Check with the provider.',
    '- **unexplained**: none of the above. Each one is a possible new bug: rebuild the smallest case with invented names and pin it as a test.',
    '', 'A difference marked "(follows)" only follows from others in the list, such as a total whose lines differ.', '',
    'This report holds real names and holdings. Keep it in data/reconcile/ on this machine; never paste it into an issue, a pull request or a chat.', '');
  return out.join('\n');
}

export function renderCsv(r: Reconciliation): string {
  const rows: (string | number | null)[][] = [['level', 'key', 'field', 'source_value', 'app_value', 'difference', 'category', 'bug_id', 'note', 'where', 'follows_from_others']];
  for (const d of r.differences) {
    rows.push([d.level, d.key, d.field, format(d.source, d.unit, true), format(d.app, d.unit, true), formatDiff(d, true), d.category, d.bug ?? '', d.note, d.where, d.root ? 'no' : 'yes']);
  }
  return `${toCsv(rows)}\r\n`;
}

/** Writes report.md and differences.csv into `dir`; returns their paths. */
export function writeReport(r: Reconciliation, dir: string, exportDates: string[] = []): { report: string; csv: string } {
  mkdirSync(dir, { recursive: true });
  const report = resolve(dir, 'report.md');
  const csv = resolve(dir, 'differences.csv');
  writeFileSync(report, renderReport(r, exportDates));
  writeFileSync(csv, renderCsv(r));
  return { report, csv };
}

/** Counts, causes and bug IDs only: nothing that names a holder or states a holding. */
export function summaryLines(r: Reconciliation): string[] {
  const lines = [`As of ${r.asOf}${r.system ? `, ${r.system} export` : ''}: ${r.comparisons.length} items compared, ${r.differences.length} differ.`];
  for (const level of LEVELS) {
    const c = r.counts[level];
    if (c.compared) lines.push(`  ${LEVEL_NAMES[level].padEnd(36)} ${String(c.compared).padStart(5)} compared  ${String(c.matching).padStart(5)} match  ${String(c.differing).padStart(5)} differ`);
  }
  for (const c of CATEGORIES) if (r.categories[c]) lines.push(`  ${c.padEnd(36)} ${String(r.categories[c]).padStart(5)} (${r.rootCategories[c]} not just following from others)`);
  const bugs = Object.entries(r.bugs).sort();
  if (bugs.length) lines.push(`  Known bugs: ${bugs.map(([b, n]) => `${b} (${n})`).join(', ')}`);
  lines.push(r.passed ? 'Pass: no unexplained difference.' : `${r.categories.unexplained} unexplained: see the report.`);
  return lines;
}
