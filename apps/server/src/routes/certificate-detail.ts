/**
 * Everything one share certificate is, gathered in a single request.
 *
 * The page that reads this shows the numbers, the terms the holder signed under,
 * the vesting position, the 83(b) position and the history of the shares. All of
 * it exists already, scattered across the issuance row, the share class, the
 * vesting engine, the document vault and the ledger, and assembling it here
 * rather than in the browser keeps the page to one request and keeps the
 * arithmetic in the engine where it belongs.
 */
import { route, notFound } from '../http.ts';
import { one, toCamel } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { documentsFor, timelineFor, holderOf, hiddenFrom } from './detail-shared.ts';
import {
  computeCapTable, summarizeVesting, vestingCurve, activeValuation, today, shareValue, businessDayOnOrAfter,
} from '@kosmitor/core';

/**
 * An 83(b) election must be filed within 30 days of the transfer. A thirtieth day on a
 * weekend or a legal holiday moves to the next business day (IRC 7503), the same rule
 * the compliance page applies, so both pages give the same date.
 */
const ELECTION_DAYS = 30;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

route.get('/api/c/:cid/issuances/:id/detail', 'read', async (ctx) => {
  const row = toCamel<Record<string, any>>(
    await one('SELECT * FROM issuances WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!row) throw notFound('Certificate not found.');

  // A holder may only open their own certificate; the wider roles see any of them.
  if (hiddenFrom(ctx, String(row.stakeholderId))) throw notFound('Certificate not found.');

  const data = await getCompanyData(ctx.companyId!);
  const asOf = today();
  const stakeholder = data.stakeholders.find((s) => s.id === row.stakeholderId) ?? null;
  const shareClass = data.shareClasses.find((c) => c.id === row.shareClassId) ?? null;
  // The legend is paperwork rather than arithmetic, so the engine's share class
  // does not carry it and it is read from the row itself.
  const classRow = toCamel<Record<string, any>>(
    await one('SELECT * FROM share_classes WHERE id = ? AND company_id = ?', row.shareClassId, ctx.companyId));
  const schedule = data.vestingSchedules.find((s) => s.id === row.vestingScheduleId) ?? null;

  const table = computeCapTable(data, { asOf, includeConvertibles: true });
  const position = table.rows.find((r) => r.stakeholderId === row.stakeholderId) ?? null;
  const fmv = activeValuation(data, asOf);

  const vesting = schedule
    ? {
        scheduleName: schedule.name,
        startDate: row.vestingStartDate ?? row.issueDate,
        summary: summarizeVesting({
          schedule, totalQuantity: row.quantity,
          vestingStartDate: row.vestingStartDate ?? row.issueDate,
          terminationDate: stakeholder?.terminationDate ?? null,
        }, asOf),
        curve: vestingCurve({
          schedule, totalQuantity: row.quantity,
          vestingStartDate: row.vestingStartDate ?? row.issueDate,
          terminationDate: stakeholder?.terminationDate ?? null,
        }, 72),
        acceleration: {
          single: schedule.accelerationSingleTrigger,
          double: schedule.accelerationDoubleTrigger,
          months: schedule.accelerationMonths,
        },
      }
    : null;

  const documents = await documentsFor(ctx, String(row.id));
  const certificate = documents.find((d) => d.category === 'CERTIFICATE') ?? null;

  // Restricted stock is what an 83(b) election is for; unrestricted shares never needed one.
  const restricted = !!row.vestingScheduleId || !!row.earlyExercised;
  const election83b = {
    relevant: restricted,
    filedOn: row.election83bFiledOn ?? null,
    dueBy: restricted ? businessDayOnOrAfter(addDays(String(row.issueDate), ELECTION_DAYS)) : null,
    overdue: restricted && !row.election83bFiledOn && businessDayOnOrAfter(addDays(String(row.issueDate), ELECTION_DAYS)) < asOf,
    document: documents.find((d) => d.category === 'TAX') ?? null,
  };

  const timeline = await timelineFor(ctx, String(row.id), documents);

  // Rows written before these columns existed have nothing in them, and both dates
  // start at the issue date unless someone says otherwise, so they are filled here
  // rather than showing a dash on every certificate the company already had.
  const issuance = {
    ...row,
    holdingStartDate: row.holdingStartDate ?? row.issueDate,
    rule144Date: row.rule144Date ?? row.holdingStartDate ?? row.issueDate,
  };

  return {
    issuance,
    stakeholder: holderOf(data, String(row.stakeholderId)),
    shareClass: shareClass
      ? { id: shareClass.id, name: shareClass.name, kind: shareClass.kind, parValue: shareClass.parValue, legend: classRow?.legend ?? null }
      : null,
    amounts: {
      capitalContribution: Math.round((Number(row.quantity) * Number(row.pricePerShare)) / 1e4),
      currentValue: shareValue(Number(row.quantity), fmv),
      fmv,
      holderFullyDiluted: position?.fullyDiluted ?? 0,
      holderFullyDilutedPct: position?.fullyDilutedPct ?? 0,
      companyFullyDiluted: table.totals.fullyDiluted,
      pctOfCompany: table.totals.fullyDiluted > 0 ? Number(row.quantity) / table.totals.fullyDiluted : 0,
    },
    vesting,
    certificate,
    documents,
    election83b,
    timeline,
  };
});
