/**
 * Writes docs/configuration.md from kosmitor.config.schema.json (what each
 * setting means) and kosmitor.config.json (its default), so the reference
 * cannot drift from the files the server reads.
 *
 *   node src/config-docs.ts           write the file
 *   node src/config-docs.ts --check   exit 1 when the file is out of date
 *
 * Run it (npm run config:docs) after changing the schema or a default.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, ENV_OVERRIDES, checkAgainstSchema } from './config.ts';

type Schema = Parameters<typeof checkAgainstSchema>[1];

export const DOCS_FILE = resolve(CONFIG_DIR, 'docs', 'configuration.md');

/**
 * Environment variables the server reads that are not settings: secrets and
 * wiring, which never go in a param file. Kept by hand, so add to it when the
 * server starts reading a new one.
 */
const ENVIRONMENT_ONLY: { name: string; what: string }[] = [
  { name: 'DATABASE_URL', what: 'PostgreSQL connection string. Default `postgres://localhost:5432/kosmitor`.' },
  { name: 'SMTP_URL', what: 'Send mail through an SMTP server: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465`.' },
  { name: 'ACS_CONNECTION_STRING', what: 'Send mail through Azure Communication Services; wins over `SMTP_URL`. Neither set: messages are printed to the log.' },
  { name: 'CT_SECRET_KEY', what: 'Encrypts the API keys people give the assistant. Without it the server keeps a generated key in its own table.' },
  { name: 'BACKUP_ACCOUNT_URL', what: 'Blob endpoint of the storage account the backup job writes to.' },
  { name: 'AZURE_CLIENT_ID', what: 'Managed identity the backup job signs in to storage with.' },
  { name: 'BACKUP_TOKEN', what: 'A storage bearer token for running the backup job by hand instead.' },
  { name: 'NODE_ENV', what: '`production` in a deployment: secure cookies, `DATABASE_URL` required, and reset links never shown on screen.' },
  { name: 'WEB_DIST', what: 'Built web app the API serves (the container image sets it).' },
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A table cell: one line, pipes escaped. */
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** Inline code that survives backticks inside the value. */
function code(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

/** Lists longer than this are summarised; the full value is in kosmitor.config.json. */
const INLINE_LIST_CHARS = 120;

function formatDefault(value: unknown): string {
  if (value === undefined) return '';
  if (!Array.isArray(value)) return code(JSON.stringify(value));
  const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (inline.length > INLINE_LIST_CHARS || value.some((v) => typeof v === 'object' && v !== null)) {
    return `${value.length} entr${value.length === 1 ? 'y' : 'ies'}, see \`kosmitor.config.json\``;
  }
  return code(inline);
}

function describe(schema: Schema): string {
  const parts = [schema.description ?? ''];
  if (schema.enum) parts.push(`One of ${schema.enum.map((e) => code(JSON.stringify(e))).join(', ')}.`);
  if (schema.minimum !== undefined && schema.maximum !== undefined) {
    if (!parts[0].includes(`${schema.minimum} to ${schema.maximum}`)) parts.push(`From ${schema.minimum} to ${schema.maximum}.`);
  }
  else if (schema.minimum !== undefined) parts.push(`At least ${schema.minimum}.`);
  else if (schema.maximum !== undefined) parts.push(`At most ${schema.maximum}.`);
  return parts.filter(Boolean).join(' ');
}

interface Row { setting: string; value: string; description: string }

/** One row per setting; a group of settings gets a row of its own, and a list of entries a row per field of an entry. */
function rows(schema: Schema, value: unknown, path: string, out: Row[]): Row[] {
  if (schema.properties && (isObject(value) || value === undefined)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const childPath = `${path}.${key}`;
      if (child.properties) out.push({ setting: childPath, value: '', description: describe(child) });
      rows(child, isObject(value) ? value[key] : undefined, childPath, out);
    }
    return out;
  }
  out.push({ setting: path, value: formatDefault(value), description: describe(schema) });
  const fields = schema.items?.properties;
  if (fields) {
    for (const [key, child] of Object.entries(fields)) out.push({ setting: `${path}[].${key}`, value: '', description: describe(child) });
  }
  return out;
}

const table = (list: Row[]): string => [
  '| Setting | Default | Description |',
  '| --- | --- | --- |',
  ...list.map((r) => `| ${code(r.setting)} | ${cell(r.value)} | ${cell(r.description)} |`),
].join('\n');

/** The whole reference, from the schema and the defaults file. */
export function renderConfigDocs(schema: Schema, defaults: Record<string, unknown>): string {
  const errors = checkAgainstSchema(defaults, schema, true);
  if (errors.length) throw new Error(`kosmitor.config.json does not match its schema:\n  - ${errors.join('\n  - ')}`);
  const sections = Object.entries(schema.properties ?? {}).filter(([key]) => key !== '$schema');

  const out: string[] = [
    '# Configuration',
    '',
    '<!-- Generated by `npm run config:docs` from kosmitor.config.schema.json and kosmitor.config.json. Edit those and run it again rather than editing this file. -->',
    '',
    'Every setting the server and the web app read, with its default.',
    '',
    '## How the settings are read',
    '',
    'Three layers, each winning over the one before:',
    '',
    '1. `kosmitor.config.json` at the repository root holds every setting at its default. Leave it as shipped, so updates merge cleanly.',
    '2. Your changes go in `kosmitor.config.local.json` next to it (ignored by git), or in the file named by the `KOSMITOR_CONFIG` environment variable (absolute, or relative to the repository root). It only needs the entries you change: objects merge key by key, and a list replaces the default list whole.',
    '3. The environment variables listed below, for values that differ per deployment.',
    '',
    'The server checks the merged result against `kosmitor.config.schema.json` when it starts, and stops with the entry named when a key is misspelt or a value has the wrong type. Under `node --test` the local file is ignored, so tests run on the defaults. `KOSMITOR_ROOT` moves the folder the files are read from (the repository root, `/app` in the container image).',
    '',
    'A `kosmitor.config.local.json` that rebrands the app, sets its address and shows the demo login:',
    '',
    '```json',
    '{',
    '  "$schema": "./kosmitor.config.schema.json",',
    '  "brand": { "productName": "Acme Equity", "pageTitle": "Acme Equity" },',
    '  "app": { "url": "https://equity.example.com" },',
    '  "demo": { "enabled": true }',
    '}',
    '```',
    '',
    '## Environment variables',
    '',
    'Each of these sets one entry and wins over both files. An empty variable counts as unset; lists are comma separated.',
    '',
    '| Variable | Sets |',
    '| --- | --- |',
    ...ENV_OVERRIDES.map((e) => `| ${code(e.name)} | ${code(e.path)} |`),
    '',
    'Secrets and wiring stay in the environment and never go in a param file:',
    '',
    '| Variable | What it is |',
    '| --- | --- |',
    ...ENVIRONMENT_ONLY.map((e) => `| ${code(e.name)} | ${cell(e.what)} |`),
    '',
    '## Settings',
    '',
    sections.map(([key]) => `[${key}](#${key.toLowerCase()})`).join(' · '),
    '',
  ];
  for (const [key, section] of sections) {
    out.push(`### ${key}`, '');
    if (section.description) out.push(section.description, '');
    out.push(table(rows(section, defaults[key], key, [])), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The reference as the files on disk say it should read. */
export function currentConfigDocs(): string {
  const read = (file: string) => JSON.parse(readFileSync(resolve(CONFIG_DIR, file), 'utf8'));
  return renderConfigDocs(read('kosmitor.config.schema.json'), read('kosmitor.config.json'));
}

/** Whether docs/configuration.md matches the files. */
export function configDocsUpToDate(): boolean {
  return existsSync(DOCS_FILE) && readFileSync(DOCS_FILE, 'utf8') === currentConfigDocs();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (!configDocsUpToDate()) {
      console.error('docs/configuration.md is out of date: run `npm run config:docs` and commit the result.');
      process.exit(1);
    }
    console.log('docs/configuration.md is up to date.');
  } else {
    mkdirSync(dirname(DOCS_FILE), { recursive: true });
    writeFileSync(DOCS_FILE, currentConfigDocs());
    console.log(`Wrote ${DOCS_FILE}`);
  }
}
