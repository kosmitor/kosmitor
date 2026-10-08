/**
 * The settings in kosmitor.config.json, checked and ready to read.
 *
 * Three layers, each winning over the one before:
 *   1. kosmitor.config.json at the repository root: every setting at its default.
 *   2. Your changes: the file named by KOSMITOR_CONFIG, or kosmitor.config.local.json
 *      next to the defaults when it exists. It only needs the entries you change.
 *   3. A few environment variables for values that differ per deployment
 *      (APP_URL, PORT, MAIL_FROM and the others in ENV below).
 * Secrets never go in either file: DATABASE_URL, SMTP_URL, ACS_CONNECTION_STRING,
 * KOSMITOR_SECRET_KEY and the backup credentials stay environment variables.
 *
 * The merged result is checked against kosmitor.config.schema.json, so a typo or a
 * wrong type stops the server at start with the exact entry named, rather than
 * surfacing later as odd behaviour. Read settings with config() at the moment they
 * are needed, not into module-level constants, so tests can change them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configureEngine, enginePolicyFrom, resetEngine, type KosmitorConfig, type PublicConfig, type VestingSchedule } from '@kosmitor/core';
import { SERVER_DIR } from './env.ts';

export type { KosmitorConfig, PublicConfig };

/** The repository root, where the param files live (/app in the container image). */
export const CONFIG_DIR = process.env.KOSMITOR_ROOT ? resolve(process.env.KOSMITOR_ROOT) : resolve(SERVER_DIR, '..', '..');
const BASE_FILE = 'kosmitor.config.json';
const LOCAL_FILE = 'kosmitor.config.local.json';
const SCHEMA_FILE = 'kosmitor.config.schema.json';

// --- Checking against the schema ----------------------------------------------

interface Schema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: return false;
  }
}

/**
 * Checks a value against the schema subset the param file uses. With `complete`,
 * every declared setting must be present (the merged result); without it, only
 * what is there is checked (one layer of changes). Unknown keys are always an
 * error, since they are almost always a misspelt setting that would be ignored.
 */
export function checkAgainstSchema(value: unknown, schema: Schema, complete: boolean, path = '', errors: string[] = []): string[] {
  const where = path || '(the file)';
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${where} must be ${types.map((t) => (t === 'null' ? 'null' : `a${/^[aeiou]/.test(t) ? 'n' : ''} ${t}`)).join(' or ')}, not ${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (value === null) return errors;
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where} must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where} must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where} is not in the expected form (${schema.pattern})`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where} needs at least ${schema.minItems} entr${schema.minItems === 1 ? 'y' : 'ies'}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where} can hold at most ${schema.maxItems} entr${schema.maxItems === 1 ? 'y' : 'ies'}`);
    // A list replaces the default whole, so its entries are always checked in full.
    if (schema.items) value.forEach((item, i) => checkAgainstSchema(item, schema.items!, true, `${path}[${i}]`, errors));
  }
  if (isObject(value) && schema.properties) {
    for (const key of Object.keys(value)) {
      if (key === '$schema' && !path) continue;
      const child = schema.properties[key];
      if (!child) errors.push(`${path ? `${path}.` : ''}${key} is not a setting (check the spelling against ${SCHEMA_FILE})`);
      else checkAgainstSchema(value[key], child, complete, path ? `${path}.${key}` : key, errors);
    }
    if (complete) {
      for (const key of Object.keys(schema.properties)) {
        if (key !== '$schema' && !(key in value)) errors.push(`${path ? `${path}.` : ''}${key} is missing`);
      }
    }
  }
  return errors;
}

