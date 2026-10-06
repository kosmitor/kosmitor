/**
 * Raising with SAFEs and convertible notes: one set of terms, several
 * investors, an optional board consent, then an agreement each investor and
 * the Company sign on the platform. An instrument is outstanding, and part of
 * the conversion math, only once both have signed; the money is tracked
 * separately ("funds received").
 */
import { randomBytes } from 'node:crypto';
import { route, newId, nowISO, audit, badRequest, notFound, str, num, date, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll } from '../db.ts';
import { getCompanyData, invalidate } from '../store.ts';
import { validateEntity } from '../validation.ts';
import { sendMail, mailConfigured, type Message } from '../mail.ts';
import { renderEmail, type EmailContent } from '../email.ts';
import { config, mailSignature } from '../config.ts';
import { templateFor, renderTemplate, ENTITY_WORDS, usd, type MergeContext } from '../templates.ts';
import { convertibleFace, longDate } from '../certificate-face.ts';
import { today, INSTRUMENT_NAMES } from '@kosmitor/core';

const COMPOUNDING_WORDS: Record<string, string> = { SIMPLE: 'simple interest', ANNUAL: 'compounded annually', MONTHLY: 'compounded monthly', DAILY: 'compounded daily' };
const pct = (x: number): string => `${(x * 100).toLocaleString(config().locale.locale, { maximumFractionDigits: 2 })}%`;
/** An amount in cents, in the param file's locale and currency, for emails: "$250,000", or "$1,234.50" when there are cents. */
const money = (cents: number): string => {
  const { locale, currency } = config().locale;
  const whole = Number.isInteger(cents / 100) ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {};
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...whole }).format(cents / 100);
};

interface SigningConfig { signerName: string; signerTitle: string; templateId: string | null; message: string | null }
interface ConvertibleRow {
  id: string; company_id: string; stakeholder_id: string; instrument: string; principal: number; issue_date: string; valuation_cap: number | null;
  discount: number; interest_rate: number; compounding: string; maturity_date: string | null; mfn: number; pro_rata_right: number; status: string;
  qualified_financing_minimum: number | null; notes: string | null; label: string | null; funds_received_on: string | null; funds_reference: string | null;
  board_approval_date: string | null; signing_config: string | null; created_at: string;
}

/** Removes an entity from any pending consents, deleting consents that covered it alone. */
export async function detachFromPendingConsents(companyId: string, entityType: string, entityId: string): Promise<void> {
  const consents = await all<{ id: string; linked_entity_ids: string | null }>(
    "SELECT id, linked_entity_ids FROM board_consents WHERE company_id = ? AND linked_entity_type = ? AND status = 'PENDING'", companyId, entityType);
  for (const c of consents) {
    const ids: string[] = c.linked_entity_ids ? JSON.parse(c.linked_entity_ids) : [];
    if (!ids.includes(entityId)) continue;
    if (ids.length === 1) await run('DELETE FROM board_consents WHERE id = ?', c.id);
    else await update('board_consents', c.id, { linkedEntityIds: JSON.stringify(ids.filter((i) => i !== entityId)) });
  }
}

async function convertibleRow(ctx: Ctx, id: string): Promise<ConvertibleRow> {
  const row = await one<ConvertibleRow>('SELECT * FROM convertibles WHERE id = ? AND company_id = ?', id, ctx.companyId);
  if (!row) throw notFound('Instrument not found.');
  return row;
}

