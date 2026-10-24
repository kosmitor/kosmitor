/**
 * Reading an Open Cap Format package that someone drops on the import page
 * (docs/importing.md, "OCF packages").
 *
 * A package is a manifest and the files it lists: a .ocf.zip, or the JSON files
 * dropped together (the page combines a loose manifest with its files). Every
 * byte is untrusted: the zip is opened with the import's unpacking limit and only
 * its .json entries are unpacked, the JSON is bounded in size, depth and object
 * count, keys that could reach an object's prototype are dropped, and file paths
 * are only ever compared, never opened.
 *
 * `readOcfUpload` is the parse step for one uploaded file; `readOcfPackage` reads
 * the package body the page sends back with the check and the import, the same
 * way, so the server trusts nothing the page kept in between. Refusals are
 * `OcfRefusal`s with the code the page shows them by.
 */
import { createHash } from 'node:crypto';
import { openZip, ZipTooLarge } from '../import/xlsx.ts';
import { config, megabytes } from '../config.ts';
import type { Notice } from '../import/engine.ts';
import { OCF_MANIFEST_LISTS, type OcfFileType } from './types.ts';

/** The parts of a package the check shows, each a table of its own, in the order they are applied. */
export type OcfSection = 'stakeholders' | 'shareClasses' | 'plans' | 'vesting' | 'valuations' | 'captable' | 'grants' | 'warrants' | 'convertibles' | 'events';
export const OCF_SECTIONS: OcfSection[] = ['stakeholders', 'shareClasses', 'plans', 'vesting', 'valuations', 'captable', 'grants', 'warrants', 'convertibles', 'events'];
export const SECTION_TITLES: Record<OcfSection, string> = {
  stakeholders: 'Stakeholders', shareClasses: 'Share classes', plans: 'Equity plans', vesting: 'Vesting schedules', valuations: 'Valuations',
  captable: 'Certificates', grants: 'Equity grants', warrants: 'Warrants', convertibles: 'SAFEs & notes', events: 'History',
};
export const isOcfSection = (v: unknown): v is OcfSection => typeof v === 'string' && (OCF_SECTIONS as string[]).includes(v);

/** A package refused as a whole, with the code the page shows it by. */
export class OcfRefusal extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/** One file of a package as the page sends it back: where it was, the MD5 of its bytes as uploaded, and its JSON. */
export interface OcfPackageFile { path: string; md5: string | null; content: Record<string, unknown> }
/** A package as parse hands it to the page and the page sends it back with the check and the import. */
export interface OcfPackageBody { manifestPath: string | null; manifest: Record<string, unknown> | null; files: OcfPackageFile[] }

export interface OcfFileSummary { path: string; fileType: string; items: number; checksum: 'ok' | 'mismatch' | 'none'; md5: string | null }
export interface OcfIssuerSummary { id: string | null; legalName: string | null; dba: string | null }

/** What parse says about an OCF file: a whole package, a loose manifest, or one loose file of a package. */
export interface OcfParse {
  part: 'package' | 'manifest' | 'file';
  version: string | null;
  /** The file_type of a loose file. */
  fileType: string | null;
  issuer: OcfIssuerSummary | null;
  asOf: string | null;
  generatedAt: string | null;
  files: OcfFileSummary[];
  /** A loose manifest's files, as it lists them: the page looks for them among the files dropped with it. */
  missing: string[];
  counts: Record<OcfSection | 'transactions', number>;
  notices: Notice[];
  package: OcfPackageBody;
}

/** The OCF part of the check's answer (WorkbookResult.ocf). */
export interface OcfSummary {
  file: string;
  version: string | null;
  issuer: OcfIssuerSummary | null;
  asOf: string | null;
  generatedAt: string | null;
  files: OcfFileSummary[];
  notices: Notice[];
  /** What the package holds that the import does not bring in, and why. */
  notImported: { what: string; count: number; reason: string }[];
  /** The company's fields the issuer fills in: empty ones, and a new company's defaults. */
  companyFill: { field: string; value: string }[];
  /** The package is another company's, so the fields go in only when the person says so (options.ocfCompanyFill). */
  companyFillAsked: boolean;
  /** Whether this check writes them. */
  companyFillApplied: boolean;
  /** Share classes on file the package's terms update (a new company's Common, nothing issued from it yet). */
  classUpdates: string[];
}

