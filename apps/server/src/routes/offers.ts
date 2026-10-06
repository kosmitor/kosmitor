/**
 * Offer letters. The company drafts an equity offer from a template, sends the
 * candidate a link, and the candidate accepts (typed name) or declines from
 * that link without an account. An accepted offer creates the stakeholder and
 * hands its equity package to the grant flow, which closes the offer.
 */
import { randomBytes } from 'node:crypto';
import { route, newId, nowISO, audit, badRequest, notFound, str, num, date, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel } from '../db.ts';
import { getCompanyData, invalidate } from '../store.ts';
import { sendMail, mailConfigured, type Message } from '../mail.ts';
import { config } from '../config.ts';
import { renderEmail } from '../email.ts';
import { templateFor, renderTemplate, AWARD_TYPE_NAMES, ENTITY_WORDS, usd, perShare, integer, type MergeContext } from '../templates.ts';
import { today } from '@ct/core';

interface OfferRow {
  id: string; company_id: string; candidate_name: string; candidate_email: string | null; position: string; department: string | null;
  start_date: string | null; salary_cents: number | null; pool_id: string | null; award_type: string; quantity: number; strike_price: number | null;
  vesting_schedule_id: string | null; expires_on: string | null; message: string | null; template_id: string | null; signer_name: string | null;
  signer_title: string | null; body: string | null; status: string; token: string | null; sent_at: string | null; viewed_at: string | null;
  accepted_at: string | null; accepted_name: string | null; accepted_ip: string | null; declined_at: string | null; decline_reason: string | null;
  stakeholder_id: string | null; award_id: string | null; created_by: string | null; created_at: string; updated_at: string | null;
}

const OFFER_TYPES = ['ISO', 'NSO', 'RSU'];
/** equity.awardType when an offer can carry it, else the first type an offer can. */
const defaultOfferType = (): string => (OFFER_TYPES.includes(config().equity.awardType) ? config().equity.awardType : OFFER_TYPES[0]);
const isExpired = (o: OfferRow): boolean => o.status === 'SENT' && !!o.expires_on && o.expires_on < today();
const linkFor = (o: OfferRow) => (o.token && o.status === 'SENT' ? `${config().app.url}/offer/${o.token}` : null);

async function offerRow(ctx: Ctx, id: string): Promise<OfferRow> {
  const row = await one<OfferRow>('SELECT * FROM offers WHERE id = ? AND company_id = ?', id, ctx.companyId);
  if (!row) throw notFound('Offer not found.');
  return row;
}

/** Merge fields for an offer: the candidate stands in for the holder, and the equity package for the grant. */
async function offerContext(o: OfferRow): Promise<MergeContext> {
  const data = await getCompanyData(o.company_id);
  const company = (await one<{ name: string; legal_name: string | null; jurisdiction: string | null; entity_type: string | null; address: string | null }>('SELECT * FROM companies WHERE id = ?', o.company_id))!;
  const plan = data.pools.find((p) => p.id === o.pool_id);
  const schedule = data.vestingSchedules.find((v) => v.id === o.vesting_schedule_id);
  const shareClass = data.shareClasses.find((c) => c.id === plan?.shareClassId);
  const settlesForFree = o.award_type === 'RSU';
  return {
    company: { name: company.name, legalName: company.legal_name ?? company.name, jurisdiction: company.jurisdiction ?? config().company.jurisdiction, entityType: ENTITY_WORDS[company.entity_type ?? ''] ?? 'company', address: company.address ?? '' },
    holder: { name: o.candidate_name, email: o.candidate_email ?? '', title: o.position, address: '' },
    grant: {
      label: '', type: o.award_type, typeName: AWARD_TYPE_NAMES[o.award_type] ?? o.award_type, isIso: o.award_type === 'ISO' ? 'yes' : '', quantity: integer(Number(o.quantity)),
      strikePrice: !settlesForFree && o.strike_price != null ? perShare(Number(o.strike_price)) : '', totalPrice: '', grantDate: '', expirationDate: '',
      vestingSchedule: schedule?.name ?? '', vestingStart: o.start_date ?? '', boardApprovalDate: '', ptepMonths: '', earlyExercise: '',
    },
    plan: { name: plan?.name ?? 'equity incentive plan', shareClass: shareClass?.name ?? '' }, shareClass: { name: shareClass?.name ?? '', parValue: shareClass ? perShare(shareClass.parValue) : '' },
    offer: { position: o.position, startDate: o.start_date ?? 'a date to be agreed', salary: o.salary_cents != null ? usd(Number(o.salary_cents)) : '', expiresOn: o.expires_on ?? '' },
    signer: { name: o.signer_name ?? '', title: o.signer_title ?? '' }, message: o.message ?? '', today: today(),
  };
}

