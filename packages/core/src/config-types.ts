/**
 * The shape of kosmitor.config.json, the one file that holds every setting an
 * operator can change: the brand, the limits, the defaults a new company starts
 * with, the compliance policy and the rest. kosmitor.config.schema.json describes
 * each entry and is what the server checks the file against.
 *
 * Types only, so the engine stays free of files and environment variables: the
 * server loads and checks the file (apps/server/src/config.ts) and passes values
 * in, and the browser receives the public part, PublicConfig, inside the page.
 */

export type PaletteShade = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
export type Palette = Record<PaletteShade, string>;

/** One answer to a multiple-choice question: the stored value, the words in emails, and the words on the button. */
export interface Choice { value: string; label: string; shortLabel: string }

export interface VestingTemplate {
  name: string;
  kind: 'TIME' | 'FULLY_VESTED';
  durationMonths: number;
  cliffMonths: number;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'WEEKLY' | 'DAILY';
  immediatePortion: number;
  yearWeights: number[] | null;
  /** Share of the unvested balance that vests on a change of control alone, 0 to 1. */
  singleTrigger: number;
  /** Share that vests when a change of control is followed by a termination, 0 to 1. */
  doubleTrigger: number;
}

export type AiProviderId = 'anthropic' | 'openai' | 'google';
export interface AiProviderSettings { enabled: boolean; models: string[]; endpoint: string }

export interface KosmitorConfig {
  brand: {
    productName: string;
    pageTitle: string;
    tagline: string;
    logoUrl: string | null;
    icons: { svg: string; ico: string; appleTouch: string };
    colors: {
      primary: Palette;
      accent: Palette;
      charts: string[];
      status: { good: string; warning: string; bad: string; track: string };
      avatarChoices: { value: string; label: string }[];
      initialsFallback: string[];
      certificateFrame: string;
    };
    signIn: {
      headline: string;
      subheadline: string;
      features: { title: string; detail: string }[];
      signInTitle: string;
      signInSubtitle: string;
      signUpTitle: string;
      signUpSubtitle: string;
    };
  };
  app: { url: string };
  server: { port: number; allowedOrigins: string[]; trustProxy: boolean };
  database: { poolMax: number };
  mail: {
    from: string; signature: string | null; smtpTimeoutSeconds: number; acsTimeoutSeconds: number;
    /** Email a welcome to each person who creates an account themselves. */
    welcomeEmail: boolean;
    /** Welcome emails the server sends per hour, from every sign-up together. 0 turns them off. */
    welcomeEmailsPerHour: number;
  };
  auth: {
    sessionDays: number;
    passwordMinLength: number;
    passwordMaxLength: number;
    resetLinkMinutes: number;
    adminResetLinkHours: number;
    resetEmailsPerHour: number;
    /** Lifetime of the link in an invitation email. */
    inviteLinkDays: number;
    /** Invitation emails one address can receive in a day, from every company together. */
    inviteEmailsPerAddressPerDay: number;
    passwordSignIn: boolean;
    selfSignup: boolean;
    /** Whether signing up sends a link to open before the account can be used; needs a mail transport. */
    verifyEmail: boolean;
    google: { clientId: string; allowedDomains: string[] };
  };
  demo: { enabled: boolean; email: string; password: string; description: string };
  valuationDesk: {
    enabled: boolean;
    name: string | null;
    /** One address, or a list with one per evaluator; each gets an email of its own. */
    email: string | string[] | null;
    /** Internal inbox for mandatory approval before evaluator delivery. Empty only while the desk is disabled. */
    approvalEmail: string;
    linkOpenDays: number;
    linkClosedDays: number;
    requestsPerCompanyPerDay: number;
    requestsPerPersonPerDay: number;
    noticesPerRequestPerDay: number;
    noticesPerCompanyPerDay: number;
    noticesPerPersonPerDay: number;
    noticesPerHour: number;
    statusEmailsPerRequestPerDay: number;
    /** Reports the team can upload to one request per day. 0 turns uploads off. */
    reportUploadsPerRequestPerDay: number;
    sendCooldownSeconds: number;
    resendCooldownMinutes: number;
    intake: {
      companySizes: Choice[];
      stages: Choice[];
      plans: Choice[];
      planTimings: Choice[];
      securityTypes: Choice[];
      softwareSuggestions: string[];
    };
  };
  limits: {
    jsonBodyMb: number;
    uploadMb: number;
    importUploadMb: number;
    importUploadRetentionDays: number;
    importMaxRows: number;
    importMaxSheets: number;
    importJsonMb: number;
    importUnzippedMb: number;
    importMaxTotalRows: number;
    ledgerPageSize: number;
    ledgerMaxPageSize: number;
    reportRows: number;
    reportMaxRows: number;
    reportPreviewRows: number;
  };
  compliance: {
    scoring: {
      start: number;
      points: { error: number; warning: number; info: number };
      bands: { min: number; label: string }[];
    };
    valuationExpiryWarningDays: number;
    election83bUrgentDays: number;
    rule701WarnHeadroom: number;
    authorizedSharesWarnRemaining: number;
    exerciseWindowWarnDays: number;
    grantExpiryNoticeDays: number;
    noteMaturityWarnDays: number;
  };
  alerts: { optionPoolLow: number; postMoneySafeOwnershipBanner: number; postMoneySafeOwnershipWarning: number };
  company: {
    entityType: 'C_CORP' | 'S_CORP' | 'LLC' | 'LTD';
    jurisdiction: string;
    legalNameSuffix: string;
    fiscalYearEnd: string;
    brandColor: string;
    commonClass: { name: string; authorized: number; parValue: number };
    exerciseRequests: boolean;
    portal: { showOwnership: boolean; showValuation: boolean; showDocuments: boolean; showExitModel: boolean; showUpdates: boolean };
    vestingSchedules: VestingTemplate[];
  };
  equity: {
    awardType: 'ISO' | 'NSO' | 'RSU' | 'RSA' | 'SAR' | 'PHANTOM' | 'GROWTH_SHARE';
    optionTermYears: number;
    postTerminationExerciseMonths: number;
    vestingMonths: number;
    cliffMonths: number;
    backLoadedWeights: number[];
    doubleTriggerWindowDays: number;
    signerTitle: string;
    convertibleSignerTitle: string;
    offerSignerTitle: string;
    offerExpiryDays: number;
    stockholderConsentThreshold: number;
    convertibleInstrument: 'SAFE_PRE' | 'SAFE_POST' | 'NOTE' | 'KISS';
    noteCompounding: 'SIMPLE' | 'ANNUAL' | 'MONTHLY' | 'DAILY';
    raiseNoteCompounding: 'SIMPLE' | 'ANNUAL' | 'MONTHLY' | 'DAILY';
    preferredClass: { authorized: number; originalIssuePrice: number; liquidationMultiple: number };
  };
  modeling: {
    roundName: string;
    preMoneyValuation: number;
    leadInvestment: number;
    targetPoolPercent: number;
    exitPresetsMillions: number[];
    exitValue: number;
    portalMaxExit: number;
    portalSalePriceMultiple: number;
  };
  tax: {
    defaultRates: {
      federalOrdinary: number; stateOrdinary: number; federalLongTerm: number; stateLongTerm: number;
      amtRate: number; medicare: number; socialSecurity: number; niit: number;
    };
  };
  stockComp: {
    defaultAssumptions: {
      volatility: number; riskFreeRate: number; dividendYield: number; expectedTermYears: number | null;
      attribution: 'GRADED' | 'STRAIGHT_LINE'; forfeiturePolicy: 'AS_OCCUR' | 'ESTIMATE'; forfeitureRate: number;
      standard: 'GAAP' | 'IFRS';
    };
  };
  locale: { locale: string; currency: string; importDateOrder: 'auto' | 'MDY' | 'DMY' };
  legal: {
    disclaimer: string; taxEstimateNote: string; esignConsent: string; esignAgreement: string;
    stockLegends: { when: 'always' | 'restricted' | 'plan' | 'notPlan' | 'nonUs'; text: string }[];
    convertibleLegend: string;
  };
  ai: {
    enabled: boolean;
    providers: Record<AiProviderId, AiProviderSettings>;
    maxOutputTokens: number;
    timeoutSeconds: number;
    historyTurns: number;
    maxQuestionChars: number;
    snapshot: { maxHolders: number; maxConvertibles: number; maxValuations: number; maxComplianceFindings: number };
    examplePrompts: string[];
  };
  analytics: { posthog: { key: string; host: string } };
  backup: { container: string; prefix: string; drillDatabase: string; maxRowDrift: number };
}

