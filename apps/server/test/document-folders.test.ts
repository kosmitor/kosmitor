/**
 * Document folders as paths: one rule cleans the folder for creating, uploading
 * and editing a document, a move is logged by where the document went, another
 * company's document cannot be moved, a viewer cannot move anything, and a path
 * too deep or too long is refused rather than cut short.
 *
 * Moving several documents at once is one request that moves all of them or
 * none: one document that is not this company's, or one folder the rule
 * refuses, leaves every document where it was.
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
await import('../src/routes/files.ts');
const { one, all } = await import('../src/db.ts');
const { documentFolder } = await import('../src/folders.ts');
const { DOCUMENT_MOVE_MAX } = await import('../src/routes/workflows.ts');

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
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
async function upload(companyId: string, query: Record<string, string>, token: string) {
  const res = await fetch(`${base}/api/c/${companyId}/documents/upload?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: new Uint8Array(PDF) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}
const count = async (companyId: string) =>
  Number((await one<{ n: string }>('SELECT COUNT(*) AS n FROM documents WHERE company_id = ?', companyId))!.n);

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Marlowe Systems' }, admin)).json.id as string;
const other = (await call('POST', '/api/companies', { name: 'Elsewhere Inc' }, admin)).json.id as string;

/** Runs the normaliser and returns the message it refuses with, or null when it accepts. */
function refusal(value: unknown): string | null {
  try { documentFolder(value); return null; } catch (err) {
    assert.equal((err as { status?: number }).status, 400, 'a refusal is a bad request');
    return (err as Error).message;
  }
}

test('the normaliser trims each level, collapses spaces, drops empty levels and defaults to General', () => {
  for (const empty of [undefined, null, '', '   ', '/', ' / // ']) assert.equal(documentFolder(empty), 'General', JSON.stringify(empty));
  assert.equal(documentFolder('Series A'), 'Series A', 'a flat name saved before folders nested is a top-level folder');
  assert.equal(documentFolder('  Series A  '), 'Series A');
  assert.equal(documentFolder('Financing / Series   A '), 'Financing/Series A');
  assert.equal(documentFolder('/Financing//Series A/'), 'Financing/Series A');
  assert.equal(documentFolder('Board\tminutes\n2026'), 'Board minutes 2026', 'tabs and line breaks are whitespace, so they collapse');
  assert.equal(documentFolder('Résumés'), 'Résumés', 'the same name typed two ways is one folder');
  assert.equal(documentFolder('a/b/c/d/e'), 'a/b/c/d/e', 'five levels are allowed');
  assert.equal(documentFolder('x'.repeat(60)), 'x'.repeat(60), 'sixty characters in one level are allowed');
  assert.equal(documentFolder(`${'x'.repeat(59)}/${'y'.repeat(60)}`).length, 120, 'a path of exactly 120 characters is allowed');
  assert.equal(documentFolder('\u{1F4C1}'.repeat(60)), '\u{1F4C1}'.repeat(60), 'characters are counted as characters, not as string units');
});

test('the normaliser refuses what is not text, too deep, too long or holds hidden characters', () => {
  for (const value of [42, true, {}, ['Financing']]) assert.match(refusal(value) ?? '', /must be text/, JSON.stringify(value));
  assert.match(refusal('a/b/c/d/e/f') ?? '', /at most 5 levels deep/);
  assert.match(refusal('x'.repeat(61)) ?? '', /folder name can be at most 60 characters/);
  assert.match(refusal(`${'x'.repeat(60)}/${'y'.repeat(60)}`) ?? '', /path can be at most 120 characters/);
  assert.match(refusal('Board\u0000minutes') ?? '', /hidden characters/);
  assert.match(refusal('Board\u007f') ?? '', /hidden characters/);
  assert.match(refusal('Financing​') ?? '', /hidden characters/, 'a zero-width space would make a second folder that reads as Financing');
  assert.match(refusal('​') ?? '', /hidden characters/, 'a folder whose name cannot be seen');
  assert.match(refusal('Board‮etunim') ?? '', /hidden characters/, 'a direction override would turn the name around on the page and in the log');
  assert.equal(refusal('//a//b//c//d//e//'), null, 'empty levels do not count towards the depth');
});

