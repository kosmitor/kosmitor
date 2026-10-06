/**
 * The record page behind an equity award, a convertible and a warrant.
 *
 * Each one answers the same shape of question as a certificate does: what is
 * this, who holds it, what is it worth, what has to happen to it next, and what
 * has happened to it already. The engine does every calculation, so the browser
 * receives figures rather than rows to add up, and the three routes differ only
 * where the instruments themselves differ.
 */
import { route, notFound } from '../http.ts';
import { all, one, toCamel, toCamelAll } from '../db.ts';
import { getCompanyData, cancellationDates } from '../store.ts';
import { documentsFor, timelineFor, holderOf, hiddenFrom } from './detail-shared.ts';
import { reportDocumentOf } from './valuation-report.ts';
import { config } from '../config.ts';
import {
  computeCapTable, computePoolSummaries, summarizeVesting, vestingCurve, awardPosition, awardIsLive,
  isoHundredKTest, modelConvertibleStack, activeValuation, today, shareValue, addMonths, splitFactor,
} from '@ct/core';

// --- Equity award -----------------------------------------------------------

route.get('/api/c/:cid/awards/:id/detail', 'read', async (ctx) => {
  const row = toCamel<Record<string, any>>(
    await one('SELECT * FROM awards WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!row || hiddenFrom(ctx, String(row.stakeholderId))) throw notFound('Equity award not found.');

  const data = await getCompanyData(ctx.companyId!);
  const asOf = today();
  const award = data.awards.find((a) => a.id === row.id);
  const holder = data.stakeholders.find((s) => s.id === row.stakeholderId) ?? null;
  const schedule = data.vestingSchedules.find((s) => s.id === row.vestingScheduleId) ?? null;
  const pool = computePoolSummaries(data, asOf).find((p) => p.poolId === row.poolId) ?? null;
  const fmv = activeValuation(data, asOf);

  // As the cap table counts it: once the holder has left, only what had vested.
  const outstanding = award ? awardPosition(award, schedule, holder?.terminationDate, asOf).outstanding : 0;
  const vesting = schedule
    ? {
        scheduleName: schedule.name,
        startDate: row.vestingStartDate ?? row.grantDate,
        summary: summarizeVesting({
          schedule, totalQuantity: Number(row.quantity),
          vestingStartDate: String(row.vestingStartDate ?? row.grantDate),
          terminationDate: holder?.terminationDate ?? null,
        }, asOf),
        curve: vestingCurve({
          schedule, totalQuantity: Number(row.quantity),
          vestingStartDate: String(row.vestingStartDate ?? row.grantDate),
          terminationDate: holder?.terminationDate ?? null,
        }, 72),
        acceleration: {
          single: schedule.accelerationSingleTrigger,
          double: schedule.accelerationDoubleTrigger,
          months: schedule.accelerationMonths,
        },
      }
    : null;

  // An option is only exercisable while the contract says so, and leaving a
  // company starts a clock that most people do not know is running. A grant that
  // records no window has equity.postTerminationExerciseMonths.
  const ptepMonths = Number(row.ptepMonths ?? config().equity.postTerminationExerciseMonths);
  const deadline = holder?.terminationDate ? addMonths(holder.terminationDate, ptepMonths) : null;
  const exercisable = {
    live: award ? awardIsLive(award, asOf, holder?.terminationDate ?? null) : false,
    expiresOn: row.expirationDate ?? null,
    postTerminationDeadline: deadline,
    postTerminationMonths: ptepMonths,
  };

  // Only incentive stock options are subject to the hundred thousand dollar limit.
  const isoLimit = row.type === 'ISO'
    ? isoHundredKTest(data, asOf, { cancellationDates: await cancellationDates(ctx.companyId!) }).filter((r) => r.stakeholderId === row.stakeholderId)
    : [];

  const spread = Math.max(0, fmv - Number(row.strikePrice ?? 0));
  const documents = await documentsFor(ctx, String(row.id));
  const requests = toCamelAll<Record<string, any>>(
    await all('SELECT * FROM exercise_requests WHERE company_id = ? AND award_id = ? ORDER BY created_at DESC', ctx.companyId, row.id));

  return {
    award: row,
    holder: holderOf(data, String(row.stakeholderId)),
    plan: pool,
    amounts: {
      outstanding,
      exercised: Number(row.exercisedQuantity ?? 0),
      cancelled: Number(row.cancelledQuantity ?? 0),
      strikePrice: Number(row.strikePrice ?? 0),
      fmvAtGrant: Number(row.fmvAtGrant ?? 0),
      fmv,
      spreadPerShare: spread,
      intrinsicValue: shareValue(outstanding, spread),
      costToExercise: shareValue(outstanding, Number(row.strikePrice ?? 0)),
      underwater: fmv > 0 && fmv < Number(row.strikePrice ?? 0),
    },
    vesting,
    exercisable,
    isoLimit,
    exerciseRequests: requests,
    documents,
    timeline: await timelineFor(ctx, String(row.id), documents),
  };
});

// --- Convertible: SAFE, note or KISS ----------------------------------------

route.get('/api/c/:cid/convertibles/:id/detail', 'read', async (ctx) => {
  const row = toCamel<Record<string, any>>(
    await one('SELECT * FROM convertibles WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!row || hiddenFrom(ctx, String(row.stakeholderId))) throw notFound('Convertible not found.');

  const data = await getCompanyData(ctx.companyId!);
  const asOf = today();
  const table = computeCapTable(data, { asOf, includeConvertibles: true });
  const holderRow = table.rows.find((r) => r.stakeholderId === row.stakeholderId) ?? null;

  // What this instrument turns into if it converted today, from the same solver
  // the cap table uses, so the page and the table can never disagree.
  const stack = modelConvertibleStack(data, asOf);
  const modelled = stack.instruments.find((i) => i.id === row.id) ?? null;

  const documents = await documentsFor(ctx, String(row.id));
  return {
    convertible: row,
    holder: holderOf(data, String(row.stakeholderId)),
    conversion: modelled,
    amounts: {
      principal: Number(row.principal ?? 0),
      valuationCap: row.valuationCap == null ? null : Number(row.valuationCap),
      discount: Number(row.discount ?? 0),
      interestRate: Number(row.interestRate ?? 0),
      holderFullyDiluted: holderRow?.fullyDiluted ?? 0,
      holderFullyDilutedPct: holderRow?.fullyDilutedPct ?? 0,
    },
    documents,
    timeline: await timelineFor(ctx, String(row.id), documents),
  };
});

// --- Warrant ----------------------------------------------------------------

route.get('/api/c/:cid/warrants/:id/detail', 'read', async (ctx) => {
  const row = toCamel<Record<string, any>>(
    await one('SELECT * FROM warrants WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!row || hiddenFrom(ctx, String(row.stakeholderId))) throw notFound('Warrant not found.');

  const data = await getCompanyData(ctx.companyId!);
  const asOf = today();
  const shareClass = data.shareClasses.find((c) => c.id === row.shareClassId) ?? null;
  const fmv = activeValuation(data, asOf);
  const outstanding = Math.max(0, Number(row.quantity ?? 0) - Number(row.exercisedQuantity ?? 0));
  const spread = Math.max(0, fmv - Number(row.strikePrice ?? 0));

  const documents = await documentsFor(ctx, String(row.id));
  return {
    warrant: row,
    holder: holderOf(data, String(row.stakeholderId)),
    shareClass: shareClass ? { id: shareClass.id, name: shareClass.name, kind: shareClass.kind } : null,
    amounts: {
      outstanding,
      exercised: Number(row.exercisedQuantity ?? 0),
      strikePrice: Number(row.strikePrice ?? 0),
      fmv,
      spreadPerShare: spread,
      intrinsicValue: shareValue(outstanding, spread),
      costToExercise: shareValue(outstanding, Number(row.strikePrice ?? 0)),
      underwater: fmv > 0 && fmv < Number(row.strikePrice ?? 0),
      expired: !!row.expirationDate && String(row.expirationDate) < asOf,
    },
    documents,
    timeline: await timelineFor(ctx, String(row.id), documents),
  };
});

// --- 409A valuation ---------------------------------------------------------
// The one compliance record that is a row rather than a calculation, so it is the
// one that can have a page of its own. Everything else under compliance is
// derived, and its rows link through to the certificate, grant or holder behind them.

route.get('/api/c/:cid/valuations/:id/detail', 'read', async (ctx) => {
  const row = toCamel<Record<string, any>>(
    await one('SELECT * FROM valuations WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!row) throw notFound('Valuation not found.');
  if (!['ADMIN', 'LEGAL', 'BOARD', 'VIEWER'].includes(ctx.membership!.role)) throw notFound('Valuation not found.');

  const data = await getCompanyData(ctx.companyId!);
  const effective = String(row.effectiveDate);
  const table = computeCapTable(data, { asOf: effective, includeConvertibles: true });

  // A valuation exists to price option grants, so the useful question is which
  // grants relied on it: those made while it was the most recent one.
  const later = data.valuations
    .filter((v) => v.status !== 'DRAFT' && v.effectiveDate > effective)
    .map((v) => v.effectiveDate)
    .sort()[0] ?? null;
  const priced = data.awards
    .filter((a) => a.grantDate >= effective && (later == null || a.grantDate < later))
    .map((a) => ({
      id: a.id, label: a.label, type: a.type, quantity: a.quantity, strikePrice: a.strikePrice,
      grantDate: a.grantDate,
      holder: data.stakeholders.find((s) => s.id === a.stakeholderId)?.name ?? 'unknown',
      // In the shares of the grant date: a split between the two divides the
      // valuation, quoted then as the app quotes any price, to the micro-cent.
      belowFairMarketValue: a.strikePrice < Math.round(Number(row.fairMarketValue ?? 0) / splitFactor(data, effective, a.grantDate)),
    }));

  // The company's valuation paperwork, as the vault would show it to this reader,
  // and without the bodies: the page only needs to know whether one can be read.
  const wide = ['ADMIN', 'LEGAL', 'BOARD'].includes(ctx.membership!.role);
  const documents = toCamelAll<Record<string, any>>(await all(
    `SELECT id, name, category, folder, status, file_name, mime_type, size_bytes, visibility, created_by, created_at,
            (body IS NOT NULL AND body <> '') AS has_body
     FROM documents WHERE company_id = ? AND category = 'VALUATION'
       ${wide ? '' : "AND (visibility = 'ALL' OR stakeholder_id = ?)"}
     ORDER BY created_at DESC`, ctx.companyId, ...(wide ? [] : [ctx.membership!.stakeholderId])));

  return {
    valuation: row,
    reportDocument: await reportDocumentOf(ctx.companyId!, row.reportDocumentId ?? null, ctx.membership!.role, ctx.membership!.stakeholderId),
    supersededBy: later,
    /** Still the price a new grant would use when nothing later has replaced it. */
    current: later == null && row.status !== 'DRAFT',
    company: {
      fullyDilutedAtEffective: table.totals.fullyDiluted,
      impliedValue: shareValue(table.totals.fullyDiluted, Number(row.fairMarketValue ?? 0)),
    },
    pricedGrants: priced,
    documents,
  };
});
