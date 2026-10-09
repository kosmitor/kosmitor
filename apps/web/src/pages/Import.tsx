/**
 * Import data: three screens on one route.
 *
 *   /import         Upload: drop one file or several (or pick them)
 *   /import/check   Check your import: the dry run of every tab, the questions it raises, Import
 *   /import/done    Done: what was added, updated, already there and left out
 *
 * The files and every answer live in this component's state while its routes
 * change (they are one element), and nowhere else: a reload lands back on
 * Upload with a note. Each file is parsed (imports/parse), every tab sorted
 * into what it holds (imports/detect), and the whole import checked
 * (imports/workbook/preview) right away, again 300 ms after any change. Import
 * sends the body that was checked, with its review token (imports/workbook/commit).
 * docs/importing.md has the API, under "Building an import page".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { api, uploadFile, useQuery, ApiError } from '../api.ts';
import { Banner, ConfirmDialog, EmptyState, ErrorNote, Loading, useToast } from '../ui.tsx';
import { ImportDropZone, TemplateMenu, type FileProblem } from '../ImportDropZone.tsx';
import { SavePdfDialog } from '../SavePdfDialog.tsx';
import { takeImportFiles, isPdf } from '../importHandoff.ts';
import { dateTime } from '../format.ts';
import { config } from '../config.ts';
import { CheckScreen, type CheckHandlers, type LeftOutRow } from './import/Check.tsx';
import { DoneScreen } from './import/Done.tsx';
import { ColumnsPanel, SettingsPanel } from './import/Panels.tsx';
import {
  DEFAULT_SETTINGS, NO_ANSWERS, NO_EDITS, isKind, mappingOf, questionsOf, requestBody, sheetNames, widthOf, withConstants,
  type Answers, type Detection, type Edits, type ImportFile, type Kind, type ParsedFile, type ParsedSheet, type Review, type RowRef,
  type Schema, type Settings, type Tab,
} from './import/model.ts';

type Step = 'upload' | 'check' | 'done';
const stepOf = (path: string): Step => (/\/import\/check\/?$/.test(path) ? 'check' : /\/import\/done\/?$/.test(path) ? 'done' : 'upload');

const SUBTITLE: Record<Kind | 'all', string> = {
  all: 'Bring in your cap table, stakeholders, grants and SAFEs from Excel or CSV.',
  stakeholders: 'Bring in your stakeholders from Excel or CSV.',
  captable: 'Bring in your cap table from Excel or CSV.',
  grants: 'Bring in your equity grants from Excel or CSV.',
  convertibles: 'Bring in your SAFEs and notes from Excel or CSV.',
};

let fileSeq = 0;
/** "data.csv" twice in one import: the second is "data (2).csv", so its tabs can be told apart. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
}

/** A failed read in the words the server chose, or the size limit, said before uploading. */
const problemOf = (file: File, err: unknown): string => {
  const message = (err as Error).message;
  return message.includes(file.name) ? message : `${file.name}: ${message}`;
};

