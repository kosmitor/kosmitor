import { route, newId, nowISO, audit, badRequest, notFound, forbidden, unauthorized,
         setSessionCookie, clearSessionCookie, str, personName, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll, afterCommit, transaction, inTransaction } from '../db.ts';
import { deleteCompany } from '../company-admin.ts';
import {
  createUser, findUserByEmail, upsertGoogleAccount, verifyPassword, createSession, destroySession, publicUser,
  issuePasswordReset, readPasswordReset, consumePasswordReset, markPasswordResetHandedOut, setPassword, generateTemporaryPassword,
  neverSignedIn, FULL_VIEW_ROLES, type AuthUser, type Role, type UserRow,
} from '../auth.ts';
import { verifyGoogleIdToken, GoogleAuthError } from '../google.ts';
import { issueNonce, consumeNonce } from '../nonces.ts';
import { sendMail, mailConfigured, appUrl, SINGLE_ADDRESS, type Message } from '../mail.ts';
import { renderEmail, type EmailContent } from '../email.ts';
import { config, deskName, mailSignature, vestingTemplates } from '../config.ts';

/** The Google client this server accepts, or null when Google sign-in is off. */
const googleClientId = (): string | null => config().auth.google.clientId.trim() || null;

/** The domains Google sign-in is limited to (auth.google.allowedDomains), compared as verifyGoogleIdToken does; empty for any. */
const googleDomains = (): string[] => config().auth.google.allowedDomains.map((d) => d.toLowerCase().replace(/^@/, ''));

/** Whether Google sign-in would let this address in: it is on, and takes any domain or this one. */
function googleAccepts(email: string): boolean {
  if (!googleClientId()) return false;
  const domains = googleDomains();
  return !domains.length || domains.includes(email.toLowerCase().split('@')[1] ?? '');
}

/**
 * Password sign-in can be turned off, leaving Google as the only way in. Every
 * route that sets a password refuses too, or a reset link would be a way round it.
 */
function assertPasswordSignIn(): void {
  if (config().auth.passwordSignIn) return;
  throw forbidden(`Password sign-in is turned off on this server.${googleClientId() ? ' Sign in with Google instead.' : ''}`);
}

route.post('/api/auth/register', 'public', async (ctx) => {
  assertPasswordSignIn();
  // Without self-service sign-up, accounts come from invitations alone.
  if (!config().auth.selfSignup) throw forbidden('New accounts are by invitation only on this server. Ask an administrator of your company to invite you.');
  const email = str(ctx.body.email, 'Email', { max: 200 }).toLowerCase();
  const name = personName(ctx.body.name, 'Name');
  const password = str(ctx.body.password, 'Password');
  if (!SINGLE_ADDRESS.test(email)) throw badRequest('Enter a valid email address.');
  checkNewPassword(password);
  if (await findUserByEmail(email)) throw badRequest('An account with that email already exists.');

  const user = await createUser(email, name, password);
  // Signing up signs the person in, so the account is never mistaken for one an invitation made and nobody has claimed.
  await update('users', user.id, { lastLoginAt: nowISO() });
  const token = await createSession(user.id);
  setSessionCookie(ctx.res, token);
  ctx.user = user;
  await welcomeNewAccount(ctx, user, 'password');
  return { user, token };
});

route.post('/api/auth/login', 'public', async (ctx) => {
  assertPasswordSignIn();
  const email = str(ctx.body.email, 'Email').toLowerCase();
  const password = str(ctx.body.password, 'Password');
  const found = await findUserByEmail(email);
  if (!found || !verifyPassword(password, found.passwordHash)) {
    throw unauthorized('That email and password do not match.');
  }
  await update('users', found.id, { lastLoginAt: nowISO() });
  const token = await createSession(found.id);
  setSessionCookie(ctx.res, token);
  return { user: publicUser(found), token };
});

