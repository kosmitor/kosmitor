import { all, toCamelAll, inTransaction, concurrently } from './db.ts';
import type { CompanyData } from '@kosmitor/core';

const bool = (v: unknown): boolean => v === 1 || v === true;
const json = <T>(v: unknown, fallback: T): T => {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
};

/**
 * Loads everything the engine needs for a company in one pass.
 *
 * The engine is pure and works on an in-memory snapshot, so every computation
 * (cap table, waterfall, compliance) reads a single consistent view rather than
 * issuing queries mid-calculation. The table reads run concurrently, except
 * inside a transaction, whose one connection takes them in turn.
 */
export async function loadCompanyData(companyId: string): Promise<CompanyData> {
  const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => toCamelAll<T>(await all(sql, companyId));

  const [shareClasses, stakeholders, issuances, awards, pools, poolAdjustments, warrants, convertibles,
         vestingSchedules, valuations, stockSplits, exercises, filings, transactions] = await concurrently([
    () => q('SELECT * FROM share_classes WHERE company_id = ? ORDER BY seniority DESC, sort_order, issue_date'),
    () => q('SELECT * FROM stakeholders WHERE company_id = ? ORDER BY name'),
    () => q('SELECT * FROM issuances WHERE company_id = ? ORDER BY issue_date, certificate_no'),
    () => q('SELECT * FROM awards WHERE company_id = ? ORDER BY grant_date, label'),
    () => q('SELECT * FROM pools WHERE company_id = ? ORDER BY created_at'),
    () => q('SELECT * FROM pool_adjustments WHERE company_id = ? ORDER BY date'),
    () => q('SELECT * FROM warrants WHERE company_id = ? ORDER BY issue_date'),
    () => q('SELECT * FROM convertibles WHERE company_id = ? ORDER BY issue_date'),
    () => q('SELECT * FROM vesting_schedules WHERE company_id = ? ORDER BY name'),
    () => q('SELECT * FROM valuations WHERE company_id = ? ORDER BY effective_date DESC'),
    () => q('SELECT * FROM stock_splits WHERE company_id = ? ORDER BY date'),
    () => q('SELECT * FROM exercises WHERE company_id = ? ORDER BY exercise_date, created_at'),
    () => q('SELECT * FROM compliance_filings WHERE company_id = ? ORDER BY filed_on, created_at'),
    // What happened to each security since it was issued, which the engine undoes
    // for a view of an earlier date (rewindToDate in @kosmitor/core).
    () => q('SELECT id, type, date, security_id, quantity, adopted_security_id FROM transactions WHERE company_id = ? AND security_id IS NOT NULL ORDER BY date, created_at'),
  ]);

  return companyDataFromRows({
    shareClasses, stakeholders, issuances, awards, pools, poolAdjustments, warrants, convertibles,
    vestingSchedules, valuations, stockSplits, exercises, filings, transactions,
  });
}

type Row = Record<string, unknown>;

/**
 * A company's tables as rows with camelCase columns, the way loadCompanyData() reads them or an import would write them.
 * Without `transactions` the snapshot has no ledger, and a view of an earlier date reads the rows as they are.
 */
export interface CompanyRows {
  shareClasses: Row[]; stakeholders: Row[]; issuances: Row[]; awards: Row[]; pools: Row[]; poolAdjustments: Row[];
  warrants: Row[]; convertibles: Row[]; vestingSchedules: Row[]; valuations: Row[]; stockSplits: Row[];
  exercises: Row[]; filings: Row[]; transactions?: Row[];
}

/**
 * Stored rows in the engine's shapes. The reconcile tool passes rows it holds in
 * memory, so an export it reads becomes exactly what the app would compute from.
 */
