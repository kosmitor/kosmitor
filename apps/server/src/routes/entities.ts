import { route, newId, nowISO, audit, badRequest, notFound, date, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll, snake } from '../db.ts';
import { validateEntity } from '../validation.ts';
import { getCompanyData, invalidate } from '../store.ts';
import { roundShares, splitFactor, today, CORRECTED_TERMS, type CompanyData, type CorrectedField } from '@kosmitor/core';
import { reissueCertificate } from './workflows.ts';
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

/**
 * The dated state of a security (docs/design/dated-ledger.md). An edit cannot set it
 * the way an event does: a status or count an event route sets is refused with that
 * route, which dates the change in the ledger. Closing or reopening a security with
 * no such route is refused too, as nothing would say when it happened.
 */
const EVENTS: Record<string, { ownDate: string; closed: string[]; routes: Record<string, string> }> = {
  issuances: { ownDate: 'issueDate', closed: ['TRANSFERRED', 'REPURCHASED', 'CANCELLED', 'CONVERTED'],
    routes: { TRANSFERRED: 'transfer', REPURCHASED: 'repurchase', CANCELLED: 'cancel' } },
  awards: { ownDate: 'grantDate', closed: ['EXERCISED', 'CANCELLED', 'EXPIRED', 'FORFEITED'],
    routes: { EXERCISED: 'exercise', CANCELLED: 'cancel', EXPIRED: 'cancel', FORFEITED: 'cancel', exercisedQuantity: 'exercise', cancelledQuantity: 'cancel' } },
  warrants: { ownDate: 'issueDate', closed: ['EXERCISED', 'EXPIRED', 'CANCELLED'],
    routes: { EXERCISED: 'exercise', EXPIRED: 'cancel', CANCELLED: 'cancel', exercisedQuantity: 'exercise' } },
  convertibles: { ownDate: 'issueDate', closed: ['CONVERTED', 'REPAID', 'CANCELLED'],
    routes: { CONVERTED: 'convert', REPAID: 'repay', CANCELLED: 'cancel', convertedOn: 'convert', convertedIntoShareClassId: 'convert' } },
};
/**
 * Who holds a security, its class or plan, and its own date. A change is a typo fix: a
 * CORRECTION with a reason that the rewind applies on every date, never a transfer.
 */
const IDENTITY: Record<string, string[]> = {
  issuances: ['stakeholderId', 'shareClassId', 'issueDate'], awards: ['stakeholderId', 'poolId', 'grantDate'],
  warrants: ['stakeholderId', 'shareClassId', 'issueDate'], convertibles: ['stakeholderId', 'issueDate'],
};
/** Not yet issued: not on the cap table, so not in the ledger either (the trigger in db.ts agrees). */
const UNISSUED = ['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE'];
/**
 * Awaiting board approval or signatures. Only those flows move a security into or out of
 * these: they check the consent or the signatures, and write the creation entry when it
 * goes live. An edit that did it would issue a security nobody approved or signed.
 */
const PENDING = ['PENDING_APPROVAL', 'PENDING_SIGNATURE'];
const refusePending = (r: Resource): Error => badRequest(
  `A ${r.label.toLowerCase()} goes into or out of ${PENDING.join(' or ')} only through its signing or approval flow. An edit cannot.`);
const isIssued = (status: unknown): boolean => !UNISSUED.includes(String(status ?? 'OUTSTANDING'));
const json = (v: unknown): string => JSON.stringify(v ?? null);