/** What the check and the import are asked to do with a package (WorkbookExtras.ocf). */
export interface OcfRun {
  /** The name the package was uploaded under. */
  file: string;
  pkg: OcfPackageBody;
  /** Rows the person left out, by section and item number. */
  exclude: Partial<Record<OcfSection, number[]>>;
  relationships?: Record<string, string>;
  /** Who each stakeholder of the package is: a stakeholder of this company by id, or 'new'. Keyed by the package's stakeholder id. */
  ocfPeople?: Map<string, string>;
  skipRowsWithErrors?: boolean;
  /** Whether the issuer's details fill in the company's (options.ocfCompanyFill); unset, they do unless the package is another company's. */
  companyFill?: boolean;
}

/** A package as read: its manifest and the files it lists, resolved. */
export interface OcfPackageRead {
  version: string;
  manifest: Record<string, unknown>;
  issuer: OcfIssuerSummary | null;
  asOf: string | null;
  generatedAt: string | null;
  /** The files the manifest lists, found, in the manifest's order, with their items. */
  files: (OcfFileSummary & { content: Record<string, unknown> })[];
  notices: Notice[];
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** No OCF object nests deeper than a dozen levels; a file that does is not one. */
const MAX_DEPTH = 64;
/** The most files a package may have. */
export const MAX_FILES = 200;
const MAX_PATH = 512;

/**
 * Checks parsed JSON for depth and drops `__proto__` keys (JSON.parse keeps them as
 * own properties, which a later copy could turn into a prototype), without
 * recursion, so a deeply nested file cannot exhaust the stack. Returns false when
 * the value nests too deeply.
 */
export function tidyJson(value: unknown): boolean {
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
  while (stack.length) {
    const { v, depth } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth >= MAX_DEPTH) return false;
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === 'object') stack.push({ v: x, depth: depth + 1 });
      continue;
    }
    if (Object.hasOwn(v, '__proto__')) delete (v as Record<string, unknown>)['__proto__'];
    for (const x of Object.values(v)) if (x !== null && typeof x === 'object') stack.push({ v: x, depth: depth + 1 });
  }
  return true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const base = (path: string): string => path.split('/').pop() ?? path;
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A path within the package with `.` and `..` worked out and backslashes as slashes; null when it climbs out. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/** A manifest's file path, read against the manifest's own folder. */
function resolvePath(manifestPath: string | null, filepath: string): string | null {
  const dir = manifestPath && manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
  return filepath.startsWith('/') ? normalizePath(filepath) : normalizePath(`${dir}${filepath}`);
}

const VERSION = /^1\.(\d+)(?:\.(\d+))?/;
function checkVersion(v: unknown, notices: Notice[]): string {
  const version = typeof v === 'string' ? v.trim().slice(0, 40) : '';
  const m = VERSION.exec(version);
  if (!m) throw new OcfRefusal('ocf-version', `This package is OCF ${version || 'of no stated version'}; Kosmitor reads OCF 1.x.`, { version: version || null });
  if (Number(m[1]) < 2) {
    notices.push({ code: 'ocf-version-older', level: 'info', text: `This package is OCF ${version}, older than 1.2.0: it is read as 1.2.0, and anything 1.2.0 no longer has is left out.` });
  }
  return version;
}

function issuerOf(manifest: Record<string, unknown>): OcfIssuerSummary | null {
  const i = manifest.issuer;
  if (!isRecord(i)) return null;
  return { id: str(i.id), legalName: str(i.legal_name), dba: str(i.dba) };
}

const dateOr = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 40) : null);

/** The number of items of a file, whatever is in them. */
const itemsOf = (content: Record<string, unknown>): unknown[] => (Array.isArray(content.items) ? content.items : []);

const LISTED_TYPES = Object.entries(OCF_MANIFEST_LISTS) as [Exclude<OcfFileType, 'OCF_MANIFEST_FILE'>, string][];
const FILE_WORDS: Partial<Record<OcfFileType, string>> = {
  OCF_FINANCINGS_FILE: 'financing', OCF_DOCUMENTS_FILE: 'document',
};

/**
 * The manifest's files found among `entries`: by the path it gives, read against the
 * manifest's folder, else by an entry of the same file_type that nothing lists
 * (notice ocf-path-resolved). A file it lists and the package does not have is
 * refused (ocf-missing-file) unless `missing` collects it. Entries of an OCF type
 * that the manifest does not list are left unread, with a notice.
 */