export function companyDataFromRows(rows: CompanyRows): CompanyData {
  const { shareClasses, stakeholders, issuances, awards, pools, poolAdjustments, warrants, convertibles,
    vestingSchedules, valuations, stockSplits, exercises, filings, transactions } = rows;
  return {
    shareClasses: shareClasses.map((r) => ({
      id: r.id as string, name: r.name as string, kind: r.kind as 'COMMON' | 'PREFERRED',
      authorized: Number(r.authorized), parValue: Number(r.parValue),
      seniority: Number(r.seniority), originalIssuePrice: Number(r.originalIssuePrice),
      liquidationMultiple: Number(r.liquidationMultiple),
      participation: r.participation as never,
      participationCap: r.participationCap == null ? null : Number(r.participationCap),
      conversionRatio: Number(r.conversionRatio),
      dividendType: r.dividendType as never, dividendRate: Number(r.dividendRate),
      dividendCompounding: bool(r.dividendCompounding),
      dividendsParticipateInResidual: bool(r.dividendsParticipate),
      votesPerShare: Number(r.votesPerShare), antiDilution: r.antiDilution as never,
      payToPlay: bool(r.payToPlay), issueDate: r.issueDate as string,
      isConvertible: bool(r.isConvertible),
    })),
    stakeholders: stakeholders.map((r) => ({
      id: r.id as string, name: r.name as string, email: (r.email as string) ?? null,
      type: r.type as never, relation: r.relation as never,
      startDate: (r.startDate as string) ?? null, terminationDate: (r.terminationDate as string) ?? null,
      taxCountry: (r.taxCountry as string) ?? null, taxState: (r.taxState as string) ?? null,
      entityGroupId: (r.entityGroupId as string) ?? null,
    })),
    issuances: issuances.map((r) => ({
      id: r.id as string, certificateNo: (r.certificateNo as string) ?? null,
      stakeholderId: r.stakeholderId as string, shareClassId: r.shareClassId as string,
      quantity: Number(r.quantity), pricePerShare: Number(r.pricePerShare),
      issueDate: r.issueDate as string, status: r.status as never,
      vestingScheduleId: (r.vestingScheduleId as string) ?? null,
      vestingStartDate: (r.vestingStartDate as string) ?? null,
      earlyExercised: bool(r.earlyExercised),
      election83bFiledOn: (r.election83bFiledOn as string) ?? null,
      sourceAwardId: (r.sourceAwardId as string) ?? null,
      notes: (r.notes as string) ?? null,
    })),
    awards: awards.map((r) => ({
      id: r.id as string, label: (r.label as string) ?? null,
      stakeholderId: r.stakeholderId as string, poolId: r.poolId as string,
      type: r.type as never, quantity: Number(r.quantity),
      strikePrice: Number(r.strikePrice), grantDate: r.grantDate as string,
      vestingStartDate: r.vestingStartDate as string,
      vestingScheduleId: r.vestingScheduleId as string, status: r.status as never,
      expirationDate: (r.expirationDate as string) ?? null,
      ptepMonths: Number(r.ptepMonths), earlyExerciseAllowed: bool(r.earlyExerciseAllowed),
      exercisedQuantity: Number(r.exercisedQuantity), cancelledQuantity: Number(r.cancelledQuantity),
      boardApprovalDate: (r.boardApprovalDate as string) ?? null,
      acceptedDate: (r.acceptedDate as string) ?? null,
      fmvAtGrant: Number(r.fmvAtGrant), rsuLiquidityCondition: bool(r.rsuLiquidityCondition),
      notes: (r.notes as string) ?? null,
    })),
    pools: pools.map((r) => ({
      id: r.id as string, name: r.name as string, shareClassId: r.shareClassId as string,
      authorized: Number(r.authorized),
      boardApprovalDate: (r.boardApprovalDate as string) ?? null,
      shareholderApprovalDate: (r.shareholderApprovalDate as string) ?? null,
      returnForfeituresToPool: bool(r.returnForfeitures),
      evergreenPercent: r.evergreenPercent == null ? null : Number(r.evergreenPercent),
      planType: r.planType as never,
    })),
    poolAdjustments: poolAdjustments.map((r) => ({
      id: r.id as string, poolId: r.poolId as string, date: r.date as string,
      amount: Number(r.amount), reason: (r.reason as string) ?? '',
    })),
    warrants: warrants.map((r) => ({
      id: r.id as string, stakeholderId: r.stakeholderId as string,
      shareClassId: r.shareClassId as string, quantity: Number(r.quantity),
      strikePrice: Number(r.strikePrice), issueDate: r.issueDate as string,
      expirationDate: (r.expirationDate as string) ?? null, status: r.status as never,
      exercisedQuantity: Number(r.exercisedQuantity), netExercise: bool(r.netExercise),
      notes: (r.notes as string) ?? null,
    })),
    convertibles: convertibles.map((r) => ({
      id: r.id as string, stakeholderId: r.stakeholderId as string,
      instrument: r.instrument as never, principal: Number(r.principal),
      issueDate: r.issueDate as string,
      valuationCap: r.valuationCap == null ? null : Number(r.valuationCap),
      discount: Number(r.discount), interestRate: Number(r.interestRate),
      compounding: r.compounding as never,
      maturityDate: (r.maturityDate as string) ?? null,
      mfn: bool(r.mfn), proRataRight: bool(r.proRataRight), status: r.status as never,
      label: (r.label as string) ?? null,
      convertedIntoShareClassId: (r.convertedIntoShareClassId as string) ?? null,
      convertedOn: (r.convertedOn as string) ?? null,
      qualifiedFinancingMinimum: r.qualifiedFinancingMinimum == null ? null : Number(r.qualifiedFinancingMinimum),
      notes: (r.notes as string) ?? null,
    })),
    vestingSchedules: vestingSchedules.map((r) => ({
      id: r.id as string, name: r.name as string, kind: r.kind as never,
      durationMonths: Number(r.durationMonths), cliffMonths: Number(r.cliffMonths),
      frequency: r.frequency as never, immediatePortion: Number(r.immediatePortion),
      yearWeights: json<number[] | null>(r.yearWeights, null),
      milestones: json<never>(r.milestones, null as never),
      customTranches: json<never>(r.customTranches, null as never),
      accelerationSingleTrigger: Number(r.accelerationSingle),
      accelerationDoubleTrigger: Number(r.accelerationDouble),
      accelerationMonths: r.accelerationMonths == null ? null : Number(r.accelerationMonths),
    })),
    valuations: valuations.map((r) => ({
      id: r.id as string, type: r.type as never,
      fairMarketValue: Number(r.fairMarketValue), effectiveDate: r.effectiveDate as string,
      expirationDate: (r.expirationDate as string) ?? null,
      provider: (r.provider as string) ?? null, reportUrl: (r.reportUrl as string) ?? null,
      status: r.status as never,
    })),
    stockSplits: stockSplits.map((r) => ({ id: r.id as string, date: r.date as string, ratio: Number(r.ratio) })),
    exercises: exercises.map((r) => ({
      id: r.id as string, awardId: r.awardId as string, stakeholderId: r.stakeholderId as string, quantity: Number(r.quantity),
      exerciseDate: r.exerciseDate as string, method: (r.method as string) ?? 'CASH', strikePrice: Number(r.strikePrice),
      fmvAtExercise: Number(r.fmvAtExercise ?? 0), sharesIssued: Number(r.sharesIssued ?? r.quantity), status: (r.status as string) ?? 'COMPLETED',
    })),
    filings: filings.map((r) => ({
      id: r.id as string, kind: r.kind as 'FORM_3921' | 'BOI', period: r.period as string, filedOn: r.filedOn as string,
      reference: (r.reference as string) ?? null, notes: (r.notes as string) ?? null,
    })),
    ...(transactions ? {
      ledger: transactions.filter((r) => r.securityId != null).map((r) => ({
        id: r.id as string, type: r.type as never, date: r.date as string, securityId: r.securityId as string,
        quantity: r.quantity == null ? null : Number(r.quantity),
        ...(r.adoptedSecurityId ? { adoptedId: r.adoptedSecurityId as string } : {}),
      })),
    } : {}),
  };
}

