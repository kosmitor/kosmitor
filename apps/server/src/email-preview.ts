/**
 * Renders every email the app sends with made-up people and companies, into one
 * page that shows each message the way a mail app would, next to its plain-text
 * part. Nothing is sent and no database is touched.
 *
 *   npm run emails:preview            writes <tmp>/kosmitor-email-preview/index.html
 *   npm run emails:preview -- <dir>   writes <dir>/index.html
 *
 * Each email is also written on its own (01-welcome.html and so on).
 *
 * The brand, colours and wording come from the param files, so this is also the
 * way to check a rebrand before any email goes out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config, deskName } from './config.ts';
import { esc } from './email.ts';
import type { Message } from './mail.ts';
import type { Situation } from './routes/valuation-requests.ts';

const { composeResetEmail, composeInviteEmail, composeWelcomeEmail } = await import('./routes/auth.ts');
const { composeRecapEmail, composeDeskEmail, composeClosedEmail, composeStatusEmail, DOCUMENT_ITEMS } = await import('./routes/valuation-requests.ts');
const { composeHolderSigningEmail } = await import('./routes/workflows.ts');
const { composeInvestorSigningEmail } = await import('./routes/fundraising.ts');
const { composeInvestorUpdateEmail } = await import('./routes/communications.ts');
const { composeOfferEmail } = await import('./routes/offers.ts');
const { composeCertificatesReadyEmail } = await import('./routes/certificates.ts');

const app = config().app.url;
const inAnHour = new Date(Date.now() + 60 * 60_000).toISOString();
const inADay = new Date(Date.now() + 24 * 3_600_000).toISOString();
const inviteExpires = new Date(Date.now() + config().auth.inviteLinkDays * 86_400_000).toISOString();
// A complete answer to the information request, every list filled in, so the preview shows each table.
const year = new Date().getUTCFullYear();
const intake = {
  version: 2, valuationDateKind: 'LATEST', valuationDate: null,
  companySize: '11-50', stage: 'SERIES_A', plans: 'OPTIONS', plansTiming: 'ONE_TO_THREE', optionsToGrant: 250_000,
  last409a: 'DATE', last409aDate: '2025-03-01',
  noFullYearYet: false, convertiblesOutstanding: true, projections: 'GUIDANCE', capTableConfirmed: true,
  guidance: [
    { year, revenue: 120_000_000, ebitda: -30_000_000 },
    { year: year + 1, revenue: 310_000_000, ebitda: 15_000_000 },
    { year: year + 2, revenue: 640_000_000, ebitda: 96_000_000 },
  ],
  management: [{ name: 'Jordan Vale', title: 'Chief executive officer' }, { name: 'Hana Ito', title: 'Chief technology officer' }],
  sweatEquity: true,
  sweatEquityPeople: [{ name: 'Jordan Vale', title: 'Chief executive officer', from: '2024-01-10', to: '2025-06-30', timePercent: 100, marketSalary: 22_000_000, salaryReceived: 6_000_000 }],
  secondary: true,
  secondaryTransactions: [{
    securityType: 'COMMON', date: '2025-11-14', shares: 40_000, pricePerShare: 1_200_000,
    priceRationale: 'Agreed between the two parties, at a discount to the Series A price.',
    rationale: 'A co-founder sold part of their stake to pay for a house.', buyer: 'A new investor', seller: 'A co-founder', expectRepeat: false,
  }],
  belowMarketExpenses: true,
  expenses: [{ nature: 'Office rent: the team worked from the CEO’s home until the Series A', recorded: 0, market: 3_600_000 }],
  software: 'Spreadsheets and QuickBooks',
  // The company's record, which the server adds to the answers when the request is made.
  incorporationDate: '2024-01-10', fiscalYearEnd: '12-31',
};
const itemLabel = (item: string): string => DOCUMENT_ITEMS.find((d) => d.item === item)!.label;
const documents = [
  { itemLabel: itemLabel('HISTORICAL_FINANCIALS'), name: 'Marlowe Systems 2024 financial statements.pdf' },
  { itemLabel: itemLabel('HISTORICAL_FINANCIALS'), name: 'Marlowe Systems 2025 financial statements.pdf' },
  { itemLabel: itemLabel('YTD_FINANCIALS'), name: `Marlowe Systems ${year} year-to-date accounts.pdf` },
  { itemLabel: itemLabel('PITCH_DECK'), name: 'Marlowe Systems Series A deck.pdf' },
  { itemLabel: itemLabel('PRIOR_VALUATIONS'), name: 'Marlowe Systems 409A report, March 2025.pdf' },
  { itemLabel: itemLabel('CHARTER'), name: 'Certificate of incorporation, as amended.pdf' },
  { itemLabel: itemLabel('CONVERTIBLE_AGREEMENTS'), name: 'Post-money SAFE agreements.pdf' },
];
const contact = { name: 'Jordan Vale', email: 'finance@marlowe.example.com', phone: '+1 (415) 555-0142' };
const situation = {
  refresh: {
    due: true,
    current: { id: 'val_1', effectiveDate: '2025-03-01', fairMarketValue: 200000, provider: 'Ledgerline Valuations', expiresOn: '2026-03-01' },
    triggers: [{ text: 'Series A Preferred was sold on Jun 1, 2025, after the valuation date.' }, { text: 'The valuation reaches twelve months on Mar 1, 2026.' }],
  },
  structure: {
    asOf: '2026-01-02', fullyDiluted: 6_000_000,
    classes: [
      { name: 'Common Stock', kind: 'COMMON', authorized: 10_000_000, outstanding: 4_000_000, originalIssuePrice: 0, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null, conversionRatio: 1, seniority: 0, dividendType: 'NONE', dividendRate: 0, issueDate: '2024-01-10' },
      { name: 'Series A Preferred', kind: 'PREFERRED', authorized: 3_000_000, outstanding: 1_000_000, originalIssuePrice: 1_500_000, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null, conversionRatio: 1, seniority: 1, dividendType: 'NONE', dividendRate: 0, issueDate: '2025-06-01' },
    ],
    optionsOutstanding: 250_000, rsusOutstanding: 0, warrantsOutstanding: 0, poolAvailable: 750_000, convertibles: { count: 2, principal: 50_000_000 },
  },
  splitSinceValuation: false,
} as unknown as Situation;
/** The person who asked for the 409A, and the company, in every email about its status. */
const asker = { companyName: 'Marlowe Systems, Inc.', to: 'jordan@example.com', toName: 'Jordan Vale' };

