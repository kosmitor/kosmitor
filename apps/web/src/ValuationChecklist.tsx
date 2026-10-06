/**
 * The appraiser's information request, asked as the 409A request form.
 *
 * An appraiser asks every company the same thirteen things before valuing its
 * common stock: the date to value it as of, the financial statements, the pitch
 * deck, who runs the company, the cap table and option ledger, the options about
 * to be granted, earlier reports, the charter, the SAFEs and notes, projections,
 * and three questions about value that changed hands below its worth (secondary
 * sales, below-market salaries, below-market expenses). A request that leaves any
 * of them out comes back with questions, and the valuation waits for the answers.
 * So each one is a question here that has to be answered, and a rule on the
 * server that refuses the request without it. The checks below mirror the
 * server's, so a problem shows at its question; the server stays the judge.
 *
 * Nothing built from the cap table names a holder. The only names the team reads
 * in the answers are the ones typed here: the management team, the people on
 * below-market salaries, and how a buyer and a seller are described, which the
 * form asks for as a role ("a new investor") rather than a name. The documents
 * go as they are, because the appraiser asked for them, and the app does not
 * read inside them: a SAFE names its investor. Their names are in both emails.
 *
 * Documents are filed in the vault as soon as they are chosen, and a request
 * links them rather than copying them, so nothing uploaded is lost when the
 * dialog closes and the company keeps its own copy of what it sent.
 */
import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from './session.tsx';
import { uploadFile } from './api.ts';
import { FormGrid } from './crud.tsx';
import { Button, Checkbox, Field, Input, Select, Spinner, Textarea, cx } from './ui.tsx';
import { Icon, type IconName } from './icons.tsx';
import {
  amountHint, currencySymbol, date, fieldNumber, money, parseMoney, parsePPS, parseShares, pps, shares, today,
} from './format.ts';
import { config, type PublicConfig } from './config.ts';
import { categoryLabel } from './documents.ts';

// --- What the checklist asks for, in the server's words -------------------------

export type DocumentItem = 'HISTORICAL_FINANCIALS' | 'YTD_FINANCIALS' | 'PITCH_DECK' | 'PRIOR_VALUATIONS'
  | 'CHARTER' | 'CONVERTIBLE_AGREEMENTS' | 'PROJECTIONS';

interface ItemInfo { item: DocumentItem; label: string; guidance: string; category: string; icon: IconName }

/**
 * What each document item is called and what to send for it, in the same words
 * and the same order as the server's DOCUMENT_ITEMS, which is the order the team
 * reads them in. The category is where an upload for the item is filed in the vault.
 */
export const DOCUMENT_ITEMS: ItemInfo[] = [
  { item: 'HISTORICAL_FINANCIALS', label: 'Historical financial statements', icon: 'ledger', category: 'OTHER',
    guidance: 'The last three to four years, or every year since the company started if it is younger.' },
  { item: 'YTD_FINANCIALS', label: 'Year-to-date financial statements', icon: 'calendar', category: 'OTHER',
    guidance: 'From the start of this financial year to the valuation date.' },
  { item: 'PITCH_DECK', label: 'Pitch deck or company presentation', icon: 'megaphone', category: 'OTHER',
    guidance: 'The latest one. It helps the appraiser understand the business.' },
  { item: 'PRIOR_VALUATIONS', label: 'Earlier valuation reports', icon: 'history', category: 'VALUATION',
    guidance: 'So the new valuation stays consistent with the earlier assumptions.' },
  { item: 'CHARTER', label: 'Certificate of incorporation', icon: 'gavel', category: 'CHARTER',
    guidance: 'The current one, with any amendments.' },
  { item: 'CONVERTIBLE_AGREEMENTS', label: 'SAFE and convertible note agreements', icon: 'convert', category: 'FINANCING',
    guidance: 'Every SAFE and note still outstanding.' },
  { item: 'PROJECTIONS', label: 'Financial projections', icon: 'trending', category: 'OTHER',
    guidance: 'Three to five years, if you have them.' },
];
const INFO = Object.fromEntries(DOCUMENT_ITEMS.map((i) => [i.item, i])) as Record<DocumentItem, ItemInfo>;
export const itemLabel = (item: DocumentItem): string => INFO[item]?.label ?? item;

/** Every upload from the form lands in this vault folder, so the request's paperwork is found in one place. */
export const UPLOAD_FOLDER = '409A request';
/** The server refuses more than this many documents for one item, and more than this many in all. */
export const MAX_PER_ITEM = 20;
export const MAX_DOCUMENTS = 100;

/** A document the checklist endpoint suggests for an item, and why it does. */
export interface ChecklistDocument {
  id: string; name: string; category: string; folder: string | null; fileName: string | null;
  mimeType: string | null; sizeBytes: number | null; createdAt: string;
  source: 'CHARTER' | 'REPORT' | 'INSTRUMENT' | 'LAST_REQUEST';
}

/**
 * What the cap table and the vault already answer (GET /c/:cid/valuation-requests/checklist).
 * The counts and the year are the ones the server checks a request against.
 */
export interface Checklist {
  convertiblesOutstanding: number;
  /** Shares issued and outstanding. A request needs some, or there is no capital structure to value. */
  sharesOutstanding: number;
  fiscalYearEnd: string | null;
  incorporationDate: string | null;
  /** Whether a whole fiscal year has passed since incorporation, so "not finished a financial year yet" is not an answer. */
  finishedFullYear: boolean;
  suggestions: Partial<Record<DocumentItem, ChecklistDocument[]>>;
}

/** A document a request hands the team, as both the company's list and the team's page send it. */
export interface RequestDocument {
  item: DocumentItem; itemLabel: string; id: string; name: string;
  fileName: string | null; mimeType: string | null; sizeBytes: number | null; hasBody: boolean; createdAt: string;
}

/** An answer that is a list, already in words: the server builds these once, for every reader. */
export interface AnswerTable { title: string; columns: string[]; rows: string[][] }

/**
 * The answers as they were stored. Every field is optional: a request made
 * before a question existed did not ask it, and reads as not asked.
 */
export interface StoredAnswers {
  version?: number;
  companySize?: string; stage?: string; plans?: string; plansTiming?: string | null;
  last409a?: string; last409aDate?: string | null; software?: string;
  management?: { name: string; title: string }[];
  sweatEquity?: boolean;
  sweatEquityPeople?: {
    name: string; title: string; from: string; to: string | null;
    timePercent: number; marketSalary: number; salaryReceived: number;
  }[];
  belowMarketExpenses?: boolean;
  expenses?: { nature: string; recorded: number; market: number }[];
  secondary?: boolean;
  secondaryTransactions?: {
    securityType: string; date: string | null; shares: number; pricePerShare: number;
    priceRationale: string; rationale: string; buyer: string; seller: string; expectRepeat: boolean;
  }[];
}

// --- The form ------------------------------------------------------------------

type YesNo = '' | 'YES' | 'NO';

/** A document attached to an item, with a word on where it came from. */
export interface AttachedDocument { id: string; name: string; fileName: string | null; sizeBytes: number | null; note?: string }

/** A file on its way into the vault, or one that did not get there. Once stored it becomes an attached document. */
export interface Upload { key: string; item: DocumentItem; name: string; size: number; error: string | null }

interface ManagementRow { key: string; name: string; title: string }
interface GuidanceRow { key: string; revenue: string; ebitda: string }
interface SecondaryRow {
  key: string; securityType: string; date: string; shares: string; pricePerShare: string;
  priceRationale: string; rationale: string; buyer: string; seller: string; expectRepeat: YesNo;
}
interface SweatRow {
  key: string; name: string; title: string; from: string; to: string; ongoing: boolean;
  timePercent: string; marketSalary: string; salaryReceived: string;
}
interface ExpenseRow { key: string; nature: string; recorded: string; market: string }

/**
 * Everything the form holds. Amounts stay the text that was typed until the
 * request is sent, so "1.2m" is not rewritten under someone's cursor; the years
 * of guidance follow from the first one, so they are consecutive by construction.
 */
export interface IntakeForm {
  valuationDateKind: '' | 'LATEST' | 'DATE'; valuationDate: string;
  companySize: string; stage: string; plans: string; plansTiming: string; optionsToGrant: string;
  last409a: '' | 'DATE' | 'NEVER' | 'UNKNOWN'; last409aDate: string;
  noFullYearYet: boolean;
  documents: Partial<Record<DocumentItem, AttachedDocument[]>>;
  uploads: Upload[];
  convertiblesOutstanding: YesNo;
  projections: '' | 'FILE' | 'GUIDANCE';
  guidanceStart: string; guidance: GuidanceRow[];
  capTableConfirmed: boolean;
  management: ManagementRow[];
  sweatEquity: YesNo; sweatEquityPeople: SweatRow[];
  secondary: YesNo; secondaryTransactions: SecondaryRow[];
  belowMarketExpenses: YesNo; expenses: ExpenseRow[];
  software: string; contactName: string; contactEmail: string; contactPhone: string; notes: string;
  /** What the last request answered to the questions about value given below market, shown beside them, never filled in. */
  lastTime: Partial<Record<'sweatEquity' | 'secondary' | 'belowMarketExpenses', boolean>>;
}

let rowSeq = 0;
/** A key for a row or an upload, so React and the problems can tell rows apart when one is removed. */
const nextKey = (): string => `r${++rowSeq}`;
const thisYear = (): number => Number(today().slice(0, 4));

const blankManagement = (): ManagementRow => ({ key: nextKey(), name: '', title: '' });
const blankGuidance = (): GuidanceRow => ({ key: nextKey(), revenue: '', ebitda: '' });
const blankSecondary = (): SecondaryRow => ({
  key: nextKey(), securityType: '', date: '', shares: '', pricePerShare: '', priceRationale: '', rationale: '', buyer: '', seller: '', expectRepeat: '',
});
// Most people giving up salary to build a company are still doing it, so "still the case" starts ticked.
const blankSweat = (): SweatRow => ({
  key: nextKey(), name: '', title: '', from: '', to: '', ongoing: true, timePercent: '', marketSalary: '', salaryReceived: '',
});
const blankExpense = (): ExpenseRow => ({ key: nextKey(), nature: '', recorded: '', market: '' });

export function blankIntake(): IntakeForm {
  return {
    valuationDateKind: '', valuationDate: '', companySize: '', stage: '', plans: '', plansTiming: '', optionsToGrant: '',
    last409a: '', last409aDate: '', noFullYearYet: false, documents: {}, uploads: [], convertiblesOutstanding: '',
    projections: '', guidanceStart: String(thisYear()), guidance: [blankGuidance(), blankGuidance()], capTableConfirmed: false,
    management: [blankManagement()], sweatEquity: '', sweatEquityPeople: [blankSweat()],
    secondary: '', secondaryTransactions: [blankSecondary()], belowMarketExpenses: '', expenses: [blankExpense()],
    software: '', contactName: '', contactEmail: '', contactPhone: '', notes: '', lastTime: {},
  };
}

const yesNo = (b: boolean | undefined): YesNo => (b === true ? 'YES' : b === false ? 'NO' : '');
const moneyField = (cents: number): string => fieldNumber(cents / 100);

