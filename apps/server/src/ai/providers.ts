/**
 * The three model providers the assistant can call.
 *
 * Each one takes a system prompt and an alternating conversation and gives back
 * text. The differences between them are small and entirely at the edges: where
 * the key goes, whether the system prompt is a field or the first message, and
 * where the answer sits in the response. Adding a fourth means adding one entry
 * here, its settings under ai.providers in kosmitor.config.json, and nothing
 * anywhere else. Which providers are offered, their suggested models and their
 * endpoints come from those settings, read when a call is made.
 *
 * Nothing in this file logs a key, an error body or a prompt. Cap table data
 * passes through it and the logs are not the place for either.
 */
import { config } from '../config.ts';

export type ProviderId = 'anthropic' | 'openai' | 'google';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Suggestions only, from ai.providers.<id>.models. Model names change constantly, so the field is free text. */
  models: string[];
  keyUrl: string;
  docsLabel: string;
}

/** A provider as this server knows it; its models are read from the settings each time they are asked for. */
const known = (id: ProviderId, label: string, keyUrl: string, docsLabel: string): Provider => ({
  id, label, keyUrl, docsLabel,
  get models() { return [...config().ai.providers[id].models]; },
});

/** Every provider this server can call, whether or not the settings offer it. providers() is the list in force. */
export const PROVIDERS: Provider[] = [
  known('anthropic', 'Anthropic', 'https://console.anthropic.com/settings/keys', 'Anthropic console'),
  known('openai', 'OpenAI', 'https://platform.openai.com/api-keys', 'OpenAI platform'),
  known('google', 'Google', 'https://aistudio.google.com/apikey', 'Google AI Studio'),
];

/** The providers people may choose: those with enabled: true under ai.providers. */
export const providers = (): Provider[] =>
  PROVIDERS.filter((p) => config().ai.providers[p.id]?.enabled === true);

/** One of the providers on offer. A provider turned off in the settings is not one. */
export const isProvider = (value: unknown): value is ProviderId =>
  providers().some((p) => p.id === value);

/** Raised for anything the provider refused, so the route can pass the reason on without a stack trace. */
export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** A provider's own message is the most useful thing to show, but not its whole error envelope. */
function describe(body: unknown, status: number): string {
  const found = (obj: unknown): string | null => {
    if (typeof obj === 'string') return obj;
    if (!obj || typeof obj !== 'object') return null;
    const record = obj as Record<string, unknown>;
    for (const field of ['message', 'error', 'detail', 'error_description']) {
      const value = record[field];
      const nested = found(value);
      if (nested) return nested;
    }
    return null;
  };
  const message = found(body);
  if (message) return message.slice(0, 400);
  return `The provider refused the request (HTTP ${status}).`;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new ProviderError('The model took too long to answer. Try a shorter question or a faster model.', 504);
    throw new ProviderError(`The provider could not be reached: ${(err as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* some gateways answer with plain text */ }
  if (!res.ok) throw new ProviderError(describe(parsed ?? text, res.status), res.status === 401 || res.status === 403 ? 400 : 502);
  if (parsed == null) throw new ProviderError('The provider sent a reply this server could not read.', 502);
  return parsed;
}

const asRecord = (value: unknown): Record<string, unknown> => (value ?? {}) as Record<string, unknown>;

export async function complete(
  provider: ProviderId, model: string, apiKey: string, system: string, messages: ChatMessage[],
): Promise<string> {
  const { ai } = config();
  const settings = ai.providers[provider];
  if (!ai.enabled) throw new ProviderError('The assistant is turned off on this server.', 403);
  if (!settings?.enabled) throw new ProviderError('This provider is turned off on this server. Choose another one in the assistant settings.');
  const maxTokens = ai.maxOutputTokens;
  const timeoutMs = ai.timeoutSeconds * 1000;

  if (provider === 'anthropic') {
    const body = await post(settings.endpoint, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }, { model, max_tokens: maxTokens, system, messages }, timeoutMs);
    const content = asRecord(body).content;
    const text = Array.isArray(content)
      ? content.filter((p) => asRecord(p).type === 'text').map((p) => String(asRecord(p).text ?? '')).join('')
      : '';
    if (!text.trim()) throw new ProviderError('The model returned an empty answer.', 502);
    return text;
  }

  if (provider === 'openai') {
    const body = await post(settings.endpoint, {
      Authorization: `Bearer ${apiKey}`,
    }, {
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }, timeoutMs);
    const choices = asRecord(body).choices;
    const first = Array.isArray(choices) ? asRecord(choices[0]) : {};
    const text = String(asRecord(first.message).content ?? '');
    if (!text.trim()) throw new ProviderError('The model returned an empty answer.', 502);
    return text;
  }

  // Google keeps the system prompt in its own field and calls the assistant "model".
  // Its endpoint is the API base; the model is part of the path.
  const url = `${settings.endpoint.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
  const body = await post(url, { 'x-goog-api-key': apiKey }, {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: maxTokens },
  }, timeoutMs);
  const candidates = asRecord(body).candidates;
  const parts = Array.isArray(candidates) ? asRecord(asRecord(candidates[0]).content).parts : null;
  const text = Array.isArray(parts) ? parts.map((p) => String(asRecord(p).text ?? '')).join('') : '';
  if (!text.trim()) throw new ProviderError('The model returned an empty answer.', 502);
  return text;
}
