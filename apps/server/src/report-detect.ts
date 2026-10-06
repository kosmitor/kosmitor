/**
 * The values a 409A report states, found in its text: the fair market value of
 * one common share, the valuation date and the valuation method.
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
 * Pure and deterministic: the same pages and the same day give the same answer.
 * The text comes from a file someone outside the company uploaded, so the work
 * is bounded whatever the text: only so much of a page and of the report is
 * read, the words around a value are looked for only so far, however long its
 * line, and only so many values are weighed on a page and in the whole report,
 * so a page stuffed with figures neither takes long nor crowds out the page that
 * states the conclusion.
 */
import { addMonths, dollarsToPPS, today } from '@kosmitor/core';

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

/** What a report with nothing to read detects: nothing, said plainly. */
export const nothingDetected = (readable: boolean): ReportDetection => ({
  readable, fairMarketValue: null, valuationDate: null, method: null, candidates: { fairMarketValue: [], valuationDate: [] },
});

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
 * body), then the earlier page, then the earlier place on it.
 */
function rank<T extends string | number>(found: Scored<T>[]): Detected<T>[] {
  const byValue = new Map<T, { best: Scored<T>; times: number }>();
  for (const f of found) {
    const seen = byValue.get(f.value);
    if (!seen) byValue.set(f.value, { best: f, times: 1 });
    else {
      seen.times++;
      if (f.score > seen.best.score) seen.best = f;
    }
  }
  return [...byValue.values()]
    .map(({ best, times }) => ({ best, total: best.score + Math.min(2, times - 1) }))
    .sort((a, b) => b.total - a.total || a.best.page - b.best.page || a.best.at - b.best.at)
    .slice(0, CANDIDATES)
    .map(({ best: { value, text, context, page, confidence } }) => ({ value, text, context, page, confidence }));
}

/**
 * The fair market value, valuation date and method a report states, each with
 * the words it came from, from the text of its pages. `asOf` is the day dates
 * are judged against, today when not given: a valuation date cannot be after it,
 * nor more than eighteen months before it.
 */
export function detectReport(report: string[], options: { asOf?: string } = {}): ReportDetection {
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
    candidates: { fairMarketValue, valuationDate },
  };
}
