import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloseGuard } from '../deploy/local-editor/close-guard.mjs';

test('clean close proceeds immediately; cancelling preserves unsaved changes', async () => {
  let dirty = false, prompts = 0, prevented = 0, closes = 0;
  const guard = createCloseGuard({ isDirty: () => dirty, confirmDiscard: async () => { prompts++; return false; }, close: () => closes++ });
  const event = { preventDefault: () => prevented++ };
  await guard(event);
  assert.deepEqual([prompts, prevented, closes], [0, 0, 0]);
  dirty = true;
  await guard(event);
  await guard(event);
  assert.deepEqual([prompts, prevented, closes, dirty], [2, 2, 0, true]);
});

test('discard closes once without requiring a save, including the reentrant close event', async () => {
  let resolve, prompts = 0, prevented = 0, closes = 0;
  const guard = createCloseGuard({
    isDirty: () => true,
    confirmDiscard: () => { prompts++; return new Promise(r => { resolve = r; }); },
    close: () => { closes++; void guard({ preventDefault: () => prevented++ }); },
  });
  const event = { preventDefault: () => prevented++ };
  const pending = guard(event);
  await guard(event); // repeated Cmd+Q/window-close while the sheet is open
  assert.deepEqual([prompts, prevented, closes], [1, 2, 0]);
  resolve(true);
  await pending;
  assert.deepEqual([prompts, prevented, closes], [1, 2, 1]);
});

test('dialog failure retains the document and allows a later close attempt', async () => {
  let failed = false, closes = 0;
  const errors = [];
  const guard = createCloseGuard({
    isDirty: () => true,
    confirmDiscard: async () => { if (!failed) { failed = true; throw Error('dialog failed'); } return true; },
    close: () => closes++, onError: e => errors.push(e.message),
  });
  await guard({ preventDefault() {} });
  assert.equal(closes, 0);
  assert.deepEqual(errors, ['dialog failed']);
  await guard({ preventDefault() {} });
  assert.equal(closes, 1);
});
