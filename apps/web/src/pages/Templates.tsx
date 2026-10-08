import { useEffect, useState } from 'react';
import { useSession } from '../session.tsx';
import { useQuery, api } from '../api.ts';
import {
  PageHeader, Card, Button, Input, Field, Textarea, Badge, Loading, ErrorNote, EmptyState,
  Checkbox, ConfirmDialog, useToast, Banner, Modal, cx,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { dateTime } from '../format.ts';

interface Template { id: string; kind: string; name: string; body: string; isDefault: boolean; builtIn: boolean; updatedAt: string | null }
interface Draft { id: string | null; kind: string; name: string; body: string; isDefault: boolean; builtIn: boolean; source: string | null }

/**
 * The documents the platform generates when equity is issued. Built-in
 * templates cover each kind; a company can duplicate and edit them, and mark
 * one as the default the issuing flows pick up.
 */
export default function Templates() {
  const { companyId, canEdit } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useQuery<{ templates: Template[]; kinds: { kind: string; label: string; description: string }[]; fields: { token: string; description: string }[] }>(
    companyId ? `/c/${companyId}/templates` : null, [companyId]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ rendered: string; unknownTokens: string[] } | null>(null);
  const [showFields, setShowFields] = useState(false);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);

  const templates = data?.templates ?? [];
  const kinds = data?.kinds ?? [];
  const fields = data?.fields ?? [];

  useEffect(() => {
    if (!draft && templates.length) select(templates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  const select = (t: Template) => {
    setDraft({ id: t.id, kind: t.kind, name: t.name, body: t.body, isDefault: t.isDefault, builtIn: t.builtIn, source: null });
    setDirty(false);
    setPreview(null);
  };
  const startNew = (kind: string) => {
    const base = templates.find((t) => t.kind === kind && t.builtIn);
    setDraft({ id: null, kind, name: '', body: base?.body ?? '', isDefault: false, builtIn: false, source: base?.id ?? null });
    setDirty(true);
    setPreview(null);
  };
  const duplicate = () => {
    if (!draft) return;
    setDraft({ ...draft, id: null, name: `${draft.name} (custom)`, builtIn: false, isDefault: false, source: draft.id });
    setDirty(true);
  };
  const edit = (patch: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setDirty(true); };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = { kind: draft.kind, name: draft.name, body: draft.body, isDefault: draft.isDefault };
      const saved = draft.id && !draft.builtIn
        ? await api<Template>(`/c/${companyId}/templates/${draft.id}`, { method: 'PATCH', body })
        : await api<Template>(`/c/${companyId}/templates`, { body });
      toast(draft.id && !draft.builtIn ? 'Template saved' : 'Template created');
      await reload();
      setDraft({ id: saved.id, kind: saved.kind, name: saved.name, body: saved.body, isDefault: !!saved.isDefault, builtIn: false, source: null });
      setDirty(false);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/c/${companyId}/templates/${deleting.id}`, { method: 'DELETE' });
      toast('Template deleted');
      setDeleting(null);
      setDraft(null);
      await reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const runPreview = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setPreview(await api<{ rendered: string; unknownTokens: string[] }>(`/c/${companyId}/templates/preview`, { body: { body: draft.body } }));
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const insertToken = (token: string) => {
    if (!draft) return;
    edit({ body: `${draft.body}{{${token}}}` });
    void navigator.clipboard?.writeText(`{{${token}}}`).catch(() => undefined);
  };

  if (loading && !data) return <Loading label="Loading templates" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;

  const kindLabel = (k: string) => kinds.find((x) => x.kind === k)?.label ?? k;

  return (
    <>
      <PageHeader concept="templates" title="Document templates"
        subtitle="The agreements and certificates generated when you issue equity. Merge fields fill in the company, holder and grant details." />

      <div className="grid gap-5 lg:grid-cols-[300px_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          {kinds.map((k) => (
            <Card key={k.kind} padded={false}>
              <div className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900">{k.label}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{k.description}</p>
                </div>
                {canEdit && (
                  <Button size="sm" variant="ghost" aria-label={`New ${k.label}`} title="New template" onClick={() => startNew(k.kind)}>
                    <Icon name="plus" className="size-4" />
                  </Button>
                )}
              </div>
              <ul>
                {templates.filter((t) => t.kind === k.kind).map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => select(t)}
                      className={cx('flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-ink-50',
                        draft?.id === t.id && 'bg-brand-50 text-brand-900')}>
                      <span className="min-w-0 truncate" title={t.name}>{t.name}</span>
                      <span className="flex shrink-0 gap-1">
                        {t.builtIn && <Badge tone="neutral">Built-in</Badge>}
                        {!!t.isDefault && <Badge tone="brand">Default</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          {!draft ? (
            <Card><EmptyState title="Pick a template" description="Choose a template on the left to read or edit it." /></Card>
          ) : (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {draft.builtIn ? (
                    <>
                      <p className="text-[15px] font-semibold text-ink-900">{draft.name}</p>
                      <p className="mt-0.5 text-[12px] text-ink-500">Built-in {kindLabel(draft.kind).toLowerCase()}. It cannot be edited; duplicate it to make your own version.</p>
                    </>
                  ) : (
                    <Field label={draft.id ? 'Template name' : `New ${kindLabel(draft.kind).toLowerCase()}`} required>
                      <Input value={draft.name} onChange={(e) => edit({ name: e.target.value })} placeholder={`${kindLabel(draft.kind)} — ${new Date().getFullYear()}`} disabled={!canEdit} />
                    </Field>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setShowFields(true)} icon={<Icon name="link" />}>Merge fields</Button>
                  <Button onClick={() => void runPreview()} loading={busy}>Preview</Button>
                  {canEdit && draft.builtIn && <Button variant="primary" onClick={duplicate} icon={<Icon name="copy" />}>Duplicate to customize</Button>}
                  {canEdit && !draft.builtIn && draft.id && (
                    <Button variant="ghost" aria-label="Delete" title="Delete" onClick={() => setDeleting(templates.find((t) => t.id === draft.id) ?? null)}>
                      <Icon name="trash" className="size-4" />
                    </Button>
                  )}
                  {canEdit && !draft.builtIn && <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!dirty || !draft.name.trim() || !draft.body.trim()}>{draft.id ? 'Save' : 'Create template'}</Button>}
                </div>
              </div>

              {!draft.builtIn && draft.source && !draft.id && (
                <div className="mt-3"><Banner tone="info" title="Starting from the built-in text">Edit anything below; merge fields in double braces are filled in when a document is generated.</Banner></div>
              )}

              <div className="mt-4">
                <Textarea value={draft.body} onChange={(e) => edit({ body: e.target.value })} rows={26} readOnly={draft.builtIn || !canEdit}
                  className="font-mono text-[12px] leading-relaxed" spellCheck={false} />
              </div>

              {!draft.builtIn && canEdit && (
                <div className="mt-3">
                  <Checkbox label={`Use as the default ${kindLabel(draft.kind).toLowerCase()}`}
                    hint="The issuing flows pick the default for each kind unless another template is chosen."
                    checked={draft.isDefault} onChange={(v) => edit({ isDefault: v })} />
                </div>
              )}
              {draft.id && !draft.builtIn && (
                <p className="mt-3 text-[11px] text-ink-400">Last saved {dateTime(templates.find((t) => t.id === draft.id)?.updatedAt ?? '')}</p>
              )}
            </Card>
          )}
        </div>
      </div>

      <Modal open={!!preview} onClose={() => setPreview(null)} title="Preview with sample data" size="lg"
        footer={<Button onClick={() => setPreview(null)}>Close</Button>}>
        {preview && preview.unknownTokens.length > 0 && (
          <div className="mb-3">
            <Banner tone="warning" title="Unknown merge fields">
              These tokens are not filled in and will render blank: {preview.unknownTokens.map((t) => `{{${t}}}`).join(', ')}.
            </Banner>
          </div>
        )}
        <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-ink-200 bg-ink-50 p-4 font-serif text-[13px] leading-relaxed text-ink-800">
          {preview?.rendered}
        </div>
      </Modal>

      <Modal open={showFields} onClose={() => setShowFields(false)} title="Merge fields" size="lg"
        description="Write a field as {{token}}. Wrap optional text in {{#if token}} … {{/if}}, or {{#unless token}} … {{/unless}} for the opposite."
        footer={<Button onClick={() => setShowFields(false)}>Close</Button>}>
        <ul className="grid gap-1 sm:grid-cols-2">
          {fields.map((f) => (
            <li key={f.token}>
              <button type="button" onClick={() => insertToken(f.token)} disabled={!draft || draft.builtIn || !canEdit}
                className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-ink-50 disabled:cursor-default disabled:hover:bg-transparent"
                title="Append to the template and copy">
                <code className="text-[12px] text-brand-700">{`{{${f.token}}}`}</code>
                <span className="text-right text-[11px] text-ink-500">{f.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy}
        title="Delete template" confirmLabel="Delete"
        message={<>Delete <strong>{deleting?.name}</strong>? Documents already generated from it are unaffected.</>}
        onConfirm={() => void remove()} />
    </>
  );
}
