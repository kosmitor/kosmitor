/**
 * The settings the server's own plumbing reads: body and upload limits, who may
 * call the API from a browser, whose address goes in the audit log, how long a
 * sign-in lasts, and the defaults behind accounts, imports, documents and the
 * assistant. Each is changed with configure() and read back where it is used.
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { freshDatabase, sessionCookie } from './helpers.ts';

delete process.env.NODE_ENV;
await freshDatabase();
const { configure, resetConfig, config, megabytes } = await import('../src/config.ts');
const { handle, route, setSessionCookie } = await import('../src/http.ts');
const auth = await import('../src/auth.ts');
const { one } = await import('../src/db.ts');

afterEach(() => resetConfig());

route.post('/api/test/echo', 'public', (ctx) => ({ ip: ctx.ip, keys: Object.keys(ctx.body).length }));
route.post('/api/test/upload', 'public', (ctx) => ({ bytes: ctx.rawBody!.length }), { raw: true });
route.post('/api/test/upload-lazy', 'public', (ctx) => ({ bytes: ctx.rawBody!.length }), { raw: true, maxBytes: () => megabytes(config().limits.importUploadMb) });

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function post(path: string, body: string | Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : new Uint8Array(body) });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

/**
 * A body past the limit, handed to the server without a socket. Over a real
 * connection the server stops reading mid-body and the connection is reset, so
 * the answer it gives can only be read like this.
 */