/** Rules the schema cannot say: settings that only make sense together. */
function checkTogether(c: KosmitorConfig): string[] {
  const errors: string[] = [];
  const bands = c.compliance.scoring.bands;
  if (bands.some((b, i) => i > 0 && b.min >= bands[i - 1].min)) errors.push('compliance.scoring.bands must run from the highest min to the lowest');
  if (bands.at(-1)?.min !== 0) errors.push('compliance.scoring.bands must end with a band whose min is 0, so every score has words');
  if (c.auth.passwordMinLength > c.auth.passwordMaxLength) errors.push('auth.passwordMinLength cannot be more than auth.passwordMaxLength');
  if (c.limits.ledgerPageSize > c.limits.ledgerMaxPageSize) errors.push('limits.ledgerPageSize cannot be more than limits.ledgerMaxPageSize');
  if (c.limits.reportRows > c.limits.reportMaxRows) errors.push('limits.reportRows cannot be more than limits.reportMaxRows');
  if (c.limits.reportPreviewRows > c.limits.reportMaxRows) errors.push('limits.reportPreviewRows cannot be more than limits.reportMaxRows');
  if (!c.valuationDesk.intake.plans.some((p) => p.value === 'NEITHER')) errors.push('valuationDesk.intake.plans must keep the NEITHER answer');
  // noticesPerHour counts emails, one per address, so a list longer than it could never be sent a notice.
  const desk = c.valuationDesk.email;
  const evaluators = new Set((desk == null ? [] : Array.isArray(desk) ? desk : [desk]).map((a) => a.trim().toLowerCase())).size;
  if (evaluators > c.valuationDesk.noticesPerHour) {
    errors.push(`valuationDesk.noticesPerHour (${c.valuationDesk.noticesPerHour}) counts one email per address, so it cannot be fewer than the ${evaluators} addresses in valuationDesk.email`);
  }
  const sumsToOne = (w: number[]) => Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-6;
  if (!sumsToOne(c.equity.backLoadedWeights)) errors.push('equity.backLoadedWeights must add up to 1');
  if (c.equity.cliffMonths > c.equity.vestingMonths) errors.push('equity.cliffMonths cannot be longer than equity.vestingMonths');
  c.company.vestingSchedules.forEach((s, i) => {
    if (s.yearWeights && !sumsToOne(s.yearWeights)) errors.push(`company.vestingSchedules[${i}].yearWeights must add up to 1`);
    if (s.cliffMonths > s.durationMonths) errors.push(`company.vestingSchedules[${i}].cliffMonths cannot be longer than its durationMonths`);
  });
  for (const list of ['companySizes', 'stages', 'plans', 'planTimings', 'securityTypes'] as const) {
    const values = c.valuationDesk.intake[list].map((o) => o.value);
    if (new Set(values).size !== values.length) errors.push(`valuationDesk.intake.${list} has the same value twice`);
  }
  if (!Object.values(c.ai.providers).some((p) => p.enabled) && c.ai.enabled) errors.push('ai.enabled needs at least one provider in ai.providers with enabled: true');
  if (!(c.equity.stockholderConsentThreshold > 0)) errors.push('equity.stockholderConsentThreshold must be above 0');
  // The pattern only checks the shape; Intl is the judge of whether every page can format with it.
  try {
    Intl.getCanonicalLocales(c.locale.locale);
    new Intl.NumberFormat(c.locale.locale, { style: 'currency', currency: c.locale.currency });
    new Intl.DateTimeFormat(c.locale.locale);
  } catch {
    errors.push(`locale.locale "${c.locale.locale}" with locale.currency "${c.locale.currency}" is not something this runtime can format (try en-US and USD)`);
  }
  return errors;
}

// --- Loading -------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readJson(file: string): JsonObject {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    throw new ConfigError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) throw new ConfigError(`${file} must hold a JSON object`);
  return parsed;
}

/** Objects merge key by key; anything else, lists included, replaces the value before it. */
export function mergeSettings(base: JsonObject, change: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(change)) {
    if (key === '$schema') continue;
    out[key] = isObject(value) && isObject(base[key]) ? mergeSettings(base[key] as JsonObject, value) : value;
  }
  return out;
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Environment variables that set one entry each, for values that differ per
 * deployment. `problem` names a mistake the schema's message would not explain.
 */
