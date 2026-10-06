/**
 * The cap table as an Excel workbook or a PDF, matching what the page shows:
 * the same as-of date, view, convertibles, unallocated pool and entity
 * grouping. The workbook adds a share-class sheet and a summary sheet; the
 * PDF is a print-ready landscape table with the company's totals.
 */
import { route, audit, badRequest } from '../http.ts';
import { one } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { computeCapTable, today, type CapTable, type CapTableRow } from '@kosmitor/core';
import { xlsx, type Cell } from '../xlsx-writer.ts';
import { tablePdf, type PdfRow } from '../pdf-writer.ts';
import { config } from '../config.ts';
import { seesWholeCompany } from '../auth.ts';

type View = 'FULLY_DILUTED' | 'OUTSTANDING' | 'AS_CONVERTED' | 'VOTING';
const VIEW_LABELS: Record<View, string> = { FULLY_DILUTED: 'Fully diluted', OUTSTANDING: 'Outstanding', AS_CONVERTED: 'As converted', VOTING: 'Voting' };
const RELATION_LABELS: Record<string, string> = {
  FOUNDER: 'Founder', EMPLOYEE: 'Employee', INVESTOR: 'Investor', ADVISOR: 'Advisor', BOARD_MEMBER: 'Board member',
  CONSULTANT: 'Consultant', CONTRACTOR: 'Contractor', ENTITY: 'Entity', FORMER_EMPLOYEE: 'Former employee', OTHER: 'Other',
};

interface ExportOptions { asOf: string; view: View; includeConvertibles: boolean; includePool: boolean; groupEntities: boolean }

const flag = (ctx: { query: URLSearchParams }, key: string, dflt: boolean): boolean => {
  const v = ctx.query.get(key);
  return v == null ? dflt : v === 'true' || v === '1';
};

function optionsOf(ctx: { query: URLSearchParams; membership: { role: string } | null }): ExportOptions {
  if (!seesWholeCompany(ctx.membership?.role ?? '')) {
    throw badRequest('Your role can only view your own holdings.');
  }
  const view = (ctx.query.get('view') ?? 'FULLY_DILUTED') as View;
  if (!(view in VIEW_LABELS)) throw badRequest('Unknown cap table view.');
  return {
    asOf: ctx.query.get('asOf') || today(),
    view,
    includeConvertibles: flag(ctx, 'includeConvertibles', false),
    includePool: flag(ctx, 'includePool', true),
    groupEntities: flag(ctx, 'groupEntities', false),
  };
}

