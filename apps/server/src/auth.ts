import { randomBytes, scryptSync, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { one, all, run, insert, update, toCamel } from './db.ts';
import type { GoogleProfile } from './google.ts';
import { cleanPersonName } from './names.ts';
import { config } from './config.ts';

export type Role = 'ADMIN' | 'LEGAL' | 'BOARD' | 'EMPLOYEE' | 'INVESTOR' | 'VIEWER';

/** Roles that may write cap table data. */
export const EDITOR_ROLES: Role[] = ['ADMIN', 'LEGAL'];
/** Roles that may see the whole cap table rather than only their own position. */
export const FULL_VIEW_ROLES: Role[] = ['ADMIN', 'LEGAL', 'BOARD', 'VIEWER'];
/** Roles that read every document in the vault; everyone else sees what is shared with everyone, or their own. */
export const VAULT_ROLES: Role[] = ['ADMIN', 'LEGAL', 'BOARD'];
/** Every role a membership can hold. */
export const ROLES: Role[] = ['ADMIN', 'LEGAL', 'BOARD', 'EMPLOYEE', 'INVESTOR', 'VIEWER'];

const oneOf = (roles: Role[]) => (role: string): boolean => (roles as string[]).includes(role);
export const isEditor = oneOf(EDITOR_ROLES);
export const seesWholeCompany = oneOf(FULL_VIEW_ROLES);
export const seesWholeVault = oneOf(VAULT_ROLES);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarColor: string | null;
  avatarUrl: string | null;
  authProvider: 'PASSWORD' | 'GOOGLE';
  /** Set after an administrator gave this person a temporary password. */
  mustChangePassword: boolean;
  /** Whether page explanations start open for this person. */
  explanationsOpen: boolean;
  /**
   * True when a Google account is linked. An account created by an invitation
   * and then claimed through Google keeps a password nobody chose, so the app
   * cannot assume a PASSWORD account has a password its owner knows.
   */
  googleLinked: boolean;
}

export interface Membership {
  id: string;
  userId: string;
  companyId: string;
  role: Role;
  stakeholderId: string | null;
  /** A demo company: anyone may look, nobody may change its records. */
  isSample: boolean;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
}

/** A colour for a new account's avatar, one of brand.colors.avatarChoices. */
function pickAvatarColor(): string {
  const choices = config().brand.colors.avatarChoices;
  return choices[Math.floor(Math.random() * choices.length)].value;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + config().auth.sessionDays * 86_400_000);
  await insert('sessions', {
    token, userId, createdAt: now.toISOString(), expiresAt: expires.toISOString(),
  });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await run('DELETE FROM sessions WHERE token = ?', token);
}

