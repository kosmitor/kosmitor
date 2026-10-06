import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, parseXmlTable, toXml } from '../src/import/xml.ts';
import { detectFormat } from '../src/routes/imports.ts';

test('generic record XML: attributes and child elements become columns, in first-seen order', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <!-- exported 2026-09-16 -->
  <captable company="Northstar">
    <certificate id="CS-1">
      <stakeholder>Avery Stone</stakeholder>
      <shareClass>Common</shareClass>
      <shares>4,200,000</shares>
      <issueDate>2021-02-01</issueDate>
    </certificate>
    <certificate id="PS-1">
      <stakeholder><![CDATA[Foundry Seed Fund I, L.P. <lead>]]></stakeholder>
      <shareClass>Series Seed Preferred</shareClass>
      <shares>2290000</shares>
      <issueDate>2022-09-15</issueDate>
      <price>0.8734</price>
    </certificate>
  </captable>`;
  const [sheet] = parseXmlTable(xml);
  assert.equal(sheet.name, 'certificate');
  assert.deepEqual(sheet.rows[0], ['id', 'stakeholder', 'shareClass', 'shares', 'issueDate', 'price']);
  assert.deepEqual(sheet.rows[1], ['CS-1', 'Avery Stone', 'Common', '4,200,000', '2021-02-01', null]);
  assert.deepEqual(sheet.rows[2], ['PS-1', 'Foundry Seed Fund I, L.P. <lead>', 'Series Seed Preferred', '2290000', '2022-09-15', '0.8734']);
});

test('generic record XML: entities are decoded and wrapper elements are descended', () => {
  const xml = `<export><meta><source>Other tool</source></meta><records>
    <row><name>Stone &amp; Co</name><note>a &lt; b &gt; c &quot;q&quot; &#233;</note></row>
    <row><name>Bao</name><note/></row>
  </records></export>`;
  // The root has two children (meta, records); the repeating element lives under <records>.
  const [sheet] = parseXmlTable(xml.replace('<meta><source>Other tool</source></meta>', ''));
  assert.deepEqual(sheet.rows, [['name', 'note'], ['Stone & Co', 'a < b > c "q" é'], ['Bao', null]]);
});

test('positional XML rows (<row><cell>…) come through as plain rows for the header picker', () => {
  const xml = `<table>
    <row><cell>Name</cell><cell>Shares</cell></row>
    <row><cell>Avery</cell><cell>100</cell></row>
    <row><cell>Bao</cell></row>
  </table>`;
  const [sheet] = parseXmlTable(xml);
  assert.deepEqual(sheet.rows, [['Name', 'Shares'], ['Avery', '100'], ['Bao', null]]);
});

test('Excel XML Spreadsheet 2003: sheets, sparse cell indexes, typed values and merged cells', () => {
  const xml = `<?xml version="1.0"?>
  <?mso-application progid="Excel.Sheet"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet ss:Name="Cap table">
      <Table>
        <Row><Cell><Data ss:Type="String">Stakeholder</Data></Cell><Cell><Data ss:Type="String">Shares</Data></Cell><Cell ss:Index="4"><Data ss:Type="String">Issued</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Avery Stone</Data></Cell><Cell><Data ss:Type="Number">4200000</Data></Cell><Cell ss:Index="4"><Data ss:Type="DateTime">2021-02-01T00:00:00.000</Data></Cell></Row>
        <Row ss:Index="4"><Cell><Data ss:Type="String">Bao</Data></Cell><Cell ss:MergeAcross="1"><Data ss:Type="Number">3800000</Data></Cell><Cell><Data ss:Type="Boolean">1</Data></Cell></Row>
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Notes"><Table><Row><Cell><Data ss:Type="String">memo</Data></Cell></Row></Table></Worksheet>
  </Workbook>`;
  const sheets = parseXmlTable(xml);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, 'Cap table');
  assert.deepEqual(sheets[0].rows[0], ['Stakeholder', 'Shares', null, 'Issued']);
  assert.deepEqual(sheets[0].rows[1], ['Avery Stone', 4_200_000, null, '2021-02-01']);
  assert.deepEqual(sheets[0].rows[2], ['Bao', 3_800_000, null, true]);   // merged cell skips a column; blank row 3 dropped
  assert.deepEqual(sheets[1].rows, [['memo']]);
});

test('malformed XML fails with a readable message rather than a crash', () => {
  assert.throws(() => parseXml('<a><b></a>'), /Mismatched closing tag/);
  assert.throws(() => parseXml('<a><b>'), /ends before <b> is closed/);
  assert.throws(() => parseXml('<!-- never closed'), /Unterminated comment/);
  assert.throws(() => parseXmlTable('<root>just text</root>'), /No repeating records/);
  assert.throws(() => parseXml('   '), /no XML elements/);
});

test('attributes with quotes and a > inside are parsed, namespace prefixes are dropped', () => {
  const node = parseXml(`<ns:root ns:title='say "hi" > there' other="x"><ns:child/></ns:root>`);
  assert.equal(node.name, 'root');
  assert.equal(node.attrs.title, 'say "hi" > there');
  assert.equal(node.attrs.other, 'x');
  assert.equal(node.children[0].name, 'child');
});

test('the XML template round-trips through the parser with the field keys as columns', () => {
  const xml = toXml('captable', 'certificate', ['stakeholderName', 'shares'], [['Stone & Co', 100], ['Bao', null]]);
  const [sheet] = parseXmlTable(xml);
  assert.deepEqual(sheet.rows, [['stakeholderName', 'shares'], ['Stone & Co', '100'], ['Bao', null]]);
});

test('format detection prefers the bytes over the file name', () => {
  assert.equal(detectFormat(Buffer.from('﻿<?xml version="1.0"?><a/>'), 'export.csv'), 'xml');
  assert.equal(detectFormat(Buffer.from('  <captable><certificate/></captable>'), 'whatever.txt'), 'xml');
  assert.equal(detectFormat(Buffer.from('Name,Shares\nAvery,100'), 'table.csv'), 'csv');
  assert.equal(detectFormat(Buffer.from('Name,Shares\nAvery,100'), 'table.xml'), 'xml');   // name only when bytes are ambiguous
  assert.equal(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'book.xlsx'), 'xlsx');
  assert.equal(detectFormat(Buffer.from('a<b'), 'x.csv'), 'csv');
});
