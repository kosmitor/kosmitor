/**
 * Asking for a new 409A.
 *
 * A request goes to the valuation team the server is set up with (valuationDesk
 * in the param file), and only when valuationDesk.enabled offers the service.
 * The company answers an appraiser's information request for a 409A, every item
 * of it mandatory, and attaches the documents it asks for from its vault; the
 * team is emailed the answers, the names of the documents, the capital structure
 * and a private link to work the request from; and the person who asked gets a
 * recap. From there the team moves the request along (started, report
 * delivered, or closed) and the company sees each step on its 409A page, until
 * it records the valuation the report set and the request closes against it.
 * The person who asked is emailed at each step, at their account address.
 *
 * Turning the service off stops new requests and every message to the team.
 * Requests already made stay readable, can still be completed or cancelled,
 * the team's links keep working, and the person who asked still hears what
 * happens, so nothing in flight is stranded.
 *
 * What the app adds is the part a company usually gets wrong: knowing when a new
 * valuation is due, saying why in words an appraiser recognises, handing over
 * the capital structure in a form an appraiser can calculate with, and closing
 * the request against the valuation it produced so the history reads straight.
 *
 * Holder names never leave through anything built from the cap table. An
 * appraiser needs the capital structure to value common stock, not the names of
 * the people who hold it, so the structure in the emails and on the team's page,
 * and the workbook, carry share classes, instruments and grants by number and
 * price only. The only names that reach the team are the ones the company types
 * in answer to the appraiser's questions: its management team, the people on
 * below-market salaries, and how the buyer and seller in a secondary transaction
 * are described, for which the form asks for a role, such as "a new investor" or
 * "a co-founder", not a name. The documents the company attaches go as they are,
 * because the appraiser asked for them, and the app does not read inside them: a
 * SAFE names its investor. The emails list them by name only; the files
 * themselves are on the team's page, behind its link, while the request is open.
 *
 * The team can upload the report from its page. The app reads the fair market
 * value, the valuation date and the method from it, and fills in the team's
 * delivery form with them; the company sees them beside the report on its 409A
 * page, and records the 409A from them only when someone there has checked them
 * against the report and pressed the button. Nothing is ever recorded from a
 * reading alone.
 *
 * The team's link is a credential: whoever has it can change the status the
 * company sees. Only a hash of its token is stored, each notice to the team
 * mints a new one and retires the last, it never appears in anything the company
 * can read, and it stops working once the request has been closed a while.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { crc32 } from 'node:zlib';
import { route, assertFullView, badRequest, notFound, forbidden, newId, nowISO, audit, str, date as isoDate, HttpError, type Ctx } from '../http.ts';
import { all, one, insert, update, run, transaction, afterCommit } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { sendMail, mailConfigured, SINGLE_ADDRESS, type Message } from '../mail.ts';
import { xlsx } from '../xlsx-writer.ts';
import { config, deskName, mailSignature } from '../config.ts';
import { renderEmail, paragraphsOf, type EmailSection } from '../email.ts';
import { readFile, storeFile, maxUploadBytes } from './files.ts';
import { readReport, ReaderBusy } from '../report-reader.ts';
import type { ReportDetection } from '../report-detect.ts';
import { renderDocumentPdf, type Doc } from './certificates.ts';
import { isEditor, seesWholeCompany, seesWholeVault, FULL_VIEW_ROLES } from '../auth.ts';
import {
  valuationRefresh, describeRefreshTrigger, computeCapTable, computePoolSummaries, awardPosition, awardIsLive,
  normalizeSplits, longDate, isTransferIssuance, formatMoney, formatPPS, formatShares, today, daysBetween, fiscalYear,
  type Choice, type CompanyData, type RefreshTrigger, type ValuationRefresh,
} from '@kosmitor/core';

/** What a member who sees only their own holdings is told about a 409A request. */
const REQUEST_NEEDS_FULL_VIEW = 'A 409A request reads the whole cap table, which your role cannot see.';

/** A request is open until it completes or is cancelled. One list, used everywhere, so no copy of it drifts. */
export const OPEN_STATUSES = ['REQUESTED', 'IN_PROGRESS', 'DELIVERED'] as const;
const isOpen = (status: string): boolean => (OPEN_STATUSES as readonly string[]).includes(status);
/** The same list for SQL. The values are fixed words, never input. */
const OPEN_SQL = OPEN_STATUSES.map((s) => `'${s}'`).join(', ');

// --- Who does the work -------------------------------------------------------

/**
 * Whether this server offers the service at all. Off, nothing new is asked for
 * and the team is sent nothing; what was asked for before stays readable.
 */
const deskOn = (): boolean => config().valuationDesk.enabled;

/**
 * Where a new request is sent: valuationDesk.email, or VALUATION_DESK_EMAIL over
 * it. With neither, a request is saved and nobody is emailed, so a laptop or a
 * test run never mails a real person and no server mails one it was not given.
 */
export function deskAddress(): string | null {
  const configured = config().valuationDesk.email?.trim();
  if (!configured) return null;
  return SINGLE_ADDRESS.test(configured) ? configured.toLowerCase() : null;
}

