/**
 * The import page with an Open Cap Format package (docs/importing.md, "OCF packages"):
 * the shapes parse sends for a package, how the files dropped together make one
 * package, the body the check and the import send, the questions the check asks,
 * and the left-out rows as a CSV. Pure functions, so the node tests can run them
 * (apps/web/test/ocf-import.test.ts): this module imports nothing but types.
 */
import type { Notice, PreviewRow, Review } from './model.ts';

export type OcfSection = 'stakeholders' | 'shareClasses' | 'plans' | 'vesting' | 'valuations' | 'captable' | 'grants' | 'warrants' | 'convertibles' | 'events';
/** The sections in the order they are applied, as the check returns them. */
export const OCF_SECTIONS: OcfSection[] = ['stakeholders', 'shareClasses', 'plans', 'vesting', 'valuations', 'captable', 'grants', 'warrants', 'convertibles', 'events'];
export const isOcfSection = (v: unknown): v is OcfSection => typeof v === 'string' && (OCF_SECTIONS as string[]).includes(v);

export const OCF_SECTION_WORDS: Record<OcfSection, { title: string; one: string; many: string }> = {
  stakeholders: { title: 'Stakeholders', one: 'stakeholder', many: 'stakeholders' },
  shareClasses: { title: 'Share classes', one: 'share class', many: 'share classes' },
  plans: { title: 'Equity plans', one: 'equity plan', many: 'equity plans' },
  vesting: { title: 'Vesting schedules', one: 'vesting schedule', many: 'vesting schedules' },
  valuations: { title: 'Valuations', one: 'valuation', many: 'valuations' },
  captable: { title: 'Certificates', one: 'certificate', many: 'certificates' },
  grants: { title: 'Equity grants', one: 'grant', many: 'grants' },
  warrants: { title: 'Warrants', one: 'warrant', many: 'warrants' },
  convertibles: { title: 'SAFEs & notes', one: 'SAFE or note', many: 'SAFEs & notes' },
  events: { title: 'History', one: 'event', many: 'events' },
};

