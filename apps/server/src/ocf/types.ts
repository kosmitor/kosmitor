/**
 * The Open Cap Format (OCF) 1.2.0 as Kosmitor writes and reads it: the files of a
 * package, the objects in them, and the ids the export gives what it derives from a
 * row (a balance certificate, a vesting start, a split of one class). docs/ocf.md has
 * the mapping; the official JSON Schemas are vendored for the tests only
 * (apps/server/test/ocf-schema/v1.2.0).
 *
 * OCF keeps money as decimal strings with a currency ({ amount: "1250000.00",
 * currency: "USD" }) and counts as decimal strings ("4500000"); convert.ts turns them
 * into cents, micro-cents and numbers at the boundary and back.
 */

export const OCF_VERSION = '1.2.0';
/** Every schema `$id` starts with this. */
export const OCF_SCHEMA_BASE = 'https://schema.opencaptablecoalition.com/v/1.2.0/';

export type OcfFileType =
  | 'OCF_MANIFEST_FILE' | 'OCF_STAKEHOLDERS_FILE' | 'OCF_STOCK_CLASSES_FILE' | 'OCF_STOCK_LEGEND_TEMPLATES_FILE'
  | 'OCF_STOCK_PLANS_FILE' | 'OCF_TRANSACTIONS_FILE' | 'OCF_VALUATIONS_FILE' | 'OCF_VESTING_TERMS_FILE'
  | 'OCF_FINANCINGS_FILE' | 'OCF_DOCUMENTS_FILE';

/** The manifest's list of files of each type. */
export const OCF_MANIFEST_LISTS: Record<Exclude<OcfFileType, 'OCF_MANIFEST_FILE'>, string> = {
  OCF_STAKEHOLDERS_FILE: 'stakeholders_files',
  OCF_STOCK_CLASSES_FILE: 'stock_classes_files',
  OCF_STOCK_LEGEND_TEMPLATES_FILE: 'stock_legend_templates_files',
  OCF_STOCK_PLANS_FILE: 'stock_plans_files',
  OCF_VESTING_TERMS_FILE: 'vesting_terms_files',
  OCF_VALUATIONS_FILE: 'valuations_files',
  OCF_TRANSACTIONS_FILE: 'transactions_files',
  OCF_FINANCINGS_FILE: 'financings_files',
  OCF_DOCUMENTS_FILE: 'documents_files',
};

/** The manifest of an exported package, at the root of the zip. */
export const OCF_MANIFEST_PATH = 'Manifest.ocf.json';

/**
 * The files an exported package always holds besides the manifest, flat at the root of
 * the zip and named as in the coalition's samples, in the order the manifest lists them.
 * No financings or documents file is written.
 */
export const OCF_PACKAGE_FILES: readonly { fileType: Exclude<OcfFileType, 'OCF_MANIFEST_FILE'>; path: string }[] = [
  { fileType: 'OCF_STAKEHOLDERS_FILE', path: 'Stakeholders.ocf.json' },
  { fileType: 'OCF_STOCK_CLASSES_FILE', path: 'StockClasses.ocf.json' },
  { fileType: 'OCF_STOCK_LEGEND_TEMPLATES_FILE', path: 'StockLegends.ocf.json' },
  { fileType: 'OCF_STOCK_PLANS_FILE', path: 'StockPlans.ocf.json' },
  { fileType: 'OCF_VESTING_TERMS_FILE', path: 'VestingTerms.ocf.json' },
  { fileType: 'OCF_VALUATIONS_FILE', path: 'Valuations.ocf.json' },
  { fileType: 'OCF_TRANSACTIONS_FILE', path: 'Transactions.ocf.json' },
];

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * The ids the export gives OCF objects that are not a row of their own. A row's own
 * object keeps the row's id (stakeholders, classes, plans, schedules, valuations, and
 * every security's `security_id`), and an event from the ledger keeps the entry's id,
 * so an export is stable from one day to the next. The import never uses an OCF id as
 * a primary key: it keeps them in the memo of each ledger entry it writes, as
 * `(OCF <id>)`, and matches on them when a package goes back into the company it came from.
 */