const relation = (r: string | null | undefined): string => (r ? RELATION_LABELS[r] ?? r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ') : '');
// Numbers and money are written the way locale.locale and locale.currency say. A
// formatter is costly to build and a table formats every cell, so each is kept.
const formats = new Map<string, Intl.NumberFormat>();
function formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const { locale } = config().locale;
  const key = `${locale} ${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) formats.set(key, format = new Intl.NumberFormat(locale, options));
  return format;
}
const moneyFormat = (digits: number, grouping = true): Intl.NumberFormat =>
  formatter({ style: 'currency', currency: config().locale.currency, minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: grouping });
const shares = (n: number): string => formatter({}).format(Math.round(n));
const pct = (fraction: number): string => formatter({ style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(fraction);
const money = (cents: number): string => moneyFormat(0).format(Math.round(cents / 100));
/** The currency's symbol, for column headings such as "Invested ($)". */
const symbol = (): string => moneyFormat(0).formatToParts(0).find((p) => p.type === 'currency')?.value ?? config().locale.currency;
const round = (n: number, places: number): number => Number(n.toFixed(places));

/** The table body in numbers, shared by both formats; the formats decide how to print them. */
function tableRows(table: CapTable, o: ExportOptions) {
  const t = table.totals;
  const sharesOf = (r: CapTableRow): number => ({ FULLY_DILUTED: r.fullyDiluted, OUTSTANDING: r.outstanding, AS_CONVERTED: r.asConverted, VOTING: r.votes })[o.view];
  const pctOf = (r: CapTableRow): number => ({ FULLY_DILUTED: r.fullyDilutedPct, OUTSTANDING: r.outstandingPct, AS_CONVERTED: r.asConvertedPct, VOTING: r.votingPct })[o.view];
  const totalShares = { FULLY_DILUTED: t.fullyDiluted, OUTSTANDING: t.outstanding, AS_CONVERTED: t.asConverted, VOTING: t.votes }[o.view];

  const columns = [
    { header: 'Holder', align: 'left' as const }, { header: 'Relationship', align: 'left' as const },
    { header: 'Shares', align: 'right' as const }, { header: 'Options', align: 'right' as const },
    { header: 'RSUs', align: 'right' as const }, { header: 'Warrants', align: 'right' as const },
    ...(o.includeConvertibles ? [{ header: 'Convertibles (as converted)', align: 'right' as const }] : []),
    { header: `${VIEW_LABELS[o.view]} shares`, align: 'right' as const }, { header: 'Ownership %', align: 'right' as const },
    { header: `Invested (${symbol()})`, align: 'right' as const }, { header: `Value (${symbol()})`, align: 'right' as const },
  ];

  type Numeric = { holder: string; relation: string; shares: number; options: number; rsus: number; warrants: number; convertibles: number | null; view: number; pct: number; invested: number | null; value: number | null; kind: 'holder' | 'pool' | 'total' };
  const body: Numeric[] = [...table.rows].sort((a, b) => sharesOf(b) - sharesOf(a)).map((r) => ({
    holder: r.name, relation: relation(r.relation), shares: r.outstanding, options: r.optionsOutstanding, rsus: r.rsusOutstanding,
    warrants: r.warrantsOutstanding, convertibles: o.includeConvertibles ? r.convertibleAsConverted : null, view: sharesOf(r), pct: pctOf(r),
    invested: r.investedAmount, value: r.currentValue, kind: 'holder',
  }));
  if (o.includePool && o.view === 'FULLY_DILUTED' && t.poolAvailable > 0) {
    body.push({ holder: 'Unallocated pool', relation: 'Plan reserve', shares: 0, options: 0, rsus: 0, warrants: 0, convertibles: o.includeConvertibles ? 0 : null,
      view: t.poolAvailable, pct: t.fullyDiluted ? t.poolAvailable / t.fullyDiluted : 0, invested: null, value: null, kind: 'pool' });
  }
  body.push({ holder: 'Total', relation: '', shares: t.outstanding, options: t.optionsOutstanding, rsus: t.rsusOutstanding, warrants: t.warrantsOutstanding,
    convertibles: o.includeConvertibles ? t.convertibleAsConverted : null, view: totalShares, pct: 1, invested: t.investedAmount, value: t.companyValue, kind: 'total' });

  const cells = (r: Numeric, fmt: 'sheet' | 'print'): Cell[] => {
    const amount = (c: number | null): Cell => (c == null ? (fmt === 'sheet' ? null : '') : fmt === 'sheet' ? round(c / 100, 2) : money(c));
    const count = (n: number | null): Cell => (n == null ? (fmt === 'sheet' ? null : '') : fmt === 'sheet' ? n : shares(n));
    return [
      r.holder, r.relation, count(r.shares), count(r.options), count(r.rsus), count(r.warrants),
      ...(o.includeConvertibles ? [count(r.convertibles)] : []),
      count(r.view), fmt === 'sheet' ? round(r.pct * 100, 4) : pct(r.pct), amount(r.invested), amount(r.value),
    ];
  };
  return { columns, body, cells };
}

async function load(ctx: { companyId: string | null; query: URLSearchParams; membership: { role: string } | null }) {
  const o = optionsOf(ctx);
  const data = await getCompanyData(ctx.companyId!);
  const table = computeCapTable(data, { asOf: o.asOf, includeConvertibles: o.includeConvertibles, includeUnallocatedPool: o.includePool, groupEntities: o.groupEntities });
  const company = await one<{ name: string; legal_name: string | null }>('SELECT name, legal_name FROM companies WHERE id = ?', ctx.companyId);
  return { o, table, company: company ?? { name: 'Company', legal_name: null } };
}

const scope = (o: ExportOptions): string =>
  `${VIEW_LABELS[o.view]} view as of ${o.asOf} · ${o.includeConvertibles ? 'including' : 'excluding'} convertibles · ${o.includePool ? 'with' : 'without'} the unallocated pool${o.groupEntities ? ' · entities grouped' : ''}`;

route.get('/api/c/:cid/captable/export.xlsx', 'read', async (ctx) => {
  const { o, table, company } = await load(ctx);
  const { columns, body, cells } = tableRows(table, o);
  const t = table.totals;
  const sign = symbol();
  const workbook = xlsx([
    { name: 'Cap table', rows: [columns.map((c) => c.header), ...body.map((r) => cells(r, 'sheet'))] },
    { name: 'Share classes', rows: [
      ['Share class', 'Type', 'Authorized', 'Outstanding', 'As converted', 'Available', 'Holders', `Issue price (${sign})`, `Invested (${sign})`, `Liquidation preference (${sign})`, 'Ownership %'],
      ...table.classes.map((c) => [c.name, c.kind === 'PREFERRED' ? 'Preferred' : 'Common', c.authorized, c.outstanding, c.asConverted, c.available, c.holders,
        round(c.pricePerShare / 1e6, 4), round(c.investedAmount / 100, 2), round(c.liquidationPreference / 100, 2), round(c.ownershipPct * 100, 4)]),
    ] },
    { name: 'Summary', rows: [
      ['Company', company.name], ['Legal name', company.legal_name ?? ''], ['As of', o.asOf], ['View', VIEW_LABELS[o.view]],
      ['Includes convertibles', o.includeConvertibles ? 'Yes' : 'No'], ['Includes unallocated pool', o.includePool ? 'Yes' : 'No'], ['Entities grouped', o.groupEntities ? 'Yes' : 'No'],
      [], ['Fully diluted shares', t.fullyDiluted], ['Outstanding shares', t.outstanding], ['As-converted shares', t.asConverted], ['Options outstanding', t.optionsOutstanding],
      ['Options vested', t.optionsVested], ['RSUs outstanding', t.rsusOutstanding], ['Warrants outstanding', t.warrantsOutstanding], ['Pool available', t.poolAvailable],
      ['Authorized shares', t.authorized], [`Price per share used for values (${sign})`, round(t.valuationPPS / 1e6, 4)], [`Company value (${sign})`, round(t.companyValue / 100, 2)],
      [`Invested (${sign})`, round(t.investedAmount / 100, 2)], [], ['Generated', new Date().toISOString()], ['Generated by', config().brand.productName],
      ...(table.warnings.length ? [[], ['Warnings'], ...table.warnings.map((w) => [w])] : []),
    ] },
  ]);
  await audit(ctx, 'EXPORT', 'reports', 'captable', 'Cap table exported as Excel');
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="cap-table-${o.asOf}.xlsx"`,
    'Content-Length': workbook.length,
  });
  ctx.res.end(workbook);
  return undefined;
});

