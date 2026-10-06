import { route, badRequest, notFound, audit, newId, nowISO, str } from '../http.ts';
import { all, toCamelAll } from '../db.ts';
import { invalidate } from '../store.ts';
import { parseCsv, toCsv } from '../import/csv.ts';
import { parseXlsx } from '../import/xlsx.ts';
import { parseXmlTable, toXml } from '../import/xml.ts';
import { IMPORT_KINDS, suggestMapping, suggestForSheet, detectSheet, guessHeaderRow, type ImportKind, type Cell } from '../import/values.ts';
import { prepareImport, commitImport, runWorkbook, limitRows, type ImportRequest, type MappingValue, type WorkbookSheet } from '../import/engine.ts';
import { config, megabytes } from '../config.ts';

const isKind = (k: string): k is ImportKind => k in IMPORT_KINDS;

/** Field definitions the wizard renders — synonyms stay server-side. */
route.get('/api/c/:cid/imports/schema', 'read', async () => ({
  maxRows: config().limits.importMaxRows,
  kinds: Object.values(IMPORT_KINDS).map((k) => ({
    key: k.key, label: k.label, description: k.description,
    fields: k.fields.map(({ key, label, type, required, hint }) => ({ key, label, type, required: !!required, hint: hint ?? null })),
  })),
}));

const XML_RECORD_NAMES: Record<ImportKind, [root: string, record: string]> = {
  stakeholders: ['stakeholders', 'stakeholder'], captable: ['captable', 'certificate'],
  grants: ['grants', 'grant'], convertibles: ['convertibles', 'instrument'],
};

/** Template as CSV, or as XML (`?format=xml`) with one element per field, named by the field keys. */
route.get('/api/c/:cid/imports/template/:kind', 'read', async (ctx) => {
  const kind = ctx.params.kind;
  if (!isKind(kind)) throw notFound('Unknown import kind.');
  const [headers, ...examples] = IMPORT_KINDS[kind].template;
  if (ctx.query.get('format') === 'xml') {
    const mapping = suggestMapping(kind, headers);
    const keyByColumn = new Map<number, string>();
    for (const [key, col] of Object.entries(mapping)) if (col != null) keyByColumn.set(col, key);
    const names = headers.map((h, i) => keyByColumn.get(i) ?? h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^(\d)/, '_$1'));
    const [root, record] = XML_RECORD_NAMES[kind];
    ctx.res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}-template.xml"`,
    });
    ctx.res.end(toXml(root, record, names, examples));
    return undefined;
  }
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${kind}-template.csv"`,
  });
  ctx.res.end(toCsv([headers, ...examples]));
  return undefined;
});

/** Which parser a file wants, from its bytes first and its name second. */
export function detectFormat(body: Buffer, fileName: string): 'xlsx' | 'xml' | 'csv' | 'pdf' {
  if (body.length > 4 && body.readUInt32LE(0) === 0x04034b50) return 'xlsx';
  if (body.subarray(0, 1024).toString('latin1').includes('%PDF-') || /\.pdf$/i.test(fileName)) return 'pdf';
  const head = body.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (head.startsWith('<?xml') || /^<[A-Za-z_]/.test(head)) return 'xml';
  if (/\.xlsx$/i.test(fileName)) return 'xlsx';
  if (/\.xml$/i.test(fileName)) return 'xml';
  return 'csv';
}

/**
 * Parses an uploaded CSV or XLSX into sheets of raw cells. Nothing is written;
 * the wizard maps columns and previews before anything touches the cap table.
 * The file may be up to limits.importUploadMb.
 */
