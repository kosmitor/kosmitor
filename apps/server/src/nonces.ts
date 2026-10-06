/**
 * Single-use nonces for Google sign-in attempts, kept in the database so they
 * survive a restart and work when more than one server instance is running.
 * Each lives five minutes and is destroyed the first time it is checked.
 */
import { randomBytes } from 'node:crypto';
import { one, run, insert } from './db.ts';

const NONCE_TTL_MS = 5 * 60_000;

export async function issueNonce(): Promise<string> {
  await run('DELETE FROM login_nonces WHERE expires_at <= ?', new Date().toISOString());
  const nonce = randomBytes(24).toString('base64url');
  await insert('login_nonces', { nonce, expiresAt: new Date(Date.now() + NONCE_TTL_MS).toISOString() });
  return nonce;
}

/** Burns the nonce whether or not it is valid, so a token can only be tried once. */
export async function consumeNonce(nonce: string | null | undefined): Promise<boolean> {
  if (!nonce) return false;
  const row = await one<{ expires_at: string }>('SELECT expires_at FROM login_nonces WHERE nonce = ?', nonce);
  await run('DELETE FROM login_nonces WHERE nonce = ?', nonce);
  return row != null && row.expires_at > new Date().toISOString();
}