const ENV: { name: string; path: string; parse: (v: string) => Json; problem?: (v: string) => string | null }[] = [
  { name: 'APP_URL', path: 'app.url', parse: (v) => v.replace(/\/+$/, '') },
  { name: 'PORT', path: 'server.port', parse: Number },
  { name: 'ALLOWED_ORIGINS', path: 'server.allowedOrigins', parse: (v) => list(v).map((o) => o.replace(/\/+$/, '')) },
  { name: 'TRUST_PROXY', path: 'server.trustProxy', parse: (v) => (/^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : v) },
  { name: 'PG_POOL_MAX', path: 'database.poolMax', parse: Number },
  { name: 'MAIL_FROM', path: 'mail.from', parse: (v) => v },
  { name: 'VERIFY_EMAIL', path: 'auth.verifyEmail', parse: (v) => (/^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : v) },
  { name: 'GOOGLE_CLIENT_ID', path: 'auth.google.clientId', parse: (v) => v },
  { name: 'GOOGLE_ALLOWED_DOMAINS', path: 'auth.google.allowedDomains', parse: (v) => list(v).map((d) => d.toLowerCase().replace(/^@/, '')) },
  // One address stays a string, as it always was; several, comma separated, become a
  // list, each address once, so one written twice does not count twice against its limit.
  { name: 'VALUATION_DESK_EMAIL', path: 'valuationDesk.email', parse: (v) => {
    const addresses = [...new Set(list(v).map((a) => a.toLowerCase()))];
    return addresses.length === 1 ? addresses[0] : addresses;
  }, problem: (v) => (list(v).some((a) => a.split('@').length > 2)
    ? 'an entry holds more than one @: separate several addresses with commas, not spaces or semicolons' : null) },
  { name: 'BACKUP_CONTAINER', path: 'backup.container', parse: (v) => v },
  { name: 'BACKUP_PREFIX', path: 'backup.prefix', parse: (v) => v },
  { name: 'DRILL_DATABASE', path: 'backup.drillDatabase', parse: (v) => v },
];

/** Which environment variable sets which entry, for the docs. */
export const ENV_OVERRIDES: readonly { name: string; path: string }[] = ENV.map(({ name, path }) => ({ name, path }));

/**
 * The environment variables above, as one more layer of changes, and what is
 * plainly wrong with any of them. An empty variable counts as unset.
 */
export function environmentLayer(env: NodeJS.ProcessEnv = process.env): { layer: JsonObject; used: string[]; problems: string[] } {
  const layer: JsonObject = {};
  const used: string[] = [];
  const problems: string[] = [];
  for (const { name, path, parse, problem } of ENV) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    used.push(name);
    const wrong = problem?.(raw);
    if (wrong) problems.push(`environment (${name}): ${wrong}`);
    const keys = path.split('.');
    let node = layer;
    for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as JsonObject;
    node[keys.at(-1)!] = parse(raw);
  }
  return { layer, used, problems };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Where the changes on top of the defaults come from, if anywhere. */
export function overridesFile(): string | null {
  const named = process.env.KOSMITOR_CONFIG?.trim();
  if (named) return isAbsolute(named) ? named : resolve(CONFIG_DIR, named);
  // Tests run on the shipped defaults, whatever a developer keeps in their own file.
  if (process.env.NODE_TEST_CONTEXT) return null;
  const local = resolve(CONFIG_DIR, LOCAL_FILE);
  return existsSync(local) ? local : null;
}

/**
 * Reads and checks every layer from disk. Throws a ConfigError naming each
 * problem. `extra` is one more layer on top, for tests.
 */