export default function ImportData() {
  const { companyId, canEdit, canViewAll } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const search = location.search;
  const urlKind = new URLSearchParams(search).get('kind');
  const kind: Kind | null = isKind(urlKind) ? urlKind : null;
  const routeStep = stepOf(location.pathname);

  const { data: schema, error: schemaError } = useQuery<Schema>(companyId ? `/c/${companyId}/imports/schema` : null, [companyId]);
  const { data: schedules, reload: reloadSchedules } = useQuery<{ id: string; name: string }[]>(companyId ? `/c/${companyId}/vesting-schedules` : null, [companyId]);
  const { data: pools, reload: reloadPools } = useQuery<{ id: string; name: string }[]>(companyId ? `/c/${companyId}/pools` : null, [companyId]);
  const { data: history, reload: reloadHistory } = useQuery<any[]>(companyId ? `/c/${companyId}/imports` : null, [companyId]);

  const [files, setFiles] = useState<ImportFile[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS);
  // What the person saw and left as it is: kept out of the check, which it changes nothing in.
  const [dismissed, setDismissed] = useState<string[]>([]);
  // The rows "Leave out N rows" left out, which "Fix them instead" puts back.
  const [leftOutByBar, setLeftOutByBar] = useState<RowRef[]>([]);
  const [asked, setAsked] = useState<string[]>([]);
  // How many changes the person made: Back and "Choose different files" ask first when there are any.
  const [fixes, setFixes] = useState(0);
  const [nonce, setNonce] = useState(0);

  const [review, setReview] = useState<Review | null>(null);
  const [reviewBody, setReviewBody] = useState<ReturnType<typeof requestBody> | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  // Import was refused because the company (or the rows) changed since the check; the page checked again.
  const [stale, setStale] = useState(false);
  const [result, setResult] = useState<{ review: Review; files: string[]; tabs: Tab[]; why: Edits['why'] } | null>(null);

  const [reading, setReading] = useState<string | null>(null);
  const [problems, setProblems] = useState<FileProblem[]>([]);
  const [pdfs, setPdfs] = useState<File[]>([]);
  // PDFs waiting for "Save this PDF as a document", one dialog after another.
  const [pdfQueue, setPdfQueue] = useState<File[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [columnsFor, setColumnsFor] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'back' | 'different'>(null);
  // "Stay" after leaving the check: the check stays on screen until the address is back on it.
  const [holding, setHolding] = useState(false);

  const heading = useRef<HTMLHeadingElement>(null);
  const seq = useRef(0);
  const immediate = useRef(true);
  const handled = useRef(false);
  // Between a commit and the Done screen: the check is emptied before the address changes.
  const committed = useRef(false);
  // The company the files in memory were read for, and the one on screen now.
  const tabsCompany = useRef<string | null>(null);
  const currentCompany = useRef(companyId);
  currentCompany.current = companyId;
  // Only a tab's latest "what it holds" counts: its column guesses arrive in any order.
  const suggests = useRef(new Map<string, number>());
  const backNav = useRef(navType);

  const reset = useCallback(() => {
    setFiles([]); setTabs([]); setEdits(NO_EDITS); setSettings(DEFAULT_SETTINGS); setAnswers(NO_ANSWERS); setDismissed([]);
    setLeftOutByBar([]); setAsked([]); setFixes(0); setReview(null); setReviewBody(null); setCheckError(null);
    setCommitError(null); setStale(false); setProblems([]); setPdfs([]); setColumnsFor(null); setSettingsOpen(false);
    seq.current++;
    suggests.current.clear();
    tabsCompany.current = null;
  }, []);

  // Leaving the check for Upload (Back, or a link to Import data) with fixes made asks first, and the
  // check stays on screen, as it was, until the answer: decided while rendering, so it never unmounts.
  // "Stay" goes back to the check.
  const lastStep = useRef(routeStep);
  const leavingCheck = lastStep.current === 'check' && routeStep === 'upload' && navType !== 'REPLACE' && tabs.length > 0 && fixes > 0;
  useEffect(() => {
    const from = lastStep.current;
    lastStep.current = routeStep;
    if (routeStep !== 'upload') setHolding(false);
    if (from === 'check' && routeStep === 'upload' && navType !== 'REPLACE' && tabs.length > 0) {
      backNav.current = navType;
      if (fixes > 0) setConfirm('back'); else reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeStep]);
  const step: Step = confirm === 'back' || holding || leavingCheck ? 'check' : routeStep;

  // Every screen starts at the top, with focus on its heading.
  useEffect(() => {
    window.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [step, !!schema]);

  // Fixes live only in this page: closing or reloading it asks first.
  const unsaved = tabs.length > 0 && fixes > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  // Another company chosen in the sidebar: the files were read, and every answer given, for the one before.
  useEffect(() => {
    if (tabsCompany.current === null || tabsCompany.current === companyId) return;
    tabsCompany.current = null;
    reset();
    setResult(null);
    setPdfQueue([]);
    setReading(null);
    setNote('You switched company, so the import was cleared. Drop the files again to import them here.');
    navigate(`/import${search}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  /** Reads files into the import: each parsed, every tab detected, the check run at once. */
  const addFiles = useCallback(async (list: File[], mode: 'replace' | 'add') => {
    if (!schema || !companyId) return;
    const cid = companyId;
    const sheetsFiles = list.filter((f) => !isPdf(f));
    const pdfList = list.filter(isPdf);
    if (sheetsFiles.length === 0) {
      setNote(null);
      setProblems([]);
      if (pdfList.length) setPdfQueue((q) => [...q, ...pdfList]);
      return;
    }
    const known = mode === 'add' ? files : [];
    const found: FileProblem[] = [];
    const fresh = sheetsFiles.filter((f) => {
      if (known.some((k) => k.original === f.name && k.size === f.size && k.lastModified === f.lastModified)) {
        found.push({ file: f.name, message: `${f.name} is already in this import.` });
        return false;
      }
      if (f.size > schema.uploadMb * 1024 * 1024) {
        found.push({ file: f.name, message: `${f.name} is over ${schema.uploadMb} MB. Save only the tabs you need and try again.` });
        return false;
      }
      return true;
    });
    setProblems([]);
    setNote(null);
    setReading(fresh.length === 1 ? `Reading ${fresh[0].name}…` : `Reading ${fresh.length} files…`);
    const extraPdfs: File[] = [...pdfList];
    const parsed: { file: File; data: ParsedFile }[] = [];
    await Promise.all(fresh.map(async (file) => {
      try {
        parsed.push({ file, data: await uploadFile<ParsedFile>(`/c/${cid}/imports/parse`, file, {}, { quiet: true }) });
      } catch (err) {
        if (err instanceof ApiError && (err.detail as { code?: string } | undefined)?.code === 'pdf') extraPdfs.push(file);
        else found.push({ file: file.name, message: problemOf(file, err) });
      }
    }));
    if (currentCompany.current !== cid) { setReading(null); return; }
    parsed.sort((a, b) => fresh.indexOf(a.file) - fresh.indexOf(b.file));

    /** Nothing to import: the problems shown where the files were dropped. */
    const nothing = () => {
      setReading(null);
      setProblems(found.length ? found : [{ file: '', message: 'Nothing in these files could be read as a table.' }]);
      if (extraPdfs.length) setPdfQueue((q) => [...q, ...extraPdfs]);
      if (mode === 'replace' && stepOf(window.location.pathname) !== 'upload') navigate(`/import${search}`, { replace: true });
    };
    if (parsed.length === 0) { nothing(); return; }

    const taken = new Set(known.map((f) => f.name));
    const newFiles: ImportFile[] = parsed.map(({ file, data }) => {
      const name = uniqueName(file.name, taken);
      taken.add(name);
      return { id: `f${Date.now().toString(36)}-${++fileSeq}`, name, original: file.name, size: file.size, lastModified: file.lastModified, uploadId: data.uploadId ?? null };
    });
    // Each tab under the name the check reads it by: trimmed, within its length, unique in its file.
    const names = parsed.map(({ data }) => sheetNames(data.sheets.map((s) => s.name)));
    const hasRows = (s: ParsedSheet) => s.rowCount - s.headerRow - 1 > 0;
    let detections: Detection[];
    try {
      const res = await api<{ sheets: Detection[] }>(`/c/${cid}/imports/detect`, {
        quiet: true,
        body: {
          ...(kind ? { preferredKind: kind } : {}),
          sheets: parsed.flatMap(({ data }, i) => data.sheets.map((s, j) => ({
            name: names[i][j], file: newFiles[i].name, headers: s.rows[s.headerRow] ?? [], rowCount: Math.max(0, s.rowCount - s.headerRow - 1),
          }))),
        },
      });
      detections = res.sheets;
    } catch (err) {
      setReading(null);
      setProblems([{ file: '', message: (err as Error).message }]);
      return;
    }
    if (currentCompany.current !== cid) { setReading(null); return; }

    let k = 0;
    const perFile: Tab[][] = parsed.map(({ data }, i) => {
      const own = data.sheets.map(() => detections[k++]);
      const recognised = own.some((d) => d.kind);
      return data.sheets.map((s, j): Tab => {
        const d = own[j];
        // A file's only table, or a workbook none of whose tabs is recognised, is asked about rather than
        // dropped; not a tab that reads as a summary beside others (a template's "How to fill this in").
        const ask = !d.kind && hasRows(s) && (data.sheets.length === 1 || (!recognised && !/summary/i.test(d.reason ?? '')));
        return {
          key: `${newFiles[i].id}#${j}`, fileId: newFiles[i].id, file: newFiles[i].name, name: names[i][j],
          rows: s.rows, rowCount: s.rowCount, truncated: s.truncated, headerRow: s.headerRow,
          numberFormat: s.numberFormat, numberDecidedBy: s.numberDecidedBy, numberEvidence: s.numberEvidence, notices: s.notices ?? [],
          kind: d.kind, detectedKind: d.kind, reason: d.reason, mapping: withConstants(d),
          leftOut: !d.kind && !ask, ask, added: [],
        };
      });
    });
    // A file with nothing to bring in and empty tabs (a template not filled in yet) is said so, not opened.
    const empty = perFile.map((ts, i) => ts.every((t) => !t.kind && !t.ask) && parsed[i].data.sheets.some((s) => !hasRows(s)));
    empty.forEach((e, i) => {
      if (!e) return;
      const name = newFiles[i].original;
      found.push({ file: name, message: parsed[i].data.sheets.length === 1
        ? `${name} has no rows below its header. Fill it in and drop it again.`
        : `${name} has no rows yet. Fill in a tab and drop it again.` });
    });
    const keptFiles = newFiles.filter((_, i) => !empty[i]);
    const newTabs = perFile.filter((_, i) => !empty[i]).flat();
    if (keptFiles.length === 0) { nothing(); return; }

    if (mode === 'replace') {
      reset();
      setFiles(keptFiles);
      setTabs(newTabs);
      setResult(null);
    } else {
      setFiles((f) => [...f, ...keptFiles]);
      setTabs((t) => [...t, ...newTabs]);
    }
    tabsCompany.current = cid;
    setProblems(found);
    if (extraPdfs.length) setPdfs((p) => [...p, ...extraPdfs]);
    setReading(null);
    immediate.current = true;
    if (stepOf(window.location.pathname) !== 'check') navigate(`/import/check${search}`);
  }, [schema, companyId, files, kind, search, navigate, reset]);

  // Files dropped on another page (the cap table's empty state) arrive here already chosen. The
  // address becomes Upload first, so Back from the check lands there (and asks when there are fixes).
  // A check or done screen with nothing in memory was reloaded: back to Upload, with a word on why.
  useEffect(() => {
    if (!schema || !companyId || handled.current) return;
    handled.current = true;
    const handoff = takeImportFiles();
    if (handoff) {
      if (routeStep !== 'upload') navigate(`/import${search}`, { replace: true });
      void addFiles(handoff.files, 'replace');
      return;
    }
    if (routeStep !== 'upload') {
      setNote('The page was reloaded, so the file was cleared. Drop it again.');
      navigate(`/import${search}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, companyId]);
  useEffect(() => {
    if (routeStep === 'done') committed.current = false;
    if (!handled.current || reading || committed.current) return;
    if (routeStep === 'check' && tabs.length === 0 && confirm !== 'back') navigate(`/import${search}`, { replace: true });
    if (routeStep === 'done' && !result) navigate(`/import${search}`, { replace: true });
  }, [routeStep, tabs.length, result, reading, confirm, navigate, search]);

  // The check: at once after files arrive or "Check again", 300 ms after any other change.
  useEffect(() => {
    if (!schema || !companyId || tabs.length === 0 || tabsCompany.current !== companyId) return;
    const body = requestBody(tabs, files, edits, settings, answers, schema);
    const id = ++seq.current;
    setCommitError(null);
    if (body.sheets.length === 0) { setReview(null); setReviewBody(null); setChecking(false); setCheckError(null); return; }
    setChecking(true);
    const delay = immediate.current ? 0 : 300;
    immediate.current = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await api<Review>(`/c/${companyId}/imports/workbook/preview`, { body, quiet: true });
        if (id !== seq.current) return;
        setReview(res);
        setReviewBody(body);
        setCheckError(null);
        const guessed = res.newPeople.filter((x) => x.guessed).map((x) => x.key);
        if (guessed.length) setAsked((a) => [...a, ...guessed.filter((g) => !a.includes(g))]);
      } catch (err) {
        if (id === seq.current) setCheckError((err as Error).message);
      } finally {
        if (id === seq.current) setChecking(false);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [tabs, files, edits, settings, answers, nonce, schema, companyId]);

  const hasSchedules = (schedules?.length ?? 0) > 0;
  const questions = useMemo(() => (schema ? questionsOf(review, tabs, files, schema, dismissed, hasSchedules) : []),
    [review, tabs, files, schema, dismissed, hasSchedules]);

  // ---------------------------------------------------------------------------
  // What the person does
  // ---------------------------------------------------------------------------

  const fixed = () => setFixes((n) => n + 1);
  const patchTab = (key: string, patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  const fieldLabel = (t: Tab, field: string): string =>
    schema?.kinds.find((k) => k.key === t.kind)?.fields.find((f) => f.key === field)?.label ?? field;

  /** Writes values into rows for this import, adding a column (mapped to its field) for a field the file has none for. */
  const writeCells = (changes: { tab: string; row: number; field: string; value: string }[]) => {
    let nextTabs = tabs;
    const cells = { ...edits.cells };
    for (const c of changes) {
      let t = nextTabs.find((x) => x.key === c.tab);
      if (!t) continue;
      let col = mappingOf(t)[c.field];
      if (typeof col !== 'number') {
        if (c.value.trim() === '') continue;
        const fill = col && typeof col !== 'number' ? col.value : null;
        const index = widthOf(t) + t.added.length;
        t = { ...t, added: [...t.added, { field: c.field, header: fieldLabel(t, c.field), fill }], mapping: { ...t.mapping, [c.field]: index } };
        const updated = t;
        nextTabs = nextTabs.map((x) => (x.key === updated.key ? updated : x));
        col = index;
      }
      cells[c.tab] = { ...cells[c.tab], [c.row]: { ...cells[c.tab]?.[c.row], [col]: c.value.trim() === '' ? null : c.value } };
    }
    setTabs(nextTabs);
    setEdits((e) => ({ ...e, cells }));
    fixed();
  };

  /** Rows left out of this import, each with why; and put back. */
  const exclude = (rows: LeftOutRow[]) => setEdits((e) => {
    const out = { ...e.exclude };
    const why = { ...e.why };
    for (const r of rows) {
      out[r.tab] = [...(out[r.tab] ?? []).filter((x) => x !== r.row), r.row];
      why[r.tab] = { ...why[r.tab], [r.row]: r.why };
    }
    return { ...e, exclude: out, why };
  });
  const include = (rows: RowRef[]) => setEdits((e) => {
    const out = { ...e.exclude };
    const why = { ...e.why };
    for (const r of rows) {
      out[r.tab] = (out[r.tab] ?? []).filter((x) => x !== r.row);
      if (why[r.tab]) why[r.tab] = Object.fromEntries(Object.entries(why[r.tab]).filter(([row]) => Number(row) !== r.row));
    }
    return { ...e, exclude: out, why };
  });

  const on: CheckHandlers = {
    setKind: (key, k) => {
      fixed();
      const id = (suggests.current.get(key) ?? 0) + 1;
      suggests.current.set(key, id);
      if (!k) { patchTab(key, { leftOut: true, ask: false, chosen: true }); return; }
      const t = tabs.find((x) => x.key === key);
      if (!t || !companyId) return;
      api<{ mapping: Record<string, number | null>; constants: Record<string, string> }>(`/c/${companyId}/imports/suggest`,
        { body: { kind: k, headers: t.rows[t.headerRow] ?? [], sheetName: t.name }, quiet: true })
        .then((s) => { if (suggests.current.get(key) === id) patchTab(key, { kind: k, mapping: withConstants(s), leftOut: false, ask: false, chosen: true }); })
        .catch((e: Error) => toast(e.message, 'error'));
    },
    setColumn: (key, field, source) => {
      fixed();
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, mapping: { ...t.mapping, [field]: source } } : t)));
    },
    setPlan: (choice) => {
      fixed();
      setSettings((s) => ('poolId' in choice ? { ...s, defaultPoolId: choice.poolId, defaultPoolName: '' } : { ...s, defaultPoolId: '', defaultPoolName: choice.name }));
    },
    setVesting: (id) => { fixed(); setSettings((s) => ({ ...s, defaultVestingScheduleId: id })); },
    replaceValue: (q, to) => {
      fixed();
      setEdits((e) => {
        const replace = { ...e.replace };
        for (const tab of new Set(q.rows.map((r) => r.tab))) {
          replace[tab] = { ...replace[tab], [q.field]: { ...replace[tab]?.[q.field], [q.value]: to } };
        }
        return { ...e, replace };
      });
    },
    turnOn: (option) => { fixed(); setSettings((s) => ({ ...s, [option]: true })); },
    setEmail: (rows, email) => writeCells(rows.map((r) => ({ ...r, field: 'email', value: email }))),
    setDateOrder: (fileId, order) => { fixed(); setFiles((fs) => fs.map((f) => (f.id === fileId ? { ...f, dateOrder: order } : f))); },
    setNumberFormat: (fileId, format) => { fixed(); setFiles((fs) => fs.map((f) => (f.id === fileId ? { ...f, numberFormat: format } : f))); },
    raise: (fix) => {
      fixed();
      setAnswers((a) => ({ ...a, raiseAuthorized: [...a.raiseAuthorized.filter((v) => v !== fix.value), fix.value], raisedNames: { ...a.raisedNames, [fix.value]: fix.className } }));
    },
    unraise: (value) => { fixed(); setAnswers((a) => ({ ...a, raiseAuthorized: a.raiseAuthorized.filter((v) => v !== value) })); },
    dismiss: (id) => setDismissed((d) => (d.includes(id) ? d : [...d, id])),
    openColumns: setColumnsFor,
    openSettings: () => setSettingsOpen(true),
    addFiles: (list) => void addFiles(list, 'add'),
    chooseDifferent: () => { if (fixes > 0) setConfirm('different'); else { reset(); navigate(`/import${search}`); } },
    commit: () => void commit(),
    recheck: () => { immediate.current = true; setCommitError(null); setNonce((n) => n + 1); },
    leaveOutRows: (rows) => { fixed(); exclude(rows); setLeftOutByBar((b) => [...b, ...rows.map(({ tab, row }) => ({ tab, row }))]); },
    putBackLeftOut: () => { fixed(); include(leftOutByBar); setLeftOutByBar([]); },
    saveRow: (tab, row, values) => { immediate.current = true; writeCells(Object.entries(values).map(([field, value]) => ({ tab, row, field, value }))); },
    leaveOutRow: (r) => { fixed(); exclude([r]); },
    putBackRow: (tab, row) => {
      fixed();
      include([{ tab, row }]);
      setLeftOutByBar((b) => b.filter((x) => !(x.tab === tab && x.row === row)));
    },
    setRelationship: (key, relation) => { fixed(); setAnswers((a) => ({ ...a, relationships: { ...a.relationships, [key]: relation } })); },
    samePerson: (keep, others) => {
      // One already on the cap table keeps its email; otherwise the first the import met.
      const email = keep.sameName.find((s) => s.onRecord && s.email)?.email ?? keep.email ?? keep.sameName.find((s) => s.email)?.email;
      if (!email) return;
      const people = keep.email === email ? others : [keep, ...others];
      const rows = people.flatMap((p) => p.rows).flatMap((r) => {
        const t = tabs.find((x) => x.file === r.file && x.name === r.sheet);
        return t ? [{ tab: t.key, row: r.row }] : [];
      });
      writeCells(rows.map((r) => ({ ...r, field: 'email', value: email })));
      setDismissed((d) => [...d, `same:${keep.name.toLowerCase()}`]);
    },
    savePdf: (file) => setPdfQueue((q) => (q.includes(file) ? q : [...q, file])),
    dismissProblems: () => setProblems([]),
  };

  const commit = async () => {
    if (!review || !reviewBody || !companyId) return;
    setCommitting(true);
    setCommitError(null);
    setStale(false);
    try {
      const res = await api<Review>(`/c/${companyId}/imports/workbook/commit`, { body: { ...reviewBody, reviewToken: review.reviewToken } });
      const names = files.filter((f) => reviewBody.sheets.some((s) => s.file === f.name)).map((f) => f.name);
      committed.current = true;
      setResult({ review: res, files: names, tabs, why: edits.why });
      reset();
      tabsCompany.current = companyId;
      toast('Import complete');
      reloadHistory(); reloadPools(); reloadSchedules();
      navigate(`/import/done${search}`);
    } catch (err) {
      const code = err instanceof ApiError ? (err.detail as { code?: string } | undefined)?.code : undefined;
      if (code === 'stale-review' || code === 'not-reviewed') {
        // Nothing was written. The old review no longer holds: it goes, and the check runs again at once.
        setStale(true);
        setReview(null);
        setReviewBody(null);
        immediate.current = true;
        setNonce((n) => n + 1);
      } else setCommitError((err as Error).message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { setCommitting(false); }
  };

  if (!canEdit) return <EmptyState title="Importing data needs an editing role" description="Ask an administrator for access." />;
  if (schemaError) return <ErrorNote error={schemaError} />;
  if (!schema || !companyId) return <Loading label="Loading import options" />;

  const columnsTab = tabs.find((t) => t.key === columnsFor) ?? null;
  const assistant = config.ai.enabled && canViewAll;

  return (
    <>
      {step === 'upload' && (
        <UploadScreen kind={kind} heading={heading} reading={reading} problems={problems} note={note} history={history ?? []}
          onDismissNote={() => setNote(null)} onFiles={(list) => void addFiles(list, 'replace')} />
      )}
      {step === 'check' && (
        <CheckScreen schema={schema} files={files} tabs={tabs} edits={edits} answers={answers} dismissed={dismissed} review={review}
          checking={checking} checkError={checkError} commitError={commitError} stale={stale} committing={committing}
          leftOutByBar={leftOutByBar.length} kind={kind} questions={questions} askedPeople={asked} reading={reading} problems={problems} pdfs={pdfs}
          schedules={schedules ?? []} pools={pools ?? []} assistant={assistant} heading={heading} on={on} />
      )}
      {step === 'done' && result && (
        <DoneScreen result={result.review} files={result.files} tabs={result.tabs} why={result.why} kind={kind} heading={heading}
          onMore={() => { reset(); setResult(null); navigate(`/import${search}`); }} />
      )}

      <ColumnsPanel tab={columnsTab} schema={schema} companyId={companyId} onClose={() => setColumnsFor(null)}
        onApply={(key, patch) => { fixed(); patchTab(key, { ...patch, ask: false, chosen: true }); setColumnsFor(null); }} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} files={files} tabs={tabs} readAs={review?.readAs ?? []}
        settings={settings} schedules={schedules ?? []} pools={pools ?? []}
        onApply={(readings, next) => {
          fixed();
          setFiles((fs) => fs.map((f) => { const r = readings.find((x) => x.id === f.id); return r ? { ...f, dateOrder: r.dateOrder, numberFormat: r.numberFormat } : f; }));
          setSettings(next);
          setSettingsOpen(false);
        }} />
      <SavePdfDialog file={pdfQueue[0] ?? null} onClose={() => setPdfQueue((q) => q.slice(1))} onSaved={(f) => setPdfs((p) => p.filter((x) => x !== f))} />
      <ConfirmDialog open={confirm !== null} title="Leave this import?"
        message="Nothing has been saved and your fixes will be lost."
        confirmLabel="Leave" danger
        onClose={() => {
          if (confirm === 'back') { setHolding(true); navigate(backNav.current === 'POP' ? 1 : -1); }
          setConfirm(null);
        }}
        onConfirm={() => {
          const was = confirm;
          setConfirm(null);
          reset();
          if (was === 'different') navigate(`/import${search}`);
        }} />
    </>
  );
}

/** Upload: the drop zone first, then the templates and the imports made before. */
function UploadScreen({ kind, heading, reading, problems, note, history, onDismissNote, onFiles }: {
  kind: Kind | null; heading: RefObject<HTMLHeadingElement | null>; reading: string | null; problems: FileProblem[];
  note: string | null; history: any[]; onDismissNote: () => void; onFiles: (files: File[]) => void;
}) {
  // The import history has a row per tab; the tabs of one import were written together, by one person.
  const past = useMemo(() => {
    const groups: { files: string[]; rows: number; at: string; by: string }[] = [];
    for (const h of history) {
      const file = String(h.fileName ?? '').split(' › ')[0] || 'A file';
      const last = groups.at(-1);
      if (last && last.by === h.createdBy && Math.abs(Date.parse(last.at) - Date.parse(h.createdAt)) < 10_000) {
        if (!last.files.includes(file)) last.files.push(file);
        last.rows += Number(h.importedCount ?? 0);
      } else groups.push({ files: [file], rows: Number(h.importedCount ?? 0), at: h.createdAt, by: h.createdBy ?? '' });
    }
    return groups;
  }, [history]);

  return (
    <div className="mx-auto max-w-[720px]">
      <h1 ref={heading} tabIndex={-1} className="text-[22px] font-semibold tracking-[-0.01em] text-ink-900 outline-none">Import data</h1>
      <p className="mt-1 text-sm text-ink-500">{SUBTITLE[kind ?? 'all']} You check every row before anything is saved.</p>
      {note && <div className="mt-4"><Banner tone="info" onDismiss={onDismissNote}>{note}</Banner></div>}
      <div className="mt-5">
        <ImportDropZone onFiles={onFiles} kind={kind} busy={reading} problems={problems} />
      </div>
      <p className="mt-3 text-[13px] text-ink-500">Starting from scratch? <TemplateMenu kind={kind} /></p>
      {past.length > 0 && (
        <details className="group mt-8">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded text-[13px] font-medium text-ink-600 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-brand-500 [&::-webkit-details-marker]:hidden">
            <svg viewBox="0 0 24 24" className="size-4 -rotate-90 transition-transform group-open:rotate-0" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="m7 10 5 5 5-5" /></svg>
            Past imports ({past.length})
          </summary>
          <ul className="mt-2 divide-y divide-ink-100 rounded-xl border border-ink-200/70 bg-white text-[13px]">
            {past.slice(0, 20).map((p, i) => (
              <li key={i} className="px-4 py-2.5 text-ink-700">
                <span className="font-medium text-ink-900">{p.files.join(' + ')}</span>
                <span className="text-ink-500"> · {p.rows.toLocaleString()} {p.rows === 1 ? 'row' : 'rows'} · {dateTime(p.at)}{p.by ? ` · ${p.by}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
