/**
 * Custom report builder: pick a dataset, the columns, filters and sort, see
 * the rows, export to CSV or Excel, and save the definition to run again.
 * Datasets are defined here so every column has a type the client can format.
 */
import { route, newId, nowISO, audit, badRequest, notFound, forbidden, str, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { computeCapTable, summarizeVesting, activeValuation, today, isDirector, type CompanyData } from '@kosmitor/core';
import { xlsx } from '../xlsx-writer.ts';
import { config } from '../config.ts';
import { seesWholeCompany } from '../auth.ts';

type ColumnType = 'text' | 'number' | 'money' | 'pps' | 'date' | 'percent' | 'boolean';
export interface Column { key: string; label: string; type: ColumnType }
type Row = Record<string, unknown>;
interface RowContext { companyId: string; data: CompanyData; asOf: string; table: ReturnType<typeof computeCapTable>; fmv: number }
interface Dataset { key: string; label: string; description: string; columns: Column[]; rows: (ctx: RowContext) => Promise<Row[]> }

const col = (key: string, label: string, type: ColumnType = 'text'): Column => ({ key, label, type });
const nameOf = (data: CompanyData, id: string | null | undefined) => data.stakeholders.find((s) => s.id === id)?.name ?? (id ?? '');
const classOf = (data: CompanyData, id: string | null | undefined) => data.shareClasses.find((c) => c.id === id)?.name ?? '';
const scheduleOf = (data: CompanyData, id: string | null | undefined) => data.vestingSchedules.find((v) => v.id === id);

export const DATASETS: Dataset[] = [
  {
    key: 'stakeholders', label: 'Stakeholders', description: 'Everyone on the cap table with their contact details and position.',
    columns: [col('name', 'Name'), col('email', 'Email'), col('type', 'Type'), col('relation', 'Relationship'), col('title', 'Title'), col('department', 'Department'),
      col('startDate', 'Start date', 'date'), col('terminationDate', 'Termination date', 'date'), col('taxCountry', 'Tax country'), col('taxState', 'Tax state'),
      col('director', 'Director', 'boolean'), col('boardSeatStart', 'Board seat from', 'date'), col('boardSeatEnd', 'Board seat until', 'date'),
      col('sharesOutstanding', 'Shares outstanding', 'number'), col('optionsOutstanding', 'Options outstanding', 'number'), col('optionsVested', 'Options vested', 'number'),
      col('fullyDiluted', 'Fully diluted shares', 'number'), col('fullyDilutedPct', 'Fully diluted %', 'percent'), col('investedAmount', 'Invested', 'money'), col('currentValue', 'Current value', 'money')],
    rows: async ({ companyId, table, asOf }) => {
      const people = toCamelAll<Row>(await all('SELECT * FROM stakeholders WHERE company_id = ? ORDER BY name', companyId));
      return people.map((p) => {
        const r = table.rows.find((x) => x.stakeholderId === p.id);
        return { ...p, director: isDirector(p, asOf), sharesOutstanding: r?.outstanding ?? 0, optionsOutstanding: r?.optionsOutstanding ?? 0, optionsVested: r?.optionsVested ?? 0,
          fullyDiluted: r?.fullyDiluted ?? 0, fullyDilutedPct: r?.fullyDilutedPct ?? 0, investedAmount: r?.investedAmount ?? 0, currentValue: r?.currentValue ?? 0 };
      });
    },
  },
  {
    key: 'captable', label: 'Cap table', description: 'One row per holder with outstanding, as-converted and fully diluted positions as of the report date.',
    columns: [col('name', 'Holder'), col('relation', 'Relationship'), col('outstanding', 'Outstanding shares', 'number'), col('asConverted', 'As converted', 'number'),
      col('optionsOutstanding', 'Options outstanding', 'number'), col('optionsVested', 'Options vested', 'number'), col('optionsUnvested', 'Options unvested', 'number'),
      col('rsusOutstanding', 'RSUs', 'number'), col('warrantsOutstanding', 'Warrants', 'number'), col('convertibleAsConverted', 'Convertibles as converted', 'number'),
      col('fullyDiluted', 'Fully diluted', 'number'), col('outstandingPct', 'Outstanding %', 'percent'), col('fullyDilutedPct', 'Fully diluted %', 'percent'),
      col('votes', 'Votes', 'number'), col('investedAmount', 'Invested', 'money'), col('currentValue', 'Current value', 'money')],
    rows: async ({ table }) => table.rows.map((r) => ({ ...r })),
  },
  {
    key: 'certificates', label: 'Certificates', description: 'Share certificates with class, price, vesting and 83(b) status.',
    columns: [col('certificateNo', 'Certificate'), col('holder', 'Holder'), col('shareClass', 'Share class'), col('quantity', 'Shares', 'number'), col('pricePerShare', 'Price per share', 'pps'),
      col('consideration', 'Consideration', 'money'), col('issueDate', 'Issue date', 'date'), col('status', 'Status'), col('vestingSchedule', 'Vesting schedule'), col('vestingStartDate', 'Vesting start', 'date'),
      col('vested', 'Vested shares', 'number'), col('earlyExercised', 'Early exercised', 'boolean'), col('election83bFiledOn', '83(b) filed on', 'date'), col('boardApprovalDate', 'Board approval', 'date'), col('notes', 'Notes')],
    rows: async ({ companyId, data, asOf }) => {
      const rows = toCamelAll<Row>(await all('SELECT * FROM issuances WHERE company_id = ? ORDER BY issue_date, certificate_no', companyId));
      return rows.map((i) => {
        const schedule = scheduleOf(data, i.vestingScheduleId as string | null);
        const holder = data.stakeholders.find((s) => s.id === i.stakeholderId);
        const summary = schedule ? summarizeVesting({ schedule, totalQuantity: Number(i.quantity), vestingStartDate: String(i.vestingStartDate ?? i.issueDate), terminationDate: holder?.terminationDate ?? null }, asOf) : null;
        return { ...i, holder: nameOf(data, i.stakeholderId as string), shareClass: classOf(data, i.shareClassId as string), consideration: Math.round((Number(i.quantity) * Number(i.pricePerShare)) / 10_000),
          vestingSchedule: schedule?.name ?? '', vested: summary ? summary.vested : Number(i.quantity), earlyExercised: Number(i.earlyExercised ?? 0) === 1 };
      });
    },
  },
  {
    key: 'grants', label: 'Equity awards', description: 'Options and RSUs with vesting as of the report date, exercises and cancellations.',
    columns: [col('label', 'Grant'), col('holder', 'Holder'), col('type', 'Type'), col('plan', 'Plan'), col('quantity', 'Granted', 'number'), col('strikePrice', 'Strike price', 'pps'),
      col('grantDate', 'Grant date', 'date'), col('vestingStartDate', 'Vesting start', 'date'), col('vestingSchedule', 'Vesting schedule'), col('vested', 'Vested', 'number'), col('unvested', 'Unvested', 'number'),
      col('exercisedQuantity', 'Exercised', 'number'), col('cancelledQuantity', 'Cancelled', 'number'), col('outstanding', 'Outstanding', 'number'), col('intrinsicValue', 'Intrinsic value', 'money'),
      col('status', 'Status'), col('expirationDate', 'Expires', 'date'), col('boardApprovalDate', 'Board approval', 'date'), col('acceptedDate', 'Accepted', 'date'), col('fmvAtGrant', 'FMV at grant', 'pps'),
      col('ptepMonths', 'PTEP (months)', 'number'), col('earlyExerciseAllowed', 'Early exercise', 'boolean'), col('notes', 'Notes')],
    rows: async ({ data, asOf, fmv }) => data.awards.map((a) => {
      const schedule = scheduleOf(data, a.vestingScheduleId);
      const holder = data.stakeholders.find((s) => s.id === a.stakeholderId);
      const summary = schedule ? summarizeVesting({ schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate, terminationDate: holder?.terminationDate ?? null }, asOf) : null;
      const outstanding = Math.max(0, a.quantity - a.exercisedQuantity - a.cancelledQuantity);
      const vested = Math.max(0, Math.min(outstanding, (summary?.vested ?? a.quantity) - a.exercisedQuantity));
      return { ...a, label: a.label ?? a.id, holder: nameOf(data, a.stakeholderId), plan: data.pools.find((p) => p.id === a.poolId)?.name ?? '', vestingSchedule: schedule?.name ?? '',
        vested, unvested: Math.max(0, outstanding - vested), outstanding, intrinsicValue: Math.max(0, Math.round((outstanding * (fmv - a.strikePrice)) / 10_000)), earlyExerciseAllowed: !!a.earlyExerciseAllowed };
    }),
  },
  {
    key: 'convertibles', label: 'SAFEs & notes', description: 'Convertible instruments with their terms and funding status.',
    columns: [col('label', 'Instrument'), col('holder', 'Holder'), col('instrument', 'Kind'), col('principal', 'Principal', 'money'), col('issueDate', 'Issue date', 'date'), col('valuationCap', 'Valuation cap', 'money'),
      col('discount', 'Discount', 'percent'), col('interestRate', 'Interest rate', 'percent'), col('compounding', 'Compounding'), col('maturityDate', 'Maturity', 'date'), col('mfn', 'MFN', 'boolean'), col('proRataRight', 'Pro rata', 'boolean'),
      col('qualifiedFinancingMinimum', 'Qualified financing minimum', 'money'), col('status', 'Status'), col('fundsReceivedOn', 'Funds received', 'date'), col('convertedOn', 'Converted on', 'date'), col('notes', 'Notes')],
    rows: async ({ companyId, data }) => toCamelAll<Row>(await all('SELECT * FROM convertibles WHERE company_id = ? ORDER BY issue_date', companyId))
      .map((c) => ({ ...c, label: c.label ?? c.id, holder: nameOf(data, c.stakeholderId as string), mfn: Number(c.mfn ?? 0) === 1, proRataRight: Number(c.proRataRight ?? 0) === 1 })),
  },
  {
    key: 'warrants', label: 'Warrants', description: 'Warrants with class, strike and exercise status.',
    columns: [col('holder', 'Holder'), col('shareClass', 'Share class'), col('quantity', 'Shares', 'number'), col('strikePrice', 'Strike price', 'pps'), col('issueDate', 'Issue date', 'date'),
      col('expirationDate', 'Expires', 'date'), col('status', 'Status'), col('exercisedQuantity', 'Exercised', 'number'), col('netExercise', 'Net exercise', 'boolean'), col('notes', 'Notes')],
    rows: async ({ data }) => data.warrants.map((w) => ({ ...w, holder: nameOf(data, w.stakeholderId), shareClass: classOf(data, w.shareClassId), netExercise: !!w.netExercise })),
  },
  {
    key: 'transactions', label: 'Transactions', description: 'The ledger: issuances, grants, exercises, transfers, conversions and cancellations.',
    columns: [col('date', 'Date', 'date'), col('type', 'Type'), col('stakeholder', 'Stakeholder'), col('counterparty', 'Counterparty'), col('securityId', 'Security'), col('shareClass', 'Share class'),
      col('quantity', 'Quantity', 'number'), col('pricePerShare', 'Price per share', 'pps'), col('amount', 'Amount', 'money'), col('memo', 'Memo'), col('createdBy', 'Recorded by'), col('createdAt', 'Recorded at')],
    rows: async ({ companyId, data, asOf }) => toCamelAll<Row>(await all('SELECT * FROM transactions WHERE company_id = ? AND date <= ? ORDER BY date, created_at', companyId, asOf))
      .map((t) => ({ ...t, stakeholder: nameOf(data, t.stakeholderId as string), counterparty: t.counterpartyId ? nameOf(data, t.counterpartyId as string) : '', shareClass: classOf(data, t.shareClassId as string | null) })),
  },
];

export interface ReportSpec { dataset: string; columns?: string[]; filters?: { column: string; op: string; value?: unknown }[]; sort?: { column: string; dir?: 'asc' | 'desc' } | null; asOf?: string; totals?: boolean }
const OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'empty', 'notEmpty'];

