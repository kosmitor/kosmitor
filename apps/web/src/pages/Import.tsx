import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { api, useQuery, uploadFile, downloadFile } from '../api.ts';
import {
  PageHeader, Card, CardHeader, Button, Select, Field, Input, Badge, Checkbox, Table, TH, TD, TR,
  Loading, ErrorNote, EmptyState, SegmentedControl, useToast, Banner, Stat, KeyValue, Spinner, cx,
} from '../ui.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { takeImportFile, IMPORT_ACCEPT } from '../importHandoff.ts';
import { DOCUMENT_CATEGORIES } from '../documents.ts';
import { config } from '../config.ts';
import {
  date, dateTime, shares as fmtShares, money as fmtMoney, pps as fmtPPS, AWARD_LABELS, INSTRUMENT_LABELS, fileSize,
} from '../format.ts';

type Cell = string | number | boolean | null;
interface FieldSpec { key: string; label: string; type: string; required: boolean; hint: string | null }
interface KindSpec { key: string; label: string; description: string; fields: FieldSpec[] }
interface ParsedSheet { name: string; rows: Cell[][]; rowCount: number; truncated: boolean; headerRow?: number }
/** A field reads a column, or takes one fixed value on every row (a share class named by the sheet). */
type MappingValue = number | { value: string } | null;
interface Suggestion { mapping: Record<string, number | null>; constants: Record<string, string>; score: number; requiredCount: number }
interface Detection extends Suggestion { name: string; kind: string | null; reason: string | null }
/** One tab of the uploaded file and how it will be imported. */
interface SheetPlan extends ParsedSheet {
  headerRow: number;
  kind: string | null;
  include: boolean;
  mapping: Record<string, MappingValue>;
  detectedKind: string | null;
  reason: string | null;
}
interface PreviewRow { row: number; status: 'ok' | 'warning' | 'error'; action: string; summary: Record<string, Cell>; messages: { level: string; text: string }[] }
interface Counts { total: number; ok: number; warnings: number; errors: number; skipped: number; willImport: number }
interface Creates { stakeholders: string[]; shareClasses: string[]; vestingSchedules: string[]; pools: string[] }
interface Preview { rows: PreviewRow[]; counts: Counts; creates: Creates; importId?: string; imported?: Record<string, number> }
interface SheetResult { sheetName: string; kind: string; blocked: boolean; preview: Preview }
interface WorkbookResult { sheets: SheetResult[]; counts: Counts; creates: Creates; imported: Record<string, number>; importIds: string[] }

const KIND_ICONS: Record<string, IconName> = { stakeholders: 'users', captable: 'certificate', grants: 'award', convertibles: 'convert' };
const NOT_MAPPED = '__none__';
const FIXED_VALUE = '__fixed__';
const SKIP_SHEET = '__skip__';

/** The widest of the first ten rows names the most columns — the header, even behind a title block. */
function guessHeaderRow(rows: Cell[][]): number {
  let best = 0;
  let bestCount = -1;
  rows.slice(0, 10).forEach((r, i) => {
    const count = r.filter((c) => c !== null && c !== undefined && String(c).trim() !== '').length;
    if (count > bestCount) { best = i; bestCount = count; }
  });
  return best;
}

const withConstants = (s: Suggestion): Record<string, MappingValue> => ({
  ...s.mapping,
  ...Object.fromEntries(Object.entries(s.constants ?? {}).map(([k, v]) => [k, { value: v }])),
});

