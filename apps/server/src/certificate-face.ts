/**
 * The front page of a certificate, an equity award and a SAFE or note, in the
 * classic stock-certificate form: the number and amount across the top, the
 * company's legal name, a faint title behind the text, the certifying paragraph,
 * the date and the signature blocks, with the legends and the full terms on the
 * pages after it.
 *
 * A face is built once, from the facts at the moment the document is generated,
 * and stored with the document (documents.face), so a signed certificate never
 * changes when a holder is renamed, shares are transferred or a class is edited
 * later. Everything here is pure: callers pass the facts in, and the PDF writer
 * draws what comes out (pdf-writer.ts certificatePdf).
 */
import { config } from './config.ts';
import { integer, perShare, usd, ENTITY_WORDS } from './templates.ts';

export type FaceKind = 'STOCK' | 'OPTION' | 'RSU' | 'AWARD' | 'SAFE' | 'NOTE';

/** A stretch of text in one weight; a paragraph is a list of them. */
export interface Run { text: string; bold?: boolean }

export interface FaceSigner {
  /** COMPANY is the block with no stakeholder; HOLDER is the holder's own. */
  role: 'COMPANY' | 'HOLDER';
  name: string;
  title: string;
}

export interface CertificateFace {
  version: 1;
  kind: FaceKind;
  /** Top left, e.g. "ID: CS-2". */
  idLabel: string;
  /** Top right, e.g. "1,000,000 Shares", "48,000 Options", "$250,000". */
  amountLabel: string;
  /** The company's legal name, large and centred. */
  heading: string;
  /** The faint title behind the text, one entry per line. */
  watermark: string[];
  paragraphs: Run[][];
  /** "Dated: June 4, 2021". */
  dated: string;
  signers: FaceSigner[];
  /** Heading of the pages after the face. */
  backTitle: string;
  /** Plain text of the pages after the face: legends, terms, the agreement. */
  back: string;
}

