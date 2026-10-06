import { route, assertFullView, badRequest, notFound, newId, nowISO, audit } from '../http.ts';
import { all, one, insert, update, run, toCamel, toCamelAll } from '../db.ts';
import { getCompanyData, invalidate, cancellationDates, cancellationsOf } from '../store.ts';
import { toCsv } from '../import/csv.ts';
import { config } from '../config.ts';
import { seesWholeCompany } from '../auth.ts';
import {
  computeCapTable, ownershipByGroup, dilutionHistory, stakeholderPosition, computePoolSummaries,
  modelRound, computeAntiDilution, modelConvertibleStack,
  computeWaterfall, computeBreakpoints, waterfallCurve, stakeholderExitCurve,
  complianceSummary, isoHundredKTest, rule701Test,
  modelExercise, modelSaleProceeds, portfolioValue, assessQSBS, splitFactor, normalizeSplits, roundShares,
  summarizeVesting, vestingCurve, activeValuation, today, addMonths,
  formatShares, formatPPS, formatMoney, formatPct,
  type CompanyData, type Award,
  election83bRows, form3921Rows, form3921Status, form3921Deadlines, beneficialOwnershipReport, type BoiStatus,
  stockCompReport, type StockCompAssumptions,
} from '@kosmitor/core';

const asOfOf = (ctx: { query: URLSearchParams }): string => ctx.query.get('asOf') || today();
const flag = (ctx: { query: URLSearchParams }, key: string, dflt: boolean): boolean => {
  const v = ctx.query.get(key);
  return v == null ? dflt : v === 'true' || v === '1';
};

/** What a member who sees only their own position is told. */
const OWN_POSITION_ONLY = 'Your role can only view your own holdings. Open the Portfolio tab instead.';

// --- Cap table -------------------------------------------------------------

route.get('/api/c/:cid/captable', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const table = computeCapTable(data, {
    asOf: asOfOf(ctx),
    includeConvertibles: flag(ctx, 'includeConvertibles', false),
    includeUnallocatedPool: flag(ctx, 'includePool', true),
    groupEntities: flag(ctx, 'groupEntities', false),
  });
  return { table, groups: ownershipByGroup(table) };
});

route.get('/api/c/:cid/dashboard', 'read', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const table = computeCapTable(data, { asOf, includeConvertibles: false });
  const compliance = complianceSummary(data, await complianceOptionsFor(ctx.companyId!, asOf));
  const convertibles = modelConvertibleStack(data, asOf);
  const company = await one<{ total_assets_cents: number }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);

  const upcomingVests = data.awards
    .filter((a) => a.status === 'OUTSTANDING')
    .map((a) => {
      const schedule = data.vestingSchedules.find((s) => s.id === a.vestingScheduleId);
      if (!schedule) return null;
      const holder = data.stakeholders.find((s) => s.id === a.stakeholderId);
      const summary = summarizeVesting({
        schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate,
        terminationDate: holder?.terminationDate ?? null,
      }, asOf);
      if (!summary.nextVestDate) return null;
      return {
        awardId: a.id, label: a.label, stakeholderName: holder?.name ?? '',
        date: summary.nextVestDate, quantity: summary.nextVestQuantity,
        percentVested: summary.percentVested,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a!.date.localeCompare(b!.date))
    .slice(0, 8);

  const openTasks = toCamelAll(await all(
    "SELECT * FROM tasks WHERE company_id = ? AND status = 'OPEN' ORDER BY due_date LIMIT 8", ctx.companyId));
  const recentActivity = toCamelAll(await all(
    'SELECT * FROM audit_log WHERE company_id = ? ORDER BY created_at DESC LIMIT 12', ctx.companyId));

  return {
    asOf,
    totals: table.totals,
    groups: ownershipByGroup(table),
    classes: table.classes,
    pools: table.pools,
    topHolders: table.rows.slice(0, 8),
    compliance: { score: compliance.score, errors: compliance.errors, warnings: compliance.warnings,
                  top: compliance.issues.slice(0, 5) },
    convertibles,
    stakeholderCount: data.stakeholders.length,
    valuation: activeValuation(data, asOf),
    totalAssets: company?.total_assets_cents ?? 0,
    upcomingVests, openTasks, recentActivity,
    warnings: table.warnings,
  };
});

route.get('/api/c/:cid/captable/history', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  return dilutionHistory(await getCompanyData(ctx.companyId!));
});