const cellText = (c: Cell): string => (c === null || c === undefined ? '' : typeof c === 'boolean' ? (c ? 'Yes' : 'No') : String(c));
const isMapped = (m: MappingValue): boolean => m != null && (typeof m === 'number' || m.value.trim() !== '');
const plural = (n: number, word: string, pluralWord = `${word}s`): string => `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
const BLANK_DOCUMENT = { title: '', category: 'AGREEMENT', folder: 'General', stakeholderId: '', securityId: '', visibility: 'ADMIN' };

export default function ImportData() {
  const { companyId, canEdit } = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data: schema, error: schemaError } = useQuery<{ kinds: KindSpec[]; maxRows: number }>(companyId ? `/c/${companyId}/imports/schema` : null, [companyId]);
  const { data: schedules } = useQuery<any[]>(companyId ? `/c/${companyId}/vesting-schedules` : null, [companyId]);
  const { data: pools } = useQuery<any[]>(companyId ? `/c/${companyId}/pools` : null, [companyId]);
  const { data: history, reload: reloadHistory } = useQuery<any[]>(companyId ? `/c/${companyId}/imports` : null, [companyId]);

  const [step, setStep] = useState<'choose' | 'attach' | 'map' | 'preview' | 'done'>('choose');
  const [kind, setKind] = useState<string>(params.get('kind') ?? 'captable');
  const [fileName, setFileName] = useState('');
  const [plans, setPlans] = useState<SheetPlan[]>([]);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [options, setOptions] = useState({
    dateOrder: config.locale.importDateOrder as string, createMissingStakeholders: true, createMissingShareClasses: true,
    defaultVestingScheduleId: '', defaultPoolId: '', skipRowsWithErrors: false,
  });
  const [preview, setPreview] = useState<WorkbookResult | null>(null);
  const [result, setResult] = useState<WorkbookResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pdf, setPdf] = useState<File | null>(null);
  const [docForm, setDocForm] = useState(BLANK_DOCUMENT);
  const [stored, setStored] = useState<any>(null);

  // Only the PDF step needs the holders and their instruments, so nothing is fetched until one arrives.
  const linking = pdf ? companyId : null;
  const { data: stakeholders } = useQuery<any[]>(linking ? `/c/${linking}/stakeholders` : null, [linking]);
  const { data: shareClasses } = useQuery<any[]>(linking ? `/c/${linking}/share-classes` : null, [linking]);
  const { data: issuances } = useQuery<any[]>(linking ? `/c/${linking}/issuances` : null, [linking]);
  const { data: awards } = useQuery<any[]>(linking ? `/c/${linking}/awards` : null, [linking]);
  const { data: convertibles } = useQuery<any[]>(linking ? `/c/${linking}/convertibles` : null, [linking]);
  const { data: warrants } = useQuery<any[]>(linking ? `/c/${linking}/warrants` : null, [linking]);

  const spec = schema?.kinds.find((k) => k.key === kind) ?? null;
  const kindLabel = (k: string | null): string => schema?.kinds.find((x) => x.key === k)?.label ?? k ?? '';
  const plan = plans[active];
  const planSpec = schema?.kinds.find((k) => k.key === plan?.kind) ?? null;
  const headers = useMemo<Cell[]>(() => plan?.rows[plan.headerRow] ?? [], [plan]);
  const dataRows = useMemo<Cell[][]>(() => plan?.rows.slice(plan.headerRow + 1) ?? [], [plan]);
  const included = plans.filter((p) => p.include && p.kind);
  const includedRows = included.reduce((n, p) => n + Math.max(0, p.rows.length - p.headerRow - 1), 0);
  const missingFor = (p: SheetPlan): string[] =>
    (schema?.kinds.find((k) => k.key === p.kind)?.fields ?? []).filter((f) => f.required && !isMapped(p.mapping[f.key])).map((f) => f.label);

  useEffect(() => { if (params.get('kind') !== kind) setParams({ kind }, { replace: true }); }, [kind, params, setParams]);

  /** Everything the chosen holder owns, described well enough to tell two of them apart. */
  const instruments = useMemo(() => {
    const holder = docForm.stakeholderId;
    if (!holder) return [] as { id: string; label: string }[];
    const mine = (rows: any[] | null): any[] => (rows ?? []).filter((r) => r.stakeholderId === holder);
    const className = (id: string): string => (shareClasses ?? []).find((c) => c.id === id)?.name ?? 'shares';
    return [
      ...mine(issuances).map((i) => ({ id: i.id,
        label: `Certificate ${i.certificateNo || '(unnumbered)'} · ${className(i.shareClassId)} · ${fmtShares(i.quantity)} shares` })),
      ...mine(awards).map((a) => ({ id: a.id,
        label: `Award ${[a.label, AWARD_LABELS[a.type] ?? a.type].filter(Boolean).join(' · ')} · ${fmtShares(a.quantity)} shares` })),
      ...mine(convertibles).map((c) => ({ id: c.id,
        label: `${[c.label, INSTRUMENT_LABELS[c.instrument] ?? c.instrument].filter(Boolean).join(' · ')} · ${fmtMoney(c.principal, { compact: true })}` })),
      ...mine(warrants).map((w) => ({ id: w.id,
        label: `Warrant · ${fmtShares(w.quantity)} shares at ${fmtPPS(w.strikePrice)}` })),
    ];
  }, [docForm.stakeholderId, issuances, awards, convertibles, warrants, shareClasses]);

  // A file dropped on another page (the cap table) arrives here already chosen.
  // It waits for the import schema, so the notes it produces can name kinds properly.
  useEffect(() => {
    if (!companyId || !schema) return;
    const handoff = takeImportFile();
    if (!handoff) return;
    setKind(handoff.kind);
    void receiveFile(handoff.file, handoff.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, schema]);

  const suggest = (k: string, headerCells: Cell[], sheetName: string) =>
    api<Suggestion>(`/c/${companyId}/imports/suggest`, { body: { kind: k, headers: headerCells, sheetName } });

  /**
   * Parses the file and plans every tab: each one is detected as a stakeholder
   * list, certificate ledger, grant ledger or convertible ledger — or set aside
   * with the reason (summary tabs). A lone sheet is imported as what was picked.
   */
  const receiveFile = async (file: File, preferredKind = kind) => {
    // A PDF is kept exactly as it was handed over, so there is nothing to parse
    // or map: it goes straight to the step that names it and links it.
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      setPdf(file);
      setFileName(file.name);
      setDocForm({ ...BLANK_DOCUMENT, title: file.name.replace(/\.pdf$/i, '') });
      setNote(null);
      setError(null);
      setStep('attach');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsed = await uploadFile<{ fileName: string; sheets: ParsedSheet[] }>(`/c/${companyId}/imports/parse`, file);
      const headerRows = parsed.sheets.map((s) => s.headerRow ?? guessHeaderRow(s.rows));
      const detected = await api<{ sheets: Detection[] }>(`/c/${companyId}/imports/detect`, {
        body: {
          preferredKind,
          sheets: parsed.sheets.map((s, i) => ({ name: s.name, headers: s.rows[headerRows[i]] ?? [], rowCount: s.rows.length - headerRows[i] - 1 })),
        },
      });
      const single = parsed.sheets.length === 1;
      const next: SheetPlan[] = parsed.sheets.map((s, i) => {
        const d = detected.sheets[i];
        const k = d.kind ?? (single ? preferredKind : null);
        return { ...s, headerRow: headerRows[i], kind: k, include: k != null, mapping: withConstants(d), detectedKind: d.kind, reason: d.reason };
      });
      setFileName(parsed.fileName);
      setPlans(next);
      setActive(Math.max(0, next.findIndex((p) => p.include)));
      setPreview(null);
      if (single) {
        const d = detected.sheets[0];
        if (d.kind && d.kind !== preferredKind) {
          setKind(d.kind);
          setNote(`This sheet looks like ${kindLabel(d.kind).toLowerCase()} rather than ${kindLabel(preferredKind).toLowerCase()} — switched. Change it below if that is wrong.`);
        } else setNote(null);
      } else {
        const used = next.filter((p) => p.include);
        const left = next.filter((p) => !p.include);
        setNote(used.length === 0
          ? 'None of the tabs has the columns of a ledger — pick a tab and choose what it holds.'
          : `${plural(used.length, 'tab')} recognised: ${used.map((p) => `${p.name} → ${kindLabel(p.kind).toLowerCase()}`).join(', ')}.`
            + (left.length ? ` Left out: ${left.map((p) => p.name).join(', ')}.` : ''));
      }
      setStep('map');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const updatePlan = (index: number, patch: Partial<SheetPlan>) =>
    setPlans((ps) => ps.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  /** Re-guesses the columns of one tab for a kind, keeping the header row. */
  const replan = async (index: number, k: string | null, headerRow?: number) => {
    const p = plans[index];
    const hr = headerRow ?? p.headerRow;
    if (!k) { updatePlan(index, { kind: null, include: false, headerRow: hr }); return; }
    try {
      const s = await suggest(k, p.rows[hr] ?? [], p.name);
      updatePlan(index, { kind: k, include: true, headerRow: hr, mapping: withConstants(s) });
      if (plans.length === 1) setKind(k);
    } catch (err) { setError((err as Error).message); }
  };

  const requestBody = (sheetPlans: SheetPlan[] = plans) => ({
    fileName,
    options: {
      dateOrder: options.dateOrder,
      createMissingStakeholders: options.createMissingStakeholders,
      createMissingShareClasses: options.createMissingShareClasses,
      defaultVestingScheduleId: options.defaultVestingScheduleId || null,
      defaultPoolId: options.defaultPoolId || null,
      skipRowsWithErrors: options.skipRowsWithErrors,
    },
    sheets: sheetPlans.filter((p) => p.include).map((p) => ({
      name: p.name, kind: p.kind, headers: p.rows[p.headerRow] ?? [], rows: p.rows.slice(p.headerRow + 1),
      mapping: p.mapping, headerRowNumber: p.headerRow + 1,
    })),
  });

  const runPreview = async (skipErrors = options.skipRowsWithErrors) => {
    setBusy(true);
    setError(null);
    try {
      const body = requestBody();
      body.options.skipRowsWithErrors = skipErrors;
      setPreview(await api<WorkbookResult>(`/c/${companyId}/imports/workbook/preview`, { body }));
      setStep('preview');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const runCommit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<WorkbookResult>(`/c/${companyId}/imports/workbook/commit`, { body: requestBody() });
      setResult(res);
      setStep('done');
      toast('Import complete');
      reloadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const saveDocument = async () => {
    if (!pdf) return;
    setBusy(true);
    setError(null);
    try {
      setStored(await uploadFile(`/c/${companyId}/documents/upload`, pdf, {
        title: docForm.title.trim() || pdf.name,
        category: docForm.category,
        folder: docForm.folder.trim() || 'General',
        stakeholderId: docForm.stakeholderId,
        securityId: docForm.securityId,
        visibility: docForm.visibility,
      }));
      setStep('done');
      toast('Document saved');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const reset = () => {
    setStep('choose'); setPlans([]); setFileName(''); setPreview(null); setResult(null); setError(null); setNote(null); setActive(0);
    setPdf(null); setDocForm(BLANK_DOCUMENT); setStored(null);
  };

  if (!canEdit) return <EmptyState title="Importing data needs an editing role" description="Ask an administrator for access." />;
  if (schemaError) return <ErrorNote error={schemaError} />;
  if (!schema) return <Loading label="Loading import options" />;

  const sampleFor = (source: MappingValue): string => {
    if (source == null) return '';
    if (typeof source !== 'number') return source.value ? `"${source.value}" on every row` : '';
    const samples: string[] = [];
    for (const r of dataRows) {
      const v = cellText(r[source]);
      if (v && !samples.includes(v)) samples.push(v);
      if (samples.length === 3) break;
    }
    return samples.join(' · ');
  };

  const steps = pdf
    ? [{ key: 'choose', label: 'Upload' }, { key: 'attach', label: 'Describe & link' }, { key: 'done', label: 'Done' }]
    : [
        { key: 'choose', label: 'Upload' }, { key: 'map', label: plans.length > 1 ? 'Sheets & columns' : 'Map columns' },
        { key: 'preview', label: 'Review' }, { key: 'done', label: 'Done' },
      ];
  const blockers = included.map((p) => ({ p, missing: missingFor(p) })).filter((x) => x.missing.length > 0);

  return (
    <>
      <PageHeader concept="import" title="Import data"
        subtitle="Bring in a cap table, stakeholders, equity awards or convertibles from a CSV, XML or Excel file — every tab of a workbook is used. A PDF is kept as a document and linked to a stakeholder or instrument"
        actions={step !== 'choose' && <Button onClick={reset}>Start over</Button>} />

      <ol className="mb-6 flex flex-wrap items-center gap-2 text-[13px]">
        {steps.map((s, i) => {
          const isActive = s.key === step;
          const done = steps.findIndex((x) => x.key === step) > i;
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span className={cx('grid size-6 place-items-center rounded-full text-[11px] font-semibold',
                isActive ? 'bg-brand-600 text-white' : done ? 'bg-secondary-100 text-secondary-800' : 'bg-ink-100 text-ink-500')}>
                {done ? <Icon name="check" className="size-3.5" /> : i + 1}
              </span>
              <span className={cx(isActive ? 'font-medium text-ink-900' : 'text-ink-500')}>{s.label}</span>
              {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-ink-200" />}
            </li>
          );
        })}
      </ol>

      {error && <div className="mb-5"><ErrorNote error={error} /></div>}

      {/* ------------------------------------------------------------------ */}
      {step === 'choose' && (
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            <Card>
              <CardHeader title="What are you importing?" subtitle="For an Excel workbook with several tabs this is only a hint — each tab is recognised on its own." />
              <div className="grid gap-3 sm:grid-cols-2">
                {schema.kinds.map((k) => (
                  <button key={k.key} onClick={() => setKind(k.key)}
                    className={cx('rounded-xl border p-4 text-left transition-colors',
                      kind === k.key ? 'border-brand-500 bg-brand-50/60 ring-2 ring-brand-500/20' : 'border-ink-200 hover:border-ink-300 hover:bg-ink-50')}>
                    <span className="flex items-center gap-2.5">
                      <span className={cx('grid size-9 place-items-center rounded-lg', kind === k.key ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-600')}>
                        <Icon name={KIND_ICONS[k.key] ?? 'document'} className="size-4.5" />
                      </span>
                      <span className="text-[14px] font-semibold text-ink-900">{k.label}</span>
                    </span>
                    <p className="mt-2 text-[12px] leading-relaxed text-ink-500">{k.description}</p>
                  </button>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader title={`Upload your ${spec?.label.toLowerCase() ?? ''} file`}
                subtitle="CSV, XML, Excel (.xlsx) or PDF. Exports from other cap table tools work — a whole workbook is imported in one go, tab by tab. A PDF is not read as a table: it is kept as a document and linked to a stakeholder or instrument." />
              <label
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void receiveFile(f); }}
                className={cx('flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors',
                  dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:border-ink-300 hover:bg-ink-50/50')}>
                <input type="file" className="hidden" accept={IMPORT_ACCEPT}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void receiveFile(f); e.target.value = ''; }} />
                {busy ? <Spinner className="size-6 text-brand-600" /> : (
                  <span className="grid size-12 place-items-center rounded-full bg-brand-50 text-brand-600"><Icon name="inbox" className="size-6" /></span>
                )}
                <span className="text-[14px] font-medium text-ink-800">{busy ? 'Reading the file…' : 'Drop a file here or click to choose'}</span>
                <span className="text-[12px] text-ink-500">Up to {schema.maxRows.toLocaleString()} rows per tab. Nothing is saved until you review and confirm.</span>
              </label>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-ink-500">
                Not sure about the columns? Download the {spec?.label.toLowerCase()} template as
                <button className="font-medium text-brand-600 hover:text-brand-700"
                  onClick={() => downloadFile(`/c/${companyId}/imports/template/${kind}`, `${kind}-template.csv`).catch((e: Error) => toast(e.message, 'error'))}>
                  CSV
                </button>
                or
                <button className="font-medium text-brand-600 hover:text-brand-700"
                  onClick={() => downloadFile(`/c/${companyId}/imports/template/${kind}?format=xml`, `${kind}-template.xml`).catch((e: Error) => toast(e.message, 'error'))}>
                  XML
                </button>
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader title="Columns for this import" />
              <ul className="space-y-2">
                {spec?.fields.map((f) => (
                  <li key={f.key} className="text-[13px]">
                    <span className="flex items-center gap-1.5">
                      <span className="font-medium text-ink-800">{f.label}</span>
                      {f.required ? <Badge tone="danger">required</Badge> : <Badge tone="neutral">{f.type}</Badge>}
                    </span>
                    {f.hint && <span className="block text-[12px] text-ink-500">{f.hint}</span>}
                  </li>
                ))}
              </ul>
            </Card>

            <Card padded={false}>
              <div className="p-5 pb-0"><CardHeader title="Import history" /></div>
              {(history ?? []).length === 0 ? <EmptyState title="No imports yet" /> : (
                <ul className="divide-y divide-ink-100">
                  {history!.slice(0, 8).map((h) => (
                    <li key={h.id} className="px-5 py-3">
                      <p className="text-[13px] font-medium text-ink-800">{kindLabel(h.kind)}</p>
                      <p className="text-[12px] text-ink-500">
                        {h.importedCount} of {h.rowCount} rows{h.fileName ? ` from ${h.fileName}` : ''} · {h.createdBy} · {dateTime(h.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {step === 'attach' && pdf && (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <Card>
            <CardHeader title="Describe the document and link it"
              subtitle="The file is kept exactly as it came. Naming the person it belongs to, and which of their instruments it covers, is what makes it findable later." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Document name" className="sm:col-span-2">
                <Input value={docForm.title} placeholder={pdf.name}
                  onChange={(e) => setDocForm({ ...docForm, title: e.target.value })} />
              </Field>
              <Field label="Category">
                <Select value={docForm.category} onChange={(e) => setDocForm({ ...docForm, category: e.target.value })}>
                  {DOCUMENT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
              <Field label="Folder">
                <Input value={docForm.folder} placeholder="General"
                  onChange={(e) => setDocForm({ ...docForm, folder: e.target.value })} />
              </Field>
              <Field label="Stakeholder" hint="Leave this empty for a document that is not about one person.">
                <Select value={docForm.stakeholderId}
                  onChange={(e) => setDocForm({
                    ...docForm, stakeholderId: e.target.value, securityId: '',
                    visibility: !e.target.value && docForm.visibility === 'HOLDER' ? 'ADMIN' : docForm.visibility,
                  })}>
                  <option value="">Not about one person</option>
                  {(stakeholders ?? []).map((sh) => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                </Select>
              </Field>
              <Field label="Instrument"
                hint={!docForm.stakeholderId ? 'Choose a stakeholder first.'
                  : instruments.length === 0 ? 'This person holds nothing yet.' : 'Optional — the certificate, grant, convertible or warrant this file covers.'}>
                <Select value={docForm.securityId} disabled={!docForm.stakeholderId || instruments.length === 0}
                  onChange={(e) => setDocForm({ ...docForm, securityId: e.target.value })}>
                  <option value="">Not about one instrument</option>
                  {instruments.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                </Select>
              </Field>
              <Field label="Who can see it" className="sm:col-span-2">
                <Select value={docForm.visibility} onChange={(e) => setDocForm({ ...docForm, visibility: e.target.value })}>
                  <option value="ADMIN">Administrators only</option>
                  <option value="HOLDER" disabled={!docForm.stakeholderId}>The linked stakeholder</option>
                  <option value="ALL">Everyone in the company</option>
                </Select>
              </Field>
            </div>
            <div className="mt-5 flex gap-2">
              <Button onClick={reset}>Back</Button>
              <Button variant="primary" className="flex-1" loading={busy} icon={<Icon name="check" />}
                onClick={() => void saveDocument()}>
                Save the document
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="The file" />
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-600">
                <Icon name="document" className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink-800">{pdf.name}</p>
                <p className="text-[12px] text-ink-500">{fileSize(pdf.size)} · PDF</p>
              </div>
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-500">
              Nothing is read out of this PDF and no rows are created from it. The bytes are stored as they are
              and can be downloaded again from the documents page, unchanged.
            </p>
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {step === 'map' && plan && (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <div className="space-y-5">
            {plans.length > 1 && (
              <Card padded={false}>
                <div className="border-b border-ink-100 p-5">
                  <h3 className="text-[15px] font-semibold">Tabs in this workbook</h3>
                  <p className="mt-0.5 text-[13px] text-ink-500">{fileName} · {plural(plans.length, 'tab')}. {note}</p>
                </div>
                <Table>
                  <thead>
                    <tr><TH width={40}></TH><TH>Tab</TH><TH align="right" width={80}>Rows</TH><TH width={210}>Import as</TH><TH>Status</TH></tr>
                  </thead>
                  <tbody>
                    {plans.map((p, i) => {
                      const missing = p.include && p.kind ? missingFor(p) : [];
                      const rows = Math.max(0, p.rows.length - p.headerRow - 1);
                      return (
                        <TR key={p.name} className={cx('cursor-pointer', i === active ? 'bg-brand-50/60' : 'hover:bg-ink-50/60', !p.include && 'text-ink-400')}
                          onClick={() => setActive(i)}>
                          <TD>
                            <input type="checkbox" className="size-4 accent-brand-600" checked={p.include} disabled={!p.kind}
                              aria-label={`Import ${p.name}`}
                              onChange={(e) => { e.stopPropagation(); updatePlan(i, { include: e.target.checked }); }} />
                          </TD>
                          <TD className="font-medium">{p.name}</TD>
                          <TD mono align="right">{rows.toLocaleString()}</TD>
                          <TD>
                            <Select value={p.kind ?? SKIP_SHEET} onClick={(e) => e.stopPropagation()}
                              onChange={(e) => { setActive(i); void replan(i, e.target.value === SKIP_SHEET ? null : e.target.value); }}>
                              <option value={SKIP_SHEET}>Skip this tab</option>
                              {schema.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                            </Select>
                          </TD>
                          <TD className="text-[12px]">
                            {!p.kind ? <span className="text-ink-500">{p.reason ?? 'Not imported'}</span>
                              : !p.include ? <Badge tone="neutral">skipped</Badge>
                              : missing.length ? <span className="text-red-700">Choose a column for {missing.join(', ')}</span>
                              : <Badge tone="success">ready</Badge>}
                          </TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </Table>
              </Card>
            )}

            <Card padded={false}>
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-100 p-5">
                <div>
                  <h3 className="text-[15px] font-semibold">{plans.length > 1 ? `Columns of “${plan.name}”` : 'Map your columns'}</h3>
                  <p className="mt-0.5 text-[13px] text-ink-500">
                    {plans.length > 1 ? '' : `${fileName} · `}{dataRows.length.toLocaleString()} data rows{plan.truncated ? ` (first ${schema.maxRows.toLocaleString()} shown)` : ''}
                    {plans.length === 1 && note ? ` · ${note}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  {plans.length === 1 && (
                    <Field label="Import as" className="w-52">
                      <Select value={plan.kind ?? kind} onChange={(e) => void replan(active, e.target.value)}>
                        {schema.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Field label="Header row" className="w-32">
                    <Select value={String(plan.headerRow)} onChange={(e) => void replan(active, plan.kind ?? kind, Number(e.target.value))}>
                      {plan.rows.slice(0, 10).map((_, i) => <option key={i} value={i}>Row {i + 1}</option>)}
                    </Select>
                  </Field>
                </div>
              </div>
              {!plan.kind ? (
                <div className="p-5 text-[13px] text-ink-500">
                  This tab is not imported{plan.reason ? ` — ${plan.reason.charAt(0).toLowerCase()}${plan.reason.slice(1)}` : ''}. Choose what it holds under “Import as” to include it.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr><TH>Field</TH><TH>Spreadsheet column</TH><TH>Sample values</TH></tr>
                  </thead>
                  <tbody>
                    {(planSpec?.fields ?? []).map((f) => {
                      const source = plan.mapping[f.key];
                      const fixed = source != null && typeof source !== 'number';
                      return (
                        <TR key={f.key}>
                          <TD>
                            <span className="flex items-center gap-1.5 font-medium">{f.label}{f.required && <span className="text-red-500">*</span>}</span>
                            {f.hint && <span className="block text-[11px] text-ink-500">{f.hint}</span>}
                          </TD>
                          <TD className="w-72">
                            <Select value={source == null ? NOT_MAPPED : fixed ? FIXED_VALUE : String(source)}
                              className={cx(f.required && !isMapped(source) && 'border-red-300')}
                              onChange={(e) => updatePlan(active, {
                                mapping: {
                                  ...plan.mapping,
                                  [f.key]: e.target.value === NOT_MAPPED ? null : e.target.value === FIXED_VALUE ? { value: '' } : Number(e.target.value),
                                },
                              })}>
                              <option value={NOT_MAPPED}>— not imported —</option>
                              {headers.map((h, i) => <option key={i} value={i}>{cellText(h) || `Column ${i + 1}`}</option>)}
                              <option value={FIXED_VALUE}>Same value for every row…</option>
                            </Select>
                            {fixed && (
                              <Input className="mt-1.5" value={source.value} placeholder={`${f.label} for every row`} autoFocus={source.value === ''}
                                onChange={(e) => updatePlan(active, { mapping: { ...plan.mapping, [f.key]: { value: e.target.value } } })} />
                            )}
                          </TD>
                          <TD className="max-w-xs truncate text-[12px] text-ink-500" title={sampleFor(source)}>
                            {source == null ? <span className="text-ink-300">—</span> : sampleFor(source) || <span className="text-ink-300">empty</span>}
                          </TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader title="Options" subtitle={plans.length > 1 ? 'Shared by every tab.' : undefined} />
              <div className="space-y-4">
                <Field label="Ambiguous dates" hint="How to read 03/04/2024.">
                  <Select value={options.dateOrder} onChange={(e) => setOptions({ ...options, dateOrder: e.target.value })}>
                    <option value="auto">Month first unless impossible (US)</option>
                    <option value="MDY">Always month / day / year</option>
                    <option value="DMY">Always day / month / year</option>
                  </Select>
                </Field>
                {included.some((p) => p.kind !== 'stakeholders') && (
                  <Checkbox label="Create stakeholders that do not exist yet" checked={options.createMissingStakeholders}
                    onChange={(v) => setOptions({ ...options, createMissingStakeholders: v })} />
                )}
                {included.some((p) => p.kind === 'captable') && (
                  <Checkbox label="Create share classes that do not exist yet" hint="Names containing “preferred” or “series” become preferred stock."
                    checked={options.createMissingShareClasses} onChange={(v) => setOptions({ ...options, createMissingShareClasses: v })} />
                )}
                {included.some((p) => p.kind === 'grants' || p.kind === 'captable') && (
                  <Field label="Default vesting schedule" hint="Used when a row has none; for certificates, leave empty for unrestricted shares.">
                    <Select value={options.defaultVestingScheduleId} onChange={(e) => setOptions({ ...options, defaultVestingScheduleId: e.target.value })}>
                      <option value="">None — rows must say</option>
                      {(schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  </Field>
                )}
                {included.some((p) => p.kind === 'grants') && (
                  <Field label="Default equity plan" hint="A plan named on the rows that does not exist yet is created.">
                    <Select value={options.defaultPoolId} onChange={(e) => setOptions({ ...options, defaultPoolId: e.target.value })}>
                      <option value="">{(pools ?? []).length === 1 ? `${pools![0].name} (only plan)` : 'None — every row must say'}</option>
                      {(pools ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  </Field>
                )}
              </div>
            </Card>
            <Card>
              <p className="text-[13px] leading-relaxed text-ink-600">
                Nothing is written yet. The next step checks every row{plans.length > 1 ? ' of every tab, in the order they will be applied (people, then certificates, grants and convertibles),' : ''} against the cap table and shows exactly what would be created.
              </p>
              {blockers.length > 0 && (
                <p className="mt-3 text-[12px] text-red-700">
                  {blockers.map((b) => `${plans.length > 1 ? `${b.p.name}: ` : ''}choose a column for ${b.missing.join(', ')}`).join(' · ')}
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <Button onClick={reset}>Back</Button>
                <Button variant="primary" className="flex-1" loading={busy} onClick={() => void runPreview()}
                  disabled={included.length === 0 || blockers.length > 0}>
                  Review {plans.length > 1 ? `${plural(included.length, 'tab')} · ` : ''}{plural(includedRows, 'row')}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {step === 'preview' && preview && (
        <WorkbookPreview result={preview} kindLabel={kindLabel} multi={plans.length > 1}
          skipErrors={options.skipRowsWithErrors}
          setSkipErrors={(v) => { setOptions({ ...options, skipRowsWithErrors: v }); void runPreview(v); }}
          onBack={() => setStep('map')} onCommit={runCommit} busy={busy} />
      )}

      {/* ------------------------------------------------------------------ */}
      {step === 'done' && stored && (
        <div className="space-y-5">
          <Banner tone="success" title="Document saved">
            “{stored.name}” was stored as it is in the {stored.folder} folder
            {stored.stakeholderId && `, linked to ${(stakeholders ?? []).find((sh) => sh.id === stored.stakeholderId)?.name ?? 'a stakeholder'}`}
            {stored.securityId && ' and one of their instruments'}
            {stored.visibility === 'HOLDER' ? ' — the linked stakeholder can see it.'
              : stored.visibility === 'ALL' ? ' — everyone in the company can see it.' : ' — only administrators can see it.'}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Link to="/documents"><Button variant="primary" icon={<Icon name="document" />}>Open documents</Button></Link>
            <Button onClick={reset} icon={<Icon name="inbox" />}>Import another file</Button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {step === 'done' && result && (
        <div className="space-y-5">
          <Banner tone="success" title="Import complete">
            {result.counts.willImport.toLocaleString()} of {result.counts.total.toLocaleString()} rows were imported
            {result.sheets.length > 1 && ` from ${plural(result.sheets.length, 'tab')}`}
            {result.counts.errors > 0 && ` — ${result.counts.errors} skipped because of errors`}
            {result.counts.skipped > 0 && ` — ${plural(result.counts.skipped, 'total or empty row')} left out`}.
          </Banner>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(result.imported).filter(([, n]) => n > 0).map(([k, n]) => (
              <Stat key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase()} value={n.toLocaleString()} />
            ))}
          </div>
          {result.sheets.length > 1 && (
            <Card>
              <CardHeader title="Tab by tab" subtitle="Applied in this order, so each tab could rely on the ones before it." />
              <ul className="divide-y divide-ink-100 text-[13px]">
                {result.sheets.map((s) => (
                  <li key={s.sheetName} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><span className="font-medium text-ink-800">{s.sheetName}</span> <span className="text-ink-500">· {kindLabel(s.kind).toLowerCase()}</span></span>
                    <span className="text-ink-600">{describeImported(s.preview.imported ?? {}, s.preview.counts)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {(result.creates.stakeholders.length > 0 || result.creates.shareClasses.length > 0 || result.creates.pools.length > 0) && (
            <Card>
              <CardHeader title="Worth a review" subtitle="These were created from the spreadsheet with sensible defaults." />
              <KeyValue columns={2} items={[
                ...(result.creates.shareClasses.length ? [{ label: 'New share classes — check terms and authorized shares',
                  value: <span>{result.creates.shareClasses.join(', ')} · <Link className="text-brand-600" to="/share-classes">Open share classes</Link></span> }] : []),
                ...(result.creates.pools.length ? [{ label: 'New equity plans — check the authorized shares against your plan documents',
                  value: <span>{result.creates.pools.join(', ')} · <Link className="text-brand-600" to="/plans">Open equity plans</Link></span> }] : []),
                ...(result.creates.stakeholders.length ? [{ label: `New stakeholders (${result.creates.stakeholders.length}) — check relationships`,
                  value: <span>{result.creates.stakeholders.slice(0, 12).join(', ')}{result.creates.stakeholders.length > 12 ? '…' : ''} · <Link className="text-brand-600" to="/stakeholders">Open stakeholders</Link></span> }] : []),
              ]} />
            </Card>
          )}
          <div className="flex flex-wrap gap-2">
            <Link to="/cap-table"><Button variant="primary" icon={<Icon name="table" />}>Open the cap table</Button></Link>
            <Button onClick={reset} icon={<Icon name="inbox" />}>Import another file</Button>
          </div>
        </div>
      )}
    </>
  );
}

function describeImported(imported: Record<string, number>, counts: Counts): string {
  const names: Record<string, [string, string]> = {
    stakeholders: ['stakeholder', 'stakeholders'], shareClasses: ['share class', 'share classes'], issuances: ['certificate', 'certificates'],
    awards: ['grant', 'grants'], convertibles: ['convertible', 'convertibles'], vestingSchedules: ['vesting schedule', 'vesting schedules'], pools: ['equity plan', 'equity plans'],
  };
  const parts = Object.entries(imported).filter(([, n]) => n > 0).map(([k, n]) => plural(n, names[k]?.[0] ?? k, names[k]?.[1]));
  if (parts.length === 0) return counts.total === 0 ? 'nothing to import' : `${counts.willImport} rows matched existing records`;
  return parts.join(', ');
}

const NUMERIC_COLUMNS = ['shares', 'price', 'strike', 'principal', 'cap', 'discount'];

function formatCell(k: string, v: Cell): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (k === 'shares') return fmtShares(v);
    if (k === 'price' || k === 'strike') return `$${v.toFixed(v < 1 ? 4 : 2)}`;
    if (k === 'principal' || k === 'cap') return fmtMoney(Math.round(v * 100), { compact: true });
    if (k === 'discount') return `${Math.round(v * 100)}%`;
    return String(v);
  }
  if (/date/i.test(k)) return date(String(v));
  return cellText(v);
}

/** Every tab's rows with their verdicts, and one confirmation for the whole file. */
function WorkbookPreview({ result, kindLabel, multi, skipErrors, setSkipErrors, onBack, onCommit, busy }: {
  result: WorkbookResult; kindLabel: (k: string | null) => string; multi: boolean;
  skipErrors: boolean; setSkipErrors: (v: boolean) => void; onBack: () => void; onCommit: () => void; busy: boolean;
}) {
  const { counts, creates } = result;
  const blocked = result.sheets.filter((s) => s.blocked);
  const canCommit = blocked.length === 0 && counts.willImport > 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={multi ? `Rows across ${plural(result.sheets.length, 'tab')}` : 'Rows'} value={counts.total.toLocaleString()} />
        <Stat label="Ready" value={counts.ok.toLocaleString()} tone="positive" />
        <Stat label="With warnings" value={counts.warnings.toLocaleString()} tone={counts.warnings ? 'warning' : 'default'} hint="Imported as-is — read the notes" />
        <Stat label="Errors" value={counts.errors.toLocaleString()} tone={counts.errors ? 'negative' : 'positive'}
          hint={counts.errors ? 'Fix the file or skip these rows' : counts.skipped ? `${plural(counts.skipped, 'total or empty row')} left out` : 'Nothing blocking'} />
      </div>

      {blocked.length > 0 && (
        <Banner tone="warning" title="Nothing is imported until every tab is clean">
          {blocked.map((s) => `“${s.sheetName}” has ${plural(s.preview.counts.errors, 'row')} with errors`).join('; ')}. Fix the file, or skip rows with errors below —
          later tabs were checked as if the blocked ones had not been applied.
        </Banner>
      )}

      {(creates.stakeholders.length > 0 || creates.shareClasses.length > 0 || creates.vestingSchedules.length > 0 || creates.pools.length > 0) && (
        <Banner tone="info" title="This import will also create">
          <ul className="list-disc space-y-0.5 pl-4">
            {creates.shareClasses.length > 0 && <li>{plural(creates.shareClasses.length, 'share class', 'share classes')}: {creates.shareClasses.join(', ')}</li>}
            {creates.pools.length > 0 && <li>{plural(creates.pools.length, 'equity plan')}: {creates.pools.join(', ')} — sized from the sheet’s “Authorized Shares” line when it has one, otherwise to the grants (see the row notes)</li>}
            {creates.stakeholders.length > 0 && <li>{plural(creates.stakeholders.length, 'stakeholder')}: {creates.stakeholders.slice(0, 8).join(', ')}{creates.stakeholders.length > 8 ? ` and ${creates.stakeholders.length - 8} more` : ''}</li>}
            {creates.vestingSchedules.length > 0 && <li>{plural(creates.vestingSchedules.length, 'vesting schedule')}: {creates.vestingSchedules.join(', ')}</li>}
          </ul>
        </Banner>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {multi ? (
          <p className="text-[13px] text-ink-600">
            Applied in this order: {result.sheets.map((s) => s.sheetName).join(' → ')} — each tab sees what the ones before it add.
          </p>
        ) : <span />}
        <Checkbox label="Skip rows with errors and import the rest" checked={skipErrors} onChange={setSkipErrors} />
      </div>

      {result.sheets.map((s) => <SheetRows key={s.sheetName} sheet={s} kindLabel={kindLabel} multi={multi} />)}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button onClick={onBack}>Back to {multi ? 'tabs & columns' : 'mapping'}</Button>
        <div className="flex items-center gap-3">
          {blocked.length > 0 && <span className="text-[13px] text-red-700">Fix the {plural(counts.errors, 'error')} or choose to skip those rows.</span>}
          <Button variant="primary" size="lg" loading={busy} disabled={!canCommit} onClick={onCommit} icon={<Icon name="check" />}>
            Import {plural(counts.willImport, 'row')}{multi ? ` from ${plural(result.sheets.length, 'tab')}` : ''}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SheetRows({ sheet, kindLabel, multi }: { sheet: SheetResult; kindLabel: (k: string | null) => string; multi: boolean }) {
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');
  const { preview } = sheet;
  const rows = preview.rows.filter((r) => filter === 'all' || r.status === filter);
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of preview.rows) for (const k of Object.keys(r.summary)) keys.add(k);
    return [...keys];
  }, [preview]);

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {multi && (
            <div>
              <h3 className="text-[14px] font-semibold text-ink-900">{sheet.sheetName}</h3>
              <p className="text-[12px] text-ink-500">
                {kindLabel(sheet.kind)} · {plural(preview.counts.willImport, 'row')} to import
                {preview.counts.skipped ? ` · ${preview.counts.skipped} left out` : ''}
                {sheet.blocked ? ' · blocked by errors' : ''}
              </p>
            </div>
          )}
          <SegmentedControl value={filter} onChange={setFilter} options={[
            { value: 'all', label: `All (${preview.counts.total})` },
            { value: 'error', label: `Errors (${preview.counts.errors})` },
            { value: 'warning', label: `Warnings (${preview.counts.warnings})` },
          ]} />
        </div>
        {sheet.blocked && <Badge tone="danger">blocked</Badge>}
      </div>
      <div className="max-h-[60vh] overflow-auto">
        <Table>
          <thead>
            <tr>
              <TH width={60}>Row</TH><TH width={90}>Status</TH>
              {columns.map((c) => <TH key={c} align={NUMERIC_COLUMNS.includes(c) ? 'right' : 'left'}>{c.replace(/([A-Z])/g, ' $1')}</TH>)}
              <TH>Notes</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.row} className={r.status === 'error' ? 'bg-red-50/40' : r.status === 'warning' ? 'bg-amber-50/30' : r.action === 'skip' ? 'text-ink-400' : undefined}>
                <TD mono className="text-ink-500">{r.row}</TD>
                <TD>
                  {r.status === 'error' ? <Badge tone="danger">error</Badge>
                    : r.status === 'warning' ? <Badge tone="warning">warning</Badge>
                    : r.action === 'skip' ? <Badge tone="neutral">skipped</Badge>
                    : r.action === 'update' ? <Badge tone="info">update</Badge> : <Badge tone="success">ready</Badge>}
                </TD>
                {columns.map((c) => (
                  <TD key={c} mono={typeof r.summary[c] === 'number'} align={NUMERIC_COLUMNS.includes(c) ? 'right' : 'left'}
                    className="max-w-[220px] truncate">{formatCell(c, r.summary[c])}</TD>
                ))}
                <TD className="max-w-md text-[12px]">
                  {r.messages.length === 0 ? <span className="text-ink-300">—</span> : (
                    <ul className="space-y-0.5">
                      {r.messages.map((m, i) => (
                        <li key={i} className={m.level === 'error' ? 'text-red-700' : m.level === 'warning' ? 'text-amber-700' : 'text-ink-500'}>{m.text}</li>
                      ))}
                    </ul>
                  )}
                </TD>
              </TR>
            ))}
            {rows.length === 0 && <TR><TD colSpan={columns.length + 3} className="py-8 text-center text-ink-500">No rows match this filter.</TD></TR>}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