const samples: { title: string; who: string; message: Message }[] = [
  { title: 'Welcome', who: 'Someone who signed up with a password', message: composeWelcomeEmail({ to: { email: 'nadia.okoro@example.com', name: 'Nadia Okoro' }, via: 'password', valuationDesk: false }) },
  { title: 'Welcome, with a 409A', who: `Someone who signed in with Google for the first time, with the ${deskName()} on`, message: composeWelcomeEmail({ to: { email: 'ilse.brandt@example.com', name: 'Ilse Brandt' }, via: 'google', valuationDesk: true }) },
  { title: 'Forgot password', who: 'Anyone who asks for a reset', message: composeResetEmail({ to: { email: 'hana.ito@example.com', name: 'Hana Ito' }, link: `${app}/reset-password?token=sample-token`, expiresAt: inAnHour, byAdmin: null }) },
  { title: 'Password reset by an administrator', who: 'A member whose administrator sent a reset', message: composeResetEmail({ to: { email: 'lena.fischer@example.com', name: 'Lena Fischer' }, link: `${app}/reset-password?token=sample-token`, expiresAt: inADay, byAdmin: 'Avery Stone', company: 'Marlowe Systems' }) },
  { title: 'Invitation, new account', who: 'Someone invited who has never signed in', message: composeInviteEmail({ to: { email: 'priya.raman@example.com', name: 'Priya Raman' }, inviter: 'Avery Stone', company: 'Marlowe Systems', role: 'EMPLOYEE', kind: 'password', link: `${app}/reset-password?token=sample-token`, expiresAt: inviteExpires, google: true }) },
  { title: 'Invitation, existing account', who: 'Someone invited who already signs in', message: composeInviteEmail({ to: { email: 'lena.fischer@example.com', name: 'Lena Fischer' }, inviter: 'Avery Stone', company: 'Marlowe Systems', role: 'BOARD', kind: 'existing', link: app, google: false }) },
  { title: 'Invitation, Google sign-in only', who: 'Someone invited to a server with password sign-in off', message: composeInviteEmail({ to: { email: 'bao.nguyen@example.com', name: 'bao.nguyen' }, inviter: 'Avery Stone', company: 'Marlowe Systems', role: 'VIEWER', kind: 'google', link: app, google: true }) },
  { title: 'Share certificate to sign', who: 'A stockholder', message: composeHolderSigningEmail({ to: 'priya@example.com', toName: 'Priya Raman', companyName: 'Tidewater Labs', shares: 10_000, className: 'Common Stock', reminder: false, what: 'certificate', link: `${app}/portal`, reference: 'CS-3', date: '2026-03-03' }) },
  { title: 'Equity award to sign (reminder)', who: 'An employee with a grant', message: composeHolderSigningEmail({ to: 'priya@example.com', toName: 'Priya Raman', companyName: 'Tidewater Labs', shares: 48_000, className: 'Incentive Stock Options', reminder: true, what: 'agreement', link: `${app}/portal`, reference: 'OPT-7', date: '2026-09-01' }) },
  { title: 'SAFE to sign', who: 'An investor', message: composeInvestorSigningEmail({ to: 'deals@halcyon.example.com', toName: 'Halcyon Ventures', companyName: 'Tidewater Labs', principal: 25_000_000, instrument: 'Post-money SAFE', reminder: false, link: `${app}/portal`, reference: 'SAFE-1', date: '2026-03-03' }) },
  { title: 'Certificates ready', who: 'A stockholder', message: composeCertificatesReadyEmail({ companyName: 'Marlowe Systems', to: 'priya@example.com', holderName: 'Priya Raman', certificates: ['Stock certificate CS-1 — Priya Raman', 'Stock certificate CS-4 — Priya Raman'], portalUrl: `${app}/portal` }) },
  { title: 'Offer letter', who: 'A candidate', message: composeOfferEmail({ companyName: 'Marlowe Systems', to: 'priya@example.com', candidateName: 'Priya Raman', position: 'VP Engineering', link: `${app}/offer/sample-token`, expiresOn: '2026-12-31', startDate: '2026-11-02', signerName: 'Avery Stone', signerTitle: 'CEO' }) },
  { title: 'Investor update', who: 'Investors and stakeholders', message: composeInvestorUpdateEmail({ companyName: 'Marlowe Systems', to: 'deals@halcyon.example.com', toName: 'Halcyon Ventures', title: 'Q3 2026 update', period: 'Q3 2026', body: 'Revenue grew 41% quarter over quarter.\n\nWe closed two enterprise pilots and hired a VP Sales.', metrics: [{ label: 'ARR', value: '$4.4M' }, { label: 'Runway', value: '22 months' }], portalUrl: `${app}/portal` }) },
  { title: '409A request received', who: 'The person who asked for a 409A', message: composeRecapEmail({ companyName: 'Marlowe Systems, Inc.', to: 'jordan@example.com', toName: 'Jordan Vale', contact, intake, documents, notes: 'We expect to grant to three new hires.\n\nThe board meets in May.', statusUrl: `${app}/compliance/409a`, replyTo: 'desk@example.com' } as Parameters<typeof composeRecapEmail>[0]) },
  { title: 'New 409A request', who: `The ${deskName()}`, message: composeDeskEmail({ companyName: 'Marlowe Systems, Inc.', to: 'desk@example.com', requestedAt: '2026-01-02T10:00:00.000Z', requestedBy: 'Jordan Vale', contact, intake, documents, notes: 'We expect to grant to three new hires.', link: `${app}/409a-desk#sample-token`, situation } as Parameters<typeof composeDeskEmail>[0]) },
  { title: '409A request closed', who: `The ${deskName()}`, message: composeClosedEmail({ companyName: 'Marlowe Systems, Inc.', to: 'desk@example.com', requestedAt: '2026-01-02T10:00:00.000Z', how: 'CANCELLED' }) },
  { title: '409A started', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'STARTED' }, message: null, replyTo: 'desk@example.com' }) },
  { title: '409A report delivered', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'DELIVERED', appraiser: 'Ledgerline Valuations', reportDate: '2026-01-31', fairMarketValue: 420_000, reportOnPage: true }, message: 'Call us if any of the assumptions need a second look.', replyTo: 'desk@example.com' }) },
  { title: '409A report delivered by email', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'DELIVERED', appraiser: 'Ledgerline Valuations', reportDate: '2026-01-31' }, message: 'The signed report is in your inbox.\n\nCall us if any of the assumptions need a second look.', replyTo: 'desk@example.com' }) },
  { title: '409A back in progress', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'REOPENED' }, message: 'We are correcting the valuation date. A new report follows this week.', replyTo: 'desk@example.com' }) },
  { title: '409A request closed by the team', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'CLOSED' }, message: 'This was a duplicate of the request you made on Jan 2.', replyTo: 'desk@example.com' }) },
  { title: '409A request completed by a colleague', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'COMPLETED', by: 'Hana Ito', valuationDate: '2026-01-31' }, message: null, replyTo: null }) },
  { title: '409A request cancelled by a colleague', who: 'The person who asked for a 409A', message: composeStatusEmail({ ...asker, change: { kind: 'CANCELLED', by: 'Hana Ito' }, message: null, replyTo: null }) },
];

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config().brand.productName)} emails</title>
<style>
  body { margin: 0; font: 14px/1.5 -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #171b22; background: #e9edf2; }
  header { padding: 24px 28px 8px; } h1 { margin: 0; font-size: 20px; } header p { margin: 4px 0 0; color: #6b7689; }
  nav { padding: 8px 28px 16px; display: flex; flex-wrap: wrap; gap: 6px; } nav a { background: #fff; border: 1px solid #d9dde5; border-radius: 999px; padding: 3px 10px; color: #434a58; text-decoration: none; font-size: 12.5px; }
  section { margin: 0 28px 28px; background: #fff; border: 1px solid #d9dde5; border-radius: 12px; overflow: hidden; }
  .head { padding: 14px 18px; border-bottom: 1px solid #e3e7ee; } .head h2 { margin: 0; font-size: 15px; } .meta { color: #6b7689; font-size: 12.5px; margin-top: 2px; }
  .subject { margin-top: 6px; font-size: 13px; } .subject b { font-weight: 600; }
  .body { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  iframe { width: 100%; height: 760px; border: 0; border-right: 1px solid #e3e7ee; background: #f3f5f8; }
  pre { margin: 0; padding: 16px 18px; white-space: pre-wrap; font: 12px/1.55 ui-monospace, Menlo, Consolas, monospace; color: #2b313c; max-height: 760px; overflow: auto; }
  @media (max-width: 900px) { .body { grid-template-columns: 1fr; } iframe { border-right: 0; border-bottom: 1px solid #e3e7ee; } }
</style></head>
<body>
<header><h1>${esc(config().brand.productName)} emails</h1><p>Every email the app sends, with made-up people. Left: what a mail app shows. Right: the plain-text part.</p></header>
<nav>${samples.map((s, i) => `<a href="#e${i}">${esc(s.title)}</a>`).join('')}</nav>
${samples.map((s, i) => `<section id="e${i}">
  <div class="head"><h2>${esc(s.title)}</h2><div class="meta">To: ${esc(s.who)} · ${esc(s.message.toName ? `${s.message.toName} <${s.message.to}>` : s.message.to)}${s.message.replyTo ? ` · Reply-To: ${esc(s.message.replyTo)}` : ''}</div>
  <div class="subject">Subject: <b>${esc(s.message.subject)}</b></div></div>
  <div class="body"><iframe title="${esc(s.title)}" sandbox srcdoc="${esc(s.message.html ?? '')}"></iframe><pre>${esc(s.message.text)}</pre></div>
</section>`).join('\n')}
</body></html>
`;

const dir = resolve(process.argv[2] ?? join(tmpdir(), 'kosmitor-email-preview'));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'index.html'), page);
// Each email on its own too, to open in a browser at its real width.
samples.forEach((s, i) => writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')}-${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.html`), s.message.html ?? ''));
console.log(`Wrote ${samples.length} emails to ${join(dir, 'index.html')}`);
process.exit(0);