route.get('/api/c/:cid/pools/summary', 'read', async (ctx) =>
  computePoolSummaries(await getCompanyData(ctx.companyId!), asOfOf(ctx)));

// --- Stakeholder detail ----------------------------------------------------

route.get('/api/c/:cid/stakeholders/:id/position', 'read', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const role = ctx.membership!.role;
  const own = ctx.membership!.stakeholderId;
  if (!seesWholeCompany(role) && own !== ctx.params.id) {
    throw badRequest('You can only view your own position.');
  }
  const position = stakeholderPosition(data, ctx.params.id, asOf);
  const portfolio = portfolioValue(data, ctx.params.id, asOf);
  const holder = data.stakeholders.find((s) => s.id === ctx.params.id);
  if (!holder) throw notFound('Stakeholder not found.');

  const grants = portfolio.grants.map((g) => {
    const schedule = data.vestingSchedules.find((s) => s.id === g.award.vestingScheduleId);
    return {
      ...g,
      schedule: schedule ?? null,
      curve: schedule
        ? vestingCurve({
            schedule, totalQuantity: g.award.quantity, vestingStartDate: g.award.vestingStartDate,
            terminationDate: holder.terminationDate,
          }, 72)
        : [],
      summary: schedule
        ? summarizeVesting({
            schedule, totalQuantity: g.award.quantity, vestingStartDate: g.award.vestingStartDate,
            terminationDate: holder.terminationDate,
          }, asOf)
        : null,
    };
  });

  return { holder, row: position.row, portfolio: { ...portfolio, grants }, issuances: position.issuances,
           convertibles: position.convertibles, warrants: position.warrants };
});

// --- Scenario modelling ----------------------------------------------------

/** Each point on a curve is a whole waterfall, so a request cannot ask for more than this many. */
const MAX_CURVE_POINTS = 200;
/** The largest exit a holder's curve is drawn to, in cents ($1 trillion): beyond it the figures stop meaning anything. */
const MAX_CURVE_EXIT = 1_000_000_000_000_00;

const curvePoints = (raw: unknown, fallback: number): number => {
  const n = Math.floor(Number(raw ?? fallback));
  return Number.isFinite(n) ? Math.min(MAX_CURVE_POINTS, Math.max(1, n)) : fallback;
};

route.post('/api/c/:cid/model/round', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const b = ctx.body ?? {};
  if (!Array.isArray(b.investors) || b.investors.length === 0) {
    throw badRequest('Add at least one investor to model the round.');
  }
  if (b.preMoney == null && b.postMoney == null) {
    throw badRequest('Enter either a pre-money or a post-money valuation.');
  }
  try {
    const result = modelRound(data, {
      name: b.name ?? 'New round',
      closeDate: b.closeDate ?? today(),
      preMoney: b.preMoney ?? undefined,
      postMoney: b.postMoney ?? undefined,
      investors: b.investors.map((i: Record<string, unknown>) => ({
        stakeholderId: (i.stakeholderId as string) ?? null,
        name: String(i.name ?? 'Investor'),
        amount: Number(i.amount ?? 0),
        discount: i.discount ? Number(i.discount) : undefined,
      })),
      targetPoolPct: Number(b.targetPoolPct ?? 0),
      poolFromPreMoney: b.poolFromPreMoney !== false,
      poolIncreaseShares: b.poolIncreaseShares ?? null,
      convertConvertibles: b.convertConvertibles !== false,
      convertibleIds: b.convertibleIds ?? null,
      capIncludesNewPool: b.capIncludesNewPool !== false,
    });
    return { result, antiDilution: computeAntiDilution(data, result) };
  } catch (err) {
    // The engine refuses terms no round can meet, such as conversions and a pool
    // that together take the whole pre-money; the person modelling needs the reason.
    if (err instanceof RangeError) throw badRequest(err.message);
    throw err;
  }
});

route.post('/api/c/:cid/model/waterfall', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const b = ctx.body ?? {};
  const exitValue = Number(b.exitValue ?? 0);
  if (exitValue <= 0) throw badRequest('Enter an exit value greater than zero.');
  const opts = {
    asOf: b.asOf ?? today(),
    transactionFees: Number(b.transactionFees ?? 0),
    escrowHoldback: Number(b.escrowHoldback ?? 0),
    accelerateUnvested: b.accelerateUnvested !== false,
    repayNotesAsDebt: b.repayNotesAsDebt !== false,
  };
  return {
    result: computeWaterfall(data, exitValue, opts),
    breakpoints: computeBreakpoints(data, opts),
    curve: waterfallCurve(data, Math.max(exitValue * 2, exitValue + 1), curvePoints(b.points, 32), opts),
  };
});