async function renderOffer(o: OfferRow): Promise<string> {
  const template = await templateFor(o.company_id, 'OFFER_LETTER', o.template_id);
  return renderTemplate(template.body, await offerContext(o)).rendered;
}

/** The fields an admin sets; validated against the company's plans and schedules. */
async function readOffer(ctx: Ctx, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = await getCompanyData(ctx.companyId!);
  const awardType = str(b.awardType ?? defaultOfferType(), 'Award type');
  if (!OFFER_TYPES.includes(awardType)) throw badRequest('Offers cover ISOs, NSOs or RSUs.');
  const poolId = b.poolId ? String(b.poolId) : null;
  if (poolId && !data.pools.some((p) => p.id === poolId)) throw badRequest('Choose an equity plan of this company.');
  const vestingScheduleId = b.vestingScheduleId ? String(b.vestingScheduleId) : null;
  if (vestingScheduleId && !data.vestingSchedules.some((v) => v.id === vestingScheduleId)) throw badRequest('Choose a vesting schedule of this company.');
  const email = b.candidateEmail ? str(b.candidateEmail, 'Email', { max: 200 }).trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('That email address does not look right.');
  return {
    candidateName: str(b.candidateName, 'Candidate', { max: 120 }), candidateEmail: email,
    position: str(b.position, 'Position', { max: 120 }), department: b.department ? str(b.department, 'Department', { max: 120 }) : null,
    startDate: b.startDate ? date(b.startDate, 'Start date') : null,
    salaryCents: b.salary != null && b.salary !== '' ? num(b.salary, 'Salary', { min: 0 }) : null,
    poolId, awardType, quantity: num(b.quantity, 'Number of shares', { min: 1 }),
    strikePrice: awardType !== 'RSU' && b.strikePrice != null && b.strikePrice !== '' ? num(b.strikePrice, 'Exercise price', { min: 0 }) : null,
    vestingScheduleId, expiresOn: b.expiresOn ? date(b.expiresOn, 'Expiry date') : null,
    message: b.message ? String(b.message).slice(0, 4000) : null, templateId: b.templateId ? String(b.templateId) : null,
    signerName: str(b.signerName ?? ctx.user!.name, 'Signed by', { max: 120 }), signerTitle: str(b.signerTitle ?? config().equity.offerSignerTitle, 'Signer title', { max: 120 }),
  };
}

function present(o: OfferRow, names: { pools: Map<string, string>; schedules: Map<string, string> }) {
  const { token: _token, ...rest } = o;
  return {
    ...toCamel<Record<string, unknown>>(rest), expired: isExpired(o), link: linkFor(o),
    poolName: o.pool_id ? names.pools.get(o.pool_id) ?? null : null, scheduleName: o.vesting_schedule_id ? names.schedules.get(o.vesting_schedule_id) ?? null : null,
  };
}

async function nameMaps(companyId: string) {
  const data = await getCompanyData(companyId);
  return { pools: new Map(data.pools.map((p) => [p.id, p.name])), schedules: new Map(data.vestingSchedules.map((v) => [v.id, v.name])) };
}

// --- Company side -----------------------------------------------------------

route.get('/api/c/:cid/offers', 'read', async (ctx) => {
  const rows = await all<OfferRow>('SELECT * FROM offers WHERE company_id = ? ORDER BY created_at DESC', ctx.companyId);
  const names = await nameMaps(ctx.companyId!);
  const counts: Record<string, number> = {};
  for (const o of rows) { const k = isExpired(o) ? 'EXPIRED' : o.status; counts[k] = (counts[k] ?? 0) + 1; }
  return { offers: rows.map((o) => present(o, names)), counts };
});

