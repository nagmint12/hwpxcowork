// (2026-11-03) 작업본(viewerCopy — 편집기가 여는 '모두 수락한 사본')의 묶음 수락:
//  - _acceptBreaksBatch: 묶음 끝 member 의 빈 run 째 버리는 넣은 나눔 표식을 따로 지우다 EDIT_OVERLAP 으로 묶음 전체가 하나씩 길로 밀리던 것
//    (변경 추적으로 전체를 잘라 낸 뒤 다시 붙인 문서 — 운영 보고서 사본에서 편집기 열기 206초)
//  - _acceptInsertsBatch: 넣음(글·개체) 수락 = 표식만 지우기를 구역 한 번 다시 읽기로
// 결과 = 하나씩(묶음 끔) 결과: 넣음 묶음은 바이트까지, 나눔 묶음은 문단 글·서식 지문·개체 지문·남은 변경 0 이 같다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { fixture } from './helpers/server.mjs';
import { compareBatch, withoutParagraphs, bodyCount } from './helpers/live-batch.mjs';

const P = HwpxDoc.prototype;
async function viewer(bytes, { breaks = true, inserts = true } = {}) {
  const rb = P._acceptBreaksBatch; const ri = P._acceptInsertsBatch;
  if (!breaks) P._acceptBreaksBatch = () => null;
  if (!inserts) P._acceptInsertsBatch = () => null;
  try { return await (await HwpxDoc.load(bytes)).viewerCopy({ tolerant: true }); } finally { P._acceptBreaksBatch = rb; P._acceptInsertsBatch = ri; }
}
function meaning(v) {
  const paras = v.paragraphs({ nested: true, view: 'final' });
  return {
    changes: v.changes().length,
    paras: paras.map((p) => [p.ref, p.text, v.formattingFingerprint(p.ref), /^s\d+\/p\d+$/.test(p.ref) ? v.objectPrint(p.ref) : '']),
  };
}
const xmlOf = (v) => v.sections.map((s) => s.xml).join('\u0000') + v.header.xml;

/** 전체를 변경 추적으로 잘라 낸 뒤 다시 붙인 문서(실시간 밀어 넣기 두 번) */
async function cutAllThenPaste(name) {
  const D = fs.readFileSync(fixture(name));
  const all = await withoutParagraphs(D, 1, (await bodyCount(D)) - 1);
  const r = await compareBatch(D, [all, D]);
  return Buffer.from(r.on.bytes);
}

test('전체 잘라내기 뒤 다시 붙인 문서: 나눔·넣음 묶음이 실제로 쓰이고 작업본 뜻 = 하나씩', { timeout: 120000 }, async () => {
  for (const name of ['shapes_hangul.hwpx', 'toc_source.hwpx', 'codes_hangul_all.hwpx']) {
    const bytes = await cutAllThenPaste(name);
    const d = await HwpxDoc.load(bytes);
    assert.ok(d.changes().some((c) => c.type === 'Insert') && d.changes().some((c) => c.type === 'Delete'), `${name}: 넣음·지움 변경이 있다`);
    // 묶음이 던지지 않고 일을 한다(전에는 EDIT_OVERLAP → 하나씩)
    const probe = await HwpxDoc.load(bytes);
    assert.ok(probe._acceptBreaksBatch(), `${name}: 나눔 묶음`);
    assert.ok(probe._acceptInsertsBatch(), `${name}: 넣음 묶음`);
    const seq = meaning(await viewer(bytes, { breaks: false, inserts: false }));
    const bat = meaning(await viewer(bytes));
    assert.equal(bat.changes, 0, `${name}: 남은 변경 없음`);
    assert.deepEqual(bat, seq, `${name}: 작업본 문단 글·서식·개체 = 하나씩`);
  }
});

test('넣음 묶음은 바이트까지 같다(나눔 묶음은 그대로 켠 채 넣음 묶음만 켬·끔)', { timeout: 120000 }, async () => {
  const docs = [fixture('hangul_trk_tbl_insert.hwpx'), fixture('hangul_trk_pic_insert_with_text.hwpx'), fixture('hangul_trk_hand_marks_in_t.hwpx'), fixture('tool_memo_tracked.hwpx'), fixture('hangul_resaved_dedup.hwpx')];
  const made = [await cutAllThenPaste('shapes_hangul.hwpx'), await cutAllThenPaste('toc_source.hwpx')];
  for (const bytes of [...docs.map((f) => fs.readFileSync(f)), ...made]) {
    const off = await viewer(bytes, { inserts: false });
    const on = await viewer(bytes);
    assert.equal(xmlOf(on), xmlOf(off));
    assert.deepEqual(on.lastTolerantSkips, off.lastTolerantSkips);
  }
});