/** The dated entry a security enters the ledger with: an ISSUANCE, or a GRANT for an award. */
async function recordCreation(ctx: Ctx, table: string, id: string, v: Record<string, unknown>, memo: string): Promise<void> {
  const quantity = table === 'convertibles' ? null : Number(v.quantity);
  const price = table === 'issuances' ? Number(v.pricePerShare ?? 0) : table === 'convertibles' ? null : Number(v.strikePrice ?? 0);
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: table === 'awards' ? 'GRANT' : 'ISSUANCE', date: v[EVENTS[table].ownDate],
    stakeholderId: v.stakeholderId ?? null, securityId: id, shareClassId: v.shareClassId ?? null, quantity, pricePerShare: price,
    amount: table === 'convertibles' ? Number(v.principal) : table === 'issuances' ? Math.round((quantity! * price!) / 10_000) : null,
    memo, createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
  });
}

/**
 * Splits restate every share count dated before them, the ledger's entries among them,
 * which are in the shares of their own day. A split dated on or before an entry already
 * recorded against a security issued before it would restate that entry, and the cap
 * table of every earlier date with it, so it is refused.
 */
async function refuseSplitBehindLedger(companyId: string, on: string): Promise<void> {
  const hit = await one<{ type: string; date: string }>(
    `SELECT t.type, t.date FROM transactions t
       LEFT JOIN issuances i ON i.id = t.security_id LEFT JOIN awards a ON a.id = t.security_id LEFT JOIN warrants w ON w.id = t.security_id
      WHERE t.company_id = ? AND t.security_id IS NOT NULL AND t.date >= ? AND COALESCE(i.issue_date, a.grant_date, w.issue_date) < ?
      ORDER BY t.date DESC LIMIT 1`, companyId, on, on);
  if (hit) {
    throw badRequest(`A split dated ${on} would restate ledger entries already recorded on or after it (the latest, a ${hit.type.toLowerCase()} on ${hit.date}), and every earlier cap table with them. Date the split after ${hit.date}.`);
  }
}

/** The company STOCK_SPLIT entry a change to a split is recorded with. */
async function recordSplit(ctx: Ctx, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Promise<void> {
  const terms = (v: Record<string, unknown> | null) => (v ? { date: v.date, ratio: Number(v.ratio) } : null);
  const on = String((after ?? before)!.date);
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'STOCK_SPLIT', date: on, securityId: null,
    memo: !before ? `${after!.ratio}:1 split recorded` : !after ? `${before.ratio}:1 split of ${before.date} removed` : `Split of ${before.date} (${before.ratio}:1) changed to ${after.date} (${after.ratio}:1)`,
    beforeValue: before ? json(terms(before)) : null, afterValue: after ? json(terms(after)) : null,
    createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
  });
}

/**
 * A security starts outstanding with nothing exercised, cancelled or converted. A
 * later state comes from its event route, which dates it in the ledger, or from the
 * import, which writes the entries it can date.
 */
function initialState(r: Resource, values: Record<string, unknown>): void {
  const ev = EVENTS[r.table];
  if (!ev) return;
  if (ev.closed.includes(String(values.status))) {
    throw badRequest(`A new ${r.label.toLowerCase()} starts outstanding. Record what happened since with its action, or bring in a closed one with the import.`);
  }
  for (const key of ['exercisedQuantity', 'cancelledQuantity']) {
    if (Number(values[key] ?? 0) !== 0) throw badRequest(`A new ${r.label.toLowerCase()} starts with nothing ${key === 'exercisedQuantity' ? 'exercised' : 'cancelled'}. Record the ${key === 'exercisedQuantity' ? 'exercise' : 'cancellation'} with its action, or use the import.`);
  }
  if (values.convertedOn || values.convertedIntoShareClassId) throw badRequest('A new instrument starts outstanding. Record the conversion with its action, or use the import.');
}
const COUNTS: CorrectedField[] = ['quantity', 'exercisedQuantity', 'cancelledQuantity'];
/** Equal as stored: a flag sent as true or false is the 1 or 0 the column holds. */
const same = (a: unknown, b: unknown): boolean => {
  const stored = (v: unknown) => String(v === true ? 1 : v === false ? 0 : v ?? '');
  return stored(a) === stored(b);
};

