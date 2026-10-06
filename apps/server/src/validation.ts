import { badRequest, date, num, str } from './http.ts';
import { one } from './db.ts';

const moneyFields = new Set(['parValue', 'originalIssuePrice', 'pricePerShare', 'strikePrice', 'fmvAtGrant',
  'principal', 'valuationCap', 'qualifiedFinancingMinimum', 'fairMarketValue', 'enterpriseValue', 'totalAssetsCents']);
const nonnegative = new Set(['quantity', 'authorized', 'exercisedQuantity', 'cancelledQuantity', 'liquidationMultiple',
  'votesPerShare', 'durationMonths', 'cliffMonths', 'ptepMonths', 'accelerationMonths', 'seniority', 'sortOrder', ...moneyFields]);
const integers = new Set(['durationMonths', 'cliffMonths', 'ptepMonths', 'accelerationMonths', 'seniority', 'sortOrder', ...moneyFields]);
const fractions = new Set(['discount', 'interestRate', 'dividendRate', 'evergreenPercent', 'immediatePortion', 'accelerationSingle', 'accelerationDouble']);
const booleans = new Set(['dividendCompounding', 'dividendsParticipate', 'payToPlay', 'isConvertible', 'earlyExercised',
  'earlyExerciseAllowed', 'rsuLiquidityCondition', 'returnForfeitures', 'netExercise', 'mfn', 'proRataRight']);
const dates = new Set(['date', 'startDate', 'terminationDate', 'issueDate', 'vestingStartDate', 'election83bFiledOn',
  'boardApprovalDate', 'grantDate', 'expirationDate', 'acceptedDate', 'shareholderApprovalDate', 'maturityDate',
  'convertedOn', 'effectiveDate', 'dueDate', 'incorporationDate']);
const choices: Record<string, Record<string, string[]>> = {
  stakeholders: { type: ['INDIVIDUAL', 'ENTITY', 'TRUST', 'FUND'], relation: ['FOUNDER', 'EMPLOYEE', 'ADVISOR', 'CONTRACTOR', 'INVESTOR', 'BOARD_MEMBER', 'FORMER_EMPLOYEE', 'OTHER'] },
  share_classes: { kind: ['COMMON', 'PREFERRED'], participation: ['NON_PARTICIPATING', 'FULL_PARTICIPATING', 'CAPPED_PARTICIPATING'], dividendType: ['NONE', 'CUMULATIVE', 'NON_CUMULATIVE'], antiDilution: ['NONE', 'BROAD_WEIGHTED', 'NARROW_WEIGHTED', 'FULL_RATCHET'] },
  issuances: { status: ['OUTSTANDING', 'CANCELLED', 'REPURCHASED', 'TRANSFERRED', 'CONVERTED', 'PENDING_SIGNATURE'] },
  awards: { type: ['ISO', 'NSO', 'RSU', 'RSA', 'SAR', 'PHANTOM', 'GROWTH_SHARE'], status: ['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE', 'OUTSTANDING', 'EXERCISED', 'CANCELLED', 'EXPIRED', 'FORFEITED'] },
  pools: { planType: ['STOCK_PLAN', 'INDUCEMENT', 'ESPP'] },
  warrants: { status: ['OUTSTANDING', 'EXERCISED', 'EXPIRED', 'CANCELLED'] },
  convertibles: { instrument: ['SAFE_PRE', 'SAFE_POST', 'NOTE', 'KISS'], compounding: ['SIMPLE', 'ANNUAL', 'MONTHLY', 'DAILY'], status: ['PENDING_APPROVAL', 'PENDING_SIGNATURE', 'OUTSTANDING', 'CONVERTED', 'REPAID', 'CANCELLED'] },
  vesting_schedules: { kind: ['TIME', 'MILESTONE', 'CUSTOM', 'FULLY_VESTED'], frequency: ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'WEEKLY', 'DAILY'] },
  // The same types and states as the core engine and the Record valuation form. This
  // list had drifted to values nothing else used, so every choice but a 409A, and the
  // Expired state, was refused on save.
  valuations: { type: ['409A', 'PREFERRED_PRICE', 'BOARD_ESTIMATE', 'SECONDARY'], status: ['DRAFT', 'ACTIVE', 'EXPIRED', 'SUPERSEDED'] },
};

export async function companyReference(table: string, id: unknown, companyId: string, label: string): Promise<void> {
  if (id == null || id === '') return;
  const value = str(id, label);
  if (!await one(`SELECT id FROM ${table} WHERE id = ? AND company_id = ?`, value, companyId)) {
    throw badRequest(`${label} must belong to this company.`);
  }
}

