// node --test tests/split_paragraphs.test.mjs — 제안 글의 줄바꿈은 새 문단(2026-10-31):
// AI 가 긴 보고서 전체를 바꿈 제안 하나에 넣으면 문단 하나에 줄 나눔 수백 개가 들어가 편집기가 글자마다 그 문단(14쪽)을 다시 그렸다.
// 이제 바꿀 글·새 문단 글의 줄마다 새 문단(빈 줄 = 빈 문단, 끝 빈 줄은 뺌), 되돌리기는 넣은 문단을 거두고 원문으로. 표 칸·글자 서식 지정 글은 예전처럼 줄 나눔.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const body = (paras) => paras.filter((p) => /^s\d+\/p\d+$/.test(p.ref)).map((p) => p.text);
async function newDoc(A, title, settings) {
  const doc = await A('/api/library/docs', { method: 'POST', body: { title, space: 'public' } });
  const D = `/api/docs/${doc.id}`;
  if (settings) await A(`${D}/settings`, { method: 'PATCH', body: settings });
  return { D, paras: async () => body(await A(`${D}/paragraphs`)), propose: (b) => A(`${D}/proposals`, { method: 'POST', body: b }),
    apply: (p) => A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' }), undo: (p) => A(`${D}/proposals/${p.pid}/undo`, { method: 'POST' }) };
}

test('실시간 고친 글만: AI 가 빈 문서에 보고서 전체를 넣어도 줄마다 문단 — 되돌리면 빈 문서, 다시 열어 적용해도 같다', { timeout: 90000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const d = await newDoc(srv.api('a'), '빈 보고서');
    assert.deepEqual(await d.paras(), ['']);
    const report = '검토 보고서\n\nⅠ. 개요\n본문 첫 줄입니다.\n\n';
    const p1 = await d.propose({ type: 'replace', ref: 's0/p0', find: '', replace: report });
    await d.apply(p1);
    const paras = await d.paras();
    assert.deepEqual(paras, ['검토 보고서', '', 'Ⅰ. 개요', '본문 첫 줄입니다.'], '줄마다 문단, 빈 줄은 빈 문단, 끝 빈 줄은 뺌');
    assert.ok(paras.every((t) => !t.includes('\n')), '문단 안 줄 나눔 없음');
    await d.undo(p1);
    assert.deepEqual(await d.paras(), ['']);
    await srv.api('a')(`${d.D}/proposals/${p1.pid}/reopen`, { method: 'POST' });
    await d.apply(p1);
    assert.deepEqual(await d.paras(), ['검토 보고서', '', 'Ⅰ. 개요', '본문 첫 줄입니다.']);
  } finally { await srv.stop(); }
});

test('문단 가운데 바꿈·여러 줄 문단 추가: 뒤쪽 원문은 마지막 새 문단으로, 주소가 밀려도 되돌리기가 제자리를 찾고, 그새 고친 문단은 STALE', { timeout: 90000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const d = await newDoc(A, '가운데');
    const seed = await d.propose({ type: 'replace', ref: 's0/p0', find: '', replace: '머리\n앞 글 바꿀 글 뒤 글' });
    await d.apply(seed);
    const p2 = await d.propose({ type: 'replace', ref: 's0/p1', find: '바꿀 글', replace: '첫째\n둘째' });
    await d.apply(p2);
    assert.deepEqual(await d.paras(), ['머리', '앞 글 첫째', '둘째 뒤 글']);
    const p3 = await d.propose({ type: 'insert', afterRef: 's0/p0', text: '가\n나' });
    await d.apply(p3);
    assert.deepEqual(await d.paras(), ['머리', '가', '나', '앞 글 첫째', '둘째 뒤 글']);
    // p2 의 문단은 p3 때문에 두 칸 밀렸다 — 그래도 제자리
    await d.undo(p2);
    assert.deepEqual(await d.paras(), ['머리', '가', '나', '앞 글 바꿀 글 뒤 글']);
    // 넣은 문단을 사람이 고쳤으면 되돌리지 않는다
    const live = await A(`${d.D}/proposals/${p3.pid}`).catch(() => null); void live;
    const p4 = await d.propose({ type: 'replace', ref: 's0/p2', find: '나', replace: '나나' });
    await d.apply(p4);
    const res = await A.res(`${d.D}/proposals/${p3.pid}/undo`, { method: 'POST' });
    assert.equal(res.status, 409);
    await d.undo(p4);
    await d.undo(p3);
    // '나' 문단에는 p4 의 제안 메모가 달려 있어 글만 지우고 빈 문단으로 남긴다(한 문단 추가 되돌리기와 같은 규칙)
    assert.deepEqual(await d.paras(), ['머리', '', '앞 글 바꿀 글 뒤 글']);
  } finally { await srv.stop(); }
});

test('변경 추적 문서: 줄마다 문단이 넣음 변경으로, 되돌리기(거절)하면 원래 한 문단', { timeout: 90000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const d = await newDoc(A, '추적 문서', { track: 'tracked' });
    const p1 = await d.propose({ type: 'replace', ref: 's0/p0', find: '', replace: '하나\n둘\n셋' });
    await d.apply(p1);
    assert.deepEqual(await d.paras(), ['하나', '둘', '셋']);
    assert.ok((await A(`${d.D}/changes`)).length >= 1, '변경 추적으로 들어감');
    await d.undo(p1);
    assert.deepEqual(await d.paras(), ['']);
  } finally { await srv.stop(); }
});

test('줄 나눔 그대로: 글자 서식(runs)을 준 글은 예전처럼 문단 안 줄 나눔', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const d = await newDoc(srv.api('a'), '서식 문서');
    const p = await d.propose({ type: 'replace', ref: 's0/p0', find: '', replace: '굵게\n보통', runs: [{ text: '굵게', char: { bold: true } }, { text: '\n보통' }] });
    await d.apply(p);
    assert.deepEqual(await d.paras(), ['굵게\n보통']);
  } finally { await srv.stop(); }
});