async function convertibleContext(row: ConvertibleRow, signing: SigningConfig): Promise<MergeContext> {
  const company = (await one<{ name: string; legal_name: string | null; jurisdiction: string | null; entity_type: string | null; address: string | null }>('SELECT * FROM companies WHERE id = ?', row.company_id))!;
  const holder = toCamel<{ name: string; email: string | null; address: string | null; title: string | null }>(await one('SELECT * FROM stakeholders WHERE id = ?', row.stakeholder_id))!;
  const isNote = row.instrument === 'NOTE';
  return {
    company: { name: company.name, legalName: company.legal_name ?? company.name, jurisdiction: company.jurisdiction ?? config().company.jurisdiction, entityType: ENTITY_WORDS[company.entity_type ?? ''] ?? 'company', address: company.address ?? '' },
    holder: { name: holder.name, email: holder.email ?? '', address: holder.address ?? '', title: holder.title ?? '' },
    convertible: {
      label: row.label ?? row.id.slice(-6).toUpperCase(), instrumentName: INSTRUMENT_NAMES[row.instrument] ?? row.instrument, isSafe: isNote ? '' : 'yes', isNote: isNote ? 'yes' : '',
      principal: usd(Number(row.principal)), issueDate: row.issue_date, valuationCap: row.valuation_cap ? usd(Number(row.valuation_cap)) : '',
      capKind: row.instrument === 'SAFE_POST' ? 'post-money' : 'pre-money', discount: Number(row.discount) > 0 ? pct(Number(row.discount)) : '',
      interestRate: Number(row.interest_rate) > 0 ? pct(Number(row.interest_rate)) : '', compounding: COMPOUNDING_WORDS[row.compounding] ?? row.compounding.toLowerCase(),
      maturityDate: row.maturity_date ?? '', mfn: Number(row.mfn) ? 'yes' : '', proRata: Number(row.pro_rata_right) ? 'yes' : '',
      qualifiedFinancingMinimum: row.qualified_financing_minimum ? usd(Number(row.qualified_financing_minimum)) : '',
    },
    signer: { name: signing.signerName, title: signing.signerTitle }, message: signing.message ?? '', today: today(),
  };
}

export interface InvestorSigningEmail {
  /** The investor's address and name, as their stakeholder record has them. */
  to: string;
  toName: string;
  companyName: string;
  /** The amount invested, in cents. */
  principal: number;
  /** The instrument's name: "Post-money SAFE", "Convertible note". */
  instrument: string;
  reminder: boolean;
  /** Where the investor signs: their portal. */
  link: string;
  /** The instrument's number ("SAFE-3"), so the investor can match the email to the agreement. */
  reference?: string | null;
  /** The instrument's issue date, as an ISO date. */
  date?: string | null;
}

/** What the instrument is, in a few plain words, for a reader who may not know the term. */
function instrumentMeaning(instrument: string): string | null {
  if (/\bSAFE\b/i.test(instrument)) return 'A SAFE is an agreement for future shares in the company.';
  if (/\bnote\b/i.test(instrument)) return 'A convertible note is a loan to the company that can later turn into shares.';
  return null;
}

/**
 * The email asking an investor to sign their SAFE or convertible note, or
 * reminding them to. Pure, so what it says can be tested without sending it.
 */
export function composeInvestorSigningEmail(e: InvestorSigningEmail): Message {
  const company = e.companyName;
  const product = config().brand.productName;
  const amount = money(e.principal);
  const meaning = instrumentMeaning(e.instrument);
  // Mid-sentence the name reads as a word ("your convertible note"); an acronym keeps its capitals.
  const name = /^[A-Z][a-z]/.test(e.instrument) ? `${e.instrument[0].toLowerCase()}${e.instrument.slice(1)}` : e.instrument;
  const subject = e.reminder ? `${company}: reminder to sign your ${name}` : `${company}: your ${name} is ready to sign`;
  const content: EmailContent = {
    preview: `Your ${name} for ${amount} ${e.reminder ? 'still needs' : 'is waiting for'} your signature in your portal.`,
    from: company,
    heading: e.reminder ? `Reminder: please sign your ${name}` : `Your ${name} is ready to sign`,
    greeting: `Hi ${e.toName},`,
    intro: [
      e.reminder
        ? `This is a reminder from ${company}: your ${name} for ${amount} is still waiting for your signature.`
        : `${company} has prepared your ${name} for ${amount}. It is ready for your signature.`,
      [meaning, 'Please open your portal, read the agreement and sign it.'].filter(Boolean).join(' '),
    ],
    details: [
      { label: 'Company', value: company },
      { label: 'Agreement', value: e.instrument },
      { label: 'Amount', value: amount },
      ...(e.reference ? [{ label: 'Reference', value: e.reference }] : []),
      ...(e.date ? [{ label: 'Issue date', value: longDate(e.date) }] : []),
      { label: 'Status', value: 'Waiting for your signature' },
    ],
    action: { label: 'Review and sign', url: e.link },
    actionNote: 'The button opens your portal. Sign in with this email address, then choose Review & sign next to the agreement. You sign by typing your full name, which counts as your electronic signature.',
    sections: [{
      title: 'What happens next',
      bullets: [
        `Once you and ${company} have both signed, your ${name} is recorded as outstanding: officially in place and shown on the company's cap table.`,
        'The signed agreement stays in your portal, where you can read it at any time.',
      ],
    }],
    signoff: `— ${mailSignature()}`,
    footer: `You are receiving this because ${company} manages its equity with ${product} and sent you this agreement to sign. Questions about it, or not expecting it? Contact ${company} directly.`,
  };
  return { to: e.to, toName: e.toName, subject, ...renderEmail(content, subject) };
}

