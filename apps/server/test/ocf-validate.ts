/**
 * Validates OCF packages against the official OCF 1.2.0 JSON Schemas, vendored
 * unmodified in test/ocf-schema/v1.2.0 (see its README). For tests only: ajv and
 * ajv-formats are dev dependencies of @kosmitor/server, and production never loads
 * this file or the schemas.
 *
 * Each file is checked against its file schema (by `file_type`), and each item also
 * against its own object schema (by `object_type`), whose errors name the field.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const ROOT = join(import.meta.dirname, 'ocf-schema', 'v1.2.0', 'schema');
const BASE = 'https://schema.opencaptablecoalition.com/v/1.2.0/';

const walk = (dir: string): string[] => readdirSync(dir).sort().flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : f.endsWith('.schema.json') ? [p] : [];
});

const schemas = walk(ROOT).map((p) => JSON.parse(readFileSync(p, 'utf8')) as { $id: string });
// The schemas are draft-07 and mark some fields "deprecated": "true", which strict mode refuses.
const ajv = new Ajv({ strict: false, allErrors: true, schemas });
addFormats(ajv);

export const FILE_SCHEMAS: Record<string, string> = {
  OCF_MANIFEST_FILE: 'files/OCFManifestFile',
  OCF_STAKEHOLDERS_FILE: 'files/StakeholdersFile',
  OCF_STOCK_CLASSES_FILE: 'files/StockClassesFile',
  OCF_STOCK_LEGEND_TEMPLATES_FILE: 'files/StockLegendTemplatesFile',
  OCF_STOCK_PLANS_FILE: 'files/StockPlansFile',
  OCF_TRANSACTIONS_FILE: 'files/TransactionsFile',
  OCF_VALUATIONS_FILE: 'files/ValuationsFile',
  OCF_VESTING_TERMS_FILE: 'files/VestingTermsFile',
  OCF_FINANCINGS_FILE: 'files/FinancingsFile',
  OCF_DOCUMENTS_FILE: 'files/DocumentsFile',
};

/** The object schema of each object_type, from the schemas' own `object_type` const or enum. */
const OBJECT_SCHEMAS = new Map<string, string>();
for (const s of schemas as { $id: string; properties?: { object_type?: { const?: string; enum?: string[] } } }[]) {
  const ot = s.properties?.object_type;
  if (!s.$id.includes('/objects/') || !ot) continue;
  for (const t of ot.const ? [ot.const] : ot.enum ?? []) if (!OBJECT_SCHEMAS.has(t)) OBJECT_SCHEMAS.set(t, s.$id);
}

const compiled = new Map<string, ValidateFunction>();
function validator(id: string): ValidateFunction {
  let v = compiled.get(id);
  if (!v) {
    v = ajv.getSchema(id) ?? undefined;
    if (!v) throw new Error(`No OCF schema ${id}`);
    compiled.set(id, v);
  }
  return v;
}

const describe = (where: string, v: ValidateFunction): string[] =>
  (v.errors ?? []).map((e) => `${where}${e.instancePath} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`);

/**
 * The problems with a package's files, by file path and JSON path; empty when every
 * file is valid. A file's own oneOf errors over the transactions are long, so an item
 * that fails its object schema is reported by that schema alone.
 */
export function validateOcf(files: { path: string; json: any }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const schema = FILE_SCHEMAS[f.json?.file_type];
    if (!schema) { out.push(`${f.path}: unknown file_type ${JSON.stringify(f.json?.file_type)}`); continue; }
    const itemProblems: string[] = [];
    (Array.isArray(f.json.items) ? f.json.items : []).forEach((item: any, i: number) => {
      const id = OBJECT_SCHEMAS.get(item?.object_type);
      if (!id) { itemProblems.push(`${f.path}/items/${i}: unknown object_type ${JSON.stringify(item?.object_type)}`); return; }
      const v = validator(id);
      if (!v(item)) itemProblems.push(...describe(`${f.path}/items/${i} (${item.object_type} ${item.id})`, v));
    });
    out.push(...itemProblems);
    const v = validator(`${BASE}${schema}.schema.json`);
    if (!v(f.json) && itemProblems.length === 0) out.push(...describe(f.path, v));
  }
  return out;
}
