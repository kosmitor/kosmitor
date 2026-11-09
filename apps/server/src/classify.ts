/**
 * Working out what an uploaded document is, so it can be filed where it belongs.
 *
 * Deliberately plain: a document's name and the first pages of its text are
 * scored against the phrases each kind of paperwork is known by, and the kind
 * that clearly wins is used. Nothing leaves the server and the same file always
 * gives the same answer. When nothing wins clearly the document is left as
 * "Other" in the default folder: a wrong guess puts a paper where nobody would
 * look for it, which is worse than leaving it where people check first.
 */
import { pdfText } from './pdf-text.ts';
import { docxToText } from './docx-text.ts';
import { DEFAULT_FOLDER } from './folders.ts';

export interface Classification {
  category: string;
  folder: string;
  /** False when nothing won clearly, so the document was left in Other / General. */
  confident: boolean;
  /** In words, what it was recognised by: "Series A term sheet". */
  reason: string;
}

interface Kind { category: string; folder: string; label: string; phrases: RegExp[] }

// Order does not matter; the score does. A phrase counts once per occurrence, up to a cap.
const KINDS: Kind[] = [
  { category: 'VALUATION', folder: 'Valuation', label: '409A valuation', phrases: [
    /\b409\s?a\b/i, /valuation report/i, /fair market value/i, /independent (?:appraisal|valuation)/i, /enterprise value/i, /discounted cash flow|option pricing method|\bopm\b|backsolve/i] },
  { category: 'FINANCING', folder: 'Financing', label: 'financing document', phrases: [
    /\bsafe\b|simple agreement for future equity/i, /convertible (?:promissory )?note/i, /term sheet/i, /(?:preferred )?stock purchase agreement/i,
    /investors?['’]? rights agreement/i, /voting agreement/i, /right of first refusal and co-?sale/i, /subscription agreement/i, /side letter/i,
    /series (?:pre-?seed|seed|[a-e])\b/i, /liquidation preference/i, /pre-?money|post-?money/i, /cap table|capitalization table/i] },
  { category: 'GRANT', folder: 'Equity', label: 'equity grant', phrases: [
    /stock option (?:grant|agreement)|notice of (?:stock option )?grant/i, /restricted stock (?:unit|award|purchase)|\brsu\b/i, /equity incentive plan|stock (?:option|incentive) plan/i,
    /\b83\s?\(b\)/i, /exercise price/i, /vesting (?:schedule|commencement)/i, /\bisos?\b|\bnsos?\b/i] },
  { category: 'CHARTER', folder: 'Corporate', label: 'incorporation document', phrases: [
    /certificate of incorporation/i, /\bbylaws\b|by-laws/i, /articles of (?:association|incorporation)/i, /certificate of amendment/i, /statuts/i,
    /good standing/i, /operating agreement/i] },
  { category: 'BOARD', folder: 'Board', label: 'board paperwork', phrases: [
    /board (?:consent|resolution|minutes|meeting|deck)/i, /minutes of (?:a|the) (?:meeting|special|regular)/i, /unanimous written consent/i, /stockholders?['’]? consent/i,
    /\bresolved\b|\bresolutions\b/i, /directors?['’]? (?:meeting|consent)/i, /\bquorum\b/i, /\bminutes\b/i, /board of directors/i] },
  { category: 'TAX', folder: 'Tax', label: 'tax document', phrases: [
    /\bw-?\s?[89]\b/i, /\b1099\b/i, /\bform 5471\b|\bform 1120\b|\b1120\b|\bk-1\b/i, /tax return/i, /employer identification number|\bein\b/i,
    /internal revenue service|\birs\b/i, /\bvat\b|sales tax/i, /franchise tax/i] },
  { category: 'AGREEMENT', folder: 'Agreements', label: 'agreement', phrases: [
    /non-?disclosure|\bnda\b|confidentiality agreement/i, /employment agreement|offer letter/i, /consulting agreement|advisor(?:y)? agreement|independent contractor/i,
    /invention assignment|ip assignment|proprietary information/i, /master services agreement|\bmsa\b/i, /statement of work/i, /this agreement/i] },
  { category: 'CERTIFICATE', folder: 'Certificates', label: 'stock certificate', phrases: [
    /stock certificate/i, /this certifies that/i, /certificate (?:no|number)\b/i, /shares of (?:common|preferred) stock/i] },
];

/** The file name counts for more than any one sentence: people name papers for what they are. */
const NAME_WEIGHT = 4;
const PER_PHRASE_CAP = 3;
const MIN_SCORE = 3;

/** The text a classification reads: the name, then up to the first pages of the file. */
export function readableText(name: string, mime: string, bytes: Buffer): string {
  const lower = name.toLowerCase();
  try {
    if (lower.endsWith('.pdf') || mime === 'application/pdf') {
      const text = pdfText(bytes, { characters: 200_000, pageCharacters: 20_000 });
      return text.readable ? text.pages.slice(0, 6).join('\n').slice(0, 60_000) : '';
    }
    if (lower.endsWith('.docx')) return docxToText(bytes).slice(0, 60_000);
    if (mime.startsWith('text/') || /\.(txt|md|csv|rtf)$/.test(lower)) return bytes.subarray(0, 60_000).toString('utf8');
  } catch { /* a file that cannot be read is classified by its name alone */ }
  return '';
}

const ROUND = /series\s+(pre-?seed|seed|[a-e])\b/i;

export function classifyDocument(name: string, mime: string, bytes: Buffer, text: string = readableText(name, mime, bytes)): Classification {
  const fileName = name.replace(/[_\-.]+/g, ' ');
  const scored = KINDS.map((kind) => {
    let score = 0;
    for (const phrase of kind.phrases) {
      if (phrase.test(fileName)) score += NAME_WEIGHT;
      const g = new RegExp(phrase.source, `${phrase.flags}g`);
      score += Math.min(PER_PHRASE_CAP, (text.match(g) ?? []).length);
    }
    return { kind, score };
  }).sort((x, y) => y.score - x.score);
  const best = scored[0];
  const runnerUp = scored[1]?.score ?? 0;
  // A winner must clear the bar and beat the next kind by a margin, since a SAFE also mentions "this agreement".
  if (best.score < MIN_SCORE || best.score < runnerUp * 1.3) {
    return { category: 'OTHER', folder: DEFAULT_FOLDER, confident: false, reason: 'could not tell what it is' };
  }
  let folder = best.kind.folder;
  let reason = best.kind.label;
  if (best.kind.category === 'FINANCING') {
    const round = ROUND.exec(fileName) ?? ROUND.exec(text);
    if (round) {
      const r = round[1].toLowerCase().replace('-', ' ');
      const label = /^[a-e]$/.test(r) ? `Series ${r.toUpperCase()}` : r === 'seed' ? 'Seed' : 'Pre seed';
      folder = `Financing/${label}`;
      reason = `${label} financing document`;
    }
  }
  return { category: best.kind.category, folder, confident: true, reason };
}
