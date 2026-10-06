/**
 * Reconciles a Pulley or Carta export against the app's math, on this machine.
 *
 *   npm run reconcile -- <export files…> [options]
 *
 *   --as-of YYYY-MM-DD    compare on this date (default: the date the export states, else today)
 *   --out DIR             where report.md and differences.csv go
 *                         (default: data/reconcile/<company>/<as-of>/ at the root of the repository)
 *   --figures FILE        compare against this export's figures without importing its ledgers, such
 *                         as a past-dated export checked against today's ledgers (repeatable)
 *   --company NAME        the company, when the export does not say
 *   --source NAME         the system the export came from, when it does not say
 *   --no-pool             leave the unallocated pool out of fully diluted
 *   --with-convertibles   add the app's SAFE and note estimates to fully diluted
 *   --date-order MDY|DMY  how to read an ambiguous date such as 03/04/2024
 *
 * Give it every file of the export: the stakeholder report and the cap table
 * workbook (or the CSVs). It only reads them. Nothing goes to a database: the
 * database address is pointed at one that refuses connections before anything
 * loads, so a stray query would fail rather than reach a real one.
 *
 * The console shows counts, causes and bug IDs only; names and holdings stay in
 * the report. Exits with 1 when a difference is unexplained, so a script can tell.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

process.env.DATABASE_URL = 'postgres://127.0.0.1:9/reconcile-uses-no-database';

const { reconcile } = await import('./index.ts');
const { writeReport, defaultReportDir, summaryLines } = await import('./report.ts');
const { SERVER_DIR } = await import('../env.ts');

const args = process.argv.slice(2);
const usage = 'Usage: npm run reconcile -- <export files…> [--as-of YYYY-MM-DD] [--out DIR] [--figures FILE] [--company NAME] [--source NAME] [--no-pool] [--with-convertibles] [--date-order MDY|DMY]';
// npm runs the script from apps/server; paths are the caller's.
const here = process.env.INIT_CWD ?? process.cwd();
const files: string[] = [];
const figures: string[] = [];
const flags: Record<string, string> = {};
const switches = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-pool' || a === '--with-convertibles') switches.add(a);
  else if (a === '--figures') figures.push(args[++i]);
  else if (a.startsWith('--')) {
    if (!['--as-of', '--out', '--company', '--source', '--date-order'].includes(a) || args[i + 1] == null) { console.error(`Unknown or incomplete option ${a}.\n${usage}`); process.exit(2); }
    flags[a] = args[++i];
  } else files.push(a);
}
if (!files.length) { console.error(usage); process.exit(2); }
if (flags['--as-of'] && !/^\d{4}-\d{2}-\d{2}$/.test(flags['--as-of'])) { console.error('--as-of takes a date as YYYY-MM-DD.'); process.exit(2); }
if (flags['--date-order'] && !['MDY', 'DMY'].includes(flags['--date-order'])) { console.error('--date-order is MDY or DMY.'); process.exit(2); }

const load = (p: string) => {
  const path = resolve(here, p);
  return { path, file: { name: basename(path), body: readFileSync(path) }, date: statSync(path).mtime.toISOString().slice(0, 10) };
};
const data = files.map(load);
const figureFiles = figures.map(load);

const result = await reconcile(data.map((d) => d.file), {
  asOf: flags['--as-of'],
  includeUnallocatedPool: !switches.has('--no-pool'),
  includeConvertibles: switches.has('--with-convertibles'),
  dateOrder: flags['--date-order'] as 'MDY' | 'DMY' | undefined,
  figures: figureFiles.map((d) => d.file),
  company: flags['--company'],
  system: flags['--source'],
});

const dir = flags['--out'] ? resolve(here, flags['--out']) : defaultReportDir(result, basename(files[0]).replace(/\.[^.]+$/, ''));
const paths = writeReport(result, dir, [...new Set([...data, ...figureFiles].map((d) => d.date))]);
for (const line of summaryLines(result)) console.log(line);
console.log(`Report: ${paths.report}`);
console.log(`Differences: ${paths.csv}`);

// A report inside the repository belongs under a data/ folder, which git and the image leave out.
const root = resolve(SERVER_DIR, '..', '..');
const inside = relative(root, dir);
if (!inside.startsWith('..') && !inside.split(sep).includes('data')) {
  console.warn(`Warning: ${dir} is inside the repository but not under a data/ folder, so git would pick it up. Move it, or write to data/reconcile/.`);
}
process.exit(result.passed ? 0 : 1);
