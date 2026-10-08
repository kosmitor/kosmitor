import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from './session.tsx';
import { useQuery, uploadFile } from './api.ts';
import { Button, ErrorNote, Field, Input, Modal, Select, useToast } from './ui.tsx';
import { DOCUMENT_CATEGORIES } from './documents.ts';
import { AWARD_LABELS, INSTRUMENT_LABELS, fileSize, money, pps, shares } from './format.ts';

const BLANK = { title: '', category: 'AGREEMENT', folder: 'General', stakeholderId: '', securityId: '', visibility: 'ADMIN' };

/**
 * "Save this PDF as a document": a PDF dropped where spreadsheets are imported
 * is not read as a table. It is kept exactly as it came, filed in Documents,
 * and linked to a stakeholder and one of their instruments, which is what makes
 * it findable later. Opens over whichever screen it was dropped on.
 */
export function SavePdfDialog({ file, onClose, onSaved }: { file: File | null; onClose: () => void; onSaved?: (file: File) => void }) {
  const { companyId } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    setForm({ ...BLANK, title: file.name.replace(/\.pdf$/i, '') });
    setError(null);
  }, [file]);

  // The holders and their instruments are fetched only once a PDF arrives.
  const linking = file ? companyId : null;
  const { data: stakeholders } = useQuery<any[]>(linking ? `/c/${linking}/stakeholders` : null, [linking]);
  const { data: shareClasses } = useQuery<any[]>(linking ? `/c/${linking}/share-classes` : null, [linking]);
  const { data: issuances } = useQuery<any[]>(linking ? `/c/${linking}/issuances` : null, [linking]);
  const { data: awards } = useQuery<any[]>(linking ? `/c/${linking}/awards` : null, [linking]);
  const { data: convertibles } = useQuery<any[]>(linking ? `/c/${linking}/convertibles` : null, [linking]);
  const { data: warrants } = useQuery<any[]>(linking ? `/c/${linking}/warrants` : null, [linking]);

  /** Everything the chosen holder owns, described well enough to tell two of them apart. */
  const instruments = useMemo(() => {
    const holder = form.stakeholderId;
    if (!holder) return [] as { id: string; label: string }[];
    const mine = (rows: any[] | null): any[] => (rows ?? []).filter((r) => r.stakeholderId === holder);
    const className = (id: string): string => (shareClasses ?? []).find((c) => c.id === id)?.name ?? 'shares';
    return [
      ...mine(issuances).map((i) => ({ id: i.id,
        label: `Certificate ${i.certificateNo || '(unnumbered)'} · ${className(i.shareClassId)} · ${shares(i.quantity)} shares` })),
      ...mine(awards).map((a) => ({ id: a.id,
        label: `Grant ${[a.label, AWARD_LABELS[a.type] ?? a.type].filter(Boolean).join(' · ')} · ${shares(a.quantity)} shares` })),
      ...mine(convertibles).map((c) => ({ id: c.id,
        label: `${[c.label, INSTRUMENT_LABELS[c.instrument] ?? c.instrument].filter(Boolean).join(' · ')} · ${money(c.principal, { compact: true })}` })),
      ...mine(warrants).map((w) => ({ id: w.id, label: `Warrant · ${shares(w.quantity)} shares at ${pps(w.strikePrice)}` })),
    ];
  }, [form.stakeholderId, issuances, awards, convertibles, warrants, shareClasses]);

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadFile(`/c/${companyId}/documents/upload`, file, {
        title: form.title.trim() || file.name,
        category: form.category,
        folder: form.folder.trim() || 'General',
        stakeholderId: form.stakeholderId,
        securityId: form.securityId,
        visibility: form.visibility,
      });
      onSaved?.(file);
      onClose();
      toast('Saved to Documents', 'success', { label: 'Open', onClick: () => navigate('/documents') });
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!file} onClose={onClose} title="Save this PDF as a document"
      description="PDFs aren't read as tables. Name it and link it, and it's filed in Documents."
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>Save document</Button>
      </>}>
      {file && (
        <div className="space-y-4">
          {error && <ErrorNote error={error} />}
          <p className="truncate text-[12px] text-ink-500">{file.name} · {fileSize(file.size)}</p>
          <Field label="Name">
            <Input value={form.title} placeholder={file.name} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {DOCUMENT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Folder">
              <Input value={form.folder} placeholder="General" onChange={(e) => setForm({ ...form, folder: e.target.value })} />
            </Field>
          </div>
          <Field label="Stakeholder" hint="Leave this empty for a document that is not about one person.">
            <Select value={form.stakeholderId}
              onChange={(e) => setForm({
                ...form, stakeholderId: e.target.value, securityId: '',
                visibility: !e.target.value && form.visibility === 'HOLDER' ? 'ADMIN' : form.visibility,
              })}>
              <option value="">Not about one person</option>
              {(stakeholders ?? []).map((sh) => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
            </Select>
          </Field>
          <Field label="Instrument"
            hint={!form.stakeholderId ? 'Choose a stakeholder first.'
              : instruments.length === 0 ? 'This person holds nothing yet.' : 'Optional: the certificate, grant, SAFE or warrant this file covers.'}>
            <Select value={form.securityId} disabled={!form.stakeholderId || instruments.length === 0}
              onChange={(e) => setForm({ ...form, securityId: e.target.value })}>
              <option value="">Not about one instrument</option>
              {instruments.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </Select>
          </Field>
          <Field label="Who can see it">
            <Select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              <option value="ADMIN">Administrators only</option>
              <option value="HOLDER" disabled={!form.stakeholderId}>The linked stakeholder</option>
              <option value="ALL">Everyone in the company</option>
            </Select>
          </Field>
        </div>
      )}
    </Modal>
  );
}
