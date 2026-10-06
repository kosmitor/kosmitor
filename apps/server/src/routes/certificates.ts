/**
 * Printable certificates and agreements, and emailing certificates to their
 * holders. Print views are self-contained HTML pages the browser can save as
 * PDF; the signature record travels with the document.
 */
import { createHash } from 'node:crypto';
import { route, audit, notFound, forbidden, badRequest, type Ctx } from '../http.ts';
import { all, one, toCamel, toCamelAll } from '../db.ts';
import { sendMail, mailConfigured, type Message } from '../mail.ts';
import { renderEmail, esc } from '../email.ts';
import { documentPdf, certificatePdf, certificateBookPdf, type CertificatePdfInput } from '../pdf-writer.ts';
import { parseFace } from '../certificate-face.ts';
import { config, iconLinks } from '../config.ts';
import { seesWholeCompany, seesWholeVault } from '../auth.ts';


export interface Doc { id: string; company_id: string; name: string; category: string; body: string | null; face: string | null; status: string; stakeholder_id: string | null; security_id: string | null; visibility: string; requires_signature: number; created_at: string }
interface Sig { signer_name: string; status: string; typed_signature: string | null; signed_at: string | null; ip_address: string | null; stakeholder_id: string | null; body_sha256?: string | null }

/**
 * Whether the text is no longer what someone signed: a signature's stored hash of the
 * body differs from the body now. The routes refuse that edit, so it means the row was
 * changed past them. Signatures from before hashes were kept are not checked.
 */
export function changedSinceSigned(body: string | null, sigs: { status?: unknown; bodySha256?: unknown; body_sha256?: unknown }[]): boolean {
  const hash = createHash('sha256').update(body ?? '').digest('hex');
  return sigs.some((s) => s.status === 'SIGNED' && (s.bodySha256 ?? s.body_sha256) != null && (s.bodySha256 ?? s.body_sha256) !== hash);
}
/** The warning printed on a document whose text changed after it was signed. */
const TAMPERED = 'WARNING: this text has changed since it was signed';
const warnIfChanged = (doc: Doc, sigs: Sig[]): string => (changedSinceSigned(doc.body, sigs) ? `${TAMPERED} \u00b7 ` : '');

const STYLE = `
  @page { margin: 22mm 20mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 0; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; padding: 32px 24px; page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  .company { font: 600 11px/1.4 -apple-system, Helvetica, Arial, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #555; }
  h1 { font-size: 20px; margin: 4px 0 18px; font-weight: 600; }
  pre { white-space: pre-wrap; font: 13.5px/1.6 Georgia, 'Times New Roman', serif; margin: 0; }
  .sigs { margin-top: 28px; border-top: 1px solid #bbb; padding-top: 14px; font: 12px/1.5 -apple-system, Helvetica, Arial, sans-serif; }
  .sig { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-bottom: 1px dotted #ddd; }
  .cursive { font-family: 'Snell Roundhand', 'Brush Script MT', cursive; font-size: 17px; }
  .meta { color: #666; }
  .foot { margin-top: 20px; font: 10.5px/1.4 -apple-system, Helvetica, Arial, sans-serif; color: #777; }
  @media screen { body { background: #f4f4f5; } .sheet { background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.12); margin: 24px auto; } .bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e4e4e7; padding: 10px 24px; font: 13px -apple-system, Helvetica, Arial, sans-serif; display: flex; gap: 12px; align-items: center; } }
  @media print { .bar { display: none; } }
`;

/** The footer line for a document that every party has signed. */
const executedNote = (): string => `Fully executed electronically on the ${config().brand.productName} platform`;

function sheet(company: { name: string; legal_name: string | null }, doc: Doc, sigs: Sig[]): string {
  const signatureRows = sigs.length ? `<div class="sigs">${sigs.map((s) => `<div class="sig"><span>${esc(s.signer_name)}</span>${
    s.status === 'SIGNED'
      ? `<span><span class="cursive">${esc(s.typed_signature)}</span> <span class="meta">· signed ${esc(String(s.signed_at).replace('T', ' ').slice(0, 16))} UTC${s.ip_address ? ` · ${esc(s.ip_address)}` : ''}</span></span>`
      : '<span class="meta">Not yet signed</span>'}</div>`).join('')}</div>` : '';
  return `<section class="sheet"><div class="company">${esc(company.legal_name ?? company.name)}</div><h1>${esc(doc.name)}</h1><pre>${esc(doc.body ?? '')}</pre>${signatureRows}<div class="foot">${esc(warnIfChanged(doc, sigs))}${
    doc.status === 'EXECUTED' ? `${esc(executedNote())}. ` : doc.requires_signature ? 'Signatures pending. ' : ''}Document ${esc(doc.id)} · generated ${new Date().toISOString().slice(0, 10)}</div></section>`;
}