route.get('/api/c/:cid/offers/:id', 'read', async (ctx) => present(await offerRow(ctx, ctx.params.id), await nameMaps(ctx.companyId!)));

route.post('/api/c/:cid/offers', 'write', async (ctx) => {
  const values = await readOffer(ctx, ctx.body);
  const id = newId('off');
  await insert('offers', { id, companyId: ctx.companyId, ...values, status: 'DRAFT', createdBy: ctx.user!.name, createdAt: nowISO() });
  const row = await offerRow(ctx, id);
  await update('offers', id, { body: await renderOffer(row) });
  await audit(ctx, 'CREATE', 'offers', id, `Offer to ${values.candidateName} drafted — ${integer(Number(values.quantity))} ${values.awardType}s as ${values.position}`);
  return present(await offerRow(ctx, id), await nameMaps(ctx.companyId!));
});

route.patch('/api/c/:cid/offers/:id', 'write', async (ctx) => {
  const existing = await offerRow(ctx, ctx.params.id);
  if (!['DRAFT', 'SENT'].includes(existing.status)) throw badRequest('Only a draft or an open offer can be edited.');
  const values = await readOffer(ctx, { ...toCamel<Record<string, unknown>>(existing as unknown as Record<string, unknown>), salary: existing.salary_cents, ...ctx.body });
  await update('offers', existing.id, { ...values, updatedAt: nowISO() });
  await update('offers', existing.id, { body: await renderOffer(await offerRow(ctx, existing.id)) });
  await audit(ctx, 'UPDATE', 'offers', existing.id, `Offer to ${values.candidateName} updated`);
  return present(await offerRow(ctx, existing.id), await nameMaps(ctx.companyId!));
});

// --- The email -------------------------------------------------------------------

/** A date the way a letter writes it: December 31, 2026. */
const longDate = (iso: string): string =>
  new Intl.DateTimeFormat(config().locale.locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
/** Cuts a company name for a subject line, which mail apps show only the start of. */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s);

export interface OfferEmail {
  companyName: string;
  /** The candidate's address and name. */
  to: string;
  candidateName: string;
  position: string;
  /** The candidate's page: the letter, and where they accept or decline it. */
  link: string;
  /** The last day the offer can be accepted, when it has one. */
  expiresOn: string | null;
  startDate?: string | null;
  /** Who signs the letter; the company when nobody is named. */
  signerName: string | null;
  signerTitle?: string | null;
}

/**
 * The email that carries an offer to the candidate. It says who the offer is
 * from, for what role and until when, and leaves the pay and the equity to the
 * letter behind the link. Pure, so the wording can be tested without sending it.
 */
export function composeOfferEmail(o: OfferEmail): Message {
  const product = config().brand.productName;
  const company = o.companyName;
  const until = o.expiresOn ? longDate(o.expiresOn) : null;
  const subject = `${clip(company, 40)}: review your offer letter`;
  const content = {
    preview: until
      ? `Read your offer for ${o.position} and accept or decline it by ${until}.`
      : `Read your offer for ${o.position}, then accept or decline it online.`,
    from: company,
    heading: `Your offer from ${company}`,
    greeting: `Hi ${o.candidateName},`,
    intro: [
      `${company} has made you an offer for the role of ${o.position}, and your offer letter is ready to read.`,
      `Please read it, then accept or decline${until ? ` by ${until}` : ''}. You can do both from the same page, without creating an account.`,
    ],
    details: [
      { label: 'Company', value: company },
      { label: 'Role', value: o.position },
      ...(o.startDate ? [{ label: 'Start date', value: longDate(o.startDate) }] : []),
      ...(until ? [{ label: 'Offer open until', value: until }] : []),
    ],
    action: { label: 'Read your offer', url: o.link },
    actionNote: `This link is for you alone: anyone who has it can accept or decline the offer, so please do not forward it.${
      until ? ` After ${until} the offer can no longer be accepted online.` : ''}`,
    sections: [{
      title: 'What happens next',
      bullets: [
        'Read the letter. It sets out the full terms of the offer.',
        'To accept, type your full name on the same page. To decline, choose Decline instead; you can say why if you want to.',
        `If your offer includes equity, ${company} will send the grant documents for you to sign separately.`,
      ],
    }],
    signoff: `— ${o.signerName ? `${o.signerName}${o.signerTitle ? `, ${o.signerTitle}` : ''}` : company}`,
    footer: `You are receiving this because ${company} sent you an offer through ${product}. If it was not meant for you, please ignore it and do not use the link. Questions about the offer? Contact ${company} directly.`,
  };
  return { to: o.to, toName: o.candidateName, subject, ...renderEmail(content, subject) };
}

