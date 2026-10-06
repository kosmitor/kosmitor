/**
 * The engine's policy settings: how compliance is scored, how early findings are
 * raised, and the assumptions it falls back on when a record leaves something
 * out. They start at the values below and the server replaces them with the ones
 * in kosmitor.config.json when it loads it (apps/server/src/config.ts), so every
 * calculation in the process agrees with the param file.
 *
 * Only policy lives here. Legal limits (the ISO $100,000 limit, Rule 701, the
 * 83(b) thirty days, the twelve-month 409A presumption, the ISO three-month
 * exercise rule) are law, stay constants where they are used, and are not
 * configurable.
 */
import type { KosmitorConfig } from './config-types.ts';
import type { StockCompAssumptions } from './accounting.ts';
import type { TaxRates } from './tax.ts';

export interface EnginePolicy {
  compliance: KosmitorConfig['compliance'];
  /** A termination this close to a change of control, either side, fires double-trigger acceleration. */
  doubleTriggerWindowDays: number;
  /** Post-termination exercise window assumed for an award that records none. */
  postTerminationExerciseMonths: number;
  /** Contractual term assumed for an option without an expiration date. */
  optionTermYears: number;
  taxRates: TaxRates;
  stockCompAssumptions: StockCompAssumptions;
}

export const DEFAULT_ENGINE_POLICY: EnginePolicy = Object.freeze({
  compliance: {
    scoring: {
      start: 100,
      points: { error: 12, warning: 4, info: 1 },
      bands: [
        { min: 85, label: 'In good shape' },
        { min: 60, label: 'A few items need attention' },
        { min: 0, label: 'Several findings need resolving' },
      ],
    },
    valuationExpiryWarningDays: 90,
    election83bUrgentDays: 7,
    rule701WarnHeadroom: 0.2,
    authorizedSharesWarnRemaining: 0.05,
    exerciseWindowWarnDays: 45,
    grantExpiryNoticeDays: 90,
    noteMaturityWarnDays: 90,
  },
  doubleTriggerWindowDays: 548,
  postTerminationExerciseMonths: 3,
  optionTermYears: 10,
  taxRates: {
    federalOrdinary: 0.37, stateOrdinary: 0.093,
    federalLongTerm: 0.2, stateLongTerm: 0.093,
    amtRate: 0.28, medicare: 0.0235, socialSecurity: 0, niit: 0.038,
  },
  stockCompAssumptions: {
    volatility: 0.6, riskFreeRate: 0.04, dividendYield: 0, expectedTermYears: null,
    attribution: 'GRADED', forfeiturePolicy: 'AS_OCCUR', forfeitureRate: 0.05, standard: 'GAAP',
  },
}) as EnginePolicy;

let current: EnginePolicy = DEFAULT_ENGINE_POLICY;

/** The policy in force. Read it at the moment of calculating, never into a module constant. */
export const enginePolicy = (): EnginePolicy => current;

/** Replaces the policy; the server calls it with the param file's values. */
export function configureEngine(next: EnginePolicy): void {
  current = next;
}

/** Back to the built-in values, for tests. */
export function resetEngine(): void {
  current = DEFAULT_ENGINE_POLICY;
}

/** The engine's policy as the param file states it. */
export function enginePolicyFrom(c: KosmitorConfig): EnginePolicy {
  return {
    compliance: c.compliance,
    doubleTriggerWindowDays: c.equity.doubleTriggerWindowDays,
    postTerminationExerciseMonths: c.equity.postTerminationExerciseMonths,
    optionTermYears: c.equity.optionTermYears,
    taxRates: c.tax.defaultRates,
    stockCompAssumptions: c.stockComp.defaultAssumptions,
  };
}
