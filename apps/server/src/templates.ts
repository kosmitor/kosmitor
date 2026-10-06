/**
 * Document templates with merge fields. A company's own templates are stored;
 * built-in ones cover the securities the platform issues. Rendering replaces
 * `{{path.to.value}}` tokens and evaluates `{{#if path}}…{{/if}}` and
 * `{{#unless path}}…{{/unless}}` blocks against a context of plain strings.
 */
import { all, one } from './db.ts';
import { config } from './config.ts';

export type TemplateKind = 'OPTION_AGREEMENT' | 'RSU_AGREEMENT' | 'CERTIFICATE' | 'OFFER_LETTER' | 'CONVERTIBLE_AGREEMENT';
export const TEMPLATE_KINDS: { kind: TemplateKind; label: string; description: string }[] = [
  { kind: 'OPTION_AGREEMENT', label: 'Option agreement', description: 'Signed by the holder and the Company when ISOs or NSOs are granted.' },
  { kind: 'RSU_AGREEMENT', label: 'RSU award agreement', description: 'Signed when restricted stock units are granted.' },
  { kind: 'CERTIFICATE', label: 'Stock certificate', description: 'The pages after the certificate\'s front page (issue, vesting, legends and terms), signed when shares are issued for signature.' },
  { kind: 'OFFER_LETTER', label: 'Offer letter', description: 'Sent to a candidate with their equity package.' },
  { kind: 'CONVERTIBLE_AGREEMENT', label: 'SAFE / note agreement', description: 'Signed by the investor and the Company when a SAFE or convertible note is issued.' },
];

export interface MergeField { token: string; description: string }
export const MERGE_FIELDS: MergeField[] = [
  { token: 'company.name', description: 'Company name' }, { token: 'company.legalName', description: 'Legal name' },
  { token: 'company.jurisdiction', description: 'State or country of formation' }, { token: 'company.entityType', description: '"corporation", "limited liability company"…' },
  { token: 'company.address', description: 'Registered address' },
  { token: 'holder.name', description: 'Recipient\'s name' }, { token: 'holder.email', description: 'Recipient\'s email' }, { token: 'holder.address', description: 'Recipient\'s address' },
  { token: 'holder.title', description: 'Recipient\'s job title' },
  { token: 'grant.label', description: 'Grant or certificate number' }, { token: 'grant.type', description: 'ISO, NSO, RSU…' }, { token: 'grant.typeName', description: '"Incentive Stock Option"…' },
  { token: 'grant.quantity', description: 'Number of shares, formatted' }, { token: 'grant.strikePrice', description: 'Exercise price per share' },
  { token: 'grant.totalPrice', description: 'Quantity × price' }, { token: 'grant.grantDate', description: 'Grant or issue date' }, { token: 'grant.expirationDate', description: 'Expiration date' },
  { token: 'grant.vestingSchedule', description: 'Schedule name ("4 years, 1 year cliff, monthly")' }, { token: 'grant.vestingStart', description: 'Vesting commencement date' },
  { token: 'grant.boardApprovalDate', description: 'Board approval date' }, { token: 'grant.ptepMonths', description: 'Post-termination exercise window in months' },
  { token: 'grant.earlyExercise', description: '"yes" when early exercise is allowed, else empty' },
  { token: 'plan.name', description: 'Equity plan name' }, { token: 'plan.shareClass', description: 'Share class the plan draws from' }, { token: 'shareClass.name', description: 'Share class name' },
  { token: 'shareClass.parValue', description: 'Par value per share' }, { token: 'shareClass.legend', description: 'Extra legend set on the share class' },
  { token: 'company.certificateTerms', description: 'Company-wide certificate terms from Settings' },
  { token: 'legends', description: 'Stock certificate: the restrictive legends from the settings that apply to these shares and this holder' },
  { token: 'signer.name', description: 'Company signatory' }, { token: 'signer.title', description: 'Signatory\'s title' },
  { token: 'message', description: 'Note entered when issuing' }, { token: 'today', description: 'Date the document was generated' },
  { token: 'offer.position', description: 'Offer letter: job title' }, { token: 'offer.startDate', description: 'Offer letter: start date' },
  { token: 'offer.salary', description: 'Offer letter: base salary' }, { token: 'offer.expiresOn', description: 'Offer letter: expiry of the offer' },
  { token: 'convertible.label', description: 'SAFE / note: instrument number' }, { token: 'convertible.instrumentName', description: '"Post-money SAFE", "Convertible note"…' },
  { token: 'convertible.isSafe', description: '"yes" for SAFEs and KISSes' }, { token: 'convertible.isNote', description: '"yes" for convertible notes' },
  { token: 'convertible.principal', description: 'Purchase amount' }, { token: 'convertible.issueDate', description: 'Issue date' },
  { token: 'convertible.valuationCap', description: 'Valuation cap, empty when uncapped' }, { token: 'convertible.capKind', description: '"post-money" or "pre-money"' },
  { token: 'convertible.discount', description: 'Discount, e.g. "20%", empty when none' }, { token: 'convertible.interestRate', description: 'Note interest rate' },
  { token: 'convertible.compounding', description: '"simple", "compounded annually"…' }, { token: 'convertible.maturityDate', description: 'Note maturity date' },
  { token: 'convertible.mfn', description: '"yes" when most-favoured-nation applies' }, { token: 'convertible.proRata', description: '"yes" when a pro rata right applies' },
  { token: 'convertible.qualifiedFinancingMinimum', description: 'Minimum raise that triggers conversion' },
];

