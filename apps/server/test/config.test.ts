/**
 * The param file: the shipped defaults against their schema, the layers on top
 * of them (an overrides file, environment variables, configure() in tests), what
 * the browser is given, the page head, and the generated reference in
 * docs/configuration.md. No database is needed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { enginePolicy } from '@kosmitor/core';

type Json = Record<string, any>;

// Every test starts from the shipped defaults: an empty overrides file stands in
// for whatever kosmitor.config.local.json a developer keeps.
const scratch = mkdtempSync(join(tmpdir(), 'kosmitor-config-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
function overrides(settings: Json): string {
  const file = join(scratch, `overrides-${++files}.json`);
  writeFileSync(file, JSON.stringify(settings));
  return file;
}
process.env.KOSMITOR_CONFIG = overrides({});

const {
  CONFIG_DIR, ConfigError, ENV_OVERRIDES, checkAgainstSchema, config, configure, loadConfig, publicConfig, renderHead, resetConfig,
} = await import('../src/config.ts');
const { configDocsUpToDate, renderConfigDocs } = await import('../src/config-docs.ts');

const readJson = (file: string): Json => JSON.parse(readFileSync(resolve(CONFIG_DIR, file), 'utf8'));
const schema = readJson('kosmitor.config.schema.json');
const base = readJson('kosmitor.config.json');

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const MISSING = Symbol('missing');
const lookup = (node: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((n, key) => (isObject(n) && key in n ? n[key] : MISSING), node);

/** Every setting the schema declares, groups included, as dotted paths. */
function settingPaths(node: Json, prefix = ''): string[] {
  return Object.entries(node.properties ?? {})
    .filter(([key]) => key !== '$schema')
    .flatMap(([key, child]: [string, any]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return child.properties ? [path, ...settingPaths(child, path)] : [path];
    });
}