test('creating a document cleans its folder, and leaving it out files it under General', async () => {
  const made = await call('POST', `/api/c/${cid}/documents`, { name: 'Board consent', category: 'BOARD', folder: ' Board /  2026 ' }, admin);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.folder, 'Board/2026');
  const plain = await call('POST', `/api/c/${cid}/documents`, { name: 'Notes', category: 'OTHER' }, admin);
  assert.equal(plain.json.folder, 'General');

  const before = await count(cid);
  const odd = await call('POST', `/api/c/${cid}/documents`, { name: 'Odd', category: 'OTHER', folder: 12 }, admin);
  assert.equal(odd.status, 400);
  assert.match(odd.json.error, /must be text/);
  const deep = await call('POST', `/api/c/${cid}/documents`, { name: 'Deep', category: 'OTHER', folder: 'a/b/c/d/e/f' }, admin);
  assert.equal(deep.status, 400);
  assert.equal(await count(cid), before, 'nothing is created when the folder is refused');
});

test('uploading a file cleans its folder and refuses one too long instead of cutting it short', async () => {
  const r = await upload(cid, { name: 'spa.pdf', category: 'FINANCING', folder: ' Financing // Series  A ' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.folder, 'Financing/Series A');
  const none = await upload(cid, { name: 'loose.pdf', category: 'OTHER' }, admin);
  assert.equal(none.json.folder, 'General');

  const before = await count(cid);
  const long = await upload(cid, { name: 'long.pdf', category: 'OTHER', folder: 'x'.repeat(130) }, admin);
  assert.equal(long.status, 400);
  assert.match(long.json.error, /at most 60 characters/);
  const deep = await upload(cid, { name: 'deep.pdf', category: 'OTHER', folder: '1/2/3/4/5/6' }, admin);
  assert.equal(deep.status, 400);
  assert.match(deep.json.error, /at most 5 levels deep/);
  assert.equal(await count(cid), before, 'a refused upload stores nothing');
});

test('editing a document moves it to a cleaned path and the log says where it went', async () => {
  const doc = (await call('POST', `/api/c/${cid}/documents`, { name: 'Side letter', category: 'AGREEMENT', folder: 'Inbox' }, admin)).json;
  const moved = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: ' Financing/ Series A /Side letters ' }, admin);
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.folder, 'Financing/Series A/Side letters');

  const top = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: '' }, admin);
  assert.equal(top.json.folder, 'General', 'an empty folder puts it back in General');
  const same = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: ' General ' }, admin);
  assert.equal(same.status, 200);

  const renamed = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { name: 'Side letter, signed' }, admin);
  assert.equal(renamed.json.folder, 'General', 'an edit that does not mention the folder leaves it alone');
  const both = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { name: 'Side letter', folder: 'Legal' }, admin);
  assert.equal(both.json.folder, 'Legal');

  const logged = (await all<{ detail: string }>(
    "SELECT detail FROM audit_log WHERE entity_id = ? AND action = 'UPDATE'", doc.id)).map((r) => r.detail).sort();
  assert.deepEqual(logged, [
    'Document moved to folder "Financing/Series A/Side letters"',
    'Document moved to folder "General"',
    'Document updated',
    'Document updated (name: "Side letter" → "Side letter, signed")',
    'Document updated and moved to folder "Legal" (name: "Side letter, signed" → "Side letter")',
  ], 'a move names the folder; filing it where it already is, or a rename alone, is an ordinary update that names the old name');
});

test('a path too deep or too long is refused and the document stays where it was', async () => {
  const doc = (await call('POST', `/api/c/${cid}/documents`, { name: 'Charter', category: 'CHARTER', folder: 'Legal' }, admin)).json;
  const deep = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: 'a/b/c/d/e/f' }, admin);
  assert.equal(deep.status, 400);
  assert.match(deep.json.error, /at most 5 levels deep/);
  const long = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: `${'x'.repeat(60)}/${'y'.repeat(60)}` }, admin);
  assert.equal(long.status, 400);
  assert.match(long.json.error, /at most 120 characters/);
  const odd = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: ['Legal'] }, admin);
  assert.equal(odd.status, 400);
  const lookalike = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: 'Legal​/Archive' }, admin);
  assert.equal(lookalike.status, 400);
  assert.match(lookalike.json.error, /hidden characters/);
  assert.equal((await one<{ folder: string }>('SELECT folder FROM documents WHERE id = ?', doc.id))!.folder, 'Legal');
});

test('another company’s document is not found, and it is not moved', async () => {
  const theirs = (await call('POST', `/api/c/${other}/documents`, { name: 'Their charter', category: 'CHARTER', folder: 'Legal' }, admin)).json;
  const r = await call('PATCH', `/api/c/${cid}/documents/${theirs.id}`, { folder: 'Taken' }, admin);
  assert.equal(r.status, 404);
  assert.equal((await one<{ folder: string }>('SELECT folder FROM documents WHERE id = ?', theirs.id))!.folder, 'Legal');
});

