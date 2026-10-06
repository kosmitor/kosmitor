/**
 * The assistant, without talking to a provider.
 *
 * Outbound calls are intercepted, so these tests cover the parts that are this
 * application's responsibility: that a key is sealed before it reaches a row and
 * never comes back out, that the snapshot handed over is the engine's own
 * arithmetic, that one person's conversations are their own, and that a refusal
 * from the provider reaches the person who owns the key.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/ai.ts');
const { one } = await import('../src/db.ts');
const { open, forgetSecretKey } = await import('../src/secrets.ts');

forgetSecretKey(); // the schema was just rebuilt underneath this process

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

// --- a stand-in for the model provider --------------------------------------

interface Sent { url: string; headers: Record<string, string>; body: any }
let sent: Sent[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { content: [{ type: 'text', text: 'Founders hold 72.0%.' }] } };
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    // Everything this test sends to its own server must still go out for real.
    if (url.startsWith(base)) return realFetch(input, init);
    sent.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body ?? '{}')) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await realFetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const KEY = 'sk-ant-api03-test-key-0123456789';

const owner = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Assistant Co' }, owner)).json.id as string;
const classes = (await call('GET', `/api/c/${cid}/share-classes`, undefined, owner)).json;
const holder = (await call('POST', `/api/c/${cid}/stakeholders`, { name: 'Avery Stone', type: 'INDIVIDUAL', relation: 'FOUNDER' }, owner)).json;
await call('POST', `/api/c/${cid}/issuances`, { stakeholderId: holder.id, shareClassId: classes[0].id, quantity: 7_200_000, issueDate: '2022-01-01' }, owner);

test('a key is sealed on the way in and never comes back out', async () => {
  const before_ = await call('GET', '/api/ai/settings', undefined, owner);
  assert.equal(before_.json.configured, false);
  assert.ok(before_.json.providers.some((p: any) => p.id === 'anthropic'), 'the provider catalogue is offered');

  const saved = await call('PUT', '/api/ai/settings', { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: KEY }, owner);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.configured, true);
  assert.equal(saved.json.model, 'claude-sonnet-5');
  assert.ok(!JSON.stringify(saved.json).includes(KEY), 'the key is never in a response');
  assert.match(saved.json.keyHint, /^sk-ant-a…/, 'enough of the key to recognise it');

  const row = await one<{ api_key: string }>('SELECT api_key FROM user_ai_settings LIMIT 1');
  assert.ok(!row!.api_key.includes(KEY), 'the stored column is not the key');
  assert.equal(await open(row!.api_key), KEY, 'and it opens back to the original');
});

test('changing the model keeps the key that is already stored', async () => {
  const again = await call('PUT', '/api/ai/settings', { provider: 'anthropic', model: 'claude-opus-5' }, owner);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.model, 'claude-opus-5');
  const row = await one<{ api_key: string }>('SELECT api_key FROM user_ai_settings LIMIT 1');
  assert.equal(await open(row!.api_key), KEY);
});

test('a question carries the engine\'s own figures and the answer is kept', async () => {
  sent = [];
  const chat = await call('POST', `/api/c/${cid}/ai/chats`, {}, owner);
  assert.equal(chat.status, 200, JSON.stringify(chat.json));

  const asked = await call('POST', `/api/c/${cid}/ai/chats/${chat.json.id}/messages`, { message: 'Who owns the most?' }, owner);
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.equal(asked.json.reply.content, 'Founders hold 72.0%.');
  assert.equal(asked.json.chat.title, 'Who owns the most?', 'the first question names the conversation');

  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /api\.anthropic\.com/);
  assert.equal(sent[0].headers['x-api-key'], KEY, 'the key is opened only on the way out');
  assert.equal(sent[0].body.model, 'claude-opus-5');
  const system = String(sent[0].body.system);
  assert.match(system, /Assistant Co/);
  assert.match(system, /7,200,000/, 'the snapshot carries computed totals, not raw rows');
  assert.match(system, /Fully diluted/);

  const back = await call('GET', `/api/c/${cid}/ai/chats/${chat.json.id}`, undefined, owner);
  assert.deepEqual(back.json.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(back.json.messages[0].content, 'Who owns the most?');
});

test('the snapshot is available for inspection, word for word', async () => {
  const ctx = await call('GET', `/api/c/${cid}/ai/context`, undefined, owner);
  assert.equal(ctx.status, 200);
  assert.ok(ctx.json.bytes > 100);
  assert.match(ctx.json.text, /# Totals/);
  assert.match(ctx.json.text, /7,200,000/);
  assert.equal(ctx.json.truncated, false);
});

test('a refusal from the provider reaches the person, and nothing is written', async () => {
  const chat = await call('POST', `/api/c/${cid}/ai/chats`, {}, owner);
  reply = { status: 401, body: { error: { message: 'invalid x-api-key' } } };
  const asked = await call('POST', `/api/c/${cid}/ai/chats/${chat.json.id}/messages`, { message: 'anything' }, owner);
  assert.equal(asked.status, 400);
  assert.match(asked.json.error, /invalid x-api-key/);

  const back = await call('GET', `/api/c/${cid}/ai/chats/${chat.json.id}`, undefined, owner);
  assert.deepEqual(back.json.messages, [], 'a question with no answer is not left in the transcript');
  reply = { status: 200, body: { content: [{ type: 'text', text: 'ok' }] } };
});

test('conversations belong to the person who had them', async () => {
  const chat = (await call('POST', `/api/c/${cid}/ai/chats`, {}, owner)).json;
  const other = (await call('POST', '/api/auth/register', { email: 'sam@example.com', name: 'Sam Reed', password: 'sam-pass-12' })).token as string;
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'sam@example.com', name: 'Sam Reed', role: 'ADMIN' }, owner);
  assert.equal(invite.status, 200, JSON.stringify(invite.json));

  const theirs = await call('GET', `/api/c/${cid}/ai/chats`, undefined, other);
  assert.deepEqual(theirs.json, [], 'a colleague sees none of them');
  const peek = await call('GET', `/api/c/${cid}/ai/chats/${chat.id}`, undefined, other);
  assert.equal(peek.status, 404);

  const settings = await call('GET', '/api/ai/settings', undefined, other);
  assert.equal(settings.json.configured, false, 'and none of the key either');
});

test('without a key the assistant says so instead of failing', async () => {
  const other = (await call('POST', '/api/auth/register', { email: 'lee@example.com', name: 'Lee Park', password: 'lee-pass-123' })).token as string;
  await call('POST', `/api/c/${cid}/members`, { email: 'lee@example.com', name: 'Lee Park', role: 'ADMIN' }, owner);
  const chat = await call('POST', `/api/c/${cid}/ai/chats`, {}, other);
  const asked = await call('POST', `/api/c/${cid}/ai/chats/${chat.json.id}/messages`, { message: 'hello' }, other);
  assert.equal(asked.status, 400);
  assert.match(asked.json.error, /not configured/);
});

test('a role that cannot see the cap table cannot ask about it', async () => {
  const invite = await call('POST', `/api/c/${cid}/members`, { email: 'priya@example.com', name: 'Priya Raman', role: 'EMPLOYEE' }, owner);
  const link = await call('POST', `/api/c/${cid}/members/${invite.json.id}/reset-password`, { mode: 'link' }, owner);
  const token = new URL(link.json.resetUrl).searchParams.get('token')!;
  const employee = (await call('POST', '/api/auth/reset', { token, password: 'priya-pass-1' })).token as string;
  const chats = await call('GET', `/api/c/${cid}/ai/chats`, undefined, employee);
  assert.notEqual(chats.status, 200);
});

test('forgetting the key leaves nothing behind', async () => {
  const gone = await call('DELETE', '/api/ai/settings', undefined, owner);
  assert.equal(gone.status, 200);
  assert.equal((await call('GET', '/api/ai/settings', undefined, owner)).json.configured, false);
  assert.equal(await one('SELECT user_id FROM user_ai_settings WHERE user_id IS NOT NULL'), undefined);
});

test('with the assistant turned off every route refuses, and a stored key can still be forgotten', async () => {
  const { configure, resetConfig } = await import('../src/config.ts');
  await call('PUT', '/api/ai/settings', { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: KEY }, owner);
  const chat = (await call('POST', `/api/c/${cid}/ai/chats`, {}, owner)).json;
  configure({ ai: { enabled: false } });
  try {
    sent = [];
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/ai/settings'], ['PUT', '/api/ai/settings', { provider: 'anthropic', model: 'claude-opus-5', apiKey: KEY }],
      ['GET', `/api/c/${cid}/ai/chats`], ['POST', `/api/c/${cid}/ai/chats`, {}], ['GET', `/api/c/${cid}/ai/chats/${chat.id}`],
      ['POST', `/api/c/${cid}/ai/chats/${chat.id}/messages`, { message: 'hello' }], ['GET', `/api/c/${cid}/ai/context`],
      ['DELETE', `/api/c/${cid}/ai/chats/${chat.id}`],
    ];
    for (const [method, path, body] of routes) {
      const res = await call(method, path, body, owner);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.match(res.json.error, /turned off/);
    }
    assert.equal(sent.length, 0, 'nothing reaches a provider');
    assert.equal((await call('DELETE', '/api/ai/settings', undefined, owner)).status, 200);
    assert.equal(await one('SELECT user_id FROM user_ai_settings WHERE user_id IS NOT NULL'), undefined);
  } finally {
    resetConfig();
  }
  assert.equal((await call('GET', `/api/c/${cid}/ai/chats/${chat.id}`, undefined, owner)).status, 200, 'the conversation is there again once it is back on');
});

test('a provider turned off is not offered, and a key stored for it is not used', async () => {
  const { configure, resetConfig } = await import('../src/config.ts');
  assert.equal((await call('PUT', '/api/ai/settings', { provider: 'openai', model: 'gpt-5', apiKey: 'sk-openai-test-0123456789abcdef' }, owner)).status, 200);
  const chat = (await call('POST', `/api/c/${cid}/ai/chats`, {}, owner)).json;
  configure({ ai: { providers: { openai: { enabled: false } } } });
  try {
    const settings = await call('GET', '/api/ai/settings', undefined, owner);
    assert.deepEqual(settings.json.providers.map((p: any) => p.id), ['anthropic', 'google']);
    assert.equal((await call('PUT', '/api/ai/settings', { provider: 'openai', model: 'gpt-5' }, owner)).status, 400);
    sent = [];
    const asked = await call('POST', `/api/c/${cid}/ai/chats/${chat.id}/messages`, { message: 'hello' }, owner);
    assert.equal(asked.status, 400);
    assert.match(asked.json.error, /OpenAI is not offered/);
    assert.equal(sent.length, 0, 'nothing is sent to it');
  } finally {
    resetConfig();
  }
});

test('how much history travels and how long a question may be follow the settings', async () => {
  const { configure, resetConfig } = await import('../src/config.ts');
  await call('PUT', '/api/ai/settings', { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: KEY }, owner);
  const chat = (await call('POST', `/api/c/${cid}/ai/chats`, {}, owner)).json;
  for (const message of ['one', 'two']) assert.equal((await call('POST', `/api/c/${cid}/ai/chats/${chat.id}/messages`, { message }, owner)).status, 200);
  configure({ ai: { historyTurns: 2, maxQuestionChars: 10 } });
  try {
    sent = [];
    assert.equal((await call('POST', `/api/c/${cid}/ai/chats/${chat.id}/messages`, { message: 'three' }, owner)).status, 200);
    const contents = sent[0].body.messages.map((m: any) => m.content);
    assert.equal(contents.length, 3, 'the last two turns and the question');
    assert.equal(contents.at(-1), 'three');
    assert.ok(!contents.includes('one'), 'older turns fall away');
    assert.equal((await call('POST', `/api/c/${cid}/ai/chats/${chat.id}/messages`, { message: 'far too long a question' }, owner)).status, 400);
  } finally {
    resetConfig();
  }
  await call('DELETE', '/api/ai/settings', undefined, owner);
});
