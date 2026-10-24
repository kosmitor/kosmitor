/**
 * The import API against what an upload or a request body can do on purpose:
 * cells far outside a sheet, zip bombs, tags left open, sheets thousands of
 * columns wide, numbers too large to store, bodies of the wrong shape, keys
 * named after Object's own properties, and requests from people who may not
 * import. Each answer is a quick 400, 401 or 403 with a code, never a crash, a
 * stall or a leaked error, and nothing is written. Also: a CSV export keeps
 * text that would run as a formula as text.
 *
 * Every name, email and figure here is invented.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshDatabase, sessionCookie } from './helpers.ts';

await freshDatabase();
const { handle } = await import('../src/http.ts');
await import('../src/routes/auth.ts');
await import('../src/routes/entities.ts');
await import('../src/routes/imports.ts');
const { insert, one } = await import('../src/db.ts');
const { xlsx, zip } = await import('../src/xlsx-writer.ts');
const { parseXlsx } = await import('../src/import/xlsx.ts');
const { parseXmlTable } = await import('../src/import/xml.ts');
const { toCsv, parseCsv, decodeText } = await import('../src/import/csv.ts');
const { configure, resetConfig, megabytes } = await import('../src/config.ts');

const api: Server = createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

async function call(method: string, path: string, body?: unknown, token: string | null = admin) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, token: sessionCookie(res) };
}

/**
 * Sends a request whose large body the server refuses without reading. It answers and closes while
 * the body is still going out, so on a busy machine the client's write can fail (EPIPE, ECONNRESET)
 * before fetch reads the answer. Such a try says nothing about the server; it is made again.
 */
async function refusedUnread<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (attempt >= 5 || (code !== 'EPIPE' && code !== 'ECONNRESET')) throw err;
    }
  }
}

let admin: string | null = null;
admin = (await call('POST', '/api/auth/register', { email: 'hester.vane@example.com', name: 'Hester Vane', password: 'hester-pass-1' }, null)).token as string;
const viewer = (await call('POST', '/api/auth/register', { email: 'otto.reede@example.com', name: 'Otto Reede', password: 'otto-pass-12' }, null)).token as string;
const company = async (name: string) => (await call('POST', '/api/companies', { name, incorporationDate: '2021-01-04', authorizedCommon: 10_000_000 })).json.id as string;
const cid = await company('Vane Hardware');

/** POST imports/parse with a file's bytes, timed. */
async function parse(name: string, body: Buffer, token: string | null = admin, to = cid) {
  const started = performance.now();
  const res = await fetch(`${base}/api/c/${to}/imports/parse?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(body) as unknown as RequestInit['body'],
  });
  return { status: res.status, json: (await res.json()) as any, ms: performance.now() - started };
}

/** A workbook of one sheet whose XML is given, written the way Excel zips it. */
const workbook = (sheetXml: string, extra: { name: string; data: Buffer }[] = []): Buffer => zip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="Holders" sheetId="1" r:id="rId1"/></sheets></workbook>') },
  { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
  { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`) },
  ...extra,
]);
const HEADER = '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Email</t></is></c></row>';
const PERSON = '<row r="2"><c r="A2" t="inlineStr"><is><t>Ada Quill</t></is></c><c r="B2" t="inlineStr"><is><t>ada@quill.example</t></is></c></row>';

/** Makes an archive's directory claim `entry` unpacks to a few bytes, as a crafted zip bomb does. */
function understate(archive: Buffer, entry: string): Buffer {
  const out = Buffer.from(archive);
  for (let p = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); p >= 0; p = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p - 1)) {
    if (out.toString('utf8', p + 46, p + 46 + out.readUInt16LE(p + 28)) === entry) { out.writeUInt32LE(10, p + 24); return out; }
  }
  throw new Error(`no ${entry}`);
}

