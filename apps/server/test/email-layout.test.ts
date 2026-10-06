/**
 * The shared email layout. Pinned here: both parts carry the same words, nothing
 * a person typed can turn into markup, only web links become buttons, and typed
 * text keeps its paragraphs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderEmail, paragraphsOf } = await import('../src/email.ts');
const { config } = await import('../src/config.ts');

const content = {
  preview: 'Sign by Friday.',
  from: 'Tidewater Labs',
  heading: 'Your share certificate is ready to sign',
  greeting: 'Hi Morgan,',
  intro: ['Tidewater Labs has issued you shares.\nPlease review and sign.'],
  details: [{ label: 'Shares', value: '10,000 shares of Common Stock' }, { label: 'Company', value: 'Tidewater Labs' }],
  action: { label: 'Review and sign', url: 'https://equity.example.com/portal?a=1&b=2' },
  actionNote: 'The link opens your portal.',
  sections: [{ title: 'What happens next', bullets: ['The shares count once everyone has signed.'] }],
  signoff: '— Tidewater Labs',
  footer: 'You are receiving this because Tidewater Labs manages its equity here.',
};

test('the HTML and the plain text carry the same words, the link and the details', () => {
  const { html, text } = renderEmail(content, 'Tidewater Labs: sign your share certificate');
  for (const part of [html, text]) {
    assert.match(part, /Hi Morgan,/);
    assert.match(part, /10,000 shares of Common Stock/);
    assert.match(part, /What happens next/i);
    assert.match(part, /You are receiving this because Tidewater Labs/);
  }
  assert.ok(text.includes('https://equity.example.com/portal?a=1&b=2'), 'the plain text has the link as typed');
  assert.ok(html.includes('href="https://equity.example.com/portal?a=1&amp;b=2"'), 'the HTML has it escaped in the attribute');
  assert.match(html, /<title>Tidewater Labs: sign your share certificate<\/title>/);
  assert.ok(html.includes(config().brand.colors.primary['600']), 'the button takes the brand colour');
  assert.ok(html.includes('Tidewater Labs has issued you shares.<br>Please review and sign.'), 'line breaks inside a paragraph are kept');
  assert.ok(!/<img|<link|src=/i.test(html), 'no images or other remote resources to block or track');
});

test('nothing a person typed becomes markup', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const { html } = renderEmail({
    ...content, greeting: `Hi ${hostile},`, heading: hostile, intro: [hostile],
    details: [{ label: hostile, value: hostile }], sections: [{ title: hostile, paragraphs: [hostile], bullets: [hostile] }],
    signoff: hostile, footer: hostile, preview: hostile, from: hostile,
  }, hostile);
  assert.ok(!html.includes('<script>'), 'no script tag');
  assert.ok(!html.includes('<img'), 'no image tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'shown as text');
});

test('only web links become buttons', () => {
  const { html } = renderEmail({ ...content, action: { label: 'Open', url: 'javascript:alert(1)' } }, 'x');
  assert.ok(!html.includes('javascript:'), 'a script link is dropped');
  assert.ok(html.includes('href="#"'));
});

test('an email without a button, greeting or signoff still reads cleanly', () => {
  const { html, text } = renderEmail({ preview: 'p', heading: 'Request closed', intro: ['Nothing more is needed.'], footer: 'f' }, 'Closed');
  assert.ok(!html.includes('If the button does not work'), 'no fallback link without a button');
  assert.equal(text, 'Nothing more is needed.\n\n--\nf\n');
});

test('typed text is split into paragraphs at blank lines', () => {
  assert.deepEqual(paragraphsOf('First line\nsame paragraph\n\n\nSecond\r\n\r\nThird  '), ['First line\nsame paragraph', 'Second', 'Third']);
});