route.post('/api/c/:cid/model/exit-curve', 'read', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const stakeholderId = String(ctx.body.stakeholderId ?? ctx.membership!.stakeholderId ?? '');
  if (!stakeholderId) throw badRequest('Choose a stakeholder.');
  const role = ctx.membership!.role;
  if (!seesWholeCompany(role) && ctx.membership!.stakeholderId !== stakeholderId) {
    throw badRequest('You can only model your own outcome.');
  }
  // modeling.portalMaxExit is in dollars; the engine works in cents.
  const fallbackExit = config().modeling.portalMaxExit * 100;
  const asked = Number(ctx.body.maxExit ?? fallbackExit);
  const maxExit = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_CURVE_EXIT, asked) : fallbackExit;
  return stakeholderExitCurve(data, stakeholderId, maxExit, curvePoints(ctx.body.points, 24), { asOf: ctx.body.asOf ?? today() });
});

route.get('/api/c/:cid/model/convertibles', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  return modelConvertibleStack(await getCompanyData(ctx.companyId!), asOfOf(ctx));
});

// --- Saved scenarios -------------------------------------------------------

route.get('/api/c/:cid/scenarios', 'read', async (ctx) =>
  toCamelAll(await all('SELECT * FROM scenarios WHERE company_id = ? ORDER BY created_at DESC', ctx.companyId))
    .map((s: Record<string, unknown>) => ({ ...s, payload: JSON.parse(String(s.payload)) })));

