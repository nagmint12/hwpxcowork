// 실시간 '변경 추적으로' 문서의 큰 잘라내기·붙여넣기(2026-11-03 — 운영 문서 583문단 전체 잘라내기 40초·다시 붙인 글이 사라짐):
//  1) 엔진 묶음(clearParagraphsTracked·deleteBreaksTracked·insertTrackedParagraphsAfter)을 켠 결과가 하나씩 한 결과와 바이트로 같다
//  2) 같은 창이 옛 기준으로 보낸 글(앞서 잘라 낸 글을 다시 붙임)이 커밋된다(ownBase) — 다른 창이면 예전 규칙 그대로
//  3) 큰 밀어 넣기는 보낸 창에 진행(WS live progress)을 알린다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { fixture } from './helpers/server.mjs';
import { compareBatch, liveFixture, withoutParagraphs, withCopiedParagraphs, bodyCount } from './helpers/live-batch.mjs';

const USER = { name: '시험 작성자', role: 'admin' };
const DOCS = ['shapes_hangul.hwpx', 'toc_source.hwpx', 'codes_hangul_all.hwpx', 'hangul_trk_pic_delete_range.hwpx'];
const finalText = async (bytes) => { const d = await HwpxDoc.load(bytes); return d.sections.map((s) => s.bodyParas.map((p) => d.text(p.ref, 'final')).join('\n')).join('\n'); };

/** 엔진 묶음 함수가 (null 이 아닌) 결과를 낸 횟수 */
function countBatches() {
  const hits = { clear: 0, breaks: 0, insert: 0 }; const restore = [];
  for (const [name, key] of [['clearParagraphsTracked', 'clear'], ['deleteBreaksTracked', 'breaks'], ['insertTrackedParagraphsAfter', 'insert']]) {
    const f = HwpxDoc.prototype[name];
    HwpxDoc.prototype[name] = function (...a) { const r = f.apply(this, a); if (r) hits[key]++; return r; };
    restore.push(() => { HwpxDoc.prototype[name] = f; });
  }
  return { hits, restore: () => restore.forEach((r) => r()) };
}

test('변경 추적 큰 지우기·붙여넣기: 묶음 결과 = 하나씩 한 결과(구역·머리 XML, 응답)', { timeout: 180000 }, async () => {
  const counter = countBatches();
  try {
    for (const name of DOCS) {
      const D = fs.readFileSync(fixture(name));
      const N = await bodyCount(D);
      const a = Math.max(1, Math.floor(N * 0.2)); const b = Math.max(a + 1, Math.floor(N * 0.6));
      const cut = await withoutParagraphs(D, a, b);
      const all = await withoutParagraphs(D, 1, N - 1);
      const n2 = await bodyCount(cut);
      const c = Math.max(1, Math.floor(n2 * 0.5)); const d = Math.min(n2 - 1, c + 2);
      const replaced = await withCopiedParagraphs(cut, c, d, a);
      const scenes = { cutBlock: [D, [cut]], cutAll: [D, [all]], pasteBack: [cut, [D]], cutAllThenPaste: [D, [all, D]], replace: [D, [replaced]], cutThenReplace: [D, [cut, replaced]] };
      for (const [scene, [base, heads]] of Object.entries(scenes)) {
        const r = await compareBatch(base, heads);
        const label = `${name} ${scene}`;
        assert.equal(r.on.header, r.off.header, `${label}: 머리 XML`);
        assert.equal(r.on.xml.length, r.off.xml.length, `${label}: 구역 수`);
        r.on.xml.forEach((x, i) => assert.ok(x === r.off.xml[i], `${label}: 구역 ${i} XML`));
        assert.deepEqual(r.on.res, r.off.res, `${label}: 밀어 넣기 응답`);
      }
    }
  } finally { counter.restore(); }
  // 묶음 길을 실제로 탔다(흉내 낼 수 없는 문단이 든 경우는 하나씩 — 그것도 위에서 같은 결과)
  assert.ok(counter.hits.clear > 0 && counter.hits.breaks > 0 && counter.hits.insert > 0, JSON.stringify(counter.hits));
});

test('같은 창이 전체를 잘라 낸 뒤 옛 기준으로 같은 글을 다시 붙이면 커밋된다(ownBase) — 다른 창이면 예전 규칙', { timeout: 120000 }, async () => {
  const D = fs.readFileSync(fixture('shapes_hangul.hwpx'));
  const all = await withoutParagraphs(D, 1, (await bodyCount(D)) - 1);
  const want = await finalText(D);
  for (const [label, seq2, expectKept] of [['같은 창', 734002, true], ['다른 창', 912001, false]]) {
    const f = await liveFixture(D);
    try {
      const r1 = await f.live.push(f.id, all, { base: 1, seq: 734001, user: USER });
      assert.equal(r1.version, 2, `${label}: 잘라 내기 커밋`);
      // 앞 밀어 넣기가 끝나기 전에 친 글 — 편집기는 기준을 옮기지 않았으므로 옛 기준(1)으로 온다
      const r2 = await f.live.push(f.id, D, { base: 1, seq: seq2, user: USER });
      const doc = await f.store.doc(f.id);
      const now = doc.sections.map((s) => s.bodyParas.map((p) => doc.text(p.ref, 'final')).join('\n')).join('\n');
      if (expectKept) {
        assert.equal(r2.version, 3, `${label}: 다시 붙인 글이 커밋됨`);
        assert.equal(now, want, `${label}: 최종본 글 = 붙인 글`);
        assert.equal(f.service._meta(f.id).versions.at(-1).seq, seq2, '기록에 창 차례');
      } else {
        assert.equal(r2.version, 2, `${label}: 옛 기준과 같은 글 — 바뀐 것 없음(예전 규칙)`);
      }
    } finally { f.close(); }
  }
});

test('큰 밀어 넣기는 보낸 창에 진행을 1초마다 알린다(type live, action progress, seq)', { timeout: 60000 }, async () => {
  const D = fs.readFileSync(fixture('toc_source.hwpx'));
  const all = await withoutParagraphs(D, 1, (await bodyCount(D)) - 1);
  const f = await liveFixture(D, { batch: false });
  const sent = []; f.service.hub.broadcast = (id, msg) => sent.push(msg);
  const realNow = Date.now; let t = realNow();
  Date.now = () => (t += 700);
  try { await f.live.push(f.id, all, { base: 1, seq: 55001, user: USER }); } finally { Date.now = realNow; f.close(); }
  const prog = sent.filter((m) => m.type === 'live' && m.action === 'progress');
  assert.ok(prog.length > 0, '진행 알림');
  assert.ok(prog.every((m) => m.seq === 55001 && m.total > 0 && m.done <= m.total && m.by === USER.name));
});