/**
 * A fresh form carrying over what rarely changes from the company's last
 * request: its size and stage, its software, who runs it, and the rows listed
 * for the three questions about value given below market, so a "yes" again
 * starts from last time's people, sales and expenses. The three yes-or-no
 * answers themselves are left to be given again, with last time's beside them:
 * a sale or a pay cut since the last 409A is exactly what they ask about, and a
 * "no" carried over would answer them for someone who has not looked. Nor the
 * valuation date, the options about to be granted or the confirmation that the
 * cap table is current, which are about now for the same reason.
 */
export function prefilledIntake(previous: StoredAnswers | null): IntakeForm {
  const f = blankIntake();
  if (!previous) return f;
  const people = previous.sweatEquityPeople ?? [];
  const sales = previous.secondaryTransactions ?? [];
  const costs = previous.expenses ?? [];
  return {
    ...f,
    companySize: previous.companySize ?? '',
    stage: previous.stage ?? '',
    software: previous.software ?? '',
    management: previous.management?.length
      ? previous.management.map((m) => ({ key: nextKey(), name: m.name, title: m.title })) : f.management,
    lastTime: { sweatEquity: previous.sweatEquity, secondary: previous.secondary, belowMarketExpenses: previous.belowMarketExpenses },
    sweatEquityPeople: people.length ? people.map((p) => ({
      key: nextKey(), name: p.name, title: p.title, from: p.from, to: p.to ?? '', ongoing: p.to == null,
      timePercent: String(p.timePercent), marketSalary: moneyField(p.marketSalary), salaryReceived: moneyField(p.salaryReceived),
    })) : f.sweatEquityPeople,
    expenses: costs.length ? costs.map((e) => ({
      key: nextKey(), nature: e.nature, recorded: moneyField(e.recorded), market: moneyField(e.market),
    })) : f.expenses,
    secondaryTransactions: sales.length ? sales.map((s) => ({
      key: nextKey(), securityType: s.securityType, date: s.date ?? '', shares: fieldNumber(s.shares),
      pricePerShare: fieldNumber(s.pricePerShare / 1e6), priceRationale: s.priceRationale, rationale: s.rationale,
      buyer: s.buyer, seller: s.seller, expectRepeat: yesNo(s.expectRepeat),
    })) : f.secondaryTransactions,
  };
}

/** Why a document is offered for an item, in the words the card shows next to it. */
const SOURCE_NOTE: Record<ChecklistDocument['source'], string> = {
  // The vault's category, which holds the bylaws too: it says where the document is filed, not what it is.
  CHARTER: `Filed under ${categoryLabel('CHARTER')}`,
  REPORT: 'The report of an earlier 409A',
  INSTRUMENT: 'Filed against an outstanding SAFE or note',
  LAST_REQUEST: 'Sent with the last request',
};

const fromSuggestion = (s: ChecklistDocument): AttachedDocument =>
  ({ id: s.id, name: s.name, fileName: s.fileName, sizeBytes: s.sizeBytes, note: SOURCE_NOTE[s.source] });

/** Adds documents to an item, once each: the same document may answer two items, but not one item twice. */
export function attach(f: IntakeForm, item: DocumentItem, docs: AttachedDocument[]): IntakeForm {
  const have = f.documents[item] ?? [];
  const fresh = docs.filter((d, i) => !have.some((h) => h.id === d.id) && docs.findIndex((x) => x.id === d.id) === i);
  return fresh.length ? { ...f, documents: { ...f.documents, [item]: [...have, ...fresh] } } : f;
}

/**
 * What the cap table and the vault already answer, filled in once when the
 * checklist arrives: whether SAFEs or notes are outstanding, and the documents
 * that are surely the ones asked for. That is one charter, the newest filed under
 * the charter category that is not the bylaws, since the category holds both and
 * every earlier version too; the reports of earlier 409As, all of which the
 * appraiser asked for; and the agreements filed against an instrument still
 * outstanding. Everything else is only offered, one click away: the other
 * charter documents, an agreement sent last time whose SAFE may since have
 * converted, and the financials sent last time, because last year's statements
 * are not this year's.
 */
export function applyChecklist(f: IntakeForm, c: Checklist): IntakeForm {
  let next: IntakeForm = f.convertiblesOutstanding ? f : { ...f, convertiblesOutstanding: c.convertiblesOutstanding > 0 ? 'YES' : 'NO' };
  const offered = (item: DocumentItem) => c.suggestions[item] ?? [];
  // The suggestions come newest first. Without a charter in its category, the one
  // someone sent as the charter last time.
  const charters = offered('CHARTER').filter((s) => !/by-?laws?/i.test(s.name));
  const charter = charters.find((s) => s.source === 'CHARTER') ?? charters.find((s) => s.source === 'LAST_REQUEST');
  next = attach(next, 'CHARTER', charter ? [fromSuggestion(charter)] : []);
  next = attach(next, 'CONVERTIBLE_AGREEMENTS', offered('CONVERTIBLE_AGREEMENTS').filter((s) => s.source === 'INSTRUMENT').slice(0, MAX_PER_ITEM).map(fromSuggestion));
  if (f.last409a === 'DATE') next = attach(next, 'PRIOR_VALUATIONS', offered('PRIOR_VALUATIONS').slice(0, MAX_PER_ITEM).map(fromSuggestion));
  return next;
}

type Update = (fn: (f: IntakeForm) => IntakeForm) => void;

/**
 * Files the chosen files in the vault for one item, each as soon as it is
 * chosen, and attaches each to the item once it is stored. A file over the
 * upload limit is refused here, before anyone waits for it to be sent.
 */
export function uploadForItem(companyId: string, item: DocumentItem, files: File[], update: Update): void {
  const limit = config.limits.uploadMb * 1024 * 1024;
  for (const file of files) {
    const key = nextKey();
    const error = file.size === 0 ? 'The file is empty.'
      : file.size > limit ? `It is over the ${config.limits.uploadMb} MB limit.` : null;
    update((f) => ({ ...f, uploads: [...f.uploads, { key, item, name: file.name, size: file.size, error }] }));
    if (error) continue;
    uploadFile<{ id: string; name: string; fileName: string | null; sizeBytes: number | null }>(
      `/c/${companyId}/documents/upload`, file, { category: INFO[item].category, folder: UPLOAD_FOLDER })
      .then((doc) => update((f) => attach({ ...f, uploads: f.uploads.filter((u) => u.key !== key) }, item, [
        { id: doc.id, name: doc.name, fileName: doc.fileName, sizeBytes: doc.sizeBytes, note: `Uploaded to ${UPLOAD_FOLDER}` },
      ])))
      .catch((err: Error) => update((f) => ({ ...f, uploads: f.uploads.map((u) => (u.key === key ? { ...u, error: err.message } : u)) })));
  }
}

/** The document items the form asks for as it stands, and whether each is required. An item a condition turns off is not sent. */
export function itemsAsked(f: IntakeForm): { item: DocumentItem; required: boolean }[] {
  return DOCUMENT_ITEMS
    .filter(({ item }) => (item !== 'HISTORICAL_FINANCIALS' || !f.noFullYearYet)
      && (item !== 'CONVERTIBLE_AGREEMENTS' || f.convertiblesOutstanding === 'YES')
      && (item !== 'PROJECTIONS' || f.projections === 'FILE'))
    .map(({ item }) => ({ item, required: item !== 'PRIOR_VALUATIONS' || f.last409a === 'DATE' }));
}

export const documentsOf = (f: IntakeForm): { item: DocumentItem; documentId: string }[] =>
  itemsAsked(f).flatMap(({ item }) => (f.documents[item] ?? []).map((d) => ({ item, documentId: d.id })));

// --- Numbers as people type them ------------------------------------------------
// The parsers in format.ts give 0 for text they cannot read, so whether an amount
// was answered is decided here: the text reads as a number, and a typed 0 counts.

/**
 * The server's bounds: the most options a company could plan to grant, the most
 * shares in one sale, and the most any amount can be, in cents or, for a price
 * per share, in micro-cents. Past them the server refuses the request.
 */
const OPTIONS_MAX = 10_000_000_000;
const SHARES_MAX = 1e13;
const MONEY_MAX = 1e15;

const withoutSign = (s: string): string => s.split(currencySymbol()).join('');
const readsAsMoney = (s: string): boolean =>
  /^-?(\d+\.?\d*|\.\d+)[kmb]?$/.test(withoutSign(s).trim().toLowerCase().replace(/[$,\s]/g, ''));
const readsAsPPS = (s: string): boolean => {
  const raw = withoutSign(s).trim().replace(/[$,\s]/g, '');
  return raw !== '' && Number.isFinite(Number(raw));
};
const readsAsShares = (s: string): boolean => {
  const raw = s.replace(/[,\s]/g, '');
  return raw !== '' && Number.isFinite(Number(raw));
};
const percentOf = (s: string): number => Number(s.replace(/[%\s]/g, ''));
/** Whole amounts without the cents, the way people say them: "$1,200,000". */
const moneyWords = (cents: number): string => money(cents, { decimals: cents % 100 === 0 ? 0 : 2 });

const shiftDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// --- The rules -------------------------------------------------------------------

/** Problems by question. A row's problems are keyed by its list, its row and its field: "expenses.r12.market". */
export type Problems = Record<string, string>;

export type StepId = 'valuation' | 'documents' | 'people' | 'transactions' | 'contact';

export const STEPS: { id: StepId; title: string; intro: string }[] = [
  { id: 'valuation', title: 'The valuation', intro: 'When to value the stock as of, and what the company is planning.' },
  { id: 'documents', title: 'Documents', intro: `Upload each one, or choose it from the vault. Uploads are filed in the vault under “${UPLOAD_FOLDER}”.` },
  { id: 'people', title: 'People', intro: 'Who runs the company, and whether anyone has worked for less than the market pays.' },
  { id: 'transactions', title: 'Transactions', intro: 'Stock that changed hands, and costs the books carry below what they are worth.' },
  { id: 'contact', title: 'Software and contact', intro: 'What you keep the books in, and who the team should call.' },
];

const STEP_OF: Record<string, StepId> = {
  valuationDateKind: 'valuation', valuationDate: 'valuation', companySize: 'valuation', stage: 'valuation',
  plans: 'valuation', optionsToGrant: 'valuation', last409a: 'valuation', last409aDate: 'valuation',
  documents: 'documents', noFullYearYet: 'documents', convertiblesOutstanding: 'documents', projections: 'documents', guidance: 'documents',
  capTableConfirmed: 'documents',
  management: 'people', sweatEquity: 'people', sweatEquityPeople: 'people',
  secondary: 'transactions', secondaryTransactions: 'transactions', belowMarketExpenses: 'transactions', expenses: 'transactions',
  software: 'contact', contactEmail: 'contact', contactPhone: 'contact',
};
export const stepOf = (key: string): StepId => STEP_OF[key.split('.')[0]] ?? 'contact';

/** Whether any problem sits at one of these questions or inside one of these lists. */
const has = (p: Problems, ...keys: string[]): boolean =>
  Object.keys(p).some((x) => keys.some((k) => x === k || x.startsWith(`${k}.`)));

const MISSING: Record<DocumentItem, string> = {
  HISTORICAL_FINANCIALS: 'Attach the financial statements, or tick that the company has not finished a financial year yet.',
  YTD_FINANCIALS: 'Attach the year-to-date financial statements.',
  PITCH_DECK: 'Attach the pitch deck or a company presentation.',
  PRIOR_VALUATIONS: 'Attach the report of the last 409A.',
  CHARTER: 'Attach the certificate of incorporation.',
  CONVERTIBLE_AGREEMENTS: 'Attach the SAFE and note agreements.',
  PROJECTIONS: 'Attach the projections, or give guidance instead.',
};