// --- Passwords -------------------------------------------------------------

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** The session token behind a request, however it was sent. */
function sessionTokenOf(ctx: { req: { headers: Record<string, string | string[] | undefined> } }): string | null {
  const cookie = String(ctx.req.headers.cookie ?? '').match(/(?:^|;\s*)ct_session=([^;]+)/);
  if (cookie) return decodeURIComponent(cookie[1]);
  const auth = String(ctx.req.headers.authorization ?? '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

function checkNewPassword(password: string): void {
  const { passwordMinLength, passwordMaxLength } = config().auth;
  if (password.length < passwordMinLength) throw badRequest(`Use at least ${passwordMinLength} characters for your password.`);
  if (password.length > passwordMaxLength) throw badRequest('That password is too long.');
}

/**
 * Always the configured address (app.url), never the request's Origin or
 * Referer: a link built from a header could point a reset at someone else's site.
 */
function resetLink(token: string): string {
  return `${config().app.url}/reset-password?token=${encodeURIComponent(token)}`;
}

/** How long a link has left, in the words of the email: "7 days", "1 hour", "24 hours", "30 minutes". */
function lifetime(expiresAt: string): string {
  const minutes = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000);
  // A day reads as 24 hours, the way an administrator's reset link has always said it; longer reads in days.
  if (minutes >= 2 * 1440 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** What the password reset email needs to know. */
export interface ResetEmailInput {
  to: { email: string; name: string };
  /** The reset page with its single-use token, built by resetLink(). */
  link: string;
  /** When the link stops working, as an ISO timestamp. */
  expiresAt: string;
  /** The administrator who reset the password, or null when the person asked for the link themselves. */
  byAdmin: string | null;
  /** The company that administrator manages, so the person can tell which one it was. */
  company?: string | null;
}

/**
 * The password reset email, in both parts. The person who asked gets the
 * reassurance that nothing changes unless they use the link; a reset by an
 * administrator says who did it and from which company.
 */
export function composeResetEmail({ to, link, expiresAt, byAdmin, company = null }: ResetEmailInput): Message {
  const product = config().brand.productName;
  const expiresIn = lifetime(expiresAt);
  const subject = byAdmin ? `Set a new password for your ${product} account` : `Reset your ${product} password`;
  const resetBy = byAdmin && company ? `${byAdmin}, an administrator of ${company},` : byAdmin;
  const content: Pick<EmailContent, 'preview' | 'heading' | 'intro' | 'details'> = byAdmin
    ? {
        preview: `${byAdmin} sent you a link to choose a new password, and it expires in ${expiresIn}.`,
        heading: 'Your password was reset',
        intro: [`${resetBy} sent you a link to set a new password for your ${product} account. Choose one using the link below.`],
        details: [
          { label: 'Account', value: to.email },
          { label: 'Reset by', value: byAdmin },
          ...(company ? [{ label: 'Company', value: company }] : []),
        ],
      }
    : {
        preview: `Choose a new password within ${expiresIn}, or ignore this email if you did not ask for it.`,
        heading: 'Reset your password',
        intro: [
          `Someone asked to reset the password for your ${product} account. If that was you, choose a new password using the link below.`,
          'If it was not you, you can ignore this email. Your password stays the same, and nothing changes until the link is used.',
        ],
        details: [{ label: 'Account', value: to.email }],
      };
  const { html, text } = renderEmail({
    ...content,
    greeting: `Hi ${to.name},`,
    action: { label: 'Choose a new password', url: link },
    actionNote: `The link works once and expires in ${expiresIn}. Anyone who has it can set your password, so do not forward this email.`,
    sections: [{
      title: 'What happens next',
      bullets: [
        'The link opens a page where you choose your new password.',
        'Once you save it, you are signed in, and signed out everywhere else.',
        byAdmin
          ? `If the link has expired, ask ${byAdmin} for a new one, or use "Forgot your password?" on the sign-in page.`
          : 'If the link has expired, ask for a new one with "Forgot your password?" on the sign-in page.',
      ],
    }],
    signoff: `— ${mailSignature()}`,
    footer: byAdmin
      ? `You are receiving this because ${byAdmin}${company ? ` of ${company}` : ''} asked for a new password to be set for the ${product} account ${to.email}. Questions about it? Ask ${byAdmin} or another administrator of ${company ?? 'your company'}.`
      : `You are receiving this because someone asked to reset the password for the ${product} account ${to.email}. If you did not ask for this, ignore this email: your password stays the same.`,
  }, subject);
  return { to: to.email, toName: to.name, subject, text, html };
}

async function mailResetLink(to: { email: string; name: string }, link: string, expiresAt: string,
                             byAdmin: string | null, company: string | null = null): Promise<boolean> {
  // A failed send is reported as not delivered rather than thrown, so "forgot
  // password" answers the same way for an address with an account as without.
  try {
    const delivery = await sendMail(composeResetEmail({ to, link, expiresAt, byAdmin, company }));
    return delivery.delivered;
  } catch (err) {
    console.error('Password reset email failed:', (err as Error).message);
    return false;
  }
}

/**
 * "Forgot password". Always answers the same way whether or not the address
 * has an account, so the form cannot be used to enumerate users. Without a
 * mail server the link is returned to the caller outside production, so the
 * flow can be exercised on a laptop.
 */
route.post('/api/auth/forgot', 'public', async (ctx) => {
  assertPasswordSignIn();
  const email = str(ctx.body.email, 'Email', { max: 200 }).toLowerCase();
  if (!SINGLE_ADDRESS.test(email)) throw badRequest('Enter a valid email address.');
  const response: Record<string, unknown> = { ok: true, mailConfigured: mailConfigured() };
  const user = await findUserByEmail(email);
  if (!user) return response;
  const issued = await issuePasswordReset(user.id, { ttlMinutes: config().auth.resetLinkMinutes });
  if (!issued) return response;                                    // throttled — say nothing
  const link = resetLink(issued.token);
  const delivered = await mailResetLink(user, link, issued.expiresAt, null);
  ctx.user = publicUser(user);
  await audit(ctx, 'PASSWORD_RESET_REQUESTED', 'users', user.id, delivered ? 'Reset link emailed' : 'Reset link issued (mail not configured)');
  if (!delivered && !isProduction()) Object.assign(response, { resetUrl: link, expiresAt: issued.expiresAt });
  return response;
});

/**
 * Whether a link is still good, whose it is and what it is for, so the page can
 * say so before asking for a password. An invitation also names the company it
 * is for, while the person still belongs to it, and who sent it.
 */
route.get('/api/auth/reset/:token', 'public', async (ctx) => {
  const link = await readPasswordReset(ctx.params.token);
  if (!link) return { valid: false };
  const answer = { valid: true, email: link.user.email, name: link.user.name, purpose: link.purpose };
  if (link.purpose !== 'INVITE') return answer;
  const company = link.companyId ? await one<{ id: string; name: string }>(
    'SELECT c.id, c.name FROM companies c JOIN memberships m ON m.company_id = c.id AND m.user_id = ? WHERE c.id = ?',
    link.user.id, link.companyId) : undefined;
  const inviter = link.createdBy ? await one<{ name: string }>('SELECT name FROM users WHERE id = ?', link.createdBy) : undefined;
  return { ...answer, companyId: company?.id ?? null, company: company?.name ?? null, invitedBy: inviter?.name ?? null };
});

/** Sets the new password from a link and signs the person in; every other session is signed out. */
route.post('/api/auth/reset', 'public', async (ctx) => {
  assertPasswordSignIn();
  const token = str(ctx.body.token, 'Reset link', { max: 200 });
  const password = str(ctx.body.password, 'Password');
  checkNewPassword(password);
  const link = await readPasswordReset(token);
  const userId = await consumePasswordReset(token);
  if (!userId) throw badRequest('This reset link is not valid any more. Ask for a new one.');
  await setPassword(userId, password, { mustChange: false });
  await update('users', userId, { lastLoginAt: nowISO() });
  const user = toCamel<{ email: string }>(await one('SELECT * FROM users WHERE id = ?', userId))!;
  const found = (await findUserByEmail(user.email))!;
  const session = await createSession(userId);
  setSessionCookie(ctx.res, session);
  ctx.user = publicUser(found);
  if (link?.purpose === 'INVITE') {
    // Written to the log of the company that sent the invitation, beside the invitation itself.
    ctx.companyId = link.companyId;
    await audit(ctx, 'INVITE_ACCEPTED', 'users', userId, `${found.email} chose a password from an invitation`);
  } else {
    await audit(ctx, 'PASSWORD_RESET', 'users', userId, 'Password set from a reset link');
  }
  return { user: publicUser(found), token: session };
});

/** Signed-in password change; keeps this session and signs out the others. */
route.post('/api/auth/change-password', 'user', async (ctx) => {
  assertPasswordSignIn();
  const current = str(ctx.body.currentPassword, 'Current password');
  const next = str(ctx.body.newPassword, 'New password');
  checkNewPassword(next);
  if (next === current) throw badRequest('Choose a password different from the current one.');
  const found = await findUserByEmail(ctx.user!.email);
  if (!found || !verifyPassword(current, found.passwordHash)) throw badRequest('The current password is not right.');
  await setPassword(found.id, next, { mustChange: false, keepToken: sessionTokenOf(ctx) });
  await audit(ctx, 'PASSWORD_CHANGED', 'users', found.id, 'Password changed');
  return { ok: true };
});

// --- Welcome email ---------------------------------------------------------

/** How someone created their own account: by signing up with a password, or by a first sign-in with Google. */
export type SignUpWay = 'password' | 'google';

/** What the welcome email needs to know. */
export interface WelcomeEmailInput {
  to: { email: string; name: string };
  via: SignUpWay;
  /** Whether the first steps offer a 409A from the valuation team; valuationDesk.enabled when not given. */
  valuationDesk?: boolean;
}

/**
 * The welcome email, in both parts, for someone who has just created an account
 * themselves. It says what the product is for, lists the first steps, each a link
 * to the page where it is done, and opens the app. The footer says why it came,
 * that it comes once, and what to do for someone who did not sign up. An account
 * made with a password nobody checked belongs to whoever chose it, so that person
 * is told to take it back rather than to ignore it.
 */
export function composeWelcomeEmail({ to, via, valuationDesk = config().valuationDesk.enabled }: WelcomeEmailInput): Message {
  const product = config().brand.productName;
  const app = appUrl();
  // A Google profile with no name leaves the account named after its address, which reads oddly as a greeting.
  const greeting = to.name && to.name !== to.email.split('@')[0] ? `Hi ${to.name},` : 'Hello,';
  const subject = `Welcome to ${product}`;
  const { html, text } = renderEmail({
    preview: `Your ${product} account is ready. Start by setting up your company.`,
    heading: `Welcome to ${product}`,
    greeting,
    intro: [`Your ${product} account is ready. ${product} keeps a company’s cap table in one place: who owns what, the grants and SAFEs behind it, and the filings that go with them.`],
    action: { label: `Open ${product}`, url: app },
    actionNote: via === 'google' ? `Sign in with Google as ${to.email}.` : `Sign in as ${to.email} with the password you chose.`,
    sections: [{
      title: 'First steps',
      steps: [
        { label: 'Set up your company', url: `${app}/import`, note: 'Create it from scratch, or import a spreadsheet exported from Pulley or Carta.' },
        { label: 'Add your cap table', url: `${app}/cap-table`, note: 'Who holds shares, options and SAFEs, and how many.' },
        { label: 'Invite your team', url: `${app}/team`, note: 'Each person gets a role that decides what they can see and change.' },
        ...(valuationDesk ? [{
          label: 'Request a 409A', url: `${app}/compliance/409a`,
          note: `The ${deskName()} values your common stock, which sets the lowest strike price for your options.`,
        }] : []),
      ],
    }],
    signoff: `— ${mailSignature()}`,
    footer: via === 'google'
      ? `You are receiving this because ${to.email} signed in to ${product} with Google for the first time, which created an account. This is a one-time email. If you do not remember signing in, you can ignore it: nobody can sign in to the account without your Google sign-in or a link sent to this address.`
      : `You are receiving this because an account was created on ${product} with ${to.email}. This is a one-time email. If you did not create it, take the account back with "Forgot your password?" on the sign-in page: the link comes only to this address, and choosing a new password signs everyone else out.`,
  }, subject);
  return { to: to.email, toName: to.name, subject, text, html };
}

/** The audit entries of a welcome email that was tried, whether it went, failed or is on its way; each counts towards the hourly limit. */
const WELCOME_ATTEMPTS = "('WELCOME_EMAIL_PENDING', 'WELCOME_EMAILED', 'WELCOME_EMAIL_FAILED')";

/** The hour mail.welcomeEmailsPerHour counts over, and how long a welcome can be on its way before it is taken to have been cut off. */
const WELCOME_WINDOW_MS = 3_600_000;

/** The welcome emails this server is sending, which it lets finish before it stops. */
const delivering = new Set<Promise<void>>();

/** Resolves once every welcome email on its way has gone or failed. */
export async function welcomesSent(): Promise<void> {
  await Promise.all(delivering);
}

/**
 * Welcomes someone who has just created an account themselves: by signing up,
 * or by a first Google sign-in that created it. Never anyone else: an invited
 * person's account is made by createUser alone and they get their invitation
 * instead, the demo account and the accounts the seed and sample scripts make
 * never come through here, and the demo address is refused besides. Each account
 * is created once, so it is welcomed once.
 *
 * Inside a transaction it waits for the commit, so a sign-up that is rolled back
 * welcomes nobody. It never throws, and the sign-up never waits for the email.
 */
export async function welcomeNewAccount(ctx: Ctx, user: AuthUser, via: SignUpWay): Promise<void> {
  if (inTransaction()) afterCommit(() => welcome(ctx, user, via));
  else await welcome(ctx, user, via);
}

/**
 * Counts the attempt and sends it. mail.welcomeEmailsPerHour caps welcome emails
 * across the server, so the sign-up form cannot be used to send email in bulk.
 * The count and the attempt's audit entry are written in one transaction under a
 * lock every server shares, so sign-ups at the same moment are counted one after
 * another and none can pass the limit before the others are counted. The email
 * goes once that has committed, without the sign-up waiting for it, and the
 * attempt's entry says how it went. Over the limit nothing is sent and the entry
 * says why. Failures go to the server log, never to the person.
 *
 * A server that stops lets its welcomes finish first (welcomesSent), but one that
 * is killed cannot, so an attempt still on its way after the hour is closed here
 * as failed: no delivery takes that long.
 */
async function welcome(ctx: Ctx, user: AuthUser, via: SignUpWay): Promise<void> {
  const { welcomeEmail, welcomeEmailsPerHour: limit } = config().mail;
  // The demo account is shared by everyone the sign-in card hands it to: it is nobody's to welcome.
  if (!welcomeEmail || limit === 0 || isDemoAccount(user.email)) return;
  try {
    const attempt = await transaction(async () => {
      await run("SELECT pg_advisory_xact_lock(hashtext('kosmitor:welcome-emails'))");
      const hourAgo = new Date(Date.now() - WELCOME_WINDOW_MS).toISOString();
      await run(
        `UPDATE audit_log SET action = 'WELCOME_EMAIL_FAILED',
           detail = replace(detail, 'Emailing a welcome to ', 'The welcome email to ') || ' may not have gone out: the server stopped while sending it'
         WHERE action = 'WELCOME_EMAIL_PENDING' AND created_at <= ?`, hourAgo);
      const tried = await one<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action IN ${WELCOME_ATTEMPTS} AND created_at > ?`, hourAgo);
      if (Number(tried?.n ?? 0) >= limit) {
        await audit(ctx, 'WELCOME_EMAIL_SKIPPED', 'users', user.id,
          `No welcome email to ${user.email}: the server has reached its limit of ${limit} welcome email${limit === 1 ? '' : 's'} an hour`);
        return null;
      }
      return audit(ctx, 'WELCOME_EMAIL_PENDING', 'users', user.id, `Emailing a welcome to ${user.email}`);
    });
    if (attempt) {
      const sending = deliverWelcome(attempt, composeWelcomeEmail({ to: { email: user.email, name: user.name }, via }));
      delivering.add(sending);
      void sending.finally(() => delivering.delete(sending));
    }
  } catch (err) {
    console.error(`[mail] The welcome email to ${user.email} was not sent:`, (err as Error).message);
  }
}

/** Sends a counted welcome email and completes its audit entry. Never throws: nothing waits for it. */
async function deliverWelcome(attempt: string, message: Message): Promise<void> {
  let outcome: { action: string; detail: string };
  try {
    const delivery = await sendMail(message);
    outcome = delivery.delivered
      ? { action: 'WELCOME_EMAILED', detail: `Welcome email sent to ${message.to}` }
      : { action: 'WELCOME_EMAIL_FAILED', detail: `The welcome email to ${message.to} was only written to the server log: mail is not configured` };
  } catch (err) {
    console.error(`[mail] The welcome email to ${message.to} failed:`, (err as Error).message);
    outcome = { action: 'WELCOME_EMAIL_FAILED', detail: `The welcome email to ${message.to} did not go out` };
  }
  try {
    await update('audit_log', attempt, outcome);
  } catch (err) {
    console.error(`[mail] Recording the welcome email to ${message.to} failed:`, (err as Error).message);
  }
}

// --- Sign in with Google ---------------------------------------------------

/** What the sign-in page needs to know before it renders. */
route.get('/api/auth/config', 'public', async () => {
  const { passwordSignIn, selfSignup } = config().auth;
  return {
    googleClientId: googleClientId(),
    googleAllowedDomains: googleDomains(),
    passwordSignIn,
    selfSignup,
    mailConfigured: mailConfigured(),
  };
});

/** Issues the single-use nonce the browser hands to Google for this attempt. */
route.post('/api/auth/google/start', 'public', async () => {
  if (!googleClientId()) throw badRequest('Google sign-in is not configured on this server.');
  return { nonce: await issueNonce() };
});

route.post('/api/auth/google', 'public', async (ctx) => {
  const clientId = googleClientId();
  if (!clientId) throw badRequest('Google sign-in is not configured on this server.');
  const credential = str(ctx.body.credential, 'Google credential', { max: 4096 });
  const nonce = str(ctx.body.nonce, 'Sign-in nonce', { max: 128 });
  // Burn the nonce before verifying so a token can only ever be tried once.
  if (!await consumeNonce(nonce)) throw unauthorized('This sign-in attempt has expired. Try again.');

  let profile;
  try {
    profile = await verifyGoogleIdToken(credential, {
      clientId, nonce, allowedDomains: [...config().auth.google.allowedDomains],
    });
  } catch (err) {
    if (err instanceof GoogleAuthError) throw unauthorized(err.message);
    throw err;
  }

  // Without self-service sign-up, Google signs in the accounts that already exist,
  // invited placeholders included, and creates none: the same two matches
  // upsertGoogleAccount tries before it would create one.
  if (!config().auth.selfSignup
      && !await one('SELECT id FROM users WHERE google_sub = ?', profile.sub)
      && !await findUserByEmail(profile.email)) {
    throw forbidden('There is no account for this Google address, and new accounts are by invitation only on this server. Ask an administrator of your company to invite you.');
  }
  const { user, created } = await upsertGoogleAccount(profile);
  await update('users', user.id, { lastLoginAt: nowISO() });
  const token = await createSession(user.id);
  setSessionCookie(ctx.res, token);
  ctx.user = user;
  await audit(ctx, 'LOGIN', 'users', user.id, 'Signed in with Google');
  // Only an account this sign-in created is new; one it found or linked (an invitation claimed) is not.
  if (created) await welcomeNewAccount(ctx, user, 'google');
  return { user, token };
});

route.post('/api/auth/logout', 'public', async (ctx) => {
  const header = (ctx.req.headers.cookie ?? '').match(/ct_session=([^;]+)/);
  if (header) await destroySession(decodeURIComponent(header[1]));
  clearSessionCookie(ctx.res);
  return { ok: true };
});

route.get('/api/auth/me', 'user', async (ctx) => {
  const companies = toCamelAll(await all(
    `SELECT c.*, m.role, m.stakeholder_id FROM memberships m
     JOIN companies c ON c.id = m.company_id
     WHERE m.user_id = ? ORDER BY c.name`, ctx.user!.id));
  return { user: ctx.user, companies };
});

/**
 * A person's own preferences: what they are called, the colour behind their
 * initials, and how pages open for them. Each field is optional, so the page can
 * save one without resending the rest, but one that is sent must be valid: an
 * empty name is refused rather than quietly kept.
 */
route.patch('/api/auth/me', 'user', async (ctx) => {
  const values: Record<string, unknown> = {};
  if (ctx.body.name !== undefined) values.name = personName(ctx.body.name, 'Name');
  if (ctx.body.avatarColor !== undefined) {
    // A colour is drawn as a background behind the initials, so it is a colour
    // and nothing else.
    const colour = str(ctx.body.avatarColor, 'Colour', { max: 7 });
    if (!/^#[0-9a-f]{6}$/i.test(colour)) throw badRequest('Choose one of the colours offered.');
    values.avatarColor = colour.toLowerCase();
  }
  if (ctx.body.explanationsOpen !== undefined) {
    if (typeof ctx.body.explanationsOpen !== 'boolean') throw badRequest('Say whether explanations should start open.');
    values.explanationsOpen = ctx.body.explanationsOpen ? 1 : 0;
  }
  await update('users', ctx.user!.id, values);
  // Many records keep only the name of whoever acted, so a rename is written
  // down: without it nothing would link what someone did before to who they are now.
  if (values.name !== undefined && values.name !== ctx.user!.name) {
    await audit(ctx, 'UPDATE', 'users', ctx.user!.id, `Name changed from ${ctx.user!.name} to ${values.name}`);
  }
  return publicUser(toCamel<UserRow>(await one('SELECT * FROM users WHERE id = ?', ctx.user!.id))!);
});

// --- Companies -------------------------------------------------------------

/** The account the sign-in page's demo card hands out to everyone, when the card is on. */
const isDemoAccount = (email: string): boolean => {
  const { enabled, email: demo } = config().demo;
  return enabled && email.trim().toLowerCase() === demo.trim().toLowerCase();
};

route.post('/api/companies', 'user', async (ctx) => {
  // Everyone shares the demo account's password, so it explores the sample company only.
  if (isDemoAccount(ctx.user!.email)) throw forbidden('The demo account is for exploring the sample company. Create your own account to set up a company.');
  const name = str(ctx.body.name, 'Company name', { max: 160 });
  const id = newId('co');
  const defaults = config().company;
  const portal = defaults.portal;
  await insert('companies', {
    id, name,
    legalName: ctx.body.legalName ?? `${name}${defaults.legalNameSuffix}`,
    entityType: ctx.body.entityType ?? defaults.entityType,
    jurisdiction: ctx.body.jurisdiction ?? defaults.jurisdiction,
    incorporationDate: ctx.body.incorporationDate ?? nowISO().slice(0, 10),
    fiscalYearEnd: ctx.body.fiscalYearEnd ?? defaults.fiscalYearEnd,
    ein: ctx.body.ein ?? null, address: ctx.body.address ?? null,
    website: ctx.body.website ?? null, currency: config().locale.currency,
    brandColor: ctx.body.brandColor ?? defaults.brandColor,
    exerciseRequestsEnabled: defaults.exerciseRequests ? 1 : 0,
    // No stored settings means everything is shown, so they are only written when the defaults hide something.
    portalSettings: Object.values(portal).every(Boolean) ? null : JSON.stringify(portal),
    totalAssetsCents: 0, createdAt: nowISO(),
  });
  await insert('memberships', {
    id: newId('mem'), userId: ctx.user!.id, companyId: id, role: 'ADMIN',
    stakeholderId: null, createdAt: nowISO(),
  });

  // Seed the configured vesting schedules (company.vestingSchedules) so grants can be made immediately.
  for (const s of vestingTemplates()) {
    await insert('vesting_schedules', {
      id: newId('vs'), companyId: id, name: s.name, kind: s.kind,
      durationMonths: s.durationMonths, cliffMonths: s.cliffMonths, frequency: s.frequency,
      immediatePortion: s.immediatePortion, yearWeights: s.yearWeights,
      milestones: s.milestones, customTranches: s.customTranches,
      accelerationSingle: s.accelerationSingleTrigger,
      accelerationDouble: s.accelerationDoubleTrigger,
      accelerationMonths: s.accelerationMonths, createdAt: nowISO(),
    });
  }
  // Every company starts with a common class (company.commonClass); par is stored in micro-dollars.
  const common = defaults.commonClass;
  const par = Math.round(common.parValue * 1e6);
  await insert('share_classes', {
    id: newId('sc'), companyId: id, name: common.name, kind: 'COMMON',
    authorized: Number(ctx.body.authorizedCommon ?? common.authorized),
    parValue: par, seniority: 0, originalIssuePrice: par, liquidationMultiple: 1,
    participation: 'NON_PARTICIPATING', participationCap: null, conversionRatio: 1,
    dividendType: 'NONE', dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0,
    votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0,
    issueDate: ctx.body.incorporationDate ?? nowISO().slice(0, 10), isConvertible: 0, sortOrder: 0,
  });

  ctx.companyId = id;
  await audit(ctx, 'CREATE', 'companies', id, `Company ${name} created`);
  return toCamel(await one('SELECT * FROM companies WHERE id = ?', id));
});

route.get('/api/c/:cid', 'read', async (ctx) => {
  const company = toCamel(await one('SELECT * FROM companies WHERE id = ?', ctx.companyId));
  if (!company) throw notFound('Company not found.');
  return { ...company, role: ctx.membership!.role, stakeholderId: ctx.membership!.stakeholderId };
});

/**
 * Deletes a company and every record in it. Only an administrator of the
 * company, and only after typing its name exactly; nothing else in the
 * database is touched.
 */
route.del('/api/c/:cid', 'admin', async (ctx) => {
  const company = await one<{ id: string; name: string }>('SELECT id, name FROM companies WHERE id = ?', ctx.companyId);
  if (!company) throw notFound('Company not found.');
  if ((ctx.query.get('confirm') ?? '').trim() !== company.name.trim()) throw badRequest('Type the company name exactly to confirm the deletion.');
  await deleteCompany(company.id);
  console.log(`[companies] ${ctx.user!.email} deleted company ${company.id} (${company.name})`);
  return { ok: true };
});

route.patch('/api/c/:cid', 'admin', async (ctx) => {
  const fields = ['name', 'legalName', 'entityType', 'jurisdiction', 'incorporationDate', 'boiStatus', 'accountingAssumptions', 'exerciseRequestsEnabled', 'paymentInstructions',
                  'fiscalYearEnd', 'ein', 'address', 'website', 'brandColor', 'totalAssetsCents', 'portalSettings', 'certificateTerms'];
  const values: Record<string, unknown> = {};
  for (const f of fields) if (ctx.body[f] !== undefined) values[f] = ctx.body[f];
  if (values.boiStatus != null && !['EXEMPT_DOMESTIC', 'REQUIRED', 'EXEMPT_OTHER'].includes(String(values.boiStatus))) {
    throw badRequest('BOI status must be EXEMPT_DOMESTIC, REQUIRED or EXEMPT_OTHER.');
  }
  if (values.exerciseRequestsEnabled !== undefined) values.exerciseRequestsEnabled = values.exerciseRequestsEnabled ? 1 : 0;
  if (values.paymentInstructions != null) values.paymentInstructions = String(values.paymentInstructions).slice(0, 4000) || null;
  if (values.certificateTerms != null) values.certificateTerms = String(values.certificateTerms).slice(0, 8000) || null;
  if (values.portalSettings !== undefined) {
    const p = values.portalSettings as Record<string, unknown> | null;
    if (p === null) values.portalSettings = null;
    else {
      if (typeof p !== 'object') throw badRequest('Portal settings must be an object.');
      const clean: Record<string, boolean> = {};
      for (const k of ['showOwnership', 'showValuation', 'showDocuments', 'showExitModel', 'showUpdates']) if (p[k] !== undefined) clean[k] = !!p[k];
      values.portalSettings = JSON.stringify(clean);
    }
  }
  if (values.accountingAssumptions !== undefined) {
    const a = values.accountingAssumptions as Record<string, unknown> | null;
    if (a === null) values.accountingAssumptions = null;
    else {
      if (typeof a !== 'object') throw badRequest('Accounting assumptions must be an object.');
      const numberIn = (k: string, min: number, max: number) => {
        if (a[k] == null || a[k] === '') return;
        const n = Number(a[k]);
        if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${k} must be between ${min} and ${max}.`);
      };
      numberIn('volatility', 0, 5); numberIn('riskFreeRate', -0.05, 0.5); numberIn('dividendYield', 0, 1);
      numberIn('expectedTermYears', 0.1, 20); numberIn('forfeitureRate', 0, 1);
      if (a.attribution != null && !['GRADED', 'STRAIGHT_LINE'].includes(String(a.attribution))) throw badRequest('Attribution must be GRADED or STRAIGHT_LINE.');
      if (a.forfeiturePolicy != null && !['AS_OCCUR', 'ESTIMATE'].includes(String(a.forfeiturePolicy))) throw badRequest('Forfeiture policy must be AS_OCCUR or ESTIMATE.');
      if (a.standard != null && !['GAAP', 'IFRS'].includes(String(a.standard))) throw badRequest('Standard must be GAAP or IFRS.');
      values.accountingAssumptions = JSON.stringify(a);
    }
  }
  await update('companies', ctx.companyId!, values);
  await audit(ctx, 'UPDATE', 'companies', ctx.companyId, 'Company settings updated');
  return toCamel(await one('SELECT * FROM companies WHERE id = ?', ctx.companyId));
});

// --- Team / access ---------------------------------------------------------

/**
 * The columns a member row carries. `managed_here` is true when this company is
 * the only one the account belongs to, which is when its administrators may
 * change the person's name, sign-in email or password (see accountManagedHere).
 * `never_signed_in` marks someone still to take up their invitation (see
 * neverSignedIn), whom the page offers to send it to again.
 */
const MEMBER_COLUMNS = `m.id, m.role, m.stakeholder_id, m.created_at, u.id AS user_id, u.name, u.email, u.avatar_color, u.avatar_url, u.auth_provider,
  NOT EXISTS (SELECT 1 FROM memberships o WHERE o.user_id = u.id AND o.company_id <> m.company_id) AS managed_here,
  (u.google_sub IS NULL AND u.last_login_at IS NULL) AS never_signed_in`;

route.get('/api/c/:cid/members', 'read', async (ctx) =>
  toCamelAll(await all(
    `SELECT ${MEMBER_COLUMNS}
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.company_id = ? ORDER BY u.name`, ctx.companyId)));

/**
 * Whether this company's administrators may change a member's account: their
 * name, the address they sign in with, or their password. An account is its
 * owner's, and one that also belongs to another company must not be changed
 * from here, or an administrator could invite someone, point their sign-in at
 * an address the administrator controls, reset the password and walk into
 * every other company that person belongs to.
 */
async function accountManagedHere(userId: string, companyId: string): Promise<boolean> {
  return !(await one('SELECT 1 FROM memberships WHERE user_id = ? AND company_id <> ? LIMIT 1', userId, companyId));
}

// --- Invitations -----------------------------------------------------------

/**
 * How an invited person gets in, which decides what their email says.
 * 'password': nobody has signed in to the account yet, and the email's link
 * chooses its password. 'google': the same with password sign-in turned off, so
 * Google is the way in. 'existing': the account already signs in, perhaps to
 * other companies, and is only told about this one.
 */
export type InviteKind = 'password' | 'google' | 'existing';

/** What the invitation email needs to know. */
export interface InviteEmailInput {
  to: { email: string; name: string };
  /** The administrator who sent it. */
  inviter: string;
  company: string;
  role: Role;
  kind: InviteKind;
  /** For 'password', the page with the single-use token (resetLink()); otherwise the app's address. */
  link: string;
  /** When a 'password' link stops working, as an ISO timestamp. */
  expiresAt?: string | null;
  /** Whether Google sign-in is on, so the email can offer it. */
  google: boolean;
}

/** Each role in the words of an invitation: what the person joins as, and what that lets them do. */
const ROLE_WORDS: Record<Role, { as: string; label: string; can: string }> = {
  ADMIN: { as: 'an administrator', label: 'Administrator', can: 'see the whole company, change its records and settings, and decide who has access' },
  LEGAL: { as: 'part of legal / finance', label: 'Legal / finance', can: 'see the whole company and change its cap table records' },
  BOARD: { as: 'a board member', label: 'Board member', can: 'see the whole company’s cap table, without changing it, and vote on board consents' },
  VIEWER: { as: 'a viewer', label: 'Viewer', can: 'see the whole company’s cap table, without changing it' },
  EMPLOYEE: { as: 'an employee', label: 'Employee', can: 'see your own equity, such as your grants, vesting and documents, and nothing of anyone else’s' },
  INVESTOR: { as: 'an investor', label: 'Investor', can: 'see your own holdings and the documents and updates shared with you, and nothing of anyone else’s' },
};

/**
 * The invitation email, in both parts. It names who sent it and the company,
 * says the role in plain words and what it shows, and how to get in: a link to
 * choose a password for an account nobody has signed in to (with Google offered
 * beside it when it is on), Google alone when passwords are off, or the app for
 * someone who already signs in. It never carries a password.
 */
export function composeInviteEmail({ to, inviter, company, role, kind, link, expiresAt = null, google }: InviteEmailInput): Message {
  const product = config().brand.productName;
  // A name typed with a line break in it must not split the subject.
  const line = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const words = ROLE_WORDS[role];
  const expiresIn = kind === 'password' && expiresAt ? lifetime(expiresAt) : null;
  // An account an invitation made is named after its address until its owner says otherwise.
  const greeting = to.name && to.name !== to.email.split('@')[0] ? `Hi ${to.name},` : 'Hello,';
  const roleLine = `As ${words.as}, you can ${words.can}.`;
  const details = [
    { label: 'Company', value: company },
    { label: kind === 'existing' ? 'Added by' : 'Invited by', value: inviter },
    { label: 'Role', value: words.label },
    { label: 'What you see', value: FULL_VIEW_ROLES.includes(role) ? 'The whole company' : 'Your own equity' },
    { label: 'Sign in as', value: to.email },
  ];
  const app = appUrl();

  let subject: string;
  let content: Omit<EmailContent, 'greeting' | 'signoff'>;
  if (kind === 'password') {
    subject = `${line(inviter)} invited you to ${line(company)} on ${product}`;
    content = {
      preview: `Choose a password within ${expiresIn} to join ${company} on ${product}.`,
      heading: `Join ${company} on ${product}`,
      intro: [
        `${inviter} invited you to join ${company} on ${product}, where the company keeps its cap table. Choose a password using the link below to sign in.`,
        roleLine,
      ],
      details,
      action: { label: 'Choose a password', url: link },
      actionNote: `The link works once and expires in ${expiresIn}. It signs you in as ${to.email}, so do not forward this email.`,
      sections: [
        ...(google ? [{ title: 'Or sign in with Google', paragraphs: [`Sign in with Google as ${to.email} at ${app} instead, and you will not need a password.`] }] : []),
        {
          title: 'What happens next',
          bullets: [
            'The link opens a page where you choose your password.',
            `Once you save it, you are signed in and ${company} opens.`,
            `If the link has expired, ask ${inviter} to send the invitation again.`,
          ],
        },
      ],
      footer: `You are receiving this because ${inviter} invited ${to.email} to ${company} on ${product}. If you did not expect it, you can ignore this email: no password is set and nothing happens until the link is used.`,
    };
  } else if (kind === 'google') {
    subject = `${line(inviter)} invited you to ${line(company)} on ${product}`;
    content = {
      preview: google ? `Sign in with Google as ${to.email} to join ${company} on ${product}.` : `Sign in as ${to.email} to join ${company} on ${product}.`,
      heading: `Join ${company} on ${product}`,
      intro: [
        `${inviter} invited you to join ${company} on ${product}, where the company keeps its cap table.`,
        google
          ? `Sign in with Google using ${to.email}, the address the invitation is for. There is no password to choose.`
          : `Sign in as ${to.email}, the address the invitation is for.`,
        roleLine,
      ],
      details,
      action: { label: google ? 'Sign in with Google' : `Open ${product}`, url: link },
      actionNote: google ? `The invitation stays open until you use it. Any other Google account will not find it.` : 'The invitation stays open until you use it.',
      sections: [{
        title: 'What happens next',
        bullets: [
          ...(google ? [`When Google asks which account to use, choose ${to.email}.`] : []),
          `Once you are signed in, ${company} opens.`,
        ],
      }],
      footer: `You are receiving this because ${inviter} invited ${to.email} to ${company} on ${product}. If you did not expect it, you can ignore this email: nothing happens unless you sign in.`,
    };
  } else {
    subject = `${line(inviter)} added you to ${line(company)} on ${product}`;
    content = {
      preview: `${company} is now among your companies on ${product}.`,
      heading: `You now have access to ${company}`,
      intro: [`${inviter} added you to ${company} on ${product}. Sign in as you usually do to see it.`, roleLine],
      details,
      action: { label: `Open ${product}`, url: link },
      sections: [{
        title: 'What happens next',
        bullets: [
          `${company} is listed with any other companies you belong to once you sign in.`,
          'The way you sign in stays the same.',
        ],
      }],
      footer: `You are receiving this because ${inviter} gave ${to.email} access to ${company} on ${product}. If you did not expect it, you can ignore this email, or ask ${inviter} to remove your access.`,
    };
  }
  const { html, text } = renderEmail({ ...content, greeting, signoff: `— ${mailSignature()}` }, subject);
  return { to: to.email, toName: to.name, subject, text, html };
}

/**
 * What an administrator is told about an invitation email: whether it went, and
 * the link to pass on when it did not, for someone this company alone may hand a
 * way into their account. `limited` says it was not tried, the address having had
 * auth.inviteEmailsPerAddressPerDay already.
 */
export interface Invitation { emailed: boolean; link?: string; limited?: boolean }

/** The invitation emails an address can receive in a day are counted over this. */
const INVITE_WINDOW_MS = 86_400_000;

/**
 * Emails a member their invitation, in two halves like the 409A status emails.
 * This one runs inside the request's transaction, under the company's lock: it
 * decides what the person is sent, issues their link, checks
 * auth.inviteEmailsPerAddressPerDay and counts the attempt towards it, by address
 * and apart from any company, and writes it to the audit log. The person's own row
 * is locked before counting, so invitations from several companies at once wait for
 * each other, and none can pass the limit before the others are counted.
 *
 * The email itself goes once the transaction commits, so a slow mail server never
 * holds the company's lock and a failed email never undoes the invitation. The
 * answer is filled in when it has gone or failed, before the response is written.
 *
 * Over the limit, a first invitation still grants access and sends nothing; a
 * resend, which is only for the email, is refused.
 */
async function sendInvitation(ctx: Ctx, invited: UserRow, role: Role, resend: boolean): Promise<Invitation> {
  const invitation: Invitation = { emailed: false };
  const companyId = ctx.companyId!;
  const { passwordSignIn, inviteLinkDays, inviteEmailsPerAddressPerDay: limit } = config().auth;
  // NO KEY UPDATE rather than UPDATE: the membership just added holds a key-share lock
  // on the row, which a second company's invitation holds too, and each waiting on the
  // other's would deadlock. Signing in waits for it as well, so what the row says now
  // holds until the invitation commits.
  const person = toCamel<UserRow>(await one('SELECT * FROM users WHERE id = ? FOR NO KEY UPDATE', invited.id))!;
  if (resend && !neverSignedIn(person)) throw badRequest(`${person.name} has signed in already, so there is no invitation to send again.`);
  const kind: InviteKind = !neverSignedIn(person) ? 'existing' : passwordSignIn ? 'password' : 'google';
  const google = googleAccepts(person.email);
  // With passwords off Google is the only way in, so an address it turns away could never use its access.
  if (kind === 'google' && !google) {
    throw badRequest(`${person.email} could not sign in: password sign-in is turned off on this server, and ${googleClientId()
      ? `Google sign-in only accepts ${googleDomains().map((d) => `@${d}`).join(' or ')} accounts` : 'Google sign-in is not set up'}.`);
  }
  // A link handed to the administrator is a way into the account, so it is only given
  // for one that belongs to this company alone, as a reset link to pass on is.
  const managed = await accountManagedHere(person.id, companyId);

  // Counted by address in invite_emails, which outlives the company that tried them;
  // an attempt still being sent counts as much as one that went or failed.
  await run('DELETE FROM invite_emails WHERE email = ? AND created_at <= ?', person.email, new Date(Date.now() - INVITE_WINDOW_MS).toISOString());
  const sent = await one<{ n: number | string }>('SELECT COUNT(*) AS n FROM invite_emails WHERE email = ?', person.email);
  const limited = Number(sent?.n ?? 0) >= limit;
  const reached = `${person.email} has reached the limit of ${limit} invitation email${limit === 1 ? '' : 's'} a day`;
  if (limited && resend) throw badRequest(`${reached}. Try again tomorrow.`);

  // A new link retires any earlier one, so only the latest invitation works.
  const issued = kind === 'password' && (!limited || managed)
    ? (await issuePasswordReset(person.id, { createdBy: ctx.user!.id, ttlMinutes: inviteLinkDays * 1440, purpose: 'INVITE', companyId }))!
    : null;
  const link = issued ? resetLink(issued.token) : null;
  if (limited) {
    await audit(ctx, 'INVITE_EMAIL_SKIPPED', 'users', person.id, `No invitation email: ${reached}`);
    invitation.limited = true;
    if (issued) {
      await markPasswordResetHandedOut(issued.token);
      invitation.link = link!;
    }
    return invitation;
  }

  const company = (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', companyId))!.name;
  const message = composeInviteEmail({
    to: { email: person.email, name: person.name }, inviter: ctx.user!.name, company, role, kind,
    link: link ?? appUrl(), expiresAt: issued?.expiresAt ?? null, google,
  });
  await insert('invite_emails', { email: person.email, createdAt: nowISO() });
  const attempt = await audit(ctx, 'INVITE_EMAIL_PENDING', 'users', person.id, `Emailing an invitation to ${person.email}`);
  afterCommit(async () => {
    try {
      invitation.emailed = (await sendMail(message)).delivered;
    } catch (err) {
      console.error(`[mail] The invitation email to ${person.email} failed:`, (err as Error).message);
    }
    // The attempt's own row says how it went, so each attempt stays one entry in the log.
    await update('audit_log', attempt, invitation.emailed
      ? { action: 'INVITE_EMAILED', detail: `Invitation emailed to ${person.email}` }
      : { action: 'INVITE_EMAIL_FAILED', detail: `The invitation email to ${person.email} did not go out` });
    // Another company may have added the person while the email was on its way, so
    // this one is asked again; and the link is marked before it is handed over, so it
    // stops working if one does later.
    if (!invitation.emailed && issued && managed && await accountManagedHere(person.id, companyId)) {
      await markPasswordResetHandedOut(issued.token);
      invitation.link = link!;
    }
  });
  return invitation;
}

/**
 * Gives someone access and emails them their invitation (see sendInvitation).
 * The answer is the membership, with `invitation` saying whether the email went.
 */
route.post('/api/c/:cid/members', 'admin', async (ctx) => {
  const email = str(ctx.body.email, 'Email', { max: 200 }).toLowerCase().trim();
  if (!SINGLE_ADDRESS.test(email)) throw badRequest('That email address does not look right.');
  const role = str(ctx.body.role, 'Role') as Role;
  const validRoles: Role[] = ['ADMIN', 'LEGAL', 'BOARD', 'EMPLOYEE', 'INVESTOR', 'VIEWER'];
  if (!validRoles.includes(role)) throw badRequest('Choose a valid role.');

  // Invited users get a placeholder account they claim by setting a password
  // or by signing in with Google using the invited address.
  let user = await findUserByEmail(email);
  if (!user) {
    await createUser(email, personName(ctx.body.name ?? email.split('@')[0], 'Name'), newId('tmp') + newId('tmp'));
    user = (await findUserByEmail(email))!;
  }
  const existing = await one('SELECT id FROM memberships WHERE user_id = ? AND company_id = ?', user.id, ctx.companyId);
  if (existing) throw badRequest('That person already has access.');

  // Unless a holder was chosen, link the one with the same email so the portal shows their equity.
  let stakeholderId: string | null = ctx.body.stakeholderId ?? null;
  if (!stakeholderId) {
    const match = await one<{ id: string }>(
      'SELECT id FROM stakeholders WHERE company_id = ? AND LOWER(email) = ? ORDER BY created_at LIMIT 1', ctx.companyId, email);
    stakeholderId = match?.id ?? null;
  }
  const id = newId('mem');
  await insert('memberships', {
    id, userId: user.id, companyId: ctx.companyId, role, stakeholderId, createdAt: nowISO(),
  });
  await audit(ctx, 'INVITE', 'memberships', id, `${email} invited as ${role}`);
  const invitation = await sendInvitation(ctx, user, role, false);
  return { ...toCamel(await one('SELECT * FROM memberships WHERE id = ?', id))!, invitation };
});

/**
 * Sends a member their invitation again, with a new link that retires the old
 * one. Only for someone who has never signed in: anyone else already has a way in.
 */
route.post('/api/c/:cid/members/:id/invite', 'admin', async (ctx) => {
  const member = await one<{ user_id: string; role: Role }>('SELECT * FROM memberships WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!member) throw notFound('Member not found.');
  const person = toCamel<UserRow>(await one('SELECT * FROM users WHERE id = ?', member.user_id));
  if (!person) throw notFound('Member not found.');
  if (!neverSignedIn(person)) throw badRequest(`${person.name} has signed in already, so there is no invitation to send again.`);
  return { invitation: await sendInvitation(ctx, person, member.role, true) };
});

/**
 * An administrator edits a member: their role and linked holder (this
 * company's membership) and their name and sign-in email (the person's
 * account, which they may also use in other companies).
 */
route.patch('/api/c/:cid/members/:id', 'admin', async (ctx) => {
  const member = await one<{ user_id: string; role: string }>('SELECT * FROM memberships WHERE id = ? AND company_id = ?',
    ctx.params.id, ctx.companyId);
  if (!member) throw notFound('Member not found.');
  const validRoles: Role[] = ['ADMIN', 'LEGAL', 'BOARD', 'EMPLOYEE', 'INVESTOR', 'VIEWER'];
  const changes: string[] = [];

  const values: Record<string, unknown> = {};
  if (ctx.body.role !== undefined) {
    const role = str(ctx.body.role, 'Role') as Role;
    if (!validRoles.includes(role)) throw badRequest('Choose a valid role.');
    if (member.role === 'ADMIN' && role !== 'ADMIN') {
      const admins = await one<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND role = 'ADMIN'", ctx.companyId);
      if (Number(admins?.n ?? 0) <= 1) throw badRequest('A company needs at least one administrator.');
    }
    if (role !== member.role) { values.role = role; changes.push(`role ${member.role} → ${role}`); }
  }
  if (ctx.body.stakeholderId !== undefined) {
    const stakeholderId = ctx.body.stakeholderId ? String(ctx.body.stakeholderId) : null;
    if (stakeholderId) {
      const holder = await one('SELECT id FROM stakeholders WHERE id = ? AND company_id = ?', stakeholderId, ctx.companyId);
      if (!holder) throw badRequest('That stakeholder does not belong to this company.');
    }
    values.stakeholderId = stakeholderId;
    changes.push(stakeholderId ? 'linked to a stakeholder' : 'unlinked from their stakeholder');
  }
  if (Object.keys(values).length) await update('memberships', ctx.params.id, values);

  // Name and email belong to the person's account. Only fields that really
  // change count, since the edit form sends them back with every save.
  const account = await one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', member.user_id);
  const person: Record<string, unknown> = {};
  if (ctx.body.name !== undefined) {
    const name = personName(ctx.body.name, 'Name');
    if (name !== account?.name) person.name = name;
  }
  if (ctx.body.email !== undefined) {
    const email = str(ctx.body.email, 'Email', { max: 200 }).toLowerCase();
    if (!SINGLE_ADDRESS.test(email)) throw badRequest('That email address does not look right.');
    if (email !== account?.email) {
      const taken = await findUserByEmail(email);
      if (taken && taken.id !== member.user_id) throw badRequest('That email address belongs to another account.');
      person.email = email;
    }
  }
  if (Object.keys(person).length) {
    if (member.user_id !== ctx.user!.id && !await accountManagedHere(member.user_id, ctx.companyId!)) {
      throw badRequest('This person also belongs to another company, so only they can change their name or sign-in email.');
    }
    await update('users', member.user_id, person);
    // Links already sent went to the old address, so none of them may set the password for the new one.
    if (person.email) await run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', nowISO(), member.user_id);
    changes.push(person.email ? 'sign-in email changed' : 'name changed');
  }

  await audit(ctx, 'UPDATE', 'memberships', ctx.params.id, changes.length ? `Member updated: ${changes.join(', ')}` : 'Member unchanged');
  return toCamel(await one(
    `SELECT ${MEMBER_COLUMNS}
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ?`, ctx.params.id));
});

/**
 * An administrator resets a member's password: emails them a link, gets a
 * link to pass on, or sets a temporary password they must change at their
 * next sign-in. Either way the person's existing sessions are signed out.
 */
route.post('/api/c/:cid/members/:id/reset-password', 'admin', async (ctx) => {
  // A password nobody can sign in with is no help; Google is the way back in.
  assertPasswordSignIn();
  const member = await one<{ user_id: string }>('SELECT * FROM memberships WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!member) throw notFound('Member not found.');
  if (member.user_id === ctx.user!.id) throw badRequest('Change your own password from your account menu.');
  const target = toCamel<{ id: string; email: string; name: string }>(await one('SELECT * FROM users WHERE id = ?', member.user_id));
  if (!target) throw notFound('Member not found.');
  const mode = str(ctx.body.mode, 'Mode');
  // An emailed link goes to the person, so any company they belong to may send
  // one. A link or a password handed to the administrator is a way into the
  // account, so it is only offered for an account that belongs to this company alone.
  const managed = await accountManagedHere(target.id, ctx.companyId!);
  if ((mode === 'link' || mode === 'temporary') && !managed) {
    throw badRequest('This person also belongs to another company, so their password can only be reset by emailing them a link.');
  }
  // Whoever signs in next may not be the person who stored an assistant key, so it is removed.
  const dropAssistantKey = () => run('DELETE FROM user_ai_settings WHERE user_id = ?', target.id);

  if (mode === 'email' || mode === 'link') {
    if (mode === 'email' && !mailConfigured()) throw badRequest('Email is not configured on this server — share a link or set a temporary password instead.');
    const issued = (await issuePasswordReset(target.id, { createdBy: ctx.user!.id, ttlMinutes: config().auth.adminResetLinkHours * 60 }))!;
    const link = resetLink(issued.token);
    // Another company sending a link leaves the person signed in until they use it,
    // so it cannot be used to keep signing them out.
    if (managed) await run('DELETE FROM sessions WHERE user_id = ?', target.id);
    if (mode === 'link') await dropAssistantKey();
    const companyName = mode === 'email'
      ? (await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', ctx.companyId))?.name ?? null
      : null;
    const emailed = mode === 'email' ? await mailResetLink(target, link, issued.expiresAt, ctx.user!.name, companyName) : false;
    // A link that could not be emailed is shown instead only when it could have been asked for directly.
    // Throwing undoes the link, since the request runs in a transaction.
    if (mode === 'email' && !emailed && !managed) throw badRequest('The email could not be sent, so no link was issued. Try again later.');
    await audit(ctx, 'PASSWORD_RESET', 'users', target.id,
      `${ctx.user!.name} issued a password reset link for ${target.email}${emailed ? ' (emailed)' : ''}`);
    return { mode, emailed, expiresAt: issued.expiresAt, ...(emailed ? {} : { resetUrl: link }) };
  }
  if (mode === 'temporary') {
    const password = ctx.body.password ? str(ctx.body.password, 'Temporary password') : generateTemporaryPassword();
    checkNewPassword(password);
    await setPassword(target.id, password, { mustChange: true });
    await run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', target.id);
    await dropAssistantKey();
    await audit(ctx, 'PASSWORD_RESET', 'users', target.id, `${ctx.user!.name} set a temporary password for ${target.email}`);
    return { mode, temporaryPassword: password };
  }
  throw badRequest('Mode must be email, link or temporary.');
});

route.del('/api/c/:cid/members/:id', 'admin', async (ctx) => {
  const member = await one<{ user_id: string; role: string }>(
    'SELECT * FROM memberships WHERE id = ? AND company_id = ?', ctx.params.id, ctx.companyId);
  if (!member) throw notFound('Member not found.');
  if (member.role === 'ADMIN') {
    const admins = await one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND role = 'ADMIN'", ctx.companyId);
    if ((admins?.n ?? 0) <= 1) throw forbidden('A company needs at least one administrator.');
  }
  await run('DELETE FROM memberships WHERE id = ?', ctx.params.id);
  // An invitation to a company the person no longer belongs to is not one to accept.
  await run("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND company_id = ? AND purpose = 'INVITE' AND used_at IS NULL",
    nowISO(), member.user_id, ctx.companyId);
  await audit(ctx, 'REVOKE', 'memberships', ctx.params.id, 'Access revoked');
  return { ok: true };
});