function resolveFiles(manifestPath: string | null, manifest: Record<string, unknown>, entries: OcfPackageFile[], notices: Notice[], missing: string[] | null): OcfPackageRead['files'] {
  const typeOf = (e: OcfPackageFile): string | null => str(e.content.file_type);
  const byPath = new Map(entries.map((e) => [normalizePath(e.path) ?? e.path, e]));
  const taken = new Set<OcfPackageFile>();
  const wanted: { fileType: string; filepath: string; md5: string | null; path: string | null }[] = [];
  for (const [fileType, list] of LISTED_TYPES) {
    const refs = manifest[list];
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (!isRecord(ref) || typeof ref.filepath !== 'string' || ref.filepath.length > MAX_PATH) continue;
      wanted.push({ fileType, filepath: ref.filepath, md5: typeof ref.md5 === 'string' ? ref.md5.toLowerCase() : null, path: resolvePath(manifestPath, ref.filepath) });
    }
  }
  // Every file found by its path first, so one found by its type never takes another's.
  const found = new Map<number, OcfPackageFile>();
  wanted.forEach((w, i) => {
    const e = w.path != null ? byPath.get(w.path) : undefined;
    if (e && !taken.has(e) && typeOf(e) === w.fileType) { found.set(i, e); taken.add(e); }
  });
  wanted.forEach((w, i) => {
    if (found.has(i)) return;
    const listedPaths = new Set(wanted.map((x) => x.path));
    const e = entries.find((x) => !taken.has(x) && typeOf(x) === w.fileType && !listedPaths.has(normalizePath(x.path) ?? x.path));
    if (e) {
      found.set(i, e);
      taken.add(e);
      notices.push({ code: 'ocf-path-resolved', level: 'info', text: `The manifest lists ${w.filepath}; ${e.path} was read for it (the same kind of file).` });
    } else if (missing) {
      missing.push(w.path ?? w.filepath);
    } else {
      throw new OcfRefusal('ocf-missing-file', `The manifest lists ${base(w.filepath)}, which is not in the package.`, { file: w.filepath });
    }
  });
  const unlisted = entries.filter((e) => { const t = typeOf(e); return !taken.has(e) && !!t && t !== 'OCF_MANIFEST_FILE' && t.startsWith('OCF_'); }).map((e) => e.path);
  if (unlisted.length) {
    notices.push({ code: 'ocf-unlisted-file', level: 'info', text: `${listOf(unlisted)} ${unlisted.length === 1 ? 'is an OCF file' : 'are OCF files'} the manifest does not list, so ${unlisted.length === 1 ? 'it is' : 'they are'} not read.` });
  }
  const out: OcfPackageRead['files'] = [];
  const mismatched: string[] = [];
  wanted.forEach((w, i) => {
    const e = found.get(i);
    if (!e) return;
    const items = itemsOf(e.content);
    const checksum = !w.md5 || !e.md5 ? 'none' : w.md5 === e.md5 ? 'ok' : 'mismatch';
    if (checksum === 'mismatch') mismatched.push(e.path);
    const word = FILE_WORDS[w.fileType as OcfFileType];
    if (word) {
      notices.push({ code: 'ocf-not-imported-file', level: 'info',
        text: `${e.path} (${plural(items.length, word)}) is not imported: Kosmitor keeps ${word === 'document' ? 'documents in the vault' : 'financing details with each security'}.` });
    }
    out.push({ path: e.path, fileType: w.fileType, items: items.length, checksum, md5: e.md5, content: e.content });
  });
  if (mismatched.length) {
    notices.unshift({ code: 'ocf-checksum', level: 'info',
      text: `${mismatched.length === out.length && out.length > 1 ? 'No file matches' : `${listOf(mismatched)} ${mismatched.length === 1 ? 'does' : 'do'} not match`} the checksum the manifest gives it: read as ${mismatched.length === 1 ? 'it is' : 'they are'}. Many tools write placeholder checksums.` });
  }
  return out;
}

/** "a, b and c", or the first few and how many more. */
function listOf(items: string[]): string {
  const shown = items.length > 4 ? [...items.slice(0, 3), `${items.length - 3} more`] : items;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] ?? '';
}

