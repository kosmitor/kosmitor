/**
 * The certificate-style front page stored with each generated stock certificate.
 * Pinned here: it is written when the certificate is issued and rewritten when a
 * draft is corrected; it carries the legends that apply to the shares and the
 * holder; and once signed it never changes, whatever happens to the live records.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

delete process.env.SMTP_URL;
await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/workflows.ts');
const { insert, one } = await import('../src/db.ts');
const { parseFace, faceText } = await import('../src/certificate-face.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, token: sessionCookie(res) };
}

const admin = (await call('POST', '/api/auth/register', { email: 'avery@example.com', name: 'Avery Stone', password: 'avery-pass-1' })).token as string;
const cid = (await call('POST', '/api/companies', { name: 'Tidewater Labs', legalName: 'Tidewater Labs, Inc.' }, admin)).json.id as string;
const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
const schedule = (await one<{ id: string }>("SELECT id FROM vesting_schedules WHERE company_id = ? AND kind = 'TIME' ORDER BY duration_months DESC LIMIT 1", cid))!.id;
const now = new Date().toISOString();
await insert('stakeholders', { id: 'stk_us', companyId: cid, name: 'Priya Raman', email: 'priya@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', taxCountry: 'US', createdAt: now });
await insert('stakeholders', { id: 'stk_abroad', companyId: cid, name: 'Lena Fischer', legalName: 'Lena M. Fischer', email: 'lena@example.com', type: 'INDIVIDUAL', relation: 'EMPLOYEE', taxCountry: 'DE', taxForm: 'W8BEN', createdAt: now });

const issue = async (body: Record<string, unknown>) => {
  const r = await call('POST', `/api/c/${cid}/issuances/issue-for-signature`, {
    shareClassId: common, pricePerShare: 100, issueDate: '2026-03-15', signerName: 'Avery Stone', signerTitle: 'President and CEO', ...body,
  }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};

test('an issued certificate stores its front page, and its text says the same as the page', async () => {
  const issued = await issue({ stakeholderId: 'stk_us', quantity: 10_000 });
  const face = parseFace(issued.document.face)!;
  assert.ok(face, 'a face is stored');
  assert.equal(face.kind, 'STOCK');
  assert.equal(face.idLabel, `ID: ${issued.issuance.certificateNo}`);
  assert.equal(face.amountLabel, '10,000 Shares');
  assert.equal(face.heading, 'Tidewater Labs, Inc.');
  assert.deepEqual(face.watermark, ['CERTIFICATE', 'OF STOCK']);
  assert.equal(face.dated, 'Dated: March 15, 2026');
  assert.deepEqual(face.signers, [
    { role: 'COMPANY', name: 'Avery Stone', title: 'President and CEO' },
    { role: 'HOLDER', name: 'Priya Raman', title: 'Stockholder' },
  ]);
  assert.ok(issued.document.body.includes(faceText(face)), 'the readable text carries the face paragraphs word for word');
  assert.ok(issued.document.body.endsWith(face.back), 'and the pages after it');
  // A US holder with fully vested shares: the Securities Act and bylaws legends only.
  assert.match(face.back, /HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT OF 1933, AS AMENDED, AND HAVE BEEN ACQUIRED FOR INVESTMENT/);
  assert.match(face.back, /SET FORTH IN THE COMPANY'S BYLAWS, COPIES/);
  assert.doesNotMatch(face.back, /REGULATION S/);
  assert.doesNotMatch(face.back, /AGREEMENT BETWEEN THE COMPANY AND THE STOCKHOLDER/);
});

test('the legends follow the shares and the holder', async () => {
  const abroad = parseFace((await issue({ stakeholderId: 'stk_abroad', quantity: 5_000, vestingScheduleId: schedule })).document.face)!;
  assert.match(abroad.back, /IN RELIANCE ON REGULATION S/, 'a holder with a W-8BEN gets the offshore legend');
  assert.match(abroad.back, /AGREEMENT BETWEEN THE COMPANY AND THE STOCKHOLDER/, 'vesting shares carry the agreement and repurchase legend');
  assert.match(faceText(abroad), /^This certifies that Lena M\. Fischer \(the "Holder"\)/, 'the legal name goes on the certificate');

  const early = parseFace((await issue({ stakeholderId: 'stk_us', quantity: 2_000, earlyExercised: true })).document.face)!;
  assert.match(early.back, /BYLAWS AND STOCK PLAN/, 'early-exercised shares carry the stock plan legend');
  assert.doesNotMatch(early.back, /COMPANY'S BYLAWS, COPIES/, 'instead of the bylaws-only one');
});

test('correcting a draft rewrites the face; signing freezes it', async () => {
  const issued = await issue({ stakeholderId: 'stk_us', quantity: 1_000 });
  const corrected = await call('PATCH', `/api/c/${cid}/issuances/${issued.issuance.id}/draft`, { quantity: 1_250 }, admin);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
  const face = parseFace(corrected.json.document.face)!;
  assert.equal(face.amountLabel, '1,250 Shares');
  assert.match(faceText(face), /registered holder of 1,250 shares/);

  for (const block of issued.signatures) {
    const signed = await call('POST', `/api/c/${cid}/signatures/${block.id}/sign`, { typedSignature: block.stakeholderId ? 'Priya Raman' : 'Avery Stone' }, admin);
    assert.equal(signed.status, 200, JSON.stringify(signed.json));
  }
  const executed = await one<{ face: string; status: string }>('SELECT face, status FROM documents WHERE id = ?', issued.document.id);
  assert.equal(executed!.status, 'EXECUTED');

  // Later edits to the live records leave the signed certificate as it was signed.
  assert.equal((await call('PATCH', `/api/c/${cid}/stakeholders/stk_us`, { name: 'Priya Raman-Okafor' }, admin)).status, 200);
  assert.equal((await call('PATCH', `/api/c/${cid}`, { legalName: 'Tidewater Labs Holdings, Inc.' }, admin)).status, 200);
  const after = await one<{ face: string }>('SELECT face FROM documents WHERE id = ?', issued.document.id);
  assert.equal(after!.face, executed!.face);
  assert.match(faceText(parseFace(after!.face)!), /Priya Raman \(the "Holder"\)/);
});
