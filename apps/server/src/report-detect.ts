/**
 * The values a 409A report states, found in its text: the fair market value of
 * one common share, the valuation date and the valuation method; and, for the
 * company's own import of a report, the firm that prepared it and the value of
 * the company it states.
 *
 * Nothing here decides anything. Each value comes with the words it was read
 * from, the page, and how sure the reading is, so the valuation team can correct
 * it before it delivers and the company can check it against the report before
 * it records the 409A. A report that says it plainly ("the fair market value per
 * share of common stock is $0.42") is read with confidence; a price that is only
 * near the right words is offered with a warning; anything else is left for a
 * person to type.
 *
 * Reports put the same facts in sentences and in tables, so a value is judged by
 * the words in its own sentence, or its own row, and never by those around
 * another amount: a table lists the preferred price on the row above the common
 * one, and the preferred price must not win.
 *
 * Pure and deterministic: the same pages, the same day and the same names of the
 * company give the same answer.
 * The text comes from a file someone outside the company uploaded, so the work
 * is bounded whatever the text: only so much of a page and of the report is
 * read, the words around a value are looked for only so far, however long its
 * line, and only so many values are weighed on a page and in the whole report,
 * so a page stuffed with figures neither takes long nor crowds out the page that
 * states the conclusion.
 */
import { addMonths, dollarsToCents, dollarsToPPS, today } from '@kosmitor/core';

export type Confidence = 'high' | 'medium' | 'low';

/** A value read from the report, with where it came from. */
export interface Detected<T> {
  value: T;
  /** The words the value was read from, as the report has them: "$0.42", "June 30, 2026". */
  text: string;
  /** The text around it, about 160 characters, so a person can see where it came from. */
  context: string;
  /** The page it is on, counting from 1. */
  page: number;
  confidence: Confidence;
}

export interface ReportDetection {
  /** Whether the report had any text to read. A scan, or a file that could not be read, has none. */
  readable: boolean;
  /** Micro-cents per common share, like every price per share in the app. */
  fairMarketValue: Detected<number> | null;
  /** YYYY-MM-DD. */
  valuationDate: Detected<string> | null;
  /** Such as "OPM backsolve", "PWERM", "Hybrid" or "Current value method". */
  method: Detected<string> | null;
  /** The best few readings of each, best first, the chosen one included, each value once. */
  candidates: { fairMarketValue: Detected<number>[]; valuationDate: Detected<string>[] };
}

/** The value of the company a report states, in cents. */
export interface CompanyValue extends Detected<number> {
  /**
   * Which value it is: the enterprise value, or the equity value when the report
   * states no enterprise value. The two differ by the company's debt and cash.
   */
  basis: 'enterprise' | 'equity';
  /**
   * Set when the figure is from a table in thousands or millions, as its heading
   * says: the value is the figure as written times that, and `text` is as written.
   */
  units?: 'thousands' | 'millions';
}

/**
 * Everything read from a report: what the valuation team's page reads, and the
 * firm that prepared the report and the company's value, which the company's
 * own import reads as well.
 */
export interface ReportReading extends ReportDetection {
  /** The firm that prepared the report, as the report names it. Never the company it values. */
  appraiser: Detected<string> | null;
  enterpriseValue: CompanyValue | null;
}

/** What a report with nothing to read detects: nothing, said plainly. */
export const nothingDetected = (readable: boolean): ReportReading => ({
  readable, fairMarketValue: null, valuationDate: null, method: null, appraiser: null, enterpriseValue: null,
  candidates: { fairMarketValue: [], valuationDate: [] },
});

/**
 * What the valuation team's page is given, and keeps with the request: the
 * values its delivery form has always been filled from, and nothing else, so
 * what it stores and shows stays as it was before the import read more.
 */
export const deskDetection = ({ appraiser: _appraiser, enterpriseValue: _value, ...detection }: ReportReading): ReportDetection => detection;

const CANDIDATES = 5;

/**
 * How much of the text is read: the most of one page, and of the whole report. A
 * page of a report has some thousands of characters and a whole report some
 * hundreds of thousands; what goes past these is not a report's text.
 */
const PAGE_TEXT = 100_000;
const REPORT_TEXT = 2_000_000;

/**
 * The most amounts, and the most dates, weighed in one report, and the most
 * mentions of each method; and the most of each on one page, so that a page
 * stuffed with them cannot use up the report's. A report states its conclusion
 * early, and past these a page of figures is not worth the time it takes.
 */
const READINGS = 10_000;
const PAGE_READINGS = 1_000;
const MENTIONS = 1_000;
const PAGE_MENTIONS = 100;

/**
 * How far from a value its line is looked along for the line's start or end. A
 * longer line is taken as cut there, so a page with no line breaks in it costs no
 * more to read than one with them.
 */
const REACH = 400;

// --- Where a value sits ------------------------------------------------------------

/** The text around a match, cut at word boundaries, with an ellipsis where it was cut. */
function contextOf(text: string, start: number, end: number): string {
  let a = Math.max(0, start - 80);
  let b = Math.min(text.length, end + 80);
  for (let n = 0; a > 0 && n < 20 && /\S/.test(text[a - 1]); n++) a--;
  for (let n = 0; b < text.length && n < 20 && /\S/.test(text[b]); n++) b++;
  const s = text.slice(a, b).replace(/\s+/g, ' ').trim();
  return `${a > 0 ? '…' : ''}${s}${b < text.length ? '…' : ''}`;
}

/**
 * Words a full stop follows without ending the sentence. A single capital is not
 * one of them: "the Series A." ends a sentence far more often in a report than an
 * initial does.
 */
const ABBREVIATION = /(?:^|[^A-Za-z])(?:inc|co|corp|ltd|llc|no|nos|mr|ms|mrs|dr|vs|approx|est|u\.s|e\.g|i\.e|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
const SENTENCE_END = /[.!?]["'”’)\]]?\s+(?=["'“‘(]?[A-Z0-9$])/g;

/** Where the last sentence in `s` starts, or 0 when `s` is one sentence. */
function lastSentenceStart(s: string): number {
  let at = 0;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(s); m; m = SENTENCE_END.exec(s)) {
    if (!ABBREVIATION.test(s.slice(Math.max(0, m.index - 8), m.index))) at = m.index + m[0].length;
  }
  return at;
}

/** Where the first sentence in `s` ends, or its length when it does not. */
function firstSentenceEnd(s: string): number {
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(s); m; m = SENTENCE_END.exec(s)) {
    if (!ABBREVIATION.test(s.slice(Math.max(0, m.index - 8), m.index))) return m.index + 1;
  }
  return s.length;
}

/** Where the line that `at` is on starts, looking back no more than REACH characters. */
function lineStart(text: string, at: number): number {
  const from = Math.max(0, at - REACH);
  const i = text.slice(from, at).lastIndexOf('\n');
  return i < 0 ? from : from + i + 1;
}

/** Where the line that `from` is on ends, looking ahead no more than REACH characters. */
function lineEnd(text: string, from: number): number {
  const i = text.slice(from, from + REACH).indexOf('\n');
  return i < 0 ? Math.min(text.length, from + REACH) : from + i;
}

