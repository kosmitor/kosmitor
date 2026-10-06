import type { CompanyData, ShareClass, VestingSchedule } from '../src/types.ts';
import { dollarsToPPS, dollarsToCents } from '../src/util.ts';

export const sched4yr: VestingSchedule = {
  id: 'vs_4yr', name: '4yr/1yr cliff', kind: 'TIME', durationMonths: 48, cliffMonths: 12,
  frequency: 'MONTHLY', immediatePortion: 0, yearWeights: null, milestones: null,
  customTranches: null, accelerationSingleTrigger: 0, accelerationDoubleTrigger: 0, accelerationMonths: null,
};

export const common: ShareClass = {
  id: 'sc_common', name: 'Common', kind: 'COMMON', authorized: 20_000_000,
  parValue: dollarsToPPS(0.0001), seniority: 0, originalIssuePrice: dollarsToPPS(0.0001),
  liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null,
  conversionRatio: 1, dividendType: 'NONE', dividendRate: 0, dividendCompounding: false,
  dividendsParticipateInResidual: false, votesPerShare: 1, antiDilution: 'NONE',
  payToPlay: false, issueDate: '2021-01-01', isConvertible: false,
};

export function seriesA(overrides: Partial<ShareClass> = {}): ShareClass {
  return {
    id: 'sc_a', name: 'Series A Preferred', kind: 'PREFERRED', authorized: 5_000_000,
    parValue: dollarsToPPS(0.0001), seniority: 1, originalIssuePrice: dollarsToPPS(1.00),
    liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null,
    conversionRatio: 1, dividendType: 'NONE', dividendRate: 0, dividendCompounding: false,
    dividendsParticipateInResidual: false, votesPerShare: 1, antiDilution: 'BROAD_WEIGHTED',
    payToPlay: false, issueDate: '2023-06-01', isConvertible: true, ...overrides,
  };
}

/** Two founders with 8M common, a 2M pool, nothing else. */
export function seedCompany(): CompanyData {
  return {
    shareClasses: [common],
    stakeholders: [
      { id: 'sh_a', name: 'Avery Stone', email: 'a@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', startDate: '2021-01-01', terminationDate: null, taxCountry: 'US', taxState: 'CA', entityGroupId: null },
      { id: 'sh_b', name: 'Bao Nguyen', email: 'b@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', startDate: '2021-01-01', terminationDate: null, taxCountry: 'US', taxState: 'CA', entityGroupId: null },
      { id: 'sh_e', name: 'Elena Ruiz', email: 'e@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', startDate: '2022-03-01', terminationDate: null, taxCountry: 'US', taxState: 'NY', entityGroupId: null },
      { id: 'sh_inv', name: 'Northwind Ventures', email: 'inv@example.com', type: 'FUND', relation: 'INVESTOR', startDate: null, terminationDate: null, taxCountry: 'US', taxState: 'DE', entityGroupId: null },
    ],
    issuances: [
      { id: 'is_1', certificateNo: 'CS-1', stakeholderId: 'sh_a', shareClassId: 'sc_common', quantity: 4_500_000, pricePerShare: dollarsToPPS(0.0001), issueDate: '2021-01-01', status: 'OUTSTANDING', vestingScheduleId: 'vs_4yr', vestingStartDate: '2021-01-01', earlyExercised: false, election83bFiledOn: '2021-01-10', sourceAwardId: null, notes: null },
      { id: 'is_2', certificateNo: 'CS-2', stakeholderId: 'sh_b', shareClassId: 'sc_common', quantity: 3_500_000, pricePerShare: dollarsToPPS(0.0001), issueDate: '2021-01-01', status: 'OUTSTANDING', vestingScheduleId: 'vs_4yr', vestingStartDate: '2021-01-01', earlyExercised: false, election83bFiledOn: '2021-01-10', sourceAwardId: null, notes: null },
    ],
    awards: [
      { id: 'aw_1', label: 'ISO-001', stakeholderId: 'sh_e', poolId: 'pool_1', type: 'ISO', quantity: 200_000, strikePrice: dollarsToPPS(0.10), grantDate: '2022-03-01', vestingStartDate: '2022-03-01', vestingScheduleId: 'vs_4yr', status: 'OUTSTANDING', expirationDate: '2032-03-01', ptepMonths: 3, earlyExerciseAllowed: false, exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: '2022-03-01', acceptedDate: '2022-03-05', fmvAtGrant: dollarsToPPS(0.10), rsuLiquidityCondition: false, notes: null },
    ],
    pools: [{ id: 'pool_1', name: '2021 Stock Plan', shareClassId: 'sc_common', authorized: 2_000_000, boardApprovalDate: '2021-01-01', shareholderApprovalDate: '2021-01-01', returnForfeituresToPool: true, evergreenPercent: null, planType: 'STOCK_PLAN' }],
    poolAdjustments: [],
    warrants: [],
    convertibles: [],
    vestingSchedules: [sched4yr],
    valuations: [{ id: 'v1', type: '409A', fairMarketValue: dollarsToPPS(0.10), effectiveDate: '2022-01-01', expirationDate: '2023-01-01', provider: 'Test', reportUrl: null, status: 'ACTIVE' }],
    stockSplits: [],
  };
}

export const $ = dollarsToCents;
export const $$ = dollarsToPPS;
