/**
 * A Word document uploaded as a template: its text comes back as the template
 * body (merge fields intact, tables as tab-separated lines), nothing is saved
 * until the page saves it, and a file that is not a .docx is refused.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/workflows.ts');
const { zip } = await import('../src/xlsx-writer.ts');
const { one } = await import('../src/db.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function json(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
async function upload(cid: string, name: string, data: Buffer, token: string) {
  const res = await fetch(`${base}/api/c/${cid}/templates/import-docx?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` }, body: data,
  });
  return { status: res.status, json: (await res.json()) as any };
}

const docx = (documentXml: string): Buffer => zip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from(`<w:document><w:body>${documentXml}</w:body></w:document>`) },
]);
const p = (...runs: string[]) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join('')}</w:p>`;

const token = (await json('POST', '/api/auth/register', { email: 'ada@example.com', name: 'Ada Vale', password: 'ada-pass-12345' })).token as string;
const cid = (await json('POST', '/api/companies', { name: 'Docx Co' }, token)).json.id as string;

test('the text of a document comes back as a template, merge fields split over runs and all, and nothing is saved', async () => {
  const file = docx([
    p('Agreement for ', '{{', 'holder.', 'name}}', ' &amp; the Company'),
    '<w:p><w:r><w:t>One</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Two</w:t><w:br/><w:t>Three</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Shares</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{grant.quantity}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    p('{{nonsense.token}}'),
  ].join(''));
  const before = (await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM document_templates WHERE company_id = ?', cid))!.n;
  const res = await upload(cid, 'Option_agreement.docx', file, token);
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'Option agreement');
  assert.equal(res.json.body, 'Agreement for {{holder.name}} & the Company\nOne\tTwo\nThree\nShares\t{{grant.quantity}}\n{{nonsense.token}}');
  assert.deepEqual(res.json.unknownTokens, ['nonsense.token']);
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM document_templates WHERE company_id = ?', cid))!.n, before);
});

test('a text box is read once, and a long agreement comes through and can be saved', async () => {
  const box = '<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>Boxed</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Boxed</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>';
  const long = Array.from({ length: 2000 }, (_, i) => p(`Clause ${i}. ${'The Optionee agrees to the terms of the Plan. '.repeat(3)}`)).join('');
  const res = await upload(cid, 'long.docx', docx(box + long), token);
  assert.equal(res.status, 200);
  assert.ok(res.json.body.length > 50_000);
  assert.equal(res.json.body.split('Boxed').length - 1, 1);
  const saved = await json('POST', `/api/c/${cid}/templates`, { kind: 'OPTION_AGREEMENT', name: res.json.name, body: res.json.body }, token);
  assert.equal(saved.status, 200);
  const tooLong = await upload(cid, 'huge.docx', docx(p('x'.repeat(500_001))), token);
  assert.equal(tooLong.json.detail.code, 'too-large');
  assert.match(tooLong.json.error, /500,001 characters/);
});

test('what is not a usable Word document is refused with a reason', async () => {
  const notDocx = await upload(cid, 'sheet.docx', zip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]), token);
  assert.equal(notDocx.status, 400);
  assert.equal(notDocx.json.detail.code, 'not-docx');
  const damaged = await upload(cid, 'x.docx', Buffer.from('plain text, not a zip'), token);
  assert.equal(damaged.json.detail.code, 'damaged');
  const empty = await upload(cid, 'blank.docx', docx('<w:p/>'), token);
  assert.equal(empty.json.detail.code, 'empty');
  const nothing = await upload(cid, 'zero.docx', Buffer.alloc(0), token);
  assert.equal(nothing.json.detail.code, 'empty');
});

test('a reader cannot upload one', async () => {
  const anon = await fetch(`${base}/api/c/${cid}/templates/import-docx?name=a.docx`, { method: 'POST', body: docx(p('x')) });
  assert.ok(anon.status === 401 || anon.status === 403);
});
