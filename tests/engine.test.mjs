// node --test tests/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const load = (n) => HwpxDoc.load(fs.readFileSync(path.join(here, 'fixtures', n)));
const author = '검토자(AI)';

test('한글이 쓴 변경 추적을 읽는다', async () => {
  const d = await load('hangul_tracked.hwpx');
  const c = d.changes();
  assert.equal(c.length, 2);
  assert.deepEqual(c.map((x) => [x.id, x.type, x.author, x.text]), [[1, 'Insert', 'Nag', ' (AI가 추가한 문장)'], [2, 'Delete', 'Nag', '원래 ']]);
  assert.equal(d.text('s0/p1', 'final'), '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)');
  assert.equal(d.text('s0/p1', 'original'), '둘째 문단입니다. 원래 있던 낱말을 지우고 새 낱말을 넣습니다.');
  assert.equal(d.trackingEnabled(), true);
});

test('메모(MEMO 필드)를 읽고 범위를 안다', async () => {
  const d = await load('tool_memo_tracked.hwpx');
  const m = d.memos();
  assert.equal(m.length, 1);
  assert.equal(m[0].author, 'AI 검토자');
  assert.deepEqual([m[0].ref, m[0].start, m[0].end, m[0].anchorText], ['s0/p0', 0, 10, '첫째 문단입니다. ']);
});

test('교체·삽입·메모 추가 후 저장하고 다시 읽어도 같다', async () => {
  const d = await load('tool_memo_tracked.hwpx');
  const r = d.find('s0/p1', '낱말을 넣습니다');
  const ids = d.replaceTracked('s0/p1', r.start, r.end, '단어를 추가합니다', { author });
  assert.deepEqual(ids, { deleteId: 5, insertId: 6 });
  assert.equal(d.insertTracked('s0/p0', 0, '[머리말] ', { author }), 7);
  const memoId = d.addMemo('s0/p1', { start: 0, end: 6, author, text: '첫 줄\n둘째 줄' });
  assert.equal(memoId, 'memo2');
  const re = await HwpxDoc.load(await d.save());
  assert.equal(re.text('s0/p1', 'final'), '둘째 문단입니다. 있던 낱말을 지우고 새 단어를 추가합니다. (AI가 추가한 문장)');
  assert.equal(re.text('s0/p0', 'markup'), '{+[머리말] +}첫째 문단입니다. 메모 대상 문장이 여기 있습니다.');
  const memo = re.memos().find((m) => m.id === 'memo2');
  assert.deepEqual([memo.text, memo.anchorText, memo.start, memo.end], ['첫 줄\n둘째 줄', '둘째 문단입', 0, 6]);
  // 헤더: 작성자는 끝에 붙고 mark=1, 변경 번호는 1..n 연속
  assert.deepEqual(re.authors().map((a) => [a.id, a.name, a.mark]), [[1, 'Nag', 1], [2, 'AI 검토자', 1], [3, author, 1]]);
  assert.deepEqual(re.changes().map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]);
});

test('수락·거절 뒤 번호를 다시 매기고 글이 맞다', async () => {
  const d = await load('tool_memo_tracked.hwpx');
  assert.equal(d.rejectChange(3), true); // 'AI 제안대로 ' 삽입 거절 → 사라짐
  assert.equal(d.text('s0/p2', 'final'), '셋째 문단은 둡니다.');
  assert.deepEqual(d.changes().map((c) => c.id), [1, 2, 3]); // 4 → 3 으로 번호 재부여
  const log = d.takeRenumberLog();
  assert.equal(log.length, 1); assert.equal(log[0].removed, 3); assert.equal(log[0].map.get(4), 3);
  assert.equal(d.acceptChange(3), true); // '그대로 ' 삭제 수락 → 사라짐
  assert.equal(d.text('s0/p2', 'original'), '셋째 문단은 둡니다.');
  d.acceptAll();
  assert.equal(d.changes().length, 0);
  assert.equal(d.text('s0/p1', 'final'), '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)');
});

test('문단 글 비교 → 변경 추적(병합)', async () => {
  const d = await load('tool_memo_tracked.hwpx');
  d.acceptAll();
  const texts = d.paragraphs({ nested: false }).map((p) => p.text);
  texts[1] = texts[1].replace('있던 낱말을', '있던 단어를') + ' 끝에 덧붙임.';
  texts.push('새로 추가된 문단입니다.');
  const rep = d.mergeBodyTexts({ 0: texts }, { author: '편집자' });
  assert.deepEqual(rep.changed, ['s0/p1']); assert.deepEqual(rep.inserted, ['s0/p3']);
  assert.equal(d.text('s0/p1', 'markup'), '둘째 문단입니다. 있던 [-낱말을-]{+단어를+} 지우고 새 낱말을 넣습니다. (AI가 추가한 문장){+ 끝에 덧붙임.+}');
  assert.equal(d.text('s0/p3', 'markup'), '{+새로 추가된 문단입니다.+}');
  assert.deepEqual(d.paragraphs({ nested: false }).map((p) => p.text), texts);
});

test('겹치는 범위는 거절한다', async () => {
  const d = await load('tool_memo_tracked.hwpx');
  assert.throws(() => d.replaceTracked('s0/p2', 7, 15, 'x', { author }), /OVERLAP|변경/);
});
