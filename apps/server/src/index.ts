import './env.ts';
import { createServer } from 'node:http';
import { config, ConfigError, type KosmitorConfig } from './config.ts';

// The param file is read before anything else loads, so a mistake in it stops the
// server here with every problem named, rather than as a stack trace from
// whichever module happened to read a setting first. The rest is imported after.
let settings: KosmitorConfig;
try {
  settings = config();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Refusing to start. ${err.message}`);
  process.exit(1);
}

const { handle } = await import('./http.ts');
const { migrate, close, DATABASE_URL } = await import('./db.ts');
const { mailConfigured } = await import('./mail.ts');
const { migrateLegacyFiles } = await import('./routes/files.ts');
const { WEB_DIST, hasWebBuild } = await import('./static.ts');
// Each module registers its routes as it loads; the order is kept, since it breaks ties between equal matches.
for (const name of [
  'health', 'auth', 'entities', 'analytics', 'workflows', 'offers', 'fundraising', 'communications', 'company',
  'certificates', 'report-builder', 'tax-forms', 'imports', 'data', 'search', 'captable-export', 'certificate-detail',
  'security-documents', 'instrument-detail', 'ai', 'valuation-requests', 'valuation-report', 'my-actions',
]) {
  await import(`./routes/${name}.ts`);
}

const isLocal = (url: string): boolean => {
  try {
    return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$|\.localhost$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

// In production the deployment must say where the database lives; a silent default is how data ends up in the wrong place.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('Refusing to start: missing environment DATABASE_URL.');
    process.exit(1);
  }
  if (isLocal(settings.app.url)) {
    console.warn(`app.url is ${settings.app.url}, so every link in an email points at the recipient's own machine. Set APP_URL, or app.url in kosmitor.config.local.json, to the public address.`);
  }
  if (!mailConfigured()) console.warn('Mail is not configured (set ACS_CONNECTION_STRING or SMTP_URL): nothing is emailed; invitations and reset links have to be shared from the screen.');
}

try {
  await migrate();
  await migrateLegacyFiles();
} catch (err) {
  const target = DATABASE_URL.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
  console.error(`Could not prepare the database at ${target}: ${(err as Error).message}`);
  console.error('Is PostgreSQL running, and does the database exist? Try: npm run db:create');
  process.exit(1);
}

// The demo card hands out an account; make sure it opens onto the sample company.
// A failure here is logged and the server starts anyway.
try {
  const { ensureDemoCompany } = await import('./sample.ts');
  const created = await ensureDemoCompany();
  if (created) console.log(`Created the sample company ${created} for the demo account (demo.enabled).`);
} catch (err) {
  console.error('Could not create the sample company for the demo account:', (err as Error).message);
}

const server = createServer((req, res) => {
  void handle(req, res);
});

// Stopping the container: let what is queued for PostHog go out first.
const { shutdown } = await import('./telemetry.ts');
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { server.close(); void shutdown().finally(() => process.exit(0)); });
}

const { port } = settings.server;
server.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(hasWebBuild() ? `Serving the web app from ${WEB_DIST}` : 'No web build found; the API runs alone (use the Vite dev server).');
});

// A welcome email goes after its sign-up has answered, so stopping waits for those on their way as well as for open requests.
const { welcomesSent } = await import('./routes/auth.ts');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => { void welcomesSent().then(() => close()).finally(() => process.exit(0)); });
  });
}