/**
 * What an edit changes in a security's dated state. Events are refused with their
 * route; what is left are corrections, each a signed change to a count in the row's
 * own units. They are written as dated CORRECTION entries by the caller.
 */
function corrections(r: Resource, id: string, before: Record<string, unknown>, after: Record<string, unknown>): { field: CorrectedField; delta: number }[] {
  const ev = EVENTS[r.table];
  if (!ev) return [];
  const useRoute = (action: string) => badRequest(
    `Record this with the ${action} action (POST /api/c/:cid/${r.path}/${id}/${action}), which dates it in the ledger. An edit cannot.`);
  if (!same(before.status, after.status)) {
    const from = String(before.status), to = String(after.status);
    if (ev.routes[to]) throw useRoute(ev.routes[to]);
    if (ev.closed.includes(to) || ev.closed.includes(from)) {
      throw badRequest(`A ${r.label.toLowerCase()} cannot go from ${from} to ${to} by an edit: the ledger would not know when it happened.`);
    }
  }
  for (const key of ['convertedOn', 'convertedIntoShareClassId']) {
    if (key in after && !same(before[key], after[key])) throw useRoute(ev.routes[key]);
  }
  const out: { field: CorrectedField; delta: number }[] = [];
  for (const field of COUNTS) {
    if (!(field in after)) continue;
    const delta = roundShares(Number(after[field] ?? 0) - Number(before[field] ?? 0));
    if (delta === 0) continue;
    if (delta > 0 && ev.routes[field]) throw useRoute(ev.routes[field]);
    out.push({ field, delta });
  }
  return out;
}

/**
 * Checks a corrected grant or warrant against what was issued on its exercises, and
 * sets its status from the corrected counts as the exercise and cancel routes would.
 */
