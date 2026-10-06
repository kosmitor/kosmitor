/**
 * Probes for the platform running the server. /api/health says the process is
 * alive; /api/ready says it can reach the database, and answers 503 until it can.
 */
import { route } from '../http.ts';
import { one } from '../db.ts';

const startedAt = Date.now();

route.get('/api/health', 'public', async () => ({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));

route.get('/api/ready', 'public', async (ctx) => {
  try {
    await one('SELECT 1 AS ok');
    return { ok: true, database: 'up' };
  } catch (err) {
    const body = JSON.stringify({ ok: false, database: 'down', error: (err as Error).message });
    ctx.res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end(body);
    return undefined;
  }
});