route.post('/api/c/:cid/imports/parse', 'write', async (ctx) => {
  const body = ctx.rawBody;
  if (!body || body.length === 0) throw badRequest('Upload a CSV, Excel, XML or PDF file.');
  const fileName = str(ctx.query.get('name') ?? 'upload', 'File name', { max: 255 });
  const format = detectFormat(body, fileName);
  // A PDF is kept as a document and linked to an instrument; it is never read as a table.
  if (format === 'pdf') throw badRequest('PDF files are stored as documents rather than read as tables. Use the document step of the import page to keep the file and link it to a stakeholder or instrument.');
  if (/\.xls$/i.test(fileName) && format !== 'xlsx' && format !== 'xml') {
    throw badRequest('Legacy .xls workbooks are not supported — save the file as .xlsx, .xml or .csv and try again.');
  }

  let sheets: { name: string; rows: Cell[][] }[];
  try {
    if (format === 'xlsx') sheets = parseXlsx(body);
    else if (format === 'xml') sheets = parseXmlTable(body.toString('utf8'));
    else sheets = [{ name: fileName.replace(/\.[^.]+$/, ''), rows: parseCsv(body.toString('utf8')) }];
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  sheets = sheets.filter((s) => s.rows.length > 0);
  if (sheets.length === 0) throw badRequest('The file has no rows.');

  return {
    fileName,
    sheets: sheets.map((s) => {
      const { rows, truncated } = limitRows(s.rows);
      return { name: s.name, rows, rowCount: s.rows.length, truncated, headerRow: guessHeaderRow(rows) };
    }),
  };
}, { raw: true, maxBytes: () => megabytes(config().limits.importUploadMb) });

/**
 * Column guesses for a header row, plus fixed values the sheet itself implies
 * (a share class named by the sheet). `score` counts required fields covered,
 * so the wizard can pick the most promising sheet of a workbook.
 */
route.post('/api/c/:cid/imports/suggest', 'read', async (ctx) => {
  const kind = String(ctx.body.kind ?? '');
  if (!isKind(kind)) throw badRequest('Unknown import kind.');
  const headers = Array.isArray(ctx.body.headers) ? (ctx.body.headers as Cell[]) : [];
  return suggestForSheet(kind, typeof ctx.body.sheetName === 'string' ? ctx.body.sheetName : null, headers);
});

/**
 * Sorts a workbook's tabs into the kinds they hold. Every tab is considered:
 * ledgers come back with a kind and a column mapping, summary tabs with the
 * reason they are left out, so the wizard can import a whole file at once.
 */
route.post('/api/c/:cid/imports/detect', 'read', async (ctx) => {
  if (!Array.isArray(ctx.body.sheets)) throw badRequest('No sheets to detect.');
  const preferred = typeof ctx.body.preferredKind === 'string' && isKind(ctx.body.preferredKind) ? ctx.body.preferredKind : null;
  return {
    // Detection looks at more tabs than an import takes, since summary tabs are sorted out here.
    sheets: (ctx.body.sheets as { name?: unknown; headers?: unknown; rowCount?: unknown }[]).slice(0, Math.max(100, config().limits.importMaxSheets)).map((sh) => {
      const name = String(sh.name ?? '');
      const headers = Array.isArray(sh.headers) ? (sh.headers as Cell[]) : [];
      return { name, ...detectSheet(name, headers, Number(sh.rowCount ?? 0), preferred) };
    }),
  };
});

function readRequest(body: Record<string, unknown>, where = ''): ImportRequest {
  const kind = String(body.kind ?? '');
  if (!isKind(kind)) throw badRequest(`Unknown import kind${where}.`);
  if (!Array.isArray(body.rows)) throw badRequest(`No rows to import${where}.`);
  if (!body.mapping || typeof body.mapping !== 'object') throw badRequest(`Map the columns first${where}.`);
  const mapping: Record<string, MappingValue> = {};
  for (const [k, v] of Object.entries(body.mapping as Record<string, unknown>)) {
    if (v == null) mapping[k] = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) mapping[k] = v;
    else if (typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') {
      const value = (v as { value: string }).value.trim();
      mapping[k] = value === '' ? null : { value: value.slice(0, 500) };
    } else throw badRequest(`Mapping for "${k}" must be a column index or a fixed value.`);
  }
  for (const f of IMPORT_KINDS[kind].fields) {
    if (f.required && mapping[f.key] == null) throw badRequest(`Map a column to "${f.label}"${where} — it is required.`);
  }
  return {
    kind, headers: (body.headers as Cell[]) ?? [], rows: body.rows as Cell[][], mapping,
    headerRowNumber: Number(body.headerRowNumber ?? 1),
    options: (body.options as ImportRequest['options']) ?? {},
  };
}