/** Whether a line ends a sentence: a full stop that is not an abbreviation's, or a question or exclamation mark. */
function endsSentence(line: string): boolean {
  const m = line.match(/([.!?])["'”’)\]]?$/);
  return !!m && (m[1] !== '.' || !ABBREVIATION.test(line.slice(0, m.index)));
}

/**
 * Whether a line runs on into the next, as one sentence a PDF has wrapped. A next
 * line that starts in lower case carries the sentence on, whatever the line before
 * ends in, a year, a date or a company's "Inc.", unless that line ended the
 * sentence. Otherwise a line that ends in a figure or a full stop is another row
 * of a table or another sentence.
 */
function runsOn(previous: string, next: string): boolean {
  if (/^[a-z]/.test(next)) return !endsSentence(previous);
  return !/[\d%.!?]$/.test(previous);
}

/**
 * The words before a value that belong to it: its own line, and the lines before
 * when the sentence runs on from them; never anything at or before `floor`, where
 * the amount before this one ends.
 */
function wordsBefore(text: string, at: number, floor: number): string {
  let start = lineStart(text, at);
  for (let lines = 0; lines < 2 && start > 0 && start > floor && at - start < 200; lines++) {
    const previousStart = lineStart(text, start - 1);
    const previous = text.slice(previousStart, start - 1).trimEnd();
    if (!previous || !runsOn(previous, text.slice(start, start + 1))) break;
    start = previousStart;
  }
  const s = text.slice(Math.max(start, floor, at - 240), at);
  return s.slice(lastSentenceStart(s));
}

/**
 * The words after a value that belong to it: the rest of its clause, running on
 * to the next line only when that line carries on the sentence in lower case, and
 * never past `ceiling`, where the next amount starts.
 */
function wordsAfter(text: string, end: number, ceiling: number, clause: boolean): string {
  let stop = lineEnd(text, end);
  if (stop < ceiling && stop - end < 120 && !/[.!?]\s*$/.test(text.slice(end, stop)) && /^[a-z(]/.test(text.slice(stop + 1, stop + 2))) {
    stop = lineEnd(text, stop + 1);
  }
  let s = text.slice(end, Math.min(stop, ceiling, end + 160));
  s = s.slice(0, firstSentenceEnd(s));
  // Only the clause the value is in: after a comma the sentence is often about something else.
  if (clause) s = s.split(/[,;]/)[0];
  return s;
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

// --- The fair market value ---------------------------------------------------------

/** An amount in dollars: $0.42, $ 1.07, US$0.89, USD 0.89, $1,250.00. */
const MONEY = /(?:\bUS\s?\$|\bUSD\s?|\$)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d,]\d)/g;
/** An amount in millions or thousands is a company's value, not a share's. */
const SCALED = /^\s?(?:million|billion|thousand|mm|bn|m|k|b)\b/i;

const WORDS_FOR: [RegExp, number][] = [
  [/fair market value|\bfmv\b/, 5],
  [/conclu(?:ded|sion|de|ding)/, 3],
  [/common (?:stock|shares?)/, 3],
  [/per (?:common )?share|\/\s?share\b|per sh\b/, 2],
  [/non-? ?marketable|\bdlom\b/, 2],
  [/minority/, 1],
  [/409a/, 1],
];
const WORDS_AGAINST: [RegExp, number][] = [
  [/preferred/, 4],
  [/\bseries (?:[a-z]\d?|seed)\b/, 4],
  [/liquidation preference/, 4],
  [/enterprise/, 4],
  [/equity value|total equity|market capitali[sz]ation/, 4],
  [/\b(?:million|billion|thousand)\b/, 3],
  [/(?:original )?issue price|valuation cap|post-money|pre-money/, 3],
  [/prior|previous|last (?:409a|valuation)|earlier/, 3],
  [/exercise price|strike price|option price|par value/, 3],
  [/revenue|ebitda|cash|debt|proceeds|invest(?:ed|ment)|raised|salary|fee/, 2],
];

interface Scored<T> extends Detected<T> { score: number; at: number }

/** How likely an amount is to be the fair market value of a common share, from the words with it. */
function scoreAmount(before: string, after: string, dollars: number, scaled: boolean): { score: number; confidence: Confidence } {
  const all = flat(`${before} ${after}`);
  // Words right by the amount count in full against it; further back, half, since a
  // sentence can mention the preferred stock before it comes to the common.
  const near = flat(`${before.slice(-60)} ${after}`);
  let score = 0;
  for (const [re, weight] of WORDS_FOR) if (re.test(all)) score += weight;
  let against = false;
  for (const [re, weight] of WORDS_AGAINST) {
    if (re.test(near)) { score -= weight; against = true; } else if (re.test(all)) score -= weight / 2;
  }
  if (scaled) score -= 8;
  if (dollars > 1000) score -= 8;   // a share of a private company's common stock rarely costs this much
  const strong = !against && !scaled && dollars <= 1000 && (
    (/fair market value|\bfmv\b/.test(all) && /common (?:stock|shares?)/.test(all) && /per (?:common )?share|\/\s?share\b/.test(all))
    || (/conclu/.test(all) && /per common share|common (?:stock|shares?)/.test(all) && /per (?:common )?share/.test(all)));
  return { score, confidence: strong && score >= 8 ? 'high' : score >= 5 ? 'medium' : 'low' };
}

/** Between the two amounts of a change: "from $0.25 per share to $0.42", or "$0.42 from $0.25". */
const CHANGE_TO = /^\s*(?:per (?:common )?share\s*)?to\s*$/i;
const CHANGE_FROM = /^\s*(?:per (?:common )?share\s*)?from\s*$/i;
/** Between the amounts of a list: "$1.62 and $0.42", "$1.62, $0.80 and $0.42", each perhaps "per share". */
const LIST_JOIN = /^\s*(?:per (?:common )?share\s*)?(?:,\s*(?:and\s+)?|and\s+)$/i;
/** What ends a list whose amounts go, in order, with the classes named before it. */
const RESPECTIVELY = /^\s*(?:per (?:common )?share\s*)?,?\s*respectively\b/i;
/** A class of stock a sentence names: the common, or a series or class of preferred. */
const CLASS = /\bcommon (?:stock|shares?)\b|\bseries (?:seed|[a-z]\d?)\b(?: (?:convertible )?preferred)?(?: (?:stock|shares?))?|\b(?:seed )?preferred (?:stock|shares?)\b/gi;

const SURER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function readAmounts(pages: string[]): Scored<number>[] {
  const found: Scored<number>[] = [];
  let left = READINGS;
  pages.forEach((text, p) => {
    const amounts: { m: RegExpMatchArray; start: number; end: number }[] = [];
    for (const m of text.matchAll(MONEY)) {
      if (amounts.length >= Math.min(left, PAGE_READINGS)) break;
      amounts.push({ m, start: m.index!, end: m.index! + m[0].length });
    }
    left -= amounts.length;
    const between = (i: number): string => (i + 1 < amounts.length ? text.slice(amounts[i].end, amounts[i + 1].start) : '');
    const floorOf = (i: number): number => (i > 0 ? amounts[i - 1].end : 0);
    const ceilingOf = (i: number): number => (i + 1 < amounts.length ? amounts[i + 1].start : text.length);
    const afterFrom = (i: number): boolean => /\bfrom\s*$/i.test(text.slice(Math.max(0, amounts[i].start - 12), amounts[i].start));

    // "The Series A Preferred and the Common Stock are $1.62 and $0.42, respectively":
    // the amounts of such a list go with the classes named before it, in order.
    const listOf = new Map<number, number[]>();
    for (let i = 0; i < amounts.length; i++) {
      let j = i;
      while (j + 1 < amounts.length && LIST_JOIN.test(between(j))) j++;
      if (j > i && RESPECTIVELY.test(text.slice(amounts[j].end, amounts[j].end + 40))) {
        const list = Array.from({ length: j - i + 1 }, (_, n) => i + n);
        for (const n of list) listOf.set(n, list);
      }
      i = j;
    }

    amounts.forEach(({ m, start, end }, i) => {
      const dollars = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1_000_000) return;
      const scaled = SCALED.test(text.slice(end, end + 12));
      let before: string;
      let after: string;
      let penalty = 0;
      let surest: Confidence = 'high';
      const list = listOf.get(i);
      if (list) {
        // Every amount of the list has the words before the list, and when the
        // classes named there pair off with the amounts, each is judged by its own
        // class alone, with the others taken out of its words. Two prices in one
        // clause are never read with full confidence.
        before = wordsBefore(text, amounts[list[0]].start, floorOf(list[0]));
        after = wordsAfter(text, amounts[list.at(-1)!].end, ceilingOf(list.at(-1)!), true);
        const classes = [...before.matchAll(CLASS)];
        const own = list.indexOf(i);
        if (classes.length === list.length) {
          before = classes.reduceRight((s, c, n) => (n === own ? s : `${s.slice(0, c.index)} ${s.slice(c.index! + c[0].length)}`), before);
          surest = 'medium';
        } else surest = 'low';
      } else {
        // A change, "from $0.25 per share to $0.42 per share": the first amount is
        // where the value was, so it counts against itself, and the second, where it
        // is now, has the words before both.
        const was = (CHANGE_TO.test(between(i)) && afterFrom(i)) || (i > 0 && CHANGE_FROM.test(between(i - 1)));
        const now = i > 0 && CHANGE_TO.test(between(i - 1)) && afterFrom(i - 1);
        before = wordsBefore(text, start, now ? floorOf(i - 1) : floorOf(i));
        after = wordsAfter(text, end, ceilingOf(i), true);
        if (was) { penalty = 6; surest = 'low'; }
      }
      const scored = scoreAmount(before, after, dollars, scaled);
      const score = scored.score - penalty;
      if (score < 2) return;
      const confidence = SURER[scored.confidence] > SURER[surest] ? surest : scored.confidence;
      found.push({ value: dollarsToPPS(dollars), text: m[0].trim(), context: contextOf(text, start, end), page: p + 1, confidence, score, at: start });
    });
  });
  return found;
}

// --- The valuation date ------------------------------------------------------------

const MONTHS = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** June 30, 2026 · Jun. 30, 2026 · 30 June 2026 · 06/30/2026 · 2026-06-30. */
const DATE = new RegExp(
  `\\b${MONTHS}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`
  + `|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS}\\.?,?\\s+(\\d{4})\\b`
  + '|\\b(\\d{1,2})([/.-])(\\d{1,2})\\8(\\d{4})\\b'
  + '|\\b(\\d{4})-(\\d{2})-(\\d{2})\\b', 'gi');
const MONTH_NUMBER = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A real date as YYYY-MM-DD, or null for one that is not (June 31). */
function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 ? d.toISOString().slice(0, 10) : null;
}