export const ocfId = {
  /** The legend template of a share class. */
  legend: (shareClassId: string): string => `${shareClassId}.legend`,
  /** The n-th balance certificate (1, 2, ...) of a row, after a partial transfer, repurchase, cancellation or conversion. */
  balance: (rowId: string, n: number): string => `${rowId}.b${n}`,
  /** The issuance transaction of a security (a row's or a balance's). */
  issuance: (securityId: string): string => `${securityId}.issue`,
  vestingStart: (securityId: string): string => `${securityId}.vesting-start`,
  milestoneEvent: (securityId: string, milestoneId: string): string => `${securityId}.milestone.${milestoneId}`,
  acceptance: (awardId: string): string => `${awardId}.accept`,
  /** A stock split is one TX_STOCK_CLASS_SPLIT per class. */
  split: (stockSplitId: string, shareClassId: string): string => `${stockSplitId}.${shareClassId}`,
  /**
   * An event the export writes for a state the ledger does not date: a security closed
   * with no entry for it, or a count the entries do not explain. Dated the security's own date.
   */
  undated: (securityId: string, what: 'closed' | 'exercised' | 'cancelled'): string => `${securityId}.${what}`,
  /** Options a leaver lost with no ledger entry: unvested on leaving, or vested when the exercise window closed. */
  lapse: (awardId: string, what: 'lapsed' | 'window-closed'): string => `${awardId}.${what}`,
};

/** The ids of the vesting conditions the export writes (vesting.ts). */
export const CONDITION = {
  start: 'start',
  cliff: 'cliff',
  periodic: 'periodic',
  tranche: (k: number): string => `tranche-${k}`,
  milestone: (milestoneId: string): string => `milestone-${milestoneId}`,
} as const;

/** The trigger ids of an exported warrant and convertible. */
export const TRIGGER = { warrantExercise: 'exercise', conversion: 'conversion', maturity: 'maturity' } as const;

// ---------------------------------------------------------------------------
// Types shared by the objects
// ---------------------------------------------------------------------------

export interface OcfMonetary { amount: string; currency: string }
export interface OcfRatio { numerator: string; denominator: string }
export interface OcfPortion extends OcfRatio { remainder?: boolean }
export interface OcfName { legal_name: string; first_name?: string; last_name?: string }
export interface OcfEmail { email_type: 'PERSONAL' | 'BUSINESS' | 'OTHER'; email_address: string }
export interface OcfPhone { phone_type: 'HOME' | 'MOBILE' | 'BUSINESS' | 'OTHER'; phone_number: string }
export interface OcfAddress {
  address_type: 'LEGAL' | 'CONTACT' | 'OTHER';
  street_suite?: string; city?: string; country_subdivision?: string; country: string; postal_code?: string;
}
export interface OcfTaxId { tax_id: string; country: string }
export interface OcfSecurityExemption { description: string; jurisdiction: string }
export interface OcfVesting { date: string; amount: string }
export interface OcfTerminationWindow {
  reason: 'VOLUNTARY_OTHER' | 'VOLUNTARY_GOOD_CAUSE' | 'VOLUNTARY_RETIREMENT' | 'INVOLUNTARY_OTHER' | 'INVOLUNTARY_DEATH' | 'INVOLUNTARY_DISABILITY' | 'INVOLUNTARY_WITH_CAUSE';
  period: number;
  period_type: 'DAYS' | 'MONTHS' | 'YEARS';
}
export const TERMINATION_WINDOW_REASONS: OcfTerminationWindow['reason'][] = [
  'VOLUNTARY_OTHER', 'VOLUNTARY_GOOD_CAUSE', 'VOLUNTARY_RETIREMENT', 'INVOLUNTARY_OTHER', 'INVOLUNTARY_DEATH', 'INVOLUNTARY_DISABILITY', 'INVOLUNTARY_WITH_CAUSE',
];

/** What every OCF object has. `comments` may end with the Kosmitor note (notes.ts). */
export interface OcfObject { id: string; object_type: string; comments?: string[] }

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export interface OcfIssuer extends OcfObject {
  object_type: 'ISSUER';
  legal_name: string;
  dba?: string;
  formation_date: string;
  country_of_formation: string;
  country_subdivision_of_formation?: string;
  tax_ids?: OcfTaxId[];
  email?: OcfEmail;
  phone?: OcfPhone;
  address?: OcfAddress;
  initial_shares_authorized?: string;
}

export type OcfRelationship =
  | 'ADVISOR' | 'BOARD_MEMBER' | 'CONSULTANT' | 'EMPLOYEE' | 'EX_ADVISOR' | 'EX_CONSULTANT' | 'EX_EMPLOYEE'
  | 'EXECUTIVE' | 'FOUNDER' | 'INVESTOR' | 'NON_US_EMPLOYEE' | 'OFFICER' | 'OTHER';