/**
 * What the browser is given: everything it shows or prefills, and nothing about
 * where mail goes, how the server is wired or which provider endpoints it calls.
 * The valuation team's name is resolved here, so the page never derives it.
 */
export interface PublicConfig {
  brand: KosmitorConfig['brand'];
  auth: Pick<KosmitorConfig['auth'], 'passwordMinLength' | 'passwordMaxLength' | 'resetLinkMinutes' | 'adminResetLinkHours' | 'inviteLinkDays' | 'passwordSignIn' | 'selfSignup'>;
  demo: KosmitorConfig['demo'];
  /**
   * statusEmails: whether valuationDesk.statusEmailsPerRequestPerDay lets any status email go out.
   * reportUploads: whether valuationDesk.reportUploadsPerRequestPerDay lets the team upload the report at all.
   */
  valuationDesk: { enabled: boolean; name: string; intake: KosmitorConfig['valuationDesk']['intake']; statusEmails: boolean; reportUploads: boolean };
  limits: Pick<KosmitorConfig['limits'], 'uploadMb' | 'importUploadMb' | 'ledgerMaxPageSize' | 'reportPreviewRows'>;
  compliance: Pick<KosmitorConfig['compliance'], 'valuationExpiryWarningDays' | 'scoring'>;
  alerts: KosmitorConfig['alerts'];
  company: Omit<KosmitorConfig['company'], 'vestingSchedules'>;
  equity: KosmitorConfig['equity'];
  modeling: KosmitorConfig['modeling'];
  stockComp: KosmitorConfig['stockComp'];
  locale: KosmitorConfig['locale'];
  legal: Pick<KosmitorConfig['legal'], 'disclaimer' | 'taxEstimateNote' | 'esignConsent' | 'esignAgreement'>;
  ai: Pick<KosmitorConfig['ai'], 'enabled' | 'examplePrompts'>;
  /** PostHog in the browser; null until analytics.posthog.key is set. */
  analytics: { posthog: { key: string; host: string } | null };
}
