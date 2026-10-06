import { randomBytes } from 'node:crypto';
import { route, newId, nowISO, audit, badRequest, notFound, forbidden, str, num, date, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll } from '../db.ts';
import { getCompanyData, invalidate } from '../store.ts';
import { validateEntity } from '../validation.ts';
import { sendMail, mailConfigured, type Message } from '../mail.ts';
import { renderEmail, type EmailContent } from '../email.ts';
import { stockFace, awardFace, faceText, stockLegends, isNonUsHolder, type CertificateFace } from '../certificate-face.ts';
import { config, mailSignature } from '../config.ts';
import { listTemplates, templateFor, templateById, renderTemplate, TEMPLATE_KINDS, MERGE_FIELDS, SAMPLE_CONTEXT, AWARD_TYPE_NAMES, ENTITY_WORDS as ENTITY_NAMES, usd as fmtUsd, perShare as fmtPerShare, integer as fmtInt, type TemplateKind, type MergeContext } from '../templates.ts';
import { removeStoredFile, securityKind, isSubjectKind, isDocumentCategory } from './files.ts';
import { changedSinceSigned, signedHash } from './certificates.ts';
import { documentFolder } from '../folders.ts';
import { startConvertibleSigning, activateConvertible, detachFromPendingConsents } from './fundraising.ts';
import { updatesFor, markUpdateRead } from './communications.ts';
import { isEditor, seesWholeCompany, seesWholeVault } from '../auth.ts';
import {
  computeCapTable, activeValuation, summarizeVesting, vestingCurve, portfolioValue, modelExercise,
  shareValue, roundShares, today, addMonths, formatShares, formatPPS, splitFactor, INSTRUMENT_NAMES, TRANSACTION_TYPES, REWOUND_TYPES, formatMoney, mfnCandidates,
} from '@kosmitor/core';

// A certificate or grant keeps the share count and price of the day it was
// recorded; a later stock split is applied when the cap table is read
// (normalizeSplits). A row written for an event — the new certificate on a
// transfer, the shares issued on an exercise, the ledger entry — is dated that
// day, so it is written in that day's shares: splitFactor(data, recorded, event)
// of them for every share as recorded, at the price divided by the same.

// ---------------------------------------------------------------------------
// Option exercises
// ---------------------------------------------------------------------------

route.get('/api/c/:cid/exercises', 'read', async (ctx) =>
  toCamelAll(await all('SELECT * FROM exercises WHERE company_id = ? ORDER BY exercise_date DESC', ctx.companyId)));

/**
 * Exercises a grant: validates the vested balance, records the exercise, issues
 * the resulting shares and writes the ledger entry — all in one transaction so
 * the cap table can never show shares without a matching exercise.
 */
// ---------------------------------------------------------------------------
// Issuing grants: board approval, agreement for signature, templates
// ---------------------------------------------------------------------------

interface SigningConfig { signerName: string; signerTitle: string; templateId: string | null; message: string | null }

/** Merge context for a grant's documents. */
async function grantContext(companyId: string, awardId: string, signing: SigningConfig): Promise<MergeContext> {
  const data = await getCompanyData(companyId);
  const award = data.awards.find((a) => a.id === awardId);
  if (!award) throw notFound('Grant not found.');
  const company = (await one<{ name: string; legal_name: string | null; jurisdiction: string | null; entity_type: string | null; address: string | null }>('SELECT * FROM companies WHERE id = ?', companyId))!;
  const holder = toCamel<{ name: string; email: string | null; address: string | null; title: string | null }>(await one('SELECT * FROM stakeholders WHERE id = ?', award.stakeholderId))!;
  const plan = data.pools.find((p) => p.id === award.poolId);
  const shareClass = data.shareClasses.find((c) => c.id === plan?.shareClassId);
  const schedule = data.vestingSchedules.find((v) => v.id === award.vestingScheduleId);
  return {
    company: { name: company.name, legalName: company.legal_name ?? company.name, jurisdiction: company.jurisdiction ?? config().company.jurisdiction, entityType: ENTITY_NAMES[company.entity_type ?? ''] ?? 'company', address: company.address ?? '' },
    holder: { name: holder.name, email: holder.email ?? '', address: holder.address ?? '', title: holder.title ?? '' },
    grant: {
      label: award.label ?? award.id.slice(-6).toUpperCase(), type: award.type, typeName: AWARD_TYPE_NAMES[award.type] ?? award.type, isIso: award.type === 'ISO' ? 'yes' : '',
      quantity: fmtInt(award.quantity), strikePrice: award.strikePrice > 0 ? fmtPerShare(award.strikePrice) : '', totalPrice: fmtUsd(Math.round((award.quantity * award.strikePrice) / 10_000)),
      grantDate: award.grantDate, expirationDate: award.expirationDate ?? '', vestingSchedule: schedule?.name ?? '', vestingStart: award.vestingStartDate,
      boardApprovalDate: award.boardApprovalDate ?? '', ptepMonths: String(award.ptepMonths ?? config().equity.postTerminationExerciseMonths), earlyExercise: award.earlyExerciseAllowed ? 'yes' : '',
    },
    plan: { name: plan?.name ?? '', shareClass: shareClass?.name ?? '' }, shareClass: { name: shareClass?.name ?? '', parValue: shareClass ? fmtPerShare(shareClass.parValue) : '' },
    signer: { name: signing.signerName, title: signing.signerTitle }, message: signing.message ?? '', today: today(),
  };
}

/**
 * The ISSUANCE entry of a certificate an event creates (an exercise, a transfer, a
 * conversion), dated the event, in that day's shares. The database refuses the
 * certificate without it (db.ts, ledger_entry_required).
 */
export async function recordIssuance(ctx: Ctx, issuanceId: string, v: Record<string, unknown>, memo: string): Promise<void> {
  const quantity = Number(v.quantity), price = Number(v.pricePerShare ?? 0);
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'ISSUANCE', date: v.issueDate, stakeholderId: v.stakeholderId, securityId: issuanceId,
    shareClassId: v.shareClassId ?? null, quantity, pricePerShare: price, amount: Math.round((quantity * price) / 10_000),
    memo, createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
  });
}

/** An approved grant with no agreement to sign becomes outstanding and enters the ledger. */
async function issueApprovedAward(ctx: Ctx, awardId: string): Promise<void> {
  const award = toCamel<Record<string, unknown>>(await one('SELECT * FROM awards WHERE id = ? AND company_id = ?', awardId, ctx.companyId));
  if (!award) throw notFound('Grant not found.');
  await update('awards', awardId, { status: 'OUTSTANDING' });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'GRANT', date: award.grantDate, stakeholderId: award.stakeholderId, counterpartyId: null,
    securityId: awardId, shareClassId: null, quantity: Number(award.quantity), pricePerShare: Number(award.strikePrice ?? 0), amount: null,
    memo: `${award.label ?? 'Grant'} granted`, createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'GRANT_ISSUED', 'awards', awardId, `Grant ${award.label ?? awardId} approved by the board and recorded`);
}