route.get('/api/c/:cid/captable/export.pdf', 'read', async (ctx) => {
  const { o, table, company } = await load(ctx);
  const { columns, body, cells } = tableRows(table, o);
  const t = table.totals;
  const rows: PdfRow[] = body.map((r) => ({ cells: cells(r, 'print').map((c) => String(c ?? '')), bold: r.kind === 'total', muted: r.kind === 'pool' }));
  const notes = [
    `Values use a price of ${moneyFormat(4, false).format(t.valuationPPS / 1e6)} per share${t.valuationPPS ? ' from the company’s valuation record' : ''}; company value ${money(t.companyValue)}, total invested ${money(t.investedAmount)}.`,
    `${shares(t.authorized)} shares authorized · ${shares(t.outstanding)} outstanding · ${shares(t.optionsOutstanding)} options outstanding (${shares(t.optionsVested)} vested) · ${shares(t.poolAvailable)} available in the plan reserve.`,
    ...table.warnings,
  ];
  const pdf = tablePdf({
    title: `${company.name} — Cap table`,
    subtitle: `${company.legal_name && company.legal_name !== company.name ? `${company.legal_name} · ` : ''}${scope(o)}`,
    columns, rows, notes,
    footer: `${config().brand.productName} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  });
  await audit(ctx, 'EXPORT', 'reports', 'captable', 'Cap table exported as PDF');
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="cap-table-${o.asOf}.pdf"`,
    'Content-Length': pdf.length,
  });
  ctx.res.end(pdf);
  return undefined;
});
