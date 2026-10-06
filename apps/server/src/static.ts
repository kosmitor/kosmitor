/**
 * Serves the built web app from the API process so both share one origin in
 * production: files under the Vite output folder, and index.html for every
 * client-side route. Nothing is served until a build exists. index.html has its
 * head filled from the param file on the way out (config.ts renderHead).
 */
import type { ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { SERVER_DIR } from './env.ts';
import { HEAD_PLACEHOLDER, renderHead } from './config.ts';

export const WEB_DIST = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : resolve(SERVER_DIR, '..', 'web', 'dist');
export const hasWebBuild = (): boolean => existsSync(join(WEB_DIST, 'index.html'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml',
};

/** Writes the file for a path, or index.html for a route; false when there is nothing to serve. */
export async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  if (!hasWebBuild()) return false;
  let rel: string;
  try { rel = normalize(decodeURIComponent(pathname)); } catch { return false; }
  let file = resolve(WEB_DIST, `.${rel}`);
  if (file !== WEB_DIST && !file.startsWith(WEB_DIST + sep)) return false;
  const looksLikeFile = /\.[a-z0-9]{1,12}$/i.test(rel);
  if (!looksLikeFile || !existsSync(file) || statSync(file).isDirectory()) {
    if (looksLikeFile) return false;                                          // a missing asset is a real 404
    file = join(WEB_DIST, 'index.html');                                      // a client-side route
    rel = '/index.html';
  }
  const ext = extname(file).toLowerCase();
  // The page carries the title, icons, colours and public settings from the param file.
  const body = file === join(WEB_DIST, 'index.html')
    ? Buffer.from((await readFile(file, 'utf8')).replace(HEAD_PLACEHOLDER, () => renderHead()))  // a function, so '$' in a setting is never a pattern
    : await readFile(file);
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Content-Length': body.length,
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (ext === '.html') Object.assign(headers, { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  res.writeHead(200, headers);
  res.end(body);
  return true;
}