const SINGLE_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** The contact's email and phone, checked as the server checks them. Also used when they are changed later. */
export function contactProblemsOf(c: { contactEmail: string; contactPhone: string }): { contactEmail?: string; contactPhone?: string } {
  const p: { contactEmail?: string; contactPhone?: string } = {};
  const email = c.contactEmail.trim();
  const phone = c.contactPhone.trim();
  if (!SINGLE_ADDRESS.test(email)) p.contactEmail = 'Enter one email address.';
  else if (email.length > 254) p.contactEmail = 'Keep it to 254 characters.';
  const digits = phone.replace(/\D/g, '').length;
  if (!phone) p.contactPhone = 'Enter a phone number.';
  else if (phone.length > 40) p.contactPhone = 'Keep it to 40 characters.';
  else if (!/^\+?[\d\s().-]+$/.test(phone)) p.contactPhone = 'Use digits, spaces and + ( ) - . only.';
  else if (digits < 7 || digits > 15) p.contactPhone = 'Enter between 7 and 15 digits.';
  return p;
}

const isBlank = (...values: string[]): boolean => values.every((v) => !v.trim());
const blankSweatRow = (r: SweatRow): boolean => isBlank(r.name, r.title, r.from, r.to, r.timePercent, r.marketSalary, r.salaryReceived);
const blankSecondaryRow = (r: SecondaryRow): boolean =>
  isBlank(r.securityType, r.date, r.shares, r.pricePerShare, r.priceRationale, r.rationale, r.buyer, r.seller, r.expectRepeat);
const blankExpenseRow = (r: ExpenseRow): boolean => isBlank(r.nature, r.recorded, r.market);
const blankManagementRow = (r: ManagementRow): boolean => isBlank(r.name, r.title);

/** A line of text: required, and no longer than the server keeps. */
function line(p: Problems, key: string, text: string, max: number, missing: string): void {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) p[key] = missing;
  else if (t.length > max) p[key] = `Keep it to ${max} characters.`;
}

/** An amount of money: required, readable, and within the server's bounds. */
function amount(p: Problems, key: string, text: string, missing: string, { min = 0, max = MONEY_MAX } = {}): void {
  const t = text.trim();
  if (!t) { p[key] = missing; return; }
  if (!readsAsMoney(t)) { p[key] = `Enter an amount, such as ${amountHint(250_000)} or 1.2m.`; return; }
  const cents = parseMoney(t);
  // A loss can go below zero, but no further than the server takes, and then it is too big, not negative.
  if (cents < 0 && min >= 0) p[key] = 'It cannot be negative.';
  else if (cents > max || cents < min) p[key] = 'Enter a smaller amount.';
}

/**
 * The server's checks, made here too so each problem shows at its question.
 * A row nothing was typed into is left out rather than flagged, so an extra
 * empty row is not a problem; a "yes" with no filled row is. With the checklist,
 * the answers are also checked against the company's records, as the server
 * checks them: shares on the cap table, the SAFEs and notes it shows, and a full
 * financial year since incorporation.
 */
export function problemsOf(f: IntakeForm, c: Checklist | null = null): Problems {
  const p: Problems = {};
  const now = today();

  // The valuation
  if (!f.valuationDateKind) p.valuationDateKind = 'Choose one.';
  else if (f.valuationDateKind === 'DATE') {
    if (!f.valuationDate) p.valuationDate = 'Enter the date to value the common stock as of.';
    else if (f.valuationDate < shiftDays(now, -365) || f.valuationDate > shiftDays(now, 365)) p.valuationDate = 'Choose a date within a year of today.';
  }
  if (!f.companySize) p.companySize = 'Choose one.';
  if (!f.stage) p.stage = 'Choose one.';
  if (!f.plans) p.plans = 'Choose one.';
  const granted = f.optionsToGrant.trim();
  if (!granted) p.optionsToGrant = 'Enter a number. A ballpark is fine, and 0 if none are planned.';
  else if (!readsAsShares(granted) || !Number.isInteger(parseShares(granted)) || parseShares(granted) < 0) {
    p.optionsToGrant = 'Enter a whole number of options, such as 250,000.';
  } else if (parseShares(granted) > OPTIONS_MAX) p.optionsToGrant = `Enter at most ${shares(OPTIONS_MAX)}.`;
  if (!f.last409a) p.last409a = 'Choose one.';
  else if (f.last409a === 'DATE' && !f.last409aDate) p.last409aDate = 'Enter the date it was valued as of.';
  else if (f.last409a === 'DATE' && f.last409aDate > now) p.last409aDate = 'It cannot be in the future.';

  // Documents
  for (const { item, required } of itemsAsked(f)) {
    const n = (f.documents[item] ?? []).length;
    if (f.uploads.some((u) => u.item === item && u.error == null)) p[`documents.${item}`] = 'Wait for the upload to finish.';
    else if (required && n === 0) p[`documents.${item}`] = MISSING[item];
    else if (n > MAX_PER_ITEM) p[`documents.${item}`] = `Attach at most ${MAX_PER_ITEM} documents here.`;
  }
  if (documentsOf(f).length > MAX_DOCUMENTS) p.documents = `Attach at most ${MAX_DOCUMENTS} documents in all.`;
  if (f.noFullYearYet && c?.finishedFullYear && c.incorporationDate) {
    p.noFullYearYet = `The company was incorporated on ${date(c.incorporationDate)}, so it has finished a financial year. Untick this and attach the historical statements, or correct the incorporation date in the company settings.`;
  }
  const safes = c?.convertiblesOutstanding ?? 0;
  if (!f.convertiblesOutstanding) p.convertiblesOutstanding = 'Say whether any SAFEs or convertible notes are outstanding.';
  else if (f.convertiblesOutstanding === 'NO' && safes > 0) {
    p.convertiblesOutstanding = `Your cap table shows ${safes === 1 ? 'one SAFE or note' : `${safes} SAFEs or notes`} outstanding. Answer yes and attach ${safes === 1 ? 'its agreement' : 'their agreements'}, or update the cap table first.`;
  }
  if (!f.projections) p.projections = 'Choose one.';
  else if (f.projections === 'GUIDANCE') {
    const start = Number(f.guidanceStart);
    const year = thisYear();
    if (f.guidance.length < 2 || f.guidance.length > 3) p.guidance = 'Give two or three years.';
    if (!Number.isInteger(start) || start < year - 1 || start + f.guidance.length - 1 > year + 10) {
      p['guidance.start'] = 'Start from last year at the earliest, and end within ten years.';
    }
    for (const g of f.guidance) {
      amount(p, `guidance.${g.key}.revenue`, g.revenue, 'Enter the revenue.');
      amount(p, `guidance.${g.key}.ebitda`, g.ebitda, 'Enter the EBITDA. A loss is fine, with a minus sign.', { min: -MONEY_MAX });
    }
  }
  if (c?.sharesOutstanding === 0) p.capTableConfirmed = 'Your cap table has no shares outstanding yet. Add the company’s shareholdings and option grants first.';
  else if (!f.capTableConfirmed) p.capTableConfirmed = 'Confirm the cap table and option ledger are up to date.';

  // People
  const team = f.management.filter((r) => !blankManagementRow(r));
  if (team.length === 0) p.management = 'List at least one person on the management team, with their title.';
  else if (team.length > 30) p.management = 'List at most 30 people.';
  for (const r of team) {
    line(p, `management.${r.key}.name`, r.name, 200, 'Enter their name.');
    line(p, `management.${r.key}.title`, r.title, 200, 'Enter their title.');
  }
  if (!f.sweatEquity) p.sweatEquity = 'Say whether anyone has taken a below-market salary.';
  else if (f.sweatEquity === 'YES') {
    const people = f.sweatEquityPeople.filter((r) => !blankSweatRow(r));
    if (people.length === 0) p.sweatEquityPeople = 'Add each person who took a below-market salary.';
    else if (people.length > 20) p.sweatEquityPeople = 'List at most 20 people.';
    for (const r of people) {
      const k = `sweatEquityPeople.${r.key}`;
      line(p, `${k}.name`, r.name, 200, 'Enter their name.');
      line(p, `${k}.title`, r.title, 200, 'Enter their title.');
      if (!r.from) p[`${k}.from`] = 'Enter when it started.';
      else if (r.from > now) p[`${k}.from`] = 'It cannot be in the future.';
      if (!r.ongoing) {
        if (!r.to) p[`${k}.to`] = 'Enter when it ended, or tick that it still is the case.';
        else if (r.to > now) p[`${k}.to`] = 'It cannot be in the future.';
        else if (r.from && r.to < r.from) p[`${k}.to`] = 'It cannot end before it started.';
      }
      const share = percentOf(r.timePercent);
      if (!r.timePercent.trim()) p[`${k}.timePercent`] = 'Enter the share of each working day.';
      else if (!Number.isInteger(share) || share < 1 || share > 100) p[`${k}.timePercent`] = 'Enter a whole number from 1 to 100.';
      amount(p, `${k}.marketSalary`, r.marketSalary, 'Enter what the market pays for the role, a year.');
      amount(p, `${k}.salaryReceived`, r.salaryReceived, 'Enter the total received since the company started. 0 is fine.');
    }
  }

  // Transactions
  if (!f.secondary) p.secondary = 'Say whether there has been a secondary transaction in the company’s stock.';
  else if (f.secondary === 'YES') {
    const sales = f.secondaryTransactions.filter((r) => !blankSecondaryRow(r));
    if (sales.length === 0) p.secondaryTransactions = 'Add each secondary transaction.';
    else if (sales.length > 20) p.secondaryTransactions = 'List at most 20 transactions.';
    const types = config.valuationDesk.intake.securityTypes;
    for (const r of sales) {
      const k = `secondaryTransactions.${r.key}`;
      if (!types.some((t) => t.value === r.securityType)) p[`${k}.securityType`] = 'Choose the security.';
      if (r.date && r.date > now) p[`${k}.date`] = 'It cannot be in the future.';
      const n = parseShares(r.shares);
      if (!r.shares.trim()) p[`${k}.shares`] = 'Give the number of shares.';
      else if (!readsAsShares(r.shares) || !Number.isInteger(n) || n < 1) p[`${k}.shares`] = 'Enter a whole number of shares, at least 1.';
      else if (n > SHARES_MAX) p[`${k}.shares`] = 'Enter a smaller number of shares.';
      if (!r.pricePerShare.trim()) p[`${k}.pricePerShare`] = 'Give the price per share.';
      else if (!readsAsPPS(r.pricePerShare) || parsePPS(r.pricePerShare) < 0) p[`${k}.pricePerShare`] = 'Enter a price, such as 1.25.';
      else if (parsePPS(r.pricePerShare) > MONEY_MAX) p[`${k}.pricePerShare`] = 'Enter a smaller price.';
      line(p, `${k}.priceRationale`, r.priceRationale, 1000, 'Say how the price was set.');
      line(p, `${k}.rationale`, r.rationale, 1000, 'Say why it happened.');
      line(p, `${k}.buyer`, r.buyer, 200, 'Say who bought, as a role such as a new investor.');
      line(p, `${k}.seller`, r.seller, 200, 'Say who sold, as a role such as a co-founder.');
      if (!r.expectRepeat) p[`${k}.expectRepeat`] = 'Choose one.';
    }
  }
  if (!f.belowMarketExpenses) p.belowMarketExpenses = 'Say whether any operating expenses are recorded below market rates.';
  else if (f.belowMarketExpenses === 'YES') {
    const costs = f.expenses.filter((r) => !blankExpenseRow(r));
    if (costs.length === 0) p.expenses = 'Add each expense recorded below market rates.';
    else if (costs.length > 20) p.expenses = 'List at most 20 expenses.';
    for (const r of costs) {
      const k = `expenses.${r.key}`;
      line(p, `${k}.nature`, r.nature, 500, 'Say what the expense is.');
      amount(p, `${k}.recorded`, r.recorded, 'Enter the amount recorded in the books a year. 0 is fine.');
      amount(p, `${k}.market`, r.market, 'Enter the market rate a year.');
    }
  }

  // Software and contact
  // The common answers are added by a click, which a text box's own limit does not stop.
  if (!f.software.trim()) p.software = 'Say what you use, even if it is spreadsheets.';
  else if (f.software.trim().length > 200) p.software = 'Keep it to 200 characters.';
  Object.assign(p, contactProblemsOf(f));
  return p;
}