route.post('/api/c/:cid/scenarios', 'write', async (ctx) => {
  const id = newId('scn');
  await insert('scenarios', {
    id, companyId: ctx.companyId, name: ctx.body.name ?? 'Untitled scenario',
    type: ctx.body.type ?? 'ROUND', payload: JSON.stringify(ctx.body.payload ?? {}),
    createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  await audit(ctx, 'CREATE', 'scenarios', id, `Scenario "${ctx.body.name}" saved`);
  return toCamel(await one('SELECT * FROM scenarios WHERE id = ?', id));
});

route.patch('/api/c/:cid/scenarios/:id', 'write', async (ctx) => {
  // update() matches on the id alone, so the scenario has to be confirmed as this
  // company's before anything is written. Without this an administrator of one
  // company could rewrite another company's scenario by knowing its id, and the
  // read-back below would hand them its contents. The delete route does scope.
  const existing = await one<{ id: string }>(
    'SELECT id FROM scenarios WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!existing) throw notFound('Scenario not found.');

  await update('scenarios', ctx.params.id, {
    name: ctx.body.name, payload: ctx.body.payload ? JSON.stringify(ctx.body.payload) : undefined,
    updatedAt: nowISO(),
  });
  return toCamel(await one('SELECT * FROM scenarios WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
});

route.del('/api/c/:cid/scenarios/:id', 'write', async (ctx) => {
  await run('DELETE FROM scenarios WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  return { ok: true };
});

// --- Compliance ------------------------------------------------------------

const US_STATES = /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|dc|[a-z]{2}, usa?|usa?|united states)$/i;

/** The company's BOI standing: as set by an administrator, else derived from where it was formed. */
function boiStatusOf(company: { boi_status?: string | null; jurisdiction?: string | null } | undefined): { status: BoiStatus; source: 'set' | 'derived' } {
  if (company?.boi_status) return { status: company.boi_status as BoiStatus, source: 'set' };
  const jurisdiction = (company?.jurisdiction ?? '').trim();
  const domestic = jurisdiction === '' || US_STATES.test(jurisdiction);
  return { status: domestic ? 'EXEMPT_DOMESTIC' : 'REQUIRED', source: 'derived' };
}

async function titlesOf(companyId: string): Promise<Record<string, string | null>> {
  const rows = await all<{ id: string; title: string | null }>('SELECT id, title FROM stakeholders WHERE company_id = ?', companyId);
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}

/**
 * What the checks need to know about the company beyond its records. The
 * dashboard, the Compliance page and the assistant's snapshot all use this, so
 * they show the same score.
 */
export async function complianceOptionsFor(companyId: string, asOf: string) {
  const company = await one<{ total_assets_cents: number; boi_status: string | null; jurisdiction: string | null; fiscal_year_end: string | null }>('SELECT * FROM companies WHERE id = ?', companyId);
  const totalAssets = company?.total_assets_cents ?? 0;
  const boi = boiStatusOf(company);
  // Rule 701 measures the class at the last balance sheet date, the end of the company's fiscal year.
  const fiscalYearEnd = company?.fiscal_year_end ?? config().company.fiscalYearEnd;
  return { asOf, totalAssets, boiStatus: boi.status, titles: await titlesOf(companyId), cancellationDates: await cancellationDates(companyId), fiscalYearEnd };
}

route.get('/api/c/:cid/compliance', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const options = await complianceOptionsFor(ctx.companyId!, asOf);
  const { totalAssets, boiStatus, fiscalYearEnd } = options;
  return {
    ...complianceSummary(data, options),
    iso100k: isoHundredKTest(data, asOf, options),
    rule701: rule701Test(data, asOf, totalAssets, { fiscalYearEnd }),
    sections: {
      elections83b: election83bRows(data, asOf).reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {} as Record<string, number>),
      form3921: form3921Status(data, asOf, options).filter((s) => s.state !== 'NOTHING_TO_FILE').map((s) => ({ year: s.year, state: s.state, count: s.count })),
      boi: boiStatus,
    },
  };
});

// --- Compliance sections ---------------------------------------------------

route.get('/api/c/:cid/compliance/83b', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const rows = election83bRows(data, asOf).map((r) => ({
    ...r, shareClassName: data.shareClasses.find((c) => c.id === r.shareClassId)?.name ?? null,
  }));
  const counts = { filed: 0, open: 0, closed: 0 };
  for (const r of rows) counts[r.status.toLowerCase() as keyof typeof counts]++;
  const unrestricted = data.issuances.filter((i) => i.status === 'OUTSTANDING').length - rows.length;
  return { asOf, rows, counts, unrestricted };
});

function form3921Payload(data: Awaited<ReturnType<typeof getCompanyData>>, asOf: string, yearParam: string | null, cancelled: Record<string, string>) {
  const statuses = form3921Status(data, asOf, { cancellationDates: cancelled });
  const requested = yearParam ? Number(yearParam) : NaN;
  const defaultYear = statuses.find((s) => s.state === 'DUE' || s.state === 'OVERDUE')?.year ?? Number(asOf.slice(0, 4)) - 1;
  const year = Number.isInteger(requested) ? requested : defaultYear;
  const status = statuses.find((s) => s.year === year) ?? {
    year, count: 0, deadlines: form3921Deadlines(year), filing: null, state: 'NOTHING_TO_FILE' as const,
  };
  return { year, statuses, status, rows: form3921Rows(data, year, { cancellationDates: cancelled }) };
}

route.get('/api/c/:cid/compliance/form-3921', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const { year, statuses, status, rows } = form3921Payload(data, asOf, ctx.query.get('year'), await cancellationDates(ctx.companyId!));
  const people = await all<{ id: string; address: string | null; email: string | null }>('SELECT id, address, email FROM stakeholders WHERE company_id = ?', ctx.companyId);
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    asOf, statuses, ...status, year,
    rows: rows.map((r) => ({ ...r, address: byId.get(r.stakeholderId)?.address ?? null, email: byId.get(r.stakeholderId)?.email ?? null })),
  };
});