function usedUp(r: Resource, id: string, values: Record<string, unknown>, data: CompanyData): void {
  const ownDate = String(values[EVENTS[r.table].ownDate]);
  const quantity = Number(values.quantity), exercised = Number(values.exercisedQuantity ?? 0), cancelled = Number(values.cancelledQuantity ?? 0);
  // The shares issued on each exercise are a certificate of their own; the count cannot fall below them.
  const issued = roundShares((data.ledger ?? []).filter((e) => e.securityId === id && e.type === 'EXERCISE')
    .reduce((s, e) => s + (e.quantity ?? 0) / splitFactor(data, ownDate, e.date), 0));
  if (exercised < issued) throw badRequest(`Shares were issued on exercise of ${issued} of these, so the exercised count cannot be lower. Cancel or repurchase the shares issued instead.`);
  const left = roundShares(quantity - exercised - cancelled);
  if (left < 0) throw badRequest(`The quantity cannot be less than what was exercised and cancelled (${roundShares(exercised + cancelled)}).`);
  const status = String(values.status);
  const byCounts = r.table === 'warrants' ? ['EXERCISED'] : ['EXERCISED', 'CANCELLED', 'EXPIRED', 'FORFEITED'];
  if (left > 0 && byCounts.includes(status)) values.status = 'OUTSTANDING';
  if (left <= 0 && status === 'OUTSTANDING') values.status = exercised > 0 ? 'EXERCISED' : 'CANCELLED';
}

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
    if (EVENTS[r.table] && PENDING.includes(String(values.status))) throw refusePending(r);
    initialState(r, values);
    await validateEntity(r.table, values, ctx.companyId!);
    const id = newId(r.path.slice(0, 3));
    if (r.table === 'stock_splits') await refuseSplitBehindLedger(ctx.companyId!, String(values.date));
    await insert(r.table, { id, companyId: ctx.companyId, ...values, ...(r.table === 'share_classes' ? {} : { createdAt: nowISO() }) });
    if (EVENTS[r.table] && isIssued(values.status)) await recordCreation(ctx, r.table, id, values, `${r.label} created`);
    if (r.table === 'stock_splits') await recordSplit(ctx, null, values);
    invalidate(ctx.companyId!);
    await audit(ctx, 'CREATE', r.table, id, `${r.label} created`);
    return toCamel(await one(`SELECT * FROM ${r.table} WHERE id = ?`, id));
  });

  route.patch(`${base}/:id`, 'write', async (ctx) => {
    const existing = await one(`SELECT * FROM ${r.table} WHERE id = ? AND company_id = ?`, ctx.params.id, ctx.companyId);
    if (!existing) throw notFound(`${r.label} not found.`);
    // Validate the resulting record so partial updates preserve existing terms.
    const before = toCamel<Record<string, unknown>>(existing)!;
    if (EVENTS[r.table] && ctx.body?.status !== undefined && !same(before.status, ctx.body.status)
        && [before.status, ctx.body.status].some((s) => PENDING.includes(String(s)))) throw refusePending(r);
    const values = clean(r, { ...before, ...ctx.body }, ctx, false);
    await validateEntity(r.table, values, ctx.companyId!);
    const fixes = corrections(r, ctx.params.id, before, values);
    const ev = EVENTS[r.table];
    if (ev && isIssued(before.status) && !isIssued(values.status)) throw badRequest(`An issued ${r.label.toLowerCase()} cannot go back to ${values.status}.`);
    if (ev && !isIssued(before.status) && isIssued(values.status)) await recordCreation(ctx, r.table, ctx.params.id, values, `${r.label} recorded as ${values.status}`);
    const identity = ev && isIssued(before.status) ? IDENTITY[r.table].filter((k) => k in values && !same(before[k], values[k])) : [];
    const terms: string[] = ev && isIssued(before.status) ? CORRECTED_TERMS[r.table as keyof typeof CORRECTED_TERMS].filter((k) => k in values && !same(before[k], values[k])) : [];
    const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason.trim().slice(0, 500) : '';
    const entry = (o: Record<string, unknown>) => insert('transactions', {
      id: newId('tx'), companyId: ctx.companyId, type: 'CORRECTION', stakeholderId: values.stakeholderId ?? null, securityId: ctx.params.id,
      shareClassId: values.shareClassId ?? null, reason: reason || null, createdAt: nowISO(), createdBy: ctx.user!.name, ...o,
    });
    if (identity.length > 0) {
      // A typo in who holds it, its class or its date: the record always should have said
      // so. It is not a transfer, and the rewind applies it on every date.
      if (!reason) {
        throw badRequest(`This ${r.label.toLowerCase()} is issued, so a change to its ${identity.join(', ')} is a correction: it says the record was always wrong and applies on every date. Give a reason to record it.`
          + (identity.includes('stakeholderId') && r.table === 'issuances' ? ` If the shares changed hands, record a transfer instead (POST /api/c/:cid/issuances/${ctx.params.id}/transfer).` : ''));
      }
      const ownDate = ev.ownDate;
      // A certificate an event issued (a transfer, an exercise, a conversion) is dated by that event,
      // written in the same transaction as its ISSUANCE entry. Its holder, class and date are the event's.
      const source = await one<{ type: string; date: string }>(
        `SELECT e.type, e.date FROM transactions i JOIN transactions e ON e.xact_id = i.xact_id AND e.id <> i.id
          WHERE i.security_id = ? AND i.type = 'ISSUANCE' AND e.type IN ('TRANSFER', 'EXERCISE', 'CONVERSION') AND e.date = i.date LIMIT 1`, ctx.params.id);
      if (source) throw badRequest(`This ${r.label.toLowerCase()} was issued by the ${source.type.toLowerCase()} on ${source.date}, which sets its ${identity.join(', ')}.`);
      const moved = identity.filter((k) => k !== ownDate);
      if (moved.length > 0) {
        // Once anything has happened to it, a new holder or class may be a transfer in disguise.
        const history = await one<{ type: string; date: string }>(
          "SELECT type, date FROM transactions WHERE security_id = ? AND type NOT IN ('ISSUANCE', 'GRANT', 'CORRECTION') ORDER BY date LIMIT 1", ctx.params.id);
        if (history) {
          throw badRequest(`This ${r.label.toLowerCase()} has ledger history (a ${history.type.toLowerCase()} on ${history.date}), so its ${moved.join(', ')} cannot be corrected as a typo.`
            + (r.table === 'issuances' ? ` If the shares changed hands, record a transfer (POST /api/c/:cid/issuances/${ctx.params.id}/transfer).` : ' Cancel it and issue a new one instead.'));
        }
      }
      if (identity.includes(ownDate)) {
        const [from, to] = [String(before[ownDate]), String(values[ownDate])].sort();
        const split = await one<{ date: string }>('SELECT date FROM stock_splits WHERE company_id = ? AND date > ? AND date <= ? LIMIT 1', ctx.companyId, from, to);
        if (split) throw badRequest(`A stock split on ${split.date} falls between ${from} and ${to}, so this date cannot be corrected: the share count would change with it.`);
        const event = await one<{ type: string; date: string }>(
          "SELECT type, date FROM transactions WHERE security_id = ? AND type NOT IN ('ISSUANCE', 'GRANT', 'CORRECTION') AND date < ? ORDER BY date LIMIT 1", ctx.params.id, values[ownDate]);
        if (event) throw badRequest(`The ${event.type.toLowerCase()} on ${event.date} comes before ${values[ownDate]}, so the date cannot move past it.`);
        // An MFN holder elected this instrument's terms: it had to be issued between the MFN
        // instrument's date and the election (mfnCandidates), or the election would lapse.
        const elected = r.table === 'convertibles' ? await one<{ date: string; issue_date: string }>(
          `SELECT t.date, m.issue_date FROM transactions t JOIN convertibles m ON m.id = t.security_id
            WHERE t.type = 'MFN_ELECTION' AND t.adopted_security_id = ? AND (t.date < ? OR m.issue_date > ?) ORDER BY t.date LIMIT 1`,
          ctx.params.id, values[ownDate], values[ownDate]) : null;
        if (elected) throw badRequest(`An MFN holder elected this instrument's terms on ${elected.date}, so its date must stay between the electing instrument's (${elected.issue_date}) and the election.`);
      }
      for (const field of identity) await entry({ date: values[ownDate], field, beforeValue: json(before[field]), afterValue: json(values[field]), memo: `${field} corrected from ${before[field]} to ${values[field]}: ${reason}` });
    }
    if (fixes.length > 0 || terms.length > 0) {
      // A correction says the record was wrong from a date on: the security's own date
      // if it always was, or a later one. Its entry is in the shares of that date.
      if (fixes.length > 0 && r.table === 'issuances' && before.status !== 'OUTSTANDING') throw badRequest('Only an outstanding certificate\'s share count can be corrected.');
      if (fixes.length > 0 && r.table === 'warrants' && ['CANCELLED', 'EXPIRED'].includes(String(before.status))) throw badRequest('A cancelled or expired warrant\'s counts cannot be corrected.');
      if (r.table === 'convertibles' && before.status !== 'OUTSTANDING') throw badRequest('Only an outstanding instrument\'s terms can be corrected.');
      const ownDate = String(values[EVENTS[r.table].ownDate]);
      const effective = date(ctx.body.effectiveDate, 'Effective date');
      if (effective < ownDate) throw badRequest(`The effective date cannot be before the ${r.label.toLowerCase()}'s own date, ${ownDate}.`);
      if (effective > today()) throw badRequest('The effective date cannot be in the future.');
      const data = await getCompanyData(ctx.companyId!);
      const k = splitFactor(data, ownDate, effective);
      if (fixes.length > 0 && (r.table === 'awards' || r.table === 'warrants')) usedUp(r, ctx.params.id, values, data);
      for (const { field, delta } of fixes) {
        await entry({ date: effective, quantity: roundShares(delta * k), field, memo: `${field} corrected from ${before[field]} to ${values[field]}` });
      }
      for (const field of terms) {
        await entry({ date: effective, field, beforeValue: json(before[field]), afterValue: json(values[field]), memo: `${field} corrected from ${before[field]} to ${values[field]}` });
      }
    }
    if (r.table === 'stock_splits' && (!same(before.date, values.date) || Number(before.ratio) !== Number(values.ratio))) {
      for (const on of new Set([String(before.date), String(values.date)])) await refuseSplitBehindLedger(ctx.companyId!, on);
      await recordSplit(ctx, before, values);
    }
    await update(r.table, ctx.params.id, values);
    invalidate(ctx.companyId!);
    // The signed certificate no longer says what the record does: it is voided, and a new one goes out for signature.
    if (r.table === 'issuances' && isIssued(before.status) && ['quantity', 'pricePerShare', ...IDENTITY.issuances].some((k) => !same(before[k], values[k]))) {
      await reissueCertificate(ctx, ctx.params.id);
    }
    // Only what moved, with its value before and after.
    const show = (v: unknown) => JSON.stringify(v ?? null).slice(0, 120);
    const changed = Object.keys(values).filter((k) => !same(before[k], values[k]));
    await audit(ctx, 'UPDATE', r.table, ctx.params.id, changed.length === 0 ? `${r.label} saved with no changes`
      : `${r.label} updated: ${changed.map((k) => `${k}: ${show(before[k])} → ${show(values[k])}`).join(', ')}`);
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
    const ev = EVENTS[r.table];
    const issued = !!ev && isIssued(existing.status);
    // An issued security entered by mistake can go while the ledger has only its creation;
    // anything that happened to it since is history, and an event route ends it instead.
    if (issued && await one("SELECT 1 FROM transactions WHERE security_id = ? AND company_id = ? AND type NOT IN ('ISSUANCE', 'GRANT') LIMIT 1", ctx.params.id, ctx.companyId)) {
      throw badRequest(`This ${r.label.toLowerCase()} has ledger history beyond its creation, so it cannot be deleted. Cancel it instead (POST /api/c/:cid/${r.path}/${ctx.params.id}/cancel).`);
    }
    // A convertible whose terms an MFN holder elected stays: the election points at it.
    if (r.table === 'convertibles' && await one('SELECT 1 FROM transactions WHERE adopted_security_id = ? AND company_id = ? LIMIT 1', ctx.params.id, ctx.companyId)) {
      throw badRequest('An MFN holder elected the terms of this instrument, so it cannot be deleted.');
    }
    const block = await r.guardDelete?.(ctx.params.id, ctx.companyId!);
    if (block) throw badRequest(block);
    if (issued) {
      const row = toCamel<Record<string, unknown>>(existing)!;
      const reason = (ctx.query.get('reason') ?? '').trim().slice(0, 500);
      await insert('transactions', {
        id: newId('tx'), companyId: ctx.companyId, type: 'CORRECTION', date: row[ev.ownDate], stakeholderId: row.stakeholderId ?? null, securityId: ctx.params.id,
        field: 'deleted', reason: reason || null, memo: `${r.label} entered by mistake, deleted`, createdAt: nowISO(), createdBy: ctx.user!.name,
      });
    }
    if (r.table === 'stock_splits') {
      await refuseSplitBehindLedger(ctx.companyId!, String(existing.date));
      await recordSplit(ctx, toCamel(existing)!, null);
    }
    await run(`DELETE FROM ${r.table} WHERE id = ? AND company_id = ?`, ctx.params.id, ctx.companyId);
    invalidate(ctx.companyId!);
    await audit(ctx, 'DELETE', r.table, ctx.params.id, `${r.label} deleted`);
    return { ok: true };
  });
}

void snake;
export const RESOURCE_PATHS = RESOURCES.map((r) => r.path);