function matches(value: unknown, op: string, wanted: unknown): boolean {
  const v = value == null ? '' : value;
  const num = (x: unknown) => (typeof x === 'boolean' ? (x ? 1 : 0) : Number(x));
  const both = typeof v === 'number' || typeof v === 'boolean' || (typeof wanted !== 'string' && wanted != null) || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && !Number.isNaN(Number(wanted)) && /^[-\d.]+$/.test(v));
  switch (op) {
    case 'empty': return v === '' || v === null;
    case 'notEmpty': return !(v === '' || v === null);
    case 'contains': return String(v).toLowerCase().includes(String(wanted ?? '').toLowerCase());
    case 'in': return (Array.isArray(wanted) ? wanted : String(wanted ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).includes(String(v).toLowerCase());
    case 'eq': return both && typeof v !== 'string' ? num(v) === num(wanted) : String(v).toLowerCase() === String(wanted ?? '').toLowerCase();
    case 'neq': return !(both && typeof v !== 'string' ? num(v) === num(wanted) : String(v).toLowerCase() === String(wanted ?? '').toLowerCase());
    case 'gt': return both ? num(v) > num(wanted) : String(v) > String(wanted ?? '');
    case 'gte': return both ? num(v) >= num(wanted) : String(v) >= String(wanted ?? '');
    case 'lt': return both ? num(v) < num(wanted) : String(v) < String(wanted ?? '');
    case 'lte': return both ? num(v) <= num(wanted) : String(v) <= String(wanted ?? '');
    default: return true;
  }
}

