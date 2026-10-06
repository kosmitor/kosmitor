/**
 * Sending through Azure Communication Services.
 *
 * Nothing leaves the machine here. What is worth pinning is the signature, because
 * Azure rejects a request whose signature is a byte out and the failure looks like
 * mail simply not arriving, and the payload, because a wrong field name is
 * accepted as valid JSON and silently drops the message body.
 *
 * The signature is checked against a value computed by hand from the documented
 * scheme rather than against whatever the code happens to produce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { parseAcsConnectionString, signAcsRequest, acsPayload, acsSend } from '../src/mail.ts';

const KEY = Buffer.from('a-test-access-key-for-signing').toString('base64');
const CONNECTION = `endpoint=https://kosmitor.communication.azure.com/;accesskey=${KEY}`;

test('a connection string is read in either order, and refused when incomplete', () => {
  const parsed = parseAcsConnectionString(CONNECTION);
  assert.equal(parsed.endpoint, 'https://kosmitor.communication.azure.com', 'the trailing slash is dropped');
  assert.equal(parsed.accessKey, KEY);

  const reversed = parseAcsConnectionString(`accesskey=${KEY};endpoint=https://kosmitor.communication.azure.com`);
  assert.deepEqual(reversed, parsed);

  assert.throws(() => parseAcsConnectionString('endpoint=https://x.communication.azure.com'), /accesskey/);
});

test('the signature is the one Azure computes, not merely a consistent one', () => {
  const config = parseAcsConnectionString(CONNECTION);
  const url = 'https://kosmitor.communication.azure.com/emails:send?api-version=2023-03-31';
  const body = '{"hello":"world"}';
  const date = 'Mon, 24 Sep 2026 12:00:00 GMT';

  const headers = signAcsRequest(config, 'POST', url, body, date);

  // Worked out here from the scheme: verb, path with query, then date;host;body hash.
  const contentHash = createHash('sha256').update(body, 'utf8').digest('base64');
  const stringToSign = [
    'POST',
    '/emails:send?api-version=2023-03-31',
    `${date};kosmitor.communication.azure.com;${contentHash}`,
  ].join('\n');
  const expected = createHmac('sha256', Buffer.from(KEY, 'base64')).update(stringToSign, 'utf8').digest('base64');

  assert.equal(headers['x-ms-content-sha256'], contentHash);
  assert.equal(headers['x-ms-date'], date);
  assert.equal(headers.Authorization, `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expected}`);
});

test('the signature covers the body and the path, so neither can be swapped', () => {
  const config = parseAcsConnectionString(CONNECTION);
  const url = 'https://kosmitor.communication.azure.com/emails:send?api-version=2023-03-31';
  const date = 'Mon, 24 Sep 2026 12:00:00 GMT';
  const base = signAcsRequest(config, 'POST', url, '{"a":1}', date).Authorization;

  assert.notEqual(signAcsRequest(config, 'POST', url, '{"a":2}', date).Authorization, base, 'a different body');
  assert.notEqual(signAcsRequest(config, 'POST', `${url}&x=1`, '{"a":1}', date).Authorization, base, 'a different query');
  assert.notEqual(signAcsRequest(config, 'GET', url, '{"a":1}', date).Authorization, base, 'a different verb');
  assert.notEqual(signAcsRequest(config, 'POST', url, '{"a":1}', 'Tue, 25 Sep 2026 12:00:00 GMT').Authorization, base, 'a different minute');
});

test('the payload carries the sender, the recipient and both bodies', () => {
  const payload = acsPayload(
    { to: 'priya@example.com', toName: 'Priya Raman', subject: 'Your certificate', text: 'Plain words.', html: '<p>Plain words.</p>' },
    'Kosmitor <no-reply@kosmitor.com>',
  ) as any;

  assert.equal(payload.senderAddress, 'no-reply@kosmitor.com', 'the address only, never the display name');
  assert.deepEqual(payload.recipients.to, [{ address: 'priya@example.com', displayName: 'Priya Raman' }]);
  assert.equal(payload.content.subject, 'Your certificate');
  assert.equal(payload.content.plainText, 'Plain words.');
  assert.equal(payload.content.html, '<p>Plain words.</p>');
});

test('a message with no html part does not claim to have one', () => {
  const payload = acsPayload({ to: 'a@example.com', subject: 'Hello', text: 'Words.' }, 'no-reply@kosmitor.com') as any;
  assert.equal('html' in payload.content, false);
});

test('a message Azure accepts resolves, and one it refuses raises with the reason', async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    seen.push({ url: String(input), headers: init.headers, body: JSON.parse(String(init.body)) });
    return new Response('', { status: 202 });
  }) as typeof fetch;
  try {
    await acsSend(CONNECTION, { to: 'a@example.com', subject: 'Hi', text: 'There.' }, 'no-reply@kosmitor.com');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://kosmitor.communication.azure.com/emails:send?api-version=2023-03-31');
    assert.match(seen[0].headers.Authorization, /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/);
    assert.equal(seen[0].body.senderAddress, 'no-reply@kosmitor.com');

    globalThis.fetch = (async () => new Response('{"error":{"message":"DomainNotLinked"}}', { status: 400 })) as typeof fetch;
    await assert.rejects(
      acsSend(CONNECTION, { to: 'a@example.com', subject: 'Hi', text: 'There.' }),
      /HTTP 400.*DomainNotLinked/s,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
