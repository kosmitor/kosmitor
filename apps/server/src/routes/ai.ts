/**
 * The assistant: questions about a cap table, answered by a model the person
 * brings themselves.
 *
 * Two things shape the design. The API key belongs to the person rather than the
 * company, because it is their account being charged and their credential to
 * keep from their colleagues, so the settings routes are not company scoped.
 * And the snapshot sent with every question is the whole cap table, so the
 * assistant is closed to the roles that are not allowed to see the whole cap
 * table, and the exact text is available for inspection at any time.
 */
import { route, assertFullView, badRequest, notFound, forbidden, HttpError, newId, nowISO, str } from '../http.ts';
import { all, one, insert, run, toCamel } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { seal, open, hint } from '../secrets.ts';
import { PROVIDERS, isProvider, complete, ProviderError, type ChatMessage, type ProviderId } from '../ai/providers.ts';
import { captableSnapshot, SYSTEM_PROMPT } from '../ai/context.ts';
import { complianceOptionsFor } from './analytics.ts';
import { config } from '../config.ts';
import { today } from '@kosmitor/core';
import { seesWholeCompany } from '../auth.ts';

// How much of the conversation travels with each question (ai.historyTurns; older
// turns fall away) and how long a question may be (ai.maxQuestionChars) are settings.

interface SettingsRow {
  user_id: string;
  provider: string;
  model: string;
  api_key: string;
  key_hint: string;
  updated_at: string;
}

/**
 * The assistant can be turned off (ai.enabled), for a deployment where cap table
 * data must not leave its servers. Every route then refuses, except forgetting a
 * stored key, which only ever removes something.
 */
function assertEnabled(): void {
  if (!config().ai.enabled) throw forbidden('The assistant is turned off on this server.');
}

/** Whether a provider is offered here: one of the supported ones, and not turned off in ai.providers. */
const offered = (id: unknown): id is ProviderId => isProvider(id) && config().ai.providers[id]?.enabled === true;

/** The providers people may choose, with the suggested models from ai.providers. */
const catalogue = () => PROVIDERS.filter((p) => offered(p.id)).map((p) => ({
  id: p.id, label: p.label, models: config().ai.providers[p.id]?.models ?? p.models, keyUrl: p.keyUrl, docsLabel: p.docsLabel,
}));

/** Never includes the key itself; there is no route that gives it back. */
function present(row: SettingsRow | undefined) {
  return {
    configured: !!row,
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    keyHint: row?.key_hint ?? null,
    updatedAt: row?.updated_at ?? null,
    providers: catalogue(),
  };
}

const settingsFor = (userId: string) =>
  one<SettingsRow>('SELECT * FROM user_ai_settings WHERE user_id = ?', userId);

// --- The person's own model and key -----------------------------------------

route.get('/api/ai/settings', 'user', async (ctx) => {
  assertEnabled();
  return present(await settingsFor(ctx.user!.id));
});

route.put('/api/ai/settings', 'user', async (ctx) => {
  assertEnabled();
  const provider = String(ctx.body.provider ?? '');
  if (!offered(provider)) throw badRequest('Choose one of the supported providers.');
  const model = str(ctx.body.model, 'Model', { max: 120 });

  const existing = await settingsFor(ctx.user!.id);
  const supplied = typeof ctx.body.apiKey === 'string' ? ctx.body.apiKey.trim() : '';
  // An empty key field means "keep the one you have", so the model can be changed
  // without the person digging their key out again.
  if (!supplied && !existing) throw badRequest('Paste an API key for the provider you chose.');
  if (supplied && supplied.length < 16) throw badRequest('That does not look like an API key.');

  const apiKey = supplied ? await seal(supplied) : existing!.api_key;
  const keyHint = supplied ? hint(supplied) : existing!.key_hint;
  const updatedAt = nowISO();

  if (existing) {
    await run('UPDATE user_ai_settings SET provider = ?, model = ?, api_key = ?, key_hint = ?, updated_at = ? WHERE user_id = ?',
      provider, model, apiKey, keyHint, updatedAt, ctx.user!.id);
  } else {
    await insert('user_ai_settings', { userId: ctx.user!.id, provider, model, apiKey, keyHint, updatedAt });
  }
  return present(await settingsFor(ctx.user!.id));
});

route.del('/api/ai/settings', 'user', async (ctx) => {
  await run('DELETE FROM user_ai_settings WHERE user_id = ?', ctx.user!.id);
  return { ok: true };
});

// --- Conversations, per company and private to their author ------------------

/** The assistant is handed the whole cap table, so it is closed to anyone who may not see it. */
function assertAssistantAccess(ctx: { membership: { role: string } | null }): void {
  assertEnabled();
  assertFullView(ctx, 'The assistant reads the whole cap table, which your role cannot see.');
}

async function ownedChat(ctx: { params: Record<string, string>; companyId: string | null; user: { id: string } | null }) {
  const chat = await one<{ id: string; title: string; created_at: string; updated_at: string }>(
    'SELECT * FROM ai_chats WHERE id = ? AND company_id = ? AND user_id = ?',
    ctx.params.id, ctx.companyId, ctx.user!.id);
  if (!chat) throw notFound('That conversation does not exist.');
  return chat;
}

