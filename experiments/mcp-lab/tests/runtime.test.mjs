import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLabRuntime, repoRoot } from '../runtime.mjs';

test('laboratory owns fresh isolated storage and cannot execute paid AI', async () => {
  const r = createLabRuntime();
  try {
    assert.ok(!r.config.dataDir.startsWith(path.join(repoRoot, 'data')));
    assert.equal(r.config.ai.enabled, false);
    await assert.rejects(r.service.ai.run(), /cannot call/);
    const made = await r.service.createBlankDocument({ title: '격리된 MCP 시험', user: r.users.owner, location: { space: 'private' } });
    assert.ok(made.id);
    assert.throws(() => r.service.assertDocRead(made.id, r.users.other), /문서가 없습니다/);
  } finally { await r.close(); }
  assert.equal(fs.existsSync(r.tempDir), false);
});

test('all lab gateways can serialize a read-check-write operation', async () => {
  const r = createLabRuntime(), order = [];
  try {
    await Promise.all([r.runExclusive(async () => { order.push('read'); await new Promise(resolve => setTimeout(resolve, 5)); order.push('write'); }),
      r.runExclusive(async () => order.push('other'))]);
    assert.deepEqual(order, ['read', 'write', 'other']);
  } finally { await r.close(); }
});
