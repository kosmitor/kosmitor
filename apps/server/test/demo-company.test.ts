/**
 * The demo account the sign-in card hands out opens onto the sample company,
 * created at server start when it is missing. Pinned here: nothing happens with
 * the demo card off; with it on the company is created once, for the demo account,
 * even when that account already existed with no company; a second start does not
 * create another.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { configure, resetConfig, config } = await import('../src/config.ts');
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
const { createServer } = await import('node:http');
const api = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as import('node:net').AddressInfo).port}`;
const { after } = await import('node:test');
after(() => api.close());
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
};
const { ensureDemoCompany } = await import('../src/sample.ts');
const { all, one } = await import('../src/db.ts');
const { createUser } = await import('../src/auth.ts');

const sampleCompaniesOf = (email: string) => all<{ id: string; is_sample: number }>(
  `SELECT c.id, c.is_sample FROM companies c JOIN memberships m ON m.company_id = c.id JOIN users u ON u.id = m.user_id WHERE LOWER(u.email) = LOWER(?)`, email);

test('with the demo card off, nothing is created', async () => {
  resetConfig();
  assert.equal(config().demo.enabled, false);
  assert.equal(await ensureDemoCompany(), null);
  assert.equal((await all('SELECT id FROM companies')).length, 0);
});

test('with it on, an existing demo account with no company gets the sample company once', async () => {
  configure({ demo: { enabled: true } });
  try {
    // The account exists but has nothing, which is what a visitor saw on a fresh server.
    await createUser(config().demo.email, 'Avery Stone', config().demo.password);
    assert.equal((await sampleCompaniesOf(config().demo.email)).length, 0);

    const created = await ensureDemoCompany();
    assert.ok(created, 'the sample company is created');
    const companies = await sampleCompaniesOf(config().demo.email);
    assert.deepEqual(companies.map((c) => [c.id, c.is_sample]), [[created, 1]]);
    assert.ok((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM stakeholders WHERE company_id = ?', created))!.n > 10, 'with its data');

    // Two servers starting together, or a restart, create nothing more.
    const again = await Promise.all([ensureDemoCompany(), ensureDemoCompany()]);
    assert.deepEqual(again, [null, null]);
    assert.equal((await sampleCompaniesOf(config().demo.email)).length, 1);
  } finally {
    resetConfig();
  }
});

test('the shared demo account cannot create companies while the demo card is on; anyone else can', async () => {
  configure({ demo: { enabled: true } });
  try {
    const demo = (await call('POST', '/api/auth/login', { email: config().demo.email, password: config().demo.password })).token as string;
    const refused = await call('POST', '/api/companies', { name: 'Visitor Co' }, demo);
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /demo account is for exploring the sample company/);
    const own = (await call('POST', '/api/auth/register', { email: 'jordan@example.com', name: 'Jordan Vale', password: 'jordan-pass-1' })).token as string;
    assert.equal((await call('POST', '/api/companies', { name: 'Vale Robotics' }, own)).status, 200);
  } finally {
    resetConfig();
  }
  // With the card off, the demo address is an ordinary account.
  const demo = (await call('POST', '/api/auth/login', { email: config().demo.email, password: config().demo.password })).token as string;
  assert.equal((await call('POST', '/api/companies', { name: 'Avery Co' }, demo)).status, 200);
});

test('the shared demo account cannot lock others out, delete the sample company, invite, or edit its profile', async () => {
  configure({ demo: { enabled: true } });
  try {
    const { email, password } = config().demo;
    const demo = (await call('POST', '/api/auth/login', { email, password })).token as string;
    const cid = (await sampleCompaniesOf(email))[0].id;
    const refuse = async (method: string, path: string, body?: unknown) => assert.equal((await call(method, path, body, demo)).status, 403, `${method} ${path}`);
    await refuse('POST', '/api/auth/change-password', { currentPassword: password, newPassword: 'locked-out-1' });
    await refuse('PATCH', '/api/auth/me', { name: 'Vandal' });
    await refuse('POST', `/api/c/${cid}/members`, { email: 'spam@example.com', name: 'Spam', role: 'VIEWER' });
    await refuse('DELETE', `/api/c/${cid}?confirm=anything`);
    // A reset link is neither issued nor shown for it.
    const forgot = await call('POST', '/api/auth/forgot', { email });
    assert.equal(forgot.json.resetUrl, undefined);
    assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = (SELECT id FROM users WHERE LOWER(email) = LOWER(?))', email))!.n, 0);
    // The password still works, and the company is still there.
    assert.equal((await call('POST', '/api/auth/login', { email, password })).status, 200);
    assert.ok(await one('SELECT id FROM companies WHERE id = ?', cid));
  } finally {
    resetConfig();
  }
});
