import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { HEAD_PLACEHOLDER, loadConfig, renderHead } from '../server/src/config.ts';

/** The head for a page, read from the param files each time so an edit shows on the next refresh. */
const fillHead = (html: string): string => html.replace(HEAD_PLACEHOLDER, () => renderHead(loadConfig()));

/**
 * Vite serves index.html itself in development and in `vite preview`, so it fills
 * the head the way the API server does in production: the title, icons, colours
 * and public settings from kosmitor.config.json. A build keeps the placeholder for
 * the server to fill when it serves the page.
 */
function kosmitorHead(): Plugin {
  return {
    name: 'kosmitor-head',
    transformIndexHtml: { order: 'pre', handler: (html, ctx) => (ctx.server ? fillHead(html) : html) },
    configurePreviewServer(server) {
      const page = resolve(server.config.root, server.config.build.outDir, 'index.html');
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const wantsPage = req.method === 'GET' && !path.startsWith('/api/') && (path === '/' || path.endsWith('.html') || !/\.[a-z0-9]{1,12}$/i.test(path));
        if (!wantsPage) return next();
        try {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(fillHead(await readFile(page, 'utf8')));
        } catch (err) { next(err); }
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwind(), kosmitorHead()],
  server: {
    port: 5173,
    // The API's port from the param file (server.port, or PORT in apps/server/.env). Read only
    // when serving: a build needs no API and must not depend on the param files.
    proxy: command === 'serve' ? { '/api': { target: `http://localhost:${loadConfig().server.port}`, changeOrigin: true } } : undefined,
  },
}));
