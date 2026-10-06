/**
 * Loads apps/server/.env before any other module reads process.env.
 *
 * Imported first by index.ts so that the settings loader (config.ts), which
 * layers a few environment variables over kosmitor.config.json, sees the file's
 * values regardless of the working directory the process was started from.
 * Existing environment variables win over the file, so deployments can override it.
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = resolve(SERVER_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