/** How many objects of each section a package holds, for the reading note. */
function countsOf(files: { fileType: string; content: Record<string, unknown> }[]): OcfParse['counts'] {
  const counts: OcfParse['counts'] = {
    stakeholders: 0, shareClasses: 0, plans: 0, vesting: 0, valuations: 0, captable: 0, grants: 0, warrants: 0, convertibles: 0, events: 0, transactions: 0,
  };
  for (const f of files) {
    for (const item of itemsOf(f.content)) {
      const t = isRecord(item) ? String(item.object_type ?? '') : '';
      switch (t) {
        case 'STAKEHOLDER': counts.stakeholders++; break;
        case 'STOCK_CLASS': counts.shareClasses++; break;
        case 'STOCK_PLAN': counts.plans++; break;
        case 'VESTING_TERMS': counts.vesting++; break;
        case 'VALUATION': counts.valuations++; break;
        default:
          if (f.fileType !== 'OCF_TRANSACTIONS_FILE') break;
          counts.transactions++;
          if (t === 'TX_STOCK_ISSUANCE') counts.captable++;
          else if (t === 'TX_EQUITY_COMPENSATION_ISSUANCE' || t === 'TX_PLAN_SECURITY_ISSUANCE') counts.grants++;
          else if (t === 'TX_WARRANT_ISSUANCE') counts.warrants++;
          else if (t === 'TX_CONVERTIBLE_ISSUANCE') counts.convertibles++;
          else counts.events++;
      }
    }
  }
  return counts;
}

/** Objects and JSON within limits.importMaxTotalRows and limits.importJsonMb. */
function checkSize(files: { content: Record<string, unknown> }[], jsonBytes: number | null): void {
  const { importMaxTotalRows: maxObjects, importJsonMb } = config().limits;
  if (files.length > MAX_FILES) throw new OcfRefusal('ocf-too-large', `This package has ${files.length.toLocaleString('en-US')} files; an import reads at most ${MAX_FILES}.`, { limitFiles: MAX_FILES });
  if (jsonBytes != null && jsonBytes > megabytes(importJsonMb)) {
    throw new OcfRefusal('ocf-too-large', `This package holds more than ${importJsonMb} MB of JSON, more than an import reads.`, { limitMb: importJsonMb });
  }
  const objects = files.reduce((n, f) => n + itemsOf(f.content).length, 0);
  if (objects > maxObjects) {
    throw new OcfRefusal('too-many-rows', `This package has ${objects.toLocaleString('en-US')} objects; an import takes at most ${maxObjects.toLocaleString('en-US')}.`, { limit: maxObjects });
  }
}

const DAMAGED_JSON = (name: string): OcfRefusal => new OcfRefusal('damaged', `${name} is not valid JSON — it may be damaged. Export the package again and drop it here.`);

/**
 * A file's bytes as text. JSON is UTF-8 (RFC 8259): bytes that are not, such as a
 * Latin-1 name or a UTF-16 file, are refused rather than read as replacement characters.
 */
function utf8(data: Buffer, name: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch {
    throw new OcfRefusal('not-utf8', `${name} is not UTF-8 text, which JSON must be. Export it again as UTF-8 and drop it here.`);
  }
}

/** JSON as an object, bounded and tidied, or the refusal. */
function parseJson(data: Buffer, name: string): Record<string, unknown> {
  const text = utf8(data, name);
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw DAMAGED_JSON(name); }
  if (!isRecord(value) || !tidyJson(value)) throw DAMAGED_JSON(name);
  return value;
}

/** An OCF file has a file_type the coalition defined. */
const isOcfFile = (content: Record<string, unknown>): boolean => typeof content.file_type === 'string' && content.file_type.startsWith('OCF_');

// ---------------------------------------------------------------------------
// Parse: one uploaded file
// ---------------------------------------------------------------------------

/** Whether bytes are a JSON file: text starting with `{` (after a byte-order mark and white space), or a .json name. */
export function looksLikeJson(body: Buffer, fileName: string): boolean {
  const head = body.subarray(0, 64).toString('utf8').replace(/^﻿/, '').trimStart();
  return head.startsWith('{') || /\.json$/i.test(fileName);
}

/**
 * One uploaded file: a .ocf.zip (`zip` true, already known to hold JSON and no office
 * document), or a single JSON file. A zip must hold one manifest and every file it
 * lists; a JSON file is a manifest on its own (part 'manifest') or one file of a
 * package (part 'file'), which the page combines with the others dropped with it.
 */