export function page(title: string, sheets: string): string {
  // The app's own icons (brand.icons), so a printable document's tab carries the same mark as every other page.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${iconLinks()}<style>${STYLE}</style></head><body><div class="bar"><strong>${esc(title)}</strong><span style="color:#666">Use your browser's Print command to save this as a PDF.</span><button onclick="window.print()" style="margin-left:auto">Print</button></div>${sheets}</body></html>`;
}

export function sendHtml(ctx: Ctx, html: string): undefined {
  const body = Buffer.from(html, 'utf8');
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  ctx.res.end(body);
  return undefined;
}

async function companyOf(ctx: Ctx) {
  return (await one<{ name: string; legal_name: string | null }>('SELECT name, legal_name FROM companies WHERE id = ?', ctx.companyId))!;
}

/**
 * A generated certificate, award or SAFE/note as its certificate-style PDF, or
 * null for a document from before faces existed (it keeps the plain layout).
 */
function certificateInput(doc: Doc, sigs: Sig[]): CertificatePdfInput | null {
  const face = parseFace(doc.face);
  if (!face) return null;
  return {
    face,
    signatures: sigs.map((s) => ({
      role: s.stakeholder_id ? 'HOLDER' : 'COMPANY', name: s.signer_name, signed: s.status === 'SIGNED', typed: s.typed_signature,
      when: s.signed_at ? String(s.signed_at).replace('T', ' ').slice(0, 16) : null, ip: s.ip_address,
    })),
    executed: doc.status === 'EXECUTED',
    footer: `${warnIfChanged(doc, sigs)}${doc.requires_signature && doc.status !== 'EXECUTED' ? 'Signatures pending \u00b7 ' : ''}Document ${doc.id} \u00b7 generated ${new Date().toISOString().slice(0, 10)}`,
    frameColor: config().brand.colors.certificateFrame,
  };
}

