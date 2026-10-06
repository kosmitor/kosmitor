/**
 * A transaction holds one connection, and pg 9 refuses a query sent to it while
 * another is still running. Reads that fan out on the pool take turns inside one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';

await freshDatabase();

const { concurrently, transaction, insert } = await import('../src/db.ts');
const { getCompanyData } = await import('../src/store.ts');

// Each task logs when it starts and ends, so the log shows whether any overlapped.
const tasks = (log: string[]) => [1, 2, 3].map((n) => async () => {
  log.push(`start ${n}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  log.push(`end ${n}`);
  return n;
});

test('outside a transaction the tasks all start at once', async () => {
  const log: string[] = [];
  assert.deepEqual(await concurrently(tasks(log)), [1, 2, 3]);
  assert.deepEqual(log.slice(0, 3), ['start 1', 'start 2', 'start 3']);
});

test('inside a transaction each task finishes before the next starts', async () => {
  const log: string[] = [];
  assert.deepEqual(await transaction(() => concurrently(tasks(log))), [1, 2, 3]);
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});

test('the company snapshot loads inside a write without overlapping queries on its connection', async () => {
  const now = new Date().toISOString();
  await insert('companies', { id: 'co_tx', name: 'Turns Co', createdAt: now });
  // helpers.ts fails this test if pg reports a query sent to a busy connection.
  const data = await transaction(async () => {
    await insert('stakeholders', { id: 'sh_tx', companyId: 'co_tx', name: 'Ada Park', type: 'INDIVIDUAL', relation: 'FOUNDER', createdAt: now });
    return getCompanyData('co_tx');
  });
  assert.deepEqual(data.stakeholders.map((s) => s.name), ['Ada Park']);
});