// --- Counts and waits, in words -------------------------------------------------

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** A number as the messages say it: in words up to ten, in digits past that. */
const inWords = (n: number): string => WORDS[n] ?? String(n);
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n: number, noun: string): string => `${inWords(n)} ${noun}${n === 1 ? '' : 's'}`;
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${inWords(n)} times`);
/** A wait in words: "a minute", "ten minutes", "45 seconds". */
function span(seconds: number): string {
  const unit = (n: number, one: string, a: string) => (n === 1 ? `${a} ${one}` : count(n, one));
  if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, 'hour', 'an');
  if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, 'minute', 'a');
  return unit(seconds, 'second', 'a');
}

// --- The intake questions ------------------------------------------------------
// The lists are valuationDesk.intake in the param file; the web app's form reads
// the same lists from the settings in the page. LAST_409A is the form's own logic.
//
// Since version 2 the questions are an appraiser's information request for a
// 409A, and every item of it is mandatory: the valuation date, the financial
// statements, the pitch deck, the management team, the cap table and option
// ledger, the options to come, earlier reports, the charter, the SAFEs and notes,
// projections, secondary transactions, sweat equity, and expenses recorded below
// market rates. Each rule is checked here and not only in the form, so whatever
// reaches the team is complete. Requests made before keep the answers they were
// made with, and everything that reads answers treats a missing one as not asked.

export const LAST_409A = ['DATE', 'NEVER', 'UNKNOWN'] as const;
/** The valuation date: one the company names, or the most recent date, which the checklist allows. */
export const VALUATION_DATE_KINDS = ['LATEST', 'DATE'] as const;
/** Projections come as a file, or, when there are none, as revenue and EBITDA guidance. */
export const PROJECTION_KINDS = ['FILE', 'GUIDANCE'] as const;

/**
 * The documents the request asks for, in the order the checklist asks for them.
 * The web app's form uses the same words.
 */
export const DOCUMENT_ITEMS = [
  { item: 'HISTORICAL_FINANCIALS', label: 'Historical financial statements', guidance: 'The last three to four years, or every year since the company started if it is younger.' },
  { item: 'YTD_FINANCIALS', label: 'Year-to-date financial statements', guidance: 'From the start of this financial year to the valuation date.' },
  { item: 'PITCH_DECK', label: 'Pitch deck or company presentation', guidance: 'The latest one. It helps the appraiser understand the business.' },
  { item: 'PRIOR_VALUATIONS', label: 'Earlier valuation reports', guidance: 'So the new valuation stays consistent with the earlier assumptions.' },
  { item: 'CHARTER', label: 'Certificate of incorporation', guidance: 'The current one, with any amendments.' },
  { item: 'CONVERTIBLE_AGREEMENTS', label: 'SAFE and convertible note agreements', guidance: 'Every SAFE and note still outstanding.' },
  { item: 'PROJECTIONS', label: 'Financial projections', guidance: 'Three to five years, if you have them.' },
] as const;
export type DocumentItem = (typeof DOCUMENT_ITEMS)[number]['item'];
const ITEM_LABEL = new Map<string, string>(DOCUMENT_ITEMS.map((d) => [d.item, d.label]));
const ITEM_ORDER = new Map<string, number>(DOCUMENT_ITEMS.map((d, n) => [d.item, n]));
const isItem = (v: unknown): v is DocumentItem => typeof v === 'string' && ITEM_LABEL.has(v);

/** What to do when an item that has to be answered has no document. */
const ATTACH: Record<DocumentItem, string> = {
  HISTORICAL_FINANCIALS: 'Attach the historical financial statements, or say the company has not finished a financial year yet.',
  YTD_FINANCIALS: 'Attach the year-to-date financial statements.',
  PITCH_DECK: 'Attach the pitch deck or a company presentation.',
  PRIOR_VALUATIONS: 'Attach the report of the last 409A.',
  CHARTER: 'Attach the certificate of incorporation.',
  CONVERTIBLE_AGREEMENTS: 'Attach the SAFE and convertible note agreements, or say none are outstanding.',
  PROJECTIONS: 'Attach the financial projections, or give revenue and EBITDA guidance instead.',
};

export interface ManagementMember { name: string; title: string }
/** Money in cents; a loss is a negative EBITDA. */
export interface Guidance { year: number; revenue: number; ebitda: number }
export interface SecondaryTransaction {
  /** A value from valuationDesk.intake.securityTypes. */
  securityType: string;
  date: string | null;
  shares: number;
  /** Micro-cents, as every price per share in the app. */
  pricePerShare: number;
  /** How the price was set. */
  priceRationale: string;
  /** Why the transaction happened. */
  rationale: string;
  /** Described by role, such as "a new investor", not by name. */
  buyer: string;
  seller: string;
  expectRepeat: boolean;
}
export interface SweatEquityPerson {
  name: string; title: string;
  /** To is null while it is still the case. */
  from: string; to: string | null;
  /** The share of each working day spent on the company, 1 to 100. */
  timePercent: number;
  /** Cents a year. */
  marketSalary: number;
  /** Cents in total since the company started. */
  salaryReceived: number;
}
/** Cents, both. */
export interface BelowMarketExpense { nature: string; recorded: number; market: number }

export interface Intake {
  /** Each a value from its list in valuationDesk.intake. */
  companySize: string;
  stage: string;
  plans: string;
  plansTiming: string | null;
  last409a: (typeof LAST_409A)[number];
  last409aDate: string | null;
  software: string;
  // The information request, from version 2. None of these is there on a request
  // made before it, and a missing one reads as a question that was not asked.
  version?: 2;
  valuationDateKind?: (typeof VALUATION_DATE_KINDS)[number];
  valuationDate?: string | null;
  optionsToGrant?: number;
  noFullYearYet?: boolean;
  capTableConfirmed?: boolean;
  management?: ManagementMember[];
  convertiblesOutstanding?: boolean;
  projections?: (typeof PROJECTION_KINDS)[number];
  guidance?: Guidance[];
  secondary?: boolean;
  secondaryTransactions?: SecondaryTransaction[];
  sweatEquity?: boolean;
  sweatEquityPeople?: SweatEquityPerson[];
  belowMarketExpenses?: boolean;
  expenses?: BelowMarketExpense[];
  // Not answers: the company's record when the request was made, kept with them
  // so the team reads the statements and the guidance's years against the dates
  // the company had on file. Never taken from what the form sends.
  incorporationDate?: string | null;
  /** MM-DD. */
  fiscalYearEnd?: string | null;
}

function oneOf(v: unknown, options: readonly Choice[], message: string): string {
  const s = typeof v === 'string' ? v : '';
  if (!options.some((o) => o.value === s)) throw badRequest(message);
  return s;
}

/** The words for a stored answer. One given before its list changed reads as it was stored. */
const labelOf = (options: readonly Choice[], value: string): string => options.find((o) => o.value === value)?.label ?? value;

/** The most options a company could plan to grant, and the most money any amount here can be, in cents. */
const OPTIONS_MAX = 10_000_000_000;
const MONEY_MAX = 1e15;
const SHARES_MAX = 1e13;

/** A yes or no the form always asks. Only a real true or false answers it. */
function yesNo(v: unknown, message: string): boolean {
  if (typeof v !== 'boolean') throw badRequest(message);
  return v;
}

/** A whole number in its range. The form reads what people type and sends a number, so text is refused. */
function whole(v: unknown, min: number, max: number, message: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw badRequest(message);
  return v;
}

/** A real date in YYYY-MM-DD form, or null. */
function realDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/**
 * A short text in a row, on one line: trimmed, its spaces collapsed, and refused
 * when it is empty or past its limit. Even the longer answers are kept to one line,
 * since each becomes a cell of a table and a line of an email.
 */
function rowText(v: unknown, max: number, row: string, ask: string, what: string): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw badRequest(`${row}: ${ask}.`);
  if (s.length > max) throw badRequest(`${row}: keep ${what} to ${max} characters or fewer.`);
  return s;
}

/** A row as sent, or an empty one for anything that is not a row, so its first field is the one reported missing. */
const asRow = (r: unknown): Record<string, unknown> => (r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : {});

/** The rows a "yes" needs: at least one, and no more than the form offers. */
function rowsOf(v: unknown, max: number, none: string, many: string): Record<string, unknown>[] {
  const list = Array.isArray(v) ? v : [];
  if (list.length === 0) throw badRequest(none);
  if (list.length > max) throw badRequest(many);
  return list.map(asRow);
}

/** Revenue and EBITDA guidance for the next two or three years, in place of projections. */
function readGuidance(v: unknown): Guidance[] {
  const list = Array.isArray(v) ? v : [];
  if (list.length < 2 || list.length > 3) throw badRequest('Give revenue and EBITDA guidance for the next two or three years.');
  const year = Number(today().slice(0, 4));
  const rows = list.map(asRow).map((r, n) => {
    const row = `Guidance row ${n + 1}`;
    return {
      year: whole(r.year, year - 1, year + 10, `${row}: give a fiscal year from ${year - 1} to ${year + 10}.`),
      revenue: whole(r.revenue, 0, MONEY_MAX, `${row}: give the revenue.`),
      ebitda: whole(r.ebitda, -MONEY_MAX, MONEY_MAX, `${row}: give the EBITDA. A loss is a negative amount.`),
    };
  });
  if (rows.some((r, n) => n > 0 && r.year !== rows[n - 1].year + 1)) {
    throw badRequest('Give the guidance for consecutive years, the earliest first.');
  }
  return rows;
}

function readSecondary(v: unknown): SecondaryTransaction[] {
  const now = today();
  const types = config().valuationDesk.intake.securityTypes;
  return rowsOf(v, 20, 'List at least one secondary transaction, or answer no.', 'List at most 20 secondary transactions.').map((r, n) => {
    const row = `Secondary transaction ${n + 1}`;
    const securityType = oneOf(r.securityType, types, `${row}: choose the type of security.`);
    let date: string | null = null;
    if (r.date != null && r.date !== '') {
      date = realDate(r.date);
      if (!date) throw badRequest(`${row}: give a real date, or leave it out.`);
      if (date > now) throw badRequest(`${row}: the date cannot be in the future.`);
    }
    return {
      securityType, date,
      shares: whole(r.shares, 1, SHARES_MAX, `${row}: give the number of shares.`),
      pricePerShare: whole(r.pricePerShare, 0, MONEY_MAX, `${row}: give the price per share.`),
      priceRationale: rowText(r.priceRationale, 1000, row, 'say how the price was set', 'how the price was set'),
      rationale: rowText(r.rationale, 1000, row, 'say why it happened', 'why it happened'),
      buyer: rowText(r.buyer, 200, row, 'say who bought, such as "a new investor"', 'the buyer'),
      seller: rowText(r.seller, 200, row, 'say who sold, such as "a co-founder"', 'the seller'),
      expectRepeat: yesNo(r.expectRepeat, `${row}: say whether you expect it to happen again.`),
    };
  });
}

function readSweatEquity(v: unknown): SweatEquityPerson[] {
  const now = today();
  return rowsOf(v, 20, 'List at least one person on a below-market salary, or answer no.', 'List at most 20 people on below-market salaries.').map((r, n) => {
    const row = `Below-market salary, person ${n + 1}`;
    const name = rowText(r.name, 200, row, 'give their name', 'the name');
    const title = rowText(r.title, 200, row, 'give their title', 'the title');
    const from = realDate(r.from);
    if (!from) throw badRequest(`${row}: give the date it started.`);
    if (from > now) throw badRequest(`${row}: the start cannot be in the future.`);
    let to: string | null = null;
    if (r.to != null && r.to !== '') {
      to = realDate(r.to);
      if (!to) throw badRequest(`${row}: give a real end date, or leave it empty if it is still the case.`);
      if (to < from) throw badRequest(`${row}: the end cannot be before the start.`);
      if (to > now) throw badRequest(`${row}: the end cannot be in the future. Leave it empty if it is still the case.`);
    }
    return {
      name, title, from, to,
      timePercent: whole(r.timePercent, 1, 100, `${row}: give the share of each working day spent on the company, from 1 to 100 percent.`),
      marketSalary: whole(r.marketSalary, 0, MONEY_MAX, `${row}: give the market salary for the role, a year.`),
      salaryReceived: whole(r.salaryReceived, 0, MONEY_MAX, `${row}: give the salary received in total since the company started.`),
    };
  });
}

function readExpenses(v: unknown): BelowMarketExpense[] {
  return rowsOf(v, 20, 'List at least one expense recorded below market rates, or answer no.', 'List at most 20 expenses recorded below market rates.').map((r, n) => {
    const row = `Below-market expense ${n + 1}`;
    // Both amounts are a year's, as the form asks for them, so an annual rent and a
    // monthly one cannot be told apart only by guessing.
    return {
      nature: rowText(r.nature, 500, row, 'say what the expense is', 'what the expense is'),
      recorded: whole(r.recorded, 0, MONEY_MAX, `${row}: give the amount recorded in the books, a year.`),
      market: whole(r.market, 0, MONEY_MAX, `${row}: give the market rate, a year.`),
    };
  });
}

/**
 * The answers, checked against the configured lists and every rule of the
 * information request, in the order the form asks them. Anything else is refused
 * rather than stored and mailed. The documents are checked on their own, against
 * the vault (readDocuments). A "no" stores no rows, whatever rows were sent.
 */
export function readIntake(b: Record<string, unknown>): Intake {
  const q = config().valuationDesk.intake;
  const now = today();

  // The valuation: its date, the company, its plans, the options to come and the last 409A.
  const valuationDateKind = (VALUATION_DATE_KINDS as readonly unknown[]).includes(b.valuationDateKind)
    ? b.valuationDateKind as (typeof VALUATION_DATE_KINDS)[number] : null;
  if (!valuationDateKind) throw badRequest('Choose the date to value the common stock as of, or the most recent date.');
  let valuationDate: string | null = null;
  if (valuationDateKind === 'DATE') {
    valuationDate = realDate(b.valuationDate);
    if (!valuationDate) throw badRequest('Give the valuation date.');
    // A report is good for twelve months, so a date further out either way is a mistake.
    if (Math.abs(daysBetween(now, valuationDate)) > 365) throw badRequest('Choose a valuation date within a year of today.');
  }
  const companySize = oneOf(b.companySize, q.companySizes, 'Choose how many people work at the company.');
  const stage = oneOf(b.stage, q.stages, 'Choose the stage the company is at.');
  const plans = oneOf(b.plans, q.plans, 'Say whether you plan to grant options or close a financing round soon.');
  const plansTiming = plans === 'NEITHER' || b.plansTiming == null || b.plansTiming === ''
    ? null : oneOf(b.plansTiming, q.planTimings, 'Choose roughly when.');
  const optionsToGrant = whole(b.optionsToGrant, 0, OPTIONS_MAX, 'Give a ballpark number of options to grant in the next 6 to 12 months, or 0.');
  const last409a = typeof b.last409a === 'string' && (LAST_409A as readonly string[]).includes(b.last409a)
    ? b.last409a as Intake['last409a'] : null;
  if (!last409a) throw badRequest('Say when the last 409A was, or that there has not been one.');
  let last409aDate: string | null = null;
  if (last409a === 'DATE') {
    last409aDate = isoDate(b.last409aDate, 'Date of the last 409A');
    if (last409aDate > now) throw badRequest('The last 409A cannot be dated in the future.');
  }

  // The documents' conditions. The cap table and option ledger are the data
  // workbook the app makes, so what is asked is that they are up to date.
  const noFullYearYet = b.noFullYearYet === true;
  const convertiblesOutstanding = yesNo(b.convertiblesOutstanding, 'Say whether any SAFEs or convertible notes are outstanding.');
  const projections = (PROJECTION_KINDS as readonly unknown[]).includes(b.projections) ? b.projections as (typeof PROJECTION_KINDS)[number] : null;
  if (!projections) throw badRequest('Say whether you will attach projections or give revenue and EBITDA guidance.');
  const guidance = projections === 'GUIDANCE' ? readGuidance(b.guidance) : [];
  if (b.capTableConfirmed !== true) throw badRequest('Confirm the cap table and option ledger are up to date.');

  // The people.
  const management = rowsOf(b.management, 30, 'List at least one person on the management team, with their title.',
    'List at most 30 people on the management team.').map((r, n) => {
    const row = `Management team, person ${n + 1}`;
    return { name: rowText(r.name, 200, row, 'give their name', 'the name'), title: rowText(r.title, 200, row, 'give their title', 'the title') };
  });
  const sweatEquity = yesNo(b.sweatEquity, 'Say whether any key people have taken a below-market salary since the company started.');
  const sweatEquityPeople = sweatEquity ? readSweatEquity(b.sweatEquityPeople) : [];

  // The transactions.
  const secondary = yesNo(b.secondary, 'Say whether there has been a secondary transaction in the company’s stock.');
  const secondaryTransactions = secondary ? readSecondary(b.secondaryTransactions) : [];
  const belowMarketExpenses = yesNo(b.belowMarketExpenses, 'Say whether any operating expenses are recorded below market rates.');
  const expenses = belowMarketExpenses ? readExpenses(b.expenses) : [];

  const software = str(b.software, 'The software you use', { max: 200 }).replace(/\s+/g, ' ');
  return {
    version: 2,
    valuationDateKind, valuationDate, companySize, stage, plans, plansTiming, optionsToGrant, last409a, last409aDate,
    noFullYearYet, convertiblesOutstanding, projections, guidance, capTableConfirmed: true,
    management, sweatEquity, sweatEquityPeople, secondary, secondaryTransactions, belowMarketExpenses, expenses,
    software,
  };
}

/** A document the request hands over, filed against the item of the checklist it answers. */
export interface DocumentLink { item: DocumentItem; documentId: string }

/** Whether the answers make an item one that needs a document. */
function required(item: DocumentItem, i: Intake): boolean {
  if (item === 'HISTORICAL_FINANCIALS') return !i.noFullYearYet;
  if (item === 'PRIOR_VALUATIONS') return i.last409a === 'DATE';
  if (item === 'CONVERTIBLE_AGREEMENTS') return !!i.convertiblesOutstanding;
  if (item === 'PROJECTIONS') return i.projections === 'FILE';
  return true;
}

/**
 * Whether the answers say an item does not apply, so documents sent for it are
 * not kept, the way a "no" keeps no rows. Earlier reports never are: without a
 * 409A on record they are optional, and one sent anyway is still worth having.
 */
function moot(item: DocumentItem, i: Intake): boolean {
  if (item === 'HISTORICAL_FINANCIALS') return !!i.noFullYearYet;
  if (item === 'CONVERTIBLE_AGREEMENTS') return !i.convertiblesOutstanding;
  if (item === 'PROJECTIONS') return i.projections !== 'FILE';
  return false;
}

/** Something to open: a stored file, or text the app can render as a PDF. */
const OPENABLE = `((d.storage_key IS NOT NULL AND b.document_id IS NOT NULL) OR COALESCE(d.body, '') <> '')`;

/**
 * The documents a request hands over: each in this company's vault with something
 * to open, duplicates collapsed, and at least one for every item the answers make
 * mandatory. The same document may answer two items.
 */
export async function readDocuments(v: unknown, companyId: string, intake: Intake): Promise<DocumentLink[]> {
  const list = Array.isArray(v) ? v : [];
  if (list.length > 100) throw badRequest('Attach at most 100 documents to one request.');
  const seen = new Set<string>();
  const links: DocumentLink[] = [];
  for (const raw of list) {
    const r = asRow(raw);
    if (!isItem(r.item)) throw badRequest('One of the documents is filed against something the request does not ask for.');
    if (typeof r.documentId !== 'string' || !r.documentId || r.documentId.length > 100) {
      throw badRequest('One of the documents is not in this company’s vault. Choose it again from the vault.');
    }
    const key = `${r.item}|${r.documentId}`;
    if (seen.has(key) || moot(r.item, intake)) continue;
    seen.add(key);
    links.push({ item: r.item, documentId: r.documentId });
  }
  for (const d of DOCUMENT_ITEMS) {
    const n = links.filter((l) => l.item === d.item).length;
    if (n > 20) throw badRequest(`Attach at most 20 documents for each item. ${d.label} has ${n}.`);
  }

  const ids = [...new Set(links.map((l) => l.documentId))];
  if (ids.length) {
    const found = await all<{ id: string; name: string; openable: boolean }>(
      `SELECT d.id, d.name, ${OPENABLE} AS openable FROM documents d LEFT JOIN file_blobs b ON b.document_id = d.id
        WHERE d.company_id = ? AND d.id IN (${ids.map(() => '?').join(', ')})`, companyId, ...ids);
    const byId = new Map(found.map((d) => [d.id, d]));
    for (const id of ids) {
      const d = byId.get(id);
      // Another company's document reads exactly as one that does not exist, so
      // the answer says nothing about any company but this one.
      if (!d) throw badRequest('One of the documents is not in this company’s vault. Choose it again from the vault.');
      if (!d.openable) throw badRequest(`"${d.name}" has no file and no text, so there is nothing to send. Choose another document.`);
    }
  }
  for (const d of DOCUMENT_ITEMS) {
    if (required(d.item, intake) && !links.some((l) => l.item === d.item)) throw badRequest(ATTACH[d.item]);
  }
  return links;
}

// --- The answers against the company's records ---------------------------------

/** The company's dates as the request reads them. Each is checked, since the company settings store what they are given. */
export interface CompanyRecord { incorporationDate: string | null; fiscalYearEnd: string | null }

async function companyRecord(companyId: string): Promise<CompanyRecord> {
  const c = await one<{ incorporation_date: string | null; fiscal_year_end: string | null }>(
    'SELECT incorporation_date, fiscal_year_end FROM companies WHERE id = ?', companyId);
  const yearEnd = typeof c?.fiscal_year_end === 'string' && realDate(`2000-${c.fiscal_year_end}`) ? c.fiscal_year_end : null;
  return { incorporationDate: realDate(c?.incorporation_date), fiscalYearEnd: yearEnd };
}

/**
 * Whether the company has been in being for the whole of a fiscal year that has
 * ended: incorporated on or before the first day of its last completed fiscal
 * year. A year ends at the close of its last day, so on that day it has not ended
 * yet. Without both dates on record this says no. It errs one way only: a new
 * company's incorporation date starts as the day it signed up, so a date nobody
 * corrected makes the company look younger than it is and lets the answer through.
 */
export function finishedFullYear(record: CompanyRecord, asOf: string): boolean {
  if (!record.incorporationDate || !record.fiscalYearEnd) return false;
  const year = Number(asOf.slice(0, 4));
  const current = fiscalYear(year, record.fiscalYearEnd);
  const last = current.end < asOf ? current : fiscalYear(year - 1, record.fiscalYearEnd);
  return record.incorporationDate <= last.start;
}

/** Shares issued and outstanding, every class together. */
const sharesOutstanding = (s: Structure): number => s.classes.reduce((n, c) => n + c.outstanding, 0);

const NO_SHARES = 'Your cap table has no shares outstanding yet. Add the company’s shareholdings and option grants first, so the appraiser has the capital structure.';

/**
 * The answers checked against the company's records, which the form fills in
 * from but cannot hold anyone to. A request that confirms the cap table is
 * current cannot have nothing on it, since the capital structure and option
 * ledger the appraiser asked for come from it; nor can it say no SAFE or note is
 * outstanding when the cap table shows some, since the team would then get none
 * of their agreements. And "not finished a financial year yet" is an answer only
 * for a company too young to have finished one, since it stands in for the
 * historical statements.
 */
function checkAgainstRecords(intake: Intake, structure: Structure, record: CompanyRecord, asOf: string): void {
  if (sharesOutstanding(structure) === 0) throw badRequest(NO_SHARES);
  const n = structure.convertibles.count;
  if (n > 0 && !intake.convertiblesOutstanding) {
    throw badRequest(`Your cap table shows ${n === 1 ? 'one SAFE or note' : `${inWords(n)} SAFEs or notes`} outstanding. Answer yes and attach ${n === 1 ? 'its agreement' : 'their agreements'}, or update the cap table first.`);
  }
  if (intake.noFullYearYet && finishedFullYear(record, asOf)) {
    throw badRequest(`The company was incorporated on ${longDate(record.incorporationDate!)}, so it has finished a financial year. Attach the historical financial statements, or correct the incorporation date in the company settings.`);
  }
}

const yes = (b: boolean): string => (b ? 'Yes' : 'No');
/** A fiscal year end (MM-DD) the way the app prints a day of the year: "Dec 31". */
const monthDay = (mmdd: string): string => (realDate(`2000-${mmdd}`) ? longDate(`2000-${mmdd}`).replace(/, 2000$/, '') : mmdd);
/** A yes with its rows: "None", or how many there are, listed below. */
const listedBelow = (answer: boolean, rows: unknown[] | undefined): string =>
  answer && rows?.length ? `${capital(inWords(rows.length))}, below` : 'None';

/**
 * The answers as labelled lines, the same in both emails, on the team's page and
 * on the company's. Each line of the information request shows only when it was
 * asked, so a request made before reads as it always did.
 */
export function intakeLines(i: Intake): { label: string; value: string }[] {
  const q = config().valuationDesk.intake;
  return [
    ...(i.valuationDateKind ? [{
      label: 'Valuation date', value: i.valuationDateKind === 'DATE' && i.valuationDate ? longDate(i.valuationDate) : 'As of the most recent date',
    }] : []),
    { label: 'Company size', value: labelOf(q.companySizes, i.companySize) },
    { label: 'Stage', value: labelOf(q.stages, i.stage) },
    { label: 'Options or financing soon', value: `${labelOf(q.plans, i.plans)}${i.plansTiming ? `, ${labelOf(q.planTimings, i.plansTiming)}` : ''}` },
    ...(i.optionsToGrant != null ? [{ label: 'Options to grant in the next 6 to 12 months', value: i.optionsToGrant ? formatShares(i.optionsToGrant) : 'None' }] : []),
    {
      label: 'Last 409A',
      value: i.last409a === 'DATE' && i.last409aDate ? `Valued as of ${longDate(i.last409aDate)}`
        : i.last409a === 'NEVER' ? 'Never had one' : 'Not sure',
    },
    // From the company's record, next to the answers they bear on: whether a full
    // financial year has passed, and which months each year of guidance covers.
    ...(i.incorporationDate ? [{ label: 'Incorporated', value: longDate(i.incorporationDate) }] : []),
    ...(i.fiscalYearEnd ? [{ label: 'Fiscal year end', value: monthDay(i.fiscalYearEnd) }] : []),
    ...(i.noFullYearYet ? [{ label: 'Financial statements', value: 'The company has not finished a financial year yet' }] : []),
    ...(i.convertiblesOutstanding != null ? [{ label: 'SAFEs or notes outstanding', value: yes(i.convertiblesOutstanding) }] : []),
    ...(i.projections ? [{ label: 'Projections', value: i.projections === 'FILE' ? 'Attached' : 'Revenue and EBITDA guidance, below' }] : []),
    ...(i.capTableConfirmed ? [{ label: 'Cap table and option ledger', value: 'Confirmed up to date. The data workbook carries them.' }] : []),
    ...(i.sweatEquity != null ? [{ label: 'People on below-market salaries', value: listedBelow(i.sweatEquity, i.sweatEquityPeople) }] : []),
    ...(i.secondary != null ? [{ label: 'Secondary transactions', value: listedBelow(i.secondary, i.secondaryTransactions) }] : []),
    ...(i.belowMarketExpenses != null ? [{ label: 'Expenses below market rates', value: listedBelow(i.belowMarketExpenses, i.expenses) }] : []),
    { label: 'Software used today', value: i.software },
  ];
}

/** An answer that is a list of rows, as a table of display strings. */
export interface AnswerTable { title: string; columns: string[]; rows: string[][] }

/** An amount in cents as the tables show it: whole dollars when there are no cents. */
const amount = (cents: number): string => formatMoney(cents, cents % 100 === 0 ? { decimals: 0 } : {});

const MANAGEMENT_TABLE = 'Management team';

/**
 * The answers that are lists, one table each, for everything that shows them:
 * both emails, the company's page and the team's. Only the tables with rows, so
 * a request made before the information request has none.
 */
export function intakeTables(i: Intake): AnswerTable[] {
  const q = config().valuationDesk.intake;
  const tables: AnswerTable[] = [
    { title: MANAGEMENT_TABLE, columns: ['Name', 'Title'], rows: (i.management ?? []).map((m) => [m.name, m.title]) },
    {
      title: 'Revenue and EBITDA guidance', columns: ['Fiscal year', 'Revenue', 'EBITDA'],
      rows: (i.projections === 'GUIDANCE' ? i.guidance ?? [] : []).map((g) => [String(g.year), amount(g.revenue), amount(g.ebitda)]),
    },
    {
      title: 'Secondary transactions',
      columns: ['Security', 'Date', 'Shares', 'Price per share', 'How the price was set', 'Why it happened', 'Buyer', 'Seller', 'Likely to happen again'],
      rows: (i.secondary ? i.secondaryTransactions ?? [] : []).map((t) => [
        labelOf(q.securityTypes, t.securityType), t.date ? longDate(t.date) : 'Not given', formatShares(t.shares), formatPPS(t.pricePerShare),
        t.priceRationale, t.rationale, t.buyer, t.seller, yes(t.expectRepeat),
      ]),
    },
    {
      title: 'People on below-market salaries',
      columns: ['Name', 'Title', 'Period', 'Time on the company', 'Market salary a year', 'Salary received since inception'],
      rows: (i.sweatEquity ? i.sweatEquityPeople ?? [] : []).map((p) => [
        p.name, p.title, `${longDate(p.from)} to ${p.to ? longDate(p.to) : 'today'}`, `${p.timePercent}% of each working day`,
        amount(p.marketSalary), amount(p.salaryReceived),
      ]),
    },
    {
      title: 'Expenses below market rates', columns: ['Expense', 'Recorded in the books a year', 'Market rate a year'],
      rows: (i.belowMarketExpenses ? i.expenses ?? [] : []).map((e) => [e.nature, amount(e.recorded), amount(e.market)]),
    },
  ];
  return tables.filter((t) => t.rows.length);
}

/**
 * A table as an email's bullets: a person as "name, title", anything else as
 * "Column: value; ...", with a full stop someone typed at the end of a cell left
 * out so it does not run into the semicolon.
 */
const tableBullets = (t: AnswerTable): string[] =>
  t.rows.map((r) => (t.title === MANAGEMENT_TABLE ? `${r[0]}, ${r[1]}`
    : t.columns.map((c, n) => `${c}: ${r[n].replace(/\.$/, '')}`).join('; ')));

/**
 * One email address, and nothing that could turn into a second one or a header.
 * Commas, semicolons, angle brackets, spaces and line breaks are all refused
 * rather than cleaned, because a cleaned address is still one nobody typed.
 */
function email(v: unknown, field: string, optional = true): string | null {
  const s = str(v, field, { max: 254, optional });
  if (!s) return null;
  if (!SINGLE_ADDRESS.test(s)) throw badRequest(`${field} must be a single email address.`);
  return s.toLowerCase();
}

/** A name that goes into a greeting, on one line. */
const name = (v: unknown, field: string, optional: boolean): string | null => {
  const s = str(v, field, { max: 200, optional }).replace(/\s+/g, ' ');
  return s || null;
};

/** A phone number as people write one: digits, with spaces, dots, dashes, brackets and a leading plus. */
export function phone(v: unknown, field: string): string {
  const s = str(v, field, { max: 40 }).replace(/\s+/g, ' ');
  if (!/^\+?[\d ().-]+$/.test(s)) throw badRequest(`${field} can hold digits, spaces and + ( ) - . only.`);
  const digits = s.replace(/\D/g, '').length;
  if (digits < 7 || digits > 15) throw badRequest(`${field} should have between 7 and 15 digits.`);
  return s;
}

// --- The capital structure, without anybody in it ---------------------------

export type TriggerWithText = RefreshTrigger & { text: string };
export type RefreshWithText = Omit<ValuationRefresh, 'triggers'> & { triggers: TriggerWithText[] };

/**
 * The refresh check with each reason in a sentence. The company is told what to
 * do about it; the appraiser, who is outside the company, is told the facts.
 */
export function refreshWithText(data: CompanyData, asOf: string, audience: 'company' | 'appraiser' = 'company'): RefreshWithText {
  const r = valuationRefresh(data, asOf, config().compliance.valuationExpiryWarningDays);
  return {
    ...r,
    triggers: r.triggers.map((t) => ({ ...t, text: describeRefreshTrigger(t, longDate, (c) => formatMoney(c, { compact: true }), audience) })),
  };
}

interface StructureClass {
  name: string; kind: string; authorized: number; outstanding: number;
  originalIssuePrice: number; liquidationMultiple: number; participation: string;
  participationCap: number | null; conversionRatio: number; seniority: number;
  dividendType: string; dividendRate: number; issueDate: string;
}

export interface Structure {
  asOf: string;
  fullyDiluted: number;
  classes: StructureClass[];
  optionsOutstanding: number;
  rsusOutstanding: number;
  warrantsOutstanding: number;
  poolAvailable: number;
  convertibles: { count: number; principal: number };
}

export function structureOf(data: CompanyData, asOf: string): Structure {
  // The same view the cap table page opens on: fully diluted, with the
  // unallocated pool, without estimating what the convertibles become. The
  // engine adjusts for stock splits internally, so the class terms read here are
  // adjusted too, or a split would leave authorized shares and issue prices on
  // one basis and outstanding shares on another.
  const adjusted = normalizeSplits(data, asOf);
  const table = computeCapTable(adjusted, { asOf, includeUnallocatedPool: true, includeConvertibles: false });
  const byId = new Map(adjusted.shareClasses.map((c) => [c.id, c]));
  const live = adjusted.convertibles.filter((c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf);
  return {
    asOf,
    fullyDiluted: table.totals.fullyDiluted,
    classes: table.classes.map((row) => {
      const c = byId.get(row.shareClassId)!;
      return {
        name: c.name, kind: c.kind, authorized: row.authorized, outstanding: row.outstanding,
        originalIssuePrice: c.originalIssuePrice, liquidationMultiple: c.liquidationMultiple,
        participation: c.participation, participationCap: c.participationCap, conversionRatio: c.conversionRatio,
        seniority: c.seniority, dividendType: c.dividendType, dividendRate: c.dividendRate, issueDate: c.issueDate,
      };
    }),
    optionsOutstanding: table.totals.optionsOutstanding,
    rsusOutstanding: table.totals.rsusOutstanding,
    warrantsOutstanding: table.totals.warrantsOutstanding,
    poolAvailable: table.totals.poolAvailable,
    convertibles: { count: live.length, principal: live.reduce((s, c) => s + c.principal, 0) },
  };
}

const PARTICIPATION: Record<string, string> = {
  NON_PARTICIPATING: 'non-participating', FULL_PARTICIPATING: 'fully participating', CAPPED_PARTICIPATING: 'participating with a cap',
};

/** What an appraiser reads about the company: why now, the 409A on file, and the structure. */
export interface Situation { refresh: RefreshWithText; structure: Structure; splitSinceValuation: boolean }

async function situationOf(companyId: string): Promise<Situation> {
  const data = await getCompanyData(companyId);
  const asOf = today();
  const refresh = refreshWithText(data, asOf, 'appraiser');
  return {
    refresh,
    structure: structureOf(data, asOf),
    splitSinceValuation: !!refresh.current && data.stockSplits.some((sp) => sp.date > refresh.current!.effectiveDate && sp.date <= asOf),
  };
}

/** The situation in its three parts, so the team's page and the team's email say the same thing. */
export interface SituationParts {
  /** Why a new valuation is being asked for, one fact per entry. */
  whyNow: string[];
  /** The 409A on file, in a sentence. */
  current: string;
  /** "Capital structure as of Jul 1, 2025". */
  structureTitle: string;
  /** The capital structure, one labelled line per class or instrument. */
  structure: { label: string; value: string }[];
}

export function situationParts(s: Situation): SituationParts {
  const { refresh, structure: st } = s;
  return {
    whyNow: refresh.triggers.length ? refresh.triggers.map((t) => t.text) : ['The company has asked for a refreshed valuation.'],
    current: refresh.current
      ? `Valued as of ${longDate(refresh.current.effectiveDate)} at ${formatPPS(refresh.current.fairMarketValue)} per common share${s.splitSinceValuation ? ', as recorded before a later stock split' : ''}${refresh.current.provider ? `, by ${refresh.current.provider}` : ''}. It reaches twelve months, or its stated expiry, on ${longDate(refresh.current.expiresOn)}.`
      : 'There is no 409A valuation on file.',
    structureTitle: `Capital structure as of ${longDate(st.asOf)}`,
    structure: [
      { label: 'Fully diluted shares', value: formatShares(st.fullyDiluted) },
      ...st.classes.map((c) => ({
        label: c.name,
        value: c.kind === 'PREFERRED'
          ? `${formatShares(c.outstanding)} shares outstanding, issued at ${formatPPS(c.originalIssuePrice)}, ${c.liquidationMultiple}x ${PARTICIPATION[c.participation] ?? c.participation}`
          : `${formatShares(c.outstanding)} shares outstanding`,
      })),
      { label: 'Options outstanding', value: formatShares(st.optionsOutstanding) },
      ...(st.rsusOutstanding ? [{ label: 'Restricted stock units outstanding', value: formatShares(st.rsusOutstanding) }] : []),
      { label: 'Unallocated option pool', value: formatShares(st.poolAvailable) },
      ...(st.warrantsOutstanding ? [{ label: 'Warrants outstanding', value: formatShares(st.warrantsOutstanding) }] : []),
      ...(st.convertibles.count
        ? [{ label: 'Convertibles outstanding', value: `${st.convertibles.count}, totalling ${formatMoney(st.convertibles.principal, { compact: true })} in principal` }]
        : []),
    ],
  };
}

/** The why-now, current-409A and structure sections, as lines of plain text. */
export function situationLines(s: Situation): string[] {
  const p = situationParts(s);
  return [
    'Why now',
    ...p.whyNow.map((t) => `- ${t}`),
    '',
    'The current 409A',
    p.current,
    '',
    p.structureTitle,
    ...p.structure.map((d) => `${d.label}: ${d.value}`),
  ];
}

// --- The emails ----------------------------------------------------------------

/** A legal name can be any length, and a header line past 998 characters is one a strict mail server refuses. */
const subjectName = (companyName: string): string => (companyName.length > 150 ? `${companyName.slice(0, 147)}...` : companyName);
/** A legal name often ends in "Inc.", and a second full stop after it reads as a typo. */
const sentence = (s: string): string => (s.endsWith('.') ? s : `${s}.`);

export interface Contact { name: string | null; email: string; phone: string }

/** A document sent with a request, as an email names it: by item and name, never by a link. */
export interface ListedDocument { itemLabel: string; name: string }

/** The answers that are lists, one section of bullets each. */
const tableSections = (i: Intake): EmailSection[] => intakeTables(i).map((t) => ({ title: t.title, bullets: tableBullets(t) }));

/** The documents, one line per item with the names of its documents under it. */
function documentDetails(documents: ListedDocument[]): { label: string; value: string }[] {
  const byItem = new Map<string, string[]>();
  for (const d of documents) byItem.set(d.itemLabel, [...(byItem.get(d.itemLabel) ?? []), d.name]);
  return [...byItem].map(([label, names]) => ({ label, value: names.join('\n') }));
}

export interface RecapEmail {
  companyName: string;
  /** The requester's own account address, never one typed into the form. */
  to: string;
  toName: string;
  contact: Contact;
  intake: Intake;
  /** What was attached, by name. The recap only reminds the person what they sent. */
  documents: ListedDocument[];
  notes: string | null;
  /** Where the company follows the request. */
  statusUrl: string;
  /** Replies reach the team, when there is one to reach. */
  replyTo: string | null;
}

/** How to reach someone, one way per line, the way the details box shows it. */
const contactLines = (c: Contact): string => [c.name, c.email, c.phone].filter(Boolean).join('\n');

/** The recap to the person who asked. Pure, so what it says can be tested without sending it. */
export function composeRecapEmail(r: RecapEmail): Message {
  const desk = deskName();
  const product = config().brand.productName;
  const subject = `Your 409A request for ${subjectName(r.companyName)} was received`;
  const { html, text } = renderEmail({
    preview: `The ${desk} will contact you to confirm scope, price and timing.`,
    heading: 'We have your 409A request',
    greeting: `Hi ${r.toName},`,
    intro: [
      `${product} has your request for a 409A valuation of ${sentence(r.companyName)} A 409A is an independent appraisal of what one common share is worth, used to set the price of new stock options.`,
      r.replyTo
        ? 'There is nothing you need to do now. Your answers are below. If anything is wrong, reply to this email.'
        : 'There is nothing you need to do now. Your answers are below. You can change your contact details and notes on the 409A page until the report is delivered.',
    ],
    details: [
      ...intakeLines(r.intake),
      { label: 'Contact', value: contactLines(r.contact) },
    ],
    action: { label: 'Follow your request', url: r.statusUrl },
    actionNote: `The 409A page in ${product} shows when the team has your request, and each step after that.`,
    sections: [
      {
        title: 'What happens next',
        bullets: [
          `The ${desk} will contact you at ${r.contact.email} or ${r.contact.phone} to confirm scope, price and timing.`,
          // Only while the emails are on (valuationDesk.statusEmailsPerRequestPerDay), so the recap never promises one that cannot come.
          ...(config().valuationDesk.statusEmailsPerRequestPerDay > 0
            ? ['We will email you at each step, such as when the team starts and when the report is delivered.'] : []),
          `When the report arrives, record the new 409A from this request on the 409A page in ${product}; that closes the request.`,
        ],
      },
      ...tableSections(r.intake),
      ...(r.documents.length ? [{
        title: 'The documents you attached',
        paragraphs: ['They stay in your vault. The team opens them from its request page while the request is open.'],
        details: documentDetails(r.documents),
      }] : []),
      ...(r.notes ? [{ title: 'Your notes', paragraphs: paragraphsOf(r.notes) }] : []),
    ],
    signoff: `— ${mailSignature()}`,
    footer: `You are receiving this because you asked ${product} for a 409A valuation of ${sentence(r.companyName)} If that was not you, cancel the request on the 409A page.`,
  }, subject);
  return { to: r.to, toName: r.toName, replyTo: r.replyTo ?? undefined, subject, text, html };
}

export interface DeskEmail {
  companyName: string;
  to: string;
  requestedAt: string;
  requestedBy: string;
  contact: Contact;
  intake: Intake;
  /**
   * What was attached, by name only. The files are on the request page, behind
   * the link, so the email carries no link to one, no contents and no attachment.
   */
  documents: ListedDocument[];
  notes: string | null;
  situation: Situation;
  /** The private page for this request. */
  link: string;
}

/** The notice to the valuation team that a request is waiting. Pure, like the recap. */
export function composeDeskEmail(r: DeskEmail): Message {
  const who = r.contact.name ?? r.requestedBy;
  const when = longDate(r.requestedAt.slice(0, 10));
  const product = config().brand.productName;
  const { linkOpenDays, linkClosedDays } = config().valuationDesk;
  const situation = situationParts(r.situation);
  const subject = `New 409A request from ${subjectName(r.companyName)}`;
  // A message to a team inbox: no greeting, since nobody in particular reads it.
  const { html, text } = renderEmail({
    preview: `Asked by ${who} on ${when}: their answers, the capital structure and a private link to work the request from.`,
    heading: 'A new 409A request is waiting',
    intro: [
      `${who} at ${r.companyName} asked for a 409A valuation on ${when}. Their contact details are below. Write to them in a new email rather than replying to or forwarding this one, since this one carries the link.`,
      `Start from the request page. It has the data workbook${r.documents.length ? ' and the documents the company attached' : ''}, and it is where you mark the request started, deliver the report, or close it. The company sees each step on its 409A page.`,
    ],
    details: [
      { label: 'Company', value: r.companyName },
      ...(r.contact.name && r.contact.name !== r.requestedBy ? [{ label: 'Asked by', value: r.requestedBy }] : []),
      { label: 'Asked on', value: when },
      { label: 'Contact', value: contactLines(r.contact) },
    ],
    action: { label: 'Open the request', url: r.link },
    actionNote: `The link opens this request only. Keep it to yourself: whoever has it can change the status the company sees. It stops working after ${count(linkOpenDays, 'day')}, ${count(linkClosedDays, 'day')} after the request closes, or when a new notice replaces it, whichever comes first.`,
    sections: [
      { title: 'Their answers', details: intakeLines(r.intake) },
      ...tableSections(r.intake),
      ...(r.documents.length ? [{
        title: 'Documents',
        paragraphs: ['They are on the request page, to download one at a time or all in one file while the request is open.'],
        details: documentDetails(r.documents),
      }] : []),
      ...(r.notes ? [{ title: 'Notes from the company', paragraphs: paragraphsOf(r.notes) }] : []),
      { title: 'Why now', bullets: situation.whyNow },
      { title: 'The current 409A', paragraphs: [situation.current] },
      { title: situation.structureTitle, details: situation.structure },
    ],
    signoff: `— ${mailSignature()}`,
    footer: `Sent by ${product} for ${sentence(r.companyName)} You are receiving this because this address is where ${product} sends requests for the ${deskName()}. If it reached you by mistake, delete it without opening the link.`,
  }, subject);
  // No reply-to: a reply quotes this message, link and all, and a reply to the
  // company would hand it the link that moves its own request.
  return { to: r.to, toName: deskName(), subject, text, html };
}

export interface ClosedEmail { companyName: string; to: string; requestedAt: string; how: 'CANCELLED' | 'COMPLETED' }

/** Tells the team a request it was working has closed, so nobody carries on with it. No link and no data. */
export function composeClosedEmail(r: ClosedEmail): Message {
  const when = longDate(r.requestedAt.slice(0, 10));
  const subject = `409A request closed: ${subjectName(r.companyName)}`;
  const product = config().brand.productName;
  // Said without claiming where the 409A came from: the company may have had it done anywhere.
  const what = r.how === 'CANCELLED'
    ? `${r.companyName} cancelled its 409A request of ${when}`
    : `${r.companyName} recorded a 409A and closed its request of ${when}`;
  // To the team inbox, like the notice: no greeting and no reply-to.
  const { html, text } = renderEmail({
    preview: `${what}, so nothing more is needed on it.`,
    heading: r.how === 'CANCELLED' ? 'A 409A request was cancelled' : 'A 409A request was closed',
    intro: [
      r.how === 'CANCELLED' ? `${what}.` : `${what}, before the report was marked delivered on the request page.`,
      'Nothing more is needed on it. Its link now shows the request as closed.',
    ],
    signoff: `— ${mailSignature()}`,
    footer: `You are receiving this because ${product} sent this request to this address for the ${deskName()}. If it reached you by mistake, you can delete it.`,
  }, subject);
  return { to: r.to, toName: deskName(), subject, text, html };
}

/**
 * A change of status the person who asked is emailed about. The team starts a
 * request, delivers the report, puts it back in progress or closes it; someone
 * at the company completes it against a 409A or cancels it.
 */
export type StatusChange =
  | { kind: 'STARTED' }
  | {
    kind: 'DELIVERED'; appraiser: string; reportDate: string;
    /** The fair market value per common share the team gave, in micro-cents, when it gave one. */
    fairMarketValue?: number | null;
    /** Whether the team uploaded the report, so it is on the 409A page rather than only in the team's own email. */
    reportOnPage?: boolean;
  }
  | { kind: 'REOPENED' }
  | { kind: 'CLOSED' }
  | { kind: 'COMPLETED'; by: string; valuationDate: string }
  | { kind: 'CANCELLED'; by: string };

/** Whether the team made a change, rather than someone at the company. */
const byTheTeam = (c: StatusChange): boolean => c.kind !== 'COMPLETED' && c.kind !== 'CANCELLED';

export interface StatusEmail {
  companyName: string;
  /** The requester's own account address, never one typed into the form. */
  to: string;
  toName: string;
  change: StatusChange;
  /** The team's note with the change, or its reason for closing, as it was typed. */
  message: string | null;
  /** The team's inbox. Used only for a change the team made, so a reply about one the company made never goes to the team. */
  replyTo: string | null;
  /**
   * Whether their role records a 409A and asks for one (ADMIN or LEGAL), true when
   * not given. Someone moved to a role that only reads the page is told who can,
   * rather than told to do what their role cannot.
   */
  canRecord?: boolean;
}

/**
 * Tells the person who asked that the status of their request changed. Pure, like
 * the others. It says what the 409A page says and nothing more: no link of the
 * team's, no holder and no document.
 */
export function composeStatusEmail(r: StatusEmail): Message {
  const desk = deskName();
  const product = config().brand.productName;
  const company = subjectName(r.companyName);
  const c = r.change;
  const replyTo = byTheTeam(c) ? r.replyTo : null;
  const valuation = `a 409A valuation of ${sentence(r.companyName)}`;
  const again = 'We will email you again when the report is ready.';
  const canRecord = r.canRecord ?? true;
  const editors = 'anyone who edits the cap table';
  // Where to get a 409A now, as this server offers it: with the service off, a
  // new request is refused, so the way left is the company's own appraiser.
  const ask = deskOn()
    ? (canRecord ? 'If you still need a 409A, ask for a new one on the 409A page.'
      : `If the company still needs a 409A, ${editors} can ask for a new one on the 409A page.`)
    : (canRecord ? 'If you still need a 409A, record one from your own appraiser on the 409A page.'
      : `If the company still needs a 409A, ${editors} can record one from its own appraiser on the 409A page.`);

  let subject: string;
  let heading: string;
  let preview: string;
  let intro: string[];
  let details: { label: string; value: string }[];
  const sections: EmailSection[] = [];
  if (c.kind === 'STARTED') {
    subject = `The ${desk} has started on your 409A for ${company}`;
    heading = `The ${desk} has started on your 409A`;
    preview = `Work has started on your request for ${valuation}`;
    intro = [`The ${desk} has started work on your request for ${valuation}`, `There is nothing you need to do now. ${again}`];
    details = [{ label: 'Status', value: 'In progress' }];
  } else if (c.kind === 'DELIVERED') {
    // The price is the one the team gave, never one only read from the report, which nobody has checked yet.
    const price = c.fairMarketValue ? `${formatPPS(c.fairMarketValue)} per common share` : null;
    subject = `Your 409A report for ${company} is ready`;
    heading = 'Your 409A report is ready';
    preview = `${c.appraiser} valued the common stock${price ? ` at ${price}` : ''} as of ${longDate(c.reportDate)}. ${canRecord ? 'Record the 409A to finish.' : 'Recording the 409A finishes the request.'}`;
    intro = [`The ${desk} has delivered the 409A report for ${sentence(r.companyName)} ${c.reportOnPage
      ? `The report is on the 409A page in ${product}, not attached to this email.`
      : 'The report itself comes from the team, not with this email.'}`];
    details = [
      { label: 'Status', value: 'Report delivered' },
      { label: 'Appraisal firm', value: c.appraiser },
      { label: 'Valuation date', value: longDate(c.reportDate) },
      ...(price ? [{ label: 'Fair market value', value: price }] : []),
    ];
    sections.push({
      title: canRecord ? 'What to do next' : 'What happens next',
      paragraphs: [c.reportOnPage
        ? `${canRecord ? 'Check' : `${capital(editors)} can check`} the values against the report on the 409A page in ${product}, then record the 409A from them. Its price then sets the strike price of new options, and recording it closes this request.`
        : `${canRecord ? 'Record' : `${capital(editors)} can record`} the 409A from the report on the 409A page in ${product}. Its price then sets the strike price of new options, and recording it closes this request.`],
    });
  } else if (c.kind === 'REOPENED') {
    subject = `Your 409A report for ${company} is back in progress`;
    heading = 'Your 409A report is back in progress';
    preview = 'The report delivered earlier was withdrawn, so do not record a 409A from it.';
    intro = [
      `The ${desk} has put your request for a 409A valuation of ${r.companyName} back in progress. The report it delivered earlier is withdrawn, so do not record a 409A from it.`,
      again,
    ];
    details = [{ label: 'Status', value: 'In progress' }];
  } else if (c.kind === 'CLOSED') {
    subject = `The ${desk} closed your 409A request for ${company}`;
    heading = `The ${desk} closed your 409A request`;
    preview = 'It was closed without a report.';
    intro = [`The ${desk} closed your request for ${valuation} No report will come from it.${r.message ? ' The team’s reason is below.' : ''}`, ask];
    details = [{ label: 'Status', value: 'Closed by the team' }];
  } else if (c.kind === 'COMPLETED') {
    subject = `Your 409A request for ${company} is complete`;
    heading = 'Your 409A request is complete';
    preview = `${c.by} recorded the 409A valued as of ${longDate(c.valuationDate)}.`;
    intro = [`${c.by} recorded a 409A valued as of ${longDate(c.valuationDate)}, and that completed your request for ${valuation}`, 'There is nothing more to do on it.'];
    details = [
      { label: 'Status', value: 'Completed' },
      { label: 'Recorded by', value: c.by },
      { label: 'Valuation date', value: longDate(c.valuationDate) },
    ];
  } else {
    subject = `Your 409A request for ${company} was cancelled`;
    heading = 'Your 409A request was cancelled';
    preview = `${c.by} cancelled it.`;
    intro = [`${c.by} cancelled your request for ${valuation}`, ask];
    details = [{ label: 'Status', value: 'Cancelled' }, { label: 'Cancelled by', value: c.by }];
  }
  if (replyTo) intro.push('To reach the team, reply to this email.');
  if (r.message) sections.push({ title: c.kind === 'CLOSED' ? 'Why the team closed it' : 'A note from the team', paragraphs: paragraphsOf(r.message) });

  const { html, text } = renderEmail({
    preview, heading, greeting: `Hi ${r.toName},`, intro, details,
    action: { label: 'Open the 409A page', url: `${config().app.url}/compliance/409a` },
    actionNote: `The 409A page in ${product} shows each step of the request.`,
    sections,
    signoff: `— ${mailSignature()}`,
    footer: `You are receiving this because you asked ${product} for ${valuation}`,
  }, subject);
  return { to: r.to, toName: r.toName, replyTo: replyTo ?? undefined, subject, text, html };
}

// --- Loading -----------------------------------------------------------------

interface RequestRow {
  id: string; company_id: string; status: string; reasons: string | null; provider: string;
  provider_email: string | null; contact_name: string | null; contact_email: string | null;
  target_date: string | null; notes: string | null; requested_by: string; sent_at: string | null;
  valuation_id: string | null; completed_at: string | null; created_at: string; updated_at: string | null;
  answers: string | null; contact_phone: string | null; requested_by_id: string | null;
  desk_token_hash: string | null; desk_token_at: string | null; recap_sent_at: string | null;
  desk_notified_at: string | null; appraiser: string | null; report_date: string | null; closed_at: string | null;
  report_document_id: string | null; report_detected: string | null; report_fmv: number | null; report_method: string | null;
}

interface EventRow { id: string; request_id: string; kind: string; message: string | null; author: string; author_name: string; created_at: string }

const intakeOf = (row: RequestRow): Intake | null => (row.answers ? JSON.parse(row.answers) as Intake : null);

const eventView = (e: EventRow) => ({ id: e.id, kind: e.kind, message: e.message, author: e.author, authorName: e.author_name, createdAt: e.created_at });

/** A document a request hands over, as both pages list it. */
export interface RequestDocument {
  item: DocumentItem; itemLabel: string; id: string; name: string;
  fileName: string | null; mimeType: string | null; sizeBytes: number | null; hasBody: boolean; createdAt: string;
}

interface LinkRow {
  request_id: string; item: DocumentItem; id: string; name: string; file_name: string | null; mime_type: string | null;
  size_bytes: number | null; has_body: boolean; created_at: string;
}

/**
 * The documents each request of a company hands over, by request, in the
 * checklist's order and then by name. The link and the document are matched on
 * the company as well as the id, so a link can only reach the company's own
 * vault. `wholeVault` false lists only what every member may see, for the roles
 * the vault shows no more than that.
 */
async function documentsOf(companyId: string, requestId: string | null, wholeVault = true): Promise<Map<string, RequestDocument[]>> {
  const rows = await all<LinkRow>(
    `SELECT l.request_id, l.item, d.id, d.name, d.file_name, d.mime_type, d.size_bytes, d.created_at,
            (COALESCE(d.body, '') <> '') AS has_body
       FROM valuation_request_documents l JOIN documents d ON d.id = l.document_id AND d.company_id = l.company_id
      WHERE l.company_id = ?${requestId ? ' AND l.request_id = ?' : ''}${wholeVault ? '' : " AND d.visibility = 'ALL'"}`,
    companyId, ...(requestId ? [requestId] : []));
  rows.sort((a, b) => ITEM_ORDER.get(a.item)! - ITEM_ORDER.get(b.item)! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const byRequest = new Map<string, RequestDocument[]>();
  for (const r of rows) {
    byRequest.set(r.request_id, [...(byRequest.get(r.request_id) ?? []), {
      item: r.item, itemLabel: ITEM_LABEL.get(r.item) ?? r.item, id: r.id, name: r.name,
      fileName: r.file_name, mimeType: r.mime_type, sizeBytes: r.size_bytes, hasBody: r.has_body, createdAt: r.created_at,
    }]);
  }
  return byRequest;
}

/**
 * How many documents each request of a company handed over that a reader limited
 * to what the vault shows everyone does not see, by request, so their page can
 * say the list leaves some out rather than pass it off as everything sent. Each
 * document once, even when it answers two items.
 */
async function hiddenDocumentsOf(companyId: string, requestId: string | null, role: string): Promise<Map<string, number>> {
  if (seesWholeVault(role)) return new Map();
  const rows = await all<{ request_id: string; n: number | string }>(
    `SELECT l.request_id, COUNT(DISTINCT d.id) AS n
       FROM valuation_request_documents l JOIN documents d ON d.id = l.document_id AND d.company_id = l.company_id
      WHERE l.company_id = ?${requestId ? ' AND l.request_id = ?' : ''} AND d.visibility <> 'ALL'
      GROUP BY l.request_id`,
    companyId, ...(requestId ? [requestId] : []));
  return new Map(rows.map((r) => [r.request_id, Number(r.n)]));
}

/**
 * The report the team uploaded, as the company's page lists it: shaped like a
 * document the request sent, filed as the report. It also carries where the vault
 * files it and who it is shown to, since someone at the company may have shared
 * it since, and the page decides from that who can open it.
 */
export type UploadedReportDocument = Omit<RequestDocument, 'item' | 'itemLabel'> & {
  item: 'REPORT'; itemLabel: string; category: string; folder: string | null; status: string; visibility: string;
};
/** The report the team uploaded, as the team's page lists it. */
export interface DeskReportDocument { id: string; name: string; fileName: string | null; sizeBytes: number | null; createdAt: string }

/** The report the team gave with a request: the file it uploaded, what was read from it, and the figures it typed. */
export interface UploadedReport<D> {
  document: D | null;
  /** What was read from the file. Shown only beside the file, to whoever may open it. */
  detected: ReportDetection | null;
  /** Micro-cents per common share, as the team gave it when it delivered. */
  fairMarketValue: number | null;
  method: string | null;
}

interface ReportFileRow {
  id: string; name: string; file_name: string | null; mime_type: string | null; size_bytes: number | null;
  category: string; folder: string | null; status: string; visibility: string; has_body: boolean; created_at: string;
}

/**
 * The files the team uploaded, by id, matched on the company as well as the id,
 * so a request can only point a page at its own company's vault.
 */
async function reportFilesOf(companyId: string, ids: (string | null)[]): Promise<Map<string, ReportFileRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await all<ReportFileRow>(
    `SELECT id, name, file_name, mime_type, size_bytes, category, folder, status, visibility, created_at, (COALESCE(body, '') <> '') AS has_body
       FROM documents WHERE company_id = ? AND id IN (${wanted.map(() => '?').join(', ')})`, companyId, ...wanted);
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The report as a page shows it, or null when the team has given none. What was
 * read from the file goes only with the file: once the file has left the vault,
 * or for a reader the vault does not show it to, the readings go too. The team's
 * own figures are what it typed when it delivered, like the firm and the date.
 */
function reportView<D>(row: RequestRow, file: ReportFileRow | undefined, shape: (f: ReportFileRow) => D): UploadedReport<D> | null {
  if (!row.report_document_id && row.report_fmv == null && !row.report_method) return null;
  return {
    document: file ? shape(file) : null,
    detected: file && row.report_detected ? JSON.parse(row.report_detected) as ReportDetection : null,
    fairMarketValue: row.report_fmv == null ? null : Number(row.report_fmv),
    method: row.report_method,
  };
}

/** The report for the company's page, as far as the reader's role sees the vault. */
function companyReport(row: RequestRow, files: Map<string, ReportFileRow>, role: string): UploadedReport<UploadedReportDocument> | null {
  const file = row.report_document_id ? files.get(row.report_document_id) : undefined;
  const shown = file && (seesWholeVault(role) || file.visibility === 'ALL') ? file : undefined;
  return reportView(row, shown, (f) => ({
    item: 'REPORT', itemLabel: 'The 409A report', id: f.id, name: f.name, fileName: f.file_name, mimeType: f.mime_type,
    sizeBytes: f.size_bytes, hasBody: f.has_body, createdAt: f.created_at,
    category: f.category, folder: f.folder, status: f.status, visibility: f.visibility,
  }));
}

/**
 * A request as the company's page reads it. Named field by field, so a column
 * added later is not sent anywhere by accident: the team's token hash never is,
 * and the contact's email and phone go only to the people who make requests.
 */
function present(
  row: RequestRow, events: EventRow[], documents: RequestDocument[], documentsHidden: number, role: string, userId: string | null,
  readers: Set<string>, report: UploadedReport<UploadedReportDocument> | null,
) {
  const editor = isEditor(role);
  const intake = intakeOf(row);
  return {
    id: row.id, status: row.status, provider: row.provider,
    /** Made by the person reading, so the next request can reuse their own contact details and nobody else's. */
    mine: !!userId && row.requested_by_id === userId,
    /**
     * Whether the person who asked is emailed at each step: the emails are on, and
     * their role still reads the 409A page. The page says so only when it is true.
     */
    emailsRequester: config().valuationDesk.statusEmailsPerRequestPerDay > 0 && !!row.requested_by_id && readers.has(row.requested_by_id),
    reasons: row.reasons ? JSON.parse(row.reasons) as string[] : [],
    requestedBy: row.requested_by, createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at,
    answers: intake, answerLines: intake ? intakeLines(intake) : [], tables: intake ? intakeTables(intake) : [],
    documents,
    /** Documents sent that this reader's role does not see, and so are not in the list. */
    documentsHidden,
    notes: row.notes,
    contactName: row.contact_name,
    contactEmail: editor ? row.contact_email : null,
    contactPhone: editor ? row.contact_phone : null,
    recapSentAt: row.recap_sent_at, deskNotifiedAt: row.desk_notified_at,
    appraiser: row.appraiser, reportDate: row.report_date,
    /** The report the team uploaded, what was read from it, and the figures the team gave with it. */
    report,
    valuationId: row.valuation_id, completedAt: row.completed_at,
    // Requests made before the intake questions went to a firm the company named.
    targetDate: row.target_date, sentAt: row.sent_at,
    events: events.map(eventView),
  };
}

/** The request, if and only if it is this company's. update() matches on the id alone. */
async function ownRequest(ctx: Ctx): Promise<RequestRow> {
  const row = await one<RequestRow>('SELECT * FROM valuation_requests WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!row) throw notFound('That 409A request does not exist.');
  return row;
}

/** The members whose role reads a company's 409A page, and so are emailed about a request they made. */
async function readersOf(companyId: string): Promise<Set<string>> {
  const rows = await all<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE company_id = ? AND role IN (${FULL_VIEW_ROLES.map(() => '?').join(', ')})`, companyId, ...FULL_VIEW_ROLES);
  return new Set(rows.map((r) => r.user_id));
}