/** The wire format uses integer cents and integer micro-cents, never dollar floats. */
export async function validateEntity(table: string, values: Record<string, unknown>, companyId: string): Promise<void> {
  for (const [field, value] of Object.entries(values)) {
    if (value == null) {
      if (nonnegative.has(field) && !['accelerationMonths', 'valuationCap', 'qualifiedFinancingMinimum', 'enterpriseValue'].includes(field)) throw badRequest(`${field} cannot be empty.`);
      continue;
    }
    if (dates.has(field)) values[field] = date(value, field);
    else if (nonnegative.has(field)) values[field] = num(value, field, { min: 0, integer: integers.has(field) });
    else if (fractions.has(field)) values[field] = num(value, field, { min: 0, max: 1 });
    else if (field === 'conversionRatio' || field === 'ratio' || field === 'participationCap') {
      values[field] = num(value, field, { min: Number.EPSILON });
    } else if (field === 'amount' && table === 'pool_adjustments') values[field] = num(value, field);
    else if (booleans.has(field)) {
      if (![true, false, 0, 1].includes(value as boolean | number)) throw badRequest(`${field} must be true or false.`);
      values[field] = value === true || value === 1 ? 1 : 0;
    }
    const options = choices[table]?.[field];
    if (options && !options.includes(String(value))) throw badRequest(`Choose a valid ${field}.`);
  }
  // Tidy the two free-text fields that every table shares, but never decide here
  // whether they had to be filled in: that is the resource's own required list.
  // An update validates the stored row with the changes merged over it, so every
  // column the row leaves blank arrives as null, and rejecting null here would
  // make an untouched optional field block the whole save.
  for (const field of ['name', 'title']) {
    if (values[field] == null || values[field] === '') continue;
    values[field] = str(values[field], field, { max: 200 });
  }
  for (const [field, reference] of Object.entries({ stakeholderId: 'stakeholders', shareClassId: 'share_classes', poolId: 'pools', vestingScheduleId: 'vesting_schedules', sourceAwardId: 'awards', convertedIntoShareClassId: 'share_classes' })) {
    await companyReference(reference, values[field], companyId, field);
  }
  if (values.quantity != null && Number(values.quantity) <= 0) throw badRequest('Quantity must be greater than zero.');
  if (values.principal != null && Number(values.principal) <= 0) throw badRequest('Principal must be greater than zero.');
  if (Number(values.discount ?? 0) >= 1) throw badRequest('Discount must be less than 100%.');
  if (Number(values.exercisedQuantity ?? 0) + Number(values.cancelledQuantity ?? 0) > Number(values.quantity ?? Infinity)) throw badRequest('Exercised and cancelled shares cannot exceed the grant quantity.');
  for (const [earlier, later] of [['startDate', 'terminationDate'], ['grantDate', 'expirationDate'], ['issueDate', 'expirationDate'], ['issueDate', 'maturityDate'], ['issueDate', 'convertedOn'], ['effectiveDate', 'expirationDate']]) {
    if (values[earlier] && values[later] && String(values[later]) < String(values[earlier])) throw badRequest(`${later} cannot precede ${earlier}.`);
  }
  if (table === 'vesting_schedules') {
    if ((values.kind ?? 'TIME') === 'TIME' && Number(values.cliffMonths ?? 12) > Number(values.durationMonths ?? 48)) throw badRequest('The cliff cannot exceed the vesting duration.');
    for (const key of ['yearWeights', 'milestones', 'customTranches']) {
      if (values[key] == null) continue;
      let list: unknown = values[key];
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch { throw badRequest(`${key} must be valid JSON.`); } }
      if (!Array.isArray(list)) throw badRequest(`${key} must be an array.`);
      let total = 0;
      for (const item of list) {
        if (key === 'yearWeights') { total += num(item, key, { min: 0, max: 1 }); continue; }
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${key} contains an invalid entry.`);
        const row = item as Record<string, unknown>;
        if (key === 'customTranches') date(row.date, 'Tranche date');
        for (const f of ['targetDate', 'achievedDate']) if (row[f]) date(row[f], f);
        if (row.portion != null) total += num(row.portion, 'Portion', { min: 0, max: 1 });
        if (row.quantity != null) num(row.quantity, 'Tranche quantity', { min: 0 });
        if (row.portion == null && (key === 'milestones' || row.quantity == null)) throw badRequest(`${key} entries require a portion or quantity.`);
      }
      if (total > 1 + 1e-9) throw badRequest(`${key} portions cannot exceed 100%.`);
      values[key] = list;
    }
  }
}
