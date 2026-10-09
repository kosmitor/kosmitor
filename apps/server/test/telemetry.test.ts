/**
 * Telemetry: nothing leaves the process without a PostHog key; with one, the
 * log lines, events and errors reach the right PostHog endpoints in the shapes
 * its ingestion expects. No database is needed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

const { configure, resetConfig } = await import('../src/config.ts');
const { flush, log, reportError, shutdown, track } = await import('../src/telemetry.ts');

// The SDK may gzip what it sends; the log records go as plain JSON.
const decode = async (body: any): Promise<any> => {
  if (typeof body === 'string') return JSON.parse(body);
  const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : Buffer.from(body);
  return JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8'));
};
const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  calls.push({ url: String(url), headers: init.headers, body: await decode(init.body) });
  return new Response('{}', { status: 200 });
}) as typeof fetch;
after(async () => { await shutdown(); globalThis.fetch = realFetch; resetConfig(); });

const quiet = { log: console.log, error: console.error };
console.log = () => {}; console.error = () => {};
after(() => Object.assign(console, quiet));

test('without a key, nothing is sent', async () => {
  track('u1', 'signed_up');
  log('info', 'GET /api/x', { status: 200 });
  reportError(new Error('boom'));
  await flush();
  assert.equal(calls.length, 0);
});

test('with a key, events and errors go to /batch/ and log lines to /i/v1/logs', async () => {
  configure({ analytics: { posthog: { key: 'phc_test', host: 'https://eu.i.posthog.com' } } });
  track('u1', 'signed_up', { via: 'password' });
  log('warn', 'POST /api/c/co_1/imports/parse', { status: 400, ms: 12, error: 'The file has no rows.' });
  reportError(new TypeError('boom'), { path: '/api/x' }, 'u1');
  await flush();

  const batch = calls.filter((c) => c.url.includes('/batch')).flatMap((c) => c.body.batch);
  assert.deepEqual(batch.map((e: any) => [e.event, e.distinct_id]), [['signed_up', 'u1'], ['$exception', 'u1']]);
  assert.equal(batch[0].properties.via, 'password');
  const exception = batch[1].properties;
  assert.equal(exception.$exception_list[0].type, 'TypeError');
  assert.equal(exception.$exception_list[0].value, 'boom');
  assert.ok(exception.$exception_list[0].stacktrace.frames.length > 0, 'the SDK parses the stack into frames');
  assert.equal(exception.path, '/api/x');

  const logs = calls.find((c) => c.url.endsWith('/i/v1/logs'))!;
  assert.equal(logs.headers.Authorization, 'Bearer phc_test');
  const records = logs.body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.deepEqual(records.map((r: any) => [r.severityText, r.body.stringValue]), [['WARN', 'POST /api/c/co_1/imports/parse'], ['ERROR', 'boom']]);
  const attrs = Object.fromEntries(records[0].attributes.map((a: any) => [a.key, a.value]));
  assert.deepEqual(attrs.status, { doubleValue: 400 });
  assert.deepEqual(attrs.error, { stringValue: 'The file has no rows.' });
  assert.ok(calls.every((c) => c.url.includes('/batch') || c.url.endsWith('/i/v1/logs')), calls.map((c) => c.url).join(' '));
});