/** Sends (or re-sends) the accept link. The letter is re-rendered so template edits reach the candidate. */
route.post('/api/c/:cid/offers/:id/send', 'write', async (ctx) => {
  const o = await offerRow(ctx, ctx.params.id);
  if (!['DRAFT', 'SENT'].includes(o.status)) throw badRequest('This offer has already been answered or withdrawn.');
  if (o.expires_on && o.expires_on < today()) throw badRequest('The offer\'s expiry date has passed; move it before sending.');
  const token = o.token ?? randomBytes(24).toString('base64url');
  await update('offers', o.id, { token, status: 'SENT', sentAt: nowISO(), body: await renderOffer(o), updatedAt: nowISO() });
  const sent = await offerRow(ctx, o.id);
  const link = linkFor(sent)!;
  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))!;
  let emailed = false;
  if (sent.candidate_email && mailConfigured()) {
    emailed = (await sendMail(composeOfferEmail({
      companyName: company.name, to: sent.candidate_email, candidateName: sent.candidate_name, position: sent.position,
      link, expiresOn: sent.expires_on, startDate: sent.start_date, signerName: sent.signer_name, signerTitle: sent.signer_title,
    }))).delivered;
  }
  await audit(ctx, o.status === 'SENT' ? 'RESEND' : 'SEND', 'offers', o.id, `Offer to ${sent.candidate_name} ${o.status === 'SENT' ? 're-sent' : 'sent'}${emailed ? ' by email' : ''}`);
  return {
    offer: present(sent, await nameMaps(ctx.companyId!)), link, emailed,
    reason: emailed ? null : !sent.candidate_email ? 'The offer has no email address.' : 'Email is not configured on this server.',
  };
});

route.post('/api/c/:cid/offers/:id/withdraw', 'write', async (ctx) => {
  const o = await offerRow(ctx, ctx.params.id);
  if (!['DRAFT', 'SENT'].includes(o.status)) throw badRequest('Only an open offer can be withdrawn.');
  await update('offers', o.id, { status: 'WITHDRAWN', updatedAt: nowISO() });
  await audit(ctx, 'WITHDRAW', 'offers', o.id, `Offer to ${o.candidate_name} withdrawn`);
  return present(await offerRow(ctx, o.id), await nameMaps(ctx.companyId!));
});

/** Turns an accepted offer into a stakeholder (matched by email, else created) ready for the grant flow. */
route.post('/api/c/:cid/offers/:id/convert', 'write', async (ctx) => {
  const o = await offerRow(ctx, ctx.params.id);
  if (o.status !== 'ACCEPTED') throw badRequest('Only an accepted offer can be turned into a grant.');
  let stakeholderId = o.stakeholder_id;
  if (!stakeholderId) {
    const existing = o.candidate_email
      ? await one<{ id: string }>('SELECT id FROM stakeholders WHERE company_id = ? AND LOWER(email) = ?', ctx.companyId, o.candidate_email)
      : undefined;
    if (existing) {
      stakeholderId = existing.id;
    } else {
      stakeholderId = newId('stk');
      await insert('stakeholders', {
        id: stakeholderId, companyId: ctx.companyId, name: o.candidate_name, email: o.candidate_email, type: 'INDIVIDUAL', relation: 'EMPLOYEE',
        title: o.position, department: o.department, startDate: o.start_date, createdAt: nowISO(),
      });
      await audit(ctx, 'CREATE', 'stakeholders', stakeholderId, `${o.candidate_name} added from their accepted offer`);
    }
    await update('offers', o.id, { stakeholderId, updatedAt: nowISO() });
    invalidate(ctx.companyId!);
  }
  return { offer: present(await offerRow(ctx, o.id), await nameMaps(ctx.companyId!)), stakeholderId };
});