/** A date written out in the documents' locale: "June 4, 2021". */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(config().locale.locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** "Common" reads as "Common Stock" on a certificate; a name that already says what it is stays as it is. */
export function stockClassName(name: string): string {
  return /\b(stock|shares?|units?)\b/i.test(name) ? name : `${name} Stock`;
}

const isCorporation = (entityType: string | null | undefined): boolean => !entityType || /CORP|PBC/.test(entityType);
const entityWord = (entityType: string | null | undefined): string => ENTITY_WORDS[entityType ?? ''] ?? 'corporation';
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

interface CompanyFacts {
  legalName: string;
  jurisdiction: string | null;
  entityType: string | null;
}

/** "a Delaware corporation (the "Corporation")" as runs, with the state in bold. */
function companyClause(c: CompanyFacts, defined: string): Run[] {
  const state = c.jurisdiction || config().company.jurisdiction;
  return [
    { text: ', a ' }, { text: state, bold: true }, { text: ` ${entityWord(c.entityType)} (the "${defined}")` },
  ];
}

// --- Legends --------------------------------------------------------------------------

export interface LegendConditions {
  /** Subject to vesting, early exercise or a repurchase right: an agreement with the holder governs transfer. */
  restricted: boolean;
  /** Issued from the equity plan (an exercise or early exercise), so the plan's transfer limits apply. */
  fromPlan: boolean;
  /** The holder is not a US person (a W-8 on file, a non-US tax country, or a Regulation S issue). */
  nonUs: boolean;
}

/** The restrictive legends for a stock certificate, from legal.stockLegends in the param file. */
export function stockLegends(when: LegendConditions): string[] {
  return config().legal.stockLegends
    .filter((l) => l.when === 'always'
      || (l.when === 'restricted' && when.restricted)
      || (l.when === 'plan' && when.fromPlan)
      || (l.when === 'notPlan' && !when.fromPlan)
      || (l.when === 'nonUs' && when.nonUs))
    .map((l) => l.text.trim());
}

/** Whether a holder counts as a non-US person for the Regulation S legend. */
export function isNonUsHolder(h: { taxForm?: string | null; taxCountry?: string | null; federalExemption?: string | null }): boolean {
  if (h.federalExemption === 'REG_S') return true;
  if (h.taxForm === 'W8BEN' || h.taxForm === 'W8BENE') return true;
  const country = (h.taxCountry ?? '').trim().toUpperCase();
  return !!country && !['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(country);
}

// --- Stock certificate --------------------------------------------------------------------

export interface StockFaceInput extends CompanyFacts {
  certificateNo: string;
  holderName: string;
  quantity: number;
  className: string;
  /** Par value in micro-dollars, as share_classes.par_value stores it. */
  parValue: number;
  issueDate: string;
  signerName: string;
  signerTitle: string;
  /** The text of the pages after the face (legends, vesting, terms). */
  back: string;
}

export function stockFace(f: StockFaceInput): CertificateFace {
  const defined = isCorporation(f.entityType) ? 'Corporation' : 'Company';
  const cls = stockClassName(f.className);
  return {
    version: 1,
    kind: 'STOCK',
    idLabel: `ID: ${f.certificateNo}`,
    amountLabel: `${integer(f.quantity)} ${plural(f.quantity, 'Share')}`,
    heading: f.legalName,
    watermark: ['CERTIFICATE', 'OF STOCK'],
    paragraphs: [
      [
        { text: 'This certifies that ' }, { text: f.holderName, bold: true }, { text: ' (the "Holder") is the registered holder of ' },
        { text: integer(f.quantity), bold: true }, { text: ` ${plural(f.quantity, 'share')} of ` }, { text: cls, bold: true },
        { text: `, par value ${perShare(f.parValue)} per share, of ` }, { text: f.legalName, bold: true }, ...companyClause(f, defined),
        { text: `. This Certificate and the shares it represents are issued and held subject to the Certificate of Incorporation and the Bylaws of the ${defined}, each as amended from time to time, copies of which are on file at the ${defined}'s principal office. By accepting this Certificate, the holder agrees to be bound by them.` },
      ],
      [
        { text: `A statement of the rights, preferences, privileges and restrictions of each class or series of stock the ${defined} is authorized to issue, and of the holders of those shares, is available to any stockholder on request and without charge at the ${defined}'s principal office. The shares represented by this Certificate are subject to the legends and terms on the following pages.` },
      ],
    ],
    dated: `Dated: ${longDate(f.issueDate)}`,
    signers: [
      { role: 'COMPANY', name: f.signerName, title: f.signerTitle },
      { role: 'HOLDER', name: f.holderName, title: 'Stockholder' },
    ],
    backTitle: 'Legends and terms',
    back: f.back,
  };
}

// --- Equity award ---------------------------------------------------------------------------

export interface AwardFaceInput extends CompanyFacts {
  label: string;
  /** ISO, NSO, RSU, RSA, SAR, PHANTOM or GROWTH_SHARE. */
  type: string;
  typeName: string;
  holderName: string;
  quantity: number;
  /** Exercise or purchase price per share in micro-dollars; 0 for units. */
  strikePrice: number;
  className: string;
  planName: string | null;
  grantDate: string;
  vestingSchedule: string | null;
  vestingStart: string | null;
  expirationDate: string | null;
  signerName: string;
  signerTitle: string;
  /** The award agreement's text, for the pages after the face. */
  back: string;
}

export function awardFace(f: AwardFaceInput): CertificateFace {
  const cls = stockClassName(f.className);
  const under: Run[] = f.planName ? [{ text: ', under the ' }, { text: f.planName, bold: true }] : [];
  const units = f.type === 'RSU' || f.type === 'PHANTOM';
  const vestPart = f.vestingSchedule
    ? `${units ? 'vest' : 'vests'} on the "${f.vestingSchedule}" schedule${f.vestingStart ? ` from ${longDate(f.vestingStart)}` : ''}`
    : null;
  const expiryPart = f.expirationDate
    ? `${units ? 'expire' : 'expires'} on ${longDate(f.expirationDate)} unless ${units ? 'they end' : 'it ends'} earlier under the ${f.planName ? 'Plan' : 'award agreement'}`
    : null;
  const timing = vestPart || expiryPart ? `${units ? 'The units' : 'The award'} ${[vestPart, expiryPart].filter(Boolean).join(' and ')}.` : null;
  let kind: FaceKind = 'AWARD';
  let watermark = ['EQUITY', 'AWARD'];
  let unit = 'Share';
  let lead: Run[];
  if (f.type === 'ISO' || f.type === 'NSO') {
    kind = 'OPTION'; watermark = ['STOCK', 'OPTION']; unit = 'Option';
    lead = [
      { text: 'This certifies that ' }, { text: f.holderName, bold: true }, { text: ' has been granted ' },
      { text: f.type === 'ISO' ? 'an Incentive Stock Option' : 'a Nonstatutory Stock Option', bold: true },
      { text: ' to purchase ' }, { text: integer(f.quantity), bold: true }, { text: ` ${plural(f.quantity, 'share')} of ` }, { text: cls, bold: true },
      { text: ' of ' }, { text: f.legalName, bold: true }, ...companyClause(f, 'Company'),
      { text: ', at an exercise price of ' }, { text: perShare(f.strikePrice), bold: true }, { text: ' per share' }, ...under, { text: '.' },
    ];
  } else if (f.type === 'RSU' || f.type === 'PHANTOM') {
    kind = 'RSU'; watermark = f.type === 'RSU' ? ['RESTRICTED', 'STOCK UNITS'] : ['PHANTOM', 'UNITS']; unit = 'Unit';
    lead = [
      { text: 'This certifies that ' }, { text: f.holderName, bold: true }, { text: ' has been granted ' },
      { text: integer(f.quantity), bold: true }, { text: ` ${f.type === 'RSU' ? 'restricted stock' : 'phantom'} ${plural(f.quantity, 'unit')}, each representing the right to ${f.type === 'RSU' ? 'receive one share' : 'a payment equal to the value of one share'} of ` },
      { text: cls, bold: true }, { text: ' of ' }, { text: f.legalName, bold: true }, ...companyClause(f, 'Company'), ...under, { text: '.' },
    ];
  } else {
    if (f.type === 'RSA') watermark = ['RESTRICTED', 'STOCK AWARD'];
    lead = [
      { text: 'This certifies that ' }, { text: f.holderName, bold: true }, { text: ' has been granted ' },
      { text: `${integer(f.quantity)} ${f.typeName}${f.quantity === 1 || /s$/i.test(f.typeName) ? '' : 's'}`, bold: true },
      { text: ' covering ' }, { text: cls, bold: true }, { text: ' of ' }, { text: f.legalName, bold: true }, ...companyClause(f, 'Company'),
      ...(f.strikePrice > 0 ? [{ text: ', at a price of ' }, { text: perShare(f.strikePrice), bold: true }, { text: ' per share' }] : []), ...under, { text: '.' },
    ];
  }
  const second = [timing,
    `The award is governed by ${f.planName ? 'the Plan and ' : ''}the award agreement on the following pages, which control if anything here differs.`]
    .filter(Boolean).join(' ');
  return {
    version: 1,
    kind,
    idLabel: `ID: ${f.label}`,
    amountLabel: `${integer(f.quantity)} ${plural(f.quantity, unit)}`,
    heading: f.legalName,
    watermark,
    paragraphs: [lead, [{ text: second }]],
    dated: `Dated: ${longDate(f.grantDate)}`,
    signers: [
      { role: 'COMPANY', name: f.signerName, title: f.signerTitle },
      { role: 'HOLDER', name: f.holderName, title: kind === 'OPTION' ? 'Optionholder' : 'Participant' },
    ],
    backTitle: `${f.typeName} agreement`,
    back: f.back,
  };
}

// --- SAFE and convertible note ------------------------------------------------------------------

export interface ConvertibleFaceInput extends CompanyFacts {
  label: string;
  /** SAFE_PRE, SAFE_POST, NOTE or KISS. */
  instrument: string;
  instrumentName: string;
  holderName: string;
  /** Purchase amount or principal, in cents. */
  principal: number;
  issueDate: string;
  /** In cents, null when uncapped. */
  valuationCap: number | null;
  /** 0 to 1. */
  discount: number;
  /** 0 to 1, notes only. */
  interestRate: number;
  compoundingWords: string;
  maturityDate: string | null;
  signerName: string;
  signerTitle: string;
  /** The agreement's text, for the pages after the face. */
  back: string;
}

const percent = (x: number): string => `${Number((x * 100).toFixed(2))}%`;
/** Whole amounts without cents, as a certificate states them: "$250,000", "$12,000,000". */
const dollars = (cents: number): string => usd(cents).replace(/[.,]00(?=\D*$)/, '');

export function convertibleFace(f: ConvertibleFaceInput): CertificateFace {
  const isNote = f.instrument === 'NOTE';
  const capWords = f.instrument === 'SAFE_POST' ? 'post-money valuation cap' : 'valuation cap';
  const terms: Run[] = [
    ...(f.valuationCap ? [{ text: `, with a ${capWords} of ` }, { text: dollars(f.valuationCap), bold: true }] : []),
    ...(f.discount > 0 ? [{ text: f.valuationCap ? ' and a discount of ' : ', with a discount of ' }, { text: percent(f.discount), bold: true }] : []),
  ];
  const lead: Run[] = isNote
    ? [
      { text: 'This certifies that ' }, { text: f.legalName, bold: true }, ...companyClause(f, 'Company'),
      { text: ', has issued to ' }, { text: f.holderName, bold: true }, { text: ' a convertible promissory note in the principal amount of ' },
      { text: dollars(f.principal), bold: true },
      ...(f.interestRate > 0 ? [{ text: ', bearing interest at ' }, { text: `${percent(f.interestRate)} per year`, bold: true }, { text: ` (${f.compoundingWords})` }] : []),
      ...(f.maturityDate ? [{ text: ', due on ' }, { text: longDate(f.maturityDate), bold: true }] : []),
      { text: ", and convertible into shares of the Company's capital stock on the terms of the note" }, ...terms, { text: '.' },
    ]
    : [
      { text: 'This certifies that ' }, { text: f.holderName, bold: true }, { text: ' has paid ' }, { text: dollars(f.principal), bold: true },
      { text: ' (the "Purchase Amount") to ' }, { text: f.legalName, bold: true }, ...companyClause(f, 'Company'),
      { text: ", in exchange for the right to certain shares of the Company's capital stock on the terms of this " },
      { text: f.instrumentName, bold: true }, ...terms, { text: '.' },
    ];
  return {
    version: 1,
    kind: isNote ? 'NOTE' : 'SAFE',
    idLabel: `ID: ${f.label}`,
    amountLabel: dollars(f.principal),
    heading: f.legalName,
    watermark: isNote ? ['CONVERTIBLE', 'PROMISSORY NOTE'] : f.instrument === 'KISS' ? ['KEEP IT', 'SIMPLE SECURITY'] : ['SIMPLE AGREEMENT', 'FOR FUTURE EQUITY'],
    paragraphs: [
      lead,
      [{ text: `The full terms are set out in the ${isNote ? 'note' : 'agreement'} on the following pages, which controls if anything here differs. This instrument, and any securities issued under it, are subject to the legend on the following page.` }],
    ],
    dated: `Dated: ${longDate(f.issueDate)}`,
    signers: [
      { role: 'COMPANY', name: f.signerName, title: f.signerTitle },
      { role: 'HOLDER', name: f.holderName, title: isNote ? 'Holder' : 'Investor' },
    ],
    backTitle: f.instrumentName,
    back: `${config().legal.convertibleLegend.trim()}\n\n${f.back}`,
  };
}

/** The face's text as plain paragraphs, for the readable body signers see and search finds. */
export function faceText(face: CertificateFace): string {
  return face.paragraphs.map((p) => p.map((r) => r.text).join('')).join('\n\n');
}

/** Reads a stored face back, or null for a document generated before faces existed. */
export function parseFace(json: string | null | undefined): CertificateFace | null {
  if (!json) return null;
  try {
    const face = JSON.parse(json) as CertificateFace;
    return face && face.version === 1 && Array.isArray(face.paragraphs) ? face : null;
  } catch {
    return null;
  }
}
