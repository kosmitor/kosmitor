/**
 * The assistant's provider, model and API key, as a section of Preferences.
 *
 * The key is the person's own and works across every company they belong to,
 * which is why it lives with their preferences rather than on a company page.
 * The warning comes first because using the assistant sends a company's cap
 * table, names included, to a provider outside this app.
 *
 * With ai.enabled off in kosmitor.config.json there is no assistant, and no card.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { api } from '../api.ts';
import { Banner, Button, Card, CardHeader, ConfirmDialog, ErrorNote, Field, Input, Loading, Select, useToast } from '../ui.tsx';
import { ConceptNote } from '../ConceptNote.tsx';
import { Icon } from '../icons.tsx';
import { relativeDate } from '../format.ts';
import { config, PRODUCT } from '../config.ts';
import { OTHER_MODEL, WhatIsSent, providerLabelOf, useAiSettings, type AiSettings } from './shared.tsx';

/**
 * The Assistant card on the Preferences page.
 *
 * Someone who can ask the assistant in this company sees it always. Someone who
 * cannot, such as an employee here who runs another company, sees it only while
 * they have a key stored, so they can still change or forget it from here.
 */
export function AssistantPreferences({ canAsk }: { canAsk: boolean }) {
  const { settings, setSettings, loading, error, reload } = useAiSettings();
  const { hash, key } = useLocation();
  const section = useRef<HTMLElement>(null);
  const shown = config.ai.enabled && (canAsk || !!settings?.configured);

  // A link to these settings, from the chat panel or search, lands on them and
  // puts focus there, each time it is followed, not only the first.
  useEffect(() => {
    if (hash !== '#assistant' || loading || !shown) return;
    const node = section.current;
    if (!node) return;
    node.scrollIntoView({ block: 'start' });
    node.focus({ preventScroll: true });
  }, [hash, key, loading, shown]);

  if (!shown) return null;
  return (
    <section ref={section} id="assistant" tabIndex={-1} aria-label="Assistant" className="scroll-mt-16 outline-none">
      <Card>
        <CardHeader title="Assistant"
          subtitle={canAsk
            ? 'The model that answers questions about your cap table, and your own API key. The chat opens from the round button at the bottom right.'
            : 'Your role in this company does not include the assistant. Your key is still stored for the companies where it does.'} />
        {canAsk && <ConceptNote id="ai-assistant" />}
        {loading ? <Loading label="Loading your assistant settings" />
          : error ? <ErrorNote error={`The assistant settings could not be loaded. ${error}`} onRetry={reload} />
            : settings ? <SettingsForm settings={settings} onChange={setSettings} canAsk={canAsk} /> : null}
      </Card>
    </section>
  );
}

