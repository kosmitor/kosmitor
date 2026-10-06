/**
 * One look for every email the app sends, so each reads the same way: a short
 * heading that says what it is about, a few plain sentences, the details that
 * matter in a box, one button for the one thing to do, what happens next (as
 * numbered steps, each a link to its page, when there are several things to do),
 * and a footer that says why the person is getting it.
 *
 * renderEmail() returns both parts of the message: HTML for mail apps, and plain
 * text with the same words in the same order for everything else. The HTML is
 * built from tables with inline styles, the only layout every mail app keeps, and
 * carries no images or remote resources, so nothing is blocked or tracked.
 * Every value is escaped here, so callers pass plain text and never markup.
 */
import { config } from './config.ts';

export interface EmailDetail { label: string; value: string }

/** One step of a numbered list: the label links to the page where it is done, and the note says what it is. */
export interface EmailStep { label: string; url: string; note?: string }

export interface EmailSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: EmailStep[];
  details?: EmailDetail[];
}

export interface EmailContent {
  /** The line mail apps show after the subject before the email is opened. */
  preview: string;
  /** Who it is from, at the top: the company for its own messages, the product otherwise. */
  from?: string;
  heading: string;
  /** "Hi Jordan," — left out for messages to a team. */
  greeting?: string | null;
  /** What this is and what is asked, before anything else. */
  intro: string[];
  /** The facts the reader needs to recognise and check, in a box. */
  details?: EmailDetail[];
  /** The one thing to do. */
  action?: { label: string; url: string };
  /** Under the button: how long the link works, and what using it does. */
  actionNote?: string;
  /** After the button: what happens next, the answers given, the fine print. */
  sections?: EmailSection[];
  /** The name the email is signed with. */
  signoff?: string | null;
  /** Why the person is getting this email, and anything to do if it was not meant for them. */
  footer: string;
}

export interface RenderedEmail { html: string; text: string }

// Neutral greys that read well on white; only the button and the name at the top take the brand colour.
const INK = '#171b22';
const BODY = '#434a58';
const MUTED = '#6b7689';
const LINE = '#e3e7ee';
const PANEL = '#f6f7f9';
const PAGE = '#f3f5f8';
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** Text made safe for HTML, quotes included; null and undefined become empty. */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** A paragraph of plain text as HTML: escaped, with its own line breaks kept. */
const prose = (s: string): string => esc(s).replace(/\r?\n/g, '<br>');

