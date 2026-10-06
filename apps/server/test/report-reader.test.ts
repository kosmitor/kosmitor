/**
 * Reading an uploaded report off the server's own thread.
 *
 * Pinned here: the worker reads what the same code reads in place; reports wait
 * their turn, and past a few in line the next is turned away at once; a reading
 * that takes too long or needs too much memory comes back as nothing read, with
 * the reason in the log, rather than failing; and while a report is read the
 * server's own thread keeps answering.
 *
 * Every PDF here is made up. Nothing here reaches the database.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readReport, ReaderBusy } = await import('../src/report-reader.ts');
const { pdfText } = await import('../src/pdf-text.ts');
const { detectReport, nothingDetected } = await import('../src/report-detect.ts');
const { documentPdf } = await import('../src/pdf-writer.ts');

// The reader says in the log why a report was not read; collected here, not printed.
const logged: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
after(() => { console.error = realError; });

/** A made-up appraisal report, written by the app's own PDF writer. */
const REPORT = documentPdf({
  company: 'Ledgerline Valuations',
  title: 'Valuation of the common stock of Marlowe Systems, Inc.',
  body: [
    `Valuation Date: ${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}`,
    'Based on our analysis, we concluded that the fair market value of the common stock is $0.42 per share on a non-marketable, minority basis.',
    'We relied on the OPM backsolve method, calibrated to the Series A financing.',
  ].join('\n'),
  signatures: [],
  footer: 'Prepared by Ledgerline Valuations',
});

/**
 * A few kilobytes that keep a reader busy for a while: one page drawing a
 * one-megabyte form over and over, until the limit on content drawn stops it.
 */
function slowReport(): Buffer {
  const line = 'BT /F1 12 Tf 72 700 Td (Fair market value) Tj ET\n';
  const form = deflateSync(Buffer.from(line.repeat(Math.ceil(1024 * 1024 / line.length))));
  const content = deflateSync(Buffer.from('/X Do\n'.repeat(300)));
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
      + '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >> >> endobj\n'
      + `4 0 obj << /Length ${content.length} /Filter /FlateDecode >> stream\n`, 'latin1'),
    content,
    Buffer.from('\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
      + `6 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length ${form.length} /Filter /FlateDecode >> stream\n`, 'latin1'),
    form,
    Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

test('the worker reads what the same code reads in place', async () => {
  const read = await readReport(REPORT);
  const text = pdfText(REPORT);
  assert.ok(text.readable);
  if (!text.readable) return;
  assert.deepEqual(read, detectReport(text.pages));
  assert.equal(read.fairMarketValue?.value, 420_000);
  assert.equal(read.method?.value, 'OPM backsolve');
});

test('reports wait their turn, and past a few in line the next is turned away at once', async () => {
  const inLine = [1, 2, 3, 4].map(() => readReport(REPORT));
  await assert.rejects(readReport(REPORT), ReaderBusy);
  for (const read of await Promise.all(inLine)) assert.equal(read.fairMarketValue?.value, 420_000);
  // Once the line has gone down, the next is read.
  assert.equal((await readReport(REPORT)).fairMarketValue?.value, 420_000);
});

test('a reading that takes too long, or needs too much memory, comes back as nothing read and says why in the log', async () => {
  logged.length = 0;
  assert.deepEqual(await readReport(REPORT, { timeoutMs: 1 }), nothingDetected(false));
  assert.match(logged.join('\n'), /\[409a\] an uploaded report was not read: it took longer than 1 ms/);
  logged.length = 0;
  assert.deepEqual(await readReport(REPORT, { memoryMb: 4 }), nothingDetected(false));
  assert.match(logged.join('\n'), /\[409a\] an uploaded report was not read: .*memory/);
  // And the reader is none the worse for it.
  assert.equal((await readReport(REPORT)).fairMarketValue?.value, 420_000);
});

test('under node --watch, as npm run dev runs the server, the report is still read', async () => {
  // Watch mode posts the worker's imports to the server on the reader's own
  // channel before the worker answers, and that is not what it read.
  const scratch = mkdtempSync(join(tmpdir(), 'kosmitor-reader-'));
  writeFileSync(join(scratch, 'report.pdf'), REPORT);
  const script = join(scratch, 'read.ts');
  writeFileSync(script, [
    `import { readFileSync } from 'node:fs';`,
    `import { readReport } from ${JSON.stringify(new URL('../src/report-reader.ts', import.meta.url).href)};`,
    `const read = await readReport(readFileSync(${JSON.stringify(join(scratch, 'report.pdf'))}));`,
    `console.log('READ ' + JSON.stringify(read));`,
  ].join('\n'));
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawn(process.execPath, ['--watch', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no answer under --watch: ${out}`)), 20_000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const found = out.match(/^READ (.*)$/m);
        if (found) { clearTimeout(timer); resolve(found[1]); }
      });
      child.stderr.on('data', (chunk) => { out += chunk; });
    });
    const read = JSON.parse(line);
    assert.equal(read.readable, true);
    assert.equal(read.fairMarketValue?.value, 420_000);
    assert.equal(read.method?.value, 'OPM backsolve');
  } finally {
    child.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('while a report is read, the server’s own thread keeps answering', async () => {
  // Read in place, a file like this holds the thread for the whole reading, and
  // nothing else on the server is answered until it is done.
  const file = slowReport();
  let ticks = 0;
  const ticking = setInterval(() => { ticks++; }, 20);
  try {
    const started = Date.now();
    const read = await readReport(file);
    const took = Date.now() - started;
    assert.equal(read.readable, false, 'the limit on content drawn stops it');
    assert.ok(took > 200, `it took a while to read (${took} ms)`);
    assert.ok(ticks >= 5, `${ticks} ticks in ${took} ms`);
  } finally {
    clearInterval(ticking);
  }
});