/** Runs fn with these environment variables (undefined removes one), then puts everything back. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  try {
    for (const [name, value] of Object.entries(vars)) set(name, value);
    resetConfig();
    fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) set(name, value);
    resetConfig();
  }
}

const noEnvOverrides = (): Record<string, undefined> => Object.fromEntries(ENV_OVERRIDES.map((e) => [e.name, undefined]));

const problem = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
  assert.match(err.message, pattern);
  return true;
};

test('the shipped file matches its schema and loads as it is', () => {
  assert.deepEqual(checkAgainstSchema(base, schema, true), []);
  withEnv(noEnvOverrides(), () => {
    const { $schema: _ignored, ...defaults } = base;
    assert.deepEqual(loadConfig(), defaults);
  });
});

test('every setting in the schema has a default and a description', () => {
  const missing = settingPaths(schema).filter((path) => lookup(base, path) === MISSING);
  assert.deepEqual(missing, [], 'settings declared in kosmitor.config.schema.json but absent from kosmitor.config.json');

  const undescribed: string[] = [];
  (function walk(node: Json, path: string) {
    for (const [key, child] of Object.entries<any>(node.properties ?? {})) {
      const at = path ? `${path}.${key}` : key;
      if (!child.description) undescribed.push(at);
      walk(child, at);
    }
    if (isObject(node.items)) walk(node.items, `${path}[]`);
  })(schema, '');
  assert.deepEqual(undescribed, []);

  for (const { name, path } of ENV_OVERRIDES) assert.notEqual(lookup(base, path), MISSING, `${name} sets ${path}, which is not a setting`);
});

test('an unknown key in the overrides file is refused, with the key named', () => {
  const file = overrides({ brand: { prodcutName: 'Acme' }, brnad: {} });
  withEnv({ KOSMITOR_CONFIG: file }, () => {
    assert.throws(() => config(), problem(/brand\.prodcutName is not a setting/));
    assert.throws(() => config(), problem(/brnad is not a setting/));
    assert.throws(() => config(), problem(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
  });
  withEnv({ KOSMITOR_CONFIG: join(scratch, 'nowhere.json') }, () => {
    assert.throws(() => config(), problem(/which does not exist/));
  });
});

test('a value of the wrong type is refused', () => {
  const file = overrides({ server: { port: '4000' }, auth: { selfSignup: 'no' } });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: file }, () => {
    assert.throws(() => config(), problem(/2 problems/));
    assert.throws(() => config(), problem(/server\.port must be an integer, not "4000"/));
    assert.throws(() => config(), problem(/auth\.selfSignup must be a boolean/));
  });
  try {
    assert.throws(() => configure({ limits: { uploadMb: 'big' } }), problem(/limits\.uploadMb must be an integer/));
    resetConfig();
    assert.throws(() => configure({ limits: { ledgerPageSize: base.limits.ledgerMaxPageSize + 1 } }),
      problem(/limits\.ledgerPageSize cannot be more than limits\.ledgerMaxPageSize/));
  } finally {
    resetConfig();
  }
});

test('environment variables win over the files', () => {
  const file = overrides({
    brand: { productName: 'Acme Equity' },
    app: { url: 'https://file.example.com' },
    server: { port: 4100, trustProxy: false },
    auth: { google: { allowedDomains: ['file.example'] } },
  });
  withEnv({
    ...noEnvOverrides(),
    KOSMITOR_CONFIG: file,
    APP_URL: 'https://env.example.com/',
    PORT: '4200',
    TRUST_PROXY: 'yes',
    ALLOWED_ORIGINS: 'https://a.example.com/, https://b.example.com',
    PG_POOL_MAX: '4',
    MAIL_FROM: 'Acme <mail@example.com>',
    GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_ALLOWED_DOMAINS: '@Example.com, other.example',
    VALUATION_DESK_EMAIL: 'Desk@Example.com',
    BACKUP_CONTAINER: 'dumps',
    BACKUP_PREFIX: 'acme',
    DRILL_DATABASE: 'acme_drill',
  }, () => {
    const c = config();
    assert.equal(c.brand.productName, 'Acme Equity', 'what no variable sets still comes from the file');
    assert.equal(c.app.url, 'https://env.example.com');
    assert.equal(c.server.port, 4200);
    assert.equal(c.server.trustProxy, true);
    assert.deepEqual(c.server.allowedOrigins, ['https://a.example.com', 'https://b.example.com']);
    assert.equal(c.database.poolMax, 4);
    assert.equal(c.mail.from, 'Acme <mail@example.com>');
    assert.equal(c.auth.google.clientId, 'client.apps.googleusercontent.com');
    assert.deepEqual(c.auth.google.allowedDomains, ['example.com', 'other.example']);
    assert.equal(c.valuationDesk.email, 'desk@example.com');
    assert.deepEqual(c.backup, { ...base.backup, container: 'dumps', prefix: 'acme', drillDatabase: 'acme_drill' });
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: file, APP_URL: '  ' }, () => {
    assert.equal(config().app.url, 'https://file.example.com', 'an empty variable counts as unset');
  });
  withEnv({ ...noEnvOverrides(), TRUST_PROXY: 'maybe' }, () => {
    assert.throws(() => config(), problem(/environment \(TRUST_PROXY\): server\.trustProxy must be a boolean/));
  });
});

test('the valuation team can be several addresses: a list in the file, comma separated in the environment, each one checked', async () => {
  const { SINGLE_ADDRESS } = await import('../src/mail.ts');
  const email = schema.properties.valuationDesk.properties.email;
  assert.equal(email.pattern, SINGLE_ADDRESS.source, 'one address is checked by the rule the mail transport uses');
  assert.equal(email.items.pattern, SINGLE_ADDRESS.source, 'and so is each entry of a list');

  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: ' Lead@Example.com , second@example.com,, ' }, () => {
    assert.deepEqual(config().valuationDesk.email, ['lead@example.com', 'second@example.com'], 'trimmed, lowercased, empty entries dropped');
  });
  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: 'Desk@Example.com,' }, () => {
    assert.equal(config().valuationDesk.email, 'desk@example.com', 'one address stays a string, as it always was');
  });
  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: 'lead@example.com, not an address' }, () => {
    assert.throws(() => config(), problem(/environment \(VALUATION_DESK_EMAIL\): valuationDesk\.email\[1\] is not in the expected form/));
  });
  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: 'lead@example.com; second@example.com' }, () => {
    assert.throws(() => config(), problem(/valuationDesk\.email is not in the expected form/), 'a semicolon is not a separator');
    assert.throws(() => config(), problem(/environment \(VALUATION_DESK_EMAIL\): an entry holds more than one @: separate several addresses with commas/),
      'and the message says what to use instead');
  });
  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: 'lead@example.com second@example.com' }, () => {
    assert.throws(() => config(), problem(/separate several addresses with commas, not spaces or semicolons/), 'nor is a space');
  });
  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: 'Desk@Example.com, desk@example.com' }, () => {
    assert.equal(config().valuationDesk.email, 'desk@example.com', 'the same address in two cases is one address');
  });
  const ten = Array.from({ length: 10 }, (_, i) => `evaluator${i + 1}@example.com`);
  withEnv({ ...noEnvOverrides(), VALUATION_DESK_EMAIL: [...ten, 'Evaluator1@example.com'].join(',') }, () => {
    assert.deepEqual(config().valuationDesk.email, ten, 'an address written twice does not count twice against the limit of 10');
  });

  const many = Array.from({ length: 11 }, (_, i) => `evaluator${i + 1}@example.com`);
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: ['Lead@example.com', 'second@example.com'] } }) }, () => {
    assert.deepEqual(config().valuationDesk.email, ['Lead@example.com', 'second@example.com'], 'a list in the file is read as it is written');
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: many } }) }, () => {
    assert.throws(() => config(), problem(/valuationDesk\.email can hold at most 10 entries/));
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: [] } }) }, () => {
    assert.throws(() => config(), problem(/valuationDesk\.email needs at least 1 entry/), 'nobody is null, not an empty list');
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: ['lead@example.com', 'Second <second@example.com>'] } }) }, () => {
    assert.throws(() => config(), problem(/valuationDesk\.email\[1\] is not in the expected form/));
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: ['file@example.com'] } }), VALUATION_DESK_EMAIL: 'env@example.com, other@example.com' }, () => {
    assert.deepEqual(config().valuationDesk.email, ['env@example.com', 'other@example.com'], 'the environment wins over the file, whole');
  });

  // The server's hourly limit counts one email per address, so it must let at least one notice out.
  const three = ['lead@example.com', 'second@example.com', 'third@example.com'];
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: three, noticesPerHour: 2 } }) }, () => {
    assert.throws(() => config(), problem(/valuationDesk\.noticesPerHour \(2\) counts one email per address, so it cannot be fewer than the 3 addresses in valuationDesk\.email/));
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { noticesPerHour: 2 } }), VALUATION_DESK_EMAIL: three.join(',') }, () => {
    assert.throws(() => config(), problem(/noticesPerHour \(2\)/), 'whether the list comes from the file or the environment');
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { email: three, noticesPerHour: 3 } }) }, () => {
    assert.equal(config().valuationDesk.noticesPerHour, 3, 'as many as the addresses is enough');
  });
  withEnv({ ...noEnvOverrides(), KOSMITOR_CONFIG: overrides({ valuationDesk: { noticesPerHour: 1 } }) }, () => {
    assert.equal(config().valuationDesk.noticesPerHour, 1, 'with no address, any limit will do');
  });
});

test('configure() layers its changes and resetConfig() goes back to the files', () => {
  try {
    configure({ auth: { sessionDays: 7 } });
    configure({ auth: { passwordMinLength: 12 }, equity: { optionTermYears: 7 } });
    assert.equal(config().auth.sessionDays, 7, 'a later configure() keeps the earlier changes');
    assert.equal(config().auth.passwordMinLength, 12);
    assert.equal(config().auth.passwordMaxLength, base.auth.passwordMaxLength);
    assert.equal(enginePolicy().optionTermYears, 7, 'the engine is handed the new settings');
    assert.throws(() => { (config().auth as Json).sessionDays = 1; }, TypeError, 'the settings are frozen');
  } finally {
    resetConfig();
  }
  assert.equal(config().auth.sessionDays, base.auth.sessionDays);
  assert.equal(config().auth.passwordMinLength, base.auth.passwordMinLength);
  assert.equal(enginePolicy().optionTermYears, base.equity.optionTermYears);
});

test('publicConfig() holds nothing the browser should not see', () => {
  const strings = (node: unknown): string[] =>
    typeof node === 'string' ? [node] : Array.isArray(node) ? node.flatMap(strings) : isObject(node) ? Object.values(node).flatMap(strings) : [];
  const email = /[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+/;
  try {
    configure({
      valuationDesk: { enabled: true, email: 'desk@example.com' },
      mail: { from: 'Example <mailer@example.com>' },
      backup: { drillDatabase: 'secret_drill_db' },
    });
    const pc = publicConfig() as Json;
    const json = JSON.stringify(pc);
    for (const section of ['app', 'server', 'database', 'mail', 'backup']) assert.ok(!(section in pc), `${section} is not public`);
    assert.ok(!('email' in pc.valuationDesk), 'the desk inbox is not public');
    assert.equal(pc.valuationDesk.enabled, true);
    assert.deepEqual(strings(pc).filter((s) => email.test(s)), [], 'no email address, demo disabled');
    assert.ok(!json.includes('secret_drill_db'));
    for (const provider of Object.values<Json>(base.ai.providers)) assert.ok(!json.includes(provider.endpoint), `${provider.endpoint} is not public`);
    assert.ok(!/endpoint/i.test(json));

    assert.equal(pc.demo.enabled, false);
    assert.equal(pc.demo.email, '', 'demo credentials are blanked while the demo is off');
    assert.equal(pc.demo.password, '');
    configure({ demo: { enabled: true } });
    const demo = (publicConfig() as Json).demo;
    assert.equal(demo.email, base.demo.email);
    assert.equal(demo.password, base.demo.password);
  } finally {
    resetConfig();
  }
});

test('renderHead() escapes the values it writes and carries the brand colours', () => {
  try {
    configure({
      brand: {
        productName: '</script><script>alert(1)</script>',
        pageTitle: 'Cap <b>table</b> & "co"',
        icons: { svg: '/x.svg?a=1&b="2"' },
        colors: { primary: { 600: '#123456' } },
      },
    });
    const head = renderHead();
    assert.ok(head.includes('<title>Cap &lt;b&gt;table&lt;/b&gt; &amp; &quot;co&quot;</title>'));
    assert.ok(head.includes('href="/x.svg?a=1&amp;b=&quot;2&quot;"'));
    assert.equal(head.split('<script').length - 1, 1, 'one script element: the settings block');
    assert.equal(head.split('</script>').length - 1, 1, 'nothing in the settings closes the block early');

    const block = head.match(/<script type="application\/json" id="kosmitor-config">([^<]*)<\/script>/);
    assert.ok(block, 'the settings travel as a JSON data block');
    assert.equal(JSON.parse(block[1]).brand.productName, '</script><script>alert(1)</script>');
    assert.deepEqual(JSON.parse(block[1]), JSON.parse(JSON.stringify(publicConfig())));

    assert.ok(head.includes('--color-brand-600:#123456'));
    for (const [shade, hex] of Object.entries<string>(base.brand.colors.primary)) {
      if (shade !== '600') assert.ok(head.includes(`--color-brand-${shade}:${hex}`), `primary ${shade}`);
    }
    for (const [shade, hex] of Object.entries<string>(base.brand.colors.accent)) {
      assert.ok(head.includes(`--color-secondary-${shade}:${hex}`), `accent ${shade}`);
    }
  } finally {
    resetConfig();
  }
});

test('docs/configuration.md is up to date', () => {
  assert.ok(configDocsUpToDate(), 'docs/configuration.md differs from the schema and defaults: run `npm run config:docs`');
  assert.throws(() => renderConfigDocs(schema, { ...base, colour: 'blue' }), /colour is not a setting/);
});