async function eventsOf(companyId: string, requestId: string): Promise<EventRow[]> {
  return all<EventRow>('SELECT * FROM valuation_request_events WHERE request_id = ? AND company_id = ? ORDER BY created_at, id', requestId, companyId);
}

async function presentById(ctx: Ctx, id: string) {
  const row = (await one<RequestRow>('SELECT * FROM valuation_requests WHERE id = ? AND company_id = ?', id, ctx.companyId))!;
  const role = ctx.membership?.role ?? '';
  const documents = (await documentsOf(ctx.companyId!, id, seesWholeVault(role))).get(id) ?? [];
  const hidden = (await hiddenDocumentsOf(ctx.companyId!, id, role)).get(id) ?? 0;
  const files = await reportFilesOf(ctx.companyId!, [row.report_document_id]);
  return present(row, await eventsOf(ctx.companyId!, id), documents, hidden, role, ctx.user?.id ?? null, await readersOf(ctx.companyId!),
    companyReport(row, files, role));
}

async function addEvent(row: { id: string; company_id: string }, kind: string, message: string | null, author: 'company' | 'desk', authorName: string): Promise<void> {
  await insert('valuation_request_events', {
    id: newId('vre'), requestId: row.id, companyId: row.company_id, kind, message, author, authorName, createdAt: nowISO(),
  });
}