function dateOf(m: RegExpMatchArray): string | null {
  const month = (name: string) => MONTH_NUMBER.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  if (m[1]) return isoDate(Number(m[3]), month(m[1]), Number(m[2]));
  if (m[5]) return isoDate(Number(m[6]), month(m[5]), Number(m[4]));
  if (m[7]) {
    // Month first, as American reports write it, unless the first number cannot be a month.
    const [a, b] = [Number(m[7]), Number(m[9])];
    return a > 12 && b <= 12 ? isoDate(Number(m[10]), b, a) : isoDate(Number(m[10]), a, b);
  }
  return isoDate(Number(m[11]), Number(m[12]), Number(m[13]));
}

/** What a date's label says about it: "Valuation Date:" right before it is the surest. */
const DATE_LABELS: { re: RegExp; score: number; confidence: Confidence }[] = [
  { re: /valuation date\s*(?:is|was|of)?\s*[:\-–—]?\s*$/, score: 12, confidence: 'high' },
  { re: /date of (?:the |this |our )?(?:valuation|appraisal)\s*(?:is|was)?\s*[:\-–—]?\s*$/, score: 11, confidence: 'high' },
  { re: /(?:effective|measurement) date\s*(?:is|was|of)?\s*[:\-–—]?\s*$/, score: 9, confidence: 'medium' },
  { re: /valuation date\b.{0,40}$/, score: 8, confidence: 'medium' },
  { re: /(?:effective|measurement) date\b.{0,40}$/, score: 6, confidence: 'medium' },
  { re: /\bas (?:of|at)\s*(?:the close of business on\s*)?$/, score: 4, confidence: 'low' },
];
/** "As of" also dates balance sheets and cap tables, which are not the valuation date. */
const NOT_THE_VALUATION = /capitali[sz]ation|cap table|balance sheet|financial statements|fiscal|year ended|months ended|outstanding|report date|dated|issued|signed|incorporat/;

function readDates(pages: string[], asOf: string): Scored<string>[] {
  const earliest = addMonths(asOf, -18);
  const found: Scored<string>[] = [];
  let left = READINGS;
  pages.forEach((text, p) => {
    let previousEnd = 0;
    let onPage = 0;
    for (const m of text.matchAll(DATE)) {
      if (left <= 0 || onPage >= PAGE_READINGS) return;
      left--;
      onPage++;
      const start = m.index!;
      const end = start + m[0].length;
      const before = flat(text.slice(Math.max(previousEnd, start - 60), start));
      previousEnd = end;
      const value = dateOf(m);
      // A report values the stock as of a day that has passed, and one older than
      // eighteen months is an earlier valuation the report refers to.
      if (!value || value > asOf || value < earliest) continue;
      const label = DATE_LABELS.find((l) => l.re.test(before));
      if (!label) continue;
      const score = label.score - (label.confidence === 'low' && NOT_THE_VALUATION.test(before) ? 3 : 0);
      if (score < 2) continue;
      found.push({ value, text: m[0], context: contextOf(text, start, end), page: p + 1, confidence: label.confidence, score, at: start });
    }
  });
  return found;
}

// --- The method ------------------------------------------------------------------

/** The methods, the most specific first, which is also the order a tie goes in. Acronyms are matched in capitals only. */
const METHODS: { value: string; patterns: RegExp[] }[] = [
  { value: 'OPM backsolve', patterns: [/\bback-?\s?solve[ds]?\b/gi] },
  { value: 'Hybrid', patterns: [/\bhybrid (?:method|approach|model)\b/gi] },
  { value: 'PWERM', patterns: [/\bPWERM\b/g, /\bprobability[- ]weighted expected return/gi] },
  { value: 'Current value method', patterns: [/\bcurrent[- ]value method\b/gi, /\bCVM\b/g] },
  { value: 'Option pricing method', patterns: [/\boption[- ]pricing (?:method|model)\b/gi, /\bOPM\b/g] },
  { value: 'Income approach (DCF)', patterns: [/\bincome approach\b/gi, /\bdiscounted cash flows?\b/gi, /\bDCF\b/g] },
  { value: 'Market approach', patterns: [/\bmarket approach\b/gi, /\bguideline public compan(?:y|ies)\b/gi, /\bguideline (?:company|transactions?) method\b/gi] },
  { value: 'Asset approach', patterns: [/\basset approach\b/gi, /\bcost approach\b/gi] },
];
/**
 * What says the report relied on a method: the appraiser saying it chose it, in
 * the first person or in the past tense of what was done, or the report naming it
 * as its primary method or its conclusion. A verb alone, "is used to allocate" or
 * "applies", only describes a method, as every report's account of the methods
 * does, and is not taken for a choice.
 */
const RELIED_ON = new RegExp([
  String.raw`\b(?:we|our)\b.{0,80}?\b(?:relied|rel(?:y|ies)|select(?:ed|s)?|utili[sz](?:ed|es)?|use[ds]?|appl(?:ied|y|ies)|employ(?:ed|s)?|adopt(?:ed|s)?|cho(?:se|sen))\b`,
  String.raw`\b(?:was|were|has been|have been)\s+(?:\w+\s+)?(?:relied|selected|utili[sz]ed|used|applied|employed|adopted|chosen|allocated using)\b`,
  String.raw`\b(?:relied|primary|conclu\w*)\b`,
].join('|'));
const SET_ASIDE = /\b(?:not|no weight|rejected|considered but|excluded|inappropriate|instead of)\b/;

/**
 * How much the mentions of a method count: one the report relied on far more
 * than any number of passing ones, which a report's description of the methods
 * and its glossary are full of, and one it set aside against it.
 */
const RELIED_WEIGHT = 6;
const MENTIONS_COUNTED = 3;
const SET_ASIDE_WEIGHT = 3;

function readMethod(pages: string[]): Detected<string> | null {
  const totals = METHODS.map(() => ({ score: 0, relied: 0, mentioned: 0, setAside: 0, best: null as (Scored<string> & { relied: boolean }) | null }));
  METHODS.forEach((method, n) => {
    const t = totals[n];
    let left = MENTIONS;
    pages.forEach((text, p) => {
      let onPage = 0;
      for (const re of method.patterns) {
        for (const m of text.matchAll(re)) {
          if (left <= 0 || onPage >= PAGE_MENTIONS) return;
          left--;
          onPage++;
          const start = m.index!;
          const end = start + m[0].length;
          // The sentence without the method's own name, which can carry a word such as "weighted".
          const sentence = flat(`${wordsBefore(text, start, 0)} ${wordsAfter(text, end, text.length, false)}`);
          const setAside = SET_ASIDE.test(sentence);
          const relied = !setAside && RELIED_ON.test(sentence);
          if (setAside) t.setAside++;
          else if (relied) t.relied++;
          else t.mentioned++;
          const score = setAside ? -1 : relied ? 2 : 1;
          if (!t.best || score > t.best.score) {
            t.best = { value: method.value, text: m[0], context: contextOf(text, start, end), page: p + 1, confidence: 'low', score, at: start, relied };
          }
        }
      }
    });
    t.score = RELIED_WEIGHT * t.relied + Math.min(MENTIONS_COUNTED, t.mentioned) - SET_ASIDE_WEIGHT * t.setAside;
  });
  // A backsolve is the option pricing method calibrated to a round, so the mentions of the one support the other.
  const backsolve = totals[0];
  const opm = totals[METHODS.findIndex((m) => m.value === 'Option pricing method')];
  if (backsolve.score > 0 && opm.score > 0) backsolve.score += opm.score / 2;

  const ranked = totals.map((t, n) => ({ ...t, n })).filter((t) => t.best && t.score > 0)
    .sort((a, b) => b.score - a.score || a.n - b.n);
  if (!ranked.length) return null;
  const [first, second] = ranked;
  const best = first.best!;
  const margin = first.score - (second?.score ?? 0);
  const confidence: Confidence = best.relied && first.score >= 4 && margin >= 2 ? 'high' : best.relied || first.score >= 2 ? 'medium' : 'low';
  return { value: best.value, text: best.text, context: best.context, page: best.page, confidence };
}

