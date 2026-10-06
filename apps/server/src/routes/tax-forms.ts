/**
 * Printable tax paperwork: a Section 83(b) election statement prefilled for a
 * restricted-stock holder, and per-employee Form 3921 information statements
 * for ISO exercises. Both are original plain-language documents rendered as
 * printable pages; tax identification numbers are never stored, so those
 * fields stay blank for the taxpayer to complete.
 */
import { route, audit, notFound, forbidden, badRequest } from '../http.ts';
import { all, one } from '../db.ts';
import { getCompanyData, cancellationDates } from '../store.ts';
import { election83bRows, form3921Rows, activeValuation, today } from '@kosmitor/core';
import { esc, page, sendHtml } from './certificates.ts';

const usd = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const perShare = (micro: number): string => `$${(micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const n = (x: number): string => x.toLocaleString('en-US');
const field = (label: string, value: string | null | undefined, blank = '________________________') => `<tr><th>${esc(label)}</th><td>${value ? esc(value) : `<span class="blank">${blank}</span>`}</td></tr>`;

const FORM_STYLE = `<style>
  table.form { width: 100%; border-collapse: collapse; margin: 14px 0; font: 13px/1.5 Georgia, serif; }
  table.form th { text-align: left; width: 38%; padding: 6px 8px; vertical-align: top; color: #333; font-weight: 600; border-bottom: 1px solid #ddd; }
  table.form td { padding: 6px 8px; border-bottom: 1px solid #ddd; }
  .blank { color: #999; letter-spacing: .05em; }
  ol { padding-left: 20px; } li { margin: 6px 0; }
  .note { font: 12px/1.5 -apple-system, Helvetica, Arial, sans-serif; color: #555; margin-top: 10px; }
  .sigline { margin-top: 26px; display: flex; gap: 40px; } .sigline div { flex: 1; border-top: 1px solid #333; padding-top: 4px; font: 11px -apple-system, Helvetica, Arial, sans-serif; color: #555; }
</style>`;

/** A holder's 83(b) election statement and the instructions for filing it. */
route.get('/api/c/:cid/compliance/83b/:issuanceId/print', 'read', async (ctx) => {
  const data = await getCompanyData(ctx.companyId!);
  const iss = data.issuances.find((i) => i.id === ctx.params.issuanceId);
  if (!iss) throw notFound('Certificate not found.');
  const role = ctx.membership!.role;
  if (!['ADMIN', 'LEGAL', 'BOARD'].includes(role) && iss.stakeholderId !== ctx.membership!.stakeholderId) throw forbidden('You can only print your own election.');
  const row = election83bRows(data, today()).find((r) => r.issuanceId === iss.id);
  if (!row) throw badRequest('This certificate is not restricted stock; no 83(b) election applies.');
  const company = (await one<{ name: string; legal_name: string | null; address: string | null; ein: string | null; jurisdiction: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId))!;
  const holder = (await one<{ name: string; address: string | null; email: string | null }>('SELECT name, address, email FROM stakeholders WHERE id = ?', iss.stakeholderId))!;
  const shareClass = data.shareClasses.find((c) => c.id === iss.shareClassId);
  const fmv = activeValuation(data, iss.issueDate) || iss.pricePerShare;
  const paid = Math.round((iss.quantity * iss.pricePerShare) / 10_000);
  const value = Math.round((iss.quantity * fmv) / 10_000);
  const legalName = company.legal_name ?? company.name;
  const taxYear = iss.issueDate.slice(0, 4);
  const restriction = row.reason === 'early exercise'
    ? 'The shares were acquired by early exercise of a stock option and are subject to the company\'s right to repurchase unvested shares at the lower of cost and fair market value if the taxpayer\'s service ends before they vest.'
    : 'The shares vest over time while the taxpayer provides services to the company and, until vested, are subject to the company\'s right to repurchase them at the lower of cost and fair market value if that service ends.';

  const statement = `<section class="sheet"><div class="company">Section 83(b) election</div><h1>Election to include the value of restricted property in gross income in the year of transfer</h1>
<p style="font:13.5px/1.6 Georgia,serif">The undersigned taxpayer elects, under Section 83(b) of the Internal Revenue Code of 1986, as amended, and the regulations under it, to include in gross income for the taxable year below the excess, if any, of the fair market value of the property described here over the amount paid for it.</p>
<table class="form">
${field('1. Taxpayer name', holder.name)}${field('Taxpayer address', holder.address)}${field('Taxpayer identification number', null)}
${field('2. Property', `${n(iss.quantity)} shares of ${shareClass?.name ?? 'stock'} of ${legalName}${iss.certificateNo ? ` (certificate ${iss.certificateNo})` : ''}`)}
${field('3. Date of transfer', iss.issueDate)}${field('Taxable year of the election', `Calendar year ${taxYear}`)}
${field('4. Restrictions on the property', restriction)}
${field('5. Fair market value at transfer', `${usd(value)} (${perShare(fmv)} per share, determined without regard to any restriction other than one that by its terms will never lapse)`)}
${field('6. Amount paid for the property', `${usd(paid)} (${perShare(iss.pricePerShare)} per share)`)}
${field('7. Amount to include in gross income', usd(Math.max(0, value - paid)))}
</table>
<p style="font:13px/1.6 Georgia,serif">The taxpayer will furnish a copy of this election to the company for which the services are performed. The taxpayer understands that the election is irrevocable once made, other than with the consent of the Commissioner, and that it must be filed no later than 30 days after the date of transfer.</p>
<div class="sigline"><div>Taxpayer signature</div><div>Date</div></div>
${holder.email ? '' : ''}</section>`;

  const instructions = `<section class="sheet"><div class="company">${esc(legalName)}</div><h1>How to file your 83(b) election</h1>
<ol style="font:13.5px/1.7 Georgia,serif">
<li><strong>Deadline: ${esc(row.deadline)}.</strong> The election must be postmarked within 30 days of ${esc(iss.issueDate)}, the date the shares were transferred to you. The IRS does not extend this deadline.</li>
<li>Fill in your taxpayer identification number (Social Security or ITIN) by hand, then sign and date the statement. Make at least two copies.</li>
<li>Mail the signed original to the IRS service center where you file your federal income tax return. Use certified mail with a return receipt, or another method that proves the mailing date, and keep the proof with your records.</li>
<li>Give one copy to ${esc(legalName)}${company.address ? ` at ${esc(company.address)}` : ''}, and record the filing date in your equity portal so the company's records match.</li>
<li>Keep a copy with your own tax records. Check the current IRS instructions on whether a copy must also be attached to your return for the year of transfer.</li>
</ol>
<p class="note">Company details for your reference: ${esc(legalName)}${company.ein ? `, EIN ${esc(company.ein)}` : ''}${company.jurisdiction ? `, a ${esc(company.jurisdiction)} corporation` : ''}. This paperwork was prepared from the company's records on ${today()}; it is not tax advice. Whether to make the election is your decision, ideally with a tax adviser.</p>
</section>`;

  await audit(ctx, 'PRINT', 'issuances', iss.id, `83(b) election statement printed for ${holder.name}`);
  return sendHtml(ctx, page(`83(b) election — ${holder.name}`, `${FORM_STYLE}${statement}${instructions}`));
});

/** One information statement per ISO exercise in a year, for the employees. */
route.get('/api/c/:cid/compliance/form-3921/:year/statements', 'read', async (ctx) => {
  if (!['ADMIN', 'LEGAL', 'BOARD', 'VIEWER'].includes(ctx.membership!.role)) throw forbidden('Only company users can print employee statements.');
  const year = Number(ctx.params.year);
  if (!Number.isInteger(year) || year < 1990) throw badRequest('Choose a tax year.');
  const data = await getCompanyData(ctx.companyId!);
  let rows = form3921Rows(data, year, { cancellationDates: await cancellationDates(ctx.companyId!) });
  const only = ctx.query.get('stakeholderId');
  if (only) rows = rows.filter((r) => r.stakeholderId === only);
  if (rows.length === 0) throw notFound(`No ISO exercises in ${year}.`);
  const company = (await one<{ name: string; legal_name: string | null; address: string | null; ein: string | null }>('SELECT * FROM companies WHERE id = ?', ctx.companyId))!;
  const people = new Map((await all<{ id: string; address: string | null }>('SELECT id, address FROM stakeholders WHERE company_id = ?', ctx.companyId)).map((p) => [p.id, p.address]));
  const legalName = company.legal_name ?? company.name;
  const sheets = rows.map((r) => `<section class="sheet"><div class="company">Form 3921 information statement · tax year ${year}</div><h1>Exercise of an incentive stock option</h1>
<p style="font:13px/1.6 Georgia,serif">${esc(legalName)} provides this statement to the employee named below about a transfer of stock on the exercise of an incentive stock option, as Section 6039 of the Internal Revenue Code requires. The corporation files the corresponding return with the IRS; keep this statement for your records and for the year you sell the shares.</p>
<table class="form">
${field('Transferor (corporation)', legalName)}${field('Transferor EIN', company.ein)}${field('Transferor address', company.address)}
${field('Employee', r.stakeholderName)}${field('Employee address', people.get(r.stakeholderId) ?? null)}${field('Employee identification number', null)}
${field('Box 1 · Date option granted', r.grantDate)}${field('Box 2 · Date option exercised', r.exerciseDate)}
${field('Box 3 · Exercise price per share', perShare(r.exercisePrice))}${field('Box 4 · Fair market value per share on exercise date', perShare(r.fmvAtExercise))}
${field('Box 5 · Number of shares transferred', n(r.quantity))}${field('Box 6 · Transferor if other than the corporation', 'Not applicable')}
${field('Grant', r.awardLabel ?? r.awardId)}${field('Spread at exercise (Box 4 − Box 3) × Box 5', usd(r.spread))}
</table>
<p class="note">The spread is not ordinary income at exercise for an incentive stock option but may be an adjustment for the alternative minimum tax. Selling within two years of grant or one year of exercise makes the sale a disqualifying disposition. Prepared ${today()} from the company's records; not tax advice.</p>
</section>`).join('');
  await audit(ctx, 'PRINT', 'compliance', null, `Form 3921 employee statements printed for ${year} (${rows.length})`);
  return sendHtml(ctx, page(`Form 3921 statements ${year} — ${company.name}`, `${FORM_STYLE}${sheets}`));
});