async function postDirect(path: string, body: Buffer, contentType: string): Promise<{ status: number; json: any }> {
  const chunks = Array.from({ length: Math.ceil(body.length / 65_536) }, (_, i) => body.subarray(i * 65_536, (i + 1) * 65_536));
  const req = Object.assign(Readable.from(chunks), {
    method: 'POST', url: path, headers: { host: 'test', 'content-type': contentType }, socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = {
    headersSent: false, writableEnded: false,
    setHeader() {},
    writeHead(code: number) { status = code; res.headersSent = true; return res; },
    end(chunk?: unknown) { text = String(chunk ?? ''); res.writableEnded = true; },
  };
  await handle(req, res as unknown as ServerResponse);
  return { status, json: JSON.parse(text) };
}

test('X-Forwarded-For is believed only behind a proxy the settings declare', async () => {
  const forwarded = { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' };
  const direct = await post('/api/test/echo', '{}', forwarded);
  assert.match(direct.json.ip, /127\.0\.0\.1$/, 'by default the address is the socket, whatever the header claims');

  configure({ server: { trustProxy: true } });
  assert.equal((await post('/api/test/echo', '{}', forwarded)).json.ip, '10.0.0.1', 'the entry the proxy appended, not what the client claimed before it');
  assert.match((await post('/api/test/echo', '{}')).json.ip, /127\.0\.0\.1$/, 'and without the header it is still the socket');
});

test('browsers may call with credentials from app.url, server.allowedOrigins and, outside production, the dev server', async () => {
  const allowed = async (origin: string) =>
    (await fetch(`${base}/api/test/echo`, { method: 'OPTIONS', headers: { Origin: origin } })).headers.get('access-control-allow-origin');
  assert.equal(await allowed(config().app.url), config().app.url);
  assert.equal(await allowed('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(await allowed('https://admin.example.com'), null);

  configure({ app: { url: 'https://equity.example.com' }, server: { allowedOrigins: ['https://admin.example.com'] } });
  assert.equal(await allowed('https://equity.example.com'), 'https://equity.example.com');
  assert.equal(await allowed('https://admin.example.com'), 'https://admin.example.com');
  assert.equal(await allowed('https://evil.example.net'), null);
});

test('request bodies and uploads stop at limits.jsonBodyMb, limits.uploadMb or the route\'s own limit', async () => {
  configure({ limits: { jsonBodyMb: 1, uploadMb: 1, importUploadMb: 2 } });
  const big = Buffer.from(JSON.stringify({ text: 'x'.repeat(megabytes(1.5)) }));
  const refused = await postDirect('/api/test/echo', big, 'application/json');
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /too large/);
  configure({ limits: { jsonBodyMb: 2 } });
  assert.equal((await post('/api/test/echo', big)).status, 200);

  const file = Buffer.alloc(megabytes(1.5));
  const binary = 'application/octet-stream';
  const upload = await postDirect('/api/test/upload', file, binary);
  assert.equal(upload.status, 413);
  assert.equal(upload.json.error, 'The file is too large — the limit is 1 MB.');
  assert.equal((await post('/api/test/upload-lazy', file, { 'Content-Type': binary })).json.bytes, file.length,
    'a route that names its limit as a function is asked on the request');
  configure({ limits: { importUploadMb: 1 } });
  assert.equal((await postDirect('/api/test/upload-lazy', file, binary)).status, 413);
});

test('a sign-in lasts auth.sessionDays, in the cookie and in the database', async () => {
  configure({ auth: { sessionDays: 7 } });
  const headers: Record<string, string> = {};
  setSessionCookie({ setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as ServerResponse, 'tok');
  assert.match(headers['Set-Cookie'], /Max-Age=604800(;|$)/);

  const user = await auth.createUser('session@example.com', 'Session Person', 'long-enough-password');
  const token = await auth.createSession(user.id);
  // The table holds the token's hash, never the token.
  const row = await one<{ created_at: string; expires_at: string }>('SELECT created_at, expires_at FROM sessions WHERE token = ?', createHash('sha256').update(token).digest('hex'));
  assert.equal(Date.parse(row!.expires_at) - Date.parse(row!.created_at), 7 * 86_400_000);
});

test('new accounts take a colour from brand.colors.avatarChoices; resets follow auth.resetEmailsPerHour and auth.resetLinkMinutes', async () => {
  configure({ brand: { colors: { avatarChoices: [{ value: '#123456', label: 'Ink' }] } }, auth: { resetEmailsPerHour: 1, resetLinkMinutes: 30 } });
  const user = await auth.createUser('colour@example.com', 'Colour Person', 'long-enough-password');
  assert.equal(user.avatarColor, '#123456');
  const google = await auth.upsertGoogleUser({ sub: 'g-colour', email: 'g.colour@example.com', emailVerified: true, name: 'G Colour', picture: null, hostedDomain: null });
  assert.equal(google.avatarColor, '#123456');

  const first = await auth.issuePasswordReset(user.id);
  assert.ok(first);
  const minutes = (Date.parse(first.expiresAt) - Date.now()) / 60_000;
  assert.ok(minutes > 29 && minutes <= 30, `lasts ${minutes} minutes`);
  assert.equal(await auth.issuePasswordReset(user.id), null, 'the second request in the hour is refused');
  assert.equal(auth.minPasswordLength(), config().auth.passwordMinLength);
});

test('the assistant offers and calls only the providers turned on, at their configured endpoints and limits', async () => {
  const { providers, isProvider, complete, ProviderError, PROVIDERS } = await import('../src/ai/providers.ts');
  assert.deepEqual(providers().map((p) => p.id), ['anthropic', 'openai', 'google']);

  configure({ ai: { maxOutputTokens: 123, providers: { openai: { enabled: false }, google: { endpoint: 'https://gemini.example.test/v9/', models: ['gemini-x'] } } } });
  assert.deepEqual(providers().map((p) => p.id), ['anthropic', 'google']);
  assert.equal(isProvider('openai'), false);
  assert.deepEqual(PROVIDERS.find((p) => p.id === 'google')!.models, ['gemini-x']);
  await assert.rejects(complete('openai', 'gpt-5', 'key', 'system', [{ role: 'user', content: 'hi' }]), ProviderError);

  const realFetch = globalThis.fetch;
  const seen: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    seen.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello.' }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await complete('google', 'gemini-x', 'key', 'system', [{ role: 'user', content: 'hi' }]), 'Hello.');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen[0].url, 'https://gemini.example.test/v9/models/gemini-x:generateContent');
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 123);

  configure({ ai: { enabled: false } });
  await assert.rejects(complete('anthropic', 'm', 'key', 'system', []), (err: InstanceType<typeof ProviderError>) => err.status === 403);
});

test('imports read ambiguous dates in locale.importDateOrder, and documents format money in locale.locale and locale.currency', async () => {
  const { coerceDate } = await import('../src/import/values.ts');
  const { usd, perShare, integer } = await import('../src/templates.ts');
  const { tablePdf } = await import('../src/pdf-writer.ts');
  assert.equal(coerceDate('03/04/2024').value, '2024-03-04');
  assert.equal(usd(123_456), '$1,234.56');
  assert.equal(perShare(100), '$0.0001');

  configure({ locale: { importDateOrder: 'DMY', locale: 'de-DE', currency: 'EUR' }, brand: { productName: 'Acme Equity' } });
  assert.equal(coerceDate('03/04/2024').value, '2024-04-03');
  assert.equal(usd(123_456), (1234.56).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  assert.equal(integer(1_234_567), '1.234.567');
  const pdf = tablePdf({ title: 'Ledger', columns: [{ header: 'A' }], rows: [{ cells: ['1'] }] }).toString('latin1');
  assert.match(pdf, /\/Producer \(Acme Equity\)/);
});