// --- The appraiser ---------------------------------------------------------------
//
// A report names the firm that prepared it on its cover ("Prepared by"), in the
// letter that opens it ("Harbor Lane Valuation Partners, LLC ("we") was engaged
// by the Company") and under the letter's signature. It names the company it
// values in the same places, with the same "Inc." after it, so the company's
// names are gathered first, from the words around them ("Prepared for", "the
// common stock of", "(the "Company")") and from the names the caller knows, and
// none of them is ever offered as the appraiser. A firm's name found nowhere but
// standing on a line of the cover or the letter is offered, with a warning.

/** A word of a name: capitalised, or a number, as in "Harbor", "409A", "J.P.", "O’Neil", "AT&T". */
const NAME_WORD = /^[A-Z0-9][A-Za-z0-9'’&.-]*$/;
/** What joins the words of a firm's name: "Smith & Jones", "Smith and Jones". */
const JOIN = /^(?:&|and|AND)$/;
/** Words that end a name however they are capitalised, since a cover is often in capitals: "PREPARED BY", "THE COMMON STOCK OF". */
const NOT_NAME = new Set([
  'a', 'an', 'the', 'of', 'for', 'by', 'to', 'from', 'at', 'as', 'in', 'on', 'with', 'or', 'is', 'was', 'were', 'has', 'have',
  'we', 'us', 'our', 'dear', 'attn', 'attention', 're', 'prepared', 'sincerely', 'per', 'this', 'that',
]);
/** A name of nothing but these is no firm's: "the Company", "Board of Directors", "Series A Preferred". */
const GENERIC = /^(?:the|company|management|board|directors?|client|issuer|report|valuation|appraisal|analysis|firm|appendix|exhibit|section|table|page|common|stock|preferred|series|seed|shares?|summary|date|notes?|[a-z]|[ivx]+|\d+)$/i;
/** The endings of a firm's legal name: LLC, L.L.P., Inc., Corporation, Ltd. */
const SUFFIX = String.raw`L\.?L\.?C|L\.?L\.?P|P\.?L\.?L\.?C|L\.?P|P\.?C|Inc(?:orporated)?|Corp(?:oration)?|Ltd|Limited|GmbH|plc`;
const SUFFIX_WORD = new RegExp(`^(?:${SUFFIX})\\.?$`, 'i');
const SUFFIX_AT = new RegExp(`[ \\t](?:${SUFFIX})(?![A-Za-z0-9])\\.?`, 'gi');
const SUFFIX_END = new RegExp(`,?\\s+(?:${SUFFIX})\\.?$`, 'i');
/** Words that make a name a firm's without one of those endings: "Ledgerline Valuations", "Harbor Advisors". */
const FIRM_WORD = /\b(?:valuations?|advisors?|advisers?|advisory|partners|group|consulting|consultants|associates|appraisals?|analytics|financial|securities|economics|research)\b/i;

interface Name { text: string; start: number; end: number; suffix: boolean }
interface Word { word: string; at: number }

/** The words between `from` and `to`, each with where it starts. */
function wordsIn(text: string, from: number, to: number): Word[] {
  return [...text.slice(from, to).matchAll(/\S+/g)].map((m) => ({ word: m[0], at: from + m.index! }));
}

/** Whether a word ends its sentence: a full stop that is not an initial's, "J.P.", a legal ending's, "Inc.", or a firm's "& Co.". */
const endsWithStop = (word: string): boolean => /\.$/.test(word) && !/^(?:[A-Z]\.)+$/.test(word) && !SUFFIX_WORD.test(word) && !/^Co\.$/i.test(word);

/** The name the kept words make, or null when they make none: only joining words, or only generic ones. */
function named(text: string, kept: Word[], suffix: boolean): Name | null {
  while (kept.length && JOIN.test(kept[0].word)) kept.shift();
  while (kept.length && JOIN.test(kept.at(-1)!.word)) kept.pop();
  const words = kept.filter((k, i) => !JOIN.test(k.word) && !(suffix && i === kept.length - 1));
  if (!words.length || words.every((k) => GENERIC.test(k.word))) return null;
  const last = kept.at(-1)!;
  // A legal ending keeps its full stop when it is an abbreviation ("Inc."), and drops the one that ends a sentence ("LLC.").
  let end = last.at + last.word.length;
  if (suffix && /^[A-Za-z]+\.$/.test(last.word) && !/^(?:inc|corp|ltd)\.$/i.test(last.word)) end--;
  return { text: text.slice(kept[0].at, end).replace(/\s+/g, ' '), start: kept[0].at, end, suffix };
}

/** A word without the punctuation that may follow it in a sentence. */
const bare = (word: string): string => word.replace(/[,;:)\]"”’]+$/, '');
const isNameWord = (word: string): boolean => NAME_WORD.test(word) && !NOT_NAME.has(word.toLowerCase().replace(/\.$/, ''));

/**
 * Whether the name goes on past the comma after words[i]: to its legal ending,
 * "Partners, LLC", or through a list of partners joined as a firm's name is, to
 * its ending, "Brackett, Holm & Wyse LLP". A person's name before a firm's,
 * "Tamsin Vale, Okenshaw Valuations, P.C.", has no "&" and stops at the comma.
 */
function goesOnPastComma(words: Word[], i: number): boolean {
  if (SUFFIX_WORD.test(bare(words[i + 1]?.word ?? ''))) return true;
  let joined = false;
  for (let j = i + 1; j < Math.min(words.length, i + 5); j++) {
    const word = bare(words[j].word);
    if (SUFFIX_WORD.test(word)) return joined;
    if (JOIN.test(word)) { joined = true; continue; }
    if (!isNameWord(word) || (word !== words[j].word && !words[j].word.endsWith(','))) return false;
  }
  return false;
}

/**
 * The name that starts at `from`, on its line, or on the next when nothing else
 * follows on this one, as on a cover with the firm's name under "Prepared by:".
 * It runs to the first word that is not a name's, and a comma ends it but for
 * the firm's legal ending after it (goesOnPastComma). A "The" opens a name only
 * when a name follows it: "The Wexmoor Group, LLC".
 */
function nameAfter(text: string, from: number): Name | null {
  let end = lineEnd(text, from);
  if (!/[A-Za-z0-9]/.test(text.slice(from, end)) && end < text.length) {
    from = end + 1;
    end = lineEnd(text, from);
  }
  const words = wordsIn(text, from, end).slice(0, 12);
  const kept: Word[] = [];
  let suffix = false;
  for (let i = 0; i < words.length && kept.length < 10; i++) {
    const { word: raw, at } = words[i];
    const word = bare(raw);
    if (kept.length && SUFFIX_WORD.test(word)) { kept.push({ word, at }); suffix = true; break; }
    if (kept.length && JOIN.test(word)) { kept.push({ word, at }); continue; }
    if (!kept.length && /^(?:The|THE)$/.test(raw) && isNameWord(bare(words[i + 1]?.word ?? ''))) { kept.push({ word, at }); continue; }
    if (!isNameWord(word)) break;
    if (endsWithStop(word)) { kept.push({ word: word.slice(0, -1), at }); break; }
    kept.push({ word, at });
    if (word !== raw && !(raw.endsWith(',') && goesOnPastComma(words, i))) break;
  }
  return named(text, kept, suffix);
}

/**
 * The name that ends at `to`, read back to its first word on its line: the legal
 * ending if it has one, and the words before it. An ending the PDF wrapped onto
 * a line of its own goes with the name on the line before: "Ashgrove Advisors,\nInc.".
 */
function nameBefore(text: string, to: number): Name | null {
  let from = lineStart(text, to);
  if (from > 0 && SUFFIX_WORD.test(text.slice(from, to).trim())) from = lineStart(text, from - 1);
  const words = wordsIn(text, from, to).slice(-12);
  const kept: Word[] = [];
  let suffix = false;
  let i = words.length - 1;
  if (i >= 0 && SUFFIX_WORD.test(words[i].word)) { kept.push(words[i]); suffix = true; i--; }
  for (; i >= 0 && kept.length < 10; i--) {
    let { word } = words[i];
    if (suffix && kept.length === 1) word = word.replace(/,$/, '');   // "Partners," before "LLC"
    if (/[,;:]$/.test(word) || endsWithStop(word)) break;
    if (JOIN.test(word)) { kept.unshift({ word, at: words[i].at }); continue; }
    if (!NAME_WORD.test(word) || NOT_NAME.has(word.toLowerCase())) break;
    kept.unshift({ word, at: words[i].at });
  }
  return named(text, kept, suffix);
}

/** A firm's name to compare by: in lower case, without its legal ending, a leading "The" or punctuation. */
const firmKey = (name: string): string => name.replace(SUFFIX_END, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');

/** Whether two names are one firm's: the same words, or one of two words or more that the other starts with. */
function sameFirm(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.includes(' ') && long.startsWith(`${short} `);
}

/** Words a report names the company it values after: "Prepared for", "the common stock of", "Board of Directors of". */
const SUBJECT_AFTER = /\bprepared[ \t]+for\b[ \t]*:?|\b(?:client|company|subject company|issuer)[ \t]*:|\b(?:stock|shares|equity|securities|interests?|units|directors|stockholders|shareholders|valuation)[ \t]+of\b[ \t]*/gi;
/** What may come between those words and the name: "the Board of Directors of", "the management of", "the". */
const SUBJECT_LEAD = /^[ \t]*(?:the[ \t]+)?(?:(?:board[ \t]+of[ \t]+directors|management|shareholders|stockholders)(?:[ \t]+of)?[ \t]*(?:the[ \t]+)?)?/i;
/**
 * A letter addressed to the board, with the company's name on the next line. The
 * comma at the end is matched as one optional piece with its spaces, never as
 * spaces around an optional comma, which would try every split of a long run of
 * spaces in turn.
 */
const ADDRESSED_TO = /^[ \t]*(?:to[ \t]*:?[ \t]*)?(?:the[ \t]+)?board[ \t]+of[ \t]+directors[ \t]*(?:,[ \t]*)?$/gim;
/**
 * The company's name defined for the rest of the report, the definition anywhere
 * in the parenthesis: Acme Robotics, Inc. (the "Company"), or ("Acme" or the "Company").
 */
const DEFINED_AS_COMPANY = /\([^()\n]{0,80}?["“'‘](?:company|issuer|client),?["”'’]/gi;
const NAMES_THE_COMPANY = /["“'‘](?:company|issuer|client),?["”'’]/i;

/** "Prepared by", as a cover or a footer has it, or a label for the appraiser. */
const PREPARED_BY = /\b(?:prepared|performed|conducted|completed)[ \t]+by\b[ \t]*:?|\b(?:appraiser|valuation[ \t]+(?:firm|provider|specialist|advisor)|independent[ \t]+(?:appraiser|valuation[ \t]+(?:firm|specialist|advisor)))[ \t]*:/gi;
/** What "prepared by" is about when it names the appraiser: the report. */
const ABOUT_THE_REPORT = /\b(?:report|valuation|appraisal|analysis|opinion|409a|letter)\b/i;
/** What else "prepared by" can be about, whoever prepared it: the projections, the statements. */
const ABOUT_SOMETHING_ELSE = /\b(?:projections?|forecasts?|budgets?|statements?|financials|schedules?|data|information|estimates?|plans?|models?|tables?|exhibits?|figures?|returns?|filings?|agreements?|minutes)\b/i;
/**
 * What else a firm a report names may have done for the company, which a sentence
 * that says so is about, whatever it says the firm did: its counsel, its audit,
 * its financing, a study of its market, or an earlier valuation.
 */
const SOMEONE_ELSE = /\b(?:counsel|legal|law firm|attorneys?|audit(?:s|ed|ors?)?|accountants?|placement|agents?|underwrit\w*|diligence|term sheet|stud(?:y|ies)|survey|market (?:analysis|research|data)|(?:prior|previous|earlier|last)[ \t]+(?:409a[ \t]+)?(?:valuation|appraisal|report|409a))\b/i;
/** What a sentence that names the firm engaged is about when the firm is the appraiser: the valuation, as the firm's own name may say. */
const ABOUT_THE_VALUATION = /valu|apprais|409a|common stock/i;
/** Before "prepared by" on a cover or in a footer: nothing, or a page number. */
const FOOTER_LEAD = /^[ \t]*(?:(?:page[ \t]+)?\d+(?:[ \t]+of[ \t]+\d+)?)?[ \t|•·–—-]*$/i;
/** The firm the company engaged: "engaged Harbor Lane Valuation Partners, LLC to". Not "engaged in", a business. */
const ENGAGED = /\b(?:engaged|retained|hired|commissioned)\b(?![ \t]+in\b)[ \t]*/gi;
/** The firm that was engaged: "Harbor Lane Valuation Partners, LLC was engaged by". */
const WAS_ENGAGED = /\b(?:has been|have been|was|were|is|are)[ \t]+(?:engaged|retained|hired|commissioned)\b(?![ \t]+in\b)/gi;
/** The firm that calls itself "we" in the letter: Harbor Lane Valuation Partners, LLC ("Harbor Lane," "we" or "us"). */
const CALLED_WE = /\([^()\n]{0,80}?["“'‘](?:we|us|our),?["”'’][^()\n]{0,60}\)/gi;
/** The close of a letter, with the firm's signature under it. */
const SIGN_OFF = /^[ \t]*(?:sincerely(?: yours)?|very truly yours|yours (?:very )?(?:truly|faithfully|sincerely)|respectfully(?: submitted)?|(?:with )?(?:kind |best )?regards)[ \t]*(?:,[ \t]*)?$/gim;
/** How many lines under the close are looked at for the firm's name: a signature, a name, credentials and a title or two come first. */
const SIGNATURE_LINES = 7;
/** What may follow a firm's name standing on a line of its own: nothing, or its address after a separator. */
const STANDS_ALONE = /^[ \t]*(?:$|[|•·–—(-]|\d)/;
/** The pages a firm's name standing alone is looked for on: the cover and the letter. */
const OPENING_PAGES = 3;

type Mention = 'prepared' | 'engaged' | 'we' | 'signed' | 'cover';

/**
 * How much a name counts for each way the report mentions it, and how sure that
 * makes the reading: with a firm's legal ending, with only a firm's word in it,
 * and with neither, which only "Prepared by" and "we" stand behind at all, since
 * a person signs a letter too.
 */
const MENTIONS_OF: Record<Mention, [number, Confidence] | null>[] = [
  { prepared: [12, 'high'], engaged: [11, 'high'], we: [11, 'high'], signed: [10, 'high'], cover: [4, 'low'] },
  { prepared: [10, 'high'], engaged: [8, 'medium'], we: [8, 'medium'], signed: [8, 'medium'], cover: null },
  { prepared: [5, 'low'], engaged: null, we: [5, 'low'], signed: null, cover: null },
];

/** The text from `at` back to where the name before it should end: past the spaces, and past a parenthesis or an aside ("Harbor, LLC, an independent firm,"). */
function backToName(text: string, at: number): number {
  const before = text.slice(Math.max(0, at - 200), at);
  const aside = before.match(/(?:\s*\([^()]{0,120}\)|,\s*(?:an?|the)\s[^,()\n]{1,80},)?\s*$/)!;
  return at - aside[0].length;
}

/** The matches of `re` on a page, no more than `most`. */
function firstOf(text: string, re: RegExp, most: number): RegExpMatchArray[] {
  const found: RegExpMatchArray[] = [];
  for (const m of text.matchAll(re)) {
    if (found.length >= most) break;
    found.push(m);
  }
  return found;
}

/** The names of the company the report values: from the caller, and from the words the report names it with. */
function subjectsOf(pages: string[], known: string[]): string[] {
  const keys = known.map(firmKey).filter(Boolean);
  let left = MENTIONS;
  pages.forEach((text) => {
    const add = (name: Name | null) => { if (name) keys.push(firmKey(name.text)); };
    for (const m of firstOf(text, SUBJECT_AFTER, Math.min(left, PAGE_MENTIONS))) {
      left--;
      const from = m.index! + m[0].length;
      add(nameAfter(text, from + text.slice(from, from + 80).match(SUBJECT_LEAD)![0].length));
    }
    for (const m of firstOf(text, ADDRESSED_TO, Math.min(left, PAGE_MENTIONS))) { left--; add(nameAfter(text, m.index! + m[0].length)); }
    for (const m of firstOf(text, DEFINED_AS_COMPANY, Math.min(left, PAGE_MENTIONS))) { left--; add(nameBefore(text, backToName(text, m.index!))); }
  });
  return keys;
}

/**
 * Whether a name is the company's by a one-word name the app knows it by:
 * "Hexwold" for "Hexwold Labs, Inc.", but not for "Hexwold Valuation Partners,
 * LLC", whose other words are a firm's.
 */
const shortNameOf = (short: string, key: string): boolean =>
  !!short && !short.includes(' ') && key.startsWith(`${short} `) && !FIRM_WORD.test(key.slice(short.length));

interface Named extends Scored<string> { key: string }

function readAppraiser(pages: string[], known: string[]): Detected<string> | null {
  const subjects = subjectsOf(pages, known);
  const shortNames = known.map(firmKey);
  const found: Named[] = [];
  let left = MENTIONS;
  pages.forEach((text, p) => {
    const offer = (name: Name | null, mention: Mention) => {
      if (!name) return;
      const key = firmKey(name.text);
      if (!key || subjects.some((s) => sameFirm(s, key)) || shortNames.some((s) => shortNameOf(s, key))) return;
      const weighed = MENTIONS_OF[name.suffix ? 0 : FIRM_WORD.test(name.text) ? 1 : 2][mention];
      if (!weighed) return;
      found.push({ value: name.text, text: name.text, context: contextOf(text, name.start, name.end), page: p + 1, confidence: weighed[1], score: weighed[0], at: name.start, key });
    };
    const each = (re: RegExp, read: (m: RegExpMatchArray) => void) => {
      for (const m of firstOf(text, re, Math.min(left, PAGE_MENTIONS))) { left--; read(m); }
    };
    /** The words of the sentence a mention is in, around `from` and `to`, the firm's own name included. */
    const sentenceOf = (from: number, to: number): string => flat(`${wordsBefore(text, from, 0)} ${text.slice(from, to)} ${wordsAfter(text, to, text.length, false)}`);
    each(PREPARED_BY, (m) => {
      // A label says it outright. "Prepared by" does when it opens its line in a
      // capital, as on a cover, or follows only the page number, as in a footer, and
      // when its sentence is about the report; never when what it says the firm did
      // is something else, the projections, the audit, the term sheet or the last
      // valuation. A sentence a PDF wrapped before "prepared by" goes on in lower case.
      const end = m.index! + m[0].length;
      const name = nameAfter(text, end);
      const label = m[0].trim().endsWith(':') && !/\bby\b/i.test(m[0]);
      const footer = /^[A-Z]/.test(m[0]) && FOOTER_LEAD.test(text.slice(lineStart(text, m.index!), m.index!));
      const after = flat(wordsAfter(text, name?.end ?? end, text.length, false));
      if (label || footer) {
        if (!SOMEONE_ELSE.test(after)) offer(name, 'prepared');
        return;
      }
      const before = wordsBefore(text, m.index!, 0);
      if (ABOUT_THE_REPORT.test(before) && !ABOUT_SOMETHING_ELSE.test(before) && !SOMEONE_ELSE.test(`${flat(before)} ${after}`)) offer(name, 'prepared');
    });
    // A firm engaged, or retained, is the appraiser when the sentence is about the
    // valuation, and not about counsel, an audit or a placement.
    const engaged = (name: Name | null, sentence: string) => {
      if (name && ABOUT_THE_VALUATION.test(sentence) && !SOMEONE_ELSE.test(sentence)) offer(name, 'engaged');
    };
    each(ENGAGED, (m) => engaged(nameAfter(text, m.index! + m[0].length), sentenceOf(m.index!, m.index! + m[0].length)));
    each(WAS_ENGAGED, (m) => engaged(nameBefore(text, backToName(text, m.index!)), sentenceOf(m.index!, m.index! + m[0].length)));
    // "we" in a parenthesis that also defines the "Company" is the company speaking, in its own documents.
    each(CALLED_WE, (m) => { if (!NAMES_THE_COMPANY.test(m[0])) offer(nameBefore(text, backToName(text, m.index!)), 'we'); });
    each(SIGN_OFF, (m) => {
      // The firm's name under the close, perhaps under a signature, a person's name
      // and a title or two: the first of the next few lines with a firm's legal
      // ending, or, failing that, the first with a firm's word, which may be only a
      // department's ("Valuation Advisory Services") above the firm. A long line is
      // a paragraph, after the signature.
      let at = m.index! + m[0].length;
      let worded: Name | null = null;
      for (let lines = 0; lines < SIGNATURE_LINES && at < text.length; lines++) {
        at = lineEnd(text, at) + 1;
        const line = text.slice(at, lineEnd(text, at));
        if (line.length > 80) break;
        const skip = line.match(/^\s*(?:\/s\/\s*)?/)![0].length;
        const name = nameAfter(text, at + skip);
        if (name?.suffix) { offer(name, 'signed'); return; }
        if (name && !worded && FIRM_WORD.test(name.text)) worded = name;
      }
      offer(worded, 'signed');
    });
    if (p < OPENING_PAGES) {
      each(SUFFIX_AT, (m) => {
        const name = nameBefore(text, m.index! + m[0].length);
        if (name && !text.slice(lineStart(text, name.start), name.start).trim() && STANDS_ALONE.test(text.slice(name.end, lineEnd(text, name.end)))) {
          offer(name, 'cover');
        }
      });
    }
  });

  // Each firm once: its best mention, a little more for each other, then the earlier page and place.
  const byFirm = new Map<string, { best: Named; times: number; plain: string | null }>();
  for (const f of found) {
    const seen = byFirm.get(f.key);
    // A cover in capitals names the firm as the letter does in ordinary case, and the ordinary case is what is kept.
    const plain = /[a-z]/.test(f.text) ? f.text : null;
    if (!seen) byFirm.set(f.key, { best: f, times: 1, plain });
    else {
      seen.times++;
      if (f.score > seen.best.score) seen.best = f;
      seen.plain ??= plain;
    }
  }
  const ranked = [...byFirm.values()]
    .map((firm) => ({ ...firm, total: firm.best.score + Math.min(2, firm.times - 1) }))
    .filter((firm) => firm.total >= 4)
    .sort((a, b) => b.total - a.total || a.best.page - b.best.page || a.best.at - b.best.at);
  if (!ranked.length) return null;
  const [first, second] = ranked;
  const { text, context, page } = first.best;
  // A report that names two firms as its author, each in so many words, leaves the choice to a person.
  const confidence: Confidence = first.best.confidence === 'high' && second?.best.confidence === 'high' ? 'medium' : first.best.confidence;
  return { value: first.plain ?? first.best.value, text, context, page, confidence };
}

// --- The value of the company ------------------------------------------------------

/** An amount in thousands, millions or billions: "$48.2 million", "$48.2M", "$1.1 bn". */
const SCALE = /^\s?(thousand|million|billion|mm|bn|k|m|b)\b/i;
const TIMES: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, mm: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9 };
/**
 * The least and the most a company's value is taken to be, in dollars. Less is
 * something else, a fee or a salary, or a figure from a table in thousands.
 */
const LEAST_VALUE = 100_000;
const MOST_VALUE = 1e12;

const ENTERPRISE = /enterprise value|\b(?:bev|tev|mvic)\b|invested capital/g;
const EQUITY = /equity value|value of (?:the )?(?:company['’]s )?(?:total |aggregate )?equity\b/g;
/** Either label, in the order a table's heading names them. */
const VALUE_LABEL = new RegExp(`${ENTERPRISE.source}|${EQUITY.source}`, 'g');
const labelBasis = (label: string): CompanyValue['basis'] => (/equity/.test(label) && !/invested capital/.test(label) ? 'equity' : 'enterprise');
/**
 * Words that say the value is the report's conclusion, and words that say only a
 * method indicated it, which count for less: the value selected from a range
 * beats the range a method indicated.
 */
const CONCLUDED = /conclu|selected|our opinion|fair (?:market )?value/;
const INDICATED = /indicated|estimated/;
/** A page whose figures are in thousands or millions, where an amount as written is not what it says. */
const IN_UNITS = /\bin (?:\$\s?|usd\s)?(thousands|millions)\b|\$\s?0{3}['’]?s\b|\b0{3}['’]?s omitted\b|\(\$?\s?0{3}\)/i;
const NOT_THE_COMPANY: [RegExp, number][] = [
  [/per (?:common |preferred )?share|\/\s?share\b|per unit/, 12],   // a price, not a company's value
  [/prior|previous|last (?:409a|valuation)|earlier/, 4],
  [/preferred|\bseries (?:[a-z]\d?|seed)\b|liquidation preference/, 3],
  [/post-money|pre-money|valuation cap/, 3],
  [/revenue|ebitda|net income|net loss|cash|debt|proceeds|raised|invest(?:ed|ment)|salary|fee|multiple|discount|guideline/, 3],
];
const EXCEPT_PER_SHARE = /except (?:for )?per[- ]share(?: (?:amounts|data|figures|values))?/g;
/** An earlier valuation, wherever its sentence names it: at most a guess at the value now. */
const EARLIER = /prior|previous|last (?:409a|valuation)|earlier/;
/** Cash, debt and the like stated with their amount: "cash of $8.4 million", "cash balance of", whatever value the sentence named first. */
const OTHER_AMOUNT = /\b(?:cash|debt|revenue|ebitda|net (?:income|loss)|proceeds)\b(?:\s+(?:balance|on hand|position))?\s*(?:of|was|is|were|totaled|totalled|amounted to|:)?\s*$/;
/** A table of other companies' values, under a heading that says so: the guideline public companies, comparable transactions. */
const OTHER_COMPANIES = /guideline|comparable|peer|public compan|precedent/;

/** Between the two ends of a range: "$44.0 million to $51.0 million", "$44.0 million – $51.0 million". */
const RANGE_TO = /^\s*(?:to|through|-|–|—)\s*$/i;
/** Between the two amounts of a change, perhaps with a few words on the first: "from $30.0 million [in the prior valuation] to $41.5 million". */
const CHANGED_TO = /^[^.;:\n$]{0,40}\bto\s*$/i;
/** After a range, in the same sentence, the point chosen in it: "…, and we selected $48.2 million". */
const CHOSEN_IN_RANGE = /^[ \t,;]*(?:and\s+)?(?:(?:we|management)\s+)?(?:selected|concluded|chose|arrived at|adopted)\b[^.;\n$]{0,30}$|(?:point estimate|mid-?point)[^.;\n$]{0,10}$/i;

/** Where the last match of `re` in `s` starts, or -1. */
function lastMatch(re: RegExp, s: string): number {
  let at = -1;
  for (const m of s.matchAll(re)) at = m.index!;
  return at;
}

/**
 * Which value the words with an amount name: the label nearest it before, then
 * the first after it, then any in its sentence. "The equity value of $54 million
 * follows from the enterprise value" is an equity value.
 */
function basisOf(before: string, after: string): { basis: CompanyValue['basis']; near: boolean } | null {
  const near = flat(before.slice(-60));
  const [e, q] = [lastMatch(ENTERPRISE, near), lastMatch(EQUITY, near)];
  if (e >= 0 || q >= 0) return { basis: e > q ? 'enterprise' : 'equity', near: true };
  const next = flat(after);
  const [ea, qa] = [next.search(ENTERPRISE), next.search(EQUITY)];
  if (ea >= 0 || qa >= 0) return { basis: qa < 0 || (ea >= 0 && ea < qa) ? 'enterprise' : 'equity', near: true };
  const far = flat(before);
  const [ef, qf] = [lastMatch(ENTERPRISE, far), lastMatch(EQUITY, far)];
  if (ef >= 0 || qf >= 0) return { basis: ef > qf ? 'enterprise' : 'equity', near: false };
  return null;
}

/**
 * The units of a figure in a table, from the table's heading: "(in thousands)" on
 * the figure's own row or on a row above it, up to the first line that ends a
 * sentence. A figure in a sentence is as the sentence writes it.
 */
function unitsOf(text: string, at: number): 'thousands' | 'millions' | null {
  let start = lineStart(text, at);
  let end = lineEnd(text, at);
  for (let lines = 0; lines < 8; lines++) {
    const line = text.slice(start, end);
    if (endsSentence(line.trimEnd())) return null;
    const m = line.match(IN_UNITS);
    if (m) return m[1]?.toLowerCase() === 'millions' ? 'millions' : 'thousands';
    if (start === 0) return null;
    end = start - 1;
    start = lineStart(text, end);
  }
  return null;
}

interface Amount { m: RegExpMatchArray; start: number; end: number; dollars: number; scaled: boolean; units: 'thousands' | 'millions' | null }

/**
 * How an amount is read: on its own words, or as one of a pair or a row that
 * goes together, with the words before the first of them (`with`).
 *   was, now: the two ends of a change; the first is where the value was.
 *   range:    the two ends of a range, neither the value; chosen: the point in it.
 *   column:   a row of figures under a heading naming a value for each, in order.
 *   columns:  such a row whose heading cannot be paired with it, one label for all.
 *   skip:     such a row with both labels that cannot be paired.
 */
type Reading = 'own' | 'was' | 'now' | 'range' | 'chosen' | 'column' | 'columns' | 'skip';

/**
 * The enterprise values and the equity values a report states, each judged by
 * the words in its own sentence or row, as the price per share is: only an
 * amount the words call one of the two is read at all.
 */
function readCompanyValues(pages: string[]): Record<CompanyValue['basis'], (Scored<number> & Pick<CompanyValue, 'units'>)[]> {
  const found: Record<CompanyValue['basis'], (Scored<number> & Pick<CompanyValue, 'units'>)[]> = { enterprise: [], equity: [] };
  let left = READINGS;
  pages.forEach((text, p) => {
    const inUnits = IN_UNITS.test(text);
    const amounts: Amount[] = [];
    for (const m of text.matchAll(MONEY)) {
      if (amounts.length >= Math.min(left, PAGE_READINGS)) break;
      const start = m.index!;
      const scale = text.slice(start + m[0].length, start + m[0].length + 12).match(SCALE);
      const units = !scale && inUnits ? unitsOf(text, start) : null;
      const times = scale ? TIMES[scale[1].toLowerCase()] : units === 'millions' ? 1e6 : units === 'thousands' ? 1e3 : 1;
      amounts.push({ m, start, end: start + m[0].length + (scale?.[0].length ?? 0), dollars: Number(m[1].replace(/,/g, '')) * times, scaled: !!scale, units });
    }
    left -= amounts.length;
    const floorOf = (i: number): number => (i > 0 ? amounts[i - 1].end : 0);
    const ceilingOf = (i: number): number => (i + 1 < amounts.length ? amounts[i + 1].start : text.length);
    /** The words between an amount and the next, when they are few enough to join the two. */
    const gap = (i: number): string | null => (i + 1 < amounts.length && amounts[i + 1].start - amounts[i].end <= 80 ? text.slice(amounts[i].end, amounts[i + 1].start) : null);
    const lead = (i: number): string => flat(text.slice(Math.max(floorOf(i), amounts[i].start - 60), amounts[i].start));
    const isRow = (i: number): boolean => /^[ \t]+$/.test(gap(i) ?? '');

    const how: { reading: Reading; with: number; basis?: CompanyValue['basis'] }[] = amounts.map((_, i) => ({ reading: 'own', with: i }));
    for (let i = 0; i + 1 < amounts.length; i++) {
      const g = gap(i);
      if (g === null) continue;
      const from = /\bfrom\s*$/.test(lead(i));
      const ranging = /\brang/.test(lead(i));
      if (from && !ranging && CHANGED_TO.test(g)) {
        // "increased from $30.0 million to $41.5 million": the second has the words before both, and not those on the first.
        how[i] = { reading: 'was', with: i };
        how[i + 1] = { reading: 'now', with: i };
        i++;
      } else if (/^\s*from\s*$/i.test(g)) {
        how[i + 1] = { reading: 'was', with: i + 1 };   // "rose to $41.5 million from $30.0 million"
        i++;
      } else if (RANGE_TO.test(g) || (from && CHANGED_TO.test(g)) || (/^\s*and\s*$/i.test(g) && /\bbetween\s*$/.test(lead(i)))) {
        how[i] = { reading: 'range', with: i };
        how[i + 1] = { reading: 'range', with: i };
        const next = gap(i + 1);
        if (next !== null && CHOSEN_IN_RANGE.test(next)) { how[i + 2] = { reading: 'chosen', with: i }; i++; }
        i++;
      }
    }
    // A row of nothing but figures, under a heading that names a value for each in
    // turn: "Equity value  Enterprise value" over "$51,300,000  $48,200,000".
    for (let i = 0; i < amounts.length; i++) {
      if (how[i].reading !== 'own' || !isRow(i) || text.slice(lineStart(text, amounts[i].start), amounts[i].start).trim()) continue;
      let last = i;
      while (last + 1 < amounts.length && isRow(last)) last++;
      const labels = [...flat(wordsBefore(text, amounts[i].start, floorOf(i))).matchAll(VALUE_LABEL)].map((m) => labelBasis(m[0]));
      const one = labels.length > 0 && labels.every((b) => b === labels[0]);
      for (let k = i; k <= last; k++) {
        how[k] = labels.length === last - i + 1 ? { reading: 'column', with: i, basis: labels[k - i] }
          : one ? { reading: 'columns', with: i, basis: labels[0] } : { reading: labels.length ? 'skip' : 'own', with: k };
      }
      i = last;
    }

    amounts.forEach((a, i) => {
      const { reading, with: first, basis } = how[i];
      if (reading === 'skip' || !Number.isFinite(a.dollars) || a.dollars < LEAST_VALUE || a.dollars > MOST_VALUE) return;
      if (OTHER_AMOUNT.test(flat(text.slice(Math.max(floorOf(i), a.start - 40), a.start)))) return;
      const before = wordsBefore(text, amounts[first].start, floorOf(first)) + (reading === 'chosen' ? ` ${gap(i - 1)}` : '');
      const after = wordsAfter(text, a.end, ceilingOf(i), true);
      const named = basis ? { basis, near: true } : basisOf(before, after);
      if (!named) return;
      // A heading's "(in thousands, except per share amounts)" says nothing about the figure under it.
      const all = flat(`${before} ${after}`).replace(EXCEPT_PER_SHARE, '');
      const near = flat(`${before.slice(-60)} ${after}`).replace(EXCEPT_PER_SHARE, '');
      // A row of a table that names something else, its heading naming the value:
      // "Kestrelmark Systems  $1,240.5 million" under "Company  Enterprise Value".
      const own = text.slice(lineStart(text, a.start), a.start).trim();
      const row = reading === 'own' && /^[A-Z]/.test(own) && !/(?:^|\s)[a-z]/.test(own) && flat(`${own} ${after}`).search(VALUE_LABEL) < 0;
      if (row && OTHER_COMPANIES.test(all)) return;
      let score = named.near ? 6 : 3;
      if (CONCLUDED.test(all)) score += 2;
      else if (INDICATED.test(all)) score += 1;
      if (/\bcompany\b|\btotal\b|\baggregate\b/.test(all)) score += 1;
      let against = false;
      for (const [re, weight] of NOT_THE_COMPANY) {
        if (re.test(near)) { score -= weight; against = true; } else if (re.test(all)) score -= weight / 2;
      }
      // How sure the reading can be at most, from how the amount stands with the others.
      let surest: Confidence = 'high';
      const atMost = (c: Confidence) => { if (SURER[c] < SURER[surest]) surest = c; };
      if (reading === 'was') { score -= 6; atMost('low'); }
      if (reading === 'range') { score -= 4; atMost('low'); }
      if (reading === 'columns' || EARLIER.test(all)) atMost('low');
      // Another value on its row, which of the row's figures the label is for being unclear.
      if (reading === 'own' && isRow(i) && amounts[i + 1].dollars >= LEAST_VALUE) atMost('low');
      // An amount as written on a page in thousands, with no heading over it to say so, may be a thousand times more.
      if (inUnits && !a.scaled && !a.units) atMost('low');
      if (reading === 'chosen' || reading === 'column' || row || a.units) atMost('medium');
      // Both values named right by it: the words do not say plainly which it is.
      if (lastMatch(ENTERPRISE, near) >= 0 && lastMatch(EQUITY, near) >= 0) atMost('medium');
      // The form asks for the enterprise value, which an equity value is not.
      if (named.basis === 'equity') atMost('medium');
      if (score < 3) return;
      const confidence: Confidence = !against && named.near && (CONCLUDED.test(all) || INDICATED.test(all)) && score >= 8 ? 'high'
        : score >= 6 ? 'medium' : 'low';
      found[named.basis].push({
        value: dollarsToCents(a.dollars), text: text.slice(a.start, a.end).trim(), context: contextOf(text, a.start, a.end),
        page: p + 1, confidence: SURER[confidence] > SURER[surest] ? surest : confidence, score, at: a.start,
        ...(a.units ? { units: a.units } : {}),
      });
    });
  });
  return found;
}

/**
 * The enterprise value the report states, or its equity value when it states no
 * enterprise value as surely: an enterprise value read only as a guess, another
 * company's or an earlier one, never displaces the equity value the report concludes.
 */
function readCompanyValue(pages: string[]): CompanyValue | null {
  const { enterprise, equity } = readCompanyValues(pages);
  const [e] = rank(enterprise, true);
  const [q] = rank(equity, true);
  if (e && (!q || SURER[e.confidence] >= SURER[q.confidence])) return { ...e, basis: 'enterprise' };
  return q ? { ...q, basis: 'equity' } : null;
}

// --- Choosing --------------------------------------------------------------------

/** The text that is read: each page cut to PAGE_TEXT, and the pages after REPORT_TEXT left out. */
function toRead(pages: string[]): string[] {
  const read: string[] = [];
  let left = REPORT_TEXT;
  for (const page of pages) {
    if (left <= 0) break;
    const text = page.length > Math.min(PAGE_TEXT, left) ? page.slice(0, Math.min(PAGE_TEXT, left)) : page;
    read.push(text);
    left -= text.length;
  }
  return read;
}

/**
 * Each value once, ranked: its best reading, a little more for each time the
 * report repeats it (a conclusion is stated in the summary and again in the
 * body), then the earlier page, then the earlier place on it. With `sureFirst`,
 * a surer reading comes first whatever its score, for values whose confidence is
 * capped by how they stand rather than scored down (a range, an earlier value).
 */
function rank<R extends Scored<string | number>>(found: R[], sureFirst = false): Omit<R, 'score' | 'at'>[] {
  const surer = (a: R, b: R): number => (sureFirst ? SURER[b.confidence] - SURER[a.confidence] : 0);
  const byValue = new Map<R['value'], { best: R; times: number }>();
  for (const f of found) {
    const seen = byValue.get(f.value);
    if (!seen) byValue.set(f.value, { best: f, times: 1 });
    else {
      seen.times++;
      if (surer(f, seen.best) < 0 || (surer(f, seen.best) === 0 && f.score > seen.best.score)) seen.best = f;
    }
  }
  return [...byValue.values()]
    .map(({ best, times }) => ({ best, total: best.score + Math.min(2, times - 1) }))
    .sort((a, b) => surer(a.best, b.best) || b.total - a.total || a.best.page - b.best.page || a.best.at - b.best.at)
    .slice(0, CANDIDATES)
    .map(({ best: { score: _score, at: _at, ...reading } }) => reading);
}

/**
 * The fair market value, valuation date and method a report states, the firm
 * that prepared it and the company's value, each with the words it came from,
 * from the text of its pages. `asOf` is the day dates are judged against, today
 * when not given: a valuation date cannot be after it, nor more than eighteen
 * months before it. `names` are the company's own names, which are never taken
 * for the appraiser's.
 */
export function detectReport(report: string[], options: { asOf?: string; names?: string[] } = {}): ReportReading {
  const pages = toRead(report);
  if (!pages.some((p) => p.trim())) return nothingDetected(false);
  const asOf = options.asOf ?? today();
  const fairMarketValue = rank(readAmounts(pages));
  const valuationDate = rank(readDates(pages, asOf));
  return {
    readable: true,
    fairMarketValue: fairMarketValue[0] ?? null,
    valuationDate: valuationDate[0] ?? null,
    method: readMethod(pages),
    appraiser: readAppraiser(pages, options.names ?? []),
    enterpriseValue: readCompanyValue(pages),
    candidates: { fairMarketValue, valuationDate },
  };
}