/**
 * One entry per required question, for the progress bar. The count follows the
 * conditions: a "yes" adds the question it opens, and ticking that there is no
 * full financial year yet puts that answer in place of the historical statements.
 */
export function questionsOf(f: IntakeForm, p: Problems): { step: StepId; done: boolean }[] {
  const q = (step: StepId, ...keys: string[]) => ({ step, done: !has(p, ...keys) });
  return [
    q('valuation', 'valuationDateKind', 'valuationDate'), q('valuation', 'companySize'), q('valuation', 'stage'),
    q('valuation', 'plans'), q('valuation', 'optionsToGrant'), q('valuation', 'last409a', 'last409aDate'),
    ...itemsAsked(f).filter((i) => i.required).map(({ item }) => q('documents', `documents.${item}`)),
    ...(f.noFullYearYet ? [q('documents', 'noFullYearYet')] : []),
    q('documents', 'convertiblesOutstanding'), q('documents', 'projections'),
    ...(f.projections === 'GUIDANCE' ? [q('documents', 'guidance')] : []),
    q('documents', 'capTableConfirmed'),
    q('people', 'management'), q('people', 'sweatEquity'),
    ...(f.sweatEquity === 'YES' ? [q('people', 'sweatEquityPeople')] : []),
    q('transactions', 'secondary'), ...(f.secondary === 'YES' ? [q('transactions', 'secondaryTransactions')] : []),
    q('transactions', 'belowMarketExpenses'), ...(f.belowMarketExpenses === 'YES' ? [q('transactions', 'expenses')] : []),
    q('contact', 'software'), q('contact', 'contactEmail'), q('contact', 'contactPhone'),
  ];
}

/**
 * The request as the server takes it. A "no" sends no rows, and a row nothing was
 * typed into is left out. A question not answered goes as null, and so does a
 * number that does not read as one, rather than as a "no" or the 0 the parsers
 * give, so the server refuses it too and stays the judge of what is complete.
 */
export function intakeBody(f: IntakeForm) {
  const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ');
  const start = Number(f.guidanceStart);
  const answer = (v: YesNo): boolean | null => (v === '' ? null : v === 'YES');
  const cents = (t: string): number | null => (readsAsMoney(t.trim()) ? parseMoney(t) : null);
  const count = (t: string): number | null => (readsAsShares(t) ? parseShares(t) : null);
  return {
    companySize: f.companySize, stage: f.stage, plans: f.plans,
    plansTiming: f.plans && f.plans !== 'NEITHER' ? f.plansTiming || null : null,
    last409a: f.last409a, last409aDate: f.last409a === 'DATE' ? f.last409aDate : null,
    valuationDateKind: f.valuationDateKind, valuationDate: f.valuationDateKind === 'DATE' ? f.valuationDate : null,
    optionsToGrant: count(f.optionsToGrant),
    noFullYearYet: f.noFullYearYet,
    capTableConfirmed: f.capTableConfirmed,
    management: f.management.filter((r) => !blankManagementRow(r)).map((r) => ({ name: oneLine(r.name), title: oneLine(r.title) })),
    convertiblesOutstanding: answer(f.convertiblesOutstanding),
    projections: f.projections,
    guidance: f.projections === 'GUIDANCE'
      ? f.guidance.map((g, i) => ({ year: start + i, revenue: cents(g.revenue), ebitda: cents(g.ebitda) })) : [],
    secondary: answer(f.secondary),
    secondaryTransactions: f.secondary === 'YES' ? f.secondaryTransactions.filter((r) => !blankSecondaryRow(r)).map((r) => ({
      securityType: r.securityType, date: r.date || null, shares: count(r.shares),
      pricePerShare: readsAsPPS(r.pricePerShare) ? parsePPS(r.pricePerShare) : null,
      priceRationale: r.priceRationale.trim(), rationale: r.rationale.trim(), buyer: oneLine(r.buyer), seller: oneLine(r.seller),
      expectRepeat: answer(r.expectRepeat),
    })) : [],
    sweatEquity: answer(f.sweatEquity),
    sweatEquityPeople: f.sweatEquity === 'YES' ? f.sweatEquityPeople.filter((r) => !blankSweatRow(r)).map((r) => ({
      name: oneLine(r.name), title: oneLine(r.title), from: r.from, to: r.ongoing ? null : r.to,
      timePercent: r.timePercent.trim() ? percentOf(r.timePercent) : null,
      marketSalary: cents(r.marketSalary), salaryReceived: cents(r.salaryReceived),
    })) : [],
    belowMarketExpenses: answer(f.belowMarketExpenses),
    expenses: f.belowMarketExpenses === 'YES' ? f.expenses.filter((r) => !blankExpenseRow(r)).map((r) => ({
      nature: oneLine(r.nature), recorded: cents(r.recorded), market: cents(r.market),
    })) : [],
    documents: documentsOf(f),
    software: f.software.trim(), contactName: f.contactName.trim() || null,
    contactEmail: f.contactEmail.trim(), contactPhone: f.contactPhone.trim(), notes: f.notes.trim() || null,
  };
}

// --- Building blocks, shared by every step -----------------------------------------

/** One part of the request form: an icon, a short title, and a tick that pops in once it is answered. */
export function Section({ icon, title, done, delay, required, children }: {
  icon: IconName; title: string; done: boolean; delay: number;
  /** Marks a part that is one required answer, such as a single document, the way a required field is marked. */
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rise rounded-xl border border-ink-200/80 p-4" style={{ animationDelay: `${delay}ms` }}>
      <h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink-900">
        <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg transition-colors duration-300',
          done ? 'bg-secondary-100 text-secondary-700' : 'bg-brand-50 text-brand-600')}>
          <Icon name={done ? 'check' : icon} className={cx('size-4', done && 'pop')} key={done ? 'done' : 'todo'} />
        </span>
        <span>{title}{required && <span className="ml-0.5 text-red-500" aria-hidden>*</span>}</span>
        <span className="sr-only">{required ? ', required' : ''}{done ? ', answered' : ''}</span>
      </h4>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export type Option = [value: string, label: string, icon?: IconName];

/** The mark a required question carries, the same as a required field's, and said aloud since the star is not. */
const RequiredMark = () => <><span className="ml-0.5 text-red-500" aria-hidden>*</span><span className="sr-only">, required</span></>;

/**
 * A question answered by picking one option. Native radio buttons underneath, so
 * the arrow keys move between options and a screen reader announces the group
 * with its question; on top, pills for short answers and tiles with an icon for
 * the ones worth a picture. The group is described by its explanation and its
 * problem, so both are read when the keyboard enters it.
 */
export function OptionGroup({ legend, note, description, name, options, value, onChange, error, required, variant = 'pill' }: {
  legend: string; note?: string; description?: React.ReactNode; name: string; options: Option[]; value: string;
  onChange: (v: string) => void; error?: string; required?: boolean; variant?: 'pill' | 'tile';
}) {
  const id = useId();
  const describedBy = [description ? `${id}-about` : null, error ? `${id}-problem` : null].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset aria-describedby={describedBy}>
      <legend className="text-[13px] font-medium text-ink-800">
        {legend}{required && <RequiredMark />}{note && <span className="ml-1.5 font-normal text-ink-400">{note}</span>}
      </legend>
      {description && <p id={`${id}-about`} className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{description}</p>}
      <div className={cx('mt-2', variant === 'tile' ? 'grid grid-cols-2 gap-2 sm:grid-cols-4' : 'flex flex-wrap gap-1.5')}>
        {options.map(([v, label, icon]) => {
          const on = value === v;
          return (
            <label key={v} className={cx(
              'relative flex cursor-pointer select-none items-center border text-[13px] transition-all duration-200',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
              variant === 'tile'
                ? 'flex-col justify-center gap-1.5 rounded-xl px-2 py-3 text-center motion-safe:hover:-translate-y-0.5'
                : 'gap-1.5 rounded-full px-3 py-1.5',
              on ? 'border-brand-500 bg-brand-50 font-medium text-brand-800 shadow-sm' : 'border-ink-200 text-ink-700 hover:border-ink-300 hover:bg-ink-50')}>
              <input type="radio" name={name} value={v} checked={on} onChange={() => onChange(v)} className="sr-only" />
              {icon && <Icon name={icon} className={cx(variant === 'tile' ? 'size-5' : 'size-3.5', on ? 'text-brand-600' : 'text-ink-400')} />}
              {label}
              {on && variant === 'pill' && <Icon name="check" className="pop size-3.5 text-brand-600" />}
              {on && variant === 'tile' && (
                <span className="pop absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-brand-600 text-white">
                  <Icon name="check" className="size-2.5" />
                </span>
              )}
            </label>
          );
        })}
      </div>
      {error && <p id={`${id}-problem`} className="mt-1.5 text-[12px] text-red-600">{error}</p>}
    </fieldset>
  );
}

/**
 * Opens smoothly when its question applies, and is out of reach of the keyboard
 * while closed. It goes in the same box as its question, with its own top
 * padding, so a closed one leaves no gap in a spaced list.
 */
