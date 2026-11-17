import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontResourceQueue } from '../studio/fonts/font-resource-queue.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('seven language-slot requests prepare one batch and refresh once without touching selection', async () => {
  const calls = []; let refresh = 0;
  const request = createFontResourceQueue({ generation: () => 1, prepare: async names => calls.push(names), refresh: async () => refresh++ });
  for (let i = 0; i < 7; i++) request('Client Face');
  request('Another Face'); await tick();
  assert.deepEqual(calls, [['Client Face', 'Another Face']]); assert.equal(refresh, 1);
});

test('an old document preparation cannot refresh its replacement; later choice still completes', async () => {
  let generation = 1, release; const calls = [], refreshed = [];
  const request = createFontResourceQueue({ generation: () => generation,
    prepare: async names => { calls.push(names); if (names[0] === 'Old') await new Promise(resolve => { release = resolve; }); },
    refresh: async () => refreshed.push(generation) });
  request('Old'); await tick(); generation = 2; request('New'); release(); await tick();
  assert.deepEqual(calls, [['Old'], ['New']]); assert.deepEqual(refreshed, [2]);
});

test('a failed face preparation remains retryable', async () => {
  let attempts = 0, refreshed = 0; const errors = [];
  const request = createFontResourceQueue({ generation: () => 1,
    prepare: async () => { if (++attempts === 1) throw Error('blocked font'); },
    refresh: async () => refreshed++, onError: error => errors.push(error.message) });
  request('Retry'); await tick(); request('Retry'); await tick();
  assert.deepEqual(errors, ['blocked font']); assert.equal(refreshed, 1); assert.equal(attempts, 2);
});