export interface OcfStakeholder extends OcfObject {
  object_type: 'STAKEHOLDER';
  name: OcfName;
  stakeholder_type: 'INDIVIDUAL' | 'INSTITUTION';
  issuer_assigned_id?: string;
  current_relationship?: OcfRelationship;
  primary_contact?: { name: OcfName; emails?: OcfEmail[]; phone_numbers?: OcfPhone[] };
  contact_info?: { emails?: OcfEmail[]; phone_numbers?: OcfPhone[] };
  addresses?: OcfAddress[];
  tax_ids?: OcfTaxId[];
}

export interface OcfRatioConversionMechanism { type: 'RATIO_CONVERSION'; conversion_price: OcfMonetary; ratio: OcfRatio; rounding_type: 'CEILING' | 'FLOOR' | 'NORMAL' }

export interface OcfStockClass extends OcfObject {
  object_type: 'STOCK_CLASS';
  name: string;
  class_type: 'COMMON' | 'PREFERRED';
  default_id_prefix: string;
  initial_shares_authorized: string;
  board_approval_date?: string;
  stockholder_approval_date?: string;
  votes_per_share: string;
  par_value?: OcfMonetary;
  price_per_share?: OcfMonetary;
  seniority: string;
  conversion_rights?: {
    type?: 'STOCK_CLASS_CONVERSION_RIGHT';
    conversion_mechanism: OcfRatioConversionMechanism;
    converts_to_future_round?: boolean;
    converts_to_stock_class_id?: string;
  }[];
  liquidation_preference_multiple?: string;
  participation_cap_multiple?: string;
}

export interface OcfStockLegendTemplate extends OcfObject { object_type: 'STOCK_LEGEND_TEMPLATE'; name: string; text: string }

export interface OcfStockPlan extends OcfObject {
  object_type: 'STOCK_PLAN';
  plan_name: string;
  board_approval_date?: string;
  stockholder_approval_date?: string;
  initial_shares_reserved: string;
  default_cancellation_behavior?: 'RETIRE' | 'RETURN_TO_POOL' | 'HOLD_AS_CAPITAL_STOCK' | 'DEFINED_PER_PLAN_SECURITY';
  /** One of the two, never both. */
  stock_class_id?: string;
  stock_class_ids?: string[];
}

export type OcfVestingDayOfMonth =
  | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18'
  | '19' | '20' | '21' | '22' | '23' | '24' | '25' | '26' | '27' | '28'
  | '29_OR_LAST_DAY_OF_MONTH' | '30_OR_LAST_DAY_OF_MONTH' | '31_OR_LAST_DAY_OF_MONTH' | 'VESTING_START_DAY_OR_LAST_DAY_OF_MONTH';

export type OcfVestingPeriod =
  | { type: 'MONTHS'; length: number; occurrences: number; day_of_month: OcfVestingDayOfMonth }
  | { type: 'DAYS'; length: number; occurrences: number };

export type OcfVestingTrigger =
  | { type: 'VESTING_START_DATE' }
  | { type: 'VESTING_SCHEDULE_ABSOLUTE'; date: string }
  | { type: 'VESTING_SCHEDULE_RELATIVE'; period: OcfVestingPeriod; relative_to_condition_id: string }
  | { type: 'VESTING_EVENT' };

/** One node of a vesting graph: a `portion` of the security or a fixed `quantity`, never both. */
export interface OcfVestingCondition {
  id: string;
  description?: string;
  portion?: OcfPortion;
  quantity?: string;
  trigger: OcfVestingTrigger;
  next_condition_ids: string[];
}

export type OcfAllocationType =
  | 'CUMULATIVE_ROUNDING' | 'CUMULATIVE_ROUND_DOWN' | 'FRONT_LOADED' | 'BACK_LOADED'
  | 'FRONT_LOADED_TO_SINGLE_TRANCHE' | 'BACK_LOADED_TO_SINGLE_TRANCHE' | 'FRACTIONAL';

export interface OcfVestingTerms extends OcfObject {
  object_type: 'VESTING_TERMS';
  name: string;
  description: string;
  allocation_type: OcfAllocationType;
  vesting_conditions: OcfVestingCondition[];
}