export function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={cx('grid transition-[grid-template-rows,opacity] duration-300 ease-out', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
      inert={!open}>
      <div className="relative min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** A text box with an icon in it, so the label above it can stay a single word. */
export function IconInput({ icon, ...rest }: { icon: IconName } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <Icon name={icon} className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
      <Input {...rest} className="pl-9" />
    </div>
  );
}

/**
 * A labelled answer with its problem under it, marked so Next and Send can scroll
 * to the first one and put the cursor in it. The problem is the control's
 * description and the control is marked invalid, so a screen reader reads what
 * is wrong with the label when the cursor lands there, rather than a burst of
 * announcements as every problem on the step appears at once.
 */
function Ask({ label, required, hint, error, className, children }: {
  label: React.ReactNode; required?: boolean; hint?: React.ReactNode; error?: string; className?: string; children: React.ReactNode;
}) {
  const id = useId();
  const control = error && isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, { 'aria-invalid': true, 'aria-describedby': `${id}-problem` })
    : children;
  return (
    <div className={cx('min-w-0', className)} data-problem={error ? '' : undefined}>
      <Field label={label} required={required} hint={hint}>{control}</Field>
      {error && <p id={`${id}-problem`} className="mt-1 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}

/**
 * A checkbox that is a required answer, or one an answer can be wrong about.
 * The shared checkbox takes no description, so its problem goes in place of its
 * hint, inside its label, and is read with the box all the same.
 */
function CheckAsk({ label, hint, required, checked, onChange, error }: {
  label: React.ReactNode; hint?: React.ReactNode; required?: boolean; checked: boolean; onChange: (v: boolean) => void; error?: string;
}) {
  return (
    <div data-problem={error ? '' : undefined}>
      <Checkbox checked={checked} onChange={onChange} label={<>{label}{required && <RequiredMark />}</>}
        hint={error ? <span className="text-red-600">{error}</span> : hint} />
    </div>
  );
}

const READERS = {
  money: (t: string) => (readsAsMoney(t) ? moneyWords(parseMoney(t)) : null),
  pps: (t: string) => (readsAsPPS(t) ? pps(parsePPS(t)) : null),
  shares: (t: string) => (readsAsShares(t) ? shares(parseShares(t)) : null),
};

/**
 * A number typed the way people type it ("1.2m", "$450,000", "250,000"), with
 * what it was read as underneath, so a slip of a zero shows before it is sent.
 */
function NumberAsk({ kind, label, value, onChange, error, hint, placeholder, required = true }: {
  kind: keyof typeof READERS; label: string; value: string; onChange: (v: string) => void;
  error?: string; hint?: string; placeholder?: string; required?: boolean;
}) {
  const read = value.trim() ? READERS[kind](value.trim()) : null;
  return (
    <Ask label={label} required={required} error={error} hint={[read && `Reads as ${read}`, hint].filter(Boolean).join('. ') || undefined}>
      <Input inputMode={kind === 'shares' ? 'numeric' : 'decimal'} value={value} autoComplete="off"
        onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </Ask>
  );
}

const YES_NO: Option[] = [['YES', 'Yes'], ['NO', 'No']];

/**
 * A yes or no the request always asks. `lastTime` is the last request's answer,
 * said beside the question rather than filled in, so it is answered afresh.
 */
function YesNoQuestion({ legend, description, name, value, onChange, error, lastTime }: {
  legend: string; description?: React.ReactNode; name: string; value: YesNo; onChange: (v: YesNo) => void; error?: string; lastTime?: boolean;
}) {
  const said = lastTime == null ? null : `Your last request said ${lastTime ? 'yes' : 'no'}.`;
  return (
    <div data-problem={error ? '' : undefined}>
      <OptionGroup legend={legend} required name={name} options={YES_NO} value={value}
        description={said ? <>{description}{description ? ' ' : ''}<span className="font-medium text-ink-600">{said}</span></> : description}
        onChange={(v) => onChange(v as YesNo)} error={error} />
    </div>
  );
}

/**
 * A list filled in row by row. Each row is a group with its own legend, so a
 * screen reader hears "Person 2" before its fields, and its remove button says
 * which row it removes. A new row takes the cursor; a removed one hands it to
 * the add button, so the keyboard is never left on nothing. A problem with the
 * list as a whole describes its first row, which is where Next puts the cursor.
 * `removable` limits which rows can go, for a list whose rows are numbered by
 * position, such as consecutive years.
 */
function Rows<T extends { key: string }>({ rows, noun, title, add, max, min = 1, onAdd, onRemove, error, removable, children }: {
  rows: T[]; noun: string; title?: (i: number) => string; add: string; max: number; min?: number;
  onAdd: () => void; onRemove: (key: string) => void; error?: string; removable?: (i: number) => boolean;
  children: (row: T, i: number) => React.ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const moved = useRef<'added' | 'removed' | null>(null);
  useEffect(() => {
    const what = moved.current;
    moved.current = null;
    if (what === 'added') {
      // The row's own group, not a question group inside an earlier row.
      list.current?.querySelector<HTMLElement>(':scope > fieldset:last-of-type')?.querySelector<HTMLElement>('input, textarea')?.focus();
    } else if (what === 'removed') {
      list.current?.querySelector<HTMLElement>('[data-add]')?.focus();
    }
  }, [rows.length]);
  const name = (i: number) => (title ? title(i) : `${noun} ${i + 1}`);
  return (
    <div ref={list} className="space-y-3" data-problem={error ? '' : undefined}>
      {rows.map((r, i) => (
        <fieldset key={r.key} className="rise min-w-0 rounded-lg border border-ink-200 bg-ink-50/40 p-3"
          aria-describedby={error && i === 0 ? `${id}-problem` : undefined}>
          <legend className="sr-only">{name(i)}</legend>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span aria-hidden className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{name(i)}</span>
            {rows.length > min && (removable?.(i) ?? true) && (
              <button type="button" onClick={() => { moved.current = 'removed'; onRemove(r.key); }} aria-label={`Remove ${name(i).toLowerCase()}`}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800">
                <Icon name="trash" className="size-3.5" /> Remove
              </button>
            )}
          </div>
          <div className="space-y-3">{children(r, i)}</div>
        </fieldset>
      ))}
      {error && <p id={`${id}-problem`} className="text-[12px] text-red-600">{error}</p>}
      {rows.length < max && (
        <button type="button" data-add onClick={() => { moved.current = 'added'; onAdd(); }}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700">
          <Icon name="plus" className="size-3.5" /> {add}
        </button>
      )}
    </div>
  );
}

type Lists = Pick<IntakeForm, 'management' | 'guidance' | 'secondaryTransactions' | 'sweatEquityPeople' | 'expenses'>;

/** Change, add and remove rows of one list, by the row's key. */
function rowsOf<K extends keyof Lists>(update: Update, list: K, blank: () => Lists[K][number]) {
  type Row = Lists[K][number];
  const map = (f: IntakeForm, fn: (rows: Row[]) => Row[]): IntakeForm => ({ ...f, [list]: fn(f[list] as Row[]) }) as IntakeForm;
  return {
    edit: (key: string, patch: Partial<Row>) => update((f) => map(f, (rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))),
    add: () => update((f) => map(f, (rows) => [...rows, blank()])),
    remove: (key: string) => update((f) => map(f, (rows) => rows.filter((r) => r.key !== key))),
  };
}

const fileSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/**
 * One document the appraiser asks for: what it is, what to send, what is
 * attached so far, and the two ways to add more. Uploads start the moment files
 * are chosen, each with its own spinner and its own error, so one refused file
 * does not hold up the others, and each one stored is announced, since the
 * spinner turning into a row says nothing to a screen reader. A button that
 * takes its own row away (remove, dismiss, a suggestion once attached) hands
 * the cursor to the card's vault button, so the keyboard never falls out of the
 * dialog to the page behind it.
 */
function DocumentItemCard({ item, required, documents, uploads, suggestions, error, showLabel = true, onUpload, onChooseVault, onAttach, onRemove, onDismiss }: {
  item: DocumentItem; required: boolean; documents: AttachedDocument[]; uploads: Upload[]; suggestions: ChecklistDocument[];
  error?: string; showLabel?: boolean;
  onUpload: (files: File[]) => void; onChooseVault: () => void; onAttach: (d: ChecklistDocument) => void;
  onRemove: (id: string) => void; onDismiss: (key: string) => void;
}) {
  const info = INFO[item];
  const id = useId();
  const offered = suggestions.filter((s) => !documents.some((d) => d.id === s.id));
  const full = documents.length >= MAX_PER_ITEM;
  const box = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  /** Runs a change that takes the pressed button away, and moves the cursor once the card has redrawn. */
  const thenRefocus = (fn: () => void) => () => { refocus.current = true; fn(); };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    // A card that just filled up has no vault button, so its first remaining button instead.
    (box.current?.querySelector<HTMLElement>('[data-vault]') ?? box.current?.querySelector<HTMLElement>('button'))?.focus();
  });
  // An upload that leaves the list without an error was stored: a failed one stays, with its error, until dismissed.
  const [stored, setStored] = useState('');
  const pending = useRef<Upload[]>([]);
  const uploadState = uploads.map((u) => `${u.key}${u.error == null ? '' : '!'}`).join(' ');
  useEffect(() => {
    const done = pending.current.filter((u) => u.error == null && !uploads.some((x) => x.key === u.key));
    pending.current = uploads;
    if (done.length) setStored(done.length === 1 ? `${done[0].name} uploaded.` : `${done.length} files uploaded.`);
  }, [uploadState]); // eslint-disable-line react-hooks/exhaustive-deps
  const problemId = error ? `${id}-problem` : undefined;
  return (
    <div ref={box} data-item={item} data-problem={error ? '' : undefined} className={cx('min-w-0', showLabel && 'rounded-lg border border-ink-200 p-3')}>
      {showLabel && (
        <h5 className="flex flex-wrap items-center gap-x-2 text-[13px] font-medium text-ink-800">
          {info.label}
          {required
            ? <><span className="-ml-1.5 text-red-500" aria-hidden>*</span><span className="sr-only">, required</span></>
            : <span className="text-[12px] font-normal text-ink-400">optional</span>}
        </h5>
      )}
      <p className="text-[12px] leading-relaxed text-ink-500">
        {info.guidance}{!showLabel && !required && ' Optional.'}
      </p>

      {(documents.length > 0 || uploads.length > 0) && (
        <ul className="mt-2 space-y-1.5" aria-label={`Attached for ${info.label.toLowerCase()}`}>
          {documents.map((d) => (
            <li key={d.id} className="rise flex items-center gap-2.5 rounded-lg bg-ink-50 px-2.5 py-2">
              <Icon name="document" className="size-4 shrink-0 text-brand-600" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink-900" title={d.name}>{d.name}</span>
                <span className="block truncate text-[11px] text-ink-500">
                  {[d.sizeBytes ? fileSize(d.sizeBytes) : null, d.note].filter(Boolean).join(' · ')}
                </span>
              </span>
              <button type="button" onClick={thenRefocus(() => onRemove(d.id))} aria-label={`Remove ${d.name}`} title="Remove"
                className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                <Icon name="trash" className="size-4" />
              </button>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.key} className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-2', u.error ? 'bg-red-50' : 'bg-ink-50')}>
              {u.error ? <Icon name="alert" className="size-4 shrink-0 text-red-500" /> : <Spinner className="size-4 shrink-0 text-brand-600" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink-900" title={u.name}>{u.name}</span>
                {u.error
                  ? <span className="block text-[11px] text-red-700" role="alert">Not uploaded. {u.error}</span>
                  : <span className="block text-[11px] text-ink-500">Uploading · {fileSize(u.size)}</span>}
              </span>
              {u.error && (
                <button type="button" onClick={thenRefocus(() => onDismiss(u.key))} aria-label={`Dismiss ${u.name}`} title="Dismiss"
                  className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-red-100 hover:text-red-700">
                  <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" /></svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {offered.length > 0 && !full && (
        <ul className="mt-2 space-y-1.5" aria-label="Suggested from the vault">
          {offered.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={thenRefocus(() => onAttach(s))}
                aria-label={`Attach ${s.name}: ${s.source === 'LAST_REQUEST' ? 'the one sent last time' : SOURCE_NOTE[s.source]}`}
                className="flex w-full items-start gap-2 rounded-lg border border-dashed border-ink-300 px-2.5 py-2 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/50">
                <Icon name="plus" className="mt-0.5 size-3.5 shrink-0 text-brand-600" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-brand-700">
                    {s.source === 'LAST_REQUEST' ? 'Use the one sent last time' : SOURCE_NOTE[s.source]}
                  </span>
                  <span className="block truncate text-[12px] text-ink-700" title={s.name}>{s.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!full && (
        <div className="mt-2 flex flex-wrap gap-2">
          {/* The input stays in the tab order, visually hidden rather than removed, so
              the file chooser opens from the keyboard and Next can put focus on it. */}
          <label className="cursor-pointer">
            <input type="file" multiple className="peer sr-only" aria-label={`Upload files: ${info.label}`} aria-describedby={problemId}
              onChange={(e) => { if (e.target.files?.length) onUpload(Array.from(e.target.files)); e.target.value = ''; }} />
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2.5 text-[13px] font-medium text-ink-800 shadow-sm hover:bg-ink-50 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500">
              <Icon name="download" className="size-4 rotate-180" /> Upload files
            </span>
          </label>
          <Button size="sm" variant="secondary" icon={<Icon name="search" className="size-4" />} data-vault="" onClick={onChooseVault}
            aria-label={`Choose from the vault: ${info.label}`} aria-describedby={problemId}>
            Choose from the vault
          </Button>
        </div>
      )}
      {error && <p id={problemId} className="mt-1.5 text-[12px] text-red-600">{error}</p>}
      <p className="sr-only" role="status">{stored}</p>
    </div>
  );
}

// --- The steps ---------------------------------------------------------------------

export interface StepProps {
  form: IntakeForm;
  update: Update;
  /** Every problem, for the tick on each part. */
  problems: Problems;
  /** The problems to show: those on the steps Next or Send has checked. */
  shown: Problems;
}

const setter = (update: Update) => <K extends keyof IntakeForm>(k: K, v: IntakeForm[K]) => update((f) => ({ ...f, [k]: v }));

type Choice = PublicConfig['valuationDesk']['intake']['companySizes'][number];
// Short labels: the question above each group already says what is being asked.
const options = (choices: Choice[], icons?: Record<string, IconName>, fallback?: IconName): Option[] =>
  choices.map((c) => [c.value, c.shortLabel, icons ? icons[c.value] ?? fallback : undefined]);
const SIZES = options(config.valuationDesk.intake.companySizes);
const STAGES = options(config.valuationDesk.intake.stages);
// The plans are tiles, so each has a picture; an answer added in the param file gets a plain one.
const PLANS = options(config.valuationDesk.intake.plans, { OPTIONS: 'award', FINANCING: 'trending', BOTH: 'layers', NEITHER: 'clock' }, 'target');
const TIMINGS = options(config.valuationDesk.intake.planTimings);
const SECURITIES = options(config.valuationDesk.intake.securityTypes);
// The form's own logic, so not a setting: the server takes these values only.
const LAST_409A: Option[] = [['DATE', 'We had one', 'calendar'], ['NEVER', 'Never', 'sparkle'], ['UNKNOWN', 'Not sure', 'help']];
const VALUATION_DATE: Option[] = [['LATEST', 'The most recent date', 'clock'], ['DATE', 'A specific date', 'calendar']];
const PROJECTIONS: Option[] = [['FILE', 'Attach projections', 'document'], ['GUIDANCE', 'Give revenue and EBITDA guidance instead', 'chart']];

/** Step 1: the date to value the stock as of, the company, what it plans, and its last 409A. */
export function ValuationStep({ form, update, problems, shown, fromRecords }: StepProps & {
  /** The effective date of the 409A on file, so the form can say where a prefilled date came from. */
  fromRecords: string | null;
}) {
  const set = setter(update);
  const now = today();
  const granted = form.optionsToGrant.trim();
  return (
    <>
      <Section icon="calendar" title="Valuation date" done={!has(problems, 'valuationDateKind', 'valuationDate')} delay={60}>
        <div>
          <div data-problem={shown.valuationDateKind ? '' : undefined}>
            <OptionGroup legend="What date should the common stock be valued as of?" name="valuationDateKind" variant="pill" required
              description="A report holds for twelve months, or until something significant happens, such as a funding round."
              value={form.valuationDateKind} onChange={(v) => set('valuationDateKind', v as IntakeForm['valuationDateKind'])}
              error={shown.valuationDateKind} options={VALUATION_DATE} />
          </div>
          <Reveal open={form.valuationDateKind === 'DATE'}>
            <Ask className="max-w-xs pt-3" label="Value it as of" required error={shown.valuationDate}>
              <Input type="date" value={form.valuationDate} min={shiftDays(now, -365)} max={shiftDays(now, 365)}
                onChange={(e) => set('valuationDate', e.target.value)} />
            </Ask>
          </Reveal>
        </div>
      </Section>

      <Section icon="users" title="Company" done={!has(problems, 'companySize', 'stage')} delay={120}>
        <div data-problem={shown.companySize ? '' : undefined}>
          <OptionGroup legend="Team size" note="incl. founders and contractors" name="companySize" required value={form.companySize}
            onChange={(v) => set('companySize', v)} error={shown.companySize} options={SIZES} />
        </div>
        <div data-problem={shown.stage ? '' : undefined}>
          <OptionGroup legend="Stage" name="stage" required value={form.stage} onChange={(v) => set('stage', v)} error={shown.stage} options={STAGES} />
        </div>
      </Section>

      <Section icon="target" title="Coming up" done={!has(problems, 'plans', 'optionsToGrant')} delay={180}>
        <div>
          <div data-problem={shown.plans ? '' : undefined}>
            <OptionGroup legend="Granting options or closing a round soon?" name="plans" variant="tile" required value={form.plans}
              onChange={(v) => set('plans', v)} error={shown.plans} options={PLANS} />
          </div>
          <Reveal open={!!form.plans && form.plans !== 'NEITHER'}>
            <div className="pt-3">
              <OptionGroup legend="How soon?" note="optional" name="plansTiming" value={form.plansTiming} onChange={(v) => set('plansTiming', v)} options={TIMINGS} />
            </div>
          </Reveal>
        </div>
        <Ask className="max-w-xs" label="Options to grant in the next 6 to 12 months" required error={shown.optionsToGrant}
          hint={[granted && readsAsShares(granted) ? `Reads as ${shares(parseShares(granted))}` : null, 'A ballpark is fine, and 0 if none are planned'].filter(Boolean).join('. ')}>
          <Input inputMode="numeric" value={form.optionsToGrant} autoComplete="off" placeholder="e.g. 250,000"
            onChange={(e) => set('optionsToGrant', e.target.value)} />
        </Ask>
      </Section>

      <Section icon="shield" title="Last 409A" done={!has(problems, 'last409a', 'last409aDate')} delay={240}>
        <div>
          <div data-problem={shown.last409a ? '' : undefined}>
            <OptionGroup legend="When was it?" name="last409a" variant="tile" required value={form.last409a}
              onChange={(v) => set('last409a', v as IntakeForm['last409a'])} error={shown.last409a} options={LAST_409A} />
          </div>
          <Reveal open={form.last409a === 'DATE'}>
            <Ask className="max-w-xs pt-3" label="Valued as of" required error={shown.last409aDate}
              hint={fromRecords && form.last409aDate === fromRecords ? 'From your records' : undefined}>
              <Input type="date" value={form.last409aDate} max={now} onChange={(e) => set('last409aDate', e.target.value)} />
            </Ask>
          </Reveal>
        </div>
      </Section>
    </>
  );
}

/** "Dec 31", for the fiscal year end the company is set up with. */
const monthDay = (mmdd: string): string => {
  const d = new Date(`2000-${mmdd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? mmdd : d.toLocaleDateString(config.locale.locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * Revenue and EBITDA for two or three years, for a company with no projections
 * to attach. Only the first year is chosen: the others follow it, so the years
 * are consecutive by construction rather than by a rule to trip over. For the
 * same reason only the first and the last year can be removed, and removing the
 * first moves the start on a year, so every year left keeps its own figures.
 */
function GuidanceEditor({ form, update, shown, fiscalYearEnd }: Pick<StepProps, 'form' | 'update' | 'shown'> & { fiscalYearEnd: string | null }) {
  const set = setter(update);
  const rows = rowsOf(update, 'guidance', blankGuidance);
  const year = thisYear();
  const start = Number(form.guidanceStart);
  // One year past the latest start three years can have, so the start left by removing the first year is always on the list.
  const years = Array.from({ length: 11 }, (_, i) => year - 1 + i);
  const remove = (key: string) => update((f) => ({
    ...f,
    guidanceStart: f.guidance[0]?.key === key ? String(Number(f.guidanceStart) + 1) : f.guidanceStart,
    guidance: f.guidance.filter((g) => g.key !== key),
  }));
  return (
    <div className="space-y-3 pt-3">
      <Ask className="max-w-xs" label="First fiscal year" required error={shown['guidance.start']}
        hint={fiscalYearEnd ? `Each year ends on ${monthDay(fiscalYearEnd)}, the company’s fiscal year end.` : undefined}>
        <Select value={form.guidanceStart} onChange={(e) => set('guidanceStart', e.target.value)}>
          {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
        </Select>
      </Ask>
      <Rows rows={form.guidance} noun="Year" title={(i) => `Fiscal year ${start + i}`} add={`Add ${start + form.guidance.length}`}
        min={2} max={3} onAdd={rows.add} onRemove={remove} error={shown.guidance}
        removable={(i) => i === 0 || i === form.guidance.length - 1}>
        {(g) => (
          <FormGrid>
            <NumberAsk kind="money" label="Revenue" value={g.revenue} error={shown[`guidance.${g.key}.revenue`]}
              placeholder={amountHint(1_200_000)} onChange={(v) => rows.edit(g.key, { revenue: v })} />
            <NumberAsk kind="money" label="EBITDA" value={g.ebitda} error={shown[`guidance.${g.key}.ebitda`]}
              hint="A loss is fine, with a minus sign" placeholder={`-${amountHint(300_000)}`} onChange={(v) => rows.edit(g.key, { ebitda: v })} />
          </FormGrid>
        )}
      </Rows>
    </div>
  );
}

/**
 * Step 2: the documents, with the questions that decide which are needed: no
 * full financial year yet, SAFEs or notes outstanding, and projections or
 * guidance. The cap table and option ledger are not asked for, because the app
 * sends them; what is asked is that someone confirms they are current.
 */
export function DocumentsStep({ form, update, problems, shown, checklist, checklistError, onChooseVault, onDownloadWorkbook }: StepProps & {
  checklist: Checklist | null;
  checklistError: string | null;
  onChooseVault: (item: DocumentItem) => void;
  onDownloadWorkbook: () => void;
}) {
  const { companyId } = useSession();
  const set = setter(update);
  const asked = itemsAsked(form);
  const required = (item: DocumentItem) => asked.find((a) => a.item === item)?.required ?? false;
  const card = (item: DocumentItem, showLabel = true) => (
    <DocumentItemCard item={item} required={required(item)} showLabel={showLabel}
      documents={form.documents[item] ?? []} uploads={form.uploads.filter((u) => u.item === item)}
      suggestions={checklist?.suggestions[item] ?? []} error={shown[`documents.${item}`]}
      onUpload={(files) => companyId && uploadForItem(companyId, item, files, update)}
      onChooseVault={() => onChooseVault(item)}
      onAttach={(s) => update((f) => attach(f, item, [fromSuggestion(s)]))}
      onRemove={(id) => update((f) => ({ ...f, documents: { ...f.documents, [item]: (f.documents[item] ?? []).filter((d) => d.id !== id) } }))}
      onDismiss={(key) => update((f) => ({ ...f, uploads: f.uploads.filter((u) => u.key !== key) }))} />
  );
  const outstanding = checklist?.convertiblesOutstanding ?? null;
  return (
    <>
      {checklistError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          What the vault already holds could not be looked up, so nothing is suggested. You can still upload each document or choose it from the vault.
        </p>
      )}
      {shown.documents && <p className="text-[12px] text-red-600" data-problem="">{shown.documents}</p>}

      <Section icon="ledger" title="Financial statements" done={!has(problems, 'noFullYearYet', 'documents.HISTORICAL_FINANCIALS', 'documents.YTD_FINANCIALS')} delay={60}>
        <div>
          <CheckAsk checked={form.noFullYearYet} onChange={(v) => set('noFullYearYet', v)} error={shown.noFullYearYet}
            label="The company has not finished a financial year yet" hint="Then the year-to-date statements are all the appraiser needs." />
          <Reveal open={!form.noFullYearYet}><div className="pt-3">{card('HISTORICAL_FINANCIALS')}</div></Reveal>
        </div>
        {card('YTD_FINANCIALS')}
      </Section>

      <Section icon="megaphone" title={itemLabel('PITCH_DECK')} required done={!has(problems, 'documents.PITCH_DECK')} delay={120}>
        {card('PITCH_DECK', false)}
      </Section>

      <Section icon="history" title={itemLabel('PRIOR_VALUATIONS')} required={required('PRIOR_VALUATIONS')}
        done={!has(problems, 'documents.PRIOR_VALUATIONS')} delay={180}>
        {card('PRIOR_VALUATIONS', false)}
      </Section>

      <Section icon="gavel" title={itemLabel('CHARTER')} required done={!has(problems, 'documents.CHARTER')} delay={240}>
        {card('CHARTER', false)}
      </Section>

      <Section icon="convert" title="SAFEs and convertible notes" done={!has(problems, 'convertiblesOutstanding', 'documents.CONVERTIBLE_AGREEMENTS')} delay={300}>
        <div>
          <YesNoQuestion legend="Any SAFEs or convertible notes outstanding?" name="convertiblesOutstanding"
            description={outstanding == null ? undefined
              : `From your cap table: ${outstanding === 0 ? 'none' : outstanding} outstanding.`}
            value={form.convertiblesOutstanding} onChange={(v) => set('convertiblesOutstanding', v)} error={shown.convertiblesOutstanding} />
          <Reveal open={form.convertiblesOutstanding === 'YES'}><div className="pt-3">{card('CONVERTIBLE_AGREEMENTS')}</div></Reveal>
        </div>
      </Section>

      <Section icon="trending" title="Projections" done={!has(problems, 'projections', 'guidance', 'documents.PROJECTIONS')} delay={360}>
        <div>
          <div data-problem={shown.projections ? '' : undefined}>
            <OptionGroup legend="Projections for the next three to five years" name="projections" required value={form.projections}
              description="If you have none, the revenue and EBITDA you expect for the next two to three years will do."
              onChange={(v) => set('projections', v as IntakeForm['projections'])} error={shown.projections} options={PROJECTIONS} />
          </div>
          <Reveal open={form.projections === 'FILE'}><div className="pt-3">{card('PROJECTIONS')}</div></Reveal>
          <Reveal open={form.projections === 'GUIDANCE'}>
            <GuidanceEditor form={form} update={update} shown={shown} fiscalYearEnd={checklist?.fiscalYearEnd ?? null} />
          </Reveal>
        </div>
      </Section>

      <Section icon="table" title="Cap table and option ledger" done={!has(problems, 'capTableConfirmed')} delay={420}>
        <p className="text-[13px] leading-relaxed text-ink-700">
          Included automatically: the capital structure and option ledger from your cap table, with each option’s exercise price
          and no holder names.{' '}
          <button type="button" onClick={onDownloadWorkbook} className="font-medium text-brand-600 hover:text-brand-700">
            Download the workbook to check it
          </button>
          . If something is missing, fix it on the cap table first: what you have entered here is kept.
        </p>
        {checklist?.sharesOutstanding === 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900">
            Your cap table has no shares on it yet, so there is no capital structure to send.{' '}
            <Link to="/certificates" className="font-medium underline underline-offset-2">Add the company’s shareholdings</Link>{' '}
            and option grants first.
          </p>
        )}
        <CheckAsk checked={form.capTableConfirmed} onChange={(v) => set('capTableConfirmed', v)} required error={shown.capTableConfirmed}
          label="The cap table and option ledger here are up to date" />
      </Section>
    </>
  );
}

/** Step 3: who runs the company, and anyone who has worked for less than the market pays. */
export function PeopleStep({ form, update, problems, shown }: StepProps) {
  const set = setter(update);
  const team = rowsOf(update, 'management', blankManagement);
  const people = rowsOf(update, 'sweatEquityPeople', blankSweat);
  const now = today();
  return (
    <>
      <Section icon="users" title="Management team" done={!has(problems, 'management')} delay={60}>
        <p className="text-[12px] leading-relaxed text-ink-500">The people who run the company, and their titles.</p>
        <Rows rows={form.management} noun="Person" add="Add a person" max={30} onAdd={team.add} onRemove={team.remove} error={shown.management}>
          {(r) => (
            <FormGrid>
              <Ask label="Name" required error={shown[`management.${r.key}.name`]}>
                <Input value={r.name} maxLength={200} autoComplete="off" placeholder="e.g. Jordan Vale" onChange={(e) => team.edit(r.key, { name: e.target.value })} />
              </Ask>
              <Ask label="Title" required error={shown[`management.${r.key}.title`]}>
                <Input value={r.title} maxLength={200} autoComplete="off" placeholder="e.g. Chief executive" onChange={(e) => team.edit(r.key, { title: e.target.value })} />
              </Ask>
            </FormGrid>
          )}
        </Rows>
      </Section>

      <Section icon="wallet" title="Below-market salaries" done={!has(problems, 'sweatEquity', 'sweatEquityPeople')} delay={120}>
        <div>
          <YesNoQuestion legend="Have any key people taken a below-market salary since the company started?" name="sweatEquity" lastTime={form.lastTime.sweatEquity}
            description="Common very early on, before or around an alpha or beta. The appraiser counts the pay given up as money put into the company."
            value={form.sweatEquity} onChange={(v) => set('sweatEquity', v)} error={shown.sweatEquity} />
          <Reveal open={form.sweatEquity === 'YES'}>
            <div className="pt-3">
              <Rows rows={form.sweatEquityPeople} noun="Person" add="Add a person" max={20} onAdd={people.add} onRemove={people.remove} error={shown.sweatEquityPeople}>
                {(r) => {
                  const k = `sweatEquityPeople.${r.key}`;
                  return (
                    <>
                      <FormGrid>
                        <Ask label="Name" required error={shown[`${k}.name`]}>
                          <Input value={r.name} maxLength={200} autoComplete="off" onChange={(e) => people.edit(r.key, { name: e.target.value })} />
                        </Ask>
                        <Ask label="Title" required error={shown[`${k}.title`]}>
                          <Input value={r.title} maxLength={200} autoComplete="off" onChange={(e) => people.edit(r.key, { title: e.target.value })} />
                        </Ask>
                        <Ask label="From" required error={shown[`${k}.from`]}>
                          <Input type="date" value={r.from} max={now} onChange={(e) => people.edit(r.key, { from: e.target.value })} />
                        </Ask>
                        {/* The end date comes after the box that reveals it, so unticking it puts the new field next in the tab order. */}
                        <div className="min-w-0 space-y-3">
                          <Checkbox checked={r.ongoing} onChange={(v) => people.edit(r.key, { ongoing: v })} label="Still the case today" />
                          {!r.ongoing && (
                            <Ask label="Until" required error={shown[`${k}.to`]}>
                              <Input type="date" value={r.to} min={r.from || undefined} max={now} onChange={(e) => people.edit(r.key, { to: e.target.value })} />
                            </Ask>
                          )}
                        </div>
                      </FormGrid>
                      <FormGrid columns={3}>
                        <Ask label="Time on the company" required error={shown[`${k}.timePercent`]} hint="Percent of each working day">
                          <Input inputMode="numeric" value={r.timePercent} maxLength={4} autoComplete="off" placeholder="e.g. 100"
                            onChange={(e) => people.edit(r.key, { timePercent: e.target.value })} />
                        </Ask>
                        <NumberAsk kind="money" label="Market salary a year" value={r.marketSalary} error={shown[`${k}.marketSalary`]}
                          placeholder={amountHint(180_000)} onChange={(v) => people.edit(r.key, { marketSalary: v })} />
                        <NumberAsk kind="money" label="Salary received in total" value={r.salaryReceived} error={shown[`${k}.salaryReceived`]}
                          hint="Since the company started" placeholder={amountHint(40_000)} onChange={(v) => people.edit(r.key, { salaryReceived: v })} />
                      </FormGrid>
                    </>
                  );
                }}
              </Rows>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}

/** Step 4: stock that changed hands between holders, and costs the books carry below what they are worth. */
export function TransactionsStep({ form, update, problems, shown }: StepProps) {
  const set = setter(update);
  const sales = rowsOf(update, 'secondaryTransactions', blankSecondary);
  const costs = rowsOf(update, 'expenses', blankExpense);
  const now = today();
  return (
    <>
      <Section icon="scale" title="Secondary transactions" done={!has(problems, 'secondary', 'secondaryTransactions')} delay={60}>
        <div>
          <YesNoQuestion legend="Has there been a secondary transaction in the company’s stock?" name="secondary" lastTime={form.lastTime.secondary}
            description="Such as a buyback, a sale to new investors, or a sale between existing investors."
            value={form.secondary} onChange={(v) => set('secondary', v)} error={shown.secondary} />
          <Reveal open={form.secondary === 'YES'}>
            <div className="pt-3">
              <Rows rows={form.secondaryTransactions} noun="Transaction" add="Add a transaction" max={20} onAdd={sales.add} onRemove={sales.remove}
                error={shown.secondaryTransactions}>
                {(r) => {
                  const k = `secondaryTransactions.${r.key}`;
                  return (
                    <>
                      <div data-problem={shown[`${k}.securityType`] ? '' : undefined}>
                        <OptionGroup legend="Security" name={`${r.key}-security`} required options={SECURITIES} value={r.securityType}
                          onChange={(v) => sales.edit(r.key, { securityType: v })} error={shown[`${k}.securityType`]} />
                      </div>
                      <FormGrid columns={3}>
                        <Ask label="Date" error={shown[`${k}.date`]} hint="If you know it">
                          <Input type="date" value={r.date} max={now} onChange={(e) => sales.edit(r.key, { date: e.target.value })} />
                        </Ask>
                        <NumberAsk kind="shares" label="Shares" value={r.shares} error={shown[`${k}.shares`]} placeholder="e.g. 50,000"
                          onChange={(v) => sales.edit(r.key, { shares: v })} />
                        <NumberAsk kind="pps" label="Price per share" value={r.pricePerShare} error={shown[`${k}.pricePerShare`]} placeholder="e.g. 1.25"
                          onChange={(v) => sales.edit(r.key, { pricePerShare: v })} />
                      </FormGrid>
                      <Ask label="How the price was set" required error={shown[`${k}.priceRationale`]}>
                        <Textarea rows={2} className="min-h-0" value={r.priceRationale} maxLength={1000}
                          placeholder="e.g. negotiated at a discount to the last round"
                          onChange={(e) => sales.edit(r.key, { priceRationale: e.target.value })} />
                      </Ask>
                      <Ask label="Why it happened" required error={shown[`${k}.rationale`]}>
                        <Textarea rows={2} className="min-h-0" value={r.rationale} maxLength={1000}
                          placeholder="e.g. an early employee wanted to sell part of their stake"
                          onChange={(e) => sales.edit(r.key, { rationale: e.target.value })} />
                      </Ask>
                      <FormGrid>
                        <Ask label="Buyer" required error={shown[`${k}.buyer`]} hint="A role, not a name">
                          <Input value={r.buyer} maxLength={200} autoComplete="off" placeholder="e.g. a new investor"
                            onChange={(e) => sales.edit(r.key, { buyer: e.target.value })} />
                        </Ask>
                        <Ask label="Seller" required error={shown[`${k}.seller`]} hint="A role, not a name">
                          <Input value={r.seller} maxLength={200} autoComplete="off" placeholder="e.g. a co-founder"
                            onChange={(e) => sales.edit(r.key, { seller: e.target.value })} />
                        </Ask>
                      </FormGrid>
                      <YesNoQuestion legend="Likely to happen again?" name={`${r.key}-repeat`} value={r.expectRepeat}
                        onChange={(v) => sales.edit(r.key, { expectRepeat: v })} error={shown[`${k}.expectRepeat`]} />
                    </>
                  );
                }}
              </Rows>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section icon="bank" title="Expenses below market rates" done={!has(problems, 'belowMarketExpenses', 'expenses')} delay={120}>
        <div>
          <YesNoQuestion legend="Are any operating expenses recorded below market rates?" name="belowMarketExpenses" lastTime={form.lastTime.belowMarketExpenses}
            description="For example, no rent recorded because the team works from the CEO’s home."
            value={form.belowMarketExpenses} onChange={(v) => set('belowMarketExpenses', v)} error={shown.belowMarketExpenses} />
          <Reveal open={form.belowMarketExpenses === 'YES'}>
            <div className="pt-3">
              <Rows rows={form.expenses} noun="Expense" add="Add an expense" max={20} onAdd={costs.add} onRemove={costs.remove} error={shown.expenses}>
                {(r) => {
                  const k = `expenses.${r.key}`;
                  return (
                    <>
                      <Ask label="Expense" required error={shown[`${k}.nature`]}>
                        <Input value={r.nature} maxLength={500} autoComplete="off" placeholder="e.g. office rent"
                          onChange={(e) => costs.edit(r.key, { nature: e.target.value })} />
                      </Ask>
                      {/* Both a year, like the market salary above, so an annual rent is not read as a monthly one. */}
                      <FormGrid>
                        <NumberAsk kind="money" label="Recorded in the books a year" value={r.recorded} error={shown[`${k}.recorded`]}
                          hint="0 if nothing is recorded" placeholder={amountHint(0)} onChange={(v) => costs.edit(r.key, { recorded: v })} />
                        <NumberAsk kind="money" label="Market rate a year" value={r.market} error={shown[`${k}.market`]}
                          placeholder={amountHint(36_000)} onChange={(v) => costs.edit(r.key, { market: v })} />
                      </FormGrid>
                    </>
                  );
                }}
              </Rows>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}

/** The tools most companies name, offered as one-click answers (valuationDesk.intake.softwareSuggestions). */
const SOFTWARE = config.valuationDesk.intake.softwareSuggestions;

/** Step 5: the software, who to contact, a note, and what leaves the app when it is sent. */
export function ContactStep({ form, update, problems, shown }: StepProps) {
  const { user } = useSession();
  const set = setter(update);
  const [noteOpen, setNoteOpen] = useState(false);
  const softwareList = form.software.split(/\s*(?:,|\band\b)\s*/i).map((t) => t.trim()).filter(Boolean);
  /** Adds a common tool to the answer, or takes it out again, keeping whatever else was typed. */
  const toggleSoftware = (tool: string) => {
    const on = softwareList.some((t) => t.toLowerCase() === tool.toLowerCase());
    const next = on ? softwareList.filter((t) => t.toLowerCase() !== tool.toLowerCase()) : [...softwareList, tool];
    set('software', next.join(', '));
  };
  return (
    <>
      <Section icon="layers" title="Software" done={!has(problems, 'software')} delay={60}>
        <div>
          <Ask label="Cap table and accounting" required error={shown.software}>
            <Input value={form.software} maxLength={200} onChange={(e) => set('software', e.target.value)} placeholder="Pick below or type" />
          </Ask>
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Common answers">
            {SOFTWARE.map((tool) => {
              const on = softwareList.some((t) => t.toLowerCase() === tool.toLowerCase());
              return (
                <button key={tool} type="button" aria-pressed={on} onClick={() => toggleSoftware(tool)}
                  className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-all duration-200',
                    on ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-dashed border-ink-300 text-ink-600 hover:border-ink-400 hover:bg-ink-50')}>
                  <Icon name={on ? 'check' : 'plus'} className={cx('size-3', on && 'pop')} key={on ? 'on' : 'off'} />
                  {tool}
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <Section icon="inbox" title="Contact" done={!has(problems, 'contactEmail', 'contactPhone')} delay={120}>
        <FormGrid columns={3}>
          <Field label="Name">
            <IconInput icon="users" value={form.contactName} maxLength={200} onChange={(e) => set('contactName', e.target.value)} autoComplete="name" />
          </Field>
          <Ask label="Email" required error={shown.contactEmail}>
            <IconInput icon="inbox" type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} autoComplete="email" />
          </Ask>
          <Ask label="Phone" required error={shown.contactPhone}>
            <IconInput icon="phone" type="tel" value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} autoComplete="tel" placeholder="+1 415 555 0100" />
          </Ask>
        </FormGrid>
        {!noteOpen && !form.notes ? (
          <button type="button" onClick={() => setNoteOpen(true)}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700">
            <Icon name="plus" className="size-3.5" /> Add a note
          </button>
        ) : (
          <div className="rise">
            <Field label="Note for the team">
              <Textarea rows={2} value={form.notes} maxLength={2000} autoFocus={noteOpen && !form.notes}
                onChange={(e) => set('notes', e.target.value)} placeholder="e.g. a round being negotiated, or a deadline" />
            </Field>
          </div>
        )}
      </Section>

      <p className="rise flex items-start gap-2 px-1 text-[12px] leading-relaxed text-ink-500" style={{ animationDelay: '180ms' }}>
        <Icon name="lock" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          The team gets your answers, the cap table with no holder names, and the documents you attached, as they are: a SAFE,
          for one, names its investor. A recap goes to {user?.email ?? 'your account address'}.
        </span>
      </p>
    </>
  );
}

// --- What was sent, on the company's page and the team's ---------------------------------

/**
 * The heading level a list's titles take, which depends on the page: under an
 * h4 on the company's request card, under an h2 on the team's page, so a screen
 * reader's list of headings follows the page's own order.
 */
export type HeadingLevel = 3 | 4 | 5;
const headingTag = (level: HeadingLevel) => `h${level}` as const;

/**
 * The answers that are lists, in the words the server put them in. A table of
 * two or three columns fits a phone; a wider one becomes a card per row, so a
 * secondary sale's nine answers stay readable at any width.
 */
export function AnswerTables({ tables, level = 5 }: { tables: AnswerTable[]; level?: HeadingLevel }) {
  if (tables.length === 0) return null;
  const Heading = headingTag(level);
  return (
    <div className="space-y-4">
      {tables.map((t) => (
        <div key={t.title} className="min-w-0">
          <Heading className="mb-1.5 text-[13px] font-semibold text-ink-900">{t.title}</Heading>
          {t.columns.length <= 3 ? (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr>{t.columns.map((c) => <th key={c} scope="col" className="border-b border-ink-200 py-1.5 pr-3 text-[11px] font-medium text-ink-500">{c}</th>)}</tr>
              </thead>
              <tbody>
                {t.rows.map((row, i) => (
                  <tr key={i}>
                    {t.columns.map((c, j) => <td key={c} className="break-words border-b border-ink-100 py-1.5 pr-3 align-top text-ink-900">{row[j] || '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="space-y-2">
              {t.rows.map((row, i) => (
                <li key={i} className="rounded-lg border border-ink-200 p-3">
                  <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {t.columns.map((c, j) => (
                      <div key={c} className="min-w-0">
                        <dt className="text-[11px] text-ink-500">{c}</dt>
                        <dd className="whitespace-pre-line break-words text-[13px] text-ink-900">{row[j] || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** The documents a request hands the team, under the item each answers, in the checklist's order. */
export function RequestDocumentList({ documents, action, level = 5 }: {
  documents: RequestDocument[];
  /** What can be done with one document by whoever is reading, such as a download button. */
  action?: (d: RequestDocument) => React.ReactNode;
  level?: HeadingLevel;
}) {
  const Heading = headingTag(level);
  const order = (item: string) => { const i = DOCUMENT_ITEMS.findIndex((x) => x.item === item); return i < 0 ? DOCUMENT_ITEMS.length : i; };
  const groups = [...new Set(documents.map((d) => d.item))].sort((a, b) => order(a) - order(b))
    .map((item) => ({ item, docs: documents.filter((d) => d.item === item) }));
  return (
    <div className="space-y-3">
      {groups.map(({ item, docs }) => (
        <div key={item} className="min-w-0">
          <Heading className="mb-1.5 text-[12px] font-medium text-ink-500">{docs[0].itemLabel || itemLabel(item)}</Heading>
          <ul className="space-y-1.5">
            {docs.map((d) => (
              <li key={`${item}-${d.id}`} className="flex items-center gap-2.5 rounded-lg border border-ink-200 px-3 py-2">
                <Icon name="document" className="size-4 shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink-900" title={d.name}>{d.name}</span>
                  <span className="block text-[11px] text-ink-500">
                    {[d.sizeBytes ? fileSize(Number(d.sizeBytes)) : d.hasBody ? 'Written in the app' : null, `added ${date(d.createdAt.slice(0, 10))}`]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
                {action?.(d)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** For the vault picker: what to show first and what is already attached to an item. */
export const vaultContext = (form: IntakeForm, item: DocumentItem) => ({
  label: INFO[item].label,
  category: INFO[item].category,
  attached: (form.documents[item] ?? []).map((d) => d.id),
});

/** A document chosen from the vault, as the card lists it. */
export const fromVault = (d: { id: string; name: string; category: string; fileName: string | null; sizeBytes: number | null }): AttachedDocument =>
  ({ id: d.id, name: d.name, fileName: d.fileName, sizeBytes: d.sizeBytes, note: `From the vault · ${categoryLabel(d.category)}` });