/** The boxes of Form 3921 for every ISO exercise of a year, one row per form, for a filing service or the IRS FIRE/IRIS upload. */
route.get('/api/c/:cid/compliance/form-3921.csv', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const { year, rows } = form3921Payload(data, asOfOf(ctx), ctx.query.get('year'), await cancellationDates(ctx.companyId!));
  const company = await one<{ legal_name: string | null; name: string; ein: string | null; address: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);
  const people = await all<{ id: string; address: string | null }>('SELECT id, address FROM stakeholders WHERE company_id = ?', ctx.companyId);
  const address = new Map(people.map((p) => [p.id, p.address]));
  const dollars = (perShare: number) => (perShare / 1e6).toFixed(4);
  const csv = toCsv([
    ['Tax year', 'Transferor (corporation)', 'Transferor EIN', 'Transferor address', 'Employee', 'Employee address', 'Employee TIN',
     'Box 1 Date option granted', 'Box 2 Date option exercised', 'Box 3 Exercise price per share', 'Box 4 FMV per share on exercise date',
     'Box 5 Number of shares transferred', 'Box 6 Transferor if other than corporation', 'Grant', 'Spread (USD)'],
    ...rows.map((r) => [
      String(year), company?.legal_name ?? company?.name ?? '', company?.ein ?? '', company?.address ?? '', r.stakeholderName, address.get(r.stakeholderId) ?? '', '',
      r.grantDate, r.exerciseDate, dollars(r.exercisePrice), dollars(r.fmvAtExercise), String(r.quantity), '', r.awardLabel ?? '', (r.spread / 100).toFixed(2),
    ]),
  ]);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="form-3921-${year}.csv"`,
  });
  ctx.res.end(csv);
  return undefined;
});

route.get('/api/c/:cid/compliance/boi', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const company = await one<{ boi_status: string | null; jurisdiction: string | null; entity_type: string | null; incorporation_date: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);
  const boi = boiStatusOf(company);
  const report = beneficialOwnershipReport(data, { asOf, titles: await titlesOf(ctx.companyId!) });
  const people = await all<{ id: string; address: string | null; email: string | null; title: string | null }>('SELECT id, address, email, title FROM stakeholders WHERE company_id = ?', ctx.companyId);
  const byId = new Map(people.map((p) => [p.id, p]));
  const enrich = (o: (typeof report.owners)[number]) => ({ ...o, address: byId.get(o.stakeholderId)?.address ?? null, email: byId.get(o.stakeholderId)?.email ?? null });
  const filings = (data.filings ?? []).filter((f) => f.kind === 'BOI');
  const last = filings[filings.length - 1] ?? null;
  return {
    asOf, status: boi.status, statusSource: boi.source,
    jurisdiction: company?.jurisdiction ?? null, entityType: company?.entity_type ?? null, incorporationDate: company?.incorporation_date ?? null,
    owners: report.owners.map(enrich), entitiesToLookThrough: report.entitiesToLookThrough.map(enrich),
    filings, lastFiledOn: last?.filedOn ?? null, updateDue: last ? report.changedSince(last.filedOn) : false,
  };
});

route.post('/api/c/:cid/compliance/filings', 'write', async (ctx) => {
  const kind = String(ctx.body.kind ?? '');
  if (!['FORM_3921', 'BOI'].includes(kind)) throw badRequest('Filing kind must be FORM_3921 or BOI.');
  const period = String(ctx.body.period ?? '').trim();
  if (kind === 'FORM_3921' && !/^\d{4}$/.test(period)) throw badRequest('Give the tax year the forms cover.');
  if (kind === 'BOI' && !['INITIAL', 'UPDATE', 'CORRECTION'].includes(period)) throw badRequest('A BOI filing is INITIAL, UPDATE or CORRECTION.');
  const filedOn = String(ctx.body.filedOn ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filedOn)) throw badRequest('Give the date it was filed.');
  const record = {
    id: newId('fil'), companyId: ctx.companyId, kind, period, filedOn,
    reference: ctx.body.reference ? String(ctx.body.reference).slice(0, 200) : null,
    notes: ctx.body.notes ? String(ctx.body.notes).slice(0, 2000) : null,
    createdBy: ctx.user!.name, createdAt: nowISO(),
  };
  await insert('compliance_filings', record);
  invalidate(ctx.companyId!);
  await audit(ctx, 'CREATE', 'compliance_filings', record.id,
    kind === 'FORM_3921' ? `Form 3921 for ${period} recorded as filed on ${filedOn}` : `BOI ${period.toLowerCase()} report recorded as filed on ${filedOn}`);
  return toCamel(await one('SELECT * FROM compliance_filings WHERE id = ?', record.id));
});

route.del('/api/c/:cid/compliance/filings/:id', 'write', async (ctx) => {
  const existing = await one<{ kind: string; period: string }>('SELECT * FROM compliance_filings WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!existing) throw notFound('Filing not found.');
  await run('DELETE FROM compliance_filings WHERE id = ?', ctx.params.id);
  invalidate(ctx.companyId!);
  await audit(ctx, 'DELETE', 'compliance_filings', ctx.params.id, `${existing.kind === 'FORM_3921' ? 'Form 3921' : 'BOI'} filing record for ${existing.period} removed`);
  return { ok: true };
});

// --- Tax / exercise modelling ---------------------------------------------

route.post('/api/c/:cid/model/exercise', 'read', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const award = data.awards.find((a) => a.id === ctx.body.awardId);
  if (!award) throw notFound('Grant not found.');
  const role = ctx.membership!.role;
  if (!seesWholeCompany(role) && award.stakeholderId !== ctx.membership!.stakeholderId) {
    throw badRequest('You can only model your own grants.');
  }
  const asOf = ctx.body.asOf ?? today();
  // A quantity is in options as the grant records them, the units the exercise
  // route takes and the Grants page shows; shares are in the shares of the
  // as-of date, after any split since the grant, as the Portal shows them. The
  // model works in the shares of the as-of date, as the exercise records them.
  const shares = ctx.body.quantity != null
    ? roundShares(Number(ctx.body.quantity) * splitFactor(data, award.grantDate, asOf))
    : Number(ctx.body.shares ?? 0);
  if (!(shares > 0)) throw badRequest('Enter how many shares to exercise.');
  // Rates left out of the request are tax.defaultRates.
  const rates = { ...config().tax.defaultRates, ...ctx.body.rates };
  const scenario = modelExercise(data, award, shares, {
    asOf, fmv: ctx.body.fmv ?? undefined, rates,
  });
  const exitPrice = Number(ctx.body.exitPricePerShare ?? 0);
  // The sale is of those shares, so it takes the strike per share of the as-of date too.
  const current = normalizeSplits(data, asOf).awards.find((a) => a.id === award.id) ?? award;
  const sale = exitPrice > 0
    ? modelSaleProceeds(current, shares, exitPrice, {
        exercisedOn: asOf,
        saleDate: ctx.body.saleDate ?? addMonths(asOf, 13),
        fmvAtExercise: scenario.fmv, rates,
      })
    : null;
  // QSBS is only for stock in a C corporation; a company with no entity type recorded is taken to be company.entityType.
  const company = await one<{ entity_type: string | null }>('SELECT entity_type FROM companies WHERE id = ?', ctx.companyId);
  const isCCorp = (company?.entity_type ?? config().company.entityType) === 'C_CORP';
  const qsbs = assessQSBS(asOf, scenario.exerciseCost, { asOf: today(), isCCorp });
  return { scenario, sale, qsbs };
});

// --- Reports / export ------------------------------------------------------

function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((cell) => {
    const s = String(cell ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

// --- Stock-based compensation (ASC 718 / IFRS 2) ---------------------------

function parseAssumptions(raw: string | null | undefined): Partial<StockCompAssumptions> {
  if (!raw) return {};
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<StockCompAssumptions> = {};
    for (const k of ['volatility', 'riskFreeRate', 'dividendYield', 'forfeitureRate'] as const) if (a[k] != null && a[k] !== '') out[k] = Number(a[k]);
    if (a.expectedTermYears != null && a.expectedTermYears !== '') out.expectedTermYears = Number(a.expectedTermYears);
    if (a.attribution) out.attribution = a.attribution as StockCompAssumptions['attribution'];
    if (a.forfeiturePolicy) out.forfeiturePolicy = a.forfeiturePolicy as StockCompAssumptions['forfeiturePolicy'];
    if (a.standard) out.standard = a.standard as StockCompAssumptions['standard'];
    return out;
  } catch { return {}; }
}

async function buildStockComp(ctx: Parameters<typeof asOfOf>[0] & { companyId: string | null; query: URLSearchParams }) {
  const data = await getCompanyData(ctx.companyId!);
  const company = await one<{ fiscal_year_end: string | null; accounting_assumptions: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);
  const asOf = asOfOf(ctx);
  const fiscalYearEnd = company?.fiscal_year_end ?? config().company.fiscalYearEnd;
  // What the company has not set falls back on stockComp.defaultAssumptions, in the report and on the page.
  const defaults = config().stockComp.defaultAssumptions;
  const yearParam = Number(ctx.query.get('year'));
  const year = Number.isInteger(yearParam) && yearParam > 1990 ? yearParam : Number(asOf.slice(0, 4));
  const people = await all<{ id: string; department: string | null }>('SELECT id, department FROM stakeholders WHERE company_id = ?', ctx.companyId);
  // Each cancellation reverses cost from its own date. The report reads their
  // quantities as shares of the grant's cancelled total, so each is first put in
  // the shares of the as-of date, whatever splits came between.
  const cancellations = Object.fromEntries(Object.entries(await cancellationsOf(ctx.companyId!, asOf)).map(([awardId, list]) =>
    [awardId, list.map((c) => ({ date: c.date, quantity: c.quantity * splitFactor(data, c.date, asOf) }))]));
  const report = stockCompReport(data, year, {
    fiscalYearEnd, asOf, assumptions: { ...defaults, ...parseAssumptions(company?.accounting_assumptions) },
    departments: Object.fromEntries(people.map((p) => [p.id, p.department])),
    cancellationDates: await cancellationDates(ctx.companyId!),
    cancellations,
  });
  // Every fiscal year from the first grant to now, so nothing is skipped in the selector.
  const current = Number(asOf.slice(0, 4));
  const first = data.awards.reduce((min, a) => Math.min(min, Number(a.grantDate.slice(0, 4))), Math.min(year, current));
  const years: number[] = [];
  for (let y = first; y <= Math.max(current, year); y++) years.push(y);
  return { report, years, fiscalYearEnd, assumptionsSet: !!company?.accounting_assumptions, defaults };
}

route.get('/api/c/:cid/reports/stock-comp', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  return buildStockComp(ctx);
});

/** The expense schedule by award, for the auditor's workpapers. */
route.get('/api/c/:cid/reports/stock-comp.csv', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const { report } = await buildStockComp(ctx);
  const dollars = (cents: number) => (cents / 100).toFixed(2);
  const perShare = (micro: number) => (micro / 1e6).toFixed(4);
  const csv = toCsv([
    ['Fiscal period', 'Award', 'Holder', 'Department', 'Type', 'Grant date', 'Quantity', 'Fair value per share', 'Total fair value',
     `Expense ${report.period.label}`, 'Cumulative expense', 'Unrecognized cost', 'Remaining years', 'Status', 'Cancelled quantity', 'Cancellation date'],
    ...report.awards.map((r) => [
      report.period.label, r.label ?? r.awardId, r.stakeholderName, r.department ?? '', r.type, r.grantDate, String(r.quantity), perShare(r.fairValuePerShare),
      dollars(r.totalFairValue), dollars(r.expense), dollars(r.cumulative), dollars(r.unrecognized), r.remainingYears.toFixed(2), r.status,
      String(r.cancelledQuantity), r.cancellationDate ?? '',
    ]),
    [],
    ['Assumptions', `volatility ${report.assumptions.volatility}`, `risk-free ${report.assumptions.riskFreeRate}`, `dividend yield ${report.assumptions.dividendYield}`,
     `expected term ${report.assumptions.expectedTermYears ?? 'simplified'}`, report.assumptions.attribution, report.assumptions.forfeiturePolicy, report.assumptions.standard],
  ]);
  ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="stock-comp-${report.period.label}.csv"` });
  ctx.res.end(csv);
  return undefined;
});