export function readOcfUpload(body: Buffer, fileName: string, zip: boolean): OcfParse {
  const notices: Notice[] = [];
  const { importUnzippedMb, importJsonMb } = config().limits;
  if (!zip) {
    if (body.length > megabytes(importJsonMb)) throw new OcfRefusal('ocf-too-large', `${fileName} is more than ${importJsonMb} MB of JSON, more than an import reads.`, { limitMb: importJsonMb });
    const content = parseJson(body, fileName);
    if (!isOcfFile(content)) throw new OcfRefusal('not-a-spreadsheet', 'This JSON file is not an Open Cap Format file.');
    const file: OcfPackageFile = { path: fileName, md5: md5(body), content };
    if (content.file_type === 'OCF_MANIFEST_FILE') {
      const version = checkVersion(content.ocf_version, notices);
      const missing: string[] = [];
      resolveFiles(fileName, content, [], notices, missing);
      return {
        part: 'manifest', version, fileType: 'OCF_MANIFEST_FILE', issuer: issuerOf(content), asOf: dateOr(content.as_of), generatedAt: dateOr(content.generated_at),
        files: [], missing, counts: countsOf([]), notices, package: { manifestPath: fileName, manifest: content, files: [] },
      };
    }
    if (!Array.isArray(content.items)) throw new OcfRefusal('damaged', `${fileName} is an OCF file with no items.`);
    checkSize([file], body.length);
    return {
      part: 'file', version: null, fileType: String(content.file_type), issuer: null, asOf: null, generatedAt: null,
      files: [{ path: fileName, fileType: String(content.file_type), items: itemsOf(content).length, checksum: 'none', md5: file.md5 }],
      missing: [], counts: countsOf([{ fileType: String(content.file_type), content }]), notices, package: { manifestPath: null, manifest: null, files: [file] },
    };
  }

  // A zip: only its JSON entries are unpacked, all of them within limits.importJsonMb (and limits.importUnzippedMb), so an
  // entry that lies about its size stops inflating there rather than at the larger unpacking limit.
  let entries: OcfPackageFile[];
  let jsonBytes = 0;
  const unpackMb = Math.min(importUnzippedMb, importJsonMb);
  try {
    const files = openZip(body, megabytes(unpackMb));
    const names = [...files.keys()].filter((n) => /\.json$/i.test(n) && !/(^|\/)__MACOSX\//.test(n) && !/(^|\/)\._/.test(base(n)) && !n.endsWith('/'));
    if (names.length > MAX_FILES) throw new OcfRefusal('ocf-too-large', `This archive has ${names.length.toLocaleString('en-US')} JSON files; an import reads at most ${MAX_FILES}.`, { limitFiles: MAX_FILES });
    entries = names.map((name) => {
      const data = files.get(name)!;
      jsonBytes += data.length;
      if (jsonBytes > megabytes(importJsonMb)) throw new OcfRefusal('ocf-too-large', `This package holds more than ${importJsonMb} MB of JSON, more than an import reads.`, { limitMb: importJsonMb });
      return { path: name, md5: md5(data), content: parseJson(data, name) };
    });
  } catch (err) {
    if (err instanceof OcfRefusal) throw err;
    if (err instanceof ZipTooLarge) {
      throw new OcfRefusal('unzips-too-large', `This archive unpacks to more than ${unpackMb} MB, more than an import reads.`, { limitMb: unpackMb });
    }
    throw new OcfRefusal('damaged', `We couldn't open ${fileName} — it may be damaged. Export the package again and drop it here.`);
  }
  const manifests = entries.filter((e) => e.content.file_type === 'OCF_MANIFEST_FILE');
  if (manifests.length === 0) throw new OcfRefusal('ocf-no-manifest', 'This archive holds JSON files but no OCF manifest.');
  if (manifests.length > 1) throw new OcfRefusal('ocf-two-manifests', `This archive holds ${manifests.length} OCF manifests (${manifests.map((m) => m.path).join(', ')}). Drop one package at a time.`);
  const [manifest] = manifests;
  const version = checkVersion(manifest.content.ocf_version, notices);
  const files = resolveFiles(manifest.path, manifest.content, entries.filter((e) => e !== manifest), notices, null);
  checkSize(files, jsonBytes);
  return {
    part: 'package', version, fileType: null, issuer: issuerOf(manifest.content), asOf: dateOr(manifest.content.as_of), generatedAt: dateOr(manifest.content.generated_at),
    files: files.map(({ content: _content, ...f }) => f), missing: [], counts: countsOf(files), notices,
    package: { manifestPath: manifest.path, manifest: manifest.content, files: files.map((f) => ({ path: f.path, md5: f.md5, content: f.content })) },
  };
}

// ---------------------------------------------------------------------------
// The check and the import: the package the page sends back
// ---------------------------------------------------------------------------

/** The package body of a request, checked for shape and size; refused (OcfRefusal) when it cannot be a package. */
export function readPackageBody(raw: unknown): OcfPackageBody {
  if (!isRecord(raw)) throw new OcfRefusal('bad-sheet', 'ocf.package must be the package parse returned.');
  const files = raw.files;
  if (!Array.isArray(files)) throw new OcfRefusal('bad-sheet', 'ocf.package.files must be a list of files.');
  if (files.length > MAX_FILES) throw new OcfRefusal('ocf-too-large', `A package has at most ${MAX_FILES} files.`, { limitFiles: MAX_FILES });
  const out: OcfPackageFile[] = files.map((f, i) => {
    if (!isRecord(f) || typeof f.path !== 'string' || f.path.length === 0 || f.path.length > MAX_PATH || !isRecord(f.content)) {
      throw new OcfRefusal('bad-sheet', `File ${i + 1} of the package is not a file: it needs a path and its JSON content.`);
    }
    const hash = typeof f.md5 === 'string' && /^[0-9a-f]{32}$/i.test(f.md5) ? f.md5.toLowerCase() : null;
    if (!tidyJson(f.content)) throw DAMAGED_JSON(f.path);
    return { path: f.path, md5: hash, content: f.content };
  });
  const manifestPath = typeof raw.manifestPath === 'string' && raw.manifestPath.length <= MAX_PATH ? raw.manifestPath : null;
  const manifest = isRecord(raw.manifest) ? raw.manifest : null;
  if (manifest && !tidyJson(manifest)) throw DAMAGED_JSON('The manifest');
  checkSize(out, null);
  return { manifestPath, manifest, files: out };
}

/**
 * A package body read for the check: its manifest (which it must have), the version,
 * and the files the manifest lists, found as parse found them. A file it lists that
 * is not there is refused.
 */
export function readOcfPackage(pkg: OcfPackageBody): OcfPackageRead {
  const notices: Notice[] = [];
  const manifest = pkg.manifest;
  if (!manifest || manifest.file_type !== 'OCF_MANIFEST_FILE') throw new OcfRefusal('ocf-no-manifest', 'This OCF package has no manifest. Drop the .ocf.zip, or the manifest with all of its files.');
  const version = checkVersion(manifest.ocf_version, notices);
  const files = resolveFiles(pkg.manifestPath, manifest, pkg.files, notices, null);
  return { version, manifest, issuer: issuerOf(manifest), asOf: dateOr(manifest.as_of), generatedAt: dateOr(manifest.generated_at), files, notices };
}

/** A request's `ocf.exclude`: item numbers by section. */
export function readExclude(raw: unknown): Partial<Record<OcfSection, number[]>> {
  if (raw == null) return {};
  if (!isRecord(raw)) throw new OcfRefusal('bad-option', 'ocf.exclude must give item numbers by section.');
  const out: Partial<Record<OcfSection, number[]>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isOcfSection(k)) throw new OcfRefusal('bad-option', `ocf.exclude names no section "${k.slice(0, 40)}".`);
    if (!Array.isArray(v) || v.length > 100_000 || !v.every((n) => Number.isInteger(n) && n > 0)) throw new OcfRefusal('bad-option', `ocf.exclude.${k} must be a list of item numbers.`);
    out[k] = [...new Set(v as number[])].sort((a, b) => a - b);
  }
  return out;
}

/** A request's `options.ocfPeople`: who each stakeholder of the package is, 'new' or a stakeholder id (checked against the company by the caller). */
export function readOcfPeople(raw: unknown): Map<string, string> | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) throw new OcfRefusal('bad-option', 'options.ocfPeople must map stakeholder ids of the package to a stakeholder or "new".');
  const entries = Object.entries(raw);
  if (entries.length > 100_000) throw new OcfRefusal('bad-option', 'options.ocfPeople has too many entries.');
  const out = new Map<string, string>();
  for (const [k, v] of entries) {
    if (k.length > 255 || typeof v !== 'string' || v.length === 0 || v.length > 255) throw new OcfRefusal('bad-option', 'options.ocfPeople must map stakeholder ids of the package to a stakeholder or "new".');
    out.set(k, v);
  }
  return out;
}
