import { UNSHOWABLE, HEADER_SYNTAX, HAS_SUBSTANCE, NAME_MAX } from './names.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveStatic } from './static.ts';
import { randomUUID } from 'node:crypto';
import { isEditor, seesWholeCompany, userForToken, membershipFor, type AuthUser, type Membership, type Role } from './auth.ts';
import { insert, one, transaction } from './db.ts';
import { invalidate } from './store.ts';
import { config, megabytes } from './config.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  /** Present only on routes registered with `raw: true` (file uploads). */
  rawBody: Buffer | null;
  user: AuthUser | null;
  membership: Membership | null;
  companyId: string | null;
  ip: string;
}

export class HttpError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Sign in to continue.') => new HttpError(401, m);
export const forbidden = (m = 'You do not have access to this.') => new HttpError(403, m);
export const notFound = (m = 'Not found.') => new HttpError(404, m);

/** Refuses a member whose role sees only their own holdings, not the whole company. */
export function assertFullView(ctx: { membership: { role: string } | null }, message: string): void {
  if (!seesWholeCompany(ctx.membership?.role ?? '')) throw forbidden(message);
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RouteOptions {
  /** Deliver the request body untouched as `ctx.rawBody` instead of parsing JSON. */
  raw?: boolean;
  /**
   * Body size ceiling: for raw routes limits.uploadMb when not given, for JSON
   * routes limits.jsonBodyMb (the import's preview and commit, which carry every
   * row of several files, take limits.importJsonMb). A function is asked on every
   * request, so a limit taken from the settings follows them rather than the
   * value at start-up.
   */
  maxBytes?: number | (() => number);
  /**
   * Runs outside a transaction and without the company's lock, as a GET does.
   * Only for a route that writes nothing and waits on something slow, such as
   * reading a report: holding the lock meanwhile would keep every other change at
   * the company waiting for it.
   */
  unlocked?: boolean;
}

interface Route extends RouteOptions {
  method: Method;
  segments: string[];
  handler: Handler;
  /** Minimum access needed; company routes also require a membership. */
  access: 'public' | 'user' | 'read' | 'write' | 'admin';
}

const routes: Route[] = [];

function add(method: Method, path: string, access: Route['access'], handler: Handler, opts: RouteOptions = {}): void {
  const wrapped: Handler = method === 'GET' || access === 'public' || opts.unlocked ? handler : async (ctx) => {
    try {
      return await transaction(async () => {
        // Serialize company mutations before reading balances. This prevents two
        // concurrent exercises, transfers or grants from spending the same shares.
        if (ctx.companyId) await one('SELECT id FROM companies WHERE id = ? FOR UPDATE', ctx.companyId);
        return handler(ctx);
      });
    } finally {
      if (ctx.companyId) invalidate(ctx.companyId);
    }
  };
  routes.push({ method, segments: path.split('/').filter(Boolean), handler: wrapped, access, ...opts });
}

export const route = {
  get: (p: string, a: Route['access'], h: Handler) => add('GET', p, a, h),
  post: (p: string, a: Route['access'], h: Handler, o?: RouteOptions) => add('POST', p, a, h, o),
  patch: (p: string, a: Route['access'], h: Handler) => add('PATCH', p, a, h),
  put: (p: string, a: Route['access'], h: Handler, o?: RouteOptions) => add('PUT', p, a, h, o),
  del: (p: string, a: Route['access'], h: Handler) => add('DELETE', p, a, h),
};

/**
 * The matching route with the most literal segments wins, so `/pools/summary`
 * beats `/pools/:id` no matter which module registered first.
 */
export function match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  let best: { route: Route; params: Record<string, string>; literals: number } | null = null;
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    let literals = 0;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { ok = false; break; }
      else literals++;
    }
    if (ok && (!best || literals > best.literals)) best = { route: r, params, literals };
  }
  return best && { route: best.route, params: best.params };
}

/** A byte count in megabytes as the messages say it: "25", or "2.5" for a part. */
const inMegabytes = (bytes: number): string => String(Math.round((bytes / 1024 / 1024) * 10) / 10);

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, `The file is too large — the limit is ${inMegabytes(maxBytes)} MB.`, { code: 'too-large', limitMb: Number(inMegabytes(maxBytes)) });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, limit = megabytes(config().limits.jsonBodyMb)): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw badRequest('Request body is too large.', { code: 'body-too-large' });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw badRequest('Request body is not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object.');
  return body;
}

function cookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Cookies travel only over HTTPS in production. */
const COOKIE_SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie',
    `kosmitor_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config().auth.sessionDays * 86400}${COOKIE_SECURE}`);
}
export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `kosmitor_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_SECURE}`);
}