/** A viewer of the test company, made the first time a test asks for one. */
let viewerToken: string | null = null;
async function viewer(): Promise<string> {
  if (viewerToken) return viewerToken;
  const member = await call('POST', `/api/c/${cid}/members`, { email: 'vic@example.com', name: 'Vic Lane', role: 'VIEWER' }, admin);
  const link = await call('POST', `/api/c/${cid}/members/${member.json.id}/reset-password`, { mode: 'link' }, admin);
  viewerToken = (await call('POST', '/api/auth/reset', { token: new URL(link.json.resetUrl).searchParams.get('token')!, password: 'vic-pass-123' })).token as string;
  return viewerToken;
}

test('a viewer cannot move a document', async () => {
  const doc = (await call('POST', `/api/c/${cid}/documents`, { name: 'Minutes', category: 'BOARD', folder: 'Board' }, admin)).json;
  const r = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: 'Elsewhere' }, await viewer());
  assert.equal(r.status, 403);
  assert.equal((await one<{ folder: string }>('SELECT folder FROM documents WHERE id = ?', doc.id))!.folder, 'Board');
});

test('a document out for signature can still be put in another folder', async () => {
  const doc = (await call('POST', `/api/c/${cid}/documents`, {
    name: 'Consulting agreement', category: 'AGREEMENT', folder: 'Contracts', requiresSignature: true,
    signers: [{ name: 'Jordan Pike', email: 'jordan@example.com' }],
  }, admin)).json;
  assert.equal(doc.status, 'AWAITING_SIGNATURE');
  const r = await call('PATCH', `/api/c/${cid}/documents/${doc.id}`, { folder: 'Contracts/Out for signature' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.folder, 'Contracts/Out for signature');
});

// ---------------------------------------------------------------------------
// Moving several documents at once
// ---------------------------------------------------------------------------

const folderOf = async (id: string) => (await one<{ folder: string }>('SELECT folder FROM documents WHERE id = ?', id))!.folder;
const moveLog = async (id: string) =>
  (await all<{ detail: string }>("SELECT detail FROM audit_log WHERE entity_id = ? AND action = 'UPDATE' ORDER BY created_at", id)).map((r) => r.detail);
const make = async (name: string, folder: string, company = cid) =>
  (await call('POST', `/api/c/${company}/documents`, { name, category: 'OTHER', folder }, admin)).json as { id: string };

test('several documents move in one request, each folder cleaned, and each is logged once', async () => {
  const a = await make('Term sheet', 'Inbox');
  const b = await make('Stock purchase agreement', 'Inbox/Later');
  const c = await make('Investor rights', 'Legal');
  const r = await call('POST', `/api/c/${cid}/documents/move`, {
    moves: [{ id: a.id, folder: ' Financing /  Series B ' }, { id: b.id, folder: 'Financing//Series B/' }, { id: c.id, folder: '' }],
  }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.map((d: { id: string; folder: string }) => [d.id, d.folder]),
    [[a.id, 'Financing/Series B'], [b.id, 'Financing/Series B'], [c.id, 'General']], 'every document, in the order asked, as it now stands');
  assert.equal(r.json[0].face, undefined, 'the stored front page is not sent back');
  assert.equal(r.json[0].hasFace, false);

  assert.equal(await folderOf(a.id), 'Financing/Series B');
  assert.equal(await folderOf(b.id), 'Financing/Series B');
  assert.equal(await folderOf(c.id), 'General');
  assert.deepEqual(await moveLog(a.id), ['Document moved to folder "Financing/Series B"']);
  assert.deepEqual(await moveLog(b.id), ['Document moved to folder "Financing/Series B"']);
  assert.deepEqual(await moveLog(c.id), ['Document moved to folder "General"']);
});

test('undoing a move sends each document back to its own folder in the same way', async () => {
  const a = await make('Board deck', 'Board/2026');
  const b = await make('Budget', 'Finance');
  await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: a.id, folder: 'Archive' }, { id: b.id, folder: 'Archive' }] }, admin);
  const back = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: a.id, folder: 'Board/2026' }, { id: b.id, folder: 'Finance' }] }, admin);
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(await folderOf(a.id), 'Board/2026');
  assert.equal(await folderOf(b.id), 'Finance');
  assert.deepEqual(await moveLog(a.id), ['Document moved to folder "Archive"', 'Document moved to folder "Board/2026"']);
});