async function companyName(companyId: string): Promise<string> {
  const c = await one<{ name: string; legal_name: string | null }>('SELECT name, legal_name FROM companies WHERE id = ?', companyId);
  return (c?.legal_name || c?.name || 'The company').replace(/\s+/g, ' ');
}

const since = (ms: number): string => new Date(Date.now() - ms).toISOString();
const isProduction = (): boolean => process.env.NODE_ENV === 'production';
const DAY = 86_400_000;

// --- The team's link -----------------------------------------------------------

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** 32 random bytes in base64url: always 43 characters, so anything else is not a token. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The page the team works from. The token rides after the #, which a browser
 * never sends to a server, so it stays out of request logs and referrers.
 * It is built from app.url only, since an address taken from the request could
 * point the link, token and all, at a site the requester chose.
 */
const deskLink = (token: string): string => `${config().app.url}/409a-desk#${token}`;

// --- Sending -------------------------------------------------------------------

/** The kinds of message a request sends, for the audit log and the limits read from it. */
const SEND_ACTIONS = ['SEND_RECAP', 'SEND_RECAP_FAILED', 'NOTIFY_DESK', 'NOTIFY_DESK_FAILED', 'NOTIFY_DESK_SKIPPED'];

interface Outcome { delivered: boolean; error: string | null }