/** A transaction's object_type in a word or two, for the History section. */
export const OCF_EVENT_LABELS: Record<string, string> = {
  TX_STOCK_ISSUANCE: 'Issuance', TX_STOCK_TRANSFER: 'Transfer', TX_STOCK_REPURCHASE: 'Repurchase', TX_STOCK_CANCELLATION: 'Cancellation',
  TX_STOCK_CONVERSION: 'Conversion', TX_STOCK_REISSUANCE: 'Re-issue', TX_STOCK_RETRACTION: 'Retraction', TX_STOCK_ACCEPTANCE: 'Acceptance',
  TX_EQUITY_COMPENSATION_ISSUANCE: 'Grant', TX_EQUITY_COMPENSATION_EXERCISE: 'Exercise', TX_EQUITY_COMPENSATION_RELEASE: 'Release',
  TX_EQUITY_COMPENSATION_CANCELLATION: 'Cancellation', TX_EQUITY_COMPENSATION_TRANSFER: 'Transfer', TX_EQUITY_COMPENSATION_RETRACTION: 'Retraction',
  TX_EQUITY_COMPENSATION_ACCEPTANCE: 'Acceptance', TX_PLAN_SECURITY_ISSUANCE: 'Grant', TX_PLAN_SECURITY_EXERCISE: 'Exercise',
  TX_PLAN_SECURITY_RELEASE: 'Release', TX_PLAN_SECURITY_CANCELLATION: 'Cancellation', TX_PLAN_SECURITY_TRANSFER: 'Transfer',
  TX_PLAN_SECURITY_RETRACTION: 'Retraction', TX_PLAN_SECURITY_ACCEPTANCE: 'Acceptance',
  TX_WARRANT_ISSUANCE: 'Warrant', TX_WARRANT_EXERCISE: 'Exercise', TX_WARRANT_CANCELLATION: 'Cancellation', TX_WARRANT_TRANSFER: 'Transfer',
  TX_WARRANT_RETRACTION: 'Retraction', TX_WARRANT_ACCEPTANCE: 'Acceptance',
  TX_CONVERTIBLE_ISSUANCE: 'SAFE or note', TX_CONVERTIBLE_CONVERSION: 'Conversion', TX_CONVERTIBLE_CANCELLATION: 'Cancellation',
  TX_CONVERTIBLE_TRANSFER: 'Transfer', TX_CONVERTIBLE_RETRACTION: 'Retraction', TX_CONVERTIBLE_ACCEPTANCE: 'Acceptance',
  TX_STOCK_CLASS_SPLIT: 'Stock split', TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT: 'Authorized shares', TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT: 'Conversion ratio',
  TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT: 'Company authorized shares', TX_STOCK_PLAN_POOL_ADJUSTMENT: 'Plan size', TX_STOCK_PLAN_RETURN_TO_POOL: 'Return to plan',
  TX_VESTING_START: 'Vesting start', TX_VESTING_EVENT: 'Vesting event', TX_VESTING_ACCELERATION: 'Acceleration',
};
export const eventLabel = (objectType: string | null | undefined): string =>
  (objectType ? OCF_EVENT_LABELS[objectType] ?? objectType.replace(/^TX_/, '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');

// ---------------------------------------------------------------------------
// What parse sends
// ---------------------------------------------------------------------------

export interface OcfFileSummary { path: string; fileType: string; items: number; checksum: 'ok' | 'mismatch' | 'none'; md5: string | null }
export interface OcfIssuer { id: string | null; legalName: string | null; dba: string | null }
export interface OcfPackageFile { path: string; md5: string | null; content: Record<string, unknown> }
export interface OcfPackageBody { manifestPath: string | null; manifest: Record<string, unknown> | null; files: OcfPackageFile[] }
export interface OcfParse {
  part: 'package' | 'manifest' | 'file';
  version: string | null;
  fileType: string | null;
  issuer: OcfIssuer | null;
  asOf: string | null;
  generatedAt: string | null;
  files: OcfFileSummary[];
  missing: string[];
  counts: Record<string, number>;
  notices: Notice[];
  package: OcfPackageBody;
}

/** The check's OCF part (Review.ocf). */
export interface OcfReview {
  file: string; version: string | null; issuer: OcfIssuer | null; asOf: string | null; generatedAt: string | null;
  files: OcfFileSummary[]; notices: Notice[]; notImported: { what: string; count: number; reason: string }[];
  /** The company's fields the issuer's details fill in: empty ones, and a new company's defaults. */
  companyFill: { field: string; value: string }[];
  /** The package is another company's: the fields go in only when the person says so (options.ocfCompanyFill). */
  companyFillAsked: boolean;
  /** Whether this check writes them. */
  companyFillApplied: boolean;
  /** Share classes on file that take the package's terms (a new company's Common, nothing issued from it yet). */
  classUpdates: string[];
}

/** One package the page holds: the name it goes under, what parse said, the package itself, and spreadsheets dropped with it (not read). */
export interface OcfState {
  name: string;
  uploadIds: string[];
  info: OcfParse;
  pkg: OcfPackageBody;
  leftAside: string[];
}

// ---------------------------------------------------------------------------
// Files dropped together make one package
// ---------------------------------------------------------------------------

/** The manifest's list of each kind of file. */
const LISTS: Record<string, string> = {
  stakeholders_files: 'OCF_STAKEHOLDERS_FILE', stock_classes_files: 'OCF_STOCK_CLASSES_FILE', stock_legend_templates_files: 'OCF_STOCK_LEGEND_TEMPLATES_FILE',
  stock_plans_files: 'OCF_STOCK_PLANS_FILE', vesting_terms_files: 'OCF_VESTING_TERMS_FILE', valuations_files: 'OCF_VALUATIONS_FILE',
  transactions_files: 'OCF_TRANSACTIONS_FILE', financings_files: 'OCF_FINANCINGS_FILE', documents_files: 'OCF_DOCUMENTS_FILE',
};
const KIND_WORDS: Record<string, string> = {
  OCF_STAKEHOLDERS_FILE: 'stakeholders', OCF_STOCK_CLASSES_FILE: 'share classes', OCF_STOCK_LEGEND_TEMPLATES_FILE: 'legends',
  OCF_STOCK_PLANS_FILE: 'equity plans', OCF_VESTING_TERMS_FILE: 'vesting terms', OCF_VALUATIONS_FILE: 'valuations', OCF_TRANSACTIONS_FILE: 'transactions',
  OCF_FINANCINGS_FILE: 'financings', OCF_DOCUMENTS_FILE: 'documents', OCF_MANIFEST_FILE: 'manifest',
};
const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;
const clean = (p: string): string => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** One parsed file of the drop: the name it was uploaded under and what parse said. */
export interface OcfPart { name: string; uploadId: string | null; ocf: OcfParse }

/**
 * The parts parse returned for the files dropped together, as one package: a .ocf.zip
 * on its own, or a manifest and the files it lists (each found by its name, else by its
 * kind). Anything else is a problem to show where the files were dropped.
 */
export function mergeOcfParts(parts: OcfPart[]): { ok: true; name: string; uploadIds: string[]; info: OcfParse; pkg: OcfPackageBody } | { ok: false; problem: string } {
  const packages = parts.filter((p) => p.ocf.part === 'package');
  const manifests = parts.filter((p) => p.ocf.part === 'manifest');
  const files = parts.filter((p) => p.ocf.part === 'file');
  const ids = (list: OcfPart[]) => list.map((p) => p.uploadId).filter((x): x is string => !!x);
  if (packages.length + manifests.length > 1 || (packages.length === 1 && files.length > 0)) return { ok: false, problem: 'Drop one OCF package at a time.' };
  if (packages.length === 1) return { ok: true, name: packages[0].name, uploadIds: ids(packages), info: packages[0].ocf, pkg: packages[0].ocf.package };
  if (manifests.length === 0) {
    if (files.length === 1) {
      const kind = KIND_WORDS[files[0].ocf.fileType ?? ''] ?? 'a part';
      return { ok: false, problem: `This is one file of an OCF package (${kind}). Drop the whole .ocf.zip, or all of its files with the manifest.` };
    }
    return { ok: false, problem: 'These are files of an OCF package without its manifest. Drop the whole .ocf.zip, or all of its files with the manifest.' };
  }
  const m = manifests[0];
  const manifest = m.ocf.package.manifest ?? {};
  const wanted: { fileType: string; path: string; md5: string | null }[] = [];
  for (const [list, fileType] of Object.entries(LISTS)) {
    const refs = manifest[list];
    if (!Array.isArray(refs)) continue;
    for (const ref of refs as { filepath?: unknown; md5?: unknown }[]) {
      if (typeof ref?.filepath === 'string') wanted.push({ fileType, path: clean(ref.filepath), md5: typeof ref.md5 === 'string' ? ref.md5.toLowerCase() : null });
    }
  }
  const used = new Set<OcfPart>();
  const out: OcfPackageFile[] = [];
  const summaries: OcfFileSummary[] = [];
  const missing: string[] = [];
  // By name first, so one found by its kind never takes another's.
  const found = wanted.map((w) => {
    const f = files.find((x) => !used.has(x) && baseName(x.name).toLowerCase() === baseName(w.path).toLowerCase() && x.ocf.fileType === w.fileType);
    if (f) used.add(f);
    return f;
  });
  wanted.forEach((w, i) => {
    const f = found[i] ?? files.find((x) => !used.has(x) && x.ocf.fileType === w.fileType && !wanted.some((v) => baseName(v.path).toLowerCase() === baseName(x.name).toLowerCase()));
    if (!f) { missing.push(baseName(w.path)); return; }
    used.add(f);
    const file = f.ocf.package.files[0];
    out.push({ path: w.path, md5: file?.md5 ?? null, content: file?.content ?? {} });
    const summary = f.ocf.files[0];
    summaries.push({ path: w.path, fileType: w.fileType, items: summary?.items ?? 0, md5: file?.md5 ?? null,
      checksum: !w.md5 || !file?.md5 ? 'none' : w.md5 === file.md5 ? 'ok' : 'mismatch' });
  });
  if (missing.length) {
    return { ok: false, problem: `This OCF package is missing ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`}. Drop the .ocf.zip, or the manifest with all of its files.` };
  }
  // Files the manifest does not list go along: the check says they are not read.
  for (const f of files) if (!used.has(f) && f.ocf.package.files[0]) out.push({ ...f.ocf.package.files[0], path: clean(f.name) });
  const counts: Record<string, number> = {};
  for (const f of files.filter((x) => used.has(x))) for (const [k, n] of Object.entries(f.ocf.counts)) counts[k] = (counts[k] ?? 0) + n;
  return {
    ok: true, name: m.name, uploadIds: ids([m, ...files]),
    info: { ...m.ocf, part: 'package', files: summaries, missing: [], counts },
    pkg: { manifestPath: clean(m.name), manifest, files: out },
  };
}

// ---------------------------------------------------------------------------
// The check and the import
// ---------------------------------------------------------------------------

/** What the person answered: relationships for people the package creates, raises, and who each package person is. */
export interface OcfAnswers {
  relationships: Record<string, string>;
  raiseAuthorized: string[];
  /** Package stakeholder id → a stakeholder of this company, or 'new'. */
  ocfPeople: Record<string, string>;
  /** Whether the issuer's details go into the company: null leaves it to the server (yes, unless the package is another company's). */
  ocfCompanyFill?: boolean | null;
}

/** The body of imports/workbook/preview (and commit, with the review's token) for a package. */
export function ocfRequestBody(state: OcfState, exclude: Record<string, number[]>, answers: OcfAnswers) {
  const leftOut = Object.fromEntries(Object.entries(exclude).filter(([k, v]) => isOcfSection(k) && v.length).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
  return {
    uploadIds: state.uploadIds,
    ocf: { file: state.name, package: state.pkg, ...(Object.keys(leftOut).length ? { exclude: leftOut } : {}) },
    options: {
      ...(Object.keys(answers.relationships).length ? { relationships: answers.relationships } : {}),
      ...(answers.raiseAuthorized.length ? { raiseAuthorized: answers.raiseAuthorized } : {}),
      ...(Object.keys(answers.ocfPeople).length ? { ocfPeople: answers.ocfPeople } : {}),
      ...(answers.ocfCompanyFill != null ? { ocfCompanyFill: answers.ocfCompanyFill } : {}),
    },
  };
}

/** A question the check asks about a package: who a person is, or a notice about the cap table after it. */
export type OcfQuestion =
  | { type: 'ocf-person'; id: string; ocfId: string; name: string; item: number; people: { id: string; name: string; email: string | null }[] }
  | { type: 'notice'; id: string; notice: Notice };

/** Every question of a package's check, the people first. `dismissed` holds the notices the person left as they are. */
export function ocfQuestionsOf(review: Review | null, dismissed: string[]): OcfQuestion[] {
  if (!review) return [];
  const out: OcfQuestion[] = [];
  for (const s of review.sheets) {
    if (s.kind !== 'stakeholders') continue;
    for (const r of s.preview.rows) {
      const m = r.messages.find((x) => x.code === 'ambiguous-person');
      if (!m || !r.ocfId) continue;
      out.push({ type: 'ocf-person', id: `ocf-person:${r.ocfId}`, ocfId: r.ocfId, name: String(r.summary.stakeholder ?? ''), item: r.row, people: m.people ?? [] });
    }
  }
  for (const n of review.notices) {
    const id = `notice:${n.fix?.value ?? n.text}`;
    if (!dismissed.includes(id)) out.push({ type: 'notice', id, notice: n });
  }
  return out;
}

/** A row with an error of its own, which "Leave out N rows" leaves out: not one that waits for another, nor one a question answers. */
export const ocfNeedsOwnFix = (r: PreviewRow): boolean =>
  r.status === 'error' && r.messages.some((m) => m.level === 'error' && m.code !== 'ocf-depends' && m.code !== 'ambiguous-person');

/** A row that only waits for another's fix: "Waits for item N". */
export const ocfWaits = (r: PreviewRow): boolean => r.status === 'error' && !ocfNeedsOwnFix(r) && r.messages.some((m) => m.code === 'ocf-depends');

/**
 * How many rows of a package would go in once every row with a problem is fixed or left
 * out. A package goes in whole or not at all, so while any section is blocked nothing is
 * ready yet: every row that would be added or updated waits.
 */
export function ocfPending(review: Review | null): { ready: number; pending: number } {
  if (!review) return { ready: 0, pending: 0 };
  if (!review.sheets.some((s) => s.blocked)) return { ready: review.counts.willImport, pending: 0 };
  const pending = review.sheets.reduce((n, s) => n + s.preview.rows.filter((r) => r.status !== 'error' && (r.outcome === 'add' || r.outcome === 'update')).length, 0);
  return { ready: 0, pending };
}

/** "EIN, address and incorporation date". */
export const fieldList = (fields: { field: string }[]): string =>
  (fields.length > 1 ? `${fields.slice(0, -1).map((f) => f.field).join(', ')} and ${fields.at(-1)!.field}` : fields[0]?.field ?? '');

/** A row's summary in a line, its values in order: "Ana Brightly · Common · 1000 · 2021-02-01". */
const summaryLine = (r: PreviewRow): string => Object.values(r.summary).filter((v) => v !== null && v !== '').map(String).join(' · ');

/** A CSV cell, quoted when it must be, and text a spreadsheet would run as a formula kept as text. */
function csv(v: string | number): string {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The rows of a package that did not go in (left out, or with errors under "Leave out N
 * rows"), as a CSV: Section, Item, OCF id, Object, Summary, Problem.
 */
export function ocfLeftOutCsv(review: Review, why: Record<string, Record<number, string>> = {}): string {
  const lines = [['Section', 'Item', 'OCF id', 'Object', 'Summary', 'Problem'].map(csv).join(',')];
  for (const s of review.sheets) {
    if (!isOcfSection(s.kind)) continue;
    for (const r of s.preview.rows) {
      if (r.outcome !== 'excluded' && r.status !== 'error') continue;
      const problem = r.messages.filter((m) => m.level === 'error').map((m) => m.text).join(' ')
        || why[s.kind]?.[r.row] || r.messages.find((m) => m.code === 'ocf-excluded-with')?.text || 'Left out by you';
      lines.push([OCF_SECTION_WORDS[s.kind].title, r.row, r.ocfId ?? '', r.object ?? '', summaryLine(r), problem].map(csv).join(','));
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