function readSpec(body: Record<string, unknown>): { spec: ReportSpec; dataset: Dataset; columns: Column[] } {
  const dataset = DATASETS.find((d) => d.key === String(body.dataset ?? ''));
  if (!dataset) throw badRequest('Choose a dataset.');
  const wanted: string[] = Array.isArray(body.columns) && body.columns.length ? body.columns.map(String) : dataset.columns.map((c) => c.key);
  const columns = wanted.map((k) => dataset.columns.find((c) => c.key === k)).filter((c): c is Column => !!c);
  if (columns.length === 0) throw badRequest('Choose at least one column.');
  const filters = (Array.isArray(body.filters) ? body.filters : []).map((f: Record<string, unknown>) => {
    const column = String(f.column ?? '');
    if (!dataset.columns.some((c) => c.key === column)) throw badRequest(`Unknown column "${column}".`);
    const op = String(f.op ?? 'eq');
    if (!OPS.includes(op)) throw badRequest(`Unknown filter "${op}".`);
    return { column, op, value: f.value };
  });
  const sort = body.sort && typeof body.sort === 'object' && (body.sort as Record<string, unknown>).column
    ? { column: String((body.sort as Record<string, unknown>).column), dir: (body.sort as Record<string, unknown>).dir === 'desc' ? 'desc' as const : 'asc' as const } : null;
  if (sort && !dataset.columns.some((c) => c.key === sort.column)) throw badRequest('Sort by a column of the dataset.');
  const asOf = body.asOf ? String(body.asOf) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw badRequest('As-of date must be YYYY-MM-DD.');
  return { spec: { dataset: dataset.key, columns: columns.map((c) => c.key), filters, sort, asOf, totals: !!body.totals }, dataset, columns };
}