/** Sends one message and says plainly what happened. The transport's own error is for the server log only. */
async function deliver(message: Message, requestId: string, what: string): Promise<Outcome> {
  try {
    const delivered = (await sendMail(message)).delivered;
    // With no mail transport the app logs the message instead, and saying it was sent would be untrue.
    return delivered ? { delivered, error: null } : { delivered, error: 'Mail is not set up on this server, so it was not emailed.' };
  } catch (err) {
    console.error(`[mail] 409A request ${requestId}: the ${what} failed:`, (err as Error).message);
    return { delivered: false, error: 'The email could not be sent. Try again later.' };
  }
}

/** What a send did with each message: sent it, tried and failed, or had nothing to send. */
export interface SendOutcome {
  recap: 'sent' | 'failed' | 'not needed';
  /** Whose account the recap went to, named so the person pressing the button is not told it went to them. */
  recapTo: string | null;
  recapError: string | null;
  desk: 'sent' | 'failed' | 'not needed';
  deskError: string | null;
}

const countSince = async (where: string, ms: number, ...params: unknown[]): Promise<number> => {
  const r = await one<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'valuation_requests' AND ${where} AND created_at > ?`, ...params, since(ms));
  return Number(r?.n ?? 0);
};

/**
 * Why the team cannot be sent a notice right now, or null when it can. The
 * limits (valuationDesk.noticesPer…) run from the narrowest to the widest, so one
 * company resending cannot use up the hour's allowance and keep every other
 * company's notice waiting.
 */
async function deskHold(ctx: Ctx, row: RequestRow): Promise<string | null> {
  if (!deskOn()) return '409A requests are turned off on this server, so the team was not notified.';
  if (!deskAddress()) return 'No valuation team address is set on this server, so the team was not notified.';
  // In production an unsent notice would be printed to the log, link and all.
  if (isProduction() && !mailConfigured()) return 'Mail is not set up on this server, so the team was not notified.';
  const limits = config().valuationDesk;
  if (await countSince(`entity_id = ? AND action IN ('NOTIFY_DESK', 'NOTIFY_DESK_FAILED')`, DAY, row.id) >= limits.noticesPerRequestPerDay) {
    return `This request has been sent to the team ${times(limits.noticesPerRequestPerDay)} today. Try again tomorrow.`;
  }
  if (await countSince(`company_id = ? AND action = 'NOTIFY_DESK'`, DAY, row.company_id) >= limits.noticesPerCompanyPerDay) {
    return `The team has had ${count(limits.noticesPerCompanyPerDay, 'notice')} from this company today. Try again tomorrow.`;
  }
  if (ctx.user && await countSince(`user_id = ? AND action IN ('NOTIFY_DESK', 'NOTIFY_DESK_FAILED')`, DAY, ctx.user.id) >= limits.noticesPerPersonPerDay) {
    return `You have sent the team ${count(limits.noticesPerPersonPerDay, 'notice')} today. Try again tomorrow.`;
  }
  if (await countSince(`action = 'NOTIFY_DESK'`, 3_600_000) >= limits.noticesPerHour) {
    return 'The valuation team is receiving a lot of requests right now. Try again in an hour.';
  }
  return null;
}

/**
 * Sends whatever has not gone yet: the recap to the person who asked, and the
 * notice to the team. `again` sends the team a fresh notice, with a new link,
 * even if one arrived before.
 *
 * Failures are reported, not thrown. The request is already saved by the time
 * this runs, and an error here would show a failure for something half done.
 */
async function sendPending(ctx: Ctx, row: RequestRow, again: boolean): Promise<SendOutcome> {
  const intake = intakeOf(row)!;
  const wantRecap = !row.recap_sent_at;
  const wantDesk = !row.desk_notified_at || again;
  const outcome: SendOutcome = { recap: 'not needed', recapTo: null, recapError: null, desk: 'not needed', deskError: null };
  if (!wantRecap && !wantDesk) return outcome;

  const company = await companyName(row.company_id);
  const contact: Contact = { name: row.contact_name, email: row.contact_email!, phone: row.contact_phone! };
  const desk = deskAddress();
  const documents = ((await documentsOf(row.company_id, row.id)).get(row.id) ?? []).map((d) => ({ itemLabel: d.itemLabel, name: d.name }));

  // The recap goes to the account of whoever asked, never to an address typed into
  // the form, so a request cannot be used to mail a stranger.
  let recap: Message | null = null;
  if (wantRecap) {
    const requester = row.requested_by_id
      ? await one<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', row.requested_by_id) : undefined;
    if (!requester) {
      outcome.recap = 'failed';
      outcome.recapError = 'The person who asked no longer has an account, so there is nobody to send the recap to.';
    } else {
      outcome.recapTo = requester.name;
      recap = composeRecapEmail({
        companyName: company, to: requester.email, toName: requester.name, contact, intake, documents, notes: row.notes,
        statusUrl: `${config().app.url}/compliance/409a`, replyTo: desk,
      });
    }
  }

  let notice: Message | null = null;
  let token: string | null = null;
  if (wantDesk) {
    const hold = await deskHold(ctx, row);
    if (hold) {
      outcome.desk = 'failed';
      outcome.deskError = hold;
    } else {
      token = randomBytes(32).toString('base64url');
      notice = composeDeskEmail({
        companyName: company, to: desk!, requestedAt: row.created_at, requestedBy: row.requested_by,
        contact, intake, documents, notes: row.notes, situation: await situationOf(row.company_id), link: deskLink(token),
      });
    }
  }

  // Both at once, so a slow mail server holds the company's records for one wait, not two.
  const [recapOutcome, deskOutcome] = await Promise.all([
    recap ? deliver(recap, row.id, 'recap') : Promise.resolve(null),
    notice ? deliver(notice, row.id, 'notice to the valuation team') : Promise.resolve(null),
  ]);

  const now = nowISO();
  const values: Record<string, unknown> = {};
  if (recapOutcome) {
    outcome.recap = recapOutcome.delivered ? 'sent' : 'failed';
    outcome.recapError = recapOutcome.error;
    if (recapOutcome.delivered) values.recapSentAt = now;
    await audit(ctx, recapOutcome.delivered ? 'SEND_RECAP' : 'SEND_RECAP_FAILED', 'valuation_requests', row.id,
      recapOutcome.delivered ? '409A request recap emailed to the person who asked' : '409A request recap was not emailed');
  }
  if (deskOutcome && token) {
    outcome.desk = deskOutcome.delivered ? 'sent' : 'failed';
    outcome.deskError = deskOutcome.error;
    if (deskOutcome.delivered) values.deskNotifiedAt = now;
    // A new link replaces the last one only once it has reached the team, so a
    // failed resend never strands a link that works. With no mail transport at
    // all the notice is printed to the console instead, link included, and the
    // link is kept so the page can be tried on a laptop.
    if (deskOutcome.delivered || !mailConfigured()) {
      values.deskTokenHash = hashToken(token);
      values.deskTokenAt = now;
    }
    await audit(ctx, deskOutcome.delivered ? 'NOTIFY_DESK' : 'NOTIFY_DESK_FAILED', 'valuation_requests', row.id,
      deskOutcome.delivered ? `409A request sent to the ${deskName()}` : `409A request was not sent to the ${deskName()}`);
  } else if (wantDesk && outcome.deskError) {
    // Held back before anything was sent. Recorded, but not counted as an attempt.
    await audit(ctx, 'NOTIFY_DESK_SKIPPED', 'valuation_requests', row.id, `409A request was not sent to the ${deskName()}`);
  }
  if (Object.keys(values).length) await update('valuation_requests', row.id, { ...values, updatedAt: now });
  return outcome;
}

/**
 * One line to the team when a request it was told about closes before the
 * report, so nobody works a dead one. Not while the service is turned off: then
 * the team is sent nothing at all.
 */
async function tellDeskClosed(ctx: Ctx, row: RequestRow, how: 'CANCELLED' | 'COMPLETED'): Promise<void> {
  const desk = deskAddress();
  if (!row.desk_notified_at || !desk || !deskOn()) return;
  const outcome = await deliver(composeClosedEmail({ companyName: await companyName(row.company_id), to: desk, requestedAt: row.created_at, how }),
    row.id, 'closing notice to the valuation team');
  await audit(ctx, outcome.delivered ? 'NOTIFY_DESK_CLOSED' : 'NOTIFY_DESK_CLOSED_FAILED', 'valuation_requests', row.id,
    outcome.delivered ? `The ${deskName()} was told the request closed` : `The ${deskName()} could not be told the request closed`);
}

/** What became of the email to the person who asked, so the team's page can say whether the company was told. */
export type Emailed = 'sent' | 'failed' | 'not sent';

/** Each change as the audit log says it. */
const CHANGE_WORDS: Record<StatusChange['kind'], string> = {
  STARTED: 'in progress', DELIVERED: 'delivered', REOPENED: 'back in progress', CLOSED: 'closed by the team',
  COMPLETED: 'completed', CANCELLED: 'cancelled',
};

/**
 * Emails the person who asked that their request's status changed. It goes to
 * their account address, never one typed into the form, like the recap, so a
 * request cannot be used to mail a stranger.
 *
 * Nobody is emailed about a change they made themselves. Nor is anyone who has
 * left the company, or whose role no longer reads its 409A page, since the email
 * says what that page says. valuationDesk.statusEmailsPerRequestPerDay caps how
 * many one request sends, so whoever holds a leaked team link cannot press its
 * buttons to flood the inbox, and 0 turns them off. Turning the service off does
 * not: whoever has a request in flight still hears what becomes of it.
 *
 * It comes in two halves. This one runs inside the change's transaction, under
 * the company's lock: it finds the person, checks the limit and writes the
 * attempt to the audit log, so changes that arrive together cannot all pass the
 * limit before any of them is counted. The half it returns sends the email, and
 * runs once the change has committed, so a slow mail server never holds the
 * company's lock and nobody is told of a change that was rolled back. Neither
 * half throws, so nothing that goes wrong here fails the change, and a savepoint
 * keeps a statement that fails here from taking the change with it.
 */
async function tellRequester(ctx: Ctx, row: RequestRow, change: StatusChange, message: string | null): Promise<() => Promise<Emailed>> {
  const notSent = async (): Promise<Emailed> => 'not sent';
  const team = byTheTeam(change);
  if (!team && ctx.user?.id === row.requested_by_id) return notSent;
  const limit = config().valuationDesk.statusEmailsPerRequestPerDay;
  if (limit === 0) return notSent;
  // The team's changes are logged under the team's name, as its own steps are.
  const actor = team ? DESK_ACTOR(row) : undefined;
  const word = CHANGE_WORDS[change.kind];
  const failed = (err: unknown): Emailed => {
    console.error(`[mail] 409A request ${row.id}: the status email to the person who asked failed:`, (err as Error).message);
    return 'failed';
  };

  const claim = async (): Promise<() => Promise<Emailed>> => {
    const skip = async (why: string) => {
      await audit(ctx, 'NOTIFY_REQUESTER_SKIPPED', 'valuation_requests', row.id, `409A request ${word}: the person who asked was not emailed, ${why}`, actor);
      return notSent;
    };
    // Requests made before the intake questions did not record who asked.
    if (!row.requested_by_id) return skip('since the request does not record who asked');
    const requester = await one<{ email: string; name: string; role: string }>(
      `SELECT u.email, u.name, m.role FROM users u JOIN memberships m ON m.user_id = u.id AND m.company_id = ?
        WHERE u.id = ? AND m.role IN (${FULL_VIEW_ROLES.map(() => '?').join(', ')})`, row.company_id, row.requested_by_id, ...FULL_VIEW_ROLES);
    if (!requester) return skip('since they no longer have access to the company’s 409A page');
    // An attempt still being sent counts as much as one that went or failed.
    if (await countSince(`entity_id = ? AND action IN ('NOTIFY_REQUESTER', 'NOTIFY_REQUESTER_FAILED', 'NOTIFY_REQUESTER_PENDING')`, DAY, row.id) >= limit) {
      return skip(`since this request has already tried to email them ${times(limit)} today`);
    }
    const email = composeStatusEmail({
      companyName: await companyName(row.company_id), to: requester.email, toName: requester.name, change, message, replyTo: deskAddress(),
      canRecord: isEditor(requester.role),
    });
    const attempt = await audit(ctx, 'NOTIFY_REQUESTER_PENDING', 'valuation_requests', row.id, `409A request ${word}: emailing the person who asked`, actor);
    return async () => {
      try {
        const outcome = await deliver(email, row.id, 'status email to the person who asked');
        // The attempt's own row says how it went, so each attempt stays one entry in the log.
        await update('audit_log', attempt, outcome.delivered
          ? { action: 'NOTIFY_REQUESTER', detail: `409A request ${word}: the person who asked was emailed` }
          : { action: 'NOTIFY_REQUESTER_FAILED', detail: `409A request ${word}: the email to the person who asked did not go out` });
        return outcome.delivered ? 'sent' : 'failed';
      } catch (err) {
        return failed(err);
      }
    };
  };

  try {
    return await transaction(claim);
  } catch (err) {
    const outcome = failed(err);
    return async () => outcome;
  }
}

// --- The company's routes --------------------------------------------------------

route.get('/api/c/:cid/valuation-refresh', 'read', async (ctx) => {
  assertFullView(ctx, REQUEST_NEEDS_FULL_VIEW);
  const asOf = ctx.query.get('asOf') ? isoDate(ctx.query.get('asOf'), 'As-of date') : today();
  return refreshWithText(await getCompanyData(ctx.companyId!), asOf);
});

route.get('/api/c/:cid/valuation-requests', 'read', async (ctx) => {
  assertFullView(ctx, REQUEST_NEEDS_FULL_VIEW);
  const rows = await all<RequestRow>('SELECT * FROM valuation_requests WHERE company_id = ? ORDER BY created_at DESC', ctx.companyId);
  const events = await all<EventRow>('SELECT * FROM valuation_request_events WHERE company_id = ? ORDER BY created_at, id', ctx.companyId);
  const byRequest = new Map<string, EventRow[]>();
  for (const e of events) byRequest.set(e.request_id, [...(byRequest.get(e.request_id) ?? []), e]);
  const role = ctx.membership!.role;
  const documents = await documentsOf(ctx.companyId!, null, seesWholeVault(role));
  const hidden = await hiddenDocumentsOf(ctx.companyId!, null, role);
  const readers = await readersOf(ctx.companyId!);
  const files = await reportFilesOf(ctx.companyId!, rows.map((r) => r.report_document_id));
  return rows.map((r) => present(r, byRequest.get(r.id) ?? [], documents.get(r.id) ?? [], hidden.get(r.id) ?? 0, role, ctx.user!.id, readers,
    companyReport(r, files, role)));
});

/**
 * Makes the request. Nothing is emailed here: the page sends it straight after
 * with POST /send, which then works on a saved request and is the same call that
 * retries a message that did not go.
 */
route.post('/api/c/:cid/valuation-requests', 'write', async (ctx) => {
  if (!deskOn()) throw forbidden('New 409A requests are turned off on this server. Requests made earlier can still be followed and closed.');
  // One open request at a time, checked first so a second attempt says so.
  const open = await one<{ id: string }>(
    `SELECT id FROM valuation_requests WHERE company_id = ? AND status IN (${OPEN_SQL}) LIMIT 1`, ctx.companyId);
  if (open) throw badRequest('A 409A request is already open. Complete or cancel it before asking for another.');

  // Anyone can sign up and create a company, and each request emails two people,
  // so how many can be made is limited per company and per person
  // (valuationDesk.requestsPerCompanyPerDay and requestsPerPersonPerDay).
  const { requestsPerCompanyPerDay: perCompany, requestsPerPersonPerDay: perPerson } = config().valuationDesk;
  const byCompany = await one<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE company_id = ? AND entity_type = 'valuation_requests' AND action = 'CREATE' AND created_at > ?`,
    ctx.companyId, since(DAY));
  if (Number(byCompany?.n ?? 0) >= perCompany) {
    throw badRequest(`${capital(count(perCompany, '409A request'))} ${perCompany === 1 ? 'has' : 'have'} been made for this company today. Try again tomorrow.`);
  }
  const byPerson = await one<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND entity_type = 'valuation_requests' AND action = 'CREATE' AND created_at > ?`,
    ctx.user!.id, since(DAY));
  if (Number(byPerson?.n ?? 0) >= perPerson) throw badRequest(`You have made ${count(perPerson, '409A request')} today. Try again tomorrow.`);

  const b = ctx.body;
  const answers = readIntake(b);
  const contactName = name(b.contactName, 'Your name', true);
  const contactEmail = email(b.contactEmail, 'Your email', false)!;
  const contactPhone = phone(b.contactPhone, 'Your phone number');
  const notes = str(b.notes, 'Notes', { max: 2000, optional: true }) || null;

  const asOf = today();
  const data = await getCompanyData(ctx.companyId!);
  const record = await companyRecord(ctx.companyId!);
  checkAgainstRecords(answers, structureOf(data, asOf), record, asOf);
  const intake: Intake = { ...answers, incorporationDate: record.incorporationDate, fiscalYearEnd: record.fiscalYearEnd };
  const documents = await readDocuments(b.documents, ctx.companyId!, intake);

  const reasons = valuationRefresh(data, asOf, config().compliance.valuationExpiryWarningDays).triggers.map((t) => t.reason);
  const id = newId('vrq');
  const now = nowISO();
  // The request, its answers and the documents that go with it are written
  // together or not at all, so the team is never sent a request missing a part.
  await transaction(async () => {
    await insert('valuation_requests', {
      id, companyId: ctx.companyId, status: 'REQUESTED', reasons: JSON.stringify(reasons),
      provider: deskName(), answers: JSON.stringify(intake), contactName, contactEmail, contactPhone, notes,
      requestedBy: ctx.user!.name, requestedById: ctx.user!.id, createdAt: now, updatedAt: now,
    });
    for (const d of documents) {
      await insert('valuation_request_documents', { requestId: id, companyId: ctx.companyId, documentId: d.documentId, item: d.item, createdAt: now });
    }
    await audit(ctx, 'CREATE', 'valuation_requests', id, `New 409A requested from the ${deskName()}`);
  });
  return presentById(ctx, id);
});

/** A document the form can offer for an item, and why it is offered. */
interface ChecklistDocument {
  id: string; name: string; category: string; folder: string | null; fileName: string | null;
  mimeType: string | null; sizeBytes: number | null; createdAt: string;
  /**
   * CHARTER: filed as a charter. REPORT: the report of a 409A on file.
   * INSTRUMENT: filed against an outstanding SAFE or note. LAST_REQUEST: sent with the last request.
   */
  source: 'CHARTER' | 'REPORT' | 'INSTRUMENT' | 'LAST_REQUEST';
}

interface VaultRow {
  id: string; name: string; category: string; folder: string | null; file_name: string | null;
  mime_type: string | null; size_bytes: number | null; created_at: string;
}

/**
 * What the form needs to ask the information request well: how many SAFEs and
 * notes the cap table has outstanding, so the question starts from the real
 * answer, and how many shares, since a request needs some; the company's year
 * end and incorporation date, and whether a full fiscal year lies between them
 * and today; and the documents in the vault that already answer an item. The
 * counts and the year are the ones the request is checked against when it is
 * made. Only documents with something to open are offered, newest first.
 */
route.get('/api/c/:cid/valuation-requests/checklist', 'read', async (ctx) => {
  assertFullView(ctx, REQUEST_NEEDS_FULL_VIEW);
  const companyId = ctx.companyId!;
  const asOf = today();
  const data = await getCompanyData(companyId);
  const structure = structureOf(data, asOf);
  const live = data.convertibles.filter((c) => c.status === 'OUTSTANDING' && c.issueDate <= asOf);
  const record = await companyRecord(companyId);

  // The vault as this reader sees it, so nothing is named here that the vault would not show them.
  const shown = seesWholeVault(ctx.membership!.role) ? '' : " AND d.visibility = 'ALL'";
  const COLUMNS = 'd.id, d.name, d.category, d.folder, d.file_name, d.mime_type, d.size_bytes, d.created_at';
  const vault = (where: string, ...params: unknown[]) => all<VaultRow>(
    `SELECT ${COLUMNS} FROM documents d LEFT JOIN file_blobs b ON b.document_id = d.id
      WHERE d.company_id = ? AND ${OPENABLE}${shown} AND ${where}`, companyId, ...params);
  const charters = await vault(`d.category = 'CHARTER'`);
  const reports = await vault(`d.id IN (SELECT report_document_id FROM valuations WHERE company_id = ? AND type = '409A' AND report_document_id IS NOT NULL)`, companyId);
  const instruments = live.length ? await vault(`d.security_id IN (${live.map(() => '?').join(', ')})`, ...live.map((c) => c.id)) : [];
  const last = await one<{ id: string }>('SELECT id FROM valuation_requests WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', companyId);
  const sentLast = last ? await all<VaultRow & { item: string }>(
    `SELECT l.item, ${COLUMNS} FROM valuation_request_documents l
       JOIN documents d ON d.id = l.document_id AND d.company_id = l.company_id
       LEFT JOIN file_blobs b ON b.document_id = d.id
      WHERE l.company_id = ? AND l.request_id = ? AND ${OPENABLE}${shown}`, companyId, last.id) : [];

  // The specific reasons go first, so a charter also sent last time is offered as the charter.
  const suggestions: Partial<Record<DocumentItem, ChecklistDocument[]>> = {};
  const offer = (item: DocumentItem, rows: VaultRow[], source: ChecklistDocument['source']) => {
    const list = suggestions[item] ?? [];
    for (const r of rows) {
      if (list.some((d) => d.id === r.id)) continue;
      list.push({
        id: r.id, name: r.name, category: r.category, folder: r.folder, fileName: r.file_name,
        mimeType: r.mime_type, sizeBytes: r.size_bytes, createdAt: r.created_at, source,
      });
    }
    if (list.length) suggestions[item] = list;
  };
  offer('CHARTER', charters, 'CHARTER');
  offer('PRIOR_VALUATIONS', reports, 'REPORT');
  offer('CONVERTIBLE_AGREEMENTS', instruments, 'INSTRUMENT');
  for (const d of DOCUMENT_ITEMS) offer(d.item, sentLast.filter((r) => r.item === d.item), 'LAST_REQUEST');
  for (const list of Object.values(suggestions)) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

  return {
    convertiblesOutstanding: structure.convertibles.count,
    sharesOutstanding: sharesOutstanding(structure),
    fiscalYearEnd: record.fiscalYearEnd,
    incorporationDate: record.incorporationDate,
    finishedFullYear: finishedFullYear(record, asOf),
    suggestions,
  };
});

route.post('/api/c/:cid/valuation-requests/:id/send', 'write', async (ctx) => {
  const row = await ownRequest(ctx);
  // Turned off, the team is sent nothing, and a recap saying it will be in touch would be untrue.
  if (!deskOn()) throw forbidden('409A requests are turned off on this server, so nothing was sent.');
  if (!isOpen(row.status)) throw badRequest('Only an open request can be sent.');
  if (!row.answers) throw badRequest('This request was made before the intake questions, so it cannot go to the valuation team. Cancel it and make a new one.');

  const { sendCooldownSeconds, resendCooldownMinutes } = config().valuationDesk;
  if (sendCooldownSeconds > 0) {
    const recent = await one<{ id: string }>(
      `SELECT id FROM audit_log WHERE company_id = ? AND entity_type = 'valuation_requests' AND entity_id = ?
         AND action IN (${SEND_ACTIONS.map((a) => `'${a}'`).join(', ')}) AND created_at > ? LIMIT 1`,
      ctx.companyId, row.id, since(sendCooldownSeconds * 1000));
    const wait = span(sendCooldownSeconds);
    if (recent) throw badRequest(`This request was sent, or tried, less than ${wait} ago. Wait ${wait} before trying again.`);
  }
  const again = ctx.body.again === true;
  if (again && resendCooldownMinutes > 0 && row.desk_notified_at && row.desk_notified_at > since(resendCooldownMinutes * 60_000)) {
    throw badRequest(`The valuation team was sent this request a few minutes ago. Wait ${span(resendCooldownMinutes * 60)} before sending it again.`);
  }

  const outcome = await sendPending(ctx, row, again);
  return { request: await presentById(ctx, row.id), ...outcome };
});

/** Why a request is not completed from a page that read it before its last change, as it stands now. */
const changedSince = (row: RequestRow): string => (row.status === 'DELIVERED'
  ? 'The valuation team delivered the report after you opened this request. Check the 409A against the report as it is now, then complete the request.'
  : 'This request changed after you opened it, and its report is not marked delivered now. Look at the request again before completing it.');

route.patch('/api/c/:cid/valuation-requests/:id', 'write', async (ctx) => {
  const row = await ownRequest(ctx);
  if (!isOpen(row.status)) {
    throw badRequest(`This request is ${row.status === 'COMPLETED' ? 'completed' : 'cancelled'} and can no longer be changed.`);
  }
  const b = ctx.body;

  if (b.status !== undefined && b.status !== row.status) {
    const next = String(b.status);
    const values: Record<string, unknown> = {};
    let change: StatusChange = { kind: 'CANCELLED', by: ctx.user!.name };
    /** Whether the 409A now carries the report the team uploaded, said beside the request so the page tells what was done. */
    let reportAttached = false;
    if (next === 'COMPLETED') {
      // The page completing a request filled its form in from the request as it
      // read it, and sends that reading's updatedAt. If the team has changed the
      // request since, putting the report back in progress, delivering it or
      // replacing its upload, the company would be completing from a report that
      // is no longer the one it checked, so it is asked to look again. A caller
      // that sends no updatedAt completes as before.
      if (b.updatedAt !== undefined) {
        if (b.updatedAt !== null && typeof b.updatedAt !== 'string') throw badRequest('Send the request’s updatedAt as the page read it.');
        if (b.updatedAt !== row.updated_at) throw new HttpError(409, changedSince(row));
      }
      // Completed means a valuation came back, so it has to name one: a 409A,
      // and this company's, not merely an id that exists.
      const valuationId = b.valuationId ? String(b.valuationId) : '';
      const v = valuationId
        ? await one<{ id: string; type: string; status: string; created_at: string; effective_date: string; report_document_id: string | null; report_url: string | null }>(
          'SELECT id, type, status, created_at, effective_date, report_document_id, report_url FROM valuations WHERE id = ? AND company_id = ?',
          valuationId, ctx.companyId)
        : null;
      if (!v) throw badRequest('Record the valuation that came back, then complete the request against it.');
      if (v.type !== '409A') throw badRequest('A 409A request is completed by a 409A valuation.');
      if (v.status !== 'ACTIVE') throw badRequest('Complete the request with the valuation the company now relies on, marked active.');
      // The answer to a request cannot predate it: that would be the old valuation
      // the request was made to replace.
      if (v.created_at < row.created_at) throw badRequest('That valuation was recorded before this request was made.');
      const taken = await one<{ id: string }>(
        'SELECT id FROM valuation_requests WHERE company_id = ? AND valuation_id = ? AND id <> ? LIMIT 1', ctx.companyId, v.id, row.id);
      if (taken) throw badRequest('That valuation already completed another request.');
      values.valuationId = v.id;
      values.completedAt = nowISO();
      change = { kind: 'COMPLETED', by: ctx.user!.name, valuationDate: v.effective_date };
      // The report the team delivered becomes the report of the 409A recorded from it,
      // so nobody has to attach it a second time. Only once the team has marked it
      // delivered: before that the upload is a draft the team may still replace, and
      // a request completed meanwhile was answered by some other 409A. Only a
      // document still in this company's vault, and only onto a valuation with no
      // report of its own: the valuation was found by this company's id above,
      // since update() matches on the id alone.
      reportAttached = !!row.report_document_id && v.report_document_id === row.report_document_id;
      if (row.status === 'DELIVERED' && row.report_document_id && !v.report_document_id && !v.report_url) {
        const doc = await one<{ id: string; name: string }>('SELECT id, name FROM documents WHERE id = ? AND company_id = ?', row.report_document_id, ctx.companyId);
        if (doc) {
          await update('valuations', v.id, { reportDocumentId: doc.id });
          await audit(ctx, 'UPDATE', 'valuations', v.id, `Report set to the document "${doc.name}", uploaded with the 409A request`);
          reportAttached = true;
        }
      }
    } else if (next !== 'CANCELLED') {
      // Started and delivered are the valuation team's to say, from its own page.
      throw badRequest('The valuation team moves a request along. From here it can be completed with the valuation it produced, or cancelled.');
    }
    const now = nowISO();
    await update('valuation_requests', row.id, { ...values, status: next, closedAt: now, updatedAt: now });
    await addEvent(row, next, null, 'company', ctx.user!.name);
    await audit(ctx, 'UPDATE', 'valuation_requests', row.id, `409A request ${next === 'COMPLETED' ? 'completed' : 'cancelled'}`);
    // The emails go once the change has committed, so a slow mail server never
    // holds the company's lock, and nobody hears of a close that was rolled back.
    // A request the team delivered is finished from its side; one closed before that is news to it.
    if (next === 'CANCELLED' || row.status !== 'DELIVERED') afterCommit(() => tellDeskClosed(ctx, row, next as 'CANCELLED' | 'COMPLETED'));
    // And the person who asked is told who closed it, unless they are the one who did.
    // The attempt is counted against the limit now, under the lock.
    afterCommit(await tellRequester(ctx, row, change, null));
    const request = await presentById(ctx, row.id);
    return next === 'COMPLETED' ? { ...request, reportAttached } : request;
  }
  if (b.valuationId !== undefined) throw badRequest('A valuation is linked by completing the request.');

  // Once it has gone, the answers stand as they were sent. The way to reach the
  // person asking can still be put right, since the team relies on it.
  const EDITABLE = ['contactName', 'contactEmail', 'contactPhone', 'notes'];
  const unknown = Object.keys(b).filter((k) => !EDITABLE.includes(k) && k !== 'status');
  if (unknown.length) throw badRequest('Only the contact details and notes of a request can be changed once it is made.');
  if (row.status === 'DELIVERED') throw badRequest('The report has been delivered, so the request can no longer be changed.');

  const values: Record<string, unknown> = {};
  if (b.contactName !== undefined) values.contactName = name(b.contactName, 'Your name', true);
  if (b.contactEmail !== undefined) values.contactEmail = email(b.contactEmail, 'Your email', false);
  if (b.contactPhone !== undefined) values.contactPhone = phone(b.contactPhone, 'Your phone number');
  if (b.notes !== undefined) values.notes = str(b.notes, 'Notes', { max: 2000, optional: true }) || null;
  const current: Record<string, unknown> = { contactName: row.contact_name, contactEmail: row.contact_email, contactPhone: row.contact_phone, notes: row.notes };
  for (const k of Object.keys(values)) if (values[k] === current[k]) delete values[k];
  if (Object.keys(values).length === 0) return presentById(ctx, row.id);

  await update('valuation_requests', row.id, { ...values, updatedAt: nowISO() });
  await addEvent(row, 'CONTACT_CHANGED', null, 'company', ctx.user!.name);
  await audit(ctx, 'UPDATE', 'valuation_requests', row.id, '409A request contact details changed');
  return presentById(ctx, row.id);
});

// --- The data workbook ---------------------------------------------------------

const dollars = (cents: number): number => Math.round(cents) / 100;
const price = (micro: number): number => Math.round(micro) / 1e6;

/** The workbook an appraiser calculates from, for one company, naming nobody. */
async function dataWorkbook(companyId: string): Promise<{ workbook: Buffer; asOf: string }> {
  const asOf = today();
  const raw = await getCompanyData(companyId);
  const refresh = refreshWithText(raw, asOf, 'appraiser');
  const structure = structureOf(raw, asOf);
  // Every count and price below on the same split-adjusted basis as the cap table.
  const data = normalizeSplits(raw, asOf);
  const classOf = new Map(data.shareClasses.map((c) => [c.id, c]));
  const leftOn = new Map(data.stakeholders.map((h) => [h.id, h.terminationDate]));
  const scheduleById = new Map(data.vestingSchedules.map((v) => [v.id, v]));
  // Grant labels, schedule names and plan names are free text, and some companies
  // write a holder into them. Any that carries a holder's name or email is
  // replaced by a plain number.
  const people = data.stakeholders.flatMap((h) => [h.name, h.email ?? ''])
    .map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 3);
  const named = (text: string | null): boolean => !!text && people.some((who) => text.toLowerCase().includes(who));
  const labelOf = (label: string | null, n: number): string => (label && !named(label) ? label : `Grant ${n}`);
  const scheduleOf = new Map(data.vestingSchedules.map((v, i) => [v.id, named(v.name) ? `Schedule ${i + 1}` : v.name]));
  const valuations = await all<{ type: string; effective_date: string; expiration_date: string | null; fair_market_value: number; provider: string | null; method: string | null; status: string }>(
    'SELECT type, effective_date, expiration_date, fair_market_value, provider, method, status FROM valuations WHERE company_id = ? ORDER BY effective_date DESC', companyId);
  const current = refresh.current
    ? await one<{ method: string | null }>('SELECT method FROM valuations WHERE id = ? AND company_id = ?', refresh.current.id, companyId)
    : null;

  // Preferred sales, one row per class, date and price. A round often closes in
  // several tranches, and an appraiser wants to see each of them.
  const SOLD = new Set(['OUTSTANDING', 'CONVERTED', 'TRANSFERRED', 'REPURCHASED']);
  const sales = new Map<string, { date: string; cls: string; shares: number; pps: number }>();
  for (const i of data.issuances) {
    const cls = classOf.get(i.shareClassId);
    if (!cls || cls.kind !== 'PREFERRED' || !SOLD.has(i.status) || isTransferIssuance(i)) continue;
    const key = `${cls.id}|${i.issueDate}|${i.pricePerShare}`;
    const seen = sales.get(key);
    if (seen) seen.shares += i.quantity;
    else sales.set(key, { date: i.issueDate, cls: cls.name, shares: i.quantity, pps: i.pricePerShare });
  }
  const saleRows = [...sales.values()].sort((a, b) => a.date.localeCompare(b.date));

  const workbook = xlsx([
    { name: 'Summary', rows: [
      ['Company', await companyName(companyId)],
      ['As of', asOf],
      ['Fully diluted shares', structure.fullyDiluted],
      [],
      ['Current 409A', refresh.current ? 'On file' : 'None on file'],
      ...(refresh.current ? [
        ['Valuation date', refresh.current.effectiveDate],
        ['Fair market value per common share ($)', price(refresh.current.fairMarketValue)],
        ['Provider', refresh.current.provider ?? ''],
        ['Method', current?.method ?? ''],
        ['Twelve months, or stated expiry, end on', refresh.current.expiresOn],
      ] : []),
      [],
      ['Why a new 409A is being asked for'],
      ...(refresh.triggers.length ? refresh.triggers.map((t) => [t.text]) : [['The company has asked for a refreshed valuation.']]),
      [],
      ['This workbook lists the capital structure by class, instrument and grant. It names no holders.'],
      ...(raw.stockSplits.some((sp) => sp.date <= asOf)
        ? [['Share counts and prices are adjusted for stock splits. Valuation history shows prices as recorded.']] : []),
      ['Generated', new Date().toISOString()], ['Generated by', config().brand.productName],
    ] },
    { name: 'Share classes', rows: [
      ['Share class', 'Type', 'Authorized', 'Outstanding', 'Original issue price ($)', 'Liquidation multiple',
        'Participation', 'Participation cap (x issue price)', 'Conversion ratio', 'Seniority', 'Dividend', 'Dividend rate (%)', 'First issued'],
      ...structure.classes.map((c) => [
        c.name, c.kind === 'PREFERRED' ? 'Preferred' : 'Common', c.authorized, c.outstanding, price(c.originalIssuePrice),
        c.liquidationMultiple, PARTICIPATION[c.participation] ?? c.participation, c.participationCap ?? '', c.conversionRatio,
        c.seniority, c.dividendType === 'NONE' ? 'None' : c.dividendType === 'CUMULATIVE' ? 'Cumulative' : 'Non-cumulative',
        Math.round(c.dividendRate * 10_000) / 100, c.issueDate,
      ]),
    ] },
    { name: 'Financings', rows: [
      ['Preferred stock sold'],
      ['Date', 'Share class', 'Shares', 'Price per share ($)', 'Amount ($)'],
      ...saleRows.map((r) => [r.date, r.cls, r.shares, price(r.pps), Math.round(r.shares * r.pps / 1e4) / 100]),
      [],
      ['Convertible instruments'],
      ['Instrument', 'Issue date', 'Principal ($)', 'Valuation cap ($)', 'Discount (%)', 'Interest rate (%)', 'Maturity', 'Status'],
      ...data.convertibles.filter((c) => c.status !== 'CANCELLED').map((c) => [
        c.instrument === 'SAFE_POST' ? 'Post-money SAFE' : c.instrument === 'SAFE_PRE' ? 'Pre-money SAFE' : c.instrument === 'NOTE' ? 'Convertible note' : 'KISS',
        c.issueDate, dollars(c.principal), c.valuationCap != null ? dollars(c.valuationCap) : '',
        Math.round(c.discount * 10_000) / 100, Math.round(c.interestRate * 10_000) / 100, c.maturityDate ?? '', c.status.toLowerCase(),
      ]),
    ] },
    { name: 'Options and awards', rows: [
      ['Grant', 'Type', 'Grant date', 'Granted', 'Outstanding', 'Exercised', 'Strike price ($)', 'Vesting schedule', 'Expires', 'Status'],
      // Outstanding means what the cap table counts: nothing for a grant that has
      // expired, lapsed after its holder left, or not been issued yet, and only
      // the part vested on the day a holder left once they have.
      ...data.awards.map((a, i) => [
        labelOf(a.label, i + 1), a.type, a.grantDate, a.quantity,
        awardIsLive(a, asOf, leftOn.get(a.stakeholderId) ?? null)
          ? awardPosition(a, scheduleById.get(a.vestingScheduleId), leftOn.get(a.stakeholderId), asOf).outstanding : 0,
        a.exercisedQuantity,
        price(a.strikePrice), a.vestingScheduleId ? scheduleOf.get(a.vestingScheduleId) ?? '' : '', a.expirationDate ?? '', a.status.toLowerCase(),
      ]),
    ] },
    { name: 'Warrants', rows: [
      ['Issue date', 'Share class', 'Shares', 'Strike price ($)', 'Expires', 'Status'],
      ...data.warrants.map((w) => [w.issueDate, classOf.get(w.shareClassId)?.name ?? '', w.quantity, price(w.strikePrice), w.expirationDate ?? '', w.status.toLowerCase()]),
    ] },
    { name: 'Equity plans', rows: [
      ['Plan', 'Authorized', 'Granted', 'Exercised', 'Available'],
      ...computePoolSummaries(data, asOf).map((p, i) => [named(p.name) ? `Plan ${i + 1}` : p.name, p.authorized, p.granted, p.exercised, p.available]),
    ] },
    { name: 'Valuation history', rows: [
      ['Type', 'Valuation date', 'Expires', 'Fair market value per share ($)', 'Provider', 'Method', 'Status'],
      ...valuations.map((v) => [v.type, v.effective_date, v.expiration_date ?? '', price(Number(v.fair_market_value)), v.provider ?? '', v.method ?? '', v.status.toLowerCase()]),
    ] },
  ]);
  return { workbook, asOf };
}

function sendWorkbook(ctx: Ctx, workbook: Buffer, asOf: string): void {
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="409a-data-${asOf}.xlsx"`,
    'Content-Length': workbook.length,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(workbook);
}