export const BUILT_IN_TEMPLATES: Record<TemplateKind, { name: string; body: string }> = {
  OPTION_AGREEMENT: {
    name: 'Stock option agreement',
    body: `{{company.legalName}}
STOCK OPTION AGREEMENT — {{grant.typeName}}

Grant {{grant.label}} · {{today}}

{{company.legalName}} (the "Company") grants {{holder.name}} (the "Optionee") an option to purchase {{grant.quantity}} shares of {{plan.shareClass}} under the {{plan.name}} (the "Plan") at an exercise price of {{grant.strikePrice}} per share, a total of {{grant.totalPrice}} if exercised in full.

1. GRANT. The option is granted on {{grant.grantDate}}{{#if grant.boardApprovalDate}} pursuant to the board approval of {{grant.boardApprovalDate}}{{/if}} and is intended to be {{#if grant.isIso}}an incentive stock option under Section 422 of the Internal Revenue Code, to the extent permitted; any portion that exceeds the $100,000 limit is a non-statutory option{{/if}}{{#unless grant.isIso}}a non-statutory stock option{{/unless}}.

2. VESTING. The option vests under the "{{grant.vestingSchedule}}" schedule measured from {{grant.vestingStart}}, subject to the Optionee's continuous service. {{#if grant.earlyExercise}}The Optionee may exercise unvested shares early; shares so acquired remain subject to the Company's repurchase right until they vest.{{/if}}

3. EXERCISE. Vested shares may be exercised by notice to the Company with payment of the exercise price in cash or as the Plan otherwise permits. The option expires on {{grant.expirationDate}}, and no later than {{grant.ptepMonths}} months after the Optionee's service ends (or as the Plan provides on death, disability or termination for cause).

4. TAX. The Optionee is responsible for all taxes arising from the option, and acknowledges receipt of the Plan and its prospectus. Exercise of an incentive stock option may have alternative minimum tax consequences; the Optionee should consult a tax adviser.

5. TRANSFER. The option is not transferable other than by will or the laws of descent, and shares acquired are subject to the Company's bylaws, right of first refusal and any stockholders' agreement.

6. PLAN GOVERNS. This agreement is subject to the Plan; where they conflict, the Plan controls. Electronic signatures recorded on the platform, with their timestamps and network addresses, bind the parties.

{{#if message}}NOTE FROM THE COMPANY. {{message}}{{/if}}

SIGNATURES
For the Company: {{signer.name}}, {{signer.title}}
Optionee: {{holder.name}}`,
  },
  RSU_AGREEMENT: {
    name: 'Restricted stock unit award agreement',
    body: `{{company.legalName}}
RESTRICTED STOCK UNIT AWARD AGREEMENT

Award {{grant.label}} · {{today}}

{{company.legalName}} (the "Company") awards {{holder.name}} (the "Participant") {{grant.quantity}} restricted stock units under the {{plan.name}}, each representing the right to receive one share of {{plan.shareClass}} on settlement.

1. VESTING. The units vest under the "{{grant.vestingSchedule}}" schedule measured from {{grant.vestingStart}}, subject to continuous service. Unvested units are forfeited when service ends.

2. SETTLEMENT. Vested units are settled in shares as soon as practicable after vesting, less any shares withheld for taxes, as the Plan and Section 409A permit.

3. NO RIGHTS AS STOCKHOLDER. The Participant has no voting or dividend rights until shares are delivered.

4. TAX. Settlement is ordinary income at the fair market value of the shares delivered; the Company will withhold as required.

5. PLAN GOVERNS. This agreement is subject to the Plan. Electronic signatures recorded on the platform bind the parties.

{{#if message}}NOTE FROM THE COMPANY. {{message}}{{/if}}

SIGNATURES
For the Company: {{signer.name}}, {{signer.title}}
Participant: {{holder.name}}`,
  },
  CERTIFICATE: {
    name: 'Stock certificate',
    // The pages after the front page. The front page itself (number, holder, shares, class,
    // par value, company, date and signatures) is drawn from the facts, so a template
    // supplies only what follows it.
    body: `ISSUE. The shares were issued on {{grant.grantDate}} at {{grant.strikePrice}} per share, for total consideration of {{grant.totalPrice}}.

{{#if grant.vestingSchedule}}VESTING. The shares are subject to the "{{grant.vestingSchedule}}" vesting schedule measured from {{grant.vestingStart}}. Unvested shares are subject to the Company's right to repurchase them at the lower of cost and fair market value if the Holder's service ends. The Holder is responsible for deciding whether to file an election under Section 83(b) within 30 days of {{grant.grantDate}}.{{/if}}

The shares are also subject to any stockholders', voting or right of first refusal agreement to which the Holder is a party, each as amended from time to time.

LEGENDS
{{legends}}
{{#if shareClass.legend}}

{{shareClass.legend}}{{/if}}
{{#if company.certificateTerms}}
TERMS
{{company.certificateTerms}}
{{/if}}

{{#if message}}NOTE FROM THE COMPANY. {{message}}{{/if}}

Board approval: {{#if grant.boardApprovalDate}}{{grant.boardApprovalDate}}{{/if}}{{#unless grant.boardApprovalDate}}as recorded in the Company's minutes{{/unless}}.

ELECTRONIC SIGNATURES. The Company and the Holder sign this certificate electronically. Each typed signature recorded on the platform, with its timestamp and network address, is the signer's binding electronic signature, and the executed certificate is delivered to the Holder through the platform.

SIGNATURES
For the Company: {{signer.name}}, {{signer.title}}
Holder: {{holder.name}}`,
  },
  CONVERTIBLE_AGREEMENT: {
    name: 'SAFE / convertible note agreement',
    body: `{{company.legalName}}
{{#if convertible.isNote}}CONVERTIBLE PROMISSORY NOTE{{/if}}{{#unless convertible.isNote}}SIMPLE AGREEMENT FOR FUTURE EQUITY{{/unless}} — {{convertible.instrumentName}}
{{convertible.label}} · {{today}}

THIS CERTIFIES THAT, in exchange for the payment by {{holder.name}} (the "Investor") of {{convertible.principal}} (the "Purchase Amount") on or about {{convertible.issueDate}}, {{company.legalName}}, a {{company.jurisdiction}} {{company.entityType}} (the "Company"), grants the Investor the right to shares of the Company's capital stock on the terms below.

1. EQUITY FINANCING. If the Company sells preferred stock in a priced financing{{#if convertible.qualifiedFinancingMinimum}} raising at least {{convertible.qualifiedFinancingMinimum}}{{/if}} before this instrument converts or terminates, the Purchase Amount{{#if convertible.isNote}} plus accrued interest{{/if}} converts automatically into that preferred stock at the Conversion Price. The Conversion Price is {{#if convertible.valuationCap}}the lower of (a) the price per share implied by a {{convertible.capKind}} valuation of {{convertible.valuationCap}} (the "Valuation Cap"){{#if convertible.discount}} and (b) the price paid by the financing's investors less a {{convertible.discount}} discount{{/if}}{{#unless convertible.discount}} and (b) the price paid by the financing's investors{{/unless}}{{/if}}{{#unless convertible.valuationCap}}{{#if convertible.discount}}the price paid by the financing's investors less a {{convertible.discount}} discount{{/if}}{{#unless convertible.discount}}the price paid by the financing's investors{{/unless}}{{/unless}}.

2. LIQUIDITY EVENT. On a change of control or initial public offering before conversion, the Investor receives, at its election, either the Purchase Amount{{#if convertible.isNote}} plus accrued interest{{/if}} or the shares it would receive on conversion{{#if convertible.valuationCap}} at the Valuation Cap price{{/if}}.

3. DISSOLUTION. If the Company dissolves before conversion, the Investor is paid the Purchase Amount{{#if convertible.isNote}} plus accrued interest{{/if}} before any distribution to holders of common stock.
{{#if convertible.isNote}}
4. INTEREST AND MATURITY. The Purchase Amount bears interest at {{convertible.interestRate}} per year, {{convertible.compounding}}, from {{convertible.issueDate}}. Unless converted earlier, principal and interest are due on {{convertible.maturityDate}}, or convert at that date on the terms above at the election of holders of a majority of the notes then outstanding.
{{/if}}
5. INVESTOR RIGHTS.{{#if convertible.proRata}} The Investor may invest in the Equity Financing to maintain its as-converted ownership.{{/if}}{{#if convertible.mfn}} If the Company later issues an instrument of the same kind on terms more favourable to its holder, the Investor may adopt those terms.{{/if}} The Investor has no rights as a stockholder until shares are issued on conversion.

6. REPRESENTATIONS. The Company is duly organised and has authorised this instrument. The Investor is an accredited investor acquiring the instrument for its own account, understands that it is not registered under securities laws, and will not transfer it without the Company's consent and an available exemption.

7. GENERAL. This instrument is governed by the laws of {{company.jurisdiction}} and may be amended by the Company together with holders of a majority of the Purchase Amounts of instruments of this kind. Electronic signatures recorded on the platform, with their timestamps and network addresses, bind the parties.

{{#if message}}NOTE FROM THE COMPANY. {{message}}{{/if}}

SIGNATURES
For the Company: {{signer.name}}, {{signer.title}}
Investor: {{holder.name}}`,
  },
  OFFER_LETTER: {
    name: 'Offer letter',
    body: `{{company.legalName}}
{{today}}

Dear {{holder.name}},

We are delighted to offer you the position of {{offer.position}} at {{company.name}}, starting {{offer.startDate}}.

COMPENSATION. Your base salary will be {{offer.salary}} per year, paid according to the Company's payroll practices.

EQUITY. Subject to approval by the board of directors, you will be granted {{grant.quantity}} {{grant.typeName}}s under the {{plan.name}}{{#if grant.strikePrice}} with an exercise price equal to the fair market value on the grant date (currently {{grant.strikePrice}} per share){{/if}}, vesting under the "{{grant.vestingSchedule}}" schedule from your start date.

{{#if message}}{{message}}{{/if}}

This offer is contingent on your eligibility to work and on the Company's standard confidentiality and invention assignment agreement, and it expires on {{offer.expiresOn}}. Accepting it on the platform is your binding acceptance.

We look forward to working with you.

{{signer.name}}
{{signer.title}}, {{company.name}}`,
  },
};