export async function runReport(companyId: string, body: Record<string, unknown>): Promise<{ spec: ReportSpec; columns: Column[]; rows: unknown[][]; total: number; totalsRow: unknown[] | null }> {
  const { spec, dataset, columns } = readSpec(body);
  const data = await getCompanyData(companyId);
  const table = computeCapTable(data, { asOf: spec.asOf!, includeConvertibles: true });
  const fmv = activeValuation(data, spec.asOf!);
  let rows = await dataset.rows({ companyId, data, asOf: spec.asOf!, table, fmv });
  for (const f of spec.filters ?? []) rows = rows.filter((r) => matches(r[f.column], f.op, f.value));
  if (spec.sort) {
    const { column, dir } = spec.sort;
    const sign = dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const x = a[column]; const y = b[column];
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;
      if (y == null || y === '') return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sign;
    });
  }
  const totalsRow = spec.totals
    ? columns.map((c, i) => (['number', 'money'].includes(c.type) ? rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) : i === 0 ? 'Total' : ''))
    : null;
  return { spec, columns, rows: rows.map((r) => columns.map((c) => r[c.key] ?? null)), total: rows.length, totalsRow };
}

/** Values as they should appear in a spreadsheet: dollars, share counts, percentages as numbers; dates and text as strings. */
function exportCell(value: unknown, type: ColumnType): string | number | null {
  if (value == null || value === '') return null;
  switch (type) {
    case 'money': return Math.round(Number(value)) / 100;
    case 'pps': return Number(value) / 1e6;
    case 'percent': return Math.round(Number(value) * 1e6) / 1e4;
    case 'number': return Number(value);
    case 'boolean': return value ? 'Yes' : 'No';
    default: return String(value);
  }
}