const messagesOf = (chatId: string) =>
  all<{ id: string; role: string; content: string; created_at: string }>(
    "SELECT id, role, content, created_at FROM ai_messages WHERE chat_id = ? ORDER BY created_at, CASE role WHEN 'user' THEN 0 ELSE 1 END, id", chatId);

const shape = (chat: { id: string; title: string; created_at: string; updated_at: string }) =>
  ({ id: chat.id, title: chat.title, createdAt: chat.created_at, updatedAt: chat.updated_at });

route.get('/api/c/:cid/ai/chats', 'read', async (ctx) => {
  assertAssistantAccess(ctx);
  const rows = await all<{ id: string; title: string; created_at: string; updated_at: string; message_count: string }>(
    `SELECT c.*, (SELECT COUNT(*) FROM ai_messages m WHERE m.chat_id = c.id) AS message_count
     FROM ai_chats c WHERE c.company_id = ? AND c.user_id = ? ORDER BY c.updated_at DESC`,
    ctx.companyId, ctx.user!.id);
  return rows.map((r) => ({ ...shape(r), messageCount: Number(r.message_count) }));
});

route.post('/api/c/:cid/ai/chats', 'read', async (ctx) => {
  assertAssistantAccess(ctx);
  const id = newId('chat');
  const at = nowISO();
  await insert('ai_chats', { id, companyId: ctx.companyId, userId: ctx.user!.id, title: 'New conversation', createdAt: at, updatedAt: at });
  return { id, title: 'New conversation', createdAt: at, updatedAt: at, messages: [] };
});

route.get('/api/c/:cid/ai/chats/:id', 'read', async (ctx) => {
  assertAssistantAccess(ctx);
  const chat = await ownedChat(ctx);
  const messages = await messagesOf(chat.id);
  return { ...shape(chat), messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at })) };
});

route.del('/api/c/:cid/ai/chats/:id', 'read', async (ctx) => {
  assertAssistantAccess(ctx);
  const chat = await ownedChat(ctx);
  await run('DELETE FROM ai_chats WHERE id = ?', chat.id);
  return { ok: true };
});

/** The company's snapshot as of today, its compliance findings worked out as the Compliance page works them out. */
async function snapshotOf(companyId: string, company: Record<string, unknown> | undefined) {
  const asOf = today();
  return captableSnapshot(company ?? {}, await getCompanyData(companyId), asOf, await complianceOptionsFor(companyId, asOf));
}

/** The snapshot itself, so nobody has to take on trust what leaves the building. */
route.get('/api/c/:cid/ai/context', 'read', async (ctx) => {
  assertAssistantAccess(ctx);
  const company = toCamel<Record<string, unknown>>(await one('SELECT * FROM companies WHERE id = ?', ctx.companyId));
  const snapshot = await snapshotOf(ctx.companyId!, company);
  return snapshot;
});

route.post('/api/c/:cid/ai/chats/:id/messages', 'read', async (ctx) => {
  assertAssistantAccess(ctx);
  const chat = await ownedChat(ctx);
  const question = str(ctx.body.message, 'Message', { max: config().ai.maxQuestionChars });

  const settings = await settingsFor(ctx.user!.id);
  if (!settings) throw badRequest('The assistant is not configured yet. Choose a provider and paste an API key to start.');
  if (!offered(settings.provider)) {
    const label = PROVIDERS.find((p) => p.id === settings.provider)?.label ?? settings.provider;
    throw badRequest(`${label} is not offered on this server any more. Choose another provider in the assistant settings.`);
  }

  const company = toCamel<Record<string, unknown>>(await one('SELECT * FROM companies WHERE id = ?', ctx.companyId));
  const snapshot = await snapshotOf(ctx.companyId!, company);

  const earlier = await messagesOf(chat.id);
  // slice(-0) would be the whole conversation, so 0 has to mean none explicitly.
  const turns = config().ai.historyTurns;
  const history: ChatMessage[] = (turns > 0 ? earlier.slice(-turns) : [])
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  let answer: string;
  try {
    answer = await complete(
      settings.provider as ProviderId, settings.model, await open(settings.api_key),
      `${SYSTEM_PROMPT}\n\n---\n\n${snapshot.text}`,
      [...history, { role: 'user', content: question }],
    );
  } catch (err) {
    // What the provider said is the useful part, and it is the person's own key
    // and model at fault, so it reaches them rather than becoming a server error.
    if (err instanceof ProviderError) throw new HttpError(err.status, err.message);
    throw err;
  }

  // Only written once the provider has answered: a failed call should not leave a
  // question in the transcript with no reply beside it.
  const at = nowISO();
  const askedId = newId('msg');
  const replyId = newId('msg');
  await insert('ai_messages', { id: askedId, chatId: chat.id, role: 'user', content: question, createdAt: at });
  await insert('ai_messages', { id: replyId, chatId: chat.id, role: 'assistant', content: answer, createdAt: nowISO() });

  // The first question names the conversation, so the list is readable later.
  const title = earlier.length === 0
    ? question.replace(/\s+/g, ' ').slice(0, 60) + (question.length > 60 ? '…' : '')
    : chat.title;
  const updatedAt = nowISO();
  await run('UPDATE ai_chats SET title = ?, updated_at = ? WHERE id = ?', title, updatedAt, chat.id);

  return {
    chat: { id: chat.id, title, updatedAt },
    reply: { id: replyId, role: 'assistant', content: answer, createdAt: at },
  };
});
