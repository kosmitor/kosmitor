/**
 * The conversation, sized for the panel that opens from the round button.
 *
 * Two facts shape it. The answers are written by someone else's model rather
 * than computed from the records, so they can be wrong while sounding certain,
 * and the footer says so. And every question carries a snapshot of this
 * company's real numbers, names included, to that provider, so the footer names
 * the provider and offers the snapshot for reading before anything is sent.
 *
 * Earlier conversations sit behind a toggle rather than beside the chat, because
 * a panel this narrow has room for one column. They stay reachable without a key,
 * so an old answer can still be read or deleted after the key is gone.
 *
 * A question can take a while. Moving to another conversation, a new one or
 * another company while it is out leaves the answer to land in its own
 * conversation, and nothing from it is drawn into the one now showing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { api, ApiError, useQuery } from '../api.ts';
import { Button, ConfirmDialog, ErrorNote, Loading, Spinner, useToast, cx } from '../ui.tsx';
import { INPUT_CLASS } from '../style.ts';
import { Icon } from '../icons.tsx';
import { relativeDate } from '../format.ts';
import {
  Bubble, EXAMPLES, WhatIsSent, providerLabelOf, useAiSettings, useAssistantPanel,
  type ChatDetail, type ChatMessage, type ChatSummary, type SendResult,
} from './shared.tsx';

export function AssistantChat({ open, onClose, composerRef }: {
  /** Whether the panel is showing. It stays mounted while closed. */
  open: boolean;
  onClose: () => void;
  /** The question box, so the panel can put focus in it when it opens. */
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { companyId, company } = useSession();
  const toast = useToast();
  const { setUnread } = useAssistantPanel();
  const { settings, loading: settingsLoading, error: settingsError, reload: reloadSettings } = useAiSettings();
  const providerLabel = providerLabelOf(settings);

  const chatsQ = useQuery<ChatSummary[]>(companyId ? `/c/${companyId}/ai/chats` : null, [companyId]);
  const chats = chatsQ.data ?? [];

  const [showList, setShowList] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [showSent, setShowSent] = useState(false);
  // What a screen reader hears: that a question went out, then the answer. The
  // conversation itself is not a live region, or opening one would read it all
  // out and the waiting timer would be announced every second.
  const [announcement, setAnnouncement] = useState('');

  // The conversation whose messages are already in memory. One this panel just
  // created is among them, so the loader below must not refetch it and wipe the
  // reply that is still in flight.
  const loadedId = useRef<string | null>(null);
  const loadSeq = useRef(0);
  // Bumped whenever the conversation on screen changes, so a reply that arrives
  // afterwards knows it belongs somewhere else.
  const sendToken = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const openRef = useRef(open);

  const focusSoon = (target: () => HTMLElement | null | undefined) => requestAnimationFrame(() => target()?.focus());

  /** Stops showing a question that is still out. Its answer is saved to its conversation all the same. */
  const letReplyGo = useCallback(() => {
    sendToken.current++;
    setSending(false);
    setAnnouncement('');
  }, []);

  const startDraft = useCallback(() => {
    letReplyGo();
    loadedId.current = null;
    setSelectedId(null);
    setMessages([]);
    setChatError(null);
    setSendError(null);
    setShowList(false);
  }, [letReplyGo]);

  // Conversations belong to one company, so switching companies starts over.
  useEffect(() => { startDraft(); }, [companyId, startDraft]);

  // Reopening reads the settings again, since they can change in another tab. A
  // dialog opened from the panel closes with it rather than floating over the page.
  useEffect(() => {
    if (open && !openRef.current) reloadSettings();
    if (!open) { setShowSent(false); setDeleting(null); }
    openRef.current = open;
  }, [open, reloadSettings]);

  const loadChat = useCallback(async (id: string) => {
    if (!companyId) return;
    const seq = ++loadSeq.current;
    setChatLoading(true);
    setChatError(null);
    try {
      const detail = await api<ChatDetail>(`/c/${companyId}/ai/chats/${id}`);
      if (seq !== loadSeq.current) return;
      loadedId.current = id;
      setMessages(detail.messages ?? []);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setChatError((err as Error).message);
      setMessages([]);
    } finally {
      if (seq === loadSeq.current) setChatLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (loadedId.current === selectedId) return;
    if (!companyId || !selectedId) {
      loadSeq.current++;
      loadedId.current = selectedId;
      setMessages([]);
      setChatError(null);
      return;
    }
    void loadChat(selectedId);
  }, [companyId, selectedId, loadChat]);

  // Replies are not streamed, so a long wait looks like nothing happening.
  useEffect(() => {
    if (!sending) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending, showList]);

  const ready = !!settings?.configured;

  // On the first open the question box appears only once the settings arrive,
  // after the panel took focus in its place; focus moves on to the box then.
  useEffect(() => {
    if (!open || !ready) return;
    const box = composerRef.current;
    if (box && document.activeElement === box.closest('[role="dialog"]')) box.focus();
  }, [open, ready, composerRef]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || sending || !companyId || !ready) return;
    const token = ++sendToken.current;
    const stillHere = () => token === sendToken.current;
    setSendError(null);
    setInput('');
    const pending: ChatMessage = { id: `pending-${Date.now()}`, role: 'user', content: question, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, pending]);
    setSending(true);
    setAnnouncement('Question sent. Waiting for the model.');
    // A suggested question disappears once it is asked, so focus goes to the box rather than nowhere.
    composerRef.current?.focus();
    try {
      let id = selectedId;
      if (!id) {
        const created = await api<ChatDetail>(`/c/${companyId}/ai/chats`, { body: {} });
        if (!stillHere()) return;
        id = created.id;
        loadedId.current = id;
        setSelectedId(id);
      }
      const result = await api<SendResult>(`/c/${companyId}/ai/chats/${id}/messages`, { body: { message: question } });
      if (!stillHere()) return;
      setMessages((m) => [...m, result.reply]);
      setAnnouncement(`The assistant answered: ${result.reply.content}`);
      if (!openRef.current) setUnread(true);
    } catch (err) {
      if (!stillHere()) return;
      // Nothing was saved, so the question goes back in the box rather than being
      // retyped, unless a new one has been started there in the meantime.
      setMessages((m) => m.filter((x) => x.id !== pending.id));
      setInput((typed) => (typed.trim() ? typed : question));
      setAnnouncement('');
      const message = (err as Error).message;
      setSendError(err instanceof ApiError && err.status === 400 && /configur/i.test(message)
        ? 'The assistant is not set up. Choose a model and add your key in Preferences.'
        : message);
    } finally {
      // A question that failed halfway may still have created the conversation, so the list is refetched either way.
      chatsQ.reload();
      if (stillHere()) setSending(false);
    }
  };

  const openChat = (id: string) => {
    if (id !== selectedId) {
      letReplyGo();
      setSelectedId(id);
      setSendError(null);
    }
    setShowList(false);
    focusSoon(() => composerRef.current ?? scroller.current);
  };

  const newChat = () => {
    startDraft();
    focusSoon(() => composerRef.current);
  };

  const remove = async () => {
    if (!deleting || !companyId) return;
    setRemoving(true);
    try {
      await api(`/c/${companyId}/ai/chats/${deleting.id}`, { method: 'DELETE' });
      const wasOpen = deleting.id === selectedId;
      if (wasOpen) startDraft();
      chatsQ.reload();
      toast('Conversation deleted');
      setDeleting(null);
      // The row that had focus is gone.
      focusSoon(() => (wasOpen ? composerRef.current : null) ?? historyButton.current);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRemoving(false);
    }
  };

  const cancelDelete = () => {
    const id = deleting?.id;
    setDeleting(null);
    if (id) focusSoon(() => deleteButtons.current.get(id));
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing guards the Enter that accepts a character from an input method editor.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const title = chats.find((c) => c.id === selectedId)?.title;
  const settled = !settingsLoading && !settingsError;
  const iconButton = 'rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-2 focus-visible:outline-brand-500';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p role="status" className="sr-only">{announcement}</p>

      <header className="flex items-center gap-2 border-b border-ink-100 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-600 text-white">
          <Icon name="sparkle" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="assistant-title" className="truncate text-[14px] font-semibold text-ink-900">Assistant</h2>
          <p className="truncate text-[11px] text-ink-500">{title || `About ${company?.name ?? 'this company'}`}</p>
        </div>
        {settled && (
          <>
            <button ref={historyButton} type="button" onClick={() => setShowList((v) => !v)} aria-pressed={showList}
              title="Earlier conversations" aria-label="Earlier conversations"
              className={cx(iconButton, showList && 'bg-brand-50 text-brand-700 hover:bg-brand-50 hover:text-brand-700')}>
              <Icon name="history" className="size-4" />
            </button>
            {ready && (
              <button type="button" onClick={newChat} title="New conversation" aria-label="New conversation" className={iconButton}>
                <Icon name="plus" className="size-4" />
              </button>
            )}
          </>
        )}
        <button type="button" onClick={onClose} title="Close" aria-label="Close the assistant" className={iconButton}>
          <Icon name="chevron" className="size-4" />
        </button>
      </header>

      {settingsLoading ? (
        <div className="flex-1 p-4"><Loading label="Loading the assistant" /></div>
      ) : settingsError ? (
        <div className="flex-1 p-4"><ErrorNote error={settingsError} onRetry={reloadSettings} /></div>
      ) : showList ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {chatsQ.error ? (
            <div className="p-3"><ErrorNote error={chatsQ.error} onRetry={chatsQ.reload} /></div>
          ) : chatsQ.loading && !chatsQ.data ? (
            <div className="p-3"><Loading label="Loading your conversations" /></div>
          ) : chats.length === 0 ? (
            <p className="px-4 py-4 text-[13px] leading-relaxed text-ink-500">
              Nothing here yet. Your questions and their answers are kept for you alone.
            </p>
          ) : (
            <ul aria-label="Earlier conversations">
              {chats.map((chat) => (
                <li key={chat.id} className={cx('group flex items-center gap-1 px-2', chat.id === selectedId && 'bg-brand-50/60')}>
                  <button type="button" onClick={() => openChat(chat.id)} aria-current={chat.id === selectedId ? 'true' : undefined}
                    className="min-w-0 flex-1 rounded-md px-1.5 py-2 text-left hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-brand-500">
                    <span className={cx('block truncate text-[13px]', chat.id === selectedId ? 'font-medium text-brand-700' : 'text-ink-800')}>
                      {chat.title || 'Untitled'}
                    </span>
                    <span className="block truncate text-[11px] text-ink-500">
                      {relativeDate(chat.updatedAt)} · {chat.messageCount} message{chat.messageCount === 1 ? '' : 's'}
                    </span>
                  </button>
                  {/* Shown on hover or focus with a mouse, and always on a touch screen, which has no hover. */}
                  <button type="button" onClick={() => setDeleting(chat)} aria-label={`Delete ${chat.title || 'this conversation'}`}
                    ref={(node) => { if (node) deleteButtons.current.set(chat.id, node); else deleteButtons.current.delete(chat.id); }}
                    className="shrink-0 rounded-md p-1.5 text-ink-400 opacity-0 hover:bg-ink-100 hover:text-red-600 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-brand-500 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <Icon name="trash" className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : !ready && !selectedId ? (
        // Nobody can ask anything without a model and a key, so the panel says
        // where to set them rather than offering a question box that will refuse.
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Icon name="sparkle" className="size-8 text-brand-500" />
          <p className="text-[14px] font-semibold text-ink-900">Set up the assistant first</p>
          <p className="text-[13px] leading-relaxed text-ink-600">
            Choose a model and add your own API key. It is kept for you alone and works in every company you belong to.
          </p>
          <Link to="/preferences#assistant" onClick={onClose}
            className="mt-1 inline-flex h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
            Open Preferences
          </Link>
          {chats.length > 0 && (
            <p className="text-[12px] text-ink-500">Earlier conversations are still here, under the clock at the top.</p>
          )}
        </div>
      ) : (
        <>
          <div ref={scroller} role="region" aria-label="Conversation" tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500">
            {chatLoading ? (
              <Loading label="Loading this conversation" />
            ) : chatError ? (
              <ErrorNote error={chatError} onRetry={() => { if (selectedId) void loadChat(selectedId); }} />
            ) : messages.length === 0 ? (
              <div className="px-1 py-2">
                <p className="text-[13px] leading-relaxed text-ink-600">
                  Ask about ownership, vesting, the option pool or a what if. Answers come from a language model, so
                  check any figure against the page that holds it.
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  {EXAMPLES.map((q) => (
                    <button key={q} type="button" onClick={() => void send(q)}
                      className="rounded-xl border border-ink-200 bg-white px-3 py-2 text-left text-[13px] text-ink-700 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((m) => <Bubble key={m.id} message={m} />)}
                {sending && (
                  <div className="flex justify-start">
                    <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-ink-200/70 bg-ink-50 px-3.5 py-2.5 text-[13px] text-ink-500">
                      <Spinner className="size-4" />
                      <span>Waiting for the model{elapsed > 2 ? `, ${elapsed} seconds so far` : ''}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {sendError && <div role="alert" className="px-3 pb-2"><ErrorNote error={sendError} /></div>}

          {ready ? (
            <div className="border-t border-ink-100 p-3">
              <div className="flex items-end gap-2">
                {/* A plain text area, two lines tall: the shared one has a minimum height
                    made for forms, which would take half this panel. It stays usable while
                    an answer is on its way, so focus is never thrown out of it. */}
                <textarea ref={composerRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onComposerKey}
                  rows={2} aria-label="Your question" placeholder={sending ? 'Your next question' : 'Ask a question'}
                  className={cx(INPUT_CLASS, 'h-auto flex-1 resize-none py-2 leading-relaxed')} />
                <Button variant="primary" loading={sending} disabled={!input.trim()} aria-label="Ask"
                  icon={<Icon name="send" />} onClick={() => void send(input)} />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                Enter sends. Each question sends this cap table, names included, to {providerLabel ?? 'your provider'}.{' '}
                <button type="button" onClick={() => setShowSent(true)} className="font-medium text-brand-600 hover:text-brand-700">
                  See what is sent
                </button>
              </p>
            </div>
          ) : (
            <p className="border-t border-ink-100 p-3 text-[12px] leading-relaxed text-ink-600">
              Asking anything new needs a model and your key.{' '}
              <Link to="/preferences#assistant" onClick={onClose} className="font-medium text-brand-600 hover:text-brand-700">
                Set them up in Preferences
              </Link>
            </p>
          )}
        </>
      )}

      <WhatIsSent open={showSent} onClose={() => setShowSent(false)} providerLabel={providerLabel} />
      <ConfirmDialog open={deleting != null} onClose={cancelDelete} onConfirm={() => void remove()}
        danger loading={removing} confirmLabel="Delete" title="Delete this conversation?"
        message={`"${deleting?.title || 'Untitled'}" and its answers are removed. Nothing on your cap table changes.`} />
    </div>
  );
}
