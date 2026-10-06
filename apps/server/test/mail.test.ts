/**
 * The SMTP client against a stand-in server on localhost: greeting, EHLO,
 * AUTH PLAIN, envelope, DATA with dot-stuffing, QUIT — and the message it builds.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

process.env.MAIL_FROM = 'Kosmitor <no-reply@kosmitor.test>';
const { smtpSend, buildMessage, appUrl } = await import('../src/mail.ts');

interface Recorded { commands: string[]; data: string }
const recorded: Recorded = { commands: [], data: '' };
const smtp: Server = createServer((socket: Socket) => {
  let inData = false;
  let buffer = '';
  socket.write('220 stand-in ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (inData) {
        if (line === '.') { inData = false; socket.write('250 2.0.0 queued as abc123\r\n'); }
        else recorded.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        continue;
      }
      recorded.commands.push(line);
      if (/^EHLO /.test(line)) socket.write('250-stand-in\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');   // no STARTTLS: allowed on localhost
      else if (/^AUTH PLAIN /.test(line)) socket.write(line.endsWith(Buffer.from('\0sender\0s3cret p@ss').toString('base64')) ? '235 ok\r\n' : '535 bad credentials\r\n');
      else if (/^MAIL FROM:/.test(line)) socket.write('250 ok\r\n');
      else if (/^RCPT TO:/.test(line)) socket.write(line.includes('bounce@') ? '550 no such user\r\n' : '250 ok\r\n');
      else if (line === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 what\r\n');
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const port = (smtp.address() as AddressInfo).port;
after(() => smtp.close());

test('a message goes through EHLO, AUTH PLAIN, the envelope and DATA, with dots stuffed', async () => {
  await smtpSend(`smtp://sender:s3cret%20p%40ss@127.0.0.1:${port}`, {
    id: '<test-1@kosmitor.test>', to: 'priya@example.com', toName: 'Priya Raman', subject: 'Reset your Kosmitor password — now',
    text: 'Hi Priya,\n.leading dot line\nhttps://app.example.com/reset-password?token=abc\n— Kosmitor',
    html: '<p>Hi <b>Priya</b></p>',
  });
  assert.match(recorded.commands[0], /^EHLO /);
  assert.match(recorded.commands[1], /^AUTH PLAIN /);
  assert.equal(recorded.commands[2], 'MAIL FROM:<no-reply@kosmitor.test>');
  assert.equal(recorded.commands[3], 'RCPT TO:<priya@example.com>');
  assert.equal(recorded.commands[4], 'DATA');
  assert.equal(recorded.commands[5], 'QUIT');
  assert.match(recorded.data, /^From: Kosmitor <no-reply@kosmitor.test>/m);
  assert.match(recorded.data, /^To: "Priya Raman" <priya@example.com>/m, 'the name quoted, the address its own');
  assert.match(recorded.data, /^Subject: =\?UTF-8\?B\?/m);                       // the em dash forces encoding
  assert.match(recorded.data, /^Message-ID: <test-1@kosmitor.test>/m);
  assert.match(recorded.data, /multipart\/alternative/);
  const textPart = recorded.data.split('Content-Transfer-Encoding: base64\n\n')[1].split('\n--')[0].replace(/\n/g, '');
  assert.equal(Buffer.from(textPart, 'base64').toString('utf8'), 'Hi Priya,\n.leading dot line\nhttps://app.example.com/reset-password?token=abc\n— Kosmitor');
});

test('rejections from the server become errors, and bad URLs are refused up front', async () => {
  await assert.rejects(() => smtpSend(`smtp://sender:wrong@127.0.0.1:${port}`, { id: '<t2>', to: 'a@example.com', subject: 's', text: 't' }), /Authentication: 535/);
  await assert.rejects(() => smtpSend(`smtp://sender:s3cret%20p%40ss@127.0.0.1:${port}`, { id: '<t3>', to: 'bounce@example.com', subject: 's', text: 't' }), /RCPT: 550/);
  await assert.rejects(() => smtpSend('http://example.com', { id: '<t4>', to: 'a@example.com', subject: 's', text: 't' }), /smtp:\/\/ or smtps:\/\//);
});

test('plain-text messages and link addresses', async () => {
  const plain = buildMessage({ id: '<t5>', to: 'a@example.com', subject: 'Plain', text: 'hello' });
  assert.match(plain, /Content-Type: text\/plain; charset=utf-8/);
  assert.doesNotMatch(plain, /multipart/);
  // Links are always app.url. The request's Origin used to stand in when it was
  // unset, which let a forged header aim a reset link at another site.
  const { configure, resetConfig } = await import('../src/config.ts');
  configure({ app: { url: 'https://app.example.com' } });
  try {
    assert.equal(appUrl('https://elsewhere.example.com'), 'https://app.example.com');
    assert.equal(appUrl(), 'https://app.example.com');
  } finally {
    resetConfig();
  }
});

test('a name can never redirect a message, and a recipient is one plain address', async () => {
  const { buildMessage: build, assertDeliverable, displayName } = await import('../src/mail.ts');
  // The old form spliced the name into the address line and read the first <...>
  // back out, so a name carrying its own address stole the message.
  const hostile = build({ id: '<t9>', to: 'priya@example.com', toName: 'Rae <thief@example.net>', subject: 's', text: 't' });
  assert.match(hostile, /^To: "Rae <thief@example.net>" <priya@example.com>$/m, 'the name is quoted text, the address is the real one');

  for (const bad of ['Rae <thief@example.net>', 'a@example.com, b@example.com', 'a@example.com\r\nBcc: b@example.com', 'nobody']) {
    assert.throws(() => assertDeliverable({ to: bad }), /single email address/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(displayName('Smith, Jane "JJ"'), '"Smith, Jane \\"JJ\\""', 'commas and quotes stay inside the quoted name');
  assert.match(displayName('Zoë Park'), /^=\?UTF-8\?B\?/, 'non-ASCII is encoded');
});
