// 실제 튜토리얼 시작 → 추적 옵션/표식 → 편집/반영/되돌리기 → 완료/재시작/내보내기.
// HWPX_TUTORIAL_AUDIT_OUT을 지정하면 한/글 왕복 검증용 사본을 남긴다. 실제 data/config는 사용하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { startServer, root } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { ADVANCED_TASKS } from '../web/tutorial-advanced-tasks.js';

const courses = ['report', 'overview', 'clipboard', 'ai-requests', 'ai-connect', 'ai-advanced'];
const text = d => d.paragraphs({ view: 'final', nested: true }).map(p => p.text);
const output = process.env.HWPX_TUTORIAL_AUDIT_OUT;
async function tracked(A, id) {
  const bytes = await A(`/api/docs/${id}/file?kind=tracked`);
  const d = await HwpxDoc.load(bytes);
  assert.equal(d.header.trackingEnabled(), true, 'HWPX 자체의 변경 내용 추적 켬');
  assert.equal(bytes.readUInt16LE(8), 0, 'mimetype 무압축 유지');
  return { bytes, d };
}
function save(name, bytes) {
  if (!output) return;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, name), bytes);
}

test('1~6 실제 시작 API: 추적 켬 + 실시간 수정/제안 반영/되돌림 + 저장/재시작/내보내기', { timeout: 180000 }, async t => {
  const srv = await startServer({ config: { tutorial: { trackChanges: true }, tutorialExampleDelayMs: 0 } });
  t.after(() => srv.stop());
  let A = srv.api('a');
  const completed = [];
  const evidence = [];
  for (const [index, course] of courses.entries()) {
    await t.test(`${index + 1}. ${course}`, async () => {
      const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: course } });
      const info = await A(`/api/docs/${id}`);
      assert.deepEqual([info.settings.editMode, info.settings.track, info.settings.exportKind], ['realtime', 'tracked', 'tracked']);
      const initial = await tracked(A, id);
      const original = text(initial.d);
      save(`${index + 1}-${course}-start.hwpx`, initial.bytes);
      // 서버 설정만 켜고 원본 HWPX는 꺼 둔 시험과 구분한다.
      const zip = await JSZip.loadAsync(initial.bytes);
      assert.equal(Number((await zip.file('Contents/header.xml').async('string')).match(/trackchageConfig[^>]*flags="(\d+)"/)[1]) & 1, 1);
      let appliedCount = 0;
      if (course === 'ai-advanced') {
        for (const task of ADVANCED_TASKS) {
          const out = await A(`/api/docs/${id}/requests`, { method: 'POST', body: { kind: 'instruct', target: { scope: 'document' }, instruction: task.prompt, tutorialStep: task.id } });
          assert.equal(out.route, 'example');
          const r = (await A(`/api/docs/${id}/requests`)).at(-1);
          assert.equal(r.status, 'done');
          assert.doesNotMatch(r.summary, /넣지 못했습니다/);
          const result = await A(`/api/docs/${id}/requests/${r.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
          assert.equal(result.counts.failed, 0, JSON.stringify(result.results.filter(x => !x.ok)));
          appliedCount += result.counts.applied;
        }
        assert.equal(appliedCount, 47);
      } else if (course === 'ai-requests') {
        const proposals = await A(`/api/docs/${id}/proposals`);
        assert.equal(proposals.length, 3);
        await A(`/api/docs/${id}/proposals/${proposals[0].pid}/apply`, { method: 'POST' });
        const mid = await tracked(A, id);
        assert.ok(mid.d.changes().length > initial.d.changes().length);
        save('4-ai-requests-applied.hwpx', mid.bytes);
        await A(`/api/docs/${id}/proposals/${proposals[1].pid}/reject`, { method: 'POST' });
        await A(`/api/docs/${id}/proposals/${proposals[0].pid}/undo`, { method: 'POST' });
        assert.deepEqual(text((await tracked(A, id)).d), original);
        appliedCount = 1;
      } else {
        // 편집기가 내보내는 최종본을 실시간 API로 밀어 넣는다(2번 직접 수정·3번 붙여넣기 경로).
        const working = await A.res(`/api/docs/${id}/file?kind=working`);
        const head = await HwpxDoc.load(working.data);
        const p = head.paragraphs().find(p => !p.parent && p.text.length > 25);
        assert.ok(p);
        const replacement = `${p.text} [추적 검증 ${index + 1}]`;
        head.mergeParagraphText(p.ref, replacement, { author: '홍길동' });
        const flat = await head.flattened();
        const result = await A(`/api/docs/${id}/live?base=${working.headers.get('x-doc-version')}&seq=${71000 + index}`, { method: 'PUT', body: await flat.save() });
        assert.ok(result.version > Number(working.headers.get('x-doc-version')));
        const edited = await tracked(A, id);
        assert.equal(edited.d.text(p.ref, 'final'), replacement);
        assert.ok(edited.d.changes().some(c => String(c.text).includes(`[추적 검증 ${index + 1}]`)));
        save(`${index + 1}-${course}-live.hwpx`, edited.bytes);
        // 겹치지 않는 제안을 반영/되돌려도 앞서 직접 입력한 추적 이력이 남아야 한다.
        // 삽입 글 내부의 중첩 수정은 아래 별도 시험에서 현재의 자동 수락 계약을 검사한다.
        const find = [...p.text].slice(0, 10).join('');
        const replace = `${find} (제안 검증)`;
        const prop = await A(`/api/docs/${id}/proposals`, { method: 'POST', body: { ref: p.ref, find, replace, reason: '독립된 추적 수정 검증', memo: false } });
        await A(`/api/docs/${id}/proposals/${prop.pid}/apply`, { method: 'POST' });
        assert.equal((await tracked(A, id)).d.text(p.ref, 'final'), replacement.replace(find, replace));
        await A(`/api/docs/${id}/proposals/${prop.pid}/undo`, { method: 'POST' });
        assert.equal((await tracked(A, id)).d.text(p.ref, 'final'), replacement);
        appliedCount = 1;
      }
      const final = await tracked(A, id);
      if (course !== 'ai-requests') assert.ok(final.d.changes().length > 0, '수정 이력이 실제로 남는다');
      save(`${index + 1}-${course}-applied.hwpx`, final.bytes);
      const exported = await A.res(`/api/docs/${id}/file?kind=export`);
      assert.equal(exported.headers.get('x-export-kind'), 'tracked');
      assert.deepEqual(text(await HwpxDoc.load(exported.data)), text(final.d));
      assert.equal((await HwpxDoc.load(exported.data)).header.trackingEnabled(), true);
      const done = await A(`/api/tutorial/${id}/complete`, { method: 'POST' });
      assert.equal(done.saved, true);
      completed.push({ id, original: text(final.d), changes: final.d.changes().length });
      evidence.push({ number: index + 1, course, settings: info.settings, appliedCount, changes: final.d.changes().length, completed: true });
    });
  }
  await srv.restart(); A = srv.api('a');
  for (const item of completed) {
    const after = await tracked(A, item.id);
    assert.deepEqual(text(after.d), item.original);
    assert.equal(after.d.changes().length, item.changes);
    assert.equal((await A(`/api/docs/${item.id}`)).tutorialSession, false);
  }
  save('api-evidence.json', JSON.stringify({ courses: evidence, restartPreserved: completed.length }, null, 2));
});
