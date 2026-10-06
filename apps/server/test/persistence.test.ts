import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { freshDatabase } from './helpers.ts';

// Point the legacy uploads directory at a scratch folder before files.ts loads.
const legacyDir = mkdtempSync(join(tmpdir(), 'kosmitor-legacy-'));
process.env.CT_LEGACY_UPLOAD_DIR = legacyDir;
await freshDatabase();

const { insert, one, run } = await import('../src/db.ts');
const { storeFile, readFile, migrateLegacyFiles } = await import('../src/routes/files.ts');

const now = new Date().toISOString();
await insert('companies', { id: 'co_files', name: 'Files Co', createdAt: now });
const doc = async (id: string, storageKey: string | null) =>
  insert('documents', { id, companyId: 'co_files', name: id, category: 'OTHER', folder: 'General', body: '',
    requiresSignature: 0, status: 'FINAL', visibility: 'ADMIN', storageKey, createdAt: now });

test('file contents round-trip through the database byte for byte, including binary', async () => {
  await doc('doc_bin', 'db:doc_bin');
  const bytes = randomBytes(300_000);           // well past any text-encoding path
  await storeFile('doc_bin', 'co_files', bytes);
  const back = await readFile('doc_bin');
  assert.ok(back && back.equals(bytes));
  const meta = await one<{ size_bytes: number; sha256: string }>('SELECT size_bytes, sha256 FROM file_blobs WHERE document_id = ?', 'doc_bin');
  assert.equal(meta!.size_bytes, 300_000);
  assert.equal(meta!.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('storing again replaces the previous content, and deleting the document removes its file', async () => {
  await doc('doc_replace', 'db:doc_replace');
  await storeFile('doc_replace', 'co_files', Buffer.from('first'));
  await storeFile('doc_replace', 'co_files', Buffer.from('second'));
  assert.equal((await readFile('doc_replace'))!.toString(), 'second');
  await run('DELETE FROM documents WHERE id = ?', 'doc_replace');
  assert.equal(await readFile('doc_replace'), null);          // cascaded with the document
});

test('files an earlier build left on disk are moved into the database once', async () => {
  mkdirSync(join(legacyDir, 'co_files'), { recursive: true });
  writeFileSync(join(legacyDir, 'co_files', 'doc_legacy'), 'from the old uploads folder');
  writeFileSync(join(legacyDir, 'co_files', 'orphan'), 'nothing references me');
  await doc('doc_legacy', 'co_files/doc_legacy');

  assert.equal(await migrateLegacyFiles(), 1);
  assert.equal((await readFile('doc_legacy'))!.toString(), 'from the old uploads folder');
  const row = await one<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = ?', 'doc_legacy');
  assert.equal(row!.storage_key, 'db:doc_legacy');
  assert.equal(existsSync(join(legacyDir, 'co_files', 'doc_legacy')), false);
  assert.equal(existsSync(join(legacyDir, 'co_files', 'orphan')), true);   // unreferenced files are left alone
  assert.equal(await migrateLegacyFiles(), 0);                             // nothing left to do
});

test('money columns hold values beyond 32 bits', async () => {
  await insert('stakeholders', { id: 'stk_big', companyId: 'co_files', name: 'Big', type: 'FUND', relation: 'INVESTOR', createdAt: now });
  await insert('convertibles', { id: 'cnv_big', companyId: 'co_files', stakeholderId: 'stk_big', instrument: 'NOTE',
    principal: 5_000_000_000_00, issueDate: '2024-01-01', valuationCap: 90_000_000_000_00, discount: 0, interestRate: 0,
    compounding: 'SIMPLE', mfn: 0, proRataRight: 0, status: 'OUTSTANDING', createdAt: now });
  const row = await one<{ principal: number; valuation_cap: number }>('SELECT principal, valuation_cap FROM convertibles WHERE id = ?', 'cnv_big');
  assert.equal(typeof row!.principal, 'number');                           // BIGINT comes back as a number, not a string
  assert.equal(row!.principal, 5_000_000_000_00);
  assert.equal(row!.valuation_cap, 90_000_000_000_00);
});