/** Generates the agreement and its two signature blocks; the grant now waits for signatures. */
export async function startAwardSigning(ctx: Ctx, awardId: string): Promise<{ documentId: string }> {
  const row = await one<{ signing_config: string | null; stakeholder_id: string; label: string | null; type: string; quantity: number; grant_date: string | null }>('SELECT * FROM awards WHERE id = ? AND company_id = ?', awardId, ctx.companyId);
  if (!row) throw notFound('Grant not found.');
  const signing: SigningConfig = row.signing_config ? JSON.parse(row.signing_config) : { signerName: ctx.user!.name, signerTitle: config().equity.signerTitle, templateId: null, message: null };
  const kind: TemplateKind = row.type === 'RSU' || row.type === 'PHANTOM' ? 'RSU_AGREEMENT' : 'OPTION_AGREEMENT';
  const template = await templateFor(ctx.companyId!, kind, signing.templateId);
  const context = await grantContext(ctx.companyId!, awardId, signing);
  const { rendered } = renderTemplate(template.body, context);
  const holder = toCamel<{ id: string; name: string; email: string | null; legalName: string | null }>(await one('SELECT * FROM stakeholders WHERE id = ?', row.stakeholder_id))!;
  const documentId = newId('doc');
  const label = row.label ?? awardId.slice(-6).toUpperCase();
  // The front page, from the grant as it stands now; the agreement follows it.
  const data = await getCompanyData(ctx.companyId!);
  const award = data.awards.find((a) => a.id === awardId)!;
  const plan = data.pools.find((p) => p.id === award.poolId);
  const shareClass = data.shareClasses.find((c) => c.id === plan?.shareClassId);
  const schedule = data.vestingSchedules.find((v) => v.id === award.vestingScheduleId);
  const companyRow = (await one<{ name: string; legal_name: string | null; jurisdiction: string | null; entity_type: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId))!;
  const face = awardFace({
    legalName: companyRow.legal_name ?? companyRow.name, jurisdiction: companyRow.jurisdiction, entityType: companyRow.entity_type,
    label, type: award.type, typeName: AWARD_TYPE_NAMES[award.type] ?? award.type, holderName: holder.legalName || holder.name,
    quantity: award.quantity, strikePrice: award.strikePrice, className: shareClass?.name ?? 'Common', planName: plan?.name ?? null,
    grantDate: award.grantDate, vestingSchedule: schedule?.name ?? null, vestingStart: award.vestingStartDate, expirationDate: award.expirationDate ?? null,
    signerName: signing.signerName, signerTitle: signing.signerTitle, back: rendered,
  });
  await insert('documents', {
    id: documentId, companyId: ctx.companyId, name: `${kind === 'RSU_AGREEMENT' ? 'RSU award agreement' : 'Option agreement'} ${label} — ${holder.name}`, category: 'GRANT_AGREEMENT',
    folder: 'Equity awards', body: rendered, face: JSON.stringify(face), stakeholderId: holder.id, securityId: awardId, requiresSignature: 1,
    status: 'AWAITING_SIGNATURE', visibility: 'HOLDER', createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  for (const sig of [
    { stakeholderId: null, signerName: `${signing.signerName}, ${signing.signerTitle} — for the Company`, signerEmail: ctx.user!.email },
    { stakeholderId: holder.id, signerName: holder.name, signerEmail: holder.email },
  ]) {
    await insert('signatures', { id: newId('sig'), companyId: ctx.companyId, documentId, ...sig, status: 'PENDING', token: randomBytes(24).toString('base64url'), sentAt: nowISO(), createdAt: nowISO() });
  }
  await update('awards', awardId, { status: 'PENDING_SIGNATURE' });
  invalidate(ctx.companyId!);
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  const emailed = await notifyHolder(holder, {
    companyName: company.name, shares: Number(row.quantity), className: `${AWARD_TYPE_NAMES[row.type] ?? row.type}s`,
    reminder: false, what: 'agreement', reference: label, date: row.grant_date,
  });
  await audit(ctx, 'GRANT_FOR_SIGNATURE', 'awards', awardId, `Grant ${label} sent for signature${emailed ? ' (holder emailed)' : ''}`);
  return { documentId };
}

/**
 * Issues a grant the way a company actually does it: optionally through a
 * board consent, then an agreement both parties sign on the platform. The
 * grant is outstanding only once both have signed.
 */
route.post('/api/c/:cid/awards/issue', 'write', async (ctx) => {
  const b = ctx.body;
  const approval = String(b.approval ?? 'NONE');
  if (!['REQUEST', 'APPROVED', 'NONE'].includes(approval)) throw badRequest('Approval must be REQUEST, APPROVED or NONE.');
  const forSignature = b.signing != null && b.signing !== false;
  const stakeholderId = str(b.stakeholderId, 'Recipient');
  const poolId = str(b.poolId, 'Equity plan');
  const type = str(b.type, 'Award type');
  const quantity = num(b.quantity, 'Quantity', { min: 1 });
  const settlesForFree = type === 'RSU' || type === 'PHANTOM';
  const strikePrice = settlesForFree ? 0 : num(b.strikePrice ?? 0, 'Strike price', { min: 0 });
  const grantDate = date(b.grantDate ?? today(), 'Grant date');
  const vestingScheduleId = str(b.vestingScheduleId, 'Vesting schedule');
  const { postTerminationExerciseMonths: ptep } = config().equity;
  // An ISO cannot run past ten years by law (IRC 422(b)(3)), whatever equity.optionTermYears says.
  const optionTermYears = type === 'ISO' ? Math.min(10, config().equity.optionTermYears) : config().equity.optionTermYears;
  const values: Record<string, unknown> = {
    label: b.label ? str(b.label, 'Grant number', { max: 40 }) : null, stakeholderId, poolId, type, quantity, strikePrice, grantDate,
    vestingStartDate: b.vestingStartDate ? date(b.vestingStartDate, 'Vesting start') : grantDate, vestingScheduleId,
    expirationDate: b.expirationDate ? date(b.expirationDate, 'Expiration') : `${Number(grantDate.slice(0, 4)) + optionTermYears}${grantDate.slice(4)}`,
    ptepMonths: Number(b.ptepMonths ?? ptep) || ptep, earlyExerciseAllowed: b.earlyExerciseAllowed ? 1 : 0, exercisedQuantity: 0, cancelledQuantity: 0,
    boardApprovalDate: approval === 'APPROVED' ? date(b.boardApprovalDate ?? today(), 'Board approval date') : null, acceptedDate: null,
    fmvAtGrant: num(b.fmvAtGrant ?? strikePrice, 'FMV at grant', { min: 0 }), rsuLiquidityCondition: 0, notes: b.notes ? String(b.notes).slice(0, 2000) : null,
    status: approval === 'REQUEST' ? 'PENDING_APPROVAL' : forSignature ? 'PENDING_SIGNATURE' : 'OUTSTANDING',
  };
  await validateEntity('awards', values, ctx.companyId!);
  if (!values.label) {
    const labels = await all<{ label: string | null }>('SELECT label FROM awards WHERE company_id = ?', ctx.companyId);
    const highest = labels.reduce((m, r) => { const mm = /^OPT-(\d+)$/.exec(r.label ?? ''); return mm ? Math.max(m, Number(mm[1])) : m; }, 0);
    values.label = `OPT-${Math.max(highest, labels.length) + 1}`;
  }
  const signing: SigningConfig | null = forSignature ? {
    signerName: str(b.signing.signerName ?? ctx.user!.name, 'Company signatory', { max: 120 }),
    signerTitle: str(b.signing.signerTitle ?? config().equity.signerTitle, 'Signatory title', { max: 120 }),
    templateId: b.signing.templateId ? String(b.signing.templateId) : null, message: b.signing.message ? String(b.signing.message).slice(0, 2000) : null,
  } : null;
  const awardId = newId('awa');
  await insert('awards', { id: awardId, companyId: ctx.companyId, ...values, status: approval === 'REQUEST' ? 'PENDING_APPROVAL' : 'DRAFT', signingConfig: signing ? JSON.stringify(signing) : null, createdAt: nowISO() });

  let consent: Record<string, unknown> | null = null;
  if (approval === 'REQUEST') {
    const directorIds: string[] = Array.isArray(b.directorIds) ? b.directorIds.map(String) : [];
    if (directorIds.length === 0) throw badRequest('Choose at least one director to approve the grant.');
    const holder = await one<{ name: string }>('SELECT name FROM stakeholders WHERE id = ?', stakeholderId);
    const consentId = newId('con');
    await insert('board_consents', {
      id: consentId, companyId: ctx.companyId, title: `Approve ${AWARD_TYPE_NAMES[type] ?? type} grant of ${fmtInt(quantity)} shares to ${holder?.name ?? 'stakeholder'}`,
      type: 'WRITTEN_CONSENT', status: 'PENDING', effectiveDate: grantDate, linkedEntityType: 'awards', linkedEntityIds: JSON.stringify([awardId]),
      body: `RESOLVED, that the Company grant ${holder?.name ?? 'the recipient'} ${fmtInt(quantity)} ${AWARD_TYPE_NAMES[type] ?? type}s under the equity plan${strikePrice ? ` at an exercise price of ${fmtPerShare(strikePrice)} per share, being the fair market value determined by the board` : ''}, vesting as set out in the grant, and that the officers of the Company are authorised to execute the award agreement.`,
      createdBy: ctx.user!.name, createdAt: nowISO(),
    });
    for (const directorId of directorIds) await insert('board_votes', { id: newId('vot'), consentId, stakeholderId: directorId, vote: 'PENDING', createdAt: nowISO() });
    consent = toCamel(await one('SELECT * FROM board_consents WHERE id = ?', consentId)) ?? null;
    await audit(ctx, 'CREATE', 'awards', awardId, `Grant ${values.label} drafted — awaiting board approval`);
  } else if (signing) {
    await startAwardSigning(ctx, awardId);
  } else {
    await issueApprovedAward(ctx, awardId);
  }
  if (b.offerId) {
    const offer = await one<{ id: string; status: string }>('SELECT id, status FROM offers WHERE id = ? AND company_id = ?', String(b.offerId), ctx.companyId);
    if (offer && offer.status === 'ACCEPTED') {
      await update('offers', offer.id, { status: 'CONVERTED', awardId, updatedAt: nowISO() });
      await audit(ctx, 'CONVERT', 'offers', offer.id, `Offer turned into grant ${values.label}`);
    }
  }
  invalidate(ctx.companyId!);
  const award = toCamel(await one('SELECT * FROM awards WHERE id = ?', awardId));
  const doc = toCamel<Record<string, unknown>>(await one("SELECT * FROM documents WHERE security_id = ? AND category = 'GRANT_AGREEMENT'", awardId));
  return { award, consent, document: doc ?? null, signatures: doc ? toCamelAll(await all('SELECT * FROM signatures WHERE document_id = ? ORDER BY created_at', doc.id)) : [] };
});

/** Withdraws a grant that is still awaiting approval or signatures, with its consent and agreement. */
route.post('/api/c/:cid/awards/:id/cancel-signing', 'write', async (ctx) => {
  const award = await one<{ id: string; status: string; label: string | null }>('SELECT * FROM awards WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!award) throw notFound('Grant not found.');
  if (!['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE'].includes(award.status)) throw badRequest('Only a grant that is not yet outstanding can be withdrawn.');
  await withdrawDocuments(ctx, award.id, `grant ${award.label ?? award.id} withdrawn before every party signed`);
  await detachFromPendingConsents(ctx.companyId!, 'awards', award.id);
  await run('DELETE FROM awards WHERE id = ? AND company_id = ?', award.id, ctx.companyId);
  invalidate(ctx.companyId!);
  await audit(ctx, 'WITHDRAW', 'awards', award.id, `Grant ${award.label ?? award.id} withdrawn before issue`);
  return { ok: true };
});

route.post('/api/c/:cid/awards/:id/remind', 'write', async (ctx) => {
  const award = toCamel<{ id: string; status: string; quantity: number; type: string; stakeholderId: string; label: string | null; grantDate: string | null }>(await one('SELECT * FROM awards WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!award) throw notFound('Grant not found.');
  if (award.status !== 'PENDING_SIGNATURE') throw badRequest('This grant is not waiting for signatures.');
  const doc = await one<{ id: string }>("SELECT id FROM documents WHERE security_id = ? AND category = 'GRANT_AGREEMENT'", award.id);
  const pending = doc ? await one<{ id: string }>("SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id = ? AND status = 'PENDING'", doc.id, award.stakeholderId) : null;
  if (!pending) throw badRequest('The holder has already signed; the Company\'s countersignature is what remains.');
  const holder = toCamel<{ name: string; email: string | null }>(await one('SELECT name, email FROM stakeholders WHERE id = ?', award.stakeholderId))!;
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  const emailed = await notifyHolder(holder, {
    companyName: company.name, shares: Number(award.quantity), className: `${AWARD_TYPE_NAMES[award.type] ?? award.type}s`,
    reminder: true, what: 'agreement', reference: award.label ?? award.id.slice(-6).toUpperCase(), date: award.grantDate,
  });
  if (emailed) await update('signatures', pending.id, { sentAt: nowISO() });
  return { emailed, reason: emailed ? null : !holder.email ? 'The holder has no email address on record.' : 'Email is not configured on this server.' };
});

// --- Templates ---------------------------------------------------------------

route.get('/api/c/:cid/templates', 'read', async (ctx) => ({
  templates: await listTemplates(ctx.companyId!), kinds: TEMPLATE_KINDS, fields: MERGE_FIELDS,
}));

route.post('/api/c/:cid/templates/preview', 'read', async (ctx) => {
  const body = str(ctx.body.body, 'Template', { max: 50_000 });
  return renderTemplate(body, { ...SAMPLE_CONTEXT, today: today() });
});

route.post('/api/c/:cid/templates', 'write', async (ctx) => {
  const kind = str(ctx.body.kind, 'Kind') as TemplateKind;
  if (!TEMPLATE_KINDS.some((k) => k.kind === kind)) throw badRequest('Unknown template kind.');
  const id = newId('tpl');
  const isDefault = ctx.body.isDefault ? 1 : 0;
  if (isDefault) await run('UPDATE document_templates SET is_default = 0 WHERE company_id = ? AND kind = ?', ctx.companyId, kind);
  await insert('document_templates', {
    id, companyId: ctx.companyId, kind, name: str(ctx.body.name, 'Name', { max: 120 }), body: str(ctx.body.body, 'Template', { max: 50_000 }),
    isDefault, createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  await audit(ctx, 'CREATE', 'document_templates', id, `Template "${ctx.body.name}" created`);
  return toCamel(await one('SELECT * FROM document_templates WHERE id = ?', id));
});

route.patch('/api/c/:cid/templates/:id', 'write', async (ctx) => {
  const existing = await templateById(ctx.companyId!, ctx.params.id);
  if (!existing) throw notFound('Template not found.');
  const values: Record<string, unknown> = { updatedAt: nowISO() };
  if (ctx.body.name != null) values.name = str(ctx.body.name, 'Name', { max: 120 });
  if (ctx.body.body != null) values.body = str(ctx.body.body, 'Template', { max: 50_000 });
  if (ctx.body.isDefault != null) {
    values.isDefault = ctx.body.isDefault ? 1 : 0;
    if (ctx.body.isDefault) await run('UPDATE document_templates SET is_default = 0 WHERE company_id = ? AND kind = ?', ctx.companyId, existing.kind);
  }
  await update('document_templates', ctx.params.id, values);
  await audit(ctx, 'UPDATE', 'document_templates', ctx.params.id, `Template "${existing.name}" updated`);
  return toCamel(await one('SELECT * FROM document_templates WHERE id = ?', ctx.params.id));
});

route.del('/api/c/:cid/templates/:id', 'write', async (ctx) => {
  const existing = await templateById(ctx.companyId!, ctx.params.id);
  if (!existing) throw notFound('Template not found.');
  await run('DELETE FROM document_templates WHERE id = ?', ctx.params.id);
  await audit(ctx, 'DELETE', 'document_templates', ctx.params.id, `Template "${existing.name}" deleted`);
  return { ok: true };
});

/** How many options a grant's holder could exercise on a date, and why the rest cannot be. */
async function exercisableOn(companyId: string, awardId: string, onDate: string) {
  const data = await getCompanyData(companyId);
  const award = data.awards.find((a) => a.id === awardId);
  if (!award) throw notFound('Grant not found.');
  if (award.status !== 'OUTSTANDING') throw badRequest('Only outstanding grants can be exercised.');
  if (award.type === 'RSU' || award.type === 'PHANTOM') throw badRequest('RSUs settle on vesting rather than being exercised.');
  const schedule = data.vestingSchedules.find((s) => s.id === award.vestingScheduleId);
  const holder = data.stakeholders.find((s) => s.id === award.stakeholderId);
  const summary = schedule
    ? summarizeVesting({ schedule, totalQuantity: award.quantity, vestingStartDate: award.vestingStartDate, terminationDate: holder?.terminationDate ?? null }, onDate)
    : null;
  const outstanding = roundShares(award.quantity - award.exercisedQuantity - award.cancelledQuantity);
  const exercisable = award.earlyExerciseAllowed ? outstanding : Math.max(0, roundShares((summary?.vested ?? award.quantity) - award.exercisedQuantity));
  return { data, award, holder, summary, outstanding, exercisable, fmv: activeValuation(data, onDate) };
}

/** Records an exercise: shares issued, the grant reduced, the ledger written. Shared by the direct route and approved requests. */
async function performExercise(ctx: Ctx, awardId: string, body: { quantity: unknown; exerciseDate?: unknown; method?: unknown; notes?: unknown }) {
  const quantity = num(body.quantity, 'Quantity', { min: 1 });
  const exerciseDate = date(body.exerciseDate ?? today(), 'Exercise date');
  const method = str(body.method ?? 'CASH', 'Method');
  const { data, award, holder, summary, exercisable } = await exercisableOn(ctx.companyId!, awardId, exerciseDate);
  if (!['CASH', 'CASHLESS', 'NET_EXERCISE', 'PROMISSORY_NOTE'].includes(method)) {
    throw badRequest('Choose a valid exercise method.');
  }

  if (quantity > exercisable + 1e-9) {
    throw badRequest(
      `Only ${formatShares(exercisable)} shares are exercisable on ${exerciseDate}` +
      (award.earlyExerciseAllowed ? '.' : ` (${formatShares(summary?.unvested ?? 0)} shares are still unvested).`),
    );
  }
  if (holder?.terminationDate) {
    // A recorded 0 is a window that closes on the day the holder leaves, as the cap table reads it (awardIsLive).
    const deadline = addMonths(holder.terminationDate, award.ptepMonths ?? config().equity.postTerminationExerciseMonths);
    if (exerciseDate > deadline) {
      throw badRequest(`The post-termination exercise window closed on ${deadline}.`);
    }
  }
  if (award.expirationDate && exerciseDate > award.expirationDate) {
    throw badRequest(`This grant expired on ${award.expirationDate}.`);
  }

  // The quantity is in options as the grant records them; the shares, the
  // exercise and the fair market value are in the shares of the exercise date.
  const k = splitFactor(data, award.grantDate, exerciseDate);
  const shares = roundShares(quantity * k);
  const strike = k === 1 ? award.strikePrice : Math.round(award.strikePrice / k);
  const fmv = activeValuation(data, exerciseDate);
  const totalCost = shareValue(quantity, award.strikePrice);
  const spread = Math.max(0, shareValue(shares, fmv) - totalCost);

  // Net exercise withholds shares worth the strike, so fewer shares are issued.
  let sharesIssued = shares;
  if (method === 'NET_EXERCISE' || method === 'CASHLESS') {
    sharesIssued = fmv > 0 ? Math.floor(shares - (quantity * award.strikePrice) / fmv) : 0;
    if (sharesIssued <= 0) throw badRequest('A net exercise yields no shares at the current fair market value.');
  }

  const pool = data.pools.find((p) => p.id === award.poolId);
  const issuanceId = newId('iss');
  const exerciseId = newId('exr');
  const certNo = `EX-${String((await all('SELECT id FROM issuances WHERE company_id = ?', ctx.companyId)).length + 1).padStart(4, '0')}`;

  await insert('issuances', {
    id: issuanceId, companyId: ctx.companyId, certificateNo: certNo,
    stakeholderId: award.stakeholderId,
    shareClassId: pool?.shareClassId ?? data.shareClasses.find((c) => c.kind === 'COMMON')?.id,
    quantity: sharesIssued, pricePerShare: strike, issueDate: exerciseDate,
    status: 'OUTSTANDING',
    vestingScheduleId: award.earlyExerciseAllowed && summary && summary.unvested > 0 ? award.vestingScheduleId : null,
    vestingStartDate: award.earlyExerciseAllowed ? award.vestingStartDate : null,
    earlyExercised: award.earlyExerciseAllowed && (summary?.unvested ?? 0) > 0 ? 1 : 0,
    election83bFiledOn: null, sourceAwardId: award.id, boardApprovalDate: null,
    notes: `Issued on exercise of ${award.label ?? award.id}`, createdAt: nowISO(),
  });
  await recordIssuance(ctx, issuanceId, { stakeholderId: award.stakeholderId, shareClassId: pool?.shareClassId ?? data.shareClasses.find((c) => c.kind === 'COMMON')?.id,
    quantity: sharesIssued, pricePerShare: strike, issueDate: exerciseDate }, `Certificate ${certNo} issued on exercise of ${award.label ?? 'a grant'}`);

  await insert('exercises', {
    id: exerciseId, companyId: ctx.companyId, awardId: award.id, stakeholderId: award.stakeholderId,
    quantity: shares, exerciseDate, method, strikePrice: strike, fmvAtExercise: fmv,
    totalCost, spread, sharesIssued, issuanceId, status: 'COMPLETED',
    notes: body.notes ?? null, createdAt: nowISO(),
  });

  const newExercised = roundShares(award.exercisedQuantity + quantity);
  await update('awards', award.id, {
    exercisedQuantity: newExercised,
    status: newExercised >= roundShares(award.quantity - award.cancelledQuantity) ? 'EXERCISED' : 'OUTSTANDING',
  });

  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'EXERCISE', date: exerciseDate,
    stakeholderId: award.stakeholderId, counterpartyId: null, securityId: award.id,
    shareClassId: pool?.shareClassId ?? null, quantity: shares, pricePerShare: strike,
    amount: totalCost, memo: `${method} exercise of ${award.label ?? 'grant'} (${formatShares(sharesIssued)} shares issued)`,
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });

  invalidate(ctx.companyId!);
  await audit(ctx, 'EXERCISE', 'awards', award.id,
    `${formatShares(quantity)} options exercised at ${formatPPS(award.strikePrice)} (${method})` +
    (k === 1 ? '' : `, ${formatShares(shares)} shares at ${formatPPS(strike)} after the stock split`));

  return {
    exercise: toCamel(await one('SELECT * FROM exercises WHERE id = ?', exerciseId)),
    issuance: toCamel(await one('SELECT * FROM issuances WHERE id = ?', issuanceId)),
    tax: modelExercise(await getCompanyData(ctx.companyId!), award, shares, { asOf: exerciseDate, fmv, rates: config().tax.defaultRates }),
  };
}

route.post('/api/c/:cid/awards/:id/exercise', 'write', async (ctx) => performExercise(ctx, ctx.params.id, ctx.body));

/**
 * Exercises a warrant, as a grant is exercised: shares issued, the warrant reduced,
 * a dated EXERCISE in the ledger in the shares of the exercise date.
 */
route.post('/api/c/:cid/warrants/:id/exercise', 'write', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const warrant = data.warrants.find((w) => w.id === ctx.params.id);
  if (!warrant) throw notFound('Warrant not found.');
  if (warrant.status !== 'OUTSTANDING') throw badRequest('Only outstanding warrants can be exercised.');
  const quantity = num(ctx.body.quantity, 'Quantity', { min: 1 });
  const exerciseDate = date(ctx.body.exerciseDate ?? today(), 'Exercise date');
  const method = str(ctx.body.method ?? 'CASH', 'Method');
  if (!['CASH', 'NET_EXERCISE'].includes(method)) throw badRequest('Choose a cash or net exercise.');
  if (method === 'NET_EXERCISE' && !warrant.netExercise) throw badRequest('This warrant does not allow a net exercise.');
  if (exerciseDate < warrant.issueDate) throw badRequest(`The warrant was issued on ${warrant.issueDate}.`);
  if (warrant.expirationDate && exerciseDate > warrant.expirationDate) throw badRequest(`This warrant expired on ${warrant.expirationDate}.`);
  const outstanding = roundShares(warrant.quantity - warrant.exercisedQuantity);
  if (quantity > outstanding + 1e-9) throw badRequest(`Only ${formatShares(outstanding)} shares remain under this warrant.`);

  const k = splitFactor(data, warrant.issueDate, exerciseDate);
  const shares = roundShares(quantity * k);
  const strike = k === 1 ? warrant.strikePrice : Math.round(warrant.strikePrice / k);
  const totalCost = shareValue(quantity, warrant.strikePrice);
  let sharesIssued = shares;
  if (method === 'NET_EXERCISE') {
    const fmv = activeValuation(data, exerciseDate);
    sharesIssued = fmv > 0 ? Math.floor(shares - (quantity * warrant.strikePrice) / fmv) : 0;
    if (sharesIssued <= 0) throw badRequest('A net exercise yields no shares at the current fair market value.');
  }

  const issuanceId = newId('iss');
  const certNo = `WX-${String((await all('SELECT id FROM issuances WHERE company_id = ?', ctx.companyId)).length + 1).padStart(4, '0')}`;
  await insert('issuances', {
    id: issuanceId, companyId: ctx.companyId, certificateNo: certNo, stakeholderId: warrant.stakeholderId,
    shareClassId: warrant.shareClassId, quantity: sharesIssued, pricePerShare: strike, issueDate: exerciseDate,
    status: 'OUTSTANDING', vestingScheduleId: null, vestingStartDate: null, earlyExercised: 0,
    election83bFiledOn: null, sourceAwardId: null, boardApprovalDate: null,
    notes: `Issued on exercise of warrant ${warrant.id}`, createdAt: nowISO(),
  });
  await recordIssuance(ctx, issuanceId, { stakeholderId: warrant.stakeholderId, shareClassId: warrant.shareClassId, quantity: sharesIssued, pricePerShare: strike, issueDate: exerciseDate },
    `Certificate ${certNo} issued on exercise of a warrant`);
  const exercised = roundShares(warrant.exercisedQuantity + quantity);
  await update('warrants', warrant.id, { exercisedQuantity: exercised, status: exercised >= warrant.quantity ? 'EXERCISED' : 'OUTSTANDING' });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'EXERCISE', date: exerciseDate,
    stakeholderId: warrant.stakeholderId, counterpartyId: null, securityId: warrant.id,
    shareClassId: warrant.shareClassId, quantity: shares, pricePerShare: strike, amount: method === 'CASH' ? totalCost : 0,
    memo: `${method} exercise of warrant (${formatShares(sharesIssued)} shares issued)`, createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'EXERCISE', 'warrants', warrant.id,
    `${formatShares(quantity)} warrant shares exercised at ${formatPPS(warrant.strikePrice)} (${method})` +
    (k === 1 ? '' : `, ${formatShares(shares)} shares at ${formatPPS(strike)} after the stock split`));
  return {
    warrant: toCamel(await one('SELECT * FROM warrants WHERE id = ?', warrant.id)),
    issuance: toCamel(await one('SELECT * FROM issuances WHERE id = ?', issuanceId)),
  };
});

// ---------------------------------------------------------------------------
// Exercise requests: holder asks → company reviews → payment → exercise recorded
// ---------------------------------------------------------------------------

const REQUEST_METHODS = ['CASH', 'NET_EXERCISE', 'CASHLESS', 'PROMISSORY_NOTE'];

/** Whether holders may ask to exercise: the company's own switch, else company.exerciseRequests. */
const exerciseRequestsOn = (company: { exercise_requests_enabled: number | null } | undefined): boolean =>
  Number(company?.exercise_requests_enabled ?? (config().company.exerciseRequests ? 1 : 0)) === 1;

async function requestRow(id: string) {
  return toCamel<Record<string, unknown>>(await one(
    `SELECT r.*, a.label AS award_label, a.type AS award_type, s.name AS stakeholder_name
     FROM exercise_requests r JOIN awards a ON a.id = r.award_id JOIN stakeholders s ON s.id = r.stakeholder_id WHERE r.id = ?`, id));
}

async function loadRequest(ctx: Ctx) {
  const row = await one<Record<string, unknown>>('SELECT * FROM exercise_requests WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!row) throw notFound('Exercise request not found.');
  return toCamel<{ id: string; awardId: string; stakeholderId: string; quantity: number; method: string; status: string }>(row)!;
}

route.get('/api/c/:cid/exercise-requests', 'read', async (ctx) => {
  const role = ctx.membership!.role;
  const mine = seesWholeCompany(role) ? null : (ctx.membership!.stakeholderId ?? '__none__');
  const rows = toCamelAll<Record<string, unknown>>(await all(
    `SELECT r.*, a.label AS award_label, a.type AS award_type, s.name AS stakeholder_name
     FROM exercise_requests r JOIN awards a ON a.id = r.award_id JOIN stakeholders s ON s.id = r.stakeholder_id
     WHERE r.company_id = ? ${mine ? 'AND r.stakeholder_id = ?' : ''} ORDER BY r.requested_at DESC`,
    ...(mine ? [ctx.companyId, mine] : [ctx.companyId])));
  const company = await one<{ exercise_requests_enabled: number; payment_instructions: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return { enabled: exerciseRequestsOn(company), paymentInstructions: company?.payment_instructions ?? null, requests: rows, counts };
});

/** A holder (or an editor on their behalf) asks to exercise vested options. */
route.post('/api/c/:cid/exercise-requests', 'read', async (ctx) => {
  const company = await one<{ exercise_requests_enabled: number }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);
  if (!exerciseRequestsOn(company)) throw badRequest('Exercise requests are turned off for this company.');
  const awardId = str(ctx.body.awardId, 'Grant');
  const quantity = num(ctx.body.quantity, 'Quantity', { min: 1 });
  const method = str(ctx.body.method ?? 'CASH', 'Method');
  if (!REQUEST_METHODS.includes(method)) throw badRequest('Choose a valid exercise method.');
  const { data, award, exercisable, fmv } = await exercisableOn(ctx.companyId!, awardId, today());
  const editor = isEditor(ctx.membership!.role);
  if (!editor && award.stakeholderId !== ctx.membership!.stakeholderId) throw forbidden('You can only request exercises of your own grants.');
  const pending = await one<{ n: number }>("SELECT COALESCE(SUM(quantity), 0) AS n FROM exercise_requests WHERE award_id = ? AND status IN ('REQUESTED', 'APPROVED', 'PAID')", awardId);
  const available = Math.max(0, roundShares(exercisable - Number(pending?.n ?? 0)));
  if (quantity > available + 1e-9) {
    throw badRequest(`Only ${formatShares(available)} options are exercisable right now${Number(pending?.n ?? 0) > 0 ? ' after your pending requests' : ''}.`);
  }
  if (method !== 'CASH' && fmv <= 0) throw badRequest('A net or cashless exercise needs a current fair market value on file.');
  const estimatedCost = shareValue(quantity, award.strikePrice);
  // The fair market value is per share today, after any split since the grant.
  const spread = Math.max(0, shareValue(roundShares(quantity * splitFactor(data, award.grantDate, today())), fmv) - estimatedCost);
  const id = newId('exq');
  await insert('exercise_requests', {
    id, companyId: ctx.companyId, awardId, stakeholderId: award.stakeholderId, quantity, method,
    strikePrice: award.strikePrice, fmv, estimatedCost, spread, status: 'REQUESTED',
    note: ctx.body.note ? String(ctx.body.note).slice(0, 2000) : null, requestedBy: ctx.user!.name,
    requestedAt: nowISO(), createdAt: nowISO(),
  });
  await audit(ctx, 'EXERCISE_REQUEST', 'awards', awardId, `${formatShares(quantity)} options requested for exercise (${method.toLowerCase().replace('_', ' ')})`);
  return requestRow(id);
});

const transition = (from: string[], to: string) => async (ctx: Ctx, extra: Record<string, unknown> = {}, detail = '') => {
  const req = await loadRequest(ctx);
  if (!from.includes(req.status)) throw badRequest(`This request is ${req.status.toLowerCase()} and cannot move to ${to.toLowerCase()}.`);
  await update('exercise_requests', req.id, { status: to, reviewedBy: ctx.user!.name, reviewedAt: nowISO(), ...extra });
  await audit(ctx, 'EXERCISE_REQUEST', 'awards', req.awardId, `Exercise request ${to.toLowerCase()}${detail}`);
  return requestRow(req.id);
};

route.post('/api/c/:cid/exercise-requests/:id/approve', 'write', async (ctx) =>
  transition(['REQUESTED'], 'APPROVED')(ctx, { adminNote: ctx.body.adminNote ? String(ctx.body.adminNote).slice(0, 2000) : null }, ' — awaiting payment'));

route.post('/api/c/:cid/exercise-requests/:id/reject', 'write', async (ctx) =>
  transition(['REQUESTED', 'APPROVED', 'PAID'], 'REJECTED')(ctx, { adminNote: ctx.body.adminNote ? String(ctx.body.adminNote).slice(0, 2000) : null }));

route.post('/api/c/:cid/exercise-requests/:id/mark-paid', 'write', async (ctx) =>
  transition(['APPROVED'], 'PAID')(ctx, { paidAt: nowISO(), paymentReference: ctx.body.paymentReference ? String(ctx.body.paymentReference).slice(0, 200) : null }, ' — payment received'));

/** Payment is in: the exercise itself is recorded through the same path as a direct exercise. */
route.post('/api/c/:cid/exercise-requests/:id/complete', 'write', async (ctx) => {
  const req = await loadRequest(ctx);
  if (!['APPROVED', 'PAID'].includes(req.status)) throw badRequest(`This request is ${req.status.toLowerCase()} and cannot be completed.`);
  const result = await performExercise(ctx, req.awardId, { quantity: req.quantity, exerciseDate: ctx.body.exerciseDate ?? today(), method: req.method, notes: `Exercise request ${req.id}` });
  await update('exercise_requests', req.id, { status: 'COMPLETED', completedAt: nowISO(), exerciseId: (result.exercise as { id: string }).id, reviewedBy: ctx.user!.name });
  return { request: await requestRow(req.id), ...result };
});

/** The holder changes their mind before anything is recorded. */
route.post('/api/c/:cid/exercise-requests/:id/withdraw', 'read', async (ctx) => {
  const req = await loadRequest(ctx);
  const editor = isEditor(ctx.membership!.role);
  if (!editor && req.stakeholderId !== ctx.membership!.stakeholderId) throw forbidden('This request belongs to someone else.');
  if (!['REQUESTED', 'APPROVED'].includes(req.status)) throw badRequest(`This request is ${req.status.toLowerCase()} and cannot be withdrawn.`);
  await update('exercise_requests', req.id, { status: 'WITHDRAWN', reviewedAt: nowISO() });
  await audit(ctx, 'EXERCISE_REQUEST', 'awards', req.awardId, 'Exercise request withdrawn');
  return requestRow(req.id);
});

/** Cancels part or all of a grant, returning the shares to the plan reserve. */
route.post('/api/c/:cid/awards/:id/cancel', 'write', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const award = data.awards.find((a) => a.id === ctx.params.id);
  if (!award) throw notFound('Grant not found.');
  const outstanding = roundShares(award.quantity - award.exercisedQuantity - award.cancelledQuantity);
  const quantity = ctx.body.quantity != null ? num(ctx.body.quantity, 'Quantity', { min: 1 }) : outstanding;
  if (quantity > outstanding + 1e-9) {
    throw badRequest(`Only ${formatShares(outstanding)} shares are outstanding under this grant.`);
  }
  const cancelDate = date(ctx.body.date ?? today(), 'Cancellation date');
  if (cancelDate < award.grantDate) throw badRequest(`The cancellation cannot be dated before the grant, ${award.grantDate}.`);
  const newCancelled = roundShares(award.cancelledQuantity + quantity);
  const fullyGone = newCancelled >= roundShares(award.quantity - award.exercisedQuantity);

  await update('awards', award.id, {
    cancelledQuantity: newCancelled,
    status: fullyGone ? (ctx.body.reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED') : 'OUTSTANDING',
  });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'CANCELLATION', date: cancelDate,
    stakeholderId: award.stakeholderId, counterpartyId: null, securityId: award.id,
    shareClassId: null, quantity: roundShares(quantity * splitFactor(data, award.grantDate, cancelDate)), pricePerShare: null, amount: null,
    memo: ctx.body.reason ?? 'Grant cancelled', createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'CANCEL', 'awards', award.id, `${formatShares(quantity)} shares cancelled`);
  return toCamel(await one('SELECT * FROM awards WHERE id = ?', award.id));
});

/** Transfers shares between stakeholders, splitting the certificate. */
route.post('/api/c/:cid/issuances/:id/transfer', 'write', async (ctx) => {
  const source = toCamel<Record<string, unknown>>(
    await one('SELECT * FROM issuances WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!source) throw notFound('Certificate not found.');
  if (source.status !== 'OUTSTANDING') throw badRequest('Only outstanding certificates can be transferred.');

  const toStakeholderId = str(ctx.body.toStakeholderId, 'Recipient');
  const recipient = await one('SELECT id FROM stakeholders WHERE id = ? AND company_id = ?', toStakeholderId, ctx.companyId);
  if (!recipient) throw badRequest('The recipient is not a stakeholder of this company.');

  const available = Number(source.quantity);
  const quantity = ctx.body.quantity != null ? num(ctx.body.quantity, 'Quantity', { min: 1 }) : available;
  if (quantity > available) throw badRequest(`That certificate only holds ${formatShares(available)} shares.`);
  const transferDate = date(ctx.body.date ?? today(), 'Transfer date');
  if (transferDate < String(source.issueDate)) throw badRequest(`The transfer cannot be dated before the certificate was issued, ${source.issueDate}.`);
  const pricePerShare = ctx.body.pricePerShare != null ? num(ctx.body.pricePerShare, 'Price') : Number(source.pricePerShare);
  // Quantity and price are per share as the certificate records them; the new
  // certificate is dated the transfer and holds that day's shares.
  const k = splitFactor(await getCompanyData(ctx.companyId!), String(source.issueDate), transferDate);
  const moved = roundShares(quantity * k);
  const movedPrice = k === 1 ? pricePerShare : Math.round(pricePerShare / k);

  const newId1 = newId('iss');
  await insert('issuances', {
    id: newId1, companyId: ctx.companyId, certificateNo: `TR-${String(Date.now()).slice(-6)}`,
    stakeholderId: toStakeholderId, shareClassId: source.shareClassId, quantity: moved,
    pricePerShare: movedPrice, issueDate: transferDate, status: 'OUTSTANDING',
    vestingScheduleId: source.vestingScheduleId, vestingStartDate: source.vestingStartDate,
    earlyExercised: source.earlyExercised, election83bFiledOn: null, sourceAwardId: source.sourceAwardId,
    boardApprovalDate: ctx.body.boardApprovalDate ?? null,
    notes: `Transferred from certificate ${source.certificateNo ?? source.id}`, createdAt: nowISO(),
  });
  await recordIssuance(ctx, newId1, { stakeholderId: toStakeholderId, shareClassId: source.shareClassId, quantity: moved, pricePerShare: movedPrice, issueDate: transferDate },
    `Certificate issued on transfer from ${source.certificateNo ?? source.id}`);

  if (quantity >= available) {
    await update('issuances', ctx.params.id, { status: 'TRANSFERRED' });
  } else {
    await update('issuances', ctx.params.id, { quantity: roundShares(available - quantity) });
  }

  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'TRANSFER', date: transferDate,
    stakeholderId: source.stakeholderId as string, counterpartyId: toStakeholderId,
    securityId: ctx.params.id, shareClassId: source.shareClassId as string, quantity: moved,
    pricePerShare: movedPrice, amount: shareValue(quantity, pricePerShare),
    memo: ctx.body.memo ?? 'Share transfer', createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'TRANSFER', 'issuances', ctx.params.id, `${formatShares(moved)} shares transferred` +
    (k === 1 ? '' : ` (${formatShares(quantity)} as the certificate records them, before the stock split)`));
  return toCamel(await one('SELECT * FROM issuances WHERE id = ?', newId1));
});

/** Repurchases unvested shares, typically on a founder departure. */
route.post('/api/c/:cid/issuances/:id/repurchase', 'write', async (ctx) => {
  const source = toCamel<Record<string, unknown>>(
    await one('SELECT * FROM issuances WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!source) throw notFound('Certificate not found.');
  if (source.status !== 'OUTSTANDING') throw badRequest('Only outstanding certificates can be repurchased.');
  const available = Number(source.quantity);
  const quantity = ctx.body.quantity != null ? num(ctx.body.quantity, 'Quantity', { min: 1 }) : available;
  if (quantity > available) throw badRequest(`That certificate only holds ${formatShares(available)} shares.`);
  const repurchaseDate = date(ctx.body.date ?? today(), 'Repurchase date');
  if (repurchaseDate < String(source.issueDate)) throw badRequest(`The repurchase cannot be dated before the certificate was issued, ${source.issueDate}.`);
  const price = num(ctx.body.pricePerShare ?? source.pricePerShare, 'Repurchase price');
  const k = splitFactor(await getCompanyData(ctx.companyId!), String(source.issueDate), repurchaseDate);

  if (quantity >= available) await update('issuances', ctx.params.id, { status: 'REPURCHASED' });
  else await update('issuances', ctx.params.id, { quantity: roundShares(available - quantity) });

  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'REPURCHASE', date: repurchaseDate,
    stakeholderId: source.stakeholderId as string, counterpartyId: null, securityId: ctx.params.id,
    shareClassId: source.shareClassId as string, quantity: roundShares(quantity * k), pricePerShare: k === 1 ? price : Math.round(price / k),
    amount: shareValue(quantity, price), memo: ctx.body.memo ?? 'Unvested share repurchase',
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'REPURCHASE', 'issuances', ctx.params.id, `${formatShares(quantity)} shares repurchased`);
  return { ok: true };
});

/** Converts an outstanding SAFE or note into shares of a class. */
route.post('/api/c/:cid/convertibles/:id/convert', 'write', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const convertible = data.convertibles.find((c) => c.id === ctx.params.id);
  if (!convertible) throw notFound('Instrument not found.');
  if (convertible.status !== 'OUTSTANDING') throw badRequest('This instrument has already been settled.');

  const shareClassId = str(ctx.body.shareClassId, 'Share class');
  const shares = num(ctx.body.shares, 'Shares', { min: 1 });
  const conversionDate = date(ctx.body.date ?? today(), 'Conversion date');
  const pricePerShare = num(ctx.body.pricePerShare, 'Conversion price', { min: 1 });

  const issuanceId = newId('iss');
  await insert('issuances', {
    id: issuanceId, companyId: ctx.companyId, certificateNo: `CV-${String(Date.now()).slice(-6)}`,
    stakeholderId: convertible.stakeholderId, shareClassId, quantity: shares,
    pricePerShare, issueDate: conversionDate, status: 'OUTSTANDING',
    vestingScheduleId: null, vestingStartDate: null, earlyExercised: 0,
    election83bFiledOn: null, sourceAwardId: null, boardApprovalDate: null,
    notes: `Issued on conversion of ${convertible.instrument}`, createdAt: nowISO(),
  });
  await recordIssuance(ctx, issuanceId, { stakeholderId: convertible.stakeholderId, shareClassId, quantity: shares, pricePerShare, issueDate: conversionDate },
    `Certificate issued on conversion of ${convertible.label ?? convertible.instrument}`);
  await update('convertibles', convertible.id, {
    status: 'CONVERTED', convertedIntoShareClassId: shareClassId, convertedOn: conversionDate,
  });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'CONVERSION', date: conversionDate,
    stakeholderId: convertible.stakeholderId, counterpartyId: null, securityId: convertible.id,
    shareClassId, quantity: shares, pricePerShare, amount: convertible.principal,
    memo: `${convertible.instrument} converted at ${formatPPS(pricePerShare)}`,
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'CONVERT', 'convertibles', convertible.id, `Converted into ${formatShares(shares)} shares`);
  return toCamel(await one('SELECT * FROM issuances WHERE id = ?', issuanceId));
});

/**
 * Records an MFN holder's election of a later convertible's terms (YC Safe, MFN
 * Amendment Provision). Only a dated MFN_ELECTION ledger entry is written: the
 * convertible keeps its terms as issued, and every view applies the election from
 * its date (electedTerms). A holder elects once; a second election is refused
 * unless sent as a `correction`, dated on or after the one it corrects, which then
 * applies from its own date.
 */
route.post('/api/c/:cid/convertibles/:id/mfn-election', 'write', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const mfn = data.convertibles.find((c) => c.id === ctx.params.id);
  if (!mfn) throw notFound('Instrument not found.');
  if (!mfn.mfn) throw badRequest('This instrument has no MFN clause.');
  if (mfn.status !== 'OUTSTANDING') throw badRequest('This instrument has already been settled.');
  const adoptedId = str(ctx.body.adoptedId, 'Adopted instrument');
  const electedOn = date(ctx.body.date, 'Election date');
  const adopted = mfnCandidates(mfn, data.convertibles, electedOn).find((c) => c.id === adoptedId);
  if (!adopted) throw badRequest('The adopted instrument must be a convertible of this company issued on or after this one and on or before the election date.');
  const previous = (data.ledger ?? []).filter((e) => e.type === 'MFN_ELECTION' && e.securityId === mfn.id).map((e) => e.date).sort().at(-1);
  const correction = ctx.body.correction === true;
  if (previous && !correction) throw badRequest('This holder has already made its MFN election. Send it as a correction to change it.');
  if (previous && electedOn < previous) throw badRequest(`A correction must be dated on or after the election it corrects (${previous}).`);

  const terms = `${INSTRUMENT_NAMES[adopted.instrument]}${adopted.valuationCap != null ? `, ${fmtUsd(adopted.valuationCap)} cap` : ''}${adopted.discount ? `, ${Math.round(adopted.discount * 100)}% discount` : ''}`;
  const memo = `${correction && previous ? 'Correction: e' : 'E'}lected the terms of ${terms}`;
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'MFN_ELECTION', date: electedOn,
    stakeholderId: mfn.stakeholderId, counterpartyId: null, securityId: mfn.id, adoptedSecurityId: adopted.id,
    shareClassId: null, quantity: null, pricePerShare: null, amount: null, memo,
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'MFN_ELECTION', 'convertibles', mfn.id, memo);
  return { ok: true };
});
/** Cancels part or all of an outstanding certificate, as a repurchase does with nothing paid. */
route.post('/api/c/:cid/issuances/:id/cancel', 'write', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const source = data.issuances.find((i) => i.id === ctx.params.id);
  if (!source) throw notFound('Certificate not found.');
  if (source.status !== 'OUTSTANDING') throw badRequest('Only outstanding certificates can be cancelled.');
  const quantity = ctx.body.quantity != null ? num(ctx.body.quantity, 'Quantity', { min: 1 }) : source.quantity;
  if (quantity > source.quantity) throw badRequest(`That certificate only holds ${formatShares(source.quantity)} shares.`);
  const cancelDate = date(ctx.body.date ?? today(), 'Cancellation date');
  if (cancelDate < source.issueDate) throw badRequest(`The cancellation cannot be dated before the certificate was issued, ${source.issueDate}.`);
  const k = splitFactor(data, source.issueDate, cancelDate);
  // A cancellation of everything closes the certificate and keeps what it held, as a transfer does.
  if (quantity >= source.quantity) await update('issuances', source.id, { status: 'CANCELLED' });
  else await update('issuances', source.id, { quantity: roundShares(source.quantity - quantity) });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: 'CANCELLATION', date: cancelDate,
    stakeholderId: source.stakeholderId, counterpartyId: null, securityId: source.id, shareClassId: source.shareClassId,
    quantity: roundShares(quantity * k), pricePerShare: null, amount: null,
    memo: ctx.body.reason ? String(ctx.body.reason).slice(0, 500) : 'Certificate cancelled', createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'CANCEL', 'issuances', source.id, `${formatShares(quantity)} shares cancelled`);
  return toCamel(await one('SELECT * FROM issuances WHERE id = ?', source.id));
});

