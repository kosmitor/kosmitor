/**
 * The public part of kosmitor.config.json: the brand, the defaults forms start
 * from, the limits pages state, and which optional features are on. The server
 * writes it into the page as a JSON block (apps/server/src/config.ts renderHead),
 * and the Vite dev server does the same, so it is there before anything renders.
 */
import type { PublicConfig } from '../../../packages/core/src/config-types.ts';

export type { PublicConfig };

function read(): PublicConfig {
  const block = document.getElementById('kosmitor-config');
  if (!block?.textContent) {
    throw new Error('This page has no configuration. Open it through the API server (npm start) or the dev servers (npm run dev), which add it.');
  }
  return JSON.parse(block.textContent) as PublicConfig;
}

export const config: PublicConfig = read();

/** The product name, for the many places that only need that. */
export const PRODUCT = config.brand.productName;