async function notifyInvestor(to: { name: string; email: string | null }, facts: Omit<InvestorSigningEmail, 'to' | 'toName' | 'link'>): Promise<boolean> {
  if (!to.email || !mailConfigured()) return false;
  const delivery = await sendMail(composeInvestorSigningEmail({ ...facts, to: to.email, toName: to.name, link: `${config().app.url}/portal` }));
  return delivery.delivered;
}

/** Generates the agreement and its two signature blocks; the instrument now waits for signatures. */
export async function startConvertibleSigning(ctx: Ctx, id: string): Promise<{ documentId: string }> {
  const row = await convertibleRow(ctx, id);
  const signing: SigningConfig = row.signing_config ? JSON.parse(row.signing_config) : { signerName: ctx.user!.name, signerTitle: config().equity.signerTitle, templateId: null, message: null };
  const template = await templateFor(ctx.companyId!, 'CONVERTIBLE_AGREEMENT', signing.templateId);
  const { rendered } = renderTemplate(template.body, await convertibleContext(row, signing));
  const holder = toCamel<{ id: string; name: string; email: string | null; legalName: string | null }>(await one('SELECT * FROM stakeholders WHERE id = ?', row.stakeholder_id))!;
  const label = row.label ?? row.id.slice(-6).toUpperCase();
  const instrument = INSTRUMENT_NAMES[row.instrument] ?? row.instrument;
  const documentId = newId('doc');
  const companyRow = (await one<{ name: string; legal_name: string | null; jurisdiction: string | null; entity_type: string | null }>('SELECT * FROM companies WHERE id = ?', row.company_id))!;
  // The front page, and the legend every SAFE and note carries, before the agreement itself.
  const face = convertibleFace({
    legalName: companyRow.legal_name ?? companyRow.name, jurisdiction: companyRow.jurisdiction, entityType: companyRow.entity_type,
    label, instrument: row.instrument, instrumentName: instrument, holderName: holder.legalName || holder.name,
    principal: Number(row.principal), issueDate: row.issue_date, valuationCap: row.valuation_cap ? Number(row.valuation_cap) : null,
    discount: Number(row.discount) || 0, interestRate: Number(row.interest_rate) || 0,
    compoundingWords: COMPOUNDING_WORDS[row.compounding] ?? row.compounding.toLowerCase(), maturityDate: row.maturity_date,
    signerName: signing.signerName, signerTitle: signing.signerTitle, back: rendered,
  });
  const body = `${config().legal.convertibleLegend.trim()}\n\n${rendered}`;
  await insert('documents', {
    id: documentId, companyId: ctx.companyId, name: `${instrument} ${label} — ${holder.name}`, category: 'CONVERTIBLE_AGREEMENT',
    folder: 'Fundraising', body, face: JSON.stringify(face), stakeholderId: holder.id, securityId: row.id, requiresSignature: 1,
    status: 'AWAITING_SIGNATURE', visibility: 'HOLDER', createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  for (const sig of [
    { stakeholderId: null, signerName: `${signing.signerName}, ${signing.signerTitle} — for the Company`, signerEmail: ctx.user!.email },
    { stakeholderId: holder.id, signerName: holder.name, signerEmail: holder.email },
  ]) {
    await insert('signatures', { id: newId('sig'), companyId: ctx.companyId, documentId, ...sig, status: 'PENDING', token: randomBytes(24).toString('base64url'), sentAt: nowISO(), createdAt: nowISO() });
  }
  await update('convertibles', row.id, { status: 'PENDING_SIGNATURE' });
  invalidate(ctx.companyId!);
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  const emailed = await notifyInvestor(holder, {
    companyName: company.name, principal: Number(row.principal), instrument, reminder: false, reference: label, date: row.issue_date,
  });
  await audit(ctx, 'CONVERTIBLE_FOR_SIGNATURE', 'convertibles', row.id, `${instrument} ${label} sent to ${holder.name} for signature${emailed ? ' (emailed)' : ''}`);
  return { documentId };
}

/** An approved instrument with no agreement to sign is outstanding at once. */
export async function activateConvertible(ctx: Ctx, id: string): Promise<void> {
  const row = await convertibleRow(ctx, id);
  await update('convertibles', row.id, { status: 'OUTSTANDING' });
  invalidate(ctx.companyId!);
  await audit(ctx, 'CONVERTIBLE_ISSUED', 'convertibles', row.id, `${INSTRUMENT_NAMES[row.instrument] ?? row.instrument} ${row.label ?? row.id} for ${usd(Number(row.principal))} recorded as outstanding`);
}

/** The next free SAFE-n / NOTE-n number for the company. */
async function nextLabel(companyId: string, instrument: string): Promise<string> {
  const prefix = instrument === 'NOTE' ? 'NOTE' : 'SAFE';
  const rows = await all<{ label: string | null }>('SELECT label FROM convertibles WHERE company_id = ?', companyId);
  const highest = rows.reduce((m, r) => { const mm = new RegExp(`^${prefix}-(\\d+)$`).exec(r.label ?? ''); return mm ? Math.max(m, Number(mm[1])) : m; }, 0);
  return `${prefix}-${Math.max(highest, rows.length) + 1}`;
}

/**
 * Issues instruments to one or more investors under the same terms. With
 * approval REQUEST a single consent covers them all; with signing each
 * investor gets an agreement to sign. Otherwise they are outstanding at once.
 */
route.post('/api/c/:cid/convertibles/issue', 'write', async (ctx) => {
  const b = ctx.body;
  const terms = b.terms ?? {};
  const approval = String(b.approval ?? 'NONE');
  if (!['REQUEST', 'APPROVED', 'NONE'].includes(approval)) throw badRequest('Approval must be REQUEST, APPROVED or NONE.');
  const forSignature = b.signing != null && b.signing !== false;
  const instrument = str(terms.instrument ?? config().equity.convertibleInstrument, 'Instrument');
  if (!INSTRUMENT_NAMES[instrument]) throw badRequest('Instrument must be a post-money SAFE, pre-money SAFE, note or KISS.');
  const isSafe = instrument !== 'NOTE';
  const discount = Number(terms.discount ?? 0);
  if (!(discount >= 0 && discount < 1)) throw badRequest('Discount must be between 0 and 1 (0.2 means a 20% discount).');
  const issueDate = date(b.issueDate ?? today(), 'Issue date');
  const investors: { stakeholderId: string; principal: number; label: string | null }[] = (Array.isArray(b.investors) ? b.investors : []).map((inv: Record<string, unknown>, i: number) => ({
    stakeholderId: str(inv.stakeholderId, `Investor ${i + 1}`), principal: num(inv.principal, `Investor ${i + 1} amount`, { min: 1 }),
    label: inv.label ? str(inv.label, 'Instrument number', { max: 40 }) : null,
  }));
  if (investors.length === 0) throw badRequest('Add at least one investor.');
  const data = await getCompanyData(ctx.companyId!);
  for (const inv of investors) if (!data.stakeholders.some((s) => s.id === inv.stakeholderId)) throw badRequest('Every investor must be a stakeholder of this company.');
  const directorIds: string[] = Array.isArray(b.directorIds) ? b.directorIds.map(String) : [];
  if (approval === 'REQUEST' && directorIds.length === 0) throw badRequest('Choose at least one director to approve the instruments.');
  const signing: SigningConfig | null = forSignature ? {
    signerName: str(b.signing.signerName ?? ctx.user!.name, 'Company signatory', { max: 120 }),
    signerTitle: str(b.signing.signerTitle ?? config().equity.signerTitle, 'Signatory title', { max: 120 }),
    templateId: b.signing.templateId ? String(b.signing.templateId) : null, message: b.signing.message ? String(b.signing.message).slice(0, 2000) : null,
  } : null;
  const shared: Record<string, unknown> = {
    instrument, issueDate, valuationCap: terms.valuationCap != null && terms.valuationCap !== '' ? num(terms.valuationCap, 'Valuation cap', { min: 1 }) : null, discount,
    interestRate: isSafe ? 0 : Number(terms.interestRate ?? 0), compounding: String(terms.compounding ?? config().equity.noteCompounding),
    maturityDate: isSafe ? null : terms.maturityDate ? date(terms.maturityDate, 'Maturity date') : null,
    mfn: terms.mfn ? 1 : 0, proRataRight: terms.proRataRight ? 1 : 0,
    qualifiedFinancingMinimum: terms.qualifiedFinancingMinimum != null && terms.qualifiedFinancingMinimum !== '' ? num(terms.qualifiedFinancingMinimum, 'Qualified financing minimum', { min: 1 }) : null,
    convertedIntoShareClassId: null, convertedOn: null, notes: b.notes ? String(b.notes).slice(0, 2000) : null,
    boardApprovalDate: approval === 'APPROVED' ? date(b.boardApprovalDate ?? today(), 'Board approval date') : null,
  };
  if (!isSafe && !(Number(shared.interestRate) >= 0 && Number(shared.interestRate) < 1)) throw badRequest('Interest rate must be between 0 and 1 (0.08 means 8% per year).');

  const ids: string[] = [];
  for (const inv of investors) {
    const id = newId('cnv');
    const values = { ...shared, stakeholderId: inv.stakeholderId, principal: inv.principal, label: inv.label ?? await nextLabel(ctx.companyId!, instrument), status: approval === 'REQUEST' ? 'PENDING_APPROVAL' : forSignature ? 'PENDING_SIGNATURE' : 'OUTSTANDING' };
    await validateEntity('convertibles', values, ctx.companyId!);
    await insert('convertibles', { id, companyId: ctx.companyId, ...values, status: approval === 'REQUEST' ? 'PENDING_APPROVAL' : 'PENDING_SIGNATURE', signingConfig: signing ? JSON.stringify(signing) : null, createdAt: nowISO() });
    ids.push(id);
  }

  let consent: Record<string, unknown> | null = null;
  const total = investors.reduce((s, i) => s + i.principal, 0);
  const name = INSTRUMENT_NAMES[instrument];
  if (approval === 'REQUEST') {
    const consentId = newId('con');
    const holders = investors.map((i) => data.stakeholders.find((s) => s.id === i.stakeholderId)?.name ?? 'investor');
    await insert('board_consents', {
      id: consentId, companyId: ctx.companyId, title: `Approve ${investors.length > 1 ? `${investors.length} ${name}s` : `${name}`} totalling ${usd(total)}`,
      type: 'WRITTEN_CONSENT', status: 'PENDING', effectiveDate: issueDate, linkedEntityType: 'convertibles', linkedEntityIds: JSON.stringify(ids),
      body: `RESOLVED, that the Company issue ${name}s in the aggregate purchase amount of ${usd(total)} to ${holders.join(', ')}${shared.valuationCap ? ` with a ${instrument === 'SAFE_POST' ? 'post-money' : 'pre-money'} valuation cap of ${usd(Number(shared.valuationCap))}` : ' without a valuation cap'}${discount ? ` and a ${pct(discount)} discount` : ''}, and that the officers of the Company are authorised to execute the instruments.`,
      createdBy: ctx.user!.name, createdAt: nowISO(),
    });
    for (const directorId of directorIds) await insert('board_votes', { id: newId('vot'), consentId, stakeholderId: directorId, vote: 'PENDING', createdAt: nowISO() });
    consent = toCamel(await one('SELECT * FROM board_consents WHERE id = ?', consentId)) ?? null;
    await audit(ctx, 'CREATE', 'convertibles', ids[0], `${investors.length} ${name}${investors.length > 1 ? 's' : ''} drafted for ${usd(total)} — awaiting board approval`);
  } else if (signing) {
    for (const id of ids) await startConvertibleSigning(ctx, id);
  } else {
    for (const id of ids) await activateConvertible(ctx, id);
  }
  invalidate(ctx.companyId!);
  const rows = toCamelAll<Record<string, unknown>>(await all(`SELECT * FROM convertibles WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ...ids));
  const documents = toCamelAll<Record<string, unknown>>(await all(`SELECT * FROM documents WHERE category = 'CONVERTIBLE_AGREEMENT' AND security_id IN (${ids.map(() => '?').join(',')})`, ...ids));
  return { convertibles: rows, consent, documents };
});

route.post('/api/c/:cid/convertibles/:id/cancel-signing', 'write', async (ctx) => {
  const row = await convertibleRow(ctx, ctx.params.id);
  if (!['PENDING_APPROVAL', 'PENDING_SIGNATURE'].includes(row.status)) throw badRequest('Only an instrument that is not yet outstanding can be withdrawn.');
  await run('DELETE FROM documents WHERE security_id = ? AND company_id = ?', row.id, ctx.companyId);
  await detachFromPendingConsents(ctx.companyId!, 'convertibles', row.id);
  await run('DELETE FROM convertibles WHERE id = ?', row.id);
  invalidate(ctx.companyId!);
  await audit(ctx, 'WITHDRAW', 'convertibles', row.id, `${INSTRUMENT_NAMES[row.instrument] ?? row.instrument} ${row.label ?? row.id} withdrawn before issue`);
  return { ok: true };
});

route.post('/api/c/:cid/convertibles/:id/remind', 'write', async (ctx) => {
  const row = await convertibleRow(ctx, ctx.params.id);
  if (row.status !== 'PENDING_SIGNATURE') throw badRequest('This instrument is not waiting for signatures.');
  const doc = await one<{ id: string }>("SELECT id FROM documents WHERE security_id = ? AND category = 'CONVERTIBLE_AGREEMENT'", row.id);
  const pending = doc ? await one<{ id: string }>("SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id = ? AND status = 'PENDING'", doc.id, row.stakeholder_id) : null;
  if (!pending) throw badRequest('The investor has already signed; the Company\'s countersignature is what remains.');
  const holder = toCamel<{ name: string; email: string | null }>(await one('SELECT name, email FROM stakeholders WHERE id = ?', row.stakeholder_id))!;
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  const emailed = await notifyInvestor(holder, {
    companyName: company.name, principal: Number(row.principal), instrument: INSTRUMENT_NAMES[row.instrument] ?? row.instrument,
    reminder: true, reference: row.label ?? row.id.slice(-6).toUpperCase(), date: row.issue_date,
  });
  if (emailed) await update('signatures', pending.id, { sentAt: nowISO() });
  return { emailed, reason: emailed ? null : !holder.email ? 'The investor has no email address on record.' : 'Email is not configured on this server.' };
});

/** Records that the investor's money arrived. */
route.post('/api/c/:cid/convertibles/:id/funds-received', 'write', async (ctx) => {
  const row = await convertibleRow(ctx, ctx.params.id);
  if (!['PENDING_SIGNATURE', 'OUTSTANDING', 'CONVERTED'].includes(row.status)) throw badRequest('Record funds once the instrument has been issued.');
  const receivedOn = date(ctx.body.receivedOn ?? today(), 'Date received');
  const reference = ctx.body.reference ? str(ctx.body.reference, 'Reference', { max: 200 }) : null;
  await update('convertibles', row.id, { fundsReceivedOn: receivedOn, fundsReference: reference });
  invalidate(ctx.companyId!);
  await audit(ctx, 'FUNDS_RECEIVED', 'convertibles', row.id, `${usd(Number(row.principal))} received for ${row.label ?? row.id} on ${receivedOn}${reference ? ` (${reference})` : ''}`);
  return toCamel(await one('SELECT * FROM convertibles WHERE id = ?', row.id));
});