/** Ends what is left of an outstanding warrant: expired (reason EXPIRED) or cancelled. */
route.post('/api/c/:cid/warrants/:id/cancel', 'write', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const warrant = data.warrants.find((w) => w.id === ctx.params.id);
  if (!warrant) throw notFound('Warrant not found.');
  if (warrant.status !== 'OUTSTANDING') throw badRequest('Only outstanding warrants can be cancelled or expire.');
  const on = date(ctx.body.date ?? today(), 'Date');
  if (on < warrant.issueDate) throw badRequest(`The warrant was issued on ${warrant.issueDate}.`);
  const expired = ctx.body.reason === 'EXPIRED';
  const left = roundShares(warrant.quantity - warrant.exercisedQuantity);
  await update('warrants', warrant.id, { status: expired ? 'EXPIRED' : 'CANCELLED' });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: expired ? 'EXPIRATION' : 'CANCELLATION', date: on,
    stakeholderId: warrant.stakeholderId, counterpartyId: null, securityId: warrant.id, shareClassId: warrant.shareClassId,
    quantity: roundShares(left * splitFactor(data, warrant.issueDate, on)), pricePerShare: null, amount: null,
    memo: expired ? 'Warrant expired' : (ctx.body.reason ? String(ctx.body.reason).slice(0, 500) : 'Warrant cancelled'),
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, expired ? 'EXPIRE' : 'CANCEL', 'warrants', warrant.id, `${formatShares(left)} warrant shares ${expired ? 'expired' : 'cancelled'}`);
  return toCamel(await one('SELECT * FROM warrants WHERE id = ?', warrant.id));
});