/** Small cache so a dashboard request does not reload the snapshot ten times. */
const cache = new Map<string, { data: Promise<CompanyData>; at: number }>();
const TTL_MS = 250;

export function getCompanyData(companyId: string): Promise<CompanyData> {
  // Never publish an uncommitted snapshot, or reuse one while processing a write.
  if (inTransaction()) return loadCompanyData(companyId);
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = loadCompanyData(companyId);
  cache.set(companyId, { data, at: Date.now() });
  data.catch(() => { if (cache.get(companyId)?.data === data) cache.delete(companyId); });
  return data;
}

export function invalidate(companyId: string): void {
  cache.delete(companyId);
}

/**
 * When each grant was first cancelled, forfeited or expired, by award id, from
 * the ledger. The stock comp report and the ISO $100K test place a cancellation
 * in its year with it.
 */
export async function cancellationDates(companyId: string): Promise<Record<string, string>> {
  const rows = await all<{ security_id: string; date: string }>(
    "SELECT security_id, MIN(date) AS date FROM transactions WHERE company_id = ? AND type IN ('CANCELLATION', 'FORFEITURE', 'EXPIRATION') GROUP BY security_id", companyId);
  return Object.fromEntries(rows.map((r) => [r.security_id, r.date]));
}

/**
 * Every cancellation, forfeiture and expiry of each grant dated on or before
 * `asOf`, oldest first, each quantity in the shares of its own date as the
 * ledger records it. A grant cancelled in two steps reverses its cost from
 * each date in turn, not all of it from the first (math audit VA-18).
 */
export async function cancellationsOf(companyId: string, asOf: string): Promise<Record<string, { date: string; quantity: number }[]>> {
  const rows = await all<{ security_id: string; date: string; quantity: number | null }>(
    "SELECT security_id, date, quantity FROM transactions WHERE company_id = ? AND type IN ('CANCELLATION', 'FORFEITURE', 'EXPIRATION') AND security_id IS NOT NULL AND date <= ? ORDER BY date, created_at",
    companyId, asOf);
  const out: Record<string, { date: string; quantity: number }[]> = {};
  for (const r of rows) (out[r.security_id] ??= []).push({ date: r.date, quantity: Number(r.quantity ?? 0) });
  return out;
}