export function loadConfig(extra: JsonObject = {}): KosmitorConfig {
  const schema = readJson(resolve(CONFIG_DIR, SCHEMA_FILE)) as Schema;
  const baseFile = resolve(CONFIG_DIR, BASE_FILE);
  const base = readJson(baseFile);
  const errors: string[] = [];
  const baseErrors = checkAgainstSchema(base, schema, true);
  if (baseErrors.length) errors.push(...baseErrors.map((e) => `${BASE_FILE}: ${e}`));

  let merged = base;
  const file = overridesFile();
  if (file) {
    if (!existsSync(file)) throw new ConfigError(`KOSMITOR_CONFIG names ${file}, which does not exist`);
    const layer = readJson(file);
    errors.push(...checkAgainstSchema(layer, schema, false).map((e) => `${file}: ${e}`));
    merged = mergeSettings(merged, layer);
  }
  const { layer: envLayer, used, problems } = environmentLayer();
  if (used.length) {
    errors.push(...problems);
    errors.push(...checkAgainstSchema(envLayer, schema, false).map((e) => `environment (${used.join(', ')}): ${e}`));
    merged = mergeSettings(merged, envLayer);
  }
  if (Object.keys(extra).length) merged = mergeSettings(merged, extra);

  if (!errors.length) errors.push(...checkAgainstSchema(merged, schema, true));
  if (!errors.length) errors.push(...checkTogether(merged as unknown as KosmitorConfig));
  if (errors.length) {
    throw new ConfigError(`The configuration has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n  - ${errors.join('\n  - ')}`);
  }
  const { $schema: _ignored, ...settings } = merged;
  return deepFreeze(settings as unknown as KosmitorConfig);
}

let current: KosmitorConfig | null = null;
let testLayer: JsonObject = {};

/** Loads the settings and hands the engine its share, so every calculation agrees with the file. */
function apply(next: KosmitorConfig): KosmitorConfig {
  current = next;
  configureEngine(enginePolicyFrom(next));
  return next;
}

/** The settings in force. Loaded on first use and kept; call it where a value is needed. */
export function config(): KosmitorConfig {
  return current ?? apply(loadConfig(testLayer));
}

/**
 * For tests: settings on top of everything else, until resetConfig(). Each call
 * adds to the changes before it rather than replacing them.
 */
export function configure(changes: Record<string, unknown>): KosmitorConfig {
  const next = mergeSettings(testLayer, changes as JsonObject);
  const loaded = loadConfig(next);   // a rejected change leaves the earlier ones in force
  testLayer = next;
  return apply(loaded);
}

export function resetConfig(): void {
  testLayer = {};
  current = null;
  resetEngine();
}

// --- Derived values ----------------------------------------------------------------

/** What the valuation team is called, as it reads after "the". */
export const deskName = (c: KosmitorConfig = config()): string =>
  c.valuationDesk.name ?? `${c.brand.productName} valuation team`;

/** The name signed at the end of system emails. */
export const mailSignature = (c: KosmitorConfig = config()): string => c.mail.signature ?? c.brand.productName;

export const megabytes = (mb: number): number => Math.round(mb * 1024 * 1024);

/** The vesting schedules a new company starts with, in the engine's shape. */
export function vestingTemplates(c: KosmitorConfig = config()): Omit<VestingSchedule, 'id'>[] {
  return c.company.vestingSchedules.map((t) => ({
    name: t.name, kind: t.kind, durationMonths: t.durationMonths, cliffMonths: t.cliffMonths, frequency: t.frequency,
    immediatePortion: t.immediatePortion, yearWeights: t.yearWeights ? [...t.yearWeights] : null,
    milestones: null, customTranches: null,
    accelerationSingleTrigger: t.singleTrigger, accelerationDoubleTrigger: t.doubleTrigger, accelerationMonths: null,
  }));
}