function SettingsForm({ settings, onChange, canAsk }: { settings: AiSettings; onChange: (next: AiSettings) => void; canAsk: boolean }) {
  const { companyId } = useSession();
  const toast = useToast();
  const providers = settings.providers ?? [];
  const [provider, setProvider] = useState(settings.provider ?? providers[0]?.id ?? '');
  const [model, setModel] = useState(settings.model ?? providers[0]?.models[0] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = providers.find((p) => p.id === provider) ?? null;
  const models = current?.models ?? [];
  const [custom, setCustom] = useState(!!settings.model && !models.includes(settings.model));

  // When the stored settings change underneath, after a save or a forget, the form follows them.
  useEffect(() => {
    setProvider(settings.provider ?? providers[0]?.id ?? '');
    setModel(settings.model ?? providers[0]?.models[0] ?? '');
  }, [settings.provider, settings.model]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickProvider = (id: string) => {
    setProvider(id);
    setModel(providers.find((p) => p.id === id)?.models[0] ?? '');
    setCustom(false);
  };
  const pickModel = (value: string) => {
    if (value === OTHER_MODEL) { setCustom(true); return; }
    setCustom(false);
    setModel(value);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const key = apiKey.trim();
    if (!provider) { setError('Choose a provider first.'); return; }
    if (!model.trim()) { setError('Name the model to use.'); return; }
    // An empty key means keep the stored one, which only works once there is one.
    if (!settings.configured && !key) { setError('Paste an API key to save these settings.'); return; }
    setSaving(true);
    setError(null);
    try {
      const next = await api<AiSettings>('/ai/settings', {
        method: 'PUT',
        body: key ? { provider, model: model.trim(), apiKey: key } : { provider, model: model.trim() },
      });
      setApiKey('');
      onChange(next);
      toast('Assistant settings saved');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const forget = async () => {
    setForgetting(true);
    try {
      await api('/ai/settings', { method: 'DELETE' });
      setApiKey('');
      onChange({ ...settings, configured: false, keyHint: null, updatedAt: null });
      toast('The stored key was removed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setForgetting(false);
      setConfirmForget(false);
    }
  };

  const label = providerLabelOf(settings) ?? current?.label ?? null;

  return (
    <>
      <Banner tone="warning" title={`Using the assistant sends a cap table to ${current?.label ?? 'the provider you choose'}`}>
        <p>
          Each question sends a snapshot of the company you are in: stakeholder names, what each of them holds,
          and the terms recorded against those holdings. The provider's terms decide what happens to it from
          there. {PRODUCT} stores your key so it can make that call, and never sends the key back to this screen.
        </p>
        {/* The snapshot is of this company, which only someone who may ask about it can read. */}
        {companyId && canAsk && (
          <p className="mt-1.5">
            <button type="button" onClick={() => setShowSent(true)} className="font-medium underline underline-offset-2">
              See exactly what is sent
            </button>
          </p>
        )}
      </Banner>

      {providers.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">No providers are available on this server yet.</p>
      ) : (
        <form onSubmit={(e) => void save(e)}>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Provider" hint={current ? current.docsLabel : undefined}>
              <Select value={provider} onChange={(e) => pickProvider(e.target.value)}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Model" hint={custom ? 'Type the model name exactly as the provider spells it.' : undefined}>
              <Select value={custom ? OTHER_MODEL : model} onChange={(e) => pickModel(e.target.value)}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value={OTHER_MODEL}>Something else</option>
              </Select>
            </Field>
            <Field label="API key"
              hint={settings.configured && settings.keyHint
                ? `A key is stored (${settings.keyHint}). Leave this blank to keep it.`
                : 'Stored for you alone, and used in every company you belong to.'}>
              {/* A key, not a password: new-password and the manager-specific attributes keep
                  a password manager from filling in the person's sign-in password here. */}
              <Input type="password" autoComplete="new-password" data-1p-ignore="" data-lpignore="true" data-form-type="other"
                spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.keyHint ?? 'Paste your API key'} />
            </Field>
          </div>

          {custom && (
            <div className="mt-4 max-w-sm">
              <Field label="Model name">
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model name" />
              </Field>
            </div>
          )}

          {error && <div className="mt-4"><ErrorNote error={error} /></div>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={saving}>{settings.configured ? 'Save changes' : 'Save and turn on'}</Button>
            {settings.configured && (
              <Button type="button" variant="ghost" onClick={() => setConfirmForget(true)} loading={forgetting}>Forget the key</Button>
            )}
            {current && (
              <a href={current.keyUrl} target="_blank" rel="noreferrer noopener"
                className="ml-auto inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:text-brand-700">
                Get a key from {current.label} <Icon name="external" className="size-3.5" />
              </a>
            )}
          </div>

          <p className="mt-3 text-[12px] text-ink-500">
            {settings.configured
              ? <>Using {label}{settings.model ? ` · ${settings.model}` : ''}.{settings.updatedAt ? ` Last changed ${relativeDate(settings.updatedAt)}.` : ''}{canAsk ? ' Open the chat with the round button at the bottom right of any page.' : ''}</>
              : 'Once a key is saved, the round button at the bottom right of any page opens the chat.'}
          </p>
        </form>
      )}

      <ConfirmDialog open={confirmForget} onClose={() => setConfirmForget(false)} onConfirm={() => void forget()}
        danger loading={forgetting} confirmLabel="Forget the key" title="Forget the stored key?"
        message={`${PRODUCT} deletes its copy of the key. Conversations stay, and asking anything new needs a key again.`} />
      <WhatIsSent open={showSent} onClose={() => setShowSent(false)} providerLabel={current?.label ?? label} />
    </>
  );
}