const csvText = (rows: (string | number | null)[][]): string => rows.map((r) => r.map((c) => {
  const s = c == null ? '' : String(c);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n');

function assertCompanyUser(ctx: Ctx): void {
  if (!seesWholeCompany(ctx.membership!.role)) throw forbidden('Reports are for company users.');
}

route.get('/api/c/:cid/report-builder', 'read', async (ctx) => {
  assertCompanyUser(ctx);
  const saved = toCamelAll<Row>(await all('SELECT * FROM saved_reports WHERE company_id = ? ORDER BY name', ctx.companyId));
  return {
    datasets: DATASETS.map((d) => ({ key: d.key, label: d.label, description: d.description, columns: d.columns })), operators: OPS,
    saved: saved.map((s) => ({ ...s, config: (() => { try { return JSON.parse(String(s.config)); } catch { return {}; } })() })),
  };
});

route.post('/api/c/:cid/report-builder/run', 'read', async (ctx) => {
  assertCompanyUser(ctx);
  // limits.reportRows when the page asks for no number, never more than limits.reportMaxRows.
  const { reportRows, reportMaxRows } = config().limits;
  const limit = Math.min(reportMaxRows, Math.max(1, Number(ctx.body.limit ?? reportRows)));
  const result = await runReport(ctx.companyId!, ctx.body);
  return { ...result, rows: result.rows.slice(0, limit), truncated: result.rows.length > limit };
});

/** Export via GET so the browser can download it: the spec travels base64url-encoded in the query. */
route.get('/api/c/:cid/report-builder/export', 'read', async (ctx) => {
  assertCompanyUser(ctx);
  let body: Record<string, unknown>;
  try { body = JSON.parse(Buffer.from(ctx.query.get('spec') ?? '', 'base64url').toString('utf8')); } catch { throw badRequest('The report definition could not be read.'); }
  const format = ctx.query.get('format') === 'xlsx' ? 'xlsx' : 'csv';
  const result = await runReport(ctx.companyId!, body);
  const header = result.columns.map((c) => c.label);
  const rows: (string | number | null)[][] = [header, ...result.rows.map((r) => r.map((v, i) => exportCell(v, result.columns[i].type)))];
  if (result.totalsRow) rows.push(result.totalsRow.map((v, i) => (typeof v === 'number' ? exportCell(v, result.columns[i].type) : (v as string))));
  const name = (ctx.query.get('name') || DATASETS.find((d) => d.key === result.spec.dataset)!.label).replace(/[^\w.-]+/g, '_');
  const fileName = `${name}_${result.spec.asOf}.${format}`;
  const content = format === 'xlsx' ? xlsx([{ name: DATASETS.find((d) => d.key === result.spec.dataset)!.label, rows }]) : Buffer.from(`﻿${csvText(rows)}`, 'utf8');
  ctx.res.writeHead(200, {
    'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
    'Content-Length': content.length, 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'private, no-store',
  });
  ctx.res.end(content);
  await audit(ctx, 'EXPORT', 'reports', null, `Custom report exported (${result.spec.dataset}, ${result.total} rows, ${format})`);
  return undefined;
});

route.post('/api/c/:cid/report-builder/saved', 'write', async (ctx) => {
  const { spec } = readSpec((ctx.body.config ?? {}) as Record<string, unknown>);
  const id = newId('rpt');
  await insert('saved_reports', { id, companyId: ctx.companyId, name: str(ctx.body.name, 'Name', { max: 120 }), dataset: spec.dataset, config: JSON.stringify(spec), createdBy: ctx.user!.name, createdAt: nowISO() });
  await audit(ctx, 'CREATE', 'saved_reports', id, `Report "${ctx.body.name}" saved`);
  return { ...toCamel<Row>(await one('SELECT * FROM saved_reports WHERE id = ?', id)), config: spec };
});

route.patch('/api/c/:cid/report-builder/saved/:id', 'write', async (ctx) => {
  const existing = await one<Row>('SELECT * FROM saved_reports WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!existing) throw notFound('Saved report not found.');
  const values: Row = { updatedAt: nowISO() };
  if (ctx.body.name != null) values.name = str(ctx.body.name, 'Name', { max: 120 });
  if (ctx.body.config != null) { const { spec } = readSpec(ctx.body.config as Record<string, unknown>); values.config = JSON.stringify(spec); values.dataset = spec.dataset; }
  await update('saved_reports', ctx.params.id, values);
  const row = toCamel<Row>(await one('SELECT * FROM saved_reports WHERE id = ?', ctx.params.id))!;
  return { ...row, config: JSON.parse(String(row.config)) };
});

route.del('/api/c/:cid/report-builder/saved/:id', 'write', async (ctx) => {
  const existing = await one<Row>('SELECT * FROM saved_reports WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!existing) throw notFound('Saved report not found.');
  await run('DELETE FROM saved_reports WHERE id = ?', ctx.params.id);
  await audit(ctx, 'DELETE', 'saved_reports', ctx.params.id, `Report "${existing.name}" deleted`);
  return { ok: true };
});