export async function userForToken(token: string | null): Promise<AuthUser | null> {
  if (!token) return null;
  const row = await one<Record<string, unknown>>(
    `SELECT u.id, u.email, u.name, u.avatar_color, u.avatar_url, u.auth_provider, u.must_change_password, u.explanations_open, u.google_sub FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
    token, new Date().toISOString(),
  );
  if (!row) return null;
  return publicUser(toCamel<UserRow>(row)!);
}

export async function membershipFor(userId: string, companyId: string): Promise<Membership | null> {
  const row = await one<Record<string, unknown>>(
    `SELECT m.*, c.is_sample FROM memberships m JOIN companies c ON c.id = m.company_id
     WHERE m.user_id = ? AND m.company_id = ?`, userId, companyId,
  );
  if (!row) return null;
  const membership = toCamel<Membership>(row)!;
  return { ...membership, isSample: Number(row.is_sample) === 1 };
}

export async function createUser(email: string, name: string, password: string): Promise<AuthUser> {
  const id = `usr_${randomUUID().slice(0, 12)}`;
  const avatarColor = pickAvatarColor();
  await insert('users', {
    id, email: email.toLowerCase().trim(), name, passwordHash: hashPassword(password),
    avatarColor, avatarUrl: null, googleSub: null, authProvider: 'PASSWORD',
    createdAt: new Date().toISOString(),
  });
  return { id, email: email.toLowerCase().trim(), name, avatarColor, avatarUrl: null, authProvider: 'PASSWORD', mustChangePassword: false, explanationsOpen: false, googleLinked: false };
}

export interface UserRow {
  id: string; email: string; name: string; passwordHash: string;
  avatarColor: string | null; avatarUrl: string | null; googleSub: string | null;
  authProvider: 'PASSWORD' | 'GOOGLE' | null; mustChangePassword: number | null;
  explanationsOpen?: number | null;
  lastLoginAt?: string | null;
}

/**
 * An account nobody has signed in to yet: one an invitation made, which its
 * owner claims by choosing a password from the invitation's link or by signing
 * in with Google. Every way in records a sign-in, and Google also links the
 * account, so either one means it has an owner who can already get in.
 */
export const neverSignedIn = (u: Pick<UserRow, 'googleSub' | 'lastLoginAt'>): boolean => !u.googleSub && !u.lastLoginAt;

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  return toCamel<UserRow>(await one('SELECT * FROM users WHERE email = ?', email.toLowerCase().trim()));
}

/**
 * The signed-in person as every endpoint returns them. Built in one place, so a
 * login, a refresh and a profile save never disagree about what a user has.
 */
export const publicUser = (u: UserRow): AuthUser => ({
  id: u.id, email: u.email, name: u.name, avatarColor: u.avatarColor,
  avatarUrl: u.avatarUrl, authProvider: u.authProvider ?? 'PASSWORD', mustChangePassword: Number(u.mustChangePassword) === 1,
  explanationsOpen: Number(u.explanationsOpen ?? 0) === 1,
  googleLinked: !!u.googleSub,
});

/**
 * Finds or creates the account behind a verified Google identity.
 *
 *  1. A user already linked to this Google subject signs straight in.
 *  2. Otherwise an existing account with the same (Google-verified) email is
 *     linked — this is how someone invited by an administrator claims their
 *     access without ever setting a password.
 *  3. Otherwise a new account is created with an unguessable, unusable
 *     password, so Google is its only way in.
 *
 * `created` says the third happened: only an account made this way is new to
 * the product, and welcomed.
 */
export async function upsertGoogleAccount(profile: GoogleProfile): Promise<{ user: AuthUser; created: boolean }> {
  const now = new Date().toISOString();
  const bySub = toCamel<UserRow>(await one('SELECT * FROM users WHERE google_sub = ?', profile.sub));
  if (bySub) {
    await update('users', bySub.id, { avatarUrl: profile.picture ?? bySub.avatarUrl, lastLoginAt: now });
    return { user: publicUser({ ...bySub, avatarUrl: profile.picture ?? bySub.avatarUrl }), created: false };
  }

  const byEmail = await findUserByEmail(profile.email);
  if (byEmail) {
    // A placeholder account created by an invitation has no real name yet.
    const name = byEmail.name === byEmail.email.split('@')[0] ? cleanPersonName(profile.name, byEmail.name) : byEmail.name;
    const avatarUrl = profile.picture ?? byEmail.avatarUrl;
    await update('users', byEmail.id, { googleSub: profile.sub, avatarUrl, name, lastLoginAt: now });
    // Claimed this way, the account needs no invitation link any more, and nobody else may use one.
    await run("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND purpose = 'INVITE' AND used_at IS NULL", now, byEmail.id);
    return { user: publicUser({ ...byEmail, name, googleSub: profile.sub, avatarUrl }), created: false };
  }

  const id = `usr_${randomUUID().slice(0, 12)}`;
  const avatarColor = pickAvatarColor();
  const name = cleanPersonName(profile.name, profile.email.split('@')[0]);
  await insert('users', {
    id, email: profile.email, name,
    passwordHash: hashPassword(randomBytes(32).toString('hex')),
    avatarColor, avatarUrl: profile.picture, googleSub: profile.sub, authProvider: 'GOOGLE',
    createdAt: now, lastLoginAt: now,
  });
  return {
    user: { id, email: profile.email, name, avatarColor, avatarUrl: profile.picture, authProvider: 'GOOGLE', mustChangePassword: false, explanationsOpen: false, googleLinked: true },
    created: true,
  };
}

/** The account behind a verified Google identity, found, linked or created (see upsertGoogleAccount). */
export async function upsertGoogleUser(profile: GoogleProfile): Promise<AuthUser> {
  return (await upsertGoogleAccount(profile)).user;
}

export function can(role: Role, action: 'read' | 'write' | 'admin'): boolean {
  if (action === 'admin') return role === 'ADMIN';
  if (action === 'write') return EDITOR_ROLES.includes(role);
  return true;
}

// --- Password resets -------------------------------------------------------

/** The shortest password accepted, auth.passwordMinLength. */
export const minPasswordLength = (): number => config().auth.passwordMinLength;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * What a link is for: a reset, or an invitation to choose a first password. They
 * work the same way; the page and the audit log word them differently.
 */
export type ResetPurpose = 'RESET' | 'INVITE';

/**
 * Issues a single-use reset link token. Only its hash is stored, earlier
 * unused links for the same person stop working, and self-service requests
 * are capped at auth.resetEmailsPerHour so an address cannot be flooded. The
 * link lasts `ttlMinutes`, auth.resetLinkMinutes when not given. An invitation
 * carries the company it is for.
 */
export async function issuePasswordReset(
  userId: string,
  opts: { createdBy?: string | null; ttlMinutes?: number; purpose?: ResetPurpose; companyId?: string | null } = {},
): Promise<{ token: string; expiresAt: string } | null> {
  const now = new Date();
  if (!opts.createdBy) {
    const recent = await one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_by IS NULL AND created_at > ?',
      userId, new Date(now.getTime() - 3_600_000).toISOString());
    if ((recent?.n ?? 0) >= config().auth.resetEmailsPerHour) return null;
  }
  // Earlier links are marked spent rather than deleted, so they still count towards the hourly cap.
  await run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', now.toISOString(), userId);
  await run('DELETE FROM password_resets WHERE expires_at < ?', new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + (opts.ttlMinutes ?? config().auth.resetLinkMinutes) * 60_000).toISOString();
  await insert('password_resets', {
    tokenHash: hashToken(token), userId, createdBy: opts.createdBy ?? null,
    createdAt: now.toISOString(), expiresAt, usedAt: null,
    purpose: opts.purpose ?? 'RESET', companyId: opts.companyId ?? null,
  });
  return { token, expiresAt };
}

/** A live link: whose account it sets the password of, what it is for, and who made it. */
export interface ResetLink { user: UserRow; purpose: ResetPurpose; companyId: string | null; createdBy: string | null }

/**
 * A live reset token, without consuming it. An invitation is live only while
 * nobody has signed in to the account, by any way; and one handed to an
 * administrator to pass on, only while the account belongs to that company
 * alone, or it would let them into the person's other companies.
 */
export async function readPasswordReset(token: string): Promise<ResetLink | null> {
  if (!token || token.length > 200) return null;
  const row = await one<{ user_id: string; purpose: string; company_id: string | null; created_by: string | null; handed_out: number }>(
    'SELECT user_id, purpose, company_id, created_by, handed_out FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    hashToken(token), new Date().toISOString());
  if (!row) return null;
  const user = toCamel<UserRow>(await one('SELECT * FROM users WHERE id = ?', row.user_id));
  if (!user) return null;
  const purpose: ResetPurpose = row.purpose === 'INVITE' ? 'INVITE' : 'RESET';
  if (purpose === 'INVITE') {
    if (!neverSignedIn(user)) return null;
    if (Number(row.handed_out) === 1
        && await one('SELECT 1 FROM memberships WHERE user_id = ? AND company_id <> ? LIMIT 1', user.id, row.company_id)) return null;
  }
  return { user, purpose, companyId: row.company_id, createdBy: row.created_by };
}

/** Records that a link went to an administrator to pass on rather than to its owner (see readPasswordReset). */
export async function markPasswordResetHandedOut(token: string): Promise<void> {
  await run('UPDATE password_resets SET handed_out = 1 WHERE token_hash = ?', hashToken(token));
}

/** The account a live reset token belongs to, without consuming it. */
export async function peekPasswordReset(token: string): Promise<UserRow | null> {
  return (await readPasswordReset(token))?.user ?? null;
}

/** Marks a token used; returns the user id, or null when it is unknown, spent or expired. */
export async function consumePasswordReset(token: string): Promise<string | null> {
  const user = await peekPasswordReset(token);
  if (!user) return null;
  const updated = await run(
    'UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
    new Date().toISOString(), hashToken(token));
  return updated > 0 ? user.id : null;
}

/**
 * Replaces a password. Every session is signed out except `keepToken` (the
 * one making the change), so a stolen session does not survive a reset.
 */
export async function setPassword(
  userId: string, password: string, opts: { mustChange?: boolean; keepToken?: string | null } = {},
): Promise<void> {
  await update('users', userId, { passwordHash: hashPassword(password), mustChangePassword: opts.mustChange ? 1 : 0 });
  if (opts.keepToken) await run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', userId, opts.keepToken);
  else await run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/** A temporary password an administrator can read out loud: three groups, no look-alike characters. */
export function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // Groups of four, at least three of them, and as many more as auth.passwordMinLength needs.
  const groups = Math.max(3, Math.ceil((config().auth.passwordMinLength + 1) / 5));
  const bytes = randomBytes(groups * 4);
  let out = '';
  for (let i = 0; i < groups * 4; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < groups * 4 - 1) out += '-';
  }
  return out.slice(0, config().auth.passwordMaxLength);
}

export async function sessionsOf(userId: string): Promise<number> {
  return (await all('SELECT token FROM sessions WHERE user_id = ?', userId)).length;
}
