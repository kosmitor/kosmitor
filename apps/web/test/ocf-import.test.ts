/**
 * The import page's pure helpers for Open Cap Format packages
 * (src/pages/import/ocf.ts): the files dropped together made into one package, the
 * body the check and the import send, the questions the check asks, and the
 * left-out items as a CSV. Every name is invented.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldList, mergeOcfParts, ocfLeftOutCsv, ocfPending, ocfQuestionsOf, ocfRequestBody, type OcfParse, type OcfPart, type OcfState } from '../src/pages/import/ocf.ts';

const manifest = {
  file_type: 'OCF_MANIFEST_FILE', ocf_version: '1.2.0',
  stakeholders_files: [{ filepath: './Stakeholders.ocf.json', md5: 'a'.repeat(32) }],
  transactions_files: [{ filepath: './Transactions.ocf.json', md5: 'b'.repeat(32) }],
};
const parse = (part: OcfParse['part'], extra: Partial<OcfParse> = {}): OcfParse => ({
  part, version: part === 'file' ? null : '1.2.0', fileType: null, issuer: null, asOf: null, generatedAt: null, files: [], missing: [], counts: {}, notices: [],
  package: { manifestPath: null, manifest: null, files: [] }, ...extra,
});
const loose = (name: string, fileType: string, md5: string, items = 2): OcfPart => ({
  name, uploadId: `upl_${name}`,
  ocf: parse('file', { fileType, files: [{ path: name, fileType, items, checksum: 'none', md5 }], counts: { [fileType === 'OCF_STAKEHOLDERS_FILE' ? 'stakeholders' : 'transactions']: items },
    package: { manifestPath: null, manifest: null, files: [{ path: name, md5, content: { file_type: fileType, items: [] } }] } }),
});
const manifestPart: OcfPart = { name: 'Manifest.ocf.json', uploadId: 'upl_m', ocf: parse('manifest', { missing: ['Stakeholders.ocf.json', 'Transactions.ocf.json'], package: { manifestPath: 'Manifest.ocf.json', manifest, files: [] } }) };

test('a manifest and its files make one package: by name, else by kind, with their checksums', () => {
  const merged = mergeOcfParts([loose('Transactions.ocf.json', 'OCF_TRANSACTIONS_FILE', 'c'.repeat(32), 5), manifestPart, loose('people.json', 'OCF_STAKEHOLDERS_FILE', 'a'.repeat(32))]);
  assert.ok(merged.ok);
  assert.equal(merged.name, 'Manifest.ocf.json');
  assert.deepEqual(merged.uploadIds, ['upl_m', 'upl_Transactions.ocf.json', 'upl_people.json']);
  assert.deepEqual(merged.pkg.files.map((f) => f.path), ['Stakeholders.ocf.json', 'Transactions.ocf.json'], 'each under the path the manifest gives it');
  assert.deepEqual(merged.info.files.map((f) => [f.path, f.checksum]), [['Stakeholders.ocf.json', 'ok'], ['Transactions.ocf.json', 'mismatch']]);
  assert.deepEqual([merged.info.part, merged.info.counts], ['package', { stakeholders: 2, transactions: 5 }]);
});

test('what cannot be one package is a problem, said where the files were dropped', () => {
  const problem = (parts: OcfPart[]) => { const r = mergeOcfParts(parts); return r.ok ? null : r.problem; };
  assert.equal(problem([manifestPart, loose('Stakeholders.ocf.json', 'OCF_STAKEHOLDERS_FILE', 'a'.repeat(32))]),
    'This OCF package is missing Transactions.ocf.json. Drop the .ocf.zip, or the manifest with all of its files.');
  assert.equal(problem([loose('Stakeholders.ocf.json', 'OCF_STAKEHOLDERS_FILE', 'a'.repeat(32))]),
    'This is one file of an OCF package (stakeholders). Drop the whole .ocf.zip, or all of its files with the manifest.');
  assert.equal(problem([loose('a.json', 'OCF_STAKEHOLDERS_FILE', 'a'.repeat(32)), loose('b.json', 'OCF_TRANSACTIONS_FILE', 'b'.repeat(32))]),
    'These are files of an OCF package without its manifest. Drop the whole .ocf.zip, or all of its files with the manifest.');
  const zipPart = (name: string): OcfPart => ({ name, uploadId: null, ocf: parse('package') });
  assert.equal(problem([zipPart('one.ocf.zip'), zipPart('two.ocf.zip')]), 'Drop one OCF package at a time.');
  assert.equal(problem([zipPart('one.ocf.zip'), manifestPart]), 'Drop one OCF package at a time.');
  const one = mergeOcfParts([zipPart('one.ocf.zip')]);
  assert.ok(one.ok && one.name === 'one.ocf.zip');
});

const state: OcfState = { name: 'tidewater.ocf.zip', uploadIds: ['upl_1'], info: parse('package'), pkg: { manifestPath: 'Manifest.ocf.json', manifest, files: [] }, leftAside: [] };

test('the body of the check: the package, the items left out by section, and only the answers given', () => {
  assert.deepEqual(ocfRequestBody(state, {}, { relationships: {}, raiseAuthorized: [], ocfPeople: {} }),
    { uploadIds: ['upl_1'], ocf: { file: 'tidewater.ocf.zip', package: state.pkg }, options: {} });
  assert.deepEqual(ocfRequestBody(state, { captable: [9, 3], events: [], somethingElse: [1] }, { relationships: { 'ana@x.example': 'FOUNDER' }, raiseAuthorized: ['Common'], ocfPeople: { ana: 'stk_1' } }), {
    uploadIds: ['upl_1'], ocf: { file: 'tidewater.ocf.zip', package: state.pkg, exclude: { captable: [3, 9] } },
    options: { relationships: { 'ana@x.example': 'FOUNDER' }, raiseAuthorized: ['Common'], ocfPeople: { ana: 'stk_1' } },
  });
  // Whether another company's details are copied: sent once answered, either way.
  for (const fill of [true, false]) {
    assert.deepEqual(ocfRequestBody(state, {}, { relationships: {}, raiseAuthorized: [], ocfPeople: {}, ocfCompanyFill: fill }).options, { ocfCompanyFill: fill });
  }
  assert.deepEqual(ocfRequestBody(state, {}, { relationships: {}, raiseAuthorized: [], ocfPeople: {}, ocfCompanyFill: null }).options, {});
});

test('a package goes in whole: while one row is blocked, nothing is ready and every row to add waits for it (finding UX-3)', () => {
  const sheet = (kind: string, blocked: boolean, rows: any[]) => ({ kind, sheetName: kind, blocked, preview: { rows, counts: {} } });
  const blocked = {
    counts: { willImport: 57 },
    sheets: [
      sheet('stakeholders', false, [row(1, {}), row(2, { outcome: 'existing', action: 'skip' }), row(3, { outcome: 'update', action: 'update' })]),
      sheet('captable', true, [row(1, {}), row(2, { status: 'error', outcome: 'error' }), row(3, { status: 'warning' })]),
    ],
  } as any;
  assert.deepEqual(ocfPending(blocked), { ready: 0, pending: 4 });
  const clear = { ...blocked, sheets: blocked.sheets.map((s: any) => ({ ...s, blocked: false })) };
  assert.deepEqual(ocfPending(clear), { ready: 57, pending: 0 });
  assert.deepEqual(ocfPending(null), { ready: 0, pending: 0 });
  assert.equal(fieldList([{ field: 'EIN' }, { field: 'address' }, { field: 'incorporation date' }]), 'EIN, address and incorporation date');
  assert.equal(fieldList([{ field: 'EIN' }]), 'EIN');
});

const row = (n: number, extra: Record<string, unknown>) => ({ row: n, status: 'ok', action: 'create', outcome: 'add', summary: {}, messages: [], ...extra }) as any;
const review = {
  sheets: [
    { kind: 'stakeholders', sheetName: 'Stakeholders', preview: { rows: [
      row(1, { status: 'error', outcome: 'error', ocfId: 'robin', object: 'STAKEHOLDER', summary: { stakeholder: 'Robin Vale' },
        messages: [{ level: 'error', code: 'ambiguous-person', text: 'Two people on the cap table are called "Robin Vale"', people: [{ id: 'stk_1', name: 'Robin Vale', email: null }, { id: 'stk_2', name: 'Robin Vale', email: 'rv@x.example' }] }] }),
      row(2, { ocfId: 'ana', summary: { stakeholder: 'Ana, "the" founder', email: 'ana@x.example' } }),
    ] } },
    { kind: 'captable', sheetName: 'Certificates', preview: { rows: [
      row(7, { status: 'error', outcome: 'error', ocfId: 'cs-1', object: 'TX_STOCK_ISSUANCE', summary: { stakeholder: '=SUM(A1)', shares: 1000 }, messages: [{ level: 'error', code: 'ocf-depends', text: 'Waits for item 1' }] }),
      row(8, { outcome: 'excluded', ocfId: 'cs-2', object: 'TX_STOCK_ISSUANCE', summary: { stakeholder: 'Bo Kestrel' }, messages: [{ level: 'info', code: 'excluded', text: 'Left out by you' }] }),
      row(9, { outcome: 'excluded', ocfId: 'cs-3', object: 'TX_STOCK_ISSUANCE', summary: { stakeholder: 'Bo Kestrel' }, messages: [{ level: 'info', code: 'ocf-excluded-with', text: 'Left out with item 8 (CS-2)' }] }),
    ] } },
  ],
  notices: [{ code: 'over-authorized', level: 'warning', text: 'After this import Common needs 5,000 shares', fix: { option: 'raiseAuthorized', value: 'Common', shareClassId: null, className: 'Common', to: 5000 } }],
} as any;

test('the questions: who each person the package cannot tell apart is, then the notices not yet dismissed', () => {
  assert.deepEqual(ocfQuestionsOf(review, []).map((q) => [q.type, q.id]), [['ocf-person', 'ocf-person:robin'], ['notice', 'notice:Common']]);
  const person = ocfQuestionsOf(review, [])[0];
  assert.ok(person.type === 'ocf-person' && person.name === 'Robin Vale' && person.item === 1 && person.people.length === 2);
  assert.deepEqual(ocfQuestionsOf(review, ['notice:Common']).map((q) => q.id), ['ocf-person:robin']);
  assert.deepEqual(ocfQuestionsOf(null, []), []);
});

test('the left-out items as a CSV: one line per item, quoted where it must be, formulas kept as text', () => {
  const text = ocfLeftOutCsv(review, { captable: { 8: 'Not ours' } });
  assert.ok(text.startsWith('﻿'));
  assert.deepEqual(text.slice(1).split('\r\n'), [
    'Section,Item,OCF id,Object,Summary,Problem',
    'Stakeholders,1,robin,STAKEHOLDER,Robin Vale,"Two people on the cap table are called ""Robin Vale"""',
    "Certificates,7,cs-1,TX_STOCK_ISSUANCE,'=SUM(A1) · 1000,Waits for item 1",
    'Certificates,8,cs-2,TX_STOCK_ISSUANCE,Bo Kestrel,Not ours',
    'Certificates,9,cs-3,TX_STOCK_ISSUANCE,Bo Kestrel,Left out with item 8 (CS-2)',
    '',
  ]);
});
