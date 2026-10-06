/**
 * Sealing the few secrets the application is handed by its users.
 *
 * Today that is one thing: the API key someone gives the assistant. It is their
 * credential, it can spend their money, and it arrives here only because it has
 * to reach the provider on their behalf, so it is encrypted before it touches a
 * row and opened only on the way out.
 *
 * The encryption key comes from KOSMITOR_SECRET_KEY when the environment sets it,
 * which is the arrangement worth having: the key then lives somewhere the
 * database does not, and a stolen dump is not enough to read the secrets. With
 * no such variable the server generates one and keeps it in its own table, which
 * still keeps keys out of logs, exports and casual queries, but cannot protect
 * them from someone holding the whole database. Set KOSMITOR_SECRET_KEY in anything
 * that matters.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { one, insert } from './db.ts';

const ALGORITHM = 'aes-256-gcm';
const SECRET_NAME = 'secret-key';
/** Fixed: the salt only has to be stable, the entropy is in the secret itself. */
const SALT = 'kosmitor/secrets/v1';

let cached: Buffer | null = null;

async function key(): Promise<Buffer> {
  if (cached) return cached;
  // CT_SECRET_KEY is the old name, still read so deployments that set it keep decrypting their stored keys.
  const fromEnv = process.env.KOSMITOR_SECRET_KEY ?? process.env.CT_SECRET_KEY;
  if (fromEnv && fromEnv.trim()) {
    cached = scryptSync(fromEnv.trim(), SALT, 32);
    return cached;
  }
  const row = await one<{ value: string }>('SELECT value FROM server_secrets WHERE name = ?', SECRET_NAME);
  if (row) {
    cached = scryptSync(row.value, SALT, 32);
    return cached;
  }
  // First use on a server with no configured key. Two processes racing here both
  // insert, one loses on the primary key, and the loser reads the winner's value.
  const generated = randomBytes(32).toString('base64');
  try {
    await insert('server_secrets', { name: SECRET_NAME, value: generated, createdAt: new Date().toISOString() });
    cached = scryptSync(generated, SALT, 32);
  } catch {
    const winner = await one<{ value: string }>('SELECT value FROM server_secrets WHERE name = ?', SECRET_NAME);
    if (!winner) throw new Error('The server could not establish a secret key.');
    cached = scryptSync(winner.value, SALT, 32);
  }
  return cached;
}

/** Only for tests, which swap databases underneath a running process. */
export function forgetSecretKey(): void {
  cached = null;
}

export async function seal(plain: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, await key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export async function open(sealed: string): Promise<string> {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('That stored secret is not in a format this server understands.');
  const decipher = createDecipheriv(ALGORITHM, await key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Enough of a key to recognise it, never enough to use it. Providers put their
 * identifying prefix at the front, so both ends are worth showing.
 */
export function hint(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 12) return `${'•'.repeat(Math.max(0, trimmed.length - 2))}${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}
