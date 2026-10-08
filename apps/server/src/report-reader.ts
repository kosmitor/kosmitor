/**
 * Reading a report the valuation team uploads, or one a company imports on its
 * 409A page, off the server's own thread.
 *
 * The file comes from outside the company: through a link, or from an appraiser
 * by way of someone at the company who uploads it. pdf-text.ts and
 * report-detect.ts bound what a crafted file can make them do, but a bound is
 * only as good as the case someone thought of, and the server answers every
 * company from one thread. So the reading runs in a worker thread of its own,
 * with a ceiling on its memory and on its time. Whatever happens in there, the
 * rest of the server keeps answering: a report that takes too long, or runs the
 * worker out of memory, comes back with nothing read, and the values are typed
 * in as they would be for a scan.
 *
 * One report is read at a time on a server, and only a few uploads wait their
 * turn, so a burst of them queues up rather than piling onto the machine; past
 * that, an upload is turned away to try again shortly.
 *
 * The worker loads this same file, which then reads the PDF it was handed and
 * posts back what it found. It imports nothing that reaches the database.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pdfText } from './pdf-text.ts';
import { detectReport, nothingDetected, type ReportReading } from './report-detect.ts';

/** How long one report may take to read. A real one takes well under a second. */
const READ_MS = 20_000;
/** The most memory the reading may use, in megabytes, beyond the file and the streams it inflates, which pdf-text.ts caps. */
const READ_MEMORY_MB = 256;
/** How many uploads may be in line at once, the one being read included. */
const IN_LINE = 4;

/** The line is full: the upload should be tried again shortly. */
export class ReaderBusy extends Error {}

/** The reading going on now, or the last one, which the next waits for. */
let line: Promise<unknown> = Promise.resolve();
let inLine = 0;

export interface ReadOptions {
  /** The names of the company the report values, which are never read as its appraiser's. */
  names?: string[];
  /**
   * Places in the line this reading leaves free: a company's import leaves one,
   * so however many companies import at once, an upload of the valuation team's
   * still finds a place.
   */
  leave?: number;
  /** How long the reading may take. For tests. */
  timeoutMs?: number;
  /** The memory the reading may use, in megabytes. For tests. */
  memoryMb?: number;
}

/**
 * What a report states, read in a worker once the reports before it are done.
 * Never fails for anything in the file: a file that cannot be read, takes too
 * long or needs too much comes back as nothing read. Throws ReaderBusy, at once,
 * when the line is full.
 */
export async function readReport(pdf: Buffer, options: ReadOptions = {}): Promise<ReportReading> {
  if (inLine >= IN_LINE - (options.leave ?? 0)) throw new ReaderBusy('The server is busy reading other reports.');
  inLine++;
  const turn = line.then(() => readInWorker(pdf, options.names ?? [], options.timeoutMs ?? READ_MS, options.memoryMb ?? READ_MEMORY_MB));
  line = turn.catch(() => undefined);
  try {
    return await turn;
  } finally {
    inLine--;
  }
}

/** Whether a message from the worker is what it read, rather than something Node itself sent on the channel. */
const isDetection = (message: unknown): message is ReportReading =>
  typeof message === 'object' && message !== null && typeof (message as { readable?: unknown }).readable === 'boolean';

function readInWorker(pdf: Buffer, names: string[], timeoutMs: number, memoryMb: number): Promise<ReportReading> {
  return new Promise((resolve) => {
    let worker: Worker;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (detection: ReportReading, problem?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      // Said in the server's log, since the team is only told nothing could be read.
      if (problem) console.error(`[409a] an uploaded report was not read: ${problem}`);
      resolve(detection);
    };
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { readReport: true, pdf, names },
        resourceLimits: { maxOldGenerationSizeMb: memoryMb },
      });
    } catch (err) {
      done(nothingDetected(false), (err as Error).message);
      return;
    }
    timer = setTimeout(() => done(nothingDetected(false), `it took longer than ${timeoutMs} ms`), timeoutMs);
    // Only the reading counts. Under `node --watch` (npm run dev), Node posts the
    // worker's imports on the same channel first, { 'watch:import': [...] }, and
    // taking that for the answer read every report as nothing at all.
    worker.on('message', (message: unknown) => { if (isDetection(message)) done(message); });
    worker.once('error', (err) => done(nothingDetected(false), err.message));
    worker.once('exit', () => done(nothingDetected(false), 'the reader stopped without an answer'));
  });
}

// --- In the worker ----------------------------------------------------------------

if (!isMainThread && parentPort && (workerData as { readReport?: boolean } | null)?.readReport) {
  // The file arrives as plain bytes; pdfText reads a Buffer.
  const { pdf: bytes, names } = workerData as { pdf: Uint8Array; names: string[] };
  const text = pdfText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  parentPort.postMessage(text.readable ? detectReport(text.pages, { names }) : nothingDetected(false));
}