route.get('/api/c/:cid/valuation-requests/package.xlsx', 'read', async (ctx) => {
  assertFullView(ctx, REQUEST_NEEDS_FULL_VIEW);
  const { workbook, asOf } = await dataWorkbook(ctx.companyId!);
  await audit(ctx, 'EXPORT', 'valuation_requests', null, '409A data workbook downloaded');
  sendWorkbook(ctx, workbook, asOf);
  return undefined;
});

// --- The valuation team's page -------------------------------------------------
//
// Reached from the emailed link, with no account. The token arrives in a header,
// which a page on another site cannot set, and every answer says not to keep it.

const DESK_ACTOR = (row: RequestRow) => ({ companyId: row.company_id, userName: deskName() });

/** The request a desk token opens, or a 404 that says nothing about why. */
async function deskRequest(ctx: Ctx): Promise<RequestRow> {
  ctx.res.setHeader('Cache-Control', 'no-store');
  const token = String(ctx.req.headers['x-desk-token'] ?? '');
  const invalid = () => notFound('This link is not valid. It may have been replaced by a newer one, or the request closed a while ago.');
  if (!TOKEN_SHAPE.test(token)) throw invalid();
  const row = await one<RequestRow>('SELECT * FROM valuation_requests WHERE desk_token_hash = ?', hashToken(token));
  if (!row) throw invalid();
  // A link lasts valuationDesk.linkOpenDays from when it was sent, and a closed
  // request's no more than linkClosedDays past its close, whichever ends first:
  // closing never revives one.
  const { linkOpenDays, linkClosedDays } = config().valuationDesk;
  const fresh = (row.desk_token_at ?? row.created_at) > since(linkOpenDays * DAY);
  const recent = isOpen(row.status) || (row.closed_at ?? row.updated_at ?? row.created_at) > since(linkClosedDays * DAY);
  if (!fresh || !recent) throw invalid();
  return row;
}