export type MergeContext = Record<string, unknown>;

const lookup = (ctx: MergeContext, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v != null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), ctx);
const truthy = (v: unknown): boolean => v != null && v !== '' && v !== false && v !== 0 && v !== 'no' && v !== 'false';

/** Fills a template; returns the text and the tokens it could not resolve. */
export function renderTemplate(body: string, ctx: MergeContext): { rendered: string; unknownTokens: string[] } {
  const unknown = new Set<string>();
  let out = body;
  // Blocks, innermost first: a block whose body opens no other block is resolved, then the pass repeats.
  const INNERMOST = /\{\{#(if|unless) ([\w.]+)\}\}((?:(?!\{\{#(?:if|unless) )[\s\S])*?)\{\{\/\1\}\}/g;
  for (let pass = 0; pass < 20 && INNERMOST.test(out); pass++) {
    INNERMOST.lastIndex = 0;
    out = out.replace(INNERMOST, (_m, kind: string, path: string, inner: string) => {
      const v = lookup(ctx, path);
      const keep = kind === 'if' ? truthy(v) : !truthy(v);
      return keep ? inner : '';
    });
    INNERMOST.lastIndex = 0;
  }
  out = out.replace(/\{\{([\w.]+)\}\}/g, (_m, path: string) => {
    const v = lookup(ctx, path);
    if (v === undefined) { unknown.add(path); return ''; }
    return v == null ? '' : String(v);
  });
  // Collapse blank lines left behind by removed blocks.
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { rendered: out, unknownTokens: [...unknown] };
}

export interface StoredTemplate { id: string; companyId: string | null; kind: TemplateKind; name: string; body: string; isDefault: boolean; builtIn: boolean; updatedAt: string | null }

/** A company's templates plus the built-ins, with the default per kind marked. */
export async function listTemplates(companyId: string): Promise<StoredTemplate[]> {
  const rows = await all<{ id: string; kind: string; name: string; body: string; is_default: number; updated_at: string | null; created_at: string }>(
    'SELECT * FROM document_templates WHERE company_id = ? ORDER BY kind, created_at', companyId);
  const own: StoredTemplate[] = rows.map((r) => ({ id: r.id, companyId, kind: r.kind as TemplateKind, name: r.name, body: r.body, isDefault: Number(r.is_default) === 1, builtIn: false, updatedAt: r.updated_at ?? r.created_at }));
  const builtIns: StoredTemplate[] = TEMPLATE_KINDS.map(({ kind }) => ({
    id: `builtin:${kind}`, companyId: null, kind, name: BUILT_IN_TEMPLATES[kind].name, body: BUILT_IN_TEMPLATES[kind].body,
    isDefault: !own.some((t) => t.kind === kind && t.isDefault), builtIn: true, updatedAt: null,
  }));
  return [...own, ...builtIns];
}

/** The template to use: the one asked for, else the company's default for the kind, else the built-in. */
export async function templateFor(companyId: string, kind: TemplateKind, templateId?: string | null): Promise<StoredTemplate> {
  const templates = await listTemplates(companyId);
  if (templateId) {
    const chosen = templates.find((t) => t.id === templateId && t.kind === kind);
    if (chosen) return chosen;
  }
  return templates.find((t) => t.kind === kind && t.isDefault) ?? templates.find((t) => t.kind === kind && t.builtIn)!;
}

export const AWARD_TYPE_NAMES: Record<string, string> = {
  ISO: 'Incentive Stock Option', NSO: 'Non-Statutory Stock Option', RSU: 'Restricted Stock Unit', RSA: 'Restricted Stock Award',
  SAR: 'Stock Appreciation Right', PHANTOM: 'Phantom Unit', GROWTH_SHARE: 'Growth Share',
};
export const ENTITY_WORDS: Record<string, string> = { C_CORP: 'corporation', S_CORP: 'corporation', LLC: 'limited liability company', LP: 'limited partnership', PBC: 'public benefit corporation' };
/** An amount in the documents' currency and number style, locale.currency and locale.locale ("$1,234.50"). */
function money(amount: number, maxDigits: number): string {
  const { locale, currency } = config().locale;
  return amount.toLocaleString(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: maxDigits });
}
/** Integer cents as money. Named for the default currency; it follows locale.currency. */
export const usd = (cents: number): string => money(cents / 100, 2);
/** A per-share price in integer micro-units, with up to six decimals. */
export const perShare = (micro: number): string => money(micro / 1e6, 6);
export const integer = (n: number): string => n.toLocaleString(config().locale.locale);

/** Sample values for previewing a template. */
export const SAMPLE_CONTEXT: MergeContext = {
  company: { name: 'Northstar Robotics', legalName: 'Northstar Robotics, Inc.', jurisdiction: 'Delaware', entityType: 'corporation', address: '100 Market Street, San Francisco, CA', certificateTerms: '' },
  holder: { name: 'Priya Raman', email: 'priya@example.com', address: '12 Elm Street, Oakland, CA', title: 'VP Engineering' },
  grant: { label: 'OPT-42', type: 'ISO', typeName: 'Incentive Stock Option', isIso: 'yes', quantity: '48,000', strikePrice: '$0.96', totalPrice: '$46,080.00',
    grantDate: '2026-03-01', expirationDate: '2036-03-01', vestingSchedule: '4 years, 1 year cliff, monthly', vestingStart: '2026-02-10',
    boardApprovalDate: '2026-02-27', ptepMonths: '3', earlyExercise: '' },
  plan: { name: '2022 Stock Plan', shareClass: 'Common' }, shareClass: { name: 'Common', parValue: '$0.0001', legend: '' },
  signer: { name: 'Avery Stone', title: 'Chief Executive Officer' }, message: '', today: new Date().toISOString().slice(0, 10),
  // The legends a plain, fully vested certificate for a US holder carries, read from the settings when previewed.
  get legends() {
    return config().legal.stockLegends.filter((l) => l.when === 'always' || l.when === 'notPlan').map((l) => l.text.trim()).join('\n\n');
  },
  offer: { position: 'Senior Engineer', startDate: '2026-04-01', salary: '$185,000', expiresOn: '2026-03-15' },
  convertible: { label: 'SAFE-7', instrumentName: 'Post-money SAFE', isSafe: 'yes', isNote: '', principal: '$250,000.00', issueDate: '2026-03-01', valuationCap: '$12,000,000.00', capKind: 'post-money', discount: '', interestRate: '', compounding: '', maturityDate: '', mfn: 'yes', proRata: 'yes', qualifiedFinancingMinimum: '' },
};

export async function templateById(companyId: string, id: string) {
  return one<{ id: string; kind: string; name: string; body: string; is_default: number }>('SELECT * FROM document_templates WHERE id = ? AND company_id = ?', id, companyId);
}