route.del('/api/c/:cid/offers/:id', 'write', async (ctx) => {
  const o = await offerRow(ctx, ctx.params.id);
  if (['ACCEPTED', 'CONVERTED'].includes(o.status)) throw badRequest('An accepted offer is part of the record; withdraw or grant it instead.');
  await run('DELETE FROM offers WHERE id = ?', o.id);
  await audit(ctx, 'DELETE', 'offers', o.id, `Offer to ${o.candidate_name} deleted`);
  return { ok: true };
});

// --- Candidate side (no account) -----------------------------------------------

async function byToken(token: string): Promise<OfferRow> {
  const o = token ? await one<OfferRow>('SELECT * FROM offers WHERE token = ?', token) : undefined;
  if (!o) throw notFound('This offer link is not valid.');
  return o;
}

function publicView(o: OfferRow, company: { name: string; legal_name: string | null }, names: { pools: Map<string, string>; schedules: Map<string, string> }) {
  return {
    status: o.status, expired: isExpired(o), company: { name: company.name, legalName: company.legal_name ?? company.name },
    candidateName: o.candidate_name, position: o.position, startDate: o.start_date, salary: o.salary_cents != null ? usd(Number(o.salary_cents)) : null,
    equity: {
      quantity: integer(Number(o.quantity)), awardType: o.award_type, awardTypeName: AWARD_TYPE_NAMES[o.award_type] ?? o.award_type,
      strikePrice: o.award_type !== 'RSU' && o.strike_price != null ? perShare(Number(o.strike_price)) : null,
      vestingSchedule: o.vesting_schedule_id ? names.schedules.get(o.vesting_schedule_id) ?? null : null, planName: o.pool_id ? names.pools.get(o.pool_id) ?? null : null,
    },
    body: o.body ?? '', expiresOn: o.expires_on, acceptedAt: o.accepted_at, acceptedName: o.accepted_name, declinedAt: o.declined_at,
  };
}

route.get('/api/offers/:token', 'public', async (ctx) => {
  const o = await byToken(ctx.params.token);
  if (o.status === 'SENT' && !o.viewed_at) await update('offers', o.id, { viewedAt: nowISO() });
  const company = (await one<{ name: string; legal_name: string | null }>('SELECT name, legal_name FROM companies WHERE id = ?', o.company_id))!;
  return publicView(o, company, await nameMaps(o.company_id));
});

route.post('/api/offers/:token/accept', 'public', async (ctx) => {
  const o = await byToken(ctx.params.token);
  if (o.status !== 'SENT') throw badRequest(o.status === 'ACCEPTED' || o.status === 'CONVERTED' ? 'This offer has already been accepted.' : 'This offer is no longer open.');
  if (isExpired(o)) throw badRequest('This offer has expired. Contact the company if you would still like to accept.');
  const typedName = str(ctx.body.typedName, 'Your full name', { max: 120 }).trim();
  if (typedName.length < 2) throw badRequest('Type your full name to accept.');
  await update('offers', o.id, { status: 'ACCEPTED', acceptedAt: nowISO(), acceptedName: typedName, acceptedIp: ctx.ip, updatedAt: nowISO() });
  ctx.companyId = o.company_id;
  await audit(ctx, 'ACCEPT', 'offers', o.id, `${o.candidate_name} accepted the offer as "${typedName}"`);
  return { ok: true, status: 'ACCEPTED' };
});

route.post('/api/offers/:token/decline', 'public', async (ctx) => {
  const o = await byToken(ctx.params.token);
  if (o.status !== 'SENT') throw badRequest('This offer is no longer open.');
  const reason = ctx.body.reason ? String(ctx.body.reason).slice(0, 2000) : null;
  await update('offers', o.id, { status: 'DECLINED', declinedAt: nowISO(), declineReason: reason, updatedAt: nowISO() });
  ctx.companyId = o.company_id;
  await audit(ctx, 'DECLINE', 'offers', o.id, `${o.candidate_name} declined the offer${reason ? `: ${reason.slice(0, 120)}` : ''}`);
  return { ok: true, status: 'DECLINED' };
});