/**
 * Someone acting on a company's records without being one of its members, such
 * as the valuation team working a 409A request from its emailed link. They are
 * named for what they are, never by whatever account the browser happens to be
 * signed in to, and the company is told the action but not where it came from.
 */
export interface AuditActor { companyId: string; userName: string }

/** Writes one row to the audit log, and returns its id for the rare entry that is completed once its outcome is known. */
export async function audit(ctx: Ctx, action: string, entityType: string | null, entityId: string | null, detail?: string, actor?: AuditActor): Promise<string> {
  const id = `aud_${randomUUID().slice(0, 12)}`;
  await insert('audit_log', {
    id,
    companyId: actor ? actor.companyId : ctx.companyId,
    userId: actor ? null : ctx.user?.id ?? null,
    userName: actor ? actor.userName : ctx.user?.name ?? 'System',
    action, entityType, entityId, detail: detail ?? null, ipAddress: actor ? null : ctx.ip,
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** Origins allowed to call the API with credentials: app.url and server.allowedOrigins, plus the Vite dev server outside production. */
function allowedOrigin(origin: string): boolean {
  const { app, server } = config();
  if (origin === app.url.replace(/\/+$/, '') || server.allowedOrigins.some((o) => o.replace(/\/+$/, '') === origin)) return true;
  return process.env.NODE_ENV !== 'production' && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');
}

/**
 * Who is calling, for the audit log and signatures. X-Forwarded-For is whatever
 * the client chose to send, so it is believed only when server.trustProxy says a
 * proxy sits in front. Even then only its last entry is: proxies such as Azure
 * Container Apps ingress and nginx append the address they saw to whatever the
 * client sent, so the entries before it are the client's own claims.
 */
function clientIp(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress ?? '';
  if (!config().server.trustProxy) return socket;
  const forwarded = req.headers['x-forwarded-for'];
  const entries = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return entries.at(-1) || socket;
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (origin && allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  try {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const found = match(req.method ?? 'GET', url.pathname);
  if (!found) {
    // Anything that is not an API call is the web app: a built file, or index.html for a client-side route.
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && (await serveStatic(res, url.pathname))) return;
    json(res, 404, { error: 'No such endpoint.' });
    return;
  }

  const ip = clientIp(req);
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '') || null;
  const token = cookie(req, 'kosmitor_session') ?? bearer;
  const user = await userForToken(token);

  const ctx: Ctx = {
    req, res, url, params: found.params, query: url.searchParams,
    body: {}, rawBody: null, user, membership: null, companyId: found.params.cid ?? null, ip,
  };

    const { access } = found.route;
    if (access !== 'public') {
      if (!user) throw unauthorized();
      if (ctx.companyId) {
        const m = await membershipFor(user.id, ctx.companyId);
        if (!m) throw forbidden('You are not a member of this company.');
        ctx.membership = m;
        const role = m.role as Role;
        if (!seesWholeCompany(role) && access === 'read') {
          const suffix = url.pathname.split('/').slice(4).join('/');
          const permitted = suffix === '' || suffix === 'portal' || suffix === 'documents' || suffix === 'search'
            || /^documents\/[^/]+\/download$/.test(suffix) || /^documents\/[^/]+\/print$/.test(suffix) || /^documents\/[^/]+\/pdf$/.test(suffix)
            || /^compliance\/83b\/[^/]+\/print$/.test(suffix)
            || /^signatures\/[^/]+\/sign$/.test(suffix)
            || /^stakeholders\/[^/]+\/position$/.test(suffix)
            || suffix === 'exercise-requests' || /^exercise-requests\/[^/]+\/withdraw$/.test(suffix)
            || /^portal\/updates\/[^/]+\/read$/.test(suffix)
            || /^consents\/[^/]+\/vote$/.test(suffix)
            || /^issuances\/[^/]+\/detail$/.test(suffix)   // the handler refuses anyone else's certificate
            || /^securities\/[^/]+\/documents$/.test(suffix)   // filtered to what this holder may see
            || suffix === 'compliance-documents'   // same filter; a Rule 701 package is theirs to read
            || suffix === 'my-actions'   // only their own signatures, votes and payments (routes/my-actions.ts)
            || /^(awards|convertibles|warrants)\/[^/]+\/detail$/.test(suffix)   // each handler refuses anyone else's
            || ['model/exercise', 'model/exit-curve'].includes(suffix);
          if (!permitted) throw forbidden('Your role can only view your own portfolio.');
        }
        if (access === 'write' && !isEditor(role)) {
          throw forbidden('Your role is read-only for cap table changes.');
        }
        if (access === 'admin' && role !== 'ADMIN') {
          throw forbidden('Only workspace administrators can do this.');
        }
        // A sample company is for exploring: its records never change. Calculations that only read
        // (modelling, report runs, the import wizard up to its review step, reading a 409A report to
        // fill in the form), managing who may look at the sample, and removing it altogether stay possible.
        if (m.isSample && req.method !== 'GET' && req.method !== 'HEAD') {
          const suffix = url.pathname.split('/').slice(4).join('/');
          const computes = suffix.startsWith('model/') || suffix === 'report-builder/run'
            || suffix.startsWith('ai/chats') || suffix === 'valuations/report-reading'
            || (suffix.startsWith('imports/') && !suffix.endsWith('/commit'));
          const housekeeping = (suffix === '' && req.method === 'DELETE') || suffix === 'members' || suffix.startsWith('members/');
          if (!computes && !housekeeping) throw forbidden('This is sample data and cannot be changed.');
        }
      }
    }

    // The body is read only once the caller may make the request: someone signed out, or without
    // the role, is answered before a byte of a large upload or import is buffered.
    if (found.route.raw) {
      const { maxBytes } = found.route;
      ctx.rawBody = await readRawBody(req, typeof maxBytes === 'function' ? maxBytes() : maxBytes ?? megabytes(config().limits.uploadMb));
    }
    else if (req.method !== 'GET' && req.method !== 'DELETE') {
      const { maxBytes } = found.route;
      ctx.body = await readBody(req, typeof maxBytes === 'function' ? maxBytes() : maxBytes);
    }
    else ctx.body = {};

    const result = await found.route.handler(ctx);
    if (res.writableEnded || res.headersSent) return;   // the handler streamed its own response
    json(res, 200, result ?? { ok: true });
  } catch (err) {
    if (err instanceof URIError || err instanceof TypeError && /Invalid URL/.test(err.message)) {
      json(res, 400, { error: 'Malformed request URL or cookie.' });
    } else if (err instanceof HttpError) {
      // Given up on partway through its body (too large): the rest is not read, so the connection cannot carry
      // another request. A body never started on (not signed in, not allowed) is drained by Node as usual.
      if (!req.complete && req.readableDidRead && !res.headersSent) res.setHeader('Connection', 'close');
      json(res, err.status, { error: err.message, detail: err.detail });
    } else {
      console.error('[api]', (err as Error).stack ?? err);
      json(res, 500, { error: 'Something went wrong on our side.' });
    }
  }
}

export function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// --- input helpers ---------------------------------------------------------

export function str(v: unknown, field: string, opts: { max?: number; optional?: boolean } = {}): string {
  if (v == null || v === '') {
    if (opts.optional) return '';
    throw badRequest(`${field} is required.`);
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be text.`);
  const s = v.trim();
  if (!s && !opts.optional) throw badRequest(`${field} is required.`);
  if (opts.max && s.length > opts.max) throw badRequest(`${field} is too long.`);
  return s;
}

/** A person's name, as typed: the rules are in names.ts, where the sign-in code can reach them too. */
export function personName(v: unknown, field: string, opts: { max?: number } = {}): string {
  const max = opts.max ?? NAME_MAX;
  const s = str(v, field, { max: max * 4 }).normalize('NFC');
  if (UNSHOWABLE.test(s)) throw badRequest(`${field} contains a character that cannot be shown.`);
  if (HEADER_SYNTAX.test(s)) throw badRequest(`${field} cannot contain <, > or ".`);
  const tidy = s.replace(/\s+/g, ' ').trim();
  if (!HAS_SUBSTANCE.test(tidy)) throw badRequest(`${field} needs at least one letter or number.`);
  if (tidy.length > max) throw badRequest(`${field} is too long.`);
  return tidy;
}

export function num(v: unknown, field: string, opts: { min?: number; max?: number; optional?: boolean; integer?: boolean } = {}): number {
  if (v == null || v === '') {
    if (opts.optional) return 0;
    throw badRequest(`${field} is required.`);
  }
  if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !v.trim())) throw badRequest(`${field} must be a number.`);
  const n = Number(v);
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER || (opts.integer && !Number.isSafeInteger(n))) throw badRequest(`${field} must be a safe integer.`);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`);
  if (opts.min != null && n < opts.min) throw badRequest(`${field} must be at least ${opts.min}.`);
  if (opts.max != null && n > opts.max) throw badRequest(`${field} must be at most ${opts.max}.`);
  return n;
}

export function date(v: unknown, field: string, opts: { optional?: boolean } = {}): string {
  if (v == null || v === '') {
    if (opts.optional) return '';
    throw badRequest(`${field} is required.`);
  }
  const s = typeof v === 'string' ? v : '';
  const timestamp = Date.parse(`${s}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== s) throw badRequest(`${field} must be a real date in YYYY-MM-DD form.`);
  return s;
}

export function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 12)}`;
export const nowISO = (): string => new Date().toISOString();