/**
 * The request as the team sees it. While it is open that is everything needed to
 * do the work; once it closes, only what became of it, since the company no
 * longer shares its cap table through a request it has closed.
 */
async function deskView(row: RequestRow) {
  const open = isOpen(row.status);
  const base = {
    id: row.id, status: row.status, open, deskName: deskName(),
    companyName: await companyName(row.company_id),
    createdAt: row.created_at, closedAt: row.closed_at,
    appraiser: row.appraiser, reportDate: row.report_date,
    events: (await eventsOf(row.company_id, row.id)).map(eventView),
  };
  if (!open) return base;
  const intake = intakeOf(row);
  const situation = await situationOf(row.company_id);
  const files = await reportFilesOf(row.company_id, [row.report_document_id]);
  return {
    ...base,
    report: reportView(row, row.report_document_id ? files.get(row.report_document_id) : undefined, (f): DeskReportDocument => ({
      id: f.id, name: f.name, fileName: f.file_name, sizeBytes: f.size_bytes, createdAt: f.created_at,
    })),
    requestedBy: row.requested_by,
    contact: { name: row.contact_name, email: row.contact_email, phone: row.contact_phone },
    answerLines: intake ? intakeLines(intake) : [],
    tables: intake ? intakeTables(intake) : [],
    // Every document the request hands over: an editor chose each one for the team.
    documents: (await documentsOf(row.company_id, row.id)).get(row.id) ?? [],
    notes: row.notes,
    situation: situationLines(situation),
  };
}

route.get('/api/valuation-desk', 'public', async (ctx) => deskView(await deskRequest(ctx)));

const DESK_ACTIONS = ['START', 'DELIVER', 'REOPEN', 'NOTE', 'CLOSE'] as const;

/**
 * The request again, once the company's lock is held, as the team's page opened
 * it. A newer link, or a close from either side while the page was open, stops
 * the change here with the reason.
 */
async function lockedRequest(found: RequestRow): Promise<RequestRow> {
  await one('SELECT id FROM companies WHERE id = ? FOR UPDATE', found.company_id);
  const row = await one<RequestRow>('SELECT * FROM valuation_requests WHERE id = ? AND company_id = ?', found.id, found.company_id);
  if (!row || row.desk_token_hash !== found.desk_token_hash) throw notFound('This link has been replaced by a newer one.');
  if (!isOpen(row.status)) throw badRequest(await closedReason(row));
  return row;
}

/** Why the team can no longer change a closed request, in its own words when it closed it itself. */
async function closedReason(row: RequestRow): Promise<string> {
  const closedHere = row.status === 'CANCELLED'
    && (await eventsOf(row.company_id, row.id)).filter((e) => e.kind === 'CANCELLED').at(-1)?.author === 'desk';
  return closedHere ? 'This request was closed from this page, so it can no longer be changed.'
    : `The company ${row.status === 'COMPLETED' ? 'completed' : 'cancelled'} this request, so it can no longer be changed.`;
}

/** The most a share's fair market value can be given as: a million dollars, in micro-cents. */
const FMV_MAX = 1e12;

/** The fair market value per common share the team gives with the report, in micro-cents, or null when it gives none. */
function fairMarketValueOf(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > FMV_MAX) {
    throw badRequest('Give the fair market value per common share as an amount above zero, or leave it empty.');
  }
  return v;
}

/** The valuation method the team gives with the report, on one line, or null when it gives none. */
function methodOf(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw badRequest('Give the method as text, or leave it empty.');
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > 120) throw badRequest('Keep the method to 120 characters or fewer.');
  return s || null;
}

/**
 * The team moves the request along. It runs under the same lock on the company
 * as the company's own changes, and reads the request again once it holds it, so
 * a cancel on one side and a status change on the other cannot both win.
 *
 * Each change of status is emailed to the person who asked once it has been
 * committed, so a slow mail server never holds the company's lock and a failure
 * never undoes the change. The attempt is counted under the lock, though, so a
 * burst of changes from a leaked link cannot all slip under the daily limit
 * while the first emails are still on their way. A note is not emailed. The
 * answer says beside the request whether the email went, so the page can tell
 * the team.
 */
route.post('/api/valuation-desk/status', 'public', async (ctx) => {
  const found = await deskRequest(ctx);
  const action = String(ctx.body.action ?? '');
  if (!(DESK_ACTIONS as readonly string[]).includes(action)) throw badRequest('That is not something this page can do.');
  const message = str(ctx.body.message, 'Note', { max: 2000, optional: true }) || null;

  const { updated, email } = await transaction(async (): Promise<{ updated: RequestRow; email: (() => Promise<Emailed>) | null }> => {
    const row = await lockedRequest(found);

    const now = nowISO();
    const values: Record<string, unknown> = {};
    let kind: string;
    let change: StatusChange | null = null;
    if (action === 'START') {
      if (row.status === 'IN_PROGRESS') return { updated: row, email: null };   // pressed twice
      if (row.status !== 'REQUESTED') throw badRequest('The report is already marked delivered. Put it back in progress first.');
      values.status = kind = 'IN_PROGRESS';
      change = { kind: 'STARTED' };
    } else if (action === 'DELIVER') {
      if (row.status === 'DELIVERED') throw badRequest('The report is already marked delivered.');
      const appraiser = name(ctx.body.appraiser, 'Appraisal firm', false)!;
      const reportDate = isoDate(ctx.body.reportDate, 'Valuation date');
      const fairMarketValue = fairMarketValueOf(ctx.body.fairMarketValue);
      const method = methodOf(ctx.body.method);
      Object.assign(values, { appraiser, reportDate, reportFmv: fairMarketValue, reportMethod: method });
      values.status = kind = 'DELIVERED';
      change = { kind: 'DELIVERED', appraiser, reportDate, fairMarketValue, reportOnPage: !!row.report_document_id };
    } else if (action === 'REOPEN') {
      if (row.status !== 'DELIVERED') throw badRequest('Only a delivered report can be put back in progress.');
      // The firm, the date, the figures and the file were the delivered report's, so
      // they go with it, and the company's record form is not filled in from a
      // report the team withdrew. The file itself stays in the company's vault: the
      // company has had it since the delivery, and may have read, kept or filed it,
      // so only the request lets go of it.
      Object.assign(values, { appraiser: null, reportDate: null, reportFmv: null, reportMethod: null, reportDetected: null, reportDocumentId: null });
      values.status = kind = 'IN_PROGRESS';
      change = { kind: 'REOPENED' };
    } else if (action === 'NOTE') {
      if (!message) throw badRequest('Write the note to show the company.');
      kind = 'MESSAGE';
    } else {
      if (!message) throw badRequest('Say why the request is being closed. The company sees it.');
      values.status = kind = 'CANCELLED';
      values.closedAt = now;
      change = { kind: 'CLOSED' };
    }
    if (Object.keys(values).length) await update('valuation_requests', row.id, { ...values, updatedAt: now });
    await addEvent(row, kind, message, 'desk', deskName());
    await audit(ctx, 'DESK_UPDATE', 'valuation_requests', row.id,
      kind === 'MESSAGE' ? `The ${deskName()} added a note` : `The ${deskName()} marked the request ${kind.toLowerCase().replace('_', ' ')}`,
      DESK_ACTOR(row));
    const updated = (await one<RequestRow>('SELECT * FROM valuation_requests WHERE id = ?', row.id))!;
    return { updated, email: change ? await tellRequester(ctx, updated, change, message) : null };
  });
  const emailed: Emailed = email ? await email() : 'not sent';
  return { ...(await deskView(updated)), emailed };
});

route.get('/api/valuation-desk/package.xlsx', 'public', async (ctx) => {
  const row = await deskRequest(ctx);
  if (!isOpen(row.status)) throw notFound('The request is closed, so its data is no longer shared.');
  const { workbook, asOf } = await dataWorkbook(row.company_id);
  await audit(ctx, 'EXPORT', 'valuation_requests', row.id, `The ${deskName()} downloaded the 409A data workbook`, DESK_ACTOR(row));
  sendWorkbook(ctx, workbook, asOf);
  return undefined;
});

// --- The documents, for the team ----------------------------------------------
//
// The files the company attached, through the team's link and nothing else: the
// same fresh token package.xlsx needs, only while the request is open, and only
// a document linked to this request. Anything else is the same 404, which says
// nothing about whether the document exists.

const CLOSED_DATA = 'The request is closed, so its data is no longer shared.';
const NOT_HERE = 'That document is not part of this request.';

type LinkedDocument = Doc & {
  item: DocumentItem; file_name: string | null; mime_type: string | null; storage_key: string | null;
  /** The size of the stored file, or null when there is none. */
  blob_bytes: number | null;
};

/** The documents linked to a request, or the one asked for, matched on the request's company as well as its id. */
async function linkedDocuments(row: RequestRow, documentId?: string): Promise<LinkedDocument[]> {
  const docs = await all<LinkedDocument>(
    `SELECT l.item, d.*, b.size_bytes AS blob_bytes
       FROM valuation_request_documents l JOIN documents d ON d.id = l.document_id AND d.company_id = l.company_id
       LEFT JOIN file_blobs b ON b.document_id = d.id
      WHERE l.request_id = ? AND l.company_id = ?${documentId ? ' AND l.document_id = ?' : ''}`,
    row.id, row.company_id, ...(documentId ? [documentId] : []));
  return docs.sort((a, b) => ITEM_ORDER.get(a.item)! - ITEM_ORDER.get(b.item)! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * What a document downloads as: a stored file as it was uploaded, or a document
 * with only text as the same PDF the company's own download makes. Null when
 * there is neither, which the request's checks make rare: a file removed later.
 */
async function fileOf(doc: LinkedDocument): Promise<{ data: Buffer; fileName: string; type: string } | null> {
  if (doc.storage_key) {
    const data = await readFile(doc.id);
    if (data) return { data, fileName: doc.file_name || doc.name, type: doc.mime_type || 'application/octet-stream' };
  }
  if (doc.body) return { data: await renderDocumentPdf(doc), fileName: `${doc.name}.pdf`, type: 'application/pdf' };
  return null;
}

/**
 * A file name in a Content-Disposition header: an ASCII copy for the clients that
 * read only that, and the name as given for the rest. Line breaks and quotes are
 * replaced, so a name cannot end the header or start another.
 */
function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, "'");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * One part of a path in a ZIP: no slashes, none of the characters Windows refuses,
 * no leading dots, not empty, and short enough for every file system, keeping
 * the extension when it has to be cut.
 */
function safeName(s: string): string {
  const clean = s.normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!clean) return 'document';
  if (clean.length <= 150) return clean;
  const ext = clean.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? '';
  return `${clean.slice(0, 150 - ext.length).trimEnd()}${ext}`;
}