/** Splits free text someone typed (an investor update, a note) into paragraphs at blank lines. */
export function paragraphsOf(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Only web links become buttons; anything else would be a way to run script from an email. */
const safeUrl = (url: string): string => (/^https?:\/\//i.test(url) ? url : '#');

function detailsHtml(details: EmailDetail[]): string {
  const rows = details.map((d, i) => `
            <tr>
              <td style="padding:${i === 0 ? '14px' : '6px'} 16px ${i === details.length - 1 ? '14px' : '6px'};font:400 13px/1.45 ${FONT};color:${MUTED};vertical-align:top;width:38%;">${esc(d.label)}</td>
              <td style="padding:${i === 0 ? '14px' : '6px'} 16px ${i === details.length - 1 ? '14px' : '6px'} 0;font:600 14px/1.45 ${FONT};color:${INK};vertical-align:top;">${prose(d.value)}</td>
            </tr>`).join('');
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};border-radius:10px;margin:20px 0 4px;border-collapse:separate;">${rows}
          </table>`;
}

function sectionHtml(s: EmailSection, primary: string): string {
  return `
          <h2 style="margin:28px 0 8px;font:600 15px/1.4 ${FONT};color:${INK};">${esc(s.title)}</h2>${
    (s.paragraphs ?? []).map((p) => `
          <p style="margin:0 0 12px;font:400 15px/1.6 ${FONT};color:${BODY};">${prose(p)}</p>`).join('')}${
    s.bullets?.length ? `
          <ul style="margin:0 0 12px;padding:0 0 0 20px;font:400 15px/1.6 ${FONT};color:${BODY};">${s.bullets.map((b) => `
            <li style="margin:0 0 6px;">${prose(b)}</li>`).join('')}
          </ul>` : ''}${
    s.steps?.length ? `
          <ol style="margin:0 0 12px;padding:0 0 0 22px;font:400 15px/1.6 ${FONT};color:${BODY};">${s.steps.map((st) => `
            <li style="margin:0 0 10px;"><a href="${esc(safeUrl(st.url))}" target="_blank" style="color:${primary};font-weight:600;text-decoration:none;">${esc(st.label)}</a>${st.note ? `<br>${prose(st.note)}` : ''}</li>`).join('')}
          </ol>` : ''}${s.details?.length ? detailsHtml(s.details) : ''}`;
}

function renderHtml(c: EmailContent, subject: string): string {
  const primary = config().brand.colors.primary['600'];
  const from = c.from ?? config().brand.productName;
  const action = c.action ? { label: c.action.label, url: safeUrl(c.action.url) } : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${esc(c.preview)}${'&#8199;&#847;'.repeat(40)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr>
            <td style="padding:0 4px 14px;font:700 15px/1.3 ${FONT};color:${primary};">${esc(from)}</td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;padding:28px 24px 24px;">
          <h1 style="margin:0 0 18px;font:600 22px/1.3 ${FONT};color:${INK};">${esc(c.heading)}</h1>${
    c.greeting ? `
          <p style="margin:0 0 12px;font:400 15px/1.6 ${FONT};color:${BODY};">${esc(c.greeting)}</p>` : ''}${
    c.intro.map((p) => `
          <p style="margin:0 0 12px;font:400 15px/1.6 ${FONT};color:${BODY};">${prose(p)}</p>`).join('')}${
    c.details?.length ? detailsHtml(c.details) : ''}${
    action ? `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 10px;">
            <tr>
              <td style="border-radius:9px;background:${primary};">
                <a href="${esc(action.url)}" target="_blank" style="display:inline-block;padding:13px 24px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:9px;">${esc(action.label)}</a>
              </td>
            </tr>
          </table>${c.actionNote ? `
          <p style="margin:0 0 6px;font:400 13px/1.5 ${FONT};color:${MUTED};">${prose(c.actionNote)}</p>` : ''}
          <p style="margin:0 0 4px;font:400 12px/1.5 ${FONT};color:${MUTED};">If the button does not work, copy this link into your browser:<br><a href="${esc(action.url)}" target="_blank" style="color:${primary};word-break:break-all;">${esc(action.url)}</a></p>` : ''}${
    (c.sections ?? []).map((s) => sectionHtml(s, primary)).join('')}${
    c.signoff ? `
          <p style="margin:24px 0 0;font:400 15px/1.6 ${FONT};color:${BODY};">${esc(c.signoff)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 8px 0;font:400 12px/1.6 ${FONT};color:${MUTED};">${prose(c.footer)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/** Label-and-value lines with the values lined up, the way a plain-text reader scans them. */
function detailsText(details: EmailDetail[]): string[] {
  const width = Math.min(28, Math.max(...details.map((d) => d.label.length)) + 1);
  return details.map((d) => {
    const [first, ...rest] = d.value.split(/\r?\n/);
    const label = `${d.label}:`.padEnd(width + 1);
    return [`  ${label} ${first}`, ...rest.map((r) => `  ${' '.repeat(width + 1)} ${r}`)].join('\n');
  });
}

function renderText(c: EmailContent): string {
  const out: string[] = [];
  const block = (lines: string[]) => { if (lines.length) out.push(lines.join('\n')); };
  if (c.greeting) block([c.greeting]);
  for (const p of c.intro) block([p]);
  if (c.details?.length) block(detailsText(c.details));
  if (c.action) block([`${c.action.label}:`, c.action.url, ...(c.actionNote ? [c.actionNote] : [])]);
  for (const s of c.sections ?? []) {
    const lines = [s.title.toUpperCase()];
    for (const p of s.paragraphs ?? []) lines.push(p, '');
    for (const b of s.bullets ?? []) lines.push(`- ${b}`);
    (s.steps ?? []).forEach((st, i) => lines.push(`${i + 1}. ${st.label}: ${st.url}`, ...(st.note ? [`   ${st.note}`] : [])));
    if (s.details?.length) lines.push(...detailsText(s.details));
    while (lines.at(-1) === '') lines.pop();
    block(lines);
  }
  if (c.signoff) block([c.signoff]);
  block(['--', c.footer]);
  return `${out.join('\n\n')}\n`;
}

/** Both parts of an email from one description of it. The subject is used as the HTML title. */
export function renderEmail(c: EmailContent, subject: string): RenderedEmail {
  return { html: renderHtml(c, subject), text: renderText(c) };
}