test('cells and rows far outside a sheet are refused as damaged at once, and a stray cell far right does not widen the sheet', async () => {
  // A 1 KB file whose cells sit at XFD2 and row 200,000 used to grow a grid until the process ran out of memory.
  for (const [name, xml] of [
    ['beyond-columns.xlsx', `${HEADER}<row r="2"><c r="A2"><v>1</v></c><c r="ZZZZZZ2"><v>1</v></c></row>`],
    ['beyond-rows.xlsx', `${HEADER}<row r="2000000"><c r="A2000000"><v>2</v></c></row>`],
    ['unclosed-rows.xlsx', HEADER + '<row r="2">'.repeat(50_000)],
  ] as const) {
    const r = await parse(name, workbook(xml));
    assert.deepEqual([r.status, r.json.detail.code], [400, 'damaged'], name);
    assert.ok(r.ms < 2000, `${name} took ${Math.round(r.ms)} ms`);
  }
  const unclosedStrings = workbook(HEADER, [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${'<si><t>x</t>'.repeat(30_000)}</sst>`) }]);
  assert.equal((await parse('unclosed-strings.xlsx', unclosedStrings)).json.detail.code, 'damaged');

  // Excel allows XFD (column 16,384) and row 1,048,576: a value there is left out with a notice, and empty rows take no room.
  const far = await parse('far.xlsx', workbook(`${HEADER}${PERSON}<row r="3"><c r="A3" t="inlineStr"><is><t>Bo Quill</t></is></c><c r="XFD3"><v>1</v></c></row><row r="1048576"><c r="A1048576" t="inlineStr"><is><t>Cy Quill</t></is></c><c r="B1048576" t="inlineStr"><is><t>cy@quill.example</t></is></c></row>`));
  assert.equal(far.status, 200, JSON.stringify(far.json));
  assert.deepEqual(far.json.sheets[0].rows, [['Name', 'Email'], ['Ada Quill', 'ada@quill.example'], ['Bo Quill', null], ['Cy Quill', 'cy@quill.example']]);
  assert.deepEqual(far.json.sheets[0].notices, [{ code: 'too-wide', level: 'warning', text: 'Only the first 1,000 columns are read; the columns after them are left out.' }]);

  // The same for XML Spreadsheet 2003.
  const ss = (body: string) => Buffer.from(`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="S"><Table><Row><Cell><Data ss:Type="String">Name</Data></Cell><Cell><Data ss:Type="String">Email</Data></Cell></Row>${body}</Table></Worksheet></Workbook>`);
  for (const body of ['<Row ss:Index="2000000000"><Cell><Data ss:Type="String">x</Data></Cell></Row>', '<Row><Cell ss:Index="2000000000"><Data ss:Type="String">x</Data></Cell></Row>']) {
    const r = await parse('far.xml', ss(body));
    assert.deepEqual([r.status, r.json.detail.code, r.json.error], [400, 'damaged', parseError(() => parseXmlTable(ss(body).toString()))]);
  }
  // Nesting deeper than a table needs is the file's fault, said as such — not "Maximum call stack size exceeded".
  const deep = await parse('deep.xml', Buffer.from(`<root><r><a>1</a><b>2</b></r><r><a>1</a><b>${'<x>'.repeat(200_000)}v${'</x>'.repeat(200_000)}</b></r></root>`));
  assert.deepEqual([deep.status, deep.json.detail.code, deep.json.error], [400, 'damaged', 'The XML is nested too deeply to be a table.']);
});

const parseError = (f: () => unknown): string => { try { f(); return 'no error'; } catch (err) { return (err as Error).message; } };

test('a workbook that unpacks to more than limits.importUnzippedMb is refused, and parts the import does not read are never unpacked', async () => {
  configure({ limits: { importUnzippedMb: 4 } });
  try {
    // A picture of 64 MB of zeros, a few KB zipped: never read, so never unpacked.
    const withPicture = workbook(`${HEADER}${PERSON}`, [{ name: 'xl/media/image1.bin', data: Buffer.alloc(megabytes(64)) }]);
    assert.ok(withPicture.length < 200_000);
    const fine = await parse('with-picture.xlsx', withPicture);
    assert.equal(fine.status, 200, JSON.stringify(fine.json));
    assert.ok(fine.ms < 2000);

    // The sheet itself unpacking to 8 MB: refused by its declared size, and by what it unpacks to when the directory lies.
    const padded = workbook(`${HEADER}${PERSON}${' '.repeat(megabytes(8))}`);
    for (const [name, file] of [['padded.xlsx', padded], ['lying.xlsx', understate(padded, 'xl/worksheets/sheet1.xml')]] as const) {
      const r = await parse(name, file);
      assert.deepEqual([r.status, r.json.detail], [400, { code: 'unzips-too-large', limitMb: 4 }], name);
      assert.equal(r.json.error, 'This workbook unpacks to more than 4 MB, more than an import reads. Save the tabs you need as their own .xlsx or .csv file and drop those here.');
    }
  } finally {
    resetConfig();
  }
});

test('long and wide files are read in one pass: unclosed tags, long attribute names, thousands of columns, a vesting cell of digits', async () => {
  // An attribute name with no "=" used to be retried from every position.
  const xml = Buffer.from(`<?xml version="1.0"?><root><r ${'a'.repeat(60_000)}><n>Ada Quill</n><e>ada@quill.example</e></r><r><n>Bo Quill</n><e>bo@quill.example</e></r></root>`);
  const attrs = await parse('long-attr.xml', xml);
  assert.equal(attrs.status, 200);
  assert.ok(attrs.ms < 2000, `${Math.round(attrs.ms)} ms`);

  // A CSV 5,000 columns wide, most of them empty: trailing empty columns go, and past 1,000 nothing is kept.
  const wide = Buffer.from(`Name,Email${','.repeat(4998)}\nAda Quill,ada@quill.example${','.repeat(4998)}\nBo Quill,bo@quill.example${',x'.repeat(2000)}\n`);
  const w = await parse('wide.csv', wide);
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.sheets[0].rows.map((r: unknown[]) => r.length), [1000, 1000, 1000]);
  assert.equal(w.json.sheets[0].notices[0].code, 'too-wide');
  const narrow = await parse('narrow.csv', Buffer.from(`Name,Email,,,\nAda Quill,ada@quill.example,,,\n`));
  assert.deepEqual(narrow.json.sheets[0].rows, [['Name', 'Email'], ['Ada Quill', 'ada@quill.example']]);

  // A cell is at most 32,767 characters (Excel's limit), and a vesting cell that long is not shorthand: an error at once.
  const cell = `1/48 ${'7'.repeat(32_000)}`;
  const sheet = { name: 'grants', kind: 'grants', headers: ['Optionee', 'Award type', 'Shares', 'Strike price', 'Grant date', 'Vesting schedule'],
    rows: Array.from({ length: 20 }, () => ['Ada Quill', 'NSO', '100', '0.10', '2024-01-02', cell]), headerRowNumber: 1,
    mapping: { stakeholderName: 0, awardType: 1, quantity: 2, strikePrice: 3, grantDate: 4, vestingSchedule: 5 } };
  const started = performance.now();
  const dry = await call('POST', `/api/c/${cid}/imports/workbook/preview`, { sheets: [sheet], options: { defaultPoolName: 'Vane Plan' } });
  assert.equal(dry.status, 200);
  assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
  assert.equal(dry.json.sheets[0].preview.rows[0].messages.find((m: any) => m.level === 'error').code, 'unknown-value');
  const tooLong = await call('POST', `/api/c/${cid}/imports/workbook/preview`, { sheets: [{ ...sheet, rows: [['Ada Quill', 'NSO', '100', '0.10', '2024-01-02', 'x'.repeat(40_000)]] }] });
  assert.deepEqual([tooLong.status, tooLong.json.detail.code], [400, 'bad-sheet']);
});

test('a number too large to store is a row error the review shows, not a failed write', async () => {
  const sheets = [{ name: 'safes', kind: 'convertibles', headers: ['Investor', 'Instrument', 'Principal', 'Issue date'], headerRowNumber: 1,
    mapping: { stakeholderName: 0, instrument: 1, principal: 2, issueDate: 3 },
    rows: [['Quill Ventures LP', 'Post-money SAFE', '250,000', '2024-01-02'], ['Huge Fund LP', 'Post-money SAFE', '100000000000000000', '2024-01-02']] },
  { name: 'certificates', kind: 'captable', headers: ['Stakeholder', 'Share class', 'Shares', 'Price per share', 'Issue date'], headerRowNumber: 1,
    mapping: { stakeholderName: 0, shareClassName: 1, quantity: 2, pricePerShare: 3, issueDate: 4 },
    rows: [['Ada Quill', 'Common', '5000000000000', '0.01', '2024-01-02'], ['Bo Quill', 'Common', '900000000000', '9999999', '2024-01-02']] }];
  const dry = await call('POST', `/api/c/${cid}/imports/workbook/preview`, { sheets });
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  const errors = dry.json.sheets.flatMap((s: any) => s.preview.rows.flatMap((r: any) => r.messages.filter((m: any) => m.level === 'error').map((m: any) => [r.row, m.code, m.field, m.text])));
  assert.deepEqual(errors, [
    [2, 'bad-number', 'quantity', 'Shares is more than the import can record'],
    [3, 'bad-number', 'pricePerShare', 'Shares times the price per share is more than the import can record'],
    [3, 'bad-number', 'principal', 'Principal is more than the import can record'],
  ]);
  const refused = await call('POST', `/api/c/${cid}/imports/workbook/commit`, { sheets });
  assert.deepEqual([refused.status, refused.json.detail.code], [400, 'rows-need-fixing']);
  assert.equal((await call('POST', `/api/c/${cid}/imports/workbook/commit`, { sheets, options: { skipRowsWithErrors: true } })).status, 200);
  assert.equal(Number((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM convertibles WHERE company_id = ?', cid))!.n), 1);
});

test('bodies of the wrong shape are 400s with a code, and nothing about the server leaks', async () => {
  const sheet = { name: 'c', kind: 'captable', headers: ['Stakeholder', 'Share class', 'Shares', 'Issue date'], headerRowNumber: 1,
    mapping: { stakeholderName: 0, shareClassName: 1, quantity: 2, issueDate: 3 }, rows: [['Ada Quill', 'Common', '10', '2024-01-02']] };
  const preview = (body: unknown) => call('POST', `/api/c/${cid}/imports/workbook/preview`, body);
  for (const [what, body] of [
    ['a row that is not a list', { sheets: [{ ...sheet, rows: [null] }] }],
    ['a cell that is a list', { sheets: [{ ...sheet, rows: [['Ada Quill', 'Common', ['10'], '2024-01-02']] }] }],
    ['a cell nested deep', { sheets: [{ ...sheet, rows: [[JSON.parse('['.repeat(2000) + ']'.repeat(2000))]] }] }],
    ['headers that are text', { sheets: [{ ...sheet, headers: 'abc' }] }],
    ['headers that are an object', { sheets: [{ ...sheet, headers: {} }] }],
    ['a sheet that is null', { sheets: [null] }],
    ['a header row number that is text', { sheets: [{ ...sheet, headerRowNumber: 'two' }] }],
  ] as const) {
    const r = await preview(body);
    assert.deepEqual([r.status, r.json.detail?.code], [400, 'bad-sheet'], what);
  }
  // The single-sheet routes the old page uses check the same, and a commit's own errors are not mislabelled.
  const legacy = await call('POST', `/api/c/${cid}/imports/commit`, { ...sheet, rows: [null] });
  assert.deepEqual([legacy.status, legacy.json.detail.code], [400, 'bad-sheet']);
  assert.doesNotMatch(legacy.json.error, /Cannot read properties|TypeError/);
  // Kinds and mapping keys named after Object's own properties are unknown, not crashes.
  for (const kind of ['constructor', 'toString', '__proto__']) {
    assert.equal((await preview({ sheets: [{ ...sheet, kind }] })).status, 400, kind);
    assert.equal((await call('POST', `/api/c/${cid}/imports/suggest`, { kind, headers: [] })).status, 400, kind);
  }
  assert.equal((await call('GET', `/api/c/${cid}/imports/template/constructor`)).status, 404);
  assert.equal((await preview({ sheets: [{ ...sheet, mapping: { ...sheet.mapping, constructor: 3, __proto__: 1 } }] })).status, 200);
  // Rows left out are per sheet in a workbook; detection takes a bounded number of sheets.
  assert.deepEqual((await preview({ sheets: [sheet], options: { excludeRows: [2] } })).json.detail, { code: 'bad-option' });
  const many = Array.from({ length: 101 }, (_, i) => ({ name: `Tab ${i}`, headers: ['Name'], rowCount: 1 }));
  assert.deepEqual((await call('POST', `/api/c/${cid}/imports/detect`, { sheets: many })).json.detail, { code: 'too-many-sheets' });
  assert.deepEqual((await call('POST', `/api/c/${cid}/imports/detect`, { sheets: [{ name: 'x', headers: Array(20_000).fill('h'), rowCount: 1 }] })).json.detail, { code: 'bad-sheet' });
  // The whole import is bounded too.
  configure({ limits: { importMaxTotalRows: 3 } });
  try {
    const r = await preview({ sheets: [{ ...sheet, rows: Array(4).fill(sheet.rows[0]) }] });
    assert.deepEqual([r.status, r.json.detail.code], [400, 'too-many-rows']);
  } finally {
    resetConfig();
  }
});

test('a person called "constructor" is a person: their relationship is guessed and asked, not taken from Object', async () => {
  const sheets = [{ name: 'c', kind: 'captable', headers: ['Stakeholder', 'Share class', 'Shares', 'Issue date'], headerRowNumber: 1,
    mapping: { stakeholderName: 0, shareClassName: 1, quantity: 2, issueDate: 3 }, rows: [['constructor', 'Common', '10', '2024-01-02'], ['toString', 'Common', '10', '2024-01-02']] }];
  const dry = await call('POST', `/api/c/${cid}/imports/workbook/preview`, { sheets, options: { relationships: { hasOwnProperty: 'ADVISOR' } } });
  assert.deepEqual(dry.json.newPeople.map((p: any) => [p.name, p.relation, p.guessed]), [['constructor', 'EMPLOYEE', true], ['toString', 'EMPLOYEE', true]]);
});

test('who may import: signed out and read-only members are answered before their body is read; a viewer cannot parse, check or import', async () => {
  const user = await one<{ id: string }>("SELECT id FROM users WHERE email = 'otto.reede@example.com'");
  await insert('memberships', { id: 'mem_otto', userId: user!.id, companyId: cid, role: 'VIEWER', createdAt: new Date().toISOString() });
  const sheet = { name: 'c', kind: 'captable', headers: ['Stakeholder', 'Share class', 'Shares', 'Issue date'], headerRowNumber: 1,
    mapping: { stakeholderName: 0, shareClassName: 1, quantity: 2, issueDate: 3 }, rows: [['Ada Quill', 'Common', '10', '2024-01-02']] };
  assert.equal((await parse('people.csv', Buffer.from('Name,Email\nAda Quill,ada@quill.example\n'), viewer)).status, 403);
  for (const route of ['workbook/preview', 'workbook/commit', 'preview', 'commit']) {
    const body = route.startsWith('workbook') ? { sheets: [sheet] } : sheet;
    assert.equal((await call('POST', `/api/c/${cid}/imports/${route}`, body, viewer)).status, 403, route);
  }
  // A body over the limit from someone who may not import is refused for who they are, not read to find it too large.
  configure({ limits: { importJsonMb: 1, importUploadMb: 1 } });
  try {
    const big = JSON.stringify({ sheets: [sheet], padding: 'x'.repeat(megabytes(2)) });
    assert.equal((await refusedUnread(() => call('POST', `/api/c/${cid}/imports/workbook/preview`, big, null))).status, 401);
    assert.equal((await refusedUnread(() => call('POST', `/api/c/${cid}/imports/workbook/preview`, big, viewer))).status, 403);
    assert.equal((await refusedUnread(() => parse('big.csv', Buffer.alloc(megabytes(2), 'a'), null))).status, 401);
    // Refused partway through the body, which closes the connection while the rest is still going out.
    assert.equal((await refusedUnread(() => call('POST', `/api/c/${cid}/imports/workbook/preview`, big))).json.detail.code, 'body-too-large');
  } finally {
    resetConfig();
  }
  // Another company's equity plan is not a default.
  const other = await company('Reede Optics');
  const common = (await one<{ id: string }>("SELECT id FROM share_classes WHERE company_id = ? AND name = 'Common'", other))!.id;
  await insert('pools', { id: 'pol_reede', companyId: other, name: 'Reede Plan', shareClassId: common, authorized: 1000, createdAt: new Date().toISOString() });
  assert.deepEqual((await call('POST', `/api/c/${cid}/imports/workbook/preview`, { sheets: [sheet], options: { defaultPoolId: 'pol_reede' } })).json.detail, { code: 'bad-option' });
  assert.equal((await call('POST', `/api/c/${other}/imports/workbook/preview`, { sheets: [sheet], options: { defaultPoolId: 'pol_reede' } })).status, 200);
});

test('a CSV export keeps text that would run as a formula as text, and leaves numbers alone', () => {
  const csv = toCsv([['Name', 'Address', 'Spread'], ['=HYPERLINK("http://x.example")', '@SUM(1)', '-1,250.00'], ['+cmd', '-$5.00', -3]]);
  assert.equal(csv, 'Name,Address,Spread\r\n"\'=HYPERLINK(""http://x.example"")",\'@SUM(1),"-1,250.00"\r\n\'+cmd,-$5.00,-3');
  assert.deepEqual(parseCsv(csv)[1], ['\'=HYPERLINK("http://x.example")', '\'@SUM(1)', '-1,250.00']);
});

test('a CSV pasted together from UTF-8 and Windows-1252 lines reads each line its own way, and the parse says which', async () => {
  const body = Buffer.concat([Buffer.from('Name,Email\nHélène Duvallon,helene@duvallon.example\nZoë Ångström,zoe@angstrom.example\n', 'utf8'),
    Buffer.from('Tom'), Buffer.from([0x92]), Buffer.from('s Ruiz,tom@ruiz.example\n')]);
  const decoded = decodeText(body);
  assert.deepEqual([decoded.encoding, decoded.mixedLines], ['utf-8', [4]]);
  const r = await parse('pasted.csv', body);
  assert.deepEqual(r.json.sheets[0].rows.map((row: string[]) => row[0]), ['Name', 'Hélène Duvallon', 'Zoë Ångström', 'Tom’s Ruiz']);
  assert.deepEqual(r.json.sheets[0].notices, [{ code: 'mixed-encoding', level: 'info', text: 'Line 4 was saved in another encoding (Windows-1252) and read that way — check the accents there' }]);
  // A file that is Windows-1252 throughout is still read as that, with no notice.
  assert.equal(decodeText(Buffer.from([0x43, 0x61, 0x74, 0xe9, 0x0a])).encoding, 'windows-1252');
  assert.equal(parseXlsx(workbook(`${HEADER}${PERSON}`))[0].rows.length, 2);
});