route.get('/api/c/:cid/reports/:report', 'read', async (ctx) => {
  assertFullView(ctx, OWN_POSITION_ONLY);
  const data: CompanyData = await getCompanyData(ctx.companyId!);
  const asOf = asOfOf(ctx);
  const report = ctx.params.report;
  const table = computeCapTable(data, { asOf, includeConvertibles: true });
  const nameOf = (id: string) => data.stakeholders.find((s) => s.id === id)?.name ?? id;

  let rows: (string | number)[][];
  switch (report) {
    case 'captable':
      rows = [['Stakeholder', 'Relationship', 'Outstanding', 'As converted', 'Options outstanding',
               'Options vested', 'RSUs', 'Warrants', 'Fully diluted', 'Ownership %', 'Invested', 'Value']];
      for (const r of table.rows) {
        rows.push([r.name, r.relation, r.outstanding, r.asConverted, r.optionsOutstanding,
                   r.optionsVested, r.rsusOutstanding, r.warrantsOutstanding, r.fullyDiluted,
                   (r.fullyDilutedPct * 100).toFixed(4), (r.investedAmount / 100).toFixed(2),
                   (r.currentValue / 100).toFixed(2)]);
      }
      rows.push(['Unallocated pool', 'POOL', 0, 0, 0, 0, 0, 0, table.totals.poolAvailable,
                 ((table.totals.poolAvailable / table.totals.fullyDiluted) * 100).toFixed(4), '', '']);
      rows.push(['TOTAL', '', table.totals.outstanding, table.totals.asConverted,
                 table.totals.optionsOutstanding, table.totals.optionsVested, table.totals.rsusOutstanding,
                 table.totals.warrantsOutstanding, table.totals.fullyDiluted, '100.0000',
                 (table.totals.investedAmount / 100).toFixed(2),
                 (table.totals.companyValue / 100).toFixed(2)]);
      break;

    case 'grants': {
      rows = [['Grant', 'Holder', 'Type', 'Quantity', 'Strike', 'Grant date', 'Vesting start',
               'Vested', 'Unvested', 'Exercised', 'Cancelled', 'Status', 'Expires']];
      for (const a of data.awards) {
        const schedule = data.vestingSchedules.find((s) => s.id === a.vestingScheduleId);
        const holder = data.stakeholders.find((s) => s.id === a.stakeholderId);
        const summary = schedule
          ? summarizeVesting({ schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate,
                               terminationDate: holder?.terminationDate ?? null }, asOf)
          : null;
        rows.push([a.label ?? a.id, nameOf(a.stakeholderId), a.type, a.quantity,
                   formatPPS(a.strikePrice), a.grantDate, a.vestingStartDate,
                   summary?.vested ?? a.quantity, summary?.unvested ?? 0,
                   a.exercisedQuantity, a.cancelledQuantity, a.status, a.expirationDate ?? '']);
      }
      break;
    }

    case 'vesting': {
      rows = [['Grant', 'Holder', 'Date', 'Shares vesting', 'Cumulative vested', 'Event']];
      for (const a of data.awards) {
        const schedule = data.vestingSchedules.find((s) => s.id === a.vestingScheduleId);
        if (!schedule) continue;
        const holder = data.stakeholders.find((s) => s.id === a.stakeholderId);
        const summary = summarizeVesting({
          schedule, totalQuantity: a.quantity, vestingStartDate: a.vestingStartDate,
          terminationDate: holder?.terminationDate ?? null }, asOf);
        for (const e of summary.events) {
          rows.push([a.label ?? a.id, nameOf(a.stakeholderId), e.date, e.quantity, e.cumulative, e.kind]);
        }
      }
      break;
    }

    case 'transactions':
      rows = [['Date', 'Type', 'Stakeholder', 'Share class', 'Quantity', 'Price per share', 'Amount', 'Memo']];
      for (const t of toCamelAll<Record<string, unknown>>(
        await all('SELECT * FROM transactions WHERE company_id = ? ORDER BY date DESC', ctx.companyId))) {
        rows.push([String(t.date), String(t.type), t.stakeholderId ? nameOf(String(t.stakeholderId)) : '',
                   String(t.shareClassId ?? ''), Number(t.quantity ?? 0),
                   t.pricePerShare ? formatPPS(Number(t.pricePerShare)) : '',
                   t.amount ? (Number(t.amount) / 100).toFixed(2) : '', String(t.memo ?? '')]);
      }
      break;

    case 'convertibles':
      rows = [['Holder', 'Instrument', 'Principal', 'Issued', 'Cap', 'Discount', 'Interest', 'Maturity', 'Status']];
      for (const c of data.convertibles) {
        rows.push([nameOf(c.stakeholderId), c.instrument, (c.principal / 100).toFixed(2), c.issueDate,
                   c.valuationCap ? (c.valuationCap / 100).toFixed(2) : '',
                   (c.discount * 100).toFixed(1) + '%', (c.interestRate * 100).toFixed(2) + '%',
                   c.maturityDate ?? '', c.status]);
      }
      break;

    case 'ownership-by-class':
      rows = [['Share class', 'Type', 'Authorized', 'Outstanding', 'As converted', 'Available',
               'Holders', 'Invested', 'Price per share', 'Liquidation preference', 'Ownership %']];
      for (const c of table.classes) {
        rows.push([c.name, c.kind, c.authorized, c.outstanding, c.asConverted, c.available, c.holders,
                   (c.investedAmount / 100).toFixed(2), formatPPS(c.pricePerShare),
                   (c.liquidationPreference / 100).toFixed(2), (c.ownershipPct * 100).toFixed(4)]);
      }
      break;

    default:
      throw notFound('Unknown report.');
  }

  const body = csv(rows);
  await audit(ctx, 'EXPORT', 'reports', report, `${report} exported as CSV`);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${report}-${asOf}.csv"`,
  });
  ctx.res.end(body);
  return undefined;
});

void formatShares; void formatMoney; void formatPct;
export type { Award };
