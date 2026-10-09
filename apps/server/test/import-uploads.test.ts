/**
 * The file handed to the import wizard is kept with how it ended, so a failed
 * import can be replayed: a file that does not parse, one that parses, and one
 * that is committed. Old files go with the next upload.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/imports.ts');
const { all, run } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
async function parse(name: string, text: string) {
  const res = await fetch(`${base}/api/c/${cid}/imports/parse?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'text/csv' }, body: text,
  });
  return { status: res.status, json: (await res.json()) as any };
}
const uploads = () => all<{ id: string; file_name: string; outcome: string; error: string | null; import_id: string | null; size_bytes: string }>(
  'SELECT id, file_name, outcome, error, import_id, size_bytes FROM import_uploads WHERE company_id = ? ORDER BY created_at', cid);

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Uploads Co' }, admin)).json.id as string;

test('a file that does not parse is kept with the reason', async () => {
  const res = await parse('empty.csv', '\n\n');
  assert.equal(res.status, 400);
  const [row] = await uploads();
  assert.equal(row.file_name, 'empty.csv');
  assert.equal(row.outcome, 'PARSE_FAILED');
  assert.equal(row.error, res.json.error);
});

test('a parsed file is kept, and committing it records the import', async () => {
  const csv = 'Name,Email,Type\nBao Lin,bao@example.com,Employee\n';
  const parsed = await parse('people.csv', csv);
  assert.equal(parsed.status, 200);
  assert.ok(parsed.json.uploadId);
  const rows = await uploads();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, parsed.json.uploadId);
  assert.equal(rows[1].outcome, 'PARSED');
  assert.equal(Number(rows[1].size_bytes), Buffer.byteLength(csv));

  const sheet = parsed.json.sheets[0];
  const mapping = (await call('POST', `/api/c/${cid}/imports/suggest`, { kind: 'stakeholders', headers: sheet.rows[0], sheetName: sheet.name }, admin)).json.mapping;
  const body = {
    uploadIds: [parsed.json.uploadId], fileName: 'people.csv', options: {},
    sheets: [{ name: sheet.name, kind: 'stakeholders', headers: sheet.rows[0], rows: sheet.rows.slice(1), mapping, headerRowNumber: 1 }],
  };
  const review = await call('POST', `/api/c/${cid}/imports/workbook/preview`, body, admin);
  assert.equal(review.status, 200, JSON.stringify(review.json));
  const commit = await call('POST', `/api/c/${cid}/imports/workbook/commit`, { ...body, reviewToken: review.json.reviewToken }, admin);
  assert.equal(commit.status, 200, JSON.stringify(commit.json));
  const after = (await uploads())[1];
  assert.equal(after.outcome, 'COMMITTED');
  assert.equal(after.import_id, commit.json.importIds[0]);
});

test('files older than the retention go with the next upload; another company cannot settle ours', async () => {
  await run("UPDATE import_uploads SET created_at = '2000-01-01T00:00:00.000Z' WHERE outcome = 'PARSE_FAILED'");
  const other = (await call('POST', '/api/auth/register', { email: 'kai@example.com', name: 'Kai Moss', password: 'kai-pass-123' })).token as string;
  const otherCid = (await call('POST', '/api/companies', { name: 'Other Co' }, other)).json.id as string;
  const [mine] = await uploads();
  const forged = await call('POST', `/api/c/${otherCid}/imports/workbook/commit`, { uploadIds: [mine.id], sheets: [{ name: 'x', kind: 'stakeholders', headers: ['Name'], rows: [], mapping: { name: 0 }, headerRowNumber: 1 }] }, other);
  assert.notEqual(forged.status, 500);
  assert.equal((await uploads())[0].id, mine.id);   // still ours, untouched by the other company

  await parse('later.csv', 'Name\nCy\n');
  const names = (await uploads()).map((r) => r.file_name);
  assert.deepEqual(names, ['people.csv', 'later.csv']);
});