/** A path not yet used in the archive: "name.pdf", then "name (2).pdf", ignoring case as Windows and macOS do. */
function unusedPath(taken: Set<string>, folder: string, file: string): string {
  const dot = file.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  let path = `${folder}/${file}`;
  for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${folder}/${stem} (${n})${ext}`;
  taken.add(path.toLowerCase());
  return path;
}

route.get('/api/valuation-desk/documents/:documentId', 'public', async (ctx) => {
  const row = await deskRequest(ctx);
  if (!isOpen(row.status)) throw notFound(CLOSED_DATA);
  const [doc] = await linkedDocuments(row, ctx.params.documentId);
  const file = doc ? await fileOf(doc) : null;
  if (!doc || !file) throw notFound(NOT_HERE);
  await audit(ctx, 'EXPORT', 'valuation_requests', row.id, `The ${deskName()} downloaded "${doc.name}"`, DESK_ACTOR(row));
  ctx.res.writeHead(200, {
    'Content-Type': file.type, 'Content-Length': file.data.length, 'Content-Disposition': attachment(file.fileName),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(file.data);
  return undefined;
});

/**
 * The most one ZIP can hold. The archive is written without the ZIP64 extension,
 * whose sizes and offsets stop at 4 GiB, and past that it would come out broken
 * rather than refused.
 */
const ZIP_LIMIT = 0xffff_ffff;

/**
 * The requests whose documents are being written into a ZIP right now. One at a
 * time for each, so a link pressed over and over cannot set the server reading
 * every file of a request many times at once.
 */
const zipping = new Set<string>();

/** A ZIP entry to write: its path in the archive and how to read its bytes, once, when its turn comes. */
interface ZipEntry { name: string; read: () => Promise<Buffer | null> }

/**
 * Writes a ZIP to the response one file at a time, so only the file being written
 * is in memory however many the request has, and waits whenever the connection
 * is slower than the database. Each file is stored as it is, not compressed:
 * statements and scans are PDFs that barely shrink, and compressing them would
 * hold up every other request on the server for nothing. Each is read before its
 * header is written, so the header carries its real size and checksum, and one
 * that has gone since the request was made is left out. Returns how many went in.
 */
async function streamZip(res: ServerResponse, entries: ZipEntry[]): Promise<number> {
  const write = (chunk: Buffer) => new Promise<void>((resolve, reject) => {
    if (res.destroyed) { reject(new Error('the download was stopped')); return; }
    if (res.write(chunk)) { resolve(); return; }
    const drained = () => { res.off('close', closed); resolve(); };
    const closed = () => { res.off('drain', drained); reject(new Error('the download was stopped')); };
    res.once('drain', drained);
    res.once('close', closed);
  });
  const d = new Date();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const day = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = await e.read();
    if (!data) continue;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    // Stored (method 0), with names in UTF-8 (flag 0x0800).
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(day, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    await write(Buffer.concat([local, name]));
    await write(data);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16);
  await write(Buffer.concat([directory, eocd]));
  res.end();
  return central.length / 2;
}

/** Every document in one ZIP, each in a folder named for the item it answers. */
route.get('/api/valuation-desk/documents.zip', 'public', async (ctx) => {
  const row = await deskRequest(ctx);
  if (!isOpen(row.status)) throw notFound(CLOSED_DATA);
  // What goes in, planned from the records before any file is read: the same
  // choice fileOf makes, a stored file as it is or text as its PDF.
  const taken = new Set<string>();
  const entries: (ZipEntry & { size: number })[] = [];
  for (const doc of await linkedDocuments(row)) {
    const stored = !!doc.storage_key && doc.blob_bytes != null;
    if (!stored && !doc.body) continue;
    const fileName = stored ? doc.file_name || doc.name : `${doc.name}.pdf`;
    entries.push({
      name: unusedPath(taken, safeName(ITEM_LABEL.get(doc.item) ?? doc.item), safeName(fileName)),
      size: stored ? Number(doc.blob_bytes) : Buffer.byteLength(doc.body ?? ''),
      read: () => (stored ? readFile(doc.id) : renderDocumentPdf(doc)),
    });
  }
  if (!entries.length) throw notFound('This request has no documents to download.');
  // Each file once, with its two headers and its name twice, and the directory's end.
  if (entries.reduce((n, e) => n + e.size + 76 + 2 * Buffer.byteLength(e.name), 22) > ZIP_LIMIT) {
    throw badRequest('These documents come to more than one ZIP file can hold. Download them one at a time.');
  }
  if (zipping.has(row.id)) {
    throw new HttpError(429, 'The documents are already being put together for this request. Wait for that download to finish, then try again.');
  }
  zipping.add(row.id);
  try {
    await audit(ctx, 'EXPORT', 'valuation_requests', row.id,
      `The ${deskName()} downloaded the request's documents in one file (${count(entries.length, 'document')})`, DESK_ACTOR(row));
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Disposition': attachment(`409a-documents-${today()}.zip`),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    await streamZip(ctx.res, entries);
  } catch (err) {
    // Before the headers, the error is answered as any other. After them there is
    // no error page to send: the download stops, and the browser says it failed
    // rather than saving half a file.
    if (!ctx.res.headersSent) throw err;
    console.error(`[409a] the documents of request ${row.id} could not be sent:`, (err as Error).message);
    ctx.res.destroy();
  } finally {
    zipping.delete(row.id);
  }
  return undefined;
});

// --- The report, from the team -------------------------------------------------
//
// The team can upload the appraisal report from its page while it works the
// request, before it marks the report delivered. The file goes into the company's
// vault, kept to administrators like any valuation paperwork, and the app reads
// the fair market value, the valuation date and the method from it to fill in the
// team's delivery form. The team corrects what was misread and delivers; the
// company then checks the values against the report and records the 409A itself.
// Uploading is optional: a report delivered by email works as it always did.

/** An upload whose file this server has started to read, and when it started. */
interface Attempt { at: number }

/**
 * The uploads to each request that this server has read, or is reading, and not
 * saved. The daily limit counts these beside the saved uploads in the audit log:
 * an upload counts from the moment its reading starts, so a burst from a leaked
 * link cannot all pass the limit before the first is saved, and a file read and
 * then refused, or lost to a failure, still counts. Kept for a day, as the limit is.
 */
const unsaved = new Map<string, Set<Attempt>>();

/** Counts an upload to a request against the day's limit, before its file is read. */
function startAttempt(requestId: string): Attempt {
  const attempt = { at: Date.now() };
  unsaved.set(requestId, (unsaved.get(requestId) ?? new Set()).add(attempt));
  return attempt;
}

/** Stops counting an attempt here: it was saved, and its audit row counts it now, or its file was never read. */
function endAttempt(requestId: string, attempt: Attempt): void {
  const mine = unsaved.get(requestId);
  mine?.delete(attempt);
  if (mine?.size === 0) unsaved.delete(requestId);
}

/** The uploads to a request read in the last day and not saved, but for `except`. */
function unsavedToday(requestId: string, except?: Attempt): number {
  const mine = unsaved.get(requestId);
  if (!mine) return 0;
  const dayAgo = Date.now() - DAY;
  for (const a of mine) if (a.at <= dayAgo) mine.delete(a);
  if (!mine.size) unsaved.delete(requestId);
  return mine.size - (except && mine.has(except) ? 1 : 0);
}

/**
 * Whether a link may upload a report today: valuationDesk.reportUploadsPerRequestPerDay,
 * with 0 turning uploads off. Counts the uploads saved and those read but not
 * saved, but for `except`: the upload asking, once its own reading is counted.
 */
async function uploadHold(row: RequestRow, except?: Attempt): Promise<string | null> {
  const limit = config().valuationDesk.reportUploadsPerRequestPerDay;
  if (limit === 0) return 'Uploading the report is turned off on this server. Send it to the company by email instead.';
  const saved = await countSince(`entity_id = ? AND action = 'DESK_UPLOAD'`, DAY, row.id);
  if (saved + unsavedToday(row.id, except) >= limit) {
    return `A report has been uploaded to this request, or tried, ${times(limit)} today. Try again tomorrow, or send it to the company by email.`;
  }
  return null;
}

/** Why a report cannot be uploaded or removed now, or null when it can: only while the team works the request. */
async function uploadRefusal(row: RequestRow): Promise<string | null> {
  if (row.status === 'DELIVERED') return 'The report is already marked delivered. Put it back in progress to change it.';
  return isOpen(row.status) ? null : closedReason(row);
}

/** Where an upload files the report in the vault. */
const UPLOAD_FILING = { category: 'VALUATION', folder: 'Valuations' } as const;
/** The name an upload gives the report in the vault: its file name, as long as the vault keeps one. */
const uploadTitle = (fileName: string): string => fileName.slice(0, 200);

interface UploadedFile {
  name: string; file_name: string | null; category: string; folder: string | null; visibility: string;
  security_id: string | null; stakeholder_id: string | null; subject_kind: string | null; updated_at: string | null;
}

/**
 * Whether a document is as the team's upload left it. Nobody at the company has
 * filed it against a holding, a holder or a compliance subject, shared it,
 * renamed it, reclassified it or moved it to another folder. Each of those edits
 * stamps updated_at, which the upload never sets, and each is checked as well in
 * case a later route makes it another way.
 */
const asUploaded = (d: UploadedFile): boolean =>
  d.updated_at == null && d.security_id == null && d.stakeholder_id == null && d.subject_kind == null
  && d.visibility === 'ADMIN' && d.category === UPLOAD_FILING.category && d.folder === UPLOAD_FILING.folder
  && d.name === uploadTitle(d.file_name ?? '');

/**
 * Removes a draft the team uploaded and then replaced or took back before
 * delivering, so drafts do not pile up in the company's vault. Only a draft,
 * while the team works the request: once it has delivered the report, the
 * company has had it, so a request that lets go of it after that only unlinks
 * it. And only a draft as the upload left it that nothing else uses: no
 * valuation's report, no request's documents, no other request, no signature.
 * A file someone at the company has put to use stays where it is.
 */
async function dropUpload(row: RequestRow, documentId: string): Promise<boolean> {
  if (row.status !== 'REQUESTED' && row.status !== 'IN_PROGRESS') return false;
  const doc = await one<UploadedFile>(
    `SELECT name, file_name, category, folder, visibility, security_id, stakeholder_id, subject_kind, updated_at
       FROM documents WHERE id = ? AND company_id = ?`, documentId, row.company_id);
  if (!doc || !asUploaded(doc)) return false;
  const used = await one(
    `SELECT 1 AS used WHERE EXISTS (SELECT 1 FROM valuations WHERE report_document_id = ?)
        OR EXISTS (SELECT 1 FROM valuation_request_documents WHERE document_id = ?)
        OR EXISTS (SELECT 1 FROM valuation_requests WHERE report_document_id = ? AND id <> ?)
        OR EXISTS (SELECT 1 FROM signatures WHERE document_id = ?)`,
    documentId, documentId, documentId, row.id, documentId);
  if (used) return false;
  return (await run('DELETE FROM documents WHERE id = ? AND company_id = ?', documentId, row.company_id)) > 0;
}

/** A file name as given, on one line and with no path in it, or a plain one when none was given. */
function uploadName(v: string | null): string {
  const s = (v ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\/]/g, '_').trim();
  if (s.length > 255) throw badRequest('The file name is too long. Rename the file and upload it again.');
  return s || 'Valuation report.pdf';
}

/**
 * The requests a report is being uploaded to right now, one at a time for each,
 * so two uploads to one request never replace each other halfway, and the team
 * is told plainly that its first is still going.
 */
const uploading = new Set<string>();

/**
 * How many reports this server reads at once. The reading runs in a worker with
 * a ceiling on its time and memory (report-reader.ts), but each one still takes
 * a core and that memory while it runs, and the file comes from outside the
 * company. A real report takes well under a second, so an upload that comes
 * while another is being read is told to try again in a moment rather than
 * piling onto the machine, and its file is not read.
 */
const READ_AT_ONCE = 1;
let reading = 0;
const READER_BUSY = 'Another report is being read. Try again in a moment.';

/**
 * The team uploads the report: the PDF as the body, its name in ?name=. It is read
 * in a worker before the company's lock is taken, since a long report takes a
 * moment and nothing else needs to wait for it; the request is read again under
 * the lock, the same lock the status changes take, so an upload and a delivery
 * or a close cannot cross. A report uploaded before replaces the earlier one.
 */
route.post('/api/valuation-desk/report', 'public', async (ctx) => {
  const found = await deskRequest(ctx);
  const refused = await uploadRefusal(found);
  if (refused) throw badRequest(refused);
  const body = ctx.rawBody;
  if (!body || body.length === 0) throw badRequest('The upload is empty. Choose the report’s PDF.');
  if (body.toString('latin1', 0, 5) !== '%PDF-') throw badRequest('Upload the report as a PDF.');
  const fileName = uploadName(ctx.query.get('name'));
  const held = await uploadHold(found);
  if (held) throw badRequest(held);
  // Nothing waits from here until the reading has started and is counted, so no
  // other upload can come between these checks and the count.
  if (uploading.has(found.id)) {
    throw new HttpError(429, 'A report is already being uploaded to this request. Wait for it to finish, then try again.');
  }
  if (reading >= READ_AT_ONCE) throw new HttpError(429, READER_BUSY);

  const attempt = startAttempt(found.id);
  uploading.add(found.id);
  try {
    let detected: ReportDetection;
    reading++;
    try {
      detected = await readReport(body);
    } catch (err) {
      // The reader keeps a line of its own, which one reading at a time never
      // fills; if it is full all the same, the file was not read and is not counted.
      if (err instanceof ReaderBusy) {
        endAttempt(found.id, attempt);
        throw new HttpError(429, READER_BUSY);
      }
      throw err;
    } finally {
      reading--;
    }

    const updated = await transaction(async () => {
      const row = await lockedRequest(found);
      const late = (await uploadRefusal(row)) ?? (await uploadHold(row, attempt));
      if (late) throw badRequest(late);
      const docId = newId('doc');
      const now = nowISO();
      await insert('documents', {
        id: docId, companyId: row.company_id, name: uploadTitle(fileName), ...UPLOAD_FILING, body: '',
        requiresSignature: 0, status: 'FINAL', visibility: 'ADMIN',
        fileName, mimeType: 'application/pdf', sizeBytes: body.length, storageKey: `db:${docId}`,
        sha256: createHash('sha256').update(body).digest('hex'), createdBy: deskName(), createdAt: now,
      });
      await storeFile(docId, row.company_id, body);
      await update('valuation_requests', row.id, { reportDocumentId: docId, reportDetected: JSON.stringify(detected), updatedAt: now });
      if (row.report_document_id) await dropUpload(row, row.report_document_id);
      await audit(ctx, 'DESK_UPLOAD', 'valuation_requests', row.id, `The ${deskName()} uploaded the report "${fileName}"`, DESK_ACTOR(row));
      return (await one<RequestRow>('SELECT * FROM valuation_requests WHERE id = ?', row.id))!;
    });
    // Committed: the audit row counts this upload from here on.
    endAttempt(found.id, attempt);
    return { ...(await deskView(updated)), detected };
  } finally {
    uploading.delete(found.id);
  }
}, { raw: true, maxBytes: maxUploadBytes });

/** The team takes its upload back before delivering, to deliver by email instead or to start again. */
route.del('/api/valuation-desk/report', 'public', async (ctx) => {
  const found = await deskRequest(ctx);
  const updated = await transaction(async () => {
    const row = await lockedRequest(found);
    const refused = await uploadRefusal(row);
    if (refused) throw badRequest(refused);
    if (!row.report_document_id && !row.report_detected) return row;   // pressed twice
    const doc = row.report_document_id
      ? await one<{ name: string }>('SELECT name FROM documents WHERE id = ? AND company_id = ?', row.report_document_id, row.company_id) : undefined;
    await update('valuation_requests', row.id, { reportDocumentId: null, reportDetected: null, updatedAt: nowISO() });
    if (row.report_document_id) await dropUpload(row, row.report_document_id);
    await audit(ctx, 'DESK_REMOVE_UPLOAD', 'valuation_requests', row.id,
      `The ${deskName()} removed the report it uploaded${doc ? ` ("${doc.name}")` : ''}`, DESK_ACTOR(row));
    return (await one<RequestRow>('SELECT * FROM valuation_requests WHERE id = ?', row.id))!;
  });
  return deskView(updated);
});

/** The team downloads the report it uploaded, with its link, while the request is open. */
route.get('/api/valuation-desk/report', 'public', async (ctx) => {
  const row = await deskRequest(ctx);
  if (!isOpen(row.status)) throw notFound(CLOSED_DATA);
  const doc = row.report_document_id
    ? await one<{ id: string; name: string; file_name: string | null; mime_type: string | null }>(
      'SELECT id, name, file_name, mime_type FROM documents WHERE id = ? AND company_id = ?', row.report_document_id, row.company_id)
    : undefined;
  const data = doc ? await readFile(doc.id) : null;
  if (!doc || !data) throw notFound('No report has been uploaded to this request.');
  await audit(ctx, 'EXPORT', 'valuation_requests', row.id, `The ${deskName()} downloaded the report it uploaded ("${doc.name}")`, DESK_ACTOR(row));
  ctx.res.writeHead(200, {
    'Content-Type': doc.mime_type || 'application/pdf', 'Content-Length': data.length, 'Content-Disposition': attachment(doc.file_name || doc.name),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(data);
  return undefined;
});
