/**
 * What the assistant's chat and its settings have in common: the shapes the API
 * returns, how a reply is drawn, the snapshot a question sends, and whether the
 * chat panel is open.
 *
 * The chat lives in a panel that opens from a round button at the foot of every
 * page, and the model and key live in Preferences, because the key belongs to
 * the person and follows them into every company, while a conversation belongs
 * to one company and should be a click away from whatever page raised the question.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from '../session.tsx';
import { api, useQuery } from '../api.ts';
import { Button, ErrorNote, Loading, Modal, cx } from '../ui.tsx';
import { dateTime } from '../format.ts';
import { config, PRODUCT } from '../config.ts';

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

export interface ProviderInfo { id: string; label: string; models: string[]; keyUrl: string; docsLabel: string }
export interface AiSettings {
  configured: boolean;
  provider: string | null;
  model: string | null;
  /** Masked, so it can be shown on screen. The key itself never leaves the server. */
  keyHint: string | null;
  updatedAt: string | null;
  providers: ProviderInfo[];
}
export interface ChatSummary { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface ChatDetail { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }
export interface SendResult { chat: { id: string; title: string; updatedAt: string }; reply: ChatMessage }
interface ContextSnapshot { text: string; bytes: number; truncated: boolean }

/**
 * Openers that show what the thing is for, from ai.examplePrompts in
 * kosmitor.config.json. Each one should map to a page that holds the real answer.
 */
export const EXAMPLES: readonly string[] = config.ai.examplePrompts;

/** Model names change faster than any list the app can ship, so the select always offers a way out. */
export const OTHER_MODEL = '__other__';

/** The provider's own name for itself, rather than its id. */
export const providerLabelOf = (s: AiSettings | null): string | null =>
  (s?.provider ? s.providers?.find((p) => p.id === s.provider)?.label ?? s.provider : null);

// Every copy of the settings on screen (Preferences and the chat panel can both
// be showing) hears about a save, so the panel never says the assistant is not
// set up a moment after the key went in.
const settingsListeners = new Set<(next: AiSettings) => void>();

/**
 * The signed-in person's model and key. The key belongs to the person, not the
 * company, so the call carries no company id and the answer is the same everywhere.
 */
export function useAiSettings() {
  const q = useQuery<AiSettings>('/ai/settings');
  const [settings, setLocal] = useState<AiSettings | null>(null);
  useEffect(() => { if (q.data) setLocal(q.data); }, [q.data]);
  useEffect(() => {
    settingsListeners.add(setLocal);
    return () => { settingsListeners.delete(setLocal); };
  }, []);
  /** Records a change the server has accepted, everywhere it is shown. */
  const setSettings = useCallback((next: AiSettings) => { for (const listener of settingsListeners) listener(next); }, []);
  return { settings, setSettings, loading: q.loading && !settings, error: settings ? null : q.error, reload: q.reload };
}

// ---------------------------------------------------------------------------
// Whether the chat panel is open, reachable from anywhere
// ---------------------------------------------------------------------------

interface AssistantPanel {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** An answer arrived while the panel was closed, so the round button shows a dot. */
  unread: boolean;
  setUnread: (unread: boolean) => void;
}
const PanelContext = createContext<AssistantPanel>({ open: false, setOpen: () => {}, unread: false, setUnread: () => {} });

export function AssistantPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [unread, setUnread] = useState(false);
  // Whoever signs in next starts with the panel closed and nothing unread.
  const userId = useSession().user?.id ?? null;
  const [owner, setOwner] = useState(userId);
  if (owner !== userId) {
    setOwner(userId);
    setOpenState(false);
    setUnread(false);
  }
  // Opening the panel is reading what is in it.
  const setOpen = useCallback((next: boolean) => { setOpenState(next); if (next) setUnread(false); }, []);
  const value = useMemo(() => ({ open, setOpen, unread, setUnread }), [open, setOpen, unread]);
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/** Opens or closes the chat panel, from the search palette or an old link to the assistant page. */
export const useAssistantPanel = () => useContext(PanelContext);

// ---------------------------------------------------------------------------
// Reading a reply
// ---------------------------------------------------------------------------

type Block = { kind: 'bullet' | 'fixed' | 'text'; lines: string[] };

/**
 * Replies come back as plain text. Bullet lines and the occasional small table
 * are the only shapes worth recognising, and everything else is left exactly as
 * the model wrote it rather than pulled through a markdown parser the app does
 * not otherwise need.
 */
function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.split('\n')) {
    const kind: Block['kind'] = /^\s*[-*•]\s+/.test(line) ? 'bullet' : line.includes('|') ? 'fixed' : 'text';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else out.push({ kind, lines: [line] });
  }
  return out;
}

function ReplyBody({ text }: { text: string }) {
  const blocks = useMemo(() => blocksOf(text), [text]);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.kind === 'bullet') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.lines.map((line, j) => <li key={j}>{line.replace(/^\s*[-*•]\s+/, '')}</li>)}
            </ul>
          );
        }
        if (block.kind === 'fixed') {
          // Columns only line up in a fixed width font, and a wrapped row stops being a row.
          return (
            <div key={i} className="overflow-x-auto">
              <pre className="whitespace-pre font-mono text-[12px] leading-relaxed">{block.lines.join('\n')}</pre>
            </div>
          );
        }
        const body = block.lines.join('\n').trim();
        if (!body) return null;
        return <p key={i} className="whitespace-pre-wrap">{body}</p>;
      })}
    </div>
  );
}

export function Bubble({ message }: { message: ChatMessage }) {
  const mine = message.role === 'user';
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[88%] min-w-0">
        <p className={cx('mb-1 text-[11px] font-medium text-ink-500', mine && 'text-right')}
          title={dateTime(message.createdAt)}>{mine ? 'You' : 'Assistant'}</p>
        <div className={cx('rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed',
          mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md border border-ink-200/70 bg-ink-50 text-ink-800')}>
          {mine ? <p className="whitespace-pre-wrap">{message.content}</p> : <ReplyBody text={message.content} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What a question sends
// ---------------------------------------------------------------------------

/**
 * The snapshot of this company that goes out with every question, for reading
 * before anyone sends anything. It is rebuilt from the live records, so it is
 * fetched each time it is opened rather than kept.
 */
export function WhatIsSent({ open, onClose, providerLabel }: { open: boolean; onClose: () => void; providerLabel: string | null }) {
  const { companyId } = useSession();
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      setContext(await api<ContextSnapshot>(`/c/${companyId}/ai/context`));
    } catch (err) {
      setContext(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  return (
    <Modal open={open} onClose={onClose} size="xl" title="What gets sent with your question"
      description={`This snapshot, your question and the rest of the conversation go to ${providerLabel ?? 'the provider you choose'}. Nothing else from ${PRODUCT} is sent.`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {loading ? <Loading label="Building the snapshot" />
        : error ? <ErrorNote error={error} onRetry={() => void load()} />
          : context ? (
            <>
              <p className="mb-3 text-[12px] text-ink-500">
                {context.bytes.toLocaleString()} bytes
                {context.truncated ? ', shortened to fit the model. The parts left out are not sent.' : '.'}
              </p>
              <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-lg bg-ink-50 p-3 font-mono text-[12px] leading-relaxed text-ink-800">
                {context.text}
              </pre>
            </>
          ) : null}
    </Modal>
  );
}