test('a document already in the folder asked for is left alone and not logged', async () => {
  const here = await make('Cap table export', 'Reports');
  const there = await make('Option ledger', 'Ledgers');
  const r = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: here.id, folder: ' Reports ' }, { id: there.id, folder: 'Reports' }] }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.map((d: { folder: string }) => d.folder), ['Reports', 'Reports']);
  assert.deepEqual(await moveLog(here.id), [], 'nothing happened to it, so nothing is logged');
  assert.deepEqual(await moveLog(there.id), ['Document moved to folder "Reports"']);
});

test('one document that is not this company’s refuses the whole batch and moves nothing', async () => {
  const mine = await make('Bylaws', 'Legal');
  const also = await make('Charter amendment', 'Legal');
  const theirs = await make('Their bylaws', 'Legal', other);
  for (const foreign of [theirs.id, 'doc_does_not_exist']) {
    const r = await call('POST', `/api/c/${cid}/documents/move`, {
      moves: [{ id: mine.id, folder: 'Governance' }, { id: also.id, folder: 'Governance' }, { id: foreign, folder: 'Governance' }],
    }, admin);
    assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.equal(r.json.error, 'Some of those documents were not found, so none were moved.',
      'another company’s document reads exactly as one that does not exist');
  }
  for (const id of [mine.id, also.id, theirs.id]) {
    assert.equal(await folderOf(id), 'Legal');
    assert.deepEqual(await moveLog(id), []);
  }
  const alone = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: theirs.id, folder: 'Taken' }] }, admin);
  assert.equal(alone.status, 404);
  assert.equal(alone.json.error, 'Document not found.');
  assert.equal(await folderOf(theirs.id), 'Legal');
});

test('one folder the rule refuses refuses the whole batch', async () => {
  const a = await make('Consent A', 'Board');
  const b = await make('Consent B', 'Board');
  const deep = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: a.id, folder: 'Minutes' }, { id: b.id, folder: 'a/b/c/d/e/f' }] }, admin);
  assert.equal(deep.status, 400);
  assert.match(deep.json.error, /at most 5 levels deep/);
  const hidden = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: a.id, folder: 'Minutes' }, { id: b.id, folder: 'Minutes​' }] }, admin);
  assert.equal(hidden.status, 400);
  assert.match(hidden.json.error, /hidden characters/);
  const odd = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: a.id, folder: 'Minutes' }, { id: b.id, folder: 7 }] }, admin);
  assert.equal(odd.status, 400);
  assert.match(odd.json.error, /must be text/);
  assert.equal(await folderOf(a.id), 'Board');
  assert.equal(await folderOf(b.id), 'Board');
});

test('a batch has to name between one and the most documents, each once, each with a folder', async () => {
  const doc = await make('Side letter B', 'Inbox');
  const refused = async (body: unknown, pattern: RegExp) => {
    const r = await call('POST', `/api/c/${cid}/documents/move`, body, admin);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.json.error, pattern);
  };
  await refused({}, /at least one document/);
  await refused({ moves: [] }, /at least one document/);
  await refused({ moves: { id: doc.id, folder: 'A' } }, /at least one document/);
  await refused({ moves: [{ folder: 'A' }] }, /document id and a folder/);
  await refused({ moves: [{ id: 42, folder: 'A' }] }, /document id and a folder/);
  await refused({ moves: [{ id: doc.id }] }, /document id and a folder/);
  await refused({ moves: ['Inbox'] }, /document id and a folder/);
  await refused({ moves: [{ id: doc.id, folder: 'A' }, { id: doc.id, folder: 'B' }] }, /only once/);
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `doc_missing_${i}`, folder: 'A' }));
  await refused({ moves: many(DOCUMENT_MOVE_MAX + 1) }, new RegExp(`At most ${DOCUMENT_MOVE_MAX} documents`));
  // The most allowed gets past the count and is answered for what it names.
  assert.equal((await call('POST', `/api/c/${cid}/documents/move`, { moves: many(DOCUMENT_MOVE_MAX) }, admin)).status, 404);
  assert.equal(await folderOf(doc.id), 'Inbox');
});

test('a viewer cannot move documents in bulk either', async () => {
  const a = await make('Minutes 1', 'Board');
  const b = await make('Minutes 2', 'Board');
  const r = await call('POST', `/api/c/${cid}/documents/move`, { moves: [{ id: a.id, folder: 'Elsewhere' }, { id: b.id, folder: 'Elsewhere' }] }, await viewer());
  assert.equal(r.status, 403);
  assert.equal(await folderOf(a.id), 'Board');
  assert.equal(await folderOf(b.id), 'Board');
  assert.deepEqual(await moveLog(a.id), []);
});
