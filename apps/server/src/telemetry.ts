/**
 * What the server says about itself: one JSON line per request, every server
 * error, and the product events worth counting. All of it goes to the process
 * log. With analytics.posthog.key set, events and errors go to PostHog through
 * its Node SDK, and the log lines to PostHog Logs over OTLP, which the SDK does
 * not speak. Without a key nothing leaves the machine.
 */
import { PostHog } from 'posthog-node';
import { config } from './config.ts';

type Fields = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';

const SEVERITY: Record<Level, number> = { info: 9, warn: 13, error: 17 };
const records: object[] = [];
let timer: NodeJS.Timeout | null = null;
let client: PostHog | null = null;
let clientKey = '';

/** The SDK client for the configured project, made on first use and remade when the key changes. */
function posthog(): PostHog | null {
  const { key, host } = config().analytics.posthog;
  if (!key) return null;
  if (!client || clientKey !== key) {
    void client?.shutdown();
    client = new PostHog(key, {
      host,
      enableExceptionAutocapture: true,
      flushAt: 20,
      flushInterval: 2000,
      fetch: (url, options) => globalThis.fetch(url, options),
    });
    client.on('error', (err: Error) => console.error(`[telemetry] ${err.message}`));
    clientKey = key;
  }
  return client;
}

function later(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, 2000);
  timer.unref();
}

/** Sends what has queued. Called on the timer, at shutdown, and by tests. */
export async function flush(): Promise<void> {
  const ph = posthog();
  const logs = records.splice(0);
  if (!ph) return;
  await Promise.all([
    ph.flush(),
    logs.length ? fetch(`${config().analytics.posthog.host}/i/v1/logs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientKey}` }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'kosmitor' } }] }, scopeLogs: [{ logRecords: logs }] }] }),
    }).catch((err: Error) => console.error(`[telemetry] logs: ${err.message}`)) : null,
  ]);
}

/** Flushes and stops the SDK; for the process's exit. */
export async function shutdown(): Promise<void> {
  await flush();
  await client?.shutdown();
  client = null;
}

/** A product event by a person: who, what, and the few facts to count by. */
export function track(distinctId: string, event: string, properties: Fields = {}): void {
  posthog()?.capture({ distinctId, event, properties });
}

/** One line to the process log (stderr for errors), and the same record to PostHog Logs. */
export function log(level: Level, message: string, fields: Fields = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  (level === 'error' ? console.error : console.log)(line);
  if (!posthog()) return;
  records.push({
    timeUnixNano: `${Date.now()}000000`, severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: { stringValue: message },
    attributes: Object.entries(fields).filter(([, v]) => v != null)
      .map(([key, v]) => ({ key, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) } })),
  });
  later();
}

/** A server error: the stack in the log, and an issue in PostHog error tracking for the person who hit it. */
export function reportError(err: unknown, fields: Fields = {}, distinctId = 'server'): void {
  const e = err instanceof Error ? err : new Error(String(err));
  log('error', e.message, { ...fields, stack: e.stack });
  posthog()?.captureException(e, distinctId, fields);
}