export interface OcfValuation extends OcfObject {
  object_type: 'VALUATION';
  provider?: string;
  board_approval_date?: string;
  stockholder_approval_date?: string;
  price_per_share: OcfMonetary;
  effective_date: string;
  stock_class_id: string;
  valuation_type: '409A';
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Every transaction: an object with a date. Most are about one security (`security_id`). */
export interface OcfTransaction extends OcfObject { date: string; security_id?: string; [field: string]: unknown }

/** The fields every issuance shares (primitives/objects/transactions/issuance/Issuance). */
export interface OcfIssuanceBase extends OcfTransaction {
  security_id: string;
  custom_id: string;
  stakeholder_id: string;
  board_approval_date?: string;
  stockholder_approval_date?: string;
  consideration_text?: string;
  security_law_exemptions: OcfSecurityExemption[];
}

export interface OcfStockIssuance extends OcfIssuanceBase {
  object_type: 'TX_STOCK_ISSUANCE';
  stock_class_id: string;
  stock_plan_id?: string;
  share_price: OcfMonetary;
  quantity: string;
  vesting_terms_id?: string;
  vestings?: OcfVesting[];
  cost_basis?: OcfMonetary;
  stock_legend_ids: string[];
  issuance_type?: 'RSA' | 'FOUNDERS_STOCK';
}

export type OcfCompensationType = 'OPTION_NSO' | 'OPTION_ISO' | 'OPTION' | 'RSU' | 'CSAR' | 'SSAR';

export interface OcfEquityCompensationIssuance extends OcfIssuanceBase {
  object_type: 'TX_EQUITY_COMPENSATION_ISSUANCE' | 'TX_PLAN_SECURITY_ISSUANCE';
  stock_plan_id?: string;
  stock_class_id?: string;
  compensation_type: OcfCompensationType;
  option_grant_type?: 'NSO' | 'ISO' | 'INTL';
  quantity: string;
  exercise_price?: OcfMonetary;
  base_price?: OcfMonetary;
  early_exercisable?: boolean;
  vesting_terms_id?: string;
  vestings?: OcfVesting[];
  expiration_date: string | null;
  termination_exercise_windows: OcfTerminationWindow[];
}

export interface OcfConversionTrigger {
  type: 'AUTOMATIC_ON_CONDITION' | 'AUTOMATIC_ON_DATE' | 'ELECTIVE_IN_RANGE' | 'ELECTIVE_ON_CONDITION' | 'ELECTIVE_AT_WILL' | 'UNSPECIFIED';
  trigger_id: string;
  nickname?: string;
  trigger_description?: string;
  trigger_condition?: string;
  trigger_date?: string;
  start_date?: string;
  end_date?: string;
  conversion_right: {
    type?: 'CONVERTIBLE_CONVERSION_RIGHT' | 'WARRANT_CONVERSION_RIGHT' | 'STOCK_CLASS_CONVERSION_RIGHT';
    conversion_mechanism: { type: string; [field: string]: unknown };
    converts_to_future_round?: boolean;
    converts_to_stock_class_id?: string;
  };
}

export interface OcfWarrantIssuance extends OcfIssuanceBase {
  object_type: 'TX_WARRANT_ISSUANCE';
  quantity?: string;
  exercise_price?: OcfMonetary;
  purchase_price: OcfMonetary;
  exercise_triggers: OcfConversionTrigger[];
  warrant_expiration_date?: string;
  vesting_terms_id?: string;
  vestings?: OcfVesting[];
  quantity_source?: 'HUMAN_ESTIMATED' | 'MACHINE_ESTIMATED' | 'UNSPECIFIED' | 'INSTRUMENT_FIXED' | 'INSTRUMENT_MAX' | 'INSTRUMENT_MIN';
}

export interface OcfConvertibleIssuance extends OcfIssuanceBase {
  object_type: 'TX_CONVERTIBLE_ISSUANCE';
  investment_amount: OcfMonetary;
  convertible_type: 'NOTE' | 'SAFE' | 'CONVERTIBLE_SECURITY';
  conversion_triggers: OcfConversionTrigger[];
  pro_rata?: string;
  seniority: number;
}

/** A file of items: every file of a package but the manifest. */
export interface OcfItemsFile<T extends OcfObject = OcfObject> { file_type: Exclude<OcfFileType, 'OCF_MANIFEST_FILE'>; items: T[] }

export interface OcfFileRef { filepath: string; md5: string }

export interface OcfManifest {
  file_type: 'OCF_MANIFEST_FILE';
  ocf_version: string;
  issuer: OcfIssuer;
  as_of: string;
  generated_at: string;
  comments?: string[];
  stock_plans_files: OcfFileRef[];
  stock_legend_templates_files: OcfFileRef[];
  stock_classes_files: OcfFileRef[];
  vesting_terms_files: OcfFileRef[];
  valuations_files: OcfFileRef[];
  transactions_files: OcfFileRef[];
  stakeholders_files: OcfFileRef[];
  financings_files?: OcfFileRef[];
  documents_files?: OcfFileRef[];
}

/** One file of a package, by its path in the zip, and its JSON. */
export interface OcfPackageFile { path: string; json: OcfManifest | OcfItemsFile }
export interface OcfPackage { files: OcfPackageFile[] }