/** The part of the settings the browser is given. Nothing here may be secret or say how the server is wired. */
export function publicConfig(c: KosmitorConfig = config()): PublicConfig {
  const { vestingSchedules: _schedules, ...company } = c.company;
  return {
    brand: c.brand,
    auth: {
      passwordMinLength: c.auth.passwordMinLength, passwordMaxLength: c.auth.passwordMaxLength,
      resetLinkMinutes: c.auth.resetLinkMinutes, adminResetLinkHours: c.auth.adminResetLinkHours, inviteLinkDays: c.auth.inviteLinkDays,
      passwordSignIn: c.auth.passwordSignIn, selfSignup: c.auth.selfSignup,
    },
    demo: c.demo.enabled ? c.demo : { ...c.demo, email: '', password: '' },
    // Whether the person who asked is emailed at each step, and whether the team can
    // upload the report, so the pages offer and promise only what the server does.
    valuationDesk: {
      enabled: c.valuationDesk.enabled, name: deskName(c), intake: c.valuationDesk.intake,
      statusEmails: c.valuationDesk.statusEmailsPerRequestPerDay > 0, reportUploads: c.valuationDesk.reportUploadsPerRequestPerDay > 0,
    },
    limits: {
      uploadMb: c.limits.uploadMb, importUploadMb: c.limits.importUploadMb,
      ledgerMaxPageSize: c.limits.ledgerMaxPageSize, reportPreviewRows: c.limits.reportPreviewRows,
    },
    compliance: { valuationExpiryWarningDays: c.compliance.valuationExpiryWarningDays, scoring: c.compliance.scoring },
    alerts: c.alerts,
    company,
    equity: c.equity,
    modeling: c.modeling,
    stockComp: c.stockComp,
    locale: c.locale,
    legal: { disclaimer: c.legal.disclaimer, taxEstimateNote: c.legal.taxEstimateNote, esignConsent: c.legal.esignConsent, esignAgreement: c.legal.esignAgreement },
    ai: { enabled: c.ai.enabled, examplePrompts: c.ai.examplePrompts },
  };
}

// --- The page head ----------------------------------------------------------------

/** Where index.html wants the head tags; the build keeps this comment for the server to fill. */
export const HEAD_PLACEHOLDER = '<!-- kosmitor:head -->';

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The palettes as the theme's colour variables. html:root outranks the stylesheet's :root, whichever loads last. */
function themeStyle(c: KosmitorConfig): string {
  const vars = [
    ...Object.entries(c.brand.colors.primary).map(([shade, hex]) => `--color-brand-${shade}:${hex}`),
    ...Object.entries(c.brand.colors.accent).map(([shade, hex]) => `--color-secondary-${shade}:${hex}`),
  ];
  return `html:root{${vars.join(';')}}`;
}

/**
 * The title, icons, colours and public settings for a page, in place of
 * HEAD_PLACEHOLDER. The settings travel as a JSON data block the page reads
 * synchronously, so nothing renders with the wrong name or colour first.
 */
export function renderHead(c: KosmitorConfig = config()): string {
  const { icons } = c.brand;
  const json = JSON.stringify(publicConfig(c)).replace(/</g, '\\u003c');
  return [
    `<title>${attr(c.brand.pageTitle)}</title>`,
    `<link rel="icon" href="${attr(icons.ico)}" sizes="32x32" />`,
    `<link rel="icon" type="image/svg+xml" href="${attr(icons.svg)}" />`,
    `<link rel="apple-touch-icon" href="${attr(icons.appleTouch)}" />`,
    `<style id="kosmitor-theme">${themeStyle(c)}</style>`,
    `<script type="application/json" id="kosmitor-config">${json}</script>`,
  ].join('\n    ');
}

/** The icon links for pages the server renders itself, such as printable certificates. */
export function iconLinks(c: KosmitorConfig = config()): string {
  const { icons } = c.brand;
  return `<link rel="icon" href="${attr(icons.ico)}" sizes="32x32"><link rel="icon" type="image/svg+xml" href="${attr(icons.svg)}">`;
}