route.post('/api/c/:cid/imports/preview', 'write', async (ctx) => {
  const { plan: _plan, ...preview } = await prepareImport(ctx.companyId!, readRequest(ctx.body));
  void _plan;
  return preview;
});

route.post('/api/c/:cid/imports/commit', 'write', async (ctx) => {
  const req = readRequest(ctx.body);
  let result;
  try {
    result = await commitImport(ctx.companyId!, req, ctx.user!.name);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  invalidate(ctx.companyId!);
  const i = result.imported;
  await audit(ctx, 'IMPORT', 'imports', result.importId,
    `Imported ${IMPORT_KINDS[req.kind].label.toLowerCase()}${req.options?.fileName ? ` from ${req.options.fileName}` : ''}: ` +
    [i.stakeholders && `${i.stakeholders} stakeholders`, i.shareClasses && `${i.shareClasses} share classes`,
     i.pools && `${i.pools} equity plans`, i.issuances && `${i.issuances} certificates`, i.awards && `${i.awards} grants`,
     i.convertibles && `${i.convertibles} convertibles`].filter(Boolean).join(', '));
  return result;
});

/** Several sheets of one file, each with its own kind and mapping, sharing the options. */
function readWorkbook(body: Record<string, unknown>): { sheets: WorkbookSheet[]; fileName: string | null } {
  if (!Array.isArray(body.sheets) || body.sheets.length === 0) throw badRequest('Choose at least one sheet to import.');
  const maxSheets = config().limits.importMaxSheets;
  if (body.sheets.length > maxSheets) throw badRequest(`A workbook import takes at most ${maxSheets} sheet${maxSheets === 1 ? '' : 's'}.`);
  const fileName = body.fileName ? str(body.fileName, 'File name', { max: 255 }) : null;
  const options = (body.options as ImportRequest['options']) ?? {};
  const sheets = (body.sheets as Record<string, unknown>[]).map((sh) => {
    const sheetName = str(sh.name ?? sh.sheetName ?? 'Sheet', 'Sheet name', { max: 120 });
    const req = readRequest({ ...sh, options: { ...options, fileName: fileName && sheetName ? `${fileName} › ${sheetName}` : fileName } }, ` on sheet "${sheetName}"`);
    return { ...req, sheetName };
  });
  return { sheets, fileName };
}

route.post('/api/c/:cid/imports/workbook/preview', 'write', async (ctx) => {
  const { sheets } = readWorkbook(ctx.body);
  return runWorkbook(ctx.companyId!, sheets, ctx.user!.name, true);
});

route.post('/api/c/:cid/imports/workbook/commit', 'write', async (ctx) => {
  const { sheets, fileName } = readWorkbook(ctx.body);
  let result;
  try {
    result = await runWorkbook(ctx.companyId!, sheets, ctx.user!.name, false);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  invalidate(ctx.companyId!);
  const i = result.imported;
  await audit(ctx, 'IMPORT', 'imports', result.importIds[0] ?? null,
    `Imported ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}${fileName ? ` from ${fileName}` : ''}: ` +
    [i.stakeholders && `${i.stakeholders} stakeholders`, i.shareClasses && `${i.shareClasses} share classes`,
     i.pools && `${i.pools} equity plans`, i.issuances && `${i.issuances} certificates`, i.awards && `${i.awards} grants`,
     i.convertibles && `${i.convertibles} convertibles`].filter(Boolean).join(', '));
  return result;
});

route.get('/api/c/:cid/imports', 'read', async (ctx) =>
  toCamelAll<Record<string, unknown>>(await all('SELECT * FROM imports WHERE company_id = ? ORDER BY created_at DESC LIMIT 50', ctx.companyId))
    .map((r) => ({ ...r, summary: r.summary ? JSON.parse(String(r.summary)) : null })));

void newId; void nowISO;