/** Sends a PDF, shown in the browser (inline) or saved as a file. */
function sendPdf(ctx: Ctx, pdf: Buffer, name: string, inline: boolean): undefined {
  const filename = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'document'}.pdf`;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    'Content-Length': pdf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(pdf);
  return undefined;
}

/**
 * One document as a printable page, for anyone allowed to see it. A certificate,
 * award or SAFE/note with a front page prints as its PDF, so Print shows exactly
 * what Read shows; anything else is the plain HTML page.
 */
route.get('/api/c/:cid/documents/:id/print', 'read', async (ctx) => {
  const doc = await one<Doc>('SELECT * FROM documents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!doc) throw notFound('Document not found.');
  const role = ctx.membership!.role;
  if (!seesWholeVault(role) && doc.visibility !== 'ALL' && doc.stakeholder_id !== ctx.membership!.stakeholderId) throw forbidden('You do not have access to this document.');
  if (!doc.body) throw badRequest('This document has no text to print; download the file instead.');
  const sigs = await all<Sig>('SELECT * FROM signatures WHERE document_id = ? ORDER BY created_at', doc.id);
  await audit(ctx, 'PRINT', 'documents', doc.id, `Printed "${doc.name}"`);
  const certificate = certificateInput(doc, sigs);
  if (certificate) return sendPdf(ctx, certificatePdf(certificate), doc.name, true);
  return sendHtml(ctx, page(doc.name, sheet(await companyOf(ctx), doc, sigs)));
});

/**
 * A document with text, as its PDF with its signature record: the certificate
 * layout when it has a front page, the plain layout otherwise. The company's own
 * download below and the valuation team's copy of a document sent with a 409A
 * request both come from here, so the two can never differ. The caller has
 * already decided the reader may see the document and that it has a body.
 */
export async function renderDocumentPdf(doc: Doc): Promise<Buffer> {
  const sigs = await all<Sig>('SELECT * FROM signatures WHERE document_id = ? ORDER BY created_at', doc.id);
  const certificate = certificateInput(doc, sigs);
  if (certificate) return certificatePdf(certificate);
  const company = (await one<{ name: string; legal_name: string | null }>('SELECT name, legal_name FROM companies WHERE id = ?', doc.company_id))!;
  return documentPdf({
    company: company.legal_name ?? company.name,
    title: doc.name,
    body: doc.body ?? '',
    signatures: sigs.map((s) => ({
      name: s.signer_name, signed: s.status === 'SIGNED', typed: s.typed_signature,
      when: s.signed_at ? `${String(s.signed_at).replace('T', ' ').slice(0, 16)} UTC` : null, ip: s.ip_address,
    })),
    footer: `${warnIfChanged(doc, sigs)}${doc.status === 'EXECUTED' ? `${executedNote()} \u00b7 ` : doc.requires_signature ? 'Signatures pending \u00b7 ' : ''}Document ${doc.id} \u00b7 generated ${new Date().toISOString().slice(0, 10)}`,
  });
}

/**
 * One document as a PDF file, with its signature record, for anyone allowed to see
 * it: the certificate layout when the document has a front page, the plain layout
 * otherwise. ?inline=1 shows it in the page (the app's reading and signing views)
 * rather than saving it, and is recorded as a view, not a download.
 */
route.get('/api/c/:cid/documents/:id/pdf', 'read', async (ctx) => {
  const doc = await one<Doc>('SELECT * FROM documents WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!doc) throw notFound('Document not found.');
  const role = ctx.membership!.role;
  if (!seesWholeVault(role) && doc.visibility !== 'ALL' && doc.stakeholder_id !== ctx.membership!.stakeholderId) throw forbidden('You do not have access to this document.');
  if (!doc.body) throw badRequest('This document has no text to render; download the file instead.');
  const inline = ctx.query.get('inline') === '1';
  const pdf = await renderDocumentPdf(doc);
  await audit(ctx, inline ? 'VIEW' : 'PRINT', 'documents', doc.id, inline ? `Viewed "${doc.name}"` : `Downloaded "${doc.name}" as PDF`);
  return sendPdf(ctx, pdf, doc.name, inline);
});

/**
 * Every executed certificate. When each has a front page, the book is one PDF of
 * the certificates in their certificate layout; otherwise the plain HTML book.
 */
route.get('/api/c/:cid/certificates/print', 'read', async (ctx) => {
  if (!seesWholeCompany(ctx.membership!.role)) throw forbidden('Only company users can print the certificate book.');
  const docs = await all<Doc>("SELECT * FROM documents WHERE company_id = ? AND category = 'CERTIFICATE' AND body IS NOT NULL AND status = 'EXECUTED' ORDER BY created_at", ctx.companyId);
  if (docs.length === 0) throw notFound('No executed certificates yet.');
  const sigs = await all<Sig & { document_id: string }>(`SELECT * FROM signatures WHERE document_id IN (${docs.map(() => '?').join(',')}) ORDER BY created_at`, ...docs.map((d) => d.id));
  const company = await companyOf(ctx);
  await audit(ctx, 'PRINT', 'documents', null, `Printed the certificate book (${docs.length} certificates)`);
  const certificates = docs.map((d) => certificateInput(d, sigs.filter((s) => s.document_id === d.id)));
  if (certificates.every((c) => c !== null)) {
    return sendPdf(ctx, certificateBookPdf(certificates as CertificatePdfInput[]), `${company.name} certificates`, true);
  }
  return sendHtml(ctx, page(`${company.name} — certificates`, docs.map((d) => sheet(company, d, sigs.filter((s) => s.document_id === d.id))).join('')));
});

/** Cuts a company name for a subject line, which mail apps show only the start of. */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s);

export interface CertificatesReadyEmail {
  companyName: string;
  /** The holder's address and name. */
  to: string;
  holderName: string;
  /** The executed certificates, by document name, e.g. "Stock certificate CS-1 — Morgan Lee". */
  certificates: string[];
  /** The holder's portal, where each certificate can be opened and printed. */
  portalUrl: string;
}

/**
 * Tells a holder their fully signed certificates are in the portal. One email
 * per holder, listing each certificate. Pure, so the wording can be tested
 * without sending anything.
 */
export function composeCertificatesReadyEmail(c: CertificatesReadyEmail): Message {
  const product = config().brand.productName;
  const company = c.companyName;
  const one = c.certificates.length === 1;
  const it = one ? 'it' : 'them';
  const subject = `${clip(company, 40)}: your share certificate${one ? ' is' : 's are'} ready`;
  const content = {
    preview: one
      ? 'It is fully signed. View and print it from your equity portal.'
      : `All ${c.certificates.length} are fully signed. View and print them from your equity portal.`,
    from: company,
    heading: one ? 'Your share certificate is ready' : 'Your share certificates are ready',
    greeting: `Hi ${c.holderName},`,
    intro: [
      one
        ? `Your share certificate from ${company} is fully signed and now in your equity portal.`
        : `Your ${c.certificates.length} share certificates from ${company} are fully signed and now in your equity portal.`,
      `You can view and print ${it} there. There is nothing you need to sign.`,
    ],
    details: [
      { label: 'Company', value: company },
      { label: one ? 'Certificate' : 'Certificates', value: c.certificates.join('\n') },
      { label: 'Status', value: 'Fully signed by everyone' },
    ],
    action: { label: one ? 'View your certificate' : 'View your certificates', url: c.portalUrl },
    actionNote: 'Sign in to your portal and look under Your documents. Each certificate there has a Print button, and your browser can save the printout as a PDF.',
    signoff: `— ${company}`,
    footer: `You are receiving this because ${company} issued you ${one ? 'this certificate' : 'these certificates'} and manages its equity with ${product}. Questions about your shares? Contact ${company} directly.`,
  };
  return { to: c.to, toName: c.holderName, subject, ...renderEmail(content, subject) };
}

/** Emails holders that their executed certificates are available in the portal. */
route.post('/api/c/:cid/certificates/email', 'write', async (ctx) => {
  const wanted: string[] | null = Array.isArray(ctx.body.issuanceIds) ? ctx.body.issuanceIds.map(String) : null;
  const rows = await all<{ id: string; security_id: string; stakeholder_id: string; name: string; holder: string; email: string | null }>(
    `SELECT d.id, d.security_id, d.stakeholder_id, d.name, s.name AS holder, s.email FROM documents d JOIN stakeholders s ON s.id = d.stakeholder_id
     WHERE d.company_id = ? AND d.category = 'CERTIFICATE' AND d.status = 'EXECUTED' ORDER BY s.name`, ctx.companyId);
  const targets = wanted ? rows.filter((r) => wanted.includes(r.security_id)) : rows;
  if (targets.length === 0) throw badRequest('No executed certificates to send.');
  const company = await companyOf(ctx);
  const link = `${config().app.url}/portal`;
  const byHolder = new Map<string, { holder: string; email: string | null; names: string[] }>();
  for (const r of targets) {
    const entry = byHolder.get(r.stakeholder_id) ?? { holder: r.holder, email: r.email, names: [] };
    entry.names.push(r.name);
    byHolder.set(r.stakeholder_id, entry);
  }
  let emailed = 0; let withoutEmail = 0;
  for (const h of byHolder.values()) {
    if (!h.email) { withoutEmail += 1; continue; }
    if (!mailConfigured()) continue;
    // One holder's unusable address, perhaps from an old import, must not stop the
    // rest of the batch; it is counted as not emailed.
    let ok = false;
    try {
      ok = (await sendMail(composeCertificatesReadyEmail({
        companyName: company.name, to: h.email, holderName: h.holder, certificates: h.names, portalUrl: link,
      }))).delivered;
    } catch (err) {
      console.error(`[mail] certificate email to holder ${h.holder} failed:`, err);
    }
    if (ok) emailed += 1;
  }
  await audit(ctx, 'EMAIL', 'documents', null, `Certificates emailed: ${emailed} of ${byHolder.size} holders${withoutEmail ? ` (${withoutEmail} without an email address)` : ''}`);
  return { holders: byHolder.size, certificates: targets.length, emailed, withoutEmail, reason: emailed ? null : !mailConfigured() ? 'Email is not configured on this server; holders can still open their certificates in the portal.' : withoutEmail === byHolder.size ? 'None of the holders has an email address.' : null };
});

export { toCamel, toCamelAll };
