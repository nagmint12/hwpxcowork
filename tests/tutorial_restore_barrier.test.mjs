import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers/server.mjs';
import { liveFixture, withoutParagraphs, bodyCount } from './helpers/live-batch.mjs';
import { tutorialOwnerKey } from '../server/tutorial-identity.js';
import { Store, RECENT_MIN } from '../server/store.js';

const user = { name: '시험 작성자', role: 'admin' };
const bytes = fs.readFileSync(fixture('tool_memo_tracked.hwpx'));

async function restoredFixture() {
  const f = await liveFixture(bytes);
  const meta = f.store.readMeta(f.id);
  meta.tutorialSession = true;
  meta.tutorialOwnerKey = tutorialOwnerKey(user);
  // Simulate a restored version without changing the opened document's bytes.
  await f.store.commit(f.id, await f.store.doc(f.id), { by: user.name, note: '복구', meta, bytes });
  meta.tutorialRestoreVersion = meta.version;
  f.store.saveMeta(meta);
  return f;
}

test('복구 이전 base/loaded를 가진 저장은 내용과 기록을 바꾸지 않는다', async () => {
  const f = await restoredFixture();
  try {
    const stale = await withoutParagraphs(bytes, 1, Math.min(2, (await bodyCount(bytes)) - 1));
    for (const [base, loaded] of [[1, 1], [2, 1], [1, 2]]) {
      await assert.rejects(f.live.push(f.id, stale, { base, loaded, seq: 13001, user }), e =>
        e.code === 'TUTORIAL_RESTORED' && e.extra?.reload === true && e.extra?.restoreVersion === 2);
      assert.deepEqual(f.store.currentBytes(f.id), bytes);
      assert.equal(f.store.readMeta(f.id).version, 2);
    }
    const fresh = await f.live.push(f.id, bytes, { base: 2, loaded: 2, seq: 24001, user });
    assert.equal(fresh.clean, true);
    assert.equal(fresh.version, 2);
  } finally { f.close(); }
});

test('복구 경계는 문서 큐에서 검사하며 완료본의 일반 저장은 막지 않는다', async () => {
  const f = await liveFixture(bytes);
  try {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const restore = f.store.withDoc(f.id, async () => {
      await hold;
      const meta = f.store.readMeta(f.id);
      meta.tutorialSession = true;
      meta.tutorialOwnerKey = tutorialOwnerKey(user);
      await f.store.commit(f.id, await f.store.doc(f.id), { by: user.name, note: '복구', meta, bytes });
      meta.tutorialRestoreVersion = 2;
      f.store.saveMeta(meta);
    });
    const pending = f.live.push(f.id, bytes, { base: 1, loaded: 1, seq: 35001, user });
    release();
    await restore;
    await assert.rejects(pending, { code: 'TUTORIAL_RESTORED' });
    const meta = f.store.readMeta(f.id);
    meta.tutorialSession = false;
    meta.tutorialCompletedAt = new Date().toISOString();
    f.store.saveMeta(meta);
    const ordinary = await f.live.push(f.id, bytes, { base: 1, loaded: 1, seq: 46001, user });
    assert.equal(ordinary.clean, true);
  } finally { f.close(); }
});

test('연습 중에는 단계 이전 기록을 보존하고 완료 뒤에는 일반 보존 정책을 쓴다', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-history-'));
  try {
    const store = new Store(tmp);
    const meta = store.create({ fileName: 'practice.hwpx', bytes, by: user.name, extra: { tutorialSession: true } });
    let gcCalls = 0;
    store.gcVersions = () => { gcCalls++; return 0; };
    const doc = await store.doc(meta.id);
    for (let i = 0; i < RECENT_MIN + 2; i++) await store.commit(meta.id, doc, { by: user.name, note: '연습', meta, bytes });
    assert.equal(meta.versions.length, RECENT_MIN + 3);
    assert.equal(gcCalls, 0);
    assert.deepEqual(store.versionBytes(meta.id, 1), bytes);
    meta.tutorialSession = false;
    await store.commit(meta.id, doc, { by: user.name, note: '완료 후 편집', meta, bytes });
    assert.equal(gcCalls, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
