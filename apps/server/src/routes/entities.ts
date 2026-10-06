import { route, newId, nowISO, audit, badRequest, notFound, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll, snake } from '../db.ts';
import { validateEntity } from '../validation.ts';
import { invalidate } from '../store.ts';
import { reportLink } from './valuation-report.ts';
import { config } from '../config.ts';

/**
 * Declarative CRUD. Every cap table entity shares the same shape — scoped to a
 * company, soft validated, audited on write — so the endpoints are generated
 * from a description rather than hand-written five times over.
 */
interface Resource {
  path: string;
  table: string;
  label: string;
  /** Writable fields, in camelCase. */
  fields: string[];
  required: string[];
  order: string;
  /** Normalises and validates the payload before it is written. */
  clean?: (body: Record<string, unknown>, ctx: Ctx) => Record<string, unknown>;
  /** Blocks deletion when the row is referenced elsewhere. */
  guardDelete?: (id: string, companyId: string) => Promise<string | null>;
}

/** The exemptions private shares are commonly sold under in the United States. */
export const FEDERAL_EXEMPTIONS = ['SECTION_4A2', 'REG_D_506B', 'REG_D_506C', 'RULE_701', 'REG_S', 'REG_CF', 'OTHER'];

const RESOURCES: Resource[] = [
  {
    path: 'stakeholders', table: 'stakeholders', label: 'Stakeholder',
    fields: ['name', 'legalName', 'email', 'secondaryEmail', 'type', 'relation', 'startDate', 'terminationDate', 'terminationReason',
             'taxCountry', 'taxState', 'taxForm', 'accreditedInvestor', 'entityGroupId', 'title', 'department', 'employeeId', 'employmentType',
             'address', 'city', 'region', 'postalCode', 'country', 'phone', 'jurisdiction', 'signatoryName', 'signatoryTitle', 'signatoryEmail',
             'tags', 'notes'],
    required: ['name'], order: 'name',
    clean: (b) => {
      const oneOf = (key: string, allowed: string[], label: string) => {
        if (b[key] === undefined) return;
        if (b[key] === null || b[key] === '') { b[key] = null; return; }
        if (!allowed.includes(String(b[key]))) throw badRequest(`${label} must be one of ${allowed.join(', ')}.`);
      };
      if (b.type !== undefined && !['INDIVIDUAL', 'ENTITY', 'FUND', 'TRUST'].includes(String(b.type))) throw badRequest('Type must be an individual, entity, fund or trust.');
      if (b.relation !== undefined && !['FOUNDER', 'EMPLOYEE', 'FORMER_EMPLOYEE', 'ADVISOR', 'CONTRACTOR', 'INVESTOR', 'BOARD_MEMBER', 'OTHER'].includes(String(b.relation))) {
        throw badRequest('Choose a valid relationship.');
      }
      oneOf('employmentType', ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'ADVISOR', 'INTERN', 'OTHER'], 'Employment type');
      oneOf('terminationReason', ['VOLUNTARY', 'INVOLUNTARY', 'RETIREMENT', 'DEATH', 'DISABILITY', 'OTHER'], 'Termination reason');
      oneOf('taxForm', ['W9', 'W8BEN', 'W8BENE', 'OTHER'], 'Tax form');
      oneOf('accreditedInvestor', ['YES', 'NO'], 'Accredited investor');
      const emails: [string, string][] = [['email', 'Email'], ['secondaryEmail', 'Secondary email'], ['signatoryEmail', 'Signatory email']];
      for (const [key, label] of emails) {
        if (b[key] === undefined) continue;
        const v = b[key] == null ? '' : String(b[key]).trim().toLowerCase();
        // One address, with nothing in it that could turn it into two or into a header.
        if (v && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(v)) throw badRequest(`${label} does not look right.`);
        b[key] = v || null;
      }
      // Free text is trimmed and blanks are stored as nulls, so a cleared field really is empty.
      for (const key of ['legalName', 'phone', 'title', 'department', 'employeeId', 'address', 'city', 'region', 'postalCode', 'country',
                         'taxCountry', 'taxState', 'jurisdiction', 'signatoryName', 'signatoryTitle', 'tags', 'notes', 'entityGroupId', 'startDate', 'terminationDate']) {
        if (b[key] === undefined) continue;
        const v = b[key] == null ? '' : String(b[key]).trim();
        b[key] = v === '' ? null : v;
      }
      if (b.startDate && b.terminationDate && String(b.terminationDate) < String(b.startDate)) throw badRequest('The termination date cannot be before the start date.');
      if (!b.terminationDate && b.terminationReason !== undefined) b.terminationReason = null;
      if (b.tags) b.tags = String(b.tags).split(',').map((t) => t.trim()).filter(Boolean).join(', ');
      return b;
    },
    guardDelete: async (id, cid) => {
      const holdings = await one<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM issuances WHERE stakeholder_id = ? AND company_id = ?)
              + (SELECT COUNT(*) FROM awards WHERE stakeholder_id = ? AND company_id = ?)
              + (SELECT COUNT(*) FROM convertibles WHERE stakeholder_id = ? AND company_id = ?) AS n`,
        id, cid, id, cid, id, cid,
      );
      return (holdings?.n ?? 0) > 0
        ? 'This stakeholder still holds securities. Transfer or cancel them first.' : null;
    },
  },
  {
    path: 'share-classes', table: 'share_classes', label: 'Share class',
    fields: ['name', 'kind', 'authorized', 'parValue', 'seniority', 'originalIssuePrice',
             'liquidationMultiple', 'participation', 'participationCap', 'conversionRatio',
             'dividendType', 'dividendRate', 'dividendCompounding', 'dividendsParticipate',
             'votesPerShare', 'antiDilution', 'payToPlay', 'issueDate', 'isConvertible', 'sortOrder', 'legend'],
    required: ['name', 'kind', 'issueDate'], order: 'seniority DESC, issue_date',
    clean: (b) => {
      if (b.kind === 'COMMON') { b.seniority = 0; b.liquidationMultiple = 1; b.participation = 'NON_PARTICIPATING'; }
      if (b.participation !== 'CAPPED_PARTICIPATING') b.participationCap = null;
      if (Number(b.conversionRatio ?? 1) <= 0) throw badRequest('Conversion ratio must be greater than zero.');
      return b;
    },
    guardDelete: async (id, cid) => {
      const n = await one<{ n: number }>('SELECT COUNT(*) AS n FROM issuances WHERE share_class_id = ? AND company_id = ?', id, cid);
      return (n?.n ?? 0) > 0 ? 'Shares have been issued in this class. Cancel them first.' : null;
    },
  },
  {
    path: 'issuances', table: 'issuances', label: 'Share issuance',
    fields: ['certificateNo', 'stakeholderId', 'shareClassId', 'quantity', 'pricePerShare',
             'issueDate', 'status', 'vestingScheduleId', 'vestingStartDate', 'earlyExercised',
             'election83bFiledOn', 'sourceAwardId', 'boardApprovalDate', 'notes',
             'federalExemption', 'stateExemption', 'proRata', 'issueReason', 'holdingStartDate',
             'rule144Date', 'accelerationNotes'],
    required: ['stakeholderId', 'shareClassId', 'quantity', 'issueDate'], order: 'issue_date DESC',
    clean: (b) => {
      if (Number(b.quantity) <= 0) throw badRequest('Quantity must be greater than zero.');
      // A certificate out for signature has a document that repeats its terms, and
      // this route cannot rewrite that document. The draft route can, so it owns
      // corrections while a certificate is still unsigned.
      if (b.status === 'PENDING_SIGNATURE') {
        throw badRequest('This certificate is out for signature. Edit it as a draft so its document is rewritten to match.');
      }
      if (b.vestingScheduleId && !b.vestingStartDate) b.vestingStartDate = b.issueDate;
      if (b.federalExemption !== undefined && b.federalExemption !== null && b.federalExemption !== ''
          && !FEDERAL_EXEMPTIONS.includes(String(b.federalExemption))) {
        throw badRequest(`Federal exemption must be one of ${FEDERAL_EXEMPTIONS.join(', ')}.`);
      }
      // Shares are held from the day they are issued unless someone says otherwise,
      // and Rule 144 counts from that day, so both default rather than sit empty.
      if (b.holdingStartDate === undefined || b.holdingStartDate === '') b.holdingStartDate = b.issueDate ?? null;
      if (b.rule144Date === undefined || b.rule144Date === '') b.rule144Date = b.holdingStartDate ?? null;
      for (const key of ['stateExemption', 'issueReason', 'accelerationNotes']) {
        if (b[key] === undefined) continue;
        const v = b[key] == null ? '' : String(b[key]).trim();
        b[key] = v === '' ? null : v;
      }
      return b;
    },
  },
  {
    path: 'awards', table: 'awards', label: 'Equity award',
    fields: ['label', 'stakeholderId', 'poolId', 'type', 'quantity', 'strikePrice', 'grantDate',
             'vestingStartDate', 'vestingScheduleId', 'status', 'expirationDate', 'ptepMonths',
             'earlyExerciseAllowed', 'exercisedQuantity', 'cancelledQuantity', 'boardApprovalDate',
             'acceptedDate', 'fmvAtGrant', 'rsuLiquidityCondition', 'notes'],
    required: ['stakeholderId', 'poolId', 'type', 'quantity', 'grantDate', 'vestingScheduleId'],
    order: 'grant_date DESC',
    clean: (b) => {
      if (Number(b.quantity) <= 0) throw badRequest('Quantity must be greater than zero.');
      if (!b.vestingStartDate) b.vestingStartDate = b.grantDate;
      if (b.ptepMonths == null || b.ptepMonths === '') b.ptepMonths = config().equity.postTerminationExerciseMonths;
      if (b.type === 'RSU' || b.type === 'PHANTOM') b.strikePrice = 0;
      return b;
    },
  },
  {
    path: 'pools', table: 'pools', label: 'Equity plan',
    fields: ['name', 'shareClassId', 'authorized', 'boardApprovalDate', 'shareholderApprovalDate',
             'returnForfeitures', 'evergreenPercent', 'planType'],
    required: ['name', 'shareClassId', 'authorized'], order: 'created_at',
    guardDelete: async (id, cid) => {
      const n = await one<{ n: number }>('SELECT COUNT(*) AS n FROM awards WHERE pool_id = ? AND company_id = ?', id, cid);
      return (n?.n ?? 0) > 0 ? 'Grants have been made from this plan.' : null;
    },
  },
  {
    path: 'pool-adjustments', table: 'pool_adjustments', label: 'Plan adjustment',
    fields: ['poolId', 'date', 'amount', 'reason'],
    required: ['poolId', 'date', 'amount'], order: 'date DESC',
  },
  {
    path: 'warrants', table: 'warrants', label: 'Warrant',
    fields: ['stakeholderId', 'shareClassId', 'quantity', 'strikePrice', 'issueDate',
             'expirationDate', 'status', 'exercisedQuantity', 'netExercise', 'notes'],
    required: ['stakeholderId', 'shareClassId', 'quantity', 'issueDate'], order: 'issue_date DESC',
  },
  {
    path: 'convertibles', table: 'convertibles', label: 'Convertible',
    fields: ['stakeholderId', 'instrument', 'principal', 'issueDate', 'valuationCap', 'discount',
             'interestRate', 'compounding', 'maturityDate', 'mfn', 'proRataRight', 'status',
             'convertedIntoShareClassId', 'convertedOn', 'qualifiedFinancingMinimum', 'notes', 'label', 'fundsReceivedOn', 'fundsReference', 'boardApprovalDate'],
    required: ['stakeholderId', 'instrument', 'principal', 'issueDate'], order: 'issue_date DESC',
    clean: (b) => {
      if (Number(b.principal) <= 0) throw badRequest('Principal must be greater than zero.');
      const d = Number(b.discount ?? 0);
      if (d < 0 || d >= 1) throw badRequest('Discount must be between 0 and 1 (0.2 means a 20% discount).');
      if (b.instrument === 'SAFE_PRE' || b.instrument === 'SAFE_POST') { b.interestRate = 0; b.maturityDate = null; }
      if (!b.compounding) b.compounding = config().equity.noteCompounding;
      return b;
    },
  },
  {
    path: 'vesting-schedules', table: 'vesting_schedules', label: 'Vesting schedule',
    fields: ['name', 'kind', 'durationMonths', 'cliffMonths', 'frequency', 'immediatePortion',
             'yearWeights', 'milestones', 'customTranches', 'accelerationSingle',
             'accelerationDouble', 'accelerationMonths'],
    required: ['name'], order: 'name',
    clean: (b) => {
      if (Number(b.cliffMonths ?? 0) > Number(b.durationMonths ?? 0) && b.kind === 'TIME') {
        throw badRequest('The cliff cannot be longer than the total vesting period.');
      }
      return b;
    },
    guardDelete: async (id, cid) => {
      const n = await one<{ n: number }>('SELECT COUNT(*) AS n FROM awards WHERE vesting_schedule_id = ? AND company_id = ?', id, cid);
      return (n?.n ?? 0) > 0 ? 'Grants use this schedule.' : null;
    },
  },
  {
    path: 'valuations', table: 'valuations', label: 'Valuation',
    fields: ['type', 'fairMarketValue', 'effectiveDate', 'expirationDate', 'provider',
             'reportUrl', 'status', 'enterpriseValue', 'method', 'notes'],
    required: ['fairMarketValue', 'effectiveDate'], order: 'effective_date DESC',
    // A link someone types is checked when it is sent, so an address that runs
    // script cannot be stored. One already on file is left as it was.
    clean: (b, ctx) => (ctx.body?.reportUrl !== undefined ? { ...b, reportUrl: reportLink(ctx.body.reportUrl) } : b),
    // A valuation that answered a 409A request is the end of that request's
    // history. Deleting it would leave the request pointing at nothing.
    guardDelete: async (id, cid) => {
      const req = await one<{ id: string }>('SELECT id FROM valuation_requests WHERE valuation_id = ? AND company_id = ? LIMIT 1', id, cid);
      return req ? 'This valuation completed a 409A request, so it stays. Mark it superseded instead.' : null;
    },
  },
  {
    path: 'stock-splits', table: 'stock_splits', label: 'Stock split',
    fields: ['date', 'ratio', 'notes'], required: ['date', 'ratio'], order: 'date DESC',
    clean: (b) => {
      if (Number(b.ratio) <= 0) throw badRequest('Split ratio must be greater than zero.');
      return b;
    },
  },
  {
    path: 'tasks', table: 'tasks', label: 'Task',
    fields: ['title', 'detail', 'kind', 'entityType', 'entityId', 'dueDate', 'status', 'assignee', 'completedAt'],
    required: ['title'], order: "CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, due_date",
  },
  {
    path: 'investor-updates', table: 'investor_updates', label: 'Investor update',
    fields: ['title', 'period', 'body', 'metrics', 'status', 'sentAt'],
    required: ['title'], order: 'created_at DESC',
  },
];

function clean(resource: Resource, body: Record<string, unknown>, ctx: Ctx, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of resource.fields) if (body[f] !== undefined) out[f] = body[f];
  if (!partial) {
    for (const r of resource.required) {
      if (out[r] === undefined || out[r] === null || out[r] === '') {
        throw badRequest(`${r.replace(/([A-Z])/g, ' $1').toLowerCase().trim()} is required.`);
      }
    }
  }
  return resource.clean ? resource.clean(out, ctx) : out;
}

for (const r of RESOURCES) {
  const base = `/api/c/:cid/${r.path}`;

  route.get(base, 'read', async (ctx) =>
    toCamelAll(await all(`SELECT * FROM ${r.table} WHERE company_id = ? ORDER BY ${r.order}`, ctx.companyId)));

  route.get(`${base}/:id`, 'read', async (ctx) => {
    const row = toCamel(await one(`SELECT * FROM ${r.table} WHERE id = ? AND company_id = ?`, ctx.params.id, ctx.companyId));
    if (!row) throw notFound(`${r.label} not found.`);
    return row;
  });

  route.post(base, 'write', async (ctx) => {
    const values = clean(r, ctx.body ?? {}, ctx, false);
    await validateEntity(r.table, values, ctx.companyId!);
    const id = newId(r.path.slice(0, 3));
    await insert(r.table, { id, companyId: ctx.companyId, ...values, ...(r.table === 'share_classes' ? {} : { createdAt: nowISO() }) });
    invalidate(ctx.companyId!);
    await audit(ctx, 'CREATE', r.table, id, `${r.label} created`);
    return toCamel(await one(`SELECT * FROM ${r.table} WHERE id = ?`, id));
  });

  route.patch(`${base}/:id`, 'write', async (ctx) => {
    const existing = await one(`SELECT * FROM ${r.table} WHERE id = ? AND company_id = ?`, ctx.params.id, ctx.companyId);
    if (!existing) throw notFound(`${r.label} not found.`);
    // Validate the resulting record so partial updates preserve existing terms.
    const values = clean(r, { ...toCamel(existing), ...ctx.body }, ctx, false);
    await validateEntity(r.table, values, ctx.companyId!);
    await update(r.table, ctx.params.id, values);
    invalidate(ctx.companyId!);
    await audit(ctx, 'UPDATE', r.table, ctx.params.id, `${r.label} updated: ${Object.keys(values).join(', ')}`);
    return toCamel(await one(`SELECT * FROM ${r.table} WHERE id = ?`, ctx.params.id));
  });

  route.del(`${base}/:id`, 'write', async (ctx) => {
    const existing = await one(`SELECT * FROM ${r.table} WHERE id = ? AND company_id = ?`, ctx.params.id, ctx.companyId);
    if (!existing) throw notFound(`${r.label} not found.`);
    const references: Record<string, [string, string][]> = {
      stakeholders: [['memberships', 'stakeholder_id'], ['warrants', 'stakeholder_id'], ['documents', 'stakeholder_id']],
      share_classes: [['pools', 'share_class_id'], ['warrants', 'share_class_id'], ['convertibles', 'converted_into_share_class_id']],
      'vesting_schedules': [['issuances', 'vesting_schedule_id']],
      pools: [['pool_adjustments', 'pool_id']],
      awards: [['issuances', 'source_award_id'], ['exercises', 'award_id']],
    };
    for (const [table, field] of references[r.table] ?? []) {
      if (await one(`SELECT 1 FROM ${table} WHERE ${field} = ? AND company_id = ? LIMIT 1`, ctx.params.id, ctx.companyId)) throw badRequest(`${r.label} is still referenced by ${table.replaceAll('_', ' ')}.`);
    }
    if (['issuances', 'awards', 'warrants', 'convertibles'].includes(r.table)
        && await one('SELECT 1 FROM transactions WHERE security_id = ? AND company_id = ? LIMIT 1', ctx.params.id, ctx.companyId)) throw badRequest('This security has ledger history and cannot be deleted.');
    const block = await r.guardDelete?.(ctx.params.id, ctx.companyId!);
    if (block) throw badRequest(block);
    await run(`DELETE FROM ${r.table} WHERE id = ? AND company_id = ?`, ctx.params.id, ctx.companyId);
    invalidate(ctx.companyId!);
    await audit(ctx, 'DELETE', r.table, ctx.params.id, `${r.label} deleted`);
    return { ok: true };
  });
}

void snake;
export const RESOURCE_PATHS = RESOURCES.map((r) => r.path);