/** Settles an outstanding SAFE or note without shares: repaid in cash, or cancelled. */
async function settleConvertible(ctx: Ctx, repaid: boolean) {
  const data = await getCompanyData(ctx.companyId!);
  const convertible = data.convertibles.find((c) => c.id === ctx.params.id);
  if (!convertible) throw notFound('Instrument not found.');
  if (convertible.status !== 'OUTSTANDING') throw badRequest('Only an outstanding instrument can be settled; this one already has been.');
  const on = date(ctx.body.date ?? today(), repaid ? 'Repayment date' : 'Cancellation date');
  if (on < convertible.issueDate) throw badRequest(`The instrument was issued on ${convertible.issueDate}, so it cannot be settled before.`);
  const amount = repaid ? (ctx.body.amount != null ? num(ctx.body.amount, 'Amount', { min: 0, integer: true }) : convertible.principal) : null;
  await update('convertibles', convertible.id, { status: repaid ? 'REPAID' : 'CANCELLED' });
  await insert('transactions', {
    id: newId('tx'), companyId: ctx.companyId, type: repaid ? 'REPAYMENT' : 'CANCELLATION', date: on,
    stakeholderId: convertible.stakeholderId, counterpartyId: null, securityId: convertible.id, shareClassId: null,
    quantity: null, pricePerShare: null, amount,
    memo: ctx.body.reason ? String(ctx.body.reason).slice(0, 500) : `${INSTRUMENT_NAMES[convertible.instrument]} ${repaid ? 'repaid' : 'cancelled'}`,
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, repaid ? 'REPAY' : 'CANCEL', 'convertibles', convertible.id, repaid ? `Repaid ${formatMoney(amount!)}` : 'Instrument cancelled');
  return toCamel(await one('SELECT * FROM convertibles WHERE id = ?', convertible.id));
}
route.post('/api/c/:cid/convertibles/:id/repay', 'write', async (ctx) => settleConvertible(ctx, true));
route.post('/api/c/:cid/convertibles/:id/cancel', 'write', async (ctx) => settleConvertible(ctx, false));

// ---------------------------------------------------------------------------
// Documents and e-signature
// ---------------------------------------------------------------------------

/**
 * The stakeholder record behind a member. An invitation that named none is
 * linked here to the holder with the same email — the usual case for an
 * employee or investor who was on the cap table before they had a login.
 */
export async function linkedStakeholderId(ctx: { membership: { id: string; stakeholderId: string | null } | null; user: { email: string } | null; companyId: string | null }): Promise<string | null> {
  const membership = ctx.membership;
  if (!membership) return null;
  if (membership.stakeholderId) return membership.stakeholderId;
  if (!ctx.user?.email) return null;
  const match = await one<{ id: string }>(
    'SELECT id FROM stakeholders WHERE company_id = ? AND LOWER(email) = ? ORDER BY created_at LIMIT 1',
    ctx.companyId, ctx.user.email.toLowerCase());
  if (!match) return null;
  await update('memberships', membership.id, { stakeholderId: match.id });
  membership.stakeholderId = match.id;
  invalidate(ctx.companyId!);
  return match.id;
}

route.get('/api/c/:cid/documents', 'read', async (ctx) => {
  const role = ctx.membership!.role;
  const mine = await linkedStakeholderId(ctx);
  const rows = seesWholeVault(role)
    ? await all('SELECT * FROM documents WHERE company_id = ? ORDER BY created_at DESC', ctx.companyId)
    : await all(`SELECT * FROM documents WHERE company_id = ?
           AND (visibility = 'ALL' OR stakeholder_id = ?) ORDER BY created_at DESC`, ctx.companyId, mine);
  const docs = toCamelAll<Record<string, unknown>>(rows);
  const sigs = toCamelAll<Record<string, unknown>>(
    await all('SELECT * FROM signatures WHERE company_id = ?', ctx.companyId));
  // A certificate corrected after it was signed: its signed copy is void and the record
  // matches only the replacement, which is flagged (resign) until every party signs it.
  const voided = new Set(docs.filter((d) => d.category === 'CERTIFICATE' && d.status === 'VOID').map((d) => d.securityId));
  // The stored front page is only drawn by the PDF route; the list says whether there is one.
  return docs.map(({ face, ...d }) => {
    const own = sigs.filter((s) => s.documentId === d.id);
    return {
      ...d, hasFace: !!face, signatures: own, tampered: changedSinceSigned(d.body as string | null, (face as string | null) ?? null, own),
      resign: d.category === 'CERTIFICATE' && d.status === 'AWAITING_SIGNATURE' && voided.has(d.securityId),
    };
  });
});

/** One list, so a category the app writes is also a category it will accept back. */
function documentCategory(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'OTHER';
  const category = String(value).toUpperCase();
  if (!isDocumentCategory(category)) throw badRequest('Choose a valid document category.');
  return category;
}

// Other parts of the app compare these with exact words (the portal looks for
// ALL, the certificate email for EXECUTED), so any other value would leave a
// document in a state nothing recognises.
const DOCUMENT_STATUSES = ['DRAFT', 'AWAITING_SIGNATURE', 'FINAL', 'EXECUTED', 'VOID'];
const DOCUMENT_VISIBILITIES = ['ADMIN', 'HOLDER', 'ALL'];

function documentStatus(value: unknown): string {
  const status = String(value).toUpperCase();
  if (!DOCUMENT_STATUSES.includes(status)) throw badRequest('Choose a valid document status.');
  return status;
}

function documentVisibility(value: unknown): string {
  const visibility = String(value).toUpperCase();
  if (!DOCUMENT_VISIBILITIES.includes(visibility)) throw badRequest('Choose who can see the document.');
  return visibility;
}

route.post('/api/c/:cid/documents', 'write', async (ctx) => {
  // The same checks the upload and update routes make: a holder and a holding
  // named in the body have to be this company's, not merely ids that exist.
  const stakeholderId = ctx.body.stakeholderId ? String(ctx.body.stakeholderId) : null;
  if (stakeholderId && !(await one('SELECT id FROM stakeholders WHERE id = ? AND company_id = ?', stakeholderId, ctx.companyId))) {
    throw badRequest('That stakeholder does not belong to this company.');
  }
  const securityId = ctx.body.securityId ? String(ctx.body.securityId) : null;
  if (securityId && !(await securityKind(ctx.companyId!, securityId))) {
    throw badRequest('That instrument does not belong to this company.');
  }

  const id = newId('doc');
  await insert('documents', {
    id, companyId: ctx.companyId, name: str(ctx.body.name, 'Document name', { max: 200 }),
    category: documentCategory(ctx.body.category), folder: documentFolder(ctx.body.folder),
    body: ctx.body.body ?? '', stakeholderId,
    securityId,
    requiresSignature: ctx.body.requiresSignature ? 1 : 0,
    status: ctx.body.requiresSignature ? 'AWAITING_SIGNATURE' : 'FINAL',
    visibility: ctx.body.visibility ?? 'ADMIN', createdBy: ctx.user!.name, createdAt: nowISO(),
  });

  for (const signer of (ctx.body.signers ?? []) as Record<string, unknown>[]) {
    await insert('signatures', {
      id: newId('sig'), companyId: ctx.companyId, documentId: id,
      stakeholderId: signer.stakeholderId ?? null,
      signerName: String(signer.name ?? 'Signer'), signerEmail: signer.email ?? null,
      status: 'PENDING', token: randomBytes(24).toString('base64url'),
      sentAt: nowISO(), createdAt: nowISO(),
    });
  }
  await audit(ctx, 'CREATE', 'documents', id, `Document "${ctx.body.name}" created`);
  return toCamel(await one('SELECT * FROM documents WHERE id = ?', id));
});

/**
 * The folder a stored document reads as. A row saved before folders were
 * cleaned up may hold a path the rule would now write differently, so a move is
 * compared against this cleaned form rather than the raw text. Nothing stored
 * should fail the rule, but if one does it reads as no folder, so any folder
 * asked for counts as a change.
 */
function storedFolder(value: string | null): string | null {
  try { return documentFolder(value); } catch { return null; }
}

route.patch('/api/c/:cid/documents/:id', 'write', async (ctx) => {
  // update() matches on the id alone, so the document has to be confirmed as this
  // company's before anything is written. Without this an administrator of one
  // company could edit another company's document by knowing its id.
  const existing = await one<{ id: string; security_id: string | null; stakeholder_id: string | null; name: string; category: string; folder: string | null }>(
    'SELECT id, security_id, stakeholder_id, name, category, folder FROM documents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!existing) throw notFound('Document not found.');

  // A document out for signature stays where it is until every party has signed.
  // The signing flow finds it through the holding it is filed against and by its
  // category, so moving it or changing what it is midway would leave the pending
  // signature blocks pointing at paper the holding no longer claims, and the
  // countersignature that issues the equity would have nothing to act on.
  // Putting it in another folder is different: the folder only says where it is
  // shown on the documents page, and signing never looks at it, so that stays allowed.
  const moves = ctx.body.securityId !== undefined && (ctx.body.securityId || null) !== existing.security_id;
  const rehomes = ctx.body.stakeholderId !== undefined && (ctx.body.stakeholderId || null) !== existing.stakeholder_id;
  const recategorises = ctx.body.category !== undefined && String(ctx.body.category).toUpperCase() !== existing.category;
  if (moves || recategorises) {
    const pending = await one<{ id: string }>(
      "SELECT id FROM signatures WHERE document_id = ? AND company_id = ? AND status = 'PENDING' LIMIT 1",
      existing.id, ctx.companyId);
    if (pending) throw badRequest('This document is out for signature. It can be moved or reclassified once every party has signed.');
  }
  // What someone signed is evidence of the holding and the holder it names: it cannot be refiled against another.
  if (moves || rehomes) {
    const signed = await one<{ signer_name: string }>(
      "SELECT signer_name FROM signatures WHERE document_id = ? AND company_id = ? AND status = 'SIGNED' LIMIT 1", existing.id, ctx.companyId);
    if (signed) throw badRequest(`${signed.signer_name.split(' — ')[0]} has signed this document, so it cannot be linked to another ${moves ? 'holding' : 'holder'}.`);
  }

  // What a signer signed cannot change under their signature. Withdraw the document and
  // send a new one to change it. The name is a label on the page, not signed content.
  if (ctx.body.body !== undefined || ctx.body.status !== undefined) {
    const signed = await one<{ signer_name: string }>(
      "SELECT signer_name FROM signatures WHERE document_id = ? AND company_id = ? AND status = 'SIGNED' LIMIT 1", existing.id, ctx.companyId);
    if (signed) throw badRequest(`${signed.signer_name.split(' — ')[0]} has signed this document, so its text and status cannot be edited. Send a new document to change it.`);
  }

  const fields = ['name', 'body'];
  const values: Record<string, unknown> = { updatedAt: nowISO() };
  for (const f of fields) if (ctx.body[f] !== undefined) values[f] = ctx.body[f];
  if (ctx.body.category !== undefined) values.category = documentCategory(ctx.body.category);
  // The holder is checked as the create and upload routes check it. The
  // certificate email finds its recipient through this column, so another
  // company's holder here would be sent this company's certificate.
  if (ctx.body.stakeholderId !== undefined) {
    const stakeholderId = ctx.body.stakeholderId ? String(ctx.body.stakeholderId) : null;
    if (stakeholderId && !(await one('SELECT id FROM stakeholders WHERE id = ? AND company_id = ?', stakeholderId, ctx.companyId))) {
      throw badRequest('That stakeholder does not belong to this company.');
    }
    values.stakeholderId = stakeholderId;
  }
  if (ctx.body.status !== undefined) values.status = documentStatus(ctx.body.status);
  if (ctx.body.visibility !== undefined) values.visibility = documentVisibility(ctx.body.visibility);
  const folder = ctx.body.folder !== undefined ? documentFolder(ctx.body.folder) : undefined;
  if (folder !== undefined) values.folder = folder;
  const refolders = folder !== undefined && folder !== storedFolder(existing.folder);

  // Filing an existing document against a holding or a compliance subject. Both
  // are validated the same way the upload route validates them, and both accept
  // null so a document can be unfiled again.
  if (ctx.body.securityId !== undefined) {
    const securityId = ctx.body.securityId ? String(ctx.body.securityId) : null;
    if (securityId && !(await securityKind(ctx.companyId!, securityId))) {
      throw badRequest('That instrument does not belong to this company.');
    }
    values.securityId = securityId;
  }
  if (ctx.body.subjectKind !== undefined || ctx.body.subjectRef !== undefined) {
    const kind = ctx.body.subjectKind ? String(ctx.body.subjectKind) : null;
    const ref = ctx.body.subjectRef ? String(ctx.body.subjectRef).slice(0, 120) : null;
    if (kind && !isSubjectKind(kind)) throw badRequest('That is not a compliance subject this app files against.');
    if (Boolean(kind) !== Boolean(ref)) throw badRequest('A compliance subject needs both a kind and a reference.');
    values.subjectKind = kind;
    values.subjectRef = ref;
  }

  await update('documents', ctx.params.id, values);
  // A move is the common edit from the documents page, so the log says where the
  // document went rather than only that it changed. A renamed or reclassified
  // document says what it was called before, signed or not.
  const changedOtherwise = Object.keys(ctx.body).some((key) => key !== 'folder' && ctx.body[key] !== undefined);
  const relabels = [
    values.name !== undefined && values.name !== existing.name ? `name: "${existing.name}" → "${values.name}"` : '',
    values.category !== undefined && values.category !== existing.category ? `category: ${existing.category} → ${values.category}` : '',
  ].filter(Boolean).join(', ');
  await audit(ctx, 'UPDATE', 'documents', ctx.params.id,
    (!refolders ? 'Document updated'
      : changedOtherwise ? `Document updated and moved to folder "${folder}"`
      : `Document moved to folder "${folder}"`) + (relabels ? ` (${relabels})` : ''));
  return toCamel(await one('SELECT * FROM documents WHERE id = ?', ctx.params.id));
});

/** The most documents one request may move: far more than anyone selects on the page, few enough to answer quickly. */
export const DOCUMENT_MOVE_MAX = 500;

/**
 * Moves documents between folders, each to the folder named for it. The
 * documents page sends one request for everything dragged or moved together,
 * and undoing a move sends each document back to its own previous folder the
 * same way.
 *
 * It is all or nothing. Every entry is checked before anything is written, so
 * one document that is not this company's, or one folder the rule refuses,
 * leaves every document where it was rather than a selection split between the
 * old folders and the new one. The whole request is also one transaction, as
 * every write route is, so nothing is half done if the database fails midway.
 */
route.post('/api/c/:cid/documents/move', 'write', async (ctx) => {
  const moves: unknown = ctx.body.moves;
  if (!Array.isArray(moves) || moves.length === 0) throw badRequest('Choose at least one document to move.');
  if (moves.length > DOCUMENT_MOVE_MAX) throw badRequest(`At most ${DOCUMENT_MOVE_MAX} documents can be moved at once.`);

  const wanted = new Map<string, string>();
  for (const entry of moves) {
    const move = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    // The folder has to be named, even as '' for General: a move that left it
    // out by mistake would otherwise file the document at the top level.
    if (typeof move.id !== 'string' || move.id === '' || !('folder' in move)) {
      throw badRequest('Each move needs a document id and a folder.');
    }
    if (wanted.has(move.id)) throw badRequest('Each document can be moved only once in a request.');
    wanted.set(move.id, documentFolder(move.folder));
  }

  // update() matches on the id alone, so every document is confirmed as this
  // company's first. One that belongs to another company is answered exactly as
  // one that does not exist, so the reply says nothing about what others hold.
  const ids = [...wanted.keys()];
  const found = await all<{ id: string; folder: string | null }>(
    `SELECT id, folder FROM documents WHERE company_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, ctx.companyId, ...ids);
  if (found.length !== ids.length) {
    throw notFound(ids.length === 1 ? 'Document not found.' : 'Some of those documents were not found, so none were moved.');
  }

  // A document already in the folder asked for is left alone and not logged, as
  // dropping it where it already is does nothing on the page.
  const now = new Map(found.map((d) => [d.id, storedFolder(d.folder)]));
  const into = new Map<string, string[]>();
  for (const [id, folder] of wanted) {
    if (folder !== now.get(id)) into.set(folder, [...(into.get(folder) ?? []), id]);
  }
  const updatedAt = nowISO();
  for (const [folder, moving] of into) {
    await run(`UPDATE documents SET folder = ?, updated_at = ? WHERE company_id = ? AND id IN (${moving.map(() => '?').join(', ')})`,
      folder, updatedAt, ctx.companyId, ...moving);
    for (const id of moving) await audit(ctx, 'UPDATE', 'documents', id, `Document moved to folder "${folder}"`);
  }

  // Every document named, in the order asked, as it now stands. The stored
  // front page is left out as the list leaves it out.
  const rows = toCamelAll<Record<string, unknown>>(await all(
    `SELECT * FROM documents WHERE company_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, ctx.companyId, ...ids));
  const byId = new Map(rows.map(({ face, ...d }) => [d.id as string, { ...d, hasFace: !!face }]));
  return ids.map((id) => byId.get(id));
});

route.del('/api/c/:cid/documents/:id', 'write', async (ctx) => {
  const doc = await one<{ storage_key: string | null }>(
    'SELECT storage_key FROM documents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!doc) throw notFound('Document not found.');
  // A signature is a record of what was agreed; deleting the document would take it with it.
  const signed = await one<{ signer_name: string }>(
    "SELECT signer_name FROM signatures WHERE document_id = ? AND company_id = ? AND status = 'SIGNED' LIMIT 1", ctx.params.id, ctx.companyId);
  if (signed) throw badRequest(`${signed.signer_name.split(' — ')[0]} has signed this document, so it cannot be deleted.`);
  await run('DELETE FROM documents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  await removeStoredFile(doc.storage_key);
  await audit(ctx, 'DELETE', 'documents', ctx.params.id, 'Document deleted');
  return { ok: true };
});

/** Records a typed signature. Members sign their own assigned blocks only. */
route.post('/api/c/:cid/signatures/:id/sign', 'read', async (ctx) => {
  const sig = toCamel<Record<string, unknown>>(
    await one('SELECT * FROM signatures WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!sig) throw notFound('Signature block not found.');
  if (sig.status === 'SIGNED') throw badRequest('This has already been signed.');
  if (sig.status === 'VOID') throw badRequest('This document was voided and can no longer be signed.');

  const role = ctx.membership!.role;
  const mine = ctx.membership!.stakeholderId;
  // A block with no stakeholder is the company's own, and only an officer signs for
  // the company. Comparing the two directly let anyone whose membership has no
  // linked stakeholder match it, null against null, and countersign: that
  // completes the document, makes the shares outstanding and writes the ledger.
  const officer = isEditor(role);
  if (!officer && (sig.stakeholderId == null || sig.stakeholderId !== mine)) {
    throw forbidden('This signature block is assigned to someone else.');
  }
  const typed = str(ctx.body.typedSignature, 'Signature');
  if (typed.trim().length < 2) throw badRequest('Type your full name to sign.');

  // The hash of what was signed, the text and the certificate face, so a later change to either shows against it.
  const doc = await one<{ body: string | null; face: string | null }>('SELECT body, face FROM documents WHERE id = ?', sig.documentId);
  await update('signatures', ctx.params.id, {
    status: 'SIGNED', typedSignature: typed, signedAt: nowISO(), ipAddress: ctx.ip, bodySha256: signedHash(doc?.body ?? null, doc?.face ?? null),
  });

  const remaining = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM signatures WHERE document_id = ? AND status != 'SIGNED'", sig.documentId);
  if ((remaining?.n ?? 0) === 0) {
    await update('documents', String(sig.documentId), { status: 'EXECUTED', updatedAt: nowISO() });
    await activateSignedIssuance(ctx, String(sig.documentId));
  }
  await audit(ctx, 'SIGN', 'documents', String(sig.documentId), `Signed by ${typed}`);
  return toCamel(await one('SELECT * FROM signatures WHERE id = ?', ctx.params.id));
});

// ---------------------------------------------------------------------------
// Issuing shares for signature
// ---------------------------------------------------------------------------

interface CertificateFacts {
  company: { name: string; legal_name: string | null; jurisdiction: string | null; entity_type: string | null; incorporation_date: string | null };
  holder: { name: string; legal_name?: string | null; tax_form?: string | null; tax_country?: string | null };
  shareClass: { name: string; par_value: number };
  certificateNo: string; quantity: number; pricePerShare: number; issueDate: string;
  schedule: { name: string } | null; vestingStartDate: string | null; earlyExercised: boolean;
  boardApprovalDate: string | null; signerName: string; signerTitle: string; message: string | null;
  /** Extra legend for the class and company-wide terms, when the company has set them. */
  legend?: string | null; terms?: string | null;
  /** Regulation S, when the issuance records it; decides the offshore legend with the holder's tax details. */
  federalExemption?: string | null;
}

const ENTITY_WORDS: Record<string, string> = { C_CORP: 'corporation', S_CORP: 'corporation', LLC: 'limited liability company', LP: 'limited partnership', PBC: 'public benefit corporation' };

/**
 * The certificate the parties sign, as two views of the same facts: the plain
 * text (what signers read, what search finds, what the signature covers) and the
 * front page drawn in the certificate layout (certificate-face.ts). The face's
 * paragraphs are the text's paragraphs, and the face's back is the text's back, so
 * the two can never say different things.
 */
export function stockCertificate(f: CertificateFacts, ownBack?: string): { body: string; face: CertificateFace } {
  const legalName = f.company.legal_name ?? f.company.name;
  const entity = ENTITY_WORDS[f.company.entity_type ?? ''] ?? 'company';
  const holderName = f.holder.legal_name || f.holder.name;
  const total = Math.round((f.quantity * f.pricePerShare) / 10_000);

  // The back: how the shares were issued, vesting, the legends and the record of signing.
  const back: string[] = [
    `ISSUE. The shares were issued on ${f.issueDate} at ${fmtPerShare(f.pricePerShare)} per share, for total consideration of ${fmtUsd(total)}.`,
  ];
  if (f.schedule) {
    back.push('', `VESTING. The shares are subject to the "${f.schedule.name}" vesting schedule${f.vestingStartDate ? ` measured from ${f.vestingStartDate}` : ''}. Unvested shares are subject to the Company's right to repurchase them at the lower of cost and fair market value if the Holder's service ends. The Holder is responsible for deciding whether to file an election under Section 83(b) of the Internal Revenue Code within 30 days of ${f.issueDate}.`);
  } else if (f.earlyExercised) {
    back.push('', 'The shares were acquired by early exercise and remain subject to the vesting and repurchase terms of the underlying option. The Holder is responsible for deciding whether to file an election under Section 83(b) within 30 days of the exercise.');
  }
  back.push('',
    'The shares are also subject to any stockholders\', voting or right of first refusal agreement to which the Holder is a party, each as amended from time to time.',
    '',
    'LEGENDS',
    ...legendsFor(f).flatMap((l, i) => (i ? ['', l] : [l])),
  );
  if (f.legend) back.push('', f.legend.trim().toUpperCase());
  if (f.terms) back.push('', 'TERMS', f.terms.trim());
  if (f.message) back.push('', `NOTE FROM THE COMPANY. ${f.message}`);
  back.push('',
    `Board approval: ${f.boardApprovalDate ?? 'as recorded in the Company\'s minutes'}.`,
    '',
    'ELECTRONIC SIGNATURES. The Company and the Holder sign this certificate electronically. Each typed signature recorded on the platform, with its timestamp and network address, is the signer\'s binding electronic signature, and the executed certificate is delivered to the Holder through the platform.',
    '',
    'SIGNATURES',
    `For the Company: ${f.signerName}, ${f.signerTitle}`,
    `Holder: ${holderName}`,
  );
  // A company's own CERTIFICATE template replaces the built-in back pages; the front stays the facts.
  const backText = ownBack ?? back.join('\n');

  const face = stockFace({
    legalName, jurisdiction: f.company.jurisdiction, entityType: f.company.entity_type,
    certificateNo: f.certificateNo, holderName, quantity: f.quantity, className: f.shareClass.name, parValue: f.shareClass.par_value,
    issueDate: f.issueDate, signerName: f.signerName, signerTitle: f.signerTitle, back: backText,
  });
  const body = [
    legalName.toUpperCase(),
    `A ${f.company.jurisdiction ?? config().company.jurisdiction} ${entity}${f.company.incorporation_date ? `, formed ${f.company.incorporation_date}` : ''}`,
    '',
    `STOCK CERTIFICATE No. ${f.certificateNo}`,
    '',
    faceText(face),
    '',
    face.dated,
    '',
    backText,
  ].join('\n');
  return { body, face };
}

/** The configured legends that apply to these shares and this holder. */
export function legendsFor(f: Pick<CertificateFacts, 'schedule' | 'earlyExercised' | 'holder' | 'federalExemption'>): string[] {
  return stockLegends({
    restricted: !!f.schedule || f.earlyExercised,
    fromPlan: f.earlyExercised,
    nonUs: isNonUsHolder({ taxForm: f.holder.tax_form, taxCountry: f.holder.tax_country, federalExemption: f.federalExemption }),
  });
}

/** The certificate's plain text alone. */
export function certificateBody(f: CertificateFacts): string {
  return stockCertificate(f).body;
}

/** Next certificate number for a class: its initials plus a running count ("CS-3", "PSS-13"). */
async function nextCertificateNo(companyId: string, shareClass: { name: string; kind: string }): Promise<string> {
  const prefix = shareClass.kind === 'COMMON' ? 'CS'
    : shareClass.name.split(/\s+/).map((w) => w[0]).join('').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'PS';
  const rows = await all<{ certificate_no: string | null }>('SELECT certificate_no FROM issuances WHERE company_id = ?', companyId);
  let max = 0;
  for (const r of rows) {
    const m = r.certificate_no?.match(new RegExp(`^${prefix}-(\\d+)$`, 'i'));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/** A share count as the param file's locale writes it, for emails and the audit log. */
const count = (n: number): string => n.toLocaleString(config().locale.locale);

/** A date written out, "March 3, 2026", in the param file's locale. */
const writtenDate = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso)
  ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(config().locale.locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  : iso);

export interface HolderSigningEmail {
  /** The holder's address and name, as their stakeholder record has them. */
  to: string;
  toName: string;
  companyName: string;
  /** How many shares the certificate is for, or how many the grant covers. */
  shares: number;
  /** The share class ("Common Stock") for a certificate; the award type in the plural ("Incentive Stock Options") for an agreement. */
  className: string;
  reminder: boolean;
  what: 'certificate' | 'agreement';
  /** Where the holder signs: their portal. */
  link: string;
  /** The certificate number or grant number, so the holder can match the email to the document. */
  reference?: string | null;
  /** The certificate's issue date or the grant date, as an ISO date. */
  date?: string | null;
}

/**
 * The email asking a holder to sign their share certificate or equity award
 * agreement, or reminding them to. Pure, so what it says can be tested without
 * sending it.
 */
export function composeHolderSigningEmail(e: HolderSigningEmail): Message {
  const company = e.companyName;
  const product = config().brand.productName;
  const qty = count(e.shares);
  const isAgreement = e.what === 'agreement';
  const docName = isAgreement ? 'equity award agreement' : 'share certificate';
  const doc = isAgreement ? 'agreement' : 'certificate';
  const holding = isAgreement ? `${qty} ${e.className}` : `${qty} shares of ${e.className}`;
  const subject = e.reminder ? `${company}: reminder to sign your ${docName}` : `${company}: sign your ${docName}`;
  const content: EmailContent = {
    preview: `Your ${doc} for ${holding} ${e.reminder ? 'still needs' : 'is waiting for'} your signature in your portal.`,
    from: company,
    heading: e.reminder ? `Reminder: please sign your ${docName}` : `Your ${docName} is ready to sign`,
    greeting: `Hi ${e.toName},`,
    intro: [
      e.reminder
        ? isAgreement
          ? `This is a reminder from ${company}: the award agreement for your grant of ${holding} is still waiting for your signature.`
          : `This is a reminder from ${company}: your share certificate for ${holding} is still waiting for your signature.`
        : isAgreement
          ? `${company} has granted you ${holding}. The award agreement, which sets out the terms of your grant, is ready for your signature.`
          : `${company} has issued you ${holding}. Your share certificate is ready for your signature.`,
      `Please open your portal, read the ${doc} and sign it.`,
    ],
    details: [
      { label: 'Company', value: company },
      { label: isAgreement ? 'Grant' : 'Shares', value: holding },
      ...(e.reference ? [{ label: isAgreement ? 'Grant number' : 'Certificate number', value: e.reference }] : []),
      ...(e.date ? [{ label: isAgreement ? 'Grant date' : 'Issue date', value: writtenDate(e.date) }] : []),
      { label: 'Status', value: 'Waiting for your signature' },
    ],
    action: { label: 'Review and sign', url: e.link },
    actionNote: `The button opens your portal. Sign in with this email address, then choose Review & sign next to the ${doc}. You sign by typing your full name, which counts as your electronic signature.`,
    sections: [{
      title: 'What happens next',
      bullets: [
        isAgreement
          ? `Once you and ${company} have both signed, the grant is recorded as outstanding: officially granted to you and shown on the company's cap table.`
          : `Once you and ${company} have both signed, the shares are recorded as outstanding: officially issued to you and shown on the company's cap table.`,
        `The signed ${doc} stays in your portal, where you can read it at any time.`,
      ],
    }],
    signoff: `— ${mailSignature()}`,
    footer: `You are receiving this because ${company} manages its equity with ${product} and sent you this ${docName} to sign. Questions about it, or not expecting it? Contact ${company} directly.`,
  };
  return { to: e.to, toName: e.toName, subject, ...renderEmail(content, subject) };
}

async function notifyHolder(to: { name: string; email: string | null }, facts: Omit<HolderSigningEmail, 'to' | 'toName' | 'link'>): Promise<boolean> {
  if (!to.email || !mailConfigured()) return false;
  const delivery = await sendMail(composeHolderSigningEmail({ ...facts, to: to.email, toName: to.name, link: `${config().app.url}/portal` }));
  return delivery.delivered;
}

/**
 * Issues shares as a certificate that both the Company and the holder sign on
 * the platform. Until every block is signed the certificate is pending: it is
 * not outstanding, not in the cap table and not in the ledger.
 */
route.post('/api/c/:cid/issuances/issue-for-signature', 'write', async (ctx) => {
  const b = ctx.body;
  const stakeholderId = str(b.stakeholderId, 'Stakeholder');
  const shareClassId = str(b.shareClassId, 'Share class');
  const quantity = num(b.quantity, 'Quantity', { min: 1 });
  const pricePerShare = num(b.pricePerShare ?? 0, 'Price per share', { min: 0 });
  const issueDate = date(b.issueDate ?? today(), 'Issue date');
  const signerName = str(b.signerName ?? ctx.user!.name, 'Company signatory', { max: 120 });
  const signerTitle = str(b.signerTitle ?? config().equity.signerTitle, 'Signatory title', { max: 120 });
  const message = b.message ? str(b.message, 'Message', { max: 2000 }) : null;

  const holder = toCamel<{ id: string; name: string; email: string | null; legalName: string | null; taxForm: string | null; taxCountry: string | null }>(await one('SELECT * FROM stakeholders WHERE id = ? AND company_id = ?', stakeholderId, ctx.companyId));
  if (!holder) throw notFound('Stakeholder not found.');
  const shareClass = await one<{ id: string; name: string; kind: string; par_value: number }>('SELECT * FROM share_classes WHERE id = ? AND company_id = ?', shareClassId, ctx.companyId);
  if (!shareClass) throw notFound('Share class not found.');
  const schedule = b.vestingScheduleId ? (await one<{ id: string; name: string }>('SELECT id, name FROM vesting_schedules WHERE id = ? AND company_id = ?', b.vestingScheduleId, ctx.companyId)) ?? null : null;
  if (b.vestingScheduleId && !schedule) throw notFound('Vesting schedule not found.');
  const company = (await one<CertificateFacts['company']>('SELECT * FROM companies WHERE id = ?', ctx.companyId))!;

  const certificateNo = b.certificateNo ? str(b.certificateNo, 'Certificate number', { max: 40 }) : await nextCertificateNo(ctx.companyId!, shareClass);
  if (await one('SELECT 1 FROM issuances WHERE company_id = ? AND LOWER(certificate_no) = LOWER(?)', ctx.companyId, certificateNo)) {
    throw badRequest(`Certificate ${certificateNo} already exists.`);
  }
  const values = {
    certificateNo, stakeholderId, shareClassId, quantity, pricePerShare, issueDate,
    vestingScheduleId: schedule?.id ?? null, vestingStartDate: schedule ? (b.vestingStartDate ? date(b.vestingStartDate, 'Vesting start') : issueDate) : null,
    earlyExercised: b.earlyExercised ? 1 : 0, election83bFiledOn: b.election83bFiledOn ? date(b.election83bFiledOn, '83(b) date') : null,
    boardApprovalDate: b.boardApprovalDate ? date(b.boardApprovalDate, 'Board approval') : null,
    notes: b.notes ? String(b.notes).slice(0, 2000) : null, status: 'PENDING_SIGNATURE',
  };
  await validateEntity('issuances', values, ctx.companyId!);

  const issuanceId = newId('iss');
  const documentId = newId('doc');
  const facts: CertificateFacts = {
    company, holder: { name: holder.name, legal_name: holder.legalName, tax_form: holder.taxForm, tax_country: holder.taxCountry },
    shareClass, certificateNo, quantity, pricePerShare, issueDate, schedule,
    vestingStartDate: values.vestingStartDate, earlyExercised: !!values.earlyExercised, boardApprovalDate: values.boardApprovalDate,
    signerName, signerTitle, message,
    legend: (shareClass as { legend?: string | null }).legend ?? null, terms: (company as { certificate_terms?: string | null }).certificate_terms ?? null };
  const certificateTemplate = await templateFor(ctx.companyId!, 'CERTIFICATE', typeof b.templateId === 'string' ? b.templateId : null);
  const ownBack = certificateTemplate.builtIn ? undefined : renderTemplate(certificateTemplate.body, {
    company: { name: company.name, legalName: company.legal_name ?? company.name, jurisdiction: company.jurisdiction ?? config().company.jurisdiction, entityType: ENTITY_NAMES[company.entity_type ?? ''] ?? 'company', certificateTerms: (company as { certificate_terms?: string | null }).certificate_terms ?? '' },
    holder: { name: holder.name, email: holder.email ?? '' },
    grant: { label: certificateNo, quantity: fmtInt(quantity), strikePrice: fmtPerShare(pricePerShare), totalPrice: fmtUsd(Math.round((quantity * pricePerShare) / 10_000)), grantDate: issueDate,
      vestingSchedule: schedule?.name ?? '', vestingStart: values.vestingStartDate ?? '', boardApprovalDate: values.boardApprovalDate ?? '' },
    shareClass: { name: shareClass.name, parValue: fmtPerShare(shareClass.par_value), legend: (shareClass as { legend?: string | null }).legend ?? '' }, signer: { name: signerName, title: signerTitle }, message: message ?? '', today: today(),
    legends: legendsFor(facts).join('\n\n'),
  }).rendered;
  // A company's own template is the back pages; the front page and its text come from the facts either way.
  const { body: renderedCertificate, face } = stockCertificate(facts, ownBack);
  await insert('issuances', { id: issuanceId, companyId: ctx.companyId, ...values, sourceAwardId: null, createdAt: nowISO() });
  await insert('documents', {
    id: documentId, companyId: ctx.companyId, name: `Stock certificate ${certificateNo} — ${holder.name}`, category: 'CERTIFICATE',
    folder: 'Certificates', body: renderedCertificate, face: JSON.stringify(face), stakeholderId: holder.id, securityId: issuanceId, requiresSignature: 1,
    status: 'AWAITING_SIGNATURE', visibility: 'HOLDER', createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  const signatures = [
    { id: newId('sig'), companyId: ctx.companyId, documentId, stakeholderId: null, signerName: `${signerName}, ${signerTitle} — for the Company`,
      signerEmail: ctx.user!.email, status: 'PENDING', token: randomBytes(24).toString('base64url'), sentAt: nowISO(), createdAt: nowISO() },
    { id: newId('sig'), companyId: ctx.companyId, documentId, stakeholderId: holder.id, signerName: holder.name,
      signerEmail: holder.email, status: 'PENDING', token: randomBytes(24).toString('base64url'), sentAt: nowISO(), createdAt: nowISO() },
  ];
  for (const sig of signatures) await insert('signatures', sig);
  invalidate(ctx.companyId!);
  const emailed = await notifyHolder(holder, {
    companyName: company.name, shares: quantity, className: shareClass.name, reminder: false, what: 'certificate', reference: certificateNo, date: issueDate,
  });
  await audit(ctx, 'ISSUE_FOR_SIGNATURE', 'issuances', issuanceId,
    `Certificate ${certificateNo}: ${count(quantity)} ${shareClass.name} shares issued to ${holder.name}, awaiting signatures${emailed ? ' (holder emailed)' : ''}`);
  return {
    issuance: toCamel(await one('SELECT * FROM issuances WHERE id = ?', issuanceId)),
    document: toCamel(await one('SELECT * FROM documents WHERE id = ?', documentId)),
    signatures: toCamelAll(await all('SELECT * FROM signatures WHERE document_id = ? ORDER BY created_at', documentId)),
    emailed,
  };
});

/**
 * Correcting a certificate that is still out for signature.
 *
 * Before anyone has signed, the certificate is a draft and a wrong share count or
 * price should be fixable without cancelling it and starting again. Once someone
 * HAS signed, it stops being a draft: changing the terms would alter the document
 * they put their name to, so the route refuses and the certificate has to be
 * withdrawn and reissued instead.
 *
 * The document is rewritten from the corrected facts, because a record and the
 * paperwork that evidences it disagreeing is worse than either being wrong.
 */
route.patch('/api/c/:cid/issuances/:id/draft', 'write', async (ctx) => {
  const row = toCamel<Record<string, any>>(
    await one('SELECT * FROM issuances WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!row) throw notFound('Certificate not found.');
  if (row.status !== 'PENDING_SIGNATURE') {
    throw badRequest('Only a certificate that is still out for signature can be edited here.');
  }

  const doc = toCamel<Record<string, any>>(
    await one("SELECT * FROM documents WHERE company_id = ? AND security_id = ? AND category = 'CERTIFICATE'", ctx.companyId, row.id));
  const blocks = toCamelAll<Record<string, any>>(doc
    ? await all('SELECT * FROM signatures WHERE document_id = ?', doc.id)
    : []);
  const signed = blocks.filter((b) => b.status === 'SIGNED');
  if (signed.length > 0) {
    throw badRequest(`${signed.map((b) => String(b.signerName).split(' — ')[0]).join(' and ')} has already signed this certificate. Withdraw it and issue a new one to change the terms.`);
  }

  const b = ctx.body;
  const quantity = b.quantity !== undefined ? num(b.quantity, 'Quantity', { min: 1 }) : Number(row.quantity);
  const pricePerShare = b.pricePerShare !== undefined ? num(b.pricePerShare, 'Price per share', { min: 0 }) : Number(row.pricePerShare);
  const issueDate = b.issueDate !== undefined ? date(b.issueDate, 'Issue date') : String(row.issueDate);
  const certificateNo = b.certificateNo !== undefined ? str(b.certificateNo, 'Certificate number', { max: 40 }) : String(row.certificateNo ?? '');
  if (certificateNo !== row.certificateNo
      && await one('SELECT 1 FROM issuances WHERE company_id = ? AND LOWER(certificate_no) = LOWER(?) AND id <> ?', ctx.companyId, certificateNo, row.id)) {
    throw badRequest(`Certificate ${certificateNo} already exists.`);
  }

  const shareClassId = b.shareClassId !== undefined ? str(b.shareClassId, 'Share class') : String(row.shareClassId);
  const shareClass = await one<{ id: string; name: string; kind: string; par_value: number; legend: string | null }>(
    'SELECT * FROM share_classes WHERE id = ? AND company_id = ?', shareClassId, ctx.companyId);
  if (!shareClass) throw notFound('Share class not found.');
  const holder = toCamel<{ id: string; name: string; email: string | null; legalName: string | null; taxForm: string | null; taxCountry: string | null }>(
    await one('SELECT * FROM stakeholders WHERE id = ? AND company_id = ?', row.stakeholderId, ctx.companyId));
  if (!holder) throw notFound('Stakeholder not found.');

  const vestingScheduleId = b.vestingScheduleId !== undefined ? (b.vestingScheduleId || null) : (row.vestingScheduleId ?? null);
  const schedule = vestingScheduleId
    ? (await one<{ id: string; name: string }>('SELECT id, name FROM vesting_schedules WHERE id = ? AND company_id = ?', vestingScheduleId, ctx.companyId)) ?? null
    : null;
  if (vestingScheduleId && !schedule) throw notFound('Vesting schedule not found.');

  const values: Record<string, unknown> = {
    certificateNo: certificateNo || null, shareClassId, quantity, pricePerShare, issueDate,
    vestingScheduleId: schedule?.id ?? null,
    vestingStartDate: schedule ? (b.vestingStartDate ? date(b.vestingStartDate, 'Vesting start') : (row.vestingStartDate ?? issueDate)) : null,
    earlyExercised: b.earlyExercised !== undefined ? (b.earlyExercised ? 1 : 0) : row.earlyExercised,
    boardApprovalDate: b.boardApprovalDate !== undefined ? (b.boardApprovalDate ? date(b.boardApprovalDate, 'Board approval') : null) : (row.boardApprovalDate ?? null),
    notes: b.notes !== undefined ? (b.notes ? String(b.notes).slice(0, 2000) : null) : (row.notes ?? null),
  };
  await validateEntity('issuances', { ...values, status: 'PENDING_SIGNATURE' }, ctx.companyId!);
  await update('issuances', String(row.id), values);

  if (doc) {
    const cert = await certificateFromRecord(ctx, String(row.id), blocks.find((x) => x.stakeholderId == null)?.signerName ?? null);
    await update('documents', String(doc.id), { name: cert.name, body: cert.body, face: cert.face, updatedAt: nowISO() });
  }

  invalidate(ctx.companyId!);
  await audit(ctx, 'UPDATE', 'issuances', String(row.id),
    `Draft certificate ${certificateNo} corrected before signature: ${count(quantity)} ${shareClass.name} shares`);
  return {
    issuance: toCamel(await one('SELECT * FROM issuances WHERE id = ?', row.id)),
    document: doc ? toCamel(await one('SELECT * FROM documents WHERE id = ?', doc.id)) : null,
  };
});

/**
 * Voids a document: it stays, with every signature on it, marked VOID, and blocks not
 * yet signed can no longer be. What someone signed is a record and is never deleted.
 */
export async function voidDocument(ctx: Ctx, documentId: string, why: string): Promise<void> {
  await run("UPDATE documents SET status = 'VOID', updated_at = ? WHERE id = ? AND company_id = ?", nowISO(), documentId, ctx.companyId);
  await run("UPDATE signatures SET status = 'VOID' WHERE document_id = ? AND company_id = ? AND status = 'PENDING'", documentId, ctx.companyId);
  await audit(ctx, 'VOID', 'documents', documentId, `Document voided: ${why}`);
}

/**
 * The documents of a security that is withdrawn before issue: one nobody has signed is
 * deleted with its blocks, one someone has signed is voided and kept.
 */
export async function withdrawDocuments(ctx: Ctx, securityId: string, why: string): Promise<void> {
  const docs = await all<{ id: string; signed: number }>(
    "SELECT d.id, (SELECT COUNT(*) FROM signatures s WHERE s.document_id = d.id AND s.status = 'SIGNED') AS signed FROM documents d WHERE d.security_id = ? AND d.company_id = ?",
    securityId, ctx.companyId);
  for (const d of docs) {
    if (Number(d.signed) > 0) await voidDocument(ctx, d.id, why);
    else await run('DELETE FROM documents WHERE id = ? AND company_id = ?', d.id, ctx.companyId);   // signatures cascade
  }
}

/**
 * A certificate's document as its record reads now. The signature blocks name the
 * company's signatory, so a rewritten document keeps that name rather than inventing
 * one from whoever is editing.
 */
async function certificateFromRecord(ctx: Ctx, issuanceId: string, companyBlockName: string | null) {
  const row = toCamel<Record<string, any>>(await one('SELECT * FROM issuances WHERE id = ?', issuanceId))!;
  const shareClass = (await one<{ id: string; name: string; kind: string; par_value: number; legend: string | null }>('SELECT * FROM share_classes WHERE id = ?', row.shareClassId))!;
  const holder = toCamel<{ id: string; name: string; email: string | null; legalName: string | null; taxForm: string | null; taxCountry: string | null }>(
    await one('SELECT * FROM stakeholders WHERE id = ?', row.stakeholderId))!;
  const schedule = row.vestingScheduleId ? (await one<{ id: string; name: string }>('SELECT id, name FROM vesting_schedules WHERE id = ?', row.vestingScheduleId)) ?? null : null;
  // The block was written as "Name, Title — for the Company". A name can hold a
  // comma of its own, so the title is what follows the LAST comma, not the first.
  const defaultTitle = config().equity.signerTitle;
  const block = String(companyBlockName ?? `${ctx.user!.name}, ${defaultTitle}`).replace(/ — for the Company$/, '');
  const cut = block.lastIndexOf(', ');
  const [signerName, signerTitle] = cut < 0 ? [block, defaultTitle] : [block.slice(0, cut), block.slice(cut + 2)];
  const company = (await one<CertificateFacts['company'] & { certificate_terms?: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId))!;
  const { body, face } = stockCertificate({
    company, holder: { name: holder.name, legal_name: holder.legalName, tax_form: holder.taxForm, tax_country: holder.taxCountry },
    shareClass, certificateNo: String(row.certificateNo ?? ''), quantity: Number(row.quantity), pricePerShare: Number(row.pricePerShare), issueDate: String(row.issueDate),
    federalExemption: (row.federalExemption as string | null) ?? null, schedule, vestingStartDate: (row.vestingStartDate as string | null) ?? null,
    earlyExercised: !!row.earlyExercised, boardApprovalDate: (row.boardApprovalDate as string | null) ?? null,
    signerName, signerTitle, message: null, legend: shareClass.legend ?? null, terms: company.certificate_terms ?? null,
  });
  return { name: `Stock certificate ${row.certificateNo ?? ''} — ${holder.name}`, body, face: JSON.stringify(face), signerName, signerTitle, holder, certificateNo: row.certificateNo as string | null };
}

/**
 * A certificate corrected after it was signed: the signed document no longer says what
 * the record does. It is voided and kept with its signatures, and a replacement goes out
 * for both parties to sign. Until they have, the documents list shows the certificate
 * awaiting signatures beside the void one (`resign` on the certificate). One nobody has
 * signed yet is rewritten in place.
 */
export async function reissueCertificate(ctx: Ctx, issuanceId: string): Promise<void> {
  const doc = await one<{ id: string; visibility: string; folder: string | null }>(
    "SELECT id, visibility, folder FROM documents WHERE company_id = ? AND security_id = ? AND category = 'CERTIFICATE' AND status <> 'VOID' ORDER BY created_at DESC LIMIT 1",
    ctx.companyId, issuanceId);
  if (!doc) return;
  const blocks = toCamelAll<Record<string, any>>(await all('SELECT * FROM signatures WHERE document_id = ? ORDER BY created_at', doc.id));
  const companyBlock = blocks.find((b) => b.stakeholderId == null);
  const cert = await certificateFromRecord(ctx, issuanceId, companyBlock?.signerName ?? null);
  if (!blocks.some((b) => b.status === 'SIGNED')) {
    await update('documents', doc.id, { name: cert.name, body: cert.body, face: cert.face, updatedAt: nowISO() });
    return;
  }
  await voidDocument(ctx, doc.id, `certificate ${cert.certificateNo ?? issuanceId} corrected after it was signed`);
  const documentId = newId('doc');
  await insert('documents', {
    id: documentId, companyId: ctx.companyId, name: cert.name, category: 'CERTIFICATE', folder: doc.folder ?? 'Certificates', body: cert.body, face: cert.face,
    stakeholderId: cert.holder.id, securityId: issuanceId, requiresSignature: 1, status: 'AWAITING_SIGNATURE', visibility: doc.visibility,
    createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  for (const sig of [
    { stakeholderId: null, signerName: `${cert.signerName}, ${cert.signerTitle} — for the Company`, signerEmail: companyBlock?.signerEmail ?? ctx.user!.email },
    { stakeholderId: cert.holder.id, signerName: cert.holder.name, signerEmail: cert.holder.email },
  ]) {
    await insert('signatures', { id: newId('sig'), companyId: ctx.companyId, documentId, ...sig, status: 'PENDING', token: randomBytes(24).toString('base64url'), sentAt: nowISO(), createdAt: nowISO() });
  }
  await audit(ctx, 'REISSUE', 'issuances', issuanceId, `Certificate ${cert.certificateNo ?? issuanceId} corrected after signing: the signed certificate is void and a corrected one awaits signatures`);
}

/** Once every block on a certificate is signed, the shares become outstanding and enter the ledger. */
async function activateSignedIssuance(ctx: Ctx, documentId: string): Promise<void> {
  const doc = await one<{ security_id: string | null; company_id: string }>('SELECT security_id, company_id FROM documents WHERE id = ?', documentId);
  if (!doc?.security_id) return;
  const award = toCamel<Record<string, unknown>>(await one("SELECT * FROM awards WHERE id = ? AND status = 'PENDING_SIGNATURE'", doc.security_id));
  if (award) {
    await update('awards', String(award.id), { status: 'OUTSTANDING', acceptedDate: today() });
    await insert('transactions', {
      id: newId('tx'), companyId: doc.company_id, type: 'GRANT', date: award.grantDate, stakeholderId: award.stakeholderId, counterpartyId: null,
      securityId: award.id, shareClassId: null, quantity: Number(award.quantity), pricePerShare: Number(award.strikePrice ?? 0), amount: null,
      memo: `${award.label ?? 'Grant'} agreement executed electronically`, createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
    });
    invalidate(doc.company_id);
    await audit(ctx, 'GRANT_EXECUTED', 'awards', String(award.id), `Grant ${award.label ?? award.id} fully signed — ${count(Number(award.quantity))} ${award.type} now outstanding`);
    return;
  }
  const cnv = toCamel<Record<string, unknown>>(await one("SELECT * FROM convertibles WHERE id = ? AND status = 'PENDING_SIGNATURE'", doc.security_id));
  if (cnv) {
    await update('convertibles', String(cnv.id), { status: 'OUTSTANDING' });
    await insert('transactions', {
      id: newId('tx'), companyId: doc.company_id, type: 'ISSUANCE', date: cnv.issueDate, stakeholderId: cnv.stakeholderId, securityId: cnv.id,
      amount: Number(cnv.principal), memo: `${cnv.label ?? INSTRUMENT_NAMES[String(cnv.instrument)] ?? 'Instrument'} executed electronically`, createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
    });
    invalidate(doc.company_id);
    await audit(ctx, 'CONVERTIBLE_EXECUTED', 'convertibles', String(cnv.id), `${INSTRUMENT_NAMES[String(cnv.instrument)] ?? cnv.instrument} ${cnv.label ?? cnv.id} fully signed — now outstanding`);
    return;
  }
  const iss = toCamel<Record<string, unknown>>(await one("SELECT * FROM issuances WHERE id = ? AND status = 'PENDING_SIGNATURE'", doc.security_id));
  if (!iss) return;
  await update('issuances', String(iss.id), { status: 'OUTSTANDING' });
  const quantity = Number(iss.quantity);
  const price = Number(iss.pricePerShare ?? 0);
  await insert('transactions', {
    id: newId('tx'), companyId: doc.company_id, type: 'ISSUANCE', date: iss.issueDate, stakeholderId: iss.stakeholderId, counterpartyId: null,
    securityId: iss.id, shareClassId: iss.shareClassId, quantity, pricePerShare: price, amount: Math.round((quantity * price) / 10_000),
    memo: `Certificate ${iss.certificateNo ?? ''} executed electronically`.trim(), createdAt: nowISO(), createdBy: ctx.user?.name ?? null,
  });
  invalidate(doc.company_id);
  await audit(ctx, 'ISSUANCE_EXECUTED', 'issuances', String(iss.id), `Certificate ${iss.certificateNo ?? iss.id} fully signed — ${count(quantity)} shares now outstanding`);
}

/** Nudges the holder again; only their block can be reminded, and only by email. */
route.post('/api/c/:cid/issuances/:id/remind', 'write', async (ctx) => {
  const iss = toCamel<{ id: string; status: string; quantity: number; stakeholderId: string; shareClassId: string; certificateNo: string | null; issueDate: string | null }>(
    await one('SELECT * FROM issuances WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId));
  if (!iss) throw notFound('Certificate not found.');
  if (iss.status !== 'PENDING_SIGNATURE') throw badRequest('This certificate is not waiting for signatures.');
  const doc = await one<{ id: string }>('SELECT id FROM documents WHERE security_id = ? AND company_id = ?', iss.id, ctx.companyId);
  const pending = doc ? await one<{ id: string }>("SELECT id FROM signatures WHERE document_id = ? AND stakeholder_id = ? AND status = 'PENDING'", doc.id, iss.stakeholderId) : null;
  if (!pending) throw badRequest('The holder has already signed; the Company\'s countersignature is what remains.');
  const holder = toCamel<{ name: string; email: string | null }>(await one('SELECT name, email FROM stakeholders WHERE id = ?', iss.stakeholderId))!;
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  const cls = (await one<{ name: string }>('SELECT name FROM share_classes WHERE id = ?', iss.shareClassId))!;
  const emailed = await notifyHolder(holder, {
    companyName: company.name, shares: Number(iss.quantity), className: cls.name, reminder: true, what: 'certificate', reference: iss.certificateNo, date: iss.issueDate,
  });
  if (emailed) await update('signatures', pending.id, { sentAt: nowISO() });
  await audit(ctx, 'REMIND', 'issuances', iss.id, emailed ? `Reminder emailed to ${holder.name}` : `Reminder requested for ${holder.name} (not emailed)`);
  return { emailed, reason: emailed ? null : !holder.email ? 'The holder has no email address on record.' : 'Email is not configured on this server.' };
});

/** Withdraws a certificate nobody has fully signed, along with its document and signature blocks. */
route.post('/api/c/:cid/issuances/:id/cancel-signing', 'write', async (ctx) => {
  const iss = await one<{ id: string; status: string; certificate_no: string | null }>('SELECT * FROM issuances WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!iss) throw notFound('Certificate not found.');
  if (iss.status !== 'PENDING_SIGNATURE') throw badRequest('Only a certificate still awaiting signatures can be withdrawn.');
  await withdrawDocuments(ctx, iss.id, `certificate ${iss.certificate_no ?? iss.id} withdrawn before every party signed`);
  await run('DELETE FROM issuances WHERE id = ? AND company_id = ?', iss.id, ctx.companyId);
  invalidate(ctx.companyId!);
  await audit(ctx, 'WITHDRAW', 'issuances', iss.id, `Certificate ${iss.certificate_no ?? iss.id} withdrawn before signature`);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Board consents
// ---------------------------------------------------------------------------

route.get('/api/c/:cid/consents', 'read', async (ctx) => {
  const consents = toCamelAll<Record<string, unknown>>(
    await all('SELECT * FROM board_consents WHERE company_id = ? ORDER BY created_at DESC', ctx.companyId));
  const votes = toCamelAll<Record<string, unknown>>(await all(
    `SELECT v.* FROM board_votes v JOIN board_consents c ON c.id = v.consent_id
     WHERE c.company_id = ?`, ctx.companyId));
  const weight = (vs: Record<string, unknown>[], vote: string) => vs.filter((v) => v.vote === vote).reduce((sum, v) => sum + Number(v.weight ?? 0), 0);
  return consents.map((c) => {
    const mine = votes.filter((v) => v.consentId === c.id);
    return {
      ...c, kind: c.kind ?? 'BOARD',
      linkedEntityIds: c.linkedEntityIds ? JSON.parse(String(c.linkedEntityIds)) : [],
      votes: mine, approvedWeight: weight(mine, 'APPROVE'), rejectedWeight: weight(mine, 'REJECT'), pendingWeight: weight(mine, 'PENDING'),
    };
  });
});

/**
 * Opens a consent. Board consents need every named director; stockholder
 * consents are weighted by voting shares and pass at a threshold of all
 * voting shares outstanding on the effective date.
 */
route.post('/api/c/:cid/consents', 'write', async (ctx) => {
  const id = newId('con');
  const kind = ctx.body.kind === 'STOCKHOLDER' || ctx.body.type === 'STOCKHOLDER_CONSENT' ? 'STOCKHOLDER' : 'BOARD';
  const effectiveDate = date(ctx.body.effectiveDate ?? today(), 'Effective date');
  let voters: { stakeholderId: string; weight: number | null }[];
  let threshold: number | null = null;
  let totalWeight: number | null = null;
  if (kind === 'STOCKHOLDER') {
    threshold = Number(ctx.body.threshold ?? config().equity.stockholderConsentThreshold);
    if (!(threshold > 0 && threshold <= 1)) throw badRequest('Threshold must be a fraction between 0 and 1 (0.5 is a simple majority).');
    const table = computeCapTable(await getCompanyData(ctx.companyId!), { asOf: effectiveDate });
    const holders = table.rows.map((r) => ({ stakeholderId: r.stakeholderId, weight: r.votes > 0 ? r.votes : r.outstanding })).filter((h) => h.weight > 0);
    if (holders.length === 0) throw badRequest('No stockholder holds voting shares yet.');
    totalWeight = holders.reduce((sum, h) => sum + h.weight, 0);
    const chosen: string[] = Array.isArray(ctx.body.stakeholderIds) ? ctx.body.stakeholderIds.map(String) : [];
    voters = chosen.length ? holders.filter((h) => chosen.includes(h.stakeholderId)) : holders;
    if (voters.length === 0) throw badRequest('None of the chosen stakeholders holds voting shares.');
  } else {
    voters = ((ctx.body.directorIds ?? []) as string[]).map((d) => ({ stakeholderId: String(d), weight: null }));
  }
  await insert('board_consents', {
    id, companyId: ctx.companyId, title: str(ctx.body.title, 'Title', { max: 200 }), kind, threshold, totalWeight,
    type: ctx.body.type ?? (kind === 'STOCKHOLDER' ? 'STOCKHOLDER_CONSENT' : 'WRITTEN_CONSENT'), body: ctx.body.body ?? '',
    status: 'PENDING', meetingDate: ctx.body.meetingDate ?? null, effectiveDate,
    linkedEntityType: ctx.body.linkedEntityType ?? null,
    linkedEntityIds: JSON.stringify(ctx.body.linkedEntityIds ?? []),
    createdBy: ctx.user!.name, createdAt: nowISO(),
  });
  for (const v of voters) {
    await insert('board_votes', { id: newId('vot'), consentId: id, stakeholderId: v.stakeholderId, weight: v.weight, vote: 'PENDING', createdAt: nowISO() });
  }
  await audit(ctx, 'CREATE', 'board_consents', id, `${kind === 'STOCKHOLDER' ? 'Stockholder' : 'Board'} consent "${ctx.body.title}" opened`);
  return toCamel(await one('SELECT * FROM board_consents WHERE id = ?', id));
});

/** Closes a pending consent without approval (withdrawn by the company, or recorded as rejected). */
route.post('/api/c/:cid/consents/:id/close', 'write', async (ctx) => {
  const consent = await one<{ id: string; status: string; title: string }>('SELECT * FROM board_consents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!consent) throw notFound('Consent not found.');
  if (consent.status !== 'PENDING') throw badRequest('Only a pending consent can be closed.');
  const status = ctx.body.status === 'REJECTED' ? 'REJECTED' : 'WITHDRAWN';
  await update('board_consents', consent.id, { status, closedNote: ctx.body.note ? String(ctx.body.note).slice(0, 500) : null });
  await audit(ctx, 'CLOSE', 'board_consents', consent.id, `Consent "${consent.title}" ${status.toLowerCase()}`);
  return toCamel(await one('SELECT * FROM board_consents WHERE id = ?', consent.id));
});

route.post('/api/c/:cid/consents/:id/vote', 'read', async (ctx) => {
  const consent = await one<Record<string, unknown>>(
    'SELECT * FROM board_consents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!consent) throw notFound('Consent not found.');
  if (consent.status !== 'PENDING') throw badRequest('This consent is closed; votes are no longer being taken.');
  const vote = str(ctx.body.vote, 'Vote');
  if (!['APPROVE', 'REJECT', 'ABSTAIN'].includes(vote)) throw badRequest('Choose approve, reject or abstain.');

  const mine = ctx.membership!.stakeholderId;
  const target = isEditor(ctx.membership!.role) && ctx.body.stakeholderId
    ? String(ctx.body.stakeholderId) : mine;
  if (!target) throw badRequest('Your account is not linked to a board member.');

  const row = await one<{ id: string }>(
    'SELECT id FROM board_votes WHERE consent_id = ? AND stakeholder_id = ?', ctx.params.id, target);
  if (!row) throw forbidden('You are not listed as a director on this consent.');
  await update('board_votes', row.id, { vote, comment: ctx.body.comment ?? null, votedAt: nowISO() });

  const pending = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM board_votes WHERE consent_id = ? AND vote = 'PENDING'", ctx.params.id);
  const rejected = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM board_votes WHERE consent_id = ? AND vote = 'REJECT'", ctx.params.id);
  let decision: 'APPROVED' | 'REJECTED' | null = null;
  if (String(consent.kind ?? 'BOARD') === 'STOCKHOLDER') {
    // Weighted by voting shares against all voting shares outstanding, not just those invited.
    const tally = await all<{ vote: string; w: number }>('SELECT vote, COALESCE(SUM(weight), 0) AS w FROM board_votes WHERE consent_id = ? GROUP BY vote', ctx.params.id);
    const weightOf = (v: string) => Number(tally.find((t) => t.vote === v)?.w ?? 0);
    const needed = Number(consent.threshold ?? config().equity.stockholderConsentThreshold) * Number(consent.total_weight ?? 0);
    if (needed > 0 && weightOf('APPROVE') >= needed) decision = 'APPROVED';
    else if (weightOf('APPROVE') + weightOf('PENDING') < needed) decision = 'REJECTED';
  } else if ((rejected?.n ?? 0) > 0) decision = 'REJECTED';
  else if ((pending?.n ?? 0) === 0) decision = 'APPROVED';
  if (decision === 'REJECTED') {
    await update('board_consents', ctx.params.id, { status: 'REJECTED' });
  } else if (decision === 'APPROVED') {
    await update('board_consents', ctx.params.id, { status: 'APPROVED', approvedAt: nowISO() });
    // Approving a grant consent stamps the board approval date onto the grants.
    const ids: string[] = consent.linked_entity_ids ? JSON.parse(String(consent.linked_entity_ids)) : [];
    if (consent.linked_entity_type === 'awards') {
      for (const awardId of ids) {
        await update('awards', awardId, { boardApprovalDate: String(consent.effective_date ?? today()) });
        const award = await one<{ status: string; signing_config: string | null }>('SELECT status, signing_config FROM awards WHERE id = ?', awardId);
        if (award?.status === 'PENDING_APPROVAL') {
          if (award.signing_config) await startAwardSigning(ctx, awardId);
          else await issueApprovedAward(ctx, awardId);
        }
      }
      invalidate(ctx.companyId!);
    }
    if (consent.linked_entity_type === 'convertibles') {
      for (const id of ids) {
        await update('convertibles', id, { boardApprovalDate: String(consent.effective_date ?? today()) });
        const row = await one<{ status: string; signing_config: string | null }>('SELECT status, signing_config FROM convertibles WHERE id = ?', id);
        if (row?.status === 'PENDING_APPROVAL') {
          if (row.signing_config) await startConvertibleSigning(ctx, id);
          else await activateConvertible(ctx, id);
        }
      }
      invalidate(ctx.companyId!);
    }
  }
  await audit(ctx, 'VOTE', 'board_consents', ctx.params.id, `Vote recorded: ${vote}`);
  return toCamel(await one('SELECT * FROM board_consents WHERE id = ?', ctx.params.id));
});

// ---------------------------------------------------------------------------
// Ledger, audit log and the stakeholder portal
// ---------------------------------------------------------------------------

/** Rows a ledger or audit page returns: limits.ledgerPageSize unless asked, never more than limits.ledgerMaxPageSize. */
function pageSize(ctx: Ctx): number {
  const { ledgerPageSize, ledgerMaxPageSize } = config().limits;
  const asked = Math.floor(Number(ctx.query.get('limit') ?? ledgerPageSize));
  return Math.min(ledgerMaxPageSize, Number.isFinite(asked) && asked >= 0 ? asked : ledgerPageSize);
}

route.get('/api/c/:cid/transactions', 'read', async (ctx) => {
  const limit = pageSize(ctx);
  return toCamelAll(await all(
    'SELECT * FROM transactions WHERE company_id = ? ORDER BY date DESC, created_at DESC LIMIT ?',
    ctx.companyId, limit));
});

route.post('/api/c/:cid/transactions', 'write', async (ctx) => {
  const type = str(ctx.body.type, 'Type');
  if (!(TRANSACTION_TYPES as readonly string[]).includes(type)) throw badRequest(`Type must be one of ${TRANSACTION_TYPES.join(', ')}.`);
  // A correction changes a security's row and its entry together, so it is written by editing the security.
  if (type === 'CORRECTION') throw badRequest('A correction is recorded by editing the security, with an effective date.');
  // Every view reads an election, so it goes through the route that checks the adopted instrument.
  if (type === 'MFN_ELECTION') throw badRequest('An MFN election is recorded from the SAFE or note (POST /api/c/:cid/convertibles/:id/mfn-election).');
  const securityId = ctx.body.securityId ? String(ctx.body.securityId) : null;
  if (securityId && !(await securityKind(ctx.companyId!, securityId))) throw badRequest('That security does not belong to this company.');
  // The engine undoes these against the row's state of today, so one the row never had would corrupt every past view.
  if (securityId && REWOUND_TYPES.includes(type as never)) {
    throw badRequest(`A ${type} against a security is recorded with its action route (transfer, repurchase, exercise, cancel, convert or repay), which changes the security and dates the entry together.`);
  }
  // The rewind reads an entry against a security by its quantity (rewindToDate), so one there must have it.
  const quantity = ctx.body.quantity != null || securityId ? num(ctx.body.quantity, 'Quantity', { min: 1, integer: true }) : null;
  const id = newId('tx');
  await insert('transactions', {
    id, companyId: ctx.companyId, type,
    date: date(ctx.body.date ?? today(), 'Date'),
    stakeholderId: ctx.body.stakeholderId ?? null, counterpartyId: ctx.body.counterpartyId ?? null,
    securityId, shareClassId: ctx.body.shareClassId ?? null, quantity,
    pricePerShare: ctx.body.pricePerShare != null ? num(ctx.body.pricePerShare, 'Price per share', { min: 0, integer: true }) : null,
    amount: ctx.body.amount != null ? num(ctx.body.amount, 'Amount', { integer: true }) : null, memo: ctx.body.memo ?? null,
    createdAt: nowISO(), createdBy: ctx.user!.name,
  });
  invalidate(ctx.companyId!);
  await audit(ctx, 'CREATE', 'transactions', id, `Manual ${type} ledger entry`);
  return toCamel(await one('SELECT * FROM transactions WHERE id = ?', id));
});

route.get('/api/c/:cid/audit', 'read', async (ctx) => {
  if (!seesWholeVault(ctx.membership!.role)) {
    throw forbidden('Only administrators can review the audit log.');
  }
  const limit = pageSize(ctx);
  return toCamelAll(await all(
    'SELECT * FROM audit_log WHERE company_id = ? ORDER BY created_at DESC LIMIT ?', ctx.companyId, limit));
});

/** Everything a holder sees about their own equity. */
/** Stakeholders whose name reads like the user's — the usual reason an email match failed. */
async function suggestedStakeholders(companyId: string, userName: string): Promise<{ id: string; name: string; relation: string }[]> {
  const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const wanted = normalize(userName);
  if (!wanted) return [];
  const parts = wanted.split(' ').filter((p) => p.length > 1);
  const rows = await all<{ id: string; name: string; relation: string }>(
    'SELECT id, name, relation FROM stakeholders WHERE company_id = ? ORDER BY name', companyId);
  return rows.filter((r) => {
    const n = normalize(r.name);
    if (n === wanted) return true;
    // Every part of the login name appears in the record's name ("Rowan Adeyemi" in "Adeyemi, Rowan").
    return parts.length > 1 && parts.every((p) => n.split(' ').includes(p));
  }).slice(0, 5);
}

/**
 * An administrator links their own account to a stakeholder record from the
 * portal. Other roles cannot pick a record for themselves — that would show
 * them someone else's equity — so they ask an administrator instead.
 */
route.post('/api/c/:cid/portal/link', 'admin', async (ctx) => {
  const stakeholderId = str(ctx.body.stakeholderId, 'Stakeholder');
  const holder = await one<{ id: string; name: string }>('SELECT id, name FROM stakeholders WHERE id = ? AND company_id = ?', stakeholderId, ctx.companyId);
  if (!holder) throw notFound('Stakeholder not found.');
  const taken = await one<{ id: string }>('SELECT id FROM memberships WHERE company_id = ? AND stakeholder_id = ? AND id <> ?', ctx.companyId, stakeholderId, ctx.membership!.id);
  if (taken) throw badRequest('Another account is already linked to that stakeholder.');
  await update('memberships', ctx.membership!.id, { stakeholderId });
  invalidate(ctx.companyId!);
  await audit(ctx, 'UPDATE', 'memberships', ctx.membership!.id, `${ctx.user!.name} linked their account to stakeholder ${holder.name}`);
  return { ok: true, stakeholderId };
});

/** A recipient opened an update in their portal. */
route.post('/api/c/:cid/portal/updates/:id/read', 'read', async (ctx) => {
  const stakeholderId = await linkedStakeholderId(ctx);
  if (!stakeholderId) throw forbidden('Your account is not linked to a stakeholder.');
  if (!(await markUpdateRead(ctx.companyId!, stakeholderId, ctx.params.id))) throw notFound('Update not found.');
  return { ok: true };
});

route.get('/api/c/:cid/portal', 'read', async (ctx) => {
  const stakeholderId = await linkedStakeholderId(ctx);
  if (!stakeholderId) {
    const isAdmin = ctx.membership!.role === 'ADMIN';
    return {
      linked: false,
      message: 'Your account is not yet linked to a stakeholder record.',
      loginEmail: ctx.user!.email,
      canLink: isAdmin,
      suggestions: await suggestedStakeholders(ctx.companyId!, ctx.user!.name),
      stakeholders: isAdmin
        ? toCamelAll(await all('SELECT id, name, relation FROM stakeholders WHERE company_id = ? ORDER BY name', ctx.companyId))
        : undefined,
    };
  }
  const data = await getCompanyData(ctx.companyId!);
  const asOf = today();
  const holder = data.stakeholders.find((s) => s.id === stakeholderId);
  if (!holder) return { linked: false, message: 'Your stakeholder record was not found.' };

  const portfolio = portfolioValue(data, stakeholderId, asOf);
  const table = computeCapTable(data, { asOf });
  const row = table.rows.find((r) => r.stakeholderId === stakeholderId);

  const grants = portfolio.grants.map((g) => {
    const schedule = data.vestingSchedules.find((s) => s.id === g.award.vestingScheduleId);
    return {
      ...g,
      scheduleName: schedule?.name ?? 'Custom',
      curve: schedule
        ? vestingCurve({
            schedule, totalQuantity: g.award.quantity,
            vestingStartDate: g.award.vestingStartDate, terminationDate: holder.terminationDate,
          }, 72)
        : [],
    };
  });

  const documents = toCamelAll(await all(
    `SELECT * FROM documents WHERE company_id = ? AND (visibility = 'ALL' OR stakeholder_id = ?)
     ORDER BY created_at DESC`, ctx.companyId, stakeholderId));
  const exerciseRequests = toCamelAll(await all(
    `SELECT r.*, a.label AS award_label FROM exercise_requests r JOIN awards a ON a.id = r.award_id
     WHERE r.company_id = ? AND r.stakeholder_id = ? ORDER BY r.requested_at DESC`, ctx.companyId, stakeholderId));
  const companyRow = await one<{ exercise_requests_enabled: number; payment_instructions: string | null; portal_settings: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId);
  const portalSettings = { ...config().company.portal, ...(() => { try { return companyRow?.portal_settings ? JSON.parse(companyRow.portal_settings) : {}; } catch { return {}; } })() };
  const pendingVotes = toCamelAll<Record<string, unknown>>(await all(
    `SELECT c.id, c.title, c.kind, c.body, c.effective_date, c.threshold, c.total_weight, c.created_at, v.weight AS my_weight
     FROM board_votes v JOIN board_consents c ON c.id = v.consent_id
     WHERE c.company_id = ? AND v.stakeholder_id = ? AND v.vote = 'PENDING' AND c.status = 'PENDING' ORDER BY c.created_at DESC`, ctx.companyId, stakeholderId));
  const signatures = toCamelAll(await all(
    `SELECT s.*, d.name AS document_name, d.body AS document_body, d.category AS document_category, d.security_id AS document_security_id,
            d.face IS NOT NULL AS document_has_face
     FROM signatures s JOIN documents d ON d.id = s.document_id
     WHERE s.company_id = ? AND s.stakeholder_id = ? AND s.status = 'PENDING' ORDER BY s.created_at`,
    ctx.companyId, stakeholderId));

  const hideValue = <T,>(v: T): T | null => (portalSettings.showValuation ? v : null);
  return {
    linked: true, holder, portalSettings, pendingVotes,
    portfolio: {
      ...portfolio, fmv: hideValue(portfolio.fmv), sharesValue: hideValue(portfolio.sharesValue), intrinsicVested: hideValue(portfolio.intrinsicVested),
      grants: grants.map((g) => ({ ...g, intrinsicValue: hideValue(g.intrinsicValue) })),
    },
    ownershipPct: portalSettings.showOwnership ? row?.fullyDilutedPct ?? 0 : null,
    companyFullyDiluted: portalSettings.showOwnership ? table.totals.fullyDiluted : null,
    documents: portalSettings.showDocuments ? documents : documents.filter((d) => d.requiresSignature), pendingSignatures: signatures,
    updates: portalSettings.showUpdates ? await updatesFor(ctx.companyId!, stakeholderId) : [],
    exerciseRequests, exerciseRequestsEnabled: exerciseRequestsOn(companyRow), paymentInstructions: companyRow?.payment_instructions ?? null,
    issuances: data.issuances.filter((i) => i.stakeholderId === stakeholderId && i.status === 'OUTSTANDING'),
    convertibles: data.convertibles.filter((c) => c.stakeholderId === stakeholderId),
  };
});
