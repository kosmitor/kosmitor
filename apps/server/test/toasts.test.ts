/**
 * The web app's toasts. A toast can now carry a button, such as Undo after
 * documents are moved, and every toast that has none has to be made and timed
 * as it always was: the app calls toast(message) and toast(message, tone) in
 * close to two hundred places. The rules live in apps/web/src/toasts.ts, free of
 * React, and the web app has no test runner of its own, so they are tested here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToast, toastLifetime, TOAST_MS, TOAST_WITH_ACTION_MS, TOAST_RELEASE_MS } from '../../web/src/toasts.ts';

test('a toast without an action is made and timed as before', () => {
  const saved = makeToast(1, 'Saved');
  assert.deepEqual(saved, { id: 1, message: 'Saved', tone: 'success' }, 'the tone defaults to success and nothing else is added');
  assert.equal(toastLifetime(saved), TOAST_MS);
  assert.equal(TOAST_MS, 4200, 'an ordinary toast stays as long as it always has');

  const refused = makeToast(2, 'That folder is too deep.', 'error');
  assert.deepEqual(refused, { id: 2, message: 'That folder is too deep.', tone: 'error' });
  assert.equal(toastLifetime(refused), TOAST_MS);
  assert.equal(toastLifetime(makeToast(3, 'Copied', 'info')), TOAST_MS);
  assert.equal(toastLifetime(makeToast(4, 'Saved', 'success', undefined)), TOAST_MS, 'an action left undefined is no action');
});

test('a toast with an action keeps it and stays a little longer', () => {
  let undone = 0;
  const action = { label: 'Undo', onClick: () => { undone++; } };
  const moved = makeToast(5, 'Moved 3 documents to Legal', 'success', action);
  assert.equal(moved.action, action);
  assert.equal(moved.tone, 'success');
  assert.equal(toastLifetime(moved), TOAST_WITH_ACTION_MS);
  assert.ok(TOAST_WITH_ACTION_MS > TOAST_MS, 'there is time to reach for the button');
  assert.ok(TOAST_RELEASE_MS > 0 && TOAST_RELEASE_MS < TOAST_WITH_ACTION_MS);
  moved.action!.onClick();
  assert.equal(undone, 1);
});

test('an action with no label is left off rather than drawn as an empty button', () => {
  const blank = makeToast(6, 'Moved', 'success', { label: '  ', onClick: () => {} });
  assert.equal(blank.action, undefined);
  assert.equal(toastLifetime(blank), TOAST_MS);
});
